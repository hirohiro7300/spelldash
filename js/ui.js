import { renderColoredWord } from "./colors.js";
import { getBestScore, getWordStats } from "./storage.js";
import { findWord } from "./wordStore.js";
import { noteChipHtml, bindNoteEditors } from "./wordNotes.js";
import { classifyWord } from "./categoryProgress.js";

export const elements = {
  time: document.getElementById("time"),
  score: document.getElementById("score"),
  miss: document.getElementById("miss"),
  typeSpeed: document.getElementById("typeSpeed"),
  bestScore: document.getElementById("bestScore"),
  japanese: document.getElementById("japanese"),
  word: document.getElementById("word"),
  wordFamily: document.getElementById("wordFamily"),
  input: document.getElementById("input"),
  typedPreview: document.getElementById("typedPreview"),
  message: document.getElementById("message"),
  restart: document.getElementById("restart"),
  weakWords: document.getElementById("weakWords"),
  combo: document.getElementById("combo"),
  recallFail: document.getElementById("recallFail"),
  speakButton: document.getElementById("speakButton")
};

// prefers-reduced-motion の人には JS のスクロールも滑らかにしない（CSS の scroll-behavior より JS の behavior が優先されるため）
export function scrollBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

// 読み上げ専用のステータス行（index.html の #srStatus）。見た目の演出と切り離して SR に一言伝える
export function announce(text) {
  const el = document.getElementById("srStatus");
  if (!el) return;
  el.textContent = "";
  setTimeout(() => {
    el.textContent = text;
  }, 30);
}

export function initializeDisplay() {
  elements.bestScore.textContent = getBestScore();
  renderWeakWords();
}

export function showMessage(text, type = "") {
  elements.message.textContent = text;
  elements.message.className = `message ${type}`;
}

export function updateCombo(combo) {
  if (!elements.combo) return;

  if (combo < 2) {
    elements.combo.textContent = "";
    elements.combo.className = "combo";
    return;
  }

  elements.combo.textContent = `×${combo}`;
  const tier = combo >= 20 ? "combo--max" : combo >= 10 ? "combo--blaze" : combo >= 5 ? "combo--hot" : "combo--on";
  elements.combo.className = `combo ${tier}`;
}

// 答え以外の文（案内・ヒント）。hint=true は等幅（頭文字や語バンクを見せる）
export function showHiddenWordText(text, { hint = false } = {}) {
  elements.word.classList.remove("hidden-word--long");
  elements.word.classList.toggle("hidden-word--hint", hint);
  elements.word.setAttribute("aria-live", "off"); // 案内文は毎語同じなので読み上げない（出題は #japanese が伝える）
  elements.word.textContent = text;
}

export function showColoredAnswer(word) {
  elements.word.classList.remove("hidden-word--hint");
  elements.word.setAttribute("aria-live", "polite"); // 答えのスペルだけ読み上げる
  elements.word.classList.toggle("hidden-word--long", String(word).length > 24); // 英文は小さめに
  elements.word.innerHTML = renderColoredWord(word);
}

export function updateTypedPreview(text) {
  elements.typedPreview.innerHTML = renderColoredWord(text);
}

export function clearTypedPreview() {
  elements.typedPreview.innerHTML = "";
}

// いま苦手な語: 「最後に思い出せなかったまま」の語（単語帳・カテゴリ別と同じ定義 = classifyWord が weak）。
// 覚えた単語帳（覚えかけ・習得）とは排他。思い出せなかった回数が多い順に 5 語、1 語 1 行
export function renderWeakWords() {
  if (!elements.weakWords) return;

  const stats = getWordStats();

  const weakWords = Object.entries(stats)
    .filter(([, data]) => classifyWord(data) === "weak" || (!data?.lastRecallFailAt && !data?.lastRecallSuccessAt && (data?.missCount ?? 0) > 0))
    .sort((a, b) => (b[1].recallFail ?? 0) - (a[1].recallFail ?? 0) || (b[1].missCount ?? 0) - (a[1].missCount ?? 0))
    .slice(0, 5);

  if (weakWords.length === 0) {
    elements.weakWords.textContent = "いま苦手な語はない。";
    return;
  }

  elements.weakWords.innerHTML = `
    <div class="word-list">
      ${weakWords.map(([wordId, data]) => {
        const word = findWord(wordId);
        const en = word ? word.en : wordId.replace(/^[a-z]+-/, "");
        const ja = word ? word.ja : "";

        const recallFail = data.recallFail ?? 0;
        const typingMiss = data.typingMiss ?? 0;
        const correct = data.correctCount ?? 0;
        // 見せる数字は「思い出せず N回」だけ。思い出せた回数・打ち間違いは title に
        const detailTitle = [`思い出せた ${correct}回`, typingMiss > 0 ? `打ち間違い ${typingMiss}回` : ""].filter(Boolean).join(" ・ ");
        const missDetail = recallFail > 0 ? `<small title="${detailTitle}">思い出せず ${recallFail}回</small>` : "";
        const leech = recallFail >= 4 ? `<span class="leech-tag">難敵</span>` : "";

        return `
          <div class="word-item">
            <span class="gcard__status gcard__status--weak">苦手</span>
            <b class="mono">${word ? `<button type="button" class="word-item__detail" data-word-detail="${wordId}">${en}</button>` : en}</b>
            ${ja ? `<span class="word-item__ja">${ja}</span>` : ""}
            ${missDetail}${leech}${noteChipHtml(wordId, { onlyIfHas: true })}
          </div>
        `;
      }).join("")}
    </div>
  `;
  bindNoteEditors(elements.weakWords, () => renderWeakWords());
}