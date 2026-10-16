// R2 end-to-end: --archive-only against fake fxtwitter v2 / GitHub / HF / arXiv / YouTube / web servers on 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROC = path.join(HERE, '..', 'process.mjs');
const fxj = async (n) => fs.readFile(path.join(HERE, 'fixtures', 'related', n), 'utf8');
process.env.LV_LOCK_FILE = path.join(os.tmpdir(), `lv-test-${process.pid}.lock`);
process.env.LV_LOG_DIR = path.join(os.tmpdir(), `lv-test-logs-${process.pid}`); // never write the production log

const IDS = {
  c07: { id: '20261016-012352-c07e399d', sid: '2110552871565660462', user: 'studio_yebisu', file: 'fx2-thread-c07e399d.json' },
  a27: { id: '20261016-011758-a27279bf', sid: '2110763835175153885', user: 'studio_yebisu', file: 'fx2-thread-a27279bf.json' },
  p84: { id: '20261016-012146-84c52ab8', sid: '2110574328156971471', user: 'studio_yebisu', file: 'fx2-thread-84c52ab8.json' },
  a4a: { id: '20261016-012832-4aeb4268', sid: '2110164449470652678', user: 'studio_yebisu', file: 'fx2-thread-4aeb4268.json' },
  self: { id: '20261016-013224-6ab719ad', sid: '2110727758884352474', user: 'note_makes_life', file: 'fx2-thread-6ab719ad.json' },
};
const mkPost = (id, text, urls) => ({
  id, text, author: { screen_name: 'u', name: 'U' }, created_timestamp: 1792029991,
  raw_text: { text, facets: urls.map((u) => ({ type: 'url', replacement: u })) },
});

async function fakeWorld() {
  const hits = { fx: [], gh: [], hf: [], arxiv: [], arxivAt: [], yt: 0, web: 0 };
  const repo = JSON.parse(await fxj('gh-repo-agent-native.json'));
  const readme = JSON.parse(await fxj('gh-readme-agent-native.json'));
  const hfModel = await fxj('hf-model-drama-3.json');
  const hfReadme = await fxj('hf-readme-drama-3.md');
  const atom = await fxj('arxiv-query-sample.xml');
  const yt = await fxj('yt-oembed-sample.json');
  const server = http.createServer(async (req, res) => {
    const u = req.url;
    const send = (body, type = 'application/json', status = 200) => { res.statusCode = status; res.setHeader('content-type', type); res.end(body); };
    let m;
    if ((m = u.match(/^\/fx\/2\/thread\/(\d+)/))) {
      hits.fx.push(m[1]);
      if (m[1] === '999') return send('{"code":404}', 'application/json', 404);
      if (m[1] === '900') return send(JSON.stringify({ code: 200, status: null, thread: [mkPost('900', 'papers', ['https://arxiv.org/abs/1706.03762', 'https://arxiv.org/abs/1810.04805v2', 'https://youtu.be/dQw4w9WgXcQ'])] }));
      if (m[1] === '901') return send(JSON.stringify({ code: 200, thread: [mkPost('901', 'web', [`${base}/web/page`])] }));
      const e = Object.values(IDS).find((x) => x.sid === m[1]);
      if (!e) return send('{}', 'application/json', 404);
      return send((await fxj(e.file)).replaceAll('https://www.builder.io/blog/introducing-agent-native', `${base}/web/blog`));
    }
    if ((m = u.match(/^\/fx\/([^/]+)\/status\/(\d+)/))) { // v1 for the snapshot
      hits.fx.push('v1:' + m[2]);
      const e = Object.values(IDS).find((x) => x.sid === m[2]);
      if (!e) return send('{"code":404}', 'application/json', 404);
      const t = JSON.parse(await fxj(e.file)).thread.find((x) => x.id === m[2]);
      delete t.media; if (t.quote) delete t.quote.media;
      return send(JSON.stringify({ code: 200, tweet: t }));
    }
    if ((m = u.match(/^\/gh\/repos\/([^/]+\/[^/]+?)(\/readme)?$/))) {
      hits.gh.push(m[1] + (m[2] || ''));
      if (m[1].toLowerCase() === 'marycache/imozuru') {
        if (m[2]) return send(JSON.stringify({ encoding: 'base64', content: Buffer.from('x'.repeat(400_000)).toString('base64') }));
        return send(JSON.stringify({ ...repo, full_name: 'MaryCache/imozuru' }));
      }
      return send(JSON.stringify(m[2] ? readme : repo));
    }
    if ((m = u.match(/^\/hf\/api\/(models|datasets|spaces)\/(.+)$/))) { hits.hf.push(m[2]); return send(hfModel); }
    if (u.match(/^\/hf\/.*\/raw\/main\/README\.md$/)) {
      if (u.includes('/black-forest-labs/')) return send('', 'text/plain', 401); // gated repo: raw files need a login
      return send(hfReadme, 'text/markdown');
    }
    if ((m = u.match(/^\/hf\/black-forest-labs\/([^/?]+)$/))) { hits.hfPage = (hits.hfPage || 0) + 1; return send('<html><head><title>bfl/' + m[1] + '</title></head><body><main><p>You need to agree to share your contact information to access this model</p><h1>FLUX 3 Image Klein</h1>' + '<p>Gated model card text. </p>'.repeat(30) + '</main></body></html>', 'text/html'); }
    if (u.startsWith('/arxiv/api/query')) {
      hits.arxiv.push(u); hits.arxivAt.push(Date.now());
      return send(atom, 'application/atom+xml');
    }
    if (u.startsWith('/yt/oembed')) { hits.yt++; return send(yt); }
    if (u.startsWith('/web/')) { hits.web++; return send('<html><head><title>Blog</title></head><body><article>' + 'Agent native blog. '.repeat(50) + '</article></body></html>', 'text/html'); }
    send('', 'text/plain', 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, hits };
}

async function tree(dir, skip = () => false) {
  const out = {};
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (skip(f)) continue;
      if (e.isDirectory()) await walk(f);
      else out[path.relative(dir, f)] = crypto.createHash('sha1').update(await fs.readFile(f)).digest('hex');
    }
  };
  await walk(dir);
  return out;
}

