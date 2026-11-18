// ===== 認証の部品（固定の版）を自分の配信から出す（Batch 97。ログイン不要。docs/SECURITY.md の Batch 97 の節） =====
//
// GET /api/auth-module?v=2.118.0&h=c1a6b90c（問いは版 v と答えの印 h の 1 つずつだけ。ほかの版・印・問い・問い無しは 404。
// GET のほかは 405: HEAD も〔中身の無い答えに 1 年の保存の頭を付けない。api/cron/keepalive.js と同じ形〕）
// → 200（スクリプトの型）: 配布物の LICENSE の注記 + 固定の版の束（api/_lib/authModule.js が登録所の tarball から作り、sha512 と
//   sha256 を固定の値で確かめた物）。答えのバイトが変わると URL（h）も変わるので、端末と配信の縁で 1 年保存してよい（immutable）。
//   作れない（登録所に届かない・5 秒で答えない・値が違う）ときは 503（保存させない）。ページは部品なしで動く（js/supabase.js の
//   オフラインの代わり: ログイン・同期・ご意見の送信・動線の計測が使えず、学習は端末の記録で動く）。
// インスタンスのメモリーに 1 回作った物を持つ（同時の呼び出しは同じ 1 回を待つ）。作れなかった後 10 秒は作り直さない（登録所が止まって
// いる間、呼び出しのたびに 5 秒待たせない・登録所へ続けて取りに行かない）。ログには理由の短い字だけ（URL・中身は書かない）
import { send } from "./_lib/shared.js";
import { AUTH_MODULE_VERSION, AUTH_MODULE_TAG, buildAuthModule } from "./_lib/authModule.js";

export const CACHE_LONG = "public, max-age=31536000, s-maxage=31536000, immutable";
const HOLD_MS = 10000;

// 求められた版と答えの印（問いがちょうど v と h の 1 つずつのときの値。ほかは null）
export function askedModule(url) {
  let params;
  try {
    params = new URL(String(url ?? ""), "http://localhost").searchParams;
  } catch {
    return null;
  }
  const keys = [...params.keys()].sort();
  return keys.length === 2 && keys[0] === "h" && keys[1] === "v" ? { v: params.get("v"), h: params.get("h") } : null;
}

// build と now は単体の検査が偽物を渡す
export function createAuthModuleHandler({ build = buildAuthModule, now = Date.now } = {}) {
  let ready = null;
  let pending = null;
  let failedAt = -Infinity;
  const load = () => {
    if (ready) return Promise.resolve(ready);
    if (pending) return pending;
    if (now() - failedAt < HOLD_MS) return Promise.reject(Object.assign(new Error("hold"), { code: "hold" }));
    pending = Promise.resolve()
      .then(() => build())
      .then((built) => {
        if (!built || !Buffer.isBuffer(built.served) || built.served.length === 0) throw Object.assign(new Error("empty"), { code: "empty" });
        ready = built;
        return built;
      })
      .catch((error) => {
        failedAt = now();
        throw error;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return async function handler(req, res) {
    // GET だけ（HEAD も 405。api/cron/keepalive.js と同じ形）
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return send(res, 405, { error: "method_not_allowed" });
    }
    const asked = askedModule(req.url);
    if (!asked || asked.v !== AUTH_MODULE_VERSION || asked.h !== AUTH_MODULE_TAG) return send(res, 404, { error: "not_found" });
    let built;
    try {
      built = await load();
    } catch (error) {
      console.error(`auth-module: unavailable ${String(error?.code ?? "error").slice(0, 32)}`);
      res.setHeader("Retry-After", "10");
      return send(res, 503, { error: "unavailable" });
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", CACHE_LONG);
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.end(built.served);
  };
}

export default createAuthModuleHandler();
