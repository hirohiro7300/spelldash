// ===== Pro の加入（Stripe Checkout セッションを作る。Vercel Serverless Function） =====
//
// POST /api/billing/checkout  { interval: "month" | "year" }
//   Authorization: Bearer <Supabase アクセストークン>（ログイン必須）
// → { url }（Stripe Checkout のページ。クライアントはここへ遷移する）
//   503 not_configured / 401 login_required / 400 bad_request（interval が不正、年額が未設定）
//   409 already_subscribed（本人の行がすでに Pro）/ 502 upstream
//
// 本人の行は本人のトークンで読む（RLS）。success / cancel の URL は SITE_ORIGIN からだけ作る（リクエストヘッダは使わない）。
// Web 専用（アプリでは購入ボタンを出さない）なので CORS は許可しない。

import { send, readBody, verifyUserFull, bearerToken } from "../_lib/shared.js";
import {
  rejectMethod,
  billingConfigured,
  priceIdFor,
  trialDays,
  siteOrigin,
  stripeFetch,
  fetchOwnSubscription,
  isProRow,
  sendUpstream,
  MESSAGES
} from "../_lib/billing.js";

// Stripe 側で「まだ生きている」契約。これがあるうちは新しい Checkout を作らない
const LIVE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

export default async function handler(req, res) {
  if (rejectMethod(req, res, "POST")) return;
  if (!billingConfigured()) return send(res, 503, { error: "not_configured", message: MESSAGES.notConfigured });

  const user = await verifyUserFull(req.headers.authorization);
  if (!user) return send(res, 401, { error: "login_required", message: MESSAGES.login });

  const interval = readBody(req).interval;
  if (interval !== "month" && interval !== "year") return send(res, 400, { error: "bad_request", message: MESSAGES.badInterval });
  const priceId = priceIdFor(interval);
  if (!priceId) return send(res, 400, { error: "bad_request", message: MESSAGES.yearlyUnavailable });

  try {
    const row = await fetchOwnSubscription(bearerToken(req.headers.authorization), user.id);
    if (isProRow(row)) return send(res, 409, { error: "already_subscribed", message: MESSAGES.alreadySubscribed });
    // webhook がまだ届いていない直後や、別のタブからの二重加入を防ぐ: 既知の顧客なら Stripe 側の生きている契約も見る
    if (row?.stripe_customer_id) {
      const list = await stripeFetch("/v1/subscriptions", { customer: row.stripe_customer_id, status: "all", limit: 10 }, { method: "GET" });
      if ((Array.isArray(list?.data) ? list.data : []).some((s) => LIVE_STATUSES.has(s?.status))) {
        return send(res, 409, { error: "already_subscribed", message: MESSAGES.alreadySubscribed });
      }
    }

    const origin = siteOrigin();
    const params = {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id } },
      success_url: `${origin}/profile.html?pro=done`,
      cancel_url: `${origin}/pro.html?pro=cancel`,
      locale: "ja",
      allow_promotion_codes: "true"
    };
    // 既に Stripe の顧客なら同じ顧客に紐づける（Portal で履歴が 1 つにまとまる）。初めてならメールだけ渡す
    if (row?.stripe_customer_id) params.customer = row.stripe_customer_id;
    else if (user.email) params.customer_email = user.email;
    const trial = trialDays();
    if (trial > 0) params.subscription_data.trial_period_days = trial;

    const session = await stripeFetch("/v1/checkout/sessions", params, {
      idempotencyKey: `checkout:${user.id}:${interval}:${Math.floor(Date.now() / 60000)}`
    });
    if (typeof session?.url !== "string" || !session.url) throw new Error("checkout session has no url");
    return send(res, 200, { url: session.url });
  } catch (error) {
    return sendUpstream(res, "checkout", error);
  }
}
