/* Vitan PMC service worker — conservative, safe caching.
 * - HTML/navigations: network-first, fall back to the cached shell offline.
 * - Hashed build assets (/assets/*): cache-first (they're immutable).
 * - Drawing / media files (any origin, /drawings/rev/* or /media/*):
 *   stale-while-revalidate, so the current For-Construction set stays viewable
 *   in the field when the signal drops (Drawings Slice 3). Content is effectively
 *   immutable — a new revision gets a new id/URL — so a cached hit is safe.
 * - Other cross-origin (the API JSON): never intercepted — always hits the network.
 * skipWaiting + clientsClaim so a new deploy takes over immediately. */
const VERSION = 'v2';
const CACHE = `vitan-pmc-${VERSION}`;
const FILES_CACHE = `vitan-pmc-files-${VERSION}`;
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icon.jpg'];

/** A drawing revision or media file, on any origin (the API may be a subdomain). */
function isFileAsset(url) {
  return url.pathname.includes('/drawings/rev/') || url.pathname.includes('/media/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('vitan-pmc-') && k !== CACHE && k !== FILES_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // Drawing / media files (any origin) → stale-while-revalidate so the current
  // set opens offline in the field. Opaque (no-cors) responses are cacheable and
  // render fine in <iframe>/<img>/<a download>; a failed revalidate keeps the hit.
  if (isFileAsset(url)) {
    event.respondWith(
      caches.open(FILES_CACHE).then((cache) =>
        cache.match(request).then((hit) => {
          const network = fetch(request)
            .then((res) => {
              if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || network;
        }),
      ),
    );
    return;
  }

  // only handle same-origin GET beyond here; the API JSON (cross-origin) passes through
  if (url.origin !== self.location.origin) return;

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
