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
import { renderPath, currentUnitOf, buildPath, renderFocusPath } from "./pathView.js";
import { renderTodayStrip } from "./homeStrip.js";
import { renderWelcome, dismissWelcome, shouldShowWelcome, isWelcomeOpen } from "./welcome.js";
import { initializeKeyboard } from "./keyboard.js";
import { renderPlayModes } from "./playModes.js";
import { ensureDefaultCourse, advanceSection, startCourse, COURSES } from "./course.js";
import { setFocusGenre } from "./studyQueue.js";
import { setGenre } from "./genres.js";
import { resumableFor } from "./sessionResume.js";
import { setupUnloadSync, isPulling } from "./sync.js";
import { initializeMixControl } from "./studyMix.js";
import "./installPrompt.js"; // beforeinstallprompt を早めに拾う（ホーム画面に追加）
import { renderLoginNudge } from "./loginNudge.js";
import { initTutorial, skipTutorialIfReturning, isTutorialRunPending } from "./tutorial.js";
import { getSetLength, setSetSize, isTimedSet } from "./dailySet.js";
import { initRoom } from "./room.js";
import { initBookshelf, renderBookshelf, updateBookshelf, holdShelf, releaseShelf, startShelf, startChoiceChanges, rememberCourse } from "./bookshelf.js";
import { getEnabledPackIds, setPackEnabled } from "./packs.js";
import { getCategories, getPackCatalog } from "./wordStore.js";
import { getGenre, genreLabel } from "./genres.js";
import { getWordStats, loadLearnStates, learnStateSource, recordsEpoch } from "./storage.js";
import { icon } from "./icons.js";
import { countLearnStates, learnDayOf } from "./learnState.js";
import { readRankPeak, raiseRankPeak, rankFor } from "./rank.js";
import { isFocusOn, applyFocusFlag, takeOldHomeUrl, LEARN_NEXT_URL } from "./focus.js";

// 英単語の学習に絞ったホーム（js/focus.js。Batch 78 段 5）: 旗が立っている間は、旧の面（机の本の章とコース・本棚・ほかの遊び方・Daily の札・
// 出題の設定・前の数え方の「覚えた単語」・はちゃんの紙片・連続日数）を描かず、「英単語を学ぶ」1 つと覚えた N ／総数・ランク・学習状況へだけ（renderFocusHome）。
// 旗が無ければ前のまま（下の !FOCUS の道。コードと保存の鍵は残す）
const FOCUS = isFocusOn();
applyFocusFlag();

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
    if (FOCUS) {
      // 英単語の学習に絞ったホーム: 教材の選択・本棚・はちゃんの紙片は描かない（数は 3 状態の材料から: renderFocusHome）
      renderHome();
      window.dispatchEvent(new CustomEvent("spelldash:store-ready"));
      return;
    }
    initializeCategoryPicker();
    renderHome(); // 語が変わったので道も描き直す
    renderLearnedCard();
    renderHasumiHome();
    renderBookshelf(); // 届いたパック・外したパックを本棚にも（js/bookshelf.js が照合する）
    window.dispatchEvent(new CustomEvent("spelldash:store-ready"));
  });
});

// ログイン済みの人にはトップページ（初めての人向け）を出さない。同期中は道と #authMessage が見える
window.addEventListener("spelldash:auth-ready", (event) => {
  if (event.detail?.loggedIn) dismissWelcome();
});

