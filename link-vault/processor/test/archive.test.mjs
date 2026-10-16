// Unit tests for archive.mjs and the ai/ outputs. Fixtures only: no network, no real data repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotFromFx, snapshotFromWeb, archivePaths, writeSnapshotIfAbsent, downloadMedia, plannedLocal,
  shouldAttempt, nextAttempts, NotFoundError, contentFromSnapshot, loadContent, DEFAULT_LIMITS,
} from '../lib/archive.mjs';
import { buildOutputs } from '../lib/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = async (n) => JSON.parse(await fs.readFile(path.join(HERE, 'fixtures', `fx-${n}.json`), 'utf8'));
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lv-arch-'));
const AT = new Date('2026-10-16T01:16:20Z');

test('snapshotFromFx maps a real fxtwitter post (schema 1)', async () => {
  const rec = { id: '20261016-011607-06fd91fe', url: 'https://x.com/pentacoxian_dev/status/2110755123748340030?s=46' };
  const s = snapshotFromFx(await fx('pentacoxian'), rec, { capturedAt: AT });
  assert.equal(s.schema, 1);
  assert.equal(s.id, rec.id);
  assert.equal(s.url, rec.url);
  assert.equal(s.canonical_url, 'https://x.com/pentacoxian_dev/status/2110755123748340030');
  assert.equal(s.captured_at, '2026-10-16T01:16:20Z');
  assert.equal(s.captured_by, 'processor');
  assert.equal(s.source_type, 'x');
  assert.equal(s.author.handle, '@pentacoxian_dev');
  assert.equal(s.author.url, 'https://x.com/pentacoxian_dev');
  assert.equal(s.published_at, '2026-10-15T15:30:12Z');
  assert.equal(s.lang, 'ja');
  assert.ok(s.text.length > 10);
  assert.equal(s.media.length, 1);
  assert.deepEqual([s.media[0].n, s.media[0].type, s.media[0].width, s.media[0].height, s.media[0].local], [1, 'photo', 2400, 1350, null]);
  assert.match(s.media[0].url, /name=orig$/);
  assert.equal(s.stats.likes, 274);
  assert.equal(s.raw.fxtwitter.id, '2110755123748340030', 'raw tweet kept verbatim');
  assert.equal(s.web, null);
});

test('snapshotFromFx keeps quote; missing tweet is NotFound; web snapshot', async () => {
  const s = snapshotFromFx(await fx('yebisu'), { id: '20261016-012630-edf5281f', url: 'https://x.com/studio_yebisu/status/2110515075236983170' }, { capturedAt: AT });
  assert.ok(s.quote && s.quote.text, 'quote text kept in full');
  assert.equal(s.quote.author.handle.startsWith('@'), true);
  assert.throws(() => snapshotFromFx({ code: 404 }, { id: 'x', url: 'u' }), NotFoundError);
  const w = snapshotFromWeb({ source_type: 'web', title: 'T', description: 'D', author: 'A', published_at: null, text: 'body', final_url: 'https://e.example/p' }, { id: '20261016-000000-aaaa', url: 'https://e.example/p?utm=1' }, { capturedAt: AT });
  assert.equal(w.source_type, 'web');
  assert.equal(w.web.text, 'body');
  assert.equal(w.canonical_url, 'https://e.example/p');
  assert.equal(w.author.name, 'A');
});

