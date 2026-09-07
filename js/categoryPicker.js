import { getCategories, getWordsByCategory } from "./wordStore.js";
import { setActiveCategory, isGamePlaying } from "./game.js";
import { renderLearnedCard } from "./learnedCard.js";
import { getGenre, setGenre, genreLabel, groupByGenre } from "./genres.js";

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
  renderGenreBar(saved);

  container.addEventListener("click", (event) => {
    const chip = event.target.closest(".category-chip");
    if (!chip) return;

    if (isGamePlaying()) return; // プレイ中は切り替えない

    const categoryId = chip.dataset.category;
    localStorage.setItem(CATEGORY_KEY, categoryId);
    setActiveCategory(categoryId);
    setGenre(""); // カテゴリを変えたらジャンルの絞り込みは解除
    renderGenreBar(categoryId);
    renderLearnedCard();

    container.querySelectorAll(".category-chip").forEach((el) => {
      el.classList.toggle("category-chip--active", el === chip);
    });
  });
}

// カテゴリの下: 一覧へのリンクと、ジャンルで絞っている時の表示・解除
function renderGenreBar(categoryId) {
  const bar = document.getElementById("genreBar");
  if (!bar) return;
  const genre = getGenre();
  const listHref = `./list.html?category=${encodeURIComponent(categoryId === "all" ? "" : categoryId)}`;
  const genres = categoryId === "all" ? [] : groupByGenre(categoryId);
  bar.innerHTML = `
    ${genre ? `<span class="genre-bar__active">ジャンル: <b>${genreLabel(genre)}</b><button type="button" class="genre-bar__clear" id="genreClear" aria-label="ジャンルの絞り込みを解除">✕ 解除</button></span>` : ""}
    ${genres.length > 1 && !genre ? `<span class="genre-bar__hint">${genres.length}ジャンル</span>` : ""}
    <a class="genre-bar__link" href="${listHref}">📖 ${categoryId === "all" ? "単語帳を見る" : "このカテゴリの一覧を見る"}</a>
  `;
  document.getElementById("genreClear")?.addEventListener("click", () => {
    if (isGamePlaying()) return;
    setGenre("");
    renderGenreBar(categoryId);
  });
}
