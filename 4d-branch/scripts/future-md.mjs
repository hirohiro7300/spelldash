// 未来の道筋のデータ（src/demo/future-data.json）を、読みやすい一覧（docs/future/README.md）に書き出す。
// 10 年後の行き先と見込み（全体・シナリオごと）、節目の状態、節目の間の歩みと分かれ道（判断の線と見込み %）
// 使い方: node scripts/future-md.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "src/demo/future-data.json"), "utf8"));
const OUT_DIR = path.join(ROOT, "docs/future");
const TYPE = { action: "行動", goal: "目標", result: "結果", branch: "分かれ道" };
const LINE = { start: "今日", base: "両立（基本）", early: "早期独立", focus: "SpellDash集中" };
const EFFORT = new Set(["15分", "1時間", "半日", "1日", "1週間", "1か月", "3か月+"]);
const esc = (s) => String(s).replace(/\|/g, "｜").replace(/\n/g, " ");
const pct = (p) => {
  const v = p * 100;
  if (v >= 99.95) return "100%";
  if (v >= 10) return `${Math.round(v)}%`;
  if (v >= 0.95) return `${(Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, "")}%`;
  if (v >= 0.05) return `${v.toFixed(1)}%`;
  return v > 0 ? "0.1% 未満" : "0%";
};

const states = new Map(data.states.map((s) => [s[0], s]));
const steps = new Map(data.steps.map((s) => [s[0], s]));
const title = (k) => states.get(k)?.[3] ?? steps.get(k)?.[2] ?? k;
const next = new Map();
for (const l of data.links) next.set(l[0], [...(next.get(l[0]) ?? []), l]);
const isBranch = (k) => steps.get(k)?.[1] === "branch";

/** start から流した見込み（分かれ道は % の割合で分ける。アプリの計算と同じ） */
function flow(start) {
  const indeg = new Map();
  const seen = new Set([start]);
  const order = [start];
  for (let i = 0; i < order.length; i++) for (const l of next.get(order[i]) ?? []) if (!seen.has(l[1])) (seen.add(l[1]), order.push(l[1]));
  for (const k of seen) indeg.set(k, 0);
  for (const k of seen) for (const l of next.get(k) ?? []) indeg.set(l[1], indeg.get(l[1]) + 1);
  const mass = new Map([[start, 1]]);
  const steps = new Map([[start, [0, 0]]]);
  const ready = [start];
  while (ready.length) {
    const k = ready.pop();
    const m = Math.min(1, mass.get(k) ?? 0);
    const outs = next.get(k) ?? [];
    const total = isBranch(k) ? outs.reduce((n, l) => n + (l[3] ?? 0), 0) : 0;
    const [lo, hi] = steps.get(k);
    for (const l of outs) {
      const w = isBranch(k) && total > 0 ? (l[3] ?? 0) / total : 1;
      mass.set(l[1], (mass.get(l[1]) ?? 0) + m * w);
      const s = steps.get(l[1]);
      steps.set(l[1], s ? [Math.min(s[0], lo + 1), Math.max(s[1], hi + 1)] : [lo + 1, hi + 1]);
      indeg.set(l[1], indeg.get(l[1]) - 1);
      if (indeg.get(l[1]) === 0) ready.push(l[1]);
    }
  }
  return { mass, steps };
}

const root = data.states.find((s) => s[2] === "start")[0];
const all = flow(root);
const ends = data.states.filter((s) => !(next.get(s[0])?.length)).sort((a, b) => (all.mass.get(b[0]) ?? 0) - (all.mass.get(a[0]) ?? 0));
const m6 = data.states.filter((s) => s[1] === 6 && s[2] !== "start");
const byLine = Object.fromEntries(m6.map((s) => [s[2], flow(s[0])]));
const lo = Math.min(...ends.map((e) => all.steps.get(e[0])?.[0] ?? 0));
const hi = Math.max(...ends.map((e) => all.steps.get(e[0])?.[1] ?? 0));
const forks = data.steps.filter((s) => s[1] === "branch").length;

const out = [];
out.push(`# ${data.title}`);
out.push("");
out.push("> 4D Branch のメニュー「未来の道筋（仕事・10 年）を読み込む…」で地図として読み込めるデータの一覧です（`node scripts/future-md.mjs` で `src/demo/future-data.json` から作り直せます）。");
out.push(`> 節目の状態 ${data.states.length}・歩み ${data.steps.length}・分かれ道 ${forks}・10 年後の行き先 ${ends.length}。1 本の道は今日から ${lo}〜${hi} 歩。見込みは分かれ道の % を掛け合わせた値で、アプリでは線の % を直すと計算し直します。`);
out.push("");
out.push("## 10 年後の行き先と見込み");
out.push("");
out.push(`| 行き先 | 見込み | ${m6.map((s) => `${LINE[s[2]]}を選んだ場合`).join(" | ")} |`);
out.push(`| --- | ---: | ${m6.map(() => "---:").join(" | ")} |`);
for (const e of ends) out.push(`| ${esc(e[3])} | ${pct(all.mass.get(e[0]) ?? 0)} | ${m6.map((s) => pct(byLine[s[2]].mass.get(e[0]) ?? 0)).join(" | ")} |`);
out.push("");
out.push("## 節目の状態");
for (const g of [...new Set(data.states.map((s) => s[1]))].sort((a, b) => a - b)) {
  out.push("");
  out.push(`### ${g === 0 ? "今日" : g === 120 ? "10 年後" : `${g} か月後`}`);
  out.push("");
  for (const s of data.states.filter((x) => x[1] === g)) out.push(`- **${esc(s[3])}**（${LINE[s[2]]}・見込み ${pct(all.mass.get(s[0]) ?? 0)}）— ${esc(s[4])}`);
}
out.push("");
out.push("## 節目の間の歩み");
for (const s of data.states) {
  const own = data.steps.filter((x) => x[8] === s[0]);
  if (!own.length) continue;
  // 歩みを、状態からたどった順（本線を先に、寄り道はその分かれ道の後）に並べる
  const order = [];
  const seen = new Set();
  const walk = (k) => {
    for (const l of next.get(k) ?? []) {
      const t = l[1];
      if (seen.has(t) || !steps.has(t) || steps.get(t)[8] !== s[0]) continue;
      seen.add(t);
      order.push(t);
      walk(t);
    }
  };
  walk(s[0]);
  const targets = [...new Set(own.flatMap((x) => (next.get(x[0]) ?? []).map((l) => l[1])).filter((k) => states.has(k)))];
  out.push("");
  out.push(`### ${esc(s[3])} → ${targets.map((k) => esc(title(k))).join("・")}（${s[1]}〜${states.get(targets[0])?.[1] ?? ""} か月目）`);
  out.push("");
  for (const k of order) {
    const st = steps.get(k);
    const effort = st[1] === "action" && EFFORT.has(st[6][0]) ? `・${st[6][0]}` : "";
    const cond = st[7].length ? ` 目安: ${st[7].map(esc).join("／")}` : "";
    out.push(`- [${TYPE[st[1]]}${effort}・${st[4]} か月目] **${esc(st[2])}**${st[3] ? ` — ${esc(st[3])}` : ""}${cond}`);
    if (st[1] === "branch") for (const l of next.get(k) ?? []) out.push(`  - ${l[3]}%｜${esc(l[2])} → ${esc(title(l[1]))}`);
  }
}
out.push("");
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "README.md"), out.join("\n"));
console.log(`docs/future/README.md を作りました（状態 ${data.states.length}・歩み ${data.steps.length}・行き先 ${ends.length}・${lo}〜${hi} 歩）`);
