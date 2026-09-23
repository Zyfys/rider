// Голосовые подсказки по маршруту BRouter: «Через 100 метров направо» → «Направо» → «Вы на месте».
// Чистые функции без DOM — проверяются тестами на реальном маршруте.

const EARTH = 6371000;
const RAD = Math.PI / 180;

// Коды манёвров BRouter (VoiceHint): 1 прямо, 2 налево, 3 плавно налево, 4 резко налево,
// 5 направо, 6 плавно направо, 7 резко направо, 8/9 держаться левее/правее,
// 10–12 разворот, 13 сход с маршрута, 14/15 круговое движение, 16 по прямой, 17/18 съезд.
const COMMANDS = {
  2: 'налево', 3: 'плавно налево', 4: 'резко налево',
  5: 'направо', 6: 'плавно направо', 7: 'резко направо',
  8: 'держитесь левее', 9: 'держитесь правее',
  10: 'развернитесь', 11: 'развернитесь', 12: 'развернитесь',
  17: 'съезд налево', 18: 'съезд направо',
};
const SILENT = new Set([1, 13, 16, 100]);
const ORDINALS = ['первый', 'второй', 'третий', 'четвёртый', 'пятый', 'шестой', 'седьмой'];

export function phrase(cmd, exit, angle) {
  if (COMMANDS[cmd]) return COMMANDS[cmd];
  if (cmd === 14 || cmd === 15) return `на круговом движении ${ORDINALS[exit - 1] || ''} съезд`.replace('  ', ' ');
  if (SILENT.has(cmd)) return null;
  // Неизвестный код — по углу поворота.
  if (angle <= -60) return 'налево';
  if (angle <= -20) return 'плавно налево';
  if (angle >= 60) return 'направо';
  if (angle >= 20) return 'плавно направо';
  return null;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Координаты — [lon, lat].
export function distance(a, b) {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(s));
}

// voicehints: [[индекс точки, код, номер съезда, расстояние до следующей, угол], ...]
export function buildGuide(coords, hints = []) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distance(coords[i - 1], coords[i]));
  const items = hints
    .map(([idx, cmd, exit, , angle]) => ({ at: cum[Math.min(idx, cum.length - 1)], text: phrase(cmd, exit, angle), cmd, exit, angle }))
    .filter((i) => i.text);
  return { coords, cum, total: cum[cum.length - 1], items, next: 0, last: 0, pre: false, arrived: false, offCount: 0 };
}

// Следующий манёвр для панели со стрелкой: { text, dist, cmd, exit, angle } или { arrive: true, dist }.
export function upcoming(g, s = 0) {
  if (g.arrived) return { arrive: true, dist: 0 };
  const it = g.items.slice(g.next).find((i) => i.at >= s - 15);
  if (!it) return { arrive: true, dist: Math.max(0, g.total - s) };
  const { text, cmd, exit, angle } = it;
  return { text, cmd, exit, angle, dist: Math.max(0, it.at - s) };
}

// Проекция точки на отрезок в локальных метрах: { s — пройдено вдоль маршрута, off — отклонение }.
function project(g, p, i) {
  const a = g.coords[i];
  const b = g.coords[i + 1];
  const k = Math.cos(a[1] * RAD) * EARTH * RAD;
  const ax = 0, ay = 0;
  const bx = (b[0] - a[0]) * k, by = (b[1] - a[1]) * EARTH * RAD;
  const px = (p[0] - a[0]) * k, py = (p[1] - a[1]) * EARTH * RAD;
  const len2 = bx * bx + by * by;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / len2)) : 0;
  const off = Math.hypot(px - t * bx, py - t * by);
  return { s: g.cum[i] + t * Math.sqrt(len2), off, i };
}

export function locate(g, p) {
  const n = g.coords.length - 1;
  const search = (from, to) => {
    let best = null;
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) {
      const r = project(g, p, i);
      if (!best || r.off < best.off) best = r;
    }
    return best;
  };
  // Сначала ищем рядом с прошлым местом (чтобы не «прыгать» на другой участок маршрута), потом везде.
  let best = search(g.last - 3, g.last + 80);
  if (!best || best.off > 45) {
    const all = search(0, n);
    if (all && (!best || all.off < best.off)) best = all;
  }
  if (!best) return { s: 0, off: distance(p, g.coords[0]) };
  g.last = best.i;
  return best;
}

// Один шаг по новой GPS-точке. Возвращает { say: [фразы], offRoute }.
export function step(g, p) {
  // Уже на месте — дальше молчим и не перестраиваем, даже если отошли от точки.
  if (g.arrived) return { say: [], offRoute: false, next: upcoming(g) };
  const { s, off } = locate(g, p);
  // Далеко от линии — ничего не объявляем (иначе GPS-скачок дал бы ложное «Вы на месте»).
  // Две такие точки подряд — сход с маршрута.
  g.offCount = off > 45 ? g.offCount + 1 : 0;
  if (g.offCount) return { say: [], offRoute: g.offCount >= 2, next: null };


  const say = [];
  // Пропускаем уже проеханные повороты.
  while (g.next < g.items.length && g.items[g.next].at < s - 15) { g.next++; g.pre = false; }
  const it = g.items[g.next];
  if (it) {
    const d = it.at - s;
    if (d <= 30) {
      let text = cap(it.text);
      const after = g.items[g.next + 1];
      if (after && after.at - it.at < 40) { text += `, затем ${after.text}`; g.next++; }
      say.push(text);
      g.next++;
      g.pre = false;
    } else if (!g.pre && d <= 160) {
      if (d >= 60) say.push(`Через ${Math.round(d / 50) * 50} метров ${it.text}`);
      g.pre = true;
    }
  }
  if (!g.arrived && g.total - s < 25) {
    g.arrived = true;
    say.push('Вы на месте');
  }
  return { say, offRoute: false, next: upcoming(g, s) };
}


export function summary(lengthM, timeS) {
  const min = Math.max(1, Math.round(timeS / 60));
  const dist = lengthM < 1000
    ? `${Math.round(lengthM / 50) * 50 || 50} метров`
    : `${(lengthM / 1000).toFixed(1).replace('.', ',')} километра`;
  return `Маршрут построен. ${dist}, ${min} ${plural(min, 'минута', 'минуты', 'минут')}.`;
}
