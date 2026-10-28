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
eq("あやふや + 自力正解（数えた日が先の日 = 時計が戻った）→ 変わらない（前に数えた日を残す）", N(UNSURE, 102, true, 100), { state: UNSURE, day: 102 });
eq("あやふや + 自力正解（数えた日が 1 日先 = 西へ日付をまたいだ）→ 変わらない（覚えたにしない・前に数えた日を残す）", N(UNSURE, 101, true, 100), { state: UNSURE, day: 101 });
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
  // 時計が戻る: 先の日（D 3）に数えた語を、時計を戻して D 1・D 2 に答えても数えない（前に数えた日 D 3 を残す）。D 3 も同じ日。D 4 で 覚えた
  // （創業者に送った既定「前に数えた日より後の日だけを数える」・dataloss d13）
  const ahead = run([[D(3, 9), K.miss], [D(3, 10), K.exact]]).s;
  const back = run([[D(1, 9), K.exact], [D(1, 20), K.exact], [D(2, 9), K.exact], [D(3, 11), K.exact], [D(4, 9), K.exact]], ahead);
  eq("時計が戻った: 先の日に数えた語は、戻った日・数えた日には数えず（前に数えた日を残す）、その後の日で 覚えた", [back.trail, run([[D(1, 9), K.exact]], ahead).s.lsd], [[UNSURE, UNSURE, UNSURE, UNSURE, LEARNED], dayOf(D(3))]);
  // d13: 数えた日 = N で、N−1・N・N+1 の自力正解 → 変わらない・変わらない・覚えた
  const atN = { ...stat(), ls: UNSURE, lsd: dayOf(D(5)) };
  eq("数えた日 N に、N−1・N・N+1 の自力正解 → 変わらない・変わらない・覚えた（dataloss d13）", run([[D(4, 12), K.exact], [D(5, 12), K.exact], [D(6, 12), K.exact]], atN).trail, [UNSURE, UNSURE, LEARNED]);
  // 10/2 に 1 日目 → 時計を 1 日戻して 10/1 → 10/2 に戻す: 10/2 を 1 日目と 2 日目に二重に数えない（反証 M2・F2）
  eq("10/2 → 時計を戻して 10/1 → 10/2 の自力正解は 1 日分（あやふや のまま）", run([[D(1, 10), K.exact], [D(0, 10, 5), K.exact], [D(1, 10, 10), K.exact]], { ...stat(), ls: UNSURE }).trail, [UNSURE, UNSURE, UNSURE]);
  // 東京 10:00 → 3 時間後にホノルル（ローカルの日付は前の日）→ 6 時間後に東京（同じ JST の日）: 1 日分（西へ日付をまたいでも二重に数えない）
  {
    const tokyo = (h) => new RealDate(Date.UTC(2026, 9, 2, h - 9)).getTime();
    const s1 = L.applyLearnAnswer({ ...stat(), ls: UNSURE }, K.exact, tokyo(10));
    process.env.TZ = "Pacific/Honolulu";
    const s2 = L.applyLearnAnswer(s1, K.exact, tokyo(13));
    process.env.TZ = "Asia/Tokyo";
    const s3 = L.applyLearnAnswer(s2, K.exact, tokyo(16));
    eq("東京 → ホノルル（前の日）→ 東京（同じ日）の自力正解は 1 日分（あやふや・数えた日は東京の日）", [s1.ls, s2.ls, s3.ls, s3.lsd], [UNSURE, UNSURE, UNSURE, s1.lsd]);
  }
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
  // 移行が書けていない間（fallback = 移行を試したときに式で決めた状態）: 欄の無い語はその状態から動かす
  eq("移行の前: 欄の無い語（式で 覚えた）に × → あやふや", run([[D(0), K.miss]], SHAPES.learning, LEARNED).trail, [UNSURE]);
  eq("移行の前: 欄の無い語（式で あやふや）に自力正解 → 1 日目（あやふや）", run([[D(0), K.exact]], SHAPES.weak, UNSURE).trail, [UNSURE]);
  eq("移行の後（fallback なし）: 欄の無い語は これから から（Battle の答えは数えない）", run([[D(0), K.exact]], SHAPES.weak).trail, [LEARNED]);
  eq("fallback は 1・2 だけ（ほかの値は これから）・欄があれば欄の値", [L.learnStateOf(stat(), 3), L.learnStateOf(stat(), "2"), L.learnStateOf(stat(), LEARNED), L.learnStateOf({ ...stat(), ls: UNSURE }, LEARNED)], [NEW, NEW, LEARNED, UNSURE]);
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
  eq("移行の前の読み（埋めた語の状態 states を pending に）は移行の後の数と同じ", [L.countLearnStates(t, VOCAB, one.states), [...one.states.values()]], [c, [2, 1, 2, 2, 1]]);
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
eq("公開の語数は表の total（数はここに持たない）", [VOCAB.total, VOCAB.order.length], [JSON.parse(VOCAB_TEXT).total, JSON.parse(VOCAB_TEXT).order.length]);
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

