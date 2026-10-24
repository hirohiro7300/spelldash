// 一冊を終えるまでの目安（js/bookPace.js）の単体テスト。ブラウザなしで 1 秒で終わる:
//   node scripts/test-pace.mjs
// 失敗が 1 つでもあれば終了コード 1。
// 場合の多くは反証役の表（Batch 76 の P・T・R・Z）を移したもの。日の境は Asia/Tokyo と America/New_York（夏時間）の両方で確かめる。
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

const TODAY = dayNoOf("2026-10-24"); // 窓 = 2026-10-11 〜 2026-10-24
const rowsOf = (pairs, today = TODAY) => pairs.map(([o, n]) => [today + o, n]);
// 表の 1 行の形: 「約14日（平均6語・残り84）」「学習を続けると…」「完了」「出さない」
function short(r) {
  if (r.kind === "pace") return `約${r.days}日（平均${r.avg}${r.unit}・残り${r.remaining}）`;
  if (r.kind === "wait") return r.long ? `学習を続けると…（約${r.days}日は出さない）` : "学習を続けると…";
  return r.kind === "done" ? "完了" : "出さない";
}
const P = (total, done, pairs, today = TODAY) => short(paceOf({ total, done, rows: rowsOf(pairs, today), today }));

// ── 0. 鍵と文 ─────────────────────────────────────────
eq("鍵の名前", PACE_KEY, "spelldash_book_pace");
eq("待ちの文（決定 4）", PACE_WAIT, "学習を続けると、完了までの目安が表示されます。");
eq("端末の注（決定 5）", PACE_DEVICE_NOTE, "この端末の記録から計算しています。");
eq("済みの注（統合担当の決め 7）", PACE_COUNT_NOTE, "済み（覚えた・習得・知ってた）で数えています。");

