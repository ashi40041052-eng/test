// R3/R4 unit tests: linkBlock, ai/ markdown and manifest with related data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkBlock, MAX_LINK_CHARS } from '../lib/prompt.mjs';
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

test('linkBlock: subject and context come before content, within 20k chars even with huge inputs', async () => {
  const b = await bundle('R'.repeat(300_000));
  b.ledger.posts.forEach((p) => { p.text = 'あ'.repeat(5000); });
  const out = linkBlock(record, { ...content, text: 'x'.repeat(12_000), related: relatedContent(b) });
  assert.ok(out.indexOf('<subject type="github"') > 0);
  assert.ok(out.indexOf('<subject') < out.indexOf('<context>') && out.indexOf('<context>') < out.indexOf('<resources>') && out.indexOf('<resources>') < out.indexOf('<content'));
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
  assert.ok(at('## 要約') < at('## ポイント') && at('## ポイント') < at('## 主題リソース') && at('## 主題リソース') < at('### README') && at('### README') < at('## 文脈') && at('## 文脈') < at('## 本文') && at('## 本文') < at('## その他のリソース'), md);
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
  assert.ok(Buffer.byteLength(line) <= 400);
  const o = JSON.parse(line);
  assert.equal(o.pk, 'r');
  assert.equal(o.pu, 'https://github.com/builderio/agent-native');
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