// ── 8. スキーマ 7 の移行（js/storage.js。読み込みのたびに新しいモジュールで「開き直す」） ─────────────
let loads = 0;
const openStorage = async () => import(`${modUrl("js/storage.js")}?open=${++loads}`);
const schema6 = () => ({ spelldash_schema_version: "6", spelldash_word_stats: JSON.stringify(table0()), spelldash_xp: "120" });
{
  // 表が取れない（オフライン）: 版 6 のまま。読み手の材料も無い（状態を出さない）。公開の語の表をまだ読んでいないこのプロセスの最初に流す
  fetchFail = true;
  LS = new FakeStorage(schema6());
  const m = await openStorage();
  const src = await m.loadLearnStates();
  eq("表が取れない: 版 6 のまま・材料なし（null）", [LS.getItem("spelldash_schema_version"), src], ["6", null]);
  fetchFail = false;
}
{
  LS = new FakeStorage(schema6());
  const calls = fetchCalls;
  const m = await openStorage();
  const src = await m.loadLearnStates();
  const t = JSON.parse(LS.getItem("spelldash_word_stats"));
  eq("版 6 の記録を開く → 版 7・欄を埋める（公開の語だけ）", [LS.getItem("spelldash_schema_version"), PUB.slice(0, 7).map((id) => t[id].ls)], ["7", [2, 1, undefined, 2, 2, 2, 1]]);
  eq("非公開の語・ほかの鍵はそのまま", [t["concept-ad-cpc"], t["my-river"], t["english-zzz-not-public"], t[PUB[7]], LS.getItem("spelldash_xp")], [SHAPES.learning, SHAPES.weak, SHAPES.learning, "broken", "120"]);
  ok("移行の後の読み手の材料: pending なし（欄の無い語は これから）", src && src.pending === null && src.vocab.total === T);
  eq("移行の後の数", L.countLearnStates(t, src.vocab, src.pending), { new: T - 6, unsure: 2, learned: 4, total: T });
  ok("表は 1 回だけ取る", fetchCalls - calls === 1);
  const text = LS.getItem("spelldash_word_stats");
  const m2 = await openStorage();
  await m2.loadLearnStates();
  ok("開き直しても同じ（何度流しても同じ文字列）", LS.getItem("spelldash_word_stats") === text && LS.getItem("spelldash_schema_version") === "7");
  LS.setItem("spelldash_schema_version", "6"); // ロールバックの後の版 6（欄は残っている）
  const m3 = await openStorage();
  await m3.loadLearnStates();
  ok("版が 6 に戻っても、欄のある語は飛ばす（同じ文字列）・版 7", LS.getItem("spelldash_word_stats") === text && LS.getItem("spelldash_schema_version") === "7");
}
{
  LS = new FakeStorage({ spelldash_schema_version: "6" });
  const calls = fetchCalls;
  await openStorage();
  ok("記録の無い端末: その場で版 7（表を取らない）", LS.getItem("spelldash_schema_version") === "7" && fetchCalls === calls);
  LS = new FakeStorage({});
  await openStorage();
  eq("初めての端末（版の鍵なし）: 版 7・空の表", [LS.getItem("spelldash_schema_version"), LS.getItem("spelldash_word_stats")], ["7", "{}"]);
  LS = new FakeStorage({ spelldash_schema_version: "6", spelldash_word_stats: JSON.stringify({ [PUB[0]]: SHAPES.played, "concept-x": SHAPES.learning }) });
  const m = await openStorage();
  await m.loadLearnStates();
  const t = JSON.parse(LS.getItem("spelldash_word_stats"));
  ok("埋める公開の語が無い端末: 表を書かずに版 7（出題だけの語・非公開の語は欄なし）", LS.getItem("spelldash_schema_version") === "7" && !("ls" in t[PUB[0]]) && !("ls" in t["concept-x"]));
}
{
  // 容量: 移行の書き込みが入らない → 版 6 のまま・表は不変・読み込みは投げない。読み手は移行の式で読む。容量が空いた次の読み込みで済む（dataloss d1）
  const seed = schema6();
  const size = Object.entries(seed).reduce((n, [k, v]) => n + k.length + v.length, 0);
  LS = new FakeStorage(seed, size + 12); // 1 語ぶんの「,"ls":2」も入らない
  const text = LS.getItem("spelldash_word_stats");
  const failed = seen("spelldash:save-failed");
  let threw = false;
  let src = null;
  try {
    const m = await openStorage();
    src = await m.loadLearnStates();
  } catch {
    threw = true;
  }
  eq("容量で書けない: 読み込みは投げない・版 6 のまま・表は同じ文字列・保存の失敗を知らせる（移行の失敗の印つき）", [threw, LS.getItem("spelldash_schema_version"), LS.getItem("spelldash_word_stats") === text, failed.length, failed[0]?.detail?.migration], [false, "6", true, 1, true]);
  ok("その間の読み手は、移行を試したときに式で決めた状態で読む（pending）・数は移行の後と同じ", src && src.pending instanceof Map && isDeepStrictEqual(L.countLearnStates(JSON.parse(text), src.vocab, src.pending), { new: T - 6, unsure: 2, learned: 4, total: T }));
  LS.limit = Infinity;
  const m = await openStorage();
  await m.loadLearnStates();
  ok("容量が空いた次の読み込みで版 7・欄が入る", LS.getItem("spelldash_schema_version") === "7" && JSON.parse(LS.getItem("spelldash_word_stats"))[PUB[0]].ls === 2);
}
{
  // 版の鍵が無い（手で直したバックアップなど）: v3 → v4 の付け替えで前置きの付いた id を動かさない（dataloss d10）。前置きの無い古い鍵は english- へ
  LS = new FakeStorage({ spelldash_word_stats: JSON.stringify({ "concept-ad-cpc": SHAPES.learning, "my-q-hello": SHAPES.weak, "my-river": SHAPES.weak, [PUB[0]]: SHAPES.learning, apple: SHAPES.weak }), spelldash_mission: JSON.stringify({ review: ["concept-ad-cpc", "my-river", "apple"] }) });
  const m = await openStorage();
  await m.loadLearnStates();
  const t = JSON.parse(LS.getItem("spelldash_word_stats"));
  eq("版の鍵なし: concept-・my-・my-q- の id は付け替えない・前置きの無い鍵だけ english- に", Object.keys(t).sort(), ["concept-ad-cpc", "english-apple", "my-q-hello", "my-river", PUB[0]].sort());
  eq("ミッションの id も同じ", JSON.parse(LS.getItem("spelldash_mission")).review, ["concept-ad-cpc", "my-river", "english-apple"]);
}

