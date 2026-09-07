import { getWordStats } from "./storage.js";
import { getWordsByCategory } from "./wordStore.js";
import { getTodayMission } from "./mission.js";
import { setDailyLearning, localDateString } from "./stats.js";
import { getFamiliarRatio } from "./studyMix.js";
import {
  allowedWordLevels,
  filterByAllowedLevels,
  recordFirstSight,
  isPlacementPending,
  markPlacementStarted,
  PLACEMENT_MIX
} from "./difficulty.js";
import {
  MAX_ACTIVE_NEW_WORDS,
  NEW_WORD_DAILY_SUCCESS_TARGET,
  NEW_WORD_REVIEW_GAPS
} from "./studyConfig.js";

// ===== Study Recall Loop ＋ New Word Learning Loop のキュー =====
//
// 出題の優先順位:
//   1. Unresolved（自力正解するまで日をまたいでも残る）
//   2. Today's Mission の Review
//   3. SRS復習期限到来
//   4. 学習中New単語の同日反復（前セッションからの持ち越し含む）
//   5. 通常補充 … ここだけ Mix Control の比率（回答済み/未回答）で構成
//
// 単語プール:
//   Familiar = 過去に自力正解済み（lastRecallSuccessAtあり）かつ非Unresolved
//   New      = 一度も回答していない（playCount === 0）
//
// New Word Learning Loop（Study限定）:
//   New単語は導入時に「学習中」となり、同日に自力正解を重ねるごとに
//   [3,5,8]問後(±1)に再出題 → 4回目で Today Secured（今日はもう出ない）。
//   途中で思い出せなければ段階が1つ戻る。同時学習は最大3語。

const MIN_QUEUE = 8;
const WEAK_ONLY_KEY = "spelldash_weak_only";

// 苦手のみ復習モード: プールを「苦手単語」に絞る（全出題経路に効く）
let weakOnly = localStorage.getItem(WEAK_ONLY_KEY) === "1";

export function isWeakOnlyMode() {
  return weakOnly;
}

export function setWeakOnlyMode(value) {
  weakOnly = !!value;
  localStorage.setItem(WEAK_ONLY_KEY, weakOnly ? "1" : "0");
}

// 苦手 = 未習得 かつ（思い出せなかったことがある / 打ち間違いが多い / 未解決）
export function isWeakStat(stat) {
  if (!stat || stat.mastered) return false;
  return (stat.recallFail ?? 0) > 0 || (stat.typingMiss ?? 0) >= 3 || isUnresolved(stat);
}

export function getWeakCount(
  categoryId = localStorage.getItem("spelldash_category") || "all"
) {
  const stats = getWordStats();
  const seen = new Set();
  return getWordsByCategory(categoryId).filter((word) => {
    if (seen.has(word.id)) return false;
    seen.add(word.id);
    return isWeakStat(stats[word.id]);
  }).length;
}

let queue = [];
let sessionFailCounts = new Map();
let practicedXpClaimed = new Set();
let recalledThisSession = new Set(); // Familiar語のセッション内再出題防止（学習中語は含めない）
let activeCategoryId = "all";
let restricted = false; // 「思い出せなかった語だけもう1周」: 補充しない
let placementRun = false; // このセッションが腕試し（初回10語）か

function todayString() {
  return localDateString();
}

function localDateOf(iso) {
  return iso ? localDateString(new Date(iso)) : null;
}

// ===== 状態判定 =====

export function isUnresolved(stat) {
  if (!stat?.lastRecallFailAt) return false;
  if (!stat.lastRecallSuccessAt) return true;
  return Date.parse(stat.lastRecallFailAt) > Date.parse(stat.lastRecallSuccessAt);
}

export function isRecalledToday(stat) {
  return !!stat?.lastRecallSuccessAt && localDateOf(stat.lastRecallSuccessAt) === todayString();
}

// 学習中（今日導入されたNew単語で、まだToday Securedでない）
export function isLearningToday(stat) {
  return (
    stat?.dailyLearningDate === todayString() &&
    (stat.dailyLearningStage ?? 0) < NEW_WORD_DAILY_SUCCESS_TARGET
  );
}

// 今日定着（同日に規定回数の自力正解を達成。masteredとは別物）
export function isSecuredToday(stat) {
  return (
    stat?.dailyLearningDate === todayString() &&
    (stat.dailyLearningStage ?? 0) >= NEW_WORD_DAILY_SUCCESS_TARGET
  );
}

export function getRecalledTodayCount() {
  const stats = getWordStats();
  let count = 0;
  for (const stat of Object.values(stats)) {
    if (isRecalledToday(stat)) count++;
  }
  return count;
}

export function getSecuredTodayCount() {
  const stats = getWordStats();
  let count = 0;
  for (const stat of Object.values(stats)) {
    if (isSecuredToday(stat)) count++;
  }
  return count;
}

