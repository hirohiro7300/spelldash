import { renderColoredWord } from "./colors.js";
import { getBestScore, getWordStats } from "./storage.js";
import { words } from "./words.js";

export const elements = {
  time: document.getElementById("time"),
  score: document.getElementById("score"),
  miss: document.getElementById("miss"),
  typeSpeed: document.getElementById("typeSpeed"),
  bestScore: document.getElementById("bestScore"),
  japanese: document.getElementById("japanese"),
  word: document.getElementById("word"),
  input: document.getElementById("input"),
  typedPreview: document.getElementById("typedPreview"),
  message: document.getElementById("message"),
  restart: document.getElementById("restart"),
  weakWords: document.getElementById("weakWords")
};

export function initializeDisplay() {
  elements.bestScore.textContent = getBestScore();
  renderWeakWords();
}

export function showMessage(text, type = "") {
  elements.message.textContent = text;
  elements.message.className = `message ${type}`;
}

export function showHiddenWordText(text) {
  elements.word.textContent = text;
}

export function showColoredAnswer(word) {
  elements.word.innerHTML = renderColoredWord(word);
}

export function updateTypedPreview(text) {
  elements.typedPreview.innerHTML = renderColoredWord(text);
}

export function clearTypedPreview() {
  elements.typedPreview.innerHTML = "";
}

export function renderWeakWords() {
  if (!elements.weakWords) return;

  const stats = getWordStats();

  const weakWords = Object.entries(stats)
    .filter(([, data]) => data.missCount > 0)
    .sort((a, b) => b[1].missCount - a[1].missCount)
    .slice(0, 5);

  if (weakWords.length === 0) {
    elements.weakWords.textContent = "まだ苦手単語はありません。";
    return;
  }

  elements.weakWords.innerHTML = `
    <div class="word-list">
      ${weakWords.map(([en, data]) => {
        const word = words.find((item) => item.en === en);
        const ja = word ? word.ja : "";

        return `
          <div class="word-item">
            <strong>${en}</strong>：${ja}<br>
            ミス ${data.missCount}回 / 正解 ${data.correctCount}回
          </div>
        `;
      }).join("")}
    </div>
  `;
}