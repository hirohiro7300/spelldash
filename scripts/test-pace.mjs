// 一冊を終えるまでの目安（js/bookPace.js）の単体テスト。ブラウザなしで 1 秒で終わる:
//   node scripts/test-pace.mjs
// 失敗が 1 つでもあれば終了コード 1。
// 場合の多くは反証役の表（Batch 76 の P・T・R・Z）とレビュー（1a〜1d・2a・2b）を移したもの。創業者の決定（2026-10-24）とレビューの直し（B1・B2）に合わせて
// 期待を直した所は「（直し）」と書く: 1 日あたり = 進み ÷ 記録を始めてからの暦日数（上限 14）・365 日を超える日数は出さない・
// その回の本で初めて済みになった語だけ数える（外れて戻った語・ほかの本の共有語・同期・読み直し・回の外の答えは加えない。× で引かない）。
// 日の境は Asia/Tokyo と America/New_York（夏時間）の両方で確かめる。
process.env.TZ = "Asia/Tokyo";

import { isDeepStrictEqual } from "util";
import {
  PACE_KEY,
  PACE_WAIT,
  PACE_DEVICE_NOTE,
  PACE_COUNT_NOTE,
  readPace,
  observePace,
  countBooks,
  neverDone,
  freshIds,
  gainedIds,
  clampStart,
  paceSpan,
  roundDays,
  formatAvg,
  paceOf,
  paceText,
  todayNo
} from "../js/bookPace.js";
import { localDay, dayNoOf } from "../js/retentionCalc.js";

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond) => eq(name, !!cond, true);
const plain = (v) => JSON.parse(JSON.stringify(v));

const TODAY = dayNoOf("2026-10-24"); // 窓 = 2026-10-11 〜 2026-10-24
const OLD = TODAY - 30; // 14 日より前から記録している冊（割る日数 14）
const rowsOf = (pairs, today = TODAY) => pairs.map(([o, n]) => [today + o, n]);
// 表の 1 行の形: 「約14日（平均6語・残り84）」「学習を続けると…」「完了」「出さない」
function short(r) {
  if (r.kind === "pace") return `約${r.days}日（平均${r.avg}${r.unit}・残り${r.remaining}${r.span === 14 ? "" : `・${r.span}日で割る`}）`;
  if (r.kind === "wait") return r.long ? `学習を続けると…（約${r.days}日は出さない）` : "学習を続けると…";
  return r.kind === "done" ? "完了" : "出さない";
}
const P = (total, done, pairs, { today = TODAY, start = OLD } = {}) => short(paceOf({ total, done, rows: rowsOf(pairs), start, today }));

// ── 0. 鍵と文 ─────────────────────────────────────────
eq("鍵の名前", PACE_KEY, "spelldash_book_pace");
eq("待ちの文（決定 4）", PACE_WAIT, "学習を続けると、完了までの目安が表示されます。");
eq("端末の注（決定 5）", PACE_DEVICE_NOTE, "この端末の記録から計算しています。");
eq("済みの注（統合担当の決め 7）", PACE_COUNT_NOTE, "済み（覚えた・習得・知ってた）で数えています。");

