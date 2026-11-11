// ショートカットキーの絵と組み立て（Batch 92。docs/SPEC_SHORTCUTS.md §12）。字は esc する

import { esc } from "./html.js";
import { LEARN_LABELS } from "./learnState.js";
import { tokensOfCaps as capsTokens, spokenCap, spokenCaps, LAYOUT_LABEL, capsOf, notesOf, textCaps } from "./shortcutsCore.js";

export const tokensOfCaps = capsTokens;
export const SCENE_MIN_FONT = 10;

const SYM = {
  "⌘": "M3.5 2A1.5 1.5 0 1 0 2 3.5H8A1.5 1.5 0 1 0 6.5 2V8A1.5 1.5 0 1 0 8 6.5H2A1.5 1.5 0 1 0 3.5 8Z",
  "⌥": "M1 3H4L7 8H9M6 3H9",
  "⌃": "M2 6.5L5 3.2L8 6.5",
  "⇧": "M5 1.6L8.6 5.4H6.6V8.6H3.4V5.4H1.4Z",
  "⊞": "M1.6 1.6H8.4V8.4H1.6ZM5 1.6V8.4M1.6 5H8.4",
  "←": "M8.5 5H1.8M4.4 2.2L1.6 5L4.4 7.8",
  "→": "M1.5 5H8.2M5.6 2.2L8.4 5L5.6 7.8",
  "↑": "M5 8.5V1.8M2.2 4.4L5 1.6L7.8 4.4",
  "↓": "M5 1.5V8.2M2.2 5.6L5 8.4L7.8 5.6"
};

export function capHtml(cap) {
  const d = SYM[cap];
  if (!d) return `<kbd class="kc">${esc(cap)}</kbd>`;
  return `<kbd class="kc kc--sym"><svg viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="${esc(d)}"/></svg><span class="sr-only">${esc(spokenCap(cap))}</span></kbd>`;
}
export function capsHtml(caps) {
  return caps.map(capHtml).join('<span class="kc-plus" aria-hidden="true">+</span>');
}
export function variantsHtml(variants) {
  return variants.map((caps) => `<span class="kc-set">${capsHtml(caps)}</span>`).join('<span class="kc-or">/</span>');
}

// == 画面の組み立て（scripts/test-text-safe.mjs 8）
const STATE_KEY = ["new", "unsure", "learned"];
export function tileHtml(x, layout, { state = 0, choice = false, open = false, arr = "jis" } = {}) {
  return `<li class="sc-tile${open ? " is-open" : ""}" data-id="${esc(x.id)}"><button type="button" class="sc-tile__btn" aria-expanded="${open}" aria-controls="scDetail-${esc(x.id)}">` +
    `<span class="sc-tile__keys">${variantsHtml(capsOf(x, layout))}</span><span class="sc-tile__ja">${esc(x.ja)}</span>` +
    `<span class="sc-tile__meta"><span class="mw-row__state mw-row__state--${STATE_KEY[state] ?? "new"}">${esc(LEARN_LABELS[state] ?? "")}</span>${choice ? '<span class="sc-tile__choice">選んで答える</span>' : ""}</span></button>` +
    `<div class="sc-detail" id="scDetail-${esc(x.id)}"${open ? "" : " hidden"}>${open ? detailHtml(x, layout, arr) : ""}</div></li>`;
}
export function detailHtml(x, layout, arr = "jis") {
  const notes = notesOf(x, layout).map((s) => `<p class="sc-detail__note">${esc(s)}</p>`).join("");
  const tk = capsTokens(capsOf(x, layout, 2)[0] ?? [], layout);
  return `<div class="sc-detail__keys">${variantsHtml(capsOf(x, layout, 2))}</div>${scenePairHtml(x, layout, 2)}` +
    `<div class="sc-detail__kb">${keyboardSvg(layout, arr, { frames: focusWindows(layout, arr, tk) })}${focusSvg(layout, arr, tk)}</div>${notes}` +
    `<button type="button" class="btn btn--sm btn--ghost sc-detail__replay">動きをもう一度見る</button>`;
}
export const missedRowHtml = (x, layout) => `<li class="sc-end__row"><span class="sc-end__keys">${capsHtml(capsOf(x, layout, 2)[0] ?? [])}</span><span class="sc-end__ja">${esc(x.short)}</span></li>`;
export function resultHtml({ head, right, pressed = null, picked = null, lines = [] }) {
  const parts = [`<span class="sc-result__h">${esc(head)}</span>${capsHtml(right)}`];
  if (pressed) parts.push(`<span class="sc-result__pressed">押したキー: ${esc(textCaps(pressed))}</span>`);
  else if (picked) parts.push(`<span class="sc-result__pressed">選んだ組: ${esc(textCaps(picked))}</span>`);
  for (const line of lines) parts.push(`<span class="sc-result__own">${esc(line)}</span>`);
  return parts.join(" ");
}
export const nearHtml = (pressed, right) => `${esc(textCaps(pressed))} を使うアプリもある。ここでは ${esc(textCaps(right))} で答える。`;

