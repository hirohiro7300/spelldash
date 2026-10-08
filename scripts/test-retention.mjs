// 記憶の保持率（js/retentionCalc.js・js/retentionLog.js・js/studyTime.js）の単体テスト。ブラウザなしで 1 秒で終わる:
//   node scripts/test-retention.mjs
// 失敗が 1 つでもあれば終了コード 1。
// 日付は固定値（窓の端 +5/+6/+8/+9・+26/+27/+33/+34）、ローカル日の境界は時間帯を Asia/Tokyo に固定して確かめる。
process.env.TZ = "Asia/Tokyo";

import { isDeepStrictEqual } from "util";
import { computeRetention, dayDiff, shiftDay, localDay, WINDOW_7, WINDOW_30 } from "../js/retentionCalc.js";
import { noteFirstRecall, noteAnswer, getRetentionRecords } from "../js/retentionLog.js";
import { touchStudyTime, getStudySecondsByDay, resetStudyTimeClock } from "../js/studyTime.js";

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond) => eq(name, !!cond, true);

// 書き手の検証用に localStorage を用意する（Node には無い）
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  }
});

// ローカルの年月日・時刻から Date を作る（時間帯に依らず「その日の」ISO になる）
const at = (ymd, h = 9, m = 0) => {
  const [y, mo, d] = ymd.split("-").map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0);
};
const iso = (ymd, h = 9) => at(ymd, h).toISOString();
const T0 = "2026-09-01";
const day = (n) => shiftDay(T0, n);
const calc = (records, seconds = {}, today = day(10)) => computeRetention(records, seconds, { today });
const empty = { none: { ok: 0, n: 0 }, some: { ok: 0, n: 0 }, measured: 0, unmeasured: 0, pending: 0 };

// ── 1. 日の計算 ─────────────────────────────────────────
eq("dayDiff 同じ日", dayDiff("2026-09-01", "2026-09-01"), 0);
eq("dayDiff 月またぎ", dayDiff("2026-08-31", "2026-09-07"), 7);
eq("dayDiff 年またぎ", dayDiff("2025-12-25", "2026-01-01"), 7);
eq("dayDiff 逆向きは負", dayDiff("2026-09-08", "2026-09-01"), -7);
ok("dayDiff 壊れた日付は NaN", Number.isNaN(dayDiff("2026-9-1", "2026-09-01")));
eq("shiftDay +33 で月またぎ", shiftDay("2026-09-01", 33), "2026-10-04");
eq("shiftDay −7", shiftDay("2026-10-03", -7), "2026-09-26");
eq("窓の定義 7 日", WINDOW_7, [6, 8]);
eq("窓の定義 30 日", WINDOW_30, [27, 33]);

// ── 2. ローカル日の境界（Asia/Tokyo。UTC で切ると日がずれる時刻）─────
eq("localDay: 0:30 はその日（UTC では前日）", localDay(at(T0, 0, 30)), T0);
eq("localDay: 23:30 はその日", localDay(at(T0, 23, 30)), T0);
eq("localDay: ISO 文字列も同じ", localDay(iso(T0, 0)), T0);
eq("localDay: 読めない値は null", localDay("not a date"), null);
{
  const early = { a: { f: at(T0, 0, 30).toISOString(), d: T0, n: 0 } };
  const late = { a: { f: at(T0, 23, 30).toISOString(), d: T0, n: 0 } };
  eq("0:30 に覚えた語: +6 日で測定中", calc(early, {}, day(6)).d7.pending, 1);
  eq("23:30 に覚えた語: +6 日で測定中", calc(late, {}, day(6)).d7.pending, 1);
  eq("23:30 に覚えた語: +5 日はまだ到達前", calc(late, {}, day(5)).d7, empty);
  eq("0:30 に覚えた語: +9 日で未測定", calc(early, {}, day(9)).d7.unmeasured, 1);
}