{
  // 公開の語の表の読み込みは 1 ページに 1 回（上の移行で読んだ表を使い回す。取り直さない）
  const calls = fetchCalls;
  const [a, b] = await Promise.all([PV.loadPublicVocab(), PV.loadPublicVocab()]);
  const c = await PV.loadPublicVocab();
  ok("読み込み済みの表を使い回す（fetch 0 回）・同じ表", fetchCalls === calls && a === b && b === c && PV.publicVocabNow() === a && a.total === VOCAB.total);
}

// ── 9. 書き手（js/stats.js recordLearnAnswer）と保存 ─────────────
// 書き手はページの js/storage.js（ST が読んだもの）を使う。表と材料はそこで読む
LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_word_stats: "{}" });
S.forgetWordStats();
await S.loadLearnStates();
const W = PUB[20];
{
  clock = D(0, 10);
  ST.recordPlay(W);
  const saved = await ST.recordLearnAnswer(W, K.exact);
  const t = JSON.parse(LS.getItem("spelldash_word_stats"));
  eq("書き手: 公開の語の初回の自力正解 → 覚えた と保存（true）", [saved, t[W].ls, t[W].lsAt], [true, 2, D(0, 10)]);
  eq("書き手: 非公開の語は書かない（false）", [await ST.recordLearnAnswer("concept-ad-cpc", K.exact), await ST.recordLearnAnswer("english-zzz-not-public", K.miss), "concept-ad-cpc" in JSON.parse(LS.getItem("spelldash_word_stats"))], [false, false, false]);
  eq("書き手: 知らない種類は書かない（false）", await ST.recordLearnAnswer(W, "alt"), false);
  clock = D(1, 10);
  await ST.recordLearnAnswer(W, K.hint);
  clock = D(1, 11);
  await ST.recordLearnAnswer(W, K.exact);
  eq("書き手: 覚えた → ヒント → 同じ日の自力正解（1 日目）", [JSON.parse(LS.getItem("spelldash_word_stats"))[W].ls, JSON.parse(LS.getItem("spelldash_word_stats"))[W].lsd], [1, dayOf(D(1))]);
}
{
  // 5月（english-may-month）と助動詞の may（english-may）は綴りが同じでも別の項目（創業者の決定 2026-10-28 §1）: 状態はカードの id ごとに持ち、
  // 片方の答えでもう片方は動かない。端末は別の写しで流し、後の検査の端末（LS）に戻す
  const MONTH = "english-may-month";
  const AUX = "english-may";
  const kept = LS;
  ok("5月と助動詞の may: どちらも公開の語（別の id・別の位置）", VOCAB.isPublic(MONTH) && VOCAB.isPublic(AUX) && VOCAB.positionOf(MONTH) !== VOCAB.positionOf(AUX));
  const auxBefore = { ...SHAPES.weak, ls: UNSURE };
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_word_stats: JSON.stringify({ [AUX]: auxBefore }) });
  S.forgetWordStats();
  await S.loadLearnStates();
  clock = D(0, 10);
  ST.recordPlay(MONTH);
  const saved = await ST.recordLearnAnswer(MONTH, K.exact);
  const t1 = JSON.parse(LS.getItem("spelldash_word_stats"));
  eq("5月の自力正解: 5月は 覚えた・助動詞の may は あやふや のまま（欄も変えない）", [saved, t1[MONTH]?.ls, JSON.stringify(t1[AUX])], [true, LEARNED, JSON.stringify(auxBefore)]);
  clock = D(0, 11);
  ST.recordPlay(AUX);
  await ST.recordLearnAnswer(AUX, K.miss);
  const t2 = JSON.parse(LS.getItem("spelldash_word_stats"));
  eq("助動詞の may の ×: 5月は 覚えた のまま", [t2[MONTH]?.ls, t2[AUX].ls], [LEARNED, UNSURE]);
  eq("数: 2 語は別々に数える（覚えた 1・あやふや 1）", L.countLearnStates(t2, VOCAB), { new: VOCAB.total - 2, unsure: 1, learned: 1, total: VOCAB.total });
  eq("移行: 助動詞の may の習得は may だけを 覚えた に（5月は記録が無いので これから）", L.fillLearnStates({ [AUX]: SHAPES.mastered }, VOCAB.isPublic, isDone).table, { [AUX]: { ...SHAPES.mastered, ls: LEARNED } });
  LS = kept;
  S.forgetWordStats();
  await S.loadLearnStates();
}
{
  // 同じタスクのほかの書き手と同じ 1 回の保存（setItem はタスクに 1 回）。ほかの書き手の欄は変えない
  const id = PUB[21];
  clock = D(2, 9);
  ST.recordPlay(id);
  S.flushWordStats();
  const writes = LS.writes.filter((k) => k === "spelldash_word_stats").length;
  ST.recordCorrect(id, true);
  ST.recordRecallSuccess(id, { clean: true, speed: "normal" });
  const p = ST.recordLearnAnswer(id, K.exact);
  await p;
  eq("同じタスクの 3 つの書き手で語の記録の setItem は 1 回", LS.writes.filter((k) => k === "spelldash_word_stats").length - writes, 1);
}
{
  // ほかの書き手の出力は、新しい書き手をはさんでも同じ（新しい 3 つの欄を除く）。同じ時計の 2 本で比べる
  const script = (withLearn) => {
    LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_word_stats: "{}" });
    S.forgetWordStats();
    const ids = PUB.slice(40, 46);
    let day = 0;
    for (let round = 0; round < 6; round++) {
      for (const [i, id] of ids.entries()) {
        clock = D(day, 9 + i);
        ST.recordPlay(id);
        if ((round + i) % 3 === 0) {
          ST.recordRecallFail(id, { k: "e", p: 1 });
          if (withLearn) ST.recordLearnAnswer(id, K.reveal);
          ST.recordCorrect(id, false);
        } else {
          ST.recordCorrect(id, true);
          ST.recordRecallSuccess(id, { clean: true, speed: "fast" }, null);
          if (withLearn) ST.recordLearnAnswer(id, K.exact);
        }
        S.flushWordStats();
      }
      day += round % 2 ? 1 : 0;
    }
    return JSON.parse(LS.getItem("spelldash_word_stats"));
  };
  const a = script(false);
  const b = script(true);
  const strip = (o) => Object.fromEntries(Object.entries(o).map(([id, s]) => [id, Object.fromEntries(Object.entries(s).filter(([k]) => !L.LEARN_FIELDS.includes(k)))]));
  eq("ほかの書き手（recordPlay・recordCorrect・recordRecallSuccess・recordRecallFail）の出力は同じ（新しい欄を除く）", strip(b), a);
  ok("新しい書き手をはさんだ側だけに欄がある", Object.values(b).every((s) => s.ls && s.lsAt) && Object.values(a).every((s) => !("ls" in s)));
}
{
  // 保存の失敗（容量）: 書き手は false・spelldash:save-failed・保存は前のまま（受け入れ基準 14）
  const failed = seen("spelldash:save-failed");
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_word_stats: JSON.stringify({ [W]: { ...stat(), ls: 1, lsd: dayOf(D(3)) } }) });
  S.forgetWordStats();
  const text = LS.getItem("spelldash_word_stats");
  LS.limit = [...LS.map].reduce((n, [k, v]) => n + k.length + v.length, 0); // これ以上増やせない
  clock = D(4, 9);
  const saved = await ST.recordLearnAnswer(W, K.exact);
  eq("保存に失敗: false・失敗の知らせ 1 回（移行の失敗の印なし）・保存は前のまま", [saved, failed.length, failed[0]?.detail?.migration, LS.getItem("spelldash_word_stats") === text], [false, 1, false, true]);
  LS.limit = Infinity;
  const again = await ST.recordLearnAnswer(W, K.exact);
  eq("容量が空いた後: 保存から読み直して書く（前の失敗の分は入っていない）", [again, JSON.parse(LS.getItem("spelldash_word_stats"))[W].ls], [true, 2]);
  eq("書きかけが無いときの whenWordStatsSaved は最後の成否", await S.whenWordStatsSaved(), true);
}
{
  // 版 7 の前（移行が容量で書けなかった端末）: 書き手も欄の無い語を、移行を試したときに式で決めた状態で読む
  const v6 = async (shape) => {
    const seed = { spelldash_schema_version: "6", spelldash_word_stats: JSON.stringify({ [W]: shape }) };
    LS = new FakeStorage(seed, Object.entries(seed).reduce((n, [k, v]) => n + k.length + v.length, 0) + 4); // 移行の「,"ls":…」が入らない
    S.forgetWordStats();
    await S.loadLearnStates();
    LS.limit = Infinity;
  };
  LS = new FakeStorage({ spelldash_schema_version: "6", spelldash_word_stats: JSON.stringify({ [W]: SHAPES.weak }) });
  S.forgetWordStats();
  eq("版 6 で移行をまだ試していない: 書き手は書かない（false。材料を待つ）", [await ST.recordLearnAnswer(W, K.exact), "ls" in JSON.parse(LS.getItem("spelldash_word_stats"))[W]], [false, false]);
  await v6(SHAPES.learning);
  clock = D(5, 9);
  await ST.recordLearnAnswer(W, K.miss);
  eq("版 6 の端末: 欄の無い 覚えた の形の語に × → あやふや（これから 扱いで 覚えた にしない）", [LS.getItem("spelldash_schema_version"), JSON.parse(LS.getItem("spelldash_word_stats"))[W].ls], ["6", 1]);
  await v6(SHAPES.weak);
  await ST.recordLearnAnswer(W, K.exact);
  eq("版 6 の端末: 欄の無い 苦手 の形の語の自力正解は 1 日目（初回の 覚えた にしない）", JSON.parse(LS.getItem("spelldash_word_stats"))[W].ls, 1);
}
{
  // 版 7 の前（移行が容量で書けなかった端末）: 欄の無い語は、移行を試したときの記録から式で決めた状態で読む。同じタスクで先に走る今の書き手
  // （recordPlay・recordCorrect・recordRecallSuccess）や Battle の書き手で動いた記録を、式で読み直さない（反証 F1。決定 §3・§4）
  const V = PUB[23];
  const seed = { spelldash_schema_version: "6", spelldash_word_stats: JSON.stringify({ [W]: SHAPES.weak, [V]: SHAPES.weak, [PUB[24]]: SHAPES.played }) };
  LS = new FakeStorage(seed, Object.entries(seed).reduce((n, [k, v]) => n + k.length + v.length, 0) + 12); // 移行の「,"ls":1」2 語ぶんが入らない
  S.forgetWordStats();
  const src = await S.loadLearnStates();
  eq("移行が容量で書けない: 版 6 のまま・読み手の材料はある", [LS.getItem("spelldash_schema_version"), !!src], ["6", true]);
  LS.limit = Infinity; // 1 問ぶんの書き込みは入る
  const count = () => L.countLearnStates(S.getWordStats(), src.vocab, src.pending);
  const before = count();
  clock = D(10, 9);
  ST.recordPlay(V); // Battle の答え（状態の書き手は呼ばない）
  ST.recordCorrect(V, true);
  ST.recordRecallSuccess(V, { clean: true, speed: "normal" });
  S.flushWordStats();
  eq("版 6 の端末: 今の書き手（Battle の形）だけでは 3 状態の数は変わらない", count(), before);
  clock = D(10, 10);
  ST.recordPlay(W); // 中心の学習の 1 問: 今の書き手の後に状態の書き手
  ST.recordCorrect(W, true);
  ST.recordRecallSuccess(W, { clean: true, speed: "normal" });
  const saved = await ST.recordLearnAnswer(W, K.exact);
  const t = JSON.parse(LS.getItem("spelldash_word_stats"));
  eq("版 6 の端末: 式で あやふや の語は、今の書き手の後の 1 回の自力正解で 1 日目（覚えた にしない）", [saved, t[W].ls, t[W].lsd], [true, UNSURE, dayOf(D(10))]);
}
{
  // 複数のタブ（dataloss d12）: ほかのタブが書いた欄を次のタスクで読み直して決める（同じ日を 2 回数えない）。記録の置き換えで回を終える
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_word_stats: JSON.stringify({ [W]: { ...stat(), ls: 1 } }) });
  S.forgetWordStats();
  clock = D(6, 9);
  await ST.recordLearnAnswer(W, K.exact); // このタブ: 1 日目
  const other = JSON.parse(LS.getItem("spelldash_word_stats"));
  LS.setItem("spelldash_word_stats", JSON.stringify({ ...other, [W]: { ...other[W], lsAt: D(6, 9, 30) } })); // ほかのタブが同じ日に答えた
  await tick();
  clock = D(6, 10);
  await ST.recordLearnAnswer(W, K.exact);
  eq("ほかのタブが同じ日に答えた後も、このタブの同じ日の答えは 1 日分（あやふや）", JSON.parse(LS.getItem("spelldash_word_stats"))[W].ls, 1);
  const epoch = S.recordsEpoch();
  const fire = (key, oldValue, newValue) => globalThis.dispatchEvent({ type: "storage", key, oldValue, newValue, storageArea: LS });
  const replaced = seen("spelldash:records-replaced");
  fire("spelldash_xp", "1", "2");
  fire("spelldash_schema_version", "6", "7");
  fire("spelldash_owner", null, "u1");
  eq("置き換えでない知らせ（XP・版が上がる・初めての持ち主）では数えない", [S.recordsEpoch() - epoch, replaced.length], [0, 0]);
  fire("spelldash_owner", "u1", "u2");
  fire("spelldash_word_stats", "{}", null);
  fire("spelldash_schema_version", "7", "6");
  fire(null, null, null);
  eq("置き換え（持ち主が替わる・語の記録が消える・版が下がる・全部消す）を数え、知らせる（開き直した js/storage.js の数だけ。どれも 4 回）", [S.recordsEpoch() - epoch, replaced.length], [4, 4 * (loads + 1)]);
  clock = D(7, 9);
  eq("回の始めの控えと違えば書かない（false）・控えが同じなら書く", [await ST.recordLearnAnswer(W, K.exact, { epoch }), await ST.recordLearnAnswer(W, K.exact, { epoch: S.recordsEpoch() })], [false, true]);
}
{
  // 開き直し（リロード）・日付の変化で二重に数えない
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_word_stats: JSON.stringify({ [W]: { ...stat(), ls: 1 } }) });
  S.forgetWordStats();
  clock = D(8, 23, 58);
  await ST.recordLearnAnswer(W, K.exact);
  S.forgetWordStats(); // 開き直し
  clock = D(8, 23, 59);
  await ST.recordLearnAnswer(W, K.exact);
  eq("開き直しても同じ日の 2 回目は数えない", JSON.parse(LS.getItem("spelldash_word_stats"))[W].ls, 1);
  clock = D(9, 0, 1);
  await ST.recordLearnAnswer(W, K.exact);
  eq("日付が変わった後の 1 回で 覚えた", JSON.parse(LS.getItem("spelldash_word_stats"))[W].ls, 2);
}
clock = null;