// ── 1. 目安の式（P。日別の進みを直に入れる。記録は 14 日より前から） ─────────────
eq("P01 残り 0 語", P(150, 150, []), "完了");
eq("P02 残り 0 語（進みが多くても完了が先）", P(150, 150, [[0, 30], [-1, 30], [-2, 30]]), "完了");
eq("P03 語が 0 の冊は出さない（0 でも完了にしない）", P(0, 0, []), "出さない");
eq("P04 14 日間の進み 0", P(150, 66, []), "学習を続けると…");
eq("P05 1 日だけ（50 語）", P(150, 66, [[0, 50]]), "学習を続けると…");
eq("P06 2 日（50＋50 語）", P(150, 66, [[0, 50], [-1, 50]]), "学習を続けると…");
eq("P07 3 日ちょうど（1 語ずつ）: 約392日は 365 を超えるので出さない（直し）", P(150, 66, [[0, 1], [-5, 1], [-13, 1]]), "学習を続けると…（約392日は出さない）");
eq("P08 創業者の例（毎日 6 語）", P(150, 66, Array.from({ length: 14 }, (_, i) => [-i, 6])), "約14日（平均6語・残り84）");
eq("P09 3 日に 28 語ずつ（休んだ 11 日も 14 に入る）", P(150, 66, [[0, 28], [-1, 28], [-2, 28]]), "約14日（平均6語・残り84）");
eq("P10 丸め 0.5 日 → 1", P(10, 9, [[0, 10], [-1, 9], [-2, 9]]), "約1日（平均2語・残り1）");
eq("P11 1 日未満（0.17 日）→ 下限 1", P(10, 9, [[0, 28], [-1, 28], [-2, 28]]), "約1日（平均6語・残り1）");
eq("P12 丸め 3.5 日（R÷(G÷14) では 3 に落ちる）", P(100, 91, [[0, 12], [-1, 12], [-2, 12]]), "約4日（平均2.6語・残り9）");
eq("P13 丸め 24.5 日", P(100, 37, [[0, 12], [-1, 12], [-2, 12]]), "約25日（平均2.6語・残り63）");
eq("P14 丸め 30.5 日", P(100, 39, [[0, 10], [-1, 9], [-2, 9]]), "約31日（平均2語・残り61）");
eq("P15 丸め 3.33 日（下へ）", P(10, 5, [[0, 7], [-1, 7], [-2, 7]]), "約3日（平均1.5語・残り5）");
eq("P16 平均 1.43 語（日数は丸めた平均でなく進みから: 100÷1.4 = 71 ではない）", P(150, 50, [[0, 10], [-3, 5], [-6, 5]]), "約70日（平均1.4語・残り100）");
eq("P17 平均 0.5 語（整数にしない）", P(20, 10, [[0, 3], [-1, 2], [-2, 2]]), "約20日（平均0.5語・残り10）");
eq("P18 平均 10.36 語（10 以上は整数）", P(150, 50, [[0, 50], [-1, 50], [-2, 45]]), "約10日（平均10語・残り100）");
eq("P19 160 語の冊・3 日で 3 語（約747日）は出さない（直し）", P(160, 0, [[0, 1], [-1, 1], [-2, 1]]), "学習を続けると…（約747日は出さない）");
eq("P20 1,000 語・3 日で 3 語（約4667日）は出さない（直し）", P(1000, 0, [[0, 1], [-1, 1], [-2, 1]]), "学習を続けると…（約4667日は出さない）");
eq("P21 窓の境: 今日−14 は入らない（G 3。直し: 約392日は出さない）", P(150, 66, [[-14, 10], [-13, 1], [-7, 1], [0, 1]]), "学習を続けると…（約392日は出さない）");
eq("P21b 窓の境: −13 の 11 語は入る", P(150, 66, [[-13, 11], [-7, 1], [0, 1]]), "約90日（平均0.9語・残り84）");
eq("P22 窓の境: 今日−14 を除くと 2 日", P(150, 66, [[-14, 10], [-13, 1], [0, 1]]), "学習を続けると…");
eq("P23 今日より後の日は数えない", P(150, 66, [[1, 5], [0, 1], [-1, 1]]), "学習を続けると…");
eq("P24 0 の日が混ざる（0 は進んだ日でない。直し: 約392日は出さない）", P(150, 66, [[0, 1], [-1, 0], [-2, 1], [-3, 1]]), "学習を続けると…（約392日は出さない）");
eq("P25 今日の分で 3 日目（今日を含む）", P(150, 66, [[0, 1], [-6, 2], [-12, 3]]), "約196日（平均0.4語・残り84）");
eq("上限ちょうど 365 日は出す", P(400, 35, Array.from({ length: 14 }, (_, i) => [-i, 1])), "約365日（平均1語・残り365）");
eq("上限 366 日は出さない", P(400, 34, Array.from({ length: 14 }, (_, i) => [-i, 1])), "学習を続けると…（約366日は出さない）");
// 純増: 進みの和が 0 以下なら、増えた日が 3 日以上でも出さない
eq("純増が 0（+1 が 3 日・−3 が 1 日）", P(150, 66, [[0, 1], [-1, 1], [-2, 1], [-3, -3]]), "学習を続けると…");
eq("純増が負", P(150, 66, [[0, 1], [-1, 1], [-2, 1], [-3, -5]]), "学習を続けると…");
eq("減った日は進んだ日に数えない（+ が 2 日・− が 1 日）", P(150, 66, [[0, 20], [-1, 20], [-2, -1]]), "学習を続けると…");
eq("減った日があっても純増と + の日で出す（84×14÷(30−2)）", P(150, 66, [[0, 10], [-1, 10], [-2, 10], [-3, -2]]), "約42日（平均2語・残り84）");
eq("壊れた数（done が total より大きい）は完了", P(10, 12, []), "完了");
eq("壊れた数（total が数でない）は出さない", short(paceOf({ total: NaN, done: 0, rows: [], today: TODAY })), "出さない");
eq("同じ日の行が 2 つあっても 1 日（和）", P(150, 66, [[0, 3], [0, 3], [-1, 6], [-2, 6]]), "約65日（平均1.3語・残り84）");
eq("同じ日の行が 2 つで 2 日にならない（2 日なら出さない）", P(150, 66, [[0, 3], [0, 3], [-1, 6]]), "学習を続けると…");

// 割る日数（創業者の決定 1）: 記録を始めてからの暦日数（今日を含む・上限 14）。学習した日数では割らない
eq("割る日数: 今日始めた → 1、4 日前 → 5、13 日前 → 14、30 日前 → 14", [paceSpan(TODAY, TODAY), paceSpan(TODAY - 4, TODAY), paceSpan(TODAY - 13, TODAY), paceSpan(OLD, TODAY)], [1, 5, 14, 14]);
eq("割る日数: 始めた日が読めない → 14（短く見せない）・今日より後（時計が戻った）→ 1", [paceSpan(null, TODAY), paceSpan(TODAY + 3, TODAY)], [14, 1]);
eq("始めて 4 日（今日を含む）・毎日 10 語・残り 110（直し: 14 で割ると約39日）", P(150, 40, [[0, 10], [-1, 10], [-2, 10], [-3, 10]], { start: TODAY - 3 }), "約11日（平均10語・残り110・4日で割る）");
eq("始めて 5 日・学んだのは 3 日（学習した日数で割らない: 30÷5 = 6）", P(150, 66, [[0, 10], [-2, 10], [-4, 10]], { start: TODAY - 4 }), "約14日（平均6語・残り84・5日で割る）");
eq("始めて 3 日・3 日とも進んだ（最短で出る日）", P(150, 66, [[0, 6], [-1, 6], [-2, 6]], { start: TODAY - 2 }), "約14日（平均6語・残り84・3日で割る）");
eq("始めて 2 日では 3 日たまらない", P(150, 66, [[0, 6], [-1, 6]], { start: TODAY - 1 }), "学習を続けると…");
eq("始めて 10 日・割る日数 10（R×10÷G の四捨五入: 84×10÷30 = 28）", P(150, 66, [[0, 10], [-4, 10], [-9, 10]], { start: TODAY - 9 }), "約28日（平均3語・残り84・10日で割る）");

