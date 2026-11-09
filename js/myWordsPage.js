// ===== マイ単語帳の画面（mywords.html。Batch 79・81。docs/SPEC_MY_WORDS.md） =====
// 単語帳の切り替え（Batch 81。作る・名前を変える・消す）・1 語ずつ足す・まとめて足す（どちらも今の単語帳へ）・一覧（今の単語帳の語。状態 これから・あやふや・覚えた）・
// 消す（確かめてから）・訳をその場で直す・選んでまとめて消す／移す・「学ぶ」（/?learn=my&book=<id>。js/game.js の学ぶ回。全部の単語帳は /?learn=my）・
// 「選択式で学ぶ」（Batch 82。/?learn=my[&book=<id>]&choice=en。js/myWordsChoice.js）。
// 単語帳を人に渡す（Batch 84。docs/SPEC_MY_WORDS.md §13）: 「渡す」でリンクと文字をコピー（形は js/myWordsShare.js）、リンク（#share=<code>）を開くと上に渡された単語帳。
// 数はマイ単語帳の中だけ（学習状況の公開の語の数とランクには入らない）。保存と同期の印は js/myWords.js、決まりは js/myWordsCore.js

import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { setupUnloadSync } from "./sync.js";
import { isNativeApp, PRODUCTION_ORIGIN } from "./appEnv.js";
import {
  getMyWords, addMyWord, addMyWordsBulk, removeMyWord, maxMyWords, limitMessage, limitOfferText,
  getMyBooks, createMyBook, renameMyBook, deleteMyBook, removeMyWords, moveMyWords, setMyWordJa, addSharedWords
} from "./myWords.js";
import { countMyStates, displayOf, isWordEntry, myStateOf, bookCounts, entriesOfBook, entryRefOf, answerKeyOf, uniqueBookName, MY_BOOK_NAME_MAX, MY_BOOKS_MAX } from "./myWordsCore.js";
import { SHARE_LONG_LINK, SHARE_MAX_WORDS, bookShare, encodeShare, decodeShare, shareCodeOf, shareLinkOf, shareTextOf } from "./myWordsShare.js";
import { LEARN_LABELS } from "./learnState.js";

const STATE_KEY = ["new", "unsure", "learned"];
const BOOK_PARAM = "book";
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("ja-JP");

initializeAuth();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();

let statusIsLimit = false;
// 今の単語帳（URL の ?book=。無い・知らない id は最初の単語帳）・選ぶの最中か・選んだ語の印（js/myWordsCore.js entryRefOf）・訳を直している語・名前の欄の用途
let current = new URLSearchParams(location.search).get(BOOK_PARAM) ?? "";
let selecting = false;
const selected = new Set();
let editing = null;
let formMode = null; // "new" | "rename" | null

function setStatus(text, { error = false, limit = false } = {}) {
  const el = $("myWordsStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-error", error);
  statusIsLimit = limit;
}

// 上限の文（js/myWords.js limitMessage）。受付中の Web で Pro でない人には、文の中の「Pro なら1,000語」を加入画面へのリンクにする
// （動線の印 mywords。js/funnelLog.js trackProEntries が押されたのを数える）。受付前・アプリ・Pro の人は文だけ（リンクも値段も出さない）
function setLimitStatus() {
  setStatus(limitMessage(), { limit: true });
  const status = $("myWordsStatus");
  if (status) writeWithOffer(status, status.textContent);
}

