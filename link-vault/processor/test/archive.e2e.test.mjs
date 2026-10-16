// End-to-end for --archive-only against a fake FxTwitter + fake web server on 127.0.0.1.
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
const fixture = async (n) => JSON.parse(await fs.readFile(path.join(HERE, 'fixtures', `fx-${n}.json`), 'utf8'));
process.env.LV_LOCK_FILE = path.join(os.tmpdir(), `lv-test-${process.pid}.lock`); // test files run in parallel
const IMG = Buffer.from('FAKE-JPEG-BYTES');

async function fakeServer() {
  const pent = await fixture('pentacoxian'), yeb = await fixture('yebisu');
  const hits = { fx: [], web: 0 };
  const server = http.createServer((req, res) => {
    const u = req.url;
    const th = u.match(/^\/fx\/2\/thread\/(\d+)/); // related capture (v3): the post alone, without urls so nothing external is fetched
    if (th) {
      hits.fx.push('thread:' + th[1]);
      if (th[1] === '999') { res.statusCode = 404; res.end('{"code":404}'); return; }
      const t = JSON.parse(JSON.stringify((th[1] === '2110755123748340030' ? pent : yeb).tweet));
      t.id = th[1]; t.text = String(t.text).replace(/https?:\/\/\S+/g, ''); delete t.card; delete t.quote; t.raw_text = { text: t.text, facets: [] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 200, status: t, thread: [t] }));
      return;
    }
    const m = u.match(/^\/fx\/([^/]+)\/status\/(\d+)/);
    if (m) {
      hits.fx.push(m[2]);
      if (m[2] === '999') { res.statusCode = 404; res.end('{"code":404,"message":"NOT_FOUND"}'); return; }
      const src = m[2] === '2110755123748340030' ? pent : yeb;
      const t = JSON.parse(JSON.stringify(src.tweet));
      if (t.media?.all) for (const x of t.media.all) x.url = `${base}/img/${x.id}.jpg?name=orig`;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 200, message: 'OK', tweet: t }));
      return;
    }
    if (u.startsWith('/img/')) { res.setHeader('content-type', 'image/jpeg'); res.end(IMG); return; }
    if (u.startsWith('/page')) { hits.web++; res.setHeader('content-type', 'text/html'); res.end('<html><head><title>Hello</title></head><body><article>' + 'long body. '.repeat(2000) + '</article></body></html>'); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, hits };
}

async function tree(dir) {
  const out = {};
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else out[path.relative(dir, f)] = crypto.createHash('sha1').update(await fs.readFile(f)).digest('hex');
    }
  };
  await walk(dir);
  return out;
}

const W = (dir) => async (rel, obj) => { const f = path.join(dir, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(obj)); };

