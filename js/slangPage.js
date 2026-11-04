// ===== スラングの画面（slang.html。Batch 80。docs/SPEC_SLANG.md） =====
// 数（グループの範囲の これから・あやふや・覚えた）・「学ぶ」（/?learn=slang。グループで絞ると &group=…）・グループの絞り込み（すべて・日常会話・仕事・ネット。
// URL の ?group= に残す）・一覧（英語・状態・意味・使い方・例文と訳）。組み込みの一覧なので足す・消すは無い。
// 数はスラングの中だけ（学習状況の公開の語の数とランクには入らない）。保存と決まりは js/slang.js

import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { setupUnloadSync } from "./sync.js";
import { LEARN_LABELS } from "./learnState.js";
import { slangEntries, slangStateOf, countSlang, readSlangProgress, parseGroup, GROUP_PARAM } from "./slang.js";

const STATE_KEY = ["new", "unsure", "learned"];
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("ja-JP");

initializeAuth();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();

let group = parseGroup(new URLSearchParams(location.search).get(GROUP_PARAM));

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function rowOf(e) {
  const li = el("li", "sl-row");
  li.dataset.id = e.id;
  li.dataset.group = e.g;
  const st = slangStateOf(e);
  const head = el("div", "sl-row__head");
  const en = el("span", "sl-row__en", e.text);
  en.lang = "en";
  head.append(en, el("span", `sl-row__state mw-row__state mw-row__state--${STATE_KEY[st]}`, LEARN_LABELS[st]));
  const ex = el("p", "sl-row__ex");
  const exEn = el("span", "sl-row__ex-en", e.ex);
  exEn.lang = "en";
  ex.append(exEn, el("span", "sl-row__ex-ja", e.exJa));
  li.append(head, el("p", "sl-row__ja", e.ja), el("p", "sl-row__note", e.note), ex);
  return li;
}

function render() {
  const { map } = readSlangProgress();
  const list = slangEntries(group, map);
  const counts = countSlang(group, map);

  const sum = $("slangSum");
  if (sum) {
    const parts = [el("b", "mw__n", `${fmt(counts.total)}語`)];
    for (const [i, key] of STATE_KEY.entries()) parts.push(el("span", "mw__count", `${LEARN_LABELS[i]} ${fmt(counts[key])}`));
    sum.replaceChildren(...parts);
  }
  const learn = $("slangLearn");
  if (learn) learn.setAttribute("href", group ? `/?learn=slang&${GROUP_PARAM}=${group}` : "/?learn=slang");
  for (const b of document.querySelectorAll("#slangFilter [data-group]")) b.setAttribute("aria-pressed", String(b.dataset.group === group));
  $("slangList")?.replaceChildren(...list.map(rowOf));
}

// 絞り込み: 押したグループだけを出し、URL の ?group= に残す（開き直し・「スラングへ」で同じ形）。焦点は押したボタンのまま
$("slangFilter")?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-group]");
  if (!btn) return;
  group = parseGroup(btn.dataset.group);
  try {
    const url = new URL(location.href);
    if (group) url.searchParams.set(GROUP_PARAM, group);
    else url.searchParams.delete(GROUP_PARAM);
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL を替えられなくても絞り込みは効く
  }
  render();
});

// ほかのタブで学んだ分は、このタブを開き直すと出る（storage イベントは聞かない: 聞く所は js/areaGuard.js の一覧どおり。単体 test-areas U1）
render();
