import { words } from "./words.js";
import { getWordStats } from "./storage.js";

const wordSearchElement = document.getElementById("wordSearch");
const wordListElement = document.getElementById("wordList");

export function initializeWordList() {
  renderWordList(words);

  wordSearchElement.addEventListener("input", () => {
    const keyword = wordSearchElement.value.toLowerCase();

    const filteredWords = words.filter((word) => {
      return (
        word.en.toLowerCase().includes(keyword) ||
        word.ja.includes(keyword)
      );
    });

    renderWordList(filteredWords);
  });
}

function renderWordList(targetWords) {
  const stats = getWordStats();

  wordListElement.innerHTML = `
    <div class="word-list">
      ${targetWords.map((word) => {
        const data = stats[word.en];

        const status = data?.mastered
          ? "習得済み"
          : data?.missCount > 0
            ? "苦手"
            : "未学習";

        return `
          <div class="word-item">
            <strong>${word.en}</strong>：${word.ja}<br>
            レベル：${word.level} / 状態：${status}
          </div>
        `;
      }).join("")}
    </div>
  `;
}