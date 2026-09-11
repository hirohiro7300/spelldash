// 単語データの機械検証。データ編集後に実行する:
//   node scripts/validate-words.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data", "english");
const PACK_DIR = path.join(ROOT, "data", "packs");
const files = [
  ...fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).map((f) => path.join(DATA_DIR, f)),
  ...(fs.existsSync(PACK_DIR) ? fs.readdirSync(PACK_DIR).filter((f) => f.endsWith(".json")).map((f) => path.join(PACK_DIR, f)) : [])
];
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "manifest.json"), "utf8"));
const manifestCategories = manifest.subjects.flatMap((s) => s.categories);

const problems = [];
const allIds = new Set();
const entries = [];
let total = 0;

for (const fullPath of files) {
  const file = path.relative(path.join(ROOT, "data"), fullPath);
  const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const seen = new Set();
  const isPack = fullPath.startsWith(PACK_DIR);

  // 分野パック: genres が tags[0] を網羅し、manifest の count と一致すること（docs/PACK_FORMAT.md）
  if (isPack) {
    if (!data.genres || typeof data.genres !== "object") problems.push(`genresなし ${file}`);
    if (!data.label || !data.blurb || !data.audience) problems.push(`label/blurb/audienceなし ${file}`);
    if (String(data.blurb ?? "").length > 40) problems.push(`blurbが長い ${file}`);
    const entry = manifestCategories.find((c) => c.id === data.category);
    if (!entry) problems.push(`manifest未登録 ${file} (category=${data.category})`);
    else if (entry.count !== data.words.length) problems.push(`manifestのcount不一致 ${file}: manifest=${entry.count} 実際=${data.words.length}`);
    const answers = new Set();
    const isWordPack = data.cardType === "word"; // レベル別パック（英検・TOEIC）: 英単語 en/ja 形式
    const isGrammar = data.cardType === "grammar"; // 文法パック: 穴埋め（q に ____ を1か所、say に完成文）
    const isSchool = data.cardType === "school"; // 義務教育パック: 日本語で答える。漢字の答えには読み（ひらがな）を accept に
    for (const w of data.words) {
      if (isSchool) {
        const a = String(w.answer ?? "");
        const hasKanji = /[一-龯]/.test(a);
        const hasKana = (w.accept ?? []).some((s) => /^[ぁ-ゖー・\s]+$/.test(String(s).trim()));
        // kanjiOnly: 問題文に読みが書いてある（同音異義語の書き分け・漢文の句法など）ので漢字で答えさせる。読みは accept に入れない
        if (hasKanji && !hasKana && !w.kanjiOnly) problems.push(`読み（ひらがな）が accept にない ${file}:${w.id} (${a})`);
        if (w.kanjiOnly && hasKana) problems.push(`kanjiOnly なのに accept に読みがある ${file}:${w.id}`);
        const q = String(w.q ?? "");
        const leaked = (w.accept ?? []).find((s) => String(s).length >= 2 && q.includes(String(s)));
        if (leaked) problems.push(`別解が問題文に含まれる ${file}:${w.id} (${leaked})`);
        if (String(w.explain ?? "").length > 100) problems.push(`explainが長い ${file}:${w.id}`);
      }
      if (isGrammar) {
        const blanks = (String(w.q ?? "").match(/____/g) || []).length;
        if (blanks !== 1) problems.push(`空欄が1か所でない ${file}:${w.id} (${blanks})`);
        if (!/（.+）/.test(String(w.q ?? ""))) problems.push(`日本語訳（全角カッコ）なし ${file}:${w.id}`);
        if (!w.say || !/^[A-Za-z]/.test(w.say)) problems.push(`sayなし/英文でない ${file}:${w.id}`);
        if (String(w.ja ?? "").length > 20) problems.push(`jaが長い ${file}:${w.id}`);
        if (String(w.answer ?? "").split(/\s+/).length > 4) problems.push(`answerが長い ${file}:${w.id}`);
      }
      if (isWordPack) {
        if (w.kind === "concept") problems.push(`英単語パックにconcept ${file}:${w.id}`);
        if (!w.pos) problems.push(`posなし ${file}:${w.id}`);
        if (String(w.ja ?? "").length > 24) problems.push(`jaが長い ${file}:${w.id} (${w.ja})`);
      } else if (w.kind !== "concept") {
        problems.push(`パックはconceptのみ ${file}:${w.id}`);
      }
      if (data.genres && !(w.tags?.[0] in data.genres)) problems.push(`genres未登録タグ ${file}:${w.id} tag=${w.tags?.[0]}`);
      if (w.answer && w.q && (isGrammar ? new RegExp(`(^|[^A-Za-z])${String(w.answer).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`, "i").test(w.q) : w.q.includes(w.answer))) problems.push(`qに答えが含まれる ${file}:${w.id}`);
      const key = String(isWordPack ? w.en : w.answer ?? "").normalize("NFKC").toLowerCase();
      if (answers.has(key)) problems.push(`${isWordPack ? "en" : "answer"}重複 ${file}:${w.id} (${isWordPack ? w.en : w.answer})`);
      answers.add(key);
    }
  }

  for (const w of data.words) {
    total++;
    const where = `${file}:${w.id}`;

    if (!w.id || !w.en || !w.ja) problems.push(`空フィールド ${where}`);
    if (w.kind === "concept") {
      // 概念カード: id は concept-<key>、answer（打つ答え）と q（場面）が必須
      if (w.id !== `concept-${w.en}`) problems.push(`ID不整合(concept) ${where} (en=${w.en})`);
      if (!/^[a-z][a-z0-9-]*$/.test(w.en ?? "")) problems.push(`キー形式 ${where} en="${w.en}"`);
      if (typeof w.answer !== "string" || !w.answer.trim()) problems.push(`answerなし ${where}`);
      if (typeof w.q !== "string" || w.q.length < 8) problems.push(`qなし/短い ${where}`);
      if (w.accept != null && !Array.isArray(w.accept)) problems.push(`accept形式 ${where}`);
    } else {
      if (w.id !== `english-${w.en}`) problems.push(`ID不整合 ${where} (en=${w.en})`);
      if (!/^[a-z][a-z-]*$/.test(w.en ?? "")) problems.push(`スペル形式 ${where} en="${w.en}"`);
    }
    if (!["easy", "normal", "hard"].includes(w.level)) problems.push(`level不正 ${where}`);
    if (!Array.isArray(w.tags) || w.tags.length === 0) problems.push(`タグなし ${where}`);
    if (seen.has(w.id)) problems.push(`ファイル内重複 ${where}`);
    seen.add(w.id);

    allIds.add(w.id);
    entries.push([file, w]);
  }
}

