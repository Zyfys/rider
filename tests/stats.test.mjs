import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStats } from '../js/stats.js';

const now = new Date(2026, 9, 11, 21, 0).getTime();
const at = (daysAgo, hour) => new Date(2026, 9, 11 - daysAgo, hour, 15).getTime();
const trip = (daysAgo, hour, street, house, zip, length, kind = 'address') => ({ id: Math.random().toString(36), ts: at(daysAgo, hour), kind, street, house, zip, length, time: 300 });

const trips = [
  trip(0, 18, 'Wilsdruffer Straße', '4', '01067', 1200),
  trip(0, 19, 'Wilsdruffer Str.', '4', '01067', 1300),      // тот же адрес в другом написании
  trip(0, 19, '', '', '', 1250, 'hub'),
  trip(0, 20, 'Grunaer Straße', '12', '01069', 900),
  trip(3, 18, 'Wilsdruffer Straße', '20', '01067', 1500),
  trip(10, 18, 'Hauptstraße', '36', '01097', 2400),
  trip(40, 12, 'Hauptstraße', '2', '01097', 2600),
];

test('periods: deliveries exclude hub returns, km include them', () => {
  const s = computeStats(trips, now);
  assert.equal(s.today.deliveries, 3);
  assert.ok(Math.abs(s.today.km - 4.65) < 1e-9);
  assert.equal(s.week.deliveries, 4);
  assert.equal(s.month.deliveries, 5);
  assert.equal(s.all.deliveries, 6);
});

test('top addresses, streets and districts', () => {
  const s = computeStats(trips, now);
  assert.deepEqual(s.topAddresses[0], { label: 'Wilsdruffer Straße 4', count: 2, km: 2.5 });
  assert.equal(s.topStreets[0].label, 'Wilsdruffer Straße');
  assert.equal(s.topStreets[0].count, 3);
  assert.equal(s.topStreets[1].label, 'Hauptstraße');
  assert.equal(s.topDistricts[0].label, 'Altstadt / Friedrichstadt (01067)');
  assert.equal(s.topDistricts[0].count, 3);
  assert.ok(!s.topAddresses.some((a) => a.label.trim() === ''), 'hub trips are not in the top');
});

test('busiest hour, average, recent', () => {
  const s = computeStats(trips, now);
  assert.equal(s.busiestHour, 18);
  assert.ok(Math.abs(s.avgKm - (1.2 + 1.3 + 0.9 + 1.5 + 2.4 + 2.6) / 6) < 1e-9);
  assert.equal(s.recent.length, 7);
  assert.equal(s.recent[0].street, 'Grunaer Straße');
});

test('empty journal', () => {
  const s = computeStats([], now);
  assert.equal(s.all.deliveries, 0);
  assert.equal(s.busiestHour, null);
  assert.deepEqual(s.topAddresses, []);
});
