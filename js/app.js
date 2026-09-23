import * as db from './db.js';
import { parseAddress, addressKey, formatAddress, geoQuery, matches } from './address.js';
import { PHRASES, CALL_SAY, CALL_HEARD, CHECKLIST, RULES } from './data.js';
import { geocode, HUB } from './geocode.js';
import * as mapView from './map.js';
import { summary } from './guidance.js';
import { arrowSvg } from './arrows.js';

const APP_VERSION = '1.8.0';

// ---------- Мелкие помощники ----------

// Построение DOM без innerHTML: пользовательский текст никогда не интерпретируется как HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const $ = (sel) => document.querySelector(sel);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* хранилище недоступно — не критично */ }
  },
};

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);
const shortDate = (d = new Date()) => d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

// ---------- Озвучка (Speech Synthesis, системный голос телефона) ----------

function germanVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === 'de-DE') || voices.find((v) => v.lang?.startsWith('de'));
}

function speak(text, rate = 0.9) {
  if (!('speechSynthesis' in window)) { toast('Озвучка не поддерживается'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  u.rate = rate;
  const v = germanVoice();
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

if ('speechSynthesis' in window) speechSynthesis.getVoices();

// Голос навигации — русский системный голос. Фразы встают в очередь, не перебивая друг друга.
function speakRu(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ru-RU';
  const voices = speechSynthesis.getVoices();
  const v = voices.find((x) => x.lang === 'ru-RU') || voices.find((x) => x.lang?.startsWith('ru'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

// Экран не гаснет, пока едем по маршруту: иначе телефон перестаёт получать GPS и голос молчит.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* нет поддержки или экран уже выключен */ }
}
document.addEventListener('visibilitychange', () => { if (mapView.nav.dest) keepAwake(true); });

// ---------- Состояние ----------

const state = {
  tab: store.get('tab', 'map'),
  query: '',
  addresses: [],
  currentId: store.get('currentId', null),
  phraseGroup: store.get('phraseGroup', PHRASES[0].id),
  callMode: 'say',
  heard: [],
  routeTo: store.get('routeTo', null),
  voice: store.get('voice', true),
  theme: store.get('theme', 'dark'),
  profile: store.get('profile', 'fastbike'),
};

async function loadAddresses() {
  state.addresses = await db.getAll();
}

function currentAddress() {
  return state.addresses.find((a) => a.id === state.currentId) || null;
}

function setCurrent(id) {
  state.currentId = id;
  store.set('currentId', id);
}

async function saveAddress(a) {
  a.updatedAt = Date.now();
  await db.put(a);
  const i = state.addresses.findIndex((x) => x.id === a.id);
  if (i >= 0) state.addresses[i] = a; else state.addresses.push(a);
  navigator.storage?.persist?.();
}

// ---------- Навигация по вкладкам ----------

const TABS = [
  { id: 'map', icon: '🗺️', label: 'Карта', render: renderMap },
  { id: 'addresses', icon: '🏠', label: 'Адреса', render: renderAddresses },
  { id: 'phrases', icon: '💬', label: 'Фразы', render: renderPhrases },
  { id: 'call', icon: '📞', label: 'Звонок', render: renderCall },
  { id: 'checklist', icon: '✅', label: 'Чек-лист', render: renderChecklist },
  { id: 'rules', icon: '🚦', label: 'ПДД', render: renderRules },
];

function renderNav() {
  const nav = $('#nav');
  nav.replaceChildren(...TABS.map((t) => h('button', {
    class: 'nav-btn' + (state.tab === t.id ? ' active' : ''),
    'aria-current': state.tab === t.id ? 'page' : null,
    onclick: () => go(t.id),
  }, h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, t.icon), h('span', {}, t.label))));
}

function go(tab) {
  state.tab = tab;
  store.set('tab', tab);
  render();
  $('#main').scrollTop = 0;
}

function render() {
  const tab = TABS.find((t) => t.id === state.tab) || TABS[0];
  $('#title').textContent = tab.label;
  renderNav();
  $('#main').classList.toggle('is-map', tab.id === 'map');
  $('#main').replaceChildren(tab.render());
}

// ---------- Экран «Карта» ----------

// Координаты адреса: из офлайн-базы OSM, один раз, потом хранятся в записи адреса.
async function ensureCoords(a) {
  if (a.lat) return a;
  const r = await geocode(a);
  if (!r) return null;
  Object.assign(a, { lat: r.lat, lon: r.lon, geoApprox: r.approx, geoNote: r.note });
  await saveAddress(a);
  return a;
}

async function showRoute(a) {
  state.routeTo = a.id;
  store.set('routeTo', a.id);
  setCurrent(a.id);
  if (state.tab !== 'map') go('map');
  await mapView.getMapElement();

  let found;
  try { found = await ensureCoords(a); } catch { toast('Не удалось загрузить базу адресов'); return; }
  if (!found) {
    toast('Адрес не найден в OSM — поставь точку вручную 📌');
    mapView.nav.dest = null;
    setEntrance(a);
    return;
  }
  mapView.routeTo({ lat: a.lat, lon: a.lon, approx: a.geoApprox }, state.profile);
}

// Поставить точку входа нажатием на карту — сохраняется в адрес и используется в следующий раз.
async function setEntrance(a) {
  const p = await mapView.pickPoint();
  if (!p) return;
  Object.assign(a, { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), geoApprox: false, geoNote: 'точка входа поставлена вручную' });
  await saveAddress(a);
  toast('Точка входа сохранена');
  mapView.routeTo({ lat: a.lat, lon: a.lon, approx: false }, state.profile);
}

// ---------- Хаб ----------

// Точка хаба: по умолчанию примерная (Prager Straße), пользователь уточняет её кнопкой 📌 у входа.
// HUB — общий объект, его же карта использует как старт, если нет GPS.
Object.assign(HUB, store.get('hub', {}));
const HUB_ID = 'hub';

async function showHub() {
  state.routeTo = HUB_ID;
  store.set('routeTo', HUB_ID);
  if (state.tab !== 'map') go('map');
  await mapView.getMapElement();
  mapView.routeTo({ lat: HUB.lat, lon: HUB.lon, approx: !store.get('hub', null) }, state.profile);
}

async function setHubPoint() {
  const p = await mapView.pickPoint();
  if (!p) return;
  const hub = { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) };
  Object.assign(HUB, hub);
  store.set('hub', hub);
  toast('Точка хаба сохранена');
  showHub();
}

// ---------- Голосовые подсказки ----------

let lastReroute = 0;
mapView.onGuide((e) => {
  if (e.routeReady) {
    keepAwake(true);
    if (state.voice) speakRu(summary(e.routeReady.length, e.routeReady.time));
  }
  if (e.say && state.voice) e.say.forEach(speakRu);
  if (e.pedZone && state.voice) speakRu('Пешеходная зона. Ведите велосипед.');
  if (e.offRoute && Date.now() - lastReroute > 30000) {
    lastReroute = Date.now();
    if (state.voice) speakRu('Вы ушли с маршрута. Перестраиваю.');
    rerouteCurrent();
  }
});

function rerouteCurrent() {
  if (state.routeTo === HUB_ID) { showHub(); return; }
  const a = state.addresses.find((x) => x.id === state.routeTo);
  if (a) showRoute(a);
}

function toggleVoice() {
  state.voice = !state.voice;
  store.set('voice', state.voice);
  if (state.voice) speakRu('Голосовые подсказки включены');
  else if ('speechSynthesis' in window) speechSynthesis.cancel();
  toast(state.voice ? '🔊 Голос включён' : '🔇 Голос выключен');
}

// Панель манёвра: крупная стрелка + расстояние + что делать. Совпадает с голосовыми подсказками.
function turnPanel(nav) {
  const m = nav.next;
  if (!m || nav.routeState !== 'ok' || nav.picking) return null;
  const icon = h('div', { class: 'turn-icon' });
  icon.innerHTML = arrowSvg(m); // только числа, без пользовательских данных
  const label = m.arrive ? (m.dist < 25 ? 'Вы на месте' : 'До места') : m.text;
  return h('div', { class: 'turn' + (m.dist < 30 ? ' now' : '') },
    icon,
    h('div', { class: 'turn-text' },
      (m.arrive && m.dist < 25) || m.dist < 10 ? null : h('div', { class: 'turn-dist' }, fmtKm(m.dist)),

      h('div', { class: 'turn-label' }, label[0].toUpperCase() + label.slice(1))));
}

const fmtKm = (m) =>
 (m < 1000 ? `${Math.round(m / 10) * 10} м` : `${(m / 1000).toFixed(1).replace('.', ',')} км`);
const fmtMin = (s) => `~${Math.max(1, Math.round(s / 60))} мин`;

function renderMap() {
  const wrap = h('div', { class: 'map-screen' });
  const top = h('div', { class: 'map-top' });
  const fabs = h('div', { class: 'map-fabs' });
  const hubBtn = h('button', { class: 'hub-btn', onclick: showHub }, '🏠 В хаб');
  const speedEl = h('div', { class: 'speed', hidden: true, 'aria-label': 'Скорость' });
  wrap.append(top, fabs, hubBtn, speedEl);


  const paint = (nav) => {
    const isHub = state.routeTo === HUB_ID;
    const hubSet = !!store.get('hub', null);
    const a = isHub ? null : state.addresses.find((x) => x.id === state.routeTo);
    const reroute = () => (isHub ? showHub() : showRoute(a));
    const banners = [];
    if (nav.picking) {
      banners.push(h('div', { class: 'map-banner info' }, isHub ? '👆 Нажми на карте, где вход в хаб' : '👆 Нажми на карте, где вход',
        h('button', { class: 'btn btn-ghost banner-btn', onclick: () => mapView.cancelPick() }, 'Отмена')));
    }
    if (nav.inPedZone) banners.push(h('div', { class: 'map-banner warn' }, '🚶 Пешеходная зона — веди велосипед рядом'));
    if (nav.gps === 'denied') banners.push(h('div', { class: 'map-banner warn' }, 'GPS запрещён. Разреши геолокацию для этого сайта в настройках Chrome.'));

    let card;
    if (!a && !isHub) {
      card = h('div', { class: 'map-card' },
        h('div', { class: 'map-card-row' },
          h('span', { class: 'muted', style: 'flex:1' }, 'Маршрут не выбран'),
          h('button', { class: 'btn', onclick: () => go('addresses') }, 'Адреса')));
    } else {
      let status = '';
      if (nav.routeState === 'loading') status = 'Строю маршрут…';
      else if (nav.routeState === 'ok' && nav.route) status = `${fmtKm(nav.route.length)} · ${fmtMin(nav.route.time)}` + (nav.route.fromHub ? ' · от хаба (нет GPS)' : '');
      else if (nav.routeState === 'offline') status = 'Нет интернета — маршрут не построить, точка на карте';
      else if (nav.routeState === 'error') status = 'Маршрут не построился — попробуй ↻';
      card = h('div', { class: 'map-card' },
        h('div', { class: 'map-card-row' },
          isHub
            ? h('div', { class: 'map-dest' }, h('span', { 'aria-hidden': 'true' }, '🏠'), h('span', { class: 'addr-main' }, 'Хаб'))
            : h('button', { class: 'map-dest', onclick: () => openAddress(a.id) },
              h('span', { class: 'mark mark-' + (a.mark || 'none'), 'aria-hidden': 'true' }),
              h('span', { class: 'addr-main' }, `${a.street} ${a.house}`)),
          h('button', { class: 'btn btn-icon btn-ghost', 'aria-label': 'Убрать маршрут', onclick: () => {
            state.routeTo = null; store.set('routeTo', null); mapView.clearRoute(); keepAwake(false); paint(mapView.nav);
          } }, '✕')),
        status ? h('div', { class: 'map-status' }, status) : null,
        a && (a.intercom || a.floor || a.entrance) ? h('div', { class: 'addr-hint' }, [a.intercom && `🔢 ${a.intercom}`, a.floor && `этаж ${a.floor}`, a.entrance].filter(Boolean).join(' · ')) : null,
        a?.geoApprox ? h('div', { class: 'map-approx' }, '⚠️ Точка примерная — поставь вход 📌') : null,
        isHub && !hubSet ? h('div', { class: 'map-approx' }, '⚠️ Точка хаба примерная — поставь её 📌 у входа') : null,

        // Во время езды (карта следует за мной) карточка компактная, чтобы не закрывать карту.
        nav.follow && nav.routeState === 'ok' ? null : h('div', { class: 'map-card-row' },
          h('div', { class: 'segmented small-seg' }, mapView.PROFILES.map((p) => h('button', {

            class: 'seg' + (state.profile === p.id ? ' on' : ''),
            onclick: () => { state.profile = p.id; store.set('profile', p.id); reroute(); },
          }, p.label))),
          h('button', { class: 'btn btn-icon', 'aria-label': 'Перестроить маршрут', onclick: reroute }, '↻')),
      );
    }
    top.replaceChildren(...[turnPanel(nav), card, ...banners].filter(Boolean));

    hubBtn.hidden = isHub || nav.picking;
    speedEl.hidden = nav.speed == null;
    if (nav.speed != null) speedEl.replaceChildren(h('b', {}, String(Math.round(nav.speed))), h('span', {}, 'км/ч'));
    fabs.replaceChildren(...[
      a || isHub ? h('button', { class: 'fab' + (nav.picking ? ' on' : ''), 'aria-label': isHub ? 'Поставить точку хаба' : 'Поставить точку входа',
        onclick: () => (nav.picking ? mapView.cancelPick() : isHub ? setHubPoint() : setEntrance(a)) }, '📌') : null,
      (a || isHub) && nav.dest ? h('button', { class: 'fab', 'aria-label': 'Показать весь маршрут', onclick: () => mapView.fitRoute() }, '⤢') : null,
      h('button', { class: 'fab', 'aria-label': state.voice ? 'Выключить голос' : 'Включить голос',
        onclick: () => { toggleVoice(); paint(mapView.nav); } }, state.voice ? '🔊' : '🔇'),
      h('button', { class: 'fab' + (nav.follow ? ' on' : ''), 'aria-label': 'Моё местоположение', onclick: () => mapView.followMe() }, '◎'),

    ].filter(Boolean));

  };

  mapView.onChange(paint);
  paint(mapView.nav);

  mapView.getMapElement().then((el) => {
    wrap.prepend(el);
    mapView.resize();
    // Маршрут выбран раньше (например, до перезапуска приложения), но ещё не построен.
    if (!mapView.nav.dest && mapView.nav.routeState === 'idle') {
      const a = state.addresses.find((x) => x.id === state.routeTo);
      if (state.routeTo === HUB_ID) showHub();
      else if (a) showRoute(a);
    }

  }).catch(() => {
    top.replaceChildren(h('div', { class: 'map-card' }, 'Карта не загрузилась. Проверь интернет и открой вкладку снова.'));
  });
  return wrap;
}

// ---------- Экран «Адреса» ----------


const MARKS = [
  { id: 'green', label: 'Простой' },
  { id: 'yellow', label: 'Средний' },
  { id: 'red', label: 'Проблемный' },
];

function addressCard(a) {
  const hint = [a.intercom && `🔢 ${a.intercom}`, a.floor && `этаж ${a.floor}`, a.entrance].filter(Boolean).join(' · ');
  return h('button', { class: 'addr-card', onclick: () => openAddress(a.id) },
    h('span', { class: 'mark mark-' + (a.mark || 'none'), 'aria-hidden': 'true' }),
    h('span', { class: 'addr-text' },
      h('span', { class: 'addr-main' }, `${a.street} ${a.house}`),
      hint ? h('span', { class: 'addr-hint' }, hint) : h('span', { class: 'addr-hint muted' }, a.zip || 'нет заметок'),
    ),
  );
}

function renderAddresses() {
  const wrap = h('div', { class: 'screen' });
  const results = h('div', { class: 'list' });

  const input = h('textarea', {
    class: 'addr-input', rows: 2, value: state.query,
    placeholder: 'Вставь адрес из Flink или начни вводить улицу',
    autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false',
    oninput: (e) => { state.query = e.target.value; fill(); },
  });

  const pasteBtn = h('button', { class: 'btn btn-big', onclick: async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { toast('Буфер обмена пуст'); return; }
      state.query = text.trim();
      input.value = state.query;
      fill(true);
    } catch {
      toast('Нет доступа к буферу — вставь долгим нажатием');
      input.focus();
    }
  } }, '📋 Вставить');

  const clearBtn = h('button', { class: 'btn btn-big btn-ghost', onclick: () => {
    state.query = ''; input.value = ''; fill(); input.focus();
  } }, '✕ Очистить');

  function fill(autoOpen = false) {
    const q = state.query.trim();
    const children = [];
    if (!q) {
      const recent = [...state.addresses].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0)).slice(0, 30);
      children.push(h('h2', { class: 'section-title' }, recent.length ? 'Последние адреса' : 'Адресов пока нет'));
      if (!recent.length) children.push(h('p', { class: 'muted pad' }, 'Скопируй адрес в приложении Flink и нажми «Вставить». Заметки (код, этаж, вход) сохранятся только на этом телефоне.'));
      children.push(...recent.map(addressCard));
    } else {
      const parsed = parseAddress(q);
      const key = parsed.house ? addressKey(parsed.street, parsed.house) : null;
      const exact = key && state.addresses.find((a) => a.key === key);
      if (exact && autoOpen) { openAddress(exact.id); return; }

      const found = exact ? [exact] : state.addresses.filter((a) => matches(a, q)).slice(0, 30);
      if (!exact && parsed.street && parsed.house) {
        children.push(h('button', { class: 'btn btn-primary btn-wide', onclick: () => createAddress(parsed) },
          `＋ Новый адрес: ${parsed.street} ${parsed.house}`));
      } else if (!exact && !found.length) {
        children.push(h('p', { class: 'muted pad' }, 'Ничего не найдено. Для нового адреса нужен номер дома.'));
      }
      if (found.length) children.push(h('h2', { class: 'section-title' }, exact ? 'Уже есть в базе' : 'Найдено'));
      children.push(...found.map(addressCard));
    }
    results.replaceChildren(...children);
  }

  wrap.append(
    h('div', { class: 'addr-search' }, input, h('div', { class: 'row' }, pasteBtn, clearBtn)),
    results,
  );
  fill();
  return wrap;
}

