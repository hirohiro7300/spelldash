// 旧いコードのタブの localStorage の書き込みを、書いたその時にタブの中で記録する（init script）と、新しいコードのタブから IndexedDB の orphans を読む口。
// 分離の入った木の見張り（js/areaGuard.js）は、移行の後に旧いコードのタブが旧い場所（spelldash_*）へ書いた人の記録を、storage の知らせで数ミリ秒のうちに
// orphans へ写して localStorage から消す。だから「旧い画面で答えた」を、答えた後に localStorage に残った語の記録では確かめられない（§15）。
// ここでは旧いコードのタブの中の Storage.prototype.setItem・removeItem・clear を、ページのスクリプトより前に包み、旧い場所の鍵への書き込みを
// 鍵・大きさ・値の要約（digest）・語の記録の変わった語（回数と最後に答えた時刻）として、出した口（exposeBinding）で検査へ知らせる。
// 旧いコードの振る舞いは変えない: 元の口をそのままの this と引数で呼び、その戻り値を返し、投げた物はそのまま投げる。記録の側の失敗は全部ここで飲み込む。
// 包むのは配信の前に始まった文書（旧い木）だけ。配信の後に始まる文書（新しいコード）には、検査が足す init script（disarmStorageTap）が包みを外す
// （init script の順番は決まっていないので、どちらが先でも外れる形）。
export const WORD_KEY = "spelldash_word_stats"; // 旧い本番の語の記録の鍵（0507672 の js/storage.js の STORAGE_KEY）
export const OLD_PREFIX = "spelldash_"; // 旧い場所の鍵
export const TAP_BINDING = "__oldtabStorageWrite";
export const ORPHANS = { db: "spelldash-areas", store: "orphans" }; // 分離の入った木の js/areaStore.js の DB_NAME と orphans の置き場

