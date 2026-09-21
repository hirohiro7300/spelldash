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

  const level = gain * getVolume();
  if (level <= 0) return;
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(level, start + 0.005);
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
// 方針（docs/CONCEPT.md §7）: 短く・小さく・少なく。正解はごく短いクリック、思い出せずは低い1音。
// コンボで音程は上げない（数字を煽らない）。

// 単語正解: 木のクリックのような短い2音（高めだが小さく）
export function sfxCorrect() {
  play(() => {
    tone({ freq: 880, duration: 0.035, type: "triangle", gain: 0.04 });
    tone({ freq: 1320, duration: 0.05, type: "sine", gain: 0.03, delay: 0.03 });
  });
}

// 答えを見た後の練習正解: さらに控えめな単音
export function sfxSoftCorrect() {
  play(() => tone({ freq: 660, duration: 0.04, type: "triangle", gain: 0.025 }));
}

// 打ち間違い: 低く短く
export function sfxMiss() {
  play(() => tone({ freq: 160, duration: 0.05, type: "triangle", gain: 0.035 }));
}

// 思い出せなかった（答え表示）: 低い1音（下降はしない）
export function sfxReveal() {
  play(() => tone({ freq: 240, duration: 0.09, type: "sine", gain: 0.03 }));
}

// レベルアップ: 2音だけ
export function sfxLevelUp() {
  play(() => {
    tone({ freq: 659, duration: 0.09, gain: 0.05 });
    tone({ freq: 988, duration: 0.14, gain: 0.05, delay: 0.09 });
  });
}

// セット完了・Daily完走: 短いチャイム（音量控えめ）
export function sfxComplete() {
  play(() => {
    tone({ freq: 784, duration: 0.08, gain: 0.05 });
    tone({ freq: 1047, duration: 0.14, gain: 0.05, delay: 0.08 });
  });
}

// ご褒美: 1音だけ
export function sfxSparkle() {
  play(() => tone({ freq: 1568, duration: 0.08, gain: 0.035 }));
}
