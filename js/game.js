import { getWordsByCategory, findWord } from "./wordStore.js";
import { hasumiResultLine, hasumiSetLine, hasumiLearnedLine, hasumiBubbleHtml, renderHasumiHome } from "./hasumi.js";
import { historyDotsHtml } from "./learnedWords.js";
import { getSetSize, markDailySetDone, getSetsToday } from "./dailySet.js";
import { renderTodayCta } from "./todayCta.js";
import { markActiveToday, recordGrowthSnapshot } from "./growthLog.js";
import { computeCategoryProgress } from "./categoryProgress.js";
import { startBgm, stopBgm, setBgmIntensity } from "./bgm.js";
import { renderLearnedCard } from "./learnedCard.js";
import {
  getWordStats,
  getBestScore,
  saveBestScore,
  recordTypingSession,
  appendSessionLog
} from "./storage.js";
import {
  recordPlay,
  recordCorrect,
  recordTypingMiss,
  recordRecallFail,
  recordRecallSuccess,
  isReviewAttempt,
  localDateString
} from "./stats.js";
import {
  startStudyQueue,
  nextStudyWordId,
  onRecallFail as queueRecallFail,
  onRecallSuccess as queueRecallSuccess,
  claimPracticeXp,
  isRecalledToday,
  isWeakOnlyMode,
  isUnresolved,
  isLearningToday,
  isReviewDue,
  getSessionReviewCount,
  getDueReviewCount,
  startRetryQueue,
  isPlacementRun,
  getQueueComposition
} from "./studyQueue.js";
import { getWeekGoal, getActiveDaysThisWeek } from "./growthLog.js";
import { canInstall, promptInstall } from "./installPrompt.js";
import { REPEAT_SUCCESS_XP, NEW_WORD_DAILY_SUCCESS_TARGET } from "./studyConfig.js";
import {
  renderStudyQueue,
  updateRecalledToday,
  playRecallSuccessEffect,
  playRecallFailEffect
} from "./studyQueueUi.js";
import { addXp, updateStreak } from "./level.js";
import { renderLevelBar, playLevelUpEffect } from "./levelUi.js";
import { renderStreakCard } from "./streakUi.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { markMissionWord, isMissionWordPending, renderMission } from "./mission.js";
import {
  getDailyWords,
  isDailyPlayedToday,
  recordDailyResult,
  renderDailyCard,
  shareDailyResult,
  DAILY_BONUS_XP
} from "./dailyChallenge.js";
import { submitDailyScore } from "./dailyRank.js";
import {
  sfxCorrect,
  sfxSoftCorrect,
  sfxMiss,
  sfxReveal,
  sfxLevelUp,
  sfxComplete,
  sfxSparkle
} from "./sfx.js";
import { bumpActivity, markDailyDone } from "./activity.js";
import { allowedWordLevels, filterByAllowedLevels, unlockNoteForLevel, consumeBoostNote, consumePlacementNote } from "./difficulty.js";
import { pushSync, recordPlaySession } from "./sync.js";
import { speak, autoSpeak, speakOnCorrect } from "./audio.js";
import { getNote, setNote, escapeHtml, NOTE_MAX_LENGTH } from "./wordNotes.js";
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

// デバッグ用: ?t=10 でChallenge/Dailyの時間を短縮できる（battle.htmlと同じ流儀）
const durationOverride = Number(new URLSearchParams(location.search).get("t")) || null;
const CHALLENGE_SECONDS = durationOverride ?? 60;

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

// 今日のセット（Study）: 自力で思い出せたユニーク語を数え、規定数で完了
let setRecalled = new Set();
let setFailed = new Set();
let setLearnEvents = new Map(); // id -> "learned" | "recovered"（完了パネルで語を見せる）
let setNewCount = 0;
let setReviewCount = 0;
let setCompletePending = false;
let currentWordKind = ""; // new / review / weak / repeat / ""
let wordSerial = 0; // setNewWordごとに増える。正解直後の二重進行防止に使う

// ヒント（Study）: 迷ったら次の1文字だけ見せる。見た時点で「自力」ではなくなる（×扱い）
// 「全く出てこない」と「見れば分かる」の間を埋め、数問後の「思い出せた！」につなげる
const HINT_DELAY_MS = Number(new URLSearchParams(location.search).get("hintms")) || 7000;
const LEECH_FAILS = 4; // これ以上思い出せていない語は「難敵」
let hintUsed = false;
let hintTimer = null;
let retryIds = null; // 「思い出せなかった語だけもう1周」中はその語のID配列

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
  document.body.classList.remove("is-playing");
  stopBgm();
  currentWord = null;
  dailyRun = null; // 中断したDailyはロックせず、カードからやり直せる
  elements.japanese.textContent = mode === "study" ? "Study Mode" : "Challenge Mode";
  showHiddenWordText("");
  updateCombo(0);
  updateBigTimer();
  renderPlayScore();
  hideResultPanel();
  renderStudyQueue(false);
  renderSetProgress();
  hideHint();
  renderWordNote(null);
  const meta = document.getElementById("wordMeta");
  if (meta) meta.textContent = "";
}

// ===== Daily Dash =====
// 日替わり固定セットを順番に出題する60秒チャレンジ。完走でその日はロック
let dailyRun = null;

export function startDailyGame() {
  if (isDailyPlayedToday()) return false;

  setMode("challenge");
  stopGame(); // 通常Challengeのプレイ中でも確実に仕切り直す（dailyRunはこの後に設定）
  dailyRun = { words: getDailyWords(), index: 0, emoji: [] };
  startGame();
  return true;
}