// == キーボードの絵（1 キー = 20 単位。仕様 §12）
const U = 20;
const FH = 0.72 * U;
const BOARD_H = FH + 0.2 * U + 5 * U;
const boardW = (layout) => (layout === "ctrl" ? 16.65 : 15) * U;
// [札, code, 判定の字, 幅]
function rowsOf(layout, arr) {
  const L = (s) => [...s].map((c) => [c.toUpperCase(), "Key" + c.toUpperCase(), c, 1]);
  const D = (s) => [...s].map((c) => [c, "Digit" + c, c, 1]);
  const jis = arr === "jis";
  const cmd = layout === "cmd";
  const gap = ["", "", "", 0.25];
  const fn = [["Esc", "Escape", "Escape", 1], gap, ...[1, 2, 3, 4].map((i) => ["F" + i, "F" + i, "F" + i, 1]), gap, ...[5, 6, 7, 8].map((i) => ["F" + i, "F" + i, "F" + i, 1]), gap,
    ...[9, 10, 11, 12].map((i) => ["F" + i, "F" + i, "F" + i, 1])];
  if (!cmd) fn.push(["PrtSc", "PrintScreen", "PrintScreen", 1.25]);
  const bs = cmd ? ["delete", "Backspace", "Backspace"] : [jis ? "BS" : "Backspace", "Backspace", "Backspace"];
  const r1 = jis
    ? [...(cmd ? [] : [["半/全", "Backquote", "`", 1]]), ...D("1234567890"), ["-", "Minus", "minus", 1], ["^", "Equal", "^", 1], ["¥", "IntlYen", "¥", 1], [...bs, cmd ? 2 : 1]]
    : [["`", "Backquote", "`", 1], ...D("1234567890"), ["-", "Minus", "minus", 1], ["= +", "Equal", "plus", 1], [...bs, 2]];
  const r2 = jis
    ? [["Tab", "Tab", "Tab", 1.5], ...L("qwertyuiop"), ["@", "BracketLeft", "@", 1], ["[", "BracketRight", "[", 1], ["Enter", "Enter", "Enter", 1.5]]
    : [["Tab", "Tab", "Tab", 1.5], ...L("qwertyuiop"), ["[", "BracketLeft", "[", 1], ["]", "BracketRight", "]", 1], ["\\", "Backslash", "\\", 1.5]];
  // ⌘ の日本語の並び: A の左は control（⌃）。Caps は描かない
  const first3 = jis && cmd ? ["⌃", "ControlLeft", "ctrl", 1.75] : ["Caps", "CapsLock", "CapsLock", 1.75];
  const r3 = jis
    ? [first3, ...L("asdfghjkl"), ["; +", "Semicolon", "plus", 1], [":", "Quote", ":", 1], ["]", "Backslash", "]", 1], ["", "Enter", "Enter", 1.25]]
    : [first3, ...L("asdfghjkl"), [";", "Semicolon", ";", 1], ["'", "Quote", "'", 1], ["Enter", "Enter", "Enter", 2.25]];
  const sh = cmd ? "⇧" : "Shift";
  const r4 = jis
    ? [[sh, "ShiftLeft", "shift", 2.25], ...L("zxcvbnm"), [",", "Comma", ",", 1], [".", "Period", ".", 1], ["/", "Slash", "/", 1], ["\\", "IntlRo", "\\", 1], [sh, "ShiftRight", "shift", 1.75]]
    : [[sh, "ShiftLeft", "shift", 2.25], ...L("zxcvbnm"), [",", "Comma", ",", 1], [".", "Period", ".", 1], ["/", "Slash", "/", 1], [sh, "ShiftRight", "shift", 2.75]];
  let r5;
  if (!cmd) {
    r5 = jis
      ? [["Ctrl", "ControlLeft", "ctrl", 1.25], ["⊞", "MetaLeft", "meta", 1.25], ["Alt", "AltLeft", "alt", 1.25], ["無変換", "NonConvert", "NonConvert", 1.25], ["Space", "Space", "Space", 3.25],
        ["変換", "Convert", "Convert", 1], ["かな", "KanaMode", "KanaMode", 1], ["Ctrl", "ControlRight", "ctrl", 1.25]]
      : [["Ctrl", "ControlLeft", "ctrl", 1.25], ["⊞", "MetaLeft", "meta", 1.25], ["Alt", "AltLeft", "alt", 1.25], ["Space", "Space", "Space", 5.25], ["Alt", "AltRight", "alt", 1.25], ["Ctrl", "ControlRight", "ctrl", 1.25]];
  } else {
    r5 = jis
      ? [["fn", "Fn", "fn", 1.25], ["⌥", "AltLeft", "alt", 1.25], ["⌘", "MetaLeft", "meta", 1.25], ["英数", "Lang2", "Lang2", 1.25], ["Space", "Space", "Space", 3.5], ["かな", "Lang1", "Lang1", 1.25],
        ["⌘", "MetaRight", "meta", 1.25]]
      : [["fn", "Fn", "fn", 1], ["⌃", "ControlLeft", "ctrl", 1], ["⌥", "AltLeft", "alt", 1], ["⌘", "MetaLeft", "meta", 1.25], ["Space", "Space", "Space", 5.25], ["⌘", "MetaRight", "meta", 1.25],
        ["⌥", "AltRight", "alt", 1.25]];
  }
  return { fn, rows: [r1, r2, r3, r4, r5] };
}

