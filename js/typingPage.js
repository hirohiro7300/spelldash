// ===== タイピング練習（/typing.html）の配線: 状態・描画・キー・時間・計測（docs/SPEC_TYPING.md） =====
//
// 状態（#typingBoard[data-state]）: ready（始まる前）→ running（打っている間）→ result（結果）。loading（教材待ち）・error（読めない）。
// 長文（3 つ目の種類。docs/SPEC_TYPING.md「長文」）だけ paused（裏に回った・ご意見の窓。次の 1 打で続きから）がある。
// キーの振り分け・焦点・画面キーボード・結果の守りは js/typingKeys.js（タイピングゲームと共有）。キーの時刻は受けた時刻（performance.now()）。
// 長文のキーの読み方・時計・スコア・自己ベスト・教材の形は js/typingLong.js、判定は js/typingDrill.js の createRun（"ja_text"／"en_text"）。
// 学習記録（spelldash_word_stats・SRS・XP・連続日数・ミッション・spelldash_key_miss）は読まない・書かない。
// 書くのは自己ベスト（spelldash_typing_practice。長文は best.long）と計測（js/funnelLog.js）だけ。

import "./appEnv.js"; // アプリならセーフエリア
import "./staticHeader.js"; // ヘッダー右端（連続日数・ログイン／設定）
import { setFooterYear } from "./footer.js";
import { initializeKeyboard } from "./keyboard.js";
import { markTypingArrival, logTypingStage } from "./funnelLog.js";
import { localDay } from "./retentionCalc.js";
import { romajiKeyOf } from "./romaji.js";
import {
  touch,
  storage,
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
  syncUrlParam,
  reopenLink
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
import {
  LONG_GROUPS,
  punctKeyOf,
  textKeyOf,
  longKeyLabel,
  createLongClock,
  stopOutcome,
  summarizeLong,
  formatLongTime,
  recordLongBest,
  longBestPhrase,
  doneLongIds,
  defaultLongId,
  nextLongId,
  longOptionLabel,
  parseLongData,
  linesFrom,
  trimLongLines
} from "./typingLong.js";

// head の theme の 1 行（ほかのページと同じ）は localStorage が投げると data-theme を付けずに止まる。
// そのままだと html[data-theme] で始まる皮が全部外れるので、ここで補う
if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = "light";

const $ = (id) => document.getElementById(id);
const el = {
  stage: $("typingStage"),
  board: $("typingBoard"),
  timer: $("typingTimer"),
  head: $("typingHead"),
  select: $("typingText"),
  title: $("typingTitle"),
  headRight: $("typingHeadRight"),
  left: $("typingLeft"),
  stop: $("typingStop"),
  play: $("typingPlay"),
  term: $("typingTerm"),
  word: $("typingWord"),
  gloss: $("typingGloss"),
  next: $("typingNext"),
  hint: $("typingHint"),
  error: $("typingError"),
  errorWhat: $("typingErrorWhat"),
  line: $("typingLine"),
  input: $("input"),
  result: $("typingResult"),
  kind: $("typingKind"),
  kpm: $("typingKpm"),
  kpmPre: $("typingKpmPre"),
  kpmUnit: $("typingKpmUnit"),
  kpmLine: $("typingKpmLine"),
  acc: $("typingAcc"),
  best: $("typingBest"),
  keys: $("typingKeys"),
  again: $("typingAgain"),
  nextText: $("typingNextText"),
  studyText: $("typingStudyText"),
  live: $("typingLive"),
  tabNote: $("typingTabNote"),
  tabs: [...document.querySelectorAll("#typingTabs [data-kind]")]
};

const KINDS = ["en", "ja", "long"];
const KIND_KEY = "spelldash_typing_kind"; // この端末に覚えた種類（タブを押したときだけ書く。学習記録・同期・CSV・バックアップには入れない）
const KIND_NAME = { en: "英単語", ja: "日本語" };
// タブの下の補足（英単語では見せないが行の高さは残す）
const TAB_NOTE = {
  ja: "小・中学校の用語。読みをローマ字で打つ。",
  long: "文章を最後まで打つ。やめても結果が出る。"
};
const STUDY_TEXT = {
  en: "日本語の訳だけを見て、英単語を思い出して打つ。1日5分から。",
  ja: "初めの画面の「ほかの本から始める」で社会・理科を選び、問題文から用語を思い出して打つ。",
  long_ja: "英単語も、打って覚える。日本語の訳だけを見て思い出して打つ。1日5分から。",
  long_en: "日本語の訳だけを見て、英単語を思い出して打つ。1日5分から。"
};
const INPUT_ARIA = {
  word: { label: "見本の語を打つ", describedby: "typingTerm typingWord typingGloss" },
  text: { label: "見本の文を打つ", describedby: "typingLine" }
};
const LONG_HINT = "打ち始めると、最後まで時間を測る。";
const PAUSED_TEXT = "止めた。打つと続きから。";
const ANNOUNCE_GAP_MS = 50; // 読み上げの行を空にしてから書くまで（同じ文を同じタスクで書き直すと読まれない環境がある）

const seconds = secondsFrom(location.search);
const span = seconds === 60 ? "1分" : `${seconds}秒`;
const linesLimit = linesFrom(location.search); // E2E 用の ?l=N（長文の文章を先頭の N 行に切る。その回は自己ベストに書かない）
const guard = createResultGuard();
const clock = createLongClock(); // 長文の時計（最初に判定したキーから最後に判定したキーまで、止めていた間を除く）

let phase = "ready"; // ready | running | paused（長文だけ）| result | loading | error
let kind = "en"; // en | ja | long
let data = null; // null = まだ届いていない／false = 取れなかった／{ en, ja }
let firstRun = true;
let run = null;
let fillOnLoad = false; // 教材が届く前に始めた回（最初の英単語）: 届いたら列の後ろに足す
let endAt = 0;
let shownSecs = -1;
let finishTimer = 0;
let tickTimer = 0;
let announceTimer = 0;
// 長文
let longTexts = null; // null = まだ取っていない／false = 取れなかった／教材の文章の列（data/typing-long.json）
let longFetching = false;
let textId = null; // 選んだ文章（ページを開いている間だけ覚える。端末には保存しない）
let selectBuilt = false; // select の項目を今の記録（済み）で作ったか
let selectPointer = false; // select で pointerdown を見た直後か（ポインタで選んだ change だけ焦点を札へ移す）
let partial = false; // 今の結果が途中まで（Esc・やめる）か

// ---- 開く種類（Batch 65 P1。docs/SPEC_TYPING.md）----
// 順は URL（?kind=en|ja|long、#long）→ この端末の記憶（spelldash_typing_kind）→ 英単語。不正な値は指定なしと同じ。typing.html の head の 1 行が同じ順で
// html[data-typing-kind] に置き（最初の描画の前。css/typing.css がタブ・札・文を出し分ける）、ここはその値から始める（head の 1 行が動かなかったときだけ自分で読む）。
// 書くのはタブを押したときだけ: URL で開いただけでは書かない（共有されたリンク・検索から来た 1 回で、その人が選んだ種類を替えない。開いた URL にはパラメータが残るので再読み込みは同じ種類）。
// 読む・覚える・URL を合わせる・開き直すの形はタイピングゲームのコースと同じ（js/typingKeys.js の choiceFromUrl・startChoice・rememberChoice・reopenLink）。
// #long だけは練習の口: 読み込みのときに ?kind=long に替える（下の起動。PR #166 のレビュー 3）
const KIND_CHOICE = { key: KIND_KEY, param: "kind", dropHash: "#long" };

const kindFromUrl = () => choiceFromUrl(KINDS, "kind") ?? (location.hash === "#long" ? "long" : null);

const startKind = () => startChoice({ ids: KINDS, preset: document.documentElement.dataset.typingKind, fromUrl: kindFromUrl(), key: KIND_KEY, fallback: "en" });

// タブを押した: 種類を端末に覚え、URL を今の種類に合わせる（history.replaceState。履歴は増やさない: 戻るはタブを 1 つずつ戻らずページを離れる。
// 再読み込みは今のタブで開き、記憶が書けない端末でも同じ。アドレスを共有すると今の種類で開く。ほかのパラメータ〔?t= など〕は残し、#long は ?kind= に替える。
// URL が替わるときだけ書く）。canonical は変えない
const chooseKind = (k) => rememberChoice(KIND_CHOICE, k);

function stopTimers() {
  clearTimeout(finishTimer);
  clearInterval(tickTimer);
  finishTimer = 0;
  tickTimer = 0;
}

const focusInput = () => focusOn(el.input);

// 待っている読み上げ（長文の「次の行」・読み込み直後の 1 行）を捨てる（結果の 1 文・止めた・始まる前を上書きしない）
function cancelAnnounce() {
  clearTimeout(announceTimer);
  announceTimer = 0;
}

function setLive(text) {
  cancelAnnounce();
  if (el.live) el.live.textContent = text;
}

// 空にしてから次のタスクで書く（同じ文が続いても黙らない）
function announce(text) {
  setLive("");
  announceTimer = setTimeout(() => {
    announceTimer = 0;
    if (el.live) el.live.textContent = text;
  }, ANNOUNCE_GAP_MS);
}

// ---- 長文の小さな問い ----

const isLong = () => kind === "long";
const currentText = () => (Array.isArray(longTexts) ? longTexts.find((t) => t.id === textId) ?? null : null);
// 文章の言語。教材が届く前は既定の ja（欄の予約は日英で同じ高さなので、英語の文章が届いても札は動かない）
const longLang = () => currentText()?.lang ?? "ja";
const doneIds = () => (Array.isArray(longTexts) ? doneLongIds(storage(), longTexts) : new Set());

// 今の行の読み上げ用の中身（日本語「見出し（読み）」、英語「文 訳」。単位の 2 段は読ませない）
function lineText() {
  const current = run?.current ?? null;
  if (!current) return "";
  return current.kind === "ja" ? `${current.term}（${current.reading}）` : `${current.text} ${current.gloss}`;
}

// ---- 描く ----

function renderWord() {
  const current = run?.current ?? null;
  const w = el.word;
  const long = isLong();
  w.replaceChildren();
  if (!current) {
    w.className = "tp-word";
    w.setAttribute("lang", "ja");
    w.dataset.rest = "";
    if (phase === "loading" || phase === "running") w.append(make("span", "tp-loading", "読み込み中"));
    // 長文は欄の予約を残す（日本語は見出しの欄、英語は訳の欄。教材が届いても今の行の位置が動かない）
    el.term.hidden = !(long && longLang() === "ja");
    el.term.textContent = "";
    el.gloss.hidden = !(long && longLang() === "en");
    el.gloss.textContent = "";
    return;
  }
  if (current.kind === "ja") {
    w.className = run.missPending ? "tp-word tp-word--ja tp-miss" : "tp-word tp-word--ja";
    w.setAttribute("lang", "ja");
    const { units, rest } = current.view();
    appendUnits(w, units, { punct: long }); // 長文は句読点の単位を直前の単位とつなぐ（行頭禁則）
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

// 次の語が無い（教材が届く前・尽きた）ときも行の高さは残す（tp-upnext--empty は visibility: hidden）。届いた瞬間に下の一文が下がらない。
// 長文の次の行は日本語が見出し（run.kind "ja_text"）、英語が文（"en_text"）: どちらも 0 番
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

// 長文の select（群ごとに打鍵の少ない順。教材の並びのまま）。項目の「済み」は検証に通る記録だけから作る
function buildSelect() {
  const done = doneIds();
  const groups = [];
  for (const g of LONG_GROUPS) {
    const list = longTexts.filter((t) => t.lang === g.lang && t.len === g.len);
    if (!list.length) continue;
    const og = document.createElement("optgroup");
    og.label = g.label;
    for (const t of list) og.append(new Option(longOptionLabel(t, done.has(t.id)), t.id));
    groups.push(og);
  }
  el.select.replaceChildren(...groups);
  selectBuilt = true;
}

// 長文の 1 行目（44px を予約。状態で中身だけ替える）: loading は無効の select、ready は select、running・paused は題・残り・やめる、result・error は行ごと隠す
function renderHead() {
  const show = isLong() && phase !== "result" && phase !== "error";
  el.head.hidden = !show;
  if (!show) return;
  const live = phase === "running" || phase === "paused";
  el.select.hidden = live;
  el.title.hidden = !live;
  el.headRight.hidden = !live;
  if (phase === "loading") {
    if (!el.select.disabled || el.select.options.length !== 1) {
      el.select.replaceChildren(new Option("読み込み中", ""));
      selectBuilt = false;
    }
    el.select.disabled = true;
  } else if (phase === "ready") {
    if (!selectBuilt) buildSelect();
    el.select.disabled = false;
    if (el.select.value !== textId) el.select.value = textId;
  }
  if (live) {
    el.title.textContent = currentText()?.title ?? "";
    el.left.textContent = `残り ${run.size - run.stats.words}行`;
  }
}

// 始まる前の一文: 長文は行の高さを残す（running は visibility: hidden。reset.css の [hidden] は行を消すので使わない）、止めたときは同じ場所に「止めた」
function renderHint() {
  if (!isLong()) {
    el.hint.hidden = phase !== "ready";
    el.hint.classList.remove("tp-hint--off");
    return;
  }
  el.hint.hidden = phase === "error";
  el.hint.textContent = phase === "paused" ? PAUSED_TEXT : LONG_HINT;
  el.hint.classList.toggle("tp-hint--off", phase === "running");
}

function renderBoardData() {
  const b = el.board.dataset;
  if (isLong()) {
    b.lang = longLang();
    b.text = textId ?? "";
    b.line = String(run?.stats.words ?? 0);
    b.lines = String(run?.size ?? 0);
    if (phase === "result" && partial) b.partial = "1";
    else delete b.partial;
  } else {
    delete b.lang;
    delete b.text;
    delete b.line;
    delete b.lines;
    delete b.partial;
  }
}

function render() {
  document.documentElement.dataset.typingKind = kind; // css/typing.css の種類の規則（タブ・1 行目・箱の高さ・長文の欄）は html の値で書く。札・箱の data-kind と同じ値に保つ
  el.board.dataset.state = phase;
  el.board.dataset.kind = kind;
  el.stage.dataset.kind = kind; // 箱（.tp-stage）は英単語・日本語の 1 分の結果の高さを取る。長文では取らない（css/typing.css）
  el.stage.dataset.state = phase; // 箱の中の導線（.tp-stage__more）はスマホの始まる前だけ出す（css/typing.css。BACKLOG D36）
  renderBoardData();
  const result = phase === "result";
  el.timer.hidden = isLong() || result || phase === "error"; // 読み込めないときは「残り 60秒」を残さない。長文の残りは 1 行目
  renderHead();
  el.play.hidden = result;
  el.result.hidden = !result;
  if (result) return;
  if (!isLong()) renderTimer();
  renderWord();
  renderNext();
  renderHint();
  el.error.hidden = phase !== "error";
  el.line.textContent = isLong() ? lineText() : "";
  if (phase === "error") {
    reopenLink(el.error.querySelector("a"), "kind", kind); // 「開き直す」は今の種類で（深いリンクで開いて記憶が無い端末でも英単語に戻らない）
    el.next.hidden = true;
    el.word.replaceChildren();
    el.word.dataset.rest = "";
    el.term.hidden = true;
    el.gloss.hidden = true;
  }
}

function tick() {
  if (phase !== "running" || isLong()) return;
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
  el.tabNote.textContent = TAB_NOTE[kind] ?? TAB_NOTE.ja;
  el.tabNote.classList.toggle("tp-tabnote--off", kind === "en"); // 英単語では見せないが行の高さは残す（札が上下しない）
  el.studyText.textContent = isLong() ? STUDY_TEXT[`long_${longLang()}`] : STUDY_TEXT[kind];
  const aria = isLong() ? INPUT_ARIA.text : INPUT_ARIA.word;
  el.input.setAttribute("aria-label", aria.label);
  el.input.setAttribute("aria-describedby", aria.describedby);
}

// opts.keepFocus: 焦点を動かさない（長文の select をキーボードで替えたとき。矢印で 2 つ以上先へ進める）
function toReady(k = kind, opts = {}) {
  stopTimers();
  guard.clear();
  kind = k;
  partial = false;
  clock.reset();
  if (k === "long") {
    const text = currentText();
    run = createRun(text?.lang === "en" ? "en_text" : "ja_text", text ? trimLongLines(text.lines, linesLimit) : []);
    fillOnLoad = false;
    phase = run.current ? "ready" : longTexts === false ? "error" : "loading";
  } else {
    run = createRun(k, wordsFor(k, firstRun));
    fillOnLoad = k === "en" && firstRun && !data; // 教材が届く前に始めた最初の英単語の回: 届いたら列の後ろに足す
    if (k === "en") firstRun = false; // 最初の英単語の回は apple から（日本語・長文で開いたときも、英単語のタブを初めて押した回が apple から）
    phase = run.current ? "ready" : data === false ? "error" : "loading";
  }
  // 長文の画面キーボードのキー（、。・' , 空白 . ?）は body の class で出し入れする。種類が long 以外・読めない画面では必ず外す
  const lang = longLang();
  document.body.classList.toggle("tp-long-ja", k === "long" && lang === "ja" && phase !== "error");
  document.body.classList.toggle("tp-long-en", k === "long" && lang === "en" && phase !== "error");
  if (phase === "error") closeKeyboard(); // 打てない画面では盤面を出さない
  else {
    document.body.classList.add("typing--live");
    document.body.classList.toggle("romaji-answer", k === "ja" || (k === "long" && lang === "ja"));
    window.dispatchEvent(new CustomEvent("spelldash:game-start")); // 画面キーボードを出す（タッチ端末。長文の loading でも出したまま）
  }
  el.errorWhat.textContent = k === "long" ? "長文" : "単語";
  syncTabs();
  setLive("");
  el.hint.textContent = k === "long" ? LONG_HINT : `打ち始めると、${span}を測る。`;
  render();
  if (!modalOpen() && !opts.keepFocus) focusInput(); // ご意見の窓が開いているときは、窓の焦点を取らない
  setTimeout(() => fitAboveKeyboard(el.board), 50);
}

function start(now) {
  if (isLong()) {
    if (phase === "paused") {
      clock.resume(now); // 止めていた間を数え終える（続きのキーの時刻まで）
      phase = "running";
      setLive("");
      render();
      return;
    }
    phase = "running"; // 長文は時間で切らない（タイマーを張らない: setTimeout に Infinity を渡すと 0 になり、すぐ終わる）
    logTypingStage("start");
    render();
    return;
  }
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

// 自己ベストの句（#typingBest）: 区切り＋句（.tp-best__phrase は 1 かたまりで折る: 括弧の中で「はじめての／記録」と折れない）。
// 区切りを句の外に置くので、句が 2 行目に送られても「・」は 1 行目の終わりに残る。parts は fill の形（null なら出さない）
function renderBest(parts) {
  if (!parts) {
    el.best.replaceChildren();
    el.best.hidden = true;
    return;
  }
  const phrase = make("span", "tp-best__phrase");
  fill(phrase, parts);
  el.best.replaceChildren(...sep(), phrase);
  el.best.hidden = false;
}

function bestText(cmp) {
  if (cmp.status === "first") return ["自己ベスト（はじめての記録）"];
  if (cmp.status === "new") return ["自己ベストを更新（前 ", ["b", cmp.prev], "）"];
  if (cmp.status === "same") return ["自己ベストと同じ"];
  if (cmp.status === "below") return ["自己ベスト ", ["b", cmp.prev], `（あと ${cmp.diff}）`];
  return null;
}

// 間違えたキー（ミス 0 なら行ごと出さない）。label は表示の名前（長文の 、。・空白）
function renderKeys(topKeys, label = (k) => k) {
  if (topKeys.length) {
    el.keys.replaceChildren(document.createTextNode("間違えたキー"));
    for (const [key, count] of topKeys) {
      el.keys.append(document.createTextNode(" "), make("span", "tp-key", label(key)), document.createTextNode(" "), make("b", "", String(count)));
    }
    el.keys.hidden = false;
  } else {
    el.keys.replaceChildren();
    el.keys.hidden = true;
  }
}

function renderResult(s, cmp) {
  el.kind.textContent = `${KIND_NAME[kind]}・${span}`;
  el.kpmPre.hidden = true;
  el.kpmUnit.hidden = false;
  el.nextText.hidden = true;
  el.kpm.textContent = String(s.kpm);
  // 正確さ・ミス（行の頭）＋自己ベスト（同じ行の続き #typingBest）
  fill(el.acc, ["正確さ ", ["b", s.accuracy === null ? "―" : `${s.accuracy}%`]]);
  el.acc.append(...sep(), "ミス ", make("b", "", String(s.miss)), el.best);
  renderBest(bestText(cmp));
  renderKeys(s.topKeys);
}

// 名前と数の組を 1 つの span（.tp-pair: 折らない）に。区切りの「 ・ 」の後ろでだけ折れる（「・」は前の組の終わりに残る。js/typingKeys.js の sep）
function pairs(list) {
  const out = [];
  list.forEach(([name, value], i) => {
    if (i) out.push(...sep());
    const pair = make("span", "tp-pair", `${name} `);
    pair.append(make("b", "", String(value)));
    out.push(pair);
  });
  return out;
}

const dash = (v) => (v === null || v === undefined ? "―" : v);

// 長文の結果: 柱（題・時間。途中までは打った行も）・主の数はスコア・補足 1（打/分・正確さ・ミス＋自己ベストの句）・補足 2（間違えたキー）
function renderLongResult(s, cmp, text) {
  const time = formatLongTime(s.sec);
  const title = text?.title ?? "";
  el.kind.textContent = partial ? `${title}・途中まで ${run.stats.words}／${run.size}行・${time}` : `${title}・${time}`;
  el.kpmPre.hidden = false;
  el.kpmUnit.hidden = true;
  el.kpm.textContent = String(dash(s.score));
  el.acc.replaceChildren(...pairs([["打/分", dash(s.kpm)], ["正確さ", s.accuracy === null ? "―" : `${s.accuracy}%`], ["ミス", s.miss]]));
  const phrase = longBestPhrase(cmp);
  el.acc.append(el.best);
  renderBest(phrase ? [phrase] : null);
  const lang = text?.lang ?? "ja";
  renderKeys(s.topKeys, (k) => longKeyLabel(k, lang));
  el.nextText.hidden = false;
}

function longLiveText(s) {
  const nums = `スコア ${dash(s.score)}。${formatLongTime(s.sec)}、打/分 ${dash(s.kpm)}、正確さ ${s.accuracy === null ? "―" : `${s.accuracy}%`}、ミス ${s.miss}。`;
  return partial ? `途中まで、${run.size}行のうち ${run.stats.words}行。${nums}` : nums;
}

// 結果を出したあと（1 分・長文で同じ）: PC は焦点を主の数の行へ、守りを張る
function afterResult() {
  if (!touch) {
    try {
      el.kpmLine.focus({ preventScroll: true });
    } catch {
      // 何もしない
    }
  }
  // 守り（js/typingKeys.js）: 盤面は出したまま（typing--live・romaji-answer を外さず、game-end も投げない）、盤面の外は押させない・結果の Enter／Space を捨てる。
  // 盤面を叩いていた指の次のタップが、下から現れたボタンやリンクに落ちないように。0.6 秒後に盤面を畳む
  guard.arm(closeKeyboard);
}

function finish() {
  if (phase !== "running" || isLong()) return; // 長文は時間で終わらない（結果の道は完走と Esc・やめるの 2 つだけ）
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
    if ((cmp.status === "first" || cmp.status === "new") && !writeBest(store, kind, seconds, { kpm: s.kpm, acc: s.accuracy, day: localDay(new Date()) })) cmp = { status: "none" };
  }
  renderResult(s, cmp);
  render();
  setLive(s.total > 0 ? `${s.kpm} 打/分。正確さ ${s.accuracy}%、ミス ${s.miss}。` : `${s.kpm} 打/分。`);
  afterResult();
  logTypingStage("done");
}

// 長文の結果（完走、または Esc・やめるの途中まで）。時間は最初に判定したキーから最後に判定したキーまで（止めていた間を除く）。
// 自己ベストは完走で ?l= の無い回だけ（途中まで・?l= の回は書かない・比べない）。計測の done は完走だけ（途中までの結果では送らない）
function finishLong(isPartial) {
  stopTimers();
  const text = currentText();
  const s = summarizeLong(run.stats, clock.elapsedMs());
  phase = "result";
  partial = isPartial;
  let cmp = { status: "none" };
  if (!isPartial && linesLimit === null && text) {
    cmp = recordLongBest(storage(), text, { score: s.score, kpm: s.kpm, acc: s.accuracy, sec: s.sec, ms: s.ms, day: localDay(new Date()) }); // 1 時間の上限は ms で見る
    if (cmp.write) selectBuilt = false; // 「済み」を付け直す
  }
  renderLongResult(s, cmp, text);
  render();
  setLive(longLiveText(s));
  afterResult();
  if (!isPartial) {
    logTypingStage("long_done");
    logTypingStage("done");
  }
}

// Esc・ページが裏に回った（1 分の打っている間）: 結果・ベスト・計測なしで始まる前へ
function abandon() {
  toReady(kind);
}

// 長文: 裏に回った・ご意見の窓をマウスで開いた（打っている間）→ 止める（時計を止め、次の 1 打で続きから）
function pauseLong() {
  if (phase !== "running") return;
  clock.pause(performance.now());
  phase = "paused";
  setLive(PAUSED_TEXT); // 待っている「次の行」は捨てる
  render();
}

// 長文: Esc・やめる（打っている間・止めている間）→ 途中までの結果。出す時間が 5 秒未満、または判定したキーが無ければ始まる前へ戻すだけ
function stopLong() {
  if (phase !== "running" && phase !== "paused") return;
  if (stopOutcome(clock) === "result") finishLong(true);
  else toReady("long");
}

function press(key, now) {
  if (isLong()) {
    // 最後まで打った分岐は typing.json の成否（data）より前（英単語の教材が取れない端末でも長文の完走は結果にする）
    const r = run.press(key, now);
    if (r.type === "correct" || r.type === "miss") {
      if (!clock.started) logTypingStage("long_start"); // 長文を初めて打ち始めた（最初に判定したキー）
      clock.count(now); // 判定したキーごと（飲んだキー・数えないキーは数えない）
    }
    if (r.type === "correct" && r.done) {
      if (!run.current) {
        finishLong(false);
        return;
      }
      render();
      announce(`次の行。${lineText()}`); // 打鍵ごとには何も言わない。行が替わったときだけ
      return;
    }
    render();
    return;
  }
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
  // 状態を替えるのは種類が英単語・日本語のときだけ（長文の loading を「単語を読み込めなかった」に書き替えない・長文の待ちに割り込まない）
  if (isLong()) {
    fillOnLoad = false;
    return;
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

// 長文の教材は長文のタブを初めて押したときに 1 回だけ取る（head で先読みしない・sw の precache に入れない）。
// 状態を替えるのは種類が長文のときだけ（届いたときに英単語・日本語のタブなら、しまうだけ）
async function loadLong() {
  if (longFetching || longTexts !== null) return;
  longFetching = true;
  let texts = null;
  try {
    const response = await fetch("./data/typing-long.json");
    if (!response.ok) throw new Error(String(response.status));
    texts = parseLongData(await response.json());
  } catch {
    texts = null;
  }
  longFetching = false;
  longTexts = texts ?? false;
  if (texts && !textId) textId = defaultLongId(texts, doneIds());
  if (!isLong() || phase !== "loading") return;
  toReady("long");
  // 焦点はすでに入力欄にあって動かず describedby が読まれないので、題と今の行を 1 回だけ読ませる
  if (phase === "ready") announce(`${currentText()?.title ?? ""}。${lineText()}`);
}

// 長文のタブ: 初めて押したら計測と教材の取り込み。打っている間・止めている間・始まる前は焦点だけ（回を捨てない）
function openLong() {
  logTypingStage("long"); // 来た日に 1 回だけ（first_visit の source。js/funnelLog.js）
  if (longTexts === null) loadLong();
  if (Array.isArray(longTexts) && !textId) textId = defaultLongId(longTexts, doneIds());
  if (kind !== "long" || phase === "result" || phase === "error") toReady("long");
  else focusInput();
}

// ---- 長文の画面キーボード（keyboard.js・keyboard.css は変えない。initializeKeyboard の後に 1 回だけ差し込む） ----
// 日本語は 、（,）・。（.）、英語は ' , 空白 . ?。出し入れは body の tp-long-ja・tp-long-en と css/typing.css だけ。
// keyboard.js の pointerdown は data-key をそのまま送る。面は keyboard.css の空白（--space）・ー（--dash）を借りる（4 テーマ・夜の面）
function addLongKeys() {
  const row = document.querySelector("#osk .osk__row--3");
  if (!row) return; // 起動が投げた
  const key = (lang, value, label, text, face) => {
    const b = make("button", `osk__key ${face} tp-osk-key tp-osk-key--${lang}`, text);
    b.type = "button";
    b.dataset.key = value;
    b.setAttribute("aria-label", label);
    b.tabIndex = -1;
    return b;
  };
  row.append(
    key("ja", ",", "読点", "、", "osk__key--dash"),
    key("ja", ".", "句点", "。", "osk__key--dash"),
    key("en", "'", "アポストロフィ", "'", "osk__key--dash"),
    key("en", ",", "カンマ", ",", "osk__key--dash"),
    key("en", " ", "空白", "空白", "osk__key--space"),
    key("en", ".", "ピリオド", ".", "osk__key--dash"),
    key("en", "?", "疑問符", "?", "osk__key--dash")
  );
}

// ---- 起動（打てるようにする配線を先に。計測とフッターは最後） ----

for (const tab of el.tabs) {
  tab.addEventListener("click", () => {
    const k = tab.dataset.kind;
    if (!KINDS.includes(k)) return;
    chooseKind(k); // 端末に覚え、URL を合わせる（押したときだけ）
    if (k === "long") {
      openLong();
      return;
    }
    if (k !== kind || phase === "result" || phase === "error") toReady(k);
    else focusInput();
  });
}
el.again.addEventListener("click", () => toReady(kind));
el.nextText.addEventListener("click", () => {
  if (!isLong() || !Array.isArray(longTexts)) return;
  textId = nextLongId(longTexts, textId) ?? textId;
  toReady("long");
});
// select: ポインタで選んだら焦点を札へ（タッチ端末を除く）。キーボードの矢印（閉じた select で change が出る）は焦点を select に残す。
// select の上の Enter で札へ（タッチ端末は焦点を当てない端末なので blur）。タッチ端末は選んだら blur（外付けキーボードの字が select の頭文字探しに渡らないように）
el.select.addEventListener("pointerdown", () => {
  selectPointer = true;
});
el.select.addEventListener("keydown", (event) => {
  selectPointer = false;
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    if (touch) el.select.blur(); // focusInput はタッチ端末では何もしないので、select に焦点が残って次の字が回を始めない
    else focusInput();
  }
});
el.select.addEventListener("change", () => {
  const byPointer = selectPointer;
  selectPointer = false;
  if (!isLong() || phase !== "ready" || !Array.isArray(longTexts) || !longTexts.some((t) => t.id === el.select.value)) return;
  textId = el.select.value;
  toReady("long", { keepFocus: touch || !byPointer });
  if (touch) el.select.blur();
});
el.stop.addEventListener("click", () => {
  if (isLong()) stopLong();
});
document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-typing-study]") : null;
  if (link) logTypingStage("study"); // 積むだけ（移動は止めない。次のページが送る）
});
wireTyping({
  input: el.input,
  board: el.board,
  phase: () => phase,
  timeOf: () => performance.now(), // 受けた時刻（start・press・時間切れの比べもこの時計）
  endAt: () => (isLong() ? Infinity : endAt), // 長文は時間切れが無い（初期値 0 のままだとキーのたびに finish が呼ばれる）
  guard,
  start,
  press,
  finish,
  reset: abandon,
  // 長文の口（1 分の 2 種類は今どおり: romajiKeyOf・Space は数えない・裏に回る／Esc で捨てる・結果の Esc ですぐもう一度）
  keyOf: (event) => (isLong() ? (longLang() === "en" ? textKeyOf(event) : punctKeyOf(event)) : romajiKeyOf(event)),
  spaceIsKey: () => isLong() && longLang() === "en",
  pause: () => (isLong() ? pauseLong() : abandon()),
  stop: () => (isLong() ? stopLong() : abandon()),
  holdResult: () => isLong()
});

try {
  initializeKeyboard({ playingClass: "typing--live", forceOnTouch: true });
  addLongKeys();
} catch {
  // 借り物の初期化で投げても、打鍵の配線は済んでいる
}

// 開く種類（Batch 65 P1）: head の 1 行が置いた html[data-typing-kind] から始める（英単語を描いてから替えない）。長文は教材をここで取りに行く
const linkKind = kindFromUrl(); // 深いリンク（?kind=・#long）で開いた種類。記憶から開いたときは null
// #long の深いリンクは ?kind=long に替える（replaceState。hash は消す・記憶は書かない。PR #166 のレビュー 3）: #long は読み込みのときに 1 回だけ読むので、
// 「本文へ」（#main）などで hash が替わると再読み込みで英単語に戻っていた。?kind= に正しい値があるときの #long は読まないのでそのまま
if (linkKind === "long" && !choiceFromUrl(KINDS, "kind")) syncUrlParam("kind", "long", "#long");
const firstKind = startKind();
if (firstKind === "long") loadLong();
toReady(firstKind);
loadData();

const arrivedNow = markTypingArrival(); // 必ず setFooterYear（trackFirstVisit が端末の番号を作る）より前。true: この端末の最初の 1 ページ
try {
  setFooterYear();
} catch {
  // フッターの借り物が投げても打鍵は止めない
}
logTypingStage("arrive");
// 深いリンクで初めて来た（first_visit の source typing_link。タイピングゲームの tgame_link と同じ形。js/funnelLog.js）。最初の 1 ページだけ:
// タブを押すと URL が ?kind= になるので、そのあとの再読み込み・戻る・タブの復元・ブックマークは URL だけでは外からの深いリンクと区別できない
if (linkKind && arrivedNow) logTypingStage("link");
if (firstKind === "long") logTypingStage("long"); // 長文で開いた（長文のタブを押したのと同じ印。来た日に 1 回だけ）
