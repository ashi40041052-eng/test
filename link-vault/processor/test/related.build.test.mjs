// R3/R4 unit tests: linkBlock, ai/ markdown and manifest with related data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkBlock, MAX_LINK_CHARS, cleanResult, readableResources } from '../lib/prompt.mjs';
import { graphFromThread, relatedContent } from '../lib/related.mjs';
import { linkMarkdown, manifestLine, subjectOf } from '../lib/ai-build.mjs';
import { fx } from './related.test.mjs';

const ID = '20261016-012352-c07e399d';
async function bundle(readme = '# Agent Native\n\nhello\n\n## Usage\ntext') {
  const g = graphFromThread(await fx('fx2-thread-c07e399d.json'), '2110552871565660462');
  const ledger = {
    schema: 1, id: ID, root: g.root, posts: g.posts, primary: g.primary,
    resources: g.resources.map((r) => ({ ...r, meta: null, text: null, ok: true, error: null })),
  };
  const res = new Map([[1, { meta: { type: 'github', key: 'builderio/agent-native', full_name: 'BuilderIO/agent-native', description: 'The agent-native framework', stars: 1234, language: 'TypeScript', license: 'MIT', topics: ['agents'], truncated: false }, text: readme }]]);
  return { ledger, res };
}
const record = { id: ID, url: 'https://x.com/studio_yebisu/status/2110552871565660462', created_at: '2026-10-16T10:23:52+09:00', note: null };
const content = { ok: true, source_type: 'x', title: 't', author: '@studio_yebisu', text: 'ソースコード\nhttps://github.com/builderio/agent-native' };

test('linkBlock: subject and context come before content, within 30k chars even with huge inputs', async () => {
  const b = await bundle('R'.repeat(300_000));
  b.ledger.posts.forEach((p) => { p.text = 'あ'.repeat(5000); });
  const out = linkBlock(record, { ...content, text: 'x'.repeat(12_000), related: relatedContent(b) });
  assert.ok(out.indexOf('<subject type="github"') > 0);
  assert.ok(out.indexOf('<subject') < out.indexOf('<context>') && out.indexOf('<context>') < out.indexOf('<content'));
  assert.match(out, /<subject type="github" url="[^"]+" n="1"/, 'the subject carries its resource number (it has a body)');
  assert.ok(out.length <= MAX_LINK_CHARS, `length ${out.length}`);
  assert.match(out, /BuilderIO\/agent-native/);
});

test('linkBlock without related is the v2 block', () => {
  const out = linkBlock(record, content);
  assert.ok(!out.includes('<subject') && !out.includes('<context>'));
  assert.ok(out.startsWith(`<link id="${ID}">\nURL:`) && out.endsWith('</content>\n</link>'));
});

