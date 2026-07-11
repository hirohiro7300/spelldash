import { getWordsByCategory, findWord } from "./wordStore.js";
import { getWordStats, getBestScore, saveBestScore, recordTypingSession } from "./storage.js";
import {
  recordPlay,
  recordCorrect,
  recordTypingMiss,
  recordRecallFail,
  recordRecallSuccess
} from "./stats.js";
import {
  startStudyQueue,
  nextStudyWordId,
  onRecallFail as queueRecallFail,
  onRecallSuccess as queueRecallSuccess,
  claimPracticeXp,
  isRecalledToday
} from "./studyQueue.js";
import { REPEAT_SUCCESS_XP } from "./studyConfig.js";
import {
  renderStudyQueue,
  updateRecalledToday,
  playRecallSuccessEffect,
  playRecallFailEffect
} from "./studyQueueUi.js";
import { addXp, updateStreak } from "./level.js";
import { renderLevelBar, playLevelUpEffect } from "./levelUi.js";
import { markMissionWord, isMissionWordPending, renderMission } from "./mission.js";
import { pushSync, recordPlaySession } from "./sync.js";
import { speak, autoSpeak } from "./audio.js";
import {
  elements,
  showMessage,
  showHiddenWordText,
  showColoredAnswer,
  updateTypedPreview,
  clearTypedPreview,
  updateCombo
} from "./ui.js";

const MODE_KEY = "spelldash_mode";

let mode = localStorage.getItem(MODE_KEY) || "study";
let currentWord = null;
let currentIndex = 0;
let score = 0;
let typingMissCount = 0;
let recallFailCount = 0;
let time = 60;
let isPlaying = false;
let timer = null;
let correctChars = 0;
let hasMissedCurrentWord = false;
let isRevealed = false;
let startTime = null;
let combo = 0;
let gainedXp = 0;
let activeCategory = "all";

export function setActiveCategory(categoryId) {
  activeCategory = categoryId;
}

export function isGamePlaying() {
  return isPlaying;
}

export function getMode() {
  return mode;
}

let modeInitialized = false;

// Study / Challenge の切り替え。プレイ中なら中断する
export function setMode(newMode) {
  if (mode === newMode && modeInitialized) return;
  modeInitialized = true;

  mode = newMode;
  stopGame();
  localStorage.setItem(MODE_KEY, newMode);

  document.body.classList.toggle("mode-study", mode === "study");

  document.querySelectorAll(".mode-switch__btn").forEach((btn) => {
    btn.classList.toggle("mode-switch__btn--active", btn.dataset.mode === mode);
  });

  showIdleMessage();
}

function showIdleMessage() {
  if (mode === "study") {
    showMessage("Enterで開始。分からない単語はEnterで答えを見る");
  } else {
    showMessage("Enterで開始（60秒チャレンジ）");
  }
}

export function stopGame() {
  clearInterval(timer);
  isPlaying = false;
  currentWord = null;
  elements.japanese.textContent = mode === "study" ? "Study Mode" : "Challenge Mode";
  showHiddenWordText("");
  updateCombo(0);
  renderStudyQueue(false);
}

export function startGame() {
  if (isPlaying) return;

  if (getWordsByCategory(activeCategory).length === 0) {
    showMessage("単語データを読み込み中です…");
    return;
  }

  isPlaying = true;
  score = 0;
  typingMissCount = 0;
  recallFailCount = 0;
  time = 60;
  correctChars = 0;
  combo = 0;
  gainedXp = 0;
  startTime = Date.now();
  updateCombo(0);

  elements.input.disabled = false;
  elements.input.value = "";
  elements.input.focus();
  clearTypedPreview();

  elements.score.textContent = score;
  elements.miss.textContent = typingMissCount;
  if (elements.recallFail) elements.recallFail.textContent = recallFailCount;
  elements.time.textContent = time;
  elements.typeSpeed.textContent = "0.0";

  showMessage(
    mode === "study"
      ? "思い出してタイプ。分からなければEnter"
      : "日本語訳を見てスペルを入力"
  );

  // Study: Recall Loopキューを構築（Unresolved → Mission Review → 復習期限 → Mission New → 通常）
  if (mode === "study") {
    startStudyQueue(activeCategory);
    updateRecalledToday();
  }

  setNewWord();

  // タイマーはChallengeのみ
  if (mode === "challenge") {
    timer = setInterval(() => {
      time--;
      elements.time.textContent = time;
      updateTypeSpeed();

      if (time <= 0) {
        endChallenge();
      }
    }, 1000);
  }
}

