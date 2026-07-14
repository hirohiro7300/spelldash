import { elements, initializeDisplay, showMessage } from "./ui.js";
import { handleKeydown, restartGame, setMode, getMode, speakCurrentWord } from "./game.js";
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
elements.restart.addEventListener("click", restartGame);

if (elements.speakButton) {
  elements.speakButton.addEventListener("click", () => {
    speakCurrentWord();
    elements.input.focus();
  });
}

// Study / Challenge の切り替え
document.querySelectorAll(".mode-switch__btn").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

// 単語データを読み込んでからゲームを有効化
initWordStore()
  .then(() => {
    initializeCategoryPicker();
    initializeMixControl();
    renderMission();
    initializeDisplay();
    setMode(getMode());
  })
  .catch(() => {
    showMessage("単語データの読み込みに失敗しました。再読み込みしてください。", "wrong");
  });
