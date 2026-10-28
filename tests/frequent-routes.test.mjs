import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterPoints, buildNameIndex, describeRoute } from '../tools/frequent-routes.mjs';

const M = 1 / 111195;                 // градусов широты в метре
const ML = M / Math.cos(51.05 * Math.PI / 180); // градусов долготы в метре
const at = (east, north) => [13.73 + east * ML, 51.04 + north * M];

test('nearby addresses form one direction, the biggest first', () => {
  const pts = [
    ...[0, 50, 120, 200, 260].map((e) => at(e, 0)),        // 5 адресов рядом
    ...[0, 80, 150].map((e) => at(3000 + e, 0)),           // 3 адреса далеко
    at(-5000, 0),                                          // одиночка
  ].map(([lon, lat]) => ({ lon, lat }));
  const c = clusterPoints(pts, 400, 3);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0].idx.sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(c[1].idx.sort(), [5, 6, 7]);
});

test('route described street by street with turns', () => {
  // Улица A на север 400 м, затем направо на улицу B на восток 300 м, затем налево на C на север 200 м.
  const A = [at(0, 0), at(0, 400)], B = [at(0, 400), at(300, 400)], C = [at(300, 400), at(300, 600)];
  const index = buildNameIndex([{ name: 'Astraße', coords: A }, { name: 'Bweg', coords: B }, { name: 'Cplatz', coords: C }]);
  const line = [];
  for (let n = 0; n <= 400; n += 20) line.push(at(0, n));
  for (let e = 20; e <= 300; e += 20) line.push(at(e, 400));
  for (let n = 420; n <= 600; n += 20) line.push(at(300, n));
  const steps = describeRoute(index, line);
  assert.deepEqual(steps.map((s) => [s.turn, s.name]), [['', 'Astraße'], ['направо', 'Bweg'], ['налево', 'Cplatz']]);
  assert.deepEqual(steps.map((s) => s.m), [400, 300, 200]);
});

test('a short unnamed piece does not become a separate step', () => {
  const A = [at(0, 0), at(0, 300)], B = [at(0, 330), at(0, 700)];
  const index = buildNameIndex([{ name: 'Astraße', coords: A }, { name: 'Bstraße', coords: B }]);
  const line = [];
  for (let n = 0; n <= 700; n += 10) line.push(at(0, n));
  const steps = describeRoute(index, line);
  assert.deepEqual(steps.map((s) => [s.turn, s.name]), [['', 'Astraße'], ['прямо', 'Bstraße']]);
});
