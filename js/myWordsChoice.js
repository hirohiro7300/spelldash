// ===== マイ単語帳の選択式（Batch 82。docs/SPEC_MY_WORDS.md §12） =====
// 創業者の依頼（2026-11-07）:「up, 〈場面〉。…は上がる？下がる？」のような行を暗記したい。マイ単語帳の学ぶ回（/?learn=my[&book=<id>]。js/game.js）に
// ?choice=en|ja を付けると、打つ代わりに選ぶ。?choice が無い入口（前からのリンク）は打つ回のまま。
// - 向き: en = 訳を見て英語を選ぶ（既定。問いは訳・選択肢は英語。打つ回と同じ向き）／ ja = 英語を見て訳を選ぶ（問いは英語・選択肢は訳）。
//   向きは URL の ?choice= だけに持つ（保存の鍵は足さない）。回の始め（1 問目に答える前）と回の終わりのパネルで替えられる
// - 語の並び・1 回の語数・回の終わりのパネル・3 状態の書き手は打つ回と同じ（js/game.js の同じ回の機械に乗る。語の鍵で記録: 同じ英語の語もその語に）
// - 数え方は打つ回と同じ（創業者の決定「打つ回と同じに数える」）: 選んだ答えは、打つ回の全文入力の答え（答えの英語を打って Enter）と同じ道
//   （js/game.js submitFreeAnswer）を通る。正解 → 打つ回の自力正解（completeWord: 3 状態・別の日に 2 回・学んだ日・連続日数・XP・学習時間・語の記録）、
//   違う → 1 打ミス（× を書いて答えを見せる。自分で次へ）、分からない → 答えを見る（revealAnswer。打つ回の Enter と同じ）。
//   選ぶ回のカードは全文入力の形（free）にする（打鍵を 1 字ずつ見ない）: 打鍵が無いので、速さの見本とよく間違えるキーだけは書かない。画面キーボードも出ない
// - 選択肢: 正解 1 つと、同じ範囲（?book= の単語帳。無ければ全部の単語帳）の違う答え 3 つまで（2〜4 個）。比べる形は英語は打つ回の全文入力の判定と同じ
//   （js/judge.js normalizeAnswer: 大文字小文字・NFKC・空白・ハイフン・アポストロフィを見ない）、訳は NFKC・空白を見ない（全角半角の記号も同じ）。
//   2 つ目の正解は出さない: 英語の選択肢は、問いの訳と同じ訳を持つ語の英語を出さない。訳の選択肢は、問いの英語の語の訳を出さない（同じ英語の語のほかの訳も）。
//   範囲に違う答えが 1 つも無いときだけ、ほかの単語帳 → 組み込みの短い一覧（CHOICE_FILL。この js の定数: 通信しない）で埋める。どこからも作れなければ短い文と打つ回への道
// - 純な部分（buildChoice ほか）は DOM を持たない（scripts/test-my-words.mjs が Node から読む）。画面の部分は mountChoice（js/game.js が選ぶ回の始めに動的 import で読む）

import { isWordEntry, answerKeyOf, displayOf, normJa, entryRefOf } from "./myWordsCore.js";
import { normalizeAnswer, answerMatches } from "./judge.js";

export const CHOICE_PARAM = "choice";
export const CHOICE_EN = "en"; // 訳を見て英語を選ぶ（既定）
export const CHOICE_JA = "ja"; // 英語を見て訳を選ぶ
export const CHOICE_DIRS = Object.freeze({ en: "訳を見て英語を選ぶ", ja: "英語を見て訳を選ぶ" });
export const CHOICE_MAX = 4; // 正解 1 と違う答え 3 つまで
export const CHOICE_MARK = Object.freeze({ right: "正解", wrong: "違う" });

// 組み込みの短い一覧（範囲にもほかの単語帳にも違う答えが無いときだけ使う。通信しない）。ほかの名前を含まない身近な語
export const CHOICE_FILL = Object.freeze(
  [
    ["book", "本"], ["water", "水"], ["window", "窓"], ["chair", "いす"], ["river", "川"], ["morning", "朝"],
    ["paper", "紙"], ["bridge", "橋"], ["garden", "庭"], ["letter", "手紙"], ["mountain", "山"], ["station", "駅"]
  ].map(([en, ja]) => Object.freeze({ en, ja }))
);

