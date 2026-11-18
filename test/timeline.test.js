import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Timeline } from '../public/src/kernel/timeline.js';

const manifest = JSON.parse(await readFile(new URL('../public/media/manifest.json', import.meta.url)));
const tl = new Timeline(manifest);

test('maps performance time to the correct segment despite differing media starts', () => {
  // cam-left only starts at 4s; at 18.7s we must land in seg0 with media time 14.7s
  const loc = tl.locateFrame('cam-left', 18.7);
  assert.equal(loc.segment.start, 4);
  assert.equal(loc.segment.fps, 25);
  assert.ok(Math.abs(loc.mediaTime - 14.7) < 1e-9);
  // frame index 367 (floor(14.7*25)) and its true performance time
  assert.equal(loc.frameIndex, 367);
  assert.ok(Math.abs(loc.frameTime - (4 + 367 / 25)) < 1e-9);
});

test('frame sequence numbers are not shared time: same index means different moments', () => {
  const wide = tl.locateFrame('cam-wide', 10); // seg0, 30fps
  const closeup = tl.locateFrame('cam-closeup', 12); // seg0 starts at 10s, 15fps
  // Both could be frame index ~60 in their own files...
  assert.equal(wide.frameIndex, 300);
  assert.equal(closeup.frameIndex, 30);
  // ...but their performance times differ by construction.
  assert.ok(Math.abs(wide.frameTime - 10) < 1 / 30);
  assert.ok(Math.abs(closeup.frameTime - 12) < 1 / 15);
});

test('different frame rates converge on the same performance moment within one frame period', () => {
  const t = 18.7;
  for (const id of ['cam-wide', 'cam-left', 'cam-drum', 'cam-closeup']) {
    const loc = tl.locateFrame(id, t);
    const period = 1 / loc.segment.fps;
    assert.ok(loc.frameTime <= t + 1e-9, `${id} frame must not be later than requested time`);
    assert.ok(t - loc.frameTime <= period + 1e-9, `${id} must be within one frame period`);
  }
});

test('explicitly reports missing coverage instead of fabricating a frame', () => {
  assert.equal(tl.segmentAt('cam-closeup', 5), null); // before first segment
  assert.equal(tl.segmentAt('cam-closeup', 27), null); // inside the 24-30 gap
  assert.equal(tl.segmentAt('cam-closeup', 38), null); // after last segment
  assert.equal(tl.locateFrame('cam-closeup', 27), null);
  const next = tl.nextCoverage('cam-closeup', 27);
  assert.equal(next.start, 30);
});

test('segment boundary at exact end time falls through to the next segment', () => {
  const loc = tl.locateFrame('cam-wide', 16);
  assert.equal(loc.segment.index, 1);
  assert.equal(loc.frameIndex, 0);
  assert.equal(loc.frameTime, 16);
});

test('unknown camera is treated as having no material', () => {
  assert.equal(tl.segmentAt('nope', 10), null);
});
