// 新しい地図の知らせ（版 7。一度だけ: 表示の設定 releaseSheet に見せた版を覚える）。設計: 作業メモ SPEC v1 §5.9（見直し user-5・user-11）
// 言うこと: 2029 年 11 月まで 3 か月ごとに 12 回の判断・1 手あたり約 2,000 の分かれ道・2 年の進め方は無くなった・差の比べ方が変わった
// （前の版と今の版の今日の 10 の手の差の表）。ボタン: 見取り図を見る・一番ありそうな道を読む

import type { AppContext } from "../app/context";
import type { DeepCtx } from "../app/deepState";
import { overviewVM, ym } from "../deepmap/views";
import { buildFuture } from "../demo/futureBundle";
import { formatMan } from "../model/impactFormat";
import { deltaTable, todayDeltasOf } from "../model/releaseNotes";
import { h } from "./dom";
import { openModal } from "./overlays";

const num = (v: number): string => Math.round(v).toLocaleString("en-US");

/** 前の版（ページに同梱の版 6 の地図）の今日の手の差。読めなければ空 */
function beforeDeltas(annual: number): Map<string, number> {
  try {
    return todayDeltasOf(buildFuture().pv.doc, annual);
  } catch {
    return new Map();
  }
}

/** 知らせを出す（閉じたら onClose） */
export function openReleaseSheet(app: AppContext, ctx: DeepCtx, onClose: () => void = () => undefined): void {
  const map = ctx.map;
  const cm = ctx.cm;
  const a = ctx.analysis();
  const ov = ctx.overview();
  const vm = overviewVM(a, ov);
  // 今日の手ごとの分かれ道（判断 + 出来事の分かれ）の幅
  let lo = Infinity;
  let hi = 0;
  for (const f of cm.firstMoves) {
    const forks = cm.nDec[f]! + cm.nSplit[f]!;
    lo = Math.min(lo, forks);
    hi = Math.max(hi, forks);
  }
  const names = new Map(vm.rows.map((r) => [r.kind, r.name]));
  const rows = deltaTable(
    beforeDeltas(ctx.annual),
    ov.moves.map((m) => ({ kind: m.kind, delta: m.delta ? m.delta.d : null, isBase: m.isBase })),
  );
  const cell = (v: number | null, base: boolean) => (base ? "比べる元" : v === null ? "—" : formatMan(v));
  const table = h(
    "table",
    { class: "rel-table" },
    h("caption", null, `今日の 10 の手の差（年収 ${num(ctx.annual)} 万円・万円）`),
    h("thead", null, h("tr", null, h("th", { attrs: { scope: "col" } }, "今日の手"), h("th", { attrs: { scope: "col" } }, "前の版"), h("th", { attrs: { scope: "col" } }, "今の版"))),
    h(
      "tbody",
      null,
      ...rows.map((r) =>
        h(
          "tr",
          { class: r.signChanged ? "is-flip" : "" },
          h("th", { attrs: { scope: "row" } }, names.get(r.kind) ?? r.kind),
          h("td", null, cell(r.before, r.isBase)),
          h("td", null, cell(r.after, r.isBase), r.signChanged ? h("span", { class: "rel-tag" }, r.after! > 0 ? "マイナスからプラスに" : "プラスからマイナスに") : null),
        ),
      ),
    ),
  );
  const m = openModal({ title: "新しい地図になった（版 7）", subtitle: `${ym(map, 0)}時点の地図・カード ${num(cm.n)} 枚`, width: 560, className: "rel-sheet", onClose, icon: "split" });
  m.body.append(
    h(
      "ul",
      { class: "rel-points" },
      h("li", null, h("b", null, `3 か月ごとに 12 回の判断、${ym(map, cm.H)}まで。`), "どの手も 3 か月ずつ。12 回目の後が 3 年後の行き先"),
      h("li", null, h("b", null, `1 手あたり約 2,000 の分かれ道。`), `今日の 10 の手それぞれの先に、${num(lo)}〜${num(hi)} の分かれ道（判断と出来事の分かれ）がある`),
      h("li", null, h("b", null, "2 年の進め方は無くなった。"), "1 年後から先も、3 か月ごとに選び直す"),
      h(
        "li",
        null,
        h("b", null, "差の比べ方が変わった。"),
        "塗りの数字は「今やる場合と、3 か月待ってから選ぶ場合の、3 年の稼ぎの差」。どの手も、その 3 か月は正確に、その後は標準の選び方で続けた見積もりどうしで比べる。前の版の差は「今のまま、その後は一番良い選び方」との差なので、同じ手でも数が違う",
      ),
    ),
    table,
    h("p", { class: "rel-foot" }, "3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる。見取り図で 10 の手の幅を並べて見られる"),
  );
  const goMap = h("button", { class: "btn btn-primary", type: "button", dataset: { fk: "rel-map" } }, "見取り図を見る");
  const goPath = vm.chain ? h("button", { class: "btn", type: "button", dataset: { fk: "rel-path" } }, "一番ありそうな道を読む") : null;
  goMap.addEventListener("click", () => {
    m.close();
    app.ui.closeDeep();
    app.ui.holdDeep(() => app.ui.clearSelection());
    if (!app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: true });
    requestAnimationFrame(() => {
      const sc = document.querySelector<HTMLElement>(".sidebar-right .insp-body-scroll");
      if (sc) sc.scrollTop = 0;
    });
  });
  goPath?.addEventListener("click", () => {
    m.close();
    app.ui.openDeep({ kind: "path", node: vm.chain!.node });
  });
  m.footer.append(...[goPath, goMap].filter((x): x is HTMLButtonElement => !!x));
  requestAnimationFrame(() => goMap.focus());
}
