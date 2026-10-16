/*
 * Related capture, supplements (DESIGN-v3.md addendum "v3.1"):
 *   A) author profile website fallback: fxtwitter /<handle> -> user.website / bio facets (+ link hubs)
 *   B) other people's replies via Grok X search (quota-limited), stored at related/x-search.json (create-only)
 * Everything here is best effort: callers wrap it; a failure never blocks archiving or analysis.
 * Env: LV_XSEARCH (default on, 0 = off), LV_GROK_BIN (default grok-api), LV_XSEARCH_PER_RUN (3),
 *      LV_XSEARCH_COOLDOWN_FILE, LV_XSEARCH_FORCE=1 (debug: ignore the trigger rules), LV_HUB_HOSTS (extra hub hosts, tests).
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fxBase, fetchWithTimeout } from './fetch-content.mjs';
import { classifyUrl } from './related.mjs';
import { readJson } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 3600 * 1000;

// ---------- A) profile website ----------

const HUB_RE = /(^|\.)(linktr\.ee|lit\.link|bento\.me|beacons\.ai|linkin\.bio|carrd\.co|campsite\.bio|taplink\.cc|potion\.so|lnk\.bio)$/i;
const JUNK_HOST = /(^|\.)(x\.com|twitter\.com|t\.co|instagram\.com|facebook\.com|tiktok\.com|linkedin\.com|discord\.gg|discord\.com|threads\.net|youtube\.com|youtu\.be|twitch\.tv|patreon\.com|ko-fi\.com|apple\.com|play\.google\.com|google\.com|googleapis\.com|gstatic\.com|w3\.org|schema\.org|sjv\.io|pxf\.io|linksynergy\.com|awin1\.com|shareasale\.com|doubleclick\.net|datagrail\.io|cookiebot\.com|onetrust\.com|linktr\.ee|lit\.link|bento\.me|beacons\.ai)$/i;
// LV_HUB_HOSTS (tests): comma list of "host[:port]/path-prefix" treated as link hubs.
const hubPrefixes = () => (process.env.LV_HUB_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const isHubUrl = (url) => {
  try {
    const u = new URL(url);
    return HUB_RE.test(u.hostname) || hubPrefixes().some((p) => `${u.host}${u.pathname}`.toLowerCase().startsWith(p));
  } catch { return false; }
};
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Hostname label that most resembles the account (official domain preferred): mirelo.ai for @MireloAI.
function officialScore(url, user) {
  const h = hostOf(url).split('.').slice(0, -1).join('');
  if (!h) return 0;
  const tokens = [alnum(user.screen_name).replace(/(ai|hq|official|app|labs?)$/, ''), alnum(user.name)].filter((t) => t.length >= 3);
  return tokens.some((t) => h.includes(t) || t.includes(h)) ? 1 : 0;
}

// Pure. html of a link hub -> outbound candidate URLs, official domain first (max 3).
export function extractHubLinks(html, user = {}) {
  const urls = [];
  for (const m of String(html).matchAll(/href=["'](https?:\/\/[^"'\s>]+)["']/gi)) {
    const u = m[1].replace(/&amp;/g, '&');
    if (JUNK_HOST.test(hostOf(u)) || isHubUrl(u) || !classifyUrl(u)) continue;
    if (!urls.some((x) => hostOf(x) === hostOf(u))) urls.push(u); // one link per site: the first (top of the hub) wins
  }
  const ranked = urls.map((u, i) => ({ u, i, o: officialScore(u, user) })).sort((a, b) => b.o - a.o || a.i - b.i);
  const official = ranked.filter((x) => x.o);
  return (official.length ? official : ranked).slice(0, 3).map((x) => x.u);
}

// Pure. fxtwitter user object -> candidate website URLs (website + bio facets), not yet hub-expanded.
export function profileUrls(user) {
  const out = [];
  const add = (u) => { if (u && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u); };
  add(user?.website?.url);
  for (const f of user?.raw_description?.facets || []) if (f.type === 'url') add(f.replacement || f.original);
  return out;
}

/*
 * Returns { status: 'ok'|'none'|'error', urls: [...] }. Never throws.
 * 'error' = network trouble (retry later); 'none' = the profile answered but has no usable site.
 */
