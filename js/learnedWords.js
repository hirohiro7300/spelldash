import { getWordStats } from "./storage.js";
import { findWord, getCategories, getWordsByCategory, getAllWords } from "./wordStore.js";
import { classifyWord } from "./categoryProgress.js";
import { localDateString } from "./stats.js";

// ===== 覚えた単語（語の粒度で見せる） =====
// 「覚えた」= 一度つまずいてから自力で思い出せた語。数字ではなく語で見せるための集計。

function categoryLabel(id) {
  return getCategories().find((c) => c.id === id)?.label ?? "";
}

// stat.history: 直近8回の {d: "YYYY-MM-DD", r: "o"|"x"}
export function historyOf(stat) {
  return Array.isArray(stat?.history) ? stat.history : [];
}

// 今日「覚えた」語: 最後に思い出せなかった（x）直後の o が今日（同日の回復も含む）。
// 覚えたあとの復習成功（x … o o o）は数えない。history は直近 8 回なので、x が流れた語は
// 入らない（覚えたのは 8 回より前なので、それで正しい）。
export function isLearnedToday(stat, today = localDateString()) {
  const h = historyOf(stat);
  const lastX = h.map((e) => e.r).lastIndexOf("x");
  if (lastX < 0) return false;
  const firstO = h.slice(lastX + 1).find((e) => e.r === "o");
  return !!firstO && firstO.d === today;
}

export function getLearnedWordsToday() {
  const stats = getWordStats();
  const list = [];
  for (const [id, stat] of Object.entries(stats)) {
    if (!isLearnedToday(stat)) continue;
    const word = findWord(id);
    if (!word) continue;
    list.push({ id, en: word.en, ja: word.ja, category: word.category, at: stat.lastRecallSuccessAt });
  }
  return list.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

// 覚えた語の数（ホームの見出し・学習データの概要・推移の記録が同じ数を使う。パックの語も含む）
export function getLearnedCount() {
  return getLearnedWordList().length;
}

// 習得の数（推移の記録用。覚えた数と同じ母集団＝id で 1 回）
export function getMasteredCount() {
  return getLearnedWordList().filter((w) => w.status === "mastered").length;
}

// 覚えた単語帳: 覚えた＋習得（知ってた語は除く）、新しい順。
// カテゴリ名は、いまのカテゴリ（spelldash_category）に同じ id があればそちら（道で覚えた名前）、
// 無ければ追加したパックの版、それも無ければ findWord の版（基本カテゴリの読み込み順）
export function getLearnedWordList() {
  const stats = getWordStats();
  const activeId = localStorage.getItem("spelldash_category") || "all";
  const inActive = new Map();
  if (activeId !== "all") for (const w of getWordsByCategory(activeId)) if (!inActive.has(w.id)) inActive.set(w.id, w);
  const inPack = new Map();
  for (const w of getAllWords()) if (w.pack && !inPack.has(w.id)) inPack.set(w.id, w);
  const list = [];
  for (const [id, stat] of Object.entries(stats)) {
    const status = classifyWord(stat);
    if (status !== "learning" && status !== "mastered") continue;
    const word = inActive.get(id) ?? inPack.get(id) ?? findWord(id);
    if (!word) continue;
    list.push({ id, en: word.en, ja: word.ja, category: word.category, label: categoryLabel(word.category), status, stat });
  }
  return list.sort((a, b) => (b.stat.lastRecallSuccessAt ?? "").localeCompare(a.stat.lastRecallSuccessAt ?? ""));
}

// 覚えた（learning＋習得）が記録にあるのに、語が引けない id の数（外したパックの語）。
// 覚えた単語帳には出せないので、件数だけ 1 行で添える
export function getDroppedLearnedCount() {
  let n = 0;
  for (const [id, stat] of Object.entries(getWordStats())) {
    const status = classifyWord(stat);
    if ((status === "learning" || status === "mastered") && !findWord(id)) n++;
  }
  return n;
}

export function getKnownWordList() {
  const stats = getWordStats();
  const list = [];
  for (const [id, stat] of Object.entries(stats)) {
    if (classifyWord(stat) !== "known") continue;
    const word = findWord(id);
    if (word) list.push({ id, en: word.en, ja: word.ja });
  }
  return list.sort((a, b) => a.en.localeCompare(b.en));
}

// 記憶ゲージ: 習得（ノーミス連続10・複数日）までの距離と、次の復習まで
export function memoryGaugeHtml(stat) {
  if (!stat || (stat.playCount ?? 0) === 0) return "";
  const streak = Math.min(10, stat.cleanCorrectStreak ?? 0);
  let due = "";
  if (stat.mastered) {
    due = "習得";
  } else if (stat.nextReviewAt) {
    const days = Math.ceil((Date.parse(stat.nextReviewAt) - Date.now()) / 86400000);
    due = days <= 0 ? "復習: 今日" : `復習: ${days}日後`;
  }
  return `<span class="mem" title="ノーミスで思い出せた連続回数（1日1回まで進む）。10で習得"><i class="mem__bar"><b style="width:${streak * 10}%"></b></i><small>${streak}/10${due ? ` ・ ${due}` : ""}</small></span>`;
}

// 履歴ドット（× × ○ ○）。日付はtitleに
export function historyDotsHtml(stat, max = 8) {
  const h = historyOf(stat).slice(-max);
  if (h.length === 0) return "";
  const word = (r) => (r === "o" ? "思い出せた" : "思い出せず");
  return `<span class="hist" role="img" aria-label="履歴: ${h.map((e) => word(e.r)).join(", ")}">${h
    .map((e) => `<i class="hist__${e.r}" title="${e.d} ${word(e.r)}" aria-hidden="true"></i>`)
    .join("")}</span>`;
}
