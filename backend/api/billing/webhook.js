// ===== Stripe Webhook（加入状態を subscriptions に写す。Vercel Serverless Function） =====
//
// POST /api/billing/webhook（Stripe が呼ぶ。Stripe-Signature ヘッダで検証）
// → { received: true }（200）
//   署名が無い・合わない・300 秒より古い → 400 bad_signature
//   未設定（STRIPE_WEBHOOK_SECRET / STRIPE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY のどれかが無い）→ 503
//   Supabase への書き込み失敗 → 500（Stripe が再送する）
//
// 扱うイベント:
//   checkout.session.completed（mode=subscription のみ。user_id = client_reference_id ?? metadata.user_id、
//     subscription を GET /v1/subscriptions/{id} で取り直して upsert）
//   customer.subscription.created / updated / deleted（user_id = metadata.user_id。無ければ stripe_customer_id で既存行を探す。
//     見つからなければ 200 で無視。deleted は status = canceled）
//   他は 200 で無視。
// 逆順到着の対策: 既存行の event_created より古いイベントは捨てる。書き込みは event_created を条件にした PATCH なので、
// 同時に届いても古い状態で上書きしない（同じ秒のイベントは後から来たものを採用）。
// ログは `billing/webhook: <type> <結果>` だけ（メール・顧客 id・本文は書かない）。
// 生ボディで署名を検証するため bodyParser を切る。

import { send } from "../_lib/shared.js";
import { MissingTableError } from "../_lib/admin.js";
import {
  rejectMethod,
  webhookConfigured,
  readRawBody,
  verifyStripeSignature,
  stripeFetch,
  isUuid,
  readSubscription,
  findSubscriptionByCustomer,
  upsertSubscription,
  updateSubscriptionIfNotNewer,
  webhookSecret,
  logBilling,
  MESSAGES
} from "../_lib/billing.js";

export const config = { api: { bodyParser: false } };

function idOf(value) {
  if (typeof value === "string") return value || null;
  return typeof value?.id === "string" && value.id ? value.id : null;
}

function toIso(seconds) {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

// Stripe の subscription → 保存する行。current_period_end は新しい API では item 側にある
function rowFrom(userId, sub, eventCreated, status) {
  const item = Array.isArray(sub?.items?.data) ? sub.items.data[0] : null;
  const periodEnd = typeof sub?.current_period_end === "number" ? sub.current_period_end : item?.current_period_end;
  return {
    user_id: userId,
    stripe_customer_id: idOf(sub?.customer),
    stripe_subscription_id: idOf(sub),
    status: typeof status === "string" && status ? status : "none",
    price_id: idOf(item?.price),
    plan_interval: typeof item?.price?.recurring?.interval === "string" ? item.price.recurring.interval : null,
    current_period_end: toIso(periodEnd),
    cancel_at_period_end: sub?.cancel_at_period_end === true,
    event_created: eventCreated,
    updated_at: new Date(Date.now()).toISOString()
  };
}

// 既存行より古いイベントは捨て、そうでなければ書く。戻り値はログ用の短い結果
async function apply(userId, sub, eventCreated, status) {
  const existing = await readSubscription(userId);
  if (existing && Number(existing.event_created) > eventCreated) return "stale ignored";
  const row = rowFrom(userId, sub, eventCreated, status);
  if (existing) {
    const updated = await updateSubscriptionIfNotNewer(row);
    return updated ? `upserted ${status}` : "stale ignored";
  }
  await upsertSubscription(row);
  return `upserted ${status}`;
}

async function handleEvent(event) {
  const type = String(event?.type || "");
  const object = event?.data?.object;
  const created = typeof event?.created === "number" ? event.created : 0;

  if (type === "checkout.session.completed") {
    if (object?.mode !== "subscription") return "ignored mode";
    const userId = object.client_reference_id ?? object.metadata?.user_id;
    if (!isUuid(userId)) return "no user";
    const subscriptionId = idOf(object.subscription);
    if (!subscriptionId) return "no subscription";
    const sub = await stripeFetch(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, null, { method: "GET" });
    return apply(userId, sub, created, String(sub?.status || "none"));
  }

  if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    let userId = object?.metadata?.user_id;
    if (!isUuid(userId)) {
      const existing = await findSubscriptionByCustomer(idOf(object?.customer));
      if (!existing) return "no user for customer";
      userId = existing.user_id;
    }
    const status = type === "customer.subscription.deleted" ? "canceled" : String(object?.status || "none");
    return apply(userId, object, created, status);
  }

  return "ignored";
}

export default async function handler(req, res) {
  if (rejectMethod(req, res, "POST")) return;
  if (!webhookConfigured()) return send(res, 503, { error: "not_configured", message: MESSAGES.notConfigured });

  let event;
  try {
    const raw = await readRawBody(req);
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"], webhookSecret())) {
      console.warn("billing/webhook: bad_signature");
      return send(res, 400, { error: "bad_signature", message: MESSAGES.badSignature });
    }
    event = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: "bad_request", message: MESSAGES.badRequest });
  }

  const type = String(event?.type || "unknown");
  try {
    const result = await handleEvent(event);
    console.log(`billing/webhook: ${type} ${result}`);
    return send(res, 200, { received: true });
  } catch (error) {
    if (error instanceof MissingTableError) console.error(`billing/webhook: ${type} subscriptions table missing (docs/SQL_BILLING.md)`);
    else logBilling(`webhook ${type}`, error);
    return send(res, 500, { error: "upstream", message: MESSAGES.webhookFailed });
  }
}
