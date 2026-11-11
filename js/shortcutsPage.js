// ショートカットキーの画面（Batch 92。docs/SPEC_SHORTCUTS.md）

import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { setupUnloadSync } from "./sync.js";
import { isTouchDevice } from "./keyboard.js";
import { createLive } from "./srLive.js";
import { esc } from "./html.js";
import { SHORTCUTS } from "./shortcutsData.js";
import {
  LAYOUTS, LAYOUT_LABEL, GROUP_LABEL, ADVANCE_WAIT_MS, PROGRESS_KEY, DEVICE_KEY, readCombo, judge, afterWrong, ownText, shouldCancel, isImeEvent, isPhysicalKey, isModifierEvent, modeOf,
  createMissWatcher, shouldAdvance, guardState, isGuardState, onGuardPop, withoutGuard, reloadMark, reloadCounted, readDevice, updateDevice, addMiss, clearMiss, fitDelta,
  readProgress, recordAnswer, stateOf, countStates, dayOf, buildRound, newRound, roundAnswer, capsOf, capsOfCombo, spokenCaps, sigOfCaps, comboString,
  buildChoices, tokensOfCaps, notesOf
} from "./shortcutsCore.js";
import { capsHtml, keyboardSvg, focusSvg, focusWindows, paintKeys, keyboardLabel, scenePairHtml, tileHtml, missedRowHtml, resultHtml, nearHtml } from "./shortcutsArt.js";

initializeAuth();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();

const $ = (id) => document.getElementById(id);
const ROUND_SIZE = 10;
const HOW_TEXT = { press: "キーを本当に押して答える。", choice: "選んで答える。", hold: "押さずに選んで答える（押すと本当に動く・ブラウザやパソコンが先に受け取る）。" };
const LONE_KEYS = new Set(["CapsLock", "NumLock", "ScrollLock", "ContextMenu", "Fn", "FnLock", "Unidentified"]);
const reduced = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const live = createLive(() => $("scLive"), { gap: 50 });
// getItem・setItem だけの口（scripts/test-areas.mjs U1）
const store = { getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) };
const PAD_HINT = ["ここを押してから、キーを押す。", "キーを押す。日本語入力はオフにする。"];

const S = {
  dev: readDevice(store),
  keyboard: !isTouchDevice(),
  group: "",
  progress: readProgress(store),
  round: null,
  q: null,
  guard: { ignore: 0, pushed: false },
  watcher: createMissWatcher(),
  nextArmed: false,
  open: null
};
const paintKb = (p) => { for (const svg of $("scKb").querySelectorAll("svg.kb")) paintKeys(svg, p); };
// 画面の位置（仕様 §2.2）
const rectOf = (el) => el.getBoundingClientRect();
const headerBottom = () => Math.max(0, document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0);
function bringIntoView(top, bottom) {
  const d = fitDelta(top, bottom, headerBottom() + 8, innerHeight - 8);
  if (d) scrollBy(0, d);
}
function focusAt(el, from = el, to = el) {
  if (!el) return;
  bringIntoView(rectOf(from).top, rectOf(to).bottom);
  el.focus({ preventScroll: true });
}
const focusChoice = () => focusAt($("scChoices").querySelector(".sc-choice"), $("scChoices"), $("scChoices"));
const layoutOf = () => S.dev.layout ?? "ctrl";
const itemsOf = (layout) => SHORTCUTS.filter((x) => x.keys?.[layout]);
const env = () => ({ keyboard: S.keyboard, miss: S.dev.miss });
const qText = (x, nth) => (x.id === "br.tab-n" ? x.ja.replace(/(左から )n( 番目)/, `$1${nth}$2`) : x.ja);

// == 一覧
function renderHome(focusId = null, replay) {
  const layout = S.dev.layout;
  for (const r of document.querySelectorAll('input[name="scLayout"]')) r.checked = r.value === layout;
  for (const r of document.querySelectorAll('input[name="scArr"]')) r.checked = r.value === S.dev.arr;
  $("scLayoutHint").hidden = !!layout;
  if (layout) $("scLayoutHint").classList.remove("is-alert");
  $("scDeviceNote").hidden = S.keyboard;
  const missN = layout ? S.dev.miss[layout].length : 0;
  $("scMissNote").hidden = missN === 0;
  if (missN) $("scMissText").textContent = `この端末では ${missN} 組をブラウザかパソコンが先に受け取ったので、選んで答えている。`;
  for (const b of $("scFilter").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.group === S.group));
  renderSum();
  renderMap(focusId, replay);
}

