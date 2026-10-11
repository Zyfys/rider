// Браузерный тест приложения целиком (Chrome + подменённые GPS, голос и BRouter).
//   node tools/serve.mjs            — в одном терминале
//   node tests/e2e/run.mjs          — в другом (BASE=https://… для проверки опубликованной версии)
// Все адреса в тесте выдуманные.
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8080/';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.env.SHOTS || join(tmpdir(), 'flink-helper-shots');
mkdirSync(SHOTS, { recursive: true });

const fixture = readFileSync(new URL('../fixtures/route-johannstadt-hub.json', import.meta.url), 'utf8');
const route = JSON.parse(fixture).features[0].geometry.coordinates;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); passed++; console.log('ok -', msg); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run'] });
await browser.defaultBrowserContext().overridePermissions(new URL(BASE).origin, ['geolocation']);
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

// Голос: записываем фразы вместо произнесения.
await page.evaluateOnNewDocument(() => {
  window.__said = [];
  speechSynthesis.speak = (u) => { window.__said.push(u.text); };
});
// BRouter: всегда отдаём один и тот же сохранённый маршрут — тест не зависит от сети и изменений карты.
// Запрос уходит из страницы, поэтому service worker его не перехватывает.
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().startsWith('https://brouter.de/')) {
    req.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: fixture });
  } else req.continue();
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text()) && errors.push(m.text()));

const text = () => page.evaluate(() => document.body.innerText);
const said = () => page.evaluate(() => window.__said);
const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const clickText = async (sel, t) => {
  const ok = await page.evaluate((sel, t) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(t)); if (el) el.click(); return !!el; }, sel, t);
  if (!ok) throw new Error(`not found: ${sel} "${t}"`);
  await sleep(300);
};
const waitText = async (re, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (re.test(await text())) return; await sleep(250); }
  throw new Error('timeout waiting for ' + re + '\n' + (await text()).slice(0, 400));
};
// Читает таблицу напрямую из IndexedDB. После «Удалить все данные» базы нет — тогда пустой список.
const readStore = (name) => page.evaluate(async (name) => {
  if (!(await indexedDB.databases()).some((d) => d.name === 'flink-helper')) return [];
  return new Promise((res) => {
    const r = indexedDB.open('flink-helper');
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(name)) { db.close(); res([]); return; }
      const g = db.transaction(name).objectStore(name).getAll();
      g.onsuccess = () => { db.close(); res(g.result); };
    };
  });
}, name);
const trips = () => readStore('trips');
const addresses = () => readStore('addresses');

