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

test('keepSelection: a selection outside the view is cleared', () => {
  const view = [{ id: 'a' }, { id: 'b' }];
  assert.equal(DL.keepSelection(view, 'b'), 'b');
  assert.equal(DL.keepSelection(view, 'zzz'), null);
  assert.equal(DL.keepSelection([], 'a'), null);
  assert.equal(DL.keepSelection(view, null), null);
});
test('threadShowsPost: the archive body is dropped only when the thread already shows the saved post', () => {
  const self = { role: 'self', text: 'body' };
  assert.equal(DL.threadShowsPost({ thread: [{ role: 'parent', text: 'p' }, self] }), true);
  assert.equal(DL.threadShowsPost({ thread: [Object.assign({ quote: { text: 'q' } }, self)] }), true);
  assert.equal(DL.threadShowsPost({ thread: [self] }), false, 'single post: thread not rendered');
  assert.equal(DL.threadShowsPost({ thread: [{ role: 'parent', text: 'p' }, { role: 'self', text: '' }] }), false);
  assert.equal(DL.threadShowsPost(null), false);
});
test('xrStatusText', () => {
  assert.equal(DL.xrStatusText(null), '');
  assert.match(DL.xrStatusText({ state: 'ok', at: '2026-10-17T03:00:00Z' }), /^リプ取得: 正常 10\/17 /);
  assert.match(DL.xrStatusText({ state: 'skip', reason: 'login required', last_ok_at: '2026-10-16T03:00:00Z' }), /^リプ取得: スキップ \(login required\) · 最終成功 10\/16 /);
});

test('threadShowsQuote: the archive 引用元 is dropped only when the thread already renders the quote', () => {
  const self = { role: 'self', text: 's' };
  assert.equal(DL.threadShowsQuote({ thread: [Object.assign({ quote: { text: 'q' } }, self)] }), true);
  assert.equal(DL.threadShowsQuote({ thread: [{ role: 'parent', text: 'p' }, self] }), false);
  assert.equal(DL.threadShowsQuote({ thread: [self] }), false);
  assert.equal(DL.threadShowsQuote(null), false);
});

// ---- v4: resource cards (DESIGN-v4.md sections 3/4) ----
const LEDGER = {
  posts: [
    { sid: 'p1', role: 'parent', depth: 1, text: 'parent' }, { sid: 's', role: 'self', text: 'saved' },
    { sid: 'r1', role: 'self_reply', depth: 1, text: 'continued' }, { sid: 'q1', role: 'quote', of: 'p1', text: 'quoted' },
  ],
  primary: { kind: 'resource', n: 2 },
  resources: [
    { n: 1, type: 'web', url: 'https://site.example/', key: 'site', found_in: [], origin: 'profile:@bob' },
    { n: 2, type: 'github', url: 'https://github.com/a/b', key: 'a/b', found_in: ['s'] },
    { n: 3, type: 'web', url: 'https://blog.example/p', key: 'blog', found_in: ['r1'] },
    { n: 4, type: 'hf', url: 'https://huggingface.co/x/y', key: 'x/y', found_in: [], origin: 'x_replies' },
    { n: 5, type: 'arxiv', url: 'https://arxiv.org/abs/1', key: '1', found_in: ['q1'] },
    { n: 6, type: 'github', url: 'https://github.com/c/d', key: 'c/d', found_in: ['s'] },
    { n: 7, type: 'web', url: 'https://www.BLOG.example/p/', key: 'dup', found_in: ['s'] },
    { n: 8, type: 'web', url: 'https://own.example/', key: 'own', found_in: [], origin: 'x_replies_self' },
  ],
};

test('resourceCards: subject, saved post, parent/quote, own continuation, others replies, profile; same url once', () => {
  const cards = DL.resourceCards(LEDGER, null);
  assert.deepEqual(cards.map((c) => c.n), [2, 6, 7, 5, 8, 4, 1], 'n=7 and n=3 are one url: the better place (saved post) wins');
  assert.deepEqual(cards.map((c) => c.where), ['保存ポスト内', '保存ポスト内', '保存ポスト内', '引用元', '本人のリプ', '他人のリプ', 'プロフィール @bob']);
  assert.equal(cards[0].subject, true);
  assert.ok(cards.slice(1).every((c) => !c.subject));
});
test('resourceCards: the AI primary_subject wins over the rule-based one; it goes first whatever its origin', () => {
  const cards = DL.resourceCards(LEDGER, { kind: 'resource', url: 'https://HUGGINGFACE.co/x/y/', name: 'y' });
  assert.equal(cards[0].n, 4);
  assert.equal(cards[0].subject, true);
  assert.equal(cards.filter((c) => c.subject).length, 1);
});
test('relatedView: every resource carries its origin label; cards equal resourceCards; without resources there are no cards', () => {
  const v = DL.relatedView(LEDGER, null, null);
  assert.equal(v.resources.find((r) => r.n === 1).where, 'プロフィール @bob');
  assert.equal(v.resources.find((r) => r.n === 3).where, '本人の続き');
  assert.equal(v.resources.find((r) => r.n === 2).where, '保存ポスト内');
  assert.deepEqual(v.cards.map((c) => c.n), DL.resourceCards(LEDGER, null).map((c) => c.n));
  const none = DL.relatedView({ posts: [{ sid: 's', role: 'self', text: 't' }], resources: [], primary: { kind: 'self' } }, null, null);
  assert.deepEqual(none.cards, []);
  assert.deepEqual(DL.resourceCards(null, null), []);
  assert.deepEqual(DL.resourceCards({ posts: [], resources: [] }, null), []);
});
test('resourceCards works on related.json alone: a resource without any AI reading or body is still a card', () => {
  const [c] = DL.resourceCards({ posts: [{ sid: 's', role: 'self' }], primary: { kind: 'self' }, resources: [{ n: 1, type: 'web', url: 'https://x.example', key: 'x', found_in: ['s'], ok: false, error: 'empty body' }] }, null);
  assert.equal(c.url, 'https://x.example');
  assert.equal(c.ok, false);
  assert.equal(DL.resourceTitle(c, null), 'x');
  assert.equal(DL.resourceTitle(c, { title: 'T' }), 'T');
});
test('search finds the tldr', () => {
  assert.equal(DL.matchesQuery({ title: 'a', tldr: '人とAIが同じ画面' }, null, 'AIが同じ'), true);
});
