// Разбор адреса, вставленного из приложения Flink, и нормализация для поиска.

// Приводит строку к виду для сравнения: «Wilsdruffer Straße» == «wilsdruffer str.» == «Wilsdruffer Strasse»,
// «Fetscherplatz» == «Fetscherpl.».
export function norm(s, collapseStreet = true) {
  const t = (s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    // Flink пишет «Sankt Petersburger Straße», в OSM — «St. Petersburger Straße».
    .replace(/\bsankt\b/g, 'st');
  return (collapseStreet ? t.replace(/strasse\b|str\b\.?/g, 'str').replace(/platz\b|pl\b\.?/g, 'pl') : t).replace(/[^a-z0-9а-яё]/g, '');
}

export function addressKey(street, house) {
  return norm(street) + '|' + norm(house);
}

const HOUSE = String.raw`\d+\s*[a-zA-Z]?(?:\s*[-–/]\s*\d+\s*[a-zA-Z]?)?`;
const STREET_HOUSE = new RegExp(String.raw`^(.*?\D)\s*(${HOUSE})$`);
const ZIP_CITY = /\b(\d{5})\s*([A-Za-zÄÖÜäöüß .-]*)/;
// Номер квартиры после дома: «Grunaer Straße 12 Apt 034», «… Whg. 12», «… 4/ Appt 310».
const APARTMENT = /\s+((?:apt|app|appt|apartment|appartement|whg|wohnung|we|zi|zimmer)\b\.?\s*\S+)$/i;
// Город/земля/страна, которые Flink дописывает после индекса («…, 01069 Dresden, Dresden») — в заметки не нужны.
const NOISE = new Set(['dresden', 'дрезден', '드레스덴', 'sachsen', 'saxony', 'саксония', 'deutschland', 'germany', 'германия']);

// Текст состоит только из названий города/земли/страны (через запятую) — в заметке он не нужен.
export function isNoise(text, city = '') {
  const parts = (text || '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => NOISE.has(p) || p === city.toLowerCase());
}

// Возвращает { street, house, zip, city, extra } — пустые строки, если чего-то нет.
export function parseAddress(text) {
  const out = { street: '', house: '', zip: '', city: '', extra: '' };
  const raw = (text || '').replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (!raw) return out;

  let rest = raw;
  const zc = raw.match(ZIP_CITY);
  if (zc) {
    out.zip = zc[1];
    out.city = zc[2].replace(/[,.\s]+$/, '').trim();
    rest = (raw.slice(0, zc.index) + ' , ' + raw.slice(zc.index + zc[0].length)).trim();
  }

  const parts = rest.split(',').map((p) => p.trim()).filter(Boolean);
  const extras = [];
  for (let p of parts) {
    if (!out.street) {
      const apt = p.match(APARTMENT);
      const before = apt ? p.slice(0, apt.index).replace(/\s*[/,–-]\s*$/, '') : '';
      if (apt && STREET_HOUSE.test(before)) {
        extras.push(apt[1]);
        p = before;
      }
      const m = p.match(STREET_HOUSE);
      if (m && /[A-Za-zÄÖÜäöüß]/.test(m[1])) {
        out.street = m[1].trim().replace(/[,.]$/, '');
        out.house = m[2].replace(/\s+/g, '');
        continue;
      }
    }
    if (!isNoise(p, out.city)) extras.push(p);
  }
  if (!out.street && extras.length) out.street = extras.shift();
  out.extra = extras.join(', ');
  return out;
}

export function formatAddress(a) {
  const line1 = [a.street, a.house].filter(Boolean).join(' ');
  const line2 = [a.zip, a.city].filter(Boolean).join(' ');
  return [line1, line2].filter(Boolean).join(', ');
}

// Запрос для внешнего навигатора (geo:-ссылка).
export function geoQuery(a) {
  return formatAddress({ ...a, city: a.city || 'Dresden' });
}

// Совпадает ли адрес с поисковым текстом (по улице+дому, в любом написании).
export function matches(a, query) {
  // Проверяем и «свёрнутую» форму (str), и полную — чтобы работал недонабранный «Stra…».
  const q = norm(query);
  if (!q) return true;
  const hay = norm(a.street) + norm(a.house) + norm(a.zip);
  const hayFull = norm(a.street, false) + norm(a.house) + norm(a.zip);
  return hay.includes(q) || hayFull.includes(norm(query, false));
}
