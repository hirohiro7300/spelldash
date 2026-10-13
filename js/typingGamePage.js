// ===== タイピングゲーム（/typing-game.html）の配線: 状態・描画・持ち時間の線・キー・時間・計測（docs/SPEC_TYPING_GAME.md） =====
//
// 状態（#tgBoard[data-state]）: ready（始まる前）→ running（打っている間）→ result（結果）。loading（教材待ち）・error（読めない）。
// キーの振り分け・扱わない場所・焦点・画面キーボード・結果の守りは js/typingKeys.js（タイピング練習 typing.html と共有）。違いは文ごとの持ち時間:
//   締切のあとに届いたキーは捨てる、流れてから FLOW_GRACE_MS の間は新しい文として通らないキーを数えない、キーの時刻は押した瞬間（eventTime）。
// 状態を変えるのは run.settle と run.press だけ（js/typingGame.js）。時計（rAF 1 本と、次の締切のタイムアウト 1 本）は settle を呼ぶだけ。
// 学習記録（単語の記録・SRS・XP・連続日数・苦手なキー）とタイピング練習の自己ベストは読まない・書かない。
// 書くのは自己ベスト（spelldash_typing_game）と計測（js/funnelLog.js）だけ。

import "./appEnv.js"; // アプリならセーフエリア
import "./staticHeader.js"; // ヘッダー右端（連続日数・ログイン／設定）
import { setFooterYear } from "./footer.js";
import { initializeKeyboard } from "./keyboard.js";
import { markTypingArrival, logTypingStage } from "./funnelLog.js";
import { localDay } from "./retentionCalc.js";
import { writeLive } from "./srLive.js";
import {
  touch,
  storage,
  eventTime,
  make,
  fill,
  appendUnits,
  validPairs,
  modalOpen,
  focusInput as focusOn,
  closeKeyboard,
  fitAboveKeyboard,
  createResultGuard,
  wireTyping,
  sep,
  choiceFromUrl,
  startChoice,
  rememberChoice,
  reopenLink
} from "./typingKeys.js";
import {
  SETTLE_SLACK_MS,
  FIRST_SENTENCES,
  COURSE_KEY,
  DEFAULT_COURSE,
  COURSES,
  COURSE_IDS,
  isCourse,
  secondsFrom,
  limitSecondsFrom,
  limitMs,
  goalFor,
  shuffleCourse,
  createGameRun,
  summarizeGame,
  readGameBest,
  compareGameBest,
  writeGameBest
} from "./typingGame.js";

// head の theme の 1 行は localStorage が投げると data-theme を付けずに止まる。皮（html[data-theme] で始まる規則）が外れないよう補う
if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = "light";

const $ = (id) => document.getElementById(id);
const el = {
  board: $("tgBoard"),
  head: document.querySelector("#tgBoard .tg-head"),
  got: $("tgGot"),
  timer: $("tgTimer"),
  play: $("tgPlay"),
  term: $("tgTerm"),
  word: $("tgWord"),
  reading: $("tgReading"),
  barFill: $("tgBarFill"),
  hint: $("tgHint"),
  error: $("tgError"),
  input: $("input"),
  result: $("tgResult"),
  kind: $("tgKind"),
  mainLine: $("tgMainLine"),
  gotNum: $("tgGotNum"),
  unit: $("tgUnit"),
  goal: $("tgGoal"),
  line: $("tgLine"),
  best: $("tgBest"),
  nudge: $("tgNudge"),
  again: $("tgAgain"),
  live: $("tgLive"),
  tabNote: $("tgTabNote"),
  tabs: [...document.querySelectorAll("#tgTabs [data-course]")]
};

const seconds = secondsFrom(location.search);
const limitSec = limitSecondsFrom(location.search); // ?s=N（E2E）: 文ごとの持ち時間を一律に。その回は自己ベストに書かない
const span = `${seconds}秒`;
const guard = createResultGuard();
const ANNOUNCE_GAP_MS = 50; // 読み上げの行を空にしてから書くまで（同じ文を同じタスクで書き直すと読まれない環境がある）
const reduced = (() => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
})();

