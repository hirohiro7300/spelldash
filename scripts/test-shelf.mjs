// わたしの本棚の規則（js/shelfStore.js）の単体テスト。ブラウザなしで 1 秒で終わる:
//   node scripts/test-shelf.mjs
// 失敗が 1 つでもあれば終了コード 1。
// コースの表は js/course.js をそのまま読む（localStorage と window の殻だけ用意する）。語の id は data/ から読む:
// 語の統計は id でカテゴリをまたいで共有される（中学英語 1年の語の大半は他の本と同じ id）ので、手で作った id では反例を再現できない。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window ??= globalThis;
globalThis.window.addEventListener ??= () => {};
globalThis.window.dispatchEvent ??= () => true;

const { COURSES, DEFAULT_COURSE } = await import("../js/course.js");
const S = await import("../js/shelfStore.js");

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond, detail = "") => eq(`${name}${detail ? ` (${detail})` : ""}`, !!cond, true);
const sorted = (list) => [...list].sort();

// ---- 目録と語（data/manifest.json と各 JSON） ----
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data/manifest.json"), "utf8"));
const cats = manifest.subjects.find((s) => s.id === "english").categories;
const WORDS = {};
for (const c of cats) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", c.file), "utf8"));
  WORDS[c.id] = (Array.isArray(raw) ? raw : raw.words).filter((w) => !w.kanjiOnly).map((w) => w.id);
}
const BASE = new Set(cats.filter((c) => !c.pack).map((c) => c.id));
const FREQ = ["ngsl", "tsl", "bsl", "nawl"];
const freqCourseOf = (id) => FREQ.find((c) => COURSES[c].packs.includes(id)) ?? null;
const known = new Set([...cats.map((c) => `b:${c.id}`), "b:my", ...Object.keys(COURSES).map((c) => `c:${c}`)]);
const DEF1 = COURSES[DEFAULT_COURSE].packs[0];
const DEF2 = COURSES[DEFAULT_COURSE].packs[1];
const pick = (cat, n) => WORDS[cat].slice(0, n);

// 状態 → snap（js/bookshelf.js の snapNow と同じ形）
function snapOf({ course = "", desk = "all", packs = [], stats = [], my = 0, best = {} } = {}) {
  const statSet = new Set(stats);
  const loaded = (id) => (BASE.has(id) || packs.includes(id) ? WORDS[id] ?? [] : []);
  return {
    packs, course, desk, myCount: my, statsEmpty: statSet.size === 0, best,
    courses: COURSES, defaultCourse: DEFAULT_COURSE, freqCourseOf, isBase: (id) => BASE.has(id), known,
    hasRecords: (ids) => ids.some((id) => loaded(id).some((w) => statSet.has(w))),
    baseRecordCounts: () => [...BASE].map((id) => ({ id, n: (WORDS[id] ?? []).filter((w) => statSet.has(w)).length }))
  };
}
const fresh = (extra = {}) => ({ course: DEFAULT_COURSE, desk: DEF1, packs: [DEF1], stats: [], my: 0, ...extra });
const shelfOf = (books, courses, extra = {}) => ({ v: 1, books, courses, seen: [], prov: false, ...extra });
const bc = (sh) => ({ books: sorted(sh.books), courses: sorted(sh.courses) });

ok("前提: 既定のコースの 1・2 巻は中学英語 1年・2年", DEF1 === "jhs-english1" && DEF2 === "jhs-english2");
ok("前提: 中学英語 1年の語の多くが他の本と同じ id（記録で本を見分けられない）", WORDS[DEF1].filter((w) => Object.entries(WORDS).some(([c, ws]) => c !== DEF1 && ws.includes(w))).length >= 100);

