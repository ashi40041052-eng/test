// Backend "claude-code": runs the Claude Code CLI in headless mode (`claude -p`) logged in with
// your Claude Pro/Max subscription. No API key and no per-use charge; it counts toward the
// plan's usage limits. Several links are analyzed per call to keep usage low.
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import { RESULT_PROPERTIES, RESULT_REQUIRED, INSTRUCTIONS, categoryList, tagList, linkBlock, cleanResult } from './prompt.mjs';

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

// cmd.exe quoting, only used when `claude` is a .cmd shim (npm install) that needs a shell.
const winQuote = (s) => (s === '' ? '""' : /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

// On Windows prefer the native claude.exe (no shell, no quoting issues).
function resolveWindowsBin(bin) {
  if (/\.exe$/i.test(bin)) return { file: bin, shell: false };
  try {
    const found = execFileSync('where', [bin], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const exe = found.find((f) => /\.exe$/i.test(f));
    if (exe) return { file: exe, shell: false };
    // npm installs also list an extensionless sh script first, which cmd.exe can't run.
    const cmd = found.find((f) => /\.(cmd|bat)$/i.test(f));
    if (cmd) return { file: winQuote(cmd), shell: true };
  } catch {}
  return { file: bin, shell: true };
}

function runClaude(bin, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // An API key in the environment would make Claude Code bill the API instead of the subscription.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const target = process.platform === 'win32' ? resolveWindowsBin(bin) : { file: bin, shell: false };
    const child = spawn(target.file, target.shell ? args.map(winQuote) : args, {
      cwd: os.tmpdir(), // keep project CLAUDE.md files out of the prompt
      env,
      shell: target.shell,
      windowsHide: true,
    });
    // Decode as UTF-8 across chunk boundaries (Japanese text would otherwise get garbled).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
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

export function createClaudeCodeAnalyzer({ model, bin = 'claude', batchSize = 5, timeoutMs = 10 * 60 * 1000 }) {
  return {
    batchSize,
    // Returns Map<id, result | Error>
    async analyzeBatch(items, categories, { tags = [], retrying = false } = {}) {
      const prompt = `${INSTRUCTIONS}

既存カテゴリ:
${categoryList(categories)}

既存タグ:
${tagList(tags)}

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
      const missing = [];
      for (const it of items) {
        const r = byId.get(it.record.id);
        if (r) out.set(it.record.id, { ...cleanResult(r), model: parsed.model });
        else missing.push(it);
      }
      // The model sometimes answers for only part of a batch: ask once more for the rest, in a smaller call.
      if (missing.length && missing.length < items.length && !retrying) {
        for (const [id, r] of await this.analyzeBatch(missing, categories, { tags, retrying: true })) out.set(id, r);
      } else for (const it of missing) out.set(it.record.id, new Error('result missing in batch response'));
      return out;
    },
  };
}
