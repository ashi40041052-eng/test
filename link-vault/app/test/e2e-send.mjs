// End-to-end check of the phone path: save -> syncAll -> capture at send time.
// Real core.js + real fxtwitter / image downloads; GitHub is a local in-memory fake (no token, no real repo).
// Run: npm run verify:phone   (needs internet; exit 0 pass, 1 fail, 2 fxtwitter unreachable)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_TOKEN = 'TEST-NOT-REAL';
const URL_TO_SAVE = process.env.LV_E2E_URL || 'https://x.com/pentacoxian_dev/status/2110755123748340030?s=46';

// ---- minimal in-memory IndexedDB (enough for core.js) ----
function fakeIndexedDB() {
  const dbs = new Map();
  const later = (f) => setTimeout(f, 0);
  const req = (fn) => { const r = {}; later(() => { try { r.result = fn(); r.onsuccess && r.onsuccess(); } catch (e) { r.error = e; r.onerror && r.onerror(); } }); return r; };
  return {
    open(name) {
      const r = {};
      later(() => {
        let d = dbs.get(name);
        const fresh = !d;
        if (fresh) {
          d = { stores: new Map(), objectStoreNames: { contains: (n) => d.stores.has(n) }, createObjectStore(n, o) { d.stores.set(n, { key: o && o.keyPath, map: new Map() }); }, close() {} };
          d.transaction = (n) => {
            const st = d.stores.get(n); const t = {};
            const op = (fn) => { const rq = req(fn); later(() => later(() => t.oncomplete && t.oncomplete())); return rq; };
            t.objectStore = () => ({
              put: (v, k) => op(() => { st.map.set(st.key ? v[st.key] : k, structuredClone(v)); }),
              get: (k) => op(() => { const v = st.map.get(k); return v === undefined ? undefined : structuredClone(v); }),
              getAll: () => op(() => [...st.map.values()].map((v) => structuredClone(v))),
            });
            return t;
          };
          dbs.set(name, d);
        }
        r.result = d;
        if (fresh) r.onupgradeneeded && r.onupgradeneeded();
        r.onsuccess && r.onsuccess();
      });
      return r;
    },
  };
}

// ---- fake GitHub Contents API: GET 200/404, PUT create 201, existing without sha 422, wrong sha 409 ----
function startFakeGitHub() {
  const files = new Map(); // path -> {content(base64), sha}
  const log = [];
  const server = http.createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://x');
    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    const send = (s, o) => { rs.writeHead(s, { 'content-type': 'application/json' }); rs.end(JSON.stringify(o)); };
    if (rq.headers.authorization !== 'Bearer ' + TEST_TOKEN) return send(401, { message: 'Bad credentials' });
    if (!m) return send(404, { message: 'Not Found' });
    const p = decodeURIComponent(m[3]);
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      log.push(rq.method + ' ' + p);
      if (rq.method === 'GET') {
        const f = files.get(p);
        return f ? send(200, { type: 'file', path: p, sha: f.sha, content: f.content, encoding: 'base64' }) : send(404, { message: 'Not Found' });
      }
      if (rq.method === 'PUT') {
        const b = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof b.content !== 'string' || !b.message) return send(422, { message: 'Invalid request' });
        const ex = files.get(p);
        if (ex && !b.sha) return send(422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
        if (ex && b.sha !== ex.sha) return send(409, { message: p + ' does not match ' + b.sha });
        const sha = crypto.createHash('sha1').update(b.content).digest('hex');
        files.set(p, { content: b.content, sha });
        return send(ex ? 200 : 201, { content: { path: p, sha } });
      }
      send(405, {});
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, files, log, port: server.address().port })));
}

let failures = 0;
const check = (name, fn) => { try { fn(); console.log('  ok   ' + name); } catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); } };