// キーの一覧（全体の絵と寄せた絵が使う）
export function boardKeys(layout, arr = "jis") {
  const { fn, rows } = rowsOf(layout, arr);
  const out = [];
  const add = (x, y, w, h, [label, code, t]) => out.push({ x, y, w: w * U, h, label, code, t });
  let x = 0;
  for (const k of fn) {
    if (k[1]) add(x, 0, k[3], FH, k);
    x += k[3] * U;
  }
  rows.forEach((row, i) => {
    let xx = 0;
    const y = FH + 0.2 * U + i * U;
    for (const k of row) {
      add(xx, y, k[3], U, k);
      xx += k[3] * U;
    }
    if (i === 4) {
      const ax = 12 * U;
      add(ax + U, y, 1, U / 2, ["↑", "ArrowUp", "ArrowUp"]);
      add(ax, y + U / 2, 1, U / 2, ["←", "ArrowLeft", "ArrowLeft"]);
      add(ax + U, y + U / 2, 1, U / 2, ["↓", "ArrowDown", "ArrowDown"]);
      add(ax + 2 * U, y + U / 2, 1, U / 2, ["→", "ArrowRight", "ArrowRight"]);
    }
  });
  if (layout === "ctrl") {
    const sx = 15.4 * U;
    add(sx, 0, 1.25, FH, ["Ins", "Insert", "Insert"]);
    [["Del", "Delete"], ["Home", "Home"], ["End", "End"], ["PgUp", "PageUp"], ["PgDn", "PageDown"]].forEach(([l, c], i) => add(sx, FH + 0.2 * U + i * U, 1.25, U, [l, c, c]));
  }
  return out;
}