// URL の検索部分（文字列か URLSearchParams）→ 向き。?choice が無ければ null（打つ回）。ja 以外の値（空・知らない値）は既定の en
export function choiceDirOf(search) {
  let params;
  try {
    params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search ?? ""));
  } catch {
    return null;
  }
  if (!params.has(CHOICE_PARAM)) return null;
  return String(params.get(CHOICE_PARAM) ?? "").trim() === CHOICE_JA ? CHOICE_JA : CHOICE_EN;
}

const bookPart = (bookId) => (bookId ? `&book=${encodeURIComponent(bookId)}` : "");

// 打つ回の入口（前のまま: /?learn=my・/?learn=my&book=<id>）
export function typedUrl(bookId = null) {
  return `/?learn=my${bookPart(bookId)}`;
}

// 選ぶ回の入口（/?learn=my[&book=<id>]&choice=en|ja）
export function choiceUrl(bookId = null, dir = CHOICE_EN) {
  return `${typedUrl(bookId)}&${CHOICE_PARAM}=${dir === CHOICE_JA ? CHOICE_JA : CHOICE_EN}`;
}

// 比べる形: 英語は打つ回の全文入力の判定と同じ（同じ形なら打つ回でも正解になる）、訳は NFKC（全角半角の英数字・記号）・空白を見ない
export const enKey = (text) => normalizeAnswer(text);
export const jaKey = (text) => normJa(text).replace(/\s+/g, "");

