import { getOskMode, setOskMode } from "./keyboard.js";
import { resetTutorial } from "./tutorial.js";
import { supabase } from "./supabase.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { initWordStore } from "./wordStore.js";
import { setupUnloadSync } from "./sync.js";
import { getAudioSettings, saveAudioSettings, speak, getVolume, setVolume, getListenRatio, setListenRatio, getEnglishVoices, getPreferredVoiceURI, setPreferredVoiceURI, previewVoice, getSpeechRate, setSpeechRate, onVoicesReady, prettyVoiceName } from "./audio.js";
import { downloadBackup, readBackupFile, inspectBackup, applyBackup } from "./backup.js";
import { isSfxEnabled, setSfxEnabled, sfxCorrect } from "./sfx.js";
import { getTheme, setTheme, isProTheme } from "./theme.js";
import { isNativeApp } from "./appEnv.js";
import { getPlan, isPro, waitForPro, postBilling, planLabel } from "./plan.js";
import { getSetSize, setSetSize } from "./dailySet.js";
import { getWeekGoal, setWeekGoal } from "./growthLog.js";
import { renderInstallCard } from "./installPrompt.js";

const loggedOutElement = document.getElementById("profileLoggedOut");
const profileCardElement = document.getElementById("profileCard");
const avatarElement = document.getElementById("profileAvatar");
const emailElement = document.getElementById("profileEmail");
const joinedElement = document.getElementById("profileJoined");

initializeAuth();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();
initWordStore();

// ===== 学習の設定（今日のセットの語数） =====
{
  const select = document.getElementById("setSizeSelect");
  if (select) {
    select.value = String(getSetSize());
    select.addEventListener("change", () => setSetSize(select.value));
  }
}

// ===== 音で出題（リスニング） =====
{
  const select = document.getElementById("listenSelect");
  if (select) {
    select.value = String(getListenRatio());
    select.addEventListener("change", () => setListenRatio(select.value));
  }
}

// ===== 週の学習日目標 =====
{
  const select = document.getElementById("weekGoalSelect");
  if (select) {
    select.value = String(getWeekGoal());
    select.addEventListener("change", () => setWeekGoal(select.value));
  }
}

// ===== ホーム画面に追加 =====
renderInstallCard("installCard");

// ===== 見た目の設定（テーマ: 白/黒＋Pro の紙/藍） =====
initializeThemeSetting();

function initializeThemeSetting() {
  const oskSelect = document.getElementById("oskSelect");
  if (oskSelect) {
    oskSelect.value = getOskMode();
    oskSelect.addEventListener("change", () => setOskMode(oskSelect.value));
  }

  const themeSelect = document.getElementById("themeSelect");
  if (!themeSelect) return;
  const hint = document.getElementById("themeHint");

  themeSelect.value = getTheme();
  themeSelect.addEventListener("change", () => {
    // 紙・藍は Pro だけ。無料の人には案内を出して選択を戻す（適用しない）
    if (isProTheme(themeSelect.value) && !isPro()) {
      if (hint) {
        hint.innerHTML = '紙・藍は Pro のテーマ。<a href="./pro.html">Pro について</a>';
        hint.hidden = false;
      }
      themeSelect.value = getTheme();
      return;
    }
    if (hint) hint.hidden = true;
    setTheme(themeSelect.value); // 即時反映＋ローカル保存
  });
  // Pro の状態が変わったら（失効など）選択も現在値に合わせる
  document.addEventListener("spelldash:plan", () => {
    themeSelect.value = getTheme();
  });
}

// ===== プラン（Free / Pro）の行と、加入直後の反映待ち =====
initializePlanRow();

function initializePlanRow() {
  const value = document.getElementById("planValue");
  const link = document.getElementById("planLink");
  const portal = document.getElementById("planPortal");
  if (!value) return;

  const render = () => {
    const plan = getPlan();
    value.textContent = planLabel(plan);
    // アプリでは加入・管理のボタンを出さない（Web 版で）
    if (link) link.hidden = isNativeApp || plan.pro;
    if (portal) portal.hidden = isNativeApp || !plan.pro;
  };
  render();
  document.addEventListener("spelldash:plan", render);

  portal?.addEventListener("click", async () => {
    portal.disabled = true;
    const label = portal.textContent;
    portal.textContent = "準備中…";
    const { status, body } = await postBilling("/api/billing/portal");
    if (status === 200 && typeof body.url === "string" && body.url) {
      location.href = body.url; // Stripe の Billing Portal へ
      return;
    }
    portal.disabled = false;
    portal.textContent = label;
    const message = status === 404
      ? "お支払いの記録が無い。加入直後なら少し待って開き直す"
      : status === 401
        ? "ログインが要る"
        : status === 0
          ? "通信できなかった。接続を確認"
          : body.message || "お支払いの管理を開けなかった。時間をおいてもう一度";
    showProfileMessage(message, "error");
  });

  // Checkout から戻ってきた（?pro=done）: webhook の反映を待つ
  if (new URLSearchParams(location.search).get("pro") === "done") {
    showProfileMessage("お支払いを確認中…");
    waitForPro().then((ok) => {
      showProfileMessage(
        ok
          ? "Pro になった。ありがとう"
          : "お支払いは完了。反映まで少し待つ（1 分たっても変わらなければ開き直す）",
        ok ? "success" : ""
      );
    });
  }
}