// ほかのタブの練習と端末の設定を読み直す。変わったときだけ一覧を描き直す（開いた詳しい欄と焦点のボタンは残す。仕様 §13）
let seen = JSON.stringify([S.progress, S.dev]);
const reread = () => {
  S.progress = readProgress(store);
  S.dev = readDevice(store);
  return seen !== (seen = JSON.stringify([S.progress, S.dev]));
};
function refresh() {
  const a = document.activeElement;
  if (reread() && !$("scHome").hidden) renderHome(a?.closest?.("#scMap .sc-tile")?.dataset.id, a?.matches?.(".sc-detail__replay"));
}
addEventListener("storage", (e) => {
  if (e.key === null || e.key === PROGRESS_KEY || e.key === DEVICE_KEY) refresh();
});

function renderSum() {
  const layout = layoutOf();
  const c = countStates(S.progress, SHORTCUTS, layout, S.group);
  const n = (v) => `<span class="mw__n">${esc(v)}</span>`;
  const label = S.dev.layout ? `（${LAYOUT_LABEL[layout]}）` : "";
  $("scSum").innerHTML = `<span>${esc(c.total)} 組${esc(label)}</span>　<span>これから ${n(c.new)}</span>　<span>あやふや ${n(c.unsure)}</span>　<span>覚えた ${n(c.learned)}</span>`;
  const meter = $("scMeter");
  meter.querySelector(".sc-meter__learned").style.width = `${c.total ? (c.learned / c.total) * 100 : 0}%`;
  meter.querySelector(".sc-meter__unsure").style.width = `${c.total ? (c.unsure / c.total) * 100 : 0}%`;
}

function renderMap(focusId = null, replay) {
  const layout = layoutOf();
  const groups = S.group ? [S.group] : ["pc", "br"];
  $("scMap").innerHTML = groups.map((g) => {
    const tiles = itemsOf(layout).filter((x) => x.g === g)
      .map((x) => tileHtml(x, layout, { state: stateOf(S.progress, x.id, layout), choice: modeOf(x, layout, env()) === "choice", open: S.open === x.id, arr: S.dev.arr })).join("");
    return `<section class="sc-map__group" aria-labelledby="scMap-${esc(g)}"><h3 class="sc-map__h" id="scMap-${esc(g)}">${esc(GROUP_LABEL[g])}</h3><ul class="sc-map__list">${tiles}</ul></section>`;
  }).join("");
  if (S.open) paintDetail(S.open);
  if (focusId) $("scMap").querySelector(`.sc-tile[data-id="${CSS.escape(focusId)}"] .sc-${replay ? "detail__replay" : "tile__btn"}`)?.focus({ preventScroll: true });
}

function paintDetail(id) {
  const tile = $("scMap").querySelector(`.sc-tile[data-id="${CSS.escape(id)}"]`);
  const x = SHORTCUTS.find((y) => y.id === id);
  if (!tile || !x) return;
  const layout = layoutOf();
  const caps = capsOf(x, layout, 2)[0];
  for (const svg of tile.querySelectorAll(".sc-detail__kb svg.kb")) paintKeys(svg, { target: tokensOfCaps(caps, layout) });
  tile.querySelector(".sc-detail__kb .kb")?.setAttribute("aria-label", keyboardLabel(layout, caps));
}

$("scMap").addEventListener("click", (e) => {
  const replay = e.target.closest?.(".sc-detail__replay");
  if (replay) {
    replayScene(replay.closest(".sc-detail")?.querySelector(".sc-cell--after"));
    return;
  }
  const btn = e.target.closest?.(".sc-tile__btn");
  if (!btn) return;
  const id = btn.closest(".sc-tile").dataset.id;
  S.open = S.open === id ? null : id;
  renderMap(id);
});