// node の字を text にし、上限の文の「Pro なら1,000語」があれば加入画面へのリンクにする（上の setLimitStatus と、渡された語を足した結果・上限の案内: Batch 84）。
// リンクにするのは js/myWords.js limitOfferText が許すときだけ（受付中の Web で Pro でない人。受付前・アプリ・Pro の人は字だけ）
function writeWithOffer(node, text) {
  node.textContent = text;
  const offer = limitOfferText();
  const at = offer ? text.indexOf(offer) : -1;
  if (at < 0) return;
  const link = el("a", "", offer);
  link.href = "./pro.html";
  link.dataset.funnel = "mywords";
  node.replaceChildren(text.slice(0, at), link, text.slice(at + offer.length));
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(cls, text, label) {
  const b = el("button", cls, text);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  return b;
}

const shownOf = (w) => (isWordEntry(w) ? displayOf(w) : String(w.answer ?? w.en));

// 同じ英語の語が 2 つ以上ある英語（Batch 82。訳が違えば同じ英語を何度も入れられる）: 行の読み上げの名前と消す前の確かめる窓に訳の頭を添えて、
// どの語かを分ける（画面の英語の字は同じまま。1 つだけの英語は前と同じ名前）
const JA_HEAD = 20;
let sharedEnglish = new Set();
function sharedEnglishOf(list) {
  const seen = new Set();
  const shared = new Set();
  for (const w of list) {
    if (!isWordEntry(w)) continue;
    const key = answerKeyOf(w);
    (seen.has(key) ? shared : seen).add(key);
  }
  return shared;
}
function labelOf(w) {
  const shown = shownOf(w);
  if (!isWordEntry(w) || !sharedEnglish.has(answerKeyOf(w))) return shown;
  const ja = String(w.ja);
  return `${shown}（${ja.length > JA_HEAD ? `${ja.slice(0, JA_HEAD)}…` : ja}）`;
}

const bookName = (books, id) => books.find((b) => b.id === id)?.name ?? "";
const rowByRef = (ref) => [...document.querySelectorAll("#myWordsList .mw-row")].find((li) => li.dataset.ref === ref) ?? null;
const pressedTab = () => document.querySelector('#myBookTabs .mw-book[aria-pressed="true"]');

// 単語帳を替える（選ぶ・訳の直しは終える）。URL の ?book= も替える（開き直し・回の終わりの「マイ単語帳へ」で同じ単語帳）
function setCurrent(id, { focusTab = false } = {}) {
  current = id;
  selecting = false;
  selected.clear();
  editing = null;
  closeGive(); // 渡すのは今の単語帳（替えたら閉じる）
  try {
    const url = new URL(location.href);
    url.searchParams.set(BOOK_PARAM, id);
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // 無視（URL が替わらないだけ）
  }
  render();
  if (focusTab) pressedTab()?.focus();
}

function renderBooks(books, counts) {
  const name = bookName(books, current);
  $("myBookTabs")?.replaceChildren(
    ...books.map((b) => {
      const n = counts[b.id]?.total ?? 0;
      const t = button("sl__tab mw-book", undefined, `${b.name} ${fmt(n)}語`);
      t.dataset.book = b.id;
      t.setAttribute("aria-pressed", b.id === current ? "true" : "false");
      t.append(el("span", "mw-book__name", b.name), el("span", "mw-book__n", fmt(n)));
      return t;
    })
  );
  const del = $("myBookDelete");
  if (del) {
    del.hidden = books.length <= 1; // 最後の 1 冊は消せない
    del.setAttribute("aria-label", `「${name}」を消す`);
  }
  $("myBookRename")?.setAttribute("aria-label", `「${name}」の名前を変える`);
  const give = $("myBookGive");
  if (give) {
    give.hidden = (counts[current]?.total ?? 0) === 0; // 英語の語の無い単語帳は渡さない
    give.setAttribute("aria-label", `「${name}」を渡す`);
  }
}

function renderSelectBar(entries, books) {
  $("myWordsSelect")?.setAttribute("aria-pressed", selecting ? "true" : "false");
  $("myWordsList")?.classList.toggle("is-selecting", selecting);
  const bar = $("myWordsSelBar");
  if (!bar) return;
  bar.hidden = !selecting;
  if (!selecting) return;
  const n = selected.size;
  const all = $("myWordsSelAll");
  all.checked = n > 0 && n === entries.length;
  all.indeterminate = n > 0 && n < entries.length;
  $("myWordsSelN").textContent = `${fmt(n)}語を選んだ`;
  const delBtn = $("myWordsSelDelete");
  delBtn.textContent = `選んだ ${fmt(n)} 語を消す`;
  delBtn.disabled = n === 0;
  const others = books.filter((b) => b.id !== current);
  $("myWordsMove").hidden = others.length === 0;
  const to = $("myWordsMoveTo");
  const keep = to.value;
  to.replaceChildren(...others.map((b) => Object.assign(document.createElement("option"), { value: b.id, textContent: b.name })));
  if (others.some((b) => b.id === keep)) to.value = keep;
  $("myWordsSelMove").disabled = n === 0 || others.length === 0;
}

function rowOf(w) {
  const ref = entryRefOf(w);
  const word = isWordEntry(w);
  const shown = shownOf(w);
  const label = labelOf(w);
  const li = el("li", "mw-row");
  li.dataset.ref = ref;
  if (selecting) {
    const pick = el("label", "mw-row__pick");
    const box = el("input", "mw-row__check");
    box.type = "checkbox";
    box.dataset.ref = ref;
    box.checked = selected.has(ref);
    box.setAttribute("aria-label", `${label} を選ぶ`);
    pick.append(box);
    li.append(pick);
  }
  li.append(el("span", "mw-row__en", shown));
  if (editing === ref && word) {
    // 訳をその場で直す（Enter で保存・Escape でやめる。英語を変えるのは消して足し直す）
    const form = el("form", "mw-row__form");
    form.noValidate = true;
    const input = el("input", "mw-row__input");
    input.type = "text";
    input.maxLength = 200;
    input.value = w.ja;
    input.autocomplete = "off";
    input.setAttribute("aria-label", `${label} の訳`);
    const save = el("button", "mw-row__save", "保存");
    save.type = "submit";
    form.append(input, save, button("mw-row__cancel", "やめる"));
    li.append(form);
  } else {
    li.append(el("span", "mw-row__ja", word ? w.ja : String(w.q ?? "")));
  }
  const state = word ? STATE_KEY[myStateOf(w)] : "scene";
  li.append(el("span", `mw-row__state mw-row__state--${state}`, word ? LEARN_LABELS[myStateOf(w)] : "場面カード"));
  if (!selecting && editing !== ref) {
    const acts = el("span", "mw-row__acts");
    if (word) acts.append(button("mw-row__edit", "直す", `${label} の訳を直す`));
    const del = button("mw-row__del", "消す", `${label} を消す`);
    del.dataset.key = w.en; // 語の鍵（同じ英語の語は鍵が別々: Batch 82）
    del.dataset.kind = w.kind === "concept" ? "concept" : "word";
    del.dataset.label = label;
    acts.append(del);
    li.append(acts);
  }
  return li;
}

function render() {
  const list = getMyWords();
  const books = getMyBooks(list); // 端末の一覧 + ほかの端末の単語帳（語の bookName）
  if (!books.some((b) => b.id === current)) current = books[0].id;
  const counts = bookCounts(list, books);
  const entries = entriesOfBook(list, current, books);
  const mine = counts[current] ?? countMyStates([]);
  const scenes = entries.length - mine.total; // 前の単語帳で作った場面カード（学ぶ回には出さない）
  for (const ref of [...selected]) if (!entries.some((w) => entryRefOf(w) === ref)) selected.delete(ref);
  if (entries.length === 0) selecting = false;
  if (editing && !entries.some((w) => entryRefOf(w) === editing)) editing = null;
  const name = bookName(books, current);
  sharedEnglish = sharedEnglishOf(list);

  renderBooks(books, counts);
  const sum = $("myWordsSum");
  if (sum) {
    const parts = [el("b", "mw__n", `${fmt(mine.total)}語`)];
    if (mine.total > 0) for (const [i, key] of STATE_KEY.entries()) parts.push(el("span", "mw__count", `${LEARN_LABELS[i]} ${fmt(mine[key])}`));
    if (scenes > 0) parts.push(el("span", "mw__count mw__count--scene", `場面カード ${fmt(scenes)}`));
    sum.replaceChildren(...parts);
  }
  const learn = $("myWordsLearn");
  if (learn) {
    learn.hidden = mine.total === 0;
    learn.href = `/?learn=my&${BOOK_PARAM}=${encodeURIComponent(current)}`;
    learn.setAttribute("aria-label", `「${name}」を学ぶ`);
  }
  // 選択式で学ぶ（Batch 82。訳を見て英語を選ぶが既定。向きは回の始めと終わりで替えられる: js/myWordsChoice.js）
  const choice = $("myWordsChoice");
  if (choice) {
    choice.hidden = mine.total === 0;
    choice.href = `/?learn=my&${BOOK_PARAM}=${encodeURIComponent(current)}&choice=en`;
    choice.setAttribute("aria-label", `「${name}」を選択式で学ぶ`);
  }
  const allTotal = countMyStates(list).total;
  const all = $("myWordsAll");
  if (all) {
    all.hidden = books.length <= 1 || allTotal === 0;
    $("myWordsAllN").textContent = `全部の単語帳 ${fmt(allTotal)}語`;
  }
  const to = $("myWordsTo");
  if (to) to.textContent = `足す先は「${name}」。`;
  const empty = $("myWordsEmpty");
  if (empty) empty.hidden = entries.length > 0;

  // 上限（全部の単語帳で 無料 100 語・Pro 1,000 語）: 足すボタンを止めて文を出す。上限を超えて持っている人も見る・消す・移すはできる
  const full = list.length >= maxMyWords();
  for (const id of ["myWordsAddButton", "myWordsBulkAdd"]) {
    const b = $(id);
    if (b) b.disabled = full;
  }
  if (full) setLimitStatus();
  else if (statusIsLimit) setStatus("");
  renderRecv(list, books); // 渡された単語帳（足す先の名前・上限の案内は今の単語帳と語の数で変わる）
  refreshGive(list, books); // 開いている「渡す」の中身（語を足した・消した・同期で届いた）

  const ul = $("myWordsList");
  if (!ul) return;
  const rows = [...entries].reverse().map(rowOf); // 新しく足した語が上
  ul.replaceChildren(...rows);
  ul.hidden = rows.length === 0;
  const head = $("myWordsListHead");
  if (head) head.hidden = rows.length === 0;
  renderSelectBar(entries, books);
}

// ===== 単語帳: 切り替え・作る・名前を変える・消す =====
$("myBookTabs")?.addEventListener("click", (event) => {
  const tab = event.target.closest(".mw-book");
  if (!tab || tab.dataset.book === current) return;
  closeBookForm();
  setCurrent(tab.dataset.book, { focusTab: true });
});

function openBookForm(mode) {
  const form = $("myBookForm");
  if (!form) return;
  formMode = mode;
  const name = bookName(getMyBooks(), current);
  $("myBookFormLabel").textContent = mode === "new" ? `新しい単語帳の名前（${MY_BOOK_NAME_MAX}文字まで）` : `「${name}」の新しい名前`;
  $("myBookSave").textContent = mode === "new" ? "作る" : "名前を変える";
  const input = $("myBookName");
  input.value = mode === "new" ? "" : name;
  form.hidden = false;
  input.focus();
  input.select();
}

function closeBookForm({ focus = false } = {}) {
  const form = $("myBookForm");
  if (!form || form.hidden) return;
  const opener = formMode === "rename" ? $("myBookRename") : $("myBookNew");
  form.hidden = true;
  formMode = null;
  if (focus) opener?.focus();
}

$("myBookNew")?.addEventListener("click", () => openBookForm("new"));
$("myBookRename")?.addEventListener("click", () => openBookForm("rename"));
$("myBookCancel")?.addEventListener("click", () => closeBookForm({ focus: true }));
$("myBookName")?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeBookForm({ focus: true });
});
$("myBookForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("myBookName");
  const r = formMode === "rename" ? renameMyBook(current, input.value) : createMyBook(input.value);
  if (!r.ok) {
    setStatus(r.error, { error: true });
    input.focus();
    return;
  }
  const made = formMode !== "rename";
  closeBookForm();
  setStatus(made ? `単語帳「${r.book.name}」を作った` : `名前を「${r.book.name}」にした`);
  if (made) setCurrent(r.book.id, { focusTab: true });
  else {
    render();
    pressedTab()?.focus();
  }
});

