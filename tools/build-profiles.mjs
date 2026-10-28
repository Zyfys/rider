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

// Правка для города в «Быстром» и «Без горок». В стандартном fastbike пешеходная зона стоит как 5 м пути
// за метр, даже если велосипед там разрешён (Prager Straße, аллеи Großer Garten), а дорожка с разрешением
// для велосипеда и покрытием «утрамбованный гравий» — как 15 м: маршрут их всегда объезжал.
// Теперь: пешеходная зона с разрешением — 1.3 (как велодорожка), без разрешения — 3 (ведёшь велосипед);
// дорожка с bicycle=yes|designated: твёрдое покрытие — 1.2, утрамбованный гравий — 1.5, остальное — 3.
// На 89 маршрутах от хаба: 75 стали короче, 4 длиннее (до +229 м), по большим улицам — 62 → 40 км.
const CITY = [
  ['  switch    highway=pedestrian                        switch hascycleway 1.3 5',
   '  switch    highway=pedestrian                        switch or hascycleway bicycle=yes|designated 1.3 3'],
  ['   switch or bicycle=designated bicycle_road=yes switch isunpaved 3 1.2',
   '   switch or bicycle=designated|yes bicycle_road=yes switch ispaved 1.2 switch surface=compacted|fine_gravel 1.5 3'],
];
const CITY_NOTE = `# Правка — пешеходные зоны и дорожки парков, где велосипед разрешён (bicycle=yes|designated), стоят почти
# как велодорожка (1.3; утрамбованный гравий — 1.5), а не 5–15. Пешеходная зона без разрешения — 3 (вести велосипед).
`;

// Профиль «Без горок»: «Быстрый» со всеми правками и штрафом за подъём. Подбор значений — на маршрутах
// от хаба к южной возвышенности (Kaitzer Straße, Bergstraße, Südhöhe): при 300 / 3 % в них не остаётся
// участков круче 7 %, крюк — до 1,5 км. Меньший штраф оставляет крутые участки, порог ниже 3 %
// удваивает длину маршрута ради пологих улиц.
const EASY = [
  ['assign uphillcost         = 0     #', 'assign uphillcost         = 300   #'],
  ['assign uphillcutoff       = 1.5   #', 'assign uphillcutoff       = 3     #'],
];
const EASY_NOTE = `# Правка «Без горок»: uphillcost = 300, uphillcutoff = 3. Каждый метр подъёма на уклоне
# круче 3 % стоит как 300 м пути, поэтому маршрут выбирает более пологую дорогу, даже если она длиннее.
`;

const header = (name, notes) => `# Flink Helper: профиль BRouter «${name}» с правками.
# Источник: https://brouter.de/brouter/profiles2/${name}.brf (BRouter, лицензия MIT).
# Правка — в accesspenalty: участок с bicycle=use_sidepath («езжай по велодорожке рядом»)
# считается проезжим с небольшим штрафом 0.3, а не закрытым. Иначе там, где сама велодорожка
# не нанесена на карту OSM, маршрут делает объезд (пример: St. Petersburger Straße у Pirnaischer Platz).
${notes.join('')}# Обновить: node tools/build-profiles.mjs
#
`;

function apply(text, pairs, what) {
  for (const [a, b] of pairs) {
    if (!text.includes(a)) throw new Error(`${what}: стандартный профиль изменился, правку нужно пересмотреть`);
    text = text.replace(a, b);
  }
  return text;
}

const write = (file, text) => {
  writeFileSync(new URL(`../profiles/${file}`, import.meta.url), text);
  console.log(`profiles/${file}`);
};

mkdirSync(new URL('../profiles/', import.meta.url), { recursive: true });
for (const [name, [from, to]] of Object.entries(PATCHES)) {
  const res = await fetch(`https://brouter.de/brouter/profiles2/${name}.brf`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  const text = apply((await res.text()).replace(/\r\n/g, '\n'), [[from, to]], name);
  if (name !== 'fastbike') { write(`flink-${name}.brf`, header(name, []) + text); continue; }
  const city = apply(text, CITY, 'fastbike (город)');
  write('flink-fastbike.brf', header(name, [CITY_NOTE]) + city);
  write('flink-easy.brf', header(name, [CITY_NOTE, EASY_NOTE]) + apply(city, EASY, 'fastbike (подъёмы)'));
}
