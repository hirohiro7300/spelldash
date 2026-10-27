// 3 つの状態（これから・あやふや・覚えた。js/learnState.js）・公開する英単語の読み手（js/publicVocab.js）・ランク（js/rank.js）と、
// スキーマ 7 の移行・保存・同期・バックアップ（js/storage.js・js/stats.js recordLearnAnswer・js/sync.js・js/backup.js）の単体テスト。ブラウザなし（数秒）:
//   node scripts/test-learn-state.mjs [<木の根>]
// 失敗が 1 つでもあれば終了コード 1。仕様は docs/SPEC_LEARN_STATE.md（創業者の決定 §2・§3・§5・§8・§10）。
// 木の根を渡すと、その木の js/ を読む（変異の確かめ: 写した木の js を壊して流すと落ちる）。
// 端末の偽物（localStorage・sessionStorage・window の出来事・fetch・Supabase）はこのファイルの中だけ。日の境は Asia/Tokyo と America/New_York（夏時間）で見る。
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
const ok = (name, cond) => eq(name, !!cond, true);

// ===== 端末の偽物 =====
// localStorage: 鍵と値の字数の合計に上限（Chromium と同じ数え方。既定は無限）。setItem の鍵の列を控える
class FakeStorage {
  constructor(seed = {}, limit = Infinity) {
    this.map = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
    this.limit = limit;
    this.writes = [];
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    const value = String(v);
    let size = k.length + value.length;
    for (const [kk, vv] of this.map) if (kk !== k) size += kk.length + vv.length;
    if (size > this.limit) {
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      throw error;
    }
    this.map.set(k, value);
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
  dump() {
    return Object.fromEntries([...this.map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}
let LS = new FakeStorage({ spelldash_schema_version: "7" });
let SS = new FakeStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => LS });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => SS });
const listeners = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
};
globalThis.removeEventListener = (type, fn) => {
  const list = listeners.get(type) ?? [];
  const i = list.indexOf(fn);
  if (i >= 0) list.splice(i, 1);
};
globalThis.dispatchEvent = (event) => {
  for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
  return true;
};
const seen = (type) => {
  const got = [];
  globalThis.addEventListener(type, (e) => got.push(e));
  return got;
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
  body: null,
  visibilityState: "visible",
  hidden: false
};
globalThis.location ??= { search: "", hostname: "localhost", pathname: "/", href: "http://localhost/", origin: "http://localhost" };
const confirms = [];
let confirmAnswer = true;
globalThis.confirm = (text) => {
  confirms.push(text);
  return confirmAnswer;
};
globalThis.reportError = () => {};
const quiet = console.warn;
console.warn = () => {};

// fetch: 公開の英単語の表だけ返す（取った回数を数える。fetchFail で落とす）
const VOCAB_TEXT = fs.readFileSync(path.join(ROOT, "data/public/english.json"), "utf8");
let fetchCalls = 0;
let fetchFail = false;
globalThis.fetch = async (u) => {
  fetchCalls++;
  if (fetchFail) throw new TypeError("offline");
  if (String(u).endsWith("data/public/english.json")) return { ok: true, status: 200, json: async () => JSON.parse(VOCAB_TEXT) };
  return { ok: false, status: 404, json: async () => ({}) };
};

