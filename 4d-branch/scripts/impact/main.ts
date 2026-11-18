// 生成の入口（Vite の SSR で読み込む。src の TypeScript をそのまま使う）
import fs from "node:fs";
import path from "node:path";
import { generate } from "./generate";
import { impactMarkdown } from "./md";
import type { WriterText } from "./bundle";
import { runRate, type World } from "./sim";
import { stateLine, textFor } from "./templates";
import { expand, prune, select, type TNode } from "./tree";

/** 書き手に渡す材料（M1: 今日・今日の手・その結果・3 か月後の手） */
function exportForWriters(world: World, texts: Record<string, WriterText>, file: string): void {
  const S = world.annual / 12;
  const full = expand(world, S);
  const sel = select(world, full, S);
  const tree = prune(full, sel.shown, S);
  const items: Array<Record<string, unknown>> = [];
  const add = (n: TNode, batch: string) => {
    const t = textFor(world, n);
    const parent = n.parent;
    const sib = parent ? parent.kids.filter((k) => k !== n).map((k) => (texts[k.key]?.title ?? textFor(world, k).title)) : [];
    items.push({
      batch,
      key: n.key,
      role: n.role === "r" ? "今日" : n.role === "a" ? "選択肢" : n.role === "s" ? `${n.m} か月後の状態（次の判断）` : "3 年後の行き先",
      month: n.m,
      kind: n.kind ?? null,
      kindLabel: n.kind ? world.kinds[n.kind]!.label : null,
      area: n.kind ? world.kinds[n.kind]!.area : null,
      weeklyHoursDelta: n.kind ? world.kinds[n.kind]!.hours : null,
      periodMonths: n.role === "a" ? world.stages[n.stage]!.len : null,
      state: stateLine(world, n.st),
      stateRaw: n.st,
      runRate: runRate(world, n.st),
      outcome: n.out ? { prob: n.out.p, label: n.out.lab, line: n.out.line } : null,
      parent: parent ? { key: parent.key, title: texts[parent.key]?.title ?? textFor(world, parent).title } : null,
      siblings: sib,
      outcomes: n.role === "a" ? n.kids.map((k) => ({ key: k.key, prob: k.out!.p, label: k.out!.lab, line: k.out!.line, state: stateLine(world, k.st) })) : undefined,
      template: t,
      current: texts[n.key] ?? null,
    });
  };
  const areaBatch = (kind: string) => (["sd_permpro", "sd_grow", "sd_pilot"].includes(kind) ? "W1" : ["fc_switch", "part", "fc_scope", "keep"].includes(kind) ? "W2" : kind === "ind_quit" ? "W4" : "W3");
  add(tree, "W0");
  for (const a of tree.kids) {
    add(a, "W0");
    for (const o of a.kids) {
      add(o, "W0");
      for (const a2 of o.kids) add(a2, areaBatch(a.kind!));
    }
  }
  fs.writeFileSync(file, JSON.stringify({ premises: world.premises, items }, null, 1));
  const cnt = new Map<string, number>();
  for (const it of items) cnt.set(it.batch as string, (cnt.get(it.batch as string) ?? 0) + 1);
  console.log(`書き手の材料: ${items.length} 件（${[...cnt.entries()].map(([k, v]) => `${k} ${v}`).join("・")}）→ ${file}`);
}

export function main(root: string, args: string[]): number {
  const dir = path.join(root, "scripts/impact");
  const world = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8")) as World;
  const texts: Record<string, WriterText> = {};
  const tdir = path.join(dir, "text");
  if (fs.existsSync(tdir)) {
    for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith(".json")).sort()) Object.assign(texts, JSON.parse(fs.readFileSync(path.join(tdir, f), "utf8")));
  }
  const ei = args.indexOf("--export");
  if (ei >= 0) {
    exportForWriters(world, texts, args[ei + 1]!);
    return 0;
  }
  const ai = args.indexOf("--annual");
  const annual = ai >= 0 ? Number(args[ai + 1]) : undefined;
  const t0 = Date.now();
  const res = generate(world, texts, annual ? { annual } : {});
  const out = path.join(dir, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "report.md"), res.report);
  console.log(res.report.split("\n## 失敗")[0]);
  console.log(`失敗 ${res.failures.length}・気になる所 ${res.warnings.length}（${Date.now() - t0} ms）`);
  for (const f of res.failures.slice(0, 30)) console.log("  ✗", f);
  for (const wn of res.warnings.slice(0, 30)) console.log("  !", wn);
  if (res.failures.length) return 1;
  if (!args.includes("--no-write")) {
    fs.writeFileSync(path.join(root, "src/demo/impact-data.json"), JSON.stringify(res.bundle));
    console.log(`書き出し: src/demo/impact-data.json（${(JSON.stringify(res.bundle).length / 1e3).toFixed(0)} KB）`);
    fs.mkdirSync(path.join(root, "docs/future"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/future/README.md"), impactMarkdown(res.bundle));
    console.log("書き出し: docs/future/README.md");
  }
  return 0;
}
