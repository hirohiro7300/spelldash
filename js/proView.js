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
import { getPlan, refreshPlan, postBilling, waitForPro, planLabel, planActionLabel } from "./plan.js";
import { fetchBillingConfig, rememberBillingConfig, setProIntent, hasProIntent, clearProIntent } from "./proFunnel.js";
import { logFunnel, logFunnelBeforeLeave, markPaidPending, hasPaidPending, freshPaidPending, bindPaidPending } from "./funnelLog.js";

const MESSAGES = {
  loginRequired: "加入にはログインが要る。",
  notConfigured: "Pro はまだ受付前。",
  nativeOnly: "Pro の加入と管理は Web 版（www.spelldash.net）で。",
  alreadyPro: "すでに Pro。",
  canceled: "支払いは中止した。請求は無い。",
  failed: "手続きを始められなかった。時間をおいてもう一度",
  network: "通信できなかった。接続を確認",
  noSubscription: "お支払いの記録が無い。加入直後なら少し待って開き直す"
};

const plansElement = document.getElementById("proPlans");
const welcomeElement = document.getElementById("proWelcome");
const priceElement = document.getElementById("proPrice");
const compareSection = document.getElementById("proCompareSection");
const plansTitle = document.getElementById("proPlansTitle");
const PAID_WAIT_TEXT = "手続きは完了。反映を待っている。もう一度申し込まない（数分たっても Pro にならなければ「ご意見・不具合」から知らせる）";
const stateElement = document.getElementById("proState");
const messageElement = document.getElementById("proMessage");

let config = null; // { configured, prices, trialMonths, trialDays, trialEndsAt }（取得前は null）
let session = null;
let busy = false;
const params = new URLSearchParams(location.search);
let resumePending = params.get("resume") === "1"; // ログインから戻った（加入の途中）。この画面でログインした場合は印（hasProIntent）で見る
let donePending = params.get("pro") === "done"; // Checkout から戻った（支払い済み）
if (donePending) markPaidPending(); // 反映が遅くても、後で Pro になったときに checkout_done を数える
let welcomeActive = donePending; // 反映を待つ間とその後は購入ボタンを出さない（二重の申し込みを防ぐ）
let resumeShown = false;
let sessionKnown = false; // getSession の結果が出たか（出るまでは「ログインしていない」と決めない）
if (params.has("resume") || params.has("pro")) {
  // 開き直したときに同じ案内を繰り返さない
  history.replaceState(null, "", location.pathname + location.hash);
}

initializeAuth();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();

// Checkout から戻ってきた（中止）: 文が見える料金の欄まで送る
if (params.get("pro") === "cancel") {
  setMessage(MESSAGES.canceled);
  logFunnel("checkout_cancel");
  requestAnimationFrame(() => document.getElementById("proPlansSection")?.scrollIntoView({ block: "start" }));
}
if (!isNativeApp && !params.has("pro")) logFunnel("pro_view"); // 動線の計測（docs/SQL_FUNNEL.md）

supabase.auth.getSession().then(({ data }) => {
  session = data?.session ?? null;
  sessionKnown = true;
  bindPaidPending(session?.user?.id); // 支払いの印をこのアカウントに付ける（持ち主がまだ無ければ）
  render();
});
supabase.auth.onAuthStateChange((_event, nextSession) => {
  session = nextSession ?? null;
  if (sessionKnown) bindPaidPending(session?.user?.id);
  render();
});
document.addEventListener("spelldash:plan", render);

// アプリでは購入 UI を出さないので価格も取りに行かない（/api/billing/* は CORS を許可していない）
if (isNativeApp) render();
else loadConfig().then(() => render());

plansElement.addEventListener("click", (event) => {
  // 未ログイン: ヘッダーのログインを開く（ログインが済むと onAuthStateChange で描き直す）
  if (event.target.closest("[data-login]")) {
    setProIntent(); // ログインから戻ったら、この画面へ戻して続きを出す（js/proFunnel.js・js/auth.js）
    logFunnel("login_click");
    // この click が document まで上がると「外側クリック」で閉じられるので、上がり切ってから開く
    setTimeout(() => document.getElementById("loginToggle")?.click(), 0);
    return;
  }
  const button = event.target.closest("[data-interval]");
  if (button) startCheckout(button.dataset.interval);
});
stateElement.addEventListener("click", (event) => {
  if (event.target.closest("#proPortal")) openPortal();
});

