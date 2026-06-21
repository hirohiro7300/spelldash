const words = [
  { en: "apple", ja: "りんご", level: "easy" },
  { en: "book", ja: "本", level: "easy" },
  { en: "school", ja: "学校", level: "easy" },
  { en: "water", ja: "水", level: "easy" },
  { en: "music", ja: "音楽", level: "easy" },
  { en: "family", ja: "家族", level: "easy" },
  { en: "friend", ja: "友達", level: "easy" },
  { en: "morning", ja: "朝", level: "easy" },
  { en: "night", ja: "夜", level: "easy" },
  { en: "happy", ja: "幸せな", level: "easy" },
  { en: "beautiful", ja: "美しい", level: "normal" },
  { en: "important", ja: "重要な", level: "normal" },
  { en: "challenge", ja: "挑戦", level: "normal" },
  { en: "future", ja: "未来", level: "normal" },
  { en: "business", ja: "事業", level: "normal" },
  { en: "customer", ja: "顧客", level: "normal" },
  { en: "marketing", ja: "マーケティング", level: "normal" },
  { en: "develop", ja: "発展させる", level: "normal" },
  { en: "improve", ja: "改善する", level: "normal" },
  { en: "success", ja: "成功", level: "normal" },
  { en: "strategy", ja: "戦略", level: "hard" },
  { en: "negotiate", ja: "交渉する", level: "hard" },
  { en: "efficient", ja: "効率的な", level: "hard" },
  { en: "revenue", ja: "収益", level: "hard" },
  { en: "investment", ja: "投資", level: "hard" },
  { en: "analyze", ja: "分析する", level: "hard" },
  { en: "growth", ja: "成長", level: "hard" },
  { en: "launch", ja: "公開する", level: "hard" },
  { en: "product", ja: "製品", level: "hard" },
  { en: "service", ja: "サービス", level: "hard" }
];

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

const timeElement = document.getElementById("time");
const scoreElement = document.getElementById("score");
const missElement = document.getElementById("miss");
const typeSpeedElement = document.getElementById("typeSpeed");
const bestScoreElement = document.getElementById("bestScore");
const japaneseElement = document.getElementById("japanese");
const wordElement = document.getElementById("word");
const inputElement = document.getElementById("input");
const messageElement = document.getElementById("message");
const typedPreviewElement = document.getElementById("typedPreview");
const restartButton = document.getElementById("restart");
const weakWordsElement = document.getElementById("weakWords");

const STORAGE_KEY = "spelldash_word_stats";
const BEST_SCORE_KEY = "spelldash_best_score";

const letterColors = {
  a: "#ef4444",
  b: "#f97316",
  c: "#f59e0b",
  d: "#eab308",
  e: "#84cc16",
  f: "#22c55e",
  g: "#10b981",
  h: "#14b8a6",
  i: "#06b6d4",
  j: "#0ea5e9",
  k: "#3b82f6",
  l: "#6366f1",
  m: "#8b5cf6",
  n: "#a855f7",
  o: "#d946ef",
  p: "#ec4899",
  q: "#f43f5e",
  r: "#fb7185",
  s: "#fdba74",
  t: "#fde047",
  u: "#bef264",
  v: "#86efac",
  w: "#67e8f9",
  x: "#93c5fd",
  y: "#c4b5fd",
  z: "#f0abfc"
};
function getWordStats() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
}

function saveWordStats(stats) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

function getBestScore() {
  return Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
}

function saveBestScore(newScore) {
  const best = getBestScore();

  if (newScore > best) {
    localStorage.setItem(BEST_SCORE_KEY, String(newScore));
  }
}

function initializeDisplay() {
  bestScoreElement.textContent = getBestScore();
  renderWeakWords();
}

function showMessage(text, type = "") {
  messageElement.textContent = text;
  messageElement.className = `message ${type}`;
}