// 道が見えている間（プレイ前）の Enter は、見えない入力欄でゲームを始めず、道のスタートと同じ動きにする。
// 英単語の学習に絞ったホームでは、保存した遊び方（Challenge）・単語帳のジャンルに関わらず「英単語を学ぶ」（見えない入力欄で Study・Challenge を始めない）
elements.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  if (document.body.classList.contains("home--playing")) return;
  if (!FOCUS && getMode() !== "study") return; // Challenge を選んでいる人の Enter は従来どおり
  if (!FOCUS && getGenre()) return; // 単語帳の「このジャンルを練習」で来た人は、その絞り込みのまま始める
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
  if (!FOCUS) renderLearnedCard();
  renderHome();
  renderLevelBar();
  if (!FOCUS) renderHasumiHome();
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
  // 今日、同じカテゴリで途中だったセットがあれば続きから（復習ボタンからは新しく）。
  // 今日のセットの長さが 60 秒なら続きを見ずに 60 秒の回を始める（spelldash_session には触れない。長さを語数に戻すと続きが出る。
  // チュートリアルの回は語数で走るので続きを見る。js/pathView.js の右頁の文と同じ判定）
  const timed = isTimedSet() && !isTutorialRunPending();
  const resume = opts.review || timed ? null : resumableFor(localStorage.getItem("spelldash_category") || "all");
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

