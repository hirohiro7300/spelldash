// 選んだ木を同梱データ（src/demo/impact-data.json の形）にする。文章は型から作り、書き手の文章（鍵ごと）があれば上書きする。

import { IMPACT_TITLE, type ImpactAltX, type ImpactBNode, type ImpactBundle, type ImpactLine, type ImpactOutX, type ImpactRootX, type ImpactSt } from "../../src/demo/impact";
import type { Line } from "./group";
import { round2, round4, runRate, type St, type World } from "./sim";
import { textFor } from "./templates";
import { edgeW, type TNode } from "./tree";

export type { ImpactBundle };

/** 書き手の文章（鍵ごと）: タイトル・短い名前・本文・結果の名前・やること */
export interface WriterText {
  title?: string;
  short?: string;
  body?: string;
  label?: string;
  todo?: string[];
}

export function stOut(s: St): ImpactSt {
  return { j: s.j, pm: s.pm, pro: s.pro, mau: round2(s.mau), pu: round2(s.pu), seats: s.seats, cl: round4(s.cl), fee: round2(s.fee), sal: round4(s.sal), cv: round4(s.cv), fl: [...s.fl] };
}

function lnOut(l: Line): ImpactLine {
  return l.cat !== undefined ? [l.metric, l.at, l.lo, l.hi, l.cat] : [l.metric, l.at, l.lo, l.hi];
}

/** 後ろから値を出す（sq: どの判断でも今のまま） */
export function rollback(n: TNode, S: number, sq: boolean): number {
  if (n.role === "e") return 0;
  if (n.role === "a") return n.kids.reduce((v, c) => v + (c.out!.p / 100) * (edgeW(c, S) + rollback(c, S, sq)), 0);
  if (sq) {
    const base = n.kids.find((a) => a.kind === "keep");
    if (base) return rollback(base, S, sq);
  }
  return Math.max(...n.kids.map((a) => rollback(a, S, sq)));
}

export function buildBundle(w: World, tree: TNode, texts: Record<string, WriterText>, annual: number): ImpactBundle {
  const nodes: ImpactBNode[] = [];
  const visit = (n: TNode, parent: number) => {
    const i = nodes.length;
    const base = textFor(w, n);
    const t = { ...base, ...(texts[n.key] ?? {}) };
    let x: ImpactRootX | ImpactAltX | ImpactOutX;
    if (n.role === "r") x = { st: stOut(n.st), rr: runRate(w, n.st) };
    else if (n.role === "a") {
      const ax: ImpactAltX = { k: n.kind!, h: w.kinds[n.kind!]!.hours, len: w.stages[n.stage]!.len };
      if (n.kind === "keep") ax.base = 1;
      if (t.todo?.length) ax.todo = t.todo;
      x = ax;
    } else {
      const o = n.out!;
      x = { p: o.p, lab: t.label ?? o.lab, line: o.line, ln: lnOut(o.ln), r: o.r, st: stOut(n.st), rr: runRate(w, n.st) };
    }
    nodes.push([n.key, parent, n.role, n.m, t.title, t.short, t.body, x]);
    for (const k of n.kids) visit(k, i);
  };
  visit(tree, -1);
  const S = annual / 12;
  const kinds: ImpactBundle["kinds"] = {};
  for (const [k, d] of Object.entries(w.kinds)) kinds[k] = [d.label, d.area, d.family, d.scen];
  const keepQ = rollback(tree.kids.find((a) => a.kind === "keep")!, S, false);
  const rootDelta: Record<string, number> = {};
  for (const a of tree.kids) rootDelta[a.kind!] = Math.round((rollback(a, S, false) - keepQ) * 100) / 100;
  const kidsCount = new Map<number, number>();
  nodes.forEach((n) => kidsCount.set(n[1], (kidsCount.get(n[1]) ?? 0) + 1));
  const counts = {
    nodes: nodes.length,
    decisions: nodes.filter((n, i) => (n[2] === "r" || n[2] === "s") && (kidsCount.get(i) ?? 0) >= 2).length,
    options: nodes.filter((n) => n[2] === "a").length,
    forks: nodes.filter((_n, i) => (kidsCount.get(i) ?? 0) >= 2).length,
    ends: nodes.filter((n) => n[2] === "e").length,
  };
  return {
    v: 2,
    kind: "impact3y",
    title: IMPACT_TITLE,
    annual,
    horizon: w.horizon,
    kinds,
    premises: w.premises,
    nodes,
    check: { annual, vRoot: Math.round(rollback(tree, S, false) * 100) / 100, vSQ: Math.round(rollback(tree, S, true) * 100) / 100, rootDelta, counts },
  };
}