// 1. parseShelf
{
  const good = JSON.stringify({ v: 1, books: ["jhist1"], courses: ["jhs-redo"], seen: ["jhs-english1"], prov: false });
  eq("1 parseShelf 正しい形", S.parseShelf(good), { v: 1, books: ["jhist1"], courses: ["jhs-redo"], seen: ["jhs-english1"], prov: false });
  eq("1 parseShelf 「{」は null", S.parseShelf("{"), null);
  eq("1 parseShelf v 2 は null", S.parseShelf(JSON.stringify({ v: 2, books: [], courses: [], seen: [] })), null);
  eq("1 parseShelf books が文字列なら null", S.parseShelf(JSON.stringify({ v: 1, books: "jhist1", courses: [], seen: [] })), null);
  eq("1 parseShelf prov が文字列なら null", S.parseShelf(JSON.stringify({ v: 1, books: [], courses: [], seen: [], prov: "yes" })), null);
  eq("1 parseShelf 古い desk・course の欄は読み飛ばす", S.parseShelf(JSON.stringify({ v: 1, books: ["a"], courses: [], seen: [], desk: "x", course: "y" })), { v: 1, books: ["a"], courses: [], seen: [], prov: false });
  eq("1 parseShelf 配列の文字列でない要素は捨てる", S.parseShelf(JSON.stringify({ v: 1, books: ["a", 3, null], courses: [], seen: [] }))?.books, ["a"]);
  eq("1 parseShelf 空・null は null", [S.parseShelf(""), S.parseShelf(null)], [null, null]);
}

// 2. effectiveCourse
eq("2 effectiveCourse コースの巻が机 → そのコース", S.effectiveCourse(snapOf({ course: "eiken", desk: "eiken3" })), "eiken");
eq("2 effectiveCourse 机が別の本 → 空", S.effectiveCourse(snapOf({ course: "jhs-redo", desk: "jhist1" })), "");
eq("2 effectiveCourse コースなし → 空", S.effectiveCourse(snapOf({ course: "", desk: "jhist1" })), "");

// 3. isDefaultState・isDefaultMark
ok("3 既定のまま: 記録が空・packs [中学英語 1年]", S.isDefaultState(snapOf(fresh())));
ok("3 既定のまま: packs []", S.isDefaultState(snapOf({ packs: [] })));
ok("3 記録があれば既定のままでない", !S.isDefaultState(snapOf(fresh({ stats: pick(DEF1, 3) }))));
ok("3 パックが増えれば既定のままでない", !S.isDefaultState(snapOf(fresh({ packs: [DEF1, "jhist1"] }))));
ok("3 既定の印: 中学英語 2年が無ければ中学英語 1年は既定の印", S.isDefaultMark(DEF1, snapOf({ packs: [DEF1] })));
ok("3 既定の印: 中学英語 2年があれば違う", !S.isDefaultMark(DEF1, snapOf({ packs: [DEF1, DEF2] })));

// 4. 移行: 既定のまま（仮の棚）
{
  const a = S.migrateShelf(snapOf(fresh()));
  eq("4 移行 既定のまま → books・courses とも空・prov true", { ...bc(a), prov: a.prov, seen: a.seen }, { books: [], courses: [], prov: true, seen: [DEF1] });
  const b = S.migrateShelf(snapOf(fresh({ my: 2 })));
  eq("4 移行 既定のまま＋マイ単語帳 2 語 → books [my]・prov true（M0 も M4〜M6 は通す）", { ...bc(b), prov: b.prov, seen: sorted(b.seen) }, { books: ["my"], courses: [], prov: true, seen: sorted([DEF1, "my"]) });
}

// 5. 移行 shelfSeed
{
  const a = S.migrateShelf(snapOf(fresh({ stats: pick(DEF1, 30) })));
  eq("5 移行 shelfSeed → courses [jhs-redo]・books []・prov false", { ...bc(a), prov: a.prov }, { books: [], courses: ["jhs-redo"], prov: false });
}

// 6. 移行 旧版の歴史の人
{
  const s = { course: DEFAULT_COURSE, desk: "jhist1", packs: [DEF1, "jhist1"], stats: pick("jhist1", 10) };
  eq("6 移行 旧版の welcome で歴史 → courses []・books [jhist1]", bc(S.migrateShelf(snapOf(s))), { books: ["jhist1"], courses: [] });
  eq("6 英検5級の記録 20 語を足しても同じ（記録で既定のコースを見分けない）", bc(S.migrateShelf(snapOf({ ...s, stats: [...pick("jhist1", 10), ...pick("eiken5", 20)] }))), { books: ["jhist1"], courses: [] });
}

