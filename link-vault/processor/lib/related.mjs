/*
 * Related capture (DESIGN-v3.md): the context graph around a saved X post and the resources it points to.
 *
 *   archive/<y>/<id>/related.json                ledger (graph + resources + primary). create-only ('wx')
 *   archive/<y>/<id>/related/posts/<sid>.json    fxtwitter v2 status objects as received (parents, quotes, self replies)
 *   archive/<y>/<id>/related/res/NN-<type>-<slug>.json  resource metadata (the file's existence is the truth, not ledger ok)
 *   archive/<y>/<id>/related/res/NN-<type>-<slug>.md    resource body (README / model card / abstract / readable text)
 *   archive/<y>/<id>/related/thread.json         optional: /2/thread response saved by the phone (preferred over fetching)
 *   archive/<y>/<id>/related-attempts.json       failure bookkeeping while related.json does not exist
 *   archive/<y>/<id>/related/res-attempts.json   retry bookkeeping for resources that failed
 *
 * Pure functions (graphFromThread, classifyUrl, canonicalUrl, dedupeResources, scorePrimary) are separate from
 * fetchers and from the orchestrator (captureRelated). Base URLs are overridable for tests:
 * LV_FXTWITTER_BASE, LV_GITHUB_BASE, LV_HF_BASE, LV_ARXIV_BASE (+ LV_ARXIV_ABS_BASE), LV_YOUTUBE_BASE.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X_STATUS, fxBase, fetchWithTimeout, fetchGeneric } from './fetch-content.mjs';
import { archivePaths, shouldAttempt, nextAttempts, NotFoundError } from './archive.mjs';
import { readJson } from './util.mjs';
import { fetchProfileSites } from './related-extra.mjs';
import { captureXReplies, xrepliesTrigger, perRun as xrepliesPerRun } from './x-replies.mjs';

export const LIMITS = {
  maxParents: 3,
  maxSelfReplies: 5,
  maxResources: 8,
  resourceTextChars: 300_000,
  webTextChars: 200_000,
  perLinkMs: 90_000,
  maxResourceBytes: 50 * 1024 * 1024,
  runResourceBudget: 40,
  runArxivBudget: 20,
  resRetryMax: 5,
};
const DAY_MS = 24 * 3600 * 1000;
const TYPE_RANK = { github: 0, hf: 1, arxiv: 2, web: 3, youtube: 4 };

// ---------- paths ----------

export function relatedPaths(dir, id) {
  const root = archivePaths(dir, id).root;
  return {
    root,
    related: path.join(root, 'related.json'),
    attempts: path.join(root, 'related-attempts.json'),
    posts: path.join(root, 'related', 'posts'),
    res: path.join(root, 'related', 'res'),
    thread: path.join(root, 'related', 'thread.json'),
    resAttempts: path.join(root, 'related', 'res-attempts.json'),
  };
}

// ---------- URL handling (pure) ----------

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|svg|mp4|mov|webm|m4v|mp3|zip)$/i;
const MEDIA_HOSTS = /^(pbs|video|abs|ton)\.twimg\.com$/i;
const GH_RESERVED = new Set(['topics', 'features', 'orgs', 'sponsors', 'marketplace', 'settings', 'about', 'pricing', 'login', 'join', 'explore', 'collections', 'trending', 'search', 'notifications', 'new', 'enterprise', 'site', 'security', 'customer-stories', 'readme', 'pulls', 'issues', 'apps', 'users', 'gist']);
const HF_RESERVED = new Set(['docs', 'blog', 'papers', 'collections', 'organizations', 'settings', 'pricing', 'join', 'login', 'tasks', 'learn', 'posts', 'api']);
const TRACKING = /^(utm_\w+|fbclid|gclid|igshid|mc_\w+|ref_src|ref_url|si|ref)$/i;

function parseHttp(raw) {
  try {
    const u = new URL(String(raw).trim());
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch { return null; }
}

// Same page, same string: no www, no tracking params, no fragment, no trailing slash.
export function canonicalUrl(raw) {
  const u = parseHttp(raw);
  if (!u) return String(raw || '').trim();
  const host = u.hostname.toLowerCase().replace(/^(www\.|mobile\.|m\.)/, '') + (u.port ? `:${u.port}` : '');
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? '?' + new URLSearchParams(params).toString() : '';
  return `${u.protocol}//${host}${u.pathname.replace(/\/+$/, '')}${qs}`;
}
export const normalizeUrl = canonicalUrl;

// Returns null for URLs that are never fetched as resources.
export function classifyUrl(raw) {
  const u = parseHttp(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|mobile\.|m\.)/, '');
  const segs = u.pathname.split('/').filter(Boolean);
  if (host === 'x.com' || host === 'twitter.com' || host === 't.co') return null;
  if (MEDIA_HOSTS.test(host) || MEDIA_EXT.test(u.pathname)) return null;
  if (host === 'github.com' && segs.length >= 2 && !GH_RESERVED.has(segs[0].toLowerCase())) {
    const repo = segs[1].replace(/\.git$/, '');
    return { type: 'github', key: `${segs[0]}/${repo}`, url: `https://github.com/${segs[0]}/${repo}` };
  }
  if (host === 'huggingface.co' || host === 'hf.co') {
    let kind = 'models', rest = segs;
    if (segs[0] === 'datasets' || segs[0] === 'spaces') { kind = segs[0]; rest = segs.slice(1); }
    if (rest.length >= 2 && !(kind === 'models' && HF_RESERVED.has(rest[0]))) {
      const key = `${rest[0]}/${rest[1]}`;
      return { type: 'hf', key, hfKind: kind, url: `https://huggingface.co/${kind === 'models' ? '' : kind + '/'}${key}` };
    }
  }
  if (host === 'arxiv.org' || host === 'export.arxiv.org') {
    const m = u.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?\/?$/);
    if (m) return { type: 'arxiv', key: m[1], url: `https://arxiv.org/abs/${m[1]}` };
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com') {
    const v = host === 'youtu.be' ? segs[0] : u.pathname === '/watch' ? u.searchParams.get('v') : null;
    if (v) return { type: 'youtube', key: v, url: `https://www.youtube.com/watch?v=${v}` };
  }
  const url = canonicalUrl(raw);
  return { type: 'web', key: url, url };
}

const dedupeKey = (c) => `${c.type}:${c.key.toLowerCase()}`;

// items: [{url, sid}] -> [{url, type, key, found_in:[sid...], hfKind?}] in first-seen order.
export function dedupeResources(items) {
  const map = new Map();
  for (const { url, sid } of items) {
    const c = classifyUrl(url);
    if (!c) continue;
    const k = dedupeKey(c);
    const cur = map.get(k);
    if (cur) { if (!cur.found_in.includes(sid)) cur.found_in.push(sid); }
    else map.set(k, { ...c, found_in: [sid] });
  }
  return [...map.values()];
}

// ---------- thread -> graph (pure) ----------

const iso = (v) => {
  if (v == null) return null;
  const t = new Date(typeof v === 'number' ? v * 1000 : v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d+Z$/, 'Z') : null;
};
const handleOf = (a) => (a?.screen_name ? `@${a.screen_name}` : null);
const postText = (t) => t?.text || t?.raw_text?.text || '';

// Expanded URLs of a post: facets (t.co already resolved), card, and bare URLs as a fallback.
function collectUrls(t) {
  const out = [];
  const add = (u) => { if (u && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u); };
  for (const f of t?.raw_text?.facets || []) if (f.type === 'url') add(f.replacement);
  add(t?.card?.url);
  if (!out.length) for (const m of postText(t).matchAll(/https?:\/\/[^\s<>"')\]]+/g)) add(m[0]);
  return out;
}

function entry(t, role, depth, extra = {}) {
  const urls = [], xLinks = [];
  for (const u of collectUrls(t)) (X_STATUS.test(u) ? xLinks : urls).push(u);
  const e = {
    sid: String(t.id), role, depth, ...extra,
    author: handleOf(t.author), text: postText(t), published_at: iso(t.created_timestamp) || iso(t.created_at),
    urls, quote_sid: t.quote?.id ? String(t.quote.id) : null,
    file: `related/posts/${t.id}.json`,
  };
  if (xLinks.length) e.x_links = xLinks;
  return e;
}

/*
 * threadJson = fxtwitter /2/thread/<id> response (or {status} only). extraParents = status objects of
 * ancestors (nearest first) fetched separately when the thread array does not contain them.
 * Returns { root, posts, objects:{sid: raw status}, resources (ranked, numbered), primary }.
 */
