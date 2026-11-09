// 新しいノードの置き場所を決める（重ならない所を探す）

import { CHILD_DX, NODE_H, NODE_W, SIBLING_DY } from "./constants";
import type { GraphIndex } from "./graph";
import type { DocData, ID } from "./types";

const GAP_X = 28;
const GAP_Y = 22;

function overlaps(doc: DocData, x: number, y: number, ignore: ReadonlySet<ID>, extra: Array<{ x: number; y: number }>): boolean {
  const w = NODE_W + GAP_X;
  const h = NODE_H + GAP_Y;
  for (const id in doc.nodes) {
    if (ignore.has(id)) continue;
    const n = doc.nodes[id]!;
    if (Math.abs(n.x - x) < w && Math.abs(n.y - y) < h) return true;
  }
  for (const p of extra) if (Math.abs(p.x - x) < w && Math.abs(p.y - y) < h) return true;
  return false;
}

/** (x, y) の近くで空いている所。上下に交互にずらして探す */
export function findFreeSpot(doc: DocData, x: number, y: number, opts: { ignore?: ReadonlySet<ID>; extra?: Array<{ x: number; y: number }>; preferDown?: boolean } = {}): { x: number; y: number } {
  const ignore = opts.ignore ?? new Set<ID>();
  const extra = opts.extra ?? [];
  const step = NODE_H + GAP_Y + 8;
  for (let i = 0; i < 40; i++) {
    const k = Math.ceil(i / 2);
    const dir = opts.preferDown ? (i % 2 === 1 ? 1 : -1) : i % 2 === 1 ? 1 : -1;
    const cy = i === 0 ? y : y + dir * k * step;
    if (!overlaps(doc, x, cy, ignore, extra)) return { x, y: cy };
  }
  // 見つからなければ右へずらす
  return { x: x + NODE_W + GAP_X, y };
}

/** 子（分岐の先）を置く場所: 親の右。すでに子がいれば、いちばん下の子の下 */
export function childSpot(doc: DocData, index: GraphIndex, parentId: ID, extra: Array<{ x: number; y: number }> = []): { x: number; y: number } {
  const p = doc.nodes[parentId];
  if (!p) return { x: 0, y: 0 };
  const kids: Array<{ x: number; y: number }> = [];
  for (const eid of index.out.get(parentId) ?? []) {
    const e = doc.edges[eid];
    const c = e && doc.nodes[e.target];
    if (c && c.x > p.x) kids.push(c);
  }
  kids.push(...extra);
  if (kids.length === 0) return findFreeSpot(doc, p.x + CHILD_DX, p.y, { extra });
  const maxY = Math.max(...kids.map((k) => k.y));
  const avgX = kids.reduce((s, k) => s + k.x, 0) / kids.length;
  return findFreeSpot(doc, Math.max(p.x + CHILD_DX * 0.8, avgX), maxY + SIBLING_DY, { extra, preferDown: true });
}

/** 合流ノードの場所: 選んだノードのいちばん右のさらに右、縦は平均 */
export function mergeSpot(doc: DocData, ids: ID[]): { x: number; y: number } {
  const ns = ids.map((id) => doc.nodes[id]).filter((n) => n !== undefined);
  if (ns.length === 0) return { x: 0, y: 0 };
  const x = Math.max(...ns.map((n) => n.x)) + CHILD_DX;
  const y = ns.reduce((s, n) => s + n.y, 0) / ns.length;
  return findFreeSpot(doc, x, Math.round(y));
}
