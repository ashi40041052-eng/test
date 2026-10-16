/* Link Vault PC dashboard. Read-only except trash (delete/restore events via LV.setDeleted).
 * Data: index.json, ai/manifest.jsonl, archive/<y>/<id>/snapshot.json + media/* from the data repo
 * (GitHub Contents API, raw). ?mock=1 reads the same layout from fixtures/mock/ instead. */
(function () {
  'use strict';
  const LV = self.LV, DL = self.DashLogic;
  const $ = (s) => document.querySelector(s);
  const MOCK = new URLSearchParams(location.search).get('mock') === '1';
  const DAY_MS = 86400000;
  const state = { index: null, manifest: new Map(), filters: {}, sel: null, view: [], events: new Map(), cfg: null };
  const urlCache = new Map(); // path -> object URL (this page load)

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeHref = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
  function fmtDate(iso, withTime) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + (withTime ? ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : '');
  }
  function shortUrl(u) { try { const x = new URL(u); return x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, ''); } catch (e) { return u || ''; } }
  let toastTimer;
  function toast(msg, action) {
    const t = $('#toast');
    t.innerHTML = esc(msg) + (action ? ' <button type="button">' + esc(action.label) + '</button>' : '');
    t.hidden = false;
    if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // ---------- data layer ----------
  const CACHE_TTL = DAY_MS;
  async function read(path, kind) { // kind: json | text | blob. Resolves null when missing.
    if (MOCK) {
      const r = await fetch('fixtures/mock/' + path);
      if (!r.ok) return null;
      return kind === 'json' ? r.json() : kind === 'blob' ? r.blob() : r.text();
    }
    const key = 'dash-cache:' + path;
    try {
      const c = await LV.kvGet(key);
      if (c && Date.now() - c.at < CACHE_TTL) return c.data;
    } catch (e) { /* cache is optional */ }
    const cfg = state.cfg;
    const r = await fetch(LV.apiUrl(cfg, path) + '?ref=' + encodeURIComponent(cfg.branch), { headers: LV.headers(cfg, true) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(path + ' (' + r.status + ')');
    const data = kind === 'json' ? await r.json() : kind === 'blob' ? await r.blob() : await r.text();
    try { await LV.kvSet(key, { at: Date.now(), data: data }); } catch (e) { /* quota: fine */ }
    return data;
  }
  async function mediaUrl(path) {
    if (urlCache.has(path)) return urlCache.get(path);
    const b = await read(path, 'blob');
    const u = b ? URL.createObjectURL(b) : null;
    urlCache.set(path, u);
    return u;
  }
  const snapCache = new Map();
  function loadSnapshot(id) {
    if (!snapCache.has(id)) snapCache.set(id, read(LV.archiveDir(id) + 'snapshot.json', 'json').catch(() => null));
    return snapCache.get(id);
  }

  async function loadAll(network) {
    if (MOCK) {
      state.index = await read('index.json', 'json');
      state.events = new Map();
    } else {
      state.cfg = await LV.getConfig();
      if (!LV.isConfigured(state.cfg)) return false;
      state.index = (await LV.cachedIndex()) || null;
      if (network !== false) { try { state.index = (await LV.fetchIndex()) || state.index; } catch (e) { if (!state.index) throw e; } }
      state.events = await LV.latestEvents();
    }
    try { state.manifest = DL.parseManifest(await read('ai/manifest.jsonl', 'text')); } catch (e) { state.manifest = new Map(); }
    return true;
  }

  // Same rule as the phone app: this device's latest event wins while unsent or newer than the index.
  function isDeleted(id, it) {
    const ev = state.events.get(id);
    const at = it && it.event_at;
    if (ev && (!ev.synced_at || !at || ev.at >= at)) return ev.action === 'delete';
    return !!(it && it.deleted);
  }
  const metaOf = (id) => state.manifest.get(id);
  const titleOf = (it) => it.title || (it.url ? shortUrl(it.url) : 'メモ');

  // ---------- state <-> URL ----------
  function readHash() {
    const h = DL.parseHash(location.hash);
    state.filters = { cat: h.cat, tag: h.tag, q: h.q, per: h.per, st: h.st, trash: h.trash === '1' ? '1' : '' };
    state.sel = h.id || null;
    $('#q').value = h.q || '';
  }
  function writeHash() {
    const f = state.filters;
    const h = DL.buildHash({ id: state.sel, cat: f.cat, tag: f.tag, q: f.q, per: f.per, st: f.st, trash: f.trash });
    history.replaceState(null, '', location.pathname + location.search + h);
  }

  // ---------- rendering ----------
  function visibleBase() { // trash-filtered only, for facet counts
    return (state.index ? state.index.items : []).filter((it) => (state.filters.trash ? isDeleted(it.id, it) : !isDeleted(it.id, it)));
  }
  function recompute() {
    const items = state.index ? state.index.items : [];
    state.view = DL.filterItems(items, state.filters, isDeleted, metaOf, Date.now());
  }

  function renderSide() {
    const f = state.filters;
    const fc = DL.facets(visibleBase());
    const opt = (key, val, label, n) => '<button type="button" class="fopt' + ((f[key] || '') === val ? ' on' : '') + '" data-k="' + key + '" data-v="' + esc(val) + '"><span>' + esc(label) + '</span>' + (n == null ? '' : '<span class="n">' + n + '</span>') + '</button>';
    const total = visibleBase().length;
    $('#side').innerHTML =
      '<h3>カテゴリ</h3>' + opt('cat', '', 'すべて', total) + fc.cats.map((c) => opt('cat', c.name, c.name, c.count)).join('') +
      '<h3>期間</h3>' + [['', 'すべて'], ['7', '7日'], ['30', '30日'], ['365', '1年']].map(([v, l]) => opt('per', v, l)).join('') +
      '<h3>状態</h3>' + [['', 'すべて'], ['pending', '未分析'], ['analyzed', '分析済み'], ['archived', 'アーカイブ済み'], ['unarchived', '未アーカイブ']].map(([v, l]) => opt('st', v, l)).join('') +
      '<h3>タグ</h3><div class="tagcloud">' + fc.tags.slice(0, 40).map((t) => opt('tag', t.name, t.name, t.count)).join('') + '</div>' +
      '<h3>ゴミ箱</h3>' + opt('trash', '', '通常', null) + opt('trash', '1', 'ゴミ箱を表示', null);
  }

  function cardHtml(it) {
    const meta = metaOf(it.id);
    const status = it.status === 'analyzed' ? '<span class="st-ok">分析済み</span>' : '<span class="st-wait">未分析</span>';
    const arch = meta ? (meta.ar ? '<span class="st-ok">📦</span>' : '') : '';
    const au = it.author && (it.author.name || it.author.handle || it.author);
    return '<div class="card' + (it.id === state.sel ? ' sel' : '') + '" data-id="' + esc(it.id) + '">' +
      '<div class="t">' + esc(titleOf(it)) + '</div>' +
      '<div class="s">' + esc(it.summary || it.note || it.url || '') + '</div>' +
      ((meta && meta.ar) ? '<img class="thumb" alt="" data-thumb="' + esc(it.id) + '">' : '<span></span>') +
      '<div class="m">' + status + arch + (au ? '<span>' + esc(au) + '</span>' : '') + '<span>' + esc(fmtDate(it.created_at)) + '</span>' +
      (it.category ? '<span class="tag">' + esc(it.category) + '</span>' : '') + '</div></div>';
  }

  function renderList() {
    const list = $('#list');
    $('#count').textContent = state.view.length + ' 件' + (state.filters.trash ? '（ゴミ箱）' : '');
    list.innerHTML = state.view.length ? state.view.map(cardHtml).join('') : '<div class="empty">条件に合うリンクがありません</div>';
    observeThumbs();
  }

  // Thumbnails load lazily (2 requests each), 3 at a time.
  let thumbIO, thumbQueue = [], thumbBusy = 0;
  function observeThumbs() {
    if (!thumbIO) {
      thumbIO = new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting) { thumbIO.unobserve(e.target); thumbQueue.push(e.target); pumpThumbs(); }
      }), { root: $('#list'), rootMargin: '200px' });
    }
    thumbQueue = [];
    document.querySelectorAll('img[data-thumb]').forEach((img) => thumbIO.observe(img));
  }
  function pumpThumbs() {
    while (thumbBusy < 3 && thumbQueue.length) {
      const img = thumbQueue.shift();
      thumbBusy++;
      (async () => {
        const id = img.dataset.thumb;
        const snap = await loadSnapshot(id);
        const rel = DL.firstLocalMedia(snap);
        const u = rel ? await mediaUrl(LV.archiveDir(id) + rel) : null;
        if (u && img.isConnected) img.src = u; else if (img.isConnected) img.style.visibility = 'hidden';
      })().catch(() => {}).finally(() => { thumbBusy--; pumpThumbs(); });
    }
  }

  function chips(arr) { return (arr || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join(' '); }

  async function renderDetail() {
    const box = $('#detail');
    const id = state.sel;
    const it = state.index && state.index.items.find((x) => x.id === id);
    if (!it) { box.innerHTML = '<div class="empty">左の一覧からリンクを選択</div>'; return; }
    const del = isDeleted(id, it);
    const head = '<h2>' + esc(titleOf(it)) + '</h2><div class="meta">' +
      '<span>保存 ' + esc(fmtDate(it.created_at, true)) + '</span>' +
      (it.category ? '<span>' + esc(it.category) + '</span>' : '') +
      '<span>' + (it.status === 'analyzed' ? '分析済み' : it.status === 'failed' ? '分析失敗' : '未分析') + '</span>' +
      (del ? '<span class="err">ゴミ箱</span>' : '') + '</div>' +
      (it.url ? '<div><a href="' + esc(safeHref(it.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(shortUrl(it.url)) + '</a></div>' : '') +
      (it.tags && it.tags.length ? '<div style="margin-top:6px">' + chips(it.tags) + '</div>' : '');
    const analysis = (it.summary ? '<h4>要約</h4><div>' + esc(it.summary) + '</div>' : '') +
      (it.key_points && it.key_points.length ? '<h4>ポイント</h4><ul>' + it.key_points.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' : '') +
      (it.note ? '<h4>メモ</h4><div>' + esc(it.note) + '</div>' : '');
    const actions = '<div class="actions"><button type="button" data-act="trash">' + (del ? '戻す (d)' : 'ゴミ箱へ (d)') + '</button>' +
      (it.url ? '<button type="button" data-act="open">元URLを開く (o)</button>' : '') + '</div>';
    box.innerHTML = head + analysis + '<h4>アーカイブ</h4><div id="archBox" class="muted">読み込み中…</div>' + actions;
    box.scrollTop = 0;
    let snap = null, errMsg = '';
    try { snap = await loadSnapshot(id); } catch (e) { errMsg = e.message; }
    if (state.sel !== id) return; // user moved on
    const ab = $('#archBox');
    if (!ab) return;
    if (!snap) { ab.textContent = errMsg || 'まだアーカイブされていません（processor が約20分おきに取得します）'; return; }
    ab.className = '';
    const au = snap.author;
    let h = '<div class="meta"><span>' + (au ? esc((au.name || '') + ' ' + (au.handle || '')) : '') + '</span>' +
      (snap.published_at ? '<span>投稿 ' + esc(fmtDate(snap.published_at, true)) + '</span>' : '') +
      '<span>取得 ' + esc(fmtDate(snap.captured_at, true)) + ' (' + esc(snap.captured_by || '') + ')</span>' +
      (snap.stats ? '<span>♥' + (snap.stats.likes ?? '-') + ' ⟲' + (snap.stats.reposts ?? '-') + ' 👁' + (snap.stats.views ?? '-') + '</span>' : '') + '</div>';
    const text = snap.text || (snap.web && snap.web.text) || '';
    if (text) h += '<div class="body">' + esc(text) + '</div>';
    if (snap.article && snap.article.text) h += '<h4>記事' + (snap.article.title ? ': ' + esc(snap.article.title) : '') + '</h4><div class="body">' + esc(snap.article.text) + '</div>';
    if (snap.quote) h += '<h4>引用元' + (snap.quote.author && snap.quote.author.handle ? ' ' + esc(snap.quote.author.handle) : '') + '</h4><div class="quote">' + esc(snap.quote.text || '') + '</div>';
    if (snap.community_note) h += '<h4>コミュニティノート</h4><div class="quote">' + esc(typeof snap.community_note === 'string' ? snap.community_note : JSON.stringify(snap.community_note)) + '</div>';
    const photos = (snap.media || []).filter((m) => m.local);
    const remote = (snap.media || []).length - photos.length;
    if (photos.length) h += '<h4>メディア ' + photos.length + '</h4><div class="gallery" id="gal">' + photos.map((m) => '<figure><img alt="' + esc(m.alt || '') + '" data-local="' + esc(m.local) + '"><figcaption>' + esc(m.type + (m.width ? ' ' + m.width + '×' + m.height : '') + (m.alt ? ' — ' + m.alt : '')) + '</figcaption></figure>').join('') + '</div>';
    if (remote > 0) h += '<div class="muted">ローカル未保存のメディア ' + remote + ' 件（動画など。processor が後追い保存）</div>';
    ab.innerHTML = h;
    ab.querySelectorAll('img[data-local]').forEach(async (img) => {
      const u = await mediaUrl(LV.archiveDir(id) + img.dataset.local).catch(() => null);
      if (u && state.sel === id) img.src = u;
    });
  }

  function renderAll() {
    recompute();
    renderSide();
    renderList();
    writeHash();
    renderDetail();
  }
  function select(id, scroll) {
    state.sel = id;
    document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel'));
    const card = id && document.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
    if (card) { card.classList.add('sel'); if (scroll) card.scrollIntoView({ block: 'nearest' }); }
    writeHash();
    renderDetail();
  }

  // ---------- trash ----------
  async function toggleTrash(id) {
    const it = state.index.items.find((x) => x.id === id);
    if (!it) return;
    const next = !isDeleted(id, it);
    const idx = state.view.findIndex((x) => x.id === id);
    if (MOCK) state.events.set(id, { target: id, action: next ? 'delete' : 'restore', at: new Date().toISOString(), synced_at: null });
    else {
      await LV.setDeleted(id, next);
      state.events = await LV.latestEvents();
      LV.syncAll().then(() => LV.latestEvents()).then((e) => { state.events = e; }).catch(() => {});
    }
    recompute();
    const after = state.view[Math.min(idx, state.view.length - 1)];
    state.sel = after ? after.id : null;
    renderSide(); renderList(); writeHash(); renderDetail();
    toast(next ? 'ゴミ箱に移しました' : '戻しました', { label: '取り消し', run: () => toggleTrash(id) });
  }

  // ---------- events ----------
  function setFilter(k, v) {
    state.filters[k] = v || '';
    renderAll();
  }
  function bind() {
    $('#side').addEventListener('click', (e) => { const b = e.target.closest('.fopt'); if (b) setFilter(b.dataset.k, b.dataset.v); });
    $('#list').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) select(c.dataset.id); });
    $('#detail').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (b) { if (b.dataset.act === 'trash') toggleTrash(state.sel); else openUrl(); return; }
      const img = e.target.closest('.gallery img');
      if (img) img.parentElement.classList.toggle('big');
    });
    let qt;
    $('#q').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => setFilter('q', e.target.value.trim()), 120); });
    $('#refresh').onclick = () => init(true);
    $('#theme').onclick = () => {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('lv-dash-theme', next); } catch (e) { /* ignore */ }
    };
    window.addEventListener('hashchange', () => { readHash(); renderAll(); });
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const typing = e.target.tagName === 'INPUT';
      if (e.key === 'Escape') { if (typing || state.filters.q) { $('#q').value = ''; $('#q').blur(); setFilter('q', ''); } return; }
      if (typing) { if (e.key === 'Enter') { $('#q').blur(); } return; }
      const k = e.key;
      if (k === '/') { e.preventDefault(); $('#q').focus(); }
      else if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (k === 'o') openUrl();
      else if (k === 'd' && state.sel) toggleTrash(state.sel);
      else if (k === 't') setFilter('trash', state.filters.trash ? '' : '1');
      else if (k === 'r') init(true);
    });
  }
  function move(delta) {
    const i = DL.step(state.view, state.sel, delta);
    if (i >= 0) select(state.view[i].id, true);
  }
  function openUrl() {
    const it = state.index && state.index.items.find((x) => x.id === state.sel);
    if (it && /^https?:\/\//i.test(it.url || '')) window.open(it.url, '_blank', 'noopener');
  }

  async function init(reload) {
    try {
      const ok = await loadAll(true);
      $('#setup').hidden = ok;
      $('#layout').hidden = !ok;
      if (!ok) return;
      if (!state.index) { $('#list').innerHTML = '<div class="empty">index.json がまだありません（processor の初回実行後に表示されます）</div>'; return; }
      if (reload !== true) readHash();
      if (!state.sel && state.index.items.length) { recompute(); if (state.view[0]) state.sel = state.view[0].id; }
      renderAll();
    } catch (e) {
      $('#list').innerHTML = '<div class="empty err">読み込みエラー: ' + esc(e.message) + '</div>';
    }
  }

  try { const t = localStorage.getItem('lv-dash-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* ignore */ }
  $('#mockBadge').hidden = !MOCK;
  bind();
  init();
})();
