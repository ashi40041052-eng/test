#!/usr/bin/env node
// Mark links 対応済み / 未対応 and push the change.
//   node mark.mjs <id|url> [<id|url> ...] done|todo [--note "..."] [--by ai|human] [--data <dir>] [--no-git]
// Writes marks/<id>.json, commits only marks/ and pushes (same lock file and pull --rebase as process.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTarget, writeMark, STATUSES } from './lib/marks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function tryLock(lockFile) {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) return false;
    if (!(Number.isInteger(pid) && pid > 0) && Date.now() - fs.statSync(lockFile).mtimeMs < 3600_000) return false;
    fs.unlinkSync(lockFile);
  } catch {}
  try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
}

export async function runMark(argv, env = process.env) {
  const args = [...argv];
  const take = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const gi = args.indexOf('--no-git');
  if (gi >= 0) args.splice(gi, 1);
  const noGit = gi >= 0 || env.LV_NO_GIT === '1';
  const note = take('--note');
  const by = take('--by') || 'ai';
  const dataDir = path.resolve(take('--data') || env.LV_DATA_DIR || '');
  const status = args.find((a) => STATUSES.includes(a));
  const targets = args.filter((a) => a !== status);
  if (!status || !targets.length) throw new Error('usage: mark.mjs <id|url>... done|todo [--note "..."]');
  if (!env.LV_DATA_DIR && !argv.includes('--data')) throw new Error('LV_DATA_DIR is not set');
  const git = (...a) => execFileSync('git', ['-C', dataDir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, GIT_AUTHOR_NAME: 'Link Vault', GIT_AUTHOR_EMAIL: 'link-vault@users.noreply.github.com', GIT_COMMITTER_NAME: 'Link Vault', GIT_COMMITTER_EMAIL: 'link-vault@users.noreply.github.com' } }).trim();

  const lockFile = env.LV_LOCK_FILE || path.join(os.tmpdir(), 'link-vault-processor.lock');
  let locked = false;
  if (!noGit) {
    for (let i = 0; i < 120 && !(locked = tryLock(lockFile)); i++) await new Promise((r) => setTimeout(r, 1000));
    if (!locked) throw new Error('processor lock is busy; try again');
  }
  try {
    if (!noGit) {
      try { if (fs.existsSync(path.join(dataDir, git('rev-parse', '--git-path', 'rebase-merge')))) git('rebase', '--abort'); } catch {}
      try { git('pull', '--rebase', '--autostash', '-X', 'theirs'); } catch (e) { try { git('rebase', '--abort'); } catch {} console.error('WARN: pull failed, continuing locally'); }
    }
    const done = [];
    for (const t of targets) {
      const id = await resolveTarget(dataDir, t);
      await writeMark(dataDir, id, status, { by, note });
      done.push(id);
    }
    if (!noGit) {
      git('add', '--', ...done.map((id) => `marks/${id}.json`));
      if (git('diff', '--cached', '--name-only', '--', 'marks')) git('commit', '-m', `mark: ${status} ${done.length} link(s) (${by})`, '--', 'marks');
      let ahead = true; try { ahead = Number(git('rev-list', '--count', '@{u}..HEAD')) > 0; } catch {}
      if (ahead) {
        let ok = false;
        for (let i = 0; i < 4 && !ok; i++) {
          try { git('push', '-u', 'origin', 'HEAD'); ok = true; } catch { try { git('pull', '--rebase', '--autostash', '-X', 'theirs'); } catch { try { git('rebase', '--abort'); } catch {} } }
        }
        if (!ok) throw new Error('git push failed; the mark is committed locally and will be pushed by the next run');
      }
    }
    return done;
  } finally { if (locked) try { fs.unlinkSync(lockFile); } catch {} }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = path.join(HERE, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  runMark(process.argv.slice(2)).then((ids) => console.log(ids.join('\n'))).catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
}
