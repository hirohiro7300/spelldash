// ===== タイピングの 2 枚のページ（/typing.html・/typing-game.html）が共有する配線: 保存・描く部品・開く値（種類・コース）・焦点・画面キーボード・結果の守り・キー =====
//
// 状態（phase・run・時計）はページが持つ（js/typingPage.js・js/typingGamePage.js）。ここは 2 枚で同じ振る舞いの部品と、キーの振り分け（wireTyping）だけ。
// 2 枚で違うのはキーの時刻だけで、引数（timeOf）で表す: ゲームは押した瞬間（event.timeStamp。文の締切と比べる）、練習は受けた時刻。
// 結果の守り（createResultGuard）の時刻は守りのタイマー 1 つだけ。結果の Enter／Space は守りが効いている間（guard.active）は無視する。
// 学習記録は読まない・書かない。

import { isTouchDevice } from "./keyboard.js";
import { romajiKeyOf } from "./romaji.js";
import { RESULT_GUARD_MS, validPairs } from "./typingDrill.js";

// 打っている間、Space／Enter とキーで押すクリックを止めるボタン（タブ・ご意見）。語のあとの癖の Space で回が消えない（止めた回では続きから）
const RUN_CONTROLS = ".tp-tabs button, [data-feedback-open]";
// Space の keydown／keyup だけ止めるボタン: 上に「やめる」（長文の [data-run-control]）を足す。Enter と detail 0 のクリックでは押せる
// （タッチ端末で回を止める手段は「やめる」だけなので、焦点は来るのに押せないボタンにしない）
const RUN_SPACE = `${RUN_CONTROLS}, [data-run-control]`;
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

// 句読点の単位（長文の読みの「、」「。」。japaneseUnits の { punct } では句読点はいつも 1 つで単位 1 つ）
const PUNCT_KANA = new Set(["、", "。"]);

// 日本語の札: かなの単位 2 段（かな・打ったキー＋手本）を node に足す。units は typingDrill.js の japaneseUnits の形。
// opts.punct（長文の日本語）: 句読点の単位に tp-unit--punct を付け、直前の単位と 1 つの入れ物（.tp-unit-pair。折らない）に入れる
// （行頭禁則: 行の折り目で「、」「。」が行の頭に来ない）。単位の class・中身・並びは同じ（入れ物は形だけ。読み上げ・data 属性は持たない）
export function appendUnits(node, units, opts = {}) {
  let last = null; // 直前の単位
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
    if (opts.punct && PUNCT_KANA.has(u.kana)) {
      unit.classList.add("tp-unit--punct");
      if (last) {
        let pair = last.parentNode === node ? null : last.parentNode;
        if (!pair) {
          pair = make("span", "tp-unit-pair");
          node.replaceChild(pair, last);
          pair.append(last);
        }
        pair.append(unit);
        last = unit;
        continue;
      }
    }
    node.append(unit);
    last = unit;
  }
}

// 結果の行の区切り「 ・ 」: 「・」は前の語と折らない（nowrap の「 ・」。css/typing.css の .tp-sep）。折れてよいのは後ろの空白だけなので、
// 行の頭に「・」が来ない（Batch 65 Q1・PR #166 のレビュー 5）。2 枚の結果の行（練習の正確さ・ミス・自己ベストと長文の組、ゲームの流れた・打/分・正確さ・ミス）で同じ。
// textContent は「 ・ 」のまま
export const sep = () => [make("span", "tp-sep", " ・"), document.createTextNode(" ")];

// 教材の [見本, 訳] の列（空でない文字列の 2 つ組だけ）。中身は js/typingDrill.js（Node から import できる所に 1 つだけ置く）
export { validPairs };

// ---- 開く値（練習の種類 ?kind=・ゲームのコース ?course=。Batch 65 P1・P2。docs/SPEC_TYPING.md・docs/SPEC_TYPING_GAME.md） ----
// 順は URL のパラメータ → この端末の記憶 → 既定。値は許す一覧（ids）の includes で見る（ふつうのオブジェクトの引きは constructor・__proto__・toString を
// 正しい値と読む: PR #166 のレビュー 4）。head の inline の 1 行が同じ順で html の data 属性に置き（最初の描画の前。CSP・速さのため js を待たない）、
// ページはその値から始める。書くのはタブを押したときだけ（rememberChoice）: URL で開いただけでは記憶を書かない

// URL の ?param= の正しい値（無い・不正・読めない URL は null）
export function choiceFromUrl(ids, param) {
  try {
    const value = new URLSearchParams(location.search).get(param);
    return ids.includes(value) ? value : null;
  } catch {
    return null;
  }
}

// 開く値: head の 1 行が置いた値（preset）→ URL の値（fromUrl。ページが choiceFromUrl などで読んだもの）→ 記憶（key）→ fallback。
// preset が正しければそれ（head の 1 行が動かなかったときだけ、ここで読む）
export function startChoice({ ids, preset, fromUrl, key, fallback }) {
  if (ids.includes(preset)) return preset;
  if (ids.includes(fromUrl)) return fromUrl;
  try {
    const saved = storage()?.getItem(key);
    if (ids.includes(saved)) return saved;
  } catch {
    // 読めない端末は既定
  }
  return fallback;
}

