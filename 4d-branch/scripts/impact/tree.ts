// 選択肢と結果の木を組み立てる。
// 1. 全部の手（できるもの）を広げた候補の木を作る（今日 → 一手 → 3 か月後 → 一手 → 1 年後 → 2 年の進め方 → 3 年後）
// 2. 後ろから値を出す（判断では一番良い手、結果は見込みで重みを付けた平均）。値は年収の月給 S で決まる
// 3. 見せる手を選ぶ: 今日は決まった 10 手。3 か月後は今のまま + 3、1 年後は今のまま + 1〜2（一番良い手・別の領域・避けたい手）
// 4. 主な手の種類（独立・週 4 日・Pro・副業・転職）がどれも 12 か所以上に出るようにし、ノード数の上限に収める

import { groupOutcomes, type Outcome } from "./group";
import { driverOf, feasible, simulate, type St, type World } from "./sim";

export type Role = "r" | "a" | "s" | "e";

export interface TNode {
  key: string;
  role: Role;
  /** 判断・結果・行き先はその月。選択肢は選ぶ月 */
  m: number;
  st: St;
  kind?: string;
  out?: Outcome;
  kids: TNode[];
  parent: TNode | null;
  /** その時点から 36 か月目までの稼ぎ（後は一番良い選び方） */
  V: number;
  /** その道を選んだ場合にここへ来る見込み */
  pPath: number;
  /** 判断の段（0: 今日、1: 3 か月後、2: 1 年後） */
  stage: number;
  /** 見せる理由（選択肢） */
  why?: "menu" | "base" | "best" | "area" | "warn" | "third" | "cover" | "fill";
}

export function areaOf(w: World, kind: string): string {
  return w.kinds[kind]!.area;
}

export function familyOf(w: World, kind: string): string {
  return w.kinds[kind]!.family;
}

/** 候補の木を広げる */
export function expand(w: World, S: number): TNode {
  const root: TNode = { key: "r", role: "r", m: 0, st: w.today, kids: [], parent: null, V: 0, pPath: 1, stage: 0 };
  const decide = (node: TNode, si: number) => {
    const stg = w.stages[si]!;
    const m0 = stg.month;
    const L = stg.len;
    const kinds = si === 0 ? w.rootMenu : Object.keys(w.kinds).filter((k) => w.kinds[k]!.stages.includes(m0));
    for (const kind of kinds) {
      if (!feasible(w, node.st, kind, m0, L)) continue;
      const alt: TNode = { key: `${node.key}.${kind}`, role: "a", m: m0, st: node.st, kind, kids: [], parent: node, V: 0, pPath: node.pPath, stage: si };
      node.kids.push(alt);
      const samples = simulate(w, node.st, kind, m0, L);
      const outs = groupOutcomes(w, kind, driverOf(kind, node.st), node.st, m0, L, samples, stg.maxOuts, S);
      for (const o of outs) {
        const end = m0 + L >= w.horizon;
        const child: TNode = { key: `${alt.key}.${o.id}`, role: end ? "e" : "s", m: m0 + L, st: o.st, out: o, kids: [], parent: alt, V: 0, pPath: alt.pPath * (o.p / 100), stage: si + 1 };
        alt.kids.push(child);
        if (!end) decide(child, si + 1);
      }
    }
  };
  decide(root, 0);
  return root;
}

/** 線の稼ぎ（結果の線: 期間の稼ぎ） */
export function edgeW(n: TNode, S: number): number {
  if (!n.out) return 0;
  const r = n.out.r;
  return S * r[0] + r[1] + r[2];
}

/** 見せる手だけで値を出し直す（判断: 一番良い手。同じなら今のまま、次に並びの前） */
export function evaluate(w: World, root: TNode, S: number, shown: (n: TNode) => boolean = () => true): void {
  const visit = (n: TNode): number => {
    if (n.role === "e") {
      n.V = 0;
      return 0;
    }
    if (n.role === "a") {
      let v = 0;
      for (const c of n.kids) v += (c.out!.p / 100) * (edgeW(c, S) + visit(c));
      n.V = v;
      return v;
    }
    let best = -Infinity;
    for (const a of n.kids) {
      if (!shown(a)) continue;
      const q = visit(a);
      if (q > best + 1e-9 || (Math.abs(q - best) <= 1e-9 && a.kind === "keep")) best = q;
    }
    n.V = best === -Infinity ? 0 : best;
    return n.V;
  };
  visit(root);
  void w;
}

export interface Selection {
  shown: Set<TNode>;
  stats: { decisions: number; nodes: number; coverage: Record<string, number>; promoted: number; filled: number; trimmed: number };
}

const isKey = (w: World, kind: string) => w.keyFamilies.includes(familyOf(w, kind));

