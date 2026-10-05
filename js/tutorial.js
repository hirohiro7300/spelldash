// ===== チュートリアル: 初回の 1 セットに 1 文ずつ添える（docs/SPEC_TUTORIAL.md） =====
//
// スライドではなく、実際の操作の直後に 1 文だけ出し、次の操作で消える。
// 画面下の 1 本の札（.coach）に出す（画面キーボードの上。入力欄や道を隠さない）。
// はちゃんは出さない（3 場面の規則）。フォーカスは奪わない。Esc で閉じる。
//
// 状態: localStorage.spelldash_tutorial = { seen: ["T1", …], started: bool }
//   初期化時に学習記録がある人（stats が 1 件以上、または腕試し済み）は seen を全部埋める＝既存ユーザーには出ない。
//   設定の「チュートリアルをもう一度」は resetTutorial() → 次のセットから T1〜T3・次の完了で T5。

import { getWordStats } from "./storage.js";
import { isPlacementPending } from "./difficulty.js";

const KEY = "spelldash_tutorial";

// 文は 1 つの表に集約（E2E が参照する）。常体・20 字前後・「！」なし
export const STEPS = {
  T1: "日本語を見て、英単語を打つ。",
  T2: "答えを見た語は、数問後にもう一度出る。打って練習。",
  T3: "思い出せた。この語は復習の間隔が伸びる。",
  T5: "明日の復習は自動で出る。開くだけでいい。",
  T4: "ここがあなたの道。毎日スタートを押すだけ、約5分。",
  T6: "連続日数。1日1セットで続く。",
};
const ALL = Object.keys(STEPS);
const WITH_BUTTON = new Set(["T4", "T5", "T6"]); // 操作で消えないものだけ「わかった」を付ける

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { seen: Array.isArray(data.seen) ? data.seen : [], started: Boolean(data.started) };
  } catch {
    return { seen: [], started: false };
  }
}

function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

let state = load();
let current = null; // { id, el, timer }

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
  state = { seen: [], started: true };
  save(state);
}

export function isTutorialDone() {
  return ALL.every(seen);
}

function dismiss(reason = "") {
  if (!current) return;
  const { el, timer, id } = current;
  clearTimeout(timer);
  el.classList.add("coach--out");
  setTimeout(() => el.remove(), 180);
  current = null;
  if (id === "T4" && reason === "ok") showT6();
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
  el.innerHTML = `<span class="coach__text">${STEPS[id]}</span>${
    WITH_BUTTON.has(id) ? `<button type="button" class="coach__ok">わかった</button>` : ""
  }`;
  el.querySelector(".coach__ok")?.addEventListener("click", () => dismiss("ok"));
  document.body.appendChild(el);
  const autoHide = id === "T6" ? 6000 : id === "T3" ? 5000 : 0; // T3 は次の語が来ても最低 1.5 秒、長くても 5 秒
  current = { id, el, shownAt: Date.now(), timer: autoHide ? setTimeout(() => dismiss("timeout"), autoHide) : null };
}

function showT6() {
  const streak = document.getElementById("headerStreak");
  if (seen("T6") || !streak || streak.hidden) return;
  show("T6");
}

// 腕試し前の人だけが対象（学習記録が無く、腕試しも済んでいない）。一度始めたら最後まで続ける
function decideEligibility() {
  if (state.started) return;
  const fresh = Object.keys(getWordStats()).length === 0 && isPlacementPending();
  state = fresh ? { seen: [], started: true } : { seen: [...ALL], started: true };
  save(state);
}

export function initTutorial() {
  decideEligibility();
  if (isTutorialDone()) return;

  const input = document.getElementById("input");

  // T1: 1 語目が出たら。T2／T3 は次の語で消える（T3 は正解の直後に次の語が来るので、1.5 秒は残す）
  window.addEventListener("spelldash:word", () => {
    if (current?.id === "T2") dismiss("next");
    if (current?.id === "T3" && Date.now() - current.shownAt > 1500) dismiss("next");
    if (!seen("T1")) show("T1");
  });
  // T1 は 1 文字打つか Enter で消える（画面キーボードは input イベント）
  const typed = () => {
    if (current?.id === "T1") dismiss("typed");
  };
  input?.addEventListener("input", typed);
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key.length === 1) typed();
  });

  // T2: 初めて答えを見た。T3: 初めて自力で思い出せた（js/game.js が投げる）
  window.addEventListener("spelldash:reveal", () => {
    if (current?.id === "T1") dismiss("reveal");
    if (!seen("T2")) show("T2");
  });
  window.addEventListener("spelldash:recall", () => {
    if (!seen("T3")) show("T3");
  });

  // T5: 1 セット目の完了（やり直しのセットは除く）
  // 完了直後はレベルアップの札（1.2 秒）が出ることがあるので、少し待ってから
  window.addEventListener("spelldash:session-end", (event) => {
    if (event.detail?.retry) return;
    if (current && ["T1", "T2", "T3"].includes(current.id)) dismiss("end");
    if (!seen("T5")) setTimeout(() => show("T5"), 1600);
  });

  // ゲームを離れて道に戻った: T5 を閉じ、T4（道）→ T6（連続日数）
  window.addEventListener("spelldash:game-end", () => {
    if (current && current.id !== "T4" && current.id !== "T6") dismiss("home");
    if (!seen("T5")) return; // まだ 1 セット目を終えていない（中断）
    if (!seen("T4")) show("T4");
    else if (!seen("T6")) showT6();
  });
  // スタートを押したら T4 は役目を終える（T6 は次に道へ戻ったとき）
  window.addEventListener("spelldash:game-start", () => {
    if (current && ["T4", "T6"].includes(current.id)) dismiss("start");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && current) dismiss("esc");
  });
}
