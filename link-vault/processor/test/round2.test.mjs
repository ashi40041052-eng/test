// Round 2 fixes: x-replies main=null, default related re-check, lock liveness/heartbeat, gitPull archive/ conflicts,
// manifest tag cap, x-replies status (llms.txt + dashboard server). Hermetic: temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { captureXReplies, setXrepliesDriver, setXrepliesResolver } from '../lib/x-replies.mjs';
import { buildAi } from '../lib/ai-build.mjs';
import { untrackedOverwritePaths } from '../lib/util.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROC = path.join(HERE, '..', 'process.mjs');
const tmp = (p = 'lv-r2-') => fs.mkdtemp(path.join(os.tmpdir(), p));
const baseEnv = (extra = {}) => ({ ...process.env, LV_NO_ENV_FILE: '1', LV_FXTWITTER_BASE: 'http://127.0.0.1:9', LV_LOG_DIR: path.join(os.tmpdir(), `lv-r2-logs-${process.pid}`), ...extra });

// ---- 1. main=null is an error ----
test('x-replies: main post missing -> error, attempt counted, no file; skipped after 3', async () => {
  const d = await tmp();
  process.env.LV_XREPLIES_LOGIN_FILE = path.join(d, 'login.json');
  process.env.LV_XREPLIES_LOCK_FILE = path.join(d, 'x.lock');
  process.env.LV_XREPLIES_FAST = '1';
  process.env.LV_LOG_DIR = d;
  delete process.env.LV_XREPLIES;
  let calls = 0;
  // a page with replies but without the main post (sid 100)
  const html = '<article><div data-testid="User-Name"><span>B</span><span>@bob</span></div><a href="/bob/status/101"><time datetime="2026-10-01T00:00:01.000Z">1h</time></a><div data-testid="tweetText">hi</div></article>';
  setXrepliesDriver({ loadThread: async () => { calls++; return { finalUrl: 'https://x.com/a/status/100', snapshots: [html] }; } });
  setXrepliesResolver(async () => '');
  const args = { relatedRoot: d, id: 'i1', statusUrl: 'u', sid: '100' };
  for (let i = 0; i < 3; i++) assert.equal((await captureXReplies({ ...args, budget: { xreplies: 5 } })).status, 'error');
  await assert.rejects(fs.access(path.join(d, 'related', 'x-replies.json')));
  assert.equal(JSON.parse(await fs.readFile(path.join(d, 'related', 'x-replies-attempts.json'), 'utf8')).count, 3);
  assert.equal((await captureXReplies({ ...args, budget: { xreplies: 5 } })).status, 'skipped');
  assert.equal(calls, 3);
  // status file (item 7): last reason is the error, no ok yet
  const st = JSON.parse(await fs.readFile(path.join(d, 'x-replies-status.json'), 'utf8'));
  assert.equal(st.state, 'error'); assert.match(st.reason, /main post not found/); assert.equal(st.last_ok_at, null);
  // an ok capture records ok + keeps nothing stale
  const ok = '<article><div data-testid="User-Name"><span>A</span><span>@a</span></div><a href="/a/status/200"><time datetime="2026-10-01T00:00:00.000Z">1h</time></a><div data-testid="tweetText">main</div></article>';
  setXrepliesDriver({ loadThread: async () => ({ finalUrl: 'x', snapshots: [ok] }) });
  assert.equal((await captureXReplies({ relatedRoot: await tmp(), id: 'i2', statusUrl: 'u', sid: '200', budget: { xreplies: 1 } })).status, 'done');
  const st2 = JSON.parse(await fs.readFile(path.join(d, 'x-replies-status.json'), 'utf8'));
  assert.equal(st2.state, 'ok'); assert.ok(st2.last_ok_at);
  setXrepliesDriver(null);
  delete process.env.LV_LOG_DIR;
});

