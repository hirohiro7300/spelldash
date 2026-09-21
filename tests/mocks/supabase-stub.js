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
function fakeSession() {
  try {
    return localStorage.getItem("spelldash_test_session") ? { access_token: "test-token", user: { id: "test-user", email: "test@example.com" } } : null;
  } catch {
    return null;
  }
}

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: fakeSession() } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithOtp: asyncNull,
    signInWithOAuth: asyncNull,
    signOut: asyncNull
  },
  from: () => chain()
};
