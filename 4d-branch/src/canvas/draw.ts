// キャンバスに描く部品（ワールド座標で描く。呼ぶ側がカメラの変換をかけておく）

import { NODE_H, NODE_TYPES, NODE_W, RELATIONS, STATUSES } from "../model/constants";
import { dayNumber, formatShort } from "../model/dates";
import type { GNode, NodeType, Relation } from "../model/types";
import { BADGE_H, BADGE_W, HALF_H, HALF_W, badgeCenter, bezierPoint, type EdgeGeom } from "./geometry";
import { CANVAS_FONT, ellipsize, wrapText } from "./text";
import { formatPercent } from "../model/forecast";

/**
 * 拡大率ごとの描き方（意味のあるズーム）:
 *   full    80% 以上: すべて（種類・状態・期限・タイトル・所属・条件・タグ）
 *   compact 30〜80%: 細部を省き、タイトルを大きくして画面で読める大きさ（約 11px）に保つ
 *   low     10〜30%: 色の箱と所属の帯（目標の名前だけ画面に目印として出す）
 *   dot     10% 未満: 点
 */
export type Lod = "full" | "compact" | "low" | "dot";

export function lodFor(zoom: number): Lod {
  if (zoom >= 0.8) return "full";
  if (zoom >= 0.3) return "compact";
  if (zoom >= 0.1) return "low";
  return "dot";
}

const rgbaCache = new Map<string, [number, number, number]>();
export function rgba(hex: string, a: number): string {
  let c = rgbaCache.get(hex);
  if (!c) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    c = m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [255, 255, 255];
    rgbaCache.set(hex, c);
  }
  return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

const RADIUS: Record<NodeType, number> = { goal: 16, action: 11, branch: 0, result: 30 };
const BRANCH_INSET = 18;

export function nodePath(ctx: CanvasRenderingContext2D, type: NodeType, left: number, top: number, w = NODE_W, h = NODE_H): void {
  ctx.beginPath();
  if (type === "branch") {
    const i = BRANCH_INSET;
    const r = 6;
    // 左右がとがった六角形（角を少し丸める）
    const pts: Array<[number, number]> = [
      [left + i, top],
      [left + w - i, top],
      [left + w, top + h / 2],
      [left + w - i, top + h],
      [left + i, top + h],
      [left, top + h / 2],
    ];
    ctx.moveTo((pts[0]![0] + pts[1]![0]) / 2, top);
    for (let k = 1; k <= 6; k++) {
      const p = pts[k % 6]!;
      const q = pts[(k + 1) % 6]!;
      ctx.arcTo(p[0], p[1], q[0], q[1], r);
    }
    ctx.closePath();
  } else {
    ctx.roundRect(left, top, w, h, RADIUS[type]);
  }
}