// 7. 移行 いろいろ使った人
eq("7 移行 いろいろ使った人 → courses [jhs-redo, ngsl]・books [jhist1, eiken3, toeic, my]",
  bc(S.migrateShelf(snapOf({ course: DEFAULT_COURSE, desk: DEF1, packs: [DEF1, DEF2, "jhist1", "eiken3", "ngsl02"], stats: pick(DEF1, 30), my: 1, best: { toeic: 30, all: 50 } }))),
  { books: sorted(["jhist1", "eiken3", "toeic", "my"]), courses: sorted(["jhs-redo", "ngsl"]) });

// 8. 移行 コースを乗り換えた人
eq("8 移行 コースを乗り換えた人 → courses [eiken]・books [jhs-english1, jhs-english2]",
  bc(S.migrateShelf(snapOf({ course: "eiken", desk: "eiken5", packs: [DEF1, DEF2, "eiken5"], stats: pick(DEF1, 30) }))), { books: sorted([DEF1, DEF2]), courses: ["eiken"] });

// 9. S2・S3
eq("9 移行 S2（旧版の初回で函 TOEIC）→ courses [toeic]・books []", bc(S.migrateShelf(snapOf({ course: "toeic", desk: "toeic500", packs: [DEF1, "toeic500"], stats: pick("toeic500", 30) }))), { books: [], courses: ["toeic"] });
{
  const ng = ["ngsl01", "ngsl02", "ngsl03", "ngsl04", "ngsl05"];
  eq("9 移行 S3（NGSL）→ courses [ngsl]・books []（中学英語 1年は既定の印）", bc(S.migrateShelf(snapOf({ course: "ngsl", desk: "ngsl05", packs: [DEF1, ...ng], stats: ng.flatMap((p) => WORDS[p]) }))), { books: [], courses: ["ngsl"] });
}

// 10. 失う側
eq("10 移行 中学英語 1年だけ学んで英検へ → courses [eiken]・books []", bc(S.migrateShelf(snapOf({ course: "eiken", desk: "eiken5", packs: [DEF1, "eiken5"], stats: pick(DEF1, 60) }))), { books: [], courses: ["eiken"] });

// 11. best
eq("11 移行 best の all・my・パックは入らない", bc(S.migrateShelf(snapOf({ course: "", desk: "all", packs: ["jhist1"], stats: pick("jhist1", 3), best: { all: 40, my: 10, jhist1: 9, eiken3: 5 } }))), { books: ["jhist1"], courses: [] });
eq("11 移行 best の基本カテゴリが保存した函の巻なら入らない（business は社会人ビジネス英語の巻）",
  bc(S.migrateShelf(snapOf({ course: "biz", desk: "business", packs: [], stats: pick("business", 5), best: { business: 12, travel: 3 } }))), { books: ["travel"], courses: ["biz"] });
eq("11 移行 M1-② 既定のコース以外の前のコースは記録で（効いていない eiken に英検5級の記録 → 函 eiken）",
  bc(S.migrateShelf(snapOf({ course: "eiken", desk: "jhist1", packs: ["eiken5", "jhist1"], stats: pick("eiken5", 5) }))), { books: sorted(["eiken5", "jhist1"]).filter((x) => x !== "eiken5"), courses: ["eiken"] });

// 11b. 既定のコースのまま、移行した時に机がチップ・すべて・マイ単語帳だった人（REVIEW-logic M1）: いまのコースの函を落とさない
{
  const s = { course: DEFAULT_COURSE, packs: [DEF1], stats: pick(DEF1, 60) };
  eq("11b 移行 既定のコース・机はチップ TOEIC → 函 jhs-redo（机の TOEIC も）", bc(S.migrateShelf(snapOf({ ...s, desk: "toeic" }))), { books: ["toeic"], courses: ["jhs-redo"] });
  eq("11b 移行 既定のコース・机は「すべて」→ 函 jhs-redo", bc(S.migrateShelf(snapOf({ ...s, desk: "all" }))), { books: [], courses: ["jhs-redo"] });
  eq("11b 移行 既定のコース・机はマイ単語帳 → 函 jhs-redo＋マイ単語帳", bc(S.migrateShelf(snapOf({ ...s, desk: "my", my: 3 }))), { books: ["my"], courses: ["jhs-redo"] });
  eq("11b 移行 机が分野パック（旧版の初回の歴史）は今のまま函なし", bc(S.migrateShelf(snapOf({ ...s, desk: "jhist1", packs: [DEF1, "jhist1"] }))), { books: ["jhist1"], courses: [] });
  eq("11b 移行 机「すべて」で記録は会計だけ（1 巻目の語に記録なし）→ 函なし", bc(S.migrateShelf(snapOf({ course: DEFAULT_COURSE, desk: "all", packs: [DEF1, "accounting"], stats: pick("accounting", 20) }))), { books: ["accounting"], courses: [] });
}

