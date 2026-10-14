// 記録の質と影の計算（js/memoryModel.js・js/memoryCheck.js と、js/stats.js の書き手の新しい欄）の単体テスト。ブラウザなし:
//   node scripts/test-memory.mjs            （不変の模擬 scripts/sim-writers.mjs も子のプロセスで流す。約 1 分）
//   node scripts/test-memory.mjs --no-sim   （模擬を流さない）
// 失敗が 1 つでもあれば終了コード 1。定義は docs/SPEC_MASTERY.md「記録の質」。
// 確かめること: 式の表（難しさ・安定性の式）・初めの値・今の記録からの移行の S・× の比・sp の材料の決まり・× の細目・「別の日」の復習・
// spelldash_memory_check の足し算と 2 つのタブ・上限（20 KB）・語ごとの欄の置き場所 spelldash_memory_words（js/memoryWords.js: 書く機会・
// 読み直して足す・壊れた保存・上限）・不変の模擬（この Batch の前の main と 1 件も違わない。受け入れの基準 1・3）
process.env.TZ = "Asia/Tokyo";

import { isDeepStrictEqual } from "util";
import { readFileSync } from "fs";
import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_SIM = !process.argv.includes("--no-sim");

// 不変の模擬は重い（1 年分の書き手）ので最初に子のプロセスで始め、ほかの検査と並べて走らせる
const simDone = RUN_SIM
  ? new Promise((resolve) => {
      execFile(process.execPath, [path.join(ROOT, "scripts/sim-writers.mjs"), ROOT, "--summary"], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    })
  : null;

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond) => eq(name, !!cond, true);
const near = (name, actual, expected, eps = 1e-6) => ok(`${name}（${actual} ≈ ${expected}）`, Math.abs(actual - expected) <= eps);

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

const MD = await import("../js/memoryModel.js");
const MC = await import("../js/memoryCheck.js");
const MW = await import("../js/memoryWords.js");
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms)); // 手が空いたときの書き込み（Node では次のタスク）を待つ

// ── 1. 式の表（設計の写し learn/d1sim/model.mjs と同じ値。2026-10-14 に照合） ─────────────
{
  const { R, intervalFactor, growthBase, onSuccess, onFail, nextInterval, initState, P, VARIANTS } = MD;
  near("R: t = S で 0.9", R(10, 10), 0.9);
  near("R: 期日前（t 1・S 10）", R(1, 10), 0.988474);
  near("R: 遅れ（t 40・S 10）", R(40, 10), 0.718278);
  near("R: t 3・S 1", R(3, 1), 0.766131);
  eq("R: t 0 は 1・S 0 は 0（まだ覚えていない）", [R(0, 5), R(5, 0)], [1, 0]);
  near("k: 目標 0.9 で 1", intervalFactor(0.9), 1);
  near("k: 目標 0.85 で 1.64", intervalFactor(0.85), 1.637407);
  near("k: 目標 0.95 で 0.46", intervalFactor(0.95), 0.460563);
  eq("伸び G: 難しさ 1・3・5・7・10", [1, 3, 5, 7, 10].map((d) => Math.round(growthBase(d) * 1e6) / 1e6), [1.74, 1.62, 1.5, 1.38, 1.2]);
  const st = { S: 10, D: 5, D0: 5 };
  const s1 = onSuccess(st, { t: 10, speed: "normal" });
  eq("正解（期日どおり）: S 10 → 15、D 5 → 4.91（−0.1 のあと初めの値へ 1 割）", [s1.S, Math.round(s1.D * 1e6) / 1e6], [15, 4.91]);
  near("正解（期日前 t 1）: 伸びは 1 割まで → 10.576", onSuccess(st, { t: 1 }).S, 10.576301);
  eq("正解（遅れて t 40）: 伸びは 2 倍まで → 20", onSuccess(st, { t: 40 }).S, 20);
  eq("速さなしの既定: すぐ・遅いでも同じ 15", [onSuccess(st, { t: 10, speed: "fast" }).S, onSuccess(st, { t: 10, speed: "slow" }).S], [15, 15]);
  eq("速さありの通り（7 通り目）: すぐ 17.5・遅い 12.5", [onSuccess(st, { t: 10, speed: "fast" }, VARIANTS[6]).S, onSuccess(st, { t: 10, speed: "slow" }, VARIANTS[6]).S], [17.5, 12.5]);
  eq("打ち間違いありの正解: S は変えず D + 0.3", onSuccess(st, { t: 10, clean: false }), { S: 10, D: 5.3, D0: 5 });
  eq("正解で S を縮めない・まだ覚えていない語は S 1", [onSuccess({ S: 0, D: 5, D0: 5 }, { t: 3 }).S], [1]);
  eq("×: S 20 → 6（0.3 倍）・S 2 → 1（下限）・S 0 → 0、D + 1（10 まで）", [onFail({ S: 20, D: 9.5 }), onFail({ S: 2, D: 3 }), onFail({ S: 0, D: 5 })].map((x) => [x.S, x.D]), [[6, 10], [1, 4], [0, 6]]);
  eq("次の間隔: S 10・段 3 → 10、S 3・段 4 → 7（下限）", [nextInterval({ S: 10 }, { rank: 3 }), nextInterval({ S: 3 }, { rank: 4 })], [10, 7]);
  eq("次の間隔: 段 5 の 30 日は 14 日以上あけた答えだけ（gap 14 → 30、gap 5 → 7）", [nextInterval({ S: 3 }, { rank: 5, gap: 14 }), nextInterval({ S: 3 }, { rank: 5, gap: 5 })], [30, 7]);
  eq("次の間隔: 遅い答えは下限なし・上限 90・× の日は 1", [nextInterval({ S: 3 }, { rank: 5, speed: "slow", gap: 30 }), nextInterval({ S: 200 }, { rank: 5, gap: 60 }), nextInterval({ S: 30 }, { afterFail: true })], [3, 90, 1]);
  eq("初めの値: 知ってた 14・3、打ち間違いあり 1・5、× 0・5", ["clean", "typo", "x"].map((k) => initState(k)), [{ S: 14, D: 3, D0: 3 }, { S: 1, D: 5, D0: 5 }, { S: 0, D: 5, D0: 5 }]);
  eq("影の 7 通り: 伸び率 1.3・1.5・1.8・2.2・2.7・3.3（速さなし）と 1.5（速さあり）", VARIANTS.map((v) => [v.G0, v.speedMul.fast]), [[1.3, 1], [1.5, 1], [1.8, 1], [2.2, 1], [2.7, 1], [3.3, 1], [1.5, 1.5]]);
  eq("既定は速さを間隔に使わない（伸び・難しさ・知ってた語の D）", [P.speedMul.fast, P.speedMul.slow, P.dStep.fast, P.dStep.slow, P.knownD.fast], [1, 1, -0.1, -0.1, 3]);
  eq("曲線の係数 19/81・−0.5・目標 0.9", [P.F, P.C, P.target], [19 / 81, -0.5, 0.9]);
}

