// 学習のランク（js/level.js LEARNING_RANKS・learningRankOf・nextLearningRankOf）と紋章の絵の名前（js/emblem.js emblemSrc・preloadRanks）の単体テスト。ブラウザなしで 1 秒で終わる:
//   node scripts/test-level.mjs
// 失敗が 1 つでもあれば終了コード 1。
// 見ること: 21 段（木・銅・銀・金・ダイヤ・レジェンド・神 × 1〜3）の名前・境のレベル・段と番号、Lv.1〜120 の割り付け（表から別に数えた答えと同じ）、
// 単調（レベルが上がってランクが下がらない）、前の称号（F3〜S1・レジェンドの 22 個。2026-10-15 まで）の人が同じレベルで何になるか、
// 次のランク、先読みする絵のランク、絵の名前と 21 段 × 2 種のファイル（段の並び・大きさ・上限は scripts/build-emblems.mjs の TIERS・STEPS・SIZES・TOTAL_MAX_BYTES を
// import して突き合わせる。import しても Chromium は立ち上がらない）、XP の決まり（xpToNext）が変わっていないこと。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window ??= globalThis;
// js/level.js → plan.js → supabase.js は SDK を動的に読みに行く。テストでは読めない URL の代わりに空の殻を渡す（警告の行を出さない）
globalThis.window.__SUPABASE_MODULE_URL = "data:text/javascript,export const createClient = () => ({});";

const L = await import("../js/level.js");
const E = await import("../js/emblem.js");
const B = await import("./build-emblems.mjs");

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond, detail = "") => eq(`${name}${detail ? ` (${detail})` : ""}`, !!cond, true);
const pick = (r) => (r ? { name: r.name, tier: r.tier, step: r.step, level: r.level } : r);

// ---- 21 段の表（「決めたこと」2・3 をそのまま書き写した答え） ----
const NAMES = ["木", "銅", "銀", "金", "ダイヤ", "レジェンド", "神"];
const IDS = ["wood", "copper", "silver", "gold", "diamond", "legend", "god"];
const LEVELS = [1, 2, 3, 5, 7, 9, 12, 15, 18, 22, 26, 30, 35, 40, 45, 51, 57, 63, 70, 80, 92];
const EXPECTED = IDS.flatMap((id, t) => [1, 2, 3].map((step, s) => ({ name: `${NAMES[t]} ${step}`, tier: id, step, level: LEVELS[t * 3 + s] })));

eq("段は 7（木・銅・銀・金・ダイヤ・レジェンド・神。英字の名前は絵のファイル名）", (L.LEARNING_RANK_TIERS ?? []).map((t) => [t.id, t.name]), IDS.map((id, i) => [id, NAMES[i]]));
eq("ランクは 21（名前・段・番号・境のレベル）", (L.LEARNING_RANKS ?? []).map(pick), EXPECTED);
eq("名前は「段の名前・半角の空白・数字」", (L.LEARNING_RANKS ?? []).map((r) => r.name).join("|"), "木 1|木 2|木 3|銅 1|銅 2|銅 3|銀 1|銀 2|銀 3|金 1|金 2|金 3|ダイヤ 1|ダイヤ 2|ダイヤ 3|レジェンド 1|レジェンド 2|レジェンド 3|神 1|神 2|神 3");
ok("表は凍っている（書き換えられない）", !!L.LEARNING_RANKS && Object.isFrozen(L.LEARNING_RANKS) && L.LEARNING_RANKS.every(Object.isFrozen) && Object.isFrozen(L.LEARNING_RANK_TIERS));
// 名前は学習のランクだけのもの（js/mastery.js の語の習熟度の rankOf・RANK_NAMES、js/battleConfig.js の Battle の RANKS と同じ名前にしない。PR #178 のレビュー 6）
eq("前の名前（rankOf・nextRankOf・RANKS・RANK_TIERS）は level.js に無い", ["rankOf", "nextRankOf", "RANKS", "RANK_TIERS"].filter((k) => k in L), []);

const rankOf = (lv) => (typeof L.learningRankOf === "function" ? L.learningRankOf(lv) : null);
const nextRankOf = (lv) => (typeof L.nextLearningRankOf === "function" ? L.nextLearningRankOf(lv) : undefined);

// ---- rankOf: 境と境の 1 つ手前 ----
for (const [i, r] of EXPECTED.entries()) {
  eq(`Lv.${r.level} は ${r.name}`, rankOf(r.level)?.name, r.name);
  if (i > 0) eq(`Lv.${r.level - 1} はまだ ${EXPECTED[i - 1].name}`, rankOf(r.level - 1)?.name, EXPECTED[i - 1].name);
}
eq("learningRankOf は { name, tier, step, level } を返す（Lv.15 は銀 2）", rankOf(15) ? { ...rankOf(15) } : null, { name: "銀 2", tier: "silver", step: 2, level: 15 });

