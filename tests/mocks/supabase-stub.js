// テスト用Supabaseスタブ。
// tests/e2e.mjs のローカルサーバーが /js/supabase.js の代わりにこれを配信する。
// 本物のSupabase（本番DB）にテストから絶対に接続しないための安全装置。
export const isSupabaseConfigured = false;

const asyncNull = async () => ({ data: null, error: null });

function chain() {
  return new Proxy(function () {}, {
    get: (_, prop) => (prop === "then" ? undefined : () => chain()),
    apply: () => chain()
  });
}

// localStorage に spelldash_test_session があればログイン済みとして振る舞う（覚え方を作る 等の検証用）
// 値が "1" なら従来どおり access_token は "test-token"。それ以外の文字列ならその値をそのまま access_token にする
// （偽 API が Bearer の値で 403／503 を返し分けるため。例: "forbidden-token", "unconfigured-token", "nonotes-token"）
function fakeSession() {
  try {
    const value = localStorage.getItem("spelldash_test_session");
    if (!value) return null;
    const token = value === "1" ? "test-token" : value;
    return { access_token: token, user: { id: "test-user", email: "test@example.com" } };
  } catch {
    return null;
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

// 到達確認はテストでは常に OK（本物のサーバーには行かない）
export const checkAuthReachable = async () => true;

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: fakeSession() } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithOtp: asyncNull,
    signInWithOAuth: asyncNull,
    signOut: asyncNull
  },
  from: (table) => (table === "subscriptions" ? subscriptionsTable() : chain())
};
