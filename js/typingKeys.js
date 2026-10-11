// ===== タイピングの 2 枚のページ（/typing.html・/typing-game.html）が共有する配線: 保存・描く部品・焦点・画面キーボード・結果の守り・キー =====
//
// 状態（phase・run・時計）はページが持つ（js/typingPage.js・js/typingGamePage.js）。ここは 2 枚で同じ振る舞いの部品と、キーの振り分け（wireTyping）だけ。
// 2 枚で違うのはキーの時刻だけで、引数（timeOf）で表す: ゲームは押した瞬間（event.timeStamp。文の締切と比べる）、練習は受けた時刻。
// 結果の守りの Enter は 2 枚とも受けた時刻（performance.now()。結果を出した時刻と同じ時計）で測る（練習の側に合わせた）。
// 学習記録は読まない・書かない。

import { isTouchDevice } from "./keyboard.js";
import { romajiKeyOf } from "./romaji.js";
import { RESULT_GUARD_MS } from "./typingDrill.js";

// 打っている間、Space／Enter とキーで押すクリックを止めるボタン（タブ・ご意見）。語のあとの癖の Space で回が消えない
const RUN_CONTROLS = ".tp-tabs button, [data-feedback-open]";
const OSK = "#osk"; // 画面キーボード（盤面）

// タッチ端末か（借り物が投げても打鍵は止めない）
export const touch = (() => {
  try {
    return isTouchDevice();
  } catch {
    return false;
  }
})();

export function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// keydown の時刻は押した瞬間（performance.now() と同じ時計）。古い実装の epoch ms などは今の時刻に落とす
export function eventTime(event) {
  const t = Number(event?.timeStamp);
  const now = performance.now();
  return Number.isFinite(t) && Math.abs(now - t) <= 5000 ? t : now;
}

// ---- 描く ----

export function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// parts: 文字列 | [tag, 中身, class?] の列で node を書き替える
export function fill(node, parts) {
  node.replaceChildren();
  for (const part of parts) {
    if (Array.isArray(part)) node.append(make(part[0], part[2] ?? "", String(part[1])));
    else node.append(document.createTextNode(part));
  }
}

// 日本語の札: かなの単位 2 段（かな・打ったキー＋手本）を node に足す。units は typingDrill.js の japaneseUnits の形
export function appendUnits(node, units) {
  for (const u of units) {
    const unit = make("span", `tp-unit tp-unit--${u.state}`);
    unit.append(make("span", "tp-unit__kana", u.kana));
    const keys = make("span", "tp-unit__keys");
    if (u.state === "done") keys.textContent = u.typed;
    else {
      if (u.typed) keys.append(make("b", "", u.typed));
      if (u.state === "now" && u.rest) {
        keys.append(make("span", "tp-now", u.rest[0]));
        if (u.rest.length > 1) keys.append(document.createTextNode(u.rest.slice(1)));
      } else if (u.rest) keys.append(document.createTextNode(u.rest));
    }
    unit.append(keys);
    node.append(unit);
  }
}

// 教材の [見本, 訳] の列（空でない文字列の 2 つ組だけ）
export function validPairs(list) {
  return Array.isArray(list) && list.length > 0 && list.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && typeof p[1] === "string" && p[0] && p[1]);
}

// ---- 焦点・画面キーボード ----

// ご意見の窓（aria-modal。開け閉めは hidden）が開いているか。打鍵ごとに呼ぶので、レイアウトを読まない
export function modalOpen() {
  return [...document.querySelectorAll('[aria-modal="true"]')].some((node) => !node.closest("[hidden]"));
}

export function focusInput(input) {
  if (touch) return; // タッチ端末では焦点を当てない（iOS の入力補助のバーを出さない。キーは document で受ける）
  try {
    input.focus({ preventScroll: true });
  } catch {
    // 何もしない
  }
}

export function closeKeyboard() {
  document.body.classList.remove("typing--live", "romaji-answer"); // keyboard.js の MutationObserver がここで盤面を畳む
  window.dispatchEvent(new CustomEvent("spelldash:game-end"));
}

// タッチ端末: 札が画面キーボードに隠れるなら、札の上端がヘッダーの下 8px に来るまで寄せる（それより上には送らない）
export function fitAboveKeyboard(board) {
  const osk = document.getElementById("osk");
  if (!osk || osk.hidden) return;
  const card = board.getBoundingClientRect();
  const keys = osk.getBoundingClientRect();
  if (card.bottom <= keys.top) return;
  const header = document.querySelector(".site-header");
  const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
  const delta = card.top - (headerBottom + 8);
  if (delta > 0) window.scrollBy(0, delta);
}

