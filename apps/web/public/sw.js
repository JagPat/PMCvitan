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
// The app cache has its own version: v3 drops any error page or asset v2 kept; the files cache (offline drawings
// and media) keeps VERSION, so the field's offline set survives this bump.
const APP_VERSION = 'v3';
const CACHE = `vitan-pmc-${APP_VERSION}`;
const FILES_CACHE = `vitan-pmc-files-${VERSION}`;
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icon.jpg'];

/** A drawing revision or media file, on any origin (the API may be a subdomain). */
function isFileAsset(url) {
  return url.pathname.includes('/drawings/rev/') || url.pathname.includes('/media/');
}

/**
 * A name for a hashed file inside the shell or one of its files: '/assets/x', 'assets/x' (from the app root, as
 * Vite's preload list writes it) or './x' (beside the file that names it).
 */
const NAMED = /(?:\/assets\/|\bassets\/|\.\/)[\w.-]+/g;

/**
 * A file Vite emits: a hashed name with a known extension. The bundle's text also holds look-alikes ('./src',
 * './u.test', './.exec') that name no file; fetching one would 404 and fail every install.
 */
const EMITTED = /^\/assets\/[\w.-]+-[\w-]{8}\.(?:m?js|css|woff2?|ttf|otf|jpe?g|png|gif|svg|webp|avif|ico)$/;

/** The emitted files that `text`, read at `base` on this origin, names. */
function namedIn(text, base) {
  const paths = [];
  for (const ref of text.match(NAMED) || []) {
    const { pathname } = new URL(ref.startsWith('assets/') ? `/${ref}` : ref, base);
    if (EMITTED.test(pathname)) paths.push(pathname);
  }
  return paths;
}

/**
 * This build's files go into its own app cache at install: those the fresh shell names, and every file those name
 * in turn. One already there (a build sharing it) is not fetched again. A file the server will not give, or gives
 * from elsewhere, fails the install, so the last release keeps serving and the browser tries the update again later.
 * Nothing is read from an earlier release's cache: its worker may still be writing to it.
 */
function keepBuild(cache) {
  const seen = new Set();
  const keep = (paths) =>
    Promise.all(
      paths
        .filter((path) => !seen.has(path))
        .map((path) => {
          seen.add(path);
          return cache
            .match(path)
            .then(
              (hit) =>
                hit ||
                fetch(path).then((res) => {
                  if (!(res.ok && res.type === 'basic')) throw new TypeError(`${path} answered ${res.status}`);
                  return cache.put(path, res.clone()).then(() => res);
                }),
            )
            .then((res) => (/\.(?:m?js|css)$/.test(path) ? res.text() : ''))
            .then((text) => keep(namedIn(text, new URL(path, self.location.origin))));
        }),
    );
  return cache
    .match('/')
    .then((shell) => shell.text())
    .then((html) => keep(namedIn(html, new URL('/', self.location.origin))));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL).then(() => keepBuild(c)))
      .then(() => self.skipWaiting()),
  );
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
          // an opaque copy (kept from an <img>) has no bytes a CORS read can use: that read goes to the network
          if (hit && hit.type === 'opaque' && request.mode === 'cors') return network;
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
            // only a good file from this site is kept: a hashed asset is read from here from then on, online too
            if (res.ok && res.type === 'basic') {
              const copy = res.clone();
              event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)));
            }
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
          // only a good page from this site becomes the offline copy: an error answered mid-deploy would otherwise be what an offline phone shows
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            // the copy is part of the event, so the worker is not stopped before it is written
            event.waitUntil(caches.open(CACHE).then((c) => c.put('/', copy)));
          }
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

/**
 * Live bug 1c (owner, #482 6063443276) — a tap opens the record the notification names. The target is an app
 * path on this origin; anything else falls back to the app root. An open window is focused AND taken to the
 * record (a history entry, so Back returns to where the viewer was); with none, a new window opens there.
 */
function notificationTarget(data) {
  try {
    const url = new URL((data && data.url) || '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href;
  } catch {
    return new URL('/', self.location.origin).href;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = notificationTarget(event.notification.data);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const client = clients.find((candidate) => 'focus' in candidate);
      if (!client) return self.clients.openWindow(target);
      const focused = (await client.focus()) || client;
      if (focused.url === target) return focused;
      if ('navigate' in focused) {
        try {
          const navigated = await focused.navigate(target);
          if (navigated) return navigated;
        } catch {
          /* a window this worker does not control cannot be navigated: open the record instead */
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
