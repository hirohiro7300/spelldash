// ===== Pro の加入（Stripe Checkout セッションを作る。Vercel Serverless Function） =====
//
// POST /api/billing/checkout  { interval: "month" | "year" }
//   Authorization: Bearer <Supabase アクセストークン>（ログイン必須）
// → { url }（Stripe Checkout のページ。クライアントはここへ遷移する）
//   503 not_configured / 401 login_required / 400 bad_request（interval が不正、年額が未設定）
//   409 already_subscribed（本人の行がすでに Pro）/ 502 upstream
//
// 無料期間（STRIPE_TRIAL_MONTHS／STRIPE_TRIAL_DAYS）は初めての人だけ: 本人の行が無く（webhook は解約後も行を canceled で残す）、
// Stripe 側にも user_id の契約が 1 つも無いとき。解約して入り直した人には付けない
//
// 本人の行は本人のトークンで読む（RLS）。success / cancel の URL は SITE_ORIGIN からだけ作る（リクエストヘッダは使わない）。
// Web 専用（アプリでは購入ボタンを出さない）なので CORS は許可しない。

import { send, readBody, verifyUserFull, bearerToken } from "../_lib/shared.js";
import {
  rejectMethod,
  billingConfigured,
  priceIdFor,
  trialEndUnix,
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
    // 行がまだ無い（webhook の前）: Stripe 側を user_id で探す。検索の反映は遅れることがあるので、画面側の「支払い済み」の印と併せて使う
    let firstTime = !row; // 行が無い = まだ一度も契約していない（無料期間を付けてよい）
    if (!row) {
      try {
        const found = await stripeFetch("/v1/subscriptions/search", { query: `metadata['user_id']:'${user.id}'`, limit: 10 }, { method: "GET" });
        const subs = Array.isArray(found?.data) ? found.data : [];
        if (subs.some((s) => LIVE_STATUSES.has(s?.status))) {
          return send(res, 409, { error: "already_subscribed", message: MESSAGES.alreadySubscribed });
        }
        if (subs.length > 0) firstTime = false; // webhook の前に解約した契約がある
      } catch {
        // 検索できなくても加入は止めない（行が無い初めての人）
      }
    }
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
      success_url: `${origin}/pro.html?pro=done`, // 加入画面で反映を待ち、使えるようになったものを並べる（js/proView.js）
      cancel_url: `${origin}/pro.html?pro=cancel`,
      locale: "ja",
      allow_promotion_codes: "true"
    };
    // 既に Stripe の顧客なら同じ顧客に紐づける（Portal で履歴が 1 つにまとまる）。初めてならメールだけ渡す
    if (row?.stripe_customer_id) params.customer = row.stripe_customer_id;
    else if (user.email) params.customer_email = user.email;
    // 無料期間は初めての人だけ。月は暦で終わりの時刻（trial_end）、日数は trial_period_days。
    // 同じ分の再送は同じ冪等キーになるので、trial_end も分の頭から数えて同じ値にする（違う値だと Stripe が idempotency_error を返す）
    const minute = Math.floor(Date.now() / 60000);
    const trialEnd = firstTime ? trialEndUnix(new Date(minute * 60000)) : 0;
    if (trialEnd > 0) params.subscription_data.trial_end = trialEnd;
    else if (firstTime && trialDays() > 0) params.subscription_data.trial_period_days = trialDays();

    const session = await stripeFetch("/v1/checkout/sessions", params, {
      idempotencyKey: `checkout:${user.id}:${interval}:${firstTime ? "trial" : "paid"}:${minute}`
    });
    if (typeof session?.url !== "string" || !session.url) throw new Error("checkout session has no url");
    return send(res, 200, { url: session.url });
  } catch (error) {
    return sendUpstream(res, "checkout", error);
  }
}
