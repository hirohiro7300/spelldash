// ===== Pro への動線（docs/SPEC_FUNNEL.md） =====
//
// 1. 知る: フッターの「SpellDash Pro」と、7 日以上学んだ人の週間レポートの 1 行（受付中のときだけ。アプリでは出さない）
// 2. 加入の途中でログインした人は、戻った先から加入画面（/pro.html）へ戻す（ログインのリンクはトップに戻るため）
//
// 受付中かどうかは /api/billing/config の configured。全ページで毎回は取りに行かず、12 時間キャッシュする。
// 学習の核は無料のまま。完了パネル・道・はちゃんの台詞には Pro を出さない（docs/CHARACTER.md・CONCEPT.md）。

import { apiUrl, isNativeApp } from "./appEnv.js";
import { isPro } from "./plan.js";

const OPEN_KEY = "spelldash_billing_open"; // { open: bool, at: ms }
const OPEN_TTL_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000; // 取れなかったときは前の値のまま、10 分後にもう一度
const RETURN_KEY = "spelldash_login_return"; // sessionStorage: ログインから戻ってきた（加入画面へ移ったあとも freshLogin として扱う）
const INTENT_KEY = "spelldash_pro_intent"; // { at: ms }（加入画面で「ログインして始める」を押した）
const INTENT_TTL_MS = 30 * 60 * 1000;

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

// 受付中か（キャッシュだけを見る。分からなければ false）
export function isBillingOpen() {
  if (isNativeApp) return false;
  const cached = readJson(OPEN_KEY);
  return cached?.open === true;
}

// 加入画面が取った config をそのまま覚える（js/proView.js）
export function rememberBillingOpen(open) {
  const before = isBillingOpen();
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify({ open: !!open, at: Date.now() }));
  } catch {
    // 保存できなくても動線が出ないだけ
  }
  // 受付中かが変わった: 上限の文などを描き直してもらう（初めて開いたページは、取り終える前に描いている）
  if (before !== isBillingOpen()) document.dispatchEvent(new CustomEvent("spelldash:billing", { detail: { open: isBillingOpen() } }));
}

// /api/billing/config を取って整える（加入画面と全ページのキャッシュが同じ規則で「受付中」を決める）。
// 戻り値: { ok, configured, prices, trialDays }。ok=false は取れなかった（受付前とは限らない）
export async function fetchBillingConfig() {
  try {
    const response = await fetch(apiUrl("/api/billing/config"), { cache: "no-store" });
    const body = await response.json();
    const prices = Array.isArray(body?.prices)
      ? body.prices.filter((p) => p && (p.interval === "month" || p.interval === "year") && Number.isFinite(Number(p.amount)))
      : [];
    const configured = response.ok && body?.configured === true && prices.some((p) => p.interval === "month");
    return { ok: response.ok, configured, prices, trialDays: Number(body?.trialDays) || 0 };
  } catch {
    return { ok: false, configured: false, prices: [], trialDays: 0 };
  }
}

// 取れた config だけを覚える。取れなかったときは前の値のまま、10 分後に取り直す
export function rememberBillingConfig(config) {
  if (config.ok) {
    rememberBillingOpen(config.configured);
    return;
  }
  try {
    const prev = readJson(OPEN_KEY);
    localStorage.setItem(OPEN_KEY, JSON.stringify({ open: prev?.open === true, at: Date.now() - OPEN_TTL_MS + RETRY_MS }));
  } catch {
    // 何もしない
  }
}

// キャッシュが古い（または無い）ときだけ config を取りに行く。戻り値: 受付中か
export async function refreshBillingOpen() {
  if (isNativeApp) return false;
  const cached = readJson(OPEN_KEY);
  if (cached && typeof cached.at === "number" && Date.now() - cached.at < OPEN_TTL_MS) return cached.open === true;
  rememberBillingConfig(await fetchBillingConfig());
  return isBillingOpen();
}

// フッターの「SpellDash Pro」（受付中のときだけ。加入画面そのものでは出さない）
export function renderFooterPro() {
  const nav = document.querySelector(".site-footer__nav");
  if (!nav || nav.querySelector("[data-footer-pro]")) return;
  if (location.pathname.endsWith("/pro.html")) return;
  const place = () => {
    if (!isBillingOpen() || nav.querySelector("[data-footer-pro]")) return;
    const link = document.createElement("a");
    link.href = "./pro.html";
    link.dataset.footerPro = "";
    link.dataset.funnel = "footer";
    link.textContent = "SpellDash Pro";
    nav.prepend(link);
  };
  place();
  refreshBillingOpen().then(place);
}

// 「Pro なら…」の案内とリンクを出してよいか（受付中で、アプリではない）。上限に当たった場所も同じ条件で出す
export function canOfferPro() {
  return isBillingOpen();
}

// 週間レポートの 1 行を出すか: 受付中・Pro でない・7 日以上学んだ
export function shouldShowWeeklyPro(activeDaysTotal) {
  return isBillingOpen() && !isPro() && activeDaysTotal >= 7;
}

// ---- 加入の途中のログイン ----

export function setProIntent() {
  try {
    localStorage.setItem(INTENT_KEY, JSON.stringify({ at: Date.now() }));
  } catch {
    // 保存できなければ、ログイン後はトップに戻るだけ
  }
}

export function hasProIntent() {
  const intent = readJson(INTENT_KEY);
  return typeof intent?.at === "number" && Date.now() - intent.at < INTENT_TTL_MS;
}

export function clearProIntent() {
  try {
    localStorage.removeItem(INTENT_KEY);
  } catch {
    // 何もしない
  }
}

// ログインのリンク・Google から戻ってきたタブで呼ぶ（js/auth.js）。加入の途中なら加入画面へ戻す。戻り値: 移動したか。
// 移った先でも「いまログインした」と分かるように印を残す（端末の記録を足すかの確認を飛ばさないため。js/sync.js）
export function resumeProIntent() {
  if (isNativeApp || !hasProIntent()) return false;
  if (isPro()) {
    clearProIntent();
    return false;
  }
  if (location.pathname.endsWith("/pro.html")) return false; // 加入画面が自分で続きを出す
  try {
    sessionStorage.setItem(RETURN_KEY, "1");
  } catch {
    // 印が残せなくても移動はする
  }
  location.replace("./pro.html?resume=1");
  return true;
}

// 直前のページがログインから戻ったタブで、ここへ移ってきたか（1 回だけ読む）
export function takeLoginReturn() {
  try {
    const value = sessionStorage.getItem(RETURN_KEY) === "1";
    sessionStorage.removeItem(RETURN_KEY);
    return value;
  } catch {
    return false;
  }
}
