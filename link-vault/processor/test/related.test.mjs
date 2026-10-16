// R1: pure functions of lib/related.mjs against real recorded fxtwitter v2 threads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphFromThread, classifyUrl, canonicalUrl, dedupeResources, parseArxivAtom } from '../lib/related.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const fx = async (n) => JSON.parse(await fs.readFile(path.join(HERE, 'fixtures', 'related', n), 'utf8'));
const roles = (g) => g.posts.map((p) => `${p.role}${p.depth}`).join(',');

test('c07e399d: parent1, self, self_reply1, quote comes from the parent; primary = github', async () => {
  const g = graphFromThread(await fx('fx2-thread-c07e399d.json'), '2110552871565660462');
  assert.equal(roles(g), 'parent1,self0,self_reply1,quote1');
  assert.equal(g.posts.find((p) => p.role === 'quote').of, '2110552869531529601');
  assert.equal(g.posts.find((p) => p.role === 'self').urls[0], 'https://github.com/builderio/agent-native');
  assert.equal(g.primary.kind, 'resource');
  assert.equal(g.resources[g.primary.n - 1].type, 'github');
  assert.equal(g.resources[0].key, 'builderio/agent-native');
  assert.ok(g.resources.some((r) => r.type === 'web' && /builder\.io\/blog/.test(r.url)));
  assert.ok(Object.keys(g.objects).length === 4);
});

test('a27279bf: self replies carry the HF links; primary = hf (first one, deterministic)', async () => {
  const j = await fx('fx2-thread-a27279bf.json');
  const g = graphFromThread(j, '2110763835175153885');
  assert.equal(roles(g), 'self0,self_reply1,self_reply2,quote0');
  assert.equal(g.primary.kind, 'resource');
  assert.equal(g.resources[0].type, 'hf');
  assert.equal(g.resources[0].key, 'black-forest-labs/flux-3-image-klein-comfy');
  assert.deepEqual(graphFromThread(j, '2110763835175153885').primary, g.primary);
});

test('84c52ab8: github only in the quoted post -> primary github (from the quote)', async () => {
  const g = graphFromThread(await fx('fx2-thread-84c52ab8.json'), '2110574328156971471');
  assert.equal(roles(g), 'self0,quote0');
  assert.equal(g.resources[0].key, 'MaryCache/imozuru');
  assert.equal(g.primary.kind, 'resource');
  assert.match(g.primary.reason, /quoted post/);
});

test('4aeb4268: url-only post with a parent; primary = hf', async () => {
  const g = graphFromThread(await fx('fx2-thread-4aeb4268.json'), '2110164449470652678');
  assert.equal(roles(g), 'parent1,self0');
  assert.equal(g.resources[0].key, 'fishaudio/drama-3');
  assert.equal(g.primary.kind, 'resource');
});

test('6ab719ad: nothing to follow -> self; 06fd91fe: self reply has HF links -> resource', async () => {
  const g = graphFromThread(await fx('fx2-thread-6ab719ad.json'), '2110727758884352474');
  assert.equal(g.primary.kind, 'self');
  assert.deepEqual(g.resources, []);
  const h = graphFromThread(await fx('fx2-thread-06fd91fe.json'), '2110755123748340030');
  assert.equal(h.primary.kind, 'resource');
  assert.equal(h.resources[0].type, 'hf');
});

test('limits: 3 parents, 5 self replies; fallback to status only', async () => {
  const mk = (id, extra = {}) => ({ id: String(id), text: `t${id}`, author: { screen_name: 'a' }, ...extra });
  const thread = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => mk(i));
  const g = graphFromThread({ thread }, '5');
  assert.equal(roles(g), 'parent3,parent2,parent1,self0,self_reply1,self_reply2,self_reply3,self_reply4,self_reply5');
  const s = graphFromThread({ status: mk(42) }, '42');
  assert.equal(roles(s), 'self0');
  const extra = graphFromThread({ status: mk(42) }, '42', { extraParents: [mk(41), mk(40)] });
  assert.equal(roles(extra), 'parent2,parent1,self0');
});

test('official quote without url becomes the subject post', () => {
  const root = { id: '2', text: 'これすごい', author: { screen_name: 'u' }, quote: { id: '1', text: 'Introducing X', author: { screen_name: 'corp', verification: { type: 'business' } } } };
  const g = graphFromThread({ thread: [root] }, '2');
  assert.deepEqual(g.primary.kind, 'post');
  assert.equal(g.primary.sid, '1');
});

test('URL normalization, classification and dedupe', () => {
  assert.equal(canonicalUrl('https://www.Example.com/a/?utm_source=x&b=1#frag'), 'https://example.com/a?b=1');
  assert.equal(classifyUrl('https://github.com/o/r/tree/main/src?utm_x=1').url, 'https://github.com/o/r');
  assert.equal(classifyUrl('https://github.com/o/r/').key, 'o/r');
  assert.equal(classifyUrl('https://github.com/topics/ai').type, 'web');
  assert.equal(classifyUrl('https://huggingface.co/o/m/blob/main/README.md').url, 'https://huggingface.co/o/m');
  assert.equal(classifyUrl('https://huggingface.co/datasets/o/d/tree/main').url, 'https://huggingface.co/datasets/o/d');
  assert.equal(classifyUrl('https://huggingface.co/spaces/o/s').hfKind, 'spaces');
  assert.equal(classifyUrl('https://arxiv.org/pdf/2401.01234v2.pdf').key, '2401.01234');
  assert.equal(classifyUrl('https://youtu.be/abc123?si=zz').url, 'https://www.youtube.com/watch?v=abc123');
  for (const u of ['https://x.com/a/status/1', 'https://t.co/abc', 'https://pbs.twimg.com/media/a.jpg', 'https://e.com/v.mp4', 'mailto:a@b.c', 'notaurl']) assert.equal(classifyUrl(u), null, u);
  const d = dedupeResources([
    { url: 'https://github.com/o/r', sid: '1' }, { url: 'https://www.github.com/O/r/tree/main', sid: '2' },
    { url: 'https://e.com/p/?utm_source=a', sid: '1' }, { url: 'https://e.com/p', sid: '1' },
  ]);
  assert.equal(d.length, 2);
  assert.deepEqual(d[0].found_in, ['1', '2']);
});

test('arxiv atom parse (recorded)', async () => {
  const xml = await fs.readFile(path.join(HERE, 'fixtures', 'related', 'arxiv-query-sample.xml'), 'utf8');
  const a = parseArxivAtom(xml);
  assert.match(a.title, /Attention/i);
  assert.ok(a.authors.length > 3);
  assert.ok(a.abstract.length > 200);
});
