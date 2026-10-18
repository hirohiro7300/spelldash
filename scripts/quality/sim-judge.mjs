// 判定器のシミュレーション（全カード × 打つもの → 打ち切ると Enter なしで正解か／何打目で × か）。読むだけ（データは変えない）。
//   node scripts/quality/sim-judge.mjs                 要約（打つものの種類 × 結果の数・規則 Q05 の当たりの数）
//   node scripts/quality/sim-judge.mjs --tsv <file>    1 行 1 件の表（競合語の表を含む）も書く
//   node scripts/quality/sim-judge.mjs --json          要約を JSON で
//   node scripts/quality/sim-judge.mjs --root <木>     別の木（data/ と js/）で流す（前の判定と比べるとき。js/answers.js に meaningGroups の無い
//                                                     PR #175 より前の木は、その木の scripts/quality/sim-judge.mjs で流す）
//
// 判定は盤面と同じ js/judge.js の typeAnswer（新しい語を頭から打つ。前の語の続きは無い。js/judge.js は ctx の木〔--root〕のもの）。候補は盤面と同じ作り方で、
// 有効にしたパックは「基本カテゴリ＋そのカードのパック」（パックを 1 つ足した人の盤面。基本カテゴリのカードは基本カテゴリだけ）。
//
// 打つもの（own＝このカードで正解になるはずのもの。規則 Q05 が見る）:
//   answer   出題語（綴り）・主な読み（ローマ字）・答え（全文入力）
//   reading  ほかの読み（accept のかな・英字の読み。ローマ字のカード）
//   accept   データの別解（綴り入力・全文入力のカード。綴り入力で打てない字〔日本語〕を含むものは untypeable）
//   alt      別解の索引の語（同じ訳の別の語。綴り入力のカード）
//   kanjiAccept  漢字の別解（ローマ字のカード）を、その読みで打ったもの。sub = bound（カードの acceptReadings で別表記に結んだ読み。
//                docs/PACK_FORMAT.md「別表記の読み」。結んだ読み 1 つごとに 1 行。ほかの行と同じ読みでも数える＝打てるようになった別表記の数）と、
//                データの中の読み（同じ字面を答えにするカードの主な読み。その読みがこのカードの読みに無いときだけ）で打った
//                short（答えの漢字の先頭部分。直列／直列回路）・same（漢字の並びが同じ。「の」の有無）・other（別の語: 電子線／陰極線）。
//                読みが分からない別解は数えない（規則 Q04 が見る）
// 競合語（rival＝打つと × になりうる語。表にだけ出す。記録が無くても欠陥の候補を全数で出す「競合語の表」）:
//   otherPack     同じ id の他のカテゴリのカードにある答え・別解（綴り）・読み（ローマ字）で、このカードの候補に無いもの
//   packAlt       全パックを有効にすると別解になるが、このカードの盤面（基本＋そのパック）では候補に無い語（有効にしたパックで正解が変わる）
//   oneChar       同じ盤面で 1 字の訳が同じ語（moon／month の「月」。1 字の訳は別解の索引が使わない。まとめ方は別解の索引と同じ
//                 js/answers.js meaningGroups の 1 字の訳）
//
// 結果（how）: auto（Enter なしで正解・別解）／enter（打ち終えて Enter で確定。× ではない）／miss（at 打目で 1 打ミス＝×）／
//             reveal（打ち終えても完成せず Enter で答えが開く＝×）／wrong（全文入力の違う答え＝×）／untypeable（その答え方では打てない字）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContext } from "./ctx.mjs";
import { kanjiOf, acceptReadingsOf } from "./common.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OWN_KINDS = ["answer", "reading", "accept", "alt", "kanjiAccept"];
export const RIVAL_KINDS = ["otherPack", "packAlt", "oneChar"];
export const X_HOWS = ["miss", "reveal", "wrong"];

// 字面（NFKC・中黒と空白を落とす）。規則 Q04w も同じ字面で比べる
export const faceOf = (s) => String(s ?? "").normalize("NFKC").replace(/[・･\s]/g, "");