// 字の幅の見積もり（em）とキーに収める字の大きさ
const emW = (s) => [...String(s)].reduce((a, ch) => a + (/[/il1.,;:'|!\[\]]/.test(ch) ? 0.32 : /[mwMW]/.test(ch) ? 0.88 : /[A-Z]/.test(ch) ? 0.68 : /[ -~]/.test(ch) ? 0.58 : 1), 0);
const fitFont = (k, want) => Math.min(want, (k.w - 3) / emW(k.label), (k.h - 2) * 0.62);
function keyHtml(k, font, sym) {
  const cx = k.x + k.w / 2;
  const cy = k.y + k.h / 2;
  const d = SYM[k.label];
  let face = "";
  if (d) {
    const s = sym(k);
    face = `<path class="kb-sym" d="${esc(d)}" transform="translate(${(cx - s / 2).toFixed(1)} ${(cy - s / 2).toFixed(1)}) scale(${(s / 10).toFixed(3)})"/>`;
  } else if (k.label) {
    const fs = Math.floor(font(k) * 100) / 100;
    face = `<text x="${cx.toFixed(1)}" y="${(cy + fs * 0.35).toFixed(1)}" font-size="${fs}">${esc(k.label)}</text>`;
  }
  return `<g class="kb-k" data-code="${esc(k.code)}" data-t="${esc(k.t)}"><rect x="${(k.x + 1).toFixed(1)}" y="${(k.y + 1).toFixed(1)}" width="${(k.w - 2).toFixed(1)}" height="${(k.h - 2).toFixed(1)}" rx="2.6"/>${face}</g>`;
}
const rectAt = (cls, x, y, w, h) => `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3"/>`;

// frames: 寄せた所の枠
export function keyboardSvg(layout, arr = "jis", { frames = [] } = {}) {
  const keys = boardKeys(layout, arr).map((k) => keyHtml(k, (q) => fitFont(q, [...q.label].length === 1 ? 8.6 : 7), (q) => Math.min(q.h * 0.75, 11))).join("");
  const fr = frames.map((f) => rectAt("kb-win", f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0)).join("");
  const label = `${LAYOUT_LABEL[layout] ?? ""}の絵`;
  return `<svg class="kb${fr ? " kb-over" : ""}" viewBox="-2 -2 ${(boardW(layout) + 4).toFixed(0)} ${(BOARD_H + 4).toFixed(0)}" role="img" aria-label="${esc(label)}" focusable="false">${keys}${fr}</svg>`;
}

const MODS = new Set(["ctrl", "alt", "shift", "meta"]);
// 修飾は左のキーだけ
const isHit = (list, t, code) => list.includes(t) && !(MODS.has(t) && /Right$/.test(code));

// == 寄せた絵（仕様 §12）
export const FOCUS_AVAIL = 262; // 320 の幅の絵の幅（px）
const SEP = 0.8 * U;
const S_MAX = 1.75;
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) });
// 窓: 近い押すキーをまとめて 2 か所まで。横に 1 キー（½・0）の余白、縦は 4 段まで
export function focusWindows(layout, arr, tokens) {
  const cl = [];
  for (const k of boardKeys(layout, arr).filter((q) => isHit(tokens, q.t, q.code)).sort((a, b) => a.x - b.x)) {
    const b = { x0: k.x, x1: k.x + k.w, y0: k.y, y1: k.y + k.h };
    const i = cl.findIndex((c) => b.x0 - c.x1 <= 3 * U && Math.max(c.y1, b.y1) - Math.min(c.y0, b.y0) <= 4 * U + 1);
    if (i < 0) cl.push(b);
    else cl[i] = union(cl[i], b);
  }
  while (cl.length > 2) cl.push(union(cl.pop(), cl.pop()));
  const BW = boardW(layout);
  const plan = (m) => cl.map((c) => {
    let x0 = Math.max(0, c.x0 - m);
    let x1 = Math.min(BW, c.x1 + m);
    if (x1 - x0 < 3 * U) {
      x0 = Math.max(0, Math.min((x0 + x1) / 2 - 1.5 * U, BW - 3 * U));
      x1 = x0 + 3 * U;
    }
    const pad = Math.max(0, Math.min(U, (4 * U - (c.y1 - c.y0)) / 2));
    return { x0, x1, y0: Math.max(0, c.y0 - pad), y1: Math.min(BOARD_H, c.y1 + pad) };
  });
  for (const m of [U, U / 2]) {
    const ws = plan(m);
    if ((ws.reduce((a, w) => a + w.x1 - w.x0, 0) + SEP * (ws.length - 1)) * 1.7 <= FOCUS_AVAIL) return ws;
  }
  return plan(0);
}
// 窓は入れ子の svg で切る。札は 12px（1 字は 14px）÷ 倍率
export function focusSvg(layout, arr, tokens) {
  const wins = focusWindows(layout, arr, tokens);
  if (!wins.length) return "";
  const totalW = wins.reduce((a, w) => a + w.x1 - w.x0, 0) + SEP * (wins.length - 1);
  const maxH = Math.max(...wins.map((w) => w.y1 - w.y0));
  const s = Math.min(S_MAX, FOCUS_AVAIL / totalW);
  const keys = boardKeys(layout, arr);
  const font = (q) => fitFont(q, ([...q.label].length === 1 ? 14 : 12) / s);
  const sym = (q) => Math.min(q.h * 0.85, 15 / s);
  let ox = 0;
  const parts = wins.map((w, i) => {
    const ww = w.x1 - w.x0;
    const wh = w.y1 - w.y0;
    const at = `x="${ox.toFixed(1)}" y="${((maxH - wh) / 2).toFixed(1)}" width="${ww.toFixed(1)}" height="${wh.toFixed(1)}"`;
    const body = keys.filter((k) => k.x < w.x1 && k.x + k.w > w.x0 && k.y < w.y1 && k.y + k.h > w.y0).map((k) => keyHtml(k, font, sym)).join("");
    let out = `<svg ${at} viewBox="${w.x0.toFixed(1)} ${w.y0.toFixed(1)} ${ww.toFixed(1)} ${wh.toFixed(1)}">${body}</svg>${rectAt("kb-win", ox, (maxH - wh) / 2, ww, wh)}`;
    ox += ww;
    if (i < wins.length - 1) {
      out += `<path class="kb-sep" d="M${(ox + SEP / 2).toFixed(1)} 4V${(maxH - 4).toFixed(1)}"/>`;
      ox += SEP;
    }
    return out;
  });
  return `<svg class="kb kb-focus" viewBox="-1 -1 ${(totalW + 2).toFixed(1)} ${(maxH + 2).toFixed(1)}" width="${Math.round(totalW * S_MAX)}" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}

export function paintKeys(svg, { target = [], down = [], wrong = [] } = {}) {
  if (!svg) return;
  for (const g of svg.querySelectorAll(".kb-k")) {
    const t = g.getAttribute("data-t");
    const code = g.getAttribute("data-code") || "";
    const isTarget = isHit(target, t, code);
    g.classList.toggle("is-target", isTarget);
    g.classList.toggle("is-wrong", !isTarget && isHit(wrong, t, code));
    g.classList.toggle("is-down", down.includes(code));
  }
}
export const keyboardLabel = (layout, caps) => `${LAYOUT_LABEL[layout] ?? ""}の絵${caps ? `。押すキー: ${spokenCaps(caps, "and")}` : ""}`;

// == 前と後の絵（120×84）
const W = 120;
const H = 84;
const BODY = 12;
const SMALL = SCENE_MIN_FONT;
const widthOf = (s, size) => [...String(s ?? "")].reduce((a, ch) => a + (/[ -~]/.test(ch) ? size * 0.6 : size), 0);
const n1 = (v) => Number(v).toFixed(1).replace(/\.0$/, "");
const T = (x, y, s, size = SMALL, cls = "sc-ink", extra = "") =>
  `<text class="${cls}" x="${n1(x)}" y="${n1(y)}" font-size="${n1(Math.max(size, SMALL))}"${extra}>${esc(s)}</text>`;
const R = (x, y, w, h, cls, rx = 2, extra = "") => `<rect class="${cls}" x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${rx}"${extra}/>`;
const role = (r) => (r ? ` data-r="${r}"` : "");
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function textRun(x, y, str, size, { sel = null, bold = null, ins = null, car = null, prev = null } = {}) {
  const chars = [...String(str ?? "")];
  const pos = [x];
  for (const ch of chars) pos.push(pos[pos.length - 1] + widthOf(ch, size));
  const at = (i) => pos[Math.max(0, Math.min(i, chars.length))];
  const out = [];
  if (Array.isArray(sel)) out.push(R(at(sel[0]) - 0.6, y - size * 0.95, at(sel[1]) - at(sel[0]) + 1.2, size * 1.25, "sc-sel", 1, role(prev && !same(prev.sel, sel) ? "a" : "")));
  const cuts = new Set([0, chars.length]);
  for (const r of [sel, bold, ins]) if (Array.isArray(r)) r.forEach((v) => cuts.add(Math.max(0, Math.min(v, chars.length))));
  const marks = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i < marks.length - 1; i++) {
    const a = marks[i];
    const b = marks[i + 1];
    if (a === b) continue;
    const part = chars.slice(a, b).join("");
    if (!part.trim()) continue;
    const isBold = Array.isArray(bold) && a >= bold[0] && b <= bold[1];
    const isIns = Array.isArray(ins) && a >= ins[0] && b <= ins[1];
    const r = prev && isIns ? "a" : prev && isBold && !same(prev.bold, bold) ? "f" : "";
    out.push(T(at(a), y, part, size, isBold ? "sc-ink sc-bold" : "sc-ink", ` textLength="${n1(at(b) - at(a))}" lengthAdjust="spacingAndGlyphs"${role(r)}`));
  }
  if (Number.isInteger(car)) out.push(R(at(car) - 0.5, y - size * 0.95, 1.4, size * 1.2, "sc-caret", 0.4, role(prev && prev.car !== car ? "f" : "")));
  return out.join("");
}

