// ===== 記録の見張り（人ごとの保存の領域。docs は S/b78/acct/DESIGN-FINAL.md §1・§2） =====
// 全ページの head の最初に、ほかのどの script より先に、同期の classic script として読む（module にしない）。
//   <script src="/js/areaGuard.js"></script><script>window.SpellDashArea||(…切り替えの画面へ…)</script>
// 人の記録の鍵（spelldash_<名前>。端末の設定・端末の計測・spelldash_test_* を除く全部）を、ページを開いたときの領域の鍵
// sd2.<領域>.<名前> に読み替える。領域は guest か u:<user id>。localStorage に置く人の記録は、いつも今の領域の 1 人だけ。
// 書くたびに、領域の印 sd2.area がページを開いたときと同じ・切り替えの swap の段でない・今のセッションの人がページの領域の人、を確かめる。
// どれか違えば書かずに例外にする（呼び手の保存の失敗の道。成功と見せない）。ページは切り替えの画面（/switch.html）へ移る。
// 包めない・確かめが合わない・Web Locks か IndexedDB が無いブラウザでは、共用の場所へ戻さず、ページを止める。
// 切り替えの画面（switch.html）では data-switch を付けて読む。そのときは鍵の決まりだけを window.SpellDashAreaKeys に置き、包まない。
(function (root) {
  "use strict";
  if (!root || root.SpellDashAreaKeys) return; // 二度目の読み込み（E2E は頭の前にも同じ物を読む）は何もしない

  // ===== 鍵の決まり（純な部分。js/areaSwitch.js と scripts/test-areas.mjs も使う） =====
  const PREFIX = "spelldash_";
  const TEST_PREFIX = "spelldash_test_";
  // 端末の鍵（人ごとに分けない）: 端末の設定 13 と端末の計測 10。ほかの spelldash_ の鍵は、後から足した鍵も、人の記録として分ける
  const DEVICE_NAMES = Object.freeze([
    "theme", "audio", "osk", "after_correct", "list_compact", "setup_open", "stats_tab", "trend_range", "weak_only", "installed", "onboarded", "typing_kind", "typing_game_course",
    "device_id", "funnel_first", "funnel_paid", "funnel_paid_send", "funnel_queue", "funnel_sent", "funnel_tgame", "funnel_typing", "billing_open", "pro_intent"
  ]);
  const DEVICE = new Set(DEVICE_NAMES.map((name) => PREFIX + name));
  const AREA_KEY = "sd2.area"; // "<領域>#<世代>"。切り替えのたびに世代 +1
  const INDEX_KEY = "sd2.index"; // { <領域>: { at: "ls" | "idb:<id>", lastUsedAt } }
  const MIGRATED_KEY = "sd2.migrated"; // { at, fromSchema, legacyId }。消さない
  const MIGRATING_KEY = "sd2.migrating"; // 移行の途中だけ
  const SWITCH_KEY = "sd2.switch"; // { id, op, from, to, phase: "drain" | "swap", at }。切り替えの途中だけ
  const AUTH_KEY = "sd2.auth"; // 認証のセッションの新しい鍵（js/supabase.js の storageKey。旧コードの部品は読まない）
  const OLD_AUTH_KEY = "sb-sujvgwozsnzjsjmkcrnk-auth-token"; // 旧い鍵。移行で新しい鍵へ移して消す
  const OWNER_KEY = PREFIX + "owner";
  const OWNER_MOVED = "sd2-moved"; // 移行の後に旧い場所の持ち主の鍵へ書く印（旧コードの同期が持ち主の違いとして確認を出す）
  const PROBE_KEY = PREFIX + "sd2probe"; // 読み込みのたびの確かめ（包んだ口で書いて生の口で読む。すぐ消す）
  const TABGEN_KEY = "sd2.tabgen"; // sessionStorage: このタブが最後に見た領域の印
  const SYNC_FLAGS = Object.freeze(["spelldash_synced_this_session", "spelldash_pulled_this_session", "spelldash_sync_done_this_session", "spelldash_pull_started_at"]);
  const SWITCH_PATH = "/switch.html";
  const PAGE_LOCK = "spelldash-page";
  const SWITCH_LOCK = "spelldash-area-switch";

  const isPersonKey = (key) => typeof key === "string" && key.startsWith(PREFIX) && !DEVICE.has(key) && !key.startsWith(TEST_PREFIX);
  const areaPrefix = (area) => "sd2." + area + ".";
  const physicalKey = (area, key) => areaPrefix(area) + key.slice(PREFIX.length);
  const logicalKey = (area, phys) => (phys.startsWith(areaPrefix(area)) ? PREFIX + phys.slice(areaPrefix(area).length) : null);
  const areaOfUser = (id) => (id ? "u:" + id : "guest");
  const readJson = (text) => {
    if (typeof text !== "string") return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  // "<領域>#<世代>" を読む。読めなければ null
  const parseMarker = (text) => {
    if (typeof text !== "string") return null;
    const at = text.lastIndexOf("#");
    const area = text.slice(0, at);
    const gen = Number(text.slice(at + 1));
    if (at <= 0 || !Number.isInteger(gen) || gen < 1 || !(area === "guest" || /^u:[^.#\s]+$/.test(area))) return null;
    return { area, gen };
  };
  const formatMarker = (area, gen) => area + "#" + gen;
  // セッションの値（認証の部品が書く JSON）から user id。無い・読めないなら null
  const sessionUserOf = (text, userText) => {
    const s = readJson(text);
    if (!s || typeof s !== "object") return null;
    const id = s.user?.id ?? s.currentSession?.user?.id ?? readJson(userText)?.user?.id ?? null;
    return typeof id === "string" && id ? id : null;
  };

  const KEYS = Object.freeze({
    PREFIX, TEST_PREFIX, DEVICE_NAMES, AREA_KEY, INDEX_KEY, MIGRATED_KEY, MIGRATING_KEY, SWITCH_KEY, AUTH_KEY, OLD_AUTH_KEY, OWNER_KEY, OWNER_MOVED, PROBE_KEY, TABGEN_KEY, SYNC_FLAGS,
    SWITCH_PATH, PAGE_LOCK, SWITCH_LOCK,
    isPersonKey, isDeviceKey: (key) => DEVICE.has(key), areaPrefix, physicalKey, logicalKey, areaOfUser, readJson, parseMarker, formatMarker, sessionUserOf
  });
  root.SpellDashAreaKeys = KEYS;

  const doc = root.document;
  const script = doc && doc.currentScript;
  // 中身の無い文書（about:blank など、origin の無い所）では何もしない
  let origin = "";
  let path = "";
  try {
    origin = String(root.location && root.location.origin);
    path = String(root.location.pathname);
  } catch {
    origin = "";
  }
  if (!origin || origin === "null") return;
  // 切り替えの画面は包まない（読み込みの頭で自分へ移らない）
  const passive = path === SWITCH_PATH || Boolean(script && typeof script.hasAttribute === "function" && script.hasAttribute("data-switch"));
  answerWorker(); // 新しい sw.js の問い合わせに答える（答えないタブは古いコードとして読み直される。補助）
  if (passive) return;

  // ===== ここから包む（アプリのページ） =====
  let stopped = false; // このページは止まった（人の記録を書かない）
  let leaving = false; // 切り替えの画面へ移る途中
  let pageArea = null; // ページを開いたときの領域
  let pageMarker = null; // そのときの sd2.area の文字列
  let pageGen = 0;
  let sessionUser = null; // 今のセッションの user id（同じタブの認証の書き込みと、ほかのタブの知らせで覚え直す）
  let sessionArea = "guest";
  let redispatching = false;
  let ls = null;
  try {
    ls = root.localStorage;
  } catch {
    ls = null;
  }
  // 保存そのものが使えない端末（サイトのデータを断る設定など）: 何も残らないので混ざらない。ページは今までどおり動く（送らない）
  if (!ls) return noStorage();
  const StorageCtor = root.Storage;
  const P = StorageCtor && StorageCtor.prototype;
  if (!P || typeof P.getItem !== "function") return unsupported("storage");
  const rawGet = P.getItem;
  const rawSet = P.setItem;
  const rawRemove = P.removeItem;
  const rawKey = P.key;
  const lengthGetter = Object.getOwnPropertyDescriptor(P, "length")?.get;
  const get = (key) => rawGet.call(ls, key);
  const set = (key, value) => rawSet.call(ls, key, value);
  const remove = (key) => rawRemove.call(ls, key);
  const allKeys = () => {
    const out = [];
    const n = lengthGetter ? lengthGetter.call(ls) : 0;
    for (let i = 0; i < n; i++) {
      const key = rawKey.call(ls, i);
      if (key !== null) out.push(key);
    }
    return out;
  };

  const readSession = () => {
    sessionUser = sessionUserOf(get(AUTH_KEY), get(AUTH_KEY + "-user"));
    sessionArea = areaOfUser(sessionUser);
  };
  const refuse = (why) => {
    const message = "記録の持ち主が替わったため、この端末に保存しなかった（" + why + "）。";
    if (typeof root.DOMException === "function") return new root.DOMException(message, "InvalidStateError");
    const error = new Error(message);
    error.name = "InvalidStateError";
    return error;
  };
  const swapPhase = () => {
    const text = get(SWITCH_KEY);
    return text !== null && readJson(text)?.phase !== "drain";
  };
  // 書いてよいか（書くたび）: 印が同じ・swap の段でない・セッションの人がページの領域の人
  const writable = () => !stopped && pageMarker !== null && get(AREA_KEY) === pageMarker && !swapPhase() && sessionArea === pageArea;
  const checkWrite = () => {
    if (writable()) return;
    const why = stopped ? "止めたページ" : get(AREA_KEY) !== pageMarker ? "領域の印" : swapPhase() ? "切り替えの途中" : "セッション";
    leave();
    throw refuse(why);
  };
  // 送ってよいか（同期の頭で使う。切り替えの途中は drain の段でも false）
  const stillMine = () => !stopped && !leaving && pageMarker !== null && get(AREA_KEY) === pageMarker && get(SWITCH_KEY) === null && sessionArea === pageArea;

  // 戻り先は # の後ろに置く（? の後ろはサーバーへ送られ、Service Worker の保存の鍵にも残る。ログインのリンクの戻り #access_token=… を含みうる）
  function switchUrl() {
    const here = root.location.pathname + root.location.search + root.location.hash;
    return SWITCH_PATH + "#back=" + encodeURIComponent(here);
  }
  // ページを止めて切り替えの画面へ（読み込みの頭で使う）
  function stopAndSwitch() {
    stopped = true;
    try {
      root.stop();
    } catch {
      // 止められなくても移る
    }
    root.location.replace(switchUrl());
  }
  // 読み込んだ後のページを切り替えの画面へ（書きかけは drain の段なら書ける）
  function leave() {
    if (leaving || stopped) return;
    leaving = true;
    try {
      root.location.replace(switchUrl());
    } catch {
      // 移れなくても書き込みは確かめで止まる
    }
  }

  // ===== 包む（包めないブラウザは止める） =====
  try {
    P.getItem = function getItem(key) {
      if (this === ls && arguments.length > 0) {
        const name = String(key);
        if (isPersonKey(name)) return pageArea === null ? null : rawGet.call(this, physicalKey(pageArea, name));
      }
      return rawGet.apply(this, arguments);
    };
    P.setItem = function setItem(key, value) {
      if (this === ls && arguments.length > 1) {
        const name = String(key);
        if (isPersonKey(name)) {
          checkWrite();
          return rawSet.call(this, physicalKey(pageArea, name), value);
        }
        if (name === AUTH_KEY || name === AUTH_KEY + "-user") {
          const result = rawSet.apply(this, arguments);
          noteSession();
          return result;
        }
      }
      return rawSet.apply(this, arguments);
    };
    P.removeItem = function removeItem(key) {
      if (this === ls && arguments.length > 0) {
        const name = String(key);
        if (isPersonKey(name)) {
          checkWrite();
          return rawRemove.call(this, physicalKey(pageArea, name));
        }
        if (name === AUTH_KEY || name === AUTH_KEY + "-user") {
          const result = rawRemove.apply(this, arguments);
          noteSession();
          return result;
        }
      }
      return rawRemove.apply(this, arguments);
    };
  } catch {
    return unsupported("wrap");
  }
  // 同じタブの認証の書き込み: 人が替わったら切り替えの画面へ（同期を始める前に）
  function noteSession() {
    readSession();
    if (pageArea !== null && sessionArea !== pageArea) leave();
  }

  // ===== 使えるか =====
  const hasIdb = (() => {
    try {
      return Boolean(root.indexedDB && typeof root.indexedDB.open === "function");
    } catch {
      return false;
    }
  })();
  const locks = root.navigator && root.navigator.locks;
  if (!hasIdb) return unsupported("indexeddb");
  if (!locks || typeof locks.request !== "function" || typeof locks.query !== "function") return unsupported("locks");
  if (ls.getItem !== P.getItem || ls.setItem !== P.setItem || ls.removeItem !== P.removeItem) return unsupported("wrap");

  // ===== 読み込みの頭の確かめ =====
  readSession();
  if (get(MIGRATED_KEY) === null) {
    if (!freshDevice()) return stopAndSwitch();
  }
  const marker = parseMarker(get(AREA_KEY));
  if (!marker || get(SWITCH_KEY) !== null || get(MIGRATING_KEY) !== null) return stopAndSwitch();
  if (sessionArea !== marker.area) return stopAndSwitch();
  if (readJson(get(INDEX_KEY))?.[marker.area]?.at !== "ls") return stopAndSwitch();
  pageArea = marker.area;
  pageGen = marker.gen;
  pageMarker = get(AREA_KEY);
  if (!selfTest()) return unsupported("selftest");

  // このタブの同期の印は、前の領域のときの物なら消す（取り込みを飛ばして古い行を送らない）
  try {
    const ss = root.sessionStorage;
    if (ss.getItem(TABGEN_KEY) !== pageMarker) {
      for (const flag of SYNC_FLAGS) ss.removeItem(flag);
      ss.setItem(TABGEN_KEY, pageMarker);
    }
  } catch {
    // sessionStorage が使えない環境では印も無い
  }

  // ===== ほかのタブの書き込み（storage イベント） =====
  // ページの領域の鍵は元の名前の知らせに作り直して届ける。ほかの領域の鍵・旧い場所の人の記録（旧コードのタブ）・見張りの印は、アプリに届けない
  root.addEventListener("storage", (event) => {
    if (redispatching) return;
    if (event.storageArea && event.storageArea !== ls) return;
    const key = event.key;
    if (key === null) {
      // ほかのタブが全部消した
      recheck();
      return;
    }
    if (key.startsWith("sd2.")) {
      event.stopImmediatePropagation();
      const name = logicalKey(pageArea, key);
      if (name !== null) {
        redispatching = true;
        try {
          root.dispatchEvent(new root.StorageEvent("storage", { key: name, oldValue: event.oldValue, newValue: event.newValue, url: event.url, storageArea: ls }));
        } finally {
          redispatching = false;
        }
        return;
      }
      if (key === AUTH_KEY || key === AUTH_KEY + "-user") {
        noteSession();
        return;
      }
      if (key === AREA_KEY || key === SWITCH_KEY || key === MIGRATING_KEY || key === INDEX_KEY) recheck();
      return;
    }
    if (isPersonKey(key)) event.stopImmediatePropagation(); // 旧い場所（旧コードのタブ）の人の記録。新しいコードは読まない
  });

  // ページの間、共有のロックを持つ（切り替えの画面は、持ち主が 0 になるのを待つ）
  function holdPageLock() {
    try {
      locks.request(PAGE_LOCK, { mode: "shared" }, () => new Promise(() => {})).catch(() => {});
    } catch {
      // 取れなくても書き込みは確かめで止まる
    }
  }
  holdPageLock();
  function recheck(event) {
    if (stopped || leaving) return;
    readSession();
    if (!stillMine()) leave();
    else if (event && event.type === "pageshow" && event.persisted) holdPageLock();
  }
  root.addEventListener("pageshow", recheck);
  root.addEventListener("focus", () => recheck());
  try {
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "visible") recheck();
    });
  } catch {
    // 文書の無い環境
  }

  // 旧い場所に人の記録（移行の後に旧コードのタブが書いた値）か旧い認証の鍵があれば、手の空いたときに IndexedDB の orphans へ写して消す
  if (orphanKeys().length > 0) {
    const sweep = () => {
      import("/js/areaSwitch.js")
        .then((mod) => mod.sweepOrphansFromPage({ get, set, remove, keys: allKeys }))
        .catch(() => {});
    };
    if (typeof root.requestIdleCallback === "function") root.requestIdleCallback(sweep, { timeout: 5000 });
    else root.setTimeout(sweep, 2000);
  }

  root.SpellDashArea = Object.freeze({
    area: pageArea,
    gen: pageGen,
    marker: pageMarker,
    authKey: AUTH_KEY,
    isPersonKey,
    // 送る前・書く前の確かめ（領域の印が同じ・切り替えの途中でない・セッションの人がページの領域の人）
    stillMine,
    canWrite: writable,
    userId: () => sessionUser,
    signedIn: () => sessionUser !== null,
    // 元の名前の鍵の一覧: 端末の鍵（spelldash_ の端末の設定・計測・test_）と、今の領域の人の記録。ほかの領域・旧い場所の値は入れない
    keys: () => {
      const out = [];
      const prefix = areaPrefix(pageArea);
      for (const key of allKeys()) {
        if (key.startsWith(prefix)) out.push(PREFIX + key.slice(prefix.length));
        else if (key.startsWith(PREFIX) && !isPersonKey(key)) out.push(key);
      }
      return out;
    },
    leave
  });
  return;

  // ===== 中の関数 =====
  // 初めての端末（人の記録・旧い認証・見張りの印のどれも無い）: 移行することが無いので、その場でゲストの領域を作る
  function freshDevice() {
    const keys = allKeys();
    if (keys.some((key) => isPersonKey(key) || key === OLD_AUTH_KEY || key.startsWith("sd2."))) return false;
    try {
      const at = new Date().toISOString();
      set(INDEX_KEY, JSON.stringify({ guest: { at: "ls", lastUsedAt: at } }));
      set(AREA_KEY, formatMarker("guest", 1));
      set(MIGRATED_KEY, JSON.stringify({ at, fromSchema: null, legacyId: null }));
      return true;
    } catch {
      return false; // 書けなければ切り替えの画面で（ロックの中で）移行する
    }
  }
  function orphanKeys() {
    return allKeys().filter((key) => (isPersonKey(key) && !(key === OWNER_KEY && get(key) === OWNER_MOVED)) || key === OLD_AUTH_KEY);
  }
  // 包んだ口で書いて生の口で読む。容量で書けないときは、包みが効いていること（口が包んだ物）だけを確かめる
  function selfTest() {
    const token = String(Math.random()).slice(2, 10) || "1";
    const phys = physicalKey(pageArea, PROBE_KEY);
    try {
      ls.setItem(PROBE_KEY, token);
    } catch (error) {
      const quota = error && (error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014);
      return quota && ls.setItem === P.setItem && ls.getItem(PROBE_KEY) === get(phys);
    }
    const ok = get(phys) === token && get(PROBE_KEY) === null && ls.getItem(PROBE_KEY) === token;
    try {
      ls.removeItem(PROBE_KEY);
    } catch {
      return false;
    }
    return ok && get(phys) === null;
  }
  function noStorage() {
    root.SpellDashArea = Object.freeze({
      area: null, gen: 0, marker: null, authKey: AUTH_KEY, isPersonKey,
      stillMine: () => false, canWrite: () => false, userId: () => null, signedIn: () => false, keys: () => [], leave: () => {}
    });
    return undefined;
  }
  // 使えないブラウザ: 共用の場所へ戻さず止める。人の記録は書けない（包めたら、包んだ口は全部断る）
  function unsupported(reason) {
    stopped = true;
    root.SpellDashAreaStopped = reason;
    try {
      root.stop();
    } catch {
      // 止められなくても下の文を出す
    }
    showStop(reason);
    return undefined;
  }
  function showStop(reason) {
    if (!doc || !doc.documentElement) return;
    const render = () => {
      const body = doc.body || doc.documentElement.appendChild(doc.createElement("body"));
      body.textContent = "";
      body.setAttribute("style", "margin:0;padding:24px 16px;font:16px/1.7 system-ui,sans-serif;background:#f6f1e7;color:#1a2137");
      const box = doc.createElement("main");
      box.id = "areaStop";
      box.dataset.reason = reason;
      box.setAttribute("style", "max-width:560px;margin:0 auto");
      const title = doc.createElement("h1");
      title.setAttribute("style", "font-size:20px;margin:0 0 12px");
      title.textContent = "このブラウザでは記録を安全に分けられない";
      const p1 = doc.createElement("p");
      p1.textContent = "記録を人ごとに分けて保存する仕組みが使えないため、学習・保存・同期を止めた。記録はこの端末に残っている。";
      const p2 = doc.createElement("p");
      p2.textContent = "新しい版のブラウザで開く。プライベートの窓では開かない。ブラウザの設定でサイトのデータを保存できるようにする。";
      box.append(title, p1, p2);
      const data = recordsForExport();
      if (Object.keys(data).length > 0) {
        const button = doc.createElement("button");
        button.type = "button";
        button.id = "areaStopExport";
        button.textContent = "記録を書き出す";
        button.addEventListener("click", () => download(data));
        box.append(button);
      }
      body.append(box);
    };
    try {
      render();
    } catch {
      // 文を出せなくても止まっている
    }
  }
  // 書き出す記録（元の名前）: 移行の前なら旧い場所の記録。移行の途中なら、残った旧い鍵に移した先の鍵を重ねた物。移行の後なら、index が ls を指す
  // 領域の記録と端末の鍵（index が idb を指す領域の localStorage の残りは途中の物なので書き出さない。js/areaSwitch.js exportRecords と同じ決まり）
  function recordsForExport() {
    const data = {};
    if (!ls) return data;
    try {
      const index = readJson(get(INDEX_KEY)) || {};
      const moving = readJson(get(MIGRATING_KEY));
      const after = !moving && (get(MIGRATED_KEY) !== null || Object.keys(index).some((a) => index[a] && index[a].at === "ls"));
      const area = after ? Object.keys(index).find((a) => index[a] && index[a].at === "ls") || null : moving && typeof moving.area === "string" ? moving.area : null;
      for (const key of allKeys()) {
        if (area && key.startsWith(areaPrefix(area))) data[PREFIX + key.slice(areaPrefix(area).length)] = get(key);
        else if (key.startsWith(PREFIX) && !key.startsWith(TEST_PREFIX) && !(key === OWNER_KEY && get(key) === OWNER_MOVED) && (!after || !isPersonKey(key)) && !(key in data)) data[key] = get(key);
      }
      delete data[PROBE_KEY];
    } catch {
      // 読めなければ書き出さない
    }
    return data;
  }
  function download(data) {
    const json = JSON.stringify({ app: "SpellDash", version: 1, exportedAt: new Date().toISOString(), data }, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = doc.createElement("a");
    const d = new Date();
    a.href = url;
    a.download = "spelldash-backup-" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + ".json";
    doc.body.appendChild(a);
    a.click();
    a.remove();
    root.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // 新しい sw.js（有効になったとき）の問い合わせに答える
  function answerWorker() {
    try {
      const sw = root.navigator && root.navigator.serviceWorker;
      if (!sw || typeof sw.addEventListener !== "function") return;
      sw.addEventListener("message", (event) => {
        if (event.data && event.data.type === "sd2-ping" && event.ports && event.ports[0]) event.ports[0].postMessage({ type: "sd2-pong" });
      });
      if (typeof sw.startMessages === "function") sw.startMessages();
    } catch {
      // Service Worker の無い環境
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