// Supabase: js/supabase.js の差し替え口（window.__SUPABASE_MODULE_URL）に、メモリーの表を返す偽のクライアント
const cloud = { user: null, tables: {}, sent: [] };
function fakeQuery(table) {
  const rows = () => cloud.tables[table] ?? [];
  const q = {
    select: () => q,
    eq: () => q,
    in: () => q,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    upsert: async (r) => {
      cloud.sent.push({ table, rows: [].concat(r) });
      return { error: null };
    },
    insert: async (r) => {
      cloud.sent.push({ table, rows: [].concat(r) });
      return { error: null };
    },
    then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject)
  };
  return q;
}
globalThis.__fakeSupabase = {
  auth: {
    getSession: async () => ({ data: { session: cloud.user ? { user: { id: cloud.user } } : null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null })
  },
  from: (table) => fakeQuery(table)
};
globalThis.__SUPABASE_MODULE_URL = `data:text/javascript,${encodeURIComponent("export const createClient = () => globalThis.__fakeSupabase;")}`;

// 偽の時計（書き手の時刻。null なら本物）
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
const R = await import(modUrl("js/rank.js"));
const PV = await import(modUrl("js/publicVocab.js"));
const ST = await import(modUrl("js/stats.js")); // 中で js/storage.js（版 7 の空の端末）と js/sync.js・js/backup.js も読む
const S = await import(modUrl("js/storage.js"));
const SY = await import(modUrl("js/sync.js"));
const BK = await import(modUrl("js/backup.js"));
const CP = await import(modUrl("js/categoryProgress.js"));
const BP = await import(modUrl("js/bookPace.js"));
const { answered } = await import(modUrl("js/mastery.js"));
const { localDay, dayNoOf } = await import(modUrl("js/retentionCalc.js"));
const isDone = (st) => BP.isDoneState(CP.classifyWord(st)); // 今の「済み」（js/pathView.js isRemembered と同じ）
const VOCAB = PV.makePublicVocab(JSON.parse(VOCAB_TEXT));
const PUB = VOCAB.order; // 公開の id（学ぶ順）
const { LEARN_NEW: NEW, LEARN_UNSURE: UNSURE, LEARN_LEARNED: LEARNED, ANSWER_KINDS: K } = L;
const tick = () => new Promise((r) => setTimeout(r, 0));

// 日時の組み立て（端末の時間帯のローカル時刻）
const at = (y, m, d, h = 12, mi = 0) => new RealDate(y, m - 1, d, h, mi).getTime();
const dayOf = (ms) => dayNoOf(localDay(new RealDate(ms)));
// 語の記録の形（今の書き手が作る欄）
const iso = (ms) => new RealDate(ms).toISOString();
const T0 = at(2026, 10, 1, 9);
const stat = (over = {}) => ({ playCount: 1, correctCount: 0, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 0, mastered: false, masteredAt: null, lastPlayed: iso(T0), nextReviewAt: null, lastRecallFailAt: null, lastRecallSuccessAt: null, dailyLearningDate: null, dailyLearningStage: 0, srsAdvancedOn: null, ...over });
const SHAPES = {
  learning: stat({ correctCount: 1, cleanCorrectStreak: 1, lastRecallSuccessAt: iso(T0) }), // 覚えた（自力正解があり未解決でない）
  known: stat({ correctCount: 1, cleanCorrectStreak: 1, knownOnSight: true, lastRecallSuccessAt: iso(T0) }), // 知ってた
  knownOnly: stat({ knownOnSight: true }), // 知ってただけ（日時の無い古い形）
  mastered: stat({ correctCount: 10, cleanCorrectStreak: 10, mastered: true, masteredAt: iso(T0), lastRecallSuccessAt: iso(T0) }), // 習得
  masteredNoDate: stat({ correctCount: 10, cleanCorrectStreak: 10, mastered: true }), // 習得（日時の欄ができる前）
  weak: stat({ recallFail: 1, missCount: 1, lastRecallFailAt: iso(T0 + 60000), lastRecallSuccessAt: iso(T0) }), // 苦手（最後が ×）
  failOnly: stat({ recallFail: 1, missCount: 1, lastRecallFailAt: iso(T0) }), // × だけ
  okNoPlay: stat({ playCount: 0, correctCount: 1, lastRecallSuccessAt: iso(T0) }), // 自力正解はあるが出題の数が 0（今の済みの門で未着手）
  played: stat(), // 出題だけ
  seen: stat({ answerSeenAt: iso(T0) }), // 別解を打って答えを見ただけ
  countsOnly: stat({ correctCount: 3, recallFail: 1 }), // v5 より前の数だけの語（日時が無い）
  retyped: stat({ correctCount: 1, nextReviewAt: iso(T0 + 86400000) }) // 答えを見た後の打ち直しだけ
};
const EXPECT = { learning: LEARNED, known: LEARNED, knownOnly: LEARNED, mastered: LEARNED, masteredNoDate: LEARNED, weak: UNSURE, failOnly: UNSURE, okNoPlay: UNSURE, played: NEW, seen: NEW, countsOnly: NEW, retyped: NEW };

// ── 1. 名前・種類 ─────────────────────────────────────────
eq("状態の名前は 3 つだけ（決定 §2）", [...L.LEARN_LABELS], ["これから", "あやふや", "覚えた"]);
eq("状態の値: これから 0（欄なし）・あやふや 1・覚えた 2", [NEW, UNSURE, LEARNED], [0, 1, 2]);
eq("答えの種類の列挙（判定の種類をコードで分ける: 決定 §3）", Object.values(K), ["exact", "variant", "altAccept", "altIndex", "reveal", "miss", "hint"]);
eq("自力正解に数える種類: 出題語・綴り違い・別解 2 つ", Object.values(K).filter(L.isCleanKind), ["exact", "variant", "altAccept", "altIndex"]);
eq("× に数える種類: 答え表示・1 打ミス・ヒント", Object.values(K).filter((k) => !L.isCleanKind(k)), ["reveal", "miss", "hint"]);
ok("知らない種類は種類でない（書き手が書かない）", !L.isAnswerKind("alt") && !L.isAnswerKind("") && !L.isAnswerKind(undefined) && L.isAnswerKind("altIndex"));
ok("知らない種類は自力正解でない", !L.isCleanKind("alt") && !L.isCleanKind(undefined));

// ── 2. 状態の動き（nextLearnState。決定 §3・依頼の規則 5） ─────────────
const N = (state, day, clean, today) => L.nextLearnState({ state, day }, clean, today);
eq("これから + 自力正解 → 覚えた", N(NEW, null, true, 100), { state: LEARNED, day: null });
eq("これから + × → あやふや（数えた日なし）", N(NEW, null, false, 100), { state: UNSURE, day: null });
eq("あやふや + 自力正解（数えた日なし）→ 今日が 1 日目", N(UNSURE, null, true, 100), { state: UNSURE, day: 100 });
eq("あやふや + 自力正解（数えた日が前の日）→ 覚えた", N(UNSURE, 99, true, 100), { state: LEARNED, day: null });
eq("あやふや + 自力正解（数えた日がずっと前）→ 覚えた", N(UNSURE, 50, true, 100), { state: LEARNED, day: null });
eq("あやふや + 自力正解（数えた日が今日）→ 変わらない", N(UNSURE, 100, true, 100), { state: UNSURE, day: 100 });
eq("あやふや + 自力正解（数えた日が先の日 = 時計が戻った）→ 今日を 1 日目に", N(UNSURE, 102, true, 100), { state: UNSURE, day: 100 });
eq("あやふや + 自力正解（数えた日が 1 日先）→ 今日を 1 日目に（覚えたにしない）", N(UNSURE, 101, true, 100), { state: UNSURE, day: 100 });
eq("あやふや + × → 数えた日を消す", N(UNSURE, 100, false, 100), { state: UNSURE, day: null });
eq("覚えた + 自力正解 → 変わらない", N(LEARNED, null, true, 100), { state: LEARNED, day: null });
eq("覚えた + × → あやふや（数えた日なし）", N(LEARNED, null, false, 100), { state: UNSURE, day: null });
eq("日が読めない時刻の自力正解は数えない", N(UNSURE, null, true, null), { state: UNSURE, day: null });

// ── 3. 語の記録に当てる（applyLearnAnswer）: 決定 §10 の場面 ─────────────
const run = (steps, start = stat(), done = null) => {
  let s = start;
  const trail = [];
  for (const [ms, kind] of steps) {
    s = L.applyLearnAnswer(s, kind, ms, done);
    trail.push(L.learnStateOf(s));
  }
  return { s, trail };
};
const D = (n, h = 12, mi = 0) => at(2026, 10, 1 + n, h, mi);
{
  const r = run([[D(0), K.exact]]);
  eq("初回の自力正解 → 覚えた（数えた日なし・最後に答えた時刻）", [r.trail, r.s.ls, "lsd" in r.s, r.s.lsAt], [[LEARNED], 2, false, D(0)]);
}
for (const kind of [K.miss, K.reveal, K.hint]) {
  const r = run([[D(0), kind]]);
  eq(`初回の × （${kind}）→ あやふや（数えた日なし）`, [r.trail, "lsd" in r.s], [[UNSURE], false]);
}
{
  const r = run([[D(0), K.miss], [D(1), K.exact], [D(2), K.exact]]);
  eq("× の後、別の日に 2 回の自力正解 → 覚えた（1 日目は あやふや のまま）", r.trail, [UNSURE, UNSURE, LEARNED]);
  eq("1 日目の数えた日は答えた日の日番号", run([[D(0), K.miss], [D(1), K.exact]]).s.lsd, dayOf(D(1)));
}
{
  const r = run([[D(0), K.miss], [D(1, 9), K.exact], [D(1, 10), K.exact], [D(1, 18), K.exact], [D(1, 23, 59), K.exact]]);
  eq("同じ日に何回自力正解しても 1 日分（あやふや のまま・数えた日は同じ）", [r.trail, r.s.lsd], [[UNSURE, UNSURE, UNSURE, UNSURE, UNSURE], dayOf(D(1))]);
  eq("その次の日の自力正解で 覚えた", run([[D(2), K.exact]], r.s).trail, [LEARNED]);
}
for (const kind of [K.miss, K.reveal, K.hint]) {
  const r = run([[D(0), K.miss], [D(1, 9), K.exact], [D(2, 9), kind], [D(2, 10), K.exact], [D(3, 9), K.exact]]);
  eq(`誤答のリセット（${kind}）: 数えた日を消し、同じ日の後の自力正解が新しい 1 日目、次の日で 覚えた`, r.trail, [UNSURE, UNSURE, UNSURE, UNSURE, LEARNED]);
}
{
  const r = run([[D(0), K.miss], [D(1, 9), K.exact], [D(2, 9), K.miss]]);
  eq("リセットの後は数えた日が無い", "lsd" in r.s, false);
  eq("× と同じ日の後の自力正解も 1 日目に数える（決定 §3「リセット後、同じ日に自力正解した場合は新しい1日目」）", run([[D(0, 10), K.miss], [D(0, 10, 5), K.exact], [D(1, 10), K.exact]]).trail, [UNSURE, UNSURE, LEARNED]);
}
eq("23:55 と翌日の 0:10 は別の日（23:50 に × → 23:55 ○ → 0:10 ○ で 覚えた）", run([[D(0, 23, 50), K.miss], [D(0, 23, 55), K.exact], [D(1, 0, 10), K.exact]]).trail, [UNSURE, UNSURE, LEARNED]);
eq("0:00 ちょうどは次の日", run([[D(0, 9), K.miss], [D(0, 23, 59), K.exact], [at(2026, 10, 2, 0, 0), K.exact]]).trail, [UNSURE, UNSURE, LEARNED]);
eq("覚えた の語の自力正解は変わらない・× で あやふや（数えた日なし）", run([[D(0), K.exact], [D(1), K.exact], [D(2), K.reveal]]).trail, [LEARNED, LEARNED, UNSURE]);
eq("覚えた → × → 同じ日の ○ → 次の日の ○ で 覚えた に戻る", run([[D(0), K.exact], [D(5, 9), K.miss], [D(5, 9, 1), K.exact], [D(6), K.exact]]).trail, [LEARNED, UNSURE, UNSURE, LEARNED]);
for (const kind of [K.variant, K.altAccept, K.altIndex]) {
  eq(`別解（${kind}）は自力正解と同じ: 初回で 覚えた`, run([[D(0), kind]]).trail, [LEARNED]);
  eq(`別解（${kind}）は あやふや の 1 日分にも数える`, run([[D(0), K.miss], [D(1), kind], [D(2), kind]]).trail, [UNSURE, UNSURE, LEARNED]);
}
{
  // 時計が戻る: 先の日（D 3）に数えた語を、時計を戻して D 1 に答える → 今日を 1 日目に置き直し、D 1 のうちは 覚えたにしない。D 2 で 覚えた
  const ahead = run([[D(3, 9), K.miss], [D(3, 10), K.exact]]).s;
  const back = run([[D(1, 9), K.exact], [D(1, 20), K.exact], [D(2, 9), K.exact]], ahead);
  eq("時計が戻った: 先の日に数えた語は、戻った日に 1 日目へ置き直し（二重に数えない）、次の日で 覚えた", [back.trail, run([[D(1, 9), K.exact]], ahead).s.lsd], [[UNSURE, UNSURE, LEARNED], dayOf(D(1))]);
  // 今日数えた後に時計を 1 日戻す: 前の日として 2 日目に数えない
  const today = run([[D(5, 9), K.miss], [D(5, 10), K.exact]]).s;
  eq("今日数えた後に時計を 1 日戻して答えても 覚えた にしない", run([[D(4, 23), K.exact]], today).trail, [UNSURE]);
}
{
  // 夏時間（America/New_York）: 切り替えの日の 0:30 と 23:30 は同じ日。次の日の 0:10 は別の日
  process.env.TZ = "America/New_York";
  const ny = (y, m, d, h, mi = 0) => new RealDate(y, m - 1, d, h, mi).getTime();
  for (const [label, y, m, d] of [["終わり 2026-11-01", 2026, 11, 1], ["始まり 2027-03-14", 2027, 3, 14]]) {
    const r = run([[ny(y, m, d, 0, 5), K.miss], [ny(y, m, d, 0, 30), K.exact], [ny(y, m, d, 23, 30), K.exact], [ny(y, m, d + 1, 0, 10), K.exact]]);
    eq(`夏時間の${label}: 同じ暦日の 0:30 と 23:30 は 1 日分・次の日の 0:10 で 覚えた（America/New_York）`, r.trail, [UNSURE, UNSURE, UNSURE, LEARNED]);
  }
  eq("夏時間の日の日番号は前の日 +1・次の日 +2（America/New_York）", [L.learnDayOf(ny(2026, 11, 1, 23, 30)) - L.learnDayOf(ny(2026, 10, 31, 23, 30)), L.learnDayOf(ny(2026, 11, 2, 0, 10)) - L.learnDayOf(ny(2026, 10, 31, 23, 30))], [1, 2]);
  process.env.TZ = "Asia/Tokyo";
}
{
  const before = Object.freeze({ ...SHAPES.weak, masteryRank: 3, history: Object.freeze([{ d: "2026-10-01", r: "x" }]) });
  const after = L.applyLearnAnswer(before, K.exact, D(2));
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !L.LEARN_FIELDS.includes(k)));
  ok("当てても答える前の記録は書き換えない（凍らせた記録で投げない）", after !== before && !("ls" in before));
  eq("ほかの欄はそのまま（ls・lsd・lsAt だけを替える）", strip(after), strip(before));
  eq("速さは見ない: 段・速さの欄があっても同じ答え", L.applyLearnAnswer({ ...stat(), masteryRank: 5, sp: [[1, 300, 50, "f", 1]] }, K.miss, D(0)).ls, L.applyLearnAnswer(stat(), K.miss, D(0)).ls);
}
{
  // 移行が済んでいない間（isDone を渡す）: 欄の無い語は移行の式で読んで動かす
  eq("移行の前: 欄の無い 覚えた の形の語に × → あやふや", run([[D(0), K.miss]], SHAPES.learning, isDone).trail, [UNSURE]);
  eq("移行の前: 欄の無い 苦手 の形の語に自力正解 → 1 日目（あやふや）", run([[D(0), K.exact]], SHAPES.weak, isDone).trail, [UNSURE]);
  eq("移行の後（isDone なし）: 欄の無い語は これから から（Battle の答えは数えない）", run([[D(0), K.exact]], SHAPES.weak).trail, [LEARNED]);
}

