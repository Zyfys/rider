// Статистика по журналу поездок. Чистые функции — проверяются тестами.
// Поездка: { id, ts, kind: 'address' | 'hub', street, house, zip, length (м), time (с), arrivedAt }.
import { norm } from './address.js';

// Почтовые индексы зоны доставки → район (для подписи).
export const DISTRICTS = {
  '01067': 'Altstadt / Friedrichstadt',
  '01069': 'Altstadt / Seevorstadt',
  '01097': 'Innere Neustadt',
  '01099': 'Äußere Neustadt',
  '01127': 'Pieschen',
  '01157': 'Cotta / Leutewitz',
  '01159': 'Löbtau',
  '01169': 'Gorbitz',
  '01187': 'Südvorstadt / Plauen',
  '01189': 'Plauen / Coschütz',
  '01217': 'Räcknitz / Zschertnitz',
  '01219': 'Strehlen',
  '01237': 'Reick',
  '01277': 'Striesen / Gruna',
  '01307': 'Johannstadt',
  '01309': 'Striesen / Blasewitz',
};

const km = (list) => list.reduce((sum, t) => sum + (t.length || 0), 0) / 1000;

function top(list, keyFn, labelFn, limit = 10) {
  const groups = new Map();
  for (const t of list) {
    const key = keyFn(t);
    if (!key) continue;
    const g = groups.get(key) || { label: '', count: 0, km: 0 };
    if (labelFn(t).length > g.label.length) g.label = labelFn(t); // «Oederaner Straße», а не «Oederaner Str»
    g.count++;
    g.km += (t.length || 0) / 1000;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.km - a.km).slice(0, limit);
}

export function computeStats(trips, now = Date.now()) {
  const deliveries = trips.filter((t) => t.kind !== 'hub');
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const DAY = 86400000;
  // В периоде: доставки считаем отдельно, километры — вместе с возвращениями в хаб.
  const period = (from) => ({
    deliveries: deliveries.filter((t) => t.ts >= from).length,
    km: km(trips.filter((t) => t.ts >= from)),
  });

  const withLength = deliveries.filter((t) => t.length > 0);
  const byHour = Array(24).fill(0);
  for (const t of deliveries) byHour[new Date(t.ts).getHours()]++;
  const busiest = Math.max(...byHour) > 0 ? byHour.indexOf(Math.max(...byHour)) : null;

  return {
    today: period(dayStart.getTime()),
    week: period(dayStart.getTime() - 6 * DAY),
    month: period(dayStart.getTime() - 29 * DAY),
    all: period(0),
    avgKm: withLength.length ? km(withLength) / withLength.length : 0,
    busiestHour: busiest,
    topAddresses: top(deliveries, (t) => `${norm(t.street)}|${norm(t.house)}`, (t) => `${t.street} ${t.house}`),
    topStreets: top(deliveries, (t) => norm(t.street), (t) => t.street),
    topDistricts: top(deliveries, (t) => t.zip, (t) => (DISTRICTS[t.zip] ? `${DISTRICTS[t.zip]} (${t.zip})` : t.zip), 8),
    recent: [...trips].sort((a, b) => b.ts - a.ts).slice(0, 10),
  };
}
