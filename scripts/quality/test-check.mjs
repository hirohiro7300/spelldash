// scripts/quality/check.mjs の比べ方の検査（CI）。教材のファイルは書き換えず、読んだ JSON を ctx.mjs の patch で変えて流す。
//   node scripts/quality/test-check.mjs
// 確かめること:
//   1. 今の教材は基準線どおり（Q03・Q04・P1）
//   2. 1 枚の accept に重複を足すと Q03 が落ち、落ちたカードがその 1 枚（PR で accept の重複を入れた形）
//   3. 英単語の accept に出題語の大文字の形を足すと Q03 が落ちる
//   4. 動詞のカードの訳を名詞だけにすると P1 が落ちる（「建物＝build」の型。今は 0 枚）
//   5. 基準線のカードを直した（漢字の別表記を外した）のに基準線を下げないと Q04 が「基準線が古い」で落ち、--update と同じ書き直しで通る
//   6. 警告の規則は増えても落ちない。基準線に無い誤りの規則に当たりがあれば落ちる。規則の無い基準線の行は落ちる
//   7. 基準線にもうあるカードに読みの無い漢字の別表記を足すと、基準線だけでは落ちない（カードの一覧なので）が、前の木と比べる（--base）と
//      Q04 の「変わったカードに新しい当たり」で落ちる
//   8. 同じく、読みが別のカードにある漢字の別解（還元）を足すと --base で Q05 が落ちる
//   9. 基準線にあるカードの説明だけ変える・別表記を 1 つ外すだけなら --base でも落ちない（変わったカードには数える）。前の木と同じなら変わったカード 0
//  10. 基準線は上げない（PR #175 のレビュー）: PR で jsci1:concept-js1-mg の accept に重複を足すと Q03 が落ち、素の --update は新しい当たりを
//      基準線に足さない（下げるだけ）。--update --add=Q03 なら足すが、CI の形（--base の木の基準線＝向け先の基準線と比べる）では
//      「基準線を上げた」で落ちる。向け先の基準線に無い規則（PR で足した規則）と、向け先の教材でも今のコードで当たるカード
//      （規則・判定器を変えて見つかった、前からある当たり）は落とさない。警告の規則は素の --update で今の当たりに合わせる
//  11. 10 と同じことを check.mjs のコマンド（--update・--update --add・--base）で、教材を変えた木の写しに流す
//  12. 規則は ctx の木（--root）の js/judge.js で判定する（Q05。規則のファイルの場所の js/ を読まない）
//  13. loadContext を 2 つ同時に呼んでも木が混ざらず、global の fetch は元に戻る
//  14. 別表記の読み（acceptReadings。Batch 71・docs/PACK_FORMAT.md「別表記の読み」）: 結ぶと Q04 が消え、結び方の誤り（読みが accept に無い・
//      読みの形でない・別表記の形に合わない・空）は当たる。結んでいない別表記は当たりのまま、一部だけ結ぶと中身が減り --base でも落ちない、
//      基準線のカードを誤って結ぶと --base で落ちる。「の」の型は今のまま
//  15. Q04w（警告）の 5 つの手がかり（短い形・他のカード・同じ読み・別表記の無い短い読み・同じ別表記の別の読み）。今の教材は 0
//  16. 別表記の形の見張り（scripts/quality/readingShape.mjs）の表
//  17. sim-judge は結んだ読みを kanjiAccept の bound の行で打つ。accept に無い読みを結ぶと Q05 が当たる
//  18. 反証の手がかり（scripts/quality/review-readings.mjs）は、データの漢字の読みで裏付けの無い組を出す
//  19. validate-words: acceptReadings の形の検査と、学校・基本の読みでない別表記をすべて結ぶこと（既定）。教材の写し（--root）で流す
//  20. add-readings の alts・drop・--root: 4 通りのファイルの体裁で書き、2 度目は 0 枚。accept に無い別表記は NG でファイルを書かない。
//      結んだ別表記を外すと、記録とその別表記だけに結んだ読みも消える
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadContext, ROOT } from "./ctx.mjs";
import { loadRules, runRules, compareWithBaseline, compareWithBase, compareWithTargetBaseline, updateBaseline, readBaseline } from "./check.mjs";

