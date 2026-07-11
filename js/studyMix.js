import { DEFAULT_FAMILIAR_RATIO } from "./studyConfig.js";

// ===== Study Mix Control（回答済み／未回答の出題比率） =====
// 回答済みを増やす → テンポよく気持ちよく打てる
// 未回答を増やす → 新しい単語を多く学べる
// 値はLocal First（localStorage即保存）でログイン時はSupabaseへ同期する。

const MIX_KEY = "spelldash_study_mix";

export function getStudyMix() {
  const defaults = { familiarRatio: DEFAULT_FAMILIAR_RATIO, updatedAt: null };
  try {
    const saved = JSON.parse(localStorage.getItem(MIX_KEY)) || {};
    const merged = { ...defaults, ...saved };
    merged.familiarRatio = clampRatio(merged.familiarRatio);
    return merged;
  } catch {
    return defaults;
  }
}

export function getFamiliarRatio() {
  return getStudyMix().familiarRatio;
}

export function saveFamiliarRatio(ratio) {
  localStorage.setItem(
    MIX_KEY,
    JSON.stringify({ familiarRatio: clampRatio(ratio), updatedAt: new Date().toISOString() })
  );
}

// クラウド側の値を採用する（同期マージ用）
export function adoptCloudRatio(ratio, updatedAt) {
  localStorage.setItem(
    MIX_KEY,
    JSON.stringify({ familiarRatio: clampRatio(ratio), updatedAt })
  );
}

function clampRatio(value) {
  const n = Math.round((Number(value) || 0) / 10) * 10;
  return Math.min(100, Math.max(0, n));
}

// ===== スライダーUI =====

export function initializeMixControl() {
  const slider = document.getElementById("mixSlider");
  const label = document.getElementById("mixLabel");
  if (!slider || !label) return;

  const apply = (ratio) => {
    slider.value = ratio;
    label.textContent = `回答済み ${ratio}% / 未回答 ${100 - ratio}%`;
    slider.setAttribute(
      "aria-label",
      `出題比率: 回答済み${ratio}パーセント、未回答${100 - ratio}パーセント`
    );
  };

  apply(getFamiliarRatio());

  slider.addEventListener("input", () => {
    const ratio = clampRatio(slider.value);
    apply(ratio);
    saveFamiliarRatio(ratio);
    // 反映は次回の通常補充から（現在の問題・学習中単語には影響しない）
  });
}