// ページの中で動く（外の変数を使わない）。arg: { wordKey, prefix, binding }
export function installStorageTap({ wordKey, prefix, binding }) {
  try {
    if (window.top !== window) return;
    if (window.__oldtabTapOff === true || window.__oldtabTap) return;
    let ls = null;
    try {
      ls = window.localStorage;
    } catch {
      ls = null;
    }
    const P = window.Storage && window.Storage.prototype;
    if (!ls || !P) return;
    const nativeGet = P.getItem;
    const nativeSet = P.setItem;
    const nativeRemove = P.removeItem;
    const nativeClear = P.clear;
    if (typeof nativeGet !== "function" || typeof nativeSet !== "function" || typeof nativeRemove !== "function" || typeof nativeClear !== "function") return;
    const jsonParse = JSON.parse;
    const jsonStringify = JSON.stringify;
    const now = Date.now;
    const fnv = (s) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return ("0000000" + h.toString(16)).slice(-8);
    };
    const state = { n: 0, sent: 0, failed: 0 };
    const docId = () => {
      try {
        return window.__oldtabDocId ?? null;
      } catch {
        return null;
      }
    };
    const send = (rec) => {
      try {
        const f = window[binding];
        if (typeof f !== "function") {
          state.failed++;
          return;
        }
        const p = f(rec);
        state.sent++;
        if (p && typeof p.then === "function") p.then(undefined, () => {});
      } catch {
        state.failed++;
      }
    };
    // 語の記録の前と後を比べ、変わった語（新しく足された語も）の回数と最後に答えた時刻を出す
    const wordDiff = (prevRaw, nextRaw) => {
      const out = { changed: {}, removed: 0, entries: null, parseError: null };
      let next = null;
      let prev = null;
      try {
        next = jsonParse(nextRaw);
      } catch (e) {
        out.parseError = "next";
      }
      try {
        prev = prevRaw ? jsonParse(prevRaw) : {};
      } catch (e) {
        prev = {};
        out.parseError = out.parseError ?? "prev";
      }
      if (!next || typeof next !== "object") return out;
      if (!prev || typeof prev !== "object") prev = {};
      const ids = Object.keys(next);
      out.entries = ids.length;
      for (const id of ids) {
        const b = next[id];
        const a = prev[id];
        let same = false;
        try {
          same = a !== undefined && jsonStringify(a) === jsonStringify(b);
        } catch {
          same = false;
        }
        if (same) continue;
        out.changed[id] = {
          playCount: b && typeof b === "object" ? b.playCount ?? null : null,
          correctCount: b && typeof b === "object" ? b.correctCount ?? null : null,
          recallFail: b && typeof b === "object" ? b.recallFail ?? null : null,
          lastPlayed: b && typeof b === "object" ? b.lastPlayed ?? null : null,
          isNew: a === undefined,
          // 書く前の同じ語の値（このタブが読んで足した元。差 = この書き込みで増えた分。A へ取り込む量の確かめに使う）
          prev: a && typeof a === "object" ? { playCount: a.playCount ?? null, correctCount: a.correctCount ?? null, recallFail: a.recallFail ?? null, lastPlayed: a.lastPlayed ?? null } : null
        };
      }
      for (const id of Object.keys(prev)) if (!(id in next)) out.removed++;
      return out;
    };
    const watched = (key) => typeof key === "string" && key.startsWith(prefix);
    const tapSet = function setItem(key, value) {
      let note = null;
      if (this === ls && arguments.length >= 2 && watched(key) && typeof value === "string") {
        try {
          note = { key, prev: nativeGet.call(ls, key) };
        } catch {
          note = null;
        }
      }
      const result = nativeSet.apply(this, arguments);
      if (note) {
        try {
          const rec = { op: "set", key: note.key, n: ++state.n, t: now(), docId: docId(), size: value.length, prevSize: note.prev === null ? null : note.prev.length, digest: fnv(value) };
          if (note.key === wordKey) {
            const d = wordDiff(note.prev, value);
            rec.changed = d.changed;
            rec.removed = d.removed;
            rec.entries = d.entries;
            rec.parseError = d.parseError;
            rec.changedDigest = fnv(jsonStringify(d.changed));
          }
          send(rec);
        } catch {
          // 記録できなくても、旧いコードの書き込みは済んでいる
        }
      }
      return result;
    };
    const tapRemove = function removeItem(key) {
      let note = null;
      if (this === ls && arguments.length >= 1 && watched(key)) {
        try {
          note = { key, prev: nativeGet.call(ls, key) };
        } catch {
          note = null;
        }
      }
      const result = nativeRemove.apply(this, arguments);
      if (note && note.prev !== null) {
        try {
          send({ op: "remove", key: note.key, n: ++state.n, t: now(), docId: docId(), size: null, prevSize: note.prev.length, digest: null });
        } catch {
          // 同じ
        }
      }
      return result;
    };
    const tapClear = function clear() {
      const mine = this === ls;
      const result = nativeClear.apply(this, arguments);
      if (mine) {
        try {
          send({ op: "clear", key: null, n: ++state.n, t: now(), docId: docId(), size: null, prevSize: null, digest: null });
        } catch {
          // 同じ
        }
      }
      return result;
    };
    P.setItem = tapSet;
    P.removeItem = tapRemove;
    P.clear = tapClear;
    // 配信の後に始まった文書（新しいコード）では、検査の init script がこれを呼んで元の口に戻す（ページのスクリプトより前）
    const restore = () => {
      try {
        if (P.setItem === tapSet) P.setItem = nativeSet;
        if (P.removeItem === tapRemove) P.removeItem = nativeRemove;
        if (P.clear === tapClear) P.clear = nativeClear;
      } catch {
        // 戻せなくても包みは元の口を呼ぶだけ
      }
    };
    Object.defineProperty(window, "__oldtabTap", { value: { state, restore }, configurable: true, enumerable: false, writable: false });
    // 包んだことを知らせる（この文書で記録が取れていることの印。文書の印はほかの init script が置くので、それが済んだ後に読む）
    // （外された文書（配信の後の新しいコード）では知らせない）
    setTimeout(() => {
      try {
        if (window.__oldtabTapOff === true) return;
      } catch {
        return;
      }
      send({ op: "install", key: null, n: 0, t: now(), docId: docId(), size: null, prevSize: null, digest: null });
    }, 0);
  } catch {
    // 包めなければ記録が無いだけ（判定は「書き込みの記録が無い」と言う）
  }
}

// 配信の後に始まる文書（新しいコード）の init script: 包みを外す（包みが先に動いていれば戻し、後なら包ませない）
export function disarmStorageTap() {
  try {
    if (window.top !== window) return;
    Object.defineProperty(window, "__oldtabTapOff", { value: true, configurable: true, enumerable: false, writable: false });
    const t = window.__oldtabTap;
    if (t && typeof t.restore === "function") t.restore();
  } catch {
    // 外せなくても包みは元の口を呼ぶだけ
  }
}

