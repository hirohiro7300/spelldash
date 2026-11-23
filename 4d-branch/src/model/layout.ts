// 新しいノードの置き場所を決める（重ならない所を探す）

import { CHILD_DX, NODE_H, NODE_W, SIBLING_DY } from "./constants";
import type { GraphIndex } from "./graph";
import type { DocData, ID } from "./types";

const GAP_X = 28;
const GAP_Y = 22;

/**
 * (x, y) の近くで空いている所。上下に交互にずらして探す。skip: 文書の位置では数えないノード（3 年の分かれ道のカードは、画面の位置が
 * 重ねる位置で、文書には位置を持たない: extra に見えているカードの重ねる位置を渡す。W-app の I2）
 */
export function findFreeSpot(doc: DocData, x: number, y: number, opts: { ignore?: ReadonlySet<ID>; extra?: Array<{ x: number; y: number }>; preferDown?: boolean; skip?: (id: ID) => boolean } = {}): { x: number; y: number } {
  const ignore = opts.ignore ?? new Set<ID>();
  const extra = opts.extra ?? [];
  const skip = opts.skip;
  const step = NODE_H + GAP_Y + 8;
  const COLS = 24;
  const ROWS = 40;
  // 探す所に重なりうるノードだけを先に 1 度で集める（探す所ごとに 8 万枚をなめない: 見直し perf-4）。重なる = 縦も横も、カードの大きさと間より近い
  const w = NODE_W + GAP_X;
  const h = NODE_H + GAP_Y;
  const reach = Math.ceil((ROWS - 1) / 2) * step;
  const x0 = x - w;
  const x1 = x + (COLS - 1) * (NODE_W + GAP_X) + w;
  const y0 = y - reach - h;
  const y1 = y + reach + h;
  const near: Array<{ x: number; y: number }> = [];
  for (const id in doc.nodes) {
    const n = doc.nodes[id]!;
    if (n.x > x0 && n.x < x1 && n.y > y0 && n.y < y1 && !ignore.has(id) && !skip?.(id)) near.push(n);
  }
  for (const p of extra) if (p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1) near.push(p);
  const hit = (cx: number, cy: number): boolean => {
    for (const p of near) if (Math.abs(p.x - cx) < w && Math.abs(p.y - cy) < h) return true;
    return false;
  };
  // 縦に交互に探し、その列が詰まっていれば右の列へ（確かめずに置かない）
  for (let col = 0; col < COLS; col++) {
    const cx = x + col * (NODE_W + GAP_X);
    for (let i = 0; i < ROWS; i++) {
      const k = Math.ceil(i / 2);
      const dir = opts.preferDown ? (i % 2 === 1 ? 1 : -1) : i % 2 === 1 ? 1 : -1;
      const cy = i === 0 ? y : y + dir * k * step;
      if (!hit(cx, cy)) return { x: cx, y: cy };
    }
  }
  // それでも無ければ、いちばん右のノードのさらに右（必ず空いている）
  let maxX = x;
  for (const id in doc.nodes) if (!ignore.has(id) && !skip?.(id)) maxX = Math.max(maxX, doc.nodes[id]!.x);
  for (const p of extra) maxX = Math.max(maxX, p.x);
  return { x: maxX + NODE_W + GAP_X, y };
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