// ── 1. 目安の式（P。日別の進みを直に入れる） ─────────────────
eq("P01 残り 0 語", P(150, 150, []), "完了");
eq("P02 残り 0 語（進みが多くても完了が先）", P(150, 150, [[0, 30], [-1, 30], [-2, 30]]), "完了");
eq("P03 語が 0 の冊は出さない（0 でも完了にしない）", P(0, 0, []), "出さない");
eq("P04 14 日間の進み 0", P(150, 66, []), "学習を続けると…");
eq("P05 1 日だけ（50 語）", P(150, 66, [[0, 50]]), "学習を続けると…");
eq("P06 2 日（50＋50 語）", P(150, 66, [[0, 50], [-1, 50]]), "学習を続けると…");
// P07・P19・P20・P21・P24 は反証役の表では日数を出す（392・747・4667 日）。上限 365 日（統合担当の決め 5）で待ちの文になる
eq("P07 3 日ちょうど（1 語ずつ）: 約392日は上限を超えるので出さない", P(150, 66, [[0, 1], [-5, 1], [-13, 1]]), "学習を続けると…（約392日は出さない）");
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
eq("P19 160 語の冊・3 日で 3 語（約747日）は出さない", P(160, 0, [[0, 1], [-1, 1], [-2, 1]]), "学習を続けると…（約747日は出さない）");
eq("P20 1,000 語・3 日で 3 語（約4667日）は出さない", P(1000, 0, [[0, 1], [-1, 1], [-2, 1]]), "学習を続けると…（約4667日は出さない）");
eq("P21 窓の境: 今日−14 は入らない（G 3）", P(150, 66, [[-14, 10], [-13, 1], [-7, 1], [0, 1]]), "学習を続けると…（約392日は出さない）");
eq("P21b 窓の境: 今日−14 の 10 語を入れると出てしまう形と違う", P(150, 66, [[-13, 11], [-7, 1], [0, 1]]), "約90日（平均0.9語・残り84）");
eq("P22 窓の境: 今日−14 を除くと 2 日", P(150, 66, [[-14, 10], [-13, 1], [0, 1]]), "学習を続けると…");
eq("P23 今日より後の日は数えない", P(150, 66, [[1, 5], [0, 1], [-1, 1]]), "学習を続けると…");
eq("P24 0 の日が混ざる（0 は進んだ日でない）", P(150, 66, [[0, 1], [-1, 0], [-2, 1], [-3, 1]]), "学習を続けると…（約392日は出さない）");
eq("P25 今日の分で 3 日目（今日を含む）", P(150, 66, [[0, 1], [-6, 2], [-12, 3]]), "約196日（平均0.4語・残り84）");
eq("上限ちょうど 365 日は出す", P(400, 35, Array.from({ length: 14 }, (_, i) => [-i, 1])), "約365日（平均1語・残り365）");
eq("上限 366 日は出さない", P(400, 34, Array.from({ length: 14 }, (_, i) => [-i, 1])), "学習を続けると…（約366日は出さない）");
// 純増（統合担当の決め 1）: 進みの和が 0 以下なら、増えた日が 3 日以上でも出さない
eq("純増が 0（+1 が 3 日・−3 が 1 日）", P(150, 66, [[0, 1], [-1, 1], [-2, 1], [-3, -3]]), "学習を続けると…");
eq("純増が負", P(150, 66, [[0, 1], [-1, 1], [-2, 1], [-3, -5]]), "学習を続けると…");
eq("減った日は進んだ日に数えない（+ が 2 日・− が 1 日）", P(150, 66, [[0, 20], [-1, 20], [-2, -1]]), "学習を続けると…");
eq("減った日があっても純増と + の日で出す（84×14÷(30−2)）", P(150, 66, [[0, 10], [-1, 10], [-2, 10], [-3, -2]]), "約42日（平均2語・残り84）");
eq("壊れた数（done が total より大きい）は完了", P(10, 12, []), "完了");
eq("壊れた数（total が数でない）は出さない", short(paceOf({ total: NaN, done: 0, rows: [], today: TODAY })), "出さない");
eq("同じ日の行が 2 つあっても 1 日（和）", P(150, 66, [[0, 3], [0, 3], [-1, 6], [-2, 6]]), "約65日（平均1.3語・残り84）");
eq("同じ日の行が 2 つで 2 日にならない（2 日なら出さない）", P(150, 66, [[0, 3], [0, 3], [-1, 6]]), "学習を続けると…");

// 丸めの式の網（P26）: R×14÷G の四捨五入を整数で。R÷(G÷14) は浮動小数で 1 日ずれる組がある
{
  let bad = 0;
  let floatBad = 0;
  for (let r = 1; r <= 1000; r++)
    for (let g = 3; g <= 2000; g++) {
      const want = Math.max(1, Math.floor((2 * r * 14 + g) / (2 * g)));
      if (roundDays(r, g) !== want) bad++;
      if (Math.max(1, Math.round(r / (g / 14))) !== want) floatBad++;
    }
  eq("P26 丸めの網（R 1〜1000 × G 3〜2000）: 整数の式と一致", bad, 0);
  ok("P26 R÷(G÷14) は狂う組がある（使っていないことの確かめ）", floatBad > 0);
}
eq("平均の見せ方: 14 で割り切れる → 整数", [formatAvg(84), formatAvg(28), formatAvg(14)], ["6", "2", "1"]);
eq("平均の見せ方: 10 未満は小数 1 桁", [formatAvg(3), formatAvg(7), formatAvg(20), formatAvg(36), formatAvg(85)], ["0.2", "0.5", "1.4", "2.6", "6.1"]);
eq("平均の見せ方: 0.9 語（13 ÷ 14）", formatAvg(13), "0.9");
eq("平均の見せ方: 10 以上は四捨五入の整数", [formatAvg(140), formatAvg(145), formatAvg(147), formatAvg(1400)], ["10", "10", "11", "100"]);