// 丸めの式の網（P26）: R×D÷G の四捨五入を整数で。R÷(G÷D) は浮動小数で 1 日ずれる組がある
{
  let bad = 0;
  let floatBad = 0;
  for (const span of [14, 5, 3])
    for (let r = 1; r <= 600; r++)
      for (let g = 3; g <= 1200; g++) {
        const want = Math.max(1, Math.floor((2 * r * span + g) / (2 * g)));
        if (roundDays(r, g, span) !== want) bad++;
        if (Math.max(1, Math.round(r / (g / span))) !== want) floatBad++;
      }
  eq("P26 丸めの網（R 1〜600 × G 3〜1200 × 割る日数 14・5・3）: 整数の式と一致", bad, 0);
  ok("P26 R÷(G÷D) は狂う組がある（使っていないことの確かめ）", floatBad > 0);
}
eq("平均の見せ方: 割り切れる → 整数", [formatAvg(84), formatAvg(28), formatAvg(14), formatAvg(30, 5)], ["6", "2", "1", "6"]);
eq("平均の見せ方: 10 未満は小数 1 桁", [formatAvg(3), formatAvg(7), formatAvg(20), formatAvg(36), formatAvg(85), formatAvg(13), formatAvg(7, 3)], ["0.2", "0.5", "1.4", "2.6", "6.1", "0.9", "2.3"]);
eq("平均の見せ方: 10 以上は四捨五入の整数", [formatAvg(140), formatAvg(145), formatAvg(147), formatAvg(1400), formatAvg(52, 5)], ["10", "10", "11", "100", "10"]);

// ── 2. 文（決定 5・統合担当の決め 6・7） ─────────────────────
{
  const r = paceOf({ total: 150, done: 66, rows: rowsOf(Array.from({ length: 14 }, (_, i) => [-i, 6])), start: OLD, today: TODAY });
  eq("文: 目安あり（決定 5 の 4 行＋済みの注）", paceText(r), ["残り84語", "最近14日間は、1日平均6語進んでいます。", "今のペースなら、完了まであと約14日が目安です。", "この端末の記録から計算しています。", "済み（覚えた・習得・知ってた）で数えています。"]);
  eq("文: 数は太字の所（num）に入る", r.parts.map((p) => p.num ?? null), [84, "6", 14, null, null]);
  eq("文: 注は note", r.parts.map((p) => !!p.note), [false, false, false, true, true]);
  const short5 = paceOf({ total: 150, done: 66, rows: rowsOf([[0, 10], [-2, 10], [-4, 10]]), start: TODAY - 4, today: TODAY });
  eq("文: 記録が 14 日に満たない間は「最近N日間」（割った日数）", paceText(short5)[1], "最近5日間は、1日平均6語進んでいます。");
  const w = paceOf({ total: 150, done: 66, rows: [], start: OLD, today: TODAY });
  eq("文: 待ち（残りは出す・日数と平均は出さない）", paceText(w), ["残り84語", "学習を続けると、完了までの目安が表示されます。", "済み（覚えた・習得・知ってた）で数えています。"]);
  eq("文: 完了", paceText(paceOf({ total: 150, done: 150, rows: [], today: TODAY })), ["完了", "済み（覚えた・習得・知ってた）で数えています。"]);
  eq("文: 語の無い冊は何も出さない", paceText(paceOf({ total: 0, done: 0, rows: [], today: TODAY })), []);
  const c = paceOf({ total: 75, done: 33, rows: rowsOf([[0, 6], [-1, 6], [-2, 6]]), start: OLD, today: TODAY, unit: "枚" });
  eq("文: 概念カードの冊は「枚」（道と同じ）", paceText(c).slice(0, 3), ["残り42枚", "最近14日間は、1日平均1.3枚進んでいます。", "今のペースなら、完了まであと約33日が目安です。"]);
  eq("文: 待ちでも単位は「枚」", paceText(paceOf({ total: 75, done: 33, rows: [], today: TODAY, unit: "枚" }))[0], "残り42枚");
  ok("文: 言い切らない（「約」「目安」）・絵文字なし", /約\d+日が目安です。$/.test(paceText(r)[2]) && !/[\u{1F300}-\u{1FAFF}]/u.test(paceText(r).join("")));
}

// ── 3. 記録の形（読む・壊れた値） ─────────────────────────
const EMPTY = { v: 1, at: null, b: {} };
eq("読めない JSON → 空", plain(readPace("{oops")), EMPTY);
eq("null → 空", plain(readPace(null)), EMPTY);
eq("配列 → 空", plain(readPace("[1,2]")), EMPTY);
eq("版が違う（v 2）→ 空（置き直す）", plain(readPace(JSON.stringify({ v: 2, at: 1, b: { a: { s: 1, p: [] } } }))), EMPTY);
eq("b が配列 → 冊なし", plain(readPace(JSON.stringify({ v: 1, at: 3, b: [1] }))), { v: 1, at: 3, b: {} });
{
  const raw = JSON.stringify({
    v: 1,
    at: TODAY,
    b: {
      good: { s: TODAY - 3, p: [[TODAY, 2], [TODAY - 1, 1]] },
      arr: [1, 2],
      str: "x",
      rows: { s: TODAY - 9, p: [[TODAY, 1], "x", [TODAY - 2], [TODAY - 3, "2"], [TODAY - 4, 0], [TODAY - 5, 1.5], [-3, 1], [TODAY, 2]] },
      noP: { s: "x" },
      old: { n: 5, s: TODAY - 1, p: [], off: 1 },
      PROTO: { s: 1, p: [] }
    }
  }).replace('"PROTO"', '"__proto__"'); // JSON の中の "__proto__" の名（オブジェクトの書き方では型になるので文字で置く）
  const s = readPace(raw);
  eq("壊れた行を捨てる: 冊でない値（配列・文字）は捨てる", Object.keys(s.b).sort(), ["__proto__", "good", "noP", "old", "rows"].sort());
  eq("壊れた行を捨てる: 日は昇順・同じ日は和・0 と数でない行は捨てる", plain(s.b.rows), { s: TODAY - 9, p: [[TODAY, 3]] });
  eq("p の無い行は空の p・読めない始めた日は null", plain(s.b.noP), { s: null, p: [] });
  eq("前の形の欄（n・off）は読まない", plain(s.b.old), { s: TODAY - 1, p: [] });
  ok("__proto__ の名の冊で型が変わらない", Object.getPrototypeOf(s.b) === null && s.b["__proto__"].s === 1);
  eq("at は残る・数でなければ null", [s.at, readPace(JSON.stringify({ v: 1, at: "x", b: {} })).at], [TODAY, null]);
  eq("書いて読み直しても同じ", plain(readPace(JSON.stringify(s))), plain(s));
}

