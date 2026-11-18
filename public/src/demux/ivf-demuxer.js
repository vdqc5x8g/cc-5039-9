// Minimal IVF demuxer for VP8 streams. It fetches the (small, test-scale) file
// over HTTP and builds a frame index including keyframe flags, so the kernel
// can locate the nearest preceding keyframe and the exact decode dependency
// chain instead of assuming frame indices line up across cameras.
const IVF_HEADER_SIZE = 32;
const IVF_FRAME_HEADER_SIZE = 12;

export class IvfDemuxer {
  constructor(url) {
    this.url = url;
    this.frames = []; // { offset, size, ptsFrames, key }
    this.header = null;
    this._buffer = null;
  }

  async init() {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`fetch ${this.url} failed: ${res.status}`);
    this._buffer = new Uint8Array(await res.arrayBuffer());
    const dv = new DataView(this._buffer.buffer);
    const signature = String.fromCharCode(...this._buffer.subarray(0, 4));
    if (signature !== 'DKIF') throw new Error(`${this.url}: not an IVF file`);
    this.header = {
      codec: new TextDecoder().decode(this._buffer.subarray(8, 12)),
      width: dv.getUint16(12, true),
      height: dv.getUint16(14, true),
      rate: dv.getUint32(16, true),
      scale: dv.getUint32(20, true),
      frameCount: dv.getUint32(24, true),
    };

    let offset = IVF_HEADER_SIZE;
    while (offset + IVF_FRAME_HEADER_SIZE <= this._buffer.length) {
      const size = dv.getUint32(offset, true);
      const ptsFrames = Number(dv.getBigUint64(offset + 4, true));
      const frameStart = offset + IVF_FRAME_HEADER_SIZE;
      if (frameStart + size > this._buffer.length) break;
      // VP8 payload descriptor: low bit of byte 0 is 0 for keyframes.
      const key = (this._buffer[frameStart] & 0x01) === 0;
      this.frames.push({ offset: frameStart, size, ptsFrames, key });
      offset = frameStart + size;
    }
    return this;
  }

  get frameRate() {
    return this.header.rate / this.header.scale;
  }

  // Media-local time of frame i in seconds (IVF pts is in frame units).
  frameMediaTime(i) {
    return this.frames[i].ptsFrames / this.frameRate;
  }

  // Nearest frame whose media time <= t, clamped to the available range.
  frameAtMediaTime(t) {
    const targetPts = Math.floor(t * this.frameRate);
    let lo = 0;
    let hi = this.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.frames[mid].ptsFrames <= targetPts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  nearestKeyframeAtOrBefore(i) {
    for (let j = i; j >= 0; j--) {
      if (this.frames[j].key) return j;
    }
    return 0;
  }

  encodedChunk(frameIndex) {
    const f = this.frames[frameIndex];
    return this._buffer.subarray(f.offset, f.offset + f.size);
  }
}
