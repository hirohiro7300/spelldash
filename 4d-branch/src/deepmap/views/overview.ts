// 「3 年の見取り図」（設計: 作業メモ SPEC v1 §5.1。作業メモ user-1・user-4・user-13・truth-4・truth-18）
// 今日の手ごとに 1 行（良い順）。行の中は起きる順: その手（名前・2 つの差）→ その手で分かること（3 か月後）→
// この先の分かれ道（3 か月ごとの小さな帯と数）→ 3 年の合計の分布（9 段）と 10〜90%。行を押すとその手の詳しい画面（#move-…）へ。
// 狭い画面では行を縦に積み、広い画面では表のように 4 列に並べる（列の見出しは広い画面だけ）。

import { h, nobr, type Child } from "./dom";
import type { OverviewRowVM, OverviewVM } from "./model";
import { distBar, miniStrip, pill, scaleLegend, splitBar } from "./parts";

/** 区切りの間でだけ折り返す文（区切りが 1 行より長いときは中でも折り返す） */
function segs(parts: readonly string[]): Child[] {
  return parts.map((t) => h("span", { class: "dm-seg-t" }, nobr(t)));
}

function decidesEl(r: OverviewRowVM): HTMLElement {
  const d = r.decides;
  const box = h("div", { class: `dm-row-decides is-${d.kind}` });
  if (d.kind === "reveal" || d.kind === "outcomes") {
    box.append(
      h("span", { class: "dm-dec-head" }, d.head),
      splitBar(d.parts, d.kind === "reveal", d.head),
      h(
        "span",
        { class: "dm-dec-parts" },
        d.parts.map((p, k) => h("span", { class: "dm-seg-t" }, `${p.label} `, h("b", null, `${Math.round(p.share * 100)}%`), k < d.parts.length - 1 ? "・" : null)),
      ),
    );
    if (d.kind === "reveal" && d.near) box.append(h("span", { class: "dm-dec-note" }, "この手の先は『今のまま』の先と近い"));
  } else box.append(h("span", { class: "dm-dec-text" }, d.text));
  return box;
}

/** 見取り図の 1 行（押すとその手の詳しい画面） */
export function overviewRow(r: OverviewRowVM, stripMax: number): HTMLAnchorElement {
  return h(
    "a",
    {
      class: `dm-row${r.isPi ? " is-pi" : ""}${r.isBase ? " is-base" : ""}`,
      attrs: { href: r.href, "aria-label": r.aria },
      dataset: { kind: r.kind },
    },
    h("div", { class: "dm-row-head" }, h("span", { class: "dm-row-name" }, r.name), r.isPi ? h("span", { class: "dm-chip" }, "おすすめ") : null),
    h("div", { class: "dm-row-pills" }, r.delta ? pill(r.delta) : h("span", { class: "dm-pill-wrap is-none" }, "差を出せない"), r.worth ? pill(r.worth) : null),
    decidesEl(r),
    h(
      "div",
      { class: "dm-row-forks" },
      h(
        "span",
        { class: "dm-forks-top" },
        miniStrip(r.strip, stripMax, "3 か月ごとの分かれ道の数"),
        h("span", { class: "dm-forks-num" }, h("b", null, r.forksText.replace(/^この先の分かれ道 /, "")), h("span", null, "この先の分かれ道")),
      ),
      h("span", { class: "dm-row-counts" }, segs(r.countsParts)),
    ),
    h(
      "div",
      { class: "dm-row-dist" },
      distBar(r.bins, "3 年の合計の分布"),
      h("span", { class: "dm-row-range" }, r.rangeParts.length ? segs(r.rangeParts) : "3 年の合計を出せない"),
      r.vsKeepText ? h("span", { class: "dm-row-vs" }, nobr(r.vsKeepText)) : null,
      r.summaryText ? h("span", { class: "dm-row-vs is-warn" }, r.summaryText) : null,
    ),
    h("span", { class: "dm-row-go", attrs: { "aria-hidden": "true" } }, "›"),
  );
}

/** 見取り図の全体（見出し・結論・比べる元・行・結び・今日から一番良い選び方で進んだ場合） */
export function renderOverview(vm: OverviewVM): HTMLElement {
  const stripMax = Math.max(1, ...vm.rows.flatMap((r) => r.strip.map((c) => c.dec + c.split)));
  // 並びは良い順（順番に意味があるので番号付きの並び）
  const list = h("ol", { class: "dm-rows" });
  for (const r of vm.rows) list.append(h("li", { class: "dm-rows-item" }, overviewRow(r, stripMax)));
  const cols = h(
    "div",
    { class: "dm-cols", attrs: { "aria-hidden": "true" } },
    h("span", null, "今日の手"),
    h("span", null, "この手で分かること（3 か月後）"),
    h("span", null, "この先の分かれ道（3 か月ごと）"),
    h("span", null, "3 年の合計の分布（この手の後、一番良い選び方で）"),
  );
  const keep = vm.keep
    ? h(
        "div",
        { class: "dm-keep" },
        h("span", { class: "dm-keep-label" }, `比べる元: ${vm.keep.label}`),
        h("span", { class: "dm-keep-bar" }, distBar(vm.keep.bins, vm.keep.label)),
        h("span", { class: "dm-keep-text" }, nobr(vm.keep.text)),
      )
    : null;
  return h(
    "section",
    { class: "dm-overview", attrs: { "aria-labelledby": "dm-overview-h" } },
    h("div", { class: "dm-overview-intro" }, h("h2", { class: "dm-h2", attrs: { id: "dm-overview-h", tabindex: "-1" } }, "3 年の見取り図"), h("p", { class: "dm-lead" }, nobr(vm.lead))),
    h("div", { class: "dm-overview-tools" }, scaleLegend("ずっと今のままとの 3 年の合計の差（境目 3・30・100・300 万円）")),
    keep,
    cols,
    list,
    h("p", { class: "dm-footer" }, vm.footer),
    vm.headline || vm.chain
      ? h("div", { class: "dm-today" }, vm.headline ? h("p", { class: "dm-headline" }, nobr(vm.headline)) : null, vm.chain ? h("a", { class: "dm-btn", attrs: { href: vm.chain.href } }, `今日から${vm.chain.text}`) : null)
      : null,
  );
}
