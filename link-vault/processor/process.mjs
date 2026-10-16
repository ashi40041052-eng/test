#!/usr/bin/env node
/*
 * Link Vault processor (runs on your PC a few times a day).
 *
 *  1. git pull the data repository
 *  2. for each link without an analysis: fetch the page, ask Claude (Claude Code CLI or API) to summarize + categorize
 *  3. regenerate index.json (dashboard) and knowledge/*.md (for AI to read)
 *  4. git commit + push
 *
 * Raw links under links/ and delete/restore events under events/ come from the phone and are
 * NEVER modified or deleted by this script. A deleted link is only hidden.
 *
 * archive/ (immutable snapshots of each link's text + media) is created before analysis; with
 * --archive-only (launchd, every 20 min) only archiving runs: no AI, no analysis files.
 *
 * Related capture (parents, quotes, self replies, github/HF/arXiv/web resources) runs right after archiving.
 * --reanalyze-related re-analyzes the links that have related.json but no analysis.primary_subject yet, the
 * links whose related.json gained supplement resources (profile website / replies) after their analysis, and the
 * links with captured replies (related/x-replies.json) that the analysis has not seen yet.
 *
 * Usage: node process.mjs [--no-ai] [--no-git] [--archive-only] [--reanalyze-related] [--data <dir>] [--max <n>]
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeUrl, walkJson, readJson, writeIfChanged } from './lib/util.mjs';
import { archiveLink, backfillMedia, loadArchives, loadContent, readSnapshot, dirSize, DEFAULT_LIMITS } from './lib/archive.mjs';
import { buildOutputs } from './lib/build.mjs';
import { captureRelated, newRelatedBudget, loadRelated } from './lib/related.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Failed links are retried on every run up to MAX_ATTEMPTS, then once a day (forever).
const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- config ----------

const envFile = path.join(HERE, '.env');
if (fssync.existsSync(envFile) && process.env.LV_NO_ENV_FILE !== '1') process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

// "claude-code" (default): Claude Code CLI with your Pro/Max subscription, no API charges.
// "api": Claude API with ANTHROPIC_API_KEY, billed per use.
const BACKEND = process.env.LV_BACKEND || 'claude-code';
const CONFIG = {
  dataDir: path.resolve(opt('--data') || process.env.LV_DATA_DIR || ''),
  backend: BACKEND,
  model: process.env.LV_MODEL || (BACKEND === 'api' ? 'claude-opus-5-5' : 'opus'),
  claudeBin: process.env.LV_CLAUDE_BIN || 'claude',
  maxPerRun: Number(opt('--max') || process.env.LV_MAX_PER_RUN || 60),
  archiveOnly: flag('--archive-only'),
  reanalyzeRelated: flag('--reanalyze-related'),
  useAi: !flag('--no-ai') && !flag('--archive-only'),
  useGit: !flag('--no-git') && process.env.LV_NO_GIT !== '1',
};

// ---------- logging ----------

const logDir = process.env.LV_LOG_DIR || path.join(HERE, 'logs'); // tests set LV_LOG_DIR to a temp dir
fssync.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 7)}.log`);
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fssync.appendFileSync(logFile, line + '\n'); } catch {}
}

// ---------- git ----------

let gitEnv = process.env;

function git(...a) {
  return execFileSync('git', ['-C', CONFIG.dataDir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trim();
}

// A fresh PC may have no git identity; commits and rebases need one, so supply a fallback.
function ensureGitIdentity() {
  let email = '';
  try { email = git('config', 'user.email'); } catch {}
  if (email) return;
  gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Link Vault', GIT_AUTHOR_EMAIL: 'link-vault@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Link Vault', GIT_COMMITTER_EMAIL: 'link-vault@users.noreply.github.com',
  };
}

function rebaseInProgress() {
  for (const p of ['rebase-merge', 'rebase-apply']) {
    try { if (fssync.existsSync(path.resolve(CONFIG.dataDir, git('rev-parse', '--git-path', p)))) return true; } catch {}
  }
  return false;
}

// While rebasing, "ours" is the upstream (remote) side. archive/ files are derived from the same
// source data, so on conflict the remote version wins; any other conflict aborts as before.
function resolveArchiveConflicts() {
  for (let i = 0; i < 50; i++) {
    const files = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    if (files.some((f) => !f.startsWith('archive/'))) return false;
    for (const f of files) {
      try { git('checkout', '--ours', '--', f); git('add', '--', f); } catch { git('rm', '-q', '--cached', '--ignore-unmatch', '--', f); }
    }
    try {
      execFileSync('git', ['-C', CONFIG.dataDir, 'rebase', '--continue'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...gitEnv, GIT_EDITOR: 'true' } });
      return true;
    } catch (e) {
      if (!rebaseInProgress()) return true;
      if (!git('diff', '--name-only', '--diff-filter=U')) {
        // an emptied commit: skip it
        try { git('rebase', '--skip'); if (!rebaseInProgress()) return true; } catch { return false; }
      }
    }
  }
  return false;
}

function gitPull() {
  if (rebaseInProgress()) { log('WARN: aborting a rebase left over from an earlier run'); git('rebase', '--abort'); }
  try {
    git('pull', '--rebase', '--autostash');
  } catch (e) {
    if (rebaseInProgress()) {
      let ok = false;
      try { ok = resolveArchiveConflicts(); } catch {}
      if (ok && !rebaseInProgress()) { log('resolved archive/ conflict in favour of the remote copy'); return; }
    }
    // Never leave the repo stuck mid-rebase: the next run must start clean.
    if (rebaseInProgress()) { try { git('rebase', '--abort'); } catch {} }
    throw e;
  }
}

// Everything except links/ is generated by this script.
const GENERATED = ['--', '.', ':(exclude)links', ':(exclude)events'];

function aheadOfUpstream() {
  try { return Number(git('rev-list', '--count', '@{u}..HEAD')) > 0; } catch { return true; }
}

function gitCommitAndPush(message) {
  git('add', '-A', ...GENERATED);
  if (git('diff', '--cached', '--name-only')) git('commit', '-m', message);
  if (!aheadOfUpstream()) return false; // also retries a push that failed on an earlier run
  for (let i = 0; i < 4; i++) {
    try { git('push', '-u', 'origin', 'HEAD'); return true; } catch (e) {
      log(`push failed (attempt ${i + 1}): ${String(e.stderr || e.message).trim()}`);
      // The phone may have added links meanwhile. They live in links/ only, so rebase never conflicts.
      try { gitPull(); } catch (e2) { log('pull failed:', String(e2.stderr || e2.message).trim()); }
    }
  }
  throw new Error('git push failed; changes are committed locally and will be pushed on the next run');
}

// ---------- lock ----------

const lockFile = process.env.LV_LOCK_FILE || path.join(os.tmpdir(), 'link-vault-processor.lock');
function acquireLock() {
  try {
    const st = fssync.statSync(lockFile);
    if (Date.now() - st.mtimeMs < 60 * 60 * 1000) return false;
    fssync.unlinkSync(lockFile); // stale
  } catch {}
  try { fssync.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
}
const releaseLock = () => { try { fssync.unlinkSync(lockFile); } catch {} };

// ---------- data ----------

const SEED_CATEGORIES = [];

async function ensureLayout(dir) {
  await fs.mkdir(path.join(dir, 'links'), { recursive: true });
  await fs.mkdir(path.join(dir, 'analysis'), { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fssync.existsSync(readme)) {
    await fs.writeFile(readme, [
      '# Link Vault data',
      '',
      '- `links/` … スマホから保存された元データ（1リンク1ファイル・追記のみ・絶対に編集/削除しない）',
      '- `analysis/` … AIによる分析結果（再生成可能）',
      '- `archive/` … 各リンクの本文・画像のスナップショット（作成後は絶対に上書きしない。related.json だけは資源の追記あり＝既存の項目は変えない）',
      '- `ai/` … AI向けの入口（`ai/llms.txt` から読む。自動生成）',
      '- `categories.json` … カテゴリ一覧（名前・説明は手で編集してOK）',
      '- `index.json` … ダッシュボード用（自動生成）',
      '- `knowledge/` … AIに読ませる用のMarkdown（自動生成）',
      '',
    ].join('\n'));
  }
}

async function loadRecords(dir) {
  const files = await walkJson(path.join(dir, 'links'));
  const records = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await fs.readFile(f, 'utf8'));
      if (!r.id || !r.created_at) throw new Error('missing id/created_at');
      records.push(r);
    } catch (e) {
      log(`WARN: skipping unreadable link file ${path.relative(dir, f)}: ${e.message}`);
    }
  }
  records.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id.localeCompare(b.id));
  return records;
}

// Latest delete/restore event per link wins. Returns Map<linkId, {action, at}>.
async function loadLatestEvents(dir) {
  const events = [];
  for (const f of await walkJson(path.join(dir, 'events'))) {
    const e = await readJson(f, null);
    if (e?.target && (e.action === 'delete' || e.action === 'restore')) events.push(e);
  }
  events.sort((a, b) => `${a.at}${a.id}`.localeCompare(`${b.at}${b.id}`));
  const latest = new Map();
  for (const e of events) latest.set(e.target, { action: e.action, at: e.at });
  return latest;
}

async function loadAnalyses(dir) {
  const m = new Map();
  for (const f of await walkJson(path.join(dir, 'analysis'))) {
    const a = await readJson(f, null);
    if (a?.id) m.set(a.id, a);
  }
  return m;
}

const analysisPath = (dir, id) => path.join(dir, 'analysis', id.slice(0, 4), `${id}.json`);
async function saveAnalysis(dir, a) {
  if (CONFIG.archiveOnly) return; // archive-only never writes analysis files
  await writeIfChanged(analysisPath(dir, a.id), JSON.stringify(a, null, 2) + '\n');
}

async function loadRelatedAll(dir, records) {
  const m = new Map();
  for (const r of records) {
    const rel = await loadRelated(dir, r.id);
    if (rel) m.set(r.id, rel);
  }
  return m;
}

// ---------- main ----------

async function main() {
  if (!CONFIG.dataDir || !fssync.existsSync(CONFIG.dataDir)) {
    throw new Error('データリポジトリのパスが未設定です。processor/.env の LV_DATA_DIR を設定してください');
  }
  if (!['claude-code', 'api'].includes(CONFIG.backend)) throw new Error(`LV_BACKEND は claude-code か api を指定してください: ${CONFIG.backend}`);
  if (CONFIG.useAi && CONFIG.backend === 'api' && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    log('WARN: ANTHROPIC_API_KEY が未設定です。SDKの他の認証方法（ant auth login）を試します');
  }
  if (!acquireLock()) { log('another run is in progress; exiting'); return; }

  try {
    const dir = CONFIG.dataDir;
    if (CONFIG.useGit) {
      ensureGitIdentity();
      try { gitPull(); } catch (e) { log('WARN: git pull failed, continuing with local copy:', String(e.stderr || e.message).trim()); }
    }
    await ensureLayout(dir);

    const records = await loadRecords(dir);
    const analyses = await loadAnalyses(dir);
    const latestEvents = await loadLatestEvents(dir);
    const deleted = new Set([...latestEvents].filter(([, e]) => e.action === 'delete').map(([id]) => id));
    const catFile = path.join(dir, 'categories.json');
    const categories = await readJson(catFile, SEED_CATEGORIES);

    // Duplicates (same normalized URL saved again) reuse the earlier analysis.
    // Deleting the link shown in the list also covers copies of it saved *before* the delete
    // (they were merged into it); a copy saved *after* the delete is a new link.
    const firstByUrl = new Map();
    const deletedAtByUrl = new Map();
    for (const r of records) {
      const key = normalizeUrl(r.url);
      if (!key) continue;
      if (deleted.has(r.id)) {
        const at = Date.parse(latestEvents.get(r.id).at);
        if (!(deletedAtByUrl.get(key) >= at)) deletedAtByUrl.set(key, at);
        continue;
      }
      if (Date.parse(r.created_at) <= deletedAtByUrl.get(key)) { deleted.add(r.id); continue; }
      const first = firstByUrl.get(key);
      if (!first) {
        firstByUrl.set(key, r.id);
        // It was a duplicate of a link that has since been deleted: it stands on its own now,
        // reusing that link's analysis (no AI call needed).
        const own = analyses.get(r.id);
        if (own?.status === 'duplicate') {
          const orig = analyses.get(own.duplicate_of);
          const a = orig?.status === 'analyzed'
            ? { ...orig, id: r.id, copied_from: orig.id, analyzed_at: new Date().toISOString() }
            : { id: r.id, status: 'failed', attempts: 0, error: 'original link was deleted', analyzed_at: new Date().toISOString() };
          analyses.set(r.id, a);
          await saveAnalysis(dir, a);
        }
        continue;
      }
      const a = analyses.get(r.id);
      if (!a || a.status !== 'duplicate') {
        const dup = { id: r.id, status: 'duplicate', duplicate_of: first, analyzed_at: new Date().toISOString() };
        analyses.set(r.id, dup);
        await saveAnalysis(dir, dup);
      }
    }

    // ---- archive: snapshot text + media of every live link before anything else ----
    const archiveStats = { created: 0, failed: 0 };
    {
      const budget = { remaining: DEFAULT_LIMITS.runBudgetBytes };
      const allowVideo = dirSize(path.join(dir, 'archive')) < DEFAULT_LIMITS.stopVideosAboveBytes;
      const byId = new Map(records.map((r) => [r.id, r]));
      const aLog = (m) => log(`archive: ${m}`);
      for (const id of firstByUrl.values()) {
        if (deleted.has(id)) continue;
        const record = byId.get(id);
        try {
          const res = await archiveLink({ dir, record, budget, allowVideo, log: aLog });
          if (res === 'created') archiveStats.created++;
          else if (res === 'failed') archiveStats.failed++;
          else if (res === 'exists') {
            // snapshot is never rewritten; only missing media files are added (e.g. what the phone could not fetch)
            const snap = await readSnapshot(dir, id);
            if (snap) await backfillMedia({ dir, snapshot: { ...snap, id }, budget, allowVideo, log: aLog });
          }
        } catch (e) { archiveStats.failed++; log(`WARN: archive ${id}: ${e.message}`); }
      }
      log(`archive: created=${archiveStats.created} failed=${archiveStats.failed} media=${Math.round((DEFAULT_LIMITS.runBudgetBytes - budget.remaining) / 1024)}KB total=${Math.round(dirSize(path.join(dir, 'archive')) / 1024 / 1024)}MB`);
    }

    // ---- related: context graph + linked resources of each X link (DESIGN-v3.md) ----
    {
      const rBudget = newRelatedBudget();
      const rStats = { created: 0, filled: 0, failed: 0 };
      const byId = new Map(records.map((r) => [r.id, r]));
      for (const id of firstByUrl.values()) {
        if (deleted.has(id)) continue;
        try {
          const res = await captureRelated({ dir, record: byId.get(id), budget: rBudget, log: (m) => log(`related: ${m}`) });
          if (res === 'created') rStats.created++;
          else if (res === 'filled') rStats.filled++;
          else if (res === 'failed') rStats.failed++;
        } catch (e) { rStats.failed++; log(`WARN: related ${id}: ${e.message}`); }
      }
      log(`related: created=${rStats.created} filled=${rStats.filled} failed=${rStats.failed} resources_fetched=${40 - rBudget.resources}`);
    }

    // id -> when related.json last gained supplement resources (v3.1), or null; only for links that have related.json
    const relatedIds = new Map();
    if (CONFIG.reanalyzeRelated) for (const r of records) {
      const f = path.join(dir, 'archive', r.id.slice(0, 4), r.id, 'related.json');
      if (fssync.existsSync(f)) {
        const xr = await readJson(path.join(path.dirname(f), 'related', 'x-replies.json'), null); // other people's replies (v3.2)
        relatedIds.set(r.id, { added: (await readJson(f, null))?.supplement?.resources_added_at || null, repliesN: xr?.replies?.length || 0, repliesAt: xr?.captured_at || null });
      }
    }
    const todo = CONFIG.archiveOnly ? [] : records.filter((r) => {
      const a = analyses.get(r.id);
      if (deleted.has(r.id)) return false; // don't spend AI on deleted links
      if (!a) return true;
      if (CONFIG.reanalyzeRelated && a.status === 'analyzed' && relatedIds.has(r.id)) {
        if (!a.primary_subject) return true;
        const rel = relatedIds.get(r.id);
        const seenAt = Date.parse(a.analyzed_at) || 0;
        const added = Date.parse(rel.added || '');
        if (added && added > seenAt) return true; // supplement resources the AI has not seen
        if (rel.repliesN && (a.related_used?.replies === undefined || Date.parse(rel.repliesAt || '') > seenAt)) return true; // replies the AI has not seen
      }
      if (a.status !== 'failed') return false;
      return (a.attempts || 0) < MAX_ATTEMPTS || Date.now() - new Date(a.analyzed_at).getTime() > DAY_MS;
    });
    log(`records=${records.length} deleted=${deleted.size} todo=${todo.length} backend=${CONFIG.backend} model=${CONFIG.model} ai=${CONFIG.useAi}`);

    let analyzed = 0, failed = 0;
    if (CONFIG.useAi && todo.length) {
      const analyzer = CONFIG.backend === 'api'
        ? (await import('./lib/analyze.mjs')).createApiAnalyzer({ model: CONFIG.model })
        : (await import('./lib/analyze-claude-code.mjs')).createClaudeCodeAnalyzer({ model: CONFIG.model, bin: CONFIG.claudeBin });
      const queue = todo.slice(0, CONFIG.maxPerRun);
      for (let i = 0; i < queue.length; i += analyzer.batchSize) {
        const batch = [];
        for (const r of queue.slice(i, i + analyzer.batchSize)) batch.push({ record: r, content: await loadContent(dir, r) });
        // Categories are updated between batches so later batches reuse new ones.
        const results = await analyzer.analyzeBatch(batch, categories);
        for (const { record: r, content } of batch) {
          const prev = analyses.get(r.id);
          try {
            const out = results.get(r.id);
            if (!out || out instanceof Error) throw out || new Error('no result');
            if (!categories.some((c) => c.name === out.category)) {
              categories.push({ name: out.category, description: out.new_category_description || '', created_at: new Date().toISOString() });
              log(`new category: ${out.category}`);
            }
            const { new_category_description, model, ...rest } = out;
            const a = {
              id: r.id,
              status: 'analyzed',
              analyzed_at: new Date().toISOString(),
              ...rest,
              source: {
                source_type: content.source_type,
                fetched: !!content.ok,
                title: content.title || null,
                author: content.author || null,
                published_at: content.published_at || null,
                final_url: content.final_url || null,
                fetch_error: content.ok ? null : content.error,
              },
              ...(content.related ? { related_used: { posts: content.related.posts.length, resources: content.related.resources.length, replies: content.related.replies.length }, primary_rule: content.related.primary } : {}),
              model,
            };
            analyses.set(r.id, a);
            await saveAnalysis(dir, a);
            analyzed++;
            log(`analyzed ${r.id} -> [${a.category}] ${a.title}`);
          } catch (e) {
            if (prev?.status === 'analyzed') { failed++; log(`FAILED re-analysis ${r.id} (kept the previous analysis): ${String(e.message || e)}`); continue; }
            const a = { id: r.id, status: 'failed', attempts: (prev?.attempts || 0) + 1, error: String(e.message || e), analyzed_at: new Date().toISOString() };
            analyses.set(r.id, a);
            await saveAnalysis(dir, a);
            failed++;
            log(`FAILED ${r.id} (attempt ${a.attempts}): ${a.error}`);
          }
        }
      }
    }

    if (!CONFIG.archiveOnly) await writeIfChanged(catFile, JSON.stringify(categories, null, 2) + '\n');

    const { files, stats } = buildOutputs({ records, analyses, categories, deleted, latestEvents, archives: await loadArchives(dir, records), related: await loadRelatedAll(dir, records) });
    // knowledge/categories is fully generated: remove files for categories that no longer exist.
    const catDir = path.join(dir, 'knowledge', 'categories');
    if (fssync.existsSync(catDir)) {
      for (const f of await fs.readdir(catDir)) {
        if (!files[`knowledge/categories/${f}`]) await fs.unlink(path.join(catDir, f));
      }
    }
    // ai/links and ai/categories are fully generated too (deleted links disappear; archive/ stays).
    for (const sub of ['ai/categories', 'ai/links']) {
      const root = path.join(dir, sub);
      const walk = async (d) => {
        let ents; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) { await walk(f); try { await fs.rmdir(f); } catch {} }
          else if (!files[path.relative(dir, f).split(path.sep).join('/')]) await fs.unlink(f);
        }
      };
      await walk(root);
    }
    for (const [rel, content] of Object.entries(files)) {
      if (rel === 'index.json') continue; // written last (contains a timestamp)
      await writeIfChanged(path.join(dir, rel), content);
    }
    // index.json carries a timestamp: rewrite it only when its content actually changed.
    const indexFile = path.join(dir, 'index.json');
    const withoutTime = (j) => (j ? JSON.stringify({ ...j, generated_at: null }) : null);
    if (withoutTime(await readJson(indexFile, null)) !== withoutTime(JSON.parse(files['index.json']))) {
      await writeIfChanged(indexFile, files['index.json']);
    }

    log(`done: analyzed=${analyzed} failed=${failed} total=${stats.total} pending=${stats.pending} categories=${stats.categories}`);

    if (CONFIG.useGit) {
      const pushed = gitCommitAndPush(CONFIG.archiveOnly
        ? `archive: ${archiveStats.created} snapshots (${new Date().toISOString().slice(0, 16)})`
        : `analyze: ${analyzed} links (${new Date().toISOString().slice(0, 16)})`);
      log(pushed ? 'pushed' : 'nothing to commit');
    }
  } finally {
    releaseLock();
  }
}

main().catch((e) => {
  log('ERROR:', e.stack || e.message || String(e));
  releaseLock();
  process.exitCode = 1;
});