// コースの乗り換え: まだ制覇していない最初のセクションから（進捗は語ごとなので失われない）。
// focusStart: 本棚の函から来たとき、焦点を机のスタートへ（背を押したときの pickBook と同じ着地）。選んだコースの函は本棚に（rememberCourse）
function chooseCourse(courseId, { focusStart = false } = {}) {
  const course = COURSES[courseId];
  if (!course) return Promise.resolve();
  const start = course.packs.find((id) => !buildPath(id).allDone) ?? course.packs[0];
  startCourse(courseId, start);
  rememberCourse(courseId);
  setGenre("");
  return initWordStore().then(() => {
    initializeCategoryPicker();
    renderLearnedCard(); // カードの行を新しいカテゴリに（語ごとの進捗は残る）
    renderHome();
    renderHasumiHome(); // 節目の一言（セクション全済み）は新しい道には合わないので描き直す
    document.getElementById("pathCard")?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    if (focusStart) document.getElementById("pathStart")?.focus({ preventScroll: true });
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
  if (FOCUS) {
    renderFocusHome();
    return null; // 章の節目（celebrateNewUnits）は無い
  }
  const path = renderPath({ onStart: startUnit, onAdvance: goNextSection, onCourse: chooseCourse });
  renderPlayModes({ onChallenge: startChallenge, onDaily: startDaily });
  renderSetupSummary();
  updateBookshelf(); // 本棚を照合して描き直す（机の本の空き・いまのコース・届いたパック。js/bookshelf.js）
  return path;
}

// 本棚の背を押した: その本を机に出す（分野パックはその場で読み込む。「本を足す」で棚に足しただけでは読み込まない）。
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
  setMode("study", { save: !FOCUS }); // 英単語の学習に絞ったホームは、保存した遊び方（Challenge）を書き換えない
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
  if (!FOCUS) renderLearnedCard();
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
  if (isTimedSet()) parts.push("60秒"); // 今日のセットの長さが 60 秒（すべて › 60秒）
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

// 今日のセットの長さ（設定ページの #setSizeSelect と同じ値を読み書きする）。変えたら道の右頁と要約、はちゃんの紙片を描き直す
// （60 秒に替えると続きの文とボタンは消えるので、紙片も「続きから。」と言わない。SPEC_MASTERY §4.8）。
// プレイ中に変えても今の回は変わらない（js/game.js が回の始めに 1 度だけ決める）。次の回から効く。
// 履歴で戻ったとき: select の autocomplete="off"（index.html）でブラウザのフォームの復元を止め、bfcache で戻すブラウザでは
// pageshow で保存値と見比べて描き直す（設定ページで長さを替えてから戻ると、古い値が出ていた）
{
  const select = document.getElementById("setLengthSelect");
  if (select) {
    const renderLength = () => {
      renderHome();
      renderHasumiHome();
    };
    select.value = getSetLength();
    select.addEventListener("change", () => {
      setSetSize(select.value);
      renderLength();
    });
    window.addEventListener("pageshow", (e) => {
      if (!e.persisted || select.value === getSetLength()) return;
      select.value = getSetLength();
      renderLength();
    });
  }
}
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

// 初めての人には既定のコース（中学英語やり直し）を敷いてから語を読む（英単語の学習に絞ったホームでは敷かない: 本・コースを選ばせない）
if (!FOCUS) ensureDefaultCourse();

// 単語データを読み込んでからゲームを有効化
// 初めての人にはトップページ（語の読み込みを待たずに出す。アプリのホームが一瞬見えないように）。
// スタートでそのまま腕試し（机の本の最初の章）へ。積んだ本（または「173冊から選ぶ」の本）を選んでいたら、その本をパックに足して机に出してから始める。
// spelldash_course は触らない（コース外の本は柱が棚の名前になるだけ。js/pathView.js）。函（コース）を選んでいたときだけ、そのコースの鍵を回す。
// 何を替えるかは本棚が下見の棚と同じ規則で求める（startChoiceChanges → js/shelfStore.js applyStartChoice）。ここはそのとおりに書くだけ。
// 状態を替えたあとで本棚を作る（startShelf: 下見と同じ棚。js/bookshelf.js）。押してからそれまで本棚は保存しない（holdShelf。語の読み込みを待つ間も）
const storeReady = initWordStore();
renderWelcome({
  // 英単語の学習に絞ったホーム: 「英単語を学ぶ」は中心の学習の入口へ（初めての人は これから の 1 語目から。js/learnQueue.js resolveNextMode）
  onStart: FOCUS ? () => location.assign(LEARN_NEXT_URL) : (choice = {}) => {
    holdShelf();
    return storeReady.then(async () => {
      const change = startChoiceChanges(choice);
      if (change.course) localStorage.setItem("spelldash_course", change.course);
      for (const id of change.packs) setPackEnabled(id, true);
      if (change.desk) localStorage.setItem("spelldash_category", change.desk);
      if (change.packs.length || change.desk) {
        await initWordStore();
        initializeCategoryPicker();
      }
      startShelf();
      const path = renderHome();
      renderHasumiHome(); // 紙片の「はじめまして」を、机の本に合う文へ
      startUnit(path ? currentUnitOf(path) : null);
    }).catch((err) => {
      releaseShelf(); // startShelf の前に落ちたら保留を解く（自動の保存が再読み込みまで止まらないように）
      throw err;
    });
  }
});

// 英単語の学習に絞ったホームの数（覚えた N ／総数・ランク・次に学ぶ状態）。学習状況（js/statsView.js）と同じ材料と決まり（js/learnPace.js learnStatusOf・
// js/learnQueue.js resolveNextMode）。描き直しが重なったら最後の 1 回だけ描く。材料が読めなければ数は出さない（ボタンは /?learn=next のまま）
let focusSeq = 0;
function renderFocusHome() {
  // 初めての人の本が開いている間は数の材料を読まない（机は見えず、「英単語を学ぶ」でページを移る。初めの読み込みを軽くする）。
  // 本が閉じたら（ログイン・同期で記録が届いた）読んで描く
  if (isWelcomeOpen()) {
    renderFocusHomeAfterWelcome();
    return;
  }
  const seq = ++focusSeq;
  const epoch = recordsEpoch();
  loadFocusView()
    .then((view) => {
      if (seq !== focusSeq) return;
      renderFocusPath(view);
      if (view && view.computed > (readRankPeak() ?? -1)) raiseFocusPeakLater(epoch);
    })
    .catch(() => {
      if (seq === focusSeq) renderFocusPath(null);
    });
}

let welcomeWatch = null;
function renderFocusHomeAfterWelcome() {
  if (welcomeWatch) return;
  welcomeWatch = new MutationObserver(() => {
    if (isWelcomeOpen()) return;
    welcomeWatch.disconnect();
    welcomeWatch = null;
    renderFocusHome();
  });
  welcomeWatch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

async function loadFocusView() {
  const source = await loadLearnStates();
  if (!source) return null;
  const [P, Q] = await Promise.all([import("./learnPace.js"), import("./learnQueue.js")]);
  const status = P.learnStatusOf({ table: getWordStats(), source, peak: readRankPeak(), today: learnDayOf(Date.now()) });
  const mode = Q.resolveNextMode(status.counts, status.due);
  return { ...status, mode, setSize: Q.LEARN_SET_SIZE[mode], doneToday: P.UNSURE_DONE_TODAY };
}

// 見せたランク（今の語数の段が最高到達ランクより上）を最高到達ランクに残す（後で下げない: 決定 §5）。学習状況（js/statsView.js raisePeakLater）と
// 同じ守り: 別のタスクで今の記録から数え直して書く・取り込みの途中は待つ・ほかのタブで記録が置き換わったら書かない
const FOCUS_PEAK_RETRY_MS = 500;
let focusPeakTimer = null;
function raiseFocusPeakLater(epoch) {
  clearTimeout(focusPeakTimer);
  const attempt = () => {
    focusPeakTimer = null;
    if (epoch !== recordsEpoch()) return;
    if (isPulling()) {
      focusPeakTimer = setTimeout(attempt, FOCUS_PEAK_RETRY_MS);
      return;
    }
    const source = learnStateSource();
    if (!source) return;
    const { learned } = countLearnStates(getWordStats(), source.vocab, source.pending);
    raiseRankPeak(rankFor(learned, source.vocab.total));
  };
  focusPeakTimer = setTimeout(attempt, 0);
}

// 英単語の学習に絞ったホーム: 古い URL（?words= ?add= ?category= と ?from=old）の引数を外して 1 行を出し（js/focus.js。値は使わない）、
// 数は語の読み込みを待たずに 3 状態の材料から入れる。初回の本の判定（renderWelcome）は外す前の URL で行う（<head> の 1 行と同じ答えにする）
if (FOCUS) {
  takeOldHomeUrl();
  renderHome();
  // 何も選んでいないとき（焦点が body）の Enter は「英単語を学ぶ」（初めての人の本が開いていればその「英単語を学ぶ」）。説明を読まずに始められる
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (document.body.classList.contains("home--playing")) return;
    const start = document.body.classList.contains("welcome-open") ? document.querySelector("#welcome [data-welcome-start]") : document.getElementById("pathStart");
    if (!start) return;
    event.preventDefault();
    start.click();
  });
}

storeReady
  .then(() => {
    // 一冊を終えるまでの目安の日次記録（端末だけ。Study の回の終わりに机の本を数える。答えの道の外）。英単語の学習に絞ったホームでは書かない
    // （spelldash_book_pace は消さずに残す。学習状況の目安は中心の学習の「初めて覚えた」の印から: js/learnPace.js）
    if (!FOCUS) import("./bookPace.js").then((m) => m.watchBookPace()).catch(() => {});
    // 動線の計測: 学んだ日が 7 日になった端末（1 回きり。docs/SQL_FUNNEL.md）
    if (getGrowthLog().filter((e) => e.active).length >= 7) logFunnel("day7");
    if (FOCUS) {
      renderLoginNudge();
      initializeDisplay();
      setMode("study", { save: false }); // 保存した遊び方が Challenge でも、ホームは中心の学習（盤面は Study。値は残す）
      openLoginFromUrl();
      return;
    }
    initializeCategoryPicker();
    renderLearnedCard();
    renderHasumiHome(); // 語の読み込み後に（「今日覚えた」の語を名指しするため）
    renderHome();
    initBookshelf({ onPick: pickBook, onCourse: (id) => chooseCourse(id, { focusStart: true }) }); // 本棚（manifest が要るので語の読み込み後）
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

    openLoginFromUrl();
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

// 静的ページ（お知らせ・規約・パック入口）の「ログイン」から来た: ?login=1 でログインのドロップダウンを開く
function openLoginFromUrl() {
  const loginUrl = new URL(location.href);
  if (loginUrl.searchParams.get("login") !== "1") return;
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