function chip(xRight, y, label, cls, r = "") {
  const w = widthOf(label, SMALL) + 8;
  return `<g class="${cls}"${role(r)}>${R(xRight - w, y, w, 13, "sc-chip-bg", 2)}${T(xRight - w + 4, y + 10, label)}</g>`;
}

function panel(x, y, w, h, title, rows = [], r = "a") {
  const body = rows.map((row, i) => (row.on ? R(x + 5, y + 18 + i * 15, w - 10, 13, "sc-sel", 1.5) : "") + T(x + 8, y + 28 + i * 15, row.t)).join("");
  return `<g class="sc-panel"${role(r)}>${R(x, y, w, h, "sc-panel-bg", 3)}${T(x + 6, y + 13, title, 11, "sc-ink sc-bold")}${body}</g>`;
}

function drawDoc(st, prev) {
  const out = [R(2, 2, 116, 80, "sc-frame", 3), R(2, 2, 116, 16, "sc-bar", 3)];
  const title = st.title ?? "メモ";
  out.push(T(8, 14, title));
  if (st.dirty) out.push(`<circle class="sc-dot" cx="${n1(8 + widthOf(title, SMALL) + 5)}" cy="9.5" r="2.4"/>`);
  if (st.note) out.push(chip(115, 3.5, st.note, "sc-chip", prev && prev.note !== st.note ? "a" : ""));
  if (st.form !== undefined) {
    ["名前", "メール"].forEach((label, i) => {
      const y = 31 + i * 26;
      const on = st.form === i;
      out.push(T(8, y, label, SMALL, "sc-dim"), R(8, y + 4, 104, 14, on ? "sc-field sc-field--on" : "sc-field", 2, role(prev && on && prev.form !== i ? "a" : "")));
      if (on) out.push(R(12, y + 7, 1.4, 8, "sc-caret", 0.4));
    });
    return out.join("");
  }
  const lines = Array.isArray(st.t) ? st.t : st.t !== undefined ? [st.t] : [];
  lines.forEach((line, i) => {
    const y = 37 + i * 16;
    if (st.sel === "all") out.push(R(7.4, y - BODY * 0.95, widthOf(line, BODY) + 1.2, BODY * 1.25, "sc-sel", 1, role(prev && prev.sel !== "all" ? "a" : "")), T(8, y, line, BODY));
    else out.push(textRun(8, y, line, BODY, i === 0 ? { sel: st.sel, bold: st.bold, ins: st.ins, car: st.car, prev } : {}));
  });
  if (st.clip !== undefined) {
    out.push(R(8, 54, 11, 15, "sc-clip", 1.5), R(10.5, 52, 6, 4, "sc-clip-top", 1));
    if (st.clip) {
      const w = widthOf(st.clip, SMALL) + 8;
      out.push(`<g class="sc-paper"${role(prev && prev.clip !== st.clip ? "y" : "")}>${R(23, 55, w, 14, "sc-paper-bg", 2)}${T(27, 66, st.clip, SMALL, st.fmt ? "sc-ink sc-bold sc-fmt" : "sc-ink")}</g>`);
    } else out.push(T(24, 66, "空", SMALL, "sc-dim"));
  }
  const pr = prev && prev.panel !== st.panel ? "a" : "";
  if (st.panel === "print") {
    out.push(`<g class="sc-panel"${role(pr)}>${R(26, 22, 88, 56, "sc-panel-bg", 3)}${T(32, 36, "印刷", 11, "sc-ink sc-bold")}${R(32, 42, 52, 3, "sc-line", 1.5)}${R(32, 49, 40, 3, "sc-line", 1.5)}${R(80, 59, 28, 14, "sc-btn", 2)}${T(84, 70, "印刷", SMALL, "sc-btn-t")}</g>`);
  } else if (st.panel === "emoji") {
    let dots = "";
    for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) dots += `<circle class="${r === 0 && c === 0 ? "sc-face sc-face--on" : "sc-face"}" cx="${50 + c * 13}" cy="${40 + r * 12}" r="4.6"/>`;
    out.push(`<g class="sc-panel"${role(pr)}>${R(40, 28, 74, 50, "sc-panel-bg", 3)}${dots}</g>`);
  } else if (st.panel === "open") {
    out.push(panel(26, 22, 88, 56, "開く", [{ t: "報告書", on: true }, { t: "議事録" }], pr));
  } else if (st.panel === "clips") {
    out.push(panel(26, 22, 88, 56, "コピーした物", [{ t: "3階 会議室", on: true }, { t: MEET_TEXT }], pr));
  }
  return out.join("");
}
const MEET_TEXT = "会議は10時から";