export function graphFromThread(threadJson, rootId, { extraParents = [] } = {}) {
  let arr = Array.isArray(threadJson?.thread) && threadJson.thread.length ? [...threadJson.thread] : (threadJson?.status ? [threadJson.status] : []);
  rootId = String(rootId);
  let idx = arr.findIndex((t) => String(t.id) === rootId);
  if (idx < 0) {
    if (!threadJson?.status) throw new NotFoundError('thread has no root post');
    arr = [threadJson.status]; idx = 0;
  }
  const posts = [], objects = {};
  const take = (t, role, depth, extra) => {
    if (!t?.id || objects[String(t.id)]) return null;
    objects[String(t.id)] = t;
    const e = entry(t, role, depth, extra);
    posts.push(e);
    return e;
  };

  const rootEntry = take(arr[idx], 'self', 0);
  const ancestors = [...arr.slice(0, idx).reverse(), ...extraParents].slice(0, LIMITS.maxParents);
  const parentEntries = ancestors.map((t, i) => take(t, 'parent', i + 1)).filter(Boolean);
  const replyEntries = arr.slice(idx + 1, idx + 1 + LIMITS.maxSelfReplies).map((t, i) => take(t, 'self_reply', i + 1)).filter(Boolean);

  // quotes: one level only. A quoted post's own quote is not followed.
  for (const e of [rootEntry, ...parentEntries, ...replyEntries]) {
    const q = objects[e.sid].quote;
    if (q?.id && !objects[String(q.id)]) {
      const qe = take(q, 'quote', e.depth, { of: e.sid });
      if (qe) qe.quote_sid = null;
    }
  }
  const order = { parent: 0, self: 1, self_reply: 2, quote: 3 };
  posts.sort((a, b) => order[a.role] - order[b.role] || (a.role === 'parent' ? b.depth - a.depth : a.depth - b.depth));

  const found = [];
  for (const p of posts) for (const url of p.urls) found.push({ url, sid: p.sid });
  return { root: rootEntry.sid, posts, objects, ...scorePrimary({ posts, resources: dedupeResources(found), objects }) };
}

