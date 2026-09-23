import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildIndex, lookup } from '../js/geocode.js';

const index = buildIndex(JSON.parse(readFileSync(new URL('../data/addresses-dresden.json', import.meta.url))));
const near = (r, lat, lon) => Math.abs(r.lat - lat) < 0.002 && Math.abs(r.lon - lon) < 0.003;

test('exact address, any spelling of Straße', () => {
  for (const street of ['Wilsdruffer Straße', 'Wilsdruffer Str', 'wilsdruffer strasse']) {
    const r = lookup(index, { street, house: '4', zip: '01067' });
    assert.ok(r && !r.approx && near(r, 51.05025, 13.74185), street + ' ' + JSON.stringify(r));
  }
});

test('same street name in different districts is resolved by zip', () => {
  const a = lookup(index, { street: 'Hauptstraße', house: '4', zip: '01465' });
  assert.ok(a.lat > 51.1, JSON.stringify(a)); // Langebrück
  const b = lookup(index, { street: 'Hauptstraße', house: '36', zip: '01097' });
  assert.ok(near(b, 51.0604, 13.7441), JSON.stringify(b)); // Innere Neustadt
});

test('without zip prefers the one closest to the hub', () => {
  const r = lookup(index, { street: 'Hauptstraße', house: '4', zip: '' });
  assert.ok(r.lat < 51.08, JSON.stringify(r));
});

test('letter suffix / missing number fall back to approximate point', () => {
  const r = lookup(index, { street: 'Wilsdruffer Straße', house: '4z', zip: '01067' });
  assert.ok(r.approx && near(r, 51.05025, 13.74185), JSON.stringify(r));
  const f = lookup(index, { street: 'Wilsdruffer Straße', house: '999', zip: '01067' });
  assert.ok(f.approx && f.note.includes('рядом'), JSON.stringify(f));
});

test('unknown street → null', () => {
  assert.equal(lookup(index, { street: 'Nichtexistierende Gasse', house: '1', zip: '' }), null);
});
