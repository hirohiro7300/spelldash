// ===== ショートカットキーの絵（Batch 92。docs/SPEC_SHORTCUTS.md §6）: キーの札・キーボードの絵・前と後の絵 =====
// どれも文字列の SVG を組む（外のファイルを読まない。img-src に触れない）。字は esc して出す（scripts/test-text-safe.mjs の見張りの対象）。
// 色は css/shortcuts.css のクラス（css/tokens.css の変数）だけで決める。記号のキー（⌘ ⌥ ⌃ ⇧ ⊞ と矢印）は字でなく線で描く。
// 前と後の絵: 3 つの型（doc 文字の編集・web ブラウザ・desk パソコンの画面）に表の状態を渡して描く。字は 10 単位以上（390 の幅で 11px 以上）・「…」で切らない。
// 後の絵の中で変わった物に役（data-r）を付ける: a 現れる・y 飛んでくる・f 光る。動きは css の .is-play（減らした動きの設定では動かさない）。

import { esc } from "./html.js";
import { tokensOfCaps as capsTokens, spokenCap, spokenCaps, LAYOUT_LABEL } from "./shortcutsCore.js";

export const tokensOfCaps = capsTokens;
export const SCENE_MIN_FONT = 10; // 前と後の絵の字の最小（viewBox 120 単位の幅。390 の幅で 1 枚 150px 前後なので 12px 前後）

// ---- 記号（10×10 の箱。線で描く） ----
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

// HTML のキーの札（<kbd>）。記号は小さな線の SVG と読み上げの名前
export function capHtml(cap) {
  const d = SYM[cap];
  if (!d) return `<kbd class="kc">${esc(cap)}</kbd>`;
  return `<kbd class="kc kc--sym"><svg viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="${esc(d)}"/></svg><span class="sr-only">${esc(spokenCap(cap))}</span></kbd>`;
}
export function capsHtml(caps) {
  return caps.map(capHtml).join('<span class="kc-plus" aria-hidden="true">+</span>');
}
// 変種（「/」でつないだ組）
export function variantsHtml(variants) {
  return variants.map((caps) => `<span class="kc-set">${capsHtml(caps)}</span>`).join('<span class="kc-or">/</span>');
}

