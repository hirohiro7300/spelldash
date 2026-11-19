// 開発用: 入れ子の木（DevTree）を読むだけの地図（MapData）にする。テストと試し版の最初の版で使う
// 同梱データの読み手（src/demo/impactBundle.ts）と同じ答えを返すこと（並べる順は木のまま・足りない文は仮の文）

import type { ImpactLine, ImpactSt, R3 } from "../../demo/impact";
import type { DevTree, DevTreeNode, MapBand, MapContStep, MapData, MapHeader, MapMix, MapRole, MapTodo, MapWhy } from "../mapData";

const ZERO: R3 = [0, 0, 0];
const NO_TODO: readonly MapTodo[] = Object.freeze([]);

export function fromDevTree(tree: DevTree): MapData {
  const nodes: DevTreeNode[] = [];
  const parents: number[] = [];
  const kids: number[][] = [];
  // 深さ優先（親は子より前・兄弟は木の順）。深い木でも止まらないように手で積む
  const stack: Array<[DevTreeNode, number]> = [[tree.root, -1]];
  while (stack.length) {
    const [n, p] = stack.pop()!;
    const i = nodes.length;
    nodes.push(n);
    parents.push(p);
    kids.push([]);
    if (p >= 0) kids[p]!.push(i);
    const ks = n.kids ?? [];
    for (let k = ks.length - 1; k >= 0; k--) stack.push([ks[k]!, i]);
  }
  const byKey = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (byKey.has(n.k)) throw new Error(`同じ鍵が 2 回あります: ${n.k}`);
    byKey.set(n.k, i);
  });
  const header: MapHeader = tree.header;
  const kindName = (k: string | undefined) => (k ? (header.kinds[k]?.[0] ?? k) : "");
  const isOut = (n: DevTreeNode) => n.r === "s" || n.r === "e";
  const N = (i: number): DevTreeNode => {
    const n = nodes[i];
    if (!n) throw new RangeError(`番号が範囲の外です: ${i}`);
    return n;
  };
  return {
    header,
    n: nodes.length,
    parent: (i) => (N(i), parents[i]!),
    childCount: (i) => (N(i), kids[i]!.length),
    child: (i, k) => {
      const c = (N(i), kids[i]![k]);
      if (c === undefined) throw new RangeError(`子の番号が範囲の外です: ${i}/${k}`);
      return c;
    },
    role: (i): MapRole => N(i).r,
    month: (i) => N(i).m,
    key: (i) => N(i).k,
    indexOfKey: (k) => byKey.get(k) ?? -1,
    kind: (i) => (N(i).r === "a" ? (N(i).kind ?? null) : null),
    hours: (i) => (N(i).r === "a" ? (N(i).h ?? 0) : 0),
    isBase: (i) => N(i).r === "a" && (N(i).base ?? N(i).kind === "keep"),
    why: (i): MapWhy | null => (N(i).r === "a" ? (N(i).why ?? null) : null),
    stub: (i) => N(i).r === "a" && !!N(i).stub,
    q: (i): R3 | null => (N(i).r === "a" ? (N(i).q ?? null) : null),
    todo: (i): readonly MapTodo[] => (N(i).r === "a" ? (N(i).todo ?? NO_TODO) : NO_TODO),
    outId: (i) => (isOut(N(i)) ? (N(i).id ?? "") : ""),
    p: (i) => (isOut(N(i)) ? (N(i).p ?? 100) : 0),
    label: (i) => (isOut(N(i)) ? (N(i).lab ?? N(i).id ?? "") : ""),
    line: (i) => (isOut(N(i)) ? (N(i).line ?? "") : ""),
    ln: (i): ImpactLine | null => (isOut(N(i)) ? (N(i).ln ?? null) : null),
    e: (i): R3 => (isOut(N(i)) ? (N(i).e ?? ZERO) : ZERO),
    rv: (i): [string, string] | null => (isOut(N(i)) ? (N(i).rv ?? null) : null),
    st: (i): ImpactSt => N(i).st,
    rr: (i): R3 => N(i).rr ?? ZERO,
    sum: (i) => N(i).r === "e" && !!N(i).sum,
    band: (i): MapBand | null => N(i).band ?? null,
    mix: (i): MapMix | null => N(i).mix ?? null,
    cont: (i): readonly MapContStep[] | null => N(i).cont ?? null,
    title: (i) => {
      const n = N(i);
      if (n.title) return n.title;
      if (n.r === "r") return "今日";
      if (n.r === "a") return kindName(n.kind);
      return n.lab ?? n.id ?? "";
    },
    short: (i) => N(i).short ?? "",
  };
}
