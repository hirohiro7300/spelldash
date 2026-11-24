// 無限キャンバス: 描画（画面内だけ・拡大率に応じて省略）・当たり判定・カメラ。設計: docs/DESIGN.md §6
// 位置はすべて vm.posOf（3 年の分かれ道の見えているノードは、開いている所だけで並べ直した重ねる位置）から読む

import type { ViewModel } from "../app/viewModel";
import type { UiState } from "../app/uiState";
import { NODE_TYPES } from "../model/constants";
import { edgeProb, formatPercent, reachP, type ForecastResult } from "../model/forecast";
import { quarterSpanText, ymText } from "../deepmap/core/time";
import { IMPACT_FIRST_ZOOM, IMPACT_ROW, impactColX } from "../model/impactLayout";
import { todayStr } from "../model/dates";
import { goalName, type GoalTables } from "../model/goal";
import type { DocData, GNode, ID, Relation } from "../model/types";
import type { Store } from "../store/store";
import { h } from "../ui/dom";
import { Camera } from "./camera";
import { badgeScale, drawEdge, drawEdgeLabel, drawNode, drawPort, drawStub, gridPattern, lodFor, rgba, type Lod } from "./draw";
import { BADGE_H, BADGE_W, HALF_H, HALF_W, badgeCenter, distToEdge, edgeGeom, inNode, labelMaxW, rectsIntersect, type EdgeGeom } from "./geometry";
import { ImpactCards, binStroke } from "./impactCards";
import { drawImpactNode, type PillRect } from "./impactDraw";
import { GOAL_RAIL_DX, GoalRail } from "./goalRail";
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

/** 選んだ物を変えてから、線の流れの動きを始めるまで（ms） */
const FLOW_HOLD_MS = 250;

/** 画面の px の箱 */
interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
  /** 文の幅の上限（画面の px。次の列のカードの手前まで。超えたら「…」で切る: 見直し user-9） */
  maxW?: number;
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
/** 年月の目盛りの帯の高さ（画面の px） */
const RULER_H = 26;
/** 折りたたみの印を押せる大きさ（3 年の分かれ道。画面の px。指でも押せる大きさ） */
const BADGE_TOUCH_PX = 44;
const ORIGIN = { x: 0, y: 0 };
/**
 * スマホ（狭い画面）でまとめて開いた後の拡大率の下限。3 か月ごとの地図のカードは 37% 以上で題名の 1 行を描く（それより小さいと札だけ）。
 * 題名が読める大きさ（画面で約 11px）に保つ（作業メモ bulk 見直しの残り 1: 30% で引くと、今日から下へ伸びる線しか見えなかった）
 */