// ── 4. 旧の記録からの移行（stateFromRecord。今の「済み」と同じ定義: js/categoryProgress.js classifyWord） ─────────────
for (const [name, s] of Object.entries(SHAPES)) {
  eq(`移行: ${name} → ${L.LEARN_LABELS[EXPECT[name]]}`, L.stateFromRecord(s, isDone), EXPECT[name]);
}
{
  // 済み = 覚えた・習得・知ってた（classifyWord）・答えの記録 = answered。式が今の判定と 1 語も違わない・3 つは重ならない（ランダムな形 2,000 語）
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let diff = 0;
  let overlap = 0;
  for (let i = 0; i < 2000; i++) {
    const s = stat({
      playCount: pick([0, 1, 3]),
      recallFail: pick([0, 0, 1, 2]),
      mastered: rnd() < 0.15,
      knownOnSight: rnd() < 0.2,
      lastRecallSuccessAt: pick([null, iso(T0), iso(T0 + 7200000)]),
      lastRecallFailAt: pick([null, null, iso(T0 + 3600000)]),
      answerSeenAt: rnd() < 0.1 ? iso(T0) : undefined
    });
    const got = L.stateFromRecord(s, isDone);
    const want = isDone(s) ? LEARNED : answered(s) ? UNSURE : NEW;
    if (got !== want) diff++;
    if (isDone(s) && !answered(s)) overlap++;
  }
  eq("移行の式は今の済み（classifyWord）と答えの記録（answered）から 1 語も違わない（2,000 語）", diff, 0);
  eq("済みの語には必ず答えの記録がある（3 状態は重ならない）", overlap, 0);
}