// ── 3. 窓の端（回答なしの語の状態）──────────────────────
{
  const rec = { a: { f: iso(T0), d: T0, n: 0 } };
  const d7at = (n) => calc(rec, {}, day(n)).d7;
  const d30at = (n) => calc(rec, {}, day(n)).d30;
  eq("+5: 7 日窓の到達前（何にも数えない）", d7at(5), empty);
  eq("+6: 7 日窓の測定中", d7at(6), { ...empty, pending: 1 });
  eq("+8: 7 日窓の測定中", d7at(8), { ...empty, pending: 1 });
  eq("+9: 7 日窓の未測定", d7at(9), { ...empty, unmeasured: 1 });
  eq("+26: 30 日窓の到達前", d30at(26), empty);
  eq("+27: 30 日窓の測定中", d30at(27), { ...empty, pending: 1 });
  eq("+33: 30 日窓の測定中", d30at(33), { ...empty, pending: 1 });
  eq("+34: 30 日窓の未測定", d30at(34), { ...empty, unmeasured: 1 });
  eq("+27 の語は 7 日窓では未測定", d7at(27), { ...empty, unmeasured: 1 });
  eq("f が未来（時計の巻き戻り）は到達前", calc(rec, {}, day(-3)).d7, empty);
}

// ── 4. 復習なし／ありの層別と分母 ─────────────────────────
{
  const records = {
    a: { f: iso(T0), d: day(7), n: 1, w7: { t: day(7), r: "o", rv: 0 } },
    b: { f: iso(T0), d: day(6), n: 1, w7: { t: day(6), r: "x", rv: 0 } },
    c: { f: iso(T0), d: day(8), n: 3, w7: { t: day(8), r: "o", rv: 2 } },
    d: { f: iso(T0), d: day(7), n: 2, w7: { t: day(7), r: "o", rv: 1 } },
    e: { f: iso(T0), d: day(1), n: 1 }, // 窓を過ぎて未回答
    g: { f: iso(day(3)), d: day(3), n: 0 }, // +7 日: 測定中
    h: { f: iso(day(8)), d: day(8), n: 0 } // +2 日: 到達前
  };
  const r = calc(records, {}, day(10));
  eq("7 日後（復習なし）= 1/2", r.d7.none, { ok: 1, n: 2 });
  eq("7 日後（復習あり）= 2/2", r.d7.some, { ok: 2, n: 2 });
  eq("測定した語 = 4", r.d7.measured, 4);
  eq("未測定 = 1（到達前・測定中は数えない）", r.d7.unmeasured, 1);
  eq("測定中 = 1", r.d7.pending, 1);
  eq("30 日窓はまだ全部到達前", r.d30, empty);
  eq("定着（7 日後に o）= 3", r.retained, 3);
  eq("since はいちばん早い f", r.since, T0);
  eq("混ぜた率は返さない（none/some だけ）", Object.keys(r.d7).sort(), ["measured", "none", "pending", "some", "unmeasured"]);
}
{
  // 30 日窓
  const records = {
    a: { f: iso(T0), d: day(30), n: 2, w7: { t: day(7), r: "o", rv: 0 }, w30: { t: day(30), r: "o", rv: 1 } },
    b: { f: iso(T0), d: day(28), n: 1, w7: { t: day(6), r: "o", rv: 0 }, w30: { t: day(28), r: "x", rv: 1 } },
    c: { f: iso(T0), d: day(27), n: 1, w30: { t: day(27), r: "o", rv: 0 } }, // 7 日窓は未測定
    d: { f: iso(T0), d: day(7), n: 1, w7: { t: day(7), r: "x", rv: 0 } } // 30 日窓は未測定
  };
  const r = calc(records, {}, day(40));
  eq("30 日後（復習なし）= 1/1", r.d30.none, { ok: 1, n: 1 });
  eq("30 日後（復習あり）= 1/2", r.d30.some, { ok: 1, n: 2 });
  eq("30 日: 測定 3・未測定 1", [r.d30.measured, r.d30.unmeasured, r.d30.pending], [3, 1, 0]);
  eq("7 日: 測定 3・未測定 1", [r.d7.measured, r.d7.unmeasured], [3, 1]);
  eq("定着は 7 日後の o だけ数える", r.retained, 2);
}