// 11c. 記録だけで学んできた人（コースなし・印なし・机は「すべて」。REVIEW-logic S1）: 記録の多い基本カテゴリが入り、棚は空にならない
{
  const junior = pick("junior", 120);
  const a = S.migrateShelf(snapOf({ course: "", desk: "all", packs: [], stats: junior }));
  ok("11c 移行 机「すべて」・中学英語 基本だけ学んだ → books に junior", a.books.includes("junior") && a.courses.length === 0, JSON.stringify(a.books));
  const counts = snapOf({ stats: junior }).baseRecordCounts().filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
  ok("11c 移行 2 冊目は 1 冊目の半分以上の記録があるときだけ", a.books.length === 1 + (counts[1] && counts[1].n * 2 >= counts[0].n ? 1 : 0), JSON.stringify(counts.slice(0, 3)));
  eq("11c 移行 机が「すべて」でない（高校英語）なら足さない（SPEC §14-11 の範囲）", S.migrateShelf(snapOf({ course: "", desk: "highschool", packs: [], stats: junior })).books, ["highschool"]);
  eq("11c 移行 机「すべて」で記録が無い本は足さない（best だけ）", S.migrateShelf(snapOf({ course: "", desk: "all", packs: ["jhist1"], stats: pick("jhist1", 3) })).books, ["jhist1"]);
}

// 12. shelfAtStart
{
  const cases = [
    ["そのまま", fresh(), { books: [], courses: ["jhs-redo"] }],
    ["歴史", { course: DEFAULT_COURSE, desk: "jhist1", packs: [DEF1, "jhist1"] }, { books: ["jhist1"], courses: [] }],
    ["函 TOEIC", { course: "toeic", desk: "toeic500", packs: [DEF1, "toeic500"] }, { books: [], courses: ["toeic"] }],
    ["S6（紹介頁から会計を足して来た・机は all）", { course: "", desk: "all", packs: ["accounting"] }, { books: ["accounting"], courses: [] }]
  ];
  for (const [name, s, want] of cases) {
    const sh = S.shelfAtStart(snapOf(s));
    eq(`12 shelfAtStart ${name}`, { ...bc(sh), prov: sh.prov }, { ...want, prov: false });
  }
}

// 13. applyStartChoice（main.js onStart の写し）と下見
{
  const before = (packs = [DEF1], course = DEFAULT_COURSE, desk = DEF1) => snapOf({ course, desk, packs });
  const preview = (snap, choice) => bc(S.shelfAtStart(S.applyStartChoice(snap, choice)));
  eq("13 下見: そのまま（中学英語 1年）", preview(before(), { bookId: DEF1 }), { books: [], courses: ["jhs-redo"] });
  eq("13 下見: 積んだ本の中学歴史", preview(before(), { bookId: "jhist1" }), { books: ["jhist1"], courses: [] });
  eq("13 下見: 函 TOEIC（最初の巻）", preview(before(), { bookId: "toeic500", courseId: "toeic" }), { books: [], courses: ["toeic"] });
  eq("13 下見: S6（packs [accounting]・机 all）", preview(before(["accounting"], "", "all"), { bookId: DEF1 }), { books: ["accounting"], courses: [] });
  const after = S.applyStartChoice(before(), { bookId: "toeic500", courseId: "toeic" });
  eq("13 applyStartChoice 函 TOEIC: コース toeic・机 toeic500・packs に toeic500", { course: after.course, desk: after.desk, packs: after.packs }, { course: "toeic", desk: "toeic500", packs: [DEF1, "toeic500"] });
  const base = S.applyStartChoice(before(), { bookId: "travel" });
  eq("13 applyStartChoice 基本カテゴリ（旅行）は packs に足さない", { desk: base.desk, packs: base.packs }, { desk: "travel", packs: [DEF1] });
  const keep = S.applyStartChoice(before(["accounting"], "", "all"), { bookId: DEF1 });
  eq("13 applyStartChoice 中学英語 1年は何も替えない", { desk: keep.desk, packs: keep.packs, course: keep.course }, { desk: "all", packs: ["accounting"], course: "" });
}

