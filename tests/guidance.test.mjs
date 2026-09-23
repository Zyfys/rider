import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildGuide, step, distance, phrase, plural, summary } from '../js/guidance.js';

const gj = JSON.parse(readFileSync(new URL('./fixtures/route-johannstadt-hub.json', import.meta.url)));
const coords = gj.features[0].geometry.coordinates.map((c) => [c[0], c[1]]);
const hints = gj.features[0].properties.voicehints;

// Точки вдоль маршрута каждые ~8 м, как GPS на велосипеде.
function ride(coords, stepM = 8) {
  const pts = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const d = distance(coords[i - 1], coords[i]);
    const n = Math.max(1, Math.round(d / stepM));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      pts.push([coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t]);
    }
  }
  return pts;
}

test('phrases for BRouter commands', () => {
  assert.equal(phrase(2, 0, -89), 'налево');
  assert.equal(phrase(5, 0, 89), 'направо');
  assert.equal(phrase(3, 0, -30), 'плавно налево');
  assert.equal(phrase(1, 0, -8), null);
  assert.equal(phrase(14, 3, 0), 'на круговом движении третий съезд');
  assert.equal(phrase(99, 0, 70), 'направо');
});

test('riding the whole route announces every turn once, in order, and arrival', () => {
  const g = buildGuide(coords, hints);
  const said = [];
  for (const p of ride(coords)) {
    const r = step(g, p);
    assert.equal(r.offRoute, false, 'never off route while on the line');
    said.push(...r.say);
  }
  console.log(said.join(' | '));
  const nowPhrases = said.filter((s) => !s.startsWith('Через') && s !== 'Вы на месте');
  const expected = g.items.map((i) => i.text);
  // Каждый поворот произнесён (часть — склеена «, затем …»)
  const spoken = nowPhrases.flatMap((s) => s.toLowerCase().split(', затем '));
  assert.deepEqual(spoken, expected);
  assert.equal(said.filter((s) => s === 'Вы на месте').length, 1);
  assert.equal(said.at(-1), 'Вы на месте');
  assert.ok(said.some((s) => /^Через \d+ метров/.test(s)), 'has advance warnings');
});

test('leaving the route triggers off-route after two fixes', () => {
  const g = buildGuide(coords, hints);
  step(g, coords[5]);
  const far = [coords[5][0] + 0.003, coords[5][1] + 0.002]; // ~250 м в сторону
  assert.equal(step(g, far).offRoute, false);
  assert.equal(step(g, far).offRoute, true);
  assert.equal(step(g, coords[6]).offRoute, false, 'back on route');
});

test('russian plurals and summary', () => {
  assert.equal(plural(1, 'минута', 'минуты', 'минут'), 'минута');
  assert.equal(plural(3, 'минута', 'минуты', 'минут'), 'минуты');
  assert.equal(plural(11, 'минута', 'минуты', 'минут'), 'минут');
  assert.equal(plural(22, 'минута', 'минуты', 'минут'), 'минуты');
  assert.equal(summary(2349, 430), 'Маршрут построен. 2,3 километра, 7 минут.');
  assert.equal(summary(420, 70), 'Маршрут построен. 400 метров, 1 минута.');
});

test('after arrival: silent, no reroute', () => {
  const g = buildGuide(coords, hints);
  step(g, coords[coords.length - 1]);
  assert.equal(g.arrived, true);
  const far = [coords[0][0] + 0.01, coords[0][1]];
  assert.deepEqual(step(g, far), { say: [], offRoute: false, next: { arrive: true, dist: 0 } });
  assert.deepEqual(step(g, far), { say: [], offRoute: false, next: { arrive: true, dist: 0 } });
});

test('GPS jump far away near the route end does not trigger "Вы на месте"', () => {
  const g = buildGuide(coords, hints);
  step(g, coords[0]);
  const end = coords[coords.length - 1];
  const jump = [end[0] - 0.004, end[1] + 0.001]; // ~300 м от конца, в стороне
  const r1 = step(g, jump);
  assert.deepEqual(r1.say, []);
  assert.equal(g.arrived, false);
  assert.equal(step(g, jump).offRoute, true);
});

test('upcoming maneuver for the arrow panel counts down and ends with arrival', async () => {
  const { upcoming } = await import('../js/guidance.js');
  const g = buildGuide(coords, hints);
  const first = upcoming(g, 0);
  assert.equal(first.text, g.items[0].text);
  assert.ok(first.dist > 0);
  let prev = null;
  const seen = [];
  for (const p of ride(coords)) {
    const r = step(g, p);
    assert.ok(r.next, 'next always present on route');
    const label = r.next.arrive ? 'arrive' : r.next.text;
    if (label !== prev) { seen.push(label); prev = label; }
  }
  assert.equal(seen.at(-1), 'arrive');
  assert.ok(seen.length >= 10, 'panel walks through the turns: ' + seen.join(','));
});
