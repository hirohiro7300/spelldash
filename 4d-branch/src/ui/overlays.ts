// 浮かぶ部品: メニュー（右クリック・ドロップダウン）・ダイアログ・お知らせ

import { h, clear } from "./dom";
import { icon } from "./icons";

// ------------------------------------------------------------ メニュー

export interface MenuItem {
  label: string;
  icon?: string;
  /** 色の点（プロジェクト・シナリオ・種類） */
  swatch?: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  hint?: string;
  run?: () => void;
  submenu?: MenuEntry[];
}

export type MenuEntry = MenuItem | "sep" | { header: string };

let openMenu: { el: HTMLElement; close: () => void } | null = null;

export function closeMenus(): void {
  openMenu?.close();
}

/** (x, y) にメニューを出す。画面からはみ出さないように寄せる */
export function showMenu(x: number, y: number, entries: MenuEntry[], opts: { minWidth?: number; className?: string; onClose?: () => void } = {}): () => void {
  closeMenus();
  const layer = document.getElementById("overlay-root") ?? document.body;
  let sub: HTMLElement | null = null;
  const close = () => {
    el.remove();
    sub?.remove();
    document.removeEventListener("pointerdown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
    if (openMenu?.el === el) openMenu = null;
    opts.onClose?.();
  };
  const build = (items: MenuEntry[], isSub: boolean): HTMLElement => {
    const m = h("div", { class: `menu ${opts.className ?? ""}`, role: "menu" });
    if (opts.minWidth) m.style.minWidth = `${opts.minWidth}px`;
    for (const it of items) {
      if (it === "sep") {
        m.append(h("div", { class: "menu-sep", role: "separator" }));
        continue;
      }
      if ("header" in it) {
        m.append(h("div", { class: "menu-header" }, it.header));
        continue;
      }
      const row = h(
        "button",
        { class: `menu-item${it.danger ? " danger" : ""}${it.checked ? " checked" : ""}`, role: "menuitem", disabled: it.disabled, type: "button", title: it.hint },
        h("span", { class: "menu-check" }, it.checked ? icon("check", 14, 2) : null),
        it.swatch ? h("span", { class: "swatch", style: { background: it.swatch } }) : it.icon ? icon(it.icon, 15) : h("span", { class: "menu-icon-gap" }),
        h("span", { class: "menu-label" }, it.label),
        it.shortcut ? h("kbd", { class: "menu-kbd" }, it.shortcut) : null,
        it.submenu ? icon("chevronRight", 14) : null,
      );
      if (it.submenu) {
        const items2 = it.submenu;
        const openSub = () => {
          sub?.remove();
          sub = build(items2, true);
          layer.append(sub);
          const r = row.getBoundingClientRect();
          place(sub, r.right - 4, r.top - 6, r.left + 4);
        };
        row.addEventListener("mouseenter", openSub);
        row.addEventListener("click", (ev) => {
          ev.preventDefault();
          openSub();
        });
      } else {
        row.addEventListener("mouseenter", () => {
          if (!isSub) {
            sub?.remove();
            sub = null;
          }
        });
        row.addEventListener("click", () => {
          if (it.disabled) return;
          close();
          it.run?.();
        });
      }
      m.append(row);
    }
    return m;
  };
  const el = build(entries, false);
  layer.append(el);
  place(el, x, y);
  const onDoc = (ev: PointerEvent) => {
    const t = ev.target as Node;
    if (!el.contains(t) && !sub?.contains(t)) close();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const scope = sub && sub.contains(document.activeElement) ? sub : el;
      const btns = [...scope.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)")];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      const next = btns[(i + (ev.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length];
      next?.focus();
    }
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
  });
  openMenu = { el, close };
  return close;
}

