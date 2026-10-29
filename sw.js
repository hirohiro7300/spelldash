// SpellDash Service Worker
// 方針: Network First（デプロイが即反映される）＋オフライン時はキャッシュへフォールバック。
// Supabase等のクロスオリジンには一切触らない。
// v5（Batch 78）: 先読みから /list.html を外した。前の版（v4）が持つ単語帳と分野パックの古いページは activate で消える
// v6（Batch 78 段 6）: 先読みからタイピングの 2 ページ（/typing.html・/typing-game.html。配信の転送で英単語のホームへ）を外した。前の版（v5）の保存は activate で消える
const CACHE_NAME = "spelldash-v6";

// 先読みのページ。配信の転送（vercel.json の redirects）が受けるパス（/list.html・/packs/*・/typing.html・/typing-game.html）は入れない: cache.addAll は転送を追うので、
// 転送の後の応答（redirected）をそのパスで保存し、オフラインでそのページを開くとブラウザが応答を断る（ページ遷移の応答は転送を含めない決まり）。
// E2E 78.5 の (4) が vercel.json と突き合わせる
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/battle.html",
  "/stats.html",
  "/profile.html",
  "/news.html",
  "/pro.html",
  "/privacy.html",
  "/terms.html",
  "/tokushoho.html"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // GET かつ同一オリジンのみ扱う（Supabase・認証リクエストは素通し）。
  // /api/ は保存しない: 管理画面の応答（プレイヤーのメール等）が端末のキャッシュに残らないように。
  // Cache API は Cache-Control: no-store を見ないので、ここで除外する必要がある
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          // パラメータ付きのページ遷移は、パラメータなしのパスにも同じ応答を保存する（ページの HTML はパラメータで変わらない）。
          // パラメータ付きの URL でだけ開く人でも、オフラインの代わり（下）が入れた時の古いパラメータなしの保存を返さない（PR #166 レビューの 1）
          const bare = request.mode === "navigate" && url.search ? response.clone() : null;
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, copy);
            if (bare) cache.put(url.pathname, bare);
          });
        }
        return response;
      })
      .catch(() => {
        // ページ遷移以外（css・js・データ）は URL がそのまま一致する保存だけを返す
        if (request.mode !== "navigate") return caches.match(request).then((hit) => hit || Response.error());
        // ページ遷移のオフラインフォールバック（タイピングの 2 枚はタブで URL を ?kind=／?course= に書き替える。パラメータは画面の js が読む）:
        // パラメータなしの同じパス → URL の完全一致 → パラメータを見ない一致 → 書斎、の順。パスだけの保存がいちばん新しい
        // （ページ遷移はパラメータがあっても無くてもそこへ保存し、install も書く）。完全一致やパラメータを見ない一致（最初に保存された項目を返す）を先にすると、
        // 何週間も前に ?kind=ja で開いた古い HTML が新しい css／js と組み合わさる（タブで同じ ?kind=ja に戻ると完全一致で当たる。PR #166 レビューの 1 とその反証）
        return caches
          .match(url.pathname)
          .then((page) => page || caches.match(request))
          .then((page) => page || caches.match(request, { ignoreSearch: true }))
          .then((page) => page || caches.match("/index.html"));
      })
  );
});
