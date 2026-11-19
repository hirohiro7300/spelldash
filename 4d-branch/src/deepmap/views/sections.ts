// 手の詳しい画面の部品: 分かれ道の帯（§5.2）・進め方（§5.3）・行き先（§5.7）・見方と前提
// どれも画面に出す形（model.ts）を受け取って DOM を返すだけ（計算はしない）

import { h, nobr } from "./dom";
import { num } from "./format";
import type { DestRowVM, DestVM, PlanRowVM, StripVM } from "./model";

// ------------------------------------------------------------ 分かれ道の帯

/** 年の区切り（帯の下の年の目盛り: 2026 年 | 2027 年 …）。列の年月から作る */
function yearSpans(yms: readonly string[]): Array<{ year: string; span: number }> {
  const out: Array<{ year: string; span: number }> = [];
  for (const t of yms) {
    const y = /^(\d{4}) 年/.exec(t)?.[1] ?? "";
    const last = out[out.length - 1];
    if (last && last.year === y) last.span++;
    else out.push({ year: y, span: 1 });
  }
  return out;
}

/** 3 か月ごとの分かれ道の数（下が判断・上が出来事の分かれ。上の数は合わせた数） */
export function stripSection(vm: StripVM): HTMLElement {
  const max = Math.max(1, ...vm.cols.map((c) => c.dec + c.split));
  const n = vm.cols.length;
  const grid = h("div", {
    class: "dm-strip-cols",
    style: { "grid-template-columns": `repeat(${n}, minmax(0, 1fr))` },
    attrs: { role: "img", "aria-label": `3 か月ごとの分かれ道の数: ${vm.cols.map((c) => `${c.ym} ${num(c.dec + c.split)}（判断 ${num(c.dec)}・出来事の分かれ ${num(c.split)}）`).join("、")}` },
  });
  for (const c of vm.cols) {
    const tot = c.dec + c.split;
    grid.append(
      h(
        "div",
        { class: "dm-strip-col", title: `${c.ym}: 判断 ${num(c.dec)} 回・出来事の分かれ ${num(c.split)}`, attrs: { "aria-hidden": "true" } },
        h("span", { class: "dm-strip-num" }, tot > 0 ? num(tot) : ""),
        h(
          "span",
          { class: "dm-strip-bar" },
          c.split > 0 ? h("i", { class: "dm-strip-split", style: { height: `${(c.split / max) * 100}%` } }) : null,
          c.dec > 0 ? h("i", { class: "dm-strip-dec", style: { height: `${(c.dec / max) * 100}%` } }) : null,
        ),
        h("span", { class: "dm-strip-m" }, c.m === 0 ? "今日" : (/(\d+) 月$/.exec(c.ym)?.[1] ?? "") + " 月"),
      ),
    );
  }
  const years = h("div", { class: "dm-strip-years", style: { "grid-template-columns": `repeat(${n}, minmax(0, 1fr))` }, attrs: { "aria-hidden": "true" } });
  // 1 列だけの年は名前を書かない（狭くて隣の年と重なる）。線だけ引く
  for (const y of yearSpans(vm.cols.map((c) => c.ym))) years.append(h("span", { style: { "grid-column": `span ${y.span}` } }, y.year && y.span >= 2 ? `${y.year} 年` : ""));
  return h(
    "figure",
    { class: "dm-strip" },
    h("ul", { class: "dm-legend" }, h("li", null, h("i", { class: "dm-key-band is-dec", attrs: { "aria-hidden": "true" } }), h("span", null, "判断（手を選ぶ時点）")), h("li", null, h("i", { class: "dm-key-band is-split", attrs: { "aria-hidden": "true" } }), h("span", null, "出来事の分かれ（結果が分かれる手）"))),
    h("div", { class: "dm-scroll dm-strip-scroll" }, h("div", { class: "dm-strip-inner" }, grid, years)),
    h("figcaption", { class: "dm-fan-cap" }, h("span", { class: "dm-strip-total" }, nobr(vm.caption)), h("span", null, "上の数は、その 3 か月に始まる分かれ道の数（判断 + 出来事の分かれ）")),
  );
}

// ------------------------------------------------------------ 進め方