function place(el: HTMLElement, x: number, y: number, flipX?: number): void {
  el.style.left = "0px";
  el.style.top = "0px";
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x;
  if (left + r.width > vw - 8) left = flipX !== undefined ? flipX - r.width : vw - r.width - 8;
  let top = y;
  if (top + r.height > vh - 8) top = Math.max(8, vh - r.height - 8);
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

/** ボタンの下にメニューを出す */
export function menuFromButton(btn: HTMLElement, entries: MenuEntry[], opts: { align?: "left" | "right"; minWidth?: number } = {}): void {
  const r = btn.getBoundingClientRect();
  btn.classList.add("is-open");
  const close = showMenu(opts.align === "right" ? r.right : r.left, r.bottom + 6, entries, { minWidth: opts.minWidth ?? r.width, onClose: () => btn.classList.remove("is-open") });
  if (opts.align === "right") {
    const el = document.querySelector<HTMLElement>("#overlay-root > .menu:last-child");
    if (el) el.style.left = `${Math.max(8, r.right - el.getBoundingClientRect().width)}px`;
  }
  void close;
}

// ------------------------------------------------------------ ダイアログ

export interface ModalHandle {
  el: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  close: () => void;
}

export function openModal(opts: { title: string; subtitle?: string; width?: number; className?: string; onClose?: () => void; icon?: string }): ModalHandle {
  closeMenus();
  const layer = document.getElementById("overlay-root") ?? document.body;
  const prevFocus = document.activeElement as HTMLElement | null;
  const body = h("div", { class: "modal-body" });
  const footer = h("div", { class: "modal-footer" });
  const closeBtn = h("button", { class: "icon-btn modal-close", type: "button", ariaLabel: "閉じる", title: "閉じる（Esc）" }, icon("x", 16));
  const panel = h(
    "div",
    { class: `modal ${opts.className ?? ""}`, role: "dialog", attrs: { "aria-modal": "true", "aria-label": opts.title } },
    h("div", { class: "modal-head" }, opts.icon ? h("span", { class: "modal-icon" }, icon(opts.icon, 18)) : null, h("div", { class: "modal-titles" }, h("h2", { class: "modal-title" }, opts.title), opts.subtitle ? h("p", { class: "modal-subtitle" }, opts.subtitle) : null), closeBtn),
    body,
    footer,
  );
  if (opts.width) panel.style.width = `min(${opts.width}px, calc(100vw - 32px))`;
  const backdrop = h("div", { class: "modal-backdrop" }, panel);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.add("closing");
    document.removeEventListener("keydown", onKey, true);
    setTimeout(() => backdrop.remove(), 140);
    opts.onClose?.();
    prevFocus?.focus?.();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && !document.querySelector(".menu")) {
      ev.stopPropagation();
      ev.preventDefault();
      close();
    }
    if (ev.key === "Tab") {
      // フォーカスをダイアログの中に留める
      const f = [...panel.querySelectorAll<HTMLElement>("button,input,textarea,select,[tabindex]:not([tabindex='-1'])")].filter((x) => !x.hasAttribute("disabled"));
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  };
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("pointerdown", (ev) => {
    if (ev.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);
  layer.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("open"));
  return { el: panel, body, footer, close };
}

export function confirmDialog(opts: { title: string; body: string; ok: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({ title: opts.title, width: 440, icon: opts.danger ? "alert" : "help", onClose: () => resolve(result) });
    m.body.append(h("p", { class: "modal-text" }, opts.body));
    const okBtn = h("button", { class: `btn ${opts.danger ? "btn-danger" : "btn-primary"}`, type: "button" }, opts.ok);
    okBtn.addEventListener("click", () => {
      result = true;
      m.close();
    });
    const cancel = h("button", { class: "btn", type: "button", onClick: () => m.close() }, opts.cancel ?? "キャンセル");
    m.footer.append(cancel, okBtn);
    setTimeout(() => okBtn.focus());
  });
}

// ------------------------------------------------------------ お知らせ

export interface ToastOpts {
  action?: { label: string; run: () => void };
  tone?: "info" | "warn" | "error" | "ok";
  ms?: number;
}

export function toast(text: string, opts: ToastOpts = {}): void {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = h("div", { class: "toast-stack", attrs: { "aria-live": "polite" } });
    stack.id = "toast-stack";
    (document.getElementById("overlay-root") ?? document.body).append(stack);
  }
  const el = h("div", { class: `toast tone-${opts.tone ?? "info"}`, role: "status" }, h("span", { class: "toast-text" }, text));
  let timer: ReturnType<typeof setTimeout>;
  const close = () => {
    clearTimeout(timer);
    el.classList.add("closing");
    setTimeout(() => el.remove(), 180);
  };
  if (opts.action) {
    const a = opts.action;
    el.append(h("button", { class: "toast-action", type: "button", onClick: () => (close(), a.run()) }, a.label));
  }
  el.append(h("button", { class: "toast-close icon-btn", type: "button", ariaLabel: "閉じる", onClick: close }, icon("x", 14)));
  stack.append(el);
  while (stack.children.length > 3) stack.firstElementChild?.remove();
  timer = setTimeout(close, opts.ms ?? (opts.action ? 6000 : 3200));
}

export function clearChildren(el: HTMLElement): void {
  clear(el);
}
