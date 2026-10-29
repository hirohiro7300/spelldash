// テスト用Supabaseスタブ。
// tests/e2e.mjs のローカルサーバーが /js/supabase.js の代わりにこれを配信する。
// 本物のSupabase（本番DB）にテストから絶対に接続しないための安全装置。
export const isSupabaseConfigured = false;

// 認証のセッションは本物の部品と同じく新しい鍵 sd2.auth に JSON で置く（js/supabase.js AUTH_STORAGE_KEY。見張り js/areaGuard.js が読む形:
// { access_token, refresh_token, expires_at, token_type, user: { id, email } }）。人ごとの保存の領域（Batch 78-7 内部の 2）の検査は、ここに書いた人で
// 見張りと切り替えの画面が動く。タブをまたぐ知らせ（SIGNED_IN・SIGNED_OUT）は、本物の部品と同じく鍵と同じ名前の BroadcastChannel で送る
export const AUTH_STORAGE_KEY = "sd2.auth";
const DEFAULT_USER = { id: "test-user", email: "test@example.com" };
// 前の形の種（tests/e2e.mjs の種の spelldash_test_session）: "1" → access_token test-token、それ以外の文字列はその値。新しい鍵が無ければ
// test-user のセッションとして新しい鍵へ書く（最初に getSession を呼んだ時。ログインのリンクから戻ったタブの部品と同じ: 見張りが人の替わりを見て切り替えの画面へ移す）
const SESSION_KEY = "spelldash_test_session";
// signOut の scope の控え（JSON の配列。検査が読む）・通信できない signOut の印（"1"。navigator.onLine が false のときも）
const SIGNOUTS_KEY = "spelldash_test_signouts";
const SIGNOUT_OFFLINE_KEY = "spelldash_test_signout_offline";
// 端末間同期の検証用「クラウド」: localStorage の spelldash_test_cloud にクラウドの id があれば、
// from(table) の呼び出しを記録して await の時点で tests/e2e.mjs のローカルサーバー（POST /__cloud/query）に投げる。
// サーバー側のメモリが Supabase の表のつもり（seed・select の失敗・遅延・送信の記録はサーバー側で決める）。
// spelldash_test_cloud が無ければ従来どおり（chain: どの呼び出しも何も返さない）。
const CLOUD_KEY = "spelldash_test_cloud";

const asyncNull = async () => ({ data: null, error: null });

function chain() {
  return new Proxy(function () {}, {
    get: (_, prop) => (prop === "then" ? undefined : () => chain()),
    apply: () => chain()
  });
}

const readStorage = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

// セッションの形（本物の部品が sd2.auth に置く形と同じ）。token が "1" なら access_token は "test-token"、それ以外の文字列はその値
// （偽 API が Bearer の値で 403／503 を返し分けるため。例: "forbidden-token", "unconfigured-token", "nonotes-token"）
function makeSession(token = "1", user = DEFAULT_USER) {
  return { access_token: token === "1" ? "test-token" : String(token), token_type: "bearer", expires_in: 3600, expires_at: 9999999999, refresh_token: "test-refresh", user: { ...DEFAULT_USER, ...user } };
}
// sd2.auth のセッション（無い・読めないなら null）
function fakeSession() {
  try {
    const s = JSON.parse(readStorage(AUTH_STORAGE_KEY) || "null");
    return s && typeof s.user?.id === "string" && s.user.id ? s : null;
  } catch {
    return null;
  }
}
function writeSession(session) {
  try {
    if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // 保存の無い環境ではログインもしない
  }
}
// 前の形の種を新しい鍵へ（新しい鍵にセッションが無いときだけ）。本物の部品と同じく、読み込みの時ではなく最初にセッションを読む時に書く
// （本物の部品は URL のトークンを初期化の後で保存する。読み込みの時に書くと、ページの残りの同期の書き込みが切り替えの前に断られる）
function adoptLegacySeed() {
  try {
    const legacy = readStorage(SESSION_KEY);
    if (legacy && !fakeSession()) writeSession(makeSession(legacy));
  } catch {
    // 使えない環境では何もしない
  }
}

// 読み込みの遅れの模擬（加入画面の読み込みの検査。PR #170 のレビュー 2）: localStorage の spelldash_test_delay = {"session": ms, "plan": ms} があれば、
// getSession（session）と subscriptions の読み（plan）を、ページを開いてから ms たつまで返さない（同じページの何度目の呼び出しも同じ時刻に返る。
// 本物ではトークンの更新・Pro の状態の問い合わせが遅いとき）。無ければ待たない（今までと同じ順で返す）
function testDelay(kind) {
  try {
    const ms = Number(JSON.parse(readStorage("spelldash_test_delay") || "{}")?.[kind]) || 0;
    const left = ms - performance.now();
    return left > 0 ? new Promise((resolve) => setTimeout(resolve, left)) : null;
  } catch {
    return null;
  }
}

