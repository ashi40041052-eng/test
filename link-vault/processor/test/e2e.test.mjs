// End-to-end: runs process.mjs against a temp data dir, with a local fake web page
// and a fake Anthropic API (via ANTHROPIC_BASE_URL). No network or API key needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// hermetic: ignore the developer's processor/.env, and never reach the real FxTwitter
process.env.LV_NO_ENV_FILE = '1';
process.env.LV_LOCK_FILE = path.join(os.tmpdir(), `lv-test-${process.pid}.lock`); // test files run in parallel
process.env.LV_LOG_DIR = path.join(os.tmpdir(), `lv-test-logs-${process.pid}`); // never write the production log
process.env.LV_FXTWITTER_BASE = 'http://127.0.0.1:9';

test('api backend: analyzes new links and never touches links/', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/page')) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<html><head><title>Prompt tips</title></head><body><article>How to write better prompts.</article></body></html>');
        return;
      }
      if (req.url.startsWith('/v1/messages')) {
        const j = JSON.parse(body);
        requests.push({ j, headers: req.headers });
        const out = { title: 'プロンプトのコツ', summary: '要約', key_points: ['a'], category: 'AI活用', new_category_description: 'AIの使い方', tags: ['prompt'], content_type: 'article', language: 'en' };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: j.model, stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 1, output_tokens: 1 } }));
        return;
      }
      res.statusCode = 404; res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-e2e-'));
  const linkFile = path.join(dir, 'links', '2026', '10', '20261014-010203-abcd0001.json');
  await fs.mkdir(path.dirname(linkFile), { recursive: true });
  const raw = JSON.stringify({ id: '20261014-010203-abcd0001', url: `${base}/page`, note: 'メモ', text: 'x', created_at: '2026-10-14T10:02:03+09:00', via: 'share' }, null, 2) + '\n';
  await fs.writeFile(linkFile, raw);

  try {
    const env = { ...process.env, LV_BACKEND: 'api', ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'test', LV_DATA_DIR: dir };
    await run(process.execPath, [path.join(HERE, '..', 'process.mjs'), '--no-git'], { env });

    assert.equal(await fs.readFile(linkFile, 'utf8'), raw, 'raw link file must be unchanged');
    const a = JSON.parse(await fs.readFile(path.join(dir, 'analysis', '2026', '20261014-010203-abcd0001.json'), 'utf8'));
    assert.equal(a.status, 'analyzed');
    assert.equal(a.category, 'AI活用');
    const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(index.items[0].title, 'プロンプトのコツ');
    assert.equal(index.categories[0].name, 'AI活用');
    const cats = JSON.parse(await fs.readFile(path.join(dir, 'categories.json'), 'utf8'));
    assert.equal(cats[0].description, 'AIの使い方');
    await fs.access(path.join(dir, 'knowledge', 'categories', 'AI活用.md'));

    // request shape
    const { j, headers } = requests[0];
    assert.equal(j.model, 'claude-opus-5-5');
    assert.equal(j.fallbacks, 'default');
    assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(j.output_config.format.type, 'json_schema');
    assert.match(j.messages[0].content, /How to write better prompts/);

    // second run: nothing new to analyze
    await run(process.execPath, [path.join(HERE, '..', 'process.mjs'), '--no-git'], { env });
    assert.equal(requests.length, 1);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('claude-code backend: batches links through the CLI without an API key', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-e2e-cc-'));
  const logFile = path.join(dir, 'fake-claude.log');
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const id = `20261014-0102${String(i).padStart(2, '0')}-cc00000${i}`;
    ids.push(id);
    const f = path.join(dir, 'links', '2026', '10', `${id}.json`);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify({ id, url: null, note: `メモ${i}`, created_at: `2026-10-14T10:02:${String(i).padStart(2, '0')}+09:00` }));
  }
  try {
    const env = {
      ...process.env,
      LV_BACKEND: 'claude-code',
      LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'),
      FAKE_CLAUDE_LOG: logFile,
      ANTHROPIC_API_KEY: 'must-not-reach-claude',
      LV_DATA_DIR: dir,
    };
    await run(process.execPath, [path.join(HERE, '..', 'process.mjs'), '--no-git'], { env });

    const calls = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 4, '10 links -> 4 batches of up to 3 (v4: bigger prompts)');
    for (const c of calls) {
      assert.equal(c.hasApiKey, false, 'API key must be removed so the subscription is used');
      assert.ok(c.argv.includes('-p') && c.argv.includes('--json-schema'));
      assert.equal(c.argv[c.argv.indexOf('--model') + 1], 'opus');
      assert.equal(c.argv[c.argv.indexOf('--tools') + 1], '');
    }
    assert.match(calls[1].input, /- AI活用: AIの使い方/, 'second batch sees the category created by the first');

    const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(index.items.length, 10);
    assert.ok(index.items.every((i) => i.status === 'analyzed' && i.category === 'AI活用'));
    assert.ok(index.items.every((i) => /^見出し\d$/.test(i.title)), 'Japanese text survives chunked output');
    const cats = JSON.parse(await fs.readFile(path.join(dir, 'categories.json'), 'utf8'));
    assert.equal(cats.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('delete events: deleted links are not analyzed, delete covers earlier copies, re-saving works, restore brings it back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-e2e-del-'));
  const logFile = path.join(dir, 'fake-claude.log');
  const write = async (rel, obj) => {
    const f = path.join(dir, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify(obj));
  };
  const A = '20261014-010000-aaaa0001', A2 = '20261014-020000-aaaa0002', B = '20261014-030000-bbbb0001';
  await write(`links/2026/10/${A}.json`, { id: A, url: 'https://x.com/u/status/1?s=20', note: 'first', created_at: '2026-10-14T10:00:00+09:00' });
  await write(`links/2026/10/${A2}.json`, { id: A2, url: 'https://twitter.com/u/status/1', note: 'again', created_at: '2026-10-14T11:00:00+09:00' });
  await write(`links/2026/10/${B}.json`, { id: B, url: null, note: 'mistake', created_at: '2026-10-14T12:00:00+09:00' });
  await write('events/2026/10/20261014-030100-ev000001.json', { id: '20261014-030100-ev000001', target: B, action: 'delete', at: '2026-10-14T03:01:00.000Z' });
  const env = { ...process.env, LV_BACKEND: 'claude-code', LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), FAKE_CLAUDE_LOG: logFile, LV_DATA_DIR: dir };
  const proc = () => run(process.execPath, [path.join(HERE, '..', 'process.mjs'), '--no-git'], { env });
  const index = async () => JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8'));
  // X links can't be fetched in tests; give fetch a quick failure
  env.HTTPS_PROXY = 'http://127.0.0.1:9';
  try {
    await proc();
    let calls = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].input.includes(A) && !calls[0].input.includes(B), 'deleted link B is not sent to AI; dup A2 not either');
    assert.ok(!calls[0].input.includes(A2));
    let idx = await index();
    assert.equal(idx.items.find((i) => i.id === B).deleted, true);
    assert.equal(idx.total, 1);
    assert.ok(!(await fs.readFile(path.join(dir, 'knowledge', 'timeline.md'), 'utf8')).includes('mistake'));

    // delete A (the link shown in the list): its copy A2, saved before the delete, goes with it
    await write('events/2026/10/20261014-040000-ev000002.json', { id: '20261014-040000-ev000002', target: A, action: 'delete', at: '2026-10-14T04:00:00.000Z' });
    await proc();
    idx = await index();
    assert.equal(idx.items.find((i) => i.id === A).deleted, true);
    assert.equal(idx.items.find((i) => i.id === A).event_at, '2026-10-14T04:00:00.000Z');
    assert.ok(!idx.items.some((i) => i.id === A2 && !i.deleted), 'earlier copy does not resurface');
    assert.equal(idx.total, 0);

    // saving the same URL again after the delete is a new link, analyzed afresh
    const A3 = '20261014-050000-aaaa0003';
    await write(`links/2026/10/${A3}.json`, { id: A3, url: 'https://x.com/u/status/1', note: 'third', created_at: '2026-10-14T14:00:00+09:00' });
    await proc();
    calls = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 2);
    idx = await index();
    const a3 = idx.items.find((i) => i.id === A3);
    assert.equal(a3.status, 'analyzed');
    assert.ok(!a3.deleted);
    assert.equal(idx.total, 1);

    // restoring A brings it back with its copies merged into it again
    await write('events/2026/10/20261014-060000-ev000004.json', { id: '20261014-060000-ev000004', target: A, action: 'restore', at: '2026-10-14T06:00:00.000Z' });
    await proc();
    idx = await index();
    const a = idx.items.find((i) => i.id === A);
    assert.ok(!a.deleted);
    assert.equal(a.also_saved_at.length, 2);
    assert.equal(idx.total, 1);

    // restore B: it is analyzed now
    await write('events/2026/10/20261014-050000-ev000003.json', { id: '20261014-050000-ev000003', target: B, action: 'restore', at: '2026-10-14T05:00:00.000Z' });
    await proc();
    idx = await index();
    const b = idx.items.find((i) => i.id === B);
    assert.ok(!b.deleted);
    assert.equal(b.status, 'analyzed');
    // raw files untouched
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'links/2026/10', `${B}.json`), 'utf8')).note, 'mistake');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('git mode: pulls phone links, commits with no git identity configured, pushes, never touches links/', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lv-e2e-git-'));
  const home = path.join(root, 'home'); // empty HOME: no global git identity
  await fs.mkdir(home);
  const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') };
  const g = (cwd, ...a) => run('git', a, { cwd, env: gitEnv });
  const who = ['-c', 'user.name=phone', '-c', 'user.email=phone@example.com'];
  const remote = path.join(root, 'remote.git'), phone = path.join(root, 'phone'), pc = path.join(root, 'pc');
  try {
    await g(root, 'init', '--bare', '-b', 'main', remote);
    await g(root, 'clone', remote, phone);
    await fs.writeFile(path.join(phone, 'README.md'), '# data\n');
    const addLink = async (id, note) => {
      const f = path.join(phone, 'links', '2026', '10', `${id}.json`);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, JSON.stringify({ id, url: null, note, created_at: '2026-10-14T10:00:00+09:00' }));
      await g(phone, 'add', '-A');
      await g(phone, ...who, 'commit', '-m', `add ${id}`);
      await g(phone, 'push', 'origin', 'HEAD:main');
    };
    await addLink('20261014-010000-gggg0001', 'one');
    await g(root, 'clone', remote, pc);

    const env = { ...gitEnv, LV_BACKEND: 'claude-code', LV_CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), LV_DATA_DIR: pc };
    const proc = () => run(process.execPath, [path.join(HERE, '..', 'process.mjs')], { env });
    await proc();

    // phone adds another link after the PC's first run
    await g(phone, 'pull', '--rebase');
    await addLink('20261014-020000-gggg0002', 'two');
    await proc();

    const check = path.join(root, 'check');
    await g(root, 'clone', remote, check);
    const index = JSON.parse(await fs.readFile(path.join(check, 'index.json'), 'utf8'));
    assert.deepEqual(index.items.map((i) => i.status).sort(), ['analyzed', 'analyzed']);
    const log = (await g(check, 'log', '--format=%an|%s')).stdout;
    assert.match(log, /Link Vault\|analyze:/, 'processor committed with fallback identity');
    // links/ only ever changed by the phone's commits
    const touched = (await g(check, 'log', '--format=%an', '--', 'links')).stdout.trim().split('\n');
    assert.ok(touched.every((a) => a === 'phone'));
    // phone pushes while the PC is analyzing -> PC push is rejected, pull --rebase must replay its
    // commit (needs a committer identity), then push succeeds and the repo is not left mid-rebase
    await g(phone, 'pull', '--rebase');
    const f3 = path.join(phone, 'links', '2026', '10', '20261014-030000-gggg0003.json');
    await fs.writeFile(f3, JSON.stringify({ id: '20261014-030000-gggg0003', url: null, note: 'three', created_at: '2026-10-14T12:00:00+09:00' }));
    const f4 = path.join(phone, 'links', '2026', '10', '20261014-040000-gggg0004.json');
    await g(phone, 'add', '-A'); await g(phone, ...who, 'commit', '-m', 'add 3'); await g(phone, 'push', 'origin', 'HEAD:main');
    await run(process.execPath, [path.join(HERE, '..', 'process.mjs')], {
      env: { ...env, FAKE_CLAUDE_HOOK: `cd '${phone}' && printf '%s' '${JSON.stringify({ id: '20261014-040000-gggg0004', url: null, note: 'four', created_at: '2026-10-14T13:00:00+09:00' })}' > '${f4}' && git add -A && git -c user.name=phone -c user.email=p@x commit -qm 'add 4' && git push -q origin HEAD:main` },
    });
    await assert.rejects(fs.access(path.join(pc, '.git', 'rebase-merge')), 'not left mid-rebase');
    await g(check, 'pull');
    const idx3 = JSON.parse(await fs.readFile(path.join(check, 'index.json'), 'utf8'));
    assert.equal(idx3.items.find((i) => i.id === '20261014-030000-gggg0003').status, 'analyzed');
    assert.ok(await fs.readFile(path.join(check, 'links', '2026', '10', '20261014-040000-gggg0004.json'), 'utf8'), 'phone link pushed mid-run is kept');
    assert.equal((await g(pc, 'status', '-sb')).stdout.split('\n')[0].includes('ahead'), false, 'PC pushed everything');

    // third run with nothing new: no extra commit
    await proc(); // analyzes link 4
    await g(check, 'pull');
    const before = (await g(check, 'rev-list', '--count', 'HEAD')).stdout.trim();
    await proc();
    await g(check, 'pull');
    const after = (await g(check, 'rev-list', '--count', 'HEAD')).stdout.trim();
    assert.equal(after, before, 'a run with nothing new makes no commit');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
