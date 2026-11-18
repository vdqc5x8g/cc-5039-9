import { Timeline } from './timeline.js';
import { RoutePool } from './route-pool.js';

// Switching state machine:
//   idle      -> no route presenting yet
//   presenting-> a route's frame is on screen, audio clock drives playback
//   waiting   -> a requested route is not ready; current frame is held, no CSS
//                swap, no stale first-frame display
//   gap       -> requested camera has no material for this performance time
//
// Every switch resolves the target source position from the shared timeline
// first, then obtains the decode dependency chain. Presentation only commits
// after the emitted frame's real timestamp is checked against the target.
export class SwitcherKernel extends EventTarget {
  constructor(manifest, { baseUrl = '', maxDecoders = 3 } = {}) {
    super();
    this.timeline = new Timeline(manifest);
    this.pool = new RoutePool(manifest, baseUrl, maxDecoders);
    this.requestedId = null;
    this.presentingId = null;
    this.state = 'idle';
    this.gapReason = null;
    this.lastFrame = null; // { cameraId, frame, performanceTime, renderedAt }
    this.metrics = this._emptyMetrics();
    this._switchSeq = 0;
  }

  _emptyMetrics() {
    return {
      switches: [],
      evictions: 0,
      gapRequests: 0,
      waitedRequests: 0,
    };
  }

  _emitChange(detail = {}) {
    this.dispatchEvent(new CustomEvent('statechange', {
      detail: {
        state: this.state,
        requestedId: this.requestedId,
        presentingId: this.presentingId,
        gapReason: this.gapReason,
        ...detail,
      },
    }));
  }

  isSelectable(cameraId, performanceTime) {
    return this.timeline.segmentAt(cameraId, performanceTime) !== null;
  }

  // Request a perspective for performance time t. Returns a structured result;
  // never throws for ordinary "no material" cases so the UI can show the slate.
  async requestView(cameraId, performanceTime) {
    const seq = ++this._switchSeq;
    const requestedAt = performance.now();
    this.requestedId = cameraId;
    this.gapReason = null;

    const located = this.timeline.locateFrame(cameraId, performanceTime);
    if (!located) {
      const hadPresenter = Boolean(this.presentingId);
      this.state = hadPresenter ? 'presenting' : 'gap';
      this.gapReason = this._describeGap(cameraId, performanceTime);
      this.metrics.gapRequests++;
      this._emitChange({ requestedAt, gapAt: { cameraId, performanceTime, hadPresenter } });
      return { ok: false, reason: 'gap', gapReason: this.gapReason };
    }

    // Same camera: nothing to switch, current playback continues unchanged.
    if (cameraId === this.presentingId && this.lastFrame) {
      this._emitChange();
      return { ok: true, switched: false };
    }

    if (this.presentingId) this.state = 'waiting';
    this.metrics.waitedRequests++;
    this._emitChange({ requestedAt, target: located });

    let route;
    try {
      route = await this.pool.acquire(cameraId, this.presentingId);
      const { frame, keyframeStart } = await route.decodeFrameAt(located.segment, located.frameIndex);
      if (seq !== this._switchSeq) { // a newer request superseded this one
        frame.close();
        return { ok: false, reason: 'superseded' };
      }

      // Verify the real frame time instead of trusting the chunk order.
      const frameMediaSec = frame.timestamp / 1_000_000;
      const actualPerformanceTime = located.segment.start + frameMediaSec;
      const expectedTime = located.frameTime;
      const timeErrorMs = Math.abs(actualPerformanceTime - expectedTime) * 1000;
      if (timeErrorMs > 1.5 / located.segment.fps * 1000) {
        frame.close();
        throw new Error(
          `frame time mismatch on ${cameraId}: got ${actualPerformanceTime.toFixed(3)}s, expected ${expectedTime.toFixed(3)}s`,
        );
      }

      this._commitFrame(cameraId, frame, actualPerformanceTime, located);
      const readyAt = performance.now();
      const record = {
        seq,
        from: this.metrics.switches.length ? this.presentingId : null,
        to: cameraId,
        requestedAt,
        readyAt,
        switchLatencyMs: readyAt - requestedAt,
        targetPerformanceTime: performanceTime,
        actualPerformanceTime,
        syncErrorMs: (actualPerformanceTime - performanceTime) * 1000,
        keyframeStart,
        targetFrameIndex: located.frameIndex,
        decodedChainLength: located.frameIndex - keyframeStart + 1,
        evicted: this.pool.evictions !== this.metrics.evictions,
      };
      this.metrics.evictions = this.pool.evictions;
      this.metrics.switches.push(record);
      this._emitChange({ committed: record });
      return { ok: true, switched: true, record };
    } catch (err) {
      if (seq !== this._switchSeq) return { ok: false, reason: 'superseded' };
      this.state = this.presentingId ? 'presenting' : 'gap';
      this.gapReason = `机位 ${cameraId} 解码失败：${err.message}`;
      this._emitChange({ error: err.message });
      return { ok: false, reason: 'error', error: err.message };
    }
  }

  _commitFrame(cameraId, frame, performanceTime, located) {
    // Close the previously held frame regardless of camera: each committed frame
    // is owned here until the next commit or an explicit gap/teardown.
    if (this.lastFrame) this.lastFrame.frame.close();
    this.lastFrame = {
      cameraId,
      frame,
      performanceTime,
      segment: located.segment,
      frameIndex: located.frameIndex,
      renderedAt: performance.now(),
    };
    this.presentingId = cameraId;
    this.state = 'presenting';
    this.gapReason = null;
  }

  _describeGap(cameraId, t) {
    const cam = this.timeline.camera(cameraId);
    const next = this.timeline.nextCoverage(cameraId, t);
    const firstStart = cam.segments[0]?.start;
    if (firstStart !== undefined && t < firstStart) {
      return `${cam.label} 在 ${firstStart.toFixed(1)}s 才开始录制（当前 ${t.toFixed(1)}s）`;
    }
    if (next) {
      return `${cam.label} 在 ${t.toFixed(1)}s 无素材，下一段 ${next.start.toFixed(1)}s 开始`;
    }
    return `${cam.label} 在 ${t.toFixed(1)}s 之后已无素材`;
  }

  // Used by the playback loop: locate the frame that should show at time t on
  // the presenting route, decoding a fresh keyframe chain after a discontinuity.
  // Every decoded frame is owned by the kernel via lastFrame until the next
  // commit, gap entry or dispose — callers only draw it and never close it.
  async frameForTime(cameraId, t) {
    const located = this.timeline.locateFrame(cameraId, t);
    if (!located) return null;
    if (
      this.lastFrame &&
      this.lastFrame.cameraId === cameraId &&
      this.lastFrame.segment.src === located.segment.src &&
      located.frameIndex === this.lastFrame.frameIndex
    ) {
      return {
        ...located,
        frame: this.lastFrame.frame,
        reuse: true,
        actualPerformanceTime: this.lastFrame.performanceTime,
      };
    }
    const route = await this.pool.acquire(cameraId, cameraId);
    const { frame } = await route.decodeFrameAt(located.segment, located.frameIndex);
    const actualPerformanceTime = located.segment.start + frame.timestamp / 1_000_000;
    // Ownership moves to lastFrame (previous frame closed inside _commitFrame).
    this._commitFrame(cameraId, frame, actualPerformanceTime, located);
    return { ...located, frame, reuse: false, actualPerformanceTime };
  }

  dispose() {
    this.pool.releaseAll();
    if (this.lastFrame) this.lastFrame.frame.close();
    this.lastFrame = null;
  }
}