async function createAddress(parsed) {
  const a = {
    id: uid(),
    key: addressKey(parsed.street, parsed.house),
    street: parsed.street, house: parsed.house, zip: parsed.zip, city: parsed.city || 'Dresden',
    intercom: '', floor: '', entrance: '', bikeParking: '', elevator: '', comment: parsed.extra || '',
    mark: null, createdAt: Date.now(), lastUsedAt: Date.now(),
  };
  await saveAddress(a);
  state.query = '';
  openAddress(a.id);
  ensureCoords(a).catch(() => {});
}

// Карточка адреса — полноэкранный лист поверх вкладок.
async function openAddress(id) {
  const a = state.addresses.find((x) => x.id === id);
  if (!a) return;
  a.lastUsedAt = Date.now();
  await saveAddress(a);
  setCurrent(a.id);

  const save = debounce(() => saveAddress(a), 400);
  const field = (name, label, opts = {}) => h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    h(opts.multiline ? 'textarea' : 'input', {
      class: 'field-input' + (opts.big ? ' field-big' : ''),
      value: a[name] || '', rows: opts.multiline ? 3 : null,
      inputmode: opts.inputmode || null, placeholder: opts.placeholder || '',
      autocomplete: 'off',
      oninput: (e) => { a[name] = e.target.value; save(); },
    }),
  );

  const segmented = (name, options) => {
    const box = h('div', { class: 'segmented', role: 'group' });
    const paint = () => box.replaceChildren(...options.map((o) => h('button', {
      class: 'seg ' + (o.cls || '') + (a[name] === o.id ? ' on' : ''),
      'aria-pressed': String(a[name] === o.id),
      onclick: () => { a[name] = a[name] === o.id ? null : o.id; paint(); saveAddress(a); },
    }, o.label)));
    paint();
    return box;
  };

  // Если координаты известны (особенно поставленная вручную точка входа) — передаём их, иначе текст адреса.
  const geoPath = a.lat ? `${a.lat},${a.lon}?q=${a.lat},${a.lon}` : `0,0?q=${encodeURIComponent(geoQuery(a))}`;
  // Android intent-ссылка: открывает geo:-адрес в конкретном приложении,
  // а если его нет — Chrome сам ведёт на страницу установки в Google Play.
  const inApp = (pkg) => `intent:${geoPath}#Intent;scheme=geo;package=${pkg};end`;

  openSheet(`${a.street} ${a.house}`, h('div', { class: 'screen' },
    h('p', { class: 'muted' }, [a.zip, a.city].filter(Boolean).join(' ')),
    h('button', { class: 'btn btn-primary btn-wide', onclick: () => { closeSheet(); showRoute(a); } }, '🗺️ Маршрут на карте'),
    a.geoNote ? h('p', { class: 'hint' }, (a.geoApprox ? '⚠️ Точка примерная: ' : '📍 ') + a.geoNote) : null,
    h('div', { class: 'field-label' }, 'Открыть в другом приложении'),
    h('div', { class: 'row' },
      h('a', { class: 'btn btn-big btn-small-text', href: inApp('app.organicmaps') }, 'Organic Maps'),
      h('a', { class: 'btn btn-big btn-small-text', href: inApp('net.osmand') }, 'OsmAnd'),
      h('a', { class: 'btn btn-big btn-small-text', href: `geo:${geoPath}` }, 'Другое')),
    h('div', { class: 'field-label' }, 'Метка'),
    segmented('mark', MARKS.map((m) => ({ ...m, cls: 'seg-' + m.id }))),
    field('intercom', 'Код домофона', { big: true, inputmode: 'text', placeholder: '—' }),
    field('floor', 'Этаж', { placeholder: 'напр. 3 (2. OG)' }),
    field('entrance', 'Подъезд / вход', { placeholder: 'со двора, вторая дверь…' }),
    field('bikeParking', 'Где пристегнуть велосипед'),
    h('div', { class: 'field-label' }, 'Лифт'),
    segmented('elevator', [{ id: 'yes', label: 'Есть' }, { id: 'no', label: 'Нет' }]),
    field('comment', 'Комментарий', { multiline: true }),
    h('p', { class: 'hint' }, 'Имена клиентов не записывай — хватит адреса и технических заметок.'),
    h('button', { class: 'btn btn-wide', onclick: () => { closeSheet(); go('call'); } }, '📞 Помощник звонка'),
    h('button', { class: 'btn btn-wide btn-danger-ghost', onclick: async () => {
      if (!confirm(`Удалить адрес ${a.street} ${a.house}?`)) return;
      await db.remove(a.id);
      state.addresses = state.addresses.filter((x) => x.id !== a.id);
      if (state.currentId === a.id) setCurrent(null);
      closeSheet();
      toast('Адрес удалён');
    } }, 'Удалить адрес'),
  ));
}