try {
  await page.setGeolocation({ latitude: route[0][1], longitude: route[0][0] });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => { localStorage.clear(); await new Promise((r) => { const d = indexedDB.deleteDatabase('flink-helper'); d.onsuccess = d.onerror = d.onblocked = r; }); });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1500);

  // ---------- Импорт старой резервной копии (формат до 1.9) и обновление данных ----------
  const day = 86400000;
  const old = (i, street, house, zip, daysAgo, hour, extra = {}) => {
    const t = new Date(Date.now() - daysAgo * day); t.setHours(hour, 10 + i, 0, 0);
    return { id: `old${i}`, key: 'x', street, house, zip, city: 'Dresden', intercom: '', floor: '', entrance: '', bikeParking: '', elevator: '', comment: 'Dresden', mark: null, createdAt: t.getTime(), lastUsedAt: t.getTime(), ...extra };
  };
  const backup = { app: 'flink-helper', version: '1.8.0', addresses: [
    old(1, 'Grunaer Straße', '12', '01069', 3, 18, { lat: 51.0489, lon: 13.7479 }),
    old(2, 'Grunaer Str', '14', '01069', 3, 19, { lat: 51.0487, lon: 13.7500 }),
    old(3, 'Hauptstraße', '5', '01097', 2, 19, { lat: 51.0585, lon: 13.7425 }),
    old(4, 'Grunaer Straße 8 Apt', '034', '01069', 2, 20),                 // квартира прилипла к номеру дома
    old(5, 'Fetscherpl', '2', '01307', 1, 21),                              // сокращение Platz
    old(6, 'Neumarkt Rosmaringasse', '5', '01067', 1, 21, { comment: '드레스덴' }), // лишнее слово перед улицей
    old(7, 'Wilsdruffer Straße', '4', '01067', 1, 22, { comment: 'код 12, со двора' }), // свою заметку не трогаем
  ] };
  const file = join(SHOTS, 'old-backup.json');
  writeFileSync(file, JSON.stringify(backup));
  await page.click('#settings-btn');
  await sleep(300);
  await (await page.$('#sheet input[type=file]')).uploadFile(file);
  await waitText(/Адресов в базе: 7/);
  await sleep(2500); // обновление данных и поиск координат идут в фоне

  const A = await addresses();
  const byId = Object.fromEntries(A.map((a) => [a.id, a]));
  assert(A.filter((a) => a.comment === 'Dresden' || a.comment === '드레스덴').length === 0, 'repeated city removed from comments');
  assert(byId.old7.comment === 'код 12, со двора', 'own notes are kept');
  assert(byId.old4.street === 'Grunaer Straße' && byId.old4.house === '8' && byId.old4.comment === 'Apt 034', 'apartment split from house number');
  assert(A.every((a) => a.lat), 'all addresses got coordinates (Pl → Platz, extra word skipped)');
  let T = await trips();
  assert(T.length === 7 && T.every((t) => t.estimated && t.kind === 'address'), 'journal backfilled: one trip per saved address');
  assert(T.find((t) => t.target === 'old1').length > 500, 'backfilled trip has an estimated distance');

  // ---------- Экран статистики ----------
  await page.evaluate(() => document.querySelector('#sheet-close').click());
  await sleep(300);
  await clickText('.nav-btn', 'Адреса');
  await clickText('button', 'Статистика поездок');
  let t = await text();
  assert(/Всего\s*7\s*доставок/.test(t), 'stats: total deliveries');
  assert(/Самые частые улицы[\s\S]*1\s*Grunaer Straße\s*3×/i.test(t),'stats: top street merges spellings (Str / Straße)');
  assert(/Altstadt \/ Seevorstadt \(01069\)\s*3×/.test(t), 'stats: districts');
  await shot('01-stats');
  await page.evaluate(() => document.querySelector('#sheet-close').click());
  await sleep(300);

  // ---------- Маршрут в хаб: голос, стрелки, полоса прогресса ----------
  await clickText('.nav-btn', 'Карта');
  await sleep(2500);
  await page.click('.hub-btn');
  await waitText(/Хаб[\s\S]*(км|м) · ~\d+ мин/);
  assert((await said())[0].startsWith('Маршрут построен'), 'route summary spoken');
  assert(/проехал 0 м[\s\S]*осталось 2,3 км/.test(await text()), 'progress bar shows 0 done / 2,3 km left');
  T = await trips();
  assert(T.length === 8 && T.some((x) => x.kind === 'hub' && !x.estimated), 'hub trip logged');

  await page.click('.fab[aria-label="Перестроить маршрут"], button[aria-label="Перестроить маршрут"]');
  await sleep(1500);
  assert((await trips()).length === 8, 'rebuilding the same route is not a new trip');

  await page.click('.fab[aria-label="Моё местоположение"]');
  const pts = [];
  for (let i = 1; i < route.length; i++) {
    const [a, b] = [route[i - 1], route[i]];
    const d = Math.hypot((b[0] - a[0]) * 70000, (b[1] - a[1]) * 111000);
    const n = Math.max(1, Math.round(d / 8)); // ~8 м между точками, как GPS на велосипеде
    for (let k = 1; k <= n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const progress = [];
  for (const [i, [lon, lat]] of pts.entries()) {
    await page.setGeolocation({ latitude: lat, longitude: lon });
    await sleep(60);
    if (i % 45 === 0) progress.push(await page.evaluate(() => document.querySelector('.route-progress')?.innerText.replace(/\n/g, ' ')));
    if (i === Math.floor(pts.length / 2)) await shot('02-riding');
  }
  await sleep(800);
  console.log('progress:', progress.join(' | '));
  const S = await said();
  console.log('voice:', S.join(' | '));
  assert(!S.some((x) => /Пешеходная зона/.test(x)), 'no voice about the pedestrian zone');
  // 15 поворотов в маршруте; близкие склеиваются в одну фразу через «затем».
  assert(S.filter((x) => x.startsWith('Сейчас ')).flatMap((x) => x.split(', затем ')).length === 15, 'every turn gets its «Сейчас …» command');
  assert(!S.some((x) => /Через (1[1-9]\d|[2-9]\d\d) метров/.test(x)), 'no warnings earlier than 100 m');
  assert(S.at(-1) === 'Вы на месте', 'arrival spoken');
  assert(/осталось 0 м/.test(await text()), 'progress bar reaches the end');
  assert(progress.length > 3 && new Set(progress).size > 3, 'progress bar moves while riding');
  T = await trips();
  assert(T.find((x) => x.kind === 'hub')?.arrivedAt > 0, 'arrival recorded in the journal');

  // ---------- Маршрут к адресу: запись в журнал ----------
  await page.setGeolocation({ latitude: route[0][1], longitude: route[0][0] });
  await clickText('.nav-btn', 'Адреса');
  await clickText('.addr-card', 'Wilsdruffer Straße 4');
  await clickText('#sheet button', 'Маршрут на карте');
  await waitText(/Wilsdruffer Straße 4[\s\S]*(км|м) · ~\d+ мин/);
  await sleep(500);
  T = await trips();
  assert(T.length === 9 && T.filter((x) => x.target === 'old7').length === 2, 'address trip logged (second visit to the same address)');
  await page.reload({ waitUntil: 'networkidle0' });
  await waitText(/Wilsdruffer Straße 4[\s\S]*(км|м) · ~\d+ мин/);
  await sleep(500);
  assert((await trips()).length === 9, 'restoring the route after restart is not a new trip');

  // ---------- Экспорт содержит журнал; удаление стирает всё ----------
  await page.click('#settings-btn');
  await sleep(300);
  assert(/поездок в журнале: 9/.test(await text()), 'settings show the journal size');
  await clickText('button', 'Удалить все данные');
  await clickText('button', 'Точно удалить');
  await sleep(500);
  assert((await addresses()).length === 0 && (await trips()).length === 0, 'delete-all wipes addresses and journal');

  console.log(`\n${passed} проверок пройдено. Ошибки в консоли:`, errors.length ? errors : 'нет');
  if (errors.length) process.exitCode = 1;
} catch (e) {
  await shot('FAIL').catch(() => {});
  console.error('\n' + e.message, '\nОшибки в консоли:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
