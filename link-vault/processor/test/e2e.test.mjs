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

test('process.mjs analyzes new links and never touches links/', async () => {
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
    const env = { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'test', LV_DATA_DIR: dir };
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