// 14. 照合 段 1（仮の棚）
{
  const prov = S.migrateShelf(snapOf(fresh()));
  const r0 = S.reconcileShelf(prov, snapOf(fresh()));
  eq("14 照合 仮の棚: 既定のままの間はそのまま", { changed: r0.changed, prov: r0.shelf.prov }, { changed: false, prov: true });
  const r1 = S.reconcileShelf(prov, snapOf(fresh({ stats: pick(DEF1, 10) })));
  eq("14 照合 仮の棚: 記録が届く → 移行し直して prov false", { ...bc(r1.shelf), prov: r1.shelf.prov, changed: r1.changed }, { books: [], courses: ["jhs-redo"], prov: false, changed: true });
  let sh = prov;
  for (const d of ["toeic", "it", "ads", DEF1]) sh = S.reconcileShelf(sh, snapOf(fresh({ desk: d }))).shelf;
  eq("14 照合 仮の棚: 机・コースだけ替わる（チップ）→ 移行し直さない（S4'）", { ...bc(sh), prov: sh.prov }, { books: [], courses: [], prov: true });
}

// 15. 照合 P3
{
  const s0 = { course: DEFAULT_COURSE, desk: DEF1, packs: [DEF1], stats: pick(DEF1, 30) };
  const sh = S.migrateShelf(snapOf(s0));
  eq("15 P3 新しいパック（コース外）→ books", bc(S.reconcileShelf(sh, snapOf({ ...s0, packs: [DEF1, "realestate"] })).shelf), { books: ["realestate"], courses: ["jhs-redo"] });
  eq("15 P3 効いているコースの巻 → 函（背は増えない）", bc(S.reconcileShelf(sh, snapOf({ ...s0, desk: DEF2, packs: [DEF1, DEF2] })).shelf), { books: [], courses: ["jhs-redo"] });
  eq("15 P3 頻度順の巻 → 全集の函", bc(S.reconcileShelf(sh, snapOf({ ...s0, packs: [DEF1, "ngsl03"] })).shelf), { books: [], courses: sorted(["jhs-redo", "ngsl"]) });
  eq("15 P3 books にある物 → そのまま", bc(S.reconcileShelf({ ...sh, books: ["jhist1"] }, snapOf({ ...s0, packs: [DEF1, "jhist1"] })).shelf), { books: ["jhist1"], courses: ["jhs-redo"] });
  eq("15 P3 語が出たマイ単語帳 → books", bc(S.reconcileShelf(sh, snapOf({ ...s0, my: 1 })).shelf), { books: ["my"], courses: ["jhs-redo"] });
  const other = { course: "eiken", desk: "eiken3", packs: ["eiken5", "eiken3"], stats: pick("eiken5", 10) };
  const sh2 = S.migrateShelf(snapOf(other));
  eq("15 P3 既定の印の中学英語 1年が届く → 何もしない（R14）", bc(S.reconcileShelf(sh2, snapOf({ ...other, packs: ["eiken5", "eiken3", DEF1] })).shelf), { books: [], courses: ["eiken"] });
}

