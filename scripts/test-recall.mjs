// 思い出す速さ（js/recallSpeed.js。語ごとの「すぐ／ふつう／時間がかかる」）の単体テスト。ブラウザなしで 1 秒もかからない:
//   node scripts/test-recall.mjs
// 失敗が 1 つでもあれば終了コード 1。定義は docs/SPEC_MASTERY.md（Batch 70）・D1 §1.3・§3。日付は固定値（時間帯は Asia/Tokyo）。
process.env.TZ = "Asia/Tokyo";

import { isDeepStrictEqual } from "util";
import { readFileSync } from "fs";
import {
  SPEED_FAST_Q,
  SPEED_SLOW_Q,
  SPEED_MIN_RECORDS,
  SPEED_MAX_PROMPT,
  SPEED_OLD_DAYS,
  SPEED_LABEL,
  SPEED_LOG_NOTE,
  promptChars,
  dayNoOf,
  ymdOfDayNo,
  speedOfRecords,
  recallSpeedClass,
  recallSpeedOf,
  recallSpeedText,
  recallSpeedLog,
  recallSpeedTag
} from "../js/recallSpeed.js";
import { FAST_RATIO, SLOW_RATIO } from "../js/masteryMeta.js";
import { encodeMark, CLS_CHAR } from "../js/memoryCheck.js";
import { dayDiff } from "../js/retentionCalc.js";

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
function ok(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
}

const TODAY = "2026-10-15";
const T = dayNoOf(TODAY);
const MARK = encodeMark({ a: true, qb: 1, ab: 1, input: "kbd" }); // 書き手（js/stats.js noteSpeedRecord）と同じ印の作り方
const FIRST = encodeMark({ a: true, qb: 1, ab: 1, first: true, input: "kbd" });
// sp の 1 件（daysAgo 日前・T1・q・分類）
const e = (daysAgo, t1, q, cls = "n", mark = MARK) => [T - daysAgo, t1, q, cls, mark];
const sp3 = [e(19, 1600, 110), e(12, 1200, 100), e(5, 1400, 120)];

// ---- 境と定数 ----
eq("境: すぐ は q 75 以下（FAST_RATIO 0.75 × 100）", SPEED_FAST_Q, Math.round(FAST_RATIO * 100));
eq("境: 時間がかかる は q 150 超（SLOW_RATIO 1.5 × 100）", SPEED_SLOW_Q, Math.round(SLOW_RATIO * 100));
eq("定数: 材料 2 件から・訳 8 字以上は出さない・90 日", [SPEED_MIN_RECORDS, SPEED_MAX_PROMPT, SPEED_OLD_DAYS], [2, 8, 90]);
eq("語: すぐ・ふつう・時間がかかる（「遅い」と書かない）", SPEED_LABEL, { fast: "すぐ", normal: "ふつう", slow: "時間がかかる" });
ok("語と注記に「遅い」・数の予測（%）が無い", !/遅い|%|％/.test(JSON.stringify(SPEED_LABEL) + SPEED_LOG_NOTE));

