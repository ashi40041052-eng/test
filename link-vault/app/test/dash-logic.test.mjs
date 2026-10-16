import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// dash-logic.js is a classic browser script: importing it registers globalThis.DashLogic.
await import('../dash-logic.js');
const DL = globalThis.DashLogic;
const idx = JSON.parse(fs.readFileSync(new URL('../fixtures/mock/index.json', import.meta.url)));
const man = DL.parseManifest(fs.readFileSync(new URL('../fixtures/mock/ai/manifest.jsonl', import.meta.url), 'utf8'));
const del = (id, it) => !!it.deleted;
const NOW = new Date('2026-10-16T03:00:00Z').getTime();

test('hash roundtrip', () => {
  const h = DL.buildHash({ id: 'a b', cat: 'AI音声生成', q: 'x y' });
  assert.deepEqual(DL.parseHash(h), { id: 'a b', cat: 'AI音声生成', q: 'x y' });
  assert.equal(DL.buildHash({}), '');
});
test('filters: trash, category, AND search, period, state', () => {
  const f = (o) => DL.filterItems(idx.items, o, del, (id) => man.get(id), NOW);
  assert.equal(f({}).length, 7);
  assert.equal(f({ trash: '1' }).length, 1);
  assert.equal(f({ cat: 'AI音声生成' }).length, 2);
  assert.equal(f({ q: 'drama3 vram' }).length, 1);
  assert.equal(f({ q: 'tts nonexistent' }).length, 0);
  assert.equal(f({ q: 'fishaudio' }).length, 2); // meta.pu + primary_subject.name
  assert.equal(f({ q: 'repository' }).length, 1); // resource_kind
  assert.equal(f({ per: '7' }).length, 6);
  assert.equal(f({ st: 'pending' }).length, 1);
  assert.equal(f({ st: 'archived' }).length, 4);
});
test('facets, step, firstLocalMedia', () => {
  const fc = DL.facets(idx.items.filter((i) => !i.deleted));
  assert.equal(fc.cats[0].count >= fc.cats[1].count, true);
  assert.equal(DL.step([], 'x', 1), -1);
  const l = [{ id: 'a' }, { id: 'b' }];
  assert.equal(DL.step(l, 'a', 1), 1);
  assert.equal(DL.step(l, 'b', 1), 1);
  assert.equal(DL.step(l, null, 1), 0);
  assert.equal(DL.firstLocalMedia({ media: [{ type: 'video', local: 'media/01.mp4' }, { type: 'photo', local: 'media/02.jpg' }] }), 'media/02.jpg');
  assert.equal(DL.firstLocalMedia(null), null);
});

test('relatedView: thread order, nested quote, primary, pk', () => {
  const rel = {
    posts: [
      { sid: 's', role: 'self', depth: 0, quote_sid: 'q', author: '@a', text: 'x' },
      { sid: 'p2', role: 'parent', depth: 2, author: '@g', text: 'g' },
      { sid: 'p1', role: 'parent', depth: 1, author: '@p', text: 'p' },
      { sid: 'r2', role: 'self_reply', depth: 2, author: '@a', text: 'r2' },
      { sid: 'r1', role: 'self_reply', depth: 1, author: '@a', text: 'r1' },
      { sid: 'q', role: 'quote', of: 's', author: '@q', text: 'quoted' },
    ],
    resources: [{ n: 1, url: 'https://github.com/o/r', type: 'github', found_in: ['r1'] }, { n: 2, url: 'https://x.org/', type: 'web', found_in: ['q'] }],
    primary: { kind: 'resource', n: 1 },
  };
  const v = DL.relatedView(rel);
  assert.deepEqual(v.thread.map((p) => p.sid), ['p2', 'p1', 's', 'r1', 'r2']);
  assert.equal(v.thread[2].quote.sid, 'q');
  assert.equal(v.thread[2].resources[0].n, 2); // resource found in the quote attaches to the quoting post
  assert.equal(v.thread[3].resources[0].n, 1);
  assert.equal(v.primary.resource.n, 1);
  assert.equal(v.pk, 'r');
  // AI primary wins
  assert.equal(DL.relatedView(rel, { url: 'https://x.org/' }).pk, 's');
  // self primary / empty
  assert.equal(DL.relatedView({ ...rel, primary: { kind: 'self' } }).pk, '-');
  assert.equal(DL.relatedView(null), null);
  assert.equal(DL.relatedView({ posts: [] }), null);
});

