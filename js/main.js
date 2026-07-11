import { elements, initializeDisplay, showMessage } from "./ui.js";
import { handleKeydown, restartGame } from "./game.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderLevelBar } from "./levelUi.js";
import { initWordStore } from "./wordStore.js";
import { initializeCategoryPicker } from "./categoryPicker.js";

initializeAuth();
setFooterYear();
renderLevelBar();

elements.input.addEventListener("keydown", handleKeydown);
elements.restart.addEventListener("click", restartGame);

// 単語データを読み込んでからゲームを有効化
initWordStore()
  .then(() => {
    initializeCategoryPicker();
    initializeDisplay();
    showMessage("Enterキーでゲーム開始");
  })
  .catch(() => {
    showMessage("単語データの読み込みに失敗しました。再読み込みしてください。", "wrong");
  });
