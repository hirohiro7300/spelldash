// 覚えた の増え（学習状況の詳しい記録の週間レポート・今月の行・推移・カレンダー。Batch 90。js/growthLog.js）の単体テスト。ブラウザなし（数秒）:
//   node scripts/test-growth-core.mjs [<木の根>]
// 失敗が 1 つでもあれば終了コード 1。仕様は docs/SPEC_LEARN_STATE.md §12。数は学習状況の最初の画面の 覚えた（3 状態。公開の語だけ）と同じ物差し。
// 見ること（番号は Batch 90 の決定の検査の番号）:
//   1 公開の語で数える  2 毎日学ぶ人  3 切り替えの日（learned だけの前の形の行）  4 行の形の守り（前の書き手と同じ欄・日の行の中身は 5 つの欄）
//   5 旧いタブ  6 2 台目  7 ほかの端末の大きい learned  8 前からの 覚えた の差（埋め・競り合い・書き手より先の読み・埋めた語の復習・旧いタブ・古い写し・前の行を書き換えない）
//   9 表が読めない  10 30 日空き・西へ・東へ  11 復元  12 答えの道の守り（js/game.js の本文）  13 前からの語の外れと覚え直し  14 埋めた語の外れと覚え直し
//   15 1 台の人の「–」  16 回の途中で閉じた日  17 2 台目で埋めの日に開いた  18 乱数の見張り（1 台・40 日・旧いタブ・外れ・覚え直し・古い写し・埋め）
//   19 数え始めた日に同じ日の埋め（ゲストで学んだ日にログインして「はい」）  20 回の途中で閉じた日の前からの語の外れ（前の行を上げすぎない・直すのは次の日以後の最初の書き込みの 1 回だけ）
//   21 読み手の決まり（今月の数えない日・窓の前の数えない日・推移の今日の点）。4 は送る道（pushUserItems）の中身も見る
// 端末の偽物（localStorage・時計・fetch）はこのファイルの中だけ。時計は Asia/Tokyo（10 は時刻帯を替える）。
process.env.TZ = "Asia/Tokyo";

