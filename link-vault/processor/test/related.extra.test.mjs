// v3.1 supplements: profile website fallback. Hermetic: fake fxtwitter / hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { extractHubLinks, profileUrls, isHubUrl } from '../lib/related-extra.mjs';
import { scorePrimary } from '../lib/related.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROC = path.join(HERE, '..', 'process.mjs');
const F = (n) => path.join(HERE, 'fixtures', 'related', n);
const fxj = async (n) => JSON.parse(await fs.readFile(F(n), 'utf8'));
process.env.LV_LOG_DIR = path.join(os.tmpdir(), `lv-test-extra-logs-${process.pid}`);
process.env.LV_LOCK_FILE = path.join(os.tmpdir(), `lv-test-extra-${process.pid}.lock`);

test('profile: website + bio facets, hub detection, linktree fixture -> official domain first', async () => {
  const mirelo = (await fxj('fx-user-MireloAI.json')).user;
  const bfl = (await fxj('fx-user-bfl_ai.json')).user;
  assert.deepEqual(profileUrls(mirelo), ['https://linktr.ee/mirelo.ai']);
  assert.deepEqual(profileUrls(bfl), ['http://bfl.ai', 'https://bfl.ai/careers']);
  assert.ok(isHubUrl('https://linktr.ee/mirelo.ai') && isHubUrl('https://lit.link/x') && !isHubUrl('http://bfl.ai'));
  assert.deepEqual(profileUrls({ website: { url: 'https://a.example' }, raw_description: { facets: [{ type: 'url', replacement: 'https://b.example' }, { type: 'mention' }] } }), ['https://a.example', 'https://b.example']);
  const links = extractHubLinks(await fs.readFile(F('hub-linktree-mirelo.html'), 'utf8'), mirelo);
  assert.equal(links[0], 'https://mirelo.ai');
  assert.ok(links.every((u) => !/sjv\.io|linktr\.ee|fonts/.test(u)), links.join());
});

test('scorePrimary: profile origin is +1 (loses to a post-primary), x_replies is +2', () => {
  const posts = [{ sid: '1', role: 'self', text: 'long enough text about something interesting here', urls: [] },
    { sid: '2', role: 'quote', of: '1', text: 'Introducing Foo', urls: [], author: '@foo' }];
  const base = { posts, objects: { 1: {}, 2: { author: {} } } };
  const prof = scorePrimary({ ...base, resources: [{ type: 'web', key: 'https://foo.ai', url: 'https://foo.ai', found_in: [], origin: 'profile:@foo' }] });
  assert.equal(prof.primary.kind, 'post'); // official quote scores 2 > 1
  assert.equal(prof.resources[0].origin, 'profile:@foo');
  const xs = scorePrimary({ ...base, resources: [{ type: 'web', key: 'https://foo.ai', url: 'https://foo.ai', found_in: [], origin: 'x_replies' }] });
  assert.equal(xs.primary.kind, 'resource');
  const only = scorePrimary({ posts: [posts[0]], objects: {}, resources: [{ type: 'web', key: 'https://foo.ai', url: 'https://foo.ai', found_in: [], origin: 'profile:@foo' }] });
  assert.equal(only.primary.kind, 'resource'); // nothing better exists
});

// ---- end to end ----
const MIR = { id: '20261016-050000-mirelo01', sid: '3000', user: 'studio_yebisu' };
const FLX = { id: '20261016-050100-flux0001', sid: '3100', user: 'studio_yebisu' };
const NOTOOL = { id: '20261016-050200-plain001', sid: '3200', user: 'studio_yebisu' };
const post = (id, text, o = {}) => ({ id, text, author: { screen_name: o.user || 'studio_yebisu' }, created_timestamp: 1792029991, raw_text: { text, facets: (o.urls || []).map((u) => ({ type: 'url', replacement: u })) }, ...(o.quote ? { quote: o.quote } : {}) });
const threads = {
  3000: { thread: [post('3000', 'SFX2.0 の動画が凄い', { quote: post('3001', 'Introducing Mirelo SFX 2.0', { user: 'MireloAI' }) })] },
  3100: { thread: [post('3100', 'リプのURLをAIに投げてね👇', { quote: post('3101', 'FLUX is here', { user: 'bfl_ai' }) })] },
  3200: { thread: [post('3200', '今日は散歩した')] },
};