function activeLearningCount(stats) {
  let count = 0;
  for (const stat of Object.values(stats)) {
    if (isLearningToday(stat)) count++;
  }
  return count;
}

// 今日はもう出題しない単語か
function isDoneForToday(stat) {
  if (isSecuredToday(stat)) return true;
  if (isUnresolved(stat)) return false;
  if (isLearningToday(stat)) return false; // 学習中は反復のため出題を続ける
  return isRecalledToday(stat);
}

// ===== 単語プール =====

function categoryWordsDeduped() {
  const stats = weakOnly ? getWordStats() : null;
  const seen = new Set();
  return getWordsByCategory(activeCategoryId).filter((word) => {
    if (seen.has(word.id)) return false;
    seen.add(word.id);
    return weakOnly ? isWeakStat(stats[word.id]) : true;
  });
}

export function isFamiliar(stat) {
  return !!stat?.lastRecallSuccessAt && !isUnresolved(stat);
}

// SRSの復習期限が来ている（習得済みは対象外）
export function isReviewDue(stat) {
  return !!stat && !stat.mastered && !!stat.nextReviewAt && Date.parse(stat.nextReviewAt) <= Date.now();
}

let sessionReviewCount = 0;

// 復習期日が来ていて、今日まだ片付いていない語の数（ホームCTA・完了パネル用）
export function getDueReviewCount(categoryId = localStorage.getItem("spelldash_category") || "all", until = Date.now()) {
  const stats = getWordStats();
  const seen = new Set();
  let count = 0;
  for (const word of getWordsByCategory(categoryId)) {
    if (seen.has(word.id)) continue;
    seen.add(word.id);
    const s = stats[word.id];
    if (!s || s.mastered || !s.nextReviewAt) continue;
    if (Date.parse(s.nextReviewAt) > until) continue;
    if (isDoneForToday(s)) continue;
    count++;
  }
  return count;
}

// 期日が来る語そのもの（「明日は negotiate など5語の復習から」の材料）
export function getDueReviewWords(categoryId = localStorage.getItem("spelldash_category") || "all", until = Date.now(), limit = 3) {
  const stats = getWordStats();
  const seen = new Set();
  const list = [];
  for (const word of getWordsByCategory(categoryId)) {
    if (seen.has(word.id)) continue;
    seen.add(word.id);
    const s = stats[word.id];
    if (!s || s.mastered || !s.nextReviewAt) continue;
    if (Date.parse(s.nextReviewAt) > until) continue;
    if (isDoneForToday(s)) continue;
    list.push(word);
    if (list.length >= limit) break;
  }
  return list;
}

// セッション開始時に「今日の復習」として積んだ語数（見える化用）
export function getSessionReviewCount() {
  return sessionReviewCount;
}

function isNew(stat) {
  return !stat || (stat.playCount ?? 0) === 0;
}

// ===== 通常補充（Mix Controlの比率はここだけに効く） =====

function pickFillers(count, excludeSet) {
  if (restricted) return []; // 回収モードは指定語だけ
  const stats = getWordStats();
  const ratio = getFamiliarRatio();
  const mission = getTodayMission();

  const usable = categoryWordsDeduped().filter((word) => {
    if (excludeSet.has(word.id)) return false;
    if (recalledThisSession.has(word.id)) return false;
    return !isDoneForToday(stats[word.id]);
  });

  const familiarPool = shuffle(usable.filter((w) => isFamiliar(stats[w.id])));

  // 新出単語はプレイヤーレベルで解放（既習語には適用しない）。
  // カテゴリに解放難易度が無い場合は最易難易度で救済（IT等のeasy 0語対策）
  const allowed = allowedWordLevels();
  let newPool = filterByAllowedLevels(
    usable.filter((w) => isNew(stats[w.id])),
    allowed
  );

  // Mission NewをNew候補の先頭に
  const missionNewPending = new Set(mission.new.filter((id) => !mission.newDone.includes(id)));
  newPool = [
    ...newPool.filter((w) => missionNewPending.has(w.id)),
    ...shuffle(newPool.filter((w) => !missionNewPending.has(w.id)))
  ];

  // 学習中New単語の上限。枠が空いている分だけ新しいNew単語を導入できる
  let newIntroBudget = Math.max(0, MAX_ACTIVE_NEW_WORDS - activeLearningCount(stats));

  const picks = [];
  let familiarIndex = 0;
  let newIndex = 0;

  while (picks.length < count) {
    const wantFamiliar = Math.random() * 100 < ratio;
    let pick = null;

    if (wantFamiliar) {
      pick = familiarPool[familiarIndex] ?? null;
      if (pick) familiarIndex++;
      // Familiar不足 → Newで補充
      if (!pick && newIntroBudget > 0 && newIndex < newPool.length) {
        pick = newPool[newIndex++];
        newIntroBudget--;
        markIntroduced(pick.id);
      }
    } else {
      if (newIntroBudget > 0 && newIndex < newPool.length) {
        pick = newPool[newIndex++];
        newIntroBudget--;
        markIntroduced(pick.id);
      }
      // New不足（または学習中上限） → Familiarで補充
      if (!pick) {
        pick = familiarPool[familiarIndex] ?? null;
        if (pick) familiarIndex++;
      }
    }

    if (!pick) break; // どちらの候補も尽きた
    picks.push(pick.id);
  }

  // それでも足りなければ「今日済み」も許可して埋める（出題停止を防ぐ）。
  // 苦手のみモードでは埋めない: 尽きたら「全部クリア」で気持ちよく終わるのが正
  if (picks.length < count && !weakOnly) {
    const fallback = shuffle(
      categoryWordsDeduped().filter(
        (w) => !excludeSet.has(w.id) && !picks.includes(w.id)
      )
    ).slice(0, count - picks.length);
    picks.push(...fallback.map((w) => w.id));
  }

  return picks;
}