// ---------- Экран «Фразы» ----------

function phraseCard(p) {
  return h('div', { class: 'phrase' },
    h('div', { class: 'phrase-ru' }, p.ru),
    h('div', { class: 'phrase-de', lang: 'de' }, p.de),
    h('div', { class: 'phrase-tr' }, p.tr),
    h('div', { class: 'phrase-actions' },
      h('button', { class: 'btn', onclick: () => speak(p.de) }, '🔊 Слушать'),
      h('button', { class: 'btn', onclick: () => showFullscreen(p) }, '⛶ Показать'),
    ),
  );
}

function renderPhrases() {
  const group = PHRASES.find((g) => g.id === state.phraseGroup) || PHRASES[0];
  return h('div', { class: 'screen' },
    h('div', { class: 'segmented sticky' }, PHRASES.map((g) => h('button', {
      class: 'seg' + (g.id === group.id ? ' on' : ''),
      onclick: () => { state.phraseGroup = g.id; store.set('phraseGroup', g.id); render(); },
    }, g.title))),
    group.items.map(phraseCard),
  );
}

function showFullscreen(p) {
  const fs = $('#fullscreen');
  fs.replaceChildren(
    h('div', { class: 'fs-de', lang: 'de' }, p.de),
    h('div', { class: 'fs-tr' }, p.tr),
    h('div', { class: 'fs-ru' }, p.ru),
    h('div', { class: 'row fs-actions' },
      h('button', { class: 'btn btn-big', onclick: (e) => { e.stopPropagation(); speak(p.de); } }, '🔊'),
      h('button', { class: 'btn btn-big', onclick: (e) => { e.stopPropagation(); speak(p.de, 0.6); } }, '🐢 Медленно'),
    ),
    h('div', { class: 'fs-close' }, 'Нажми в любом месте, чтобы закрыть'),
  );
  fs.hidden = false;
  fs.onclick = () => { hideFullscreen(); popOverlay(); };
  pushOverlay();
}

