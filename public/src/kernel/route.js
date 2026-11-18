import { IvfDemuxer } from '../demux/ivf-demuxer.js';

// One Route owns the demuxers of every segment for one camera and a VP8
// VideoDecoder. Decoding always starts at the nearest preceding keyframe so
// inter-frame dependencies are satisfied; frames before the requested one are
// decoded and discarded. The first output frame handed to the switcher is
// therefore guaranteed to be the target frame or a later one — never a stale
// keyframe left over in some cache.
export class Route {
  constructor(camera, baseUrl) {
    this.camera = camera;
    this.baseUrl = baseUrl;
    this.demuxers = new Map(); // segment src -> IvfDemuxer
    this.decoder = null;
    this.configuredKey = null;
    this._request = null; // { outputs, expected, resolve, reject }
    this._chain = Promise.resolve(); // serializes overlapping decode requests
    this._lastOutputTime = null;
  }

  get id() {
    return this.camera.id;
  }

  async ensureDemuxer(segment) {
    let d = this.demuxers.get(segment.src);
    if (!d) {
      d = await new IvfDemuxer(`${this.baseUrl}${segment.src}`).init();
      this.demuxers.set(segment.src, d);
    }
    return d;
  }

  async ensureReady(segment) {
    await this.ensureDemuxer(segment);
    if (!this.decoder) {
      const support = await VideoDecoder.isConfigSupported({
        codec: 'vp8',
        codedWidth: this.camera.width,
        codedHeight: this.camera.height,
      });
      if (!support.supported) throw new Error('VP8 decoding is not supported in this browser');
      this.decoder = new VideoDecoder({
        output: (frame) => this._onOutput(frame),
        error: (err) => this._onError(err),
      });
    }
    const configKey = `${segment.src}`;
    if (this.configuredKey !== configKey || this.decoder.state === 'unconfigured') {
      if (this.decoder.state !== 'unconfigured') await this.decoder.reset();
      this.decoder.configure({
        codec: this.camera.codec,
        codedWidth: this.camera.width,
        codedHeight: this.camera.height,
      });
      this.configuredKey = configKey;
    }
  }

  _onOutput(frame) {
    this._lastOutputTime = performance.now();
    if (!this._request) { frame.close(); return; }
    this._request.outputs.push(frame);
    if (this._request.outputs.length === this._request.expected) {
      const { resolve, outputs } = this._request;
      this._request = null;
      resolve(outputs);
    }
  }

  _onError(err) {
    if (this._request) {
      const { reject } = this._request;
      this._request = null;
      reject(err);
    }
  }

  // Decode the dependency chain for targetFrameIndex in the given segment and
  // resolve with the decoded VideoFrame at that exact index. Calls on the same
  // route are serialized so an in-flight request can never have its output
  // slot overwritten by a newer one.
  decodeFrameAt(segment, targetFrameIndex) {
    const run = this._chain.then(() => this._decodeFrameAtLocked(segment, targetFrameIndex));
    // Keep the chain alive regardless of individual success/failure.
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  async _decodeFrameAtLocked(segment, targetFrameIndex) {
    await this.ensureReady(segment);
    const demuxer = await this.ensureDemuxer(segment);
    const startKey = demuxer.nearestKeyframeAtOrBefore(targetFrameIndex);

    if (this._request) throw new Error(`route ${this.id}: decode request already in flight`);
    if (this.decoder.decodeQueueSize > 0) await this.decoder.flush();

    const chunks = [];
    for (let i = startKey; i <= targetFrameIndex; i++) {
      const meta = demuxer.frames[i];
      chunks.push(new EncodedVideoChunk({
        type: meta.key ? 'key' : 'delta',
        timestamp: Math.round((meta.ptsFrames / demuxer.frameRate) * 1_000_000),
        data: demuxer.encodedChunk(i),
      }));
    }

    const done = new Promise((resolve, reject) => {
      this._request = { outputs: [], expected: chunks.length, resolve, reject };
    });
    for (const chunk of chunks) this.decoder.decode(chunk);
    const outputs = await done;
    const targetOffset = targetFrameIndex - startKey;
    const target = outputs[targetOffset];
    for (let i = 0; i < outputs.length; i++) {
      if (i !== targetOffset) outputs[i].close();
    }
    if (!target) throw new Error(`route ${this.id}: target frame ${targetFrameIndex} was not emitted`);
    return { frame: target, keyframeStart: startKey, demuxer };
  }

  get queueSize() {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  // Release the hardware resource so the LRU pool can hand the budget to another
  // route. Pending VideoFrames stay valid until their holders close them.
  release() {
    if (this._request) {
      this._request.reject(new Error(`route ${this.id}: decoder released mid-decode`));
      this._request = null;
    }
    if (this.decoder) {
      try { this.decoder.close(); } catch { /* already closed */ }
      this.decoder = null;
      this.configuredKey = null;
    }
  }
}
