// Минималистичный тёмный стиль: только дома с номерами, дороги, велодорожки,
// пешеходные зоны, трамвайные пути и линия маршрута. Никаких POI, магазинов и значков.
// Данные: OpenFreeMap (схема OpenMapTiles) © участники OpenStreetMap.

export const COLORS = {
  bg: '#0e1013',
  water: '#10263a',
  building: '#252a31',
  buildingLine: '#343a43',
  road: '#434953',
  roadMajor: '#59606b',
  path: '#3a4049',
  cycle: '#3ddc84',
  pedestrian: '#ff6464',
  tram: '#ffc53d',
  label: '#c9ced6',
  number: '#eef0f3',
  route: '#56c8ff',
  routeCasing: '#04141d',
};

const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];

const LINE = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];
const POLY = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];

const MAJOR = ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false];
const MINOR = ['match', ['get', 'class'], ['tertiary', 'minor', 'service', 'track'], true, false];

// Велодорожка: highway=cycleway или путь/тротуар с разрешением для велосипеда.
const CYCLE = ['any',
  ['==', ['get', 'subclass'], 'cycleway'],
  ['all', ['==', ['get', 'class'], 'path'], ['match', ['get', 'bicycle'], ['designated', 'yes'], true, false]],
];
const FOOT_ONLY = ['all', ['==', ['get', 'class'], 'path'], ['!', CYCLE]];

const width = (base) => ['interpolate', ['exponential', 1.6], ['zoom'], 12, base * 0.5, 15, base * 2, 18, base * 8];

export function buildStyle() {
  return {
    version: 8,
    name: 'flink-helper-dark',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> · маршруты <a href="https://brouter.de" target="_blank">BRouter</a>',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': COLORS.bg } },
      { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': COLORS.water } },

      // Пешеходные зоны (Prager Straße, Altmarkt, Hauptstraße) — полупрозрачная красная заливка.
      { id: 'ped-area', type: 'fill', source: 'osm', 'source-layer': 'transportation',
        filter: ['all', POLY, ['==', ['get', 'subclass'], 'pedestrian']],
        paint: { 'fill-color': COLORS.pedestrian, 'fill-opacity': 0.16 } },
      { id: 'ped-area-line', type: 'line', source: 'osm', 'source-layer': 'transportation',
        filter: ['all', POLY, ['==', ['get', 'subclass'], 'pedestrian']],
        paint: { 'line-color': COLORS.pedestrian, 'line-opacity': 0.6, 'line-width': 1.5, 'line-dasharray': [2, 2] } },

      { id: 'building', type: 'fill', source: 'osm', 'source-layer': 'building', minzoom: 14,
        paint: { 'fill-color': COLORS.building, 'fill-outline-color': COLORS.buildingLine } },

      { id: 'footway', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 15,
        filter: ['all', LINE, FOOT_ONLY, ['!=', ['get', 'subclass'], 'pedestrian']],
        paint: { 'line-color': COLORS.path, 'line-width': width(0.5), 'line-dasharray': [2, 1.5] } },
      { id: 'ped-line', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 14,
        filter: ['all', LINE, FOOT_ONLY, ['==', ['get', 'subclass'], 'pedestrian']],
        paint: { 'line-color': COLORS.pedestrian, 'line-opacity': 0.55, 'line-width': width(0.9) } },

      { id: 'road-minor', type: 'line', source: 'osm', 'source-layer': 'transportation',
        filter: ['all', LINE, MINOR],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': COLORS.road, 'line-width': width(1.2) } },
      { id: 'road-major', type: 'line', source: 'osm', 'source-layer': 'transportation',
        filter: ['all', LINE, MAJOR],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': COLORS.roadMajor, 'line-width': width(2) } },

      { id: 'cycleway', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 12,
        filter: ['all', LINE, CYCLE],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': COLORS.cycle, 'line-width': width(0.9) } },

      { id: 'tram', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 13,
        filter: ['all', LINE, ['==', ['get', 'subclass'], 'tram']],
        paint: { 'line-color': COLORS.tram, 'line-opacity': 0.8, 'line-width': 1.5, 'line-dasharray': [3, 2] } },

      // Стрелки одностороннего движения.
      { id: 'oneway', type: 'symbol', source: 'osm', 'source-layer': 'transportation', minzoom: 16,
        filter: ['all', LINE, ['==', ['get', 'oneway'], 1], ['any', MAJOR, MINOR]],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'text-field': '→', 'text-font': FONT_BOLD, 'text-size': 16, 'text-keep-upright': false, 'text-rotation-alignment': 'map' },
        paint: { 'text-color': '#8a929e' } },

      { id: 'street-name', type: 'symbol', source: 'osm', 'source-layer': 'transportation_name', minzoom: 14,
        filter: ['!=', ['get', 'class'], 'path'],
        layout: { 'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name_de'], ['get', 'name']], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 14, 12, 18, 16], 'text-max-angle': 30 },
        paint: { 'text-color': COLORS.label, 'text-halo-color': COLORS.bg, 'text-halo-width': 2 } },

      { id: 'housenumber', type: 'symbol', source: 'osm', 'source-layer': 'housenumber', minzoom: 16,
        layout: { 'text-field': ['get', 'housenumber'], 'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 16, 11, 19, 16], 'text-padding': 1 },
        paint: { 'text-color': COLORS.number, 'text-halo-color': COLORS.bg, 'text-halo-width': 1.5 } },
    ],
  };
}

// Слои поверх карты: маршрут, точка назначения, моя позиция.
export function addOverlayLayers(map) {
  const empty = { type: 'FeatureCollection', features: [] };
  map.addSource('route', { type: 'geojson', data: empty });
  map.addSource('dest', { type: 'geojson', data: empty });
  map.addSource('me', { type: 'geojson', data: empty });

  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': COLORS.routeCasing, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 7, 18, 16] } }, 'street-name');
  map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': COLORS.route, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 4, 18, 10] } }, 'street-name');

  map.addLayer({ id: 'dest-halo', type: 'circle', source: 'dest', paint: { 'circle-radius': 18, 'circle-color': COLORS.route, 'circle-opacity': 0.25 } });
  map.addLayer({ id: 'dest', type: 'circle', source: 'dest',
    paint: { 'circle-radius': 9, 'circle-color': ['case', ['get', 'approx'], COLORS.tram, COLORS.route], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });

  map.addLayer({ id: 'me', type: 'circle', source: 'me',
    paint: { 'circle-radius': 9, 'circle-color': '#2f80ff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
}
