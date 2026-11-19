// 3 年の分かれ道のカードを描く（4 つの拡大率ごと）。設計: docs/DESIGN.md §4.7
//   選択肢: 塗りの札（3 年の影響「+65万」・基準・—）・★/≒/✓・見込みの帯（結果ごとの割合と色）・3 年後の月の稼ぎの差と週の時間。枠と上の色は影響の段の色
//   結果・行き先: 縁取りの札（その結果になる見込み「35%」）。色はその結果の良し悪し。下の行に選択肢の幅・3 年の稼ぎ
//   今日: 「最善 +65万」と選択肢の幅
// 縮小（low）では段の色で塗り、真ん中に「+65」「35%」。一番小さく（dot）では段の色の四角

import { NODE_H, NODE_TYPES, NODE_W } from "../model/constants";
import { IMPACT_FILL, IMPACT_INK, IMPACT_NEUTRAL_RING } from "../model/impactFormat";
import type { GNode } from "../model/types";
import { badgeScale, drawBadge, drawProjectStripe, drawTypeIcon, nodePath, rgba, type NodeDrawOpts } from "./draw";
import { BADGE_W, HALF_H, HALF_W, badgeCenter } from "./geometry";
import { binStroke, type ImpactCard } from "./impactCards";
import { CANVAS_FONT, ellipsize, wrapText } from "./text";

/** 札の位置（ワールド座標。font はワールドの大きさ）。E2E で札が画面に入っているかを確かめるのに使う */
export interface PillRect {
  x: number;
  y: number;
  w: number;
  h: number;
  font: number;
}

const INK_LIGHT = "#EEF1F7";
/** 印の色（◎ おすすめは ★ より控えめな金色） */
const MARK_COLORS: Record<string, string> = { "★": "#F2C14E", "◎": "#C9A85A", "≒": "#C9D3E6", "✓": "#3DD9A4" };
const BRANCH_TEXT_INSET = 16;

/** 文字の幅（太さと文字ごとに 100px で測って覚え、大きさに比例させる。描くたびに測らない・文字列も作らない） */
const widthCache = new Map<number, Map<string, number>>();
function textWidth(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number): number {
  let byText = widthCache.get(weight);
  if (!byText) widthCache.set(weight, (byText = new Map()));
  let w = byText.get(text);
  if (w === undefined) {
    const f = ctx.font;
    ctx.font = `${weight} 100px ${CANVAS_FONT}`;
    w = ctx.measureText(text).width;
    ctx.font = f;
    if (byText.size > 4000) byText.clear();
    byText.set(text, w);
  }
  return (w * size) / 100;
}

/** 見込みの帯: 結果ごとの区切り（幅は割合・色はその結果の段の色） */
function drawRisk(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, risk: ImpactCard["risk"], a: number, gap: number): void {
  if (!risk.length || w <= 0) return;
  const total = risk.reduce((s, r) => s + r.w, 0) || 1;
  const avail = Math.max(0, w - gap * (risk.length - 1));
  let cx = x;
  for (const r of risk) {
    const sw = Math.max(Math.min(h, 2), (avail * r.w) / total);
    ctx.beginPath();
    ctx.roundRect(cx, y, sw, h, Math.min(3, h / 2, sw / 2));
    ctx.fillStyle = rgba(binStroke(r.bin), a);
    ctx.fill();
    cx += sw + gap;
  }
}

/** ★・≒・✓ を左から描き、描いた幅を返す */
function drawMarks(ctx: CanvasRenderingContext2D, marks: string, x: number, y: number, size: number, a: number): number {
  ctx.font = `700 ${size}px ${CANVAS_FONT}`;
  let cx = x;
  for (const m of marks) {
    ctx.fillStyle = rgba(MARK_COLORS[m] ?? INK_LIGHT, a);
    ctx.fillText(m, cx, y);
    cx += textWidth(ctx, m, 700, size) + size * 0.12;
  }
  return cx - x;
}

function marksWidth(ctx: CanvasRenderingContext2D, marks: string, size: number): number {
  let w = 0;
  for (const m of marks) w += textWidth(ctx, m, 700, size) + size * 0.12;
  return w;
}

/**
 * 札を描く。filled: 塗りの札（選択肢の 3 年の影響）、そうでなければ縁取りの札（結果の見込み・今日の最善）。
 * 文字は真ん中。描いた札を pill に書く
 */
