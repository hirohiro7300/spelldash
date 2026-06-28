import { supabase } from "./supabase.js";
import { elements, initializeDisplay } from "./ui.js";
import { handleKeydown, restartGame } from "./game.js";
import { initializeWordList } from "./wordList.js";

initializeDisplay();
initializeWordList();

elements.input.addEventListener("keydown", handleKeydown);
elements.restart.addEventListener("click", restartGame);