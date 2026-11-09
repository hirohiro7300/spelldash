// キャンバスの操作: パン・ズーム・選択・範囲選択・ドラッグ・接続（つまみから）・タッチのピンチ・Safari のトラックパッドのピンチ

import type { Commands } from "../app/commands";
import type { UiState } from "../app/uiState";
import type { ViewModel } from "../app/viewModel";
import type { ID } from "../model/types";
import type { Store } from "../store/store";
import { isMac } from "../ui/dom";
import type { CanvasView, Hit } from "./CanvasView";
import { HALF_W } from "./geometry";

type Mode =
  | { kind: "idle" }
  | { kind: "pan"; sx: number; sy: number; cx: number; cy: number; moved: boolean; clearOnClick: boolean }
  | { kind: "marquee"; base: Set<ID> }
  | { kind: "drag"; ids: Set<ID>; wx: number; wy: number; sx: number; sy: number; moved: boolean; node: ID; wasSelected: boolean; additive: boolean }
  | { kind: "connect"; sx: number; sy: number }
  | { kind: "press"; hit: Hit; sx: number; sy: number }
  | { kind: "pinch"; dist: number; cx: number; cy: number };

export interface InteractionHooks {
  startEdit(id: ID): void;
  contextMenu(hit: Hit, clientX: number, clientY: number, world: { x: number; y: number }): void;
  /** 何もない所で接続を離した: そこに作る種類を選ぶ */
  pickTypeAt(clientX: number, clientY: number, onPick: (type: "goal" | "action" | "branch" | "result") => void): void;
  focusEdge(id: ID): void;
}

export class Interaction {
  private mode: Mode = { kind: "idle" };
  private readonly pointers = new Map<number, { x: number; y: number; type: string }>();
  spaceDown = false;
  private hoverRaf = 0;
  private lastMove: { x: number; y: number } | null = null;
  /** 押した所（離すまでに動いたかを見る） */
  private downAt: { x: number; y: number } | null = null;
  /** 直前に離した操作が動いたか（クリックのすぐ後のドラッグ・パンで出る dblclick を無視する） */
  private lastUpMoved = false;
  /** Safari のピンチ（gesture*）の直前の scale */
  private gestureScale = 1;

  constructor(
    private readonly view: CanvasView,
    private readonly store: Store,
    private readonly ui: UiState,
    private readonly vm: ViewModel,
    private readonly cmd: Commands,
    private readonly hooks: InteractionHooks,
  ) {
    const c = view.canvas;
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointercancel", this.onCancel);
    c.addEventListener("pointerleave", () => {
      // 出る直前の動きで予約したホバーの更新が、消した後に光を戻さないように
      cancelAnimationFrame(this.hoverRaf);
      this.hoverRaf = 0;
      this.lastMove = null;
      if (this.mode.kind === "idle") this.ui.setHover(null, null);
    });
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("dblclick", this.onDbl);
    c.addEventListener("contextmenu", this.onContext);
    // Safari（macOS）のトラックパッドのピンチは ctrl+ホイールではなく gesture* で来る。止めないとページごと拡大される
    if ("GestureEvent" in globalThis) {
      c.addEventListener("gesturestart", this.onGesture);
      c.addEventListener("gesturechange", this.onGesture);
      c.addEventListener("gestureend", this.onGesture);
    }
  }

  get busy(): boolean {
    return this.mode.kind !== "idle";
  }