// ── 2. 影の 7 通り（語ごとの記録の形）と移行の S ─────────────
{
  const { shadowInit, shadowSuccess, shadowFail, shadowSameDay, shadowPredict, readShadow, writeShadow, migrateState, predBand, logLoss } = MD;
  eq("初めての答え（知ってた）: 7 通りとも 14、D 3", shadowInit("clean"), { Sv: [14, 14, 14, 14, 14, 14, 14], D: 3, D0: 3 });
  eq("初めての答え（×）: 0（まだ覚えていない）", shadowInit("x").Sv, [0, 0, 0, 0, 0, 0, 0]);
  eq("× のあと、その日の最初の自力正解: S 1、D = min(7, 4 + × の回数)", [shadowSuccess(shadowInit("x"), { t: 0, xCount: 1 }), shadowSuccess(shadowInit("x"), { t: 0, xCount: 6 }).D], [{ Sv: [1, 1, 1, 1, 1, 1, 1], D: 5, D0: 5 }, 7]);
  eq("同じ日: まだ覚えていない語の自力正解だけ S 1、覚えた語は変えない", [shadowSameDay(shadowInit("x"), { ok: true, xCount: 1 }).Sv[0], shadowSameDay(shadowInit("clean"), { ok: true }).Sv[0], shadowSameDay(shadowInit("x"), { ok: false }).Sv[0]], [1, 14, 0]);
  const known = shadowInit("clean");
  const grown = shadowSuccess(known, { t: 14, speed: "fast" });
  eq("知ってた語の 14 日後の正解（期日どおり・すぐ）: 伸び率ごとに 14 × G（難しさ 3: G = 1 + (G0 − 1) × 1.24）、7 通り目だけ速さで伸びが 1.5 倍（14 × 1.93）", grown.Sv.map((s) => Math.round(s * 1000) / 1000), [19.208, 22.68, 27.888, 34.832, 43.512, 53.928, 27.02]);
  eq("× で 7 通りとも 0.3 倍（1 日まで）・D + 1", shadowFail({ Sv: [10, 20, 30, 2, 3, 100, 20], D: 4, D0: 3 }), { Sv: [3, 6, 9, 1, 1, 30, 6], D: 5, D0: 3 });
  eq("見込み（覚えていない通りは null）", shadowPredict({ Sv: [10, 0, 10, 10, 10, 10, 10], D: 5, D0: 5 }, 10).map((r) => (r === null ? null : Math.round(r * 1000) / 1000)), [0.9, null, 0.9, 0.9, 0.9, 0.9, 0.9]);
  const stat = {};
  writeShadow(stat, { Sv: [14.26, 21.98, 27.89, 35.43, 44.04, 54.16, 27.02], D: 2.94, D0: 3 });
  eq("記録には 0.1 刻みの整数で書く（S × 10・D × 10）", [stat.memSv, stat.memD, stat.memD0], [[143, 220, 279, 354, 440, 542, 270], 29, 30]);
  eq("読み戻すと 0.1 刻みの値", readShadow(stat), { Sv: [14.3, 22, 27.9, 35.4, 44, 54.2, 27], D: 2.9, D0: 3 });
  eq("形の合わない記録は読まない（移行の値で作り直す）", [readShadow({ memSv: [1, 2], memD: 30 }), readShadow({ memSv: [1, 2, 3, 4, 5, 6, 7.5], memD: 30 }), readShadow({ memSv: [1, 2, 3, 4, 5, 6, 7] })], [null, null, null]);
  eq("移行の S: 自力正解なし 0・未解決 1・確認待ちの知ってた語 14・習得 45", [migrateState({}).S, migrateState({ everRecalled: true, unresolved: true }).S, migrateState({ everRecalled: true, knownWaiting: true, known: true }).S, migrateState({ everRecalled: true, mastered: true }).S], [0, 1, 14, 45]);
  const DAY = 86400000;
  eq("移行の S: ふつうの語は 期日 − 最後の自力正解 の日数を 1〜30 に（10 日 → 10・45 日 → 30・0.2 日 → 1・読めない → 1）", [10 * DAY, 45 * DAY, 0.2 * DAY].map((d) => migrateState({ everRecalled: true, okMs: 1e12, dueMs: 1e12 + d }).S).concat(migrateState({ everRecalled: true }).S), [10, 30, 1, 1]);
  eq("移行の D: clamp(4 + min(× の回数, 5) − 知ってた 2, 1, 9)", [migrateState({ recallFail: 0 }).D, migrateState({ recallFail: 3 }).D, migrateState({ recallFail: 9 }).D, migrateState({ recallFail: 0, known: true, everRecalled: true }).D], [4, 7, 9, 2]);
  eq("見込みの帯: 0.95 以上・0.9・0.85・0.8・0.8 未満", [0.97, 0.95, 0.92, 0.87, 0.81, 0.5].map(predBand), [0, 0, 1, 2, 3, 4]);
  near("対数損失（0.9 で ○）", logLoss(0.9, true), -Math.log(0.9));
  near("対数損失は 0.001〜0.999 に丸める", logLoss(1, false), -Math.log(0.001));
}

