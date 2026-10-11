// ===== タイピングゲーム（/typing-game.html）の配線: 状態・描画・持ち時間の線・キー・時間・計測（docs/SPEC_TYPING_GAME.md） =====
//
// 状態（#tgBoard[data-state]）: ready（始まる前）→ running（打っている間）→ result（結果）。loading（教材待ち）・error（読めない）。
// キーの取り方・扱わない場所・焦点・時間切れの守りは js/typingPage.js（typing.html）の写し。違いは文ごとの持ち時間:
//   締切のあとに届いたキーは捨てる、流れてから FLOW_GRACE_MS の間は新しい文として通らないキーを数えない、キーの時刻は event.timeStamp。
// 状態を変えるのは run.settle と run.press だけ（js/typingGame.js）。時計（文ごとの timer・全体の timer・rAF・200ms の tick）は settle を呼ぶだけ。
// 学習記録（単語の記録・SRS・XP・連続日数・苦手なキー）とタイピング練習の自己ベストは読まない・書かない。
// 書くのは自己ベスト（spelldash_typing_game）と計測（js/funnelLog.js）だけ。

import "./appEnv.js"; // アプリならセーフエリア
import "./staticHeader.js"; // ヘッダー右端（連続日数・ログイン／設定）
import { setFooterYear } from "./footer.js";
import { initializeKeyboard, isTouchDevice } from "./keyboard.js";
import { romajiKeyOf } from "./romaji.js";
import { markTypingArrival, logTypingStage } from "./funnelLog.js";
import { RESULT_GUARD_MS } from "./typingDrill.js";
import {
  SETTLE_SLACK_MS,
  FIRST_SENTENCE,
  DEFAULT_COURSE,
  COURSES,
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
const guarded = () => [el.again, document.querySelector(".tp-result__next"), document.querySelector(".tp-about")].filter(Boolean);

const seconds = secondsFrom(location.search);
const limitSec = limitSecondsFrom(location.search); // ?s=N（E2E）: 文ごとの持ち時間を一律に。その回は自己ベストに書かない
const span = `${seconds}秒`;
const touch = (() => {
  try {
    return isTouchDevice();
  } catch {
    return false;
  }
})();
const reduced = (() => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
})();

let phase = "ready"; // ready | running | result | loading | error
let course = DEFAULT_COURSE;
let data = null; // null = まだ届いていない／false = 取れなかった／{ short, normal, long }
let firstRun = true;
let run = null;
let fillOnLoad = false; // 教材が届く前に始めた最初の回（最初の文だけ）: 届いたら列の後ろに足す
let resultAt = 0;
let shownSecs = -1;
let shownRatio = -1;
let finishTimer = 0;
let settleTimer = 0;
let tickTimer = 0;
let rafId = 0;
let collapseTimer = 0;

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// keydown の時刻は押した瞬間（performance.now() と同じ時計）。古い実装の epoch ms などは今の時刻に落とす
function eventTime(event) {
  const t = Number(event?.timeStamp);
  const now = performance.now();
  return Number.isFinite(t) && Math.abs(now - t) <= 5000 ? t : now;
}

function stopTimers() {
  clearTimeout(finishTimer);
  clearTimeout(settleTimer);
  clearInterval(tickTimer);
  if (rafId) cancelAnimationFrame(rafId);
  finishTimer = 0;
  settleTimer = 0;
  tickTimer = 0;
  rafId = 0;
}

// 結果の守り（RESULT_GUARD_MS）を片付ける
function clearGuard() {
  clearTimeout(collapseTimer);
  collapseTimer = 0;
  for (const node of guarded()) node.removeAttribute("inert");
}

function focusInput() {
  if (touch) return; // タッチ端末では焦点を当てない（iOS の入力補助のバーを出さない。キーは document で受ける）
  try {
    el.input.focus({ preventScroll: true });
  } catch {
    // 何もしない
  }
}

function setLive(text) {
  if (el.live) el.live.textContent = text;
}

// 同じ文が続けて書かれると読まれない読み上げ環境があるので、一度空にしてから書く
function announce(text) {
  setLive("");
  setLive(text);
}