// ---- 純関数（DOM・保存に触らない。import は js/retentionCalc.js だけ） ----
{
  const src = readFileSync(new URL("../js/recallSpeed.js", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
  eq("純関数: import は ./retentionCalc.js だけ", imports, ["./retentionCalc.js"]);
  ok("純関数: localStorage・document・window を読まない", !/localStorage|document\.|window\./.test(src.replace(/\/\/.*$/gm, "")));
}

// ---- 問いの字数（js/game.js promptLength と同じ数え方） ----
eq("字数: りんご 3・建物 2・括弧の中を除く（請求書（インボイス） 3）・前後の空白", [promptChars("りんご"), promptChars("建物"), promptChars("請求書（インボイス）"), promptChars(" 机 ")], [3, 2, 3, 1]);
eq("字数: 半角の括弧も除く・空・null", [promptChars("SNS (略)"), promptChars(""), promptChars(null)], [3, 0, 0]);
{
  const game = readFileSync(new URL("../js/game.js", import.meta.url), "utf8");
  const mine = readFileSync(new URL("../js/recallSpeed.js", import.meta.url), "utf8");
  const re = String.raw`.replace(/[（(][^）)]*[）)]/g, "").trim()].length`;
  ok("字数: js/game.js promptLength（書き手の qLen）と同じ式", game.includes(re) && mine.includes(re));
}

// ---- 日番号（js/stats.js と同じ: 1970-01-01 からのローカル暦日の数） ----
eq("日番号: 1970-01-02 は 1・往復", [dayNoOf("1970-01-02"), ymdOfDayNo(dayNoOf(TODAY)), dayNoOf("2026-10-15") - dayNoOf("2026-10-03")], [1, TODAY, 12]);
eq("日番号: 読めない日は null", [dayNoOf("x"), ymdOfDayNo(1.5), ymdOfDayNo(null)], [null, null, null]);
eq("日番号: js/stats.js の dayNoOf（dayDiff(1970-01-01, ymd)）と同じ", dayNoOf(TODAY), dayDiff("1970-01-01", TODAY));

// ---- 出す語・出さない語 ----
{
  const base = { sp: sp3, prompt: "建物", today: TODAY };
  eq("段 2・3・4 には出す", [2, 3, 4].map((rank) => recallSpeedOf({ ...base, rank })?.speed), ["normal", "normal", "normal"]);
  eq("段 0・1・5 には出さない", [0, 1, 5, undefined, "4"].map((rank) => recallSpeedOf({ ...base, rank })), [null, null, null, null, null]);
  eq("材料 0・1 件は出さない（2 件から）", [[], [e(3, 1500, 100)], undefined, null, "x", {}].map((sp) => recallSpeedOf({ ...base, rank: 4, sp })), [null, null, null, null, null, null]);
  eq("材料 2 件で出す（n 2）", recallSpeedOf({ ...base, rank: 4, sp: sp3.slice(1) })?.n, 2);
  eq("訳 7 字は出す・8 字以上は出さない・括弧の中は数えない", ["あいうえおかき", "あいうえおかきく", "あいうえおかきくけこ", "あいうえおかき（くけこ）"].map((prompt) => !!recallSpeedOf({ ...base, rank: 3, prompt })), [true, false, false, true]);
  eq("形の違う件は材料に数えない（印に材料 a のビットが無い・日番号が整数でない・T1 が数でない・分類が無い）", recallSpeedOf({ ...base, rank: 3, sp: [e(9, 1500, 100), e(5, 1500, 100, "n", 2), [T - 4.5, 1500, 100, "n", MARK], [T - 3, "x", 100, "n", MARK], [T - 2, 1500, 100, null, MARK], "bad", null] }), null);
}

// ---- 語の値（q の中央値）と境 ----
{
  const sp = (...qs) => qs.map((q, i) => e(30 - i * 5, 1500, q));
  eq("q の中央値 75 は すぐ・76 は ふつう", [speedOfRecords(sp(70, 80)), speedOfRecords(sp(70, 82))], ["fast", "normal"]);
  eq("q の中央値 150 は ふつう・151 は 時間がかかる", [speedOfRecords(sp(140, 160)), speedOfRecords(sp(150, 152))], ["normal", "slow"]);
  eq("3 件は中央値（60・200・100 → 100 ふつう／40・70・300 → 70 すぐ）", [speedOfRecords(sp(60, 200, 100)), speedOfRecords(sp(40, 70, 300))], ["normal", "fast"]);
  eq("q が null の件は q の中央値に入れない（建物: 初めて q なし・14 日後 q 125 → ふつう、165 → 時間がかかる）", [speedOfRecords([e(14, 2500, null, "u", FIRST), e(0, 2500, 125)]), speedOfRecords([e(14, 3300, null, "u", FIRST), e(0, 3300, 165, "s")])], ["normal", "slow"]);
  eq("q が 1 件も無い: 最後の分類が すぐ なら すぐ・ほかは出さない", [speedOfRecords([e(9, 900, null, "u"), e(3, 900, null, "f")]), speedOfRecords([e(9, 900, null, "f"), e(3, 900, null, "u")]), speedOfRecords([e(9, 900, null, "n"), e(3, 900, null, "n")])], ["fast", null, null]);
  eq("q が無く最後の分類も すぐ でない語は行ごと出さない", recallSpeedOf({ sp: [e(9, 900, null, "f"), e(3, 900, null, "u")], rank: 3, prompt: "机", today: TODAY }), null);
  eq("並びは日の順に直してから「最後」を決める（保存の順によらない）", speedOfRecords([e(3, 900, null, "u"), e(9, 900, null, "f")].sort((a, b) => a[0] - b[0])), null);
  eq("recallSpeedOf も日の順に並べ直す", recallSpeedOf({ sp: [e(3, 900, null, "f"), e(9, 900, null, "u")], rank: 3, prompt: "机", today: TODAY })?.speed, "fast");
}

// ---- 返り値・文 ----
{
  const rs = recallSpeedOf({ sp: sp3, rank: 4, prompt: "建物", today: TODAY });
  eq("返り値: 速さ・語・件数・最後の日・古くない・記録は新しい順", rs, {
    speed: "normal",
    label: "ふつう",
    n: 3,
    last: "2026-10-10",
    old: false,
    records: [{ day: "2026-10-10", ms: 1400 }, { day: "2026-10-03", ms: 1200 }, { day: "2026-09-26", ms: 1600 }]
  });
  eq("行の文: 「ふつう ・ 最近 3 回の答えから」", recallSpeedText(rs), "ふつう ・ 最近 3 回の答えから");
  eq("畳んだ記録: 新しい順に「M月D日 N.N秒」・注記", recallSpeedLog(rs), "10月10日 1.4秒 ・ 10月3日 1.2秒 ・ 9月26日 1.6秒（出題から1打目まで。訳を読む時間を含む。この端末）");
  ok("行の文と畳んだ記録に「遅い」・%・予測の語が無い", !/遅い|%|％|予測|見込み|記憶率/.test(recallSpeedText(rs) + recallSpeedLog(rs)));
  const old = recallSpeedOf({ sp: [e(130, 1500, 160, "s"), e(91, 1500, 170, "s")], rank: 3, prompt: "机", today: TODAY });
  eq("最後の材料が 90 日より前（91 日）: 「（M月D日まで）」を添える", [old?.old, recallSpeedText(old)], [true, "時間がかかる ・ 最近 2 回の答えから（7月16日まで）"]);
  const edge = recallSpeedOf({ sp: [e(130, 1500, 160, "s"), e(90, 1500, 170, "s")], rank: 3, prompt: "机", today: TODAY });
  eq("ちょうど 90 日前は添えない", [edge?.old, recallSpeedText(edge)], [false, "時間がかかる ・ 最近 2 回の答えから"]);
  eq("今日が読めないときは古いと言わない", recallSpeedOf({ sp: [e(200, 1500, 50, "f"), e(150, 1500, 60, "f")], rank: 3, prompt: "机", today: "" })?.old, false);
  eq("秒は 0.1 秒に丸める（1,449ms → 1.4・1,450 → 1.5・12,340 → 12.3）", recallSpeedLog({ records: [{ day: "2026-10-03", ms: 1449 }, { day: "2026-10-02", ms: 1450 }, { day: "2026-10-01", ms: 12340 }] }), "10月3日 1.4秒 ・ 10月2日 1.5秒 ・ 10月1日 12.3秒（出題から1打目まで。訳を読む時間を含む。この端末）");
  eq("出さない語の文は空", [recallSpeedText(null), recallSpeedLog(null)], ["", ""]);
}

// ---- 単語帳に添える語（すぐ・時間がかかる の 2 つだけ） ----
{
  const of = (q) => recallSpeedOf({ sp: [e(9, 1500, q), e(3, 1500, q)], rank: 3, prompt: "机", today: TODAY });
  eq("単語帳: すぐ・時間がかかる だけ添え、ふつう・出さない語は空", [recallSpeedTag(of(50)), recallSpeedTag(of(160)), recallSpeedTag(of(100)), recallSpeedTag(null)], ["すぐ", "時間がかかる", "", ""]);
}

// ---- 数え上げ用の分類（recallSpeedClass）は recallSpeedOf と同じ答え（単語帳・学習データ。並べ替え・日付の文字なし） ----
{
  // 種を固定した擬似乱数で、段 0〜5・件数 0〜4・q（null・境の前後）・分類・壊れた件・並びの入れ替え・訳の字数を混ぜる
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  const QS = [null, null, 40, 75, 76, 100, 150, 151, 220];
  const CLS = ["f", "n", "s", "u"];
  const PROMPTS = ["机", "建物", "あいうえおかき", "あいうえおかきく", "請求書（インボイス）", ""];
  let same = 0;
  const diff = [];
  for (let k = 0; k < 3000; k++) {
    const n = rnd(5);
    const sp = Array.from({ length: n }, () => (rnd(10) === 0 ? ["bad"] : e(rnd(200), 500 + rnd(3000), QS[rnd(QS.length)], CLS[rnd(4)], rnd(8) === 0 ? 2 : MARK)));
    const args = { sp, rank: rnd(6), prompt: PROMPTS[rnd(PROMPTS.length)], today: TODAY };
    const a = recallSpeedClass(args);
    const b = recallSpeedOf(args)?.speed ?? null;
    if (a === b) same++;
    else if (diff.length < 3) diff.push({ args, a, b });
  }
  eq("数え上げ用の分類: 3,000 通りの種で recallSpeedOf の速さと同じ", { same, diff }, { same: 3000, diff: [] });
  eq("数え上げ用の分類: 単語帳の語（すぐ・時間がかかる・ふつうは空）", [recallSpeedTag("fast"), recallSpeedTag("slow"), recallSpeedTag("normal"), recallSpeedTag(null)], ["すぐ", "時間がかかる", "", ""]);
  eq("数え上げ用の分類: 形の違う sp（配列でない・1 件）・段の文字は null", [recallSpeedClass({ sp: "x", rank: 3, prompt: "机" }), recallSpeedClass({ sp: [e(3, 900, 50)], rank: 3, prompt: "机" }), recallSpeedClass({ sp: sp3, rank: "3", prompt: "机" })], [null, null, null]);
}

// ---- 書き手の sp の形（[日番号, T1, q, 分類, 印]）と分類の字 ----
eq("分類の字は書き手と同じ（f・n・s・u）", CLS_CHAR, { unknown: "u", fast: "f", normal: "n", slow: "s" });
ok("印は材料 a のビットが立つ（初めての答えも）", (MARK & 1) === 1 && (FIRST & 1) === 1 && (FIRST & 64) === 64);

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join("\n"));
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
