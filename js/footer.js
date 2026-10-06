import { initFeedback } from "./feedback.js";
import { initOfflineBanner } from "./offline.js";
import { renderFooterPro } from "./proFunnel.js";
import { trackProEntries, flushFunnelQueue, trackFirstVisit, flushPaidPending } from "./funnelLog.js";
import { isPro } from "./plan.js";

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
  // 動線の計測（docs/SQL_FUNNEL.md）: 加入画面へのリンクの入口と、初めて来た端末（学習記録の無い端末で番号を作ったとき）
  trackProEntries();
  flushFunnelQueue();
  trackFirstVisit();
  flushPaidPending(isPro());
  document.addEventListener("spelldash:plan", () => flushPaidPending(isPro()));
}
