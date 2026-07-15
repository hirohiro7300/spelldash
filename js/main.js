import { elements, initializeDisplay, showMessage } from "./ui.js";
import {
  handleKeydown,
  handleTextInput,
  handleBeforeInput,
  restartGame,
  setMode,
  getMode,
  speakCurrentWord,
  startDailyGame
} from "./game.js";
import { renderDailyCard } from "./dailyChallenge.js";
import { isWeakOnlyMode, setWeakOnlyMode, getWeakCount } from "./studyQueue.js";
import { isGamePlaying } from "./game.js";
import { renderOnboarding } from "./onboarding.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderLevelBar } from "./levelUi.js";
import { renderStreakCard } from "./streakUi.js";
import { initWordStore } from "./wordStore.js";
import { initializeCategoryPicker } from "./categoryPicker.js";
import { renderMission } from "./mission.js";
import { setupUnloadSync } from "./sync.js";
import { initializeMixControl } from "./studyMix.js";

initializeAuth();
setFooterYear();
renderLevelBar();
renderStreakCard();
setupUnloadSync();

// クラウド同期でローカルデータが更新されたら表示を作り直す
window.addEventListener("spelldash:synced", () => {
  renderLevelBar();
  renderStreakCard();
  renderMission();
  initializeDisplay();
});

elements.input.addEventListener("keydown", handleKeydown);
// モバイル（ソフトキーボード）: keydownで文字が取れない環境用
elements.input.addEventListener("beforeinput", handleBeforeInput);
elements.input.addEventListener("input", handleTextInput);
elements.restart.addEventListener("click", restartGame);

if (elements.speakButton) {
  elements.speakButton.addEventListener("click", () => {
    speakCurrentWord();
    elements.input.focus();
  });
}

// Study / Challenge の切り替え
document.querySelectorAll(".mode-switch__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    setMode(btn.dataset.mode);
    refreshWeakToggle();
  });
});

// ===== 苦手のみ復習トグル（Studyモード限定） =====
function refreshWeakToggle() {
  const button = document.getElementById("weakToggleButton");
  const count = document.getElementById("weakToggleCount");
  if (!button || !count) return;

  button.classList.toggle("weak-toggle__btn--on", isWeakOnlyMode());
  const weak = getWeakCount();
  count.textContent = weak > 0 ? `${weak}語` : "0語";
  button.disabled = weak === 0 && !isWeakOnlyMode();
}

const weakToggleButton = document.getElementById("weakToggleButton");
if (weakToggleButton) {
  weakToggleButton.addEventListener("click", () => {
    setWeakOnlyMode(!isWeakOnlyMode());
    refreshWeakToggle();
    // プレイ中なら新しいプールでキューを作り直す
    if (isGamePlaying() && getMode() === "study") {
      restartGame();
    }
  });
}

// カテゴリ変更後に苦手数を更新（描画後に反映されるよう次のtickで）
document.getElementById("categoryPicker")?.addEventListener("click", () => {
  setTimeout(refreshWeakToggle, 0);
});

// 単語データを読み込んでからゲームを有効化
initWordStore()
  .then(() => {
    initializeCategoryPicker();
    initializeMixControl();
    renderMission();
    renderDailyCard(() => {
      startDailyGame();
      elements.input.focus();
    });
    initializeDisplay();
    setMode(getMode());
    refreshWeakToggle();
    renderOnboarding(() => {
      setMode("study");
      restartGame();
      elements.input.focus();
      document.getElementById("input")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  })
  .catch(() => {
    showMessage("単語データの読み込みに失敗しました。再読み込みしてください。", "wrong");
  });
