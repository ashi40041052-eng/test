/* Link Vault service worker: offline app shell + background sync. */
importScripts('./core.js');

const CACHE = 'lv-shell-v1';
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

  // Navigations (including share-target launches with ?url=...) get the cached shell,
  // so a shared link can be saved even with no connection.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Stale-while-revalidate for static files.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Android Chrome: retries automatically when connectivity returns, even if the app is closed.
self.addEventListener('sync', (e) => {
  if (e.tag !== 'lv-sync') return;
  e.waitUntil(
    self.LV.syncAll().then((r) => {
      if (r.configured && r.pending > 0 && !r.error) throw new Error('pending items remain; retry later');
      return self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage({ type: 'synced', result: r })));
    })
  );
});
