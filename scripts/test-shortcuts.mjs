// ショートカットキーの練習（Batch 92。docs/SPEC_SHORTCUTS.md）の単体: 表（js/shortcutsData.js）・判定と答え方と回と保存の純な部分
// （js/shortcutsCore.js）・絵の字（js/shortcutsArt.js）・名前の見張り・保存の鍵の分け方。DOM なし（手元で直に読む）。
// 番号は docs/SPEC_SHORTCUTS.md §16 の単体の番号（1〜10・5b〜5d）。ファイルが無い・関数が無いときは、その検査を落として続ける（全部を数える）。
import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
const show = (v) => {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
};
// fn は true（通る）か、落ちた理由（文字・値）を返す。投げたら落ちる
function t(name, fn) {
  let r;
  try {
    r = fn();
  } catch (e) {
    r = `投げた: ${e?.message ?? e}`;
  }
  if (r === true) passed++;
  else {
    failed++;
    console.log(`✗ ${name}${r === false || r === undefined ? "" : ` — ${show(r).slice(0, 400)}`}`);
  }
}
const load = async (rel) => {
  try {
    return await import(pathToFileURL(path.join(ROOT, rel)).href);
  } catch (e) {
    failed++;
    console.log(`✗ ${rel} を読めない — ${String(e?.message ?? e).slice(0, 200)}`);
    return {};
  }
};
const D = await load("js/shortcutsData.js");
const C = await load("js/shortcutsCore.js");
const A = await load("js/shortcutsArt.js");
const ITEMS = Array.isArray(D.SHORTCUTS) ? D.SHORTCUTS : [];
const item = (id) => ITEMS.find((x) => x.id === id) ?? { id, keys: {} };
const LAYOUTS = ["ctrl", "cmd"];
const SOURCE_CODES = ["os-ctrl", "os-cmd", "shot-cmd", "doc", "web-g", "web-e", "web-s"];

// 事件の形（押す枠の keydown と同じ欄）。isTrusted は本物のキー
const ev = (o) => ({ isTrusted: true, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0, key: "", code: "", getModifierState: () => false, ...o });
// 正解の組の字（"ctrl+shift+z"・"meta+["・"F5"・"ctrl+#"）から、英語の並びのキーの事件を作る
const MOD_FLAG = { ctrl: "ctrlKey", alt: "altKey", shift: "shiftKey", meta: "metaKey" };
function keyOfToken(k, shift) {
  if (/^[a-z]$/.test(k)) return { key: shift ? k.toUpperCase() : k, code: "Key" + k.toUpperCase() };
  if (/^[0-9]$/.test(k)) return { key: k, code: "Digit" + k };
  if (k === "plus") return { key: shift ? "+" : "=", code: "Equal" };
  if (k === "minus") return { key: shift ? "_" : "-", code: "Minus" };
  if (k === "Space") return { key: " ", code: "Space" };
  if (k === "[") return { key: "[", code: "BracketLeft" };
  if (k === "]") return { key: "]", code: "BracketRight" };
  return { key: k, code: k };
}
function eventOf(accept, nth = 3, extra = []) {
  const parts = String(accept).split("+");
  const main = parts.pop();
  const mods = new Set([...parts.filter((p) => !p.startsWith("?")), ...extra]);
  const o = {};
  for (const m of mods) o[MOD_FLAG[m]] = true;
  return ev({ ...o, ...keyOfToken(main === "#" ? String(nth) : main, mods.has("shift")) });
}
const read = (e, layout) => C.readCombo(e, layout);
const judgeOf = (id, layout, e, nth = 3) => C.judge(item(id), layout, read(e, layout), nth);
const keysOf = (x, layout) => x?.keys?.[layout] ?? null;
const pressHow = (k) => k && (k.how === "press" || k.how === "guard");

// ===== 1. 表 =====
t("1 表: 50 項目（パソコン共通 30・ブラウザ 20。優先 A 21・B 29）・id が重ならない・凍結", () => {
  const ids = ITEMS.map((x) => x.id);
  const g = (v) => ITEMS.filter((x) => x.g === v).length;
  const p = (v) => ITEMS.filter((x) => x.p === v).length;
  return (ITEMS.length === 50 && new Set(ids).size === 50 && g("pc") === 30 && g("br") === 20 && p("A") === 21 && p("B") === 29 && Object.isFrozen(D.SHORTCUTS) && ITEMS.every((x) => Object.isFrozen(x))) || { n: ITEMS.length, pc: g("pc"), br: g("br"), A: p("A"), B: p("B") };
});
t("1 表: どの項目にも 群・優先・働き（問い）・short（働きから括弧を除いた字）・前と後の絵（文字の編集・ブラウザ・パソコンの画面）・読み上げの文 2 つ", () => {
  const bad = ITEMS.filter((x) => !["pc", "br"].includes(x.g) || !["A", "B"].includes(x.p) || typeof x.ja !== "string" || !x.ja
    || x.short !== x.ja.replace(/（[^）]*）/g, "").trim() || !x.short || /[（）]/.test(x.short)
    || !x.scene || !["doc", "web", "desk"].includes(x.scene.k) || !x.scene.a || !x.scene.b
    || !Array.isArray(x.say) || x.say.length !== 2 || !x.say.every((s) => typeof s === "string" && s.length > 2));
  return (ITEMS.length === 50 && bad.length === 0) || bad.map((x) => x.id);
});
t("1 表: ⌘ のキーボードに組の無い項目は pc.clipboard-history だけ。Ctrl のキーボードは全部ある", () => {
  const noCmd = ITEMS.filter((x) => !keysOf(x, "cmd")).map((x) => x.id);
  const noCtrl = ITEMS.filter((x) => !keysOf(x, "ctrl")).map((x) => x.id);
  return (show(noCmd) === '["pc.clipboard-history"]' && noCtrl.length === 0) || { noCmd, noCtrl };
});
t("1 表: 答え方の数（Ctrl: 押す 24・押す・守り 3・選ぶ 23／⌘: 押す 23・押す・守り 3・選ぶ 23）", () => {
  const n = (layout, how) => ITEMS.filter((x) => keysOf(x, layout)?.how === how).length;
  const got = LAYOUTS.map((l) => [n(l, "press"), n(l, "guard"), n(l, "choice")]);
  return show(got) === "[[24,3,23],[23,3,23]]" || got;
});
t("1 表: 出典は記号だけ（os-ctrl・os-cmd・shot-cmd・doc・web-g・web-e・web-s）・キーボードごとに 1 つ以上・確かめた日は 2026-11-11", () => {
  const bad = [];
  for (const x of ITEMS) for (const l of LAYOUTS) {
    const k = keysOf(x, l);
    if (!k) continue;
    if (!Array.isArray(k.src) || k.src.length === 0 || !k.src.every((s) => SOURCE_CODES.includes(s))) bad.push(`${x.id}@${l} ${show(k.src)}`);
  }
  return (bad.length === 0 && D.CHECKED_AT === "2026-11-11" && show(Object.keys(D.SOURCES ?? {}).sort()) === show([...SOURCE_CODES].sort())) || { bad, at: D.CHECKED_AT };
});
t("1 表: 見せる組（show）がどのキーボードにもある・押す組には正解（accept）がある・選ぶ組の理由（ブラウザ・パソコン・画面のキー・違い）", () => {
  const bad = [];
  for (const x of ITEMS) for (const l of LAYOUTS) {
    const k = keysOf(x, l);
    if (!k) continue;
    if (!Array.isArray(k.show) || !k.show.length || !k.show.every((v) => Array.isArray(v) && v.length)) bad.push(`${x.id}@${l} show`);
    if (pressHow(k) && (!Array.isArray(k.accept) || !k.accept.length)) bad.push(`${x.id}@${l} accept`);
    if (k.how === "choice" && !["browser", "os", "screen", "differ"].includes(k.why)) bad.push(`${x.id}@${l} why`);
    if (!["press", "guard", "choice"].includes(k.how)) bad.push(`${x.id}@${l} how`);
  }
  return (ITEMS.length === 50 && bad.length === 0) || bad;
});
t("1 表（判定役の直し）: 「次を検索」に F3 は無い・「探す」に F3 がある・ウィンドウを閉じるに括弧が無い・名前を付けて保存は無い・⌘ の再読み込みの出典は web-e と os-cmd", () => {
  const fn = keysOf(item("br.find-next"), "ctrl");
  const f = keysOf(item("br.find"), "ctrl");
  const rl = keysOf(item("br.reload"), "cmd");
  return (fn && !(fn.accept ?? []).includes("F3") && (f?.accept ?? []).includes("F3") && item("pc.close-window").ja === "いまのウィンドウを閉じる"
    && !ITEMS.some((x) => /名前を付けて保存/.test(x.ja)) && show([...(rl?.src ?? [])].sort()) === show(["os-cmd", "web-e"])) || { fn: fn?.accept, f: f?.accept, cw: item("pc.close-window").ja, rl: rl?.src };
});