// ── 2. 文（決定 5・統合担当の決め 6・7） ─────────────────────
{
  const r = paceOf({ total: 150, done: 66, rows: rowsOf(Array.from({ length: 14 }, (_, i) => [-i, 6])), today: TODAY });
  eq("文: 目安あり（決定 5 の 4 行＋済みの注）", paceText(r), ["残り84語", "最近14日間は、1日平均6語進んでいます。", "今のペースなら、完了まであと約14日が目安です。", "この端末の記録から計算しています。", "済み（覚えた・習得・知ってた）で数えています。"]);
  eq("文: 数は太字の所（num）に入る", r.parts.map((p) => p.num ?? null), [84, "6", 14, null, null]);
  eq("文: 注は note", r.parts.map((p) => !!p.note), [false, false, false, true, true]);
  const w = paceOf({ total: 150, done: 66, rows: [], today: TODAY });
  eq("文: 待ち（残りは出す・日数と平均は出さない）", paceText(w), ["残り84語", "学習を続けると、完了までの目安が表示されます。", "済み（覚えた・習得・知ってた）で数えています。"]);
  eq("文: 完了", paceText(paceOf({ total: 150, done: 150, rows: [], today: TODAY })), ["完了", "済み（覚えた・習得・知ってた）で数えています。"]);
  eq("文: 語の無い冊は何も出さない", paceText(paceOf({ total: 0, done: 0, rows: [], today: TODAY })), []);
  const c = paceOf({ total: 75, done: 33, rows: rowsOf([[0, 6], [-1, 6], [-2, 6]]), today: TODAY, unit: "枚" });
  eq("文: 概念カードの冊は「枚」（道と同じ）", paceText(c).slice(0, 3), ["残り42枚", "最近14日間は、1日平均1.3枚進んでいます。", "今のペースなら、完了まであと約33日が目安です。"]);
  eq("文: 待ちでも単位は「枚」", paceText(paceOf({ total: 75, done: 33, rows: [], today: TODAY, unit: "枚" }))[0], "残り42枚");
  ok("文: 予測の言い切りをしない（「約」「目安」・絵文字なし）", /約\d+日が目安です。$/.test(paceText(r)[2]) && !/[\u{1F300}-\u{1FAFF}]/u.test(paceText(r).join("")));
}

// ── 3. 記録の形（読む・壊れた値） ─────────────────────────
const plain = (v) => JSON.parse(JSON.stringify(v));
const EMPTY = { v: 1, at: null, b: {} };
eq("読めない JSON → 空", plain(readPace("{oops")), EMPTY);
eq("null → 空", plain(readPace(null)), EMPTY);
eq("配列 → 空", plain(readPace("[1,2]")), EMPTY);
eq("版が違う（v 2）→ 空（置き直す）", plain(readPace(JSON.stringify({ v: 2, at: 1, b: { a: { n: 1, p: [] } } }))), EMPTY);
eq("b が配列 → 冊なし", plain(readPace(JSON.stringify({ v: 1, at: 3, b: [1] }))), { v: 1, at: 3, b: {} });
{
  const raw = JSON.stringify({
    v: 1,
    at: TODAY,
    b: {
      good: { n: 5, p: [[TODAY, 2], [TODAY - 1, 1]] },
      neg: { n: -1, p: [] },
      float: { n: 1.5, p: [] },
      str: { n: "3", p: [] },
      rows: { n: 4, p: [[TODAY, 1], "x", [TODAY - 2], [TODAY - 3, "2"], [TODAY - 4, 0], [TODAY - 5, 1.5], [-3, 1], [TODAY, 2]] },
      noP: { n: 2 },
      PROTO: { n: 9, p: [] }
    }
  }).replace('"PROTO"', '"__proto__"'); // JSON の中の "__proto__" の名（オブジェクトの書き方では型になるので文字で置く）
  const s = readPace(raw);
  eq("壊れた行を捨てる: 残るのは good・rows・noP（と __proto__ の名の冊）", Object.keys(s.b).sort(), ["__proto__", "good", "noP", "rows"].sort());
  eq("壊れた行を捨てる: 日は昇順・同じ日は和・0 と数でない行は捨てる", s.b.rows, { n: 4, p: [[TODAY, 3]] });
  eq("p の無い行は空の p", s.b.noP, { n: 2, p: [] });
  ok("__proto__ の名の冊で型が変わらない", Object.getPrototypeOf(s.b) === null && s.b["__proto__"].n === 9);
  eq("at は残る", s.at, TODAY);
  eq("at が数でなければ null", readPace(JSON.stringify({ v: 1, at: "x", b: {} })).at, null);
  const again = readPace(JSON.stringify(s));
  eq("書いて読み直しても同じ", JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(s)));
}

