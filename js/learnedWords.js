import { getWordStats } from "./storage.js";
import { findWord, getCategories } from "./wordStore.js";
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

// 今日「覚えた」語: 今日 o があり、それより前に x がある（同日の回復も含む）
export function isLearnedToday(stat, today = localDateString()) {
  const h = historyOf(stat);
  const todayIdx = h.findIndex((e) => e.d === today && e.r === "o");
  if (todayIdx < 0) return false;
  return h.slice(0, todayIdx).some((e) => e.r === "x");
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

// 覚えた単語帳: 覚えかけ＋習得（知ってた語は除く）、新しい順
export function getLearnedWordList() {
  const stats = getWordStats();
  const list = [];
  for (const [id, stat] of Object.entries(stats)) {
    const status = classifyWord(stat);
    if (status !== "learning" && status !== "mastered") continue;
    const word = findWord(id);
    if (!word) continue;
    list.push({ id, en: word.en, ja: word.ja, category: word.category, label: categoryLabel(word.category), status, stat });
  }
  return list.sort((a, b) => (b.stat.lastRecallSuccessAt ?? "").localeCompare(a.stat.lastRecallSuccessAt ?? ""));
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
    due = "習得済み";
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
  return `<span class="hist" aria-label="思い出せた履歴">${h
    .map((e) => `<i class="hist__${e.r}" title="${e.d} ${e.r === "o" ? "思い出せた" : "思い出せず"}"></i>`)
    .join("")}</span>`;
}