// ===== 2. 答え方 =====
const ENV_KB = { keyboard: true, miss: { ctrl: [], cmd: [] } };
t("2 答え方: 押す問いの正解に Tab・Esc・⊞（Ctrl のキーボードの meta）・Fn が無い", () => {
  const bad = [];
  for (const x of ITEMS) for (const l of LAYOUTS) {
    const k = keysOf(x, l);
    if (!pressHow(k)) continue;
    for (const a of [...(k.accept ?? []), ...(k.also ?? [])]) {
      const parts = a.split("+");
      if (parts.some((p) => ["Tab", "Escape", "fn", "Fn"].includes(p)) || (l === "ctrl" && parts.includes("meta"))) bad.push(`${x.id}@${l} ${a}`);
    }
  }
  return (ITEMS.length === 50 && bad.length === 0) || bad;
});
t("2 答え方: 表で選ぶの項目は、キーボードがあっても押す問いにならない・押すの項目は押す・戻る／進む／再読み込みは押す・守り", () => {
  const bad = [];
  for (const x of ITEMS) for (const l of LAYOUTS) {
    const k = keysOf(x, l);
    if (!k) {
      if (C.modeOf(x, l, ENV_KB) !== null) bad.push(`${x.id}@${l} 無いのに出す`);
      continue;
    }
    const m = C.modeOf(x, l, ENV_KB);
    if (m !== k.how) bad.push(`${x.id}@${l} ${m}≠${k.how}`);
  }
  const guards = ["br.back", "br.forward", "br.reload"].flatMap((id) => LAYOUTS.map((l) => C.modeOf(item(id), l, ENV_KB)));
  return (bad.length === 0 && guards.every((m) => m === "guard")) || { bad, guards };
});
t("2 答え方: 指の端末で物理キーをまだ見ていない（keyboard なし）→ どの項目も選ぶ", () => {
  const bad = ITEMS.flatMap((x) => LAYOUTS.filter((l) => keysOf(x, l) && C.modeOf(x, l, { keyboard: false, miss: { ctrl: [], cmd: [] } }) !== "choice").map((l) => `${x.id}@${l}`));
  return (ITEMS.length === 50 && bad.length === 0) || bad;
});
t("2 答え方: この端末で届かなかった組（miss）は選ぶ・ほかのキーボードの miss は効かない", () => {
  const a = C.modeOf(item("pc.copy"), "ctrl", { keyboard: true, miss: { ctrl: ["ctrl+c"], cmd: [] } });
  const b = C.modeOf(item("pc.copy"), "ctrl", { keyboard: true, miss: { ctrl: [], cmd: ["meta+c"] } });
  const c = C.modeOf(item("pc.copy"), "cmd", { keyboard: true, miss: { ctrl: [], cmd: ["meta+c"] } });
  return (a === "choice" && b === "press" && c === "choice") || { a, b, c };
});