// 新しいコードのタブで IndexedDB の orphans を読む（ページの中で動く）。DB が無ければ作らない（一覧で確かめ、無い DB を開いたら upgrade を取り消す）。
// 値そのものは返さない（鍵ごとの大きさ・digest と、語の記録なら語ごとの回数）
export async function readOrphansInPage({ db: dbName, store, wordKey }) {
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  };
  const out = { at: Date.now(), dbExists: null, storeExists: false, records: [], error: null };
  try {
    if (typeof indexedDB === "undefined") {
      out.error = "indexedDB が無い";
      return out;
    }
    if (typeof indexedDB.databases === "function") {
      const list = await indexedDB.databases();
      out.dbExists = list.some((d) => d.name === dbName);
      if (!out.dbExists) return out;
    }
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onupgradeneeded = () => {
        try {
          req.transaction.abort();
        } catch {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    out.dbExists = true;
    try {
      db.onversionchange = () => db.close();
      out.storeExists = db.objectStoreNames.contains(store);
      if (!out.storeExists) return out;
      const all = await new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const r = tx.objectStore(store).getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const rec of all) {
        const keys = {};
        for (const [k, v] of Object.entries(rec?.keys ?? {})) {
          const s = typeof v === "string" ? v : v === null || v === undefined ? null : JSON.stringify(v);
          const e = { size: s === null ? null : s.length, digest: s === null ? null : fnv(s) };
          if (k === wordKey && s) {
            try {
              const j = JSON.parse(s);
              e.words = Object.fromEntries(Object.entries(j ?? {}).map(([id, b]) => [id, { playCount: b?.playCount ?? null, correctCount: b?.correctCount ?? null, recallFail: b?.recallFail ?? null, lastPlayed: b?.lastPlayed ?? null }]));
            } catch {
              e.words = null;
            }
          }
          keys[k] = e;
        }
        out.records.push({ id: String(rec?.id ?? ""), savedAt: rec?.savedAt ?? null, area: rec?.area ?? null, keys });
      }
    } finally {
      db.close();
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 200);
  }
  return out;
}

// ===== A へ戻る段（docs/SPEC_ACCOUNT_AREAS.md §0.3 の 1）の見張り =====
// 見張りのタブ（検査のページ lib/watch.html。アプリのコードは無い）で、ほかのタブの localStorage の書き込みの知らせ（storage イベント）を聞く。
// 書いたタブには知らせが来ないので、アプリのタブとは別のタブで聞く。人ごとの領域の鍵（sd2.<領域>.<名前>）と端末の印（sd2.index など）の変わり目を、
// 書いたその時に検査へ知らせる。値は語の記録（語ごとの回数・最後に答えた時刻・3 状態の欄）と送る語の印（語の id の並び）だけを要約し、
// 端末の印は短い物だけそのまま。アプリのページには何も足さない（見張りのタブの中だけ）
export const WATCH_BINDING = "__oldtabAreaWrite";
export const AREA_WORD_NAME = "word_stats"; // sd2.<領域>.word_stats（js/storage.js の spelldash_word_stats）
export const AREA_DIRTY_NAME = "dirty_words"; // sd2.<領域>.dirty_words（js/sync.js の送る語の印 spelldash_dirty_words）

