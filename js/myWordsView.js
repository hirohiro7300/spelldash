import { getMyWords, addMyWord, addMyWordsBulk, removeMyWord } from "./myWords.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";

// ===== 学習データ: マイ単語帳の管理UI =====

const STATUS_LABEL = { untouched: "未着手", weak: "苦手", learning: "覚えかけ", mastered: "習得" };

export function initializeMyWordsView(onChange = () => {}) {
  const form = document.getElementById("myWordForm");
  const bulkButton = document.getElementById("myWordBulkAdd");
  if (!form) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const en = document.getElementById("myWordEn");
    const ja = document.getElementById("myWordJa");
    const result = addMyWord(en.value, ja.value);
    setStatus(result.ok ? `「${result.en}」を追加しました` : result.error, !result.ok);
    if (result.ok) {
      en.value = "";
      ja.value = "";
      en.focus();
      renderMyWordsList();
      onChange();
    }
  });

  bulkButton?.addEventListener("click", () => {
    const textarea = document.getElementById("myWordBulk");
    const { added, skipped } = addMyWordsBulk(textarea.value);
    const lines = [];
    if (added.length > 0) lines.push(`${added.length}語を追加しました`);
    if (skipped.length > 0) lines.push(`スキップ ${skipped.length}件: ${skipped.slice(0, 3).join(" / ")}${skipped.length > 3 ? " …" : ""}`);
    setStatus(lines.join("　") || "追加する行がありません", added.length === 0);
    if (added.length > 0) {
      textarea.value = "";
      renderMyWordsList();
      onChange();
    }
  });

  document.getElementById("myWordList")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button) return;
    removeMyWord(button.dataset.remove);
    renderMyWordsList();
    onChange();
  });

  renderMyWordsList();
}

function setStatus(text, isError) {
  const el = document.getElementById("myWordStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `muted my-words__status${isError ? " my-words__status--error" : ""}`;
}

export function renderMyWordsList() {
  const container = document.getElementById("myWordList");
  const count = document.getElementById("myWordCount");
  if (!container) return;

  const list = getMyWords().slice().reverse();
  const stats = getWordStats();
  if (count) count.textContent = `${list.length}語`;

  if (list.length === 0) {
    container.innerHTML = `<p class="muted">まだありません。仕事や試験でよく見る単語を入れてみましょう。</p>`;
    return;
  }

  container.innerHTML = list
    .map((w) => {
      const status = classifyWord(stats[`my-${w.en}`]);
      return `
        <div class="my-word">
          <span class="my-word__en">${w.en}</span>
          <span class="my-word__ja">${escapeHtml(w.ja)}</span>
          <span class="my-word__status my-word__status--${status}">${STATUS_LABEL[status]}</span>
          <button type="button" class="my-word__remove" data-remove="${w.en}" aria-label="${w.en} を削除">削除</button>
        </div>`;
    })
    .join("");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