// データの中の読みの表: 字面 → その字面を答えにする最初のカード（manifest の並び。読みの無いカードは数えない）の { ref, entries }。
// entries は judge.romajiEntriesFor(w)（entriesOf: Map〔カード → entries〕を渡せば作り直さない）。
// sim-judge は主な読みで漢字の別解を打ち、規則 Q04w の「他のカード」は結んだ読みをそのカードの読みと比べる
export function readingsByFace(cards, judge, entriesOf = null) {
  const out = new Map();
  for (const w of cards) {
    const entries = entriesOf?.get(w) ?? judge.romajiEntriesFor(w);
    if (!entries.length) continue;
    const f = faceOf(w.en);
    if (!out.has(f)) out.set(f, { ref: w.ref, entries });
  }
  return out;
}
// 綴り入力で打てる字（物理キーの 1 字。日本語は打てない: js/game.js handleCompositionEnd が英字モードに戻させる）
const SPELL_TYPEABLE = /^[\x20-\x7e]+$/;

// 打つもの 1 件に対して判定器を走らせる（keys = 実際に打つキーの並び。null なら untypeable）
function run(judge, word, candidates, keys) {
  if (keys == null) return { how: "untypeable", at: 0 };
  return judge.typeAnswer(word, candidates, keys);
}

// own の打つものの結果が規則 Q05 の当たり（×）か。出題語・主な読みは Enter なしで正解しないといけない（auto）。
// 別解は Enter で確定しても × ではない（advertisement の問いの ad は止めずに Enter で別解。js/answers.js completedAnswer）
export function isOwnFailure(row) {
  if (!OWN_KINDS.includes(row.input)) return false;
  if (row.how === "untypeable") return false; // 打てない別解は Q05 ではなく表に出すだけ（綴り入力のカードの日本語の別解）
  if (row.input === "answer") return row.mode === "free" ? row.how !== "enter" : row.how !== "auto";
  if (row.mode === "romaji") return row.how !== "auto";
  return X_HOWS.includes(row.how);
}