// 単語帳を消す: 確かめる窓で名前と入っている語の数を言う。最後の 1 冊は消せない（ボタンを出さない）
$("myBookDelete")?.addEventListener("click", () => {
  const books = getMyBooks();
  if (books.length <= 1) return;
  const name = bookName(books, current);
  const n = entriesOfBook(getMyWords(), current, books).length;
  if (!window.confirm(`単語帳「${name}」を消す？入っている ${fmt(n)} 語も一緒に消える。`)) return;
  const r = deleteMyBook(current);
  if (!r.ok) {
    setStatus(r.error, { error: true });
    return;
  }
  closeBookForm();
  setStatus(`単語帳「${name}」と ${fmt(r.removed)}語を消した`);
  setCurrent(getMyBooks()[0].id, { focusTab: true });
});

// ===== 足す（今の単語帳へ） =====
$("myWordsAdd")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const en = $("myWordsEn");
  const ja = $("myWordsJa");
  const result = addMyWord(en.value, ja.value, current);
  if (!result.ok) {
    setStatus(result.error, { error: true });
    (/日本語訳/.test(result.error) ? ja : en).focus();
    return;
  }
  en.value = "";
  ja.value = "";
  setStatus(`足した: ${result.en}`);
  render();
  en.focus();
});

// まとめて足す: 足した後の欄には足せなかった行だけを残す（もう一度押しても、足した行をまた断らない。全部足せたら空）。
// 1 行も足せなかったときは欄をそのまま（打った形で直せる）。断った理由は英語と訳の頭でどの行かを言う（js/myWords.js addMyWordsBulk）
$("myWordsBulkAdd")?.addEventListener("click", () => {
  const box = $("myWordsBulk");
  const { added, skipped, rest } = addMyWordsBulk(box.value, current);
  const kept = added.length > 0 && skipped.length > 0;
  const lines = [];
  if (added.length > 0) lines.push(`${added.length}語を足した`);
  if (skipped.length > 0) lines.push(`足せなかった ${skipped.length}行${kept ? "（欄に残した）" : ""}: ${skipped.slice(0, 3).join(" ／ ")}${skipped.length > 3 ? " …" : ""}`);
  if (lines.length === 0) lines.push("1行に「english, 訳」で書く");
  if (added.length > 0) box.value = (rest ?? []).join("\n");
  setStatus(lines.join("。"), { error: added.length === 0 });
  render();
});

