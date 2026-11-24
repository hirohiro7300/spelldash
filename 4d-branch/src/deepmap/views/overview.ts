// 「3 年の見取り図」（設計: 作業メモ SPEC v1 §5.1。作業メモ user-1・user-3・user-4・user-13・truth-2・truth-4・truth-18）
// 上から: 見出しと読み方（3 年の幅は、この手より、この先の選び方と運で決まる）→ 資産のゴールの帯（src/deepmap/views/goal.ts）→「10 の手をひと目で」（共通の万円の軸に、
// どの手も 3 年の合計の 10〜90% の棒と真ん中の線・ずっと今のままの点線。1 行 44px で、スマホの最初の画面に 10 行が入る）→
// 段の色の見本と比べる元 → 今日の手ごとのカード（良い順）→ 今日から一番ありそうな道・真ん中あたりの道。
// カードの中は起きる順: その手（名前・2 つの差）→ その手で分かること（3 か月後）→ この先の分かれ道（3 か月ごとの小さな帯と数）→
// 3 年の合計の分布（9 段）と 10〜90%・ずっと今のままより・3 か月待っても。カードを押すとその手の詳しい画面（#move-…）へ。
// 狭い画面ではカードを縦に積み、判断・行き先の数の 1 行は手の詳しい画面にだけ出す（カードを短く）。広い画面では表のように 4 列に並べる。

import { h, nobr, type Child } from "./dom";
import { goalSeedEl, goalSkeletonEl, goalStripEl, type GoalOverviewVM } from "./goal";
import { num } from "./format";
import type { ChainVM, GlanceVM, OverviewRowVM, OverviewVM } from "./model";
import { distBar, miniStrip, pill, pillValue, scaleLegend, splitBar } from "./parts";

/**
 * 前に組み立てた部品（同じ中身なら組み直さずに使い回す）。アプリの概要が、計算が変わるたびに見取り図を作り直すときに渡す
 * （これにした後に変わるのはその手の行だけ。試し版は渡さない）。prev は前の回の部品で、組み立てた後は今回の物に替わる。
 * 使い回すのは置かれていない（ページに無い）物だけ。置かれている物は写す（ページから抜かない）
 */
export interface OverviewMemo {
  prev: Map<string, Element>;
}

/** key の部品を、前の回にあれば使い回し（置かれている・今回もう使った物は写す）、無ければ組み立てる。next に今回の物を覚える */
function reuse<T extends Element>(memo: OverviewMemo | undefined, next: Map<string, Element>, key: string, build: () => T): T {
  if (!memo) return build();
  const used = next.get(key);
  const kept = used ?? memo.prev.get(key);
  const el = !kept ? build() : used || kept.isConnected ? (kept.cloneNode(true) as T) : (kept as T);
  if (!used) next.set(key, el);
  return el;
}

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
  } else box.append(h("span", { class: "dm-dec-text" }, d.text));
  const note = d.kind === "reveal" || d.kind === "outcomes" || d.kind === "plain" ? d.note : null;
  if (note) box.append(h("span", { class: "dm-dec-note" }, note));
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
      h("span", { class: "dm-row-dist-head" }, r.distHead),
      distBar(r.bins, "3 年の合計の分布"),
      h("span", { class: "dm-row-range" }, r.rangeParts.length ? segs(r.rangeParts) : "3 年の合計を出せない"),
      r.vsKeepText ? h("span", { class: "dm-row-vs" }, nobr(r.vsKeepText)) : null,
      r.waitText ? h("span", { class: "dm-row-vs is-wait" }, nobr(r.waitText)) : null,
      r.summaryText ? h("span", { class: "dm-row-vs is-warn" }, r.summaryText) : null,
    ),
    h("span", { class: "dm-row-go", attrs: { "aria-hidden": "true" } }, "›"),
  );
}

/** 軸の上の位置（%） */
function at(g: GlanceVM, v: number): string {
  return `${((Math.max(g.lo, Math.min(g.hi, v)) - g.lo) / Math.max(1e-9, g.hi - g.lo)) * 100}%`;
}

/** 「10 の手をひと目で」: 1 行 = 名前・今やる vs 3 か月待つ・共通の軸の 3 年の合計の棒（10〜90%・真ん中）（作業メモ user-3） */
function glanceEl(g: GlanceVM, goal: GoalOverviewVM | null, memo?: OverviewMemo, next: Map<string, Element> = new Map()): HTMLElement {
  const axis = h("div", { class: "dm-glance-axis", attrs: { "aria-hidden": "true" } });
  const ticks = h("span", { class: "dm-glance-ticks" });
  g.ticks.forEach((t, k) => ticks.append(h("span", { class: k === 0 ? "is-first" : k === g.ticks.length - 1 ? "is-last" : "", style: { left: at(g, t) } }, num(t))));
  if (g.keep !== null) ticks.append(h("span", { class: "dm-glance-keepmark", style: { left: at(g, g.keep) } }));
  axis.append(h("span", { class: "dm-glance-axis-label" }, "3 年の合計（万円）"), ticks);
  const legend = g.keepLabel
    ? h(
        "p",
        { class: "dm-glance-legend", attrs: { "aria-hidden": "true" } },
        h("i", { class: "dm-glance-legend-keep" }),
        nobr(g.keepLabel),
        h("i", { class: "dm-glance-legend-range" }),
        "10〜90%",
        h("i", { class: "dm-glance-legend-mid" }),
        "真ん中",
      )
    : null;
  const list = h("ol", { class: "dm-glance-list" });
  const axisKey = JSON.stringify([g.lo, g.hi, g.ticks, g.keep]);
  const gk = goal?.key ?? "";
  for (const r of g.rows) list.append(reuse(memo, next, `g${axisKey}${gk}${JSON.stringify(r)}`, () => glanceItem(g, r, gk)));
  return h(
    "section",
    { class: "dm-glance", attrs: { "aria-labelledby": "dm-glance-h" } },
    h("div", { class: "dm-glance-head" }, h("h3", { class: "dm-h3", attrs: { id: "dm-glance-h" } }, g.title), h("p", { class: "dm-glance-sub" }, nobr(g.sub))),
    axis,
    list,
    legend,
    g.note ? h("p", { class: "dm-glance-note" }, g.note) : null,
    // 芽とは何か（資産のゴールの数ができたら埋める）
    h("p", { class: "dm-glance-note dm-goal-seednote", dataset: { goalKey: gk } }, goal?.seedNote ?? ""),
  );
}

