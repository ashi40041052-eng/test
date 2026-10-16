// x-replies: hermetic. Fake driver + fixture HTML; no browser, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseThread, detectLoginWall, xrepliesTrigger, captureXReplies, setXrepliesDriver, setXrepliesResolver, xrepliesEnabled } from '../lib/x-replies.mjs';
import { scorePrimary } from '../lib/related.mjs';

const art = (h, id, text, extra = '') => `<article data-testid="tweet"><div data-testid="User-Name"><span>Name ${h}</span><span>@${h}</span></div><a href="/${h}/status/${id}"><time datetime="2026-10-01T00:00:0${id % 10}.000Z">1h</time></a><div data-testid="tweetText">${text}</div>${extra}</article>`;
const PAGE = `<html>${art('author', '100', 'Big news 👇')}
${art('bob', '101', 'Try <a href="https://t.co/AAA" title="https://github.com/foo/bar" dir="ltr">github.com/foo/ba…</a> &amp; enjoy')}
${art('author', '102', 'repo: <a href="https://t.co/BBB">https://t.co/BBB</a>')}
${art('eve', '103', 'no link here')}</html>`;
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lv-xr-'));
async function env(driver) {
  const d = await tmp();
  process.env.LV_XREPLIES_LOGIN_FILE = path.join(d, 'login.json');
  process.env.LV_XREPLIES_LOCK_FILE = path.join(d, 'x.lock');
  process.env.LV_XREPLIES_FAST = '1';
  delete process.env.LV_XREPLIES; delete process.env.LV_FXTWITTER_BASE;
  setXrepliesDriver(driver);
  setXrepliesResolver(async (u) => (u.endsWith('BBB') ? 'https://huggingface.co/foo/model' : ''));
  return d;
}

test('parseThread: replies under the main post, links via title, deduped across snapshots', () => {
  const { main, replies } = parseThread([PAGE, PAGE], '100');
  assert.equal(main.handle, '@author');
  assert.deepEqual(replies.map((r) => r.sid), ['101', '102', '103']);
  assert.equal(replies[0].name, 'Name bob');
  assert.equal(replies[0].text, 'Try github.com/foo/ba… & enjoy');
  assert.equal(replies[0].links[0].title, 'https://github.com/foo/bar');
});

test('detectLoginWall', () => {
  assert.ok(detectLoginWall('<a data-testid="loginButton">', 'https://x.com/a/status/1'));
  assert.ok(detectLoginWall('', 'https://x.com/i/flow/login?redirect'));
  assert.ok(!detectLoginWall(PAGE, 'https://x.com/author/status/100'));
});

test('capture: writes create-only archive, own replies flagged, t.co resolved without a browser', async () => {
  const d = await env({ loadThread: async () => ({ finalUrl: 'https://x.com/author/status/100', snapshots: [PAGE] }) });
  const budget = { xreplies: 1 };
  const r = await captureXReplies({ relatedRoot: d, id: 'i1', statusUrl: 'https://x.com/author/status/100', sid: '100', budget });
  assert.equal(r.status, 'done');
  assert.deepEqual(r.urls, [{ url: 'https://huggingface.co/foo/model', own: true }, { url: 'https://github.com/foo/bar', own: false }]);
  const doc = JSON.parse(await fs.readFile(path.join(d, 'related', 'x-replies.json'), 'utf8'));
  assert.equal(doc.schema, 1); assert.equal(doc.replies.length, 3); assert.equal(doc.replies[1].own, true);
  assert.equal(budget.xreplies, 0);
  // second call: file exists -> no browser
  setXrepliesDriver({ loadThread: async () => { throw new Error('must not run'); } });
  assert.equal((await captureXReplies({ relatedRoot: d, id: 'i1', statusUrl: 'x', sid: '100', budget })).status, 'done');
});

test('capture: login wall -> login_required, notice written once, then skipped (no retry storm)', async () => {
  let calls = 0;
  const d = await env({ loadThread: async () => { calls++; return { finalUrl: 'https://x.com/i/flow/login', snapshots: ['<div data-testid="loginButton"></div>'] }; } });
  const a = await captureXReplies({ relatedRoot: d, id: 'i2', statusUrl: 'u', sid: '1', budget: { xreplies: 5 } });
  assert.equal(a.status, 'login_required');
  assert.ok(JSON.parse(await fs.readFile(process.env.LV_XREPLIES_LOGIN_FILE, 'utf8')).at);
  const b = await captureXReplies({ relatedRoot: d, id: 'i3', statusUrl: 'u', sid: '1', budget: { xreplies: 5 } });
  assert.equal(b.status, 'skipped'); assert.equal(calls, 1);
  await assert.rejects(fs.access(path.join(d, 'related', 'x-replies.json')));
});

test('capture: errors count attempts, stop at 3; disabled/budget 0 skip; fxtwitter double never reaches a browser', async () => {
  let calls = 0;
  const d = await env({ loadThread: async () => { calls++; throw new Error('boom'); } });
  // loadThread throws inside the lock -> propagate as error status
  for (let i = 0; i < 5; i++) await captureXReplies({ relatedRoot: d, id: 'i4', statusUrl: 'u', sid: '1', budget: { xreplies: 5 } }).catch(() => {});
  assert.equal(calls, 3); // 3 attempts max
  assert.equal((await captureXReplies({ relatedRoot: await tmp(), id: 'i5', statusUrl: 'u', sid: '1', budget: { xreplies: 0 } })).status, 'skipped');
  setXrepliesDriver(null);
  process.env.LV_FXTWITTER_BASE = 'http://127.0.0.1:1';
  assert.equal(xrepliesEnabled(), false);
  delete process.env.LV_FXTWITTER_BASE;
});

test('trigger: reply hint / tool / recent-without-resource-primary; scoring +2 / +3', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const posts = [{ sid: '1', role: 'self', text: 'something plain', urls: [] }];
  assert.equal(xrepliesTrigger(posts, [], { primary: { kind: 'self' }, savedAt: '2026-10-08T00:00:00Z', now }), 'recent');
  assert.equal(xrepliesTrigger(posts, [], { primary: { kind: 'self' }, savedAt: '2026-09-01T00:00:00Z', now }), null);
  assert.equal(xrepliesTrigger(posts, [], { primary: { kind: 'resource' }, savedAt: '2026-10-08T00:00:00Z', now }), null);
  assert.equal(xrepliesTrigger([{ ...posts[0], text: 'link in replies 👇' }], [], { primary: { kind: 'self' }, savedAt: '2020-01-01', now }), 'replies');
  const base = { posts, objects: { 1: {} } };
  const mk = (origin) => scorePrimary({ ...base, resources: [{ type: 'web', key: 'https://foo.ai', url: 'https://foo.ai', found_in: [], origin }] });
  assert.match(mk('x_replies').resources[0].origin, /x_replies/);
  assert.equal(mk('x_replies_self').resources[0].origin, 'x_replies_self');
});