async function world() {
  const hits = { users: [], hub: 0 };
  const mir = await fxj('fx-user-MireloAI.json'), bfl = await fxj('fx-user-bfl_ai.json');
  const server = http.createServer(async (req, res) => {
    let m;
    const send = (b, t = 'application/json', s = 200) => { res.statusCode = s; res.setHeader('content-type', t); res.end(b); };
    if ((m = req.url.match(/^\/fx\/2\/thread\/(\d+)/))) return threads[m[1]] ? send(JSON.stringify(threads[m[1]])) : send('{}', 'application/json', 404);
    if ((m = req.url.match(/^\/fx\/([A-Za-z0-9_]+)$/))) {
      hits.users.push(m[1]);
      if (m[1] === 'MireloAI') return send(JSON.stringify({ ...mir, user: { ...mir.user, website: { url: `${base}/hub/mirelo` } } }));
      if (m[1] === 'bfl_ai') return send(JSON.stringify({ ...bfl, user: { ...bfl.user, website: { url: `${base}/site/bfl` } } }));
      return send('{}', 'application/json', 404);
    }
    if (req.url === '/hub/mirelo') { // same page, official-domain anchors moved first (the fake site has no real hostname to match)
      hits.hub++;
      const lines = (await fs.readFile(F('hub-linktree-mirelo.html'), 'utf8')).split('\n');
      const off = lines.filter((l) => /href="https?:\/\/mirelo\.ai/.test(l)).map((l) => l.replace(/https?:\/\/mirelo\.ai/g, `${base}/site/mirelo`));
      return send([...off, ...lines.filter((l) => !/href="https?:\/\/mirelo\.ai/.test(l))].join('\n'), 'text/html');
    }
    if (req.url.startsWith('/site/')) return send('<html><head><title>Official site</title></head><body><article>' + 'Official product page. '.repeat(40) + '</article></body></html>', 'text/html');
    send('', 'text/plain', 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, hits };
}

async function setup() {
  const w = await world();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-extra-'));
  for (const e of [MIR, FLX, NOTOOL]) {
    await fs.mkdir(path.join(dir, 'links/2026/10'), { recursive: true });
    await fs.writeFile(path.join(dir, `links/2026/10/${e.id}.json`), JSON.stringify({ id: e.id, url: `https://x.com/${e.user}/status/${e.sid}`, created_at: '2026-10-16T10:00:00+09:00' }));
  }
  const env = {
    ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: dir, LV_CLAUDE_BIN: '/nonexistent/claude', LV_FXTWITTER_BASE: `${w.base}/fx`,
    LV_HUB_HOSTS: `${w.base.replace('http://', '')}/hub/`, LV_NO_GH: '1', LV_LOG_DIR: path.join(dir, 'logs'),
  };
  const proc = (extra = {}) => run(process.execPath, [PROC, '--archive-only', '--no-git'], { env: { ...env, ...extra } });
  const rj = async (e, rel) => JSON.parse(await fs.readFile(path.join(dir, 'archive/2026', e.id, rel), 'utf8'));
  return { ...w, dir, proc, rj, cleanup: async () => { w.server.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

test('e2e: profile hub fallback adds the official site; idempotent', async () => {
  const t = await setup();
  try {
    await t.proc();
    const m = await t.rj(MIR, 'related.json');
    const prof = m.resources.find((r) => r.origin === 'profile:@MireloAI');
    assert.ok(prof, JSON.stringify(m.resources));
    assert.match(prof.url, /\/site\/mirelo/);
    assert.ok(prof.ok);
    assert.ok((await t.rj(FLX, 'related.json')).resources.some((r) => r.origin === 'profile:@bfl_ai'));
    const before = await fs.readFile(path.join(t.dir, 'archive/2026', MIR.id, 'related.json'), 'utf8');
    await t.proc();
    assert.equal(await fs.readFile(path.join(t.dir, 'archive/2026', MIR.id, 'related.json'), 'utf8'), before);
  } finally { await t.cleanup(); }
});

test('e2e: a v3 related.json gains supplement resources later -> --reanalyze-related redoes only that link', async () => {
  const t = await setup();
  const logFile = path.join(t.dir, 'fake-claude.log');
  const ai = { LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_LOG: logFile, LV_BACKEND: 'claude-code', LV_LOG_DIR: path.join(t.dir, 'logs') };
  const calls = async () => (await fs.readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  try {
    // MIR already has a v3-era related.json (no supplement) and an analysis with a primary_subject
    const root = path.join(t.dir, 'archive/2026', MIR.id);
    await fs.mkdir(path.join(root, 'related/posts'), { recursive: true });
    await fs.writeFile(path.join(root, 'related.json'), JSON.stringify({
      schema: 1, id: MIR.id, captured_at: '2026-10-16T01:00:00.000Z', captured_by: 'processor', thread_from: 'fx', root: '3000',
      posts: [{ sid: '3000', role: 'self', author: '@studio_yebisu', text: 'SFX2.0 の動画が凄い', urls: [], published_at: '2026-10-16T01:00:00.000Z' },
        { sid: '3001', role: 'quote', of: '3000', author: '@MireloAI', text: 'Introducing Mirelo SFX 2.0', urls: [] }],
      resources: [], primary: { kind: 'post', sid: '3001', reason: 'x' },
    }, null, 2));
    for (const e of [MIR, FLX, NOTOOL]) {
      await fs.mkdir(path.join(t.dir, 'analysis/2026'), { recursive: true });
      await fs.writeFile(path.join(t.dir, 'analysis/2026', `${e.id}.json`), JSON.stringify({ id: e.id, status: 'analyzed', analyzed_at: '2026-10-16T02:00:00.000Z', primary_subject: { kind: 'self', url: null, name: '' }, resource_kind: 'none', title: 't', summary: 's', category: 'AI活用', tags: [] }));
    }
    await t.proc(); // archive-only: supplement appends the profile site
    const m = await t.rj(MIR, 'related.json');
    assert.ok(m.resources.some((r) => r.origin === 'profile:@MireloAI'));
    assert.equal(m.posts.length, 2, 'existing entries untouched');
    assert.ok(m.supplement.resources_added_at > '2026-10-16T02:00:00.000Z');
    await run(process.execPath, [PROC, '--reanalyze-related', '--no-git'], { env: { ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: t.dir, LV_FXTWITTER_BASE: `${t.base}/fx`, LV_HUB_HOSTS: `${t.base.replace('http://', '')}/hub/`, LV_NO_GH: '1', ...ai } });
    const c = await calls();
    assert.equal(c.length, 1);
    assert.ok(c[0].includes(MIR.id) && !c[0].includes(NOTOOL.id), 'only the supplemented link is redone');
    assert.match(c[0], /site\/mirelo/);
    // and not again
    await run(process.execPath, [PROC, '--reanalyze-related', '--no-git'], { env: { ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: t.dir, LV_FXTWITTER_BASE: `${t.base}/fx`, LV_HUB_HOSTS: `${t.base.replace('http://', '')}/hub/`, LV_NO_GH: '1', ...ai } });
    assert.equal((await calls()).length, 1);
  } finally { await t.cleanup(); }
});

test('e2e: captured replies reach the analysis prompt and ai/links md; --reanalyze-related redoes a link that has not seen them, once', async () => {
  const t = await setup();
  const logFile = path.join(t.dir, 'fake-claude.log');
  const ai = { LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_LOG: logFile, LV_BACKEND: 'claude-code', LV_LOG_DIR: path.join(t.dir, 'logs') };
  const calls = async () => (await fs.readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const reanalyze = () => run(process.execPath, [PROC, '--reanalyze-related', '--no-git'], { env: { ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: t.dir, LV_FXTWITTER_BASE: `${t.base}/fx`, LV_HUB_HOSTS: `${t.base.replace('http://', '')}/hub/`, LV_NO_GH: '1', ...ai } });
  try {
    await t.proc(); // archive: related.json for all three
    const root = path.join(t.dir, 'archive/2026', MIR.id);
    await fs.writeFile(path.join(root, 'related', 'x-replies.json'), JSON.stringify({ schema: 1, id: MIR.id, captured_at: '2026-10-16T01:00:00.000Z', replies: [{ n: 1, handle: '@bob', name: 'Bob', text: 'REPLYMARK see the repo', time: '2026-10-16T01:00:00Z', own: false, links: ['https://example.org/repo'] }], urls: [] }));
    for (const e of [MIR, FLX, NOTOOL]) {
      await fs.mkdir(path.join(t.dir, 'analysis/2026'), { recursive: true });
      await fs.writeFile(path.join(t.dir, 'analysis/2026', `${e.id}.json`), JSON.stringify({ id: e.id, status: 'analyzed', analyzed_at: '2026-10-17T02:00:00.000Z', primary_subject: { kind: 'self', url: null, name: '' }, resource_kind: 'none', title: 't', summary: 's', category: 'AI活用', tags: [], related_used: { posts: 1, resources: 0, replies: 0 } }));
    }
    // analyzed after the capture and related_used.replies is present: only a link with replies the analysis never saw is redone
    await reanalyze();
    assert.equal((await calls()).length, 0);
    const a = JSON.parse(await fs.readFile(path.join(t.dir, 'analysis/2026', `${MIR.id}.json`), 'utf8'));
    delete a.related_used;
    await fs.writeFile(path.join(t.dir, 'analysis/2026', `${MIR.id}.json`), JSON.stringify(a));
    await reanalyze();
    const c = await calls();
    assert.equal(c.length, 1);
    assert.ok(c[0].includes(MIR.id) && c[0].includes('REPLYMARK') && !c[0].includes(NOTOOL.id));
    assert.equal(JSON.parse(await fs.readFile(path.join(t.dir, 'analysis/2026', `${MIR.id}.json`), 'utf8')).related_used.replies, 1);
    assert.match(await fs.readFile(path.join(t.dir, 'ai/links/2026', `${MIR.id}.md`), 'utf8'), /## 他の人のリプ\n[\s\S]*### @bob \(Bob\)[\s\S]*REPLYMARK see the repo\n- link: https:\/\/example.org\/repo/);
    await reanalyze();
    assert.equal((await calls()).length, 1, 'not again');
  } finally { await t.cleanup(); }
});
