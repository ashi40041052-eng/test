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
  const results = ids.map((id, i) => ({
    id, title: `見出し${i}`, summary: '要約', key_points: ['p'], category: 'AI活用',
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
