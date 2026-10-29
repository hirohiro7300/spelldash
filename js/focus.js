// ===== 英単語の学習への絞り込み（Batch 78 段 5。創業者の決定 §7・§9 の 1・10・18） =====
//
// 主導線は ホーム・英単語を学ぶ・学習状況・アカウント／設定 だけ。旗（FOCUS_ENGLISH）が立っている間は:
//   ホーム（index.html・js/main.js）: ボタン「英単語を学ぶ」1 つと、覚えた N / 総数・ランク・学習状況へのリンクだけを描く。
//     本棚・積んだ本・「N冊から選ぶ」・コース・ほかの遊び方（Challenge・Daily・Battle）・Daily の札・出題の設定・連続日数・はちゃんの紙片・
//     前の数え方の「覚えた単語」は描かない（コードは残す）。初めての人の最初の本（js/welcome.js）も本を選ばせない。
//   古い画面・古い URL から来た人は、英単語のホームへ案内して 1 行だけ「英単語の学習にまとめました。」と知らせる（下の表）。
// 消さないもの: コード・保存の鍵（spelldash_category・spelldash_course・spelldash_packs・spelldash_mode・spelldash_session・
//   spelldash_book_pace・マイ単語帳など）・利用者の記録（非公開の語の記録も）。読まない・書かないだけ。
// 戻すとき: FOCUS_ENGLISH を false にし、index.html と profile.html の <html data-focus="english">（最初の描画の旗。CSS が見る）を外す。
//
// 古い URL（PRESTART「古い URL」・contradictions c5）:
//   ホーム（index.html）の ?words=（単語帳の「苦手だけ練習」の回）・?add=（パックを足す）・?category=（教材・巻を選ぶ）・?genre=（分野の絞り込み）・
//     ?from=old（転送とページの守りが付けるしるし。?from= のほかの値〔typing など〕は古い URL ではない）→ 値は使わない（回を始めない・パックを足さない・
//     鍵を書かない）。URL から外して、ホームに 1 行。単語帳の #packs・#myWords（配信の転送は # を持ち越す: /list.html#packs → /?from=old#packs）も外す
//   単語帳（list.html。マイ単語帳・#packs・#myWords・?add=・?category= を含む）→ js/listView.js が最初にページの守り（leaveOldScreen）
//   /packs/* と /packs/ → vercel.json の転送（permanent: false）とページの守り（段 5a）が MOVED_URL へ
//   タイピングの 2 ページ（typing.html・typing-game.html）→ vercel.json の転送（permanent: false）が MOVED_URL へ（Batch 78 段 6。創業者の決定 3。古いお知らせの
//     リンクは履歴のまま。ページとファイルは残す: アプリの器と E2E は直接開く）
//   保存した遊び方 spelldash_mode = challenge → ホームは中心の学習を始める（値は残す: js/game.js setMode の save: false）
//   古い形の続き（Study の spelldash_session）→ 出さない（鍵は残す: js/sessionResume.js resumableFor）
// Battle（battle.html）と加入画面（pro.html。noindex）は直接開けば今のまま動く（導線から外すだけ。段 5a・段 6）
//
// この module は import を持たない（どのページからも静的に読んでよい）

export const FOCUS_ENGLISH = true;

// 最初の描画の旗（html[data-focus]）の値
export const FOCUS_ATTR = "english";

// 古い画面から来た人への 1 行（index.html の #focusNote に同じ文を静的に置く）
export const FOCUS_NOTE = "英単語の学習にまとめました。";

// 案内の行き先（英単語のホーム）。?from=old は「古い画面から来た」しるし（ホームが 1 行を出して URL から外す。vercel.json の転送と
// パックのページの守り〔段 5a〕も同じ行き先）
export const MOVED_PARAM = "from";
export const MOVED_VALUE = "old";
export const MOVED_URL = `/?${MOVED_PARAM}=${MOVED_VALUE}`;

// 「英単語を学ぶ」の入口（js/learnQueue.js LEARN_NEXT。回を始めるときに今の記録からモードを決める）
export const LEARN_NEXT_URL = "/?learn=next";

// ホームで「古い URL」とみなす引数（あれば値によらず）と、しるし ?from=old（index.html の <head> の 1 行〔id="focusMoved"〕も同じ決まり。E2E が突き合わせる）
export const OLD_HOME_PARAMS = Object.freeze(["words", "add", "category", "genre"]);

// 古い URL と一緒に来たら外す単語帳の #（ホームの # はほかに #login などがあるので、この 2 つだけ）
export const OLD_HOME_HASHES = Object.freeze(["#packs", "#myWords"]);

export function isFocusOn() {
  return FOCUS_ENGLISH;
}

// 最初の描画の旗を FOCUS_ENGLISH に合わせる（index.html・profile.html の静的な旗と食い違ったときだけ書く）。
// 旗を外したときは index.html に静的に置いた英単語のホームの中身（.focus-home）も外す: 前のホームの #pathHead・#pathNow を空に戻す
// （読み込み中の高さ css/room.css の :empty が効き、js/pathView.js renderPath が描く。#pathStart が 2 つにならない）
export function applyFocusFlag(root = document.documentElement) {
  if (FOCUS_ENGLISH && root.dataset.focus !== FOCUS_ATTR) root.dataset.focus = FOCUS_ATTR;
  if (FOCUS_ENGLISH) return;
  if ("focus" in root.dataset) delete root.dataset.focus;
  root.querySelectorAll(".focus-home").forEach((el) => {
    const parent = el.parentElement;
    el.remove();
    if (parent && parent.children.length === 0) parent.textContent = ""; // 残った改行も消して :empty にする
  });
}

// URL の検索部分のうち、古い URL の引数（しるしの ?from=old を含む。無ければ空の配列）
export function oldHomeParams(search) {
  const q = new URLSearchParams(search);
  const found = OLD_HOME_PARAMS.filter((k) => q.has(k));
  if (q.get(MOVED_PARAM) === MOVED_VALUE) found.push(MOVED_PARAM);
  return found;
}

// ホームに来た古い URL を片付ける: 古い引数を URL から外し（履歴は増やさない。ほかの引数と # は残す）、1 行を出すかを返す。
// 旗が無ければ何もしない（false）。1 行を出すかは html[data-moved]（<head> の 1 行が最初の描画で置く）にも合わせる
export function takeOldHomeUrl() {
  if (!FOCUS_ENGLISH) return false;
  const found = oldHomeParams(location.search);
  const root = document.documentElement;
  if (found.length === 0) {
    delete root.dataset.moved;
    return false;
  }
  root.dataset.moved = "";
  try {
    const url = new URL(location.href);
    for (const k of found) url.searchParams.delete(k);
    if (OLD_HOME_HASHES.includes(url.hash)) url.hash = "";
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // 無視（開き直すともう一度 1 行が出るだけ）
  }
  return true;
}

// 古い画面（単語帳など）のページの守り: 旗が立っていれば英単語のホームへ置き換えて true（呼び手はそこで止まる）。
// location.replace なので戻るボタンで古い画面に戻らない。保存の鍵は何も書かない・消さない
export function leaveOldScreen() {
  if (!FOCUS_ENGLISH) return false;
  location.replace(MOVED_URL);
  return true;
}
