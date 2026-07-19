// Crash Bet service worker — network-first, cache fallback (offline PWA)
const CACHE = 'crash-bet-v4'; // v4: freecam + procedural skybox
const ASSETS = [
  '.', 'index.html', 'css/style.css', 'icon.svg', 'manifest.webmanifest',
  'js/main.js', 'js/lib.js', 'js/parts.js', 'js/families.js', 'js/vehicles.js', 'js/names.js',
  'js/physics.js', 'js/deform.js', 'js/editor.js', 'js/props.js', 'js/env.js',
  'js/scenery.js', 'js/roads.js', 'js/worldgen.js',
  'libs/three.module.js', 'libs/OrbitControls.js', 'libs/RoomEnvironment.js',
  'libs/GLTFExporter.js', 'libs/TextureUtils.js', 'libs/rapier3d-compat.module.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