function hideFullscreen() {
  $('#fullscreen').hidden = true;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// ---------- Экран «Звонок» ----------

// Разносит услышанное по полям заметки: этаж → «Этаж», лифт → «Лифт», где дом → «Вход», остальное → комментарий.
function applyHeard(a, items) {
  const other = [];
  for (const it of items) {
    if (!it.note) continue;
    if (it.note.startsWith('этаж: ')) a.floor = it.note.slice(6);
    else if (it.note === 'есть лифт') a.elevator = 'yes';
    else if (it.group === 'Где дом') a.entrance = [a.entrance, it.note].filter(Boolean).join(', ');
    else other.push(it.note);
  }
  if (other.length) a.comment = [a.comment, `📞 ${shortDate()}: ${other.join(', ')}`].filter(Boolean).join('\n');
}

function renderCall() {
  const a = currentAddress();
  const wrap = h('div', { class: 'screen' });

  wrap.append(a
    ? h('button', { class: 'current-addr', onclick: () => openAddress(a.id) },
        h('span', { class: 'mark mark-' + (a.mark || 'none'), 'aria-hidden': 'true' }),
        h('span', { class: 'addr-text' },
          h('span', { class: 'muted small' }, 'Текущий адрес'),
          h('span', { class: 'addr-main' }, `${a.street} ${a.house}`)))
    : h('button', { class: 'current-addr empty', onclick: () => go('addresses') }, 'Адрес не выбран — выбрать в «Адресах»'));

  wrap.append(h('div', { class: 'segmented sticky' },
    [['say', '🗣 Я говорю'], ['heard', '👂 Он сказал']].map(([id, label]) => h('button', {
      class: 'seg' + (state.callMode === id ? ' on' : ''),
      onclick: () => { state.callMode = id; render(); },
    }, label))));

  if (state.callMode === 'say') {
    wrap.append(...CALL_SAY.map((p) => h('div', { class: 'phrase phrase-compact' },
      h('div', { class: 'phrase-de', lang: 'de' }, p.de),
      h('div', { class: 'phrase-tr' }, p.tr),
      h('div', { class: 'phrase-row' },
        h('span', { class: 'phrase-ru' }, p.ru),
        h('button', { class: 'btn btn-icon', 'aria-label': 'Слушать', onclick: () => speak(p.de) }, '🔊')),
    )));
    return wrap;
  }

  const isOn = (it) => state.heard.includes(it);
  for (const g of CALL_HEARD) {
    wrap.append(h('h2', { class: 'section-title' }, g.group));
    const grid = h('div', { class: 'heard-grid' });
    for (const it of g.items) {
      it.group = g.group;
      const btn = h('button', {
        class: 'heard' + (isOn(it) ? ' on' : ''),
        'aria-pressed': String(isOn(it)),
        onclick: () => {
          state.heard = isOn(it) ? state.heard.filter((x) => x !== it) : [...state.heard, it];
          btn.classList.toggle('on', isOn(it));
          btn.setAttribute('aria-pressed', String(isOn(it)));
          updateBar();
        },
      },
        h('span', { class: 'heard-de', lang: 'de' }, it.de),
        h('span', { class: 'heard-tr' }, it.tr),
        h('span', { class: 'heard-ru' }, it.ru));
      grid.append(btn);
    }
    wrap.append(grid);
  }

  const codeInput = h('input', { class: 'field-input field-big', placeholder: 'код двери, если назвали', autocomplete: 'off' });
  wrap.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Код домофона'), codeInput));

  const bar = h('div', { class: 'save-bar' });
  function updateBar() {
    const n = state.heard.length;
    bar.replaceChildren(h('button', {
      class: 'btn btn-primary btn-wide',
      disabled: !a || (!n && !codeInput.value.trim()),
      onclick: async () => {
        applyHeard(a, state.heard);
        if (codeInput.value.trim()) a.intercom = codeInput.value.trim();
        await saveAddress(a);
        state.heard = [];
        toast('Сохранено в заметку');
        render();
      },
    }, a ? `💾 Сохранить в заметку${n ? ` (${n})` : ''}` : 'Сначала выбери адрес'));
  }
  codeInput.addEventListener('input', updateBar);
  updateBar();
  wrap.append(bar);
  return wrap;
}

// ---------- Экран «Чек-лист» ----------

function renderChecklist() {
  // Отметки живут один день: на следующий день чек-лист снова пустой.
  let saved = store.get('checklist', {});
  if (saved.date !== today()) saved = { date: today(), done: [] };
  const done = new Set(saved.done);
  const persist = () => store.set('checklist', { date: saved.date, done: [...done] });

  const all = CHECKLIST.flatMap((g) => g.items);
  const progress = h('div', { class: 'progress' });
  const paintProgress = () => {
    const n = all.filter((i) => done.has(i)).length;
    progress.textContent = n === all.length ? 'Всё готово 👍' : `Готово ${n} из ${all.length}`;
  };
  paintProgress();

  return h('div', { class: 'screen' },
    progress,
    CHECKLIST.map((g) => [
      h('h2', { class: 'section-title' }, g.group),
      g.items.map((item) => {
        const btn = h('button', {
          class: 'check' + (done.has(item) ? ' on' : ''),
          role: 'checkbox', 'aria-checked': String(done.has(item)),
          onclick: () => {
            done.has(item) ? done.delete(item) : done.add(item);
            btn.classList.toggle('on', done.has(item));
            btn.setAttribute('aria-checked', String(done.has(item)));
            persist(); paintProgress();
          },
        }, h('span', { class: 'check-box', 'aria-hidden': 'true' }), h('span', {}, item));
        return btn;
      }),
    ]),
    h('button', { class: 'btn btn-wide btn-ghost', onclick: () => { store.set('checklist', {}); render(); } }, 'Сбросить отметки'),
  );
}

// ---------- Экран «ПДД» ----------

function renderRules() {
  return h('div', { class: 'screen' },
    RULES.map((sec, i) => h('details', { class: 'rules', open: i === 0 || null },
      h('summary', {}, sec.title),
      h('ul', {}, sec.items.map((it) => typeof it === 'string'
        ? h('li', {}, it)
        : h('li', { class: 'fine' }, '💶 ', it.text))),
    )),
  );
}

// ---------- Лист (оверлей) и настройки ----------

// Кнопка «Назад» на Android закрывает лист/полный экран, а не приложение:
// при открытии добавляем запись в историю, при закрытии — снимаем её.
function pushOverlay() {
  if (history.state?.overlay) return;
  history.pushState({ overlay: true }, '');
}

function popOverlay() {
  if (history.state?.overlay) history.back();
}

window.addEventListener('popstate', () => {
  if (!$('#fullscreen').hidden) { hideFullscreen(); if (!$('#sheet').hidden) pushOverlay(); return; }
  if (!$('#sheet').hidden) { $('#sheet').hidden = true; render(); }
});

function openSheet(title, content) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(content);
  $('#sheet').hidden = false;
  $('#sheet-body').scrollTop = 0;
  pushOverlay();
}