import fs from "fs";
import path from "path";
import { isDeepStrictEqual } from "util";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const modUrl = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
function ok(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail === "" ? "" : `\n    ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

// ===== 端末の偽物 =====
class FakeStorage {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
    this.writes = [];
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
    this.writes.push(k);
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  get length() {
    return this.map.size;
  }
}
let LS = new FakeStorage({ spelldash_schema_version: "7" });
const SS = new FakeStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => LS });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => SS });
const listeners = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = (event) => {
  for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
  return true;
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ getContext: () => null, style: {}, setAttribute() {}, appendChild() {} }),
  documentElement: { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
  body: null,
  visibilityState: "visible",
  hidden: false
};
globalThis.location ??= { search: "", hash: "", hostname: "localhost", pathname: "/", href: "http://localhost/", origin: "http://localhost" };
globalThis.reportError = () => {};
console.warn = () => {};

const VOCAB_TEXT = fs.readFileSync(path.join(ROOT, "data/public/english.json"), "utf8");
globalThis.fetch = async (u) => (String(u).endsWith("data/public/english.json") ? { ok: true, status: 200, json: async () => JSON.parse(VOCAB_TEXT) } : { ok: false, status: 404, json: async () => ({}) });

// 偽の時計（null なら本物）
const RealDate = Date;
let clock = null;
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(clock ?? RealDate.now());
    else super(...a);
  }
  static now() {
    return clock ?? RealDate.now();
  }
}
globalThis.Date = FakeDate;

// ===== 読み込み =====
const L = await import(modUrl("js/learnState.js"));
const PV = await import(modUrl("js/publicVocab.js"));
const S = await import(modUrl("js/storage.js"));
const G = await import(modUrl("js/growthLog.js"));
const U = await import(modUrl("js/userItemsSync.js"));
const R = await import(modUrl("js/retentionCalc.js"));
const CP = await import(modUrl("js/categoryProgress.js"));
const BP = await import(modUrl("js/bookPace.js"));
const LV = await import(modUrl("js/level.js"));
const WR = await import(modUrl("js/weeklyReport.js"));
const CV = await import(modUrl("js/calendarView.js"));
await S.loadLearnStates();
const VOCAB = PV.makePublicVocab(JSON.parse(VOCAB_TEXT));
const PUB = VOCAB.order;
const isDone = (st) => BP.isDoneState(CP.classifyWord(st));

// 新しい読み手（直す前の木には無い: 呼ぶと「…が無い」を返して検査が落ちる）
const missing = (name) => () => `${name} が無い`;
const fn = (name) => (typeof G[name] === "function" ? G[name] : missing(name));
const week = (endOffset = 0) => fn("getCoreDelta7")(endOffset);
const month = () => fn("getCoreMonthDelta")(new Date());
const coreNow = () => fn("getCoreNow")();
const series = (days = 30) => fn("getCoreSeries")(days);
const gainOf = (ymd) => {
  const g = fn("getCoreDayGains")();
  return g instanceof Map ? (g.has(ymd) ? g.get(ymd).gained : "学習した日でない") : g;
};
const seriesPoint = (ymd, days = 30) => {
  const s = series(days);
  return Array.isArray(s) ? (s.find((p) => p.date === ymd)?.learned ?? "点なし") : s;
};
const seriesEnd = (days = 30) => {
  const s = series(days);
  return Array.isArray(s) ? s.at(-1)?.learned : s;
};

// ===== 端末・時計・学ぶ =====
const pad = (n) => String(n).padStart(2, "0");
const at = (ymd, h = 21, m = 0) => new RealDate(`${ymd}T${pad(h)}:${pad(m)}:00+09:00`).getTime();
const setNow = (ymd, h = 21, m = 0) => (clock = at(ymd, h, m));
const shift = (ymd, n) => R.shiftDay(ymd, n);
const today = () => R.localDay(new Date());
const devices = new Map();
function device(name) {
  LS = new FakeStorage({ spelldash_schema_version: "7" });
  devices.set(name, LS);
  S.forgetWordStats();
  return LS;
}
function switchTo(name) {
  LS = devices.get(name);
  S.forgetWordStats();
}
const table = () => S.getWordStats();
function setTable(ws) {
  LS.setItem("spelldash_word_stats", JSON.stringify(ws));
  S.forgetWordStats();
}
const growth = () => JSON.parse(LS.getItem("spelldash_growth_log") || "[]");
const setGrowth = (rows) => LS.setItem("spelldash_growth_log", JSON.stringify(rows));
const live = () => L.countLearnStates(table(), VOCAB).learned;

// 中心の学習の答え（本物の applyLearnAnswer。history は js/stats.js の形）。答えのたびの印 markActiveToday は今のまま
function answer(ids, kind, ms = Date.now(), { history = true } = {}) {
  const ws = { ...table() };
  for (const id of ids) {
    const prev = ws[id] ?? {};
    const s = L.applyLearnAnswer(prev, kind, ms);
    const iso = new RealDate(ms).toISOString();
    s.playCount = (prev.playCount ?? 0) + 1;
    s.lastPlayed = iso;
    if (L.isCleanKind(kind)) {
      s.correctCount = (prev.correctCount ?? 0) + 1;
      s.lastRecallSuccessAt = iso;
    } else {
      s.recallFail = (prev.recallFail ?? 0) + 1;
      s.lastRecallFailAt = iso;
    }
    if (history) s.history = [...(prev.history ?? []).slice(-7), { d: R.localDay(new RealDate(ms)), r: L.isCleanKind(kind) ? "o" : "x" }];
    ws[id] = s;
  }
  setTable(ws);
  G.markActiveToday();
}
// まだ記録の無い公開の語を n 語（pool の順）
function unseen(n, pool = PUB) {
  const ws = table();
  const out = [];
  for (const id of pool) {
    if (out.length >= n) break;
    if (!ws[id]) out.push(id);
  }
  return out;
}
function learnNew(n, ymd, h = 21, m = 0, pool = PUB) {
  setNow(ymd, h, m);
  const ids = unseen(n, pool);
  answer(ids, "exact", clock);
  return ids;
}
// 回の終わり・学習状況のページの書き手（js/game.js snapshotGrowth・js/statsView.js renderGrowthTrend と同じ呼び方。learned は前の数え方の数〔ここでは答えのある語の数〕）
const oldCount = () => Object.values(table()).filter((s) => (s.correctCount ?? 0) > 0).length;
const endOfSet = () => G.recordGrowthSnapshot({ learned: oldCount(), mastered: 0 });
// Batch 90 の前の書き手（旧いタブ・ほかの端末の古い版）: 今日の行を learned・mastered・active・v の 5 つの欄で作り直す。前の日の行には触らない
function oldTabWrite(learned = oldCount(), mastered = 0) {
  const list = growth();
  const d = today();
  const i = list.findIndex((e) => e.date === d);
  const prev = i >= 0 ? list[i] : null;
  const row = { date: d, learned, mastered, active: !!prev?.active, v: 2 };
  if (i >= 0) list[i] = row;
  else list.push(row);
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  setGrowth(list.slice(-120));
}
// 15 列だけにした語の記録（2 台目に届く形。js/sync.js statToRow → rowToStat の近似）
const COLS = ["playCount", "correctCount", "typingMiss", "recallFail", "cleanCorrectStreak", "mastered", "masteredAt", "lastPlayed", "nextReviewAt", "lastRecallFailAt", "lastRecallSuccessAt", "dailyLearningDate", "dailyLearningStage", "srsAdvancedOn"];
function viaCloud(ws) {
  const out = {};
  for (const [id, s] of Object.entries(ws)) {
    const o = {};
    for (const c of COLS) o[c] = s[c] ?? null;
    o.missCount = s.recallFail ?? null;
    out[id] = o;
  }
  return out;
}
// クラウドの day 行（ほかの端末の行。中身は 5 つの欄だけ）
const cloudDays = (rows) => rows.map((e) => ({ kind: "day", key: e.date, payload: { learned: e.learned ?? 0, mastered: e.mastered ?? 0, active: !!e.active, set: false, sets: 0 }, deleted: false, updated_at: new RealDate(clock ?? RealDate.now()).toISOString() }));
// 表の上限（docs/SQL_USER_ITEMS.md の payload::text の長さ）が測る形（鍵は短い順 → 字の順、": " と ", "）のバイト数
const jsonbText = (o) => "{" + Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map((k) => JSON.stringify(k) + ": " + JSON.stringify(o[k])).join(", ") + "}";
const fmtDelta = (v) => (typeof v === "number" ? `+${v}` : v === null ? "–" : String(v));

// 基本カテゴリに無い公開の語（english-zero など。中心の学習の語の大半）
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data/manifest.json"), "utf8"));
const english = manifest.subjects.find((s) => s.id === "english");
const baseIds = new Set(english.categories.filter((c) => !c.pack).flatMap((c) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", c.file), "utf8")).words.map((w) => w.id)));
const NONBASE = PUB.filter((id) => !baseIds.has(id));

// ── 1. 公開の語で数える ─────────────
{
  device("one");
  const days = ["2026-12-03", "2026-12-04", "2026-12-05"];
  for (const d of days) {
    learnNew(10, d, 20, 0, NONBASE);
    LV.updateStreak();
    endOfSet();
  }
  let r = null;
  try {
    r = WR.computeWeeklyReport();
  } catch (error) {
    r = { error: String(error) };
  }
  const cal = CV.computeCalendarDays().days.filter((x) => days.includes(x.date)).map((x) => x.gained);
  ok("1 公開の語（基本カテゴリに無い english-zero など）を 3 日で 10 語ずつ: 学習状況の 覚えた は 30", live() === 30 && NONBASE.includes("english-zero"), { live: live() });
  eq("1 週間レポートの「7日で 覚えた」+30・累計 30（学習状況と同じ数）", [r?.learnedDelta, r?.learnedTotal], [30, 30]);
  eq("1 今月の行 +30・推移の最後の点 30", [month(), seriesEnd()], [30, 30]);
  eq("1 カレンダーは 3 日とも +10", cal, [10, 10, 10]);
}

// ── 2. 毎日学ぶ人: 14 日、毎日 5 語 ─────────────
{
  device("daily");
  const got = [];
  for (let i = 0; i < 14; i++) {
    learnNew(5, shift("2026-12-01", i));
    endOfSet();
    got.push(week(0));
  }
  eq("2 毎日 5 語: 週は +5・+10 … +35 の後 +35 のまま", got, [5, 10, 15, 20, 25, 30, 35, 35, 35, 35, 35, 35, 35, 35]);
}

// ── 3. 切り替えの日: learned だけの前の形の行と、lsf と history のある表（外れて あやふや に戻った語をまぜる） ─────────────
{
  device("switch");
  const start = "2026-11-10";
  const truth = new Map();
  let dropped = 0;
  for (let i = 0; i < 20; i++) {
    const d = shift(start, i);
    learnNew(6, d, 20);
    if (i === 8 || i === 13) {
      // 前に覚えた語を 2 語ずつ外す（あやふや。印 lsf は前の日のまま）
      const ws = table();
      const ids = PUB.filter((id) => ws[id]?.ls === 2 && Number.isInteger(ws[id].lsf) && ws[id].lsf > 0).slice(0, 2);
      answer(ids, "miss", at(d, 21));
      dropped += ids.length;
    }
    if (i === 16 || i === 17) {
      // 外した語の 2 語を覚え直す（別の日に 2 回の自力正解で 覚えた）
      const ws = table();
      answer(PUB.filter((id) => ws[id]?.ls === 1).slice(0, 2), "exact", at(d, 21, 10));
    }
    oldTabWrite(); // 前の版の書き手（core を知らない）
    truth.set(d, live());
  }
  const switchDay = shift(start, 20);
  learnNew(6, switchDay, 20);
  endOfSet(); // 新しい版の最初の書き込み
  truth.set(switchDay, live());
  const rows = growth();
  const off = rows.filter((e) => e.date < switchDay).map((e) => (Number.isInteger(e.core) ? Math.abs(e.core - truth.get(e.date)) : "core なし"));
  const dayDiff = [];
  for (let i = 1; i < 20; i++) {
    const a = rows.find((e) => e.date === shift(start, i - 1));
    const b = rows.find((e) => e.date === shift(start, i));
    dayDiff.push(Number.isInteger(a?.core) && Number.isInteger(b?.core) ? Math.abs(b.core - a.core - (truth.get(b.date) - truth.get(a.date))) : "core なし");
  }
  const w = week(0);
  const tw = truth.get(switchDay) - truth.get(shift(switchDay, -7));
  ok("3 切り替えの日: 前の行の core は正解から「外した語の数」以内（数え直した値）", off.length === 20 && off.every((x) => typeof x === "number" && x <= dropped), { off, dropped });
  ok("3 切り替えの日: 1 日の増えの差は 4 以内（段が無い）", dayDiff.every((x) => typeof x === "number" && x <= 4), dayDiff);
  ok("3 切り替えの日: 週は正解から 2 以内・+500 を超えない", typeof w === "number" && Math.abs(w - tw) <= 2 && w <= 500, { week: w, truth: tw });
  ok("3 切り替えの日: learned・mastered・v は前の版の値のまま（v:2 でない行 0）", rows.every((e) => e.v === 2 && Number.isInteger(e.learned)), rows.slice(0, 3));
}

// ── 4. 行の形の守り（直す前の木でも通る）: learned・mastered・active・v は前の書き手と同じ・日の行の中身は 5 つの欄・80 バイト以下・送る印 ─────────────
{
  // 前の書き手（Batch 90 の前の recordGrowthSnapshot の決まり）を写した物
  const refWrite = (list, d, { learned, mastered, active = false, legacyLearned = null }) => {
    const out = list.map((e) => ({ ...e }));
    const legacy = out.length > 0 && !out.some((e) => e.v === 2) ? legacyLearned : null;
    if (legacy != null) {
      const offset = learned - legacy;
      if (offset !== 0) for (const e of out) e.learned = Math.max(0, (e.learned ?? 0) + offset);
    }
    const i = out.findIndex((e) => e.date === d);
    const prev = i >= 0 ? out[i] : null;
    const row = { date: d, learned, mastered, active: !!(prev?.active || active), v: 2 };
    if (i >= 0) out[i] = row;
    else out.push(row);
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
  };
  const shape = (rows) => rows.map((e) => ({ date: e.date, learned: e.learned, mastered: e.mastered, active: !!e.active, v: e.v }));
  device("shape");
  const v1 = [
    { date: "2026-12-01", learned: 3, mastered: 1, active: true },
    { date: "2026-12-02", learned: 5, mastered: 2, active: true }
  ];
  setGrowth(v1);
  learnNew(4, "2026-12-03", 20);
  let ref = refWrite(v1, "2026-12-03", { learned: 9, mastered: 3, legacyLearned: 6 });
  ref = ref.map((e) => (e.date === "2026-12-03" ? { ...e, active: true } : e)); // markActiveToday の行
  G.recordGrowthSnapshot({ learned: 9, mastered: 3, legacyLearned: () => 6 });
  eq("4 前の形（v1）の行の底上げと今日の行: learned・mastered・active・v は前の書き手と同じ", shape(growth()), shape(ref));
  learnNew(3, "2026-12-04", 20);
  ref = refWrite(ref, "2026-12-04", { learned: 12, mastered: 3 }).map((e) => (e.date === "2026-12-04" ? { ...e, active: true } : e));
  G.recordGrowthSnapshot({ learned: 12, mastered: 3 });
  G.recordGrowthSnapshot({ learned: 11, mastered: 3 }); // 語数が減った描き直し
  ref = refWrite(ref, "2026-12-04", { learned: 11, mastered: 3 });
  eq("4 次の日の書き込み・減った描き直し: learned・mastered・active・v は前の書き手と同じ", shape(growth()), shape(ref));
  // 送る印: core（送らない欄）だけが変わったときは付けない
  U.clearDirtyItems();
  answer(unseen(2), "exact", at("2026-12-04", 21, 30)); // 学習状況の 覚えた だけが増える（learned の引数は同じ）
  U.clearDirtyItems();
  G.recordGrowthSnapshot({ learned: 11, mastered: 3 });
  eq("4 送る印: learned・mastered・active が同じなら core が変わっても付けない", [...U.getDirtyItems()], []);
  // 日の行の中身（送る形）: 5 つの欄・表の上限の測り方で 80 バイト以下
  const { toUpload } = U.mergeCloudItems([], "u1");
  const payloads = toUpload.filter((r) => r.kind === "day").map((r) => r.payload);
  ok("4 日の行の中身は learned・mastered・active・set・sets の 5 つの欄だけ（core・cb・nf は送らない）", payloads.length >= 3 && payloads.every((p) => JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["active", "learned", "mastered", "set", "sets"])), payloads);
  ok("4 日の行の中身は 80 バイト以下（表の上限 512 の測り方）", payloads.every((p) => Buffer.byteLength(jsonbText(p), "utf8") <= 80), payloads.map((p) => Buffer.byteLength(jsonbText(p), "utf8")));
  // 送る道（pushUserItems → buildDirtyRows → 送り先の upsert）。クラウドに同じ日の行が無い最初の送信（合わせ直しを通らない形）でも 5 つの欄だけ
  U.touchItems("day", growth().map((e) => e.date));
  const sent = [];
  const fakeClient = {
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        then: (resolve) => resolve({ data: [], error: null }),
        upsert: async (rows) => {
          sent.push(...rows);
          return { error: null, status: 201 };
        }
      };
      return q;
    }
  };
  await U.pushUserItems(fakeClient, "u1", { now: clock });
  const pushed = sent.filter((r) => r.kind === "day").map((r) => r.payload);
  ok("4 送る道（pushUserItems）で送った日の行の中身も 5 つの欄だけ・80 バイト以下", pushed.length === growth().length && pushed.every((p) => JSON.stringify(Object.keys(p).sort()) === JSON.stringify(["active", "learned", "mastered", "set", "sets"]) && Buffer.byteLength(jsonbText(p), "utf8") <= 80), pushed);
  // max と OR: クラウドの大きい learned・active が届いても、端末だけの欄（core など）は残る
  const before = growth().find((e) => e.date === "2026-12-02");
  U.mergeCloudItems([{ kind: "day", key: "2026-12-02", payload: { learned: 999, mastered: 0, active: true, set: false, sets: 0 }, deleted: false, updated_at: new RealDate(clock).toISOString() }], "u1");
  const after = growth().find((e) => e.date === "2026-12-02");
  eq("4 クラウドの行と合わせる（max と OR）: learned は大きい方・端末だけの欄はそのまま", [after.learned, after.active, after.core, after.cb, after.core0], [999, true, before.core, before.cb, before.core0]);
}

// ── 5. 旧いタブ: 今日の行を 5 つの欄で作り直した後、次の書き込みで今日の core が戻り、旧いタブだけの日は数え直す ─────────────
{
  device("oldtab");
  for (let i = 0; i < 5; i++) {
    learnNew(5, shift("2026-12-01", i), 20);
    endOfSet();
  }
  learnNew(5, "2026-12-06", 9);
  endOfSet();
  setNow("2026-12-06", 12);
  learnNew(3, "2026-12-06", 12);
  oldTabWrite(); // 旧いタブが 3 語学んで回を終えた（今日の core が落ちる）
  const mid = { week: week(0), today: growth().find((e) => e.date === "2026-12-06"), gain: gainOf("2026-12-06") };
  eq("5 旧いタブが今日の行を作り直した直後: 週は表から数えるので正しい（+33）・今日のカレンダーは「–」", [mid.week, mid.today.core, mid.gain], [33, undefined, null]);
  setNow("2026-12-06", 21);
  endOfSet();
  eq("5 次の新しい書き込みで今日の core が戻る（33）・カレンダー +8", [growth().find((e) => e.date === "2026-12-06").core, gainOf("2026-12-06")], [33, 8]);
  const keep = growth().filter((e) => Number.isInteger(e.core)).map((e) => [e.date, e.core]);
  learnNew(4, "2026-12-07", 20);
  oldTabWrite(); // 旧いタブだけで学んだ日
  setNow("2026-12-08", 8);
  endOfSet(); // 次の日の新しい書き込み
  const rows = growth();
  eq("5 旧いタブだけの日は数え直す（12-07 = 37）・昨日までの 7 日 +37", [rows.find((e) => e.date === "2026-12-07").core, week(1)], [37, 37]);
  ok("5 下がった行 0・v:2 でない行 0", keep.every(([d, c]) => rows.find((e) => e.date === d).core >= c) && rows.every((e) => e.v === 2), rows);
}

// ── 6. 2 台目: 15 列だけの表＋埋め＋ほかの端末から届いた core の無い行。学ぶ前も、数え始めて 7 日目までも「–」。その後は B の増えだけ ─────────────
{
  device("A6");
  for (let i = 0; i < 4; i++) {
    learnNew(10, shift("2026-12-01", i), 20);
    endOfSet();
  }
  const wsA = table();
  const daysA = growth();
  device("B6");
  setNow("2026-12-05", 22);
  const filled = L.fillLearnStates(viaCloud(wsA), VOCAB.isPublic, isDone, {});
  setTable(filled.table);
  U.mergeCloudItems(cloudDays(daysA), "u1");
  endOfSet(); // 学習状況のページの書き手が先に走る
  const before = [week(0), month(), coreNow()];
  const got = [];
  learnNew(10, "2026-12-05", 22, 30);
  endOfSet();
  got.push(week(0));
  for (let i = 1; i <= 6; i++) {
    learnNew(4, shift("2026-12-05", i), 20);
    endOfSet();
    got.push(week(0));
  }
  eq("6 2 台目（埋め 40 語）: 学ぶ前は週・今月とも「–」（+40 や +0 でない）・今は 40", before, [null, null, 40]);
  eq("6 2 台目: 数え始めて 6 日目までは「–」、7 日目（12-11）から B の増えだけ（10 + 4×6）", got, [null, null, null, null, null, null, 34]);
  eq("6 2 台目: 今月は A だけの学習した日が数え始めより前にあるので「–」", month(), null);
  ok("6 2 台目: A だけの日の行は数えない（null）", growth().filter((e) => e.date < "2026-12-05").every((e) => e.core === null), growth().slice(0, 5));
}

// ── 7. A の行が B の大きい learned に上がっても、A の週は変わらない ─────────────
{
  device("A7");
  for (let i = 0; i < 7; i++) {
    learnNew(6, shift("2026-12-01", i), 20);
    endOfSet();
  }
  const w0 = [week(0), month(), seriesEnd()];
  U.mergeCloudItems([{ kind: "day", key: "2026-12-05", payload: { learned: 212, mastered: 0, active: true, set: true, sets: 2 }, deleted: false, updated_at: new RealDate(clock).toISOString() }], "u1");
  eq("7 A の週・今月・推移の最後（7 日で 42 語）", w0, [42, 42, 42]);
  eq("7 B の大きい learned（212）が A の 12-05 の行に入る", growth().find((e) => e.date === "2026-12-05").learned, 212);
  eq("7 A の週・今月・推移は変わらない（+42）", [week(0), month(), seriesEnd()], [42, 42, 42]);
}

// ── 8. 前からの 覚えた の差（埋め・移行で増えた 覚えた は増えに入れない） ─────────────
const OTHER = PUB.slice(-400); // ほかの端末で覚えた語（この端末の学ぶ語と重ならない）
const otherTable = () => Object.fromEntries(OTHER.slice(0, 300).map((id) => [id, { playCount: 3, correctCount: 3, mastered: true, masteredAt: "2026-11-20T10:00:00.000Z", lastPlayed: "2026-11-20T10:00:00.000Z" }]));
function fillNow() {
  const local = table();
  const merged = { ...viaCloud(otherTable()), ...local };
  const f = L.fillLearnStates(merged, VOCAB.isPublic, isDone, local);
  setTable(f.table ?? merged);
  return [...f.states.values()].filter((v) => v === 2).length;
}
function fourDays(name) {
  device(name);
  for (let i = 0; i < 4; i++) {
    learnNew(5, shift("2026-12-01", i), 20);
    endOfSet();
  }
  setNow("2026-12-05", 20);
}
{
  // (a)(c)(d)(g): 埋めの直後に書き手より先に読む・埋めの後の書き込み・埋めた語の復習・前の行は書き換えない
  fourDays("C8a");
  const prevRows = JSON.stringify(growth().map((e) => [e.date, e.core, e.core0, e.cb]));
  const n = fillNow();
  const read = [week(0), month(), coreNow()];
  endOfSet();
  const written = [week(0), month()];
  const kept = JSON.stringify(growth().filter((e) => e.date < "2026-12-05").map((e) => [e.date, e.core, e.core0, e.cb]));
  setNow("2026-12-05", 20, 30);
  const ws = table();
  answer(PUB.filter((id) => ws[id]?.ls === 2 && ws[id].lsf === undefined).slice(0, 10), "exact", clock); // 埋めた語を 10 語復習（印 0）
  endOfSet();
  eq("8 (c) 埋め（300 語）の直後・書き手より先に読む: 週・今月 +20 のまま・今は 320", [n, ...read], [300, 20, 20, 320]);
  eq("8 (a) 埋めの後の書き込み: 週・今月 +20 のまま", written, [20, 20]);
  eq("8 (d) 埋めた語を 10 語復習しても増えない（+20）", week(0), 20);
  eq("8 (g) 書き手は前の行の core・core0・cb を書き換えない", kept, prevRows);
}
{
  // (b) 埋めた表の保存のすぐ後に書き手が走り、その日はもう書かない: 次の週が正しい
  fourDays("C8b");
  fillNow();
  endOfSet();
  learnNew(5, "2026-12-06", 20);
  endOfSet();
  learnNew(5, "2026-12-12", 20);
  endOfSet();
  eq("8 (b) 埋めの日に書き手が走った後: 12-12 の週は 12-06〜12-12 に覚えた 10", week(0), 10);
}
{
  // (e) 旧いタブが今日の行を作り直しても二重に数えない (f) 古い写しを書き戻されても週が正しい
  fourDays("C8e");
  fillNow();
  endOfSet();
  setNow("2026-12-05", 21);
  learnNew(5, "2026-12-05", 21);
  oldTabWrite();
  const afterOld = week(0);
  setNow("2026-12-05", 22);
  endOfSet();
  eq("8 (e) 埋めの後に旧いタブが今日の行を作り直す: 週 +25・夜の書き込みの後も +25（二重に数えない）", [afterOld, week(0)], [25, 25]);
  fourDays("C8f");
  const snap = LS.getItem("spelldash_growth_log"); // ほかのタブが持っている埋めの前の写し
  fillNow();
  endOfSet();
  LS.setItem("spelldash_growth_log", snap);
  const stale = week(0);
  learnNew(5, "2026-12-05", 21);
  endOfSet();
  eq("8 (f) 古い写しを書き戻された後: 週 +20・夜の回の後 +25", [stale, week(0)], [20, 25]);
}

// ── 9. 表が読めない: 書き手は core を下げない・作らない。一度も読めない端末の週は「–」 ─────────────
{
  const blind = () => {
    LS.setItem("spelldash_schema_version", "6"); // 版 7 の前で、移行を試していない: learnStateSource() は null
    S.forgetWordStats();
  };
  const sight = () => {
    LS.setItem("spelldash_schema_version", "7");
    S.forgetWordStats();
  };
  device("blind");
  for (let i = 0; i < 3; i++) {
    learnNew(5, shift("2026-12-01", i), 20);
    endOfSet();
  }
  const before = growth().find((e) => e.date === "2026-12-03");
  blind();
  setNow("2026-12-03", 22);
  const ws = table();
  answer(PUB.filter((id) => ws[id]?.ls === 2).slice(0, 4), "miss", clock); // 外れても、表が読めない間は前の値
  G.recordGrowthSnapshot({ learned: 0, mastered: 0 });
  const after = growth().find((e) => e.date === "2026-12-03");
  eq("9 表が読めない書き込み: 今日の core・cb・core0・nf は前の値のまま（0 を書かない・下げない）", [after.core, after.cb, after.nf], [before.core, before.cb, before.nf]);
  eq("9 表が読めない: 今の 覚えた は最後に測った行（15）・週 +15", [coreNow(), week(0)], [15, 15]);
  sight();
  device("never");
  blind();
  setNow("2026-12-04", 20);
  answer(unseen(5), "exact", clock);
  G.recordGrowthSnapshot({ learned: 5, mastered: 0 });
  eq("9 一度も読めない端末: core を作らない・週と今月は「–」・今は分からない", [growth().some((e) => "core" in e), week(0), month(), coreNow()], [false, null, null, null]);
}

// ── 10. 30 日空き・西へ・東へ ─────────────
{
  device("travel");
  for (let i = 0; i < 5; i++) {
    learnNew(5, shift("2026-12-01", i), 20);
    endOfSet();
  }
  setNow("2027-01-05", 8);
  endOfSet(); // 30 日空いた朝に学習状況を開く
  const s = series(30);
  ok("10 30 日空いた朝: 昨日までの 7 日は +0（「–」でない）・推移は窓より前の 25 から横の線（30 点）", week(1) === 0 && Array.isArray(s) && s.filter((p) => p.learned === 25).length === 30, { week: week(1), s: Array.isArray(s) ? s.slice(0, 2) : s });
  learnNew(6, "2027-01-05", 20);
  endOfSet();
  eq("10 30 日空いた後に 6 語: 週 +6", week(0), 6);
  learnNew(4, "2027-01-06", 7);
  endOfSet();
  process.env.TZ = "Pacific/Honolulu"; // 西へ（端末の日付が 01-05 に戻る）
  clock = at("2027-01-06", 17);
  const westDay = today();
  answer(unseen(3), "exact", clock);
  endOfSet();
  const westGains = ["2027-01-05", "2027-01-06"].map(gainOf);
  eq("10 西へ（端末の日付 01-05）: 週 +13（6+4+3）・カレンダーは負の値なし（01-05 +13・01-06 0）", [westDay, week(0), westGains], ["2027-01-05", 13, [13, 0]]);
  clock = new RealDate("2027-01-07T20:00:00-10:00").getTime();
  answer(unseen(2), "exact", clock);
  endOfSet();
  process.env.TZ = "Asia/Tokyo"; // 東へ（01-08 が飛ぶ）
  learnNew(5, "2027-01-09", 20);
  endOfSet();
  const all = fn("getCoreDayGains")();
  const gains = all instanceof Map ? [...all].filter(([d]) => d >= "2027-01-01").map(([, v]) => v.gained) : [all];
  eq("10 東へ（01-08 が無い）: 01-09 の週は 01-02〜01-09 の 6+4+3+2+5 = +20・カレンダーに負の値なし", [week(0), gains.every((g) => g === null || g >= 0)], [20, true]);
}

// ── 11. 復元: 新しい形のファイルは戻した値のまま・前の形のファイルは「–」→ 次の書き込みで数え直す・新しい鍵を作らない ─────────────
{
  device("restore");
  for (let i = 0; i < 6; i++) {
    learnNew(5, shift("2026-12-01", i), 20);
    endOfSet();
  }
  const fileLog = LS.getItem("spelldash_growth_log");
  const fileTable = LS.getItem("spelldash_word_stats");
  for (let i = 6; i < 8; i++) {
    learnNew(5, shift("2026-12-01", i), 20);
    endOfSet();
  }
  LS.setItem("spelldash_growth_log", fileLog);
  setTable(JSON.parse(fileTable));
  setNow("2026-12-08", 21);
  eq("11 新しい形のファイル（12-06）を戻した直後: 今 30・週 +25（12-01 の終わりから）", [coreNow(), week(0)], [30, 25]);
  const oldShape = JSON.parse(fileLog).map(({ date, learned, mastered, active, v }) => ({ date, learned, mastered, active, v }));
  LS.setItem("spelldash_growth_log", JSON.stringify(oldShape));
  const blank = week(0);
  LS.writes.length = 0;
  endOfSet();
  eq("11 Batch 90 の前の形のファイルを戻した直後は「–」、次の書き込みで数え直す（+25）", [blank, week(0)], [null, 25]);
  const keys = [...new Set(LS.writes)].sort();
  ok("11 書き手が書く鍵は成長ログと送る印だけ（新しい鍵を作らない）", keys.every((k) => ["spelldash_growth_log", "spelldash_user_items_dirty", "spelldash_user_items_meta"].includes(k)), keys);
}

// ── 12. 答えの道の守り（直す前の木でも通る）: js/game.js の答えの道の関数の本文に、成長ログの書き手と新しい数え方の呼び出しが無い ─────────────
{
  const src = fs.readFileSync(path.join(ROOT, "js/game.js"), "utf8");
  const bodyOf = (name) => {
    const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
    if (!m) return null;
    let depth = 0;
    let j = m.index + m[0].length - 1;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    const open = src.indexOf("{", j);
    depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0) return src.slice(open, k + 1);
    }
    return null;
  };
  const NEW_WORK = /recordGrowthSnapshot|snapshotGrowth|getCore|tallyCore|fillCoreRows|countLearnStates/;
  for (const name of ["completeWord", "acceptChar", "advanceNow", "applyLearnXp"]) {
    const body = bodyOf(name);
    ok(`12 答えの道 ${name}: 本文に成長ログの書き手と 覚えた の数え直しが無い`, body !== null && !NEW_WORK.test(body), body === null ? "関数が無い" : NEW_WORK.exec(body)?.[0]);
  }
  const growthSrc = fs.readFileSync(path.join(ROOT, "js/growthLog.js"), "utf8");
  const mark = /export function markActiveToday\(\) \{[\s\S]*?\n\}/.exec(growthSrc)?.[0] ?? "";
  ok("12 答えのたびの印 markActiveToday は表を読まない（core を数えない）", mark !== "" && !/getWordStats|learnStateSource|core/.test(mark), mark.slice(0, 80));
}

// ── 13. 前からの語の外れと覚え直しを別の回で（移行で 覚えた・印なし・history ありの 600 語） ─────────────
{
  device("recover");
  const ws0 = {};
  const baseWords = [...PUB].reverse().slice(0, 600);
  for (const id of baseWords) ws0[id] = { playCount: 4, correctCount: 4, mastered: true, lastPlayed: "2026-10-20T12:00:00.000Z", history: [{ d: "2026-10-20", r: "o" }], ls: 2 };
  setTable(ws0);
  const end = new Map();
  let cursor = 0;
  const weeks = [];
  for (let i = 0; i < 28; i++) {
    const d = shift("2026-11-01", i);
    learnNew(5, d, 20);
    const unsure = baseWords.filter((id) => table()[id]?.ls === 1);
    if (unsure.length) answer(unsure, "exact", at(d, 20, 10)); // 「あやふや」の回（前の日に外した語の 2 日目 → 覚えた）
    endOfSet();
    for (let j = 0; j < 20; j++) {
      const id = baseWords[cursor++ % baseWords.length];
      if (table()[id]?.ls !== 2) continue;
      answer([id], j < 3 ? "miss" : "exact", at(d, 20, 20) + j);
    }
    endOfSet(); // 「覚えた の復習」の回
    end.set(d, live());
    if (i >= 7) weeks.push([week(0), end.get(d) - end.get(shift(d, -7))]);
  }
  const s30 = series(30);
  const first = Array.isArray(s30) ? s30.find((p) => p.learned !== null) : null;
  ok("13 前からの語を毎日 3 語外し、次の日に覚え直す: 8 日目からの週はその 7 日の学習状況の 覚えた の差と同じ", weeks.length === 21 && weeks.every(([w, t]) => w === t), weeks.slice(0, 4));
  eq("13 今月は学習状況の差（月の始まり 600 から +134）・推移の始めの点はその日の学習状況（11-01 の 602）", [month(), first?.date, first?.learned], [live() - 600, "2026-11-01", end.get("2026-11-01")]);
}

// ── 14. 埋めた語（ls 2・lsf 無し・history 無し）の外れと覚え直し ─────────────
{
  device("relearn");
  const ws0 = {};
  const old = PUB.slice(0, 200);
  for (const id of old) ws0[id] = { ls: 2, playCount: 3, correctCount: 3, mastered: true };
  setTable(ws0);
  const truth = new Map([[shift("2026-12-01", -1), 200]]);
  const bad = [];
  const diffs = [];
  for (let n = 0; n < 20; n++) {
    const d = shift("2026-12-01", n);
    learnNew(5, d, 21);
    const wrong = old.slice(0, 20);
    if (n === 7) answer(wrong, "miss", at(d, 21, 10)); // 覚えた の復習で 20 語を間違える
    if (n === 9 || n === 10) answer(wrong, "exact", at(d, 21, 10)); // あやふや の 1 日目・2 日目 → 覚えた
    endOfSet();
    truth.set(d, live());
    const tw = truth.get(d) - (truth.get(shift(d, -7)) ?? 200);
    if (week(0) !== tw) bad.push([d, week(0), tw]);
  }
  const s30 = series(30);
  if (!Array.isArray(s30)) diffs.push(s30);
  else for (const p of s30) if (p.learned !== null && truth.has(p.date) && p.learned !== truth.get(p.date)) diffs.push([p.date, p.learned - truth.get(p.date)]);
  eq("14 埋めた語を 20 語外し、2 日で覚え直す: 週はどの日も学習状況の差と同じ（12-11 +35・12-15 +55）", bad, []);
  eq("14 推移の点と学習状況の差はどの日も 0", diffs, []);
}

// ── 15. 1 台の人に「–」を出さない ─────────────
{
  // (A) 新しい人。1 日目はマイ単語帳の答えだけ（答えのたびの印だけ・公開の語の記録なし）、2 日目から毎日 10 語
  device("soloA");
  setNow("2026-12-01", 20);
  G.markActiveToday();
  const got = [];
  for (let i = 1; i <= 6; i++) {
    learnNew(10, shift("2026-12-01", i), 21);
    endOfSet();
    got.push([week(0), month()]);
  }
  eq("15 (A) 1 日目はマイ単語帳だけの新しい人: 2〜7 日目の週と今月は +10〜+60（「–」でない）", got, [10, 20, 30, 40, 50, 60].map((n) => [n, n]));
  ok("15 (A) 行に core: null が無い", growth().every((e) => e.core !== null), growth().slice(0, 2));
  // (B) 前の版で Battle だけの日が 3 日、その後 Study の日（移行で ls 2・印なし・history あり）、その後新しい版で 10 語
  device("soloB");
  const ws = {};
  PUB.slice(0, 40).forEach((id, k) => {
    const d = k < 20 ? "2026-12-04" : "2026-12-05";
    ws[id] = { playCount: 3, correctCount: 3, mastered: true, lastPlayed: `${d}T12:00:00.000Z`, history: [{ d, r: "o" }], ls: 2 };
  });
  setTable(ws);
  setGrowth([1, 2, 3, 4, 5].map((n) => ({ date: `2026-12-0${n}`, learned: n < 4 ? 0 : (n - 3) * 20, mastered: n < 4 ? 0 : (n - 3) * 20, active: true, v: 2 })));
  learnNew(10, "2026-12-06", 21);
  endOfSet();
  eq("15 (B) Battle だけの日の後の切り替えの日: 週と今月は +10（「–」でない）・行に core: null が無い", [week(0), month(), growth().some((e) => e.core === null)], [10, 10, false]);
}

// ── 16. 回の途中で閉じた日（回の終わりの書き手が走らない）: 次の日の書き込みでその日に戻す ─────────────
{
  device("leave");
  for (let n = 1; n <= 6; n++) {
    learnNew(10, `2026-12-0${n}`, 21);
    endOfSet();
  }
  learnNew(10, "2026-12-07", 21);
  endOfSet();
  for (let i = 0; i < 7; i++) learnNew(1, "2026-12-07", 21, 20); // 2 セット目を 7 語まで答えて閉じた（答えのたびの印だけ）
  setNow("2026-12-08", 7, 30);
  G.recordGrowthSnapshot({ learned: 0, mastered: 0 }); // 次の朝、学ぶ前に学習状況を開く
  eq("16 次の朝: 昨日までの 7 日 +77・カレンダーの 12-07 +17・推移の 12-07 は 77", [week(1), gainOf("2026-12-07"), seriesPoint("2026-12-07")], [77, 17, 77]);
  setNow("2026-12-09", 7, 30);
  G.recordGrowthSnapshot({ learned: 0, mastered: 0 });
  eq("16 その次の朝: 昨日までの 7 日 +67", week(1), 67);
}

// ── 17. 2 台目 B が埋めの日に一度学習状況を開き、その後は A だけで学ぶ: B の週と今月は「–」 ─────────────
{
  device("A17");
  for (let n = 1; n <= 3; n++) {
    learnNew(10, `2026-12-0${n}`, 21);
    endOfSet();
  }
  const wsA = table();
  const rowsA = growth();
  device("B17");
  setNow("2026-12-03", 22);
  setTable(L.fillLearnStates(viaCloud(wsA), VOCAB.isPublic, isDone, {}).table);
  U.mergeCloudItems(cloudDays(rowsA), "u1");
  endOfSet(); // 埋めの日に一度開いた
  switchTo("A17");
  for (let n = 4; n <= 11; n++) {
    learnNew(10, shift("2026-12-01", n - 1), 21);
    endOfSet();
  }
  const rowsA2 = growth();
  switchTo("B17");
  setNow("2026-12-12", 7, 30);
  U.mergeCloudItems(cloudDays(rowsA2), "u1");
  endOfSet();
  const b = [week(1), month()];
  device("B17b"); // 埋めの日に開かなかった B'
  setNow("2026-12-03", 22);
  setTable(L.fillLearnStates(viaCloud(wsA), VOCAB.isPublic, isDone, {}).table);
  setNow("2026-12-12", 7, 30);
  U.mergeCloudItems(cloudDays(rowsA2), "u1");
  endOfSet();
  eq("17 2 台目 B（埋めの日に開いた）と B'（開かなかった）: 9 日目の朝の昨日までの 7 日と今月は「–」（+0 でない）", [...b, week(1), month()], [null, null, null, null]);
}

// ── 18. 乱数の見張り: 1 台の端末を 40 日（学ぶ・回の終わり・旧いタブ・外れ・覚え直し・古い写しの書き戻し・300 語の埋め）。毎晩の書き手の後の週と今月が
//        「学習状況の 覚えた の差 − 前からの 覚えた の差」と同じ（許す誤差 0）。種 3 つ × 10 回 ─────────────
{
  // 正解: 学習状況の 覚えた − 前からの 覚えた（覚えた で印 lsf の無い語 ＋ 印 0 で これから でない語）
  const truthNow = () => {
    const ws = table();
    let n = 0;
    for (const id of PUB) {
      const s = ws[id];
      const st = L.learnStateOf(s);
      if (st === 2) n++;
      if ((st === 2 && s?.lsf === undefined) || (s?.lsf === 0 && st !== 0)) n--;
    }
    return n;
  };
  const isPos = (s) => Number.isInteger(s?.lsf) && s.lsf > 0;
  const misses = [];
  let runs = 0;
  for (const seed0 of [3, 5, 11]) {
    let seed = seed0;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    for (let run = 0; run < 10; run++) {
      runs++;
      device(`fuzz${seed0}-${run}`);
      const nbEnd = new Map();
      const log = [];
      const fillDay = Math.floor(rnd() * 30) + 3;
      const OPS = ["learn", "learn", "learn", "end", "old", "oldActive", "failBase", "relearn", "failNew", "stale", "snap"];
      for (let i = 0; i < 40; i++) {
        const d = shift("2026-11-01", i);
        let hour = 8;
        let snap = null; // ほかのタブが同じ日に読んでおいた写し（書き手は読んで書くまでが 1 回なので、日をまたいだ写しは書き戻されない）
        const ops = Math.floor(rnd() * 6);
        for (let j = 0; j < ops; j++) {
          setNow(d, hour++);
          const op = pick(OPS);
          if (op === "learn") {
            answer(unseen(Math.floor(rnd() * 6) + 1), "exact", clock);
            if (rnd() < 0.6) endOfSet();
          } else if (op === "end") endOfSet();
          else if (op === "old") oldTabWrite();
          else if (op === "oldActive") G.markActiveToday();
          else if (op === "failBase" || op === "failNew") {
            const ws = table();
            const ids = PUB.filter((id) => L.learnStateOf(ws[id]) === 2 && (op === "failNew" ? isPos(ws[id]) : !isPos(ws[id])));
            if (ids.length) answer([pick(ids)], "miss", clock);
          } else if (op === "relearn") {
            const ws = table();
            const ids = PUB.filter((id) => L.learnStateOf(ws[id]) === 1);
            if (ids.length) answer([pick(ids)], "exact", clock);
          } else if (op === "snap") snap = LS.getItem("spelldash_growth_log");
          else if (op === "stale" && snap) LS.setItem("spelldash_growth_log", snap);
          log.push(`${d.slice(5)} ${op}`);
        }
        if (i === fillDay) {
          // 同期の初めの埋め（答えの記録の無い 覚えた の語を 300 語。印なし・history なし）
          const ws = { ...table() };
          let k = 0;
          for (const id of [...PUB].reverse()) {
            if (k >= 300) break;
            if (ws[id]) continue;
            ws[id] = { playCount: 2, correctCount: 2, mastered: true, ls: 2 };
            k++;
          }
          setTable(ws);
          log.push(`${d.slice(5)} fill300`);
        }
        setNow(d, 23);
        endOfSet(); // 学習状況を開いた（描く前に書く）
        const t = truthNow();
        nbEnd.set(d, t);
        const tWeek = i - 7 < 0 ? t : Math.max(0, t - (nbEnd.get(shift(d, -7)) ?? 0));
        let mBase = 0;
        for (let b = i - 1; b >= 0; b--) {
          if (shift("2026-11-01", b) < `${d.slice(0, 7)}-01`) {
            mBase = nbEnd.get(shift("2026-11-01", b)) ?? 0;
            break;
          }
        }
        const tMonth = Math.max(0, t - mBase);
        const w = week(0);
        const m = month();
        if (w !== tWeek || m !== tMonth) misses.push({ seed: seed0, run, day: d, week: fmtDelta(w), truthWeek: tWeek, month: fmtDelta(m), truthMonth: tMonth, ops: log.slice(-12).join(" ") });
      }
    }
  }
  eq(`18 乱数の見張り（種 3 つ × 10 回 × 40 日）: 週と今月が正解と違う日 0（${runs} 回）`, misses.slice(0, 3), []);
}

// ── 19. 数え始めた日に同じ日の埋めが入る（ゲストで学んだ日にログインして「はい」→ 同期の初めの埋め）: 週・今月・カレンダーはこの端末で覚えた語だけ ─────────────
{
  device("sameday");
  learnNew(5, "2026-12-05", 9);
  endOfSet(); // 数え始めた最初の書き込み（その日の始まり core0 と 前からの 覚えた cb を測る）
  setNow("2026-12-05", 12);
  const n = fillNow(); // 同じ日に、答えの記録の無い 覚えた の語（前からの 覚えた が変わる）
  endOfSet(); // 同じ日の書き直し
  const filled = [n, week(0), month(), gainOf("2026-12-05"), seriesEnd()];
  learnNew(10, "2026-12-05", 21);
  endOfSet();
  const evening = [week(0), month(), gainOf("2026-12-05")];
  setNow("2026-12-07", 20);
  endOfSet();
  const later = [week(0), month(), gainOf("2026-12-05")];
  eq("19 ゲストで 5 語学んだ日に同じ日の埋め（300 語）: 週・今月・その日のカレンダー +5（埋めを数えない）・推移の最後は今の 覚えた 305", filled, [300, 5, 5, 5, 305]);
  eq("19 同じ日にさらに 10 語: 週・今月・カレンダー +15", evening, [15, 15, 15]);
  eq("19 2 日後も 週・今月・その日のカレンダー +15", later, [15, 15, 15]);
  // 前の日から学んでいた端末（数え始めた日が埋めの日より前）
  device("sameday2");
  learnNew(5, "2026-12-04", 21);
  endOfSet();
  learnNew(5, "2026-12-05", 9);
  endOfSet();
  setNow("2026-12-05", 12);
  fillNow();
  endOfSet();
  eq("19 前の日から学んでいた端末: 週・今月 +10・埋めの日のカレンダー +5", [week(0), month(), gainOf("2026-12-05")], [10, 10, 5]);
}

// ── 20. 回の途中で閉じた日に、前からの語の外れや覚え直しもある: 前の行はその日の終わりの 覚えた（新しい語だけを足して上げすぎない） ─────────────
{
  // 6 日、毎日 10 語。7 日目は 10 語で回の終わりの書き手（その日の最後の書き込み）
  const sevenDays = (name) => {
    device(name);
    for (let n = 1; n <= 6; n++) {
      learnNew(10, `2026-12-0${n}`, 21);
      endOfSet();
    }
    learnNew(10, "2026-12-07", 20);
    endOfSet();
  };
  const older = (n) => {
    const ws = table();
    return PUB.filter((id) => ws[id]?.ls === 2 && ws[id].lsf === R.dayNoOf("2026-12-01")).slice(0, n);
  };
  const row07 = () => growth().find((e) => e.date === "2026-12-07")?.core;
  const morning = () => {
    setNow("2026-12-08", 7, 30);
    G.recordGrowthSnapshot({ learned: 0, mastered: 0 }); // 次の朝、学ぶ前に学習状況を開く
    return WR.computeWeeklyReport();
  };
  // (a) 覚えた の復習の回で前からの語を 3 語外して閉じ、新しい語の回で 5 語覚えて閉じた（どちらも書き手なし）
  sevenDays("cut-a");
  answer(older(3), "miss", at("2026-12-07", 21, 0));
  for (let i = 0; i < 5; i++) learnNew(1, "2026-12-07", 21, 30);
  const endA = live();
  const rA = morning();
  eq("20 (a) 外れ 3・新しい語 5 の次の朝: 12-07 の行・昨日までの 7 日・週間レポートの増えと累計は その日の終わりの 72（75 でない）・カレンダーの 12-07 +12・推移の 12-07 は 72", [endA, row07(), week(1), rA.learnedDelta, rA.learnedTotal, gainOf("2026-12-07"), seriesPoint("2026-12-07")], [72, 72, 72, 72, 72, 12, 72]);
  for (let n = 8; n <= 14; n++) {
    learnNew(2, `2026-12-${pad(n)}`, 21);
    endOfSet();
  }
  setNow("2026-12-15", 7, 30);
  G.recordGrowthSnapshot({ learned: 0, mastered: 0 });
  eq("20 (a) 7 日後の朝: 昨日までの 7 日 +14（12-08〜12-14 に 2 語ずつ。11 でない）", week(1), 14);
  // (b) 同じ 7 日目の後、次の日は先に新しい語の回を 5 語終える（その日の最初の書き込みが回の終わり）
  sevenDays("cut-b");
  answer(older(3), "miss", at("2026-12-07", 21, 0));
  for (let i = 0; i < 5; i++) learnNew(1, "2026-12-07", 21, 30);
  learnNew(5, "2026-12-08", 9);
  endOfSet();
  eq("20 (b) 次の日に先に 5 語学んでから書く: 12-07 の行 72・カレンダーの 12-07 +12・12-08 +5・週 +67（12-01 の終わりの 10 から 77）", [row07(), gainOf("2026-12-07"), gainOf("2026-12-08"), week(0)], [72, 12, 5, 67]);
  // (c) 外れだけ（新しい語なし）: 12-07 の行は下がる
  sevenDays("cut-c");
  answer(older(3), "miss", at("2026-12-07", 21, 0));
  const rC = morning();
  eq("20 (c) 外れ 3 だけの次の朝: 12-07 の行・昨日までの 7 日・週間レポートの増えと累計は 67（70 でない）・カレンダーの 12-07 +7", [row07(), week(1), rC.learnedDelta, rC.learnedTotal, gainOf("2026-12-07")], [67, 67, 67, 67, 7]);
  // (d) 覚え直し: 12-05 に外し、12-06 に あやふや の 1 日目、12-07 の書き手の後に 2 日目の自力正解で 覚えた に戻して閉じた
  device("cut-d");
  let back = [];
  for (let n = 1; n <= 6; n++) {
    const d = `2026-12-0${n}`;
    learnNew(10, d, 21);
    if (n === 5) {
      back = older(1);
      answer(back, "miss", at(d, 21, 5));
    }
    if (n === 6) answer(back, "exact", at(d, 21, 5));
    endOfSet();
  }
  learnNew(10, "2026-12-07", 20);
  endOfSet();
  answer(back, "exact", at("2026-12-07", 21, 0));
  morning();
  eq("20 (d) 書き手の後に覚え直して閉じた日の次の朝: 12-07 の行と昨日までの 7 日はその日の終わりの 70・カレンダーの 12-07 +11", [live(), row07(), week(1), gainOf("2026-12-07")], [70, 70, 70, 11]);
  // (e) 直すのは次の日以後の最初の書き込みの 1 回だけ: 12-07 に覚えた語の 1 つをその日のうちに外し、あやふや の 1 日目の自力正解（その後に書き手）。
  //     次の朝に学習状況を開いて 12-07 の行を直した後、12-08 の あやふや の回で 2 日目の自力正解（覚えた に戻る）。戻ったのは 12-08 の分
  device("cut-e");
  for (let n = 1; n <= 6; n++) {
    learnNew(10, `2026-12-0${n}`, 21);
    endOfSet();
  }
  const firstOf07 = learnNew(10, "2026-12-07", 20);
  endOfSet();
  answer([firstOf07[0]], "miss", at("2026-12-07", 21, 0));
  answer([firstOf07[0]], "exact", at("2026-12-07", 21, 5));
  setNow("2026-12-07", 21, 10);
  endOfSet(); // その日の最後の書き込み（69）
  morning();
  const atMorning = row07();
  setNow("2026-12-08", 21);
  answer([firstOf07[0]], "exact", clock);
  endOfSet();
  eq("20 (e) 次の朝に直した後、次の日に覚え直した語は 12-07 に入れない: 12-07 の行 69（朝も夜も）・カレンダーの 12-07 +9・12-08 +1・今 70", [atMorning, row07(), gainOf("2026-12-07"), gainOf("2026-12-08"), live()], [69, 69, 9, 1, 70]);
}

// ── 21. 読み手の決まり（決定の V3・V6）: 今月の数えない日・窓の前の数えない日・推移の今日の点 ─────────────
{
  // (a) 2 台目 B が 11-28 の埋めの日に学習状況を開き、12-04 まで学ばない。12-01〜12-03 は A だけの学習した日（B では core: null）
  device("A21");
  for (let n = 25; n <= 27; n++) {
    learnNew(10, `2026-11-${n}`, 21);
    endOfSet();
  }
  const wsA = table();
  const rowsA = growth();
  device("B21");
  setNow("2026-11-28", 22);
  setTable(L.fillLearnStates(viaCloud(wsA), VOCAB.isPublic, isDone, {}).table);
  U.mergeCloudItems(cloudDays(rowsA), "u1");
  endOfSet();
  switchTo("A21");
  for (let i = 0; i < 6; i++) {
    learnNew(10, shift("2026-11-28", i), 21);
    endOfSet();
  }
  const rowsA2 = growth();
  switchTo("B21");
  setNow("2026-12-04", 21);
  U.mergeCloudItems(cloudDays(rowsA2), "u1");
  learnNew(10, "2026-12-04", 21, 30);
  endOfSet();
  eq("21 (a) 数え始めた 11-28 の行の後、今月に数えない学習した日（12-01〜12-03）がある: 今月は「–」（B の +10 でない）・今は 40", [growth().filter((e) => e.date >= "2026-12-01" && e.date < "2026-12-04").map((e) => e.core), month(), coreNow()], [[null, null, null], null, 40]);
  // (b) 埋めの日に書き手が走った後で、ほかの端末の日の行（core の無い active な行）が届き、次に書く前に読む: 窓の始めより前に core の行が無く、
  //     数え始めた日より前にまだ数えていない学習した日がある → 週は「–」
  device("A21b");
  for (let n = 1; n <= 4; n++) {
    learnNew(10, `2026-12-0${n}`, 21);
    endOfSet();
  }
  const wsA3 = table();
  const rowsA3 = growth();
  device("B21b");
  setNow("2026-12-05", 22);
  setTable(L.fillLearnStates(viaCloud(wsA3), VOCAB.isPublic, isDone, {}).table);
  endOfSet();
  U.mergeCloudItems(cloudDays(rowsA3), "u1");
  eq("21 (b) 数え始めた日より前に、まだ数えていない学習した日が届いた直後: 週は「–」（+0 でない）", [growth().filter((e) => e.date < "2026-12-05").map((e) => e.core), week(0)], [[undefined, undefined, undefined, undefined], null]);
  // (c) 推移の今日の点は今の 覚えた（今日の行の core が古い: 回の途中で閉じた）
  device("series21");
  for (let n = 1; n <= 3; n++) {
    learnNew(10, `2026-12-0${n}`, 21);
    endOfSet();
  }
  learnNew(4, "2026-12-03", 22);
  eq("21 (c) 今日の行の core 30 のまま今の 覚えた 34: 推移の最後の点は 34", [growth().at(-1).core, seriesEnd(), coreNow()], [30, 34, 34]);
}

// ── 22. マイ単語帳で 覚えた（Batch 91。docs/SPEC_MY_WORDS.md §17）: 週間レポートのマス・シェアの文と絵の行・はちゃんの一言（W1〜W4）と、
//        英単語の数と日の行はマイ単語帳の語の有無で同じ（W5。直す前の木でも通る守り） ─────────────
{
  const M = await import(modUrl("js/myWords.js"));
  const H = await import(modUrl("js/hasumi.js"));
  const K = L.ANSWER_KINDS;
  // 描いた週間レポート（入れ物の偽物。シェアのボタンの受け手は付けない）
  const drawWeekly = () => {
    const box = { innerHTML: "", querySelector: () => null };
    const real = document.getElementById;
    document.getElementById = (id) => (id === "weeklyW" ? box : null);
    try {
      WR.renderWeeklyReport("weeklyW");
    } finally {
      document.getElementById = real;
    }
    return box.innerHTML;
  };
  // 数の並び（weekly__grid）のマスの [見出し, 値]
  const cells = (html) => [...html.matchAll(/<div><span>([^<]*)<\/span><strong>(.*?)<\/strong><\/div>/g)].map((m) => [m[1], m[2]]);
  const heads = (html) => cells(html).map(([h]) => h);
  const myCell = (html) => cells(html).find(([h]) => h === "マイ単語帳で 覚えた") ?? null;
  const shareLines = (r) => WR.buildWeeklyShareText(r).split("\n");
  const imageRows = (r) => (typeof WR.weeklyImageRows === "function" ? WR.weeklyImageRows(r) : ["weeklyImageRows が無い"]);
  // マイ単語帳の回の 1 問: 答えの書き手と、答えのたびの学習した日の印・連続日数（js/game.js applyLearnXp と同じ）
  const myAnswer = (key, kind) => {
    M.recordMyAnswer(key, kind, clock);
    G.markActiveToday();
    LV.updateStreak();
  };
  // 学習状況のページを開いた: 成長ログの書き手（js/statsView.js renderGrowthTrend。回の終わりと同じ呼び方）の後に週間レポートを数える
  const openStats = () => {
    endOfSet();
    return WR.computeWeeklyReport();
  };

  // W1〜W3: マイ単語帳だけの人。2 語を覚え、1 語は外した（窓は 12-02〜12-08）
  device("w-my");
  setNow("2026-12-07", 20);
  M.addMyWordsBulk("alpha one, 一\nbeta two, 二\ngamma three, 三");
  setNow("2026-12-08", 21);
  myAnswer("alpha one", K.exact);
  myAnswer("beta two", K.exact);
  myAnswer("gamma three", K.miss);
  const r1 = openStats();
  eq("W1 マイ単語帳だけの人（2 語を覚え、1 語を外した）: myGain 2・マスを出す", [r1.myGain, r1.myShow], [2, true]);
  const html1 = drawWeekly();
  eq("W2 描いた数の並び: 学習した日・英単語で 覚えた・マイ単語帳で 覚えた（+2 語）・思い出せた率の順。「7日で 覚えた」は無い",
    [heads(html1), myCell(html1), html1.includes("7日で 覚えた")],
    [["学習した日", "英単語で 覚えた", "マイ単語帳で 覚えた", "思い出せた率"], ["マイ単語帳で 覚えた", "+2<small> 語</small>"], false]);
  eq("W2 英単語のマスは +0 語のまま（マイ単語帳の語を混ぜない）・はちゃんの一言は増えた週の字", [cells(html1).find(([h]) => h === "英単語で 覚えた")?.[1], H.hasumiWeeklyLine(r1).text], ["+0<small> 語</small>", "増えた語は、来週も復習で出る。"]);
  const lines1 = shareLines(r1);
  const li = lines1.findIndex((s) => s.startsWith("学習 "));
  eq("W3 シェアの文: 「学習 …」の行の次に「マイ単語帳で 覚えた +2語」", lines1[li + 1], "マイ単語帳で 覚えた +2語");
  // （シェアの絵は W6。前の「絵の行にマイ単語帳の行」は、大きい「+0 語 覚えた」の下に小さく出る形だったので W6 (b) に替えた）

  // W4 (a) 窓の中で答えたが増え 0（外しただけ）: マスは +0 語で出る・はちゃんは増えた週の字にしない
  device("w-zero");
  setNow("2026-12-07", 20);
  M.addMyWordsBulk("delta four, 四");
  setNow("2026-12-08", 21);
  myAnswer("delta four", K.miss);
  const r4a = openStats();
  const html4a = drawWeekly();
  eq("W4 (a) 窓の中で答えたが増え 0: myGain 0・マス「+0 語」・見出し「英単語で 覚えた」・シェアの文に「マイ単語帳で 覚えた +0語」",
    [r4a.myGain, r4a.myShow, myCell(html4a), heads(html4a).includes("英単語で 覚えた"), shareLines(r4a).includes("マイ単語帳で 覚えた +0語")],
    [0, true, ["マイ単語帳で 覚えた", "+0<small> 語</small>"], true, true]);
  ok("W4 (a) はちゃんの一言は増えた週の字にしない", H.hasumiWeeklyLine(r4a).text !== "増えた語は、来週も復習で出る。", H.hasumiWeeklyLine(r4a));
  // W4 (b) 前から 覚えた の語（lf の無い ls 2）に今週答えた: lf 0 で数えない。マスは +0 語で出る
  device("w-prev");
  setNow("2026-12-07", 20);
  LS.setItem("spelldash_my_words", JSON.stringify([{ en: "epsilon five", ja: "五", addedAt: "2026-10-01T00:00:00.000Z", ls: 2, lsAt: at("2026-10-05", 20) }]));
  setNow("2026-12-08", 21);
  myAnswer("epsilon five", K.exact);
  const r4b = openStats();
  eq("W4 (b) 前から 覚えた の語に今週答えた: lf 0・myGain 0・マス「+0 語」", [JSON.parse(LS.getItem("spelldash_my_words"))[0].lf, r4b.myGain, myCell(drawWeekly())], [0, 0, ["マイ単語帳で 覚えた", "+0<small> 語</small>"]]);
  // W4 (c)（守り）窓の中でマイ単語帳の語に答えていない人（窓の前に覚えた語だけ）・マイ単語帳を使わない人: マスなし・「7日で 覚えた」のまま・シェアの文と絵の行もそのまま
  device("w-old");
  setNow("2026-11-20", 20);
  M.addMyWordsBulk("zeta six, 六");
  setNow("2026-11-21", 21);
  myAnswer("zeta six", K.exact);
  endOfSet();
  learnNew(3, "2026-12-08", 21, 0, NONBASE);
  LV.updateStreak();
  const r4c = openStats();
  const html4c = drawWeekly();
  eq("W4 (c)（守り）窓の中で答えていない人: マスなし・「7日で 覚えた」・シェアの文にマイ単語帳の字なし（英単語は +3）",
    [myCell(html4c), heads(html4c).includes("7日で 覚えた"), shareLines(r4c).some((s) => s.includes("マイ単語帳")), WR.buildWeeklyShareText(r4c).includes("覚えた +3語")],
    [null, true, false, true]);
  device("w-none");
  learnNew(3, "2026-12-08", 21, 0, NONBASE);
  LV.updateStreak();
  openStats();
  const html4d = drawWeekly();
  eq("W4 (c)（守り）マイ単語帳を使わない人: マスなし・「7日で 覚えた」", [myCell(html4d), heads(html4d)], [null, ["学習した日", "7日で 覚えた", "思い出せた率"]]);

  // W6（Batch 91 の反証）: レポートをシェアの文と絵（アプリの外に出る所）も、マスを出す週は数の並びと同じく頭でどちらの数かを言う。
  //     マイ単語帳だけで学ぶ人の絵に、大きい「+0 語 覚えた」を出さない（英単語の増えが 0 か分からない週にマイ単語帳で 1 語以上覚えたら、大きい数はマイ単語帳の数）
  const hero = (r) => (typeof WR.weeklyImageHero === "function" ? WR.weeklyImageHero(r) : { big: "weeklyImageHero が無い", label: "" });
  const bare = (lines) => lines.filter((s) => /覚えた \+/.test(s) && !/(英単語で|マイ単語帳で) 覚えた \+/.test(s)); // 頭の無い「覚えた +」の行
  eq("W6 (a) マイ単語帳だけの人（英単語 +0・マイ単語帳 +2）: シェアの文に頭の無い「覚えた +」の行が無い・英単語の行は「英単語で 覚えた +0語（累計 0）」",
    [bare(lines1), lines1[li]?.includes("・ 英単語で 覚えた +0語（累計 0）")], [[], true]);
  eq("W6 (b) 同じ人のシェアの絵: 大きい数はマイ単語帳の +2（「語 マイ単語帳で 覚えた」）・下の行は 学習した日 → 「英単語で 覚えた  +0語」（マイ単語帳の行は大きい数と重ねない）",
    [hero(r1).big, hero(r1).label, imageRows(r1).slice(0, 2), imageRows(r1).some((s) => s.startsWith("マイ単語帳で"))],
    ["+2", "語 マイ単語帳で 覚えた", ["学習した日  1 / 7", "英単語で 覚えた  +0語"], false]);
  // 英単語 +3・マイ単語帳 +1 の人（同じ窓）
  device("w-mix");
  setNow("2026-12-07", 20);
  M.addMyWordsBulk("lambda eleven, 十一");
  learnNew(3, "2026-12-08", 21, 0, NONBASE);
  setNow("2026-12-08", 21, 30);
  myAnswer("lambda eleven", K.exact);
  const r6 = openStats();
  const lines6 = shareLines(r6);
  eq("W6 (c) 英単語 +3・マイ単語帳 +1 の人: シェアの文は「英単語で 覚えた +3語（累計 3）」と「マイ単語帳で 覚えた +1語」（頭の無い行なし）・絵の大きい数は英単語の +3（「語 英単語で 覚えた」）・下の行に「マイ単語帳で 覚えた  +1語」",
    [r6.learnedDelta, r6.myGain, bare(lines6), lines6.some((s) => s.includes("・ 英単語で 覚えた +3語（累計 3）")), lines6.includes("マイ単語帳で 覚えた +1語"), hero(r6).big, hero(r6).label, imageRows(r6).includes("マイ単語帳で 覚えた  +1語")],
    [3, 1, [], true, true, "+3", "語 英単語で 覚えた", true]);
  eq("W6 (d) 窓の中で答えたが増えは両方 0: 絵の大きい数は英単語の +0（「語 英単語で 覚えた」）・下の行に「マイ単語帳で 覚えた  +0語」・シェアの文に頭の無い行なし",
    [hero(r4a).big, hero(r4a).label, imageRows(r4a).includes("マイ単語帳で 覚えた  +0語"), bare(shareLines(r4a))], ["+0", "語 英単語で 覚えた", true, []]);
  // 英単語の増えが分からない（–）週（2 台目の数え始め。js/weeklyReport.js knowsLearned）にマイ単語帳で +3: 描く物だけの純な検査
  const unknown6 = { range: "12/2〜12/8", activeDays: 5, learnedDelta: null, learnedTotal: null, retention: null, recallRate: 80, streak: 2, bestScore: 0, myShow: true, myGain: 3 };
  eq("W6 (e) 英単語の増えが分からない週にマイ単語帳で +3: 絵の大きい数はマイ単語帳の +3・下の行の頭は 学習した日（英単語の行は出さない）・シェアの文に頭の無い行なし",
    [hero(unknown6).big, hero(unknown6).label, imageRows(unknown6)[0], imageRows(unknown6).some((s) => s.startsWith("英単語で")), bare(shareLines(unknown6))],
    ["+3", "語 マイ単語帳で 覚えた", "学習した日  5 / 7", false, []]);
  eq("W6 (f)（守り）マスを出さない週（窓の前にだけマイ単語帳に答えた人）: シェアの文は前のまま「覚えた +3語（累計 …）」・絵の大きい数 +3「語 覚えた」・頭の付いた行なし",
    [WR.buildWeeklyShareText(r4c).includes("・ 覚えた +3語（累計"), hero(r4c).big, hero(r4c).label, imageRows(r4c).some((s) => /英単語で|マイ単語帳で/.test(s))],
    [true, "+3", "語 覚えた", false]);

  // W5（守り）英単語の数（週・今月・今の 覚えた・日ごとの増え）と送る日の行は、マイ単語帳の語を足して答えた人と、そうでない人で同じ
  const englishOf = (withMy) => {
    device(withMy ? "w5-my" : "w5-plain");
    const keys = ["eta seven", "theta eight", "iota nine", "kappa ten"];
    if (withMy) {
      setNow("2026-12-01", 8);
      M.addMyWordsBulk(keys.map((k, i) => `${k}, 訳${i}`).join("\n"));
    }
    for (let n = 1; n <= 8; n++) {
      const d = `2026-12-0${n}`;
      learnNew(5, d, 20, 0, NONBASE);
      LV.updateStreak();
      if (withMy && n <= keys.length) {
        setNow(d, 20, 30);
        myAnswer(keys[n - 1], n % 2 ? K.exact : K.miss);
      }
      endOfSet();
    }
    const gains = fn("getCoreDayGains")();
    const days = U.mergeCloudItems([], "u1").toUpload.filter((r) => r.kind === "day").map((r) => [r.key, r.payload]);
    return { week: week(0), month: month(), now: coreNow(), gains: gains instanceof Map ? [...gains] : gains, days, rows: growth().map(({ date, learned, mastered, active }) => ({ date, learned, mastered, active })) };
  };
  const plain = englishOf(false);
  const withMy = englishOf(true);
  eq("W5（守り）英単語の週・今月・今の 覚えた・日ごとの増え・送る日の行（5 つの欄）・成長ログの行は、マイ単語帳の語の有無で同じ", withMy, plain);
}

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join("\n"));
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`OK: 覚えた の増え ${passed} 件`);
