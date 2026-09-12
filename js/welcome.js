import { renderColoredWord } from "./colors.js";
import { getWordStats } from "./storage.js";
import { getTotalXp } from "./level.js";

// ===== 初めて来た人向けのトップページ（ランディング） =====
//
// 学習データもオンボーディング済みの印も無い人にだけ、アプリの代わりに見せる。
// 「無料で始める」で印を付けてアプリ（道）に切り替え、そのまま腕試しを始める。
// 戻ってきた人・深いリンク（?set= ?words= ?t= #play など）で来た人には出さない。

const ONBOARDED_KEY = "spelldash_onboarded";

const DEMO_WORDS = [
  { ja: "りんご", en: "apple" },
  { ja: "学校", en: "school" },
  { ja: "交渉する", en: "negotiate" }
];

export function markOnboarded() {
  localStorage.setItem(ONBOARDED_KEY, "1");
}

export function shouldShowWelcome() {
  if (localStorage.getItem(ONBOARDED_KEY)) return false;
  if (getTotalXp() > 0) return false;
  if (Object.keys(getWordStats()).length > 0) return false;
  if (location.search.length > 1) return false; // ?set= ?words= ?t= などの深いリンク
  if (location.hash === "#play") return false;
  return true;
}

// ミニ体験: 日本語を見て1語打つ。3語で「こんな感じ」が分かる（学習記録には残さない）
function setupDemo(root, onDone) {
  const ja = root.querySelector("#welcomeDemoJa");
  const preview = root.querySelector("#welcomeDemoPreview");
  const input = root.querySelector("#welcomeDemoInput");
  const msg = root.querySelector("#welcomeDemoMsg");
  const dots = root.querySelector("#welcomeDemoDots");
  if (!ja || !preview || !input || !msg) return;

  let index = 0;
  let typed = "";
  let locked = false;

  const show = () => {
    const word = DEMO_WORDS[index];
    ja.textContent = word.ja;
    typed = "";
    preview.innerHTML = "";
    input.value = "";
    msg.textContent = index === 0 ? "キーボードで英単語を打ってみて（1文字ずつ色が付きます）" : "次の1語。思い出して打つ";
    msg.className = "welcome-demo__msg";
    if (dots) dots.innerHTML = DEMO_WORDS.map((_, i) => `<i class="${i < index ? "on" : ""}"></i>`).join("");
  };

  const finishWord = () => {
    locked = true;
    msg.textContent = index === 0 ? "○ 思い出せた！ 打てた語は「覚えた」に近づき、忘れそうな頃にまた出ます" : index === 1 ? "○ いい感じ。分からない語は Enter で答えを見てOK。数問後にまた出ます" : "○ 3語クリア！ 本番は中学英語の腕試し10語から";
    msg.className = "welcome-demo__msg welcome-demo__msg--ok";
    if (dots) dots.innerHTML = DEMO_WORDS.map((_, i) => `<i class="${i <= index ? "on" : ""}"></i>`).join("");
    setTimeout(() => {
      index++;
      locked = false;
      if (index >= DEMO_WORDS.length) {
        ja.textContent = "できた！";
        preview.innerHTML = "";
        input.value = "";
        input.disabled = true;
        onDone?.();
        return;
      }
      show();
      input.focus({ preventScroll: true });
    }, 1100);
  };

  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (locked) return;
      // 分からないときの動きも体験できる: 答えを見せて、そのまま打てば進む
      preview.innerHTML = renderColoredWord(DEMO_WORDS[index].en);
      msg.textContent = `答えは「${DEMO_WORDS[index].en}」。見ながら打ってOK（本番では数問後にもう一度出ます）`;
      msg.className = "welcome-demo__msg welcome-demo__msg--reveal";
      return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    if (locked) return;
    const expected = DEMO_WORDS[index].en[typed.length];
    if (event.key.toLowerCase() !== expected) {
      root.querySelector(".welcome-demo__card")?.classList.remove("welcome-demo__card--miss");
      void root.offsetWidth;
      root.querySelector(".welcome-demo__card")?.classList.add("welcome-demo__card--miss");
      return;
    }
    typed += expected;
    input.value = typed;
    preview.innerHTML = renderColoredWord(typed);
    if (typed === DEMO_WORDS[index].en) finishWord();
  });

  show();
}

// 表示して、始めるボタンで onStart を呼ぶ。戻り値: 表示したかどうか
export function renderWelcome({ onStart } = {}) {
  const root = document.getElementById("welcome");
  const app = document.querySelector(".app--home");
  if (!root || !app) return false;
  if (!shouldShowWelcome()) {
    root.hidden = true;
    return false;
  }

  root.hidden = false;
  app.hidden = true;
  document.body.classList.add("welcome-open");

  const start = () => {
    markOnboarded();
    root.hidden = true;
    app.hidden = false;
    document.body.classList.remove("welcome-open");
    document.body.classList.add("returning"); // キャッチコピーは見せたので、アプリ側の見出しは道から
    window.scrollTo({ top: 0 });
    onStart?.();
  };
  root.querySelectorAll("[data-welcome-start]").forEach((btn) => btn.addEventListener("click", start));
  root.querySelector("#welcomeLogin")?.addEventListener("click", (event) => {
    event.preventDefault();
    markOnboarded();
    root.hidden = true;
    app.hidden = false;
    document.body.classList.remove("welcome-open");
    document.getElementById("loginToggle")?.click();
  });

  setupDemo(root, () => root.querySelector("#welcomeAfterDemo")?.removeAttribute("hidden"));
  return true;
}
