// 単語ごとの習熟度（js/mastery.js・js/masteryMeta.js と、js/stats.js の書き手）の単体テスト。ブラウザなしで数秒で終わる:
//   node scripts/test-mastery.mjs
// 失敗が 1 つでもあれば終了コード 1。定義は docs/SPEC_MASTERY.md（§3・§6・§7・§9.3）。
// 日付は固定値、ローカル日の境界は時間帯を Asia/Tokyo に固定して確かめる（書き手の節だけは今の時刻からの相対で種を作る）。
process.env.TZ = "Asia/Tokyo";

import { isDeepStrictEqual } from "util";
import { readFileSync } from "fs";
import {
  RANK_NAMES,
  RANK_GLOSS,
  RANK_RULE,
  SOLID_GAP_DAYS,
  TOP_GAP_DAYS,
  KNOWN_CHECK_DAYS,
  MIN_GAP_MS,
  answered,
  isFirstAnswer,
  isKnownWord,
  isKnownWaiting,
  answerContext,
  nextRank,
  initialRank,
  rankOf,
  rankHtml,
  rankBasis,
  rankNext,
  statusScaleNote,
  STATUS_SCALE_NOTE,
  holdBeforeDue,
  SRS_STEPS,
  MAX_INTERVAL_DAYS,
  RANK_FLOOR_DAYS,
  intervalAfter,
  keepLaterDue,
  unseenFailCap,
  daysBetween,
  daysSinceAnswer
} from "../js/mastery.js";
import * as MA from "../js/mastery.js"; // Batch 70 の M1・M1'（isSlipFail・masteryPeakOf・RANK_FLOOR_GAP_DAYS）。名前で読むので、無い版でも読み込みは落ちず検査が落ちる
import { localDay, dayDiff, gapBand } from "../js/retentionCalc.js"; // gap の帯は js/masteryMeta.js と js/memoryCheck.js が同じものを使う（PR #172 のレビュー 7）
import {
  BOX_KEYS,
  COLD_FAST_MS,
  boxKey,
  classifySpeed,
  noteSpeedSample,
  getSpeedBox,
  getMasteryMeta,
  noteRankCheck,
  notePendingFirstFast,
  flushMasteryMeta,
  tickMasteryMeta,
  forgetMasteryMeta
} from "../js/masteryMeta.js";

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond) => eq(name, !!cond, true);

// localStorage（Node には無い）。キーごとの setItem の回数を数える
const store = new Map();
const writes = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      writes.set(k, (writes.get(k) ?? 0) + 1);
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    }
  }
});
const writesOf = (k) => writes.get(k) ?? 0;