// ===== 一覧: 消す（確かめてから）・訳を直す・選ぶ =====
function stopEditing(ref) {
  editing = null;
  render();
  rowByRef(ref)?.querySelector(".mw-row__edit")?.focus();
}

$("myWordsList")?.addEventListener("click", (event) => {
  const edit = event.target.closest(".mw-row__edit");
  if (edit) {
    editing = edit.closest(".mw-row")?.dataset.ref ?? null;
    render();
    const input = rowByRef(editing)?.querySelector(".mw-row__input");
    input?.focus();
    input?.select();
    return;
  }
  if (event.target.closest(".mw-row__cancel")) {
    stopEditing(editing);
    return;
  }
  // 消す: 確かめてから（キーボードでも同じ。消した後の焦点は次の行の「消す」か足す欄）
  const btn = event.target.closest(".mw-row__del");
  if (!btn) return;
  const label = btn.dataset.label;
  if (!window.confirm(`「${label}」をマイ単語帳から消す？`)) return;
  const row = btn.closest("li");
  const nextKey = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector(".mw-row__del")?.dataset.key ?? null;
  removeMyWord(btn.dataset.key, btn.dataset.kind);
  setStatus(`消した: ${label}`);
  render();
  const next = nextKey ? [...document.querySelectorAll("#myWordsList .mw-row__del")].find((b) => b.dataset.key === nextKey) : null;
  (next ?? $("myWordsEn"))?.focus();
});