// ---- Lv.1〜120 の割り付け: 表から別に数えた答えと同じ・単調・21 段がどれも使われる ----
const expectAt = (lv) => EXPECTED.filter((r) => r.level <= lv).at(-1) ?? EXPECTED[0];
const bad = [];
const order = [];
for (let lv = 1; lv <= 120; lv++) {
  const got = rankOf(lv);
  if (got?.name !== expectAt(lv).name) bad.push(`${lv}:${got?.name}`);
  order.push((L.LEARNING_RANKS ?? []).indexOf(got));
}
eq("Lv.1〜120 のランクが表どおり", bad, []);
ok("レベルが上がってランクが下がらない（Lv.1〜120 で単調）", order.every((v, i) => v >= 0 && (i === 0 || v >= order[i - 1])), order.join(","));
eq("Lv.1〜120 で 21 段がどれも使われる", new Set(order).size, 21);
eq("Lv.92 から先はずっと神 3（Lv.92・120・500）", [92, 120, 500].map((lv) => rankOf(lv)?.name), ["神 3", "神 3", "神 3"]);
eq("壊れたレベル（0・負・NaN・undefined）は木 1", [0, -3, NaN, undefined].map((lv) => rankOf(lv)?.name), ["木 1", "木 1", "木 1", "木 1"]);

// ---- 次のランク ----
eq("次のランク（Lv.1 → 木 2・Lv.4 → 銅 1・Lv.91 → 神 3）", [1, 4, 91].map((lv) => nextRankOf(lv)?.name), ["木 2", "銅 1", "神 3"]);
eq("神 3 の先は無い（Lv.92・150 → null）", [92, 150].map(nextRankOf), [null, null]);

// ---- 前の称号（2026-10-15 まで。F3 → … → S1 → レジェンド）の人は、レベルが同じまま名前と紋章だけ変わる ----
const OLD = [["F3", 1], ["F2", 2], ["F1", 3], ["E3", 5], ["E2", 7], ["E1", 9], ["D3", 12], ["D2", 15], ["D1", 18], ["C3", 22], ["C2", 26], ["C1", 30], ["B3", 35], ["B2", 40], ["B1", 45], ["A3", 51], ["A2", 57], ["A1", 63], ["S3", 70], ["S2", 77], ["S1", 84], ["レジェンド", 92]];
eq("前の称号の境のレベルで今のランク（S2 の Lv.77 は神 1・S1 の Lv.84 は神 2・レジェンドの Lv.92 は神 3。ほかは同じ順の段）",
  OLD.map(([old, lv]) => `${old}→${rankOf(lv)?.name}`),
  ["F3→木 1", "F2→木 2", "F1→木 3", "E3→銅 1", "E2→銅 2", "E1→銅 3", "D3→銀 1", "D2→銀 2", "D1→銀 3", "C3→金 1", "C2→金 2", "C1→金 3", "B3→ダイヤ 1", "B2→ダイヤ 2", "B1→ダイヤ 3", "A3→レジェンド 1", "A2→レジェンド 2", "A1→レジェンド 3", "S3→神 1", "S2→神 1", "S1→神 2", "レジェンド→神 3"]);

// ---- XP・レベルの決まりは変えない（xpToNext・getLevelState） ----
eq("xpToNext は 100 + (Lv − 1) × 50 のまま", [1, 2, 10, 92].map(L.xpToNext), [100, 150, 550, 4650]);
const xpForLv = (lv) => { let x = 0; for (let l = 1; l < lv; l++) x += L.xpToNext(l); return x; };
const st = (xp) => L.getLevelState(xp);
eq("getLevelState: Lv.5 ちょうどの XP で銅 1・残りは次のレベルまで", (({ level, rank, currentXp, neededXp }) => ({ level, rank: rank?.name, currentXp, neededXp }))(st(xpForLv(5))), { level: 5, rank: "銅 1", currentXp: 0, neededXp: 300 });
eq("getLevelState: 5 XP 手前は木 3（Lv.4）", st(xpForLv(5) - 5).rank?.name, "木 3");
ok("getLevelState は前の title を返さない（残骸を残さない）", !("title" in st(0)));
eq("前の称号の関数は無い（getTitle・getNextTitle・emblemTier・titleNames・EMBLEM_TIERS）", ["getTitle", "getNextTitle", "emblemTier", "titleNames", "EMBLEM_TIERS"].filter((k) => k in L), []);


