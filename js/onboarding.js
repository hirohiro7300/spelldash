import { getWordStats } from "./storage.js";
import { getTotalXp } from "./level.js";

// 初回訪問オンボーディング。
// 目的: 最初の30秒で「1語思い出して打てた」という成功体験を作る。
// 学習データが1語でもあれば二度と表示しない（既存ユーザーには出ない）。

const ONBOARDED_KEY = "spelldash_onboarded";

function isFirstVisit() {
  if (localStorage.getItem(ONBOARDED_KEY)) return false;
  if (getTotalXp() > 0) return false;
  return Object.keys(getWordStats()).length === 0;
}

export function markOnboarded() {
  localStorage.setItem(ONBOARDED_KEY, "1");
}

export function renderOnboarding(onStart) {
  const container = document.getElementById("onboardingCard");
  if (!container) return;

  if (!isFirstVisit()) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <button type="button" class="onboarding__close" id="onboardingClose" aria-label="閉じる">✕</button>
    <div class="onboarding__title">30秒で分かるSpellDash</div>
    <ol class="onboarding__steps">
      <li><strong>日本語訳</strong>を見て、英単語をタイプ</li>
      <li>分からなければ <kbd>Enter</kbd> で答えを表示</li>
      <li>答えを見た単語は、数問後にもう一度出ます。<strong>思い出せたら勝ち</strong></li>
    </ol>
    <button type="button" class="onboarding__start" id="onboardingStart">▶ 最初の1語を打ってみる</button>
  `;

  document.getElementById("onboardingStart").addEventListener("click", () => {
    markOnboarded();
    container.innerHTML = "";
    if (onStart) onStart();
  });

  document.getElementById("onboardingClose").addEventListener("click", () => {
    markOnboarded();
    container.innerHTML = "";
  });
}