function closeSheet() {
  $('#sheet').hidden = true;
  popOverlay();
  render();
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openSettings() {
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data.addresses) ? data.addresses : [];
      const valid = items.filter((a) => a && a.id && a.street);
      for (const a of valid) a.key = addressKey(a.street, a.house);
      await db.putMany(valid);
      await loadAddresses();
      toast(`Импортировано адресов: ${valid.length}`);
      openSettings();
    } catch {
      toast('Не удалось прочитать файл');
    }
  } });

  let armed = false;
  const deleteBtn = h('button', { class: 'btn btn-wide btn-danger', onclick: async () => {
    if (!armed) {
      armed = true;
      deleteBtn.textContent = '⚠️ Точно удалить? Нажми ещё раз';
      setTimeout(() => { armed = false; deleteBtn.textContent = '🗑 Удалить все данные'; }, 5000);
      return;
    }
    await db.destroy();
    try { localStorage.clear(); } catch { /* уже пусто */ }
    state.addresses = []; state.currentId = null; state.heard = []; state.query = '';
    toast('Все данные удалены');
    closeSheet();
  } }, '🗑 Удалить все данные');

  const de = germanVoice();
  openSheet('Данные и настройки', h('div', { class: 'screen' },
    h('div', { class: 'info-box' },
      h('strong', {}, `Адресов в базе: ${state.addresses.length}`),
      h('p', {}, 'Адреса, коды и заметки хранятся только на этом телефоне и никуда не отправляются.'),
      h('p', {}, 'Для карты в интернет уходят только: запросы кусочков карты (OpenFreeMap) и координаты начала и конца маршрута (BRouter) — без адреса и заметок. Поиск адреса работает на телефоне.'),

    ),
    h('h2', { class: 'section-title' }, 'Резервная копия'),
    h('button', { class: 'btn btn-wide', onclick: () => {
      download(`flink-helper-backup-${today()}.json`, JSON.stringify({ app: 'flink-helper', version: APP_VERSION, exportedAt: new Date().toISOString(), addresses: state.addresses }, null, 2));
    } }, '⬇️ Экспорт в файл'),
    h('button', { class: 'btn btn-wide', onclick: () => fileInput.click() }, '⬆️ Импорт из файла'),
    fileInput,
    h('p', { class: 'hint' }, 'Файл копии содержит адреса и коды — это данные Flink. Не пересылай его никому.'),
    h('h2', { class: 'section-title' }, 'Удаление'),
    deleteBtn,
    h('p', { class: 'hint' }, 'При увольнении данные компании нужно удалить (§ 10 контракта). Кнопка стирает адреса, заметки и отметки чек-листа.'),
    h('h2', { class: 'section-title' }, 'Голос'),
    h('p', { class: 'hint' }, de ? `Немецкий голос: ${de.name}` : 'Немецкий голос не найден. Android: Настройки → Язык и ввод → Синтез речи → Google → установить «Deutsch».'),
    h('button', { class: 'btn btn-wide', onclick: () => speak('Hallo, hier ist Ihre Bestellung von Flink.') }, '🔊 Проверить голос'),
    h('p', { class: 'hint center' }, `Flink Helper Dresden · v${APP_VERSION}`),
  ));
}

