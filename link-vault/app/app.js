/* Link Vault UI */
(function () {
  'use strict';
  const LV = self.LV;
  const $ = (s) => document.querySelector(s);
  const state = { mode: 'timeline', category: null, query: '', index: null, local: [], events: new Map() };

  // ---------- helpers ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function safeHref(u) { return /^https?:\/\//i.test(u || '') ? u : '#'; }
  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function dayKey(iso) {
    const d = new Date(iso);
    const w = '日月火水木金土'[d.getDay()];
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日（' + w + '）';
  }
  function shortUrl(u) {
    try { const x = new URL(u); return x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, ''); } catch (e) { return u || ''; }
  }

  let toastTimer;
  function toast(msg, ms, action) {
    const t = $('#toast');
    t.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => { t.hidden = true; action.run(); });
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }

  // ---------- saving ----------

  async function save(text, via, sharedUrl) {
    try {
      const items = await LV.saveInput(text, via, sharedUrl);
      if (!items.length) { toast('保存する内容がありません'); return false; }
      toast(items.length > 1 ? items.length + '件を端末に保存しました ✓' : '端末に保存しました ✓');
      await refreshLocal();
      requestSync();
      return true;
    } catch (e) {
      alert(e.message || String(e));
      return false;
    }
  }

  async function pasteFromClipboard() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      toast('クリップボードを読めませんでした。下の欄に貼り付けてください', 3500);
      $('#input').focus();
      return;
    }
    if (!text.trim()) { toast('クリップボードが空です'); return; }
    await save(text, 'clipboard');
  }

  // Shared from another app (Android share sheet) -> ?url=&text=&title=
  async function handleShareLaunch() {
    const p = new URLSearchParams(location.search);
    if (!p.has('url') && !p.has('text') && !p.has('title')) return;
    const text = [p.get('title'), p.get('text')].filter(Boolean).join('\n');
    history.replaceState(null, '', location.pathname);
    await save(text, 'share', p.get('url') || '');
  }

  // ---------- sync ----------

  let syncTimer = null;
  function requestSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(doSync, 300);
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then((r) => r.sync.register('lv-sync')).catch(() => {});
    }
  }

  async function doSync(manual) {
    try {
      const r = await LV.syncAll();
      if (manual) {
        if (!r.configured) toast('設定タブで保存先を設定してください', 3500);
        else if (r.error) toast('送信エラー: ' + r.error, 5000);
        else if (r.pending) toast('未送信 ' + r.pending + '件（通信回復後に再送）', 3500);
        else toast('すべて送信済みです');
      }
    } catch (e) {
      if (manual) toast('送信エラー: ' + e.message, 4000);
    }
    await refreshLocal();
  }

  function updateBadge() {
    const b = $('#syncBadge');
    const pending = state.local.filter((i) => !i.synced_at)
      .concat([...state.events.values()].filter((e) => !e.synced_at));
    const err = pending.find((i) => i.sync_error);
    b.hidden = false;
    b.className = 'badge' + (err ? ' err' : pending.length ? '' : ' ok');
    b.textContent = err ? '⚠ 送信エラー' : pending.length ? '未送信 ' + pending.length + '件' : '☁ 同期済み';
  }

  // ---------- rendering ----------

  async function refreshLocal() {
    state.local = (await LV.getAllItems()).sort((a, b) => b.id.localeCompare(a.id));
    state.events = await LV.latestEvents();
    updateBadge();
    renderTrash();
    renderRecent();
    if (!$('#view-list').hidden) renderList();
    renderStorageInfo();
  }

  function analyzedMap() {
    const m = new Map();
    if (state.index) for (const it of state.index.items) m.set(it.id, it);
    return m;
  }

  function statusChip(local, analyzed) {
    if (analyzed && analyzed.status === 'analyzed') return '<span class="chip">✅ 分析済み</span>';
    if (local && !local.synced_at) {
      return local.sync_error
        ? '<span class="chip status-err">⚠ 未送信（' + esc(local.sync_error) + '）</span>'
        : '<span class="chip status-local">📱 端末に保存済み・送信待ち</span>';
    }
    return '<span class="chip">☁ 送信済み・分析待ち</span>';
  }

  // A local delete/restore event wins over what the (older) index says.
  function isDeleted(id, indexItem) {
    const ev = state.events.get(id);
    if (ev) return ev.action === 'delete';
    return !!(indexItem && indexItem.deleted);
  }

  function itemHtml(it, local, inTrash) {
    const analyzed = it.status === 'analyzed';
    const title = analyzed && it.title ? it.title : (it.url ? shortUrl(it.url) : 'メモ');
    const head = it.url
      ? '<a class="title" href="' + esc(safeHref(it.url)) + '" target="_blank" rel="noopener">' + esc(title) + '</a>' +
        '<a class="url" href="' + esc(safeHref(it.url)) + '" target="_blank" rel="noopener">' + esc(shortUrl(it.url)) + '</a>'
      : '<span class="title">' + esc(title) + '</span>';
    const summary = analyzed && it.summary ? '<p class="summary">' + esc(it.summary) + '</p>' : '';
    const points = analyzed && it.key_points && it.key_points.length
      ? '<details><summary>ポイント</summary><ul>' + it.key_points.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul></details>'
      : '';
    const note = it.note ? '<p class="note">📝 ' + esc(it.note) + '</p>' : '';
    const cat = analyzed && it.category ? '<button type="button" class="chip cat" data-cat="' + esc(it.category) + '">' + esc(it.category) + '</button>' : '';
    const tags = analyzed && it.tags ? it.tags.map((t) => '<span class="chip">#' + esc(t) + '</span>').join('') : '';
    return '<li class="item">' + head + summary + points + note +
      '<div class="foot">' + cat + tags + '<span>' + esc(fmtDate(it.created_at)) + '</span>' + (inTrash ? '' : statusChip(local, it)) +
      (inTrash
        ? '<button type="button" class="act" data-restore="' + esc(it.id) + '">↩ 戻す</button>'
        : '<button type="button" class="act" data-del="' + esc(it.id) + '" aria-label="削除">🗑</button>') +
      '</div></li>';
  }

  function renderRecent() {
    const m = analyzedMap();
    const html = state.local.filter((l) => !isDeleted(l.id, m.get(l.id))).slice(0, 20)
      .map((l) => itemHtml(Object.assign({}, l, m.get(l.id) || {}), l)).join('');
    $('#recent').innerHTML = html || '<li class="meta">まだ何も保存されていません</li>';
  }

  // Index items + local items the index doesn't know about yet (unsent / not analyzed).
  function allItems() {
    return allRows().filter(({ it }) => !isDeleted(it.id, it));
  }

  function allRows() {
    const index = state.index;
    const known = new Set(index ? index.known_ids || index.items.map((i) => i.id) : []);
    const localById = new Map(state.local.map((l) => [l.id, l]));
    const fromIndex = index ? index.items.map((i) => ({ it: i, local: localById.get(i.id) })) : [];
    const extra = state.local.filter((l) => !known.has(l.id)).map((l) => ({ it: Object.assign({ status: 'pending' }, l), local: l }));
    return extra.concat(fromIndex).sort((a, b) => new Date(b.it.created_at) - new Date(a.it.created_at));
  }

  function matches(it, q) {
    if (!q) return true;
    const hay = [it.title, it.summary, it.note, it.url, it.category, (it.tags || []).join(' '), (it.key_points || []).join(' ')].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }

  function renderChips(rows) {
    const counts = new Map();
    rows.forEach(({ it }) => { if (it.status === 'analyzed' && it.category) counts.set(it.category, (counts.get(it.category) || 0) + 1); });
    const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    $('#catChips').innerHTML = state.mode === 'timeline' && cats.length
      ? '<button type="button" class="chip' + (state.category ? '' : ' on') + '" data-cat="">すべて</button>' +
        cats.map(([c, n]) => '<button type="button" class="chip' + (state.category === c ? ' on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + ' ' + n + '</button>').join('')
      : '';
  }

  function renderList() {
    let rows = allItems().filter(({ it }) => matches(it, state.query));
    renderChips(rows);
    if (state.mode === 'timeline' && state.category) rows = rows.filter(({ it }) => it.category === state.category);

    const gen = state.index && state.index.generated_at ? '最終分析: ' + fmtDate(state.index.generated_at) + ' / ' : '';
    $('#listMeta').textContent = gen + rows.length + '件';

    const body = $('#listBody');
    if (!rows.length) {
      body.innerHTML = '<p class="meta">' + (state.index ? '該当するリンクはありません' : 'まだ分析結果がありません。PC側の分析が実行されると表示されます。') + '</p>';
      return;
    }

    if (state.mode === 'timeline') {
      let html = '', cur = '';
      for (const { it, local } of rows) {
        const k = dayKey(it.created_at);
        if (k !== cur) { if (cur) html += '</ul>'; html += '<div class="day">' + esc(k) + '</div><ul class="list">'; cur = k; }
        html += itemHtml(it, local);
      }
      body.innerHTML = html + '</ul>';
      return;
    }

    const groups = new Map();
    for (const r of rows) {
      const c = r.it.status === 'analyzed' && r.it.category ? r.it.category : '未分類（分析待ち）';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(r);
    }
    const desc = new Map(((state.index && state.index.categories) || []).map((c) => [c.name, c.description]));
    body.innerHTML = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([c, list]) =>
      '<details class="cat-group"' + (state.query ? ' open' : '') + '><summary>' + esc(c) + '<span class="count">' + list.length + '件</span>' +
      (desc.get(c) ? '<span class="desc">' + esc(desc.get(c)) + '</span>' : '') + '</summary><ul class="list">' +
      list.map(({ it, local }) => itemHtml(it, local)).join('') + '</ul></details>'
    ).join('');
  }

  function renderTrash() {
    const rows = allRows().filter(({ it }) => isDeleted(it.id, it));
    $('#trashMeta').textContent = rows.length ? rows.length + '件。「戻す」で一覧に復活します。' : 'ゴミ箱は空です';
    $('#trash').innerHTML = rows.map(({ it, local }) => itemHtml(it, local, true)).join('');
  }

  async function setDeleted(id, deleted) {
    await LV.setDeleted(id, deleted);
    await refreshLocal();
    if (!$('#view-list').hidden) renderList();
    requestSync();
  }

  async function deleteItem(id) {
    if (!confirm('このリンクを削除しますか？\n（設定タブのゴミ箱から戻せます）')) return;
    await setDeleted(id, true);
    toast('削除しました', 6000, { label: '元に戻す', run: () => setDeleted(id, false).then(() => toast('元に戻しました')) });
  }

  async function loadIndex(network) {
    state.index = (await LV.cachedIndex()) || null;
    renderList();
    renderRecent();
    renderTrash();
    if (!network) return;
    try {
      const fresh = await LV.fetchIndex();
      if (fresh) { state.index = fresh; renderList(); renderRecent(); renderTrash(); }
    } catch (e) { /* offline or not configured: cached copy is shown */ }
  }

  async function renderStorageInfo() {
    const total = state.local.filter((l) => !isDeleted(l.id)).length;
    const pending = state.local.filter((i) => !i.synced_at).length;
    let persisted = '不明';
    try { if (navigator.storage && navigator.storage.persisted) persisted = (await navigator.storage.persisted()) ? '有効' : '無効（ホーム画面に追加すると有効になりやすい）'; } catch (e) {}
    $('#storageInfo').textContent = '端末内: ' + total + '件（未送信 ' + pending + '件） / 端末ストレージ永続化: ' + persisted;
  }

  // ---------- views ----------

  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
    if (name === 'list') loadIndex(true);
    if (name === 'settings') fillSettings();
    window.scrollTo(0, 0);
  }

  async function fillSettings() {
    const c = await LV.getConfig();
    const f = $('#settingsForm');
    f.owner.value = c.owner; f.repo.value = c.repo; f.branch.value = c.branch; f.token.value = c.token;
    renderStorageInfo();
  }

  // ---------- events ----------

  function bind() {
    $('#pasteBtn').addEventListener('click', pasteFromClipboard);

    $('#addForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = $('#input').value;
      if (await save(v, 'manual')) $('#input').value = '';
    });

    // Pasting a bare URL saves immediately.
    $('#input').addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!$('#input').value.trim() && LV.extractUrls(text).length) {
        e.preventDefault();
        save(text, 'paste');
      }
    });

    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    $('#syncBadge').addEventListener('click', () => doSync(true));
    $('#syncNow').addEventListener('click', () => doSync(true));

    $('#search').addEventListener('input', (e) => { state.query = e.target.value.trim(); renderList(); });
    document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
      state.mode = b.dataset.mode;
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      renderList();
    }));
    document.addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { deleteItem(del.dataset.del); return; }
      const res = e.target.closest('[data-restore]');
      if (res) { setDeleted(res.dataset.restore, false).then(() => toast('一覧に戻しました')); return; }
      const chip = e.target.closest('[data-cat]');
      if (!chip) return;
      state.mode = 'timeline';
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x.dataset.mode === 'timeline'));
      state.category = chip.dataset.cat || null;
      if ($('#view-list').hidden) showView('list'); else renderList();
    });

    $('#settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const cfg = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim() || 'main', token: f.token.value.trim() };
      await LV.setConfig(cfg);
      const msg = $('#settingsMsg');
      msg.textContent = '接続テスト中…';
      try {
        await LV.testConnection(cfg);
        msg.textContent = '✓ 接続OK。保存済みのリンクを送信します。';
        // Earlier fatal errors may have been caused by the old settings: clear them and retry.
        for (const it of state.local.filter((i) => !i.synced_at && i.sync_error)) { it.sync_error = null; await LV.putItem(it); }
        doSync(true);
      } catch (err) {
        msg.textContent = '✗ ' + err.message;
      }
    });

    $('#exportBtn').addEventListener('click', async () => {
      const items = await LV.getAllItems();
      const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'link-vault-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });

    window.addEventListener('online', () => requestSync());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestSync(); });
    setInterval(() => { if (navigator.onLine) doSync(); }, 60000);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'synced') refreshLocal(); });
    }
  }

  async function init() {
    bind();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
    try {
      const restored = await LV.reconcileBackup();
      if (restored) toast('バックアップから ' + restored + '件を復元しました');
    } catch (e) { console.warn(e); }
    await refreshLocal();
    await handleShareLaunch();
    await loadIndex(false);
    const cfg = await LV.getConfig();
    if (!LV.isConfigured(cfg)) toast('はじめに「設定」で保存先を登録してください（未設定でも端末には保存されます）', 5000);
    requestSync();
    loadIndex(true);
  }

  init();
})();
