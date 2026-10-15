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

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
