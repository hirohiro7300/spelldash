// M2 の書き手の点検: M1 の文章と、渡した組の文章だけを入れて作り、失敗・気になる所をすべて出す（ほかの組の書きかけを混ぜない）
import fs from "node:fs";
import path from "node:path";
import type { WriterText } from "./bundle";
import { generate } from "./generate";
import type { World } from "./sim";

const len = (s: string) => [...s].length;

interface BatchItem {
  key: string;
  role: string;
  month: number;
  kind?: { id: string };
  plans?: BatchItem[];
  ends?: BatchItem[];
}

export function checkBatch(root: string, batchFile: string, textFiles: string[]): number {
  const dir = path.join(root, "scripts/impact");
  const world = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8")) as World;
  const texts: Record<string, WriterText> = {};
  const tdir = path.join(dir, "text");
  for (const f of fs.readdirSync(tdir).filter((x) => /^m1-.*\.json$/.test(x)).sort()) Object.assign(texts, JSON.parse(fs.readFileSync(path.join(tdir, f), "utf8")));
  const mine: Record<string, WriterText> = {};
  for (const f of textFiles) Object.assign(mine, JSON.parse(fs.readFileSync(f, "utf8")));
  Object.assign(texts, mine);
  // 組の中のノード（役割つき）
  const batch = JSON.parse(fs.readFileSync(batchFile, "utf8")) as { monthThreeOptions: Array<{ states: BatchItem[] }> };
  const want = new Map<string, "s" | "a" | "e">();
  for (const g of batch.monthThreeOptions)
    for (const s of g.states) {
      want.set(s.key, "s");
      for (const p of s.plans ?? []) {
        want.set(p.key, "a");
        for (const e of p.ends ?? []) want.set(e.key, "e");
      }
    }
  const problems: string[] = [];
  const missing = [...want.keys()].filter((k) => !mine[k]);
  const extra = Object.keys(mine).filter((k) => !want.has(k));
  if (missing.length) problems.push(`✗ 書いていないノード ${missing.length} 件: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}`);
  if (extra.length) problems.push(`✗ この組に無いキー ${extra.length} 件: ${extra.slice(0, 20).join(", ")}`);
  for (const [key, t] of Object.entries(mine)) {
    const role = want.get(key);
    if (!role) continue;
    const title = t.title ?? "";
    const body = t.body ?? "";
    if (!title || !body) problems.push(`✗ title・body のどちらかが無い: ${key}`);
    if (t.todo) problems.push(`✗ やること（todo）はこの段には付けない: ${key}`);
    if (role === "s" && !title.startsWith("1 年後:")) problems.push(`✗ 1 年後の状態のタイトルは「1 年後:」で始める: ${key}「${title}」`);
    if (role === "e" && !title.startsWith("3 年後:")) problems.push(`✗ 行き先のタイトルは「3 年後:」で始める: ${key}「${title}」`);
    if (role === "a" && /^(1|3) 年後:/.test(title)) problems.push(`✗ 進め方のタイトルは手（動詞）で始める: ${key}「${title}」`);
    const [lo, hi] = role === "s" ? [30, 70] : role === "a" ? [40, 80] : [60, 120];
    const n = len(body);
    if (n < lo || n > hi + 10) problems.push(`! 本文の長さ ${n} 字（${lo}〜${hi}）: ${key}`);
    if (t.label !== undefined && len(t.label) > 10) problems.push(`! 線の名前が長い（${len(t.label)}）: ${key}「${t.label}」`);
    if (role === "a" && t.label !== undefined) problems.push(`✗ 進め方に label は付けない: ${key}`);
  }
  const res = generate(world, texts, {});
  console.log(`この組の文章: ${Object.keys(mine).length} 件（組のノード ${want.size} 件）`);
  console.log(`生成の点検: 失敗 ${res.failures.length}・気になる所 ${res.warnings.length}`);
  for (const x of res.failures) console.log("  ✗", x);
  for (const x of res.warnings) console.log("  !", x);
  console.log(`形の点検: ${problems.length} 件`);
  for (const x of problems) console.log("  ", x);
  const clean = !res.failures.length && !res.warnings.length && !problems.length;
  console.log(clean ? "結果: きれい" : "結果: 直す所あり");
  return clean ? 0 : 1;
}
