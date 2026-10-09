import { getNativePreferences } from './preferences';
import { isValidOfflineCopy, type OfflineCopy } from './copyLimits';
export type { OfflineCopy } from './copyLimits';
const MAX_COPIES = 3;
let writes = Promise.resolve();
const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open('pichamber-native-offline', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('copies', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('Offline storage is unavailable'));
});
const transaction = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('copies', mode);
    const request = operation(tx.objectStore('copies'));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(new Error('Offline storage could not be updated')); };
  });
};
export const readOfflineCopies = async (): Promise<OfflineCopy[]> => {
  if (!getNativePreferences().offlineCache) return [];
  const copies: unknown[] = await transaction('readonly', (store) => store.getAll());
  return copies.filter(isValidOfflineCopy).sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_COPIES);
};
export const saveOfflineCopy = (copy: OfflineCopy): Promise<void> => {
  const task = writes.catch(() => undefined).then(async () => {
    if (!getNativePreferences().offlineCache) throw new Error('Offline copies are disabled.');
    if (!isValidOfflineCopy(copy)) throw new Error('This copy is too large. Save a shorter loaded transcript.');
    await transaction('readwrite', (store) => store.put(copy));
    // Evict within the same database transaction so no concurrent writer can grow the cache.
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('copies', 'readwrite');
      const store = tx.objectStore('copies');
      const request = store.getAll();
      request.onsuccess = () => {
        const all = (request.result as OfflineCopy[]).sort((a, b) => b.savedAt - a.savedAt);
        all.slice(MAX_COPIES).forEach((item) => store.delete(item.id));
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error('Offline cache cleanup failed')); };
    });
  });
  writes = task;
  return task;
};
export const clearOfflineCopies = (): Promise<void> => {
  const task = writes.catch(() => undefined).then(async () => { await transaction('readwrite', (store) => store.clear()); });
  writes = task;
  return task;
};
