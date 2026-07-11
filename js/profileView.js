import { supabase } from "./supabase.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { computeSummary, computeTypingSummary } from "./summary.js";
import { getLevelState, getStreak } from "./level.js";
import { renderLevelBar } from "./levelUi.js";

const loggedOutElement = document.getElementById("profileLoggedOut");
const profileCardElement = document.getElementById("profileCard");
const avatarElement = document.getElementById("profileAvatar");
const emailElement = document.getElementById("profileEmail");
const joinedElement = document.getElementById("profileJoined");
const summaryElement = document.getElementById("profileSummary");
const typingElement = document.getElementById("profileTyping");

initializeAuth();
renderLevelBar();
renderSummary();
renderTyping();
setFooterYear();

supabase.auth.getSession().then(({ data }) => renderProfile(data.session));
supabase.auth.onAuthStateChange((_event, session) => renderProfile(session));

function renderProfile(session) {
  const isLoggedIn = Boolean(session);

  loggedOutElement.hidden = isLoggedIn;
  profileCardElement.hidden = !isLoggedIn;

  if (!isLoggedIn) return;

  const email = session.user.email ?? "";
  emailElement.textContent = email;
  avatarElement.textContent = email.charAt(0).toUpperCase() || "?";

  const createdAt = session.user.created_at;
  if (createdAt) {
    const joined = new Date(createdAt).toLocaleDateString("ja-JP");
    joinedElement.textContent = `登録日：${joined}`;
  } else {
    joinedElement.textContent = "";
  }
}

function renderCards(container, cards) {
  container.innerHTML = cards
    .map(
      (card) => `
        <div class="stat-card">
          <span>${card.label}</span>
          <strong>${card.value}</strong>
        </div>
      `
    )
    .join("");
}

function renderSummary() {
  const s = computeSummary();
  const level = getLevelState();
  const streak = getStreak();

  renderCards(summaryElement, [
    { label: "称号", value: level.title },
    { label: "連続プレイ", value: `${streak.current}日` },
    { label: "ベストスコア", value: s.best },
    { label: "習得済み", value: `${s.mastered} / ${s.total}` },
    { label: "習得率", value: `${s.masteryRate}%` },
    { label: "正答率", value: `${s.accuracy}%` }
  ]);
}

function renderTyping() {
  const t = computeTypingSummary();

  renderCards(typingElement, [
    { label: "平均タップ / 秒", value: t.tapsPerSecond.toFixed(1) },
    { label: "ミスタイプ率", value: `${t.mistypeRate.toFixed(1)}%` },
    { label: "最高速度 (打/秒)", value: t.bestSpeed.toFixed(1) },
    { label: "プレイ回数", value: t.sessions }
  ]);
}