// ── 4. 写す（observePace）: 冊の行を置き、その回の本に進みを足す ─────────────
{
  let s = observePace(readPace(null), { books: ["a", "b"], today: TODAY - 2 });
  eq("初めての写しは行を置くだけ（記録を始めた日 = その日）", plain([s.b.a, s.b.b, s.at]), [{ s: TODAY - 2, p: [] }, { s: TODAY - 2, p: [] }, TODAY - 2]);
  s = observePace(s, { books: ["a", "b"], today: TODAY - 2, gains: [{ book: "a", n: 3 }] });
  eq("進み: その回の本（a）の今日の行に足す。ほかの本（b）は変えない", plain([s.b.a, s.b.b]), [{ s: TODAY - 2, p: [[TODAY - 2, 3]] }, { s: TODAY - 2, p: [] }]);
  s = observePace(s, { books: ["a", "b"], today: TODAY - 2, gains: [{ book: "a", n: 2 }, { book: "b", n: 1 }] });
  eq("同じ日の 2 回目は和", plain([s.b.a.p, s.b.b.p]), [[[TODAY - 2, 5]], [[TODAY - 2, 1]]]);
  const same = observePace(s, { books: ["a", "b"], today: TODAY - 2, gains: [{ book: "a", n: 0 }, { book: "a", n: -2 }, { book: "a", n: 1.5 }, { book: "", n: 1 }, null] });
  eq("0・負・小数・名の無い進みは足さない（× で引かない）", plain(same.b.a.p), [[TODAY - 2, 5]]);
  const c = observePace(s, { books: ["a", "b", "c"], today: TODAY });
  eq("あとから足した冊は、その日から記録を始める", plain(c.b.c), { s: TODAY, p: [] });
  const gone = observePace(c, { books: ["c"], today: TODAY });
  eq("読み込んでいない冊: 窓の中に進みのある冊（a・b）は残し、進みの無い冊は捨てる", Object.keys(gone.b).sort(), ["a", "b", "c"]);
  const later = observePace(c, { books: ["c"], today: TODAY + 20 });
  eq("読み込んでいない冊の進みが窓の外へ出たら捨てる", Object.keys(later.b).sort(), ["c"]);
  const keep = observePace(c, { books: null, today: TODAY, gains: [{ book: "z", n: 2 }] });
  eq("冊の一覧を渡さない写しは冊を捨てない・行の無い本への進みは行を作る", [Object.keys(keep.b).sort(), plain(keep.b.z)], [["a", "b", "c", "z"], { s: TODAY, p: [[TODAY, 2]] }]);
  eq("前の状態は書き換えない", plain(s.b.a.p), [[TODAY - 2, 5]]);
  eq("今日が数でなければ何もしない", observePace(s, { books: ["a"], today: NaN, gains: [{ book: "a", n: 9 }] }), s);
}
// 窓の外・時計
{
  let s = observePace(readPace(null), { books: ["a"], today: TODAY - 40 });
  for (let d = TODAY - 39; d <= TODAY; d++) s = observePace(s, { books: ["a"], today: d, gains: [{ book: "a", n: 1 }] });
  eq("毎日足しても p は直近 14 日だけ（上限）", s.b.a.p.length, 14);
  eq("p の最初の日は今日−13・始めた日は残る", [s.b.a.p[0][0], s.b.a.s], [TODAY - 13, TODAY - 40]);
  ok("40 日分を書いても 1 冊 1KB 未満", JSON.stringify(s).length < 1024);
  const back = observePace(s, { books: ["a"], today: TODAY - 3, gains: [{ book: "a", n: 5 }] });
  eq("時計が戻った（今日 < 前に写した日）: その写しの進みは足さない・未来の日の行は捨てる・at は端末の今日", [back.b.a.p.some(([d]) => d > TODAY - 3), back.b.a.p.at(-1), back.at], [false, [TODAY - 3, 1], TODAY - 3]);
  const fwd = observePace(back, { books: ["a"], today: TODAY - 3, gains: [{ book: "a", n: 2 }] });
  eq("戻した後の次の写しからは足す", fwd.b.a.p.at(-1), [TODAY - 3, 3]);
}
// 記録を始めた日（反証役のレビュー B2）: 今日より後にしない・窓の中の行より後にしない
{
  eq("clampStart: 未来 → 今日・行のいちばん早い日 → その日・読めない → null", [clampStart(TODAY + 30, [], TODAY), clampStart(TODAY, [[TODAY - 5, 1]], TODAY), clampStart("x", [], TODAY), clampStart(TODAY - 3, [[TODAY + 2, 1]], TODAY)], [TODAY, TODAY - 5, null, TODAY - 3]);
  // 2a: 時計が +30 日の状態でホームを開き（初めて見た冊）、時計を戻してから 3 日 10 語ずつ学ぶ
  let s = observePace(readPace(null), { books: ["A"], today: TODAY + 30 });
  eq("2a 時計が進んだ日に初めて見た冊の s は進んだ日", s.b.A.s, TODAY + 30);
  s = observePace(s, { books: ["A"], today: TODAY - 2 }); // 時計を戻した（ホームの読み込み）
  eq("2a 時計を戻した後の写しで s は今日に詰める", s.b.A.s, TODAY - 2);
  for (const d of [TODAY - 2, TODAY - 1, TODAY]) s = observePace(s, { books: ["A"], today: d, gains: [{ book: "A", n: 10 }] });
  const r = paceOf({ total: 100, done: 30, rows: s.b.A.p, start: s.b.A.s, today: TODAY });
  eq("2a 3 日 10 語ずつ → 最近3日間・1日平均10語・残り70 → 約7日（直す前は「最近1日間」「約2日」）", [paceText(r)[1], paceText(r)[2]], ["最近3日間は、1日平均10語進んでいます。", "今のペースなら、完了まであと約7日が目安です。"]);
  // 2b: 壊れた s（今日 + 999）でも、表示の側でも詰める
  const rows = rowsOf([[0, 10], [-1, 10], [-2, 10]]);
  eq("2b 壊れた s（今日+999）: 割る日数は行のいちばん早い日から（3）", [paceSpan(TODAY + 999, TODAY, rows), paceText(paceOf({ total: 100, done: 30, rows, start: TODAY + 999, today: TODAY }))[1]], [3, "最近3日間は、1日平均10語進んでいます。"]);
  eq("2b 壊れた s を写しで詰める", observePace({ v: 1, at: TODAY, b: { A: { s: TODAY + 999, p: rows } } }, { books: ["A"], today: TODAY }).b.A.s, TODAY - 2);
  eq("始めた日より前の行が窓にある（行が先に書かれた）: 割る日数はその行から", paceSpan(TODAY - 1, TODAY, rowsOf([[0, 1], [-6, 1]])), 7);
}