// ── 3. spelldash_memory_check の足し算・2 つのタブ・上限 ─────────────
{
  store.clear();
  MC.forgetMemoryCheck();
  const nowMs = new Date(2026, 9, 14, 9).getTime();
  MC.noteCalibration("w1", [0.9, 0.9, 0.95, 0.96, 0.97, 0.98, 0.9], "o", nowMs);
  MC.noteCalibration("w1", [0.8, 0.8, 0.85, 0.9, 0.92, 0.94, null], "xt", nowMs);
  let m = MC.getMemoryCheck();
  eq("cal: 見込みを出した数（覚えていない通りは数えない）", m.cal.n, [2, 2, 2, 2, 2, 2, 1]);
  eq("cal: 帯ごとの [○, ×記憶, ×1 打ミス]（1.5 の通り: 0.9 → 帯 1 の ○、0.8 → 帯 3 の ×1 打ミス）", [m.cal.b[1][1].slice(0, 3), m.cal.b[1][3].slice(0, 3)], [[1, 0, 0], [0, 0, 1]]);
  near("cal: 対数損失の和（1.5 の通り）", m.cal.ll[1], Math.round((-Math.log(0.9) - Math.log(0.2)) * 1000) / 1000, 0.002);
  near("cal: 1 打ミスの × を除いた損失（1.5 の通り）", m.cal.lm[1], Math.round(-Math.log(0.9) * 1000) / 1000, 0.002);
  const b = MC.bucketOf("w1");
  eq("cal: 語の束の損失の差は 7 通りとも見込みのある答えだけ（2 件目は 7 通り目が null で数えない）", m.cal.w[b][6], 1);
  ok("語の束は 0〜63・同じ id は同じ束", b >= 0 && b < 64 && MC.bucketOf("w1") === b && MC.bucketOf("w2") !== undefined);
  MC.noteSpeedNext(MC.decodePend(MC.encodePend({ a: true, b: true, m: 1, p: 2, t: 0, rank: 4 })), 7, "o", nowMs);
  m = MC.getMemoryCheck();
  eq("speedNext: 材料 a と b のそれぞれに、3 つの物差し（m・p・t）の分類 × 段 × 帯", Object.keys(m.speedNext).sort(), ["m.a.f.4.6-13", "m.b.f.4.6-13", "p.a.n.4.6-13", "p.b.n.4.6-13", "t.a.u.4.6-13", "t.b.u.4.6-13"]);
  MC.noteXNext("m3a", 1, "xm", nowMs);
  MC.noteXNext("zz", 1, "o", nowMs);
  MC.noteCapHit(31, "o", nowMs);
  MC.noteCapHit(0, "o", nowMs);
  m = MC.getMemoryCheck();
  eq("xNext・capHit: 知らない種類・帯の無い gap は数えない", [m.xNext, m.capHit], [{ "m3a.1": [0, 1, 0] }, { "30+": [1, 0, 0] }]);
  for (let i = 0; i < 25; i++) MC.noteSamples({ t1: 1000 + i * 10, tp: 1500 + i * 10, qLen: 3, aLen: 6, input: "kbd", first: i === 0 }, nowMs);
  MC.noteSamples({ t1: 150, qLen: 3, aLen: 6, input: "kbd" }, nowMs);
  MC.noteSamples({ t1: 31000, qLen: 3, aLen: 6, input: "kbd" }, nowMs);
  MC.noteSamples({ t1: 1000, qLen: 3, aLen: 6, input: "pen" }, nowMs);
  m = MC.getMemoryCheck();
  eq("見本: 200ms 未満・30 秒超・知らない経路は入れない（25 件）", [m.input.kbd.t1.length, m.len.kbd.q[1].length, m.len.kbd.a[1].length, m.first.f.length, m.first.r.length], [25, 25, 25, 1, 24]);
  const basis = MC.speedBasis({ qLen: 4, input: "kbd" });
  eq("本人の基準: 字数帯の中央値・経路の中央値・下から 2 割・T1 ＋ 止まりの中央値（20 件以上）", basis, { all: 1120, band: 1120, p20: 1040, tp: 1620 });
  eq("本人の基準: 帯が 20 件未満なら null（呼び手は経路全体で比べる）", MC.speedBasis({ qLen: 9, input: "kbd" }).band, null);
  eq("物差し p（下から 2 割 × 1.3）と t（T1 ＋ 止まりの中央値比）", [MC.classP20(1300, 1000), MC.classP20(1301, 1000), MC.classP20(2601, 1000), MC.classP20(900, null), MC.classTp(750, 1000), MC.classTp(1501, 1000)], [1, 2, 3, 0, 1, 3]);
  MC.noteInputCount("ime", true, nowMs);
  MC.noteInputCount("ime", false, nowMs);
  eq("経路ごとの測った正解の数と、一度に 2 字以上入った数", [MC.getMemoryCheck().input.ime.n, MC.getMemoryCheck().input.ime.multi], [2, 1]);
  eq("印と控えの符号は往復する", [MC.decodeMark(MC.encodeMark({ a: true, b: false, qb: 2, ab: 3, first: true, input: "ime" })), MC.decodePend(MC.encodePend({ a: false, b: true, m: 3, p: 1, t: 2, rank: 5 }))], [{ a: true, b: false, qb: 2, ab: 3, first: true, input: "ime" }, { a: false, b: true, m: 3, p: 1, t: 2, rank: 5 }]);

  // 書く機会: 10 答えごと（tick。答えのタスクの外＝手が空いたとき）・flush。変わっていなければ書かない
  writes.clear();
  for (let i = 0; i < 9; i++) MC.tickMemoryCheck();
  await wait();
  eq("9 答えでは書かない", writesOf("spelldash_memory_check"), 0);
  MC.tickMemoryCheck();
  eq("10 答え目: 答えのタスクの中では書かない", writesOf("spelldash_memory_check"), 0);
  await wait();
  eq("10 答え目の後（手が空いたとき）に 1 回書く", writesOf("spelldash_memory_check"), 1);
  eq("変わっていなければ flush しても書かない", [MC.flushMemoryCheck(), writesOf("spelldash_memory_check")], [false, 1]);
  const saved = JSON.parse(store.get("spelldash_memory_check"));
  eq("保存の形: v 1・schedV 1・since（ローカル日）", [saved.v, saved.schedV, saved.since], [1, 1, "2026-10-14"]);

  // 2 つのタブ（別のモジュール）: 書く直前に読み直し、このタブで足した分だけを足す
  const A = await import("../js/memoryCheck.js?tab=a");
  const B = await import("../js/memoryCheck.js?tab=b");
  A.forgetMemoryCheck();
  B.forgetMemoryCheck();
  A.noteXNext("e", 3, "o", nowMs);
  B.noteXNext("e", 3, "xm", nowMs);
  B.noteXNext("e", 3, "xm", nowMs);
  A.flushMemoryCheck();
  B.flushMemoryCheck();
  eq("2 つのタブ: 互いの足し算を消さない", JSON.parse(store.get("spelldash_memory_check")).xNext["e.2-5"], [1, 2, 0]);
  // 消去・復元の後: メモリーを捨てると古い中身を書き戻さない
  A.noteXNext("h", 3, "o", nowMs);
  store.delete("spelldash_memory_check");
  A.forgetMemoryCheck();
  eq("消去の後に forget すると、書きかけ（このタブで足した分）も書かない", [A.flushMemoryCheck(), store.has("spelldash_memory_check")], [false, false]);
  store.set("spelldash_memory_check", JSON.stringify({ v: 1, schedV: 2, xNext: { "e.1": [9, 9, 9] } }));
  eq("出し方の版の違う集計は混ぜない（空から）", A.getMemoryCheck().xNext, {});
  store.set("spelldash_memory_check", "{壊れた");
  A.forgetMemoryCheck();
  eq("壊れた保存は空として読む", A.getMemoryCheck().cal.n, [0, 0, 0, 0, 0, 0, 0]);

  // 上限 20 KB: 古い見本から捨て、それでも超えるなら件数の少ない枡から
  const big = JSON.parse(JSON.stringify(A.getMemoryCheck()));
  for (const p of MC.PATHS) {
    big.len[p] = { q: [0, 1, 2, 3].map(() => Array(40).fill(6999)), a: [0, 1, 2, 3].map(() => Array(40).fill(6999)) };
    big.input[p] = { t1: Array(40).fill(6999), tp: Array(40).fill(13999), n: 99, multi: 1 };
  }
  for (let i = 0; i < 900; i++) big.speedNext[`m.a.f.${(i % 5) + 1}.k${i}`] = [i, 1, 0];
  const json = MC.fitSize(big);
  ok(`上限: 20,000 字以下に収める（${json.length}）`, json.length <= MC.MAX_BYTES);
  ok("上限: 見本は古い方から捨てる（直近は残る・40 件より少ない）", big.input.kbd.t1.length < 40);
  ok("上限: それでも超えるときは件数の少ない枡から捨てる（多い枡は残る）", !big.speedNext["m.a.f.1.k0"] && !!big.speedNext["m.a.f.5.k899"]);
  const small = JSON.parse(JSON.stringify(A.getMemoryCheck()));
  small.first.f = [1, 2, 3];
  MC.fitSize(small);
  eq("上限より小さければ何も捨てない", small.first.f, [1, 2, 3]);
}