// ---- 2. related re-check is the default ----
test('process: a newer x-replies.json triggers re-analysis with no flags; --no-reanalyze-related opts out', async () => {
  const dir = await tmp();
  const id = '20261016-090000-aaaa0001';
  const w = async (rel, o) => { const f = path.join(dir, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, typeof o === 'string' ? o : JSON.stringify(o)); };
  await w(`links/2026/10/${id}.json`, { id, url: 'http://127.0.0.1:9/page', created_at: '2026-10-16T09:00:00+09:00' });
  await w(`archive/2026/${id}/snapshot.json`, { schema: 1, id, source_type: 'web', canonical_url: 'http://127.0.0.1:9/page', captured_at: '2026-10-16T00:00:00Z', captured_by: 'test', text: 'body', media: [] });
  await w(`archive/2026/${id}/related.json`, { schema: 1, id, posts: [], resources: [], supplement: {} });
  await w(`analysis/2026/${id}.json`, { id, status: 'analyzed', analyzed_at: '2026-10-16T01:00:00.000Z', title: 't', summary: 's', key_points: [], category: 'AI活用', tags: [], primary_subject: { kind: 'self', url: null, name: '' }, related_used: { posts: 0, resources: 0, replies: 0 } });
  await w('categories.json', [{ name: 'AI活用', description: '', created_at: '2026-10-01T00:00:00Z' }]);
  const logFile = path.join(dir, 'fake.log');
  const env = baseEnv({ LV_DATA_DIR: dir, LV_BACKEND: 'claude-code', LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_LOG: logFile, LV_LOCK_FILE: path.join(dir, 'lock') });
  const proc = (...a) => run(process.execPath, [PROC, '--no-git', ...a], { env });
  const calls = async () => (await fs.readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
  try {
    await proc();
    assert.equal(await calls(), 0, 'nothing new: no AI call');
    await w(`archive/2026/${id}/related/x-replies.json`, { schema: 1, id, captured_at: '2026-10-16T05:00:00.000Z', main: null, replies: [{ n: 1, handle: '@bob', name: 'Bob', text: 'see the repo', own: false, links: [] }], urls: [] });
    await proc('--no-reanalyze-related');
    assert.equal(await calls(), 0, 'opt-out');
    await proc();
    assert.equal(await calls(), 1, 'default run re-analyzes');
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, `analysis/2026/${id}.json`), 'utf8')).related_used.replies, 1);
    await proc();
    assert.equal(await calls(), 1, 'and only once');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---- 3. lock ----
test('process lock: a live pid blocks even when the file is old; a dead pid is stale; heartbeat refreshes mtime', async () => {
  const dir = await tmp();
  const lock = path.join(dir, 'lock');
  await fs.mkdir(path.join(dir, 'links'), { recursive: true });
  const env = baseEnv({ LV_DATA_DIR: dir, LV_LOCK_FILE: lock });
  const proc = (extra = {}) => run(process.execPath, [PROC, '--no-git', '--archive-only'], { env: { ...env, ...extra } });
  const old = new Date(Date.now() - 5 * 3600_000);
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    await fs.writeFile(lock, String(sleeper.pid)); await fs.utimes(lock, old, old);
    const a = await proc();
    assert.match(a.stdout, /another run is in progress/);
    assert.equal(await fs.readFile(lock, 'utf8'), String(sleeper.pid), 'live lock untouched');
    sleeper.kill(); await new Promise((r) => sleeper.once('exit', r));
    await fs.writeFile(lock, String(sleeper.pid)); // now a dead pid, fresh mtime
    const b = await proc();
    assert.doesNotMatch(b.stdout, /another run is in progress/);
    await assert.rejects(fs.access(lock), 'released after the run');
    // heartbeat: during the run (held open by the fake claude hook) the lock mtime moves forward
    const rec = '20261016-090000-bbbb0001';
    await fs.mkdir(path.join(dir, 'links/2026/10'), { recursive: true });
    await fs.writeFile(path.join(dir, `links/2026/10/${rec}.json`), JSON.stringify({ id: rec, url: 'http://127.0.0.1:9/p', created_at: '2026-10-16T09:00:00+09:00' }));
    const out = path.join(dir, 'mt.txt');
    // the fake claude hook ages the lock, waits, then reports the mtime the running processor left on it
    await run(process.execPath, [PROC, '--no-git'], { env: { ...env, LV_BACKEND: 'claude-code', LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_HOOK: `touch -t 202001010000 ${lock}; sleep 1; node -e "const fs=require('fs');fs.writeFileSync('${out}',String(fs.statSync('${lock}').mtimeMs))"`, LV_LOCK_HEARTBEAT_MS: '100' } });
    assert.ok(Number(await fs.readFile(out, 'utf8')) > Date.now() - 60_000, 'lock mtime was refreshed while the run was alive');
  } finally { sleeper.kill(); await fs.rm(dir, { recursive: true, force: true }); }
});

// ---- 4. gitPull ----
test('untrackedOverwritePaths parses git output', () => {
  const t = "error: The following untracked working tree files would be overwritten by checkout:\n\tarchive/2026/x/snapshot.json\n\tlinks/y.json\nPlease move or remove them before you switch branches.\nAborting\n";
  assert.deepEqual(untrackedOverwritePaths(t), ['archive/2026/x/snapshot.json', 'links/y.json']);
  assert.deepEqual(untrackedOverwritePaths('nothing'), []);
});

