// ログイン中の人のアカウントのアイコン（ヘッダーの #headerAvatar。38px の丸、720px 以下は 32px）と、メニューの一番上の行に、学習のランクを出す。
// ランクは Batch 78 の 9 段（js/rank.js。覚えた語数で決まる・一度届いたら下がらない）。前の XP の 21 段は使わない（XP は貯めるがランクにしない: 決定 §5）。
// ボタンの名前は「アカウントメニュー（中学生）」、メニューの一番上の行は「中学生」（Lv は出さない）。Battle の RP のランクと Pro は入れない。
// js/auth.js が、ログインしているときだけ読み込みの後の手の空いたときに動的 import で読む（最初の描画・LCP を待たせない。静的 import は modulepreload を変える）。
// 未ログイン・アプリ（ログインしない）では読まない。HTML は 7 ページとも同じ形で、中身はここで替える（頭文字の span は js/auth.js が置く）。
//
// ランクの材料: 見せるランク = max（最高到達ランク spelldash_rank_peak, 今の覚えた語数の段）（js/rank.js shownRank。学習状況と同じ）。
//   今の覚えた語数は、このページで 3 状態の材料（公開の語の表）がもう読めているときだけ数える（学習状況・中心の学習のページ）。読めていなければ最高到達ランクだけ。
//   最高到達ランクがまだ無い（移行の後に学習状況も回の終わりもまだ）ときは、材料を 1 回だけ後から読んで数える（語の記録が無ければ読まずに赤ちゃん）。
//   ここでは最高到達ランクを書かない（書くのは学習状況と中心の学習の回の終わり）。
// ランクが決まる・決まらない: 決まるのは、端末の持ち主の印（js/sync.js OWNER_KEY）がこのアカウントか、このタブで同期を終えた（js/sync.js DONE_FLAG）とき。
//   それ以外（持ち主が別のアカウント・持ち主の印が無く同期がまだ・同期の失敗）と、材料が読めないときは頭文字のまま、ボタンの名前は「アカウントメニュー」、行は出さない。
// 絵: 新しい 9 段の絵はまだ無い（決定 §5・§12）。絵ができるまでアイコンは頭文字のまま（js/emblem.js learnRankEmblemSrc が "" を返す）。絵を足したらそこで URL を返す
//   （読めない・遅い絵は頭文字のまま。壊れた画像の印を出さない: 下の renderEmblem）。
// 替える時機（nextShown）: このタブの回で上がったランクは、ランクの幕を閉じた知らせ（spelldash:rank-up-closed。detail.rank はランクの名前か段の番号）の後に替える。
//   幕が出ている間とプレイ中は段を替えない。回の終わり（spelldash:game-end）と頭（spelldash:game-start）は後へ回して（setTimeout 0）幕が出ていないことを見てから替える。
//   最高到達ランクを上げた知らせ（spelldash:rank-peak。同じタブ）・同期（spelldash:synced）・別のタブ（storage）・記録の置き換え・メニューを開く前は、
//   幕とプレイの外ならそのまま替える。下がった演出は出さない（見せるランクは下がらない。別のアカウントに替わったときだけ前の人のランクを消す）。
import { RANK_NAMES, RANK_PEAK_KEY, rankFor, readRankPeak, shownRank, rankOfName, parseRankPeak } from "./rank.js";
import { learnRankEmblemSrc } from "./emblem.js";
import { STORAGE_KEY, getWordStats, hasWordRecords, learnStateSource, loadLearnStates } from "./storage.js";
import { countLearnStates } from "./learnState.js";

export const OWNER_KEY = "spelldash_owner"; // js/sync.js OWNER_KEY（localStorage。最後に同期できたアカウントの user id）
export const SYNC_DONE_KEY = "spelldash_sync_done_this_session"; // js/sync.js DONE_FLAG（sessionStorage。このタブで同期を最後まで終えた user id）
const MENU_LABEL = "アカウントメニュー";

