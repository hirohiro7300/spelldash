// ===== BGM（廃止） =====
// 2026-09-21 コンセプト「墨と朱」で BGM は廃止した（学習の道具に自動生成のループ音は不要。効果音は js/sfx.js）。
// game.js からの呼び出しは残っているので、関数だけ残して何もしない。
export function isBgmEnabled() {
  return false;
}
export function setBgmEnabled() {}
export function startBgm() {}
export function stopBgm() {}
export function setBgmIntensity() {}
