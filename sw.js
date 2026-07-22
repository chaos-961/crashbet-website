// Crash Bet service worker — network-first, cache fallback (offline PWA)
// BUMP THIS whenever any cached asset changes — the old cache is deleted on
// activate, so a version bump is what stops returning PWA users pairing new JS
// with a stale cached index.html. The ASSETS list must name EVERY imported
// module, or offline load fails on whichever one is missing.
const CACHE = 'crash-bet-v8';
const ASSETS = [
  '.', 'index.html', 'css/style.css', 'icon.svg', 'manifest.webmanifest',
  'js/main.js', 'js/lib.js', 'js/parts.js', 'js/families.js', 'js/vehicles.js', 'js/names.js',
  'js/physics.js', 'js/deform.js', 'js/editor.js', 'js/props.js', 'js/env.js',
  'js/scenery.js', 'js/roads.js', 'js/worldgen.js', 'js/fx.js', 'js/director.js', 'js/recorder.js',
  'js/markets.js', 'js/economy.js', 'js/betui.js', 'js/povcam.js', 'js/achievements.js',
  'js/signals.js', 'js/terrain.js', 'js/water.js', 'js/vegetation.js', 'js/weather.js',
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