// ── 5. 学習効率の分母（today − 7 日 までの学習時間）────────────
{
  const records = { a: { f: iso(T0), d: day(7), n: 1, w7: { t: day(7), r: "o", rv: 0 } }, b: { f: iso(T0), d: day(7), n: 1, w7: { t: day(7), r: "o", rv: 0 } }, c: { f: iso(T0), d: day(7), n: 1, w7: { t: day(7), r: "x", rv: 0 } } };
  const today = day(10);
  const seconds = { [shiftDay(today, -8)]: 1800, [shiftDay(today, -7)]: 3600, [shiftDay(today, -6)]: 7200, [today]: 600 };
  const r = calc(records, seconds, today);
  eq("学習時間は 7 日前までの日だけ（1.5 時間）", r.hours, 1.5);
  eq("1 時間で定着 = 2 ÷ 1.5", Math.round(r.perHour * 100) / 100, 1.33);
  eq("学習時間 0 なら perHour は null", calc(records, { [shiftDay(today, -1)]: 3600 }, today).perHour, null);
  eq("壊れた値は無視", calc(records, { "2026-09-01": "x", bad: 100, [shiftDay(today, -9)]: -5 }, today).hours, 0);
}

// ── 6. 壊れた記録に耐える ─────────────────────────────
{
  const r = calc({ a: null, b: {}, c: { f: "junk" }, d: 5, e: { f: iso(T0), w7: { r: "?" } } }, null, day(10));
  eq("読めない記録は飛ばす", [r.d7.measured, r.d7.unmeasured, r.retained], [0, 1, 0]);
  eq("記録が無ければ since は today", calc({}, {}, day(10)).since, day(10));
  eq("records が null でも落ちない", calc(null, null, day(10)).d7, empty);
  eq("today が無ければ今日", typeof computeRetention({}, {}, {}).since, "string");
}