// 端末の設定は読み直して変える欄だけを替える（仕様 §13）
function setDevice(field, change) {
  S.dev = { ...S.dev, [field]: updateDevice(store, change).device[field] };
}
for (const [name, field] of [["scLayout", "layout"], ["scArr", "arr"]]) {
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      setDevice(field, (d) => ({ ...d, [field]: r.value }));
      renderHome();
    });
  }
}
$("scFilter").addEventListener("click", (e) => {
  const b = e.target.closest?.("button[data-group]");
  if (!b) return;
  S.group = b.dataset.group;
  S.open = null;
  renderHome();
});
$("scMissReset").addEventListener("click", () => {
  setDevice("miss", clearMiss);
  renderHome();
  focusAt($("scStart"));
});

// == 回
function show(which) {
  $("scHome").hidden = which !== "home";
  $("scPlay").hidden = which !== "play";
  $("scEnd").hidden = which !== "end";
}

function startRound(only = null) {
  reread();
  if (!S.dev.layout) {
    $("scLayoutHint").hidden = false;
    $("scLayoutHint").classList.add("is-alert");
    live.say($("scLayoutHint").textContent);
    show("home");
    focusAt(document.querySelector('input[name="scLayout"]'), $("scLayoutHint"));
    return;
  }
  const layout = S.dev.layout;
  const queue = buildRound(SHORTCUTS, layout, S.progress, { size: only ? 50 : ROUND_SIZE, today: dayOf(Date.now()), group: only ? "" : S.group, only });
  if (!queue.length) return;
  S.round = { st: newRound(queue, S.progress), layout, id: `r${Date.now().toString(36)}` };
  show("play");
  showQuestion();
}

function clearGuard() {
  if (S.guard.pushed) {
    S.guard.pushed = false;
    S.guard.ignore++;
    history.back();
  }
  if (history.state?.sdReload) history.replaceState(withoutGuard(history.state, "sdReload"), "");
}

function showQuestion() {
  const R = S.round;
  let item = R.st.queue[R.st.i];
  while (item && !item.keys?.[R.layout]) {
    R.st = { ...R.st, i: R.st.i + 1 };
    item = R.st.queue[R.st.i];
  }
  if (!item) return endRound();
  const nth = item.id === "br.tab-n" ? 2 + Math.floor(Math.random() * 7) : null;
  S.q = { item, layout: R.layout, nth, state: "waiting", force: null, answeredAt: 0, released: true, answerCode: "", down: new Set(), choices: null };
  S.watcher.reset();
  const play = $("scPlay");
  play.dataset.id = item.id;
  $("scDots").innerHTML = R.st.queue.map((_, i) => `<li class="sc-dots__d${i < R.st.i ? " is-past" : i === R.st.i ? " is-now" : ""}"></li>`).join("");
  $("scCount").textContent = `${Math.min(R.st.i + 1, R.st.queue.length)} / ${R.st.queue.length}`;
  $("scGroup").textContent = GROUP_LABEL[item.g];
  $("scQ").textContent = qText(item, nth);
  $("scScene").innerHTML = scenePairHtml(item, R.layout, nth);
  $("scKb").innerHTML = keyboardSvg(R.layout, S.dev.arr);
  $("scResult").textContent = "";
  $("scResult").dataset.kind = "";
  $("scSuggest").hidden = true;
  $("scNotes").hidden = true;
  $("scNow").textContent = "";
  renderMode(true);
  $("scPadHint").textContent = PAD_HINT[+(document.activeElement === $("scPad"))];
  // 守り: 戻るの問いだけ段を 1 つ足す。再読み込みの問いは今の段に印
  if (S.q.mode === "guard" && item.id === "br.back") {
    history.pushState(guardState(R.id), "");
    S.guard.pushed = true;
  }
  if (S.q.mode === "guard" && item.id === "br.reload") history.replaceState({ ...(history.state ?? {}), sdReload: reloadMark("br.reload", R.layout, Date.now(), !(item.id in R.st.firsts)) }, "");
}

