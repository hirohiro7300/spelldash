// 新しい地図の知らせ（版 7。一度だけ: 表示の設定 releaseSheet と、文書の meta.releaseSheet に見せた版を覚える）。設計: 作業メモ SPEC v1 §5.9（見直し user-5・user-11）
// 言うこと: 2029 年 11 月まで 3 か月ごとに 12 回の判断・1 手あたり約 2,000 の分かれ道・2 年の進め方は無くなった・差の比べ方が変わった
// （前の版と今の版の今日の 10 の手の差の表と、前の版で選んだ・見送ったカードのうち差の向きか順位が変わった物の表: W-app の I5）・
// 「前の版で決めたこと」（新しい地図に無いカードで決めた物を残した所。直した見込みや線の説明も: W-app の I8）。
// ボタン: 見取り図を見る・一番ありそうな道を読む（・前の版で決めたことを見る）

import type { AppContext } from "../app/context";
import type { DeepCtx } from "../app/deepState";
import { deltaBetween, F_BASE, type Analysis } from "../deepmap/core";
import { overviewVM, ym } from "../deepmap/views";
import { buildFuture } from "../demo/futureBundle";
import { formatMan } from "../model/impactFormat";
import { decidedTable, deltaTable, flipLabel, optionDeltasOf, todayDeltasOf, type DecidedRow } from "../model/releaseNotes";
import type { DocData, GNode, ID } from "../model/types";
import { isNarrowScreen } from "./breakpoints";
import { showDeepOverview } from "./deepPanel";
import { h } from "./dom";
import { openModal } from "./overlays";

const num = (v: number): string => Math.round(v).toLocaleString("en-US");

/** 前の版で選んだ・見送ったカードの鍵の読み替え（版 6 の鍵 → 今の地図の鍵。地図を新しい版で読んだときの数: src/persist/legacyMap.ts） */
export type DecidedCards = ReadonlyArray<{ from: string; to: string; status: string }>;

/** 前の版（ページに同梱の版 6 の地図）の差。読めなければ空 */
function beforeDeltas(annual: number): { today: Map<string, number>; all: Map<string, number> } {
  try {
    const doc = buildFuture().pv.doc;
    return { today: todayDeltasOf(doc, annual), all: optionDeltasOf(doc, annual) };
  } catch {
    return { today: new Map(), all: new Map() };
  }
}

/** 今の地図の鍵の手の、今のままとの差と、同じ判断の手の差（数が出せなければ null） */
function afterOf(ctx: DeepCtx, a: Analysis): (key: string) => { delta: number | null; siblings: Array<{ key: string; delta: number | null }> } | null {
  const cm = ctx.cm;
  return (key) => {
    const j = ctx.map.indexOfKey(key);
    if (j <= 0) return null;
    const d = cm.parent[j]!;
    let base = -1;
    for (let s = cm.kidOff[d]!; s < cm.kidOff[d + 1]!; s++) if (cm.flags[cm.kids[s]!]! & F_BASE) base = cm.kids[s]!;
    if (base < 0) return null;
    const dOf = (x: number): number | null => (x === base ? 0 : (deltaBetween(a.pi, x, base)?.d ?? null));
    const siblings: Array<{ key: string; delta: number | null }> = [];
    for (let s = cm.kidOff[d]!; s < cm.kidOff[d + 1]!; s++) siblings.push({ key: ctx.map.key(cm.kids[s]!), delta: dOf(cm.kids[s]!) });
    return { delta: dOf(j), siblings };
  };
}

const STATUS_LABEL: Record<string, string> = { active: "選んだ手", done: "選んだ手（済み）", dropped: "見送った手" };

/** 「前の版で決めたこと」の見出しのカードと、その列のカード（新しい地図に無いカードで決めた物）。無ければ null */
export function prevGroupOf(doc: DocData): { group: GNode; cards: GNode[] } | null {
  let group: GNode | null = null;
  const cards: GNode[] = [];
  // 全体を見てよい: 一度だけの知らせ（新しい地図の知らせ）を開いたときに 1 回
  for (const n of Object.values(doc.nodes)) {
    if (typeof n.meta?.prevGroup === "number") group = n;
    else if (typeof n.meta?.prevKey === "string") cards.push(n);
  }
  if (!group) return null;
  cards.sort((p, q) => p.y - q.y || p.x - q.x);
  return { group, cards };
}

