// ノードの上で直接タイトルを編集する欄（日本語入力の変換中の Enter では確定しない）

import type { Commands } from "../app/commands";
import { NODE_W } from "../model/constants";
import type { ID } from "../model/types";
import type { Store } from "../store/store";
import { h } from "../ui/dom";
import type { CanvasView } from "./CanvasView";
import { HALF_H, HALF_W } from "./geometry";

export class InlineEditor {
  private el: HTMLTextAreaElement | null = null;
  private id: ID | null = null;
  private original = "";

  constructor(
    private readonly view: CanvasView,
    private readonly store: Store,
    private readonly cmd: Commands,
  ) {
    view.onCamera(() => this.place());
    store.on("change", () => {
      if (this.id && !this.store.doc.nodes[this.id]) this.cancel();
    });
  }

  get active(): boolean {
    return this.el !== null;
  }

  start(id: ID): void {
    if (this.store.readOnly) return;
    const n = this.store.doc.nodes[id];
    if (!n) return;
    this.commit();
    // 小さすぎると打ちにくいので寄る
    if (this.view.camera.zoom < 0.7) this.view.centerOn(id, { zoom: 1, animate: false });
    else this.view.centerOn(id, { onlyIfHidden: true, animate: false });
    this.id = id;
    this.original = n.title;
    const ta = h("textarea", { class: "inline-editor", attrs: { "aria-label": "タイトル", rows: "2", spellcheck: "false" } });
    ta.value = n.title;
    ta.placeholder = "タイトルを入力";
    ta.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        this.commit();
        this.view.canvas.focus();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.cancel();
        this.view.canvas.focus();
      } else if (ev.key === "Tab" && !ev.isComposing) {
        // 確定して、続けて子を作る
        ev.preventDefault();
        const nid = this.id;
        this.commit();
        if (nid) this.cmd.addChild(nid);
      }
    });
    ta.addEventListener("blur", () => this.commit());
    this.el = ta;
    this.view.editingId = id;
    this.view.root.append(ta);
    this.place();
    this.view.requestRender();
    // すぐに入力を受ける（続けて打った文字がキャンバスのショートカットへ行かないように）
    ta.focus({ preventScroll: true });
    ta.select();
  }

  place(): void {
    if (!this.el || !this.id) return;
    const n = this.store.doc.nodes[this.id];
    if (!n) return;
    const z = this.view.camera.zoom;
    const inset = n.type === "branch" ? 22 : 16;
    const p = this.view.camera.toScreen(n.x - HALF_W + inset - 4, n.y - HALF_H + 38);
    const s = this.el.style;
    s.left = `${p.x}px`;
    s.top = `${p.y}px`;
    s.width = `${(NODE_W - inset * 2 + 8) * z}px`;
    s.height = `${46 * z}px`;
    s.fontSize = `${15 * z}px`;
    s.lineHeight = `${19.5 * z}px`;
    s.padding = `${2 * z}px ${4 * z}px`;
    s.borderRadius = `${6 * z}px`;
  }

  commit(): void {
    if (!this.el || !this.id) return;
    const id = this.id;
    const value = this.el.value.replace(/\s*\n\s*/g, " ");
    this.teardown();
    if (value !== this.original) this.cmd.updateNode(id, { title: value }, { label: "タイトルを編集" });
  }

  cancel(): void {
    this.teardown();
  }

  private teardown(): void {
    const el = this.el;
    this.el = null;
    this.id = null;
    this.view.editingId = null;
    el?.remove();
    this.view.requestRender();
  }
}
