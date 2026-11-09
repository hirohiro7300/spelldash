// ===== Stripe Webhook（加入状態を subscriptions に写す。Vercel Serverless Function） =====
//
// POST /api/billing/webhook（Stripe が呼ぶ。Stripe-Signature ヘッダで検証）
// → { received: true }（200）
//   署名が無い・合わない・300 秒より古い → 400 bad_signature
//   未設定（STRIPE_WEBHOOK_SECRET / STRIPE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY のどれかが無い）→ 503。月額の Price の変数は見ない
//   （受付を止めるためにそれを外しても、加入している人の解約予定・更新・支払いの失敗は写し続ける。docs/BILLING.md §2）
//   Supabase への書き込み失敗 → 500（Stripe が再送する）
//
// 扱うイベント:
//   checkout.session.completed（mode=subscription のみ。user_id = client_reference_id ?? metadata.user_id、
//     subscription を GET /v1/subscriptions/{id} で取り直して書く）
//   customer.subscription.created / updated / deleted（user_id = metadata.user_id。無ければ stripe_customer_id で既存行を探す。
//     見つからなければ 200 で無視。deleted は status = canceled）
//   他は 200 で無視。
// 別の契約（Batch 88）: 行は 1 人 1 行（user_id）なので、1 人に契約が 2 つあると、片方の終わりがもう片方の生きている行を上書きしうる。
//   - 行の契約と違う契約のイベントで、行が Pro（isProRow）で、届いた状態が生きていない（active・trialing・past_due の外）なら書かない（other subscription ignored）
//   - 行が Pro のまま別の契約が生きている状態で届いたら、前のとおり新しい方を書き、ログに billing/webhook: duplicate live subscription（番号は書かない。
//     docs/BILLING.md §8: 片方を返金してすぐキャンセルする）
//   - 行の契約が生きていない状態になったら、同じ顧客にほかの生きている契約が無いかを一覧で見て、あればそちらを書く（Pro のまま。どちらを先に止めても行は壊れない）
// 逆順到着の対策: 既存行の event_created より古いイベントは捨てる。行がある時の書き込みは event_created を条件にした PATCH、
// 行が無い時の最初の書き込みは「入れるだけ」（同じ人の行がもうあれば何もしない）で、入らなければ同じ条件つきの PATCH へ進む。
// だから 2 つのイベントが同時に届いても古い状態で上書きしない（同じ秒のイベントは後から来たものを採用）。scripts/test-billing.mjs が両方の順で確かめる。
// ログは `billing/webhook: <type> <結果>` だけ（メール・顧客 id・本文は書かない）。
// 署名は届いたバイト列で確かめる（readRawBody: rawBody → 配信の補助が付け替えた req.on の写し → まだ読まれていない流れ → 文字列か Buffer の body の順。
// 解析済みの値から JSON を作り直さない）。今の配信のサーバーの関数は、関数を呼ぶ前に本文を読み切って req.on を写しに付け替える補助が既定で入り、
// 下の config（bodyParser: false）は読まない（効かない。Batch 83 の反証）。その指定を読む作りのために残すだけで、補助は切らない（res.status / res.json を使う）

import { send } from "../_lib/shared.js";
import { MissingTableError } from "../_lib/admin.js";
import {
  rejectMethod,
  webhookConfigured,
  readRawBody,
  verifyStripeSignature,
  stripeFetch,
  isUuid,
  isProRow,
  subscriptionsOfCustomer,
  LIVE_SUBSCRIPTION_STATUSES,
  readSubscription,
  findSubscriptionByCustomer,
  insertSubscriptionIfAbsent,
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

// 同じ顧客のほかの生きている契約（exceptId でない物）。期限のいちばん先の物。無ければ null。読めなければ投げる（500 で再送させる: 決めずに書かない）
async function otherLiveSubscription(customerId, exceptId) {
  if (!customerId) return null;
  const live = (await subscriptionsOfCustomer(customerId)).filter((s) => idOf(s) && idOf(s) !== exceptId && LIVE_SUBSCRIPTION_STATUSES.has(String(s?.status)));
  const endOf = (s) => (typeof s?.current_period_end === "number" ? s.current_period_end : Number(s?.items?.data?.[0]?.current_period_end) || 0);
  return live.sort((a, b) => endOf(b) - endOf(a))[0] ?? null;
}

// 既存行より古いイベントは捨て、そうでなければ書く。戻り値はログ用の短い結果
// 行が無ければ「入れるだけ」。入らなかった（同時に届いた別のイベントが先に入れた）ら、行がある時と同じ条件つきの書き換えへ
async function apply(userId, sub, eventCreated, status) {
  const existing = await readSubscription(userId);
  if (existing && Number(existing.event_created) > eventCreated) return "stale ignored";
  const subId = idOf(sub);
  const live = LIVE_SUBSCRIPTION_STATUSES.has(status);
  const otherSub = Boolean(existing?.stripe_subscription_id && subId && existing.stripe_subscription_id !== subId);
  const existingPro = isProRow(existing);
  // 別の契約の終わり（解約・期限切れなど）で、生きている行を上書きしない
  if (otherSub && existingPro && !live) return "other subscription ignored";
  // 生きている契約が 2 つ: 前のとおり新しい方を書く（どちらも本人の契約。片方を返金してすぐキャンセルする: docs/BILLING.md §8）
  if (otherSub && existingPro && live) console.warn("billing/webhook: duplicate live subscription");
  let target = sub;
  let targetStatus = status;
  let kept = "";
  // 行の契約が生きていない状態になった: 同じ顧客にほかの生きている契約があれば、そちらを書く（Pro のまま）
  if (!live && existing && !otherSub && existingPro) {
    const alive = await otherLiveSubscription(idOf(sub?.customer) || existing.stripe_customer_id, subId);
    if (alive) {
      target = alive;
      targetStatus = String(alive.status);
      kept = " (other live subscription kept)";
    }
  }
  const row = rowFrom(userId, target, eventCreated, targetStatus);
  if (!existing && (await insertSubscriptionIfAbsent(row))) return `inserted ${targetStatus}${kept}`;
  const updated = await updateSubscriptionIfNotNewer(row);
  return updated ? `updated ${targetStatus}${kept}` : "stale ignored";
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
    if (raw === null || !verifyStripeSignature(raw, req.headers["stripe-signature"], webhookSecret())) {
      // 生ボディが読めない（配信の側が本文を解析済みの値にしかしていない）ときは印を分ける（鍵の取り違えと見分ける。docs/BILLING.md の 8）
      console.warn(`billing/webhook: bad_signature${raw === null ? " (no raw body)" : ""}`);
      return send(res, 400, { error: "bad_signature", message: MESSAGES.badSignature });
    }
    event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
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