// ===== 3. 判定 =====
t("3 判定: 全部の押す組（accept と also）を両方のキーボードで正解（n 番目のタブは問いの数）", () => {
  const bad = [];
  for (const x of ITEMS) for (const l of LAYOUTS) {
    const k = keysOf(x, l);
    if (!pressHow(k)) continue;
    for (const a of [...k.accept, ...(k.also ?? [])]) {
      const v = C.judge(x, l, read(eventOf(a, 5), l), 5);
      if (v !== "ok") bad.push(`${x.id}@${l} ${a} → ${v}`);
    }
  }
  return (ITEMS.length === 50 && bad.length === 0) || bad;
});
t("3 判定: 正解の組に修飾を 1 つ足すと ×（足した組がその項目のほかの正解・近い組のときを除く）", () => {
  const bad = [];
  let n = 0;
  for (const x of ITEMS) for (const l of LAYOUTS) {
    const k = keysOf(x, l);
    if (!pressHow(k)) continue;
    for (const a of k.accept) {
      const p = C.parseAccept(a);
      for (const m of ["ctrl", "alt", "shift", "meta"]) {
        if (p.mods.has(m) || p.optional.has(m)) continue;
        const e = eventOf(a, 5, [m]);
        const combo = read(e, l);
        const own = [...k.accept, ...(k.also ?? [])].some((b) => C.matchesAccept(b, combo, 5));
        const near = (k.near ?? []).some((b) => C.matchesAccept(b, combo, 5));
        const want = own ? "ok" : near ? "near" : "wrong";
        const v = C.judge(x, l, combo, 5);
        n++;
        if (v !== want) bad.push(`${x.id}@${l} ${a}+${m} → ${v}（${want}）`);
      }
    }
  }
  return (bad.length === 0 && n > 150) || { n, bad };
});
t("3 判定: 修飾は旗でちょうど一致（Ctrl+Shift+C はコピーでない）・⌘ の問いの Ctrl+C は × ・大文字の key でも正解", () => {
  const a = judgeOf("pc.copy", "ctrl", ev({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }));
  const b = judgeOf("pc.copy", "cmd", ev({ key: "c", code: "KeyC", ctrlKey: true }));
  const c = judgeOf("pc.redo", "cmd", ev({ key: "Z", code: "KeyZ", metaKey: true, shiftKey: true }));
  return (a === "wrong" && b === "wrong" && c === "ok") || { a, b, c };
});
t("3 判定（反証 1）: ⌘ のキーボードで getModifierState(\"AltGraph\") が真でも ⌥←・⌥⇧→・⌥+Backspace は正解", () => {
  const ag = (o) => ev({ ...o, altKey: true, getModifierState: (m) => m === "AltGraph" });
  const a = judgeOf("pc.word-left-right", "cmd", ag({ key: "ArrowLeft", code: "ArrowLeft" }));
  const b = judgeOf("pc.select-word", "cmd", ag({ key: "ArrowRight", code: "ArrowRight", shiftKey: true }));
  const c = judgeOf("pc.delete-word", "cmd", ag({ key: "Backspace", code: "Backspace" }));
  return (a === "ok" && b === "ok" && c === "ok") || { a, b, c };
});
t("3 判定（AltGr）: Ctrl のキーボードで ctrlKey・altKey・AltGraph の 3 つが立つ押し方は Ctrl+Alt にしない（どの項目の正解にもならない）", () => {
  const e = ev({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true, getModifierState: (m) => m === "AltGraph" });
  const c = read(e, "ctrl");
  const okAny = ITEMS.some((x) => keysOf(x, "ctrl") && C.judge(x, "ctrl", c, 3) === "ok");
  const plain = read(ev({ key: "q", code: "KeyQ", ctrlKey: true, altKey: true }), "ctrl");
  return (c.altGraph === true && !c.ctrl && !c.alt && !okAny && plain.ctrl === true && plain.alt === true) || { c, plain, okAny };
});
t("3 判定: 日本語入力の間の英字と数字は code で読む（Process・keyCode 229 に Ctrl）・⌥ の作る字は code の位置・数字は code（Shift つきの数字の字）", () => {
  const a = judgeOf("pc.copy", "ctrl", ev({ key: "Process", keyCode: 229, code: "KeyC", ctrlKey: true }));
  const b = judgeOf("pc.paste-plain", "cmd", ev({ key: "◊", code: "KeyV", metaKey: true, altKey: true, shiftKey: true }));
  const bb = C.mainKey(ev({ key: "ç", code: "KeyC", altKey: true }));
  const c = judgeOf("br.zoom-reset", "ctrl", ev({ key: "à", code: "Digit0", ctrlKey: true }));
  const d = judgeOf("br.tab-n", "ctrl", ev({ key: "!", code: "Digit1", ctrlKey: true }), 1);
  return (a === "ok" && bb === "c" && c === "ok" && d === "ok") || { a, bb, c, d };
});
t("3 判定: 拡大の + の 4 通り（英語の並びの = と +、日本語の並びの ; と Shift+;）とテンキーの +・縮小の -・元の大きさの 0", () => {
  const z = (o, l = "ctrl") => judgeOf("br.zoom-in", l, ev(o));
  const r = [
    z({ key: "=", code: "Equal", ctrlKey: true }), z({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }),
    z({ key: ";", code: "Semicolon", ctrlKey: true }), z({ key: "+", code: "Semicolon", ctrlKey: true, shiftKey: true }),
    z({ key: "+", code: "NumpadAdd", ctrlKey: true }), z({ key: "+", code: "NumpadAdd", metaKey: true }, "cmd"),
    judgeOf("br.zoom-out", "cmd", ev({ key: "-", code: "Minus", metaKey: true })), judgeOf("br.zoom-out", "ctrl", ev({ key: "-", code: "NumpadSubtract", ctrlKey: true })),
    judgeOf("br.zoom-reset", "cmd", ev({ key: "0", code: "Digit0", metaKey: true }))
  ];
  return r.every((v) => v === "ok") || r;
});
t("3 判定（反証 4）: 日本語の並びの Ctrl+Shift+-（key =・code Minus）は「小さく」で正解・「大きく」で ×／^ のキー（key ^・code Equal）は「大きく」で ×／日本語入力の間の ^（key Process・code Equal）は判定しない／⌘[（key [・code BracketRight）は戻るで正解", () => {
  const jm = ev({ key: "=", code: "Minus", ctrlKey: true, shiftKey: true });
  const a = judgeOf("br.zoom-out", "ctrl", jm);
  const b = judgeOf("br.zoom-in", "ctrl", jm);
  const c = judgeOf("br.zoom-in", "ctrl", ev({ key: "^", code: "Equal", ctrlKey: true }));
  const d = judgeOf("br.zoom-in", "ctrl", ev({ key: "Process", keyCode: 229, code: "Equal", ctrlKey: true }));
  const e = judgeOf("br.back", "cmd", ev({ key: "[", code: "BracketRight", metaKey: true }));
  const f = judgeOf("br.back", "cmd", ev({ key: "[", code: "BracketLeft", metaKey: true }));
  const g = judgeOf("br.forward", "cmd", ev({ key: "[", code: "BracketRight", metaKey: true }));
  return (a === "ok" && b === "wrong" && c === "wrong" && d === "unclear" && e === "ok" && f === "ok" && g === "wrong") || { a, b, c, d, e, f, g };
});
t("3 判定（反証 8）: 公式の頁にある別の組（also）も正解: Ctrl+Insert はコピー・Shift+Insert は貼り付け・PageDown／PageUp は 1 画面ずつ（両方のキーボード）", () => {
  const r = [
    judgeOf("pc.copy", "ctrl", ev({ key: "Insert", code: "Insert", ctrlKey: true })),
    judgeOf("pc.paste", "ctrl", ev({ key: "Insert", code: "Insert", shiftKey: true })),
    judgeOf("br.scroll-page", "ctrl", ev({ key: "PageDown", code: "PageDown" })),
    judgeOf("br.scroll-page", "ctrl", ev({ key: "PageUp", code: "PageUp" })),
    judgeOf("br.scroll-page", "cmd", ev({ key: "PageDown", code: "PageDown" })),
    judgeOf("br.scroll-page", "cmd", ev({ key: "PageUp", code: "PageUp" }))
  ];
  return r.every((v) => v === "ok") || r;
});
t("3 判定: F3 は「探す」で正解・「次を検索」で ×（判定役の直し）", () => {
  const a = judgeOf("br.find", "ctrl", ev({ key: "F3", code: "F3" }));
  const b = judgeOf("br.find-next", "ctrl", ev({ key: "F3", code: "F3" }));
  return (a === "ok" && b === "wrong") || { a, b };
});
t("3 判定: やり直すの Ctrl+Shift+Z と ⌘Y は近い組（数えない）", () => {
  const a = judgeOf("pc.redo", "ctrl", ev({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }));
  const b = judgeOf("pc.redo", "cmd", ev({ key: "y", code: "KeyY", metaKey: true }));
  return (a === "near" && b === "near") || { a, b };
});
t("3 判定: アドレスバーは Ctrl+L と Alt+D が正解・F6 と F4 は近い組・⌘ の戻るの ⌘← は近い組", () => {
  const r = [judgeOf("br.address", "ctrl", ev({ key: "l", code: "KeyL", ctrlKey: true })), judgeOf("br.address", "ctrl", ev({ key: "d", code: "KeyD", altKey: true })),
    judgeOf("br.address", "ctrl", ev({ key: "F6", code: "F6" })), judgeOf("br.address", "ctrl", ev({ key: "F4", code: "F4" })),
    judgeOf("br.back", "cmd", ev({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }))];
  return show(r) === show(["ok", "ok", "near", "near", "near"]) || r;
});
t("3 判定: ⌘ のキーボードの delete は key Backspace（⌥+delete で前の 1 語を消す）・n 番目のタブは問いの数だけ正解・Enter は答えにしない", () => {
  const a = judgeOf("pc.delete-word", "cmd", ev({ key: "Backspace", code: "Backspace", altKey: true }));
  const b = judgeOf("br.tab-n", "ctrl", ev({ key: "3", code: "Digit3", ctrlKey: true }), 3);
  const c = judgeOf("br.tab-n", "ctrl", ev({ key: "4", code: "Digit4", ctrlKey: true }), 3);
  const d = judgeOf("br.tab-n", "cmd", ev({ key: "7", code: "Digit7", metaKey: true }), 7);
  const e = ITEMS.some((x) => LAYOUTS.some((l) => pressHow(keysOf(x, l)) && C.judge(x, l, read(ev({ key: "Enter", code: "Enter" }), l), 3) === "ok"));
  return (a === "ok" && b === "ok" && c === "wrong" && d === "ok" && !e) || { a, b, c, d, e };
});
t("3 判定（反証 5）: 表の全部を回し、切り替えを聞く押し方は今のキーボードのほかの項目の正解（also を含む）でない・聞く押し方はある", () => {
  let prompts = 0;
  const bad = [];
  for (const l of LAYOUTS) {
    const o = l === "ctrl" ? "cmd" : "ctrl";
    for (const x of ITEMS) {
      const k = keysOf(x, l);
      const ko = keysOf(x, o);
      if (!pressHow(k) || !ko?.accept) continue;
      for (const a of [...ko.accept, ...(ko.also ?? [])]) {
        const combo = read(eventOf(a, 3), l);
        const r = C.afterWrong(x, l, combo, 3, ITEMS);
        if (!r?.suggest) continue;
        prompts++;
        const own = ITEMS.filter((y) => y.id !== x.id && keysOf(y, l) && [...(keysOf(y, l).accept ?? []), ...(keysOf(y, l).also ?? [])].some((b) => C.matchesAccept(b, combo, 3)));
        if (own.length) bad.push(`${l}/${x.id}/${a}: ${own.map((y) => y.id).join(",")}`);
      }
    }
  }
  return (bad.length === 0 && prompts > 30) || { prompts, bad };
});
t("3 判定（反証 5）: Ctrl の「1 語ずつ動かす」で Alt+← は「戻る」の組（own）・切り替えは聞かない／⌘ の戻るで ⌥← は「1 語ずつ動かす」の組／Ctrl のコピーで ⌘C は切り替えを聞く", () => {
  const a = C.afterWrong(item("pc.word-left-right"), "ctrl", read(ev({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }), "ctrl"), 3, ITEMS);
  const b = C.afterWrong(item("br.back"), "cmd", read(ev({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }), "cmd"), 3, ITEMS);
  const c = C.afterWrong(item("pc.copy"), "ctrl", read(ev({ key: "c", code: "KeyC", metaKey: true }), "ctrl"), 3, ITEMS);
  return (a?.own?.id === "br.back" && !a.suggest && a.own.short === "前のページに戻る" && b?.own?.id === "pc.word-left-right" && !b.suggest && c?.suggest === "cmd" && !c.own) || { a: a?.own?.id ?? a, b: b?.own?.id ?? b, c };
});
t("3 ほかの項目の組の文: 「それは前のページに戻る組。」（動きの言葉にはそのまま 組）・「それはページを 1 画面ずつ下への組。」（へ で終わる名には の）・50 項目どれも「それは…組。」で、動きの言葉の後に の を挟まない", () => {
  if (typeof C.ownText !== "function") return "ownText が無い";
  const a = C.ownText(item("br.back"));
  const b = C.ownText(item("br.scroll-page"));
  const c = C.ownText(item("br.find-next"));
  const bad = ITEMS.map((x) => [x.id, C.ownText(x)]).filter(([, s]) => !/^それは.+組。$/.test(s) || /[うくぐすつぬぶむる]の組。$/.test(s));
  return (a === "それは前のページに戻る組。" && b === "それはページを 1 画面ずつ下への組。" && c === "それは探した言葉の次の場所への組。" && bad.length === 0) || { a, b, c, bad };
});

