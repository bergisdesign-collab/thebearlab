// The cache belongs to this installation path; other apps on the host may also use Cache Storage.
const prefix = 'thebearlab-shell:' + new URL(self.registration.scope).pathname + ':';
const cacheName = prefix + 'v2';
const shell = [
  'index.html', 'manifest.webmanifest', 'logo.png', 'icon-192.png', 'icon-512.png',
  'icon-maskable-512.png', 'apple-touch-icon.png', 'teddy.json',
  'sandbox/bear-reference.webp', 'sandbox/order-model.js', 'sandbox/order-ui.js',
  'sandbox/order-ui.css', 'sandbox/workshop.css',
  'vendor/three-r147/three.min.js', 'vendor/three-r147/OrbitControls.js', 'vendor/three-r147/GLTFLoader.js'
];
const files = new Set(shell.map(path => new URL(path, self.registration.scope).href));
const index = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(Array.from(files, url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const previous = (await caches.keys()).filter(key => key.startsWith(prefix) && key !== cacheName);
    await Promise.all(previous.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const key = request.mode === 'navigate' ? index : request.url;
  if (!files.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(request);
      if (response.ok) {
        await cache.put(key, response.clone());
        return response;
      }
      return response.status >= 500 ? (await cache.match(key)) || response : response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});