export function startGame(options = {}) {
  if (isPlaying) return;
  const retry = Array.isArray(options.retry) && options.retry.length > 0 ? options.retry : null;
  let composition = null;

  if (getWordsByCategory(activeCategory).length === 0) {
    showMessage(
      activeCategory === "my"
        ? "マイ単語帳はまだ空です。学習データ → マイ単語帳 から追加できます"
        : "単語データを読み込み中です…"
    );
    return;
  }

  isPlaying = true;
  // フォーカスモード: 時間制ラン中はスマホで周辺UIを畳む（1画面1目的）。
  // Studyは終了の概念がないため対象外（モード切替手段を奪わない）
  document.body.classList.toggle("is-playing", mode === "challenge");
  if (mode === "challenge") startBgm(); // 時間制ランのみBGM（Studyは静かに集中）
  hideResultPanel();
  score = 0;
  typingMissCount = 0;
  recallFailCount = 0;
  time = CHALLENGE_SECONDS;
  if (dailyRun) {
    // 「もう一回」は先頭から（完走前のみ可能）
    dailyRun.index = 0;
    dailyRun.emoji = [];
  }
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
  updateBigTimer();
  renderPlayScore();

  showMessage(
    dailyRun
      ? "⚡ DAILY DASH! 今日の問題は全員共通。60秒で何語打てるか"
      : mode === "study"
        ? "思い出してタイプ。分からなければEnter"
        : "日本語訳を見てスペルを入力"
  );

  // Study: Recall Loopキューを構築（Unresolved → Mission Review → 復習期限 → Mission New → 通常）
  if (mode === "study") {
    retryIds = retry;
    if (retry) startRetryQueue(retry);
    else startStudyQueue(activeCategory);
    composition = getQueueComposition(); // 最初の1語を取り出す前に構成を控える
    updateRecalledToday();
    setRecalled = new Set();
    setFailed = new Set();
    setLearnEvents = new Map();
    setNewCount = 0;
    setReviewCount = 0;
    setCompletePending = false;
    renderSetProgress();
  }

  setNewWord();

  // セットの中身を先に伝える（何をやるか分かってから始める）
  if (mode === "study") {
    if (retry) {
      showMessage(`🔁 思い出せなかった ${retry.length}語 をもう一度。全部自力で打てたら回収完了`, "revealed");
    } else if (isPlacementRun()) {
      showMessage("まず腕試し10語。知ってる語はそのまま打って、知らない語はEnterで答えを見てOK", "revealed");
    } else {
      const c = composition ?? getQueueComposition();
      const parts = [];
      if (c.review > 0) parts.push(`復習 ${c.review}`);
      if (c.weak > 0) parts.push(`苦手 ${c.weak}`);
      if (c.repeat > 0) parts.push(`反復 ${c.repeat}`);
      if (c.fresh > 0) parts.push(`新しい語 ${c.fresh}`);
      if (c.review > 0 || c.weak > 0) {
        showMessage(`${parts.join("・")} からスタート。思い出せるかな？`, "revealed");
      }
    }
  }

  // タイマーはChallengeのみ
  if (mode === "challenge") {
    timer = setInterval(() => {
      time--;
      elements.time.textContent = time;
      updateBigTimer();
      updateTypeSpeed();

      if (time <= 0) {
        endChallenge();
      }
    }, 1000);
  }
}

// カード右上の大型タイマー（Challenge/Dailyプレイ中のみ表示、残り10秒で赤）
function updateBigTimer() {
  const el = document.getElementById("bigTimer");
  if (!el) return;

  const active = isPlaying && mode === "challenge";
  el.hidden = !active;
  if (!active) return;

  el.textContent = time;
  el.classList.toggle("big-timer--danger", time <= 10);
  setBgmIntensity(time <= 10 ? 2 : 1); // 終盤はBGMも前のめりに
}

export function restartGame() {
  clearInterval(timer);
  isPlaying = false;
  startGame();
}

// Enterキー相当の操作（物理キーボード・ソフトキーボード共通）
// 未開始=スタート / プレイ中=「わからない」1回目で答え表示、2回目で次へ
function triggerEnter() {
  if (!isPlaying) {
    startGame();
    return;
  }

  if (!isRevealed) {
    revealAnswer();
  } else {
    // 答えを見た後のスキップ = Dailyでは「打てなかった単語」⬛
    if (dailyRun && mode === "challenge") {
      dailyRun.emoji.push("⬛");
    }
    setNewWord();
    showMessage(mode === "study" ? "思い出してタイプ。分からなければEnter" : "");
  }
}

export function handleKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    triggerEnter();
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

// ===== モバイル（ソフトキーボード/IME）対応 =====
// AndroidのGboard等はkeydownで "Unidentified" しか返さないため、
// inputイベントで入力欄の実際の値を照合する。
// デスクトップではprintableキーをkeydownでpreventDefaultしているので二重処理にならない。

// 日本語IMEの変換中はvalueを触らない（触るとIMEと衝突して入力が壊れる）
let composing = false;

export function handleCompositionStart() {
  composing = true;
}

export function handleCompositionEnd() {
  composing = false;
  if (!isPlaying || !currentWord) return;

  // 確定された文字に日本語等が含まれていたら、受理済み位置へ巻き戻して案内する
  // （かな→ローマ字の復元は不可能なため、打ち直してもらうのが最も安全）
  if (/[^a-z\s]/i.test(elements.input.value)) {
    const prefix = currentWord.en.slice(0, currentIndex);
    elements.input.value = prefix;
    updateTypedPreview(prefix);
    showMessage("キーボードを英字モードにしてね", "wrong");
    return;
  }
  handleTextInput();
}

export function handleTextInput() {
  if (!isPlaying || !currentWord) return;
  if (composing) return; // 変換確定はhandleCompositionEndで処理する

  const word = currentWord.en;
  const accepted = word.slice(0, currentIndex);
  const raw = elements.input.value.toLowerCase().replace(/[^a-z]/g, "");

  if (raw === accepted) return;

  // 削除や予測変換での置き換えは、受理済みの位置へ巻き戻すだけ（ミス扱いしない）
  if (!raw.startsWith(accepted)) {
    elements.input.value = accepted;
    updateTypedPreview(accepted);
    return;
  }

  for (const typedChar of raw.slice(accepted.length)) {
    if (typedChar === word[currentIndex]) {
      const isLastChar = currentIndex + 1 === word.length;
      if (isLastChar) {
        elements.input.value = word;
        updateTypedPreview(word);
      }
      if (acceptChar()) return; // 単語完成。setNewWordが入力欄をリセットする
    } else {
      handleTypingMiss();
      break; // 1イベントにつきミスは1回まで（予測変換の一括挿入対策）
    }
  }

  const prefix = word.slice(0, currentIndex);
  elements.input.value = prefix;
  updateTypedPreview(prefix);
}

