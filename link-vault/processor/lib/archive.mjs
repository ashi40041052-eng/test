/*
 * Archive: an immutable snapshot of each saved link (text + media), kept in the data repo.
 *
 *   archive/<YYYY>/<id>/snapshot.json   created once, NEVER overwritten (create-only: flag 'wx')
 *   archive/<YYYY>/<id>/media/NN.ext    media files; NN = snapshot.media[].n. Files may be added later;
 *                                       the file's existence on disk is the truth (not media[].local)
 *   archive/<YYYY>/<id>/attempts.json   failure bookkeeping, only while snapshot.json does not exist
 *
 * snapshot.json schema 1 (see DESIGN-v2.md 1.2):
 *   { schema:1, id, url, canonical_url, captured_at, captured_by:'phone'|'processor',
 *     source_type:'x'|'web'|'file', title, author:{name,handle,url}|null, published_at, lang,
 *     text, html_text:null, quote:{url,author,published_at,text,media}|null, article:{title,text}|null,
 *     replying_to, community_note,
 *     media:[{n,type:'photo'|'video'|'gif',url,width,height,alt,local,bytes,sha256,skip_reason?}],
 *     web:{final_url,description,text}|null, stats:{likes,reposts,views}|null, raw:{fxtwitter} }
 *   media[].local is set only if the file was downloaded when the snapshot was written;
 *   skip_reason ('too_large' | 'over_limit') marks media that will never be fetched.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { X_STATUS, fxBase, fetchGeneric, fetchWithTimeout, fetchContent, MAX_WEB_TEXT } from './fetch-content.mjs';
import { readJson } from './util.mjs';

const MB = 1024 * 1024;
export const DEFAULT_LIMITS = {
  maxImages: 8,
  maxImageBytes: 5 * MB,
  maxVideos: 1,
  maxVideoBytes: 20 * MB,
  hardCapBytes: 10 * MB,
  runBudgetBytes: 150 * MB,
  stopVideosAboveBytes: 2 * 1024 * MB, // total archive size at which videos stop
};
const WEEK_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export class NotFoundError extends Error {}

// ---------- paths ----------

export function archivePaths(dir, id) {
  const root = path.join(dir, 'archive', id.slice(0, 4), id);
  return { root, snapshot: path.join(root, 'snapshot.json'), attempts: path.join(root, 'attempts.json'), media: path.join(root, 'media') };
}
export const archiveRelDir = (id) => `archive/${id.slice(0, 4)}/${id}/`;

const pad = (n) => String(n).padStart(2, '0');
export function plannedLocal(m) {
  let ext = '';
  try { ext = path.extname(new URL(m.url).pathname).slice(1).toLowerCase(); } catch {}
  if (!/^[a-z0-9]{2,4}$/.test(ext)) ext = m.type === 'photo' ? 'jpg' : 'mp4';
  return `media/${pad(m.n)}.${ext}`;
}

// ---------- snapshot builders ----------

const iso = (v) => {
  if (v == null) return null;
  const t = new Date(typeof v === 'number' ? v * 1000 : v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d+Z$/, 'Z') : null;
};
const authorOf = (a) => (a?.screen_name ? { name: a.name || null, handle: `@${a.screen_name}`, url: `https://x.com/${a.screen_name}` } : null);

function mediaFromFx(all = []) {
  return all.map((x, i) => {
    let url = x.url;
    if (x.type === 'video' || x.type === 'gif') {
      // smallest mp4 variant (bitrate ascending) keeps the repository small
      const mp4 = (x.variants || x.formats || []).filter((v) => v?.url && (!v.content_type || /mp4/.test(v.content_type)) && /\.mp4/.test(v.url));
      mp4.sort((a, b) => (a.bitrate ?? Infinity) - (b.bitrate ?? Infinity));
      if (mp4[0]) url = mp4[0].url;
    }
    return {
      n: i + 1,
      type: x.type === 'gif' ? 'gif' : x.type === 'video' ? 'video' : 'photo',
      url,
      width: x.width ?? null, height: x.height ?? null,
      alt: x.altText || x.alt_text || null,
      local: null, bytes: null, sha256: null,
    };
  }).filter((m) => m.url);
}

function articleText(a) {
  const blocks = a?.content?.blocks;
  const body = Array.isArray(blocks) ? blocks.map((b) => b.text).filter(Boolean).join('\n\n') : '';
  return body || a?.preview_text || '';
}

export function snapshotFromFx(fx, record, { capturedAt = new Date(), capturedBy = 'processor' } = {}) {
  const t = fx?.tweet || fx;
  if (!t || !t.id) throw new NotFoundError('fxtwitter: no tweet');
  const author = authorOf(t.author);
  const q = t.quote;
  return {
    schema: 1,
    id: record.id,
    url: record.url,
    canonical_url: author ? `https://x.com/${t.author.screen_name}/status/${t.id}` : (t.url || record.url),
    captured_at: iso(new Date(capturedAt).toISOString()),
    captured_by: capturedBy,
    source_type: 'x',
    // "<name>: <first 60 chars>" — identical rule in app/core.js snapshotFromFx (keep in sync)
    title: `${t.author?.name ? `${t.author.name}: ` : ''}${String(t.text || t.raw_text?.text || '').replace(/\s+/g, ' ').trim().slice(0, 60)}`,
    author,
    published_at: iso(t.created_timestamp) || iso(t.created_at),
    lang: t.lang || null,
    text: t.text || t.raw_text?.text || '',
    html_text: null,
    quote: q ? {
      url: q.url || null, author: authorOf(q.author), published_at: iso(q.created_timestamp) || iso(q.created_at),
      text: q.text || q.raw_text?.text || '', media: mediaFromFx(q.media?.all),
    } : null,
    article: t.article ? { title: t.article.title || '', text: articleText(t.article) } : null,
    replying_to: t.replying_to ?? null,
    community_note: t.community_note ?? null,
    media: mediaFromFx(t.media?.all),
    web: null,
    stats: { likes: t.likes ?? null, reposts: t.retweets ?? null, views: t.views ?? null },
    raw: { fxtwitter: t },
  };
}

// page = result of fetchGeneric(url, MAX_WEB_TEXT)
export function snapshotFromWeb(page, record, { capturedAt = new Date(), capturedBy = 'processor' } = {}) {
  return {
    schema: 1,
    id: record.id,
    url: record.url,
    canonical_url: page.final_url || record.url,
    captured_at: iso(new Date(capturedAt).toISOString()),
    captured_by: capturedBy,
    source_type: page.source_type === 'file' ? 'file' : 'web',
    title: page.title || null,
    author: page.author ? { name: page.author, handle: null, url: null } : null,
    published_at: iso(page.published_at),
    lang: null,
    text: '',
    html_text: null,
    quote: null, article: null, replying_to: null, community_note: null,
    media: [],
    web: { final_url: page.final_url || null, description: page.description || null, text: page.text || '' },
    stats: null,
    raw: {},
  };
}

// ---------- create-only write ----------

export async function writeSnapshotIfAbsent(file, snapshot) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

// ---------- media ----------

async function downloadOne(url, dest, cap, budget, fetchImpl) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > cap) { try { await r.body?.cancel(); } catch {} return { skip: 'too_large' }; }
  const chunks = [];
  let got = 0;
  for await (const c of r.body) {
    got += c.length;
    if (got > cap) { try { await r.body.cancel(); } catch {} return { skip: 'too_large' }; }
    if (got > budget.remaining) { try { await r.body.cancel(); } catch {} return { transient: 'budget' }; }
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, dest);
  budget.remaining -= buf.length;
  return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

const defaultFetch = (url) => fetchWithTimeout(url, {}, 60000);

/*
 * Downloads missing media of `snapshot` into <archiveRoot>/media. Returns the media list with
 * local/bytes/sha256/skip_reason filled in (the caller decides whether to persist it: only a
 * snapshot that is about to be created gets it; existing snapshots are never rewritten).
 * Files already on disk are kept untouched. budget = { remaining } is shared across a run.
 */