// ---------- Тема ----------

function applyTheme() {
  const light = state.theme === 'light';
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]').content = light ? '#f3f4f6' : '#0e1013';
  document.querySelector('meta[name="color-scheme"]').content = light ? 'light' : 'dark';
  const btn = $('#theme-btn');
  btn.textContent = light ? '🌙' : '☀️';
  btn.setAttribute('aria-label', light ? 'Тёмная тема' : 'Светлая тема');
  mapView.setTheme(state.theme);
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  store.set('theme', state.theme);
  applyTheme();
}

// ---------- Запуск ----------

async function init() {
  $('#settings-btn').addEventListener('click', openSettings);
  $('#theme-btn').addEventListener('click', toggleTheme);
  applyTheme();

  $('#sheet-close').addEventListener('click', closeSheet);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#fullscreen').hidden) $('#fullscreen').click();
    else if (!$('#sheet').hidden) closeSheet();
  });
  await loadAddresses();
  render();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // Установленное приложение Android держит в памяти и при возврате не перезагружает,
    // поэтому проверяем обновления сами: при каждом возврате в приложение и раз в 30 минут.
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      setInterval(check, 30 * 60 * 1000);
    }).catch(() => {});
    // Новая версия активировалась — сразу показываем её (если не открыта карточка с вводом).
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      if ($('#sheet').hidden) location.reload();
      else toast('Есть новая версия — перезапусти приложение');
    });

  }
}

init();