// ---- 描く ----

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// js/typingPage.js:136-188 の日本語の枝の写し（かなの単位 2 段・手本・打ったキー・ミスの印）
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
  for (const u of units) {
    const unit = make("span", `tp-unit tp-unit--${u.state}`);
    unit.append(make("span", "tp-unit__kana", u.kana));
    const keys = make("span", "tp-unit__keys");
    if (u.state === "done") keys.textContent = u.typed;
    else {
      if (u.typed) keys.append(make("b", "", u.typed));
      if (u.state === "now" && u.rest) {
        keys.append(make("span", "tp-now", u.rest[0]));
        if (u.rest.length > 1) keys.append(document.createTextNode(u.rest.slice(1)));
      } else if (u.rest) keys.append(document.createTextNode(u.rest));
    }
    unit.append(keys);
    w.append(unit);
  }
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
    el.word.replaceChildren();
    el.word.dataset.rest = "";
    el.term.textContent = "";
    el.reading.textContent = "";
  }
  if (phase !== "running") setBar(1);
}

// ---- 時計（状態は run.settle だけが変える） ----

// → 終わったか。時計は締切に気づいてから SETTLE_SLACK_MS の余白で流す（その間に届いた締切前のキーを、押した瞬間で数える）
function onClock() {
  if (phase !== "running") return true;
  const r = run.settle(performance.now(), SETTLE_SLACK_MS);
  if (r.ended) {
    finish();
    return true;
  }
  if (r.flowed) onFlowed();
  return false;
}

function onFlowed() {
  render();
  announce("次の文"); // 流れたときだけ（取れたときは書かない）。見た目・音は変えない
  shownRatio = -1;
  armSettle();
}

function armSettle() {
  clearTimeout(settleTimer);
  settleTimer = 0;
  if (phase !== "running" || !run.current || !(run.deadline < run.endAt)) return;
  settleTimer = setTimeout(() => {
    settleTimer = 0;
    if (!onClock()) armSettle();
  }, Math.max(0, run.deadline + SETTLE_SLACK_MS - performance.now()));
}

function armFinish() {
  clearTimeout(finishTimer);
  finishTimer = setTimeout(() => {
    finishTimer = 0;
    if (!onClock()) armFinish(); // 時計がわずかに早く起きたら張り直す
  }, Math.max(1, run.endAt + SETTLE_SLACK_MS - performance.now()));
}

function tick() {
  if (phase !== "running") return;
  if (onClock()) return;
  const left = Math.ceil((run.endAt - performance.now()) / 1000);
  if (left !== shownSecs) renderTimer();
}

// 持ち時間の線: 毎フレーム settle → 残り比を transform: scaleX で書く（CSS の transition は書かない。reduced motion は 10 段）
function frame() {
  rafId = 0;
  if (phase !== "running") return;
  if (onClock()) return;
  let ratio = run.remainingRatio(performance.now());
  if (reduced) ratio = Math.ceil(ratio * 10) / 10;
  if (ratio !== shownRatio) setBar(ratio);
  rafId = requestAnimationFrame(frame);
}

// ---- 状態 ----

