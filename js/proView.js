// ===== SpellDash Pro（/pro.html）: 比較・価格・加入・状態 =====
//
// 価格は /api/billing/config から取る（コードに金額を書かない。Stripe の Price が正）。
// 加入は /api/billing/checkout → Stripe Checkout へ移動。管理は /api/billing/portal → Billing Portal へ。
// アプリ（Capacitor）では購入ボタンと価格を出さず、状態だけ出す（加入と管理は Web 版で）。

import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { setupUnloadSync } from "./sync.js";
import { supabase } from "./supabase.js";
import { apiUrl, isNativeApp } from "./appEnv.js";
import { getPlan, refreshPlan, postBilling, formatPlanDate } from "./plan.js";

const MESSAGES = {
  loginRequired: "加入にはログインが必要です。右上からログインしてください。",
  notConfigured: "Pro はまだ受付前です。",
  nativeOnly: "Pro の加入と管理は Web 版（www.spelldash.net）で。",
  alreadyPro: "すでに Pro です。",
  canceled: "手続きを中止しました。いつでも再開できます。",
  failed: "手続きを始められませんでした。時間をおいてお試しください。",
  network: "通信できませんでした。接続を確認してください。",
  noSubscription: "お支払いの記録が見つかりません。加入直後なら、少し待ってから開き直してください。"
};

const plansElement = document.getElementById("proPlans");
const stateElement = document.getElementById("proState");
const messageElement = document.getElementById("proMessage");

let config = null; // { configured, prices, trialDays }（取得前は null）
let session = null;
let busy = false;

initializeAuth();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();

// Checkout から戻ってきた（中止）
if (new URLSearchParams(location.search).get("pro") === "cancel") {
  setMessage(MESSAGES.canceled);
}

supabase.auth.getSession().then(({ data }) => {
  session = data?.session ?? null;
  render();
});
supabase.auth.onAuthStateChange((_event, nextSession) => {
  session = nextSession ?? null;
  render();
});
document.addEventListener("spelldash:plan", render);

// アプリでは購入 UI を出さないので価格も取りに行かない（/api/billing/* は CORS を許可していない）
if (isNativeApp) render();
else loadConfig().then(() => render());

plansElement.addEventListener("click", (event) => {
  const button = event.target.closest("[data-interval]");
  if (button) startCheckout(button.dataset.interval);
});
stateElement.addEventListener("click", (event) => {
  if (event.target.closest("#proPortal")) openPortal();
});

async function loadConfig() {
  try {
    const response = await fetch(apiUrl("/api/billing/config"), { cache: "no-store" });
    const body = await response.json();
    config = {
      configured: response.ok && body?.configured === true,
      prices: Array.isArray(body?.prices) ? body.prices.filter((p) => p && (p.interval === "month" || p.interval === "year") && Number.isFinite(Number(p.amount))) : [],
      trialDays: Number(body?.trialDays) || 0
    };
  } catch {
    config = { configured: false, prices: [], trialDays: 0 };
  }
  if (config.configured && !config.prices.some((p) => p.interval === "month")) config.configured = false;
}

function yen(amount) {
  return `¥${Number(amount).toLocaleString("ja-JP")}`;
}

function setMessage(text, type = "") {
  messageElement.textContent = text;
  messageElement.className = `pro-message${type ? ` pro-message--${type}` : ""}`;
}

// 価格と CTA（#proPlans）
function renderPlans(plan) {
  if (isNativeApp) {
    plansElement.hidden = true;
    plansElement.innerHTML = "";
    return;
  }
  plansElement.hidden = false;

  if (plan.pro) {
    // 加入済み: CTA は出さない（状態欄に管理ボタン）
    plansElement.innerHTML = "";
    return;
  }
  if (!config) {
    plansElement.innerHTML = '<p class="pro-pending">読み込んでいます</p>';
    return;
  }
  if (!config.configured) {
    plansElement.innerHTML = `<p class="pro-pending">${MESSAGES.notConfigured}</p>`;
    return;
  }

  const month = config.prices.find((p) => p.interval === "month");
  const year = config.prices.find((p) => p.interval === "year");
  const perMonth = year ? Math.round(Number(year.amount) / 12) : 0;
  plansElement.innerHTML = `
    <div class="pro-plans__buttons">
      <button type="button" class="btn pro-cta" id="proCheckoutMonth" data-interval="month">月額 ${yen(month.amount)} で始める</button>
      ${year ? `<button type="button" class="btn btn--ghost pro-cta" id="proCheckoutYear" data-interval="year">年額 ${yen(year.amount)}（月あたり ${yen(perMonth)}）</button>` : ""}
    </div>
    <p class="pro-plans__hint">${config.trialDays > 0 ? `最初の ${config.trialDays} 日間は無料。` : ""}税込。いつでも解約できます。解約後も期間の終わりまで使えます。</p>`;
}

// 状態（#proState）
function renderState(plan) {
  if (plan.pro) {
    const date = formatPlanDate(plan.periodEnd);
    const text = plan.cancelAtPeriodEnd
      ? `解約予定（${date || "期間末"} まで利用できます）`
      : `Pro をご利用中${date ? `（次回の更新 ${date}）` : ""}`;
    stateElement.innerHTML = `<span class="pro-state__text">${text}</span>${
      isNativeApp ? "" : ' <button type="button" class="btn btn--sm btn--ghost" id="proPortal">お支払いの管理</button>'
    }`;
    return;
  }
  if (isNativeApp) {
    stateElement.innerHTML = `<span class="pro-pending">${MESSAGES.nativeOnly}</span>`;
    return;
  }
  if (!session) {
    stateElement.textContent = MESSAGES.loginRequired;
    return;
  }
  stateElement.textContent = "";
}

function render() {
  const plan = getPlan();
  renderPlans(plan);
  renderState(plan);
}

function setBusy(on) {
  busy = on;
  for (const button of plansElement.querySelectorAll(".pro-cta")) {
    button.disabled = on;
    if (on) {
      button.dataset.label = button.textContent;
      button.textContent = "準備中…";
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
  }
  const portal = document.getElementById("proPortal");
  if (portal) portal.disabled = on;
}

async function startCheckout(interval) {
  if (busy) return;
  if (!session) {
    setMessage(MESSAGES.loginRequired, "error");
    return;
  }
  setMessage("");
  setBusy(true);
  const { status, body } = await postBilling("/api/billing/checkout", { interval });
  if (status === 200 && typeof body.url === "string" && body.url) {
    location.href = body.url; // Stripe Checkout へ
    return;
  }
  setBusy(false);
  if (status === 401) return setMessage(MESSAGES.loginRequired, "error");
  if (status === 409) {
    setMessage(MESSAGES.alreadyPro);
    refreshPlan();
    return;
  }
  if (status === 503) return setMessage(MESSAGES.notConfigured);
  if (status === 0) return setMessage(MESSAGES.network, "error");
  setMessage(body.message || MESSAGES.failed, "error");
}

async function openPortal() {
  if (busy) return;
  setMessage("");
  setBusy(true);
  const { status, body } = await postBilling("/api/billing/portal");
  if (status === 200 && typeof body.url === "string" && body.url) {
    location.href = body.url; // Billing Portal へ
    return;
  }
  setBusy(false);
  if (status === 401) return setMessage(MESSAGES.loginRequired, "error");
  if (status === 404) return setMessage(MESSAGES.noSubscription, "error");
  if (status === 503) return setMessage(MESSAGES.notConfigured);
  if (status === 0) return setMessage(MESSAGES.network, "error");
  setMessage(body.message || MESSAGES.failed, "error");
}