// ── 7. 書き手: 初回・知ってた・復習日数・write-once ──────────
{
  store.clear();
  const learned = { knownOnSight: false, recallFail: 1 };
  const known = { knownOnSight: true, recallFail: 0 };
  const relearned = { knownOnSight: true, recallFail: 1, history: [{ d: day(-30), r: "o" }, { d: T0, r: "x" }, { d: T0, r: "o" }] };

  noteFirstRecall("known", known, null, at(T0, 10));
  eq("知ってた語（初見ノーミス・つまずき 0）には f を立てない", getRetentionRecords().known, undefined);
  noteAnswer("known", "o", known, at(day(7), 10));
  eq("f の無い語の回答は何も書かない", getRetentionRecords().known, undefined);
  noteFirstRecall("relearned", relearned, iso(day(-30)), at(T0, 10));
  ok("知ってた語でも、つまずいてから思い出せたら f が立つ", !!getRetentionRecords().relearned?.f);

  // 測定の開始前（または別の端末）にすでに覚えていた語: 以前の自力正解（prevSuccessAt）がある → t0 を立てない
  noteFirstRecall("old", { knownOnSight: false, recallFail: 2, history: [{ d: day(-40), r: "o" }, { d: T0, r: "o" }] }, iso(day(-40)), at(T0, 10));
  eq("以前に自力正解のある語（測定開始前に覚えた語）には f を立てない", getRetentionRecords().old, undefined);
  noteFirstRecall("old2", { recallFail: 0, history: [{ d: T0, r: "o" }] }, iso(day(-100)), at(T0, 10));
  eq("2 台目（history・knownOnSight が無い）でも lastRecallSuccessAt があれば立てない", getRetentionRecords().old2, undefined);
  noteFirstRecall("old3", { knownOnSight: false, recallFail: 1 }, iso(day(-3)), at(T0, 10));
  eq("history が無くても prevSuccessAt があれば立てない", getRetentionRecords().old3, undefined);
  noteFirstRecall("first", { knownOnSight: false, recallFail: 1, history: [{ d: day(-1), r: "x" }, { d: T0, r: "o" }] }, null, at(T0, 10));
  eq("以前の自力正解が無い語（× のあと初めて ○）には立てる", getRetentionRecords().first?.d, T0);
  // 知ってた語の学び直し: 最後の x のあとに o が無いときだけ（すでに学び直し済みの語には立てない）
  noteFirstRecall("kn2", { knownOnSight: true, recallFail: 1, history: [{ d: day(-30), r: "o" }, { d: day(-2), r: "x" }, { d: day(-2), r: "o" }, { d: T0, r: "o" }] }, iso(day(-2)), at(T0, 10));
  eq("知ってた語でも、つまずいたあとの ○ がすでにあれば立てない（t0 はその ○）", getRetentionRecords().kn2, undefined);
  noteFirstRecall("kn3", { knownOnSight: true, recallFail: 1, history: Array.from({ length: 8 }, (_, i) => ({ d: day(i - 8), r: "o" })) }, iso(day(-1)), at(T0, 10));
  eq("知ってた語で x が history から流れていれば立てない（学び直しは 8 回より前）", getRetentionRecords().kn3, undefined);
  noteFirstRecall("kn4", { knownOnSight: true, recallFail: 1 }, iso(day(-1)), at(T0, 10));
  eq("知ってた語で history が無ければ立てない", getRetentionRecords().kn4, undefined);
  noteFirstRecall("kn5", { knownOnSight: true, recallFail: 1, history: [{ d: T0, r: "x" }, { d: T0, r: "o" }] }, null, at(T0, 10));
  eq("prevSuccessAt が無ければ knownOnSight でも recallFail があれば立てる", getRetentionRecords().kn5?.d, T0);

  noteFirstRecall("w", learned, null, at(T0, 10));
  const first = getRetentionRecords().w;
  eq("初回: f は ISO、d は覚えた日、n は 0", [first.f, first.d, first.n], [at(T0, 10).toISOString(), T0, 0]);
  noteFirstRecall("w", learned, iso(T0, 10), at(day(1), 10));
  eq("2 回目の自力正解で f は変わらない（write-once）", getRetentionRecords().w.f, first.f);

  noteAnswer("w", "o", learned, at(T0, 11));
  noteAnswer("w", "x", learned, at(T0, 12));
  eq("覚えた日の反復は復習に数えない", getRetentionRecords().w.n, 0);
  noteAnswer("w", "x", learned, at(day(1), 9));
  noteAnswer("w", "o", learned, at(day(1), 9, 5));
  eq("翌日の回答は 1 日として数える（同日 2 回でも 1）", [getRetentionRecords().w.n, getRetentionRecords().w.d], [1, day(1)]);
  noteAnswer("w", "o", learned, at(day(3), 9));
  eq("別の日でもう 1 日", getRetentionRecords().w.n, 2);
  noteAnswer("w", "o", learned, at(day(5), 9));
  eq("+5 日はまだ窓の外（w7 なし、復習 3 日）", [getRetentionRecords().w.w7, getRetentionRecords().w.n], [undefined, 3]);
  noteAnswer("w", "x", learned, at(day(6), 9));
  eq("+6 日の最初の回答が w7（rv はその前の復習日数 3）", getRetentionRecords().w.w7, { t: day(6), r: "x", rv: 3 });
  eq("窓の回答の日も復習日数に入る（次の窓の rv 用）", getRetentionRecords().w.n, 4);
  noteAnswer("w", "o", learned, at(day(6), 9, 30));
  eq("同じ日の 2 回目は上書きしない", getRetentionRecords().w.w7, { t: day(6), r: "x", rv: 3 });
  noteAnswer("w", "o", learned, at(day(7), 9));
  eq("翌日の o でも上書きしない（最初に問われたときの状態）", getRetentionRecords().w.w7, { t: day(6), r: "x", rv: 3 });
  eq("+7 日の回答は復習日数にだけ入る", getRetentionRecords().w.n, 5);
  noteAnswer("w", "o", learned, at(day(26), 9));
  eq("+26 日は 30 日窓の外", getRetentionRecords().w.w30, undefined);
  noteAnswer("w", "o", learned, at(day(33), 9));
  eq("+33 日の最初の回答が w30（rv = それまでの復習日数 6）", getRetentionRecords().w.w30, { t: day(33), r: "o", rv: 6 });
  noteAnswer("w", "x", learned, at(day(34), 9));
  eq("+34 日の回答は w30 を変えない", getRetentionRecords().w.w30, { t: day(33), r: "o", rv: 6 });

  // 窓の中で初めて答えた語（復習なし）
  noteFirstRecall("fresh", learned, null, at(T0, 10));
  noteAnswer("fresh", "o", learned, at(day(8), 9));
  eq("復習なしで +8 日に o → rv 0", getRetentionRecords().fresh.w7, { t: day(8), r: "o", rv: 0 });
  noteAnswer("fresh", "o", learned, at(day(9), 9));
  eq("+9 日は窓の外（上書きなし）", getRetentionRecords().fresh.w7, { t: day(8), r: "o", rv: 0 });

  // 集計と書き手がつながる
  const r = calc(getRetentionRecords(), {}, day(40));
  eq("書いた記録を集計: 7 日後 復習なし 1/1・復習あり 0/1", [r.d7.none, r.d7.some], [{ ok: 1, n: 1 }, { ok: 0, n: 1 }]);
  eq("書いた記録を集計: 30 日後 復習あり 1/1、未測定 4（fresh・relearned・first・kn5）", [r.d30.some, r.d30.unmeasured], [{ ok: 1, n: 1 }, 4]);

  // 壊れた保存値でも落ちず、書き直せる
  store.set("spelldash_retention", "{broken");
  noteFirstRecall("x", learned, null, at(T0, 10));
  ok("壊れた JSON の上からでも初回を書ける", !!getRetentionRecords().x?.f);
  store.set("spelldash_retention", "[1,2]");
  eq("配列が入っていたら空扱い", getRetentionRecords(), {});
  noteAnswer("x", "o", learned, at(day(7), 9));
  eq("空扱いの状態で f の無い語には書かない", getRetentionRecords(), {});
  ok("引数が欠けても落ちない", (noteFirstRecall(null, learned), noteAnswer("x", "maybe", learned), true));
}

