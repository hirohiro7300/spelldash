// 3 年の影響のエンジンが葉を足す・消すだけで直した形と数（src/model/impactSplice.ts）が、文書から最初から作った物
// （compileDocTopo + fillNums + fillStatus）と番号・並び・数まで同じかを比べる道具（作業メモ SPEC v1 §7.1 の 1・perf-4）

import { compileDocTopo, fillNums, fillStatus, type Nums, type Topo } from "../../../src/model/impactGraph";
import type { ImpactEngine } from "../../../src/model/impactEngine";
import type { DocData, ID } from "../../../src/model/types";

type Arr = ArrayLike<unknown>;

/** 2 つの並びが要素まで同じか（数は Object.is: NaN も -0 も区別する）。違えば最初の所を書いた文字列 */
function diffArr(name: string, a: Arr, b: Arr): string | null {
  if (a.length !== b.length) return `${name}: 長さ ${a.length} ≠ ${b.length}`;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return `${name}[${i}]: ${String(a[i])} ≠ ${String(b[i])}`;
  return null;
}

/** 形の違い（無ければ空） */
export function topoDiff(a: Topo, b: Topo): string[] {
  const out: string[] = [];
  const push = (x: string | null) => x && out.push(x);
  push(a.n === b.n ? null : `n: ${a.n} ≠ ${b.n}`);
  push(a.scopeSize === b.scopeSize ? null : `scopeSize: ${a.scopeSize} ≠ ${b.scopeSize}`);
  push(a.merges === b.merges ? null : `merges: ${a.merges} ≠ ${b.merges}`);
  for (const k of ["ids", "rootIds", "roots", "off", "tgt", "src", "eid", "incOff", "incSlot", "firstParent"] as const) push(diffArr(k, a[k] as Arr, b[k] as Arr));
  push(diffArr("loose", [...a.loose].sort(), [...b.loose].sort()));
  push(diffArr("tgtLoose", [...a.tgtLoose].map(([s, id]) => `${s}:${id}`).sort(), [...b.tgtLoose].map(([s, id]) => `${s}:${id}`).sort()));
  if (a.idx.size !== b.idx.size) out.push(`idx.size: ${a.idx.size} ≠ ${b.idx.size}`);
  else for (const [id, i] of b.idx) if (a.idx.get(id) !== i) {
    out.push(`idx ${id}: ${a.idx.get(id)} ≠ ${i}`);
    break;
  }
  return out;
}

/** 数の違い（無ければ空） */
export function numsDiff(a: Nums, b: Nums): string[] {
  const out: string[] = [];
  if (a.H !== b.H) out.push(`H: ${a.H} ≠ ${b.H}`);
  if (a.likeBasis !== b.likeBasis) out.push(`likeBasis: ${a.likeBasis} ≠ ${b.likeBasis}`);
  for (const k of ["kind", "t", "rr", "w", "er", "base", "rank", "isBase", "noData", "fam", "rvKey", "rvCat", "q", "stub", "sum"] as const) {
    const x = diffArr(k, a[k] as Arr, b[k] as Arr);
    if (x) out.push(x);
  }
  return out;
}

/**
 * エンジンの今の形・数・状態（result を呼んだ後）を、文書から最初から作った物と比べる。違いの説明の並び（同じなら空）。
 * out は文書の索引の出る線、roots は 3 年の分かれ道の入口（文書の順。ViewModel が渡す物と同じ）
 */
export function engineGraphDiff(engine: ImpactEngine, doc: DocData, out: Map<ID, ID[]>, roots?: readonly ID[]): string[] {
  const g = engine.graph;
  const fresh = compileDocTopo(doc, out, roots);
  if (!fresh || !g.topo) return fresh || g.topo ? [`形の有無: ${!!g.topo} ≠ ${!!fresh}`] : [];
  const diff = topoDiff(g.topo, fresh.topo);
  if (diff.length) return diff;
  if (!g.nums) return ["数が無い"];
  const nd = numsDiff(g.nums, fillNums(fresh.topo, fresh.seen));
  if (nd.length) return nd;
  const st = g.stat ? diffArr("stat", g.stat, fillStatus(fresh.topo, fresh.seen)) : "状態が無い";
  if (st) return [st];
  // 覚えている文書の物が今の文書の物（変わったかを比べる元）
  const so = g.seen ? diffArr("nodeObj", g.seen.nodeObj, fresh.seen.nodeObj) ?? diffArr("edgeObj", g.seen.edgeObj, fresh.seen.edgeObj) : "文書の物が無い";
  return so ? [so] : [];
}