export const PHONE_BULK_ZOOM = 0.4;
/** スマホのまとめて開くで寄せる上限（62% 以上は題名 2 行。それより寄せると、開いた先が画面の外へ出る） */
const PHONE_BULK_ZOOM_MAX = 0.62;

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
  /**
   * キャンバスの上と下で、ほかの部品が今覆っている高さ（画面の px。上の帯・拡大縮小の部品とその上に出るお知らせ）。App が決める。
   * 年月の目盛りはここに入れない（キャンバスが足す）
   */
  covered: () => { top: number; bottom: number } = () => ({ top: 0, bottom: 0 });
  /** 確かめ用（E2E）: [] にすると、描くたびに 3 年の分かれ道の選択肢の札の位置を集め直す。ふだんは null（集めない） */
  debugPills: PillDebug[] | null = null;
  /** 描いた縮小したときの目印（画面座標の左右と、使えた幅の上限）。E2E の確かめ用（[] にしたときだけ集める: 見直し user-9） */
  debugHeads: Array<{ text: string; x0: number; x1: number; maxW: number | null }> | null = null;
  /** 確かめ用（E2E の性能）: true なら描いた後に 1 画素読み、絵を描き終えるまで待ってから時間を測る（描く命令だけでなく塗りまで） */
  rasterFlush = false;

  private readonly ctx: CanvasRenderingContext2D;
  private scheduled = false;
  /**
   * 選んだ物を変えた直後は、線の流れの動きを少し待ってから始める（この時刻まで。選んだ直後のフレームは詳細の欄も作るので、続けて毎フレーム
   * 描き直すと、選んだ後の最初のフレームが次の描き直しに押し出される: 作業メモ perf-8）。動かない線はすぐ描く
   */
  private flowHold = 0;
  private flowTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private camAnim: { from: { x: number; y: number; zoom: number }; to: { x: number; y: number; zoom: number }; start: number; ms: number } | null = null;
  private labelBoxes: Box[] = [];
  private stubBoxes: Box[] = [];
  private grid: { key: string; pattern: CanvasPattern | null } | null = null;
  /**
   * 点の格子は、地図の下の別のキャンバスに描く（カメラ・大きさが変わったときだけ描き直す）。地図と同じキャンバスに毎フレーム
   * 敷き詰めると、カードを選ぶ・概要へ戻るたびに画面全体の格子を描き直し、ソフトウェアで描く環境ではフレームの仕上げが 3〜4 ms
   * 延びていた（P4・選ぶの行）。見た目は同じ（地図のキャンバスは透けていて、格子の上に重なる）
   */
  private readonly gridCanvas: HTMLCanvasElement;
  private readonly gridCtx: CanvasRenderingContext2D | null;
  /** 格子のキャンバスに今描いてある物（同じなら描き直さない） */
  private gridDrawn = "";
  private readonly cameraListeners = new Set<() => void>();
  private readonly renderListeners = new Set<() => void>();
  private readonly reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  private centerCache = { version: -1, revision: -1, y: 0 };
  /** 3 年の分かれ道のカード・線に書く物（計算の結果ごとに作る） */
  private readonly cards = new ImpactCards();
  private readonly pillTmp: PillRect = { x: 0, y: 0, w: 0, h: 0, font: 0 };
  /** 資産のゴールの列・行き先からゴールへの線・ゴールのカード（3 か月ごとの地図だけ: src/canvas/goalRail.ts） */
  readonly goal = new GoalRail(
    () => this.panToGoal(),
    () => this.requestRender(),
  );
  /** 見えている行き先のカード（見えているカードの並びか計算の結果が変わったときだけ選び直す） */
  private goalEnds: { src: readonly ID[]; imp: unknown; ends: ID[] } = { src: [], imp: null, ends: [] };

  constructor(
    private readonly store: Store,
    private readonly ui: UiState,
    private readonly vm: ViewModel,
  ) {
    this.canvas = h("canvas", { class: "graph-canvas", attrs: { "aria-label": "分岐のキャンバス", role: "application", tabindex: "0" } });
    this.gridCanvas = h("canvas", { class: "graph-grid", attrs: { "aria-hidden": "true" } });
    this.gridCtx = this.gridCanvas.getContext("2d", { alpha: true });
    this.root = h("div", { class: "canvas-wrap" }, this.gridCanvas, this.canvas);
    const ctx = this.canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("Canvas 2D が使えません");
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(this.root);
    onPixelRatioChange(() => this.resize());
    store.on("change", () => this.requestRender());
    ui.on("visual", () => this.requestRender());
    ui.on("hover", () => this.requestRender());
    ui.on("pick", () => this.requestRender());
    ui.on("selection", () => {
      this.flowHold = performance.now() + FLOW_HOLD_MS;
    });
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
    this.gridCanvas.width = this.canvas.width;
    this.gridCanvas.height = this.canvas.height;
    this.grid = null;
    this.gridDrawn = "";
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
   * スマホでまとめて開いた: 開き始めたカードと、そのすぐ先に開いたカード（同じ行の右へ続く物から 2 枚）を、題名が読める大きさ
   * （PHONE_BULK_ZOOM 以上）で、上の帯・目盛りの下、お知らせ・拡大縮小の部品の上に見せる。開いた所の全体がその大きさで入れば全体を
   * 真ん中に。残りは開き始めたカードから右と下へ続くので、動かして見る（前は 30% まで引いて開いた所の左上を画面の角に合わせ、
   * 今日から下へ伸びる線と、上の帯の下に隠れた今日だけが見えた: 作業メモ bulk 見直しの残り 1）
   */
  private revealBulkPhone(anchor: { x: number; y: number }, kidPos: ReadonlyArray<{ x: number; y: number }>, area: { minX: number; minY: number; maxX: number; maxY: number }): void {
    const cov = this.covered();
    const L = 8;
    const R = this.width - 8;
    const T = Math.max(this.rulerShown ? RULER_H : 0, cov.top) + 8;
    const B = Math.max(T + 2 * HALF_H * PHONE_BULK_ZOOM, this.height - cov.bottom - 8);
    const fitIn = (b: { minX: number; minY: number; maxX: number; maxY: number }) => Math.min((R - L) / (b.maxX - b.minX), (B - T) / (b.maxY - b.minY));
    const zAll = fitIn(area);
    if (zAll >= PHONE_BULK_ZOOM) {
      const z = Math.min(1, zAll);
      this.animateTo({ zoom: z, x: L + (R - L - (area.maxX - area.minX) * z) / 2 - area.minX * z, y: T + (B - T - (area.maxY - area.minY) * z) / 2 - area.minY * z }, 320);
      return;
    }
    // 開き始めたカードに近い順（同じ行 → 近い列）。木は右へ伸びるので、行のずれを重く見る
    const near = kidPos
      .filter((p) => p.x > anchor.x)
      .sort((a, b) => Math.abs(a.y - anchor.y) - Math.abs(b.y - anchor.y) || a.x - b.x)
      .slice(0, 2);
    const box = { minX: anchor.x - HALF_W, minY: anchor.y - HALF_H, maxX: anchor.x + HALF_W, maxY: anchor.y + HALF_H };
    for (const p of near) {
      box.minX = Math.min(box.minX, p.x - HALF_W);
      box.maxX = Math.max(box.maxX, p.x + HALF_W);
      box.minY = Math.min(box.minY, p.y - HALF_H);
      box.maxY = Math.max(box.maxY, p.y + HALF_H);
    }
    const z = Math.min(PHONE_BULK_ZOOM_MAX, Math.max(PHONE_BULK_ZOOM, fitIn(box)));
    // 開き始めたカードを左上に（その先は右と下へ続く）
    this.animateTo({ zoom: z, x: L - box.minX * z, y: T - box.minY * z }, 320);
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
    /** 開いて出てきたカードの位置（スマホで、開き始めたカードのすぐ先を選ぶ） */
    const kidPos: Array<{ x: number; y: number }> = [];
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
        const q = this.vm.posOf(e.target)!;
        add(q);
        if (ids.length > 1) kidPos.push(q);
        kids++;
      }
    }
    if (!anchor || !kids) return;
    const cam = this.camera;
    if (ids.length > 1 && this.width < 640) {
      this.revealBulkPhone(anchor, kidPos, { minX, minY, maxX, maxY });
      return;
    }
    if (ids.length > 1) {
      // まとめて開いた（いくつものカードを一度に）: 開いた所の全体が見える大きさまで引く（下限まで）。収まれば真ん中に、
      // 収まらなければ開いた所の左上（開き始めたカードの所）から見せる（拡大率をそのままにすると、何百枚開いても画面がほとんど
      // 変わらず、縦に長い開き方では上半分が空く: 見直し reader-1）
      const L = this.insets.left + 16;
      const T = this.insets.top + 16;
      const R = this.width - this.insets.right - 16;
      const B = this.height - this.insets.bottom - 16;
      const bw = maxX - minX;
      const bh = maxY - minY;
      // 引く下限: 広い画面は 12%（形が見える。狭い画面は revealBulkPhone）
      const floor = 0.12;
      const zf = Math.min((R - L) / bw, (B - T) / bh);
      const z = Math.min(1, Math.max(floor, zf));
      const fits = zf >= floor;
      const fx = (R - L) / bw >= z;
      const x = fx ? L + (R - L - bw * z) / 2 - minX * z : L - minX * z;
      const y = fits ? T + (B - T - bh * z) / 2 - minY * z : T - minY * z;
      this.animateTo({ zoom: z, x, y }, 320);
      return;
    }
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
    // 収まらない向きは、開き始めたカード（ids の先頭）を目印に: 横はそのカードを左の端に（次の列が見える）、縦はそのカードを真ん中に
    // （開いた物の左上に合わせると、縦に長い開き方では、今日から遠い上の枝だけが見える: 見直し user-8）
    const ax = (anchor.x - HALF_W) * z + x;
    const ay = anchor.y * z + y;
    if (sx1 - sx0 > R - L) dx = L + 16 - ax;
    else if (sx0 < L) dx = L - sx0;
    else if (sx1 > R) dx = R - sx1;
    if (sy1 - sy0 > B - T) dy = (T + B) / 2 - ay;
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
   * 折りたたみ中は full・compact で描く。開閉する物のあるノード（vm.canCollapse。C・メニューと同じ決まり）のホバー・選択中の「−」は full だけ。
   * low・dot では描かない。3 年の分かれ道は、選んでいるノードの「−」を compact でも描く（スマホで開いた所を閉じられるように）
   */
  private badgeVisible(id: ID, lod: Lod): boolean {
    if (lod !== "full" && lod !== "compact") return false;
    const n = this.store.doc.nodes[id];
    if (!n) return false;
    const nv = this.vm.nodes.get(id);
    if (nv?.collapsed || (nv?.collapsedCount ?? 0) > 0) return true;
    const selected = this.ui.selection.nodes.has(id);
    if (lod !== "full" && !(selected && this.vm.inImpact(id))) return false;
    return (this.ui.hover.node === id || selected) && this.vm.canCollapse(id);
  }

  // ------------------------------------------------------------ 当たり判定

  hitTest(sx: number, sy: number): Hit {
    this.vm.ensure();
    // 上に固定した年月の目盛りの帯（3 か月ごとの地図）は、下のカードを押さない
    if (this.rulerShown && sy < RULER_H) return { kind: "empty" };
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
      // 位置を先に見る（印を出しているかは文書を引くので、近い物だけ。まとめて開いて 2,600 枚見えていても押すたびに全部を引かない）
      for (let i = this.vm.drawNodes.length - 1; i >= 0; i--) {
        const id = this.vm.drawNodes[i]!;
        const p = this.pos(id);
        const c = badgeCenter(p.x, p.y);
        if (Math.abs(w.x - c.x) <= hw && Math.abs(w.y - c.y) <= hh && this.badgeVisible(id, lod)) return { kind: "badge", node: id };
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
        const p = this.pos(id);
        const c = badgeCenter(p.x, p.y);
        if (Math.abs(w.x - c.x) <= tw && w.y >= c.y - hh && w.y <= c.y + down && this.vm.inImpact(id) && this.badgeVisible(id, lod)) return { kind: "badge", node: id };
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

  /** 点の格子を下のキャンバスに描く（show = false なら消す）。カメラ・大きさ・拡大率が前と同じなら何もしない */
  private drawGrid(show: boolean): void {
    const g = this.gridCtx;
    if (!g) return;
    if (!show) {
      if (this.gridDrawn !== "off") g.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
      this.gridDrawn = "off";
      return;
    }
    const z = this.camera.zoom;
    let spacing = 32;
    while (spacing * z < 16) spacing *= 4;
    const px = spacing * z * this.dpr;
    const fade = Math.min(1, (spacing * z - 16) / 24 + 0.35);
    const key = `${px.toFixed(2)}|${this.dpr}|${fade.toFixed(2)}`;
    if (!this.grid || this.grid.key !== key) this.grid = { key, pattern: gridPattern(g, px, Math.max(1, this.dpr * 1.1), 0.16 * fade) };
    const pat = this.grid.pattern;
    const ox = ((this.camera.x * this.dpr) % px) - px + this.dpr * 1.1;
    const oy = ((this.camera.y * this.dpr) % px) - px + this.dpr * 1.1;
    const drawn = `${key}|${ox}|${oy}|${this.gridCanvas.width}|${this.gridCanvas.height}`;
    if (drawn === this.gridDrawn) return;
    this.gridDrawn = drawn;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
    if (!pat) return;
    pat.setTransform(new DOMMatrix([px / Math.round(px), 0, 0, px / Math.round(px), ox, oy]));
    g.fillStyle = pat;
    g.fillRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
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
    this.drawGrid(prefs.showGrid);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * cam.x, dpr * cam.y);
    const margin = 60 / z;
    const view = { minX: -cam.x / z - margin, minY: -cam.y / z - margin, maxX: (this.width - cam.x) / z + margin, maxY: (this.height - cam.y) / z + margin };
    const flowT = prefs.animate && !this.reducedMotion && (vm.pathActive || sel.edges.size > 0) ? now : null;
    let animating = false;

    // 接続
    const labels: Array<{ id: ID; g: EdgeGeom; text: string; rel: Relation; alpha: number; emph: boolean; color?: string; maxW?: number; bold?: boolean; start?: boolean }> = [];
    // 3 か月ごとの地図（版 7）: 選び方の道をどの拡大率でも強め、札は列の間に収め、まとめた行き先への線は破線（作業メモ SPEC v1 §5.6）
    const quarter = imp.active && cards.quarterly(imp, doc);
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
        const pi = imp.onPiEdge(e);
        const near = lod === "full" || lod === "compact";
        const k = lod === "low" ? (pi ? 1 : 0.25) : lod === "dot" ? (pi ? 0.8 : 0.1) : quarter ? (pi ? 1 : ie.alpha * 0.6) : ie.alpha;
        const style = quarter && pi && near ? cards.emph(ie.style) : ie.style;
        drawEdge(ctx, g, { lod, zoom: z, alpha: ev.alpha, relation: e.relation, selected, hovered, path: ev.path, cross: false, offScenario: ev.offScenario, flowT, style, styleAlpha: k, dash: ie.cont });
        if (flowT !== null && (ev.path || selected) && lod !== "low" && lod !== "dot") animating = true;
        if (lod === "full" || lod === "compact") {
          if (ie.kind === "chance") {
            // 「35%」（大きく見ているとき・選んだ・ホバーは「35%｜判断の線」）
            const long = lod === "full" || selected || hovered;
            const text = long ? ie.long : ie.pct;
            const maxW = quarter ? labelMaxW(g, z, ie.cont ? 150 : 170) : 170;
            if (text && ((prefs.showLabels && ev.alpha > 0.25) || selected || hovered)) labels.push({ id: eid, g, text, rel: e.relation, alpha: Math.max(ev.alpha, selected || hovered ? 1 : 0), emph: selected || hovered || ev.path, color: ie.color, maxW, bold: !long, start: ie.cont });
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
    for (const l of labels) this.labelBoxes.push({ id: l.id, ...drawEdgeLabel(ctx, l.g, l.text, l.rel, l.alpha, l.emph, z, l.color ? { color: l.color, maxW: l.maxW, bold: l.bold, start: l.start } : {}) });

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
    // 見込み（P_path）は、数えてある物だけを使う（3 年の分かれ道のカードは使わない）。まだなら、見込みの要らない名前・数だけで描き、
    // 見込みは空いた時間に少しずつ数えて、数え終えたら描き直す（8 万枚の地図では計画を作るのに 4 倍遅いスマホで 0.6 秒かかり、起動の
    // 最初のフレームを待たせていた: 見直し perf-1・perf-7。見取り図を先に見せて、触れるようにしてから）
    const fcNow = vm.forecastIfReady();
    let fcWanted = false;
    const fcOf = (): ForecastResult | null => {
      if (!fcNow) fcWanted = true;
      return fcNow;
    };
    const screenLabels: ScreenLabel[] = [];
    const impLabels: ScreenLabel[] = [];
    /** 縮小したときに描いた 3 年の分かれ道のカード（画面の px）。目印の文がほかのカード（真ん中の差の札）に重ならないように（P2 の確かめ F2） */
    const cardBoxes: LabelBox[] = [];
    const ranks =
      imp.active && (lod === "low" || lod === "dot")
        ? fcNow
          ? cards.labelRank(imp, doc, (id) => reachP(fcNow.reach, id))
          : (fcOf(), cards.labelRankBase(imp))
        : null;
    const pillBox = this.pillTmp;
    // 「ほかのカードも選ぶ」の間は、選んだカードに太い枠と印（どれを選んだかが縮小しても分かるように: 見直し reader-6）
    const picking = this.ui.multiPick;
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
        reach: card ? undefined : fcOf()?.active ? fcNow!.reach.get(id)?.p : undefined,
      };
      if (card) {
        drawImpactNode(ctx, n, p.x, p.y, opts, card, pills ? pillBox : null);
        if (selected && picking) pickMark(ctx, p.x, p.y, z);
        if (pills && pillBox.w > 0 && card.pill) pills.push({ id, text: card.pill, x: pillBox.x * z + cam.x, y: pillBox.y * z + cam.y, w: pillBox.w * z, h: pillBox.h * z, font: pillBox.font * z });
        if (lod === "low") cardBoxes.push({ x0: (p.x - HALF_W) * z + cam.x, y0: (p.y - HALF_H) * z + cam.y, x1: (p.x + HALF_W) * z + cam.x, y1: (p.y + HALF_H) * z + cam.y });
        if (lod === "low" || lod === "dot") {
          // 縮小したときの目印: 選択中 > 検索の当たり > 今日の選択肢 > ★ の選択肢 > 見込みの高い行き先（一番小さくしたときは今日と行き先 5 つ）
          const r = selected ? 0 : nv.match ? 1 : (ranks?.get(id) ?? -1);
          // 選択肢は、カードの真ん中に差を描いているとき（low・19% 以上）は題名だけ（同じ差を 2 度出さない: 見直し user-9）
          const deltaShown = lod === "low" && z >= 0.19 && card.role === "alt" && !!card.low && !!card.labelTitle;
          const text = lod === "dot" ? card.dotLabel || card.label : deltaShown ? card.labelTitle : card.label;
          if (r >= 0 && text && (lod === "low" || r <= 1 || card.role === "root" || card.role === "end")) {
            impLabels.push({ x: p.x, y: p.y, text, color: "#EEF1F7", alpha: nv.alpha, rank: card.role === "root" && lod === "dot" ? -1 : r, dot: card.role === "root" ? null : binStroke(card.bin), left: true, maxW: lod === "low" ? this.nextColumnGap(id, p.x) : undefined });
          }
        }
        continue;
      }
      drawNode(ctx, n, p.x, p.y, opts);
      if (selected && picking) pickMark(ctx, p.x, p.y, z);
      // ふつうのカードの箱も目印の重なりに使う（「前の版で決めたこと」の詰まった列で、目標の目印が上のカードを隠していた: 見直し reader-3）
      if (lod === "low") cardBoxes.push({ x0: (p.x - HALF_W) * z + cam.x, y0: (p.y - HALF_H) * z + cam.y, x1: (p.x + HALF_W) * z + cam.x, y1: (p.y + HALF_H) * z + cam.y });
      if ((lod === "low" || lod === "dot") && (n.type === "goal" || selected || nv.match)) screenLabels.push({ x: p.x, y: p.y, text: null, n, reach: fcOf()?.active ? fcNow!.reach.get(id)?.p : undefined, color: NODE_TYPES[n.type].color, alpha: nv.alpha, rank: selected ? 0 : nv.match ? 1 : 2, dot: null });
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
    this.drawGoal(quarter ? imp.root : null, lod);
    if (impLabels.length) this.drawScreenLabels(impLabels, lod === "dot" ? 6 : 80, cardBoxes);
    if (screenLabels.length) this.drawScreenLabels(screenLabels, 80, cardBoxes);
    // 年月の目盛り（3 か月ごとの地図。どの拡大率でも画面の上に固定: 作業メモ SPEC v1 §5.6・user-7・user-15）
    this.setRuler(quarter && imp.root ? this.drawRuler(imp.root, doc) : false);

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
    // 見込みが要ったのに、まだ数えていなかった: 空いた時間に数え、数え終えたら描き直す
    if (fcWanted && !this.forecastAsked) {
      this.forecastAsked = true;
      vm.warmForecast(() => {
        this.forecastAsked = false;
        this.requestRender();
      });
    }
    this.frames++;
    for (const fn of this.renderListeners) fn();
    if (this.camAnim) this.requestRender();
    else if (animating) {
      const wait = this.flowHold - performance.now();
      if (wait <= 0) this.requestRender();
      else if (!this.flowTimer)
        this.flowTimer = setTimeout(() => {
          this.flowTimer = 0;
          this.requestRender();
        }, wait);
    }
  }

  /**
   * 資産のゴールの列と、見えている行き先からゴールへの線（画面の座標で。目印の文より下・目盛りより下に描く）とゴールのカードの位置。
   * root が null（3 か月ごとの地図でない）・入口が見えていなければ、どれも出さない
   */
  private drawGoal(root: ID | null, lod: Lod): void {
    const vm = this.vm;
    const imp = vm.impact;
    if (!root || !imp.active || !vm.hasOverlay(root)) return this.goal.off();
    const doc = this.store.doc;
    const c = this.goalEnds;
    if (c.src !== vm.drawNodes || c.imp !== imp) {
      c.src = vm.drawNodes;
      c.imp = imp;
      c.ends = vm.drawNodes.filter((id) => imp.kind.get(id) === "leaf");
    }
    const cam = this.camera;
    const sel = this.ui.selection.nodes;
    this.goal.draw({
      ctx: this.ctx,
      width: this.width,
      height: this.height,
      top: RULER_H,
      z: cam.zoom,
      cx: cam.x,
      cy: cam.y,
      lod,
      railX: vm.posOf(root)!.x + GOAL_RAIL_DX,
      ends: c.ends,
      pos: (id) => this.pos(id),
      card: (id) => this.cards.card(imp, doc, id),
      pathActive: vm.pathActive,
      onPath: (id) => vm.node(id).path,
      selected: sel.size === 1 ? (sel.values().next().value ?? null) : null,
      t: this.cards.goal(imp, doc),
    });
  }

  /** ゴールの列が見える所へ動かす（拡大率と縦はそのまま。列を画面の右寄りに置き、左に行き先からの線が見えるように） */
  panToGoal(): void {
    const imp = this.vm.impact;
    const root = imp.active ? imp.root : null;
    if (!root || !this.vm.hasOverlay(root) || !this.measurable) return;
    const rx = this.vm.posOf(root)!.x + GOAL_RAIL_DX;
    const z = this.camera.zoom;
    const cw = this.width < 640 ? 128 : 176;
    const sx = Math.max(this.width * 0.4, this.width - cw - 40);
    this.animateTo({ zoom: z, x: sx - rx * z, y: this.camera.y }, 380);
  }

  /** 見込みを空いた時間に数えるよう頼んだ（数え終えるまで重ねて頼まない） */
  private forecastAsked = false;

  /** 目盛りを描いている（キャンバスの上のお知らせの帯を目盛りの下へ: src/styles/deep.css）。確かめ用に描いた目盛りの文字 */
  rulerShown = false;
  rulerTexts: string[] = [];

  private setRuler(on: boolean): void {
    if (on === this.rulerShown) return;
    this.rulerShown = on;
    this.root.parentElement?.classList.toggle("has-ruler", on);
  }

  /**
   * 年月の目盛り: 画面の上に固定した帯に、地図の列ごとの年月（判断・結果の列は「2027 年 2 月」、手の列は「12 月〜2 月の手」）。
   * 列は入口（今日）の位置から（impactColX。月から決めた列と同じ）。重なる文字は出さない（判断の列を先に置く）。描いたら true
   */
  private drawRuler(root: ID, doc: DocData): boolean {
    const r = doc.nodes[root];
    const anchor = r?.meta?.anchor;
    if (!r || typeof anchor !== "string" || !this.vm.hasOverlay(root)) return false;
    const rp = this.vm.posOf(root)!;
    const ctx = this.ctx;
    const cam = this.camera;
    const z = cam.zoom;
    const W = this.width;
    const H = RULER_H;
    ctx.fillStyle = "rgba(9,12,18,0.92)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(0, H - 1, W, 1);
    const texts: string[] = [];
    const placed: Array<[number, number]> = [];
    const free = (a: number, b: number) => !placed.some(([x0, x1]) => a < x1 + 10 && b > x0 - 10);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    // 判断・結果の列（年月）を先に、次に右の端のゴール（「→ ゴール 資産 10 億円（目安）」）、間が空いていれば手の列（その 3 か月）
    const gt = this.vm.impact.active ? this.cards.goal(this.vm.impact, doc) : null;
    for (const pass of [0, 1]) {
      if (pass === 1 && gt) this.rulerGoal(rp.x, gt, free, placed, texts);
      ctx.font = pass === 0 ? `650 11px ${CANVAS_FONT}` : `500 10.5px ${CANVAS_FONT}`;
      for (let d = pass; d <= 24; d += 2) {
        const sx = (rp.x + impactColX(d)) * z + cam.x;
        if (sx < -160 || sx > W + 160) continue;
        let text: string;
        try {
          text = pass === 0 ? ymText(anchor, (d / 2) * 3) : `${quarterSpanText(anchor, ((d - 1) / 2) * 3)}の手`;
        } catch {
          return false;
        }
        if (d === 0) text = `今日 ${text}`;
        if (d === 24) text = `${text}（3 年後）`;
        const w = ctx.measureText(text).width;
        // 端の列は画面の中へ寄せる（入口の列が左の端にあっても「今日」が切れない）
        const x0 = Math.max(6, Math.min(W - w - 6, sx - w / 2));
        if (!free(x0, x0 + w)) continue;
        placed.push([x0, x0 + w]);
        texts.push(text);
        ctx.fillStyle = pass === 0 ? "rgba(221,227,238,0.95)" : "rgba(150,160,178,0.9)";
        ctx.fillText(text, x0, H / 2 + 0.5);
        // 列の真ん中の小さな目印
        ctx.fillStyle = pass === 0 ? "rgba(165,151,255,0.85)" : "rgba(150,160,178,0.5)";
        ctx.fillRect(Math.round(sx) - 0.5, H - 5, 1, 4);
      }
    }
    ctx.textBaseline = "alphabetic";
    this.rulerTexts = texts;
    return true;
  }

  /**
   * 目盛りのゴールの札: ゴールの列が見えていれば列の右に、右の外なら目盛りの右の端に「→ ゴール 資産 10 億円（目安）」
   * （入らなければ「→ ゴール」）。左の外（ゴールより右を見ている）なら出さない
   */
  private rulerGoal(rootX: number, t: GoalTables, free: (a: number, b: number) => boolean, placed: Array<[number, number]>, texts: string[]): void {
    const ctx = this.ctx;
    const W = this.width;
    const sx = (rootX + GOAL_RAIL_DX) * this.camera.zoom + this.camera.x;
    if (sx < 0) return;
    ctx.font = `650 11px ${CANVAS_FONT}`;
    for (const text of [`→ ゴール ${goalName(t)}（目安）`, "→ ゴール"]) {
      const w = ctx.measureText(text).width;
      const x0 = Math.max(6, Math.min(W - w - 6, sx + 6));
      if (!free(x0, x0 + w)) continue;
      placed.push([x0, x0 + w]);
      texts.push(text);
      ctx.fillStyle = "rgba(255,200,120,0.98)";
      ctx.fillText(text, x0, RULER_H / 2 + 0.5);
      if (sx <= W) {
        ctx.fillStyle = "rgba(255,181,71,0.9)";
        ctx.fillRect(Math.round(sx) - 0.5, RULER_H - 6, 1, 5);
      }
      return;
    }
  }

  /** ふつうの地図の目印の文（題名。未来の道筋の行き先などは見込みを添える）。ctx.font は呼ぶ側で 12px にしておく */
  private plainText(n: GNode, reach: number | undefined): string {
    const title = wrapText(this.ctx, n.title.trim() || "（無題）", 180, 1)[0] ?? "";
    return reach !== undefined && reach < 0.9995 ? `${title}（${formatPercent(reach)}）` : title;
  }

  /** 縮小したときの目印（画面の大きさで）。重なる名前は出さない（大事なものから置く）。cap まで */
  /**
   * カード id（x は中心の世界座標）の目印の文が使える幅（画面の px）: 見えている子のカード（次の列）の左の端まで。
   * 見えている子が無ければ上限なし（undefined）
   */
  private nextColumnGap(id: ID, x: number): number | undefined {
    let next = Infinity;
    for (const eid of this.vm.index.out.get(id) ?? []) {
      const e = this.store.doc.edges[eid];
      if (!e || !this.vm.hasOverlay(e.target) || this.vm.node(e.target).hidden) continue;
      const q = this.vm.posOf(e.target);
      if (q && q.x > x && q.x < next) next = q.x;
    }
    // 目印はカードの左の端から始まる: 使える幅 = 次の列のカードの左の端 − このカードの左の端 − すき間
    return next === Infinity ? undefined : (next - x) * this.camera.zoom - 10;
  }

  private drawScreenLabels(items: ScreenLabel[], cap: number, cards: readonly LabelBox[] = []): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const cam = this.camera;
    ctx.textBaseline = "alphabetic";
    ctx.font = `650 12px ${CANVAS_FONT}`;
    ctx.lineJoin = "round";
    items.sort((a, b) => a.rank - b.rank || b.alpha - a.alpha);
    const placed: LabelBox[] = [];
    // カードの箱を縦 40 px ごとの帯に分けて引く（目印 80 個 × 見えるカード数百を全部比べない）
    const BAND = 40;
    const bands = new Map<number, LabelBox[]>();
    for (const b of cards) {
      for (let r = Math.floor(b.y0 / BAND); r <= Math.floor(b.y1 / BAND); r++) {
        let list = bands.get(r);
        if (!list) bands.set(r, (list = []));
        list.push(b);
      }
    }
    const hits = (b: LabelBox, list: Iterable<LabelBox>): boolean => {
      for (const q of list) if (q.x0 < b.x1 && q.x1 > b.x0 && q.y0 < b.y1 && q.y1 > b.y0) return true;
      return false;
    };
    const onCard = (b: LabelBox): boolean => {
      for (let r = Math.floor(b.y0 / BAND); r <= Math.floor(b.y1 / BAND); r++) if (hits(b, bands.get(r) ?? [])) return true;
      return false;
    };
    let shown = 0;
    for (const it of items) {
      if (shown >= cap) break;
      const sx = it.x * z + cam.x;
      const sy = (it.y - HALF_H) * z + cam.y - 6;
      if (sx < -100 || sx > this.width + 100 || sy < -20 || sy > this.height + 20) continue;
      const dw = it.dot ? 12 : 0;
      let text = it.text ?? this.plainText(it.n!, it.reach);
      // 次の列のカードの手前で切る（入りきらないほど狭ければ出さない）
      if (it.maxW !== undefined) {
        if (it.maxW - dw < 28) continue;
        text = clipToWidth(ctx, text, it.maxW - dw);
        if (!text) continue;
      }
      let w = ctx.measureText(text).width;
      let left = it.left ? sx - HALF_W * z : sx - (w + dw) / 2;
      let base = sy;
      let box = { x0: left - 4, y0: base - 14, x1: left + w + dw + 4, y1: base + 4 };
      // カードの上の目印が、上の行のカード（真ん中の差の札）に重なる（縮小して行が詰まったとき）: カードの左に、真ん中の高さで出す。
      // そこも空いていなければ出さない（選んだカードの目印は今までどおり上に出す）
      if (it.rank > 0 && it.left && cards.length && onCard(box)) {
        const cy = it.y * z + cam.y;
        const room = Math.min(it.maxW ?? 160, 160);
        const t2 = clipToWidth(ctx, text, room - dw);
        if (!t2) continue;
        const w2 = ctx.measureText(t2).width;
        const right = sx - HALF_W * z - 6;
        const alt = { x0: right - w2 - dw - 4, y0: cy - 10, x1: right + 2, y1: cy + 8 };
        if (onCard(alt) || placed.some((b) => b.x0 < alt.x1 && b.x1 > alt.x0 && b.y0 < alt.y1 && b.y1 > alt.y0)) continue;
        text = t2;
        w = w2;
        left = right - w2 - dw;
        base = cy + 4;
        box = alt;
      }
      // 真ん中に出す目印（ふつうのカードの題名）が、上のカードに重なる: 出さない（選んだカードの目印は出す）
      else if (it.rank > 0 && !it.left && cards.length && onCard(box)) continue;
      if (it.rank > 0 && placed.some((b) => b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0)) continue;
      placed.push(box);
      shown++;
      this.debugHeads?.push({ text, x0: left, x1: left + w + dw, maxW: it.maxW ?? null });
      if (it.dot) {
        ctx.beginPath();
        ctx.arc(left + 4, base - 4, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(7,9,13,0.92)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(left + 4, base - 4, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = rgba(it.dot, Math.max(0.5, it.alpha));
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(7,9,13,0.92)";
      ctx.lineWidth = 4;
      ctx.strokeText(text, left + dw, base);
      ctx.fillStyle = rgba(it.color, Math.max(0.4, it.alpha));
      ctx.fillText(text, left + dw, base);
    }
  }
}

/** 文を幅 maxW（画面の px。今の文字の形で測る）に収める。入りきらなければ後ろを「…」にする */
export function clipToWidth(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${chars.slice(0, mid).join("")}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${chars.slice(0, lo).join("")}…` : "";
}

/** 「ほかのカードも選ぶ」で選んだカードの印（画面で 3 px の枠と、右上の丸）。世界の座標で描く（ctx はカメラの変換のまま） */
function pickMark(ctx: CanvasRenderingContext2D, x: number, y: number, z: number): void {
  const pad = 5 / z;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#5BC0A0";
  ctx.lineWidth = 3 / z;
  ctx.beginPath();
  ctx.roundRect(x - HALF_W - pad, y - HALF_H - pad, (HALF_W + pad) * 2, (HALF_H + pad) * 2, 14 / z + pad);
  ctx.stroke();
  const r = Math.max(9 / z, 6);
  ctx.fillStyle = "#5BC0A0";
  ctx.beginPath();
  ctx.arc(x + HALF_W, y - HALF_H, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#0c0f15";
  ctx.lineWidth = r * 0.28;
  ctx.beginPath();
  ctx.moveTo(x + HALF_W - r * 0.45, y - HALF_H);
  ctx.lineTo(x + HALF_W - r * 0.1, y - HALF_H + r * 0.35);
  ctx.lineTo(x + HALF_W + r * 0.45, y - HALF_H - r * 0.35);
  ctx.stroke();
  ctx.restore();
}