// ---- 結果の守り ----
// 結果を出してから RESULT_GUARD_MS の間、盤面（#osk）の外は押させない（クリック・タップ・キーで押すクリックを捨てる。mousedown は焦点を動かさない）。
// 守る物を一覧にしない: 内か外かは closest(#osk) だけで決める（札の中のボタン・導線・フッターのリンク・タブ・ヘッダーも外）。
// inert は使わない（札の中の焦点と読み上げの行を残す）。盤面は出したまま、終わったら onEnd（盤面を畳む）
export function createResultGuard(ms = RESULT_GUARD_MS) {
  let timer = 0;
  const block = (event) => {
    if (!timer || (event.target instanceof Element && event.target.closest(OSK))) return;
    event.preventDefault();
    if (event.type !== "mousedown") event.stopImmediatePropagation();
  };
  for (const type of ["click", "auxclick", "mousedown"]) window.addEventListener(type, block, true); // window の capture: ページのどの配線より先
  return {
    get active() {
      return timer !== 0;
    },
    arm(onEnd) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = 0;
        onEnd();
      }, ms);
    },
    clear() {
      clearTimeout(timer);
      timer = 0;
    }
  };
}

// ---- キー・クリック・裏に回る ----

function editable(target, input) {
  if (!(target instanceof Element) || target === input) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

// キーは document の keydown で受ける（#input に焦点が無くても打てる。画面キーボードの合成イベントも上がってくる）。page:
//   input, board              … 札の入力欄・札（札の空きを押したら焦点を入力欄へ）
//   phase()                   … "ready" | "running" | "result" | "loading" | "error"
//   timeOf(event)             … キーの時刻（練習: performance.now()、ゲーム: eventTime）
//   endAt()                   … 打っている回の終わりの時刻（timeOf と同じ時計）
//   resultAt()                … 結果を出した時刻（performance.now()）
//   start(now)・press(key, now)・finish()・reset()（始まる前へ。結果・ベスト・計測なし）
export function wireTyping(page) {
  function onKey(event) {
    if (modalOpen()) return;
    const target = event.target;
    if (editable(target, page.input)) return;
    const isEnter = event.key === "Enter";
    const isSpace = event.key === " " || event.key === "Spacebar";
    if ((isEnter || isSpace) && (event.isComposing || event.keyCode === 229)) return; // IME の確定
    const phase = page.phase();
    if (phase === "loading" || phase === "error") return;
    const now = page.timeOf(event);
    const mod = event.ctrlKey || event.metaKey || event.altKey;
    const key = romajiKeyOf(event); // 英単語も日本語も（IME オンの Process・JIS かな配列・Shift つきも物理キーの位置で読む）
    const onControl = target instanceof Element && target.closest('button, a[href], [role="button"]');

    // 時間を過ぎていたら先に終える（時計が遅れても数がずれない）。そのキーは捨てる
    if (phase === "running" && now >= page.endAt()) {
      if (key || ((isEnter || isSpace) && !onControl)) event.preventDefault();
      page.finish();
      return;
    }

    if (event.key === "Escape") {
      if (phase === "running" || phase === "result") {
        event.preventDefault();
        page.reset();
      }
      return;
    }

    if (isEnter || isSpace) {
      if (onControl) {
        if (phase === "running" && target.closest(RUN_CONTROLS)) event.preventDefault();
        return;
      }
      if (mod) return;
      event.preventDefault();
      if (event.repeat) return;
      if (phase === "ready") page.start(now);
      else if (phase === "result" && performance.now() - page.resultAt() >= RESULT_GUARD_MS) page.reset();
      return; // 打っている間の Space／Enter は数えない
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      if (phase === "ready" || phase === "running") event.preventDefault(); // 打った字は消せない（数えない）
      return;
    }

    if (key) {
      if (phase === "result") {
        if (event.repeat) event.preventDefault();
        return; // 勝手にやり直さない
      }
      event.preventDefault();
      if (event.repeat) return;
      if (phase === "ready") page.start(now);
      page.press(key, now);
      return;
    }

    // ローマ字のキーでない 1 文字のキー（/ . , ; など）: 打っている間は数えず、ブラウザにも渡さない（Firefox のクイック検索）
    if (phase === "running" && !mod && [...String(event.key ?? "")].length === 1) event.preventDefault();
  }

  // Space はボタンの上で keyup のときに押される: 打っている間は keyup も止める
  function onKeyUp(event) {
    if (page.phase() !== "running" || modalOpen()) return;
    if (event.key !== " " && event.key !== "Spacebar") return;
    const target = event.target;
    if (target instanceof Element && target.closest(RUN_CONTROLS)) event.preventDefault();
  }

  // キーで押されたクリック（detail 0）が打っている間のタブ・ご意見のボタンに届いたら止める（keydown を止め損ねたときの保険）
  function onClickCapture(event) {
    if (page.phase() !== "running") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (event.detail === 0) {
      if (target.closest(RUN_CONTROLS)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    // マウス・タップでご意見の窓を開いた: その回は捨てる（窓の裏で時間が切れて結果とベストが残らないように）
    if (target.closest("[data-feedback-open]")) page.reset();
  }

  // ページが裏に回った（打っている間）: 始まる前へ（裏で時計が間引かれても、戻った瞬間に結果を出さない）
  function onVisibility() {
    if (document.hidden && page.phase() === "running") page.reset();
  }

  page.board.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, a[href]")) return;
    const phase = page.phase();
    if (phase === "ready" || phase === "running") focusInput(page.input);
  });
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("visibilitychange", onVisibility);
}