// ===== 4. 止める・日本語入力 =====
t("4 止める: Tab・Shift+Tab・Esc は止めない／Ctrl・⌘・Alt つき・F キー・Space・矢印・Home・End・PageUp・PageDown・Insert・Backspace は止める・字だけは止めない", () => {
  const no = [ev({ key: "Tab" }), ev({ key: "Tab", shiftKey: true }), ev({ key: "Escape" }), ev({ key: "a", code: "KeyA" })];
  const yes = [ev({ key: "c", ctrlKey: true }), ev({ key: "r", metaKey: true }), ev({ key: "ArrowLeft", altKey: true }), ev({ key: "F5" }), ev({ key: "F12" }), ev({ key: " " }),
    ev({ key: "ArrowDown" }), ev({ key: "Home" }), ev({ key: "End" }), ev({ key: "PageUp" }), ev({ key: "PageDown" }), ev({ key: "Insert" }), ev({ key: "Backspace" }), ev({ key: "Control", ctrlKey: true }), ev({ key: "Meta", metaKey: true }), ev({ key: "Alt", altKey: true })];
  const a = no.map((e) => C.shouldCancel(e));
  const b = yes.map((e) => C.shouldCancel(e));
  return (a.every((v) => v === false) && b.every((v) => v === true)) || { a, b };
});
t("4 日本語入力: 修飾なしの変換中（isComposing・keyCode 229・key Process）は判定しない・修飾つき（Ctrl・⌘・Alt）は読む（code で）", () => {
  const a = [ev({ isComposing: true, key: "k" }), ev({ keyCode: 229, key: "k" }), ev({ key: "Process", code: "KeyC" })].map((e) => C.isImeEvent(e));
  const b = [ev({ key: "Process", keyCode: 229, code: "KeyC", ctrlKey: true }), ev({ key: "Process", keyCode: 229, code: "KeyC", metaKey: true }), ev({ key: "c", code: "KeyC" })].map((e) => C.isImeEvent(e));
  return (a.every(Boolean) && b.every((v) => !v)) || { a, b };
});
t("4 物理キーの見分け: 本物（isTrusted）で物理の code の keydown だけ・合成の事件と code の無い打鍵は数えない", () => {
  const r = [C.isPhysicalKey(ev({ key: "a", code: "KeyA" })), C.isPhysicalKey(ev({ key: "1", code: "Digit1" })), C.isPhysicalKey(ev({ key: "a", code: "KeyA", isTrusted: false })), C.isPhysicalKey(ev({ key: "Unidentified", code: "" }))];
  return show(r) === "[true,true,false,false]" || r;
});