test('ai markdown: sections in order, frontmatter, manifest pk/pu; without related nothing changes', async () => {
  const b = await bundle();
  const item = { id: ID, url: record.url, title: 'Agent Native', summary: '要約', key_points: ['p'], category: 'AI', tags: ['a'], status: 'analyzed', created_at: record.created_at, content_type: 'repository' };
  const snap = { id: ID, captured_at: '2026-10-16T01:00:00Z', captured_by: 'processor', source_type: 'x', text: 'ソースコード', media: [], quote: null, author: { handle: '@studio_yebisu' } };
  const analysis = { primary_subject: { kind: 'resource', url: 'https://github.com/BuilderIO/agent-native', name: 'agent-native' }, resource_kind: 'repository' };
  const md = linkMarkdown(item, record, analysis, snap, b);
  const at = (h) => md.indexOf(h);
  assert.ok(at('## ポイント') < at('## 要約') && at('## 要約') < at('## 主題リソース') && at('## 主題リソース') < at('### README') && at('### README') < at('## 文脈') && at('## 文脈') < at('## 本文') && at('## 本文') < at('## その他のリソース'), md);
  const fmText = md.split('\n---\n')[0];
  const fm = Object.fromEntries(fmText.split('\n').slice(1).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
  assert.equal(fm.primary_kind, 'repository');
  assert.equal(fm.primary_url, 'https://github.com/builderio/agent-native');
  assert.equal(fm.primary_name, 'BuilderIO/agent-native');
  assert.equal(fm.context_posts, '3');
  assert.match(fm.related, /archive\/2026\/20261016-012352-c07e399d\/related\.json$/);
  assert.match(md, /\\## Usage/, 'third-party headings are escaped');
  assert.match(md, /#### 引用 @/);
  assert.equal(md.split('ソースコード').length - 1, 1, 'the saved post text is written once (本文 only)');
  assert.ok(!md.includes('保存したポスト'), 'no duplicate self block in 文脈');
  const line = manifestLine(item, analysis, snap, record, b);
  assert.ok(Buffer.byteLength(line) <= 640);
  const o = JSON.parse(line);
  assert.equal(o.pk, 'r');
  assert.equal(o.pu, 'https://github.com/builderio/agent-native');
  // long tags + subject url: all 8 tags survive the cap
  const tags = ['claude-code', 'agent-native', 'mcp', 'typescript', 'builder-io', 'ai-agents', 'open-source', 'developer-tools'];
  const long = JSON.parse(manifestLine({ ...item, title: 'エージェントネイティブな開発フレームワークの紹介と使い方まとめ', tags }, analysis, snap, record, b));
  assert.deepEqual(long.g, tags);
  assert.equal(long.pu, 'https://github.com/builderio/agent-native');
  // no related data: v2 output (no new keys, no new sections)
  const plain = linkMarkdown(item, record, {}, snap);
  assert.ok(!plain.includes('primary_kind') && !plain.includes('## 主題リソース') && !plain.includes('## 文脈'));
  assert.ok(!('pk' in JSON.parse(manifestLine(item, {}, snap, record))));
});

test('subjectOf prefers the AI answer; falls back to the rule; self when AI says self', async () => {
  const b = await bundle();
  assert.equal(subjectOf(b, {}).kind, 'resource');
  assert.equal(subjectOf(b, { primary_subject: { kind: 'self', url: null, name: '' } }).kind, 'self');
  assert.equal(subjectOf(b, { primary_subject: { kind: 'resource', url: 'https://example.com/unknown', name: 'x' } }).res.key, 'builderio/agent-native');
  assert.equal(subjectOf(null, {}), null);
});

test('replies: <replies> in the prompt (shrinks with the budget) and "## 他の人のリプ" in ai/links md', async () => {
  const b = await bundle();
  b.replies = { captured_at: '2026-10-16T12:00:00Z', truncated: false, replies: [
    { n: 1, handle: '@bob', name: 'Bob', text: '# fake heading\nofficial repo is here', time: '2026-10-16T01:00:00Z', own: false, links: ['https://github.com/foo/bar'] },
    { n: 2, handle: '@studio_yebisu', name: 'Y', text: 'self note', own: true, links: [] },
  ] };
  const rc = relatedContent(b);
  assert.equal(rc.replies.length, 2);
  const out = linkBlock(record, { ...content, related: rc });
  assert.match(out, /<replies>\n@bob: # fake heading/);
  assert.match(out, /@studio_yebisu \(本人\): self note/);
  assert.ok(out.indexOf('<replies>') < out.indexOf('<content'));
  const big = { ...b, replies: { replies: Array.from({ length: 30 }, (_, i) => ({ handle: '@u' + i, text: 'あ'.repeat(3000), links: [] })) } };
  assert.ok(linkBlock(record, { ...content, text: 'x'.repeat(12_000), related: relatedContent(big) }).length <= MAX_LINK_CHARS);
  const md = linkMarkdown({ id: ID, url: record.url, created_at: record.created_at, status: 'analyzed', tags: [] }, record, null, null, b);
  assert.match(md, /\nreplies: 1\n/); // the author's own reply is not counted
  assert.match(md, /## 他の人のリプ\n/);
  assert.match(md, /### @bob \(Bob\) 2026-10-16T01:00:00Z\n\\# fake heading official repo is here\n- link: https:\/\/github.com\/foo\/bar/);
  assert.match(md, /### @studio_yebisu \(Y\) \[本人\]/);
  assert.equal(/\n# fake heading/.test(md), false);
  const none = linkMarkdown({ id: ID, url: record.url, created_at: record.created_at, status: 'analyzed', tags: [] }, record, null, null, await bundle());
  assert.equal(none.includes('## 他の人のリプ'), false);
  assert.match(none, /replies: 0/);
});

test('ai/subjects.md grouped by kind + manifest pn; llms.txt / schema.md mention them and llms stays <= 60 lines', async () => {
  const { buildAi } = await import('../lib/ai-build.mjs');
  const b = await bundle();
  const item = { id: ID, url: record.url, title: 'Agent Native', summary: '要約', category: 'AI', tags: ['a'], status: 'analyzed', created_at: record.created_at };
  const plain = { id: '20261001-000000-aaaaaaaa', url: 'https://x.com/u/status/1', title: 'plain', status: 'analyzed', created_at: '2026-10-01T00:00:00Z', tags: [] };
  const files = buildAi({ items: [item, plain], byId: new Map(), analyses: new Map(), archives: new Map(), cats: [{ name: 'AI', count: 1, description: 'd' }], lastChange: '-', pendingCount: 0, related: new Map([[ID, b]]) });
  const md = files['ai/subjects.md'];
  assert.ok(md.indexOf('## repo (1)') > 0 && md.indexOf('## repo (1)') < md.indexOf('## model (0)') && md.indexOf('## model (0)') < md.indexOf('## post (0)'), md);
  assert.match(md, /\*\*BuilderIO\/agent-native\*\* — The agent-native framework · ★1,234 · license: MIT/);
  assert.match(md, /\[Agent Native\]\(links\/2026\/[^)]+\.md\) · AI · 2026-10-16/);
  assert.ok(!md.includes('plain'), 'links without a subject are not listed');
  const first = JSON.parse(files['ai/manifest.jsonl'].split('\n')[0]);
  assert.equal(first.pn, 'BuilderIO/agent-native');
  assert.match(files['ai/llms.txt'], /subjects\.md/);
  assert.match(files['ai/schema.md'], /pn=/);
  assert.match(files['ai/schema.md'], /subjects\.md/);
  assert.ok(files['ai/llms.txt'].split('\n').length <= 60);
});

// ---------- v4 ----------

// four resources: subject (github, body), a blog (body, n=2 from the thread), a profile site (body), plus one that had no body
async function bundle3(bodyLen = 40_000) {
  const b = await bundle('R'.repeat(bodyLen));
  const mk = (n, type, url, extra = {}) => ({ n, type, url, key: url, found_in: [], meta: null, text: null, ok: true, error: null, ...extra });
  Object.assign(b.ledger.resources.find((r) => r.n === 2), { url: 'https://builder.io/blog/x', ok: true });
  b.ledger.resources.push(
    mk(3, 'web', 'https://builder.io', { origin: 'profile:@Steve8708' }),
    mk(4, 'web', 'https://example.org/empty', { ok: false, error: 'empty body' }),
  );
  b.res.set(2, { meta: { title: 'Introducing Agent-Native' }, text: 'B'.repeat(bodyLen) });
  b.res.set(3, { meta: { title: 'Builder.io' }, text: 'P'.repeat(bodyLen) });
  return b;
}

test('v4 linkBlock: every resource with a body is a <resource n> block, one without a body is not handed over', async () => {
  const b = await bundle3(1000);
  const rel = relatedContent(b);
  const out = linkBlock(record, { ...content, related: rel });
  assert.match(out, /<resource n="2" type="web" url="https:\/\/builder.io\/blog\/x" name="Introducing Agent-Native">/);
  assert.match(out, /<resource n="3" /);
  assert.ok(!out.includes('<resource n="4"') && !out.includes('example.org/empty'), 'no body -> not handed over (the dashboard shows a plain link card)');
  assert.ok(!out.includes('<resources>'));
  assert.deepEqual(readableResources(rel).map((r) => r.n), [1, 2, 3], 'subject first');
  assert.ok(out.indexOf('<subject') < out.indexOf('<context>') && out.indexOf('<resource n="3"') < out.indexOf('<content'));
});

test('v4 linkBlock: huge bodies shrink within 30k and other resources shrink before the subject; none is dropped', async () => {
  const b = await bundle3(200_000);
  b.ledger.posts.forEach((p) => { p.text = 'あ'.repeat(5000); });
  const out = linkBlock(record, { ...content, text: 'x'.repeat(12_000), related: relatedContent(b) });
  assert.ok(out.length <= MAX_LINK_CHARS, `length ${out.length}`);
  for (const n of [2, 3]) assert.ok(out.includes(`<resource n="${n}"`), `resource ${n} kept`);
  const run = (c) => Math.max(0, ...(out.match(new RegExp(`${c}{20,}`, 'g')) || []).map((x) => x.length));
  assert.ok(run('R') >= 1500, 'the subject body keeps its share');
  assert.ok(run('B') >= 100 && run('B') <= 2500 && run('P') <= 2500, 'other resource bodies are clipped to 2,500 or less');
  assert.ok(run('R') > run('B'), 'the subject keeps more than the others');
});

test('v4 cleanResult: only handed-over resources survive, n/url/type come from the ledger, my_note is forced empty, one line tldr', async () => {
  const rel = relatedContent(await bundle3(100));
  const r = cleanResult({
    tldr: ' 一行\nです ', key_points: ['a', 'b', 'c', 'd', 'e', 'f'], tags: [], category: 'x',
    resources: [
      { n: 2, url: 'https://evil.example', type: 'github', name: 'Blog', what: '記事', features: ['f1', '', 'f2'], usage: '', audience: 'dev', my_note: 'AI wrote this' },
      { n: 4, url: 'https://example.org/empty', name: 'x', what: 'guess', features: [], usage: '', audience: '', my_note: '' },
      { n: 1, url: 'u', name: 'Repo', type: 'github', what: 'w', features: ['f'], usage: 'npx x', audience: 'a', my_note: '' },
      { n: 2, url: 'dup', name: 'dup', what: 'dup', features: [], usage: '', audience: '', my_note: '' },
    ],
  }, rel);
  assert.equal(r.tldr, '一行 です');
  assert.deepEqual(r.resources.map((x) => x.n), [1, 2], 'handed-over order, no n=4 (no body), no duplicate n');
  assert.equal(r.resources[1].url, 'https://builder.io/blog/x');
  assert.equal(r.resources[1].type, 'web');
  assert.deepEqual(r.resources[1].features, ['f1', 'f2']);
  assert.ok(r.resources.every((x) => x.my_note === ''));
  assert.equal(cleanResult({ key_points: [] }).resources.length, 0, 'no related -> empty');
});

test('v4 ai markdown: TL;DR -> ポイント -> リソース (all, ordered, with readings) -> 要約 -> 主題リソース; unread resources still get their link', async () => {
  const b = await bundle3(100);
  const item = { id: ID, url: record.url, title: 'Agent Native', summary: '長い要約', key_points: ['p1'], tldr: '一行まとめ', category: 'AI', tags: ['a'], status: 'analyzed', created_at: record.created_at, content_type: 'repository' };
  const snap = { id: ID, captured_at: '2026-10-16T01:00:00Z', captured_by: 'processor', source_type: 'x', text: 'ソースコード', media: [], quote: null, author: { handle: '@studio_yebisu' } };
  const analysis = {
    v: 4, tldr: '一行まとめ', primary_subject: { kind: 'resource', url: 'https://github.com/builderio/agent-native', name: 'agent-native' }, resource_kind: 'repository',
    resources: [{ n: 1, url: 'https://github.com/builderio/agent-native', name: 'BuilderIO/agent-native', type: 'github', what: '何かの基盤', features: ['機能A', '機能B'], usage: 'npx create x', audience: '開発者', my_note: '' },
      { n: 2, url: 'https://builder.io/blog/x', name: 'Intro', type: 'web', what: '告知記事', features: ['背景'], usage: '', audience: '読みたい人', my_note: '' }],
  };
  const md = linkMarkdown(item, record, analysis, snap, b);
  const at = (h) => md.indexOf(h);
  assert.ok(at('## TL;DR') < at('## ポイント') && at('## ポイント') < at('## リソース') && at('## リソース') < at('## 要約') && at('## 要約') < at('## 主題リソース') && at('## 主題リソース') < at('## 文脈'), md);
  const sec = md.slice(at('## リソース'), at('## 要約'));
  assert.ok(sec.indexOf('agent-native') < sec.indexOf('Intro') && sec.indexOf('Intro') < sec.indexOf('https://builder.io\n'), 'subject, post-side resource, then profile');
  assert.match(sec, /### BuilderIO\/agent-native \[主題\]\n- URL: https:\/\/github.com\/builderio\/agent-native\n- 種類: github · 出所: 保存ポスト内\n- 何: 何かの基盤\n- できること:\n  - 機能A\n  - 機能B\n- 使い方: npx create x\n- 向く人: 開発者\n- 自分メモ: （未記入）/);
  assert.match(sec, /- 使い方: （本文に記載なし）/);
  assert.match(sec, /https:\/\/builder.io\n- 種類: web · 出所: プロフィール @Steve8708\n- AI の読み: なし（未分析）/);
  assert.match(sec, /example.org\/empty\n- 種類: web\n- AI の読み: なし（本文なし）/);
  // older analysis (no v4): no TL;DR / readings, the links are still listed
  const old = linkMarkdown({ ...item, tldr: undefined }, record, { primary_subject: analysis.primary_subject }, snap, b);
  assert.ok(!old.includes('## TL;DR') && old.includes('## リソース') && old.includes('- AI の読み: なし'));
  // a link without related data has no リソース section at all
  assert.ok(!linkMarkdown(item, record, analysis, snap, null).includes('## リソース'));
});
