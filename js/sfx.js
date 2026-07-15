import { getAudioSettings, saveAudioSettings } from "./audio.js";

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

// 単音を鳴らす。type/周波数/長さ/音量/開始遅延
function tone({ freq, duration = 0.08, type = "sine", gain = 0.08, delay = 0, slideTo = null }) {
  const context = getCtx();
  if (!context) return;

  const start = context.currentTime + delay;
  const osc = context.createOscillator();
  const amp = context.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) {
    osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  }

  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(gain, start + 0.005);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(amp);
  amp.connect(context.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function play(fn) {
  if (!isSfxEnabled()) return;
  try {
    fn();
  } catch {
    // 音は装飾。失敗してもゲームを止めない
  }
}

// 単語正解: コンボが伸びるほど少しずつ高く（気持ちよさの積み上げ）
export function sfxCorrect(combo = 0) {
  play(() => {
    const step = Math.min(combo, 10);
    const base = 660 * Math.pow(1.03, step);
    tone({ freq: base, duration: 0.07, gain: 0.07 });
    tone({ freq: base * 1.335, duration: 0.09, gain: 0.07, delay: 0.06 });
  });
}

// 答えを見た後の練習正解: 控えめな単音
export function sfxSoftCorrect() {
  play(() => tone({ freq: 520, duration: 0.06, gain: 0.045 }));
}

// 打ち間違い: 低く短く（不快すぎない程度）
export function sfxMiss() {
  play(() => tone({ freq: 180, duration: 0.06, type: "triangle", gain: 0.05 }));
}

// 思い出せなかった（答え表示）: 下降音
export function sfxReveal() {
  play(() => tone({ freq: 330, slideTo: 210, duration: 0.16, type: "sine", gain: 0.05 }));
}

// レベルアップ: 上昇アルペジオ
export function sfxLevelUp() {
  play(() => {
    [523, 659, 784, 1047].forEach((freq, i) =>
      tone({ freq, duration: 0.12, gain: 0.08, delay: i * 0.09 })
    );
  });
}

// ミッション完了・今日定着・Daily完走: 短いチャイム
export function sfxComplete() {
  play(() => {
    tone({ freq: 784, duration: 0.1, gain: 0.08 });
    tone({ freq: 1047, duration: 0.16, gain: 0.08, delay: 0.09 });
  });
}

// シールド獲得などのご褒美: キラッ
export function sfxSparkle() {
  play(() => {
    tone({ freq: 1319, duration: 0.07, gain: 0.06 });
    tone({ freq: 1760, duration: 0.1, gain: 0.05, delay: 0.05 });
  });
}
