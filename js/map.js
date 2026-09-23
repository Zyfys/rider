// Карта (MapLibre) + GPS + маршрут по велопрофилю BRouter.
// Сознательно без пошаговых команд и автоперестроения: линия маршрута + своя точка.
import { buildStyle, addOverlayLayers } from './map-style.js';
import { HUB } from './geocode.js';

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
};

let map = null;
let el = null;
let loaded = null;
let routeToken = 0;
let routeCoords = [];
let listener = () => {};

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
    style: buildStyle(),
    center: [HUB.lon, HUB.lat],
    zoom: 14.5,
    maxZoom: 19,
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  loaded = new Promise((resolve) => map.on('load', () => {
    addOverlayLayers(map);
    // Подпись авторов карты по умолчанию раскрыта и закрывает низ экрана — сворачиваем в значок «i».
    el.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    resolve();
  }));

  map.on('dragstart', () => { if (nav.follow) { nav.follow = false; emit(); } });
  startGps();
  return el;
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
    nav.gps = 'ok';
    await loaded;
    map.getSource('me').setData(fc([point(nav.me.lon, nav.me.lat)]));
    if (nav.follow && !nav.picking) map.easeTo({ center: [nav.me.lon, nav.me.lat], zoom: first ? Math.max(map.getZoom(), 16.5) : map.getZoom(), duration: first ? 0 : 600 });
    checkPedZone();
    emit();
  }, (err) => {
    nav.gps = err.code === 1 ? 'denied' : 'unavailable';
    emit();
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
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

  const start = (await waitForFix(6000)) || HUB;
  if (token !== routeToken) return;
  const url = `https://brouter.de/brouter?lonlats=${start.lon.toFixed(6)},${start.lat.toFixed(6)}|${dest.lon.toFixed(6)},${dest.lat.toFixed(6)}&profile=${profile}&alternativeidx=0&format=geojson`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(await res.text());
    const gj = await res.json();
    if (token !== routeToken) return;
    const props = gj.features[0].properties;
    nav.route = { length: +props['track-length'], time: +props['total-time'], fromHub: start === HUB };
    nav.routeState = 'ok';
    routeCoords = gj.features[0].geometry.coordinates.map((c) => [c[0], c[1]]);
    map.getSource('route').setData(gj);
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
  if (nav.me) map?.easeTo({ center: [nav.me.lon, nav.me.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 400 });
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