// ── 4. 書き手（js/stats.js）: sp の材料・× の細目・影の欄・別の日の復習 ─────────────
{
  const W = await import("../js/stats.js");
  const MM = await import("../js/masteryMeta.js");
  const ST = await import("../js/storage.js");
  const RealDate = Date;
  let clock = new RealDate(2026, 9, 14, 9, 0, 0).getTime();
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
  const quiet = console.warn;
  console.warn = noop;
  const DAY = 86400000;
  const HOUR = 3600000;
  const tick = () => new Promise((r) => setImmediate(r));
  const blank = (over = {}) => ({ playCount: 1, correctCount: 0, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 0, mastered: false, masteredAt: null, lastPlayed: null, nextReviewAt: null, lastRecallFailAt: null, lastRecallSuccessAt: null, dailyLearningDate: null, dailyLearningStage: 0, srsAdvancedOn: null, ...over });
  // mem: 語ごとの記録の質（spelldash_memory_words の 1 件 { t, memSv, memD, memD0, sp?, spP? }）を最初から置く
  const seed = (map, mem = null) => {
    store.set("spelldash_word_stats", JSON.stringify(map));
    store.delete("spelldash_memory_check");
    if (mem) store.set("spelldash_memory_words", JSON.stringify({ v: 1, w: mem }));
    else store.delete("spelldash_memory_words");
    ST.forgetWordStats();
    MM.forgetMasteryMeta();
    MC.forgetMemoryCheck();
    MW.forgetMemoryWords();
  };
  const readStat = (id) => JSON.parse(store.get("spelldash_word_stats"))[id];
  // 語の記録と、別のキーの語ごとの記録の質を重ねて読む（記録の質の欄は word_stats に無い）
  const read = (id) => ({ ...readStat(id), ...(MW.getMemoryWord(id) ?? {}) });
  const measure = (over = {}) => ({ t1: 420, pcMax: 180, qLen: 3, aLen: 5, input: "kbd", multi: false, outside: false, stalled: false, firstSight: false, ...over });
  const answer = async (id, m = measure(), speed = "normal", clean = true) => {
    W.recordCorrect(id, clean);
    W.recordRecallSuccess(id, { clean, speed }, m);
    await tick();
    return read(id);
  };
  const dayNo = (ms) => Math.round((new RealDate(new RealDate(ms).getFullYear(), new RealDate(ms).getMonth(), new RealDate(ms).getDate()).getTime() - new RealDate(1970, 0, 1).getTime()) / DAY);

  // ---- (a) の材料: 初めての答え → 入る。同じ日・翌日は入らない。3 日後は入る ----
  seed({ w1: blank(), w2: blank(), w3: blank() });
  let s = await answer("w1", measure({ t1: 420 }), "fast");
  eq("初めての答え（ノーミス・400ms 以上）: sp に 1 件 [日番号, T1, q（基準が無い間は null）, 分類, 印]", s.sp, [[dayNo(clock), 420, null, "f", MC.encodeMark({ a: true, qb: 1, ab: 1, first: true, input: "kbd" })]]);
  eq("初めての答え: 影の 7 通りは 14 日（0.1 刻みの整数 140）・D 3", [s.memSv, s.memD, s.memD0], [[140, 140, 140, 140, 140, 140, 140], 30, 30]);
  ok("初めての答え: 控え spP（材料 a）", Array.isArray(s.spP) && MC.decodePend(s.spP[1]).a === true);
  eq("置き場所: 語の記録（word_stats）には記録の質の欄を書かない（別のキー spelldash_memory_words。時刻 t = 自力正解の時刻）", [["sp", "spP", "memSv", "memD", "memD0", "t"].filter((k) => k in readStat("w1")), MW.getMemoryWord("w1").t === Date.parse(readStat("w1").lastRecallSuccessAt)], [[], true]);
  clock += 2 * HOUR;
  s = await answer("w1", measure({ t1: 500 }));
  eq("同じ日の 2 回目: sp は増えない", s.sp.length, 1);
  clock += 22 * HOUR; // 翌日 9 時
  s = await answer("w1", measure({ t1: 520 }));
  eq("翌日（1 暦日）: sp は増えない（材料 (a) は 3 暦日以上）・知ってた語（S 14）は (b) でもない → 控えも無い", [s.sp.length, s.spP ?? null], [1, null]);
  clock += 3 * DAY;
  s = await answer("w1", measure({ t1: 610 }));
  eq("3 暦日あけた最初の答え: sp に 2 件目", s.sp.length, 2);
  clock += 3 * DAY;
  await answer("w1", measure({ t1: 630 }));
  clock += 3 * DAY;
  s = await answer("w1", measure({ t1: 640 }));
  eq("sp は直近 3 件（420 は押し出される）", s.sp.map((e) => e[1]), [610, 630, 640]);
  // 入れない答え
  clock += 3 * DAY;
  for (const [label, m] of [
    ["一度に 2 字以上（multi）", measure({ multi: true })],
    ["1 打目の前に盤面の外（outside）", measure({ outside: true })],
    ["30 秒超", measure({ t1: 30001 })],
    ["200ms 未満", measure({ t1: 150 })],
    ["測れなかった語（null）", null]
  ]) {
    seed({ w9: blank() });
    const st = await answer("w9", m);
    eq(`入れない: ${label}`, [st.sp ?? null, st.spP ?? null], [null, null]);
  }
  seed({ w9: blank() });
  eq("入れない: 打ち間違いありの正解（Battle の clean 偽）", (await answer("w9", measure(), "unknown", false)).sp ?? null, null);
  seed({ w9: blank() });
  await answer("w9", measure({ multi: true, input: "ime" }));
  eq("一度に 2 字以上の正解は sp・見本に入れないが、経路の数（測った正解・2 字以上）には数える", [MC.getMemoryCheck().input.ime.n, MC.getMemoryCheck().input.ime.multi, MC.getMemoryCheck().input.ime.t1.length], [1, 1, 0]);
  seed({ w9: blank() });
  s = await answer("w9", measure({ stalled: true, pcMax: 3500 }));
  eq("止まった答え（stalled）: sp には入る・「T1 ＋ 最も長い止まり」の見本には入れない", [s.sp.length, MC.getMemoryCheck().input.kbd.t1.length, MC.getMemoryCheck().input.kbd.tp.length], [1, 1, 0]);

  // ---- (b) の印: 覚えた語（× → 同じ日に自力正解で S 1）を翌日に答える → (a) でないので sp に入らないが、控えは (b) ----
  seed({ w4: blank() });
  W.recordRecallFail("w4", { k: "e", p: 2 });
  await tick();
  clock += 5 * 60000;
  s = await answer("w4", measure());
  eq("× の後の同じ日の自力正解: 影の S 1（10）・D min(7, 4 + 1) = 5（50）", [s.memSv[1], s.memD], [10, 50]);
  clock += DAY;
  s = await answer("w4", measure());
  ok("翌日（t 1 ≥ 0.5 × S 1）: sp に入らず、控えは材料 (b) だけ", !s.sp && MC.decodePend(s.spP[1]).b === true && MC.decodePend(s.spP[1]).a === false);
  ok("翌日の正解で影の S が伸びる（1.5 の通り 1 → 1.4 以上）", s.memSv[1] > 10);

  // ---- q: 経路の基準（20 件）が育つと q が数になる ----
  seed({ ...Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`q${i}`, blank()])) });
  let last = null;
  for (let i = 0; i < 22; i++) last = await answer(`q${i}`, measure({ t1: 1000 + (i === 21 ? 500 : 0) }));
  eq("q: 同じ字数帯の見本が 20 件以上なら、帯の中央値との比（1,500 ÷ 1,000 × 100 = 150）", last.sp[0][2], 150);

  // ---- × の細目（history の k・p・a） ----
  seed({ x1: blank({ lastRecallSuccessAt: new RealDate(clock - 3 * DAY).toISOString(), cleanCorrectStreak: 2, correctCount: 2, history: [{ d: "2026-10-01", r: "o" }] }) });
  W.recordRecallFail("x1", { k: "m", p: 3, a: true });
  await tick();
  eq("1 打ミス: history の最後に { k: m, p: 3, a: true }", read("x1").history.at(-1), { d: W.localDateString(), r: "x", k: "m", p: 3, a: true });
  W.recordRecallFail("x1", { k: "e", p: 0, a: null });
  W.recordRecallFail("x1");
  W.recordRecallFail("x1", { k: "zz", p: 2 });
  W.recordRecallFail("x1", { k: "h", p: -1 });
  await tick();
  eq("答え表示 { k: e, p: 0 }（a は m だけ）・引数なし（Battle）は u・知らない種類は u・負の字数は書かない", read("x1").history.slice(-4).map(({ k, p, a }) => ({ k, p, a })), [{ k: "e", p: 0, a: undefined }, { k: "u", p: undefined, a: undefined }, { k: "u", p: undefined, a: undefined }, { k: "h", p: undefined, a: undefined }]);
  eq("history は 8 件まで（形は変えない）", read("x1").history.length, 6);

  // ---- 移行: 影の欄の無い語は今の記録から作り、その日の最初の答えで見込みを数える ----
  seed({ m1: blank({ correctCount: 3, cleanCorrectStreak: 3, lastRecallSuccessAt: new RealDate(clock - 3 * DAY).toISOString(), nextReviewAt: new RealDate(clock).toISOString(), history: [{ d: "2026-10-01", r: "o" }] }) });
  s = await answer("m1", measure({ t1: 900 }));
  eq("移行: 期日 − 最後の自力正解 = 3 日 → S 3、t 3 の正解（見込み 0.9・期日どおり）で 1.5 の通りは 3 × G（D 4 → 伸び 1.56）", s.memSv[1], Math.round(3 * (1 + 0.5 * 1.12) * 10));
  eq("移行: 見込みを cal に 1 件（7 通り）", MC.getMemoryCheck().cal.n, [1, 1, 1, 1, 1, 1, 1]);

  // ---- 2 台目・古い版で答えた語: 影の欄を書いた時刻（記録の質の t）より新しい答えがあれば、S を同期する欄から作り直す（D は残し、見ていない × で +1） ----
  {
    const okAt = new RealDate(clock - 3 * DAY).toISOString();
    const failAt = new RealDate(clock - 2 * DAY).toISOString();
    const shadow500 = { t: Date.parse(okAt), memSv: [500, 500, 500, 500, 500, 500, 500], memD: 30, memD0: 30 };
    seed({ d2: blank({ correctCount: 5, cleanCorrectStreak: 0, recallFail: 1, lastRecallSuccessAt: okAt, lastRecallFailAt: failAt, nextReviewAt: failAt, masteryRank: 4, masteryAt: okAt, history: [{ d: "2026-10-01", r: "o" }] }) }, { d2: shadow500 });
    W.recordRecallFail("d2", { k: "e", p: 0 });
    await tick();
    const st = read("d2");
    eq("2 台目の × を見ていない語: S は同期する欄から（未解決 → 1、今日の × で 0.3 倍して下限 1）・D は 3 + 見ていない × 1 + 今日の × 1 = 5", [st.memSv, st.memD], [[10, 10, 10, 10, 10, 10, 10], 50]);
    seed({ d3: blank({ correctCount: 5, cleanCorrectStreak: 3, lastRecallSuccessAt: okAt, nextReviewAt: new RealDate(clock).toISOString(), masteryRank: 4, masteryAt: okAt }) }, { d3: shadow500 });
    await answer("d3", measure());
    eq("見ていない答えが無い語（記録の質の t = 最後の答え）は影の欄をそのまま使う（S 50 から伸びる）", read("d3").memSv[1] >= 500, true);
    // 古い版（この端末の前の版の書き手は段と masteryAt を書くが、記録の質を書かない）で答えた語も、t より新しい答えとして作り直す
    seed({ d4: blank({ correctCount: 5, cleanCorrectStreak: 0, recallFail: 1, lastRecallSuccessAt: okAt, lastRecallFailAt: failAt, nextReviewAt: failAt, masteryRank: 3, masteryAt: failAt }) }, { d4: shadow500 });
    clock += DAY;
    await answer("d4", measure());
    eq("古い版で答えた語（masteryAt は新しい・記録の質の t は古い）: S は同期する欄から作り直す（50 のまま伸ばさない）", read("d4").memSv[1] < 500, true);

    // 見ていない答えをはさんだ速さの控え（spP）は speedNext に数えない（控えの「次の答え」は見ていない答えなので、数えると結果を別の答えに、
    // 間隔を別の間隔に付ける）。控えは欠けた記録として捨てる。この答えが材料なら、この答えの控えを新しく作る
    const speedNextNow = () => MC.getMemoryCheck().speedNext;
    const syncedAnswer = (id) => {
      // 2 台目で答えた（同期の取り込みで lastRecallSuccessAt・期日・streak だけが来る。js/sync.js）
      const stats = JSON.parse(store.get("spelldash_word_stats"));
      const iso = new RealDate(clock).toISOString();
      stats[id] = { ...stats[id], lastRecallSuccessAt: iso, lastPlayed: iso, nextReviewAt: new RealDate(clock + 3 * DAY).toISOString(), cleanCorrectStreak: (stats[id].cleanCorrectStreak ?? 0) + 1 };
      store.set("spelldash_word_stats", JSON.stringify(stats));
      ST.forgetWordStats();
    };
    // 対照: 見ていない答えが無ければ、初めての答えの控えを次のその日の最初の答え（4 日後）で数える
    seed({ p0: blank() });
    await answer("p0", measure());
    MW.flushMemoryWords();
    clock += 4 * DAY;
    await answer("p0", measure());
    eq("対照（見ていない答えなし）: 初めての答えの控えを 4 日後の答えで speedNext に数える（m・p・t の 3 枡、2〜5 日の帯）", Object.keys(speedNextNow()).map((k) => k.split(".").at(-1)), ["2-5", "2-5", "2-5"]);
    // (1) 2 台目の答えをはさむ: 0 日目（この端末）→ 4 日目（2 台目）→ 12 日目（この端末）
    seed({ p1: blank() });
    await answer("p1", measure());
    MW.flushMemoryWords();
    clock += 4 * DAY;
    syncedAnswer("p1");
    clock += 8 * DAY;
    const p1 = await answer("p1", measure());
    eq("2 台目の答えをはさんだ控え: この端末の次のその日の最初の答え（12 日後）で speedNext に数えない（本当の次の答えは 4 日後・2 台目）", speedNextNow(), {});
    eq("同上: この答え（2 台目の答えから 8 日・材料 a）の控えは今日の日番号で作る", [p1.spP?.[0], MC.decodePend(p1.spP?.[1])?.a], [dayNo(clock), true]);
    // (1b) 2 台目の答えと同じ日のこの端末の答え（その日の最初の答えではない）でも控えを捨てる（後の日に数え直さない）
    seed({ p4: blank() });
    await answer("p4", measure());
    MW.flushMemoryWords();
    clock += 5 * DAY;
    syncedAnswer("p4");
    clock += 3 * HOUR;
    const p4 = await answer("p4", measure());
    clock += 4 * DAY;
    await answer("p4", measure());
    eq("2 台目の答えと同じ日のこの端末の答え: 控えを捨てる（4 日後の答えで初めての答えの控えを 9 日として数えない）", [p4.spP ?? null, speedNextNow()], [null, {}]);
    // (2) タブが落ちた: 3 日目の答え（初めての答えの控えを数え、新しい控えを作った）が、集計も語ごとの欄も書く前に落ちる → 10 日目
    seed({ p2: blank() });
    await answer("p2", measure());
    MW.flushMemoryWords();
    MC.flushMemoryCheck();
    clock += 3 * DAY;
    await answer("p2", measure());
    MC.forgetMemoryCheck();
    MW.forgetMemoryWords();
    MM.forgetMasteryMeta();
    clock += 7 * DAY;
    await answer("p2", measure());
    eq("タブが落ちて書けなかった答えの次の答え（10 日後）: 初めての答えの控えを「次の間隔 6〜13 日」として数えない（本当の次の答えは 3 日後）", speedNextNow(), {});
    // (2b) 集計は書けたが語ごとの欄は書く前に落ちた: 同じ控えを 2 度数えない
    seed({ p3: blank() });
    await answer("p3", measure());
    MW.flushMemoryWords();
    MC.flushMemoryCheck();
    clock += 3 * DAY;
    await answer("p3", measure());
    MC.flushMemoryCheck();
    const counted = speedNextNow();
    MC.forgetMemoryCheck();
    MW.forgetMemoryWords();
    clock += 7 * DAY;
    await answer("p3", measure());
    eq("集計だけ書けて語ごとの欄が落ちた語: 初めての答えの控えを 2 度数えない（speedNext は 3 日後の答えで数えた 3 枡のまま）", [Object.keys(counted).length, speedNextNow()], [3, counted]);
  }

  // ---- xNext: 前の日の最初の × の種類 → 次のその日の最初の答え ----
  seed({ x2: blank({ correctCount: 3, cleanCorrectStreak: 3, lastRecallSuccessAt: new RealDate(clock - 3 * DAY).toISOString(), nextReviewAt: new RealDate(clock).toISOString() }) });
  W.recordRecallFail("x2", { k: "m", p: 1, a: false });
  await tick();
  clock += 4 * 60000;
  await answer("x2", measure());
  clock += DAY;
  await answer("x2", measure());
  eq("xNext: 2 字目までの 1 打ミス（m2）の翌日の答え ○", MC.getMemoryCheck().xNext, { "m2.1": [1, 0, 0] });

  // ---- 書き込みの回数: 正解の 1 打の word_stats は 1 回（新しい欄は同じ写しに書く） ----
  seed({ r1: blank() });
  writes.clear();
  W.recordCorrect("r1", true);
  W.recordRecallSuccess("r1", { clean: true, speed: "normal" }, measure());
  await tick();
  eq("正解の 1 打で spelldash_word_stats の setItem は 1 回・spelldash_memory_words は 0 回（10 答えごと）", [writesOf("spelldash_word_stats"), writesOf("spelldash_memory_words")], [1, 0]);
  ok("同期の行を作る js/sync.js は新しい欄を読まない（送る行は 15 列のまま）", !/\b(sp|spP|memSv|memD|memD0)\b/.test(readFileSync(path.join(ROOT, "js/sync.js"), "utf8").replace(/\/\/.*$/gm, "")));

  // ---- S5: 「別の日」の復習（最後の自力正解と暦日が違い、6 時間以上） ----
  const ra = (okAt, now) => {
    clock = new RealDate(now).getTime();
    return W.isReviewAttempt({ lastRecallSuccessAt: new RealDate(okAt).toISOString() });
  };
  eq("復習: 前日 23 時の正解を翌日 9 時（10 時間）→ 復習", ra("2026-10-13T23:00:00+09:00", "2026-10-14T09:00:00+09:00"), true);
  eq("復習: 前日 23 時の正解を翌日 2 時（3 時間）→ 復習でない", ra("2026-10-13T23:00:00+09:00", "2026-10-14T02:00:00+09:00"), false);
  eq("復習: 同じ日の 1 時の正解を 23 時半（22.5 時間）→ 復習でない（前は 20 時間で復習）", ra("2026-10-14T01:00:00+09:00", "2026-10-14T23:30:00+09:00"), false);
  eq("復習: 時計が戻って正解が先に見える → 復習でない", ra("2026-10-15T12:00:00+09:00", "2026-10-14T12:00:00+09:00"), false);
  eq("復習: 自力正解が無い・読めない → 復習でない", [W.isReviewAttempt({}), W.isReviewAttempt({ lastRecallSuccessAt: "x" })], [false, false]);

  globalThis.Date = RealDate;
  console.warn = quiet;
}

