// Собирает свои профили BRouter из стандартных: скачивает fastbike/trekking с brouter.de
// и вносит одну правку (см. шапку в profiles/flink-*.brf).
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

const header = (name) => `# Flink Helper: профиль BRouter «${name}» с одной правкой.
# Источник: https://brouter.de/brouter/profiles2/${name}.brf (BRouter, лицензия MIT).
# Правка — в accesspenalty: участок с bicycle=use_sidepath («езжай по велодорожке рядом»)
# считается проезжим с небольшим штрафом 0.3, а не закрытым. Иначе там, где сама велодорожка
# не нанесена на карту OSM, маршрут делает объезд (пример: St. Petersburger Straße у Pirnaischer Platz).
# Обновить: node tools/build-profiles.mjs
#
`;

mkdirSync(new URL('../profiles/', import.meta.url), { recursive: true });
for (const [name, [from, to]] of Object.entries(PATCHES)) {
  const res = await fetch(`https://brouter.de/brouter/profiles2/${name}.brf`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  const text = (await res.text()).replace(/\r\n/g, '\n');
  if (!text.includes(from)) throw new Error(`${name}: стандартный профиль изменился, правку нужно пересмотреть`);
  writeFileSync(new URL(`../profiles/flink-${name}.brf`, import.meta.url), header(name) + text.replace(from, to));
  console.log(`profiles/flink-${name}.brf`);
}
