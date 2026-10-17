/* Link Vault dashboard: pure logic (no DOM, no network) so it can be unit-tested in node. */
(function (g) {
  'use strict';

  // "#id=..&cat=..&q=.." <-> object. Only known keys are kept.
  const KEYS = ['id', 'cat', 'tag', 'q', 'per', 'st', 'trash', 'sub', 'mk'];
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
    return [it.title, it.tldr, it.summary, it.note, it.url, it.category, it.author && (it.author.name || it.author.handle || it.author),
      (it.tags || []).join(' '), (it.key_points || []).join(' '), meta && meta.a, meta && (meta.g || []).join(' '),
      meta && meta.pu, meta && meta.pn, it.primary_subject && it.primary_subject.name, it.resource_kind]
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
      if (f.sub && ((meta && meta.pk) || '-') !== f.sub) return false;
      if (f.mk === 'todo' && it.mark === 'done') return false;
      if (f.mk === 'done' && it.mark !== 'done') return false;
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
      const pk = (m && m.pk) || '-'; // items without a subject count under "なし" so the counts sum to the total
      subs.set(pk, (subs.get(pk) || 0) + 1);
      if (it.category) cats.set(it.category, (cats.get(it.category) || 0) + 1);
      (it.tags || []).forEach((t) => tags.set(t, (tags.get(t) || 0) + 1));
    });
    const sort = (m) => Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
    return { cats: sort(cats), tags: sort(tags), subs: Array.from(subs, ([key, count]) => ({ key, count })).sort((a, b) => (a.key === '-') - (b.key === '-') || b.count - a.count) };
  }

  // Counts for the 対応 filter from the trash-filtered list (a missing mark is todo).
  function markCounts(items) {
    let done = 0;
    items.forEach((it) => { if (it.mark === 'done') done++; });
    return { all: items.length, todo: items.length - done, done: done };
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

  // The selected id if it is in the current view, else null (a hidden link must not keep its detail pane).
  function keepSelection(view, selId) {
    return selId && view.some((x) => x.id === selId) ? selId : null;
  }

  // Header text for logs/x-replies-status.json ({state: ok|skip|error, reason, at, last_ok_at}); '' when absent.
  function xrStatusText(st) {
    if (!st || !st.state) return '';
    const d = (iso) => { const t = new Date(iso); return isNaN(t) ? '' : (t.getMonth() + 1) + '/' + t.getDate() + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); };
    if (st.state === 'ok') return 'リプ取得: 正常 ' + d(st.at);
    return 'リプ取得: ' + (st.state === 'error' ? 'エラー' : 'スキップ') + (st.reason ? ' (' + String(st.reason).slice(0, 40) + ')' : '') + (st.last_ok_at ? ' · 最終成功 ' + d(st.last_ok_at) : '');
  }

  // true when the rendered thread already shows the saved post's own text (the archive section must not repeat it)
  function threadShowsPost(view) {
    const th = (view && view.thread) || [];
    return (th.length > 1 || th.some((p) => p.quote)) && th.some((p) => p.role === 'self' && p.text);
  }

  // true when the rendered thread already shows a quoted post (the archive section must not repeat it as 引用元)
  function threadShowsQuote(view) {
    const th = (view && view.thread) || [];
    return (th.length > 1 || th.some((p) => p.quote)) && th.some((p) => p.quote);
  }

  // First locally stored photo of a snapshot, or null. Media files are in <archiveDir>/media/.
  function firstLocalMedia(snap) {
    const m = ((snap && snap.media) || []).find((x) => x.local && x.type === 'photo');
    return m ? m.local : null;
  }

  // ---- v3: related graph (related.json, written by the processor; schema in DESIGN-v3.md section 2) ----
  const PK = { r: ['📦', 'リポジトリ'], m: ['🧠', 'モデル'], p: ['📄', '論文'], s: ['🌐', 'サイト'], v: ['▶️', '動画'], x: ['💬', 'ポスト'] };
  const TYPE_PK = { github: 'r', hf: 'm', arxiv: 'p', web: 's', youtube: 'v' };
  const pkInfo = (pk) => PK[pk] || (pk === '-' ? ['', 'なし'] : null);
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
  // normalized url for matching a reply link against a resource (scheme / www / trailing slash / case ignored)
  const normUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[#?].*$/, '').replace(/\/+$/, '');

  // Other people's replies (related/x-replies.json): each reply gets the resource chips whose url it links to.
  function repliesView(doc, resources, max) {
    if (!doc || !Array.isArray(doc.replies)) return [];
    return doc.replies.slice(0, max || 30).map((r) => {
      const links = (r.links || []).map(normUrl);
      return Object.assign({}, r, {
        resources: resources.filter((x) => links.some((l) => l === normUrl(x.url) || l.indexOf(normUrl(x.url) + '/') === 0)),
      });
    });
  }

  // ---- v4: resources first (DESIGN-v4.md section 3/4) ----
  // Where a resource was found. rank orders the cards: saved post < parent/quote < own continuation < others' replies < profile.
  const ROLE_WHERE = { self: [1, '保存ポスト内'], parent: [2, '親ポスト'], quote: [2, '引用元'], self_reply: [3, '本人の続き'] };
  function resourceWhere(r, posts) {
    const role = new Map((posts || []).map((p) => [p.sid, p.role]));
    let best = null;
    (r.found_in || []).forEach((sid) => { const w = ROLE_WHERE[role.get(sid)]; if (w && (!best || w[0] < best[0])) best = w; });
    if (best) return { rank: best[0], where: best[1] };
    const o = r.origin || '';
    if (o === 'x_replies_self') return { rank: 3, where: '本人のリプ' };
    if (o === 'x_replies') return { rank: 4, where: '他人のリプ' };
    if (o.indexOf('profile:') === 0) return { rank: 5, where: 'プロフィール ' + o.slice(8) };
    return { rank: 6, where: o };
  }
  // The resource this link was saved for: AI primary_subject first, then the rule-based primary of related.json.
  function primaryResource(rel, resources, aiPrimary) {
    if (aiPrimary && aiPrimary.url) {
      const r = resources.find((x) => normUrl(x.url) === normUrl(aiPrimary.url));
      if (r) return { resource: r, reason: 'ai' };
    }
    const pr = rel && rel.primary;
    if (pr && pr.kind === 'resource') {
      const r = resources.find((x) => x.n === pr.n);
      if (r) return { resource: r, reason: pr.reason || '' };
    }
    return null;
  }
  // Every resource of a link once (same url dropped), ordered subject -> saved post -> parent/quote -> own continuation
  // -> others' replies -> profile (ties: discovery order n). Works on related.json alone (the AI reading is optional).
  function resourceCards(rel, aiPrimary) {
    if (!rel || !Array.isArray(rel.resources)) return [];
    const resources = rel.resources.map((r) => Object.assign({}, r, { pk: TYPE_PK[r.type] || 's' }, resourceWhere(r, rel.posts)));
    const pr = primaryResource(rel, resources, aiPrimary);
    const seen = new Set();
    return resources
      .map((r) => Object.assign(r, { subject: !!(pr && pr.resource.n === r.n) }))
      .sort((a, b) => (b.subject - a.subject) || (a.rank - b.rank) || ((a.n || 0) - (b.n || 0)))
      .filter((r) => { const k = normUrl(r.url); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  // Display name of a resource from its meta json (loaded lazily by the dashboard).
  const resourceTitle = (r, m) => (m && (m.full_name || m.id || m.title)) || r.name || r.key || r.url;

  function relatedView(rel, aiPrimary, repliesDoc) {
    if (!rel || !Array.isArray(rel.posts) || !rel.posts.length) return null;
    const resources = (rel.resources || []).map((r) => Object.assign({}, r, { pk: TYPE_PK[r.type] || 's' }, resourceWhere(r, rel.posts)));
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
    // each resource URL is shown as a chip once: thread first, then replies, then "その他のリソース"
    const shown = new Set();
    const firstSeen = (list) => list.filter((r) => { const k = normUrl(r.url); if (shown.has(k)) return false; shown.add(k); return true; });
    const thread = parents.concat(selfP, replies).map(view).map((p) => Object.assign({}, p, { resources: firstSeen(p.resources) }));
    let primary = null;
    const pr = rel.primary;
    const pres = primaryResource(rel, resources, aiPrimary);
    if (pres) primary = { kind: 'resource', resource: pres.resource, reason: pres.reason };
    if (!primary && pr && pr.kind === 'post') {
      const p = rel.posts.find((x) => x.sid === pr.sid);
      if (p) primary = { kind: 'post', post: view(p), reason: pr.reason || '' };
    }
    const pk = primary ? (primary.kind === 'resource' ? primary.resource.pk : 'x') : '-';
    const others = repliesView(repliesDoc, resources).map((r) => Object.assign({}, r, { resources: firstSeen(r.resources) }));
    const rest = resources.filter((r) => !(primary && primary.resource && primary.resource.n === r.n) && !shown.has(normUrl(r.url)));
    return { thread, resources, cards: resourceCards(rel, aiPrimary), rest, replies: others, primary, pk, hasContext: thread.length > 1 || resources.length > 0 || others.length > 0, counts: { posts: rel.posts.length, resources: resources.length, replies: others.length } };
  }

  g.DashLogic = { markCounts, TYPE_PK, resourceCards, resourceWhere, resourceTitle, PK, pkInfo, subjectLabel, relatedView, parseHash, buildHash, matchesQuery, filterItems, facets, parseManifest, step, firstLocalMedia, keepSelection, xrStatusText, threadShowsPost, threadShowsQuote };
})(typeof self !== 'undefined' ? self : globalThis);
