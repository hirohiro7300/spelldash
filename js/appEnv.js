// ===== 実行環境（Web / PWA / ネイティブアプリ） =====
//
// Capacitor でアプリにしたときは、ページは capacitor://localhost（iOS）／https://localhost（Android）から
// 読み込まれる。API は本番の絶対 URL へ、Service Worker は使わない、セーフエリアを空ける。

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

if (isNativeApp) {
  document.documentElement.classList.add("native-app");
  document.documentElement.classList.add(`native-${window.Capacitor.getPlatform?.() ?? "app"}`);
}
