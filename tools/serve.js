// 本機預覽用的靜態檔案伺服器（網頁版本身不需要伺服器）：node tools/serve.js [port]
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 5317);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

http
  .createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.resolve(ROOT, urlPath === '/' ? 'index.html' : urlPath.slice(1));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error();
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`FF14副本復盤記錄（本機預覽）：http://localhost:${PORT}`));
