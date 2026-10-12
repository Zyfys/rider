import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findClimbs, worstClimb, sliceLine } from '../js/elevation.js';
import { buildGuide, step, summary, CLIMB_PHRASE } from '../js/guidance.js';

const M = 1 / 111195; // градусов широты в метре

// Прямая на север с заданным профилем: [[длина участка в метрах, уклон в %], ...], точка каждые 10 м.
function line(profile) {
  const pts = [[13.73, 51.03, 110]];
  let s = 0;
  let ele = 110;
  for (const [len, grade] of profile) {
    for (let d = 10; d <= len; d += 10) {
      s += 10;
      ele += 10 * grade / 100;
      pts.push([13.73, 51.03 + s * M, ele]);
    }
  }
  return pts;
}

const hilly = line([[300, 0], [200, 6], [200, 0], [300, 9], [200, 0]]);

test('finds climbs, measures them and marks the steep one', () => {
  const climbs = findClimbs(hilly);
  assert.equal(climbs.length, 2);
  const [a, b] = climbs;
  assert.ok(Math.abs(a.from - 300) <= 40 && Math.abs(a.to - 500) <= 40, `first climb at ${a.from}–${a.to}`);
  assert.equal(a.steep, false);
  assert.ok(a.max > 5.5 && a.max <= 6.1);
  assert.ok(Math.abs(b.from - 700) <= 40 && Math.abs(b.to - 1000) <= 40, `second climb at ${b.from}–${b.to}`);
  assert.equal(b.steep, true);
  assert.ok(b.max > 8.5 && b.max <= 9.1);
  assert.ok(Math.abs(b.gain - 27) <= 3);
  assert.equal(worstClimb(climbs), b);
});

test('flat roads, short bumps and descents are not climbs', () => {
  assert.deepEqual(findClimbs(line([[1000, 0]])), []);
  assert.deepEqual(findClimbs(line([[400, 2], [400, 3]])), [], 'gentle slope');
  assert.deepEqual(findClimbs(line([[300, 0], [60, 8], [300, 0]])), [], 'a 5 m bump');
  assert.deepEqual(findClimbs(line([[300, 0], [300, -9], [300, 0]])), [], 'downhill');
});

test('route without elevation data gives no climbs', () => {
  assert.deepEqual(findClimbs(hilly.map((c) => [c[0], c[1]])), []);
  assert.deepEqual(findClimbs([]), []);
  assert.equal(worstClimb([]), null);
});

test('a climb interrupted by a short flat stretch is one climb', () => {
  const climbs = findClimbs(line([[300, 0], [150, 8], [40, 0], [150, 8], [300, 0]]));
  assert.equal(climbs.length, 1);
  assert.ok(climbs[0].to - climbs[0].from >= 300);
});

test('sliceLine cuts the stretch of the route between two marks', () => {
  const g = buildGuide(hilly.map((c) => [c[0], c[1]]));
  const part = sliceLine(g.coords, g.cum, 705, 995);
  const lat = (m) => 51.03 + m * M;
  assert.ok(Math.abs(part[0][1] - lat(705)) < M && Math.abs(part.at(-1)[1] - lat(995)) < M);
  assert.equal(part.length, 31); // концы + точки каждые 10 м между ними
});

test('voice warns about a steep climb once, before it starts; a moderate climb is silent', () => {
  const coords = hilly.map((c) => [c[0], c[1]]);
  const g = buildGuide(coords, [], findClimbs(hilly));
  const heard = [];
  for (let i = 0; i < coords.length; i++) {
    for (const text of step(g, coords[i]).say) heard.push([i * 10, text]);
  }
  const warnings = heard.filter(([, t]) => t === CLIMB_PHRASE);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0][0] >= 540 && warnings[0][0] <= 640, `warned at ${warnings[0][0]} m, climb starts at ~700 m`);
  assert.equal(heard.at(-1)[1], 'Вы на месте');
});

test('no warning when the route starts on the climb itself', () => {
  const up = line([[300, 9], [300, 0]]);
  const coords = up.map((c) => [c[0], c[1]]);
  const g = buildGuide(coords, [], findClimbs(up));
  const heard = coords.flatMap((p) => step(g, p).say);
  assert.ok(!heard.includes(CLIMB_PHRASE));
});

test('route summary mentions a steep climb', () => {
  assert.equal(summary(3700, 1260, findClimbs(hilly)), 'Маршрут построен. 3,7 километра, 21 минута. На пути крутой подъём.');
  assert.equal(summary(3700, 1260, [{ steep: false }]), 'Маршрут построен. 3,7 километра, 21 минута.');
  assert.equal(summary(3700, 1260), 'Маршрут построен. 3,7 километра, 21 минута.');
});
