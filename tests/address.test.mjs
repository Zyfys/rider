import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAddress, addressKey, matches } from '../js/address.js';

const cases = [
  ['Wilsdruffer Straße 12, 01067 Dresden', { street: 'Wilsdruffer Straße', house: '12', zip: '01067', city: 'Dresden' }],
  ['Wilsdruffer Str. 12\n01067 Dresden\nDeutschland', { street: 'Wilsdruffer Str', house: '12', zip: '01067', city: 'Dresden' }],
  ['St. Petersburger Straße 12a, 01069 Dresden', { street: 'St. Petersburger Straße', house: '12a', zip: '01069' }],
  ['Grunaer Straße 12-14, 01069 Dresden, 2. OG links', { street: 'Grunaer Straße', house: '12-14', extra: '2. OG links' }],
  ['Hauptstraße 5 B', { street: 'Hauptstraße', house: '5B', zip: '' }],
  ['01309 Dresden, Bodenbacher Str. 3', { street: 'Bodenbacher Str', house: '3', zip: '01309', city: 'Dresden' }],
  ['Straße des 17. Juni 5, 01069 Dresden', { street: 'Straße des 17. Juni', house: '5' }],
];
for (const [input, exp] of cases) {
  test(input, () => {
    const r = parseAddress(input);
    for (const k of Object.keys(exp)) assert.equal(r[k], exp[k], `${k} in ${JSON.stringify(r)}`);
  });
}

test('keys ignore spelling of Straße', () => {
  assert.equal(addressKey('Wilsdruffer Straße', '12'), addressKey('wilsdruffer str.', '12'));
  assert.equal(addressKey('Wilsdruffer Strasse', '12 A'), addressKey('Wilsdruffer Str', '12a'));
  assert.notEqual(addressKey('Strehlener Straße', '1'), addressKey('Str', '1'));
});

test('search while typing', () => {
  const a = { street: 'Wilsdruffer Straße', house: '12', zip: '01067' };
  for (const q of ['wils', 'Wilsdruffer Stra', 'wilsdruffer str 12', 'Wilsdruffer Straße 12', 'wilsdruffer strasse']) assert.ok(matches(a, q), q);
  assert.ok(!matches(a, 'Grunaer'));
  assert.ok(matches({ street: 'Löbtauer Straße', house: '3' }, 'loebtauer'));
});

// Форматы, в которых адрес реально приходит из Flink (примеры выдуманные)
test('Flink repeats the city after the zip — it must not land in the notes', () => {
  for (const tail of ['Dresden', '드레스덴', 'Sachsen', 'Deutschland']) {
    const r = parseAddress(`Hauptstraße 5, 01097 Dresden, ${tail}`);
    assert.deepEqual([r.street, r.house, r.zip, r.city, r.extra], ['Hauptstraße', '5', '01097', 'Dresden', '']);
  }
  assert.equal(parseAddress('Hauptstraße 5, 01097 Dresden, Dresden, 2. OG links').extra, '2. OG links');
});

test('apartment number after the house number goes to the notes', () => {
  const r = parseAddress('Grunaer Straße 12 Apt 034, 01069 Dresden, Dresden');
  assert.deepEqual([r.street, r.house, r.extra], ['Grunaer Straße', '12', 'Apt 034']);
  assert.equal(parseAddress('Grunaer Str. 12a Whg. 7').house, '12a');
  // «We»/«Zi» внутри названия улицы не трогаем
  assert.equal(parseAddress('Zinzendorfstraße 4').street, 'Zinzendorfstraße');
});

test('apartment after a slash: «4/ Appt 310»', () => {
  const r = parseAddress('Lindenweg 4/ Appt 310, 01069 Dresden');
  assert.deepEqual([r.street, r.house, r.extra], ['Lindenweg', '4', 'Appt 310']);
});

test('Sankt and St. are the same street', () => {
  assert.equal(addressKey('Sankt Petersburger Straße', '25'), addressKey('St. Petersburger Straße', '25'));
  assert.equal(addressKey('St Petersburger Str', '25'), addressKey('St. Petersburger Straße', '25'));
});

test('Platz and Pl. are the same street', () => {
  assert.equal(addressKey('Fetscherplatz', '2'), addressKey('Fetscherpl.', '2'));
  assert.equal(addressKey('Schillerplatz', '9'), addressKey('Schillerpl', '9'));
  assert.ok(matches({ street: 'Fetscherplatz', house: '2' }, 'fetscherpl 2'));
});
