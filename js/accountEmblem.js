// ログイン中の人のアカウントのアイコン（ヘッダーの #headerAvatar。38px の丸、720px 以下は 32px）を、今の学習のランク（js/level.js。XP から決まる 21 段）の紋章にする。
// ボタンの名前は「アカウントメニュー（銀 2）」、メニューの一番上の行は「銀 2 ・ Lv.15」（読み上げは「銀 2、レベル 15」）。Battle の RP のランクと Pro は入れない。
// js/auth.js が、ログインしているときだけ読み込みの後の手の空いたときに動的 import で読む（最初の描画・LCP を待たせない。静的 import は modulepreload を変える）。
// 未ログイン・アプリ（ログインしない）では読まない。HTML は 7 ページとも同じ形で、中身はここで替える（頭文字の span は js/auth.js が置く）。
//
// ランクが決まる・決まらない: 決まるのは、端末の持ち主の印（js/sync.js OWNER_KEY）がこのアカウントか、このタブで同期を終えた（js/sync.js DONE_FLAG）とき。
//   それ以外（持ち主が別のアカウント・持ち主の印が無く同期がまだ・同期の失敗・壊れた XP）は頭文字のまま、ボタンの名前は「アカウントメニュー」、行は出さない。
// 絵がまだ・読めない（404・オフライン）・遅い: 頭文字のまま（ボタンの名前と行はランクを出す）。壊れた画像の印を出さない（js/emblem.js の作法）。
// 替える時機（nextShown）: このタブのプレイで上がったランクは、ランクの幕（js/game.js celebrateRankUp）を閉じた知らせ（spelldash:rank-up-closed）の後に替える。
//   幕が出ている間とプレイ中（60 秒の回・腕試しは幕を回の終わりに控える）は段を替えない（同じ段なら Lv だけ新しく）。回の終わり（spelldash:game-end）は幕より先に
//   来るので、それでは段を替えない。同期（spelldash:synced）・別のタブ（storage）・メニューを開く前は、幕とプレイの外ならそのまま替える（上がる・下がる）。
import { getLevelState, getTotalXp, LEARNING_RANKS } from "./level.js";
import { emblemSrc } from "./emblem.js";

export const OWNER_KEY = "spelldash_owner"; // js/sync.js OWNER_KEY（localStorage。最後に同期できたアカウントの user id）
export const SYNC_DONE_KEY = "spelldash_sync_done_this_session"; // js/sync.js DONE_FLAG（sessionStorage。このタブで同期を最後まで終えた user id）
export const XP_KEY = "spelldash_xp"; // js/level.js XP_KEY
// これより大きい XP は壊れた値として扱う（Lv. 約 2,000。神 3 は Lv.92 = 213,850）。getLevelState は 1 レベルずつ数えるので、Infinity や 1e300 では止まらない
export const MAX_XP = 1e8;
const MENU_LABEL = "アカウントメニュー";

// ---- 決める（DOM なし。scripts/test-account-emblem.mjs） ----

// 保存の XP（js/level.js getTotalXp と同じ読み方。壊れた値は Infinity・NaN のまま返し、accountRankState が「決まらない」にする）
export function readXp() {
  return getTotalXp();
}

// ランクが決まれば { rank, level }、決まらなければ null
export function accountRankState({ userId, owner, syncedUser, xp }) {
  if (!userId) return null;
  if (owner !== userId && syncedUser !== userId) return null;
  if (!Number.isFinite(xp) || xp > MAX_XP) return null;
  const state = getLevelState(xp);
  return { rank: state.rank, level: state.level };
}

export function menuLabel(state) {
  return state ? `${MENU_LABEL}（${state.rank.name}）` : MENU_LABEL;
}

// メニューの一番上の行（学習データの行 js/levelUi.js と同じ書き方）と、その読み上げ（「Lv.」を「レベル」に。「エルブイ」と読まれない）
export function rankRowText(state) {
  return `${state.rank.name} ・ Lv.${state.level}`;
}

export function rankRowSpeech(state) {
  return `${state.rank.name}、レベル ${state.level}`;
}

// 紋章の絵（96px の小さい絵。学習データの行・ランクの一覧と同じ）。決まらない・知らないランクは ""
export function emblemUrl(state) {
  return state ? emblemSrc(state.rank, { small: true }) : "";
}

const sameRank = (a, b) => !!a && !!b && a.rank.name === b.rank.name;

// 次に出す状態。current = 今の XP から（決まらなければ null）、shown = 今出している状態、curtainOpen = ランクの幕が出ている、
// running = プレイ中（または段を替えない描き直し）、announced = 幕を閉じた知らせで見せたランク
export function nextShown({ current, shown = null, curtainOpen = false, running = false, announced = null }) {
  if (!current) return null;
  if (announced) {
    // 幕で見せた。プレイ中なら幕で見せたランクまで（そのあと回の間に次の段へ進んでいても、その幕はまだ）
    if (!running || sameRank(announced, current)) return current;
    return announced;
  }
  if (curtainOpen) return shown;
  if (running) return sameRank(shown, current) ? current : shown;
  return current;
}

// 幕を閉じた知らせの detail（{ rank: ランクの名前, level }）→ { rank, level }。壊れていれば null
export function announcedFrom(detail) {
  const rank = LEARNING_RANKS.find((r) => r.name === detail?.rank);
  const level = Number(detail?.level);
  if (!rank || !Number.isInteger(level) || level < rank.level) return null;
  return { rank, level };
}

// ---- 描く（ブラウザ） ----

let account = null; // { userId }（null = 未ログイン）
let shown = null; // 今出している { rank, level }（null = 頭文字）
let failedSrc = ""; // 読めなかった絵の URL（通信が戻るか段が替わるまで取り直さない。知らせのたびに 404 を取りに行かない）
let installed = false;

function storageValue(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function currentState() {
  try {
    return accountRankState({
      userId: account?.userId ?? null,
      owner: storageValue(localStorage, OWNER_KEY),
      syncedUser: storageValue(sessionStorage, SYNC_DONE_KEY),
      xp: readXp()
    });
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

// 描き直す。opts.announced = 幕を閉じた知らせのランク、opts.levelOnly = 段は替えない（回の終わり: 控えた幕がまだ出ていないことがある）、opts.retry = 読めなかった絵も読み直す
export function refreshAccountEmblem({ announced = null, levelOnly = false, retry = false } = {}) {
  if (typeof document === "undefined") return;
  if (retry) failedSrc = "";
  const next = account
    ? nextShown({ current: currentState(), shown, curtainOpen: !!document.querySelector(".rank-up"), running: levelOnly || isRunning(), announced })
    : null;
  render(next);
}

function render(state) {
  shown = state;
  const button = document.getElementById("avatarButton");
  if (button) button.setAttribute("aria-label", menuLabel(state));
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
  // 回の終わり: 段は替えない（控えた幕は game-end の後に足される）。Lv だけ新しく（Challenge は game-end の後に XP を足すので後へ回す）
  window.addEventListener("spelldash:game-end", () => setTimeout(() => refreshAccountEmblem({ levelOnly: true }), 0));
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === XP_KEY || event.key === OWNER_KEY) refreshAccountEmblem();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) refreshAccountEmblem();
  });
  window.addEventListener("online", () => refreshAccountEmblem({ retry: true }));
  // メニューを開く前（ホバー・焦点・クリック）: Lv を新しくする（幕とプレイの間は段を替えない）
  const user = document.getElementById("accountUser");
  user?.addEventListener("pointerenter", () => refreshAccountEmblem());
  user?.addEventListener("focusin", () => refreshAccountEmblem());
}