// ── 5. 埋める（fillLearnStates）と数える（countLearnStates） ─────────────
const table0 = () => ({
  [PUB[0]]: SHAPES.learning,
  [PUB[1]]: SHAPES.weak,
  [PUB[2]]: SHAPES.played,
  [PUB[3]]: SHAPES.known,
  [PUB[4]]: SHAPES.mastered,
  [PUB[5]]: { ...SHAPES.weak, ls: 2, lsAt: T0 }, // 前から欄のある語（上書きしない）
  [PUB[6]]: SHAPES.failOnly,
  "concept-ad-cpc": SHAPES.learning, // 非公開（概念カード）
  "my-river": SHAPES.weak, // 非公開（マイ単語帳）
  "english-zzz-not-public": SHAPES.learning, // 非公開の英単語
  [PUB[7]]: "broken" // 表でない値
});
{
  const t = table0();
  const before = JSON.stringify(t);
  const one = L.fillLearnStates(t, VOCAB.isPublic, isDone);
  const two = L.fillLearnStates(one.table, VOCAB.isPublic, isDone);
  eq("埋めた語の数（答えのある公開の語で欄の無い 5 語）", one.filled, 5);
  eq("埋めた状態: 覚えた・あやふや・（出題だけは書かない）・知ってた → 覚えた・習得 → 覚えた・前からの欄・× だけ → あやふや", [PUB[0], PUB[1], PUB[2], PUB[3], PUB[4], PUB[5], PUB[6]].map((id) => one.table[id].ls), [2, 1, undefined, 2, 2, 2, 1]);
  ok("元の表は書き換えない", JSON.stringify(t) === before);
  eq("2 回目は何も埋めない（何度流しても同じ）", [two.table, two.filled], [null, 0]);
  eq("非公開の語・表でない値には触らない（同じ文字列）", ["concept-ad-cpc", "my-river", "english-zzz-not-public", PUB[7]].map((id) => JSON.stringify(one.table[id])), ["concept-ad-cpc", "my-river", "english-zzz-not-public", PUB[7]].map((id) => JSON.stringify(t[id])));
  const strip = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== "ls")) : o);
  ok("ほかの欄は 1 つも変えない（ls だけ足す）", Object.keys(t).every((id) => isDeepStrictEqual(strip(one.table[id]), strip(t[id]))));
  eq("id の集合は同じ（間引かない）", Object.keys(one.table).sort(), Object.keys(t).sort());
  ok("埋める候補があるか（hasUnfilled）: 前 true・後 false", L.hasUnfilled(t) && !L.hasUnfilled({ [PUB[0]]: one.table[PUB[0]], [PUB[2]]: SHAPES.played }));
  const c = L.countLearnStates(one.table, VOCAB);
  eq("数: 公開の語だけ（非公開の 3 語は数えない）", c, { new: VOCAB.total - 6, unsure: 2, learned: 4, total: VOCAB.total });
  eq("移行の前の読み（isDone）は移行の後の数と同じ", L.countLearnStates(t, VOCAB, isDone), c);
  eq("同期の初めの埋め: 取り込む前の端末に答えのある語は埋めない", L.fillLearnStates({ [PUB[0]]: SHAPES.learning, [PUB[1]]: SHAPES.learning, [PUB[2]]: SHAPES.weak }, VOCAB.isPublic, isDone, { [PUB[0]]: SHAPES.failOnly, [PUB[1]]: SHAPES.played }).table, { [PUB[0]]: SHAPES.learning, [PUB[1]]: { ...SHAPES.learning, ls: 2 }, [PUB[2]]: { ...SHAPES.weak, ls: 1 } });
}
{
  // 排他と合計: どんな表でも これから＋あやふや＋覚えた = 公開の語数
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let bad = 0;
  for (let k = 0; k < 30; k++) {
    const t = {};
    for (let i = 0; i < 400; i++) {
      const id = rnd() < 0.8 ? PUB[Math.floor(rnd() * PUB.length)] : `concept-x${i}`;
      t[id] = { ...stat(), ls: [undefined, 1, 2, 3, "2", null][Math.floor(rnd() * 6)] };
    }
    const c = L.countLearnStates(t, VOCAB);
    if (c.new + c.unsure + c.learned !== c.total || c.total !== VOCAB.total || c.new < 0) bad++;
  }
  eq("3 状態の和はいつも公開の語数（読めない欄の値は これから）", bad, 0);
  eq("記録の無い端末: これから が全部", L.countLearnStates({}, VOCAB), { new: VOCAB.total, unsure: 0, learned: 0, total: VOCAB.total });
}

