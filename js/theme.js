// ===== テーマ（白／黒＋Pro の紙／藍）管理 =====
//
// 標準は白（light）。選択はローカル保存（端末ごとの好みとして扱う）。
// 各ページの<head>先頭のインラインスニペットが初期適用を担う（FOUC防止。Pro 判定はしない）。
// このモジュールは設定画面からの切替と、meta theme-colorの追従、Pro でない人の紙／藍の巻き戻しを担当する。
// 値は color-scheme の系統（light / dark）。紙はライト系、藍はダーク系の変種。

import { syncNativeChrome } from "./appEnv.js";
import { isPro } from "./plan.js";

const KEY = "spelldash_theme";

export const THEMES = { light: "light", dark: "dark", paper: "light", indigo: "dark" };
const PRO_THEMES = new Set(["paper", "indigo"]);
const THEME_COLOR = { light: "#f4f6fb", dark: "#0f172a", paper: "#f3ecdd", indigo: "#121a2b" };

export function isProTheme(theme) {
  return PRO_THEMES.has(theme);
}

// 保存値を返す。Pro でない人の紙／藍は同じ系統の白／黒に落とす（保存値も書き換える）
export function getTheme() {
  const saved = localStorage.getItem(KEY);
  const theme = THEMES[saved] ? saved : "light";
  if (PRO_THEMES.has(theme) && !isPro()) {
    const fallback = THEMES[theme];
    localStorage.setItem(KEY, fallback);
    return fallback;
  }
  return theme;
}

export function setTheme(theme) {
  localStorage.setItem(KEY, THEMES[theme] ? theme : "light");
  applyTheme();
}

export function applyTheme() {
  const theme = getTheme();
  document.documentElement.dataset.theme = theme;
  syncNativeChrome(THEMES[theme]); // アプリではステータスバーの色も追従（系統で渡す）
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}
