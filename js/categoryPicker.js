import { getCategories, getWordsByCategory } from "./wordStore.js";
import { setActiveCategory, isGamePlaying } from "./game.js";

const CATEGORY_KEY = "spelldash_category";

export function getSavedCategory() {
  return localStorage.getItem(CATEGORY_KEY) || "all";
}

export function initializeCategoryPicker() {
  const container = document.getElementById("categoryPicker");
  if (!container) return;

  const saved = getSavedCategory();
  const categories = [{ id: "all", label: "すべて" }, ...getCategories()];

  container.innerHTML = categories
    .map((c) => {
      const count = getWordsByCategory(c.id).length;
      return `
        <button
          type="button"
          class="category-chip${c.id === saved ? " category-chip--active" : ""}"
          data-category="${c.id}"
        >
          ${c.label}<span class="category-chip__count">${count}</span>
        </button>
      `;
    })
    .join("");

  setActiveCategory(saved);

  container.addEventListener("click", (event) => {
    const chip = event.target.closest(".category-chip");
    if (!chip) return;

    if (isGamePlaying()) return; // プレイ中は切り替えない

    const categoryId = chip.dataset.category;
    localStorage.setItem(CATEGORY_KEY, categoryId);
    setActiveCategory(categoryId);

    container.querySelectorAll(".category-chip").forEach((el) => {
      el.classList.toggle("category-chip--active", el === chip);
    });
  });
}
