// ミニマップ: 全体の中で今どこを見ているか。押す・ドラッグでその場所へ

import type { UiState } from "../app/uiState";
import type { ViewModel } from "../app/viewModel";
import { NODE_TYPES } from "../model/constants";
import type { Store } from "../store/store";
import { h } from "../ui/dom";
import type { CanvasView } from "./CanvasView";
import { HALF_H, HALF_W } from "./geometry";
import { onPixelRatioChange } from "./pixelRatio";

const W = 208;
const H = 132;

export class Minimap {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private map = { scale: 1, ox: 0, oy: 0 };
  private dragging = false;

  constructor(
    private readonly view: CanvasView,
    private readonly store: Store,
    private readonly vm: ViewModel,
    private readonly ui: UiState,
  ) {
    this.canvas = h("canvas", { class: "minimap-canvas", attrs: { "aria-hidden": "true" } });
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.ctx = this.canvas.getContext("2d")!;
    this.applyPixelRatio();
    // 画素の細かさが違う画面へ移ったら、描く大きさを合わせて描き直す
    onPixelRatioChange(() => {
      this.applyPixelRatio();
      this.schedule();
    });
    this.el = h("div", { class: "minimap", title: "ミニマップ（押すとその場所へ）" }, this.canvas);
    view.onRender(() => this.schedule());
    this.canvas.addEventListener("pointerdown", (ev) => {
      this.dragging = true;
      this.canvas.setPointerCapture(ev.pointerId);
      this.jump(ev);
    });
    this.canvas.addEventListener("pointermove", (ev) => {
      if (this.dragging) this.jump(ev);
    });
    // 離したときのほか、ブラウザに取られた（pointercancel）・捕まえが外れたときも止める（押したままにならないように）
    const stop = () => {
      this.dragging = false;
    };
    this.canvas.addEventListener("pointerup", stop);
    this.canvas.addEventListener("pointercancel", stop);
    this.canvas.addEventListener("lostpointercapture", stop);
    this.canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      this.view.zoomBy(Math.exp(-Math.max(-60, Math.min(60, ev.deltaY)) * 0.006));
    }, { passive: false });
    ui.on("prefs", () => this.applyVisible());
    this.applyVisible();
  }

  /** 描く大きさを今の画素の細かさに合わせる（大きさを変えると変換も戻るので、かけ直す） */
  private applyPixelRatio(): void {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private applyVisible(): void {
    this.el.hidden = !this.ui.prefs.showMinimap || this.ui.prefs.view !== "map";
    if (!this.el.hidden) this.schedule();
  }

  private schedule(): void {
    if (this.el.hidden || this.timer) return;
    const wait = Math.max(0, 90 - (performance.now() - this.last));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.draw();
    }, wait);
  }

  private jump(ev: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    const wx = (mx - this.map.ox) / this.map.scale;
    const wy = (my - this.map.oy) / this.map.scale;
    const z = this.view.camera.zoom;
    this.view.camera.x = this.view.width / 2 - wx * z;
    this.view.camera.y = this.view.height / 2 - wy * z;
    this.view.cameraChanged();
  }

  private draw(): void {
    this.last = performance.now();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    const doc = this.store.doc;
    const b = this.vm.bounds();
    const cam = this.view.camera;
    const tl = cam.toWorld(0, 0);
    const br = cam.toWorld(this.view.width, this.view.height);
    const minX = Math.min(b ? b.minX - HALF_W : tl.x, tl.x);
    const minY = Math.min(b ? b.minY - HALF_H : tl.y, tl.y);
    const maxX = Math.max(b ? b.maxX + HALF_W : br.x, br.x);
    const maxY = Math.max(b ? b.maxY + HALF_H : br.y, br.y);
    const pad = 8;
    const scale = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
    const ox = pad + (W - pad * 2 - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = pad + (H - pad * 2 - (maxY - minY) * scale) / 2 - minY * scale;
    this.map = { scale, ox, oy };
    const nw = Math.max(1.5, HALF_W * 2 * scale);
    const nh = Math.max(1.5, HALF_H * 2 * scale);
    for (const id of this.vm.drawNodes) {
      const n = doc.nodes[id]!;
      const v = this.vm.nodes.get(id)!;
      ctx.globalAlpha = Math.max(0.25, v.alpha);
      ctx.fillStyle = NODE_TYPES[n.type].color;
      ctx.fillRect(ox + (n.x - HALF_W) * scale, oy + (n.y - HALF_H) * scale, nw, nh);
    }
    ctx.globalAlpha = 1;
    // 見ている範囲
    ctx.strokeStyle = "rgba(165,151,255,0.95)";
    ctx.fillStyle = "rgba(139,123,255,0.10)";
    ctx.lineWidth = 1.2;
    const vx = ox + tl.x * scale;
    const vy = oy + tl.y * scale;
    const vw = (br.x - tl.x) * scale;
    const vh = (br.y - tl.y) * scale;
    ctx.fillRect(vx, vy, vw, vh);
    ctx.strokeRect(vx + 0.5, vy + 0.5, vw, vh);
    // 全体が見えているときは引っ込める（キャンバスを広く使う）
    const all = !b || (b.minX - HALF_W >= tl.x && b.maxX + HALF_W <= br.x && b.minY - HALF_H >= tl.y && b.maxY + HALF_H <= br.y);
    this.el.classList.toggle("idle", all && !this.dragging);
  }
}
