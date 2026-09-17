// 例文を単語データに差し込む（1行1語の書式を崩さない）
//   node scripts/add-examples.mjs data/english/business.json examples/business.json
// examples ファイル: { "english-negotiate": { "ex": "We need to negotiate a better price.", "exJa": "もっと良い値段を交渉する必要がある。", "exForm": "negotiate" }, ... }
//   ex     … 英文（70字以内、その語（または exForm の形）を含む）
//   exJa   … 日本語訳（40字以内）
//   exForm … 英文中の語形が見出し語と違うとき（went, better, studies など）。同じなら省略
// 対象ファイルが整形済み（1項目1行）のときは、先に words 配列だけを1行1語に直してから差し込む（内容は変えない）。
import fs from "fs";

const [target, source] = process.argv.slice(2);
if (!target || !source) {
  console.error("usage: node scripts/add-examples.mjs <data json> <examples json>");
  process.exit(1);
}

const examples = JSON.parse(fs.readFileSync(source, "utf8"));
let text = fs.readFileSync(target, "utf8");

// 1行1語か（"id" のある行がその行内で } で閉じているか）
const isOneLinePerWord = (t) => {
  const idLines = t.split("\n").filter((l) => /"id":\s*"/.test(l));
  return idLines.length > 0 && idLines.every((l) => /}\s*,?\s*$/.test(l));
};

if (!isOneLinePerWord(text)) {
  // 先頭のメタ（genres など）は整形のまま、words だけ1行1語に
  const d = JSON.parse(text);
  if (!Array.isArray(d.words)) {
    console.error(`${target}: words 配列が見つかりません`);
    process.exit(1);
  }
  const line = (w) => "    {" + Object.entries(w).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}";
  const headVal = (v) => (v && typeof v === "object" ? JSON.stringify(v, null, 2).replace(/\n/g, "\n  ") : JSON.stringify(v));
  const head = Object.entries(d).filter(([k]) => k !== "words").map(([k, v]) => `  ${JSON.stringify(k)}: ${headVal(v)},`).join("\n");
  const out = `{\n${head}\n  "words": [\n${d.words.map(line).join(",\n")}\n  ]\n}\n`;
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(d)) {
    console.error(`${target}: 1行1語への整形で内容が変わるため中止`);
    process.exit(1);
  }
  text = out;
  console.log(`${target}: words を1行1語の書式に整形（${d.words.length}語）`);
}

const lines = text.split("\n");
let added = 0;
let replaced = 0;
const missing = new Set(Object.keys(examples));

const esc = (s) => JSON.stringify(String(s));

const out = lines.map((line) => {
  const m = line.match(/"id":\s*"([^"]+)"/);
  if (!m || !examples[m[1]]) return line;
  const e = examples[m[1]];
  const tail = line.match(/}\s*,?\s*$/);
  if (!tail) return line; // ここには来ない想定（上で1行1語にしている）
  missing.delete(m[1]);
  // 既存の ex/exJa/exForm を取り除いてから付け直す
  const body = line.replace(/,\s*"ex(?:Ja|Form)?":\s*"(?:[^"\\]|\\.)*"/g, "");
  if (body !== line) replaced++;
  else added++;
  const spaced = /"id":\s"/.test(body); // {"id": ...}（コロンの後に空白）か {"id":...} かに合わせる
  const sep = spaced ? ": " : ":";
  const en = (body.match(/"en":\s*"([^"]+)"/) || [])[1] ?? "";
  const form = e.exForm && String(e.exForm).toLowerCase() !== en.toLowerCase() ? String(e.exForm) : ""; // 見出し語と同じなら不要
  const fields = [`"ex"${sep}${esc(e.ex)}`, `"exJa"${sep}${esc(e.exJa)}`, ...(form ? [`"exForm"${sep}${esc(form)}`] : [])];
  const insertAt = body.lastIndexOf("}");
  return body.slice(0, insertAt) + ", " + fields.join(", ") + body.slice(insertAt);
});

const result = out.join("\n");
const inserted = (result.match(/"exJa"/g) || []).length;
fs.writeFileSync(target, result);
console.log(`${target}: ${added} added, ${replaced} replaced（ファイル内の exJa: ${inserted}）${missing.size ? `, ${missing.size} ids not found: ${[...missing].slice(0, 5).join(", ")}` : ""}`);
if (added + replaced === 0) {
  console.error("何も差し込めませんでした（id が一致しないか、書式が想定外）");
  process.exit(1);
}
