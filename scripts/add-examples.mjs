// 例文を単語データに差し込む（1行1語の書式を崩さない）
//   node scripts/add-examples.mjs data/english/business.json examples/business.json
// examples ファイル: { "english-negotiate": { "ex": "We need to negotiate a better price.", "exJa": "もっと良い値段を交渉する必要がある。", "exForm": "negotiate" }, ... }
//   ex     … 英文（70字以内、その語（または exForm の形）を含む）
//   exJa   … 日本語訳（40字以内）
//   exForm … 英文中の語形が見出し語と違うとき（went, better, studies など）。同じなら省略
import fs from "fs";

const [target, source] = process.argv.slice(2);
if (!target || !source) {
  console.error("usage: node scripts/add-examples.mjs <data json> <examples json>");
  process.exit(1);
}

const examples = JSON.parse(fs.readFileSync(source, "utf8"));
const lines = fs.readFileSync(target, "utf8").split("\n");
let added = 0;
let replaced = 0;
const missing = new Set(Object.keys(examples));

const esc = (s) => JSON.stringify(String(s));

const out = lines.map((line) => {
  const m = line.match(/"id":\s*"([^"]+)"/);
  if (!m || !examples[m[1]]) return line;
  const e = examples[m[1]];
  missing.delete(m[1]);
  // 既存の ex/exJa/exForm を取り除いてから付け直す
  let body = line.replace(/,\s*"ex(?:Ja|Form)?":\s*"(?:[^"\\]|\\.)*"/g, "");
  if (body !== line) replaced++;
  else added++;
  const tail = body.match(/}\s*,?\s*$/);
  if (!tail) return line;
  const spaced = /"id":\s"/.test(body); // {"id": ...}（コロンの後に空白）か {"id":...} かに合わせる
  const sep = spaced ? ": " : ":";
  const en = (body.match(/"en":\s*"([^"]+)"/) || [])[1] ?? "";
  const form = e.exForm && String(e.exForm).toLowerCase() !== en.toLowerCase() ? String(e.exForm) : ""; // 見出し語と同じなら不要
  const fields = [`"ex"${sep}${esc(e.ex)}`, `"exJa"${sep}${esc(e.exJa)}`, ...(form ? [`"exForm"${sep}${esc(form)}`] : [])];
  const insertAt = body.lastIndexOf("}");
  return body.slice(0, insertAt) + ", " + fields.join(", ") + body.slice(insertAt);
});

fs.writeFileSync(target, out.join("\n"));
console.log(`${target}: ${added} added, ${replaced} replaced${missing.size ? `, ${missing.size} ids not found: ${[...missing].slice(0, 5).join(", ")}` : ""}`);
