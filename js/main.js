import { elements, initializeDisplay, showMessage } from "./ui.js";
import {
  handleKeydown,
  handleTextInput,
  handleBeforeInput,
  handleCompositionStart,
  handleCompositionEnd,
  restartGame,
  setMode,
  getMode,
  speakCurrentWord,
  startDailyGame,
  useHint,
  startGame
} from "./game.js";
import { renderDailyCard, isDailyPlayedToday } from "./dailyChallenge.js";
import { isWeakOnlyMode, setWeakOnlyMode, getWeakCount } from "./studyQueue.js";
import { isGamePlaying } from "./game.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderLevelBar } from "./levelUi.js";
import { renderStreakCard } from "./streakUi.js";
import { renderHasumiHome } from "./hasumi.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { initWordStore } from "./wordStore.js";
import { initializeCategoryPicker } from "./categoryPicker.js";
import { renderLearnedCard } from "./learnedCard.js";
import { renderPath, currentUnitOf } from "./pathView.js";
import { renderWelcome } from "./welcome.js";
import { renderPlayModes } from "./playModes.js";
import { ensureDefaultCourse, advanceSection } from "./course.js";
import { setFocusGenre } from "./studyQueue.js";
import { setGenre } from "./genres.js";
import { renderWeeklyReport } from "./weeklyReport.js";
import { renderMission } from "./mission.js";
import { setupUnloadSync } from "./sync.js";
import { initializeMixControl } from "./studyMix.js";
import "./installPrompt.js"; // beforeinstallprompt を早めに拾う（ホーム画面に追加）
import { renderLoginNudge } from "./loginNudge.js";
import { getCategories } from "./wordStore.js";
import { getGenre, genreLabel } from "./genres.js";
import { getWordStats } from "./storage.js";

initializeAuth();
setFooterYear();
renderHeaderStreak();
renderLevelBar();
renderStreakCard();
renderHasumiHome();
setupUnloadSync();

// 同期で追加パックの選択が変わったら、語を読み直してカテゴリを作り直す
window.addEventListener("spelldash:packs", (event) => {
  if (!event.detail?.synced) return;
  initWordStore().then(() => initializeCategoryPicker());
});

// クラウド同期でローカルデータが更新されたら表示を作り直す
window.addEventListener("spelldash:synced", () => {
  renderLearnedCard();
  renderHome();
  renderLevelBar();
  renderStreakCard();
  renderHasumiHome();
  renderMission();
  initializeDisplay();
});

elements.input.addEventListener("keydown", handleKeydown);
// モバイル（ソフトキーボード）: keydownで文字が取れない環境用
elements.input.addEventListener("beforeinput", handleBeforeInput);
elements.input.addEventListener("input", handleTextInput);
// 日本語IME対策: 変換中はvalueに触らず、確定時にまとめて処理
elements.input.addEventListener("compositionstart", handleCompositionStart);
elements.input.addEventListener("compositionend", handleCompositionEnd);
elements.restart.addEventListener("click", restartGame);

if (elements.speakButton) {
  elements.speakButton.addEventListener("click", () => {
    speakCurrentWord();
    elements.input.focus();
  });
}

// ヒント（Study）: 迷った時に次の1文字だけ。見た時点で×扱い
document.getElementById("hintButton")?.addEventListener("click", () => {
  useHint();
  elements.input.focus();
});

