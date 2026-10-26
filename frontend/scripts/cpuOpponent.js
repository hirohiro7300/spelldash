import { CPU_BY_RANK, CPU_TYPES, calculateBattleScore } from "./battleConfig.js";

// ===== CPU対戦相手 =====
// 生成AI・外部APIは使わない。ローカルの確率・時間モデルで、
// 「問題開始 → 入力進捗 → 正解/Pass → 次へ」を問題ごとに進行させる。
// 最終スコアを先に決めて辻褄を合わせる方式にはしない
// （イベントの列で進むため、将来のGhost Match再生にそのまま流用できる）。

const TICK_MS = 100;
const LEVEL_TIME_FACTOR = { easy: 0.9, normal: 1.0, hard: 1.15 };
const LEVEL_ACCURACY_MOD = { easy: 0.05, normal: 0, hard: -0.08 };

function gaussian(mean, sd) {
  // Box-Muller。極端な値は切り詰める
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  const value = mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(mean * 0.35, Math.min(value, mean * 2.5));
}

export function createCpuOpponent({ rankId, words, onEvent }) {
  const base = CPU_BY_RANK[rankId] ?? CPU_BY_RANK.bronze;
  const type = CPU_TYPES[Math.floor(Math.random() * CPU_TYPES.length)];

  const profile = {
    typeId: type.id,
    typeLabel: type.label,
    name: type.name,
    accuracy: Math.min(0.98, Math.max(0.2, base.accuracy + type.accuracyMod)),
    avgAnswerMs: base.avgAnswerMs * type.speedMul,
    sdMs: base.sdMs,
    passRate: Math.min(0.5, base.passRate * type.passMul),
    missRate: Math.min(0.6, base.missRate * type.missMul)
  };

  let state = null;
  let timer = null;
  let startTime = null;
  let wordIndex = 0;

  const stats = { score: 0, combo: 0, correct: 0, passes: 0, misses: 0 };

  // 現在の単語の「計画」を立てる（結果と所要時間を先に決め、進捗だけ逐次見せる）
  function planWord(word) {
    const len = word.en.length;
    const levelFactor = LEVEL_TIME_FACTOR[word.level] ?? 1.0;
    const lengthFactor = 0.6 + len * 0.08; // 5文字≒1.0、10文字≒1.4
    const accuracy = profile.accuracy + (LEVEL_ACCURACY_MOD[word.level] ?? 0);

    // 判定: まずPassするか → しないなら正答率で正解/不正解（不正解もPass扱い）
    let outcome;
    if (Math.random() < profile.passRate) {
      outcome = "pass";
    } else {
      outcome = Math.random() < accuracy ? "correct" : "pass";
    }

    const hasMiss = Math.random() < profile.missRate;

    let durationMs = gaussian(profile.avgAnswerMs * levelFactor * lengthFactor, profile.sdMs);
    if (hasMiss) durationMs *= 1.35; // ミスは時間で払う（Challengeと同じ思想）
    if (outcome === "pass") durationMs = gaussian(profile.avgAnswerMs * 0.8, profile.sdMs * 0.7);

    return {
      word,
      len,
      durationMs,
      outcome,
      hasMiss,
      startedAt: null,
      gapMs: 300 + Math.random() * 400 // 次の問題までの間
    };
  }

  function tick() {
    if (!state) return;
    const now = Date.now();
    const elapsed = now - state.startedAt;

    if (elapsed < state.durationMs) {
      // 入力進捗（文字数ベースのドットのみ。実際の文字は見せない）
      const progress = Math.min(state.len, Math.floor((elapsed / state.durationMs) * state.len));
      onEvent({ type: "progress", done: progress, total: state.len });
      return;
    }

    // 単語の決着
    const timeMs = now - startTime;

    if (state.outcome === "correct") {
      onEvent({ type: "progress", done: state.len, total: state.len }); // 正解時は打ち切った表示に
      if (state.hasMiss) stats.misses += 1;
      stats.combo = state.hasMiss ? 0 : stats.combo + 1;
      stats.correct += 1;
      stats.score += calculateBattleScore({
        answerMs: state.durationMs,
        hadTypingMiss: state.hasMiss
      });
      onEvent({ type: "correct", timeMs, score: stats.score, combo: stats.combo });
    } else {
      stats.passes += 1;
      stats.combo = 0;
      onEvent({ type: "pass", timeMs, score: stats.score, combo: 0 });
    }

    // 次の単語へ（少し間を置く）
    const nextWord = words[wordIndex % words.length];
    wordIndex += 1;
    const gap = state.gapMs;
    state = null;

    setTimeout(() => {
      if (!timer) return;
      state = planWord(nextWord);
      state.startedAt = Date.now();
      onEvent({ type: "word-start", ja: nextWord.ja, total: nextWord.en.length });
    }, gap);
  }

  return {
    profile,
    stats,
    start() {
      startTime = Date.now();
      const firstWord = words[wordIndex % words.length];
      wordIndex += 1;
      state = planWord(firstWord);
      state.startedAt = Date.now();
      onEvent({ type: "word-start", ja: firstWord.ja, total: firstWord.en.length });
      timer = setInterval(tick, TICK_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      state = null;
    }
  };
}