function renderColoredWord(word) {
  return word
    .split("")
    .map((letter) => {
      const color = letterColors[letter.toLowerCase()] || "#facc15";
      return `<span style="color: ${color};">${letter}</span>`;
    })
    .join("");
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

function setNewWord() {
  currentWord = chooseWord();
  currentIndex = 0;
  hasMissedCurrentWord = false;

  japaneseElement.textContent = currentWord.ja;
  wordElement.textContent = "スペルはまだ非表示";
  wordElement.classList.add("hidden");
  inputElement.value = "";
  typedPreviewElement.innerHTML = "";
  recordPlay(currentWord.en);
}

function recordPlay(word) {
  const stats = getWordStats();

  if (!stats[word]) {
    stats[word] = {
      playCount: 0,
      correctCount: 0,
      missCount: 0,
      cleanCorrectStreak: 0,
      mastered: false,
      masteredAt: null
    };
  }

  stats[word].playCount += 1;
  saveWordStats(stats);
}

function recordCorrect(word, wasClean) {
  const stats = getWordStats();

  if (!stats[word]) return;

  stats[word].correctCount += 1;

  if (wasClean) {
    stats[word].cleanCorrectStreak += 1;

    if (stats[word].cleanCorrectStreak >= 10) {
      stats[word].mastered = true;
      stats[word].masteredAt = new Date().toISOString();
    }
  } else {
    stats[word].cleanCorrectStreak = 0;
  }

  saveWordStats(stats);
}

function recordMiss(word) {
  const stats = getWordStats();

  if (!stats[word]) return;

  stats[word].missCount += 1;
  stats[word].cleanCorrectStreak = 0;
  stats[word].mastered = false;

  saveWordStats(stats);
}

function startGame() {
  if (isPlaying) return;

  isPlaying = true;
  score = 0;
  miss = 0;
  time = 60;
  correctChars = 0;
  startTime = Date.now();

  inputElement.disabled = false;
  inputElement.value = "";
  inputElement.focus();
  typedPreviewElement.innerHTML = "";

  scoreElement.textContent = score;
  missElement.textContent = miss;
  timeElement.textContent = time;
  typeSpeedElement.textContent = "0.0";

  showMessage("日本語訳を見てスペルを入力", "");
  setNewWord();

  timer = setInterval(() => {
    time--;
    timeElement.textContent = time;
    updateTypeSpeed();

    if (time <= 0) {
      endGame();
    }
  }, 1000);
}

function endGame() {
  clearInterval(timer);
  isPlaying = false;
  inputElement.disabled = true;

  saveBestScore(score);
  bestScoreElement.textContent = getBestScore();
  renderWeakWords();

  showMessage(`終了！スコア ${score} / 平均 ${typeSpeedElement.textContent}打/秒`, "finished");
}

function updateTypeSpeed() {
  if (!startTime) return;

  const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
  const speed = correctChars / elapsedSeconds;

  typeSpeedElement.textContent = speed.toFixed(1);
}

function renderWeakWords() {
  const stats = getWordStats();

  const weakWords = Object.entries(stats)
    .filter(([, data]) => data.missCount > 0)
    .sort((a, b) => b[1].missCount - a[1].missCount)
    .slice(0, 5);

  if (weakWords.length === 0) {
    weakWordsElement.textContent = "まだ苦手単語はありません。";
    return;
  }

  weakWordsElement.innerHTML = `
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

inputElement.addEventListener("keydown", (event) => {
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
    inputElement.value += expectedChar;
    typedPreviewElement.innerHTML = renderColoredWord(inputElement.value);
    currentIndex++;
    correctChars++;
    updateTypeSpeed();

    if (currentIndex === currentWord.en.length) {
      score++;
      scoreElement.textContent = score;

      recordCorrect(currentWord.en, !hasMissedCurrentWord);
      showMessage("Good!", "correct");

      setTimeout(setNewWord, 250);
    }
  } else {
    miss++;
    missElement.textContent = miss;
    hasMissedCurrentWord = true;

    wordElement.innerHTML = renderColoredWord(currentWord.en);
    recordMiss(currentWord.en);
    showMessage("Miss! スペルを表示しました", "wrong");
  }
});

restartButton.addEventListener("click", () => {
  clearInterval(timer);
  startGame();
});

initializeDisplay();