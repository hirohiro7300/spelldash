import { getStreak, hasPlayedToday } from "./level.js";

// 全ページのヘッダーに🔥ストリークを常時表示する。
// 「今日まだやっていない」がどのページでも目に入る＝損失回避の常時提示

export function renderHeaderStreak() {
  const headerInner = document.querySelector(".site-header__inner");
  if (!headerInner) return;

  let el = document.getElementById("headerStreak");
  if (!el) {
    el = document.createElement("a");
    el.id = "headerStreak";
    el.className = "header-streak";
    el.href = "/";
    el.title = "連続プレイ日数";
    const account = headerInner.querySelector(".account");
    headerInner.insertBefore(el, account ?? null);
  }

  const streak = getStreak();
  const done = hasPlayedToday();

  el.classList.toggle("header-streak--off", !done);
  el.textContent = `🔥 ${streak.current}`;
}
