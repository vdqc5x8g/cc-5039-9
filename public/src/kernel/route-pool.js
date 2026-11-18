import { Route } from './route.js';

// Bounded pool of Route decoders. This is what makes the implementation a real
// switching kernel rather than N background <video> elements: only
// `maxDecoders` VideoDecoder objects exist at any time, and an evicted route
// must rebuild its keyframe dependency chain before it can present again.
export class RoutePool {
  constructor(manifest, baseUrl, maxDecoders = 3) {
    this.routes = new Map(
      manifest.cameras.map((cam) => [cam.id, new Route(cam, baseUrl)]),
    );
    this.maxDecoders = maxDecoders;
    this.lru = []; // route ids, most recently used last
    this.evictions = 0;
  }

  get activeDecoderCount() {
    return this.lru.length;
  }

  // Acquire a route for use, evicting the least recently used decoder when the
  // hardware budget is full. The currently presenting route is pinned.
  async acquire(cameraId, pinnedId = null) {
    const route = this.routes.get(cameraId);
    if (!route) throw new Error(`unknown camera ${cameraId}`);

    const hasDecoder = this.lru.includes(cameraId);
    if (!hasDecoder) {
      if (this.lru.length >= this.maxDecoders) {
        const victim = this.lru.find((id) => id !== pinnedId) ?? this.lru[0];
        this.routes.get(victim).release();
        this.lru = this.lru.filter((id) => id !== victim);
        this.evictions++;
      }
      this.lru.push(cameraId);
    } else {
      this.lru = [...this.lru.filter((id) => id !== cameraId), cameraId];
    }
    return route;
  }

  get(cameraId) {
    return this.routes.get(cameraId);
  }

  releaseAll() {
    for (const route of this.routes.values()) route.release();
    this.lru = [];
  }
}