// ── 5. 冊の数え方（countBooks）・回の控え（freshIds・gainedIds） ───────────────
{
  const done = new Set(["a", "b", "k", "m"]);
  let calls = 0;
  const isDone = (id) => (calls++, done.has(id));
  const out = countBooks([{ id: "A", ids: ["a", "b", "c", "a"] }, { id: "B", ids: ["a", "d", "k", "m", "z"] }, { id: "E", ids: [] }], isDone);
  eq("冊ごとの済みの数（冊の中の同じ id は 1 語・同じ id は両方の冊で済み）", out, { A: 2, B: 3, E: 0 });
  eq("語ごとの判定は 1 回（id ごとに覚える）", calls, 7);
  eq("語の数（重複を除く）", countBooks([{ id: "A", ids: ["a", "a", "b"] }], () => false, { total: true }), { A: { done: 0, total: 2 } });
  const T0 = Date.parse("2026-10-24T09:00:00+09:00");
  const stats = {
    seen: { playCount: 1 }, // 出題だけ
    weakNew: { playCount: 1, recallFail: 1, lastRecallFailAt: new Date(T0 - 1000).toISOString() }, // 初めての答えが ×
    ok: { lastRecallSuccessAt: new Date(T0 - 86400000).toISOString() },
    weakOld: { recallFail: 1, lastRecallSuccessAt: new Date(T0 - 86400000 * 3).toISOString(), lastRecallFailAt: new Date(T0 - 86400000).toISOString() }, // 一度済みになって外れた
    known: { knownOnSight: true },
    mastered: { mastered: true }
  };
  eq("一度も済みになったことの無い語: 未着手・出題だけ・初めての答えが × の語（自力正解・知ってた・習得のある語は入らない）", [...freshIds(["none", "seen", "weakNew", "ok", "weakOld", "known", "mastered", "none"], stats)], ["none", "seen", "weakNew"]);
  ok("neverDone", neverDone(undefined) && neverDone({}) && !neverDone({ lastRecallSuccessAt: "2026-01-01T00:00:00Z" }) && !neverDone({ knownOnSight: true }) && !neverDone({ mastered: true }));
  const after = { ...stats, none: { lastRecallSuccessAt: new Date(T0 + 5000).toISOString() }, seen: { lastRecallSuccessAt: new Date(T0 - 5000).toISOString() }, weakNew: { recallFail: 1, lastRecallFailAt: new Date(T0 + 9000).toISOString(), lastRecallSuccessAt: new Date(T0 + 8000).toISOString() } };
  const doneNow = (id) => id === "none" || id === "seen";
  eq("回で初めて済みになった語: 控えのうち今済みで、自力正解が回の始めより後（同期で届いた古い正解は数えない）", gainedIds(new Set(["none", "seen", "weakNew"]), after, doneNow, T0), ["none"]);
}