// ── 4. 数える・置き直す（observePace） ─────────────────────
{
  let s = readPace(null);
  s = observePace(s, { a: 10, b: 0 }, { today: TODAY - 2, mode: "rebase" });
  eq("初めての写しは基準だけ（進みに入れない）", [s.b.a, s.b.b, s.at], [{ n: 10, p: [] }, { n: 0, p: [] }, TODAY - 2]);
  s = observePace(s, { a: 13, b: 1 }, { today: TODAY - 2, mode: "count" });
  eq("数える: 前の写しからの増えを今日の行に", [s.b.a.p, s.b.b.p], [[[TODAY - 2, 3]], [[TODAY - 2, 1]]]);
  s = observePace(s, { a: 12, b: 1 }, { today: TODAY - 2, mode: "count" });
  eq("同じ日に減ると、その日の和から引く", s.b.a.p, [[TODAY - 2, 2]]);
  s = observePace(s, { a: 10, b: 1 }, { today: TODAY - 2, mode: "count" });
  eq("同じ日の和が 0 になったら行を消す", s.b.a.p, []);
  s = observePace(s, { a: 50, b: 1 }, { today: TODAY - 1, mode: "rebase" });
  eq("置き直し（同期・読み直し）は進みに入れない", [s.b.a, s.at], [{ n: 50, p: [] }, TODAY - 1]);
  s = observePace(s, { a: 52, b: 1, c: 7 }, { today: TODAY, mode: "count" });
  eq("数えるときに初めて見た冊（回の前に足した本）は基準だけ", [s.b.a.p, s.b.c], [[[TODAY, 2]], { n: 7, p: [] }]);
  const f = observePace(s, { a: 60, c: 9, d: 4 }, { today: TODAY, mode: "fill" });
  eq("fill: 行の無い冊にだけ基準を置く（ほかの冊は変えない）", [f.b.a, f.b.c, f.b.d], [s.b.a, s.b.c, { n: 4, p: [] }]);
  const gone = observePace(s, { a: 52 }, { today: TODAY, mode: "rebase" });
  eq("読み込んでいない冊: 窓の中に進みのある冊（b）は残し、進みの無い冊（c）は捨てる", [Object.keys(gone.b).sort(), gone.b.b, gone.b.c ?? null], [["a", "b"], { n: 1, p: [[TODAY - 2, 1]], off: 1 }, null]);
  const keep = observePace(observePace(s, { a: 52, b: 3 }, { today: TODAY, mode: "count" }), { a: 52 }, { today: TODAY, mode: "rebase" });
  eq("読み込んでいない冊の進みは窓の中は残る", keep.b.b, { n: 3, p: [[TODAY - 2, 1], [TODAY, 2]], off: 1 });
  eq("中の値を書き換えない（前の状態はそのまま）", s.b.a.p, [[TODAY, 2]]);
  const bad = observePace(s, { a: -1, b: 2.5, e: "3" }, { today: TODAY, mode: "count" });
  ok("壊れた数（負・小数・文字）は数えない", bad.b.a.n === 52 && bad.b.b.n === 1 && !bad.b.e);
  eq("今日が数でなければ何もしない", observePace(s, { a: 99 }, { today: NaN, mode: "count" }), s);
}
// 窓の外・時計
{
  let s = readPace(null);
  s = observePace(s, { a: 0 }, { today: TODAY - 40, mode: "rebase" });
  for (let d = TODAY - 39, n = 1; d <= TODAY; d++, n++) s = observePace(s, { a: n }, { today: d, mode: "count" });
  eq("毎日数えても p は直近 14 日だけ（上限）", s.b.a.p.length, 14);
  eq("p の最初の日は今日−13", s.b.a.p[0][0], TODAY - 13);
  ok("40 日分を書いても 1KB 未満", JSON.stringify(s).length < 1024);
  const back = observePace(s, { a: 45 }, { today: TODAY - 3, mode: "count" });
  eq("時計が戻った（今日 < 前に数えた日）: 数えずに置き直す", [back.b.a.n, back.b.a.p.some(([d]) => d > TODAY - 3), back.b.a.p.find(([d]) => d === TODAY - 3)], [45, false, [TODAY - 3, 1]]);
  eq("時計が戻った: 未来の日の行は捨て、at は端末の今日", back.at, TODAY - 3);
  const fwd = observePace(back, { a: 46 }, { today: TODAY - 2, mode: "count" });
  eq("戻した後の次の日からは数える", fwd.b.a.p.at(-1), [TODAY - 2, 1]);
  const first = observePace(readPace(null), { a: 9 }, { today: TODAY, mode: "count" });
  eq("前の写しが無いときの count は基準だけ（at が無い）", first.b.a, { n: 9, p: [] });
}

