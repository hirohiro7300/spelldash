import { getAudioSettings, saveAudioSettings, getVolume } from "./audio.js";

// 効果音（WebAudioで合成、音声ファイル不要）。
// 設定は spelldash_audio の sfx フィールド（既定ON）。発音(mode/accent)とは独立。
// AudioContextはユーザー操作後に遅延生成する（自動再生ポリシー対応）。

let ctx = null;

function getCtx() {
  if (!window.AudioContext && !window.webkitAudioContext) return null;

  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ctx.state === "suspended") {
    ctx.resume();
  }
  return ctx;
}

export function isSfxEnabled() {
  return getAudioSettings().sfx !== false; // 未設定はON
}

export function setSfxEnabled(enabled) {
  saveAudioSettings({ ...getAudioSettings(), sfx: !!enabled });
}

// 単音（サイン波などの純音）。ノイズ系と組み合わせる
function tone({ freq, duration = 0.08, type = "sine", gain = 0.08, delay = 0, slideTo = null }) {
  const context = getCtx();
  if (!context) return;
  const start = context.currentTime + delay;
  const osc = context.createOscillator();
  const amp = context.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  const level = gain * getVolume();
  if (level <= 0) return;
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(level, start + 0.004);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(amp);
  amp.connect(context.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

// ごく短いノイズ（キーボードのクリック・木を叩く音に近い）。バンドパスで音色を決める
let noiseBuffer = null;
function noise({ duration = 0.02, gain = 0.03, freq = 2200, q = 1.2, type = "bandpass", delay = 0 }) {
  const context = getCtx();
  if (!context) return;
  if (!noiseBuffer) {
    const len = Math.floor(context.sampleRate * 0.1);
    noiseBuffer = context.createBuffer(1, len, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  const level = gain * getVolume();
  if (level <= 0) return;
  const start = context.currentTime + delay;
  const src = context.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const amp = context.createGain();
  amp.gain.setValueAtTime(level, start);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  src.connect(filter);
  filter.connect(amp);
  amp.connect(context.destination);
  src.start(start);
  src.stop(start + duration + 0.01);
}

function play(fn) {
  if (!isSfxEnabled()) return;
  try {
    fn();
  } catch {
    // 音は装飾。失敗してもゲームを止めない
  }
}

// 方針（docs/CONCEPT.md §7）: 短く・小さく・少なく。ゲーム機ではなくキーボードの音。
// 4種類だけ: 正解のティック／答えを見た後の正解（さらに小さく）／ミス（低いコツン）／完了（2音）。

// 単語正解: 12ms のクリック＋ごく短い木の音
export function sfxCorrect() {
  play(() => {
    noise({ duration: 0.012, gain: 0.035, freq: 2200, q: 1.5 });
    tone({ freq: 900, duration: 0.025, type: "triangle", gain: 0.02 });
  });
}

// 答えを見た後の練習正解: クリックだけ
export function sfxSoftCorrect() {
  play(() => noise({ duration: 0.012, gain: 0.02, freq: 2000, q: 1.5 }));
}

// 打ち間違い・思い出せなかった: 低いコツン
export function sfxMiss() {
  play(() => {
    noise({ duration: 0.04, gain: 0.03, freq: 300, q: 0.8, type: "lowpass" });
    tone({ freq: 140, duration: 0.06, type: "sine", gain: 0.02 });
  });
}

// 思い出せなかった（答え表示）: ミスと同じ音を小さく（別の「下降音」は廃止）
export function sfxReveal() {
  play(() => noise({ duration: 0.035, gain: 0.02, freq: 300, q: 0.8, type: "lowpass" }));
}

// セット完了・レベルアップ・Daily 完走・ご褒美: 柔らかい2音（G5 → C6）
export function sfxComplete() {
  play(() => {
    tone({ freq: 784, duration: 0.09, type: "sine", gain: 0.04 });
    tone({ freq: 1047, duration: 0.16, type: "sine", gain: 0.04, delay: 0.09 });
  });
}

export function sfxLevelUp() {
  sfxComplete();
}

export function sfxSparkle() {
  play(() => tone({ freq: 1568, duration: 0.06, type: "sine", gain: 0.02 }));
}

// 他モジュール（将来）が同じ AudioContext を使えるように
export function getAudioContext() {
  return getCtx();
}