// ── 10. 同期（js/sync.js initialSync） ─────────────
const row = (wordId, over = {}) => ({ user_id: "u1", word_id: wordId, play_count: 5, correct_count: 3, typing_miss: 0, recall_fail: 2, clean_correct_streak: 0, mastered: false, mastered_at: null, last_played: iso(D(20)), next_review_at: iso(D(20)), last_recall_fail_at: iso(D(20)), last_recall_success_at: iso(D(10)), daily_learning_date: null, daily_learning_stage: 0, srs_advanced_on: null, updated_at: iso(D(20)), ...over });
const SENT_COLUMNS = ["user_id", "word_id", "play_count", "correct_count", "typing_miss", "recall_fail", "clean_correct_streak", "mastered", "mastered_at", "last_played", "next_review_at", "last_recall_fail_at", "last_recall_success_at", "daily_learning_date", "daily_learning_stage", "srs_advanced_on", "updated_at"];
async function sync(seed, { user = "u1", rows = [], answer = true, limit = Infinity } = {}) {
  LS = new FakeStorage(seed, limit);
  SS = new FakeStorage();
  S.forgetWordStats();
  cloud.user = user;
  cloud.tables = { word_progress: rows, user_progress: [] };
  cloud.sent = [];
  confirms.length = 0;
  confirmAnswer = answer;
  const result = await SY.initialSync();
  return { result, t: JSON.parse(LS.getItem("spelldash_word_stats") || "{}") };
}
const A = PUB[30];
const B = PUB[31];
const C = PUB[32];
const E = PUB[33];
{
  // 端末の 覚えた・あやふや（数えた日）と、クラウドの新しい行（× を含む）: 状態は端末のまま（決定 §8）
  const local = { [A]: { ...SHAPES.learning, ls: 2, lsAt: D(5) }, [B]: { ...SHAPES.weak, ls: 1, lsd: dayOf(D(5)), lsAt: D(5) } };
  const { result, t } = await sync({ spelldash_schema_version: "7", spelldash_owner: "u1", spelldash_learn_filled: "u1", spelldash_word_stats: JSON.stringify(local) }, { rows: [row(A), row(B)] });
  eq("取り込み: クラウドの行が新しく × を含んでも、端末の 覚えた・あやふやと数えた日・最後の答えの時刻は残る", [result, t[A].ls, t[A].lsAt, t[B].ls, t[B].lsd, t[B].lsAt], ["changed", 2, D(5), 1, dayOf(D(5)), D(5)]);
  eq("取り込み: ほかの欄はクラウドの新しい値になる（マージは今のまま）", [t[A].recallFail, t[A].playCount, t[A].lastRecallFailAt], [2, 5, iso(D(20))]);
  const old = await sync({ spelldash_schema_version: "7", spelldash_owner: "u1", spelldash_learn_filled: "u1", spelldash_word_stats: JSON.stringify({ [A]: { ...SHAPES.learning, ls: 2, lastPlayed: iso(D(30)) } }) }, { rows: [row(A, { last_played: iso(D(1)), recall_fail: 9 })] });
  const sentWords = old.result && cloud.sent.filter((s) => s.table === "word_progress").flatMap((s) => s.rows);
  eq("古いクラウドの行: 端末の行がそのまま残り（ls 2）、送る行は 15 列のまま（状態の欄は送らない）", [old.t[A].ls, old.t[A].recallFail, sentWords.length, sentWords.every((r) => isDeepStrictEqual(Object.keys(r), SENT_COLUMNS))], [2, 0, 1, true]);
}
{
  // 初めの埋め（1 回だけ）: 版 7 の端末にクラウドだけの語が届く → 移行の式。端末で答えた語（欄なし）・欄のある語は変えない
  const seed = {
    spelldash_schema_version: "7",
    spelldash_owner: "u1",
    spelldash_word_stats: JSON.stringify({ [C]: { ...SHAPES.failOnly, lastPlayed: iso(D(1)) }, [E]: { ...SHAPES.played, lastPlayed: iso(D(1)) } })
  };
  const rows = [row(A, { recall_fail: 0, last_recall_fail_at: null, correct_count: 1, clean_correct_streak: 1 }), row(B), row(C, { recall_fail: 0, last_recall_fail_at: null }), row(E, { recall_fail: 0, last_recall_fail_at: null }), row("concept-ad-cpc", { recall_fail: 0, last_recall_fail_at: null })];
  const first = await sync(seed, { rows });
  eq("初めの取り込み: クラウドだけの語を移行の式で埋める（覚えた・あやふや）・印を付ける", [first.t[A].ls, first.t[B].ls, LS.getItem("spelldash_learn_filled")], [2, 1, "u1"]);
  eq("初めの取り込み: 端末に答えのあった語（欄なし。Battle の答え）は これから のまま・答えの無かった語は埋める・非公開の語には書かない", [first.t[C].ls, first.t[E].ls, first.t["concept-ad-cpc"].ls], [undefined, 2, undefined]);
  // 次のタブ（印は付いた）: 新しく届いた語は これから のまま
  const next = await sync({ ...Object.fromEntries(LS.map), spelldash_word_stats: LS.getItem("spelldash_word_stats") }, { rows: [...rows, row(PUB[34], { recall_fail: 0, last_recall_fail_at: null })] });
  eq("2 回目の取り込み: 新しく届いた語は埋めない（これから）・埋めた語は変わらない", [next.t[PUB[34]].ls, next.t[A].ls, next.t[B].ls], [undefined, 2, 1]);
  // 版 6（移行が済んでいない）: ここでは埋めず、印も付けない
  const v6 = await sync({ spelldash_schema_version: "6", spelldash_owner: "u1", spelldash_word_stats: JSON.stringify({ [PUB[35]]: { ...SHAPES.played, lastPlayed: iso(D(1)) } }), spelldash_xp: "1" }, { rows: [row(A)] });
  eq("版 6 の取り込み: 埋めない・印を付けない（移行が埋める）", [v6.t[A].ls, LS.getItem("spelldash_learn_filled")], [undefined, null]);
}
{
  // 初めの埋めの保存が容量で書けない: 埋めの印を付けない（次の取り込みでやり直す）。容量が空いた後の取り込みで埋める（反証 M1・dataloss d5）
  const rows = PUB.slice(100, 150).map((id) => row(id, { recall_fail: 0, last_recall_fail_at: null, correct_count: 1, clean_correct_streak: 1 }));
  await sync({ spelldash_schema_version: "7" }, { rows }); // 容量なしで 1 回流して、埋めた表の字数を知る
  const filledChars = LS.getItem("spelldash_word_stats").length;
  const others = [...LS.map].filter(([k]) => k !== "spelldash_word_stats").reduce((n, [k, v]) => n + k.length + v.length, 0);
  const limit = others + "spelldash_word_stats".length + filledChars - rows.length * ',"ls":2'.length + 100; // 欄の無い表は入り、欄のある表は入らない
  const failed = seen("spelldash:save-failed");
  const first = await sync({ spelldash_schema_version: "7" }, { rows, limit });
  eq("初めの埋めの保存が容量で書けない: 印を付けない・表は入っていない・保存の失敗を知らせる", [LS.getItem("spelldash_learn_filled"), Object.keys(first.t).length, failed.length > 0], [null, 0, true]);
  const again = await sync({ ...LS.dump() }, { rows });
  eq("容量が空いた次の取り込み: 埋める（覚えた 50 語）・印を付ける", [Object.values(again.t).filter((x) => x.ls === LEARNED).length, LS.getItem("spelldash_learn_filled")], [rows.length, "u1"]);
}
{
  // 別のアカウントに置き換え: 前の人の状態・最高到達ランク・埋めの印は消え、新しい人の行は初めの埋めで決める（決定 §8・dataloss d6）
  const seed = { spelldash_schema_version: "7", spelldash_owner: "u0", spelldash_rank_peak: "6", spelldash_learn_filled: "u0", spelldash_word_stats: JSON.stringify({ [A]: { ...SHAPES.learning, ls: 2 }, [B]: { ...SHAPES.learning, ls: 2 } }) };
  const { result, t } = await sync(seed, { user: "u1", rows: [row(B)] });
  eq("置き換え: 確認 1 回・前の人の語と最高到達ランクは消え、新しい人の語は移行の式（あやふや）", [result, confirms.length, A in t, t[B].ls, LS.getItem("spelldash_rank_peak"), LS.getItem("spelldash_learn_filled"), LS.getItem("spelldash_owner")], ["changed", 1, false, 1, null, "u1", "u1"]);
  const cancel = await sync(seed, { user: "u1", rows: [row(B)], answer: false });
  eq("置き換えを断る: 何も書かない", [cancel.result, LS.getItem("spelldash_word_stats"), LS.getItem("spelldash_rank_peak")], ["cancelled", seed.spelldash_word_stats, "6"]);
}
{
  // ログアウトの後に答えた記録: 同じアカウントで入り直すときに足すかをたずねる（dataloss d7。創業者に送った既定）
  const base = { spelldash_schema_version: "7", spelldash_owner: "u1", spelldash_learn_filled: "u1" };
  LS = new FakeStorage(base);
  clock = D(10, 9);
  SY.clearSyncedFlag(); // ログアウト
  const out = LS.getItem("spelldash_logout_at");
  ok("ログアウトで時刻を残す（持ち主のある端末）", out === iso(D(10, 9)));
  clock = D(10, 15);
  SY.clearSyncedFlag();
  clock = null;
  ok("2 回目（ログインをやめた）では上書きしない（最初のログアウトの時刻のまま）", LS.getItem("spelldash_logout_at") === out);
  const after = { ...base, spelldash_logout_at: iso(D(10)), spelldash_word_stats: JSON.stringify({ [A]: { ...SHAPES.learning, ls: 2, lastPlayed: iso(D(11)), lastRecallSuccessAt: iso(D(11)) } }) };
  const no = await sync(after, { rows: [], answer: false });
  eq("ログアウトの後の記録あり・断る: cancelled・確認の文は今の文・何も書かない", [no.result, confirms, LS.getItem("spelldash_word_stats") === after.spelldash_word_stats, LS.getItem("spelldash_logout_at")], ["cancelled", ["この端末の記録を、このアカウントの記録に足す。別の人の記録なら、キャンセルしてログインをやめる。"], true, iso(D(10))]);
  const yes = await sync(after, { rows: [] });
  eq("ログアウトの後の記録あり・足す: 同期して時刻を消す", [yes.result, confirms.length, LS.getItem("spelldash_logout_at"), yes.t[A].ls], ["same", 1, null, 2]);
  const quietRelogin = await sync({ ...base, spelldash_logout_at: iso(D(10)), spelldash_word_stats: JSON.stringify({ [A]: { ...SHAPES.learning, ls: 2, lastPlayed: iso(D(9)), lastRecallSuccessAt: iso(D(9)) } }) }, { rows: [] });
  eq("ログアウトの後に記録が無ければたずねない", [quietRelogin.result, confirms.length], ["same", 0]);
  const lsAtOnly = await sync({ ...base, spelldash_logout_at: iso(D(10)), spelldash_word_stats: JSON.stringify({ [A]: { ...SHAPES.learning, ls: 1, lsAt: D(11), lastPlayed: iso(D(9)), lastRecallSuccessAt: iso(D(9)) } }) }, { rows: [], answer: false });
  eq("ログアウトの後に中心の学習で答えた時刻（lsAt）だけが新しい語でもたずねる", [lsAtOnly.result, confirms.length], ["cancelled", 1]);
}

