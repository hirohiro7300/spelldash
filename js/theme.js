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
// meta theme-color（ブラウザの UI の色）。各ページの <head> のインラインの表と同じ値にする。
// 紙のページ: tokens.css の --paper。書斎（index.html、meta に data-room）: ヘッダーが透明で載る天井の色 --vault
const THEME_COLOR = { light: "#F4ECDA", dark: "#17120E", paper: "#F3E8CF", indigo: "#0E1322" };
const THEME_COLOR_ROOM = { light: "#1A2137", dark: "#04060B", paper: "#20243A", indigo: "#03050C" };

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
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", (meta.hasAttribute("data-room") ? THEME_COLOR_ROOM : THEME_COLOR)[theme]);
}
