#!/usr/bin/env node
// Stand-in for the `claude` CLI used by the claude-code backend test.
// Records argv/env, then answers with Claude Code's `--output-format json` shape.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const log = process.env.FAKE_CLAUDE_LOG;
  if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), hasApiKey: 'ANTHROPIC_API_KEY' in process.env, cwd: process.cwd(), input }) + '\n');
  // Test hook: simulate something happening while the AI is working (e.g. the phone pushing).
  if (process.env.FAKE_CLAUDE_HOOK) { execSync(process.env.FAKE_CLAUDE_HOOK, { stdio: 'ignore', shell: '/bin/bash' }); delete process.env.FAKE_CLAUDE_HOOK; }
  const ids = [...input.matchAll(/<link id="([^"]+)">/g)].map((m) => m[1]);
  // v3: if a <subject> precedes the link's content, answer with it as the primary subject
  const blocks = input.split('<link id="').slice(1);
  // Test hook: FAKE_CLAUDE_DROP=<id> leaves that link out of the answer when it is batched with others.
  const results = ids.filter((id) => !(process.env.FAKE_CLAUDE_DROP === id && ids.length > 1)).map((id) => ({
    primary_subject: (() => { const m = blocks[ids.indexOf(id)].match(/<subject type="(\w+)" url="([^"]*)"[^>]*>\n名前: ([^\n]*)/); return m && m[1] !== 'post' ? { kind: 'resource', url: m[2], name: m[3] } : { kind: 'self', url: null, name: '' }; })(),
    resource_kind: /<subject type="github"/.test(blocks[ids.indexOf(id)]) ? 'repository' : 'none',
    // v4: one reading for every <subject ... n="N"> / <resource n="N" ...> that carries a body (FAKE_CLAUDE_NO_RESOURCES=1 answers none)
    tldr: `一行${ids.indexOf(id)}`,
    resources: process.env.FAKE_CLAUDE_NO_RESOURCES ? [] : [
      ...[...blocks[ids.indexOf(id)].matchAll(/<subject type="(\w+)" url="([^"]*)" n="(\d+)"/g)].map((m) => ({ n: Number(m[3]), url: m[2], type: m[1], name: `res${m[3]}` })),
      ...[...blocks[ids.indexOf(id)].matchAll(/<resource n="(\d+)" type="(\w+)" url="([^"]*)" name="([^"]*)"/g)].map((m) => ({ n: Number(m[1]), url: m[3], type: m[2], name: m[4] })),
    ].map((r) => ({ ...r, what: `何${r.n}`, features: [`機能${r.n}a`, `機能${r.n}b`], usage: `npx run${r.n}`, audience: `向く人${r.n}`, my_note: 'AI が書いた自分メモ' })),
    id, title: `見出し${ids.indexOf(id)}`, summary: '要約', key_points: ['p'], category: 'AI活用',
    new_category_description: 'AIの使い方', tags: ['ai'], content_type: 'article', language: 'ja',
  }));
  const out = Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { results }, modelUsage: { 'claude-opus-5-5': {} } }));
  // Write in 5-byte pieces with pauses so multi-byte characters straddle chunk boundaries.
  let i = 0;
  const next = () => {
    if (i >= out.length) return;
    process.stdout.write(out.subarray(i, i + 5), () => setTimeout(next, 1));
    i += 5;
  };
  next();
});