let passed = 0;
let failed = 0;
const check = (name, ok, info = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && info ? `\n    ${info}` : ""}`);
};

const rules = await loadRules();
const pick = (...ids) => rules.filter((r) => ids.includes(r.id));
const baseline = readBaseline();
const wordOf = (files, cat, id) => files.get(cat).words.find((w) => w.id === id);

async function run(ids, patch, base = baseline) {
  const ctx = await loadContext({ patch });
  const results = await runRules(ctx, pick(...ids));
  return { ctx, results, ...compareWithBaseline(results, base, { partial: true }) };
}

// 前の木（今の教材のまま）と PR の木（patch した教材）で比べる（check.mjs --base と同じ）
const baseCtx = await loadContext();
async function runVsBase(ids, patch) {
  const ctx = await loadContext({ patch });
  const rs = pick(...ids);
  const results = await runRules(ctx, rs);
  const vs = await compareWithBase(ctx, results, baseCtx, rs, baseline);
  return { vs, only: compareWithBaseline(results, baseline, { partial: true }), ...compareWithBaseline(results, baseline, { partial: true, changed: vs.byRule }) };
}

// 1
{
  const { failures } = await run(["Q03", "Q04", "P1"]);
  check("今の教材は基準線どおり（Q03・Q04・P1）", failures.length === 0, failures.join(" / "));
}

// 2
{
  const ref = "jsci1:concept-js1-cu";
  const { rows, failures } = await run(["Q03"], (files) => {
    const w = wordOf(files, "jsci1", "concept-js1-cu");
    w.accept = [...w.accept, "銅"]; // 「銅」がもう 1 つ
  });
  const q03 = rows.find((r) => r.id === "Q03");
  check("accept に同じ語を足すと Q03 が落ちる", failures.some((f) => f.startsWith("Q03: 新しい当たり 1 枚")), failures.join(" / "));
  check("落ちたカードは足した 1 枚だけ", q03.added.length === 1 && q03.added[0] === ref, JSON.stringify(q03.added));
}

// 3
{
  const { rows } = await run(["Q03"], (files) => {
    const w = files.get("junior").words.find((x) => x.en === "apple");
    w.accept = [...(w.accept ?? []), "Apple"];
  });
  const q03 = rows.find((r) => r.id === "Q03");
  check("英単語の accept に出題語の大文字の形を足すと Q03 に当たる", q03.added.length === 1 && q03.added[0] === "junior:english-apple", JSON.stringify(q03.added));
}

// 4
{
  const { rows, failures } = await run(["P1"], (files) => {
    const w = files.get("eiken4").words.find((x) => x.en === "build");
    w.ja = "建物";
  });
  const p1 = rows.find((r) => r.id === "P1");
  check("動詞 build の訳を「建物」にすると P1 が落ちる", p1.added.includes("eiken4:english-build") && failures.some((f) => f.startsWith("P1:")), failures.join(" / "));
}

// 5
{
  const target = baseline.Q04.find((ref) => ref.startsWith("accounting:"));
  const [cat, id] = target.split(":");
  const patch = (files) => {
    const w = wordOf(files, cat, id);
    w.accept = w.accept.filter((a) => !/[㐀-鿿々〆]/.test(a)); // 漢字の別表記を外す（読みは残る）
  };
  const first = await run(["Q04"], patch);
  const q04 = first.rows.find((r) => r.id === "Q04");
  check("基準線のカードを直して基準線を下げないと Q04 は「基準線が古い」で落ちる", q04.removed.length === 1 && q04.removed[0] === target && first.failures.some((f) => f.includes("基準線が古い")), first.failures.join(" / "));
  const lowered = updateBaseline(first.results, baseline, { only: new Set(["Q04"]) });
  const second = await run(["Q04"], patch, lowered);
  check("基準線を下げると通る（ほかの規則の基準線は変わらない）", second.failures.length === 0 && lowered.Q04.length === baseline.Q04.length - 1 && lowered.Q03 === baseline.Q03, second.failures.join(" / "));
}

// 6
{
  const ctx = await loadContext();
  const fake = [
    { id: "W1", level: "warn", describe: "警告", run: (c) => c.cards.slice(0, 3).map((w) => ({ card: w.ref })) },
    { id: "E1", level: "error", describe: "誤り", run: (c) => c.cards.slice(0, 1).map((w) => ({ card: w.ref })) }
  ];
  const results = await runRules(ctx, fake);
  const { failures } = compareWithBaseline(results, { W1: [], Q99: [] });
  check("警告の規則は増えても落ちない", !failures.some((f) => f.startsWith("W1")), failures.join(" / "));
  check("基準線に無い誤りの規則に当たりがあれば落ちる", failures.some((f) => f.startsWith("E1: 新しい当たり 1 枚")), failures.join(" / "));
  check("規則の無い基準線の行は落ちる", failures.some((f) => f.startsWith("Q99:")), failures.join(" / "));
}

// 7
{
  const ref = "banking:concept-bank-freeze";
  const { vs, only, failures } = await runVsBase(["Q04"], (files) => {
    wordOf(files, "banking", "concept-bank-freeze").accept.push("口座停止");
  });
  check("基準線にあるカードに読みの無い漢字の別表記を足しても、基準線だけでは落ちない（基準線はカードの一覧）", baseline.Q04.includes(ref) && only.failures.length === 0, only.failures.join(" / "));
  const got = vs.byRule.get("Q04") ?? [];
  check(
    "前の木と比べると Q04「変わったカードに新しい当たり」で落ち、当たりは足した別表記だけ",
    failures.some((f) => f.startsWith("Q04: 変わったカードに新しい当たり 1 枚")) && got.length === 1 && got[0].card === ref && got[0].added.length === 1 && got[0].added[0].includes("口座停止"),
    `${failures.join(" / ")} ${JSON.stringify(got)}`
  );
}

// 8
{
  const ref = "publishing:concept-pub-schedule";
  const { vs, failures } = await runVsBase(["Q05"], (files) => {
    wordOf(files, "publishing", "concept-pub-schedule").accept.push("還元");
  });
  const got = vs.byRule.get("Q05") ?? [];
  check("基準線にある Q05 のカードに × になる漢字の別解（還元）を足すと、前の木と比べて Q05 が落ちる", baseline.Q05.includes(ref) && failures.some((f) => f.startsWith("Q05: 変わったカードに新しい当たり 1 枚")) && got[0]?.added.some((d) => d.includes("還元")), `${failures.join(" / ")} ${JSON.stringify(got)}`);
}

// 9
{
  const { vs, failures } = await runVsBase(["Q04", "Q05"], (files) => {
    wordOf(files, "banking", "concept-bank-freeze").explain += "。";
    const w = wordOf(files, "publishing", "concept-pub-schedule");
    w.accept = w.accept.filter((a) => a !== "スケジュール表");
  });
  check("基準線にあるカードの説明を変える・別表記を 1 つ外すだけなら、前の木と比べても落ちない（変わったカードは 2 枚）", failures.length === 0 && vs.changed.size === 2, `${failures.join(" / ")} changed=${vs.changed.size}`);
  const same = await runVsBase(["Q04"], null);
  check("前の木と同じ教材なら変わったカードは 0 枚で、前の木は流さない", same.vs.changed.size === 0 && same.vs.ranBase.length === 0 && same.failures.length === 0, JSON.stringify({ changed: same.vs.changed.size, ran: same.vs.ranBase }));
}

// 10
{
  const ref = "jsci1:concept-js1-mg";
  const patch = (files) => {
    const w = wordOf(files, "jsci1", "concept-js1-mg");
    w.accept = [...w.accept, "マグネシウム"]; // PR で accept に重複を足した
  };
  const ctx = await loadContext({ patch });
  const rs = pick("Q03", "Q15");
  const results = await runRules(ctx, rs);
  const first = compareWithBaseline(results, baseline, { partial: true });
  const q03 = first.rows.find((r) => r.id === "Q03");
  check("PR で jsci1:concept-js1-mg の accept に重複を足すと Q03 が新しい当たり 1 枚で落ちる", first.failures.some((f) => f.startsWith("Q03: 新しい当たり 1 枚")) && q03.added.join() === ref, first.failures.join(" / "));
  const updated = updateBaseline(results, baseline);
  const second = compareWithBaseline(results, updated, { partial: true });
  check("素の --update は誤りの規則の新しい当たりを基準線に足さない（Q03 は 0 枚のまま・まだ落ちる）", updated.Q03?.length === 0 && second.failures.some((f) => f.startsWith("Q03: 新しい当たり 1 枚")), `Q03=${JSON.stringify(updated.Q03)} ${second.failures.join(" / ")}`);
  const lowered = updateBaseline(results, { ...baseline, Q03: [ref, "jsci1:concept-js1-cu"] });
  check("素の --update はもう当たらないカード（cu）を消し、今も当たるカード（mg）は残す（下げる）", JSON.stringify(lowered.Q03) === JSON.stringify([ref]), JSON.stringify(lowered.Q03));
  const q15 = results.find((r) => r.id === "Q15");
  check("警告の規則は素の --update で今の当たりに合わせる（落とさない規則。数の推移を基準線の差分で見る）", JSON.stringify(updateBaseline(results, { ...baseline, Q15: [] }).Q15) === JSON.stringify([...q15.hits.keys()].sort()), "");
  const added = updateBaseline(results, baseline, { add: new Set(["Q03"]) });
  const local = compareWithBaseline(results, added, { partial: true });
  check("--update --add=Q03 なら新しい当たりを足し、手元の比べ（--base なし）は通る", JSON.stringify(added.Q03) === JSON.stringify([ref]) && local.failures.length === 0, `Q03=${JSON.stringify(added.Q03)} ${local.failures.join(" / ")}`);
  const raised = await compareWithTargetBaseline(baseline, added, rs, baseCtx);
  const ci = compareWithBaseline(results, added, { partial: true, raised });
  check(
    "CI の形（向け先の基準線と比べる）では、--add で足しても Q03「基準線を上げた」で落ち、足したカードは 1 枚",
    ci.failures.some((f) => f.startsWith("Q03: 基準線を上げた（向け先 0 → 今 1")) && raised.get("Q03")?.added.join() === ref,
    `${ci.failures.join(" / ")} ${JSON.stringify([...raised])}`
  );
  const fresh = await compareWithTargetBaseline({ Q15: baseline.Q15 }, added, rs, baseCtx);
  check("向け先の基準線に無い規則（PR で足した規則）は上げても落とさない", ![...fresh.values()].some((x) => x.added.length), JSON.stringify([...fresh]));
  // 規則・判定器を変えて、前からある教材に当たりが見つかった形（同じ id の規則が、向け先の教材でも今の教材でも同じカードに当たる）
  const wider = [{ id: "E7", level: "error", describe: "広げた規則", run: (c) => c.cards.slice(0, 2).map((w) => ({ card: w.ref })) }];
  const wide = await runRules(ctx, wider);
  const nextBase = updateBaseline(wide, { E7: [baseCtx.cards[0].ref] }, { add: new Set(["E7"]) });
  const fromCode = await compareWithTargetBaseline({ E7: [baseCtx.cards[0].ref] }, nextBase, wider, baseCtx);
  const ciCode = compareWithBaseline(wide, nextBase, { partial: true, raised: fromCode });
  check(
    "向け先の教材でも今のコードで当たるカード（規則・判定器の変更で見つかった前からの当たり）は、基準線に足しても落とさない",
    ciCode.failures.length === 0 && fromCode.get("E7")?.fromCode.length === 1 && fromCode.get("E7")?.added.length === 0,
    `${ciCode.failures.join(" / ")} ${JSON.stringify([...fromCode])}`
  );
}

// 11
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spelldash-check-"));
  try {
    const pr = path.join(tmp, "pr");
    fs.cpSync(path.join(ROOT, "data"), path.join(pr, "data"), { recursive: true });
    fs.cpSync(path.join(ROOT, "js"), path.join(pr, "js"), { recursive: true });
    fs.mkdirSync(path.join(pr, "scripts", "quality"), { recursive: true });
    const prBaseline = path.join(pr, "scripts", "quality", "baseline.json");
    fs.writeFileSync(prBaseline, JSON.stringify(baseline, null, 2) + "\n");
    const file = path.join(pr, "data", "packs", "jsci1.json");
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.words.find((w) => w.id === "concept-js1-mg").accept.push("マグネシウム");
    fs.writeFileSync(file, JSON.stringify(json));
    const CHECK = path.join(path.dirname(fileURLToPath(import.meta.url)), "check.mjs");
    const cli = (...args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [CHECK, `--root=${pr}`, `--baseline=${prBaseline}`, "--only=Q03", ...args], { encoding: "utf8" }) };
      } catch (e) {
        return { code: e.status, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
      }
    };
    const q03 = () => JSON.parse(fs.readFileSync(prBaseline, "utf8")).Q03;
    const a = cli(`--base=${ROOT}`);
    check("コマンド: 重複を足した木で --base は Q03 の新しい当たりで落ちる（exit 1）", a.code === 1 && a.out.includes("Q03: 新しい当たり 1 枚"), a.out.slice(-400));
    cli("--update");
    const b = cli(`--base=${ROOT}`);
    check("コマンド: 素の --update の後も Q03 の基準線は 0 枚で、--base はまだ落ちる", q03().length === 0 && b.code === 1, `Q03=${JSON.stringify(q03())} ${b.out.slice(-300)}`);
    cli("--update", "--add=Q03");
    const c = cli();
    const d = cli(`--base=${ROOT}`);
    check(
      "コマンド: --update --add=Q03 で足すと手元は通るが、CI の形（--base と向け先の基準線）は「基準線を上げた」で落ちる",
      q03().join() === "jsci1:concept-js1-mg" && c.code === 0 && d.code === 1 && d.out.includes("Q03: 基準線を上げた"),
      `Q03=${JSON.stringify(q03())} local=${c.code} ci=${d.code} ${d.out.slice(-400)}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 12
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spelldash-judge-"));
  try {
    fs.cpSync(path.join(ROOT, "js"), path.join(tmp, "js"), { recursive: true });
    fs.renameSync(path.join(tmp, "js", "judge.js"), path.join(tmp, "js", "judge-real.js"));
    // この木の判定器は、何を打っても 1 打目で ×（規則が別の木の判定器を使えば Q05 の当たりは基準線と同じ 167 枚前後のまま）
    fs.writeFileSync(path.join(tmp, "js", "judge.js"), 'export * from "./judge-real.js";\nexport function typeAnswer() {\n  return { how: "miss", at: 1, expected: "" };\n}\n');
    const ctx = await loadContext({ root: tmp, dataRoot: ROOT });
    const [q05] = await runRules(ctx, pick("Q05"));
    const details = [...q05.hits.values()].flat();
    check("Q05 は ctx の木（--root）の js/judge.js で判定する（その木の判定器が全部 × なら、全カードが当たる）", q05.hits.size > 1000 && details.every((d) => d.includes("1 打目で ×")), `Q05=${q05.hits.size} 枚`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 13
{
  const ref = "jsci1:concept-js1-mg";
  const prev = globalThis.fetch;
  const mark = (s) => (files) => {
    wordOf(files, "jsci1", "concept-js1-mg").explain = s;
  };
  let got = null;
  try {
    const [a, b, c] = await Promise.all([loadContext({ patch: mark("木A") }), loadContext({ patch: mark("木B") }), loadContext({ patch: mark("木C") })]);
    got = [a, b, c].map((x) => x.cardByRef.get(ref)?.explain);
  } catch (e) {
    got = String(e?.message ?? e);
  }
  check("loadContext を 3 つ同時に呼んでも、それぞれ自分の教材を読む（木が混ざらない）", JSON.stringify(got) === JSON.stringify(["木A", "木B", "木C"]), JSON.stringify(got));
  const fetchBack = globalThis.fetch === prev;
  globalThis.fetch = prev;
  check("同時に呼んだ後、global の fetch は元に戻る（偽の fetch が残らない）", fetchBack, "");
}

// ---- 14〜20: 別表記の読み（acceptReadings。Batch 71） ----
// 教材を直しても（段 3 で学校と基本を結ぶ）検査が変わらないように、使うカードは patch で決まった形に置いてから流す
const R = baseCtx.modules.romaji;
const KNOWN = {
  "jhist1:concept-jh1-iwajuku": ["いわじゅくいせき", "岩宿", "いわじゅく"],
  "jhist1:concept-jh1-sannaimaruyama": ["さんないまるやまいせき", "三内丸山", "さんないまるやま"],
  "jhist1:concept-jh1-oshio": ["おおしおへいはちろうのらん", "大塩の乱", "おおしおのらん"],
  "jhist1:concept-jh1-shotokutaishi": ["しょうとくたいし", "厩戸皇子", "うまやどのおうじ", "厩戸王", "うまやどのおう", "うまやとおう"],
  "elem-hist:concept-eh-shotokutaishi": ["しょうとくたいし", "厩戸皇子", "うまやどのおうじ", "厩戸王"],
  "hs-bio:concept-hb-gairai": ["がいらいせいぶつ", "外来種", "がいらいしゅ"],
  "hs-civics:concept-hp-akaji-kokusai": ["あかじこくさい", "特例国債", "とくれいこくさい"],
  "listing:concept-weight-tax-refund": ["自動車重量税還付", "重量税の還付", "じゅうりょうぜいかんぷ"],
  "listing:concept-deal": ["契約", "売却合意", "成約件数", "せいやく"],
  "elem-math:concept-em-bunpai": ["ぶんぱいのきまり", "分配法則"]
};
// ref のカードを KNOWN の accept（＋ add − remove）にし、acceptReadings を map にする（undefined なら欄を消す）
const put = (files, ref, map, { add = [], remove = [] } = {}) => {
  const [cat, id] = ref.split(":");
  const w = wordOf(files, cat, id);
  w.accept = [...KNOWN[ref].filter((a) => !remove.includes(a)), ...add];
  if (map === undefined) delete w.acceptReadings;
  else w.acceptReadings = map;
};
const known = (...refs) => (files) => refs.forEach((ref) => put(files, ref, undefined));
const hitsOf = async (ids, patch) => {
  const ctx = await loadContext({ patch });
  const results = await runRules(ctx, pick(...ids));
  const of = (id, ref) => results.find((r) => r.id === id)?.hits.get(ref) ?? null;
  return { ctx, results, of };
};
// 前の木も patch した教材で流す（base と head のどちらも決まった形から。基準線にもそのカードを入れる）
async function vsBase(ids, basePatch, headPatch, refs) {
  const base = { ...baseline };
  for (const id of ids) base[id] = [...new Set([...(baseline[id] ?? []), ...refs])].sort();
  const before = await loadContext({ patch: basePatch });
  const ctx = await loadContext({ patch: (files) => (basePatch(files), headPatch(files)) });
  const rs = pick(...ids);
  const results = await runRules(ctx, rs);
  const vs = await compareWithBase(ctx, results, before, rs, base);
  return { vs, only: compareWithBaseline(results, base, { partial: true }), ...compareWithBaseline(results, base, { partial: true, changed: vs.byRule }) };
}
const IWA = "jhist1:concept-jh1-iwajuku";
const SAN = "jhist1:concept-jh1-sannaimaruyama";
const OSHIO = "jhist1:concept-jh1-oshio";
const SHOTOKU = "elem-hist:concept-eh-shotokutaishi";
const JSHO = "jhist1:concept-jh1-shotokutaishi";
const GAI = "hs-bio:concept-hb-gairai";
const AKA = "hs-civics:concept-hp-akaji-kokusai";
const TAX = "listing:concept-weight-tax-refund";

// 14
{
  const before = (await hitsOf(["Q04"], known(IWA))).of("Q04", IWA) ?? [];
  check("結んでいない漢字の別表記は Q04 の当たりのまま（中身は「読みを結んでいない」）", before.length === 1 && before[0] === "漢字の別表記「岩宿」（B 型）に読みを結んでいない", JSON.stringify(before));
  const bound = (await hitsOf(["Q04"], (files) => put(files, IWA, { 岩宿: "いわじゅく" }))).of("Q04", IWA);
  check("別表記に読みを結ぶと Q04 から消える（jhist1 岩宿遺跡: 岩宿 → いわじゅく）", bound === null, JSON.stringify(bound));
  const missing = (await hitsOf(["Q04"], (files) => put(files, IWA, { 岩宿: "いわじゅく" }, { remove: ["いわじゅく"] }))).of("Q04", IWA) ?? [];
  check("結んだ読みが accept に無いと Q04 に当たる", missing.length === 1 && missing[0].includes("「岩宿」に結んだ読み「いわじゅく」が accept に無い"), JSON.stringify(missing));
  const shape = (await hitsOf(["Q04"], (files) => put(files, OSHIO, { 大塩の乱: "おおしおらん" }, { add: ["おおしおらん"] }))).of("Q04", OSHIO) ?? [];
  check("結んだ読みが別表記の形に合わないと Q04 に当たる（大塩の乱 → おおしおらん。「の」が読みに無い）", shape.length === 1 && shape[0].includes("「大塩の乱」に結んだ読み「おおしおらん」と、別表記のかな・字数が合わない"), JSON.stringify(shape));
  const latin = (await hitsOf(["Q04"], (files) => put(files, IWA, { 岩宿: "iwajuku" }, { add: ["iwajuku"] }))).of("Q04", IWA) ?? [];
  check("結んだ読みがひらがなの読みでない（iwajuku）と Q04 に当たる", latin.length === 1 && latin[0].includes("「岩宿」に結んだ「iwajuku」が読みの形でない"), JSON.stringify(latin));
  const empty = (await hitsOf(["Q04"], (files) => put(files, IWA, { 岩宿: [] }))).of("Q04", IWA) ?? [];
  check("結んだ読みが空の配列なら Q04 に当たる", empty.length === 1 && empty[0].includes("「岩宿」に結んだ読みが無い"), JSON.stringify(empty));

  const whole = (await hitsOf(["Q04"], known(SHOTOKU))).of("Q04", SHOTOKU) ?? [];
  const partPatch = (files) => put(files, SHOTOKU, { 厩戸皇子: "うまやどのおうじ" });
  const part = (await hitsOf(["Q04"], partPatch)).of("Q04", SHOTOKU) ?? [];
  check("1 枚の別表記の一部だけを結ぶと、当たりは残り中身が減る（聖徳太子: 2 → 1。残りは 厩戸王）", whole.length === 2 && part.length === 1 && part[0] === "漢字の別表記「厩戸王」（C 型）に読みを結んでいない", `${JSON.stringify(whole)} → ${JSON.stringify(part)}`);
  const partVs = await vsBase(["Q04"], known(SHOTOKU), partPatch, [SHOTOKU]);
  check("一部だけ結んでも --base では落ちない（変わったカード 1 枚）", partVs.failures.length === 0 && partVs.vs.changed.size === 1, `${partVs.failures.join(" / ")} changed=${partVs.vs.changed.size}`);
  const wrongVs = await vsBase(["Q04"], known(IWA), (files) => put(files, IWA, { 岩宿: "いわじゆく" }), [IWA]);
  const grown = wrongVs.vs.byRule.get("Q04") ?? [];
  check(
    "基準線にあるカードを誤って結ぶ（accept に無い読み）と、基準線だけでは落ちないが、--base で Q04「変わったカードに新しい当たり」で落ちる",
    wrongVs.only.failures.length === 0 && wrongVs.failures.some((f) => f.startsWith("Q04: 変わったカードに新しい当たり 1 枚")) && grown[0]?.card === IWA && grown[0]?.added[0]?.includes("いわじゆく"),
    `${wrongVs.only.failures.join(" / ")} | ${wrongVs.failures.join(" / ")} ${JSON.stringify(grown)}`
  );

  const no = (await hitsOf(["Q04"], known(TAX))).of("Q04", TAX) ?? [];
  check("「の」の有無だけ違う別表記は今の数え方のまま（読みが無ければ当たり）", no.includes("「の」の有無だけ違う別表記「重量税の還付」の読みが無い（主な読み じゅうりょうぜいかんぷ）"), JSON.stringify(no));
  const noBound = (await hitsOf(["Q04"], (files) => put(files, TAX, { 重量税の還付: "じゅうりょうぜいのかんぷ" }, { add: ["じゅうりょうぜいのかんぷ"] }))).of("Q04", TAX) ?? [];
  check("「の」の型も結べば消え、ほかの別表記（自動車重量税還付）は当たりのまま", noBound.length === 1 && noBound[0] === "漢字の別表記「自動車重量税還付」（B 型）に読みを結んでいない", JSON.stringify(noBound));
}

// 15
{
  const hasRule = rules.some((r) => r.id === "Q04w" && r.level === "warn");
  check("Q04w（警告）の規則がある", hasRule, rules.map((r) => r.id).join(","));
  const q = (await hitsOf(["Q04w"])).results.find((r) => r.id === "Q04w");
  check("今の教材の Q04w は基準線どおり（--update --add=Q04w で入れた。警告なので --update で合わせる）", hasRule && JSON.stringify([...(q?.hits.keys() ?? [])].sort()) === JSON.stringify(baseline.Q04w ?? null), `${q?.hits.size} / ${JSON.stringify(baseline.Q04w)}`);
  const w = (ref, patch) => hitsOf(["Q04w"], patch).then((x) => x.of("Q04w", ref) ?? []);
  const a1 = await w(SAN, (files) => put(files, SAN, { 三内丸山: "さんないまるさん" }, { add: ["さんないまるさん"] }));
  const a0 = await w(SAN, (files) => put(files, SAN, { 三内丸山: "さんないまるやま" }));
  // さんないまるさん に結ぶと、前の読み さんないまるやま はどの別表記にも結ばれない短い読みになるので「別表記の無い短い読み」にも出る
  check(
    "Q04w 短い形: 三内丸山 → さんないまるさん（ほかの読みの頭にならない）は当たり、さんないまるやま は当たらない",
    hasRule && a1.filter((d) => d.startsWith("短い形: 「三内丸山」は答えの頭なのに、読み「さんないまるさん」")).length === 1 && a0.length === 0,
    `${JSON.stringify(a1)} / ${JSON.stringify(a0)}`
  );
  const b1 = await w(GAI, (files) => put(files, GAI, { 外来種: "がいらいだね" }, { add: ["がいらいだね"] }));
  const b0 = await w(GAI, (files) => put(files, GAI, { 外来種: "がいらいしゅ" }));
  check("Q04w 他のカード: 外来種 → がいらいだね（外来種を答えにするカードの読みは がいらいしゅ）は当たり、がいらいしゅ は当たらない", hasRule && b1.length === 1 && b1[0].startsWith("他のカード: 「外来種」は ") && b1[0].includes("がいらいしゅ") && b0.length === 0, `${JSON.stringify(b1)} / ${JSON.stringify(b0)}`);
  const c1 = await w(AKA, (files) => put(files, AKA, { 特例国債: "あかじこくさい" }));
  const c0 = await w(AKA, (files) => put(files, AKA, { 特例国債: "とくれいこくさい" }));
  check("Q04w 同じ読み: 特例国債 → あかじこくさい（答えの主な読み）は当たり、とくれいこくさい は当たらない", hasRule && c1.length === 1 && c1[0].startsWith("同じ読み: 「特例国債」は答えと漢字が違う（赤字／特例）") && c0.length === 0, `${JSON.stringify(c1)} / ${JSON.stringify(c0)}`);
  const d1 = await w(IWA, (files) => put(files, IWA, undefined, { remove: ["岩宿"] }));
  const d0 = await w(IWA, (files) => put(files, IWA, { 岩宿: "いわじゅく" }));
  check("Q04w 別表記の無い短い読み: 岩宿 を外して いわじゅく を残すと当たり、岩宿 に結べば当たらない", hasRule && d1.length === 1 && d1[0].startsWith("別表記の無い短い読み: 「いわじゅく」は主な読み「いわじゅくいせき」の頭") && d0.length === 0, `${JSON.stringify(d1)} / ${JSON.stringify(d0)}`);
  const pair = (r1, r2) => (files) => {
    put(files, SHOTOKU, { 厩戸王: r1 }, { add: [r1] });
    put(files, JSHO, { 厩戸王: r2 });
  };
  const e1 = await hitsOf(["Q04w"], pair("うまやどのおう", "うまやとおう"));
  const e0 = await hitsOf(["Q04w"], pair("うまやどのおう", "うまやどのおう"));
  const eA = e1.of("Q04w", SHOTOKU) ?? [];
  const eB = e1.of("Q04w", JSHO) ?? [];
  check(
    "Q04w 同じ別表記の別の読み: 2 枚で 厩戸王 を共通の読みの無い読みに結ぶと両方に当たり、同じ読みなら当たらない",
    hasRule && eA.length === 1 && eA[0].startsWith(`同じ別表記の別の読み: 「厩戸王」を ${JSHO} では「うまやとおう」`) && eB.length === 1 && eB[0].includes(SHOTOKU) && !e0.of("Q04w", SHOTOKU) && !e0.of("Q04w", JSHO),
    `${JSON.stringify(eA)} / ${JSON.stringify(eB)} / ${JSON.stringify(e0.of("Q04w", SHOTOKU))}`
  );
}

// 16
{
  let shapeOk = null;
  try {
    ({ readingShapeOk: shapeOk } = await import("./readingShape.mjs"));
  } catch (e) {
    shapeOk = null;
  }
  const ok = [["関ケ原", "せきがはら"], ["一ヵ月", "いっかげつ"], ["X線", "xせん"], ["W杯", "だぶりゅーはい"], ["1192年", "1192ねん"], ["鎌倉ばくふ", "かまくらばくふ"], ["岩宿", "いわじゅく"]];
  const ng = [["大塩の乱", "おおしおらん"], ["平塚らいてう", "ひらつからいちょう"], ["岩宿", "いわじゅくいせきあと"]];
  const bad = shapeOk ? [...ok.filter(([t, r]) => !shapeOk(t, r, R.normalizeReading)), ...ng.filter(([t, r]) => shapeOk(t, r, R.normalizeReading))] : ["readingShape.mjs が無い"];
  check("別表記の形の見張り: 関ケ原・一ヵ月・X線・W杯・1192年・鎌倉ばくふ は合い、大塩の乱＝おおしおらん・平塚らいてう＝ひらつからいちょう は合わない", bad.length === 0, JSON.stringify(bad));
}

// 17
{
  const { simulate } = await import("./sim-judge.mjs");
  const ex1 = (files) => put(files, SHOTOKU, { 厩戸皇子: "うまやどのおうじ", 厩戸王: ["うまやどのおう", "うまやとおう"] }, { add: ["うまやどのおう", "うまやとおう"] });
  const ctx = await loadContext({ patch: ex1 });
  const rows = simulate(ctx, { rivals: false }).rows.filter((r) => r.ref === SHOTOKU && r.input === "kanjiAccept" && r.sub === "bound");
  check(
    "sim-judge: 結んだ別表記は読み 1 つごとに kanjiAccept の bound の行になり、Enter なしで正解（聖徳太子 3 行）",
    rows.length === 3 && rows.every((r) => r.how === "auto") && rows.map((r) => `${r.text}=${r.keys}`).join(",") === "厩戸皇子=umayadonoouji,厩戸王=umayadonoou,厩戸王=umayatoou",
    JSON.stringify(rows)
  );
  const q05 = (await hitsOf(["Q05"], (files) => put(files, IWA, { 岩宿: "いわじゆく" }))).of("Q05", IWA) ?? [];
  check("accept に無い読みを結ぶと、その読みは打てないので Q05 に当たる（bound の行）", q05.some((d) => d.includes("bound「岩宿」") && d.includes("×")), JSON.stringify(q05));
}

// 18
{
  let review = null;
  try {
    ({ reviewReadings: review } = await import("./review-readings.mjs"));
  } catch (e) {
    review = null;
  }
  let lines = [];
  if (review) {
    const ctx = await loadContext({
      patch: (files) => {
        put(files, "elem-math:concept-em-bunpai", { 分配法則: "ぶんぱいのきまり" });
        put(files, IWA, { 岩宿: "いわじゅく" });
      }
    });
    lines = review(ctx, { refs: new Set(["elem-math:concept-em-bunpai", IWA]) }).rows;
  }
  check(
    "反証の手がかり: 分配法則 → ぶんぱいのきまり（法・則の読みがデータに無い）は裏付けの無い組に出て、岩宿 → いわじゅく は出ない",
    review && lines.length === 1 && lines[0].card === "elem-math:concept-em-bunpai" && lines[0].alt === "分配法則" && lines[0].reading === "ぶんぱいのきまり",
    JSON.stringify(lines)
  );
}

// 19, 20（写しにコマンドを流す）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spelldash-readings-"));
  const node = (script, args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  };
  try {
    // 19 validate-words（教材の写し）
    const vroot = path.join(tmp, "v");
    fs.cpSync(path.join(ROOT, "data"), path.join(vroot, "data"), { recursive: true });
    const fileOf = (cat) => baseCtx.categoryById.get(cat).file;
    const edit = (ref, fn) => {
      const [cat, id] = ref.split(":");
      const f = path.join(vroot, "data", fileOf(cat));
      const json = JSON.parse(fs.readFileSync(f, "utf8"));
      fn(json.words.find((x) => x.id === id));
      fs.writeFileSync(f, JSON.stringify(json));
    };
    const set = (ref, map, add = []) =>
      edit(ref, (w) => {
        w.accept = [...(KNOWN[ref] ?? w.accept), ...add];
        if (map === undefined) delete w.acceptReadings;
        else w.acceptReadings = map;
      });
    set(IWA, { 岩宿: "いわじゅく" });
    const good = node("validate-words.mjs", [`--root=${vroot}`]);
    check("validate-words: 形の合う acceptReadings は通り、結んだ数を出す（読みを結んだ別表記 1 以上）", good.code === 0 && /読みを結んだ別表記 [1-9]/.test(good.out), good.out.slice(-300));
    set(SAN, undefined);
    set("listing:concept-deal", undefined);
    const strict = node("validate-words.mjs", [`--root=${vroot}`]);
    const sLines = strict.out.split("\n").filter((l) => l.includes("学校・基本の別表記に読みを結んでいない"));
    check(
      "validate-words: 学校と基本の結んでいない別表記を NG にする（三内丸山・listing の 契約）。結んだ 岩宿 と分野パックは出ない",
      strict.code === 1 &&
        sLines.some((l) => l.includes("packs/jhist1.json:concept-jh1-sannaimaruyama (三内丸山)")) &&
        sLines.some((l) => l.includes("english/listing.json:concept-deal (契約)")) &&
        !sLines.some((l) => l.includes("concept-jh1-iwajuku")) &&
        !sLines.some((l) => l.includes("packs/banking.json")),
      `exit=${strict.code} ${sLines.length} 件 ${sLines.slice(0, 3).join(" / ")}`
    );
    set(IWA, { 岩宿跡: "いわじゅく" });
    set(SAN, { 三内丸山: "さんないまるさん" });
    set(OSHIO, { 大塩の乱: "oshio" });
    set(JSHO, { うまやどのおう: "うまやどのおう" });
    set(SHOTOKU, { 厩戸王: 5 });
    set(AKA, { 特例国債: ["とくれいこくさい", "トクレイコクサイ"] });
    edit("hs-gendaibun:concept-hgb-signifie", (w) => {
      w.accept = [...w.accept.filter((a) => a !== "signifié"), "signifié"];
      w.acceptReadings = { signifié: "しにふぃえ" };
    });
    edit("elem-sci:concept-es-sanagi", (w) => (w.acceptReadings = ["蛹"]));
    edit("junior:english-apple", (w) => (w.acceptReadings = { 林檎: "りんご" }));
    const bad = node("validate-words.mjs", [`--root=${vroot}`]);
    const want = [
      "acceptReadings の別表記が accept に無い packs/jhist1.json:concept-jh1-iwajuku (岩宿跡)",
      "acceptReadings の読みが accept に無い packs/jhist1.json:concept-jh1-sannaimaruyama (三内丸山: さんないまるさん)",
      "acceptReadings の読みがひらがなの読みでない packs/jhist1.json:concept-jh1-oshio (大塩の乱: oshio)",
      "acceptReadings の別表記が読み（読みに読みは要らない） packs/jhist1.json:concept-jh1-shotokutaishi (うまやどのおう)",
      "acceptReadings の値（読みか読みの配列） packs/elem-hist.json:concept-eh-shotokutaishi (厩戸王)",
      "acceptReadings の読みが重複 packs/hs-civics.json:concept-hp-akaji-kokusai (特例国債)",
      "acceptReadings の別表記にかなも漢字も無い packs/hs-gendaibun.json:concept-hgb-signifie (signifié)",
      "acceptReadings の形（オブジェクト） packs/elem-sci.json:concept-es-sanagi",
      "acceptReadings は日本語の答えのカードだけ english/junior.json:english-apple"
    ];
    const lost = want.filter((x) => !bad.out.includes(x));
    check("validate-words: acceptReadings の形の誤り 9 種を NG にする", bad.code === 1 && lost.length === 0, `exit=${bad.code} 無い: ${lost.join(" / ")}`);

    // 20 add-readings（4 通りの体裁＋区切りに空白の無い形の小さな教材。--root）
    const aroot = path.join(tmp, "a");
    const card = (id, answer, accept, extra = {}) => ({ id: `concept-${id}`, en: id, kind: "concept", answer, accept, ja: `${answer}の要約`, level: "easy", tags: ["t"], ...extra });
    const T = {
      line: { file: "packs/t-line.json", cards: [card("t-shotoku", "聖徳太子", ["しょうとくたいし", "厩戸皇子", "うまやどのおうじ", "厩戸王"]), card("t-iwa", "岩宿遺跡", ["いわじゅくいせき", "岩宿"])] },
      tight: { file: "packs/t-tight.json", cards: [card("t-iwa2", "岩宿遺跡", ["いわじゅくいせき", "岩宿"])] },
      row: { file: "packs/t-row.json", cards: [card("t-choku", "直列回路", ["ちょくれつかいろ", "直列", "直列つなぎ"]), card("t-hei", "並列回路", ["へいれつかいろ"])] },
      multi: { file: "english/t-multi.json", cards: [card("t-deal", "成約", ["契約", "売却合意", "成約件数", "せいやく"]), card("t-tax", "重量税還付", ["重量税の還付", "じゅうりょうぜいかんぷ"])] },
      pretty: { file: "packs/t-pretty.json", cards: [card("t-kino", "帰納", ["きのう", "induction", "帰納法"])] }
    };
    const head = (cat) => ({ subject: "english", category: cat, label: cat });
    const indentCard = (w, sep) =>
      "    {\n" +
      Object.entries(w)
        .map(([k, v]) => `      ${JSON.stringify(k)}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(sep)}]` : JSON.stringify(v)}`)
        .join(",\n") +
      "\n    }";
    const fileText = {
      // 1 項目 1 行・accept は 1 行（elem-hist の形）／区切りに空白の無い形（jhist1 の形）
      line: `{\n  "subject": "english",\n  "category": "t-line",\n  "label": "t-line",\n  "words": [\n${T.line.cards.map((w) => indentCard(w, ", ")).join(",\n")}\n  ]\n}\n`,
      tight: `{\n  "subject": "english",\n  "category": "t-tight",\n  "label": "t-tight",\n  "words": [\n${T.tight.cards.map((w) => indentCard(w, ",")).join(",\n")}\n  ]\n}\n`,
      // 1 行 1 カード（jsci1 の形）
      row: `{\n  "subject": "english",\n  "category": "t-row",\n  "label": "t-row",\n  "words": [\n${T.row.cards.map((w) => `    { ${Object.entries(w).map(([k, v]) => `${JSON.stringify(k)}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v)}`).join(", ")} }`).join(",\n")}\n  ]\n}\n`,
      // 複数行の accept で、JSON.stringify と末尾の改行だけが違う（english/listing.json の形）
      multi: JSON.stringify({ ...head("t-multi"), words: T.multi.cards }, null, 2),
      // JSON.stringify(_, null, 2) の形（hs-gendaibun など）
      pretty: JSON.stringify({ ...head("t-pretty"), words: T.pretty.cards }, null, 2) + "\n"
    };
    const manifest = { subjects: [{ id: "english", categories: Object.entries(T).map(([k, t]) => ({ id: `t-${k}`, file: t.file, ...(t.file.startsWith("packs/") ? { pack: true } : {}) })) }] };
    fs.mkdirSync(path.join(aroot, "data", "packs"), { recursive: true });
    fs.mkdirSync(path.join(aroot, "data", "english"), { recursive: true });
    fs.writeFileSync(path.join(aroot, "data", "manifest.json"), JSON.stringify(manifest));
    for (const [k, t] of Object.entries(T)) fs.writeFileSync(path.join(aroot, "data", t.file), fileText[k]);
    const read = (k) => fs.readFileSync(path.join(aroot, "data", T[k].file), "utf8");
    const ledger = (name, rows) => {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, JSON.stringify(rows));
      return p;
    };
    const empty = ledger("proposed-empty.json", []);
    const add = (...args) => node("add-readings.mjs", [`--root=${aroot}`, ...args]);
    const L1 = ledger("reviewed-1.json", [
      { id: "concept-t-shotoku", category: "t-line", readings: [], alts: { 厩戸皇子: "うまやどのおうじ", 厩戸王: ["うまやどのおう", "うまやとおう"] } },
      { id: "concept-t-iwa2", category: "t-tight", readings: [], alts: { 岩宿: "いわじゅく" } },
      { id: "concept-t-choku", category: "t-row", readings: [], alts: { 直列つなぎ: "ちょくれつつなぎ" }, drop: ["直列"] },
      { id: "concept-t-deal", category: "t-multi", readings: [], drop: ["契約", "売却合意", "成約件数"] },
      { id: "concept-t-tax", category: "t-multi", readings: [], alts: { 重量税の還付: "じゅうりょうぜいのかんぷ" } },
      { id: "concept-t-kino", category: "t-pretty", readings: [], alts: { 帰納法: "きのうほう" } }
    ]);
    const first = add(empty, L1);
    const swap = (text, pairs) => pairs.reduce((t, [a, b]) => (t.split(a).length === 2 ? t.replace(a, b) : `（置き換え元が 1 つでない: ${a.slice(0, 40)}）`), text);
    const expect = {
      line: swap(fileText.line, [
        ['      "accept": ["しょうとくたいし", "厩戸皇子", "うまやどのおうじ", "厩戸王"],\n', '      "accept": ["しょうとくたいし", "厩戸皇子", "うまやどのおうじ", "厩戸王", "うまやどのおう", "うまやとおう"],\n      "acceptReadings": {"厩戸皇子": "うまやどのおうじ", "厩戸王": ["うまやどのおう", "うまやとおう"]},\n']
      ]),
      tight: swap(fileText.tight, [['      "accept": ["いわじゅくいせき","岩宿"],\n', '      "accept": ["いわじゅくいせき","岩宿","いわじゅく"],\n      "acceptReadings": {"岩宿":"いわじゅく"},\n']]),
      row: swap(fileText.row, [['"accept": ["ちょくれつかいろ", "直列", "直列つなぎ"], "ja"', '"accept": ["ちょくれつかいろ", "直列つなぎ", "ちょくれつつなぎ"], "acceptReadings": {"直列つなぎ": "ちょくれつつなぎ"}, "ja"']]),
      multi: swap(fileText.multi, [
        ['      "accept": [\n        "契約",\n        "売却合意",\n        "成約件数",\n        "せいやく"\n      ],\n', '      "accept": [\n        "せいやく"\n      ],\n'],
        ['        "じゅうりょうぜいかんぷ"\n      ],\n', '        "じゅうりょうぜいかんぷ",\n        "じゅうりょうぜいのかんぷ"\n      ],\n      "acceptReadings": {"重量税の還付": "じゅうりょうぜいのかんぷ"},\n']
      ]),
      pretty: swap(fileText.pretty, [['        "きのう",\n        "induction",\n        "帰納法"\n      ],\n', '        "きのう",\n        "induction",\n        "帰納法",\n        "きのうほう"\n      ],\n      "acceptReadings": {\n        "帰納法": "きのうほう"\n      },\n']])
    };
    const wrong = Object.keys(expect).filter((k) => read(k) !== expect[k]);
    check(
      "add-readings の alts: 4 通りの体裁（1 項目 1 行・1 行 1 カード・複数行の accept・JSON.stringify の形）と区切りに空白の無い形で、accept の直後に書き、ほかの行は変えない",
      first.code === 0 && wrong.length === 0 && first.out.includes("結んだ別表記: 6件") && first.out.includes("カード 6枚 / ファイル 5本"),
      `exit=${first.code} 違うファイル: ${wrong.map((k) => `${k}\n${read(k)}`).join(",")} ${first.out.slice(-300)}`
    );
    const again = add(empty, L1);
    check("add-readings: 2 度目は何も変えない（カード 0 枚）", again.code === 0 && again.out.includes("カード 0枚") && Object.keys(expect).every((k) => read(k) === expect[k]), again.out.slice(-200));
    const snap = read("row");
    const typo = add(empty, ledger("reviewed-typo.json", [{ id: "concept-t-choku", category: "t-row", readings: [], alts: { 蛹虫: "さなぎむし", 直列つなぎ: "chokuretsu" } }]));
    check(
      "add-readings: accept に無い別表記（蛹虫）・ひらがなでない読みは NG（exit 1）で、そのファイルは書かない",
      typo.code === 1 && typo.out.includes("packs/t-row.json:concept-t-choku 別表記「蛹虫」が accept に無い（alts）") && typo.out.includes("「直列つなぎ」の読み「chokuretsu」がひらがなの読みでない（alts）") && read("row") === snap,
      `exit=${typo.code} ${typo.out.slice(-300)}`
    );
    const dropped = add(
      empty,
      ledger("reviewed-drop.json", [
        { id: "concept-t-shotoku", category: "t-line", readings: ["しょうとくたいし", "うまやとおう"], drop: ["厩戸王"] },
        { id: "concept-t-choku", category: "t-row", readings: [], drop: ["直列つなぎ"] }
      ])
    );
    const eh = JSON.parse(read("line")).words.find((x) => x.id === "concept-t-shotoku");
    check(
      "add-readings: 結んだ別表記を drop すると、その記録と、その別表記だけに結んだ読みも消える（台帳の readings にある読みは残す。空になれば欄ごと消す）",
      dropped.code === 0 &&
        JSON.stringify(eh.accept) === JSON.stringify(["しょうとくたいし", "厩戸皇子", "うまやどのおうじ", "うまやとおう"]) &&
        JSON.stringify(eh.acceptReadings) === JSON.stringify({ 厩戸皇子: "うまやどのおうじ" }) &&
        dropped.out.includes("packs/t-line.json:concept-t-shotoku 「厩戸王」に結んでいた読み「うまやどのおう」も外した") &&
        !dropped.out.includes("読み「うまやとおう」も外した") &&
        read("row").includes('"accept": ["ちょくれつかいろ"], "ja"') &&
        !read("row").includes("acceptReadings"),
      `exit=${dropped.code} ${JSON.stringify(eh.accept)} ${JSON.stringify(eh.acceptReadings)} ${dropped.out.slice(-400)}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
