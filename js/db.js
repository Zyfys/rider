// Локальное хранилище адресов (IndexedDB). Ничего не уходит с устройства.

const DB_NAME = 'flink-helper';
const DB_VERSION = 1;
const STORE = 'addresses';

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('key', 'key', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const getAll = () => tx('readonly', (s) => s.getAll());
export const get = (id) => tx('readonly', (s) => s.get(id));
export const put = (item) => tx('readwrite', (s) => s.put(item));
export const remove = (id) => tx('readwrite', (s) => s.delete(id));
export const clear = () => tx('readwrite', (s) => s.clear());

export const putMany = (items) => tx('readwrite', (s) => { items.forEach((i) => s.put(i)); });

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