function shuffle(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(Number(rand()) * (i + 1)) || 0);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 決まった乱数（検査で並びを決める。mulberry32）。画面は Math.random
export function seededRandom(seed) {
  let a = Number(seed) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1 問の選択肢（純）。entry = 問いの語（保存の形）、scope = 範囲の語（その単語帳。場面カードを含んでよい）、others = 範囲の外の語（ほかの単語帳）、
// dir = 向き、rand = 乱数、fill = 組み込みの一覧。返り値 { ok, prompt（問いの字）, options: [{ text（画面の字）, en（その選択肢の答えの英語）, correct }], from（違う答えの出どころ） }。
// 作れないときは { ok: false, prompt }
export function buildChoice({ entry, scope = [], others = [], dir = CHOICE_EN, rand = Math.random, fill = CHOICE_FILL, max = CHOICE_MAX } = {}) {
  if (!isWordEntry(entry)) return { ok: false, prompt: "" };
  const toJa = dir === CHOICE_JA;
  const prompt = toJa ? displayOf(entry) : entry.ja;
  const qEn = enKey(answerKeyOf(entry));
  const qJa = jaKey(entry.ja);
  const words = (list) => (Array.isArray(list) ? list : []).filter(isWordEntry);
  const inScope = words(scope);
  const outside = words(others);
  const builtin = (Array.isArray(fill) ? fill : []).filter((f) => f && typeof f.en === "string" && f.en && typeof f.ja === "string" && f.ja).map((f) => ({ en: f.en, ja: f.ja }));
  // 正解にもなる答え（違う答えに出さない）: 英語の選択肢は「問いの訳と同じ訳の語」の英語、訳の選択肢は「問いの英語の語」の訳（どこの語でも）
  const banned = new Set([toJa ? qJa : qEn]);
  for (const w of [...inScope, ...outside, ...builtin]) {
    if (toJa && enKey(answerKeyOf(w)) === qEn) banned.add(jaKey(w.ja));
    if (!toJa && jaKey(w.ja) === qJa) banned.add(enKey(answerKeyOf(w)));
  }
  const optionOf = (w) => (toJa ? { text: w.ja, key: jaKey(w.ja), en: answerKeyOf(w) } : { text: displayOf(w), key: enKey(answerKeyOf(w)), en: answerKeyOf(w) });
  const candidates = (list) => {
    const seen = new Set();
    const out = [];
    for (const w of list) {
      if (toJa && enKey(answerKeyOf(w)) === qEn) continue; // 訳の選択肢は、問いと違う英語の語から
      const o = optionOf(w);
      if (!o.key || banned.has(o.key) || seen.has(o.key)) continue;
      seen.add(o.key);
      out.push(o);
    }
    return out;
  };
  let from = "scope";
  let pool = candidates(inScope);
  if (pool.length === 0) {
    from = "other";
    pool = candidates(outside);
  }
  if (pool.length === 0) {
    from = "builtin";
    pool = candidates(builtin);
  }
  if (pool.length === 0) return { ok: false, prompt };
  const right = optionOf(entry);
  const wrong = shuffle(pool, rand).slice(0, Math.max(1, max - 1));
  const options = shuffle([{ text: right.text, en: right.en, correct: true }, ...wrong.map((o) => ({ text: o.text, en: o.en, correct: false }))], rand);
  return { ok: true, prompt, options, from };
}

// 選んだ選択肢 → 打つ回の全文入力で打った字（js/game.js submitFreeAnswer に渡す）。正解は答えの英語そのもの（打つ回で答えを打って Enter と同じ）。
// 違う答えはその選択肢の英語（違う英語しか選択肢にしないので当たらない）。万一当たる形なら当たらない字 "-"（判定の形では空 = 不正解）
export function typedAsOf(option, card) {
  if (!option || !card) return "-";
  if (option.correct) return String(card.en ?? "");
  const text = String(option.en ?? "");
  return text && !answerMatches(card, text) ? text : "-";
}

// 二重に記録しない守り（1 問に 1 回）。問いごとの印（token = カードの id と出した回の番号）を開き、答え（claim）と「次へ」（next）をそれぞれ 1 回だけ受ける。
// キーの押しっぱなし（keydown の repeat）・2 度目のクリック（click の detail が 2 以上）は repeat として受けない。前の問いの印・閉じた後（回の終わり）・
// 開き直したページ（新しい守り）は受けない
export function createChoiceGuard() {
  let token = null;
  let answered = false;
  let moved = false;
  return {
    open(t) {
      token = t;
      answered = false;
      moved = false;
    },
    close() {
      token = null;
    },
    claim(t, { repeat = false } = {}) {
      if (token === null || t !== token || answered || repeat) return false;
      answered = true;
      return true;
    },
    // 答えが通らなかった（回の側が断った）ときだけ戻す
    release(t) {
      if (token !== null && t === token && !moved) answered = false;
    },
    next(t) {
      if (token === null || t !== token || !answered || moved) return false;
      moved = true;
      return true;
    },
    get token() {
      return token;
    },
    get answered() {
      return answered;
    }
  };
}

// ===== 画面（js/game.js が選ぶ回の始めに呼ぶ） =====
// deps: { dir, bookId, current() → 今のカード（回が動いていなければ null）, entryOf(card) → 保存の語, scope() → 範囲の語, all() → 全部の語,
//         pick(card, typed) → 受けたか（全文入力の答えとして判定）, unknown(card) → 受けたか（答えを見る）, next(card) → 受けたか（打つ回の Enter と同じ） }
// 返り値: { dir, lineFor(ctx, state) → [文, 種類], modeLine(), otherName(), urls() → { again, other, typed }, destroy() }
export function mountChoice(deps) {
  let dir = deps.dir === CHOICE_JA ? CHOICE_JA : CHOICE_EN;
  const otherDir = () => (dir === CHOICE_JA ? CHOICE_EN : CHOICE_JA);
  const guard = createChoiceGuard();
  let built = null;
  let word = null;
  let serial = 0;
  let picked = 0; // この回で答えた数（始めの切り替えは 1 問目に答えるまで）
  let alive = true;

  const el = (tag, cls, text = "") => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  const card = document.getElementById("gameCard");
  const box = el("div", "choice");
  box.id = "choiceBox";
  box.hidden = true;
  const dirLine = el("p", "choice__dir");
  dirLine.id = "choiceDir";
  const dirName = el("span", "choice__dirname");
  const swap = el("button", "choice__switch");
  swap.type = "button";
  swap.id = "choiceSwitch";
  dirLine.append(dirName, swap);
  const opts = el("div", "choice__opts");
  opts.id = "choiceOpts";
  opts.setAttribute("role", "group");
  opts.setAttribute("aria-label", "選択肢");
  opts.tabIndex = -1;
  const none = el("p", "choice__none");
  none.id = "choiceNone";
  none.hidden = true;
  const typedLink = el("a", "", "打って学ぶ");
  typedLink.id = "choiceTyped";
  typedLink.href = typedUrl(deps.bookId);
  none.append(document.createTextNode("この語の選択肢を作れない。"), typedLink);
  const acts = el("div", "choice__acts");
  const skip = el("button", "choice__btn choice__btn--ghost", "分からない");
  skip.type = "button";
  skip.id = "choiceSkip";
  const next = el("button", "choice__btn", "次へ");
  next.type = "button";
  next.id = "choiceNext";
  next.hidden = true;
  acts.append(skip, next);
  const hint = el("p", "choice__hint");
  hint.id = "choiceHint";
  box.append(dirLine, opts, none, acts, hint);
  const anchor = document.getElementById("promptContext");
  if (anchor?.parentNode) anchor.after(box);
  else card?.append(box);
  document.body.classList.add("choice-run");

  // 新しい問いで焦点を選択肢の組へ移してよいか: 焦点がどこにも無い・選ぶ回の箱の中・回のパネル（続けて学ぶ）・見えなくなった要素のとき（メモの欄やナビからは奪わない）
  const focusInBox = () => {
    const active = document.activeElement;
    return !active || active === document.body || box.contains(active) || !!active.closest?.("#resultPanel") || active.getClientRects().length === 0;
  };

  function render({ keepFocus = false } = {}) {
    const current = deps.current();
    if (!alive || !current) return;
    word = current;
    serial++;
    guard.open(`${current.id}#${serial}`);
    const entry = deps.entryOf(current);
    const scope = deps.scope();
    const inScope = new Set((Array.isArray(scope) ? scope : []).map(entryRefOf));
    const others = (deps.all() ?? []).filter((w) => w && !inScope.has(entryRefOf(w)));
    built = buildChoice({ entry, scope, others, dir });
    const q = document.getElementById("japanese");
    if (q && built.prompt) q.textContent = built.prompt;
    const label = document.querySelector("#gameCard .label");
    if (label) label.textContent = dir === CHOICE_JA ? "英語" : "日本語訳";
    const buttons = (built.ok ? built.options : []).map((o, i) => {
      const b = el("button", "choice__opt");
      b.type = "button";
      b.dataset.i = String(i);
      b.setAttribute("aria-pressed", "false");
      const n = el("span", "choice__n", String(i + 1));
      n.setAttribute("aria-hidden", "true");
      b.append(n, el("span", "choice__text", o.text), el("span", "choice__mark"));
      return b;
    });
    opts.replaceChildren(...buttons);
    opts.hidden = !built.ok;
    none.hidden = built.ok;
    skip.hidden = !built.ok;
    next.hidden = true;
    dirLine.hidden = picked > 0;
    dirName.textContent = `${CHOICE_DIRS[dir]}。`;
    swap.textContent = `${CHOICE_DIRS[otherDir()]}に替える`;
    hint.textContent = built.ok ? `数字のキー（1〜${buttons.length}）でも選べる。答えた後は Enter で次へ。` : "";
    hint.hidden = !built.ok;
    box.hidden = false;
    if (!keepFocus && focusInBox()) opts.focus({ preventScroll: true });
  }

  function mark(pickedIndex) {
    [...opts.querySelectorAll(".choice__opt")].forEach((b, i) => {
      const o = built.options[i];
      b.setAttribute("aria-disabled", "true");
      if (o?.correct) {
        b.dataset.state = "right";
        b.querySelector(".choice__mark").textContent = CHOICE_MARK.right;
      } else if (i === pickedIndex) {
        b.dataset.state = "wrong";
        b.querySelector(".choice__mark").textContent = CHOICE_MARK.wrong;
      }
      if (i === pickedIndex) b.setAttribute("aria-pressed", "true");
    });
    picked++;
    skip.hidden = true;
    dirLine.hidden = true;
    next.hidden = false;
    hint.textContent = "Enter か「次へ」で次の問題。";
    next.focus({ preventScroll: true });
  }

  function choose(i, { repeat = false } = {}) {
    const o = built?.ok ? built.options[i] : null;
    const t = guard.token;
    if (!o || !word || !guard.claim(t, { repeat })) return;
    if (!deps.pick(word, typedAsOf(o, word))) {
      guard.release(t);
      return;
    }
    mark(i);
  }

  function giveUp({ repeat = false } = {}) {
    const t = guard.token;
    if (!built?.ok || !word || !guard.claim(t, { repeat })) return;
    if (!deps.unknown(word)) {
      guard.release(t);
      return;
    }
    mark(-1);
  }

  function goNext({ repeat = false } = {}) {
    const t = guard.token;
    if (repeat || !word || !guard.next(t)) return;
    deps.next(word);
  }

  function switchDir() {
    if (picked > 0 || guard.answered) return;
    dir = otherDir();
    try {
      const url = new URL(location.href);
      url.searchParams.set(CHOICE_PARAM, dir);
      history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // 無視（開き直すと前の向き）
    }
    render({ keepFocus: true });
  }

  const onClick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const repeat = event.detail > 1; // ダブルクリックの 2 度目（次の問いのボタンに当たっても答えにしない）
    const opt = target.closest(".choice__opt");
    if (opt && box.contains(opt)) choose(Number(opt.dataset.i), { repeat });
    else if (target.closest("#choiceSkip")) giveUp({ repeat });
    else if (target.closest("#choiceNext")) goNext({ repeat: false });
    else if (target.closest("#choiceSwitch")) switchDir();
  };

  // 開いている窓（<dialog>・aria-modal の札。閉じた札は hidden か inert の中）の中の打鍵は選ぶ回のものではない
  const modalOpen = () => !!document.querySelector("dialog[open]") || [...document.querySelectorAll('[aria-modal="true"]')].some((n) => !n.closest("[hidden], [inert]") && n.getClientRects().length > 0);

  const onKey = (event) => {
    if (!alive || box.hidden || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    // 打鍵は焦点が問いの札（#gameCard）の中か、どこにも無いときだけ（ヘッダーのメニューを Esc で閉じても「分からない」にしない）
    if (target && target !== document.body && target !== document.documentElement && !card?.contains(target)) return;
    if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return; // 覚え方のメモなどを打っている
    if (modalOpen()) return;
    if (/^[1-4]$/.test(event.key)) {
      const i = Number(event.key) - 1;
      if (built?.ok && built.options[i] && !guard.answered) {
        event.preventDefault();
        choose(i, { repeat: event.repeat });
      }
      return;
    }
    if (event.key === "Escape") {
      if (built?.ok && !guard.answered) {
        event.preventDefault();
        giveUp({ repeat: event.repeat });
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      if (event.repeat) {
        event.preventDefault(); // 押しっぱなしの Enter・空白はどのボタンも押さない（選んだ後・次の問いへ流れない）
        return;
      }
      if (!guard.answered) return; // 答える前の Enter・空白は、焦点のあるボタン（選択肢・分からない）だけが受ける
      if (target?.closest("#choiceNext")) return; // 次へ のボタンは自分の押しで進む
      event.preventDefault(); // 選択肢のボタンの上でも、答えた後は次へ
      goNext({ repeat: event.repeat });
    }
  };

  const onWord = () => render();
  const onEnd = () => {
    guard.close();
    box.hidden = true;
  };
  box.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  window.addEventListener("spelldash:word", onWord);
  window.addEventListener("spelldash:game-end", onEnd);

  return {
    get dir() {
      return dir;
    },
    // 答えの後の 1 行（aria-live の #message。js/game.js が保存の成否の後に出す）。ctx = 打つ回の文の種類（clean・miss・reveal）、state = 3 状態の文（null は保存できなかった）
    lineFor(ctx, state) {
      const right = built?.options?.find((o) => o.correct)?.text ?? "";
      if (state === null) return [`保存できませんでした。答えは ${right}`, "revealed"];
      if (ctx === "clean") return [state === "正解" ? `正解。${right}` : `正解。${right}（${state}）`, "correct"];
      if (ctx === "miss") return [`違う。正しい答えは ${right}（${state}）`, "revealed"];
      return [`答えは ${right}（${state}）`, "revealed"];
    },
    modeLine: () => `選択式・${CHOICE_DIRS[dir]}`,
    otherName: () => CHOICE_DIRS[otherDir()],
    urls: () => ({ again: choiceUrl(deps.bookId, dir), other: choiceUrl(deps.bookId, otherDir()), typed: typedUrl(deps.bookId) }),
    destroy() {
      alive = false;
      guard.close();
      box.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("spelldash:word", onWord);
      window.removeEventListener("spelldash:game-end", onEnd);
      box.remove();
      document.body.classList.remove("choice-run");
    }
  };
}