export async function fetchProfileSites(handle, log = () => {}) {
  const h = String(handle).replace(/^@/, '');
  try {
    const r = await fetchWithTimeout(`${fxBase()}/${h}`, { headers: { Accept: 'application/json' } });
    if (r.status >= 500) return { status: 'error', urls: [] };
    if (!r.ok) return { status: 'none', urls: [] };
    const user = (await r.json()).user;
    if (!user) return { status: 'none', urls: [] };
    const out = [];
    for (const u of profileUrls(user)) {
      if (isHubUrl(u)) {
        try {
          const hr = await fetchWithTimeout(u, { headers: { 'User-Agent': 'Mozilla/5.0 (link-vault)', Accept: 'text/html' } });
          if (hr.ok) for (const l of extractHubLinks(await hr.text(), user)) if (!out.includes(l)) out.push(l);
        } catch (e) { log(`profile hub ${u}: ${e.message}`); }
      } else if (classifyUrl(u) && !JUNK_HOST.test(hostOf(u)) && !out.includes(u)) out.push(u);
    }
    return { status: out.length ? 'ok' : 'none', urls: out.slice(0, 3) };
  } catch (e) {
    log(`profile ${h}: ${e.message}`);
    return { status: 'error', urls: [] };
  }
}

// ---------- B) Grok X search ----------

const REPLY_HINT = /リプ|リプライ|コメント欄|返信|👇|\bbelow\b|in (?:the )?replies|link in (?:the )?reply|\bcomments?\b/i;
const TOOL_HINT = /ツール|アプリ|サービス|モデル|リリース|公開|発表|オープン(?:ウェイト|ソース)|\bintroducing\b|\blaunch|\bapp\b|\btool\b|\bmodel\b|\bAPI\b|\bSDK\b|open[- ]?(?:source|weights?)|\bbeta\b|\bv\d+(?:\.\d+)?\b/i;

export const xsearchEnabled = () => process.env.LV_XSEARCH !== '0';
// Tests that point fxtwitter at a double must also point LV_GROK_BIN at a fake; otherwise never run the real one.
export const xsearchAllowed = () => xsearchEnabled() && !(process.env.LV_FXTWITTER_BASE && !process.env.LV_GROK_BIN);
const grokBin = () => process.env.LV_GROK_BIN || 'grok-api';
const perRun = () => Number(process.env.LV_XSEARCH_PER_RUN ?? 3);
const cooldownFile = () => process.env.LV_XSEARCH_COOLDOWN_FILE || path.join(HERE, '..', 'logs', 'xsearch-cooldown.json');
export const newXsearchBudget = () => ({ searches: perRun() });

/*
 * posts = ledger posts (role/text/urls), resources = ledger/graph resources with origin. Pure.
 * Returns 'replies' (trigger 1), 'tool' (trigger 2) or null.
 */
export function xsearchTrigger(posts, resources) {
  if (process.env.LV_XSEARCH_FORCE === '1') return 'forced';
  const real = resources.filter((r) => !String(r.origin || '').startsWith('profile:') && r.origin !== 'x_search');
  const selfThread = new Set(posts.filter((p) => p.role === 'self' || p.role === 'self_reply').map((p) => p.sid));
  const inSelfThread = real.some((r) => (r.found_in || []).some((s) => selfThread.has(s)));
  const pointing = posts.filter((p) => p.role === 'self' || p.role === 'parent').some((p) => REPLY_HINT.test(p.text || ''));
  if (pointing && !inSelfThread) return 'replies';
  if (!real.length && posts.some((p) => TOOL_HINT.test(p.text || ''))) return 'tool';
  return null;
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

export function buildXsearchArgs({ handle, sid, publishedAt }) {
  const t = Date.parse(publishedAt) || Date.now();
  const h = String(handle || '').replace(/^@/, '');
  const query = `Replies by other users in the conversation of https://x.com/${h || 'i'}/status/${sid} (conversation_id:${sid}, to:${h}) that contain a link (URL) to the tool, product, repository or model being discussed. List each reply author and the full URLs.`;
  return { query, from: ymd(t - DAY_MS), to: ymd(t + 3 * DAY_MS) };
}

const QUOTA_RE = /spending[- ]?limit|quota|rate[- ]?limit|too many requests|\b429\b|unauthori[sz]ed|\b401\b|\b403\b|forbidden|auth|login|credit|exceeded/i;

function runGrok(args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    execFile(grokBin(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: (stderr || '') + (err && typeof err.code !== 'number' ? String(err.message) : '') });
    });
  });
}