$("myWordsList")?.addEventListener("submit", (event) => {
  const form = event.target.closest(".mw-row__form");
  if (!form) return;
  event.preventDefault();
  const row = form.closest(".mw-row");
  const ref = row?.dataset.ref ?? "";
  const r = setMyWordJa(ref.replace(/^word:/, ""), form.querySelector(".mw-row__input")?.value ?? "");
  if (!r.ok) {
    setStatus(r.error, { error: true });
    form.querySelector(".mw-row__input")?.focus();
    return;
  }
  setStatus(`訳を直した: ${row?.querySelector(".mw-row__en")?.textContent ?? ""}`);
  stopEditing(ref);
});

$("myWordsList")?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !event.target.closest(".mw-row__input")) return;
  event.preventDefault();
  stopEditing(editing);
});

$("myWordsList")?.addEventListener("change", (event) => {
  const box = event.target.closest(".mw-row__check");
  if (!box) return;
  if (box.checked) selected.add(box.dataset.ref);
  else selected.delete(box.dataset.ref);
  const books = getMyBooks();
  renderSelectBar(entriesOfBook(getMyWords(), current, books), books);
});

function setSelecting(on) {
  selecting = on;
  selected.clear();
  editing = null;
  render();
  (selecting ? $("myWordsSelAll") : $("myWordsSelect"))?.focus();
}

$("myWordsSelect")?.addEventListener("click", () => setSelecting(!selecting));
$("myWordsSelDone")?.addEventListener("click", () => setSelecting(false));

$("myWordsSelAll")?.addEventListener("change", (event) => {
  selected.clear();
  if (event.target.checked) for (const w of entriesOfBook(getMyWords(), current, getMyBooks())) selected.add(entryRefOf(w));
  render();
});

// 選んだ語を消す: 確かめる窓は 1 つで数を言う。消すのは 1 回の書き込み（js/myWords.js removeMyWords）
$("myWordsSelDelete")?.addEventListener("click", () => {
  const n = selected.size;
  if (n === 0 || !window.confirm(`選んだ ${fmt(n)} 語を消す？`)) return;
  const r = removeMyWords([...selected]);
  if (!r.ok) {
    setStatus(r.error, { error: true });
    return;
  }
  selected.clear();
  setStatus(`${fmt(r.removed)}語を消した`);
  render();
  (selecting ? $("myWordsSelAll") : $("myWordsEn"))?.focus();
});

// 選んだ語をほかの単語帳へ移す（3 状態は残す。1 回の書き込み）
$("myWordsSelMove")?.addEventListener("click", () => {
  const to = $("myWordsMoveTo")?.value;
  if (!to || selected.size === 0) return;
  const r = moveMyWords([...selected], to);
  if (!r.ok) {
    setStatus(r.error, { error: true });
    return;
  }
  selected.clear();
  setStatus(`${fmt(r.moved)}語を「${bookName(getMyBooks(), to)}」へ移した`);
  render();
  (selecting ? $("myWordsSelAll") : $("myWordsEn"))?.focus();
});

