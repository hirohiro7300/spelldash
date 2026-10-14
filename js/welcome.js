import { renderColoredWord } from "./colors.js";
import { getTotalXp } from "./level.js";
import { PLACEMENT_NOTE, PLACEMENT_MINUTES } from "./course.js";
import { renderHasumiHome } from "./hasumi.js"; // 紙片の文は body.welcome-open を見る: 畳んだら描き直す
import { esc, numHtml } from "./html.js";
import { hasWordRecords } from "./storage.js";

// ===== 初めて来た人向けのトップページ（書斎の机に置いた最初の本） =====
//
// 学習データもオンボーディング済みの印も無い人にだけ、アプリの代わりに見せる。
// 机の本の左頁に見出しと 1 語体験、右頁に「最初の 1 冊」とスタート（＝腕試し）。本の下に 4 冊を積み、選ぶと机の本が替わる。
// スタートで印を付けてアプリ（机の本）に切り替え、そのまま腕試しを始める（onStart({ bookId })）。
// 戻ってきた人・深いリンク（?set= ?words= ?t= #play など）で来た人には出さない。

const ONBOARDED_KEY = "spelldash_onboarded";

const DEMO_WORDS = [
  { ja: "りんご", en: "apple" },
  { ja: "学校", en: "school" },
  { ja: "交渉する", en: "negotiate" }
];

// 最初の 1 冊（机の上）と、積んだ本。store の前に描くので manifest は読まず、ここに持つ（id は data/manifest.json）。
// 色は背表紙の革（tokens.css の --leather-*。初回は store より前なので値で持つ）
export const FIRST_BOOK = { id: "jhs-english1", shelf: "英単語", title: "中学英語 1年", sub: "中学英語 1年から・答えは英語", lang: "en", cover: "#1E2436" };
export const WELCOME_PILE = [
  { id: "jhist1", shelf: "社会", title: "中学歴史 古代〜近世", sub: "中学歴史 古代〜近世・答えは日本語", lang: "ja", cover: "#2B1F17", style: "--wd:93%;--x:4px;--r:.7deg;--hh:44px" },
  { id: "jsci1", shelf: "理科", title: "中学理科 物理・化学", sub: "中学理科 物理・化学・答えは日本語", lang: "ja", cover: "#2C3550", style: "--wd:97%;--x:0px;--r:-.8deg;--hh:50px" },
  { id: "jkokugo1", shelf: "国語", title: "四字熟語・ことわざ", sub: "四字熟語・ことわざ・慣用句・答えは日本語", lang: "ja", cover: "#4A2320", style: "--wd:90%;--x:8px;--r:.4deg;--hh:45px" },
  { id: "accounting", shelf: "仕事の言葉", title: "経理・会計", sub: "簿記・会計の基本・答えは日本語", lang: "ja", cover: "#5E361C", style: "--wd:95%;--x:2px;--r:-1.1deg;--hh:48px" }
];

let currentBook = FIRST_BOOK;

export function markOnboarded() {
  localStorage.setItem(ONBOARDED_KEY, "1");
}

