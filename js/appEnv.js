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

// ブラウザの UI（meta theme-color）とアプリのステータスバーの色: ヘッダーの帯（天井の紺 --vault）。全ページ・全テーマで暗い。
// 各ページの <head> のインラインの表・manifest.webmanifest の theme_color と同じ値にする（tokens.css の --vault）
export const THEME_COLOR = { light: "#1A2137", dark: "#04060B", paper: "#20243A", indigo: "#03050C" };

// ステータスバーをヘッダーの帯に合わせる。帯はどのテーマでも暗いので文字は白（iOS: style DARK）、背景は帯の色（Android）
export function syncNativeChrome(theme) {
  if (!isNativeApp) return;
  nativeCall("StatusBar", "setStyle", { style: "DARK" });
  nativeCall("StatusBar", "setBackgroundColor", { color: THEME_COLOR[theme] ?? THEME_COLOR.light });
}

// アプリ内に無いページ（/packs/ の紹介ページなど）は本番サイトを外部ブラウザで開く
export function openExternal(url) {
  window.open(url, "_blank", "noopener");
}

if (isNativeApp) {
  document.documentElement.classList.add("native-app");
  document.documentElement.classList.add(`native-${window.Capacitor.getPlatform?.() ?? "app"}`);
  syncNativeChrome(localStorage.getItem("spelldash_theme") || "light");

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