// ── 4b. 語ごとの記録の質の置き場所（spelldash_memory_words・js/memoryWords.js）: 書く機会・読み直して足す・壊れた保存・上限 ─────────────
{
  const W = await import("../js/stats.js");
  const ST = await import("../js/storage.js");
  const MM = await import("../js/masteryMeta.js");
  const KEY = "spelldash_memory_words";
  const at = (ms) => new Date(ms).toISOString();
  const T = Date.UTC(2026, 9, 14, 0, 0, 0);
  const statAt = (ms) => ({ playCount: 1, correctCount: 1, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 1, mastered: false, lastRecallSuccessAt: at(ms), lastRecallFailAt: null, nextReviewAt: at(ms + 86400000) });
  const entry = (t, extra = {}) => ({ t, memSv: [10, 10, 10, 10, 10, 10, 10], memD: 50, memD0: 50, ...extra });
  const reset = (stats, stored = undefined) => {
    store.clear();
    store.set("spelldash_word_stats", JSON.stringify(stats));
    if (stored !== undefined) store.set(KEY, stored);
    ST.forgetWordStats();
    MM.forgetMasteryMeta();
    MC.forgetMemoryCheck();
    MW.forgetMemoryWords();
    writes.clear();
  };
  const saved = () => JSON.parse(store.get(KEY) ?? "null");

  // 書く機会: 書き手の 9 答えでは書かず、10 答え目の後（答えのタスクの外）に 1 回
  const blank = () => ({ playCount: 1, correctCount: 0, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 0, mastered: false, masteredAt: null, lastPlayed: null, nextReviewAt: null, lastRecallFailAt: null, lastRecallSuccessAt: null, dailyLearningDate: null, dailyLearningStage: 0, srsAdvancedOn: null });
  reset(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}`, blank()])));
  for (let i = 0; i < 9; i++) {
    W.recordCorrect(`n${i}`, true);
    W.recordRecallSuccess(`n${i}`, { clean: true, speed: "normal" }, null);
    await new Promise((r) => setImmediate(r));
  }
  await wait();
  eq("書き手の 9 答えでは spelldash_memory_words を書かない（word_stats は 9 回）", [writesOf(KEY), writesOf("spelldash_word_stats")], [0, 9]);
  W.recordCorrect("n9", true);
  W.recordRecallSuccess("n9", { clean: true, speed: "normal" }, null);
  eq("10 答え目: 答えのタスクの中では書かない", writesOf(KEY), 0);
  await wait();
  eq("10 答え目の後（手が空いたとき）に 1 回書く・10 語とも入る（v 1）", [writesOf(KEY), saved()?.v, Object.keys(saved()?.w ?? {}).length], [1, 1, 10]);
  eq("変えた語が無ければ flush しても書かない", [MW.flushMemoryWords(), writesOf(KEY)], [false, 1]);
  MM.flushMasteryMeta();
  await wait();
  eq("回の終わり（flushMasteryMeta）も変えた語が無ければ書かない", writesOf(KEY), 1);
  W.recordRecallFail("n0", { k: "e", p: 0 });
  await new Promise((r) => setImmediate(r));
  MM.flushMasteryMeta();
  eq("回の終わり: このタスクの中では書かず", writesOf(KEY), 1);
  await wait();
  eq("回の終わりの後に 1 回書く（× の答えも t が新しくなる）", [writesOf(KEY), saved().w.n0.t === Date.parse(JSON.parse(store.get("spelldash_word_stats")).n0.lastRecallFailAt)], [2, true]);

  // 2 つのタブ（別のモジュール）: 書く直前に読み直し、このタブで変えた語だけを足す。もう一方が後から答えた語は保存のまま
  reset({ a1: statAt(T + 3000), b1: statAt(T + 1000), c1: statAt(T + 2000) });
  const A = await import("../js/memoryWords.js?tab=a");
  const B = await import("../js/memoryWords.js?tab=b");
  A.forgetMemoryWords();
  B.forgetMemoryWords();
  A.useWordStatsReader(ST.getWordStats); // 各タブの js/stats.js が渡す読み手
  B.useWordStatsReader(ST.getWordStats);
  A.putMemoryWord("a1", entry(T + 3000));
  A.putMemoryWord("c1", entry(T + 2000, { memD: 70 }));
  B.putMemoryWord("b1", entry(T + 1000));
  B.putMemoryWord("c1", entry(T + 1500, { memD: 60 }));
  A.flushMemoryWords();
  B.flushMemoryWords();
  eq("2 つのタブ: 互いの語を消さない・同じ語は後の答え（t の大きい方）が残る", [Object.keys(saved().w).sort(), saved().w.c1.memD], [["a1", "b1", "c1"], 70]);

  // 復元・端末の記録を消す（別のタブ）の後: 語の記録に無い語・語の記録の最後の答えの方が古い語は書き戻さない
  reset({ k1: statAt(T + 1000), k2: statAt(T + 1000) });
  A.forgetMemoryWords();
  A.putMemoryWord("k1", entry(T + 1000));
  A.putMemoryWord("k2", entry(T + 9000)); // この答えの後に、別のタブが古いバックアップを復元した（語の記録は T + 1000 の答えまで）
  A.putMemoryWord("gone", entry(T + 9000)); // 別のタブが端末の記録を消した（語の記録に無い）
  A.flushMemoryWords();
  eq("語の記録に無い語・語の記録の最後の答えより新しい語は書かない（別のタブの復元・消去・語の記録を書けなかった答え）", Object.keys(saved().w), ["k1"]);

  // 同じタブで続けて書く: 保存が前に書いた文字列のままなら JSON から戻さない（読み直しの parse は 0 回）。書き戻さない語は保存の値に戻す
  reset({ k1: statAt(T + 1000), k2: statAt(T + 1000) }, JSON.stringify({ v: 1, w: { k2: entry(T + 1000, { memD: 11 }) } }));
  const realParse = JSON.parse;
  let wordsParses = 0;
  JSON.parse = function (text, rev) {
    if (typeof text === "string" && text.startsWith('{"v":1,"w":')) wordsParses++;
    return realParse.call(this, text, rev);
  };
  let parseInFlush = null;
  let k2After = null;
  try {
    MW.getMemoryWord("k1"); // 読む（parse 1 回）
    const p0 = wordsParses;
    MW.putMemoryWord("k1", entry(T + 1000, { memD: 70 }));
    MW.flushMemoryWords();
    MW.putMemoryWord("k2", entry(T + 9000, { memD: 99 })); // 語の記録より新しい（書き戻さない）
    MW.flushMemoryWords();
    parseInFlush = wordsParses - p0;
    k2After = [saved().w.k2.memD, MW.getMemoryWord("k2").memD];
    // ほかのタブが書いた後は読み直して足す（このタブの変化だけ）
    store.set(KEY, JSON.stringify({ v: 1, w: { ...saved().w, k3: entry(T + 5000) } }));
    MW.putMemoryWord("k1", entry(T + 1000, { memD: 72 }));
    MW.flushMemoryWords();
  } finally {
    JSON.parse = realParse;
  }
  eq("同じタブで続けて書く: 読み直しの parse は 0 回・書き戻さない語は保存の値（memD 11）に戻す（保存とメモリーの両方）", [parseInFlush, k2After], [0, [11, 11]]);
  eq("ほかのタブが書いた後: 読み直して、もう一方の語（k3）を残し、このタブの語だけを足す", [Object.keys(saved().w).sort(), saved().w.k1.memD], [["k1", "k2", "k3"], 72]);

  // 消去・復元の後（このタブ）: forget で書きかけも捨てる
  A.putMemoryWord("k1", entry(T + 1000, { memD: 90 }));
  store.delete(KEY);
  A.forgetMemoryWords();
  eq("forget の後は書きかけを書かない", [A.flushMemoryWords(), store.has(KEY)], [false, false]);

  // 壊れた保存: 止めずに空として読み、上書きする前に 1 つだけ写す
  for (const [label, raw] of [["JSON でない", "{壊れた"], ["表でない（配列）", "[1,2,3]"], ["版が違う", JSON.stringify({ v: 2, w: {} })], ["w が無い", JSON.stringify({ v: 1 })]]) {
    reset({ k1: statAt(T + 1000) }, raw);
    let threw = false;
    let got = "x";
    try {
      got = MW.getMemoryWord("k1");
      MW.putMemoryWord("k1", entry(T + 1000));
      MW.flushMemoryWords();
    } catch {
      threw = true;
    }
    eq(`壊れた保存（${label}）: 止まらない・空として読む・写しを残して上書きする`, [threw, got, store.get("spelldash_memory_words_corrupt"), Object.keys(saved()?.w ?? {})], [false, null, raw, ["k1"]]);
  }
  reset({ k1: statAt(T + 1000) }, JSON.stringify({ v: 1, w: { k1: 5, k2: [1], k3: null } }));
  eq("語ごとの値が表でない語は無いものとして読む（移行の値で作り直す）", [MW.getMemoryWord("k1"), MW.getMemoryWord("k2"), MW.getMemoryWord("k3"), store.has("spelldash_memory_words_corrupt")], [null, null, null, false]);
  reset({}, "null");
  eq("null は空（写さない）", [MW.getMemoryWord("k1"), store.has("spelldash_memory_words_corrupt")], [null, false]);

  // 上限: 超えたら最後に答えた時刻の古い語から捨てて 9 割に収める
  const many = {};
  for (let i = 0; i < 200; i++) many[`z${String(i).padStart(3, "0")}`] = statAt(T + i * 1000);
  reset(many);
  for (let i = 0; i < 200; i++) MW.putMemoryWord(`z${String(i).padStart(3, "0")}`, entry(T + i * 1000, { sp: [[20740, 900, 100, "n", 5]] }));
  MW.flushMemoryWords({ max: 10000 });
  const kept = Object.keys(saved().w);
  ok(`上限: ${store.get(KEY).length} 字 ≤ 上限の 9 割（9,000 字）`, store.get(KEY).length <= 9000 && kept.length > 0);
  ok("上限: 古い語から捨てる（最も新しい語は残り、最も古い語は消える）", kept.includes("z199") && !kept.includes("z000") && kept.every((id) => Number(id.slice(1)) >= 200 - kept.length));
  eq("上限の既定は 50 万字", MW.MAX_CHARS, 500000);

  // 容量で書けない: 半分まで減らしてもう一度
  reset(many);
  for (let i = 0; i < 200; i++) MW.putMemoryWord(`z${String(i).padStart(3, "0")}`, entry(T + i * 1000));
  const realSet = localStorage.setItem;
  let refused = 0;
  localStorage.setItem = (k, v) => {
    if (k === KEY && String(v).length > 12000) {
      refused++;
      throw new Error("QuotaExceededError");
    }
    return realSet(k, v);
  };
  let res;
  try {
    res = MW.flushMemoryWords();
  } finally {
    localStorage.setItem = realSet;
  }
  ok(`容量: 書けなかったら半分まで減らして書き直す（断られた ${refused} 回・${store.get(KEY)?.length} 字・新しい語が残る）`, res === true && refused === 1 && store.get(KEY).length <= 12000 && !!saved().w.z199);
}

// ── 5. 速さの箱（js/masteryMeta.js）: 測りの札で入れない答え・基準も返す ─────────────
{
  const MM = await import("../js/masteryMeta.js");
  store.clear();
  MM.forgetMasteryMeta();
  MC.forgetMemoryCheck();
  eq("箱: 一度に 2 字以上・盤面の外の答えは入れない（今の箱の決まりは変えない）", [MM.noteSpeedSample("en.kbd.study", { t1: 900, pc: 100 }, { multi: true }), MM.noteSpeedSample("en.kbd.study", { t1: 900, pc: 100 }, { outside: true }), MM.getSpeedBox("en.kbd.study").t1.length], [false, false, 0]);
  MM.noteSpeedSample("en.kbd.study", { t1: 900, pc: 100 }, { stalled: true });
  MM.noteSpeedSample("en.kbd.study", { t1: 950, pc: 120 });
  eq("箱: 止まった答えは T1 だけ（pc は入れない）・札なしは今のまま", MM.getSpeedBox("en.kbd.study"), { t1: [900, 950], pc: [120] });
  eq("classifySpeed: 字数・経路を渡さなければ今の形のまま", MM.classifySpeed({ t1: 1400 }, "en.kbd.study", { firstAnswer: true, data: { t1: [], pc: [] } }), { speed: "fast", basis: "prior" });
  eq("classifySpeed: 字数を渡すと比べた基準（全体・字数帯の中央値。20 件未満は null）も返す", MM.classifySpeed({ t1: 1400 }, "en.kbd.study", { firstAnswer: true, data: { t1: [], pc: [] }, qLen: 3 }), { speed: "fast", basis: "prior", all: null, band: null });
}

// ── 6. 不変の模擬（受け入れの基準 1・3）: 製品の書き手を偽の時計で 1 年。この Batch の前の main と 1 件も違わない ─────────────
if (simDone) {
  const { error, stdout, stderr } = await simDone;
  if (error) failures.push(`不変の模擬が走らない: ${error.message}\n${String(stderr).slice(0, 2000)}`);
  else {
    const got = JSON.parse(stdout);
    const want = JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/sim-writers.json"), "utf8"));
    eq("不変の模擬: 答えの数・段の分布・習得の数", [got.answers, got.ranks, got.mastered], [want.answers, want.ranks, want.mastered]);
    const diff = Object.keys(want.words).filter((id) => got.words[id] !== want.words[id]);
    eq(`不変の模擬: 語ごとの nextReviewAt・masteryRank・cleanCorrectStreak・mastered・masteryAt ほか今の欄（${Object.keys(want.words).length} 語）が前の main と同じ`, diff.length === 0 && Object.keys(got.words).length === Object.keys(want.words).length ? [] : diff.slice(0, 20), []);
    const rdiff = Object.keys(want.retentionWords).filter((id) => got.retentionWords[id] !== want.retentionWords[id]);
    eq(`不変の模擬: spelldash_retention（${Object.keys(want.retentionWords).length} 語）が前の main と同じ`, [got.retention === want.retention, rdiff.slice(0, 20)], [true, []]);
    eq("不変の模擬: spelldash_mastery_meta（速さの箱・段の確かめ）が前の main と同じ", got.meta, want.meta);
    ok(`大きさ: 1 語あたりの増えは 200 B 以下（word_stats の × の細目 ${got.size.newBytesPerWord} B ＋ spelldash_memory_words ${got.size.memoryWordsPerWord} B）`, got.size.memoryWordsPerWord > 0 && got.size.newBytesPerWord + got.size.memoryWordsPerWord <= 200);
    ok(`大きさ: 語の記録（word_stats）の 1 語あたりの増えは × の細目だけ（${got.size.newBytesPerWord} B ≤ 10 B）`, got.size.newBytesPerWord > 0 && got.size.newBytesPerWord <= 10);
    ok(`大きさ: spelldash_memory_check は 20 KB 以下（${got.size.memoryCheckBytes} 字）`, got.size.memoryCheckBytes > 0 && got.size.memoryCheckBytes <= 20000);
  }
}

if (failures.length) {
  console.error(`NG: memory ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log(`OK: memory ${passed} passed${simDone ? "（不変の模擬を含む）" : "（--no-sim）"}`);