// ---- 決める（DOM なし。scripts/test-account-emblem.mjs） ----

// ランクが決まれば { rank: 段の番号 0〜8, name }、決まらなければ null。
// peak = 最高到達ランク（読めない値は無いのと同じ）、learned・total = 今の覚えた語数と公開の語数（数えていなければ null）。
// 決まるのは持ち主の印かこのタブの同期が本人で、最高到達ランクか今の語数のどちらかがあるとき（どちらも無ければ材料を待つ: null）
export function accountRankState({ userId, owner, syncedUser, peak = null, learned = null, total = null }) {
  if (!userId) return null;
  if (owner !== userId && syncedUser !== userId) return null;
  const p = parseRankPeak(peak);
  const counted = Number.isInteger(learned) && learned >= 0 && Number.isInteger(total) && total > 0;
  if (p === null && !counted) return null;
  const rank = counted ? shownRank(learned, p, total) : p;
  return { rank, name: RANK_NAMES[rank] };
}

export function menuLabel(state) {
  return state ? `${MENU_LABEL}（${state.name}）` : MENU_LABEL;
}

// メニューの一番上の行（ランクの名前だけ。Lv は出さない）と、その読み上げ
export function rankRowText(state) {
  return state.name;
}

export function rankRowSpeech(state) {
  return `ランク ${state.name}`;
}

// アイコンの絵（新しい 9 段の絵はまだ無いので ""。js/emblem.js learnRankEmblemSrc）。決まらないときも ""
export function emblemUrl(state) {
  return state ? learnRankEmblemSrc(state.rank, { small: true }) : "";
}

const sameRank = (a, b) => !!a && !!b && a.rank === b.rank;

// 次に出す状態。current = 今の材料から（決まらなければ null）、shown = 今出している状態、curtainOpen = ランクの幕が出ている、
// running = プレイ中（または段を替えない描き直し）、announced = 幕を閉じた知らせで見せたランク
export function nextShown({ current, shown = null, curtainOpen = false, running = false, announced = null }) {
  if (!current) return null;
  if (announced) {
    // 幕で見せた。プレイ中なら幕で見せたランクまで（そのあと回の間に次の段へ進んでいても、その幕はまだ）
    if (!running || sameRank(announced, current)) return current;
    return announced.rank < current.rank ? announced : current;
  }
  if (curtainOpen) return shown;
  if (running) return sameRank(shown, current) ? current : shown;
  return current;
}

// 幕を閉じた知らせの detail（{ rank: ランクの名前 か 段の番号 }）→ { rank, name }。9 段のどれでもなければ null
export function announcedFrom(detail) {
  const raw = detail?.rank;
  const rank = typeof raw === "string" && rankOfName(raw) !== null ? rankOfName(raw) : parseRankPeak(raw);
  return rank === null ? null : { rank, name: RANK_NAMES[rank] };
}

// ---- 描く（ブラウザ） ----

let account = null; // { userId }（null = 未ログイン）
let shown = null; // 今出している { rank, name }（null = 頭文字）
let failedSrc = ""; // 読めなかった絵の URL（通信が戻るか段が替わるまで取り直さない。知らせのたびに 404 を取りに行かない）
let installed = false;
let loadingLearn = null; // 最高到達ランクが無いときに 3 状態の材料を読んでいる Promise（1 ページ 1 回）
let learnFailed = false; // 材料が読めなかった（オフライン）: 通信が戻るまで読み直さない（描き直しのたびに取りに行かない）

