// Карта (MapLibre) + GPS + маршрут по велопрофилю BRouter.
// Сознательно без пошаговых команд и автоперестроения: линия маршрута + своя точка.
import { buildStyle, addOverlayLayers, applyTheme } from './map-style.js';
import { HUB } from './geocode.js';
import { buildGuide, step, upcoming, distance } from './guidance.js';

export const PROFILES = [
  { id: 'fastbike', label: 'Быстрый' },
  { id: 'trekking', label: 'Спокойный' },
];

// Состояние, которое показывает интерфейс.
export const nav = {
  me: null,           // { lat, lon, acc }
  gps: 'waiting',     // waiting | ok | denied | unavailable
  follow: true,
  inPedZone: false,
  dest: null,         // { lat, lon, approx }
  route: null,        // { length, time, fromHub }
  routeState: 'idle', // idle | loading | ok | offline | error
  picking: false,
  next: null,         // следующий манёвр для панели со стрелкой (см. upcoming в guidance.js)
  speed: null,        // км/ч
  progress: null,     // { done, total } — метры по маршруту, для полосы прогресса
};

// Скорость: из GPS, а если телефон её не даёт — по двум последним точкам. Сглаживаем, чтобы цифра не прыгала.
let lastFix = null;
function updateSpeed(p) {
  let ms = p.coords.speed;
  if (ms == null || Number.isNaN(ms) || ms < 0) {
    ms = null;
    if (lastFix) {
      const dt = (p.timestamp - lastFix.t) / 1000;
      if (dt > 0.5 && dt < 15) ms = distance([lastFix.lon, lastFix.lat], [p.coords.longitude, p.coords.latitude]) / dt;
    }
  }
  lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, t: p.timestamp };
  if (ms == null) return;
  const kmh = Math.min(ms * 3.6, 80);
  nav.speed = nav.speed == null ? kmh : nav.speed * 0.5 + kmh * 0.5;
  if (nav.speed < 1.5) nav.speed = 0;
}

let map = null;
let el = null;
let loaded = null;
let routeToken = 0;
let routeCoords = [];
let listener = () => {};
let theme = 'dark';
let guide = null;
const FOLLOW_ZOOM = 16.5;
let followZoom = null;
// События для голоса: { say: [фразы] } | { routeReady: {length, time} } | { offRoute: true }
let guideListener = () => {};
export const onGuide = (fn) => { guideListener = fn; };

export let cancelPick = () => {};

export const onChange = (fn) => { listener = fn; };
const emit = () => listener(nav);

const fc = (features) => ({ type: 'FeatureCollection', features });
const point = (lon, lat, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });

// Карта создаётся один раз и переносится между перерисовками экрана.
export async function getMapElement() {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'map';
  const ml = await import('../vendor/maplibre-gl.mjs');
  map = new ml.Map({
    container: el,
    style: buildStyle(theme),
    center: [HUB.lon, HUB.lat],
    zoom: 14.5,
    maxZoom: 19,
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  // Ждём только стиль, а не событие load (оно наступает, когда загружены все кусочки карты):
  // при медленном интернете маршрут и своя точка должны появляться сразу, карта догрузится под ними.
  loaded = new Promise((resolve) => map.once('style.load', () => {
    addOverlayLayers(map, theme);
    resolve();
  }));
  // Подпись авторов карты по умолчанию раскрыта и закрывает низ экрана — сворачиваем в значок «i».
  // Она раскрывается, когда приходят данные источника, поэтому сворачиваем после полной загрузки.
  map.once('load', () => el.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  // Пользователь сам изменил масштаб — больше не тянем карту к масштабу «следования».
  map.on('zoomstart', (e) => { if (e.originalEvent) followZoom = null; });

  map.on('dragstart', () => { if (nav.follow) { nav.follow = false; emit(); } });
  startGps();
  return el;
}

export async function setTheme(t) {
  theme = t;
  if (!map) return;
  await loaded;
  applyTheme(map, t);
}

export function resize() {
  map?.resize();
}

// ---------- GPS ----------

function startGps() {
  if (!('geolocation' in navigator)) { nav.gps = 'unavailable'; emit(); return; }
  navigator.geolocation.watchPosition(async (p) => {
    const first = !nav.me;
    nav.me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    updateSpeed(p);
    nav.gps = 'ok';
    await loaded;
    map.getSource('me').setData(fc([point(nav.me.lon, nav.me.lat)]));
    if (first) followZoom = Math.max(map.getZoom(), FOLLOW_ZOOM);
    // followZoom — куда приближаемся после нажатия ◎. Без него новое положение GPS прерывало бы
    // анимацию приближения, и карта оставалась бы отдалённой.
    if (nav.follow && !nav.picking) map.easeTo({ center: [nav.me.lon, nav.me.lat], zoom: followZoom ?? map.getZoom(), duration: first ? 0 : 600 });
    checkPedZone();
    if (guide && !nav.picking) {
      const r = step(guide, [nav.me.lon, nav.me.lat], nav.speed == null ? null : nav.speed / 3.6);
      nav.next = r.next;
      if (r.s != null) nav.progress = { done: r.s, total: guide.total };
      if (r.say.length) guideListener({ say: r.say });
      if (r.offRoute) guideListener({ offRoute: true });
    }
    emit();
  }, (err) => {
    nav.gps = err.code === 1 ? 'denied' : 'unavailable';
    emit();
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}

// Стою ли я в пешеходной зоне — проверяем по отрисованному слою под своей точкой.
function checkPedZone() {
  if (!nav.me || !map.getLayer('ped-area')) return;
  const px = map.project([nav.me.lon, nav.me.lat]);
  nav.inPedZone = map.queryRenderedFeatures([[px.x - 2, px.y - 2], [px.x + 2, px.y + 2]], { layers: ['ped-area'] }).length > 0;
}

function waitForFix(ms) {
  if (nav.me || nav.gps === 'denied' || nav.gps === 'unavailable') return Promise.resolve(nav.me);
  return new Promise((resolve) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (nav.me || nav.gps !== 'waiting' || Date.now() - started > ms) { clearInterval(t); resolve(nav.me); }
    }, 250);
  });
}

// ---------- Свой профиль BRouter ----------

// Стандартные велопрофили BRouter считают участок с bicycle=use_sidepath закрытым и, если велодорожка
// рядом не нанесена на карту, ведут в объезд. В profiles/flink-*.brf это правило исправлено.
// Профиль загружается на сервер BRouter (в нём нет личных данных), сервер возвращает его временный id.
const PROFILE_VERSION = 1; // увеличить при изменении profiles/*.brf
const PROFILE_TTL = 12 * 3600 * 1000;

async function customProfileId(profile, force = false) {
  const key = `brouterProfile:${profile}`;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch { /* нет сохранённого */ }
  if (!force && saved?.v === PROFILE_VERSION && Date.now() - saved.ts < PROFILE_TTL) return saved.id;
  const text = await (await fetch(`./profiles/flink-${profile}.brf`)).text();
  const res = await fetch('https://brouter.de/brouter/profile', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text, signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`profile upload ${res.status}`);
  const { profileid } = await res.json();
  if (!profileid) throw new Error('profile upload: no id');
  try { localStorage.setItem(key, JSON.stringify({ id: profileid, v: PROFILE_VERSION, ts: Date.now() })); } catch { /* не критично */ }
  return profileid;
}

async function fetchRoute(start, dest, profile) {
  const url = (p) => `https://brouter.de/brouter?lonlats=${start.lon.toFixed(6)},${start.lat.toFixed(6)}|${dest.lon.toFixed(6)},${dest.lat.toFixed(6)}&profile=${p}&alternativeidx=0&format=geojson&timode=2`;
  // 1) свой профиль; 2) сервер его уже забыл — загружаем заново; 3) не вышло — стандартный, лишь бы маршрут был.
  for (const force of [false, true]) {
    try {
      const res = await fetch(url(await customProfileId(profile, force)), { signal: AbortSignal.timeout(15000) });
      if (res.ok) return await res.json();
    } catch { /* пробуем следующий вариант */ }
    if (navigator.onLine === false) break;
  }
  const res = await fetch(url(profile), { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ---------- Маршрут ----------

export async function routeTo(dest, profile) {
  const token = ++routeToken;
  nav.dest = dest;
  nav.route = null;
  nav.routeState = 'loading';
  emit();
  await loaded;
  map.getSource('dest').setData(fc([point(dest.lon, dest.lat, { approx: !!dest.approx })]));
  map.getSource('route').setData(fc([]));
  routeCoords = [];
  guide = null;
  nav.next = null;
  nav.progress = null;

  const start = (await waitForFix(6000)) || HUB;
  if (token !== routeToken) return;
  try {
    const gj = await fetchRoute(start, dest, profile);
    if (token !== routeToken) return;
    const props = gj.features[0].properties;
    nav.route = { length: +props['track-length'], time: +props['total-time'], fromHub: start === HUB };
    nav.routeState = 'ok';
    routeCoords = gj.features[0].geometry.coordinates.map((c) => [c[0], c[1]]);
    map.getSource('route').setData(gj);
    guide = buildGuide(routeCoords, props.voicehints || []);
    nav.next = upcoming(guide, 0);
    nav.progress = { done: 0, total: guide.total };
    guideListener({ routeReady: nav.route });
    fitRoute();
  } catch {
    if (token !== routeToken) return;
    nav.routeState = navigator.onLine === false ? 'offline' : 'error';
    map.easeTo({ center: [dest.lon, dest.lat], zoom: 17 });
  }
  emit();
}

export async function clearRoute() {
  routeToken++;
  nav.dest = null;
  nav.route = null;
  nav.routeState = 'idle';
  await loaded;
  map.getSource('dest').setData(fc([]));
  map.getSource('route').setData(fc([]));
  routeCoords = [];
  guide = null;
  nav.next = null;
  nav.progress = null;
  emit();
}

export function fitRoute() {
  if (!map || !nav.dest) return;
  const coords = [[nav.dest.lon, nav.dest.lat], ...routeCoords];
  if (nav.me) coords.push([nav.me.lon, nav.me.lat]);
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  nav.follow = false;
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: { top: 170, bottom: 110, left: 40, right: 80 }, maxZoom: 17.5, duration: 500 });
  emit();
}

export function followMe() {
  nav.follow = true;
  if (map) followZoom = Math.max(map.getZoom(), FOLLOW_ZOOM);
  if (nav.me) map?.easeTo({ center: [nav.me.lon, nav.me.lat], zoom: followZoom, duration: 400 });
  emit();
}

// Режим «поставить точку входа»: следующее нажатие на карту возвращает координаты.
export function pickPoint() {
  nav.picking = true;
  nav.follow = false;
  emit();
  return new Promise((resolve) => {
    const onClick = (e) => { finish({ lat: e.lngLat.lat, lon: e.lngLat.lng }); };
    const finish = (value) => {
      map.off('click', onClick);
      nav.picking = false;
      cancelPick = () => {};
      emit();
      resolve(value);
    };
    cancelPick = () => finish(null);
    map.on('click', onClick);
    if (nav.dest) map.easeTo({ center: [nav.dest.lon, nav.dest.lat], zoom: Math.max(map.getZoom(), 18), duration: 400 });
  });
}
