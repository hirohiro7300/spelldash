// ===== Pro までの動線の数（創業者専用の CRM、Vercel Serverless Function） =====
//
// GET /api/admin/funnel
//   Authorization: Bearer <Supabase アクセストークン>（ADMIN_EMAILS / ADMIN_USER_IDS の人だけ）
// → { missing: false, today, steps, side, ratios, days7: {step: 端末数}, days30, sources7: [{source, devices}], sources30 }
//   funnel_events が無ければ { missing: true }（docs/SQL_FUNNEL.md）。
// 集計は RPC admin_funnel_counts（SQL の 2）があればそれ（数十行で済む）、無ければ 30 日分の行を読んで数える。
// 記録は端末のランダムな番号と段階だけ（メール・学習の中身は無い）。プレイヤーには何も送らない。

import { send } from "../_lib/shared.js";
import { handleAdmin, restOptional, rpcAllOrNull, jstToday, addDays } from "../_lib/admin.js";
import { summarizeFunnel, summarizeFunnelCounts } from "../_lib/funnel.js";

// 関数が無いと分かったら、このインスタンスでは 10 分間 RPC を呼ばない（無い環境で毎回 1 往復ふやさない）
const RPC_RETRY_MS = 10 * 60 * 1000;
let rpcMissingUntil = 0;

export default async function handler(req, res) {
  await handleAdmin(req, res, { method: "GET", label: "funnel" }, async () => {
    const today = jstToday();
    if (Date.now() >= rpcMissingUntil) {
      const counted = await rpcAllOrNull("admin_funnel_counts", { p_today: today });
      if (counted) return send(res, 200, { missing: false, ...summarizeFunnelCounts(counted, today) });
      rpcMissingUntil = Date.now() + RPC_RETRY_MS;
    }
    const since = addDays(today, -29);
    const { rows, missing } = await restOptional("funnel_events", `select=device_id,step,source,day&day=gte.${since}&order=id`);
    if (missing) return send(res, 200, { missing: true, today });
    return send(res, 200, { missing: false, ...summarizeFunnel(rows, today) });
  });
}