// ソフトキーボードのEnter（Go/実行）はkeydownではなくinsertLineBreakとして来る環境がある
export function handleBeforeInput(event) {
  if (event.inputType === "insertLineBreak") {
    event.preventDefault();
    triggerEnter();
  }
}

// 「思い出せなかった」の記録（答え表示・ヒントで共通）。1語につき1回だけ
function markRecallFail() {
  recallFailCount++;
  if (elements.recallFail) elements.recallFail.textContent = recallFailCount;

  recordRecallFail(currentWord.id);

  // Study: Unresolved（赤）としてキューへ戻す。数問後に再出題される
  if (mode === "study") {
    setFailed.add(currentWord.id);
    queueRecallFail(currentWord.id);
    playRecallFailEffect();
    renderStudyQueue(true);
  }

  combo = 0;
  updateCombo(0);
  renderPlayScore();
}

// Enter1回目 or 1ミスタイプ: 不正解 → 答えを表示（recallFailとして記録）
function revealAnswer(fromMiss = false) {
  isRevealed = true;
  hideHint();
  if (!fromMiss) sfxReveal(); // ミス起点ではsfxMissが鳴っているので重ねない

  // ヒントを見た時点で×は記録済み。二重に数えない
  if (!hintUsed) markRecallFail();

  showColoredAnswer(currentWord.en);
  renderWordFamily(currentWord);
  renderWordHistory();
  renderWordNote(currentWord);

  // 発音: autoなら1回再生。スピーカーボタンも表示
  autoSpeak(currentWord.en);
  if (elements.speakButton) {
    elements.speakButton.hidden = false;
  }

  // 頭から打ち直して練習できるようにリセット
  currentIndex = 0;
  elements.input.value = "";
  clearTypedPreview();

  const stat = getWordStats()[currentWord.id];
  const leech = (stat?.recallFail ?? 0) >= LEECH_FAILS;
  showMessage(
    fromMiss
      ? "ミス！正しいスペルを見て打ち直そう"
      : leech
        ? `答えを表示。${stat.recallFail}回目の難敵。覚え方を📝メモしておくと効くよ`
        : "答えを表示。入力して練習 or Enterで次へ",
    fromMiss ? "wrong" : "revealed"
  );
}

// ===== ヒント（Study） =====
function scheduleHint() {
  clearTimeout(hintTimer);
  hintTimer = null;
  if (mode !== "study" || !isPlaying) return;
  hintTimer = setTimeout(() => {
    if (!isPlaying || !currentWord || isRevealed || mode !== "study") return;
    const button = document.getElementById("hintButton");
    if (button) button.hidden = false;
  }, HINT_DELAY_MS);
}

function hideHint() {
  clearTimeout(hintTimer);
  hintTimer = null;
  const button = document.getElementById("hintButton");
  if (button) button.hidden = true;
}

// 次の1文字を見せる（＝その文字を受理する）。最初のヒントで×を記録
export function useHint() {
  if (!isPlaying || !currentWord || isRevealed || mode !== "study") return;

  if (!hintUsed) {
    hintUsed = true;
    hasMissedCurrentWord = true; // クリーン判定からも外す
    markRecallFail();
    renderWordHistory();
    renderWordNote(currentWord);
    sfxReveal();
  }

  const nextChar = currentWord.en[currentIndex];
  const total = currentWord.en.length;
  const shown = currentIndex + 1;
  showHiddenWordText(
    `💡 ${currentWord.en.slice(0, shown)}${"・".repeat(Math.max(0, total - shown))}（${total}文字）`
  );
  showMessage(
    shown === 1
      ? `💡 頭文字は「${nextChar}」。残りを自力で打ってみよう（ヒントを見たので、この語はまた出すね）`
      : `💡 次は「${nextChar}」。続きを打ってみよう`,
    "revealed"
  );

  elements.input.value += nextChar;
  updateTypedPreview(elements.input.value);
  acceptChar();
}

// ===== 自分のメモ（覚え方）: 答え表示・ヒント後に表示＋編集 =====
function renderWordNote(word) {
  const el = document.getElementById("wordNote");
  if (!el) return;
  if (!word || mode !== "study") {
    el.innerHTML = "";
    return;
  }

  const note = getNote(word.id);
  el.innerHTML = note
    ? `<span class="word-note__text">📝 ${escapeHtml(note)}</span><button type="button" class="word-note__edit" id="noteEdit">編集</button>`
    : `<button type="button" class="word-note__edit word-note__edit--add" id="noteEdit">📝 覚え方をメモ</button>`;

  document.getElementById("noteEdit")?.addEventListener("click", () => {
    el.innerHTML = `
      <input type="text" class="note-input" id="noteInput" maxlength="${NOTE_MAX_LENGTH}" placeholder="覚え方（例: nego＝交渉のネゴ）" value="${escapeHtml(note)}" autocomplete="off" />
      <button type="button" class="word-note__save" id="noteSave">保存</button>
    `;
    const input = document.getElementById("noteInput");
    const save = () => {
      setNote(word.id, input.value);
      renderWordNote(word);
      elements.input.focus();
    };
    document.getElementById("noteSave")?.addEventListener("click", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        renderWordNote(word);
        elements.input.focus();
      }
    });
    input.focus();
  });
}

export function speakCurrentWord() {
  if (currentWord) {
    speak(currentWord.en);
  }
}

