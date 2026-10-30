// にせの受け口（認証と表）。ブラウザの文脈の全部の要求を context.route で受ける（本物のプロジェクトには 1 件も出さない）。
// 本物の認証の部品（lib/authLib.mjs が検査の時に作る）が使う口を、本物と同じ形で返す:
//   認証: GET /auth/v1/health・POST /auth/v1/otp（メールのリンクを「受信箱」に積む）・GET /auth/v1/verify（リンク → redirect_to#access_token=…）・
//         POST /auth/v1/token?grant_type=refresh_token（回転・使い回しの検出・取り消し）・GET /auth/v1/user・POST /auth/v1/logout?scope=global|local|others
//   表:   /rest/v1/<表>（select・insert・upsert・update・delete。行ごとの権限 RLS: 自分の user_id の行だけ）
// アクセストークンは JWT の形（sub = user id・exp は短い。既定 100 秒: 部品は残り 90 秒を切ると更新するので、タブは何度も更新する）。
// 表の要求は署名と exp だけを見る（本番の表の受け口と同じ: ログアウトの後も期限までは通る＝いちばん漏れやすい側）。/auth/v1/user は取り消したセッションを断る。
// 全部の要求を記録する: 順番・時刻・段（シナリオが付ける）・どのタブか・方法・道・Authorization の人（A／B／匿名）・中身・行の user_id。
// 通信の切れたタブの要求も、届かなかった物として同じ形で残す（そのタブが誰として送ろうとしたか）。
// holdToken(tab): そのタブのトークンの更新（POST /auth/v1/token）を releaseToken まで止める（更新の途中で配信を替え、新しいタブが移行する形を作る）。
import crypto from "crypto";

export const SUPABASE_URL = "https://sujvgwozsnzjsjmkcrnk.supabase.co";
// 旧いコード（直前の本番）の認証の部品がセッションを置く鍵（本物の部品の既定: sb-<ref>-auth-token）
export const OLD_AUTH_KEY = "sb-sujvgwozsnzjsjmkcrnk-auth-token";
export const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1anZnd296c256anNqbWtjcm5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MDA5NDIsImV4cCI6MjA5ODE3Njk0Mn0.NkgB0vIgI4Q3DL5fSuF4kbtF3P4ORMbHzoPGbnOG3mc";
const SECRET = "oldtab-harness-only-secret"; // 検査だけの鍵（本物の鍵ではない）

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function signJwt(payload) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

function readJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(fromB64u(parts[1]).toString("utf8"));
    const good = b64u(crypto.createHmac("sha256", SECRET).update(`${parts[0]}.${parts[1]}`).digest()) === parts[2];
    return { payload, good };
  } catch {
    return null;
  }
}

// 主キー（upsert の重なりの判定）。on_conflict があればそれを使う
const PK = {
  word_progress: ["user_id", "word_id"],
  user_progress: ["user_id"],
  user_items: ["user_id", "kind", "key"],
  profiles: ["user_id"],
  activity_days: ["user_id", "day"],
  funnel_events: ["device_id", "step", "source", "day"],
  subscriptions: ["user_id"]
};
const TABLES = new Set([...Object.keys(PK), "battle_sessions", "play_sessions", "daily_scores", "feedback"]);
const PUBLIC_READ = new Set(["daily_scores"]); // 日ごとの順位は全員の行を読む
const ANON_WRITE = new Set(["funnel_events", "feedback"]); // 未ログインでも書ける（user_id が空か本人）

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function parseFilterValue(raw) {
  const m = String(raw).match(/^(not\.)?(eq|neq|gt|gte|lt|lte|in|is|like|ilike)\.(.*)$/s);
  if (!m) return null;
  let [, not, op, val] = m;
  if (op === "in") {
    const inner = val.replace(/^\(/, "").replace(/\)$/, "");
    const items = [];
    for (const mm of inner.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)) items.push(mm[1] !== undefined ? mm[1].replace(/\\(.)/g, "$1") : mm[2]);
    val = items;
  }
  return { not: !!not, op, val };
}

const asText = (v) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v));

