import { supabase } from "./supabase.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { computeSummary, computeTypingSummary } from "./summary.js";
import { getLevelState, getStreak } from "./level.js";
import { renderLevelBar } from "./levelUi.js";
import { initWordStore } from "./wordStore.js";
import { setupUnloadSync } from "./sync.js";
import { getAudioSettings, saveAudioSettings, speak } from "./audio.js";
import { isSfxEnabled, setSfxEnabled, sfxCorrect } from "./sfx.js";

const loggedOutElement = document.getElementById("profileLoggedOut");
const profileCardElement = document.getElementById("profileCard");
const avatarElement = document.getElementById("profileAvatar");
const emailElement = document.getElementById("profileEmail");
const joinedElement = document.getElementById("profileJoined");
const summaryElement = document.getElementById("profileSummary");
const typingElement = document.getElementById("profileTyping");

initializeAuth();
renderLevelBar();
renderTyping();
setFooterYear();
setupUnloadSync();

initWordStore().then(() => {
  renderSummary();
});

window.addEventListener("spelldash:synced", () => {
  renderLevelBar();
  renderSummary();
  renderTyping();
});

// ===== 発音の設定 =====
initializeAudioSettings();

function initializeAudioSettings() {
  const modeSelect = document.getElementById("audioModeSelect");
  const accentSelect = document.getElementById("accentSelect");
  const statusElement = document.getElementById("audioSettingStatus");
  if (!modeSelect || !accentSelect) return;

  const settings = getAudioSettings();
  modeSelect.value = settings.mode;
  accentSelect.value = settings.accent;

  const save = () => {
    saveAudioSettings({ ...getAudioSettings(), mode: modeSelect.value, accent: accentSelect.value });
    statusElement.textContent = "保存しました。";
    // アクセント確認用に1回だけサンプル再生
    if (modeSelect.value !== "off") {
      speak("investment");
    }
    setTimeout(() => (statusElement.textContent = ""), 2000);
  };

  modeSelect.addEventListener("change", save);
  accentSelect.addEventListener("change", save);

  // 効果音のON/OFF（発音とは独立）
  const sfxSelect = document.getElementById("sfxSelect");
  if (sfxSelect) {
    sfxSelect.value = isSfxEnabled() ? "on" : "off";
    sfxSelect.addEventListener("change", () => {
      setSfxEnabled(sfxSelect.value === "on");
      if (sfxSelect.value === "on") sfxCorrect(3); // 確認用サンプル
      statusElement.textContent = "保存しました。";
      setTimeout(() => (statusElement.textContent = ""), 2000);
    });
  }
}

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

  initializeDisplayName(session);
}

// ===== ランキング表示名 =====
// profiles.display_name を編集し、ローカルにもキャッシュする。
// Daily Dashのスコア送信はキャッシュを優先して使う（次回の記録から反映）
const DISPLAY_NAME_KEY = "spelldash_display_name";
let displayNameInitialized = false;

async function initializeDisplayName(session) {
  const input = document.getElementById("displayNameInput");
  const saveButton = document.getElementById("displayNameSave");
  const status = document.getElementById("displayNameStatus");
  if (!input || !saveButton || displayNameInitialized) return;
  displayNameInitialized = true;

  // 現在値: profiles → メタデータ → メール先頭 の順
  const { data } = await supabase
    .from("profiles")
    .select("display_name")
    .maybeSingle();
  const meta = session.user.user_metadata ?? {};
  const current =
    data?.display_name ||
    meta.full_name ||
    meta.name ||
    session.user.email?.split("@")[0] ||
    "";

  input.value = current;
  if (current) localStorage.setItem(DISPLAY_NAME_KEY, current);

  saveButton.addEventListener("click", async () => {
    const name = input.value.trim().slice(0, 20);
    if (!name) {
      status.textContent = "表示名を入力してください。";
      return;
    }

    const { error } = await supabase.from("profiles").upsert({
      user_id: session.user.id,
      display_name: name,
      updated_at: new Date().toISOString()
    });

    if (error) {
      status.textContent = "保存に失敗しました。時間をおいて再試行してください。";
      return;
    }

    localStorage.setItem(DISPLAY_NAME_KEY, name);
    status.textContent = "保存しました。次回のDaily Dashから反映されます。";
    setTimeout(() => {
      status.textContent = "Daily Dashランキングに表示される名前です（次回の記録から反映）。";
    }, 3000);
  });
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
    { label: "ストリークシールド", value: `🛡️ × ${streak.shields ?? 0}` },
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
