// 反証の手がかり（CI では流さない。docs/PACK_FORMAT.md「別表記の読み」）: 漢字の別表記に結んだ読み（acceptReadings）を、
// データの中の漢字の読みの表（scripts/quality/kanjiReadings.mjs。答えと主な読みの組から作る。辞書は使わない）で裏付け、
// 裏付けの無い組（どれかの漢字が、データに出てきた読みで並べられない）を 1 行ずつ出す。
//   node scripts/quality/review-readings.mjs                    この木の全カード
//   node scripts/quality/review-readings.mjs --base=<木>        その木（PR の向け先）と比べて変わったカードの組だけ
//   node scripts/quality/review-readings.mjs --only=<カテゴリ,…> そのカテゴリだけ
//   node scripts/quality/review-readings.mjs --root=<木>        別の木の data/ と js/ で流す
// 1 行は「<カード>\t<別表記> ← <読み>\t裏付けの無い字: 字=かな・…」。
// 規則にはしない: 正しい読みでも、データに無い音なら出る（頼朝 の 朝＝とも・大山古墳 の 山＝せん・古文の訓）。反証役が 1 行ずつ見る一覧
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContext, ROOT } from "./ctx.mjs";
import { acceptReadingsOf } from "./common.mjs";
import { buildTable, supported } from "./kanjiReadings.mjs";

const KANJI = /[㐀-鿿々〆]/;

// ctx の教材で表を作り、結んだ組を裏付ける。refs（Set）・only（Set: カテゴリ id）があればそのカードだけ出す
// → { pairs: 表の材料の組の数, checked: 見た組の数, rows: [{ card, alt, reading, bad: [{ k, kana }] }] }
export function reviewReadings(ctx, { refs = null, only = null } = {}) {
  const R = ctx.modules.romaji;
  const { romajiEntriesFor } = ctx.modules.judge;
  const pairs = [];
  for (const w of ctx.cards) {
    const entries = romajiEntriesFor(w);
    if (!entries.length || !KANJI.test(String(w.raw.answer ?? ""))) continue;
    const p = R.primaryReading(entries.filter((x) => R.hasKana(x.reading)));
    if (p) pairs.push({ face: w.raw.answer, reading: p.reading });
  }
  const table = buildTable(pairs);
  const rows = [];
  let checked = 0;
  for (const w of ctx.cards) {
    if (refs && !refs.has(w.ref)) continue;
    if (only && !only.has(w.entry.id)) continue;
    for (const [alt, list] of acceptReadingsOf(w)) {
      for (const r of list) {
        const n = R.normalizeReading(r);
        if (!R.isReading(n) || !R.hasKana(n)) continue; // 形の誤りは Q04・validate-words
        checked++;
        const s = supported(table, alt, n);
        if (!s.ok) rows.push({ card: w.ref, alt, reading: r, bad: s.bad ?? [] });
      }
    }
  }
  return { pairs: pairs.length, checked, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const unknown = args.filter((a) => !["root", "base", "only"].some((k) => a.startsWith(`--${k}=`)));
  if (unknown.length) {
    console.error(`知らない引数: ${unknown.join(" ")}（使い方は scripts/quality/review-readings.mjs の先頭）`);
    process.exit(2);
  }
  const root = path.resolve(opt("root") ?? ROOT);
  const ctx = await loadContext({ root });
  let refs = null;
  if (opt("base")) {
    const { changedRefs } = await import("./check.mjs");
    const baseCtx = await loadContext({ root, dataRoot: path.resolve(opt("base")) });
    refs = changedRefs(baseCtx, ctx);
  }
  const only = opt("only") ? new Set(opt("only").split(",").filter(Boolean)) : null;
  const { pairs, checked, rows } = reviewReadings(ctx, { refs, only });
  for (const r of rows) console.log(`${r.card}\t${r.alt} ← ${r.reading}\t裏付けの無い字: ${r.bad.map((b) => `${b.k}=${b.kana}`).join("・") || "（並べ方なし）"}`);
  console.log(`結んだ組 ${checked}・裏付けの無い組 ${rows.length}（カード ${new Set(rows.map((r) => r.card)).size} 枚。表の材料は答えと主な読み ${pairs} 組${refs ? `。前の木と比べて変わったカード ${refs.size} 枚だけ` : ""}）`);
}
