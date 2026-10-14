#!/usr/bin/env node
// Stand-in for the `claude` CLI used by the claude-code backend test.
// Records argv/env, then answers with Claude Code's `--output-format json` shape.
import fs from 'node:fs';

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const log = process.env.FAKE_CLAUDE_LOG;
  if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), hasApiKey: 'ANTHROPIC_API_KEY' in process.env, cwd: process.cwd(), input }) + '\n');
  const ids = [...input.matchAll(/<link id="([^"]+)">/g)].map((m) => m[1]);
  const results = ids.map((id, i) => ({
    id, title: `見出し${i}`, summary: '要約', key_points: ['p'], category: 'AI活用',
    new_category_description: 'AIの使い方', tags: ['ai'], content_type: 'article', language: 'ja',
  }));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { results }, modelUsage: { 'claude-opus-5-5': {} } }));
});