// ---- 先読みする絵のランク（js/emblem.js preloadRanks。PR #178 のレビュー 2）: 幕に出る次のランクから。今のランクは読まない ----
const pre = (xp, reach = 0) => (typeof E.preloadRanks === "function" ? E.preloadRanks({ xp, reach }).map((r) => r.name) : null);
eq("先読み（Study）: 次のランクだけ（0 XP の木 1 → 木 2・Lv.4 の木 3 → 銅 1。今のランクは読まない）", [pre(0), pre(xpForLv(4))], [["木 2"], ["銅 1"]]);
eq("先読み（Challenge／Daily・1,000 XP 先まで）: 0 XP の木 1 → 木 2・木 3・銅 1（多くて 3 枚）・Lv.4 → 銅 1・銅 2", [pre(0, 1000), pre(xpForLv(4), 1000)], [["木 2", "木 3", "銅 1"], ["銅 1", "銅 2"]]);
eq("先読み: 届きうる先が多くても 3 枚まで（0 XP に 10,000 XP 先）・上の段では 1 枚（Lv.40 に 1,000 XP 先 → ダイヤ 3）・神 3 の先は無し", [pre(0, 10000)?.length, pre(xpForLv(40), 1000), pre(xpForLv(92), 1000)], [3, ["ダイヤ 3"], []]);

// ---- 絵の名前とファイル（段の並び・大きさ・上限は scripts/build-emblems.mjs と同じ値。PR #178 のレビュー 7） ----
eq("build-emblems.mjs の TIERS は js/level.js LEARNING_RANK_TIERS の英字の名前と同じ並び", B.TIERS, (L.LEARNING_RANK_TIERS ?? []).map((t) => t.id));
eq("build-emblems.mjs の STEPS は各段の番号（1〜3）と同じ", B.STEPS, [...new Set((L.LEARNING_RANKS ?? []).map((r) => r.step))]);
eq("build-emblems.mjs の SIZES は幕 224px と小さい絵 96px（-sm）", (B.SIZES ?? []).map((x) => [x.suffix, x.px]), [["", 224], ["-sm", 96]]);
eq("幕の絵の URL（銅 1 → copper-1.webp）", E.emblemSrc(rankOf(5)), "/assets/images/emblems/copper-1.webp");
eq("小さい絵の URL（神 3 → god-3-sm.webp）", E.emblemSrc(rankOf(92), { small: true }), "/assets/images/emblems/god-3-sm.webp");
eq("レジェンドの絵は legend-<n>（元の絵の名前の legend-rainbow ではない）", E.emblemSrc(rankOf(57)), "/assets/images/emblems/legend-2.webp");
eq("知らないランク・空は空の URL（絵を出さない）", [null, undefined, {}, { tier: "x", step: 1 }, { tier: "wood", step: 4 }, "木 1"].map((r) => E.emblemSrc(r)), ["", "", "", "", "", ""]);
const dir = path.join(ROOT, "assets/images/emblems");
// WebP の画素の大きさ（scripts/lib/canvas-art.mjs の webpSize。生成器・E2E と同じ読み方）
const { webpSize } = await import("./lib/canvas-art.mjs");
let total = 0;
for (const r of L.LEARNING_RANKS ?? []) for (const size of B.SIZES ?? []) {
  const small = size.suffix === "-sm";
  const name = path.basename(E.emblemSrc(r, { small }) || "-");
  const file = path.join(dir, name);
  const buf = fs.existsSync(file) ? fs.readFileSync(file) : null;
  total += buf?.length ?? 0;
  ok(`絵のファイル ${name} がある・${size.px}px・上限 ${size.maxBytes / 1024}KB 以下（build-emblems.mjs SIZES）`, !!buf && buf.length > 0 && buf.length <= size.maxBytes && webpSize(buf)?.join() === `${size.px},${size.px}`, buf ? `${buf.length} bytes ${webpSize(buf)}` : "無い");
}
ok(`21 段 × 2 種の合計が上限 ${(B.TOTAL_MAX_BYTES ?? 0) / 1024}KB 以下（build-emblems.mjs TOTAL_MAX_BYTES）`, total > 0 && total <= B.TOTAL_MAX_BYTES, `${total} bytes`);
const want = new Set((L.LEARNING_RANKS ?? []).flatMap((r) => (B.SIZES ?? []).map((size) => path.basename(E.emblemSrc(r, { small: size.suffix === "-sm" }) || "-"))));
eq("絵の置き場には 21 段 × 2 種だけ（前の 8 段の F.webp などは無い）", want.size === 42 ? fs.readdirSync(dir).filter((f) => !want.has(f)) : [`want ${want.size}`], []);
ok("縮めた元の置き場（scripts/emblems/）は無い", !fs.existsSync(path.join(ROOT, "scripts/emblems")));

if (failures.length) {
  console.log(`test-level: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-level: ${passed} passed`);
