// Личная карта: все сохранённые адреса и маршруты к ним от хаба.
//
//   node tools/build-private-map.mjs копия1.json [копия2.json …] [lat,lon хаба] [--cached]
//
// Можно передать несколько резервных копий — адреса объединяются (одинаковые id считаются один раз).
//
// Результат — один файл private/karta-adresov.html (папка private/ не попадает в git:
// внутри адреса клиентов). Открывается в браузере, работает и на телефоне.
// Маршруты строятся заново через BRouter от хаба — как их строит приложение
// (профиль по умолчанию «Без горок», profiles/flink-easy.brf).
// Откуда на самом деле начиналась каждая поездка, приложение не записывало.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { buildStyle, THEMES } from '../js/map-style.js';
import { buildIndex, lookup, HUB } from '../js/geocode.js';
import { parseAddress, isNoise, norm } from '../js/address.js';
import { DISTRICTS } from '../js/stats.js';
import { clusterPoints, buildNameIndex, describeRoute } from './frequent-routes.mjs';

// --cached — не обращаться к серверу, взять только уже построенные маршруты (когда BRouter просит подождать).
const onlyCached = process.argv.includes('--cached');
const args = process.argv.slice(2).filter((a) => a !== '--cached');
const hubArg = args.find((a) => /^\d+\.\d+,\d+\.\d+$/.test(a));
const backupPaths = args.filter((a) => a !== hubArg);
if (!backupPaths.length) { console.error('Укажи путь к файлу резервной копии'); process.exit(1); }
const hub = hubArg ? { lat: +hubArg.split(',')[0], lon: +hubArg.split(',')[1] } : HUB;