// モバイルではモード選択後にゲームカードが画面外に残るため、見える位置へ寄せる
// （すでに十分見えているデスクトップ等では何もしない）
function scrollGameIntoView() {
  const card = document.getElementById("gameCard");
  if (!card) return;
  const top = card.getBoundingClientRect().top;
  if (top < 0 || top > window.innerHeight * 0.35) {
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ===== 道（ホームの1画面目）: スタート1個でStudy、ほかの遊び方は解放式の一覧 =====
function showGame(show) {
  document.body.classList.toggle("home--playing", show);
  const back = document.getElementById("backToPath");
  if (back) back.hidden = !show;
}

// 道のスタート／復習: 新しく出す語をそのユニットに絞ってStudyを始める（復習はカテゴリ全体から）
function startUnit(unit) {
  setGenre(""); // 手動のジャンル絞り込みは解除（道が代わりに絞る）
  setFocusGenre(unit?.tag ?? "");
  setMode("study");
  refreshWeakToggle();
  showGame(true);
  restartGame();
  elements.input.focus({ preventScroll: true });
  scrollGameIntoView();
}

function startChallenge() {
  setFocusGenre("");
  setMode("challenge");
  refreshWeakToggle();
  showGame(true);
  restartGame();
  elements.input.focus({ preventScroll: true });
  scrollGameIntoView();
}

function startDaily() {
  if (isDailyPlayedToday()) {
    const more = document.getElementById("homeMore");
    if (more) more.open = true;
    document.getElementById("dailyCard")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  setFocusGenre("");
  showGame(true);
  startDailyGame();
  elements.input.focus({ preventScroll: true });
  scrollGameIntoView();
}

// 次のセクション（コースの次のパック）へ: パックを追加して語を読み直し、道を描き直す
function goNextSection() {
  const next = advanceSection(localStorage.getItem("spelldash_category") || "");
  if (!next) return;
  initWordStore().then(() => {
    initializeCategoryPicker();
    renderHome();
    document.getElementById("pathCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderHome() {
  const path = renderPath({ onStart: startUnit, onAdvance: goNextSection });
  renderPlayModes({ onChallenge: startChallenge, onDaily: startDaily });
  renderSetupSummary();
  return path;
}

document.getElementById("backToPath")?.addEventListener("click", () => {
  setMode("study");
  showGame(false);
  renderHome();
  document.getElementById("pathCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// どの入口から始まっても（Enter キー含む）ゲームカードを出す
window.addEventListener("spelldash:game-start", () => showGame(true));

// セットが終わったら道の数字を更新（結果パネルはそのまま）
window.addEventListener("spelldash:session-end", () => {
  renderHome();
  renderLearnedCard();
});

// ===== 出題設定（カテゴリ・ジャンル・苦手のみ・比率）は普段は畳む。要約1行だけ見せる =====
const SETUP_OPEN_KEY = "spelldash_setup_open";

function renderSetupSummary() {
  const el = document.getElementById("setupSummary");
  if (!el) return;
  const categoryId = localStorage.getItem("spelldash_category") || "all";
  const label = categoryId === "all" ? "すべて" : getCategories().find((c) => c.id === categoryId)?.label ?? categoryId;
  const parts = [label];
  if (getGenre()) parts.push(genreLabel(getGenre()));
  if (isWeakOnlyMode()) parts.push("苦手のみ");
  el.textContent = parts.join(" › ");
}

function setSetupOpen(open) {
  const panel = document.getElementById("setupPanel");
  const toggle = document.getElementById("setupToggle");
  if (!panel || !toggle) return;
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.classList.toggle("setup-toggle--open", open);
  localStorage.setItem(SETUP_OPEN_KEY, open ? "1" : "0");
}

document.getElementById("setupToggle")?.addEventListener("click", () => {
  const panel = document.getElementById("setupPanel");
  setSetupOpen(panel?.hidden !== false);
});
window.addEventListener("spelldash:genre", renderSetupSummary);

// 戻ってきた人にはキャッチコピーの説明文を出さない（1画面目を「今日のセット」に寄せる）
if (Object.keys(getWordStats()).length > 0) document.body.classList.add("returning");

// ===== 苦手のみ復習トグル（Studyモード限定） =====
function refreshWeakToggle() {
  const button = document.getElementById("weakToggleButton");
  const count = document.getElementById("weakToggleCount");
  if (!button || !count) return;

  button.classList.toggle("weak-toggle__btn--on", isWeakOnlyMode());
  const weak = getWeakCount();
  count.textContent = weak > 0 ? `${weak}語` : "0語";
  button.disabled = weak === 0 && !isWeakOnlyMode();
}

const weakToggleButton = document.getElementById("weakToggleButton");
if (weakToggleButton) {
  weakToggleButton.addEventListener("click", () => {
    setWeakOnlyMode(!isWeakOnlyMode());
    refreshWeakToggle();
    renderSetupSummary();
    // プレイ中なら新しいプールでキューを作り直す
    if (isGamePlaying() && getMode() === "study") {
      restartGame();
    }
  });
}

// カテゴリ変更後に苦手数を更新（描画後に反映されるよう次のtickで）
document.getElementById("categoryPicker")?.addEventListener("click", () => {
  setTimeout(() => {
    refreshWeakToggle();
    setFocusGenre("");
    renderHome();
  }, 0);
});

// 初めての人には既定のコース（中学英語やり直し）を敷いてから語を読む
ensureDefaultCourse();

// 単語データを読み込んでからゲームを有効化
initWordStore()
  .then(() => {
    initializeCategoryPicker();
    renderLearnedCard();
    const path = renderHome();
    // 初めての人にはトップページ。「無料で始める」でそのまま腕試し（道の最初のユニット）へ
    renderWelcome({ onStart: () => startUnit(path ? currentUnitOf(path) : null) });
    renderLoginNudge();
    setSetupOpen(localStorage.getItem(SETUP_OPEN_KEY) === "1");
    // 週間レポート: 日曜・月曜だけホームに（それ以外は学習データで見られる）
    const dow = new Date().getDay();
    const weeklyHome = document.getElementById("weeklyHome");
    if (weeklyHome && (dow === 0 || dow === 1 || location.search.includes("weekly=1"))) {
      weeklyHome.hidden = false;
      renderWeeklyReport("weeklyHome", { compact: true });
    }
    initializeMixControl();
    renderMission();
    renderDailyCard(() => {
      startDailyGame();
      elements.input.focus();
    });
    initializeDisplay();
    setMode(getMode());
    refreshWeakToggle();

    // 単語帳の「苦手だけ練習」: ?words=id1,id2 でその語だけのセッションを始める
    const wordsParam = new URLSearchParams(location.search).get("words");
    if (wordsParam) {
      const ids = wordsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
      if (ids.length > 0) {
        setMode("study");
        showGame(true);
        startGame({ retry: ids });
        elements.input.focus({ preventScroll: true });
        scrollGameIntoView();
        history.replaceState(null, "", location.pathname);
      }
    }
  })
  .catch(() => {
    showMessage("単語データの読み込みに失敗しました。", "wrong");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reload-button";
    button.textContent = "再読み込み";
    button.addEventListener("click", () => location.reload());
    elements.message.append(" ", button);
  });

// スマホ: ソフトキーボードが開いて入力欄が隠れたら見える位置へ寄せる
if (window.visualViewport) {
  let recenterTimer = null;
  window.visualViewport.addEventListener("resize", () => {
    if (window.innerWidth > 560 || document.activeElement !== elements.input) return;
    clearTimeout(recenterTimer);
    recenterTimer = setTimeout(() => {
      const rect = elements.input.getBoundingClientRect();
      const visibleBottom = window.visualViewport.height + window.visualViewport.offsetTop;
      if (rect.bottom > visibleBottom - 8 || rect.top < 0) {
        elements.input.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 120);
  });
}