// 正解時にスコア数字をパルスさせる（気持ちよさの微調整）
function pulseScore() {
  const el = elements.score;
  if (!el) return;
  el.classList.remove("stat-pulse");
  void el.offsetWidth; // アニメーション再トリガー
  el.classList.add("stat-pulse");
}

// Knowledge Map（Phase A）: 答え表示時に派生語ファミリーを1行見せる。
// 「単語は孤立した点ではなく、つながっている」ことの予告編
function renderWordFamily(word) {
  if (!elements.wordFamily) return;

  if (!Array.isArray(word.family) || word.family.length === 0) {
    elements.wordFamily.textContent = "";
    return;
  }

  const names = word.family
    .map((id) => findWord(id))
    .filter(Boolean)
    .map((w) => `${w.en}（${w.ja}）`);

  elements.wordFamily.textContent = names.length
    ? `🔗 同じ仲間: ${names.join(" / ")}`
    : "";
}

function handleCorrectChar(expectedChar) {
  elements.input.value += expectedChar;
  updateTypedPreview(elements.input.value);
  acceptChar();
}

// 1文字受理の共通処理（DOMの入力欄には触れない）。単語完成ならtrueを返す
function acceptChar() {
  currentIndex++;
  correctChars++;
  updateTypeSpeed();

  if (currentIndex === currentWord.en.length) {
    completeWord();
    return true;
  }

  return false;
}

let studyWordsSinceSync = 0;

function completeWord() {
  score++;
  elements.score.textContent = score;
  pulseScore();
  hideHint();

  // 自力 = 答えもヒントも見ていない
  const selfRecall = !isRevealed && !hintUsed;

  if (selfRecall) {
    sfxCorrect(combo);
  } else {
    sfxSoftCorrect();
  }

  // Dailyのシェア用グリッド: 🟩自力正解 🟨答えを見て正解
  if (dailyRun && mode === "challenge") {
    dailyRun.emoji.push(isRevealed ? "🟨" : "🟩");
  }

  // Studyは終了イベントがないため、10語ごとにクラウド同期
  if (mode === "study") {
    studyWordsSinceSync++;
    if (studyWordsSinceSync >= 10) {
      studyWordsSinceSync = 0;
      pushSync();
    }
  }

  // clean = 思い出せて、かつ打ち間違いもなし（ヒント使用は hasMissedCurrentWord=true で除外済み）
  const isClean = !hasMissedCurrentWord && selfRecall;

  // 当日初の自力正解かどうか（XPと学習ループの判定に使う。記録前に見る）
  const prevStat = getWordStats()[currentWord.id];
  const firstRecallToday = !isRecalledToday(prevStat);

  // 学びの瞬間を判定（記録前の状態で）:
  //  learned   = 別の日に思い出せなかった語を、今日自力で思い出せた（学習成立）
  //  recovered = 同じ日の失敗からの回復（Recall Loop）
  //  retained  = 1日以上前に覚えた語を復習で思い出せた（定着）
  //  known     = 初見でノーミス自力正解（もともと知っていた）
  let learnEvent = null;
  if (mode === "study" && selfRecall && prevStat) {
    if (isUnresolved(prevStat)) {
      const failDay = prevStat.lastRecallFailAt ? localDateString(new Date(prevStat.lastRecallFailAt)) : null;
      learnEvent = failDay && failDay !== localDateString() ? "learned" : "recovered";
    } else if (isClean && prevStat.playCount === 1 && (prevStat.recallFail ?? 0) === 0 && !prevStat.lastRecallSuccessAt) {
      learnEvent = "known";
    } else if (isReviewAttempt(prevStat)) {
      learnEvent = "retained";
    }
  }

  recordCorrect(currentWord.id, isClean);

  // 答えを見ずに正解 = 自力で思い出せた（打ち間違いは許容）
  // ※答え表示後の入力練習では lastRecallSuccessAt を更新しない
  let loopResult = null;
  if (selfRecall) {
    recordRecallSuccess(currentWord.id);
    if (mode === "study") bumpActivity("studyCorrect"); // KPI心拍

    if (mode === "study") {
      speakOnCorrect(currentWord.en); // 綴りを打てた直後に音でも確認（設定で切れる）
      loopResult = queueRecallSuccess(currentWord.id);
      playRecallSuccessEffect();
      updateRecalledToday();

      if (learnEvent === "learned" || learnEvent === "recovered") {
        if (!setLearnEvents.has(currentWord.id) || learnEvent === "learned") setLearnEvents.set(currentWord.id, learnEvent);
      }
      renderWordHistory();

      // 今日のセット: 自力正解のユニーク語を数える
      if (!setRecalled.has(currentWord.id)) {
        setRecalled.add(currentWord.id);
        if (currentWordKind === "new") setNewCount++;
        if (currentWordKind === "review") setReviewCount++;
        renderSetProgress();
        if (setRecalled.size >= currentSetSize()) setCompletePending = true;
      }
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
  if (!selfRecall) {
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
    applyStudyXp(earned, missionResult, loopResult, learnEvent);
    if (consumeBoostNote()) {
      setTimeout(() => showMessage("知ってる語が多いみたい。少し難しい単語も混ぜていくね", "revealed"), 1200);
    }
    announcePlacement();
  } else {
    gainedXp += earned;

    if (missionResult.justCompleted) {
      showMessage(`MISSION COMPLETE +${missionResult.bonusXp} XP`, "correct");
    } else {
      showMessage(`Good! +${wordXp} XP`, "correct");
    }
  }

  // Challenge/Daily: 待ち時間ゼロで次の単語へ（60秒×30語で7.5秒あった空白をなくす）。
  // 正解の音・スコアのパルスは非同期で重なるのでテンポを止めない
  if (mode !== "study") {
    renderPlayScore();
    setNewWord();
    return;
  }

  // Study: 正解演出の後に次へ。250ms以内にEnter等で既に進んでいたら二重に進めない
  const serialAtComplete = wordSerial;
  setTimeout(() => {
    if (!isPlaying) return;
    if (mode === "study" && setCompletePending) {
      endStudySession();
      return;
    }
    if (wordSerial !== serialAtComplete) return;
    setNewWord();
  }, 250);
}

// 成長ログ: 覚えた語数のスナップショット（今週+N・30日推移の材料）
function snapshotGrowth() {
  try {
    const all = computeCategoryProgress()[0];
    recordGrowthSnapshot({ learned: all.learned, mastered: all.mastered });
  } catch {
    // ログは装飾
  }
}

// ===== 今日のセット: 進捗と完了 =====
// セットの目標語数（回収モードではその語数）
function currentSetSize() {
  return retryIds ? retryIds.length : getSetSize();
}

function renderSetProgress() {
  const el = document.getElementById("setProgress");
  if (!el) return;
  if (!isPlaying || mode !== "study") {
    el.innerHTML = "";
    return;
  }
  const size = currentSetSize();
  const done = Math.min(setRecalled.size, size);
  el.innerHTML = `
    <span class="set-progress__label">${retryIds ? "もう一度" : "今日のセット"}</span>
    <span class="set-progress__count"><b>${done}</b> / ${size}</span>
    <span class="set-progress__bar"><i style="width:${(done / size) * 100}%"></i></span>
  `;
}

// ===== 「覚えた！」の瞬間 =====
// 別の日に思い出せなかった語を今日自力で思い出せた＝学習成立。ここだけは大きく祝う
function celebrateLearned(word, earned) {
  sfxSparkle();
  sfxComplete();

  const card = document.getElementById("gameCard");
  if (card) {
    card.classList.remove("game-card--learned");
    void card.offsetWidth;
    card.classList.add("game-card--learned");
    const stamp = document.createElement("div");
    stamp.className = "learn-stamp";
    stamp.textContent = "覚えた！";
    card.appendChild(stamp);
    setTimeout(() => stamp.remove(), 1400);
  }

  showMessage(`✨ 覚えた！ ${word.en}（${word.ja}）${earned > 0 ? `  +${earned} XP` : ""}`, "learned");

  const toast = document.getElementById("learnToast");
  if (toast) {
    toast.innerHTML = hasumiBubbleHtml(hasumiLearnedLine(word.en), "hasumi--result");
    toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.hidden = true;
    }, 4500);
  }
}

