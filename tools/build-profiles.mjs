// Собирает свои профили BRouter из стандартных: скачивает fastbike/trekking с brouter.de
// и вносит правки (см. шапку в profiles/flink-*.brf).
//
//   node tools/build-profiles.mjs
//
// Запускать, если BRouter обновил стандартные профили. После этого увеличить PROFILE_VERSION в js/map.js.
import { writeFileSync, mkdirSync } from 'node:fs';

// [что заменить, на что] — проверка use_sidepath переносится перед остальными и получает малый штраф.
const PATCHES = {
  fastbike: [
    `assign accesspenalty
       switch bikeaccess
              0
              switch footaccess
                     5
                     switch any_cycleroute
                            15
                            switch bicycle=use_sidepath
                                   25
                                   10000
`,
    `assign accesspenalty
       switch bikeaccess
              0
              switch bicycle=use_sidepath
                     0.3
                     switch footaccess
                            5
                            switch any_cycleroute
                                   15
                                   10000
`],
  trekking: [
    `       if bikeaccess then 0
       else if footaccess then 4
       else if any_cycleroute then 15
       else if bicycle=use_sidepath then 25
       else 10000
`,
    `       if bikeaccess then 0
       else if bicycle=use_sidepath then 0.3
       else if footaccess then 4
       else if any_cycleroute then 15
       else 10000
`],
};

// Профиль «Без горок»: fastbike с той же правкой и штрафом за подъём. Подбор значений — на маршрутах
// от хаба к южной возвышенности (Kaitzer Straße, Bergstraße, Südhöhe): при 300 / 3 % в них не остаётся
// участков круче 7 %, крюк — до 1,5 км. Меньший штраф оставляет крутые участки, порог ниже 3 %
// удваивает длину маршрута ради пологих улиц.
const EASY = [
  ['assign uphillcost         = 0     #', 'assign uphillcost         = 300   #'],
  ['assign uphillcutoff       = 1.5   #', 'assign uphillcutoff       = 3     #'],
];
const EASY_NOTE = `# Вторая правка — «Без горок»: uphillcost = 300, uphillcutoff = 3. Каждый метр подъёма на уклоне
# круче 3 % стоит как 300 м пути, поэтому маршрут выбирает более пологую дорогу, даже если она длиннее.
`;

const header = (name, note = '') => `# Flink Helper: профиль BRouter «${name}» с ${note ? 'двумя правками' : 'одной правкой'}.
# Источник: https://brouter.de/brouter/profiles2/${name}.brf (BRouter, лицензия MIT).
# Правка — в accesspenalty: участок с bicycle=use_sidepath («езжай по велодорожке рядом»)
# считается проезжим с небольшим штрафом 0.3, а не закрытым. Иначе там, где сама велодорожка
# не нанесена на карту OSM, маршрут делает объезд (пример: St. Petersburger Straße у Pirnaischer Platz).
${note}# Обновить: node tools/build-profiles.mjs
#
`;

mkdirSync(new URL('../profiles/', import.meta.url), { recursive: true });
for (const [name, [from, to]] of Object.entries(PATCHES)) {
  const res = await fetch(`https://brouter.de/brouter/profiles2/${name}.brf`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  const text = (await res.text()).replace(/\r\n/g, '\n');
  if (!text.includes(from)) throw new Error(`${name}: стандартный профиль изменился, правку нужно пересмотреть`);
  const patched = text.replace(from, to);
  writeFileSync(new URL(`../profiles/flink-${name}.brf`, import.meta.url), header(name) + patched);
  console.log(`profiles/flink-${name}.brf`);
  if (name !== 'fastbike') continue;
  let easy = patched;
  for (const [a, b] of EASY) {
    if (!easy.includes(a)) throw new Error('fastbike: параметры подъёма изменились, правку «Без горок» нужно пересмотреть');
    easy = easy.replace(a, b);
  }
  writeFileSync(new URL('../profiles/flink-easy.brf', import.meta.url), header(name, EASY_NOTE) + easy);
  console.log('profiles/flink-easy.brf');
}
