// ===== 人ごとの記録の控え（IndexedDB。docs は S/b78/acct/DESIGN-FINAL.md §1.2・§1.3） =====
// DB spelldash-areas の 4 つの入れ物:
//   areas      … 使っていない人の記録。1 人 1 件 { area, id, keys, savedAt, schema, sum }。期限なし・自動で消さない
//   legacy     … 移行の前の旧い記録（spelldash_* の人の記録の全部）。1 件 { id, savedAt, fromSchema, keys, sum }。期限なし・自動で消さない
//   orphans    … 移行の後に旧コードのタブが旧い鍵へ書いた値の写し { id, savedAt, keys, sum }。期限なし・読まない・移し直さない
//   prerestore … 復元の前の今の記録の写し（js/backup.js が使う）。期限なし
// keys は元の名前（spelldash_<名前>）から値への表。書くときは durability strict で書き、新しいトランザクションで読み直して鍵ごとに比べる。
// 写しを消すのは、利用者の明示の確認があるときだけ（今は消す口を作らない）。
// js/areaSwitch.js（切り替えの画面）と、E2E・単体（scripts/test-areas.mjs のメモリーの IndexedDB）が読む。import は無い。

export const DB_NAME = "spelldash-areas";
export const DB_VERSION = 1;
export const STORES = Object.freeze({ areas: "area", legacy: "id", orphans: "id", prerestore: "id" });

// 控えを使えないときの例外。code: open（開けない）・quota（容量）・write（書けない）・verify（読み直しが合わない）・read（読めない）
export class AreaStoreError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "AreaStoreError";
    this.code = code;
    this.cause = cause;
  }
}

export function isQuotaError(error) {
  return error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED" || error?.code === 22 || error?.code === 1014 || error?.code === "quota";
}

// 鍵ごとの値の要約（FNV-1a 32 を鍵の順に。字数も持つ）。中身を比べる代わりではなく、写しが壊れていないかの目印
export function sumOf(keys) {
  let h = 0x811c9dc5;
  let n = 0;
  const feed = (text) => {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    n += text.length;
  };
  for (const name of Object.keys(keys ?? {}).sort()) {
    feed(name);
    feed("\u0000");
    feed(String(keys[name]));
    feed("\u0001");
  }
  return `${n}:${h.toString(16).padStart(8, "0")}`;
}

// 2 つの鍵の表が同じか（鍵の集まりと、鍵ごとの値の字が同じ）
export function sameKeys(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false;
  return true;
}

function classify(error, fallback) {
  if (error instanceof AreaStoreError) return error;
  if (isQuotaError(error)) return new AreaStoreError("quota", "この端末の保存の空きが足りない。", error);
  return new AreaStoreError(fallback, "記録の控えを書けなかった。", error);
}

// 開く。無い・開けないときは AreaStoreError("open")
export function openAreaStore(idb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!idb || typeof idb.open !== "function") {
      reject(new AreaStoreError("open", "記録の控えの置き場（IndexedDB）が使えない。"));
      return;
    }
    let request;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(new AreaStoreError("open", "記録の控えの置き場（IndexedDB）を開けない。", error));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, keyPath] of Object.entries(STORES)) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
    };
    request.onsuccess = () => resolve(wrap(request.result));
    request.onerror = () => reject(new AreaStoreError("open", "記録の控えの置き場（IndexedDB）を開けない。", request.error));
  });
}

function wrap(db) {
  const write = (store, record) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(classify(error, "write"));
      };
      let tx;
      try {
        tx = db.transaction(store, "readwrite", { durability: "strict" });
        const request = tx.objectStore(store).put(record);
        request.onerror = () => fail(request.error);
      } catch (error) {
        fail(error);
        try {
          tx?.abort();
        } catch {
          // もう終わったトランザクション
        }
        return;
      }
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tx.onabort = () => fail(tx.error);
      tx.onerror = () => fail(tx.error);
    });
  const read = (store, key) =>
    new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(store, "readonly");
        const request = tx.objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new AreaStoreError("read", "記録の控えを読めなかった。", request.error));
      } catch (error) {
        reject(new AreaStoreError("read", "記録の控えを読めなかった。", error));
      }
    });
  return {
    put: write,
    get: read,
    // 書いて、新しいトランザクションで読み直して比べる（鍵の集まり・鍵ごとの値・id・要約）。合わなければ AreaStoreError("verify")
    async putVerified(store, record) {
      await write(store, record);
      let back;
      try {
        back = await read(store, record[STORES[store]]);
      } catch (error) {
        throw new AreaStoreError("verify", "記録の控えを読み直せなかった。", error);
      }
      if (!back || back.id !== record.id || back.sum !== record.sum || !sameKeys(back.keys, record.keys) || sumOf(back.keys) !== record.sum) {
        throw new AreaStoreError("verify", "記録の控えを読み直すと中身が合わなかった。");
      }
      return back;
    },
    close() {
      try {
        db.close();
      } catch {
        // 閉じられなくても続ける
      }
    }
  };
}

// 永続の保存を頼む（初めて控えを書くとき）。断られても分ける（DESIGN-FINAL §7 (f)）。答えは true・false
export async function askPersist(storage = globalThis.navigator?.storage) {
  try {
    if (!storage || typeof storage.persist !== "function") return false;
    if (typeof storage.persisted === "function" && (await storage.persisted())) return true;
    return Boolean(await storage.persist());
  } catch {
    return false;
  }
}
