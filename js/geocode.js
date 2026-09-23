// Поиск координат адреса по офлайн-базе OSM (data/addresses-dresden.json).
// Всё считается на телефоне — адрес никуда не отправляется.
import { norm } from './address.js';

// Хаб Prager Straße — точка старта, если GPS нет, и ориентир для выбора одноимённых улиц.
export const HUB = { lat: 51.0452, lon: 13.7370 };

// data: { "Улица|Индекс": [["12a", lat, lon], ...] } → Map(normStreet → [{ zip, houses: Map(normHouse → [lat, lon, house]) }])
export function buildIndex(data) {
  const index = new Map();
  for (const [key, list] of Object.entries(data)) {
    const [street, zip] = key.split('|');
    const houses = new Map(list.map(([h, lat, lon]) => [norm(h), [lat, lon, h]]));
    const s = norm(street);
    if (!index.has(s)) index.set(s, []);
    index.get(s).push({ zip, houses });
  }
  return index;
}

const dist2 = (a, b) => (a[0] - b.lat) ** 2 + ((a[1] - b.lon) * 0.63) ** 2;
const houseNum = (h) => parseInt(h, 10);

// Возвращает { lat, lon, approx, note } или null, если улица не найдена.
export function lookup(index, { street, house, zip }) {
  let groups = index.get(norm(street));
  if (!groups) return null;
  if (zip) {
    const byZip = groups.filter((g) => g.zip === zip);
    // Точки без индекса в OSM тоже годятся — добавляем их к группе с нужным индексом.
    if (byZip.length) groups = [...byZip, ...groups.filter((g) => !g.zip)];
  }

  const h = norm(house);
  const candidates = [h, (house.match(/^\d+/) || [''])[0]].filter(Boolean);
  // Точное совпадение (или «12» для «12a», «12» для «12-14»).
  for (const c of candidates) {
    const hits = groups.map((g) => g.houses.get(c)).filter(Boolean);
    if (hits.length) {
      // Одноимённые улицы в разных районах без индекса — берём ближайшую к хабу.
      const best = hits.sort((a, b) => dist2(a, HUB) - dist2(b, HUB))[0];
      return { lat: best[0], lon: best[1], approx: c !== h, note: c !== h ? `дом ${best[2]} (точного ${house} нет в OSM)` : '' };
    }
  }

  // Номера нет в базе — ближайший номер на той же улице, предпочитая ту же чётность (та же сторона).
  const n = houseNum(house);
  let best = null;
  for (const g of groups) {
    for (const [lat, lon, hh] of g.houses.values()) {
      const m = houseNum(hh);
      if (Number.isNaN(m)) continue;
      const score = Number.isNaN(n) ? 0 : Math.abs(m - n) + ((m - n) % 2 ? 0.5 : 0);
      if (!best || score < best.score) best = { score, lat, lon, hh };
    }
  }
  if (!best) return null;
  return { lat: best.lat, lon: best.lon, approx: true, note: `рядом с домом ${best.hh} (точного ${house} нет в OSM)` };
}

let indexPromise = null;
export function loadIndex() {
  indexPromise ||= fetch('./data/addresses-dresden.json')
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(buildIndex)
    .catch((e) => { indexPromise = null; throw e; });
  return indexPromise;
}

export async function geocode(address) {
  return lookup(await loadIndex(), address);
}
