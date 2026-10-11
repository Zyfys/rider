// Личная карта: все сохранённые адреса и маршруты к ним от хаба.
//
//   node tools/build-private-map.mjs "путь/к/flink-helper-backup-ГГГГ-ММ-ДД.json" [lat,lon хаба]
//
// Результат — один файл private/karta-adresov.html (папка private/ не попадает в git:
// внутри адреса клиентов). Открывается в браузере, работает и на телефоне.
// Маршруты строятся заново через BRouter от хаба — как их строит приложение
// («Быстрый» профиль с правкой из profiles/flink-fastbike.brf).
// Откуда на самом деле начиналась каждая поездка, приложение не записывало.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { buildStyle, THEMES } from '../js/map-style.js';
import { buildIndex, lookup, HUB } from '../js/geocode.js';
import { parseAddress, isNoise } from '../js/address.js';

const [backupPath, hubArg] = process.argv.slice(2);
if (!backupPath) { console.error('Укажи путь к файлу резервной копии'); process.exit(1); }
const hub = hubArg ? { lat: +hubArg.split(',')[0], lon: +hubArg.split(',')[1] } : HUB;

const backup = JSON.parse(readFileSync(backupPath, 'utf8').replace(/^﻿/, ''));
const index = buildIndex(JSON.parse(readFileSync(new URL('../data/addresses-dresden.json', import.meta.url))));

// Адреса: координаты из копии, а где их нет — ищем заново (с теми же исправлениями, что в приложении).
const points = [];
for (const a of backup.addresses) {
  let { street, house, lat, lon } = a;
  let approx = !!a.geoApprox;
  if (!lat) {
    const p = parseAddress(`${street} ${house}`);
    if (p.street && p.house) ({ street, house } = p);
    const r = lookup(index, { street, house, zip: a.zip });
    if (!r) { console.warn('не найден на карте:', street, house); continue; }
    ({ lat, lon } = r);
    approx = r.approx;
  }
  // Смена: всё, что после полуночи до 5 утра, относится к предыдущему дню.
  const shift = new Date(a.createdAt - 5 * 3600000);
  points.push({
    label: `${street} ${house}`, zip: a.zip, lat, lon, approx,
    ts: a.createdAt,
    shift: shift.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
    note: [a.intercom && `код ${a.intercom}`, a.floor && `этаж ${a.floor}`, a.entrance, !isNoise(a.comment, a.city) && a.comment].filter(Boolean).join(' · '),
  });
}
points.sort((a, b) => a.ts - b.ts);

// Маршруты от хаба. Уже построенные храним рядом, чтобы при повторном запуске не дёргать сервер.
mkdirSync(new URL('../private/', import.meta.url), { recursive: true });
const cacheFile = new URL('../private/routes-cache.json', import.meta.url);
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let built = 0;

// Тот же профиль, что использует приложение: стандартный «Быстрый» с правкой про use_sidepath.
// Сервер хранит загруженный профиль недолго, поэтому загружаем его при каждом запуске.
const PROFILE_TAG = 'flink-fastbike-1';
const profileText = readFileSync(new URL('../profiles/flink-fastbike.brf', import.meta.url), 'utf8');
async function uploadProfile() {
  const res = await fetch('https://brouter.de/brouter/profile', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: profileText });
  if (!res.ok) throw new Error(`не удалось загрузить профиль: ${res.status}`);
  return (await res.json()).profileid;
}
let profileId = null;
for (const [i, p] of points.entries()) {
  const lonlats = `${hub.lon.toFixed(5)},${hub.lat.toFixed(5)}|${p.lon.toFixed(5)},${p.lat.toFixed(5)}`;
  const key = `${PROFILE_TAG}|${lonlats}`;
  if (!cache[key]) {
    try {
      // Бесплатный сервер ограничивает частоту запросов: при отказе ждём и пробуем снова.
      let res;
      for (let attempt = 0; attempt < 6; attempt++) {
        profileId ||= await uploadProfile();
        const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${profileId}&alternativeidx=0&format=geojson`;
        res = await fetch(url, { headers: { 'User-Agent': 'flink-helper-dresden/1.9 (personal map)' }, signal: AbortSignal.timeout(30000) });
        if (res.status === 500 && attempt < 2) { await res.text(); profileId = null; continue; } // профиль на сервере устарел
        if (res.status !== 403 && res.status !== 429) break;
        await res.text();
        process.stdout.write(`\rмаршруты: ${i}/${points.length} — сервер просит подождать, пауза ${15 * (attempt + 1)} с `);
        await sleep(15000 * (attempt + 1));
      }
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 80)}`);
      const f = (await res.json()).features[0];
      cache[key] = {
        length: +f.properties['track-length'], time: +f.properties['total-time'],
        line: f.geometry.coordinates.map((c) => [+c[0].toFixed(5), +c[1].toFixed(5)]),
      };
      built++;
      writeFileSync(cacheFile, JSON.stringify(cache));
      await sleep(1500); // бережно к бесплатному серверу
    } catch (e) {
      console.warn(`маршрут не построился: ${p.label} — ${e.message}`);
    }
  }
  if (cache[key]) Object.assign(p, cache[key]);
  process.stdout.write(`\rмаршруты: ${i + 1}/${points.length}`);
}
console.log(`\nпостроено заново: ${built}, из кэша: ${points.filter((p) => p.line).length - built}`);