function renderMode(focus) {
  const q = S.q;
  const base = modeOf(q.item, q.layout, env());
  q.mode = q.force ?? base;
  const play = $("scPlay");
  play.dataset.mode = q.mode;
  play.dataset.state = q.state;
  const press = q.mode !== "choice";
  const waiting = q.state === "waiting";
  const k = q.item.keys[q.layout];
  // キーの無い端末には「押さずに」を言わない（仕様 §14）
  const hold = S.keyboard && k.how === "choice" && (k.why === "browser" || k.why === "os");
  $("scHow").textContent = press ? HOW_TEXT.press : hold ? HOW_TEXT.hold : HOW_TEXT.choice;
  $("scPad").hidden = !press;
  $("scPadHint").hidden = !waiting;
  // 答えた後は札を隠す（仕様 §2.3）
  $("scChoices").hidden = press || !waiting;
  $("scHold").hidden = press || !hold || !waiting;
  $("scKb").hidden = !press && waiting;
  if (!press && waiting) {
    if (!q.choices) q.choices = buildChoices(q.item, q.layout, SHORTCUTS, Math.random, q.nth);
    $("scChoices").innerHTML = q.choices.map((c, i) => `<button type="button" class="sc-choice" data-ok="${c.correct ? "1" : "0"}" data-i="${i}" aria-label="${esc(`${i + 1}. ${spokenCaps(c.caps, "and")}`)}">` +
      `<span class="sc-choice__n" aria-hidden="true">${i + 1}</span><span class="sc-choice__keys">${capsHtml(c.caps)}</span></button>`).join("");
  }
  $("scChoose").hidden = !(waiting && press);
  $("scDunno").hidden = !waiting;
  $("scNext").hidden = waiting;
  $("scReplay").hidden = waiting;
  $("scRetry").hidden = true;
  if (focus && waiting) focusAt(press ? $("scPad") : $("scQ"), $("scPlay"), $("scQ"));
}

function setResult(kind, html) {
  const r = $("scResult");
  r.dataset.kind = kind;
  r.innerHTML = html;
}

$("scPad").addEventListener("keydown", (e) => {
  const q = S.q;
  if (!q || $("scPlay").hidden) return;
  if (q.state === "done") {
    if (shouldCancel(e)) e.preventDefault();
    if (e.key === "Escape") return $("scNext").focus({ preventScroll: true });
    if (shouldAdvance(e, { answeredAt: q.answeredAt, released: q.released }, performance.now())) {
      e.preventDefault();
      goNext();
    }
    return;
  }
  if (!e.isTrusted) return;
  const now = performance.now();
  if (e.code) q.down.add(e.code);
  paintKb({ down: [...q.down] });
  if (isModifierEvent(e)) {
    if (shouldCancel(e)) e.preventDefault();
    S.watcher.keydown(e, now);
    $("scNow").innerHTML = capsHtml(capsOfCombo({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key: "" }, q.layout).slice(0, -1));
    return;
  }
  S.watcher.keydown(e, now);
  const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (e.key === "Tab" && bare) return;
  if (e.key === "Escape" || e.key === "Esc") {
    q.force = "choice";
    renderMode(false);
    focusChoice();
    return;
  }
  if (shouldCancel(e)) e.preventDefault();
  if (e.repeat || LONE_KEYS.has(e.key)) return;
  if (isImeEvent(e)) return imeHint();
  if (e.key === "Enter" && bare && !e.shiftKey) return;
  const combo = readCombo(e, q.layout);
  const v = judge(q.item, q.layout, combo, q.nth);
  if (v === "unclear") return imeHint();
  $("scNow").innerHTML = capsHtml(capsOfCombo(combo, q.layout));
  if (v === "near") {
    setResult("near", nearHtml(capsOfCombo(combo, q.layout), capsOf(q.item, q.layout, q.nth)[0]));
    live.say($("scResult").textContent);
    return;
  }
  answer(v === "ok" ? "ok" : "wrong", "p", { combo, code: e.code });
});

function imeHint() {
  $("scPadHint").textContent = "日本語入力をオフにしてから押す。";
  live.say("日本語入力をオフにしてから押す。");
}

$("scPad").addEventListener("keyup", (e) => {
  const q = S.q;
  if (!q) return;
  S.watcher.keyup(e);
  if (isModifierEvent(e)) q.down.clear();
  else q.down.delete(e.code);
  paintKb(q.state === "done" ? { ...q.paint, down: [...q.down] } : { down: [...q.down] });
});

