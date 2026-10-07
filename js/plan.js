// ===== プラン（SpellDash Pro）の状態 =====
//
// 本人の subscriptions 行（RLS で本人だけ読める）を localStorage（spelldash_plan）にキャッシュし、
// 各所の「Pro かどうか」は同期的に isPro() で判定する（毎回ネットワークに行かない）。
// 判定の式はサーバー（api/_lib/billing.js の isProRow）と同じ: status が active / trialing / past_due で、
// current_period_end が無いか、current_period_end + 3 日を過ぎていなければ Pro。
// 真偽の最終判断はサーバー（AI の回数など）。ここは表示とローカルのゲートだけ。

import { supabase } from "./supabase.js";
import { apiUrl } from "./appEnv.js";

const KEY = "spelldash_plan";
const GRACE_MS = 3 * 86400000; // 更新失敗などに備えた 3 日の猶予
const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);
const FREE = { pro: false, status: "none", interval: null, periodEnd: null, cancelAtPeriodEnd: false, checkedAt: null };

// サーバーと同じ式（モジュールは共有しない）。row は subscriptions の行、または getPlan() の形
export function isProRow(row, now = Date.now()) {
  if (!row || !PRO_STATUSES.has(row.status)) return false;
  const end = row.current_period_end ?? row.periodEnd ?? null;
  if (!end) return true;
  const endMs = Date.parse(end);
  if (Number.isNaN(endMs)) return false; // 読めない日付は free（サーバーと同じ）
  return endMs + GRACE_MS > now;
}

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

export function getPlan(now = Date.now()) {
  const cached = readCache();
  if (!cached) return { ...FREE };
  const plan = {
    status: typeof cached.status === "string" ? cached.status : "none",
    interval: cached.interval === "month" || cached.interval === "year" ? cached.interval : null,
    periodEnd: typeof cached.periodEnd === "string" ? cached.periodEnd : null,
    cancelAtPeriodEnd: cached.cancelAtPeriodEnd === true,
    checkedAt: typeof cached.checkedAt === "string" ? cached.checkedAt : null
  };
  return { pro: isProRow(plan, now), ...plan };
}

// キャッシュだけで判定（checkedAt は見ない。期限 + 3 日を過ぎていれば false）
export function isPro(now = Date.now()) {
  return isProRow(getPlan(now), now);
}

function emit() {
  document.dispatchEvent(new CustomEvent("spelldash:plan", { detail: getPlan() }));
  // 失効した人が Pro のテーマ（紙・藍）のままなら、theme.js に戻してもらう
  const theme = document.documentElement.dataset.theme;
  if ((theme === "paper" || theme === "indigo") && !isPro()) {
    import("./theme.js").then((m) => m.applyTheme()).catch(() => {});
  }
}

function savePlan(row) {
  const plan = {
    status: typeof row?.status === "string" ? row.status : "none",
    interval: row?.plan_interval === "month" || row?.plan_interval === "year" ? row.plan_interval : null,
    periodEnd: typeof row?.current_period_end === "string" ? row.current_period_end : null,
    cancelAtPeriodEnd: row?.cancel_at_period_end === true,
    checkedAt: new Date().toISOString()
  };
  localStorage.setItem(KEY, JSON.stringify(plan));
}

// サーバーの行を読み直してキャッシュを更新する（ログイン直後・ページ表示時・加入後）
export async function refreshPlan() {
  let session = null;
  try {
    const { data } = await supabase.auth.getSession();
    session = data?.session ?? null;
  } catch {
    session = null;
  }

  if (!session) {
    localStorage.removeItem(KEY);
    emit();
    return getPlan();
  }

  let result = null;
  try {
    result = await supabase
      .from("subscriptions")
      .select("status,plan_interval,current_period_end,cancel_at_period_end")
      .eq("user_id", session.user.id)
      .maybeSingle();
  } catch {
    result = null;
  }

  // 読めなかった（テーブル無し・オフライン等）ときは既存のキャッシュを保つ
  if (result && typeof result === "object" && !result.error && typeof result.data !== "function") {
    savePlan(result.data); // 行が無ければ data=null → free として保存
  }
  emit();
  return getPlan();
}

// ?pro=done 用: webhook の反映を待って何度か読み直す。Pro になれば true
export async function waitForPro({ tries = 6, interval = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await refreshPlan();
    if (isPro()) return true;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, interval));
  }
  return isPro();
}

// ログアウト時
export function clearPlan() {
  localStorage.removeItem(KEY);
  emit();
}

// ===== 課金 API（/api/billing/checkout・portal）への POST =====
// 本人のアクセストークンを Bearer で付ける。応答は { status, body } にそろえる（通信できなければ status 0）。
// セッションが無ければ 401 相当を返し、ネットワークには出ない
export async function postBilling(path, payload = {}) {
  let token = null;
  try {
    const { data } = await supabase.auth.getSession();
    token = data?.session?.access_token ?? null;
  } catch {
    token = null;
  }
  if (!token) return { status: 401, body: { error: "login_required" } };

  let response;
  try {
    response = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      cache: "no-store"
    });
  } catch {
    return { status: 0, body: {} };
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body: body && typeof body === "object" ? body : {} };
}

// 「YYYY/M/D」（更新日・利用期限の表示用）。読めない日付は空文字
export function formatPlanDate(iso) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// プランの 1 行（加入画面の状態欄とプロフィールのプラン行で同じ文）。status で分ける
//   free → "無料" / pro → "Pro（次回の更新 YYYY/M/D）" / 解約予定 → "Pro（解約予定・YYYY/M/D まで使える）"
//   支払い遅延は日付を出さない（更新に失敗した時点で期限は次の期間の終わりに進んでいて、無料に戻る日は Stripe の再試行が決める）
export function planLabel(plan = getPlan()) {
  if (!plan.pro) return "無料";
  const date = formatPlanDate(plan.periodEnd);
  if (plan.status === "past_due") return "Pro（お支払いが確認できていない。カードを更新しないと無料に戻る）";
  if (plan.cancelAtPeriodEnd) return date ? `Pro（解約予定・${date} まで使える）` : "Pro（解約予定）";
  if (plan.status === "trialing") return date ? `Pro の無料期間中（${date} から有料で自動更新）` : "Pro の無料期間中";
  return date ? `Pro（次回の更新 ${date}）` : "Pro";
}

// 支払いの管理ボタンの文（加入画面とプロフィールで同じ）
export function planActionLabel(plan = getPlan()) {
  return plan.status === "past_due" ? "カードを更新する" : "解約・お支払いの管理";
}
