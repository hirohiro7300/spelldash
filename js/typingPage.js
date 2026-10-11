// ===== タイピング練習（/typing.html）の配線: 状態・描画・キー・時間・計測（docs/SPEC_TYPING.md） =====
//
// 状態（#typingBoard[data-state]）: ready（始まる前）→ running（打っている間）→ result（結果）。loading（教材待ち）・error（読めない）。
// キーの振り分け・焦点・画面キーボード・結果の守りは js/typingKeys.js（タイピングゲームと共有）。キーの時刻は受けた時刻（performance.now()）。
// 学習記録（spelldash_word_stats・SRS・XP・連続日数・ミッション・spelldash_key_miss）は読まない・書かない。
// 書くのは自己ベスト（spelldash_typing_practice）と計測（js/funnelLog.js）だけ。

import "./appEnv.js"; // アプリならセーフエリア
import "./staticHeader.js"; // ヘッダー右端（連続日数・ログイン／設定）
import { setFooterYear } from "./footer.js";
import { initializeKeyboard } from "./keyboard.js";
import { markTypingArrival, logTypingStage } from "./funnelLog.js";
import {
  touch,
  storage,
  localDay,
  make,
  fill,
  appendUnits,
  validPairs,
  modalOpen,
  focusInput as focusOn,
  closeKeyboard,
  fitAboveKeyboard,
  createResultGuard,
  wireTyping
} from "./typingKeys.js";
import {
  FIRST_WORD,
  secondsFrom,
  shuffle,
  createRun,
  summarize,
  readBest,
  compareBest,
  writeBest
} from "./typingDrill.js";

// head の theme の 1 行（ほかのページと同じ）は localStorage が投げると data-theme を付けずに止まる。
// そのままだと html[data-theme] で始まる皮が全部外れるので、ここで補う
if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = "light";

const $ = (id) => document.getElementById(id);
const el = {
  board: $("typingBoard"),
  timer: $("typingTimer"),
  play: $("typingPlay"),
  term: $("typingTerm"),
  word: $("typingWord"),
  gloss: $("typingGloss"),
  next: $("typingNext"),
  hint: $("typingHint"),
  error: $("typingError"),
  input: $("input"),
  result: $("typingResult"),
  kind: $("typingKind"),
  kpm: $("typingKpm"),
  kpmLine: $("typingKpmLine"),
  acc: $("typingAcc"),
  best: $("typingBest"),
  keys: $("typingKeys"),
  again: $("typingAgain"),
  studyText: $("typingStudyText"),
  live: $("typingLive"),
  tabNote: $("typingTabNote"),
  tabs: [...document.querySelectorAll("#typingTabs [data-kind]")]
};

const KIND_NAME = { en: "英単語", ja: "日本語" };
const STUDY_TEXT = {
  en: "日本語の訳だけを見て、英単語を思い出して打つ。1日5分から。",
  ja: "初めの画面の「ほかの本から始める」で社会・理科を選び、問題文から用語を思い出して打つ。"
};

const seconds = secondsFrom(location.search);
const span = seconds === 60 ? "1分" : `${seconds}秒`;
const guard = createResultGuard();

let phase = "ready"; // ready | running | result | loading | error
let kind = "en";
let data = null; // null = まだ届いていない／false = 取れなかった／{ en, ja }
let firstRun = true;
let run = null;
let fillOnLoad = false; // 教材が届く前に始めた回（最初の英単語）: 届いたら列の後ろに足す
let endAt = 0;
let resultAt = 0;
let shownSecs = -1;
let finishTimer = 0;
let tickTimer = 0;

function stopTimers() {
  clearTimeout(finishTimer);
  clearInterval(tickTimer);
  finishTimer = 0;
  tickTimer = 0;
}

const focusInput = () => focusOn(el.input);

function setLive(text) {
  if (el.live) el.live.textContent = text;
}

// ---- 描く ----

function renderWord() {
  const current = run?.current ?? null;
  const w = el.word;
  w.replaceChildren();
  if (!current) {
    w.className = "tp-word";
    w.setAttribute("lang", "ja");
    w.dataset.rest = "";
    if (phase === "loading" || phase === "running") w.append(make("span", "tp-loading", "読み込み中"));
    el.term.hidden = true;
    el.term.textContent = "";
    el.gloss.hidden = true;
    el.gloss.textContent = "";
    return;
  }
  if (current.kind === "ja") {
    w.className = run.missPending ? "tp-word tp-word--ja tp-miss" : "tp-word tp-word--ja";
    w.setAttribute("lang", "ja");
    const { units, rest } = current.view();
    appendUnits(w, units);
    w.dataset.rest = rest;
    el.term.textContent = current.term;
    el.term.hidden = false;
    el.gloss.hidden = true;
    el.gloss.textContent = "";
  } else {
    w.className = run.missPending ? "tp-word tp-miss" : "tp-word";
    w.setAttribute("lang", "en");
    const v = current.view();
    if (v.done) w.append(make("span", "tp-done", v.done));
    if (v.now) w.append(make("span", "tp-now", v.now));
    if (v.rest) w.append(document.createTextNode(v.rest));
    w.dataset.rest = current.rest();
    el.gloss.textContent = current.gloss;
    el.gloss.hidden = false;
    el.term.hidden = true;
    el.term.textContent = "";
  }
}