function lost() {
  const q = S.q;
  if (!q) return;
  q.down.clear();
  if (q.state !== "waiting" || q.mode === "choice") {
    S.watcher.reset();
    return;
  }
  paintKb({});
  const r = S.watcher.lost(performance.now(), q.item, q.layout);
  if (!r) return;
  q.force = "choice";
  if (r.persist) {
    setDevice("miss", (d) => addMiss(d, q.layout, r.combos));
    renderMode(false);
    setResult("miss", esc("ブラウザかパソコンが先に受け取ったようだ。この組は、この端末では選んで答える。"));
  } else {
    renderMode(false);
    setResult("miss", esc("押せなかったようだ。この問いは選んで答える。"));
    $("scRetry").hidden = false;
  }
  live.say($("scResult").textContent);
}
$("scPad").addEventListener("blur", lost);
document.addEventListener("visibilitychange", () => (document.hidden ? lost() : refresh()));
// 押す枠の案内は焦点の有無で替える（待つ間だけ）
for (const [type, i] of [["focus", 1], ["blur", 0]]) $("scPad").addEventListener(type, () => S.q?.state === "waiting" && ($("scPadHint").textContent = PAD_HINT[i]));

// 答えた後も #scPlay の中で止める（仕様 §5）
$("scPlay").addEventListener("keydown", (e) => {
  const q = S.q;
  if (!q || q.state !== "done" || e.target === $("scPad") || !shouldCancel(e)) return;
  if (e.ctrlKey || e.metaKey || e.altKey || /^F\d/.test(e.key) || e.repeat || !(q.released || performance.now() - q.answeredAt >= ADVANCE_WAIT_MS)) e.preventDefault();
});
$("scPlay").addEventListener("keyup", (e) => {
  if (S.q?.state === "done" && e.code === S.q.answerCode) S.q.released = true;
});

$("scRetry").addEventListener("click", () => {
  const q = S.q;
  if (!q || q.state !== "waiting") return;
  q.force = null;
  setResult("", "");
  renderMode(true);
});
$("scChoose").addEventListener("click", () => {
  const q = S.q;
  if (!q || q.state !== "waiting") return;
  q.force = "choice";
  renderMode(false);
  focusChoice();
});
$("scChoices").addEventListener("click", (e) => {
  const b = e.target.closest?.(".sc-choice");
  if (!b || S.q?.state !== "waiting") return;
  pick(Number(b.dataset.i));
});
function pick(i) {
  const q = S.q;
  const c = q.choices?.[i];
  if (!c) return;
  answer(c.correct ? "ok" : "wrong", "c", { picked: c });
}
$("scDunno").addEventListener("click", () => {
  const q = S.q;
  if (!q || q.state !== "waiting") return;
  answer("wrong", q.mode === "choice" ? "c" : "p", { dunno: true });
});

document.addEventListener("keydown", (e) => {
  const t = e.target;
  const inField = t instanceof Element && !!t.closest("input, textarea, select, [contenteditable='true']");
  if (!S.keyboard && isPhysicalKey(e) && !inField && !isImeEvent(e)) {
    S.keyboard = true;
    live.say("キーボードがつながった。押して答えられる。");
    $("scDeviceNote").hidden = true;
    if (!$("scHome").hidden) {
      renderMap(t instanceof Element ? t.closest(".sc-tile")?.dataset.id : null);
    }
  }
  const q = S.q;
  if (!q || $("scPlay").hidden || q.state !== "waiting" || q.mode !== "choice" || inField) return;
  if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-4]$/.test(e.key)) return;
  e.preventDefault();
  pick(Number(e.key) - 1);
});

