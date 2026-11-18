// Minimal static file server with HTTP Range support so the browser player can
// fetch media exactly like it would from a CDN. Run: node tools/serve.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT ?? 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ivf': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(ROOT, rel);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); return res.end('forbidden');
    }
    const s = await stat(filePath);
    const type = TYPES[extname(filePath)] ?? 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : s.size - 1;
      if (start >= s.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${s.size}` });
        return res.end();
      }
      end = Math.min(end, s.size - 1);
      const data = await readFile(filePath, { encoding: null });
      res.writeHead(206, {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${s.size}`,
        'Content-Length': end - start + 1,
      });
      return res.end(data.subarray(start, end + 1));
    }
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': s.size, 'Accept-Ranges': 'bytes' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, () => console.log(`stage player: http://localhost:${PORT}/`));
