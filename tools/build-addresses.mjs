// Собирает офлайн-базу адресов Дрездена из OpenStreetMap (© участники OSM, ODbL).
//
//   node tools/build-addresses.mjs            — скачать через Overpass и собрать
//   node tools/build-addresses.mjs file.tsv   — собрать из уже скачанного файла
//
// Результат: data/addresses-dresden.json вида { "Улица|Индекс": [["12a", lat, lon], ...] }.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const QUERY = `[out:csv(::lat,::lon,"addr:street","addr:housenumber","addr:postcode";false;"\\t")][timeout:300];
area["name"="Dresden"]["boundary"="administrative"]["admin_level"="6"]->.a;
nwr(area.a)["addr:housenumber"]["addr:street"];
out center;`;

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function download() {
  for (const url of MIRRORS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': 'flink-helper-dresden/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(QUERY),
    });
    const text = await res.text();
    if (res.ok && /^\d/.test(text)) return text;
    console.warn(`Overpass ${url}: ${res.status}`);
  }
  throw new Error('Overpass недоступен');
}

const tsv = process.argv[2] ? await readFile(process.argv[2], 'utf8') : await download();
const out = {};
let count = 0;
for (const line of tsv.split('\n')) {
  const [lat, lon, street, house, zip] = line.split('\t');
  if (!lat || !street || !house) continue;
  // «12;14» или «12,14» — несколько номеров на одном здании
  for (const h of house.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
    const key = `${street.trim()}|${(zip || '').trim()}`;
    const list = (out[key] ||= []);
    if (list.some((e) => e[0] === h)) continue;
    list.push([h, +(+lat).toFixed(5), +(+lon).toFixed(5)]);
    count++;
  }
}
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
const json = JSON.stringify(out);
await writeFile(new URL('../data/addresses-dresden.json', import.meta.url), json);
console.log(`Улиц: ${Object.keys(out).length}, адресов: ${count}, размер: ${(json.length / 1024 / 1024).toFixed(2)} МБ`);
