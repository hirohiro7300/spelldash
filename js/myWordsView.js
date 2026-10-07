import { getMyWords, addMyWord, addMyConcept, addMyWordsBulk, removeMyWord, maxMyWords, limitMessage } from "./myWords.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";
import { initializeCardGen } from "./cardGen.js";
import { icon } from "./icons.js";

// ===== 学習データ: マイ単語帳の管理UI =====

const STATUS_LABEL = { untouched: "未着手", weak: "苦手", learning: "覚えた", mastered: "習得" };

export function initializeMyWordsView(onChange = () => {}) {
  document.addEventListener("spelldash:plan", renderLimitState); // Pro の状態が後から届いたら上限（100 → 1,000）を引き直す
  document.addEventListener("spelldash:billing", renderLimitState); // 受付中かが分かったら「Pro なら…」を付け直す
  const form = document.getElementById("myWordForm");
  const bulkButton = document.getElementById("myWordBulkAdd");
  if (!form) return;
  window.addEventListener("spelldash:mywords", renderMyWordsList); // 同期で別の端末の語が届いた・消えたら一覧と上限を描き直す

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const en = document.getElementById("myWordEn");
    const ja = document.getElementById("myWordJa");
    const result = addMyWord(en.value, ja.value);
    setStatus(result.ok ? `追加済み: ${result.en}` : result.error, !result.ok);
    if (result.ok) {
      en.value = "";
      ja.value = "";
      en.focus();
      renderMyWordsList();
      onChange();
    }
  });

  // 場面カード（意味→用語）: 自分の教材を意味ベースで入れる
  const conceptForm = document.getElementById("myConceptForm");
  conceptForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const q = document.getElementById("myConceptQ");
    const answer = document.getElementById("myConceptAnswer");
    const explain = document.getElementById("myConceptExplain");
    const accept = document.getElementById("myConceptAccept");
    const result = addMyConcept({ q: q.value, answer: answer.value, explain: explain.value, accept: accept.value });
    setStatus(result.ok ? `追加済み: ${result.en}` : result.error, !result.ok);
    if (result.ok) {
      q.value = "";
      answer.value = "";
      explain.value = "";
      accept.value = "";
      q.focus();
      renderMyWordsList();
      onChange();
    }
  });

  // 「英単語 / 場面カード / テキストから作る」の切替
  const panels = { word: "myWordForm", concept: "myConceptForm", ai: "myCardGen" };
  document.querySelectorAll("[data-my-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const kind = tab.dataset.myTab;
      document.querySelectorAll("[data-my-tab]").forEach((t) => {
        t.classList.toggle("my-tab--active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      for (const [key, id] of Object.entries(panels)) {
        const panel = document.getElementById(id);
        if (panel) panel.hidden = key !== kind;
      }
    });
  });
  initializeCardGen(() => {
    renderMyWordsList();
    onChange();
  });

  bulkButton?.addEventListener("click", () => {
    const textarea = document.getElementById("myWordBulk");
    const { added, skipped } = addMyWordsBulk(textarea.value);
    const lines = [];
    if (added.length > 0) lines.push(`${added.length}語を追加した`);
    if (skipped.length > 0) lines.push(`スキップ ${skipped.length}件: ${skipped.slice(0, 3).join(" / ")}${skipped.length > 3 ? " …" : ""}`);
    setStatus(lines.join("　") || "追加する行が無い", added.length === 0);
    if (added.length > 0) {
      textarea.value = "";
      renderMyWordsList();
      onChange();
    } else {
      renderLimitState(); // 上限で 1 語も入らなかったときは、理由（上限の文）を出し直す
    }
  });

  document.getElementById("myWordList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button) return;
    removeMyWord(button.dataset.remove, button.dataset.removeKind);
    renderMyWordsList();
    onChange();
  });

  renderMyWordsList();
}

function setStatus(text, isError) {
  const el = document.getElementById("myWordStatus");
  if (!el) return;
  const limit = text.endsWith(limitMessage()); // 直前の結果（「追加済み: …」）を前に残して上限の文を続けることがある
  el.textContent = text;
  // 上限の案内（「Pro なら」を含む固定文）にだけ Pro へのリンクを「。」の直後に続ける。ユーザー入力は innerHTML に入れない
  if (limit && text.includes("Pro なら")) {
    const link = document.createElement("a");
    link.href = "./pro.html";
    link.dataset.funnel = "mywords";
    link.className = "pro-link";
    link.textContent = "Pro について";
    el.append(link);
  }
  // 上限は仕様で失敗ではないので朱にしない（通常の色のまま）
  el.className = `muted my-words__status${isError && !limit ? " my-words__status--error" : ""}`;
  el.dataset.limit = limit ? "1" : "";
}