test('--archive-only: snapshots + media for X and web, idempotent, no analysis, links/ untouched, gone after 3x 404', async () => {
  const { server, base, hits } = await fakeServer();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-arch-e2e-'));
  const w = W(dir);
  const ids = { x1: '20261016-011607-06fd91fe', x2: '20261016-012630-edf5281f', web: '20261016-013000-aaaa0001', gone: '20261016-014000-bbbb0001', memo: '20261016-015000-cccc0001' };
  await w(`links/2026/10/${ids.x1}.json`, { id: ids.x1, url: 'https://x.com/pentacoxian_dev/status/2110755123748340030?s=46', created_at: '2026-10-16T10:16:07+09:00' });
  await w(`links/2026/10/${ids.x2}.json`, { id: ids.x2, url: 'https://x.com/studio_yebisu/status/2110515075236983170?s=46', created_at: '2026-10-16T10:26:30+09:00' });
  await w(`links/2026/10/${ids.web}.json`, { id: ids.web, url: `${base}/page`, created_at: '2026-10-16T10:30:00+09:00' });
  await w(`links/2026/10/${ids.gone}.json`, { id: ids.gone, url: 'https://x.com/nobody/status/999', created_at: '2026-10-16T10:40:00+09:00' });
  await w(`links/2026/10/${ids.memo}.json`, { id: ids.memo, url: null, note: 'memo', created_at: '2026-10-16T10:50:00+09:00' });
  const linksBefore = await tree(path.join(dir, 'links'));
  const env = { ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: dir, LV_FXTWITTER_BASE: `${base}/fx`, LV_CLAUDE_BIN: '/nonexistent/claude' };
  const proc = () => run(process.execPath, [PROC, '--archive-only', '--no-git'], { env });
  const snapPath = (id) => path.join(dir, 'archive', id.slice(0, 4), id, 'snapshot.json');
  try {
    await proc();
    const s1 = JSON.parse(await fs.readFile(snapPath(ids.x1), 'utf8'));
    assert.equal(s1.schema, 1);
    assert.equal(s1.captured_by, 'processor');
    assert.equal(s1.media[0].local, 'media/01.jpg');
    assert.equal(await fs.readFile(path.join(dir, 'archive/2026', ids.x1, 'media/01.jpg'), 'utf8'), IMG.toString());
    assert.equal(s1.media[0].sha256, crypto.createHash('sha256').update(IMG).digest('hex'));
    const sw = JSON.parse(await fs.readFile(snapPath(ids.web), 'utf8'));
    assert.equal(sw.source_type, 'web');
    assert.ok(sw.web.text.length > 12000, 'web text is kept far beyond the 12k prompt limit');
    await fs.access(snapPath(ids.x2));
    await assert.rejects(fs.access(snapPath(ids.memo)));
    await assert.rejects(fs.access(path.join(dir, 'analysis')).then(() => fs.readdir(path.join(dir, 'analysis')).then((l) => { if (l.length) throw new Error('analysis written'); else throw new Error('none'); })), /none|ENOENT/);
    const att = JSON.parse(await fs.readFile(path.join(dir, 'archive/2026', ids.gone, 'attempts.json'), 'utf8'));
    assert.deepEqual([att.count, att.gone], [1, false]);
    // ai/ was regenerated, with snapshot text for pending links
    const md = await fs.readFile(path.join(dir, 'ai/links/2026', `${ids.x1}.md`), 'utf8');
    assert.match(md, /archived: true/);
    assert.match(md, /status: pending/);
    assert.match(await fs.readFile(path.join(dir, 'ai/llms.txt'), 'utf8'), /アーカイブ済み 3/);

    // second run: nothing changes (snapshots are not re-fetched; only the failing link is retried)
    const hitsBefore = hits.fx.length;
    const t1 = await tree(dir);
    await proc();
    const t2 = await tree(dir);
    const changed = Object.keys({ ...t1, ...t2 }).filter((k) => t1[k] !== t2[k]);
    assert.deepEqual(changed, [`archive/2026/${ids.gone}/attempts.json`, `archive/2026/${ids.gone}/related-attempts.json`]);
    assert.equal(hits.fx.length - hitsBefore, 2, 'only the missing post was requested again (snapshot + thread)');
    assert.equal(hits.web, 1);

    // third 404 -> gone; afterwards not retried every run
    await proc();
    const g = JSON.parse(await fs.readFile(path.join(dir, 'archive/2026', ids.gone, 'attempts.json'), 'utf8'));
    assert.deepEqual([g.count, g.gone], [3, true]);
    const n = hits.fx.length;
    await proc();
    assert.equal(hits.fx.length, n, 'gone links are only retried weekly');

    // a snapshot is never rewritten, even if the source changed
    const before = await fs.readFile(snapPath(ids.x1), 'utf8');
    await proc();
    assert.equal(await fs.readFile(snapPath(ids.x1), 'utf8'), before);

    // missing media file is added later without touching snapshot.json
    await fs.unlink(path.join(dir, 'archive/2026', ids.x1, 'media/01.jpg'));
    await proc();
    assert.equal(await fs.readFile(path.join(dir, 'archive/2026', ids.x1, 'media/01.jpg'), 'utf8'), IMG.toString());
    assert.equal(await fs.readFile(snapPath(ids.x1), 'utf8'), before);
    assert.deepEqual(await tree(path.join(dir, 'links')), linksBefore, 'links/ untouched');
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('analysis run reads the snapshot instead of fetching live, and deleted links lose their ai/ file but keep archive/', async () => {
  const { server, base, hits } = await fakeServer();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-arch-e2e2-'));
  const w = W(dir);
  const id = '20261016-013000-aaaa0001', id2 = '20261016-013100-aaaa0002';
  await w(`links/2026/10/${id}.json`, { id, url: `${base}/page`, created_at: '2026-10-16T10:30:00+09:00' });
  await w(`links/2026/10/${id2}.json`, { id: id2, url: `${base}/page2`, created_at: '2026-10-16T10:31:00+09:00' });
  const logFile = path.join(dir, 'fake-claude.log');
  const env = { ...process.env, LV_NO_ENV_FILE: '1', LV_DATA_DIR: dir, LV_FXTWITTER_BASE: `${base}/fx`, LV_BACKEND: 'claude-code', LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_LOG: logFile };
  try {
    await run(process.execPath, [PROC, '--no-git'], { env });
    assert.equal(hits.web, 2, 'page fetched once by the archive step each; analysis reuses the snapshot');
    const calls = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.match(calls[0].input, /long body/);
    await fs.access(path.join(dir, 'ai/links/2026', `${id}.md`));
    assert.match(await fs.readFile(path.join(dir, 'ai/links/2026', `${id}.md`), 'utf8'), /status: analyzed/);

    await w('events/2026/10/20261016-020000-ev000001.json', { id: '20261016-020000-ev000001', target: id, action: 'delete', at: '2026-10-16T02:00:00.000Z' });
    await run(process.execPath, [PROC, '--no-git'], { env });
    await assert.rejects(fs.access(path.join(dir, 'ai/links/2026', `${id}.md`)), 'deleted link leaves ai/');
    await fs.access(path.join(dir, 'archive/2026', id, 'snapshot.json'));
    assert.ok(!(await fs.readFile(path.join(dir, 'ai/manifest.jsonl'), 'utf8')).includes(id));
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('git mode: second archive-only run commits nothing; conflicting archive/ file from the phone resolves to the remote copy', async () => {
  const { server, base } = await fakeServer();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-arch-git-'));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
  const g = (cwd, ...a) => run('git', a, { cwd, env: gitEnv });
  const who = ['-c', 'user.name=phone', '-c', 'user.email=phone@example.com'];
  const remote = path.join(root, 'remote.git'), phone = path.join(root, 'phone'), pc = path.join(root, 'pc');
  const id = '20261016-011607-06fd91fe';
  try {
    await g(root, 'init', '--bare', '-b', 'main', remote);
    await g(root, 'clone', remote, phone);
    await fs.writeFile(path.join(phone, 'README.md'), '# data\n');
    await W(phone)(`links/2026/10/${id}.json`, { id, url: 'https://x.com/pentacoxian_dev/status/2110755123748340030', created_at: '2026-10-16T10:16:07+09:00' });
    await g(phone, 'add', '-A'); await g(phone, ...who, 'commit', '-m', 'link'); await g(phone, 'push', 'origin', 'HEAD:main');
    await g(root, 'clone', remote, pc);
    const env = { ...gitEnv, LV_NO_ENV_FILE: '1', LV_DATA_DIR: pc, LV_FXTWITTER_BASE: `${base}/fx` };
    const proc = () => run(process.execPath, [PROC, '--archive-only'], { env });

    await proc();
    const count = async (d) => (await g(d, 'rev-list', '--count', 'HEAD')).stdout.trim();
    await g(phone, 'pull', '--rebase');
    assert.ok((await fs.stat(path.join(phone, 'archive/2026', id, 'snapshot.json'))).isFile(), 'pushed to the remote');
    assert.match((await g(phone, 'log', '-1', '--format=%s')).stdout, /^archive: 1 snapshots/);
    const c1 = await count(phone);
    await proc();
    await g(phone, 'pull', '--rebase');
    assert.equal(await count(phone), c1, 'nothing new -> no commit');

    // conflict: the PC made (and committed) a snapshot locally while the phone pushed a different one
    const id2 = '20261016-012630-edf5281f';
    await W(phone)(`links/2026/10/${id2}.json`, { id: id2, url: 'https://x.com/studio_yebisu/status/2110515075236983170', created_at: '2026-10-16T10:26:30+09:00' });
    await g(phone, 'add', '-A'); await g(phone, ...who, 'commit', '-m', 'link2'); await g(phone, 'push', 'origin', 'HEAD:main');
    await g(pc, 'pull', '--rebase');
    await run(process.execPath, [PROC, '--archive-only', '--no-git'], { env });
    await g(pc, 'add', '-A'); await g(pc, ...who, 'commit', '-m', 'pc local snapshot');
    const p2 = path.join(phone, 'archive/2026', id2);
    await fs.mkdir(path.join(p2, 'media'), { recursive: true });
    await fs.writeFile(path.join(p2, 'snapshot.json'), '{"schema":1,"captured_by":"phone"}\n');
    await fs.writeFile(path.join(p2, 'media/01.jpg'), 'PHONE-IMG');
    await g(phone, 'add', '-A'); await g(phone, ...who, 'commit', '-m', 'phone snapshot'); await g(phone, 'push', 'origin', 'HEAD:main');
    await proc();
    await assert.rejects(fs.access(path.join(pc, '.git', 'rebase-merge')), 'not left mid-rebase');
    assert.equal(JSON.parse(await fs.readFile(path.join(pc, 'archive/2026', id2, 'snapshot.json'), 'utf8')).captured_by, 'phone', 'remote copy wins');
    assert.equal((await g(pc, 'status', '-sb')).stdout.split('\n')[0].includes('ahead'), false, 'pushed');
  } finally {
    server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