// ===== 5. 届かなかった組の見張り（純な状態機械） =====
const mod = (name, held = {}) => ev({ key: name, code: name + "Left", ctrlKey: name === "Control" || !!held.ctrl, altKey: name === "Alt" || !!held.alt, shiftKey: name === "Shift" || !!held.shift, metaKey: name === "Meta" || !!held.meta });
t("5 見張り（反証 2）: 正解と同じ修飾 → 1.5 秒以内に焦点が外れる → 1 回目はその問いだけ選ぶ形（覚えない）・同じページで同じ組の 2 回目に覚える", () => {
  const w = C.createMissWatcher();
  w.keydown(mod("Meta"), 1000);
  const first = w.lost(1500, item("pc.copy"), "cmd");
  w.reset();
  w.keydown(mod("Meta"), 5000);
  const second = w.lost(5200, item("pc.copy"), "cmd");
  return (first?.toChoice === true && first.persist === false && second?.toChoice === true && second.persist === true && show(second.combos) === '["meta+c"]') || { first, second };
});
t("5 見張り（反証 2）: Ctrl+C の問いで Alt だけを押して焦点が外れる（窓の切り替え）→ 何もしない・1.5 秒を過ぎた焦点の外れも何もしない", () => {
  const w = C.createMissWatcher();
  w.keydown(mod("Alt"), 1000);
  const a = w.lost(1100, item("pc.copy"), "ctrl");
  w.keydown(mod("Control"), 2000);
  const b = w.lost(3600, item("pc.copy"), "ctrl");
  return (a === null && b === null) || { a, b };
});
t("5 見張り: 修飾 → 主のキー → 焦点が外れる → 覚えない／Shift → Tab（Shift+Tab）→ 外れる → 覚えない／Ctrl の keydown → Ctrl の keyup → Tab → 外れる → 覚えない", () => {
  const w = C.createMissWatcher();
  w.keydown(mod("Control"), 1000);
  w.keydown(ev({ key: "c", code: "KeyC", ctrlKey: true }), 1050);
  const a = w.lost(1100, item("pc.copy"), "ctrl");
  w.keydown(mod("Shift"), 2000);
  w.keydown(ev({ key: "Tab", code: "Tab", shiftKey: true }), 2050);
  const b = w.lost(2100, item("pc.redo"), "cmd");
  w.keydown(mod("Control"), 3000);
  w.keyup(ev({ key: "Control", code: "ControlLeft" }), 3050);
  w.keydown(ev({ key: "Tab", code: "Tab" }), 3100);
  const c = w.lost(3150, item("pc.copy"), "ctrl");
  return (a === null && b === null && c === null) || { a, b, c };
});
t("5 見張り: 次の問い（reset）で解く・Ctrl を押したまま外れるのを同じ項目で 2 回 → 2 回目に覚える組は ctrl+c", () => {
  const w = C.createMissWatcher();
  w.keydown(mod("Control"), 1000);
  w.reset();
  const a = w.lost(1100, item("pc.copy"), "ctrl");
  w.keydown(mod("Control"), 2000);
  const b = w.lost(2100, item("pc.copy"), "ctrl");
  w.keydown(mod("Control"), 3000);
  const c = w.lost(3100, item("pc.copy"), "ctrl");
  return (a === null && b?.persist === false && c?.persist === true && show(c.combos) === '["ctrl+c"]') || { a, b, c };
});

// ===== 5b. 次へ =====
t("5b 次へ（反証 3）: 答えた後の repeat の keydown・答えて 300 ms 以内で答えたキーの keyup の前の Enter・Space では進まない／keyup の後・300 ms の後の Enter・Space で進む・字では進まない", () => {
  const R = { answeredAt: 1000, released: false };
  const r = [
    C.shouldAdvance(ev({ key: " ", code: "Space", repeat: true }), { answeredAt: 1000, released: true }, 5000),
    C.shouldAdvance(ev({ key: "Enter", code: "Enter" }), R, 1100),
    C.shouldAdvance(ev({ key: " ", code: "Space" }), R, 1200),
    C.shouldAdvance(ev({ key: "Enter", code: "Enter" }), { answeredAt: 1000, released: true }, 1100),
    C.shouldAdvance(ev({ key: " ", code: "Space" }), R, 1400),
    C.shouldAdvance(ev({ key: "a", code: "KeyA" }), { answeredAt: 1000, released: true }, 5000)
  ];
  return show(r) === "[false,false,false,true,true,false]" || r;
});

// ===== 5c. 戻る・進む・再読み込みの守り =====
t("5c 守り（反証 6）: 印 sdGuard のある状態だけを守りと見る・戻るの問いの間の popstate は数える・印の段に進むで着いたら進むの問いなら数えて戻る・ほかは黙って戻る・自分の history.back() の popstate は無視する", () => {
  const g = C.guardState("r1");
  const r = [C.isGuardState(g), C.isGuardState(null), C.isGuardState({}), C.isGuardState({ sdReload: { id: "br.reload" } }),
    C.onGuardPop(null, { ignore: 0, waiting: "br.back", pushed: true }), C.onGuardPop({ sdReload: 1 }, { ignore: 0, waiting: "br.back", pushed: true }),
    C.onGuardPop(null, { ignore: 0, waiting: "pc.copy", pushed: false }), C.onGuardPop(null, { ignore: 0, waiting: "br.back", pushed: false }),
    C.onGuardPop(g, { ignore: 0, waiting: "br.forward", pushed: false }), C.onGuardPop(g, { ignore: 0, waiting: null, pushed: false }), C.onGuardPop(g, { ignore: 0, waiting: "br.back", pushed: true }),
    C.onGuardPop(null, { ignore: 1, waiting: "br.back", pushed: true })];
  return show(r) === show([true, false, false, false, "count", "count", "none", "none", "count-back", "back", "back", "self"]) || r;
});
t("5c 守り: 読み込みで印の段を見たら印だけを外す（ほかの欄は残す）・再読み込みの印は reload で 2 分以内なら数える（それ以外は数えない）", () => {
  const a = C.withoutGuard({ sdGuard: "r1", sdReload: { id: "br.reload", layout: "ctrl", at: 5 } });
  const b = C.withoutGuard({ sdGuard: "r1" });
  const mark = C.reloadMark("br.reload", "cmd", 1000);
  const st = { sdReload: mark };
  const r = [C.reloadCounted(st, "reload", 1000 + 60000)?.layout, C.reloadCounted(st, "navigate", 2000), C.reloadCounted(st, "reload", 1000 + 121000), C.reloadCounted({}, "reload", 2000),
    C.reloadCounted({ sdReload: { id: "pc.copy", layout: "ctrl", at: 1000 } }, "reload", 2000)];
  return (show(a) === show({ sdReload: { id: "br.reload", layout: "ctrl", at: 5 } }) && b === null && show(r) === show(["cmd", null, null, null, null])) || { a, b, r };
});

// ===== 5d. 端末の鍵 =====
const memStore = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
};
t("5d 端末の鍵（反証 7）: 読み手は kb のような欄を読まない・書き手は書かない（{ layout: \"ctrl\", kb: 1 } でも「キーボードを見た」にならない）・読めない値は空", () => {
  const s = memStore({ spelldash_shortcut_device: JSON.stringify({ layout: "ctrl", kb: 1, arr: "us" }) });
  const d = C.readDevice(s);
  const ok1 = d.layout === "ctrl" && d.arr === "us" && !("kb" in d) && !("keyboard" in d) && show(d.miss) === show({ ctrl: [], cmd: [] });
  C.writeDevice(s, d);
  const written = JSON.parse(s.getItem("spelldash_shortcut_device"));
  const bad = C.readDevice(memStore({ spelldash_shortcut_device: "{oops" }));
  const none = C.readDevice(memStore({}));
  return (ok1 && !("kb" in written) && bad.layout === null && bad.arr === "jis" && none.layout === null && show(none.miss) === show({ ctrl: [], cmd: [] })) || { d, written, bad, none };
});
t("5d 端末の鍵: 届かなかった組はキーボードごとに 40 まで（新しい物を残す）・「押して答えるに戻す」で空", () => {
  let d = C.readDevice(memStore({}));
  for (let i = 0; i < 45; i++) d = C.addMiss(d, "ctrl", [`ctrl+k${i}`]);
  d = C.addMiss(d, "cmd", ["meta+c", "meta+c"]);
  const ok1 = d.miss.ctrl.length === 40 && d.miss.ctrl.includes("ctrl+k44") && !d.miss.ctrl.includes("ctrl+k0") && show(d.miss.cmd) === '["meta+c"]';
  const e = C.clearMiss(d);
  return (ok1 && e.miss.ctrl.length === 0 && e.miss.cmd.length === 0) || { d: d.miss, e: e?.miss };
});

