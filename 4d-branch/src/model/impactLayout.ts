// 3 年の分かれ道の並べ方（目次の形）。開いているノードの子だけを、上から順に 1 行ずつ並べる。設計: docs/DESIGN.md §4.7
//   横 = 深さごとの列（判断 → 選択肢は 300、選択肢 → 結果は 400。結果の線の「35%｜判断の線」を書く余白）
//   縦 = 行（128）。親は最初の子と同じ行。子を持つ兄弟の間は少し空ける
// 行は上から順に増えるだけなので重ならない。開く・閉じるで動くのは、そのノードより下の行だけ。

import type { GNode, ID } from "./types";

/** 深さごとの列の位置（それより深い列は 300 ずつ） */
export const IMPACT_X = [0, 300, 700, 1000, 1400, 1700, 2100];
export const IMPACT_ROW = 128;
export const IMPACT_GROUP_GAP = 24;
/** 3 年の分かれ道を開いた・寄ったときの、いちばん引いた大きさ（スマホでも選択肢の数が読める大きさ） */
export const IMPACT_FIRST_ZOOM = 0.45;

export function impactColX(depth: number): number {
  const last = IMPACT_X.length - 1;
  return depth <= last ? IMPACT_X[depth]! : IMPACT_X[last]! + 300 * (depth - last);
}

/** 作ったときの順位（meta.rank）。無ければ null（後から足したノード） */
function rankOf(n: GNode): number | null {
  const r = n.meta?.rank;
  return typeof r === "number" && Number.isFinite(r) ? r : null;
}

/** 兄弟の並びの順: 作ったときの順位 → 後から足したノード（作った時刻の順）→ ID */
export function compareImpactKids(a: GNode, b: GNode): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra !== null && rb !== null && ra !== rb) return ra - rb;
  if (ra !== null && rb === null) return -1;
  if (ra === null && rb !== null) return 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 目次の形に並べる。kids は表示する子（並びの順）を返す。合流（2 つ目以降の親）・循環は最初にたどった所に置く。
 * more: 入口からはたどれないが見えているノードと、その列の深さ。入口の木の下に、それぞれを根として並べる（もう置いた物は飛ばす）。
 * 戻り値は入口からの相対位置
 */
export function outlineLayout(root: ID, kids: (id: ID) => ID[], more: ReadonlyArray<readonly [ID, number]> = []): Map<ID, { x: number; y: number }> {
  const pos = new Map<ID, { x: number; y: number }>();
  let cursor = 0;
  // 再帰を使わずにたどる（深い地図でも止まらない）
  interface Frame {
    id: ID;
    depth: number;
    list: ID[];
    i: number;
    firstY: number | null;
    prevHadKids: boolean;
  }
  const open = (id: ID, depth: number): Frame | null => {
    pos.set(id, { x: impactColX(depth), y: cursor });
    const list = kids(id).filter((k) => !pos.has(k));
    if (!list.length) {
      cursor += IMPACT_ROW;
      return null;
    }
    return { id, depth, list, i: 0, firstY: null, prevHadKids: false };
  };
  const place = (id: ID, depth: number): void => {
    const stack: Frame[] = [];
    const f0 = open(id, depth);
    if (f0) stack.push(f0);
    while (stack.length) {
      const f = stack[stack.length - 1]!;
      if (f.i >= f.list.length) {
        stack.pop();
        // 親は最初の子の行（子の行が決まってから）
        pos.get(f.id)!.y = f.firstY ?? pos.get(f.id)!.y;
        const parent = stack[stack.length - 1];
        if (parent) parent.prevHadKids = true;
        continue;
      }
      const k = f.list[f.i]!;
      f.i++;
      if (pos.has(k)) continue;
      if (f.i > 1 && f.prevHadKids) cursor += IMPACT_GROUP_GAP;
      f.prevHadKids = false;
      const child = open(k, f.depth + 1);
      if (f.firstY === null) f.firstY = pos.get(k)!.y;
      if (child) stack.push(child);
    }
  };
  place(root, 0);
  for (const [id, depth] of more) {
    if (pos.has(id)) continue;
    cursor += IMPACT_GROUP_GAP;
    place(id, Math.max(0, depth));
  }
  return pos;
}
