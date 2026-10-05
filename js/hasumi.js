import { getStreak, hasPlayedToday } from "./level.js";
import { getRecalledTodayCount } from "./studyQueue.js";
import { getLearnedWordsToday } from "./learnedWords.js";
import { getSetSize } from "./dailySet.js";

// ===== はちゃん（はすみ / Hasumi）: 学習パートナー =====
//
// トーン規則（docs/CHARACTER.md と docs/CONCEPT.md 原則 8・10 が正）:
// - ユーザーが主人公、はちゃんは伴走者。主役にならない
// - 1 行 1 文。事実＋伴走。「！」は多くて 1 つ
// - 「すごい／えらい／ばっちり／がんばろ」のような盛り上げ語は使わない
// - 依存を煽る表現・罪悪感を与える表現は禁止
//   NG:「来てくれないと思った…」「寂しかった…」「会いたかった…」
// - 数字と矛盾することを言わない（結果の一言は前回比で分岐する）

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
    // 今日覚えた語があれば、語を名指しで（数字より語）
    const learned = getLearnedWordsToday();
    if (learned.length > 0) {
      const extra = learned.length > 1 ? ` ほか${learned.length - 1}語` : "";
      return { mood: "happy", text: `今日は ${learned[0].en}${extra}を覚えた。` };
    }
    const recalled = getRecalledTodayCount();
    if (recalled > 0) {
      return { mood: "happy", text: `今日は${recalled}語、思い出せた。` };
    }
    return { mood: "happy", text: "今日のぶん、終わった。" };
  }

  if (streak.current > 0 && streak.current + 1 > streak.best) {
    return { mood: "normal", text: "今日やると、連続記録を更新。" };
  }

  // 腕試しが済んでいない人には、セットの語数ではなく腕試しの話をする（道のラベルと数字をそろえる）
  if (localStorage.getItem("spelldash_placement") !== "done") {
    return { mood: "normal", text: "まず腕試し10語から。" };
  }

  const size = getSetSize();
  if (hour >= 5 && hour < 11) {
    return { mood: "normal", text: pick([`おはよう。今日の${size}語、いこう。`, "おはよう。まず1語から。"]) };
  }
  if (hour >= 11 && hour < 18) {
    return { mood: "normal", text: pick(["おかえり。1語からでいい。", `おかえり。今日の${size}語、いこう。`]) };
  }
  return { mood: "normal", text: pick(["おつかれさま。5分だけ、いこう。", "おつかれさま。1語からでいい。"]) };
}

// 結果画面の一言（前回比で分岐し、数字と矛盾しない）
export function hasumiResultLine({ isBest = false, isDaily = false, diff = null } = {}) {
  if (isBest) {
    return { mood: "happy", text: "やった、前の自分を超えた！" };
  }
  if (diff != null && diff > 0) {
    return { mood: "happy", text: "前より伸びた。" };
  }
  if (diff != null && diff < 0) {
    return { mood: "normal", text: "思い出せなかった語を、ひとつ拾おう。" };
  }
  if (isDaily) {
    return { mood: "normal", text: "Daily Dash は1日1回。また明日。" };
  }
  return { mood: "normal", text: "おつかれさま。" };
}

// 「覚えた」の瞬間の一言（語を名指しで）
export function hasumiLearnedLine(en) {
  return { mood: "happy", text: pick([`${en}、残ってた。`, `前は出てこなかった ${en}、いまは出る。`]) };
}

// 今日のセット完了の一言（完了の事実だけ。次を急かさない）
export function hasumiSetLine({ count = 0, failed = 0, sets = 1 } = {}) {
  if (sets > 1) {
    return { mood: "happy", text: `${sets}セット目、終わった。` };
  }
  if (failed === 0) {
    return { mood: "happy", text: "今日は全部、自力で出てきた。" };
  }
  return { mood: "normal", text: "今日のぶん、終わった。" };
}

// 週間レポートの一言（数字を一緒に見る。少ない週も責めない）
export function hasumiWeeklyLine(r) {
  if (r.learnedDelta > 0) return { mood: "happy", text: "増えた語は、来週の復習で定着する。" };
  if (r.activeDays >= 3) return { mood: "normal", text: "続いた週。来週も5分から。" };
  if (r.activeDays > 0) return { mood: "normal", text: "少しでも続いた。来週も5分から。" };
  return { mood: "normal", text: "今週は休み。今日から1セット、いこう。" };
}

// ストリークカードの一言（言うことがある時だけ返す）
export function hasumiStreakLine() {
  const streak = getStreak();
  const playedToday = hasPlayedToday();
  if (!playedToday && streak.current > 0 && streak.current + 1 > streak.best) {
    return "あと1日で記録更新。";
  }
  if (playedToday && streak.best >= 2 && streak.current >= streak.best) {
    return "連続記録、更新中。";
  }
  return null;
}

// 吹き出しUI（アバター＋一言）を組み立てる共通部品
export function hasumiBubbleHtml({ mood, text }, extraClass = "") {
  return `
    <div class="hasumi ${extraClass}">
      <img class="hasumi__avatar" src="${AVATAR[mood] ?? AVATAR.normal}" alt="はちゃん" width="32" height="32" />
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
