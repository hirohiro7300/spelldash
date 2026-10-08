import "./appEnv.js"; // 実行環境（アプリなら html.native-app）
import { elements, initializeDisplay, showMessage, scrollBehavior } from "./ui.js";
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
  startGame,
  stopGame
} from "./game.js";
import { renderDailyCard, isDailyPlayedToday } from "./dailyChallenge.js";
import { isWeakOnlyMode, setWeakOnlyMode, getWeakCount } from "./studyQueue.js";
import { isGamePlaying } from "./game.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { logFunnel } from "./funnelLog.js";
import { getGrowthLog } from "./growthLog.js";
import { renderLevelBar } from "./levelUi.js";
import { renderHasumiHome } from "./hasumi.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { initWordStore } from "./wordStore.js";
import { initializeCategoryPicker } from "./categoryPicker.js";
import { renderLearnedCard } from "./learnedCard.js";
import { renderPath, currentUnitOf, buildPath } from "./pathView.js";
import { renderTodayStrip } from "./homeStrip.js";
import { renderWelcome, dismissWelcome, shouldShowWelcome } from "./welcome.js";
import { initializeKeyboard } from "./keyboard.js";
import { renderPlayModes } from "./playModes.js";
import { ensureDefaultCourse, advanceSection, startCourse, COURSES } from "./course.js";
import { setFocusGenre } from "./studyQueue.js";
import { setGenre } from "./genres.js";
import { resumableFor } from "./sessionResume.js";
import { setupUnloadSync } from "./sync.js";
import { initializeMixControl } from "./studyMix.js";
import "./installPrompt.js"; // beforeinstallprompt を早めに拾う（ホーム画面に追加）
import { renderLoginNudge } from "./loginNudge.js";
import { initTutorial, skipTutorialIfReturning } from "./tutorial.js";
import { initRoom } from "./room.js";
import { initBookshelf, renderBookshelf, updateBookshelf } from "./bookshelf.js";
import { getEnabledPackIds, setPackEnabled } from "./packs.js";
import { getCategories, getPackCatalog } from "./wordStore.js";
import { getGenre, genreLabel } from "./genres.js";
import { getWordStats } from "./storage.js";
import { icon } from "./icons.js";

initializeAuth();
setFooterYear();
initRoom(); // 書斎: PC で机の列を sticky に（js/room.js）
initializeKeyboard(); // 専用キーボード（スマホでプレイ中だけ出る）
renderHeaderStreak();
initTutorial(); // 初回の 1 セットに 1 文ずつ（docs/SPEC_TUTORIAL.md）。既存ユーザーには何も出ない
renderLevelBar();
setupUnloadSync();

// 同期で追加パックの選択が変わったら、語を読み直してカテゴリを作り直す。
// 数える側（覚えた単語・はちゃん）も語が入ってから描き直し、読み直しの終わりを知らせる（js/sync.js は待ってから synced を投げる）
window.addEventListener("spelldash:packs", (event) => {
  if (!event.detail?.synced) return;
  initWordStore().then(() => {
    initializeCategoryPicker();
    renderHome(); // 語が変わったので道も描き直す
    renderLearnedCard();
    renderHasumiHome();
    renderBookshelf(); // 追加済みの本（読みかけ）が変わったので本棚も組み直す
    window.dispatchEvent(new CustomEvent("spelldash:store-ready"));
  });
});

// ログイン済みの人にはトップページ（初めての人向け）を出さない。同期中は道と #authMessage が見える
window.addEventListener("spelldash:auth-ready", (event) => {
  if (event.detail?.loggedIn) dismissWelcome();
});

// 道が見えている間（プレイ前）の Enter は、見えない入力欄でゲームを始めず、道のスタートと同じ動きにする
elements.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  if (document.body.classList.contains("home--playing")) return;
  if (getMode() !== "study") return; // Challenge を選んでいる人の Enter は従来どおり
  if (getGenre()) return; // 単語帳の「このジャンルを練習」で来た人は、その絞り込みのまま始める
  const start = document.getElementById("pathStart");
  if (!start) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  start.click();
});

// クラウド同期でローカルデータが更新されたら表示を作り直す
window.addEventListener("spelldash:synced", () => {
  if (!shouldShowWelcome()) dismissWelcome(); // 記録が届いたらトップページを畳む
  skipTutorialIfReturning(); // 記録が届いた端末では初回の札を出さない
  renderHeaderStreak();
  renderLoginNudge(); // ログイン済みなら案内を消す（「この端末だけにある」を残さない）
  renderLearnedCard();
  renderHome();
  renderLevelBar();
  renderHasumiHome();
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
    card.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  }
}

// ===== 道（ホームの1画面目）: スタート1個でStudy、ほかの遊び方は解放式の一覧 =====
function showGame(show) {
  document.body.classList.toggle("home--playing", show);
  const back = document.getElementById("backToPath");
  if (back) back.hidden = !show;
}