// 開くコース: head の inline script が決めた html[data-typing-course]（?course= → 覚えたコース → ふつうの文。Batch 65 P2）から始める
// （ふつうの文を一度描いてから替えない。不正な値は飛ばす。head の 1 行が動かなかったときだけ同じ順で自分で読む。js/typingKeys.js startChoice）。
// courseParam: ?course= の正しい値（深いリンクで来た回の計測。覚えない）。値はコースの id の一覧で見る（PR #166 のレビュー 4: COURSES[c] の引きは
// ?course=constructor・__proto__ を正しい値と読み、tgame_link を送っていた）
const COURSE_CHOICE = { key: COURSE_KEY, param: "course" };
const courseParam = choiceFromUrl(COURSE_IDS, "course");
const START_COURSE = startChoice({ ids: COURSE_IDS, preset: document.documentElement.dataset.typingCourse, fromUrl: courseParam, key: COURSE_KEY, fallback: DEFAULT_COURSE });

let phase = "ready"; // ready | running | result | loading | error
let course = START_COURSE;
let data = null; // null = まだ届いていない／false = 取れなかった／{ short, normal, long }
let firstRun = true;
let run = null;
let fillOnLoad = false; // 教材が届く前に始めた最初の回（最初の文だけ）: 届いたら列の後ろに足す
let shownSecs = -1;
let shownRatio = -1;
let clockTimer = 0;
let rafId = 0;
let announceTimer = 0;

const focusInput = () => focusOn(el.input);

// 待っている「次の文」を捨てる（結果の 1 文・始まる前の空・読み込めない画面を上書きしない）
function cancelAnnounce() {
  clearTimeout(announceTimer);
  announceTimer = 0;
}

// 読み上げの行に書く（js/srLive.js: ご意見の窓が開いている間は窓の中の行へ。背後は inert で #tgLive は読まれない。js/ui.js announce と同じ判定。Batch 66 R1）
function setLive(text) {
  cancelAnnounce();
  if (el.live) writeLive(el.live, text);
}

// 同じ文が続けて書かれると読まれない読み上げ環境があるので、空にしてから次のタスクで書く（2 回目以降の「次の文」も読まれる）
function announce(text) {
  setLive("");
  announceTimer = setTimeout(() => {
    announceTimer = 0;
    if (el.live) writeLive(el.live, text);
  }, ANNOUNCE_GAP_MS);
}

// ---- 描く ----

// かなの単位 2 段・手本・打ったキー・ミスの印（単位は js/typingKeys.js の appendUnits。typing.html の日本語と同じ）
function renderWord() {
  const current = run?.current ?? null;
  const w = el.word;
  w.replaceChildren();
  if (!current) {
    w.className = "tp-word tp-word--ja";
    w.dataset.rest = "";
    if (phase === "loading" || phase === "running") w.append(make("span", "tp-loading", "読み込み中"));
    el.term.textContent = ""; // 行の高さ（min-height）は残す
    el.reading.textContent = "";
    return;
  }
  w.className = run.missPending ? "tp-word tp-word--ja tp-miss" : "tp-word tp-word--ja";
  const { units, rest } = current.view();
  appendUnits(w, units);
  w.dataset.rest = rest;
  el.term.textContent = current.term;
  el.reading.textContent = current.reading;
}

function renderTimer() {
  if (phase === "running" && run?.started) {
    const left = Math.max(0, Math.ceil((run.endAt - performance.now()) / 1000));
    shownSecs = left;
    el.timer.textContent = `残り ${left}秒`;
  } else el.timer.textContent = `残り ${seconds}秒`;
}

function setBar(ratio) {
  shownRatio = ratio;
  el.barFill.style.transform = ratio === 1 ? "" : `scaleX(${ratio})`;
}

