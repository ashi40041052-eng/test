#!/usr/bin/env node
// ONE-TIME migration (round 1): x-replies.json captured before the parent/self-thread filter held the thread's own posts
// and text cut at "さらに表示". Deletes every archive's related/x-replies.json + x-replies-attempts.json and clears
// supplement.xreplies_done in related.json so the next processor run re-captures them (LV_XREPLIES_PER_RUN per run).
// Re-running is a no-op: .migrations/xreplies-v2 in the data dir marks it done. The processor's normal git flow commits the result.
// Usage: node scripts/migrate-xreplies-once.mjs --data <data dir> [--dry]
import fs from 'node:fs/promises';
import path from 'node:path';
import { walkJson, readJson } from '../lib/util.mjs';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const dry = process.argv.includes('--dry');
const data = path.resolve(arg('--data') || process.env.LV_DATA_DIR || '');
const marker = path.join(data, '.migrations', 'xreplies-v2');
const exists = (f) => fs.access(f).then(() => true, () => false);

if (!data || !(await exists(path.join(data, 'archive')))) { console.error('data dir with archive/ required (--data)'); process.exit(1); }
if (await exists(marker)) { console.log('already migrated (marker present): nothing to do'); process.exit(0); }

let removed = 0, cleared = 0;
for (const f of await walkJson(path.join(data, 'archive'))) {
  if (path.basename(f) !== 'related.json' || path.basename(path.dirname(f)) === 'related') continue;
  const dir = path.dirname(f);
  for (const name of ['x-replies.json', 'x-replies-attempts.json']) {
    const t = path.join(dir, 'related', name);
    if (await exists(t)) { if (!dry) await fs.unlink(t); removed++; }
  }
  const rel = await readJson(f, null);
  if (rel?.supplement && ('xreplies_done' in rel.supplement || 'xreplies_trigger' in rel.supplement)) {
    delete rel.supplement.xreplies_done; delete rel.supplement.xreplies_trigger;
    if (!dry) await fs.writeFile(f, JSON.stringify(rel, null, 2) + '\n');
    cleared++;
  }
}
if (!dry) { await fs.mkdir(path.dirname(marker), { recursive: true }); await fs.writeFile(marker, new Date().toISOString() + '\n'); }
console.log(`${dry ? '[dry] ' : ''}removed ${removed} files, reset ${cleared} related.json`);