// ── 6. 公開の語の読み手（js/publicVocab.js） ─────────────
eq("公開の語数は表の total（2,857。数はここに持たない）", [VOCAB.total, VOCAB.order.length], [JSON.parse(VOCAB_TEXT).total, JSON.parse(VOCAB_TEXT).order.length]);
eq("並びと位置: 先頭・最後・無い id", [VOCAB.positionOf(PUB[0]), VOCAB.positionOf(PUB.at(-1)), VOCAB.positionOf("concept-x"), VOCAB.isPublic(PUB[10]), VOCAB.isPublic("english-zzz")], [0, VOCAB.total - 1, -1, true, false]);
for (const [name, bad] of [["語数と order が合わない", { total: 3, order: ["a", "b"] }], ["id が重なる", { total: 2, order: ["a", "a"] }], ["order が無い", { total: 0 }], ["id が文字列でない", { total: 2, order: ["a", 3] }]]) {
  let threw = false;
  try {
    PV.makePublicVocab(bad);
  } catch {
    threw = true;
  }
  ok(`形の違う表は投げる（${name}）`, threw);
}
// ── 7. ランク（js/rank.js。決定 §5） ─────────────
const T = VOCAB.total;
eq("9 段の名前", [...R.RANK_NAMES], ["赤ちゃん", "よちよち", "単語キッズ", "小学生", "中学生", "高校生", "留学生", "バイリンガル", "アメリカ人"]);
eq("境: 0・120・350・650・1,000・1,400・1,850・2,350・公開の語数", R.rankThresholds(T), [0, 120, 350, 650, 1000, 1400, 1850, 2350, T]);
{
  const at9 = R.rankThresholds(T);
  const got = [];
  const want = [];
  for (let k = 1; k < at9.length; k++) {
    got.push([R.rankFor(at9[k] - 1, T), R.rankFor(at9[k], T), R.rankFor(at9[k] + 1, T)]);
    want.push([k - 1, k, Math.min(k, 8)]);
  }
  eq("ランクの境の前後（境 −1・境・境 +1）", got, want);
  eq("0 語は 赤ちゃん・総数でアメリカ人", [R.rankFor(0, T), R.rankFor(T, T), R.RANK_NAMES[R.rankFor(T, T)]], [0, 8, "アメリカ人"]);
}
eq("次のランクまで: 100 語の赤ちゃん → よちよち まであと 20 語", R.nextRankGap(100, 0, T), { rank: 1, name: "よちよち", at: 120, remaining: 20 });
eq("次のランクまで: 最高 3（小学生）で今 500 語 → 中学生まであと 500 語（今の数で正直に）", R.nextRankGap(500, R.shownRank(500, 3, T), T), { rank: 4, name: "中学生", at: 1000, remaining: 500 });
eq("アメリカ人の後は「あと M 語」を出さない", R.nextRankGap(T, 8, T), null);
eq("見せるランクは最高到達ランクより下がらない（覚えたが減っても）", [R.shownRank(10, 5, T), R.shownRank(1500, 2, T), R.shownRank(130, null, T)], [5, 5, 1]);
{
  const store = new FakeStorage();
  const trail = [R.raiseRankPeak(3, store).peak, R.raiseRankPeak(2, store).peak, R.raiseRankPeak(0, store).peak, R.raiseRankPeak(5, store).peak, R.raiseRankPeak(9, store).peak, R.raiseRankPeak("x", store).peak];
  eq("最高到達ランクは下がらない（3 → 2・0 は書かない → 5。範囲の外・読めない値は無視）", [trail, store.getItem(R.RANK_PEAK_KEY)], [[3, 3, 3, 5, 5, 5], "5"]);
  const full = new FakeStorage({ [R.RANK_PEAK_KEY]: "2" }, 10);
  eq("書けない（容量）: saved false・値はそのまま・投げない", [R.raiseRankPeak(4, full), full.getItem(R.RANK_PEAK_KEY)], [{ peak: 2, saved: false }, "2"]);
  eq("鍵の名前（spelldash_ で始まる: バックアップに入り、置き換えで消える）", R.RANK_PEAK_KEY, "spelldash_rank_peak");
  eq("読めない保存の値は null（壊れた値で上げない）", ["", "-1", "8.5", "9", "abc", "3"].map(R.parseRankPeak), [null, null, null, null, null, 3]);
}

console.warn = quiet;
if (failures.length) {
  console.error(`test-learn-state: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-learn-state: ${passed} passed`);
process.exit(0);