function render() {
  el.board.dataset.state = phase;
  el.board.dataset.course = course;
  el.board.dataset.got = String(run?.got ?? 0);
  el.board.dataset.lost = String(run?.lost ?? 0);
  const result = phase === "result";
  el.head.hidden = result || phase === "error"; // 読み込めないときは「残り 90秒」「取れた」を残さない
  el.play.hidden = result;
  el.result.hidden = !result;
  if (result) return;
  renderTimer();
  el.got.querySelector("b").textContent = String(run?.got ?? 0);
  renderWord();
  el.hint.hidden = phase === "loading" || phase === "error";
  el.hint.classList.toggle("tg-hint--off", phase === "running"); // 打っている間は見せないが行の高さは残す（札が上下しない）
  el.error.hidden = phase !== "error";
  if (phase === "error") {
    reopenLink(el.error.querySelector("a"), "course", course); // 「開き直す」は今のコースで（PR #166 のレビュー 2。練習の ?kind= と同じ形）
    el.word.replaceChildren();
    el.word.dataset.rest = "";
    el.term.textContent = "";
    el.reading.textContent = "";
  }
  if (phase !== "running") setBar(1);
}

// ---- 時計（状態は run.settle だけが変える） ----
// rAF 1 本: 毎フレーム settle → 持ち時間の線と残り秒を書く。タイムアウト 1 本: 次の締切（文の持ち時間と回の終わりの早い方）＋余白
// （rAF が止まったときの保険。起きたら syncClock が線と残り秒も描き直すので、rAF が止まっていても締切ごとに表示が進む）。張り直すのも止めるのも syncClock だけ

// → 回が終わった・止まったか（結果・読み込めない）。時計は締切に気づいてから SETTLE_SLACK_MS の余白で流す
// （その間に届いた締切前のキーを、押した瞬間で数える）
function onClock() {
  if (phase !== "running") return true;
  const r = run.settle(performance.now(), SETTLE_SLACK_MS);
  if (r.ended) {
    finish();
    return true;
  }
  if (r.flowed) onFlowed();
  return phase !== "running";
}

// 時計を今の状態に合わせる（始めた・文が替わった・列に足した・終えた・止めた・始まる前に戻った・タイムアウトが起きたら呼ぶ）。
// running: 線と残り秒を描き直し、タイムアウトを次の締切に張り直し、rAF が止まっていれば動かす。それ以外: 両方止める
function syncClock() {
  clearTimeout(clockTimer);
  clockTimer = 0;
  shownRatio = -1;
  if (phase !== "running") {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    return;
  }
  paint(performance.now());
  const next = run.current && run.deadline < run.endAt ? run.deadline : run.endAt;
  clockTimer = setTimeout(() => {
    clockTimer = 0;
    if (!onClock()) syncClock(); // 早く起きた・文が流れて締切が替わった → 張り直す
  }, Math.max(1, next + SETTLE_SLACK_MS - performance.now()));
  if (!rafId) rafId = requestAnimationFrame(frame);
}

// 持ち時間の線は transform: scaleX で書く（CSS の transition は書かない。reduced motion は 10 段）。残り秒は変わったときだけ書く
function paint(now) {
  let ratio = run.remainingRatio(now);
  if (reduced) ratio = Math.ceil(ratio * 10) / 10;
  if (ratio !== shownRatio) setBar(ratio);
  if (Math.ceil((run.endAt - now) / 1000) !== shownSecs) renderTimer();
}

function frame() {
  rafId = 0;
  if (onClock()) return;
  paint(performance.now());
  if (!rafId) rafId = requestAnimationFrame(frame); // このフレームで流れたときは syncClock が次を頼んでいる（2 本にしない）
}

