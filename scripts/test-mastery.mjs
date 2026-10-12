// 単語ごとの習熟度（js/mastery.js・js/masteryMeta.js と、js/stats.js の書き手）の単体テスト。ブラウザなしで数秒で終わる:
//   node scripts/test-mastery.mjs
// 失敗が 1 つでもあれば終了コード 1。定義は docs/SPEC_MASTERY.md（§3・§7・§9.3）。
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
  holdBeforeDue
} from "../js/mastery.js";
import {
  BOX_KEYS,
  COLD_FAST_MS,
  boxKey,
  gapBand,
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
  seed({ k: base({ playCount: 2, cleanCorrectStreak: 0 }), f: base({ playCount: 1, cleanCorrectStreak: 0 }) });
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
      eq("期日が翌日の間も補充・息抜きから外さない（段 3・確認待ちでない）", holdBeforeDue(kb, clock + 3600 * 1000), false);
      clock = at("2026-10-18", 10); // 14 日あけて、すぐ打てる
      study("kb", "fast");
      study("kp", "fast");
      await nextTask();
      eq("14 日あけてすぐ打っても 3 → 4（5 に飛ばない。打ち間違いの無い同じ流れも 4）", [read().kb.masteryRank, read().kp.masteryRank], [4, 4]);
    } finally {
      globalThis.Date = RealDate;
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

// ── 結果 ──────────────────────────────────────────
if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK: mastery ${passed} passed`);
process.exit(0);
