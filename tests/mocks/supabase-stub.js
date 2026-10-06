// テスト用Supabaseスタブ。
// tests/e2e.mjs のローカルサーバーが /js/supabase.js の代わりにこれを配信する。
// 本物のSupabase（本番DB）にテストから絶対に接続しないための安全装置。
export const isSupabaseConfigured = false;

const SESSION_KEY = "spelldash_test_session";
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

// localStorage に spelldash_test_session があればログイン済みとして振る舞う（覚え方を作る 等の検証用）
// 値が "1" なら従来どおり access_token は "test-token"。それ以外の文字列ならその値をそのまま access_token にする
// （偽 API が Bearer の値で 403／503 を返し分けるため。例: "forbidden-token", "unconfigured-token", "nonotes-token"）
function fakeSession() {
  const value = readStorage(SESSION_KEY);
  if (!value) return null;
  const token = value === "1" ? "test-token" : value;
  return { access_token: token, user: { id: "test-user", email: "test@example.com" } };
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
  return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row(), error: null }) }) }) };
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
    getSession: async () => ({ data: { session: fakeSession() } }),
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
    // ログアウト: spelldash_test_session を消して SIGNED_OUT を流す（本物の SDK と同じく購読者へ知らせる）
    signOut: async () => {
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {
        // 使えない環境では何もしない
      }
      emit("SIGNED_OUT", null);
      return { data: null, error: null };
    }
  },
  from: (table) => {
    if (table === "subscriptions") return subscriptionsTable();
    const cloud = readStorage(CLOUD_KEY);
    return cloud ? cloudBuilder(cloud, table) : chain();
  }
};

// テスト用: ログインリンクから戻ってきた体で SIGNED_IN を流す（同じタブでの再ログイン）
if (typeof window !== "undefined") {
  window.__stubAuth = {
    signIn(value = "1") {
      localStorage.setItem(SESSION_KEY, value);
      emit("SIGNED_IN", fakeSession());
    }
  };
}