// New単語を「学習中」として登録（比率で導入された時点から同日反復の対象になる）
function markIntroduced(wordId) {
  setDailyLearning(wordId, 0);
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ===== キュー構築・進行 =====

export function startStudyQueue(categoryId) {
  activeCategoryId = categoryId;
  queue = [];
  sessionFailCounts = new Map();
  practicedXpClaimed = new Set();
  recalledThisSession = new Set();
  restricted = false;
  placementRun = false;

  const stats = getWordStats();
  const words = categoryWordsDeduped();
  const idsInCategory = new Set(words.map((w) => w.id));
  const mission = getTodayMission();
  const now = Date.now();

  const seen = new Set();
  const push = (id) => {
    if (seen.has(id) || !idsInCategory.has(id)) return;
    if (isDoneForToday(stats[id])) return;
    seen.add(id);
    queue.push(id);
  };

  // 0. 初回体験＝腕試し: 学習履歴が全く無ければ、短くて易しい3語で成功体験を作ってから
  //    普通4語・難しい3語を混ぜた計10語で「どこから始めるか」を決める（2回目以降は発動しない）
  if (Object.keys(stats).length === 0 && isPlacementPending()) {
    const byLevel = (level) => shuffle(words.filter((w) => w.level === level));
    const easy = words
      .filter((w) => w.level === "easy")
      .sort((a, b) => a.en.length - b.en.length)
      .slice(0, PLACEMENT_MIX.easy);
    const rest = shuffle([...byLevel("normal").slice(0, PLACEMENT_MIX.normal), ...byLevel("hard").slice(0, PLACEMENT_MIX.hard)]);
    const picks = [...easy, ...rest];
    if (picks.length >= 6) {
      picks.forEach((w) => {
        push(w.id);
        markIntroduced(w.id); // 初見の「知ってた／知らなかった」を記録対象にする
      });
      markPlacementStarted();
      placementRun = true;
    } else {
      // 難易度が偏ったカテゴリ（マイ単語帳等）: 従来どおり短い語から
      words
        .filter((w) => w.level === "easy")
        .sort((a, b) => a.en.length - b.en.length)
        .slice(0, 3)
        .forEach((w) => push(w.id));
    }
  }

  // 1. Unresolved
  words.filter((w) => isUnresolved(stats[w.id])).forEach((w) => push(w.id));

  // 2. Today's Mission の Review（未達成分）
  mission.review.filter((id) => !mission.reviewDone.includes(id)).forEach(push);

  // 3. SRSの復習期限が来ている単語（「今日の復習」として件数を控える）
  const before = queue.length;
  words
    .filter((w) => {
      const s = stats[w.id];
      return s && !s.mastered && s.nextReviewAt && Date.parse(s.nextReviewAt) <= now;
    })
    .forEach((w) => push(w.id));
  sessionReviewCount = queue.length - before;

  // 4. 学習中New単語（同日の持ち越し。Today Secured前なら反復を続ける）
  words.filter((w) => isLearningToday(stats[w.id])).forEach((w) => push(w.id));

  // 5. 通常補充（比率適用）
  if (queue.length < MIN_QUEUE) {
    queue.push(...pickFillers(MIN_QUEUE - queue.length, new Set(queue)));
  }
}

// 「思い出せなかった語だけもう1周」: 指定語だけを回す（補充なし）。全部自力で思い出せたら終わり
export function startRetryQueue(ids) {
  queue = shuffle([...new Set(ids)]);
  sessionFailCounts = new Map();
  practicedXpClaimed = new Set();
  recalledThisSession = new Set();
  sessionReviewCount = 0;
  restricted = true;
  placementRun = false;
}

export function isPlacementRun() {
  return placementRun;
}

// セッション開始時のキュー構成（開始メッセージ用）
export function getQueueComposition() {
  const stats = getWordStats();
  const c = { weak: 0, review: 0, repeat: 0, fresh: 0, total: queue.length };
  for (const id of queue) {
    const s = stats[id];
    if (!s || (s.playCount ?? 0) === 0) c.fresh++;
    else if (isUnresolved(s)) c.weak++;
    else if (isLearningToday(s)) c.repeat++;
    else if (isReviewDue(s)) c.review++;
  }
  return c;
}

function refillIfNeeded() {
  if (queue.length >= 3) return;
  queue.push(...pickFillers(MIN_QUEUE - queue.length, new Set(queue)));
}

export function nextStudyWordId() {
  refillIfNeeded();
  return queue.shift() ?? null;
}

// 指定した問数だけ後ろに再挿入（±のジッターは呼び出し側の値に含める）。
// キューが短ければ別問題で埋めて、直後の即時再出題を防ぐ
function scheduleAt(wordId, offset) {
  if (queue.length < offset) {
    const fillers = pickFillers(offset - queue.length, new Set([...queue, wordId]));
    queue.push(...fillers);
  }

  let position = Math.min(offset, queue.length);
  if (position === 0 && queue.length > 0) position = 1;

  queue.splice(position, 0, wordId);
}

// Recall Fail: 数問後に再出題。学習中New単語は同日成功段階を1つ戻す
export function onRecallFail(wordId) {
  const stats = getWordStats();
  const stat = stats[wordId];

  // 初見で思い出せなかった = 学ぶべき語。難易度ブーストの材料に「知らなかった」を記録
  if (stat && (stat.playCount ?? 0) <= 1 && (stat.recallFail ?? 0) <= 1 && !stat.lastRecallSuccessAt) {
    recordFirstSight(false);
  }

  if (isLearningToday(stat) || isSecuredToday(stat)) {
    // 全リセットはせず1段階だけ戻す（Secured後の失敗も学習中に戻る）
    const stage = Math.max(0, (stat.dailyLearningStage ?? 0) - 1);
    setDailyLearning(wordId, stage);
  }

  const fails = (sessionFailCounts.get(wordId) ?? 0) + 1;
  sessionFailCounts.set(wordId, fails);

  // 学習中単語は2〜4問後、それ以外は初回3〜5問後・以降2〜4問後
  const learning = isLearningToday(getWordStats()[wordId]);
  const [min, max] = learning || fails > 1 ? [2, 4] : [3, 5];
  const offset = min + Math.floor(Math.random() * (max - min + 1));

  scheduleAt(wordId, offset);
}

// 自力正解。学習中New単語なら段階を進め、Today Securedまで同日反復する
// 戻り値: { secured, requeued, stage }
export function onRecallSuccess(wordId) {
  const stats = getWordStats();
  const stat = stats[wordId];

  queue = queue.filter((id) => id !== wordId);

  // 初見でノーミス自力正解（もともと知っていた語）: 同日反復に入れず今日は終わり
  if (stat?.knownOnSight && isLearningToday(stat) && (stat.dailyLearningStage ?? 0) === 0) {
    recordFirstSight(true);
    setDailyLearning(wordId, NEW_WORD_DAILY_SUCCESS_TARGET);
    recalledThisSession.add(wordId);
    return { secured: false, requeued: false, stage: null, known: true };
  }

  if (isLearningToday(stat)) {
    const stage = (stat.dailyLearningStage ?? 0) + 1;
    setDailyLearning(wordId, stage);

    if (stage >= NEW_WORD_DAILY_SUCCESS_TARGET) {
      // 今日定着。今日はもう出題しない（翌日以降は既存SRSが引き継ぐ）
      recalledThisSession.add(wordId);
      return { secured: true, requeued: false, stage };
    }

    // n回目の成功 → GAPS[n-1] ±1問後に再出題
    const base = NEW_WORD_REVIEW_GAPS[stage - 1] ?? NEW_WORD_REVIEW_GAPS.at(-1);
    const offset = Math.max(2, base + (Math.floor(Math.random() * 3) - 1));
    scheduleAt(wordId, offset);
    return { secured: false, requeued: true, stage };
  }

  // Familiar語: このセッションではもう出さない
  recalledThisSession.add(wordId);
  return { secured: false, requeued: false, stage: null };
}

export function claimPracticeXp(wordId) {
  if (practicedXpClaimed.has(wordId)) return false;
  practicedXpClaimed.add(wordId);
  return true;
}

export function getQueueSnapshot(limit = 5) {
  const stats = getWordStats();
  return {
    items: queue.slice(0, limit).map((id) => ({
      id,
      unresolved: isUnresolved(stats[id])
    })),
    remaining: queue.length
  };
}
