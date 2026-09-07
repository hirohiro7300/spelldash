import { supabase } from "./supabase.js";

// 発音機能（Web Speech API）。音声ファイル不要でUS/UK切り替え可能。
// 設定: mode = auto（答え表示時に1回再生）/ manual（スピーカー押下のみ）/ off
const AUDIO_KEY = "spelldash_audio";

export function getAudioSettings() {
  try {
    return { mode: "auto", accent: "us", ...JSON.parse(localStorage.getItem(AUDIO_KEY) || "{}") };
  } catch {
    return { mode: "auto", accent: "us" };
  }
}

export function saveAudioSettings(settings) {
  localStorage.setItem(AUDIO_KEY, JSON.stringify(settings));
  syncAudioSettings(settings);
}

// ログイン中ならprofilesにも保存（端末をまたいで設定が残る）
async function syncAudioSettings(settings) {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id;
  if (!userId) return;

  await supabase.from("profiles").upsert({
    user_id: userId,
    audio_mode: settings.mode,
    preferred_accent: settings.accent,
    updated_at: new Date().toISOString()
  });
}

function pickVoice(accent) {
  const lang = accent === "uk" ? "en-GB" : "en-US";
  const voices = window.speechSynthesis?.getVoices() ?? [];
  return (
    voices.find((v) => v.lang === lang && v.localService) ||
    voices.find((v) => v.lang === lang) ||
    voices.find((v) => v.lang.startsWith("en")) ||
    null
  );
}

// 手動再生（スピーカーボタン）: 設定OFFでも鳴らす
export function speak(text) {
  if (!window.speechSynthesis) return;

  const settings = getAudioSettings();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = settings.accent === "uk" ? "en-GB" : "en-US";

  const voice = pickVoice(settings.accent);
  if (voice) utterance.voice = voice;

  utterance.rate = 0.9;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

// 自動再生（答え表示時）: mode=auto のときだけ1回鳴らす
export function autoSpeak(text) {
  if (getAudioSettings().mode !== "auto") return;
  speak(text);
}

// 正解時の発音（Studyで自力正解した瞬間）: 綴りと音を結びつける。
// 既定ON。mode=off なら鳴らさない（発音そのものを切っている人を尊重）
export function isSpeakOnCorrectEnabled() {
  const settings = getAudioSettings();
  return settings.mode !== "off" && settings.speakOnCorrect !== false;
}

export function setSpeakOnCorrectEnabled(enabled) {
  saveAudioSettings({ ...getAudioSettings(), speakOnCorrect: !!enabled });
}

export function speakOnCorrect(text) {
  if (!isSpeakOnCorrectEnabled()) return;
  speak(text);
}

// ===== 音量（効果音・BGM共通、0〜1。既定1） =====
export function getVolume() {
  const v = Number(getAudioSettings().volume);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

export function setVolume(v) {
  const clamped = Math.max(0, Math.min(1, Number(v) || 0));
  saveAudioSettings({ ...getAudioSettings(), volume: clamped });
}

// 一部ブラウザは初回getVoicesが空なので事前ロード
if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    window.speechSynthesis.getVoices();
  });
}
