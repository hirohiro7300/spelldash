// 起動の途中に、3 か月ごとの地図（版 7）の「3 年の見取り図」だけを先に描く（作業メモ SPEC v1 §7.2 の見取り図の最初の描画・user-18）。
// 8 万枚の文書を組み立てる前に、地図（読むだけの MapData）を計算の芯で組み直して数え、見取り図だけを描いてから文書の組み立てに進む。
// アプリの画面ができたら、その画面に入れ替わる（右のパネル・スマホの引き出しの先頭に、同じ見取り図）。
// 組み直した地図と、選んだ手の無い計算・見取り図の数は覚えておき、アプリの 3 年の影響のエンジンと見取り図がそのまま使う
// （compiledMapOf・plainAnalysis。二度は数えない）。読むだけ（押しても何も起きない）。

import "../deepmap/views/views.css";
import "../styles/deep.css";
import { plainAnalysis, plainOverview } from "../app/deepState";
import type { MapData } from "../deepmap/mapData";
import { overviewVM, renderOverview, ym } from "../deepmap/views";
import { IMPACT_DEFAULT_ANNUAL } from "../model/impact";
import { compiledMapOf } from "../model/impactGraph";
import { h } from "./dom";

/**
 * 描いた画面が出るまで待つ（rAF の後のタスク。そのフレームが出た直後に文書の組み立てに進む）。
 * 隠れたタブでは rAF が来ないので待たない（誰も見ていない。起動を止めない）。念のため 200ms で先に進む
 */
function afterPaint(): Promise<void> {
  if (document.visibilityState === "hidden") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const late = setTimeout(resolve, 200);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(late);
        resolve();
      }, 0),
    );
  });
}

/** 起動の間の入力として捨てる種類 */
const QUEUED: readonly string[] = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "touchstart", "touchend", "keydown", "keyup", "wheel"];
/** 既定の動き（スクロール）を止めない種類 */
const PASSIVE: ReadonlySet<string> = new Set(["touchstart", "wheel"]);

/**
 * 先に描いた見取り図を押した入力を捨てる。文書の組み立て（長い 1 つの仕事）の間に押した入力は、組み立ての後に届いて、
 * 入れ替わったアプリの同じ位置（引き出しの別の行）を押してしまう。見取り図が外れた時刻より前に起きた入力（event.timeStamp）は捨てる
 * （見直し user-12）。外れた後しばらくして見張りをやめる
 */
function dropQueuedInput(box: HTMLElement): void {
  const parent = box.parentElement;
  if (!parent || typeof MutationObserver === "undefined") return;
  let readyAt = Infinity;
  const drop = (ev: Event): void => {
    if (ev.timeStamp >= readyAt) return;
    if (ev.cancelable && !PASSIVE.has(ev.type)) ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  // 触れる・回すは passive のまま（止めるのはアプリへ届くことだけ。passive でないと、その間のスクロールが仕事の終わりを待つ）
  for (const t of QUEUED) window.addEventListener(t, drop, { capture: true, passive: PASSIVE.has(t) });
  const stop = (): void => {
    for (const t of QUEUED) window.removeEventListener(t, drop, { capture: true });
  };
  const mo = new MutationObserver(() => {
    if (box.isConnected) return;
    mo.disconnect();
    // 外れたのは組み立ての仕事の終わり（その後の小さな仕事）。それより前の入力は、待っていた入力
    readyAt = performance.now();
    setTimeout(stop, 4000);
  });
  mo.observe(parent, { childList: true });
  // 念のため（入れ替わらずに止まったとき）
  setTimeout(() => {
    if (box.isConnected) return;
    mo.disconnect();
    if (readyAt === Infinity) readyAt = performance.now();
    stop();
  }, 120_000);
}

/** 見取り図を mount に描き、描かれる（次の画面）まで待つ。描けなければ何もしない（アプリの起動は続ける） */
export async function paintDeepSplash(mount: HTMLElement, map: MapData, annual = IMPACT_DEFAULT_ANNUAL): Promise<void> {
  try {
    const cm = compiledMapOf(map);
    const a = plainAnalysis(cm, annual);
    const vm = overviewVM(a, plainOverview(cm, a));
    const view = renderOverview(vm);
    // 先に描くのは見出し・結びの文・「10 の手をひと目で」だけ（1 画面に収まる所。10 の手のくわしい行は描かず、最初の描画を軽く。
    // くわしい行はアプリの右のパネル・引き出しの見取り図に出る）
    for (const sel of [".dm-overview-tools", ".dm-keep", ".dm-cards-h", ".dm-cols", ".dm-rows", ".dm-today"]) view.querySelector(sel)?.remove();
    // 押せる所は押しても何も起きない（アプリができるまでの間の、読むだけの画面。押せる形にも見せない: 見直し user-12）
    view.addEventListener("click", (ev) => ev.preventDefault());
    for (const a of view.querySelectorAll("a")) {
      a.removeAttribute("href");
      a.setAttribute("aria-disabled", "true");
      a.setAttribute("tabindex", "-1");
    }
    const box = h(
      "div",
      { class: "deep-splash", attrs: { "aria-busy": "true" } },
      h("p", { class: "deep-splash-head" }, h("span", { class: "deep-splash-busy" }, "読み込み中"), `${ym(map, 0)}時点の地図（カード ${cm.n.toLocaleString("en-US")} 枚）。手を押して詳しく見られるのは、読み込みの後`),
      h("div", { class: "deep-splash-body dm-host" }, view),
    );
    mount.replaceChildren(box);
    dropQueuedInput(box);
    await afterPaint();
  } catch (e) {
    console.error(e);
  }
}