// ローカルの年月日・時刻から ms（時間帯に依らず「その日の」時刻）
const at = (ymd, h = 9, m = 0) => {
  const [y, mo, d] = ymd.split("-").map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
};
const iso = (ymd, h = 9, m = 0) => new Date(at(ymd, h, m)).toISOString();
const deepFreeze = (o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

const ctx = (over = {}) => ({ prevDay: "2026-10-01", sameDay: false, gap: 3, failedToday: false, knownCheck: false, ...over });
const FIRST = { prevDay: null, sameDay: false, gap: null, failedToday: false, knownCheck: false };
const okA = (speed = "normal", clean = true) => ({ ok: true, clean, speed });
const NG = { ok: false, clean: false, speed: "unknown" };

// ── 0. 定数 ───────────────────────────────────────────
eq("段の名前", RANK_NAMES, ["", "まだ", "あやふや", "思い出せる", "身についた", "即答"]);
eq("段の説明", RANK_GLOSS, ["", "思い出せなかったまま", "思い出せたが、確かではない", "間違えずに思い出せた", "6日以上あけて思い出せた（初めてで、すぐ打てた語も）", "2週間以上あけて、すぐ打てた"]);
ok("規則の文は「時間がたつだけでは下がらない」で終わる", RANK_RULE.endsWith("時間がたつだけでは下がらない。"));
eq("日数と時間の定数", [SOLID_GAP_DAYS, TOP_GAP_DAYS, KNOWN_CHECK_DAYS, MIN_GAP_MS], [6, 20, 14, 6 * 3600 * 1000]);
eq("既定の線", COLD_FAST_MS, { "en.kbd": 1500, "en.touch": 2100 });

// ── 1. 初めての答え ───────────────────────────────────
eq("初めて: × → 1", nextRank(0, NG, FIRST), 1);
eq("初めて: ノーミス fast → 4", nextRank(0, okA("fast"), FIRST), 4);
eq("初めて: ノーミス normal → 3", nextRank(0, okA("normal"), FIRST), 3);
eq("初めて: ノーミス unknown → 3", nextRank(0, okA("unknown"), FIRST), 3);
eq("初めて: ノーミス slow → 3（遅くても 3）", nextRank(0, okA("slow"), FIRST), 3);
eq("初めて: 打ち間違いあり → 2", nextRank(0, okA("fast", false), FIRST), 2);

// ── 2. 同じ日の扱い（answerContext から）──────────────────
{
  const D = "2026-10-12";
  const c1 = answerContext({ masteryRank: 1, masteryAt: iso(D, 9), lastRecallFailAt: iso(D, 9) }, at(D, 10));
  eq("同じ日の ○: まだ → あやふや", nextRank(1, okA(), c1), 2);
  const c3 = answerContext({ masteryRank: 3, masteryAt: iso(D, 9), lastRecallSuccessAt: iso(D, 9) }, at(D, 10));
  eq("同じ日の ○: 3 → 3", nextRank(3, okA("fast"), c3), 3);
  const morning = { masteryRank: 4, masteryAt: iso(D, 8), lastRecallSuccessAt: iso(D, 8) };
  const cx1 = answerContext(morning, at(D, 21));
  eq("朝 ○ の後の夜の × は今日最初の × なので 1 段（failedToday 偽）", [cx1.failedToday, nextRank(4, NG, cx1)], [false, 3]);
  const evening = { masteryRank: 3, masteryAt: iso(D, 21), lastRecallSuccessAt: iso(D, 8), lastRecallFailAt: iso(D, 21) };
  const cx2 = answerContext(evening, at(D, 21, 30));
  eq("同じ日の 2 回目の × では下がらない（failedToday 真）", [cx2.failedToday, nextRank(3, NG, cx2)], [true, 3]);
  const late = { masteryRank: 2, masteryAt: iso("2026-10-11", 23, 56), lastRecallFailAt: iso("2026-10-11", 23, 50), lastRecallSuccessAt: iso("2026-10-11", 23, 56) };
  const cm = answerContext(late, at(D, 0, 3));
  eq("23:56 の答え → 00:03 の ○ は同じ日の扱い（2 → 2）", [cm.sameDay, cm.gap, nextRank(2, okA("fast"), cm)], [true, null, 2]);
  const future = { masteryRank: 2, masteryAt: iso("2026-10-13", 9), lastRecallSuccessAt: iso("2026-10-13", 9) };
  const cb = answerContext(future, at(D, 9));
  eq("gap −1（時計の戻り）は同じ日の扱い: ○ 2 → 2", [cb.sameDay, nextRank(2, okA("fast"), cb)], [true, 2]);
  eq("gap −1: × 4 → 3", nextRank(4, NG, cb), 3);
}

// ── 3. その日の最初の × ───────────────────────────────
eq("その日の最初の ×: 5 → 4", nextRank(5, NG, ctx()), 4);
eq("その日の最初の ×: 2 → 1", nextRank(2, NG, ctx()), 1);
eq("その日の最初の ×: 1 → 1（最低は 1）", nextRank(1, NG, ctx()), 1);

// ── 4. 日数が分からない答え（prevDay なし・段あり）─────────────
{
  const c = answerContext({ mastered: true, cleanCorrectStreak: 10 }, at("2026-10-12"));
  eq("日数が分からない: 文脈", [c.prevDay, c.unknownDays, c.firstAnswer, c.rank], [null, true, false, 4]);
  eq("日数が分からない: ○ 4 → 4", nextRank(4, okA("fast"), c), 4);
  eq("日数が分からない: × 4 → 3（1 まで落ちない）", nextRank(4, NG, c), 3);
  eq("日数が分からない: ○ 1 → 2", nextRank(1, okA(), { ...c, prevDay: null }), 2);
}

// ── 5. ノーミス（別の日）────────────────────────────────
eq("2・gap 1 → 3", nextRank(2, okA(), ctx({ gap: 1 })), 3);
eq("3・gap 5 → 3", nextRank(3, okA("fast"), ctx({ gap: 5 })), 3);
eq("3・gap 6 → 4", nextRank(3, okA(), ctx({ gap: 6 })), 4);
eq("2・gap 30 → 3（1 日 1 段）", nextRank(2, okA("fast"), ctx({ gap: 30 })), 3);
eq("4・gap 20・fast → 5", nextRank(4, okA("fast"), ctx({ gap: 20 })), 5);
eq("4・gap 19・fast → 4", nextRank(4, okA("fast"), ctx({ gap: 19 })), 4);
eq("4・gap 20・normal → 4", nextRank(4, okA("normal"), ctx({ gap: 20 })), 4);
eq("4・gap 20・unknown → 4", nextRank(4, okA("unknown"), ctx({ gap: 20 })), 4);
eq("5・slow → 4（遅い答えのまま即答と言わない）", nextRank(5, okA("slow"), ctx({ gap: 30 })), 4);
eq("5・normal → 5", nextRank(5, okA("normal"), ctx({ gap: 30 })), 5);
eq("5・unknown → 5", nextRank(5, okA("unknown"), ctx({ gap: 30 })), 5);
eq("1・gap 3 → 2", nextRank(1, okA(), ctx({ gap: 3 })), 2);

// ── 6. 知ってた語の最初の確認 ─────────────────────────────
const KC = (gap) => ctx({ gap, knownCheck: true });
eq("確認: 3・gap 14・fast → 5", nextRank(3, okA("fast"), KC(14)), 5);
eq("確認: 3・gap 13・fast → 4（通常の規則）", nextRank(3, okA("fast"), KC(13)), 4);
eq("確認: 3・gap 14・normal → 4", nextRank(3, okA("normal"), KC(14)), 4);
eq("確認: 4・gap 14・unknown → 4", nextRank(4, okA("unknown"), KC(14)), 4);
eq("確認の前に別の日の答えあり（knownCheck 偽）: 4・gap 14・fast → 4", nextRank(4, okA("fast"), ctx({ gap: 14 })), 4);
eq("知ってたでない 3・gap 14・fast → 4", nextRank(3, okA("fast"), ctx({ gap: 14 })), 4);
eq("確認でも打ち間違いありは上げない", nextRank(3, okA("fast", false), KC(14)), 3);

// ── 7. 打ち間違いあり（Battle）──────────────────────────
eq("打ち間違いあり: 1 → 2", nextRank(1, okA("unknown", false), ctx()), 2);
eq("打ち間違いあり: 4 → 4（正解で下げない）", nextRank(4, okA("unknown", false), ctx({ gap: 25 })), 4);
eq("打ち間違いあり: 2 → 2（2 より上げない）", nextRank(2, okA("unknown", false), ctx({ gap: 25 })), 2);

// ── 8. answerContext ─────────────────────────────────
{
  const D = "2026-10-12";
  const c = answerContext({ lastRecallSuccessAt: iso(D, 9) }, at(D, 15));
  eq("同じローカル日", [c.prevDay, c.sameDay, c.gap, c.firstOfDay], [D, true, null, false]);
  const c5 = answerContext({ lastRecallSuccessAt: iso("2026-10-11", 22) }, at(D, 3));
  eq("6 時間未満で日付をまたぐ → 同じ日の扱い", [c5.sameDay, c5.gap, c5.firstOfDay], [true, null, false]);
  const c7 = answerContext({ lastRecallSuccessAt: iso("2026-10-11", 20) }, at(D, 3));
  eq("7 時間あけて日付をまたぐ → 別の日（gap 1）", [c7.sameDay, c7.gap, c7.firstOfDay], [false, 1, true]);
  const cb = answerContext({ lastRecallSuccessAt: iso("2026-10-13", 9) }, at(D, 9));
  eq("gap −1 は同じ日の扱い", [cb.sameDay, cb.gap, cb.firstOfDay], [true, null, false]);
  const c8 = answerContext({ lastRecallSuccessAt: iso("2026-10-04", 9) }, at(D, 9));
  eq("8 日あけた", [c8.gap, c8.firstOfDay], [8, true]);
  const cBoth = answerContext({ lastRecallSuccessAt: iso("2026-10-01", 9), lastRecallFailAt: iso("2026-10-09", 9) }, at(D, 9));
  eq("前の答えは ○ と × の新しい方（× の日から数える）", [cBoth.prevDay, cBoth.gap], ["2026-10-09", 3]);
  eq("今日の × あり → failedToday", answerContext({ lastRecallFailAt: iso(D, 8) }, at(D, 20)).failedToday, true);
  eq("昨日の × のみ → failedToday 偽", answerContext({ lastRecallFailAt: iso("2026-10-11", 8) }, at(D, 20)).failedToday, false);
  eq("昨日 23 時の × → 2 時は 6 時間未満なので failedToday", answerContext({ lastRecallFailAt: iso("2026-10-11", 23) }, at(D, 2)).failedToday, true);
  const cf = answerContext({ playCount: 3 }, at(D));
  eq("初めての答え（出題だけの語も）", [cf.prevDay, cf.firstAnswer, cf.unknownDays, cf.rank, cf.firstOfDay], [null, true, false, 0, false]);
  const cu = answerContext({ knownOnSight: true, recallFail: 0, cleanCorrectStreak: 1 }, at(D));
  eq("日数が分からない答え（knownOnSight だけ）", [cu.firstAnswer, cu.unknownDays, cu.rank], [false, true, 3]);
  eq("knownCheck: 知ってた語で streak 1", answerContext({ knownOnSight: true, recallFail: 0, cleanCorrectStreak: 1, lastRecallSuccessAt: iso("2026-09-28") }, at(D)).knownCheck, true);
  eq("knownCheck: streak 2 なら偽", answerContext({ knownOnSight: true, recallFail: 0, cleanCorrectStreak: 2, lastRecallSuccessAt: iso("2026-09-28") }, at(D)).knownCheck, false);
  eq("knownCheck: つまずいた知ってた語は偽", answerContext({ knownOnSight: true, recallFail: 1, cleanCorrectStreak: 1, lastRecallSuccessAt: iso("2026-09-28") }, at(D)).knownCheck, false);
  // 初見の知ってたは期日を 14 日後に置く。打ち間違いありの正解（streak 0）→ 別の日のノーミスで streak 1 に戻った語は、期日が streak の間隔（翌日）
  const kOk = { knownOnSight: true, recallFail: 0, cleanCorrectStreak: 1, lastRecallSuccessAt: iso("2026-09-28"), nextReviewAt: iso("2026-10-12") };
  eq("knownCheck: 初見の知ってた（期日は最後の自力正解の 14 日後）→ 真", [answerContext(kOk, at(D)).knownCheck, isKnownWaiting(kOk)], [true, true]);
  const kRe = { ...kOk, lastRecallSuccessAt: iso("2026-10-04"), nextReviewAt: iso("2026-10-05") };
  eq("knownCheck: streak 1 でも期日が最後の自力正解の翌日（打ち間違いありの正解のあと、別の日のノーミス）→ 偽", [answerContext(kRe, at(D)).knownCheck, isKnownWaiting(kRe)], [false, false]);
  eq("isKnownWaiting: 期日が最後の自力正解から 13 日 → 真・12 日 → 偽", [isKnownWaiting({ ...kOk, nextReviewAt: iso("2026-10-11") }), isKnownWaiting({ ...kOk, nextReviewAt: iso("2026-10-10") })], [true, false]);
  eq("答えの記録", [answered({ playCount: 4 }), answered({ mastered: true }), answered({ knownOnSight: true }), answered(null)], [false, true, true, false]);
  eq("知ってた語", [isKnownWord({ knownOnSight: true }), isKnownWord({ knownOnSight: true, recallFail: 1 }), isKnownWord({ knownOnSight: "yes" })], [true, false, false]);
}

// ── 9. rankOf と initialRank ──────────────────────────
{
  const a = iso("2026-10-01");
  eq("欄が勝つ", rankOf({ masteryRank: 2, masteryAt: a, lastRecallSuccessAt: a, cleanCorrectStreak: 8 }), 2);
  const unseen = { masteryRank: 4, masteryAt: a, lastRecallSuccessAt: a, lastRecallFailAt: iso("2026-10-03") };
  eq("見ていない ×（masteryAt より新しく未解決）で読むときだけ 1 段下げる", rankOf(unseen), 3);
  eq("見ていない × でも最低は 1", rankOf({ ...unseen, masteryRank: 1 }), 1);
  eq("× のあと解決済みならそのまま", rankOf({ ...unseen, lastRecallSuccessAt: iso("2026-10-04") }), 4);
  const same = iso("2026-10-03");
  eq("masteryAt と lastRecallFailAt が同じ文字列なら下げない", rankOf({ masteryRank: 3, masteryAt: same, lastRecallSuccessAt: a, lastRecallFailAt: same }), 3);
  const old = { lastRecallSuccessAt: a, cleanCorrectStreak: 3 };
  eq("範囲外の値は初期値", [7, 0, "4", 2.5, -1].map((v) => rankOf({ ...old, masteryRank: v })), [3, 3, 3, 3, 3]);
  eq("答えの記録が無ければ欄があっても 0", rankOf({ playCount: 2, masteryRank: 4 }), 0);

  const h = (...rows) => rows.map(([d, r]) => ({ d, r }));
  eq("初期値: 記録なし → 0", [initialRank({}), initialRank({ playCount: 5 }), initialRank(null)], [0, 0, 0]);
  const known2 = { knownOnSight: true, recallFail: 0, cleanCorrectStreak: 2, lastRecallSuccessAt: a };
  eq("初期値: 知ってた・streak 2・6 日以上あいた ○ あり → 4", initialRank({ ...known2, history: h(["2026-09-01", "o"], ["2026-09-15", "o"]) }), 4);
  eq("初期値: 知ってた・streak 2・6 日以上あいた ○ なし → 3", initialRank({ ...known2, history: h(["2026-09-01", "o"], ["2026-09-03", "o"]) }), 3);
  eq("初期値: 知ってた・streak 2・history 2 件未満 → 4", [initialRank({ ...known2, history: h(["2026-09-01", "o"]) }), initialRank(known2)], [4, 4]);
  eq("初期値: 知ってた・streak 1 → 3", initialRank({ ...known2, cleanCorrectStreak: 1 }), 3);
  eq("初期値: knownOnSight だけ（lastRecallSuccessAt なし）→ 3", initialRank({ playCount: 1, knownOnSight: true, recallFail: 0 }), 3);
  const unres = { recallFail: 1, cleanCorrectStreak: 0, lastRecallSuccessAt: a, lastRecallFailAt: iso("2026-10-05") };
  eq("初期値: 未解決で masteredAt あり → 3", initialRank({ ...unres, masteredAt: iso("2026-08-01") }), 3);
  eq("初期値: 未解決・最後の × の前に ○ の日が 2 日 → 2", initialRank({ ...unres, history: h(["2026-09-20", "o"], ["2026-10-01", "o"], ["2026-10-05", "x"]) }), 2);
  eq("初期値: 未解決・最後の × の前に ○ の日が 1 日 → 1", initialRank({ ...unres, history: h(["2026-10-01", "o"], ["2026-10-01", "o"], ["2026-10-05", "x"]) }), 1);
  eq("初期値: 未解決・history なし → 1", initialRank(unres), 1);
  eq("初期値: 単語帳の種（未解決・streak 3・masteredAt なし・○ 1 日 → ×）→ 1", initialRank({ ...unres, cleanCorrectStreak: 3, history: h(["2026-10-01", "o"], ["2026-10-05", "x"]) }), 1);
  eq("初期値: 自力正解が無い（つまずいた知ってた語・× の日時なし）→ 1", initialRank({ knownOnSight: true, recallFail: 1 }), 1);
  const ten = Array.from({ length: 8 }, (_, i) => ({ d: `2026-09-${String(10 + i).padStart(2, "0")}`, r: "o" }));
  eq("初期値: 習得・6 日以上あいた ○ なし（毎日のミッションで習得）→ 3", initialRank({ mastered: true, masteredAt: a, cleanCorrectStreak: 10, lastRecallSuccessAt: a, history: ten }), 3);
  eq("初期値: 習得・6 日以上あいた ○ あり → 4", initialRank({ mastered: true, cleanCorrectStreak: 10, lastRecallSuccessAt: a, history: h(["2026-09-01", "o"], ["2026-09-20", "o"]) }), 4);
  eq("初期値: streak 6・history 2 件未満 → 4", initialRank({ cleanCorrectStreak: 6, lastRecallSuccessAt: a }), 4);
  eq("初期値: 解決済み・streak 3 → 3", initialRank({ cleanCorrectStreak: 3, lastRecallSuccessAt: iso("2026-10-06"), lastRecallFailAt: iso("2026-10-05"), recallFail: 1 }), 3);
  eq("初期値: 自力正解あり・streak 1 → 2", initialRank({ cleanCorrectStreak: 1, lastRecallSuccessAt: a }), 2);
  eq("初期値: 自力正解あり・streak 0 → 2", initialRank({ cleanCorrectStreak: 0, lastRecallSuccessAt: a }), 2);
  eq("初期値: 壊れた history の項目でも落ちない", initialRank({ cleanCorrectStreak: 6, lastRecallSuccessAt: a, history: [null, { d: "x" }, { r: "o" }] }), 3);

  // 読み手は stat を書き換えない（凍らせて呼ぶ。モジュールは strict mode なので書き換えれば例外）
  const frozen = deepFreeze({ ...unseen, history: h(["2026-09-20", "o"], ["2026-10-01", "o"]), nextReviewAt: iso("2026-10-30") });
  let threw = null;
  try {
    rankOf(frozen);
    initialRank(frozen);
    answerContext(frozen, at("2026-10-12"));
    rankHtml(rankOf(frozen), { title: rankBasis(frozen, "2026-10-12") });
    rankNext(frozen, "2026-10-12");
    holdBeforeDue(frozen, at("2026-10-12"), { includeRank3: true });
  } catch (e) {
    threw = e.message;
  }
  eq("読み手（rankOf・initialRank・answerContext・rankHtml・rankBasis・rankNext・holdBeforeDue）は stat を書き換えない", threw, null);
}

// ── 10. 初見の判定 ───────────────────────────────────
eq("isFirstAnswer: 出題 3 回・答えなし → true", isFirstAnswer({ playCount: 3, recallFail: 0 }), true);
eq("isFirstAnswer: recallFail 1 → false", isFirstAnswer({ playCount: 1, recallFail: 1 }), false);
eq("isFirstAnswer: lastRecallSuccessAt あり → false", isFirstAnswer({ playCount: 1, lastRecallSuccessAt: iso("2026-10-01") }), false);
eq("isFirstAnswer: lastRecallFailAt あり → false", isFirstAnswer({ playCount: 1, lastRecallFailAt: iso("2026-10-01") }), false);
eq("isFirstAnswer: 日時の無い古い記録（習得・知ってた・ノーミス連続あり）は初見と読まない", [isFirstAnswer({ playCount: 30, mastered: true, cleanCorrectStreak: 10 }), isFirstAnswer({ playCount: 1, knownOnSight: true }), isFirstAnswer({ playCount: 6, cleanCorrectStreak: 4 })], [false, false, false]);
eq("isFirstAnswer: 出題だけの語（streak 0・correctCount 0）→ true", isFirstAnswer({ playCount: 2, correctCount: 0, cleanCorrectStreak: 0, mastered: false, knownOnSight: undefined }), true);

// ── 11. 速さ ───────────────────────────────────────
{
  const box19 = { t1: Array(19).fill(2000), pc: [] };
  const first = { firstAnswer: true, data: box19 };
  eq("19 件・初めて・en.kbd・1,400ms → fast（既定の線）", classifySpeed({ t1: 1400 }, "en.kbd.study", first), { speed: "fast", basis: "prior" });
  eq("19 件・初めて・en.kbd・1,500ms ちょうど → fast", classifySpeed({ t1: 1500 }, "en.kbd.study", first).speed, "fast");
  eq("19 件・初めて・en.kbd・1,600ms → unknown", classifySpeed({ t1: 1600 }, "en.kbd.study", first), { speed: "unknown", basis: null });
  eq("19 件・初めて・en.touch・2,000ms → fast", classifySpeed({ t1: 2000 }, "en.touch.play", first), { speed: "fast", basis: "prior" });
  eq("19 件・初めてでない → unknown", classifySpeed({ t1: 1000 }, "en.kbd.study", { data: box19 }).speed, "unknown");
  eq("19 件・ja（ローマ字）→ unknown", classifySpeed({ t1: 1000 }, "ja.kbd.study", first).speed, "unknown");
  eq("19 件・2,500ms → unknown（既定から slow・normal は出さない）", classifySpeed({ t1: 2500 }, "en.kbd.study", first).speed, "unknown");
  eq("19 件・10 秒 → unknown（slow は出さない）", classifySpeed({ t1: 10000 }, "en.kbd.study", first).speed, "unknown");
  eq("19 件・pc は見ない", classifySpeed({ t1: 1400, pc: 99999 }, "en.kbd.study", first).speed, "fast");

  const box20 = { t1: Array(20).fill(2000), pc: [] };
  const own = { data: box20 };
  eq("20 件・200ms 未満 → unknown（先打ち）", classifySpeed({ t1: 150 }, "en.kbd.study", own).speed, "unknown");
  eq("20 件・0.75 倍ちょうど → fast（本人）", classifySpeed({ t1: 1500 }, "en.kbd.study", own), { speed: "fast", basis: "own" });
  eq("20 件・初めての答えでも本人の基準", classifySpeed({ t1: 1600 }, "en.kbd.study", { data: box20, firstAnswer: true }), { speed: "normal", basis: "own" });
  eq("20 件・1.5 倍ちょうど → normal", classifySpeed({ t1: 3000 }, "en.kbd.study", own), { speed: "normal", basis: "own" });
  eq("20 件・1.5 倍超 → slow", classifySpeed({ t1: 3001 }, "en.kbd.study", own), { speed: "slow", basis: "own" });
  eq("20 件・ja も本人の基準で測る", classifySpeed({ t1: 1000 }, "ja.touch.play", own).speed, "fast");
  const pc19 = { t1: Array(20).fill(2000), pc: Array(19).fill(100) };
  eq("pc の箱 19 件なら pc を見ない（fast）", classifySpeed({ t1: 1400, pc: 1000 }, "en.kbd.study", { data: pc19 }).speed, "fast");
  eq("pc の箱 19 件なら pc を見ない（slow にしない）", classifySpeed({ t1: 2000, pc: 1000 }, "en.kbd.study", { data: pc19 }).speed, "normal");
  const pc20 = { t1: Array(20).fill(2000), pc: Array(20).fill(100) };
  eq("pc の箱 20 件・2 倍ちょうどは fast", classifySpeed({ t1: 1400, pc: 200 }, "en.kbd.study", { data: pc20 }).speed, "fast");
  eq("pc の箱 20 件・2 倍超は fast にしない", classifySpeed({ t1: 1400, pc: 201 }, "en.kbd.study", { data: pc20 }).speed, "normal");
  eq("pc の箱 20 件・2.5 倍超で slow", classifySpeed({ t1: 1400, pc: 251 }, "en.kbd.study", { data: pc20 }).speed, "slow");
  eq("pc を測れない答え（null）は pc を見ない", classifySpeed({ t1: 1400, pc: null }, "en.kbd.study", { data: pc20 }).speed, "fast");
  eq("測らない答え（null・NaN）・知らない箱 → unknown", [classifySpeed(null, "en.kbd.study", own).speed, classifySpeed({ t1: NaN }, "en.kbd.study", own).speed, classifySpeed({ t1: 1000 }, "en.pen.study", own).speed], ["unknown", "unknown", "unknown"]);

  eq("箱のキー 8 つ", [...BOX_KEYS].sort(), ["en.kbd.play", "en.kbd.study", "en.touch.play", "en.touch.study", "ja.kbd.play", "ja.kbd.study", "ja.touch.play", "ja.touch.study"]);
  eq("boxKey", [boxKey({ lang: "en", input: "kbd", ctx: "study" }), boxKey({ lang: "ja", input: "touch", ctx: "play" }), boxKey({ lang: "fr", input: "kbd", ctx: "study" }), boxKey()], ["en.kbd.study", "ja.touch.play", null, null]);
  eq("gap の帯", [0, 1, 2, 5, 6, 13, 14, 29, 30, 400, NaN].map(gapBand), [null, "1", "2-5", "2-5", "6-13", "6-13", "14-29", "14-29", "30+", "30+", null]);

  // 箱に入れる（メモリー）。保存は flushMasteryMeta のときだけ
  store.clear();
  writes.clear();
  forgetMasteryMeta();
  eq("入れる: 先打ち（200ms 未満）・知らない箱は入れない", [noteSpeedSample("en.kbd.study", { t1: 150 }), noteSpeedSample("xx", { t1: 900 })], [false, false]);
  ok("入れる: 測れた答えは入る", noteSpeedSample("en.kbd.study", { t1: 9000, pc: 300 }));
  eq("入れるとき 7,000ms で丸める", getSpeedBox("en.kbd.study"), { t1: [7000], pc: [300] });
  eq("入れただけでは保存しない", writesOf("spelldash_mastery_meta"), 0);
  for (let i = 1; i <= 40; i++) noteSpeedSample("en.kbd.study", { t1: 1000 + i, pc: null });
  const b = getSpeedBox("en.kbd.study");
  eq("41 件目で古い 1 件を捨てる（40 件）", [b.t1.length, b.t1[0], b.t1[39], b.pc], [40, 1001, 1040, [300]]);
  eq("箱が初めて 20 件になったときの中央値（1 回だけ書く。7,000 と 1,001〜1,019 の 20 件）", getMasteryMeta().check.firstMedian["en.kbd.study"], 1010.5);
  eq("メモリーの箱で分類（data を渡さない）", classifySpeed({ t1: 700 }, "en.kbd.study").basis, "own");
  ok("変わったので flush で 1 回書く", flushMasteryMeta() && writesOf("spelldash_mastery_meta") === 1);
  ok("変わっていなければ flush で書かない", !flushMasteryMeta() && writesOf("spelldash_mastery_meta") === 1);
  forgetMasteryMeta();
  eq("保存から読み直せる", getSpeedBox("en.kbd.study").t1.length, 40);
  store.set("spelldash_mastery_meta", "{broken");
  forgetMasteryMeta();
  eq("壊れた保存は空として読む", [getSpeedBox("en.kbd.study").t1.length, getMasteryMeta().v], [0, 1]);
  store.set("spelldash_mastery_meta", JSON.stringify({ v: 1, speed: { "en.kbd.study": { t1: [1, "x", 2000] }, "zz.kbd.study": { t1: [5] } }, check: { pending: { a: "p", b: "q" } } }));
  forgetMasteryMeta();
  eq("形の合う所だけ拾う", [getSpeedBox("en.kbd.study").t1, Object.keys(getMasteryMeta().speed), getMasteryMeta().check.pending], [[1, 2000], ["en.kbd.study"], { a: "p" }]);
}

// ── 段の確かめの集計（§3.8）────────────────────────────
{
  store.clear();
  writes.clear();
  forgetMasteryMeta();
  noteRankCheck({ id: "a", rankBefore: 3, gap: 8, ok: true }, at("2026-10-12"));
  noteRankCheck({ id: "b", rankBefore: 3, gap: 7, ok: false }, at("2026-10-12"));
  noteRankCheck({ id: "c", rankBefore: 5, gap: 40, ok: true }, at("2026-10-13"));
  noteRankCheck({ id: "d", rankBefore: 2, gap: 0, ok: true }); // 同じ日は数えない
  noteRankCheck({ id: "e", rankBefore: 0, gap: 3, ok: true }); // 段 0 は数えない
  const m = getMasteryMeta();
  eq("段 × 帯 × 結果", m.check.rank, { 3: { "6-13": [1, 1] }, 5: { "30+": [1, 0] } });
  eq("数え始めた日", m.check.since, "2026-10-12");
  notePendingFirstFast("p1", "prior");
  notePendingFirstFast("o1", "own");
  notePendingFirstFast("z", "none");
  eq("初めてで「すぐ」の語を控える", getMasteryMeta().check.pending, { p1: "p", o1: "o" });
  noteRankCheck({ id: "p1", rankBefore: 4, gap: 1, ok: false });
  noteRankCheck({ id: "o1", rankBefore: 4, gap: 2, ok: true });
  eq("次のその日の最初の答えで firstFast に数えて消す", [getMasteryMeta().check.firstFast, getMasteryMeta().check.pending], [{ prior: [0, 1], own: [1, 0] }, {}]);
  for (let i = 0; i < 205; i++) notePendingFirstFast(`w${i}`, "prior");
  const pend = Object.keys(getMasteryMeta().check.pending);
  eq("控えは 200 件まで（古い順に捨てる）", [pend.length, pend[0], pend[199]], [200, "w5", "w204"]);
  writes.clear();
  for (let i = 0; i < 9; i++) tickMasteryMeta();
  eq("9 答えでは書かない", writesOf("spelldash_mastery_meta"), 0);
  tickMasteryMeta();
  eq("10 答えごとに 1 回書く（変わっていれば）", writesOf("spelldash_mastery_meta"), 1);
  for (let i = 0; i < 10; i++) tickMasteryMeta();
  eq("変わっていなければ 10 答えでも書かない", writesOf("spelldash_mastery_meta"), 1);
}

// ── 12. 根拠と次の条件の文 ──────────────────────────────
{
  const T = "2026-10-12";
  const hist = (...rows) => rows.map(([d, r]) => ({ d, r }));
  eq("段 0 は空", [rankBasis({ playCount: 2 }, T), rankNext({ playCount: 2 }, T), rankHtml(0)], ["", "", ""]);
  eq("初期値で読んでいる語", rankBasis({ cleanCorrectStreak: 3, lastRecallSuccessAt: iso("2026-10-03") }, T), "これまでの記録から決めた仮の段（最後の答え 10月3日）");
  eq("初期値・日時の無い古い行は括弧ごと省く", rankBasis({ mastered: true, cleanCorrectStreak: 10 }, T), "これまでの記録から決めた仮の段");
  const unres = { masteryRank: 2, masteryAt: iso("2026-10-11", 20), recallFail: 1, lastRecallSuccessAt: iso("2026-10-01"), lastRecallFailAt: iso("2026-10-11", 20) };
  eq("未解決", rankBasis(unres, T), "10月11日は思い出せなかった");
  const kw = { masteryRank: 4, masteryAt: iso("2026-10-05"), knownOnSight: true, recallFail: 0, cleanCorrectStreak: 1, lastRecallSuccessAt: iso("2026-10-05"), nextReviewAt: iso("2026-10-19"), history: hist(["2026-10-05", "o"]) };
  eq("確認待ちの知ってた語・段 4", rankBasis(kw, T), "10月5日に初めて答えて、すぐ打てた");
  eq("確認待ちの知ってた語・段 3", rankBasis({ ...kw, masteryRank: 3 }, T), "10月5日に初めて答えて、間違えずに打てた");
  eq("確認待ちの次の条件（nextReviewAt の日）", rankNext(kw, T), "10月19日の確認で すぐ打てると 即答");
  eq("確認待ちの次の条件（期日が無ければ前の答え＋14 日）", rankNext({ ...kw, masteryRank: 3, nextReviewAt: null }, T), "10月19日の確認で すぐ打てると 即答");
  // 確認の日が過ぎて、まだ答えていない語（初見の 14 日後を過ぎた。期日は最後の答え＋14 日で、今日より前）
  const kwLate = { ...kw, masteryAt: iso("2026-09-24"), lastRecallSuccessAt: iso("2026-09-24"), nextReviewAt: iso("2026-10-08"), history: hist(["2026-09-24", "o"]) };
  eq("確認の日が過ぎていれば「次の確認で」", rankNext(kwLate, T), "次の確認で すぐ打てると 即答");
  for (const s of [kw, { ...kw, masteryRank: 3 }]) {
    const text = rankBasis(s, T) + rankNext(s, T);
    ok(`初めての答えで入った語（段 ${s.masteryRank}）の文に「日をあけ」「6日以上」が無い`, !text.includes("日をあけ") && !text.includes("6日以上") && text.includes("初めて答えて"));
  }
  const r4 = { masteryRank: 4, masteryAt: iso("2026-10-03"), cleanCorrectStreak: 5, lastRecallSuccessAt: iso("2026-10-03"), history: hist(["2026-09-26", "o"], ["2026-10-03", "o"]) };
  eq("N日あけて", rankBasis(r4, T), "10月3日に思い出せた（7日あけて）");
  eq("段 4 の次の条件（前の答え＋20 日）", rankNext(r4, T), "10月23日以降に すぐ打てると 即答");
  eq("history が足りなければ括弧なし", rankBasis({ ...r4, history: hist(["2026-10-03", "o"]) }, T), "10月3日に思い出せた");
  eq("history の最後の o の日が違えば括弧なし", rankBasis({ ...r4, history: hist(["2026-09-20", "o"], ["2026-09-26", "o"]) }, T), "10月3日に思い出せた");
  eq("差が 0（同じ日の反復）なら括弧なし", rankBasis({ ...r4, history: hist(["2026-10-03", "x"], ["2026-10-03", "o"]) }, T), "10月3日に思い出せた");
  // 日数の数え方は 1 つ（Batch 68 L1-6）: 前の答えのローカル日からの暦日の差。盤面の上・正解の後の文（daysSinceAnswer）と語の詳細（rankBasis）が同じ数
  eq("daysBetween: 暦日の差・同じ日／前の答えなし／先の日は 0", [daysBetween("2026-10-13", "2026-10-14"), daysBetween("2026-10-17", "2026-10-19"), daysBetween("2026-10-14", "2026-10-14"), daysBetween(null, "2026-10-14"), daysBetween("2026-10-15", "2026-10-14")], [1, 2, 0, 0, 0]);
  eq("daysSinceAnswer: 前日 23 時の自力正解を翌日 9 時に → 1（24 時間の切り捨てなら 0）", daysSinceAnswer({ lastRecallSuccessAt: iso("2026-10-13", 23) }, "2026-10-14"), 1);
  eq("daysSinceAnswer: 前の答えは ○ と × の新しい方（3 日目 21:00 × → 21:04 ○、5 日目に → 2）", daysSinceAnswer({ lastRecallFailAt: iso("2026-10-17", 21), lastRecallSuccessAt: iso("2026-10-17", 21, 4) }, "2026-10-19"), 2);
  eq("daysSinceAnswer: 前の答えが無い語は 0", daysSinceAnswer({ playCount: 1 }, "2026-10-19"), 0);
  eq("rankBasis の（N日あけて）も同じ数え方（3 日目 → 5 日目で 2）", rankBasis({ masteryRank: 3, masteryAt: iso("2026-10-19", 21), recallFail: 1, cleanCorrectStreak: 2, lastRecallFailAt: iso("2026-10-17", 21), lastRecallSuccessAt: iso("2026-10-19", 21), history: hist(["2026-10-17", "x"], ["2026-10-17", "o"], ["2026-10-19", "o"]) }, "2026-10-19"), "10月19日に思い出せた（2日あけて）");
  const r3 = { masteryRank: 3, masteryAt: iso("2026-10-10"), cleanCorrectStreak: 3, lastRecallSuccessAt: iso("2026-10-10") };
  eq("段 3 の次の条件（前の答え＋6 日）", rankNext(r3, T), "10月16日以降に 間違えずに思い出せると 身についた");
  eq("日付が今日以前なら「次に」", rankNext({ ...r3, lastRecallSuccessAt: iso("2026-10-01"), masteryAt: iso("2026-10-01") }, T), "次に 間違えずに思い出せると 身についた");
  const r2 = { masteryRank: 2, masteryAt: iso("2026-10-12"), cleanCorrectStreak: 0, lastRecallSuccessAt: iso("2026-10-12") };
  eq("段 2 の次の条件（前の答え＋1 日）", rankNext(r2, T), "10月13日以降に 間違えずに思い出せると 思い出せる");
  eq("段 2・前の答えが昨日なら「次に」", rankNext({ ...r2, lastRecallSuccessAt: iso("2026-10-11"), masteryAt: iso("2026-10-11") }, T), "次に 間違えずに思い出せると 思い出せる");
  eq("段 1 の次の条件", rankNext({ masteryRank: 1, masteryAt: iso("2026-10-11"), recallFail: 1, lastRecallFailAt: iso("2026-10-11") }, T), "自力で思い出せると あやふや");
  eq("未解決の段 3 は × の日から数える", rankNext({ ...unres, masteryRank: 3 }, T), "10月17日以降に 間違えずに思い出せると 身についた");
  eq("段 5 は次の条件なし", rankNext({ ...r4, masteryRank: 5 }, T), "");
  eq("前の答えの日が分からない古い行は日数で言う", rankNext({ mastered: true, cleanCorrectStreak: 10 }, T), "20日以上あけて すぐ打てると 即答");

  eq(
    "rankHtml: 目盛り 5 つ＋名前・role=img・aria-label",
    rankHtml(4),
    '<span class="rank" data-rank="4" role="img" aria-label="習熟度 身についた（5段のうち4）"><i></i><i></i><i></i><i></i><i></i><span class="rank__name">身についた</span></span>'
  );
  ok("rankHtml: label \"\" で「習熟度」を重ねない", rankHtml(1, { label: "" }).includes('aria-label="まだ（5段のうち1）"'));
  ok("rankHtml: name false で名前を出さない", !rankHtml(5, { name: false }).includes("rank__name"));
  ok("rankHtml: title は属性に入れて実体にする", rankHtml(3, { title: 'a"<b>' }).includes('title="a&quot;&lt;b&gt;"'));
  ok("rankHtml: 分数・「/10」を出さない", !/\/10|\d\/\d/.test(rankHtml(3)));
}

// ── 12b. 題箋と段が食い違って見える組の 1 文（語の詳細。Batch 64 M4）──────────────
{
  // 組（覚えた＋あやふや・習得＋思い出せる・苦手＋身についた ほか）だけに 1 文。ほかの組・段 0・未着手は空
  const pairs = [];
  for (const st of ["untouched", "weak", "learning", "mastered", "known"]) for (let r = 0; r <= 5; r++) if (statusScaleNote(st, r)) pairs.push(`${st}${r}`);
  eq("食い違って見える組: 苦手＋3〜5・覚えた／知ってた＋1〜2・習得＋1〜3", pairs.join(" "), "weak3 weak4 weak5 learning1 learning2 mastered1 mastered2 mastered3 known1 known2");
  eq("BACKLOG の 3 組の文（題箋の意味＋「習熟度とは別の物差し」）", [statusScaleNote("learning", 2), statusScaleNote("mastered", 3), statusScaleNote("weak", 4)], [STATUS_SCALE_NOTE.learning, STATUS_SCALE_NOTE.mastered, STATUS_SCALE_NOTE.weak]);
  ok("どの文も 1 文・題箋の名前で始まり「習熟度とは別の物差し。」で終わる・段の名前を含まない", Object.entries(STATUS_SCALE_NOTE).every(([k, t]) => t.split("。").filter(Boolean).length === 1 && t.endsWith("習熟度とは別の物差し。") && t.startsWith({ weak: "苦手 ", learning: "覚えた ", mastered: "習得 ", known: "知ってた " }[k]) && !RANK_NAMES.slice(1).some((n) => t.includes(n))));
}

// ── 13. 期日前に出さない（S6）────────────────────────────
{
  const NOW = at("2026-10-12");
  const fut = iso("2026-10-20");
  const past = iso("2026-10-01");
  const s4 = { masteryRank: 4, masteryAt: past, cleanCorrectStreak: 5, lastRecallSuccessAt: past };
  eq("段 4・期日が未来 → 出さない", holdBeforeDue({ ...s4, nextReviewAt: fut }, NOW), true);
  eq("段 5・期日が未来 → 出さない", holdBeforeDue({ ...s4, masteryRank: 5, nextReviewAt: fut }, NOW), true);
  eq("段 4・期日が過去 → 出す", holdBeforeDue({ ...s4, nextReviewAt: past }, NOW), false);
  eq("段 4・期日なし → 出す", holdBeforeDue({ ...s4, nextReviewAt: null }, NOW), false);
  const kw3 = { masteryRank: 3, masteryAt: past, knownOnSight: true, recallFail: 0, cleanCorrectStreak: 1, lastRecallSuccessAt: past, nextReviewAt: fut };
  eq("確認待ちの知ってた語・段 3 → 出さない", holdBeforeDue(kw3, NOW), true);
  eq("確認待ちの知ってた語（段の欄なし。knownOnSight の種）→ 出さない", holdBeforeDue({ playCount: 1, knownOnSight: true, recallFail: 0, cleanCorrectStreak: 1, lastRecallSuccessAt: past, nextReviewAt: fut }, NOW), true);
  const s3 = { masteryRank: 3, masteryAt: past, cleanCorrectStreak: 3, lastRecallSuccessAt: past, nextReviewAt: fut };
  eq("段 3・期日が未来 → 補充には出す", holdBeforeDue(s3, NOW), false);
  eq("段 3・includeRank3（ミッション）で期日が未来 → 出さない", holdBeforeDue(s3, NOW, { includeRank3: true }), true);
  eq("段 2・includeRank3 でも出す", holdBeforeDue({ ...s3, masteryRank: 2 }, NOW, { includeRank3: true }), false);
  // 苦手（未解決。最後が ×）は期日を見ずに出す。種は実際の流れの形: 段 4・段 5 で × → 答えを見て打ち直し（recordCorrect の非 clean の枝が
  // 期日を翌日にする）→ 段は 1 つ下・最後が ×・期日は × の翌日（今より先）。書き手を通した同じ流れは §15 にもある
  const slip = (rank) => ({ masteryRank: rank, masteryAt: iso("2026-10-12", 8), cleanCorrectStreak: 0, recallFail: 1, missCount: 1, lastRecallSuccessAt: past, lastRecallFailAt: iso("2026-10-12", 8), nextReviewAt: iso("2026-10-13", 8) });
  for (const [from, s] of [[4, slip(3)], [5, slip(4)]]) {
    eq(`× と打ち直しの後の苦手（段 ${from} → ${s.masteryRank}・期日は翌日）→ 補充・息抜きに出す`, holdBeforeDue(s, NOW), false);
    eq(`× と打ち直しの後の苦手（段 ${from} → ${s.masteryRank}・期日は翌日）→ ミッション（includeRank3）にも出す`, holdBeforeDue(s, NOW, { includeRank3: true }), false);
  }
  eq("knownOnSight が残る苦手の語（× あり）も同じ → 出す", holdBeforeDue({ ...slip(3), knownOnSight: true }, NOW, { includeRank3: true }), false);
  eq("記録なし → 出す", holdBeforeDue(undefined, NOW), false);
}

// ── 14. 復習の間隔とのつなぎ（段階 2: S2・S3 の intervalAfter、S1 の keepLaterDue）──────────
{
  // 間隔の表は js/mastery.js の SRS_STEPS の 1 か所（js/stats.js の REVIEW_INTERVAL_DAYS はこれを指す。PR #161 のレビュー 6 で写しをやめた）
  eq("間隔の表 SRS_STEPS は 1・2・3・5・7・10・14・21・30（今の SRS のまま）・書き換えられない", [[...SRS_STEPS], Object.isFrozen(SRS_STEPS)], [[1, 2, 3, 5, 7, 10, 14, 21, 30], true]);
  eq("上限 30 日・下限 身についた 7 日／即答 30 日", [MAX_INTERVAL_DAYS, RANK_FLOOR_DAYS[4], RANK_FLOOR_DAYS[5], RANK_FLOOR_DAYS[3] ?? 0], [30, 7, 30, 0]);
  // 予定どおり続ける人: gap ＝ 前の間隔、streakDays ＝ streak の間隔。段はその列で実際に付く段（gap 6 以上で 4、gap 21 ですぐなら 5）
  const sched = [];
  for (let k = 1; k < SRS_STEPS.length; k++) {
    const gap = SRS_STEPS[k - 1];
    const rank = gap >= 20 ? 5 : gap >= 6 ? 4 : 3;
    sched.push(intervalAfter({ streakDays: SRS_STEPS[k], gap, rank, speed: rank === 5 ? "fast" : "normal" }));
  }
  eq("予定どおりの列 1→2→3→5→7→10→14→21→30 は今と同じ（credit も下限も streak の間隔を超えない）", [1, ...sched], SRS_STEPS);
  eq("予定どおりの列（段 3 のまま・速さ unknown でも同じ）", SRS_STEPS.slice(1).map((d, i) => intervalAfter({ streakDays: d, gap: SRS_STEPS[i], rank: 3, speed: "unknown" })), SRS_STEPS.slice(1));
  eq("習得の後（streak 10・gap 30）→ 30", intervalAfter({ streakDays: 30, gap: 30, rank: 5, speed: "normal" }), 30);
  eq("知ってた語の初見（gap なし）→ 14（credit なし）", intervalAfter({ streakDays: 14, gap: null, rank: 4, speed: "fast" }), 14);
  eq("知ってた語の確認（gap 14）: すぐ → 即答 → 30 日", intervalAfter({ streakDays: 2, gap: 14, rank: 5, speed: "fast" }), 30);
  eq("知ってた語の確認（gap 14）: ふつう → 身についた → 21 日", intervalAfter({ streakDays: 2, gap: 14, rank: 4, speed: "normal" }), 21);
  eq("その次（gap 21）→ 30 日", intervalAfter({ streakDays: 3, gap: 21, rank: 4, speed: "normal" }), 30);
  eq("段 4 の語の × の翌日（streak 1・gap 1）→ 7 日（下限）", intervalAfter({ streakDays: 1, gap: 1, rank: 4, speed: "normal" }), 7);
  eq("即答から × で 身についた の語の翌日（Recall Loop で streak 1 → 2）→ 7 日", intervalAfter({ streakDays: 2, gap: 1, rank: 4, speed: "unknown" }), 7);
  // M1'（Batch 70）: 即答の 30 日は前の答えから 14 日以上あけた答えだけ。短いときは身についたの 7 日（× の翌日の正解 1 回から 30 日あけない）
  eq("段 5 の下限: gap 1 は 7 日（M1'。前は gap 1 でも 30 日）", intervalAfter({ streakDays: 2, gap: 1, rank: 5, speed: "normal" }), 7);
  eq("段 2・段 3 には下限が無く、gap 6 未満は credit も無い（gap 1 → streak の間隔 1 のまま）", intervalAfter({ streakDays: 1, gap: 1, rank: 2, speed: "normal" }), 1);
  eq("credit は gap 6 から（gap 5 → credit なし・gap 6 → 7）", [intervalAfter({ streakDays: 1, gap: 5, rank: 3, speed: "normal" }), intervalAfter({ streakDays: 1, gap: 6, rank: 3, speed: "normal" })], [1, 7]);
  // 1 日遅れ（期日には前の答えの時刻が付き、回を始めた時点で期日が来た語だけを積むので、毎日同じ時刻に学ぶ人でもふつうに起きる）: gap ＝ 間隔 + 1
  const late1 = [];
  for (let k = 1; k < SRS_STEPS.length; k++) {
    const gap = SRS_STEPS[k - 1] + 1;
    const rank = gap >= 20 ? 5 : gap >= 6 ? 4 : 3;
    late1.push(intervalAfter({ streakDays: SRS_STEPS[k], gap, rank, speed: rank === 5 ? "fast" : "normal" }));
  }
  eq("1 日遅れ（gap 2・3・4・6・8・11・15・22）でも表を飛ばさない（2→3→5→7→10→14→21→30。今と同じ）", late1, SRS_STEPS.slice(1));
  eq("× の後に Recall Loop が無い語（streak 0 → 翌日のノーミスで streak 1・gap 1）→ 1 日（今と同じ。2 日にしない）", intervalAfter({ streakDays: 1, gap: 1, rank: 2, speed: "normal" }), 1);
  eq("gap 40（遅れて戻った）→ 30（上限）", intervalAfter({ streakDays: 3, gap: 40, rank: 3, speed: "normal" }), 30);
  eq("gap 30 → 30（表の最後より長い gap は 30）", intervalAfter({ streakDays: 5, gap: 30, rank: 4, speed: "unknown" }), 30);
  eq("slow → credit も下限も無し（streak の間隔のまま）", intervalAfter({ streakDays: 3, gap: 30, rank: 4, speed: "slow" }), 3);
  eq("速さ unknown（測らない答え・Battle）は credit あり", intervalAfter({ streakDays: 3, gap: 8, rank: 4, speed: "unknown" }), 10);
  eq("gap が NaN → credit なし", intervalAfter({ streakDays: 2, gap: NaN, rank: 4, speed: "normal" }), 2);
  eq("gap 0 → credit なし", intervalAfter({ streakDays: 2, gap: 0, rank: 4, speed: "normal" }), 2);
  eq("gap −1（時計の戻り）→ credit なし", intervalAfter({ streakDays: 2, gap: -1, rank: 5, speed: "fast" }), 2);
  eq("gap が null・文字・欠けている → credit なし", [intervalAfter({ streakDays: 2, gap: null, rank: 4 }), intervalAfter({ streakDays: 2, gap: "14", rank: 4 }), intervalAfter({ streakDays: 2, rank: 4 })], [2, 2, 2]);
  eq("streak が進まなかった答え（streakDays 0）でも credit（gap 6 → 7）・gap 5 なら 0（recordCorrect が決めた期日のまま）", [intervalAfter({ streakDays: 0, gap: 6, rank: 3, speed: "normal" }), intervalAfter({ streakDays: 0, gap: 5, rank: 3, speed: "normal" })], [7, 0]);
  eq("streak の間隔より短くしない（期日前の答え: streakDays 21・gap 2 → 21）", intervalAfter({ streakDays: 21, gap: 2, rank: 3, speed: "normal" }), 21);
  eq("引数なし・崩れた引数 → 0", [intervalAfter(), intervalAfter({ streakDays: NaN, gap: NaN })], [0, 0]);

  const NOW = at("2026-10-12", 9);
  const fut10 = iso("2026-10-22", 9);
  const fut5 = iso("2026-10-17", 9);
  const past = iso("2026-10-10", 9);
  eq("keepLaterDue: 未来の期日（10 日後）は新しい期日（5 日後）より早めない", keepLaterDue(fut10, fut5, NOW), fut10);
  eq("keepLaterDue: 未来の期日（5 日後）より新しい期日（10 日後）が後なら新しい方", keepLaterDue(fut5, fut10, NOW), fut10);
  eq("keepLaterDue: 過ぎた期日は新しい方", keepLaterDue(past, fut5, NOW), fut5);
  eq("keepLaterDue: 今ちょうどの期日は新しい方", keepLaterDue(new Date(NOW).toISOString(), fut5, NOW), fut5);
  eq("keepLaterDue: 前の期日が無い・読めない → 新しい方", [keepLaterDue(null, fut5, NOW), keepLaterDue(undefined, fut5, NOW), keepLaterDue("x", fut5, NOW)], [fut5, fut5, fut5]);
  eq("keepLaterDue: 新しい期日が読めなければ前の期日を残す（どちらも読めなければ新しい方）", [keepLaterDue(fut10, "x", NOW), keepLaterDue(null, null, NOW)], [fut10, null]);

  // unseenFailCap: この端末の段が見ていない ×（2 台目・古い版で答えた）がある語は、S3 の下限を 1 段下の段で見る（解決済みでも）
  const at30 = iso("2026-09-12", 12);
  const failY = iso("2026-10-11", 12);
  const okY = iso("2026-10-11", 12, 10);
  eq("unseenFailCap: 段 5・masteryAt より後の × を 2 台目で打ち直した（解決済み）→ 4（rankOf は 5 のまま）", [unseenFailCap({ masteryRank: 5, masteryAt: at30, lastRecallFailAt: failY, lastRecallSuccessAt: okY }), rankOf({ masteryRank: 5, masteryAt: at30, lastRecallFailAt: failY, lastRecallSuccessAt: okY })], [4, 5]);
  eq("unseenFailCap: 未解決（最後が ×）でも 1 段下（rankOf と同じ段）", unseenFailCap({ masteryRank: 5, masteryAt: at30, lastRecallFailAt: failY, lastRecallSuccessAt: at30 }), 4);
  eq("unseenFailCap: 自分で書いた ×（masteryAt と同じ文字列）・× なし → null", [unseenFailCap({ masteryRank: 4, masteryAt: failY, lastRecallFailAt: failY }), unseenFailCap({ masteryRank: 5, masteryAt: at30, lastRecallSuccessAt: okY })], [null, null]);
  eq("unseenFailCap: 段 1 は 1 のまま・段の欄が無い語（initialRank で読む）・記録なし → null", [unseenFailCap({ masteryRank: 1, masteryAt: at30, lastRecallFailAt: failY }), unseenFailCap({ lastRecallFailAt: failY, lastRecallSuccessAt: okY }), unseenFailCap(undefined)], [1, null, null]);
}

// ── 15. 書き手（js/stats.js）: 同じ写しに段を書く・答える前の stat の控え・確かめの集計 ─────────
// js/stats.js は js/sync.js などを通じて window を読むので、読み込む前に最小の代わりを置く（DOM は使わない）
{
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
  const quiet = console.warn;
  console.warn = noop; // 偽のサーバーが無いときの「オフラインで続行」の 1 行を黙らせる
  store.clear();
  store.set("spelldash_schema_version", "6");
  const { recordCorrect, recordRecallSuccess, recordRecallFail } = await import("../js/stats.js");

  const DAY = 86400000;
  const ago = (days, extraMs = 0) => new Date(Date.now() - days * DAY - extraMs).toISOString();
  const base = (over = {}) => ({
    playCount: 3,
    correctCount: 2,
    missCount: 0,
    typingMiss: 0,
    recallFail: 0,
    cleanCorrectStreak: 2,
    mastered: false,
    masteredAt: null,
    lastPlayed: ago(1),
    nextReviewAt: null,
    lastRecallFailAt: null,
    lastRecallSuccessAt: null,
    dailyLearningDate: null,
    dailyLearningStage: 0,
    srsAdvancedOn: null,
    ...over
  });
  const seed = (map) => {
    store.set("spelldash_word_stats", JSON.stringify(map));
    forgetMasteryMeta();
  };
  const read = () => JSON.parse(store.get("spelldash_word_stats"));
  const nextTask = () => new Promise((r) => setTimeout(r, 0));
  const study = (id, speed = "normal") => {
    recordCorrect(id, true);
    recordRecallSuccess(id, { clean: true, speed });
  };
  const consistent = (s) => rankOf(s) === s.masteryRank && Number.isInteger(s.masteryRank);

  // 段 3・8 日前の自力正解 → ノーミスで 4。1 打で word_stats の保存は 1 回、mastery_meta は 0 回
  seed({ w: base({ masteryRank: 3, masteryAt: ago(8), lastRecallSuccessAt: ago(8), cleanCorrectStreak: 3, history: [{ d: "2026-01-01", r: "o" }] }) });
  await nextTask();
  writes.clear();
  study("w");
  await nextTask();
  let s = read().w;
  eq("8 日あけたノーミス: 3 → 4", s.masteryRank, 4);
  eq("8 日あけたノーミス: 期日は 10 日後（S2: gap 8 → 10。streak 4 の 5 日より長い。段 4 の下限 7 日）", Math.round((Date.parse(s.nextReviewAt) - Date.now()) / DAY), 10);
  ok("masteryAt は書いた lastRecallSuccessAt と同じ文字列", s.masteryAt === s.lastRecallSuccessAt);
  ok("書いた直後は rankOf === masteryRank", consistent(s));
  eq("正解の 1 打で word_stats の保存は 1 回・mastery_meta は 0 回", [writesOf("spelldash_word_stats"), writesOf("spelldash_mastery_meta")], [1, 0]);
  eq("その日の最初の答えを確かめに数える（答える前の段 3 × 帯 6-13）", getMasteryMeta().check.rank, { 3: { "6-13": [1, 0] } });

  // 同じ日に ×（今日最初の × で 1 段）→ 2 回目の × は下がらない。書くたびに一致
  recordRecallFail("w");
  await nextTask();
  s = read().w;
  eq("同じ日の ○ のあとの ×: 4 → 3", s.masteryRank, 3);
  ok("× の masteryAt・lastRecallFailAt・nextReviewAt は同じ文字列", s.masteryAt === s.lastRecallFailAt && s.nextReviewAt === s.lastRecallFailAt);
  ok("× を書いた直後も rankOf === masteryRank（自分の × を見ていない × と読まない）", consistent(s));
  recordRecallFail("w");
  await nextTask();
  s = read().w;
  eq("同じ日の 2 回目の ×: 3 のまま", [s.masteryRank, consistent(s)], [3, true]);
  recordCorrect("w", false); // 答え表示の後の打ち直し（答えに数えない）
  await nextTask();
  eq("答え表示の後の打ち直しでは段を書かない", read().w.masteryRank, 3);
  eq("同じ日の答えは確かめに数えない", getMasteryMeta().check.rank, { 3: { "6-13": [1, 0] } });

  // 段 4・前の答え 1 日前で × → 3
  seed({ x: base({ masteryRank: 4, masteryAt: ago(1), lastRecallSuccessAt: ago(1), cleanCorrectStreak: 5 }) });
  await nextTask();
  recordRecallFail("x");
  await nextTask();
  eq("段 4・前の答え 1 日前で × → 3", [read().x.masteryRank, consistent(read().x)], [3, true]);
  eq("× も確かめに数える", getMasteryMeta().check.rank, { 4: { 1: [0, 1] } });

  // 初見の直し: 出題 2 回・答えなしでノーミス → 知ってた
  seed({ k: base({ playCount: 2, correctCount: 0, cleanCorrectStreak: 0 }), f: base({ playCount: 1, correctCount: 0, cleanCorrectStreak: 0 }) }); // 出題だけの語は答えの綴りを見ていない（correctCount 0）
  await nextTask();
  study("k", "fast");
  study("f", "unknown");
  await nextTask();
  const kk = read().k;
  eq("出題 2 回・答えなしの語: 知ってた・2 週間後に確認・段 4（すぐ）", [kk.knownOnSight, kk.cleanCorrectStreak, Math.round((Date.parse(kk.nextReviewAt) - Date.now()) / DAY), kk.masteryRank], [true, 1, 14, 4]);
  eq("初見のノーミス（速さ unknown）→ 3", read().f.masteryRank, 3);
  eq("初めての答えは確かめに数えない", getMasteryMeta().check.rank, {});

  // Battle 型の呼び方（引数なし）
  seed({
    b1: base({ masteryRank: 3, masteryAt: ago(2), lastRecallSuccessAt: ago(2), cleanCorrectStreak: 3 }),
    b2: base({ masteryRank: 1, masteryAt: ago(3), lastRecallFailAt: ago(3), recallFail: 1, cleanCorrectStreak: 0 }),
    b3: base({ masteryRank: 4, masteryAt: ago(25), lastRecallSuccessAt: ago(25), cleanCorrectStreak: 7 }),
    b4: base({ cleanCorrectStreak: 5, lastRecallSuccessAt: ago(3), srsAdvancedOn: "2000-01-01" })
  });
  await nextTask();
  recordRecallFail("b1");
  recordCorrect("b2", false);
  recordRecallSuccess("b2");
  recordCorrect("b3", true);
  recordRecallSuccess("b3");
  recordCorrect("b4", true);
  recordRecallSuccess("b4");
  await nextTask();
  const bt = read();
  eq("Battle のパス（×）で 1 段下がる", bt.b1.masteryRank, 2);
  eq("Battle の打ち間違いありの正解: 1 → 2（2 より上げない）", bt.b2.masteryRank, 2);
  eq("Battle のノーミス正解は速さ unknown なので即答にならない（4・25 日 → 4）", bt.b3.masteryRank, 4);
  eq("段の欄なし・streak 5・3 日前 → 3（recordCorrect の後の streak 6 で 4 と読まない）", [bt.b4.cleanCorrectStreak, bt.b4.masteryRank], [6, 3]);
  ok("Battle の書き込みも rankOf === masteryRank", ["b1", "b2", "b3", "b4"].every((id) => consistent(bt[id])));

  // 控えは次のタスクへ持ち越さない（答え表示の後の打ち直しで recordCorrect だけ → 次の答え）
  seed({ c1: base({ cleanCorrectStreak: 5, lastRecallSuccessAt: ago(3), srsAdvancedOn: "2000-01-01" }), c2: base({ masteryRank: 2, masteryAt: ago(3), lastRecallSuccessAt: ago(3), cleanCorrectStreak: 1 }) });
  await nextTask();
  recordCorrect("c1", true);
  await nextTask();
  recordRecallSuccess("c2", { clean: true, speed: "normal" });
  recordRecallSuccess("c1");
  await nextTask();
  const cc = read();
  eq("別の語の答えには控えを使わない（c2: 2 → 3）", cc.c2.masteryRank, 3);
  eq("前のタスクの控えは捨ててある（c1 は今の stat から読む: streak 6 → 4、控えが無いので打ち間違いありの扱い）", cc.c1.masteryRank, 4);

  // 知ってた語の最初の確認（14 日後・すぐ）→ 即答。確認待ちでない知ってた語は飛ばない
  seed({
    kc: base({ masteryRank: 3, masteryAt: ago(14), knownOnSight: true, cleanCorrectStreak: 1, lastRecallSuccessAt: ago(14), srsAdvancedOn: "2000-01-01", nextReviewAt: ago(0, 1000) }),
    k2: base({ masteryRank: 4, masteryAt: ago(14), knownOnSight: true, cleanCorrectStreak: 2, lastRecallSuccessAt: ago(14), srsAdvancedOn: "2000-01-01" })
  });
  await nextTask();
  study("kc", "fast");
  study("k2", "fast");
  await nextTask();
  eq("知ってた語の最初の確認ですぐ → 即答", read().kc.masteryRank, 5);
  eq("確認の前に別の日の答えがある知ってた語（streak 2）は 14 日では即答にしない", read().k2.masteryRank, 4);
  eq("確認の後の期日: 即答 → 30 日後（S3）・身についた（gap 14）→ 21 日後（S2）", [read().kc, read().k2].map((x) => Math.round((Date.parse(x.nextReviewAt) - Date.now()) / DAY)), [30, 21]);

  // 初めてで「すぐ」だった語の次の答え（firstFast）
  seed({ ff: base({ masteryRank: 4, masteryAt: ago(2), knownOnSight: true, cleanCorrectStreak: 1, lastRecallSuccessAt: ago(2) }) });
  notePendingFirstFast("ff", "prior");
  await nextTask();
  recordRecallFail("ff");
  await nextTask();
  eq("初めてで「すぐ」だった語の次のその日の最初の答えを firstFast に数える", [getMasteryMeta().check.firstFast.prior, getMasteryMeta().check.pending], [[0, 1], {}]);

  // S6 と苦手: 段 4・段 5 で × → 答えを見て打ち直し（Study の決まり）。期日は翌日になるが、苦手（未解決）なので補充・ミッションから外さない
  seed({
    sl4: base({ masteryRank: 4, masteryAt: ago(7), lastRecallSuccessAt: ago(7), cleanCorrectStreak: 6, missCount: 1, recallFail: 1, lastRecallFailAt: ago(40), nextReviewAt: ago(0, 1000) }),
    sl5: base({ masteryRank: 5, masteryAt: ago(30), lastRecallSuccessAt: ago(30), cleanCorrectStreak: 9, missCount: 1, recallFail: 1, lastRecallFailAt: ago(90), nextReviewAt: ago(0, 1000) })
  });
  await nextTask();
  for (const id of ["sl4", "sl5"]) {
    recordRecallFail(id);
    await nextTask();
    recordCorrect(id, false); // 答え表示の後の打ち直し
    await nextTask();
  }
  {
    const sl = read();
    const tomorrow = Date.now() + 11 * 3600 * 1000; // 翌朝（期日の前）
    eq("× と打ち直しの後: 段 4 → 3・段 5 → 4、期日は翌日", [sl.sl4.masteryRank, sl.sl5.masteryRank, Math.round((Date.parse(sl.sl4.nextReviewAt) - Date.now()) / DAY), Math.round((Date.parse(sl.sl5.nextReviewAt) - Date.now()) / DAY)], [3, 4, 1, 1]);
    eq(
      "× と打ち直しの後の苦手は、期日が先でも補充・息抜き・ミッション（includeRank3）から外さない（今と翌朝）",
      ["sl4", "sl5"].flatMap((id) => [holdBeforeDue(sl[id]), holdBeforeDue(sl[id], Date.now(), { includeRank3: true }), holdBeforeDue(sl[id], tomorrow, { includeRank3: true })]),
      [false, false, false, false, false, false]
    );
  }

  // 知ってた語 → 打ち間違いありの正解（Battle）→ 別の日のノーミス: もう確認待ちではない（根拠の文・次の条件・14 日後の段）。
  // 偽の時計で書き手を何日も回す（stats.js は new Date()・Date.now() を呼ぶたびに今の globalThis.Date を読む）
  {
    const RealDate = Date;
    let clock = at("2026-10-01", 9);
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
    try {
      seed({ kb: base({ playCount: 1, correctCount: 0, cleanCorrectStreak: 0 }), kp: base({ playCount: 1, correctCount: 0, cleanCorrectStreak: 0 }) });
      await nextTask();
      study("kb", "normal"); // 10月1日: 初見のノーミス → 知ってた・段 3
      study("kp", "normal"); // 比べる: 打ち間違いの無い同じ流れ
      await nextTask();
      ok("10月1日: 初見のノーミスで確認待ち", isKnownWaiting(read().kb) && read().kb.masteryRank === 3);
      clock = at("2026-10-03", 9);
      recordCorrect("kb", false); // 10月3日: Battle 型の打ち間違いありの正解（引数なし）
      recordRecallSuccess("kb");
      await nextTask();
      clock = at("2026-10-04", 9);
      study("kb", "normal"); // 10月4日: Study のノーミス（streak 0 → 1）
      study("kp", "normal");
      await nextTask();
      const kb = read().kb;
      const today = "2026-10-04";
      eq("打ち間違いありの正解のあと別の日のノーミス: streak 1・知ってたのまま・段 3", [kb.cleanCorrectStreak, kb.knownOnSight, kb.recallFail, kb.masteryRank], [1, true, 0, 3]);
      eq("その語はもう確認待ちでない（knownCheck 偽・isKnownWaiting 偽）", [answerContext(kb, clock + 3600 * 1000).knownCheck, isKnownWaiting(kb)], [false, false]);
      ok(`根拠の文に「初めて答えて」が無い（${rankBasis(kb, today)}）`, !rankBasis(kb, today).includes("初めて答えて"));
      ok(`次の条件に「の確認で」が無い（${rankNext(kb, today)}）`, !rankNext(kb, today).includes("の確認で"));
      // 確認待ちでなくても、× が一度も無い知ってた語は期日（翌日）までは補充・息抜きに出さない（PR #161 のレビュー 2。streak によらない）
      eq("確認待ちでない知ってた語も、× が無ければ期日（翌日）の前は補充・息抜きに出さない（段 3）", holdBeforeDue(kb, clock + 3600 * 1000), true);
      clock = at("2026-10-18", 10); // 14 日あけて、すぐ打てる
      study("kb", "fast");
      study("kp", "fast");
      await nextTask();
      eq("14 日あけてすぐ打っても 3 → 4（5 に飛ばない。打ち間違いの無い同じ流れも 4）", [read().kb.masteryRank, read().kp.masteryRank], [4, 4]);
    } finally {
      globalThis.Date = RealDate;
    }
  }

  // ── 段階 2（S1〜S5）: 偽の時計で書き手を何日も回す。毎日 12:00 に、期日が来ている語（isReviewDue と同じ「期日 ≤ 今」）にだけ答える人 ──
  {
    const RealDate = Date;
    let clock = 0;
    class FakeDate extends RealDate {
      constructor(...a) {
        if (a.length === 0) super(clock);
        else super(...a);
      }
      static now() {
        return clock;
      }
    }
    const D0 = "2026-01-05";
    const dayAt = (n, h = 12, m = 0) => {
      const d = new RealDate(at(D0, h, m));
      d.setDate(d.getDate() + n);
      return d.getTime();
    };
    const dayOfDue = (st) => dayDiff(D0, localDay(new RealDate(Date.parse(st.nextReviewAt))));
    const fresh = () => base({ playCount: 1, correctCount: 0, cleanCorrectStreak: 0, lastPlayed: null });
    const answer = (id, how) => {
      if (how === "x") {
        recordRecallFail(id); // 答え表示（×）
        recordCorrect(id, false); // 答えを見て打ち直す（答えに数えない。期日は翌日）
      } else if (how === "typo") {
        recordCorrect(id, false); // Battle の打ち間違いありの正解（引数なし）
        recordRecallSuccess(id);
      } else study(id, how);
    };
    // from 日の翌日から last 日まで、期日が来た日にだけ答える。plan(day) → 答え方（"fast" | "normal" | "slow" | "x" | "typo"）。答えた日・段・次の期日の日を返す
    const follow = async (id, from, last, plan = () => "normal") => {
      const log = [];
      for (let d = from + 1; d <= last; d++) {
        clock = dayAt(d);
        if (!(Date.parse(read()[id].nextReviewAt) <= clock)) continue;
        const how = plan(d);
        if (how === "x") clock = dayAt(d, 11); // × の日は 11:00 に × → 11:10 に Recall Loop（翌日 12:00 には期日が来ている）
        answer(id, how);
        await nextTask();
        if (how === "x") {
          clock = dayAt(d, 11, 10); // Recall Loop: 同じ回の後で、自力で打てる
          study(id, "normal");
          await nextTask();
        }
        const st = read()[id];
        log.push({ d, rank: st.masteryRank, next: dayOfDue(st), streak: st.cleanCorrectStreak });
      }
      return log;
    };
    globalThis.Date = FakeDate;
    try {
      // apple: 初見でノーミス・すぐ（既定の線）→ 身についた・14 日後。14 日目にすぐ（本人の基準）→ 即答・30 日後。あとは 30 日ごと
      clock = dayAt(0);
      seed({ apple: fresh(), apple3: fresh(), apple4: fresh(), early: fresh(), slip: fresh(), kt: fresh() });
      await nextTask();
      for (const id of ["apple", "apple3", "early", "slip", "kt"]) study(id, "fast");
      study("apple4", "normal"); // 初見でふつうの速さ → 思い出せる
      await nextTask();
      eq("apple 0 日目: 知ってた・身についた・14 日後（初見に S2 は当てない）", [read().apple.knownOnSight, read().apple.masteryRank, dayOfDue(read().apple)], [true, 4, 14]);
      const apple = await follow("apple", 0, 106, (d) => (d === 14 ? "fast" : "normal"));
      eq("apple の道: 106 日までに出るのは 0・14・44・74・104 日の 5 回", [0, ...apple.map((e) => e.d)], [0, 14, 44, 74, 104]);
      eq("apple の道: 14 日目から即答のまま、次はいつも 30 日後", apple.map((e) => [e.rank, e.next - e.d]), [[5, 30], [5, 30], [5, 30], [5, 30]]);
      const apple4 = await follow("apple4", 0, 106, (d) => (d === 14 ? "fast" : "normal"));
      eq("0 日目の速さによらない（初見で 思い出せる → 14 日目にすぐで即答。同じ 5 回）", [read().apple4.masteryRank, 0, ...apple4.map((e) => e.d)], [5, 0, 14, 44, 74, 104]);
      const apple3 = await follow("apple3", 0, 100, (d) => (d === 35 ? "fast" : "normal"));
      eq("14 日目がふつうの速さ → 身についた・21 日後（S2）、35 日目にすぐで即答・30 日後: 0・14・35・65・95 日", [0, ...apple3.map((e) => e.d)], [0, 14, 35, 65, 95]);
      eq("14 日目がふつう → 4・21 日後、35 日目 → 5・30 日後", apple3.slice(0, 2).map((e) => [e.rank, e.next - e.d]), [[4, 21], [5, 30]]);

      // S1: 1〜13 日に Challenge などで答えても期日は早まらない（streak は進む。確認待ちではなくなる）
      clock = dayAt(5);
      const dueBefore = read().early.nextReviewAt;
      study("early", "normal");
      await nextTask();
      eq("S1: 5 日目に正解しても 14 日目の期日のまま（同じ文字列）・streak 2・段 4 のまま", [read().early.nextReviewAt === dueBefore, read().early.cleanCorrectStreak, read().early.masteryRank, isKnownWaiting(read().early)], [true, 2, 4, false]);
      // S1 の例外: 打ち間違いありの正解（Battle）は今のまま期日を翌日に
      clock = dayAt(6);
      answer("early", "typo");
      await nextTask();
      eq("S1 の例外: 期日が先でも、打ち間違いありの正解は期日を翌日に（今のまま）", [dayOfDue(read().early), read().early.cleanCorrectStreak], [7, 0]);

      // 即答の語が 44 日目に 1 打ミス（appel）: 身についた → 翌日から 7・10・14・21 日（S2・S3）→ 97 日目にすぐで即答・30 日後
      const slipLog = await follow("slip", 0, 130, (d) => (d === 14 || d === 97 ? "fast" : d === 44 ? "x" : "normal"));
      eq("即答の語の 44 日目の appel: 答える日は 0・14・44・45・52・62・76・97・127", [0, ...slipLog.map((e) => e.d)], [0, 14, 44, 45, 52, 62, 76, 97, 127]);
      eq("44 日目に 即答 → 身についた（Recall Loop は同じ日なので動かない）、97 日目にすぐで 即答", slipLog.map((e) => e.rank), [5, 4, 4, 4, 4, 4, 5, 5]);
      eq("44 日目の翌日は 1 日後、45 日目から 7・10・14・21 日後、97 日目から 30 日後", slipLog.slice(1).map((e) => e.next - e.d), [1, 7, 10, 14, 21, 30, 30]);

      // 知ってた語 → 即答 → 打ち間違いありの正解（streak 0）→ 10 日あけたノーミス（streak 1）: 伸ばさない（確認待ちと読み違えない）→ 翌日から 30 日
      clock = dayAt(14);
      study("kt", "fast");
      await nextTask();
      clock = dayAt(20);
      answer("kt", "typo");
      await nextTask();
      clock = dayAt(30);
      study("kt", "normal");
      await nextTask();
      const kt30 = read().kt;
      eq("知ってた語が打ち間違いの後に streak 1 に戻る答えは伸ばさない（翌日）・確認待ちと読まない・段 5 のまま", [kt30.cleanCorrectStreak, dayOfDue(kt30) - 30, isKnownWaiting(kt30), kt30.masteryRank], [1, 1, false, 5]);
      clock = dayAt(31);
      study("kt", "normal");
      await nextTask();
      // M1'（Batch 70）: gap 1 の即答の答えには 30 日をかけない（身についたの 7 日）
      eq("その翌日（streak 2・gap 1）は即答のまま 7 日後（M1'。前は 30 日）", [dayOfDue(read().kt) - 31, isKnownWaiting(read().kt), read().kt.masteryRank], [7, false, 5]);

      // appel（初見で 1 打ミス）の後の道: 予定どおり来る人の期日は今と同じ（どの答えでも「今日 + streak の間隔」）
      clock = dayAt(0, 9);
      seed({ appel: fresh(), late: fresh() });
      await nextTask();
      for (const id of ["appel", "late"]) {
        answer(id, "x");
        await nextTask();
        clock = dayAt(0, 9, 10);
        study(id, "normal"); // Recall Loop で打てる
        await nextTask();
        clock = dayAt(0, 9);
      }
      eq("appel 0 日目: まだ → Recall Loop で あやふや・翌日", [read().appel.masteryRank, dayOfDue(read().appel), read().appel.cleanCorrectStreak], [2, 1, 1]);
      const appel = await follow("appel", 0, 100, (d) => (d === 63 ? "fast" : "normal"));
      eq("appel の後の道: 1・3・6・11・18・28・42・63・93 日（間隔 1→2→3→5→7→10→14→21→30。今と同じ）", appel.map((e) => e.d), [1, 3, 6, 11, 18, 28, 42, 63, 93]);
      eq("appel の後の道: どの答えでも次の期日は「今日 + streak の間隔」（今の SRS と同じ）", appel.every((e) => e.next - e.d === SRS_STEPS[Math.min(e.streak, SRS_STEPS.length) - 1]), true);
      eq("appel の後の道の段: 翌日に 思い出せる、18 日目（gap 7）に 身についた、63 日目（gap 21・すぐ）に 即答", appel.map((e) => e.rank), [3, 3, 3, 3, 4, 4, 4, 5, 5]);
      eq("appel の後の道: 93 日目に習得（streak 10。今と同じ）", [read().appel.cleanCorrectStreak, read().appel.mastered], [10, true]);
      // 遅れて戻った人の語は伸びる（今は streak の間隔のまま）
      const lateBack = [];
      clock = dayAt(1);
      study("late", "normal"); // 1 日目は予定どおり（期日は 3 日目）
      await nextTask();
      clock = dayAt(40); // 37 日あけて戻る
      study("late", "normal");
      await nextTask();
      lateBack.push(read().late.cleanCorrectStreak, dayOfDue(read().late) - 40, read().late.masteryRank);
      eq("遅れて戻った語（37 日あけた正解）: streak 3 の 3 日ではなく 30 日後（S2）・段 4", lateBack, [3, 30, 4]);

      // 回の始まりより後の Recall Loop（12:00 の × → 12:10 に打てる）→ 毎日 12:00 に始める人: 期日（12:10）はまだ来ていないので翌日に回る
      // （1 日遅れ。gap ＝ 間隔 + 1）。答える日も保持率の 7 日窓も今と同じ（gap 6 未満は credit なし。表を飛ばさない）。
      // Challenge・Daily の ×（Recall Loop が無い）の後も今と同じ 1・2・4・7 日。毎日違う時刻に学ぶ人も同じ（値は今の書き手で回した結果）
      clock = dayAt(0);
      seed({ lp: fresh(), cx: fresh(), jt: fresh() });
      await nextTask();
      for (const id of ["lp", "cx", "jt"]) answer(id, "x");
      await nextTask();
      clock = dayAt(0, 12, 10);
      study("lp", "normal");
      await nextTask();
      const route = { lp: [0], cx: [0], jt: [0] };
      for (let d = 1; d <= 50; d++) {
        for (const id of ["lp", "cx", "jt"]) {
          clock = id === "jt" ? dayAt(d, 7 + ((d * 7) % 16), (d * 13) % 60) : dayAt(d);
          if (!(Date.parse(read()[id].nextReviewAt) <= clock)) continue;
          study(id, "normal");
          await nextTask();
          route[id].push(d);
        }
      }
      const ret = JSON.parse(store.get("spelldash_retention") || "{}");
      const w7day = (id) => (ret[id]?.w7 ? [dayDiff(D0, ret[id].w7.t), ret[id].w7.r] : null);
      eq("12:10 の Recall Loop・毎日 12:00 に学ぶ人: 0・2・4・7・12・19・29・43 日（今と同じ。1 日遅れで表を飛ばさない）", route.lp, [0, 2, 4, 7, 12, 19, 29, 43]);
      eq("その語の保持率の 7 日窓は 7 日目に測る（今と同じ）", w7day("lp"), [7, "o"]);
      eq("Recall Loop の無い ×（Challenge・Daily）の後: 1・2・4・7・12・19・29・43 日（間隔 1→2→3→5→7→10→14。今と同じ）", route.cx, [0, 1, 2, 4, 7, 12, 19, 29, 43]);
      eq("その語の 7 日窓（初めての自力正解は 1 日目）は 7 日目に測る（今と同じ）", w7day("cx"), [7, "o"]);
      eq("毎日 7〜23 時のどこかで学ぶ人（Recall Loop の無い ×）: 1・2・5・8・13・20・31・45 日・7 日窓は 8 日目（今と同じ）", [route.jt, w7day("jt")], [[0, 1, 2, 5, 8, 13, 20, 31, 45], [8, "o"]]);

      // 2 台目で × → Recall Loop（同期で解決済み）→ この端末で翌日ノーミス: 段 5 のまま読めても、S3 の下限は 1 段下（身についた の 7 日）
      const yFail = new Date(dayAt(-1)).toISOString();
      const yLoop = new Date(dayAt(-1, 12, 10)).toISOString();
      const old30 = new Date(dayAt(-30)).toISOString();
      const fromB = (over = {}) =>
        base({ masteryRank: 5, masteryAt: old30, recallFail: 1, missCount: 1, cleanCorrectStreak: 1, srsAdvancedOn: localDay(new Date(dayAt(-1))), lastRecallFailAt: yFail, lastRecallSuccessAt: yLoop, nextReviewAt: new Date(dayAt(0, 12, 10)).toISOString(), history: [{ d: localDay(new Date(dayAt(-30))), r: "o" }], ...over });
      clock = dayAt(0, 13);
      seed({ dv: fromB(), dvx: fromB({ lastRecallSuccessAt: old30, cleanCorrectStreak: 0, nextReviewAt: yFail }), dv4: fromB({ masteryRank: 4 }) });
      await nextTask();
      eq("2 台目の × → Recall Loop の語は rankOf では段 5 のまま（解決済み。段階 1 の読み方）", rankOf(read().dv), 5);
      for (const id of ["dv", "dvx", "dv4"]) study(id, "normal");
      await nextTask();
      const dueIn = (id) => Math.round((Date.parse(read()[id].nextReviewAt) - clock) / DAY);
      eq("2 台目の × → Loop の翌日、この端末でノーミス: 段 5 の語は 7 日後（30 日にしない。同じ端末の × の後と同じ）", [dueIn("dv"), read().dv.cleanCorrectStreak], [7, 2]);
      eq("2 台目の × のまま（未解決）の翌日: rankOf が 1 段下げて 身についた・7 日後", [read().dvx.masteryRank, dueIn("dvx")], [4, 7]);
      eq("段 4 の語なら下限は段 3（無し）→ streak の間隔 2 日（同じ端末の × の後と同じ）", dueIn("dv4"), 2);
      clock = dayAt(7, 13);
      study("dv", "normal");
      await nextTask();
      // M1'（Batch 70）: gap 7 の即答の答えには 30 日をかけない（gap 7 の credit 10 日。前は 30 日）
      eq("その次の答え（masteryAt が揃い、見ていない × は無い・gap 7）は即答の下限 30 日でなく credit の 10 日（M1'）", dueIn("dv"), 10);

      // slow: 即答の語が遅い正解 → 身についた、credit も下限も無し（streak の間隔）
      clock = dayAt(0);
      seed({ sw: base({ masteryRank: 5, masteryAt: new Date(dayAt(-30)).toISOString(), lastRecallSuccessAt: new Date(dayAt(-30)).toISOString(), cleanCorrectStreak: 3, srsAdvancedOn: "2000-01-01", nextReviewAt: new Date(dayAt(-1)).toISOString() }) });
      await nextTask();
      study("sw", "slow");
      await nextTask();
      eq("即答の語の遅い正解（gap 30）: 身についた・streak 4 の 5 日後のまま（S2・S3 は当てない）", [read().sw.masteryRank, dayOfDue(read().sw)], [4, 5]);

      // 同じ日の扱い（23:50 の × → 00:03 の ○）: その日の最初の答えではないので伸ばさない
      clock = dayAt(0, 23, 50);
      seed({ nt: base({ masteryRank: 4, masteryAt: new Date(dayAt(-10)).toISOString(), lastRecallSuccessAt: new Date(dayAt(-10)).toISOString(), cleanCorrectStreak: 5, srsAdvancedOn: "2000-01-01", nextReviewAt: new Date(dayAt(-1)).toISOString() }) });
      await nextTask();
      answer("nt", "x");
      await nextTask();
      clock = dayAt(1, 0, 3);
      study("nt", "normal");
      await nextTask();
      eq("23:50 の × → 00:03 の ○ は同じ日の扱い: 段 3 のまま・期日は streak 1 の翌日（下限 7 日は当てない）", [read().nt.masteryRank, read().nt.cleanCorrectStreak, Math.round((Date.parse(read().nt.nextReviewAt) - clock) / DAY)], [3, 1, 1]);
      clock = dayAt(2);
      study("nt", "normal");
      await nextTask();
      eq("その翌日（gap 1。段 3）→ 段 3・2 日後（S2 の credit 2。段 3 に下限は無い）", [read().nt.masteryRank, dayOfDue(read().nt) - 2], [3, 2]);
    } finally {
      globalThis.Date = RealDate;
      store.delete("spelldash_mastery_meta"); // この筋書きの確かめの集計（10 答えごとに保存された分）を次の節へ持ち越さない
      forgetMasteryMeta();
    }
  }

  // 10 答えごとに 1 回だけ保存（変わっていれば）
  seed(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, base({ masteryRank: 2, masteryAt: ago(2), lastRecallSuccessAt: ago(2), cleanCorrectStreak: 1 })])));
  await nextTask();
  writes.clear();
  for (let i = 0; i < 9; i++) study(`t${i}`);
  await nextTask();
  eq("9 答えでは mastery_meta を書かない", writesOf("spelldash_mastery_meta"), 0);
  study("t9");
  await nextTask();
  eq("10 答え目で 1 回書く", writesOf("spelldash_mastery_meta"), 1);
  eq("その 10 答えの確かめ（段 2 × 帯 2-5 で 10 件）", JSON.parse(store.get("spelldash_mastery_meta")).check.rank, { 2: { "2-5": [10, 0] } });
  ok("段の欄は端末だけ: 同期の行を作る js/sync.js は mastery の欄を読まない（送る行は 15 列のまま）", Object.keys(read().t0).includes("masteryRank") && !readFileSync(new URL("../js/sync.js", import.meta.url), "utf8").includes("mastery"));
  console.warn = quiet;
}

