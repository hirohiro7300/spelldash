import { elements, initializeDisplay, showMessage } from "./ui.js";
import { handleKeydown, restartGame, setMode, getMode } from "./game.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderLevelBar } from "./levelUi.js";
import { initWordStore } from "./wordStore.js";
import { initializeCategoryPicker } from "./categoryPicker.js";
import { renderMission } from "./mission.js";

initializeAuth();
setFooterYear();
renderLevelBar();

elements.input.addEventListener("keydown", handleKeydown);
elements.restart.addEventListener("click", restartGame);

// Study / Challenge の切り替え
document.querySelectorAll(".mode-switch__btn").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

// 単語データを読み込んでからゲームを有効化
initWordStore()
  .then(() => {
    initializeCategoryPicker();
    renderMission();
    initializeDisplay();
    setMode(getMode());
  })
  .catch(() => {
    showMessage("単語データの読み込みに失敗しました。再読み込みしてください。", "wrong");
  });
