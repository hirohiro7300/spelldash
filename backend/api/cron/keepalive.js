// ===== Supabase の一時停止を防ぐ日次の呼び出し（Vercel Cron） =====
//
// GET /api/cron/keepalive（vercel.json の crons から 1 日 1 回）
// Supabase の無料プロジェクトは API が 1 週間呼ばれないと一時停止し、ログインと同期が止まる
// （2026-10-02 に実際に起きた）。公開テーブル daily_scores を anon key で 1 行だけ読んで「使われている」状態を保つ。
// Vercel の環境変数 CRON_SECRET があれば、その Bearer が無い呼び出しは 401。無ければ誰が呼んでも 1 行読むだけ（害は無い）。

import { SUPABASE_URL, SUPABASE_ANON_KEY, send } from "../_lib/shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "method_not_allowed" });
  }
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return send(res, 401, { error: "unauthorized" });
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/daily_scores?select=day&limit=1`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    console.log(`cron/keepalive: supabase ${response.status}`);
    return send(res, response.ok ? 200 : 502, { ok: response.ok, status: response.status });
  } catch (error) {
    console.error("cron/keepalive: unreachable", error?.cause?.code || error?.name || "");
    return send(res, 502, { ok: false, status: 0 });
  }
}
