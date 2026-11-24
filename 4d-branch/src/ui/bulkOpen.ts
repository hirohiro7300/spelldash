// まとめて開く（3 か月ごとの地図・版 7）。設計: 作業メモ bulk/design.md（A〜D）
//   A 段数で開く        選んだカードの先を 3 か月先・半年先・1 年先・2 年先・地図の終わりまで（ちょうどその段数の形にする）
//   B 見込みの高い道    今日か選んだカードから、見込みの高い道 5 本・10 本の上のカードだけを開く（開いている物に足す）
//   C 複数のカード      選んだ何枚かの先を、同じ段数でいっぺんに（入れ子なら深い方の区切り）。タッチでは「ほかのカードも選ぶ」で選ぶ
//   D 同じ時期まで      今日から、選んだ時期（3 か月ごとの 12 の時期）までの判断と手を全部
// どれも押す前に開いた後の枚数を出し、キャンバス全体で 3,000 枚（DEEP_OPEN_CAP）を超えるものは開かず見取り図へ。足す枚数が 1,000 枚を
// 超える・縦に 320 行を超えるときは、ページの中の確かめ（confirmDialog）で聞いてから開く。開く・閉じるは見え方だけ（UiState.prefs.impactOpen:
// 文書・履歴・保存・同期は変えない）で、1 回の操作は 1 回の setImpactOpen。お知らせの「元に戻す」で前の形へ戻す

import type { AppContext } from "../app/context";
import type { DeepCtx } from "../app/deepState";
import type { OpenSnapshot } from "../app/viewModel";
import { ym } from "../deepmap/views";
import { BULK_ASK_CARDS, DEEP_OPEN_CAP, DEEP_OPEN_ROWS, DEPTH_STEPS, deepDepths, foldPlan, likelyPaths, quarterOpens, shapePlan, topsOf, visibleUnderEach, type DeepHorizon, type ShapePick } from "../model/deepOpen";
import type { ID } from "../model/types";
import { isNarrowScreen } from "./breakpoints";
import { clear, h } from "./dom";
import { icon } from "./icons";
import { confirmDialog, toast } from "./overlays";

/** 数を 3 桁ごとに区切る */
const num = (v: number): string => Math.round(v).toLocaleString("en-US");

/** 数と単位（「1 年」「383 枚」）を 1 かたまりにする（390 の幅で数と単位の間で折り返さない: 見直し reader-4） */
export const keepNum = (t: string): string => t.replace(/(\d) /g, "$1 ");

/** 開いている形ごとに覚えた、開いているカードの番号（開いている形は変えるたびに別の物になる） */
const openIdxMemo = new WeakMap<DeepCtx, { src: object; set: ReadonlySet<string>; out: number[] }>();

/** 地図で今開いているカード（地図の番号。地図の外の自分のカードは入れない） */
export function openIdx(app: AppContext, ctx: DeepCtx): number[] {
  const src = app.ui.prefs.impactOpen;
  const set = app.vm.impactOpenSet(ctx.root);
  const hit = openIdxMemo.get(ctx);
  if (hit && hit.src === src && hit.set === set) return hit.out;
  const out: number[] = [];
  for (const id of set) {
    const j = ctx.indexOf(id);
    if (j >= 0) out.push(j);
  }
  openIdxMemo.set(ctx, { src, set, out });
  return out;
}

/** 見えるノードの集まりごとに覚えた、見えている地図のカードの番号（小さい順） */
const drawnMemo = new WeakMap<DeepCtx, { gen: number; vm: object; sorted: Int32Array; drawn: number }>();

/**
 * 今見えているカードの数と、そのうち覆う先（tops: 番号の順）の中の物の数（頭は含まない）。見えている地図のカードの番号は、見える物が
 * 変わったときだけ並べ直す（選ぶたびに 2,600 枚をなめない: 作業メモ bulk §5）。数えるのは覆う先ごとに 2 分探し
 */
