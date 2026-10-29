// 人ごとの保存の領域（ゲスト・アカウント A・アカウント B）の単体テスト。ブラウザなし（数秒）:
//   node scripts/test-areas.mjs [<木の根>] [--no-mutate]
// 仕様は S/b78/acct/DESIGN-FINAL.md（版 2）の §1・§2・§3・§4・§8（docs は統合の段で docs/SPEC_ACCOUNT_AREAS.md に移す）。
// 見張り js/areaGuard.js（classic script）は、偽の window（vm の文脈）で読む。js/areaSwitch.js・js/areaStore.js は、偽の localStorage・
// メモリーの IndexedDB・偽の Web Locks を渡して流す。この段（内部の 1）の検査:
//   U1 鍵の分け方と、localStorage の使い方の全数（getItem・setItem・removeItem のほかに名前が出る所をファイルごとに固定・?. と window／self／globalThis／top・
//      名前の文字列・別名の先をたどって clear・key・length・プロパティ・[ ] を使わない）・storage イベント・全ページの頭に見張り（戻り先は # の後ろ）・
//      切り替えの画面とその部品の先読み・部品が読めないときの復旧の画面・認証の部品に渡すセッションの置き場（満杯でもメモリーに置かない）
//   U2 包んだ口の読み替え・書くたびの確かめ（領域・swap の段・セッションの人）・storage イベントの作り直し・頭で止める・戻ったタブの確かめ直し・
//      自分の確かめ・使えないブラウザ・切り替えの画面の戻り先（同じ origin のパスだけ）・sessionStorage（同じ Storage の型）のタブの印は読み替えない
//   U3 移行の 5 通りと 2 回流し・legacy の写し・旧い本体が localStorage に残らない・落ちた点からの続き・移行の途中の旧タブの書き込み（orphans）・
//      容量のぎりぎり（移した後の形が入るなら 1 回で終わる・入らなければ書き出しは legacy）・移行の途中の書き出し・新しい鍵の読み直し・persist() を頼む
//   U4 切り替えの各点で落としたときの直し（どちらかが全部そろう・古い写しを戻さない）・drain の待ち・落ちた後のやり直しも失敗（満杯・写しが無い・
//      控えが開けない）しても元は localStorage にそろう・書き出しは index が idb を指す領域の残りを読まない・切り替えの前の片付けが写せなければ止める・
//      展開した記録の読み直し・片付けの消す直前の読み直し
//   U6 展開の途中で localStorage が満杯 → 切り替え先は IndexedDB・元は失わない・印は替わらない・戻す書き込みの取り消しは前からあった鍵（遅れた値）を消さない
//   U9 の一部（変異）: 見張りと切り替えの手順を 1 つずつ壊すと、どれかが落ちる（--no-mutate で飛ばす）
// 失敗が 1 つでもあれば終了コード 1。
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import { isDeepStrictEqual } from "util";
import { fileURLToPath, pathToFileURL } from "url";

