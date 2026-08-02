// Minimal service worker — only exists to make admin.html installable as an app.
// It intentionally does NOT cache API/data calls, so the dashboard always reflects
// live data from the server/database. It only caches the static app shell.

const CACHE_NAME = '2mg-admin-shell-v1';
const SHELL_FILES = [
  '/admin.html',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — admin data must always be fresh, and the
  // kill switch check in particular must never be served from cache.
  // Note: '/admin/' (trailing slash) matches API routes like /admin/login,
  // /admin/stats, etc. — it does NOT match the /admin.html shell file itself.
  if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/kill-switch')) {
    return; // let it hit the network normally
  }

  // For the shell itself, try network first so updates land quickly,
  // falling back to cache only if offline.
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
