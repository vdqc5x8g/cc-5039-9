// Generates the multi-camera stage test media:
//  - four VP8/IVF camera streams with different media start offsets, frame rates
//    and a missing segment (cam4 has no material for part of the show)
//  - one master audio WAV covering the whole performance
//  - manifest.json describing coverage in a shared performance timeline
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFFmpeg } from './ffmpeg-node.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = join(ROOT, 'public', 'media');

const SHOW_DURATION = 40; // performance timeline seconds
const WIDTH = 320;
const HEIGHT = 180;
const SAMPLE_RATE = 44100;

// Each camera: distinct hue so E2E can tell shots apart by pixel color.
// segments use [start,end) on the shared performance timeline.
const CAMERAS = [
  {
    id: 'cam-wide', label: '全景机位', hue: 0,
    fps: 30, segments: [[0, 16], [16, 32], [32, 40]],
  },
  {
    id: 'cam-left', label: '左侧机位', hue: 120,
    fps: 25, segments: [[4, 20], [20, 40]],
  },
  {
    id: 'cam-drum', label: '鼓点机位', hue: 240,
    fps: 24, segments: [[8, 24], [24, 36]],
  },
  {
    // intentionally sparse: joins late, has a gap 24-30, ends early
    id: 'cam-closeup', label: '特写机位', hue: 300,
    fps: 15, segments: [[10, 24], [30, 36]],
  },
];

function escapeDrawtext(s) {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// Frames are burned with camera id and the segment-relative frame counter.
// The player must NOT trust this counter: it maps frames via manifest timing.
function buildFilter(cam, segIndex, duration) {
  const gop = Math.round(cam.fps * 2); // keyframe every 2s
  const label = escapeDrawtext(`${cam.id} seg${segIndex}`);
  const frameExpr = escapeDrawtext(`frame %{n}  srcpt %{pts\\:hms}`);
  const font = "fontfile='/font.ttf':";
  const filters = [
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${cam.fps}:duration=${duration}`,
    `hue=h=${cam.hue}:s=3`,
    `drawbox=x=8:y=8:w=${WIDTH - 16}:h=44:color=black@0.55:t=fill`,
    `drawtext=${font}text='${label}':x=16:y=14:fontsize=20:fontcolor=white`,
    `drawtext=${font}text='${frameExpr}':x=16:y=34:fontsize=14:fontcolor=yellow`,
  ];
  return { filter: filters.join(','), gop };
}

async function encodeSegment(ff, cam, segIndex, start, end) {
  const duration = end - start;
  const { filter, gop } = buildFilter(cam, segIndex, duration);
  const outName = `${cam.id}-${segIndex}.ivf`;
  ff.exec(
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', filter,
    '-c:v', 'libvpx',
    '-g', String(gop), '-keyint_min', String(gop),
    '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '600k',
    '-f', 'ivf', `/${outName}`,
  );
  const bytes = ff.FS.readFile(`/${outName}`);
  await writeFile(join(MEDIA, outName), bytes);
  return { file: outName, size: bytes.length, gop };
}

// 44.1kHz mono PCM master track: gentle tone plus a per-second tick so the
// clock track is audible and visibly structured in a waveform.
function buildWav(durationSec) {
  const n = Math.floor(durationSec * SAMPLE_RATE);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24); buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const tone = 0.18 * Math.sin(2 * Math.PI * 220 * t);
    const tickPhase = t % 1;
    const tick = tickPhase < 0.03 ? 0.35 * Math.sin(2 * Math.PI * 880 * t) : 0;
    const v = Math.max(-1, Math.min(1, tone + tick));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

async function main() {
  await mkdir(MEDIA, { recursive: true });
  const ff = await createFFmpeg();
  const fontBytes = await readFile('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  ff.FS.writeFile('/font.ttf', fontBytes);
  const manifest = {
    version: 1,
    width: WIDTH,
    height: HEIGHT,
    duration: SHOW_DURATION,
    audio: { src: 'master.wav', sampleRate: SAMPLE_RATE, role: 'master' },
    cameras: [],
  };

  for (const cam of CAMERAS) {
    const segments = [];
    for (let i = 0; i < cam.segments.length; i++) {
      const [start, end] = cam.segments[i];
      const meta = await encodeSegment(ff, cam, i, start, end);
      segments.push({
        index: i,
        src: meta.file,
        start, // first frame's performance time (seconds)
        end,
        fps: cam.fps,
        gopFrames: meta.gop,
      });
      console.log(`encoded ${cam.id} seg${i} ${start}-${end}s @ ${cam.fps}fps (${meta.size}B)`);
    }
    manifest.cameras.push({
      id: cam.id,
      label: cam.label,
      hue: cam.hue,
      fps: cam.fps,
      width: WIDTH,
      height: HEIGHT,
      codec: 'vp8',
      segments,
    });
  }

  await writeFile(join(MEDIA, 'master.wav'), buildWav(SHOW_DURATION));
  await writeFile(join(MEDIA, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`manifest + master.wav written under ${MEDIA}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
