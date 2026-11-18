// StagePlayer ties the switcher kernel to a canvas and a master audio track.
// The <audio> element is the single performance clock: video frames are pulled
// from the kernel against audio.currentTime, so every camera presents the same
// performance moment even when their frame rates and segment starts differ.
export class StagePlayer {
  constructor(kernel, { canvas, audioEl, manifest, baseUrl = '' }) {
    this.kernel = kernel;
    this.canvas = canvas;
    this.audio = audioEl;
    this.manifest = manifest;
    this.baseUrl = baseUrl;
    this.ctx = canvas.getContext('2d');
    this.playing = false;
    this._raf = 0;
    this._inflight = false;
    this._lastClock = 0;
    this._lastDrawTime = null;
    this._blackStart = null;
    this._blackMs = 0;
    this.onTick = null;
    this._boundLoop = this._loop.bind(this);

    this.audio.addEventListener('play', () => { this.playing = true; this._start(); });
    this.audio.addEventListener('pause', () => {
      this.playing = false;
      this._stop();
      this._refreshPausedFrame();
    });
    this.audio.addEventListener('seeked', () => this._refreshPausedFrame());
    // A gap detected at request time (button click while paused) must clear the
    // canvas too, not just flip a status flag while the old frame stays visible.
    this.kernel.addEventListener('statechange', (e) => {
      if (e.detail.gapAt) this._enterGap(e.detail.gapAt.performanceTime);
    });
  }

  get currentTime() {
    return this.audio.currentTime;
  }

  get lastSync() {
    return this._lastSync ?? null;
  }

  get blackRangeMs() {
    return this._blackMs + (this._blackStart !== null ? performance.now() - this._blackStart : 0);
  }

  async load() {
    this.audio.src = `${this.baseUrl ?? ''}${this.manifest.audio.src}`;
    this._drawSlate('就绪', '点击播放后选择机位');
  }

  async play() {
    await this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  async seek(t) {
    const clamped = Math.max(0, Math.min(this.manifest.duration, t));
    this.audio.currentTime = clamped;
    if (!this.playing) await this._refreshPausedFrame();
  }

  // User-facing camera button entry point.
  async selectCamera(cameraId) {
    const result = await this.kernel.requestView(cameraId, this.audio.currentTime);
    if (!this.playing) await this._refreshPausedFrame();
    return result;
  }

  _start() {
    this._stop();
    this._raf = requestAnimationFrame(this._boundLoop);
  }

  _stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  async _refreshPausedFrame() {
    const t = this.audio.currentTime;
    if (!this.kernel.presentingId) return;
    if (!this.kernel.isSelectable(this.kernel.presentingId, t)) {
      this._enterGap(t);
      return;
    }
    if (this.kernel.state === 'gap') this._exitGap();
    const out = await this.kernel.frameForTime(this.kernel.presentingId, t);
    if (!out) {
      this._enterGap(t);
      return;
    }
    this._present(out, t);
  }

  async _loop() {
    if (!this.playing) return;
    this._raf = requestAnimationFrame(this._boundLoop);
    if (this._inflight) return; // serialize pulls: no frame queue races
    const t = this.audio.currentTime;
    if (t === this._lastClock) return;
    this._lastClock = t;

    const cameraId = this.kernel.presentingId;
    if (!cameraId) {
      this._drawSlate('播放中', '请选择一个机位');
      this._markBlack();
      this._fireTick(t);
      return;
    }
    if (!this.kernel.isSelectable(cameraId, t)) {
      this._enterGap(t);
      this._fireTick(t);
      return;
    }
    if (this.kernel.state === 'gap') this._exitGap();

    this._inflight = true;
    try {
      const out = await this.kernel.frameForTime(cameraId, t);
      if (!out) {
        this._enterGap(t);
      } else {
        if (this.kernel.state === 'gap') this._exitGap();
        this._present(out, t);
      }
    } finally {
      this._inflight = false;
    }
    this._fireTick(t);
  }

  // The presenting route stays pinned in presentingId (so playback resumes
  // from it), but state becomes 'gap', the old frame is released and the canvas
  // is cleared — a missing segment must never be masked by repeating the frame.
  _enterGap(t) {
    if (this.kernel.state !== 'gap') {
      this.kernel.state = 'gap';
      this.kernel.gapReason = this.kernel._describeGap(this.kernel.presentingId ?? this.kernel.requestedId, t);
      this.kernel._emitChange({ enteredGapAt: t });
    }
    if (this.kernel.lastFrame) {
      this.kernel.lastFrame.frame.close();
      this.kernel.lastFrame = null;
    }
    this._lastSync = null;
    this._presented = null;
    this._drawGapSlate(t);
    this._markBlack();
  }

  _exitGap() {
    this.kernel.state = 'presenting';
    this.kernel.gapReason = null;
    this.kernel._emitChange({ exitedGap: true });
  }

  _present(out, clockTime) {
    const frame = out.frame;
    const cameraId = this.kernel.presentingId;
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    this._settleBlack();
    this._lastDrawTime = performance.now();
    // Frame lifecycle is owned by the kernel; the player only draws it.
    this._presented = {
      cameraId,
      frameTime: out.actualPerformanceTime ?? out.frameTime,
      segment: out.segment,
      frameIndex: out.frameIndex,
    };
    this._lastSync = {
      clockTime,
      frameTime: this._presented.frameTime,
      syncErrorMs: (this._presented.frameTime - clockTime) * 1000,
      cameraId,
    };
  }

  get presentedFrame() {
    return this._presented ?? null;
  }

  _markBlack() {
    if (this._blackStart === null) this._blackStart = performance.now();
  }

  _settleBlack() {
    if (this._blackStart !== null) {
      this._blackMs += performance.now() - this._blackStart;
      this._blackStart = null;
    }
  }

  _drawGapSlate(t) {
    const cam = this.kernel.timeline.camera(this.kernel.requestedId);
    const reason = this.kernel.gapReason ?? `${cam?.label ?? '机位'} 在 ${t.toFixed(1)}s 无素材`;
    this._drawSlate('该时段无素材', reason, '#7a1f1f');
    if (this._blackStart === null) this._blackStart = performance.now();
  }

  _drawSlate(title, subtitle, bg = '#1d2433') {
    const { width: w, height: h } = this.canvas;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.fillStyle = bg;
    this.ctx.fillRect(0, 0, w, h);
    this.ctx.strokeStyle = '#46506b';
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(6, 6, w - 12, h - 12);
    this.ctx.fillStyle = '#e8ecf6';
    this.ctx.font = 'bold 20px sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(title, w / 2, h / 2 - 8);
    this.ctx.font = '14px sans-serif';
    this.ctx.fillStyle = '#aab4cc';
    this.ctx.fillText(subtitle, w / 2, h / 2 + 18);
  }

  _fireTick(t) {
    this.onTick?.({
      clockTime: t,
      state: this.kernel.state,
      requestedId: this.kernel.requestedId,
      presentingId: this.kernel.presentingId,
      sync: this._lastSync ?? null,
      blackRangeMs: this.blackRangeMs,
      decoders: this.kernel.pool.activeDecoderCount,
    });
  }

  dispose() {
    this._stop();
    this.audio.pause();
    this.kernel.dispose();
  }
}
