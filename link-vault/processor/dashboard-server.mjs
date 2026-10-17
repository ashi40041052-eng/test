#!/usr/bin/env node
// Local PC dashboard: serves app/ at / and the cloned data repo (read-only) at /data/ on 127.0.0.1.
// No token needed — the dashboard detects localhost and reads files directly.
//   node dashboard-server.mjs            → http://127.0.0.1:4848/dashboard.html
// Env: LV_DATA_DIR (from .env), LV_DASH_PORT (default 4848)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeMark, readMarks } from './lib/marks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(HERE, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const APP_DIR = path.resolve(HERE, '../app');
const DATA_DIR = path.resolve(process.env.LV_DATA_DIR || '');
const LOG_DIR = path.resolve(process.env.LV_LOG_DIR || path.join(HERE, 'logs'));
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

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj)); };
// loopback peer + loopback Host + JSON content type (the last forces a CORS preflight, so other web pages cannot post here)
const isLocalReq = (req) => /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '') && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '');

// Marks are only written to marks/<id>.json here. Committing/pushing is left to the 20-min archive run
// (process.mjs commits everything except links/ and events/), so this server never races its git lock.
async function handleMark(req, res) {
  if (!isLocalReq(req) || !String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 403, { error: 'forbidden' });
  let body = '';
  for await (const c of req) { body += c; if (body.length > 4096) return json(res, 413, { error: 'too large' }); }
  let b;
  try { b = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
  if (!b || typeof b.id !== 'string' || (b.status !== 'done' && b.status !== 'todo')) return json(res, 400, { error: 'bad request' });
  try { json(res, 200, { id: b.id, ...(await writeMark(DATA_DIR, b.id, b.status, { by: 'human' })) }); }
  catch (e) { json(res, /unknown|bad id/.test(e.message) ? 400 : 500, { error: e.message }); }
}

http.createServer((req, res) => {
  if (req.url === '/api/mark' && req.method === 'POST') { handleMark(req, res).catch(() => json(res, 500, { error: 'failed' })); return; }
  if (req.url === '/api/marks' && req.method === 'GET') { if (!isLocalReq(req)) return json(res, 403, { error: 'forbidden' }); readMarks(DATA_DIR).then((m) => json(res, 200, m), () => json(res, 500, {})); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (rel === '/') { res.writeHead(302, { Location: '/dashboard.html' }).end(); return; }
  const isData = rel.startsWith('/data/');
  // the only log served: the x-replies status (no secrets; the dashboard header shows it)
  const file = rel === '/logs/x-replies-status.json' ? path.join(LOG_DIR, 'x-replies-status.json')
    : isData ? resolveUnder(DATA_DIR, rel.slice(6)) : resolveUnder(APP_DIR, rel.slice(1));
  if (!file || file.includes(path.sep + '.git')) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Link Vault dashboard: http://127.0.0.1:${PORT}/dashboard.html`));