// ---------- primary subject (pure) ----------

const OFFICIAL_TEXT = /\bIntroducing\b|announc|\blaunch|公開|発表|リリース/i;

function urlOnly(text, urls) {
  let t = text || '';
  for (const u of urls) t = t.split(u).join(' ');
  t = t.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, '');
  return t.length < 20;
}

/*
 * g = { posts, resources (unranked, with found_in), objects }.
 * Returns { resources (ranked, at most 8, numbered from 1), primary }.
 */
export function scorePrimary(g) {
  const bySid = new Map(g.posts.map((p) => [p.sid, p]));
  const root = g.posts.find((p) => p.role === 'self');
  const urlRoot = !!root && urlOnly(root.text, root.urls);
  const scored = g.resources.map((r, order) => {
    let score = 0;
    const why = [];
    const roles = new Set();
    for (const sid of r.found_in) {
      const p = bySid.get(sid);
      if (!p) continue;
      roles.add(p.role === 'quote' ? `quote_of_${bySid.get(p.of)?.role || 'x'}` : p.role);
    }
    if (roles.has('self')) { score += 5; why.push('in the saved post'); if (urlRoot) { score += 3; why.push('the post is only this url'); } }
    if (roles.has('self_reply')) { score += 3; why.push("in the author's self reply"); }
    if (roles.has('quote_of_self')) { score += 3; why.push('in the quoted post'); }
    if (roles.has('parent') || [...roles].some((x) => x.startsWith('quote_of_') && x !== 'quote_of_self')) { score += 2; why.push('in a parent post'); }
    if (r.found_in.length > 1) { score += 2; why.push('appears in several posts'); }
    // supplements (v3.1): the author's profile website only wins when nothing better exists; replies found by search rank like a parent link
    if (String(r.origin || '').startsWith('profile:')) { score += 1; why.push(`author profile website (${r.origin.slice(8)})`); }
    if (r.origin === 'x_replies') { score += 2; why.push("found in other people's replies (browser)"); if (r.mentions >= 2) { score += 1; why.push(`mentioned in ${r.mentions} replies`); } }
    if (r.origin === 'x_replies_self') { score += 3; why.push("found in the author's own reply (browser)"); }
    return { ...r, score, order, why: why.join('; ') };
  });
  scored.sort((a, b) => b.score - a.score || (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9) || a.order - b.order);
  const top = scored.slice(0, LIMITS.maxResources);
  const resources = top.map(({ score, order, why, ...r }, i) => ({ n: i + 1, ...r }));

  let primary = { kind: 'self', reason: 'no resource or official quote; the saved post itself' };
  let postScore = 0, postPrimary = null;
  const q = root && g.posts.find((p) => p.role === 'quote' && p.of === root.sid);
  if (q && !q.urls.length) {
    const qo = g.objects?.[q.sid];
    if (['business', 'organization', 'government'].includes(qo?.author?.verification?.type) || OFFICIAL_TEXT.test(q.text)) {
      postScore = 2;
      postPrimary = { kind: 'post', sid: q.sid, reason: 'the quoted post looks official and has no url' };
    }
  }
  if (top[0] && top[0].score > 0 && top[0].score >= postScore) primary = { kind: 'resource', n: 1, reason: `${top[0].why} (score ${top[0].score})` };
  else if (postPrimary) primary = postPrimary;
  return { resources, primary };
}