async function loadConfig() {
  const fetched = await fetchBillingConfig(); // 全ページのキャッシュと同じ規則（js/proFunnel.js）
  rememberBillingConfig(fetched); // 取れなかったときは受付前と覚えない（前の値のまま 10 分後に取り直す）
  config = { configured: fetched.configured, prices: fetched.prices, trialMonths: fetched.trialMonths, trialDays: fetched.trialDays, trialEndsAt: fetched.trialEndsAt };
}

// 無料期間（初めての方だけ。api/billing/checkout.js が判定する）。無ければ null
//   label: 「1か月」「7日」／ endText: 無料期間の終わりの日（M/D。サーバーが計算した trialEndsAt を日本時間で出すだけ。日数のときは n 日後）
function trialInfo() {
  const months = Number(config?.trialMonths) || 0;
  const days = Number(config?.trialDays) || 0;
  if (months <= 0 && days <= 0) return null;
  const endMs = months > 0 ? Date.parse(config?.trialEndsAt ?? "") : Date.now() + days * 86400000;
  const jst = Number.isNaN(endMs) ? null : new Date(endMs + 9 * 3600000);
  return { label: months > 0 ? `${months}か月` : `${days}日`, endText: jst ? `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}` : "" };
}

// この人に無料期間が付くか: 未ログインは「初めての方は」と案内だけ、ログイン済みは契約の行を読めて、一度も契約が無い人
// （解約後も行は canceled で残る）。行をまだ読めていない（checkedAt が無い）ときは、無料とは約束しない（ボタンは通常の文）
function trialEligible() {
  if (!session) return true;
  const plan = getPlan();
  return Boolean(plan.checkedAt) && plan.status === "none";
}

// ログイン済みで、契約の行をまだ読めていない（無料期間が付くか分からない）
function trialUnknown() {
  return Boolean(session) && !getPlan().checkedAt;
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

  // 加入済み・支払いの反映を待っている: 売り場（比較表・料金の 1 行）は出さず、見出しは「プラン」
  const owned = plan.pro || welcomeActive;
  if (compareSection) compareSection.hidden = owned;
  if (plansTitle) plansTitle.textContent = owned ? "プラン" : "料金";
  if (owned) {
    if (priceElement) priceElement.hidden = true;
    plansElement.innerHTML = "";
    return;
  }
  // 支払いを終えたのに、まだ Pro に反映されていない（開き直した）: 購入ボタンを出さない（二重の申し込みを防ぐ）。
  // ログインが分かるまでは、印があれば待つ側に倒す（購入ボタンを一瞬でも出さない）
  if (freshPaidPending() && (!sessionKnown || hasPaidPending(session?.user?.id))) {
    if (priceElement) priceElement.hidden = true;
    plansElement.innerHTML = `<p class="pro-pending">${PAID_WAIT_TEXT}</p>`;
    return;
  }
  if (!config) {
    plansElement.innerHTML = '<p class="pro-pending">読み込み中</p>';
    return;
  }
  if (!config.configured) {
    plansElement.innerHTML = `<p class="pro-pending">${MESSAGES.notConfigured}</p>`;
    return;
  }

  const month = config.prices.find((p) => p.interval === "month");
  const year = config.prices.find((p) => p.interval === "year");
  if (!month) {
    // 月額の価格が無い（Stripe の設定の入れ替え中など）: ボタンを出さず「準備中」
    plansElement.innerHTML = `<p class="pro-pending">${MESSAGES.notConfigured}</p>`;
    return;
  }
  const perMonth = year ? Math.round(Number(year.amount) / 12) : 0;
  const terms = termsHtml(month, year, perMonth, { withPerMonth: !session });
  // 最初の画面で「いくらで、いつでもやめられるか」が分かるように、見出しの直下に 1 行
  const trialInfoNow = trialInfo();
  if (priceElement) {
    const offer = trialInfoNow && trialEligible() ? `初めての方は最初の${trialInfoNow.label}無料。` : "";
    priceElement.textContent = `月額 ${yen(month.amount)}${year ? ` ／ 年額 ${yen(year.amount)}` : ""}（税込）。${offer}いつでも解約できる。`;
    priceElement.hidden = false;
  }
  const trial = trialInfoNow && session && trialEligible() ? `${trialInfoNow.label}無料で始める` : "";
  if (!session) {
    // 未ログイン: ボタンは「ログインして始める」1 つ（押すとヘッダーのログインが開く。動かないボタンを出さない）
    plansElement.innerHTML = `
    <div class="pro-plans__buttons">
      <button type="button" class="btn pro-cta" id="proLoginStart" data-login>ログインして始める</button>
    </div>
    ${terms}`;
    return;
  }
  plansElement.innerHTML = `
    <div class="pro-plans__buttons">
      <button type="button" class="btn pro-cta" id="proCheckoutMonth" data-interval="month">${trial ? `${trial}（その後 月額 ${yen(month.amount)}）` : `月額 ${yen(month.amount)} で始める`}</button>
      ${year ? `<button type="button" class="btn btn--ghost pro-cta" id="proCheckoutYear" data-interval="year">${trial ? `${trial}（その後 年額 ${yen(year.amount)}）` : `年額 ${yen(year.amount)}（月あたり ${yen(perMonth)}）`}</button>` : ""}
    </div>
    ${terms}`;
}