export async function downloadMedia(snapshot, archiveRoot, { limits = {}, budget = { remaining: Infinity }, allowVideo = true, fetchImpl = defaultFetch, log = () => {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  let images = 0, videos = 0;
  const out = [];
  for (const m of snapshot.media || []) {
    const rel = plannedLocal(m);
    const dest = path.join(archiveRoot, rel);
    const isVideo = m.type !== 'photo';
    const counted = isVideo ? videos : images;
    const res = { ...m };
    if (fssync.existsSync(dest)) {
      const st = fssync.statSync(dest);
      res.local = rel; res.bytes = st.size;
      if (!res.sha256) res.sha256 = crypto.createHash('sha256').update(await fs.readFile(dest)).digest('hex');
      delete res.skip_reason;
      isVideo ? videos++ : images++;
    } else if (m.skip_reason) {
      // permanent: leave as recorded
    } else if (counted >= (isVideo ? L.maxVideos : L.maxImages)) {
      res.skip_reason = 'over_limit';
    } else if (isVideo && !allowVideo) {
      // transient: archive too big for videos right now
    } else {
      try {
        const cap = Math.min(isVideo ? L.maxVideoBytes : L.maxImageBytes, L.hardCapBytes);
        const d = await downloadOne(m.url, dest, cap, budget, fetchImpl);
        if (d.skip) { res.skip_reason = d.skip; log(`media ${m.n} skipped: ${d.skip}`); }
        else if (d.transient) log(`media ${m.n} deferred: run budget reached`);
        else { res.local = rel; res.bytes = d.bytes; res.sha256 = d.sha256; isVideo ? videos++ : images++; }
      } catch (e) { log(`media ${m.n} failed: ${e.message}`); }
    }
    out.push(res);
  }
  return out;
}

// total bytes under a directory (to stop videos at 2GB)
export function dirSize(p) {
  let n = 0;
  let entries;
  try { entries = fssync.readdirSync(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) n += dirSize(f);
    else { try { n += fssync.statSync(f).size; } catch {} }
  }
  return n;
}

// ---------- retry rules ----------

// not found 3x in a row -> gone -> weekly; more than 10 failures -> daily; otherwise every run.
export function shouldAttempt(att, now = Date.now()) {
  if (!att) return true;
  const last = Date.parse(att.last_at) || 0;
  if (att.gone) return now - last >= WEEK_MS;
  if ((att.count || 0) > 10) return now - last >= DAY_MS;
  return true;
}

export function nextAttempts(prev, err, now = new Date()) {
  const notFound = err instanceof NotFoundError;
  const count = (prev?.count || 0) + 1;
  const not_found = notFound ? (prev?.not_found || 0) + 1 : 0;
  return { count, not_found, last_at: now.toISOString(), last_error: String(err.message || err), gone: not_found >= 3 };
}

// ---------- fetch + archive one link ----------

async function fetchFx(url) {
  const m = url.match(X_STATUS);
  const user = m[1] && m[1].toLowerCase() !== 'i' ? m[1] : 'i';
  const r = await fetchWithTimeout(`${fxBase()}/${user}/status/${m[2]}`, { headers: { Accept: 'application/json' } });
  if (r.status === 404) throw new NotFoundError('fxtwitter 404');
  if (!r.ok) throw new Error(`fxtwitter ${r.status}`);
  return r.json();
}

/*
 * Creates archive/<y>/<id>/snapshot.json (+ media) unless it already exists.
 * Returns 'exists' | 'created' | 'skipped' (memo/no http url, or waiting for retry) | 'failed'.
 */
export async function archiveLink({ dir, record, now = new Date(), capturedBy = 'processor', budget, allowVideo = true, limits, fetchImpl, log = () => {} }) {
  const p = archivePaths(dir, record.id);
  if (fssync.existsSync(p.snapshot)) return 'exists';
  if (!/^https?:\/\//i.test(record.url || '')) return 'skipped';
  const att = await readJson(p.attempts, null);
  if (!shouldAttempt(att, now.getTime())) return 'skipped';
  try {
    let snap;
    if (X_STATUS.test(record.url)) snap = snapshotFromFx(await fetchFx(record.url), record, { capturedAt: now, capturedBy });
    else snap = snapshotFromWeb(await fetchGeneric(record.url, MAX_WEB_TEXT), record, { capturedAt: now, capturedBy });
    snap.media = await downloadMedia(snap, p.root, { limits, budget, allowVideo, fetchImpl, log });
    await writeSnapshotIfAbsent(p.snapshot, snap);
    return 'created';
  } catch (e) {
    const next = nextAttempts(att, e, now);
    await fs.mkdir(p.root, { recursive: true });
    await fs.writeFile(p.attempts, JSON.stringify(next, null, 2) + '\n');
    log(`archive failed ${record.id} (#${next.count}${next.gone ? ', gone' : ''}): ${next.last_error}`);
    return 'failed';
  }
}

// Adds missing media files for an existing snapshot (snapshot.json itself is never rewritten).
// Returns the number of bytes downloaded.
export async function backfillMedia({ dir, snapshot, budget, allowVideo = true, limits, fetchImpl, log = () => {} }) {
  const p = archivePaths(dir, snapshot.id);
  const missing = (snapshot.media || []).some((m) => !m.skip_reason && !fssync.existsSync(path.join(p.root, plannedLocal(m))));
  if (!missing) return 0;
  const before = budget.remaining;
  await downloadMedia(snapshot, p.root, { limits, budget, allowVideo, fetchImpl, log });
  return before - budget.remaining;
}

// ---------- reading ----------

export async function readSnapshot(dir, id) {
  return readJson(archivePaths(dir, id).snapshot, null);
}

// Snapshot with media[].local set from what is actually on disk (null if the file is missing).
export function withLocalMedia(dir, snapshot) {
  const root = archivePaths(dir, snapshot.id).root;
  return { ...snapshot, media: (snapshot.media || []).map((m) => {
    const rel = plannedLocal(m);
    return { ...m, local: fssync.existsSync(path.join(root, rel)) ? rel : null };
  }) };
}

export async function loadArchives(dir, records) {
  const m = new Map();
  for (const r of records) {
    const s = await readSnapshot(dir, r.id);
    if (s) m.set(r.id, withLocalMedia(dir, { ...s, id: r.id }));
  }
  return m;
}

// ---------- analysis input ----------

const MAX_PROMPT_TEXT = 12_000;

export function contentFromSnapshot(s) {
  if (s.source_type === 'x') {
    const parts = [s.text || ''];
    if (s.article) parts.push(`[記事] ${s.article.title || ''}\n${s.article.text || ''}`);
    if (s.quote) parts.push(`[引用元 ${s.quote.author?.handle || ''}] ${s.quote.text || ''}`);
    for (const m of s.media || []) if (m.alt) parts.push(`[画像説明] ${m.alt}`);
    return {
      ok: true, source_type: 'x', title: s.title, author: s.author?.handle || null, published_at: s.published_at,
      description: null, text: parts.filter(Boolean).join('\n\n').slice(0, MAX_PROMPT_TEXT), final_url: null,
    };
  }
  return {
    ok: true, source_type: s.source_type, title: s.title, author: s.author?.name || null, published_at: s.published_at,
    description: s.web?.description || null, text: (s.web?.text || '').slice(0, MAX_PROMPT_TEXT), final_url: s.web?.final_url || null,
  };
}

// Archive first; falls back to a live fetch (v1 behaviour) when there is no snapshot yet.
export async function loadContent(dir, record) {
  const s = await readSnapshot(dir, record.id);
  return s ? contentFromSnapshot(s) : fetchContent(record.url);
}