const seen = new Set();
const backup = { addresses: backupPaths
  .flatMap((f) => JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')).addresses)
  .filter((a) => !seen.has(a.id) && seen.add(a.id)) };
const addressData = JSON.parse(readFileSync(new URL('../data/addresses-dresden.json', import.meta.url)));
const index = buildIndex(addressData);

// Адреса: координаты из копии, а где их нет — ищем заново (с теми же исправлениями, что в приложении).
const points = [];
for (const a of backup.addresses) {
  let { street, house, lat, lon } = a;
  let approx = !!a.geoApprox;
  // Старые версии могли неверно разобрать адрес (квартира в названии улицы) — разбираем заново.
  if (!lat || /\d/.test(street)) {
    const p = parseAddress(`${street} ${house}`);
    if (p.street && p.house) ({ street, house } = p);
  }
  if (!lat) {
    const r = lookup(index, { street, house, zip: a.zip });
    if (!r) { console.warn('не найден на карте:', street, house); continue; }
    ({ lat, lon } = r);
    approx = r.approx;
  }
  // Смена: всё, что после полуночи до 5 утра, относится к предыдущему дню.
  const shift = new Date(a.createdAt - 5 * 3600000);
  points.push({
    label: `${street} ${house}`, street, house, zip: a.zip, lat, lon, approx,
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

// Тот же профиль, что использует приложение по умолчанию: «Без горок» со всеми правками.
// Сервер хранит загруженный профиль недолго, поэтому загружаем его при каждом запуске.
// При изменении profiles/flink-easy.brf увеличить число в PROFILE_TAG — иначе возьмутся старые маршруты из кэша.
const PROFILE_TAG = 'flink-easy-2';
const profileText = readFileSync(new URL('../profiles/flink-easy.brf', import.meta.url), 'utf8');
async function uploadProfile() {
  const res = await fetch('https://brouter.de/brouter/profile', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: profileText, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`не удалось загрузить профиль: ${res.status}`);
  return (await res.json()).profileid;
}
let profileId = null;

// Маршрут from → to: из кэша или с сервера. Возвращает { length, time, line } или null.
async function getRoute(from, to, what) {
  const lonlats = `${from.lon.toFixed(5)},${from.lat.toFixed(5)}|${to.lon.toFixed(5)},${to.lat.toFixed(5)}`;
  const key = `${PROFILE_TAG}|${lonlats}`;
  if (!cache[key] && !onlyCached) {
    try {
      // Бесплатный сервер ограничивает частоту запросов: при отказе ждём и пробуем снова.
      let res;
      for (let attempt = 0; attempt < 6; attempt++) {
        profileId ||= await uploadProfile();
        const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${profileId}&alternativeidx=0&format=geojson`;
        res = await fetch(url, { headers: { 'User-Agent': 'flink-helper-dresden/1.13 (personal map)' }, signal: AbortSignal.timeout(30000) });
        if (res.status === 500 && attempt < 2) { await res.text(); profileId = null; continue; } // профиль на сервере устарел
        if (res.status !== 403 && res.status !== 429) break;
        await res.text();
        process.stdout.write(`\r${what} — сервер просит подождать, пауза ${15 * (attempt + 1)} с `);
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
      console.warn(`\nмаршрут не построился: ${what} — ${e.message}`);
    }
  }
  return cache[key] || null;
}

for (const [i, p] of points.entries()) {
  const r = await getRoute(hub, p, `маршруты: ${i}/${points.length}`);
  if (r) Object.assign(p, r);
  process.stdout.write(`\rмаршруты: ${i + 1}/${points.length}`);
}
console.log(`\nпостроено заново: ${built}, из кэша: ${points.filter((p) => p.line).length - built}`);

const withRoute = points.filter((p) => p.line);
const totalKm = withRoute.reduce((s, p) => s + p.length, 0) / 1000;

// ---------- Статистика для панели ----------

const M_LAT = 111195;
const M_LON = M_LAT * Math.cos(51.05 * Math.PI / 180);
const meters = (a, b) => Math.hypot((a[0] - b[0]) * M_LON, (a[1] - b[1]) * M_LAT);

// Популярность участков: сколько маршрутов проходит по каждому отрезку (туда и обратно — один отрезок).
const segKey = (a, b) => { const x = a.join(','), y = b.join(','); return x < y ? `${x};${y}` : `${y};${x}`; };
const segs = new Map();
for (const p of withRoute) {
  const used = new Set();
  for (let i = 1; i < p.line.length; i++) {
    const k = segKey(p.line[i - 1], p.line[i]);
    if (used.has(k)) continue;
    used.add(k);
    const s = segs.get(k);
    if (s) s.n++; else segs.set(k, { a: p.line[i - 1], b: p.line[i], n: 1 });
  }
}
// Для карты: отрезки, сгруппированные по числу маршрутов.
const heatBy = new Map();
for (const s of segs.values()) {
  if (!heatBy.has(s.n)) heatBy.set(s.n, []);
  heatBy.get(s.n).push([s.a, s.b]);
}
const heat = [...heatBy].sort((a, b) => a[0] - b[0]).map(([n, lines]) => ({ n, lines }));

// Название улицы для отрезка — по ближайшему дому из базы адресов OSM (в пределах 45 м).
// Это приближение: на перекрёстках ближайший дом может стоять на поперечной улице, поэтому улица
// засчитывается маршруту, только если он проехал по ней не меньше 80 м.
const CELL = 0.001;
const grid = new Map();
for (const [key, list] of Object.entries(addressData)) {
  const street = key.split('|')[0];
  for (const [, lat, lon] of list) {
    const c = `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
    if (!grid.has(c)) grid.set(c, []);
    grid.get(c).push([lon, lat, street]);
  }
}
function nearestStreet([lon, lat]) {
  const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
  let best = null, bestD = 45;
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
    for (const h of grid.get(`${i},${j}`) || []) {
      const d = meters(h, [lon, lat]);
      if (d < bestD) { bestD = d; best = h[2]; }
    }
  }
  return best;
}
const segStreet = new Map();
for (const [k, s] of segs) segStreet.set(k, nearestStreet([(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]));

const corridors = new Map(); // улица → { routes, m, keys }
for (const p of withRoute) {
  const perStreet = new Map();
  for (let i = 1; i < p.line.length; i++) {
    const k = segKey(p.line[i - 1], p.line[i]);
    const street = segStreet.get(k);
    if (!street) continue;
    const e = perStreet.get(street) || { m: 0, keys: [] };
    e.m += meters(p.line[i - 1], p.line[i]);
    e.keys.push(k);
    perStreet.set(street, e);
  }
  for (const [street, e] of perStreet) {
    if (e.m < 80) continue;
    const c = corridors.get(street) || { routes: 0, m: 0, keys: new Set() };
    c.routes++;
    c.m += e.m;
    for (const k of e.keys) c.keys.add(k);
    corridors.set(street, c);
  }
}
const paths = [...corridors].sort((a, b) => b[1].routes - a[1].routes || b[1].m - a[1].m).slice(0, 20)
  .map(([street, c]) => ({ label: street, count: c.routes, km: Math.round(c.m / 100) / 10, lines: [...c.keys].map((k) => [segs.get(k).a, segs.get(k).b]) }));

// Куда: улицы и районы доставки (по точкам — каждая точка один заказ).
function group(keyFn, labelFn) {
  const g = new Map();
  points.forEach((p, i) => {
    const k = keyFn(p);
    if (!k) return;
    const e = g.get(k) || { label: labelFn(p), count: 0, idx: [] };
    if (labelFn(p).length > e.label.length) e.label = labelFn(p);
    e.count++;
    e.idx.push(i);
    g.set(k, e);
  });
  return [...g.values()].sort((a, b) => b.count - a.count);
}
const streets = group((p) => norm(p.street), (p) => p.street).slice(0, 20);
const districts = group((p) => p.zip || '', (p) => (DISTRICTS[p.zip] ? `${DISTRICTS[p.zip]} (${p.zip})` : p.zip));
const repeats = group((p) => norm(p.street) + '|' + norm(p.house), (p) => p.label).filter((g) => g.count > 1);

// Время: часы, дни недели, смены (часовой пояс Дрездена).
const berlin = (ts, opts) => new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Berlin', ...opts });
const hours = Array(24).fill(0);
const weekdays = Array(7).fill(0); // пн … вс
for (const p of points) {
  hours[+berlin(p.ts, { hour: '2-digit', hour12: false }) % 24]++;
  const wd = new Date(p.ts - 5 * 3600000).toLocaleString('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' });
  weekdays[['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd)]++;
}
const shiftList = [];
for (const p of points) {
  let s = shiftList.find((x) => x.shift === p.shift);
  if (!s) { s = { shift: p.shift, count: 0, km: 0, from: p.ts, to: p.ts }; shiftList.push(s); }
  s.count++;
  s.km += (p.length || 0) / 1000;
  s.from = Math.min(s.from, p.ts);
  s.to = Math.max(s.to, p.ts);
}
for (const s of shiftList) {
  s.time = `${berlin(s.from, { hour: '2-digit', minute: '2-digit' })}–${berlin(s.to, { hour: '2-digit', minute: '2-digit' })}`;
  s.km = Math.round(s.km * 10) / 10;
  delete s.from; delete s.to;
}

// ---------- Шпаргалка: частые направления, путь туда и обратно словами ----------

// Названия улиц — из OSM (Overpass), один раз; хранятся в private/streets-cache.json.
const streetsFile = new URL('../private/streets-cache.json', import.meta.url);
if (!existsSync(streetsFile)) {
  const lons = points.map((p) => p.lon).concat(hub.lon), lats = points.map((p) => p.lat).concat(hub.lat);
  const bbox = [Math.min(...lats) - 0.005, Math.min(...lons) - 0.005, Math.max(...lats) + 0.005, Math.max(...lons) + 0.005].map((v) => v.toFixed(4)).join(',');
  const q = `[out:json][timeout:120];way(${bbox})[highway][name][highway!~"^(motorway|motorway_link|proposed|construction|platform|bus_stop|corridor|elevator)$"];out tags geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'flink-helper-dresden/1.13 (personal map)' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Overpass: ${res.status}`);
  const ways = (await res.json()).elements.filter((e) => e.geometry && e.tags.name)
    .map((e) => ({ name: e.tags.name, coords: e.geometry.map((g) => [+g.lon.toFixed(6), +g.lat.toFixed(6)]) }));
  writeFileSync(streetsFile, JSON.stringify(ways));
}
const nameIndex = buildNameIndex(JSON.parse(readFileSync(streetsFile, 'utf8')));

const LEARN = 12; // сколько направлений в шпаргалке
const learn = [];
for (const c of clusterPoints(points, 400, 3).slice(0, LEARN)) {
  // Образец направления — адрес с маршрутом, ближайший к его центру.
  const withLine = c.idx.filter((i) => points[i].line);
  if (!withLine.length) continue;
  const rep = points[withLine.reduce((b, i) => (meters([points[i].lon, points[i].lat], c.center) < meters([points[b].lon, points[b].lat], c.center) ? i : b))];
  const back = await getRoute(rep, hub, `обратная дорога ${learn.length + 1}/${LEARN}`);
  const names = c.idx.reduce((m, i) => { const s = points[i].street; m[s] = (m[s] || 0) + 1; return m; }, {});
  const topStreets = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
  const zips = c.idx.reduce((m, i) => { const z = points[i].zip; m[z] = (m[z] || 0) + 1; return m; }, {});
  const zip = Object.entries(zips).sort((a, b) => b[1] - a[1])[0][0];
  learn.push({
    title: topStreets.slice(0, 2).join(' · '), streets: [DISTRICTS[zip] || zip, ...topStreets.slice(2)], count: c.idx.length, idx: c.idx,
    to: { km: Math.round(rep.length / 100) / 10, min: Math.max(1, Math.round(rep.time / 60)), steps: describeRoute(nameIndex, rep.line), line: rep.line },
    back: back && { km: Math.round(back.length / 100) / 10, min: Math.max(1, Math.round(back.time / 60)), steps: describeRoute(nameIndex, back.line), line: back.line },
  });
}
process.stdout.write('\n');

// Та же шпаргалка простым текстом — читать с телефона или распечатать.
const stepText = (s, i, from) => `   ${i + 1}. ${s.turn ? s.turn + ' — ' : from + ' — '}${s.name}, ${s.m >= 1000 ? (s.m / 1000).toFixed(1).replace('.', ',') + ' км' : s.m + ' м'}`;
const cheat = [
  'ЧАСТЫЕ МАРШРУТЫ — выучить',
  `Составлено ${new Date().toLocaleDateString('ru-RU')} по ${points.length} заказам. Путь — до адреса в середине направления (BRouter, «Без горок»).`,
  '',
  ...learn.flatMap((d, n) => [
    `${n + 1}. ${d.title} — ${d.count} заказов (${Math.round(d.count / points.length * 100)} %)`,
    `   ${d.streets.join(', ')}`,
    `   ТУДА — ${String(d.to.km).replace('.', ',')} км, ~${d.to.min} мин:`,
    ...d.to.steps.map((s, i) => stepText(s, i, 'от хаба')),
    ...(d.back ? [`   ОБРАТНО В ХАБ — ${String(d.back.km).replace('.', ',')} км, ~${d.back.min} мин:`, ...d.back.steps.map((s, i) => stepText(s, i, 'от адреса'))] : []),
    '',
  ]),
].join('\n');
writeFileSync(new URL('../private/chastye-marshruty.txt', import.meta.url), '\uFEFF' + cheat);

const data = {
  hub, points, heat, paths, streets, districts, repeats, hours, weekdays, shifts: shiftList, learn,
  made: new Date().toLocaleDateString('ru-RU'),
  summary: { count: points.length, routes: withRoute.length, totalKm, shifts: shiftList.length },
};
const C = THEMES.dark;
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// Последовательная шкала одного оттенка: редко — тёмно-синий у фона, часто — почти белый.
const HEAT = ['#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'];

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Мои адреса и маршруты</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css">
<style>
  :root { --surface: rgba(24, 27, 32, .95); --line: #2f343c; --text: #eef0f3; --muted: #9aa3ad; --bar: #3987e5; --track: #22262d; --hl: ${C.approx}; }
  html, body { margin: 0; height: 100%; background: ${C.bg}; color: var(--text); font: 15px/1.4 system-ui, 'Segoe UI', Roboto, sans-serif; }
  #map { position: absolute; inset: 0; }
  .panel { position: absolute; top: 10px; left: 10px; z-index: 2; width: min(380px, calc(100% - 20px)); max-height: calc(100% - 20px); display: flex; flex-direction: column; box-sizing: border-box; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: 0 4px 16px rgba(0, 0, 0, .4); }
  .head { flex: none; padding: 12px 14px 0; }
  .panel h1 { margin: 0; font-size: 18px; }
  .tabs { flex: none; display: flex; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--line); overflow-x: auto; }
  .tabs button { flex: none; min-height: 34px; padding: 0 11px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); font: inherit; font-weight: 700; cursor: pointer; }
  .tabs button.on { background: var(--track); color: var(--text); box-shadow: inset 0 0 0 2px var(--bar); }
  .body { flex: 1 1 auto; min-height: 0; padding: 10px 14px 12px; overflow-y: auto; }
  .body p { margin: 4px 0; color: var(--muted); font-size: 13px; }
  .big { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 4px 0 10px; }
  .big div { display: flex; flex-direction: column; }
  .big b { font-size: 22px; line-height: 1.1; }
  .big span { font-size: 12px; color: var(--muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chips button { min-height: 34px; padding: 0 11px; border: 1px solid var(--line); border-radius: 999px; background: var(--track); color: var(--text); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
  .chips button.on { background: ${C.route}; border-color: ${C.route}; color: #04141d; }
  h2 { margin: 12px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .rows { display: flex; flex-direction: column; gap: 2px; }
  .row { position: relative; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; min-height: 34px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
  .row:hover, .row.on { background: var(--track); }
  .row.on { box-shadow: inset 3px 0 0 var(--hl); }
  .row .bar { position: absolute; left: 8px; bottom: 4px; height: 3px; border-radius: 2px; background: var(--bar); }
  .row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .row .val { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .row .val b { color: var(--text); }
  .cols { display: flex; align-items: flex-end; gap: 3px; height: 110px; padding-top: 16px; }
  .col { position: relative; flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
  .col i { display: block; width: 100%; max-width: 22px; border-radius: 4px 4px 0 0; background: var(--bar); }
  .col i.zero { background: var(--track); height: 2px; border-radius: 1px; }
  .col em { position: absolute; top: -16px; font-style: normal; font-size: 11px; color: var(--muted); }
  .labels { display: flex; gap: 3px; margin-top: 4px; }
  .labels span { flex: 1; text-align: center; font-size: 11px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  td, th { padding: 4px 6px; text-align: right; border-bottom: 1px solid var(--line); }
  td:first-child, th:first-child { text-align: left; }
  th { color: var(--muted); font-weight: 600; }
  .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 8px; font-size: 12px; color: var(--muted); }
  .ramp { display: inline-flex; gap: 2px; vertical-align: middle; }
  .ramp i { width: 16px; height: 6px; border-radius: 2px; }
  .legend .dot { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border-radius: 50%; vertical-align: middle; }
  .sel { flex: none; margin: 0 14px 12px; padding: 8px 10px; border-radius: 10px; background: var(--track); font-size: 14px; }
  .sel p { margin: 2px 0; color: var(--muted); font-size: 13px; }
  .seg2 { display: inline-flex; gap: 2px; padding: 2px; border-radius: 10px; background: var(--track); }
  .seg2 button { min-height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font: inherit; font-size: 14px; font-weight: 700; cursor: pointer; }
  .seg2 button.on { background: #2f343c; color: var(--text); }
  .learn { margin: 0 0 6px; border: 1px solid var(--line); border-radius: 10px; }
  .learn.on { border-color: var(--hl); }
  .learn-head { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 10px; background: transparent; color: var(--text); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
  .learn-head:hover { background: var(--track); }
  .learn-head .val { color: var(--muted); white-space: nowrap; }
  .learn-streets { grid-column: 1 / -1; color: var(--muted); font-size: 13px; }
  .learn-sub { margin: 4px 10px 2px; font-size: 13px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
  .steps { margin: 0 0 6px; padding: 0 10px; list-style: none; }
  .steps li { display: grid; grid-template-columns: 22px 1fr auto; gap: 6px; align-items: baseline; padding: 4px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
  .steps li:last-child { border-bottom: 0; }
  .steps .arrow { color: var(--hl); font-weight: 800; text-align: center; }
  .steps .len { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .maplibregl-ctrl-attrib { font-size: 11px; }
  @media (max-width: 600px) { .panel { max-height: 52%; } .big b { font-size: 19px; } }
</style>
</head>
<body>
<div id="map"></div>
<div class="panel">
  <div class="head"><h1>Мои адреса и маршруты</h1></div>
  <div class="tabs" id="tabs"></div>
  <div class="body" id="body"></div>
  <div class="sel" id="sel" hidden></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script>
var DATA = ${json(data)};
var STYLE = ${json(buildStyle('dark'))};
var HEAT = ${json(HEAT)};
var fmt = function (v) { return v.toFixed(1).replace('.', ','); };
var ARROWS = { '': '●', 'прямо': '↑', 'направо': '→', 'налево': '←', 'плавно направо': '↗', 'плавно налево': '↖', 'разворот': '↩' };
var fc = function (features) { return { type: 'FeatureCollection', features: features }; };
var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
var map = new maplibregl.Map({ container: 'map', style: STYLE, center: [DATA.hub.lon, DATA.hub.lat], zoom: 12.6, dragRotate: false, attributionControl: { compact: true } });
map.touchZoomRotate.disableRotation();

var tab = 'overview';
var mode = 'heat';       // heat — популярность путей, routes — все маршруты
var shift = null;        // фильтр по смене
var selected = null;     // выбранный адрес
var highlight = null;    // { kind: 'path'|'points', key, lines?, idx? }

function visible() {
  return DATA.points.map(function (p, i) { return { p: p, i: i }; }).filter(function (x) { return !shift || x.p.shift === shift; });
}
function routeFeatures(list) {
  return list.filter(function (x) { return x.p.line; }).map(function (x) { return { type: 'Feature', properties: { i: x.i }, geometry: { type: 'LineString', coordinates: x.p.line } }; });
}
function pointFeatures(list) {
  return list.map(function (x) { return { type: 'Feature', properties: { i: x.i, approx: x.p.approx }, geometry: { type: 'Point', coordinates: [x.p.lon, x.p.lat] } }; });
}
function heatFeatures() {
  return DATA.heat.map(function (h) { return { type: 'Feature', properties: { n: h.n }, geometry: { type: 'MultiLineString', coordinates: h.lines } }; });
}

function paintMap() {
  var list = visible();
  var showHeat = mode === 'heat' && !shift;
  map.setLayoutProperty('heat', 'visibility', showHeat ? 'visible' : 'none');
  map.setLayoutProperty('routes', 'visibility', showHeat ? 'none' : 'visible');
  map.getSource('routes').setData(fc(routeFeatures(list)));
  map.getSource('points').setData(fc(pointFeatures(list)));
  var hlLines = [], hlPoints = [], hlBack = [];
  if (highlight && highlight.lines) hlLines = [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: highlight.lines } }];
  if (highlight && highlight.back && highlight.back.length) hlBack = [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: highlight.back } }];
  if (highlight && highlight.idx && highlight.keepRoutes) hlPoints = pointFeatures(highlight.idx.map(function (i) { return { p: DATA.points[i], i: i }; }));
  else if (highlight && highlight.idx) {
    var sel = highlight.idx.map(function (i) { return { p: DATA.points[i], i: i }; });
    hlLines = routeFeatures(sel);
    hlPoints = pointFeatures(sel);
  }
  if (selected != null) {
    var one = [{ p: DATA.points[selected], i: selected }];
    hlLines = routeFeatures(one);
    hlPoints = pointFeatures(one);
  }
  map.getSource('hl').setData(fc(hlLines));
  map.getSource('hl-back').setData(fc(hlBack));
  map.getSource('hl-points').setData(fc(hlPoints));
}

function fitTo(coords) {
  if (!coords.length) return;
  var lons = coords.map(function (c) { return c[0]; }), lats = coords.map(function (c) { return c[1]; });
  var small = innerWidth <= 600;
  map.fitBounds([[Math.min.apply(null, lons), Math.min.apply(null, lats)], [Math.max.apply(null, lons), Math.max.apply(null, lats)]],
    { padding: small ? { top: document.querySelector('.panel').offsetHeight + 30, bottom: 40, left: 30, right: 30 } : { top: 40, bottom: 40, left: 420, right: 40 }, maxZoom: 16, duration: 500 });
}

// Строка списка: название, полоска длины по значению, число. Нажатие — подсветка на карте.
function rows(items, max, valueText, onPick, isOn) {
  var box = el('div', 'rows');
  items.forEach(function (it) {
    var r = el('button', 'row' + (isOn(it) ? ' on' : ''));
    r.append(el('span', 'name', it.label));
    var v = el('span', 'val'); v.innerHTML = ''; v.append(valueText(it)); r.append(v);
    var bar = el('i', 'bar'); bar.style.width = 'calc((100% - 16px) * ' + (it.count / max).toFixed(3) + ')'; r.append(bar);
    r.title = it.label + ': ' + it.count;
    r.onclick = function () { onPick(it); };
    box.append(r);
  });
  return box;
}
function val(b, rest) { var f = document.createDocumentFragment(); f.append(el('b', null, String(b))); if (rest) f.append(' ' + rest); return f; }

function columns(values, labels, unit) {
  var wrap = el('div');
  var max = Math.max.apply(null, values) || 1;
  var cols = el('div', 'cols');
  values.forEach(function (v, i) {
    var c = el('div', 'col');
    c.title = labels[i] + ': ' + v + ' ' + unit;
    var bar = el('i', v ? '' : 'zero');
    if (v) { bar.style.height = Math.max(3, (v / max) * 90) + 'px'; c.append(el('em', null, String(v))); }
    c.append(bar);
    cols.append(c);
  });
  var lab = el('div', 'labels');
  labels.forEach(function (l) { lab.append(el('span', null, l)); });
  wrap.append(cols, lab);
  return wrap;
}

function pickPoints(kind, it) {
  if (highlight && highlight.key === kind + it.label) { highlight = null; paintAll(); return; }
  selected = null; shift = null;
  highlight = { key: kind + it.label, idx: it.idx };
  paintAll();
  fitTo(it.idx.map(function (i) { return [DATA.points[i].lon, DATA.points[i].lat]; }).concat([[DATA.hub.lon, DATA.hub.lat]]));
}

var TABS = [
  ['overview', 'Обзор'], ['learn', 'Выучить'], ['paths', 'Пути'], ['streets', 'Куда'], ['districts', 'Районы'], ['time', 'Время'],
];

function renderBody() {
  var body = document.getElementById('body');
  body.replaceChildren();
  var list = visible();
  if (tab === 'overview') {
    var withRoute = list.filter(function (x) { return x.p.line; });
    var km = withRoute.reduce(function (s, x) { return s + x.p.length; }, 0) / 1000;
    var shifts = shift ? 1 : DATA.summary.shifts;
    var big = el('div', 'big');
    [[list.length, 'заказов'], [shifts, shift ? 'смена' : 'смен'], [fmt(list.length / shifts), 'за смену'], [fmt(km / (withRoute.length || 1)), 'км до клиента']].forEach(function (b) {
      var d = el('div'); d.append(el('b', null, String(b[0])), el('span', null, b[1])); big.append(d);
    });
    body.append(big);
    var seg = el('div', 'seg2');
    [['heat', 'Популярность путей'], ['routes', 'Все маршруты']].forEach(function (m) {
      var b = el('button', mode === m[0] && !(shift && m[0] === 'heat') ? 'on' : '', m[1]);
      b.onclick = function () { mode = m[0]; if (m[0] === 'heat') shift = null; paintAll(); };
      seg.append(b);
    });
    body.append(seg);
    var legend = el('div', 'legend');
    if (mode === 'heat' && !shift) {
      var ramp = el('span', 'ramp');
      HEAT.forEach(function (c) { var i = el('i'); i.style.background = c; ramp.append(i); });
      legend.append(el('span', null, 'реже'), ramp, el('span', null, 'чаще — ярче и толще'));
    } else legend.append(el('span', null, 'маршруты от хаба, где накладываются — ярче'));
    var hubDot = el('span'); var d1 = el('i', 'dot'); d1.style.background = '${C.cycle}'; hubDot.append(d1, 'хаб');
    var addrDot = el('span'); var d2 = el('i', 'dot'); d2.style.background = '#fff'; addrDot.append(d2, 'адрес');
    legend.append(hubDot, addrDot);
    body.append(legend);
    body.append(el('h2', null, 'Смена'));
    var chips = el('div', 'chips');
    [[null, 'Все']].concat(DATA.shifts.map(function (s) { return [s.shift, s.shift]; })).forEach(function (c) {
      var b = el('button', shift === c[0] ? 'on' : '', c[1]);
      b.onclick = function () { shift = c[0]; selected = null; highlight = null; if (shift) mode = 'routes'; paintAll(); };
      chips.append(b);
    });
    body.append(chips);
    body.append(el('p', null, 'Нажми на точку — покажу адрес и маршрут. Маршруты построены ' + DATA.made + ' от хаба (BRouter, «Без горок»); откуда ты ехал на самом деле, приложение не записывало. Файл личный: в нём адреса клиентов.'));
  } else if (tab === 'learn') {
    body.append(el('p', null, 'Направления, куда ездишь чаще всего (адреса в пределах ~400 м — одно направление). Путь до типичного адреса и обратно в хаб — по улицам. Нажми — покажу на карте: туда жёлтым, обратно зелёным пунктиром.'));
    DATA.learn.forEach(function (d, n) {
      var key = 'learn' + n;
      var on = highlight && highlight.key === key;
      var card = el('div', 'learn' + (on ? ' on' : ''));
      var head = el('button', 'learn-head');
      head.append(el('b', null, (n + 1) + '. ' + d.title), el('span', 'val', d.count + ' заказов · ' + Math.round(d.count / DATA.points.length * 100) + ' %'));
      head.append(el('span', 'learn-streets', d.streets.join(', ')));
      head.onclick = function () {
        if (on) { highlight = null; paintAll(); return; }
        selected = null; shift = null;
        highlight = { key: key, lines: [d.to.line], back: d.back ? [d.back.line] : [], idx: d.idx, keepRoutes: true };
        paintAll();
        fitTo(d.to.line.concat(d.back ? d.back.line : []));
      };
      card.append(head);
      if (on) {
        [['Туда', d.to], ['Обратно в хаб', d.back]].forEach(function (part) {
          if (!part[1]) return;
          card.append(el('div', 'learn-sub', part[0] + ' · ' + fmt(part[1].km) + ' км · ~' + part[1].min + ' мин'));
          var ol = el('ol', 'steps');
          part[1].steps.forEach(function (s) {
            var li = el('li');
            li.append(el('span', 'arrow', ARROWS[s.turn] || '•'), el('span', 'what', (s.turn ? s.turn + ' — ' : (part[0] === 'Туда' ? 'от хаба — ' : 'от адреса — ')) + s.name), el('span', 'len', s.m >= 1000 ? fmt(s.m / 1000) + ' км' : s.m + ' м'));
            ol.append(li);
          });
          card.append(ol);
        });
      }
      body.append(card);
    });
    body.append(el('p', null, 'Путь — от хаба до адреса в середине направления; к соседним адресам последние улицы отличаются. Названия улиц — из OSM; короткие куски (до 50 м) не показаны.'));
  } else if (tab === 'paths') {
    body.append(el('p', null, 'Улицы, по которым маршруты от хаба проходят чаще всего (засчитано, если по улице не меньше 80 м). Название — по ближайшим домам, на перекрёстках возможны неточности.'));
    body.append(rows(DATA.paths, DATA.paths[0] ? DATA.paths[0].count : 1,
      function (it) { return val(it.count, 'раз · ' + fmt(it.km) + ' км'); },
      function (it) {
        if (highlight && highlight.key === 'path' + it.label) { highlight = null; paintAll(); return; }
        selected = null; shift = null; mode = 'heat';
        highlight = { key: 'path' + it.label, lines: it.lines };
        paintAll();
        fitTo([].concat.apply([], it.lines));
      },
      function (it) { return highlight && highlight.key === 'path' + it.label; }));
  } else if (tab === 'streets') {
    body.append(el('p', null, 'Улицы, куда чаще всего привозил заказы. Нажми — покажу адреса и маршруты.'));
    body.append(rows(DATA.streets, DATA.streets[0].count, function (it) { return val(it.count, 'заказов'); },
      function (it) { pickPoints('street', it); }, function (it) { return highlight && highlight.key === 'street' + it.label; }));
    if (DATA.repeats.length) {
      body.append(el('h2', null, 'Один и тот же дом несколько раз'));
      body.append(rows(DATA.repeats, DATA.repeats[0].count, function (it) { return val(it.count, 'раза'); },
        function (it) { pickPoints('repeat', it); }, function (it) { return highlight && highlight.key === 'repeat' + it.label; }));
      body.append(el('p', null, 'Сюда стоит записать код, этаж и вход — в следующий раз сэкономит время.'));
    }
  } else if (tab === 'districts') {
    body.append(el('p', null, 'Заказы по почтовым индексам. Нажми — покажу адреса района.'));
    var total = DATA.points.length;
    body.append(rows(DATA.districts, DATA.districts[0].count, function (it) { return val(it.count, '· ' + Math.round(it.count / total * 100) + ' %'); },
      function (it) { pickPoints('district', it); }, function (it) { return highlight && highlight.key === 'district' + it.label; }));
  } else if (tab === 'time') {
    // Часы по порядку смены: с 6 утра до 5 утра следующего дня, пустые края обрезаны.
    var order = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5];
    var a = 0, z = order.length - 1;
    while (a < z && !DATA.hours[order[a]]) a++;
    while (z > a && !DATA.hours[order[z]]) z--;
    var hrs = [], hl = [];
    for (var k = a; k <= z; k++) { hrs.push(DATA.hours[order[k]]); hl.push(String(order[k])); }
    body.append(el('h2', null, 'Заказы по часам'), columns(hrs, hl, 'заказов'));
    body.append(el('h2', null, 'По дням недели'), columns(DATA.weekdays, ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'], 'заказов'));
    body.append(el('h2', null, 'Смены'));
    var t = el('table'); var head = el('tr');
    ['Дата', 'Время', 'Заказов', 'км*'].forEach(function (x) { head.append(el('th', null, x)); }); t.append(head);
    DATA.shifts.forEach(function (s) {
      var tr = el('tr'); [s.shift, s.time, s.count, fmt(s.km)].forEach(function (x) { tr.append(el('td', null, String(x))); }); t.append(tr);
    });
    body.append(t, el('p', null, '* километры от хаба до клиентов в одну сторону, по построенным маршрутам; дорога обратно не учтена.'));
  }
}

function renderTabs() {
  var box = document.getElementById('tabs');
  box.replaceChildren();
  TABS.forEach(function (t) {
    var b = el('button', tab === t[0] ? 'on' : '', t[1]);
    b.onclick = function () { tab = t[0]; renderTabs(); renderBody(); document.getElementById('body').scrollTop = 0; };
    box.append(b);
  });
}

function renderSel(info) {
  var box = document.getElementById('sel');
  box.replaceChildren();
  if (info) { box.hidden = false; box.append(info); return; }
  box.hidden = selected == null;
  if (selected == null) return;
  var p = DATA.points[selected];
  box.append(el('b', null, p.label));
  [[p.zip, p.line ? fmt(p.length / 1000) + ' км от хаба · ~' + Math.max(1, Math.round(p.time / 60)) + ' мин' : 'маршрут не построился'].filter(Boolean).join(' · '),
    'заказ ' + new Date(p.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + (p.approx ? ' · точка примерная' : ''),
    p.note].filter(Boolean).forEach(function (t) { box.append(el('p', null, t)); });
}

function paintAll() { renderTabs(); renderBody(); paintMap(); renderSel(); }

map.on('load', function () {
  ['routes', 'points', 'hl', 'hl-back', 'hl-points', 'heat'].forEach(function (id) { map.addSource(id, { type: 'geojson', data: fc([]) }); });
  map.getSource('heat').setData(fc(heatFeatures()));
  map.addSource('hub', { type: 'geojson', data: fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [DATA.hub.lon, DATA.hub.lat] } }]) });
  // Популярность: число маршрутов на отрезке → цвет (одна шкала синего) и толщина.
  map.addLayer({ id: 'heat', type: 'line', source: 'heat', layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'n'] },
    paint: { 'line-color': ['step', ['get', 'n'], HEAT[0], 2, HEAT[1], 5, HEAT[2], 12, HEAT[3], 30, HEAT[4]],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, ['interpolate', ['linear'], ['get', 'n'], 1, 1.2, 40, 5], 16, ['interpolate', ['linear'], ['get', 'n'], 1, 3, 40, 12]] } }, 'street-name');
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '${C.route}', 'line-opacity': 0.28, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 5] } }, 'street-name');
  map.addLayer({ id: 'hl-back', type: 'line', source: 'hl-back', layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': '${C.cycle}', 'line-dasharray': [1.5, 1.2], 'line-offset': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 7], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 5] } }, 'street-name');
  map.addLayer({ id: 'hl-casing', type: 'line', source: 'hl', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#04141d', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 7, 16, 12] } }, 'street-name');
  map.addLayer({ id: 'hl', type: 'line', source: 'hl', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '${C.approx}', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 7] } }, 'street-name');
  map.addLayer({ id: 'points', type: 'circle', source: 'points',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3.5, 16, 8], 'circle-color': '#ffffff', 'circle-stroke-color': '#04141d', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'hl-points', type: 'circle', source: 'hl-points',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 10], 'circle-color': '${C.approx}', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'hub', type: 'circle', source: 'hub', paint: { 'circle-radius': 10, 'circle-color': '${C.cycle}', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });

  map.on('click', function (e) {
    var hit = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ['hl-points', 'points'] });
    if (hit.length) { selected = hit[0].properties.i; paintMap(); renderSel(); return; }
    var seg = map.getLayoutProperty('heat', 'visibility') !== 'none' && map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: ['heat'] });
    if (seg && seg.length) {
      var n = Math.max.apply(null, seg.map(function (f) { return f.properties.n; }));
      selected = null; paintMap();
      var b = el('div'); b.append(el('b', null, 'Здесь проходит ' + n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? 'маршрут' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'маршрута' : 'маршрутов'))), el('p', null, 'из ' + DATA.summary.routes + ' построенных от хаба'));
      renderSel(b);
      return;
    }
    selected = null; paintMap(); renderSel();
  });
  map.on('mouseenter', 'points', function () { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'points', function () { map.getCanvas().style.cursor = ''; });

  fitTo(DATA.points.map(function (p) { return [p.lon, p.lat]; }).concat([[DATA.hub.lon, DATA.hub.lat]]));
  paintAll();
  // Подпись авторов карты по умолчанию раскрыта и закрывает низ экрана — сворачиваем в значок «i».
  var attrib = document.querySelector('.maplibregl-ctrl-attrib');
  if (attrib) attrib.classList.remove('maplibregl-compact-show');
});
</script>
</body>
</html>
`;

const out = new URL('../private/karta-adresov.html', import.meta.url);
writeFileSync(out, html);
console.log(`адресов: ${points.length}, маршрутов: ${withRoute.length}, всего ${totalKm.toFixed(1)} км в одну сторону`);
console.log(`отрезков: ${segs.size}, самый частый — ${Math.max(...[...segs.values()].map((s) => s.n))} маршрутов; популярные улицы: ${paths.slice(0, 5).map((p) => `${p.label} ${p.count}`).join(', ')}`);
console.log('готово:', decodeURIComponent(out.pathname.replace(/^\//, '')));
