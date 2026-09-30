// Service worker: instant repeat visits and offline use of visited areas.
//   /assets/*            content-hashed JS/CSS/wasm → cache-first (immutable)
//   /textures/*, fonts   cache-first
//   navigations, *.json, /data/transit/*   network-first, cached copy when offline
//     (schedules must match the transit index of the same upload, so no
//      stale-while-revalidate; the HTTP cache still covers quick revisits)
// Tile bytes are cached by the tile workers themselves (Cache Storage
// "tiles-<build>"), so they are not handled here. Responses keep their
// COOP/COEP headers, so cached pages stay cross-origin isolated.
const SHELL = 'shell-v1';
const DATA = 'data-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/'])).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if ((k.startsWith('shell-') && k !== SHELL) || (k.startsWith('data-') && k !== DATA)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type !== 'opaque') c.put(req, res.clone());
  return res;
}

async function networkFirst(req, name) {
  const c = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    const p = url.pathname;
    if (p.startsWith('/assets/') || p.startsWith('/textures/') || p.startsWith('/fonts/')) return e.respondWith(cacheFirst(req, SHELL));
    if (p.startsWith('/data/transit/')) return e.respondWith(networkFirst(req, DATA));
    if (p.startsWith('/data/tiles/') || p.startsWith('/data/graph/') || p === '/rum') return; // tile workers cache these
    if (req.mode === 'navigate') return e.respondWith(networkFirst(req, SHELL));
    if (p.endsWith('.json')) return e.respondWith(networkFirst(req, DATA));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    return e.respondWith(cacheFirst(req, SHELL));
  }
});
