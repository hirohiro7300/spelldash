import { BATTLE, rankFromRp } from "./battleConfig.js";

// ===== Battle戦績のLocal First保存 =====
// Rank（勝敗で上下する現在の実力）は、Level（下がらない学習量）とは別物として扱う。

const BATTLE_KEY = "spelldash_battle";
const PENDING_SESSIONS_KEY = "spelldash_pending_battles";

export function getBattleStore() {
  const defaults = {
    rp: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    currentWinStreak: 0,
    bestWinStreak: 0,
    updatedAt: null
  };

  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(BATTLE_KEY)) || {}) };
  } catch {
    return defaults;
  }
}

export function saveBattleStore(store) {
  localStorage.setItem(BATTLE_KEY, JSON.stringify(store));
}

export function getRankState() {
  return rankFromRp(getBattleStore().rp);
}

// 試合結果を戦績へ反映（localStorageへ即保存）。RPは0未満にしない
export function applyMatchResult(result) {
  const store = getBattleStore();
  const rpBefore = store.rp;
  const rankBefore = rankFromRp(rpBefore);

  const rpChange =
    result === "win" ? BATTLE.rp.win : result === "draw" ? BATTLE.rp.draw : BATTLE.rp.loss;

  store.rp = Math.max(0, store.rp + rpChange);

  if (result === "win") {
    store.wins += 1;
    store.currentWinStreak += 1;
    store.bestWinStreak = Math.max(store.bestWinStreak, store.currentWinStreak);
  } else if (result === "loss") {
    store.losses += 1;
    store.currentWinStreak = 0;
  } else {
    store.draws += 1;
  }

  store.updatedAt = new Date().toISOString();
  saveBattleStore(store);

  const rankAfter = rankFromRp(store.rp);

  return {
    rpBefore,
    rpChange: store.rp - rpBefore, // 0クリップ後の実際の変化量
    rpAfter: store.rp,
    rankBefore,
    rankAfter,
    promoted: rankAfter.min > rankBefore.min,
    demoted: rankAfter.min < rankBefore.min,
    store
  };
}

// ===== battle_sessions 送信待ち行列（同期失敗時の再送用） =====

export function queueBattleSession(sessionRow) {
  const pending = getPendingBattleSessions();
  pending.push(sessionRow);
  localStorage.setItem(PENDING_SESSIONS_KEY, JSON.stringify(pending));
}

export function getPendingBattleSessions() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_SESSIONS_KEY)) || [];
  } catch {
    return [];
  }
}

export function clearPendingBattleSessions() {
  localStorage.setItem(PENDING_SESSIONS_KEY, JSON.stringify([]));
}
