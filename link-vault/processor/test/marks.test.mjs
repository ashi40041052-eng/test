import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildOutputs } from '../lib/build.mjs';
import { runMark } from '../mark.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID1 = '20261001-000000-aaaa1111', ID2 = '20261002-000000-bbbb2222';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lv-marks-'));
function makeData(dir) {
  for (const [id, url] of [[ID1, 'https://a.example/1'], [ID2, 'https://b.example/2?utm_source=x']]) {
    fs.mkdirSync(path.join(dir, 'links/2026'), { recursive: true });
    fs.writeFileSync(path.join(dir, `links/2026/${id}.json`), JSON.stringify({ id, url, created_at: '2026-10-01T00:00:00Z' }));
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ known_ids: [ID1, ID2], items: [{ id: ID1 }, { id: ID2 }] }));
}

test('buildOutputs carries the mark into index, manifest (mk), frontmatter, llms.txt and stats', () => {
  const records = [
    { id: ID1, url: 'https://a.example/1', note: null, created_at: '2026-10-01T09:00:00+09:00' },
    { id: ID2, url: 'https://b.example/2', note: null, created_at: '2026-10-02T09:00:00+09:00' },
  ];
  const { files, stats } = buildOutputs({ records, analyses: new Map(), categories: [], marks: new Map([[ID1, 'done']]) });
  const items = JSON.parse(files['index.json']).items;
  assert.equal(items.find((i) => i.id === ID1).mark, 'done');
  assert.equal(items.find((i) => i.id === ID2).mark, 'todo');
  assert.equal(stats.todo, 1);
  const man = files['ai/manifest.jsonl'].trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(man.find((m) => m.id === ID1).mk, 'done');
  assert.equal(man.find((m) => m.id === ID2).mk, 'todo');
  assert.match(files[`ai/links/2026/${ID1}.md`], /^mark: done$/m);
  assert.match(files[`ai/links/2026/${ID2}.md`], /^mark: todo$/m);
  assert.match(files['ai/llms.txt'], /mark\.mjs <id\|URL> done/);
  assert.match(files['ai/llms.txt'], /未対応 1/);
  assert.match(files['ai/schema.md'], /\| mark \|/);
  assert.match(files['ai/schema.md'], /mk=対応状況/);
});

async function startServer(dataDir) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [path.join(HERE, '../dashboard-server.mjs')], { env: { ...process.env, LV_DATA_DIR: dataDir, LV_DASH_PORT: String(port), LV_NO_ENV_FILE: '1' }, stdio: 'pipe' });
  await new Promise((res, rej) => { p.stdout.on('data', res); p.on('exit', rej); setTimeout(rej, 5000); });
  return { port, stop: () => p.kill() };
}
const post = (port, body, headers = { 'Content-Type': 'application/json' }) => fetch(`http://127.0.0.1:${port}/api/mark`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('POST /api/mark writes marks/<id>.json; bad ids and bad requests are rejected', async () => {
  const dir = tmp(); makeData(dir);
  const s = await startServer(dir);
  try {
    let r = await post(s.port, { id: ID1, status: 'done' });
    assert.equal(r.status, 200);
    const f = path.join(dir, 'marks', `${ID1}.json`);
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(m.status, 'done'); assert.equal(m.by, 'human'); assert.ok(m.at);
    const all = await (await fetch(`http://127.0.0.1:${s.port}/api/marks`)).json();
    assert.equal(all[ID1].status, 'done');
    r = await post(s.port, { id: ID1, status: 'todo' });
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).status, 'todo');
    for (const id of ['../../etc/passwd', 'nope-0000', '', `${ID1}/../x`, '..', 5]) {
      assert.equal((await post(s.port, { id, status: 'done' })).status, 400, String(id));
    }
    assert.equal((await post(s.port, { id: ID2, status: 'maybe' })).status, 400);
    assert.equal((await post(s.port, 'not json')).status, 400);
    assert.equal((await post(s.port, { id: ID2, status: 'done' }, { 'Content-Type': 'text/plain' })).status, 403);
    const evil = await new Promise((res) => { const q = http.request({ host: '127.0.0.1', port: s.port, path: '/api/mark', method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example' } }, (x) => { x.resume(); res(x.statusCode); }); q.end(JSON.stringify({ id: ID2, status: 'done' })); });
    assert.equal(evil, 403);
    assert.ok(!fs.existsSync(path.join(dir, 'marks', `${ID2}.json`)));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'marks')), [`${ID1}.json`]);
  } finally { s.stop(); }
});

test('mark.mjs CLI: id and URL, note/by, several ids, commits only marks/ and pushes', async () => {
  const root = tmp();
  const remote = path.join(root, 'remote.git'), dir = path.join(root, 'data');
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, dir], { stdio: 'pipe' });
  g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 't');
  makeData(dir); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'init'); g(dir, 'push', '-q', '-u', 'origin', 'HEAD');
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'dirty'); // must not be committed by mark
  const env = { ...process.env, LV_DATA_DIR: dir, LV_LOCK_FILE: path.join(root, 'lock') };
  const ids = await runMark(['https://a.example/1', ID2, 'done', '--note', 'fixed it'], env);
  assert.deepEqual(ids, [ID1, ID2]);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'marks', `${ID1}.json`), 'utf8'));
  assert.deepEqual([m.status, m.by, m.note], ['done', 'ai', 'fixed it']);
  assert.equal(g(dir, 'status', '--short'), '?? unrelated.txt');
  assert.equal(g(dir, 'rev-list', '--count', '@{u}..HEAD'), '0'); // pushed
  assert.match(g(remote, 'ls-tree', '-r', '--name-only', 'main'), new RegExp(`marks/${ID2}.json`));
  assert.ok(!fs.existsSync(path.join(root, 'lock')));
  await runMark([ID1, 'todo', '--by', 'human'], env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'marks', `${ID1}.json`), 'utf8')).status, 'todo');
  await assert.rejects(runMark(['no-such-link', 'done'], env), /unknown link/);
  await assert.rejects(runMark(['../x', 'done'], env), /unknown link/);
});
