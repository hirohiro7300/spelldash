import { getStreak, hasPlayedToday, SHIELD_EARN_EVERY, shieldMax } from "./level.js";
import { localDateString } from "./stats.js";
import { getRecalledTodayCount, isBeforePlacement } from "./studyQueue.js";
import { getLearnedWordsToday } from "./learnedWords.js";

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

  // 昨日休んだがシールドが守った朝: 何が起きたかを 1 文で（責めない。数字はチップが持つ）
  if (streak.shieldSavedOn === localDateString()) {
    return { mood: "normal", text: "昨日は休み。連続はそのまま。" };
  }

  // 節目の前日だけ（4 日目・9 日目…）。毎日「記録更新」と言うと情報が無い。
  // 言うのは「今日やると何が増えるか」。すでに持っている枚数で変える（上限なら増えないので言わない）
  if (streak.current > 0 && (streak.current + 1) % SHIELD_EARN_EVERY === 0 && streak.shields < shieldMax()) {
    const next = streak.current + 1;
    if (streak.shields > 0) return { mood: "normal", text: `今日やると${next}日。休める日がもう1日増える。` };
    return { mood: "normal", text: `今日やると${next}日。1日休んでも切れなくなる。` };
  }

  // 腕試し前の人（まだ 1 語も答えていない）には、セットの語数ではなく腕試しの話をする（道の見出しと同じ判定）
  if (isBeforePlacement()) {
    return { mood: "normal", text: "まず腕試し10語から。" };
  }

  if (hour >= 5 && hour < 11) {
    return { mood: "normal", text: pick(["おはよう。まず1語から。", "おはよう。5分だけ、いこう。"]) };
  }
  if (hour >= 11 && hour < 18) {
    return { mood: "normal", text: pick(["おかえり。1語からでいい。", "おかえり。5分だけ、いこう。"]) };
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
export function hasumiSetLine({ count = 0, failed = 0, sets = 1, recovered = 0 } = {}) {
  if (sets > 1) {
    return { mood: "happy", text: `${sets}セット目、終わった。` };
  }
  if (failed === 0 && !recovered) {
    return { mood: "happy", text: "今日は全部、自力で思い出せた。" };
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