export function restartGame() {
  clearInterval(timer);
  isPlaying = false;
  startGame();
}

export function handleKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();

    if (!isPlaying) {
      startGame();
      return;
    }

    // Enter = 「わからない」。1回目で答え表示、2回目で次へ
    if (!isRevealed) {
      revealAnswer();
    } else {
      setNewWord();
      showMessage(mode === "study" ? "思い出してタイプ。分からなければEnter" : "");
    }
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
    handleTypingMiss();
  }
}

// Enter1回目: 思い出せなかった → 答えを表示（recallFailとして記録）
function revealAnswer() {
  isRevealed = true;
  recallFailCount++;
  if (elements.recallFail) elements.recallFail.textContent = recallFailCount;

  recordRecallFail(currentWord.id);

  // Study: Unresolved（赤）としてキューへ戻す。数問後に再出題される
  if (mode === "study") {
    queueRecallFail(currentWord.id);
    playRecallFailEffect();
    renderStudyQueue(true);
  }

  combo = 0;
  updateCombo(0);

  showColoredAnswer(currentWord.en);

  // 発音: autoなら1回再生。スピーカーボタンも表示
  autoSpeak(currentWord.en);
  if (elements.speakButton) {
    elements.speakButton.hidden = false;
  }

  // 頭から打ち直して練習できるようにリセット
  currentIndex = 0;
  elements.input.value = "";
  clearTypedPreview();

  showMessage("答えを表示。入力して練習 or Enterで次へ", "revealed");
}

export function speakCurrentWord() {
  if (currentWord) {
    speak(currentWord.en);
  }
}

function handleCorrectChar(expectedChar) {
  elements.input.value += expectedChar;
  updateTypedPreview(elements.input.value);

  currentIndex++;
  correctChars++;
  updateTypeSpeed();

  if (currentIndex === currentWord.en.length) {
    completeWord();
  }
}

let studyWordsSinceSync = 0;

function completeWord() {
  score++;
  elements.score.textContent = score;

  // Studyは終了イベントがないため、10語ごとにクラウド同期
  if (mode === "study") {
    studyWordsSinceSync++;
    if (studyWordsSinceSync >= 10) {
      studyWordsSinceSync = 0;
      pushSync();
    }
  }

  // clean = 思い出せて、かつ打ち間違いもなし
  const isClean = !hasMissedCurrentWord && !isRevealed;

  // 当日初の自力正解かどうか（XPと学習ループの判定に使う。記録前に見る）
  const firstRecallToday = !isRecalledToday(getWordStats()[currentWord.id]);

  recordCorrect(currentWord.id, isClean);

  // 答えを見ずに正解 = 自力で思い出せた（打ち間違いは許容）
  // ※答え表示後の入力練習では lastRecallSuccessAt を更新しない
  let loopResult = null;
  if (!isRevealed) {
    recordRecallSuccess(currentWord.id);

    if (mode === "study") {
      loopResult = queueRecallSuccess(currentWord.id);
      playRecallSuccessEffect();
      updateRecalledToday();
    }
  }

  if (isClean) {
    combo++;
  }
  updateCombo(combo);

  // XP: 答えを見た後の練習は+5（Studyでは同一単語につきセッション1回まで）。
  // 自力正解は 基本10+クリーン5+コンボ最大10。
  // ただしStudyでの同日反復（2回目以降の自力正解）は少額XP（反復の目的は定着でありXP稼ぎではない）
  let wordXp;
  if (isRevealed) {
    wordXp = mode === "study" ? (claimPracticeXp(currentWord.id) ? 5 : 0) : 5;
  } else if (mode === "study" && !firstRecallToday) {
    wordXp = REPEAT_SUCCESS_XP;
  } else {
    wordXp = 10 + (isClean ? 5 : 0) + Math.min(combo, 10);
  }
  let earned = wordXp;

  const missionResult = markMissionWord(currentWord.id);
  earned += missionResult.bonusXp;
  renderMission();

  if (mode === "study") {
    applyStudyXp(earned, missionResult, loopResult);
  } else {
    gainedXp += earned;

    if (missionResult.justCompleted) {
      showMessage(`MISSION COMPLETE +${missionResult.bonusXp} XP`, "correct");
    } else {
      showMessage(`Good! +${wordXp} XP`, "correct");
    }
  }

  setTimeout(setNewWord, 250);
}

