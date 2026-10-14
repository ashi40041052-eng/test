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
      for (const { x, push, save } of queue) {
        const out = await push(cfg, x);
        if (out === 'ok') {
          x.synced_at = isoLocal(new Date());
          x.sync_error = null;
          await save(x);
          res.pushed++;
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
  };
})(self);
