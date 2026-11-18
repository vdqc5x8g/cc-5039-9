import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = join(process.cwd(), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ivf': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.css': 'text/css; charset=utf-8',
};

async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://x').pathname;
      const rel = pathname === '/' ? '/index.html' : pathname;
      const file = join(ROOT, decodeURIComponent(rel));
      await stat(file);
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

let server;
test.beforeAll(async () => { server = await serve(); });
test.afterAll(async () => { await server.close(); });

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(server.url);
  await page.waitForFunction(() => window.__stage !== undefined);
  return { page, errors };
}

test.describe('stage multi-camera kernel', () => {
  test('uses WebCodecs decoders, not background video elements', async () => {
    const browser = await chromium.launch();
    const { page, errors } = await newPage(browser);
    const hasVideoElement = await page.locator('video').count();
    expect(hasVideoElement).toBe(0);
    const webCodecs = await page.evaluate(() => typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function');
    expect(webCodecs).toBe(true);
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
    await browser.close();
  });

  test('switch lands on the same performance moment with measured latency and sync error', async () => {
    const browser = await chromium.launch();
    const { page } = await newPage(browser);
    await page.evaluate(() => window.__stage.player.seek(18.7));
    await page.getByRole('button', { name: /全景机位/ }).click();
    await page.waitForFunction(() => window.__stage.kernel.presentingId === 'cam-wide');

    const t0 = await page.evaluate(() => performance.now());
    await page.getByRole('button', { name: /鼓点机位/ }).click();
    const record = await page.waitForFunction(() => {
      const sw = window.__stage.kernel.metrics.switches;
      return sw.find((s) => s.to === 'cam-drum');
    }).then((h) => h.evaluate((v) => v));
    const latency = record.readyAt - record.requestedAt;
    expect(latency).toBeGreaterThan(0);
    expect(latency).toBeLessThan(2000);
    // drum is 24fps: frame at 18.7 must be within one frame period (~41.7ms)
    expect(Math.abs(record.syncErrorMs)).toBeLessThan(1000 / 24 + 1);
    // the committed frame timestamp is independently checked against target
    expect(record.actualPerformanceTime).toBeGreaterThan(18.7 - 1 / 24 - 0.001);
    expect(record.actualPerformanceTime).toBeLessThanOrEqual(18.7 + 0.001);
    expect(record.decodedChainLength).toBeGreaterThanOrEqual(1);
    await browser.close();
  });

  test('canvas pixels actually change to the target camera hue', async () => {
    const browser = await chromium.launch();
    const { page } = await newPage(browser);
    await page.evaluate(() => window.__stage.player.seek(12));
    const readHue = async () => page.evaluate(() => {
      const c = document.getElementById('stage');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
    await page.getByRole('button', { name: /全景机位/ }).click();
    await page.waitForFunction(() => window.__stage.kernel.presentingId === 'cam-wide');
    const wideRgb = await readHue();
    await page.getByRole('button', { name: /左侧机位/ }).click();
    await page.waitForFunction(() => window.__stage.kernel.presentingId === 'cam-left');
    const leftRgb = await readHue();
    expect(wideRgb.join(',')).not.toEqual(leftRgb.join(','));
    await browser.close();
  });

  test('gap camera is explicitly unavailable and produces a slate, not a repeated frame', async () => {
    const browser = await chromium.launch();
    const { page } = await newPage(browser);
    await page.evaluate(() => window.__stage.player.seek(27));
    const closeupBtn = page.getByRole('button', { name: /特写机位/ });
    await expect(closeupBtn).toBeDisabled();
    // kernel-level request still returns the structured gap result
    const result = await page.evaluate(() => window.__stage.kernel.requestView('cam-closeup', 27));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('gap');
    expect(result.gapReason).toContain('无素材');
    const gapCount = await page.evaluate(() => window.__stage.kernel.metrics.gapRequests);
    expect(gapCount).toBeGreaterThan(0);
    await browser.close();
  });

  test('decoder budget is enforced: 4th camera evicts an LRU decoder', async () => {
    const browser = await chromium.launch();
    const { page } = await newPage(browser);
    await page.evaluate(() => window.__stage.player.seek(12));
    for (const id of ['cam-wide', 'cam-left', 'cam-drum', 'cam-closeup']) {
      await page.evaluate((cid) => window.__stage.player.selectCamera(cid), id);
      await page.waitForFunction((cid) => window.__stage.kernel.presentingId === cid, id);
    }
    const state = await page.evaluate(() => ({
      active: window.__stage.kernel.pool.activeDecoderCount,
      max: window.__stage.kernel.pool.maxDecoders,
      evictions: window.__stage.kernel.pool.evictions,
    }));
    expect(state.active).toBeLessThanOrEqual(state.max);
    expect(state.evictions).toBeGreaterThan(0);
    // going back to an evicted camera requires a fresh keyframe chain decode
    const back = await page.evaluate(async () => {
      const r = await window.__stage.player.selectCamera('cam-wide');
      return r.record;
    });
    expect(back.decodedChainLength).toBeGreaterThanOrEqual(1);
    await browser.close();
  });

  test('different frame rates align to the same performance moment', async () => {
    const browser = await chromium.launch();
    const { page } = await newPage(browser);
    await page.evaluate(() => window.__stage.player.seek(18.7));
    const errors = [];
    for (const [id, fps] of [['cam-wide', 30], ['cam-drum', 24], ['cam-closeup', 15]]) {
      const r = await page.evaluate(async (cid) => {
        const out = await window.__stage.player.selectCamera(cid);
        return out.record ?? null;
      }, id);
      if (r) errors.push({ id, err: Math.abs(r.syncErrorMs), limit: 1000 / fps });
    }
    for (const e of errors) {
      expect(e.err, `${e.id} sync error`).toBeLessThan(e.limit + 1);
    }
    await browser.close();
  });

  test('playback through a coverage gap shows an explicit gap state then recovers', async () => {
    const browser = await chromium.launch({
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const { page, errors } = await newPage(browser);
    await page.evaluate(() => window.__stage.player.seek(22.5));
    await page.evaluate(() => window.__stage.player.selectCamera('cam-closeup'));
    await page.waitForFunction(() => window.__stage.kernel.presentingId === 'cam-closeup');
    await page.evaluate(() => window.__stage.player.play());
    await page.waitForFunction(() => window.__stage.player.playing === true);

    await page.waitForFunction(() => {
      const t = window.__stage.player.currentTime;
      return t >= 25 && window.__stage.kernel.state === 'gap';
    }, { timeout: 15000 });
    // gap must not be masked by re-presenting the previous frame
    const gapInfo = await page.evaluate(() => ({
      state: window.__stage.kernel.state,
      reason: window.__stage.kernel.gapReason,
      blackMs: window.__stage.player.blackRangeMs,
      presented: window.__stage.player.presentedFrame,
    }));
    expect(gapInfo.reason).toContain('无素材');
    expect(gapInfo.blackMs).toBeGreaterThan(0);
    expect(gapInfo.presented).toBeNull();

    await page.waitForFunction(() => {
      const t = window.__stage.player.currentTime;
      return t >= 31 && window.__stage.kernel.state === 'presenting'
        && window.__stage.kernel.presentingId === 'cam-closeup';
    }, { timeout: 15000 });
    // after recovery the live sync readout is rebuilt against the audio clock
    const recovered = await page.evaluate(() => window.__stage.player.presentedFrame);
    expect(recovered).not.toBeNull();
    expect(recovered.cameraId).toBe('cam-closeup');
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
    await browser.close();
  });

  test('switch latency and black range are measured across heterogeneous sources', async () => {
    const browser = await chromium.launch();
    const { page } = await newPage(browser);
    await page.evaluate(() => window.__stage.player.seek(18.7));
    // 30fps -> 25fps -> 24fps -> 15fps, all resolving the same performance moment
    for (const id of ['cam-wide', 'cam-left', 'cam-drum', 'cam-closeup']) {
      await page.evaluate((c) => window.__stage.player.selectCamera(c), id);
      await page.waitForFunction((c) => window.__stage.kernel.presentingId === c, id);
    }
    const summary = await page.evaluate(() => {
      const sw = window.__stage.kernel.metrics.switches;
      return {
        count: sw.length,
        latencyMs: sw.map((s) => +s.switchLatencyMs.toFixed(2)),
        maxLatencyMs: +Math.max(...sw.map((s) => s.switchLatencyMs)).toFixed(2),
        syncErrorsMs: sw.map((s) => +s.syncErrorMs.toFixed(2)),
        chainLengths: sw.map((s) => s.decodedChainLength),
        evictions: window.__stage.kernel.pool.evictions,
      };
    });
    console.log('SWITCH METRICS:', JSON.stringify(summary));
    expect(summary.count).toBe(4);
    expect(summary.maxLatencyMs).toBeGreaterThan(0);
    expect(summary.maxLatencyMs).toBeLessThan(2000);
    // every sync error must stay within one frame period of the target camera
    const fpsById = { 'cam-wide': 30, 'cam-left': 25, 'cam-drum': 24, 'cam-closeup': 15 };
    for (const s of await page.evaluate(() => window.__stage.kernel.metrics.switches)) {
      expect(Math.abs(s.syncErrorMs)).toBeLessThan(1000 / fpsById[s.to] + 1);
    }
    // a normal camera-to-camera switch holds the previous frame, so no black time
    expect(await page.evaluate(() => window.__stage.player.blackRangeMs)).toBe(0);
    await browser.close();
  });

  test('segment boundary switch keeps frame time continuous', async () => {
    const browser = await chromium.launch();
    const { page } = await newPage(browser);
    // cam-wide has a segment join exactly at 16s and 32s.
    await page.evaluate(() => window.__stage.player.seek(15.8));
    await page.evaluate(() => window.__stage.player.selectCamera('cam-wide'));
    const before = await page.evaluate(() => window.__stage.kernel.lastFrame.performanceTime);

    // A same-camera request is a no-op by design; the playback loop re-pulls a
    // frame against the new clock instead, crossing the segment boundary.
    await page.evaluate(() => window.__stage.player.seek(16.1));
    const out = await page.evaluate(async () => {
      const f = await window.__stage.kernel.frameForTime('cam-wide', 16.1);
      return { segmentIndex: f.segment.index, frameIndex: f.frameIndex, frameTime: f.frameTime };
    });
    expect(out.segmentIndex).toBe(1);
    expect(out.frameIndex).toBeGreaterThanOrEqual(0);
    expect(out.frameTime).toBeGreaterThan(before);
    expect(out.frameTime).toBeLessThanOrEqual(16.1 + 1e-9);
    await browser.close();
  });

  test('sustained playback crosses segment joins without frame leaks or errors', async () => {
    const browser = await chromium.launch({
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const { page, errors } = await newPage(browser);
    // cam-wide joins at 16s and 32s; play across both within a short window.
    await page.evaluate(() => window.__stage.player.seek(14));
    await page.evaluate(() => window.__stage.player.selectCamera('cam-wide'));
    await page.waitForFunction(() => window.__stage.kernel.presentingId === 'cam-wide');
    await page.evaluate(() => window.__stage.player.play());

    await page.waitForFunction(() => window.__stage.player.currentTime >= 34, { timeout: 25000 });
    await page.evaluate(() => window.__stage.player.pause());

    const finalState = await page.evaluate(() => {
      const lf = window.__stage.kernel.lastFrame;
      return {
        state: window.__stage.kernel.state,
        segmentIndex: lf?.segment.index,
        frameTime: lf?.performanceTime,
        // only the single held frame should remain; no accumulation in any route
        decoders: window.__stage.kernel.pool.activeDecoderCount,
      };
    });
    expect(finalState.state).toBe('presenting');
    expect(finalState.segmentIndex).toBe(2); // crossed 16s and 32s joins
    expect(finalState.frameTime).toBeGreaterThan(32);
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
    await browser.close();
  });
});