// 16. 照合 段 0・3（外したパック・"my" は外れない）
{
  const s0 = { course: DEFAULT_COURSE, desk: DEF1, packs: [DEF1, "jhist1"], stats: pick(DEF1, 30), my: 3 };
  const sh = S.migrateShelf(snapOf(s0));
  eq("16 移行 [jhist1, my]", sorted(sh.books), sorted(["jhist1", "my"]));
  const r1 = S.reconcileShelf(sh, snapOf({ ...s0, packs: [DEF1] })).shelf;
  eq("16 外したパック → books から消える（my は残る）", sorted(r1.books), ["my"]);
  const r2 = S.reconcileShelf(r1, snapOf({ ...s0, packs: [DEF1] })).shelf;
  const r3 = S.reconcileShelf(r2, snapOf({ ...s0, packs: [DEF1], my: 0 })).shelf;
  const r4 = S.reconcileShelf(r3, snapOf({ ...s0, packs: [DEF1], my: 2 })).shelf;
  eq("16 S5 マイ単語帳: 次の照合 [my] → 語が 0 [my] → また 2 語 [my]", [r2.books, r3.books, r4.books], [["my"], ["my"], ["my"]]);
  const dropped = S.reconcileShelf(S.dropKey(r4, "b:my"), snapOf({ ...s0, packs: [DEF1], my: 2 })).shelf;
  eq("16 下ろしたマイ単語帳は照合で戻らない（seen の my は消えない）", dropped.books, []);
}

// 17. チップを見て回っても何も足さない（S4）
{
  let s = { course: DEFAULT_COURSE, desk: DEF1, packs: [DEF1], stats: pick(DEF1, 30) };
  let sh = S.migrateShelf(snapOf(s));
  for (const d of ["toeic", "it", "ads", DEF1]) {
    s = { ...s, desk: d };
    sh = S.reconcileShelf(sh, snapOf(s)).shelf;
  }
  eq("17 S4 チップ TOEIC → IT → 広告 → 中学英語 1年で books・courses とも不変", bc(sh), { books: [], courses: ["jhs-redo"] });
}

// 18. noteStudyStart
{
  const sh = shelfOf([], []);
  eq("18 noteStudyStart 机が効いているコースの巻 → 函", bc(S.noteStudyStart(sh, snapOf({ course: "eiken", desk: "eiken3", packs: ["eiken3"], stats: ["x"] })).shelf), { books: [], courses: ["eiken"] });
  eq("18 noteStudyStart 頻度順の巻（コース外）→ 全集の函", bc(S.noteStudyStart(sh, snapOf({ course: "", desk: "ngsl05", packs: ["ngsl05"], stats: ["x"] })).shelf), { books: [], courses: ["ngsl"] });
  eq("18 noteStudyStart 基本カテゴリ → books", bc(S.noteStudyStart(sh, snapOf({ course: DEFAULT_COURSE, desk: "toeic", packs: [DEF1], stats: ["x"] })).shelf), { books: ["toeic"], courses: [] });
  eq("18 noteStudyStart パック → books", bc(S.noteStudyStart(sh, snapOf({ course: "", desk: "jhist1", packs: ["jhist1"], stats: ["x"] })).shelf), { books: ["jhist1"], courses: [] });
  const none = S.noteStudyStart(sh, snapOf({ course: "", desk: "all", packs: [], stats: ["x"] }));
  eq("18 noteStudyStart all → 何もしない", { ...bc(none.shelf), changed: none.changed }, { books: [], courses: [], changed: false });
  const prov = S.migrateShelf(snapOf(fresh()));
  const re = S.noteStudyStart(prov, snapOf({ course: "", desk: "jhist1", packs: [DEF1, "eiken5", "jhist1"], stats: pick("eiken5", 3) })).shelf;
  eq("18 noteStudyStart 仮の棚で既定のままでない → 先に移行し直す", { ...bc(re), prov: re.prov }, { books: sorted(["eiken5", "jhist1"]), courses: [], prov: false });
  let s = { course: DEFAULT_COURSE, desk: DEF1, packs: [DEF1], stats: pick(DEF1, 30) };
  let sh4 = S.migrateShelf(snapOf(s));
  s = { ...s, desk: "toeic" };
  sh4 = S.noteStudyStart(S.reconcileShelf(sh4, snapOf(s)).shelf, snapOf(s)).shelf;
  s = { ...s, desk: DEF1 };
  sh4 = S.reconcileShelf(sh4, snapOf(s)).shelf;
  eq("18 S4 の続き: TOEIC で 1 セット始めて机を戻す → books [toeic]", bc(sh4), { books: ["toeic"], courses: ["jhs-redo"] });
}

