// 無限キャンバス: 描画（画面内だけ・拡大率に応じて省略）・当たり判定・カメラ。設計: docs/DESIGN.md §6
// 位置はすべて vm.posOf（3 年の分かれ道の見えているノードは、開いている所だけで並べ直した重ねる位置）から読む

import type { ViewModel } from "../app/viewModel";
import type { UiState } from "../app/uiState";
import { NODE_TYPES } from "../model/constants";
import { edgeProb, formatPercent } from "../model/forecast";
import { IMPACT_FIRST_ZOOM, IMPACT_ROW } from "../model/impactLayout";
import { todayStr } from "../model/dates";
import type { GNode, ID, Relation } from "../model/types";
import type { Store } from "../store/store";
import { h } from "../ui/dom";
import { Camera } from "./camera";
import { badgeScale, drawEdge, drawEdgeLabel, drawNode, drawPort, drawStub, gridPattern, lodFor, rgba, type Lod } from "./draw";
import { BADGE_H, BADGE_W, HALF_H, HALF_W, badgeCenter, distToEdge, edgeGeom, inNode, rectsIntersect, type EdgeGeom } from "./geometry";
import { ImpactCards, binStroke } from "./impactCards";
import { drawImpactNode, type PillRect } from "./impactDraw";
import { onPixelRatioChange } from "./pixelRatio";
import { CANVAS_FONT, wrapText } from "./text";

export type Hit =
  | { kind: "port"; node: ID; side: "out" | "in" }
  | { kind: "badge"; node: ID }
  | { kind: "stub"; edge: ID }
  | { kind: "node"; node: ID }
  | { kind: "label"; edge: ID }
  | { kind: "edge"; edge: ID }
  | { kind: "empty" };

export interface ConnectPreview {
  sources: ID[];
  /** out: つまみのノードから出す / in: つまみのノードへ入れる */
  side: "out" | "in";
  anchor: ID;
  wx: number;
  wy: number;
  target: ID | null;
}

interface Box {
  id: ID;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 縮小したときの目印（画面の大きさで描く名前） */
interface ScreenLabel {
  x: number;
  y: number;
  /** 文。null ならノードの題名から描くときに作る（画面の外・数を超えた物は作らない） */
  text: string | null;
  n?: GNode;
  /** 未来の道筋の見込み（題名に添える） */
  reach?: number;
  color: string;
  alpha: number;
  rank: number;
  /** 文の前に付ける色の点（3 年の分かれ道の段の色） */
  dot: string | null;
  /** カードの左端にそろえる（3 年の分かれ道。列ごとに目印の頭がそろい、左の列の目印と重なりにくい） */
  left?: boolean;
}

/** 描いた札（画面座標。E2E の確かめ用。debugPills を [] にしたときだけ集める） */
export interface PillDebug {
  id: ID;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 文字の大きさ（画面の px） */
  font: number;
}

const PORT_SCREEN_R = 7;
/** 折りたたみの印を押せる大きさ（3 年の分かれ道。画面の px。指でも押せる大きさ） */
const BADGE_TOUCH_PX = 44;
const ORIGIN = { x: 0, y: 0 };

export class CanvasView {
  readonly root: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly camera = new Camera();
  width = 0;
  height = 0;
  dpr = 1;
  /** 動かしている途中のずれ（離すまでストアに書かない） */
  drag: { ids: Set<ID>; dx: number; dy: number } | null = null;
  connect: ConnectPreview | null = null;
  /** 範囲選択（画面座標） */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  editingId: ID | null = null;
  /** 直近の描画にかかった時間（ms） */
  lastFrameMs = 0;
  frames = 0;
  /** 画面の右・下にかぶる部品の大きさ（全体表示の余白に使う） */
  insets = { left: 40, right: 48, top: 60, bottom: 60 };
  /** 確かめ用（E2E）: [] にすると、描くたびに 3 年の分かれ道の選択肢の札の位置を集め直す。ふだんは null（集めない） */
  debugPills: PillDebug[] | null = null;
  /** 確かめ用（E2E の性能）: true なら描いた後に 1 画素読み、絵を描き終えるまで待ってから時間を測る（描く命令だけでなく塗りまで） */
  rasterFlush = false;

  private readonly ctx: CanvasRenderingContext2D;
  private scheduled = false;
  private camAnim: { from: { x: number; y: number; zoom: number }; to: { x: number; y: number; zoom: number }; start: number; ms: number } | null = null;
  private labelBoxes: Box[] = [];
  private stubBoxes: Box[] = [];
  private grid: { key: string; pattern: CanvasPattern | null } | null = null;
  private readonly cameraListeners = new Set<() => void>();
  private readonly renderListeners = new Set<() => void>();
  private readonly reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  private centerCache = { version: -1, revision: -1, y: 0 };
  /** 3 年の分かれ道のカード・線に書く物（計算の結果ごとに作る） */
  private readonly cards = new ImpactCards();
  private readonly pillTmp: PillRect = { x: 0, y: 0, w: 0, h: 0, font: 0 };

