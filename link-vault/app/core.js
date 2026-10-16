/*
 * Link Vault core: IndexedDB storage + GitHub sync.
 * Classic script shared by the page (<script>) and the service worker (importScripts),
 * exposed as self.LV.
 *
 * Durability rules:
 *  - An item is written locally (IndexedDB, strict durability + localStorage mirror)
 *    BEFORE any network activity. Saving never depends on the network.
 *  - Local items are never deleted. Sync only sets synced_at.
 *  - Remote writes are create-only files with a unique id, so retries are idempotent
 *    and can never overwrite another link.
 *  - Deleting is a soft delete: a "delete" event is recorded (and synced) and the link is
 *    hidden everywhere. A later "restore" event brings it back. Nothing is erased.
 */
(function (g) {
  'use strict';

  const DB_NAME = 'link-vault';
  const DB_VERSION = 2;
  const LS_BACKUP_KEY = 'lv-backup-v1';
  // Japanese punctuation and full-width brackets end a URL (text often follows with no space).
  const URL_RE = /https?:\/\/[^\s<>"'「」『』（）【】。、！？　]+/g;

  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  // Runs one request and resolves only after the transaction has committed.
  function run(store, mode, op) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const t = mode === 'readwrite'
        ? db.transaction(store, mode, { durability: 'strict' })
        : db.transaction(store, mode);
      const r = op(t.objectStore(store));
      let value;
      if (r) r.onsuccess = () => { value = r.result; };
      t.oncomplete = () => resolve(value);
      t.onerror = () => reject(t.error || (r && r.error));
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    }));
  }

  const putItem = (item) => run('items', 'readwrite', (s) => s.put(item));
  const getItem = (id) => run('items', 'readonly', (s) => s.get(id));
  const getAllItems = () => run('items', 'readonly', (s) => s.getAll()).then((a) => a || []);
  const putEvent = (ev) => run('events', 'readwrite', (s) => s.put(ev));
  const getAllEvents = () => run('events', 'readonly', (s) => s.getAll()).then((a) => a || []);
  const kvGet = (key) => run('kv', 'readonly', (s) => s.get(key));
  const kvSet = (key, value) => run('kv', 'readwrite', (s) => s.put(value, key));

  // ---------- localStorage mirror (second local copy; page only) ----------

  function hasLS() {
    try { return typeof localStorage !== 'undefined'; } catch (e) { return false; }
  }
  function readBackup() {
    if (!hasLS()) return [];
    try { return JSON.parse(localStorage.getItem(LS_BACKUP_KEY) || '[]'); } catch (e) { return []; }
  }
  function writeBackup(item) {
    if (!hasLS()) return false;
    try {
      const list = readBackup();
      if (!list.some((x) => x.id === item.id)) {
        list.push({ id: item.id, url: item.url, text: item.text, note: item.note, created_at: item.created_at, via: item.via });
        localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(list));
      }
      return true;
    } catch (e) {
      return false; // quota etc. IndexedDB is the primary store.
    }
  }

  // Restores anything that exists only in the localStorage mirror (e.g. IDB was wiped).
  async function reconcileBackup() {
    const backup = readBackup();
    if (!backup.length) return 0;
    let restored = 0;
    for (const b of backup) {
      const existing = await getItem(b.id);
      if (!existing) {
        await putItem(Object.assign({ synced_at: null, sync_error: null }, b));
        restored++;
      }
    }
    return restored;
  }

  // ---------- creating items ----------

  function pad(n, w) { return String(n).padStart(w || 2, '0'); }

  function newId(date) {
    const d = date || new Date();
    const stamp = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + '-' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
    const rnd = new Uint8Array(4);
    (g.crypto || crypto).getRandomValues(rnd);
    return stamp + '-' + Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Local time ISO string with offset, e.g. 2026-10-14T21:03:05+09:00
  function isoLocal(d) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      sign + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
  }

  // Strips trailing punctuation, and a trailing ")" that has no matching "(" in the URL,
  // so "(see https://a.com)" works and "https://en.wikipedia.org/wiki/Mercury_(planet)" stays whole.
  function cleanUrl(u) {
    for (;;) {
      const t = u.replace(/[.,、。!！?？:;]+$/, '');
      const open = (t.match(/\(/g) || []).length, close = (t.match(/\)/g) || []).length;
      const next = t.endsWith(')') && close > open ? t.slice(0, -1) : t;
      if (next === u) return u;
      u = next;
    }
  }

  function extractUrls(text) {
    const found = (text || '').match(URL_RE) || [];
    return Array.from(new Set(found.map(cleanUrl)));
  }

  // Splits raw input into items: one per URL. Text without any URL is kept as a memo item.
  function buildItems(rawText, via, sharedUrl) {
    const text = (rawText || '').trim();
    const urls = extractUrls([sharedUrl || '', text].join(' '));
    let note = text;
    // Longest first, so a URL that is a prefix of another doesn't leave "/x" behind.
    urls.slice().sort((a, b) => b.length - a.length).forEach((u) => { note = note.split(u).join(' '); });
    note = note.replace(/\s+/g, ' ').trim();
    const now = new Date();
    const base = { text: text || null, note: note || null, created_at: isoLocal(now), via: via || 'manual', synced_at: null, sync_error: null };
    if (!urls.length) {
      if (!text) return [];
      return [Object.assign({ id: newId(now), url: null }, base)];
    }
    return urls.map((u) => Object.assign({ id: newId(now), url: u }, base));
  }

  // Saves locally. Resolves with the saved items once at least one local store has them.
  async function saveInput(rawText, via, sharedUrl) {
    const items = buildItems(rawText, via, sharedUrl);
    const saved = [];
    for (const item of items) {
      const lsOk = writeBackup(item);
      let idbOk = false;
      try { await putItem(item); idbOk = true; } catch (e) { console.error('IndexedDB save failed', e); }
      if (!idbOk && !lsOk) throw new Error('端末への保存に失敗しました。テキストをコピーして控えてください。');
      saved.push(item);
    }
    return saved;
  }

  // ---------- delete / restore (soft) ----------

  async function setDeleted(targetId, deleted) {
    const now = new Date();
    const ev = { id: newId(now), target: targetId, action: deleted ? 'delete' : 'restore', at: now.toISOString(), synced_at: null, sync_error: null };
    await putEvent(ev);
    return ev;
  }

  // Map<targetId, latest local event>
  async function latestEvents() {
    const m = new Map();
    const evs = (await getAllEvents()).sort((a, b) => (a.at + a.id).localeCompare(b.at + b.id));
    for (const e of evs) m.set(e.target, e);
    return m;
  }

  // ---------- config ----------

  async function getConfig() {
    const c = (await kvGet('config')) || {};
    return { owner: c.owner || '', repo: c.repo || '', branch: c.branch || 'main', token: c.token || '' };
  }
  const setConfig = (c) => kvSet('config', c);
  const isConfigured = (c) => !!(c.owner && c.repo && c.token);

  // ---------- GitHub sync ----------

  function b64utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function remotePath(item) {
    // id starts with YYYYMMDD (UTC)
    return 'links/' + item.id.slice(0, 4) + '/' + item.id.slice(4, 6) + '/' + item.id + '.json';
  }

  function apiUrl(cfg, path) {
    const p = path.split('/').map(encodeURIComponent).join('/');
    return 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/contents/' + p;
  }

  function headers(cfg, raw) {
    return {
      Authorization: 'Bearer ' + cfg.token,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async function remoteExists(cfg, path) {
    const r = await fetch(apiUrl(cfg, path) + '?ref=' + encodeURIComponent(cfg.branch), { headers: headers(cfg), cache: 'no-store' });
    return r.ok;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function eventPath(ev) {
    return 'events/' + ev.id.slice(0, 4) + '/' + ev.id.slice(4, 6) + '/' + ev.id + '.json';
  }

  function pushItem(cfg, item) {
    const record = { id: item.id, url: item.url, note: item.note, text: item.text, created_at: item.created_at, via: item.via, client: 'link-vault-pwa' };
    return pushFile(cfg, remotePath(item), record, 'add link ' + item.id);
  }

  function pushEvent(cfg, ev) {
    const record = { id: ev.id, target: ev.target, action: ev.action, at: ev.at, client: 'link-vault-pwa' };
    return pushFile(cfg, eventPath(ev), record, ev.action + ' link ' + ev.target);
  }

  // Creates one file. Returns 'ok' | 'retry' | 'fatal:<message>'
  async function pushFile(cfg, path, record, message) {
    const body = JSON.stringify({
      message: message,
      content: b64utf8(JSON.stringify(record, null, 2) + '\n'),
      branch: cfg.branch,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      let r;
      try {
        r = await fetch(apiUrl(cfg, path), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, headers(cfg)), body: body });
      } catch (e) {
        return 'retry'; // offline / network error
      }
      if (r.status === 200 || r.status === 201) return 'ok';
      if (r.status === 422) {
        // File already exists = an earlier attempt succeeded but the response was lost.
        try { if (await remoteExists(cfg, path)) return 'ok'; } catch (e) { return 'retry'; }
        return 'fatal:GitHubが保存を拒否しました (422)';
      }
      if (r.status === 409 || r.status >= 500 || r.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
      if (r.status === 401) return 'fatal:トークンが無効です (401)';
      // Secondary rate limit: GitHub answers 403 with retry-after / remaining=0. Not a permission problem.
      if (r.status === 403 && (r.headers.get('retry-after') || r.headers.get('x-ratelimit-remaining') === '0')) return 'retry';
      if (r.status === 403) return 'fatal:権限がありません (403)。トークンの Contents 書き込み権限を確認してください';
      if (r.status === 404) return 'fatal:リポジトリが見つかりません (404)。設定を確認してください';
      return 'fatal:GitHub エラー ' + r.status;
    }
    return 'retry';
  }


  // ---------- snapshot capture (phone-side archive, DESIGN-v2 section 1.3 route A) ----------
  // Best-effort and strictly separate from saving: it runs only AFTER a link's PUT succeeded,
  // is never awaited by syncAll, never throws to the caller, and writes create-only files
  // (PUT without sha; 422 = already there = fine). Anything it cannot finish is picked up by
  // the processor's archive-only run. Only X posts are captured here (fxtwitter is CORS-open).

  // Same expression as processor/lib/fetch-content.mjs X_STATUS: keep the two in sync.
  const X_STATUS = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:([A-Za-z0-9_]{1,15})|i(?:\/web)?)\/status(?:es)?\/(\d+)/i;
  const MEDIA_MAX_ONE = 3 * 1024 * 1024, MEDIA_MAX_COUNT = 4, MEDIA_MAX_TOTAL = 10 * 1024 * 1024;

  function parseXStatus(url) {
    const m = (url || '').match(X_STATUS);
    return m ? { user: m[1] || 'i', statusId: m[2] } : null;
  }

  function archiveDir(id) { return 'archive/' + id.slice(0, 4) + '/' + id + '/'; }

  function isoAny(v) { const t = v ? new Date(v).getTime() : NaN; return isFinite(t) ? new Date(t).toISOString().replace(/\.\d+Z$/, 'Z') : null; }
  function tsIso(sec) { return typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null; }

  function fxAuthor(a) {
    if (!a) return null;
    const h = a.screen_name ? '@' + a.screen_name : null;
    return { name: a.name || null, handle: h, url: a.screen_name ? 'https://x.com/' + a.screen_name : null };
  }

  // Same mapping as processor/lib/archive.mjs mediaFromFx (keep in sync): video/gif -> smallest mp4 variant.
  function fxMedia(m) {
    const all = (m && m.all) || [];
    return all.map((x, i) => {
      let url = x.url;
      if (x.type === 'video' || x.type === 'gif') {
        const mp4 = (x.variants || x.formats || []).filter((v) => v && v.url && (!v.content_type || /mp4/.test(v.content_type)) && /\.mp4/.test(v.url));
        mp4.sort((a, b) => (a.bitrate == null ? Infinity : a.bitrate) - (b.bitrate == null ? Infinity : b.bitrate));
        if (mp4[0]) url = mp4[0].url;
      }
      return { n: i + 1, type: x.type === 'gif' ? 'gif' : x.type === 'video' ? 'video' : 'photo', url: url,
        width: x.width == null ? null : x.width, height: x.height == null ? null : x.height, alt: x.altText || x.alt_text || null,
        local: null, bytes: null, sha256: null };
    }).filter((x) => x.url);
  }

  function fxArticleText(a) {
    const blocks = a && a.content && a.content.blocks;
    const body = Array.isArray(blocks) ? blocks.map((b) => b && b.text).filter(Boolean).join('\n\n') : '';
    return body || (a && a.preview_text) || '';
  }

  // fxtwitter tweet -> snapshot (schema 1, DESIGN-v2 1.2). Pure.
  function snapshotFromFx(tweet, rec, capturedAt) {
    const au = fxAuthor(tweet.author);
    const text = tweet.text || (tweet.raw_text && tweet.raw_text.text) || '';
    const q = tweet.quote;
    const art = tweet.article;
    const head = text.replace(/\s+/g, ' ').trim().slice(0, 60);
    return {
      schema: 1, id: rec.id, url: rec.url,
      canonical_url: au && au.handle ? 'https://x.com/' + au.handle.slice(1) + '/status/' + tweet.id : (tweet.url || rec.url),
      captured_at: capturedAt, captured_by: 'phone', source_type: 'x',
      title: (au && au.name ? au.name + ': ' : '') + head,
      author: au,
      published_at: tsIso(tweet.created_timestamp) || isoAny(tweet.created_at),
      lang: tweet.lang || null,
      text: text, html_text: null,
      quote: q ? { url: q.url || null, author: fxAuthor(q.author), published_at: tsIso(q.created_timestamp),
        text: q.text || (q.raw_text && q.raw_text.text) || '', media: fxMedia(q.media) } : null,
      article: art ? { title: art.title || '', text: fxArticleText(art) } : null,
      replying_to: tweet.replying_to || null,
      community_note: tweet.community_note || null,
      media: fxMedia(tweet.media),
      web: null,
      stats: { likes: tweet.likes == null ? null : tweet.likes, reposts: tweet.retweets == null ? null : tweet.retweets, views: tweet.views == null ? null : tweet.views },
      raw: { fxtwitter: tweet },
    };
  }

  function mediaExt(url, contentType) {
    let ext = '';
    try { ext = (new URL(url).pathname.match(/\.([A-Za-z0-9]{2,4})$/) || [])[1] || ''; } catch (e) { /* fall through */ }
    if (!ext) ext = ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[contentType] || 'jpg');
    return ext.toLowerCase();
  }

  function b64bytes(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function sha256hex(buf) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Create-only PUT of base64 content. Returns 'ok' | 'retry' | 'fatal:<status>'.
  async function putNew(cfg, path, b64, message) {
    const body = JSON.stringify({ message: message, content: b64, branch: cfg.branch });
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try { r = await fetch(apiUrl(cfg, path), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, headers(cfg)), body: body }); }
      catch (e) { return 'retry'; }
      if (r.status === 200 || r.status === 201 || r.status === 422) return 'ok'; // 422 = already exists
      if (r.status === 409 || r.status >= 500 || r.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
      return 'fatal:' + r.status;
    }
    return 'retry';
  }

  // Downloads photos (<=3MB each, <=4, <=10MB total). Returns [{m, buf, ext, sha, bytes}].
  async function downloadPhotos(snap) {
    const got = [];
    let total = 0;
    for (const m of snap.media) {
      if (m.type !== 'photo' || !m.url || got.length >= MEDIA_MAX_COUNT) continue;
      try {
        const r = await fetch(m.url);
        if (!r.ok) continue;
        if (Number(r.headers.get('content-length') || 0) > MEDIA_MAX_ONE) continue;
        const buf = await r.arrayBuffer();
        if (buf.byteLength > MEDIA_MAX_ONE || total + buf.byteLength > MEDIA_MAX_TOTAL) continue;
        total += buf.byteLength;
        got.push({ m: m, buf: buf, ext: mediaExt(m.url, r.headers.get('content-type')), sha: await sha256hex(buf), bytes: buf.byteLength });
      } catch (e) { /* skip this image */ }
    }
    return got;
  }

  // Never rejects. Resolves 'skipped' | 'done' | 'failed'.
  async function captureSnapshot(cfg, item) {
    try {
      const x = parseXStatus(item && item.url);
      if (!x || !isConfigured(cfg) || (g.navigator && g.navigator.onLine === false)) return 'skipped';
      const dir = archiveDir(item.id);
      const snapPath = dir + 'snapshot.json';
      if (await remoteExists(cfg, snapPath)) return 'skipped'; // processor (or an earlier run) did it
      const r = await fetch('https://api.fxtwitter.com/' + x.user + '/status/' + x.statusId, { headers: { Accept: 'application/json' } });
      if (!r.ok) return 'failed'; // 404 etc.: the processor records attempts/gone
      const tweet = (await r.json()).tweet;
      if (!tweet) return 'failed';
      const snap = snapshotFromFx(tweet, { id: item.id, url: item.url }, new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
      // Photos first so snapshot.media[].local is truthful; each is its own create-only file.
      for (const p of await downloadPhotos(snap)) {
        const name = String(p.m.n).padStart(2, '0') + '.' + p.ext;
        if (await putNew(cfg, dir + 'media/' + name, b64bytes(p.buf), 'archive media ' + item.id) === 'ok') {
          p.m.local = 'media/' + name; p.m.bytes = p.bytes; p.m.sha256 = p.sha;
        }
      }
      return (await pushFile(cfg, snapPath, snap, 'archive snapshot ' + item.id)) === 'ok' ? 'done' : 'failed';
    } catch (e) {
      return 'failed';
    }
  }

  // Best-effort v3 context capture: /2/thread JSON as related/thread.json, create-only. Never rejects; never blocks the save.
  async function captureThread(cfg, item) {
    try {
      const x = parseXStatus(item && item.url);
      if (!x || !isConfigured(cfg) || (g.navigator && g.navigator.onLine === false)) return 'skipped';
      const path = archiveDir(item.id) + 'related/thread.json';
      if (await remoteExists(cfg, path)) return 'skipped'; // processor (or an earlier run) did it
      const r = await fetch('https://api.fxtwitter.com/2/thread/' + x.statusId, { headers: { Accept: 'application/json' } });
      if (!r.ok) return 'failed';
      const thread = await r.json();
      if (!thread || !Array.isArray(thread.thread)) return 'failed';
      return (await pushFile(cfg, path, thread, 'archive thread ' + item.id)) === 'ok' ? 'done' : 'failed';
    } catch (e) {
      return 'failed';
    }
  }

  // Captures started by syncAll; the service worker waits on these so the browser keeps it alive.
  const captures = new Set();
  function startCapture(cfg, item) {
    const p = new Promise((res) => queueMicrotask(() => captureSnapshot(cfg, item).then(() => captureThread(cfg, item)).then(res, () => res('failed'))));
    captures.add(p);
    p.then(() => captures.delete(p));
  }
  const capturesIdle = () => Promise.all(Array.from(captures));

  let syncing = null;
  function syncAll() {
    if (syncing) return syncing;
    const work = async () => {
      const cfg = await getConfig();
      const pending = (await getAllItems()).filter((i) => !i.synced_at).sort((a, b) => a.id.localeCompare(b.id));
      const events = (await getAllEvents()).filter((e) => !e.synced_at).sort((a, b) => a.id.localeCompare(b.id));
      const res = { pushed: 0, pending: pending.length + events.length, failed: 0, error: null, configured: isConfigured(cfg) };
      if (!res.pending || !res.configured) return res;
      // Links first, then delete/restore events (oldest first, so the latest action wins).
      const queue = pending.map((x) => ({ x, push: pushItem, save: putItem }))
        .concat(events.map((x) => ({ x, push: pushEvent, save: putEvent })));
      const toCapture = []; // started after the loop: captures never compete with the saves above for the branch
      for (const { x, push, save } of queue) {
        const out = await push(cfg, x);
        if (out === 'ok') {
          x.synced_at = isoLocal(new Date());
          x.sync_error = null;
          await save(x);
          res.pushed++;
          if (push === pushItem && x.url) toCapture.push(x);
        } else {
          res.failed++;
          if (out.startsWith('fatal:')) {
            res.error = out.slice(6);
            x.sync_error = res.error;
            await save(x);
          }
          break; // keep order; try again later
        }
      }
      res.pending -= res.pushed;
      toCapture.forEach((x) => startCapture(cfg, x)); // best-effort, not awaited
      return res;
    };
    const locked = (g.navigator && g.navigator.locks)
      ? g.navigator.locks.request('lv-sync', work)
      : work();
    syncing = locked.finally(() => { syncing = null; });
    return syncing;
  }

  // ---------- dashboard data ----------

  async function fetchIndex() {
    const cfg = await getConfig();
    if (!isConfigured(cfg)) throw new Error('未設定');
    const r = await fetch(apiUrl(cfg, 'index.json') + '?ref=' + encodeURIComponent(cfg.branch), { headers: headers(cfg, true), cache: 'no-store' });
    if (r.status === 404) return null; // processor has not run yet
    if (!r.ok) throw new Error('index.json の取得に失敗 (' + r.status + ')');
    const index = await r.json();
    await kvSet('index', index);
    return index;
  }
  const cachedIndex = () => kvGet('index');

  async function testConnection(cfg) {
    const r = await fetch('https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo), { headers: headers(cfg), cache: 'no-store' });
    if (!r.ok) throw new Error('リポジトリに接続できません (' + r.status + ')');
    const j = await r.json();
    if (j.permissions && !j.permissions.push) throw new Error('書き込み権限がありません');
    return j;
  }

  g.LV = {
    saveInput, buildItems, extractUrls, getAllItems, putItem, reconcileBackup,
    setDeleted, latestEvents, getAllEvents,
    getConfig, setConfig, isConfigured, syncAll, fetchIndex, cachedIndex, testConnection,
    remotePath, isoLocal,
    captureSnapshot, captureThread, capturesIdle, snapshotFromFx, parseXStatus, archiveDir,
    // dashboard helpers
    kvGet, kvSet, apiUrl, headers,
  };
})(self);
