// やりたいことリストのデータ（src/demo/wishlist-data.json）を、読みやすい一覧（docs/wishlist/）に書き出す。
// 領域ごとに 1 枚（GitHub やスマホでも開ける大きさ）と、目次・領域をまたぐつながりの README.md
// 使い方: node scripts/wishlist-md.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "src/demo/wishlist-data.json"), "utf8"));
const OUT_DIR = path.join(ROOT, "docs/wishlist");

const HORIZONS = [
  ["now", "今すぐ（3 か月以内）"],
  ["y1", "1 年以内"],
  ["y3", "3 年以内"],
  ["y5", "5 年以内"],
  ["y10", "いつか（10 年以内）"],
];
const TYPE = { action: "行動", goal: "目標", result: "結果" };
const SCEN = { base: "両立（基本）", early: "早期独立", focus: "SpellDash集中" };
const REL = { supports: "相乗効果", condition: "条件", blocks: "阻害", feedback: "循環" };

const titleOf = new Map();
const areaOf = new Map();
for (const a of data.areas)
  for (const t of a.themes) {
    for (const it of t.items) {
      titleOf.set(it[0], it[2]);
      areaOf.set(it[0], a.name);
    }
    for (const b of t.branches) titleOf.set(b[0], b[1]);
  }
const count = data.areas.reduce((n, a) => n + a.themes.reduce((m, t) => m + t.items.length, 0), 0);
const branches = data.areas.reduce((n, a) => n + a.themes.reduce((m, t) => m + t.branches.length, 0), 0);
const themes = data.areas.reduce((n, a) => n + a.themes.length, 0);
const esc = (s) => s.replace(/\|/g, "｜");

const pad = (i) => String(i + 1).padStart(2, "0");
const fileOf = (i, a) => `${pad(i)}-${a.key}.md`;
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// 目次（README.md）
const index = [];
index.push(`# やりたいことリスト ${count.toLocaleString("ja-JP")}`);
index.push("");
index.push(`> 4D Branch のメニュー「やりたいことリスト（2,000）を読み込む…」で地図として読み込めるデータの一覧です（\`node scripts/wishlist-md.mjs\` で \`src/demo/wishlist-data.json\` から作り直せます）。`);
index.push(`> ${data.areas.length} の領域・${themes} のテーマ・やりたいこと ${count.toLocaleString("ja-JP")} 件・分岐 ${branches} 個・領域をまたぐつながり ${data.links.length} 本。`);
index.push("");
index.push("| 領域 | 件数 | テーマ |");
index.push("| --- | ---: | --- |");
data.areas.forEach((a, i) => {
  const n = a.themes.reduce((m, t) => m + t.items.length, 0);
  index.push(`| [${a.name}](${fileOf(i, a)}) | ${n} | ${a.themes.map((t) => t.name).join("・")} |`);
});

data.areas.forEach((a, i) => {
  const out = [];
  const n = a.themes.reduce((m, t) => m + t.items.length, 0);
  out.push(`# ${a.name}（${n} 件）`);
  out.push("");
  out.push(`${a.description} ／ [目次へ](README.md)`);
  for (const t of a.themes) {
    out.push("");
    out.push(`## ${t.name} — ${t.hubTitle}`);
    out.push("");
    out.push(t.hubBody);
    for (const [h, label] of HORIZONS) {
      const items = t.items.filter((it) => it[4] === h);
      if (!items.length) continue;
      out.push("");
      out.push(`**${label}**`);
      out.push("");
      for (const it of items) {
        const after = it[6].length ? `（先に: ${it[6].map((x) => titleOf.get(x) ?? x).join("、")}）` : "";
        const cond = it[7].length ? ` 目安: ${it[7].join("／")}` : "";
        out.push(`- [${TYPE[it[1]]}] **${esc(it[2])}** — ${esc(it[3])}${cond}${after}`);
      }
    }
    if (t.branches.length) {
      out.push("");
      out.push("**分岐**");
      out.push("");
      for (const b of t.branches) {
        out.push(`- **${esc(b[1])}** — ${esc(b[2])}`);
        for (const [to, when, scen] of b[6]) out.push(`  - ${esc(when)} → ${esc(titleOf.get(to) ?? to)}${scen ? `（シナリオ: ${SCEN[scen]}）` : ""}`);
      }
    }
  }
  out.push("");
  fs.writeFileSync(path.join(OUT_DIR, fileOf(i, a)), out.join("\n"));
});

if (data.links.length) {
  index.push("");
  index.push("## 領域をまたぐつながり");
  index.push("");
  index.push("| 関係 | から | へ | 言葉 |");
  index.push("| --- | --- | --- | --- |");
  for (const [from, to, rel, label] of data.links) index.push(`| ${REL[rel] ?? rel} | ${esc(titleOf.get(from) ?? from)}（${areaOf.get(from)}） | ${esc(titleOf.get(to) ?? to)}（${areaOf.get(to)}） | ${esc(label)} |`);
}
index.push("");
fs.writeFileSync(path.join(OUT_DIR, "README.md"), index.join("\n"));
console.log(`docs/wishlist/ に ${data.areas.length + 1} 枚を作りました（${count} 件）`);