// ---------- fetchers ----------

const trimBase = (v, d) => (v || d).replace(/\/+$/, '');
const ghBase = () => trimBase(process.env.LV_GITHUB_BASE, 'https://api.github.com');
const hfBase = () => trimBase(process.env.LV_HF_BASE, 'https://huggingface.co');
const arxivBase = () => trimBase(process.env.LV_ARXIV_BASE, 'https://export.arxiv.org');
const arxivAbsBase = () => trimBase(process.env.LV_ARXIV_ABS_BASE || process.env.LV_ARXIV_BASE, 'https://arxiv.org');
const ytBase = () => trimBase(process.env.LV_YOUTUBE_BASE, 'https://www.youtube.com');

let ghToken; // undefined = not looked up yet
function githubToken() {
  if (process.env.LV_GITHUB_BASE || process.env.LV_NO_GH === '1') return null; // never send a token to a test double
  if (ghToken === undefined) {
    try { ghToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null; } catch { ghToken = null; }
  }
  return ghToken;
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

async function getJson(url, headers = {}) {
  const r = await fetchWithTimeout(url, { headers: { Accept: 'application/json', ...headers } });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url}`), { status: r.status });
  return r.json();
}
async function getText(url, headers = {}) {
  const r = await fetchWithTimeout(url, { headers });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url}`), { status: r.status });
  if (Number(r.headers.get('content-length') || 0) > LIMITS.maxResourceBytes) throw new Error('response too large');
  return r.text();
}

async function fetchGithub(res) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const tok = githubToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const repo = await getJson(`${ghBase()}/repos/${res.key}`, headers);
  const meta = clean({
    full_name: repo.full_name, description: repo.description, stars: repo.stargazers_count, language: repo.language,
    license: repo.license?.spdx_id || repo.license?.name || null, topics: repo.topics || [], pushed_at: repo.pushed_at,
    default_branch: repo.default_branch, homepage: repo.homepage || null,
  });
  let body = null;
  try {
    const rd = await getJson(`${ghBase()}/repos/${res.key}/readme`, headers);
    body = rd.content ? Buffer.from(rd.content, 'base64').toString('utf8') : null;
  } catch (e) { if (e.status !== 404) throw e; }
  return { meta, body, limit: LIMITS.resourceTextChars };
}

async function fetchHf(res) {
  const kind = res.hfKind || 'models';
  const prefix = kind === 'models' ? '' : `${kind}/`;
  const j = await getJson(`${hfBase()}/api/${kind}/${res.key}`);
  const meta = clean({
    id: j.id || res.key, kind, pipeline_tag: j.pipeline_tag, tags: j.tags, downloads: j.downloads, likes: j.likes,
    lastModified: j.lastModified, gated: j.gated ?? false, license: j.cardData?.license ?? null, library_name: j.library_name,
  });
  let body = null, bodySource;
  try { body = await getText(`${hfBase()}/${prefix}${res.key}/raw/main/README.md`); bodySource = 'readme'; } catch (e) { if (![401, 403, 404].includes(e.status)) throw e; }
  // Gated repos answer 401 for raw files, but the model card is still rendered on the public page: keep that text.
  if (body == null) {
    try {
      const g = await fetchGeneric(`${hfBase()}/${prefix}${res.key}`, LIMITS.resourceTextChars);
      if (g.source_type === 'web' && g.text && g.text.length > 200) { body = g.text; bodySource = 'page'; }
    } catch {}
  }
  return { meta: clean({ ...meta, body_source: bodySource }), body, limit: LIMITS.resourceTextChars };
}