// 19. 2 台目: 移行が同期の前でも後でも保存した棚が同じ
{
  const both = (name, synced) => {
    const a = S.reconcileShelf(S.migrateShelf(snapOf(fresh())), snapOf(synced)).shelf;
    const b = S.reconcileShelf(S.migrateShelf(snapOf(synced)), snapOf(synced)).shelf;
    eq(`19 2 台目 ${name}: 同期の前に移行しても後に移行しても同じ`, bc(a), bc(b));
    return bc(b);
  };
  eq("19 S1 の棚", both("S1（机 jhist1・英検5級 20 語）", { course: "", desk: "jhist1", packs: [DEF1, "eiken5", "jhist1"], stats: [...pick("eiken5", 20), ...pick("jhist1", 5)] }), { books: sorted(["eiken5", "jhist1"]), courses: [] });
  eq("19 S7 の棚", both("S7（机 eiken3）", { course: "eiken", desk: "eiken3", packs: [DEF1, "eiken5", "eiken4", "eiken3"], stats: pick("eiken5", 20) }), { books: [], courses: ["eiken"] });
  eq("19 S8 の棚", both("S8（机 中学英語 1年・記録あり）", { course: DEFAULT_COURSE, desk: DEF1, packs: [DEF1, "jhist1"], stats: pick(DEF1, 30) }), { books: ["jhist1"], courses: ["jhs-redo"] });
  eq("19 S9 の棚", both("S9（机 toeic・パックでない）", { course: "", desk: "toeic", packs: [DEF1], stats: pick("toeic", 10) }), { books: ["toeic"], courses: [] });
}

// 20. 照合を 2 回続けると 2 回目は changed: false
{
  const s = { course: DEFAULT_COURSE, desk: DEF1, packs: [DEF1, "realestate"], stats: pick(DEF1, 30), my: 1 };
  const once = S.reconcileShelf(S.migrateShelf(snapOf({ ...s, packs: [DEF1], my: 0 })), snapOf(s));
  const twice = S.reconcileShelf(once.shelf, snapOf(s));
  eq("20 照合 1 回目は changed、2 回目は changed: false", [once.changed, twice.changed], [true, false]);
}

// 21. displayItems
{
  const order = [
    ...["jhs-redo", "biz", "conversation", "hs", "eiken", "toeic", "ngsl", "tsl", "bsl", "nawl"].map((c) => ({ key: `c:${c}`, group: "course" })),
    ...[DEF1, DEF2, "my"].map((id) => ({ key: `b:${id}`, group: "eng" })),
    ...["eiken3", "toeic"].map((id) => ({ key: `b:${id}`, group: "exam" })),
    ...["ngsl05"].map((id) => ({ key: `b:${id}`, group: "freq" })),
    ...["jhist1", "pref"].map((id) => ({ key: `b:${id}`, group: "social" }))
  ];
  const view = (sh, s) => S.displayItems(sh, snapOf(s), order).map((x) => `${x.kind}:${x.id}${x.current ? "*" : ""}${x.droppable ? "" : "!"}/${x.group}`);
  eq("21 displayItems 函の順・空きは函の直後・本は目録の順・群・droppable",
    view(shelfOf(["jhist1", "eiken3", "my", "zzz-unknown"], ["eiken", "jhs-redo"]), { course: DEFAULT_COURSE, desk: DEF1, packs: [DEF1] }),
    ["box:jhs-redo*!/course", `slot:${DEF1}!/course`, "box:eiken/course", "book:my/eng", "book:eiken3/exam", "book:jhist1/social"]);
  eq("21 displayItems 机がコース外の本 → 目録の位置に空き、函は印なし",
    view(shelfOf(["eiken3"], ["jhs-redo"]), { course: DEFAULT_COURSE, desk: "pref", packs: [DEF1, "pref"] }),
    ["box:jhs-redo/course", "book:eiken3/exam", "slot:pref!/social"]);
  eq("21 displayItems 保存した本が机に出ていると空き（背は出さない）", view(shelfOf(["jhist1"], []), { course: "", desk: "jhist1", packs: ["jhist1"] }), ["slot:jhist1!/social"]);
  eq("21 displayItems 机が all なら空きは無い", view(shelfOf([], []), { course: "", desk: "all", packs: [] }), []);
}

