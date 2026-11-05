// ===== マイ単語帳の画面（mywords.html。Batch 79・81。docs/SPEC_MY_WORDS.md） =====
// 単語帳の切り替え（Batch 81。作る・名前を変える・消す）・1 語ずつ足す・まとめて足す（どちらも今の単語帳へ）・一覧（今の単語帳の語。状態 これから・あやふや・覚えた）・
// 消す（確かめてから）・訳をその場で直す・選んでまとめて消す／移す・「学ぶ」（/?learn=my&book=<id>。js/game.js の学ぶ回。全部の単語帳は /?learn=my）。
// 数はマイ単語帳の中だけ（学習状況の公開の語の数とランクには入らない）。保存と同期の印は js/myWords.js、決まりは js/myWordsCore.js

import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { setupUnloadSync } from "./sync.js";
import {
  getMyWords, addMyWord, addMyWordsBulk, removeMyWord, maxMyWords, limitMessage,
  getMyBooks, createMyBook, renameMyBook, deleteMyBook, removeMyWords, moveMyWords, setMyWordJa
} from "./myWords.js";
import { countMyStates, displayOf, isWordEntry, myStateOf, bookCounts, entriesOfBook, entryRefOf, MY_BOOK_NAME_MAX } from "./myWordsCore.js";
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
const bookName = (books, id) => books.find((b) => b.id === id)?.name ?? "";
const rowByRef = (ref) => [...document.querySelectorAll("#myWordsList .mw-row")].find((li) => li.dataset.ref === ref) ?? null;
const pressedTab = () => document.querySelector('#myBookTabs .mw-book[aria-pressed="true"]');

// 単語帳を替える（選ぶ・訳の直しは終える）。URL の ?book= も替える（開き直し・回の終わりの「マイ単語帳へ」で同じ単語帳）
function setCurrent(id, { focusTab = false } = {}) {
  current = id;
  selecting = false;
  selected.clear();
  editing = null;
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
  const li = el("li", "mw-row");
  li.dataset.ref = ref;
  if (selecting) {
    const pick = el("label", "mw-row__pick");
    const box = el("input", "mw-row__check");
    box.type = "checkbox";
    box.dataset.ref = ref;
    box.checked = selected.has(ref);
    box.setAttribute("aria-label", `${shown} を選ぶ`);
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
    input.setAttribute("aria-label", `${shown} の訳`);
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
    if (word) acts.append(button("mw-row__edit", "直す", `${shown} の訳を直す`));
    const del = button("mw-row__del", "消す", `${shown} を消す`);
    del.dataset.key = w.en;
    del.dataset.kind = w.kind === "concept" ? "concept" : "word";
    del.dataset.label = shown;
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
  if (full) setStatus(limitMessage(), { limit: true });
  else if (statusIsLimit) setStatus("");

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

$("myWordsBulkAdd")?.addEventListener("click", () => {
  const box = $("myWordsBulk");
  const { added, skipped } = addMyWordsBulk(box.value, current);
  const lines = [];
  if (added.length > 0) lines.push(`${added.length}語を足した`);
  if (skipped.length > 0) lines.push(`足せなかった ${skipped.length}行: ${skipped.slice(0, 3).join(" ／ ")}${skipped.length > 3 ? " …" : ""}`);
  if (lines.length === 0) lines.push("1行に「english, 訳」で書く");
  if (added.length > 0 && skipped.length === 0) box.value = "";
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

// 同期で別の端末の語が届いた・消えた（js/userItemsSync.js）・Pro の状態や受付が後から分かった（上限と文）
window.addEventListener("spelldash:mywords", render);
document.addEventListener("spelldash:plan", render);
document.addEventListener("spelldash:billing", render);
// ほかのタブで足した・学んだ語は、このタブを開き直すと出る（storage イベントは聞かない: 聞く所は js/areaGuard.js の一覧どおり。単体 test-areas U1）

render();
