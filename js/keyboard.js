// ===== 専用キーボード（画面キーボード、A〜Z＋BS） =====
//
// docs/KEYBOARD.md の構想。スマホの OS キーボードは日本語切替・予測変換・数字記号が邪魔で、
// スペル入力の最大の摩擦になる。A〜Z と Backspace だけの盤面をアプリ内に持ち、
// 端末・OS によらず同じ配列・同じ打鍵感にする。Web版のスマホでもそのまま使える。
//
// - 既定は「自動」: タッチ端末（pointer: coarse）でオン。PCではオフ。設定で強制オン／オフ
// - 英単語の綴り入力と、英文を丸ごと打つカード（writing）で使う。日本語で答えるカード（場面・義務教育）は
//   A〜Z では打てないので OS キーボードに戻す
// - 文字は #input に keydown を合成して送る（game.js の処理をそのまま通す）。英文カードは値を直接編集
// - 触覚: Capacitor の Haptics があればそれ、無ければ navigator.vibrate

const OSK_KEY = "spelldash_osk"; // "auto" | "on" | "off"
const ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"]
];

export function getOskMode() {
  const v = localStorage.getItem(OSK_KEY);
  return v === "on" || v === "off" ? v : "auto";
}

export function setOskMode(mode) {
  if (mode === "on" || mode === "off") localStorage.setItem(OSK_KEY, mode);
  else localStorage.removeItem(OSK_KEY);
  window.dispatchEvent(new CustomEvent("spelldash:osk"));
}

export function isTouchDevice() {
  return window.matchMedia?.("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
}

export function oskEnabled() {
  const mode = getOskMode();
  if (mode === "on") return true;
  if (mode === "off") return false;
  return isTouchDevice();
}

function haptic() {
  try {
    const H = window.Capacitor?.Plugins?.Haptics;
    if (H?.impact) {
      H.impact({ style: "LIGHT" });
      return;
    }
    navigator.vibrate?.(8);
  } catch {
    // 無視
  }
}

let container = null;
let input = null;
let spaceKey = null;

function sendKey(key) {
  if (!input) return;
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  input.dispatchEvent(ev);
  return ev.defaultPrevented;
}

// 英文カード（free-answer かつ write-answer）は game.js が文字処理をしないので、値を直接編集する
function isFreeText() {
  return document.body.classList.contains("free-answer");
}

function pressChar(ch) {
  haptic();
  if (isFreeText()) {
    input.value += ch;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  sendKey(ch);
}

function pressBackspace() {
  haptic();
  if (isFreeText()) {
    input.value = input.value.slice(0, -1);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // 綴り入力では受理済みの文字は消せない（1ミス＝不正解の方針）。何もしない
}

function pressEnter() {
  haptic();
  sendKey("Enter");
}

// 今のカードで盤面を使えるか: 日本語で答えるカードは不可
function usableNow() {
  const write = document.body.classList.contains("write-answer");
  return !isFreeText() || write;
}

export function refreshKeyboard() {
  if (!container || !input) return;
  const on = oskEnabled() && usableNow() && document.body.classList.contains("home--playing");
  container.hidden = !on;
  document.body.classList.toggle("osk-open", on);
  if (on) {
    input.setAttribute("inputmode", "none"); // OS キーボードを出さない（入力欄はフォーカス可能のまま）
    if (spaceKey) spaceKey.hidden = !document.body.classList.contains("write-answer");
  } else {
    input.removeAttribute("inputmode");
  }
}

export function initializeKeyboard() {
  container = document.getElementById("osk");
  input = document.getElementById("input");
  if (!container || !input) return;

  container.innerHTML = `
    <div class="osk__rows" aria-label="画面キーボード">
      ${ROWS.map(
        (row, i) => `<div class="osk__row osk__row--${i}">
          ${row.map((k) => `<button type="button" class="osk__key" data-key="${k}">${k}</button>`).join("")}
          ${i === 2 ? `<button type="button" class="osk__key osk__key--bs" data-action="bs" aria-label="1文字消す">⌫</button>` : ""}
        </div>`
      ).join("")}
      <div class="osk__row osk__row--3">
        <button type="button" class="osk__key osk__key--space" data-action="space" hidden aria-label="空白">空白</button>
        <button type="button" class="osk__key osk__key--enter" data-action="enter">Enter<small>答え／次へ</small></button>
      </div>
    </div>
  `;
  spaceKey = container.querySelector('[data-action="space"]');

  // pointerdown で反応（click だと 300ms 遅れる端末がある）。入力欄のフォーカスは奪わない
  container.addEventListener("pointerdown", (event) => {
    const key = event.target.closest(".osk__key");
    if (!key) return;
    event.preventDefault();
    key.classList.add("osk__key--down");
    setTimeout(() => key.classList.remove("osk__key--down"), 90);
    if (key.dataset.key) pressChar(key.dataset.key);
    else if (key.dataset.action === "bs") pressBackspace();
    else if (key.dataset.action === "space") pressChar(" ");
    else if (key.dataset.action === "enter") pressEnter();
  });
  // 盤面をタップしても入力欄からフォーカスが外れないように
  container.addEventListener("mousedown", (e) => e.preventDefault());
  container.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });

  window.addEventListener("spelldash:osk", refreshKeyboard);
  window.addEventListener("spelldash:game-start", () => setTimeout(refreshKeyboard, 0));
  window.addEventListener("spelldash:word", refreshKeyboard);
  new MutationObserver(refreshKeyboard).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  refreshKeyboard();
}
