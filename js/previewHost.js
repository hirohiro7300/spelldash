// ===== 確認用の Preview（*.vercel.app）の止め口 =====
// 本番は www.spelldash.net。本番の vercel.app の名前は vercel.json で本番へ転送するので、*.vercel.app で開けるのは確認用の配信だけ。
// 確認用の配信では、ログイン・同期・バックアップの読み込みを止める（本番のクラウドの記録に触れない・端末の記録を置き換えない）。
// 中心学習・学習状況・ランクなどは端末の記録だけで動く（2026-10-30 の決定 7）。

export function isPreviewHostname(hostname) {
  return /\.vercel\.app$/i.test(String(hostname ?? ""));
}

export const isPreviewHost = typeof location !== "undefined" && isPreviewHostname(location.hostname);

export const PREVIEW_NOTE = "確認用の Preview です。ログイン・同期・バックアップの読み込みは現在調整中。記録はこの Preview を開いた端末にだけ残る。";

if (isPreviewHost && typeof document !== "undefined") {
  document.documentElement.classList.add("preview-host");
  const apply = () => {
    for (const el of document.querySelectorAll(".account-menu__native")) el.textContent = PREVIEW_NOTE;
    if (document.body && !document.getElementById("previewBanner")) {
      const banner = document.createElement("p");
      banner.id = "previewBanner";
      banner.className = "preview-banner";
      banner.setAttribute("role", "note");
      banner.textContent = PREVIEW_NOTE;
      document.body.prepend(banner);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
}