// 申し込みの前に確かめること（料金・無料期間・更新・解約・支払い）。ボタンの直下に置く（次の Stripe の画面で確定する）
function termsHtml(month, year, perMonth, { withPerMonth = true } = {}) {
  // 月あたりは年額のボタンが言うので、ボタンが出るとき（ログイン済み）は繰り返さない
  const price = `月額 ${yen(month.amount)}${year ? ` ／ 年額 ${yen(year.amount)}${withPerMonth ? `（月あたり ${yen(perMonth)}）` : ""}` : ""}（税込）`;
  const info = trialInfo();
  const charge = `月額 ${yen(month.amount)}${year ? `（年額なら ${yen(year.amount)}）` : ""}`;
  const trial = !info
    ? ""
    : trialEligible()
      ? `<div><dt>無料期間</dt><dd>初めての方だけ、最初の${info.label}は無料。${session && info.endText ? `${info.endText} に` : "無料期間の終わりに"} ${charge}を請求。それまでに解約すれば請求は無い</dd></div>`
      : trialUnknown()
        ? `<div><dt>無料期間</dt><dd>初めての方だけ、最初の${info.label}は無料（付くかどうかは次の Stripe の画面に出る）</dd></div>`
        : `<div><dt>無料期間</dt><dd>初めての方だけ（以前に加入したことがあるので、今回は加入した日に ${charge}を請求）</dd></div>`;
  return `
    <dl class="pro-terms" aria-label="申し込みの前に">
      <div><dt>料金</dt><dd>${price}</dd></div>
      ${trial}
      <div><dt>更新</dt><dd>${year ? "毎月（年額は毎年）" : "毎月"}、同じ料金で自動で更新</dd></div>
      <div><dt>解約</dt><dd>いつでも設定の「解約・お支払いの管理」から。期間の終わりまで使え、日割りの返金はしない</dd></div>
      <div><dt>支払い</dt><dd>カード（次の Stripe の画面で入力して確定）</dd></div>
    </dl>
    <p class="pro-plans__hint"><a href="./tokushoho.html">特定商取引法に基づく表記</a> ・ <a href="./terms.html">利用規約</a></p>`;
}

