// 生成パック（NGSL / TSL / BSL）の見出しを中身に合わせる。
//   node scripts/normalize-packs.mjs
// 執筆時に品詞を直すとジャンル（tags[0]）の構成が変わるので、genres を実際に使われているものだけにする。
// 使われていないジャンルが残るとパック紹介ページに「0語のジャンル」が出てしまう。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "data", "packs");
const GENRES = { n: "名詞", v: "動詞", adj: "形容詞・副詞", fn: "機能語（前置詞・接続詞・代名詞など）" };

let fixed = 0;
for (const f of fs.readdirSync(DIR).sort()) {
  if (!/^(ngsl|tsl|bsl)\d+\.json$/.test(f)) continue;
  const file = path.join(DIR, f);
  const text = fs.readFileSync(file, "utf8");
  const data = JSON.parse(text);
  const used = new Set(data.words.map((w) => w.tags?.[0]));
  const want = Object.fromEntries(Object.entries(GENRES).filter(([k]) => used.has(k)));
  if (JSON.stringify(want) === JSON.stringify(data.genres)) continue;
  // 見出しだけ差し替える（words の1行1語の書式は崩さない）
  const before = JSON.stringify(data.genres, null, 2).split("\n").map((l, i) => (i === 0 ? l : "  " + l)).join("\n");
  const after = JSON.stringify(want, null, 2).split("\n").map((l, i) => (i === 0 ? l : "  " + l)).join("\n");
  const next = text.replace(`"genres": ${before}`, `"genres": ${after}`);
  if (next === text) {
    console.error(`書き換えできず: ${f}（genres の書式が想定と違う）`);
    continue;
  }
  fs.writeFileSync(file, next);
  console.log(`${f}: ${Object.keys(data.genres).join(",")} → ${Object.keys(want).join(",")}`);
  fixed++;
}
console.log(`genres を整えたパック: ${fixed}`);