// ログイン状態の変化を購読者へ流す（ログアウト → 同じタブで再ログイン の検証用）
const listeners = [];
function emit(event, session) {
  for (const cb of [...listeners]) {
    try {
      cb(event, session);
    } catch {
      // 購読側の例外は他の購読者へ流すのを止めない
    }
  }
}
// ほかのタブへの知らせ（本物の部品と同じく、保存の鍵と同じ名前の BroadcastChannel。受けたタブは購読者へ流すだけで、保存は書かない）
let channel = null;
try {
  channel = new BroadcastChannel(AUTH_STORAGE_KEY);
  channel.onmessage = (e) => {
    const { event, session } = e.data || {};
    if (typeof event === "string") emit(event, session ?? null);
  };
} catch {
  channel = null;
}
function announce(event, session) {
  emit(event, session);
  try {
    channel?.postMessage({ event, session });
  } catch {
    // 送れなくても、このタブには流した
  }
}
function noteSignOut(scope) {
  try {
    const list = JSON.parse(readStorage(SIGNOUTS_KEY) || "[]");
    list.push(scope ?? null);
    localStorage.setItem(SIGNOUTS_KEY, JSON.stringify(list));
  } catch {
    // 控えられなくても続ける
  }
}

// subscriptions（Pro の加入状態）だけは localStorage の spelldash_test_plan を本人の行として返す（無ければ行なし）。
// 例: {"status":"active","plan_interval":"month","current_period_end":"<今日+20日 ISO>","cancel_at_period_end":false}
// js/plan.js の refreshPlan() は select().eq().maybeSingle() の形で読むので、その形だけ用意する
function subscriptionsTable() {
  const row = () => {
    try {
      return JSON.parse(localStorage.getItem("spelldash_test_plan") || "null");
    } catch {
      return null;
    }
  };
  return { select: () => ({ eq: () => ({ maybeSingle: async () => { const wait = testDelay("plan"); if (wait) await wait; return { data: row(), error: null }; } }) }) };
}

async function runCloudQuery(cloud, table, ops) {
  const body = JSON.stringify({ cloud, table, ops, userId: fakeSession()?.user?.id ?? null });
  try {
    // keepalive は本体 64KB までしか送れない。pagehide の送信も記録できるよう、小さいときだけ付ける
    const res = await fetch("/__cloud/query", { method: "POST", headers: { "Content-Type": "application/json" }, body, cache: "no-store", keepalive: body.length < 60000 });
    return await res.json();
  } catch (e) {
    return { data: null, error: { message: `fetch failed: ${e.message}` }, count: null };
  }
}

// 本物の js/supabase.js と同じ形: メソッド呼び出しを記録し、then された時点で実行する
function cloudBuilder(cloud, table) {
  const ops = [];
  const proxy = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === "then") return (resolve, reject) => runCloudQuery(cloud, table, ops).then(resolve, reject);
      if (prop === "catch") return (fn) => runCloudQuery(cloud, table, ops).catch(fn);
      if (prop === "finally") return (fn) => runCloudQuery(cloud, table, ops).finally(fn);
      return (...args) => {
        ops.push([String(prop), args]);
        return proxy;
      };
    }
  });
  return proxy;
}

// 到達確認はテストでは常に OK（本物のサーバーには行かない）
export const checkAuthReachable = async () => true;

export const supabase = {
  auth: {
    getSession: async () => {
      const wait = testDelay("session");
      if (wait) await wait;
      if (readStorage(SESSION_KEY) && !fakeSession()) {
        // 本物の部品と同じく、ページの読み込みの同期の処理が済んでから書く（次のタスク）
        await new Promise((resolve) => setTimeout(resolve, 0));
        adoptLegacySeed();
      }
      return { data: { session: fakeSession() } };
    },
    onAuthStateChange: (cb) => {
      listeners.push(cb);
      return {
        data: {
          subscription: {
            unsubscribe() {
              const i = listeners.indexOf(cb);
              if (i >= 0) listeners.splice(i, 1);
            }
          }
        }
      };
    },
    signInWithOtp: asyncNull,
    signInWithOAuth: asyncNull,
    // ログアウト（本物の部品と同じ）: 受け口に届かない（オフライン・spelldash_test_signout_offline）なら失敗を返し、セッションは残す。
    // 届けばセッション（sd2.auth と前の形の種）を消して SIGNED_OUT を流す（ほかのタブにも）。scope は控える
    signOut: async (options = {}) => {
      noteSignOut(options?.scope ?? null);
      const offline = (typeof navigator !== "undefined" && navigator.onLine === false) || readStorage(SIGNOUT_OFFLINE_KEY) === "1";
      if (offline) return { error: { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 } };
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {
        // 使えない環境では何もしない
      }
      writeSession(null);
      announce("SIGNED_OUT", null);
      return { error: null };
    }
  },
  from: (table) => {
    if (table === "subscriptions") return subscriptionsTable();
    const cloud = readStorage(CLOUD_KEY);
    return cloud ? cloudBuilder(cloud, table) : chain();
  }
};

// テスト用:
//   signIn(token, user) … ログインリンクから戻ってきた体（sd2.auth に書いて SIGNED_IN をこのタブとほかのタブへ）。user で別の人（{ id, email }）
//   expire()           … トークンの更新が失敗した体（本物の部品と同じく、セッションを消して SIGNED_OUT をこのタブとほかのタブへ）
if (typeof window !== "undefined") {
  window.__stubAuth = {
    signIn(value = "1", user = DEFAULT_USER) {
      const session = makeSession(value, user);
      writeSession(session);
      announce("SIGNED_IN", session);
    },
    expire() {
      writeSession(null);
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {
        // 使えない環境では何もしない
      }
      announce("SIGNED_OUT", null);
    }
  };
}
