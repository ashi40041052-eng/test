import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// dash-logic.js is a classic browser script: importing it registers globalThis.DashLogic.
await import('../dash-logic.js');
const DL = globalThis.DashLogic;
const idx = JSON.parse(fs.readFileSync(new URL('../fixtures/mock/index.json', import.meta.url)));
const man = DL.parseManifest(fs.readFileSync(new URL('../fixtures/mock/ai/manifest.jsonl', import.meta.url), 'utf8'));
const del = (id, it) => !!it.deleted;
const NOW = new Date('2026-10-16T03:00:00Z').getTime();

test('hash roundtrip', () => {
  const h = DL.buildHash({ id: 'a b', cat: 'AI音声生成', q: 'x y' });
  assert.deepEqual(DL.parseHash(h), { id: 'a b', cat: 'AI音声生成', q: 'x y' });
  assert.equal(DL.buildHash({}), '');
});
test('filters: trash, category, AND search, period, state', () => {
  const f = (o) => DL.filterItems(idx.items, o, del, (id) => man.get(id), NOW);
  assert.equal(f({}).length, 7);
  assert.equal(f({ trash: '1' }).length, 1);
  assert.equal(f({ cat: 'AI音声生成' }).length, 2);
  assert.equal(f({ q: 'drama3 vram' }).length, 1);
  assert.equal(f({ q: 'tts nonexistent' }).length, 0);
  assert.equal(f({ per: '7' }).length, 6);
  assert.equal(f({ st: 'pending' }).length, 1);
  assert.equal(f({ st: 'archived' }).length, 4);
});
test('facets, step, firstLocalMedia', () => {
  const fc = DL.facets(idx.items.filter((i) => !i.deleted));
  assert.equal(fc.cats[0].count >= fc.cats[1].count, true);
  assert.equal(DL.step([], 'x', 1), -1);
  const l = [{ id: 'a' }, { id: 'b' }];
  assert.equal(DL.step(l, 'a', 1), 1);
  assert.equal(DL.step(l, 'b', 1), 1);
  assert.equal(DL.step(l, null, 1), 0);
  assert.equal(DL.firstLocalMedia({ media: [{ type: 'video', local: 'media/01.mp4' }, { type: 'photo', local: 'media/02.jpg' }] }), 'media/02.jpg');
  assert.equal(DL.firstLocalMedia(null), null);
});