export function installAreaWatch({ binding, wordName, dirtyName }) {
  if (window.__oldtabAreaWatch) return "既に聞いている";
  window.__oldtabAreaWatch = true;
  const AREA_RE = /^sd2\.(guest|u:[^.#\s]+)\.(.+)$/;
  const words = (raw) => {
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== "object") return null;
      const out = {};
      for (const [id, b] of Object.entries(j)) {
        if (!b || typeof b !== "object") continue;
        out[id] = { playCount: b.playCount ?? null, correctCount: b.correctCount ?? null, recallFail: b.recallFail ?? null, lastPlayed: b.lastPlayed ?? null, ls: b.ls ?? null, lsd: b.lsd ?? null, lsAt: b.lsAt ?? null, lsf: b.lsf ?? null, mastered: b.mastered ?? null };
      }
      return out;
    } catch {
      return "parse-error";
    }
  };
  window.addEventListener("storage", (e) => {
    try {
      if (e.storageArea !== window.localStorage) return;
      const send = (rec) => {
        const p = window[binding]?.(rec);
        if (p && typeof p.then === "function") p.then(undefined, () => {});
      };
      if (e.key === null) return send({ t: Date.now(), key: null, op: "clear" });
      if (!e.key.startsWith("sd2.")) return;
      const m = AREA_RE.exec(e.key);
      const rec = { t: Date.now(), key: e.key, area: m ? m[1] : null, name: m ? m[2] : null, op: e.newValue === null ? "remove" : "set", size: e.newValue === null ? null : e.newValue.length };
      if (m && m[2] === wordName && e.newValue !== null) rec.words = words(e.newValue);
      if (m && m[2] === dirtyName && e.newValue !== null) {
        try {
          rec.dirty = JSON.parse(e.newValue);
        } catch {
          rec.dirty = "parse-error";
        }
      }
      if (!m && e.newValue !== null && e.newValue.length <= 4000) rec.value = e.newValue;
      send(rec);
    } catch {
      // 聞けなかった知らせは記録に無いだけ
    }
  });
  return "聞き始めた";
}

// 見張りのタブで、端末の印（sd2.area・sd2.index・sd2.migrated）と、localStorage にある領域の語の記録・送る語の印、IndexedDB の areas（使っていない人の控え）を読む。
// DB が無ければ作らない。値は語ごとの要約だけ（回数・最後に答えた時刻・3 状態の欄）
export async function readAreasInPage({ db: dbName, wordName, dirtyName }) {
  const AREA_RE = /^sd2\.(guest|u:[^.#\s]+)\.(.+)$/;
  const words = (raw) => {
    if (typeof raw !== "string") return null;
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== "object") return null;
      const out = {};
      for (const [id, b] of Object.entries(j)) {
        if (!b || typeof b !== "object") continue;
        out[id] = { playCount: b.playCount ?? null, correctCount: b.correctCount ?? null, recallFail: b.recallFail ?? null, lastPlayed: b.lastPlayed ?? null, ls: b.ls ?? null, lsd: b.lsd ?? null, lsAt: b.lsAt ?? null, lsf: b.lsf ?? null, mastered: b.mastered ?? null };
      }
      return out;
    } catch {
      return "parse-error";
    }
  };
  const list = (raw) => {
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return "parse-error";
    }
  };
  const out = { at: Date.now(), marker: null, index: null, migrated: null, switching: null, ls: {}, idb: { dbExists: null, storeExists: false, records: [] }, error: null };
  try {
    const get = (k) => window.localStorage.getItem(k);
    out.marker = get("sd2.area");
    out.index = list(get("sd2.index"));
    out.migrated = list(get("sd2.migrated"));
    out.switching = get("sd2.switch");
    for (const key of Object.keys(window.localStorage)) {
      const m = AREA_RE.exec(key);
      if (!m) continue;
      const a = (out.ls[m[1]] ??= { keys: 0 });
      a.keys++;
      if (m[2] === wordName) a.words = words(get(key));
      if (m[2] === dirtyName) a.dirty = list(get(key));
    }
    if (typeof indexedDB === "undefined") throw new Error("indexedDB が無い");
    if (typeof indexedDB.databases === "function") {
      out.idb.dbExists = (await indexedDB.databases()).some((d) => d.name === dbName);
      if (!out.idb.dbExists) return out;
    }
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onupgradeneeded = () => {
        try {
          req.transaction.abort();
        } catch {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    out.idb.dbExists = true;
    try {
      db.onversionchange = () => db.close();
      out.idb.storeExists = db.objectStoreNames.contains("areas");
      if (!out.idb.storeExists) return out;
      const all = await new Promise((resolve, reject) => {
        const tx = db.transaction("areas", "readonly");
        const r = tx.objectStore("areas").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const rec of all) {
        const keys = rec?.keys ?? {};
        out.idb.records.push({ area: rec?.area ?? null, id: String(rec?.id ?? ""), savedAt: rec?.savedAt ?? null, keys: Object.keys(keys).length, words: words(keys["spelldash_" + wordName]), dirty: list(keys["spelldash_" + dirtyName]) });
      }
    } finally {
      db.close();
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 200);
  }
  return out;
}