function storageValue(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

// 今の覚えた語数と公開の語数。材料がこのページでもう読めているときだけ数える（{ learned, total }）。語の記録が無ければ材料なしで 0 語。
// まだ読めていなければ null（最高到達ランクが無いときは needLearn で 1 回だけ後から読む）
function learnedNow() {
  const source = learnStateSource();
  if (source) return { learned: countLearnStates(getWordStats(), source.vocab, source.pending).learned, total: source.vocab.total };
  if (!hasWordRecords()) return { learned: 0, total: 1 }; // 記録が無い = 0 語（rankFor(0) はどの総数でも赤ちゃん）
  return null;
}

function needLearn() {
  if (loadingLearn || learnFailed) return;
  loadingLearn = loadLearnStates()
    .catch(() => null)
    .then((source) => {
      loadingLearn = null;
      if (!source) {
        learnFailed = true; // 通信が戻ったら（online）読み直す
        return;
      }
      refreshAccountEmblem();
    });
}

function currentState() {
  try {
    const peak = readRankPeak();
    const now = learnedNow();
    const who = { userId: account?.userId ?? null, owner: storageValue(localStorage, OWNER_KEY), syncedUser: storageValue(sessionStorage, SYNC_DONE_KEY) };
    const state = accountRankState({ ...who, peak, learned: now?.learned ?? null, total: now?.total ?? null });
    // 本人の記録と決まっていて、最高到達ランクも今の語数もまだ無いときだけ材料を読む（持ち主が別の人・取り込みの前は読まない）
    if (!state && peak === null && !now && accountRankState({ ...who, peak: 0 })) needLearn();
    return state;
  } catch {
    return null;
  }
}

// プレイ中（ホームの Study・Challenge の回の途中。完了の画面 body.set-done は外。js/main.js showGame・js/game.js）
function isRunning() {
  const body = document.body?.classList;
  return !!body && body.contains("home--playing") && !body.contains("set-done");
}

// ログインの状態を受け取る（js/auth.js updateAuthDisplay。認証の知らせのたびに来る）。同じ人なら今の状態を捨てずに比べ直すだけ
export function setAccountSession(session) {
  installListeners();
  const userId = session?.user?.id ?? null;
  if (userId !== account?.userId) {
    shown = null;
    failedSrc = "";
    render(null);
  }
  account = userId ? { userId } : null;
  refreshAccountEmblem();
}

// 描き直す。opts.announced = 幕を閉じた知らせのランク、opts.settled = 回の終わり・頭（プレイ中の印を見ない。幕が出ていれば替えない）、opts.retry = 読めなかった絵と材料も読み直す
export function refreshAccountEmblem({ announced = null, settled = false, retry = false } = {}) {
  if (typeof document === "undefined") return;
  if (retry) {
    failedSrc = "";
    learnFailed = false;
  }
  const next = account
    ? nextShown({ current: currentState(), shown, curtainOpen: !!document.querySelector(".rank-up"), running: !settled && isRunning(), announced })
    : null;
  render(next);
}

function render(state) {
  shown = state;
  const button = document.getElementById("avatarButton");
  const name = menuLabel(state);
  if (button && button.getAttribute("aria-label") !== name) button.setAttribute("aria-label", name); // 同じなら書かない（焦点のたびに名前の変化を起こさない）
  renderRow(state);
  renderEmblem(emblemUrl(state));
}

// メニューの一番上の行（#userStatus の前）。見える字は aria-hidden、読み上げは sr-only。押せる項目ではない（焦点を取らない・.account-menu__item を付けない）
function renderRow(state) {
  const status = document.getElementById("userStatus");
  let row = document.getElementById("accountRank");
  if (!state) {
    if (row) row.hidden = true;
    return;
  }
  if (!row) {
    if (!status?.parentElement) return;
    row = document.createElement("p");
    row.className = "account-menu__rank";
    row.id = "accountRank";
    row.innerHTML = `<span aria-hidden="true"></span><span class="sr-only"></span>`;
    status.parentElement.insertBefore(row, status);
  }
  row.firstElementChild.textContent = rankRowText(state);
  row.lastElementChild.textContent = rankRowSpeech(state);
  row.hidden = false;
}

// 紋章の img。新しい絵は透明のまま足し、読めたら前の絵と替える（届くまで前の絵か頭文字）。読めなければ新旧とも外して頭文字（前のランクの絵を残さない）。
// 遅れて届いた古い絵は、今の URL と違えば捨てる
function renderEmblem(src) {
  const avatar = document.getElementById("headerAvatar");
  if (!avatar) return;
  const imgs = [...avatar.querySelectorAll("img.avatar__emblem")];
  if (!src) {
    imgs.forEach((img) => img.remove());
    avatar.classList.remove("has-emblem");
    return;
  }
  if (imgs.some((img) => img.dataset.src === src)) {
    imgs.filter((img) => img.dataset.src !== src && !img.classList.contains("is-ready")).forEach((img) => img.remove()); // 読み込み中の別の絵は要らない
    return;
  }
  if (src === failedSrc) {
    imgs.forEach((img) => img.remove());
    avatar.classList.remove("has-emblem");
    return;
  }
  imgs.filter((img) => !img.classList.contains("is-ready")).forEach((img) => img.remove());
  const img = document.createElement("img");
  img.className = "avatar__emblem";
  img.dataset.src = src;
  img.width = 32;
  img.height = 32;
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.decoding = "async";
  img.draggable = false;
  img.setAttribute("fetchpriority", "low");
  img.addEventListener(
    "load",
    () => {
      if (!img.isConnected || emblemUrl(shown) !== src) {
        img.remove();
        return;
      }
      avatar.querySelectorAll("img.avatar__emblem").forEach((other) => other !== img && other.remove());
      img.classList.add("is-ready");
      avatar.classList.add("has-emblem");
    },
    { once: true }
  );
  img.addEventListener(
    "error",
    () => {
      if (!img.isConnected) return;
      if (emblemUrl(shown) === src) {
        failedSrc = src;
        avatar.querySelectorAll("img.avatar__emblem").forEach((other) => other.remove());
        avatar.classList.remove("has-emblem");
      } else {
        img.remove();
      }
    },
    { once: true }
  );
  img.src = src;
  avatar.append(img);
}

// 後へ回す（幕を閉じた知らせは Enter の keydown と同じ頃に来うる。入力の処理と同じタスクで DOM を触らない）
function later(run, timeout = 300) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout });
  else setTimeout(run, 50);
}

