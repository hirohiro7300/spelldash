import { elements, initializeDisplay } from "./ui.js";
import { handleKeydown, restartGame } from "./game.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";

initializeDisplay();
initializeAuth();
setFooterYear();

elements.input.addEventListener("keydown", handleKeydown);
elements.restart.addEventListener("click", restartGame);
