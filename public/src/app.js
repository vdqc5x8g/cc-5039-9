import { SwitcherKernel } from './kernel/switcher-kernel.js';
import { StagePlayer } from './player/stage-player.js';

const $ = (id) => document.getElementById(id);

const manifest = await fetch('./media/manifest.json').then((r) => r.json());
const kernel = new SwitcherKernel(manifest, { baseUrl: './media/', maxDecoders: 3 });
const player = new StagePlayer(kernel, {
  canvas: $('stage'),
  audioEl: $('masterAudio'),
  manifest,
  baseUrl: './media/',
});
await player.load();

const colorFor = (hue) => `hsl(${hue}, 70%, 55%)`;
const cameraById = new Map(manifest.cameras.map((c) => [c.id, c]));
const buttons = new Map();

// Build camera buttons from the manifest.
for (const cam of manifest.cameras) {
  const btn = document.createElement('button');
  btn.className = 'cam-btn';
  btn.innerHTML = `<span class="dot" style="background:${colorFor(cam.hue)}"></span>${cam.label}<br>
    <small style="color:var(--muted)">${cam.id} · ${cam.fps}fps</small>`;
  btn.addEventListener('click', () => player.selectCamera(cam.id));
  $('cameraButtons').appendChild(btn);
  buttons.set(cam.id, btn);
}

const stateLabels = { idle: '空闲', waiting: '等待解码', presenting: '呈现中', gap: '无素材' };

kernel.addEventListener('statechange', (e) => {
  const d = e.detail;
  $('requestedView').textContent = d.requestedId
    ? `${cameraById.get(d.requestedId)?.label ?? d.requestedId}（${d.requestedId}）` : '—';
  $('presentingView').textContent = d.presentingId
    ? `${cameraById.get(d.presentingId)?.label ?? d.presentingId}（${d.presentingId}）` : '—';
  const badge = $('stateBadge');
  badge.className = `badge ${d.state}`;
  badge.textContent = stateLabels[d.state] ?? d.state;
  $('gapNote').textContent = d.gapReason ?? '';

  const overlay = $('overlay');
  if (d.state === 'waiting') {
    overlay.classList.add('show');
    $('spinner').style.display = 'block';
    $('overlayTitle').textContent = '等待目标机位就绪';
    $('overlayDetail').textContent = '保留当前画面，正在计算目标源位置并取得关键帧解码依赖…';
  } else if (d.state === 'gap' && !d.presentingId) {
    overlay.classList.add('show');
    $('spinner').style.display = 'none';
    $('overlayTitle').textContent = '该时段无素材';
    $('overlayDetail').textContent = d.gapReason ?? '';
  } else {
    overlay.classList.remove('show');
  }

  if (d.committed) {
    renderMetricRow(d.committed);
    // The frame just committed; refresh sync readouts immediately rather than
    // waiting for the next animation tick (which never fires while paused).
    renderStatus(snapshot());
  }
  refreshButtonStyles();
});

function refreshButtonStyles() {
  const t = player.currentTime;
  for (const [id, btn] of buttons) {
    btn.classList.toggle('requested', id === kernel.requestedId && id !== kernel.presentingId);
    btn.classList.toggle('presenting', id === kernel.presentingId);
    const selectable = kernel.isSelectable(id, t);
    btn.classList.toggle('unavailable', !selectable);
    btn.disabled = !selectable;
    btn.title = selectable ? '' : kernel._describeGap(id, t);
  }
}

function renderMetricRow(r) {
  const body = $('metricsBody');
  if (body.querySelector('td[colspan]')) body.innerHTML = '';
  const tr = document.createElement('tr');
  const from = r.from ? cameraById.get(r.from)?.label ?? r.from : '（首帧）';
  const to = cameraById.get(r.to)?.label ?? r.to;
  tr.innerHTML = `<td>${r.seq}</td><td>${from} → ${to}</td>
    <td>${r.switchLatencyMs.toFixed(1)}</td>
    <td class="${Math.abs(r.syncErrorMs) < 1000 / manifest.cameras.find(c=>c.id===r.to).fps ? 'sync-good' : 'sync-bad'}">${r.syncErrorMs.toFixed(1)}</td>
    <td>${r.decodedChainLength} 帧 (自关键帧 ${r.keyframeStart})</td>
    <td>${r.evicted ? '是' : '否'}</td>`;
  body.prepend(tr);
}

