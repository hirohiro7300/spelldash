import { getStreak, hasPlayedToday } from "./level.js";
import { icon } from "./icons.js";

// 全ページのヘッダーに連続日数を常時表示する（線画の炎＋日数。絵文字は使わない）。
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
  el.innerHTML = `${icon("flame", { size: 14 })}<b>${streak.current}</b><span>日</span>`;
  el.setAttribute("aria-label", `連続 ${streak.current}日${done ? "" : "（今日はまだ）"}`);
}
