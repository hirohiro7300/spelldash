// ===== 自分のメモ（覚え方） =====
//
// 「negotiate = nego(交渉)＋…」のような、本人だけに効く覚え方を語ごとに1つ持つ。
// 答えを見た時／ヒントを見た時に表示し、思い出せなかった語を自分のものにする場をつくる。
// 端末ローカル（spelldash_word_notes）。バックアップ（backup.js）に含まれる。
// クラウド同期は word_progress に note 列が入ってから（docs/SQL_FEEDBACK.md 参照）。

const NOTES_KEY = "spelldash_word_notes";
export const NOTE_MAX_LENGTH = 80;

export function getAllNotes() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function getNote(wordId) {
  const note = getAllNotes()[wordId];
  return typeof note === "string" ? note : "";
}

// 空文字で保存すると削除
export function setNote(wordId, text) {
  const notes = getAllNotes();
  const trimmed = String(text ?? "").trim().slice(0, NOTE_MAX_LENGTH);
  if (trimmed) {
    notes[wordId] = trimmed;
  } else {
    delete notes[wordId];
  }
  localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  window.dispatchEvent(new CustomEvent("spelldash:notes"));
  return trimmed;
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// 一覧用: メモの表示＋編集ボタン（クリック処理は bindNoteEditors で委譲）
export function noteChipHtml(wordId) {
  const note = getNote(wordId);
  return `<button type="button" class="note-chip${note ? " note-chip--has" : ""}" data-note-word="${wordId}" title="${note ? "メモを編集" : "覚え方をメモ"}">📝${note ? ` ${escapeHtml(note)}` : ""}</button>`;
}

// 一覧内の 📝 ボタンをインライン編集にする（container内で委譲）
export function bindNoteEditors(container, onSaved) {
  if (!container || container.dataset.noteBound) return;
  container.dataset.noteBound = "1";

  container.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-note-word]");
    if (!chip || chip.classList.contains("note-chip--editing")) return;
    const wordId = chip.dataset.noteWord;
    const current = getNote(wordId);

    chip.classList.add("note-chip--editing");
    chip.innerHTML = "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "note-input";
    input.maxLength = NOTE_MAX_LENGTH;
    input.placeholder = "覚え方（例: nego＝交渉のネゴ）";
    input.value = current;
    const save = document.createElement("span");
    save.className = "note-save";
    save.textContent = "保存";
    chip.append(input, save);
    input.focus();

    const finish = () => {
      setNote(wordId, input.value);
      if (onSaved) onSaved(wordId);
    };
    save.addEventListener("click", (e) => {
      e.stopPropagation();
      finish();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (onSaved) onSaved(wordId);
      }
    });
    input.addEventListener("click", (e) => e.stopPropagation());
  });
}
