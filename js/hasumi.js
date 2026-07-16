import { getStreak, hasPlayedToday } from "./level.js";
import { getRecalledTodayCount } from "./studyQueue.js";

// ===== はちゃん（はすみ / Hasumi）: 学習パートナー =====
//
// トーン規則（docs/CHARACTER.md が正）:
// - ユーザーが主人公、はちゃんは伴走者。主役にならない
// - 応援・共感・励まし・成長を一緒に喜ぶ、のみ
// - 依存を煽る表現・罪悪感を与える表現は禁止
//   NG:「来てくれないと思った…」「寂しかった…」「会いたかった…」

const AVATAR = {
  normal: "./assets/images/hasumi.png",
  happy: "./assets/images/hasumi-happy.png"
};

function pick(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}

// ホームの一言（時間帯＋今日の状態で変える。長文にしない）
export function hasumiHomeLine() {
  const hour = new Date().getHours();
  const streak = getStreak();

  if (hasPlayedToday()) {
    // 成長の実感: 今日思い出せた語数を一緒に喜ぶ（docs/PMF.md 候補A）
    const recalled = getRecalledTodayCount();
    if (recalled > 0) {
      return { mood: "happy", text: `今日は${recalled}語思い出せたよ！えらい！` };
    }
    return {
      mood: "happy",
      text: pick(["今日の分ばっちり！えらい！", "今日もクリア済み！その調子だよ〜！"])
    };
  }

  if (streak.current > 0 && streak.current + 1 > streak.best) {
    return { mood: "normal", text: "今日プレイで記録更新だよ！一緒にがんばろっ！" };
  }

  if (hour >= 5 && hour < 11) {
    return { mood: "normal", text: pick(["おはよう〜！今日も一緒にがんばろーね！", "おはよう！まずは1語からダッシュしよっ！"]) };
  }
  if (hour >= 11 && hour < 18) {
    return { mood: "normal", text: pick(["おかえり！今日も少しだけ頑張ろう！", "おかえり〜！今日も一緒にダッシュしよっ！"]) };
  }
  return { mood: "normal", text: pick(["おつかれさま！5分だけ一緒にやろっ！", "今日もおつかれさま！少しだけ頑張ろう！"]) };
}

// 結果画面の一言（成長を一緒に喜ぶ）
export function hasumiResultLine({ isBest = false, isDaily = false } = {}) {
  if (isBest) {
    return { mood: "happy", text: "やったー！ベスト更新だよ！すごすぎる〜！" };
  }
  if (isDaily) {
    return { mood: "happy", text: pick(["Daily完走おつかれさま！また明日ね！", "今日もお疲れさま！前より伸びてるよ！"]) };
  }
  return { mood: "normal", text: pick(["今日もお疲れさま！前より伸びてるよ！", "いい感じ〜！その調子だよ〜！"]) };
}

// ストリークカードの一言（言うことがある時だけ返す）
export function hasumiStreakLine() {
  const streak = getStreak();
  const playedToday = hasPlayedToday();
  if (!playedToday && streak.current > 0 && streak.current + 1 > streak.best) {
    return "あと1日で記録更新！";
  }
  if (playedToday && streak.best >= 2 && streak.current >= streak.best) {
    return "ベスト記録更新中！すごいすごい！";
  }
  return null;
}

// 吹き出しUI（アバター＋一言）を組み立てる共通部品
export function hasumiBubbleHtml({ mood, text }, extraClass = "") {
  return `
    <div class="hasumi ${extraClass}">
      <img class="hasumi__avatar" src="${AVATAR[mood] ?? AVATAR.normal}" alt="はちゃん" width="44" height="44" />
      <div class="hasumi__bubble">${text}</div>
    </div>
  `;
}

// ホームの吹き出しを描画
export function renderHasumiHome() {
  const container = document.getElementById("hasumiHome");
  if (!container) return;
  container.innerHTML = hasumiBubbleHtml(hasumiHomeLine(), "hasumi--home");
}
