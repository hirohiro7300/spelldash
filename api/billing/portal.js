// ===== お支払いの管理（Stripe Billing Portal セッションを作る。Vercel Serverless Function） =====
//
// POST /api/billing/portal
//   Authorization: Bearer <Supabase アクセストークン>（ログイン必須）
// → { url }（Portal のページ。解約・カード変更・領収書はここで本人が行う）
//   404 no_subscription（本人の行に stripe_customer_id が無い）/ 503 / 401 / 502
//   502 auth_unavailable（Batch 94。本人確認を確かめられない: 4 秒で打ち切り・通信の失敗・本人確認の 5xx。401 は鍵が違うときだけ。_lib/shared.js verifyUserChecked）
//
// 戻り先は SITE_ORIGIN/profile.html（リクエストヘッダは使わない）。Web 専用なので CORS は許可しない。

import { send, verifyUserChecked, bearerToken } from "../_lib/shared.js";
import { rejectMethod, secretKeyConfigured, siteOrigin, stripeFetch, fetchOwnSubscription, sendUpstream, overBillingRate, MESSAGES } from "../_lib/billing.js";

export default async function handler(req, res) {
  if (rejectMethod(req, res, "POST")) return;
  // 秘密鍵だけを見る（受付を止めて月額の Price の変数を外しても、加入している人は解約・カードの変更ができる）
  if (!secretKeyConfigured()) return send(res, 503, { error: "not_configured", message: MESSAGES.notConfigured });

  const verified = await verifyUserChecked(req.headers.authorization);
  if (verified.problem === "unavailable") return send(res, 502, { error: "auth_unavailable", message: MESSAGES.authUnavailable });
  const user = verified.user;
  if (!user) return send(res, 401, { error: "login_required", message: MESSAGES.login });
  // 同じ人は 1 分 10 回まで（Batch 88。_lib/billing.js overBillingRate）
  if (overBillingRate("portal", user.id)) return send(res, 429, { error: "too_many", message: MESSAGES.tooMany });

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
