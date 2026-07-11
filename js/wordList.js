import { getWordsByCategory, getCategories } from "./wordStore.js";
import { getWordStats } from "./storage.js";

const wordSearchElement = document.getElementById("wordSearch");
const wordListElement = document.getElementById("wordList");
const wordCategoryElement = document.getElementById("wordCategoryFilter");

let selectedCategory = "all";

export function initializeWordList() {
  renderCategoryFilter();
  renderFilteredList();

  wordSearchElement.addEventListener("input", renderFilteredList);
}

function renderCategoryFilter() {
  if (!wordCategoryElement) return;

  const categories = getCategories();

  wordCategoryElement.innerHTML = `
    <option value="all">すべてのカテゴリ</option>
    ${categories.map((c) => `<option value="${c.id}">${c.label}</option>`).join("")}
  `;

  wordCategoryElement.addEventListener("change", () => {
    selectedCategory = wordCategoryElement.value;
    renderFilteredList();
  });
}

function renderFilteredList() {
  const keyword = (wordSearchElement.value || "").toLowerCase().trim();
  const base = getWordsByCategory(selectedCategory);

  const filteredWords = keyword
    ? base.filter(
        (word) =>
          word.en.toLowerCase().includes(keyword) ||
          word.ja.includes(keyword) ||
          (word.tags || []).some((tag) => tag.includes(keyword))
      )
    : base;

  renderWordList(filteredWords);
}

function renderWordList(targetWords) {
  const stats = getWordStats();
  const categories = getCategories();
  const labelOf = (id) => categories.find((c) => c.id === id)?.label ?? id;

  if (targetWords.length === 0) {
    wordListElement.innerHTML = `<p class="muted">該当する単語がありません。</p>`;
    return;
  }

  wordListElement.innerHTML = `
    <p class="muted word-count">${targetWords.length}語</p>
    <div class="word-list">
      ${targetWords
        .slice(0, 200)
        .map((word) => {
          const data = stats[word.en];

          const status = data?.mastered
            ? "習得済み"
            : data?.missCount > 0
              ? "苦手"
              : data?.playCount > 0
                ? "学習中"
                : "未学習";

          return `
            <div class="word-item">
              <strong>${word.en}</strong>：${word.ja}<br>
              ${labelOf(word.category)} / レベル：${word.level} / 状態：${status}
            </div>
          `;
        })
        .join("")}
    </div>
    ${targetWords.length > 200 ? `<p class="muted">※表示は200語まで。検索やカテゴリで絞り込んでください。</p>` : ""}
  `;
}
