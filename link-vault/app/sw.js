/* Link Vault service worker: offline app shell + background sync. */
importScripts('./core.js');

const CACHE = 'lv-shell-v5';
const SHELL_MARKER = 'id="pasteBtn"'; // present only in this app's index.html
const SHELL = ['./', './index.html', './style.css', './core.js', './app.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // GitHub API etc. always go to network

  // Network first, so a new release is used as soon as the app is opened online; the cache
  // is the offline fallback. Navigations (including share-target launches with ?url=...)
  // fall back to the cached shell, so a shared link can be saved with no connection.
  // Only successful responses are cached: an error page must never replace the shell.
  const fallback = () => (req.mode === 'navigate'
    ? caches.match('./index.html')
    : caches.match(req, { ignoreSearch: true }));
  e.respondWith(
    fetch(req).then(async (res) => {
      if (!res.ok) return (await fallback()) || res;
      if (req.mode === 'navigate') {
        // Wi-Fi login pages answer 200 with their own HTML: only trust the real app shell.
        const html = await res.clone().text();
        if (!html.includes(SHELL_MARKER)) return (await fallback()) || res;
        const c = await caches.open(CACHE);
        await c.put('./index.html', new Response(html, { headers: res.headers }));
        return res;
      }
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => fallback())
  );
});

// Android Chrome: retries automatically when connectivity returns, even if the app is closed.
self.addEventListener('sync', (e) => {
  if (e.tag !== 'lv-sync') return;
  e.waitUntil(
    // Snapshot captures started by syncAll are best-effort; wait for them (never fail on them).
    self.LV.syncAll().then((r) => self.LV.capturesIdle().catch(() => {}).then(() => r)).then((r) => {
      if (r.configured && r.pending > 0 && !r.error) throw new Error('pending items remain; retry later');
      return self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage({ type: 'synced', result: r })));
    })
  );
});
