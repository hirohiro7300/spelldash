import { getWordStats, getBestScore, getTypingStats } from "./storage.js";
import { getAllWords } from "./wordStore.js";

export function computeSummary() {
  const stats = getWordStats();
  const entries = Object.values(stats);
  const words = getAllWords();

  // 語は id で 1 回だけ数える（同じ id が基本カテゴリとパックに別々に入っている）。
  // 分子も「いま読み込んでいる語」に限る（外したパックや消したマイ単語の記録を数えない＝分母と同じ母集団）
  const ids = new Set(words.map((word) => word.id));
  const total = ids.size;
  const loaded = Object.entries(stats).filter(([id]) => ids.has(id)).map(([, data]) => data);
  const learned = loaded.filter((data) => (data.playCount ?? 0) > 0).length;
  const mastered = loaded.filter((data) => data.mastered).length;

  const totalCorrect = entries.reduce((sum, data) => sum + (data.correctCount ?? 0), 0);
  const totalMiss = entries.reduce((sum, data) => sum + (data.missCount ?? 0), 0);
  const totalPlays = entries.reduce((sum, data) => sum + (data.playCount ?? 0), 0);

  const attempts = totalCorrect + totalMiss;
  const accuracy = attempts > 0 ? Math.round((totalCorrect / attempts) * 100) : 0;
  const masteryRate = total > 0 ? Math.round((mastered / total) * 100) : 0;

  return {
    best: getBestScore(),
    total,
    learned,
    mastered,
    masteryRate,
    totalCorrect,
    totalMiss,
    totalPlays,
    accuracy
  };
}

export function computeTypingSummary() {
  const typing = getTypingStats();

  const totalTaps = typing.correctChars + typing.missChars;
  const tapsPerSecond = typing.seconds > 0 ? totalTaps / typing.seconds : 0;
  const mistypeRate = totalTaps > 0 ? (typing.missChars / totalTaps) * 100 : 0;
  const minutes = typing.seconds / 60;
  const wordsPerMinute = minutes > 0 ? typing.correctChars / 5 / minutes : 0;

  return {
    sessions: typing.sessions,
    totalTaps,
    tapsPerSecond,
    mistypeRate,
    bestSpeed: typing.bestSpeed,
    wordsPerMinute,
    seconds: typing.seconds
  };
}
