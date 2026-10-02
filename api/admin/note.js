// ===== プレイヤーのメモ・タグ・ピン留め（創業者専用の CRM、Vercel Serverless Function） =====
//
// POST /api/admin/note  { userId: "<uuid>", note?: string(≤2000), tags?: string[](各≤30, 最大20), pinned?: boolean }
//   Authorization: Bearer <Supabase アクセストークン>（ADMIN_EMAILS / ADMIN_USER_IDS の人だけ）
// → { ok: true, note, tags, pinned }
//
// crm_notes に upsert する（渡された項目だけ更新、updated_at = 今）。テーブルが無ければ 503 not_configured。
// プレイヤーへの通知は一切しない（CRM は「見る」と「メモする」だけ）。

import { send, readBody } from "../_lib/shared.js";
import {
  handleAdmin,
  serviceFetch,
  isMissingTable,
  errorCode,
  UpstreamError,
  isUuid,
  noteText,
  tagList,
  MESSAGES
} from "../_lib/admin.js";

const NOTE_MAX = 2000;
const TAG_MAX = 30;
const TAGS_MAX = 20;

function bad(res, message) {
  return send(res, 400, { error: "bad_request", message });
}

export default async function handler(req, res) {
  await handleAdmin(req, res, { method: "POST", label: "note" }, async () => {
    const body = readBody(req);
    const userId = String(body.userId || "").trim();
    if (!isUuid(userId)) return bad(res, MESSAGES.badUserId);

    const patch = {};
    if (body.note !== undefined) {
      if (typeof body.note !== "string") return bad(res, "note は文字列で送ってください。");
      if (body.note.length > NOTE_MAX) return bad(res, `メモは ${NOTE_MAX} 文字までです。`);
      patch.note = body.note;
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string")) {
        return bad(res, "tags は文字列の配列で送ってください。");
      }
      const tags = [...new Set(tagList(body.tags))];
      if (tags.length > TAGS_MAX) return bad(res, `タグは ${TAGS_MAX} 個までです。`);
      if (tags.some((tag) => tag.length > TAG_MAX)) return bad(res, `タグは 1 つ ${TAG_MAX} 文字までです。`);
      patch.tags = tags;
    }
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== "boolean") return bad(res, "pinned は true / false で送ってください。");
      patch.pinned = body.pinned;
    }
    if (Object.keys(patch).length === 0) return bad(res, "更新する項目がありません（note / tags / pinned のいずれか）。");

    const response = await serviceFetch("/rest/v1/crm_notes?on_conflict=user_id", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ user_id: userId, ...patch, updated_at: new Date(Date.now()).toISOString() })
    });

    if (!response.ok) {
      if (await isMissingTable(response)) return send(res, 503, { error: "not_configured", message: MESSAGES.notesMissing });
      const code = await errorCode(response);
      if (code === "23503") return send(res, 404, { error: "not_found", message: MESSAGES.notFound });
      if (code === "23514" || code === "22001") return bad(res, "メモかタグが長すぎます。");
      throw new UpstreamError("crm_notes", response.status, code);
    }

    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    return send(res, 200, {
      ok: true,
      note: noteText(row?.note),
      tags: tagList(row?.tags),
      pinned: row?.pinned === true
    });
  });
}
