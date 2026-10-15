// 製品の書き手（js/stats.js・js/mastery.js・js/masteryMeta.js）を偽の時計で 1 年回す模擬（DOM なし）。
//   node scripts/sim-writers.mjs [<木の根>] [--quality]
// 300 語・365 日・5 つの型（毎回すぐ・毎回ふつう・毎回時間がかかる・初見で × のち覚える・× の 4 つの種類と Battle の呼び方を混ぜた型）。
// 2 割の日を休み、学ぶ時刻は 7〜23 時のどこか（同じ日の 2 回目の回もある）。js/game.js completeWord・markRecallFail と
// js/studyQueue.js の同日反復、js/battleEngine.js の呼び順を写す。測りの札（measure）と × の種類（detail）も渡す（前の版の書き手は読まない）。
// 出力（標準出力に JSON）: 語ごとの記録（新しい欄と、別の日の扱いを直した lastReviewResult・lastReviewAt を除く。history は d と r だけ）・
// spelldash_retention・spelldash_mastery_meta と、大きさ（word_stats の新しい欄〔history の × の細目〕の分・語ごとの欄 spelldash_memory_words・
// spelldash_memory_check）。
// scripts/test-memory.mjs が、この出力の要約（hash）を tests/fixtures/sim-writers.json（この Batch の前の main で取った値）と比べる（受け入れの基準 1）。
// --quality: 一度に 2 字以上入った答え・盤面の外へ焦点が移った答え・3 秒止まった答えを混ぜる（js/game.js が箱に入れない・pc を入れない分だけ、
// 本人の基準が変わり段が動きうる。比べない。BUILD の参考の数）。既定の模擬はどれも偽（4 つの型と × の種類だけ）
// 計測用（比べない）: --words=<数>（語の数。既定 300）・--t0=<ISO>（1 日目の 0 時。既定 2026-10-14）・--dump（1 年後の spelldash_* をまるごと出す）
process.env.TZ = "Asia/Tokyo";

import path from "path";
import { createHash } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";

const args = process.argv.slice(2);
const QUALITY = args.includes("--quality");
const SUMMARY = args.includes("--summary");
const AS_BEFORE = args.includes("--as-before"); // --quality と使う: 箱への見本を前の版の js/game.js と同じに（札を見ずに全部入れる）
const RAW = args.includes("--raw");
const DUMP = args.includes("--dump");
const argOf = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const N_WORDS = Number(argOf("words")) || 300; // 1 年後の spelldash_word_stats をそのまま出す（大きさ・保存の重さを測る） // 比べる値の要約（語ごとの hash）だけを出す（tests/fixtures/sim-writers.json と同じ形）
const ROOT = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

// ===== 端末の偽物（localStorage・window・document）と偽の時計 =====
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    }
  }
});
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const noop = () => {};
globalThis.window = globalThis;
globalThis.addEventListener ??= noop;
globalThis.removeEventListener ??= noop;
globalThis.dispatchEvent ??= noop;
globalThis.location ??= { search: "", hostname: "localhost", pathname: "/", href: "http://localhost/", origin: "http://localhost" };
globalThis.document ??= {
  addEventListener: noop,
  removeEventListener: noop,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: { dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false } },
  body: null,
  visibilityState: "visible",
  hidden: false
};
const out = console.log.bind(console);
console.log = noop;
console.warn = noop;
store.set("spelldash_schema_version", "6");

const RealDate = Date;
const T0 = new RealDate(argOf("t0") ?? "2026-10-14T00:00:00+09:00").getTime();
let clock = T0 + 12 * 3600000;
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(clock);
    else super(...a);
  }
  static now() {
    return clock;
  }
}
globalThis.Date = FakeDate;

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const S = await imp("js/stats.js");
const M = await imp("js/mastery.js");
const MM = await imp("js/masteryMeta.js");
const ST = await imp("js/storage.js");
let MC = null; // js/memoryCheck.js（この Batch から。前の版には無い）
try {
  MC = await imp("js/memoryCheck.js");
} catch {
  MC = null;
}
let MW = null; // js/memoryWords.js（同じ）
try {
  MW = await imp("js/memoryWords.js");
} catch {
  MW = null;
}

