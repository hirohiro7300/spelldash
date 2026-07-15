// Supabaseクライアント（遅延ロード版）。
//
// 以前は静的import("https://esm.sh/...")だったため、CDN障害時に
// モジュールグラフ全体が失敗しアプリが起動しなかった（単一障害点）。
// 動的importに変更し、失敗時はオフラインスタブで応答することで、
// CDNが落ちてもゲーム本体はLocal Firstで動き続ける。
//
// ここに置くキーはブラウザに埋め込む前提の「公開キー」（anon / publishable）です。
// 秘密の service_role キーは絶対に置かないこと。
// 取得場所：Supabase ダッシュボード → Project Settings → API → Project API keys

const supabaseUrl = "https://sujvgwozsnzjsjmkcrnk.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1anZnd296c256anNqbWtjcm5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MDA5NDIsImV4cCI6MjA5ODE3Njk0Mn0.NkgB0vIgI4Q3DL5fSuF4kbtF3P4ORMbHzoPGbnOG3mc";

export const isSupabaseConfigured =
  supabaseAnonKey.length > 20 &&
  (supabaseAnonKey.startsWith("eyJ") || supabaseAnonKey.startsWith("sb_"));

// テスト用の差し替え口（本番では常にesm.sh）
const MODULE_URL =
  (typeof window !== "undefined" && window.__SUPABASE_MODULE_URL) ||
  "https://esm.sh/@supabase/supabase-js@2";

let realClient = null;
let loadFailed = false;

const ready = import(MODULE_URL)
  .then(({ createClient }) => {
    realClient = createClient(supabaseUrl, supabaseAnonKey);
  })
  .catch(() => {
    loadFailed = true;
    console.warn("Supabase SDKの読み込みに失敗しました。オフラインモードで続行します。");
  });

// SDK未着時の応答（呼び出し側は error を見て静かにスキップする設計）
function stubResult() {
  return { data: null, error: { message: "supabase unavailable" }, count: null };
}

// auth: メソッド呼び出しをSDKロード後に委譲。失敗時は未ログイン相当を返す
const authProxy = new Proxy(
  {},
  {
    get(_, method) {
      return async (...args) => {
        await ready;
        if (realClient) return realClient.auth[method](...args);

        if (method === "getSession") return { data: { session: null } };
        if (method === "onAuthStateChange") {
          return { data: { subscription: { unsubscribe() {} } } };
        }
        return stubResult();
      };
    }
  }
);

// from(): ビルダー呼び出しを記録し、awaitされた時点で実クライアントに再生する。
// SDKが無ければスタブ結果を返す（Local First: 同期系は全て失敗を許容している）
function lazyBuilder(table) {
  const calls = [];

  const proxy = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === "then") {
        return (resolve, reject) => execute().then(resolve, reject);
      }
      return (...args) => {
        calls.push([prop, args]);
        return proxy;
      };
    }
  });

  async function execute() {
    await ready;
    if (!realClient) return stubResult();

    let query = realClient.from(table);
    for (const [method, args] of calls) {
      query = query[method](...args);
    }
    return query; // PostgRESTビルダーはthenable
  }

  return proxy;
}

export const supabase = {
  auth: authProxy,
  from: (table) => lazyBuilder(table)
};
