// 無限キャンバス: 描画（画面内だけ・拡大率に応じて省略）・当たり判定・カメラ。設計: docs/DESIGN.md §6

import type { ViewModel } from "../app/viewModel";
import type { UiState } from "../app/uiState";
import { NODE_TYPES } from "../model/constants";
import { todayStr } from "../model/dates";
import type { GNode, ID, Relation } from "../model/types";
import type { Store } from "../store/store";
import { h } from "../ui/dom";
import { Camera } from "./camera";
import { badgeScale, drawEdge, drawEdgeLabel, drawNode, drawPort, drawStub, gridPattern, lodFor, rgba, type Lod } from "./draw";
import { BADGE_H, BADGE_W, HALF_H, HALF_W, badgeCenter, distToEdge, edgeGeom, inNode, rectsIntersect, type EdgeGeom } from "./geometry";
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

const PORT_SCREEN_R = 7;

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

  private pendingFit: { ids?: Iterable<ID>; animate?: boolean } | null = null;

  private get measurable(): boolean {
    return this.width > 1 && !this.root.hidden && this.root.isConnected;
  }

  private runPendingFit(): void {
    const p = this.pendingFit;
    if (!p || !this.measurable) return;
    this.pendingFit = null;
    this.fit(p.ids, { animate: p.animate });
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
    if (p >= 1) this.camAnim = null;
    for (const fn of this.cameraListeners) fn();
  }

  fitBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, opts: { animate?: boolean; maxZoom?: number } = {}): void {
    const t = this.camera.fitTarget({ minX: b.minX - HALF_W, minY: b.minY - HALF_H, maxX: b.maxX + HALF_W, maxY: b.maxY + HALF_H }, this.width, this.height, this.insets, opts.maxZoom ?? 1.05);
    this.animateTo(t, opts.animate === false ? 0 : 380);
  }

  /** 全体（または指定したノード）が収まるように */
  fit(ids?: Iterable<ID>, opts: { animate?: boolean } = {}): void {
    if (!this.measurable || this.root.getBoundingClientRect().width < 2) {
      this.pendingFit = { ids: ids ? [...ids] : undefined, animate: false };
      return;
    }
    const b = this.vm.bounds(ids);
    if (!b) {
      this.animateTo({ x: this.width / 2, y: this.height / 2, zoom: 1 }, opts.animate === false ? 0 : 300);
      return;
    }
    this.fitBounds(b, opts);
  }

  /** ノードを画面の中ほどへ（小さすぎるときは寄る） */
  centerOn(id: ID, opts: { zoom?: number; animate?: boolean; onlyIfHidden?: boolean } = {}): void {
    const n = this.store.doc.nodes[id];
    if (!n || !this.measurable) return;
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

  pos(id: ID, n: GNode): { x: number; y: number } {
    const d = this.drag;
    if (d && d.ids.has(id)) return { x: n.x + d.dx, y: n.y + d.dy };
    return n;
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
   * 折りたたみ中は full・compact で描く。出る線のあるノードのホバー・選択中の「−」は full だけ。low・dot では描かない
   */
  private badgeVisible(id: ID, lod: Lod): boolean {
    if (lod !== "full" && lod !== "compact") return false;
    const n = this.store.doc.nodes[id];
    if (!n) return false;
    if (n.collapsed || (this.vm.nodes.get(id)?.collapsedCount ?? 0) > 0) return true;
    if (lod !== "full") return false;
    const hasOut = (this.vm.index.out.get(id)?.length ?? 0) > 0;
    return hasOut && (this.ui.hover.node === id || this.ui.selection.nodes.has(id));
  }

  // ------------------------------------------------------------ 当たり判定

  hitTest(sx: number, sy: number): Hit {
    this.vm.ensure();
    const doc = this.store.doc;
    const z = this.camera.zoom;
    const w = this.camera.toWorld(sx, sy);
    const lod = lodFor(z);
    if (lod === "full" || lod === "compact") {
      const r = (PORT_SCREEN_R + 4) / z;
      for (const id of this.portCandidates()) {
        const n = doc.nodes[id]!;
        const p = this.pos(id, n);
        if (Math.hypot(w.x - (p.x + HALF_W), w.y - p.y) <= r) return { kind: "port", node: id, side: "out" };
        if (Math.hypot(w.x - (p.x - HALF_W), w.y - p.y) <= r) return { kind: "port", node: id, side: "in" };
      }
    }
    if (lod === "full" || lod === "compact") {
      const k = badgeScale(z);
      for (let i = this.vm.drawNodes.length - 1; i >= 0; i--) {
        const id = this.vm.drawNodes[i]!;
        if (!this.badgeVisible(id, lod)) continue;
        const n = doc.nodes[id]!;
        const p = this.pos(id, n);
        const c = badgeCenter(p.x, p.y);
        if (Math.abs(w.x - c.x) <= (BADGE_W * k) / 2 + 2 / z && Math.abs(w.y - c.y) <= (BADGE_H * k) / 2 + 2 / z) return { kind: "badge", node: id };
      }
    }
    for (const b of this.stubBoxes) if (w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h) return { kind: "stub", edge: b.id };
    for (let i = this.vm.drawNodes.length - 1; i >= 0; i--) {
      const id = this.vm.drawNodes[i]!;
      const n = doc.nodes[id]!;
      const p = this.pos(id, n);
      if (inNode(p.x, p.y, w.x, w.y, lod === "dot" ? 4 / z : 0)) return { kind: "node", node: id };
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
    const a = e && doc.nodes[e.source];
    const b = e && doc.nodes[e.target];
    if (!a || !b) return null;
    return this.geomBetween(a, b);
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

  private geomBetween(a: GNode, b: GNode): EdgeGeom {
    const pa = this.pos(a.id, a);
    const pb = this.pos(b.id, b);
    const side = (pa.y + pb.y) / 2 < this.graphCenterY() ? -1 : 1;
    return edgeGeom(pa.x, pa.y, pb.x, pb.y, side);
  }

  /** 範囲選択（画面座標の四角に重なる表示中のノード） */
  nodesInScreenRect(x0: number, y0: number, x1: number, y1: number): ID[] {
    const a = this.camera.toWorld(Math.min(x0, x1), Math.min(y0, y1));
    const b = this.camera.toWorld(Math.max(x0, x1), Math.max(y0, y1));
    const out: ID[] = [];
    const doc = this.store.doc;
    for (const id of this.vm.drawNodes) {
      const n = doc.nodes[id]!;
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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (prefs.showGrid) this.drawGrid();
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * cam.x, dpr * cam.y);
    const margin = 60 / z;
    const view = { minX: -cam.x / z - margin, minY: -cam.y / z - margin, maxX: (this.width - cam.x) / z + margin, maxY: (this.height - cam.y) / z + margin };
    const flowT = prefs.animate && !this.reducedMotion && (vm.pathActive || sel.edges.size > 0) ? now : null;
    let animating = false;

    // 接続
    const labels: Array<{ id: ID; g: EdgeGeom; text: string; rel: Relation; alpha: number; emph: boolean }> = [];
    for (const eid of vm.drawEdges) {
      const e = doc.edges[eid]!;
      const a = doc.nodes[e.source]!;
      const b = doc.nodes[e.target]!;
      const g = this.geomBetween(a, b);
      if (!rectsIntersect(g, view)) continue;
      const ev = vm.edges.get(eid)!;
      const selected = sel.edges.has(eid);
      const hovered = hover.edge === eid;
      drawEdge(ctx, g, { lod, zoom: z, alpha: ev.alpha, relation: e.relation, selected, hovered, path: ev.path, cross: ev.cross, offScenario: ev.offScenario, flowT });
      if (flowT !== null && (ev.path || selected) && lod !== "low" && lod !== "dot") animating = true;
      const text = e.condition.trim() || e.label.trim();
      if (text && (lod === "full" || lod === "compact") && ((prefs.showLabels && z >= 0.55 && ev.alpha > 0.25) || selected || hovered)) {
        labels.push({ id: eid, g, text, rel: e.relation, alpha: Math.max(ev.alpha, selected || hovered ? 1 : 0), emph: selected || hovered || ev.path });
      }
    }
    // 折りたたんだ接続
    this.stubBoxes = [];
    if (lod === "full" || lod === "compact") {
      const perSource = new Map<ID, number>();
      for (const s of vm.stubEdges) {
        const e = doc.edges[s.id]!;
        const a = doc.nodes[e.source]!;
        const k = perSource.get(a.id) ?? 0;
        perSource.set(a.id, k + 1);
        const p = this.pos(a.id, a);
        const box = drawStub(ctx, p.x, p.y + k * 24 - 10 * Math.min(k, 1), s.count, e.relation, vm.node(a.id).alpha);
        this.stubBoxes.push({ id: s.id, ...box });
      }
    }
    this.labelBoxes = [];
    for (const l of labels) this.labelBoxes.push({ id: l.id, ...drawEdgeLabel(ctx, l.g, l.text, l.rel, l.alpha, l.emph, z) });

    // 接続をつくっている途中の線
    const cp = this.connect;
    if (cp) {
      const an = doc.nodes[cp.anchor];
      if (an) {
        const p = this.pos(an.id, an);
        const tgt = cp.target ? doc.nodes[cp.target] : null;
        let g: EdgeGeom;
        if (cp.side === "out") g = tgt ? this.geomBetween(an, tgt) : edgeGeom(p.x, p.y, cp.wx + HALF_W, cp.wy);
        else g = tgt ? this.geomBetween(tgt, an) : edgeGeom(cp.wx - HALF_W, cp.wy, p.x, p.y);
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
    const screenLabels: Array<{ n: GNode; x: number; y: number; alpha: number; rank: number }> = [];
    for (const id of vm.drawNodes) {
      const n = doc.nodes[id]!;
      const p = this.pos(id, n);
      if (p.x + HALF_W < view.minX || p.x - HALF_W > view.maxX || p.y + HALF_H < view.minY || p.y - HALF_H > view.maxY) continue;
      const nv = vm.nodes.get(id)!;
      const colors: string[] = [];
      for (const pid of n.projectIds) {
        const c = doc.projects[pid]?.color;
        if (c) colors.push(c);
      }
      const selected = sel.nodes.has(id);
      drawNode(ctx, n, p.x, p.y, {
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
        showBadge: this.badgeVisible(id, lod),
        today,
      });
      if ((lod === "low" || lod === "dot") && (n.type === "goal" || selected || nv.match)) screenLabels.push({ n, x: p.x, y: p.y, alpha: nv.alpha, rank: selected ? 0 : nv.match ? 1 : 2 });
    }
    // つまみ
    if (lod === "full" || lod === "compact") {
      const r = PORT_SCREEN_R / z;
      for (const id of this.portCandidates()) {
        const n = doc.nodes[id]!;
        const p = this.pos(id, n);
        const color = NODE_TYPES[n.type].color;
        drawPort(ctx, p.x + HALF_W, p.y, r, color, cp?.anchor === id && cp.side === "out");
        drawPort(ctx, p.x - HALF_W, p.y, r * 0.82, rgba(color, 0.8), cp?.anchor === id && cp.side === "in");
      }
    }

    // 画面の大きさで描く文字（縮小したときのタイトル・目印）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (screenLabels.length) this.drawScreenLabels(screenLabels);

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

    this.lastFrameMs = performance.now() - t0;
    this.frames++;
    for (const fn of this.renderListeners) fn();
    if (this.camAnim || animating) this.requestRender();
  }

  /** 縮小したときの目印（目標・選択中・検索の当たりの名前を画面の大きさで） */
  private drawScreenLabels(items: Array<{ n: GNode; x: number; y: number; alpha: number; rank: number }>): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const cam = this.camera;
    ctx.textBaseline = "alphabetic";
    ctx.font = `650 12px ${CANVAS_FONT}`;
    ctx.lineJoin = "round";
    // 重なる名前は出さない（大事なものから置く）。多いときは画面の格子で数を抑える
    items.sort((a, b) => a.rank - b.rank || b.alpha - a.alpha);
    const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
    let shown = 0;
    for (const it of items) {
      if (shown >= 80) break;
      const sx = it.x * z + cam.x;
      const sy = (it.y - HALF_H) * z + cam.y - 6;
      if (sx < -100 || sx > this.width + 100 || sy < -20 || sy > this.height + 20) continue;
      const text = wrapText(ctx, it.n.title.trim() || "（無題）", 180, 1)[0] ?? "";
      const w = ctx.measureText(text).width;
      const box = { x0: sx - w / 2 - 4, y0: sy - 14, x1: sx + w / 2 + 4, y1: sy + 4 };
      if (it.rank > 0 && placed.some((b) => b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0)) continue;
      placed.push(box);
      shown++;
      ctx.strokeStyle = "rgba(7,9,13,0.92)";
      ctx.lineWidth = 4;
      ctx.strokeText(text, sx - w / 2, sy);
      ctx.fillStyle = rgba(NODE_TYPES[it.n.type].color, Math.max(0.4, it.alpha));
      ctx.fillText(text, sx - w / 2, sy);
    }
  }
}