// ===== 渡す（Batch 84。docs/SPEC_MY_WORDS.md §13）: 今の単語帳のリンク（#share=<code>）と文字（まとめて足すの形）をコピーする =====
// 中身は単語帳の名前と英語（画面の形）と訳だけ（js/myWordsShare.js bookShare）。リンクの origin は Web なら今の origin、アプリなら本番（js/appEnv.js）。
// コピーは押した操作の中で最初に呼ぶ（リンクは開いたときに作っておく）。コピーできないときは欄に出して選んでもらう
let give = null; // 開いている「渡す」の中身 { bookId, link, text, count }
let giveSeq = 0;
const shareOrigin = () => (isNativeApp ? PRODUCTION_ORIGIN : location.origin);

function setGiveStatus(text, { error = false } = {}) {
  const s = $("myGiveStatus");
  if (!s) return;
  s.textContent = text;
  s.classList.toggle("is-error", error);
}

// 開く（focus: 開いた後に焦点を最初のボタンへ）。開いている間に語が変わったら焦点を動かさずに作り直す（refreshGive）
async function openGive({ focus = true } = {}) {
  const list = getMyWords();
  const books = getMyBooks(list);
  const bookId = books.some((b) => b.id === current) ? current : books[0].id;
  const share = bookShare(list, bookId, books);
  if (share.words.length === 0) {
    closeGive();
    return;
  }
  const seq = ++giveSeq;
  const enc = share.over ? null : await encodeShare(share);
  if (seq !== giveSeq) return; // 作っている間に閉じた・開き直した
  const link = enc?.fits ? shareLinkOf(shareOrigin(), enc.code) : null;
  const text = shareTextOf(share.words);
  give = { bookId, link, text, count: share.words.length };
  $("myGiveTitle").textContent = `「${share.name}」を渡す`;
  $("myGiveLead").textContent = `${fmt(share.words.length)}語。リンクを開いた人は、自分のマイ単語帳に足せる。文字は相手の「まとめて足す」に貼ると同じ語になる。`;
  const notes = [];
  if (share.scenes) notes.push(`場面カード ${fmt(share.scenes)}枚は入れない。`);
  if (share.invalid) notes.push(`今の決まりに合わない ${fmt(share.invalid)}語は入れない。`);
  if (share.over) notes.push(`${fmt(SHARE_MAX_WORDS)}語より多いので、リンクにはできない。「文字をコピー」で渡す。`);
  else if (!link) notes.push("リンクにするには長すぎる。「文字をコピー」で渡す。");
  else if (link.length > SHARE_LONG_LINK) notes.push(`リンクが長い（${fmt(link.length)}字）。チャットやメールによっては途中で切れる。そのときは「文字をコピー」で渡す。`);
  const note = $("myGiveNote");
  note.textContent = notes.join("");
  note.hidden = notes.length === 0;
  $("myGiveLink").disabled = !link;
  $("myGiveShare").hidden = typeof navigator.share !== "function";
  const panel = $("myGive");
  const opening = panel.hidden;
  panel.hidden = false;
  $("myBookGive")?.setAttribute("aria-expanded", "true");
  if (opening) setGiveStatus("");
  if (focus) (link ? $("myGiveLink") : $("myGiveText"))?.focus();
}

function closeGive({ focus = false } = {}) {
  giveSeq++;
  give = null;
  const panel = $("myGive");
  const wasOpen = !!panel && !panel.hidden;
  if (panel) panel.hidden = true;
  $("myBookGive")?.setAttribute("aria-expanded", "false");
  const box = $("myGiveCopyBox");
  if (box) box.hidden = true;
  const area = $("myGiveCopy");
  if (area) area.value = "";
  setGiveStatus("");
  if (focus && wasOpen) $("myBookGive")?.focus();
}

// 開いている「渡す」を今の語で作り直す（焦点は動かさない）。中身が同じなら何もしない
function refreshGive(list, books) {
  const panel = $("myGive");
  if (!give || !panel || panel.hidden) return;
  if (give.bookId !== current) {
    closeGive();
    return;
  }
  if (shareTextOf(bookShare(list, current, books).words) !== give.text) openGive({ focus: false });
}

async function copyGive(kind, button) {
  if (!give) return;
  const value = kind === "link" ? give.link : give.text;
  if (!value) return;
  const done = kind === "link" ? "リンクをコピーした。チャットやメールに貼って渡す。" : `文字をコピーした（${fmt(give.count)}行）。相手は「まとめて足す」に貼る。`;
  const box = $("myGiveCopyBox");
  const area = $("myGiveCopy");
  try {
    await navigator.clipboard.writeText(value);
    box.hidden = true;
    area.value = "";
    setGiveStatus(done);
    return;
  } catch {
    // 下の欄に出して写す
  }
  box.hidden = false;
  area.value = value;
  area.focus();
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  if (copied) {
    box.hidden = true;
    area.value = "";
    setGiveStatus(done);
    button?.focus();
  } else {
    setGiveStatus("コピーできなかった。下の欄の字を選んでコピーする。", { error: true });
  }
}