test('subject filter + facets + labels', () => {
  const items = [{ id: 'a', category: 'c' }, { id: 'b', category: 'c' }, { id: 'c' }];
  const meta = { a: { pk: 'r' }, b: { pk: 'm' } };
  const mo = (id) => meta[id];
  assert.deepEqual(DL.filterItems(items, { sub: 'r' }, () => false, mo, 0).map((x) => x.id), ['a']);
  assert.deepEqual(DL.filterItems(items, { sub: '' }, () => false, mo, 0).length, 3);
  assert.deepEqual(DL.facets(items, mo).subs.map((s) => s.key).sort(), ['-', 'm', 'r']);
  assert.equal(DL.facets(items, mo).subs.reduce((n, s) => n + s.count, 0), items.length); // sums to the total
  assert.equal(DL.pkInfo('-')[1], 'なし');
  assert.deepEqual(DL.filterItems(items, { sub: '-' }, () => false, mo, 0).map((x) => x.id), ['c']);
  assert.equal(DL.subjectLabel('https://github.com/BuilderIO/agent-native/tree/main'), 'BuilderIO/agent-native');
  assert.equal(DL.subjectLabel('https://huggingface.co/datasets/o/d'), 'o/d');
  assert.equal(DL.parseHash(DL.buildHash({ sub: 'r' })).sub, 'r');
});

test('relatedView: other people\'s replies get the resource chips they link to', () => {
  const rel = {
    posts: [{ sid: 's', role: 'self', depth: 0, author: '@a', text: 'x' }],
    resources: [{ n: 1, url: 'https://github.com/o/r', type: 'github', key: 'o/r', found_in: [], origin: 'x_replies' }, { n: 2, url: 'https://x.org/', type: 'web', found_in: [] }],
    primary: { kind: 'resource', n: 1 },
  };
  const doc = { replies: [
    { n: 1, handle: '@bob', text: 'try this', own: false, links: ['https://www.github.com/o/r/'] },
    { n: 2, handle: '@eve', text: 'no link', own: false, links: [] },
    { n: 3, handle: '@a', text: 'deep', own: true, links: ['https://github.com/o/r/tree/main'] },
  ] };
  const v = DL.relatedView(rel, null, doc);
  assert.equal(v.replies.length, 3);
  assert.deepEqual(v.replies[0].resources.map((r) => r.n), [1]);
  assert.deepEqual(v.replies[1].resources, []);
  assert.deepEqual(v.replies[2].resources, []); // already shown on the first reply: each URL once
  assert.equal(v.counts.replies, 3);
  assert.equal(DL.relatedView(rel).replies.length, 0); // no replies doc
  assert.equal(DL.relatedView({ ...rel, resources: [] }, null, doc).hasContext, true);
});

test('relatedView: a resource shown as a thread chip is not repeated in replies or "rest"', () => {
  const rel = {
    posts: [{ sid: 's', role: 'self', depth: 0, author: '@a', text: 'x' }],
    resources: [{ n: 1, url: 'https://github.com/o/r', type: 'github', found_in: ['s'] }, { n: 2, url: 'https://x.org/', type: 'web', found_in: [] }, { n: 3, url: 'https://y.org/', type: 'web', found_in: [] }],
  };
  const v = DL.relatedView(rel, null, { replies: [{ handle: '@b', text: 't', links: ['https://github.com/o/r', 'https://x.org/'] }] });
  assert.deepEqual(v.thread[0].resources.map((r) => r.n), [1]);
  assert.deepEqual(v.replies[0].resources.map((r) => r.n), [2]);
  assert.deepEqual(v.rest.map((r) => r.n), [3]);
});
