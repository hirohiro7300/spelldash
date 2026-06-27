import { elements, initializeDisplay } from "./ui.js";
import { handleKeydown, restartGame } from "./game.js";

initializeDisplay();

elements.input.addEventListener("keydown", handleKeydown);
elements.restart.addEventListener("click", restartGame);