// 見え方の計算（src/app/viewModel.ts）が、葉を足す・消すだけの変更でたどり直さずに直した物（範囲・木・自分のノードの入口・見込み）を、
// 最初から作った物と比べる道具（tests/unit/structEdits.test.ts・viewModelSlow.test.ts。作業メモ SPEC v1 §7.1 の 5・6、perf-4）

import type { ViewModel } from "../../../src/app/viewModel";
import type { ForecastResult } from "../../../src/model/forecast";
import type { ID } from "../../../src/model/types";

/** 見え方の計算の中（確かめ用に、外から読む） */
interface VmInside {
  scopeCache: unknown;
  treeCache: unknown;
  userCache: unknown;
  scopeInfo(): { order: ID[]; pos: Map<ID, number>; rootOf: Int32Array; depth: Int32Array; parent: Int32Array; parentEdge: ID[]; roots: ID[]; flow: number; fromMap?: boolean };
  treeInfo(info: unknown): { key: string; size: Int32Array; clean: Uint8Array; regular: Uint8Array };
  userPart(info: unknown): { key: string; users: ID[]; indeg0: ID[]; sccs: ID[][] };
}

const arr = (x: ArrayLike<unknown>) => Array.from(x);

/** 直した範囲・木・自分のノードの入口を、キャッシュを捨てて作り直した物と比べる（比べた後は直した物に戻す） */
export function scopeDiff(vm: ViewModel): string[] {
  const v = vm as unknown as VmInside;
  const out: string[] = [];
  const info = v.scopeInfo();
  const tree = v.treeInfo(info);
  const user = v.userPart(info);
  const saved = { s: v.scopeCache, t: v.treeCache, u: v.userCache };
  v.scopeCache = null;
  v.treeCache = null;
  v.userCache = null;
  const f = v.scopeInfo();
  if (f.fromMap === info.fromMap) {
    const ft = v.treeInfo(f);
    const fu = v.userPart(f);
    const eq = (name: string, a: unknown, b: unknown) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      if (sa !== sb) {
        let i = 0;
        if (Array.isArray(a) && Array.isArray(b)) while (i < a.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i++;
        out.push(`${name}: [${i}] ${JSON.stringify((a as unknown[])[i])} ≠ ${JSON.stringify((b as unknown[])[i])}（長さ ${(a as unknown[]).length} / ${(b as unknown[]).length}）`);
      }
    };
    eq("roots", info.roots, f.roots);
    eq("order", info.order, f.order);
    eq("rootOf", arr(info.rootOf), arr(f.rootOf));
    eq("depth", arr(info.depth), arr(f.depth));
    eq("parent", arr(info.parent), arr(f.parent));
    eq("parentEdge", info.parentEdge, f.parentEdge);
    if (info.pos.size !== f.pos.size) out.push(`pos.size ${info.pos.size} ≠ ${f.pos.size}`);
    for (const [id, p] of f.pos) if (info.pos.get(id) !== p) {
      out.push(`pos ${id}: ${info.pos.get(id)} ≠ ${p}`);
      break;
    }
    eq("tree.key", tree.key, ft.key);
    eq("tree.size", arr(tree.size), arr(ft.size));
    eq("tree.clean", arr(tree.clean), arr(ft.clean));
    eq("tree.regular", arr(tree.regular), arr(ft.regular));
    eq("users", user, fu);
  }
  v.scopeCache = saved.s;
  v.treeCache = saved.t;
  v.userCache = saved.u;
  return out;
}

export function forecastDiff(a: ForecastResult, b: ForecastResult): string[] {
  const out: string[] = [];
  if (a.active !== b.active || a.longest !== b.longest) out.push(`active/longest ${a.active}/${a.longest} ≠ ${b.active}/${b.longest}`);
  if (JSON.stringify(a.order) !== JSON.stringify(b.order)) out.push("流した順が違う");
  if (a.reach.size !== b.reach.size) out.push(`届いた数 ${a.reach.size} ≠ ${b.reach.size}`);
  for (const [id, r] of b.reach) {
    const x = a.reach.get(id);
    if (!x || !Object.is(x.p, r.p) || x.minSteps !== r.minSteps || x.maxSteps !== r.maxSteps) {
      out.push(`見込み ${id}: ${JSON.stringify(x)} ≠ ${JSON.stringify(r)}`);
      break;
    }
  }
  if (JSON.stringify(a.ends) !== JSON.stringify(b.ends)) out.push("行き先の並びが違う");
  if (JSON.stringify([...a.impactScope].sort()) !== JSON.stringify([...b.impactScope].sort())) out.push("範囲が違う");
  return out;
}

