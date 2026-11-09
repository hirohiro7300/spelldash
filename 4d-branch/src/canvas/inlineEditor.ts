// ノードの上で直接タイトルを編集する欄（日本語入力の変換中の Enter・Esc・Tab は入力に任せる）

import type { Commands } from "../app/commands";
import { NODE_W } from "../model/constants";
import type { ID } from "../model/types";
import type { Store } from "../store/store";
import { h, isMac } from "../ui/dom";
import type { CanvasView } from "./CanvasView";
import { HALF_H, HALF_W } from "./geometry";

/** 欄が自分で使うキー（⌘・Ctrl と一緒でもアプリへは通さない） */
const EDITOR_KEYS = new Set(["Enter", "Escape", "Tab"]);

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
      // 変換中のキーは日本語入力のもの（macOS の Chrome は isComposing、Safari は keyCode 229 で分かる）
      const composing = ev.isComposing || ev.keyCode === 229;
      // ⌘S（保存）・⌘K（検索）・⌘E（書き出し）はアプリのショートカットへ通す（止めるとブラウザの「ページを保存」などが開く）。
      // ⌘Z・⌘A などは、入力中の欄にはアプリが手を出さないので、ふだんの文字の編集のまま。
      // Mac の Ctrl+K・Ctrl+E は行の編集のキーなので通さない
      if (!composing && (isMac ? ev.metaKey : ev.ctrlKey) && !EDITOR_KEYS.has(ev.key)) {
        const key = ev.key.toLowerCase();
        if (key === "s" || key === "e") {
          // 保存・書き出しには打っている題名も入れる
          this.commit();
          this.view.canvas.focus();
        }
        return;
      }
      ev.stopPropagation();
      // 変換中は欄のショートカットも使わない（Esc で編集ごと取り消さない・Tab で子を作らない）
      if (composing) return;
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        this.commit();
        this.view.canvas.focus();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.cancel();
        this.view.canvas.focus();
      } else if (ev.key === "Tab") {
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
