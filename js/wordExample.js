import { speak } from "./audio.js";
import { icon } from "./icons.js";

// ===== 例文（英単語カード） =====
// データの ex（英文）／exJa（訳）／exForm（英文中の語形）を、答え表示・正解時・単語帳・単語詳細に出す。
// 見出し語は太字にして「この文のどこがその語か」を一目で分かるようにする。

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function hasExample(word) {
  return !!(word && word.ex && word.exJa);
}

// 英文の中の見出し語（または exForm）を <b> で囲む。見つからなければそのまま
export function highlightExample(word) {
  const ex = String(word?.ex ?? "");
  const form = String(word?.exForm || word?.en || "");
  if (!form) return esc(ex);
  const re = new RegExp(`(^|[^A-Za-z])(${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=[^A-Za-z]|$)`, "i");
  const m = ex.match(re);
  if (!m) return esc(ex);
  const start = m.index + m[1].length;
  const end = start + m[2].length;
  return `${esc(ex.slice(0, start))}<b>${esc(ex.slice(start, end))}</b>${esc(ex.slice(end))}`;
}

export function exampleHtml(word, { speakButton = true, className = "word-example" } = {}) {
  if (!hasExample(word)) return "";
  // 読み上げボタンは英文の末尾に続けて置く（別行に落ちないように __en の中に入れる）
  return `
    <span class="${className}__en">${highlightExample(word)}${speakButton ? ` <button type="button" class="${className}__speak" data-example-speak aria-label="例文を読み上げる">${icon("speaker", { size: 14 })}</button>` : ""}</span>
    <span class="${className}__ja">${esc(word.exJa)}</span>
  `;
}

// container に描画（無ければ空にする）。読み上げボタンで英文を読み上げる
export function renderWordExample(container, word) {
  if (!container) return;
  if (!hasExample(word)) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = exampleHtml(word);
  container.querySelector("[data-example-speak]")?.addEventListener("click", (event) => {
    event.preventDefault();
    speak(word.ex);
    document.getElementById("input")?.focus({ preventScroll: true });
  });
}
