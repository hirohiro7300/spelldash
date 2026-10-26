// ===== お支払いの管理（Stripe Billing Portal セッションを作る。Vercel Serverless Function） =====
//
// POST /api/billing/portal
//   Authorization: Bearer <Supabase アクセストークン>（ログイン必須）
// → { url }（Portal のページ。解約・カード変更・領収書はここで本人が行う）
//   404 no_subscription（本人の行に stripe_customer_id が無い）/ 503 / 401 / 502
//
// 戻り先は SITE_ORIGIN/profile.html（リクエストヘッダは使わない）。Web 専用なので CORS は許可しない。

import { send, verifyUserFull, bearerToken } from "../_lib/shared.js";
import { rejectMethod, billingConfigured, siteOrigin, stripeFetch, fetchOwnSubscription, sendUpstream, MESSAGES } from "../_lib/billing.js";

export default async function handler(req, res) {
  if (rejectMethod(req, res, "POST")) return;
  if (!billingConfigured()) return send(res, 503, { error: "not_configured", message: MESSAGES.notConfigured });

  const user = await verifyUserFull(req.headers.authorization);
  if (!user) return send(res, 401, { error: "login_required", message: MESSAGES.login });

  try {
    const row = await fetchOwnSubscription(bearerToken(req.headers.authorization), user.id);
    const customerId = typeof row?.stripe_customer_id === "string" ? row.stripe_customer_id : "";
    if (!customerId) return send(res, 404, { error: "no_subscription", message: MESSAGES.noSubscription });

    const session = await stripeFetch("/v1/billing_portal/sessions", {
      customer: customerId,
      return_url: `${siteOrigin()}/profile.html`
    });
    if (typeof session?.url !== "string" || !session.url) throw new Error("portal session has no url");
    return send(res, 200, { url: session.url });
  } catch (error) {
    return sendUpstream(res, "portal", error);
  }
}