// ── 11. バックアップと復元（js/backup.js） ─────────────
{
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_rank_peak: "4", spelldash_logout_at: iso(D(1)), spelldash_learn_filled: "u1", spelldash_owner: "u1", spelldash_word_stats: JSON.stringify({ [A]: { ...SHAPES.learning, ls: 2, lsAt: D(1) }, [B]: { ...SHAPES.weak, ls: 1, lsd: 20000 } }) });
  S.forgetWordStats();
  const data = BK.buildBackup().data;
  eq("バックアップ: 最高到達ランクと語ごとの状態の欄が入る・同期の印（持ち主・ログアウト・埋めの印）は入らない", [data.spelldash_rank_peak, JSON.parse(data.spelldash_word_stats)[B].lsd, "spelldash_owner" in data, "spelldash_logout_at" in data, "spelldash_learn_filled" in data], ["4", 20000, false, false, false]);
}
{
  // 古い（版 6）バックアップの復元: その場で版 7・欄を埋める（再読み込みを待たない: dataloss d9）。最高到達ランク = max（前, バックアップ, 今の数）
  const many = {};
  for (const id of PUB.slice(0, 130)) many[id] = SHAPES.learning; // 130 語が済み → よちよち（1）
  many["concept-ad-cpc"] = SHAPES.weak;
  const backup = { app: "SpellDash", version: 1, exportedAt: iso(D(0)), data: { spelldash_schema_version: "6", spelldash_word_stats: JSON.stringify(many), spelldash_xp: "50" } };
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_rank_peak: "0", spelldash_owner: "u1", spelldash_learn_filled: "u1", spelldash_logout_at: iso(D(0)), spelldash_word_stats: "{}" });
  SS = new FakeStorage({ spelldash_synced_this_session: "u1", spelldash_pulled_this_session: "u1", spelldash_sync_done_this_session: "u1", spelldash_pull_started_at: "1" });
  S.forgetWordStats();
  const summary = BK.applyBackup(backup);
  const t = JSON.parse(LS.getItem("spelldash_word_stats"));
  eq("版 6 のバックアップを戻すと、返る前に版 7・欄が入る（非公開の語は欄なし）", [summary.words, LS.getItem("spelldash_schema_version"), t[PUB[0]].ls, t[PUB[129]].ls, "ls" in t["concept-ad-cpc"]], [131, "7", 2, 2, false]);
  eq("戻した後の最高到達ランク = 今の数の段（前 0・バックアップに無し・今 130 語 = よちよち）", LS.getItem("spelldash_rank_peak"), "1");
  eq("ログイン中のタブの同期の印は消す（次に取り込みからやり直す: 古い行でクラウドを上書きしない）・持ち主・埋めの印・ログアウトの時刻も消す", [SS.length, LS.getItem("spelldash_owner"), LS.getItem("spelldash_learn_filled"), LS.getItem("spelldash_logout_at")], [0, null, null, null]);
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_rank_peak: "5", spelldash_word_stats: "{}" });
  S.forgetWordStats();
  BK.applyBackup({ ...backup, data: { ...backup.data, spelldash_rank_peak: "3" } });
  eq("最高到達ランクは下げない（前 5・バックアップ 3・今 1 → 5）", LS.getItem("spelldash_rank_peak"), "5");
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_word_stats: "{}" });
  S.forgetWordStats();
  BK.applyBackup({ ...backup, data: { ...backup.data, spelldash_rank_peak: "3" } });
  eq("前の値が無い: バックアップの 3（今 1 より大きい）", LS.getItem("spelldash_rank_peak"), "3");
}
{
  // 版の鍵が無いバックアップ: id を付け替えない（dataloss d10）・欄を埋める
  const backup = { app: "SpellDash", version: 1, data: { spelldash_word_stats: JSON.stringify({ "concept-ad-cpc": SHAPES.learning, "my-q-hello": SHAPES.weak, "my-river": SHAPES.weak, [PUB[0]]: SHAPES.learning }) } };
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_word_stats: "{}" });
  S.forgetWordStats();
  BK.applyBackup(backup);
  eq("版の鍵なしのバックアップ: 戻した直後は書き換えない（古い版の段は次に開いたとき。今までどおり）", [LS.getItem("spelldash_word_stats"), LS.getItem("spelldash_schema_version")], [backup.data.spelldash_word_stats, null]);
  await tick();
  ok("版の鍵なしのバックアップ: 版 6 より前の表に版 7 の段を当てない（材料が読めても）", LS.getItem("spelldash_word_stats") === backup.data.spelldash_word_stats);
  const m = await openStorage(); // 再読み込み
  await m.loadLearnStates();
  const t = JSON.parse(LS.getItem("spelldash_word_stats"));
  eq("版の鍵なしのバックアップ: 開き直すと concept-・my- の id はそのまま・公開の語に欄・版 7", [Object.keys(t).sort(), t[PUB[0]].ls, LS.getItem("spelldash_schema_version")], [["concept-ad-cpc", "my-q-hello", "my-river", PUB[0]].sort(), 2, "7"]);
}
{
  // 復元が容量で途中で失敗: 前の記録に戻して投げる（前の記録を消したまま半分で止めない: verify-dataloss m1）
  const seed = { spelldash_schema_version: "7", spelldash_rank_peak: "2", spelldash_owner: "u1", spelldash_xp: "300", spelldash_word_stats: JSON.stringify({ [A]: { ...SHAPES.learning, ls: 2 } }), spelldash_theme: "dark" };
  const size = Object.entries(seed).reduce((n, [k, v]) => n + k.length + v.length, 0);
  LS = new FakeStorage(seed, size + 400);
  S.forgetWordStats();
  const big = {};
  for (const id of PUB.slice(0, 40)) big[id] = SHAPES.learning;
  let message = "";
  try {
    BK.applyBackup({ app: "SpellDash", version: 1, data: { spelldash_xp: "9", spelldash_word_stats: JSON.stringify(big), spelldash_schema_version: "6" } });
  } catch (error) {
    message = error.message;
  }
  eq("復元の途中で容量: 投げる（短い文）・前の記録は 1 つも変わらない", [message, LS.dump()], ["端末の空きが足りず、復元できなかった。今の記録はそのまま。", Object.fromEntries(Object.entries(seed).sort(([a], [b]) => (a < b ? -1 : 1)))]);
}
{
  // 別のアカウントのときの消去: 最高到達ランクも消す（d6）。設定と版は残す
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_rank_peak: "7", spelldash_theme: "dark", spelldash_word_stats: JSON.stringify({ [A]: { ls: 2 } }), spelldash_logout_at: iso(D(1)), spelldash_learn_filled: "u0" });
  BK.clearLocalRecords();
  eq("消去: 最高到達ランク・語の記録・ログアウトの時刻・埋めの印は消え、設定と版は残る", LS.dump(), { spelldash_schema_version: "7", spelldash_theme: "dark" });
}
{
  // backup.js の同期の印の名前は js/sync.js と同じ 4 つ（写しの食い違いを止める）
  const syncSrc = fs.readFileSync(path.join(ROOT, "js/sync.js"), "utf8");
  const flags = [...syncSrc.matchAll(/const \w+_FLAG = "(spelldash_[a-z_]+)"; \/\/ sessionStorage/g)].map((m) => m[1]);
  const backupSrc = fs.readFileSync(path.join(ROOT, "js/backup.js"), "utf8");
  const list = JSON.parse(/const SYNC_FLAGS = (\[[^\]]+\])/.exec(backupSrc)?.[1] ?? "[]");
  eq("js/backup.js SYNC_FLAGS は js/sync.js の sessionStorage の 4 つの印と同じ", [list.length, [...list].sort()], [4, [...flags].sort()]);
}

console.warn = quiet;
if (failures.length) {
  console.error(`test-learn-state: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-learn-state: ${passed} passed`);
process.exit(0);