const ARGS = process.argv.slice(2);
const ROOT = path.resolve(ARGS.find((a) => !a.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const MUTATE = !ARGS.includes("--no-mutate");
const QUIET = ARGS.includes("--quiet");

// ===== 結果 =====
let passed = 0;
let failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond, detail = "") => eq(detail ? `${name}（${detail}）` : name, !!cond, true);

// ===== 偽物 =====
const quotaError = () => {
  const error = new Error("quota");
  error.name = "QuotaExceededError";
  return error;
};
// localStorage の中身（タブの間で共有する）: 鍵と値の字数の合計に上限（Chromium と同じ数え方）
class Backing {
  constructor(seed = {}, limit = Infinity) {
    this.map = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
    this.limit = limit;
  }
  size(except = null) {
    let n = 0;
    for (const [k, v] of this.map) if (k !== except) n += k.length + v.length;
    return n;
  }
  get(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  set(k, v) {
    const value = String(v);
    if (this.size(k) + k.length + value.length > this.limit) throw quotaError();
    this.map.set(k, value);
  }
  remove(k) {
    this.map.delete(k);
  }
  keys() {
    return [...this.map.keys()];
  }
  dump() {
    return Object.fromEntries([...this.map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}
// タブごとの Storage の型（見張りは prototype を包むので、タブごとに作る）
function storageClass(backingOf) {
  return class Storage {
    getItem(k) {
      return backingOf(this).get(String(k));
    }
    setItem(k, v) {
      backingOf(this).set(String(k), v);
    }
    removeItem(k) {
      backingOf(this).remove(String(k));
    }
    key(i) {
      return backingOf(this).keys()[i] ?? null;
    }
    clear() {
      for (const k of backingOf(this).keys()) backingOf(this).remove(k);
    }
    get length() {
      return backingOf(this).keys().length;
    }
  };
}
// 生の口（切り替えの手順に渡す）
const rawOf = (backing) => ({ get: (k) => backing.get(k), set: (k, v) => backing.set(k, v), remove: (k) => backing.remove(k), keys: () => backing.keys() });

// 偽の Web Locks（1 つのプロセスの中の全部のタブで共有）
class FakeLocks {
  constructor() {
    this.held = [];
    this.waiting = [];
  }
  hold(name, mode = "shared") {
    const lock = { name, mode, clientId: "other" };
    this.held.push(lock);
    return () => {
      this.held = this.held.filter((l) => l !== lock);
      this.pump();
    };
  }
  canTake(name, mode) {
    const same = this.held.filter((l) => l.name === name);
    return mode === "shared" ? same.every((l) => l.mode === "shared") : same.length === 0;
  }
  request(name, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    const mode = opts?.mode ?? "exclusive";
    return new Promise((resolve, reject) => {
      const run = () => {
        const lock = { name, mode, clientId: "self" };
        this.held.push(lock);
        Promise.resolve()
          .then(() => cb(lock))
          .then(
            (v) => {
              this.held = this.held.filter((l) => l !== lock);
              this.pump();
              resolve(v);
            },
            (e) => {
              this.held = this.held.filter((l) => l !== lock);
              this.pump();
              reject(e);
            }
          );
      };
      if (this.canTake(name, mode)) run();
      else if (opts?.ifAvailable) Promise.resolve().then(() => cb(null)).then(resolve, reject);
      else this.waiting.push({ name, mode, run });
    });
  }
  pump() {
    for (const w of [...this.waiting]) {
      if (this.canTake(w.name, w.mode)) {
        this.waiting.splice(this.waiting.indexOf(w), 1);
        w.run();
      }
    }
  }
  async query() {
    return { held: this.held.map((l) => ({ ...l })), pending: this.waiting.map((w) => ({ name: w.name, mode: w.mode })) };
  }
}

// 次の番（タイマーの 1ms の切り上げを避ける。順は登録の順）
const tick = (fn) => setImmediate(fn);
// メモリーの IndexedDB（js/areaStore.js が使う所だけ: open・upgrade・transaction・put・get・durability）。
// 書き込みはトランザクションの終わりにまとめて入る（途中で失敗したら何も入らない）。失敗の差し込み: failOpen・failPut(store, value)・corruptRead(store, value)
class FakeIDB {
  constructor() {
    this.dbs = new Map();
    this.failOpen = null;
    this.failPut = null;
    this.corruptRead = null;
    this.durabilities = [];
  }
  open(name, version) {
    const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    tick(() => {
      if (this.failOpen) {
        req.error = this.failOpen;
        req.onerror?.({ target: req });
        return;
      }
      let db = this.dbs.get(name);
      if (!db) {
        db = { version: 0, stores: new Map() };
        this.dbs.set(name, db);
      }
      req.result = new FakeDB(this, db);
      if (db.version < version) {
        db.version = version;
        req.onupgradeneeded?.({ target: req });
      }
      req.onsuccess?.({ target: req });
    });
    return req;
  }
  // 中を直に見る（検査用）
  peek(store, key) {
    const s = this.dbs.get("spelldash-areas")?.stores.get(store);
    return s ? structuredClone(s.data.get(key)) : undefined;
  }
  all(store) {
    const s = this.dbs.get("spelldash-areas")?.stores.get(store);
    return s ? [...s.data.values()].map((v) => structuredClone(v)) : [];
  }
  poke(store, value) {
    const s = this.dbs.get("spelldash-areas").stores.get(store);
    s.data.set(value[s.keyPath], structuredClone(value));
  }
}
class FakeDB {
  constructor(factory, db) {
    this.factory = factory;
    this.db = db;
    this.objectStoreNames = { contains: (n) => db.stores.has(n) };
  }
  createObjectStore(name, { keyPath }) {
    this.db.stores.set(name, { keyPath, data: new Map() });
  }
  transaction(names, mode, opts) {
    return new FakeTx(this, mode, opts);
  }
  close() {
    this.closed = true;
  }
}
class FakeTx {
  constructor(conn, mode, opts) {
    this.conn = conn;
    this.mode = mode;
    this.pending = 0;
    this.staged = [];
    this.aborted = false;
    this.error = null;
    this.oncomplete = this.onerror = this.onabort = null;
    if (mode === "readwrite") conn.factory.durabilities.push(opts?.durability ?? "default");
    tick(() => this.maybeCommit());
  }
  objectStore(name) {
    const store = this.conn.db.stores.get(name);
    if (!store) throw Object.assign(new Error("no store " + name), { name: "NotFoundError" });
    const factory = this.conn.factory;
    return {
      put: (value) =>
        this.request(() => {
          const fault = factory.failPut?.(name, value);
          if (fault) throw fault;
          this.staged.push([store, value[store.keyPath], structuredClone(value)]);
          return value[store.keyPath];
        }),
      get: (key) =>
        this.request(() => {
          const value = store.data.has(key) ? structuredClone(store.data.get(key)) : undefined;
          return value !== undefined && factory.corruptRead ? factory.corruptRead(name, value) ?? value : value;
        }),
      getAll: () => this.request(() => [...store.data.values()].map((v) => structuredClone(v)))
    };
  }
  request(fn) {
    const r = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending++;
    tick(() => {
      if (this.aborted) return;
      try {
        r.result = fn();
        r.onsuccess?.({ target: r });
      } catch (e) {
        r.error = e;
        r.onerror?.({ target: r });
        this.abort(e);
        return;
      }
      this.pending--;
      tick(() => this.maybeCommit());
    });
    return r;
  }
  maybeCommit() {
    if (this.aborted || this.pending > 0 || this.done) return;
    this.done = true;
    for (const [store, key, value] of this.staged) store.data.set(key, value);
    this.oncomplete?.({ target: this });
  }
  abort(e) {
    if (this.aborted || this.done) return;
    this.aborted = true;
    this.error = e ?? null;
    tick(() => {
      this.onerror?.({ target: this });
      this.onabort?.({ target: this });
    });
  }
}

// ===== 読み込み =====
let guardSrc = fs.readFileSync(path.join(ROOT, "js/areaGuard.js"), "utf8");
let SW = await import(pathToFileURL(path.join(ROOT, "js/areaSwitch.js")).href);
let ST = await import(pathToFileURL(path.join(ROOT, "js/areaStore.js")).href);

// 見張りを 1 つのタブとして読む。返り値は偽の window（ctx）と、記録した動き
const OLD_AUTH = "sb-sujvgwozsnzjsjmkcrnk-auth-token";
const session = (id) => JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: 9999999999, user: { id, email: `${id}@example.com` } });
class FakeStorageEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    Object.assign(this, { key: init.key ?? null, oldValue: init.oldValue ?? null, newValue: init.newValue ?? null, url: init.url ?? "", storageArea: init.storageArea ?? null });
  }
}
function openTab(backing, { path: pagePath = "/index.html", search = "", locks = new FakeLocks(), idb = true, noLocks = false, session: ss = null, freezeProto = false, shadowSetItem = false, storageThrows = false, attrs = {} } = {}) {
  // 本物のブラウザと同じく、localStorage と sessionStorage は同じ Storage の型（同じ prototype）で、中身だけが別。
  // 見張りは prototype を包むので、sessionStorage も包んだ口を通る（「this が localStorage のときだけ読み替える」を確かめるため）
  const ssBacking = ss ?? new Backing();
  let ssInst = null;
  const Storage = storageClass((self) => (ssInst !== null && self === ssInst ? ssBacking : backing));
  const target = new EventTarget();
  const log = { replaced: [], stopped: 0, idle: [], timers: [], blobs: [] };
  const elements = [];
  const makeEl = (tag) => {
    const el = { tag, children: [], attrs: {}, dataset: {}, textContent: "", id: "", handlers: {}, setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; }, addEventListener(type, fn) { this.handlers[type] = fn; }, remove() {}, click() {} };
    elements.push(el);
    return el;
  };
  const docTarget = new EventTarget();
  const document = {
    currentScript: Object.keys(attrs).length ? { hasAttribute: (n) => n in attrs } : null,
    documentElement: makeEl("html"),
    body: makeEl("body"),
    visibilityState: "visible",
    createElement: makeEl,
    addEventListener: (...a) => docTarget.addEventListener(...a),
    dispatchEvent: (e) => docTarget.dispatchEvent(e)
  };
  const ctx = {
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, Error, Promise, Set, Map, Symbol, RegExp, URL, Uint8Array,
    encodeURIComponent, decodeURIComponent, DOMException, Event, structuredClone, Blob, TextEncoder, crypto: globalThis.crypto,
    setTimeout: (fn, ms) => log.timers.push([fn, ms]),
    requestIdleCallback: (fn) => log.idle.push(fn),
    queueMicrotask,
    StorageEvent: FakeStorageEvent,
    Storage,
    location: { origin: "https://www.spelldash.net", pathname: pagePath, search, hash: "", href: "https://www.spelldash.net" + pagePath + search, replace: (u) => log.replaced.push(u) },
    stop: () => log.stopped++,
    navigator: noLocks ? {} : { locks },
    document,
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
    dispatchEvent: (e) => target.dispatchEvent(e)
  };
  if (idb) ctx.indexedDB = { open() {} };
  const ls = new Storage();
  if (shadowSetItem) Object.defineProperty(ls, "setItem", { value: function (k, v) { backing.set(k, v); } });
  if (storageThrows) Object.defineProperty(ctx, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  else ctx.localStorage = ls;
  ssInst = new Storage();
  ctx.sessionStorage = ssInst;
  if (freezeProto) Object.freeze(Storage.prototype);
  // 「記録を書き出す」のファイル（Blob）を控える
  ctx.URL = class extends URL {
    static createObjectURL(blob) {
      log.blobs.push(blob);
      return "blob:test";
    }
    static revokeObjectURL() {}
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  let threw = null;
  try {
    vm.runInContext(guardSrc, ctx, { filename: "areaGuard.js" });
  } catch (e) {
    threw = e;
  }
  // ほかのタブからの知らせ（物理の鍵の storage イベント）を届ける
  const fire = (key, oldValue, newValue) => ctx.dispatchEvent(new FakeStorageEvent("storage", { key, oldValue, newValue, storageArea: storageThrows ? null : ls }));
  const heard = [];
  ctx.addEventListener("storage", (e) => heard.push([e.key, e.oldValue, e.newValue]));
  const tryWrite = (key, value) => {
    try {
      ctx.localStorage.setItem(key, value);
      return "ok";
    } catch (e) {
      return e.name;
    }
  };
  return { ctx, ls: storageThrows ? null : ls, log, threw, fire, heard, tryWrite, elements, ssBacking, locks };
}
const keysOf = (ctx) => ctx.SpellDashAreaKeys;
// 移行の済んだ端末の印（ゲストの領域 gen）
const migratedMarks = (area = "guest", gen = 1, index = null) => ({ "sd2.area": `${area}#${gen}`, "sd2.index": JSON.stringify(index ?? { [area]: { at: "ls", lastUsedAt: "2026-10-01T00:00:00.000Z" } }), "sd2.migrated": JSON.stringify({ at: "2026-10-01T00:00:00.000Z", fromSchema: "7", legacyId: "L0" }) });

// ===== 記録の種（3 状態・最高到達ランク・回の続き・送信待ちを含む） =====
const WS = (tag) => JSON.stringify({ apple: { playCount: 3, correctCount: 3, ls: 2, lsd: 20300, lsAt: 1780000000000, history: [1, 1, 1], tag }, bread: { playCount: 2, correctCount: 1, ls: 1, lsd: 20301, tag } });
const personSeed = (tag) => ({
  spelldash_schema_version: "7",
  spelldash_word_stats: WS(tag),
  spelldash_rank_peak: tag === "A" ? "3" : "1",
  spelldash_learn_session: JSON.stringify({ kind: "new", at: 5, tag }),
  spelldash_dirty_words: JSON.stringify(["apple", "bread"]),
  spelldash_xp: tag === "A" ? "1200" : "40",
  spelldash_owner: undefined
});
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// 切り替えの手順を偽物で作る
let seq = 0; // 写しの id（タブをまたいで重ならない）
function switcher(backing, { idb = new FakeIDB(), locks = new FakeLocks(), crashAt = null, onRemove = null, onSleep = null } = {}) {
  let t = Date.parse("2026-10-29T00:00:00Z");
  let ops = 0;
  let dead = false;
  const base = rawOf(backing);
  const raw = onRemove ? { ...base, remove: (k) => { base.remove(k); onRemove(k); } } : base;
  const ls = crashAt === null ? raw : {
    get: raw.get,
    keys: raw.keys,
    set: (k, v) => {
      if (dead) throw new Error("crashed");
      if (++ops === crashAt) {
        dead = true;
        throw Object.assign(new Error("crashed"), { crash: true });
      }
      raw.set(k, v);
    },
    remove: (k) => {
      if (dead) throw new Error("crashed");
      if (++ops === crashAt) {
        dead = true;
        throw Object.assign(new Error("crashed"), { crash: true });
      }
      raw.remove(k);
    }
  };
  const K = loadKeys();
  const sw = SW.createSwitcher({
    ls,
    keys: K,
    openStore: () => ST.openAreaStore(idb),
    locks,
    now: () => (t += 7),
    newId: () => `id${++seq}`,
    sleep: async (ms) => {
      t += ms ?? 100;
      await onSleep?.(ms);
    },
    persist: async () => true
  });
  return { sw, idb, locks, ops: () => ops, dead: () => dead };
}
// 鍵の決まり（見張りを data-switch で読んだときの SpellDashAreaKeys）
function loadKeys() {
  const tab = openTab(new Backing(), { path: "/switch.html" });
  return tab.ctx.SpellDashAreaKeys;
}
const settle = async (backing, opts = {}) => {
  const s = switcher(backing, opts);
  try {
    return { result: await s.sw.settle(), ...s };
  } catch (error) {
    return { error, ...s };
  }
};
// 領域の記録（元の名前）
const areaRecords = (backing, area) => {
  const prefix = `sd2.${area}.`;
  return Object.fromEntries(backing.keys().filter((k) => k.startsWith(prefix)).sort().map((k) => ["spelldash_" + k.slice(prefix.length), backing.get(k)]));
};
const rawPersonKeys = (backing) => backing.keys().filter((k) => loadKeys().isPersonKey(k));
// 復旧の画面の「記録を書き出す」と同じ物（控えは渡したメモリーの IndexedDB）。書き出せなければ例外を返す
const exportOf = async (backing, idb) => {
  try {
    return await SW.exportRecords(rawOf(backing), loadKeys(), { openStore: () => ST.openAreaStore(idb), digest: globalThis.crypto.subtle });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};
const personOf = (data) => (data ? Object.fromEntries(Object.entries(data).filter(([k]) => loadKeys().isPersonKey(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : null);
const sortedRec = (o) => (o ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : o);
// 書き出しに入れない鍵（js/backup.js の EXCLUDE と同じ。持ち主の鍵・同期の印・送信待ち・ログアウトの時刻・端末の開き方の好み）
const EXPORT_DROP = (() => {
  const text = fs.readFileSync(path.join(ROOT, "js/backup.js"), "utf8");
  const m = text.match(/const EXCLUDE = new Set\(\[([^\]]*)\]\)/);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
})();
const exportable = (rec) => sortedRec(Object.fromEntries(Object.entries(rec ?? {}).filter(([k]) => !EXPORT_DROP.includes(k))));
const isCrash = (e) => Boolean(e && (e.crash || e.message === "crashed" || isCrash(e.cause)));

// js/supabase.js が認証の部品に渡すセッションの置き場（§2 の (3)・§4）。部品の既定は、localStorage への試し書きが入らない端末（満杯）では
// メモリーに置く。そうなると見張りが見る sd2.auth と部品のセッションの人が食い違い、ほかの人のリンクで入っても切り替えの画面へ移らない（反証）。
// 偽の部品（createClient の引数を控える）を差し込み口 window.__SUPABASE_MODULE_URL で読ませ、渡された口を偽の localStorage で確かめる。1 回だけ流す
let authStorageResult = null;
function authStorageProbe() {
  authStorageResult ??= (async () => {
    const calls = [];
    const fake = { failSet: null, denied: false, value: "SAVED" };
    const fakeLs = {
      getItem: (k) => (calls.push(["get", k]), k === "sd2.auth" ? fake.value : null),
      setItem: (k, v) => {
        calls.push(["set", k, v]);
        if (fake.failSet) throw fake.failSet;
        if (k === "sd2.auth") fake.value = v;
      },
      removeItem: (k) => calls.push(["remove", k])
    };
    const lib = `export function createClient(url, key, opts) { globalThis.__sdAuthOpts = opts ?? null; return { auth: { getSession: async () => ({ data: { session: null }, error: null }) }, from() { return {}; } }; }`;
    const saved = { window: Object.getOwnPropertyDescriptor(globalThis, "window"), ls: Object.getOwnPropertyDescriptor(globalThis, "localStorage") };
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { __SUPABASE_MODULE_URL: "data:text/javascript," + encodeURIComponent(lib) } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { if (fake.denied) throw new DOMException("denied", "SecurityError"); return fakeLs; } });
    try {
      const mod = await import(pathToFileURL(path.join(ROOT, "js/supabase.js")).href);
      await mod.supabase.auth.getSession();
      const opts = globalThis.__sdAuthOpts;
      const st = opts?.auth?.storage;
      if (!st || typeof st.getItem !== "function" || typeof st.setItem !== "function" || typeof st.removeItem !== "function") return { storageKey: opts?.auth?.storageKey ?? null, storage: false };
      await st.setItem("sd2.auth", "B-SESSION");
      const wrote = calls.some((c) => c[0] === "set" && c[1] === "sd2.auth" && c[2] === "B-SESSION");
      const read = await st.getItem("sd2.auth");
      fake.failSet = quotaError();
      let failed = null;
      try {
        await st.setItem("sd2.auth", "C-SESSION");
      } catch (e) {
        failed = e.name;
      }
      fake.failSet = null;
      const afterFail = await st.getItem("sd2.auth"); // 書けなかった値をメモリーに置かない（読むのはいつも localStorage）
      await st.removeItem("sd2.auth");
      const removed = calls.some((c) => c[0] === "remove" && c[1] === "sd2.auth");
      fake.denied = true;
      let deniedRead;
      try {
        deniedRead = await st.getItem("sd2.auth");
      } catch (e) {
        deniedRead = "throws " + e.name;
      }
      return { storageKey: opts.auth.storageKey, storage: true, wrote, read, failed, afterFail, removed, deniedRead };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    } finally {
      if (saved.window) Object.defineProperty(globalThis, "window", saved.window);
      else delete globalThis.window;
      if (saved.ls) Object.defineProperty(globalThis, "localStorage", saved.ls);
      else delete globalThis.localStorage;
      delete globalThis.__sdAuthOpts;
    }
  })();
  return authStorageResult;
}

// =====================================================================
async function runAll() {
  // ── U1 鍵の分け方と使い方の形 ─────────────────────────────
  {
    const K = loadKeys();
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) files.push(p);
      }
    };
    walk(path.join(ROOT, "js"));
    const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html")).map((f) => path.join(ROOT, f));
    const packPages = fs.existsSync(path.join(ROOT, "packs")) ? fs.readdirSync(path.join(ROOT, "packs")).filter((f) => f.endsWith(".html")).map((f) => path.join(ROOT, "packs", f)) : [];
    const appFiles = [...files, ...pages, path.join(ROOT, "sw.js")];
    const src = Object.fromEntries(appFiles.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, "utf8")]));
    // 鍵の一覧（コードに出る spelldash_ の鍵）
    const found = new Set();
    for (const text of Object.values(src)) for (const m of text.matchAll(/["'`](spelldash_[a-z0-9_]+)/g)) found.add(m[1]);
    const TAB_FLAGS = ["spelldash_synced_this_session", "spelldash_pulled_this_session", "spelldash_sync_done_this_session", "spelldash_pull_started_at", "spelldash_login_return", "spelldash_funnel_missing"];
    const PERSON = ["activity", "battle", "best_by_category", "best_score", "book_pace", "category", "course", "daily", "daily_set", "dirty_words", "display_name", "feedback_queue", "first_sight", "genre", "growth_log", "key_miss", "learn_filled", "learn_session", "level_boost", "level_boost_note", "login_nudge", "logout_at", "mastery_meta", "memory_check", "memory_words", "memory_words_corrupt", "mission", "mode", "my_words", "owner", "packs", "pending_battles", "placement", "placement_note", "plan", "rank_peak", "retention", "schema_version", "session", "session_log", "set_size", "sets_total", "shelf", "streak", "study_mix", "study_time", "tutorial", "typing_game", "typing_practice", "typing_stats", "user_items_dirty", "user_items_meta", "veteran", "week_goal", "word_ai", "word_notes", "word_stats", "word_stats_corrupt", "xp", "xp_synced", "xp_write"].map((n) => "spelldash_" + n);
    const classes = { device: [], test: [], tab: [], person: [], probe: [] };
    for (const key of [...found].sort()) {
      if (key === K.PROBE_KEY) classes.probe.push(key);
      else if (TAB_FLAGS.includes(key)) classes.tab.push(key);
      else if (key.startsWith("spelldash_test_")) classes.test.push(key);
      else if (K.isDeviceKey(key)) classes.device.push(key);
      else classes.person.push(key);
    }
    eq("U1 人の記録の鍵は 61 個で、一覧のとおり（後から足した鍵も人ごと。足したら一覧を直す）", classes.person, PERSON);
    eq("U1 端末の鍵は端末の設定 13 と端末の計測 10（コードに出る物は全部が一覧にある）", [K.DEVICE_NAMES.length, classes.device.length], [23, 23]);
    ok("U1 人の記録の判定: 端末の鍵・spelldash_test_・spelldash_ で始まらない鍵は人の記録でない", !K.isPersonKey("spelldash_theme") && !K.isPersonKey("spelldash_test_session") && !K.isPersonKey("sd2.guest.word_stats") && !K.isPersonKey("sb-x-auth-token") && K.isPersonKey("spelldash_word_stats") && K.isPersonKey("spelldash_new_key_later"));
    ok("U1 書き出しに入れない鍵（見張りの EXPORT_EXCLUDE。復旧の画面・使えないブラウザの書き出し）は js/backup.js の EXCLUDE と同じ（持ち主の鍵・同期の印を含む）", EXPORT_DROP.includes("spelldash_owner") && isDeepStrictEqual([...(K.EXPORT_EXCLUDE ?? [])].sort(), [...EXPORT_DROP].sort()), JSON.stringify(K.EXPORT_EXCLUDE ?? null));
    ok("U1 印・認証の新しい鍵は spelldash_ で始まらない（旧コードの消去が触れない）", [K.AREA_KEY, K.INDEX_KEY, K.MIGRATED_KEY, K.MIGRATING_KEY, K.SWITCH_KEY, K.AUTH_KEY].every((k) => !k.startsWith("spelldash_")));
    // 認証の新しい鍵は js/supabase.js の storageKey と同じ・部品の版は固定
    const supa = fs.readFileSync(path.join(ROOT, "js/supabase.js"), "utf8");
    ok("U1 js/supabase.js の storageKey は見張りの鍵と同じ・旧い鍵と違う", supa.includes(`AUTH_STORAGE_KEY = "${K.AUTH_KEY}"`) && /storageKey:\s*AUTH_STORAGE_KEY/.test(supa) && K.AUTH_KEY !== K.OLD_AUTH_KEY);
    ok("U1 js/supabase.js は認証の部品の版を固定する（@2 のような幅のある版を使わない）", /supabase-js@\d+\.\d+\.\d+"/.test(supa) && !/supabase-js@2"/.test(supa));
    ok("U1 旧い認証の鍵は js/supabase.js の URL の ref から作る既定の名前", supa.includes(K.OLD_AUTH_KEY.replace(/^sb-/, "").replace(/-auth-token$/, "")));
    eq("U1 js/supabase.js は認証の部品にセッションの置き場を渡す（満杯でもメモリーに置かない）: 書くのも読むのも localStorage（見張りの包んだ口）を通す・書けなければ例外で、その値を覚えない・消すのも localStorage・localStorage を読めない端末では保存されたセッションは無い",
      await authStorageProbe(),
      { storageKey: K.AUTH_KEY, storage: true, wrote: true, read: "B-SESSION", failed: "QuotaExceededError", afterFail: "B-SESSION", removed: true, deniedRead: null });
    // 使い方の形（コメントを除く。?. の形と、window・self・globalThis・top・parent・frames を前に付けた形も見る）
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/<!--[\s\S]*?-->/g, "");
    // html は script の中身と on… の属性だけ（本文の文の「localStorage」は使い方でない）
    const codeOf = (rel, text) => {
      if (!rel.endsWith(".html")) return strip(text);
      const parts = [];
      for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) parts.push(m[1]);
      for (const m of text.matchAll(/\son[a-z]+\s*=\s*"([^"]*)"/gi)) parts.push(m[1]);
      return strip(parts.join("\n;\n"));
    };
    const code = Object.fromEntries(Object.entries(src).map(([f, t]) => [f, codeOf(f, t)]));
    for (const p of packPages) code[path.relative(ROOT, p)] = codeOf(p, fs.readFileSync(p, "utf8"));
    const G = String.raw`(?:(?:window|self|globalThis|top|parent|frames)\s*\??\.\s*)?`;
    const hits = (re, allow = []) => Object.entries(code).filter(([f, t]) => !allow.includes(f) && re.test(t)).map(([f]) => f);
    eq("U1 clear() を使わない（localStorage・sessionStorage。?. の形も）", hits(new RegExp(String.raw`\b(localStorage|sessionStorage)\s*\??\.\s*clear\s*\(`)), []);
    eq("U1 key()・length は見張り・切り替えの画面・バックアップの見張りの無い所（Node の単体）だけ", hits(/\blocalStorage\s*\??\.\s*(key\s*\(|length\b)/, ["js/areaGuard.js", "js/areaSwitch.js", "js/backup.js"]), []);
    eq("U1 プロパティの形（localStorage.foo）を使わない", hits(/\blocalStorage\s*\??\.\s*(?!getItem\b|setItem\b|removeItem\b|key\b|length\b)[A-Za-z_$]/), []);
    eq("U1 localStorage[\"foo\"]・localStorage?.[\"foo\"] の形を使わない", hits(/\blocalStorage\s*(?:\?\.)?\s*\[/), []);
    eq("U1 window[\"localStorage\"] のように名前の文字列で取らない", hits(/["'`]localStorage["'`]/), []);
    eq("U1 Object.keys(localStorage)・for…in・展開・JSON.stringify(localStorage) を使わない（self.・top. なども）", hits(new RegExp(String.raw`Object\.(keys|entries|values|assign|getOwnPropertyNames)\(\s*${G}localStorage\b|\bin\s+${G}localStorage\b|\.\.\.\s*${G}localStorage\b|JSON\.stringify\(\s*${G}localStorage\b`)), []);
    // 全数: localStorage という名前が getItem・setItem・removeItem を呼ぶ形のほかで出る所（前の語・前に付いた物・後ろ）を、ファイルごとに固定する。
    // 新しい形（別名・引数で渡す・返す・比べる・?.[ ]・名前の文字列）を足すと、ここが落ちる。足すときは、その先も領域の口（読み替える 3 つ）だけかを確かめて一覧を直す
    const lsForms = (t) => {
      const out = [];
      for (const m of t.matchAll(/(?<![\w$])localStorage(?![\w$])/g)) {
        const post = t.slice(m.index + 12, m.index + 60);
        if (/^\s*(?:\?\.|\.)\s*(?:getItem|setItem|removeItem)\s*\(/.test(post)) continue;
        const pre = t.slice(Math.max(0, m.index - 60), m.index);
        const obj = pre.match(/([A-Za-z_$][\w$]*\s*(?:\?\.|\.)\s*)$/)?.[1] ?? "";
        const rest = pre.slice(0, pre.length - obj.length);
        const before = rest.match(/(?:[A-Za-z_$][\w$]*\s*\(\s*|[A-Za-z_$][\w$]*\s*=\s*|return\s+|[!=]==?\s*|[<>]=?\s*|[(,:?[]\s*|&&\s*|\|\|\s*|\.\.\.\s*|typeof\s+|in\s+|of\s+)$/)?.[0] ?? rest.slice(-1);
        const after = post.match(/^(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*\s*\(?|\s*(?:\?\.)?\s*\[|\s*[,;)\]}:]|\s*$)/)?.[0] ?? post.slice(0, 1);
        out.push(`${before.replace(/\s+/g, "")}|${obj.replace(/\s+/g, "")}localStorage|${after.replace(/\s+/g, "")}`);
      }
      return out;
    };
    const forms = Object.fromEntries(Object.entries(code).map(([f, t]) => [f, lsForms(t)]).filter(([, l]) => l.length > 0).sort(([a], [b]) => (a < b ? -1 : 1)));
    eq("U1 localStorage を値として使う所（別名・既定の引数・引数で渡す・返す・比べる・key・length）は一覧のとおり（全ファイル・packs も）", forms, {
      "index.html": ["s=|localStorage|,"],
      "js/accountEmblem.js": ["storageValue(|localStorage|,"],
      "js/areaGuard.js": ["ls=|root.localStorage|;"],
      "js/areaSwitch.js": ["webStorage=|globalThis.localStorage|;"],
      "js/backup.js": ["<|localStorage|.length", "push(|localStorage|.key("],
      "js/rank.js": ["storage=|globalThis.localStorage|)", "storage=|globalThis.localStorage|)"],
      "js/storage.js": ["!==|localStorage|)"],
      "js/typingKeys.js": ["return|window.localStorage|;"]
    });
    // 別名の先: 上の所で localStorage を受けた名前（const X = …・既定の引数・引数で受けた関数の仮引数・返す関数の呼び出し F()）と、そこから代入・引数で
    // 渡った名前を、全ファイルでたどる。その名前では getItem・setItem・removeItem のほか（clear・key・length・プロパティ・[ ]）を使わない
    // （切り替えの画面の生の口 js/areaSwitch.js だけ key・length も。見張り js/areaGuard.js は包む本人なので除く）
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const jsFiles = Object.keys(code).filter((f) => f.endsWith(".js"));
    const splitArgs = (t, open) => {
      const args = [];
      let depth = 0;
      let cur = "";
      for (let i = open + 1; i < t.length; i++) {
        const c = t[i];
        if ("([{".includes(c)) depth++;
        if (")]}".includes(c)) {
          if (depth === 0) {
            args.push(cur.trim());
            return args;
          }
          depth--;
        }
        if (c === "," && depth === 0) {
          args.push(cur.trim());
          cur = "";
        } else cur += c;
      }
      return args;
    };
    const paramsOf = (fn) => {
      for (const f of jsFiles) {
        const m = code[f].match(new RegExp(String.raw`function\s+${esc(fn)}\s*\(([^)]*)\)`));
        if (m) return { file: f, params: m[1].split(",").map((p) => p.trim().split("=")[0].trim()) };
      }
      return null;
    };
    const aliases = new Set(); // "file\u0000name"
    const queue = [];
    const addAlias = (f, n) => {
      if (!n || f === "js/areaGuard.js" || aliases.has(f + "\u0000" + n)) return;
      aliases.add(f + "\u0000" + n);
      queue.push([f, n]);
    };
    for (const [f, t] of Object.entries(code)) {
      for (const m of t.matchAll(new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\??\.\s*)?localStorage\b(?!\s*\??\.)`, "g"))) addAlias(f, m[1]);
      for (const m of t.matchAll(new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(\s*${G}localStorage\s*[,)]`, "g"))) {
        const def = paramsOf(m[1]);
        if (def) addAlias(def.file, def.params[0]);
      }
      for (const m of t.matchAll(new RegExp(String.raw`return\s+${G}localStorage\b(?!\s*\??\.)`, "g"))) {
        const fn = [...t.slice(0, m.index).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].pop()?.[1];
        if (!fn) continue;
        addAlias(f, fn + "()");
        for (const g of jsFiles) if (new RegExp(String.raw`import\s*\{[^}]*\b${esc(fn)}\b[^}]*\}\s*from\s*["'][^"']*${esc(path.basename(f))}["']`).test(code[g])) addAlias(g, fn + "()");
      }
    }
    while (queue.length) {
      const [f, n] = queue.shift();
      const t = code[f];
      const N = esc(n);
      for (const m of t.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[^;]*?\?\s*)?${N}\s*(?=[;:,)\n]|$)`, "g"))) addAlias(f, m[1]);
      for (const m of t.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (["if", "for", "while", "switch", "catch", "function", "return"].includes(m[1])) continue;
        const args = splitArgs(t, m.index + m[0].length - 1);
        const i = args.indexOf(n);
        if (i < 0) continue;
        const def = paramsOf(m[1]);
        if (def && def.params[i]) addAlias(def.file, def.params[i]);
      }
    }
    const aliasBad = [];
    for (const key of aliases) {
      const [f, n] = key.split("\u0000");
      const allowed = ["getItem", "setItem", "removeItem", ...(f === "js/areaSwitch.js" ? ["key", "length"] : [])];
      const N = esc(n);
      for (const m of code[f].matchAll(new RegExp(String.raw`(?<![\w$./'"\x60])${N}\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)`, "g"))) if (!allowed.includes(m[1])) aliasBad.push(`${f}: ${n}.${m[1]}`);
      for (const m of code[f].matchAll(new RegExp(String.raw`(?<![\w$./'"\x60])${N}\s*(?:\?\.)?\s*\[`, "g"))) aliasBad.push(`${f}: ${n}[`);
    }
    ok("U1 別名の先を全部たどった（index.html の s・js/rank.js・js/accountEmblem.js の storage・js/typingKeys.js の storage() とその先のタイピングの 5 ファイル・切り替えの画面の生の口）", ["index.html\u0000s", "js/rank.js\u0000storage", "js/accountEmblem.js\u0000storage", "js/typingKeys.js\u0000storage()", "js/typingPage.js\u0000store", "js/typingGamePage.js\u0000store", "js/typingLong.js\u0000storage", "js/typingDrill.js\u0000storage", "js/typingGame.js\u0000storage", "js/areaSwitch.js\u0000webStorage"].every((k) => aliases.has(k)), [...aliases].map((k) => k.replace("\u0000", ":")).join(" "));
    eq("U1 別名の先でも getItem・setItem・removeItem のほか（clear・key・length・プロパティ・[ ]）を使わない", aliasBad, []);
    // storage イベントを聞く所（見張りが元の名前に作り直して届ける）
    const listeners = Object.entries(src).filter(([, t]) => /addEventListener\(\s*["']storage["']|\bonstorage\b/.test(strip(t))).map(([f]) => f).sort();
    eq("U1 storage イベントを聞く所は一覧のとおり（見張りが元の名前の知らせを届ける）", listeners, ["js/accountEmblem.js", "js/areaGuard.js", "js/masteryMeta.js", "js/memoryWords.js", "js/statsView.js", "js/storage.js"]);
    // 全ページの頭: 見張りの 1 行が最初の script（色の 1 行より前）
    // 戻り先は URL の # の後ろ（#back=）に置く。? の後ろに置くと、ログインのリンクの戻り（#access_token=…）がサーバーへ送られ、Service Worker の保存の鍵にも残る
    const GUARD_LINE = '<script src="/js/areaGuard.js"></script><script>window.SpellDashArea||(stop(),location.replace("/switch.html#back="+encodeURIComponent(location.pathname+location.search+location.hash)))</script>';
    const firstScript = (html) => {
      const head = html.slice(0, html.indexOf("</head>"));
      const i = head.indexOf("<script");
      return i < 0 ? "" : head.slice(i, i + GUARD_LINE.length);
    };
    const appPages = [...pages.filter((p) => path.basename(p) !== "switch.html"), ...packPages];
    eq("U1 全ページ（packs も）の head の最初の script が見張りの 1 行", appPages.filter((p) => firstScript(fs.readFileSync(p, "utf8")) !== GUARD_LINE).map((p) => path.relative(ROOT, p)), []);
    const switchHtml = fs.existsSync(path.join(ROOT, "switch.html")) ? fs.readFileSync(path.join(ROOT, "switch.html"), "utf8") : "";
    ok("U1 switch.html は見張りを data-switch で読み（包まない）、js/areaSwitch.js を読む・学習の部品を読まない", switchHtml.includes('<script src="/js/areaGuard.js" data-switch></script>') && switchHtml.includes("js/areaSwitch.js") && !/js\/(game|main|storage|sync|auth)\.js/.test(switchHtml));
    const queryBack = [...appPages, ...pages, path.join(ROOT, "js/areaGuard.js"), path.join(ROOT, "js/areaSwitch.js"), path.join(ROOT, "scripts/build-pack-pages.mjs")].filter((p) => fs.existsSync(p) && /switch\.html\?back=|[?&]back=/.test(fs.readFileSync(p, "utf8"))).map((p) => path.relative(ROOT, p));
    eq("U1 切り替えの画面の戻り先を ? の後ろに置かない（見張り・頭の 1 行・packs の生成器・切り替えの画面）", [...new Set(queryBack)], []);
    const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
    const core = (sw.match(/const CORE_ASSETS = \[([\s\S]*?)\];/)?.[1] ?? "").match(/"[^"]+"/g)?.map((x) => x.slice(1, -1)) ?? [];
    const switchAssets = [...switchHtml.matchAll(/<(?:link rel="stylesheet"|script)[^>]*(?:href|src)="([^"]+)"/g)].map((m) => "/" + m[1].replace(/^\.?\//, ""));
    eq("U1 sw.js は切り替えの画面とその部品（見張り・js/areaSwitch.js・js/areaStore.js・css）を先読みする（オフラインでも直しと復旧の画面が開く）", ["/switch.html", ...new Set(switchAssets), "/js/areaStore.js"].filter((a) => !core.includes(a)), []);
    ok("U1 switch.html は部品が読めないとき（オフライン・取れない）に復旧の画面と「もう一度」を出す（小さい classic の script）", /<script>[^<]*switchRecovery[^<]*<\/script>/.test(switchHtml) && switchHtml.includes('id="switchOffline"'));
    // 列挙は領域を知る口
    const backup = fs.readFileSync(path.join(ROOT, "js/backup.js"), "utf8");
    ok("U1 js/backup.js の列挙は SpellDashArea.keys()（見張りの無い所だけ key・length）", /SpellDashArea/.test(backup) && (strip(backup).match(/localStorage\.length/g) ?? []).length === 1);
    const header = fs.readFileSync(path.join(ROOT, "js/staticHeader.js"), "utf8");
    ok("U1 js/staticHeader.js はログインを新しい鍵で見る（key・length を使わない・旧い鍵 sb- を見ない）", /SpellDashArea/.test(header) && !/localStorage\.(key|length)/.test(strip(header)) && !/"sb-"/.test(header));
  }

  // ── U2 見張り ─────────────────────────────
  {
    // 初めての端末: その場でゲストの領域を作り、読み替える
    const b = new Backing();
    const tab = openTab(b);
    eq("U2 初めての端末: 頭で止めない・印を作る", [tab.threw?.message ?? null, tab.log.stopped, tab.log.replaced, b.get("sd2.area"), JSON.parse(b.get("sd2.index")).guest.at, b.get("sd2.migrated") !== null], [null, 0, [], "guest#1", "ls", true]);
    const L = tab.ctx.localStorage;
    L.setItem("spelldash_word_stats", "{\"a\":1}");
    L.setItem("spelldash_theme", "dark");
    L.setItem("spelldash_test_session", "1");
    eq("U2 人の記録は sd2.<領域>.<名前> へ・端末の鍵と test_ はそのまま", [b.get("sd2.guest.word_stats"), b.get("spelldash_word_stats"), b.get("spelldash_theme"), b.get("spelldash_test_session")], ["{\"a\":1}", null, "dark", "1"]);
    eq("U2 読むのも元の名前で（getItem）", [L.getItem("spelldash_word_stats"), L.getItem("spelldash_theme")], ["{\"a\":1}", "dark"]);
    const alias = tab.ctx.window.localStorage;
    alias.setItem("spelldash_xp", "5");
    const proto = Object.getPrototypeOf(L);
    eq("U2 別名・window.localStorage・prototype の呼び方でも同じ", [b.get("sd2.guest.xp"), proto.getItem.call(L, "spelldash_xp")], ["5", "5"]);
    L.removeItem("spelldash_xp");
    eq("U2 removeItem も読み替える", [b.get("sd2.guest.xp"), b.get("spelldash_xp")], [null, null]);
    eq("U2 確かめの鍵は残らない", b.get("sd2.guest.sd2probe"), null);
    eq("U2 SpellDashArea.keys() は元の名前（今の領域の人の記録と端末の鍵）", [...tab.ctx.SpellDashArea.keys()].sort(), ["spelldash_test_session", "spelldash_theme", "spelldash_word_stats"]);
    ok("U2 stillMine・canWrite（ゲスト・セッションなし）", tab.ctx.SpellDashArea.stillMine() && tab.ctx.SpellDashArea.canWrite() && tab.ctx.SpellDashArea.area === "guest" && tab.ctx.SpellDashArea.userId() === null);
    // 二度目の読み込みは何もしない
    vm.runInContext(guardSrc, tab.ctx);
    L.setItem("spelldash_xp", "6");
    eq("U2 二度読んでも二重に読み替えない", [b.get("sd2.guest.xp"), b.get("sd2.sd2.guest.xp")], ["6", null]);

    // ほかの領域・旧い場所の値は見えない
    const b2 = new Backing({ ...migratedMarks("guest", 4), "sd2.guest.word_stats": "G", "sd2.u:A.word_stats": "A", spelldash_word_stats: "OLD", spelldash_owner: "sd2-moved" });
    const t2 = openTab(b2);
    eq("U2 今の領域だけを読む（ほかの領域・旧い場所の値は見えない）", [t2.ctx.localStorage.getItem("spelldash_word_stats"), [...t2.ctx.SpellDashArea.keys()].sort()], ["G", ["spelldash_word_stats"]]);
    ok("U2 旧い場所の値（旧コードのタブ）は片付けを頼む（手の空いたとき）", t2.log.idle.length === 1);

    // 書くたびの確かめ: 領域の印
    const b3 = new Backing({ ...migratedMarks("guest", 2), "sd2.guest.xp": "1" });
    const t3 = openTab(b3);
    b3.set("sd2.area", "u:B#3");
    eq("U2 印が替わった後の書き込みは拒む（書かない・切り替えの画面へ）", [t3.tryWrite("spelldash_xp", "999"), b3.get("sd2.guest.xp"), b3.get("sd2.u:B.xp"), t3.log.replaced[0]?.startsWith("/switch.html#back=")], ["InvalidStateError", "1", null, true]);
    ok("U2 removeItem も拒む", (() => { try { t3.ctx.localStorage.removeItem("spelldash_xp"); return false; } catch (e) { return e.name === "InvalidStateError"; } })() && b3.get("sd2.guest.xp") === "1");
    ok("U2 端末の鍵は書ける（人の記録でない）", t3.tryWrite("spelldash_theme", "dark") === "ok");
    // swap の段
    const b4 = new Backing({ ...migratedMarks("guest", 2) });
    const t4 = openTab(b4);
    b4.set("sd2.switch", JSON.stringify({ id: "s", phase: "drain", from: "guest", to: "u:B" }));
    eq("U2 drain の段は書ける（閉じる前の書きかけ）・stillMine は false", [t4.tryWrite("spelldash_xp", "2"), t4.ctx.SpellDashArea.stillMine()], ["ok", false]);
    b4.set("sd2.switch", JSON.stringify({ id: "s", phase: "swap", from: "guest", to: "u:B" }));
    eq("U2 swap の段は拒む", [t4.tryWrite("spelldash_xp", "3"), b4.get("sd2.guest.xp")], ["InvalidStateError", "2"]);
    // セッションの人: 同じタブの認証の書き込み
    const b5 = new Backing({ ...migratedMarks("guest", 1) });
    const t5 = openTab(b5);
    t5.ctx.localStorage.setItem(keysOf(t5.ctx).AUTH_KEY, session("B"));
    eq("U2 同じタブでほかの人がログイン: 切り替えの画面へ・人の記録は書かない", [t5.log.replaced.length, t5.tryWrite("spelldash_xp", "1"), b5.get("sd2.guest.xp"), t5.ctx.SpellDashArea.userId()], [1, "InvalidStateError", null, "B"]);
    // ほかのタブの知らせ
    const b6 = new Backing({ ...migratedMarks("u:A", 1), "sd2.auth": session("A") });
    const t6 = openTab(b6);
    ok("U2 セッションの人と領域が同じなら書ける", t6.tryWrite("spelldash_xp", "1") === "ok" && t6.ctx.SpellDashArea.userId() === "A");
    b6.set("sd2.auth", session("B"));
    t6.fire("sd2.auth", session("A"), session("B"));
    eq("U2 ほかのタブでほかの人がログイン（知らせ）: 拒む・切り替えの画面へ", [t6.tryWrite("spelldash_xp", "2"), b6.get("sd2.u:A.xp"), t6.log.replaced.length > 0], ["InvalidStateError", "1", true]);
    const b6b = new Backing({ ...migratedMarks("u:A", 1), "sd2.auth": session("A") });
    const t6b = openTab(b6b);
    b6b.remove("sd2.auth");
    t6b.fire("sd2.auth", session("A"), null);
    eq("U2 ほかのタブでログアウト（知らせ）: 拒む", t6b.tryWrite("spelldash_xp", "2"), "InvalidStateError");

    // storage イベントの作り直し
    const b7 = new Backing({ ...migratedMarks("guest", 1) });
    const t7 = openTab(b7);
    t7.fire("sd2.guest.word_stats", "{}", "{\"x\":1}");
    t7.fire("sd2.u:B.word_stats", null, "B");
    t7.fire("spelldash_word_stats", null, "OLD");
    t7.fire("spelldash_theme", "light", "dark");
    t7.fire("sd2.index", "{}", "{}");
    eq("U2 storage イベント: 今の領域の鍵は元の名前で届く・ほかの領域・旧い場所・印は届かない・端末の鍵はそのまま", t7.heard, [["spelldash_word_stats", "{}", "{\"x\":1}"], ["spelldash_theme", "light", "dark"]]);
    b7.set("sd2.switch", JSON.stringify({ id: "s", phase: "drain" }));
    t7.fire("sd2.switch", null, b7.get("sd2.switch"));
    ok("U2 切り替えの印の知らせで切り替えの画面へ", t7.log.replaced.length === 1 && t7.log.replaced[0].startsWith("/switch.html#back=%2Findex.html"));

    // 頭で止める
    const stops = [
      ["移行の前（旧い鍵の記録あり）", { spelldash_word_stats: "{}", spelldash_xp: "3" }],
      ["移行の前（旧い認証の鍵だけ）", { [OLD_AUTH]: session("A") }],
      ["切り替えの印がある", { ...migratedMarks(), "sd2.switch": JSON.stringify({ phase: "drain" }) }],
      ["移行の途中", { ...migratedMarks(), "sd2.migrating": JSON.stringify({ legacyId: "x" }) }],
      ["ページの領域 ≠ セッションの人", { ...migratedMarks("guest"), "sd2.auth": session("A") }],
      ["index が ls でない", { ...migratedMarks("guest", 3, { guest: { at: "idb:x" } }) }],
      ["印が読めない", { ...migratedMarks(), "sd2.area": "guest" }]
    ];
    for (const [name, seed] of stops) {
      const bb = new Backing(seed);
      const before = bb.dump();
      const tt = openTab(bb, { search: "?learn=next" });
      eq(`U2 頭で止める: ${name}（止めて /switch.html へ・使えないブラウザの文は出さない・人の記録を書けない）`, [tt.log.stopped, tt.log.replaced, tt.elements.some((e) => e.id === "areaStop"), tt.tryWrite("spelldash_xp", "9"), bb.dump(), tt.ctx.SpellDashArea === undefined], [1, ["/switch.html#back=%2Findex.html%3Flearn%3Dnext"], false, "InvalidStateError", before, true]);
    }
    // 切り替えの画面では包まない
    const b8 = new Backing({ spelldash_word_stats: "OLD" });
    const t8 = openTab(b8, { path: "/switch.html" });
    eq("U2 switch.html: 包まない・止めない・鍵の決まりだけ", [t8.log.stopped, t8.log.replaced, t8.ctx.localStorage.getItem("spelldash_word_stats"), typeof t8.ctx.SpellDashAreaKeys.isPersonKey, t8.ctx.SpellDashArea], [0, [], "OLD", "function", undefined]);
    // 使えないブラウザ: 共用に戻さず止める
    for (const [name, opts] of [["IndexedDB が無い", { idb: false }], ["Web Locks が無い", { noLocks: true }], ["prototype を包めない", { freezeProto: true }], ["包んだ口が使われない（自分の setItem）", { shadowSetItem: true }]]) {
      const bb = new Backing({ ...migratedMarks(), "sd2.guest.xp": "1", spelldash_theme: "dark" });
      const before = bb.dump();
      const tt = openTab(bb, opts);
      const stopEl = tt.elements.find((e) => e.id === "areaStop");
      eq(`U2 使えない（${name}）: 止める（後の script は動かない）・文を出す・SpellDashArea を置かない・何も書かない`, [tt.threw?.message ?? null, tt.log.stopped, tt.log.replaced, Boolean(stopEl), stopEl?.dataset.reason ?? null, tt.ctx.SpellDashArea === undefined, bb.dump()], [null, 1, [], true, opts.idb === false ? "indexeddb" : opts.noLocks ? "locks" : "wrap", true, before]);
      // 包めたブラウザでは、止めた後の人の記録の書き込みも断る（共用の場所へ戻さない）
      if (!opts.freezeProto && !opts.shadowSetItem) eq(`U2 使えない（${name}）: 止めた後の人の記録の書き込みは断る・共用の場所にも書かない`, [tt.tryWrite("spelldash_xp", "2"), bb.get("spelldash_xp"), bb.get("sd2.guest.xp")], ["InvalidStateError", null, "1"]);
    }
    {
      const bb = new Backing({ ...migratedMarks(), "sd2.guest.xp": "1" });
      const tt = openTab(bb, { idb: false });
      const exportBtn = tt.elements.find((e) => e.id === "areaStopExport");
      ok("U2 使えないブラウザの文に「記録を書き出す」がある（今の領域の記録）", Boolean(exportBtn) && exportBtn.textContent === "記録を書き出す");
    }
    // 保存そのものが使えない端末: 止めない（何も残らない）・送らない
    const t9 = openTab(new Backing(), { storageThrows: true });
    eq("U2 保存が使えない端末: 止めない・stillMine は false", [t9.log.stopped, t9.log.replaced, t9.ctx.SpellDashArea?.stillMine(), t9.threw?.message ?? null], [0, [], false, null]);
    // タブの同期の印: 世代が違えば消す。sessionStorage は localStorage と同じ Storage の型（本物のブラウザと同じ）なので、見張りの包んだ口を通る。
    // 包んだ口は this が localStorage のときだけ読み替える: sessionStorage の印は元の名前のまま消す・書く・読む（sd2.<領域>. の鍵を作らない）
    const lsb = new Backing({ ...migratedMarks("u:A", 3), "sd2.auth": session("A") });
    const ssb = new Backing({ spelldash_synced_this_session: "A", spelldash_pulled_this_session: "A", spelldash_sync_done_this_session: "A", spelldash_pull_started_at: "1", "sd2.tabgen": "u:A#1", spelldash_login_return: "1" });
    const tss = openTab(lsb, { session: ssb });
    eq("U2 領域の世代が替わったタブは同期の印 4 つを元の名前で消す（ほかの印は残す・sessionStorage に sd2.<領域>. の鍵を作らない）", [Object.getPrototypeOf(tss.ctx.sessionStorage) === Object.getPrototypeOf(tss.ctx.localStorage), ssb.dump()], [true, { "sd2.tabgen": "u:A#3", spelldash_login_return: "1" }]);
    tss.ctx.sessionStorage.setItem("spelldash_synced_this_session", "A");
    eq("U2 sessionStorage のタブの印は元の名前のまま書いて読む（読み替えない・localStorage の領域の鍵にも書かない）", [ssb.get("spelldash_synced_this_session"), ssb.get("sd2.u:A.synced_this_session"), tss.ctx.sessionStorage.getItem("spelldash_synced_this_session"), lsb.get("sd2.u:A.synced_this_session")], ["A", null, "A", null]);
    tss.ctx.sessionStorage.removeItem("spelldash_synced_this_session");
    eq("U2 sessionStorage のタブの印は元の名前のまま消す", ssb.get("spelldash_synced_this_session"), null);
    const ssc = new Backing({ spelldash_pulled_this_session: "A", "sd2.tabgen": "u:A#3" });
    openTab(new Backing({ ...migratedMarks("u:A", 3), "sd2.auth": session("A") }), { session: ssc });
    eq("U2 同じ世代なら印は残す", ssc.get("spelldash_pulled_this_session"), "A");
    // ページの共有のロックを持つ
    const lk = new FakeLocks();
    openTab(new Backing(migratedMarks()), { locks: lk });
    await new Promise((r) => setTimeout(r, 0));
    eq("U2 ページの間、共有のロック spelldash-page を持つ", (await lk.query()).held.filter((l) => l.name === "spelldash-page" && l.mode === "shared").length, 1);
    // 凍って知らせを受けていないタブが戻った: visibilitychange（見える）・pageshow（戻るの控えから）・focus で確かめ直して切り替えの画面へ
    for (const [name, fire] of [
      ["visibilitychange", (t) => t.ctx.document.dispatchEvent(new Event("visibilitychange"))],
      ["pageshow(persisted)", (t) => t.ctx.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }))],
      ["focus", (t) => t.ctx.dispatchEvent(new Event("focus"))]
    ]) {
      const bb = new Backing({ ...migratedMarks("guest", 1), "sd2.guest.xp": "1" });
      const tt = openTab(bb);
      bb.set("sd2.area", "u:B#2"); // 凍っている間に切り替わった（storage イベントは届いていない）
      bb.set("sd2.auth", session("B"));
      const quiet = tt.log.replaced.length;
      fire(tt);
      eq(`U2 戻ったタブ（${name}）: 確かめ直して切り替えの画面へ（戻る前は動かない）`, [quiet, tt.log.replaced.length, tt.log.replaced[0]?.startsWith("/switch.html#back=") ?? false], [0, 1, true]);
    }
    // 自分の確かめ: 包んだ口で書いた値が生の口で読めない保存（書き込みが黙って消える）では止める
    {
      class Silent extends Backing {
        set() {}
      }
      const bb = new Silent({ ...migratedMarks("guest", 1), "sd2.guest.xp": "1" });
      const tt = openTab(bb);
      const stopEl = tt.elements.find((e) => e.id === "areaStop");
      eq("U2 自分の確かめが合わない（書き込みが黙って消える保存）: 止める・文を出す（理由 selftest）・SpellDashArea を置かない", [tt.log.stopped, stopEl?.dataset.reason ?? null, tt.ctx.SpellDashArea === undefined], [1, "selftest", true]);
    }
    // 同じタブのログアウト（認証の部品が sd2.auth・sd2.auth-user を removeItem）: 覚え直して切り替えの画面へ・人の記録を書かない・送らない（§2 の (3)）
    for (const key of ["sd2.auth", "sd2.auth-user"]) {
      const seed = { ...migratedMarks("u:A", 1), "sd2.u:A.xp": "1" };
      if (key === "sd2.auth") seed["sd2.auth"] = session("A");
      else seed["sd2.auth-user"] = JSON.stringify({ user: { id: "A" } });
      seed["sd2.auth"] ??= JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: 9999999999 });
      const b = new Backing(seed);
      const t = openTab(b);
      const before = [t.ctx.SpellDashArea.signedIn(), t.ctx.SpellDashArea.stillMine()];
      t.ctx.localStorage.removeItem(key);
      eq(`U2 同じタブのログアウト（${key} を removeItem）: 切り替えの画面へ・人の記録を書かない・stillMine と signedIn は false`, [before, t.log.replaced.length, t.tryWrite("spelldash_xp", "2"), b.get("sd2.u:A.xp"), t.ctx.SpellDashArea.stillMine(), t.ctx.SpellDashArea.signedIn()], [[true, true], 1, "InvalidStateError", "1", false, false]);
    }
    // 満杯の端末: 読み込みの確かめ（包んだ口で書く）が容量で入らなくても、ページは止めない（共用に戻さず、今の領域を読める・書けないのは容量の例外）
    {
      const seed = { ...migratedMarks("guest", 1), "sd2.guest.xp": "7", "sd2.guest.word_stats": "w".repeat(3000) };
      const b = new Backing(seed, new Backing(seed).size()); // 1 字も入らない
      const t = openTab(b);
      eq("U2 満杯の端末: 止めない・使えないブラウザの文を出さない・今の領域を読める・書けないのは容量の例外（成功と見せない）", [t.log.stopped, t.elements.some((e) => e.id === "areaStop"), t.ctx.SpellDashArea?.area ?? null, t.ctx.localStorage.getItem("spelldash_xp"), t.tryWrite("spelldash_xp", "8888888"), b.get("sd2.guest.xp")], [0, false, "guest", "7", "QuotaExceededError", "7"]);
    }
    // 確かめの書き込みが容量でない理由で投げる保存: 止める（理由 selftest）
    {
      class Denied extends Backing {
        set(k, v) {
          if (k.endsWith("sd2probe")) throw new DOMException("denied", "SecurityError");
          super.set(k, v);
        }
      }
      const t = openTab(new Denied({ ...migratedMarks("guest", 1), "sd2.guest.xp": "7" }));
      eq("U2 確かめの書き込みが容量でない例外: 止める（理由 selftest）・SpellDashArea を置かない", [t.log.stopped, t.elements.find((e) => e.id === "areaStop")?.dataset.reason ?? null, t.ctx.SpellDashArea === undefined], [1, "selftest", true]);
    }
    // 退避した領域（index が idb を指す）の鍵が localStorage に残っている（見え方の古いタブが切り替えの後に書いた）: 頭で見つけて、手の空いたときに片付けを頼む。
    // ほかのタブの知らせでも同じ（今の領域の鍵・index が ls を指す領域の鍵では頼まない）
    {
      const idx = { "u:B": { at: "ls" }, "u:A": { at: "idb:a1" } };
      const b = new Backing({ ...migratedMarks("u:B", 3, idx), "sd2.auth": session("B"), "sd2.u:B.xp": "222", "sd2.u:A.xp": "999" });
      const t = openTab(b);
      eq("U2 退避した領域の鍵が残る端末: 頭で止めない・今の領域を読む・片付けを 1 回頼む", [t.log.stopped, t.ctx.SpellDashArea?.area, t.ctx.localStorage.getItem("spelldash_xp"), t.log.idle.length], [0, "u:B", "222", 1]);
      const b2 = new Backing({ ...migratedMarks("u:B", 3, idx), "sd2.auth": session("B"), "sd2.u:B.xp": "222" });
      const t2 = openTab(b2);
      const quiet = [t2.log.idle.length, t2.log.timers.length];
      t2.fire("sd2.u:B.xp", "222", "223"); // 今の領域
      const own = [t2.log.idle.length, t2.log.timers.length];
      b2.set("sd2.u:A.xp", "999");
      t2.fire("sd2.u:A.xp", null, "999"); // 退避した領域へ、見え方の古いタブが書いた
      t2.fire("sd2.u:A.word_stats", null, "{}");
      eq("U2 退避した領域の鍵の知らせ（ほかのタブ）: 片付けを 1 回だけ頼む・今の領域の知らせでは頼まない・アプリには届けない", [quiet, own, t2.log.idle.length + t2.log.timers.length > 0, t2.log.idle.length + t2.log.timers.length <= 1, t2.heard.map((h) => h[0])], [[0, 0], [0, 0], true, true, ["spelldash_xp"]]);
    }
    // 使えないブラウザの「記録を書き出す」: 持ち主の値（§5。アカウントは user id から作る安定した値）を入れ、生の user id・同期の印は書かない（js/backup.js の EXCLUDE と同じ鍵を除く）
    {
      const uid = "0f8d2c5e-1b7a-4c3d-9e8f-123456789abc";
      const b = new Backing({ ...migratedMarks(`u:${uid}`, 2), "sd2.auth": session(uid), [`sd2.u:${uid}.xp`]: "5", [`sd2.u:${uid}.word_stats`]: "{}", [`sd2.u:${uid}.owner`]: uid, [`sd2.u:${uid}.xp_synced`]: "5", [`sd2.u:${uid}.logout_at`]: "2026-10-01T00:00:00.000Z", [`sd2.u:${uid}.dirty_words`]: "[]", spelldash_theme: "dark" });
      const t = openTab(b, { idb: false });
      const button = t.elements.find((e) => e.id === "areaStopExport");
      let file = null;
      if (button?.handlers.click) {
        await button.handlers.click();
        for (let i = 0; i < 20 && t.log.blobs.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
        file = t.log.blobs[0] ? JSON.parse(await t.log.blobs[0].text()) : null;
      }
      const tag = (await SW.ownerOf(`u:${uid}`, globalThis.crypto.subtle)).tag;
      eq("U2 使えないブラウザの書き出し: 持ち主はアカウントの値・生の user id は無い・持ち主の鍵と同期の印（owner・xp_synced・logout_at・dirty_words）は入れない・記録と端末の鍵は入る", [file?.owner ?? null, file ? JSON.stringify(file).includes(uid) : null, file ? ["spelldash_owner", "spelldash_xp_synced", "spelldash_logout_at", "spelldash_dirty_words"].filter((k) => k in file.data) : null, file?.data?.spelldash_xp ?? null, file?.data?.spelldash_theme ?? null], [{ kind: "account", tag }, false, [], "5", "dark"]);
    }
    // 切り替えの画面の戻り先（# の後ろの back）: 同じ origin のパスだけ。タブ・改行を挟んだ //・\・外の URL・切り替えの画面そのものは / へ
    {
      const origin = "https://www.spelldash.net";
      const bad = ["https://evil.example/", "//evil.example/", "/\\evil.example/", "/\t/evil.example/", "/\n/evil.example/", "/\r/evil.example/", "\t//evil.example/", "/\u0000/evil.example/", "data:text/html,x", "", null, "/switch.html", "/switch.html#back=%2F", "/switch.html?x=1"];
      eq("U2 戻り先: 外の URL・タブや改行を挟んだ //・\\・切り替えの画面は / にする（どれも同じ origin のまま）", bad.map((v) => SW.safeBack(v, origin)).map((r, i) => (r === "/" ? null : `${JSON.stringify(bad[i])} → ${JSON.stringify(r)} → ${new URL(r, origin).origin}`)).filter(Boolean), []);
      const good = ["/stats.html", "/?learn=next", "/index.html?learn=new#play", "/#access_token=AAA&refresh_token=RRR", "/packs/school.html?x=%2F%2Fy"];
      eq("U2 戻り先: 同じ origin のパスはそのまま（パラメータとログインの戻りの # も）", good.map((v) => SW.safeBack(v, origin)), good);
      const fromHash = typeof SW.backFrom === "function" ? SW.backFrom({ hash: "#back=" + encodeURIComponent("/stats.html?learn=next#x"), search: "?back=%2F%2Fevil.example" }) : "（backFrom が無い）";
      eq("U2 戻り先は URL の # の後ろから読む（? の後ろの back は読まない）", fromHash, "/stats.html?learn=next#x");
    }
  }

  // ── U3 移行（§8） ─────────────────────────────
  {
    const K = loadKeys();
    const cases = [
      { name: "持ち主なし・ログイン中 U", seed: { ...clean(personSeed("A")), [OLD_AUTH]: session("U") }, area: "u:U", final: "u:U" },
      { name: "持ち主なし・未ログイン", seed: clean(personSeed("A")), area: "guest", final: "guest" },
      { name: "持ち主 U・ログイン中 U", seed: { ...clean(personSeed("A")), spelldash_owner: "U", [OLD_AUTH]: session("U") }, area: "u:U", final: "u:U" },
      { name: "持ち主 A・未ログイン（A の領域へ入れて退避・ゲストは空）", seed: { ...clean(personSeed("A")), spelldash_owner: "A" }, area: "u:A", final: "guest" },
      { name: "持ち主 B・ログイン中 A（B の領域へ入れて退避・A は空）", seed: { ...clean(personSeed("A")), spelldash_owner: "B", [OLD_AUTH]: session("A") }, area: "u:B", final: "u:A" }
    ];
    for (const c of cases) {
      const b = new Backing({ ...c.seed, spelldash_theme: "dark", spelldash_device_id: "dev1" });
      const old = Object.fromEntries(Object.entries(c.seed).filter(([k]) => K.isPersonKey(k)));
      const r = await settle(b);
      const legacy = r.idb.all("legacy");
      const migrated = JSON.parse(b.get("sd2.migrated") ?? "null");
      eq(`U3 ${c.name}: 失敗しない・領域`, [r.error?.message ?? null, b.get("sd2.area")], [null, `${c.final}#${c.area === c.final ? 1 : 2}`]);
      eq(`U3 ${c.name}: legacy に旧い記録の全部（1 件・読み直し済み・印に id）`, [legacy.length, legacy[0]?.keys, migrated?.legacyId === legacy[0]?.id, migrated?.fromSchema], [1, old, true, "7"]);
      eq(`U3 ${c.name}: 旧い本体は localStorage に残らない（持ち主の鍵は「移した」の印だけ）・移行が消す（旧い場所の片付け orphans に回さない）`, [rawPersonKeys(b), b.get("spelldash_owner"), r.idb.all("orphans").length], [["spelldash_owner"], "sd2-moved", 0]);
      const where = c.area === c.final ? areaRecords(b, c.area) : r.idb.peek("areas", c.area)?.keys;
      eq(`U3 ${c.name}: 記録（3 状態・最高到達ランク・回の続き・送信待ち）は 1 字も違わず ${c.area} に入る`, where, old);
      ok(`U3 ${c.name}: 端末の鍵はそのまま`, b.get("spelldash_theme") === "dark" && b.get("spelldash_device_id") === "dev1");
      if (c.area !== c.final) eq(`U3 ${c.name}: 切り替え先 ${c.final} は空で始まる・index は ${c.area} が idb`, [areaRecords(b, c.final), JSON.parse(b.get("sd2.index"))[c.area].at.startsWith("idb:"), JSON.parse(b.get("sd2.index"))[c.final].at], [{}, true, "ls"]);
      if (c.seed[OLD_AUTH]) eq(`U3 ${c.name}: 認証のセッションを新しい鍵へ移し、旧い鍵は消す`, [b.get("sd2.auth"), b.get(OLD_AUTH)], [c.seed[OLD_AUTH], null]);
      eq(`U3 ${c.name}: 控えは durability strict で書く`, [...new Set(r.idb.durabilities)], ["strict"]);
      // 2 回流しても同じ
      const dump = b.dump();
      const again = await settle(b, { idb: r.idb, locks: r.locks });
      eq(`U3 ${c.name}: 2 回流しても同じ（legacy は増えない）`, [again.error?.message ?? null, b.dump(), r.idb.all("legacy").length], [null, dump, 1]);
    }
    // 落ちた点からの続き: 移行の各書き込みで落とし、次のタブで直す
    const seed = { ...clean(personSeed("A")), spelldash_owner: "U", [OLD_AUTH]: session("U"), spelldash_theme: "dark" };
    const old = Object.fromEntries(Object.entries(seed).filter(([k]) => K.isPersonKey(k)));
    let points = 0;
    for (let n = 1; n < 60; n++) {
      const b = new Backing(seed);
      const idb = new FakeIDB();
      const first = await settle(b, { idb, crashAt: n });
      if (!first.error) break; // n が手順の書き込みの数を超えた
      points++;
      const second = await settle(b, { idb });
      eq(`U3 移行の ${n} 番目の書き込みで落ちた: 次に開くと続きから終わる・記録は 1 字も違わない・旧い本体は残らない`, [second.error?.message ?? null, b.get("sd2.area"), areaRecords(b, "u:U"), rawPersonKeys(b), b.get("sd2.auth"), b.get(OLD_AUTH), b.get("sd2.migrating")], [null, "u:U#1", old, ["spelldash_owner"], seed[OLD_AUTH], null, null]);
    }
    ok("U3 移行の書き込みの全部の点で落として確かめた（10 点以上）", points >= 10, `${points} 点`);
    // 容量: 旧い本体と新しい鍵の両方は入らない端末でも移せる（その鍵の旧い本体を消してから書く）
    {
      const big = "x".repeat(4000);
      const s = { spelldash_word_stats: big, spelldash_xp: "3", spelldash_schema_version: "7" };
      const limit = Object.entries(s).reduce((n, [k, v]) => n + k.length + v.length, 0) + 600;
      const b = new Backing(s, limit);
      const r = await settle(b);
      eq("U3 容量のぎりぎりの端末: 旧い本体を消してから新しい鍵へ書く（失わない・両方は残らない）", [r.error?.message ?? null, b.get("sd2.guest.word_stats") === big, b.get("spelldash_word_stats"), r.idb.all("legacy")[0]?.keys.spelldash_word_stats === big], [null, true, null, true]);
    }
    // legacy に写せない・読み直しが合わない: 止める（旧い記録はそのまま・印を書かない）
    for (const [name, inject, reason] of [["写せない（容量）", (idb) => (idb.failPut = () => quotaError()), "quota"], ["読み直しが合わない", (idb) => (idb.corruptRead = (store, v) => ({ ...v, keys: { ...v.keys, spelldash_xp: "0" } })), "legacy"], ["IndexedDB を開けない", (idb) => (idb.failOpen = new Error("blocked")), "open"]]) {
      const b = new Backing({ ...clean(personSeed("A")) });
      const before = b.dump();
      const idb = new FakeIDB();
      inject(idb);
      const r = await settle(b, { idb });
      eq(`U3 legacy に${name}: 止める（理由 ${reason}）・旧い記録はそのまま・印を書かない`, [r.error?.reason, b.dump()], [reason, before]);
    }
    // 新しい鍵の書き込みが黙って消える保存（切り替えの画面は読み込みの確かめをしない）: 手順 3 の読み直し（新しい領域への移行の確認）で止める。
    // 旧い本体は消さない（legacy だけに残さない）・移行の印を書かない
    {
      class DropNew extends Backing {
        set(k, v) {
          if (String(k).startsWith("sd2.guest.")) return; // 新しい鍵だけ黙って消える
          super.set(k, v);
        }
      }
      const seed = { ...clean(personSeed("A")), spelldash_theme: "dark" };
      const b = new DropNew(seed);
      const r = await settle(b);
      const old = Object.fromEntries(Object.entries(seed).filter(([k]) => K.isPersonKey(k)));
      eq("U3 移行で新しい鍵が書けていない（黙って消える保存）: 止める（理由 migrate）・旧い本体は localStorage にそのまま・移行の印を書かない", [r.error?.reason ?? null, Object.fromEntries(rawPersonKeys(b).map((k) => [k, b.get(k)])), b.get("sd2.migrated")], ["migrate", old, null]);
    }
    // persist() を頼む（§7 (f)。初めて IndexedDB に写すとき）: 移行で 1 回以上・切り替えの退避で 1 回以上。askPersist は、まだ永続でなければ navigator.storage.persist() を呼ぶ
    {
      let asked = 0;
      const b = new Backing({ ...clean(personSeed("A")) });
      const idb = new FakeIDB();
      const mk = () => SW.createSwitcher({ ls: rawOf(b), keys: K, openStore: () => ST.openAreaStore(idb), locks: new FakeLocks(), now: () => Date.parse("2026-10-29T00:00:00Z"), newId: () => `p${++seq}`, sleep: async () => {}, persist: async () => { asked++; return true; } });
      const r1 = await mk().settle().then(() => null, (e) => e);
      const afterMigrate = asked;
      b.set("sd2.auth", session("B"));
      const r2 = await mk().settle().then(() => null, (e) => e);
      eq("U3 persist() を頼む: 移行（legacy に写す）で 1 回以上・切り替え（ゲストを退避）で 1 回以上", [r1?.message ?? null, r2?.message ?? null, afterMigrate >= 1, asked - afterMigrate >= 1, idb.peek("areas", "guest") !== undefined], [null, null, true, true, true]);
      const ask = async (persisted) => {
        let called = 0;
        const res = await ST.askPersist({ persisted: async () => persisted, persist: async () => { called++; return true; } });
        return [called, res];
      };
      eq("U3 askPersist: まだ永続でなければ navigator.storage.persist() を 1 回呼んで答えを返す・すでに永続なら呼ばずに true・口が無ければ false", [await ask(false), await ask(true), await ST.askPersist(null)], [[1, true], [0, true], false]);
    }
    // 移行の途中（legacy に写した後）に旧コードのタブが旧い鍵へ書いた値: 消して失わない。orphans に 1 字も違わず写して localStorage から消す（読まない・移し直さない）
    {
      const seed = clean(personSeed("A"));
      const b = new Backing({ ...seed });
      const idb = new FakeIDB();
      let fired = false;
      idb.failPut = (store) => {
        if (store === "legacy" && !fired) {
          fired = true;
          b.set("spelldash_xp", "OLDTAB-AFTER-SNAPSHOT");
        }
        return null;
      };
      const r = await settle(b, { idb });
      eq("U3 移行の途中に旧コードのタブが書いた値: 旧い場所に残らず orphans に 1 字も違わず写る・新しい鍵には写した時の値", [r.error?.message ?? null, b.get("spelldash_xp"), idb.all("orphans").some((o) => o.keys.spelldash_xp === "OLDTAB-AFTER-SNAPSHOT"), areaRecords(b, "guest").spelldash_xp], [null, null, true, seed.spelldash_xp]);
    }
    // 容量のぎりぎりの端末: 移した後の形が入るなら、1 回で必ず終わる（途中で止まって開けなくならない）。入らなければ止まるが、
    // 書き出しは legacy（旧い記録の全部）と 1 字も違わない。もう一度でも同じ。u:<uuid> の鍵は旧い名前より 33 字長い
    {
      seq = Math.max(seq, 100000); // 写しの id の字数をそろえる（終わった形の大きさを比べる）
      const uid = "0f8d2c5e-1b7a-4c3d-9e8f-123456789abc";
      const seeds = [
        ["ログイン中・小さい鍵と大きい語の記録", { spelldash_memory_words: "s".repeat(100), spelldash_word_stats: "x".repeat(4000), spelldash_xp: "3", spelldash_schema_version: "7", spelldash_theme: "dark", [OLD_AUTH]: session(uid) }, `u:${uid}`],
        ["ログイン中・語の記録の前に小さい鍵 20", (() => {
          const s = { spelldash_theme: "dark", [OLD_AUTH]: session(uid) };
          for (let i = 0; i < 20; i++) s[`spelldash_a${String(i).padStart(2, "0")}`] = "s".repeat(200);
          s.spelldash_word_stats = "x".repeat(30000);
          s.spelldash_xp = "3";
          return s;
        })(), `u:${uid}`],
        ["持ち主あり・ログイン中", { spelldash_owner: uid, spelldash_word_stats: "x".repeat(3000), spelldash_xp: "3", spelldash_rank_peak: "2", [OLD_AUTH]: session(uid), [OLD_AUTH + "-user"]: JSON.stringify({ user: { id: uid } }) }, `u:${uid}`],
        ["未ログイン・ゲスト", { spelldash_word_stats: "x".repeat(5000), spelldash_xp: "3", spelldash_schema_version: "7", spelldash_theme: "dark" }, "guest"]
      ];
      for (const [name, s, area] of seeds) {
        const old = sortedRec(Object.fromEntries(Object.entries(s).filter(([k]) => K.isPersonKey(k))));
        const used = new Backing(s).size();
        const free = new Backing(s);
        const r0 = await settle(free);
        const need = free.size() - used; // 移した後の形に要る空き
        eq(`U3 容量（${name}）: 空きに上限が無ければ終わる`, [r0.error?.message ?? null, free.get("sd2.area")], [null, `${area}#1`]);
        const hs = [...new Set([Math.max(0, need - 200), need - 1, need, need + 1, need + 37, need + 200, ...Array.from({ length: 7 }, (_, k) => need + 400 + k * 641)])].filter((h) => h >= 0);
        const stuck = [];
        for (const h of hs) {
          const b = new Backing(s, used + h);
          const r1 = await settle(b);
          const fits = h >= need;
          if (!r1.error) {
            const done = sortedRec(areaRecords(b, area));
            if (!(fits && isDeepStrictEqual(done, old) && isDeepStrictEqual(rawPersonKeys(b), ["spelldash_owner"]) && b.get("sd2.migrating") === null && b.get("sd2.migrated") !== null && b.get(OLD_AUTH) === null)) stuck.push(`${h}: 終わったが形が違う`);
            continue;
          }
          if (fits) stuck.push(`${h}（空き ${need} で入る）: 止まった（${r1.error.reason ?? r1.error.message}）`);
          const e1 = await exportOf(b, r1.idb);
          if (!isDeepStrictEqual(personOf(e1?.data), exportable(old))) stuck.push(`${h}: 書き出しが legacy と違う（${e1 instanceof Error ? e1.message : Object.keys(personOf(e1.data)).length + " 鍵"}）`);
          const r2 = await settle(b, { idb: r1.idb });
          if (r2.error) {
            const e2 = await exportOf(b, r1.idb);
            if (!isDeepStrictEqual(personOf(e2?.data), exportable(old))) stuck.push(`${h}: もう一度の後の書き出しが legacy と違う`);
          } else if (!fits) stuck.push(`${h}: 入らないのに終わった`);
        }
        eq(`U3 容量（${name}・空き ${need} の前後 ${hs.length} 通り）: 移した後の形が入るなら 1 回で終わる・入らなければ止まり、書き出しは legacy と同じ`, stuck, []);
      }
    }
    // 移行の途中（sd2.migrating がある）で止まった端末の書き出し: legacy（読めなければ、新しい鍵と残った旧い鍵を合わせた物）。持ち主は legacy から決めた領域
    {
      const s = { ...clean(personSeed("A")), spelldash_theme: "dark" };
      const old = sortedRec(Object.fromEntries(Object.entries(s).filter(([k]) => K.isPersonKey(k))));
      for (let n = 1; n < 30; n++) {
        const b = new Backing(s);
        const idb = new FakeIDB();
        const first = await settle(b, { idb, crashAt: n });
        if (!first.error) break;
        if (b.get("sd2.migrating") === null) continue;
        const e = await exportOf(b, idb);
        idb.failOpen = new Error("lost");
        const e2 = await exportOf(b, idb);
        eq(`U3 移行の ${n} 番目で落ちた端末の書き出し: legacy と同じ・控えが開けなくても新しい鍵と旧い鍵を合わせて同じ・端末の鍵も入る`, [personOf(e?.data), personOf(e2?.data), e?.data?.spelldash_theme], [exportable(old), exportable(old), "dark"]);
      }
    }
  }

  // ── U4 切り替えの直し・U6 展開の途中で満杯 ─────────────────────────────
  {
    const K = loadKeys();
    const A = clean(personSeed("A"));
    const B = clean(personSeed("B"));
    // A の領域が今・B は IndexedDB（前に退避した）の端末を作る
    async function twoAreas(limit = Infinity) {
      const b = new Backing({ ...migratedMarks("u:B", 1), "sd2.auth": session("B"), ...Object.fromEntries(Object.entries(B).map(([k, v]) => [K.physicalKey("u:B", k), v])) });
      const idb = new FakeIDB();
      b.set("sd2.auth", session("A"));
      const r1 = await settle(b, { idb }); // B → A（B を退避・A は空）
      if (r1.error) throw r1.error;
      const L = rawOf(b);
      for (const [k, v] of Object.entries(A)) L.set(K.physicalKey("u:A", k), v); // A で学んだ
      b.limit = limit;
      return { b, idb };
    }
    {
      const { b, idb } = await twoAreas();
      eq("U4 準備: A が localStorage・B は IndexedDB（index が id を指す）", [b.get("sd2.area"), areaRecords(b, "u:A"), areaRecords(b, "u:B"), idb.peek("areas", "u:B")?.keys, JSON.parse(b.get("sd2.index"))["u:B"].at === `idb:${idb.peek("areas", "u:B").id}`], ["u:A#2", A, {}, B, true]);
      b.set("sd2.auth", session("B"));
      const r = await settle(b, { idb });
      eq("U4 A → B: B の記録が 1 字も違わず戻る・A は退避（localStorage に A の鍵が 1 つも無い）", [r.error?.message ?? null, b.get("sd2.area"), areaRecords(b, "u:B"), areaRecords(b, "u:A"), idb.peek("areas", "u:A")?.keys], [null, "u:B#3", B, {}, A]);
      b.set("sd2.auth", session("A"));
      await settle(b, { idb });
      eq("U4 B → A: A が 1 字も違わず戻る", [b.get("sd2.area"), areaRecords(b, "u:A"), areaRecords(b, "u:B")], ["u:A#4", A, {}]);
    }
    // 各点で落とす（A → B）
    let points = 0;
    for (let n = 1; n < 80; n++) {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      const first = await settle(b, { idb, crashAt: n });
      if (!first.error) break;
      points++;
      const mixed = b.keys().filter((k) => k.startsWith("sd2.u:A.")).length > 0 && b.keys().filter((k) => k.startsWith("sd2.u:B.")).length > 0;
      const crashedStops = openTab(new Backing(b.dump())).log.stopped === 1;
      // 次に開いたタブ（直し）: セッションは B のまま
      const second = await settle(b, { idb });
      eq(`U4 A → B の ${n} 番目の書き込みで落ちた: 直すと B がそろい、A は IndexedDB にそろう・混ざらない`, [second.error?.message ?? null, b.get("sd2.area")?.split("#")[0], areaRecords(b, "u:B"), areaRecords(b, "u:A"), idb.peek("areas", "u:A")?.keys, b.get("sd2.switch")], [null, "u:B", B, {}, A, null]);
      ok(`U4 A → B の ${n} 番目で落ちた形: 直す前のページは頭で止まる（学習の部品は動かない）`, crashedStops, mixed ? "A と B の鍵が両方ある形" : "");
    }
    ok("U4 切り替えの書き込みの全部の点で落として確かめた（8 点以上）", points >= 8, `${points} 点`);
    for (let n = 1; n < 80; n++) {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      const first = await settle(b, { idb, crashAt: n });
      if (!first.error) break;
      b.set("sd2.auth", session("A"));
      const second = await settle(b, { idb });
      eq(`U4 ${n} 番目で落ちた後にセッションが A に戻った: A がそろう・B は IndexedDB のまま`, [second.error?.message ?? null, b.get("sd2.area")?.split("#")[0], areaRecords(b, "u:A"), areaRecords(b, "u:B"), idb.peek("areas", "u:B")?.keys], [null, "u:A", A, {}, B]);
    }
    // 古い写しを戻さない（nsverify F1）: A の古い写しが IndexedDB に残っていて、A を学び進めた後の切り替えで落ちても、今の A を失わない
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      await settle(b, { idb }); // A を退避（1 日目の写し）
      b.set("sd2.auth", session("A"));
      await settle(b, { idb }); // A を戻す（写しは残る）
      const A2 = { ...A, spelldash_word_stats: WS("A-day9"), spelldash_rank_peak: "5" };
      for (const [k, v] of Object.entries(A2)) b.set(K.physicalKey("u:A", k), v); // 9 日目まで学んだ
      const staleId = idb.peek("areas", "u:A").id;
      b.set("sd2.auth", session("B"));
      for (let n = 1; n < 40; n++) {
        const bb = new Backing(b.dump());
        const idb2 = new FakeIDB();
        idb2.dbs = structuredClone(idb.dbs);
        const first = await settle(bb, { idb: idb2, crashAt: n });
        if (!first.error) break;
        bb.set("sd2.auth", session("A"));
        await settle(bb, { idb: idb2 });
        eq(`U4 古い写し（${staleId}）を戻さない: ${n} 番目で落ちても 9 日目の A がそろう`, areaRecords(bb, "u:A"), A2);
      }
    }
    // U6 展開の途中で満杯
    {
      const bigB = { ...B, spelldash_word_stats: "B".repeat(6000) };
      const b = new Backing({ ...migratedMarks("u:B", 1), "sd2.auth": session("B"), ...Object.fromEntries(Object.entries(bigB).map(([k, v]) => [K.physicalKey("u:B", k), v])) });
      const idb = new FakeIDB();
      b.set("sd2.auth", session("A"));
      await settle(b, { idb }); // B を退避
      for (const [k, v] of Object.entries(A)) b.set(K.physicalKey("u:A", k), v);
      b.set("zz.filler", "f".repeat(2000)); // ほかの物で端末の空きが減った
      b.limit = b.size() + 3000; // A を消しても B（6000 字）は入らない
      const before = b.dump();
      const bRecord = idb.peek("areas", "u:B");
      b.set("sd2.auth", session("B"));
      const r = await settle(b, { idb });
      const after = b.dump();
      const idx = JSON.parse(after["sd2.index"]);
      eq("U6 展開の途中で満杯: 理由 quota・A は localStorage に 1 字も違わず残る・印は替わらない・途中の印は消す", [r.error?.reason, areaRecords(b, "u:A"), after["sd2.area"], after["sd2.switch"] ?? null, idx["u:A"].at], ["quota", A, before["sd2.area"], null, "ls"]);
      eq("U6 切り替え先 B は IndexedDB に残る（index も写しも同じ）・localStorage に B の鍵は 1 つも無い", [idx["u:B"].at, idb.peek("areas", "u:B"), areaRecords(b, "u:B")], [`idb:${bRecord.id}`, bRecord, {}]);
      eq("U6 ほかの物（端末の鍵・ほかの値）は変わらない", Object.fromEntries(Object.entries(after).filter(([k]) => !k.startsWith("sd2."))), Object.fromEntries(Object.entries(before).filter(([k]) => !k.startsWith("sd2."))));
      // 見張りは、このページを止めて切り替えの画面へ（セッション B・領域 A）
      const tab = openTab(b);
      ok("U6 満杯の後のページ: 頭で止めて切り替えの画面へ（学習・保存をしない）", tab.log.stopped === 1 && tab.log.replaced.length === 1);
    }
    // U6 の続き: 展開の途中で満杯になり、そのあいだに退避した A の写しが読めなくなっても、元 A は手元の写し（退避の前に読んだ物）から書き戻す
    {
      const bigB = { ...B, spelldash_word_stats: "B".repeat(6000) };
      const b = new Backing({ ...migratedMarks("u:B", 1), "sd2.auth": session("B"), ...Object.fromEntries(Object.entries(bigB).map(([k, v]) => [K.physicalKey("u:B", k), v])) });
      const idb = new FakeIDB();
      b.set("sd2.auth", session("A"));
      await settle(b, { idb });
      for (const [k, v] of Object.entries(A)) b.set(K.physicalKey("u:A", k), v);
      b.set("zz.filler", "f".repeat(2000));
      b.limit = b.size() + 3000;
      let readsOfA = 0;
      idb.corruptRead = (store, v) => (store === "areas" && v.area === "u:A" && ++readsOfA > 1 ? { ...v, keys: {} } : v); // 読み直しの 1 回の後は読めない
      b.set("sd2.auth", session("B"));
      const r = await settle(b, { idb });
      eq("U6 満杯で、退避した A の写しがその後に読めなくなっても: A は localStorage に 1 字も違わず戻る・index は ls（手元の写しから）", [r.error?.reason, areaRecords(b, "u:A"), JSON.parse(b.get("sd2.index"))["u:A"].at], ["quota", sortedRec(A), "ls"]);
    }
    // 容量（手順 7 のほか）: 切り替えの印（手順 1・3）・index（手順 6・8）・領域の印（手順 9）の書き込みで満杯。どの空きでも、止まるなら理由は quota（復旧の画面で容量不足）・
    // 途中の印は残さない・元は localStorage にそろい index は ls・切り替え先の index は前のまま（写しを指す）。空きができれば次の 1 回で終わり、切り替え先は写しのとおり。
    // 写しの id は本物と同じ長さ（randomUUID）にする（index の伸びが本物と同じになる）
    {
      const UA = "11111111-2222-4333-8444-555555555555";
      const UB = "66666666-7777-4888-9999-aaaaaaaaaaaa";
      const uuidSettle = async (backing, idb) => {
        let t = Date.parse("2026-10-29T00:00:00Z");
        const sw = SW.createSwitcher({ ls: rawOf(backing), keys: K, openStore: () => ST.openAreaStore(idb), locks: new FakeLocks(), now: () => (t += 7), newId: () => globalThis.crypto.randomUUID(), sleep: async (ms) => { t += ms ?? 100; }, persist: async () => true });
        try {
          return { result: await sw.settle() };
        } catch (error) {
          return { error };
        }
      };
      for (const [label, F, T, Frec, Trec] of [
        ["A → B", `u:${UA}`, `u:${UB}`, A, B],
        ["ゲスト → アカウント（領域の印が伸びる）", "guest", `u:${UB}`, A, B],
        ["アカウント → 新しいゲスト（index が伸びる）", `u:${UA}`, "guest", A, null],
        ["小さいゲスト → 新しいアカウント（手順 8 の index・手順 9 の領域の印が伸びる）", "guest", `u:${UB}`, { spelldash_xp: "1" }, null]
      ]) {
        const bad = [];
        let stoppedQuota = 0;
        for (let head = 0; head <= 400; head += 3) {
          // T（あれば）を退避した後に F で学んだ端末
          const b = new Backing(Trec ? { ...migratedMarks(T, 1), "sd2.auth": session(T.slice(2)), ...Object.fromEntries(Object.entries(Trec).map(([k, v]) => [K.physicalKey(T, k), v])) } : { ...migratedMarks(F, 1) });
          if (T === "guest") b.remove("sd2.auth");
          const idb = new FakeIDB();
          if (Trec) {
            if (F === "guest") b.remove("sd2.auth");
            else b.set("sd2.auth", session(F.slice(2)));
            const r0 = await uuidSettle(b, idb);
            if (r0.error) { bad.push(`準備: ${r0.error.message}`); break; }
          } else {
            if (F === "guest") b.remove("sd2.auth");
            else b.set("sd2.auth", session(F.slice(2)));
            b.set("sd2.area", `${F}#1`);
            b.set("sd2.index", JSON.stringify({ [F]: { at: "ls", lastUsedAt: "2026-10-01T00:00:00.000Z" } }));
          }
          for (const [k, v] of Object.entries(Frec)) b.set(K.physicalKey(F, k), v);
          const indexBefore = JSON.parse(b.get("sd2.index"));
          if (T === "guest") b.remove("sd2.auth");
          else b.set("sd2.auth", session(T.slice(2)));
          b.limit = b.size() + head;
          const r = await uuidSettle(b, idb);
          if (!r.error) continue;
          const reason = r.error instanceof SW.SwitchError ? r.error.reason : `生の ${r.error.name}`;
          const idx = JSON.parse(b.get("sd2.index"));
          const got = [reason, b.get("sd2.switch"), isDeepStrictEqual(areaRecords(b, F), sortedRec(Frec)), idx[F]?.at, idx[T]?.at ?? null, Object.keys(areaRecords(b, T)).length, b.get("sd2.area")?.split("#")[0]];
          const want = ["quota", null, true, "ls", indexBefore[T]?.at ?? null, 0, F];
          if (!isDeepStrictEqual(got, want)) bad.push(`空き ${head}: ${JSON.stringify(got)}`);
          else stoppedQuota++;
          // 空きができた: 次の 1 回で終わり、切り替え先は写しのとおり・元は IndexedDB
          b.limit = Infinity;
          const again = await uuidSettle(b, idb);
          const done = [again.error?.reason ?? again.error?.message ?? null, b.get("sd2.area")?.split("#")[0], isDeepStrictEqual(areaRecords(b, T), Trec ? sortedRec(Trec) : {}), Object.keys(areaRecords(b, F)).length, isDeepStrictEqual(idb.peek("areas", F)?.keys, Frec)];
          if (!isDeepStrictEqual(done, [null, T, true, 0, true])) bad.push(`空き ${head} の後に空きができた: ${JSON.stringify(done)}`);
        }
        const uniq = bad.filter((x, i, a) => a.findIndex((y) => y.replace(/^空き \d+/, "") === x.replace(/^空き \d+/, "")) === i);
        eq(`U6 容量（${label}・空き 0〜400 字）: 止まるなら理由 quota・途中の印なし・元は localStorage で index は ls・切り替え先の index は前のまま・空きができれば次の 1 回で終わる`, uniq, []);
        ok(`U6 容量（${label}）: 止まる空きを 3 通り以上確かめた`, stoppedQuota >= 3, `${stoppedQuota} 通り`);
      }
      // 移行の途中の印（sd2.migrating）が満杯で入らない: 理由 quota・旧い記録はそのまま・もう一度を何回押しても legacy は 1 件（同じ中身の写しを増やさない）
      {
        const seed = { ...clean(personSeed("A")), spelldash_theme: "dark" };
        const b = new Backing(seed);
        b.limit = b.size() + 30;
        const before = b.dump();
        const idb = new FakeIDB();
        const r = await uuidSettle(b, idb);
        for (let i = 0; i < 3; i++) await uuidSettle(b, idb);
        eq("U3 移行の途中の印が満杯で入らない: 理由 quota・旧い記録はそのまま・もう一度 3 回で legacy は 1 件のまま", [r.error instanceof SW.SwitchError ? r.error.reason : `生の ${r.error?.name}`, isDeepStrictEqual(b.dump(), before), idb.all("legacy").length], ["quota", true, 1]);
        b.limit = Infinity;
        const done = await uuidSettle(b, idb);
        eq("U3 移行の途中の印が入らなかった端末: 空きができれば終わる・legacy は 1 件・印はその id", [done.error?.message ?? null, b.get("sd2.area"), idb.all("legacy").length, JSON.parse(b.get("sd2.migrated") ?? "{}").legacyId === idb.all("legacy")[0]?.id], [null, "guest#1", 1, true]);
      }
    }
    // 書き出し（復旧の画面）: 持ち主の値（tag）を入れ、生の user id は書かない。js/backup.js の EXCLUDE と同じ鍵（持ち主の鍵・同期の印・送信待ち・ログアウトの時刻）は入れない
    {
      const uid = "0f8d2c5e-1b7a-4c3d-9e8f-123456789abc";
      const rec = { ...A, spelldash_owner: uid, spelldash_xp_synced: "1200", spelldash_xp_write: "1", spelldash_logout_at: "2026-10-01T00:00:00.000Z", spelldash_learn_filled: "1" };
      const b = new Backing({ ...migratedMarks(`u:${uid}`, 2), "sd2.auth": session(uid), ...Object.fromEntries(Object.entries(rec).map(([k, v]) => [K.physicalKey(`u:${uid}`, k), v])), spelldash_theme: "dark", spelldash_typing_kind: "x" });
      const exp = await exportOf(b, new FakeIDB());
      const text = exp instanceof Error ? "" : JSON.stringify(exp);
      const tag = (await SW.ownerOf(`u:${uid}`, globalThis.crypto.subtle)).tag;
      eq("U4 書き出し: 持ち主はアカウントの値・生の user id は無い・EXCLUDE の鍵は入れない・ほかの記録と端末の鍵は入る", [exp?.owner ?? null, text.includes(uid), EXPORT_DROP.filter((k) => text.includes(`"${k}"`)), personOf(exp?.data), exp?.data?.spelldash_theme], [{ kind: "account", tag }, false, [], exportable(A), "dark"]);
      const migBackup = await (async () => {
        const old = new Backing({ ...clean(personSeed("A")), spelldash_owner: uid, spelldash_xp_synced: "3", spelldash_theme: "dark" });
        return exportOf(old, new FakeIDB());
      })();
      eq("U4 書き出し（移行の前）: 持ち主の鍵（生の user id）と同期の印は入れない", [migBackup instanceof Error ? migBackup.message : JSON.stringify(migBackup).includes(uid), migBackup?.data?.spelldash_xp_synced ?? null], [false, null]);
    }
    // 退避（IndexedDB）に失敗: 切り替えない
    for (const [name, inject, reason] of [["容量", (idb) => (idb.failPut = (store) => (store === "areas" ? quotaError() : null)), "quota"], ["読み直しが合わない", (idb) => (idb.corruptRead = (store, v) => (store === "areas" ? { ...v, keys: {} } : v)), "evacuate"]]) {
      const { b, idb } = await twoAreas();
      const before = b.dump();
      inject(idb);
      b.set("sd2.auth", session("B"));
      const r = await settle(b, { idb });
      eq(`U4 退避に失敗（${name}）: 止める・A は localStorage のまま・印も index も替えない`, [r.error?.reason, areaRecords(b, "u:A"), b.get("sd2.area"), b.get("sd2.index"), b.get("sd2.switch")], [reason, A, before["sd2.area"], before["sd2.index"], null]);
    }
    // swap の段: 元の鍵を消し始めた後に、ほかのタブ（凍って戻った）が書こうとしても拒む。localStorage に元の鍵を残さない
    {
      const { b, idb } = await twoAreas();
      const other = openTab(b);
      let during = null;
      b.set("sd2.auth", session("B"));
      const s1 = switcher(b, { idb, onRemove: (k) => { if (during === null && k.startsWith("sd2.u:A.")) during = other.tryWrite("spelldash_xp", "555"); } });
      let err = null;
      try {
        await s1.sw.settle();
      } catch (e) {
        err = e;
      }
      eq("U4 swap の段: 元の鍵を消している間のほかのタブの書き込みは拒む・切り替えの後に元の鍵が localStorage に残らない", [err?.message ?? null, during, areaRecords(b, "u:A"), areaRecords(b, "u:B"), idb.peek("areas", "u:A").keys], [null, "InvalidStateError", {}, B, A]);
    }
    // 切り替え先の写しが index の指す物でない・無い（ブラウザが消した等）: 元を消さずに止める
    for (const [name, change] of [["id が違う", (idb) => idb.poke("areas", { ...idb.peek("areas", "u:B"), id: "other" })], ["無い", (idb) => idb.dbs.get("spelldash-areas").stores.get("areas").data.delete("u:B")]]) {
      const { b, idb } = await twoAreas();
      change(idb);
      const before = b.dump();
      b.set("sd2.auth", session("B"));
      const r = await settle(b, { idb });
      eq(`U4 切り替え先の写しが${name}: 理由 target・A は localStorage のまま・印は替えない`, [r.error?.reason, areaRecords(b, "u:A"), b.get("sd2.area"), b.get("sd2.switch")], ["target", A, before["sd2.area"], null]);
    }
    // ほかのページ（凍ったタブ）が残っても進める。swap の後は、そのタブは書けない
    {
      const { b, idb } = await twoAreas();
      const locks = new FakeLocks();
      const frozen = openTab(b, { locks });
      ok("U4 凍ったタブ: 切り替えの前は書ける", frozen.tryWrite("spelldash_xp", "77") === "ok");
      b.set("sd2.auth", session("B"));
      const r = await settle(b, { idb, locks });
      eq("U4 凍ったタブが共有のロックを放さなくても切り替える・戻ったタブの A の書き込みは拒まれ、B に入らない", [r.error?.message ?? null, b.get("sd2.area"), frozen.tryWrite("spelldash_xp", "88"), areaRecords(b, "u:B").spelldash_xp, idb.peek("areas", "u:A").keys.spelldash_xp], [null, "u:B#3", "InvalidStateError", B.spelldash_xp, "77"]);
    }
    // 旧い場所の値（移行の後に旧コードのタブが書いた）: orphans へ写して消す・読まない
    {
      const b = new Backing({ ...migratedMarks("guest", 1), "sd2.guest.xp": "5", spelldash_owner: "sd2-moved", spelldash_xp: "999", spelldash_word_stats: "OLDTAB", [OLD_AUTH]: session("A") });
      const r = await settle(b);
      eq("U4 旧い場所の値は orphans へ写して localStorage から消す・旧い認証の鍵は消す・今の領域は変えない", [r.error?.message ?? null, r.idb.all("orphans").map((o) => o.keys), rawPersonKeys(b), b.get(OLD_AUTH), areaRecords(b, "guest")], [null, [{ spelldash_xp: "999", spelldash_word_stats: "OLDTAB" }], ["spelldash_owner"], null, { spelldash_xp: "5" }]);
    }
    // 旧い場所の片付けの途中（orphans へ写している間）に旧コードのタブが同じ鍵を書き直した: 写していない値を消さない（localStorage か orphans に残る）
    {
      const b = new Backing({ ...migratedMarks("guest", 1), "sd2.guest.xp": "5", spelldash_owner: "sd2-moved", spelldash_xp: "999" });
      const idb = new FakeIDB();
      idb.failPut = (store) => {
        if (store === "orphans" && b.get("spelldash_xp") === "999") b.set("spelldash_xp", "NEWER-FROM-OLD-TAB");
        return null;
      };
      const r = await settle(b, { idb });
      const kept = b.get("spelldash_xp") === "NEWER-FROM-OLD-TAB" || idb.all("orphans").some((o) => o.keys.spelldash_xp === "NEWER-FROM-OLD-TAB");
      eq("U4 旧い場所の片付けの途中に旧タブが書いた値: localStorage か orphans のどちらかに残る（写していない値を消さない）・写した値は orphans", [r.error?.message ?? null, kept, idb.all("orphans").some((o) => o.keys.spelldash_xp === "999")], [null, true, true]);
    }
    // 旧コードのタブ（「消して置き換える」の確認の OK）が持ち主の印を消し、自分の持ち主を書いた: 片付けの後は「移した」の印に戻る（§6 の 3）・旧タブの値は orphans
    {
      const b = new Backing({ ...migratedMarks("guest", 1), "sd2.guest.xp": "5", spelldash_owner: "A", spelldash_xp: "999" });
      const r = await settle(b);
      eq("U4 旧タブが持ち主の印を替えた後の片付け: 持ち主の鍵は「移した」の印・旧タブの持ち主の値は orphans", [r.error?.message ?? null, b.get("spelldash_owner"), r.idb.all("orphans").some((o) => o.keys.spelldash_owner === "A")], [null, "sd2-moved", true]);
    }
    // 見え方の古いタブ（確認の窓が開いたまま・長い処理の間に切り替わった）が、切り替えの後に退避した領域の鍵へ書いた（書くたびの確かめは古い印を読んで通す）:
    // localStorage に 2 人分を残さない。index が idb を指す領域（と index に無い印でない領域）の鍵は、写しと同じなら消し、違えば orphans に写して確かめてから消す
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      await settle(b, { idb }); // A → B（A は IndexedDB）
      const late = { spelldash_xp: "999", spelldash_memory_words: "[\"late\"]", spelldash_rank_peak: A.spelldash_rank_peak };
      for (const [k, v] of Object.entries(late)) b.set(K.physicalKey("u:A", k), v); // 見え方の古いタブの書き込み（rank_peak は写しと同じ値）
      const pageStops = openTab(new Backing(b.dump())).log.stopped;
      const r = await settle(b, { idb }); // 切り替えの画面を通る（セッション B のまま）
      const lateRec = idb.all("orphans").filter((o) => o.area === "u:A");
      eq("U4 退避した領域へ遅れて書かれた鍵: 切り替えの画面を通ると localStorage から消え（B だけ）・写しと違う値は orphans（領域つき）・写しと同じ値は写さない・A の写しは変えない・ページは頭で止めない",
        [r.error?.message ?? null, areaRecords(b, "u:A"), areaRecords(b, "u:B"), lateRec.map((o) => o.keys), idb.peek("areas", "u:A").keys, pageStops],
        [null, {}, B, [{ spelldash_xp: "999", spelldash_memory_words: "[\"late\"]" }], A, 0]);
      // A に戻る: 1 回で終わる（残りで「切り替え先」が止まらない）・A は写しのとおり
      b.set("sd2.auth", session("A"));
      const back = await settle(b, { idb });
      eq("U4 遅れて書かれた鍵を片付けた後に A へ戻る: 1 回で終わる・A は写しのとおり・B は IndexedDB", [back.error?.reason ?? back.error?.message ?? null, areaRecords(b, "u:A"), areaRecords(b, "u:B")], [null, sortedRec(A), {}]);
    }
    // 片付けを経ずに（残りがあるまま）その領域へ戻る: 1 回目で終わる・遅れた値は orphans（失わない）
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      await settle(b, { idb });
      b.set(K.physicalKey("u:A", "spelldash_xp"), "999");
      b.set(K.physicalKey("u:A", "spelldash_memory_words"), "[\"late\"]");
      b.set("sd2.auth", session("A"));
      const back = await settle(b, { idb });
      eq("U4 遅れて書かれた鍵が残ったまま A へ戻る: 1 回目で終わる（理由 target で止めない）・A は写しのとおり・遅れた値 999 は orphans に残る", [back.error?.reason ?? back.error?.message ?? null, areaRecords(b, "u:A"), idb.all("orphans").some((o) => o.area === "u:A" && o.keys.spelldash_xp === "999")], [null, sortedRec(A), true]);
    }
    // 切り替えの途中（手順 6 で元を消した後）に、元の領域へ見え方の古いタブが書いた: 終わった後に localStorage に残らず、orphans にある
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      let fired = false;
      const s1 = switcher(b, { idb, onRemove: (k) => { if (!fired && k.startsWith("sd2.u:A.")) { fired = true; b.set("sd2.u:A.late_key", "LATE"); } } });
      let err = null;
      try {
        await s1.sw.settle();
      } catch (e) {
        err = e;
      }
      eq("U4 手順 6 の後に元の領域へ遅れて書かれた鍵: 切り替えは終わる・localStorage には B だけ・遅れた値は orphans", [err?.message ?? null, b.get("sd2.area"), areaRecords(b, "u:A"), areaRecords(b, "u:B"), idb.all("orphans").some((o) => o.area === "u:A" && o.keys.spelldash_late_key === "LATE")], [null, "u:B#3", {}, B, true]);
    }
    // 退避の写しを確かめた後・元を消す前に、元の領域へ見え方の古いタブが書いた: その値を失わない（localStorage・A の写し・orphans のどれかに残る）
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      let fired = false;
      idb.corruptRead = (store, v) => {
        if (store === "areas" && v.area === "u:B" && !fired) {
          fired = true;
          b.set("sd2.u:A.xp", "LATE-WINDOW");
        }
        return v;
      };
      await settle(b, { idb });
      idb.corruptRead = null;
      const kept = b.get("sd2.u:A.xp") === "LATE-WINDOW" || idb.peek("areas", "u:A")?.keys.spelldash_xp === "LATE-WINDOW" || idb.all("orphans").some((o) => o.keys.spelldash_xp === "LATE-WINDOW");
      const both = Object.keys(areaRecords(b, "u:A")).length > 0 && Object.keys(areaRecords(b, "u:B")).length > 0;
      eq("U4 確かめた後・消す前に元へ遅れて書かれた値: 失わない・localStorage に 2 人分を残さない", [kept, both], [true, false]);
    }
    // 切り替え先の領域へ、展開の前に見え方の古いタブが書いていた（手順 1〜6 の間）: 写しで上書きして失わない（orphans）・展開は写しのとおり・1 回で終わる
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      let fired = false;
      const s1 = switcher(b, { idb, onRemove: (k) => { if (!fired && k.startsWith("sd2.u:A.")) { fired = true; b.set("sd2.u:B.xp", "STALE-B"); b.set("sd2.u:B.extra_key", "STALE-EXTRA"); } } });
      let err = null;
      try {
        await s1.sw.settle();
      } catch (e) {
        err = e;
      }
      const o = idb.all("orphans").filter((x) => x.area === "u:B").map((x) => x.keys);
      eq("U4 展開の前に切り替え先へ遅れて書かれた鍵: 切り替えは終わる・B は写しのとおり・遅れた値は orphans", [err?.reason ?? err?.message ?? null, areaRecords(b, "u:B"), o.some((k) => k.spelldash_xp === "STALE-B" && k.spelldash_extra_key === "STALE-EXTRA")], [null, B, true]);
    }
    // 展開の途中で満杯になって止める時、元の領域へ遅れて書かれた鍵を orphans へ写せない（IndexedDB に書けない）: 戻すときに遅れた値を重ねる（失わない）
    {
      const bigB = { ...B, spelldash_word_stats: "B".repeat(6000) };
      const b = new Backing({ ...migratedMarks("u:B", 1), "sd2.auth": session("B"), ...Object.fromEntries(Object.entries(bigB).map(([k, v]) => [K.physicalKey("u:B", k), v])) });
      const idb = new FakeIDB();
      b.set("sd2.auth", session("A"));
      await settle(b, { idb });
      for (const [k, v] of Object.entries(A)) b.set(K.physicalKey("u:A", k), v);
      b.set("zz.filler", "f".repeat(2000));
      b.limit = b.size() + 3000; // A を消しても B は入らない
      b.set("sd2.auth", session("B"));
      let fired = false;
      const s1 = switcher(b, { idb, onRemove: (k) => { if (!fired && k.startsWith("sd2.u:A.")) { fired = true; b.set("sd2.u:A.late_key", "LATE"); idb.failPut = (store) => (store === "orphans" ? new Error("broken") : null); } } });
      let err = null;
      try {
        await s1.sw.settle();
      } catch (e) {
        err = e;
      }
      eq("U6 満杯で止める時に遅れた鍵を写せない: 理由 quota・A は localStorage に戻り、遅れた値も残る・index は ls", [err?.reason ?? null, { ...areaRecords(b, "u:A"), spelldash_late_key: undefined }, b.get("sd2.u:A.late_key"), JSON.parse(b.get("sd2.index"))["u:A"].at], ["quota", { ...sortedRec(A), spelldash_late_key: undefined }, "LATE", "ls"]);
    }
    // 同じ形で、A と遅れた値の両方は入らない（A を戻す書き込みも容量で入らない）・遅れた値は orphans へ写せない: 戻す書き込みを取り消すときに、
    // 前からあった鍵（遅れた値。写しにある名前 xp も、無い名前 late_key も）を消さない。A は確かめた写し（index が指す）に、遅れた値は localStorage に残る
    // （失わない・2 人分を重ねない）。空きができれば次の 1 回で B へ切り替わり、遅れた値は orphans へ
    // （反証: 取り消しが今の値と同じ鍵を全部消し、遅れた値がどこにも残らなかった）
    {
      const bigB = { ...B, spelldash_word_stats: "B".repeat(4000) };
      const LATE = "LATE-" + "z".repeat(900);
      const b = new Backing({ ...migratedMarks("u:B", 1), "sd2.auth": session("B"), ...Object.fromEntries(Object.entries(bigB).map(([k, v]) => [K.physicalKey("u:B", k), v])) });
      const idb = new FakeIDB();
      b.set("sd2.auth", session("A"));
      await settle(b, { idb }); // B を退避・A は空で始まる
      for (const [k, v] of Object.entries(A)) b.set(K.physicalKey("u:A", k), v);
      b.set("sd2.auth", session("B"));
      b.limit = b.size() + 900; // A と印は入る。B は入らない。A と遅れた値の両方も入らない
      idb.failPut = (store) => (store === "orphans" ? quotaError() : null);
      let injected = false;
      const s1 = switcher(b, { idb, onRemove: (k) => {
        // 手順 6 で A の最後の鍵が消えた直後に、見え方の古い A のタブの書き込みが届く
        if (!injected && k.startsWith("sd2.u:A.") && !b.keys().some((x) => x.startsWith("sd2.u:A.")) && (b.get("sd2.switch") ?? "").includes('"swap"')) {
          injected = true;
          b.set("sd2.u:A.late_key", LATE);
          b.set("sd2.u:A.xp", "LATE-XP");
        }
      } });
      let err = null;
      try {
        await s1.sw.settle();
      } catch (e) {
        err = e;
      }
      const where = (value) => [
        ...b.keys().filter((k) => b.get(k) === value).map((k) => "ls:" + k),
        ...["orphans", "areas", "legacy"].flatMap((s) => idb.all(s).filter((r) => Object.values(r.keys ?? {}).includes(value)).map((r) => `${s}:${r.area ?? r.id}`))
      ];
      const idx = JSON.parse(b.get("sd2.index"));
      const aCopy = idb.peek("areas", "u:A");
      const aBack = idx["u:A"]?.at === "ls" && isDeepStrictEqual({ ...areaRecords(b, "u:A"), spelldash_late_key: undefined, spelldash_xp: undefined }, { ...sortedRec(A), spelldash_late_key: undefined, spelldash_xp: undefined });
      const aInCopy = idx["u:A"]?.at === `idb:${aCopy?.id}` && isDeepStrictEqual(aCopy?.keys, A);
      eq("U6 満杯で止める時、A と遅れた値の両方は入らず遅れた値も写せない: 理由 quota・遅れた値は失わない（localStorage に残る）・A は localStorage か確かめた写しにそろう・印は替えない・途中の印なし・B の鍵は無い",
        [injected, err?.reason ?? null, where(LATE), where("LATE-XP"), aBack || aInCopy, b.get("sd2.area"), b.get("sd2.switch"), Object.keys(areaRecords(b, "u:B")).length],
        [true, "quota", ["ls:sd2.u:A.late_key"], ["ls:sd2.u:A.xp"], true, "u:A#2", null, 0]);
      // 空きができ、IndexedDB にも書ける: 次の 1 回で B へ。遅れた値は orphans（A の領域として）・A の写しは A のまま
      b.limit = Infinity;
      idb.failPut = null;
      const again = await settle(b, { idb });
      eq("U6 その後に空きができた: 次の 1 回で B へ切り替わる・遅れた値は orphans（A の領域）・localStorage には B だけ・A の写しは A",
        [again.error?.reason ?? again.error?.message ?? null, b.get("sd2.area")?.split("#")[0], isDeepStrictEqual(areaRecords(b, "u:B"), sortedRec(bigB)), Object.keys(areaRecords(b, "u:A")).length, where(LATE), where("LATE-XP"), isDeepStrictEqual(idb.peek("areas", "u:A")?.keys, A)],
        [null, "u:B", true, 0, ["orphans:u:A"], ["orphans:u:A"], true]);
    }
    // 展開（手順 7）の途中で、見え方の古いタブが切り替え先 B の鍵（xp）へ書き、展開がその鍵を上書きした後に容量で止まる: 取り消しは、この展開が足した鍵を消し、
    // 上書きした鍵は前の値（ほかのタブが書いた値）に戻す（消さない）。その値は退避した B の localStorage の残りとして置かれる（次の片付けが orphans へ）。A は戻る
    {
      const Bx = { spelldash_a: "1", spelldash_xp: "40", spelldash_word_stats: "B".repeat(6000) };
      class Hook extends Backing {
        set(k, v) {
          super.set(k, v);
          this.hook?.(k, v);
        }
      }
      const b = new Hook({ ...migratedMarks("u:B", 1), "sd2.auth": session("B"), ...Object.fromEntries(Object.entries(Bx).map(([k, v]) => [K.physicalKey("u:B", k), v])) });
      const idb = new FakeIDB();
      b.set("sd2.auth", session("A"));
      await settle(b, { idb }); // B を退避（鍵の順は a・xp・word_stats）
      for (const [k, v] of Object.entries(A)) b.set(K.physicalKey("u:A", k), v);
      b.set("zz.filler", "f".repeat(2000));
      b.limit = b.size() + 3000; // A を消しても B は入らない
      b.set("sd2.auth", session("B"));
      let fired = false;
      b.hook = (k) => {
        if (!fired && k === "sd2.u:B.a") {
          fired = true;
          Backing.prototype.set.call(b, "sd2.u:B.xp", "STALE-B"); // 展開の途中にほかのタブが書いた
        }
      };
      const r = await settle(b, { idb });
      b.hook = null;
      eq("U6 展開の途中にほかのタブが書いた鍵を展開が上書きしてから容量で止まる: 理由 quota・その鍵は前の値（ほかのタブの値）に戻る・展開が足した鍵は無い・A は localStorage に戻る・印は替えない",
        [fired, r.error?.reason ?? null, b.get("sd2.u:B.xp"), b.get("sd2.u:B.a"), b.get("sd2.u:B.word_stats"), isDeepStrictEqual(areaRecords(b, "u:A"), sortedRec(A)), b.get("sd2.area")?.split("#")[0], b.get("sd2.switch")],
        [true, "quota", "STALE-B", null, null, true, "u:A", null]);
    }
    // 切り替えの前の片付け（退避した領域の遅れた鍵を orphans へ写す）が IndexedDB に書けない: 切り替えが要るときは止める
    // （元の領域を localStorage に置いたまま、遅れた鍵の領域の残りも置いたまま、別の領域を重ねて展開しない。§1.2）
    {
      const C = { spelldash_schema_version: "7", spelldash_word_stats: WS("C"), spelldash_xp: "333" };
      const idb = new FakeIDB();
      const store = await ST.openAreaStore(idb);
      await store.putVerified("areas", { area: "u:B", id: "b1", keys: B, savedAt: "2026-10-29T00:00:00.000Z", schema: "7", sum: ST.sumOf(B) });
      await store.putVerified("areas", { area: "u:C", id: "c1", keys: C, savedAt: "2026-10-29T00:00:00.000Z", schema: "7", sum: ST.sumOf(C) });
      store.close();
      const b = new Backing({ ...migratedMarks("u:A", 2, { "u:A": { at: "ls" }, "u:B": { at: "idb:b1" }, "u:C": { at: "idb:c1" } }), "sd2.auth": session("C"), ...Object.fromEntries(Object.entries(A).map(([k, v]) => [K.physicalKey("u:A", k), v])), "sd2.u:B.xp": "LATE-B" });
      const before = b.dump();
      idb.failPut = (s) => (s === "orphans" ? quotaError() : null);
      const r = await settle(b, { idb });
      eq("U4 切り替えの前の片付けを写せない: 止める（理由 quota）・印と index はそのまま・C を展開しない・遅れた B の値は残る・A はそのまま",
        [r.error?.reason ?? null, b.get("sd2.area"), b.get("sd2.index"), Object.keys(areaRecords(b, "u:C")).length, b.get("sd2.u:B.xp"), isDeepStrictEqual(areaRecords(b, "u:A"), sortedRec(A)), b.get("sd2.switch")],
        ["quota", "u:A#2", before["sd2.index"], 0, "LATE-B", true, null]);
    }
    // 展開した記録を読み直して比べる（§1.2 写して読み直して確かめてから index を替える）: 切り替え先の鍵の書き込みが黙って消える保存では、
    // 切り替え先を有効にしない（index は切り替え先の写しを指したまま・元は localStorage に戻る・印は替えない）
    {
      class DropB extends Backing {
        set(k, v) {
          if (this.dropB && String(k).startsWith("sd2.u:B.")) return;
          super.set(k, v);
        }
      }
      const b = new DropB({ ...migratedMarks("u:B", 1), "sd2.auth": session("B"), ...Object.fromEntries(Object.entries(B).map(([k, v]) => [K.physicalKey("u:B", k), v])) });
      const idb = new FakeIDB();
      b.set("sd2.auth", session("A"));
      await settle(b, { idb }); // B → A（B は IndexedDB）
      for (const [k, v] of Object.entries(A)) b.set(K.physicalKey("u:A", k), v);
      const bAt = JSON.parse(b.get("sd2.index"))["u:B"].at;
      b.dropB = true;
      b.set("sd2.auth", session("B"));
      const r = await settle(b, { idb });
      const idx = JSON.parse(b.get("sd2.index"));
      eq("U4 展開した切り替え先が localStorage に入っていない（黙って消える保存）: 止める（理由 target）・印は A のまま・A は localStorage にそろう・index は B の写しを指したまま",
        [r.error?.reason ?? null, b.get("sd2.area")?.split("#")[0], isDeepStrictEqual(areaRecords(b, "u:A"), sortedRec(A)), idx["u:A"]?.at, idx["u:B"]?.at, b.get("sd2.switch")],
        ["target", "u:A", true, "ls", bAt, null]);
    }
    // 退避した領域の残りの片付けで、orphans へ写している間に見え方の古いタブが同じ鍵を書き直した: 消す直前に読み直し、写していない値を消さない
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      await settle(b, { idb }); // A → B（A は IndexedDB）
      b.set("sd2.u:A.xp", "999"); // 見え方の古いタブが A へ遅れて書いた
      idb.failPut = (s) => {
        if (s === "orphans" && b.get("sd2.u:A.xp") === "999") b.set("sd2.u:A.xp", "NEWER-LATE"); // 写している間にもう一度
        return null;
      };
      const r = await settle(b, { idb });
      const kept = b.get("sd2.u:A.xp") === "NEWER-LATE" || idb.all("orphans").some((o) => o.keys?.spelldash_xp === "NEWER-LATE");
      eq("U4 退避した領域の片付けの途中に遅れて書かれた値: localStorage か orphans に残る（写していない値を消さない）・写した値は orphans", [r.error?.message ?? null, kept, idb.all("orphans").some((o) => o.area === "u:A" && o.keys?.spelldash_xp === "999")], [null, true, true]);
    }
    // 直し（sd2.switch が残っていた）で、index が idb を指す領域の鍵が写しと違う（遅れて書かれた）: 消さずに orphans へ
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      await settle(b, { idb });
      b.set("sd2.switch", JSON.stringify({ id: "x", op: "session", from: "u:B", to: "u:A", phase: "swap", at: "2026-10-29T00:00:00.000Z" }));
      b.set(K.physicalKey("u:A", "spelldash_xp"), A.spelldash_xp); // 途中まで書いた（写しと同じ）
      b.set(K.physicalKey("u:A", "spelldash_word_stats"), "LATE-WS"); // 遅れて書かれた（写しと違う）
      const r = await settle(b, { idb });
      eq("U4 直しで、退避した領域の鍵が写しと違う: 消さずに orphans へ・写しと同じ鍵は写さない・直した後は B だけ", [r.error?.message ?? null, areaRecords(b, "u:A"), areaRecords(b, "u:B"), idb.all("orphans").filter((o) => o.area === "u:A").map((o) => o.keys)], [null, {}, B, [{ spelldash_word_stats: "LATE-WS" }]]);
    }
    // 直しで、遅れて書かれた値を orphans へ写せない（IndexedDB に書けない）: 消さない・途中の印を残す（どのページも頭で止まり、復旧の画面）
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      await settle(b, { idb });
      b.set("sd2.switch", JSON.stringify({ id: "x", op: "session", from: "u:B", to: "u:A", phase: "swap", at: "2026-10-29T00:00:00.000Z" }));
      b.set(K.physicalKey("u:A", "spelldash_word_stats"), "LATE-WS");
      idb.failPut = (store) => (store === "orphans" ? new Error("broken") : null);
      const r = await settle(b, { idb });
      eq("U4 直しで遅れた値を写せない: 止める（理由 evacuate）・遅れた値は localStorage に残る・途中の印は残る（ページは頭で止まる）", [r.error?.reason ?? r.error?.message ?? null, b.get("sd2.u:A.word_stats"), b.get("sd2.switch") !== null, openTab(new Backing(b.dump())).log.stopped], ["evacuate", "LATE-WS", true, 1]);
    }
    // アプリのページからの片付け: 移行の前・移行の途中は、旧い場所の記録にも退避した領域の鍵にも触れない（移行が読む本体を orphans へ移さない）
    {
      const deps = { keys: K, locks: new FakeLocks(), openStore: () => ST.openAreaStore(new FakeIDB()) };
      const pre = new Backing({ ...clean(personSeed("A")), spelldash_theme: "dark" });
      const preBefore = pre.dump();
      const n1 = await SW.sweepOrphansFromPage(rawOf(pre), deps).catch((e) => e.message);
      const mid = new Backing({ ...clean(personSeed("A")), ...migratedMarks("guest", 1), "sd2.migrating": JSON.stringify({ legacyId: "L1", area: "guest", at: "2026-10-29T00:00:00.000Z" }) });
      mid.remove("sd2.migrated");
      const midBefore = mid.dump();
      const n2 = await SW.sweepOrphansFromPage(rawOf(mid), deps).catch((e) => e.message);
      eq("U4 ページからの片付け: 移行の前・移行の途中は何もしない（旧い場所の記録をそのまま残す）", [n1, isDeepStrictEqual(pre.dump(), preBefore), n2, isDeepStrictEqual(mid.dump(), midBefore)], [0, true, 0, true]);
    }
    // アプリのページからの片付け（見張りが見つけたとき）: 退避した領域の鍵も orphans へ写して消す。切り替え・移行の途中は何もしない
    {
      const { b, idb } = await twoAreas();
      b.set("sd2.auth", session("B"));
      await settle(b, { idb });
      b.set(K.physicalKey("u:A", "spelldash_xp"), "999");
      const deps = { keys: K, locks: new FakeLocks(), openStore: () => ST.openAreaStore(idb) };
      b.set("sd2.switch", JSON.stringify({ id: "y", phase: "drain" }));
      const during = typeof SW.sweepOrphansFromPage === "function" ? await SW.sweepOrphansFromPage(rawOf(b), deps).catch((e) => e.message) : "（無い）";
      const kept = b.get("sd2.u:A.xp");
      b.remove("sd2.switch");
      await SW.sweepOrphansFromPage(rawOf(b), deps).catch(() => {});
      eq("U4 ページからの片付け: 切り替えの途中は退避した領域の鍵に触れない・終わった後は orphans へ写して消す", [during === 0 || during === undefined, kept, areaRecords(b, "u:A"), idb.all("orphans").some((o) => o.area === "u:A" && o.keys.spelldash_xp === "999")], [true, "999", {}, true]);
    }
    // drain の段（§3 の 2）: ほかのページが共有のロックを持つ間は待つ。そのページの最後の書き込みは通り、その値が A の退避の写しに入る
    {
      const { b, idb } = await twoAreas();
      const locks = new FakeLocks();
      const other = openTab(b); // ページの見張り（書き込みの確かめ）
      const release = locks.hold("spelldash-page"); // そのページの共有のロック
      let sleeps = 0;
      let wrote = null;
      b.set("sd2.auth", session("B"));
      const r = await settle(b, { idb, locks, onSleep: () => {
        sleeps++;
        if (sleeps === 2) {
          wrote = other.tryWrite("spelldash_xp", "LAST-IN-DRAIN");
          release();
        }
      } });
      eq("U4 drain の段: ほかのページがロックを放すまで待つ・その間の最後の書き込みは通り、A の退避の写しに入る", [r.error?.message ?? null, wrote, idb.peek("areas", "u:A")?.keys.spelldash_xp, b.get("sd2.area")?.split("#")[0]], [null, "ok", "LAST-IN-DRAIN", "u:B"]);
    }
    // 前の切り替えが落ちた（タブを閉じた）後、やり直しも失敗する（満杯・切り替え先の写しが無い・控えが開けない）:
    // 元 A は localStorage に 1 字も違わずそろい（写しから書き戻す）、index は ls・印は A・B の鍵は無い。書き出しは A と A の持ち主の値。
    // 控えが開けないときは、A が localStorage にそろっていればそれを書き出し、写しにしか無ければ書き出さない（途中まで消した A を A の持ち主の値で出さない）
    {
      const tagA = (await SW.ownerOf("u:A", globalThis.crypto.subtle)).tag;
      const tagB = (await SW.ownerOf("u:B", globalThis.crypto.subtle)).tag;
      const fullSetup = async () => {
        const bigB = { ...B, spelldash_word_stats: "B".repeat(6000) };
        const b = new Backing({ ...migratedMarks("u:B", 1), "sd2.auth": session("B"), ...Object.fromEntries(Object.entries(bigB).map(([k, v]) => [K.physicalKey("u:B", k), v])) });
        const idb = new FakeIDB();
        b.set("sd2.auth", session("A"));
        await settle(b, { idb }); // B を退避
        for (const [k, v] of Object.entries(A)) b.set(K.physicalKey("u:A", k), v);
        b.set("zz.filler", "f".repeat(2000));
        b.limit = b.size() + 3000; // A を消しても B（6000 字）は入らない
        return { b, idb, Bx: bigB };
      };
      const plainSetup = async () => ({ ...(await twoAreas()), Bx: B });
      const cases = [
        ["満杯", fullSetup, () => {}],
        ["切り替え先の写しが無い", plainSetup, (idb) => idb.dbs.get("spelldash-areas").stores.get("areas").data.delete("u:B")],
        ["控えが開けない", plainSetup, (idb) => (idb.failOpen = new Error("Connection to Indexed Database server lost"))]
      ];
      for (const [label, setup, inject] of cases) {
        let points = 0;
        const bad = [];
        for (let n = 1; n < 80; n++) {
          const { b, idb, Bx } = await setup();
          b.set("sd2.auth", session("B"));
          const first = await settle(b, { idb, crashAt: n });
          if (!first.error || !isCrash(first.error)) break;
          points++;
          inject(idb);
          const second = await settle(b, { idb });
          const idx = JSON.parse(b.get("sd2.index"));
          const exp = await exportOf(b, idb);
          const expPerson = exp instanceof Error ? null : personOf(exp.data);
          if (!second.error) {
            if (!(isDeepStrictEqual(areaRecords(b, "u:B"), sortedRec(Bx)) && isDeepStrictEqual(areaRecords(b, "u:A"), {}) && isDeepStrictEqual(idb.peek("areas", "u:A")?.keys, A))) bad.push(`${n}: やり直しで終わったが B と A がそろわない`);
            continue;
          }
          const lsA = areaRecords(b, "u:A");
          if (label !== "控えが開けない") {
            const got = [isDeepStrictEqual(lsA, sortedRec(A)), idx["u:A"]?.at, b.get("sd2.area")?.split("#")[0], b.get("sd2.switch"), Object.keys(areaRecords(b, "u:B")).length, isDeepStrictEqual(expPerson, exportable(A)), exp?.owner?.tag === tagA];
            if (!isDeepStrictEqual(got, [true, "ls", "u:A", null, 0, true, true])) bad.push(`${n}: ${JSON.stringify(got)}（${second.error.reason}）`);
          } else if (idx["u:A"]?.at === "ls") {
            if (!(isDeepStrictEqual(lsA, sortedRec(A)) && isDeepStrictEqual(expPerson, exportable(A)) && exp?.owner?.tag === tagA)) bad.push(`${n}: A は localStorage にあるが書き出しが A と違う`);
          } else if (idx["u:B"]?.at === "ls") {
            // 落ちたのが B をそろえて index を替えた後: B が localStorage にそろっている。書き出しは B（B の持ち主）
            if (!(isDeepStrictEqual(areaRecords(b, "u:B"), sortedRec(Bx)) && isDeepStrictEqual(expPerson, exportable(Bx)) && exp?.owner?.tag === tagB && isDeepStrictEqual(idb.peek("areas", "u:A")?.keys, A))) bad.push(`${n}: B は localStorage にあるが書き出しが B と違う`);
          } else if (!(exp instanceof Error && isDeepStrictEqual(idb.peek("areas", "u:A")?.keys, A))) bad.push(`${n}: A は写しにしか無いのに、書き出しが ${exp instanceof Error ? "失敗" : Object.keys(expPerson).length + " 鍵の途中の A"}`);
        }
        eq(`U4 前の切り替えが落ちた後のやり直しも失敗（${label}・${points} 点）: A は写しから localStorage にそろい index は ls・書き出しは A（途中の A を出さない）`, bad, []);
        ok(`U4 前の切り替えが落ちた後のやり直し（${label}）: 全部の書き込みの点で落として確かめた（8 点以上）`, points >= 8, `${points} 点`);
      }
    }
    // 書き出しは index が idb を指す領域の localStorage の残りを読まない。localStorage に今の領域が無ければ、index が指す確かめた写しを書き出す
    {
      const idb = new FakeIDB();
      const store = await ST.openAreaStore(idb);
      await store.putVerified("areas", { area: "u:A", id: "a1", keys: A, savedAt: "2026-10-29T00:00:00.000Z", schema: "7", sum: ST.sumOf(A) });
      store.close();
      const b = new Backing({ ...migratedMarks("u:A", 3, { "u:A": { at: "idb:a1" }, "u:B": { at: "idb:b1" } }), "sd2.auth": session("B"), "sd2.u:A.xp": A.spelldash_xp, "sd2.u:B.xp": "999" });
      const exp = await exportOf(b, idb);
      const tagA = (await SW.ownerOf("u:A", globalThis.crypto.subtle)).tag;
      eq("U4 書き出し: localStorage に今の領域が無い端末は、index が指す A の写し（全部）と A の持ち主の値・残りの鍵（途中の A・B）は読まない", [exp instanceof Error ? exp.message : personOf(exp.data), exp?.owner?.tag === tagA], [exportable(A), true]);
      idb.failOpen = new Error("lost");
      const exp2 = await exportOf(b, idb);
      ok("U4 書き出し: その写しが読めなければ書き出さない（途中の A を A の持ち主の値で出さない）", exp2 instanceof Error);
    }
  }
}

