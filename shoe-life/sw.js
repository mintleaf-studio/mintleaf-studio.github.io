/* Shoe Life service worker — cache local assets only. No third-party fetches. */
const CACHE = 'shoe-life-v0.2';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './privacy.html',
  './icons/icon.svg',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
          return caches.delete(k);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Only same-origin; never reach third parties
  if (url.origin !== self.location.origin) {
    event.respondWith(Response.error());
    return;
  }
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (cache) {
          cache.put(req, copy);
        });
        return res;
      }).catch(function () {
        if (req.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return Response.error();
      });
    })
  );
});
