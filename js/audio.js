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
const GOOD_APPLE = /^(Samantha|Ava|Allison|Zoe|Nicky|Evan|Tom|Joelle|Noelle|Daniel|Kate|Serena|Oliver|Stephanie|Martha|Arthur|Karen|Moira|Tessa|Fiona|Jamie)\b/i;
// macOS の遊びの声（Bad News, Bells, Cellos …）は候補から外す
const NOVELTY = /^(Fred|Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Junior|Kathy|Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;

const normLang = (l) => String(l || "").replace("_", "-").toLowerCase();
const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|CriOS|Edg/.test(navigator.userAgent);

function voiceScore(voice, lang) {
  const name = voice.name || "";
  let score = 50;
  if (/natural/i.test(name)) score = 100;
  else if (/premium/i.test(name)) score = 96;
  else if (/enhanced/i.test(name)) score = 92;
  else if (/^Google (US|UK) English/i.test(name)) score = 90;
  else if (/siri/i.test(name)) score = 80;
  else if (GOOD_APPLE.test(name)) score = 70;
  if (NOVELTY.test(name)) score = 1;
  if (/compact/i.test(name)) score = 10;
  if (/espeak/i.test(name)) score = 5;
  const l = normLang(voice.lang);
  if (l.startsWith(lang.toLowerCase())) score += 20;
  else if (l.startsWith("en")) score += 5;
  else score -= 40;
  if (voice.localService === false && !voice.name.includes("Google") && !/natural/i.test(name)) score += 2; // Android の Google TTS など
  if (voice.localService === false && navigator.onLine === false) score -= 60; // オフラインでは遠隔の声は鳴らない
  return score;
}

export function getEnglishVoices(accent = getAudioSettings().accent) {
  const lang = accent === "uk" ? "en-GB" : "en-US";
  const voices = (window.speechSynthesis?.getVoices() ?? []).filter((v) => normLang(v.lang).startsWith("en") && !NOVELTY.test(v.name || ""));
  return voices
    .map((v) => ({ voice: v, score: voiceScore(v, lang) }))
    .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name));
}

// 設定画面向けの読みやすい名前: 「Microsoft Aria Online (Natural) - English (United States)」→「Aria ・ US ・ 高品質」
export function prettyVoiceName(voice) {
  const raw = voice?.name || "";
  let name = raw
    .replace(/^Microsoft\s+/i, "")
    .replace(/\s+Online/i, "")
    .replace(/\s*\(Natural\)/i, "")
    .replace(/\s*-\s*English\s*\([^)]*\)/i, "")
    .replace(/^Google\s+/i, "")
    .replace(/\s*\((Enhanced|Premium|Compact)\)/i, "")
    .trim();
  const l = normLang(voice?.lang);
  const region = l.startsWith("en-gb") ? "UK" : l.startsWith("en-us") ? "US" : l.startsWith("en-au") ? "AU" : l.startsWith("en-in") ? "IN" : l.startsWith("en-ie") ? "IE" : l.startsWith("en-za") ? "ZA" : "EN";
  const quality = /natural|premium/i.test(raw) ? " ・ 高品質" : /enhanced/i.test(raw) ? " ・ 拡張" : /compact/i.test(raw) ? " ・ 簡易" : "";
  return `${name || raw} ・ ${region}${quality}`;
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

// WebKit（iOS/macOS Safari）は rate<1 が他より大きく遅くなるので少し速めの基準にする
function rateFor(text) {
  const table = isWebKit ? { slow: 0.9, normal: 1.0, fast: 1.1 } : { slow: 0.85, normal: 0.95, fast: 1.05 };
  const base = table[getSpeechRate()];
  return /\s/.test(String(text).trim()) ? Math.round(base * 0.95 * 100) / 100 : base;
}

// 読み上げ用に英文を整える: 曲がった引用符・ダッシュ・アクセント付き文字（résumé）を ASCII に。それでも英語以外が残れば読まない
function normalizeSpeech(text) {
  const t = String(text)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  return /[^\x00-\x7f]/.test(t) ? "" : t.trim();
}

let current = null;
let unlocked = false;

// iOS は「ユーザー操作の中で一度 speak した後」でないと自動再生できない。最初のタップ／キー入力で無音の発話を通しておく
export function unlockSpeech() {
  if (unlocked || !window.speechSynthesis) return;
  unlocked = true;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch {
    // 無視
  }
}

if (typeof document !== "undefined") {
  ["pointerdown", "keydown", "touchend"].forEach((ev) => document.addEventListener(ev, unlockSpeech, { once: true, passive: true }));
}

// 手動再生（スピーカーボタン）: 設定OFFでも鳴らす
export function speak(text, options = {}) {
  if (!window.speechSynthesis) return;
  const clean = normalizeSpeech(text);
  if (!clean) return; // 英語以外は読まない

  const settings = getAudioSettings();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = settings.accent === "uk" ? "en-GB" : "en-US";

  const voice = options.voice ?? pickVoice(settings.accent);
  if (voice) utterance.voice = voice;

  utterance.rate = options.rate ?? rateFor(clean);
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onend = utterance.onerror = () => {
    if (current === utterance) current = null;
    options.onend?.();
  };

  const synth = window.speechSynthesis;
  const go = () => {
    current = utterance;
    synth.speak(utterance);
  };
  // 話している最中だけ止める。cancel 直後の speak は落ちることがあるので1フレーム置く（iOS・Chrome）
  if (synth.speaking || synth.pending) {
    synth.cancel();
    setTimeout(go, 30);
  } else {
    go();
  }
}

export function isSpeaking() {
  return !!window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
}

// 声・速さの試聴（プロフィールの各行で共通）: 単語のあとに例文を1つ
export function previewVoice(uri) {
  const all = window.speechSynthesis?.getVoices() ?? [];
  const voice = uri ? all.find((v) => v.voiceURI === uri || v.name === uri) : undefined;
  speak("negotiate", { voice, onend: () => speak("We need to negotiate a better price.", { voice }) });
}

// 自動再生（答え表示時）: mode=auto のときだけ1回鳴らす
export function autoSpeak(text) {
  if (getAudioSettings().mode !== "auto") return;
  speak(text);
}

// 正解時の発音（Studyで自力正解した瞬間）: 綴りと音を結びつける。
// 既定ON。mode=off なら鳴らさない（発音そのものを切っている人を尊重）
// 「自動」なら正解時にも発音する（以前の個別設定 speakOnCorrect は「自動」に統合。false が保存されていれば尊重）
export function isSpeakOnCorrectEnabled() {
  const settings = getAudioSettings();
  return settings.mode === "auto" && settings.speakOnCorrect !== false;
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
  let timer = null;
  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(fn, 50); // voiceschanged は連発するのでまとめる
  };
  if (window.speechSynthesis.getVoices().length > 0) fn();
  window.speechSynthesis.addEventListener?.("voiceschanged", run);
}

if (window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    window.speechSynthesis.getVoices();
  });
}
