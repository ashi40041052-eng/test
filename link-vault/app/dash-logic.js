/* Link Vault dashboard: pure logic (no DOM, no network) so it can be unit-tested in node. */
(function (g) {
  'use strict';

  // "#id=..&cat=..&q=.." <-> object. Only known keys are kept.
  const KEYS = ['id', 'cat', 'tag', 'q', 'per', 'st', 'trash'];
  function parseHash(hash) {
    const out = {};
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    KEYS.forEach((k) => { const v = p.get(k); if (v) out[k] = v; });
    return out;
  }
  function buildHash(s) {
    const p = new URLSearchParams();
    KEYS.forEach((k) => { if (s[k]) p.set(k, s[k]); });
    const t = p.toString();
    return t ? '#' + t : '';
  }

  const DAY = 86400000;
  const PERIODS = { '7': 7 * DAY, '30': 30 * DAY, '365': 365 * DAY };

  function haystack(it, meta) {
    return [it.title, it.summary, it.note, it.url, it.category, it.author && (it.author.name || it.author.handle || it.author),
      (it.tags || []).join(' '), (it.key_points || []).join(' '), meta && meta.a, meta && (meta.g || []).join(' ')]
      .filter(Boolean).join('\n').toLowerCase();
  }

  // Every whitespace-separated term must appear (AND search).
  function matchesQuery(it, meta, q) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const h = haystack(it, meta);
    return terms.every((t) => h.includes(t));
  }

  // filters: {cat, tag, q, per, st('pending'|'archived'|'unarchived'|'analyzed'), trash}
  // isDeleted(id,item) decides trash membership; metaOf(id) returns the manifest row or undefined.
  function filterItems(items, f, isDeleted, metaOf, now) {
    const t0 = (now || Date.now());
    return items.filter((it) => {
      const del = isDeleted(it.id, it);
      if (f.trash ? !del : del) return false;
      if (f.cat && it.category !== f.cat) return false;
      if (f.tag && !(it.tags || []).includes(f.tag)) return false;
      if (f.per && PERIODS[f.per] && t0 - new Date(it.created_at).getTime() > PERIODS[f.per]) return false;
      const meta = metaOf(it.id);
      if (f.st === 'pending' && it.status === 'analyzed') return false;
      if (f.st === 'analyzed' && it.status !== 'analyzed') return false;
      if (f.st === 'archived' && !(meta && meta.ar)) return false;
      if (f.st === 'unarchived' && meta && meta.ar) return false;
      return matchesQuery(it, meta, f.q);
    });
  }

  // Counts for the sidebar from the already trash-filtered list (ignores cat/tag so they stay clickable).
  function facets(items) {
    const cats = new Map(), tags = new Map();
    items.forEach((it) => {
      if (it.category) cats.set(it.category, (cats.get(it.category) || 0) + 1);
      (it.tags || []).forEach((t) => tags.set(t, (tags.get(t) || 0) + 1));
    });
    const sort = (m) => Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
    return { cats: sort(cats), tags: sort(tags) };
  }

  function parseManifest(text) {
    const m = new Map();
    String(text || '').split('\n').forEach((line) => {
      if (!line.trim()) return;
      try { const r = JSON.parse(line); if (r && r.id) m.set(r.id, r); } catch (e) { /* skip bad line */ }
    });
    return m;
  }

  // Next/previous selection index with clamping; -1 when the list is empty.
  function step(list, currentId, delta) {
    if (!list.length) return -1;
    const i = list.findIndex((x) => x.id === currentId);
    if (i < 0) return delta > 0 ? 0 : list.length - 1;
    return Math.max(0, Math.min(list.length - 1, i + delta));
  }

  // First locally stored photo of a snapshot, or null. Media files are in <archiveDir>/media/.
  function firstLocalMedia(snap) {
    const m = ((snap && snap.media) || []).find((x) => x.local && x.type === 'photo');
    return m ? m.local : null;
  }

  g.DashLogic = { parseHash, buildHash, matchesQuery, filterItems, facets, parseManifest, step, firstLocalMedia };
})(typeof self !== 'undefined' ? self : globalThis);
