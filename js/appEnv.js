// ===== 実行環境（Web / PWA / ネイティブアプリ） =====
//
// Capacitor でアプリにしたときは、ページは capacitor://localhost（iOS）／https://localhost（Android）から
// 読み込まれる。API は本番の絶対 URL へ、Service Worker は使わない、セーフエリアを空ける。
// このアプリはビルド無しの ES modules なので @capacitor/core は読み込まない。ネイティブのプラグインは
// WebView に注入されるブリッジ（Capacitor.nativePromise）で直接呼ぶ。

export const isNativeApp = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());

export const PRODUCTION_ORIGIN = "https://www.spelldash.net";

// /api/... の呼び先。Web ではそのまま同一オリジン、アプリでは本番へ
export function apiUrl(path) {
  return isNativeApp ? PRODUCTION_ORIGIN + path : path;
}

// 認証のリダイレクト先。アプリ内の WebView のオリジンは外から開けないので本番へ
export function authRedirectOrigin() {
  return isNativeApp ? PRODUCTION_ORIGIN : window.location.origin;
}

// ネイティブのプラグインを呼ぶ（アプリ以外・プラグイン無しでは何もしない）。失敗は握りつぶす（装飾なので）
export function nativeCall(plugin, method, options = {}) {
  if (!isNativeApp) return Promise.resolve(null);
  const bridge = window.Capacitor?.nativePromise;
  if (typeof bridge !== "function") return Promise.resolve(null);
  try {
    return Promise.resolve(bridge(plugin, method, options)).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

// ステータスバーの色をテーマに合わせる（iOS: style LIGHT＝暗い文字、DARK＝白い文字）
export function syncNativeChrome(theme) {
  if (!isNativeApp) return;
  const dark = theme === "dark";
  nativeCall("StatusBar", "setStyle", { style: dark ? "DARK" : "LIGHT" });
  nativeCall("StatusBar", "setBackgroundColor", { color: dark ? "#0f172a" : "#ffffff" });
}

// アプリ内に無いページ（/packs/ の紹介ページなど）は本番サイトを外部ブラウザで開く
export function openExternal(url) {
  window.open(url, "_blank", "noopener");
}

if (isNativeApp) {
  document.documentElement.classList.add("native-app");
  document.documentElement.classList.add(`native-${window.Capacitor.getPlatform?.() ?? "app"}`);
  syncNativeChrome(localStorage.getItem("spelldash_theme") === "dark" ? "dark" : "light");

  // dist に含めていない /packs/ へのリンクは本番へ（WebView 内で開くと index.html が壊れて出る）
  document.addEventListener(
    "click",
    (event) => {
      const a = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!a) return;
      let url;
      try {
        url = new URL(a.getAttribute("href"), window.location.href);
      } catch {
        return;
      }
      if (!url.pathname.startsWith("/packs/")) return;
      event.preventDefault();
      openExternal(PRODUCTION_ORIGIN + url.pathname + url.search + url.hash);
    },
    true
  );
}