const rj = async (dir, id, rel) => JSON.parse(await fs.readFile(path.join(dir, 'archive', id.slice(0, 4), id, rel), 'utf8'));

test('related capture: graph, resources, primary, idempotent, truncation, arxiv spacing, gone after 3x 404', async () => {
  const { server, base, hits } = await fakeWorld();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-rel-e2e-'));
  const w = async (rel, obj) => { const f = path.join(dir, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(obj)); };
  const link = async (id, url, t) => w(`links/2026/10/${id}.json`, { id, url, created_at: t });
  for (const [i, e] of Object.values(IDS).entries()) await link(e.id, `https://x.com/${e.user}/status/${e.sid}?s=46`, `2026-10-16T10:0${i}:00+09:00`);
  const ARX = '20261016-020000-arx00001', GONE = '20261016-020100-gone0001', WEB = '20261016-020200-web00001';
  await link(ARX, 'https://x.com/u/status/900', '2026-10-16T11:00:00+09:00');
  await link(GONE, 'https://x.com/nobody/status/999', '2026-10-16T11:01:00+09:00');
  await link(WEB, 'https://x.com/u/status/901', '2026-10-16T11:02:00+09:00');
  const env = {
    ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: dir, LV_CLAUDE_BIN: '/nonexistent/claude',
    LV_FXTWITTER_BASE: `${base}/fx`, LV_GITHUB_BASE: `${base}/gh`, LV_HF_BASE: `${base}/hf`, LV_ARXIV_BASE: `${base}/arxiv`, LV_YOUTUBE_BASE: `${base}/yt`,
  };
  const proc = () => run(process.execPath, [PROC, '--archive-only', '--no-git'], { env });
  try {
    await proc();
    // c07e399d: github repo, README, blog; primary = github
    const c = await rj(dir, IDS.c07.id, 'related.json');
    assert.equal(c.schema, 1);
    assert.equal(c.root, IDS.c07.sid);
    assert.deepEqual(c.posts.map((p) => p.role), ['parent', 'self', 'self_reply', 'quote']);
    assert.equal(c.primary.kind, 'resource');
    const gh = c.resources[c.primary.n - 1];
    assert.equal(gh.type, 'github');
    assert.equal(gh.ok, true);
    const meta = await rj(dir, IDS.c07.id, gh.meta);
    assert.equal(meta.full_name, 'BuilderIO/agent-native');
    assert.ok(meta.stars > 0);
    assert.match(await fs.readFile(path.join(dir, 'archive/2026', IDS.c07.id, gh.text), 'utf8'), /agent|Agent/);
    assert.ok(c.resources.some((r) => r.type === "web" && r.ok), JSON.stringify(c.resources));
    await fs.access(path.join(dir, 'archive/2026', IDS.c07.id, 'related/posts', IDS.c07.sid + '.json'));
    // a27279bf: HF; 4aeb4268: HF model card; self: no resources
    const a = await rj(dir, IDS.a27.id, 'related.json');
    assert.equal(a.primary.kind, 'resource');
    assert.equal(a.resources[0].type, 'hf');
    assert.equal(a.resources.length, 2);
    // gated HF repo: raw README is 401, so the model card text comes from the public page
    assert.ok(a.resources.every((r) => r.ok && r.text), JSON.stringify(a.resources));
    const gated = await rj(dir, IDS.a27.id, a.resources[0].meta);
    assert.equal(gated.body_source, 'page');
    assert.match(await fs.readFile(path.join(dir, 'archive/2026', IDS.a27.id, a.resources[0].text), 'utf8'), /Gated model card text/);
    assert.equal((await rj(dir, IDS.a4a.id, (await rj(dir, IDS.a4a.id, 'related.json')).resources[0].meta)).body_source, 'readme');
    const hfMeta = await rj(dir, IDS.a4a.id, (await rj(dir, IDS.a4a.id, 'related.json')).resources[0].meta);
    assert.ok(hfMeta.downloads >= 0);
    assert.deepEqual((await rj(dir, IDS.self.id, 'related.json')).primary.kind, 'self');
    // 84c52ab8: 400k README is cut to 300k with truncated:true
    const p84 = await rj(dir, IDS.p84.id, 'related.json');
    const big = p84.resources[0];
    assert.equal(big.type, 'github');
    assert.equal(big.bytes, 300_000);
    assert.equal(big.truncated, true);
    assert.equal((await rj(dir, IDS.p84.id, big.meta)).truncated, true);
    // arxiv: two calls at least 3 s apart; youtube oembed used
    assert.equal(hits.arxiv.length, 2);
    assert.ok(hits.arxivAt[1] - hits.arxivAt[0] >= 2900, `arxiv gap ${hits.arxivAt[1] - hits.arxivAt[0]}ms`);
    const ar = await rj(dir, ARX, 'related.json');
    assert.deepEqual(ar.resources.map((r) => r.type).sort(), ['arxiv', 'arxiv', 'youtube']);
    assert.ok(ar.resources.every((r) => r.ok));
    // second run changes nothing (except the failing link's bookkeeping)
    const skip = (f) => f.includes(GONE) || f.endsWith('/attempts.json'); // synthetic posts have no v1 snapshot
    const before = await tree(dir, skip);
    await proc();
    assert.deepEqual(await tree(dir, skip), before);
    // gone after 3 not-found
    await proc();
    const att = await rj(dir, GONE, 'related-attempts.json');
    assert.equal(att.gone, true);
    assert.equal(att.count, 3);
    const calls = hits.fx.filter((x) => x === '999').length;
    await proc();
    assert.equal(hits.fx.filter((x) => x === '999').length, calls, 'gone links are not retried every run');
    // a phone-made related/thread.json is used instead of fetching
    const SID = '2110727758884352999', PH = '20261016-030000-phone001';
    await link(PH, `https://x.com/u/status/${SID}`, '2026-10-16T12:00:00+09:00');
    await w(`archive/2026/${PH}/related/thread.json`, { code: 200, thread: [mkPost(SID, 'phone thread', [])] });
    await proc();
    assert.equal((await rj(dir, PH, 'related.json')).thread_from, 'phone');
    assert.ok(!hits.fx.includes(SID));
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('failed resources keep related.json and are retried later', async () => {
  const { server, base } = await fakeWorld();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-rel-e2e-'));
  const id = '20261016-040000-retry001';
  await fs.mkdir(path.join(dir, 'links/2026/10'), { recursive: true });
  await fs.writeFile(path.join(dir, `links/2026/10/${id}.json`), JSON.stringify({ id, url: 'https://x.com/u/status/901', created_at: '2026-10-16T13:00:00+09:00' }));
  const env = { ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: dir, LV_CLAUDE_BIN: '/nonexistent/claude', LV_FXTWITTER_BASE: `${base}/fx`, LV_GITHUB_BASE: `${base}/gh`, LV_HF_BASE: `${base}/hf` };
  try {
    // 901's only resource is on the fake web server; stop it first so the fetch fails
    // (the fx fake is the same server, so serve the thread from a phone-made file instead)
    await fs.mkdir(path.join(dir, 'archive/2026', id, 'related'), { recursive: true });
    await fs.writeFile(path.join(dir, 'archive/2026', id, 'related/thread.json'), JSON.stringify({ thread: [{ id: '901', text: 'x', author: { screen_name: 'u' }, raw_text: { facets: [{ type: 'url', replacement: 'http://127.0.0.1:9/dead' }] } }] }));
    await run(process.execPath, [PROC, '--archive-only', '--no-git'], { env });
    const r = await rj(dir, id, 'related.json');
    assert.equal(r.resources[0].ok, false);
    assert.ok(r.resources[0].error);
    const before = await fs.readFile(path.join(dir, 'archive/2026', id, 'related.json'), 'utf8');
    await run(process.execPath, [PROC, '--archive-only', '--no-git'], { env });
    assert.equal(await fs.readFile(path.join(dir, 'archive/2026', id, 'related.json'), 'utf8'), before);
    assert.equal((await rj(dir, id, 'related/res-attempts.json')).count, 1);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('analysis uses the subject; --reanalyze-related redoes only links that lack primary_subject', async () => {
  const { server, base } = await fakeWorld();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-rel-e2e-'));
  const logFile = path.join(dir, 'fake-claude.log');
  const link = async (e, t) => { const f = path.join(dir, `links/2026/10/${e.id}.json`); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify({ id: e.id, url: `https://x.com/${e.user}/status/${e.sid}`, created_at: t })); };
  await link(IDS.c07, '2026-10-16T10:00:00+09:00');
  await link(IDS.self, '2026-10-16T10:01:00+09:00');
  const env = {
    ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: dir, LV_BACKEND: 'claude-code', LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_LOG: logFile,
    LV_FXTWITTER_BASE: `${base}/fx`, LV_GITHUB_BASE: `${base}/gh`, LV_HF_BASE: `${base}/hf`,
  };
  const proc = (...a) => run(process.execPath, [PROC, '--no-git', ...a], { env });
  const ana = async (e) => JSON.parse(await fs.readFile(path.join(dir, 'analysis/2026', `${e.id}.json`), 'utf8'));
  const calls = async () => (await fs.readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  try {
    await proc();
    const a = await ana(IDS.c07);
    assert.equal(a.primary_subject.kind, 'resource');
    assert.equal(a.primary_subject.url, 'https://github.com/builderio/agent-native');
    assert.equal(a.resource_kind, 'repository');
    assert.equal(a.related_used.resources, 2);
    assert.equal(a.primary_rule.kind, 'resource');
    assert.equal((await ana(IDS.self)).primary_subject.kind, 'self');
    const first = await calls();
    assert.equal(first.length, 1);
    assert.ok(first[0].input.indexOf('<subject') < first[0].input.indexOf('<content'), 'subject comes before content');
    assert.match(first[0].input, /<context>/);
    const md = await fs.readFile(path.join(dir, 'ai/links/2026', `${IDS.c07.id}.md`), 'utf8');
    assert.ok(md.indexOf('## 主題リソース') > 0 && md.indexOf('## 主題リソース') < md.indexOf('## 文脈') && md.indexOf('## 文脈') < md.indexOf('## 本文'));
    assert.match(md, /primary_name: BuilderIO\/agent-native/);
    const man = (await fs.readFile(path.join(dir, 'ai/manifest.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(man.find((m) => m.id === IDS.c07.id).pk, 'r');
    // index.json carries the AI's subject (the dashboard reads items[].primary_subject)
    const idx = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.deepEqual(idx.items.find((i) => i.id === IDS.c07.id).primary_subject, a.primary_subject);
    assert.equal(idx.items.find((i) => i.id === IDS.c07.id).resource_kind, 'repository');
    assert.equal(idx.items.find((i) => i.id === IDS.self.id).primary_subject.kind, 'self');

    // nothing to re-analyze while both have primary_subject
    await proc('--reanalyze-related');
    assert.equal((await calls()).length, 1);
    // drop primary_subject from one analysis (a v2-era analysis) -> only that one is redone
    const f = path.join(dir, 'analysis/2026', `${IDS.c07.id}.json`);
    const old = await ana(IDS.c07); delete old.primary_subject; delete old.resource_kind;
    await fs.writeFile(f, JSON.stringify(old));
    await proc('--reanalyze-related');
    const after = await calls();
    assert.equal(after.length, 2);
    assert.ok(after[1].input.includes(IDS.c07.id) && !after[1].input.includes(IDS.self.id));
    assert.equal((await ana(IDS.c07)).primary_subject.kind, 'resource');
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