const withRoute = points.filter((p) => p.line);
const totalKm = withRoute.reduce((s, p) => s + p.length, 0) / 1000;
const data = {
  hub, points,
  made: new Date().toLocaleDateString('ru-RU'),
  summary: { count: points.length, routes: withRoute.length, totalKm, avgKm: totalKm / (withRoute.length || 1) },
};
const C = THEMES.dark;
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Мои адреса и маршруты</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css">
<style>
  html, body { margin: 0; height: 100%; background: ${C.bg}; color: #eef0f3; font: 15px/1.4 system-ui, 'Segoe UI', Roboto, sans-serif; }
  #map { position: absolute; inset: 0; }
  .panel { position: absolute; top: 10px; left: 10px; z-index: 2; max-width: min(360px, calc(100% - 20px)); padding: 12px 14px; border: 1px solid #2f343c; border-radius: 14px; background: rgba(24, 27, 32, .94); box-shadow: 0 4px 16px rgba(0, 0, 0, .4); }
  .panel h1 { margin: 0 0 2px; font-size: 18px; }
  .panel p { margin: 4px 0; color: #9aa3ad; font-size: 13px; }
  .big { display: flex; gap: 16px; margin: 8px 0; }
  .big div { display: flex; flex-direction: column; }
  .big b { font-size: 24px; line-height: 1.1; }
  .big span { font-size: 12px; color: #9aa3ad; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chips button { min-height: 36px; padding: 0 12px; border: 1px solid #2f343c; border-radius: 999px; background: #22262d; color: #eef0f3; font: inherit; font-weight: 600; cursor: pointer; }
  .chips button.on { background: ${C.route}; border-color: ${C.route}; color: #04141d; }
  .sel { margin-top: 10px; padding-top: 8px; border-top: 1px solid #2f343c; }
  .sel b { font-size: 17px; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 12px; color: #9aa3ad; }
  .legend i { display: inline-block; width: 18px; height: 4px; margin-right: 5px; border-radius: 2px; vertical-align: middle; }
  .legend i.dot { width: 10px; height: 10px; border-radius: 50%; }
  .maplibregl-ctrl-attrib { font-size: 11px; }
  details { margin-top: 8px; font-size: 13px; color: #9aa3ad; }
  summary { cursor: pointer; min-height: 28px; }
</style>
</head>
<body>
<div id="map"></div>
<div class="panel">
  <h1>Мои адреса и маршруты</h1>
  <div class="big">
    <div><b id="n"></b><span>адресов</span></div>
    <div><b id="km"></b><span>км от хаба в одну сторону</span></div>
    <div><b id="avg"></b><span>км в среднем</span></div>
  </div>
  <div class="chips" id="chips"></div>
  <div class="legend">
    <span><i style="background:${C.route}"></i>маршрут от хаба (ярче — чаще)</span>
    <span><i class="dot" style="background:#fff"></i>адрес</span>
    <span><i style="background:${C.approx}"></i>выбранный маршрут</span>
    <span><i class="dot" style="background:${C.cycle}"></i>хаб</span>
  </div>
  <div class="sel" id="sel" hidden></div>
  <details><summary>О карте</summary><p id="foot"></p></details>
</div>
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script>
const DATA = ${json(data)};
const STYLE = ${json(buildStyle('dark'))};
const fmt = (v) => v.toFixed(1).replace('.', ',');
const fc = (features) => ({ type: 'FeatureCollection', features });
const map = new maplibregl.Map({ container: 'map', style: STYLE, center: [DATA.hub.lon, DATA.hub.lat], zoom: 12.6, dragRotate: false, attributionControl: { compact: true } });
map.touchZoomRotate.disableRotation();

const shifts = [...new Set(DATA.points.map((p) => p.shift))];
let shift = null;      // null — все смены
let selected = null;   // индекс выбранного адреса

const visible = () => DATA.points.map((p, i) => ({ p, i })).filter(({ p }) => !shift || p.shift === shift);
const routeFeatures = (list) => list.filter(({ p }) => p.line).map(({ p, i }) => ({ type: 'Feature', properties: { i }, geometry: { type: 'LineString', coordinates: p.line } }));
const pointFeatures = (list) => list.map(({ p, i }) => ({ type: 'Feature', properties: { i, approx: p.approx }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }));

function paint() {
  const list = visible();
  map.getSource('routes').setData(fc(routeFeatures(list)));
  map.getSource('points').setData(fc(pointFeatures(list)));
  const sel = selected != null && list.find(({ i }) => i === selected);
  map.getSource('selected').setData(fc(sel ? routeFeatures([sel]) : []));
  map.getSource('selected-point').setData(fc(sel ? pointFeatures([sel]) : []));
  const withRoute = list.filter(({ p }) => p.line);
  const km = withRoute.reduce((s, { p }) => s + p.length, 0) / 1000;
  document.getElementById('n').textContent = list.length;
  document.getElementById('km').textContent = fmt(km);
  document.getElementById('avg').textContent = fmt(km / (withRoute.length || 1));
  for (const b of document.querySelectorAll('#chips button')) b.classList.toggle('on', (b.dataset.shift || null) === shift);
  const box = document.getElementById('sel');
  box.hidden = !sel;
  if (sel) {
    const p = sel.p;
    box.replaceChildren();
    const title = document.createElement('b'); title.textContent = p.label; box.append(title);
    const lines = [
      [p.zip, p.line ? fmt(p.length / 1000) + ' км от хаба · ~' + Math.max(1, Math.round(p.time / 60)) + ' мин' : 'маршрут не построился'].filter(Boolean).join(' · '),
      'добавлен ' + new Date(p.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + (p.approx ? ' · точка примерная' : ''),
      p.note,
    ].filter(Boolean);
    for (const t of lines) { const d = document.createElement('p'); d.textContent = t; box.append(d); }
  }
}

map.on('load', () => {
  const empty = fc([]);
  for (const id of ['routes', 'selected', 'points', 'selected-point']) map.addSource(id, { type: 'geojson', data: empty });
  map.addSource('hub', { type: 'geojson', data: fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [DATA.hub.lon, DATA.hub.lat] } }]) });
  // Полупрозрачные линии: где маршруты накладываются, улица светится ярче — видно, где ездишь чаще всего.
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '${C.route}', 'line-opacity': 0.28, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 5] } }, 'street-name');
  map.addLayer({ id: 'selected-casing', type: 'line', source: 'selected', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#04141d', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 7, 16, 12] } }, 'street-name');
  map.addLayer({ id: 'selected', type: 'line', source: 'selected', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '${C.approx}', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 7] } }, 'street-name');
  map.addLayer({ id: 'points', type: 'circle', source: 'points',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 8], 'circle-color': '#ffffff', 'circle-stroke-color': '#04141d', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'selected-point', type: 'circle', source: 'selected-point',
    paint: { 'circle-radius': 11, 'circle-color': '${C.approx}', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
  map.addLayer({ id: 'hub', type: 'circle', source: 'hub', paint: { 'circle-radius': 10, 'circle-color': '${C.cycle}', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });

  const chips = document.getElementById('chips');
  const add = (label, value) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (value) b.dataset.shift = value;
    b.onclick = () => { shift = value; selected = null; paint(); };
    chips.append(b);
  };
  add('Все', null);
  for (const s of shifts) add(s, s);

  map.on('click', 'points', (e) => { selected = e.features[0].properties.i; paint(); });
  map.on('click', (e) => { if (!map.queryRenderedFeatures(e.point, { layers: ['points'] }).length) { selected = null; paint(); } });
  map.on('mouseenter', 'points', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'points', () => { map.getCanvas().style.cursor = ''; });

  const lons = DATA.points.map((p) => p.lon).concat(DATA.hub.lon);
  const lats = DATA.points.map((p) => p.lat).concat(DATA.hub.lat);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: innerWidth > 800 ? { top: 40, bottom: 40, left: 400, right: 40 } : { top: document.querySelector('.panel').offsetHeight + 30, bottom: 50, left: 30, right: 30 }, duration: 0 });
  document.getElementById('foot').textContent = 'Нажми на точку — покажу адрес и маршрут к нему. Кнопки с датами показывают одну смену. Маршруты построены ' + DATA.made + ' от хаба (BRouter, «Быстрый»); откуда ты ехал на самом деле, приложение не записывало. Файл личный: в нём адреса клиентов.';
  paint();
});
</script>
</body>
</html>
`;

const out = new URL('../private/karta-adresov.html', import.meta.url);
writeFileSync(out, html);
console.log(`адресов: ${points.length}, маршрутов: ${withRoute.length}, всего ${totalKm.toFixed(1)} км в одну сторону`);
console.log('готово:', decodeURIComponent(out.pathname.replace(/^\//, '')));
