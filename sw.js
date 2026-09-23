// Service worker: офлайн-работа приложения и кэш просмотренных кусочков карты.
//
// Файлы приложения — «сначала сеть»: при интернете всегда свежая версия,
// без интернета — сохранённая копия. Версию CACHE менять при изменении списка FILES.
const CACHE = 'flink-helper-v6';
const TILES = 'flink-helper-tiles';
const MAX_TILES = 4000;
const NETWORK_TIMEOUT = 3000;

const FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/address.js',
  './js/data.js',
  './js/geocode.js',
  './js/map.js',
  './js/map-style.js',
  './js/guidance.js',
  './js/arrows.js',
  './vendor/maplibre-gl.mjs',
  './vendor/maplibre-gl-shared.mjs',
  './vendor/maplibre-gl-worker.mjs',
  './vendor/maplibre-gl.css',
  './data/addresses-dresden.json',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else if (url.hostname === 'tiles.openfreemap.org') {
    // Тайлы и шрифты с версией в адресе не меняются — сначала кэш.
    // Описание источника (/planet) меняется при обновлении карты — сначала сеть.
    event.respondWith(url.pathname === '/planet' ? networkFirst(req, TILES) : cacheFirst(req));
  }
  // Остальное (маршруты BRouter) — напрямую в сеть, не кэшируем.
});

async function networkFirst(req, cacheName = CACHE) {
  const cache = await caches.open(cacheName);
  // no-cache: не брать файл из HTTP-кэша браузера, а сверить с сервером (быстро, по ETag).
  const net = fetch(req, { cache: 'no-cache' }).then((res) => {

    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  // Сеть медленная — отдаём кэш; кэша нет — продолжаем ждать сеть.
  const fast = await Promise.race([net.catch(() => null), new Promise((r) => setTimeout(r, NETWORK_TIMEOUT, null))]);
  if (fast) return fast;
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    return await net;
  } catch {
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    if (Math.random() < 0.02) trim(cache);
  }
  return res;
}

// Не даём кэшу карты расти бесконечно: удаляем самые старые записи.
async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(k);
}
