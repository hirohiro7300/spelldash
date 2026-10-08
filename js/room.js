// ===== 書斎（部屋）のレイアウトの手当て =====
//
// PC（1100px 以上）では机の列（.nook）を sticky にして、本棚を長くスクロールしても机の本が画面に残る。
// 机の列が画面より高いときは、下端が画面の下に付くように top を負にする（上端で止めるとスタートが隠れる）。
// プレイ中（body.home--playing）と初回（body.welcome-open）は sticky を外す（ゲームカードや積んだ本の高さが変わる）。
// 動きは無い（位置の計算だけ。prefers-reduced-motion でも同じ）。

export function initRoom() {
  const nook = document.getElementById("nook");
  if (!nook) return;
  const wide = matchMedia("(min-width: 1100px)");

  const fitNook = () => {
    const body = document.body;
    if (!wide.matches || body.classList.contains("home--playing") || body.classList.contains("welcome-open")) {
      nook.style.position = "";
      nook.style.top = "";
      return;
    }
    nook.style.position = "sticky";
    nook.style.top = `${Math.min(0, window.innerHeight - nook.offsetHeight)}px`;
  };

  fitNook();
  window.addEventListener("resize", fitNook);
  wide.addEventListener?.("change", fitNook);
  if (typeof ResizeObserver === "function") new ResizeObserver(fitNook).observe(nook);
  new MutationObserver(fitNook).observe(document.body, { attributes: true, attributeFilter: ["class"] });
}