// ── 16. PR #159 のレビュー対応（1〜5）: 別解の道の後の初見・2 台目の確認待ち・物理キーの判定・2 つのタブの mastery_meta・同じ日の × の後の ○ ──
// 書き手は §15 と同じ js/stats.js（同じモジュール）。偽の時計で日をまたぐ。2 つのタブは js/masteryMeta.js を別のモジュールとして 2 回読む（localStorage は共有）
{
  const W = await import("../js/stats.js");
  const MM = await import("../js/masteryMeta.js");
  const DAY = 86400000;
  const RealDate = Date;
  let clock = at("2026-10-01", 9);
  class FakeDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(clock);
      else super(...a);
    }
    static now() {
      return clock;
    }
  }
  const blank = (over = {}) => ({ playCount: 1, correctCount: 0, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 0, mastered: false, masteredAt: null, lastPlayed: null, nextReviewAt: null, lastRecallFailAt: null, lastRecallSuccessAt: null, dailyLearningDate: null, dailyLearningStage: 0, srsAdvancedOn: null, ...over });
  const seed = (map) => {
    store.set("spelldash_word_stats", JSON.stringify(map));
    forgetMasteryMeta();
  };
  const read = () => JSON.parse(store.get("spelldash_word_stats"));
  const nextTask = () => new Promise((r) => setTimeout(r, 0));
  const study = (id, speed = "normal") => {
    W.recordCorrect(id, true);
    W.recordRecallSuccess(id, { clean: true, speed });
  };
  const daysTo = (isoStr) => Math.round((RealDate.parse(isoStr) - clock) / DAY);
  const quiet = console.warn;
  console.warn = () => {};

  // ---- 1. 別解を打って答えを見た語（acceptAlternative が答えを見せ、× を記録せず、打ち直しで recordCorrect(id, false)）は、翌日のノーミスでも知ってたにしない ----
  eq("PR159-1: 答えの綴りを見た語（correctCount 1・答えの日時なし）は初見でない", isFirstAnswer(blank({ correctCount: 1 })), false);
  eq("PR159-1: 答えを見た印（answerSeenAt）だけの語も初見でない", isFirstAnswer(blank({ answerSeenAt: iso("2026-10-01") })), false);
  eq("PR159-1: 出題だけされて答えなかった語（correctCount 0・印なし）は今どおり初見", isFirstAnswer(blank({ playCount: 3 })), true);
  const cAlt = answerContext(blank({ correctCount: 1 }), at("2026-10-02", 12));
  eq("PR159-1: その語の answerContext は初めての答えでない（段 0・前の答えの日なし）", [cAlt.firstAnswer, cAlt.rank, cAlt.prevDay], [false, 0, null]);
  eq("PR159-1: 段は初めての答えの枝を通らない（ノーミス・すぐでも 4 にせず 2、× は 1）", [nextRank(0, okA("fast"), cAlt), nextRank(0, NG, cAlt)], [2, 1]);
  globalThis.Date = FakeDate;
  try {
    clock = at("2026-10-01", 9);
    seed({ alt: blank(), seen: blank(), plain: blank({ playCount: 2 }), done: blank({ correctCount: 3, lastRecallSuccessAt: iso("2026-09-20"), cleanCorrectStreak: 2 }) });
    await nextTask();
    W.recordCorrect("alt", false); // 別解を打った後、見せた出題語を打ち直す（答えに数えない）
    const seenFn = typeof W.recordAnswerSeen === "function" ? W.recordAnswerSeen : null;
    seenFn?.("seen"); // 別解を打って答えを見たが、打ち直す前に時間切れ・離れた
    seenFn?.("done"); // 答えの記録がある語には印を書かない（初見でないので要らない）
    await nextTask();
    eq("PR159-1: 別解の打ち直しは答えに数えない（日時なし・段なし・correctCount 1）", [read().alt.lastRecallSuccessAt, read().alt.masteryRank, read().alt.correctCount], [null, undefined, 1]);
    eq("PR159-1: recordAnswerSeen は初見の語にだけ印を書く（答えの記録がある語には書かない）", [typeof read().seen.answerSeenAt, read().done.answerSeenAt], ["string", undefined]);
    clock = at("2026-10-02", 12);
    for (const id of ["alt", "seen", "plain"]) study(id, "fast");
    await nextTask();
    const r = read();
    eq("PR159-1: 別解の道の翌日のノーミス・すぐ: 知ってたにならない・段 2（初めての答えの枝を通らない）・期日は翌日（streak 1）", [r.alt.knownOnSight === true, r.alt.masteryRank, r.alt.cleanCorrectStreak, daysTo(r.alt.nextReviewAt)], [false, 2, 1, 1]);
    eq("PR159-1: 答えを見て打ち直さなかった語（印あり）も同じ（知ってたにならない・段 2）", [r.seen.knownOnSight === true, r.seen.masteryRank], [false, 2]);
    eq("PR159-1: 出題だけの語は今どおり知ってた・段 4・14 日後", [r.plain.knownOnSight, r.plain.masteryRank, daysTo(r.plain.nextReviewAt)], [true, 4, 14]);

    // ---- 2. 2 台目: knownOnSight（端末だけの欄）が届かない写しでも、同期する欄だけで確認待ちと読む ----
    clock = at("2026-10-01", 9);
    seed({ k1: blank() });
    await nextTask();
    study("k1", "fast"); // 初見のノーミス・すぐ → 知ってた・段 4・14 日後
    await nextTask();
    const dev1 = read().k1;
    // 2 台目の写し（js/sync.js rowToStat は同期する 15 列だけを写す。knownOnSight・段の欄・history は届かない）
    const { knownOnSight: _k, masteryRank: _r, masteryAt: _a, history: _h, ...dev2 } = dev1;
    clock = at("2026-10-05", 9);
    eq("PR159-2: 2 台目の写しでも確認待ち（isKnownWord・isKnownWaiting・holdBeforeDue が真、initialRank・rankOf が 3）", [isKnownWord(dev2), isKnownWaiting(dev2), holdBeforeDue(dev2, clock), initialRank(dev2), rankOf(dev2)], [true, true, true, 3, 3]);
    eq("PR159-2: 2 台目の 14 日後の答えは知ってた語の最初の確認（knownCheck）", answerContext(dev2, at("2026-10-15", 9)).knownCheck, true);
    clock = at("2026-10-15", 9);
    seed({ k1: dev2 });
    await nextTask();
    study("k1", "fast");
    await nextTask();
    eq("PR159-2: 2 台目でも 14 日後の確認ですぐ → 即答・30 日後（1 台目と同じ）", [read().k1.masteryRank, daysTo(read().k1.nextReviewAt)], [5, 30]);
    // 知ってたでない語は確認待ちの形（streak 1・recallFail 0・期日が最後の自力正解から 13 日以上先）にしない:
    // 初めての答えが打ち間違いありの正解（Battle）→ 13 日あけたノーミス（streak 0 → 1・recallFail 0）は伸ばさない
    clock = at("2026-10-01", 9);
    seed({ bt: blank() });
    await nextTask();
    W.recordCorrect("bt", false);
    W.recordRecallSuccess("bt");
    await nextTask();
    clock = at("2026-10-14", 9);
    study("bt", "normal");
    await nextTask();
    const bt = read().bt;
    eq("PR159-2: 打ち間違いありの正解の後に streak 1・recallFail 0 になる答えは伸ばさない（翌日）・知ってた／確認待ちと読まない・補充から外さない", [bt.cleanCorrectStreak, bt.recallFail, daysTo(bt.nextReviewAt), isKnownWord(bt), isKnownWaiting(bt), holdBeforeDue(bt, clock + 3600000)], [1, 0, 1, false, false, false]);

    // ---- 5. その日の × で段が下がった語は、同じ日の ○（Recall Loop）で上げない。新しい語の × → ○ は今どおり 2 ----
    clock = at("2026-10-12", 8);
    seed({
      dn: blank({ masteryRank: 2, masteryAt: iso("2026-10-09", 8), lastRecallSuccessAt: iso("2026-10-09", 8), cleanCorrectStreak: 1, correctCount: 1, srsAdvancedOn: "2026-10-09", nextReviewAt: iso("2026-10-10", 8) }),
      nw: blank(),
      r1: blank({ masteryRank: 1, masteryAt: iso("2026-10-11", 8), lastRecallFailAt: iso("2026-10-11", 8), recallFail: 1, missCount: 1, nextReviewAt: iso("2026-10-11", 8) })
    });
    await nextTask();
    for (const id of ["dn", "nw", "r1"]) {
      W.recordRecallFail(id); // 08:00 答え表示（×）
      W.recordCorrect(id, false); // 答えを見て打ち直す（答えに数えない）
      await nextTask();
    }
    const am = read();
    eq("PR159-5: 段 2 の語の朝の × → 1（段を下げた答えの日時を masteryDownAt に）、新しい語の × → 1・段 1 の語の × → 1（下げていないので印なし）", [am.dn.masteryRank, am.dn.masteryDownAt === am.dn.lastRecallFailAt, am.nw.masteryRank, am.nw.masteryDownAt, am.r1.masteryRank, am.r1.masteryDownAt], [1, true, 1, undefined, 1, undefined]);
    // 語の詳細の次の条件（rankNext）: 今日の × で下げた語は今日の ○ では上がらないので、前の答えの日＋1 日を言う（打ち直す前の未解決の間も）。
    // 下げていない語（新しい語の × → 1・前の日から 1 の語の × → 1）は今日の ○ で上がるので日付なし（今どおり）
    eq("PR159-5: 朝 × で下げた語の次の条件は「10月13日以降に 自力で思い出せると あやふや」（今日の ○ では上がらない）", rankNext(am.dn, "2026-10-12"), "10月13日以降に 自力で思い出せると あやふや");
    eq("PR159-5: 下げていない段 1 の語（新しい語・前の日から 1 の語）の次の条件は今どおり日付なし", [rankNext(am.nw, "2026-10-12"), rankNext(am.r1, "2026-10-12")], ["自力で思い出せると あやふや", "自力で思い出せると あやふや"]);
    clock = at("2026-10-12", 18);
    for (const id of ["dn", "nw", "r1"]) study(id, "normal"); // 夕方 Recall Loop で自力で打てる
    await nextTask();
    const pm = read();
    eq("PR159-5: 段 2 の語の朝 × → 夕方 ○ は 1 のまま（思い出せなかった日は 1 段下がる）", pm.dn.masteryRank, 1);
    eq("PR159-5: 新しい語の × → ○ は今どおり 2・昨日の × の段 1 の語の今日の × → ○ も今どおり 2", [pm.nw.masteryRank, pm.r1.masteryRank], [2, 2]);
    eq("PR159-5: 期日・streak は今と同じ（同じ日の ○ は伸ばさない: streak 1・翌日）", [pm.dn.cleanCorrectStreak, daysTo(pm.dn.nextReviewAt), pm.nw.cleanCorrectStreak, daysTo(pm.nw.nextReviewAt)], [1, 1, 1, 1]);
    eq("PR159-5: 書いた直後も rankOf === masteryRank", ["dn", "nw", "r1"].every((id) => rankOf(pm[id]) === pm[id].masteryRank), true);
    eq("PR159-5: 朝 × → 夕方 ○ の後も次の条件は「10月13日以降に」（今日もう一度思い出せても上がらない）・根拠は「10月12日に思い出せた」", [rankNext(pm.dn, "2026-10-12"), rankBasis(pm.dn, "2026-10-12")], ["10月13日以降に 自力で思い出せると あやふや", "10月12日に思い出せた"]);
    eq("PR159-5: その語の翌日の次の条件は日付なし（翌日の ○ で上がる）", rankNext(pm.dn, "2026-10-13", at("2026-10-13", 9)), "自力で思い出せると あやふや");
    // 文の約束を書き手で確かめる: 今日のもう一度の ○ では上がらない（文のとおり）
    {
      const c = answerContext(pm.dn, at("2026-10-12", 21));
      eq("PR159-5: 次の条件の文のとおり、今日（21:00）もう一度の ○ では上がらない", [c.downToday, nextRank(c.rank, okA(), c)], [true, 1]);
    }
    clock = at("2026-10-13", 19);
    study("dn", "normal");
    await nextTask();
    eq("PR159-5: 翌日のノーミス（gap 1）で 1 → 2（翌日以降の規則で上がる）・期日は streak 2 の 2 日後", [read().dn.masteryRank, daysTo(read().dn.nextReviewAt)], [2, 2]);
    const cDown = answerContext({ masteryRank: 1, masteryAt: iso("2026-10-12", 8), masteryDownAt: iso("2026-10-12", 8), lastRecallFailAt: iso("2026-10-12", 8), lastRecallSuccessAt: iso("2026-10-09", 8), recallFail: 1 }, at("2026-10-12", 18));
    eq("PR159-5: answerContext の downToday（今日 × で下げた）→ nextRank は同じ日の ○ で 1 のまま", [cDown.downToday, nextRank(1, okA(), cDown)], [true, 1]);
    const cDown6 = answerContext({ masteryRank: 1, masteryAt: iso("2026-10-11", 23, 50), masteryDownAt: iso("2026-10-11", 23, 50), lastRecallFailAt: iso("2026-10-11", 23, 50), recallFail: 1 }, at("2026-10-12", 0, 3));
    eq("PR159-5: 23:50 に下げて 00:03 の ○（6 時間未満は同じ日の扱い）も 1 のまま", [cDown6.downToday, nextRank(1, okA(), cDown6)], [true, 1]);
    eq("PR159-5: 前の日に下げた語の今日の最初の ○（gap 1）は今どおり 2", nextRank(1, okA(), answerContext({ masteryRank: 1, masteryAt: iso("2026-10-11", 8), masteryDownAt: iso("2026-10-11", 8), lastRecallFailAt: iso("2026-10-11", 8), recallFail: 1 }, at("2026-10-12", 18))), 2);
  } finally {
    globalThis.Date = RealDate;
  }

  // ---- 3. 入力の経路: 物理キーとみなすのは、信頼された keydown で code が物理キーの名前のときだけ（iPhone・Android の画面キーボードは code が空・Unidentified・keyCode 229） ----
  const kin = typeof MM.keyInputOf === "function" ? MM.keyInputOf : () => "missing";
  eq(
    "PR159-3: 物理キー（信頼された keydown・code が KeyA／Digit1／Minus／Space／Numpad1）→ kbd",
    [kin({ isTrusted: true, key: "a", code: "KeyA", keyCode: 65 }), kin({ isTrusted: true, key: "1", code: "Digit1", keyCode: 49 }), kin({ isTrusted: true, key: "-", code: "Minus", keyCode: 189 }), kin({ isTrusted: true, key: " ", code: "Space", keyCode: 32 }), kin({ isTrusted: true, key: "1", code: "Numpad1", keyCode: 97 })],
    ["kbd", "kbd", "kbd", "kbd", "kbd"]
  );
  eq(
    "PR159-3: 画面のキーボード（信頼された keydown でも code が空・Unidentified・無い）→ touch（code のある keyCode 229 は IME オンの物理キー: §17 の PR161-1）",
    [kin({ isTrusted: true, key: "a", code: "", keyCode: 65 }), kin({ isTrusted: true, key: "Unidentified", code: "Unidentified", keyCode: 229 }), kin({ isTrusted: true, key: "a", keyCode: 65 })],
    ["touch", "touch", "touch"]
  );
  eq("PR159-3: 専用の画面キーボード（#osk の合成 keydown。isTrusted 偽）は今どおり touch", kin({ isTrusted: false, key: "a", code: "KeyA", keyCode: 65 }), "touch");

  // ---- 4. 2 つのタブ: flush の直前に保存を読み直し、このタブで足した分（見本・集計の増分）だけを足して書く ----
  {
    const KEY = "spelldash_mastery_meta";
    const BOX = "en.kbd.study";
    store.delete(KEY);
    const A = await import("../js/masteryMeta.js?tab=a");
    const B = await import("../js/masteryMeta.js?tab=b");
    A.forgetMasteryMeta();
    B.forgetMasteryMeta();
    const stored = () => JSON.parse(store.get(KEY) || "null");
    A.noteSpeedSample(BOX, { t1: 1000, pc: 100 }); // どちらのタブも空の保存を読んだ後で足す
    B.noteSpeedSample(BOX, { t1: 2000, pc: 200 });
    A.noteRankCheck({ id: "a1", rankBefore: 3, gap: 2, ok: true });
    B.noteRankCheck({ id: "b1", rankBefore: 3, gap: 2, ok: false });
    A.notePendingFirstFast("pa", "prior");
    B.notePendingFirstFast("pb", "own");
    A.flushMasteryMeta();
    B.flushMasteryMeta();
    let s1 = stored();
    eq("PR159-4: 2 つのタブが交互に書いても両方の見本が残る（A 1000・B 2000）", [s1?.speed?.[BOX]?.t1, s1?.speed?.[BOX]?.pc], [[1000, 2000], [100, 200]]);
    eq("PR159-4: 集計は足し算（段 3 × 帯 2-5 で ○ 1・× 1）・控えの語も両方", [s1?.check?.rank?.["3"]?.["2-5"], Object.keys(s1?.check?.pending ?? {})], [[1, 1], ["pa", "pb"]]);
    B.noteSpeedSample(BOX, { t1: 3000, pc: 300 });
    B.flushMasteryMeta();
    A.noteSpeedSample(BOX, { t1: 4000, pc: 400 });
    A.noteRankCheck({ id: "a2", rankBefore: 3, gap: 3, ok: true });
    A.flushMasteryMeta();
    s1 = stored();
    eq("PR159-4: もう 1 巡（B → A）でも 4 件とも残り、集計は ○ 2・× 1", [s1?.speed?.[BOX]?.t1, s1?.check?.rank?.["3"]?.["2-5"]], [[1000, 2000, 3000, 4000], [2, 1]]);
    eq("PR159-4: 書いた後のメモリーは保存と同じ（A の基準にも B の見本が入る）", A.getSpeedBox(BOX).t1, [1000, 2000, 3000, 4000]);
    // B の控えの語（pb）を A が数える（A は書いたときに読み直したので pb を知っている）→ 保存からも消える
    A.noteRankCheck({ id: "pb", rankBefore: 4, gap: 1, ok: true });
    A.flushMasteryMeta();
    s1 = stored();
    eq("PR159-4: もう一方のタブの控えの語を数えると firstFast に足して控えから消す（A の控え pa は残る）", [s1?.check?.firstFast?.own, Object.keys(s1?.check?.pending ?? {})], [[1, 0], ["pa"]]);
    // 見本は各箱の最新 40 件: A が 30 件・B が 30 件を足して A → B の順に書くと、A の後ろ 10 件と B の 30 件
    store.delete(KEY);
    A.forgetMasteryMeta();
    B.forgetMasteryMeta();
    for (let i = 0; i < 30; i++) A.noteSpeedSample(BOX, { t1: 1000 + i, pc: null });
    for (let i = 0; i < 30; i++) B.noteSpeedSample(BOX, { t1: 5000 + i, pc: null });
    A.flushMasteryMeta();
    B.flushMasteryMeta();
    const t40 = stored()?.speed?.[BOX]?.t1 ?? [];
    eq("PR159-4: 見本は箱ごとに最新 40 件（A の後ろ 10 件 → B の 30 件）・最初の中央値は先に書いた A が 20 件で決めた値のまま", [t40.length, t40[0], t40.at(-1), stored()?.check?.firstMedian?.[BOX]], [40, 1020, 5029, 1009.5]);
    eq("PR159-4: 変わっていなければ書かない", [A.flushMasteryMeta(), B.flushMasteryMeta()], [false, false]);
    store.delete(KEY);
    A.forgetMasteryMeta();
    B.forgetMasteryMeta();
  }
  console.warn = quiet;
}

