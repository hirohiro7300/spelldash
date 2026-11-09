// IndexedDB の小さな手助け（Promise にするだけ）

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB の要求に失敗しました"));
  });
}

/** トランザクションが完了（commit）するまで待つ。中止されたら reject */
export function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error ?? new DOMException("トランザクションが中止されました", "AbortError"));
    t.onerror = () => reject(t.error ?? new Error("トランザクションに失敗しました"));
  });
}

export function openDb(name: string, version: number, upgrade: (db: IDBDatabase, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(name, version);
    } catch (e) {
      reject(e);
      return;
    }
    r.onupgradeneeded = (ev) => upgrade(r.result, ev.oldVersion);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB を開けません"));
    r.onblocked = () => reject(new Error("IndexedDB が別のタブにふさがれています"));
  });
}