/** 種類のアイコン（中心 cx, cy・大きさ s） */
export function drawTypeIcon(ctx: CanvasRenderingContext2D, type: NodeType, cx: number, cy: number, s: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = s * 0.13;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const u = s / 24;
  ctx.translate(cx - 12 * u, cy - 12 * u);
  ctx.scale(u, u);
  ctx.lineWidth = 2;
  ctx.beginPath();
  switch (type) {
    case "goal":
      ctx.arc(12, 12, 8.5, 0, Math.PI * 2);
      ctx.moveTo(16.5, 12);
      ctx.arc(12, 12, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(12, 12, 1.6, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "action":
      ctx.moveTo(13.2, 3);
      ctx.lineTo(5.5, 13.4);
      ctx.lineTo(11.3, 13.4);
      ctx.lineTo(10.4, 21);
      ctx.lineTo(18.5, 10.4);
      ctx.lineTo(12.6, 10.4);
      ctx.closePath();
      ctx.stroke();
      break;
    case "branch":
      ctx.moveTo(12, 17);
      ctx.lineTo(12, 13);
      ctx.lineTo(7.2, 6.6);
      ctx.moveTo(12, 13);
      ctx.lineTo(16.8, 6.6);
      ctx.stroke();
      for (const [x, y] of [
        [12, 19],
        [6, 5],
        [18, 5],
      ] as const) {
        ctx.beginPath();
        ctx.arc(x, y, 2.1, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    case "result":
      ctx.moveTo(6, 21);
      ctx.lineTo(6, 4);
      ctx.moveTo(6, 4.5);
      ctx.lineTo(16.5, 4.5);
      ctx.lineTo(14.1, 8.3);
      ctx.lineTo(16.5, 12.1);
      ctx.lineTo(6, 12.1);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

export interface NodeDrawOpts {
  lod: Lod;
  zoom: number;
  alpha: number;
  selected: boolean;
  hovered: boolean;
  match: boolean;
  ghost: boolean;
  offScenario: boolean;
  dropTarget: boolean;
  editing: boolean;
  projectColors: string[];
  collapsedCount: number;
  /** 折りたたみの印を描くか（当たり判定と同じ答え。CanvasView.badgeVisible） */
  showBadge: boolean;
  today: string;
  /** 未来の道筋で、ここに至る見込み（0〜1。見込みの無い文書では undefined） */
  reach?: number;
}

const FONT_TITLE = `600 14px ${CANVAS_FONT}`;
const FONT_SMALL = `650 11px ${CANVAS_FONT}`;
const FONT_META = `500 11px ${CANVAS_FONT}`;

/** 所属プロジェクトの色の帯（カードの下の縁）。縮小しても所属と共有が見える */
function drawProjectStripe(ctx: CanvasRenderingContext2D, type: NodeType, left: number, top: number, colors: string[], a: number, zoom: number): void {
  if (!colors.length) return;
  const hgt = Math.max(4, 2.6 / zoom);
  ctx.save();
  nodePath(ctx, type, left, top);
  ctx.clip();
  const inset = type === "branch" ? BRANCH_INSET : 0;
  const w = (NODE_W - inset * 2) / colors.length;
  colors.forEach((c, i) => {
    ctx.fillStyle = rgba(c, 0.95 * Math.max(a, 0.3));
    ctx.fillRect(left + inset + i * w, top + NODE_H - hgt, w + 0.5, hgt);
  });
  ctx.restore();
}

export function drawNode(ctx: CanvasRenderingContext2D, n: GNode, x: number, y: number, o: NodeDrawOpts): void {
  const meta = NODE_TYPES[n.type];
  const color = meta.color;
  const left = x - HALF_W;
  const top = y - HALF_H;
  const a = o.alpha;
  const px = 1 / o.zoom; // 画面の 1px

  if (o.lod === "dot") {
    ctx.fillStyle = rgba(color, 0.85 * a);
    ctx.fillRect(left, top, NODE_W, NODE_H);
    return;
  }

  ctx.save();
  // 選択の光
  if (o.selected) {
    ctx.shadowColor = rgba(color, 0.7 * Math.max(a, 0.6));
    ctx.shadowBlur = 26 * Math.min(1.4, Math.max(0.5, o.zoom)) * (globalThis.devicePixelRatio || 1);
  }
  nodePath(ctx, n.type, left, top);
  if (o.lod === "low") {
    ctx.fillStyle = rgba(color, 0.2 * a + 0.05);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1.5, 1.2 * px);
    ctx.strokeStyle = rgba(color, (o.selected ? 1 : 0.75) * a);
    ctx.stroke();
    drawProjectStripe(ctx, n.type, left, top, o.projectColors, a, o.zoom);
    if (o.match) {
      nodePath(ctx, n.type, left - 10, top - 10, NODE_W + 20, NODE_H + 20);
      ctx.lineWidth = 2.5 * px;
      ctx.strokeStyle = "rgba(242,193,78,0.95)";
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  ctx.fillStyle = `rgba(17,22,32,${(0.97 * Math.max(a, 0.35)).toFixed(3)})`;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";

  // 上から種類の色をうっすら
  if (a > 0.3) {
    ctx.save();
    nodePath(ctx, n.type, left, top);
    ctx.clip();
    const g = ctx.createLinearGradient(0, top, 0, top + NODE_H);
    g.addColorStop(0, rgba(color, 0.14 * a));
    g.addColorStop(0.6, rgba(color, 0.02 * a));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(left, top, NODE_W, NODE_H);
    ctx.restore();
  }

  // 枠
  nodePath(ctx, n.type, left, top);
  const borderA = o.selected ? 1 : o.hovered || o.dropTarget ? 0.85 : 0.45;
  ctx.lineWidth = o.selected ? Math.max(2, 1.6 * px) : Math.max(1.2, 1 * px);
  ctx.strokeStyle = rgba(color, borderA * Math.max(a, o.selected ? 0.8 : 0));
  if (o.ghost || o.offScenario) ctx.setLineDash([6, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  if (n.type === "goal") {
    // 目標は内側にもう 1 本（的のような二重線）
    ctx.beginPath();
    ctx.roundRect(left + 4, top + 4, NODE_W - 8, NODE_H - 8, 12);
    ctx.lineWidth = Math.max(1, 0.8 * px);
    ctx.strokeStyle = rgba(color, 0.22 * a);
    ctx.stroke();
  }
  if (o.dropTarget) {
    nodePath(ctx, n.type, left - 5, top - 5, NODE_W + 10, NODE_H + 10);
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = "rgba(139,123,255,0.9)";
    ctx.stroke();
  }
  if (o.match) {
    nodePath(ctx, n.type, left - 6, top - 6, NODE_W + 12, NODE_H + 12);
    ctx.lineWidth = Math.max(2, 1.8 * px);
    ctx.strokeStyle = "rgba(242,193,78,0.95)";
    ctx.stroke();
  }

  const inset = n.type === "branch" ? 22 : 15;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  if (o.lod === "compact") {
    // タイトルだけを大きく（画面で約 11.5px）。2 行まで
    if (!o.editing) {
      const f = Math.round(Math.min(34, Math.max(15, 11.5 / o.zoom)));
      ctx.font = `650 ${f}px ${CANVAS_FONT}`;
      const lines = wrapText(ctx, n.title.trim() || "（無題）", NODE_W - inset * 2, 2);
      const lh = f * 1.18;
      const blockH = lines.length * lh;
      const startY = top + (NODE_H - 6 - blockH) / 2 + f * 0.86;
      ctx.fillStyle = n.title.trim() ? `rgba(238,241,247,${(n.status === "dropped" ? 0.55 : 1) * a})` : `rgba(110,120,137,${a})`;
      lines.forEach((ln, i) => ctx.fillText(ln, left + inset, startY + i * lh));
    }
    drawProjectStripe(ctx, n.type, left, top, o.projectColors, a, o.zoom);
    if (n.status === "done") drawDoneMark(ctx, left + NODE_W - inset + 2, top + 13, a, Math.max(1, 0.7 / o.zoom));
  } else {
    // full: アイコン・種類・状態・期限・タイトル・所属・条件・タグ
    const ix = left + (n.type === "branch" ? 33 : 22);
    const iy = top + 22;
    ctx.beginPath();
    ctx.arc(ix, iy, 11.5, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, 0.17 * a);
    ctx.fill();
    drawTypeIcon(ctx, n.type, ix, iy, 14.5, rgba(color, a));

    ctx.font = FONT_SMALL;
    ctx.fillStyle = rgba(color, 0.95 * a);
    const labelX = ix + 18;
    ctx.fillText(meta.label, labelX, top + 26);
    let cursorX = labelX + ctx.measureText(meta.label).width;
    if (n.status !== "open") {
      const st = STATUSES[n.status];
      ctx.font = FONT_META;
      ctx.fillStyle = rgba(st.color, 0.95 * a);
      const t = ` · ${st.label}`;
      ctx.fillText(t, cursorX, top + 26);
      cursorX += ctx.measureText(t).width;
    }
    if (n.time.due) {
      ctx.font = FONT_META;
      ctx.textAlign = "right";
      const diff = dayNumber(n.time.due) - dayNumber(o.today);
      const done = n.status === "done" || n.status === "dropped";
      ctx.fillStyle = done ? rgba("#6f7889", a) : diff < 0 ? rgba("#ff5d6c", a) : diff <= 14 ? rgba("#f2c14e", a) : rgba("#8d96a8", a);
      ctx.fillText(formatShort(n.time.due, o.today), left + NODE_W - inset, top + 26);
      ctx.textAlign = "left";
    }

    if (!o.editing) {
      ctx.font = FONT_TITLE;
      const maxW = NODE_W - inset * 2;
      const title = n.title.trim() || "（無題）";
      const lines = wrapText(ctx, title, maxW, 2);
      ctx.fillStyle = n.title.trim() ? (n.status === "dropped" ? `rgba(160,168,184,${(0.7 * a).toFixed(3)})` : `rgba(238,241,247,${a.toFixed(3)})`) : `rgba(110,120,137,${a.toFixed(3)})`;
      lines.forEach((ln, i) => {
        const by = top + 50 + i * 18.5;
        ctx.fillText(ln, left + inset, by);
        if (n.status === "dropped") {
          const w = ctx.measureText(ln).width;
          ctx.fillRect(left + inset, by - 5, w, 1.2);
        }
      });
    }

    let fx = left + inset + 3;
    const fy = top + NODE_H - 11;
    for (const c of o.projectColors.slice(0, 6)) {
      ctx.beginPath();
      ctx.arc(fx, fy - 3.5, 3.7, 0, Math.PI * 2);
      ctx.fillStyle = rgba(c, a);
      ctx.fill();
      fx += 10.5;
    }
    if (o.projectColors.length) fx += 4;
    ctx.font = FONT_META;
    const parts: string[] = [];
    if (o.reach !== undefined && o.reach < 0.9995) parts.push(`見込み ${formatPercent(o.reach)}`);
    if (n.conditions.length) parts.push(`条件 ${n.conditions.filter((c) => c.met).length}/${n.conditions.length}`);
    if (n.tags.length) parts.push(n.tags.slice(0, 3).map((t) => `#${t}`).join(" "));
    if (parts.length) {
      ctx.fillStyle = `rgba(128,138,156,${a.toFixed(3)})`;
      const maxW = left + NODE_W - inset - fx - (o.showBadge || o.collapsedCount || n.collapsed ? 52 : n.status === "done" ? 20 : 0);
      if (maxW > 20) ctx.fillText(ellipsize(ctx, parts.join("  ·  "), maxW), fx, fy);
    }
    if (n.status === "done" && !(o.showBadge || n.collapsed)) drawDoneMark(ctx, left + NODE_W - inset - 4, fy - 4, a, 1);
  }

  // 折りたたみの印（描くかどうかは呼ぶ側が当たり判定と同じ決まりで渡す）
  if (o.showBadge) drawBadge(ctx, x, y, n.collapsed, o.collapsedCount, color, a, o.lod, o.zoom);
  ctx.restore();
}

function drawDoneMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, a: number, k: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, 7 * k, 0, Math.PI * 2);
  ctx.fillStyle = rgba("#3dd9a4", 0.2 * a);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 3.2 * k, cy + 0.2 * k);
  ctx.lineTo(cx - 0.8 * k, cy + 2.6 * k);
  ctx.lineTo(cx + 3.4 * k, cy - 2.4 * k);
  ctx.strokeStyle = rgba("#3dd9a4", a);
  ctx.lineWidth = 1.6 * k;
  ctx.stroke();
}

function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, collapsed: boolean, count: number, color: string, a: number, lod: Lod, zoom: number): void {
  const c = badgeCenter(x, y);
  const k = badgeScale(zoom);
  const bw = BADGE_W * k;
  const bh = BADGE_H * k;
  ctx.beginPath();
  ctx.roundRect(c.x - bw / 2, c.y - bh / 2, bw, bh, bh / 2);
  ctx.fillStyle = collapsed ? rgba(color, 0.95 * Math.max(a, 0.5)) : "rgba(20,26,38,0.96)";
  ctx.fill();
  ctx.lineWidth = 1.2 * k;
  ctx.strokeStyle = rgba(color, collapsed ? 1 : 0.7);
  ctx.stroke();
  if (lod !== "full" && lod !== "compact") return;
  ctx.font = `700 ${Math.round(11 * k)}px ${CANVAS_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = collapsed ? "#0b0e14" : rgba(color, 1);
  ctx.fillText(collapsed ? (count > 0 ? `+${count}` : "▸") : "−", c.x, c.y + 0.5);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/** 入る・出るのつまみ（接続の始点） */
/** 縮小しても印が画面で小さくなりすぎないように */
export function badgeScale(zoom: number): number {
  return Math.max(1, Math.min(2.4, 0.85 / zoom));
}

export function drawPort(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, active: boolean): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = active ? color : "#0e121a";
  ctx.fill();
  ctx.lineWidth = r * 0.28;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - r * 0.45, y);
  ctx.lineTo(x + r * 0.45, y);
  ctx.moveTo(x, y - r * 0.45);
  ctx.lineTo(x, y + r * 0.45);
  ctx.strokeStyle = active ? "#0e121a" : color;
  ctx.lineWidth = r * 0.24;
  ctx.stroke();
}

export interface EdgeDrawOpts {
  lod: Lod;
  zoom: number;
  alpha: number;
  relation: Relation;
  selected: boolean;
  hovered: boolean;
  path: boolean;
  cross: boolean;
  offScenario: boolean;
  /** 流れの動き（ミリ秒）。null なら動かさない */
  flowT: number | null;
}

function strokeCurve(ctx: CanvasRenderingContext2D, g: EdgeGeom, lod: Lod): void {
  ctx.beginPath();
  ctx.moveTo(g.x0, g.y0);
  if (lod === "dot") ctx.lineTo(g.x3, g.y3);
  else ctx.bezierCurveTo(g.c1x, g.c1y, g.c2x, g.c2y, g.x3, g.y3);
  ctx.stroke();
}

export function drawEdge(ctx: CanvasRenderingContext2D, g: EdgeGeom, o: EdgeDrawOpts): void {
  const rel = RELATIONS[o.relation];
  const px = 1 / o.zoom;
  const emphasized = o.path || o.selected || o.hovered;
  const a = o.alpha * (emphasized ? 1 : o.lod === "dot" ? 0.3 : o.lod === "low" ? 0.6 : 1);
  const color = rel.color;
  const base = rel.width + (o.cross ? 0.9 : 0) + (o.selected ? 1.4 : o.hovered ? 0.8 : 0);
  const lw = Math.max(base, (o.lod === "low" || o.lod === "dot" ? 1 : 0.9) * px);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // プロジェクト間の線は外側に光
  if ((o.cross || o.selected) && (o.lod === "full" || o.lod === "compact")) {
    ctx.strokeStyle = rgba(color, (o.selected ? 0.22 : 0.13) * a);
    ctx.lineWidth = lw + (o.selected ? 9 : 7);
    ctx.setLineDash([]);
    strokeCurve(ctx, g, o.lod);
  }
  ctx.strokeStyle = rgba(color, (o.path || o.selected ? 0.98 : 0.78) * a);
  ctx.lineWidth = lw;
  const dashOk = o.lod === "full" || o.lod === "compact";
  ctx.setLineDash(dashOk ? (o.offScenario ? [3, 7] : rel.dash) : []);
  strokeCurve(ctx, g, o.lod);
  ctx.setLineDash([]);

  // 流れ（選んだ経路の上を光が進む）
  if (o.flowT !== null && (o.path || o.selected) && o.lod !== "dot" && o.lod !== "low") {
    ctx.strokeStyle = `rgba(255,255,255,${(0.55 * a).toFixed(3)})`;
    ctx.lineWidth = Math.max(1.4, lw * 0.75);
    ctx.setLineDash([5, 22]);
    ctx.lineDashOffset = -((o.flowT / 28) % 27);
    strokeCurve(ctx, g, o.lod);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  if (o.lod === "low" || o.lod === "dot") return;
  // 矢印（向き）
  const tx = g.x3 - g.c2x;
  const ty = g.y3 - g.c2y;
  const len = Math.hypot(tx, ty) || 1;
  const ux = tx / len;
  const uy = ty / len;
  const s = Math.max(9, 7 * px) + (o.selected ? 2 : 0);
  ctx.beginPath();
  ctx.moveTo(g.x3 + ux * 1, g.y3 + uy * 1);
  ctx.lineTo(g.x3 - ux * s - uy * s * 0.55, g.y3 - uy * s + ux * s * 0.55);
  ctx.lineTo(g.x3 - ux * s * 0.68, g.y3 - uy * s * 0.68);
  ctx.lineTo(g.x3 - ux * s + uy * s * 0.55, g.y3 - uy * s - ux * s * 0.55);
  ctx.closePath();
  ctx.fillStyle = rgba(color, (o.path || o.selected ? 1 : 0.85) * a);
  ctx.fill();
  if (o.relation === "blocks") {
    // 阻害は止め線
    const bx = g.x3 - ux * (s + 5);
    const by = g.y3 - uy * (s + 5);
    ctx.beginPath();
    ctx.moveTo(bx - uy * 8, by + ux * 8);
    ctx.lineTo(bx + uy * 8, by - ux * 8);
    ctx.strokeStyle = rgba(color, a);
    ctx.lineWidth = Math.max(2.2, 1.4 * px);
    ctx.stroke();
  }
}

/** 線の中ほどのラベル（条件・説明）。描いた枠を返す（当たり判定用） */
export function drawEdgeLabel(ctx: CanvasRenderingContext2D, g: EdgeGeom, text: string, relation: Relation, alpha: number, emphasized: boolean, zoom: number): { x: number; y: number; w: number; h: number } {
  const rel = RELATIONS[relation];
  const p = bezierPoint(g, 0.5);
  const k = Math.max(1, Math.min(2, 0.9 / zoom));
  const fs = Math.round(11.5 * k * 2) / 2;
  ctx.font = `500 ${fs}px ${CANVAS_FONT}`;
  const t = ellipsize(ctx, text, 190 * k);
  const w = ctx.measureText(t).width + 26 * k;
  const h = 22 * k;
  const x = p.x - w / 2;
  const y = p.y - h / 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = `rgba(13,17,25,${(0.94 * Math.max(alpha, 0.4)).toFixed(3)})`;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(rel.color, (emphasized ? 0.85 : 0.42) * alpha);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + 11 * k, p.y, 3.2 * k, 0, Math.PI * 2);
  ctx.fillStyle = rgba(rel.color, alpha);
  ctx.fill();
  ctx.fillStyle = `rgba(214,220,231,${alpha.toFixed(3)})`;
  ctx.textBaseline = "middle";
  ctx.fillText(t, x + 19 * k, p.y + 0.5);
  ctx.textBaseline = "alphabetic";
  return { x, y, w, h };
}

/** 折りたたんだ接続: 付け根だけ描いて「+N」 */
export function drawStub(ctx: CanvasRenderingContext2D, sx: number, sy: number, count: number, relation: Relation, alpha: number): { x: number; y: number; w: number; h: number } {
  const rel = RELATIONS[relation];
  const x0 = sx + HALF_W;
  ctx.beginPath();
  ctx.moveTo(x0, sy);
  ctx.lineTo(x0 + 34, sy);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = rgba(rel.color, 0.8 * alpha);
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.setLineDash([]);
  const w = 44;
  const h = 20;
  const x = x0 + 34;
  const y = sy - h / 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = rgba(rel.color, 0.9 * alpha);
  ctx.fill();
  ctx.font = `700 11px ${CANVAS_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#0b0e14";
  ctx.fillText(count > 0 ? `+${count}` : "▸", x + w / 2, sy + 0.5);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  return { x, y, w, h };
}

/** ドット格子の模様（拡大率ごとに作り直す） */
export function gridPattern(ctx: CanvasRenderingContext2D, spacingPx: number, dotPx: number, alpha: number): CanvasPattern | null {
  const size = Math.max(4, Math.round(spacingPx));
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const t = tile.getContext("2d");
  if (!t) return null;
  t.fillStyle = `rgba(148,163,184,${alpha.toFixed(3)})`;
  t.beginPath();
  t.arc(dotPx, dotPx, dotPx * 0.75, 0, Math.PI * 2);
  t.fill();
  return ctx.createPattern(tile, "repeat");
}