// 単語の履歴ドット（× × ○ ○）を単語の下に出す（Studyのみ）
function renderWordHistory() {
  const el = document.getElementById("wordHistory");
  if (!el) return;
  if (mode !== "study" || !currentWord) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = historyDotsHtml(getWordStats()[currentWord.id]);
}

// Challenge/Dailyプレイ中: カード内にスコアとコンボを常設（統計カードは視界外のため）
function renderPlayScore() {
  const el = document.getElementById("playScore");
  if (!el) return;
  const active = isPlaying && mode === "challenge";
  el.hidden = !active;
  if (!active) return;
  const tier = combo >= 20 ? "max" : combo >= 10 ? "blaze" : combo >= 5 ? "hot" : combo >= 2 ? "on" : "";
  el.innerHTML = `
    <span class="play-score__value">${score}</span>
    <span class="play-score__combo ${tier ? `play-score__combo--${tier}` : ""}">${combo >= 2 ? `🔥${combo}` : ""}</span>
  `;
}

// 完了パネル: 数字ではなく語で見せる（覚えた！／思い出せた／思い出せず）
function renderSetWordChips() {
  const chip = (id, cls = "") => {
    const w = findWord(id);
    return w ? `<button type="button" class="word-chip ${cls}" data-speak="${w.en}"><b>${w.en}</b><small>${w.ja}</small></button>` : "";
  };
  const learned = [...setLearnEvents].filter(([, e]) => e === "learned").map(([id]) => id);
  const recovered = [...setLearnEvents].filter(([, e]) => e === "recovered").map(([id]) => id);
  const failed = [...setFailed].filter((id) => !setRecalled.has(id));
  const group = (title, ids, cls) =>
    ids.length ? `<div class="word-chips"><span class="word-chips__title">${title}</span>${ids.map((id) => chip(id, cls)).join("")}</div>` : "";
  return (
    group("✨ 覚えた！（前は出てこなかった語）", learned, "word-chip--learned") +
    group("👍 思い出せた（さっき見た語）", recovered, "word-chip--recovered") +
    group("↻ 思い出せず（また出すね）", failed, "word-chip--failed")
  );
}

// 腕試し（初回10語）の結果を1回だけ伝える。答え表示後にも出るよう、少し遅らせて上書きする
function announcePlacement() {
  const p = consumePlacementNote();
  if (!p) return;
  const line =
    p.boost >= 2
      ? `腕試し: ${p.total}語中 ${p.known}語 知ってた！難しい単語も最初から混ぜていくね`
      : p.boost === 1
        ? `腕試し: ${p.total}語中 ${p.known}語 知ってた。少し難しい単語も混ぜていくね`
        : `腕試し: ${p.total}語中 ${p.known}語 知ってた。まずは基本の単語から一緒に積み上げよう`;
  setTimeout(() => showMessage(`🎯 ${line}`, "revealed"), 1300);
}

