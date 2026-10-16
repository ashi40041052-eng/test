/*
 * Other people's replies on X, read with the user's OWN logged-in session in a real (headless) Chromium
 * (DESIGN-v3.md addendum "v3.2"). Replaces Grok X search as the default replies source.
 * The browser is behind a tiny driver interface so tests never start one:
 *   driver.loadThread(url, { maxScrolls, delay }) -> { finalUrl, snapshots: [html, ...] }   (page HTML after load / each scroll)
 * Credentials and cookie values are never read, logged or stored (only the cookie *name* auth_token is checked in x-login.mjs).
 * Env: LV_XREPLIES (0 off / 1 on; default on when the profile dir exists), LV_X_PROFILE (~/.link-vault/x-profile),
 *      LV_XREPLIES_PER_RUN (4), LV_XREPLIES_LOGIN_FILE, LV_XREPLIES_LOCK_FILE.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './util.mjs';
import { classifyUrl } from './related.mjs';
import { xsearchTrigger } from './related-extra.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 3600 * 1000;
export const MAX_REPLIES = 30;
export const MAX_URLS = 8;
const MAX_ATTEMPTS = 3;

export const profileDir = () => process.env.LV_X_PROFILE || path.join(os.homedir(), '.link-vault', 'x-profile');
const loginFile = () => process.env.LV_XREPLIES_LOGIN_FILE || path.join(HERE, '..', 'logs', 'x-login-required.json');
const lockFile = () => process.env.LV_XREPLIES_LOCK_FILE || path.join(HERE, '..', 'logs', 'x-browser.lock');
export const perRun = () => Number(process.env.LV_XREPLIES_PER_RUN ?? 4);

let driver = null; // tests inject one; production lazily builds the playwright driver
export const setXrepliesDriver = (d) => { driver = d; };
let resolver = null; // t.co -> final url (HEAD, no browser); injectable
export const setXrepliesResolver = (f) => { resolver = f; };

export function xrepliesEnabled() {
  if (process.env.LV_XREPLIES === '0') return false;
  if (driver) return process.env.LV_XREPLIES !== '0';
  // hermetic: a test double for fxtwitter without an injected driver must never reach a real browser
  if (process.env.LV_FXTWITTER_BASE) return false;
  if (process.env.LV_XREPLIES === '1') return true;
  return fssync.existsSync(profileDir());
}

// ---------- pure extraction (fixture-tested) ----------

const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
const stripTags = (s) => decode(s.replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, '$1').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i')); return m ? decode(m[1]) : null; };

export function detectLoginWall(html, finalUrl = '') {
  if (/\/(?:i\/flow\/)?login(?:[/?#]|$)/i.test(String(finalUrl))) return true;
  return /data-testid="(?:loginButton|signupButton|login)"/i.test(html) || /data-testid="sheetDialog"[\s\S]{0,400}(?:Sign in|ログイン)/i.test(html);
}

const articlesOf = (html) => {
  const out = [];
  for (const m of html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)) out.push(m[1]);
  return out;
};

// One <article> -> { sid, handle, name, text, time, permalink, links:[{href,text,title}] } or null
export function parseArticle(inner) {
  const st = inner.match(/<a\b[^>]*href="\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:[/?#][^"]*)?"[^>]*>\s*<time\b([^>]*)>/i);
  if (!st) return null;
  const time = attr(`<x ${st[3]}`, 'datetime');
  const userBlock = (inner.match(/data-testid="User-Name"[^>]*>([\s\S]*?)(?=<time\b|data-testid="tweetText"|$)/i) || [])[1] || '';
  const spans = [...userBlock.matchAll(/<span\b[^>]*>([^<]+)<\/span>/g)].map((x) => decode(x[1]).trim()).filter(Boolean);
  const name = spans.find((s) => !s.startsWith('@') && s !== '·') || st[1];
  const tm = inner.match(/data-testid="tweetText"[^>]*>([\s\S]*?)<\/div>/i);
  const textHtml = tm ? tm[1] : '';
  const links = [];
  for (const a of textHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(a[1], 'href');
    if (!href || !/^https?:\/\//i.test(href)) continue;
    links.push({ href, text: stripTags(a[2]).trim(), title: attr(a[1], 'title') });
  }
  // card links (link previews) outside the text
  for (const a of inner.matchAll(/<a\b([^>]*\bhref="(https?:\/\/t\.co\/[^"]+)"[^>]*)>/gi)) {
    if (!links.some((l) => l.href === decode(a[2]))) links.push({ href: decode(a[2]), text: '', title: attr(a[1], 'title') });
  }
  return { sid: st[2], handle: `@${st[1]}`, name, text: stripTags(textHtml).trim(), time, permalink: `https://x.com/${st[1]}/status/${st[2]}`, links };
}

// href/text/title -> candidate absolute url ('' when only a t.co that still needs a HEAD)
export function visibleLinkUrl(l) {
  const c = [l.title, l.text].map((s) => String(s || '').replace(/[…\s]+$/g, '').trim());
  for (const s of c) {
    if (/^https?:\/\//i.test(s) && !/^https?:\/\/t\.co\//i.test(s) && !/…|\.\.\.$/.test(s)) return s;
  }
  if (!/^https?:\/\/t\.co\//i.test(l.href)) return l.href;
  return '';
}

// snapshots -> { main:{sid,handle,name}|null, replies:[parsed...] } (deduped, document order, main post excluded)
export function parseThread(snapshots, sid) {
  const seen = new Map();
  for (const html of snapshots) for (const inner of articlesOf(html)) {
    const a = parseArticle(inner);
    if (a && !seen.has(a.sid)) seen.set(a.sid, a);
  }
  const main = seen.get(String(sid)) || null;
  const replies = [...seen.values()].filter((a) => a.sid !== String(sid));
  return { main, replies };
}

async function headResolve(url) {
  if (resolver) return resolver(url);
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return r.headers.get('location') || '';
  } catch { return ''; }
}

export async function resolveLinks(links) {
  const out = [];
  for (const l of links) {
    let u = visibleLinkUrl(l);
    if (!u) u = await headResolve(l.href);
    if (u && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

// ---------- login-required notice (written once; no retry storm) ----------

export const loginRequired = () => fssync.existsSync(loginFile());
async function noteLoginRequired(now, log) {
  try {
    await fs.mkdir(path.dirname(loginFile()), { recursive: true });
    await fs.writeFile(loginFile(), JSON.stringify({ at: now.toISOString(), message: 'X にログインが必要です。ターミナルで `npm run x-login` を実行してログインしてください(完了すると自動で再開します)。' }, null, 2) + '\n', { flag: 'wx' });
    log('x-replies: login required (wrote logs/x-login-required.json; run `npm run x-login`)');
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

// ---------- one-browser-at-a-time lock ----------

async function withLock(fn) {
  const f = lockFile();
  await fs.mkdir(path.dirname(f), { recursive: true });
  try {
    const st = fssync.statSync(f);
    if (Date.now() - st.mtimeMs > 15 * 60 * 1000) fssync.unlinkSync(f); // stale
  } catch {}
  let fh;
  try { fh = await fs.open(f, 'wx'); } catch (e) { if (e.code === 'EEXIST') return { busy: true }; throw e; }
  try { await fh.write(String(process.pid)); await fh.close(); return { value: await fn() }; }
  finally { try { fssync.unlinkSync(f); } catch {} }
}

// ---------- trigger ----------

/*
 * Same rules as the Grok x_search triggers ('replies' | 'tool'), plus 'recent': saved within 7 days and the
 * primary subject is not a resource. Pure.
 */
