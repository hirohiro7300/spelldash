// 単語データの機械検証。データ編集後に実行する:
//   node scripts/validate-words.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "english");
const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));

const problems = [];
const allIds = new Set();
const entries = [];
let total = 0;

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
  const seen = new Set();

  for (const w of data.words) {
    total++;
    const where = `${file}:${w.id}`;

    if (!w.id || !w.en || !w.ja) problems.push(`空フィールド ${where}`);
    if (w.id !== `english-${w.en}`) problems.push(`ID不整合 ${where} (en=${w.en})`);
    if (!/^[a-z][a-z-]*$/.test(w.en ?? "")) problems.push(`スペル形式 ${where} en="${w.en}"`);
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

console.log(`words: ${total} / unique ids: ${allIds.size} / family付き: ${familyById.size}`);
if (problems.length === 0) {
  console.log("OK: 問題なし");
} else {
  console.log(`NG: ${problems.length}件`);
  problems.forEach((p) => console.log("  " + p));
  process.exit(1);
}