export function planSection(rows: readonly PlanRowVM[]): HTMLElement {
  const list = h("ol", { class: "dm-plan" });
  for (const r of rows) {
    const moves = h("ul", { class: "dm-plan-moves" });
    for (const m of r.moves) {
      moves.append(
        h(
          "li",
          { class: "dm-plan-move" },
          h("span", { class: "dm-plan-line" }, h("span", { class: "dm-plan-name" }, m.name), h("b", { class: "dm-plan-pct" }, m.shareText)),
          h("span", { class: "dm-plan-bar", attrs: { "aria-hidden": "true" } }, h("i", { style: { width: `${Math.max(1, Math.round(m.share * 100))}%` } })),
          m.cond ? h("span", { class: "dm-plan-cond" }, m.cond) : null,
          m.stubText ? h("span", { class: "dm-plan-cond is-warn" }, m.stubText) : null,
        ),
      );
    }
    list.append(
      h(
        "li",
        { class: "dm-plan-row" },
        h("div", { class: "dm-plan-when" }, h("b", null, r.ym), r.span ? h("span", null, r.span) : null),
        h("div", { class: "dm-plan-body" }, moves, r.more ? h("p", { class: "dm-plan-more" }, r.more) : null, r.note ? h("p", { class: "dm-plan-more" }, r.note) : null),
      ),
    );
  }
  return list;
}

// ------------------------------------------------------------ 行き先

export interface DestOpts {
  /** 行を押したとき: その種類の k 番目の行き先へ（k は 0 から） */
  onPick(row: DestRowVM, k: number): void;
  /** 次に見せる番号（行の鍵ごと。画面を作り直しても続きから） */
  cursor: Map<string, number>;
}

export function destSection(vm: DestVM, opts: DestOpts): HTMLElement {
  const list = h("ol", { class: "dm-dest" });
  for (const r of vm.rows) {
    const n = r.ends.length;
    const next = h("span", { class: "dm-dest-next" });
    const showNext = () => {
      const k = (opts.cursor.get(r.key) ?? 0) % Math.max(1, n);
      next.textContent = n > 1 ? `次に見る道 ${num(k + 1)} / ${num(n)}` : "1 通りの道";
    };
    showNext();
    list.append(
      h(
        "li",
        null,
        h(
          "button",
          {
            class: "dm-dest-row",
            attrs: { type: "button", "aria-label": `${r.label}・${r.shareText}・${r.countText}・${r.meanText}${r.vsKeepText ? `・${r.vsKeepText}` : ""}。押すとこの種類の道を 1 本ずつ見る` },
            on: {
              click: () => {
                if (!n) return;
                const k = (opts.cursor.get(r.key) ?? 0) % n;
                opts.cursor.set(r.key, (k + 1) % n);
                showNext();
                opts.onPick(r, k);
              },
            },
          },
          h("b", { class: "dm-dest-pct" }, r.shareText),
          h(
            "span",
            { class: "dm-dest-main" },
            h("span", { class: "dm-dest-label" }, r.label),
            h("span", { class: "dm-dest-bar", attrs: { "aria-hidden": "true" } }, h("i", { style: { width: `${Math.max(1, Math.round(r.share * 100))}%` } })),
            h("span", { class: "dm-dest-meta" }, nobr(`${r.countText}・${r.meanText}${r.vsKeepText ? `（${r.vsKeepText}）` : ""}`)),
            r.summaryText ? h("span", { class: "dm-dest-meta is-warn" }, r.summaryText) : null,
            next,
          ),
          h("span", { class: "dm-row-go", attrs: { "aria-hidden": "true" } }, "›"),
        ),
      ),
    );
  }
  return h("div", { class: "dm-dest-box" }, list, vm.more ? h("p", { class: "dm-plan-more" }, vm.more) : null);
}

// ------------------------------------------------------------ 見方と前提

export interface NotesVM {
  howTo: string[];
  premises: string[];
  annual: number;
}

export function notesSection(vm: NotesVM): HTMLElement {
  return h(
    "section",
    { class: "dm-notes", attrs: { "aria-labelledby": "dm-notes-h" } },
    h("h2", { class: "dm-h2 is-small", attrs: { id: "dm-notes-h" } }, "見方"),
    h("ul", { class: "dm-notes-list" }, vm.howTo.map((t) => h("li", null, nobr(t)))),
    h(
      "details",
      { class: "dm-premises" },
      h("summary", null, `前提（数字の決め方・${num(vm.premises.length)} 項目）`),
      vm.premises.length ? h("ul", { class: "dm-notes-list" }, vm.premises.map((t) => h("li", null, t))) : h("p", { class: "dm-plan-more" }, "この地図には前提が書かれていない"),
    ),
  );
}