function showProfileMessage(text, type = "") {
  const el = document.getElementById("authMessage");
  if (!el) return;
  el.textContent = text;
  el.className = `auth-message ${type}`.trim();
}

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
    statusElement.textContent = "保存済み";
    // アクセント確認用に1回だけサンプル再生
    if (modeSelect.value !== "off") {
      previewVoice(getPreferredVoiceURI());
    }
    setTimeout(() => (statusElement.textContent = ""), 2000);
  };

  modeSelect.addEventListener("change", save);
  accentSelect.addEventListener("change", () => {
    save();
    fillVoices(); // アクセントが変わると候補の並びも変わる
  });

  // 声の選択（端末にある英語の声を自然さ順に）と試聴
  const voiceSelect = document.getElementById("voiceSelect");
  const voicePreview = document.getElementById("voicePreview");
  const fillVoices = () => {
    if (!voiceSelect) return;
    const list = getEnglishVoices(accentSelect.value);
    const current = getPreferredVoiceURI();
    voiceSelect.innerHTML = `<option value="">自動（${list[0] ? prettyVoiceName(list[0].voice) : "端末の声"}）</option>` + list
      .map(({ voice }) => `<option value="${voice.voiceURI.replace(/"/g, "&quot;")}">${prettyVoiceName(voice)}</option>`)
      .join("");
    voiceSelect.value = list.some(({ voice }) => voice.voiceURI === current) ? current : "";
  };
  if (voiceSelect) {
    fillVoices();
    onVoicesReady(fillVoices);
    voiceSelect.addEventListener("change", () => {
      setPreferredVoiceURI(voiceSelect.value);
      previewVoice(voiceSelect.value);
      statusElement.textContent = "保存済み";
      setTimeout(() => (statusElement.textContent = ""), 2000);
    });
  }
  voicePreview?.addEventListener("click", () => previewVoice(voiceSelect?.value || ""));
  // iOS だけ: 高品質の声は OS の設定から追加できる
  const iosHint = document.getElementById("voiceIosHint");
  if (iosHint && /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream) iosHint.hidden = false;

  const rateSelect = document.getElementById("rateSelect");
  if (rateSelect) {
    rateSelect.value = getSpeechRate();
    rateSelect.addEventListener("change", () => {
      setSpeechRate(rateSelect.value);
      previewVoice(getPreferredVoiceURI());
      statusElement.textContent = "保存済み";
      setTimeout(() => (statusElement.textContent = ""), 2000);
    });
  }

  // 効果音のON/OFF（発音とは独立）
  const sfxSelect = document.getElementById("sfxSelect");
  if (sfxSelect) {
    sfxSelect.value = isSfxEnabled() ? "on" : "off";
    sfxSelect.addEventListener("change", () => {
      setSfxEnabled(sfxSelect.value === "on");
      if (sfxSelect.value === "on") sfxCorrect(3); // 確認用サンプル
      statusElement.textContent = "保存済み";
      setTimeout(() => (statusElement.textContent = ""), 2000);
    });
  }

  // 音量（効果音）
  const volumeRange = document.getElementById("volumeRange");
  const volumeValue = document.getElementById("volumeValue");
  if (volumeRange) {
    volumeRange.value = String(Math.round(getVolume() * 100));
    if (volumeValue) volumeValue.textContent = `${volumeRange.value}%`;
    volumeRange.addEventListener("input", () => {
      setVolume(Number(volumeRange.value) / 100);
      if (volumeValue) volumeValue.textContent = `${volumeRange.value}%`;
    });
    volumeRange.addEventListener("change", () => {
      if (Number(volumeRange.value) > 0) sfxCorrect(3); // 確認用サンプル
      statusElement.textContent = "保存済み";
      setTimeout(() => (statusElement.textContent = ""), 2000);
    });
  }
}

// ===== 学習データのバックアップ / 復元 =====
initializeBackup();

function initializeBackup() {
  const exportButton = document.getElementById("backupExport");
  const importInput = document.getElementById("backupImport");
  const status = document.getElementById("backupStatus");
  if (!exportButton || !importInput || !status) return;

  exportButton.addEventListener("click", () => {
    try {
      downloadBackup();
      status.textContent = "書き出した。ダウンロードフォルダに保存";
    } catch {
      status.textContent = "書き出せなかった";
    }
  });

  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    try {
      const obj = await readBackupFile(file);
      const info = inspectBackup(obj);
      const when = info.exportedAt ? new Date(info.exportedAt).toLocaleString("ja-JP") : "不明";
      const ok = window.confirm(
        `このバックアップを読み込みますか？\n\n単語の記録: ${info.words}語 / XP: ${info.xp}\n書き出し日時: ${when}\n\nこの端末の学習データはファイルの内容で置き換わります。`
      );
      if (!ok) {
        status.textContent = "読み込みを中止した";
        return;
      }
      applyBackup(obj);
      status.textContent = `復元した（${info.words}語）。ページを再読み込みする`;
      setTimeout(() => location.reload(), 900);
    } catch (error) {
      status.textContent = error.message || "読み込めなかった";
    }
  });
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
  if (avatarElement) avatarElement.textContent = email.charAt(0).toUpperCase() || "?";

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
      status.textContent = "表示名が空";
      return;
    }

    const { error } = await supabase.from("profiles").upsert({
      user_id: session.user.id,
      display_name: name,
      updated_at: new Date().toISOString()
    });

    if (error) {
      status.textContent = "保存できなかった。時間をおいてもう一度";
      return;
    }

    localStorage.setItem(DISPLAY_NAME_KEY, name);
    status.textContent = "保存済み。次回の Daily Dash から反映";
    setTimeout(() => {
      status.textContent = "Daily Dash のランキングに出る名前（次回の記録から）";
    }, 3000);
  });
}

// チュートリアルをもう一度（docs/SPEC_TUTORIAL.md）: 次のセットから T1〜T3、次の完了で T5
document.getElementById("tutorialReset")?.addEventListener("click", () => {
  resetTutorial();
  const status = document.getElementById("tutorialResetStatus");
  if (status) status.textContent = "次のセットから出る";
});