// index.html の <head> の 1 行（id="firstVisit"。最初の描画から初回の本を出すための写し）と同じ条件・同じ読み方: 語の記録は無い・空の文字列・{}・null を「記録なし」、
// 読めない値（壊れた JSON）は初回と見ない（1 行は catch で何もしない）。変えるときは両方を変える（E2E が同じ状態の表で突き合わせる）
export function shouldShowWelcome() {
  if (localStorage.getItem(ONBOARDED_KEY)) return false;
  if (getTotalXp() > 0) return false;
  // 語の記録は保存の文字列を 1 行と同じ読み方で見る（js/storage.js hasWordRecords。鍵と読み方は storage.js が持つ）
  if (hasWordRecords()) return false;
  // アプリ内への深いリンク（?set= ?words= ?t= など）で来た人には出さない。それ以外のパラメータ（計測用等）では出す
  const params = new URLSearchParams(location.search);
  if (["set", "words", "t", "weekly", "category", "genre", "mode"].some((k) => params.has(k))) return false;
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
    msg.textContent = index === 0 ? "打てた文字から色が変わる" : "次の1語。思い出して打つ";
    msg.className = "welcome-demo__msg";
    if (dots) dots.innerHTML = DEMO_WORDS.map((_, i) => `<i class="${i < index ? "on" : ""}"></i>`).join("");
  };

  const finishWord = () => {
    locked = true;
    msg.textContent = index < 2 ? "思い出せた。" : "3語できた。";
    msg.className = "welcome-demo__msg welcome-demo__msg--ok";
    if (dots) dots.innerHTML = DEMO_WORDS.map((_, i) => `<i class="${i <= index ? "on" : ""}"></i>`).join("");
    setTimeout(() => {
      index++;
      locked = false;
      if (index >= DEMO_WORDS.length) {
        ja.textContent = "できた";
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

  const flashMiss = () => {
    root.querySelector(".welcome-demo__card")?.classList.remove("welcome-demo__card--miss");
    void root.offsetWidth;
    root.querySelector(".welcome-demo__card")?.classList.add("welcome-demo__card--miss");
  };

  // 1文字受け付ける。合っていれば true
  const acceptChar = (ch) => {
    if (locked) return false;
    const expected = DEMO_WORDS[index].en[typed.length];
    if (ch.toLowerCase() !== expected) {
      flashMiss();
      return false;
    }
    typed += expected;
    input.value = typed;
    preview.innerHTML = renderColoredWord(typed);
    if (typed === DEMO_WORDS[index].en) finishWord();
    return true;
  };

  const reveal = () => {
    if (locked) return;
    // 分からないときの動きも体験できる: 答えを見せて、そのまま打てば進む
    preview.innerHTML = renderColoredWord(DEMO_WORDS[index].en);
    msg.textContent = `答えは「${DEMO_WORDS[index].en}」。見ながら打ってよい（本番では数問後にもう一度出る）`;
    msg.className = "welcome-demo__msg welcome-demo__msg--reveal";
  };

  // 物理キーボード: keydown で1文字ずつ
  input.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      reveal();
      return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    acceptChar(event.key);
  });
  // ソフトキーボード・IME（keydown で文字が取れない環境）: 入力欄の値を照合する
  let composing = false;
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertLineBreak") {
      event.preventDefault();
      reveal();
    }
  });
  input.addEventListener("input", () => {
    if (composing) return;
    const raw = input.value.toLowerCase().replace(/[^a-z]/g, "");
    if (raw === typed) return;
    if (!raw.startsWith(typed)) {
      input.value = typed; // 削除や置き換えは受理済みの位置へ戻すだけ
      return;
    }
    for (const ch of raw.slice(typed.length)) {
      if (!acceptChar(ch)) break;
    }
    if (input.value !== typed && !locked) input.value = typed;
  });

  show();
}

// 右頁の「最初の 1 冊」の文（本ごと）。英単語は腕試しの案内（道のスタート下と同じ文）。日本語で答える本も同じ目安の分（js/course.js PLACEMENT_MINUTES）
function bookCap(book) {
  return book.lang === "en" ? PLACEMENT_NOTE : `最初は腕試し10枚（約${PLACEMENT_MINUTES}分）。分からなければ Enter で答えを見る。`;
}

function flatbookHtml(book, { back = false } = {}) {
  return `<li${back ? " hidden" : ""}><button type="button" class="flatbook${back ? " flatbook--back" : ""}" data-book="${esc(book.id)}" aria-pressed="${book.id === currentBook.id}" aria-label="${esc(book.shelf)}、${esc(book.title)}を机に出す" style="--c:${esc(book.cover)};${book.style ?? "--wd:94%;--x:3px;--r:-.5deg;--hh:46px"}"><span class="flatbook__k">${esc(book.shelf)}</span><span class="flatbook__t">${numHtml(book.title)}</span><span class="flatbook__s">${book.lang === "en" ? "答えは英語" : "答えは日本語"}</span></button></li>`;
}

// 積んだ本（4 冊）と、入れ替えたときに降りてくる英単語（hidden）。index.html の #welcomeStack に同じ中身を静的に置いてある（最初の描画から積んだ高さ。
// 空きの高さを手で数えない）。E2E が index.html の積みとこれの中身が同じことを見る。本を替えるときは両方を変える
export function welcomePileHtml() {
  return WELCOME_PILE.map((b) => flatbookHtml(b)).join("") + flatbookHtml(FIRST_BOOK, { back: true });
}

// 机の本を替える（積んだ本・本棚から）。始めない。本棚からの本は meta（{ shelf, title, sub, lang }）で名前をもらう
export function pickWelcomeBook(id, meta = null) {
  const root = document.getElementById("welcome");
  const deskBook = root?.querySelector("#welcomeBook");
  if (!root || !deskBook) return;
  // 知っている本（英単語・積んだ 4 冊）も、本棚の函から来たときは meta を重ねる（course・函の名前。英単語の巻を最初に持つコースを選んでも鍵が回る）
  const known = id === FIRST_BOOK.id ? FIRST_BOOK : WELCOME_PILE.find((b) => b.id === id) ?? null;
  const book = known ? (meta ? { ...known, ...meta } : known) : meta ? { id, lang: "ja", shelf: "", title: id, sub: "", cover: "#2B1F17", ...meta } : null;
  if (!book) return;
  currentBook = book;
  const swap = () => {
    const t = deskBook.querySelector('[data-f="t"]');
    const s = deskBook.querySelector('[data-f="s"]');
    const cap = deskBook.querySelector('[data-f="cap"]');
    if (t) t.textContent = book.shelf || book.title;
    if (s) s.innerHTML = numHtml(book.sub);
    if (cap) cap.innerHTML = numHtml(bookCap(book));
    root.querySelectorAll("[data-welcome-start]").forEach((btn) => {
      btn.dataset.book = book.id;
    });
    root.querySelectorAll(".flatbook").forEach((btn) => btn.setAttribute("aria-pressed", String(btn.dataset.book === book.id)));
    // 英単語が机から降りたら積みに出す（戻れるように）。机に戻ったら畳む
    const back = root.querySelector(".flatbook--back")?.closest("li");
    if (back) back.hidden = book.id === FIRST_BOOK.id;
  };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    swap();
    return;
  }
  deskBook.classList.add("swapping");
  setTimeout(() => {
    swap();
    deskBook.classList.remove("swapping");
  }, 160);
}