function matchFilter(row, col, f) {
  const v = row[col];
  const s = asText(v);
  let ok;
  switch (f.op) {
    case "eq": ok = s === f.val; break;
    case "neq": ok = s !== f.val; break;
    case "gt": ok = s !== null && (typeof v === "number" ? v > Number(f.val) : s > f.val); break;
    case "gte": ok = s !== null && (typeof v === "number" ? v >= Number(f.val) : s >= f.val); break;
    case "lt": ok = s !== null && (typeof v === "number" ? v < Number(f.val) : s < f.val); break;
    case "lte": ok = s !== null && (typeof v === "number" ? v <= Number(f.val) : s <= f.val); break;
    case "in": ok = f.val.includes(s); break;
    case "is": ok = f.val === "null" ? v === null || v === undefined : asText(v) === f.val; break;
    default: ok = true;
  }
  return f.not ? !ok : ok;
}

export function createFakeSupabase({ users, tokenTtl = 100, seed = {}, log = () => {} }) {
  const t0 = Date.now();
  const byId = new Map(users.map((u) => [u.id, u]));
  const byEmail = new Map(users.map((u) => [u.email, u]));
  const tables = new Map();
  for (const t of TABLES) tables.set(t, []);
  for (const [t, rows] of Object.entries(seed)) tables.set(t, rows.map((r) => structuredClone(r)));
  const sessions = new Map(); // sid → { userId, revoked, createdAt }
  const refreshTokens = new Map(); // token → { sid, usedAt, child }
  const otps = new Map(); // token → { email, redirectTo, used }
  const mailbox = []; // { email, link, at }
  const requests = [];
  let seq = 0;
  let phase = "0";
  const labels = new WeakMap(); // page → タブの名前

  const who = (userId) => byId.get(userId)?.label ?? (userId ? "?" : null);

  function issueSession(user, sid = crypto.randomUUID()) {
    const now = Math.floor(Date.now() / 1000);
    if (!sessions.has(sid)) sessions.set(sid, { userId: user.id, revoked: false, createdAt: now });
    const access_token = signJwt({
      aud: "authenticated", exp: now + tokenTtl, iat: now, iss: `${SUPABASE_URL}/auth/v1`, sub: user.id, email: user.email, phone: "",
      app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { email: user.email, email_verified: true, sub: user.id },
      role: "authenticated", aal: "aal1", amr: [{ method: "otp", timestamp: now }], session_id: sid, is_anonymous: false
    });
    const refresh_token = crypto.randomBytes(9).toString("base64url");
    refreshTokens.set(refresh_token, { sid, usedAt: null, child: null });
    return { access_token, token_type: "bearer", expires_in: tokenTtl, expires_at: now + tokenTtl, refresh_token, user: userJson(user) };
  }

  function userJson(user) {
    const at = new Date(t0).toISOString();
    return {
      id: user.id, aud: "authenticated", role: "authenticated", email: user.email, email_confirmed_at: at, phone: "", confirmed_at: at, last_sign_in_at: at,
      app_metadata: { provider: "email", providers: ["email"] }, user_metadata: { email: user.email, email_verified: true, sub: user.id },
      identities: [], created_at: at, updated_at: at, is_anonymous: false
    };
  }

  // Authorization の人。kind: user（署名が合い期限内）・expired・bad・anon（匿名の鍵）・none
  function identity(headers) {
    const raw = String(headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!raw) return { kind: "none", who: null };
    if (raw === ANON_KEY) return { kind: "anon", who: null };
    const jwt = readJwt(raw);
    if (!jwt || !jwt.good) return { kind: "bad", who: null };
    const p = jwt.payload;
    const base = { sub: p.sub, who: who(p.sub), sid: p.session_id, exp: p.exp };
    if (p.exp * 1000 <= Date.now()) return { kind: "expired", ...base };
    return { kind: "user", ...base, sessionRevoked: !!sessions.get(p.session_id)?.revoked };
  }

  function tabOf(request) {
    try {
      const page = request.frame().page();
      return labels.get(page) ?? "page?";
    } catch {
      return "worker"; // Service Worker などページの外からの要求
    }
  }

  const json = (status, body, extra = {}) => ({ status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "content-range, x-supabase-api-version", ...extra }, body: body === undefined ? "" : JSON.stringify(body) });
  const authErr = (status, code, msg) => json(status, { code: status, error_code: code, msg });

  function handleAuth(method, url, headers, body, rec) {
    const p = url.pathname.replace(/^\/auth\/v1/, "");
    rec.kind = `auth:${p.slice(1)}${url.searchParams.get("grant_type") ? ":" + url.searchParams.get("grant_type") : ""}`;
    if (p === "/health" || p === "/settings") return json(200, p === "/health" ? { version: "fake", name: "GoTrue" } : { external: { email: true }, disable_signup: false });
    if (p === "/otp" && method === "POST") {
      const email = String(body?.email ?? "").toLowerCase();
      rec.email = email;
      const user = byEmail.get(email);
      if (!user) return authErr(400, "otp_disabled", "Signups not allowed for otp");
      const token = crypto.randomBytes(12).toString("hex");
      const redirectTo = url.searchParams.get("redirect_to") || "";
      otps.set(token, { email, redirectTo, used: false });
      const link = `${SUPABASE_URL}/auth/v1/verify?token=${token}&type=magiclink&redirect_to=${encodeURIComponent(redirectTo)}`;
      mailbox.push({ email, link, at: Date.now() });
      return json(200, {});
    }
    if (p === "/verify" && method === "GET") {
      const token = url.searchParams.get("token");
      const redirectTo = url.searchParams.get("redirect_to") || "";
      const otp = otps.get(token);
      if (!otp || otp.used) return { status: 303, headers: { location: `${redirectTo}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` }, body: "" };
      otp.used = true;
      const user = byEmail.get(otp.email);
      const s = issueSession(user);
      rec.who = user.label;
      const hash = new URLSearchParams({ access_token: s.access_token, expires_at: String(s.expires_at), expires_in: String(s.expires_in), refresh_token: s.refresh_token, token_type: "bearer", type: "magiclink" });
      return { status: 303, headers: { location: `${redirectTo || "/"}#${hash}` }, body: "" };
    }
    if (p === "/token" && method === "POST" && url.searchParams.get("grant_type") === "refresh_token") {
      const rt = refreshTokens.get(body?.refresh_token);
      rec.refreshToken = String(body?.refresh_token ?? "").slice(0, 6);
      if (!rt) return authErr(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      const sess = sessions.get(rt.sid);
      rec.who = who(sess?.userId);
      if (!sess || sess.revoked) return authErr(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      if (rt.usedAt !== null) {
        // 使い回し: 10 秒以内は同じセッションの新しい組を返す（本物の猶予）。それより後はセッションごと取り消す
        if (Date.now() - rt.usedAt > 10000) {
          sess.revoked = true;
          rec.reuseRevoked = true;
          return authErr(400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
        }
      } else rt.usedAt = Date.now();
      const s = issueSession(byId.get(sess.userId), rt.sid);
      return json(200, s);
    }
    if (p === "/user" && method === "GET") {
      const id = identity(headers);
      rec.who = id.who;
      if (id.kind === "expired") return authErr(403, "bad_jwt", "invalid JWT: unable to parse or verify signature, token has invalid claims: token is expired");
      if (id.kind !== "user") return authErr(401, "no_authorization", "This endpoint requires a valid Bearer token");
      if (id.sessionRevoked) return authErr(403, "session_not_found", "Session from session_id claim in JWT does not exist");
      return json(200, userJson(byId.get(id.sub)));
    }
    if (p === "/logout" && method === "POST") {
      const id = identity(headers);
      const scope = url.searchParams.get("scope") || "global";
      rec.who = id.who;
      rec.scope = scope;
      if (id.kind === "expired") return authErr(403, "bad_jwt", "token is expired");
      if (id.kind !== "user") return authErr(401, "no_authorization", "This endpoint requires a valid Bearer token");
      for (const [sid, s] of sessions) {
        if (s.userId !== id.sub) continue;
        if (scope === "global" || (scope === "local" && sid === id.sid) || (scope === "others" && sid !== id.sid)) s.revoked = true;
      }
      return { status: 204, headers: { "access-control-allow-origin": "*" }, body: "" };
    }
    return authErr(404, "not_found", `fake: ${method} ${p} は持たない`);
  }

  function handleRest(method, url, headers, body, rec) {
    const table = url.pathname.replace(/^\/rest\/v1\//, "").split("/")[0];
    rec.table = table;
    const id = identity(headers);
    const prefer = String(headers.prefer || "");
    if (id.kind === "expired") return json(401, { code: "PGRST303", details: null, hint: null, message: "JWT expired" });
    if (id.kind === "bad") return json(401, { code: "PGRST301", details: null, hint: null, message: "JWSError JWSInvalidSignature" });
    const uid = id.kind === "user" ? id.sub : null;
    if (!TABLES.has(table)) return json(404, { code: "PGRST205", details: null, hint: null, message: `Could not find the table 'public.${table}' in the schema cache` });
    const rows = tables.get(table);
    const filters = [];
    for (const [k, v] of url.searchParams) {
      if (RESERVED.has(k)) continue;
      const f = parseFilterValue(v);
      if (f) filters.push([k, f]);
    }
    const visible = (r) => PUBLIC_READ.has(table) || (uid !== null && r.user_id === uid);
    const matches = (r) => filters.every(([k, f]) => matchFilter(r, k, f));

    if (method === "GET" || method === "HEAD") {
      rec.kind = "rest:select";
      let out = rows.filter((r) => visible(r) && matches(r));
      const order = url.searchParams.get("order");
      if (order) {
        const keys = order.split(",").map((o) => o.split("."));
        out = [...out].sort((a, b) => {
          for (const [col, dir] of keys) {
            if (a[col] === b[col]) continue;
            const c = a[col] > b[col] ? 1 : -1;
            return dir === "desc" ? -c : c;
          }
          return 0;
        });
      }
      const total = out.length;
      const limit = url.searchParams.get("limit");
      if (limit) out = out.slice(0, Number(limit));
      const sel = (url.searchParams.get("select") || "*").replace(/\s/g, "");
      if (sel !== "*") {
        const cols = sel.split(",");
        out = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      }
      rec.resultRows = out.length;
      const extra = /count=/.test(prefer) ? { "content-range": `${out.length ? `0-${out.length - 1}` : "*"}/${total}` } : {};
      if (String(headers.accept || "").includes("vnd.pgrst.object+json")) {
        if (out.length !== 1) return json(406, { code: "PGRST116", details: `The result contains ${out.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" });
        return json(200, out[0], extra);
      }
      return method === "HEAD" ? { status: 200, headers: { "access-control-allow-origin": "*", ...extra }, body: "" } : json(200, out, extra);
    }

    if (method === "POST") {
      const list = Array.isArray(body) ? body : body ? [body] : [];
      const upsert = /resolution=(merge|ignore)-duplicates/.test(prefer);
      rec.kind = upsert ? "rest:upsert" : "rest:insert";
      rec.rowUserIds = [...new Set(list.map((r) => r?.user_id ?? null))];
      const allowed = list.every((r) => (ANON_WRITE.has(table) ? r.user_id == null || r.user_id === uid : uid !== null && r.user_id === uid));
      if (!allowed) {
        rec.rejected = "rls";
        return json(403, { code: "42501", details: null, hint: null, message: `new row violates row-level security policy for table "${table}"` });
      }
      const conflict = url.searchParams.get("on_conflict")?.split(",").map((s) => s.trim()) ?? PK[table];
      const ignore = /resolution=ignore-duplicates/.test(prefer);
      const stored = [];
      for (const r of list) {
        const i = upsert && conflict ? rows.findIndex((x) => conflict.every((k) => asText(x[k]) === asText(r[k]))) : -1;
        if (i >= 0) {
          if (!ignore) rows[i] = { ...rows[i], ...structuredClone(r) };
          stored.push(rows[i]);
        } else {
          const added = structuredClone(r);
          rows.push(added);
          stored.push(added);
        }
      }
      return /return=representation/.test(prefer) ? json(201, stored) : { status: 201, headers: { "access-control-allow-origin": "*" }, body: "" };
    }

    if (method === "PATCH") {
      rec.kind = "rest:update";
      rec.rowUserIds = [...new Set([body?.user_id, filters.find(([k, f]) => k === "user_id" && f.op === "eq")?.[1].val].filter((x) => x != null))];
      let n = 0;
      if (body && body.user_id !== undefined && body.user_id !== uid) {
        rec.rejected = "rls";
        return json(403, { code: "42501", details: null, hint: null, message: `new row violates row-level security policy for table "${table}"` });
      }
      for (const r of rows) if (visible(r) && uid !== null && r.user_id === uid && matches(r)) { Object.assign(r, structuredClone(body)); n++; }
      rec.updated = n;
      return { status: 204, headers: { "access-control-allow-origin": "*" }, body: "" };
    }

    if (method === "DELETE") {
      rec.kind = "rest:delete";
      rec.rowUserIds = [...new Set([filters.find(([k, f]) => k === "user_id" && f.op === "eq")?.[1].val].filter((x) => x != null))];
      const before = rows.length;
      tables.set(table, rows.filter((r) => !(uid !== null && r.user_id === uid && matches(r))));
      rec.deleted = before - tables.get(table).length;
      return { status: 204, headers: { "access-control-allow-origin": "*" }, body: "" };
    }
    return json(405, { message: "method not allowed" });
  }

  const offline = new Set(); // 通信が切れているタブ（にせの受け口に届かない: 本物と同じく net::ERR_INTERNET_DISCONNECTED）
  let hold = null; // { tab, promise, release, pending: [] }
  const held = []; // 止めた更新の記録 { tab, at, releasedAt, seq }
  const bodyOf = (request) => {
    const raw = request.postData();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  async function handle(route) {
    const request = route.request();
    if (offline.has(tabOf(request))) {
      // 届かなかった。誰として・何を送ろうとしたかは残す（kind offline。判定は「送った」に数えない。旧いコードのタブが B として送ろうとしたかは数える）
      const u = new URL(request.url());
      const id = identity(request.headers());
      const body = bodyOf(request);
      const rows = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
      requests.push({ seq: ++seq, at: Date.now(), t: Date.now() - t0, phase, tab: tabOf(request), method: request.method(), path: u.pathname, query: Object.fromEntries(u.searchParams), auth: { kind: id.kind, who: id.who }, body, rowUserIds: [...new Set(rows.map((r) => r?.user_id ?? null))], table: u.pathname.startsWith("/rest/v1/") ? u.pathname.replace(/^\/rest\/v1\//, "").split("/")[0] : undefined, kind: "offline", status: "offline" });
      return route.abort("internetdisconnected");
    }
    const method = request.method();
    const url = new URL(request.url());
    const headers = request.headers();
    const body = bodyOf(request);
    let heldRec = null;
    if (hold && method === "POST" && url.pathname === "/auth/v1/token" && tabOf(request) === hold.tab) {
      heldRec = { tab: hold.tab, at: Date.now(), phase, releasedAt: null, seq: null };
      held.push(heldRec);
      await hold.promise;
      heldRec.releasedAt = Date.now();
    }
    if (method === "OPTIONS") {
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,PUT,HEAD,OPTIONS" }, body: "" });
    }
    const id = identity(headers);
    const rec = {
      seq: ++seq, at: Date.now(), t: Date.now() - t0, phase, tab: tabOf(request), method, path: url.pathname,
      query: Object.fromEntries(url.searchParams), auth: { kind: id.kind, who: id.who, sid: id.sid ? id.sid.slice(0, 8) : undefined, exp: id.exp },
      body
    };
    if (heldRec) {
      heldRec.seq = rec.seq;
      rec.heldMs = heldRec.releasedAt - heldRec.at;
      rec.heldPhase = heldRec.phase;
    }
    let res;
    try {
      if (url.pathname.startsWith("/auth/v1/")) res = handleAuth(method, url, headers, body, rec);
      else if (url.pathname.startsWith("/rest/v1/")) res = handleRest(method, url, headers, body, rec);
      else {
        rec.kind = "other";
        res = json(404, { message: "fake: not handled" });
      }
    } catch (e) {
      rec.error = String(e?.stack || e);
      res = json(500, { message: "fake: error" });
    }
    rec.status = res.status;
    requests.push(rec);
    log(`#${rec.seq} [${rec.phase}] ${rec.tab} ${method} ${url.pathname}${url.search ? "?" + [...url.searchParams.keys()].join("&") : ""} ${rec.auth.kind}${rec.auth.who ? ":" + rec.auth.who : ""}${rec.who && rec.who !== rec.auth.who ? " (" + rec.who + ")" : ""} → ${res.status}${rec.rejected ? " (rls)" : ""}`);
    return route.fulfill(res);
  }

  return {
    handle,
    setOffline(tab, on) { if (on) offline.add(tab); else offline.delete(tab); },
    holdToken(tab) {
      let release;
      const promise = new Promise((r) => { release = r; });
      hold = { tab, promise, release };
    },
    releaseToken() {
      if (!hold) return;
      const h = hold;
      hold = null;
      h.release();
    },
    held,
    requests,
    tables,
    mailbox,
    setPhase(p) { phase = p; },
    label(page, name) { labels.set(page, name); },
    // メールのリンク（その人の最新）
    lastLink(email) {
      const m = [...mailbox].reverse().find((x) => x.email === email);
      return m?.link ?? null;
    },
    // ほかの端末で頼んだリンク（ブラウザの外で受けたメール）を作る
    issueLink(email, redirectTo) {
      const token = crypto.randomBytes(12).toString("hex");
      otps.set(token, { email, redirectTo, used: false });
      const link = `${SUPABASE_URL}/auth/v1/verify?token=${token}&type=magiclink&redirect_to=${encodeURIComponent(redirectTo)}`;
      mailbox.push({ email, link, at: Date.now(), outside: true });
      return link;
    },
    whoOf: who,
    sessions
  };
}
