#!/usr/bin/env node
// Local PC dashboard: serves app/ at / and the cloned data repo (read-only) at /data/ on 127.0.0.1.
// No token needed — the dashboard detects localhost and reads files directly.
//   node dashboard-server.mjs            → http://127.0.0.1:4848/dashboard.html
// Env: LV_DATA_DIR (from .env), LV_DASH_PORT (default 4848)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(HERE, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const APP_DIR = path.resolve(HERE, '../app');
const DATA_DIR = path.resolve(process.env.LV_DATA_DIR || '');
const PORT = Number(process.env.LV_DASH_PORT || 4848);
if (!process.env.LV_DATA_DIR || !fs.existsSync(DATA_DIR)) { console.error('LV_DATA_DIR が見つかりません: ' + DATA_DIR); process.exit(1); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json' };

function resolveUnder(root, rel) {
  const p = path.resolve(root, '.' + path.sep + rel);
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (rel === '/') { res.writeHead(302, { Location: '/dashboard.html' }).end(); return; }
  const isData = rel.startsWith('/data/');
  const file = isData ? resolveUnder(DATA_DIR, rel.slice(6)) : resolveUnder(APP_DIR, rel.slice(1));
  if (!file || file.includes(path.sep + '.git')) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Link Vault dashboard: http://127.0.0.1:${PORT}/dashboard.html`));
