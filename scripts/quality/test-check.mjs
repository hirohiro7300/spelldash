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
import { loadContext } from "./ctx.mjs";
import { loadRules, runRules, compareWithBaseline, compareWithBase, baselineOf, readBaseline } from "./check.mjs";

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
  const lowered = baselineOf(first.results, baseline, new Set(["Q04"]));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
