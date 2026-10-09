// ===== チュートリアル: 初回の 1 セットに 1 文ずつ添える（docs/SPEC_TUTORIAL.md） =====
//
// スライドではなく、実際の操作の直後に 1 文だけ出し、次の操作で消える。
// 画面下の 1 本の札（.coach）に出す（画面キーボードの上。入力欄や道を隠さない）。
// 画面にある案内（#word の「分からないときは Enter で答えを表示」、#message の結果、完了パネルの「明日は…から」）と
// 同じことは言わない。札は「いま起きたことの意味」だけを 3 回: 答えを見た語はまた出る／思い出せた語は日をあけて出る／道は毎日スタートだけ。
// はちゃんは出さない（3 場面の規則）。フォーカスは奪わない。Esc で閉じる。
//
// 状態: localStorage.spelldash_tutorial = { seen: ["T2", …], started: bool }
//   初期化時に学習記録がある人（stats が 1 件以上、または腕試し済み）は seen を全部埋める＝既存ユーザーには出ない。
//   設定の「チュートリアルをもう一度」は resetTutorial() → 次のセットから。

import { getWordStats } from "./storage.js";
import { isPlacementPending } from "./difficulty.js";

const KEY = "spelldash_tutorial";

// 文は 1 つの表に集約（E2E が参照する）。常体・20 字以内・「！」なし
export const STEPS = {
  T2: "この語は数問後にもう一度出る。",
  T3: "この語は、次は日をあけて出る。",
  T4: "毎日、スタートを押すだけ。約5分。",
};
const ALL = Object.keys(STEPS);
export const T3_MIN_MS = 1500; // T3 を出した語は、次の語まで最低これだけ置く（js/game.js が spelldash:recall の detail.hold で受け取る）
const WITH_BUTTON = new Set(["T4"]); // 操作で消えないものだけ「わかった」を付ける

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { seen: Array.isArray(data.seen) ? data.seen : [], started: Boolean(data.started), setDone: Boolean(data.setDone) };
  } catch {
    return { seen: [], started: false, setDone: false };
  }
}

function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

let state = load();
let current = null; // { id, el, timer, shownAt }

function seen(id) {
  return state.seen.includes(id);
}

function markSeen(id) {
  if (!seen(id)) {
    state.seen.push(id);
    save(state);
  }
}

// 設定「チュートリアルをもう一度」
export function resetTutorial() {
  state = { seen: [], started: true, setDone: false };
  save(state);
}

export function isTutorialDone() {
  return ALL.every(seen);
}

function dismiss() {
  if (!current) return;
  const { el, timer } = current;
  clearTimeout(timer);
  el.classList.add("coach--out");
  setTimeout(() => el.remove(), 180);
  current = null;
}

function show(id) {
  if (seen(id)) return;
  dismiss();
  markSeen(id);
  const el = document.createElement("div");
  el.className = "coach";
  el.dataset.step = id;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el); // 先に空の live region を置き、次のフレームで文を入れる（読み上げが拾う）
  requestAnimationFrame(() => {
    if (current?.el !== el) return;
    el.innerHTML = `<span class="coach__text">${STEPS[id]}</span>${
      WITH_BUTTON.has(id) ? `<button type="button" class="coach__ok">わかった</button>` : ""
    }`;
    el.querySelector(".coach__ok")?.addEventListener("click", () => dismiss());
  });
  const autoHide = id === "T3" ? 5000 : 0; // T3 は最低 1.5 秒（その語の待ちも 1.5 秒にする）、長くても 5 秒
  current = { id, el, shownAt: Date.now(), timer: autoHide ? setTimeout(() => dismiss(), autoHide) : null };
}

// 腕試し前の人だけが対象（学習記録が無く、腕試しも済んでいない）。一度始めたら最後まで続ける
function decideEligibility() {
  if (state.started) return;
  const fresh = Object.keys(getWordStats()).length === 0 && isPlacementPending();
  state = fresh ? { seen: [], started: true, setDone: false } : { seen: [...ALL], started: true, setDone: true };
  save(state);
}

// 同期で記録が届いた端末（js/main.js の spelldash:synced）: まだ 1 枚も出していなければ既存ユーザー扱いに戻す。
// 初期化は同期より先に走るので、空の端末では一度「新規」と決まっている（途中まで見た新規の人はそのまま）
export function skipTutorialIfReturning() {
  if (state.seen.length > 0 || state.setDone) return;
  if (Object.keys(getWordStats()).length === 0) return;
  state = { seen: [...ALL], started: true, setDone: true };
  save(state);
  dismiss();
}

export function initTutorial() {
  decideEligibility();
  if (isTutorialDone()) return;

  // T2／T3 は次の語で消える。T3 を出した語は Study なら game.js が 1.5 秒待ってから次の語を出す（Enter で先へ進んだときもその次の語で消す）。
  // Challenge・Daily は正解と同じタスクで次の語が出るので、出してから 1.5 秒たった後の語で消す（長くても 5 秒）
  window.addEventListener("spelldash:word", () => {
    if (current?.id === "T2") dismiss();
    if (current?.id === "T3" && (current.held || Date.now() - current.shownAt >= T3_MIN_MS)) dismiss();
  });

  // T2: 初めて答えを見た。T3: 初めて自力で思い出せた（js/game.js が投げる）
  window.addEventListener("spelldash:reveal", () => {
    if (!seen("T2")) show("T2");
  });
  window.addEventListener("spelldash:recall", (event) => {
    if (seen("T3")) return;
    show("T3");
    if (event.detail) event.detail.hold = T3_MIN_MS; // 札の「この語」が次の語を指さないように、この語の待ちを延ばす
    if (current?.id === "T3") current.held = event.detail?.mode === "study"; // 待ちを延ばせるのは Study だけ
  });

  // 1 セット目を終えた（やり直しのセットは除く）: 道に戻ったときに T4 を出せる
  window.addEventListener("spelldash:session-end", (event) => {
    if (event.detail?.retry) return;
    if (!state.setDone) {
      state.setDone = true;
      save(state);
    }
  });

  // ゲームが止まった／次を始めた: 出ている札は消す
  window.addEventListener("spelldash:game-end", () => dismiss());
  window.addEventListener("spelldash:game-start", () => dismiss());

  // 道に戻った（js/main.js の「道に戻る」が投げる）: 1 セット目を終えていれば T4（道）
  window.addEventListener("spelldash:home", () => {
    dismiss();
    if (!state.setDone) return; // まだ 1 セット目を終えていない（途中で戻った）
    if (!seen("T4")) show("T4");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && current) dismiss();
  });
}
