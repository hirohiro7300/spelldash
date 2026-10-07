// ===== Pro の価格（Vercel Serverless Function、ログイン不要） =====
//
// GET /api/billing/config
// → { configured: boolean, prices: [{ interval: "month"|"year", amount, currency }], trialMonths, trialDays }（無料期間は初めての人だけ）
//   未設定（STRIPE_SECRET_KEY か STRIPE_PRICE_MONTHLY が無い）なら { configured: false, prices: [], trialDays: 0 }（200）。
//   金額はコードに書かず Stripe の Price（GET /v1/prices/{id}）から取る。unit_amount をそのまま（JPY はゼロ小数）。
//   Stripe の応答は 10 分メモリキャッシュ。月額の Price が取れなければ 502、年額が取れなければ年額だけ出さない。

import { send } from "../_lib/shared.js";
import { rejectMethod, billingConfigured, priceIdFor, trialDays, trialMonths, stripeFetch, logBilling, sendUpstream } from "../_lib/billing.js";

const CACHE_MS = 10 * 60 * 1000;
const priceCache = new Map();

async function loadPrice(priceId) {
  const cached = priceCache.get(priceId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.price;
  const price = await stripeFetch(`/v1/prices/${encodeURIComponent(priceId)}`, null, { method: "GET" });
  if (!price || typeof price.unit_amount !== "number") throw new Error("price has no unit_amount");
  priceCache.set(priceId, { at: Date.now(), price });
  return price;
}

function priceInfo(interval, price) {
  return {
    interval: price.recurring?.interval === "year" ? "year" : price.recurring?.interval === "month" ? "month" : interval,
    amount: price.unit_amount,
    currency: String(price.currency || "jpy").toLowerCase()
  };
}

export default async function handler(req, res) {
  if (rejectMethod(req, res, "GET")) return;
  if (!billingConfigured()) return send(res, 200, { configured: false, prices: [], trialDays: 0, trialMonths: 0 });

  const prices = [];
  try {
    prices.push(priceInfo("month", await loadPrice(priceIdFor("month"))));
  } catch (error) {
    return sendUpstream(res, "config", error);
  }
  const yearlyId = priceIdFor("year");
  if (yearlyId) {
    try {
      prices.push(priceInfo("year", await loadPrice(yearlyId)));
    } catch (error) {
      logBilling("config", error);
    }
  }
  // 無料期間は初めての人だけ（checkout が判定する）。月で指定されていれば trialDays は 0 にして画面の文を 1 つにする
  const months = trialMonths();
  return send(res, 200, { configured: true, prices, trialMonths: months, trialDays: months > 0 ? 0 : trialDays() });
}