$("myBookGive")?.addEventListener("click", () => {
  if ($("myGive")?.hidden === false) closeGive({ focus: true });
  else openGive();
});
$("myGiveClose")?.addEventListener("click", () => closeGive({ focus: true }));
$("myGive")?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeGive({ focus: true });
});
$("myGiveLink")?.addEventListener("click", (event) => copyGive("link", event.currentTarget));
$("myGiveText")?.addEventListener("click", (event) => copyGive("text", event.currentTarget));
// 端末の共有の画面（navigator.share があるときだけボタンを出す。ネイティブのプラグインは足していない）。リンクにできないときは文字を渡す
$("myGiveShare")?.addEventListener("click", async () => {
  if (!give || typeof navigator.share !== "function") return;
  const title = $("myGiveTitle")?.textContent ?? "単語帳を渡す";
  const data = give.link ? { title, text: $("myGiveLead")?.textContent ?? "", url: give.link } : { title, text: give.text };
  try {
    await navigator.share(data);
    setGiveStatus("共有した。");
  } catch (error) {
    if (error?.name === "AbortError") setGiveStatus("");
    else setGiveStatus("共有できなかった。リンクか文字をコピーして渡す。", { error: true });
  }
});

// ===== 渡された単語帳（Batch 84）: mywords.html#share=<code> を開くと上に出す =====
// 名前・語の数・最初の 5 語（字だけ）と、新しい単語帳として足す（既定。名前は今の単語帳と重ねない）・今の単語帳に足す・やめる。
// 足すのは 1 語ずつ足すと同じ決まり（js/myWords.js addSharedWords）。足した後とやめた後は # を外す（読み直しても、もう聞かない）。
// 読めないリンクは 1 行だけ（このリンクは読めません）。ゲストもログインした人も、今の人の領域に足す
const RECV_ROWS = 5;
let recv = null; // 読めた中身 { name, words }
let recvSeq = 0;
let recvTimer = 0;

function setRecvStatus(text, { error = false, offer = false, later = false } = {}) {
  const s = $("myRecvStatus");
  if (!s) return;
  clearTimeout(recvTimer);
  s.classList.toggle("is-error", error);
  const write = () => (offer ? writeWithOffer(s, text) : (s.textContent = text));
  if (!later) {
    write();
    return;
  }
  s.textContent = ""; // 出したばかりの読み上げの行は、空にしてから書く（読み上げが拾う）
  recvTimer = setTimeout(write, 40);
}

// # を外す（足した後とやめた後）。足した先の単語帳があれば ?book= もその単語帳に
function dropShareHash(bookId = null) {
  try {
    const url = new URL(location.href);
    url.hash = "";
    if (bookId) url.searchParams.set(BOOK_PARAM, bookId);
    history.replaceState(history.state, "", `${url.pathname}${url.search}`);
  } catch {
    // 外せなくても読み直しで同じ問いが出るだけ
  }
}

// 区切り（行の部品の出し入れ）。mode: "ask"（問い）・"done"（足した後）・"bad"（読めない: 1 行だけ）
function recvParts(mode) {
  const ask = mode === "ask";
  for (const id of ["myRecvSum", "myRecvRows", "myRecvHint", "myRecvNew", "myRecvHere", "myRecvCancel"]) {
    const node = $(id);
    if (node) node.hidden = !ask;
  }
  if (!ask) $("myRecvMore").hidden = true;
  $("myRecvTitle").hidden = mode === "bad";
  $("myRecvActs").hidden = mode === "bad";
  $("myRecvClose").hidden = mode !== "done";
}

async function readShareLink() {
  const code = shareCodeOf(location.hash);
  if (code === null) return;
  const seq = ++recvSeq;
  recv = null;
  const r = await decodeShare(code);
  if (seq !== recvSeq) return;
  const box = $("myRecv");
  if (!box) return;
  if (!r.ok) {
    recvParts("bad");
    box.hidden = false;
    setRecvStatus(r.reason === "unsupported" ? "このブラウザではこのリンクを読めません" : "このリンクは読めません", { later: true });
    return;
  }
  recv = { name: r.name, words: r.words };
  setRecvStatus("");
  recvParts("ask");
  box.hidden = false;
  renderRecv();
  $("myRecvTitle")?.focus();
}