// Knowledge Map拡張フィールドの整合性
const familyById = new Map();
for (const [file, w] of entries) {
  if (w.family || w.root) {
    const where = `${file}:${w.id}`;
    if (!w.root) problems.push(`familyありrootなし ${where}`);
    if (!Array.isArray(w.family)) {
      problems.push(`family形式 ${where}`);
      continue;
    }
    for (const fid of w.family) {
      if (!allIds.has(fid)) problems.push(`family先が存在しない ${where} -> ${fid}`);
      if (fid === w.id) problems.push(`family自己参照 ${where}`);
    }
    if (new Set(w.family).size !== w.family.length) problems.push(`family重複 ${where}`);

    // 同一IDの全コピーで root/family が一致すること
    const key = w.id;
    const sig = `${w.root}|${[...w.family].sort().join(",")}`;
    if (familyById.has(key) && familyById.get(key) !== sig) {
      problems.push(`コピー間不一致 ${where}`);
    }
    familyById.set(key, sig);
  }
}

// 相互参照: AのfamilyにBがいるなら、BのfamilyにもAがいること
for (const [file, w] of entries) {
  if (!Array.isArray(w.family)) continue;
  for (const fid of w.family) {
    const sig = familyById.get(fid);
    if (sig != null && !sig.includes(w.id)) {
      problems.push(`相互参照欠け ${file}:${w.id} <- ${fid} 側にない`);
    }
  }
}

// 同じ id が別ファイルにあるのは「同一単語の重複掲載」（統計を共有）としてカテゴリ間では許容するが、
// 概念カードは意味が異なりうるので id の衝突を禁止する
{
  const conceptSeen = new Map();
  for (const [file, w] of entries) {
    if (w.kind !== "concept") continue;
    if (conceptSeen.has(w.id) && conceptSeen.get(w.id) !== file) problems.push(`概念カードのid衝突 ${w.id}: ${conceptSeen.get(w.id)} と ${file}`);
    conceptSeen.set(w.id, file);
  }
}

console.log(`words: ${total} / unique ids: ${allIds.size} / family付き: ${familyById.size}`);
if (problems.length === 0) {
  console.log("OK: 問題なし");
} else {
  console.log(`NG: ${problems.length}件`);
  problems.forEach((p) => console.log("  " + p));
  process.exit(1);
}