// ===== 6. 3 状態 =====
const day = (dd) => new Date(2026, 10, dd, 12).getTime();
t("6 3 状態: js/learnState.js の nextLearnState と同じ動き（これから→覚えた・× であやふや・あやふやは日を変えて 2 日目に覚えた）・キーボードごとに別・押したか選んだか（how）を残す", () => {
  let p = C.emptyProgress();
  p = C.applyAnswer(p, "pc.copy", "ctrl", true, day(11), "p");
  p = C.applyAnswer(p, "pc.paste", "ctrl", false, day(11), "c");
  const s1 = [C.stateOf(p, "pc.copy", "ctrl"), C.stateOf(p, "pc.copy", "cmd"), C.stateOf(p, "pc.paste", "ctrl")];
  p = C.applyAnswer(p, "pc.paste", "ctrl", true, day(11), "p");
  const s2 = C.stateOf(p, "pc.paste", "ctrl");
  p = C.applyAnswer(p, "pc.paste", "ctrl", true, day(12), "c");
  const s3 = C.stateOf(p, "pc.paste", "ctrl");
  p = C.applyAnswer(p, "pc.copy", "ctrl", false, day(13), "p");
  const rec = p.it["pc.paste@ctrl"];
  return (show(s1) === "[2,0,1]" && s2 === 1 && s3 === 2 && C.stateOf(p, "pc.copy", "ctrl") === 1 && rec.how === "c" && rec.at === day(12) && C.keyOf("pc.copy", "cmd") === "pc.copy@cmd") || { s1, s2, s3, rec };
});
t("6 保存: 読めない JSON・形の違う値は空として読む・書いた物を読み直すと同じ・鍵は spelldash_shortcuts", () => {
  const s = memStore({});
  let p = C.applyAnswer(C.emptyProgress(), "br.back", "cmd", true, day(11), "p");
  const ok = C.writeProgress(s, p);
  const back = C.readProgress(s);
  const bad = [C.readProgress(memStore({ spelldash_shortcuts: "{bad" })), C.readProgress(memStore({ spelldash_shortcuts: "[1,2]" })), C.readProgress(memStore({ spelldash_shortcuts: '{"v":2,"it":{}}' }))];
  const throwing = C.writeProgress({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, p);
  return (ok === true && show(back) === show(p) && [...s.map.keys()].join() === "spelldash_shortcuts" && C.PROGRESS_KEY === "spelldash_shortcuts" && C.DEVICE_KEY === "spelldash_shortcut_device"
    && bad.every((b) => show(b) === show(C.emptyProgress())) && throwing === false) || { back, bad };
});
t("6 数: これから＋あやふや＋覚えた＝そのキーボードの項目の数（Ctrl 50・⌘ 49）・群で絞れる", () => {
  let p = C.applyAnswer(C.emptyProgress(), "pc.copy", "ctrl", true, day(11), "p");
  p = C.applyAnswer(p, "br.back", "ctrl", false, day(11), "p");
  const a = C.countStates(p, ITEMS, "ctrl");
  const b = C.countStates(p, ITEMS, "cmd");
  const c = C.countStates(p, ITEMS, "ctrl", "br");
  return (a.total === 50 && a.new === 48 && a.unsure === 1 && a.learned === 1 && b.total === 49 && b.new === 49 && c.total === 20 && c.unsure === 1 && c.learned === 0) || { a, b, c };
});
t("6 回の中の 2 回目からは記録しない（回の中のやり直しは練習）・× の組は 3 問後にもう一度（2 回まで）", () => {
  const q = ["pc.copy", "pc.paste", "pc.cut", "pc.undo", "pc.redo"].map(item);
  let st = C.newRound(q, C.emptyProgress());
  const step = (result) => {
    const x = st.queue[st.i];
    const r = C.roundAnswer(st, { item: x, layout: "ctrl", result, how: "p", nowMs: day(11) });
    st = { ...r.st, i: r.st.i + 1 };
    return { id: x.id, recorded: r.recorded };
  };
  const first = step("wrong");
  const ids1 = st.queue.map((x) => x.id);
  step("ok"); step("ok"); step("ok");
  const again = step("ok");
  const s = C.stateOf(st.progress, "pc.copy", "ctrl");
  // 2 回まで: 3 回まちがえても 3 回目の後は足さない
  let st2 = C.newRound(q.slice(0, 1), C.emptyProgress());
  let n = 0;
  while (st2.i < st2.queue.length && n < 10) {
    const r = C.roundAnswer(st2, { item: st2.queue[st2.i], layout: "ctrl", result: "wrong", how: "p", nowMs: day(11) });
    st2 = { ...r.st, i: r.st.i + 1 };
    n++;
  }
  return (first.recorded === true && show(ids1) === show(["pc.copy", "pc.paste", "pc.cut", "pc.undo", "pc.copy", "pc.redo"]) && again.id === "pc.copy" && again.recorded === false && s === 1 && n === 3 && st2.firsts["pc.copy"] === false) || { first, ids1, again, s, n };
});

// ===== 7. 回 =====
t("7 回: 10 問・今日の分のあやふや（古い順）→ これから（A → B、表の順）→ 覚えた（古い順）→ 今日もう数えたあやふや・群で絞る・そのキーボードに組のある項目だけ", () => {
  const today = C.dayOf(day(20));
  let p = C.emptyProgress();
  const set = (id, s, d, at) => { p = { ...p, it: { ...p.it, [`${id}@ctrl`]: { s, ...(d === null ? {} : { d }), at, how: "p" } } }; };
  set("pc.print", 1, null, 30); set("pc.bold", 1, today - 1, 20); set("pc.cut", 1, today, 10);
  set("pc.copy", 2, null, 50); set("pc.paste", 2, null, 40);
  const r = C.buildRound(ITEMS, "ctrl", p, { size: 10, today });
  const ids = r.map((x) => x.id);
  const all = C.buildRound(ITEMS, "ctrl", p, { size: 60, today }).map((x) => x.id);
  const firstNewB = all.findIndex((id) => item(id).p === "B" && !p.it[`${id}@ctrl`]);
  const lastNewA = all.map((id) => item(id).p === "A" && !p.it[`${id}@ctrl`]).lastIndexOf(true);
  const tail = all.slice(-3);
  const cmd = C.buildRound(ITEMS, "cmd", C.emptyProgress(), { size: 60, today }).map((x) => x.id);
  const br = C.buildRound(ITEMS, "ctrl", C.emptyProgress(), { size: 10, today, group: "br" });
  return (r.length === 10 && show(ids.slice(0, 3)) === show(["pc.bold", "pc.print", "pc.undo"]) && lastNewA < firstNewB && show(tail) === show(["pc.paste", "pc.copy", "pc.cut"])
    && all.length === 50 && cmd.length === 49 && !cmd.includes("pc.clipboard-history") && br.length === 10 && br.every((x) => x.g === "br") && br[0].id === "br.new-tab") || { ids, tail, firstNewB, lastNewA, n: all.length, cmd: cmd.length };
});
t("7 回: 間違えた組だけの回（only）", () => {
  const r = C.buildRound(ITEMS, "ctrl", C.emptyProgress(), { size: 20, only: ["br.find", "pc.copy"] }).map((x) => x.id);
  return show(r) === show(["pc.copy", "br.find"]) || r;
});

// ===== 8. 選択肢 =====
t("8 選択肢: 50 × 2 の全部で 4 つ・正解 1 つ・同じキーの組を並べない・ブラウザで違う組の別の形と別の組（also）と近い組を誤りの選択肢に使わない・番号の読み上げは「コントロール と C」", () => {
  const bad = [];
  let rngN = 0;
  const rng = () => ((rngN = (rngN * 9301 + 49297) % 233280) / 233280);
  for (const x of ITEMS) for (const l of LAYOUTS) {
    const k = keysOf(x, l);
    if (!k) continue;
    const own = new Set([...(k.show ?? []), ...(k.alt ?? [])].map((caps) => C.sigOfCaps(caps.map((c) => (c === "1〜8" ? "3" : c)), l)));
    for (const a of [...(k.accept ?? []), ...(k.also ?? []), ...(k.near ?? [])]) own.add(C.comboString(read(eventOf(a, 3), l)));
    for (let r = 0; r < 3; r++) {
      const c = C.buildChoices(x, l, ITEMS, rng, 3);
      const sigs = c.map((o) => o.sig);
      const wrongOwn = c.filter((o) => !o.correct && own.has(o.sig));
      if (c.length !== 4 || c.filter((o) => o.correct).length !== 1 || new Set(sigs).size !== 4 || wrongOwn.length || !c.every((o) => Array.isArray(o.caps) && o.caps.length)) bad.push(`${x.id}@${l} ${show(sigs)}`);
    }
  }
  const spoken = C.spokenCaps(["Ctrl", "C"], "and");
  const hold = C.spokenCaps(["⇧", "⌘", "Z"], "hold");
  return (bad.length === 0 && spoken === "コントロール と C" && hold === "シフト と コマンド を押したまま Z") || { bad: bad.slice(0, 8), n: bad.length, spoken, hold };
});

// ===== 9. 名前の見張り =====
// 会社・製品・OS・ブラウザ・言語の名前の一覧はリポジトリに置かない（公開の決まり）。名前の SHA-256（塩つき）の頭 16 桁だけを持つ（docs/SPEC_SLANG.md の前例）。
// 英字は大文字小文字を区別し、前後が英字・数字でない所（字の塊）だけ当てる。2 語の名前は続く 2 つの塊で当てる。カタカナは前後がカタカナでない所（塊）だけ当てる。
// 当たりの確かめに一覧に入れた作り物の語の形（canary）が 1 つある
const NAME_SALT = "spelldash-shortcuts-names:";
const NAMES_ASCII = new Set(["06f5d439c3cb6b74", "09a5044143a4ae72", "13207f5222fdfb54", "2051eadddf745125", "23ae5a7f699cb440", "2553d3bc63dc6147", "2bfee1e5666d472e", "2d6e9a79fcf94f93", "2d7adecdb47cbc44", "33b0a6541284af89", "345d4c6bba9618f7", "3550833775c6cd0e", "48c7336c9e6862ac", "49bd786bdbf7af5a", "49d372f9215ce9e2", "4f1a7a13596dffc2", "513cf409fa8e7c6c", "52839a20148552a4", "5469e5f621e587c5", "5543d1b2c6da3b54", "5772adb10df5f13d", "594e5118afb9e8de", "5ad088e10b5ee6c9", "5ae59d56da09b931", "5aef5d34452c4796", "62a4c27256707857", "64ec738f41969d78", "686b0dfd67faa46e", "6b49e42bed8cbdef", "774b1a5837e14335", "7beb88e0033fa92c", "862a054aa3474792", "88a68ce5329f9e7a", "8a4beef6a65a8205", "90f8c45812dc4693", "91f24ba751ca4679", "96ce79fcea2cc5e4", "9b8a7c0a074e7d5e", "a6cca0fa5b468e27", "afe1a07f1441b14a", "b05935b0e41e1607", "b0ca070ec9790c7c", "b0d193323081db9d", "b47ebeccb5fbdbef", "b5bd4f1493a84a4d", "b983711e859b244e", "ba1a5f5391cf4445", "bd205f9d07a336e3", "c028545ab5260a6d", "c41c4c6fd87740ff", "c902542b6b316006", "c96253da97056bb2", "cc6760cea855f7c4", "ce4fd499ef2ba254", "d1f73f98c4336a77", "d9c838c7e6b2e201", "dd1c0ccf9c5d648e", "e144698b607bf895", "e459f8beaa406f75", "e4a61544ef304454", "e4c4c82c79cd59e9", "e735e9a704259baa", "ea487958213c3ac3", "f149e10ecf127e13", "f1f6bc78c4a6e31c", "f6a93c83878a794e", "f9fa69a2f8b09dab", "fce70afa7ee1ca43", "feaa3d2fae940fe0"]);
const NAMES_KANA = new Set(["05164f3c61f87e7b", "08c0652f5c932b65", "0ae41459e099d33b", "16807bcbab2bed39", "2442737afea79cca", "46c3cb063a10b19c", "56b4c30e5c398919", "632668e263ed1ddb", "6a31c8a28f583d8d", "7823a1df56ed22b7", "7a80b18bf58f06a2", "822663d9cb500e7d", "99a59a62ae8fb8dc", "99dbe04ae64ee700", "9cc1f77958ac64d5", "a61f6b2743ebe475", "b3e02ec08e9c38ef", "b60638caf1c54973", "b869e2bb9d7e7c04", "bd0b52af03a6080c", "c29ee163894ceaba", "c3b44877681c47de", "dccc273af0937608", "dd32fd941ba13eb4", "e81215fda3ed1a4d", "ed59d5bbc1dd847a", "efccea3b4f51d341", "f16c1d4e84373c11", "f637a77193e73d5f", "fa03e80372c9d85d", "fa32046585fb86fa"]);
const nameHash = (s) => createHash("sha256").update(NAME_SALT + s).digest("hex").slice(0, 16);
function nameHits(text) {
  const hits = [];
  const words = [...String(text).matchAll(/[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*/g)].map((m) => ({ w: m[0], at: m.index }));
  words.forEach((m, i) => {
    if (NAMES_ASCII.has(nameHash(m.w))) hits.push(`${m.w.slice(0, 2)}…@${m.at}`);
    const next = words[i + 1];
    if (next && next.at === m.at + m.w.length + 1 && NAMES_ASCII.has(nameHash(`${m.w} ${next.w}`))) hits.push(`${m.w.slice(0, 2)}…@${m.at}`);
  });
  for (const m of String(text).matchAll(/[゠-ヿ]+/g)) if (NAMES_KANA.has(nameHash(m[0]))) hits.push(`${m[0].slice(0, 1)}…@${m.index}`);
  return hits;
}
// 共有のヘッダー（ログインの欄の前からの字）とフッターの塊は除く（全ページと同じ写し。scripts/test-site-map.mjs が守る）
const ownText = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  let s = fs.readFileSync(p, "utf8");
  if (rel.endsWith(".html")) s = s.replace(/<header class="site-header">[\s\S]*?<\/header>/, "").replace(/<footer class="site-footer">[\s\S]*?<\/footer>/, "").replace(/<!-- modulepreload:start -->[\s\S]*?<!-- modulepreload:end -->/, "");
  if (rel === "tests/e2e.mjs") {
    const a = s.indexOf("// ===== 92.1 ");
    const b = a >= 0 ? s.indexOf("\n// ===== ", a + 10) : -1;
    s = a >= 0 ? s.slice(a, b > a ? b : undefined) : null;
  }
  return s;
};
const NEW_FILES = ["shortcuts.html", "js/shortcutsData.js", "js/shortcutsCore.js", "js/shortcutsArt.js", "js/shortcutsPage.js", "css/shortcuts.css", "docs/SPEC_SHORTCUTS.md", "tests/e2e.mjs"];
t("9 名前: 新しいページ・js・css・仕様・E2E の 92.1 の節（表と絵の字を含む）に、会社・製品・OS・ブラウザ・言語の名前が無い（見張りの確かめ: 一覧の作り物の語は前後が字でない所だけ当たり・一覧に無い語は当たらない・一覧は 90 以上）", () => {
  const canary = ["Zqx", "name", "canary"].join("");
  const self = [nameHits(`x ${canary} y`).length, nameHits(`${canary}s`).length, nameHits(`a${canary}`).length, nameHits("Ctrl Alt Shift Tab Esc パスワード キーワード ブラウザ パソコン").length];
  if (show(self) !== "[1,0,0,0]" || NAMES_ASCII.size + NAMES_KANA.size < 90) return { self };
  const out = [];
  const missing = [];
  for (const f of NEW_FILES) {
    const s = ownText(f);
    if (s === null) {
      missing.push(f);
      continue;
    }
    for (const h of nameHits(s)) out.push(`${f}: ${h}`);
  }
  const art = [];
  for (const x of ITEMS) for (const l of LAYOUTS) if (keysOf(x, l) && typeof A.scenePairHtml === "function") art.push(A.scenePairHtml(x, l));
  for (const l of LAYOUTS) for (const arr of ["jis", "us"]) if (typeof A.keyboardSvg === "function") art.push(A.keyboardSvg(l, arr));
  for (const h of nameHits(art.join("\n"))) out.push(`絵: ${h}`);
  return (missing.length === 0 && art.length === 103 && out.length === 0) || { missing, art: art.length, out };
});
t("9 名前: コードに機械の値（platform・userAgent）を読む所が無い", () => {
  const bad = ["js/shortcutsData.js", "js/shortcutsCore.js", "js/shortcutsArt.js", "js/shortcutsPage.js"].filter((f) => {
    const s = ownText(f);
    return s === null || /\bplatform\b|userAgent/.test(s);
  });
  return bad.length === 0 || bad;
});
t("9 字: 新しいファイルに見えない字・向きを変える字をそのまま書かない（\\u で書く）", () => {
  const bad = [];
  for (const f of NEW_FILES) {
    const s = ownText(f);
    if (s === null) bad.push(`${f}: 無い`);
    else if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00a0\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(s)) bad.push(f);
  }
  return bad.length === 0 || bad;
});