// 道のスタート／復習: 新しく出す語をそのユニットに絞ってStudyを始める（復習はカテゴリ全体から）
function startUnit(unit, opts = {}) {
  setGenre(""); // 手動のジャンル絞り込みは解除（道が代わりに絞る）
  // 今日、同じカテゴリで途中だったセットがあれば続きから（復習ボタンからは新しく）
  const resume = opts.review ? null : resumableFor(localStorage.getItem("spelldash_category") || "all");
  setFocusGenre(resume ? resume.focus ?? "" : unit?.tag ?? "");
  setMode("study");
  stopGame(); // すでに Study 中でも仕切り直す（setMode は同じモードだと何もしない）
  refreshWeakToggle();
  showGame(true);
  if (resume) startGame({ resume });
  else restartGame();
  elements.input.focus({ preventScroll: true });
  scrollGameIntoView();
}

function startChallenge() {
  setFocusGenre("");
  setMode("challenge");
  stopGame(); // Daily Dash の途中でも通常 Challenge として仕切り直す（dailyRun を消す）
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
    document.getElementById("dailyCard")?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
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
    renderLearnedCard(); // カードの行を新しいカテゴリに（語ごとの進捗は残る）
    renderHome();
    renderHasumiHome(); // 節目の一言（セクション全済み）は新しい道には合わないので描き直す
    document.getElementById("pathCard")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  });
}

// コースの乗り換え: まだ制覇していない最初のセクションから（進捗は語ごとなので失われない）
function chooseCourse(courseId) {
  const course = COURSES[courseId];
  if (!course) return Promise.resolve();
  const start = course.packs.find((id) => !buildPath(id).allDone) ?? course.packs[0];
  startCourse(courseId, start);
  setGenre("");
  return initWordStore().then(() => {
    initializeCategoryPicker();
    renderLearnedCard(); // カードの行を新しいカテゴリに（語ごとの進捗は残る）
    renderHome();
    renderHasumiHome(); // 節目の一言（セクション全済み）は新しい道には合わないので描き直す
    document.getElementById("pathCard")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  });
}

// ユニット済みの節目: セット開始時の済みユニットを控えて、終了時に増えていたら完了パネルの見出しの下に 1 行（道には出さない）
let doneUnitsAtStart = null;
window.addEventListener("spelldash:game-start", () => {
  try {
    doneUnitsAtStart = new Set(buildPath().units.filter((u) => u.done).map((u) => u.label));
  } catch {
    doneUnitsAtStart = null;
  }
});

function celebrateNewUnits(path) {
  if (!doneUnitsAtStart || !path) return;
  const fresh = path.units.filter((u) => u.done && !doneUnitsAtStart.has(u.label)).map((u) => u.label);
  doneUnitsAtStart = null;
  if (fresh.length === 0) return;
  const text = path.allDone ? `${path.label} 全章 済み` : `${fresh.map((l) => `「${l}」`).join("")}の章 済み`;
  // 完了パネルは session-end のあとに描かれる（js/game.js）ので、次のフレームで見出しの直後に入れる
  requestAnimationFrame(() => {
    const title = document.querySelector("#resultPanel .result-panel__title");
    if (!title) return;
    title.parentElement.querySelector(".result-panel__unit")?.remove();
    const line = document.createElement("p");
    line.className = "result-panel__unit";
    line.textContent = text;
    title.insertAdjacentElement("afterend", line);
  });
}

function renderHome() {
  const path = renderPath({ onStart: startUnit, onAdvance: goNextSection, onCourse: chooseCourse });
  renderPlayModes({ onChallenge: startChallenge, onDaily: startDaily });
  renderSetupSummary();
  updateBookshelf(); // 机の上の本の空きと読みかけを本棚に（js/bookshelf.js）
  return path;
}

// 本棚の背を押した: その本を机に出す（分野パックはその場で読み込む。追加の手続きは要らない）。
// コースの鍵: 今のコースにその本があれば今のコースのまま、別のコースにだけあれば最初に見つかったコースへ。どのコースにも無い本はコースを触らない
// （柱が棚の名前になるだけ。js/pathView.js）。終わったら机の本へスクロールし、焦点はスタートへ
async function pickBook(id) {
  if (isGamePlaying()) return;
  const category = [...getCategories(), ...getPackCatalog()].find((c) => c.id === id);
  if (!category) return;
  const needsLoad = !!category.pack && !getEnabledPackIds().includes(id);
  if (needsLoad) setPackEnabled(id, true);
  localStorage.setItem("spelldash_category", id);
  const current = COURSES[localStorage.getItem("spelldash_course") || ""];
  const course = current?.packs.includes(id) ? current : Object.values(COURSES).find((c) => c.packs.includes(id));
  if (course) startCourse(course.id, id);
  setGenre("");
  setFocusGenre("");
  if (needsLoad) await initWordStore();
  initializeCategoryPicker(); // 保存したカテゴリを出題側（setActiveCategory）にも反映する
  renderLearnedCard();
  renderHome();
  renderHasumiHome();
  refreshWeakToggle();
  document.getElementById("pathCard")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  document.getElementById("pathStart")?.focus({ preventScroll: true });
}

