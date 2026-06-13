// 用 IndexedDB 存放原始文件（如 EPUB），供「原版渲染」反复读取。
// localStorage 存不下大文件，故元数据走 localStorage、原始文件走这里。

const DB_NAME = "readtaylor";
const STORE = "files";
const VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = fn(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export function putFile(id: string, blob: Blob): Promise<unknown> {
  return tx("readwrite", (s) => s.put(blob, id));
}

export async function getFile(id: string): Promise<Blob | undefined> {
  try {
    const v = await tx<Blob>("readonly", (s) => s.get(id));
    return v || undefined;
  } catch {
    return undefined;
  }
}

export function delFile(id: string): Promise<unknown> {
  return tx("readwrite", (s) => s.delete(id)).catch(() => undefined);
}
