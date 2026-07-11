import { getWordStats } from "./storage.js";
import { getWordsByCategory } from "./wordStore.js";
import { getTodayMission } from "./mission.js";

// ===== Study Recall Loop のキュー =====
// 「思い出せなかった問題が画面内を巡回し、自力で一度思い出せるまで残り続ける」
//
// 状態の定義（word statsの日時から導出。キュー自体はセッション限り）:
//   Pending       … まだ今日回答していない
//   Unresolved    … lastRecallFailAt > lastRecallSuccessAt（自力正解するまで継続、日をまたいでも残る）
//   Recalled Today… lastRecallSuccessAt がローカル日付で今日

const MIN_QUEUE = 8;

let queue = [];                    // これから出題するword idの列
let sessionFailCounts = new Map(); // セッション内のRecall Fail回数（再出題間隔の決定用）
let practicedXpClaimed = new Set(); // 答え表示後の練習+5XPを取得済みのword id
let recalledThisSession = new Set();
let activeCategoryId = "all";

function localDateString(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayString() {
  return localDateString(new Date().toISOString());
}

// Unresolved: 思い出せなかった記録があり、その後まだ自力で思い出せていない
export function isUnresolved(stat) {
  if (!stat?.lastRecallFailAt) return false;
  if (!stat.lastRecallSuccessAt) return true;
  return Date.parse(stat.lastRecallFailAt) > Date.parse(stat.lastRecallSuccessAt);
}

export function isRecalledToday(stat) {
  return !!stat?.lastRecallSuccessAt && localDateString(stat.lastRecallSuccessAt) === todayString();
}

// 今日、自力で一度以上思い出せたユニーク単語数（日次で自動リセット）
export function getRecalledTodayCount() {
  const stats = getWordStats();
  let count = 0;
  for (const stat of Object.values(stats)) {
    if (isRecalledToday(stat)) count++;
  }
  return count;
}

export function getUnresolvedCount() {
  const stats = getWordStats();
  let count = 0;
  for (const stat of Object.values(stats)) {
    if (isUnresolved(stat)) count++;
  }
  return count;
}

// カテゴリ間重複語は同じidを共有しているため、id単位で1つに絞る
function categoryWordsDeduped() {
  const seen = new Set();
  return getWordsByCategory(activeCategoryId).filter((word) => {
    if (seen.has(word.id)) return false;
    seen.add(word.id);
    return true;
  });
}

// 今日すでに自力正解済み（かつその後失敗していない）単語は出題から外す
function isDoneForToday(stat) {
  return isRecalledToday(stat) && !isUnresolved(stat);
}

// 通常抽選（穴埋め用）: 既存の重み付けを簡略化して流用
function pickFillers(count, excludeSet) {
  const stats = getWordStats();

  let candidates = categoryWordsDeduped().filter((word) => {
    if (excludeSet.has(word.id)) return false;
    if (recalledThisSession.has(word.id)) return false;
    return !isDoneForToday(stats[word.id]);
  });

  // 対象が尽きた場合は「今日済み」も許可（即時再出題の防止を優先）
  if (candidates.length === 0) {
    candidates = categoryWordsDeduped().filter((word) => !excludeSet.has(word.id));
  }

  const picks = [];
  const used = new Set();

  while (picks.length < count && used.size < candidates.length) {
    const word = candidates[Math.floor(Math.random() * candidates.length)];
    if (used.has(word.id)) continue;
    used.add(word.id);
    picks.push(word.id);
  }

  return picks;
}

// Study開始時のキュー構築。優先順位:
// 1. Unresolved → 2. MissionのReview → 3. 復習期限到来 → 4. MissionのNew → 5. 通常抽選
export function startStudyQueue(categoryId) {
  activeCategoryId = categoryId;
  queue = [];
  sessionFailCounts = new Map();
  practicedXpClaimed = new Set();
  recalledThisSession = new Set();

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

  // 1. Unresolved（日をまたいでも解決するまで残る）
  words.filter((w) => isUnresolved(stats[w.id])).forEach((w) => push(w.id));

  // 2. Today's Mission の Review（未達成分）
  mission.review.filter((id) => !mission.reviewDone.includes(id)).forEach(push);

  // 3. SRSの復習期限が来ている単語
  words
    .filter((w) => {
      const s = stats[w.id];
      return s && !s.mastered && s.nextReviewAt && Date.parse(s.nextReviewAt) <= now;
    })
    .forEach((w) => push(w.id));

  // 4. Today's Mission の New（未達成分）
  mission.new.filter((id) => !mission.newDone.includes(id)).forEach(push);

  // 5. 通常抽選で最低数まで埋める
  if (queue.length < MIN_QUEUE) {
    queue.push(...pickFillers(MIN_QUEUE - queue.length, new Set(queue)));
  }
}

function refillIfNeeded() {
  if (queue.length >= 3) return;
  queue.push(...pickFillers(MIN_QUEUE - queue.length, new Set(queue)));
}

// 次の問題を取り出す
export function nextStudyWordId() {
  refillIfNeeded();
  return queue.shift() ?? null;
}

// Recall Fail: 数問後に再出題されるようキューへ戻す
// 1回目は3〜5問後、2回目以降は2〜4問後（範囲内でランダム）。連続出題はしない
export function onRecallFail(wordId) {
  const fails = (sessionFailCounts.get(wordId) ?? 0) + 1;
  sessionFailCounts.set(wordId, fails);

  const [min, max] = fails === 1 ? [3, 5] : [2, 4];
  let offset = min + Math.floor(Math.random() * (max - min + 1));

  // キューが短い場合は間に別問題を挟む（直後の即時再出題を防ぐ）
  if (queue.length < offset) {
    const fillers = pickFillers(offset - queue.length, new Set([...queue, wordId]));
    queue.push(...fillers);
  }

  offset = Math.min(offset, queue.length);
  if (offset === 0 && queue.length > 0) offset = 1;

  queue.splice(offset, 0, wordId);
}

// 自力正解: このセッションではもう出題しない
export function onRecallSuccess(wordId) {
  recalledThisSession.add(wordId);
  queue = queue.filter((id) => id !== wordId);
}

// 答え表示後の練習+5XPは同一セッション・同一単語につき1回まで
export function claimPracticeXp(wordId) {
  if (practicedXpClaimed.has(wordId)) return false;
  practicedXpClaimed.add(wordId);
  return true;
}

// キュー表示用（内容は見せない。状態と残量だけ）
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
