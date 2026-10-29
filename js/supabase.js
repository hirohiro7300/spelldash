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

// テスト用の差し替え口（本番では常にesm.sh）。
// 部品の版は固定する（2.118.0。2026-10-29 に決めた）: 人ごとの保存の領域（js/areaGuard.js）は、部品が保存するセッションの鍵と形・
// タブをまたぐ知らせ・SIGNED_OUT を出す時機に頼る。幅のある版（@2）だと、知らないうちに振る舞いが変わる。版を上げるときは
// 旧タブの検査（tests/oldtab）と scripts/test-areas.mjs を流してから
const MODULE_URL =
  (typeof window !== "undefined" && window.__SUPABASE_MODULE_URL) ||
  "https://esm.sh/@supabase/supabase-js@2.118.0";

// 認証のセッションを置く鍵（世代を分けた新しい名前。spelldash_ で始めない）。旧い既定の鍵 sb-<ref>-auth-token は、移行のときに
// 切り替えの画面（js/areaSwitch.js）がここへ移して消す。旧コードのタブの部品は旧い鍵と旧い知らせの名前しか見ないので、
// 新しいタブでログインした人のセッションを読めない（DESIGN-FINAL §6）。js/areaGuard.js の AUTH_KEY と同じ名前（scripts/test-areas.mjs が確かめる）
export const AUTH_STORAGE_KEY = "sd2.auth";

// 認証のセッションの置き場（部品に渡す）。部品の既定は、localStorage への試し書きが入らない端末（満杯）ではセッションをメモリーに置く。
// そうなると、見張り（js/areaGuard.js）が読む sd2.auth と部品のセッションの人が食い違い、ほかの人のリンクで入っても切り替えの画面へ移らず、
// その人の同期が前の人の領域で動く。だから置き場を渡し、いつも localStorage（見張りが包んだ口）を通す。
// 書けなければ例外（部品はログインの失敗として返す。メモリーだけに置かない）。localStorage を読めない端末（サイトのデータを断る設定）では、
// 保存されたセッションは無い（読むと null・消すのは何もしない）
const authStorage = {
  getItem(key) {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    globalThis.localStorage.setItem(key, value);
  },
  removeItem(key) {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      // 読めない端末には消す物も無い
    }
  }
};

// 書き込みの世代の印（X-Client-Info。CORS で既に許されている見出しなので、新しい見出しは足さない）。人ごとの保存の領域の入った版（2）から送る。
// 後でサーバー側の行の権限で「この印の無い書き込みを断る」を足せる（旧コードのタブは印を付けない）
export const CLIENT_INFO = "spelldash/2 supabase-js-web/2.118.0";

// 送る直前の確かめ（人ごとの保存の領域。js/areaGuard.js の SpellDashArea）: 表（/rest/v1/）への要求は、Authorization のトークンの人とページの領域が合い、
// 見張りの stillMine()（領域の印が開いたときと同じ・切り替えの途中でない・セッションの人がページの人）のときだけ送る。違えば送らずに失敗の答えを返す
// （呼び手は送れなかったとして扱い、成功と見せない）。認証（/auth/v1/）はいつも通す（ログアウト・トークンの更新）。見張りの無い所では表へ送らない
function tokenUser(authorization) {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  const part = m ? m[1].split(".")[1] : null;
  if (!part) return null;
  try {
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return typeof payload?.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
function refusedResponse() {
  return new Response(JSON.stringify({ message: "記録の持ち主が替わったため送らなかった。", code: "SD2_AREA" }), { status: 409, headers: { "Content-Type": "application/json" } });
}
function guardedFetch(input, init) {
  const url = typeof input === "string" ? input : String(input?.url ?? input);
  if (url.includes("/rest/v1/")) {
    const headers = new Headers(init?.headers ?? (typeof input === "object" ? input?.headers : undefined) ?? undefined);
    const user = tokenUser(headers.get("Authorization"));
    const area = globalThis.SpellDashArea;
    let fits = false;
    try {
      fits = Boolean(area) && area.area === (user ? "u:" + user : "guest") && area.stillMine() === true;
    } catch {
      fits = false;
    }
    if (!fits) return Promise.resolve(refusedResponse());
  }
  return fetch(input, init);
}

let realClient = null;
let loadFailed = false;

const ready = import(MODULE_URL)
  .then(({ createClient }) => {
    realClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { storageKey: AUTH_STORAGE_KEY, storage: authStorage },
      global: { headers: { "X-Client-Info": CLIENT_INFO }, fetch: guardedFetch }
    });
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

// ログインのサーバーに届くか（プロジェクトの一時停止・通信断の検出）。
// Supabase の無料プロジェクトは 1 週間使われないと一時停止し、ホスト名が引けなくなる（DNS_PROBE_FINISHED_NXDOMAIN）。
// そのまま signInWithOAuth すると Google ではなく壊れたページへ飛ばされるので、先に 1 回だけ軽く確かめる。
export async function checkAuthReachable(timeoutMs = 4000) {
  if (!isSupabaseConfigured) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/health`, { headers: { apikey: supabaseAnonKey }, signal: controller.signal, cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const supabase = {
  auth: authProxy,
  from: (table) => lazyBuilder(table)
};