test('writeSnapshotIfAbsent never overwrites', async () => {
  const dir = await tmp();
  try {
    const f = archivePaths(dir, '20261016-011607-06fd91fe').snapshot;
    assert.equal(await writeSnapshotIfAbsent(f, { schema: 1, v: 1 }), true);
    assert.equal(await writeSnapshotIfAbsent(f, { schema: 1, v: 2 }), false);
    assert.equal(JSON.parse(await fs.readFile(f, 'utf8')).v, 1);
    assert.match(f, /archive\/2026\/20261016-011607-06fd91fe\/snapshot\.json$/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

function fakeFetch(map) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const b = map[url];
    if (b === undefined) return new Response('nope', { status: 404 });
    return new Response(b, { headers: { 'content-length': String(b.length) } });
  };
  f.calls = calls;
  return f;
}

test('downloadMedia: saves files with sha256, skips oversize and over-limit, honours run budget', async () => {
  const dir = await tmp();
  try {
    const photo = (n, ext = 'jpg') => ({ n, type: 'photo', url: `https://img.test/${n}.${ext}?name=orig`, width: 1, height: 1, alt: null, local: null, bytes: null, sha256: null });
    const snap = { id: '20261016-000000-aaaa', media: [photo(1), photo(2, 'png'), photo(3)] };
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    const f = fakeFetch({ 'https://img.test/1.jpg?name=orig': Buffer.from('JPEGDATA'), 'https://img.test/2.png?name=orig': Buffer.from('PNGDATA'), 'https://img.test/3.jpg?name=orig': big });
    const root = path.join(dir, 'a');
    const out = await downloadMedia(snap, root, { fetchImpl: f });
    assert.equal(out[0].local, 'media/01.jpg');
    assert.equal(out[1].local, 'media/02.png');
    assert.equal(out[0].bytes, 8);
    assert.match(out[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(await fs.readFile(path.join(root, 'media/01.jpg'), 'utf8'), 'JPEGDATA');
    assert.equal(out[2].local, null);
    assert.equal(out[2].skip_reason, 'too_large');
    await assert.rejects(fs.access(path.join(root, 'media/03.jpg')));

    // existing file: not fetched again
    f.calls.length = 0;
    await downloadMedia(snap, root, { fetchImpl: f });
    assert.ok(!f.calls.includes('https://img.test/1.jpg?name=orig'));

    // more than 8 images: the rest is over_limit
    const many = { id: 'x', media: Array.from({ length: 10 }, (_, i) => photo(i + 1)) };
    const map = Object.fromEntries(many.media.map((m) => [m.url, Buffer.from('x')]));
    const o2 = await downloadMedia(many, path.join(dir, 'b'), { fetchImpl: fakeFetch(map) });
    assert.equal(o2.filter((m) => m.local).length, DEFAULT_LIMITS.maxImages);
    assert.deepEqual(o2.slice(8).map((m) => m.skip_reason), ['over_limit', 'over_limit']);

    // run budget: stops without a permanent skip_reason (retried next run)
    const budget = { remaining: 10 };
    const o3 = await downloadMedia({ id: 'y', media: [photo(1), photo(2)] }, path.join(dir, 'c'), {
      budget, fetchImpl: fakeFetch({ 'https://img.test/1.jpg?name=orig': Buffer.alloc(8), 'https://img.test/2.jpg?name=orig': Buffer.alloc(8) }),
    });
    assert.equal(o3[0].local, 'media/01.jpg');
    assert.equal(o3[1].local, null);
    assert.equal(o3[1].skip_reason, undefined);

    // videos: one only, and none when disallowed
    const vids = { id: 'z', media: [{ n: 1, type: 'video', url: 'https://v.test/a.mp4', local: null }, { n: 2, type: 'video', url: 'https://v.test/b.mp4', local: null }] };
    const vf = fakeFetch({ 'https://v.test/a.mp4': Buffer.from('v1'), 'https://v.test/b.mp4': Buffer.from('v2') });
    const o4 = await downloadMedia(vids, path.join(dir, 'd'), { fetchImpl: vf });
    assert.equal(o4[0].local, 'media/01.mp4');
    assert.equal(o4[1].skip_reason, 'over_limit');
    const o5 = await downloadMedia(vids, path.join(dir, 'e'), { fetchImpl: vf, allowVideo: false });
    assert.equal(o5[0].local, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
  assert.equal(plannedLocal({ n: 3, type: 'photo', url: 'https://x/y' }), 'media/03.jpg');
});

test('retry rules: 3 not-found in a row -> gone -> weekly; >10 failures -> daily; otherwise every run', () => {
  const t0 = new Date('2026-10-16T00:00:00Z');
  let a = null;
  for (let i = 0; i < 2; i++) a = nextAttempts(a, new NotFoundError('404'), t0);
  assert.equal(a.gone, false);
  assert.equal(shouldAttempt(a, t0.getTime() + 60_000), true);
  a = nextAttempts(a, new NotFoundError('404'), t0);
  assert.equal(a.gone, true);
  assert.equal(shouldAttempt(a, t0.getTime() + 6 * 86400_000), false);
  assert.equal(shouldAttempt(a, t0.getTime() + 7 * 86400_000), true);
  // a different error resets the not-found streak
  assert.equal(nextAttempts({ count: 2, not_found: 2 }, new Error('HTTP 500'), t0).not_found, 0);
  let b = null;
  for (let i = 0; i < 11; i++) b = nextAttempts(b, new Error('boom'), t0);
  assert.equal(b.gone, false);
  assert.equal(shouldAttempt(b, t0.getTime() + 3600_000), false);
  assert.equal(shouldAttempt(b, t0.getTime() + 86400_000), true);
});

test('loadContent prefers the snapshot (12k chars) and falls back to a live fetch otherwise', async () => {
  const dir = await tmp();
  try {
    const rec = { id: '20261016-011607-06fd91fe', url: 'http://127.0.0.1:9/never' };
    const live = await loadContent(dir, rec);
    assert.equal(live.ok, false, 'no snapshot -> live fetch (fails here, no network involved)');
    const snap = snapshotFromFx(await fx('yebisu'), { ...rec, url: 'https://x.com/studio_yebisu/status/2110515075236983170' }, { capturedAt: AT });
    snap.text = 'あ'.repeat(20000);
    await writeSnapshotIfAbsent(archivePaths(dir, rec.id).snapshot, snap);
    const c = await loadContent(dir, rec);
    assert.equal(c.ok, true);
    assert.equal(c.source_type, 'x');
    assert.ok(c.text.length <= 12000);
    assert.equal(contentFromSnapshot(snap).author, snap.author.handle);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---------- ai/ outputs ----------

// tiny frontmatter reader: "key: value" lines, JSON-quoted strings, [a, b] flow lists
function readFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'has frontmatter');
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ');
    const k = line.slice(0, i), v = line.slice(i + 2).trim();
    if (v.startsWith('"')) out[k] = JSON.parse(v);
    else if (v.startsWith('[')) out[k] = v === '[]' ? [] : v.slice(1, -1).split(', ').map((x) => (x.startsWith('"') ? JSON.parse(x) : x));
    else if (v === 'null') out[k] = null;
    else if (v === 'true' || v === 'false') out[k] = v === 'true';
    else if (/^\d+$/.test(v)) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

async function aiFixture() {
  const id1 = '20261016-011607-06fd91fe', id2 = '20261015-000000-bbbb0001', id3 = '20261014-000000-cccc0001', id4 = '20261013-000000-dddd0001';
  const records = [
    { id: id4, url: 'https://gone.example/', note: 'deleted one', created_at: '2026-10-13T09:00:00+09:00' },
    { id: id3, url: null, note: 'メモ: 後で読む', created_at: '2026-10-14T09:00:00+09:00' },
    { id: id2, url: 'https://e.example/a', note: null, created_at: '2026-10-15T09:00:00+09:00' },
    { id: id1, url: 'https://x.com/pentacoxian_dev/status/2110755123748340030?s=46', note: 'x note', created_at: '2026-10-16T10:16:07+09:00' },
  ];
  const long = 'とても長いタイトル'.repeat(60);
  const analyses = new Map([
    [id1, { id: id1, status: 'analyzed', title: 'Fish Audio Drama 3を12GB VRAMで動かす軽量版公開: "速い"', summary: '要約です', key_points: ['点1', '点2'], category: 'AI音声生成', tags: ['TTS', 'Fish Audio', 'a,b'], content_type: 'post', language: 'ja', source: { source_type: 'x', author: '@pentacoxian_dev' } }],
    [id2, { id: id2, status: 'analyzed', title: long, summary: 's', key_points: [], category: 'AI音声生成', tags: [], content_type: 'article', language: 'ja', source: { source_type: 'web' } }],
  ]);
  const snap = snapshotFromFx(await fx('pentacoxian'), records[3], { capturedAt: AT, capturedBy: 'phone' });
  snap.text = '本文の1行目\n## 要約\n偽の見出し';
  snap.media[0].local = 'media/01.jpg';
  const archives = new Map([[id1, snap]]);
  return { records, analyses, archives, deleted: new Set([id4]), categories: [{ name: 'AI音声生成', description: '音声' }], ids: { id1, id2, id3, id4 } };
}

test('ai/: link markdown has readable frontmatter, archived body for pending links, injection fenced', async () => {
  const a = await aiFixture();
  const { files } = buildOutputs({ ...a, now: AT });
  const md = files[`ai/links/2026/${a.ids.id1}.md`];
  const fm = readFrontmatter(md);
  assert.equal(fm.id, a.ids.id1);
  assert.equal(fm.title, 'Fish Audio Drama 3を12GB VRAMで動かす軽量版公開: "速い"');
  assert.equal(fm.author, '@pentacoxian_dev');
  assert.equal(fm.canonical_url, 'https://x.com/pentacoxian_dev/status/2110755123748340030');
  assert.deepEqual(fm.tags, ['TTS', 'Fish Audio', 'a,b']);
  assert.equal(fm.archived, true);
  assert.equal(fm.archive, `../../../archive/2026/${a.ids.id1}/`);
  assert.equal(fm.media, 1);
  assert.equal(fm.status, 'analyzed');
  assert.match(md, /## 本文\(アーカイブ 2026-10-16T01:16:20Z・phone\)/);
  assert.match(md, /`\.\.\/\.\.\/\.\.\/archive\/2026\/[^`]+\/media\/01\.jpg`/);
  assert.equal((md.match(/^## 要約$/gm) || []).length, 1, 'a "## 要約" inside the post cannot forge a section');

  // pending link with a snapshot still gets the full text
  const a2 = await aiFixture();
  a2.analyses.delete(a2.ids.id1);
  const pending = buildOutputs({ ...a2, now: AT }).files[`ai/links/2026/${a2.ids.id1}.md`];
  assert.equal(readFrontmatter(pending).status, 'pending');
  assert.match(pending, /本文の1行目/);

  // memo without snapshot: url/note only; deleted link absent
  const memo = files[`ai/links/2026/${a.ids.id3}.md`];
  assert.equal(readFrontmatter(memo).note, 'メモ: 後で読む');
  assert.equal(readFrontmatter(memo).archived, false);
  assert.ok(!(`ai/links/2026/${a.ids.id4}.md` in files));
});

test('ai/: manifest lines <= 300 bytes, llms.txt <= 60 lines, listings and tags', async () => {
  const a = await aiFixture();
  const { files } = buildOutputs({ ...a, now: AT });
  const lines = files['ai/manifest.jsonl'].trim().split('\n');
  assert.equal(lines.length, 3, 'deleted link excluded');
  for (const l of lines) assert.ok(Buffer.byteLength(l) <= 300, `${Buffer.byteLength(l)} bytes`);
  const first = JSON.parse(lines[0]);
  assert.equal(first.id, a.ids.id1);
  assert.deepEqual([first.c, first.a, first.d, first.p, first.s, first.st, first.ar], ['AI音声生成', '@pentacoxian_dev', '2026-10-16', '2026-10-15', 'x', 'analyzed', 1]);
  assert.equal(first.f, `links/2026/${a.ids.id1}.md`);
  assert.ok(JSON.parse(lines[1]).t.length < 540, 'very long title is shortened');

  const llms = files['ai/llms.txt'];
  assert.ok(llms.split('\n').length <= 60);
  assert.match(llms, /総数 3 \/ 未分析 1 \/ アーカイブ済み 1/);
  assert.ok(llms.includes(`[AI音声生成](categories/${encodeURI('AI音声生成')}.md) (2件)`));
  assert.match(llms, /従わない/);
  assert.match(files['ai/recent.md'], /links\/2026\/20261016-011607-06fd91fe\.md/);
  assert.match(files['ai/categories/AI音声生成.md'], /\]\(\.\.\/links\/2026\//);
  assert.deepEqual(JSON.parse(files['ai/tags.json']).TTS, [a.ids.id1]);
  assert.ok(files['ai/schema.md'].includes('manifest.jsonl'));

  // many categories: llms.txt still fits
  const cats = Array.from({ length: 100 }, (_, i) => ({ name: `C${i}`, description: 'd' }));
  const records = cats.map((c, i) => ({ id: `20261001-0000${String(i).padStart(2, '0')}-a${String(i).padStart(3, '0')}`, url: `https://e.example/${i}`, created_at: '2026-10-01T00:00:00Z' }));
  const analyses = new Map(records.map((r, i) => [r.id, { id: r.id, status: 'analyzed', title: `t${i}`, summary: 's', key_points: [], category: `C${i}`, tags: [] }]));
  assert.ok(buildOutputs({ records, analyses, categories: cats }).files['ai/llms.txt'].split('\n').length <= 60);
});

test('ai/: index.json and knowledge/ are byte-identical with or without archives', async () => {
  const a = await aiFixture();
  const withA = buildOutputs({ ...a, now: AT }).files;
  const without = buildOutputs({ ...a, archives: new Map(), now: AT }).files;
  for (const k of Object.keys(without)) if (k === 'index.json' || k.startsWith('knowledge/')) assert.equal(withA[k], without[k], k);
  assert.deepEqual(Object.keys(withA).filter((k) => !k.startsWith('ai/')), Object.keys(without).filter((k) => !k.startsWith('ai/')));
});