const backToPath = document.getElementById("backToPath");
if (backToPath) backToPath.innerHTML = `${icon("arrowLeft")}机に戻る`;
backToPath?.addEventListener("click", () => {
  setMode("study");
  stopGame(); // プレイ中のセットは中断する（setMode は同じモードだと止めない）
  showGame(false);
  renderHome();
  window.dispatchEvent(new CustomEvent("spelldash:home")); // 机の本が見えた（チュートリアル js/tutorial.js）
  document.getElementById("pathCard")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  document.getElementById("pathStart")?.focus({ preventScroll: true }); // 「机に戻る」は消えるので、焦点はスタートへ
});

// どの入口から始まっても（Enter キー含む）ゲームカードを出す
window.addEventListener("spelldash:game-start", () => showGame(true));

// セットが終わったら道の数字を更新（結果パネルはそのまま）
window.addEventListener("spelldash:session-end", () => {
  const path = renderHome();
  renderLearnedCard();
  renderTodayStrip(); // チップの「途中」を「済み」に
  celebrateNewUnits(path);
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
  const summary = parts.join(" › ");
  el.textContent = summary;
  // 出題名が道の見出し（コース名）と同じなら、行は「設定」だけに（同じ名前を 2 度言わない。css/home.css）
  const toggle = document.getElementById("setupToggle");
  const pathTitle = document.querySelector("#pathHead .path__title")?.textContent?.trim() ?? "";
  toggle?.classList.toggle("setup-toggle--same", pathTitle !== "" && summary === pathTitle);
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
  // disabled にせず aria-disabled（キーボードで到達でき、押すと理由を伝える）
  const off = weak === 0 && !isWeakOnlyMode();
  button.setAttribute("aria-disabled", String(off));
  button.setAttribute("aria-pressed", String(isWeakOnlyMode()));
}

const weakToggleButton = document.getElementById("weakToggleButton");
if (weakToggleButton) {
  weakToggleButton.addEventListener("click", () => {
    if (weakToggleButton.getAttribute("aria-disabled") === "true") {
      showMessage("苦手な語はまだ無い。思い出せなかった語が出たら、ここで絞れる");
      return;
    }
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
// 初めての人にはトップページ（語の読み込みを待たずに出す。アプリのホームが一瞬見えないように）。
// スタートでそのまま腕試し（机の本の最初の章）へ。積んだ本（または本棚の本）を選んでいたら、その本をパックに足して机に出してから始める。
// spelldash_course は触らない（コース外の本は柱が棚の名前になるだけ。js/pathView.js）。本棚の函（コース）を選んでいたときだけ、そのコースの鍵を回す
const storeReady = initWordStore();
renderWelcome({
  onStart: ({ bookId, courseId } = {}) => storeReady.then(async () => {
    if (courseId && COURSES[courseId]) startCourse(courseId, bookId);
    if (bookId && bookId !== "jhs-english1") {
      if (getPackCatalog().some((c) => c.id === bookId) && !getEnabledPackIds().includes(bookId)) setPackEnabled(bookId, true);
      localStorage.setItem("spelldash_category", bookId);
      await initWordStore();
      initializeCategoryPicker();
    }
    const path = renderHome();
    renderHasumiHome(); // 紙片の「はじめまして」を、机の本に合う文へ
    startUnit(path ? currentUnitOf(path) : null);
  })
});

storeReady
  .then(() => {
    // 動線の計測: 学んだ日が 7 日になった端末（1 回きり。docs/SQL_FUNNEL.md）
    if (getGrowthLog().filter((e) => e.active).length >= 7) logFunnel("day7");
    initializeCategoryPicker();
    renderLearnedCard();
    renderHasumiHome(); // 語の読み込み後に（「今日覚えた」の語を名指しするため）
    renderHome();
    initBookshelf({ onPick: pickBook, onCourse: chooseCourse }); // 本棚（manifest が要るので語の読み込み後）
    renderLoginNudge();
    setSetupOpen(localStorage.getItem(SETUP_OPEN_KEY) === "1");
    initializeMixControl();
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

    // 静的ページ（お知らせ・規約・パック入口）の「ログイン」から来た: ?login=1 でログインのドロップダウンを開く
    const loginUrl = new URL(location.href);
    if (loginUrl.searchParams.get("login") === "1") {
      loginUrl.searchParams.delete("login");
      history.replaceState(null, "", `${loginUrl.pathname}${loginUrl.search}${loginUrl.hash}`);
      // auth.js はセッション確認のあとで #accountGuest を出し、spelldash:auth-ready を投げる。それを待ってから開く
      const openLogin = () => {
        const guest = document.getElementById("accountGuest");
        if (guest && !guest.hidden) document.getElementById("loginToggle")?.click();
      };
      if (!document.getElementById("accountGuest")?.hidden) openLogin();
      else window.addEventListener("spelldash:auth-ready", openLogin, { once: true });
    }
  })
  .catch(() => {
    showMessage("単語データを読み込めなかった", "wrong");
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
        elements.input.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
      }
    }, 120);
  });
}
