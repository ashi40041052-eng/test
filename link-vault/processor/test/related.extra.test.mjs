// v3.1 supplements: profile website fallback + Grok X search. Hermetic: fake fxtwitter / hub / grok binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { extractHubLinks, profileUrls, isHubUrl, xsearchTrigger, urlsFromSearchOutput, buildXsearchArgs } from '../lib/related-extra.mjs';
import { scorePrimary } from '../lib/related.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROC = path.join(HERE, '..', 'process.mjs');
const F = (n) => path.join(HERE, 'fixtures', 'related', n);
const fxj = async (n) => JSON.parse(await fs.readFile(F(n), 'utf8'));
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

test('scorePrimary: profile origin is +1 (loses to a post-primary), x_search is +2', () => {
  const posts = [{ sid: '1', role: 'self', text: 'long enough text about something interesting here', urls: [] },
    { sid: '2', role: 'quote', of: '1', text: 'Introducing Foo', urls: [], author: '@foo' }];
  const base = { posts, objects: { 1: {}, 2: { author: {} } } };
  const prof = scorePrimary({ ...base, resources: [{ type: 'web', key: 'https://foo.ai', url: 'https://foo.ai', found_in: [], origin: 'profile:@foo' }] });
  assert.equal(prof.primary.kind, 'post'); // official quote scores 2 > 1
  assert.equal(prof.resources[0].origin, 'profile:@foo');
  const xs = scorePrimary({ ...base, resources: [{ type: 'web', key: 'https://foo.ai', url: 'https://foo.ai', found_in: [], origin: 'x_search' }] });
  assert.equal(xs.primary.kind, 'resource');
  const only = scorePrimary({ posts: [posts[0]], objects: {}, resources: [{ type: 'web', key: 'https://foo.ai', url: 'https://foo.ai', found_in: [], origin: 'profile:@foo' }] });
  assert.equal(only.primary.kind, 'resource'); // nothing better exists
});

