/* Link Vault dashboard: pure logic (no DOM, no network) so it can be unit-tested in node. */
(function (g) {
  'use strict';

  // "#id=..&cat=..&q=.." <-> object. Only known keys are kept.
  const KEYS = ['id', 'cat', 'tag', 'q', 'per', 'st', 'trash', 'sub'];
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
      if (f.sub && (!meta || (meta.pk || '-') !== f.sub)) return false;
      if (f.st === 'pending' && it.status === 'analyzed') return false;
      if (f.st === 'analyzed' && it.status !== 'analyzed') return false;
      if (f.st === 'archived' && !(meta && meta.ar)) return false;
      if (f.st === 'unarchived' && meta && meta.ar) return false;
      return matchesQuery(it, meta, f.q);
    });
  }

  // Counts for the sidebar from the already trash-filtered list (ignores cat/tag so they stay clickable).
  function facets(items, metaOf) {
    const cats = new Map(), tags = new Map(), subs = new Map();
    items.forEach((it) => {
      const m = metaOf && metaOf(it.id);
      if (m && m.pk && m.pk !== '-') subs.set(m.pk, (subs.get(m.pk) || 0) + 1);
      if (it.category) cats.set(it.category, (cats.get(it.category) || 0) + 1);
      (it.tags || []).forEach((t) => tags.set(t, (tags.get(t) || 0) + 1));
    });
    const sort = (m) => Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
    return { cats: sort(cats), tags: sort(tags), subs: Array.from(subs, ([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count) };
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

  // ---- v3: related graph (related.json, written by the processor; schema in DESIGN-v3.md section 2) ----
  const PK = { r: ['📦', 'リポジトリ'], m: ['🧠', 'モデル'], p: ['📄', '論文'], s: ['🌐', 'サイト'], v: ['▶️', '動画'], x: ['💬', 'ポスト'] };
  const TYPE_PK = { github: 'r', hf: 'm', arxiv: 'p', web: 's', youtube: 'v' };
  const pkInfo = (pk) => PK[pk] || null;
  function subjectLabel(pu) { // short display name for a primary url
    try {
      const u = new URL(pu);
      const h = u.host.replace(/^www\./, '');
      const seg = u.pathname.split('/').filter(Boolean);
      if ((h === 'github.com' || h === 'huggingface.co') && seg.length >= 2) {
        const i = (seg[0] === 'datasets' || seg[0] === 'spaces') ? 1 : 0;
        return seg[i] + '/' + seg[i + 1];
      }
      return h + u.pathname.replace(/\/$/, '');
    } catch (e) { return String(pu || ''); }
  }

  // Pure view of related.json: thread order (farthest parent -> parents -> self -> self replies),
  // quotes nested under the post they quote, resources attached to the posts they were found in,
  // and the primary subject. aiPrimary ({kind,url,name}) from analysis wins over the rule-based primary.
  function relatedView(rel, aiPrimary) {
    if (!rel || !Array.isArray(rel.posts) || !rel.posts.length) return null;
    const resources = (rel.resources || []).map((r) => Object.assign({}, r, { pk: TYPE_PK[r.type] || 's' }));
    const quotes = new Map();
    rel.posts.filter((p) => p.role === 'quote').forEach((q) => { if (q.of && !quotes.has(q.of)) quotes.set(q.of, q); });
    const view = (p) => {
      const q = (p.quote_sid && rel.posts.find((x) => x.sid === p.quote_sid && x.role === 'quote')) || quotes.get(p.sid) || null;
      return Object.assign({}, p, {
        quote: q,
        resources: resources.filter((r) => (r.found_in || []).includes(p.sid) || (q && (r.found_in || []).includes(q.sid))),
      });
    };
    const byDepth = (a, b) => (b.depth || 0) - (a.depth || 0);
    const parents = rel.posts.filter((p) => p.role === 'parent').sort(byDepth);
    const selfP = rel.posts.filter((p) => p.role === 'self');
    const replies = rel.posts.filter((p) => p.role === 'self_reply').sort((a, b) => (a.depth || 0) - (b.depth || 0));
    const thread = parents.concat(selfP, replies).map(view);
    let primary = null;
    const pr = rel.primary;
    if (aiPrimary && aiPrimary.url) {
      const r = resources.find((x) => x.url === aiPrimary.url);
      if (r) primary = { kind: 'resource', resource: r, reason: 'ai' };
    }
    if (!primary && pr && pr.kind === 'resource') {
      const r = resources.find((x) => x.n === pr.n);
      if (r) primary = { kind: 'resource', resource: r, reason: pr.reason || '' };
    }
    if (!primary && pr && pr.kind === 'post') {
      const p = rel.posts.find((x) => x.sid === pr.sid);
      if (p) primary = { kind: 'post', post: view(p), reason: pr.reason || '' };
    }
    const pk = primary ? (primary.kind === 'resource' ? primary.resource.pk : 'x') : '-';
    return { thread, resources, primary, pk, hasContext: thread.length > 1 || resources.length > 0, counts: { posts: rel.posts.length, resources: resources.length } };
  }

  g.DashLogic = { PK, pkInfo, subjectLabel, relatedView, parseHash, buildHash, matchesQuery, filterItems, facets, parseManifest, step, firstLocalMedia };
})(typeof self !== 'undefined' ? self : globalThis);