function endStudySession() {
  clearInterval(timer);
  isPlaying = false;
  setCompletePending = false;
  currentWord = null;

  const isRetry = !!retryIds;
  retryIds = null;
  const recalled = setRecalled.size;
  const failedIds = [...setFailed].filter((id) => !setRecalled.has(id));
  const failed = failedIds.length;
  const state = isRetry ? { setsToday: getSetsToday() } : markDailySetDone(recalled);
  pushSync();

  elements.japanese.textContent = "Study Mode";
  showHiddenWordText("");
  const meta = document.getElementById("wordMeta");
  if (meta) meta.textContent = "";
  renderStudyQueue(false);
  renderSetProgress();
  renderTodayCta();
  renderLearnedCard();
  renderHasumiHome();

  // 明日までに復習期日が来る語（今日片付けた分は除く）
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(23, 59, 59, 999);
  const dueTomorrow = getDueReviewCount(activeCategory, tomorrow.getTime());

  // 週の目標（学習日数）: ちょうど達成した日は一言添える
  const goal = getWeekGoal();
  const activeDays = getActiveDaysThisWeek();
  const goalLine =
    activeDays >= goal
      ? `<div class="result-panel__goal">🎯 今週の目標 ${goal}日 達成！（${activeDays}日目）</div>`
      : `<div class="result-panel__goal result-panel__goal--progress">今週 ${activeDays} / ${goal}日 ・ 目標まであと${goal - activeDays}日</div>`;

  const panel = document.getElementById("resultPanel");
  if (panel) {
    const hasumiLine = isRetry
      ? failed === 0
        ? { mood: "happy", text: `${recalled}語ぜんぶ回収！さっき出てこなかった語が、もう自分のものだよ！` }
        : { mood: "happy", text: `${recalled}語回収！残りはまた明日、一緒に確認しよう！` }
      : hasumiSetLine({ count: recalled, failed, sets: state.setsToday });
    panel.innerHTML = `
      <div class="result-panel__title">${isRetry ? "🔁 回収完了" : "🎉 今日のセット完了"}</div>
      ${hasumiBubbleHtml(hasumiLine, "hasumi--result")}
      <div class="result-panel__grid">
        <div><span>思い出せた</span><strong>${recalled}語</strong></div>
        ${isRetry ? "" : `<div><span>うち復習</span><strong>${setReviewCount}</strong></div>
        <div><span>新しく覚えた</span><strong>${setNewCount}</strong></div>`}
        <div><span>思い出せず</span><strong>${failed}</strong></div>
        <div><span>明日の復習予定</span><strong>${dueTomorrow}語</strong></div>
      </div>
      ${renderSetWordChips()}
      ${goalLine}
      <div class="result-panel__actions">
        ${failed > 0 ? `<button type="button" class="result-panel__action" id="setRetry">思い出せなかった${failed}語をもう一度</button>` : ""}
        <button type="button" class="result-panel__action${failed > 0 ? " result-panel__action--ghost" : ""}" id="setAgain">もう1セット</button>
        <button type="button" class="result-panel__action result-panel__action--ghost" id="setChallenge">Challengeで腕試し</button>
        ${canInstall() ? `<button type="button" class="result-panel__action result-panel__action--ghost" id="setInstall">📲 ホーム画面に追加</button>` : ""}
      </div>
      <div class="result-panel__tagline">今日も、はちゃんと少しだけ。</div>
    `;
    panel.hidden = false;
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    panel.querySelectorAll("[data-speak]").forEach((chip) => chip.addEventListener("click", () => speak(chip.dataset.speak)));
    document.getElementById("setRetry")?.addEventListener("click", () => {
      clearInterval(timer);
      isPlaying = false;
      startGame({ retry: failedIds });
      elements.input.focus();
    });
    document.getElementById("setInstall")?.addEventListener("click", async (event) => {
      const outcome = await promptInstall();
      event.currentTarget.textContent = outcome === "accepted" ? "✓ 追加しました" : "📲 ホーム画面に追加";
    });
    document.getElementById("setAgain")?.addEventListener("click", () => {
      restartGame();
      elements.input.focus();
    });
    document.getElementById("setChallenge")?.addEventListener("click", () => {
      setMode("challenge");
      startGame();
      elements.input.focus();
    });
  }

  showMessage(isRetry ? `回収完了！${recalled}語をもう一度思い出せた` : `今日のぶん完了！${recalled}語思い出せた`, "finished");
}

