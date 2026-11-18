// The shared performance timeline. Every camera segment declares its start/end
// on this timeline, while its own media starts at pts 0. The mapping is therefore
// performanceTime = segment.start + frameIndex / fps. Frame sequence numbers are
// never compared across cameras: two streams can share an index at totally
// different performance times.
export class Timeline {
  constructor(manifest) {
    this.duration = manifest.duration;
    this.cameras = new Map();
    for (const cam of manifest.cameras) {
      this.cameras.set(cam.id, { ...cam, segments: [...cam.segments].sort((a, b) => a.start - b.start) });
    }
  }

  get cameraList() {
    return [...this.cameras.values()];
  }

  camera(cameraId) {
    return this.cameras.get(cameraId);
  }

  // Returns null when the camera has no material covering t. Callers must treat
  // that as "not selectable now" rather than repeating an old frame.
  segmentAt(cameraId, t) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return null;
    return cam.segments.find((s) => t >= s.start && t < s.end) ?? null;
  }

  // Exact frame lookup inside a segment, returning the frame whose time is the
  // closest one not later than t (the frame displayed during [frameT, frameT+Δ)).
  locateFrame(cameraId, t) {
    const segment = this.segmentAt(cameraId, t);
    if (!segment) return null;
    const mediaTime = t - segment.start;
    const frameIndex = Math.min(
      Math.floor(mediaTime * segment.fps + 1e-9),
      Math.floor((segment.end - segment.start) * segment.fps) - 1,
    );
    const frameTime = segment.start + frameIndex / segment.fps;
    return { segment, frameIndex, frameTime, mediaTime };
  }

  // Coverage for UI button state: next segment start after t, or null.
  nextCoverage(cameraId, t) {
    const cam = this.cameras.get(cameraId);
    if (!cam) return null;
    return cam.segments.find((s) => s.start > t) ?? null;
  }
}
