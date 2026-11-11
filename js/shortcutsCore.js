// ショートカットキーの純な部分（Batch 92。docs/SPEC_SHORTCUTS.md）。DOM なし

import { nextLearnState, learnDayOf, LEARN_NEW, LEARN_UNSURE, LEARN_LEARNED } from "./learnState.js";

export const PROGRESS_KEY = "spelldash_shortcuts"; // 人ごと
export const DEVICE_KEY = "spelldash_shortcut_device"; // 端末ごと
export const LAYOUTS = Object.freeze(["ctrl", "cmd"]);
export const LAYOUT_LABEL = Object.freeze({ ctrl: "Ctrl のキーボード", cmd: "⌘ のキーボード" });
export const GROUP_LABEL = Object.freeze({ pc: "パソコン共通", br: "ブラウザ" });
export const UNCLEAR = "?"; // 判定しない
export const MISS_MAX = 40;
export const MISS_WINDOW_MS = 1500;
export const ADVANCE_WAIT_MS = 300;
export const RELOAD_WINDOW_MS = 120000;
const MOD_ORDER = ["ctrl", "alt", "shift", "meta"];
const MOD_KEY_NAMES = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS", "Hyper", "Super", "Fn", "FnLock"]);

// == キーの読み方（仕様 §4）
const CODE_SYMBOL = { BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\" };

export function mainKey(e) {
  const k = typeof e?.key === "string" ? e.key : "";
  const code = typeof e?.code === "string" ? e.code : "";
  const opaque = !k || k === "Process" || k === "Unidentified" || k === "Dead";
  if (/^[a-z]$/i.test(k)) return k.toLowerCase();
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (code === "Minus" || code === "NumpadSubtract") return "minus";
  if (code === "NumpadAdd") return "plus";
  if (code === "Semicolon" && (e.ctrlKey || e.metaKey) && (k === ";" || k === "+")) return "plus";
  if (code === "Equal") return k === "=" || k === "+" ? "plus" : opaque ? UNCLEAR : k;
  if (!code && (k === "+" || k === "=")) return "plus";
  if (!code && (k === "-" || k === "_")) return "minus";
  if (k === " " || k === "Spacebar" || code === "Space") return "Space";
  if (/^F([1-9]|1[0-2])$/.test(k)) return k;
  if (k === "Esc") return "Escape";
  if (!opaque && k.length === 1 && k.charCodeAt(0) > 0x7e) return CODE_SYMBOL[code] ?? UNCLEAR;
  if (!opaque) return k;
  return UNCLEAR;
}

// AltGr は Ctrl のキーボードだけ（⌘ では AltGraph の旗を見ない）
export function readCombo(e, layout) {
  const c = { ctrl: !!e?.ctrlKey, alt: !!e?.altKey, shift: !!e?.shiftKey, meta: !!e?.metaKey, key: mainKey(e) };
  const ag = typeof e?.getModifierState === "function" && !!e.getModifierState("AltGraph");
  if (layout === "ctrl" && ag && c.ctrl && c.alt && !c.meta) {
    c.ctrl = false;
    c.alt = false;
    c.altGraph = true;
  }
  return c;
}

export function comboString(c) {
  return [...(c?.altGraph ? ["altgr"] : []), ...MOD_ORDER.filter((m) => c?.[m]), c?.key ?? ""].join("+");
}

export function parseAccept(s) {
  const parts = String(s).split("+");
  const key = parts.pop();
  const mods = new Set();
  const optional = new Set();
  for (const p of parts) (p.startsWith("?") ? optional : mods).add(p.replace(/^\?/, ""));
  return { mods, optional, key };
}

export function matchesAccept(accept, combo, nth = null) {
  if (!combo || combo.altGraph) return false;
  const a = parseAccept(accept);
  const key = a.key === "#" ? String(nth) : a.key;
  if (combo.key !== key) return false;
  return MOD_ORDER.every((m) => a.optional.has(m) || !!combo[m] === a.mods.has(m));
}

const answersOf = (k) => [...(k?.accept ?? []), ...(k?.also ?? [])];

export function judge(item, layout, combo, nth = null) {
  const k = item?.keys?.[layout];
  if (!k || !combo) return "wrong";
  if (combo.key === UNCLEAR) return "unclear";
  if (answersOf(k).some((a) => matchesAccept(a, combo, nth))) return "ok";
  if ((k.near ?? []).some((a) => matchesAccept(a, combo, nth))) return "near";
  return "wrong";
}

// × の後: ほかの項目の組なら { own }、他方のキーボードの組なら { suggest }（仕様 §7）
export function afterWrong(item, layout, combo, nth, all = []) {
  if (judge(item, layout, combo, nth) !== "wrong") return null;
  const sig = sigOfCaps(capsOfCombo(combo, layout), layout);
  const others = all.filter((y) => y.id !== item.id && y.keys?.[layout]);
  const own = others.find((y) => answersOf(y.keys[layout]).some((a) => matchesAccept(a, combo, nth)))
    ?? others.find((y) => [...y.keys[layout].show, ...(y.keys[layout].alt ?? [])].some((caps) => !caps.includes("1〜8") && sigOfCaps(caps, layout) === sig));
  if (own) return { own };
  const other = layout === "ctrl" ? "cmd" : "ctrl";
  if (answersOf(item.keys?.[other]).some((a) => matchesAccept(a, combo, nth))) return { suggest: other };
  return null;
}

export function ownText(item) {
  const s = String(item?.short ?? "");
  return `それは${s}${/[うくぐすつぬぶむる]$/.test(s) ? "" : "の"}組。`;
}

export function shouldCancel(e) {
  const k = e?.key || "";
  if (k === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) return false;
  if (k === "Escape" || k === "Esc") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (/^F([1-9]|1[0-2])$/.test(k)) return true;
  return [" ", "Spacebar", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Insert", "Backspace"].includes(k);
}

export function isImeEvent(e) {
  const composing = !!e?.isComposing || e?.keyCode === 229 || e?.key === "Process";
  return composing && !(e.ctrlKey || e.metaKey || e.altKey);
}

export function isPhysicalKey(e) {
  return !!e?.isTrusted && typeof e.code === "string" && /^(Key[A-Z]|Digit\d|Numpad|Arrow|Shift|Control|Alt|Meta|Space|Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|Page|F\d|Minus|Equal|Bracket|Semicolon|Quote|Backquote|Backslash|Comma|Period|Slash|Intl|CapsLock)/.test(e.code);
}

export function isModifierEvent(e) {
  return MOD_KEY_NAMES.has(e?.key) || /^(Control|Meta|Alt|Shift|OS)(Left|Right)$/.test(e?.code || "");
}

// == 答え方（仕様 §3）。env = { keyboard, miss }
export function modeOf(item, layout, env = {}) {
  const k = item?.keys?.[layout];
  if (!k) return null;
  if (!env.keyboard || k.how === "choice") return "choice";
  const miss = env.miss?.[layout] ?? [];
  if ((k.accept ?? []).some((a) => miss.includes(a))) return "choice";
  return k.how;
}

// == 届かなかった組の見張り（仕様 §6。1 回目は toChoice、2 回目は persist）
export function createMissWatcher() {
  let held = null;
  let at = 0;
  const seen = new Map();
  const disarm = () => {
    held = null;
    at = 0;
  };
  return {
    keydown(e, t) {
      if (!isModifierEvent(e)) return disarm();
      const flags = { ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey };
      if (!held) at = t;
      held = flags;
    },
    keyup(e) {
      if (isModifierEvent(e)) disarm();
    },
    lost(t, item, layout) {
      const h = held;
      const since = at;
      disarm();
      if (!h || t - since > MISS_WINDOW_MS) return null;
      const k = item?.keys?.[layout];
      if (!k || k.how === "choice") return null;
      const combos = (k.accept ?? []).filter((a) => {
        const p = parseAccept(a);
        return MOD_ORDER.every((m) => (p.optional.has(m) ? true : p.mods.has(m) === h[m])) && MOD_ORDER.some((m) => h[m]);
      });
      if (!combos.length) return null;
      const sig = `${layout}:${combos.join("|")}`;
      const n = (seen.get(sig) ?? 0) + 1;
      seen.set(sig, n);
      return { toChoice: true, persist: n >= 2, combos };
    },
    reset: disarm
  };
}

// == 次へ（仕様 §8）。R = { answeredAt, released }
export function shouldAdvance(e, R, now) {
  if (!R || e?.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return false;
  return !!R.released || now - R.answeredAt >= ADVANCE_WAIT_MS;
}

// == 戻る・進む・再読み込みの守り（仕様 §9）
export const guardState = (id) => ({ sdGuard: String(id) });
export const isGuardState = (s) => !!s && typeof s === "object" && typeof s.sdGuard === "string" && s.sdGuard !== "";
export function onGuardPop(state, R) {
  if (R?.ignore > 0) return "self";
  if (isGuardState(state)) return R?.waiting === "br.forward" ? "count-back" : "back";
  return R?.waiting === "br.back" && R?.pushed ? "count" : "none";
}
export function withoutGuard(state, key = "sdGuard") {
  if (!state || typeof state !== "object") return null;
  const rest = { ...state };
  delete rest[key];
  return Object.keys(rest).length ? rest : null;
}
export const reloadMark = (id, layout, at, first = true) => ({ id, layout, at, first: first !== false });
export function reloadCounted(state, navType, now) {
  const m = state?.sdReload;
  if (navType !== "reload" || !m || m.id !== "br.reload" || !LAYOUTS.includes(m.layout) || !Number.isFinite(m.at)) return null;
  return now - m.at >= 0 && now - m.at <= RELOAD_WINDOW_MS ? { id: m.id, layout: m.layout, first: m.first !== false } : null;
}

// == 画面の位置（仕様 §2.2）
export function fitDelta(top, bottom, viewTop, viewBottom) {
  if (top < viewTop || bottom - top > viewBottom - viewTop) return top - viewTop;
  return bottom > viewBottom ? bottom - viewBottom : 0;
}

// == 端末の設定 { layout, arr, miss }（仕様 §13）
const missList = (v) => (Array.isArray(v) ? [...new Set(v.filter((s) => typeof s === "string" && s.length > 0 && s.length < 64))].slice(-MISS_MAX) : []);
export function readDevice(storage) {
  let d = null;
  try {
    d = JSON.parse(storage.getItem(DEVICE_KEY) ?? "null");
  } catch {
    d = null;
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) d = {};
  return { layout: LAYOUTS.includes(d.layout) ? d.layout : null, arr: d.arr === "us" ? "us" : "jis", miss: { ctrl: missList(d.miss?.ctrl), cmd: missList(d.miss?.cmd) } };
}
export function writeDevice(storage, d) {
  const o = { ...(LAYOUTS.includes(d?.layout) ? { layout: d.layout } : {}), arr: d?.arr === "us" ? "us" : "jis", miss: { ctrl: missList(d?.miss?.ctrl), cmd: missList(d?.miss?.cmd) } };
  try {
    storage.setItem(DEVICE_KEY, JSON.stringify(o));
    return true;
  } catch {
    return false;
  }
}
export function addMiss(d, layout, combos) {
  const now = (d?.miss?.[layout] ?? []).filter((s) => !combos.includes(s));
  return { ...d, miss: { ...d.miss, [layout]: missList([...now, ...combos]) } };
}
export const clearMiss = (d) => ({ ...d, miss: { ctrl: [], cmd: [] } });
export function updateDevice(storage, change) {
  const device = change(readDevice(storage));
  return { device, saved: writeDevice(storage, device) };
}

// == 3 状態（仕様 §13）
export const dayOf = (ms) => learnDayOf(ms);
export const keyOf = (id, layout) => `${id}@${layout}`;
export const emptyProgress = () => ({ v: 1, it: {} });
export function readProgress(storage) {
  try {
    const p = JSON.parse(storage.getItem(PROGRESS_KEY) ?? "null");
    if (p && typeof p === "object" && !Array.isArray(p) && p.v === 1 && p.it && typeof p.it === "object" && !Array.isArray(p.it)) return p;
  } catch {
    /* 読めない値は空として読む（上書きは答えたときだけ） */
  }
  return emptyProgress();
}
export function writeProgress(storage, p) {
  try {
    storage.setItem(PROGRESS_KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}
// 読み直して書く（ほかのタブ）
export function recordAnswer(storage, id, layout, clean, nowMs, how = "p") {
  const progress = applyAnswer(readProgress(storage), id, layout, clean, nowMs, how);
  return { progress, saved: writeProgress(storage, progress) };
}
export function stateOf(p, id, layout) {
  const r = p?.it?.[keyOf(id, layout)];
  return r && (r.s === LEARN_UNSURE || r.s === LEARN_LEARNED) ? r.s : LEARN_NEW;
}
export function applyAnswer(p, id, layout, clean, nowMs, how = "p") {
  const k = keyOf(id, layout);
  const prev = p.it[k] ?? {};
  const next = nextLearnState({ state: stateOf(p, id, layout), day: Number.isInteger(prev.d) ? prev.d : null }, !!clean, learnDayOf(nowMs));
  const rec = {};
  if (next.state) rec.s = next.state;
  if (next.state === LEARN_UNSURE && Number.isInteger(next.day)) rec.d = next.day;
  rec.at = nowMs;
  rec.how = how === "c" ? "c" : "p";
  return { ...p, it: { ...p.it, [k]: rec } };
}
export function countStates(p, items, layout, group = "") {
  const out = { total: 0, new: 0, unsure: 0, learned: 0 };
  for (const x of items) {
    if (!x.keys?.[layout] || (group && x.g !== group)) continue;
    out.total++;
    out[["new", "unsure", "learned"][stateOf(p, x.id, layout)]]++;
  }
  return out;
}

// == 回（仕様 §10）
export function buildRound(items, layout, p, { size = 10, today = learnDayOf(Date.now()), group = "", only = null } = {}) {
  const pool = items.filter((x) => x.keys?.[layout] && (!group || x.g === group) && (!only || only.includes(x.id)));
  const rec = (x) => p?.it?.[keyOf(x.id, layout)] ?? {};
  const at = (x) => (Number.isFinite(rec(x).at) ? rec(x).at : 0);
  const byAt = (a, b) => at(a) - at(b);
  const st = (x) => stateOf(p, x.id, layout);
  const counted = (x) => Number.isInteger(rec(x).d) && rec(x).d >= today;
  const due = pool.filter((x) => st(x) === LEARN_UNSURE && !counted(x)).sort(byAt);
  const fresh = pool.filter((x) => st(x) === LEARN_NEW).sort((a, b) => (a.p === b.p ? 0 : a.p < b.p ? -1 : 1));
  const learned = pool.filter((x) => st(x) === LEARN_LEARNED).sort(byAt);
  const later = pool.filter((x) => st(x) === LEARN_UNSURE && counted(x)).sort(byAt);
  return [...due, ...fresh, ...learned, ...later].slice(0, size);
}
export function newRound(queue, progress) {
  return { queue: [...queue], i: 0, progress, firsts: {}, tries: {} };
}
// 最初の答えだけ記録する。× の組は 3 問後に（2 回まで）
export function roundAnswer(st, { item, layout, result, how = "p", nowMs }) {
  const first = !Object.prototype.hasOwnProperty.call(st.firsts, item.id);
  const ok = result === "ok";
  const out = { ...st, queue: [...st.queue], firsts: { ...st.firsts }, tries: { ...st.tries } };
  if (first) {
    out.firsts[item.id] = ok;
    out.progress = applyAnswer(st.progress, item.id, layout, ok, nowMs, how);
  }
  if (!ok) {
    out.tries[item.id] = (out.tries[item.id] ?? 0) + 1;
    if (out.tries[item.id] <= 2) out.queue.splice(Math.min(st.i + 4, out.queue.length), 0, item);
  }
  return { st: out, recorded: first };
}

// == 見せる字・選択肢・読み上げ
const CAP_TOKEN = { Ctrl: "ctrl", "⌃": "ctrl", Alt: "alt", "⌥": "alt", Shift: "shift", "⇧": "shift", "⌘": "meta", "⊞": "meta", Fn: "fn",
  "←": "ArrowLeft", "→": "ArrowRight", "↑": "ArrowUp", "↓": "ArrowDown", Esc: "Escape", PrtScn: "PrintScreen", PgDn: "PageDown", PgUp: "PageUp", "+": "plus", "-": "minus" };
const MOD_TOKENS = ["fn", "ctrl", "alt", "shift", "meta"];
export function tokenOfCap(cap, layout) {
  if (cap === "Delete") return layout === "cmd" ? "Backspace" : "Delete";
  if (CAP_TOKEN[cap]) return CAP_TOKEN[cap];
  return /^[A-Z]$/.test(cap) ? cap.toLowerCase() : cap;
}
export const tokensOfCaps = (caps, layout) => caps.map((c) => tokenOfCap(c, layout));
export function sigOfCaps(caps, layout) {
  const t = tokensOfCaps(caps, layout);
  const mods = MOD_TOKENS.filter((m) => t.includes(m));
  return [...mods, ...t.filter((x) => !MOD_TOKENS.includes(x))].join("+");
}
export function capsOf(item, layout, nth = null) {
  const k = item?.keys?.[layout];
  if (!k) return [];
  return k.show.map((caps) => caps.map((c) => (c === "1〜8" && nth ? String(nth) : c)));
}
const KEY_LABEL = { plus: "+", minus: "-", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", PageDown: "PgDn", PageUp: "PgUp", PrintScreen: "PrtScn" };
export function capsOfCombo(c, layout) {
  const cmd = layout === "cmd";
  const mods = cmd
    ? [c.ctrl && "⌃", c.alt && "⌥", c.shift && "⇧", c.meta && "⌘"]
    : [c.meta && "⊞", c.ctrl && "Ctrl", c.altGraph && "AltGr", c.alt && "Alt", c.shift && "Shift"];
  let key = KEY_LABEL[c.key] ?? (/^[a-z]$/.test(c.key) ? c.key.toUpperCase() : c.key);
  if (cmd && c.key === "Backspace") key = "Delete";
  if (!key || key === UNCLEAR) key = "？";
  return [...mods.filter(Boolean), key];
}
export const textCaps = (caps) => caps.join(" + ");
const HOLD_NOTE = "押すと本当に動くので、練習では押さずに選ぶ。";
const WHY_NOTE = { browser: HOLD_NOTE, os: HOLD_NOTE, screen: "Tab と Esc はこの画面で使うので、選んで答える。" };
export function notesOf(item, layout) {
  const k = item?.keys?.[layout];
  return k ? [k.note ?? "", WHY_NOTE[k.why] ?? ""].filter(Boolean) : [];
}

const SPOKEN = { "⌘": "コマンド", "⌥": "オプション", "⌃": "コントロール", "⇧": "シフト", "⊞": "ロゴのキー", Ctrl: "コントロール", Shift: "シフト", Alt: "オルト", AltGr: "オルトグラフ",
  "←": "左矢印", "→": "右矢印", "↑": "上矢印", "↓": "下矢印", Esc: "エスケープ", "+": "プラス", "-": "マイナス", "[": "左角かっこ", "]": "右角かっこ", ".": "ピリオド", ";": "セミコロン",
  Space: "スペース", PrtScn: "プリントスクリーン", Fn: "ファンクション", Tab: "タブ", Home: "ホーム", End: "エンド", Delete: "デリート", Backspace: "バックスペース", Insert: "インサート",
  PgDn: "ページダウン", PgUp: "ページアップ" };
export const spokenCap = (c) => SPOKEN[c] ?? c;
export function spokenCaps(caps, mode = "and") {
  const names = caps.map(spokenCap);
  if (mode !== "hold" || names.length < 2) return names.join(" と ");
  return `${names.slice(0, -1).join(" と ")} を押したまま ${names[names.length - 1]}`;
}

export function buildChoices(item, layout, all, rng = Math.random, nth = null) {
  const k = item.keys[layout];
  const variants = capsOf(item, layout, nth);
  const right = { sig: sigOfCaps(variants[0], layout), caps: variants[0], correct: true, id: item.id };
  const taken = new Set([...variants, ...(k.alt ?? [])].map((caps) => sigOfCaps(caps, layout)));
  for (const a of [...(k.accept ?? []), ...(k.also ?? []), ...(k.near ?? [])]) {
    const p = parseAccept(a);
    const key = p.key === "#" ? String(nth) : p.key;
    const base = Object.fromEntries(MOD_ORDER.map((m) => [m, p.mods.has(m)]));
    taken.add(comboString({ ...base, key }));
    for (const m of p.optional) taken.add(comboString({ ...base, [m]: true, key }));
  }
  const mine = new Set(tokensOfCaps(variants[0], layout).filter((t) => MOD_TOKENS.includes(t)));
  const pool = all
    .filter((x) => x.id !== item.id && x.keys?.[layout] && !x.keys[layout].show[0].includes("1〜8"))
    .map((x) => {
      const caps = x.keys[layout].show[0];
      const mods = tokensOfCaps(caps, layout).filter((t) => MOD_TOKENS.includes(t));
      const same = mods.length === mine.size && mods.every((m) => mine.has(m));
      return { x, caps, sig: sigOfCaps(caps, layout), s: (same ? 2 : 0) + (x.g === item.g ? 1 : 0) + rng() * 1.5 };
    })
    .sort((a, b) => b.s - a.s);
  const picks = [];
  for (const c of pool) {
    if (taken.has(c.sig)) continue;
    taken.add(c.sig);
    picks.push({ sig: c.sig, caps: c.caps, correct: false, id: c.x.id });
    if (picks.length === 3) break;
  }
  const out = [right, ...picks];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
