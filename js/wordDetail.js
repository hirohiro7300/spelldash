import { exampleHtml, hasExample } from "./wordExample.js";
import { findWord, findWordIn, getCategories } from "./wordStore.js";
import { answerLabel } from "./wordData.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";
import { historyDotsHtml } from "./learnedWords.js";
import { getNote, setNote, escapeHtml, NOTE_MAX_LENGTH } from "./wordNotes.js";
import { renderWordAi } from "./wordAi.js";
import { speak } from "./audio.js";
import { speechTextOf } from "./wordStore.js";
import { icon } from "./icons.js";
import { trapFocus } from "./focusTrap.js";
import { rankHtml, rankOf, rankBasis, rankNext, statusScaleNote, RANK_NAMES, RANK_RULE } from "./mastery.js";
import { localDay } from "./retentionCalc.js";

// ===== 単語詳細ポップアップ =====
// 一覧のどこから押しても、その語の「状態・履歴・メモ・仲間・発音」を1か所で見られる。
// 語を中心に情報を束ねる（学習データページ用）。

const STATUS_LABEL = { untouched: "未着手", weak: "苦手", learning: "覚えた", mastered: "習得", known: "知ってた" };
const LEVEL_LABEL = { easy: "やさしい", normal: "ふつう", hard: "むずかしい" };

// 習熟度（docs/SPEC_MASTERY.md §5.2）: meta の行の下に 2 行と畳んだ決まり。段 0（答えの記録が無い）は 3 つとも出さない。
//   1 行目: 習熟度 [目盛り] 名前 ・ その語の事実（rankBasis）。見出しに「習熟度」があるので目盛りの aria-label には重ねない（label: ""）
//   2 行目: 段の梯子（今の段だけ太字。読み上げない）と次の段の条件（rankNext。読み上げる。段 5 は無し）
//   題箋と段が食い違って見える組（苦手＋身についた など）だけ: 題箋の意味と「習熟度とは別の物差し」の 1 文（statusScaleNote。Batch 64 M4）
//   その下: 畳んだ「習熟度の決まり」（開くと規則の文。閉じていれば 1 行で、毎語に規則の 4 文が並ばない）
// 文はどれも mastery.js が記録から作る固定の文（利用者の入力を含まない）。stat は読むだけ
function masteryHtml(stat, status, today = localDay(new Date())) {
  const r = rankOf(stat);
  if (r === 0) return "";
  const next = rankNext(stat, today);
  const scale = statusScaleNote(status, r);
  const ladder = RANK_NAMES.slice(1)
    .map((name, i) => (i + 1 === r ? `<b>${name}</b>` : name))
    .join(" ・ ");
  return `<div class="word-detail__rank">
      <p class="word-detail__rank-line"><span class="word-detail__rank-label">習熟度</span> ${rankHtml(r, { label: "" })} ・ <span class="word-detail__rank-basis">${rankBasis(stat, today)}</span></p>
      <p class="rank-ladder"><span aria-hidden="true">${ladder}${next ? " ・ " : ""}</span>${next ? `<span class="rank-ladder__next">${next}</span>` : ""}</p>
      ${scale ? `<p class="rank-scale">${scale}</p>` : ""}
      <details class="rank-rule"><summary>習熟度の決まり</summary><p>${RANK_RULE}</p></details>
    </div>`;
}

function ensureModal() {
  let modal = document.getElementById("wordDetail");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "wordDetail";
  modal.className = "word-detail";
  modal.hidden = true;
  modal.innerHTML = `<div class="word-detail__backdrop" data-detail-close></div><div class="word-detail__panel" role="dialog" aria-modal="true" aria-labelledby="wordDetailTitle" id="wordDetailPanel"></div>`;
  document.body.appendChild(modal);
  modal.querySelector("[data-detail-close]").addEventListener("click", closeWordDetail);
  return modal;
}

// 開いている間のフォーカストラップ（Esc で閉じる・Tab は中で循環・閉じたら押した要素へ戻る）。
// 仲間の語で開き直しても同じトラップを使い回す（戻り先は最初に押した要素のまま）
let releaseTrap = null;

export function closeWordDetail() {
  const modal = document.getElementById("wordDetail");
  if (modal) modal.hidden = true;
  document.body.classList.remove("modal-open");
  if (releaseTrap) {
    const release = releaseTrap;
    releaseTrap = null;
    release();
  }
}

