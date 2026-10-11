// Локальное хранилище (IndexedDB): адреса с заметками и журнал поездок. Ничего не уходит с устройства.

const DB_NAME = 'flink-helper';
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('addresses')) {
          const store = db.createObjectStore('addresses', { keyPath: 'id' });
          store.createIndex('key', 'key', { unique: false });
        }
        // v2: журнал поездок для статистики
        if (!db.objectStoreNames.contains('trips')) db.createObjectStore('trips', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        // Другая вкладка обновляет базу — освобождаем её, чтобы обновление не зависло.
        req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const result = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const table = (name) => ({
  getAll: () => tx(name, 'readonly', (s) => s.getAll()),
  get: (id) => tx(name, 'readonly', (s) => s.get(id)),
  put: (item) => tx(name, 'readwrite', (s) => s.put(item)),
  remove: (id) => tx(name, 'readwrite', (s) => s.delete(id)),
  clear: () => tx(name, 'readwrite', (s) => s.clear()),
  putMany: (items) => tx(name, 'readwrite', (s) => { items.forEach((i) => s.put(i)); }),
});

// Адреса — основная таблица, её функции доступны напрямую: db.getAll(), db.put() …
export const { getAll, get, put, remove, clear, putMany } = table('addresses');
export const trips = table('trips');

// Полное удаление базы вместе со структурой (для кнопки «Удалить все данные»).
export async function destroy() {
  if (dbPromise) {
    (await dbPromise).close();
    dbPromise = null;
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