// Studyモードは1語ごとに即XP反映（セッションの「終了」がないため）
function applyStudyXp(earned, missionResult, loopResult, learnEvent = null) {
  markActiveToday();
  snapshotGrowth();
  renderLearnedCard(); // 覚えた単語数を即時更新
  const streak = updateStreak();
  if (streak.isFirstToday) {
    earned += 50;
    renderStreakCard();
    renderHeaderStreak();
    renderHasumiHome();
  }

  const result = addXp(earned);
  renderLevelBar();

  // 「覚えた！」は他の何より先に祝う（学習が成立した瞬間）
  if (learnEvent === "learned") {
    celebrateLearned(currentWord, earned);
    return;
  }

  if (result.leveledUp) {
    playLevelUpEffect();
    sfxLevelUp();
    showMessage(
      `🎉 レベルアップ！ Lv.${result.after.level}「${result.after.title}」${unlockNoteForLevel(result.after.level)}`,
      "finished"
    );
    return;
  }

  if (streak.isFirstToday) {
    const shieldNote = streak.earnedShield ? " 🛡️ シールド獲得！" : "";
    if (streak.earnedShield) sfxSparkle();
    showMessage(`🔥 ${streak.current}日連続！ +${earned} XP${shieldNote}`, "correct");
    return;
  }

  if (missionResult.justCompleted) {
    sfxComplete();
    showMessage(`MISSION COMPLETE +${missionResult.bonusXp} XP`, "correct");
    return;
  }

  // New単語を今日4回思い出せた → 静かに定着を伝える
  if (loopResult?.secured) {
    sfxComplete();
    showMessage(`今日定着 ✓ もう今日は出ません +${earned} XP`, "correct");
    return;
  }

  // ヒントを見て打てた: 自力ではないが、次に自力で打てる準備はできた
  if (hintUsed && !isRevealed) {
    showMessage(`💡 ヒントありで打てた。数問後にもう一度、今度は自力で${earned > 0 ? `  +${earned} XP` : ""}`, "revealed");
    return;
  }

  // 自力正解: 学びの種類ごとに違う言葉で（数字より意味）
  if (!isRevealed) {
    const xp = earned > 0 ? `  +${earned} XP` : "";
    const stat = getWordStats()[currentWord.id];
    if (stat?.mastered) {
      sfxComplete();
      showMessage(`🏆 ${currentWord.en} を習得！10回連続で思い出せた${xp}`, "learned");
      return;
    }
    if (learnEvent === "recovered") {
      sfxSparkle();
      showMessage(`👍 思い出せた！ ${currentWord.en} — さっきは出てこなかったのに${xp}`, "correct");
      return;
    }
    if (learnEvent === "retained") {
      const days = stat?.lastReviewAt && stat?.history?.length > 1
        ? Math.max(1, Math.round((Date.now() - Date.parse(stat.history[stat.history.length - 2]?.d ?? stat.lastReviewAt)) / 86400000))
        : null;
      showMessage(`✓ 定着 ${days ? `${days}日ぶりでも` : ""}思い出せた${xp}`, "correct");
      return;
    }
    if (learnEvent === "known") {
      showMessage(`知ってた ✓ ${currentWord.en} は2週間後にもう一度だけ確認するね${xp}`, "correct");
      return;
    }
    const streakCount = stat?.cleanCorrectStreak ?? 0;
    showMessage(`○ 思い出せた${streakCount >= 2 ? `（${streakCount}回目）` : ""}${xp}`, "correct");
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
  sfxMiss();

  recordTypingMiss(currentWord.id);

  // 1回でもミスしたら不正解: スペルを表示して打ち直し。
  // 当てずっぽうでの正解到達は「思い出して打つ」の本質ではない（2026-08-15創業者決定）
  if (!isRevealed) {
    revealAnswer(true);
    return;
  }

  // 答え表示後の練習中のミスは表示のみ
  showMessage("Miss!", "wrong");
}

function setNewWord() {
  wordSerial++;
  // Daily: 固定セットを順番に / Study: Recall Loopキュー / Challenge: 重み付き抽選
  if (dailyRun && mode === "challenge") {
    currentWord = dailyRun.words[dailyRun.index % dailyRun.words.length];
    dailyRun.index++;
  } else if (mode === "study") {
    const wordId = nextStudyWordId();

    // 苦手のみモードで出題が尽きた = 全部クリア。達成感を演出して終了
    if (!wordId && isWeakOnlyMode()) {
      stopGame();
      showMessage("🎉 苦手単語をすべてクリア！明日また確認しよう", "finished");
      return;
    }

    currentWord = (wordId && findWord(wordId)) || chooseWord();
    renderStudyQueue(true);
  } else {
    currentWord = chooseWord();
  }

  currentIndex = 0;
  hasMissedCurrentWord = false;
  isRevealed = false;
  hintUsed = false;
  hideHint();
  renderWordNote(null);

  elements.japanese.textContent = currentWord.ja;
  showHiddenWordText("分からないときは Enter で答えを表示");
  if (elements.speakButton) {
    elements.speakButton.hidden = true;
  }
  if (elements.wordFamily) {
    elements.wordFamily.textContent = "";
  }

  elements.input.value = "";
  clearTypedPreview();

  renderWordMeta(); // recordPlayより前（未プレイ判定のため）
  const hist = document.getElementById("wordHistory");
  if (hist) hist.innerHTML = "";
  recordPlay(currentWord.id);
  scheduleHint();
}

// 単語の状態ラベル（Studyのみ）: 「なぜ今この単語が出たか」を1行で見せる
function renderWordMeta() {
  const el = document.getElementById("wordMeta");
  if (!el) return;
  if (mode !== "study" || !currentWord) {
    el.textContent = "";
    return;
  }

  const stat = getWordStats()[currentWord.id];
  let label = "";
  currentWordKind = "";
  if (!stat || (stat.playCount ?? 0) === 0) {
    label = "✨ 新しい単語";
    currentWordKind = "new";
  } else if (isUnresolved(stat)) {
    const fails = stat.recallFail ?? 0;
    label = fails >= LEECH_FAILS ? `🔥 難敵（${fails}回思い出せていない）今度こそ` : "♻️ もう一度（前回は思い出せなかった）";
    currentWordKind = "weak";
  } else if (isLearningToday(stat)) {
    label = `🔁 今日の反復 ${Math.min((stat.dailyLearningStage ?? 0) + 1, NEW_WORD_DAILY_SUCCESS_TARGET)}/${NEW_WORD_DAILY_SUCCESS_TARGET}`;
    currentWordKind = "repeat";
  } else if (isReviewDue(stat)) {
    currentWordKind = "review";
    const days = stat.lastRecallSuccessAt
      ? Math.floor((Date.now() - Date.parse(stat.lastRecallSuccessAt)) / 86400000)
      : 0;
    label = days >= 1 ? `↻ ${days}日ぶりの復習` : "↻ 復習";
  }
  el.textContent = label;
}

function chooseWord() {
  const stats = getWordStats();
  const allowed = allowedWordLevels();

  // 未プレイの単語はプレイヤーレベルで解放（既習語は常に出題対象）。
  // カテゴリ内に解放難易度が無い場合はfilterByAllowedLevelsが最易難易度で救済
  const pool = getWordsByCategory(activeCategory);
  const played = pool.filter((word) => stats[word.id]);
  const unlocked = filterByAllowedLevels(
    pool.filter((word) => !stats[word.id]),
    allowed
  );
  const words = [...played, ...unlocked];

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
  markActiveToday();
  snapshotGrowth();
  document.body.classList.remove("is-playing");
  stopBgm();
  elements.input.disabled = true;
  updateBigTimer();
  renderPlayScore();

  const isDaily = !!dailyRun;
  const previousBest = getBestScore();

  const elapsedSeconds = startTime ? (Date.now() - startTime) / 1000 : 0;
  const speed = elapsedSeconds > 0 ? correctChars / elapsedSeconds : 0;

  recordTypingSession({
    correctChars,
    missChars: typingMissCount,
    seconds: elapsedSeconds,
    speed
  });

  // スコア推移グラフ用のローカル履歴
  appendSessionLog({
    at: new Date().toISOString(),
    mode: isDaily ? "daily" : "challenge",
    score,
    speed: Math.round(speed * 10) / 10,
    typingMiss: typingMissCount,
    recallFail: recallFailCount
  });

  // クラウド同期＋プレイ履歴（未ログインなら何もしない）
  recordPlaySession({
    mode: isDaily ? "daily" : "challenge",
    score,
    typingSpeed: Math.round(speed * 10) / 10,
    typingMiss: typingMissCount,
    recallFail: recallFailCount,
    durationSeconds: Math.round(elapsedSeconds)
  });
  pushSync();

  // KPI心拍: challenge/daily の完走を記録
  if (isDaily) {
    markDailyDone();
  } else {
    bumpActivity("challengeRuns");
  }

  // Daily完走: 結果を保存してその日はロック＋ボーナスXP
  if (isDaily) {
    gainedXp += DAILY_BONUS_XP;
    recordDailyResult({
      score,
      typingMiss: typingMissCount,
      recallFail: recallFailCount,
      speed: Math.round(speed * 10) / 10,
      emoji: dailyRun.emoji.join("")
    });
    dailyRun = null;
    renderDailyCard();
    // ランキング送信 → 反映後にカードを再描画（未ログイン・テーブル未作成なら静かに無視）
    submitDailyScore({ score, speed: Math.round(speed * 10) / 10 }).finally(() => renderDailyCard());
  }

  saveBestScore(score);
  const isBest = score > 0 && score > previousBest;
  elements.bestScore.textContent = getBestScore();
  updateCombo(0);

  // 今日最初のプレイならストリークボーナス
  const streak = updateStreak();
  let bonusText = "";

  if (streak.isFirstToday) {
    gainedXp += 50;
    const shieldNote = streak.earnedShield ? " 🛡️ シールド獲得！" : "";
    bonusText = `（今日の初プレイ +50 XP / 🔥${streak.current}日連続${shieldNote}）`;
    renderStreakCard();
    renderHeaderStreak();
    renderHasumiHome();
  }

  const result = addXp(gainedXp);
  renderLevelBar();

  if (result.leveledUp) {
    playLevelUpEffect();
    sfxLevelUp();
    showMessage(
      `🎉 レベルアップ！ Lv.${result.after.level}「${result.after.title}」 +${gainedXp} XP${unlockNoteForLevel(result.after.level)}`,
      "finished"
    );
    return;
  }

  if (isDaily) {
    sfxComplete();
    showMessage(`⚡ DAILY DASH 終了！スコア ${score} / +${gainedXp} XP（また明日）${bonusText}`, "finished");
    renderResultPanel({ isDaily, isBest, gainedXp, speed, previousBest });
    return;
  }

  showMessage(`終了！スコア ${score} / +${gainedXp} XP ${bonusText}`, "finished");
  renderResultPanel({ isDaily, isBest, gainedXp, speed, previousBest });
}

// ===== 終了リザルトパネル =====
// メッセージ1行では終了の満足感と次のアクションが弱いため、
// スコア・ベスト更新・次の一手（もう一回/シェア）をカード内に見せる
function renderResultPanel({ isDaily, isBest, gainedXp, speed, previousBest = 0 }) {
  const panel = document.getElementById("resultPanel");
  if (!panel) return;

  // ベスト更新 or ベストまでの差分（次にもう一回押す理由を作る）
  let bestBadge = "";
  if (isBest) {
    bestBadge = `<div class="result-panel__best">🏆 ベストスコア更新！${previousBest > 0 ? ` +${score - previousBest}` : ""}</div>`;
  } else if (previousBest > 0) {
    bestBadge = `<div class="result-panel__gap">ベスト ${previousBest} まであと <b>${previousBest + 1 - score}</b></div>`;
  }
  const title = isDaily ? "⚡ DAILY DASH 結果" : "⏱ CHALLENGE 結果";

  const actions = isDaily
    ? `<button type="button" class="result-panel__action" id="resultShare">結果をシェア</button>
       <button type="button" class="result-panel__action result-panel__action--ghost" id="resultStudy">苦手をStudyで復習</button>`
    : `<button type="button" class="result-panel__action" id="resultRetry">もう一回</button>
       <button type="button" class="result-panel__action result-panel__action--ghost" id="resultStudy">苦手をStudyで復習</button>`;

  panel.innerHTML = `
    <div class="result-panel__title">${title}</div>
    ${bestBadge}
    ${hasumiBubbleHtml(hasumiResultLine({ isBest, isDaily }), "hasumi--result")}
    <div class="result-panel__grid">
      <div><span>スコア</span><strong>${score}</strong></div>
      <div><span>思い出せず</span><strong>${recallFailCount}</strong></div>
      <div><span>ミスタイプ</span><strong>${typingMissCount}</strong></div>
      <div><span>速度</span><strong>${(Math.round(speed * 10) / 10).toFixed(1)}打/秒</strong></div>
      <div><span>獲得XP</span><strong>+${gainedXp}</strong></div>
    </div>
    <div class="result-panel__actions">${actions}</div>
    <div class="result-panel__tagline">今日も、はちゃんと少しだけ。</div>
  `;
  panel.hidden = false;

  // モバイルではパネルが画面外（ゲームカードの下）に出るため、結果を見える位置へ。
  // すでに見えていればblock:"nearest"は何もしない
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

  document.getElementById("resultRetry")?.addEventListener("click", () => {
    restartGame();
    elements.input.focus();
  });

  document.getElementById("resultStudy")?.addEventListener("click", () => {
    setMode("study");
    startGame();
    elements.input.focus();
  });

  const shareButton = document.getElementById("resultShare");
  if (shareButton) {
    shareButton.addEventListener("click", async () => {
      const outcome = await shareDailyResult().catch(() => "failed");
      if (outcome === "copied") {
        shareButton.textContent = "コピーしました！SNSに貼り付けてね";
      }
    });
  }
}

function hideResultPanel() {
  const panel = document.getElementById("resultPanel");
  if (panel) panel.hidden = true;
}

function updateTypeSpeed() {
  if (!startTime) return;

  const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
  const speed = correctChars / elapsedSeconds;

  elements.typeSpeed.textContent = speed.toFixed(1);
}