// ctx（scripts/quality/ctx.mjs）の全カードを流す。judge・answers を替えると別の判定で流せる（前の判定との比べ）。既定は ctx の木の js/。
// readingOf(text) → かなの読み | null: 漢字の別解の読み（既定はデータの中の読み）。rivals = 競合語も流すか（own はいつも流す）
export function simulate(ctx, { judge = ctx.modules.judge, answers = ctx.modules.answers, romaji = ctx.modules.romaji, readingOf = null, rivals = true } = {}) {
  if (!judge) throw new Error("simulate: judge（js/judge.js）が要る");
  if (rivals && typeof answers.meaningGroups !== "function") throw new Error("simulate: js/answers.js に meaningGroups が無い（PR #175 より前の木。その木の scripts/quality/sim-judge.mjs で流す）");
  const t0 = performance.now();
  const { cards } = ctx;
  const base = cards.filter((w) => !w.entry.pack);
  const indexCache = new Map();
  const indexFor = (w) => {
    const key = w.entry.pack ? w.entry.id : "";
    if (!indexCache.has(key)) indexCache.set(key, answers.buildAlternativeIndex(key ? [...base, ...ctx.cardsOf(key)] : base));
    return indexCache.get(key);
  };
  const allIndex = rivals ? answers.buildAlternativeIndex(cards) : null;
  const canon = (reading) => romaji.canonicalRomaji(reading, { finalN: true });

  // データの中の読み: 答え（字面）→ 主な読み（かな）。読みが書かれていない漢字の別解を、同じ字面を答えにするカードの読みで打つ
  const dataReading = new Map();
  if (!readingOf) {
    for (const [face, { entries }] of readingsByFace(cards, judge)) {
      const primary = romaji.primaryReading(entries);
      if (primary) dataReading.set(face, primary.reading);
    }
  }
  const readingOfText = readingOf ?? ((text) => dataReading.get(faceOf(text)) ?? null);

  // 同じ id のカード（他のカテゴリ）・1 字の訳の語（盤面ごと）
  const byId = new Map();
  for (const w of cards) {
    if (!byId.has(w.id)) byId.set(w.id, []);
    byId.get(w.id).push(w);
  }
  // 1 字の訳 → (en → …)。別解の索引と同じカード・同じ訳の分け方（js/answers.js meaningGroups）で、1 字の訳だけ
  const oneCharCache = new Map();
  const oneCharFor = (w) => {
    const key = w.entry.pack ? w.entry.id : "";
    if (!oneCharCache.has(key)) oneCharCache.set(key, answers.meaningGroups(key ? [...base, ...ctx.cardsOf(key)] : base, { oneChar: true }));
    return oneCharCache.get(key);
  };

  const rows = [];
  const push = (w, mode, input, text, keys, result, sub = "") =>
    rows.push({ ref: w.ref, mode, input, sub, text, keys: keys ?? "", how: result.how, kind: result.kind ?? "", at: result.at ?? 0, expected: result.expected ?? "" });

  for (const w of cards) {
    const { mode, entries } = judge.answerModeOf(w);
    if (w.calc) continue; // 計算カードは出題のたびに答えを作る（js/calcCards.js）。教材の答えは無い
    if (mode === "spell") {
      const cands = answers.acceptedAnswers(w, indexFor(w));
      const accepts = new Set((Array.isArray(w.accept) ? w.accept : []).map((s) => String(s ?? "").toLowerCase().trim()).filter(Boolean));
      push(w, mode, "answer", w.en, w.en, run(judge, w, cands, w.en));
      for (const c of cands.slice(1)) {
        const input = accepts.has(c) ? "accept" : "alt";
        const keys = SPELL_TYPEABLE.test(c) ? c : null;
        push(w, mode, input, c, keys, run(judge, w, cands, keys));
      }
      if (!rivals) continue;
      const own = new Set(cands);
      const seen = new Set();
      const rival = (input, text, sub = "") => {
        const t = String(text ?? "").toLowerCase().trim();
        if (!t || own.has(t) || seen.has(input + "\t" + t)) return;
        seen.add(input + "\t" + t);
        const keys = SPELL_TYPEABLE.test(t) ? t : null;
        push(w, mode, input, t, keys, run(judge, w, cands, keys), sub);
      };
      for (const o of byId.get(w.id) ?? []) {
        if (o === w || o.entry.id === w.entry.id) continue;
        if (judge.answerModeOf(o).mode !== "spell") continue;
        rival("otherPack", o.en, o.entry.id);
        for (const a of Array.isArray(o.accept) ? o.accept : []) rival("otherPack", a, o.entry.id);
      }
      for (const e of allIndex.get(w.en) ?? []) rival("packAlt", e);
      const one = oneCharFor(w);
      const { jaTokens } = ctx.modules.jaAmbiguity;
      if (w.ja && !w.q) {
        for (const t of jaTokens(w.ja)) {
          const k = answers.altKey(t);
          if (k.length !== 1) continue;
          for (const e of one.get(k)?.keys() ?? []) if (e !== w.en) rival("oneChar", e, k);
        }
      }
      continue;
    }
    if (mode === "romaji") {
      const primary = romaji.primaryReading(entries);
      const readings = new Set(entries.map((e) => e.reading));
      for (const e of entries) {
        const keys = canon(e.reading);
        push(w, mode, e === primary ? "answer" : "reading", e.reading, keys, run(judge, w, [], keys));
      }
      const seen = new Set();
      const typeReading = (input, text, reading, sub = "") => {
        if (!reading || readings.has(reading) || seen.has(input + "\t" + reading)) return;
        seen.add(input + "\t" + reading);
        const keys = canon(reading);
        push(w, mode, input, text, keys, run(judge, w, [], keys), sub);
      };
      const ka = kanjiOf(w.en);
      const bound = acceptReadingsOf(w);
      for (const a of Array.isArray(w.accept) ? w.accept : []) {
        if (romaji.isReading(romaji.normalizeReading(a))) continue;
        const kb = kanjiOf(a);
        if (!kb) continue;
        // 結んだ読み（acceptReadings）: 別表記 1 つ・読み 1 つごとに、その読みを打つ（読みの形でなければ untypeable）
        for (const r of bound.get(a) ?? []) {
          const n = romaji.normalizeReading(r);
          const keys = romaji.isReading(n) ? canon(n) : null;
          push(w, mode, "kanjiAccept", a, keys, keys ? run(judge, w, [], keys) : { how: "untypeable", at: 0 }, "bound");
        }
        const reading = readingOfText(a);
        if (!reading) continue;
        const sub = kb === ka ? "same" : ka.startsWith(kb) ? "short" : "other";
        typeReading("kanjiAccept", a, romaji.normalizeReading(reading), sub);
      }
      if (!rivals) continue;
      for (const o of byId.get(w.id) ?? []) {
        if (o === w || o.entry.id === w.entry.id) continue;
        for (const e of judge.romajiEntriesFor(o)) typeReading("otherPack", e.reading, e.reading, o.entry.id);
      }
      continue;
    }
    // 全文入力: 答えとデータの別解を、書かれたとおりに打って Enter
    push(w, mode, "answer", w.en, w.en, run(judge, w, [], w.en));
    for (const a of Array.isArray(w.accept) ? w.accept : []) push(w, mode, "accept", a, a, run(judge, w, [], a));
  }
  return { rows, cards: cards.length, ms: performance.now() - t0 };
}

