// ===== オフライン表示 =====
// 通信が切れても学習はこの端末に保存され、接続時に同期される（Local First）。
// 「壊れた」と思わせないため、状態を1行で伝えるだけ。操作は奪わない。

let banner = null;

function render() {
  const offline = navigator.onLine === false;
  if (!offline) {
    if (banner) banner.hidden = true;
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "offline-banner";
    banner.setAttribute("role", "status");
    banner.textContent = "オフラインです。学習はこの端末に保存され、接続が戻ると自動で同期します。";
    document.body.appendChild(banner);
  }
  banner.hidden = false;
}

export function initOfflineBanner() {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return;
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  render();
}