test('gitPull e2e: untracked local archive/ files that the remote also has are removed (remote wins) and the pull is retried', async () => {
  const root = await tmp();
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const bare = path.join(root, 'remote.git'), a = path.join(root, 'a'), b = path.join(root, 'b');
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['clone', '-q', bare, a], { stdio: 'ignore' });
    await fs.writeFile(path.join(a, 'README.md'), 'x'); g(a, 'add', '-A'); g(a, 'commit', '-qm', 'init'); g(a, 'push', '-q', '-u', 'origin', 'HEAD:main');
    execFileSync('git', ['clone', '-q', bare, b], { stdio: 'ignore' });
    // the other PC pushes archive/ files; this PC created the same files locally, untracked
    const rel = 'archive/2026/20261016-000000-aaaa0001/snapshot.json';
    await fs.mkdir(path.join(a, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(a, rel), 'REMOTE'); await fs.writeFile(path.join(a, 'links.txt'), 'remote-links');
    g(a, 'add', '-A'); g(a, 'commit', '-qm', 'remote archive'); g(a, 'push', '-q');
    await fs.mkdir(path.join(b, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(b, rel), 'LOCAL');
    await fs.writeFile(path.join(b, 'links.txt'), 'local-only'); // not under archive/: must NOT be removed
    // 1) a non-archive file in the way is never removed (that pull cannot succeed, which is the old behaviour)
    const c = path.join(root, 'c');
    execFileSync('git', ['clone', '-q', bare, c], { stdio: 'ignore' });
    await fs.rm(path.join(c, 'links.txt'), { force: true });
    g(c, 'reset', '-q', '--hard', 'HEAD~1');
    await fs.mkdir(path.join(c, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(c, 'links.txt'), 'local-only');
    await run(process.execPath, [PROC, '--archive-only'], { env: baseEnv({ LV_DATA_DIR: c, LV_LOCK_FILE: path.join(root, 'lock') }) }).catch(() => {});
    assert.equal(await fs.readFile(path.join(c, 'links.txt'), 'utf8'), 'local-only');
    const env = baseEnv({ LV_DATA_DIR: b, LV_LOCK_FILE: path.join(root, 'lock') });
    await fs.rm(path.join(b, 'links.txt'));
    // 2) only archive/ files in the way -> removed, retried, remote copy wins
    const r = await run(process.execPath, [PROC, '--archive-only'], { env });
    assert.match(r.stdout, /remote wins/);
    assert.equal(await fs.readFile(path.join(b, rel), 'utf8'), 'REMOTE');
    assert.match(g(b, 'log', '--oneline', '-5'), /remote archive/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// ---- 7. status in llms.txt ----
test('llms.txt shows the x-replies status', () => {
  const mk = (xrepliesStatus) => buildAi({ items: [], byId: new Map(), analyses: new Map(), archives: new Map(), cats: [], lastChange: null, pendingCount: 0, xrepliesStatus })['ai/llms.txt'];
  assert.match(mk({ state: 'skip', reason: 'login required', at: '2026-10-17T01:00:00.000Z', last_ok_at: '2026-10-16T01:00:00.000Z' }), /## リプ取得 {2}スキップ\(login required\) 2026-10-17T01:00:00.000Z \/ 最終成功 2026-10-16T01:00:00.000Z/);
  assert.doesNotMatch(mk(null), /リプ取得/);
});

test('dashboard server serves logs/x-replies-status.json (and nothing else from logs/)', async () => {
  const dir = await tmp(), logs = path.join(dir, 'logs'), data = path.join(dir, 'data');
  await fs.mkdir(logs); await fs.mkdir(data);
  await fs.writeFile(path.join(logs, 'x-replies-status.json'), '{"state":"ok"}');
  await fs.writeFile(path.join(logs, '2026-10.log'), 'secret');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(HERE, '..', 'dashboard-server.mjs')], { env: baseEnv({ LV_DATA_DIR: data, LV_LOG_DIR: logs, LV_DASH_PORT: String(port) }), stdio: 'ignore' });
  try {
    const get = (p) => new Promise((res, rej) => { const t = Date.now(); const go = () => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res([r.statusCode, b])); }).on('error', (e) => (Date.now() - t > 5000 ? rej(e) : setTimeout(go, 100))); go(); });
    assert.deepEqual(await get('/logs/x-replies-status.json'), [200, '{"state":"ok"}']);
    assert.equal((await get('/logs/2026-10.log'))[0], 404);
  } finally { srv.kill(); await fs.rm(dir, { recursive: true, force: true }); }
});

// ---- round 3 ----
test('process: related_used.replies re-analyzes when the reply count changes in either direction', async () => {
  const dir = await tmp();
  const id = '20261016-090000-aaaa0002';
  const w = async (rel, o) => { const f = path.join(dir, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, typeof o === 'string' ? o : JSON.stringify(o)); };
  const rep = (n) => ({ schema: 1, id, captured_at: '2026-10-16T00:30:00.000Z', main: null, urls: [], replies: Array.from({ length: n }, (_, i) => ({ n: i + 1, handle: '@u' + i, name: 'U', text: 'r' + i, own: false, links: [] })) });
  await w(`links/2026/10/${id}.json`, { id, url: 'http://127.0.0.1:9/page', created_at: '2026-10-16T09:00:00+09:00' });
  await w(`archive/2026/${id}/snapshot.json`, { schema: 1, id, source_type: 'web', canonical_url: 'http://127.0.0.1:9/page', captured_at: '2026-10-16T00:00:00Z', captured_by: 'test', text: 'body', media: [] });
  await w(`archive/2026/${id}/related.json`, { schema: 1, id, posts: [], resources: [], supplement: {} });
  await w(`archive/2026/${id}/related/x-replies.json`, rep(1)); // older than analyzed_at, count 1 vs 3 seen
  await w(`analysis/2026/${id}.json`, { id, status: 'analyzed', analyzed_at: '2026-10-16T01:00:00.000Z', title: 't', summary: 's', key_points: [], category: 'AI活用', tags: [], primary_subject: { kind: 'self', url: null, name: '' }, related_used: { posts: 0, resources: 0, replies: 3 } });
  await w('categories.json', [{ name: 'AI活用', description: '', created_at: '2026-10-01T00:00:00Z' }]);
  const logFile = path.join(dir, 'fake.log');
  const env = baseEnv({ LV_DATA_DIR: dir, LV_BACKEND: 'claude-code', LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_LOG: logFile, LV_LOCK_FILE: path.join(dir, 'lock') });
  const proc = () => run(process.execPath, [PROC, '--no-git'], { env });
  const calls = async () => (await fs.readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
  try {
    await proc();
    assert.equal(await calls(), 1, 'shrink 3 -> 1 re-analyzes');
    await proc();
    assert.equal(await calls(), 1, 'stable afterwards');
    await w(`archive/2026/${id}/related/x-replies.json`, { ...rep(0), captured_at: '2026-10-16T00:30:00.000Z' });
    await proc();
    assert.equal(await calls(), 2, 'shrink 1 -> 0 re-analyzes');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('run-guarded: a syntax error in lib logs one skip line and exits 0; a clean tree runs process.mjs', async () => {
  const dir = await tmp();
  try {
    await fs.mkdir(path.join(dir, 'lib'), { recursive: true });
    await fs.writeFile(path.join(dir, 'process.mjs'), "console.log('RAN', process.argv.slice(2).join(','));\n");
    await fs.writeFile(path.join(dir, 'lib', 'ok.mjs'), 'export const a = 1;\n');
    const GUARD = path.join(HERE, '..', 'run-guarded.mjs');
    const env = { ...process.env, LV_GUARD_DIR: dir };
    const good = await run(process.execPath, [GUARD, '--archive-only'], { env });
    assert.match(good.stdout, /RAN --archive-only/);
    await fs.writeFile(path.join(dir, 'lib', 'bad.mjs'), 'export const = ;\n');
    const bad = await run(process.execPath, [GUARD], { env });
    assert.equal(bad.code ?? 0, 0);
    assert.doesNotMatch(bad.stdout, /RAN/);
    assert.equal(bad.stdout.trim().split('\n').length, 1);
    assert.match(bad.stdout, /skip: syntax error in lib\/bad\.mjs/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('stripFrontmatter removes the YAML block (HF model-card languages) from README excerpts', async () => {
  const { stripFrontmatter } = await import('../lib/ai-build.mjs');
  assert.equal(stripFrontmatter('---\nlanguage:\n- en\n- ja\nlicense: mit\n---\n# Title\nbody'), '# Title\nbody');
  assert.equal(stripFrontmatter('# No front\n---\nrule'), '# No front\n---\nrule');
  assert.equal(stripFrontmatter(undefined), '');
});