/** 「前の版で決めたこと」のカードの、前の版で直した線（見込み・説明・関係）の言い方。無ければ null */
export function prevEdgeText(n: GNode): string | null {
  const pe = n.meta?.prevEdge;
  if (!pe || typeof pe !== "object") return null;
  const e = pe as { p0?: unknown; prob?: unknown; label?: unknown; condition?: unknown; relation?: unknown };
  const parts: string[] = [];
  if (typeof e.p0 === "number") parts.push(`見込み ${Math.round(e.p0)}% → ${typeof e.prob === "number" ? `${Math.round(e.prob)}%` : "なし"}`);
  if (typeof e.label === "string" && e.label) parts.push(`線の説明「${e.label}」`);
  if (typeof e.condition === "string" && e.condition) parts.push(`条件「${e.condition}」`);
  if (typeof e.relation === "string") parts.push("線の種類を変えていた");
  return parts.length ? `前の版で直した線: ${parts.join("・")}` : null;
}

/** 知らせを出す（閉じたら onClose）。decided: 前の版で選んだ・見送ったカードの鍵の読み替え（この起動で地図を新しい版で読んだときだけ） */
export function openReleaseSheet(app: AppContext, ctx: DeepCtx, opts: { decided?: DecidedCards; notices?: readonly string[]; onClose?: () => void } = {}): void {
  const map = ctx.map;
  const cm = ctx.cm;
  const a = ctx.analysis();
  const ov = ctx.overview();
  const vm = overviewVM(a, ov, { name: (f) => ctx.text().title(f) });
  // 今日の手ごとの分かれ道（判断 + 出来事の分かれ）の幅
  let lo = Infinity;
  let hi = 0;
  for (const f of cm.firstMoves) {
    const forks = cm.nDec[f]! + cm.nSplit[f]!;
    lo = Math.min(lo, forks);
    hi = Math.max(hi, forks);
  }
  const names = new Map(vm.rows.map((r) => [r.kind, r.name]));
  const before = beforeDeltas(ctx.annual);
  const rows = deltaTable(
    before.today,
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
          h("td", null, cell(r.after, r.isBase), r.signChanged ? h("span", { class: "rel-tag" }, flipLabel(r.after!)) : null),
        ),
      ),
    ),
  );
  // 前の版で選んだ・見送ったカード（新しい地図のカードへ引き継いだ・移した物）のうち、差の向きか順位が変わった物
  const decided = opts.decided ?? [];
  const mine: DecidedRow[] = decided.length ? decidedTable(decided, before.all, afterOf(ctx, a)) : [];
  const doc = app.store.doc;
  const titleOf = (key: string): string => {
    const j = map.indexOfKey(key);
    const n = j >= 0 ? doc.nodes[ctx.idOf(j)] : undefined;
    return n?.title || key;
  };
  const tagOf = (r: DecidedRow): string => {
    const parts: string[] = [];
    if (r.signChanged) parts.push(flipLabel(r.after!));
    if (r.rankChanged) parts.push(`同じ判断の手の中で ${r.rankBefore} 番目 → ${r.rankAfter} 番目`);
    return parts.join("・");
  };
  const mineBlock = decided.length
    ? mine.length
      ? h(
          "table",
          { class: "rel-table rel-mine" },
          h("caption", null, "前の版で選んだ・見送ったカードで、差の向きか順位が変わった物（万円）"),
          h("thead", null, h("tr", null, h("th", { attrs: { scope: "col" } }, "カード"), h("th", { attrs: { scope: "col" } }, "前の版"), h("th", { attrs: { scope: "col" } }, "今の版"))),
          h(
            "tbody",
            null,
            ...mine.map((r) =>
              h(
                "tr",
                { class: r.signChanged ? "is-flip" : "" },
                h("th", { attrs: { scope: "row" } }, titleOf(r.key), h("span", { class: "rel-sub" }, `${STATUS_LABEL[r.status] ?? "決めた手"}・${ctx.place(map.indexOfKey(r.key)).ym}`)),
                h("td", null, r.before === null ? "—" : formatMan(r.before)),
                h("td", null, r.after === null ? "—" : formatMan(r.after), h("span", { class: "rel-tag" }, tagOf(r))),
              ),
            ),
          ),
        )
      : h("p", { class: "rel-foot rel-mine-none" }, `前の版で選んだ・見送ったカード ${decided.length} 枚は、新しい地図でも差の向きと同じ判断の手の中の順位が変わらなかった`)
    : null;
  // 「前の版で決めたこと」（新しい地図に無いカードで決めた物）
  const prev = prevGroupOf(doc);
  const prevBlock = prev
    ? h(
        "div",
        { class: "rel-prev" },
        h("p", { class: "rel-prev-head" }, h("b", null, "前の版で決めたこと"), `（今日の左・${prev.cards.length} 枚）: 新しい地図に無いカードで、選んだ・見送った・書き換えた物。中身は前の版のまま`),
        h(
          "ul",
          { class: "rel-prev-list" },
          ...prev.cards.slice(0, 6).map((n) => {
            const st = STATUS_LABEL[n.status];
            const edge = prevEdgeText(n);
            return h("li", null, h("span", { class: "rel-prev-title" }, n.title || "（題名なし）"), st ? h("span", { class: "rel-sub" }, st) : null, edge ? h("span", { class: "rel-sub" }, edge) : null);
          }),
          prev.cards.length > 6 ? h("li", { class: "rel-sub" }, `ほか ${prev.cards.length - 6} 枚`) : null,
        ),
      )
    : null;
  const m = openModal({ title: "新しい地図になった（版 7）", subtitle: `${ym(map, 0)}時点の地図・カード ${num(cm.n)} 枚`, width: 560, className: "rel-sheet", onClose: opts.onClose ?? (() => undefined), icon: "split" });
  // 起動の知らせ（引き上げで移した・残したカードの数など）。お知らせにすると、この知らせの上に長く重なるので、ここに出す（見直し R2）
  const notices = opts.notices?.length ? h("div", { class: "rel-notices", role: "note" }, ...opts.notices.map((t) => h("p", null, t))) : null;
  m.body.append(
    ...(notices ? [notices] : []),
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
    ...(mineBlock ? [mineBlock] : []),
    ...(prevBlock ? [prevBlock] : []),
    h("p", { class: "rel-foot" }, "3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる。見取り図で 10 の手の幅を並べて見られる"),
  );
  const goMap = h("button", { class: "btn btn-primary", type: "button", dataset: { fk: "rel-map" } }, "見取り図を見る");
  const goPath = vm.chain ? h("button", { class: "btn", type: "button", dataset: { fk: "rel-path" } }, "一番ありそうな道を読む") : null;
  const goPrev = prev ? h("button", { class: "btn", type: "button", dataset: { fk: "rel-prev" } }, "前の版で決めたことを見る") : null;
  goMap.addEventListener("click", () => {
    m.close();
    showDeepOverview(app);
  });
  goPath?.addEventListener("click", () => {
    m.close();
    app.ui.openDeep({ kind: "path", node: vm.chain!.node });
  });
  goPrev?.addEventListener("click", () => {
    m.close();
    if (!prev) return;
    const ids: ID[] = [prev.group.id, ...prev.cards.map((c) => c.id)].filter((id) => !!app.store.doc.nodes[id]);
    if (app.ui.prefs.view !== "map") app.ui.setPrefs({ view: "map" });
    app.ui.select([prev.group.id]);
    // 狭い画面では右の引き出しがキャンバスを覆うので閉じる（寄せた「前の版で決めたこと」のカードを見せる: 見直し R7）
    if (isNarrowScreen() && app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: false });
    app.view.fit(ids, { minZoom: 0.3 });
  });
  m.footer.append(...[goPrev, goPath, goMap].filter((x): x is HTMLButtonElement => !!x));
  requestAnimationFrame(() => goMap.focus());
}
