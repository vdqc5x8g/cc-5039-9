import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { IvfDemuxer } from '../public/src/demux/ivf-demuxer.js';

// Node-side structural twin of the browser fetch path.
class NodeIvf extends IvfDemuxer {
  async initFromBytes(bytes) {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      arrayBuffer: async () => bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
      ),
    });
    try { return await this.init(); } finally { globalThis.fetch = original; }
  }
}

const dir = new URL('../public/media/', import.meta.url);
const files = (await readdir(dir)).filter((n) => n.endsWith('.ivf'));

test('every generated IVF indexes all frames with correct keyframe cadence', async () => {
  for (const name of files) {
    const bytes = new Uint8Array(await readFile(new URL(name, dir)));
    const d = await new NodeIvf(name).initFromBytes(bytes);
    assert.equal(d.header.codec, 'VP80', name);
    assert.equal(d.frames.length, d.header.frameCount, name);
    assert.equal(d.frames[0].key, true, `${name} first frame must be a keyframe`);
    const gop = d.frames.filter((f) => f.key).length;
    assert.ok(gop >= 2, `${name} should contain several keyframes, got ${gop}`);
    // keyframes must be exactly one GOP apart (gopFrames = 2*fps)
    const keyIdx = d.frames.map((f, i) => (f.key ? i : -1)).filter((i) => i >= 0);
    for (let i = 1; i < keyIdx.length; i++) {
      assert.equal(keyIdx[i] - keyIdx[i - 1], Math.round(d.frameRate * 2), name);
    }
  }
});

test('frameAtMediaTime and nearestKeyframeAtOrBefore drive dependency lookup', async () => {
  const bytes = new Uint8Array(await readFile(new URL('cam-drum-0.ivf', dir)));
  const d = await new NodeIvf('cam-drum-0.ivf').initFromBytes(bytes);
  assert.equal(d.frameRate, 24);
  // 5.3s into the segment -> frame 127; preceding keyframe is 96 (4s GOP)
  const i = d.frameAtMediaTime(5.3);
  assert.equal(i, 127);
  assert.equal(d.nearestKeyframeAtOrBefore(i), 96);
  const before = d.frameMediaTime(d.nearestKeyframeAtOrBefore(i));
  assert.ok(before <= 5.3);
});

test('encoded chunks stay within the byte buffer', async () => {
  const bytes = new Uint8Array(await readFile(new URL('cam-wide-0.ivf', dir)));
  const d = await new NodeIvf('cam-wide-0.ivf').initFromBytes(bytes);
  const last = d.frames[d.frames.length - 1];
  const chunk = d.encodedChunk(d.frames.length - 1);
  assert.equal(chunk.byteLength, last.size);
  assert.ok(last.offset + last.size <= bytes.length);
});