export function drawnSplit(app: AppContext, ctx: DeepCtx, tops: readonly number[]): { drawn: number; inside: number } {
  const vm = app.vm;
  vm.ensure();
  let m = drawnMemo.get(ctx);
  if (!m || m.gen !== vm.visibleGen || m.vm !== vm) {
    const xs: number[] = [];
    for (const nid of vm.drawNodes) {
      const j = ctx.indexOf(nid);
      if (j > 0) xs.push(j);
    }
    const sorted = Int32Array.from(xs).sort();
    drawnMemo.set(ctx, (m = { gen: vm.visibleGen, vm, sorted, drawn: vm.drawNodes.length }));
  }
  const lower = (v: number): number => {
    let lo = 0;
    let hi = m!.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (m!.sorted[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let inside = 0;
  for (const t of topsOf(ctx.cm, tops)) inside += lower(t + ctx.cm.size[t]!) - lower(t + 1);
  return { drawn: m.drawn, inside };
}

/** 段数の言葉（「3 か月先まで」「半年先まで」「1 年先まで」「2029 年 11 月まで」） */
export function depthLabel(ctx: DeepCtx, x: { months: number; toEnd: boolean }): string {
  if (x.toEnd) return `${ym(ctx.map, ctx.cm.H)}まで`;
  if (x.months === 6) return "半年先まで";
  if (x.months % 12 === 0) return `${x.months / 12} 年先まで`;
  return `${x.months} か月先まで`;
}

/** 今日からの時期の言葉（「3 か月後」「半年後」「1 年後」「1 年 3 か月後」「1 年半後」） */
export function relLabel(m: number): string {
  if (m === 6) return "半年後";
  if (m < 12) return `${m} か月後`;
  const y = Math.floor(m / 12);
  const r = m % 12;
  if (!r) return `${y} 年後`;
  if (r === 6) return `${y} 年半後`;
  return `${y} 年 ${r} か月後`;
}

/** まとめて開く 1 回の中身（地図の番号） */
export interface BulkRun {
  /** どこから（「今日」「「名前」」「選んだ 3 枚」） */
  from: string;
  /** 何を（「1 年先まで」「2027 年 11 月まで」「見込みの高い道 5 本」） */
  what: string;
  /** 道だけを開く（B）か、その時期までの全部か（A・C・D） */
  paths?: boolean;
  open: number[];
  close: number[];
  /** キャンバスを寄せる目印のカード（開き始めたカード） */
  head: number;
  /** 開いた後に見える、覆う先のカードの数 */
  count: number;
  rows: number;
  /** 開いた後のキャンバス全体の数 */
  total: number;
  /** 開く前に見えている数 */
  drawn: number;
  /** 開いた後に戻す道（お知らせの「元に戻す」のほか） */
  back: string;
  /** 見取り図で見る（無ければ出さない） */
  mapLink: (() => void) | null;
}

/** 開く前に聞くか（足す枚数が 1,000 枚を超える・縦に 320 行を超える） */
export const needsAsk = (total: number, drawn: number, rows: number): boolean => total - drawn > BULK_ASK_CARDS || rows > DEEP_OPEN_ROWS;

/** 開く前の形へ戻す（お知らせの「元に戻す」）。その後にほかの開く・たたむがあれば戻さずに訳を言う */
export function undoOpen(app: AppContext, snap: OpenSnapshot): void {
  if (app.vm.restoreOpen(snap)) toast("開く前の形に戻した", { ms: 2400 });
  else toast("そのあとに開く・たたむをしたため、ここからは戻せません（「この先をまとめてたたむ」か「最初の形に戻す」で戻せます）", { tone: "warn", ms: 8000 });
}

/** まとめて開く（大きければページの中で聞いてから。1 回の setImpactOpen・お知らせに「元に戻す」） */
export async function runBulk(app: AppContext, ctx: DeepCtx, r: BulkRun): Promise<boolean> {
  const what = `${/^\d/.test(r.what) ? " " : ""}${r.what}`;
  if (needsAsk(r.total, r.drawn, r.rows)) {
    const shape = r.rows > DEEP_OPEN_ROWS ? `キャンバスは縦に約 ${num(r.rows)} 行になり、引いて見ることになります。` : `キャンバスのカードは全体で ${num(r.total)} 枚になります。`;
    const ok = await confirmDialog({
      title: `${num(r.count)} 枚を開きます`,
      body: `${r.from}から${what}${r.paths ? "の道の上のカードを開きます。" : "の判断と手をすべて開きます。"}${shape}開いた後は、お知らせの「元に戻す」か「${r.back}」で戻せます。`,
      ok: "開く",
      cancel: "やめる",
    });
    if (!ok) return false;
  }
  const ids: ID[] = [];
  if (r.open.includes(r.head)) ids.push(ctx.idOf(r.head));
  for (const j of r.open) if (j !== r.head) ids.push(ctx.idOf(j));
  const snap = app.vm.bulkOpen(
    ids,
    r.close.map((j) => ctx.idOf(j)),
    { reveal: true },
  );
  if (app.ui.prefs.view !== "map") app.ui.setPrefs({ view: "map" });
  if (isNarrowScreen() && app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: false });
  if (!snap) {
    toast(keepNum(`もう開いています（${num(r.count)} 枚）`), { ms: 2400 });
    return true;
  }
  toast(`${r.from}から${keepNum(what)}${r.paths ? "の道" : "の判断と手"}を開いた（${num(r.count)} 枚）`, {
    tone: "ok",
    ms: 8000,
    action: { label: "元に戻す", run: () => undoOpen(app, snap) },
    action2: r.mapLink ? { label: "見取り図で見る", run: r.mapLink } : undefined,
  });
  return true;
}

/** まとめてたたむ（頭のカードを閉じ、その先で開いている物を全部閉じる。1 回の setImpactOpen） */
export function runFold(app: AppContext, ctx: DeepCtx, tops: readonly number[], from: string, n: number): void {
  const close = foldPlan(ctx.cm, tops, openIdx(app, ctx)).map((j) => ctx.idOf(j));
  const snap = app.vm.bulkOpen([], close);
  if (!snap) return;
  toast(keepNum(`${from}の先をたたんだ（${num(n)} 枚）`), { tone: "ok", ms: 8000, action: { label: "元に戻す", run: () => undoOpen(app, snap) } });
}

/** 開くボタン（ボタンの文は数と単位を 1 かたまりに） */
function openBtn(fk: string, text: string, title: string, run: () => void, opts: { disabled?: boolean } = {}): HTMLButtonElement {
  return h("button", { class: "btn btn-sm deep-open", type: "button", dataset: { fk }, title, disabled: opts.disabled, onClick: run }, icon("expand", 14), keepNum(text));
}

/** 見取り図で見るボタン（上限を超える区切り） */
export function mapBtn(fk: string, text: string, title: string, run: () => void): HTMLButtonElement {
  return h("button", { class: "btn btn-sm deep-open is-map", type: "button", dataset: { fk }, title, onClick: run }, icon("layers", 14), keepNum(text));
}

/** カードの名前（お知らせの「〜から」） */
export function cardName(app: AppContext, ctx: DeepCtx, i: number): string {
  if (i === 0) return "今日";
  const n = app.store.doc.nodes[ctx.idOf(i)];
  return `「${(n?.title ?? "").trim() || "（無題）"}」`;
}

// ------------------------------------------------------------ A: 選んだカードの先を段数で

/** A の行（「どこまで開くか」と段数のボタン。上限を超える最初の段数は「見取り図で見る」）。先の無いカードは null */
export function depthRows(app: AppContext, ctx: DeepCtx, i: number, mapLink: () => void, split = drawnSplit(app, ctx, [i])): HTMLElement[] | null {
  const cm = ctx.cm;
  const ds = deepDepths(cm, i);
  if (!ds.length) return null;
  const id = ctx.idOf(i);
  const { drawn, inside } = split;
  const outside = drawn - inside;
  const row = h("div", { class: "deep-open-row deep-open-depth" });
  let over: DeepHorizon | null = null;
  for (const x of ds) {
    const total = outside + x.count;
    if (total > DEEP_OPEN_CAP) {
      over ??= x;
      continue;
    }
    const label = depthLabel(ctx, x);
    const ask = needsAsk(total, drawn, x.rows);
    row.append(
      openBtn(`open:${x.months}:${id}`, `${label}（${num(x.count)} 枚）`, `この先の${label}の判断と手を開く（開いた後のキャンバス ${num(total)} 枚${ask ? "。開く前に確かめます" : ""}）`, () => {
        const plan = shapePlan(cm, [{ i, lim: x.toEnd ? Infinity : x.limit }], openIdx(app, ctx));
        void runBulk(app, ctx, { from: cardName(app, ctx, i), what: label, open: plan.open, close: plan.close, head: i, count: plan.count, rows: plan.rows, total: outside + plan.count, drawn, back: "この先をまとめてたたむ", mapLink });
      }),
    );
  }
  if (over) {
    const label = depthLabel(ctx, over);
    row.append(mapBtn(`open-map:${id}`, `見取り図で見る（${label} ${num(over.count)} 枚）`, `${label}は ${num(over.count)} 枚（キャンバスに出せるのは全体で ${num(DEEP_OPEN_CAP)} 枚まで）`, mapLink));
  }
  return [h("p", { class: "deep-open-note" }, "どこまで開くか"), row];
}

// ------------------------------------------------------------ B: 見込みの高い道だけ

/** B の行（「5 本（見込み 24%・150 枚）」「10 本（36%・261 枚）」）。行き先の無いカードは null */
export function likelyRows(app: AppContext, ctx: DeepCtx, i: number, mapLink: () => void, split?: { drawn: number; inside: number }): HTMLElement[] | null {
  const cm = ctx.cm;
  const a = ctx.analysis();
  const p5 = likelyPaths(a, i, 5);
  if (!p5.n || !p5.open.length) return null;
  const p10 = likelyPaths(a, i, 10);
  const opts = p10.n > p5.n ? [p5, p10] : [p5];
  const id = ctx.idOf(i);
  const { drawn, inside } = split ?? drawnSplit(app, ctx, [i]);
  const outside = drawn - inside;
  // 今開いている物（このカードの先の分）
  const mark = new Uint8Array(cm.size[i]!);
  for (const j of openIdx(app, ctx)) if (j >= i && j < i + mark.length) mark[j - i] = 1;
  const row = h("div", { class: "deep-open-row deep-open-likely" });
  // 5 本・10 本の開いた後の数は 1 回なめて（今日なら 8 万枚）
  const counts = visibleUnderEach(cm, i, mark, opts.map((p) => new Set(p.open)));
  opts.forEach((p, k) => {
    const vis = counts[k]!;
    const total = outside + vis.count;
    const pct = Math.max(1, Math.round(p.mass * 100));
    const text = k === 0 ? `${p.n} 本（見込み ${pct}%・${num(vis.count)} 枚）` : `${p.n} 本（${pct}%・${num(vis.count)} 枚）`;
    const over = total > DEEP_OPEN_CAP;
    row.append(
      openBtn(
        `likely:${p.n}:${id}`,
        text,
        over ? `開いた後のキャンバスが ${num(total)} 枚（キャンバスに出せるのは全体で ${num(DEEP_OPEN_CAP)} 枚まで）` : `見込みの高い道 ${p.n} 本（合わせて見込み ${pct}%）の上のカードを開く（開いた後のキャンバス ${num(total)} 枚）`,
        () => void runBulk(app, ctx, { from: cardName(app, ctx, i), what: `見込みの高い道 ${p.n} 本`, paths: true, open: p.open, close: [], head: i, count: vis.count, rows: vis.rows, total, drawn, back: i === 0 ? "最初の形に戻す" : "この先をまとめてたたむ", mapLink }),
        { disabled: over },
      ),
    );
  });
  let note = "見込みの高い道だけ（判断はおすすめの手で。これにした手があればその手で）";
  if (i === 0) {
    const f = a.pi.pi[0] ?? -1;
    const name = f >= 0 ? ctx.text().title(f).trim() || "（無題）" : "";
    if (name) note = `見込みの高い道だけ（今日は『${name}』で進んだとき）`;
  }
  return [h("p", { class: "deep-open-note" }, note), row];
}

// ------------------------------------------------------------ D: 同じ時期のカードを全部（今日から）

/** 選んでいた時期（作り直しても同じ物を選んだまま。このタブの間） */
let quarterChoice: number | null = null;

/** D の行（「この時期まで全部ひらく」・時期を選ぶ・「開く（N 枚）」・見取り図で見る） */
export function quarterRows(app: AppContext, ctx: DeepCtx, mapLink: () => void, split = drawnSplit(app, ctx, [0])): HTMLElement[] | null {
  const cm = ctx.cm;
  const qs = quarterOpens(cm);
  if (!qs.length) return null;
  const { drawn, inside } = split;
  const outside = drawn - inside;
  const fits = (k: number) => outside + qs[k]!.count <= DEEP_OPEN_CAP;
  const sel = h("select", { class: "input input-sm deep-quarter", dataset: { fk: "quarter" }, attrs: { "aria-label": "開く時期" } });
  let def = -1;
  qs.forEach((q, k) => {
    const when = `${ym(ctx.map, q.months)}まで`;
    const ok = fits(k);
    const o = h("option", { value: String(q.months), disabled: !ok }, keepNum(ok ? `${when}（${relLabel(q.months)}・${num(q.count)} 枚）` : `${when}（${num(q.count)} 枚・多すぎて開けません）`));
    sel.append(o);
    if (ok && (q.months <= 12 || def < 0)) def = k;
  });
  if (def < 0) {
    // どの時期もキャンバス全体で 3,000 枚を超える（ほかのカードがもう多く見えている）: 訳と見取り図
    const q = qs[0]!;
    return [
      h("p", { class: "deep-open-note" }, "この時期まで全部ひらく（今日から）"),
      h(
        "div",
        { class: "deep-open-row deep-open-quarter" },
        h("p", { class: "deep-open-note" }, keepNum(`キャンバスにほかのカードが ${num(outside)} 枚見えているため、今日から開くと全体で ${num(DEEP_OPEN_CAP)} 枚を超えます（${ym(ctx.map, q.months)}までで ${num(outside + q.count)} 枚）`)),
        mapBtn(`open-map:${ctx.root}`, "見取り図で見る", `キャンバスに出せるのは全体で ${num(DEEP_OPEN_CAP)} 枚まで`, mapLink),
      ),
    ];
  }
  const chosen = qs.findIndex((q, k) => q.months === quarterChoice && fits(k));
  sel.selectedIndex = chosen >= 0 ? chosen : def;
  const go = h("button", { class: "btn btn-sm btn-primary deep-open deep-quarter-go", type: "button", dataset: { fk: "quarter-open" } });
  const sync = () => {
    const q = qs[sel.selectedIndex]!;
    const total = outside + q.count;
    clear(go);
    go.append(icon("expand", 14), keepNum(`開く（${num(q.count)} 枚）`));
    go.title = `今日から ${ym(ctx.map, q.months)}までの判断と手を開く（開いた後のキャンバス ${num(total)} 枚${needsAsk(total, drawn, q.rows) ? "。開く前に確かめます" : ""}）`;
  };
  sync();
  sel.addEventListener("change", () => {
    quarterChoice = qs[sel.selectedIndex]!.months;
    sync();
  });
  go.addEventListener("click", () => {
    const q = qs[sel.selectedIndex]!;
    if (!fits(sel.selectedIndex)) return;
    quarterChoice = q.months;
    const plan = shapePlan(cm, [{ i: 0, lim: q.toEnd ? Infinity : q.months }], openIdx(app, ctx));
    void runBulk(app, ctx, { from: "今日", what: `${ym(ctx.map, q.months)}まで`, open: plan.open, close: plan.close, head: 0, count: plan.count, rows: plan.rows, total: outside + plan.count, drawn, back: "最初の形に戻す", mapLink });
  });
  const row = h("div", { class: "deep-open-row deep-open-quarter" }, sel, go);
  const firstOver = qs.findIndex((_, k) => !fits(k));
  if (firstOver >= 0) {
    const q = qs[firstOver]!;
    row.append(mapBtn(`open-map:${ctx.root}`, `見取り図で見る（${ym(ctx.map, q.months)}から先）`, `${ym(ctx.map, q.months)}までは ${num(q.count)} 枚（キャンバスに出せるのは全体で ${num(DEEP_OPEN_CAP)} 枚まで）`, mapLink));
  }
  return [h("p", { class: "deep-open-note" }, "この時期まで全部ひらく（今日から）"), row];
}

// ------------------------------------------------------------ まとめてたたむ・ほかのカードも選ぶ

/** 「この先をまとめてたたむ（今 N 枚）」（このカードの先に見えている物があるときだけ） */
export function foldBtn(app: AppContext, ctx: DeepCtx, i: number, split = drawnSplit(app, ctx, [i])): HTMLElement | null {
  const { inside } = split;
  if (!inside) return null;
  return h(
    "button",
    { class: "btn btn-sm deep-fold", type: "button", dataset: { fk: `fold:${ctx.idOf(i)}` }, title: "このカードと、その先で開いているカードを全部閉じる", onClick: () => runFold(app, ctx, [i], cardName(app, ctx, i), inside) },
    icon("collapse", 14),
    keepNum(`この先をまとめてたたむ（今 ${num(inside)} 枚）`),
  );
}

/** 「ほかのカードも選ぶ」（押すたびに選びに足す・外す。タッチで ⇧ の代わり） */
export function pickToggle(app: AppContext, fk: string): HTMLElement {
  const on = app.ui.multiPick;
  const b = h(
    "button",
    {
      class: "btn btn-sm deep-pick",
      type: "button",
      dataset: { fk, pickToggle: "1" },
      attrs: { "aria-pressed": on ? "true" : "false" },
      title: "キャンバスのカードを押すたびに、選びに足す・外す（終わるときは「終わる」か Esc）",
      onClick: () => {
        const next = !app.ui.multiPick;
        app.ui.setMultiPick(next);
        // 狭い画面: 引き出しを閉じてキャンバスのカードを押せるように
        if (next && isNarrowScreen() && app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: false });
      },
    },
    icon("plus", 14),
    "ほかのカードも選ぶ",
  );
  return b;
}

// ------------------------------------------------------------ C: 複数のカードを一度に（複数選択の詳細）

/** 選んだカードのうち地図のカード（番号）と、地図の外の物の数 */
function mapPicks(app: AppContext, ctx: DeepCtx): { picks: number[]; other: number } {
  const picks: number[] = [];
  let other = 0;
  for (const id of app.ui.selection.nodes) {
    const j = ctx.indexOf(id);
    if (j >= 0) picks.push(j);
    else other++;
  }
  return { picks: picks.sort((a, b) => a - b), other };
}

/** 「選んだ M 枚の先をひらく」（複数選択の詳細の頭。地図のカードが無ければ隠す）。見え方が変わったら作り直す */
export function buildMultiOpen(app: AppContext, mapLinkOf: (ctx: DeepCtx, i: number) => () => void): { el: HTMLElement; update(): void } {
  const el = h("section", { class: "deep-open-sec deep-multi", attrs: { "aria-label": "選んだカードの先をひらく" } });
  let key = "";
  return {
    el,
    update() {
      const ctx = app.vm.deep.get();
      const { picks, other } = ctx ? mapPicks(app, ctx) : { picks: [], other: 0 };
      el.hidden = !ctx || !picks.length;
      if (!ctx || !picks.length) {
        key = "";
        clear(el);
        return;
      }
      app.vm.ensure();
      let open = 0;
      for (const r in app.ui.prefs.impactOpen) open += app.ui.prefs.impactOpen[r]!.length + 1;
      const k = `${ctx.map.header.hash}|${ctx.cm.version.topology}|${app.vm.drawNodes.length}|${open}|${picks.join(",")}|${other}|${app.ui.multiPick}`;
      if (k === key) return;
      key = k;
      keepFocus(el, () => fillMulti(app, ctx, el, picks, other, mapLinkOf));
    },
  };
}

function fillMulti(app: AppContext, ctx: DeepCtx, el: HTMLElement, picks: number[], other: number, mapLinkOf: (ctx: DeepCtx, i: number) => () => void): void {
  clear(el);
  const cm = ctx.cm;
  const H = cm.H;
  const now = openIdx(app, ctx);
  // 覆う先の頭（ほかの選んだカードの先に無い物）
  const tops = topsOf(cm, picks);
  const { drawn, inside } = drawnSplit(app, ctx, tops);
  const outside = drawn - inside;
  const row = h("div", { class: "deep-open-row deep-open-depth" });
  let prev = -1;
  let over: { label: string; count: number } | null = null;
  const from = `選んだ ${picks.length} 枚`;
  for (const d of DEPTH_STEPS) {
    const toEnd = d >= H;
    const pk: ShapePick[] = picks.map((i) => ({ i, lim: cm.month[i]! + d >= H ? Infinity : cm.month[i]! + d }));
    const plan = shapePlan(cm, pk, now);
    if (!plan.count || plan.count === prev) continue;
    prev = plan.count;
    const label = depthLabel(ctx, { months: d, toEnd });
    const total = outside + plan.count;
    if (total > DEEP_OPEN_CAP) {
      over ??= { label, count: plan.count };
      continue;
    }
    const ask = needsAsk(total, drawn, plan.rows);
    row.append(
      openBtn(`multi-open:${d}`, `${label}（${num(plan.count)} 枚）`, `選んだカードの先の${label}の判断と手を開く（開いた後のキャンバス ${num(total)} 枚${ask ? "。開く前に確かめます" : ""}）`, () => {
        const p = shapePlan(cm, pk, openIdx(app, ctx));
        void runBulk(app, ctx, { from, what: label, open: p.open, close: p.close, head: tops[0]!, count: p.count, rows: p.rows, total: outside + p.count, drawn, back: "まとめてたたむ", mapLink: null });
      }),
    );
  }
  if (over) row.append(mapBtn("multi-map", `見取り図で見る（${over.label} ${num(over.count)} 枚）`, `${over.label}は ${num(over.count)} 枚（キャンバスに出せるのは全体で ${num(DEEP_OPEN_CAP)} 枚まで）`, mapLinkOf(ctx, tops[0]!)));
  const tools = h("div", { class: "deep-open-row deep-open-tools" });
  if (inside) {
    tools.append(
      h(
        "button",
        { class: "btn btn-sm deep-fold", type: "button", dataset: { fk: "multi-fold" }, title: "選んだカードと、その先で開いているカードを全部閉じる", onClick: () => runFold(app, ctx, tops, from, inside) },
        icon("collapse", 14),
        keepNum(`まとめてたたむ（今 ${num(inside)} 枚）`),
      ),
    );
  }
  tools.append(pickToggle(app, "multi-pick"));
  const head = h("h3", { class: "insp-label" }, `選んだ ${picks.length} 枚の先をひらく`, h("span", { class: "insp-count" }, `キャンバスは全体で ${num(DEEP_OPEN_CAP)} 枚まで`));
  el.append(head);
  if (other) el.append(h("p", { class: "deep-open-note" }, `地図のカードだけを開きます（ほかの ${other} 件はそのまま）`));
  if (row.childElementCount) el.append(h("p", { class: "deep-open-note" }, "どこまで開くか（重なるときは深い方まで）"), row);
  else el.append(h("p", { class: "deep-open-note" }, "選んだカードの先に、開ける判断と手がありません"));
  el.append(tools);
}

/**
 * 中身を作り直しても、キーボードで操作していた部品（data-fk の鍵）にフォーカスを戻す（無くなっていたら同じ欄の最初の部品へ）。
 * フォーカスが中に無ければ何もしない
 */
export function keepFocus(el: HTMLElement, rebuild: () => void): void {
  const a = document.activeElement;
  const fk = a instanceof HTMLElement && el.contains(a) ? (a.dataset.fk ?? "") : null;
  rebuild();
  if (fk === null) return;
  const t = (fk ? el.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]:not(:disabled)`) : null) ?? el.querySelector<HTMLElement>("button:not(:disabled), select:not(:disabled)");
  t?.focus({ preventScroll: true });
}