// Pure. Raw grok-api output -> unique http(s) URLs (strings anywhere in the JSON, or the text itself).
export function urlsFromSearchOutput(raw) {
  const out = [];
  const add = (u) => { u = u.replace(/[.,;:!?)\]}>"'、。]+$/, ''); if (!out.includes(u)) out.push(u); };
  const scan = (s) => { for (const m of String(s).matchAll(/https?:\/\/[^\s<>"'\\)\]]+/g)) add(m[0]); };
  try { (function walk(v) { if (typeof v === 'string') scan(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(JSON.parse(raw)); } catch { scan(raw); }
  return out;
}

async function cooldownActive(now) {
  const c = await readJson(cooldownFile(), null);
  return !!c?.until && Date.parse(c.until) > now.getTime();
}
async function setCooldown(reason, now) {
  try {
    await fs.mkdir(path.dirname(cooldownFile()), { recursive: true });
    await fs.writeFile(cooldownFile(), JSON.stringify({ until: new Date(now.getTime() + DAY_MS).toISOString(), reason: String(reason).slice(0, 300), set_at: now.toISOString() }, null, 2) + '\n');
  } catch {}
}

/*
 * One search for one link. Returns { state, urls }.
 * state: 'done' (x-search.json exists or was written) | 'skipped' (disabled/budget/cooldown/retry wait) | 'error' | 'quota'.
 * The raw response is written once ('wx') and never replaced.
 */
export async function searchReplies({ dir, relatedRoot, id, handle, sid, publishedAt, budget, now = new Date(), log = () => {} }) {
  const file = path.join(relatedRoot, 'related', 'x-search.json');
  const attFile = path.join(relatedRoot, 'related', 'x-search-attempts.json');
  const existing = await readJson(file, null);
  if (existing) return { state: 'done', urls: existing.urls || urlsFromSearchOutput(existing.raw || '') };
  if (!xsearchAllowed() || budget.searches <= 0 || (await cooldownActive(now))) return { state: 'skipped', urls: [] };
  const att = await readJson(attFile, { count: 0, last_at: null });
  if (att.count >= 3 && now.getTime() - (Date.parse(att.last_at) || 0) < DAY_MS) return { state: 'skipped', urls: [] };
  const { query, from, to } = buildXsearchArgs({ handle, sid, publishedAt });
  const args = ['search', 'x', '--query', query, '--output', 'json', '--from-date', from, '--to-date', to];
  budget.searches--;
  const r = await runGrok(args);
  const text = `${r.stdout}\n${r.stderr}`;
  const bad = r.code !== 0 || /"error"\s*:/.test(r.stdout.slice(0, 400)) && QUOTA_RE.test(r.stdout);
  if (bad) {
    const quota = QUOTA_RE.test(text);
    log(`xsearch ${id}: ${quota ? 'quota/auth' : 'error'}: ${text.trim().slice(0, 160)}`);
    if (quota) await setCooldown(text.trim(), now);
    await fs.mkdir(path.dirname(attFile), { recursive: true });
    await fs.writeFile(attFile, JSON.stringify({ count: att.count + 1, last_at: now.toISOString(), last_error: text.trim().slice(0, 300) }, null, 2) + '\n');
    return { state: quota ? 'quota' : 'error', urls: [] };
  }
  const urls = urlsFromSearchOutput(r.stdout).filter((u) => classifyUrl(u)).slice(0, 8);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, JSON.stringify({ schema: 1, id, searched_at: now.toISOString(), cmd: [path.basename(grokBin()), ...args], query, from_date: from, to_date: to, urls, raw: r.stdout }, null, 2) + '\n', { flag: 'wx' });
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return { state: 'done', urls };
}

export const hasXsearchFile = (relatedRoot) => fssync.existsSync(path.join(relatedRoot, 'related', 'x-search.json'));