// 上限（maxMyWords 以上）: 「追加する」を disabled にし、上限の文を入力欄の直前（フォームの上）に出す。
// 入力した語は消さない（Pro にした直後にそのまま押せる）。上限を下回ったら元の位置（一覧の上）に戻す
function renderLimitState() {
  const el = document.getElementById("myWordStatus");
  const form = document.getElementById("myWordForm");
  const list = document.getElementById("myWordList");
  if (!el || !form) return;
  const atLimit = getMyWords().length >= maxMyWords();
  for (const button of document.querySelectorAll("#myWordForm button[type=submit], #myConceptForm button[type=submit]")) {
    button.disabled = atLimit;
  }
  if (atLimit) {
    // いま出ている結果（追加済み・まとめて追加の内訳）は消さず、その後ろに上限の文を続ける
    const prev = el.dataset.limit === "1" ? "" : el.textContent.trim();
    setStatus(prev ? `${prev}　${limitMessage()}` : limitMessage(), false);
    el.classList.add("my-words__status--limit");
    if (el.nextElementSibling !== form) form.before(el);
  } else {
    el.classList.remove("my-words__status--limit");
    if (el.dataset.limit === "1") setStatus("", false);
    if (list && el.nextElementSibling !== list) list.before(el);
  }
}

const MY_WORDS_FIRST = 50;
let showAllMyWords = false;
let listBelow = false; // 下の単語帳がマイ単語帳を出している（js/listView.js）: ここでは一覧を描かず、下を指す
let listBelowFiltered = false; // 下は検索・状態で絞り込んでいる（全部は出ていない）

// 下の単語帳がマイ単語帳を出しているか（同じ語を 2 回並べない）。filtered: 下を絞り込んでいる
export function setMyWordsListBelow(value, { filtered = false } = {}) {
  if (listBelow === Boolean(value) && listBelowFiltered === Boolean(filtered)) return;
  listBelow = Boolean(value);
  listBelowFiltered = Boolean(filtered);
  renderMyWordsList();
}

export function renderMyWordsList() {
  const container = document.getElementById("myWordList");
  const count = document.getElementById("myWordCount");
  if (!container) return;

  const list = getMyWords().slice().reverse();
  const stats = getWordStats();
  if (count) count.textContent = `${list.length.toLocaleString("ja-JP")}語`;
  renderLimitState();

  if (list.length === 0) {
    container.innerHTML = `<p class="muted">まだ無い。仕事や試験でよく見る語から</p>`;
    return;
  }
  if (listBelow) {
    container.innerHTML = `<p class="muted my-words__below">追加した ${list.length.toLocaleString("ja-JP")}語は下の一覧に${listBelowFiltered ? "（いまは絞り込み中。検索と「すべて」で全部出る）" : ""}。消すときは語の右の ×</p>`;
    return;
  }

  // 1 行＝1 語: 用語（太字）・意味 ・ 状態、右端に削除（40×40 のアイコン）。解説や別解は下の一覧（.gcard）に出る。
  // 多い人（Pro は 1,000 語まで）は新しい 50 語だけ描き、「すべて表示」で残りを出す（下の単語帳まで何万 px も送らせない）
  const shown = showAllMyWords || list.length <= MY_WORDS_FIRST ? list : list.slice(0, MY_WORDS_FIRST);
  container.innerHTML = shown
    .map((w) => {
      const concept = w.kind === "concept";
      const status = classifyWord(stats[concept ? `my-q-${w.en}` : `my-${w.en}`]);
      const label = concept ? w.answer : w.en;
      return `
        <div class="my-word${concept ? " my-word--concept" : ""}">
          <span class="my-word__text"><b class="my-word__en${concept ? "" : " mono"}">${escapeHtml(label)}</b> <span class="my-word__ja">${escapeHtml(concept ? w.q : w.ja)}</span> ・ <span class="my-word__status my-word__status--${status}">${STATUS_LABEL[status]}</span></span>
          <button type="button" class="my-word__remove" data-remove="${escapeHtml(w.en)}" data-remove-kind="${concept ? "concept" : "word"}" aria-label="${escapeHtml(label)} を削除" title="削除">${icon("x", { size: 16 })}</button>
        </div>`;
    })
    .join("") +
    (shown.length < list.length
      ? `<button type="button" class="btn btn--sm btn--ghost my-words__more" id="myWordMore">すべて表示（${list.length.toLocaleString("ja-JP")}語）</button>`
      : "");
  container.querySelector("#myWordMore")?.addEventListener("click", () => {
    showAllMyWords = true;
    renderMyWordsList();
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