// 要約: 打つものの種類（と sub）× 結果 → { rows, cards }（カードは pack:id の数）
export function summarize(rows) {
  const out = {};
  for (const r of rows) {
    const k = r.input + (r.input === "kanjiAccept" ? `:${r.sub}` : "");
    const o = (out[k] ??= {});
    const c = (o[r.how] ??= { rows: 0, cards: new Set() });
    c.rows++;
    c.cards.add(r.ref);
  }
  const plain = {};
  for (const [k, o] of Object.entries(out)) plain[k] = Object.fromEntries(Object.entries(o).map(([h, c]) => [h, { rows: c.rows, cards: c.cards.size }]));
  return plain;
}

export function ownFailures(rows) {
  return rows.filter(isOwnFailure);
}

const TSV_HEAD = ["card", "mode", "input", "sub", "text", "keys", "how", "kind", "at", "expected"];
export function toTsv(rows) {
  const cell = (v) => String(v ?? "").replace(/[\t\n]/g, " ");
  return [TSV_HEAD.join("\t"), ...rows.map((r) => [r.ref, r.mode, r.input, r.sub, r.text, r.keys, r.how, r.kind, r.at, r.expected].map(cell).join("\t"))].join("\n") + "\n";
}

// ---- コマンド ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const root = path.resolve(opt("--root") ?? path.join(HERE, "..", ".."));
  const t0 = performance.now();
  const ctx = await loadContext({ root });
  const sim = simulate(ctx); // 判定器は ctx の木の js/judge.js（ctx.modules.judge）
  const fails = ownFailures(sim.rows);
  const summary = {
    cards: sim.cards,
    rows: sim.rows.length,
    ms: Math.round(performance.now() - t0),
    simMs: Math.round(sim.ms),
    byInput: summarize(sim.rows),
    q05: { rows: fails.length, cards: new Set(fails.map((r) => r.ref)).size }
  };
  const tsv = opt("--tsv");
  if (tsv) fs.writeFileSync(tsv, toTsv(sim.rows));
  if (args.includes("--json")) console.log(JSON.stringify(summary, null, 1));
  else {
    console.log(`判定のシミュレーション: ${summary.cards.toLocaleString()} 枚・${summary.rows.toLocaleString()} 件（${(summary.ms / 1000).toFixed(1)} 秒）`);
    for (const [k, o] of Object.entries(summary.byInput)) {
      console.log(`  ${k.padEnd(18)} ${Object.entries(o).map(([h, c]) => `${h} ${c.rows}件/${c.cards}枚`).join("  ")}`);
    }
    console.log(`  Q05（正解になるはずのものが × になる）: ${summary.q05.rows} 件・${summary.q05.cards} 枚`);
    if (tsv) console.log(`  表: ${tsv}`);
  }
}