  private local(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.view.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  private setCursor(c: string): void {
    if (this.view.canvas.style.cursor !== c) this.view.canvas.style.cursor = c;
  }

  // ------------------------------------------------------------ 押す

  private onDown = (ev: PointerEvent) => {
    // 右クリックは contextmenu に任せる。Mac の Ctrl+クリックも右クリック（ボタン 0 で来て、すぐ contextmenu が続く）なので、
    // ここで選択に足すと、メニューが押していないノードにまで効く
    if (ev.button === 2 || (isMac && ev.ctrlKey && ev.button === 0)) return;
    this.view.canvas.focus({ preventScroll: true });
    this.view.stopCameraAnimation();
    const p = this.local(ev);
    this.downAt = p;
    this.pointers.set(ev.pointerId, { ...p, type: ev.pointerType });
    this.view.canvas.setPointerCapture(ev.pointerId);

    const touches = [...this.pointers.values()].filter((x) => x.type === "touch");
    if (touches.length === 2) {
      // 2 本指: ピンチ（それまでの操作は取り消す）
      this.view.drag = null;
      this.view.marquee = null;
      this.view.connect = null;
      const a = touches[0]!;
      const b = touches[1]!;
      this.mode = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    if (ev.button === 1 || this.spaceDown) {
      ev.preventDefault();
      this.mode = { kind: "pan", sx: p.x, sy: p.y, cx: this.view.camera.x, cy: this.view.camera.y, moved: false, clearOnClick: false };
      this.setCursor("grabbing");
      return;
    }
    const hit = this.view.hitTest(p.x, p.y);
    // 選択に足す: Shift・⌘（Mac）/ Shift・Ctrl（ほか）
    const additive = ev.shiftKey || ev.metaKey || (!isMac && ev.ctrlKey);
    switch (hit.kind) {
      case "port": {
        if (this.store.readOnly) return;
        const sel = this.ui.selection.nodes;
        const sources = hit.side === "out" && sel.has(hit.node) && sel.size > 1 ? [...sel] : [hit.node];
        const w = this.view.camera.toWorld(p.x, p.y);
        this.view.connect = { sources, side: hit.side, anchor: hit.node, wx: w.x, wy: w.y, target: null };
        this.mode = { kind: "connect", sx: p.x, sy: p.y };
        this.setCursor("crosshair");
        break;
      }
      case "node": {
        const wasSelected = this.ui.selection.nodes.has(hit.node);
        if (additive) this.ui.toggleNode(hit.node);
        else if (!wasSelected) this.ui.select([hit.node]);
        const ids = this.ui.selection.nodes.has(hit.node) ? new Set(this.ui.selection.nodes) : new Set<ID>();
        const w = this.view.camera.toWorld(p.x, p.y);
        this.mode = { kind: "drag", ids, wx: w.x, wy: w.y, sx: p.x, sy: p.y, moved: false, node: hit.node, wasSelected, additive };
        break;
      }
      case "edge":
      case "label":
        if (additive) {
          const s = new Set(this.ui.selection.edges);
          if (s.has(hit.edge)) s.delete(hit.edge);
          else s.add(hit.edge);
          this.ui.select([], s);
        } else this.ui.select([], [hit.edge]);
        this.mode = { kind: "press", hit, sx: p.x, sy: p.y };
        break;
      case "badge":
      case "stub":
        this.mode = { kind: "press", hit, sx: p.x, sy: p.y };
        break;
      case "empty":
        if (ev.shiftKey) {
          this.mode = { kind: "marquee", base: new Set(this.ui.selection.nodes) };
          this.view.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        } else {
          this.mode = { kind: "pan", sx: p.x, sy: p.y, cx: this.view.camera.x, cy: this.view.camera.y, moved: false, clearOnClick: !additive };
        }
        break;
    }
  };

  // ------------------------------------------------------------ 動かす

  private onMove = (ev: PointerEvent) => {
    const p = this.local(ev);
    if (this.pointers.has(ev.pointerId)) this.pointers.set(ev.pointerId, { ...p, type: ev.pointerType });
    const m = this.mode;
    switch (m.kind) {
      case "idle":
        this.lastMove = p;
        if (!this.hoverRaf) this.hoverRaf = requestAnimationFrame(() => this.updateHover());
        return;
      case "pan": {
        const dx = p.x - m.sx;
        const dy = p.y - m.sy;
        if (!m.moved && Math.hypot(dx, dy) < 3) return;
        m.moved = true;
        this.setCursor("grabbing");
        this.view.camera.x = m.cx + dx;
        this.view.camera.y = m.cy + dy;
        this.view.cameraChanged();
        return;
      }
      case "drag": {
        if (this.store.readOnly) return;
        if (!m.moved && Math.hypot(p.x - m.sx, p.y - m.sy) < 4) return;
        if (!m.moved) {
          m.moved = true;
          if (m.ids.size === 0) {
            m.ids = new Set([m.node]);
            this.ui.select([m.node]);
          }
        }
        const w = this.view.camera.toWorld(p.x, p.y);
        this.view.drag = { ids: m.ids, dx: w.x - m.wx, dy: w.y - m.wy };
        this.setCursor("grabbing");
        this.view.requestRender();
        return;
      }
      case "connect": {
        const cp = this.view.connect;
        if (!cp) return;
        const w = this.view.camera.toWorld(p.x, p.y);
        cp.wx = w.x;
        cp.wy = w.y;
        const hit = this.view.hitTest(p.x, p.y);
        const t = hit.kind === "node" || hit.kind === "port" ? hit.node : null;
        cp.target = t && !cp.sources.includes(t) && t !== cp.anchor ? t : null;
        this.view.requestRender();
        return;
      }
      case "marquee": {
        const mq = this.view.marquee;
        if (!mq) return;
        mq.x1 = p.x;
        mq.y1 = p.y;
        const inside = this.view.nodesInScreenRect(mq.x0, mq.y0, mq.x1, mq.y1);
        this.ui.select(new Set([...m.base, ...inside]));
        return;
      }
      case "pinch": {
        const touches = [...this.pointers.values()].filter((x) => x.type === "touch");
        if (touches.length < 2) return;
        const a = touches[0]!;
        const b = touches[1]!;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        this.view.camera.x += cx - m.cx;
        this.view.camera.y += cy - m.cy;
        if (m.dist > 0) this.view.camera.zoomAt(cx, cy, dist / m.dist);
        m.dist = dist;
        m.cx = cx;
        m.cy = cy;
        this.view.cameraChanged();
        return;
      }
      case "press":
        return;
    }
  };

  private updateHover(): void {
    this.hoverRaf = 0;
    const p = this.lastMove;
    if (!p || this.mode.kind !== "idle") return;
    const hit = this.view.hitTest(p.x, p.y);
    switch (hit.kind) {
      case "port":
        this.ui.setHover(hit.node, null);
        this.setCursor(this.store.readOnly ? "default" : "crosshair");
        break;
      case "badge":
        this.ui.setHover(hit.node, null);
        this.setCursor("pointer");
        break;
      case "node":
        this.ui.setHover(hit.node, null);
        this.setCursor(this.spaceDown ? "grab" : "default");
        break;
      case "edge":
      case "label":
      case "stub":
        this.ui.setHover(null, hit.edge);
        this.setCursor("pointer");
        break;
      default:
        this.ui.setHover(null, null);
        this.setCursor(this.spaceDown ? "grab" : "default");
    }
  }

  // ------------------------------------------------------------ 離す

  private onUp = (ev: PointerEvent) => {
    const p = this.local(ev);
    this.pointers.delete(ev.pointerId);
    try {
      this.view.canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* もう離れている */
    }
    const m = this.mode;
    const from = this.downAt;
    this.downAt = null;
    this.lastUpMoved = m.kind === "pinch" || ((m.kind === "pan" || m.kind === "drag") && m.moved) || (!!from && Math.hypot(p.x - from.x, p.y - from.y) > 5);
    if (m.kind === "pinch") {
      if (this.pointers.size === 0) this.mode = { kind: "idle" };
      return;
    }
    this.mode = { kind: "idle" };
    switch (m.kind) {
      case "pan":
        if (!m.moved && m.clearOnClick) this.ui.clearSelection();
        break;
      case "drag": {
        const d = this.view.drag;
        this.view.drag = null;
        if (m.moved && d) {
          this.cmd.moveNodes(d.ids, d.dx, d.dy, d.ids.size > 1 ? `${d.ids.size} 件を移動` : "移動");
        } else if (!m.moved && m.wasSelected && !m.additive && this.ui.selection.nodes.size > 1) {
          this.ui.select([m.node]);
        }
        this.view.requestRender();
        break;
      }
      case "connect": {
        const cp = this.view.connect;
        this.view.connect = null;
        this.view.requestRender();
        if (!cp) break;
        if (cp.target) {
          if (cp.side === "out") this.cmd.connect(cp.sources, cp.target);
          else this.cmd.connect([cp.target], cp.anchor);
        } else if (Math.hypot(p.x - m.sx, p.y - m.sy) > 24) {
          // 何もない所で離した → そこに新しいノード（分岐・合流の先）を作る
          const at = { x: cp.side === "out" ? cp.wx + HALF_W : cp.wx - HALF_W, y: cp.wy };
          this.hooks.pickTypeAt(ev.clientX, ev.clientY, (type) => {
            if (cp.side === "out") this.cmd.createNode(type, at, { from: cp.sources, edit: true, exact: true });
            else this.cmd.createNode(type, at, { to: [cp.anchor], edit: true, exact: true });
          });
        }
        break;
      }
      case "marquee":
        this.view.marquee = null;
        this.view.requestRender();
        break;
      case "press": {
        if (Math.hypot(p.x - m.sx, p.y - m.sy) > 5) break;
        if (m.hit.kind === "badge") this.cmd.toggleCollapse([m.hit.node]);
        else if (m.hit.kind === "stub") this.cmd.toggleEdgeCollapse(m.hit.edge);
        break;
      }
    }
    this.lastMove = p;
    this.updateHover();
  };

  private onCancel = (ev: PointerEvent) => {
    this.pointers.delete(ev.pointerId);
    this.downAt = null;
    this.view.drag = null;
    this.view.connect = null;
    this.view.marquee = null;
    this.mode = { kind: "idle" };
    this.view.requestRender();
  };

  // ------------------------------------------------------------ ホイール・ダブルクリック・右クリック

  private onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    this.view.stopCameraAnimation();
    const p = this.local(ev);
    let dx = ev.deltaX;
    let dy = ev.deltaY;
    if (ev.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (ev.deltaMode === 2) {
      dx *= this.view.height;
      dy *= this.view.height;
    }
    const zoomGesture = ev.ctrlKey || ev.metaKey || (this.ui.prefs.wheel === "zoom" && !ev.shiftKey);
    if (zoomGesture) {
      const d = Math.max(-60, Math.min(60, dy));
      this.view.camera.zoomAt(p.x, p.y, Math.exp(-d * 0.0085));
    } else {
      if (ev.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      this.view.camera.x -= dx;
      this.view.camera.y -= dy;
    }
    this.view.cameraChanged();
  };

  /** Safari のピンチ: scale は始めからの倍率なので、前の値との比だけ拡大縮小する */
  private onGesture = (ev: Event) => {
    ev.preventDefault();
    const { scale: s, clientX, clientY } = ev as Event & { scale?: number; clientX?: number; clientY?: number };
    const scale = s && s > 0 ? s : 1;
    if (ev.type === "gesturestart") {
      this.gestureScale = scale;
      this.view.stopCameraAnimation();
      return;
    }
    const factor = scale / this.gestureScale;
    this.gestureScale = scale;
    if (ev.type !== "gesturechange") return;
    // 指のピンチ（iPhone・iPad でも gesture* が来る）はポインターの側で拡大している
    if (this.mode.kind === "pinch" || [...this.pointers.values()].some((x) => x.type === "touch")) return;
    const p = typeof clientX === "number" && typeof clientY === "number" ? this.local({ clientX, clientY }) : { x: this.view.width / 2, y: this.view.height / 2 };
    this.view.camera.zoomAt(p.x, p.y, factor);
    this.view.cameraChanged();
  };

  private onDbl = (ev: MouseEvent) => {
    // クリックのすぐ後にドラッグ・パンすると、離した所で dblclick が来る（ノードを作ったり編集を始めたりしない）
    if (this.lastUpMoved) return;
    const p = this.local(ev);
    const hit = this.view.hitTest(p.x, p.y);
    if (hit.kind === "node") this.hooks.startEdit(hit.node);
    else if (hit.kind === "edge" || hit.kind === "label") this.hooks.focusEdge(hit.edge);
    else if (hit.kind === "empty" && !this.store.readOnly) {
      const w = this.view.camera.toWorld(p.x, p.y);
      this.cmd.createNode(this.ui.prefs.lastType, { x: w.x, y: w.y }, { edit: true, exact: true });
    }
  };

  private onContext = (ev: MouseEvent) => {
    ev.preventDefault();
    const p = this.local(ev);
    const hit = this.view.hitTest(p.x, p.y);
    if (hit.kind === "node" || hit.kind === "badge" || hit.kind === "port") {
      if (!this.ui.selection.nodes.has(hit.node)) this.ui.select([hit.node]);
    } else if (hit.kind === "edge" || hit.kind === "label" || hit.kind === "stub") {
      if (!this.ui.selection.edges.has(hit.edge)) this.ui.select([], [hit.edge]);
    }
    this.hooks.contextMenu(hit, ev.clientX, ev.clientY, this.view.camera.toWorld(p.x, p.y));
  };

  /** 矢印キーで少しずつ動かす（選択なしならパン） */
  nudge(dx: number, dy: number): void {
    const ids = [...this.ui.selection.nodes];
    if (ids.length) this.cmd.moveNodes(ids, dx, dy, "少し移動");
    else {
      this.view.camera.x -= dx * this.view.camera.zoom * 4;
      this.view.camera.y -= dy * this.view.camera.zoom * 4;
      this.view.cameraChanged();
    }
    void this.vm;
  }
}
