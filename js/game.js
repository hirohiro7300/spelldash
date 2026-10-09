import { getWordsByCategory, findWord, findWordIn, getCategories, promptOf, speechTextOf, isConceptWord, answersFor } from "./wordStore.js";
import { jaLooksSame } from "./jaAmbiguity.js";
import { viableAnswers, completedAnswer, isSpellingVariant } from "./answers.js";
import { createRomajiMatcher, readingEntries, primaryReading, romajiKeyOf, hasJapaneseScript, hasKana } from "./romaji.js";
import { applyGenre } from "./genres.js";
import { hasumiResultLine, hasumiSetLine, hasumiLearnedLine, hasumiBubbleHtml, renderHasumiHome } from "./hasumi.js";
import { historyDotsHtml, getLearnedCount, getLearnedCounts } from "./learnedWords.js";
import { getSetSize, markDailySetDone, getSetsToday } from "./dailySet.js";
import { markActiveToday, recordGrowthSnapshot } from "./growthLog.js";
import { computeLegacyLearnedCount } from "./categoryProgress.js";
import { startBgm, stopBgm, setBgmIntensity } from "./bgm.js";
import { renderLearnedCard } from "./learnedCard.js";
import {
  getWordStats,
  getBestScore,
  saveBestScore,
  getCategoryBest,
  saveCategoryBest,
  getSessionLog,
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
  getDueReviewWords,
  startRetryQueue,
  isPlacementRun,
  startResumedQueue,
  getUpcomingIds,
  getFocusGenre,
  getQueueComposition,
  insertBreather
} from "./studyQueue.js";
import { getWeekGoal, getActiveDaysThisWeek } from "./growthLog.js";
import { canInstall, promptInstall } from "./installPrompt.js";
import { recordKeyMiss } from "./keyMiss.js";
import { icon } from "./icons.js";
import { REPEAT_SUCCESS_XP, NEW_WORD_DAILY_SUCCESS_TARGET } from "./studyConfig.js";
import {
  renderStudyQueue,
  updateRecalledToday,
  playRecallSuccessEffect,
  playRecallFailEffect
} from "./studyQueueUi.js";
import { addXp, updateStreak, getTitle } from "./level.js";
import { renderLevelBar, playLevelUpEffect } from "./levelUi.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { markMissionWord, isMissionWordPending, renderMission } from "./mission.js";
import {
  getDailyWords,
  isDailyPlayedToday,
  recordDailyResult,
  renderDailyCard,
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
import { speak, autoSpeak, speakOnCorrect, getListenRatio } from "./audio.js";
import { renderWordExample, hasExample } from "./wordExample.js";
import { saveSession, clearSession } from "./sessionResume.js";
import { getAfterCorrect, waitAfterCorrect, MILESTONE_MS, ADVANCE_GUARD_MS, ECHO_AFTER_DONE_MS, NOTE_RECHECK_MS } from "./afterCorrect.js";
import { generateCalc } from "./calcCards.js";
import { getNote, setNote, escapeHtml, NOTE_MAX_LENGTH } from "./wordNotes.js";
import { renderWordAi } from "./wordAi.js";
import {
  elements,
  showMessage,
  showHiddenWordText,
  showColoredAnswer,
  showAnswerWithReading,
  updateRomajiPreview,
  updateTypedPreview,
  clearTypedPreview,
  updateCombo,
  scrollBehavior,
  announce
} from "./ui.js";

const MODE_KEY = "spelldash_mode";

// デバッグ用: ?t=10 でChallenge/Dailyの時間を短縮できる（battle.htmlと同じ流儀）
const durationOverride = Number(new URLSearchParams(location.search).get("t")) || null;
const CHALLENGE_SECONDS = durationOverride ?? 60;

let mode = localStorage.getItem(MODE_KEY) || "study";
let currentWord = null;
let currentIndex = 0;
// いま受け入れている綴りの候補（先頭が出題語、あとは同じ訳の別解）
let answerCandidates = [];
let typedSoFar = "";
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
let consecutiveFails = 0; // Studyで連続して思い出せなかった数（3で救済）
let listenMode = false; // 音で出題（日本語を隠して発音だけ聞かせる）

// 全文入力モード（概念カード等、答えが a-z だけでない語）: 1文字ずつではなく Enter で答え全体を判定する。
// 日本語IMEで打てるように、入力欄の値には触らない
let freeMode = false;
let hintChars = 0; // 全文入力モードでヒントで見せた文字数
let awaitingNext = false; // 正解後、次の語へ進むまでの待ち（Enterで即進行）
let advanceTimer = null;
let advancedAt = -Infinity; // 正解後の待ちを終えて次の語を出した時刻（直後の Enter／Esc の守り。isAdvanceEcho）
let advancedBy = null; // 次の語へ進んだきっかけ（"timer" = 待ちが終わった／"key" = Enter）
let completedAt = -Infinity; // Study で前の語を打ち終えた時刻（タイマーで進んだときの守り。isAdvanceEcho）
let milestoneThisWord = false; // この語で節目の演出（覚えた のスタンプ・レベルアップの幕）を出した
let learnedCardStale = false; // プレイ中は覚えた単語カードを描かない（畳まれて見えない）。終わったら描く
let keepMessage = false; // この語の結果の行を次の語が出ても残すか（語の名を含む行・節目の行。showResult が決める。advanceNow）
let readingHold = false; // 待ちの間に作った覚え方を読んでいる（自動では進めない。Enter で次へ）
let staleMessageTimer = null;

function isFreeAnswer(word) {
  return !!word && !/^[a-z-]+$/.test(word.en);
}

// ローマ字モード（日本語の答え: 鎌倉幕府 など）: 漢字に変換せず、読みをローマ字で打つ（2026-10 創業者指示。js/romaji.js）。
// 1打ずつ判定し（英単語の綴り入力と同じ 1 ミス＝不正解）、どれかの読みを打ち終えたら Enter なしで正解。
// 入力欄は読み取り専用にして IME・OS キーボードを開かせない（keydown は届く）。打ったかなと、その下に打ったキーを出す。
// かなの読みが 1 つもないカード（自分で作った場面カードなど）は従来どおり全文入力（IME で打って Enter）
let romajiMode = false;
let romaji = null; // いまの読みの判定（createRomajiMatcher）。答えを見た後は主な読みだけ
let romajiEntries = [];
// 読みを打ち終えた直後の打鍵の持ち越し止め: 終えた語の判定（matcher）と最後の打鍵の時刻。
// 終えた語の読みの続き（語末の ん の 2 つ目の n、いわじゅく で終えた後の いせき）を、
// 間を空けずに打ったキーは次の語の打鍵にしない（Study・Challenge とも 0.6 秒。Study は正解後の待ちの間も続きの判定に食わせ、
// タイマーで進んだときは次の語へ持ち越す。Enter で自分から進んだときは捨てる）
let romajiSpill = null;
const ROMAJI_SPILL_GAP_MS = 600;

function romajiEntriesFor(word) {
  if (!word || word.calc || word.kanjiOnly || word.write || word.blank || !isConceptWord(word)) return [];
  if (!hasJapaneseScript(word.en)) return [];
  const entries = readingEntries(word);
  // かなの読みが無い（英字の別解だけの自分の場面カード）は、答えを打てないので全文入力に戻す
  return entries.some((e) => hasKana(e.reading)) ? entries : [];
}

// 入力欄: ローマ字モードでは読み取り専用（IME も OS キーボードも開かない。keydown は届く）
const INPUT_LABEL = "英単語を入力";
function setInputRomaji(on) {
  const input = elements.input;
  if (!input) return;
  const changed = input.readOnly !== on;
  input.readOnly = on;
  input.setAttribute("aria-label", on ? "読みをローマ字で入力（変換しない）" : INPUT_LABEL);
  // フォーカス中に切り替わったら付け直す（IME の状態と、前のカードで開いた OS キーボードを捨てさせる）
  if (changed && document.activeElement === input) {
    input.blur();
    input.focus({ preventScroll: true });
  }
}

function resetRomajiMode() {
  romajiMode = false;
  romaji = null;
  romajiEntries = [];
  romajiSpill = null;
  document.body.classList.remove("romaji-answer");
  setInputRomaji(false);
}

function primaryRomajiEntry() {
  return primaryReading(romajiEntries);
}

function renderRomaji() {
  if (!romaji) return;
  elements.input.value = romaji.keys; // 値は見えない（文字色は透明）。プレースホルダを消すため
  updateRomajiPreview(romaji.state());
}

// 表記ゆれを吸収して比較（全角/半角・空白・記号・大文字小文字・アポストロフィ）
function normalizeAnswer(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・／/\-‐－_（）()「」『』.,、。:：;；?？!！'’"”“]/g, "");
}

function answerMatches(word, text) {
  const typed = normalizeAnswer(text);
  if (!typed) return false;
  const candidates = [word.en, ...(Array.isArray(word.accept) ? word.accept : [])];
  return candidates.some((c) => normalizeAnswer(c) === typed);
}

// 英作文: 語ごとに比べて、最初に違う語の位置を返す（語順・時制の誤りを指摘するため）
function splitWords(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,、。:：;；?？!！"”“]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

function firstWordDiff(answer, typed) {
  const a = splitWords(answer);
  const t = splitWords(typed);
  const shown = String(answer ?? "").replace(/[.,、。:：;；?？!！"”“]/g, "").split(/\s+/).filter(Boolean); // 表示用（大文字を保つ）
  for (let i = 0; i < Math.max(a.length, t.length); i++) {
    if (a[i] !== t[i]) return { index: i, expected: shown[i] ?? "", typed: t[i] ?? "", total: a.length, typedTotal: t.length };
  }
  return null;
}

// 並べ替え: 答えの語をシャッフル（元の順と同じにならないように。カードごとに固定）
let bankWords = [];
function buildWordBank(word) {
  const words = String(word?.en ?? "").replace(/[.?!]$/, "").split(/\s+/).filter(Boolean);
  if (words.length < 2) return words;
  let shuffled = words.slice();
  for (let attempt = 0; attempt < 8; attempt++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (shuffled.join(" ") !== words.join(" ")) break;
  }
  return shuffled;
}

function renderExplain(word) {
  const el = document.getElementById("wordExplain");
  if (el) el.textContent = word?.explain ? word.explain : "";
  renderWordExample(document.getElementById("wordExample"), word); // 例文（英単語カード）も同じタイミングで出す
}

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
  // カード下の数字のラベル: Study は「思い出せた」、Challenge は「正解」（index.html の初期値は Study 側）
  const scoreLabel = elements.score?.previousElementSibling;
  if (scoreLabel && scoreLabel.tagName === "SPAN") scoreLabel.textContent = mode === "study" ? "思い出せた" : "正解";

  document.querySelectorAll(".mode-switch__btn").forEach((btn) => {
    btn.classList.toggle("mode-switch__btn--active", btn.dataset.mode === mode);
  });

  showIdleMessage();
}

function showIdleMessage() {
  if (mode === "study") {
    showMessage("Enter で開始");
  } else {
    showMessage("Enter で開始（60秒）");
  }
}

// ゲームが終わった／止まったことをホームに知らせる（専用キーボードを畳む等）
function notifyGameEnd() {
  if (learnedCardStale) {
    learnedCardStale = false;
    renderLearnedCard();
  }
  document.body.classList.remove("placement"); // 腕試しの途中でやめても数字1行は戻す（css/home.css）
  resetRomajiMode(); // 入力欄を読み取り専用のままにしない（道のスタートの Enter・他の画面の入力に戻す）
  window.dispatchEvent(new CustomEvent("spelldash:game-end", { detail: { mode } }));
}

export function stopGame() {
  clearInterval(timer);
  isPlaying = false;
  notifyGameEnd();
  document.body.classList.remove("is-playing");
  stopBgm();
  currentWord = null;
  dailyRun = null; // 中断したDailyはロックせず、カードからやり直せる
  document.body.classList.remove("set-done");
  elements.japanese.textContent = ""; // 内部モード名（Study Mode 等）は出さない。完了の見出しは結果パネルの 1 つだけ
  setPromptLabel("");
  renderPromptContext(null);
  showHiddenWordText("");
  updateCombo(0);
  updateBigTimer();
  renderPlayScore();
  hideResultPanel();
  renderStudyQueue(false);
  renderSetProgress();
  hideHint();
  renderWordNote(null);
  renderExplain(null);
  clearTimeout(advanceTimer);
  awaitingNext = false;
  advancedAt = -Infinity;
  advancedBy = null;
  completedAt = -Infinity;
  readingHold = false;
  milestoneThisWord = false;
  document.body.classList.remove("free-answer");
  document.getElementById("gameCard")?.classList.remove("game-card--concept");
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
  const resume = !retry && options.resume && Array.isArray(options.resume.queue) && options.resume.queue.length > 0 ? options.resume : null; // 前回の続きから
  let composition = null;

  if (getWordsByCategory(activeCategory).length === 0) {
    showMessage(
      activeCategory === "my"
        ? "マイ単語帳はまだ空。単語帳ページから追加する"
        : "単語データを読み込み中"
    );
    return;
  }

  isPlaying = true;
  window.dispatchEvent(new CustomEvent("spelldash:game-start", { detail: { mode } })); // ホーム: ゲームカードを出す
  // フォーカスモード: 時間制ラン中はスマホで周辺UIを畳む（1画面1目的）。
  // Studyは終了の概念がないため対象外（モード切替手段を奪わない）
  document.body.classList.toggle("is-playing", mode === "challenge");
  document.body.classList.remove("set-done"); // 前回の結果画面の畳みを解く
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
  romajiSpill = null;
  advancedAt = -Infinity;
  advancedBy = null;
  completedAt = -Infinity;
  readingHold = false;
  milestoneThisWord = false;
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

  // 出題中の案内は入力欄の上の 1 本（#word の「分からないときは Enter で答えを表示」）だけ。下の行は結果にだけ使う
  showMessage("");

  // Study: Recall Loopキューを構築（Unresolved → Mission Review → 復習期限 → Mission New → 通常）
  if (mode === "study") {
    retryIds = retry;
    consecutiveFails = 0;
    if (retry) startRetryQueue(retry);
    else if (resume) startResumedQueue(resume.queue, resume.recalled);
    else startStudyQueue(activeCategory);
    composition = getQueueComposition(); // 最初の1語を取り出す前に構成を控える
    updateRecalledToday();
    setRecalled = new Set(resume?.recalled ?? []);
    setFailed = new Set(resume?.failed ?? []);
    setLearnEvents = new Map();
    setNewCount = resume?.newCount ?? 0;
    setReviewCount = resume?.reviewCount ?? 0;
    setCompletePending = false;
    renderSetProgress();
  }

  setNewWord();

  // 腕試し中は body.placement（css/home.css が「思い出せた 0 ・ 思い出せず 0 …」の行を畳む）。確定・終了・中断で外す
  document.body.classList.toggle("placement", mode === "study" && isPlacementRun());

  // セットの中身を先に伝える（何をやるか分かってから始める）
  if (mode === "study") {
    if (retry) {
      showMessage(`思い出せなかった ${retry.length}語をもう一度`, "revealed");
    } else if (resume) {
      showMessage(`前回の続きから。あと ${Math.max(0, currentSetSize() - setRecalled.size)}語で今日のセット完了`, "revealed");
    } else if (isPlacementRun()) {
      showMessage(""); // 腕試しの告知はトップの注記が済ませている。Enter の説明は #word の 1 本
    } else {
      const c = composition ?? getQueueComposition();
      const parts = [];
      if (c.review > 0) parts.push(`復習 ${c.review}`);
      if (c.weak > 0) parts.push(`もう一度 ${c.weak}`);
      if (c.repeat > 0) parts.push(`反復 ${c.repeat}`);
      if (c.fresh > 0) parts.push(`新しい単語 ${c.fresh}`);
      if (c.review > 0 || c.weak > 0) {
        showMessage(`${parts.join("・")}から`, "revealed");
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

  // 正解直後の待ち: Enterで待たずに次へ
  if (awaitingNext) {
    advanceNow("key");
    return;
  }
  if (isAdvanceEcho()) return; // 次の語が出た直後の、前の語に向けた Enter／Esc（答えを開かない＝×にしない）

  // ローマ字モード: 読みは打ち終えた時点で正解になっている。Enter は英単語と同じく 1 回目は答え表示、
  // 答えを見た後はスキップ（下の通常処理）
  if (romajiMode && romaji && !isRevealed) {
    revealAnswer();
    return;
  }

  // 全文入力モード: 入力があれば判定、空なら「分からない」
  if (freeMode) {
    const typed = elements.input.value.trim();
    if (!isRevealed) {
      if (typed) submitFreeAnswer(typed);
      else revealAnswer();
      return;
    }
    if (typed) {
      if (answerMatches(currentWord, typed)) {
        finishFreeWord();
      } else {
        showMessage("違う。答えのとおりに打つ", "wrong");
        elements.input.value = "";
      }
      return;
    }
    // 空でEnter = スキップして次へ（下の通常処理）
  }

  if (!isRevealed) {
    // 別解を打ち終えて止まっている場合（出題語 advertisement に対して "ad" など）は、
    // 「分からない」ではなく別解として受け取る
    const done = completedAnswer(activeCandidates(), typedSoFar, { force: true });
    if (done && done !== currentWord.en) {
      finishTypedAnswer(done);
      return;
    }
    revealAnswer();
  } else {
    // 答えを見た後のスキップ = Dailyでは「打てなかった単語」⬛
    if (dailyRun && mode === "challenge") {
      dailyRun.emoji.push("⬛");
    }
    setNewWord();
    showMessage("");
  }
}

// 次の語が出てから ADVANCE_GUARD_MS（0.3 秒）の、その語にまだ何も打っていない Enter／Esc か。
// タイマーで進んだときは、前の語を打ち終えてから ECHO_AFTER_DONE_MS（1.2 秒）の間も同じ。
// 待ちの終わり際に「次へ」と押した指・二度押し・打ち終えたら Enter で次への癖が、次の語の「分からない」にならないようにする
function isAdvanceEcho() {
  const now = performance.now();
  return (
    mode === "study" &&
    !isRevealed &&
    (now - advancedAt < ADVANCE_GUARD_MS || (advancedBy === "timer" && now - completedAt < ECHO_AFTER_DONE_MS)) &&
    typedSoFar === "" &&
    !elements.input.value &&
    !romaji?.keys
  );
}

// 読みを打ち終えた直後、終えた語の読みの続きを間を空けずに打ったキー（語末の ん の 2 つ目の n、
// いわじゅく で終えた後の いせき）か。続きとして通れば時刻を進めて true（呼び元が飲む）。
// Shift などローマ字でないキーでは途切れさせない
function swallowRomajiSpill(event) {
  if (!romajiSpill) return false;
  const key = romajiKeyOf(event);
  if (!key) return false;
  const spill = romajiSpill;
  romajiSpill = null;
  const now = performance.now();
  if (now - spill.at <= ROMAJI_SPILL_GAP_MS && spill.matcher.feed(key).ok) {
    if (spill.matcher.state().canContinue) romajiSpill = { matcher: spill.matcher, at: now };
    return true;
  }
  return false;
}

export function handleKeydown(event) {
  // IME変換確定のEnter（isComposing / keyCode 229）はゲーム操作にしない
  if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) return;

  if (event.key === "Enter") {
    event.preventDefault();
    triggerEnter();
    return;
  }

  if (!isPlaying || !currentWord) return;

  // 正解直後の待ち（次の語が出る前）: 文字キーは判定しない（次の語の1文字目をミス扱いにしない）。
  // ローマ字の続きは判定に食わせて時刻を進める（待ちが短くても、続きの打鍵が次の語に入らない）
  if (awaitingNext) {
    swallowRomajiSpill(event);
    event.preventDefault();
    return;
  }

  // Esc = 「わからない」（Enterと同じ: 答え表示 → もう一度で次へ）
  if (event.key === "Escape") {
    event.preventDefault();
    triggerEnter();
    return;
  }
  // Ctrl+.（Cmd+.）= 発音。Tab は既定どおり次の要素へ（入力欄に閉じ込めない）
  if (event.key === "." && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    speak(speechTextOf(currentWord));
    return;
  }

  // 読みを打ち終えた直後の、終えた語の読みの続き（swallowRomajiSpill）は次の語の打鍵にしない。
  // 次の語の頭と同じキーでも続きが先（続きの窓は最後の打鍵から 0.6 秒＝次の語が出て長くて 0.35 秒。
  // 思い出して打つ語の 1 打目はその間には来ないが、ゆっくり打つ人の 2 つ目の n は来る）
  if (swallowRomajiSpill(event)) {
    event.preventDefault();
    return;
  }

  // ローマ字モード: 読みを 1 打ずつ判定（IME は通さない）
  if (romajiMode) {
    handleRomajiKey(event);
    return;
  }

  // 全文入力モード: 文字入力はブラウザ／IMEに任せる（Enterで判定）
  if (freeMode) return;

  if (event.key.length !== 1) return;

  event.preventDefault();

  const typedChar = event.key.toLowerCase();

  if (viableAnswers(activeCandidates(), typedSoFar + typedChar).length > 0) {
    handleCorrectChar(typedChar);
  } else {
    handleTypingMiss(currentWord.en[currentIndex], typedChar);
  }
}

// ローマ字モードの 1 打。ローマ字のキーでないもの（空白・記号・Backspace）は判定しない（ミスにもしない）
function handleRomajiKey(event) {
  if (!romaji) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return; // 再読み込み・コピーなどブラウザの操作は止めない
  const key = romajiKeyOf(event);
  if (!key) {
    if ([...String(event.key ?? "")].length === 1 || ["Backspace", "Delete", "Process", "Unidentified"].includes(event.key)) event.preventDefault();
    return;
  }
  event.preventDefault();
  const result = romaji.feed(key);
  if (!result.ok) {
    handleTypingMiss(result.expected, key);
    return;
  }
  renderRomaji();
  // 画面キーボードが出ていると、長い問題文の下の入力欄が盤面に隠れることがある。打ち始めに見える位置へ
  if (romaji.keys.length === 1 && document.body.classList.contains("osk-open")) {
    elements.input.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }
  if (result.done) finishRomajiWord();
}

// 読みを打ち終えた（Enter なし・変換なし）。速度はかなの数で数える
function finishRomajiWord() {
  const state = romaji.state();
  const entry = romaji.entries[state.finished] ?? romaji.entries[0];
  correctChars += [...(entry?.reading ?? "")].length;
  updateTypeSpeed();
  // まだ続けて打てる（長い読み・語末の ん の nn）なら、直後の続きの打鍵を次の語に持ち越さない
  romajiSpill = state.canContinue ? { matcher: romaji, at: performance.now() } : null;
  completeWord();
}

// 答えを見た後は出題語だけを練習させる（別解でごまかせないように）
function activeCandidates() {
  return isRevealed ? [currentWord.en] : answerCandidates;
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
  if (romajiMode) {
    // 入力欄は読み取り専用なので来ないはず。来ても値は打ったキーに戻す（判定は keydown だけ）
    elements.input.value = romaji?.keys ?? "";
    return;
  }
  if (freeMode) return; // 全文入力モードでは日本語をそのまま受け付ける

  // 確定された文字に日本語等が含まれていたら、受理済み位置へ巻き戻して案内する
  // （かな→ローマ字の復元は不可能なため、打ち直してもらうのが最も安全）
  if (/[^a-z\s]/i.test(elements.input.value)) {
    elements.input.value = typedSoFar;
    updateTypedPreview(typedSoFar);
    showMessage("キーボードを英字モードに", "wrong");
    return;
  }
  handleTextInput();
}

export function handleTextInput() {
  if (!isPlaying || !currentWord) return;
  if (romajiMode) {
    elements.input.value = romaji?.keys ?? ""; // 判定は keydown だけ（入力欄は読み取り専用）
    return;
  }
  if (freeMode) return; // 全文入力モードは Enter で判定
  if (composing) return; // 変換確定はhandleCompositionEndで処理する
  if (awaitingNext) {
    // 正解直後の待ち: 入力は捨てる（次の語の判定に持ち越さない）
    elements.input.value = "";
    return;
  }

  const accepted = typedSoFar;
  const raw = elements.input.value.toLowerCase().replace(/[^a-z]/g, "");

  if (raw === accepted) return;

  // 削除や予測変換での置き換えは、受理済みの位置へ巻き戻すだけ（ミス扱いしない）
  if (!raw.startsWith(accepted)) {
    elements.input.value = accepted;
    updateTypedPreview(accepted);
    return;
  }

  for (const typedChar of raw.slice(accepted.length)) {
    if (viableAnswers(activeCandidates(), typedSoFar + typedChar).length > 0) {
      const willFinish = completedAnswer(activeCandidates(), typedSoFar + typedChar) !== null;
      if (willFinish) {
        elements.input.value = typedSoFar + typedChar;
        updateTypedPreview(elements.input.value);
      }
      if (acceptChar(typedChar)) return; // 単語完成。setNewWordが入力欄をリセットする
    } else {
      handleTypingMiss(currentWord.en[currentIndex], typedChar);
      break; // 1イベントにつきミスは1回まで（予測変換の一括挿入対策）
    }
  }

  elements.input.value = typedSoFar;
  updateTypedPreview(typedSoFar);
}

// ソフトキーボードのEnter（Go/実行）はkeydownではなくinsertLineBreakとして来る環境がある
export function handleBeforeInput(event) {
  if (event.inputType === "insertLineBreak") {
    event.preventDefault();
    triggerEnter();
    return;
  }
  if (romajiMode) event.preventDefault(); // ローマ字モードは keydown だけで判定する（値を書き換えさせない）
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

    // 3連続で思い出せなかったら、次に「思い出せる語」を1つ挟んで立て直す
    consecutiveFails++;
    if (consecutiveFails === 3 && insertBreather()) {
      const toast = document.getElementById("learnToast");
      if (toast) {
        toast.innerHTML = hasumiBubbleHtml({ mood: "normal", text: "3つ続けて出てこないのは、よくある。次は思い出せる語を1つ挟む。" }, "hasumi--result");
        toast.hidden = false;
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
          toast.hidden = true;
        }, 4000);
      }
      renderStudyQueue(true);
    }
  }

  combo = 0;
  updateCombo(0);
  renderPlayScore();
}

// Enter1回目 or 1ミスタイプ: 不正解 → 答えを表示（recallFailとして記録）
// 別解を打ち終わったとき: 減点も×記録もしない。「それも正解」と伝えたうえで、
// この問題の語を見せて打ってもらう（別解だけで済ませると出題語が身につかないため）
function acceptAlternative(typed) {
  sfxSoftCorrect();
  isRevealed = true;
  hideHint();
  showColoredAnswer(currentWord.en);
  if (listenMode) elements.japanese.textContent = promptOf(currentWord);
  renderWordFamily(currentWord);
  renderWordHistory();
  renderWordNote(currentWord);
  renderExplain(currentWord);
  autoSpeak(speechTextOf(currentWord));
  if (elements.speakButton) elements.speakButton.hidden = !speechTextOf(currentWord);

  currentIndex = 0;
  typedSoFar = "";
  elements.input.value = "";
  clearTypedPreview();
  showMessage(`${typed} も「${promptOf(currentWord)}」。この問題の語は ${currentWord.en}`, "info");
}

// 答えを見せる。ローマ字モードは答えの下に読みも（鎌倉幕府 ／ かまくらばくふ）
function showAnswer() {
  if (romajiMode) showAnswerWithReading(currentWord.en, primaryRomajiEntry()?.display);
  else showColoredAnswer(currentWord.en);
}

function revealAnswer(fromMiss = false) {
  isRevealed = true;
  hideHint();
  window.dispatchEvent(new CustomEvent("spelldash:reveal", { detail: { id: currentWord?.id, fromMiss } })); // チュートリアル（js/tutorial.js）
  if (!fromMiss) sfxReveal(); // ミス起点ではsfxMissが鳴っているので重ねない

  // ヒントを見た時点で×は記録済み。二重に数えない
  if (!hintUsed) markRecallFail();

  showAnswer();
  if (listenMode) elements.japanese.textContent = promptOf(currentWord); // 音だけだった語の意味を見せる
  renderWordFamily(currentWord);
  renderWordHistory();
  renderWordNote(currentWord);
  renderExplain(currentWord);

  // 発音: autoなら1回再生。スピーカーボタンも表示（英語がある語だけ）
  autoSpeak(speechTextOf(currentWord));
  if (elements.speakButton) {
    elements.speakButton.hidden = !speechTextOf(currentWord);
  }

  // 頭から打ち直して練習できるようにリセット
  currentIndex = 0;
  typedSoFar = "";
  elements.input.value = "";
  clearTypedPreview();
  if (romajiMode) romaji = createRomajiMatcher([primaryRomajiEntry()]); // 答えを見た後は、見せた読みだけを打って練習

  const stat = getWordStats()[currentWord.id];
  const leech = (stat?.recallFail ?? 0) >= LEECH_FAILS;
  showMessage(
    fromMiss
      ? freeMode
        ? "違う。答えを見て打ち直す（Enter で判定）"
        : "違う。答えを見て打ち直す"
      : leech
        ? `${stat.recallFail}回目の難敵。覚え方をメモすると残る`
        : freeMode
          ? "打って練習するか、空のまま Enter で次へ"
          : "打って練習するか、Enter で次へ",
    fromMiss ? "wrong" : "revealed"
  );

  // 画面キーボードが出ていると、答え・例文・操作チップの分だけ入力欄が盤面の下に落ちる。見える位置へ戻す
  // （html:has(body.osk-open) の scroll-padding-bottom が盤面の高さ分を確保している）
  if (document.body.classList.contains("osk-open")) {
    elements.input.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }
}

// ===== 全文入力モードの判定 =====
function submitFreeAnswer(typed) {
  if (answerMatches(currentWord, typed)) {
    finishFreeWord();
    return;
  }
  // 違う答え = 思い出せていない。答えを見せて打ち直し（1ミス＝不正解の方針と同じ）
  typingMissCount++;
  elements.miss.textContent = typingMissCount;
  hasMissedCurrentWord = true;
  combo = 0;
  updateCombo(0);
  sfxMiss();
  recordTypingMiss(currentWord.id);
  revealAnswer(true);
  // 英作文: どこから違うかを語単位で指摘（語順・時制・冠詞の気づきに）
  if (currentWord.write) {
    const diff = firstWordDiff(currentWord.en, typed);
    if (diff) {
      const where = diff.index >= diff.total
        ? `${diff.total}語で終わりだけど、余分に「${diff.typed}」がある`
        : diff.typed
          ? `${diff.index + 1}語目が違う: あなたは「${diff.typed}」、答えは「${diff.expected}」`
          : `${diff.index + 1}語目「${diff.expected}」から先が足りない`;
      showMessage(`違う。${where}。答えを見て打ち直す（Enter で判定）`, "wrong");
    }
  }
}

function finishFreeWord() {
  currentIndex = currentWord.en.length;
  correctChars += currentWord.en.length;
  updateTypeSpeed();
  completeWord();
}

// 正解後の待ちを終えて次へ（by: "key" = Enter で自分から／"timer" = 待ちが終わった）
function advanceNow(by = "key") {
  clearTimeout(advanceTimer);
  advanceTimer = null;
  if (!awaitingNext) return; // タイマーと Enter が重なっても 1 回だけ進む
  awaitingNext = false;
  readingHold = false;
  if (by !== "timer") romajiSpill = null; // Enter で自分から進んだ: 次の語の 1 打目から受け付ける
  if (!isPlaying) return;
  if (mode === "study" && setCompletePending) {
    endStudySession();
    return;
  }
  const prev = currentWord;
  setNewWord();
  // 前の語の結果の行（「正解」「思い出せた +N XP」など語の名を含まない行）を次の語の下に見せない。
  // 語の名を含む行（「知ってた。business は…」「X を習得」）と節目の行（Lv・連続日数・シールド・ミッション）は残す（showResult の keep）。
  if (isPlaying && prev && !keepMessage) hideStaleMessage();
  advancedAt = performance.now();
  advancedBy = by;
}

// 前の語の結果の行を見えなくする。文はすぐには消さない（aria-live の読み上げを途中で落とさない）。
// 次の showMessage が置き換える。1.5 秒たっても置き換わらなければ文も消す（あとで読み上げで辿っても前の語の結果が出ない）
function hideStaleMessage() {
  const el = elements.message;
  if (!el.textContent) return;
  el.classList.add("message--stale");
  clearTimeout(staleMessageTimer);
  staleMessageTimer = setTimeout(() => {
    if (el.classList.contains("message--stale")) showMessage("");
  }, 1500);
}

// この語の結果の行。keep: 次の語が出ても残す（語の名を含む行・節目の行）。最後に出した行が決める
function showResult(text, type, keep = false) {
  keepMessage = keep;
  showMessage(text, type);
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

  // 計算カード: 頭文字ではなく式を見せる
  if (currentWord.calc) {
    showHiddenWordText(currentWord.calcFormula, { hint: true });
    showMessage(`${currentWord.calcFormula}。計算して数字を入力（ヒントを見たので、この問題はまた出す）`, "revealed");
    return;
  }

  // 英作文: 1語ずつ見せる（文字単位だと長すぎる）
  if (currentWord.write) {
    const words = currentWord.en.split(/\s+/).filter(Boolean);
    hintChars = Math.min(words.length, hintChars + 1);
    const shown = words.slice(0, hintChars).join(" ");
    showHiddenWordText(`${shown}${" ▢".repeat(Math.max(0, words.length - hintChars))}（${words.length}語）`, { hint: true });
    showMessage(
      hintChars === 1
        ? `最初の語は「${words[0]}」。続きを思い出して入力（ヒントを見たので、この文はまた出す）`
        : `${shown} … 続きを入力してEnter`,
      "revealed"
    );
    return;
  }

  // ローマ字モード: 読みの次の 1 かなを打ったことにする（その下に綴りも出る）。見せるのは打った分のかなと残りの字数
  if (romajiMode && romaji) {
    const next = romaji.hint();
    if (!next) return;
    romaji.type(next.keys);
    renderRomaji();
    const state = romaji.state();
    const shown = state.committed.map((seg) => seg.kana).join("");
    const total = [...(romaji.entries[state.candidate ?? 0]?.display ?? "")].length;
    showHiddenWordText(`${shown}${"・".repeat(Math.max(0, total - [...shown].length))}（${total}文字）`, { hint: true });
    showMessage(
      hintChars === 0
        ? `頭の字は「${next.kana}」。続きを打つ（ヒントを見たので、この語はまた出す）`
        : `次は「${next.kana}」。続きを打つ`,
      "revealed"
    );
    hintChars++;
    if (state.done) finishRomajiWord();
    return;
  }

  // 全文入力モード: 文字を入力欄に入れず、頭から1文字ずつ見せるだけ
  if (freeMode) {
    hintChars = Math.min(currentWord.en.length, hintChars + 1);
    const total = currentWord.en.length;
    showHiddenWordText(`${currentWord.en.slice(0, hintChars)}${"・".repeat(Math.max(0, total - hintChars))}（${total}文字）`, { hint: true });
    showMessage(
      hintChars === 1
        ? `頭文字は「${currentWord.en[0]}」。続きを思い出して入力（ヒントを見たので、この語はまた出す）`
        : `${currentWord.en.slice(0, hintChars)}… 続きを入力してEnter`,
      "revealed"
    );
    return;
  }

  const nextChar = currentWord.en[currentIndex];
  const total = currentWord.en.length;
  const shown = currentIndex + 1;
  showHiddenWordText(`${currentWord.en.slice(0, shown)}${"・".repeat(Math.max(0, total - shown))}（${total}文字）`, { hint: true });
  showMessage(
    shown === 1
      ? `頭文字は「${nextChar}」。残りを自力で打つ（ヒントを見たので、この語はまた出す）`
      : `次は「${nextChar}」。続きを打つ`,
    "revealed"
  );

  elements.input.value += nextChar;
  updateTypedPreview(elements.input.value);
  acceptChar();
}

// ===== 自分のメモ（覚え方）: 答え表示・ヒント後に表示＋編集 =====
// 覚え方のメモを書いている途中か: 欄か保存ボタンに焦点がある、または欄の中を押し下げている
// （マウスで「保存」を押すと、押し下げで焦点が欄から離れる。Safari はボタンに焦点を移さない）
let notePressed = false;
function releaseNote() {
  notePressed = false;
}
function isEditingNote() {
  if (!document.getElementById("noteInput")) return false;
  return notePressed || !!document.getElementById("wordNote")?.contains(document.activeElement);
}

// 覚え方を作る（AI）の返事を待っている（待ちを止めるのは長くて AI_HOLD_MAX_MS。返事が来なくても先へ進める）
const AI_HOLD_MAX_MS = 10000;
let aiStartedAt = -Infinity;
function isMakingWordAi() {
  return !!document.querySelector("#wordAi [data-word-ai-run]:disabled") && performance.now() - aiStartedAt < AI_HOLD_MAX_MS;
}

function renderWordNote(word) {
  const el = document.getElementById("wordNote");
  if (!el) return;
  const aiSlot = document.getElementById("wordAi");
  if (!word || mode !== "study") {
    el.innerHTML = "";
    if (aiSlot) {
      aiSlot.innerHTML = "";
      delete aiSlot.dataset.wordAiFor; // ログインの確かめが後から返っても、前の語のボタンを描かない
    }
    return;
  }
  // 覚え方を作る（AI）: 保存済みなら表示、ログイン中ならボタン。生成後は入力欄へ戻す
  renderWordAi(aiSlot, word, {
    onStart: () => {
      aiStartedAt = performance.now();
      elements.input.focus(); // 押したボタンは返事まで押せない。焦点を入力欄へ戻し、Enter で次へ進めるようにする
    },
    // 返事（覚え方・断りの文）が出た: 待ちの間なら読み終えるまで待つ（Enter で次へ）
    onSettled: () => {
      if (awaitingNext && currentWord === word) readingHold = true;
      elements.input.focus();
    }
  });

  const note = getNote(word.id);
  el.innerHTML = note
    ? `<span class="word-note__text">${icon("note")}${escapeHtml(note)}</span><button type="button" class="word-note__edit" id="noteEdit">編集</button>`
    : `<button type="button" class="word-note__edit word-note__edit--add" id="noteEdit">${icon("note")}覚え方をメモ</button>`;

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
    // 欄・保存ボタンを押し下げている間は待ちを止める（離したら次の見直しで進む。click は離した直後に同じ流れで来る）
    for (const target of [input, document.getElementById("noteSave")]) {
      target?.addEventListener("pointerdown", () => {
        notePressed = true;
        document.addEventListener("pointerup", releaseNote, { once: true });
        document.addEventListener("pointercancel", releaseNote, { once: true });
      });
    }
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
    speak(speechTextOf(currentWord));
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

  const lines = [];
  if (Array.isArray(word.family) && word.family.length > 0) {
    const names = word.family
      .map((id) => findWord(id))
      .filter(Boolean)
      .map((w) => `${w.en}（${w.ja}）`);
    if (names.length) lines.push(`仲間の語: ${names.join("・")}`);
  }
  // 紛らわしい語（affect/effect, adapt/adopt …）: 綴りが1〜2文字違いの語を並べて混同を潰す
  const confusables = findConfusables(word);
  if (confusables.length) lines.push(`似た綴り: ${confusables.map((w) => `${w.en}（${w.ja}）`).join("・")}`);

  elements.wordFamily.textContent = lines.join("　");
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function findConfusables(word) {
  if (!word || isConceptWord(word) || !/^[a-z-]{4,}$/.test(word.en)) return [];
  const family = new Set(Array.isArray(word.family) ? word.family : []);
  const seen = new Set([word.id]);
  const maxDistance = word.en.length >= 7 ? 2 : 1;
  const out = [];
  for (const w of getWordsByCategory(word.category === "my" ? "my" : "all")) {
    if (seen.has(w.id) || family.has(w.id) || isConceptWord(w) || !/^[a-z-]+$/.test(w.en)) continue;
    seen.add(w.id);
    if (levenshtein(word.en, w.en) <= maxDistance) out.push(w);
    if (out.length >= 3) break;
  }
  return out;
}

function handleCorrectChar(typedChar) {
  elements.input.value += typedChar;
  updateTypedPreview(elements.input.value);
  acceptChar(typedChar);
}

// 1文字受理の共通処理（DOMの入力欄には触れない）。単語完成ならtrueを返す
function acceptChar(typedChar) {
  typedSoFar += typedChar ?? currentWord.en[currentIndex];
  currentIndex = typedSoFar.length;
  correctChars++;
  updateTypeSpeed();

  const done = completedAnswer(activeCandidates(), typedSoFar);
  if (done) {
    finishTypedAnswer(done);
    return true;
  }

  return false;
}

// 打ち終わった綴りで分岐。出題語ならそのまま正解、別解なら減点せずに出題語を見せる
function finishTypedAnswer(typed) {
  if (typed === currentWord.en) {
    completeWord();
    return;
  }
  // つづり違い（favourite / favorite）は同じ語。打ち直させずにそのまま正解にする
  if (isSpellingVariant(typed, currentWord.en)) {
    completeWord();
    showResult(`${typed} も正解（この教材では ${currentWord.en}）`, "info", true);
    return;
  }
  acceptAlternative(typed);
}

let studyWordsSinceSync = 0;

function completeWord() {
  keepMessage = false;
  let holdMs = 0; // チュートリアル T3 を出した語の最低の待ち（js/tutorial.js が spelldash:recall の detail.hold に書く）
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
    consecutiveFails = 0;
    recordRecallSuccess(currentWord.id);
    const recallDetail = { id: currentWord.id, mode };
    window.dispatchEvent(new CustomEvent("spelldash:recall", { detail: recallDetail })); // チュートリアル（js/tutorial.js）
    holdMs = Number(recallDetail.hold) || 0;
    if (mode === "study") bumpActivity("studyCorrect"); // KPI心拍

    if (mode === "study") {
      speakOnCorrect(speechTextOf(currentWord)); // 綴りを打てた直後に音でも確認（設定で切れる）
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
        saveResumePoint();
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
      setTimeout(() => showMessage("知っている語が多い。少し難しい単語も混ぜる", "revealed"), 1200);
    }
    announcePlacement();
  } else {
    gainedXp += earned;

    // Challenge 中の XP は結果パネルの 1 か所にまとめる（打っている最中に動く数字を増やさない）
    showResult(missionResult.justCompleted ? "ミッション達成" : "正解", "correct");
  }

  // Challenge/Daily: 待ち時間ゼロで次の単語へ（60秒×30語で7.5秒あった空白をなくす）。
  // 正解の音・スコアのパルスは非同期で重なるのでテンポを止めない
  if (mode !== "study") {
    renderPlayScore();
    setNewWord();
    return;
  }

  // Study: 正解の手応えのあと次へ。自力で正解した例文つきの語・概念カードは、答えと例文・解説を少しだけ見せる（Enter で即進行）。
  // 長さは設定「正解のあと」（js/afterCorrect.js）。答えを見た語・腕試しは手応えだけ（表示の時に読んでいる／テンポ優先）
  const concept = isConceptWord(currentWord);
  const { ms, glance } = waitAfterCorrect({
    concept,
    withExample: hasExample(currentWord),
    revealed: isRevealed,
    placement: isPlacementRun(),
    pace: getAfterCorrect()
  });
  if (glance) {
    renderExplain(currentWord);
    showAnswer();
  } else if (concept && !isRevealed) {
    showAnswer(); // 読みを打った語は答えの漢字を一目（すぐ次へ・腕試し）
  }
  if (listenMode) elements.japanese.textContent = promptOf(currentWord);
  // 節目（覚えた・レベルアップの幕）とチュートリアル T3 の語は、演出・札が次の語に重ならない長さまで待つ
  const wait = Math.max(ms, milestoneThisWord ? MILESTONE_MS : 0, holdMs);
  const serialAtComplete = wordSerial;
  awaitingNext = true;
  completedAt = performance.now();
  clearTimeout(advanceTimer);
  const tick = () => {
    if (!isPlaying || wordSerial !== serialAtComplete) return;
    // 待ちの間に作った覚え方を読んでいる: 自動では進めない（Enter で次へ）
    if (readingHold) return;
    // 覚え方のメモを書いている間・覚え方を作っている間は進めない（次の語の renderWordNote(null) が書きかけを消す）
    if (isEditingNote() || isMakingWordAi()) {
      advanceTimer = setTimeout(tick, NOTE_RECHECK_MS);
      return;
    }
    advanceNow("timer");
  };
  advanceTimer = setTimeout(tick, wait);
}

// 成長ログ: 覚えた語数のスナップショット（今週+N・30日推移の材料）
function snapshotGrowth() {
  try {
    recordGrowthSnapshot({ ...getLearnedCounts(), legacyLearned: computeLegacyLearnedCount });
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
function celebrateLearned(word, earned, note = "") {
  milestoneThisWord = true; // スタンプ（1.4 秒）が消えるまで次の語を出さない
  sfxSparkle();
  sfxComplete();

  const card = document.getElementById("gameCard");
  if (card) {
    card.classList.remove("game-card--learned");
    void card.offsetWidth;
    card.classList.add("game-card--learned");
    const stamp = document.createElement("div");
    stamp.className = "learn-stamp";
    stamp.textContent = "覚えた";
    card.appendChild(stamp);
    setTimeout(() => stamp.remove(), 1400);
  }

  const jaShort = word.ja.length > 22 ? `${word.ja.slice(0, 22)}…` : word.ja;
  showResult(`覚えた！ ${word.en}（${jaShort}）${earned > 0 ? `  +${earned} XP` : ""}${note}`, "learned", true);

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
    <span class="play-score__combo ${tier ? `play-score__combo--${tier}` : ""}">${combo >= 2 ? `×${combo}` : ""}</span>
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
    group("覚えた（前は出てこなかった語）", learned, "word-chip--learned") +
    group("思い出せた（2回目）", recovered, "word-chip--recovered") +
    group("思い出せず", failed, "word-chip--failed")
  );
}

// 腕試し（初回10語）の結果を1回だけ伝える。答え表示後にも出るよう、少し遅らせて上書きする
function announcePlacement() {
  const p = consumePlacementNote();
  if (!p) return;
  document.body.classList.remove("placement"); // 腕試しが確定した。ここから先の数字は本物（css/home.css）
  const line =
    p.boost >= 2
      ? `腕試し: ${p.total}語中 ${p.known}語 知ってた。難しい単語も最初から混ぜていく`
      : p.boost === 1
        ? `腕試し: ${p.total}語中 ${p.known}語 知ってた。少し難しい単語も混ぜていく`
        : p.known === 0
          ? "腕試し終わり。基本の単語から積み上げる"
          : `腕試し: ${p.total}語中 ${p.known}語 知ってた。まずは基本の単語から積み上げる`;
  setTimeout(() => showMessage(line, "revealed"), 1300);
}

function endStudySession() {
  learnedCardStale = false; // 下で自分で描く（notifyGameEnd で二重に描かない）
  clearInterval(timer);
  isPlaying = false;
  notifyGameEnd();
  setCompletePending = false;
  currentWord = null;
  if (!retryIds) clearSession(); // セットを終えたので「前回の続き」は消す

  const isRetry = !!retryIds;
  retryIds = null;
  const recalled = setRecalled.size;
  const failedIds = [...setFailed].filter((id) => !setRecalled.has(id));
  const failed = failedIds.length;
  const state = isRetry ? { setsToday: getSetsToday() } : markDailySetDone(recalled);
  pushSync();
  window.dispatchEvent(new CustomEvent("spelldash:session-end", { detail: { recalled, failed: failedIds.length, retry: isRetry } })); // ホームの道を描き直す

  // 完了画面: 出題 UI は畳む（body.set-done → css/card.css）。完了の事実は見出し 1 つ、数字は 1 行
  document.body.classList.add("set-done");
  elements.japanese.textContent = "";
  setPromptLabel("");
  showHiddenWordText("");
  const meta = document.getElementById("wordMeta");
  if (meta) meta.textContent = "";
  renderStudyQueue(false);
  renderSetProgress();
  renderLearnedCard();
  renderHasumiHome();

  // 明日までに復習期日が来る語（今日片付けた分は除く）
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(23, 59, 59, 999);
  const dueTomorrow = getDueReviewCount(activeCategory, tomorrow.getTime());
  const dueWords = getDueReviewWords(activeCategory, tomorrow.getTime(), 3);
  const tomorrowLine =
    dueTomorrow > 0
      ? `<div class="result-panel__tomorrow">明日の復習: <b>${dueWords.map((w) => w.en).join("・")}</b>${dueTomorrow > dueWords.length ? ` ほか${dueTomorrow - dueWords.length}語` : ""}</div>`
      : `<div class="result-panel__tomorrow">明日の復習はまだ無い。新しい語から</div>`;

  // 週の目標（学習日数）: ちょうど達成した日だけ一言添える（途中経過の数字は出さない。数字は 1 行の原則）
  const goal = getWeekGoal();
  const activeDays = getActiveDaysThisWeek();
  const goalLine = activeDays === goal ? `<div class="result-panel__goal">今週の目標 ${goal}日 達成</div>` : "";

  const panel = document.getElementById("resultPanel");
  if (panel) {
    const hasumiLine = isRetry
      ? failed === 0
        ? { mood: "happy", text: "全部回収した。" }
        : { mood: "normal", text: "残りは明日また出す。" }
      : hasumiSetLine({ count: recalled, failed, recovered: [...setFailed].filter((id) => setRecalled.has(id)).length, sets: state.setsToday }); // 答えを見てから思い出せた語（再開後も残る setFailed から）
    panel.innerHTML = `
      <h2 class="result-panel__title" id="resultTitle" tabindex="-1">${isRetry ? "回収完了" : "今日のセット完了"}</h2>
      ${hasumiBubbleHtml(hasumiLine, "hasumi--result")}
      <div class="result-panel__grid">
        <div><span>思い出せた</span><strong>${recalled}</strong></div>
        <div><span>思い出せず</span><strong>${failed}</strong></div>
      </div>
      ${renderSetWordChips()}
      ${tomorrowLine}
      ${goalLine}
      <div class="result-panel__actions">
        ${failed > 0 ? `<button type="button" class="result-panel__action" id="setRetry">思い出せなかった${failed}語をもう一度</button>` : ""}
        <button type="button" class="result-panel__action${failed > 0 ? " result-panel__action--ghost" : ""}" id="setAgain">もう1セット</button>
        <button type="button" class="result-panel__action result-panel__action--ghost" id="setChallenge">Challenge（60秒）</button>
        ${canInstall() ? `<button type="button" class="result-panel__action result-panel__action--ghost" id="setInstall">ホーム画面に追加</button>` : ""}
      </div>
    `;
    panel.hidden = false;
    focusResultTitle(panel);
    panel.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    panel.querySelectorAll("[data-speak]").forEach((chip) => chip.addEventListener("click", () => speak(chip.dataset.speak)));
    document.getElementById("setRetry")?.addEventListener("click", () => {
      clearInterval(timer);
      isPlaying = false;
      startGame({ retry: failedIds });
      elements.input.focus();
    });
    document.getElementById("setInstall")?.addEventListener("click", async (event) => {
      const outcome = await promptInstall();
      event.currentTarget.textContent = outcome === "accepted" ? "追加しました" : "ホーム画面に追加";
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

  showMessage(""); // 完了の事実はパネルの見出しが言う
}

// Studyモードは1語ごとに即XP反映（セッションの「終了」がないため）
function applyStudyXp(earned, missionResult, loopResult, learnEvent = null) {
  markActiveToday();
  snapshotGrowth();
  learnedCardStale = true; // プレイ中は畳まれて見えない（css/room.css の body.home--playing）。終わったら notifyGameEnd が描く
  const streak = updateStreak();
  if (streak.isFirstToday) {
    earned += 50;
    renderHeaderStreak();
    renderHasumiHome();
  }

  // シールド獲得（5 日ごとに 1 回きり）: 「覚えた」「レベルアップ」の行が勝っても、音と注記は落とさない
  const shieldNote = streak.earnedShield ? " ・ シールド獲得（1日休んでも切れない）" : "";
  if (streak.earnedShield) sfxSparkle();

  const result = addXp(earned);
  renderLevelBar();

  // 「覚えた！」は他の何より先に祝う（学習が成立した瞬間）
  if (learnEvent === "learned") {
    celebrateLearned(currentWord, earned, shieldNote);
    return;
  }

  if (result.leveledUp) {
    playLevelUpEffect();
    sfxLevelUp();
    // ランクが変わる節目はオーバーレイ 1 つ、それ以外は 1 行。両方は出さない
    if (isPlacementRun() || !celebrateRankUp(result)) {
      showResult(`Lv.${result.after.level} に上がった${unlockNoteForLevel(result.after.level)}${shieldNote}`, "finished", true);
    } else {
      showResult(`思い出せた${shieldNote}`, "correct", !!shieldNote); // 幕が節目。1 行の「思い出せた」は次の語で消す
    }
    return;
  }

  // 連続日数は自力正解のときだけ言う。ただしシールド獲得は答えを見た語でも知らせる
  if (streak.isFirstToday && streak.current >= 2 && (!isRevealed || streak.earnedShield)) {
    showResult(`${streak.current}日連続${shieldNote}`, "correct", true);
    return;
  }

  if (missionResult.justCompleted) {
    sfxComplete();
    showResult(`ミッション達成 +${missionResult.bonusXp} XP`, "correct", true);
    return;
  }

  // New単語を今日4回思い出せた → 静かに定着を伝える
  if (loopResult?.secured) {
    sfxComplete();
    showResult("今日はもう出ない", "correct");
    return;
  }

  // ヒントを見て打てた: 自力ではないが、次に自力で打てる準備はできた
  if (hintUsed && !isRevealed) {
    showResult(`ヒントありで打てた。数問後にもう一度、今度は自力で${earned > 0 ? `  +${earned} XP` : ""}`, "revealed");
    return;
  }

  // 自力正解: 学びの種類ごとに違う言葉で（数字より意味）
  if (!isRevealed) {
    const xp = earned > 0 ? `  +${earned} XP` : "";
    const stat = getWordStats()[currentWord.id];
    if (stat?.mastered) {
      sfxComplete();
      showResult(`${currentWord.en} を習得。10回連続で思い出せた${xp}`, "learned", true);
      return;
    }
    if (learnEvent === "recovered") {
      sfxSparkle();
      showResult(`思い出せた。さっき思い出せなかった ${currentWord.en}`, "correct", true);
      return;
    }
    if (learnEvent === "retained") {
      const days = stat?.lastReviewAt && stat?.history?.length > 1
        ? Math.max(1, Math.round((Date.now() - Date.parse(stat.history[stat.history.length - 2]?.d ?? stat.lastReviewAt)) / 86400000))
        : null;
      showResult(`定着。${days ? `${days}日ぶりでも` : ""}思い出せた${xp}`, "correct");
      return;
    }
    if (learnEvent === "known") {
      showResult(`知ってた。${currentWord.en} は2週間後にもう一度だけ確認${xp}`, "correct", true);
      return;
    }
    const streakCount = stat?.cleanCorrectStreak ?? 0;
    showResult(`思い出せた${streakCount >= 2 ? `（${streakCount}回目）` : ""}${xp}`, "correct");
    return;
  }

  showResult("正解", "correct");
}

// 打ち間違い: 答えは表示しない（覚えていたかどうかとは別のデータとして記録）
function handleTypingMiss(expectedChar = currentWord?.en[currentIndex], typedChar = "") {
  typingMissCount++;
  elements.miss.textContent = typingMissCount;
  hasMissedCurrentWord = true;
  combo = 0;
  updateCombo(0);
  sfxMiss();

  recordTypingMiss(currentWord.id);
  recordKeyMiss(expectedChar, typedChar); // よく間違えるキー（学習データ）

  // 1回でもミスしたら不正解: スペルを表示して打ち直し。
  // 当てずっぽうでの正解到達は「思い出して打つ」の本質ではない（2026-08-15創業者決定）
  if (!isRevealed) {
    revealAnswer(true);
    return;
  }

  // 答え表示後の練習中のミスは表示のみ
  showMessage("違う。もう一度", "wrong");
}

function setNewWord() {
  wordSerial++;
  // Daily: 固定セットを順番に / Study: Recall Loopキュー / Challenge: 重み付き抽選
  if (dailyRun && mode === "challenge") {
    currentWord = dailyRun.words[dailyRun.index % dailyRun.words.length];
    dailyRun.index++;
  } else if (mode === "study") {
    let wordId = nextStudyWordId();
    // 漢字の書き分けのカード（kanjiOnly）は学習に出さない。前回の続き・もう一度の列に残っていても飛ばす
    while (wordId && findWordIn(activeCategory, wordId)?.kanjiOnly) wordId = nextStudyWordId();

    // 苦手のみモードで出題が尽きた = 全部クリア。達成感を演出して終了
    if (!wordId && isWeakOnlyMode()) {
      stopGame();
      showMessage("苦手単語をすべてクリア。明日また確認", "finished");
      return;
    }

    currentWord = (wordId && findWordIn(activeCategory, wordId)) || chooseWord();
    renderStudyQueue(true);
  } else {
    currentWord = chooseWord();
  }

  // 計算カード: 出題のたびに数字を作り直し、この1問だけの答え・解説を持つ複製にする（記録は元のidに乗る）
  if (currentWord.calc) {
    const g = generateCalc(currentWord.calc);
    if (g) currentWord = { ...currentWord, en: g.answer, answer: g.answer, accept: g.accept, q: g.q, explain: g.explain, calcFormula: g.formula };
  }

  // 音で出題: Studyの英単語（概念カード以外）を設定の割合で「聞いて打つ」にする
  listenMode =
    mode === "study" &&
    !isConceptWord(currentWord) &&
    !!speechTextOf(currentWord) &&
    getListenRatio() > 0 &&
    Math.random() * 100 < getListenRatio();

  currentIndex = 0;
  typedSoFar = "";
  // 答えを見た後は出題語だけを練習させる（別解でごまかせないように）
  answerCandidates = answersFor(currentWord);
  hasMissedCurrentWord = false;
  isRevealed = false;
  hintUsed = false;
  hintChars = 0;
  awaitingNext = false;
  milestoneThisWord = false;
  clearTimeout(advanceTimer);
  hideHint();
  renderWordNote(null);
  renderExplain(null);

  // ローマ字モード（日本語の答え）／全文入力モード（英語の用語・読みのない日本語の答え）の切替
  romajiEntries = romajiEntriesFor(currentWord);
  romajiMode = romajiEntries.length > 0;
  romaji = romajiMode ? createRomajiMatcher(romajiEntries) : null;
  freeMode = !romajiMode && isFreeAnswer(currentWord);
  document.body.classList.toggle("romaji-answer", romajiMode);
  setInputRomaji(romajiMode);
  document.body.classList.toggle("free-answer", freeMode);
  document.body.classList.toggle("write-answer", !!currentWord.write); // 画面キーボード: 英文カードは A〜Z＋空白で打てる
  document.getElementById("gameCard")?.classList.toggle("game-card--concept", isConceptWord(currentWord));
  bankWords = currentWord.bank ? buildWordBank(currentWord) : [];
  elements.input.placeholder = currentWord.write
    ? "英文を入力してEnter"
    : currentWord.blank
      ? freeMode ? "空欄の英語を入力してEnter" : "空欄の英語を入力"
      : romajiMode ? "読みをローマ字で（変換しない）" : freeMode ? "答えを入力して Enter（日本語可）" : "英単語を入力";

  // 品詞（pos）があるレベル別パックの語は「日本語訳（動）」のように添える。訳の曖昧さを減らす
  setPromptLabel(
    currentWord.calc
      ? "計算（数字で答える）"
      : listenMode
        ? "音を聞いて打つ（発音 か Ctrl+. でもう一度）"
        : currentWord.write
          ? `${currentWord.bank ? "語を並べ替えて英文を打つ" : "日本語を英文にして打つ"}${currentWord.ja ? `（${currentWord.ja}）` : ""}`
        : currentWord.blank
          ? `空欄に入る英語を打つ${currentWord.ja ? `（${currentWord.ja}）` : ""}`
          : currentWord.school
            ? currentWord.kanjiOnly
              ? "説明に合う語を漢字で答える"
              : romajiMode
                ? "説明に合う語を答える（読みをローマ字で）"
                : "説明に合う語を答える（漢字でも、ひらがなでも可）"
            : isConceptWord(currentWord)
              ? "場面（これは何のこと？）"
            : currentWord.pos
              ? `日本語訳（${currentWord.pos}）`
              : "日本語訳"
  );
  elements.japanese.textContent = listenMode ? "聞いて打つ" : promptOf(currentWord);
  renderPromptContext(listenMode ? null : currentWord);
  if (currentWord.calc) elements.input.placeholder = "数字を入力してEnter（例: 8000 / 5%）";
  showHiddenWordText(
    currentWord.calc
      ? "式を思い出して計算。分からないときは Enter（ヒントで式）"
      : currentWord.bank
        ? `並べ替え: ${bankWords.join(" / ")}`
        : currentWord.write
          ? "英文を打つ（大文字・句読点は不問）。分からないときは Enter"
      : currentWord.blank
        ? "空欄に入る語を英語で。分からないときは Enter で答えを表示"
        : romajiMode
          ? "読みをローマ字で打つ。分からないときは Enter"
          : freeMode
            ? "用語や略語で答える。分からないときは Enter"
            : "分からないときは Enter で答えを表示",
    { hint: !!currentWord.bank }
  );
  if (elements.speakButton) {
    elements.speakButton.hidden = !listenMode;
  }
  if (listenMode) {
    // 150ms のうちに次の語へ進んだら読まない（前の語の発音で答えが漏れない）
    const serial = wordSerial;
    setTimeout(() => {
      if (serial === wordSerial && isPlaying && listenMode) speak(speechTextOf(currentWord));
    }, 150);
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
  window.dispatchEvent(new CustomEvent("spelldash:word", { detail: { id: currentWord.id } })); // 画面キーボード等が盤面を更新する
  saveResumePoint();
}

// 同じ訳の語が同じカテゴリに複数あるとき（見る: see／look／watch など）は、例文の訳を文脈として添える。
// 訳だけでは決まらない語を「当てずっぽう」にしない（英語の綴りは見せない）
function isAmbiguousPrompt(word) {
  if (!word || isConceptWord(word) || word.write || word.blank || word.calc || word.school) return false;
  if (!String(word.ja ?? "").trim()) return false;
  return getWordsByCategory(activeCategory).some((w) => w.id !== word.id && w.en !== word.en && jaLooksSame(word.ja, w.ja));
}

// カード上部のラベル（「日本語訳（動）」など）。完了・停止時は空にする
function setPromptLabel(text) {
  const promptLabel = document.querySelector("#gameCard .label");
  if (promptLabel) promptLabel.textContent = text;
}

function renderPromptContext(word) {
  const el = document.getElementById("promptContext");
  if (!el) return;
  el.textContent = word && word.exJa && isAmbiguousPrompt(word) ? `例文: ${word.exJa}` : "";
}

// 「前回の続きから」用に、いまの語と残りの語・セットの進みを保存（通常の Study セットだけ）
function saveResumePoint() {
  if (mode !== "study" || !isPlaying || !currentWord || retryIds || isPlacementRun()) return;
  saveSession({
    category: activeCategory,
    focus: getFocusGenre(),
    queue: [currentWord.id, ...getUpcomingIds()],
    recalled: [...setRecalled],
    failed: [...setFailed],
    newCount: setNewCount,
    reviewCount: setReviewCount,
    setSize: currentSetSize()
  });
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
    label = "新しい単語";
    currentWordKind = "new";
  } else if (isUnresolved(stat)) {
    const fails = stat.recallFail ?? 0;
    label = fails >= LEECH_FAILS ? `難敵（${fails}回思い出せていない）` : "もう一度（前回は思い出せなかった）";
    currentWordKind = "weak";
  } else if (isLearningToday(stat)) {
    label = `今日の反復 ${Math.min((stat.dailyLearningStage ?? 0) + 1, NEW_WORD_DAILY_SUCCESS_TARGET)}/${NEW_WORD_DAILY_SUCCESS_TARGET}`;
    currentWordKind = "repeat";
  } else if (isReviewDue(stat)) {
    currentWordKind = "review";
    const days = stat.lastRecallSuccessAt
      ? Math.floor((Date.now() - Date.parse(stat.lastRecallSuccessAt)) / 86400000)
      : 0;
    label = days >= 1 ? `${days}日ぶりの復習` : "復習";
  }
  el.textContent = label;
}

function chooseWord() {
  const stats = getWordStats();
  const allowed = allowedWordLevels();

  // 未プレイの単語はプレイヤーレベルで解放（既習語は常に出題対象）。
  // カテゴリ内に解放難易度が無い場合はfilterByAllowedLevelsが最易難易度で救済
  const pool = applyGenre(getWordsByCategory(activeCategory)); // ジャンル絞り込みはChallengeにも効く
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
      // 古い word_stats には missCount 等が無いことがある。NaN にすると Array(NaN) で落ちるので安全に読む
      weight += (Number(data.missCount) || 0) * 3;

      const accuracy = (Number(data.correctCount) || 0) / Math.max(Number(data.playCount) || 0, 1);
      if (accuracy < 0.5) weight += 5;
      if (data.mastered) weight = 1;
      // 復習期日が来ている語はChallengeでも優先（Challengeが復習にもなる）
      if (isReviewDue(data)) weight += 6;
    }

    // 今日のミッション対象は優先的に出題（遊んでいるだけで達成できる）
    if (isMissionWordPending(word.id)) {
      weight += 8;
    }

    return Array(Math.max(1, Math.round(weight) || 1)).fill(word);
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
  notifyGameEnd();
  markActiveToday();
  snapshotGrowth();
  document.body.classList.remove("is-playing");
  document.body.classList.add("set-done"); // 出題 UI を畳んで結果パネルだけにする（css/card.css）
  stopBgm();
  elements.input.disabled = true;
  updateBigTimer();
  renderPlayScore();
  setPromptLabel("");
  elements.japanese.textContent = "";
  showHiddenWordText("");
  renderExplain(null);

  const isDaily = !!dailyRun;
  const previousBest = getBestScore();
  const previousRun = getSessionLog().filter((e) => e.mode === (isDaily ? "daily" : "challenge")).at(-1)?.score ?? null;
  const categoryBestBefore = isDaily ? 0 : getCategoryBest(activeCategory);
  const categoryBestUpdated = isDaily ? false : saveCategoryBest(activeCategory, score);

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
    const more = document.getElementById("homeMore");
    if (more) more.open = true; // 結果とランキングが見える位置に
    // ランキング送信 → 反映後にカードを再描画（未ログイン・テーブル未作成なら静かに無視）
    submitDailyScore({ score, speed: Math.round(speed * 10) / 10 }).finally(() => renderDailyCard());
  }

  saveBestScore(score);
  const isBest = score > 0 && score > previousBest;
  elements.bestScore.textContent = getBestScore();
  updateCombo(0);

  // 今日最初のプレイならストリークボーナス（XP の内訳は書かない。合計は結果パネルの 1 か所）
  const streak = updateStreak();
  if (streak.isFirstToday) {
    gainedXp += 50;
    renderHeaderStreak();
    renderHasumiHome();
  }

  const result = addXp(gainedXp);
  renderLevelBar();

  // シールド獲得（5 日ごとに 1 回きり）は、その日の最初のプレイが Challenge／Daily でも知らせる
  let shieldLine = "";
  if (streak.earnedShield) {
    sfxSparkle();
    shieldLine = `${streak.current}日連続 ・ シールド獲得（1日休んでも切れない）`;
  }

  // 結果の事実はパネルだけに書く（メッセージ行は空にして二重に言わない）
  showMessage("");
  let levelLine = "";
  if (result.leveledUp) {
    playLevelUpEffect();
    sfxLevelUp();
    // ランクが変わる節目はオーバーレイ 1 つ、それ以外はパネルに 1 行。両方は出さない
    if (!celebrateRankUp(result)) levelLine = `Lv.${result.after.level} に上がった${unlockNoteForLevel(result.after.level)}`;
  } else if (isDaily) {
    sfxComplete();
  }
  renderResultPanel({ isDaily, isBest, gainedXp, speed, previousBest, previousRun, categoryBestBefore, categoryBestUpdated, levelLine, shieldLine });
}

// ===== 終了リザルトパネル =====
// メッセージ1行では終了の満足感と次のアクションが弱いため、
// スコア・ベスト更新・次の一手（もう一回/シェア）をカード内に見せる
function renderResultPanel({ isDaily, isBest, gainedXp, speed, previousBest = 0, previousRun = null, categoryBestBefore = 0, categoryBestUpdated = false, levelLine = "", shieldLine = "" }) {
  const panel = document.getElementById("resultPanel");
  if (!panel) return;

  // 見出し 1 つ・数字 1 行。ベストの値は数字の行に入れるので、ここは「更新した」という事実と前回比だけ
  let bestBadge = "";
  if (isBest) {
    bestBadge = `<div class="result-panel__best">ベスト更新</div>`;
  }
  // 前回比（1回ごとの伸び）
  const diff = previousRun != null ? score - previousRun : null;
  if (diff != null) {
    bestBadge += `<div class="result-panel__diff${diff > 0 ? " result-panel__diff--up" : diff < 0 ? " result-panel__diff--down" : ""}">前回 ${previousRun} → ${score}（${diff > 0 ? `+${diff}` : diff === 0 ? "同じ" : diff}）</div>`;
  }
  // カテゴリ別ベスト: 全体ベストと同時には出さない。前の記録を更新したときだけ（初回は何も言わない。「初めての記録」は「ベスト N」と並ぶと矛盾して読める）
  if (!isDaily && !isBest && activeCategory !== "all" && categoryBestUpdated && categoryBestBefore > 0) {
    bestBadge += `<div class="result-panel__cat">このカテゴリのベスト更新</div>`;
  }
  if (levelLine) bestBadge += `<div class="result-panel__level">${levelLine}</div>`;
  if (shieldLine) bestBadge += `<div class="result-panel__level">${shieldLine}</div>`;
  const title = isDaily ? "Daily Dash 結果" : "Challenge 結果";

  const actions = isDaily
    ? `<button type="button" class="result-panel__action" id="resultStudy">苦手を復習</button>`
    : `<button type="button" class="result-panel__action" id="resultRetry">もう一回</button>
       <button type="button" class="result-panel__action result-panel__action--ghost" id="resultStudy">苦手を復習</button>`;

  panel.innerHTML = `
    <h2 class="result-panel__title" id="resultTitle" tabindex="-1">${title}</h2>
    ${bestBadge}
    ${hasumiBubbleHtml(hasumiResultLine({ isBest, isDaily, diff }), "hasumi--result")}
    <div class="result-panel__grid">
      <div><span>スコア</span><strong>${score}</strong></div>
      <div><span>ベスト</span><strong>${getBestScore()}</strong></div>
      <div><span>速度</span><strong>${(Math.round(speed * 10) / 10).toFixed(1)}打/秒</strong></div>
      <div><span>経験値</span><strong>+${gainedXp}</strong></div>
    </div>
    <div class="result-panel__actions">${actions}</div>
  `;
  panel.hidden = false;
  focusResultTitle(panel);

  // 結果は見出しから見せる（scroll-margin-top はヘッダー分。css/card.css）
  panel.scrollIntoView({ behavior: scrollBehavior(), block: "start" });

  document.getElementById("resultRetry")?.addEventListener("click", () => {
    restartGame();
    elements.input.focus();
  });

  document.getElementById("resultStudy")?.addEventListener("click", () => {
    setMode("study");
    startGame();
    elements.input.focus();
  });
}

function getCategoryLabel(id) {
  return getCategories().find((c) => c.id === id)?.label ?? (id === "my" ? "マイ単語帳" : id);
}

// 称号が変わるレベルアップ（F3→F2 等）は節目。大きめのオーバーレイで祝う（画面の語は「レベルアップ」。「ランク」は Battle の RP の制度に取っておく）
function celebrateRankUp(result) {
  if (!result?.leveledUp) return false;
  const beforeTitle = getTitle(result.before.level);
  const afterTitle = result.after.title;
  if (beforeTitle === afterTitle) return false;
  const overlay = document.createElement("div");
  overlay.className = "rank-up";
  overlay.setAttribute("aria-hidden", "true"); // 読み上げは静的な #srStatus（role=status）に流す。後から挿入した live 領域は読まれない
  announce(`レベルアップ: ${beforeTitle} から ${afterTitle}`);
  overlay.innerHTML = `
    <div class="rank-up__inner">
      <div class="rank-up__label">レベルアップ</div>
      <div class="rank-up__title"><span>${beforeTitle}</span><i>→</i><b>${afterTitle}</b></div>
      <div class="rank-up__sub">${unlockNoteForLevel(result.after.level).replace(/^。/, "")}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  milestoneThisWord = true; // 幕（1.2 秒＋消える 0.22 秒）が消えるまで次の語を出さない
  sfxSparkle();
  // 1.2 秒で静かに消える。タップでも閉じられる（次の一手を待たせない）
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.classList.add("rank-up--out");
    setTimeout(() => overlay.remove(), 220);
  };
  // キーボードでも閉じられる（Esc／Enter）。既定動作は妨げない。表示直後の Enter（答え表示→次への連打）では消さない
  const shownAt = performance.now();
  const onKey = (event) => {
    if (event.key === "Enter" && performance.now() - shownAt < 300) return;
    if (event.key === "Escape" || event.key === "Enter") close();
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("pointerdown", close);
  setTimeout(close, 1200);
  return true;
}

// 結果パネルが出たら見出しに焦点（SR に「今日のセット完了」等が伝わり、Tab で次の操作に届く）
function focusResultTitle(panel) {
  const title = panel.querySelector("#resultTitle");
  if (!title) return;
  try {
    title.focus({ preventScroll: true });
  } catch {
    // 無視
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
