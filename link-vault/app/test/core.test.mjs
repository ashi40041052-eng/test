// Pure-logic / mocked-network tests for the phone-side snapshot capture. Run: node --test app/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(fileURLToPath(new URL('../core.js', import.meta.url)), 'utf8'));
const LV = globalThis.LV;

const cfg = { owner: 'o', repo: 'r', branch: 'main', token: 'TEST-NOT-REAL' };
const item = { id: '20261016-011607-06fd91fe', url: 'https://x.com/pentacoxian_dev/status/2110755123748340030' };
const tweet = {
  id: '2110755123748340030', url: 'https://x.com/pentacoxian_dev/status/2110755123748340030', text: '本文全文 '.repeat(50), lang: 'ja',
  created_timestamp: 1792078212, likes: 3, retweets: 1, views: 99,
  author: { name: 'PentaCoxian', screen_name: 'pentacoxian_dev' },
  quote: { url: 'https://x.com/q/status/1', text: 'quoted', author: { name: 'Q', screen_name: 'q' } },
  media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg?name=orig', width: 10, height: 10 },
                 { type: 'video', url: 'https://video.twimg.com/v.mp4' },
                 { type: 'photo', url: 'https://pbs.twimg.com/media/big.png?name=orig' }] },
};

function mockNet({ existing = new Set(), put422 = new Set(), fxStatus = 200 } = {}) {
  const puts = [], gets = {};
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url);
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (url.startsWith('https://api.fxtwitter.com/')) return fxStatus === 200 ? J({ tweet }) : J({}, fxStatus);
    if (url.startsWith('https://pbs.twimg.com/media/a.jpg')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.startsWith('https://pbs.twimg.com/media/big.png')) return new Response(new Uint8Array(10), { headers: { 'content-length': String(4 * 1024 * 1024) } });
    if (url.includes('api.github.com')) {
      const path = decodeURIComponent(url.split('/contents/')[1].split('?')[0]);
      if (opt.method === 'PUT') {
        puts.push({ path, body: JSON.parse(opt.body) });
        return new Response('{}', { status: put422.has(path) ? 422 : 201 });
      }
      const seen = (gets[path] = (gets[path] || 0) + 1);
      // A path that answers 422 on PUT was created by someone else after our first existence check.
      return new Response('{}', { status: existing.has(path) || (put422.has(path) && seen > 1) ? 200 : 404 });
    }
    throw new Error('unexpected ' + url);
  };
  return puts;
}

test('parseXStatus', () => {
  assert.deepEqual(LV.parseXStatus('https://twitter.com/a_b/status/123?s=20'), { user: 'a_b', statusId: '123' });
  assert.equal(LV.parseXStatus('https://example.com/status/1'), null);
});

test('snapshotFromFx maps schema 1', () => {
  const s = LV.snapshotFromFx(tweet, item, '2026-10-16T01:16:20Z');
  assert.equal(s.schema, 1);
  assert.equal(s.captured_by, 'phone');
  assert.equal(s.author.handle, '@pentacoxian_dev');
  assert.equal(s.text, tweet.text);
  assert.equal(s.published_at, new Date(1792078212000).toISOString().replace('.000', ''));
  assert.equal(s.media.length, 3);
  assert.equal(s.media[0].local, null);
  assert.equal(s.raw.fxtwitter, tweet);
  assert.equal(s.quote.author.handle, '@q');
});

test('capture: media first, snapshot create-only, local only for stored photos', async () => {
  const puts = mockNet();
  assert.equal(await LV.captureSnapshot(cfg, item), 'done');
  const paths = puts.map((p) => p.path);
  assert.deepEqual(paths, [
    'archive/2026/' + item.id + '/media/01.jpg',
    'archive/2026/' + item.id + '/snapshot.json',
  ]); // video skipped, 4MB photo skipped
  puts.forEach((p) => assert.equal('sha' in p.body, false, 'must be create-only'));
  const snap = JSON.parse(Buffer.from(puts[1].body.content, 'base64').toString());
  assert.equal(snap.media[0].local, 'media/01.jpg');
  assert.equal(snap.media[0].bytes, 3);
  assert.equal(snap.media[1].local, null);
  assert.equal(snap.media[2].local, null);
});

test('capture: skips when snapshot exists, when not X, when unconfigured', async () => {
  const puts = mockNet({ existing: new Set(['archive/2026/' + item.id + '/snapshot.json']) });
  assert.equal(await LV.captureSnapshot(cfg, item), 'skipped');
  assert.equal(await LV.captureSnapshot(cfg, { id: item.id, url: 'https://example.com/' }), 'skipped');
  assert.equal(await LV.captureSnapshot({ ...cfg, token: '' }, item), 'skipped');
  assert.equal(puts.length, 0);
});

test('capture: 422 on PUT is treated as success; never rejects on failures', async () => {
  const snapPath = 'archive/2026/' + item.id + '/snapshot.json';
  mockNet({ put422: new Set([snapPath, 'archive/2026/' + item.id + '/media/01.jpg']) });
  assert.equal(await LV.captureSnapshot(cfg, item), 'done');
  mockNet({ fxStatus: 404 });
  assert.equal(await LV.captureSnapshot(cfg, item), 'failed');
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await LV.captureSnapshot(cfg, item), 'failed');
});
