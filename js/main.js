import { supabase } from "./supabase.js";
import { elements, initializeDisplay } from "./ui.js";
import { handleKeydown, restartGame } from "./game.js";
import { initializeWordList } from "./wordList.js";
import { initializeAuth } from "./auth.js";

initializeDisplay();
initializeWordList();
initializeAuth();

const footerYearElement = document.getElementById("footerYear");
if (footerYearElement) {
  footerYearElement.textContent = new Date().getFullYear();
}

elements.input.addEventListener("keydown", handleKeydown);
elements.restart.addEventListener("click", restartGame);