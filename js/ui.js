import { renderColoredWord } from "./colors.js";
import { getBestScore, getWordStats } from "./storage.js";
import { findWord } from "./wordStore.js";
import { noteChipHtml, bindNoteEditors } from "./wordNotes.js";
import { classifyWord } from "./categoryProgress.js";
import { normalizeReading } from "./romaji.js";
import { createLive } from "./srLive.js";

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

// 読み上げ専用のステータス行（index.html の #srStatus）。見た目の演出と切り離して SR に一言伝える。
// 一度空にしてから 30ms 後に書く（同じ文の続けての読み上げも拾われる）。その待ちの間に次の announce が来たら、前の文を消さずに
// 1 つの文につなげる（時間切れでレベルアップと見出しの文が同じ tick に来る: js/game.js celebrateRankUp → focusResultTitle。PR #164 レビューの 3）。
// 窓が開いている間は #srStatus が窓の外で読まれないので、書く瞬間に開いている窓の中の読み上げの行に書く
// （窓の中なので、aria-modal の窓の外を読まない読み上げでも読まれる。Batch 65 Q3 の窓の外の行 #srStatusTop は PR #166 レビューの 7 で窓の中の行に替えた）。
// 書く前は #srStatus と窓の中の行を全部空にする（窓を開け閉めしても、前の文が残った行で同じ文が読まれないことがない）。
// 空にして間をあけて書く・書く瞬間に行き先を選ぶ・つなげるの形は js/srLive.js createLive（タイピングの 2 ページの読み上げも同じ形。PR #168 レビューの 7）
const srStatus = createLive(() => document.getElementById("srStatus"), { gap: 30, join: true });
export function announce(text) {
  srStatus.say(text);
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

// 答え（鎌倉幕府）の下に読み（かまくらばくふ）を添える。答えがかなだけ（読みと同じ）なら添えない
export function showAnswerWithReading(answer, reading) {
  showColoredAnswer(answer);
  const shown = String(reading ?? "");
  if (!shown || normalizeReading(answer) === normalizeReading(shown)) return;
  const small = document.createElement("small");
  small.className = "hidden-word__reading";
  small.textContent = shown;
  elements.word.appendChild(small);
}

// ローマ字で打つカード: 打ったかなを上、その下に打ったキーを出す（2 段）。まだかなにならないキーは末尾に。
// 読みのまだ打っていない部分は出さない（思い出す練習なので、写させない）
export function updateRomajiPreview({ committed = [], pending = "" } = {}) {
  const cell = (kana, keys, cls = "") => {
    const el = document.createElement("span");
    el.className = `rk${cls}`;
    const top = document.createElement("span");
    top.className = "rk__kana";
    top.textContent = kana;
    const bottom = document.createElement("span");
    bottom.className = "rk__keys";
    bottom.textContent = keys;
    el.append(top, bottom);
    return el;
  };
  const cells = committed.map((seg) => cell(seg.kana, seg.keys));
  if (pending) cells.push(cell("\u00a0", pending, " rk--pending"));
  elements.typedPreview.replaceChildren(...cells);
}

export function updateTypedPreview(text) {
  elements.typedPreview.innerHTML = renderColoredWord(text);
}

export function clearTypedPreview() {
  elements.typedPreview.innerHTML = "";
}

// いま苦手な語: 「最後に思い出せなかったまま」の語（単語帳・カテゴリ別と同じ定義 = classifyWord が weak）。
// 覚えた単語帳（覚えた・習得）とは排他。思い出せなかった回数が多い順に 5 語、1 語 1 行
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