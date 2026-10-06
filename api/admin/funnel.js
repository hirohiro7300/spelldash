// ===== Pro までの動線の数（創業者専用の CRM、Vercel Serverless Function） =====
//
// GET /api/admin/funnel
//   Authorization: Bearer <Supabase アクセストークン>（ADMIN_EMAILS / ADMIN_USER_IDS の人だけ）
// → { missing: false, today, steps, side, days7: {step: 端末数}, days30, sources7: [{source, devices}], sources30 }
//   funnel_events が無ければ { missing: true }（docs/SQL_FUNNEL.md）。
// 記録は端末のランダムな番号と段階だけ（メール・学習の中身は無い）。プレイヤーには何も送らない。

import { send } from "../_lib/shared.js";
import { handleAdmin, restOptional, jstToday, addDays } from "../_lib/admin.js";
import { summarizeFunnel } from "../_lib/funnel.js";

export default async function handler(req, res) {
  await handleAdmin(req, res, { method: "GET", label: "funnel" }, async () => {
    const today = jstToday();
    const since = addDays(today, -29);
    const { rows, missing } = await restOptional("funnel_events", `select=device_id,step,source,day&day=gte.${since}&order=id`);
    if (missing) return send(res, 200, { missing: true, today });
    return send(res, 200, { missing: false, ...summarizeFunnel(rows, today) });
  });
}
