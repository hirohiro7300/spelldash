import { getStreak, hasPlayedToday } from "./level.js";
import { icon } from "./icons.js";
import { watchHeaderFit } from "./headerFit.js";

// 全ページのヘッダーに連続日数を常時表示する（線画の炎＋日数。絵文字は使わない）。
// 「今日まだやっていない」がどのページでも目に入る＝損失回避の常時提示

// Batch 78: ヘッダーには出さない（依頼 §6「連続記録を人質にしない」）。連続日数の記録（spelldash_streak・js/level.js）と下の描き方は残す。
// 静的な頁（js/staticHeader.js が描く札）は css/brand.css の「ヘッダーの連続日数」の規則が消す。戻すときは true にして、その CSS の 2 つの規則を消す
export const HEADER_STREAK_SHOWN = false;

export function renderHeaderStreak() {
  const headerInner = document.querySelector(".site-header__inner");
  if (!headerInner) return;

  if (!HEADER_STREAK_SHOWN) {
    watchHeaderFit(); // ナビの 1 行の測りはこれまでどおり（連続日数を描いた後に呼んでいた所）
    return;
  }

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

  el.hidden = streak.current === 0; // 0 は見せない（初回も、途切れた朝も）。1 セット終えれば戻る

  el.classList.toggle("header-streak--off", !done);
  el.innerHTML = `${icon("flame", { size: 14 })}<b>${streak.current}</b><span>日</span>`;
  el.setAttribute("aria-label", `連続 ${streak.current}日${done ? "" : "（今日はまだ）"}`);
  watchHeaderFit(); // 1 行に入らなければ細い形に（字の寸法によらず測って決める。以後の変化は js/headerFit.js が見張る）
}