// ── 17. PR #161 のレビュー対応（1〜4）: IME オンの物理キー・14 日の確認の前に正解した知ってた語・別のタブの消去／復元の後の基準・
// 6 時間の窓をまたぐ語の詳細の次の条件。書き手は §15 と同じ js/stats.js（偽の時計で日をまたぐ）。2 つのタブは js/masteryMeta.js を別のモジュールとして読む ──
{
  const W = await import("../js/stats.js");
  const MM = await import("../js/masteryMeta.js");
  const RealDate = Date;
  let clock = at("2026-01-05", 12);
  class FakeDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(clock);
      else super(...a);
    }
    static now() {
      return clock;
    }
  }
  const D0 = "2026-01-05";
  const dayAt = (n, h = 12, m = 0) => {
    const d = new RealDate(at(D0, h, m));
    d.setDate(d.getDate() + n);
    return d.getTime();
  };
  const dayOfDue = (st) => dayDiff(D0, localDay(new RealDate(Date.parse(st.nextReviewAt))));
  const blank = (over = {}) => ({ playCount: 1, correctCount: 0, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 0, mastered: false, masteredAt: null, lastPlayed: null, nextReviewAt: null, lastRecallFailAt: null, lastRecallSuccessAt: null, dailyLearningDate: null, dailyLearningStage: 0, srsAdvancedOn: null, ...over });
  const seed = (map) => {
    store.set("spelldash_word_stats", JSON.stringify(map));
    forgetMasteryMeta();
  };
  const read = () => JSON.parse(store.get("spelldash_word_stats"));
  const nextTask = () => new Promise((r) => setTimeout(r, 0));
  const study = (id, speed = "normal") => {
    W.recordCorrect(id, true);
    W.recordRecallSuccess(id, { clean: true, speed });
  };
  const quiet = console.warn;
  console.warn = () => {};

  // ---- 1. 日本語入力（IME）オンの物理キーボード: keydown は keyCode 229・key "Process" だが code は物理キーの名前 → 物理キーの箱 ----
  const kin = MM.keyInputOf;
  eq(
    "PR161-1: IME オンの物理キー（信頼された keydown・keyCode 229・key Process・code KeyA／Digit1／Minus）→ kbd（物理キーの名前を keyCode より先に見る）",
    [kin({ isTrusted: true, keyCode: 229, key: "Process", code: "KeyA" }), kin({ isTrusted: true, keyCode: 229, key: "Process", code: "Digit1" }), kin({ isTrusted: true, keyCode: 229, key: "Process", code: "Minus" })],
    ["kbd", "kbd", "kbd"]
  );
  eq(
    "PR161-1: code が空・Unidentified・無い keyCode 229（画面キーボード）は今どおり touch",
    [kin({ isTrusted: true, keyCode: 229, key: "Unidentified", code: "" }), kin({ isTrusted: true, keyCode: 229, key: "Unidentified", code: "Unidentified" }), kin({ isTrusted: true, keyCode: 229, key: "Process" })],
    ["touch", "touch", "touch"]
  );
  eq("PR161-1: 合成の keydown（#osk。isTrusted 偽）は code があっても touch", kin({ isTrusted: false, keyCode: 229, key: "Process", code: "KeyA" }), "touch");

  globalThis.Date = FakeDate;
  try {
    // ---- 2. 確認待ちの知ってた語を 14 日の確認の前に（Challenge などで）正解しても、期日（14 日目）の前は補充・息抜き・ミッションに出さない ----
    clock = dayAt(0);
    seed({ kc: blank(), kf: blank(), kx: blank(), kt: blank() });
    await nextTask();
    study("kc", "normal"); // 初見のノーミス・ふつう → 知ってた・思い出せる・14 日後
    study("kf", "fast"); // 初見のノーミス・すぐ → 知ってた・身についた・14 日後
    study("kx", "normal");
    study("kt", "normal");
    await nextTask();
    clock = dayAt(5);
    study("kc", "normal"); // 5 日目: Challenge と同じ書き手の呼び方でノーミス正解（S1: 期日は 14 日目のまま。streak 2 で確認待ちでなくなる）
    study("kf", "normal");
    await nextTask();
    const kc = read().kc;
    const kf = read().kf;
    eq("PR161-2: 5 日目の正解の後: streak 2・段 3（思い出せる）のまま・期日は 14 日目のまま・確認待ちでない（isKnownWaiting 偽）・知ってた語のまま", [kc.cleanCorrectStreak, kc.masteryRank, dayOfDue(kc), isKnownWaiting(kc), isKnownWord(kc)], [2, 3, 14, false, true]);
    const span = [6, 7, 8, 9, 10, 11, 12, 13];
    eq("PR161-2: 6〜13 日目は補充・息抜きに出さない（holdBeforeDue 真。段 3 でも）", span.map((d) => holdBeforeDue(kc, dayAt(d))), span.map(() => true));
    eq("PR161-2: 6〜13 日目はミッション（includeRank3）にも出さない", span.map((d) => holdBeforeDue(kc, dayAt(d), { includeRank3: true })), span.map(() => true));
    eq("PR161-2: 14 日目（期日の時刻）以降は出す", [holdBeforeDue(kc, dayAt(14)), holdBeforeDue(kc, dayAt(14), { includeRank3: true }), holdBeforeDue(kc, dayAt(20))], [false, false, false]);
    eq("PR161-2: 初見ですぐだった語（段 4）も同じ（6〜13 日目は出さない・14 日目から出す）", [...span.map((d) => holdBeforeDue(kf, dayAt(d))), holdBeforeDue(kf, dayAt(14))], [...span.map(() => true), false]);
    // 14 日目の答えは「知ってた語の最初の確認」にならない（前の答えの日が 5 日目に動いた。§3.7 のとおり）: gap 9 の ○ は段 3 のまま
    clock = dayAt(14);
    study("kc", "fast");
    await nextTask();
    eq("PR161-2: 14 日目の答えは知ってた語の確認ではない（今のまま: gap 9 のすぐは 3 → 4 で即答にしない）・期日は今どおり 10 日後（S2）", [read().kc.masteryRank, dayOfDue(read().kc) - 14], [4, 10]);
    // × のあった知ってた語（Recall Loop で解決済み）は段で読む（知ってた語の守りは × が一度も無い語だけ）
    clock = dayAt(3, 11);
    W.recordRecallFail("kx"); // 3 日目に × → 答えを見て打ち直す → Recall Loop で打てる
    W.recordCorrect("kx", false);
    await nextTask();
    clock = dayAt(3, 11, 10);
    study("kx", "normal");
    await nextTask();
    const kx = read().kx;
    eq("PR161-2: × のあった知ってた語（解決済み・段 2・期日は翌日）は × が一度もある語なので守らない（補充に出す）", [kx.knownOnSight, kx.recallFail, kx.masteryRank, holdBeforeDue(kx, dayAt(3, 18))], [true, 1, 2, false]);
    // 打ち間違いありの正解（Battle。streak 0・期日は翌日）の後も × は無いので、期日（翌日）までは出さない
    clock = dayAt(4);
    W.recordCorrect("kt", false);
    W.recordRecallSuccess("kt");
    await nextTask();
    const kt = read().kt;
    eq("PR161-2: 打ち間違いありの正解の後（streak 0・期日は翌日・× なし）は期日まで出さず、翌日から出す", [kt.cleanCorrectStreak, dayOfDue(kt), holdBeforeDue(kt, dayAt(4, 18)), holdBeforeDue(kt, dayAt(5))], [0, 5, true, false]);

    // ---- 4. 語の詳細の次の条件（rankNext）も、答えの判定（answerContext の downToday）と同じ 6 時間の窓で「今日下げた」を見る ----
    clock = at("2026-10-12", 23);
    const r2 = () => blank({ masteryRank: 2, masteryAt: iso("2026-10-09", 8), lastRecallSuccessAt: iso("2026-10-09", 8), cleanCorrectStreak: 1, correctCount: 1, srsAdvancedOn: "2026-10-09", nextReviewAt: iso("2026-10-10", 8) });
    seed({ lt: r2(), lo: r2() });
    await nextTask();
    for (const id of ["lt", "lo"]) {
      W.recordRecallFail(id); // 23:00 答え表示（×）
      W.recordCorrect(id, false); // 答えを見て打ち直す
      await nextTask();
    }
    clock = at("2026-10-13", 0, 30);
    study("lo", "normal"); // 00:30 Recall Loop で自力で打てる（下げた日の扱いなので 1 のまま）
    await nextTask();
    const late = read();
    eq("PR161-4: 23:00 の × で 2 → 1（masteryDownAt）・00:30 の ○ でも 1 のまま", [late.lt.masteryRank, late.lt.masteryDownAt === late.lt.lastRecallFailAt, late.lo.masteryRank], [1, true, 1]);
    const t1 = at("2026-10-13", 1);
    const t6 = at("2026-10-13", 6);
    for (const id of ["lt", "lo"]) {
      const c1 = answerContext(late[id], t1);
      eq(`PR161-4（${id}）: 01:00 は下げた日の扱い（downToday 真）で、今の ○ では上がらない`, [c1.downToday, nextRank(c1.rank, okA(), c1)], [true, 1]);
      eq(`PR161-4（${id}）: 01:00 の次の条件は日付つき（10月13日以降に。答えの判定と同じ扱い）`, rankNext(late[id], "2026-10-13", t1), "10月13日以降に 自力で思い出せると あやふや");
      const c6 = answerContext(late[id], t6);
      eq(`PR161-4（${id}）: 下げてから 6 時間たった 06:00 は今の ○ で上がり、次の条件は日付なし`, [c6.downToday, nextRank(c6.rank, okA(), c6), rankNext(late[id], "2026-10-13", t6)], [false, 2, "自力で思い出せると あやふや"]);
    }
    // 時計が戻って下げた時刻が先に見えるときも今日の扱い（今どおり）
    const ahead = { masteryRank: 1, masteryAt: iso("2026-10-13", 9), masteryDownAt: iso("2026-10-13", 9), lastRecallFailAt: iso("2026-10-13", 9), lastRecallSuccessAt: iso("2026-10-09", 8), recallFail: 1 };
    eq("PR161-4: 下げた時刻が先に見える（時計の戻り）ときも今日の扱い（日付つき）・answerContext も同じ", [rankNext(ahead, "2026-10-12", at("2026-10-12", 20)), answerContext(ahead, at("2026-10-12", 20)).downToday], ["10月14日以降に 自力で思い出せると あやふや", true]);
  } finally {
    globalThis.Date = RealDate;
  }

  // ---- 3. 別のタブで「端末の記録を消す」「復元」をした後、このタブの書き込みで速さの基準（firstMedian）・数え始めた日（since）を戻さない ----
  {
    const KEY = "spelldash_mastery_meta";
    const BOX = "en.kbd.study";
    const A = await import("../js/masteryMeta.js?tab=c");
    const B = await import("../js/masteryMeta.js?tab=d");
    const stored = () => JSON.parse(store.get(KEY) || "null");
    const old = { v: 1, speed: { [BOX]: { t1: Array(20).fill(1500), pc: [] } }, check: { since: "2026-09-01", rank: { 3: { "2-5": [4, 1] } }, firstFast: { prior: [0, 0], own: [0, 0] }, pending: {}, firstMedian: { [BOX]: 1500 } } };
    const now = at("2026-10-12", 9);
    store.set(KEY, JSON.stringify(old));
    A.forgetMasteryMeta();
    B.forgetMasteryMeta();
    const la = A.getMasteryMeta(); // タブ A が読み込む
    eq("PR161-3: タブ A が読み込んだ中身には基準と数え始めた日がある", [la.check.firstMedian[BOX], la.check.since], [1500, "2026-09-01"]);
    // タブ B が「端末の記録を消す」（js/backup.js clearLocalRecords: キーを消してメモリーを捨てる）
    store.delete(KEY);
    B.forgetMasteryMeta();
    A.noteSpeedSample(BOX, { t1: 1200, pc: null });
    A.noteRankCheck({ id: "x1", rankBefore: 3, gap: 2, ok: true }, now);
    A.flushMasteryMeta();
    let s = stored();
    eq("PR161-3: 消した後に A が書いても、読み込んだ時からあった基準（firstMedian）と数え始めた日（9月1日）は戻らない", [s?.check?.firstMedian?.[BOX], s?.check?.since === "2026-09-01"], [undefined, false]);
    eq("PR161-3: A が足した分（見本 1 件・集計 1 件）だけを書く（消す前の見本・集計も戻らない）", [s?.speed?.[BOX]?.t1, s?.check?.rank], [[1200], { 3: { "2-5": [1, 0] } }]);
    eq("PR161-3: 数え始めた日は、A が消した後の保存へ足した集計を数えた日（10月12日）", s?.check?.since, "2026-10-12");
    for (let i = 0; i < 19; i++) A.noteSpeedSample(BOX, { t1: 1300, pc: null });
    A.flushMasteryMeta();
    s = stored();
    eq("PR161-3: その後に A が新しく決めた最初の中央値（20 件目。1300）は書く", [s?.speed?.[BOX]?.t1?.length, s?.check?.firstMedian?.[BOX]], [20, 1300]);
    // タブ B が since の遅い・基準の無いバックアップを復元（js/backup.js applyBackup）
    store.set(KEY, JSON.stringify(old));
    A.forgetMasteryMeta();
    B.forgetMasteryMeta();
    A.getMasteryMeta();
    store.set(KEY, JSON.stringify({ v: 1, speed: {}, check: { since: "2026-10-05", rank: {}, firstFast: { prior: [0, 0], own: [0, 0] }, pending: {}, firstMedian: {} } }));
    B.forgetMasteryMeta();
    A.noteSpeedSample(BOX, { t1: 1100, pc: null });
    A.noteRankCheck({ id: "x2", rankBefore: 2, gap: 1, ok: false }, now);
    A.flushMasteryMeta();
    s = stored();
    eq("PR161-3: 復元の後に A が書いても、A の読み込んだ時の基準・数え始めた日は戻らない（復元した 10月5日のまま・基準なし）", [s?.check?.firstMedian?.[BOX], s?.check?.since, s?.speed?.[BOX]?.t1], [undefined, "2026-10-05", [1100]]);
    // 消していない保存（読み込んだ時の基準がまだある）には今どおり（先に書いた値のまま）
    store.set(KEY, JSON.stringify(old));
    A.forgetMasteryMeta();
    A.getMasteryMeta();
    A.noteSpeedSample(BOX, { t1: 900, pc: null });
    A.noteRankCheck({ id: "x3", rankBefore: 3, gap: 2, ok: true }, now);
    A.flushMasteryMeta();
    s = stored();
    eq("PR161-3: 消していなければ基準・数え始めた日は保存のまま（1500・9月1日）・集計は足し算", [s?.check?.firstMedian?.[BOX], s?.check?.since, s?.check?.rank?.["3"]?.["2-5"]], [1500, "2026-09-01", [5, 1]]);
    store.delete(KEY);
    A.forgetMasteryMeta();
    B.forgetMasteryMeta();
  }
  console.warn = quiet;
}

