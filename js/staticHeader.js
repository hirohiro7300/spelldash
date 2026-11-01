import { icon } from "./icons.js";
import { watchHeaderFit } from "./headerFit.js";

// ===== 静的ページ（news／privacy／terms／tokushoho／packs）のヘッダー右端 =====
// アプリと同じ並び（連続日数チップ＋ログイン／設定）にする。Supabase は読み込まない
// （js/level.js → plan.js → supabase.js が SDK を取りに行くので、連続日数は localStorage を直接読む。
//   計算は level.js getStreak と同じ: last が今日か昨日でなければ 0 日）。
// 要素は HTML 側に置いてある（アプリと同じ DOM: チップは .account の直前の兄弟、ログインは .account の中）:
//   <a id="headerStreak" class="header-streak" href="/stats.html" hidden></a>
//   <div class="account"><a id="accountLink" class="btn btn--sm btn--ghost account__home account__link" href="/?login=1">ログイン</a></div>

const STREAK_KEY = "spelldash_streak";

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readStreak() {
  let data = {};
  try {
    data = JSON.parse(localStorage.getItem(STREAK_KEY)) || {};
  } catch {
    data = {};
  }
  const current = Number(data.current ?? 0) || 0;
  const shields = Number(data.shields ?? 0) || 0;
  const best = Math.max(current, Number(data.best ?? 0) || 0);
  const today = ymd(new Date());
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = ymd(y);
  const done = data.last === today;
  // 空いた日がシールドの枚数以内なら連続は続いている扱い（js/level.js normalizeStreak と同じ。ここでは保存はしない）
  const missed = data.last ? Math.round((new Date(today) - new Date(String(data.last).slice(0, 10))) / 86400000) - 1 : Infinity;
  const alive = data.last === today || data.last === yesterday || (missed > 0 && missed <= shields);
  return { current: alive ? current : 0, best, done };
}

// 連続日数チップ。連続 0 日（初回も、途切れた朝も）は hidden のまま（アプリ側 js/headerStreak.js と同じ条件）
export function renderStaticHeaderStreak() {
  const el = document.getElementById("headerStreak");
  if (!el) return;
  const streak = readStreak();
  el.hidden = streak.current === 0;
  if (el.hidden) return;
  el.classList.toggle("header-streak--off", !streak.done);
  el.innerHTML = `${icon("flame", { size: 14 })}<b>${streak.current}</b><span>日</span>`;
  el.setAttribute("aria-label", `連続 ${streak.current}日${streak.done ? "" : "（今日はまだ）"}`);
}

// ログイン済みらしいか: 認証のセッションの新しい鍵（js/supabase.js AUTH_STORAGE_KEY。見張り js/areaGuard.js が読んで覚える）か、テスト用セッション。
// 旧い鍵（sb-…-auth-token）は見ない（移行の後に残るのは旧コードのタブが書き戻した物だけ）。鍵の一覧（key・length）は使わない
function looksLoggedIn() {
  try {
    if (localStorage.getItem("spelldash_test_session")) return true;
    return Boolean(window.SpellDashArea?.signedIn());
  } catch {
    // localStorage が使えない環境では未ログイン扱い
    return false;
  }
}

export function renderStaticAccountLink() {
  const link = document.getElementById("accountLink");
  if (!link) return;
  if (!looksLoggedIn()) return;
  link.textContent = "設定";
  link.href = "/profile.html";
}

export function initStaticHeader() {
  renderStaticHeaderStreak();
  renderStaticAccountLink();
  watchHeaderFit(); // 1 行に入らなければ細い形に（アプリの頁の js/headerStreak.js と同じ）
}

initStaticHeader();
