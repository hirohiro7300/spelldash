// SpellDash Service Worker
// 方針: Network First（デプロイが即反映される）＋オフライン時はキャッシュへフォールバック。
// Supabase等のクロスオリジンには一切触らない。
const CACHE_NAME = "spelldash-v1";

const CORE_ASSETS = [
  "/",
  "/index.html",
  "/battle.html",
  "/stats.html",
  "/profile.html"
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

  // GET かつ同一オリジンのみ扱う（Supabase・認証リクエストは素通し）
  if (request.method !== "GET" || url.origin !== location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => {
          if (hit) return hit;
          // ページ遷移のオフラインフォールバック
          if (request.mode === "navigate") return caches.match("/index.html");
          return Response.error();
        })
      )
  );
});