test('x search trigger rules and output parsing', () => {
  const P = (role, text, urls = [], sid = role) => ({ sid, role, text, urls });
  assert.equal(xsearchTrigger([P('self', 'URLはリプ欄に貼ります👇')], []), 'replies');
  assert.equal(xsearchTrigger([P('self', 'リプのURLを見て'), P('self_reply', 'x', ['https://a.example'], 'r')], [{ found_in: ['r'] }]), null); // self thread has one
  assert.equal(xsearchTrigger([P('self', '新しいツールが公開された')], []), 'tool');
  assert.equal(xsearchTrigger([P('self', '新しいツールが公開された')], [{ found_in: [], origin: 'profile:@x' }]), 'tool'); // profile does not count as found
  assert.equal(xsearchTrigger([P('self', '今日の散歩はいい天気')], []), null);
  assert.equal(xsearchTrigger([P('self', '新しいツールが公開された')], [{ found_in: ['self'] }]), null);
  const urls = urlsFromSearchOutput(JSON.stringify({ content: 'see https://a.example/x, and (https://b.example).', citations: ['https://a.example/x'] }));
  assert.deepEqual(urls, ['https://a.example/x', 'https://b.example']);
  const a = buildXsearchArgs({ handle: '@u', sid: '123', publishedAt: '2026-10-16T01:00:00Z' });
  assert.equal(a.from, '2026-10-15'); assert.equal(a.to, '2026-10-19'); assert.match(a.query, /status\/123/);
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

async function world(grokScript) {
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

async function setup(grokBody) {
  const w = await world();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-extra-'));
  const bin = path.join(dir, 'fake-grok.sh');
  const counter = path.join(dir, 'grok-calls.txt');
  await fs.writeFile(bin, `#!/bin/bash\necho "$@" >> '${counter}'\n${grokBody}\n`, { mode: 0o755 });
  for (const e of [MIR, FLX, NOTOOL]) {
    await fs.mkdir(path.join(dir, 'links/2026/10'), { recursive: true });
    await fs.writeFile(path.join(dir, `links/2026/10/${e.id}.json`), JSON.stringify({ id: e.id, url: `https://x.com/${e.user}/status/${e.sid}`, created_at: '2026-10-16T10:00:00+09:00' }));
  }
  const env = {
    ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: dir, LV_CLAUDE_BIN: '/nonexistent/claude', LV_FXTWITTER_BASE: `${w.base}/fx`,
    LV_GROK_BIN: bin, LV_HUB_HOSTS: `${w.base.replace('http://', '')}/hub/`, LV_XSEARCH_COOLDOWN_FILE: path.join(dir, 'cooldown.json'), LV_NO_GH: '1',
  };
  const proc = (extra = {}) => run(process.execPath, [PROC, '--archive-only', '--no-git'], { env: { ...env, ...extra } });
  const calls = async () => (await fs.readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const rj = async (e, rel) => JSON.parse(await fs.readFile(path.join(dir, 'archive/2026', e.id, rel), 'utf8'));
  return { ...w, dir, proc, calls, rj, cleanup: async () => { w.server.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

test('e2e: profile hub fallback + x search stores raw response once, budget, idempotent', async () => {
  const t = await setup(`cat '${F('fake-grok-ok.json')}'`);
  try {
    await t.proc({ LV_XSEARCH_PER_RUN: '3' });
    // Mirelo: quote without url -> profile (hub -> official site) + tool trigger -> x search
    const m = await t.rj(MIR, 'related.json');
    const origins = m.resources.map((r) => r.origin).filter(Boolean);
    assert.ok(origins.includes('profile:@MireloAI'), JSON.stringify(m.resources));
    assert.ok(origins.includes('x_search'));
    const prof = m.resources.find((r) => r.origin === 'profile:@MireloAI');
    assert.match(prof.url, /\/site\/mirelo/);
    assert.ok(prof.ok);
    assert.equal(m.primary.kind, 'resource');
    assert.equal(m.resources[m.primary.n - 1].origin, 'x_search');
    const xs = await t.rj(MIR, 'related/x-search.json');
    assert.match(xs.raw, /sfx-demo/);
    assert.match(xs.query, /status\/3000/);
    assert.equal(xs.cmd.includes('--allowed-handle'), false);
    // Flux-like post: "👇" pointing to replies, no self-thread url -> search too; plain post -> none
    assert.equal((await t.calls()).length, 2);
    await assert.rejects(fs.access(path.join(t.dir, 'archive/2026', NOTOOL.id, 'related/x-search.json')));
    assert.ok((await t.rj(FLX, 'related.json')).resources.some((r) => r.origin === 'profile:@bfl_ai'));
    // second run: nothing new, no search, files untouched
    const before = await fs.readFile(path.join(t.dir, 'archive/2026', MIR.id, 'related.json'), 'utf8');
    const rawBefore = await fs.readFile(path.join(t.dir, 'archive/2026', MIR.id, 'related/x-search.json'), 'utf8');
    await t.proc();
    assert.equal((await t.calls()).length, 2);
    assert.equal(await fs.readFile(path.join(t.dir, 'archive/2026', MIR.id, 'related.json'), 'utf8'), before);
    assert.equal(await fs.readFile(path.join(t.dir, 'archive/2026', MIR.id, 'related/x-search.json'), 'utf8'), rawBefore);
  } finally { await t.cleanup(); }
});

test('e2e: per-run search budget', async () => {
  const t = await setup(`cat '${F('fake-grok-ok.json')}'`);
  try {
    await t.proc({ LV_XSEARCH_PER_RUN: '1' });
    assert.equal((await t.calls()).length, 1);
    await t.proc({ LV_XSEARCH_PER_RUN: '1' }); // the other link gets its search in the next run
    assert.equal((await t.calls()).length, 2);
  } finally { await t.cleanup(); }
});

test('e2e: spending-limit writes a 24h cooldown, skips the rest, never blocks archiving; recovers after cooldown', async () => {
  const t = await setup(`echo 'Error: spending-limit reached' >&2; exit 1`);
  try {
    await t.proc();
    assert.equal((await t.calls()).length, 1, 'one failing call, then the cooldown stops the others');
    const cd = JSON.parse(await fs.readFile(path.join(t.dir, 'cooldown.json'), 'utf8'));
    assert.ok(Date.parse(cd.until) - Date.now() > 23 * 3600 * 1000);
    for (const e of [MIR, FLX, NOTOOL]) assert.equal((await t.rj(e, 'related.json')).schema, 1); // capture finished anyway
    await assert.rejects(fs.access(path.join(t.dir, 'archive/2026', MIR.id, 'related/x-search.json')));
    await t.proc();
    assert.equal((await t.calls()).length, 1, 'cooldown holds');
  } finally { await t.cleanup(); }
});

test('e2e: LV_XSEARCH=0 and a fake-less test double never call grok', async () => {
  const t = await setup(`cat '${F('fake-grok-ok.json')}'`);
  try {
    await t.proc({ LV_XSEARCH: '0' });
    assert.equal((await t.calls()).length, 0);
    assert.equal((await t.rj(MIR, 'related.json')).resources.some((r) => r.origin === 'profile:@MireloAI'), true);
  } finally { await t.cleanup(); }
});

test('e2e: a v3 related.json gains supplement resources later -> --reanalyze-related redoes only that link', async () => {
  const t = await setup(`cat '${F('fake-grok-ok.json')}'`);
  const logFile = path.join(t.dir, 'fake-claude.log');
  const ai = { LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_LOG: logFile, LV_BACKEND: 'claude-code', LV_XSEARCH: '0' };
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
    await t.proc({ LV_XSEARCH: '0' }); // archive-only: supplement appends the profile site
    const m = await t.rj(MIR, 'related.json');
    assert.ok(m.resources.some((r) => r.origin === 'profile:@MireloAI'));
    assert.equal(m.posts.length, 2, 'existing entries untouched');
    assert.ok(m.supplement.resources_added_at > '2026-10-16T02:00:00.000Z');
    await run(process.execPath, [PROC, '--reanalyze-related', '--no-git'], { env: { ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: t.dir, LV_FXTWITTER_BASE: `${t.base}/fx`, LV_GROK_BIN: path.join(t.dir, 'fake-grok.sh'), LV_HUB_HOSTS: `${t.base.replace('http://', '')}/hub/`, LV_NO_GH: '1', ...ai } });
    const c = await calls();
    assert.equal(c.length, 1);
    assert.ok(c[0].includes(MIR.id) && !c[0].includes(NOTOOL.id), 'only the supplemented link is redone');
    assert.match(c[0], /site\/mirelo/);
    // and not again
    await run(process.execPath, [PROC, '--reanalyze-related', '--no-git'], { env: { ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: t.dir, LV_FXTWITTER_BASE: `${t.base}/fx`, LV_GROK_BIN: path.join(t.dir, 'fake-grok.sh'), LV_HUB_HOSTS: `${t.base.replace('http://', '')}/hub/`, LV_NO_GH: '1', ...ai } });
    assert.equal((await calls()).length, 1);
  } finally { await t.cleanup(); }
});
