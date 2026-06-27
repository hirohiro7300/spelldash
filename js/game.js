import { words } from "./words.js";
import { getWordStats, getBestScore, saveBestScore } from "./storage.js";
import { recordPlay, recordCorrect, recordMiss } from "./stats.js";
import {
  elements,
  showMessage,
  showHiddenWordText,
  showColoredAnswer,
  updateTypedPreview,
  clearTypedPreview,
  renderWeakWords
} from "./ui.js";

let currentWord = null;
let currentIndex = 0;
let score = 0;
let miss = 0;
let time = 60;
let isPlaying = false;
let timer = null;
let correctChars = 0;
let hasMissedCurrentWord = false;
let startTime = null;

export function startGame() {
  if (isPlaying) return;

  isPlaying = true;
  score = 0;
  miss = 0;
  time = 60;
  correctChars = 0;
  startTime = Date.now();

  elements.input.disabled = false;
  elements.input.value = "";
  elements.input.focus();
  clearTypedPreview();

  elements.score.textContent = score;
  elements.miss.textContent = miss;
  elements.time.textContent = time;
  elements.typeSpeed.textContent = "0.0";

  showMessage("日本語訳を見てスペルを入力");
  setNewWord();

  timer = setInterval(() => {
    time--;
    elements.time.textContent = time;
    updateTypeSpeed();

    if (time <= 0) {
      endGame();
    }
  }, 1000);
}

export function restartGame() {
  clearInterval(timer);
  isPlaying = false;
  startGame();
}

export function handleKeydown(event) {
  if (event.key === "Enter" && !isPlaying) {
    startGame();
    return;
  }

  if (!isPlaying || !currentWord) return;
  if (event.key.length !== 1) return;

  event.preventDefault();

  const expectedChar = currentWord.en[currentIndex];
  const typedChar = event.key.toLowerCase();

  if (typedChar === expectedChar) {
    handleCorrectChar(expectedChar);
  } else {
    handleMiss();
  }
}

function handleCorrectChar(expectedChar) {
  elements.input.value += expectedChar;
  updateTypedPreview(elements.input.value);

  currentIndex++;
  correctChars++;
  updateTypeSpeed();

  if (currentIndex === currentWord.en.length) {
    score++;
    elements.score.textContent = score;

    recordCorrect(currentWord.en, !hasMissedCurrentWord);
    showMessage("Good!", "correct");

    setTimeout(setNewWord, 250);
  }
}

function handleMiss() {
  miss++;
  elements.miss.textContent = miss;
  hasMissedCurrentWord = true;

  showColoredAnswer(currentWord.en);
  recordMiss(currentWord.en);
  showMessage("Miss! スペルを表示しました", "wrong");
}

function setNewWord() {
  currentWord = chooseWord();
  currentIndex = 0;
  hasMissedCurrentWord = false;

  elements.japanese.textContent = currentWord.ja;
  showHiddenWordText("スペルはまだ非表示");

  elements.input.value = "";
  clearTypedPreview();

  recordPlay(currentWord.en);
}

function chooseWord() {
  const stats = getWordStats();

  const weightedWords = words.flatMap((word) => {
    const data = stats[word.en];
    let weight = 3;

    if (data) {
      weight += data.missCount * 3;

      const accuracy = data.correctCount / Math.max(data.playCount, 1);
      if (accuracy < 0.5) weight += 5;
      if (data.mastered) weight = 1;
    }

    return Array(weight).fill(word);
  });

  let selected = weightedWords[Math.floor(Math.random() * weightedWords.length)];

  if (currentWord && selected.en === currentWord.en && words.length > 1) {
    selected = words.find((word) => word.en !== currentWord.en);
  }

  return selected;
}

function endGame() {
  clearInterval(timer);
  isPlaying = false;
  elements.input.disabled = true;

  saveBestScore(score);
  elements.bestScore.textContent = getBestScore();
  renderWeakWords();

  showMessage(`終了！スコア ${score} / 平均 ${elements.typeSpeed.textContent}打/秒`, "finished");
}

function updateTypeSpeed() {
  if (!startTime) return;

  const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
  const speed = correctChars / elapsedSeconds;

  elements.typeSpeed.textContent = speed.toFixed(1);
}