async function main() {
  const gh = await startFakeGitHub();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opt) => {
    url = String(url);
    if (url.startsWith('https://api.github.com/')) return realFetch('http://127.0.0.1:' + gh.port + url.slice('https://api.github.com'.length), opt);
    return realFetch(url, opt); // fxtwitter + pbs.twimg.com are REAL
  };
  globalThis.self = globalThis;
  globalThis.indexedDB = fakeIndexedDB();
  vm.runInThisContext(fs.readFileSync(path.join(here, '../core.js'), 'utf8'));
  const LV = globalThis.LV;

  await LV.setConfig({ owner: 'me', repo: 'vault', branch: 'main', token: TEST_TOKEN });
  const [item] = await LV.saveInput('これ面白い ' + URL_TO_SAVE, 'manual');
  console.log('saved', item.id, item.url);
  const res = await LV.syncAll();
  await LV.capturesIdle();
  console.log('sync', JSON.stringify(res), '| fake GitHub files:', gh.files.size);

  const read = (p) => { const f = gh.files.get(p); return f && Buffer.from(f.content, 'base64'); };
  const json = (p) => JSON.parse(read(p).toString('utf8'));
  const dir = LV.archiveDir(item.id);

  check('sync pushed 1 item, no error', () => { assert.equal(res.pushed, 1); assert.equal(res.failed, 0); assert.equal(res.error, null); });
  const local = (await LV.getAllItems()).find((i) => i.id === item.id);
  check('local item has synced_at', () => assert.ok(local.synced_at));
  const linkPath = `links/${item.id.slice(0, 4)}/${item.id.slice(4, 6)}/${item.id}.json`;
  check('link file at links/YYYY/MM/<id>.json', () => { const j = json(linkPath); assert.equal(j.id, item.id); assert.equal(j.url, URL_TO_SAVE); assert.equal(j.client, 'link-vault-pwa'); assert.equal(j.note, 'これ面白い'); assert.ok(read(linkPath).toString().endsWith('\n')); });

  const snapPath = dir + 'snapshot.json';
  if (!gh.files.has(snapPath)) {
    console.log('  snapshot missing: fxtwitter unreachable or tweet gone?');
    gh.server.close(); process.exit(2);
  }
  const snap = json(snapPath);
  check('snapshot path archive/<y>/<id>/snapshot.json', () => assert.match(snapPath, /^archive\/\d{4}\/[\d-]+-[0-9a-f]{8}\/snapshot\.json$/));
  check('snapshot schema 1, captured_by phone, source x', () => { assert.equal(snap.schema, 1); assert.equal(snap.captured_by, 'phone'); assert.equal(snap.source_type, 'x'); assert.equal(snap.id, item.id); assert.equal(snap.url, URL_TO_SAVE); });
  check('snapshot has text, author handle, canonical url, captured_at', () => { assert.ok(snap.text.length > 0); assert.match(snap.author.handle, /^@/); assert.match(snap.canonical_url, /^https:\/\/x\.com\/[^/]+\/status\/\d+$/); assert.match(snap.captured_at, /^\d{4}-\d\d-\d\dT[\d:]+Z$/); });
  check('snapshot.raw.fxtwitter present', () => assert.ok(snap.raw && snap.raw.fxtwitter && snap.raw.fxtwitter.id));
  const photos = snap.media.filter((m) => m.type === 'photo');
  console.log('  media: ' + snap.media.length + ' total, ' + photos.length + ' photo, ' + snap.media.filter((m) => m.local).length + ' stored on phone');
  for (const m of snap.media.filter((m) => m.local)) {
    check('media ' + m.local + ' written, sha256/bytes match snapshot', () => {
      const b = read(dir + m.local);
      assert.ok(b && b.length > 0); assert.equal(b.length, m.bytes); assert.equal(crypto.createHash('sha256').update(b).digest('hex'), m.sha256);
      assert.match(m.local, /^media\/\d\d\.[a-z0-9]{2,4}$/);
    });
  }
  if (!process.env.LV_E2E_URL) check('default tweet has a photo and it was stored on the phone', () => { assert.ok(photos.length >= 1); assert.ok(photos.every((m) => m.local), 'photo not stored'); });
  const threadPath = dir + 'related/thread.json';
  check('related/thread.json written with thread[] array', () => { const t = json(threadPath); assert.ok(Array.isArray(t.thread)); assert.ok(t.thread.length >= 1); });

  // ---- idempotence: re-sync and re-capture must not rewrite or add anything ----
  const before = new Map([...gh.files].map(([k, v]) => [k, v.sha]));
  const putsBefore = gh.log.filter((l) => l.startsWith('PUT')).length;
  const cfg = await LV.getConfig();
  await LV.syncAll(); await LV.capturesIdle();
  await LV.captureSnapshot(cfg, item); await LV.captureThread(cfg, item);
  check('re-run changes nothing and PUTs nothing', () => { assert.equal(gh.log.filter((l) => l.startsWith('PUT')).length, putsBefore); for (const [k, v] of gh.files) assert.equal(before.get(k), v.sha); assert.equal(gh.files.size, before.size); });

  // ---- the processor must read what the phone wrote ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-e2e-'));
  for (const [p, f] of gh.files) { const dst = path.join(tmp, p); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, Buffer.from(f.content, 'base64')); }
  const proc = path.join(here, '../../processor/lib/');
  const A = await import(pathToFileURL(proc + 'archive.mjs'));
  const R = await import(pathToFileURL(proc + 'related.mjs'));
  const record = JSON.parse(fs.readFileSync(path.join(tmp, linkPath), 'utf8'));
  const psnap = await A.readSnapshot(tmp, item.id);
  check('processor readSnapshot reads the phone snapshot', () => { assert.equal(psnap.id, item.id); assert.equal(psnap.captured_by, 'phone'); });
  const arch = await A.loadArchives(tmp, [record]);
  check('processor withLocalMedia finds every phone-stored file', () => { const s = arch.get(item.id); assert.ok(s); for (const m of s.media) assert.equal(m.local, snap.media.find((x) => x.n === m.n).local, 'media #' + m.n + ' local mismatch'); });
  check('processor contentFromSnapshot yields x text', () => { const c = A.contentFromSnapshot(arch.get(item.id)); assert.equal(c.ok, true); assert.equal(c.source_type, 'x'); assert.ok(c.text.length > 0); assert.equal(c.author, snap.author.handle); });
  const snapBefore = fs.readFileSync(path.join(tmp, snapPath), 'utf8');
  await A.archiveLink({ dir: tmp, record, fetchImpl: async () => { throw new Error('processor must not refetch'); } }).catch(() => {});
  check('snapshot.json untouched by processor archiveLink', () => assert.equal(fs.readFileSync(path.join(tmp, snapPath), 'utf8'), snapBefore));
  const rp = R.relatedPaths(tmp, item.id);
  check('relatedPaths.thread points at the phone file', () => assert.equal(path.relative(tmp, rp.thread), threadPath));
  check('processor graphFromThread parses the phone thread.json', () => { const g = R.graphFromThread(JSON.parse(fs.readFileSync(rp.thread, 'utf8')), snap.raw.fxtwitter.id); assert.ok(g); assert.ok(JSON.stringify(g).includes(snap.raw.fxtwitter.id)); });

  gh.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nFAILED: ${failures} check(s)` : '\nPASS: phone save -> sync -> capture is consistent with the processor');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