/** 「10 の手をひと目で」の 1 行 */
function glanceItem(g: GlanceVM, r: GlanceVM["rows"][number], goalKey: string): HTMLLIElement {
  const bar = h("span", { class: "dm-glance-bar", attrs: { "aria-hidden": "true" } });
  for (const t of g.ticks) bar.append(h("i", { class: "dm-glance-grid", style: { left: at(g, t) } }));
  if (g.keep !== null) bar.append(h("i", { class: "dm-glance-keep", style: { left: at(g, g.keep) } }));
  if (r.range) {
    bar.append(
      h("i", { class: "dm-glance-range", style: { left: at(g, r.range.p10), right: `calc(100% - ${at(g, r.range.p90)})` } }),
      h("i", { class: "dm-glance-mid", style: { left: at(g, r.range.p50) } }),
    );
  }
  const dp = r.delta;
  return h(
    "li",
    null,
    h(
      "a",
      { class: `dm-glance-row${r.isPi ? " is-pi" : ""}${r.isBase ? " is-base" : ""}`, attrs: { href: r.href, "aria-label": r.aria } },
      h("span", { class: "dm-glance-name" }, r.name),
      dp ? h("span", { class: "dm-glance-pill" }, pillValue(dp)) : h("span", { class: "dm-glance-pill is-none" }, "差なし"),
      goalSeedEl(r.node, r.seed, goalKey),
      bar,
    ),
  );
}

/** 一番ありそうな道・真ん中あたりの道のボタン（下に 3 年の合計と行き先の中の位置） */
export function chainLinks(xs: ReadonlyArray<ChainVM | null>, primary = false): HTMLElement | null {
  const items = xs.filter((x): x is ChainVM => !!x);
  if (!items.length) return null;
  return h(
    "div",
    { class: "dm-chains" },
    items.map((c, k) => h("div", { class: "dm-chain" }, h("a", { class: `dm-btn${primary && k === 0 ? " is-primary" : ""}`, attrs: { href: c.href } }, c.text), c.sub ? h("p", { class: "dm-chain-sub" }, nobr(c.sub)) : null)),
  );
}

/** 見取り図の全体（見出し・読み方・ひと目・比べる元・行・今日から一番良い選び方で進んだ場合） */
export function renderOverview(vm: OverviewVM, memo?: OverviewMemo): HTMLElement {
  const stripMax = Math.max(1, ...vm.rows.flatMap((r) => r.strip.map((c) => c.dec + c.split)));
  const next = new Map<string, Element>();
  // 並びは良い順（順番に意味があるので番号付きの並び）
  const list = h("ol", { class: "dm-rows" });
  for (const r of vm.rows) list.append(reuse(memo, next, `r${stripMax}${JSON.stringify(r)}`, () => h("li", { class: "dm-rows-item" }, overviewRow(r, stripMax))));
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
  const el = h(
    "section",
    { class: "dm-overview", attrs: { "aria-labelledby": "dm-overview-h" } },
    h(
      "div",
      { class: "dm-overview-intro" },
      h("h2", { class: "dm-h2", attrs: { id: "dm-overview-h", tabindex: "-1" } }, "3 年の見取り図"),
      h("p", { class: "dm-lead" }, nobr(vm.lead)),
      h("p", { class: "dm-frame" }, vm.frame),
    ),
    vm.goal ? goalStripEl(vm.goal.strip) : goalSkeletonEl(),
    glanceEl(vm.glance, vm.goal, memo, next),
    h("div", { class: "dm-overview-tools" }, scaleLegend("カードの棒の色: ずっと今のままとの 3 年の合計の差（万円）")),
    keep,
    h("h3", { class: "dm-h3 dm-cards-h" }, `${num(vm.rows.length)} の手のくわしい見取り図（良い順）`),
    cols,
    list,
    vm.headline || vm.chain || vm.median
      ? h(
          "div",
          { class: "dm-today" },
          vm.headline ? h("p", { class: "dm-headline" }, nobr(vm.headline)) : null,
          h("p", { class: "dm-goal-today", attrs: { hidden: !vm.goal?.today }, dataset: { goalKey: vm.goal?.key ?? "" } }, vm.goal?.today ? nobr(vm.goal.today) : null),
          chainLinks([vm.chain, vm.median]),
        )
      : null,
  );
  if (memo) memo.prev = next;
  return el;
}
