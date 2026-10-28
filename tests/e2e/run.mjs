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

// Тот же маршрут, но с горкой: с 800-го по 1100-й метр уклон 9 % (+27 м). Его мок отдаёт для профиля
// «Быстрый»; для «Без горок» — исходный ровный. Так проверяется и показ подъёма, и кнопка «Объехать».
const hillyFixture = (() => {
  const gj = JSON.parse(fixture);
  const pts = gj.features[0].geometry.coordinates;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) s += Math.hypot((pts[i][0] - pts[i - 1][0]) * 70000, (pts[i][1] - pts[i - 1][1]) * 111000);
    pts[i][2] = 113 + Math.max(0, Math.min(300, s - 800)) * 0.09;
  }
  gj.features[0].properties['filtered ascend'] = '27';
  return JSON.stringify(gj);
})();

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
// Приложение сначала загружает на сервер свой профиль (POST /brouter/profile) и строит маршрут с его id.
const brouter = { uploads: 0, profiles: [], failNext: 1, texts: {} }; // первый запрос маршрута «сервер забыл профиль»
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (url.startsWith('https://brouter.de/brouter/profile')) {
    brouter.uploads++;
    brouter.lastUpload = req.postData() || '';
    brouter.texts[`custom_test${brouter.uploads}`] = brouter.lastUpload;
    req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ profileid: `custom_test${brouter.uploads}` }) });
  } else if (url.startsWith('https://brouter.de/')) {
    const profile = new URL(url).searchParams.get('profile');
    brouter.profiles.push(profile);
    if (profile.startsWith('custom_') && brouter.failNext-- > 0) req.respond({ status: 500, headers: cors, body: 'profile not found' });
    else {
      const noHillPenalty = /assign uphillcost\s+= 0 /.test(brouter.texts[profile] || '');
      req.respond({ status: 200, contentType: 'application/json', headers: cors, body: noHillPenalty ? hillyFixture : fixture });
    }
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
  // profile = fastbike без отметки easyProfile — как у установленного приложения до версии 1.11.
  await page.evaluate(async () => { localStorage.clear(); localStorage.setItem('profile', '"fastbike"'); await new Promise((r) => { const d = indexedDB.deleteDatabase('flink-helper'); d.onsuccess = d.onerror = d.onblocked = r; }); });
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(1500);

  // ---------- Импорт старой резервной копии (формат до 1.9) и обновление данных ----------
  const day = 86400000;
  const old = (i, street, house, zip, daysAgo, hour, extra = {}) => {
    // +1 день: адрес без маршрута попадает в статистику через 3 часа — тест не должен зависеть от времени запуска.
    const t = new Date(Date.now() - (daysAgo + 1) * day); t.setHours(hour, 10 + i, 0, 0);
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
  assert(brouter.lastUpload.includes('bicycle=use_sidepath') && brouter.lastUpload.includes('0.3'), 'custom BRouter profile (use_sidepath fix) is uploaded');
  assert(/assign uphillcost\s+= 300 /.test(brouter.lastUpload) && /assign uphillcutoff\s+= 3 /.test(brouter.lastUpload), 'after the update the profile is switched to «Без горок» once (uphill penalty)');
  assert(brouter.lastUpload.includes('switch or hascycleway bicycle=yes|designated 1.3 3') && brouter.lastUpload.includes('surface=compacted|fine_gravel 1.5 3'),
    'profile lets the route use pedestrian zones and park paths where bikes are allowed');
  assert(!/Пешеходная зона/.test(await text()), 'no pedestrian-zone banner');
  assert(brouter.profiles[0] === 'custom_test1' && brouter.profiles[1] === 'custom_test2' && brouter.uploads === 2,
    'route uses the custom profile; when the server forgot it, the app re-uploads and retries');
  assert(/проехал 0 м[\s\S]*осталось 2,3 км/.test(await text()), 'progress bar shows 0 done / 2,3 km left');
  T = await trips();
  assert(T.length === 8 && T.some((x) => x.kind === 'hub' && !x.estimated), 'hub trip logged');

  await page.click('.fab[aria-label="Перестроить маршрут"], button[aria-label="Перестроить маршрут"]');
  await sleep(1500);
  assert((await trips()).length === 8, 'rebuilding the same route is not a new trip');
  assert(brouter.uploads === 2 && brouter.profiles.at(-1) === 'custom_test2', 'profile id is reused, not uploaded for every route');

  // ---------- Подъёмы: «Быстрый» ведёт через горку, «Объехать» возвращает пологий маршрут ----------
  assert(!/⛰/.test(await text()), 'flat route: no climb line');
  await clickText('.seg', 'Быстрый');
  await waitText(/⛰ Крутой подъём \d+ м, до 9 %/);
  assert(/· ↗ 27 м/.test(await text()), 'route card shows the ascent');
  assert((await said()).at(-1).endsWith('На пути крутой подъём.'), 'steep climb mentioned in the spoken summary');
  assert(await page.evaluate(() => document.querySelectorAll('.rp-climb.steep').length === 1), 'climb marked on the progress bar');
  await sleep(1200);
  await shot('02a-climb');
  await clickText('.map-climb button', 'Объехать');
  await sleep(1500);
  assert(!/⛰/.test(await text()) && brouter.profiles.at(-1) === 'custom_test2', '«Объехать» switches to the hill-avoiding profile');
  assert(await page.evaluate(() => localStorage.getItem('profile')) === '"easy"', 'profile choice is saved');
  assert((await trips()).length === 8, 'switching the profile is not a new trip');

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
    // Ждём ответа страницы: пока она занята отрисовкой карты, точки GPS копились бы и «перепрыгивали» поворот.
    await page.evaluate(() => 0);
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
  const hubTrack = T.find((x) => x.kind === 'hub')?.track || [];
  assert(hubTrack.length > 100 && hubTrack.every((p) => p.length === 3), `GPS track recorded for the trip (${hubTrack.length} points)`);
  assert(!/На месте ·/.test(await text()), 'no «На месте» note card for the hub');

  // ---------- Маршрут к адресу: запись в журнал ----------
  // Сначала убираем маршрут: на пустой карте открытие вкладки раньше «восстанавливало» маршрут
  // и стирало отметку о новой поездке — поездка к клиенту не записывалась.
  await page.click('button[aria-label="Убрать маршрут"]');
  await sleep(300);
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

  // ---------- «На месте»: быстрая заметка у двери ----------
  for (const [lon, lat] of pts.slice(-40)) {
    await page.setGeolocation({ latitude: lat, longitude: lon });
    await sleep(60);
    await page.evaluate(() => 0);
  }
  await waitText(/На месте · Wilsdruffer Straße 4/);
  assert(/уже 2-й раз/.test(await text()), 'arrival card says this is a repeat visit');
  await page.type('.arrive .arr-field input', '4711');
  await clickText('.arrive .arr-chip', 'со двора');
  await clickText('.arrive .arr-chip', 'лифта нет');
  await clickText('.arrive .arr-chip', 'Простой');
  // Новые точки GPS перерисовывают карту — поле ввода не должно терять текст и курсор.
  await page.setGeolocation({ latitude: pts.at(-1)[1] + 0.00001, longitude: pts.at(-1)[0] });
  await sleep(800);
  assert(await page.evaluate(() => document.activeElement?.closest?.('.arrive') != null || document.querySelector('.arrive input').value === '4711'), 'note card survives GPS updates');
  await sleep(600);
  let W = (await addresses()).find((a) => a.id === 'old7');
  assert(W.intercom === '4711' && W.entrance === 'со двора' && W.elevator === 'no' && W.mark === 'green', 'quick note saved to the address');
  assert(/🔢 4711 · со двора/.test(await text()), 'saved note shown big on the card');
  await clickText('.arrive button', 'Готово');
  assert(!/На месте ·/.test(await text()), 'card closes with «Готово»');
  assert(/↺ раньше возил сюда: 1 раз · лифта нет/.test(await text()), 'route card shows repeat visits and the note');
  const addrTrip = (await trips()).filter((x) => x.target === 'old7').at(-1);
  assert(addrTrip.arrivedAt > 0 && addrTrip.track?.length > 5, 'address trip: arrival and track recorded');

  // ---------- Вставленный адрес не разобрался — попадает в список «Не найденные адреса» ----------
  await clickText('.nav-btn', 'Адреса');
  await page.evaluate(() => { navigator.clipboard.readText = async () => 'Irgendwo im Hinterhof ohne Nummer'; });
  await clickText('button', 'Вставить');
  await waitText(/Ничего не найдено/);
  await page.type('.addr-input', ' x'); // набор по буквам в список не попадает
  await sleep(300);

  // ---------- Экспорт содержит журнал; удаление стирает всё ----------
  await page.click('#settings-btn');
  await sleep(300);
  assert(/поездок в журнале: 9/.test(await text()), 'settings show the journal size');
  assert(/Не найденные адреса[\s\S]*Irgendwo im Hinterhof ohne Nummer\s*не разобран/i.test(await text()), 'unparsed pasted address is listed in settings');
  assert(await page.evaluate(() => JSON.parse(localStorage.getItem('notFound')).length) === 1, 'typing does not add to the not-found list');
  await clickText('button', 'Удалить все данные');
  await clickText('button', 'Точно удалить');
  await sleep(500);
  assert((await addresses()).length === 0 && (await trips()).length === 0, 'delete-all wipes addresses and journal');
  assert(await page.evaluate(() => localStorage.getItem('notFound')) === null, 'delete-all wipes the not-found list');

  console.log(`\n${passed} проверок пройдено. Ошибки в консоли:`, errors.length ? errors : 'нет');
  if (errors.length) process.exitCode = 1;
} catch (e) {
  await shot('FAIL').catch(() => {});
  console.error('\n' + e.message, '\nОшибки в консоли:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
