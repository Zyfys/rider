// Частые направления и описание маршрута словами — для шпаргалки на личной карте.
// Чистые функции: точки и линии на входе, текст на выходе. Проверяются тестами.

const M_LAT = 111195;
const M_LON = M_LAT * Math.cos(51.05 * Math.PI / 180);
const meters = (a, b) => Math.hypot((a[0] - b[0]) * M_LON, (a[1] - b[1]) * M_LAT);
const bearing = (a, b) => (Math.atan2((b[0] - a[0]) * M_LON, (b[1] - a[1]) * M_LAT) * 180 / Math.PI + 360) % 360;

// Направления: адреса, до которых не больше radius метров, — одно направление.
// Жадно: берём адрес с наибольшим числом соседей, забираем его соседей, повторяем.
// points — [{ lon, lat, ... }]; возвращает [{ idx: [индексы точек], center: [lon, lat] }] по убыванию размера.
export function clusterPoints(points, radius = 400, minSize = 3) {
  const free = new Set(points.map((_, i) => i));
  const near = points.map((p, i) => points.map((q, j) => j).filter((j) => meters([p.lon, p.lat], [points[j].lon, points[j].lat]) <= radius));
  const clusters = [];
  for (;;) {
    let best = -1, bestN = 0;
    for (const i of free) {
      const n = near[i].filter((j) => free.has(j)).length;
      if (n > bestN) { best = i; bestN = n; }
    }
    if (bestN < minSize) break;
    const idx = near[best].filter((j) => free.has(j));
    idx.forEach((j) => free.delete(j));
    const center = [idx.reduce((s, j) => s + points[j].lon, 0) / idx.length, idx.reduce((s, j) => s + points[j].lat, 0) / idx.length];
    clusters.push({ idx, center });
  }
  return clusters;
}

// Индекс названий улиц: отрезки именованных дорог OSM в сетке ~150 м.
// ways — [{ name, coords: [[lon, lat], ...] }]
export function buildNameIndex(ways) {
  const CELL = 0.0015;
  const grid = new Map();
  const cell = (lon, lat) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
  for (const w of ways) {
    for (let i = 1; i < w.coords.length; i++) {
      const a = w.coords[i - 1], b = w.coords[i];
      const seg = { name: w.name, a, b, br: bearing(a, b) };
      const keys = new Set([cell(a[0], a[1]), cell(b[0], b[1]), cell((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)]);
      for (const k of keys) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(seg); }
    }
  }
  return { grid, cell, CELL };
}

// Расстояние от точки до отрезка, м.
function toSegment(p, a, b) {
  const ax = 0, ay = 0, bx = (b[0] - a[0]) * M_LON, by = (b[1] - a[1]) * M_LAT;
  const px = (p[0] - a[0]) * M_LON, py = (p[1] - a[1]) * M_LAT;
  const len2 = bx * bx + by * by;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / len2)) : 0;
  return Math.hypot(px - t * bx, py - t * by);
}

// Название улицы под отрезком маршрута: ближайший именованный отрезок в пределах 18 м,
// идущий в ту же сторону (иначе на перекрёстке подхватится поперечная улица).
export function nameAt(index, a, b) {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const br = bearing(a, b);
  const [ci, cj] = index.cell(mid[0], mid[1]).split(',').map(Number);
  let best = null, bestScore = 18;
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
    for (const s of index.grid.get(`${i},${j}`) || []) {
      let d = Math.abs(s.br - br) % 180;
      if (d > 90) d = 180 - d; // дорога в обе стороны
      if (d > 35) continue;
      const score = toSegment(mid, s.a, s.b) + d / 5;
      if (score < bestScore) { bestScore = score; best = s.name; }
    }
  }
  return best;
}

const TURN = (delta) => {
  const d = ((delta + 540) % 360) - 180; // −180…180, плюс — вправо
  const a = Math.abs(d);
  if (a < 25) return 'прямо';
  if (a < 60) return d > 0 ? 'плавно направо' : 'плавно налево';
  if (a < 150) return d > 0 ? 'направо' : 'налево';
  return 'разворот';
};

// Маршрут словами: [{ turn, name, m }] — первая строка без поворота.
// Короткие куски (< 50 м) и куски без названия сливаются с соседними, чтобы шпаргалка была короткой.
export function describeRoute(index, line) {
  const runs = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const m = meters(a, b);
    if (m < 0.5) continue;
    const name = nameAt(index, a, b) || '';
    const last = runs[runs.length - 1];
    if (last && last.name === name) { last.m += m; last.end = [a, b]; }
    else runs.push({ name, m, start: [a, b], end: [a, b] });
  }
  // Сливаем короткие и безымянные куски с предыдущим (первый — со следующим).
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && (r.m < 50 || !r.name) ) { last.m += r.m; last.end = r.end; continue; }
    if (last && !last.name && merged.length === 1) { r.m += last.m; r.start = last.start; merged.pop(); }
    if (last && last.name === r.name) { last.m += r.m; last.end = r.end; continue; }
    merged.push({ ...r });
  }
  return merged.map((r, i) => ({
    turn: i ? TURN(bearing(...r.start) - bearing(...merged[i - 1].end)) : '',
    name: r.name || 'проезд без названия',
    m: Math.round(r.m / 10) * 10,
  }));
}