// ===== 絵（js/shortcutsArt.js）の字の形 =====
t("絵: キーボードの絵 4 種（Ctrl／⌘ × 日本語の並び／英語の並び）・押す組のキーは絵にある・答える前は光らせない（is-target 0）", () => {
  const bad = [];
  for (const l of LAYOUTS) for (const arr of ["jis", "us"]) {
    const svg = A.keyboardSvg(l, arr);
    if (/is-target|is-wrong|is-down/.test(svg)) bad.push(`${l}/${arr}: 光っている`);
    for (const x of ITEMS) {
      const k = keysOf(x, l);
      if (!k) continue;
      for (const caps of k.show) for (const tok of A.tokensOfCaps(caps.map((c) => (c === "1〜8" ? "3" : c)), l)) {
        if (!new RegExp(`data-t="${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(svg)) bad.push(`${l}/${arr} ${x.id}: ${tok}`);
      }
    }
  }
  return bad.length === 0 || [...new Set(bad)].slice(0, 20);
});
t("絵（rich の誤り）: ⌘ の日本語の並びに 半/全・無変換・変換 を描かない（英数・かながある）・Ctrl の日本語の並びには 半/全・無変換・変換・かな がある", () => {
  const labels = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const cj = labels(A.keyboardSvg("cmd", "jis"));
  const kj = labels(A.keyboardSvg("ctrl", "jis"));
  return (!cj.some((s) => ["半/全", "無変換", "変換"].includes(s)) && cj.includes("英数") && cj.includes("かな") && ["半/全", "無変換", "変換", "かな"].every((s) => kj.includes(s))) || { cj, kj };
});
t("絵: 前と後の絵は全部の項目 × キーボードで描ける・字は 9 単位以上（390 の幅で 11px 以上になる大きさ）・「…」で切らない・読み上げは figure に「前: …。後: …。」", () => {
  const bad = [];
  for (const x of ITEMS) for (const l of LAYOUTS) {
    if (!keysOf(x, l)) continue;
    const h = A.scenePairHtml(x, l);
    const sizes = [...h.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
    if (!sizes.length || Math.min(...sizes) < A.SCENE_MIN_FONT || A.SCENE_MIN_FONT < 9) bad.push(`${x.id}@${l} 字 ${Math.min(...sizes)}`);
    if (h.includes("…")) bad.push(`${x.id}@${l} …`);
    if (!h.includes(`aria-label="前: ${x.say[0]}。後: ${x.say[1]}。"`)) bad.push(`${x.id}@${l} 読み上げ`);
    if (!/class="sc-svg[^"]*"[^>]*aria-hidden="true"/.test(h)) bad.push(`${x.id}@${l} svg`);
  }
  return (ITEMS.length === 50 && bad.length === 0) || bad.slice(0, 20);
});
t("絵: 札（kbd）の字は esc する・記号のキーは線（path）で描き、読み上げの名前を添える", () => {
  const h = A.capsHtml(["<b>&", "⌘"]);
  return (h.includes("&lt;b&gt;&amp;") && !h.includes("<b>") && /<kbd[^>]*kc--sym[^>]*><svg[^>]*aria-hidden="true"[^>]*><path[^>]*\/><\/svg><span class="sr-only">コマンド<\/span><\/kbd>/.test(h)) || h;
});

// ===== 10. 保存の鍵の分け方 =====
t("10 鍵: spelldash_shortcuts は人ごと・spelldash_shortcut_device は端末（js/areaGuard.js の DEVICE_NAMES）・バックアップと書き出しに端末の鍵は入らない（js/backup.js EXCLUDE・見張りの EXPORT_EXCLUDE）・端末の記録を消しても残す", () => {
  const guard = fs.readFileSync(path.join(ROOT, "js/areaGuard.js"), "utf8");
  const backup = fs.readFileSync(path.join(ROOT, "js/backup.js"), "utf8");
  const names = (guard.match(/const DEVICE_NAMES = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? "").match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  const exp = (guard.match(/const EXPORT_EXCLUDE = Object\.freeze\(\[([^\]]*)\]\)/)?.[1] ?? "").match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  const exc = (backup.match(/const EXCLUDE = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "").match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  const keep = (backup.match(/const KEEP_ON_CLEAR = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "").match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  return (names.includes("shortcut_device") && !names.includes("shortcuts") && names.length === 24 && exp.includes("spelldash_shortcut_device") && exc.includes("spelldash_shortcut_device")
    && !exc.includes("spelldash_shortcuts") && keep.includes("spelldash_shortcut_device") && !keep.includes("spelldash_shortcuts")) || { n: names.length, exp, exc, keep };
});
const SW = await load("js/areaSwitch.js");
t("10 鍵: ショートカットだけ練習したゲストにも「移す？」を聞く（hasRecords）・端末の鍵だけ・空の記録では聞かない", () => {
  const a = SW.hasRecords?.({ spelldash_shortcuts: JSON.stringify({ v: 1, it: { "pc.copy@ctrl": { s: 2, at: 1, how: "p" } } }) });
  const b = SW.hasRecords?.({ spelldash_shortcut_device: JSON.stringify({ layout: "ctrl" }) });
  const c = SW.hasRecords?.({ spelldash_shortcuts: JSON.stringify({ v: 1, it: {} }) });
  return (a === true && b === false && c === false) || { a, b, c };
});

console.log(`test-shortcuts: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
