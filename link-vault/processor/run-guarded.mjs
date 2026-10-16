#!/usr/bin/env node
/*
 * Entry for scheduled (launchd/cron) runs. The jobs run from the working tree, so a half-edited file would crash
 * process.mjs on import. Before running, `node --check` every .mjs of process.mjs + lib/; on a syntax error log ONE
 * line and exit 0 (the next scheduled run tries again). Otherwise run process.mjs with the same arguments.
 * LV_GUARD_DIR overrides the directory checked/run (tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = process.env.LV_GUARD_DIR || path.dirname(fileURLToPath(import.meta.url));
const files = [path.join(dir, 'process.mjs')];
try { for (const f of fs.readdirSync(path.join(dir, 'lib')).sort()) if (f.endsWith('.mjs')) files.push(path.join(dir, 'lib', f)); } catch {}
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    const why = String(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'syntax error';
    console.log(`[${new Date().toISOString()}] skip: syntax error in ${path.relative(dir, f)} (${why.trim().slice(0, 160)}); will retry next run`);
    process.exit(0);
  }
}
const r = spawnSync(process.execPath, [path.join(dir, 'process.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
