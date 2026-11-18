// 書き手に渡す材料（M2: 1 年後の状態・2 年の進め方・3 年後の行き先）。3 か月後の状態ごとに 1 組（21 組）
import fs from "node:fs";
import path from "node:path";
import type { WriterText } from "./bundle";
import { runRate, type World } from "./sim";
import { stateLine, textFor } from "./templates";
import { expand, prune, select, type TNode } from "./tree";

/** 組（B01〜B21）と 3 か月後の状態の対応（文章のファイル text/m2-Bxx.json の名前と同じ） */
const BATCH_KEYS = [
  "r.ad_permside.a0_a1",
  "r.ad_permside.s",
  "r.ad_permside.n",
  "r.sd_permpro.a",
  "r.sd_permpro.s",
  "r.sd_permpro.n",
  "r.fc_switch.high",
  "r.fc_switch.mid",
  "r.fc_switch.none",
  "r.sd_pilot.yes",
  "r.sd_pilot.no",
  "r.sd_grow.all",
  "r.fc_scope.all",
  "r.ad_portfolio.yes",
  "r.ad_portfolio.no",
  "r.part.e",
  "r.part.p",
  "r.ind_quit.cl2",
  "r.ind_quit.cl1",
  "r.ind_quit.cl0",
  "r.keep.all",
];

export function exportM2(root: string, file: string): void {
  const dir = path.join(root, "scripts/impact");
  const world = JSON.parse(
    fs.readFileSync(path.join(dir, "world.json"), "utf8"),
  ) as World;
  const texts: Record<string, WriterText> = {};
  const tdir = path.join(dir, "text");
  if (fs.existsSync(tdir))
    for (const f of fs
      .readdirSync(tdir)
      .filter((x) => x.endsWith(".json"))
      .sort())
      Object.assign(
        texts,
        JSON.parse(fs.readFileSync(path.join(tdir, f), "utf8")),
      );
  const S = world.annual / 12;
  const full = expand(world, S);
  const sel = select(world, full, S);
  const tree = prune(full, sel.shown, S);
  const title = (n: TNode): string =>
    texts[n.key]?.title ?? textFor(world, n).title;
  const body = (n: TNode): string =>
    texts[n.key]?.body ?? textFor(world, n).body;
  const roleName = (n: TNode): string =>
    n.role === "a"
      ? "2 年の進め方（1 年後の選択肢）"
      : n.role === "s"
        ? "1 年後の状態（次の判断）"
        : "3 年後の行き先";
  const items: Array<Record<string, unknown>> = [];
  const batches: Array<{
    batch: string;
    key: string;
    title: string;
    rootOption: string;
    count: number;
  }> = [];
  const pathOf = (
    n: TNode,
  ): Array<{
    key: string;
    role: string;
    month: number;
    title: string;
    label?: string;
    body: string;
  }> => {
    const list: TNode[] = [];
    for (let p = n.parent; p; p = p.parent) list.unshift(p);
    return list.map((p) => ({
      key: p.key,
      role: p.role,
      month: p.m,
      title: title(p),
      ...(p.out ? { label: p.out.lab } : {}),
      body: body(p),
    }));
  };
  const add = (n: TNode, batch: string) => {
    const t = textFor(world, n);
    const parent = n.parent;
    const sib = parent
      ? parent.kids.filter((k) => k !== n).map((k) => title(k))
      : [];
    const kind = n.kind ? world.kinds[n.kind] : undefined;
    items.push({
      batch,
      key: n.key,
      role: roleName(n),
      month: n.m,
      kind: n.kind ?? null,
      kindLabel: kind?.label ?? null,
      area: kind?.area ?? null,
      weeklyHoursDelta: kind?.hours ?? null,
      periodMonths: n.role === "a" ? world.stages[n.stage]!.len : null,
      state: stateLine(world, n.st),
      stateRaw: n.st,
      runRate: runRate(world, n.st),
      outcome: n.out
        ? { prob: n.out.p, label: n.out.lab, line: n.out.line }
        : null,
      path: pathOf(n),
      parent: parent ? { key: parent.key, title: title(parent) } : null,
      siblings: sib,
      outcomes:
        n.role === "a"
          ? n.kids.map((k) => ({
              key: k.key,
              prob: k.out!.p,
              label: k.out!.lab,
              line: k.out!.line,
              state: stateLine(world, k.st),
            }))
          : undefined,
      template: t,
      current: texts[n.key] ?? null,
    });
  };
  // 組の番号は 3 か月後の状態ごとに決めておく（値で並びが変わっても、書いた文章のファイル m2-Bxx.json と合うように）
  const subtrees = tree.kids.flatMap((a) => a.kids.map((o) => ({ a, o })));
  const order = (k: string) => {
    const i = BATCH_KEYS.indexOf(k);
    return i < 0 ? BATCH_KEYS.length : i;
  };
  subtrees.sort(
    (x, y) => order(x.o.key) - order(y.o.key) || (x.o.key < y.o.key ? -1 : 1),
  );
  let extra = BATCH_KEYS.length;
  for (const { a, o } of subtrees) {
    const i = BATCH_KEYS.indexOf(o.key);
    const batch = `B${String(i < 0 ? ++extra : i + 1).padStart(2, "0")}`;
    const before = items.length;
    const walk = (n: TNode) => {
      if (n.m >= 12) add(n, batch);
      for (const k of n.kids) walk(k);
    };
    for (const a2 of o.kids) for (const k of a2.kids) walk(k);
    batches.push({
      batch,
      key: o.key,
      title: title(o),
      rootOption: title(a),
      count: items.length - before,
    });
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ premises: world.premises, batches, items }, null, 1),
  );
  console.log(`M2 の材料: ${items.length} 件・${batches.length} 組 → ${file}`);
  for (const x of batches)
    console.log(`  ${x.batch} ${x.count} 件  ${x.rootOption} → ${x.title}`);
}