  constructor(
    private readonly store: Store,
    private readonly ui: UiState,
    private readonly vm: ViewModel,
  ) {
    this.canvas = h("canvas", { class: "graph-canvas", attrs: { "aria-label": "分岐のキャンバス", role: "application", tabindex: "0" } });
    this.root = h("div", { class: "canvas-wrap" }, this.canvas);
    const ctx = this.canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Canvas 2D が使えません");
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(this.root);
    onPixelRatioChange(() => this.resize());
    store.on("change", () => this.requestRender());
    ui.on("visual", () => this.requestRender());
    ui.on("hover", () => this.requestRender());
    ui.on("expand", (ids) => this.revealOpened(ids));
  }

  /** 直近の描画で出した線の札の数（確かめ用） */
  get labelCount(): number {
    return this.labelBoxes.length;
  }

  onCamera(fn: () => void): () => void {
    this.cameraListeners.add(fn);
    return () => this.cameraListeners.delete(fn);
  }

  onRender(fn: () => void): () => void {
    this.renderListeners.add(fn);
    return () => this.renderListeners.delete(fn);
  }

  /** カメラを動かしたら呼ぶ */
  cameraChanged(): void {
    for (const fn of this.cameraListeners) fn();
    this.requestRender();
  }

  resize(): void {
    const r = this.root.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    // 隠れている間（リスト表示など）は大きさ 0。カメラを壊さないように無視する
    if (r.width < 2 || r.height < 2) return;
    const w = Math.round(r.width);
    const hgt = Math.round(r.height);
    if (w === this.width && hgt === this.height && dpr === this.dpr) {
      this.runPendingFit();
      // 隠れていた間（リスト表示）は描いていないので、また出たら描き直す
      this.requestRender();
      return;
    }
    const first = this.width === 0;
    this.width = w;
    this.height = hgt;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hgt}px`;
    this.grid = null;
    if (first) this.cameraChanged();
    this.runPendingFit();
    this.requestRender();
  }

  private pendingFit: { ids?: Iterable<ID>; animate?: boolean; minZoom?: number; align?: "top-left" } | null = null;

  private get measurable(): boolean {
    return this.width > 1 && !this.root.hidden && this.root.isConnected;
  }

  private runPendingFit(): void {
    const p = this.pendingFit;
    if (!p || !this.measurable) return;
    this.pendingFit = null;
    this.fit(p.ids, { animate: p.animate, minZoom: p.minZoom, align: p.align });
  }

  requestRender(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame((t) => this.render(t));
  }

  /** 画面の中心のワールド座標 */
  viewCenter(): { x: number; y: number } {
    return this.camera.toWorld(this.width / 2, this.height / 2);
  }

  // ------------------------------------------------------------ カメラの動き

  animateTo(to: { x: number; y: number; zoom: number }, ms = 340): void {
    if (this.reducedMotion || ms <= 0) {
      this.camera.x = to.x;
      this.camera.y = to.y;
      this.camera.zoom = to.zoom;
      this.camAnim = null;
      this.cameraChanged();
      return;
    }
    this.camAnim = { from: { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom }, to, start: performance.now(), ms };
    this.requestRender();
  }

  private stepCamera(now: number): void {
    const a = this.camAnim;
    if (!a) return;
    const p = Math.min(1, (now - a.start) / a.ms);
    const e = 1 - Math.pow(1 - p, 3);
    const W = this.width / 2;
    const H = this.height / 2;
    // 画面の中心のワールド座標と拡大率（対数）を補間すると、まっすぐ寄っていく
    const c0 = { x: (W - a.from.x) / a.from.zoom, y: (H - a.from.y) / a.from.zoom };
    const c1 = { x: (W - a.to.x) / a.to.zoom, y: (H - a.to.y) / a.to.zoom };
    const zoom = Math.exp(Math.log(a.from.zoom) + (Math.log(a.to.zoom) - Math.log(a.from.zoom)) * e);
    const cx = c0.x + (c1.x - c0.x) * e;
    const cy = c0.y + (c1.y - c0.y) * e;
    this.camera.zoom = zoom;
    this.camera.x = W - cx * zoom;
    this.camera.y = H - cy * zoom;
    if (p >= 1) {
      // 最後はちょうど目標に（補間の丸めで 0.3 が 0.2999… になると、文字の出る大きさの境目を下回る）
      this.camera.zoom = a.to.zoom;
      this.camera.x = a.to.x;
      this.camera.y = a.to.y;
      this.camAnim = null;
    }
    for (const fn of this.cameraListeners) fn();
  }

  /**
   * 範囲が収まるように。minZoom: これより引かない（収まらなければ、範囲の左端を左の余白にそろえ、縦は範囲の中ほどに合わせる。
   * 狭い画面でも、左から読み進める範囲（未来の道筋の今日など）の入口を、文字の読める大きさで見せる）。
   * align "top-left": 範囲の左上を余白の左上にそろえる（3 年の分かれ道の今日と選択肢。上から読み進める）
   */
  fitBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, opts: { animate?: boolean; maxZoom?: number; minZoom?: number; align?: "top-left" } = {}): void {
    const box = { minX: b.minX - HALF_W, minY: b.minY - HALF_H, maxX: b.maxX + HALF_W, maxY: b.maxY + HALF_H };
    const t = this.camera.fitTarget(box, this.width, this.height, this.insets, opts.maxZoom ?? 1.05);
    if (opts.align === "top-left") {
      // 上の余白は左と同じくらいに詰める（スマホで 10 の選択肢の最後の印まで、右下の操作の上に入るように）
      const z = Math.max(t.zoom, opts.minZoom ?? 0);
      t.zoom = z;
      t.x = this.insets.left - box.minX * z;
      t.y = Math.min(this.insets.top, this.insets.left) - box.minY * z;
    } else if (opts.minZoom && t.zoom < opts.minZoom) {
      const z = opts.minZoom;
      const ah = Math.max(50, this.height - this.insets.top - this.insets.bottom);
      t.zoom = z;
      t.x = this.insets.left - box.minX * z;
      t.y = this.insets.top + ah / 2 - ((box.minY + box.maxY) / 2) * z;
    }
    this.animateTo(t, opts.animate === false ? 0 : 380);
  }

  /**
   * 全体（または指定したノード）が収まるように（minZoom・align は fitBounds と同じ）。
   * 3 年の分かれ道の今日と選択肢（開いた・読み込んだ・寄ったとき）なら、見えている物だけで、左上にそろえて 45% より引かない
   */
  fit(ids?: Iterable<ID>, opts: { animate?: boolean; minZoom?: number; align?: "top-left" } = {}): void {
    if (!this.measurable || this.root.getBoundingClientRect().width < 2) {
      this.pendingFit = { ids: ids ? [...ids] : undefined, animate: false, minZoom: opts.minZoom, align: opts.align };
      return;
    }
    const list = ids ? [...ids] : undefined;
    const b = this.vm.bounds(list);
    if (!b) {
      this.animateTo({ x: this.width / 2, y: this.height / 2, zoom: 1 }, opts.animate === false ? 0 : 300);
      return;
    }
    if (list && this.vm.isImpactEntry(list)) this.fitBounds(b, { ...opts, align: "top-left", minZoom: Math.max(opts.minZoom ?? 0, IMPACT_FIRST_ZOOM) });
    else this.fitBounds(b, opts);
  }

  /** ノードを画面の中ほどへ（小さすぎるときは寄る）。3 年の分かれ道で閉じた所の中なら、上流を開いて（見え方だけ）から */
  centerOn(id: ID, opts: { zoom?: number; animate?: boolean; onlyIfHidden?: boolean } = {}): void {
    if (!this.store.doc.nodes[id] || !this.measurable) return;
    this.vm.openPathTo(id);
    const n = this.vm.posOf(id);
    if (!n) return;
    if (opts.onlyIfHidden) {
      const s = this.camera.toScreen(n.x, n.y);
      const mx = HALF_W * this.camera.zoom + 30;
      const my = HALF_H * this.camera.zoom + 30;
      if (s.x > mx && s.x < this.width - mx && s.y > my && s.y < this.height - my && this.camera.zoom >= 0.45) return;
    }
    const zoom = opts.zoom ?? Math.max(this.camera.zoom, 0.8);
    const cx = (this.width - this.insets.right + this.insets.left) / 2;
    const cy = (this.height - this.insets.bottom + this.insets.top) / 2;
    this.animateTo({ zoom, x: cx - n.x * zoom, y: cy - n.y * zoom }, opts.animate === false ? 0 : 360);
  }

  /**
   * 3 年の分かれ道でノードを開いた: 開いて出てきた子が画面の外なら、そのノードと子が見える所へ動かす
   * （拡大率はそのまま。30% より小さければ 30% に。収まらなければ、開いたノードを左上に）
   */
  private revealOpened(ids: ID[]): void {
    if (!this.measurable || !ids.length) return;
    this.vm.ensure();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let anchor: { x: number; y: number } | null = null;
    let kids = 0;
    const add = (p: { x: number; y: number }) => {
      minX = Math.min(minX, p.x - HALF_W);
      maxX = Math.max(maxX, p.x + HALF_W);
      minY = Math.min(minY, p.y - HALF_H);
      maxY = Math.max(maxY, p.y + HALF_H);
    };
    for (const id of ids) {
      if (!this.vm.hasOverlay(id)) continue;
      const p = this.vm.posOf(id)!;
      anchor ??= p;
      add(p);
      for (const eid of this.vm.index.out.get(id) ?? []) {
        const e = this.store.doc.edges[eid];
        if (!e || this.vm.node(e.target).hidden || !this.vm.hasOverlay(e.target)) continue;
        add(this.vm.posOf(e.target)!);
        kids++;
      }
    }
    if (!anchor || !kids) return;
    const cam = this.camera;
    let z = cam.zoom;
    let x = cam.x;
    let y = cam.y;
    if (z < 0.3) {
      // 開いたノードの画面の位置を保ったまま 30% に
      const s = cam.toScreen(anchor.x, anchor.y);
      z = 0.3;
      x = s.x - anchor.x * z;
      y = s.y - anchor.y * z;
    }
    const L = this.insets.left;
    const T = this.insets.top;
    const R = this.width - this.insets.right;
    const B = this.height - this.insets.bottom;
    const sx0 = minX * z + x;
    const sx1 = maxX * z + x;
    const sy0 = minY * z + y;
    const sy1 = maxY * z + y;
    let dx = 0;
    let dy = 0;
    if (sx1 - sx0 > R - L) dx = L - sx0;
    else if (sx0 < L) dx = L - sx0;
    else if (sx1 > R) dx = R - sx1;
    if (sy1 - sy0 > B - T) dy = T - sy0;
    else if (sy0 < T) dy = T - sy0;
    else if (sy1 > B) dy = B - sy1;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && z === cam.zoom) return;
    this.animateTo({ zoom: z, x: x + dx, y: y + dy }, 320);
  }

  zoomBy(factor: number): void {
    this.camAnim = null;
    const z = this.camera.zoom;
    const target = Math.max(0.04, Math.min(2.5, z * factor));
    const W = this.width / 2;
    const H = this.height / 2;
    const k = target / z;
    this.animateTo({ zoom: target, x: W - (W - this.camera.x) * k, y: H - (H - this.camera.y) * k }, 180);
  }

  setZoom(z: number): void {
    this.zoomBy(z / this.camera.zoom);
  }

  stopCameraAnimation(): void {
    this.camAnim = null;
  }

  // ------------------------------------------------------------ 位置

  /** 描く位置（vm.posOf に、動かしている途中のずれを足す）。返す物は書き換えない */
  pos(id: ID): { x: number; y: number } {
    const p = this.vm.posOf(id) ?? ORIGIN;
    const d = this.drag;
    if (d && d.ids.has(id)) return { x: p.x + d.dx, y: p.y + d.dy };
    return p;
  }

  private portCandidates(): ID[] {
    const out: ID[] = [];
    if (this.ui.hover.node) out.push(this.ui.hover.node);
    if (this.ui.selection.nodes.size === 1) {
      const s = [...this.ui.selection.nodes][0]!;
      if (!out.includes(s)) out.push(s);
    }
    return out.filter((id) => this.store.doc.nodes[id] && !this.vm.node(id).hidden);
  }

  /**
   * 折りたたみの印を描くか。描画と当たり判定はこれだけで決める（描かれていない印は押せない）。
   * 折りたたみ中は full・compact で描く。出る線のあるノードのホバー・選択中の「−」は full だけ。low・dot では描かない。
   * 3 年の分かれ道は、選んでいるノードの「−」を compact でも描く（スマホで開いた所を閉じられるように）
   */
  private badgeVisible(id: ID, lod: Lod): boolean {
    if (lod !== "full" && lod !== "compact") return false;
    const n = this.store.doc.nodes[id];
    if (!n) return false;
    const nv = this.vm.nodes.get(id);
    if (nv?.collapsed || (nv?.collapsedCount ?? 0) > 0) return true;
    const selected = this.ui.selection.nodes.has(id);
    if (lod !== "full" && !(selected && this.vm.inImpact(id))) return false;
    const hasOut = (this.vm.index.out.get(id)?.length ?? 0) > 0;
    return hasOut && (this.ui.hover.node === id || selected);
  }

  // ------------------------------------------------------------ 当たり判定

  hitTest(sx: number, sy: number): Hit {
    this.vm.ensure();
    const z = this.camera.zoom;
    const w = this.camera.toWorld(sx, sy);
    const lod = lodFor(z);
    if (lod === "full" || lod === "compact") {
      const r = (PORT_SCREEN_R + 4) / z;
      for (const id of this.portCandidates()) {
        const p = this.pos(id);
        if (Math.hypot(w.x - (p.x + HALF_W), w.y - p.y) <= r) return { kind: "port", node: id, side: "out" };
        if (Math.hypot(w.x - (p.x - HALF_W), w.y - p.y) <= r) return { kind: "port", node: id, side: "in" };
      }
    }
    const badges = lod === "full" || lod === "compact";
    const k = badgeScale(z);
    // 描いた印（の周り 2px）
    const hw = (BADGE_W * k) / 2 + 2 / z;
    const hh = (BADGE_H * k) / 2 + 2 / z;
    if (badges) {
      for (let i = this.vm.drawNodes.length - 1; i >= 0; i--) {
        const id = this.vm.drawNodes[i]!;
        if (!this.badgeVisible(id, lod)) continue;
        const p = this.pos(id);
        const c = badgeCenter(p.x, p.y);
        if (Math.abs(w.x - c.x) <= hw && Math.abs(w.y - c.y) <= hh) return { kind: "badge", node: id };
      }
    }
    for (const b of this.stubBoxes) if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) return { kind: "stub", edge: b.id };
    for (let i = this.vm.drawNodes.length - 1; i >= 0; i--) {
      const id = this.vm.drawNodes[i]!;
      const p = this.pos(id);
      if (inNode(p.x, p.y, w.x, w.y, lod === "dot" ? 4 / z : 0)) return { kind: "node", node: id };
    }
    if (badges) {
      // 3 年の分かれ道の印は、指でも押せるようにカードの外へ広げる（画面で 44px の幅。下は次の行のカードの手前＝行の間 32 まで、右はカードの外まで）。
      // カードの中は描いた印の所だけ（カードを押して選ぶのを邪魔しない）。ここへ来た点はどのカードの中でもない
      const tw = Math.max(hw, BADGE_TOUCH_PX / 2 / z);
      const down = Math.min(Math.max(hh, BADGE_TOUCH_PX / 2 / z), Math.max(hh, IMPACT_ROW - HALF_H * 2));
      for (let i = this.vm.drawNodes.length - 1; i >= 0; i--) {
        const id = this.vm.drawNodes[i]!;
        if (!this.vm.inImpact(id) || !this.badgeVisible(id, lod)) continue;
        const p = this.pos(id);
        const c = badgeCenter(p.x, p.y);
        if (Math.abs(w.x - c.x) <= tw && w.y >= c.y - hh && w.y <= c.y + down) return { kind: "badge", node: id };
      }
    }
    for (let i = this.labelBoxes.length - 1; i >= 0; i--) {
      const b = this.labelBoxes[i]!;
      if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) return { kind: "label", edge: b.id };
    }
    const tol = 7 / z;
    for (let i = this.vm.drawEdges.length - 1; i >= 0; i--) {
      const id = this.vm.drawEdges[i]!;
      const g = this.geomOf(id);
      if (!g) continue;
      if (w.x < g.minX - tol || w.x > g.maxX + tol || w.y < g.minY - tol || w.y > g.maxY + tol) continue;
      if (distToEdge(g, w.x, w.y) <= tol) return { kind: "edge", edge: id };
    }
    return { kind: "empty" };
  }

  geomOf(edgeId: ID): EdgeGeom | null {
    const doc = this.store.doc;
    const e = doc.edges[edgeId];
    if (!e || !doc.nodes[e.source] || !doc.nodes[e.target]) return null;
    return this.geomBetween(e.source, e.target);
  }

  /** グラフの縦の中ほど（戻る線を外側へ回すため） */
  private graphCenterY(): number {
    const c = this.centerCache;
    if (c.version !== this.vm.version || c.revision !== this.store.revision) {
      const b = this.vm.bounds();
      c.y = b ? (b.minY + b.maxY) / 2 : 0;
      c.version = this.vm.version;
      c.revision = this.store.revision;
    }
    return c.y;
  }

  private geomBetween(a: ID, b: ID): EdgeGeom {
    const pa = this.pos(a);
    const pb = this.pos(b);
    const side = (pa.y + pb.y) / 2 < this.graphCenterY() ? -1 : 1;
    return edgeGeom(pa.x, pa.y, pb.x, pb.y, side);
  }

  /** 範囲選択（画面座標の四角に重なる表示中のノード） */
  nodesInScreenRect(x0: number, y0: number, x1: number, y1: number): ID[] {
    const a = this.camera.toWorld(Math.min(x0, x1), Math.min(y0, y1));
    const b = this.camera.toWorld(Math.max(x0, x1), Math.max(y0, y1));
    const out: ID[] = [];
    for (const id of this.vm.drawNodes) {
      const n = this.pos(id);
      if (n.x + HALF_W >= a.x && n.x - HALF_W <= b.x && n.y + HALF_H >= a.y && n.y - HALF_H <= b.y) out.push(id);
    }
    return out;
  }

  // ------------------------------------------------------------ 描画

  private drawGrid(): void {
    const z = this.camera.zoom;
    let spacing = 32;
    while (spacing * z < 16) spacing *= 4;
    const px = spacing * z * this.dpr;
    const fade = Math.min(1, (spacing * z - 16) / 24 + 0.35);
    const key = `${px.toFixed(2)}|${this.dpr}|${fade.toFixed(2)}`;
    if (!this.grid || this.grid.key !== key) this.grid = { key, pattern: gridPattern(this.ctx, px, Math.max(1, this.dpr * 1.1), 0.16 * fade) };
    const pat = this.grid.pattern;
    if (!pat) return;
    const ox = ((this.camera.x * this.dpr) % px) - px + this.dpr * 1.1;
    const oy = ((this.camera.y * this.dpr) % px) - px + this.dpr * 1.1;
    pat.setTransform(new DOMMatrix([px / Math.round(px), 0, 0, px / Math.round(px), ox, oy]));
    this.ctx.fillStyle = pat;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private render(now: number): void {
    this.scheduled = false;
    // 隠れている間（リスト表示）は描かない（流れの動きで毎フレーム描き続けない）。また出たら resize() から描き直す
    if (this.width === 0 || this.root.hidden) return;
    const t0 = performance.now();
    this.stepCamera(now);
    this.vm.ensure();
    const ctx = this.ctx;
    const dpr = this.dpr;
    const cam = this.camera;
    const z = cam.zoom;
    const prefs = this.ui.prefs;
    const doc = this.store.doc;
    const vm = this.vm;
    const sel = this.ui.selection;
    const hover = this.ui.hover;
    const lod = lodFor(z);
    const today = todayStr();
    // 3 年の分かれ道（無ければ active = false。文書・シナリオが変わらなければ前の計算をそのまま使う）
    const imp = vm.impact;
    const cards = this.cards;
    const pills: PillDebug[] | null = this.debugPills ? (this.debugPills = []) : null;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (prefs.showGrid) this.drawGrid();
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * cam.x, dpr * cam.y);
    const margin = 60 / z;
    const view = { minX: -cam.x / z - margin, minY: -cam.y / z - margin, maxX: (this.width - cam.x) / z + margin, maxY: (this.height - cam.y) / z + margin };
    const flowT = prefs.animate && !this.reducedMotion && (vm.pathActive || sel.edges.size > 0) ? now : null;
    let animating = false;

    // 接続
    const labels: Array<{ id: ID; g: EdgeGeom; text: string; rel: Relation; alpha: number; emph: boolean; color?: string; maxW?: number; bold?: boolean }> = [];
    for (const eid of vm.drawEdges) {
      const e = doc.edges[eid]!;
      const g = this.geomBetween(e.source, e.target);
      if (!rectsIntersect(g, view)) continue;
      const ev = vm.edges.get(eid)!;
      const selected = sel.edges.has(eid);
      const hovered = hover.edge === eid;
      const ie = imp.active ? cards.edge(imp, doc, eid) : null;
      if (ie) {
        // 3 年の分かれ道: 判断の線は控えめ（★ の線を強く・基準の線は薄く）、結果の線はその結果の色で、見込みの太さ。
        // 縮小すると、選び方の道（π）だけを濃く
        const pi = imp.piEdges.has(eid);
        const k = lod === "low" ? (pi ? 1 : 0.25) : lod === "dot" ? (pi ? 0.8 : 0.1) : ie.alpha;
        drawEdge(ctx, g, { lod, zoom: z, alpha: ev.alpha, relation: e.relation, selected, hovered, path: ev.path, cross: false, offScenario: ev.offScenario, flowT, style: ie.style, styleAlpha: k });
        if (flowT !== null && (ev.path || selected) && lod !== "low" && lod !== "dot") animating = true;
        if (lod === "full" || lod === "compact") {
          if (ie.kind === "chance") {
            // 「35%」（大きく見ているとき・選んだ・ホバーは「35%｜判断の線」）
            const long = lod === "full" || selected || hovered;
            const text = long ? ie.long : ie.pct;
            if (text && ((prefs.showLabels && ev.alpha > 0.25) || selected || hovered)) labels.push({ id: eid, g, text, rel: e.relation, alpha: Math.max(ev.alpha, selected || hovered ? 1 : 0), emph: selected || hovered || ev.path, color: ie.color, maxW: 170, bold: !long });
          } else if (selected || hovered) {
            // 判断の線にはふだん札を付けない（自分で書いた説明は、選んだ・ホバーしたときだけ）
            const text = e.condition.trim() || e.label.trim();
            if (text) labels.push({ id: eid, g, text, rel: e.relation, alpha: 1, emph: true });
          }
        }
        continue;
      }
      drawEdge(ctx, g, { lod, zoom: z, alpha: ev.alpha, relation: e.relation, selected, hovered, path: ev.path, cross: ev.cross, offScenario: ev.offScenario, flowT });
      if (flowT !== null && (ev.path || selected) && lod !== "low" && lod !== "dot") animating = true;
      // 分かれ道の線は見込み（%）を先頭に出す（長い条件が省略されても見込みは見える）
      const base = e.condition.trim() || e.label.trim();
      const prob = edgeProb(e);
      const text = prob === null ? base : base ? `${prob}%｜${base}` : `${prob}%`;
      // 見込みのある分かれ道の線は、少し縮小しても読めるように早めに出す
      if (text && (lod === "full" || lod === "compact") && ((prefs.showLabels && z >= (prob === null ? 0.55 : 0.4) && ev.alpha > 0.25) || selected || hovered)) {
        labels.push({ id: eid, g, text, rel: e.relation, alpha: Math.max(ev.alpha, selected || hovered ? 1 : 0), emph: selected || hovered || ev.path });
      }
    }
    // 折りたたんだ接続
    this.stubBoxes = [];
    if (lod === "full" || lod === "compact") {
      const perSource = new Map<ID, number>();
      for (const s of vm.stubEdges) {
        const e = doc.edges[s.id]!;
        const k = perSource.get(e.source) ?? 0;
        perSource.set(e.source, k + 1);
        const p = this.pos(e.source);
        const box = drawStub(ctx, p.x, p.y + k * 24 - 10 * Math.min(k, 1), s.count, e.relation, vm.node(e.source).alpha);
        this.stubBoxes.push({ id: s.id, ...box });
      }
    }
    this.labelBoxes = [];
    for (const l of labels) this.labelBoxes.push({ id: l.id, ...drawEdgeLabel(ctx, l.g, l.text, l.rel, l.alpha, l.emph, z, l.color ? { color: l.color, maxW: l.maxW, bold: l.bold } : {}) });

    // 接続をつくっている途中の線
    const cp = this.connect;
    if (cp) {
      const an = doc.nodes[cp.anchor];
      if (an) {
        const p = this.pos(an.id);
        const tgt = cp.target ? doc.nodes[cp.target] : null;
        let g: EdgeGeom;
        if (cp.side === "out") g = tgt ? this.geomBetween(an.id, tgt.id) : edgeGeom(p.x, p.y, cp.wx + HALF_W, cp.wy);
        else g = tgt ? this.geomBetween(tgt.id, an.id) : edgeGeom(cp.wx - HALF_W, cp.wy, p.x, p.y);
        ctx.save();
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = "rgba(165,151,255,0.95)";
        ctx.lineWidth = Math.max(2, 1.5 / z);
        ctx.beginPath();
        ctx.moveTo(g.x0, g.y0);
        ctx.bezierCurveTo(g.c1x, g.c1y, g.c2x, g.c2y, g.x3, g.y3);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ノード
    const fc = vm.forecast;
    const screenLabels: ScreenLabel[] = [];
    const impLabels: ScreenLabel[] = [];
    const ranks = imp.active && (lod === "low" || lod === "dot") ? cards.labelRank(imp, doc, (id) => fc.reach.get(id)?.p ?? 0) : null;
    const pillBox = this.pillTmp;
    for (const id of vm.drawNodes) {
      const n = doc.nodes[id]!;
      const p = this.pos(id);
      if (p.x + HALF_W < view.minX || p.x - HALF_W > view.maxX || p.y + HALF_H < view.minY || p.y - HALF_H > view.maxY) continue;
      const nv = vm.nodes.get(id)!;
      const colors: string[] = [];
      for (const pid of n.projectIds) {
        const c = doc.projects[pid]?.color;
        if (c) colors.push(c);
      }
      const selected = sel.nodes.has(id);
      const card = imp.active ? cards.card(imp, doc, id) : null;
      const opts = {
        lod,
        zoom: z,
        alpha: selected ? Math.max(nv.alpha, 0.85) : nv.alpha,
        selected,
        hovered: hover.node === id,
        match: nv.match,
        ghost: nv.ghost,
        offScenario: nv.offScenario,
        dropTarget: cp?.target === id,
        editing: this.editingId === id,
        projectColors: colors,
        collapsedCount: nv.collapsedCount,
        collapsed: nv.collapsed,
        showBadge: this.badgeVisible(id, lod),
        today,
        reach: fc.active ? fc.reach.get(id)?.p : undefined,
      };
      if (card) {
        drawImpactNode(ctx, n, p.x, p.y, opts, card, pills ? pillBox : null);
        if (pills && pillBox.w > 0 && card.pill) pills.push({ id, text: card.pill, x: pillBox.x * z + cam.x, y: pillBox.y * z + cam.y, w: pillBox.w * z, h: pillBox.h * z, font: pillBox.font * z });
        if (lod === "low" || lod === "dot") {
          // 縮小したときの目印: 選択中 > 検索の当たり > 今日の選択肢 > ★ の選択肢 > 見込みの高い行き先（一番小さくしたときは今日と行き先 5 つ）
          const r = selected ? 0 : nv.match ? 1 : (ranks?.get(id) ?? -1);
          const text = lod === "dot" ? card.dotLabel || card.label : card.label;
          if (r >= 0 && text && (lod === "low" || r <= 1 || card.role === "root" || card.role === "end")) {
            impLabels.push({ x: p.x, y: p.y, text, color: "#EEF1F7", alpha: nv.alpha, rank: card.role === "root" && lod === "dot" ? -1 : r, dot: card.role === "root" ? null : binStroke(card.bin), left: true });
          }
        }
        continue;
      }
      drawNode(ctx, n, p.x, p.y, opts);
      if ((lod === "low" || lod === "dot") && (n.type === "goal" || selected || nv.match)) screenLabels.push({ x: p.x, y: p.y, text: null, n, reach: fc.active ? fc.reach.get(id)?.p : undefined, color: NODE_TYPES[n.type].color, alpha: nv.alpha, rank: selected ? 0 : nv.match ? 1 : 2, dot: null });
    }
    // つまみ
    if (lod === "full" || lod === "compact") {
      const r = PORT_SCREEN_R / z;
      for (const id of this.portCandidates()) {
        const n = doc.nodes[id]!;
        const p = this.pos(id);
        const color = NODE_TYPES[n.type].color;
        drawPort(ctx, p.x + HALF_W, p.y, r, color, cp?.anchor === id && cp.side === "out");
        drawPort(ctx, p.x - HALF_W, p.y, r * 0.82, rgba(color, 0.8), cp?.anchor === id && cp.side === "in");
      }
    }

    // 画面の大きさで描く文字（縮小したときのタイトル・目印）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (impLabels.length) this.drawScreenLabels(impLabels, lod === "dot" ? 6 : 80);
    if (screenLabels.length) this.drawScreenLabels(screenLabels, 80);

    // 範囲選択
    const m = this.marquee;
    if (m) {
      const x = Math.min(m.x0, m.x1);
      const y = Math.min(m.y0, m.y1);
      ctx.fillStyle = "rgba(139,123,255,0.08)";
      ctx.strokeStyle = "rgba(139,123,255,0.85)";
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    }

    if (this.rasterFlush) ctx.getImageData(0, 0, 1, 1);
    this.lastFrameMs = performance.now() - t0;
    this.frames++;
    for (const fn of this.renderListeners) fn();
    if (this.camAnim || animating) this.requestRender();
  }

  /** ふつうの地図の目印の文（題名。未来の道筋の行き先などは見込みを添える）。ctx.font は呼ぶ側で 12px にしておく */
  private plainText(n: GNode, reach: number | undefined): string {
    const title = wrapText(this.ctx, n.title.trim() || "（無題）", 180, 1)[0] ?? "";
    return reach !== undefined && reach < 0.9995 ? `${title}（${formatPercent(reach)}）` : title;
  }

  /** 縮小したときの目印（画面の大きさで）。重なる名前は出さない（大事なものから置く）。cap まで */
  private drawScreenLabels(items: ScreenLabel[], cap: number): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const cam = this.camera;
    ctx.textBaseline = "alphabetic";
    ctx.font = `650 12px ${CANVAS_FONT}`;
    ctx.lineJoin = "round";
    items.sort((a, b) => a.rank - b.rank || b.alpha - a.alpha);
    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    let shown = 0;
    for (const it of items) {
      if (shown >= cap) break;
      const sx = it.x * z + cam.x;
      const sy = (it.y - HALF_H) * z + cam.y - 6;
      if (sx < -100 || sx > this.width + 100 || sy < -20 || sy > this.height + 20) continue;
      const text = it.text ?? this.plainText(it.n!, it.reach);
      const w = ctx.measureText(text).width;
      const dw = it.dot ? 12 : 0;
      const left = it.left ? sx - HALF_W * z : sx - (w + dw) / 2;
      const box = { x0: left - 4, y0: sy - 14, x1: left + w + dw + 4, y1: sy + 4 };
      if (it.rank > 0 && placed.some((b) => b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0)) continue;
      placed.push(box);
      shown++;
      if (it.dot) {
        ctx.beginPath();
        ctx.arc(left + 4, sy - 4, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(7,9,13,0.92)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(left + 4, sy - 4, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = rgba(it.dot, Math.max(0.5, it.alpha));
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(7,9,13,0.92)";
      ctx.lineWidth = 4;
      ctx.strokeText(text, left + dw, sy);
      ctx.fillStyle = rgba(it.color, Math.max(0.4, it.alpha));
      ctx.fillText(text, left + dw, sy);
    }
  }
}
