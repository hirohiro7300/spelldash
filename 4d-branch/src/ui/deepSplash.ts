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
    // 押せる所は押しても何も起きない（アプリができるまでの間の、読むだけの画面）
    view.addEventListener("click", (ev) => ev.preventDefault());
    const box = h(
      "div",
      { class: "deep-splash", attrs: { "aria-busy": "true" } },
      h("p", { class: "deep-splash-head" }, `${ym(map, 0)}時点の地図を開いている…（カード ${cm.n.toLocaleString("en-US")} 枚）`),
      h("div", { class: "deep-splash-body dm-host" }, view),
    );
    mount.replaceChildren(box);
    await afterPaint();
  } catch (e) {
    console.error(e);
  }
}