let lastArxivAt = 0;
const arxivIntervalMs = () => Number(process.env.LV_ARXIV_INTERVAL_MS ?? 3000);
async function arxivWait() {
  const wait = lastArxivAt + arxivIntervalMs() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastArxivAt = Date.now();
}
const xmlText = (s) => String(s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export function parseArxivAtom(xml) {
  const entry = (xml.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1];
  if (!entry) return null;
  const tag = (t) => { const m = entry.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? xmlText(m[1]) : null; };
  return {
    title: tag('title'), abstract: tag('summary'), published: tag('published'),
    authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => xmlText(m[1])),
    categories: [...entry.matchAll(/<category[^>]*\bterm="([^"]+)"/g)].map((m) => m[1]),
  };
}

async function fetchArxiv(res) {
  let info = null;
  try {
    await arxivWait();
    info = parseArxivAtom(await getText(`${arxivBase()}/api/query?id_list=${encodeURIComponent(res.key)}`));
  } catch (e) {
    if (e.status !== 429 && !(e.status >= 500)) throw e;
  }
  if (!info) { // rate limited: read the abs page instead
    await arxivWait();
    const html = await getText(`${arxivAbsBase()}/abs/${res.key}`);
    const t = (k) => { const m = html.match(new RegExp(`<meta name="${k}" content="([^"]*)"`, 'i')); return m ? xmlText(m[1]) : null; };
    info = { title: t('citation_title'), abstract: t('citation_abstract') || t('description'), published: t('citation_date'), authors: [...html.matchAll(/<meta name="citation_author" content="([^"]*)"/gi)].map((m) => xmlText(m[1])), categories: [] };
    if (!info.title) throw new Error('arxiv: could not parse the abs page');
  }
  return { meta: clean({ title: info.title, authors: info.authors, published: info.published, categories: info.categories }), body: info.abstract, limit: LIMITS.resourceTextChars };
}

async function fetchYoutube(res) {
  const j = await getJson(`${ytBase()}/oembed?url=${encodeURIComponent(res.url)}&format=json`);
  return { meta: clean({ title: j.title, author_name: j.author_name, thumbnail_url: j.thumbnail_url }), body: null, limit: 0 };
}

export const EMPTY_BODY = 'empty body';
export async function fetchWeb(res) {
  const g = await fetchGeneric(res.url, LIMITS.webTextChars);
  if (g.source_type === 'file') throw new Error(`unsupported content-type (${g.description || 'non-html'})`);
  const bodyText = String(g.text || '').replace(/\s+/g, ' ').trim();
  // a JS-only page yields at most its <title>/description as "text": that is no body
  if (!bodyText || bodyText === (g.title || '').trim() || bodyText === (g.description || '').trim()) throw new Error(EMPTY_BODY); // JS-only / blank pages: shown as 本文なし, not as a successful fetch
  return { meta: clean({ final_url: g.final_url, title: g.title, description: g.description }), body: g.text, limit: LIMITS.webTextChars };
}

const FETCHERS = { github: fetchGithub, hf: fetchHf, arxiv: fetchArxiv, youtube: fetchYoutube, web: fetchWeb };

// Returns { meta, body, truncated }. Throws on failure. Text is cut to the type's limit (truncated:true).
export async function fetchResource(res) {
  const out = await FETCHERS[res.type](res);
  const over = out.body != null && out.body.length > out.limit;
  const body = out.body == null ? null : over ? out.body.slice(0, out.limit) : out.body;
  return { meta: { type: res.type, key: res.key, url: res.url, ...out.meta, fetched_at: new Date().toISOString(), truncated: over }, body, truncated: over };
}

// ---------- file writing (create-only) ----------

const slugOf = (res) => String(res.key || res.url).replace(/^https?:\/\//, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'res';
const resBase = (res) => `${String(res.n).padStart(2, '0')}-${res.type}-${slugOf(res)}`;

async function writeNew(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, data, { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}

async function writeResourceFiles(p, res, fetched) {
  const base = resBase(res);
  await writeNew(path.join(p.res, `${base}.json`), JSON.stringify(fetched.meta, null, 2) + '\n');
  if (fetched.body) await writeNew(path.join(p.res, `${base}.md`), fetched.body);
  return { meta: `related/res/${base}.json`, text: fetched.body ? `related/res/${base}.md` : null, bytes: Buffer.byteLength(fetched.body || ''), truncated: fetched.truncated };
}

// ---------- fetching the thread ----------

async function fxGet(pathPart) {
  const r = await fetchWithTimeout(`${fxBase()}${pathPart}`, { headers: { Accept: 'application/json' } });
  if (r.status === 404) throw new NotFoundError('fxtwitter 404');
  if (!r.ok) throw new Error(`fxtwitter ${r.status}`);
  return r.json();
}

async function loadThread(p, rootId) {
  const saved = await readJson(p.thread, null);
  if (saved && (saved.thread || saved.status)) return { json: saved, from: 'phone' };
  return { json: await fxGet(`/2/thread/${rootId}`), from: 'fxtwitter' };
}

// Ancestors by walking replying_to when the thread array does not contain them (someone else's posts).
async function walkParents(json, rootId, log) {
  const arr = json.thread?.length ? json.thread : json.status ? [json.status] : [];
  if (arr.findIndex((t) => String(t.id) === String(rootId)) > 0) return [];
  const have = new Set(arr.map((t) => String(t.id)));
  const root = arr.find((t) => String(t.id) === String(rootId)) || json.status;
  const out = [];
  let cur = root;
  while (out.length < LIMITS.maxParents && cur?.replying_to?.status && !have.has(String(cur.replying_to.status))) {
    try {
      const j = await fxGet(`/2/status/${cur.replying_to.status}`);
      const s = j.status || j.tweet;
      if (!s?.id) break;
      out.push(s); have.add(String(s.id)); cur = s;
    } catch (e) { log(`related: parent ${cur.replying_to.status} unavailable: ${e.message}`); break; }
  }
  return out;
}

// ---------- orchestrator ----------

export const newRelatedBudget = () => ({ resources: LIMITS.runResourceBudget, arxiv: LIMITS.runArxivBudget, xreplies: xrepliesPerRun() });

async function fetchAll(p, resources, budget, log) {
  const started = Date.now();
  const results = new Map(); // n -> ledger fields
  for (const res of resources) {
    if (Date.now() - started > LIMITS.perLinkMs) { results.set(res.n, { ok: false, error: 'per-link time limit' }); continue; }
    if (budget.resources <= 0) { results.set(res.n, { ok: false, error: 'run budget reached' }); continue; }
    if (res.type === 'arxiv') {
      if (budget.arxiv <= 0) { results.set(res.n, { ok: false, error: 'arxiv run budget reached' }); continue; }
      budget.arxiv--;
    }
    budget.resources--;
    try {
      const f = await fetchResource(res);
      results.set(res.n, { ok: true, error: null, ...(await writeResourceFiles(p, res, f)) });
    } catch (e) {
      log(`related: resource ${res.url} failed: ${e.message}`);
      results.set(res.n, { ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }
  return results;
}


// ---------- supplements: profile website + x replies (v3.1/v3.2) ----------

// -> new resources [{url,type,key,found_in:[],origin,...}] not already in `have`, in order.
function newFromExtras(have, extras) {
  const seen = new Set(have.map(dedupeKey));
  const out = [];
  for (const { url, origin, mentions } of extras) {
    const c = classifyUrl(url);
    if (!c || seen.has(dedupeKey(c))) continue;
    seen.add(dedupeKey(c));
    out.push({ ...c, found_in: [], origin, ...(mentions > 1 ? { mentions } : {}) });
  }
  return out;
}

/*
 * posts: ledger-style posts; resources: ledger/graph resources; supp: {profile_done, xreplies_done} (mutated).
 * Returns the extra {url, origin} candidates. Never throws.
 */
async function gatherExtras({ p, record, posts, resources, supp, budget, now, log, primary }) {
  const extras = [];
  try {
    if (!supp.profile_done) {
      const self = posts.find((x) => x.role === 'self');
      const handles = [...new Set(posts.filter((x) => (x.role === 'quote' || x.role === 'parent') && !x.urls.length && x.author && x.author !== self?.author).map((x) => x.author))].slice(0, 2);
      let failed = false;
      for (const h of handles) {
        const r = await fetchProfileSites(h, log);
        if (r.status === 'error') failed = true;
        for (const url of r.urls) extras.push({ url, origin: `profile:${h}` });
      }
      // network trouble: retry next run, but give up after 5 tries so an unreachable profile does not cost 2 fetches every run forever
      if (!failed || (supp.profile_attempts = (supp.profile_attempts || 0) + 1) >= 5) supp.profile_done = true;
    }
  } catch (e) { log(`profile fallback failed: ${e.message}`); }
  try {
    if (!supp.xreplies_done) {
      const trig = xrepliesTrigger();
      const self = posts.find((x) => x.role === 'self');
      if (trig && self?.sid) {
        const r = await captureXReplies({ relatedRoot: p.root, id: record.id, statusUrl: record.url, sid: self.sid, skipSids: posts.map((x) => x.sid), budget, now, log });
        if (r.status === 'done') { supp.xreplies_done = true; supp.xreplies_trigger = trig; for (const u of r.urls) extras.push({ url: u.url, origin: u.own ? 'x_replies_self' : 'x_replies', mentions: u.count }); }
      }
    }
  } catch (e) { log(`x replies failed: ${e.message}`); }
  return extras;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

// Existing related.json: append supplement resources (never change or remove anything already there). true when it changed.
async function supplementExisting(p, record, budget, now, log) {
  const ledger = await readJson(p.related, null);
  if (!ledger?.posts) return false;
  const supp = { ...(ledger.supplement || {}) };
  const before = JSON.stringify(supp);
  const extras = await gatherExtras({ p, record, posts: ledger.posts, resources: ledger.resources || [], supp, budget, now, log, primary: ledger.primary });
  let fresh = newFromExtras(ledger.resources || [], extras).slice(0, Math.max(0, LIMITS.maxResources - (ledger.resources || []).length));
  if (!fresh.length && JSON.stringify(supp) === before) return false;
  let n = Math.max(0, ...(ledger.resources || []).map((r) => r.n));
  fresh = fresh.map((r) => ({ ...r, n: ++n }));
  if (fresh.length) supp.resources_added_at = now.toISOString(); // --reanalyze-related re-reads links changed after their analysis
  const fetched = fresh.length ? await fetchAll(p, fresh, budget, log) : new Map();
  const added = fresh.map((r) => ({
    n: r.n, url: r.url, type: r.type, key: r.key, ...(r.hfKind ? { hfKind: r.hfKind } : {}), found_in: r.found_in, origin: r.origin, ...(r.mentions ? { mentions: r.mentions } : {}),
    meta: null, text: null, bytes: 0, ok: false, error: null, ...(fetched.get(r.n) || {}),
  }));
  const resources = [...ledger.resources, ...added];
  const objects = {};
  for (const x of ledger.posts) objects[x.sid] = await readJson(path.join(p.posts, `${x.sid}.json`), null);
  const sp = scorePrimary({ posts: ledger.posts, resources: resources.map((r) => ({ ...r })), objects });
  const top = sp.primary.kind === 'resource' ? sp.resources[sp.primary.n - 1] : null;
  const keep = top && resources.find((r) => dedupeKey(r) === dedupeKey(top));
  const primary = keep ? { ...sp.primary, n: keep.n } : sp.primary;
  const next = { ...ledger, resources, primary, supplement: { v: 1, ...supp, updated_at: now.toISOString() } };
  await writeAtomic(p.related, JSON.stringify(next, null, 2) + '\n');
  return true;
}

/*
 * Creates related.json (+ posts, resources) for an X link unless it exists; for an existing one, retries
 * resources whose meta file is missing. Returns 'exists' | 'created' | 'filled' | 'skipped' | 'failed'.
 */
export async function captureRelated({ dir, record, budget = newRelatedBudget(), now = new Date(), log = () => {} }) {
  const m = (record.url || '').match(X_STATUS);
  if (!m) return 'skipped';
  const rootId = m[2];
  const p = relatedPaths(dir, record.id);
  if (fssync.existsSync(p.related)) {
    const filled = await fillMissing(p, budget, now, log);
    let supp = false;
    try { supp = await supplementExisting(p, record, budget, now, log); } catch (e) { log(`related supplement ${record.id}: ${e.message}`); }
    return filled || supp ? 'filled' : 'exists';
  }
  const att = await readJson(p.attempts, null);
  if (!shouldAttempt(att, now.getTime())) return 'skipped';
  try {
    const { json, from } = await loadThread(p, rootId);
    let graph = graphFromThread(json, rootId, { extraParents: await walkParents(json, rootId, log) });
    const supp = {};
    const extras = await gatherExtras({ p, record, posts: graph.posts, resources: graph.resources, supp, budget, now, log, primary: graph.primary });
    const more = newFromExtras(graph.resources, extras);
    if (more.length) {
      const sp = scorePrimary({ posts: graph.posts, resources: [...graph.resources.map(({ n, ...r }) => r), ...more], objects: graph.objects });
      graph = { ...graph, ...sp };
    }
    for (const [sid, obj] of Object.entries(graph.objects)) await writeNew(path.join(p.posts, `${sid}.json`), JSON.stringify(obj, null, 2) + '\n');
    const fetched = await fetchAll(p, graph.resources, budget, log);
    const ledger = {
      schema: 1, id: record.id, captured_at: now.toISOString(), captured_by: 'processor', thread_from: from, root: graph.root,
      posts: graph.posts,
      resources: graph.resources.map((r) => ({
        n: r.n, url: r.url, type: r.type, key: r.key, ...(r.hfKind ? { hfKind: r.hfKind } : {}), found_in: r.found_in, ...(r.origin ? { origin: r.origin } : {}), ...(r.mentions ? { mentions: r.mentions } : {}),
        meta: null, text: null, bytes: 0, ok: false, error: null, ...(fetched.get(r.n) || {}),
      })),
      primary: graph.primary,
      supplement: { v: 1, ...supp },
    };
    await fs.writeFile(p.related, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx' });
    return 'created';
  } catch (e) {
    if (e.code === 'EEXIST') return 'exists';
    const next = nextAttempts(att, e, now);
    await fs.mkdir(p.root, { recursive: true });
    await fs.writeFile(p.attempts, JSON.stringify(next, null, 2) + '\n');
    log(`related failed ${record.id} (#${next.count}${next.gone ? ', gone' : ''}): ${next.last_error}`);
    return 'failed';
  }
}

// ok:false resources: up to 5 retries on every run, then once a day. The file's existence is the truth.
async function fillMissing(p, budget, now, log) {
  const ledger = await readJson(p.related, null);
  const missing = (ledger?.resources || []).filter((r) => !fssync.existsSync(path.join(p.root, r.meta || `related/res/${resBase(r)}.json`)));
  if (!missing.length) return false;
  const att = await readJson(p.resAttempts, { count: 0, last_at: null });
  if (att.count >= LIMITS.resRetryMax && now.getTime() - (Date.parse(att.last_at) || 0) < DAY_MS) return false;
  const results = await fetchAll(p, missing, budget, log);
  await fs.mkdir(path.dirname(p.resAttempts), { recursive: true });
  await fs.writeFile(p.resAttempts, JSON.stringify({ count: att.count + 1, last_at: now.toISOString() }, null, 2) + '\n');
  return [...results.values()].some((r) => r.ok);
}

// ---------- reading (analysis input / ai build) ----------

// { ledger, res: Map<n, {meta, text}>, replies: x-replies.json|null } or null when there is no related.json.
export async function loadRelated(dir, id) {
  const p = relatedPaths(dir, id);
  const ledger = await readJson(p.related, null);
  if (!ledger) return null;
  const res = new Map();
  for (const r of ledger.resources || []) {
    const meta = await readJson(path.join(p.root, r.meta || `related/res/${resBase(r)}.json`), null);
    let text = null;
    try { text = await fs.readFile(path.join(p.root, r.text || `related/res/${resBase(r)}.md`), 'utf8'); } catch {}
    if (meta || text) res.set(r.n, { meta, text });
  }
  // other people's replies (related/x-replies.json, captured with bsk); null when never captured
  const replies = await readJson(path.join(p.root, 'related', 'x-replies.json'), null);
  return { ledger, res, replies: Array.isArray(replies?.replies) ? replies : null };
}

// Display name of a resource for headings and lists.
export function resourceName(r, loaded) {
  const m = loaded?.meta;
  return m?.full_name || m?.id || m?.title || r.key || r.url;
}

// Shape used by the analysis prompt: ledger posts + resources with their loaded meta/text.
export function relatedContent(loaded) {
  const { ledger, res } = loaded;
  return {
    primary: ledger.primary,
    posts: ledger.posts,
    replies: loaded.replies?.replies || [],
    resources: ledger.resources.map((r) => {
      const l = res.get(r.n);
      return { ...r, name: resourceName(r, l), meta: l?.meta || null, text: l?.text || null };
    }),
  };
}