// URL の ?param= を value に合わせる（history.replaceState: 履歴は増やさない。ほかのパラメータは残す）。dropHash（練習の "#long"）が今の hash なら消す
// （?param= に替えたので要らない）。URL が替わるときだけ書く（同じなら何もしない）。canonical は替えない。書き替えられない環境（古い WebView など）は URL をそのまま
export function syncUrlParam(param, value, dropHash = null) {
  try {
    const url = new URL(location.href);
    const drop = Boolean(dropHash) && url.hash === dropHash;
    if (url.searchParams.get(param) === value && !drop) return;
    url.searchParams.set(param, value);
    if (drop) url.hash = "";
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    // URL はそのまま
  }
}

// タブで選んだ値: この端末に覚え（key。次に何も指定せずに開いたときの値）、URL の ?param= を合わせる（再読み込み・共有でも今の値で開く。
// ?param= は記憶より先に読むので、合わせないと再読み込みで前の値に戻る）。覚えられない端末でも URL で今の値は保てる
export function rememberChoice({ key, param, dropHash = null }, value) {
  try {
    storage()?.setItem(key, value);
  } catch {
    // URL だけ合わせる
  }
  syncUrlParam(param, value, dropHash);
}

// 「読み込めなかった」の「開き直す」（anchor）は今の値で開き直す（静的な href は ./typing.html・./typing-game.html。深いリンクで開いて記憶が無い端末でも、
// 既定の種類・コースに戻らない: PR #166 のレビュー 2）。ほかのパラメータは残し、hash は落とす
export function reopenLink(anchor, param, value) {
  if (!anchor) return;
  try {
    const url = new URL(location.href);
    url.searchParams.set(param, value);
    anchor.setAttribute("href", url.pathname + url.search);
  } catch {
    // 静的な href のまま
  }
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
// inert は使わない（札の中の焦点と読み上げの行を残す）。盤面は出したまま、終わったら onEnd（盤面を畳む）。
// 守りの間は active（wireTyping が結果の Enter／Space を捨てる。時刻は ms のタイマー 1 つだけで持つ）
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

// 長文の英語（page.spaceIsKey() が true）で Space として読むキー: " "・"Spacebar"・全角の空白、IME オンの Process／Unidentified で code が Space
function isWideSpace(event) {
  const key = event.key;
  return key === " " || key === "Spacebar" || key === "\u3000" || ((key === "Process" || key === "Unidentified") && event.code === "Space");
}

// キーは document の keydown で受ける（#input に焦点が無くても打てる。画面キーボードの合成イベントも上がってくる）。page:
//   input, board              … 札の入力欄・札（札の空きを押したら焦点を入力欄へ）
//   phase()                   … "ready" | "running" | "paused" | "result" | "loading" | "error"（paused は長文だけ）
//   timeOf(event)             … キーの時刻（練習: performance.now()、ゲーム: eventTime）
//   endAt()                   … 打っている回の終わりの時刻（timeOf と同じ時計。時間切れの比べは running だけ）
//   guard                     … 結果の守り（createResultGuard。結果を出したときに arm する。active の間は結果の Enter／Space を捨てる）
//   start(now)・press(key, now)・finish()・reset()（始まる前へ。結果・ベスト・計測なし）
// 渡さなければ今どおりの口（タイピング練習の長文が使う。docs/SPEC_TYPING.md「長文」）:
//   keyOf(event)              … キーの読み方（既定 romajiKeyOf）
//   spaceIsKey()              … true のとき Space を広く読み（isWideSpace。keyCode 229 でも変換中でなければ Space）、running・paused では焦点がどこでも
//                               （編集できる要素を除く）preventDefault して、running は press(" ")、paused は start（続きから。判定しない）。既定 () => false
//   pause()                   … running で裏に回った・ご意見の窓をマウスで開いた（既定 reset）
//   stop(now)                 … running・paused の Esc（既定 reset）
//   holdResult()              … true のとき、result の Esc は守りの間（guard.active）と押しっぱなし（repeat）では何もしない（既定 () => false）
// paused: 守り（Backspace、ほかの 1 文字）は running と同じ。判定するキー・Space・Enter は先に start(now)（続きから）を呼ぶ（Space・Enter はそこで止め、
// 判定するキーはそのあと press）。焦点がタブ・ご意見の上の Space／Enter と「やめる」の上の Space も、ボタンは押させずに続きから（判定しない。
// 「やめる」の上の Enter はやめる）。続きに戻ったら焦点を入力欄へ（タッチ端末を除く）
export function wireTyping(page) {
  const keyOf = typeof page.keyOf === "function" ? page.keyOf : romajiKeyOf;
  const spaceIsKey = typeof page.spaceIsKey === "function" ? page.spaceIsKey : () => false;
  const holdResult = typeof page.holdResult === "function" ? page.holdResult : () => false;
  const pause = () => (typeof page.pause === "function" ? page.pause() : page.reset());
  const stop = (now) => (typeof page.stop === "function" ? page.stop(now) : page.reset());
  const live = (phase) => phase === "running" || phase === "paused";
  // 止めた回を続きから。ご意見の窓を閉じると焦点は窓を開いたボタンに戻るので、入力欄へ戻す
  const resume = (now) => {
    page.start(now);
    focusInput(page.input);
  };

  function onKey(event) {
    if (modalOpen()) return;
    const target = event.target;
    if (editable(target, page.input)) return;
    const isEnter = event.key === "Enter";
    const wide = spaceIsKey();
    const isSpace = event.key === " " || event.key === "Spacebar" || (wide && isWideSpace(event));
    if (isEnter && (event.isComposing || event.keyCode === 229)) return; // IME の確定
    if (isSpace && (event.isComposing || (!wide && event.keyCode === 229))) return; // IME の確定（spaceIsKey のときは変換中だけ: readonly の #input に確定するものは無い）
    const phase = page.phase();
    if (phase === "loading" || phase === "error") return;
    const now = page.timeOf(event);
    const mod = event.ctrlKey || event.metaKey || event.altKey;
    const key = keyOf(event); // 英単語も日本語も（IME オンの Process・JIS かな配列・Shift つきも物理キーの位置で読む）
    const onControl = target instanceof Element && target.closest('button, a[href], [role="button"]');

    // 時間を過ぎていたら先に終える（時計が遅れても数がずれない）。そのキーは捨てる
    if (phase === "running" && now >= page.endAt()) {
      if (key || ((isEnter || isSpace) && !onControl)) event.preventDefault();
      page.finish();
      return;
    }

    if (event.key === "Escape") {
      if (live(phase)) {
        event.preventDefault();
        stop(now);
      } else if (phase === "result") {
        event.preventDefault();
        if (!(holdResult() && (page.guard.active || event.repeat))) page.reset();
      }
      return;
    }

    // spaceIsKey: 打っている間の Space は焦点がどこでも空白（ボタン・リンク・タブ・ご意見・やめる の上でも押させない）
    if (isSpace && wide && live(phase) && !mod) {
      event.preventDefault();
      if (event.repeat) return;
      if (phase === "running") page.press(" ", now);
      else resume(now);
      return;
    }

    if (isEnter || isSpace) {
      if (onControl) {
        if (live(phase) && target.closest(isSpace ? RUN_SPACE : RUN_CONTROLS)) {
          event.preventDefault();
          // 止めた回（長文だけ）: ボタンは押させず続きから（判定しない）。ご意見の窓を閉じると焦点は窓を開いたボタンに戻るため
          if (phase === "paused" && !mod && !event.repeat) resume(now);
        }
        return;
      }
      if (mod) return;
      event.preventDefault();
      if (event.repeat) return;
      if (phase === "ready") page.start(now);
      else if (phase === "paused") resume(now);
      else if (phase === "result" && !page.guard.active) page.reset();
      return; // 打っている間の Space／Enter は数えない
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      if (phase === "ready" || live(phase)) event.preventDefault(); // 打った字は消せない（数えない）
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
      else if (phase === "paused") resume(now);
      page.press(key, now);
      return;
    }

    // ローマ字のキーでない 1 文字のキー（/ . , ; など）: 打っている間は数えず、ブラウザにも渡さない（Firefox のクイック検索）
    if (live(phase) && !mod && [...String(event.key ?? "")].length === 1) event.preventDefault();
  }

  // Space はボタンの上で keyup のときに押される: 打っている間は keyup も止める（spaceIsKey のときは焦点がどこでも）
  function onKeyUp(event) {
    if (!live(page.phase()) || modalOpen()) return;
    if (event.key !== " " && event.key !== "Spacebar") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (spaceIsKey() ? !editable(target, page.input) : target.closest(RUN_SPACE)) event.preventDefault();
  }

  // キーで押されたクリック（detail 0）が打っている間のタブ・ご意見のボタンに届いたら止める（keydown を止め損ねたときの保険）。
  // 「やめる」（[data-run-control]）は止めない（Tab で来て Enter・支援技術が出すクリックで押せる）
  function onClickCapture(event) {
    const phase = page.phase();
    if (!live(phase)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (event.detail === 0) {
      if (target.closest(RUN_CONTROLS)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    // マウス・タップでご意見の窓を開いた: その回は捨てる（窓の裏で時間が切れて結果とベストが残らないように）。長文は止める（pause）
    if (phase === "running" && target.closest("[data-feedback-open]")) pause();
  }

  // ページが裏に回った（打っている間）: 始まる前へ（裏で時計が間引かれても、戻った瞬間に結果を出さない）。長文は止める（pause）
  function onVisibility() {
    if (document.hidden && page.phase() === "running") pause();
  }

  page.board.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, a[href], select, label")) return; // select を押すと焦点を奪って選べない
    const phase = page.phase();
    if (phase === "ready" || live(phase)) focusInput(page.input);
  });
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("visibilitychange", onVisibility);
}