const STAR = "M0 -4.2L1.25 -1.3L4.1 -1.25L1.95 0.65L2.6 3.6L0 2.1L-2.6 3.6L-1.95 0.65L-4.1 -1.25L-1.25 -1.3Z";
function drawWeb(st, prev) {
  const dark = !!st.dark;
  const out = [R(2, 2, 116, 80, dark ? "sc-frame sc-frame--dark" : "sc-frame", 3)];
  const tabs = st.tabs ?? [];
  const tw = Math.min(34, 112 / Math.max(1, tabs.length));
  const on = st.on === "n" ? 1 : st.on ?? 0;
  const prevOn = prev ? (prev.on === "n" ? 1 : prev.on ?? 0) : on;
  tabs.forEach((name, i) => {
    const isOn = on === i;
    const r = prev ? (!(prev.tabs ?? []).includes(name) ? "a" : isOn && prevOn !== i ? "f" : "") : "";
    out.push(`<g class="${isOn ? "sc-tab sc-tab--on" : "sc-tab"}"${role(r)}>${R(4 + i * tw, 4, tw - 1.5, 14, "sc-tab-bg", 2)}${T(4 + i * tw + (tw - 1.5) / 2, 14.5, name, SMALL, "sc-ink", ' text-anchor="middle"')}</g>`);
  });
  out.push(R(4, 21, 112, 13, dark ? "sc-addr sc-addr--dark" : "sc-addr", 6));
  const url = st.blank || dark ? "" : `news/${st.page ?? 1}`;
  if (st.urlSel && url) out.push(R(8.4, 22.5, widthOf(url, SMALL) + 3, 10, "sc-sel", 1, role(prev && !prev.urlSel ? "a" : "")));
  if (url) out.push(T(10, 31, url, SMALL, "sc-ink", role(prev && (prev.page ?? 1) !== (st.page ?? 1) ? "f" : "")));
  if (st.star !== undefined) out.push(`<path class="${st.star ? "sc-star sc-star--on" : "sc-star"}" d="${STAR}" transform="translate(107 27.5)"${role(prev && st.star && !prev.star ? "f" : "")}/>`);
  if (dark) {
    out.push(`<g class="sc-dark"${role(prev && !prev.dark ? "a" : "")}><circle cx="52" cy="50" r="5"/><circle cx="68" cy="50" r="5"/>${R(56, 49, 8, 2, "sc-dark-bar", 1)}${T(60, 70, "履歴を残さない", SMALL, "sc-darktext", ' text-anchor="middle"')}</g>`);
    return out.join("");
  }
  if (st.blank) {
    out.push(T(60, 62, "新しいタブ", SMALL, "sc-dim", ` text-anchor="middle"${role(prev && !prev.blank ? "a" : "")}`));
    return out.join("");
  }
  const z = st.zoom ?? 1;
  const size = 13 * z;
  const head = st.scroll ? `${st.scroll + 1} 画面目` : st.page ? `${st.page} ページ目` : "お知らせ";
  const headR = prev && (prev.page !== st.page || prev.scroll !== st.scroll) ? "f" : "";
  const zoomR = prev && (prev.zoom ?? 1) !== z ? "a" : "";
  const lines = st.scroll ? ["続きの話", "会議室は3階"] : ["会議は金曜", "会議室は3階"];
  const body = [T(8, 37 + size, head, size, "sc-ink sc-bold", role(headR))];
  let k = 0;
  lines.forEach((ln, i) => {
    const y = 37 + size + (i + 1) * size * 1.15;
    if (y > 80) return;
    if (st.find && ln.includes(st.find)) {
      k++;
      const a = ln.indexOf(st.find);
      const hitOn = st.hit === k;
      const x0 = 8 + widthOf(ln.slice(0, a), size);
      body.push(R(x0 - 0.6, y - size * 0.95, widthOf(st.find, size) + 1.2, size * 1.25, hitOn ? "sc-hit sc-hit--on" : "sc-hit", 1, role(prev && hitOn && prev.hit !== k ? "f" : "")));
    }
    body.push(T(8, y, ln, size));
  });
  out.push(`<g class="sc-page"${role(zoomR)}>${body.join("")}</g>`);
  if (st.pct) out.push(chip(115, 37, st.pct, "sc-chip", prev && prev.pct !== st.pct ? "a" : ""));
  if (st.find) out.push(`<g class="sc-panel"${role(prev && !prev.find ? "a" : "")}>${R(62, 37, 54, 15, "sc-panel-bg", 2)}${T(66, 48, st.find)}${T(92, 48, `${st.hit ?? 1}/2`, SMALL, "sc-dim")}</g>`);
  if (st.reload) out.push(`<g class="sc-reload"${role(prev && !prev.reload ? "a" : "")}><path class="sc-arc" d="M106 62a7 7 0 1 1 -2.1 -5"/><path class="sc-arrowhead" d="M104.6 52.2l0.6 5.4l-5.2 -0.9z"/></g>`);
  if (st.scroll !== undefined) out.push(R(110, 38, 5, 42, "sc-scroll-track", 2.5), R(110, 38 + st.scroll * 20, 5, 20, "sc-scroll", 2.5, role(prev && prev.scroll !== st.scroll ? "a" : "")));
  const pr = prev && prev.panel !== st.panel ? "a" : "";
  if (st.panel === "history") out.push(panel(36, 36, 80, 44, "履歴", [{ t: "天気" }, { t: "地図" }], pr));
  if (st.panel === "downloads") out.push(panel(30, 36, 86, 44, "ダウンロード", [{ t: "報告書" }, { t: "議事録" }], pr));
  return out.join("");
}