function installListeners() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("spelldash:rank-up-closed", (event) => {
    const announced = announcedFrom(event.detail);
    later(() => refreshAccountEmblem({ announced: announced ?? currentState() }));
  });
  window.addEventListener("spelldash:synced", () => refreshAccountEmblem());
  // 最高到達ランクを上げた（同じタブの学習状況・中心の学習の回の終わり: js/rank.js raiseRankPeak）。幕が出ていれば替えない（幕を閉じた知らせで替える）
  window.addEventListener("spelldash:rank-peak", () => later(() => refreshAccountEmblem()));
  window.addEventListener("spelldash:records-replaced", () => refreshAccountEmblem());
  // 回の終わり: 後へ回す。控えた幕は同じタスクで入るので、幕が出ていれば替えない
  window.addEventListener("spelldash:game-end", () => setTimeout(() => refreshAccountEmblem({ settled: true }), 0));
  // 回の頭: 回を始める処理と同じタスクで描かない
  window.addEventListener("spelldash:game-start", () => setTimeout(() => refreshAccountEmblem({ settled: true }), 0));
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === RANK_PEAK_KEY || event.key === OWNER_KEY || event.key === STORAGE_KEY) refreshAccountEmblem();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) refreshAccountEmblem();
  });
  window.addEventListener("online", () => refreshAccountEmblem({ retry: true }));
  // メニューを開く前（ホバー・焦点・クリック）: 今の材料で描き直す（幕とプレイの間は段を替えない）
  const user = document.getElementById("accountUser");
  user?.addEventListener("pointerenter", () => refreshAccountEmblem());
  user?.addEventListener("focusin", () => refreshAccountEmblem());
}