// 22. packRows
{
  const r1 = S.packRows(Array(7).fill({ w: 46, group: "a" }), 334);
  eq("22 packRows [46×7]・内側 334 → 1 段で本立ては出ない", { rows: r1.rows.length, end: r1.end, used: r1.rows[0].used }, { rows: 1, end: false, used: 334 });
  const r2 = S.packRows(Array(8).fill({ w: 46, group: "a" }), 334);
  eq("22 packRows [46×8] → 2 段、本立ては 2 段目", { rows: r2.rows.map((r) => r.items.length), end: r2.end }, { rows: [7, 1], end: true });
  const r3 = S.packRows([{ w: 68, group: "course" }, { w: 40, group: "course" }], 264, { hint: true });
  eq("22 packRows 320 の函＋空き＋一文 → 1 段で本立てと一文も 1 段目（残り 120 ≥ 98）", { rows: r3.rows.length, total: r3.total, end: r3.end, hint: r3.hint }, { rows: 1, total: 1, end: true, hint: { row: 0, left: 146, width: 118, center: false } });
  const r4 = S.packRows([{ w: 165 - 34, group: "a" }], 264, { hint: true }); // 使った 131＋本立て 34 = 165、残り 99 ≥ 98
  const r5 = S.packRows([{ w: 166 - 34 + 1, group: "a" }], 264, { hint: true }); // 残り 97
  eq("22 packRows 残り 98 なら一文が入り、97 なら出ない（段は増えない）", [!!r4.hint, r5.hint, r5.total], [true, null, 1]);
  const r6 = S.packRows([{ w: 44, group: "a" }], 396, { hint: true, minRows: 3 });
  eq("22 packRows 最低 3 段 → 空の段 2、一文は 2 段目の中央", { total: r6.total, rows: r6.rows.length, hint: r6.hint }, { total: 3, rows: 1, hint: { row: 1, left: 0, width: 396, center: true } });
  const r7 = S.packRows([], 334, { hint: true });
  eq("22 packRows 0 個 → 1 段で一文は中央・本立ては無い", { total: r7.total, end: r7.end, hint: r7.hint }, { total: 1, end: false, hint: { row: 0, left: 0, width: 334, center: true } });
  const r8 = S.packRows([{ w: 44, group: "a" }, { w: 44, group: "a" }, { w: 44, group: "b" }, { w: 200, group: "b" }], 300);
  eq("22 packRows 群の境目は 10・段の頭は 0", r8.rows.map((r) => r.items.map((x) => x.gap)), [[0, 2, 10], [0]]);
}

// 23. serializeShelf
{
  const raw = S.serializeShelf({ v: 1, books: ["zzz-new-pack", "jhist1", "jhist1"], courses: ["eiken"], seen: ["zzz-new-pack"], prov: false });
  eq("23 serializeShelf 目録に無い id も残す（重なりは 1 つ）", S.parseShelf(raw), { v: 1, books: ["zzz-new-pack", "jhist1"], courses: ["eiken"], seen: ["zzz-new-pack"], prov: false });
}

// addKey・dropKey
{
  const sh = S.addKey(shelfOf([], [], { prov: true }), "c:eiken");
  eq("addKey 函を足すと prov false", { courses: sh.courses, prov: sh.prov }, { courses: ["eiken"], prov: false });
  eq("dropKey 本を下ろす", S.dropKey(shelfOf(["a", "b"], ["eiken"]), "b:a").books, ["b"]);
  eq("dropKey 函を下ろす", S.dropKey(shelfOf(["a"], ["eiken", "toeic"]), "c:eiken").courses, ["toeic"]);
  ok("deskKey 目録に無い机は null", S.deskKey(snapOf({ desk: "zzz-none" })) === null);
}

if (failures.length) {
  console.error(`test-shelf: ${failures.length} failed, ${passed} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`test-shelf: ${passed} passed`);