function drawTag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number, size: number, bin: number, filled: boolean, a: number, lw: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  if (filled) {
    ctx.fillStyle = rgba(IMPACT_FILL[bin]!, a);
    ctx.fill();
    if (bin === 0) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = rgba(IMPACT_NEUTRAL_RING, a);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(IMPACT_INK[bin]!, a);
  } else {
    ctx.fillStyle = rgba(binStroke(bin), 0.28 * a);
    ctx.fill();
    ctx.lineWidth = lw * 1.25;
    ctx.strokeStyle = rgba(binStroke(bin), a);
    ctx.stroke();
    ctx.fillStyle = rgba(INK_LIGHT, a);
  }
  ctx.font = `700 ${size}px ${CANVAS_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + w / 2, y + h / 2 + size * 0.04);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

export function drawImpactNode(ctx: CanvasRenderingContext2D, n: GNode, x: number, y: number, o: NodeDrawOpts, c: ImpactCard, pill: PillRect | null = null): void {
  const left = x - HALF_W;
  const top = y - HALF_H;
  const a = o.alpha;
  const s = 1 / o.zoom;
  const isRoot = c.role === "root";
  const typeColor = NODE_TYPES[n.type].color;
  const fill = IMPACT_FILL[c.bin]!;
  // 枠の色: 段の色（ほぼ同じは灰色）。今日は目標の色のまま
  const stroke = isRoot ? typeColor : binStroke(c.bin);
  if (pill) pill.w = 0;

  if (o.lod === "dot") {
    ctx.fillStyle = rgba(fill, 0.85 * a);
    ctx.fillRect(left, top, NODE_W, NODE_H);
    return;
  }

  ctx.save();
  if (o.selected) {
    ctx.shadowColor = `rgba(221,229,245,${(0.6 * Math.max(a, 0.6)).toFixed(3)})`;
    ctx.shadowBlur = 26 * Math.min(1.4, Math.max(0.5, o.zoom)) * (globalThis.devicePixelRatio || 1);
  }
  nodePath(ctx, n.type, left, top);

  if (o.lod === "low") {
    // 段の色で塗る（形はそのまま）。真ん中に「+65」「35%」
    ctx.fillStyle = rgba(fill, 0.92 * a);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1.5, (o.selected ? 2.2 : 1.2) * s);
    ctx.strokeStyle = o.selected ? rgba(INK_LIGHT, Math.max(a, 0.8)) : rgba(stroke, 0.9 * a);
    ctx.stroke();
    if (c.role === "alt" && !c.base) drawProjectStripe(ctx, n.type, left, top, o.projectColors, a, o.zoom);
    if (o.zoom >= 0.19 && c.low) {
      let size = 12 * s;
      const maxW = NODE_W - 14;
      const w = textWidth(ctx, c.low, 700, size);
      if (w > maxW) size *= maxW / w;
      ctx.font = `700 ${size}px ${CANVAS_FONT}`;
      ctx.fillStyle = rgba(IMPACT_INK[c.bin]!, (c.dropped ? 0.6 : 1) * a);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(c.low, x, y + size * 0.04);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
    if (o.match) {
      nodePath(ctx, n.type, left - 10, top - 10, NODE_W + 20, NODE_H + 20);
      ctx.lineWidth = 2.5 * s;
      ctx.strokeStyle = "rgba(242,193,78,0.95)";
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  // full・compact: 暗いカードに段の色
  ctx.fillStyle = `rgba(17,22,32,${(0.97 * Math.max(a, 0.35)).toFixed(3)})`;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  if (a > 0.3) {
    ctx.save();
    nodePath(ctx, n.type, left, top);
    ctx.clip();
    if (o.lod === "compact" && !isRoot) {
      ctx.fillStyle = rgba(fill, 0.3 * a);
      ctx.fillRect(left, top, NODE_W, NODE_H);
    } else {
      const tint = isRoot ? typeColor : stroke;
      const g = ctx.createLinearGradient(0, top, 0, top + NODE_H);
      g.addColorStop(0, rgba(tint, 0.14 * a));
      g.addColorStop(0.6, rgba(tint, 0.02 * a));
      g.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = g;
      ctx.fillRect(left, top, NODE_W, NODE_H);
    }
    ctx.restore();
  }
  // 枠（基準＝今のままは破線）
  nodePath(ctx, n.type, left, top);
  ctx.lineWidth = o.selected ? Math.max(2.4, 2 * s) : Math.max(1.4, 1.1 * s);
  ctx.strokeStyle = rgba(stroke, (o.selected || o.hovered || o.dropTarget ? 1 : 0.9) * Math.max(a, o.selected ? 0.8 : 0));
  if (c.base || o.ghost || o.offScenario) {
    const k = Math.max(1, 0.8 * s);
    ctx.setLineDash([7 * k, 5 * k]);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  if (n.type === "goal") {
    ctx.beginPath();
    ctx.roundRect(left + 4, top + 4, NODE_W - 8, NODE_H - 8, 12);
    ctx.lineWidth = Math.max(1, 0.8 * s);
    ctx.strokeStyle = rgba(typeColor, 0.22 * a);
    ctx.stroke();
  }
  if (o.dropTarget) {
    nodePath(ctx, n.type, left - 5, top - 5, NODE_W + 10, NODE_H + 10);
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = "rgba(139,123,255,0.9)";
    ctx.stroke();
  }
  if (o.match) {
    nodePath(ctx, n.type, left - 6, top - 6, NODE_W + 12, NODE_H + 12);
    ctx.lineWidth = Math.max(2, 1.8 * s);
    ctx.strokeStyle = "rgba(242,193,78,0.95)";
    ctx.stroke();
  }
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  if (o.lod === "compact") drawCompact(ctx, n, left, top, o, c, s, pill);
  else drawFull(ctx, n, left, top, o, c, typeColor, pill);

  if (c.role === "alt" && !c.base) drawProjectStripe(ctx, n.type, left, top, o.projectColors, a, o.zoom);
  if (o.showBadge) drawBadge(ctx, x, y, o.collapsed, o.collapsedCount, typeColor, a, o.lod, o.zoom);
  ctx.restore();
}

/** compact（30〜80%）: 1 行目に札（と見込みの帯・★）、2 行目に短い名前（62% 以上はタイトル 2 行）。大きさは画面の px で決める */
function drawCompact(ctx: CanvasRenderingContext2D, n: GNode, left: number, top: number, o: NodeDrawOpts, c: ImpactCard, s: number, pill: PillRect | null): void {
  const a = o.alpha;
  const z = o.zoom;
  const hex = n.type === "branch";
  const f = z >= 0.5 ? 13 : z >= 0.45 ? 12 : 11;
  const size = f * s;
  // 札の高さは文字 + 5px（2 行目と、下の縁にかかる折りたたみの印が重ならないように詰める）
  const ph = (f + 5) * s;
  const x0 = left + (hex ? BRANCH_TEXT_INSET : 0) + 6 * s;
  const y0 = top + 4 * s;
  const rowRight = left + NODE_W - (hex ? BRANCH_TEXT_INSET : 0) - 6 * s;
  let cx = x0;
  const tag = c.pill ?? c.chip;
  if (tag) {
    const w = Math.min(rowRight - x0, textWidth(ctx, tag, 700, size) + 14 * s);
    drawTag(ctx, tag, x0, y0, w, ph, size, c.bin, c.pill !== null, (c.dropped ? 0.55 : 1) * a, 1.2 * s);
    if (pill) (pill.x = x0), (pill.y = y0), (pill.w = w), (pill.h = ph), (pill.font = size);
    cx = x0 + w;
  }
  // ★ は右端、見込みの帯はその間（16px 以上あるとき）
  let mw = 0;
  if (c.marks) {
    const ms = 12 * s;
    mw = marksWidth(ctx, c.marks, ms);
    ctx.textBaseline = "middle";
    drawMarks(ctx, c.marks, Math.max(cx + 4 * s, rowRight - mw), y0 + ph / 2, ms, a);
    ctx.textBaseline = "alphabetic";
  }
  if (c.role === "alt" && c.risk.length) {
    const rx0 = cx + 6 * s;
    const rx1 = rowRight - (mw ? mw + 4 * s : 0);
    if (rx1 - rx0 >= 16 * s) drawRisk(ctx, rx0, y0 + ph / 2 - 2 * s, rx1 - rx0, 4 * s, c.risk, a, 2 * s);
  }
  if (o.editing) return;
  // 2 行目: 62% 以上はタイトル 2 行、それより小さければ短い名前 1 行（45% 未満は少し小さく）
  const two = z >= 0.62;
  const fw = Math.round((z < 0.45 ? 10.5 : 11.5) * s * 2) / 2;
  ctx.font = `650 ${fw}px ${CANVAS_FONT}`;
  const maxW = Math.round(NODE_W - (hex ? BRANCH_TEXT_INSET : 0) * 2 - 12 * s);
  const text = two ? n.title.trim() || "（無題）" : c.short;
  const lines = wrapText(ctx, text, maxW, two ? 2 : 1);
  const lh = fw * 1.18;
  const first = y0 + ph + 2 * s + fw * 0.88;
  // カードの下（所属の帯）にかかる行は描かない（とても小さいときは札だけ）
  const limit = top + NODE_H - (c.role === "alt" ? Math.max(4, 2.6 * s) : 2 * s) - fw * 0.12;
  ctx.fillStyle = rgba(INK_LIGHT, (c.dropped ? 0.55 : 1) * a);
  lines.forEach((ln, i) => {
    const by = first + i * lh;
    if (by > limit) return;
    ctx.fillText(ln, x0, by);
    if (c.dropped) ctx.fillRect(x0, by - fw * 0.33, ctx.measureText(ln).width, Math.max(1, 0.9 * s));
  });
}

/** full（80% 以上）: 1 行目にアイコン・名前・印・札、タイトル 2 行、下の行に見込みの帯と 3 年後の月の差・週の時間（または選択肢の幅・3 年の稼ぎ） */
function drawFull(ctx: CanvasRenderingContext2D, n: GNode, left: number, top: number, o: NodeDrawOpts, c: ImpactCard, typeColor: string, pill: PillRect | null): void {
  const a = o.alpha;
  const hex = n.type === "branch";
  const inset = hex ? 22 : 15;
  const ix = left + (hex ? 33 : 22);
  const iy = top + 22;
  ctx.beginPath();
  ctx.arc(ix, iy, 11.5, 0, Math.PI * 2);
  ctx.fillStyle = rgba(typeColor, 0.17 * a);
  ctx.fill();
  drawTypeIcon(ctx, n.type, ix, iy, 14.5, rgba(typeColor, a));

  // 右上の札（右端は 204。六角形は 186）
  const right = left + (hex ? 186 : 204);
  let tagLeft = right;
  if (c.pill) {
    const w = Math.min(100, Math.max(44, textWidth(ctx, c.pill, 700, 14) + 18));
    tagLeft = right - w;
    drawTag(ctx, c.pill, tagLeft, top + 8, w, 24, 14, c.bin, true, (c.dropped ? 0.55 : 1) * a, 1.2);
    if (pill) (pill.x = tagLeft), (pill.y = top + 8), (pill.w = w), (pill.h = 24), (pill.font = 14);
  } else if (c.chip) {
    const w = Math.max(40, textWidth(ctx, c.chip, 700, 13) + 16);
    tagLeft = right - w;
    drawTag(ctx, c.chip, tagLeft, top + 9, w, 22, 13, c.role === "root" ? 0 : c.bin, false, a, 1.2);
    if (pill) (pill.x = tagLeft), (pill.y = top + 9), (pill.w = w), (pill.h = 22), (pill.font = 13);
  }

  // 1 行目: 領域（選択肢）・時期（結果）・今日、その後に ★/≒/✓
  const labelX = ix + 18;
  const mw = c.marks ? marksWidth(ctx, c.marks, 12) + 4 : 0;
  ctx.font = `650 11px ${CANVAS_FONT}`;
  const head = ellipsize(ctx, c.head, Math.max(10, tagLeft - 6 - labelX - mw));
  ctx.fillStyle = rgba(c.headColor ?? typeColor, 0.95 * a);
  ctx.fillText(head, labelX, top + 26);
  if (c.marks) drawMarks(ctx, c.marks, labelX + ctx.measureText(head).width + 4, top + 26.5, 12, a);

  // タイトル 2 行
  if (!o.editing) {
    ctx.font = `600 14px ${CANVAS_FONT}`;
    const title = n.title.trim() || "（無題）";
    const lines = wrapText(ctx, title, NODE_W - inset * 2, 2);
    ctx.fillStyle = n.title.trim() ? (c.dropped ? `rgba(160,168,184,${(0.7 * a).toFixed(3)})` : `rgba(238,241,247,${a.toFixed(3)})`) : `rgba(110,120,137,${a.toFixed(3)})`;
    lines.forEach((ln, i) => {
      const by = top + 50 + i * 18.5;
      ctx.fillText(ln, left + inset, by);
      if (c.dropped) ctx.fillRect(left + inset, by - 5, ctx.measureText(ln).width, 1.2);
    });
  }

  // 下の行（基線は top+85）。折りたたみの印があれば、その左まで（見込みの帯を少し短くして文を残す）
  const fy = top + 85;
  const badge = o.showBadge || o.collapsed;
  let tx = left + inset;
  if (c.role === "alt" && c.risk.length) {
    const rw = badge ? 44 : 56;
    drawRisk(ctx, left + 15, top + 79, rw, 6, c.risk, a, 2);
    tx = left + 15 + rw + 8;
  }
  if (c.bottom) {
    ctx.font = `500 11px ${CANVAS_FONT}`;
    const end = badge ? badgeCenter(left + HALF_W, top + HALF_H).x - (BADGE_W * badgeScale(o.zoom)) / 2 - 4 : left + NODE_W - inset;
    const maxW = end - tx;
    if (maxW > 16) {
      let t = c.bottom;
      if (ctx.measureText(t).width > maxW) t = c.bottomShort;
      ctx.fillStyle = `rgba(168,177,194,${a.toFixed(3)})`;
      ctx.fillText(ellipsize(ctx, t, maxW), tx, fy);
    }
  }
}
