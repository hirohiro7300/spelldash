// 保存先（IndexedDB・localStorage の代わり）をそのまま読み書きする道具と、Web Locks の代わり。
// 薄い形の保存の道（tests/unit/thinPaths.test.ts）が使う（persistence.test.ts の物と同じ作り）
import type { memoryKV } from "../../../src/persist/persistence";

/** 保存先をそのまま開く（Persistence が作った後に。版は今のまま） */
export function rawOpen(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => resolve(r.result);
  });
}

export type RawStore = "kv" | "backupMeta" | "backupData";

/** 値をそのまま置く（key が無ければ keyPath の物） */
export async function rawPut(name: string, store: RawStore, value: unknown, key?: string): Promise<void> {
  const db = await rawOpen(name);
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(store, "readwrite");
      if (key === undefined) t.objectStore(store).put(value);
      else t.objectStore(store).put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

/** 保存先の 1 つの値をそのまま読む */
export async function rawGet(name: string, store: RawStore, key: string): Promise<unknown> {
  const db = await rawOpen(name);
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(store, "readonly").objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

/** 保存先のその入れ物の値を全部読む */
export async function rawAll(name: string, store: RawStore): Promise<unknown[]> {
  const db = await rawOpen(name);
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(store, "readonly").objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result as unknown[]);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

/** 保存先の中身をまるごと文字にする（何も書き換えていないことを、そのままの値で確かめる） */
export async function rawDump(name: string, stores: RawStore[] = ["kv", "backupMeta", "backupData"]): Promise<string> {
  const db = await rawOpen(name);
  const out: Record<string, unknown> = {};
  try {
    for (const store of stores) {
      out[store] = await new Promise((resolve, reject) => {
        const t = db.transaction(store, "readonly");
        const keys = t.objectStore(store).getAllKeys();
        const vals = t.objectStore(store).getAll();
        t.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
        t.onerror = () => reject(t.error);
      });
    }
  } finally {
    db.close();
  }
  return JSON.stringify(out);
}

/** 小さな保存先（localStorage の代わり）の中身をまるごと文字にする */
export const kvDump = (kv: ReturnType<typeof memoryKV>): string => JSON.stringify([...kv.data].sort(([a], [b]) => a.localeCompare(b)));

/** Web Locks の代わり（ifAvailable と steal だけを扱う。hold: 答えを止めておく） */
export function fakeLocks(init: { deny?: boolean; hold?: boolean } = {}) {
  const ctl = { deny: false, hold: false, ...init };
  let holder: ((err: unknown) => void) | null = null;
  const waiting: Array<() => void> = [];
  const request = (name: string, options: LockOptions, cb: (lock: Lock | null) => unknown): Promise<unknown> => {
    if (ctl.deny) return Promise.reject(new DOMException("The request was denied.", "SecurityError"));
    return new Promise((resolve, reject) => {
      const answer = () => {
        if (holder && !options.steal) {
          void Promise.resolve(cb(null)).then(resolve, reject);
          return;
        }
        holder?.(new DOMException("The lock request is aborted.", "AbortError"));
        const mine = reject;
        holder = mine;
        const free = () => {
          if (holder === mine) holder = null;
        };
        void Promise.resolve(cb({ name, mode: "exclusive" } as Lock)).then(
          (v) => (free(), resolve(v)),
          (e) => (free(), reject(e)),
        );
      };
      if (ctl.hold) waiting.push(answer);
      else setTimeout(answer);
    });
  };
  return { ctl, locks: { request } as unknown as LockManager, release: () => waiting.splice(0).forEach((f) => f()), held: () => holder !== null };
}
