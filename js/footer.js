import { initFeedback } from "./feedback.js";
import { initOfflineBanner } from "./offline.js";
import { renderFooterPro } from "./proFunnel.js";
import { trackProEntries, flushFunnelQueue, trackFirstVisit, flushPaidPending } from "./funnelLog.js";
import { isPro, getPlan } from "./plan.js";

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
  // 支払いの完了は、サーバーで確かめた Pro（spelldash:plan。js/plan.js の refreshPlan が投げる）だけで数える。
  // 読み込み時のキャッシュでは数えない（期限切れ間近の past_due の人が払い直した直後に、確定前で数えてしまうため）
  document.addEventListener("spelldash:plan", () => flushPaidPending(isPro(), getPlan().user));
}

// 読み込みの間は題より下とフッターを透明にしているページ（body[data-pending]。単語帳・学習データ・加入画面。css/pages.css。Batch 67 C1）を出す。
// 描き終えた同じタスクで呼ぶ。描いた字の形（明朝・数字の woff2）がまだ届いていなければ待つ（差し替えで折り返しが変わると、出した後に下が動く）。
// 待つのは長くても fontWait ms（届かない字のために中身を出さないことはしない。0 なら待たない）。既定は FONT_WAIT_MS
export const FONT_WAIT_MS = 300;
// 300ms にした理由（PR #170 のレビュー 6。前は 1,000ms）: 3 ページの LCP は帯のヘッダーか題（透明にしない所）で、出す時刻に動かない（全応答 0／80／300ms 遅延 ×
// 1200／390／320 で待ち 1,000・300・150・0 の差は計測の揺れの内）。全応答が遅いときは字も描き終えて 300ms 以内に届くので、待ち 300 でも 1,000 と同じく
// 出した後の差し替えは無い（CLS 0.0003〜0.0014）。字だけが遅い（+500・+1,500ms）ときは 1,000 だと中身を最大 1 秒透明にする。待たない（0）と全応答 300ms 遅延でも
// 差し替えが見える（単語帳 320 で 0.10 → 分野パックの見出しの行を 1 行に固定して直した。学習データ 390 で 0.009）ので 0 にはしない
export function revealPendingPage({ fontWait = FONT_WAIT_MS } = {}) {
  if (!document.body.hasAttribute("data-pending")) return;
  const reveal = () => document.body.removeAttribute("data-pending");
  void document.body.offsetHeight; // いま描いた中身の字を組む（ここで使う字の読み込みが始まり、document.fonts.ready が待つ）
  if (!fontWait || !document.fonts || document.fonts.status === "loaded") return reveal();
  Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, fontWait))]).then(reveal, reveal);
}