function answer(result, how, { combo = null, code = "", picked = null, dunno = false, said = "" } = {}) {
  const q = S.q;
  const R = S.round;
  const now = Date.now();
  q.state = "done";
  q.answeredAt = performance.now();
  q.answerCode = code;
  q.released = !code;
  const r = roundAnswer(R.st, { item: q.item, layout: q.layout, result, how, nowMs: now });
  R.st = r.st;
  let saved = true;
  if (r.recorded) {
    // 読み直して当てる（仕様 §10。最初の答えだけは R.st.firsts）
    const w = recordAnswer(store, q.item.id, q.layout, result === "ok", now, how);
    S.progress = R.st.progress = w.progress;
    saved = w.saved;
  }
  clearGuard();
  const variants = capsOf(q.item, q.layout, q.nth);
  const k = q.item.keys[q.layout];
  let right = variants[0];
  if (result === "ok" && combo) right = [...variants, ...(k.alt ?? [])].find((caps) => sigOfCaps(caps, q.layout) === comboString(combo)) ?? variants[0];
  const wrong = result !== "ok" && !dunno;
  const pressed = wrong && combo ? capsOfCombo(combo, q.layout) : null;
  const pickedCaps = wrong && !combo ? picked?.caps ?? null : null;
  const aw = wrong && combo ? afterWrong(q.item, q.layout, combo, q.nth, SHORTCUTS) : null;
  const head = result === "ok" ? "正解" : dunno ? "こう押す" : "ちがう";
  const lines = [aw?.own ? ownText(aw.own) : "", said, saved ? "" : "この端末に保存できなかった。"].filter(Boolean);
  setResult(dunno ? "dunno" : result, resultHtml({ head, right, pressed, picked: pickedCaps, lines }));
  if (aw?.suggest) {
    const other = aw.suggest;
    $("scSuggestText").textContent = `${LAYOUT_LABEL[other]}の押し方だった。切り替える？`;
    $("scSwitch").textContent = `${LAYOUT_LABEL[other]}にする`;
    $("scSwitch").dataset.layout = other;
    $("scSuggest").hidden = false;
  }
  const notes = notesOf(q.item, q.layout);
  $("scNotes").textContent = notes.join(" ");
  $("scNotes").hidden = notes.length === 0;
  q.paint = { target: tokensOfCaps(right, q.layout), wrong: tokensOfCaps(pressed ?? pickedCaps ?? [], q.layout) };
  const kb = $("scKb");
  kb.hidden = false;
  kb.innerHTML = keyboardSvg(q.layout, S.dev.arr, { frames: focusWindows(q.layout, S.dev.arr, q.paint.target) }) + focusSvg(q.layout, S.dev.arr, q.paint.target);
  paintKb({ ...q.paint, down: [...q.down] });
  kb.querySelector(".kb")?.setAttribute("aria-label", keyboardLabel(q.layout, right));
  renderMode(false);
  $("scPlay").dataset.state = "done";
  // 読み上げは結果の行と同じ材料（仕様 §15）
  const tell = [head, (wrong ? "正しくは " : "") + spokenCaps(right, "hold"), pressed && `押したのは ${spokenCaps(pressed, "hold")}`, pickedCaps && `選んだのは ${spokenCaps(pickedCaps, "hold")}`,
    ...lines, aw?.suggest && `${LAYOUT_LABEL[aw.suggest]}の押し方だった。切り替えるボタンがある`];
  live.say(`${tell.filter(Boolean).join("。")}。`.replace(/。+/g, "。"));
  S.nextArmed = false;
  const next = $("scNext");
  const fits = rectOf(next).bottom - rectOf($("scScene")).top <= innerHeight - 16 - headerBottom();
  focusAt(next, fits ? $("scScene") : kb, next);
  const cell = $("scScene").querySelector(".sc-cell--after");
  const cr = cell?.getBoundingClientRect();
  if (cr && (reduced() || (cr.top >= headerBottom() && cr.bottom <= innerHeight))) playScene(cell);
}

function playScene(cell) {
  if (!cell) return;
  if (reduced()) {
    cell.classList.add("is-done");
    return;
  }
  cell.classList.remove("is-play");
  void cell.offsetWidth;
  cell.classList.add("is-play");
}
function replayScene(cell) {
  if (!cell) return;
  bringIntoView(rectOf(cell).top, rectOf(cell).bottom);
  playScene(cell);
}
$("scReplay").addEventListener("click", () => replayScene($("scScene").querySelector(".sc-cell--after")));

