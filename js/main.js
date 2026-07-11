import { elements, initializeDisplay } from "./ui.js";
import { handleKeydown, restartGame } from "./game.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderLevelBar } from "./levelUi.js";

initializeDisplay();
initializeAuth();
setFooterYear();
renderLevelBar();

elements.input.addEventListener("keydown", handleKeydown);
elements.restart.addEventListener("click", restartGame);
