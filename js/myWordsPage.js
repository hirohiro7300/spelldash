// ===== マイ単語帳の画面（mywords.html。Batch 79。docs/SPEC_MY_WORDS.md） =====
// 1 語ずつ足す・まとめて足す・一覧（語ごとの状態 これから・あやふや・覚えた）・消す（確かめてから）・「学ぶ」（/?learn=my。js/game.js の学ぶ回）。
// 数はマイ単語帳の中だけ（学習状況の公開の語の数とランクには入らない）。保存と同期の印は js/myWords.js、決まりは js/myWordsCore.js

import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { setupUnloadSync } from "./sync.js";
import { getMyWords, addMyWord, addMyWordsBulk, removeMyWord, maxMyWords, limitMessage } from "./myWords.js";
import { countMyStates, displayOf, isWordEntry, myStateOf } from "./myWordsCore.js";
import { LEARN_LABELS } from "./learnState.js";

const STATE_KEY = ["new", "unsure", "learned"];
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("ja-JP");

initializeAuth();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();

let statusIsLimit = false;

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

function render() {
  const list = getMyWords();
  const counts = countMyStates(list);
  const scenes = list.length - counts.total; // 前の単語帳で作った場面カード（学ぶ回には出さない）

  const sum = $("myWordsSum");
  if (sum) {
    const parts = [el("b", "mw__n", `${fmt(counts.total)}語`)];
    if (counts.total > 0) for (const [i, key] of STATE_KEY.entries()) parts.push(el("span", "mw__count", `${LEARN_LABELS[i]} ${fmt(counts[key])}`));
    sum.replaceChildren(...parts);
  }
  const learn = $("myWordsLearn");
  if (learn) learn.hidden = counts.total === 0;
  const empty = $("myWordsEmpty");
  if (empty) empty.hidden = list.length > 0;

  // 上限（無料 100 語・Pro 1,000 語）: 足すボタンを止めて文を出す。上限を超えて持っている人も見る・消すはできる
  const full = list.length >= maxMyWords();
  for (const id of ["myWordsAddButton", "myWordsBulkAdd"]) {
    const b = $(id);
    if (b) b.disabled = full;
  }
  if (full) setStatus(limitMessage(), { limit: true });
  else if (statusIsLimit) setStatus("");

  const ul = $("myWordsList");
  if (!ul) return;
  const rows = list
    .map((w, i) => ({ w, i }))
    .reverse() // 新しく足した語が上
    .map(({ w }) => {
      const li = el("li", "mw-row");
      const word = isWordEntry(w);
      const shown = word ? displayOf(w) : String(w.answer ?? w.en);
      li.append(el("span", "mw-row__en", shown), el("span", "mw-row__ja", word ? w.ja : String(w.q ?? "")));
      const state = word ? STATE_KEY[myStateOf(w)] : "scene";
      li.append(el("span", `mw-row__state mw-row__state--${state}`, word ? LEARN_LABELS[myStateOf(w)] : "場面カード"));
      const del = el("button", "mw-row__del", "消す");
      del.type = "button";
      del.dataset.key = w.en;
      del.dataset.kind = w.kind === "concept" ? "concept" : "word";
      del.dataset.label = shown;
      del.setAttribute("aria-label", `${shown} を消す`);
      li.append(del);
      return li;
    });
  ul.replaceChildren(...rows);
  ul.hidden = rows.length === 0;
  const title = $("myWordsListTitle");
  if (title) title.hidden = rows.length === 0;
  if (scenes > 0 && sum) sum.append(el("span", "mw__count mw__count--scene", `場面カード ${fmt(scenes)}`));
}

$("myWordsAdd")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const en = $("myWordsEn");
  const ja = $("myWordsJa");
  const result = addMyWord(en.value, ja.value);
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
  const { added, skipped } = addMyWordsBulk(box.value);
  const lines = [];
  if (added.length > 0) lines.push(`${added.length}語を足した`);
  if (skipped.length > 0) lines.push(`足せなかった ${skipped.length}行: ${skipped.slice(0, 3).join(" ／ ")}${skipped.length > 3 ? " …" : ""}`);
  if (lines.length === 0) lines.push("1行に「english, 訳」で書く");
  if (added.length > 0 && skipped.length === 0) box.value = "";
  setStatus(lines.join("。"), { error: added.length === 0 });
  render();
});

// 消す: 確かめてから（キーボードでも同じ。消した後の焦点は次の行の「消す」か一覧の見出し）
$("myWordsList")?.addEventListener("click", (event) => {
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

// 同期で別の端末の語が届いた・消えた（js/userItemsSync.js）・Pro の状態や受付が後から分かった（上限と文）
window.addEventListener("spelldash:mywords", render);
document.addEventListener("spelldash:plan", render);
document.addEventListener("spelldash:billing", render);
// ほかのタブで足した・学んだ語は、このタブを開き直すと出る（storage イベントは聞かない: 聞く所は js/areaGuard.js の一覧どおり。単体 test-areas U1）

render();
