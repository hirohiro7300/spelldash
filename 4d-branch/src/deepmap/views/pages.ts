// 画面の組み立て: 手の詳しい画面（#move-…）と道の画面の仮の形（#path-…）
// 試し版（src/preview）とアプリ（P2）の両方で使う。行き来（ハッシュ）は使う側が決め、ここはリンクの先を受け取るだけ。

import { h, nobr } from "./dom";
import { fanChart } from "./fanChart";
import { OVERVIEW_HASH } from "./format";
import type { DestRowVM, MoveDetailVM, PathVM } from "./model";
import { pill, SPLIT_COLORS, swatch } from "./parts";
import { destSection, pathSection, planSection, stripSection } from "./sections";

export interface PageHandle {
  el: HTMLElement;
  destroy(): void;
}

export interface MoveDetailOpts {
  /** 行き先の種類を押したとき（k 番目の行き先へ） */
  onDest(row: DestRowVM, k: number): void;
  /** 行き先の次に見せる番号（画面を作り直しても続きから） */
  destCursor: Map<string, number>;
  /** 戻り先（無ければ見取り図） */
  backHref?: string;
}

function card(id: string, title: string, sub: string | null, ...body: Array<Node | null>): HTMLElement {
  return h("section", { class: `dm-card dm-card-${id}`, attrs: { "aria-labelledby": `dm-${id}-h` } }, h("h3", { class: "dm-h3", attrs: { id: `dm-${id}-h` } }, title), sub ? h("p", { class: "dm-sub" }, sub) : null, ...body);
}

/** 手の詳しい画面: 見出し（差・まとめの数・この手の結果・一番ありそうな道）→ 扇 → 分かれ道の帯 → 進め方 → 行き先 */
export function renderMoveDetail(vm: MoveDetailVM, opts: MoveDetailOpts): PageHandle {
  const r = vm.row;
  const reveal = r.decides.kind === "reveal";
  const outs = h(
    "ul",
    { class: "dm-outs" },
    vm.outcomes.map((o, k) =>
      h(
        "li",
        { class: "dm-out" },
        h("span", { class: "dm-out-name" }, reveal ? swatch(SPLIT_COLORS[k] ?? "#5d6577") : null, o.label),
        h("b", { class: "dm-out-pct" }, o.shareText),
        h("span", { class: "dm-out-total" }, nobr(o.totalText), o.vsKeepText ? h("small", null, nobr(o.vsKeepText)) : null),
      ),
    ),
  );
  const fan = fanChart(vm.fan);
  const el = h(
    "article",
    { class: "dm-move" },
    h("a", { class: "dm-back", attrs: { href: opts.backHref ?? OVERVIEW_HASH } }, "‹ 見取り図へ"),
    h(
      "header",
      { class: "dm-move-head" },
      h(
        "div",
        { class: "dm-move-main" },
        h("p", { class: "dm-eyebrow" }, vm.eyebrow),
        h("h2", { class: "dm-h2", attrs: { tabindex: "-1" } }, r.name, r.isPi ? h("span", { class: "dm-chip" }, "おすすめ") : null),
        h("div", { class: "dm-move-pills" }, r.delta ? pill(r.delta) : null, r.worth ? pill(r.worth) : null),
        h("ul", { class: "dm-facts" }, vm.facts.map((t) => h("li", null, nobr(t)))),
        r.decides.kind === "near" || (r.decides.kind === "reveal" && r.decides.near) ? h("p", { class: "dm-sub" }, r.decides.kind === "near" ? r.decides.text : "この手の先は『今のまま』の先と近い") : null,
        vm.chain ? h("a", { class: "dm-btn is-primary", attrs: { href: vm.chain.href } }, vm.chain.text) : null,
      ),
      vm.outcomes.length ? h("div", { class: "dm-outs-box" }, h("p", { class: "dm-outs-head" }, vm.outcomesHead, h("span", null, "その後、一番良い選び方で進んだ 3 年の合計")), outs) : null,
    ),
    h(
      "div",
      { class: "dm-move-grid" },
      card("fan", "月の稼ぎの広がり", vm.fan.answers.length ? "この手の後、一番良い選び方で進んだときの月の稼ぎ。会社の答えなど、この手で分かることの答えごとに分けて見られる" : "この手の後、一番良い選び方で進んだときの月の稼ぎ", fan.el),
      card("strip", "分かれ道の数（3 か月ごと）", "この手の先に、いつ、いくつ分かれ道があるか", stripSection(vm.strip)),
      card("plan", "進め方（3 か月ごとのおすすめの手）", "その時に判断がある道の中で、どの手を選ぶことになるかの割合と、そうなる直前の結果", planSection(vm.plan)),
      card(
        "dest",
        `${vm.endYm}の行き先（種類ごと）`,
        "この手の後、一番良い選び方で着く行き先を、仕事・会社の答え・副業・Pro でまとめた。押すと、その種類の道を見込みの高い順に 1 本ずつ見る",
        destSection(vm.dest, { onPick: opts.onDest, cursor: opts.destCursor }),
      ),
    ),
  );
  return { el, destroy: () => fan.destroy() };
}

/** 道の画面の仮の形（一番ありそうな道の行を並べるだけ） */
export function renderPathPage(vm: PathVM): PageHandle {
  const el = h(
    "article",
    { class: "dm-move dm-path-page" },
    h("a", { class: "dm-back", attrs: { href: vm.backHref } }, `‹ ${vm.backText}`),
    h("header", { class: "dm-move-head" }, h("p", { class: "dm-eyebrow" }, "道（試しの形）"), h("h2", { class: "dm-h2", attrs: { tabindex: "-1" } }, vm.title), h("p", { class: "dm-sub" }, nobr(vm.intro))),
    pathSection(vm),
  );
  return { el, destroy() {} };
}