// Transport controls.
$('playBtn').addEventListener('click', () => player.play());
$('pauseBtn').addEventListener('click', () => player.pause());
$('seek').addEventListener('input', (e) => player.seek(Number(e.target.value)));

// Any clock discontinuity (programmatic seek included) changes which cameras
// have material, so button availability is recomputed off the audio element.
$('masterAudio').addEventListener('seeked', () => refreshButtonStyles());

function renderStatus(snap) {
  $('seek').value = snap.clockTime.toFixed(2);
  $('clockLabel').textContent = `${snap.clockTime.toFixed(2)}s / ${manifest.duration.toFixed(2)}s`;
  $('clockTime').textContent = `${snap.clockTime.toFixed(3)} s`;
  if (snap.sync) {
    $('frameTime').textContent = `${snap.sync.frameTime.toFixed(3)} s`;
    const err = snap.sync.syncErrorMs;
    const el = $('syncError');
    // Negative = the displayed frame's time precedes the clock by sub-frame lag.
    el.textContent = `${err >= 0 ? '+' : ''}${err.toFixed(1)} ms`;
    el.className = 'v ' + (Math.abs(err) < 100 ? 'sync-good' : 'sync-bad');
  } else {
    $('frameTime').textContent = '—';
    $('syncError').textContent = '—';
  }
  $('blackRange').textContent = `${snap.blackRangeMs.toFixed(0)} ms`;
  $('decoderCount').textContent = `${snap.decoders} / ${kernel.pool.maxDecoders}`;
  refreshButtonStyles();
}

function snapshot() {
  const pf = player.presentedFrame;
  // Recompute against the live clock so a reused frame still reports the current
  // lead/lag instead of a value frozen at its first presentation.
  const sync = pf ? {
    frameTime: pf.frameTime,
    syncErrorMs: (pf.frameTime - player.currentTime) * 1000,
    cameraId: pf.cameraId,
  } : null;
  return {
    clockTime: player.currentTime,
    state: kernel.state,
    requestedId: kernel.requestedId,
    presentingId: kernel.presentingId,
    sync,
    blackRangeMs: player.blackRangeMs,
    decoders: kernel.pool.activeDecoderCount,
  };
}

player.onTick = () => renderStatus(snapshot());
$('masterAudio').addEventListener('seeked', () => renderStatus(snapshot()));
$('masterAudio').addEventListener('loadedmetadata', () => renderStatus(snapshot()));

// Scenario buttons: each drives the real kernel at real timeline positions.
$('testCold').addEventListener('click', async () => {
  // Touch four cameras with a 3-decoder budget: the fourth acquisition evicts.
  await player.seek(12);
  for (const id of ['cam-wide', 'cam-left', 'cam-drum', 'cam-closeup']) {
    await player.selectCamera(id);
    await new Promise((r) => setTimeout(r, 120));
  }
});
$('testGap').addEventListener('click', async () => {
  await player.seek(27); // closeup has no coverage in [24,30)
  await player.selectCamera('cam-closeup');
});
$('testFps').addEventListener('click', async () => {
  await player.seek(18.7); // 30fps wide vs 24fps drum vs 15fps closeup
  for (const id of ['cam-wide', 'cam-drum', 'cam-closeup']) {
    await player.selectCamera(id);
    await new Promise((r) => setTimeout(r, 150));
  }
});
$('testSeek').addEventListener('click', async () => {
  await player.seek(33);
  await player.selectCamera('cam-left');
  await player.seek(5);
  await player.selectCamera('cam-wide');
});

window.__stage = { kernel, player, manifest }; // expose for browser E2E tests
