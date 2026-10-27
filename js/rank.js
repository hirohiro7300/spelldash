// ===== ランク（覚えた語数の 9 段。Batch 78。創業者の決定 §5）の決まりと、最高到達ランクの鍵 =====
// 段は公開の語のうち「覚えた」の語数（js/learnState.js countLearnStates の learned）だけで決まる。XP・ログイン日数・Battle の RP・課金は使わない。
// 一度届いた段は下がらない: 見せるランク = max（最高到達ランク, 今の語数の段）。画面の数（覚えた N / 総数・次のランクまであと M 語・3 状態の語数）は
// 今の状態から正直に数える（最高到達ランクと今の覚えた語数は別の値）。下がった演出・知らせは出さない。
// 最高到達ランクは端末だけの鍵 spelldash_rank_peak（段の番号 0〜8 の数字の文字列。送らない。バックアップに入る。別のアカウントに替えると消える: js/backup.js）。
// 書くのは中心の学習の回の終わりと学習状況の表示だけ（移行・取り込み・復元のタスクでは数え直さない。復元は前・バックアップ・今の数の大きい方: js/backup.js）。
// 上の純な関数は import なし・DOM なし（Node から直に読む: scripts/test-learn-state.mjs）。鍵を読む・書く関数だけが端末の保存に触る（失敗しても投げない）。
// 名前は語彙の量の主張にしない（「中学生レベル」とは書かない）。新しい段の絵はまだ無い（文字で出す）。

export const RANK_NAMES = Object.freeze(["赤ちゃん", "よちよち", "単語キッズ", "小学生", "中学生", "高校生", "留学生", "バイリンガル", "アメリカ人"]);
// 1〜8 段の境（覚えた語数）。最後の段（アメリカ人）の境は公開の語数（js/publicVocab.js total。語を足したら、1〜8 段は動かさず、ここだけが新しい総数になる）
const RANK_FROM = Object.freeze([0, 120, 350, 650, 1000, 1400, 1850, 2350]);
export const RANK_TOP = RANK_NAMES.length - 1;
export const RANK_PEAK_KEY = "spelldash_rank_peak";

// 9 段の境（覚えた語数）。total = 公開の語数
export function rankThresholds(total) {
  return [...RANK_FROM, total];
}

// 今の覚えた語数の段（0 = 赤ちゃん 〜 8 = アメリカ人）。境ちょうどでその段
export function rankFor(count, total) {
  const n = Number.isFinite(count) ? count : 0;
  const at = rankThresholds(total);
  let rank = 0;
  for (let k = 1; k < at.length; k++) if (n >= at[k]) rank = k;
  return rank;
}

// 見せるランク（下がらない）: 最高到達ランクと今の語数の段の大きい方
export function shownRank(count, peak, total) {
  return Math.max(rankFor(count, total), parseRankPeak(peak) ?? 0);
}

// 次のランクまで: 見せている段の次の段と、その境までの残り（M = 境 − 今の覚えた語数。覚えたが減っていれば段の幅より大きくなりうる）。
// 最後の段（アメリカ人）なら null（「あと M 語」の行を出さない）
export function nextRankGap(count, rank, total) {
  if (!Number.isInteger(rank) || rank >= RANK_TOP) return null;
  const next = Math.max(rank + 1, 1);
  const at = rankThresholds(total)[next];
  return { rank: next, name: RANK_NAMES[next], at, remaining: Math.max(0, at - (Number.isFinite(count) ? count : 0)) };
}

// 保存の値 → 段の番号（0〜8 の整数）。無い・読めない値は null
export function parseRankPeak(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= RANK_TOP ? n : null;
}

// 最高到達ランク（無ければ null）
export function readRankPeak(storage = globalThis.localStorage) {
  try {
    return parseRankPeak(storage?.getItem(RANK_PEAK_KEY));
  } catch {
    return null;
  }
}

// 最高到達ランクを rank まで上げる（下げない: 保存の値 = max（保存の値, rank））。書くタスクの中で保存を読み直してから比べる
// （ほかのタブ・前の人の値をメモリーから持ち越さない）。返り値 { peak: 書いた後の値, saved: 書けた・書く必要が無かったら true、書けなかったら false }。
// 上げたら、同じタブに spelldash:rank-peak（detail.peak）を知らせる（アカウントのアイコン js/accountEmblem.js が描き直す。ほかのタブは storage イベント）
export function raiseRankPeak(rank, storage = globalThis.localStorage) {
  const stored = readRankPeak(storage);
  const want = parseRankPeak(rank);
  if (want === null || (stored !== null && stored >= want)) return { peak: stored, saved: true };
  try {
    storage.setItem(RANK_PEAK_KEY, String(want));
  } catch {
    return { peak: stored, saved: false };
  }
  notifyRankPeak(want);
  return { peak: want, saved: true };
}

function notifyRankPeak(peak) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  try {
    window.dispatchEvent(new CustomEvent("spelldash:rank-peak", { detail: { peak } }));
  } catch {
    // 知らせは飾り（アイコンは次の描き直しで合う）。書けた値はそのまま
  }
}

// ===== 画面の形（学習状況・アカウントのアイコン。Batch 78 段 4） =====
// 見せるランク（下がらない）と、次のランクまでの残り（今の覚えた語数から正直に。最後の段なら next は null = 「あと M 語」の行を出さない）
export function rankView(count, peak, total) {
  const rank = shownRank(count, peak, total);
  return { rank, name: RANK_NAMES[rank], next: nextRankGap(count, rank, total) };
}

// 段の番号 → 名前（範囲の外・読めない値は null）
export function rankName(rank) {
  const r = parseRankPeak(rank);
  return r === null ? null : RANK_NAMES[r];
}

// 名前 → 段の番号（知らない名前は null）
export function rankOfName(name) {
  const i = RANK_NAMES.indexOf(name);
  return i >= 0 ? i : null;
}
