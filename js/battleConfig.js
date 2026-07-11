// ===== Battle Preseason の設定 =====
// スコア・RP・ランク・CPU性能はすべてここに集約する。
// 実際にプレイした感触に合わせて、このファイルだけで調整できるようにしておく。

export const BATTLE = {
  durationSeconds: 60,
  wordsPerSet: 40,
  // 両者の問題セットに適用する難易度ミックス（別々の問題・同じ構成比）
  levelMix: { easy: 0.4, normal: 0.4, hard: 0.2 },
  score: {
    base: 100,          // 自力正解
    speedBonusMax: 50,  // 速度ボーナス上限（速度だけで勝敗が決まらない範囲）
    speedWindowMs: 8000, // これ以上かかると速度ボーナス0
    noMissBonus: 10     // ノーミスボーナス
  },
  rp: { win: 20, draw: 5, loss: -10 }
};

export const RANKS = [
  { id: "bronze", label: "Bronze", min: 0 },
  { id: "silver", label: "Silver", min: 100 },
  { id: "gold", label: "Gold", min: 200 },
  { id: "platinum", label: "Platinum", min: 300 },
  { id: "diamond", label: "Diamond", min: 400 },
  { id: "master", label: "Master", min: 500 }
];

// ランクごとのCPU基本性能（プレイヤーが強いほど相手も強い。試合中の追従はしない）
export const CPU_BY_RANK = {
  bronze:   { accuracy: 0.5, avgAnswerMs: 7200, sdMs: 2200, passRate: 0.25, missRate: 0.25 },
  silver:   { accuracy: 0.6, avgAnswerMs: 6200, sdMs: 2000, passRate: 0.2, missRate: 0.22 },
  gold:     { accuracy: 0.7, avgAnswerMs: 5200, sdMs: 1800, passRate: 0.15, missRate: 0.2 },
  platinum: { accuracy: 0.78, avgAnswerMs: 4300, sdMs: 1500, passRate: 0.1, missRate: 0.18 },
  diamond:  { accuracy: 0.85, avgAnswerMs: 3600, sdMs: 1200, passRate: 0.07, missRate: 0.15 },
  master:   { accuracy: 0.92, avgAnswerMs: 2900, sdMs: 1000, passRate: 0.04, missRate: 0.12 }
};

// CPUタイプ（静かで知的な対戦相手。派手なキャラクター性は持たせない）
export const CPU_TYPES = [
  { id: "steady", label: "Steady", name: "アオイ", speedMul: 1.0, accuracyMod: 0.03, missMul: 0.8, passMul: 1.0 },
  { id: "sprinter", label: "Sprinter", name: "ハヤテ", speedMul: 0.72, accuracyMod: -0.07, missMul: 1.6, passMul: 1.1 },
  { id: "scholar", label: "Scholar", name: "シオン", speedMul: 1.3, accuracyMod: 0.09, missMul: 0.6, passMul: 0.7 },
  { id: "rival", label: "Rival", name: "リン", speedMul: 1.0, accuracyMod: 0, missMul: 1.0, passMul: 1.0 }
];

export function rankFromRp(rp) {
  let current = RANKS[0];
  for (const rank of RANKS) {
    if (rp >= rank.min) current = rank;
  }

  const index = RANKS.indexOf(current);
  const next = RANKS[index + 1] ?? null;

  return {
    ...current,
    next,
    // 次のランクまでの進捗（Masterは満タン表示）
    progress: next ? (rp - current.min) / (next.min - current.min) : 1,
    intoRank: rp - current.min,
    span: next ? next.min - current.min : 100
  };
}

// プレイヤーとCPUで同じ関数を使う（公平性）
export function calculateBattleScore({ answerMs, hadTypingMiss }) {
  const { base, speedBonusMax, speedWindowMs, noMissBonus } = BATTLE.score;
  const clamped = Math.min(Math.max(answerMs, 0), speedWindowMs);
  const speedBonus = Math.round((speedBonusMax * (speedWindowMs - clamped)) / speedWindowMs);
  return base + speedBonus + (hadTypingMiss ? 0 : noMissBonus);
}