// ── 6. 回ごとの流れ（T・反証役のレビュー 1a〜1d。端末で答えて、写すまでを模す） ─────────
// 語の記録は js/stats.js の書き手の欄だけ（○: 自力正解の日時・×: 思い出せずの日時と回数・k: 知ってた）。済みの判定は js/categoryProgress.js classifyWord と同じ形。
// steps: [日（今日からの差）, 何をしたか, …]
//   ["study", 本, [[語, "o"|"x"|"k"], ...]]  … その本の Study の回（始めに控え・終わりに数える）
//   ["play", [[語, "o"|"x"], ...]]            … Challenge・Daily・Battle・別のページ（本に属さない答え。数えない）
//   ["sync", [[語, "o"|"x", 何日前の答えか]]]   … 同期で届いた別の端末の答え
//   ["reload", 冊の中身]                       … パックの出し入れ・版の変化（冊の一覧が替わる）
function simulate({ books, before = [], steps }) {
  const stats = {};
  let clock = 0;
  const stamp = (o) => new Date(Date.UTC(2026, 9, 24 + o, 0, 0, 0) + 3600000 + ++clock * 1000).toISOString(); // その日の 9 時台（東京）
  const answer = (id, r, at) => {
    const st = (stats[id] = { ...(stats[id] ?? { playCount: 0, recallFail: 0 }) });
    st.playCount++;
    if (r === "x") {
      st.recallFail++;
      st.lastRecallFailAt = at;
    } else {
      if (r === "k") st.knownOnSight = true;
      st.lastRecallSuccessAt = at;
    }
  };
  const isDone = (id) => {
    const st = stats[id];
    if (!st || !st.playCount) return false;
    if (st.knownOnSight && !st.recallFail && !st.mastered) return true;
    if (st.mastered) return true;
    if (st.lastRecallFailAt && (!st.lastRecallSuccessAt || Date.parse(st.lastRecallFailAt) > Date.parse(st.lastRecallSuccessAt))) return false;
    return !!st.lastRecallSuccessAt;
  };
  for (const id of before) answer(id, "o", new Date(Date.UTC(2026, 8, 1)).toISOString()); // 窓より前から済み
  let shelf = { ...books };
  let s = observePace(readPace(null), { books: Object.keys(shelf), today: TODAY - 20 });
  for (const [o, kind, a, b] of steps) {
    const today = TODAY + o;
    if (kind === "study") {
      const since = Date.parse(stamp(o));
      const fresh = freshIds(shelf[a] ?? [], stats);
      for (const [id, r] of b) answer(id, r, stamp(o));
      const n = gainedIds(fresh, stats, isDone, since).length;
      s = observePace(s, { books: Object.keys(shelf), today, gains: [{ book: a, n }] });
    } else if (kind === "play") {
      for (const [id, r] of a) answer(id, r, stamp(o));
      s = observePace(s, { books: Object.keys(shelf), today });
    } else if (kind === "sync") {
      for (const [id, r, ago] of a) answer(id, r, new Date(Date.parse(stamp(o)) - ago * 86400000).toISOString());
      s = observePace(s, { books: Object.keys(shelf), today });
    } else if (kind === "reload") {
      shelf = a;
      s = observePace(s, { books: Object.keys(shelf), today });
    }
  }
  const doneOf = (book) => (shelf[book] ?? []).filter((id, i, all) => all.indexOf(id) === i && isDone(id)).length;
  return { s, doneOf, total: (book) => new Set(shelf[book] ?? []).size };
}
const rowsText = (p) => (p?.length ? p.map(([d, n]) => `${d - TODAY}:${n}`).join(" ") : "なし");
const T = (input, book = "A") => rowsText(simulate(input).s.b[book]?.p);
const paceAt = (r, book = "A", today = TODAY) => short(paceOf({ total: r.total(book), done: r.doneOf(book), rows: r.s.b[book]?.p ?? [], start: r.s.b[book]?.s, today }));
{
  // 創業者の決定 5: 同じ日に 済み → 未済み → 済み を二重に加えない。数えるのは初めて済みになった語だけ（外れて戻った語は数えない。× で引かない）
  eq("T01 窓より前から済み・同じ日の回で × → ○: 進みなし", T({ books: { A: ["a"] }, before: ["a"], steps: [[0, "study", "A", [["a", "x"], ["a", "o"]]]] }), "なし");
  eq("T02 同じ回で 未着手→済み→未済み→済み: 1（2 にしない）", T({ books: { A: ["a"] }, steps: [[0, "study", "A", [["a", "o"], ["a", "x"], ["a", "o"]]]] }), "0:1");
  eq("T02b 同じ日の 2 回に分かれた（○ × で終わり、次の回で ○）: 0（外れて戻った語。直し: 純増の作りでは 1）", T({ books: { A: ["a"] }, steps: [[0, "study", "A", [["a", "o"], ["a", "x"]]], [0, "study", "A", [["a", "o"]]]] }), "なし");
  eq("T03 同じ回で 未着手→済み→未済みで終わる: なし", T({ books: { A: ["a"] }, steps: [[0, "study", "A", [["a", "o"], ["a", "x"]]]] }), "なし");
  eq("T03b 初めての答えが × で、同じ回で ○: 1（学習の回の形）", T({ books: { A: ["a"] }, steps: [[0, "study", "A", [["a", "x"], ["a", "o"]]]] }), "0:1");
  eq("T04 外れて次の日に戻る（窓より前から済み）: なし（直し: 純増の作りでは −1 と +1）", T({ books: { A: ["a"] }, before: ["a"], steps: [[-3, "study", "A", [["a", "x"]]], [-2, "study", "A", [["a", "o"]]]] }), "なし");
  eq("T05 入る→外れる→また入る: 入った日だけ（直し: 純増では −6:−1 −2:1 も）", T({ books: { A: ["a"] }, steps: [[-10, "study", "A", [["a", "o"]]], [-6, "study", "A", [["a", "x"]]], [-2, "study", "A", [["a", "o"]]]] }), "-10:1");
  eq("T06 外れたまま: なし（直し: 純増では −3:−1）", T({ books: { A: ["a"] }, before: ["a"], steps: [[-3, "study", "A", [["a", "x"]]]] }), "なし");
  eq("T07 知ってた", T({ books: { A: ["a"] }, steps: [[-4, "study", "A", [["a", "k"]]]] }), "-4:1");
  {
    // T08: 新しい語 0・毎日 1 語の復習のつまずきを翌日に戻すだけ（30 語・20 語は窓より前から済み）→ 出さない
    const ids = Array.from({ length: 30 }, (_, i) => `w${i}`);
    const steps = [];
    for (let o = -13; o <= 0; o++) steps.push([o, "study", "A", [...(o > -13 ? [[`w${o + 12}`, "o"]] : []), ...(o < 0 ? [[`w${o + 13}`, "x"]] : [])]]);
    const r = simulate({ books: { A: ids }, before: ids.slice(0, 20), steps });
    eq("T08 復習のつまずきを翌日に戻すだけ: 進みなし・目安を出さない", [rowsText(r.s.b.A.p), paceAt(r)], ["なし", "学習を続けると…"]);
  }
  // 反証役のレビュー B1: 外れ（Challenge・別の本の回・同期・Battle）と戻り（Study の回）を二重に数えない（直す前の木では +2・日数が出る）
  eq("1a 同じ日 Study で覚える → Challenge の × → Study で戻す: 1（直す前は 2）", T({ books: { A: ["w", "a"] }, steps: [[0, "study", "A", [["w", "o"]]], [0, "play", [["w", "x"]]], [0, "study", "A", [["w", "o"]]]] }), "0:1");
  {
    const r = simulate({ books: { A: ["w", "a"], B: ["w", "b"] }, steps: [[0, "study", "A", [["w", "o"]]], [0, "study", "B", [["w", "x"]]], [0, "study", "A", [["w", "o"]]]] });
    eq("1b 共有の語 w: A の回で覚える → B の回で外す → A の回で戻す: A は 1・B は 0（直す前は A が 2）", [rowsText(r.s.b.A.p), rowsText(r.s.b.B.p)], ["0:1", "なし"]);
  }
  eq("1c Study で覚える → 同期で別の端末の × が届く → Study で戻す: 1（直す前は 2）", T({ books: { A: ["w", "a"] }, steps: [[0, "study", "A", [["w", "o"]]], [0, "sync", [["w", "x", 0]]], [0, "study", "A", [["w", "o"]]]] }), "0:1");
  {
    // 1d: 新しい語 0。窓より前から済みの語を毎日 1 語 Battle で外し、次の Study で戻す（13 日。残りは減らない）
    const ids = Array.from({ length: 30 }, (_, i) => `o${i}`);
    const steps = [];
    for (let k = 13; k >= 1; k--) steps.push([-k, "play", [[`o${k}`, "x"]]], [-k, "study", "A", [[`o${k}`, "o"]]]);
    const r = simulate({ books: { A: ids }, before: ids.slice(0, 20), steps });
    eq("1d 新しい語 0・毎日 Battle で外し Study で戻す（13 日）: 進みなし・目安を出さない（直す前は「約11日」）", [rowsText(r.s.b.A.p), paceAt(r, "A", TODAY - 1)], ["なし", "学習を続けると…"]);
  }
  // 創業者の決定 4: 別の本で共有の語が済みになった変化を、今の本に加えない
  {
    const r = simulate({ books: { A: ["a", "b", "c"], B: ["a", "d", "e"] }, steps: [[-3, "study", "B", [["d", "o"]]], [-2, "study", "A", [["b", "o"]]], [-1, "study", "A", [["a", "o"]]]] });
    eq("T09 同じ id が 2 冊: A の回で覚えた共有の a は A だけ（B は −3 の自分の回だけ。直し: 反証役の表では B も進む）", [rowsText(r.s.b.A.p), rowsText(r.s.b.B.p)], ["-2:1 -1:1", "-3:1"]);
    eq("T09 B の残りは共有の a の分も減る（済みの数は今の記録）", r.doneOf("B"), 2);
    const r2 = simulate({
      books: { A: ["a1", "a2", "a3", "s1", "s2", "s3"], B: ["s1", "s2", "s3", "b1", "b2", "b3", "b4", "b5"] },
      steps: [[-5, "study", "A", [["s1", "o"], ["s2", "o"], ["s3", "o"]]], [-3, "study", "B", [["b1", "o"]]], [-2, "study", "B", [["b2", "o"]]], [-1, "study", "B", [["b3", "o"]]]]
    });
    eq("別の本の共有語: B の進みは自分の回の 3 語だけ（A の回の 3 語は加えない）", rowsText(r2.s.b.B.p), "-3:1 -2:1 -1:1");
    const r3 = simulate({ books: { A: ["s1", "a1"], B: ["s1", "b1"] }, steps: [[-2, "study", "A", [["s1", "o"]]], [-1, "study", "B", [["s1", "x"], ["s1", "o"]]]] });
    eq("A で覚えた共有の語を B の回で × → ○: B は 0（一度済みになった語）", rowsText(r3.s.b.B.p), "なし");
  }
  // 創業者の決定 4: 同期で届いた変化を加えない（T12・T12b）
  for (const [name, ago] of [["T12 同期で 20〜60 日前の完了 40 語が今日届く", 40], ["T12b 届いた 40 語が別の端末で窓の中（3 日前）に覚えた語", 3]]) {
    const ids = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const r = simulate({ books: { A: ids }, steps: [[-2, "study", "A", [["s50", "o"]]], [-1, "study", "A", [["s51", "o"]]], [0, "study", "A", [["s52", "o"]]], [0, "sync", ids.slice(0, 40).map((id) => [id, "o", ago])]] });
    eq(`${name}: この端末の回の 3 語だけ（約266日）`, paceAt(r), "約266日（平均0.2語・残り57）");
  }
  {
    // 回の途中で同期が届いた（届いた語は回の控えにあるが、正解の日時は回の始めより前）
    const stats = { y0: { playCount: 1, lastRecallSuccessAt: "2026-10-01T00:00:00.000Z" }, y1: { playCount: 1, lastRecallSuccessAt: "2026-10-24T01:00:05.000Z" } };
    const since = Date.parse("2026-10-24T01:00:00.000Z");
    eq("回の途中に届いた古い正解は数えない・この回の正解は数える", gainedIds(new Set(["y0", "y1"]), stats, () => true, since), ["y1"]);
  }
  // 創業者の決定 4: パックの読み直し・版の変化を加えない（T10・T11）
  {
    const r = simulate({
      books: { P: ["p1", "p2", "p3", "p4"], Q: ["p1", "q1"] },
      steps: [[-6, "study", "P", [["p2", "o"]]], [-5, "reload", { Q: ["p1", "q1"] }], [-4, "study", "Q", [["p1", "o"]]], [-2, "reload", { P: ["p1", "p2", "p3", "p4"], Q: ["p1", "q1"] }], [-1, "study", "P", [["p3", "o"]]]]
    });
    eq("T10 本を外して足し直す: 外した間に別の本で覚えた共有の p1 は加えない（直し: 反証役の表では −4 も入る）", rowsText(r.s.b.P.p), "-6:1 -1:1");
    const v = simulate({ books: { V: ["a", "b", "c", "d"] }, steps: [[-3, "study", "V", [["d", "o"]]], [-3, "reload", { V: ["a", "b", "c", "e", "f"] }], [-2, "study", "V", [["a", "o"]]], [-1, "study", "V", [["b", "o"]]]] });
    eq("T11 パックの版の変化（d 消・e f 増）: 過去の行は書いたときのまま（直し: 反証役の表は今の中身で数え直す）", rowsText(v.s.b.V.p), "-3:1 -2:1 -1:1");
  }
  eq("Challenge・Daily・Battle で初めて済みになった語は数えない（済みには入る）", T({ books: { A: ["a", "b", "c"] }, steps: [[-2, "play", [["a", "o"]]], [-1, "study", "A", [["b", "o"]]], [0, "play", [["c", "o"], ["b", "x"]]]] }), "-1:1");
  {
    // R12: 回の終わりに数える。ページを開いたときだけ写す作り（回の外の写しだけ）なら進みは入らない
    const ids = Array.from({ length: 168 }, (_, i) => `r${i}`);
    const steps = [];
    for (let o = -13, k = 0; o <= 0; o++) steps.push([o, "study", "A", Array.from({ length: 6 }, () => [`r${k++}`, "o"])]);
    eq("R12 毎日 6 語を回の終わりに数える: 約14日（決定 5 の例）", paceAt(simulate({ books: { A: ids }, steps })), "約14日（平均6語・残り84）");
    eq("R12 回の外の写しだけなら進みは入らない", rowsText(simulate({ books: { A: ids }, steps: steps.map(([o, , , list]) => [o, "play", list]) }).s.b.A.p), "なし");
  }
  {
    // T13: 時計を +30 日 → 3 日学ぶ → 戻す
    let s = observePace(readPace(null), { books: ["A"], today: TODAY - 1 });
    for (const d of [30, 31, 32]) s = observePace(s, { books: ["A"], today: TODAY + d, gains: [{ book: "A", n: 1 }] });
    eq("T13 時計を進めている間は出る（その日の今日で数える）", short(paceOf({ total: 4, done: 3, rows: s.b.A.p, start: s.b.A.s, today: TODAY + 32 })), "約5日（平均0.2語・残り1）");
    eq("T13 戻した後: 未来の日の行は数えない", short(paceOf({ total: 4, done: 3, rows: s.b.A.p, start: s.b.A.s, today: TODAY })), "学習を続けると…");
    eq("T13 戻した後に写すと未来の行は消える", observePace(s, { books: ["A"], today: TODAY }).b.A.p, []);
  }
  eq("T14 時計を 3 日戻す: 窓で数えるのは −8・−7 の 2 日", short(paceOf({ total: 6, done: 5, rows: rowsOf([[-8, 1], [-7, 1], [-2, 1], [-1, 1], [0, 1]]), start: OLD, today: TODAY - 3 })), "学習を続けると…");
  eq("T14 戻す前（端末の今日が本当の今日）なら 5 日で出す", short(paceOf({ total: 6, done: 5, rows: rowsOf([[-8, 1], [-7, 1], [-2, 1], [-1, 1], [0, 1]]), start: OLD, today: TODAY })), "約3日（平均0.4語・残り1）");
}