// 次の語が無い（教材が届く前・尽きた）ときも行の高さは残す（tp-upnext--empty は visibility: hidden）。届いた瞬間に下の一文が下がらない
function renderNext() {
  const next = run?.next ?? null;
  const b = el.next.querySelector("b") ?? el.next.appendChild(document.createElement("b"));
  el.next.hidden = false;
  b.textContent = next ? String(next[run.kind === "ja" ? 1 : 0]) : "";
  el.next.classList.toggle("tp-upnext--empty", !next);
}

function renderTimer() {
  if (phase === "running") {
    const left = Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
    shownSecs = left;
    el.timer.textContent = `残り ${left}秒`;
  } else el.timer.textContent = `残り ${seconds}秒`;
}

function render() {
  el.board.dataset.state = phase;
  el.board.dataset.kind = kind;
  const result = phase === "result";
  el.timer.hidden = result || phase === "error"; // 読み込めないときは「残り 60秒」を残さない
  el.play.hidden = result;
  el.result.hidden = !result;
  if (result) return;
  renderTimer();
  renderWord();
  renderNext();
  el.hint.hidden = phase !== "ready";
  el.error.hidden = phase !== "error";
  if (phase === "error") {
    el.next.hidden = true;
    el.word.replaceChildren();
    el.word.dataset.rest = "";
  }
}

function tick() {
  if (phase !== "running") return;
  const now = performance.now();
  if (now >= endAt) {
    finish();
    return;
  }
  const left = Math.ceil((endAt - now) / 1000);
  if (left !== shownSecs) renderTimer();
}

// ---- 状態 ----

function wordsFor(k, first) {
  if (k === "en" && first) {
    const rest = data ? shuffle(data.en.filter((p) => p[0] !== FIRST_WORD[0])) : [];
    return [FIRST_WORD, ...rest];
  }
  return data ? shuffle(data[k]) : [];
}

function syncTabs() {
  for (const tab of el.tabs) {
    const on = tab.dataset.kind === kind;
    tab.classList.toggle("stats-tab--active", on);
    tab.setAttribute("aria-pressed", on ? "true" : "false");
  }
  el.tabNote.classList.toggle("tp-tabnote--off", kind !== "ja"); // 英単語では見せないが行の高さは残す（札が上下しない）
  el.studyText.textContent = STUDY_TEXT[kind];
}

function toReady(k = kind) {
  stopTimers();
  guard.clear();
  kind = k;
  run = createRun(k, wordsFor(k, firstRun));
  fillOnLoad = k === "en" && firstRun && !data; // 教材が届く前に始めた最初の英単語の回: 届いたら列の後ろに足す
  firstRun = false;
  phase = run.current ? "ready" : data === false ? "error" : "loading";
  if (phase === "error") closeKeyboard(); // 打てない画面では盤面を出さない
  else {
    document.body.classList.add("typing--live");
    document.body.classList.toggle("romaji-answer", k === "ja");
    window.dispatchEvent(new CustomEvent("spelldash:game-start")); // 画面キーボードを出す（タッチ端末）
  }
  syncTabs();
  setLive("");
  el.hint.textContent = `打ち始めると、${span}を測る。`;
  render();
  if (!modalOpen()) focusInput(); // ご意見の窓が開いているときは、窓の焦点を取らない
  setTimeout(() => fitAboveKeyboard(el.board), 50);
}

function start(now) {
  phase = "running";
  endAt = now + seconds * 1000;
  finishTimer = setTimeout(finish, Math.max(0, endAt - performance.now()));
  tickTimer = setInterval(tick, 200);
  logTypingStage("start");
  render();
}

// 打ち終えたが次の語が無く、教材も取れなかった: 時間を止める（結果・ベストは出さない）
function toError() {
  stopTimers();
  phase = "error";
  closeKeyboard();
  render();
}

function bestText(cmp) {
  if (cmp.status === "first") return [" ・ 自己ベスト（はじめての記録）"];
  if (cmp.status === "new") return [" ・ 自己ベストを更新（前 ", ["b", cmp.prev], "）"];
  if (cmp.status === "same") return [" ・ 自己ベストと同じ"];
  if (cmp.status === "below") return [" ・ 自己ベスト ", ["b", cmp.prev], `（あと ${cmp.diff}）`];
  return null;
}

