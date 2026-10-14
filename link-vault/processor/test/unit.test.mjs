import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, safeFileName } from '../lib/util.mjs';
import { extractFromHtml } from '../lib/fetch-content.mjs';
import { buildOutputs } from '../lib/build.mjs';

test('normalizeUrl merges x/twitter share variants', () => {
  assert.equal(
    normalizeUrl('https://twitter.com/foo/status/123?s=20&t=abc'),
    normalizeUrl('https://x.com/foo/status/123/'),
  );
  assert.equal(normalizeUrl('https://www.example.com/a/?utm_source=x&b=1'), 'https://example.com/a?b=1');
  // YouTube timestamps are meaningful and kept
  assert.equal(normalizeUrl('https://youtube.com/watch?v=1&t=30'), 'https://youtube.com/watch?t=30&v=1');
});

test('safeFileName strips path characters', () => {
  assert.equal(safeFileName('AI/LLM: 活用'), 'AI_LLM_ 活用');
});

test('extractFromHtml reads og tags and body text', () => {
  const html = `<html><head><title>T</title><meta property="og:title" content="OG &amp; Title">
  <meta name="description" content="desc"></head><body><nav>menu</nav><article><p>Hello</p><script>x()</script><p>World</p></article></body></html>`;
  const r = extractFromHtml(html);
  assert.equal(r.title, 'OG & Title');
  assert.equal(r.description, 'desc');
  assert.match(r.text, /Hello\s+World/);
  assert.doesNotMatch(r.text, /menu|x\(\)/);
});

test('buildOutputs merges duplicates and keeps unanalyzed links', () => {
  const records = [
    { id: '20261001-000000-aaaa', url: 'https://a.example/1', note: 'first', created_at: '2026-10-01T09:00:00+09:00' },
    { id: '20261002-000000-bbbb', url: 'https://a.example/1', note: 'again', created_at: '2026-10-02T09:00:00+09:00' },
    { id: '20261003-000000-cccc', url: 'https://b.example/', note: null, created_at: '2026-10-03T09:00:00+09:00' },
  ];
  const analyses = new Map([
    ['20261001-000000-aaaa', { id: '20261001-000000-aaaa', status: 'analyzed', title: 'A', summary: 'S', key_points: ['p'], category: 'AI', tags: ['t'] }],
    ['20261002-000000-bbbb', { id: '20261002-000000-bbbb', status: 'duplicate', duplicate_of: '20261001-000000-aaaa' }],
  ]);
  const { files, stats } = buildOutputs({ records, analyses, categories: [{ name: 'AI', description: 'd' }], now: new Date('2026-10-04T00:00:00Z') });
  const index = JSON.parse(files['index.json']);
  assert.equal(index.items.length, 2);
  assert.equal(index.known_ids.length, 3);
  assert.equal(index.items[0].status, 'pending');
  assert.equal(index.items[1].note, 'first / again');
  assert.deepEqual(index.items[1].also_saved_at, ['2026-10-02T09:00:00+09:00']);
  assert.equal(stats.pending, 1);
  assert.ok(files['knowledge/categories/AI.md'].includes('[A](https://a.example/1)'));
  assert.ok(files['knowledge/timeline.md'].includes('（未分析）'));
});

test('buildOutputs flags deleted links and keeps them out of knowledge', () => {
  const records = [
    { id: '20261001-000000-aaaa', url: 'https://a.example/', created_at: '2026-10-01T09:00:00+09:00' },
    { id: '20261002-000000-bbbb', url: 'https://b.example/', created_at: '2026-10-02T09:00:00+09:00' },
  ];
  const analyses = new Map(records.map((r, i) => [r.id, { id: r.id, status: 'analyzed', title: `T${i}`, summary: 's', category: 'C', tags: [] }]));
  const { files, stats } = buildOutputs({ records, analyses, categories: [{ name: 'C' }], deleted: new Set(['20261002-000000-bbbb']) });
  const index = JSON.parse(files['index.json']);
  assert.equal(index.items.length, 2, 'deleted item stays in index for the trash view');
  assert.equal(index.items.find((i) => i.id === '20261002-000000-bbbb').deleted, true);
  assert.equal(index.total, 1);
  assert.equal(index.categories[0].count, 1);
  assert.equal(stats.deleted, 1);
  assert.ok(!files['knowledge/timeline.md'].includes('T1'));
  assert.ok(!files['knowledge/links.jsonl'].includes('bbbb'));
  assert.ok(files['knowledge/timeline.md'].includes('T0'));
});
