// ===== 英単語の表示（2トーン） =====
// 以前は文字ごとの虹色だったが、コンセプト「墨と朱」（docs/CONCEPT.md 原則7）で
// 打った文字＝朱、答えの表示＝墨 の2トーンにした。色は CSS 側（.typed-preview span / .hidden-word span）。
// 英文（空白あり）は単語ごとにまとめて、単語の途中で折り返さないようにする。

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function renderColoredWord(word) {
  const letters = (text) =>
    text
      .split("")
      .map((letter) => `<span class="cl">${esc(letter)}</span>`)
      .join("");
  if (/\s/.test(String(word).trim())) {
    return String(word)
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `<span class="cw">${letters(w)}</span>`)
      .join(" ");
  }
  return letters(String(word));
}