// ── 5. 冊の数え方（countBooks） ───────────────────────────
{
  const done = new Set(["a", "b", "k", "m"]);
  let calls = 0;
  const isDone = (id) => (calls++, done.has(id));
  const out = countBooks([{ id: "A", ids: ["a", "b", "c", "a"] }, { id: "B", ids: ["a", "d", "k", "m", "z"] }, { id: "E", ids: [] }], isDone);
  eq("冊ごとの済みの数（冊の中の同じ id は 1 語・同じ id は両方の冊で済み）", out, { A: 2, B: 3, E: 0 });
  eq("語ごとの判定は 1 回（id ごとに覚える）", calls, 7);
  eq("語の数（重複を除く）", countBooks([{ id: "A", ids: ["a", "a", "b"] }], () => false, { total: true }), { A: { done: 0, total: 2 } });
}

// ── 6. 日ごとの済みの変化 → 進み（T。端末で答えて、回の終わりに数える流れを模す） ─────
// state: 語 → "done" | "weak"（無ければ未着手）。books: 冊 → 語。events: [日（今日からの差）, 語, "o"|"x"|"k"]
function simulate({ books, before = {}, events, today = TODAY, countEach = true, sync = [] }) {
  const st = new Map(Object.entries(before));
  const doneOf = () => countBooks(Object.entries(books).map(([id, ids]) => ({ id, ids })), (id) => st.get(id) === "done");
  let s = observePace(readPace(null), doneOf(), { today: today - 20, mode: "rebase" }); // 窓より前の写しが基準
  const byDay = new Map();
  for (const e of events) byDay.set(e[0], [...(byDay.get(e[0]) ?? []), e]);
  for (const x of sync) byDay.set(x[0], [...(byDay.get(x[0]) ?? []), [...x, "sync"]]);
  const daysSeen = [...byDay.keys()].sort((a, b) => a - b);
  for (const o of daysSeen) {
    for (const [, id, r, how] of byDay.get(o)) {
      st.set(id, r === "x" ? "weak" : "done");
      if (how === "sync") s = observePace(s, doneOf(), { today: today + o, mode: "rebase" });
      else if (countEach) s = observePace(s, doneOf(), { today: today + o, mode: "count" });
    }
    if (!countEach) s = observePace(s, doneOf(), { today: today + o, mode: "rebase" });
  }
  return { s, done: doneOf(), st };
}
const rowsText = (p, today = TODAY) => (p.length ? p.map(([d, n]) => `${d - today}:${n}`).join(" ") : "なし");
{
  const T = (input) => rowsText(simulate(input).s.b.A.p);
  eq("T01 同じ日に 済み→未済み→済み: 進みなし", T({ books: { A: ["a"] }, before: { a: "done" }, events: [[0, "a", "x"], [0, "a", "o"]] }), "なし");
  eq("T02 同じ日に 未着手→済み→未済み→済み: 1（2 にしない）", T({ books: { A: ["a"] }, events: [[0, "a", "o"], [0, "a", "x"], [0, "a", "o"]] }), "0:1");
  eq("T03 同じ日に 未着手→済み→未済みで終わる: なし", T({ books: { A: ["a"] }, events: [[0, "a", "o"], [0, "a", "x"]] }), "なし");
  eq("T04 外れて次の日に戻る: −1 と +1（純増 0）", T({ books: { A: ["a"] }, before: { a: "done" }, events: [[-3, "a", "x"], [-2, "a", "o"]] }), "-3:-1 -2:1");
  eq("T05 入る→外れる→また入る", T({ books: { A: ["a"] }, events: [[-10, "a", "o"], [-6, "a", "x"], [-2, "a", "o"]] }), "-10:1 -6:-1 -2:1");
  eq("T06 外れたまま", T({ books: { A: ["a"] }, before: { a: "done" }, events: [[-3, "a", "x"]] }), "-3:-1");
  eq("T07 知ってた", T({ books: { A: ["a"] }, events: [[-4, "a", "k"]] }), "-4:1");
  // T08: 新しい語 0・毎日 1 語の復習のつまずきを翌日に戻すだけ（30 語・20 語は窓より前から済み）→ 純増 0 で出さない
  {
    const ids = Array.from({ length: 30 }, (_, i) => `w${i}`);
    const before = Object.fromEntries(ids.slice(0, 20).map((id) => [id, "done"]));
    const events = [];
    for (let i = 0; i < 13; i++) events.push([-13 + i, `w${i}`, "x"], [-12 + i, `w${i}`, "o"]);
    events.sort((a, b) => a[0] - b[0]);
    const r = simulate({ books: { A: ids }, before, events });
    eq("T08 復習のつまずきを翌日に戻すだけ: 目安を出さない", short(paceOf({ total: 30, done: r.done.A, rows: r.s.b.A.p, today: TODAY })), "学習を続けると…");
  }
  const t9 = simulate({ books: { A: ["a", "b", "c"], B: ["a", "d", "e"] }, events: [[-3, "d", "o"], [-2, "b", "o"], [-1, "a", "o"]] });
  eq("T09 同じ id が 2 冊（a で両方の冊が進む）", [rowsText(t9.s.b.A.p), rowsText(t9.s.b.B.p)], ["-2:1 -1:1", "-3:1 -1:1"]);
  // T12: 同期で古い完了 40 語が今日届く（この端末は 3 日 × 1 語）→ 届いた分は置き直し。T12b（窓の中の 40 語）も同じ（この端末の答えだけ）
  // 同期で届いた語は、別の端末で覚えた日によらず届いた時に置き直す（どちらも同じ）
  for (const name of ["T12 同期で 20〜60 日前の完了 40 語が今日届く", "T12b 届いた 40 語が別の端末で窓の中に覚えた語"]) {
    const ids = Array.from({ length: 100 }, (_, i) => `s${i}`);
    const sync = Array.from({ length: 40 }, (_, i) => [0, `s${i}`, "o"]);
    const r = simulate({ books: { A: ids }, events: [[-2, "s50", "o"], [-1, "s51", "o"], [0, "s52", "o"]], sync });
    eq(`${name}: この端末の答えだけ（約266日）`, short(paceOf({ total: 100, done: r.done.A, rows: r.s.b.A.p, today: TODAY })), "約266日（平均0.2語・残り57）");
  }
  // R12: 写しを置き直しだけで書く（学習データのページを開いたときだけ書く作り）は誤り。答えた日に数える
  {
    const ids = Array.from({ length: 168 }, (_, i) => `r${i}`);
    const events = [];
    for (let d = -13, k = 0; d <= 0; d++) for (let j = 0; j < 6; j++) events.push([d, `r${k++}`, "o"]);
    const counted = simulate({ books: { A: ids }, events });
    eq("R12 毎日 6 語を回の終わりに数える: 約14日（決定 5 の例）", short(paceOf({ total: 168, done: counted.done.A, rows: counted.s.b.A.p, today: TODAY })), "約14日（平均6語・残り84）");
    const pageOnly = simulate({ books: { A: ids }, events, countEach: false });
    eq("R12 置き直しだけ（ページを開いた日に写すだけ）なら進みは入らない", pageOnly.s.b.A.p, []);
  }
  // T13: 時計を +30 日 → 3 日学ぶ → 戻す
  {
    let s = observePace(readPace(null), { A: 0 }, { today: TODAY - 1, mode: "rebase" });
    s = observePace(s, { A: 1 }, { today: TODAY + 30, mode: "count" });
    s = observePace(s, { A: 2 }, { today: TODAY + 31, mode: "count" });
    s = observePace(s, { A: 3 }, { today: TODAY + 32, mode: "count" });
    eq("T13 時計を進めている間は出る（その日の今日で数える）", short(paceOf({ total: 4, done: 3, rows: s.b.A.p, today: TODAY + 32 })), "約5日（平均0.2語・残り1）");
    eq("T13 戻した後: 未来の日の行は数えない", short(paceOf({ total: 4, done: 3, rows: s.b.A.p, today: TODAY })), "学習を続けると…");
    const back = observePace(s, { A: 3 }, { today: TODAY, mode: "count" });
    eq("T13 戻した後に書くと未来の行は消える", back.b.A.p, []);
  }
  // T14: 時計を 3 日戻した（本当の 10-22〜10-24 の行が、端末の今日 10-21 から見て未来）
  eq("T14 時計を 3 日戻す: 窓で数えるのは −8・−7 の 2 日", short(paceOf({ total: 6, done: 5, rows: rowsOf([[-8, 1], [-7, 1], [-2, 1], [-1, 1], [0, 1]]), today: TODAY - 3 })), "学習を続けると…");
  eq("T14 戻す前（端末の今日が本当の今日）なら 5 日で出す", short(paceOf({ total: 6, done: 5, rows: rowsOf([[-8, 1], [-7, 1], [-2, 1], [-1, 1], [0, 1]]), today: TODAY })), "約3日（平均0.4語・残り1）");
  // T10・T11: 外していた本を足し直す・パックの版が変わる → 読み直しで置き直す（統合担当の決め 2）。過去の行は書いたときの中身のまま
  {
    let s = observePace(readPace(null), { P: 0 }, { today: TODAY - 8, mode: "rebase" });
    s = observePace(s, { P: 1 }, { today: TODAY - 6, mode: "count" }); // p2
    s = observePace(s, {}, { today: TODAY - 5, mode: "rebase" }); // 外した（P が読み込まれていない）
    s = observePace(s, { P: 2 }, { today: TODAY - 2, mode: "rebase" }); // 足し直した（外した間に別の冊で p1 を覚えた: 進みにしない）
    s = observePace(s, { P: 3 }, { today: TODAY - 1, mode: "count" }); // p3
    eq("T10 本を外して足し直す: 外した間の進みは置き直し（−6・−1 だけ）", rowsText(s.b.P.p), "-6:1 -1:1");
    // 回の途中で外して、ホームで足し直してから回を始めた（読み込み直しの置き直しが無い）: 外した間の変化は回の始め（fill）で置き直す
    let h = observePace(readPace(null), { P: 0, Q: 0 }, { today: TODAY - 8, mode: "rebase" });
    h = observePace(h, { P: 1, Q: 0 }, { today: TODAY - 6, mode: "count" });
    h = observePace(h, { Q: 1 }, { today: TODAY - 4, mode: "count" }); // P を外していた（Q で共有の p1 を覚えた）
    eq("T10b 外していた間は off の印", h.b.P, { n: 1, p: [[TODAY - 6, 1]], off: 1 });
    h = observePace(h, { P: 2, Q: 1 }, { today: TODAY - 4, mode: "fill" }); // 足し直して回を始めた
    eq("T10b 足し直した冊は fill でも基準を置き直す（印は消える）", h.b.P, { n: 2, p: [[TODAY - 6, 1]] });
    h = observePace(h, { P: 3, Q: 1 }, { today: TODAY - 4, mode: "count" });
    eq("T10b 足し直した後の回の進みだけ数える", rowsText(h.b.P.p), "-6:1 -4:1");
    eq("T10b off の印は読み直しても残る", readPace(JSON.stringify(observePace(h, { Q: 1 }, { today: TODAY - 3, mode: "count" }))).b.P.off, 1);
    eq("T10b 読み込んでいない冊で進みが窓の外へ出たら捨てる", observePace(h, { Q: 1 }, { today: TODAY + 20, mode: "count" }).b.P ?? null, null);
    let v = observePace(readPace(null), { V: 0 }, { today: TODAY - 5, mode: "rebase" });
    v = observePace(v, { V: 1 }, { today: TODAY - 3, mode: "count" }); // d（v2 で消える語）
    v = observePace(v, { V: 1 }, { today: TODAY - 3, mode: "rebase" }); // 版が変わった（d が消え e・f が増えた。済みの数は a・b・c のうち 0 → 中身が変わっても置き直し）
    v = observePace(v, { V: 2 }, { today: TODAY - 2, mode: "count" });
    v = observePace(v, { V: 3 }, { today: TODAY - 1, mode: "count" });
    eq("T11 パックの版の変化は置き直し（消えた語の過去の進みは書いたまま）", rowsText(v.b.V.p), "-3:1 -2:1 -1:1");
  }
}

