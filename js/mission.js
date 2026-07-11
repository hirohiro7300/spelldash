import { getWordStats } from "./storage.js";
import { getAllWords, findWord } from "./wordStore.js";

// Today's Mission: 「今日はこれだけやればOK」を作る。
// Review = 復習が必要な単語（ミスが多い順 → 最後にやってから時間が経っている順）
// New    = まだ一度もやっていない単語
const MISSION_KEY = "spelldash_mission";
const REVIEW_TARGET = 12;
const NEW_TARGET = 5;
const MISSION_BONUS_XP = 40;

const LEVEL_RANK = { easy: 0, normal: 1, hard: 2 };

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadMission() {
  try {
    return JSON.parse(localStorage.getItem(MISSION_KEY));
  } catch {
    return null;
  }
}

function saveMission(mission) {
  localStorage.setItem(MISSION_KEY, JSON.stringify(mission));
}

// Reviewの選定: 未習得 かつ（ミスあり or 復習期限が来ている）
// 優先順位: missCount 多い → lastPlayed が古い
function pickReviewWords() {
  const stats = getWordStats();
  const now = Date.now();

  return Object.entries(stats)
    .filter(([en]) => findWord(en))
    .filter(([, data]) => {
      if (data.mastered) return false;
      if ((data.playCount ?? 0) === 0) return false;
      const due = data.nextReviewAt && Date.parse(data.nextReviewAt) <= now;
      return (data.missCount ?? 0) > 0 || due;
    })
    .sort((a, b) => {
      const missDiff = (b[1].missCount ?? 0) - (a[1].missCount ?? 0);
      if (missDiff !== 0) return missDiff;
      return Date.parse(a[1].lastPlayed ?? 0) - Date.parse(b[1].lastPlayed ?? 0);
    })
    .slice(0, REVIEW_TARGET)
    .map(([en]) => en);
}

// Newの選定: 未プレイの単語。選択中カテゴリ → 易しいレベルを優先し、少しランダム
function pickNewWords(excludeSet) {
  const stats = getWordStats();
  const preferredCategory = localStorage.getItem("spelldash_category") || "all";

  // カテゴリ間で重複する単語（同一id）は1つに絞る
  const seen = new Set();
  const candidates = getAllWords().filter((word) => {
    if ((stats[word.id]?.playCount ?? 0) > 0) return false;
    if (excludeSet.has(word.id) || seen.has(word.id)) return false;
    seen.add(word.id);
    return true;
  });

  return candidates
    .map((word) => ({
      word,
      rank:
        (word.category === preferredCategory ? 0 : 10) +
        (LEVEL_RANK[word.level] ?? 1) +
        Math.random()
    }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, NEW_TARGET)
    .map((entry) => entry.word.id);
}

// 今日のミッションを取得（日付が変わっていたら作り直す）
export function getTodayMission() {
  const stored = loadMission();

  if (stored && stored.date === todayString()) {
    return stored;
  }

  const review = pickReviewWords();
  const newWords = pickNewWords(new Set(review));

  const mission = {
    date: todayString(),
    review,
    new: newWords,
    reviewDone: [],
    newDone: [],
    bonusAwarded: false
  };

  saveMission(mission);
  return mission;
}

export function isMissionComplete(mission = getTodayMission()) {
  const total = mission.review.length + mission.new.length;
  const done = mission.reviewDone.length + mission.newDone.length;
  return total > 0 && done >= total;
}

// ミッション対象でまだ終わっていない単語か（出題の重み付けに使う）
export function isMissionWordPending(en) {
  const mission = getTodayMission();
  return (
    (mission.review.includes(en) && !mission.reviewDone.includes(en)) ||
    (mission.new.includes(en) && !mission.newDone.includes(en))
  );
}

// 単語を正解し終えたときに呼ぶ。ミッション完了の瞬間ならボーナスXPを返す
export function markMissionWord(en) {
  const mission = getTodayMission();
  let changed = false;

  if (mission.review.includes(en) && !mission.reviewDone.includes(en)) {
    mission.reviewDone.push(en);
    changed = true;
  }

  if (mission.new.includes(en) && !mission.newDone.includes(en)) {
    mission.newDone.push(en);
    changed = true;
  }

  if (!changed) return { bonusXp: 0, justCompleted: false };

  let bonusXp = 0;
  let justCompleted = false;

  if (isMissionComplete(mission) && !mission.bonusAwarded) {
    mission.bonusAwarded = true;
    bonusXp = MISSION_BONUS_XP;
    justCompleted = true;
  }

  saveMission(mission);
  return { bonusXp, justCompleted };
}

// ===== 表示 =====

export function renderMission() {
  const container = document.getElementById("missionCard");
  if (!container) return;

  const mission = getTodayMission();
  const reviewTotal = mission.review.length;
  const newTotal = mission.new.length;

  if (reviewTotal + newTotal === 0) {
    container.innerHTML = `
      <div class="mission__head">Today's Mission</div>
      <p class="mission__empty">今日のミッションはありません。自由にプレイしましょう。</p>
    `;
    return;
  }

  if (isMissionComplete(mission)) {
    container.classList.add("mission--complete");
    container.innerHTML = `
      <div class="mission__head">Today's Mission</div>
      <p class="mission__complete">MISSION COMPLETE</p>
    `;
    return;
  }

  container.classList.remove("mission--complete");
  container.innerHTML = `
    <div class="mission__head">Today's Mission</div>
    <div class="mission__items">
      <div class="mission__item">
        <span class="mission__label">Review</span>
        <strong>${mission.reviewDone.length} / ${reviewTotal}</strong>
      </div>
      <div class="mission__item">
        <span class="mission__label">New</span>
        <strong>${mission.newDone.length} / ${newTotal}</strong>
      </div>
    </div>
  `;
}