// ── 8. 学習時間 ─────────────────────────────────────
{
  store.clear();
  resetStudyTimeClock();
  const base = at(T0, 10).getTime();
  touchStudyTime(base);
  eq("最初のイベントは足さない（前が無い）", getStudySecondsByDay(), {});
  touchStudyTime(base + 4000);
  eq("4 秒後のイベントで 4 秒", getStudySecondsByDay()[T0], 4);
  touchStudyTime(base + 4000 + 90000);
  eq("90 秒あいたら 60 秒だけ（離席の打ち切り）", getStudySecondsByDay()[T0], 64);
  touchStudyTime(base + 4000 + 90000 + 1500);
  eq("1.5 秒は小数のまま足す", getStudySecondsByDay()[T0], 65.5);
  touchStudyTime(base + 4000 + 90000 + 1500 - 1000);
  eq("時計が戻ったぶんは足さない", getStudySecondsByDay()[T0], 65.5);
  const next = at(day(1), 0, 0).getTime();
  touchStudyTime(next);
  eq("日をまたいだ長い空き（上限 60 秒）は新しい日に足す", [getStudySecondsByDay()[T0], getStudySecondsByDay()[day(1)]], [65.5, 60]);
  touchStudyTime(next + 10000);
  eq("日付が変わると別の日に足す", [getStudySecondsByDay()[T0], getStudySecondsByDay()[day(1)]], [65.5, 70]);
  resetStudyTimeClock();
  touchStudyTime(next + 20000);
  eq("ページを開き直した直後のイベントは足さない", getStudySecondsByDay()[day(1)], 70);

  // 120 日で切る
  const many = Object.fromEntries(Array.from({ length: 125 }, (_, i) => [shiftDay(T0, -200 + i), 10]));
  store.set("spelldash_study_time", JSON.stringify(many));
  resetStudyTimeClock();
  touchStudyTime(base);
  touchStudyTime(base + 1000);
  const kept = Object.keys(getStudySecondsByDay()).sort();
  eq("120 日より古い日は消える", [kept.length, kept[kept.length - 1]], [120, T0]);
  ok("残るのは新しい方", kept[0] > shiftDay(T0, -200));

  store.set("spelldash_study_time", "{broken");
  resetStudyTimeClock();
  touchStudyTime(base);
  touchStudyTime(base + 1000);
  eq("壊れた JSON の上からでも書ける", getStudySecondsByDay()[T0], 1);
}

// ── 結果 ──────────────────────────────────────────
if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK: retention ${passed} passed`);
