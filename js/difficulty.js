import { getLevelState } from "./level.js";

// 単語難易度のレベル解放。
// 「最初から難しい単語が出て離脱する」を防ぎ、レベルアップに
// 「新しい単語が解放される」という報酬性を持たせる。
//
// 適用範囲: 新出単語の導入（Study補充・Challenge抽選・ミッションNew）のみ。
//   - 既にプレイしたことのある単語は常に出題対象（学習記録を壊さない）
//   - Daily Dash は全員共通問題のため適用しない（公平性維持）

export const UNLOCK_NORMAL_LEVEL = 5;
export const UNLOCK_HARD_LEVEL = 10;

// ===== 難易度の自動引き上げ =====
// 初見の新語を「知ってた」割合が高い人（社会人の学び直し等）に、
// レベルを待たずに次の難易度を混ぜる。直近12語中9語以上知っていたら1段上げる。
const FIRST_SIGHT_KEY = "spelldash_first_sight";
const BOOST_KEY = "spelldash_level_boost";
const BOOST_NOTE_KEY = "spelldash_level_boost_note";
const FIRST_SIGHT_WINDOW = 12;
const FIRST_SIGHT_THRESHOLD = 9;

export function getLevelBoost() {
  const v = Number(localStorage.getItem(BOOST_KEY)) || 0;
  return Math.max(0, Math.min(2, v));
}

// ===== 初回の腕試し（Placement） =====
// 初回セッションの先頭10語（易3・普通4・難3）の「知ってた／知らなかった」で、
// 12語の観察を待たずに難易度を即決定する。社会人の初回が apple/water で終わらないように。
const PLACEMENT_KEY = "spelldash_placement";
const PLACEMENT_NOTE_KEY = "spelldash_placement_note";
export const PLACEMENT_WORDS = 10;
export const PLACEMENT_MIX = { easy: 3, normal: 4, hard: 3 };

export function isPlacementPending() {
  return !localStorage.getItem(PLACEMENT_KEY);
}

export function markPlacementStarted() {
  if (isPlacementPending()) localStorage.setItem(PLACEMENT_KEY, "started");
}

function isPlacementRunning() {
  return localStorage.getItem(PLACEMENT_KEY) === "started";
}

function finishPlacement(log) {
  const known = log.filter(Boolean).length;
  const boost = known >= 9 ? 2 : known >= 6 ? 1 : 0;
  if (boost > getLevelBoost()) localStorage.setItem(BOOST_KEY, String(boost));
  const result = { known, total: log.length, boost, at: new Date().toISOString() };
  localStorage.setItem(PLACEMENT_KEY, JSON.stringify(result));
  localStorage.setItem(PLACEMENT_NOTE_KEY, JSON.stringify(result));
  return result;
}

// 腕試し直後の案内を1回だけ取り出す（{known, total, boost}）
export function consumePlacementNote() {
  const raw = localStorage.getItem(PLACEMENT_NOTE_KEY);
  if (!raw) return null;
  localStorage.removeItem(PLACEMENT_NOTE_KEY);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 初見の結果を記録し、条件を満たせば1段ブースト（戻すことはしない）
export function recordFirstSight(known) {
  let log = [];
  try {
    log = JSON.parse(localStorage.getItem(FIRST_SIGHT_KEY) || "[]");
    if (!Array.isArray(log)) log = [];
  } catch {
    log = [];
  }
  log.push(!!known);

  // 腕試し中: 10語そろった時点で判定して終了（以降は12語窓の通常判定）
  if (isPlacementRunning()) {
    if (log.length >= PLACEMENT_WORDS) {
      const result = finishPlacement(log);
      localStorage.setItem(FIRST_SIGHT_KEY, "[]");
      return { boosted: result.boost > 0, placement: result };
    }
    localStorage.setItem(FIRST_SIGHT_KEY, JSON.stringify(log));
    return { boosted: false };
  }

  log = log.slice(-FIRST_SIGHT_WINDOW);

  let boosted = false;
  if (log.length >= FIRST_SIGHT_WINDOW && log.filter(Boolean).length >= FIRST_SIGHT_THRESHOLD && getLevelBoost() < 2) {
    localStorage.setItem(BOOST_KEY, String(getLevelBoost() + 1));
    localStorage.setItem(BOOST_NOTE_KEY, "1");
    log = [];
    boosted = true;
  }
  localStorage.setItem(FIRST_SIGHT_KEY, JSON.stringify(log));
  return { boosted };
}

// ブースト直後の案内を1回だけ取り出す
export function consumeBoostNote() {
  if (localStorage.getItem(BOOST_NOTE_KEY) !== "1") return false;
  localStorage.removeItem(BOOST_NOTE_KEY);
  return true;
}

function tierForLevel(playerLevel) {
  if (playerLevel < UNLOCK_NORMAL_LEVEL) return 0;
  if (playerLevel < UNLOCK_HARD_LEVEL) return 1;
  return 2;
}

// 解放されている難易度のSet。全解放ならnull（フィルタ不要の意）
export function allowedWordLevels(playerLevel = getLevelState().level) {
  const tier = Math.max(tierForLevel(playerLevel), getLevelBoost());
  if (tier === 0) return new Set(["easy"]);
  if (tier === 1) return new Set(["easy", "normal"]);
  return null;
}

export function isWordLevelAllowed(word, allowed = allowedWordLevels()) {
  return !allowed || allowed.has(word.level);
}

// 新出単語リストへのゲート適用。
// 解放難易度の語が1語も無いカテゴリ（例: ITはeasy 0語）では、
// そのカテゴリに存在する最も易しい難易度を許可する。
// カテゴリ選択はユーザーの明示的な意思なので「何も出ない」を絶対に作らない
export function filterByAllowedLevels(words, allowed = allowedWordLevels()) {
  if (!allowed) return words;

  const gated = words.filter((w) => allowed.has(w.level));
  if (gated.length > 0) return gated;

  for (const level of ["easy", "normal", "hard"]) {
    const fallback = words.filter((w) => w.level === level);
    if (fallback.length > 0) return fallback;
  }

  return words;
}

// レベルアップ時の解放メッセージ（該当しなければ空文字）
export function unlockNoteForLevel(level) {
  if (level === UNLOCK_NORMAL_LEVEL) return " 🔓 新しい難易度の単語が解放！";
  if (level === UNLOCK_HARD_LEVEL) return " 🔓 最高難易度の単語が解放！";
  return "";
}