/** 見せる手を選ぶ（下の段から） */
export function select(w: World, root: TNode, S: number): Selection {
  evaluate(w, root, S);
  const shown = new Set<TNode>();
  const decisions: TNode[] = [];
  const collect = (n: TNode) => {
    if (n.role === "r" || n.role === "s") decisions.push(n);
    for (const k of n.kids) collect(k);
  };
  collect(root);
  const baseOf = (d: TNode) => d.kids.find((a) => a.kind === "keep")!;
  const deltaOf = (d: TNode, a: TNode) => a.V - baseOf(d).V;
  const WARN = -15;
  for (const d of decisions) {
    const alts = d.kids;
    if (d.stage === 0) {
      for (const a of alts) (shown.add(a), (a.why = a.kind === "keep" ? "base" : "menu"));
      continue;
    }
    const base = baseOf(d);
    shown.add(base);
    base.why = "base";
    const others = alts.filter((a) => a !== base).sort((a, b) => b.V - a.V);
    if (!others.length) continue;
    const a1 = others[0]!;
    shown.add(a1);
    a1.why = "best";
    if (d.stage === 1) {
      const a2 = others.find((a) => !shown.has(a) && areaOf(w, a.kind!) !== areaOf(w, a1.kind!)) ?? others.find((a) => !shown.has(a));
      if (a2) (shown.add(a2), (a2.why = "area"));
      const warn = others
        .filter((a) => !shown.has(a) && isKey(w, a.kind!) && deltaOf(d, a) <= WARN)
        .sort((a, b) => a.V - b.V)[0];
      const used = new Set([a1, a2].filter(Boolean).map((a) => areaOf(w, a!.kind!)));
      const a3 = warn ?? others.find((a) => !shown.has(a) && !used.has(areaOf(w, a.kind!))) ?? others.find((a) => !shown.has(a));
      if (a3) (shown.add(a3), (a3.why = warn ? "warn" : "third"));
    }
  }
  // 主な手の種類が出る所を数え、足りなければ、出せる判断のうち来る見込みの高い所に足す
  const coverage = (): Record<string, number> => {
    const cnt: Record<string, number> = {};
    for (const f of w.keyFamilies) cnt[f] = 0;
    for (const d of decisions) {
      const fams = new Set(d.kids.filter((a) => shown.has(a)).map((a) => familyOf(w, a.kind!)));
      for (const f of fams) if (f in cnt) cnt[f]!++;
    }
    return cnt;
  };
  let promoted = 0;
  const maxAlts = (d: TNode) => w.stages[d.stage]!.maxAlts;
  for (const f of w.keyFamilies) {
    let have = coverage()[f]!;
    if (have >= 12) continue;
    const cands = decisions
      .filter((d) => d.stage > 0)
      .map((d) => ({ d, a: d.kids.filter((a) => !shown.has(a) && familyOf(w, a.kind!) === f).sort((x, y) => y.V - x.V)[0] }))
      .filter((x) => x.a && !x.d.kids.some((a) => shown.has(a) && familyOf(w, a.kind!) === f))
      .sort((x, y) => y.d.pPath - x.d.pPath);
    for (const { d, a } of cands) {
      if (have >= 12) break;
      const cur = d.kids.filter((k) => shown.has(k));
      if (cur.length >= maxAlts(d)) {
        // 一番良い手・今のまま・避けたい手以外の最後の手と入れ替える
        const out = cur.filter((k) => k.why !== "base" && k.why !== "best" && k.why !== "warn" && k.why !== "cover").sort((x, y) => x.V - y.V)[0];
        if (!out) continue;
        shown.delete(out);
      }
      shown.add(a!);
      a!.why = "cover";
      promoted++;
      have++;
    }
  }
  // ノード数を数え、上限まで 1 年後の判断に 2 つ目の手を足す（来る見込みの高い判断から）
  const count = () => {
    let n = 0;
    const visit = (x: TNode) => {
      n++;
      for (const k of x.kids) if (x.role === "a" || shown.has(k)) visit(k);
    };
    visit(root);
    return n;
  };
  let nodes = count();
  let filled = 0;
  const d2 = decisions.filter((d) => d.stage === 2).sort((a, b) => b.pPath - a.pPath);
  for (const d of d2) {
    const cur = d.kids.filter((k) => shown.has(k));
    if (cur.length >= maxAlts(d)) continue;
    const a1 = cur.find((k) => k.why === "best");
    const others = d.kids.filter((a) => !shown.has(a) && a.kind !== "keep").sort((a, b) => b.V - a.V);
    const warn = others.filter((a) => isKey(w, a.kind!) && deltaOf(d, a) <= WARN).sort((a, b) => a.V - b.V)[0];
    const pick = warn ?? others.find((a) => !a1 || areaOf(w, a.kind!) !== areaOf(w, a1.kind!)) ?? others[0];
    if (!pick) continue;
    const add = 1 + pick.kids.length;
    if (nodes + add > w.cap.nodes) continue;
    shown.add(pick);
    pick.why = warn ? "warn" : "fill";
    nodes += add;
    filled++;
  }
  // 上限を超えていれば、来る見込みの低い 1 年後の判断から 2 つ目の手を外す
  let trimmed = 0;
  if (nodes > w.cap.nodes) {
    const extra = d2
      .slice()
      .reverse()
      .flatMap((d) => d.kids.filter((k) => shown.has(k) && (k.why === "fill" || k.why === "third" || k.why === "area")));
    for (const a of extra) {
      if (nodes <= w.cap.nodes) break;
      shown.delete(a);
      nodes -= 1 + a.kids.length;
      trimmed++;
    }
  }
  evaluate(w, root, S, (a) => shown.has(a));
  return { shown, stats: { decisions: decisions.length, nodes, coverage: coverage(), promoted, filled, trimmed } };
}

/** 見せる木だけを取り出す（並び: 選択肢は値の高い順で今のままは最後、結果は良い順） */
export function prune(root: TNode, shown: Set<TNode>, S: number): TNode {
  const copy = (n: TNode, parent: TNode | null): TNode => {
    const c: TNode = { ...n, kids: [], parent };
    let kids = n.role === "a" ? n.kids : n.kids.filter((k) => shown.has(k));
    if (n.role === "a") kids = [...kids].sort((a, b) => edgeW(b, S) + b.V - (edgeW(a, S) + a.V));
    else kids = [...kids].sort((a, b) => Number(a.kind === "keep") - Number(b.kind === "keep") || b.V - a.V);
    c.kids = kids.map((k) => copy(k, c));
    return c;
  };
  return copy(root, null);
}
