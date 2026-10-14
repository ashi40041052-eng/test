import fs from 'node:fs/promises';
import path from 'node:path';

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|igshid|mc_\w+|ref_src|ref_url|si)$/i;
const X_SHARE_PARAMS = /^(s|t)$/i; // x.com share links append ?s=20&t=...

// Canonical form used to detect the same link saved twice.
export function normalizeUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return raw.trim(); }
  let host = u.hostname.toLowerCase().replace(/^(www\.|mobile\.|m\.)/, '');
  if (host === 'twitter.com') host = 'x.com';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k) && !(host === 'x.com' && X_SHARE_PARAMS.test(k))).sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? '?' + new URLSearchParams(params).toString() : '';
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  return `${u.protocol}//${host}${pathname}${qs}`;
}

export async function walkJson(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkJson(p));
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) {
    if (fallback !== undefined && (e.code === 'ENOENT' || e instanceof SyntaxError)) return fallback;
    throw e;
  }
}

// Writes atomically (temp file + rename) and only when content changed.
export async function writeIfChanged(file, content) {
  try { if (await fs.readFile(file, 'utf8') === content) return false; } catch {}
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
  return true;
}

export function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';
}