// ===== キーボードの絵 =====
const U = 20; // キー 1 つの幅（viewBox の単位）
// 段の並び: [札, code, 判定の字, 幅]
function rowsOf(layout, arr) {
  const L = (s) => [...s].map((c) => [c.toUpperCase(), "Key" + c.toUpperCase(), c, 1]);
  const D = (s) => [...s].map((c) => [c, "Digit" + c, c, 1]);
  const jis = arr === "jis";
  const cmd = layout === "cmd";
  const gap = ["", "", "", 0.25];
  const fn = [["Esc", "Escape", "Escape", 1], gap, ...[1, 2, 3, 4].map((i) => ["F" + i, "F" + i, "F" + i, 1]), gap, ...[5, 6, 7, 8].map((i) => ["F" + i, "F" + i, "F" + i, 1]), gap,
    ...[9, 10, 11, 12].map((i) => ["F" + i, "F" + i, "F" + i, 1])];
  if (!cmd) fn.push(["PrtScn", "PrintScreen", "PrintScreen", 1.25]);
  const bs = cmd ? ["delete", "Backspace", "Backspace"] : ["Backspace", "Backspace", "Backspace"];
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
      ? [["Ctrl", "ControlLeft", "ctrl", 1.25], ["⊞", "MetaLeft", "meta", 1.25], ["Alt", "AltLeft", "alt", 1.25], ["無変換", "NonConvert", "NonConvert", 1], ["Space", "Space", "Space", 3.5],
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

// キーボードの絵（<svg>）。答える前は光らせない（光らせるのは paintKeys）。読み上げの名前は「Ctrl のキーボードの絵」
export function keyboardSvg(layout, arr = "jis") {
  const { fn, rows } = rowsOf(layout, arr);
  const side = layout === "ctrl";
  const W = (side ? 16.4 : 15) * U;
  const fh = 0.72 * U;
  const H = fh + 0.2 * U + 5 * U;
  const parts = [];
  const key = (x, y, w, h, [label, code, t]) => {
    const cx = x + (w * U) / 2;
    const cy = y + h / 2;
    const d = SYM[label];
    let face = "";
    if (d) {
      const s = Math.min(h * 0.5, 9);
      face = `<path class="kb-sym" d="${esc(d)}" transform="translate(${(cx - s / 2).toFixed(1)} ${(cy - s / 2).toFixed(1)}) scale(${(s / 10).toFixed(2)})"/>`;
    } else if (label) {
      const fs = label.length > 4 ? 5.6 : label.length > 2 ? 6.4 : label.length === 1 ? 8.6 : 7.4;
      face = `<text x="${cx.toFixed(1)}" y="${(cy + fs * 0.35).toFixed(1)}" font-size="${fs}">${esc(label)}</text>`;
    }
    parts.push(`<g class="kb-k" data-code="${esc(code)}" data-t="${esc(t)}"><rect x="${(x + 1).toFixed(1)}" y="${(y + 1).toFixed(1)}" width="${(w * U - 2).toFixed(1)}" height="${(h - 2).toFixed(1)}" rx="2.6"/>${face}</g>`);
  };
  let x = 0;
  for (const k of fn) {
    if (k[1]) key(x, 0, k[3], fh, k);
    x += k[3] * U;
  }
  rows.forEach((row, i) => {
    let xx = 0;
    const y = fh + 0.2 * U + i * U;
    for (const k of row) {
      key(xx, y, k[3], U, k);
      xx += k[3] * U;
    }
    if (i === 4) {
      const ax = 12 * U;
      key(ax + U, y, 1, U / 2, ["↑", "ArrowUp", "ArrowUp"]);
      key(ax, y + U / 2, 1, U / 2, ["←", "ArrowLeft", "ArrowLeft"]);
      key(ax + U, y + U / 2, 1, U / 2, ["↓", "ArrowDown", "ArrowDown"]);
      key(ax + 2 * U, y + U / 2, 1, U / 2, ["→", "ArrowRight", "ArrowRight"]);
    }
  });
  if (side) {
    const sx = 15.4 * U;
    key(sx, 0, 1, fh, ["Ins", "Insert", "Insert"]);
    [["Del", "Delete"], ["Home", "Home"], ["End", "End"], ["PgUp", "PageUp"], ["PgDn", "PageDown"]].forEach(([l, c], i) => key(sx, fh + 0.2 * U + i * U, 1, U, [l, c, c]));
  }
  const label = `${LAYOUT_LABEL[layout] ?? ""}の絵`;
  return `<svg class="kb" viewBox="-2 -2 ${(W + 4).toFixed(0)} ${(H + 4).toFixed(0)}" role="img" aria-label="${esc(label)}" focusable="false">${parts.join("")}</svg>`;
}

// 押すキー（金）・押しているキー（沈む）・押し違えたキー（朱の点線）を絵に写す。修飾は左のキーだけ光らせる
const MODS = new Set(["ctrl", "alt", "shift", "meta"]);
export function paintKeys(svg, { target = [], down = [], wrong = [] } = {}) {
  if (!svg) return;
  for (const g of svg.querySelectorAll(".kb-k")) {
    const t = g.getAttribute("data-t");
    const code = g.getAttribute("data-code") || "";
    const hit = (list) => list.includes(t) && !(MODS.has(t) && /Right$/.test(code));
    const isTarget = hit(target);
    g.classList.toggle("is-target", isTarget);
    g.classList.toggle("is-wrong", !isTarget && hit(wrong));
    g.classList.toggle("is-down", down.includes(code));
  }
}
// 読み上げの名前（答えた後）: 「Ctrl のキーボードの絵。押すキー: コントロール と C」
export const keyboardLabel = (layout, caps) => `${LAYOUT_LABEL[layout] ?? ""}の絵${caps ? `。押すキー: ${spokenCaps(caps, "and")}` : ""}`;

// ===== 前と後の絵（120×84） =====
const W = 120;
const H = 84;
const BODY = 12; // 文字の編集の本文の字
const SMALL = SCENE_MIN_FONT;
const widthOf = (s, size) => [...String(s ?? "")].reduce((a, ch) => a + (/[ -~]/.test(ch) ? size * 0.6 : size), 0);
const n1 = (v) => Number(v).toFixed(1).replace(/\.0$/, "");
const T = (x, y, s, size = SMALL, cls = "sc-ink", extra = "") =>
  `<text class="${cls}" x="${n1(x)}" y="${n1(y)}" font-size="${n1(Math.max(size, SMALL))}"${extra}>${esc(s)}</text>`;
const R = (x, y, w, h, cls, rx = 2, extra = "") => `<rect class="${cls}" x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${rx}"${extra}/>`;
const role = (r) => (r ? ` data-r="${r}"` : "");
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// 1 行の字（選んだ範囲・太字・現れた範囲・カーソル）。範囲は字の番号 [a, b)
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
  if (st.scroll !== undefined) out.push(R(110, 38, 5, 42, "sc-track", 2.5), R(110, 38 + st.scroll * 20, 5, 20, "sc-thumb", 2.5, role(prev && prev.scroll !== st.scroll ? "a" : "")));
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
  // 後の絵で変わった物が描けない（消えただけ）ときは、絵の中身を一度光らせる
  if (prev && !inner.includes("data-r=")) inner = `<g data-r="f">${inner}</g>`;
  return `<svg class="sc-svg ${cls}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">${inner}</svg>`;
}

// 前と後の絵（<figure>）。読み上げは figure の名前 1 つ（「前: …。後: …。」）。n 番目のタブは数を差し込む
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