function windowAt(x, y, w, h, name, { front = false, hang = false, r = "" } = {}) {
  const lines = [0, 1, 2].map((i) => R(x + 5, y + 19 + i * 6, Math.max(6, w * (0.62 - i * 0.14)), 2.6, "sc-line", 1.3)).join("");
  const stuck = hang && front ? T(x + 6, y + h - 6, "応答なし", SMALL, "sc-dim") : "";
  return `<g class="${front ? "sc-win sc-win--front" : "sc-win"}"${role(r)}>${R(x, y, w, h, "sc-win-bg", 2)}${R(x, y, w, 14, "sc-bar", 2)}${T(x + 4, y + 11, name)}${hang && front ? "" : lines}${stuck}</g>`;
}
function drawDesk(st, prev) {
  const out = [R(2, 2, 116, 80, "sc-screen", 3), R(2, 68, 116, 14, "sc-taskbar", 0)];
  if (st.over === "lock") {
    out.push(`<g class="sc-lock"${role(prev ? "a" : "")}>${R(2, 2, 116, 80, "sc-lock-bg", 3)}<path class="sc-shackle" d="M54 40v-6a6 6 0 0 1 12 0v6"/>${R(50.5, 40, 19, 14, "sc-lock-body", 2)}${T(60, 68, "ロック中", SMALL, "sc-darktext", ' text-anchor="middle"')}</g>`);
    return out.join("");
  }
  if (st.icons) out.push(`<g class="sc-icons"${role(prev && !prev.icons ? "a" : "")}>${[0, 1, 2].map((i) => R(8, 8 + i * 18, 13, 13, "sc-icon", 2)).join("")}</g>`);
  if (st.dock) out.push(`<g class="sc-dock"${role(prev && prev.dock !== st.dock ? "y" : "")}>${R(6, 69.5, 30, 11, "sc-dock-bg", 2)}${T(11, 78.6, st.dock)}</g>`);
  const wins = st.wins ?? [];
  if (st.tile) {
    out.push(`<g${role(prev && !prev.tile ? "a" : "")}>${wins.map((name, i) => windowAt(4 + i * 38.5, 16, 35, 40, name, { front: true })).join("")}</g>`);
  } else {
    for (let i = wins.length - 1; i >= 0; i--) {
      const front = i === 0;
      const r = prev && front && (st.fresh || (prev.wins ?? [])[0] !== wins[0]) ? "a" : "";
      out.push(windowAt(12 + i * 14, 8 + i * 9, 72, 40, wins[i], { front, hang: st.hang, r }));
    }
  }
  const or = prev && prev.over !== st.over ? "a" : "";
  if (st.over === "switch") {
    const thumbs = wins.slice(0, 2).map((name, i) => `${R(20 + i * 42, 24, 38, 20, i === 0 ? "sc-thumb sc-thumb--on" : "sc-thumb", 2)}${T(39 + i * 42, 56, name, SMALL, "sc-ink", ' text-anchor="middle"')}`).join("");
    out.push(`<g class="sc-panel"${role(or)}>${R(14, 18, 92, 44, "sc-panel-bg", 3)}${thumbs}</g>`);
  }
  if (st.over === "shotArea" || st.over === "shotFull") {
    const box = st.over === "shotArea" ? R(30, 12, 52, 32, "sc-shot", 0) : R(3.5, 3.5, 113, 63, "sc-shot", 0);
    out.push(`<g${role(or)}>${box}</g>`, `<g class="sc-photo"${role(or ? "y" : "")}>${R(82, 46, 32, 18, "sc-photo-bg", 2)}${T(88, 59, "写真")}</g>`);
  }
  if (st.over === "search") out.push(`<g class="sc-panel"${role(or)}>${R(14, 24, 92, 18, "sc-panel-bg", 9)}<circle class="sc-glass" cx="25" cy="32.5" r="3.4"/><path class="sc-glass" d="M27.4 35l3 3"/>${T(36, 37, "名前で探す", SMALL, "sc-dim")}</g>`);
  if (st.over === "task") {
    out.push(`<g class="sc-panel"${role(or)}>${R(8, 8, 104, 56, "sc-panel-bg", 3)}${T(14, 21, "アプリ", SMALL, "sc-ink sc-bold")}${R(12, 25, 96, 14, "sc-sel", 1.5)}${T(16, 35.5, "文書（応答なし）")}${T(16, 52, "地図")}${R(82, 45, 24, 14, "sc-btn", 2)}${T(84, 55.5, "終了", SMALL, "sc-btn-t")}</g>`);
  }
  return out.join("");
}