// =====================================================================
await runAll();
const baseFailures = failures;
const basePassed = passed;

// ── U9 の一部: 変異（手順を 1 つずつ壊すと、どれかが落ちる） ─────────────────────────────
const MUTANTS = [
  ["見張り: 書くたびの領域の印を見ない", "guard", "get(AREA_KEY) === pageMarker && !swapPhase()", "!swapPhase()"],
  ["見張り: swap の段を見ない", "guard", "&& !swapPhase() && sessionArea === pageArea;", "&& sessionArea === pageArea;"],
  ["見張り: セッションの人を見ない", "guard", "&& !swapPhase() && sessionArea === pageArea;", "&& !swapPhase();"],
  ["見張り: 読むのを読み替えない", "guard", "return pageArea === null ? null : rawGet.call(this, physicalKey(pageArea, name));", ""],
  ["見張り: ほかの領域の知らせも届ける", "guard", "      event.stopImmediatePropagation();\n      const name = logicalKey(pageArea, key);", "      const name = logicalKey(pageArea, key);"],
  ["見張り: 頭でセッションの人と領域を比べない", "guard", "if (sessionArea !== marker.area) return stopAndSwitch();", ""],
  ["見張り: 初めての端末の判定で旧い記録を見ない", "guard", "isPersonKey(key) || key === OLD_AUTH_KEY || ", ""],
  ["見張り: 使えないブラウザでも止めない（IndexedDB）", "guard", 'if (!hasIdb) return unsupported("indexeddb");', ""],
  ["見張り: 同期の印を消さない", "guard", "for (const flag of SYNC_FLAGS) ss.removeItem(flag);", ""],
  ["控え: 読み直しで比べない", "store", "if (!back || back.id !== record.id || back.sum !== record.sum || !sameKeys(back.keys, record.keys) || sumOf(back.keys) !== record.sum) {", "if (false) {"],
  ["控え: durability strict で書かない", "store", '{ durability: "strict" }', "{}"],
  ["移行: 旧い本体を消さない", "switch", "    for (const key of legacyKeys()) if (legacy.keys[key] === ls.get(key)) ls.remove(key);\n    try {", "    try {"],
  ["移行: 旧い本体を値を比べずに全部消す（旧タブが後から書いた値を orphans に回さず失う）", "switch", "    for (const key of legacyKeys()) if (legacy.keys[key] === ls.get(key)) ls.remove(key);\n    try {", "    for (const key of legacyKeys()) ls.remove(key);\n    try {"],
  ["移行: 入らないとき今の鍵の旧い本体だけ消す（書き終えた鍵の旧い本体が場所を取ったまま）", "switch", "          if (!isQuotaError(error) || !freeOldBodies()) throw error;", "          if (!isQuotaError(error)) throw error;\n          ls.remove(name);"],
  ["移行: 終わりの印が入らないときに途中の印を先に消さない", "switch", "        if (!isQuotaError(error)) throw error;\n        const moving = ls.get(K.MIGRATING_KEY);", "        throw error;\n        const moving = ls.get(K.MIGRATING_KEY);"],
  ["移行: 認証の鍵が並んで入らないときに旧い鍵を先に消さない", "switch", "          if (!isQuotaError(error)) throw error;\n          // 両方は入らない: 旧い鍵を先に消してから書く", "          throw error;\n          // 両方は入らない: 旧い鍵を先に消してから書く"],
  ["移行: 持ち主の印を見ない", "switch", "if (typeof owner === \"string\" && owner && owner !== K.OWNER_MOVED) return K.areaOfUser(owner);", ""],
  ["移行: 認証のセッションを移さない", "switch", "      ls.set(K.OWNER_KEY, K.OWNER_MOVED);\n      moveAuth();", "      ls.set(K.OWNER_KEY, K.OWNER_MOVED);"],
  ["移行: legacy に写さない", "switch", "        await store.putVerified(\"legacy\", legacy);", ""],
  ["切り替え: 退避の写しを書かない", "switch", "await store.putVerified(\"areas\", { area, id, keys: snapshot,", "await Promise.resolve({ area, id, keys: snapshot,"],
  ["切り替え: swap の段にしない", "switch", 'ls.set(K.SWITCH_KEY, JSON.stringify({ ...flag, phase: "swap" }));', ""],
  ["切り替え: 満杯のときに元を書き戻さない", "switch", '      for (const [area, snapshot] of archived) if (readIndex()[area]?.at !== "ls") restore(area, { ...snapshot, ...collect(area) });', ""],
  ["切り替え: 満杯のときに書いた切り替え先を消さない", "switch", [["        if (wroteTarget) for (const [name, value] of Object.entries(incoming ?? {})) if (ls.get(K.physicalKey(target, name)) === value) ls.remove(K.physicalKey(target, name));\n", ""], ["      for (const [phys, prior, value] of wrote) if (prior === null && ls.get(phys) === value) ls.remove(phys);\n", ""]]],
  ["切り替え: 前の切り替えが落ちた後のやり直しが失敗しても、元を写しから戻さない", "switch", "      if (from && from !== target && liveAreas().length === 0) {", "      if (false) {"],
  ["切り替え: drain の段でページのロックを待たない", "switch", "    await drain();\n", "\n"],
  ["切り替え: drain の待ちの上限 0", "switch", "const DRAIN_MAX_MS = 3000;", "const DRAIN_MAX_MS = 0;"],
  ["切り替え: 先に印を替える", "switch", "    const archived = [];", "    ls.set(K.AREA_KEY, K.formatMarker(target, gen));\n    const archived = [];"],
  ["切り替え: 切り替え先の写しの id を比べない", "switch", "if (!record || `idb:${record.id}` !== at || sumOf(record.keys) !== record.sum) return null;", "if (!record) return null;"],
  ["書き出し: index が idb を指す印の領域の localStorage の残りを書き出す", "switch", '    area = Object.keys(index).find((a) => index[a]?.at === "ls") ?? null;', '    area = Object.keys(index).find((a) => index[a]?.at === "ls") ?? marker?.area ?? null;'],
  ["書き出し: 移行の途中に legacy を読まない", "switch", '    person = await readVerified("legacy", migrating.legacyId, (record) => record.id === migrating.legacyId);', "    person = null;"],
  ["戻り先: 確かめない（外の URL も受ける）", "switch", [['  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\u0000-\\u001f\\u007f\\\\]/.test(value)) return "/";', '  if (typeof value !== "string") return "/";'], ['  if (url.origin !== new URL(base).origin || url.pathname === "/switch.html") return "/";', '  if (url.pathname === "/switch.html") return "/";']]],
  ["戻り先: ? の後ろに置く", "guard", 'return SWITCH_PATH + "#back=" + encodeURIComponent(here);', 'return SWITCH_PATH + "?back=" + encodeURIComponent(here);'],
  ["見張り: 読み込みの確かめ（selfTest）をしない", "guard", '  if (!selfTest()) return unsupported("selftest");', ""],
  ["見張り: 戻ったタブ（pageshow・focus）で確かめ直さない", "guard", '  root.addEventListener("pageshow", recheck);\n  root.addEventListener("focus", () => recheck());', ""],
  ["見張り: 戻ったタブ（visibilitychange）で確かめ直さない", "guard", '      if (doc.visibilityState === "visible") recheck();', ""],
  ["直し: idb を指す領域の残りを片付けない", "switch", "    const removed = await sweepStale(store);", "    const removed = 0;"],
  ["直し: idb を指す領域の残りを写しと比べずに消す（遅れて書かれた値を失う）", "switch", "    const removed = await sweepStale(store);", "    let removed = 0;\n    for (const [area, entry] of Object.entries(readIndex())) if (typeof entry?.at === \"string\" && entry.at.startsWith(\"idb:\")) for (const key of physicalOf(area)) { ls.remove(key); removed++; }"],
  ["片付け: 旧い場所の値を消さない", "switch", "      for (const key of names) if (ls.get(key) === found[key]) ls.remove(key);", ""],
  // 反証の役の変異（S/b78/rvareas/tests2/mymutants.out の G1・S7・S8・G8a・G8b）
  ["見張り: 同じタブのログアウト（sd2.auth の removeItem）で覚え直さない", "guard", "          const result = rawRemove.apply(this, arguments);\n          noteSession();", "          const result = rawRemove.apply(this, arguments);"],
  ["片付け: 持ち主の印が消えていても書き直さない", "switch", "    if (ls.get(K.OWNER_KEY) === null) {", "    if (false) {"],
  ["片付け: 写した後に値を比べずに消す（写している間に旧タブが書いた値を失う）", "switch", "      for (const key of names) if (ls.get(key) === found[key]) ls.remove(key);", "      for (const key of names) ls.remove(key);"],
  ["見張り: 自分の確かめが容量でない例外で投げても止めない", "guard", "      return quota && ls.setItem === P.setItem && ls.getItem(PROBE_KEY) === get(phys);", "      return true;"],
  ["見張り: 満杯の端末（確かめの書き込みが容量で入らない）で止める", "guard", "      return quota && ls.setItem === P.setItem && ls.getItem(PROBE_KEY) === get(phys);", "      return false;"],
  // 見え方の古いタブが退避した領域へ遅れて書いた鍵（反証 fix2 の 1）
  ["退避した領域の残り: 切り替えの画面で切り替えの前に片付けない", "switch", "      let staleError = null;\n      try {\n        await sweepStale(store);", "      let staleError = null;\n      try {\n        await Promise.resolve();"],
  ["退避した領域の残り: 切り替えの後に片付けない", "switch", "      if (result) {\n        try {\n          await sweepStale(store);", "      if (false) {\n        try {\n          await sweepStale(store);"],
  ["退避した領域の残り: orphans に写さずに消す", "switch", "        await store.putVerified(\"orphans\", { id: newId(), savedAt: iso(), area, keys: late, sum: sumOf(late) });", ""],
  ["退避した領域の残り: 写しと同じ値も orphans に写す", "switch", "      for (const [name, value] of Object.entries(found)) if (!copy || copy[name] !== value) late[name] = value;", "      for (const [name, value] of Object.entries(found)) late[name] = value;"],
  ["切り替え: 手順 6 で元を消す直前に写しと比べない", "switch", "        if (!sameKeys(collect(area), snapshot)) throw await stop(\"changed\");\n        writeIndex(", "        writeIndex("],
  ["切り替え: 展開の前に切り替え先の残りを片付けない", "switch", "      if (!live.includes(target) && physicalOf(target).length > 0) {", "      if (false) {"],
  ["切り替え: 止める時に元の領域の遅れた値を戻す記録に重ねない", "switch", [["{ ...snapshot, ...collect(area) }", "snapshot"], ["{ ...copy, ...collect(from) }", "copy"]]],
  ["切り替え: 止めるときに切り替え先の index を前に戻さない", "switch", "        if (JSON.stringify(idx[target] ?? null) !== JSON.stringify(targetBefore ?? null)) {", "        if (false) {"],
  ["切り替え: 手順 1 の印が入らないとき容量と言わない", "switch", "      ls.set(K.SWITCH_KEY, JSON.stringify(flag));\n    } catch (error) {\n      throw fail(isQuotaError(error) ? \"quota\" : \"evacuate\", error);", "      ls.set(K.SWITCH_KEY, JSON.stringify(flag));\n    } catch (error) {\n      throw error;"],
  ["切り替え: 手順 3・6・8・9 が容量で入らないとき退避の失敗と言う", "switch", "      if (error instanceof SwitchError || stopping) throw error;\n      throw await stop(isQuotaError(error) ? \"quota\" : \"evacuate\", error);", "      if (error instanceof SwitchError || stopping) throw error;\n      throw await stop(\"evacuate\", error);"],
  ["移行: 途中の印が入らないとき容量と言わない", "switch", "        // 途中の印が入らない: 旧い記録はそのまま（まだ何も移していない）。復旧の画面で容量不足を出す\n        throw fail(isQuotaError(error) ? \"quota\" : \"migrate\", error);", "        throw error;"],
  ["移行: 同じ中身の確かめた legacy を使い回さない", "switch", "      if (found) legacy = found;", "      if (false) legacy = found;"],
  ["ページからの片付け: 切り替え・移行の途中でも片付ける", "switch", "    if (raw.get(K.SWITCH_KEY) !== null || raw.get(K.MIGRATING_KEY) !== null || raw.get(K.MIGRATED_KEY) === null) return 0;", ""],
  ["ページからの片付け: 退避した領域の残りを片付けない", "switch", "      return old + (await switcher.sweepStale(store, { page: true }));", "      return old;"],
  ["見張り: 頭で退避した領域の残りを見つけない", "guard", "      return hit !== null && hit.area !== pageArea && isStaleArea(hit.area, index, pageArea);", "      return false;"],
  ["見張り: 退避した領域の鍵の知らせで片付けを頼まない", "guard", "        if (hit && hit.area !== pageArea && isStaleArea(hit.area, readJson(get(INDEX_KEY)), pageArea)) scheduleSweep();", ""],
  // 書き出し（反証 fix2 の 3）
  ["書き出し: 持ち主の鍵・同期の印を除かない", "switch", "  for (const key of K.EXPORT_EXCLUDE ?? []) delete data[key];", ""],
  ["見張りの書き出し: 持ち主の鍵・同期の印を除かない", "guard", "      for (const key of EXPORT_EXCLUDE) delete data[key];", ""],
  ["見張りの書き出し: 持ち主の値を付けない", "guard", "    if (owner) backup.owner = owner;", ""],
  // 反証 fix3（S/b78/rvareas/tests3 の G40〜G42・S29・S9・S4・S23・S6・St5 と storage3 の遅れた値）
  ["見張り: setItem の読み替えを sessionStorage にも当てる（this が localStorage かを見ない）", "guard", "    P.setItem = function setItem(key, value) {\n      if (this === ls && arguments.length > 1) {", "    P.setItem = function setItem(key, value) {\n      if (arguments.length > 1) {"],
  ["見張り: removeItem の読み替えを sessionStorage にも当てる（タブの同期の印が消えない）", "guard", "    P.removeItem = function removeItem(key) {\n      if (this === ls && arguments.length > 0) {", "    P.removeItem = function removeItem(key) {\n      if (arguments.length > 0) {"],
  ["見張り: getItem の読み替えを sessionStorage にも当てる", "guard", "    P.getItem = function getItem(key) {\n      if (this === ls && arguments.length > 0) {", "    P.getItem = function getItem(key) {\n      if (arguments.length > 0) {"],
  ["切り替え: 切り替えの前の片付けが写せなくても切り替える（元の残りに別の領域を重ねる）", "switch", "    if (staleError) throw fail(isQuotaError(staleError) ? \"quota\" : \"evacuate\", staleError);\n", ""],
  ["移行: 新しい鍵を読み直して legacy と比べない（新しい領域への移行を確かめない）", "switch", "    for (const [name, value] of Object.entries(legacy.keys)) if (ls.get(K.physicalKey(area, name)) !== value) throw fail(\"migrate\");\n", ""],
  ["切り替え: 展開した記録を読み直して比べない", "switch", "      if (!sameKeys(collect(area), keys)) throw new AreaStoreError(\"verify\", \"書き戻すと中身が合わなかった。\");\n", ""],
  ["退避した領域の残り: 消す直前に読み直さない（写している間に書かれた値を消す）", "switch", "if (ls.get(phys) === value && K.isStaleArea(area, readIndex(), markerNow()?.area ?? null)) {", "if (true) {"],
  ["切り替え: persist() を頼まない", "switch", "    persistAsked = true;\n    try {\n      await persist();", "    persistAsked = true;\n    try {\n      void persist;"],
  ["控え: askPersist が navigator.storage.persist() を呼ばない", "store", "    return Boolean(await storage.persist());", "    return false;"],
  ["書き戻しの取り消し: 前からあった鍵も、今の値が同じなら消す（止めるときに戻す元の領域の遅れた値を失う）", "switch", [["      for (const [phys, prior, value] of wrote) if (prior === null && ls.get(phys) === value) ls.remove(phys);\n", "      for (const [phys, , value] of wrote) if (ls.get(phys) === value) ls.remove(phys);\n      for (const [name, value] of Object.entries(keys)) if (ls.get(K.physicalKey(area, name)) === value) ls.remove(K.physicalKey(area, name));\n"]]],
  ["書き戻しの取り消し: 前からあった同じ名前の鍵を前の値に戻さない", "switch", "        if (prior === null || ls.get(phys) !== value) continue;", "        continue;"]
];
let mutantReport = [];
if (MUTATE && baseFailures.length === 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "areas-mut-"));
  const files = { guard: "js/areaGuard.js", switch: "js/areaSwitch.js", store: "js/areaStore.js" };
  const original = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(path.join(ROOT, f), "utf8")]));
  let n = 0;
  for (const [name, file, from, to] of MUTANTS) {
    n++;
    const pairs = Array.isArray(from) ? from : [[from, to]];
    if (!pairs.every(([a]) => original[file].includes(a))) {
      mutantReport.push(`${name}: 変異の元の文が見つからない（テストを直す）`);
      continue;
    }
    const d = path.join(dir, String(n), "js");
    fs.mkdirSync(d, { recursive: true });
    const mutated = pairs.reduce((text, [a, b]) => text.replace(a, b), original[file]);
    for (const [k, f] of Object.entries(files)) fs.writeFileSync(path.join(d, path.basename(f)), k === file ? mutated : original[k]);
    guardSrc = fs.readFileSync(path.join(d, "areaGuard.js"), "utf8");
    SW = await import(pathToFileURL(path.join(d, "areaSwitch.js")).href);
    ST = await import(pathToFileURL(path.join(d, "areaStore.js")).href);
    passed = 0;
    failures = [];
    try {
      await runAll();
    } catch (e) {
      failures.push(`throw: ${e.message}`);
    }
    if (failures.length === 0) mutantReport.push(`${name}: 落ちなかった`);
    else if (!QUIET) console.log(`  変異「${name}」→ ${failures.length} 件落ちる（例: ${failures[0].split("\n")[0]}）`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

if (baseFailures.length > 0 || mutantReport.length > 0) {
  for (const f of baseFailures) console.log(`✗ ${f}`);
  for (const m of mutantReport) console.log(`✗ 変異 ${m}`);
  console.log(`\n${basePassed} passed, ${baseFailures.length} failed${MUTATE ? `, 変異の取りこぼし ${mutantReport.length}` : ""}`);
  process.exit(1);
}
console.log(`test-areas: ${basePassed} passed${MUTATE ? `・変異 ${MUTANTS.length} 件がどれも落ちる` : ""}`);