// ── 7. 日の境（Z。端末の時間帯の暦日。ms で引かない） ─────────────
for (const tz of ["Asia/Tokyo", "America/New_York"]) {
  process.env.TZ = tz;
  const at = (y, m, d, h, mi, s = 0, ms = 0) => new Date(y, m - 1, d, h, mi, s, ms);
  const inWin = (date, todayYmd) => paceOf({ total: 10, done: 0, rows: [[todayNo(date), 1]], start: dayNoOf(todayYmd) - 30, today: dayNoOf(todayYmd) }).active === 1;
  eq(`Z01 今日−13 の 00:00:00.000 は窓に入る（${tz}）`, inWin(at(2026, 10, 11, 0, 0), "2026-10-24"), true);
  eq(`Z02 今日−14 の 23:59:59.999 は入らない（${tz}）`, inWin(at(2026, 10, 10, 23, 59, 59, 999), "2026-10-24"), false);
  eq(`Z03 今日の 23:59:59.999 は入る（${tz}）`, inWin(at(2026, 10, 24, 23, 59, 59, 999), "2026-10-24"), true);
  eq(`Z04 夏時間の終わり: 今日 2026-11-05・10-23 00:30 は入る（${tz}）`, inWin(at(2026, 10, 23, 0, 30), "2026-11-05"), true);
  eq(`Z05 夏時間の始まり: 今日 2027-03-20・03-06 23:30 は入らない（${tz}）`, inWin(at(2027, 3, 6, 23, 30), "2027-03-20"), false);
  eq(`割る日数も暦日（夏時間をまたいで 14・${tz}）`, paceSpan(todayNo(at(2026, 10, 23, 0, 30)), dayNoOf("2026-11-05")), 14);
  eq(`todayNo はローカル日の日番号（${tz}）`, todayNo(at(2026, 10, 24, 0, 5)), dayNoOf(localDay(at(2026, 10, 24, 0, 5))));
  eq(`todayNo: 読めない日時は null（${tz}）`, todayNo(new Date("x")), null);
}
process.env.TZ = "Asia/Tokyo";

// ── 結果 ─────────────────────────────────────────
if (failures.length) {
  console.error(`test-pace: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-pace: ${passed} passed`);
