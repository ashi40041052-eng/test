// Backend "claude-code": runs the Claude Code CLI in headless mode (`claude -p`) logged in with
// your Claude Pro/Max subscription. No API key and no per-use charge; it counts toward the
// plan's usage limits. Several links are analyzed per call to keep usage low.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { RESULT_PROPERTIES, RESULT_REQUIRED, INSTRUCTIONS, categoryList, linkBlock, cleanResult } from './prompt.mjs';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', ...RESULT_REQUIRED],
        properties: { id: { type: 'string' }, ...RESULT_PROPERTIES },
      },
    },
  },
};

const SYSTEM = 'You are a librarian that summarizes and categorizes saved links. Follow the instructions in the user message and answer only with the requested structured output.';

// cmd.exe quoting for Windows, where `claude` is usually a .cmd shim that needs a shell.
const winQuote = (s) => (s === '' ? '""' : /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function runClaude(bin, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // An API key in the environment would make Claude Code bill the API instead of the subscription.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const win = process.platform === 'win32';
    const child = spawn(bin,win ? args.map(winQuote) : args, {
      cwd: os.tmpdir(), // keep project CLAUDE.md files out of the prompt
      env,
      shell: win,
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`Claude Code (${bin}) が見つかりません。インストールして \`claude\` でログインしてください`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) return reject(new Error(`claude exited with ${code}: ${stderr.trim().slice(0, 500)}`));
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

export function createClaudeCodeAnalyzer({ model, bin = 'claude', batchSize = 8, timeoutMs = 10 * 60 * 1000 }) {
  return {
    batchSize,
    // Returns Map<id, result | Error>
    async analyzeBatch(items, categories) {
      const prompt = `${INSTRUCTIONS}

既存カテゴリ:
${categoryList(categories)}

以下の ${items.length} 件のリンクを分析し、results に1件ずつ（id は <link id> の値をそのまま）入れてください。

${items.map((it) => linkBlock(it.record, it.content)).join('\n\n')}`;

      const args = [
        '-p',
        '--output-format', 'json',
        '--json-schema', JSON.stringify(SCHEMA),
        '--system-prompt', SYSTEM,
        '--tools', '',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--effort', 'low',
      ];
      if (model) args.push('--model', model);

      const out = new Map();
      let parsed;
      try {
        const stdout = await runClaude(bin, args, prompt, timeoutMs);
        const res = JSON.parse(stdout);
        if (res.is_error) throw new Error(`claude error: ${String(res.result || res.subtype || 'unknown').slice(0, 300)}`);
        parsed = res.structured_output || JSON.parse(res.result);
        parsed.model = Object.keys(res.modelUsage || {})[0] || model || 'claude-code';
      } catch (e) {
        for (const it of items) out.set(it.record.id, e);
        return out;
      }
      const byId = new Map((parsed.results || []).map((r) => [r.id, r]));
      for (const it of items) {
        const r = byId.get(it.record.id);
        out.set(it.record.id, r ? { ...cleanResult(r), model: parsed.model } : new Error('result missing in batch response'));
      }
      return out;
    },
  };
}
