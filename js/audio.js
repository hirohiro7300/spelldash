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

// ===== 声の選択 =====
// 端末にある英語の声を「自然さ」で点数づけして、いちばん良い声を自動で使う。
//   Microsoft ～ Online (Natural)（Edge/Windows） > Google US/UK English（Chrome） > Apple の Enhanced/Premium・Siri 系
//   > Apple の標準声（Samantha など） > その他 > compact/eSpeak（機械的なので最後）
// ユーザーがプロフィールで声を選んだら（voiceURI）それを最優先。
const GOOD_APPLE = /^(Samantha|Ava|Allison|Zoe|Nicky|Evan|Tom|Joelle|Noelle|Daniel|Kate|Serena|Oliver|Stephanie|Martha|Arthur|Karen|Moira|Tessa|Fiona)\b/i;

function voiceScore(voice, lang) {
  const name = voice.name || "";
  let score = 50;
  if (/natural/i.test(name)) score = 100;
  else if (/^Google (US|UK) English/i.test(name)) score = 90;
  else if (/(enhanced|premium)/i.test(name)) score = 85;
  else if (/siri/i.test(name)) score = 80;
  else if (GOOD_APPLE.test(name)) score = 70;
  if (/compact/i.test(name)) score = 10;
  if (/espeak/i.test(name)) score = 5;
  if (voice.lang === lang) score += 20;
  else if (/^en[-_]/i.test(voice.lang)) score += 5;
  else score -= 40;
  return score;
}

export function getEnglishVoices(accent = getAudioSettings().accent) {
  const lang = accent === "uk" ? "en-GB" : "en-US";
  const voices = (window.speechSynthesis?.getVoices() ?? []).filter((v) => /^en([-_]|$)/i.test(v.lang));
  return voices
    .map((v) => ({ voice: v, score: voiceScore(v, lang) }))
    .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name));
}

export function getPreferredVoiceURI() {
  return getAudioSettings().voiceURI || "";
}

export function setPreferredVoiceURI(uri) {
  const next = { ...getAudioSettings() };
  if (uri) next.voiceURI = uri;
  else delete next.voiceURI;
  saveAudioSettings(next);
}

function pickVoice(accent) {
  const uri = getPreferredVoiceURI();
  const all = window.speechSynthesis?.getVoices() ?? [];
  if (uri) {
    const chosen = all.find((v) => v.voiceURI === uri || v.name === uri);
    if (chosen) return chosen;
  }
  return getEnglishVoices(accent)[0]?.voice ?? null;
}

// ===== 速さ =====
// slow 0.85 / normal 0.95 / fast 1.05。例文（空白を含む文）は少し遅く読む
export function getSpeechRate() {
  const v = getAudioSettings().rate;
  return v === "slow" || v === "fast" || v === "normal" ? v : "normal";
}

export function setSpeechRate(v) {
  saveAudioSettings({ ...getAudioSettings(), rate: v === "slow" || v === "fast" ? v : "normal" });
}

function rateFor(text) {
  const base = { slow: 0.85, normal: 0.95, fast: 1.05 }[getSpeechRate()];
  return /\s/.test(String(text).trim()) ? Math.max(0.7, base - 0.05) : base;
}

// 手動再生（スピーカーボタン）: 設定OFFでも鳴らす
export function speak(text, options = {}) {
  if (!window.speechSynthesis) return;
  if (!text || /[^\x00-\x7f]/.test(text)) return; // 英語以外は読まない

  const settings = getAudioSettings();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = settings.accent === "uk" ? "en-GB" : "en-US";

  const voice = options.voice ?? pickVoice(settings.accent);
  if (voice) utterance.voice = voice;

  utterance.rate = options.rate ?? rateFor(text);
  utterance.pitch = 1;
  utterance.volume = 1;
  // 直前の読み上げを止めてから話す。iOS は cancel 直後の speak が無視されることがあるので1フレーム置く
  window.speechSynthesis.cancel();
  setTimeout(() => window.speechSynthesis.speak(utterance), 0);
}

// 声の試聴（プロフィール）
export function previewVoice(uri) {
  const all = window.speechSynthesis?.getVoices() ?? [];
  const voice = uri ? all.find((v) => v.voiceURI === uri || v.name === uri) : null;
  speak("Remember the word, then type it.", { voice: voice ?? undefined });
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

// ===== 音で出題（リスニング）: Studyで日本語の代わりに発音を聞いて打つ割合（0/25/50%、既定0） =====
export function getListenRatio() {
  const v = Number(getAudioSettings().listenRatio);
  return [0, 25, 50].includes(v) ? v : 0;
}

export function setListenRatio(v) {
  saveAudioSettings({ ...getAudioSettings(), listenRatio: [0, 25, 50].includes(Number(v)) ? Number(v) : 0 });
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

// 一部ブラウザ（iOS Safari・Chrome）は初回 getVoices が空なので事前ロードし、そろったら知らせる
export function onVoicesReady(fn) {
  if (!window.speechSynthesis) return;
  if (window.speechSynthesis.getVoices().length > 0) fn();
  window.speechSynthesis.addEventListener?.("voiceschanged", fn);
}

if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    window.speechSynthesis.getVoices();
  });
}