// 問いの中身（render からも呼ぶ: 今の単語帳の名前・上限までの数・単語帳の数）
function renderRecv(list = getMyWords(), books = getMyBooks(list)) {
  if (!recv || $("myRecv")?.hidden !== false) return;
  const n = recv.words.length;
  $("myRecvSum").textContent = `「${recv.name}」 ${fmt(n)}語`;
  $("myRecvRows").replaceChildren(
    ...recv.words.slice(0, RECV_ROWS).map((w) => {
      const li = el("li", "mw-recv__row");
      li.append(el("span", "mw-recv__en", w.en), el("span", "mw-recv__ja", w.ja));
      return li;
    })
  );
  const more = $("myRecvMore");
  more.hidden = n <= RECV_ROWS;
  more.textContent = n > RECV_ROWS ? `ほか ${fmt(n - RECV_ROWS)}語` : "";
  const here = books.find((b) => b.id === current) ?? books[0];
  const newName = uniqueBookName(recv.name, books);
  const room = maxMyWords() - list.length;
  const canNew = books.length < MY_BOOKS_MAX && !!newName;
  const hint = [canNew ? `新しい単語帳の名前は「${newName}」。今の単語帳は「${here.name}」。` : `単語帳は${fmt(MY_BOOKS_MAX)}冊まで。今の単語帳「${here.name}」には足せる。`];
  if (room <= 0) hint.push(endSentence(limitMessage()));
  else if (room < n) hint.push(`上限まであと ${fmt(room)}語。`);
  writeWithOffer($("myRecvHint"), hint.join(""));
  const add = $("myRecvNew");
  add.disabled = !canNew || room <= 0;
  add.setAttribute("aria-label", canNew ? `新しい単語帳「${newName}」として足す` : "新しい単語帳として足す");
  const put = $("myRecvHere");
  put.disabled = room <= 0;
  put.setAttribute("aria-label", `今の単語帳「${here.name}」に足す`);
}

const endSentence = (text) => (/[。．.]$/.test(text) ? text : `${text}。`);

function addRecv(toNew) {
  if (!recv) return;
  const asked = recv;
  recv = null; // 足している間の描き直し（語の保存が spelldash:mywords を投げる）で問いを描き直さない
  const r = addSharedWords(asked.words, toNew ? { name: asked.name } : { book: current });
  if (!r.ok) {
    recv = asked;
    renderRecv();
    setRecvStatus(r.error, { error: true });
    return;
  }
  const parts = [];
  if (r.added.length > 0) parts.push(r.created ? `${fmt(r.added.length)}語を新しい単語帳「${r.book.name}」に足した。` : `${fmt(r.added.length)}語を「${r.book.name}」に足した。`);
  else parts.push("足せた語は無い。");
  if (r.skipped.length > 0) parts.push(`足せなかった ${fmt(r.skipped.length)}語: ${r.skipped.slice(0, 3).join(" ／ ")}${r.skipped.length > 3 ? " …" : ""}。`);
  if (r.limited > 0) parts.push(`上限で足せなかった ${fmt(r.limited)}語。${endSentence(limitMessage())}`);
  recvSeq++;
  dropShareHash(r.book?.id ?? null);
  if (r.book) current = r.book.id;
  selecting = false;
  selected.clear();
  editing = null;
  render();
  recvParts("done");
  setRecvStatus(parts.join(""), { error: r.added.length === 0, offer: true });
  $("myRecvClose")?.focus();
}

$("myRecvNew")?.addEventListener("click", () => addRecv(true));
$("myRecvHere")?.addEventListener("click", () => addRecv(false));
$("myRecvCancel")?.addEventListener("click", () => {
  recv = null;
  recvSeq++;
  dropShareHash();
  $("myRecv").hidden = true;
  setRecvStatus("");
  pressedTab()?.focus();
});
$("myRecvClose")?.addEventListener("click", () => {
  $("myRecv").hidden = true;
  setRecvStatus("");
  pressedTab()?.focus();
});
// 開いたままのページで別のリンク（# だけが違う）を開いた
window.addEventListener("hashchange", () => {
  if (shareCodeOf(location.hash) !== null) readShareLink();
});

// 同期で別の端末の語が届いた・消えた（js/userItemsSync.js）・Pro の状態や受付が後から分かった（上限と文）
window.addEventListener("spelldash:mywords", render);
document.addEventListener("spelldash:plan", render);
document.addEventListener("spelldash:billing", render);
// ほかのタブで足した・学んだ語は、このタブを開き直すと出る（storage イベントは聞かない: 聞く所は js/areaGuard.js の一覧どおり。単体 test-areas U1）

render();
readShareLink();