// ── 18. Batch 70: 段の戻り方（M1）と即答の 30 日の下限（M1'）。docs/SPEC_MASTERY.md §3.5・§3.7 ──────────────
// M1: 1 打ミスの ×（history の k "m" で、3 字目以降〔p ≥ 2〕か隣のキー〔a〕。全文入力の違う答え〔a が無い〕は入れない）で下がった段は、
// 下がる前の段を masteryPeak に控え、翌日以降のノーミス・遅くない・その日の最初の答えで控えた段まで 1 日 1 段で戻す。
// M1': 即答の 30 日の下限は前の答えから 14 日以上あけた答えだけ（短いときは身についたの 7 日）。書き手は §15 と同じ js/stats.js（偽の時計で日をまたぐ）
{
  // ---- 純関数 ----
  eq("M1': 即答の 30 日の下限をかける gap は 14 日から（RANK_FLOOR_GAP_DAYS）・身についたの 7 日は gap 1 から", [MA.RANK_FLOOR_GAP_DAYS?.[5], MA.RANK_FLOOR_GAP_DAYS?.[4] ?? 0], [14, 0]);
  eq(
    "M1': intervalAfter 段 5 の下限（gap 1 → 7・gap 13 → credit 14・gap 14 → 30・gap 21 → 30）。段 4 は今のまま（gap 1 → 7）",
    [1, 13, 14, 21].map((gap) => intervalAfter({ streakDays: 2, gap, rank: 5, speed: "normal" })).concat(intervalAfter({ streakDays: 1, gap: 1, rank: 4, speed: "normal" })),
    [7, 14, 30, 30, 7]
  );
  eq("M1': slow は今どおり下限なし・gap が数でなければ下限なし", [intervalAfter({ streakDays: 2, gap: 1, rank: 5, speed: "slow" }), intervalAfter({ streakDays: 2, gap: null, rank: 5, speed: "fast" })], [2, 2]);
  const slip = typeof MA.isSlipFail === "function" ? MA.isSlipFail : () => "isSlipFail が無い";
  eq(
    "M1 isSlipFail: 1 打ミスの 3 字目以降（p 2）・1 字目でも隣のキー（a）は真。2 字目までの隣でない字・全文入力の違う答え（a なし）・答え表示・ヒント・パス・不明・古い × は偽",
    [
      { r: "x", k: "m", p: 2, a: false },
      { r: "x", k: "m", p: 0, a: true },
      { r: "x", k: "m", a: true },
      { r: "x", k: "m", p: 1, a: false },
      { r: "x", k: "m", a: false },
      { r: "x", k: "m", p: 4 },
      { r: "x", k: "e", p: 5 },
      { r: "x", k: "h", p: 2 },
      { r: "x", k: "p", p: 3 },
      { r: "x", k: "u" },
      { r: "x" },
      { r: "o", k: "m", p: 3, a: true },
      null
    ].map((e) => slip(e)),
    [true, true, true, false, false, false, false, false, false, false, false, false, false]
  );
  // 控えの読み方（masteryPeakOf）: 段の欄があり、控えが今の段より上で、この端末が最後の × を見ていて（lastRecallFailAt ≤ masteryAt）、history の最後の × が M1 の ×
  const failAt = iso("2026-10-10", 12);
  const okAt = iso("2026-10-10", 12, 2);
  const slipped = { masteryRank: 4, masteryAt: okAt, masteryPeak: 5, recallFail: 1, lastRecallFailAt: failAt, lastRecallSuccessAt: okAt, history: [{ d: "2026-09-10", r: "o" }, { d: "2026-10-10", r: "x", k: "m", p: 3, a: false }, { d: "2026-10-10", r: "o" }] };
  const peakOf = typeof MA.masteryPeakOf === "function" ? MA.masteryPeakOf : () => "masteryPeakOf が無い";
  eq(
    "M1 masteryPeakOf: 1 打ミスで下がった語は 5。控えが今の段以下・見ていない ×・最後の × が答え表示／古い形・崩れた値・段の欄なしは 0",
    [
      peakOf(slipped),
      peakOf({ ...slipped, masteryPeak: 4 }),
      peakOf({ ...slipped, lastRecallFailAt: iso("2026-10-11", 9), recallFail: 2 }),
      peakOf({ ...slipped, history: [...slipped.history.slice(0, 1), { d: "2026-10-10", r: "x", k: "e", p: 3 }, { d: "2026-10-10", r: "o" }] }),
      peakOf({ ...slipped, history: [...slipped.history.slice(0, 1), { d: "2026-10-10", r: "x" }] }),
      ...[6, "5", 4.5, null].map((v) => peakOf({ ...slipped, masteryPeak: v })),
      peakOf({ ...slipped, masteryRank: undefined }),
      peakOf(undefined)
    ],
    [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  );
  eq("M1 answerContext: peak は masteryPeakOf と同じ（控えの無い語は 0）", [answerContext(slipped, at("2026-10-11", 12)).peak, answerContext({ ...slipped, masteryPeak: undefined }, at("2026-10-11", 12)).peak], [5, 0]);
  // nextRank: 控え（c.peak）が今の段より上なら、翌日以降のノーミス・遅くない答えで 1 段（6 日・20 日・すぐの条件なし）。× と同じ日の ○ は今のまま
  const P = (r, a, over = {}) => nextRank(r, a, ctx({ gap: 1, peak: 5, ...over }));
  eq(
    "M1 nextRank: 控え 5 の段 4 → 翌日のふつう・すぐ・速さ unknown で 5。遅い・打ち間違いあり・同じ日の ○・× は今のまま（4・4・4・3）",
    [P(4, okA("normal")), P(4, okA("fast")), P(4, okA("unknown")), P(4, okA("slow")), P(4, okA("normal", false)), P(4, okA("normal"), { sameDay: true, gap: null }), P(4, NG)],
    [5, 5, 5, 4, 4, 4, 3]
  );
  eq("M1 nextRank: 1 日 1 段（控え 5 の段 3 → 4）・控えより上に上げない（控え 4 の段 3 を 25 日あけてすぐ → 4）・控えが今の段以下なら今のまま", [P(3, okA("normal")), P(3, okA("fast"), { peak: 4, gap: 25 }), P(4, okA("normal"), { peak: 4 }), P(4, okA("normal"), { peak: 0 })], [4, 4, 4, 4]);
  eq("M1 nextRank: 今の規則の方が上ならそちら（知ってた語の確認で 3 → 5）", nextRank(3, okA("fast"), ctx({ gap: 14, knownCheck: true, peak: 4 })), 5);
  // 語の詳細の次の条件（rankNext。仕上げでつないだ）: 控えが使える語は「前の答えの翌日以降に 間違えずに思い出せると <1 段上の名前>」（nextRank の M1 の枝と
  // 同じ日・同じ段。今の規則の「6日・20日あけて」「すぐ打てると」は言わない）。控えが使えない語は今の文。規則の文にも戻り方の 1 文
  const T10 = "2026-10-10";
  eq(
    "M1 rankNext: 控え 5 の段 4 は「10月11日以降に 間違えずに思い出せると 即答」・翌日に見ると「次に …」",
    [rankNext(slipped, T10), rankNext(slipped, "2026-10-11")],
    ["10月11日以降に 間違えずに思い出せると 即答", "次に 間違えずに思い出せると 即答"]
  );
  eq(
    "M1 rankNext: 控え 5 の段 3（続けて 2 回下がった）は 1 段上の 身についた（6 日あけなくても）・控え 3 の段 2 は今の段 2 の文と同じ",
    [rankNext({ ...slipped, masteryRank: 3 }, T10), rankNext({ ...slipped, masteryRank: 2, masteryPeak: 3 }, T10)],
    ["10月11日以降に 間違えずに思い出せると 身についた", "10月11日以降に 間違えずに思い出せると 思い出せる"]
  );
  eq(
    "M1 rankNext: 控えの無い語・最後の × が答え表示の語は今の文（20 日あけて すぐ打てると 即答）・2 台目の × を取り込んだ語は 1 段下（3）の今の文（6 日あけて）",
    [
      rankNext({ ...slipped, masteryPeak: undefined }, T10),
      rankNext({ ...slipped, history: [...slipped.history.slice(0, 1), { d: "2026-10-10", r: "x", k: "e", p: 3 }, { d: "2026-10-10", r: "o" }] }, T10),
      rankNext({ ...slipped, lastRecallFailAt: iso("2026-10-11", 9), recallFail: 2 }, "2026-10-11")
    ],
    ["10月30日以降に すぐ打てると 即答", "10月30日以降に すぐ打てると 即答", "10月17日以降に 間違えずに思い出せると 身についた"]
  );
  {
    // nextRank と同じ日・同じ段か: 控え 5 の段 4 を翌日 9 時にふつうの速さで打つと 5（文の「10月11日以降に … 即答」と合う）
    const c = answerContext(slipped, at("2026-10-11", 9));
    eq("M1 rankNext と nextRank: 文の日（翌日）のふつうの答えで文の段（即答）になる", [c.sameDay, nextRank(c.rank, okA("normal"), c)], [false, 5]);
  }
  ok(
    "M1 規則の文: 打ち間違いで下がった段の戻り方の 1 文があり、「時間がたつだけでは下がらない」で終わる・「遅い」は無い",
    RANK_RULE.includes("3字目からの打ち間違いか 隣のキーの押し間違いで下がった段は、翌日から 間違えずに思い出せると 1 日 1 段ずつ戻る。") &&
      RANK_RULE.endsWith("時間がたつだけでは下がらない。") &&
      !RANK_RULE.includes("遅い")
  );

  // ---- 書き手（js/stats.js）: 控えを書く・戻す・消す ----
  const W = await import("../js/stats.js");
  const RealDate = Date;
  let clock = at("2026-10-01", 12);
  class FakeDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(clock);
      else super(...a);
    }
    static now() {
      return clock;
    }
  }
  const DAY = 86400000;
  const blank = (over = {}) => ({ playCount: 1, correctCount: 0, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 0, mastered: false, masteredAt: null, lastPlayed: null, nextReviewAt: null, lastRecallFailAt: null, lastRecallSuccessAt: null, dailyLearningDate: null, dailyLearningStage: 0, srsAdvancedOn: null, ...over });
  // 即答の語（30 日前に自力正解・期日は今）
  const five = (over = {}) => {
    const okIso = iso("2026-09-01", 12);
    return blank({ playCount: 9, correctCount: 9, cleanCorrectStreak: 6, masteryRank: 5, masteryAt: okIso, lastRecallSuccessAt: okIso, lastPlayed: okIso, srsAdvancedOn: "2026-09-01", nextReviewAt: iso("2026-10-01", 11), history: [{ d: "2026-08-02", r: "o" }, { d: "2026-09-01", r: "o" }], ...over });
  };
  const seed = (map) => {
    store.set("spelldash_word_stats", JSON.stringify(map));
    forgetMasteryMeta();
  };
  const read = () => JSON.parse(store.get("spelldash_word_stats"));
  const nextTask = () => new Promise((r) => setTimeout(r, 0));
  const study = (id, speed = "normal") => {
    W.recordCorrect(id, true);
    W.recordRecallSuccess(id, { clean: true, speed });
  };
  const fail = (id, detail) => {
    W.recordRecallFail(id, detail);
    W.recordCorrect(id, false); // 答えを見て打ち直す（答えに数えない）
  };
  const daysTo = (st) => Math.round((RealDate.parse(st.nextReviewAt) - clock) / DAY);
  const day = (n, h = 12, m = 0) => at("2026-10-01", h, m) + n * DAY;
  const quiet = console.warn;
  console.warn = () => {};
  globalThis.Date = FakeDate;
  try {
    const SLIP3 = { k: "m", p: 2, a: false }; // 3 字目の 1 打ミス（隣でない）
    const ids = ["m3", "adj1", "reveal", "hint", "m2", "battle", "free", "slow", "typo", "loop", "twice", "mixed", "unseen", "four", "one", "bt"];
    clock = day(0);
    seed(Object.fromEntries(ids.map((id) => [id, five(id === "four" ? { masteryRank: 4 } : id === "one" ? { masteryRank: 1 } : {})])));
    await nextTask();
    writes.clear();
    W.recordRecallFail("m3", SLIP3);
    await nextTask();
    eq("M1 書き手: 1 打ミスの × の保存は 1 回（控えも同じ写しに書く）", writesOf("spelldash_word_stats"), 1);
    W.recordCorrect("m3", false);
    fail("adj1", { k: "m", p: 0, a: true }); // 1 字目でも隣のキー
    fail("reveal", { k: "e", p: 3 }); // 答え表示
    fail("hint", { k: "h", p: 2 }); // ヒント
    fail("m2", { k: "m", p: 1, a: false }); // 2 字目・隣でない
    fail("battle"); // Battle（引数なし）
    fail("free", { k: "m", p: 4, a: null }); // 全文入力の違う答え（a なし）
    for (const id of ["slow", "typo", "loop", "twice", "mixed", "unseen", "four", "one", "bt"]) fail(id, SLIP3);
    await nextTask();
    let s = read();
    eq(
      "M1 書き手: 段 5 の × で 4。控え（masteryPeak 5）は 1 打ミスの 3 字目以降・隣のキーだけ。答え表示・ヒント・2 字目まで・Battle・全文入力は控えなし",
      ["m3", "adj1", "reveal", "hint", "m2", "battle", "free"].map((id) => [s[id].masteryRank, s[id].masteryPeak ?? null]),
      [[4, 5], [4, 5], [4, null], [4, null], [4, null], [4, null], [4, null]]
    );
    eq("M1 書き手: 段 4 の 1 打ミス → 3・控え 4。段 1 は下がらないので控えなし", [[s.four.masteryRank, s.four.masteryPeak], [s.one.masteryRank, s.one.masteryPeak ?? null]], [[3, 4], [1, null]]);
    // 同じ日: Recall Loop の ○ は今のまま（同じ日なので戻さない）、同じ日の答え表示の × は控えを消す
    clock = day(0, 12, 4);
    study("loop", "fast");
    W.recordRecallFail("mixed", { k: "e", p: 0 }); // 同じ日の 2 回目の ×（段は下がらない）・答え表示
    await nextTask();
    s = read();
    eq("M1 書き手: 同じ日の ○ では戻さない（4 のまま・控え 5 は残る）・同じ日の答え表示の × で控えを消す（4 のまま）", [[s.loop.masteryRank, s.loop.masteryPeak], [s.mixed.masteryRank, s.mixed.masteryPeak ?? null]], [[4, 5], [4, null]]);
    // 2 台目の × を取り込んだ形（この端末の段が見ていない × がある）: 控えは使わない
    s.unseen = { ...s.unseen, lastRecallFailAt: new RealDate(day(0, 20)).toISOString(), recallFail: s.unseen.recallFail + 1 };
    store.set("spelldash_word_stats", JSON.stringify(s));

    // 翌日（gap 1）
    clock = day(1);
    for (const id of ["m3", "adj1", "reveal", "hint", "m2", "battle", "free", "loop", "mixed", "unseen", "four"]) study(id, "normal");
    study("slow", "slow");
    W.recordCorrect("typo", false); // 打ち間違いありの正解（Battle）
    W.recordRecallSuccess("typo");
    W.recordRecallFail("twice", SLIP3); // 翌日も 1 打ミス → 3（控えは 5 のまま）
    W.recordCorrect("twice", false);
    W.recordCorrect("bt", true); // Battle のノーミス正解（引数なし・速さ unknown）
    W.recordRecallSuccess("bt");
    await nextTask();
    s = read();
    eq(
      "M1 書き手: 翌日のノーミスで 1 打ミスの語は 5 に戻り控えは消える。答え表示・ヒント・2 字目まで・Battle の ×・全文入力の語は 4 のまま（今の決まり）",
      ["m3", "adj1", "reveal", "hint", "m2", "battle", "free"].map((id) => [s[id].masteryRank, s[id].masteryPeak ?? null]),
      [[5, null], [5, null], [4, null], [4, null], [4, null], [4, null], [4, null]]
    );
    eq("M1・M1' 書き手: 戻った翌日の期日は 7 日後（gap 1 なので 30 日にしない）・戻らない語も 7 日後（身についたの下限）", ["m3", "adj1", "reveal", "battle"].map((id) => daysTo(s[id])), [7, 7, 7, 7]);
    eq("M1 書き手: 段 4 の 1 打ミス → 3 → 翌日のふつうで 4（6 日あけなくても）・控えは消える", [s.four.masteryRank, s.four.masteryPeak ?? null], [4, null]);
    eq("M1 書き手: 同じ日の答え表示で控えを消した語・2 台目の × を取り込んだ語は戻さない（今の決まり。控えも消える）", [[s.mixed.masteryRank, s.mixed.masteryPeak ?? null], [s.unseen.masteryRank, s.unseen.masteryPeak ?? null]], [[4, null], [3, null]]);
    eq("M1 書き手: Recall Loop で打てた語も翌日に戻る", [s.loop.masteryRank, s.loop.masteryPeak ?? null], [5, null]);
    eq("M1 書き手: 遅い答え・打ち間違いありの正解では戻さず、控えを残す（4・控え 5）", [[s.slow.masteryRank, s.slow.masteryPeak], [s.typo.masteryRank, s.typo.masteryPeak]], [[4, 5], [4, 5]]);
    eq("M1 書き手: 翌日も 1 打ミス → 3・控えは 5 のまま（どちらの段も 1 打ミスで下がった）", [s.twice.masteryRank, s.twice.masteryPeak], [3, 5]);
    eq("M1 書き手: Battle のノーミス正解（速さ unknown）でも戻る（遅くないノーミス）", [s.bt.masteryRank, s.bt.masteryPeak ?? null], [5, null]);

    // 2 日後
    clock = day(2);
    for (const id of ["slow", "typo", "twice"]) study(id, "normal");
    await nextTask();
    s = read();
    eq("M1 書き手: 控えの残った語は次の日のノーミスで戻る（遅い・打ち間違いの翌日 → 5）・2 回下がった語は 1 日 1 段（3 → 4・控え 5 は残る）", [[s.slow.masteryRank, s.slow.masteryPeak ?? null], [s.typo.masteryRank, s.typo.masteryPeak ?? null], [s.twice.masteryRank, s.twice.masteryPeak]], [[5, null], [5, null], [4, 5]]);
    clock = day(3);
    study("twice", "normal");
    await nextTask();
    eq("M1 書き手: その翌日に 5 へ戻りきって控えを消す", [read().twice.masteryRank, read().twice.masteryPeak ?? null], [5, null]);
    ok("M1 書き手: どの語も書いた直後は rankOf === masteryRank", Object.values(read()).every((st) => rankOf(st) === st.masteryRank));

    // ---- M2: 模擬の道（D1 §2.7 の L2 の行）を製品の書き手で。毎日 12:00 に期日の語だけ答える。× の日は 12:00 に × → 打ち直し → 12:02 に Recall Loop ----
    const D0 = "2026-01-05";
    const pd = (n, h = 12, m = 0) => at(D0, h, m) + n * DAY;
    const dueDay = (st) => dayDiff(D0, localDay(new RealDate(RealDate.parse(st.nextReviewAt))));
    const walk = async (id, last, xDay, detail) => {
      const log = [];
      for (let d = 1; d <= last; d++) {
        clock = pd(d);
        if (!(RealDate.parse(read()[id].nextReviewAt) <= clock)) continue;
        if (d === xDay) {
          W.recordRecallFail(id, detail);
          clock = pd(d, 12, 0) + 15000;
          W.recordCorrect(id, false);
          await nextTask();
          clock = pd(d, 12, 2);
          study(id, "normal");
        } else study(id, "fast");
        await nextTask();
        const st = read()[id];
        log.push(`${d}${d === xDay ? (detail?.k === "m" ? "×m" : "×") : ""}:${RANK_NAMES[st.masteryRank]}`);
      }
      return log;
    };
    clock = pd(0);
    seed({ apple: blank(), appleE: blank() });
    await nextTask();
    study("apple", "fast");
    study("appleE", "fast");
    await nextTask();
    eq("M2: 0 日目 初見ですぐ → 身についた・14 日後", [read().apple.masteryRank, dueDay(read().apple)], [4, 14]);
    const typoPath = await walk("apple", 140, 44, { k: "m", p: 3, a: false }); // appel（4 字目の 1 打ミス）
    eq("M2: 44 日目に 1 打ミスの apple（L2）: 44×m 身についた → 46 即答 → 53 → 63 → 77 → 107 → 137", typoPath, ["14:即答", "44×m:身についた", "46:即答", "53:即答", "63:即答", "77:即答", "107:即答", "137:即答"]);
    const revealPath = await walk("appleE", 140, 44, { k: "e", p: 4 });
    eq("M2: 答え表示の × は今と同じ: 44× 身についた → 46 → 53 → 63 → 77 → 98 即答 → 128", revealPath, ["14:即答", "44×:身についた", "46:身についた", "53:身についた", "63:身についた", "77:身についた", "98:即答", "128:即答"]);
  } finally {
    globalThis.Date = RealDate;
    console.warn = quiet;
  }
}

// ── 結果 ──────────────────────────────────────────
if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK: mastery ${passed} passed`);
process.exit(0);
