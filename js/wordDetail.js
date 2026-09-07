import { findWord, getCategories } from "./wordStore.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";
import { historyDotsHtml } from "./learnedWords.js";
import { getNote, setNote, escapeHtml, NOTE_MAX_LENGTH } from "./wordNotes.js";
import { speak } from "./audio.js";

// ===== 単語詳細ポップアップ =====
// 一覧のどこから押しても、その語の「状態・履歴・メモ・仲間・発音」を1か所で見られる。
// 語を中心に情報を束ねる（学習データページ用）。

const STATUS_LABEL = { untouched: "未着手", weak: "苦手", learning: "覚えかけ", mastered: "習得", known: "知ってた" };

function ensureModal() {
  let modal = document.getElementById("wordDetail");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "wordDetail";
  modal.className = "word-detail";
  modal.hidden = true;
  modal.innerHTML = `<div class="word-detail__backdrop" data-detail-close></div><div class="word-detail__panel" role="dialog" aria-modal="true" id="wordDetailPanel"></div>`;
  document.body.appendChild(modal);
  modal.querySelector("[data-detail-close]").addEventListener("click", closeWordDetail);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeWordDetail();
  });
  return modal;
}

export function closeWordDetail() {
  const modal = document.getElementById("wordDetail");
  if (modal) modal.hidden = true;
}

export function openWordDetail(wordId, { onNoteSaved } = {}) {
  const word = findWord(wordId);
  if (!word) return;
  const modal = ensureModal();
  const panel = modal.querySelector("#wordDetailPanel");
  const stat = getWordStats()[wordId];
  const status = classifyWord(stat);
  const category = getCategories().find((c) => c.id === word.category)?.label ?? "";
  const note = getNote(wordId);
  const family = (Array.isArray(word.family) ? word.family : []).map((id) => findWord(id)).filter(Boolean);
  const nextReview = stat?.nextReviewAt && !stat.mastered ? Math.max(0, Math.ceil((Date.parse(stat.nextReviewAt) - Date.now()) / 86400000)) : null;

  panel.innerHTML = `
    <button type="button" class="word-detail__close" data-detail-close aria-label="閉じる">✕</button>
    <div class="word-detail__head">
      <span class="word-detail__en">${escapeHtml(word.en)}</span>
      <button type="button" class="speak-button word-detail__speak" id="wordDetailSpeak">🔊</button>
    </div>
    <div class="word-detail__ja">${escapeHtml(word.ja)}</div>
    <div class="word-detail__meta">
      <span class="word-detail__status word-detail__status--${status}">${STATUS_LABEL[status]}</span>
      ${category ? `<span>${escapeHtml(category)}</span>` : ""}
      ${word.level ? `<span>レベル ${word.level}</span>` : ""}
      ${stat ? `<span>思い出せた ${stat.correctCount ?? 0}回 ・ 思い出せず ${stat.recallFail ?? 0}回</span>` : ""}
      ${nextReview != null ? `<span>次の復習: ${nextReview === 0 ? "今日" : `${nextReview}日後`}</span>` : ""}
      ${stat?.cleanCorrectStreak ? `<span>ノーミス連続 ${stat.cleanCorrectStreak}/10</span>` : ""}
    </div>
    ${historyDotsHtml(stat) ? `<div class="word-detail__history">履歴 ${historyDotsHtml(stat)}</div>` : ""}
    <div class="word-detail__note">
      <label for="wordDetailNote">📝 覚え方のメモ</label>
      <div class="word-detail__note-row">
        <input type="text" id="wordDetailNote" class="note-input" maxlength="${NOTE_MAX_LENGTH}" value="${escapeHtml(note)}" placeholder="例: nego＝交渉のネゴ" autocomplete="off" />
        <button type="button" class="note-save" id="wordDetailNoteSave">保存</button>
      </div>
    </div>
    ${family.length ? `<div class="word-detail__family">🔗 同じ仲間: ${family.map((w) => `<button type="button" class="family-chip" data-word-detail="${w.id}">${escapeHtml(w.en)}</button>`).join(" ")}</div>` : ""}
  `;
  modal.hidden = false;
  panel.querySelector("[data-detail-close]").addEventListener("click", closeWordDetail);
  panel.querySelector("#wordDetailSpeak").addEventListener("click", () => speak(word.en));
  const input = panel.querySelector("#wordDetailNote");
  const save = () => {
    setNote(wordId, input.value);
    const btn = panel.querySelector("#wordDetailNoteSave");
    btn.textContent = "保存済み ✓";
    setTimeout(() => (btn.textContent = "保存"), 1500);
    if (onNoteSaved) onNoteSaved(wordId);
  };
  panel.querySelector("#wordDetailNoteSave").addEventListener("click", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  });
  panel.querySelectorAll("[data-word-detail]").forEach((b) => b.addEventListener("click", () => openWordDetail(b.dataset.wordDetail, { onNoteSaved })));
}

// ページ全体で [data-word-detail] を拾う（一覧の再描画に強い委譲）
let bound = false;
export function bindWordDetail(options = {}) {
  if (bound) return;
  bound = true;
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-word-detail]");
    if (!target || target.closest("#wordDetail")) return;
    event.preventDefault();
    openWordDetail(target.dataset.wordDetail, options);
  });
}
