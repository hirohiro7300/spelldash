import { isNativeApp } from "./appEnv.js";
// ===== ホーム画面に追加（PWAインストール導線） =====
//
// 通知を使わない方針のため、「戻ってくる」導線はホーム画面のアイコンに寄せる。
// Chrome/Edge/Android は beforeinstallprompt を拾って1タップで追加。
// iOS Safari はイベントが無いので手順（共有 → ホーム画面に追加）を案内する。

let deferredPrompt = null;
const listeners = new Set();

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event;
  listeners.forEach((fn) => fn());
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  try {
    localStorage.setItem("spelldash_installed", "1");
  } catch {
    // 無視
  }
  listeners.forEach((fn) => fn());
});

export function onInstallStateChange(fn) {
  listeners.add(fn);
}

export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

export function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}

export function canInstall() {
  return !!deferredPrompt && !isStandalone();
}

export async function promptInstall() {
  if (!deferredPrompt) return "unavailable";
  const event = deferredPrompt;
  deferredPrompt = null;
  try {
    event.prompt();
    const choice = await event.userChoice;
    return choice?.outcome === "accepted" ? "accepted" : "dismissed";
  } catch {
    return "failed";
  }
}

// 設定画面などの1ブロックを描画（状態に応じて文言を変える）
export function renderInstallCard(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (isNativeApp) {
    el.innerHTML = ""; // アプリ版では「ホーム画面に追加」は不要
    return;
  }

  // 実際に追加できるときだけ出す（説明文は出さない）。追加済み・iOS・非対応は空のまま
  const draw = () => {
    if (isStandalone() || !canInstall()) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = `
      <button type="button" class="btn btn--sm btn--ghost" id="installButton">ホーム画面に追加</button>
      <p class="muted">アイコンから1タップで開けます。通知は送りません。</p>
    `;
    el.querySelector("#installButton").addEventListener("click", async () => {
      const outcome = await promptInstall();
      if (outcome === "accepted") el.innerHTML = `<p class="install__done">追加しました。ホーム画面のアイコンから開けます。</p>`;
      else draw();
    });
  };

  draw();
  onInstallStateChange(draw);
}