// 状態（#proState）
function renderState(plan) {
  if (plan.pro) {
    // 文はプロフィールのプラン行と同じ（js/plan.js planLabel。支払い遅延・無料期間・解約予定で分ける）
    const pastDue = plan.status === "past_due";
    stateElement.innerHTML = `<span class="pro-state__text">${planLabel(plan)}</span>${
      isNativeApp ? "" : ` <button type="button" class="btn btn--sm ${pastDue ? "" : "btn--ghost"}" id="proPortal">${planActionLabel(plan)}</button>`
    }`;
    return;
  }
  if (isNativeApp) {
    stateElement.innerHTML = `<span class="pro-pending">${MESSAGES.nativeOnly}</span>`;
    return;
  }
  // 未ログインの案内は主ボタン（ログインして始める）が言うので、ここでは出さない
  stateElement.textContent = "";
}

let scrolledToPlans = false;

function render() {
  const plan = getPlan();
  renderPlans(plan);
  renderState(plan);
  maybeResume(plan);
  maybeWelcome();
  // 加入の途中でログインをやめた（記録を足す確認を断った）: 「ログインして始める」が見える位置へ 1 回だけ送る
  if (!session && sessionKnown && config && !scrolledToPlans && hasProIntent()) {
    scrolledToPlans = true;
    document.getElementById("proPlansSection")?.scrollIntoView({ block: "start" });
  }
}

// ログインから戻った（加入の途中）: 選ぶところから続ける
// ?resume=1（ログインから戻ったタブがここへ移ってきた）なら印を消す。
// この画面のまま別のタブでログインした（印だけある）場合は案内だけ出し、印は戻ってきたタブのために残す
function maybeResume(plan) {
  if (resumeShown || !(resumePending || hasProIntent()) || !session || !config) return;
  resumeShown = true;
  if (resumePending) clearProIntent();
  resumePending = false;
  if (plan.pro || !config.configured || isNativeApp || welcomeActive || hasPaidPending(session.user?.id)) return;
  const hasYear = config.prices.some((p) => p.interval === "year");
  setMessage(hasYear ? "ログインした。月額か年額を選ぶ。" : "ログインした。月額で始められる。");
  logFunnel("login_return");
  document.getElementById("proCheckoutMonth")?.focus({ preventScroll: false });
}

// 支払いを終えて戻った: 反映を待って、使えるようになったものを並べる
const UNLOCKED = [
  { label: "マイ単語帳 1,000語まで", href: "./list.html#myWords" },
  { label: "テーマ 紙・藍", href: "./profile.html#appearance" },
  { label: "覚えた単語の推移 90日", href: "./stats.html#week" },
  { label: "連続記録の修復 月 1 回", href: "" },
  { label: "AI の解説 1 日 60 回・カード作成 20 回", href: "" }
];

function maybeWelcome() {
  if (!donePending || !welcomeElement) return;
  if (!session) {
    // ログインが切れている（別のブラウザ・期限切れ）: 支払いは Stripe で済んでいるので、ログインすれば反映されると伝える
    if (!sessionKnown) return;
    donePending = false;
    welcomeElement.hidden = false;
    welcomeElement.innerHTML = `<p class="pro-welcome__title" role="status">手続きは完了。加入したアカウントでログインすると Pro になる</p>`;
    welcomeActive = false;
    render();
    return;
  }
  donePending = false;
  clearProIntent();
  welcomeElement.hidden = false;
  welcomeElement.innerHTML = `<p class="pro-welcome__title" role="status">手続きを確認中…</p>`;
  waitForPro({ tries: 30 }).then((ok) => {
    if (!ok) {
      // 反映がまだ（約 1 分待った）: 購入ボタンは出さないまま。開き直しても「支払い済み」の印で出さない（renderPlans）
      welcomeElement.innerHTML = `<p class="pro-welcome__title" role="status">${PAID_WAIT_TEXT}</p>`;
      return;
    }
    const items = UNLOCKED.map((u) => `<li>${u.href ? `<a href="${u.href}">${u.label}</a>` : u.label}</li>`).join("");
    welcomeElement.innerHTML = `
      <p class="pro-welcome__title" role="status">Pro になった。ありがとう</p>
      <p class="pro-welcome__lead">いまから使えるもの</p>
      <ul class="pro-welcome__list">${items}</ul>`;
  });
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
    await logFunnelBeforeLeave("checkout_start", interval); // 移る前に送る（長くても 0.8 秒）
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