function syncTabs() {
  for (const tab of el.tabs) {
    const on = tab.dataset.course === course;
    tab.classList.toggle("stats-tab--active", on);
    tab.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const c = COURSES[course];
  el.tabNote.textContent = `${c.note} ・ 目標 ${goalFor(course, seconds)}${c.unit}`;
}

function toReady(c = course) {
  stopTimers();
  clearGuard();
  course = COURSES[c] ? c : DEFAULT_COURSE;
  const first = course === "normal" && firstRun;
  const list = data ? shuffleCourse(data[course], first ? FIRST_SENTENCE : null) : first ? [FIRST_SENTENCE] : [];
  const cur = course;
  run = createGameRun({ sentences: list, seconds, limit: (r) => limitMs(cur, r, limitSec) });
  fillOnLoad = first && !data; // 教材が届く前に開いた最初の回: 届いたら列の後ろに足す
  firstRun = false;
  phase = run.current ? "ready" : data === false ? "error" : "loading";
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
  setTimeout(fitAboveKeyboard, 50);
}

function start(now) {
  phase = "running";
  run.start(now);
  armFinish();
  armSettle();
  tickTimer = setInterval(tick, 200);
  shownRatio = -1;
  rafId = requestAnimationFrame(frame);
  logTypingStage("start", "tgame");
  render();
}

function closeKeyboard() {
  document.body.classList.remove("typing--live", "romaji-answer"); // keyboard.js の MutationObserver がここで盤面を畳む
  window.dispatchEvent(new CustomEvent("spelldash:game-end"));
}

// 打ち終えたが次の文が無く、教材も取れなかった: 時間を止める（結果・ベストは出さない）
function toError() {
  stopTimers();
  phase = "error";
  closeKeyboard();
  render();
}

function fill(node, parts) {
  node.replaceChildren();
  for (const part of parts) {
    if (Array.isArray(part)) node.append(make(part[0], part[2] ?? "", String(part[1])));
    else node.append(document.createTextNode(part));
  }
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

// 名前と数の組を 1 つの span（.tg-pair: 折らない）に。区切りの「 ・ 」でだけ折れる
function pairs(list) {
  const out = [];
  list.forEach(([name, value], i) => {
    if (i) out.push(document.createTextNode(" ・ "));
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
  stopTimers();
  run.settle(Math.max(performance.now(), run.endAt)); // 締切が 90 秒の中にあった文を流しきって終える（打ちかけは数えない）
  phase = "result";
  const s = summarizeGame(run, course, seconds);
  let cmp = { status: "none" };
  const store = limitSec == null ? storage() : null; // ?s= の回は書かない・比べない
  if (store) {
    cmp = compareGameBest(readGameBest(store, course, seconds), s.got, s.kpm);
    if (["first", "new", "faster"].includes(cmp.status) && !writeGameBest(store, course, seconds, { got: s.got, lost: s.lost, kpm: s.kpm, acc: s.accuracy, day: localDay() })) cmp = { status: "none" };
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
  resultAt = performance.now();
  // 守り: 盤面は出したまま（typing--live・romaji-answer を外さず、game-end も投げない）、結果のボタン群は inert。
  // 盤面を叩いていた指の次のタップが、下から現れたボタンに落ちないように（js/typingPage.js:369-376 の写し）
  for (const node of guarded()) node.setAttribute("inert", "");
  collapseTimer = setTimeout(() => {
    collapseTimer = 0;
    for (const node of guarded()) node.removeAttribute("inert");
    closeKeyboard();
  }, RESULT_GUARD_MS);
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
  if (!run.current) {
    if (data === false) {
      toError();
      return;
    }
    if (data) run.add(shuffleCourse(data[course]), now); // 列が尽きた（?s= の回）: 混ぜ直して後ろに足す
    // まだ届いていなければ「読み込み中」のまま（時間は進む）
  }
  render();
  if (run.current !== before) {
    shownRatio = -1;
    armSettle();
  }
  if (r.flowed) announce("次の文");
}

// ---- 教材 ----

function validPairs(list) {
  return Array.isArray(list) && list.length > 0 && list.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string" && p[0] && p[1]);
}

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
      run.add(shuffleCourse(data.normal.filter((p) => !(p[0] === FIRST_SENTENCE[0] && p[1] === FIRST_SENTENCE[1]))), performance.now());
      if (run.current !== before) {
        render();
        shownRatio = -1;
        armSettle();
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

// ---- キー（js/typingPage.js:437-537 の写し。違いは docs/SPEC_TYPING_GAME.md「キー」） ----

// ご意見の窓（aria-modal。開け閉めは hidden）が開いているか。打鍵ごとに呼ぶので、レイアウトを読まない
function modalOpen() {
  return [...document.querySelectorAll('[aria-modal="true"]')].some((node) => !node.closest("[hidden]"));
}

function editable(target) {
  if (!(target instanceof Element) || target === el.input) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function onKey(event) {
  if (modalOpen()) return;
  const target = event.target;
  if (editable(target)) return;
  const isEnter = event.key === "Enter";
  const isSpace = event.key === " " || event.key === "Spacebar";
  if ((isEnter || isSpace) && (event.isComposing || event.keyCode === 229)) return; // IME の確定
  if (phase === "loading" || phase === "error") return;
  const now = eventTime(event);
  const mod = event.ctrlKey || event.metaKey || event.altKey;
  const key = romajiKeyOf(event);
  const onControl = target instanceof Element && target.closest('button, a[href], [role="button"]');

  // 90 秒を過ぎていたら先に終える（時計が遅れても数がずれない）。そのキーは捨てる
  if (phase === "running" && now >= run.endAt) {
    if (key || ((isEnter || isSpace) && !onControl)) event.preventDefault();
    finish();
    return;
  }

  if (event.key === "Escape") {
    if (phase === "running" || phase === "result") {
      event.preventDefault();
      if (phase === "running") abandon();
      else toReady(course);
    }
    return;
  }

  if (isEnter || isSpace) {
    if (onControl) {
      // 打っている間、コースのタブ・ご意見のボタンの上の Space／Enter は押させない（癖の Space で回が消えない）
      if (phase === "running" && target.closest(".tp-tabs button, [data-feedback-open]")) event.preventDefault();
      return;
    }
    if (mod) return;
    event.preventDefault();
    if (event.repeat) return;
    if (phase === "ready") start(now);
    else if (phase === "result" && performance.now() - resultAt >= RESULT_GUARD_MS) toReady(course);
    return; // 打っている間の Space／Enter は数えない（文に空白は無い）
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    if (phase === "ready" || phase === "running") event.preventDefault(); // 打った字は消せない（数えない）
    return;
  }

  if (key) {
    if (phase === "result") {
      if (event.repeat) event.preventDefault();
      return; // 勝手にやり直さない
    }
    event.preventDefault();
    if (event.repeat) return;
    if (phase === "ready") start(now);
    press(key, now);
    return;
  }

  // ローマ字のキーでない 1 文字のキー（/ . , ; など）: 打っている間は数えず、ブラウザにも渡さない（Firefox のクイック検索）
  if (phase === "running" && !mod && [...String(event.key ?? "")].length === 1) event.preventDefault();
}

// Space はボタンの上で keyup のときに押される: 打っている間は keyup も止める
function onKeyUp(event) {
  if (phase !== "running" || modalOpen()) return;
  if (event.key !== " " && event.key !== "Spacebar") return;
  const target = event.target;
  if (target instanceof Element && target.closest(".tp-tabs button, [data-feedback-open]")) event.preventDefault();
}

// キーで押されたクリック（detail 0）が打っている間のタブ・ご意見のボタンに届いたら止める（keydown を止め損ねたときの保険）
function onClickCapture(event) {
  if (phase !== "running") return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (event.detail === 0) {
    if (target.closest(".tp-tabs button, [data-feedback-open]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    return;
  }
  // マウス・タップでご意見の窓を開いた: その回は捨てる（窓の裏で時間が切れて結果とベストが残らないように）
  if (target.closest("[data-feedback-open]")) abandon();
}

function onVisibility() {
  if (document.hidden && phase === "running") abandon(); // 裏で時計が間引かれても、戻った瞬間に「流れた 10」と出さない
}

// bfcache から戻った: module の状態が残っているので始まる前からやり直す
function onPageShow(event) {
  if (event.persisted) toReady(course);
}

// ---- タッチ端末: 札を画面キーボードの上に寄せる（js/typingPage.js:541-551 の写し） ----

function fitAboveKeyboard() {
  const osk = document.getElementById("osk");
  if (!osk || osk.hidden) return;
  const board = el.board.getBoundingClientRect();
  const keys = osk.getBoundingClientRect();
  if (board.bottom <= keys.top) return;
  const header = document.querySelector(".site-header");
  const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
  const delta = board.top - (headerBottom + 8); // 札の上端がヘッダーの下 8px に来るまで（それより上には送らない）
  if (delta > 0) window.scrollBy(0, delta);
}

// ---- 起動（打てるようにする配線を先に。計測とフッターは最後） ----

for (const tab of el.tabs) {
  tab.addEventListener("click", () => {
    const c = tab.dataset.course;
    if (!COURSES[c]) return;
    if (c !== course || phase === "result" || phase === "error") toReady(c);
    else focusInput();
  });
}
el.again.addEventListener("click", () => toReady(course));
el.board.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest("button, a[href]")) return;
  if (phase === "ready" || phase === "running") focusInput();
});
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-tgame-study]") : null;
  if (link) logTypingStage("study", "tgame"); // 積むだけ（移動は止めない。次のページが送る）
});
document.addEventListener("click", onClickCapture, true);
document.addEventListener("keydown", onKey);
document.addEventListener("keyup", onKeyUp);
document.addEventListener("visibilitychange", onVisibility);
window.addEventListener("pageshow", onPageShow);

try {
  initializeKeyboard({ playingClass: "typing--live", forceOnTouch: true });
} catch {
  // 借り物の初期化で投げても、打鍵の配線は済んでいる
}

toReady(DEFAULT_COURSE);
loadData();

markTypingArrival("tgame"); // 必ず setFooterYear（trackFirstVisit が端末の番号を作る）より前
try {
  setFooterYear();
} catch {
  // フッターの借り物が投げても打鍵は止めない
}
logTypingStage("arrive", "tgame");
logTypingStage("game", "typing"); // タイピング練習から初めて来た端末がゲームを開いた（その端末だけ送る）
