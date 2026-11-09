// 画素の細かさ（devicePixelRatio）の変化を知らせる。窓を別の画面へ移しても CSS の大きさは変わらず
// ResizeObserver は呼ばれないので、今の値の resolution のメディアクエリが外れたら知らせ、新しい値でまた見張る

export function onPixelRatioChange(fn: () => void): void {
  const mq = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
  if (!mq?.addEventListener) return;
  mq.addEventListener(
    "change",
    () => {
      onPixelRatioChange(fn);
      fn();
    },
    { once: true },
  );
}
