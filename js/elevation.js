// Подъёмы на маршруте по высотам из BRouter (третье число в координатах точки).
// Чистые функции без DOM — проверяются тестами.
import { distance } from './guidance.js';

const STEP = 20;         // шаг пересчёта высот вдоль маршрута, м
const WINDOW = 4;        // уклон считается на отрезке WINDOW × STEP = 80 м: высоты в данных шумят
const CLIMB = 5;         // % — с такого уклона участок считается подъёмом
export const STEEP = 7;  // % — «крутой подъём»: на нём слабый мотор e-bike уже не вытягивает
const MERGE_GAP = 60;    // м — подъёмы с такой паузой между ними считаются одним
const MIN_GAIN = 8;      // м набора — меньшие горки не показываем

// coords — [[lon, lat, высота], ...]. Возвращает подъёмы по порядку:
// [{ from, to — метры от начала маршрута, gain — набор в метрах, max — наибольший уклон в %, steep }]
export function findClimbs(coords) {
  if (coords.length < 2 || coords.some((c) => typeof c[2] !== 'number' || Number.isNaN(c[2]))) return [];
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1];
  if (total < STEP * WINDOW) return [];

  // Высоты через равные промежутки.
  const ele = [];
  for (let s = 0, i = 0; s <= total; s += STEP) {
    while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const len = cum[i + 1] - cum[i];
    const t = len ? Math.min(1, (s - cum[i]) / len) : 0;
    ele.push(coords[i][2] + (coords[i + 1][2] - coords[i][2]) * t);
  }

  // Уклон каждого шага — по окну в 80 м вокруг него.
  const n = ele.length - 1;
  const grade = [];
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1);
    const b = Math.min(n, a + WINDOW);
    grade.push(((ele[b] - ele[a]) / ((b - a) * STEP)) * 100);
  }

  const runs = [];
  for (let k = 0; k < n; k++) {
    if (grade[k] < CLIMB) continue;
    const last = runs[runs.length - 1];
    if (last && (k - last.b) * STEP <= MERGE_GAP) last.b = k + 1;
    else runs.push({ a: k, b: k + 1 });
  }

  return runs
    .map(({ a, b }) => {
      const max = Math.max(...grade.slice(a, b));
      return { from: a * STEP, to: Math.min(total, b * STEP), gain: Math.round(ele[b] - ele[a]), max: Math.round(max * 10) / 10, steep: max >= STEEP };
    })
    .filter((c) => c.gain >= MIN_GAIN);
}

// Самый тяжёлый подъём — для строки в карточке маршрута.
export function worstClimb(climbs) {
  return climbs.reduce((w, c) => (!w || c.max > w.max ? c : w), null);
}

// Кусок линии маршрута между отметками from и to (метры от начала) — чтобы подкрасить подъём на карте.
export function sliceLine(coords, cum, from, to) {
  const at = (s) => {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const len = cum[i + 1] - cum[i];
    const t = len ? Math.max(0, Math.min(1, (s - cum[i]) / len)) : 0;
    return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t];
  };
  const inside = coords.filter((_, i) => cum[i] > from && cum[i] < to).map((c) => [c[0], c[1]]);
  return [at(from), ...inside, at(to)];
}
