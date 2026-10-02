// ===== フォーカストラップ（モーダル・シート・ドロップダウン共通） =====
//
// 開いている間、Tab／Shift+Tab を container の中で循環させ、Esc で閉じ、閉じたら開く前の要素に焦点を戻す。
// 使い方:
//   const release = trapFocus(panel, { onEscape: close, initialFocus: panel.querySelector(".close") });
//   ... 閉じるとき release();
// loop:false にすると、端で Tab を押したときに循環せず onEscape を呼ぶ（ドロップダウン: 抜けたら閉じる）。
// restoreFocus:false にすると閉じても焦点を戻さない（呼び出し側で別の要素に移すとき）。

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "summary"
].join(",");

function isVisible(el) {
  if (el.closest("[hidden]")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 || el === document.activeElement;
}

export function focusableIn(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest("[inert]") && isVisible(el));
}

// 開いている間、背後（container を含まない body 直下の要素）を inert にする。戻す関数を返す
export function inertOthers(container) {
  const touched = [];
  for (const child of document.body.children) {
    if (child === container || child.contains(container) || child.tagName === "SCRIPT") continue;
    if (child.hasAttribute("inert")) continue;
    child.setAttribute("inert", "");
    touched.push(child);
  }
  return () => touched.forEach((el) => el.removeAttribute("inert"));
}

export function trapFocus(container, { onEscape, initialFocus, loop = true, restoreFocus = true, inert = false } = {}) {
  if (!container) return () => {};
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const restoreInert = inert ? inertOthers(container) : () => {};

  const focusFirst = () => {
    const target = (typeof initialFocus === "function" ? initialFocus() : initialFocus) || focusableIn(container)[0] || container;
    if (target === container && !container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
    try {
      target.focus({ preventScroll: true });
    } catch {
      // 一部の要素は focus() を持たない
    }
  };

  const onKeydown = (event) => {
    if (event.key === "Escape") {
      if (onEscape) {
        event.preventDefault();
        event.stopPropagation();
        onEscape(event);
      }
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusableIn(container);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = container.contains(active);
    if (event.shiftKey) {
      if (!inside || active === first || active === container) {
        if (!loop) return onEscape?.(event, { leaving: "backward" });
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      if (!loop) return onEscape?.(event, { leaving: "forward" });
      event.preventDefault();
      first.focus();
    }
  };

  // マウス等で外に焦点が出たとき（loop のモーダルでは中へ戻す。ドロップダウンは閉じる）
  const onFocusIn = (event) => {
    if (container.contains(event.target)) return;
    if (loop) {
      const items = focusableIn(container);
      (items[0] || container).focus({ preventScroll: true });
    } else {
      onEscape?.(event, { leaving: "pointer" });
    }
  };

  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("focusin", onFocusIn);
  focusFirst();

  let released = false;
  return function release({ restore = restoreFocus } = {}) {
    if (released) return;
    released = true;
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("focusin", onFocusIn);
    restoreInert();
    if (restore && opener && opener.isConnected && !opener.closest("[hidden]")) {
      try {
        opener.focus({ preventScroll: true });
      } catch {
        // 無視
      }
    }
  };
}
