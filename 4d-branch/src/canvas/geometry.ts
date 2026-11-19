// 図形の計算（ワールド座標）: ノードの枠・つまみ・接続の曲線・当たり判定

import { NODE_H, NODE_W } from "../model/constants";

export const HALF_W = NODE_W / 2;
export const HALF_H = NODE_H / 2;

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeGeom {
  x0: number;
  y0: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x3: number;
  y3: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  backward: boolean;
}

/**
 * 接続の曲線: 元の右端 → 先の左端。先が右にあれば横向きの S 字、
 * 左（循環で戻る線など）にあれば、外側（side: 1 = 下・-1 = 上）を回って入る
 */
export function edgeGeom(ax: number, ay: number, bx: number, by: number, side: 1 | -1 = 1): EdgeGeom {
  const x0 = ax + HALF_W;
  const y0 = ay;
  const x3 = bx - HALF_W;
  const y3 = by;
  const dx = x3 - x0;
  let c1x: number;
  let c1y: number;
  let c2x: number;
  let c2y: number;
  const backward = dx < 40;
  if (!backward) {
    const k = Math.max(50, dx * 0.5);
    c1x = x0 + k;
    c1y = y0;
    c2x = x3 - k;
    c2y = y3;
  } else {
    const span = Math.abs(dx) + NODE_W;
    const k = 110 + Math.min(220, span * 0.1);
    const base = side > 0 ? Math.max(y0, y3) + HALF_H : Math.min(y0, y3) - HALF_H;
    const drop = (70 + Math.min(260, span * 0.12)) * side;
    c1x = x0 + k;
    c1y = base + drop;
    c2x = x3 - k;
    c2y = base + drop;
  }
  return {
    x0,
    y0,
    c1x,
    c1y,
    c2x,
    c2y,
    x3,
    y3,
    minX: Math.min(x0, c1x, c2x, x3),
    minY: Math.min(y0, c1y, c2y, y3),
    maxX: Math.max(x0, c1x, c2x, x3),
    maxY: Math.max(y0, c1y, c2y, y3),
    backward,
  };
}

export function bezierPoint(g: EdgeGeom, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * g.x0 + b * g.c1x + c * g.c2x + d * g.x3, y: a * g.y0 + b * g.c1y + c * g.c2y + d * g.y3 };
}

/** 曲線の上で、横の位置が x になる所の t（0〜1。左から右へ進む線だけ。二分法） */
export function tAtX(g: EdgeGeom, x: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bezierPoint(g, mid).x < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 線の札の大きさの倍率（引いて見ると文字を大きく。最大 2 倍） */
export function labelScale(zoom: number): number {
  return Math.max(1, Math.min(2, 0.9 / zoom));
}

/** 札の左右の余白・点の分（倍率 1 のとき。drawEdgeLabel と同じ） */
export const LABEL_PAD = 26;
/** 札とカードの間に空ける幅（ワールドの px） */
export const LABEL_GAP = 6;

/**
 * 3 年の分かれ道の結果の線の札に書ける文字の幅（倍率 1 の px。drawEdgeLabel の maxW）。札が線の両端のカードの間に収まる幅にする
 * （作業メモ user-16: 列の間が狭いと「35%｜判断の線」の札がカードに重なる）。それでも cap より広くはしない
 */
export function labelMaxW(g: EdgeGeom, zoom: number, cap = 170): number {
  const k = labelScale(zoom);
  const room = g.x3 - g.x0 - 2 * LABEL_GAP;
  return Math.max(12, Math.min(cap, room / k - LABEL_PAD));
}

/**
 * 線の札の枠（ワールド座標）。w は札の幅（文字の幅 + 余白）。start: 線の始まり（元のカードの右）に寄せる（長い線の札）。
 * それ以外は線の真ん中
 */
export function edgeLabelBox(g: EdgeGeom, w: number, h: number, start = false): { x: number; y: number; w: number; h: number; cy: number } {
  const p = start && !g.backward ? bezierPoint(g, tAtX(g, g.x0 + LABEL_GAP + w / 2)) : bezierPoint(g, 0.5);
  return { x: p.x - w / 2, y: p.y - h / 2, w, h, cy: p.y };
}

/** 曲線上の点で、いちばん近い所までの距離 */
export function distToEdge(g: EdgeGeom, px: number, py: number, steps = 24): number {
  let best = Infinity;
  let prev = { x: g.x0, y: g.y0 };
  for (let i = 1; i <= steps; i++) {
    const p = bezierPoint(g, i / steps);
    const d = distToSegment(px, py, prev.x, prev.y, p.x, p.y);
    if (d < best) best = d;
    prev = p;
  }
  return best;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * vx;
  const qy = ay + t * vy;
  return Math.hypot(px - qx, py - qy);
}

export function inNode(nx: number, ny: number, px: number, py: number, pad = 0): boolean {
  return Math.abs(px - nx) <= HALF_W + pad && Math.abs(py - ny) <= HALF_H + pad;
}

export function rectsIntersect(a: { minX: number; minY: number; maxX: number; maxY: number }, b: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** 折りたたみの印の位置（ノードの下の線の右寄り） */
export function badgeCenter(nx: number, ny: number): Pt {
  return { x: nx + HALF_W - 34, y: ny + HALF_H };
}

export const BADGE_W = 46;
export const BADGE_H = 20;
