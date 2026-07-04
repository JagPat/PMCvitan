/* Vitan PMC service worker — conservative, safe caching.
 * - HTML/navigations: network-first, fall back to the cached shell offline.
 * - Hashed build assets (/assets/*): cache-first (they're immutable).
 * - Cross-origin (the API): never intercepted — always hits the network.
 * skipWaiting + clientsClaim so a new deploy takes over immediately. */
const VERSION = 'v1';
const CACHE = `vitan-pmc-${VERSION}`;
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icon.jpg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('vitan-pmc-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // only handle same-origin GET; the API (cross-origin) and non-GET pass through untouched
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // immutable hashed assets → cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // navigations / HTML → network-first, fall back to cached shell when offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || caches.match(request))),
    );
    return;
  }

  // other same-origin statics (favicon, manifest, icon) → cache-first
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});

/* Web Push (Phase 8): show the notification, and focus/open the app on click. */
self.addEventListener('push', (event) => {
  let data = { title: 'Vitan PMC', body: 'You have a new update.', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* non-JSON payload — keep the defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.jpg',
      badge: '/favicon.svg',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
