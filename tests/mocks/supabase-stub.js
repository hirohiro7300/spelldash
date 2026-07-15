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

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithOtp: asyncNull,
    signInWithOAuth: asyncNull,
    signOut: asyncNull
  },
  from: () => chain()
};