function renderResult(s, cmp) {
  el.kind.textContent = `${KIND_NAME[kind]}・${span}`;
  el.kpm.textContent = String(s.kpm);
  // 正確さ・ミス（行の頭）＋自己ベスト（同じ行の続き #typingBest）
  const best = el.best;
  fill(el.acc, ["正確さ ", ["b", s.accuracy === null ? "―" : `${s.accuracy}%`], " ・ ミス ", ["b", s.miss]]);
  el.acc.append(best);
  const parts = bestText(cmp);
  if (parts) fill(best, parts);
  else best.replaceChildren();
  best.hidden = !parts;
  // 間違えたキー（ミス 0 なら行ごと出さない）
  if (s.topKeys.length) {
    el.keys.replaceChildren(document.createTextNode("間違えたキー"));
    for (const [key, count] of s.topKeys) {
      el.keys.append(document.createTextNode(" "), make("span", "tp-key", key), document.createTextNode(" "), make("b", "", String(count)));
    }
    el.keys.hidden = false;
  } else {
    el.keys.replaceChildren();
    el.keys.hidden = true;
  }
}

function finish() {
  if (phase !== "running") return;
  // ご意見の窓が開いたまま時間が切れた回は、打っていない時間を含むので捨てる（結果・ベスト・計測なし）
  if (modalOpen()) {
    abandon();
    return;
  }
  stopTimers();
  phase = "result";
  const s = summarize(run.stats, seconds);
  const store = storage();
  let cmp = { status: "none" };
  if (store) {
    cmp = compareBest(readBest(store, seconds)[kind], s.kpm);
    if ((cmp.status === "first" || cmp.status === "new") && !writeBest(store, kind, seconds, { kpm: s.kpm, acc: s.accuracy, day: localDay() })) cmp = { status: "none" };
  }
  renderResult(s, cmp);
  render();
  setLive(s.total > 0 ? `${s.kpm} 打/分。正確さ ${s.accuracy}%、ミス ${s.miss}。` : `${s.kpm} 打/分。`);
  if (!touch) {
    try {
      el.kpmLine.focus({ preventScroll: true });
    } catch {
      // 何もしない
    }
  }
  resultAt = performance.now();
  // 守り（js/typingKeys.js）: 盤面は出したまま（typing--live・romaji-answer を外さず、game-end も投げない）、盤面の外は押させない。
  // 盤面を叩いていた指の次のタップが、下から現れたボタンやリンクに落ちないように。0.6 秒後に盤面を畳む
  guard.arm(closeKeyboard);
  logTypingStage("done");
}

// Esc・ページが裏に回った（打っている間）: 結果・ベスト・計測なしで始まる前へ
function abandon() {
  toReady(kind);
}

function press(key, now) {
  run.press(key, now);
  if (!run.current && data === false) {
    toError();
    return;
  }
  render();
}

// ---- 教材 ----

async function loadData() {
  try {
    const response = await fetch("./data/typing.json");
    if (!response.ok) throw new Error(String(response.status));
    const json = await response.json();
    if (!json || json.v !== 1 || !validPairs(json.en) || !validPairs(json.ja)) throw new Error("shape");
    data = { en: json.en, ja: json.ja };
  } catch {
    data = false;
  }
  if (data) {
    if (phase === "loading") {
      toReady(kind);
      return;
    }
    if (fillOnLoad && run && (phase === "ready" || phase === "running")) {
      fillOnLoad = false;
      run.add(shuffle(data[run.kind].filter((p) => !(run.kind === "en" && p[0] === FIRST_WORD[0]))));
      render();
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

// ---- 起動（打てるようにする配線を先に。計測とフッターは最後） ----

for (const tab of el.tabs) {
  tab.addEventListener("click", () => {
    const k = tab.dataset.kind;
    if (k !== "en" && k !== "ja") return;
    if (k !== kind || phase === "result" || phase === "error") toReady(k);
    else focusInput();
  });
}
el.again.addEventListener("click", () => toReady(kind));
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-typing-study]") : null;
  if (link) logTypingStage("study"); // 積むだけ（移動は止めない。次のページが送る）
});
wireTyping({
  input: el.input,
  board: el.board,
  phase: () => phase,
  timeOf: () => performance.now(), // 受けた時刻（start・press・時間切れの比べもこの時計）
  endAt: () => endAt,
  resultAt: () => resultAt,
  start,
  press,
  finish,
  reset: abandon
});

try {
  initializeKeyboard({ playingClass: "typing--live", forceOnTouch: true });
} catch {
  // 借り物の初期化で投げても、打鍵の配線は済んでいる
}

toReady("en");
loadData();

markTypingArrival(); // 必ず setFooterYear（trackFirstVisit が端末の番号を作る）より前
try {
  setFooterYear();
} catch {
  // フッターの借り物が投げても打鍵は止めない
}
logTypingStage("arrive");