// Studyモードは1語ごとに即XP反映（セッションの「終了」がないため）
function applyStudyXp(earned, missionResult, loopResult) {
  const streak = updateStreak();
  if (streak.isFirstToday) {
    earned += 50;
  }

  const result = addXp(earned);
  renderLevelBar();

  if (result.leveledUp) {
    playLevelUpEffect();
    showMessage(`🎉 レベルアップ！ Lv.${result.after.level}「${result.after.title}」`, "finished");
    return;
  }

  if (missionResult.justCompleted) {
    showMessage(`MISSION COMPLETE +${missionResult.bonusXp} XP`, "correct");
    return;
  }

  // New単語を今日4回思い出せた → 静かに定着を伝える
  if (loopResult?.secured) {
    showMessage(`今日定着 ✓ もう今日は出ません +${earned} XP`, "correct");
    return;
  }

  showMessage(earned > 0 ? `Good! +${earned} XP` : "Good!", "correct");
}

// 打ち間違い: 答えは表示しない（覚えていたかどうかとは別のデータとして記録）
function handleTypingMiss() {
  typingMissCount++;
  elements.miss.textContent = typingMissCount;
  hasMissedCurrentWord = true;
  combo = 0;
  updateCombo(0);

  recordTypingMiss(currentWord.id);
  showMessage("Miss!", "wrong");
}

function setNewWord() {
  // Study: Recall Loopキューから取り出す / Challenge: 従来の重み付き抽選
  if (mode === "study") {
    const wordId = nextStudyWordId();
    currentWord = (wordId && findWord(wordId)) || chooseWord();
    renderStudyQueue(true);
  } else {
    currentWord = chooseWord();
  }

  currentIndex = 0;
  hasMissedCurrentWord = false;
  isRevealed = false;

  elements.japanese.textContent = currentWord.ja;
  showHiddenWordText("分からないときは Enter で答えを表示");
  if (elements.speakButton) {
    elements.speakButton.hidden = true;
  }

  elements.input.value = "";
  clearTypedPreview();

  recordPlay(currentWord.id);
}

function chooseWord() {
  const stats = getWordStats();
  const words = getWordsByCategory(activeCategory);

  const weightedWords = words.flatMap((word) => {
    const data = stats[word.id];
    let weight = 3;

    if (data) {
      weight += data.missCount * 3;

      const accuracy = data.correctCount / Math.max(data.playCount, 1);
      if (accuracy < 0.5) weight += 5;
      if (data.mastered) weight = 1;
    }

    // 今日のミッション対象は優先的に出題（遊んでいるだけで達成できる）
    if (isMissionWordPending(word.id)) {
      weight += 8;
    }

    return Array(weight).fill(word);
  });

  let selected = weightedWords[Math.floor(Math.random() * weightedWords.length)];

  if (currentWord && selected.id === currentWord.id && words.length > 1) {
    selected = words.find((word) => word.id !== currentWord.id);
  }

  return selected;
}

function endChallenge() {
  clearInterval(timer);
  isPlaying = false;
  elements.input.disabled = true;

  const elapsedSeconds = startTime ? (Date.now() - startTime) / 1000 : 0;
  const speed = elapsedSeconds > 0 ? correctChars / elapsedSeconds : 0;

  recordTypingSession({
    correctChars,
    missChars: typingMissCount,
    seconds: elapsedSeconds,
    speed
  });

  // クラウド同期＋プレイ履歴（未ログインなら何もしない）
  recordPlaySession({
    mode: "challenge",
    score,
    typingSpeed: Math.round(speed * 10) / 10,
    typingMiss: typingMissCount,
    recallFail: recallFailCount,
    durationSeconds: Math.round(elapsedSeconds)
  });
  pushSync();

  saveBestScore(score);
  elements.bestScore.textContent = getBestScore();
  updateCombo(0);

  // 今日最初のプレイならストリークボーナス
  const streak = updateStreak();
  let bonusText = "";

  if (streak.isFirstToday) {
    gainedXp += 50;
    bonusText = `（今日の初プレイ +50 XP / ${streak.current}日連続）`;
  }

  const result = addXp(gainedXp);
  renderLevelBar();

  if (result.leveledUp) {
    playLevelUpEffect();
    showMessage(
      `🎉 レベルアップ！ Lv.${result.after.level}「${result.after.title}」 +${gainedXp} XP`,
      "finished"
    );
    return;
  }

  showMessage(`終了！スコア ${score} / +${gainedXp} XP ${bonusText}`, "finished");
}

function updateTypeSpeed() {
  if (!startTime) return;

  const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
  const speed = correctChars / elapsedSeconds;

  elements.typeSpeed.textContent = speed.toFixed(1);
}