// ===== 決まった乱数（xorshift32） =====
let seedState = 20261014;
const rnd = () => {
  seedState ^= seedState << 13;
  seedState >>>= 0;
  seedState ^= seedState >> 17;
  seedState ^= seedState << 5;
  seedState >>>= 0;
  return seedState / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const jitter = (base, spread = 0.2) => Math.max(210, Math.round(base * (1 - spread + 2 * spread * rnd())));

const tick = () => new Promise((r) => setImmediate(r)); // 保存はマイクロタスクで 1 回にまとめて書かれる（js/storage.js）
const read = () => ST.getWordStats(); // 読み手の表（js/storage.js。書き手が保存した中身と同じ）
const DAY = 86400000;
const dayAt = (n, h = 12, m = 0) => {
  const d = new RealDate(T0);
  d.setDate(d.getDate() + n);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const TARGET = 4; // js/studyQueue.js NEW_WORD_DAILY_SUCCESS_TARGET
const todayStr = () => S.localDateString();
const isLearningToday = (s) => s?.dailyLearningDate === todayStr() && (s.dailyLearningStage ?? 0) < TARGET;
const isSecuredToday = (s) => s?.dailyLearningDate === todayStr() && (s.dailyLearningStage ?? 0) >= TARGET;
const isDue = (s) => !!s && !s.mastered && !!s.nextReviewAt && Date.parse(s.nextReviewAt) <= Date.now();

// 本人の基準: 物理キーの Study の箱に 40 件（中央値 2,000ms）。画面キーボードの箱は空（既定の線で分類される）
{
  const t1 = [];
  const pc = [];
  for (let i = 0; i < 40; i++) {
    const f = 0.7 + (0.6 * i) / 39;
    t1.push(Math.round(2000 * f));
    pc.push(Math.round(220 * f));
  }
  store.set("spelldash_mastery_meta", JSON.stringify({ v: 1, speed: { "en.kbd.study": { t1, pc } }, check: { rank: {}, firstFast: { prior: [0, 0], own: [0, 0] }, pending: {}, firstMedian: {} } }));
}

// ===== 語 =====
// type: 0 すぐ（T1 700ms）・1 ふつう（2,000ms）・2 時間がかかる（3,600ms）・3 初見で × のち覚える（2,400ms）・4 × の種類と Battle を混ぜる（2,200ms）
const TYPES = [
  { t1: 700, known: 0.6, fail: 0.05 },
  { t1: 2000, known: 0.3, fail: 0.08 },
  { t1: 3600, known: 0.2, fail: 0.1 },
  { t1: 2400, known: 0, fail: 0.12 },
  { t1: 2200, known: 0.25, fail: 0.18, battle: 0.25 }
];
const WORDS = Array.from({ length: N_WORDS }, (_, i) => ({
  id: `w${String(i).padStart(N_WORDS > 1000 ? 4 : 3, "0")}`,
  type: i % 5,
  qLen: 1 + Math.floor(rnd() * 9),
  aLen: 3 + Math.floor(rnd() * 9)
}));
let answers = 0;

function measureOf(w, prev, { t1, input }) {
  const ctx = M.answerContext(prev, Date.now());
  return {
    t1,
    pcMax: jitter(260, 0.5),
    qLen: w.qLen,
    aLen: w.aLen,
    input,
    multi: QUALITY && rnd() < 0.05,
    outside: QUALITY && rnd() < 0.03,
    stalled: QUALITY && rnd() < 0.04,
    firstSight: !!ctx.firstAnswer
  };
}

// 1 回のタスク（イベント）ごとに書き手を呼び、保存（マイクロタスク）を待つ。出題（recordPlay）は前のタスク、答えの書き込みは 1 つのタスク
// （js/game.js completeWord・markRecallFail の中で js/studyQueue.js の onRecallSuccess・onRecallFail も同じタスクで呼ばれる）

// Study の自力正解（js/game.js completeWord の呼び順。Study の自力正解はノーミス）
async function studyOk(w) {
  answers++;
  S.recordPlay(w.id);
  await tick();
  const prev = read()[w.id];
  const input = rnd() < 0.1 ? (rnd() < 0.5 ? "osk" : "ime") : "kbd";
  const t1 = jitter(TYPES[w.type].t1);
  const measure = measureOf(w, prev, { t1, input });
  const ctx = M.answerContext(prev, Date.now());
  const box = input === "kbd" ? "en.kbd.study" : "en.touch.study";
  const sample = { t1, pc: jitter(220, 0.3) };
  const { speed, basis } = MM.classifySpeed(sample, box, { firstAnswer: ctx.firstAnswer });
  S.recordCorrect(w.id, true, ctx);
  S.recordRecallSuccess(w.id, { clean: true, speed }, measure);
  // js/game.js と同じく測りの札をそのまま渡す（入れない答え・pc を入れない答えは noteSpeedSample が決める。前の版の書き手は札を読まない）。
  // --as-before は前の版の js/game.js と同じに札を渡さない（全部入れる）
  if (ctx.firstAnswer || ctx.firstOfDay) MM.noteSpeedSample(box, sample, AS_BEFORE ? null : measure);
  if (ctx.firstAnswer && speed === "fast") MM.notePendingFirstFast(w.id, basis);
  // js/studyQueue.js onRecallSuccess（同日反復）
  const s = read()[w.id];
  if (s.knownOnSight && isLearningToday(s) && (s.dailyLearningStage ?? 0) === 0) S.setDailyLearning(w.id, TARGET);
  else if (isLearningToday(s)) S.setDailyLearning(w.id, (s.dailyLearningStage ?? 0) + 1);
  await tick();
}

// Study の ×（答え表示 e・ヒント h・1 打ミス m・パス p）。p 以外は答えを見て打ち直す（次のタスク。recordCorrect の非 clean の枝）
async function studyFail(w, k) {
  answers++;
  S.recordPlay(w.id);
  await tick();
  const p = Math.floor(rnd() * Math.min(4, w.aLen));
  const detail = { k, p, a: k === "m" ? rnd() < 0.5 : null };
  if (k === "m") S.recordTypingMiss(w.id);
  S.recordRecallFail(w.id, detail);
  const s = read()[w.id]; // js/studyQueue.js onRecallFail
  if (isLearningToday(s) || isSecuredToday(s)) S.setDailyLearning(w.id, Math.max(0, (s.dailyLearningStage ?? 0) - 1));
  await tick();
  if (k !== "p") {
    clock += 15000;
    S.recordCorrect(w.id, false, null);
    await tick();
  }
}

// Battle（js/battleEngine.js。引数なし）: パスは recordRecallFail(id)、正解は recordCorrect(id, clean) → recordRecallSuccess(id)。打ち間違いは別の打鍵のタスク
async function battle(w, ok, clean = true) {
  answers++;
  S.recordPlay(w.id);
  await tick();
  if (ok && !clean) {
    S.recordTypingMiss(w.id);
    await tick();
  }
  if (!ok) S.recordRecallFail(w.id);
  else {
    S.recordCorrect(w.id, clean);
    S.recordRecallSuccess(w.id);
  }
  await tick();
}

const FAIL_KINDS = ["e", "e", "h", "m", "m", "p"];

// 復習・補充の 1 問（その日の最初の答え）。× のあとは Recall Loop で 4 分後に自力正解（Study）
async function review(w) {
  const t = TYPES[w.type];
  if (t.battle && rnd() < t.battle) {
    const ok = rnd() >= t.fail;
    await battle(w, ok, rnd() < 0.7);
    return;
  }
  if (rnd() < t.fail) {
    await studyFail(w, w.type === 4 ? pick(FAIL_KINDS) : "e");
    clock += 4 * 60000;
    await studyOk(w);
  } else await studyOk(w);
}

// 新しい語: 出題の印（markIntroduced）→ 初めての答え。知ってた語は 1 回、ほかは × → 同日反復 4 回
async function introduce(w) {
  S.setDailyLearning(w.id, 0);
  await tick();
  const t = TYPES[w.type];
  if (rnd() < t.known) {
    await studyOk(w);
    return;
  }
  await studyFail(w, w.type === 4 ? pick(["e", "h", "m"]) : "e");
  for (const gap of [100, 75, 125, 200]) {
    clock += gap * 1000;
    await studyOk(w);
  }
}

let introduced = 0;
for (let d = 0; d < 365; d++) {
  if (d > 0 && rnd() < 0.2) continue; // 2 割の日を休む
  clock = dayAt(d, 7 + Math.floor(rnd() * 17), Math.floor(rnd() * 60));
  const seen = WORDS.slice(0, introduced);
  const done = new Set();
  // 期日の語（回を始めた時点で期日が来た語）
  const stats0 = read();
  for (const w of seen.filter((x) => isDue(stats0[x.id]))) {
    clock += 8000 + Math.floor(rnd() * 8000);
    await review(w);
    done.add(w.id);
  }
  // 補充の既習 3 語（期日前の語も。苦手は除く）
  const stats1 = read();
  const fam = seen.filter((x) => !done.has(x.id) && stats1[x.id]?.lastRecallSuccessAt && !M.isUnresolved(stats1[x.id]));
  for (let k = 0; k < 3 && fam.length; k++) {
    const w = fam.splice(Math.floor(rnd() * fam.length), 1)[0];
    clock += 8000 + Math.floor(rnd() * 8000);
    await review(w);
    done.add(w.id);
  }
  // 新しい語 10 語（300 語まで）
  for (let k = 0; k < 10 && introduced < WORDS.length; k++) {
    clock += 10000;
    await introduce(WORDS[introduced++]);
  }
  // 同じ日の 2 回目の回（3 割）: 1〜8 時間後に 4 語
  if (rnd() < 0.3) {
    clock += (1 + Math.floor(rnd() * 8)) * 3600000;
    const pool = WORDS.slice(0, introduced);
    for (let k = 0; k < 4; k++) {
      clock += 9000;
      await review(pick(pool));
    }
  }
  MC?.flushMemoryCheck?.(); // 回の終わり
  MW?.flushMemoryWords?.();
}
MC?.flushMemoryCheck?.();
MW?.flushMemoryWords?.();
await tick();
globalThis.Date = RealDate;

// ===== 出力 =====
const NEW_FIELDS = ["sp", "spP", "memSv", "memD", "memD0"];
const CHANGED_FIELDS = ["lastReviewResult", "lastReviewAt"]; // 「別の日」の扱い（S5）で意図して変わる欄（比べない）
const stats = JSON.parse(store.get("spelldash_word_stats") || "{}");
if (RAW) {
  out(JSON.stringify(stats));
  process.exit(0);
}
if (DUMP) {
  out(JSON.stringify(Object.fromEntries([...store.entries()].filter(([k]) => k.startsWith("spelldash_")))));
  process.exit(0);
}
const words = {};
const reviewFields = {};
let newBytes = 0;
for (const [id, st] of Object.entries(stats)) {
  const base = {};
  for (const [k, v] of Object.entries(st)) {
    if (NEW_FIELDS.includes(k) || CHANGED_FIELDS.includes(k)) continue;
    base[k] = k === "history" && Array.isArray(v) ? v.map((e) => ({ d: e.d, r: e.r })) : v;
  }
  words[id] = base;
  reviewFields[id] = { r: st.lastReviewResult ?? null, at: st.lastReviewAt ?? null };
  const stripped = { ...st };
  for (const k of NEW_FIELDS) delete stripped[k];
  if (Array.isArray(st.history)) stripped.history = st.history.map((e) => ({ d: e.d, r: e.r }));
  newBytes += JSON.stringify(st).length - JSON.stringify(stripped).length;
}
const n = Object.keys(stats).length;
const memoryWordsBytes = (store.get("spelldash_memory_words") || "").length; // 語ごとの記録の質（別のキー）
// 鍵の順に依らない JSON（書き手が欄を足す順が変わっても同じ値なら同じ文字列）
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));
const hash = (v) => createHash("sha256").update(canon(v)).digest("hex").slice(0, 16);
const retention = JSON.parse(store.get("spelldash_retention") || "{}");
const meta = JSON.parse(store.get("spelldash_mastery_meta") || "null");
const ranks = {};
for (const st of Object.values(words)) ranks[st.masteryRank ?? 0] = (ranks[st.masteryRank ?? 0] ?? 0) + 1;
if (SUMMARY) {
  out(
    JSON.stringify(
      {
        answers,
        ranks,
        mastered: Object.values(words).filter((st) => st.mastered).length,
        // 比べない（大きさの基準）: newBytesPerWord = word_stats の 1 語あたりの増え（history の × の細目）、memoryWordsPerWord = 別のキーの 1 語あたり
        size: { newBytesPerWord: n ? Math.round((newBytes / n) * 10) / 10 : 0, memoryWordsBytes, memoryWordsPerWord: n ? Math.round((memoryWordsBytes / n) * 10) / 10 : 0, memoryCheckBytes: (store.get("spelldash_memory_check") || "").length },
        retention: hash(retention),
        meta: hash(meta),
        words: Object.fromEntries(Object.keys(words).sort().map((id) => [id, hash(words[id])])),
        retentionWords: Object.fromEntries(Object.keys(retention).sort().map((id) => [id, hash(retention[id])]))
      },
      null,
      1
    )
  );
  process.exit(0);
}
out(
  JSON.stringify({
    words,
    retention,
    meta,
    review: reviewFields,
    info: {
      answers,
      words: n,
      wordStatsBytes: (store.get("spelldash_word_stats") || "").length,
      newBytesPerWord: n ? Math.round((newBytes / n) * 10) / 10 : 0,
      memoryWordsBytes,
      memoryCheckBytes: (store.get("spelldash_memory_check") || "").length,
      memoryCheck: JSON.parse(store.get("spelldash_memory_check") || "null")
    }
  })
);
