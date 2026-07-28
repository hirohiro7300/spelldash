import { getAudioSettings, saveAudioSettings } from "./audio.js";

// ===== BGM（WebAudioで生成、音源ファイル不要） =====
//
// Challenge/Dailyの60秒ラン中に流れる控えめなループ。
// - lo-fi調: 柔らかいコードパッド＋ペンタトニックの小さなアルペジオ＋薄いハット
// - 残り10秒で intensity=2 になり、ハットが倍速になって緊張感を出す
// - 設定は spelldash_audio の bgm フィールド（既定ON）。効果音とは独立
// - 音は装飾: どこかで失敗してもゲームは止めない

let ctx = null;
let master = null;
let running = false;
let intensity = 1;
let schedulerTimer = null;
let nextBeatTime = 0;
let beatCount = 0;

const BPM = 84;
const BEAT = 60 / BPM;

// Cmaj7 → Am7 → Fmaj7 → G7（2拍ごとに進行、8拍で1周）
const CHORDS = [
  [261.63, 329.63, 392.0, 493.88],
  [220.0, 261.63, 329.63, 392.0],
  [174.61, 220.0, 261.63, 329.63],
  [196.0, 246.94, 293.66, 349.23]
];

// アルペジオ用（Cメジャーペンタトニック・高め）
const PLUCKS = [523.25, 587.33, 659.25, 783.99, 880.0];

export function isBgmEnabled() {
  return getAudioSettings().bgm !== false; // 未設定はON
}

export function setBgmEnabled(enabled) {
  saveAudioSettings({ ...getAudioSettings(), bgm: !!enabled });
  if (!enabled) stopBgm();
}

function getCtx() {
  if (!window.AudioContext && !window.webkitAudioContext) return null;
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function pad(context, chord, start, duration) {
  for (const freq of chord) {
    for (const detune of [-4, 4]) {
      const osc = context.createOscillator();
      const amp = context.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, start);
      osc.detune.setValueAtTime(detune, start);
      amp.gain.setValueAtTime(0, start);
      amp.gain.linearRampToValueAtTime(0.016, start + 0.3);
      amp.gain.setValueAtTime(0.016, start + duration - 0.35);
      amp.gain.linearRampToValueAtTime(0.0001, start + duration);
      osc.connect(amp);
      amp.connect(master);
      osc.start(start);
      osc.stop(start + duration + 0.05);
    }
  }
}

function pluck(context, freq, start) {
  const osc = context.createOscillator();
  const amp = context.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, start);
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(0.045, start + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
  osc.connect(amp);
  amp.connect(master);
  osc.start(start);
  osc.stop(start + 0.55);
}

function hat(context, start, loud = false) {
  const bufferSize = Math.floor(context.sampleRate * 0.03);
  const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  const src = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const amp = context.createGain();
  filter.type = "highpass";
  filter.frequency.value = 6000;
  amp.gain.value = loud ? 0.05 : 0.025;
  src.buffer = buffer;
  src.connect(filter);
  filter.connect(amp);
  amp.connect(master);
  src.start(start);
}

// 1拍ぶんの音を予約する（lookaheadスケジューラ）
function scheduleBeat(context, time, beat) {
  // 2拍ごとにコード（8拍=1周）
  if (beat % 2 === 0) {
    const chord = CHORDS[Math.floor(beat / 2) % CHORDS.length];
    pad(context, chord, time, BEAT * 2);
  }

  // ハット: 8分。intensity 2 では16分になって前へ進む感じを出す
  hat(context, time);
  hat(context, time + BEAT / 2, intensity >= 2);
  if (intensity >= 2) {
    hat(context, time + BEAT / 4);
    hat(context, time + (BEAT * 3) / 4);
  }

  // アルペジオ: たまに1音（毎拍40%）。乱数でも音階がペンタなので外れない
  if (Math.random() < 0.4) {
    pluck(context, PLUCKS[Math.floor(Math.random() * PLUCKS.length)], time + BEAT / 2);
  }
}

function scheduler() {
  const context = getCtx();
  if (!context || !running) return;

  // 先の0.4秒ぶんを予約し続ける
  while (nextBeatTime < context.currentTime + 0.4) {
    scheduleBeat(context, nextBeatTime, beatCount);
    nextBeatTime += BEAT;
    beatCount += 1;
  }
  schedulerTimer = setTimeout(scheduler, 120);
}

export function startBgm() {
  if (!isBgmEnabled() || running) return;
  try {
    const context = getCtx();
    if (!context) return;

    master = context.createGain();
    master.gain.value = 1;
    master.connect(context.destination);

    running = true;
    intensity = 1;
    beatCount = 0;
    nextBeatTime = context.currentTime + 0.05;
    scheduler();
  } catch {
    running = false;
  }
}

export function stopBgm() {
  running = false;
  clearTimeout(schedulerTimer);
  try {
    if (master && ctx) {
      // ブツ切りにせず0.25秒でフェードアウト
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      const old = master;
      setTimeout(() => old.disconnect(), 400);
    }
  } catch {
    // 音は装飾
  }
  master = null;
}

// 残り10秒などで緊張感を上げる（1=通常 / 2=終盤）
export function setBgmIntensity(level) {
  intensity = level;
}