export function xrepliesTrigger(posts, resources, { primary, savedAt, now = new Date() } = {}) {
  const t = xsearchTriggerNoForce(posts, resources);
  if (t) return t;
  const saved = Date.parse(savedAt || '');
  if (saved && now.getTime() - saved <= 7 * DAY_MS && primary?.kind !== 'resource') return 'recent';
  return null;
}
function xsearchTriggerNoForce(posts, resources) {
  const prev = process.env.LV_XSEARCH_FORCE;
  delete process.env.LV_XSEARCH_FORCE;
  try { return xsearchTrigger(posts, resources); } finally { if (prev !== undefined) process.env.LV_XSEARCH_FORCE = prev; }
}

// ---------- capture ----------

/*
 * -> { status: 'done'|'skipped'|'login_required'|'error', urls: [{url, own}] }
 * Archive file (create-only): <archive>/<y>/<id>/related/x-replies.json
 *   { schema:1, id, status_url, sid, captured_at, main:{handle,name}|null, truncated:bool,
 *     replies:[{ n, handle, name, text, time, permalink, own:bool, links:[url] }],   // max 30, other people's replies + the author's own
 *     urls:[{ url, own }] }                                                           // unique outbound links, own = author's own reply
 */
export async function captureXReplies({ relatedRoot, id, statusUrl, sid, budget, now = new Date(), log = () => {} }) {
  const file = path.join(relatedRoot, 'related', 'x-replies.json');
  const attFile = path.join(relatedRoot, 'related', 'x-replies-attempts.json');
  const existing = await readJson(file, null);
  if (existing) return { status: 'done', urls: existing.urls || [] };
  if (!xrepliesEnabled() || loginRequired() || (budget && budget.xreplies <= 0)) return { status: 'skipped', urls: [] };
  const att = await readJson(attFile, { count: 0, last_at: null });
  if (att.count >= MAX_ATTEMPTS) return { status: 'skipped', urls: [] };
  let drv = driver;
  if (!drv) {
    try { drv = await (await import('./x-browser.mjs')).playwrightDriver(profileDir()); }
    catch (e) { log(`x-replies: playwright unavailable, skipped (${String(e.message).slice(0, 80)})`); return { status: 'skipped', urls: [] }; }
  }
  if (budget) budget.xreplies--;
  try {
    const locked = await withLock(async () => {
      const delay = () => new Promise((r) => setTimeout(r, process.env.LV_XREPLIES_FAST === '1' ? 0 : 1500 + Math.random() * 2500));
      return drv.loadThread(statusUrl, { maxScrolls: 3, delay });
    });
    if (locked.busy) { if (budget) budget.xreplies++; return { status: 'skipped', urls: [] }; }
    const page = locked.value;
    const all = page.snapshots.join('\n');
    if (detectLoginWall(all, page.finalUrl)) { await noteLoginRequired(now, log); return { status: 'login_required', urls: [] }; }
    const { main, replies } = parseThread(page.snapshots, sid);
    const mainHandle = (main?.handle || '').toLowerCase();
    const picked = replies.slice(0, MAX_REPLIES);
    const out = [];
    const urls = [];
    for (const [i, r] of picked.entries()) {
      const own = !!mainHandle && r.handle.toLowerCase() === mainHandle;
      const links = await resolveLinks(r.links);
      out.push({ n: i + 1, handle: r.handle, name: r.name, text: r.text, time: r.time, permalink: r.permalink, own, links });
      for (const u of links) {
        if (!classifyUrl(u)) continue;
        const prev = urls.find((x) => x.url === u);
        if (prev) prev.own = prev.own || own; else urls.push({ url: u, own });
      }
    }
    urls.sort((a, b) => Number(b.own) - Number(a.own));
    const doc = { schema: 1, id, status_url: statusUrl, sid: String(sid), captured_at: now.toISOString(), main: main ? { handle: main.handle, name: main.name } : null, truncated: replies.length > MAX_REPLIES, replies: out, urls: urls.slice(0, MAX_URLS) };
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return { status: 'done', urls: doc.urls };
  } catch (e) {
    log(`x-replies ${id}: ${String(e.message).slice(0, 160)}`);
    await fs.mkdir(path.dirname(attFile), { recursive: true });
    await fs.writeFile(attFile, JSON.stringify({ count: att.count + 1, last_at: now.toISOString(), last_error: String(e.message).slice(0, 300) }, null, 2) + '\n');
    return { status: 'error', urls: [] };
  }
}
