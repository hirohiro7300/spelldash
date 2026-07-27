// ===== テーマ（白ベース/黒ベース）管理 =====
//
// 標準は白（light）。選択はローカル保存（端末ごとの好みとして扱う）。
// 各ページの<head>先頭のインラインスニペットが初期適用を担う（FOUC防止）。
// このモジュールは設定画面からの切替と、meta theme-colorの追従を担当する。

const KEY = "spelldash_theme";

export function getTheme() {
  return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
}

export function setTheme(theme) {
  localStorage.setItem(KEY, theme === "dark" ? "dark" : "light");
  applyTheme();
}

export function applyTheme() {
  const theme = getTheme();
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0f172a" : "#f4f6fb");
}