// 列が尽きたら次の文を出す（キーで取れた・キーで流れた・時計で流れたの 3 か所で同じ）→ 続けるか。
// 教材が取れなかった → 読み込めなかったの画面（時間を止める。結果・自己ベスト・計測なし）／届いている → 混ぜ直して後ろに足す（?s= の回）／
// まだ届いていない → 「読み込み中」のまま（時間は進む）。
// 足した文の持ち時間は列が尽きた瞬間から（run.sentenceStartedAt: 流れた文の締切・取れたキーの時刻。js/typingGame.js settle・press が張る）。
// 時計・キーが締切に気づいた時刻からにすると、列の途中の文（settle が締切から張る）より持ち時間が延びる
function nextSentence() {
  if (run.current) return true;
  if (data === false) {
    toError();
    return false;
  }
  if (data) run.add(shuffleCourse(data[course]), run.sentenceStartedAt);
  return true;
}

// 時計が文を流した（取れたときは書かない。見た目・音は変えない）
function onFlowed() {
  if (!nextSentence()) return;
  render();
  announce("次の文");
  syncClock();
}

// ---- 状態 ----

function syncTabs() {
  for (const tab of el.tabs) {
    const on = tab.dataset.course === course;
    tab.classList.toggle("stats-tab--active", on);
    tab.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const c = COURSES[course];
  // 区切りは結果の行と同じ sep（折れない「 ・」と折れてよい空白。行の頭に「・」が来ない。Batch 66 R2）。textContent は「note ・ 目標 N単位」のまま
  el.tabNote.replaceChildren(c.note, ...sep(), `目標 ${goalFor(course, seconds)}${c.unit}`);
}

function toReady(c = course) {
  guard.clear();
  course = isCourse(c) ? c : DEFAULT_COURSE;
  document.documentElement.dataset.typingCourse = course; // コースの規則（css/typing-game.css）は html の印で当たる
  // ページを開いた最初の回は、開いたコースの内蔵の文（typing-game.html に 3 つ直書き。FIRST_SENTENCES）だけで始め、教材が届いたら残りを後ろに足す（loadData）。
  // 最初の toReady は起動の同期の処理なので、教材はまだ届いていない。何も指定せずに開いたときはふつうの文の FIRST_SENTENCE（今までどおり）
  const first = firstRun;
  const list = first ? [FIRST_SENTENCES[course]] : data ? shuffleCourse(data[course]) : [];
  const cur = course;
  run = createGameRun({ sentences: list, seconds, limit: (r) => limitMs(cur, r, limitSec) });
  fillOnLoad = first;
  firstRun = false;
  phase = run.current ? "ready" : data === false ? "error" : "loading";
  syncClock(); // 前の回の時計を止める
  if (phase === "error") closeKeyboard(); // 打てない画面では盤面を出さない
  else {
    document.body.classList.add("typing--live", "romaji-answer"); // 常に日本語（ー のキーを出す）
    window.dispatchEvent(new CustomEvent("spelldash:game-start")); // 画面キーボードを出す（タッチ端末）
  }
  syncTabs();
  setLive("");
  el.hint.textContent = `打ち始めると、${span}を測る。文ごとに持ち時間がある。尽きると次の文へ。`;
  render();
  if (!modalOpen()) focusInput(); // ご意見の窓が開いているときは、窓の焦点を取らない
  setTimeout(() => fitAboveKeyboard(el.board), 50);
}

function start(now) {
  phase = "running";
  run.start(now);
  logTypingStage("start", "tgame");
  render();
  syncClock();
}

// 次の文が無く、教材も取れなかった: 時間を止める（結果・ベスト・計測は出さない）
function toError() {
  phase = "error";
  syncClock();
  cancelAnnounce();
  closeKeyboard();
  render();
}

function bestParts(cmp, unit) {
  const p = cmp.prev;
  if (cmp.status === "first") return ["自己ベスト（はじめての記録）"];
  if (cmp.status === "new") return ["自己ベストを更新（前 ", ["b", p.got], `${unit}）`];
  if (cmp.status === "faster") return ["自己ベストと同じ ", ["b", p.got], `${unit}・打/分を更新（前 `, ["b", p.kpm], "）"];
  if (cmp.status === "same") return ["自己ベストと同じ（", ["b", p.got], `${unit}・打/分 `, ["b", p.kpm], "）"];
  if (cmp.status === "below") return ["自己ベスト ", ["b", p.got], `${unit}（あと ${cmp.diff}${unit}）`];
  return null;
}

// 名前と数の組を 1 つの span（.tg-pair: 折らない）に。区切りの「 ・ 」の後ろでだけ折れる（「・」は前の組の終わりに残る。js/typingKeys.js の sep。
// 練習の結果の行と同じ。PR #166 のレビュー 5: ふつうの文字の「 ・ 」は「・」の前の空白で折れ、2 行目が「・ ミス …」で始まる幅があった）
function pairs(list) {
  const out = [];
  list.forEach(([name, value], i) => {
    if (i) out.push(...sep());
    const pair = make("span", "tg-pair", `${name} `);
    pair.append(make("b", "", String(value)));
    out.push(pair);
  });
  return out;
}

function renderResult(s, cmp) {
  el.kind.textContent = `${COURSES[course].name}・${span}`;
  el.gotNum.textContent = String(s.got);
  el.unit.textContent = s.unit;
  fill(el.goal, s.reached ? ["目標 ", ["b", s.goal], `${s.unit}に届いた`] : ["目標 ", ["b", s.goal], `${s.unit}まで あと ${s.goal - s.got}${s.unit}`]);
  el.line.replaceChildren(...pairs([["流れた", s.lost], ["打/分", s.kpm], ["正確さ", s.accuracy === null ? "―" : `${s.accuracy}%`], ["ミス", s.miss]]));
  const parts = bestParts(cmp, s.unit);
  if (parts) fill(el.best, parts);
  else el.best.replaceChildren();
  el.best.hidden = !parts;
  el.nudge.hidden = !(s.lost > s.got && course !== "short");
}

function finish() {
  if (phase !== "running") return;
  // ご意見の窓が開いたまま時間が切れた回は、打っていない時間を含むので捨てる（結果・ベスト・計測なし）
  if (modalOpen()) {
    abandon();
    return;
  }
  run.settle(Math.max(performance.now(), run.endAt)); // 締切が 90 秒の中にあった文を流しきって終える（打ちかけは数えない）
  phase = "result";
  syncClock();
  const s = summarizeGame(run, course, seconds);
  let cmp = { status: "none" };
  const store = limitSec == null ? storage() : null; // ?s= の回は書かない・比べない
  if (store) {
    cmp = compareGameBest(readGameBest(store, course, seconds), s.got, s.kpm);
    if (["first", "new", "faster"].includes(cmp.status) && !writeGameBest(store, course, seconds, { got: s.got, lost: s.lost, kpm: s.kpm, acc: s.accuracy, day: localDay(new Date()) })) cmp = { status: "none" };
  }
  renderResult(s, cmp);
  render();
  const head = `${s.got} ${s.unit}。${s.reached ? "目標に届いた" : `目標まで あと ${s.goal - s.got}${s.unit}`}。`;
  setLive(s.total > 0 ? `${head}流れた ${s.lost}、打/分 ${s.kpm}、正確さ ${s.accuracy}%、ミス ${s.miss}。` : `${head}流れた ${s.lost}。`);
  if (!touch) {
    try {
      el.mainLine.focus({ preventScroll: true });
    } catch {
      // 何もしない
    }
  }
  // 守り（js/typingKeys.js。typing.html と同じ）: 盤面は出したまま、盤面の外は押させない・結果の Enter／Space を捨てる。0.6 秒後に盤面を畳む
  guard.arm(closeKeyboard);
  logTypingStage("done", "tgame");
}

// Esc・ページが裏に回った（打っている間）: 結果・ベスト・計測なしで始まる前へ
function abandon() {
  toReady(course);
}

function press(key, now) {
  const before = run.current;
  const r = run.press(key, now);
  if (r.type === "ended") {
    finish(); // そのキーは捨てる
    return;
  }
  if (!nextSentence()) return;
  render();
  if (run.current !== before) syncClock();
  if (r.flowed) announce("次の文");
}

// ---- 教材 ----

async function loadData() {
  try {
    const response = await fetch("./data/typing-game.json");
    if (!response.ok) throw new Error(String(response.status));
    const json = await response.json();
    const c = json?.courses;
    if (!json || json.v !== 1 || !c || !validPairs(c.short) || !validPairs(c.normal) || !validPairs(c.long)) throw new Error("shape");
    data = { short: c.short, normal: c.normal, long: c.long };
  } catch {
    data = false;
  }
  if (data) {
    if (phase === "loading") {
      toReady(course);
      return;
    }
    if (fillOnLoad && run && (phase === "ready" || phase === "running")) {
      fillOnLoad = false;
      const before = run.current;
      const [ft, fr] = FIRST_SENTENCES[course]; // 最初の回のコース（教材が届く前にタブを押すと fillOnLoad は落ちる）
      run.add(shuffleCourse(data[course].filter((p) => !(p[0] === ft && p[1] === fr))), performance.now()); // 最初の回の残り（内蔵の文を除く）
      if (run.current !== before) {
        render();
        syncClock();
      }
    }
    fillOnLoad = false;
    return;
  }
  fillOnLoad = false;
  if (run && !run.current) {
    if (phase === "running") toError();
    else if (phase === "loading" || phase === "ready") {
      phase = "error";
      closeKeyboard(); // 打てない画面では盤面を出さない
      render();
    }
  }
}

// bfcache から戻った: module の状態が残っているので始まる前からやり直す
function onPageShow(event) {
  if (event.persisted) toReady(course);
}

// ---- 起動（打てるようにする配線を先に。計測とフッターは最後） ----

// タブで選んだコース: この端末に覚え（次に何も指定せずに開いたときのコース）、URL の ?course= を合わせる（js/typingKeys.js rememberChoice。
// replaceState で履歴は増やさない・URL が替わるときだけ書く。再読み込みでも共有でも、今のコースで開く）。
// ?course= で開いただけでは覚えない（貼られたリンク・検索から来た 1 回で、その人が選んだコースを上書きしない）
for (const tab of el.tabs) {
  tab.addEventListener("click", () => {
    const c = tab.dataset.course;
    if (!isCourse(c)) return;
    rememberChoice(COURSE_CHOICE, c);
    if (c !== course || phase === "result" || phase === "error") toReady(c);
    else focusInput();
  });
}
el.again.addEventListener("click", () => toReady(course));
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-tgame-study]") : null;
  if (link) logTypingStage("study", "tgame"); // 積むだけ（移動は止めない。次のページが送る）
});
wireTyping({
  input: el.input,
  board: el.board,
  phase: () => phase,
  timeOf: eventTime, // 押した瞬間（文の締切・90 秒の終わりと比べる。docs/SPEC_TYPING_GAME.md「キー」）
  endAt: () => run.endAt,
  guard,
  start,
  press,
  finish,
  reset: abandon // Esc・裏に回った・ご意見の窓を開いた: 結果・ベスト・計測なしで始まる前へ
});
window.addEventListener("pageshow", onPageShow);

try {
  initializeKeyboard({ playingClass: "typing--live", forceOnTouch: true });
} catch {
  // 借り物の初期化で投げても、打鍵の配線は済んでいる
}

toReady(START_COURSE);
loadData();

const arrivedNow = markTypingArrival("tgame"); // 必ず setFooterYear（trackFirstVisit が端末の番号を作る）より前。true: この端末の最初の 1 ページ
try {
  setFooterYear();
} catch {
  // フッターの借り物が投げても打鍵は止めない
}
logTypingStage("arrive", "tgame");
// ?course= の深いリンクで初めて来た端末（tgame_link。docs/SQL_FUNNEL.md 5）。最初の 1 ページだけ（タブが replaceState で書いた ?course= の開き直しは数えない。練習の typing_link と同じ）
if (courseParam && arrivedNow) logTypingStage("link", "tgame");
logTypingStage("game", "typing"); // タイピング練習から初めて来た端末がゲームを開いた（その端末だけ送る）