$("scSwitch").addEventListener("click", () => {
  const other = $("scSwitch").dataset.layout;
  if (!LAYOUTS.includes(other)) return;
  setDevice("layout", (d) => ({ ...d, layout: other }));
  if (S.round) S.round.layout = other;
  $("scSuggest").hidden = true;
  live.say(`${LAYOUT_LABEL[other]}にした。`);
  $("scNext").focus({ preventScroll: true });
});

// 次へ: Enter・Space の keydown がボタンの上で始まったときだけ押せる（仕様 §8）
$("scNext").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (e.repeat) e.preventDefault();
  else S.nextArmed = true;
});
$("scNext").addEventListener("keyup", (e) => {
  if (e.key === " " && !S.nextArmed) e.preventDefault();
});
$("scNext").addEventListener("click", goNext);
function goNext() {
  const R = S.round;
  if (!R || S.q?.state !== "done") return;
  R.st = { ...R.st, i: R.st.i + 1 };
  if (R.st.i >= R.st.queue.length) return endRound();
  showQuestion();
}

function endRound() {
  const R = S.round;
  S.q = null;
  const firsts = Object.entries(R.st.firsts);
  const okN = firsts.filter(([, ok]) => ok).length;
  $("scScore").textContent = `${firsts.length} 問のうち ${okN} 問 正解`;
  const missed = firsts.filter(([, ok]) => !ok).map(([id]) => SHORTCUTS.find((x) => x.id === id)).filter(Boolean);
  $("scMissed").innerHTML = missed.map((x) => missedRowHtml(x, R.layout)).join("");
  $("scMissed").hidden = $("scMissedTitle").hidden = missed.length === 0;
  $("scAgain").hidden = missed.length === 0;
  R.missed = missed.map((x) => x.id);
  show("end");
  renderHome();
  focusAt($("scEndTitle"), $("scEnd"));
  live.say(`おつかれさま。${$("scScore").textContent}。`);
}
$("scAgain").addEventListener("click", () => startRound(S.round?.missed ?? null));
$("scMore").addEventListener("click", () => startRound());
$("scBack").addEventListener("click", () => {
  show("home");
  focusAt($("scStart"));
});
$("scQuit").addEventListener("click", () => {
  clearGuard();
  S.q = null;
  S.round = null;
  show("home");
  renderHome();
  focusAt($("scStart"));
});
$("scStart").addEventListener("click", () => startRound());

// == 戻る・進む・再読み込みの守り（仕様 §9）
addEventListener("popstate", (e) => {
  const q = S.q;
  const waiting = q && q.state === "waiting" && q.mode === "guard" ? q.item.id : null;
  const act = onGuardPop(e.state, { ignore: S.guard.ignore, waiting, pushed: S.guard.pushed });
  if (act === "self") {
    S.guard.ignore--;
    return;
  }
  if (act === "count") {
    S.guard.pushed = false;
    answer("ok", "p", { said: "ブラウザが先に動いたが、押せた。" });
    return;
  }
  if (act === "count-back") {
    answer("ok", "p", { said: "ブラウザが先に動いたが、押せた。" });
    S.guard.ignore++;
    history.back();
    return;
  }
  if (act === "back") {
    S.guard.ignore++;
    history.back();
  }
});
addEventListener("pageshow", (e) => {
  if (isGuardState(history.state)) history.replaceState(withoutGuard(history.state), "");
  S.guard.pushed = false;
  if (e.persisted) refresh();
});

function reloadCheck() {
  const st = history.state;
  if (!st?.sdReload) return;
  const nav = performance.getEntriesByType?.("navigation")?.[0]?.type ?? "";
  const hit = reloadCounted(st, nav, Date.now());
  history.replaceState(withoutGuard(st, "sdReload"), "");
  if (!hit) return;
  // 2 回目の出題は記録しない（仕様 §10）
  if (hit.first) S.progress = recordAnswer(store, hit.id, hit.layout, true, Date.now(), "p").progress;
  const x = SHORTCUTS.find((y) => y.id === hit.id);
  const n = $("scNotice");
  n.textContent = `読み込み直した。さっきの問い（${x?.ja ?? ""}）は押せた。`;
  n.hidden = false;
  live.say(n.textContent);
}

if (isGuardState(history.state)) history.replaceState(withoutGuard(history.state), "");
reloadCheck();
renderHome();