// 初回の本が開いているか（開くと決まっているか）: js が引き継いだあとは body.welcome-open、引き継ぐ前（module の js が読まれている間）は
// index.html の <head> の 1 行が置いた html[data-first-visit]。読み込み時に状態を覚える js（js/bookshelf.js・js/room.js）はこれで読む
// （body のクラスだけを見ると、引き継ぎで「閉 → 開」に替わったと見て本棚を語の読み込みの前に描いてしまう）
export function isWelcomeOpen() {
  return document.body.classList.contains("welcome-open") || "firstVisit" in document.documentElement.dataset;
}

// 初回の本（open）と机の切り替え。index.html の <head> の 1 行が置いた html[data-first-visit]（CSS が最初の描画から初回の本を出す）はここで外す:
// 以後は hidden と body.welcome-open が決める（同じタスクで置き換えるので、描画の間に机が挟まらない）
function setWelcomeOpen(root, app, open) {
  root.hidden = !open;
  app.hidden = open;
  document.body.classList.toggle("welcome-open", open);
  delete document.documentElement.dataset.firstVisit;
}

// トップページを畳んでアプリ（机の本）を出す。ログイン済みの人・同期で記録が届いた人に使う（js/main.js）。
// スタートと同じ切り替えから、腕試しの開始（onStart）を抜いたもの
export function dismissWelcome() {
  const root = document.getElementById("welcome");
  const app = document.querySelector(".app--home");
  if (!root || !app) return;
  markOnboarded();
  if (root.hidden && !isWelcomeOpen()) return;
  setWelcomeOpen(root, app, false);
  document.body.classList.add("returning");
  renderHasumiHome(); // 「はじめまして」を、戻ってきた人の文に
}

// 表示して、スタートで onStart({ bookId }) を呼ぶ。戻り値: 表示したかどうか
export function renderWelcome({ onStart } = {}) {
  const root = document.getElementById("welcome");
  const app = document.querySelector(".app--home");
  if (!root || !app) return false;
  if (!shouldShowWelcome()) {
    // <head> の 1 行（最初の描画から初回の本を出す。判定は同じ）と食い違ったときは机に戻す（ふだんは何も変わらない）
    setWelcomeOpen(root, app, false);
    return false;
  }

  setWelcomeOpen(root, app, true);

  // 積んだ本（4 冊）と、入れ替えたときに降りてくる英単語: index.html に静的に置いた物を使う（無いときだけ作る）
  const stack = root.querySelector("#welcomeStack");
  if (stack) {
    if (!stack.querySelector(".flatbook")) stack.innerHTML = welcomePileHtml();
    stack.addEventListener("click", (event) => {
      const btn = event.target.closest(".flatbook");
      if (btn) pickWelcomeBook(btn.dataset.book);
    });
  }
  const cap = root.querySelector('#welcomeBook [data-f="cap"]');
  if (cap) cap.innerHTML = numHtml(bookCap(currentBook));

  const start = () => {
    markOnboarded();
    setWelcomeOpen(root, app, false);
    document.body.classList.add("returning"); // キャッチコピーは見せたので、アプリ側の見出しは机の本から
    window.scrollTo({ top: 0 });
    onStart?.({ bookId: currentBook.id, courseId: currentBook.course }); // course は本棚の函から選んだとき（js/bookshelf.js）
  };
  root.querySelectorAll("[data-welcome-start]").forEach((btn) => btn.addEventListener("click", start));
  root.querySelector("#welcomeLogin")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation(); // document のクリック監視（auth.js）が開いた直後のログイン欄を閉じないように
    markOnboarded();
    setWelcomeOpen(root, app, false);
    renderHasumiHome(); // 紙片の「はじめまして」は初回の本の間だけ
    document.getElementById("loginToggle")?.click();
  });

  setupDemo(root, () => root.querySelector("#welcomeAfterDemo")?.removeAttribute("hidden"));
  return true;
}