// category を渡すと、そのカテゴリに入っている版の語を優先して引く。
// 同じ id の語が複数のパックにあり、パックごとに訳・例文が違うことがあるため
// （例: compile は IT パックでは「コンパイルする」、TOEIC パックでは「まとめる」）。
export function openWordDetail(wordId, { onNoteSaved, category: fromCategory } = {}) {
  const word = findWordIn(fromCategory, wordId) ?? findWord(wordId);
  if (!word) return;
  const modal = ensureModal();
  const panel = modal.querySelector("#wordDetailPanel");
  const stat = getWordStats()[wordId];
  const status = classifyWord(stat);
  const category = getCategories().find((c) => c.id === word.category)?.label ?? "";
  const note = getNote(wordId);
  const family = (Array.isArray(word.family) ? word.family : []).map((id) => findWord(id)).filter(Boolean);
  const nextReview = stat?.nextReviewAt && !stat.mastered ? Math.max(0, Math.ceil((Date.parse(stat.nextReviewAt) - Date.now()) / 86400000)) : null;
  // 題箋の title: 思い出せず・ノーミス連続。「思い出せた N回」（correctCount は答えを見た後の打ち直しも数えて多めに出る）は出さない
  const statusTitle = stat ? `思い出せず ${stat.recallFail ?? 0}回${stat.cleanCorrectStreak ? ` ・ ノーミス連続 ${stat.cleanCorrectStreak}/10` : ""}` : "";

  // 最後の [data-sr-live] は窓の間の読み上げの行（js/ui.js announce。背後は inert なので、60 秒の時間切れの見出しの文などはここに書く。PR #166 レビューの 7）
  panel.innerHTML = `
    <button type="button" class="word-detail__close" data-detail-close aria-label="閉じる">${icon("x")}</button>
    <div class="word-detail__head">
      <span class="word-detail__en${word.q && !/^[A-Za-z0-9 .,'’/&()-]+$/.test(word.answer ?? word.en ?? "") ? "" : " mono"}" id="wordDetailTitle">${escapeHtml(word.answer ?? word.en)}</span>
      ${speechTextOf(word) ? `<button type="button" class="speak-button word-detail__speak" id="wordDetailSpeak" aria-label="発音">${icon("speaker")}発音</button>` : ""}
    </div>
    <div class="word-detail__ja">${escapeHtml(word.ja)}</div>
    ${word.q ? `<div class="word-detail__q">場面: ${escapeHtml(word.q)}</div>` : ""}
    ${word.explain ? `<div class="word-detail__q">${escapeHtml(word.explain)}</div>` : ""}
    ${hasExample(word) ? `<div class="word-detail__ex word-example">${exampleHtml(word)}</div>` : ""}
    <div class="word-detail__meta">
      <span class="word-detail__status word-detail__status--${status}"${statusTitle ? ` title="${statusTitle}"` : ""}>${STATUS_LABEL[status]}</span>
      ${category ? `<span>${escapeHtml(category)}</span>` : ""}
      ${word.pos ? `<span>${escapeHtml(word.pos)}</span>` : ""}
      ${word.level ? `<span>${LEVEL_LABEL[word.level] ?? escapeHtml(word.level)}</span>` : ""}
      ${nextReview != null ? `<span>次の復習 ${nextReview === 0 ? "今日" : `${nextReview}日後`}</span>` : ""}
    </div>
    ${masteryHtml(stat, status)}
    ${historyDotsHtml(stat) ? `<div class="word-detail__history">履歴 ${historyDotsHtml(stat)}</div>` : ""}
    <div class="word-detail__note">
      <label for="wordDetailNote">覚え方のメモ</label>
      <div class="word-detail__note-row">
        <input type="text" id="wordDetailNote" class="note-input" maxlength="${NOTE_MAX_LENGTH}" value="${escapeHtml(note)}" placeholder="例: nego＝交渉のネゴ" autocomplete="off" />
        <button type="button" class="note-save" id="wordDetailNoteSave">保存</button>
      </div>
    </div>
    <div class="word-detail__ai" id="wordDetailAi"></div>
    ${family.length ? `<div class="word-detail__family">同じ仲間: ${family.map((w) => `<button type="button" class="family-chip" data-word-detail="${w.id}">${escapeHtml(answerLabel(w))}</button>`).join(" ")}</div>` : ""}
    <p class="sr-only" role="status" aria-live="polite" data-sr-live></p>
  `;
  modal.hidden = false;
  document.body.classList.add("modal-open"); // 背後の sticky（ジャンル列）を止める
  const closeButton = panel.querySelector("[data-detail-close]");
  closeButton.addEventListener("click", closeWordDetail);
  if (!releaseTrap) {
    releaseTrap = trapFocus(panel, { onEscape: closeWordDetail, initialFocus: closeButton, inert: true });
  } else {
    closeButton.focus({ preventScroll: true }); // 仲間の語で開き直したとき
  }
  panel.querySelector("#wordDetailSpeak")?.addEventListener("click", () => speak(speechTextOf(word)));
  panel.querySelector("[data-example-speak]")?.addEventListener("click", () => speak(word.ex)); // 例文の読み上げ
  const input = panel.querySelector("#wordDetailNote");
  const save = () => {
    setNote(wordId, input.value);
    const btn = panel.querySelector("#wordDetailNoteSave");
    btn.textContent = "保存済み";
    setTimeout(() => (btn.textContent = "保存"), 1500);
    if (onNoteSaved) onNoteSaved(wordId);
  };
  panel.querySelector("#wordDetailNoteSave").addEventListener("click", save);
  renderWordAi(panel.querySelector("#wordDetailAi"), word);
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
    openWordDetail(target.dataset.wordDetail, { ...options, category: target.dataset.wordCategory || options.category });
  });
}
