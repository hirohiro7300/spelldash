import { initFeedback } from "./feedback.js";
import { initOfflineBanner } from "./offline.js";
import { renderFooterPro } from "./proFunnel.js";

export function setFooterYear() {
  const footerYearElement = document.getElementById("footerYear");
  if (footerYearElement) {
    footerYearElement.textContent = new Date().getFullYear();
  }
  // フッターの「ご意見・不具合」リンク（全ページ共通）
  initFeedback();
  // オフライン表示（全ページ共通）
  initOfflineBanner();
  // 「SpellDash Pro」（受付中のときだけ。docs/SPEC_FUNNEL.md）
  renderFooterPro();
}