const DRAW = { doc: drawDoc, web: drawWeb, desk: drawDesk };
function svgOf(kind, st, prev, cls) {
  let inner = (DRAW[kind] ?? drawDoc)(st ?? {}, prev);
  if (prev && !inner.includes("data-r=")) inner = `<g data-r="f">${inner}</g>`;
  return `<svg class="sc-svg ${cls}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">${inner}</svg>`;
}

export function scenePairHtml(item, layout, nth = null) {
  const sc = item?.scene ?? { k: "doc", a: {}, b: {} };
  const after0 = layout === "cmd" && sc.bCmd ? sc.bCmd : sc.b;
  const fill = (v) => (nth && typeof v === "string" ? v.replace(/(左から )n( 番目)/, `$1${nth}$2`) : v);
  const after = nth && after0?.on === "n" ? { ...after0, on: nth - 1 } : after0;
  const say = (item?.say ?? ["", ""]).map(fill);
  return `<figure class="sc-pair" aria-label="前: ${esc(say[0])}。後: ${esc(say[1])}。">` +
    `<div class="sc-cell sc-cell--before"><span class="sc-cap" aria-hidden="true">前</span>${svgOf(sc.k, sc.a, null, "sc-svg--before")}</div>` +
    `<svg class="sc-arrow" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 6H9.5M6.5 3L9.5 6L6.5 9"/></svg>` +
    `<div class="sc-cell sc-cell--after"><span class="sc-cap" aria-hidden="true">後</span>${svgOf(sc.k, after, sc.a ?? {}, "sc-svg--after")}</div></figure>`;
}