// ── 7. 日の境（Z。端末の時間帯の暦日。ms で引かない） ─────────────
for (const tz of ["Asia/Tokyo", "America/New_York"]) {
  process.env.TZ = tz;
  const at = (y, m, d, h, mi, s = 0, ms = 0) => new Date(y, m - 1, d, h, mi, s, ms);
  const inWin = (date, todayYmd) => {
    const r = paceOf({ total: 10, done: 0, rows: [[todayNo(date), 1], [dayNoOf(todayYmd) - 100, 1]], today: dayNoOf(todayYmd) });
    return r.active === 1;
  };
  eq(`Z01 今日−13 の 00:00:00.000 は窓に入る（${tz}）`, inWin(at(2026, 10, 11, 0, 0), "2026-10-24"), true);
  eq(`Z02 今日−14 の 23:59:59.999 は入らない（${tz}）`, inWin(at(2026, 10, 10, 23, 59, 59, 999), "2026-10-24"), false);
  eq(`Z03 今日の 23:59:59.999 は入る（${tz}）`, inWin(at(2026, 10, 24, 23, 59, 59, 999), "2026-10-24"), true);
  eq(`Z04 夏時間の終わり: 今日 2026-11-05・10-23 00:30 は入る（${tz}）`, inWin(at(2026, 10, 23, 0, 30), "2026-11-05"), true);
  eq(`Z05 夏時間の始まり: 今日 2027-03-20・03-06 23:30 は入らない（${tz}）`, inWin(at(2027, 3, 6, 23, 30), "2027-03-20"), false);
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
