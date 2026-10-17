// 対応済み/未対応 marks: one file per link, marks/<id>.json = {status:'done'|'todo', at, by?:'ai'|'human', note?}.
// A missing file means todo. Shared by the dashboard server (POST /api/mark) and the mark.mjs CLI.
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeUrl, readJson, walkJson, writeIfChanged } from './util.mjs';

export const STATUSES = ['done', 'todo'];
export const ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/; // no dots or slashes: cannot escape marks/

// ids of every saved link: index.json known_ids/items plus links/**/<id>.json (new links the index does not list yet)
export async function knownIds(dataDir) {
  const ids = new Set();
  const idx = await readJson(path.join(dataDir, 'index.json'), null);
  for (const i of idx?.known_ids || []) ids.add(i);
  for (const it of idx?.items || []) ids.add(it.id);
  for (const f of await walkJson(path.join(dataDir, 'links'))) ids.add(path.basename(f, '.json'));
  return ids;
}

// id or URL -> id (throws when unknown). A URL matches the link with the same normalized URL (newest wins).
export async function resolveTarget(dataDir, arg) {
  const s = String(arg || '').trim();
  const ids = await knownIds(dataDir);
  if (ids.has(s)) return s;
  if (/^https?:\/\//i.test(s)) {
    const want = normalizeUrl(s);
    const hits = [];
    for (const f of await walkJson(path.join(dataDir, 'links'))) {
      const r = await readJson(f, null);
      if (r?.url && normalizeUrl(r.url) === want) hits.push(path.basename(f, '.json'));
    }
    if (hits.length) {
      // a duplicate is merged under the earliest link in index.json; prefer an id the index shows
      hits.sort();
      return hits[0];
    }
  }
  throw new Error(`unknown link: ${s}`);
}

export async function writeMark(dataDir, id, status, { by = 'human', note } = {}) {
  if (!ID_RE.test(String(id))) throw new Error('bad id');
  if (!STATUSES.includes(status)) throw new Error('bad status');
  if (!(await knownIds(dataDir)).has(id)) throw new Error('unknown id');
  const m = { status, at: new Date().toISOString(), by: by === 'ai' ? 'ai' : 'human' };
  if (note) m.note = String(note).slice(0, 500);
  await writeIfChanged(path.join(dataDir, 'marks', `${id}.json`), JSON.stringify(m, null, 1) + '\n');
  return m;
}

// {id: {status, at, by, note}} for every valid marks/*.json
export async function readMarks(dataDir) {
  const out = {};
  let names = [];
  try { names = await fs.readdir(path.join(dataDir, 'marks')); } catch {}
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    const x = await readJson(path.join(dataDir, 'marks', n), null);
    if (ID_RE.test(id) && x && STATUSES.includes(x.status)) out[id] = x;
  }
  return out;
}
