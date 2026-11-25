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
import { BULK_ASK_CARDS, DEEP_OPEN_CAP, DEEP_OPEN_ROWS, deepDepths, deepHorizons, foldPlan, insideTops, likelyPaths, quarterOpens, shapeDepths, shapePlan, shapeRule, topsOf, visibleUnderEach, type DeepHorizon, type ShapePick } from "../model/deepOpen";
import type { ID } from "../model/types";
import { isNarrowScreen } from "./breakpoints";
import { clear, h, MOD } from "./dom";
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

/** 書き換えた地図での drawnSplit（見える物が同じ間） */
const liveSplitMemo = new WeakMap<DeepCtx, { vm: object; gen: number; byKey: Map<string, { drawn: number; inside: number }> }>();

/** 見えるノードの集まりごとに覚えた、見えている地図のカードの番号（小さい順） */
const drawnMemo = new WeakMap<DeepCtx, { gen: number; vm: object; sorted: Int32Array; drawn: number }>();

/**
 * 今見えているカードの数と、そのうち覆う先（tops: 番号の順）の中の物の数（頭は含まない）。見えている地図のカードの番号は、見える物が
 * 変わったときだけ並べ直す（選ぶたびに 2,600 枚をなめない: 作業メモ bulk §5）。数えるのは覆う先ごとに 2 分探し
 */
export function drawnSplit(app: AppContext, ctx: DeepCtx, tops: readonly number[]): { drawn: number; inside: number } {
  const vm = app.vm;
  vm.ensure();
  // 書き換えた地図（自分のカードを足した・地図のカードを消した）: 見え方の範囲の線でたどって数える（地図の番号には自分のカードが無い）
  if (ctx.edited) {
    // 見える物が同じ間は覚えた物（今日の欄は手ごとに 10 回呼ぶ）
    const k = `${vm.visibleGen}|${topsOf(ctx.cm, tops).join(",")}`;
    let memo = liveSplitMemo.get(ctx);
    if (!memo || memo.vm !== vm || memo.gen !== vm.visibleGen) liveSplitMemo.set(ctx, (memo = { vm, gen: vm.visibleGen, byKey: new Map() }));
    const hit = memo.byKey.get(k);
    if (hit) return hit;
    const cur = vm.impactOpenSet(ctx.root);
    const heads = topsOf(ctx.cm, tops).filter((t) => isDrawn(app, ctx, t));
    const out = { drawn: vm.drawNodes.length, inside: vm.countImpactUnder(heads.map((t) => ctx.idOf(t)), (id) => cur.has(id)).count };
    memo.byKey.set(k, out);
    return out;
  }
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

/** カードが今キャンバスに見えているか（閉じた上のカードの中に隠れていない。隠れたカードから開いても何も見えない: 見直し data-hidden-head-false-toast） */
export function isDrawn(app: AppContext, ctx: DeepCtx, i: number): boolean {
  return !app.vm.node(ctx.idOf(i)).hidden;
}

/**
 * 書き換えた地図（ctx.edited）での、開いた後の数。tops の先を、地図のカード j は want(j)・自分のカード（地図の番号が無い）は今の
 * 開閉のままで開いたとして、見え方の範囲の線でたどる（足したカード・消したカードも数に入る: 見直し data-counts-ignore-user-edits）。
 * 数が stop を超えたらそこでやめる
 */
export function liveCount(app: AppContext, ctx: DeepCtx, tops: readonly number[], want: (j: number) => boolean, stop = Infinity): { count: number; rows: number } {
  const cur = app.vm.impactOpenSet(ctx.root);
  const cm = ctx.cm;
  const ts = topsOf(cm, tops);
  return app.vm.countImpactUnder(
    ts.map((t) => ctx.idOf(t)),
    (id) => {
      const j = ctx.indexOf(id);
      if (j < 0) return cur.has(id);
      return ts.includes(j) || insideTops(cm, ts, j) ? want(j) : cur.has(id);
    },
    stop,
  );
}

/**
 * 書き換えた地図での shapeCount の答え（地図の番号の表 ctx.ids ごと）。数は見え方の範囲の線（文書の索引の形と道の線の版）・開いている物
 * （impactOpenSet の入れ物）・地図と番号の表だけで決まり、選んだ手・見送った手・年収・方針には依らない。「これにする」「見送る」で
 * 画面に渡す物が作り直され、詳細の「この先をひらく」を詰め直すたびに、そのカードの先の数千枚をなめ直さない（スマホで +80 ms だった）
 */
const shapeMemo = new WeakMap<readonly ID[], { vm: object; topo: number; flow: number; cur: ReadonlySet<ID>; cm: DeepCtx["cm"]; root: ID; byKey: Map<string, { count: number; rows: number }> }>();

/** 覆う先を「ちょうどその段数まで」にしたときの数（書き換えた地図ではたどって数える。そうでなければ地図の番号で数えた物 base） */
export function shapeCount(app: AppContext, ctx: DeepCtx, picks: readonly ShapePick[], base: { count: number; rows: number }, stop = Infinity): { count: number; rows: number } {
  if (!ctx.edited) return base;
  const vm = app.vm;
  const v = vm.index.version;
  const cur = vm.impactOpenSet(ctx.root);
  let m = shapeMemo.get(ctx.ids);
  if (!m || m.vm !== vm || m.topo !== v.topo || m.flow !== v.flow || m.cur !== cur || m.cm !== ctx.cm || m.root !== ctx.root) {
    shapeMemo.set(ctx.ids, (m = { vm, topo: v.topo, flow: v.flow, cur, cm: ctx.cm, root: ctx.root, byKey: new Map() }));
  }
  const key = `${picks.map((p) => `${p.i}:${p.lim}`).join(",")}|${stop}`;
  const hit = m.byKey.get(key);
  if (hit) return hit;
  const rule = shapeRule(ctx.cm, picks);
  const out = liveCount(app, ctx, rule.tops, rule.want, stop);
  if (m.byKey.size >= 256) m.byKey.clear();
  m.byKey.set(key, out);
  return out;
}

/** まとめて開く・たたむの最後のお知らせを閉じる関数（新しく開く・たたむ・⌘Z で戻したら、古い「元に戻す」を残さない: 見直し reader-7） */
let lastToast: (() => void) | null = null;

function bulkToast(text: string, opts: Parameters<typeof toast>[1]): void {
  lastToast?.();
  lastToast = toast(text, opts);
}

/** ⌘Z・上部の「元に戻す」でまとめて開く・たたむを戻した（App の Commands から） */
export function bulkUndone(): void {
  bulkToast("開く前の形に戻した", { ms: 2400 });
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
  /** 開く前に見えている、覆う先のカードの数（増える数 = count − inside） */
  inside: number;
  /** 覆う先の頭（無ければ head だけ。どれかが隠れていれば開かない） */
  tops?: readonly number[];
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
  if (app.vm.restoreOpen(snap)) bulkToast("開く前の形に戻した", { ms: 2400 });
  else toast("そのあとに開く・たたむをしたため、ここからは戻せません（「この先をまとめてたたむ」か「最初の形に戻す」で戻せます）", { tone: "warn", ms: 8000 });
}

/** まとめて開く（大きければページの中で聞いてから。1 回の setImpactOpen・お知らせに「元に戻す」） */
export async function runBulk(app: AppContext, ctx: DeepCtx, r: BulkRun): Promise<boolean> {
  const what = `${/^\d/.test(r.what) ? " " : ""}${r.what}`;
  // 頭が閉じた上のカードの中に隠れていれば、開いてもキャンバスには何も増えない（数を言って開いたことにしない）
  const hidden = (r.tops ?? [r.head]).filter((t) => !isDrawn(app, ctx, t));
  if (hidden.length) {
    hiddenToast(app, ctx.map, hidden);
    return false;
  }
  const added = r.count - r.inside;
  if (needsAsk(r.total, r.drawn, r.rows)) {
    const shape = r.rows > DEEP_OPEN_ROWS ? `キャンバスは縦に約 ${num(r.rows)} 行になり、引いて見ることになります。` : `キャンバスのカードは全体で ${num(r.total)} 枚になります。`;
    const ok = await confirmDialog({
      title: r.paths ? `${num(added)} 枚を開きます` : `${num(r.count)} 枚を開きます`,
      body: `${r.from}から${what}${r.paths ? "の上のカードを開きます。" : "の判断と手をすべて開きます。"}${shape}開いた後は、${MOD}Z かお知らせの「元に戻す」、「${r.back}」で戻せます。`,
      ok: "開く",
      cancel: "やめる",
    });
    if (!ok) return false;
  }
  const ids: ID[] = [];
  if (r.open.includes(r.head)) ids.push(ctx.idOf(r.head));
  for (const j of r.open) if (j !== r.head) ids.push(ctx.idOf(j));
  // 右のパネルの合わせ直しは、開いた所を描いた後に（1 つの長い仕事にしない）
  app.ui.panelAfterPaint = true;
  const snap = app.vm.bulkOpen(
    ids,
    r.close.map((j) => ctx.idOf(j)),
    { reveal: true },
  );
  if (app.ui.prefs.view !== "map") app.ui.setPrefs({ view: "map" });
  if (isNarrowScreen() && app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: false });
  // ほかのカードも選ぶは、開いたら終える（次に押したカードを選びに足さない: 見直し reader-6）
  if (app.ui.multiPick) app.ui.setMultiPick(false);
  if (!snap) {
    toast(keepNum(`もう開いています（${num(r.count)} 枚）`), { ms: 2400 });
    return true;
  }
  openedToast(app, ctx.map, r, what, added, snap);
  return true;
}

/**
 * お知らせの押す所（ここから下の 2 つ）は画面に渡す物を持たない: 押したときの物を引く（runBulk の中で作ると、その関数の中の物と
 * 一緒に、開いたときの画面に渡す物と計算（1 つ 8 MB ほど）をお知らせが閉じた後も持ち続けた: 最後のお知らせは次まで残る）。
 * 地図の番号は同じ地図なら同じカード
 */
function currentCtx(app: AppContext, map: DeepCtx["map"]): DeepCtx | null {
  const c = app.vm.deep.get();
  return c && c.map === map ? c : null;
}

/** 隠れているカードを開こうとしたときのお知らせ（「キャンバスに出す」） */
function hiddenToast(app: AppContext, map: DeepCtx["map"], hidden: readonly number[]): void {
  const show = (): void => {
    const c = currentCtx(app, map);
    if (c) showOnCanvas(app, c, hidden);
  };
  toast("このカードは今キャンバスで隠れています（上のカードが閉じています）。「キャンバスに出す」で出してから開いてください", { tone: "warn", ms: 6000, action: { label: "キャンバスに出す", run: show } });
}

/** 開いた後のお知らせ（何を開いたか・元に戻す・見取り図で見る／選んだカードを見る） */
function openedToast(app: AppContext, map: DeepCtx["map"], r: BulkRun, what: string, added: number, snap: OpenSnapshot): void {
  const n = r.paths ? `${num(Math.max(0, added))} 枚増えた` : `${num(r.count)} 枚`;
  // 離れたいくつものカードから開いたときは、選んだ所を全部見る道を添える（F は選んだカードを画面に収める: 見直し reader-1）
  // スマホ（キーが無い）では F と言わず、押せる「選んだカードを見る」にする（見取り図で見るがあれば、そちらを残して文を外す: 見直し reader-6）
  const tops = r.tops ?? [r.head];
  const multi = tops.length > 1;
  const touch = isNarrowScreen();
  const far = multi && !touch ? "。F で選んだカードを画面に収めます" : "";
  const fitTops = (): void => {
    const c = currentCtx(app, map);
    if (!c) return;
    const ids = tops.filter((t) => isDrawn(app, c, t)).map((t) => c.idOf(t));
    if (ids.length) app.view.fit(ids);
  };
  const mapLink = r.mapLink;
  bulkToast(`${r.from}から${keepNum(what)}${r.paths ? "" : "の判断と手"}を開いた（${keepNum(n)}）${far}`, {
    tone: "ok",
    ms: 8000,
    action: { label: "元に戻す", run: () => undoOpen(app, snap) },
    // 見取り図で見るを押しても、お知らせの「元に戻す」は残す（見直し data-undo-toast-only）
    action2: mapLink ? { label: "見取り図で見る", run: mapLink, keep: true } : multi && touch ? { label: "選んだカードを見る", run: fitTops, keep: true } : undefined,
  });
}

/** 隠れているカードをキャンバスに出す（上の閉じたカードを開く。見え方だけ・1 回の setImpactOpen） */
export function showOnCanvas(app: AppContext, ctx: DeepCtx, idx: readonly number[]): void {
  const open = new Set<ID>();
  for (const i of idx) for (const id of app.vm.collapseBlockers(ctx.idOf(i)).open) open.add(id);
  if (open.size) app.vm.setImpactOpen(open);
  const first = idx[0];
  if (first !== undefined && app.ui.prefs.view === "map") app.view.centerOn(ctx.idOf(first), { onlyIfHidden: true });
}

/** まとめてたたむ（頭のカードを閉じ、その先で開いている物を全部閉じる。1 回の setImpactOpen） */
export function runFold(app: AppContext, ctx: DeepCtx, tops: readonly number[], from: string, n: number): void {
  const close = foldPlan(ctx.cm, tops, openIdx(app, ctx)).map((j) => ctx.idOf(j));
  // 覆う先の中の自分のカード（地図の番号が無い）で開いている物も閉じる（後で開き直したときに、隠れていた先がまとめて出てこない）
  close.push(...userOpensInside(app, ctx, tops));
  const snap = app.vm.bulkOpen([], close);
  if (!snap) return;
  bulkToast(keepNum(`${from}の先をたたんだ（${num(n)} 枚）`), { tone: "ok", ms: 8000, action: { label: "元に戻す", run: () => undoOpen(app, snap) } });
}

/** 覆う先（tops の先）の中の、自分のカードで開いている物（書き換えた地図だけ。近い上の地図のカードで決める） */
export function userOpensInside(app: AppContext, ctx: DeepCtx, tops: readonly number[]): ID[] {
  if (!ctx.edited) return [];
  const out: ID[] = [];
  const ts = topsOf(ctx.cm, tops);
  for (const id of app.vm.impactOpenSet(ctx.root)) {
    if (ctx.indexOf(id) >= 0) continue;
    const chain = app.vm.impactChain(id);
    for (let k = chain.length - 2; k >= 0; k--) {
      const j = ctx.indexOf(chain[k]!);
      if (j < 0) continue;
      if (ts.includes(j) || insideTops(ctx.cm, ts, j)) out.push(id);
      break;
    }
  }
  return out;
}

/** 今日の欄の「最初の形に戻す」（今日から開いた後に戻す道を、開くボタンの横に。⌘Z・お知らせの「元に戻す」で戻せる: 見直し reader-4） */
export function resetBtn(app: AppContext): HTMLElement {
  return h(
    "button",
    {
      class: "btn btn-sm deep-fold",
      type: "button",
      dataset: { fk: "bulk-reset" },
      title: "開いている所を最初の形に戻す",
      onClick: () => {
        const snap = app.vm.bulkReset();
        if (snap) bulkToast("最初の形に戻した", { tone: "ok", ms: 8000, action: { label: "元に戻す", run: () => undoOpen(app, snap) } });
        else toast("もう最初の形です", { ms: 2400 });
      },
    },
    icon("collapse", 14),
    "最初の形に戻す",
  );
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

// ------------------------------------------------------------ 手ごとに開く（今日の欄）

/** 手ごとに開くの 1 つの手: 開く区切りと、その形の数・押す前の見えている数 */
export interface MoveFit {
  x: DeepHorizon;
  pk: ShapePick[];
  count: number;
  rows: number;
  drawn: number;
  inside: number;
}

/**
 * 今日の手 f の「手ごとに開く」の区切り（一番小さい区切り: 1 年先まで）。手ごとに開くも、その手の先をちょうどその区切りまでの形に
 * する（前に深く開いて C や +N の札で閉じた手でも、隠れていた深い所を一緒に出さない。数 = 開いた後の数で、1,000 枚の確かめ・
 * 3,000 枚の上限もその数で決める: 見直し data-permove-count-cap-bypass）。キャンバスで読める区切り（全体で 3,000 枚まで・縦に 320 行
 * まで: 見直し user-8）でなければ null。今日を閉じていて隠れている手も null
 */
export function moveFit(app: AppContext, ctx: DeepCtx, f: number): MoveFit | null {
  if (!isDrawn(app, ctx, f)) return null;
  const x = deepHorizons(ctx.cm, f)[0];
  if (!x) return null;
  const { drawn, inside } = drawnSplit(app, ctx, [f]);
  const pk: ShapePick[] = [{ i: f, lim: x.toEnd ? Infinity : x.limit }];
  const c = shapeCount(app, ctx, pk, x);
  if (drawn - inside + c.count > DEEP_OPEN_CAP || c.rows > DEEP_OPEN_ROWS) return null;
  return { x, pk, count: c.count, rows: c.rows, drawn, inside };
}

/** 手ごとに開くを押したときの中身（押したときの開いている物で形を作る） */
export function moveRun(app: AppContext, ctx: DeepCtx, f: number, fit: MoveFit, what: string, mapLink: (() => void) | null): BulkRun {
  const plan = shapePlan(ctx.cm, fit.pk, openIdx(app, ctx));
  const n = shapeCount(app, ctx, fit.pk, plan);
  return { from: cardName(app, ctx, f), what, open: plan.open, close: plan.close, head: f, count: n.count, inside: fit.inside, rows: n.rows, total: fit.drawn - fit.inside + n.count, drawn: fit.drawn, back: "この先をまとめてたたむ", mapLink };
}

// ------------------------------------------------------------ A: 選んだカードの先を段数で

/** 隠れているカードの欄（開くボタンの代わりに、訳と「キャンバスに出す」: 見直し data-hidden-head-false-toast） */
export function hiddenRows(app: AppContext, ctx: DeepCtx, idx: readonly number[], fk: string): HTMLElement[] {
  const text = idx.length > 1 ? `選んだうち ${idx.length} 枚は、今キャンバスで隠れています（上のカードが閉じています）。出してから開けます` : "このカードは今キャンバスで隠れています（上のカードが閉じています）。出してから開けます";
  return [
    h("p", { class: "deep-open-note" }, keepNum(text)),
    h(
      "div",
      { class: "deep-open-row" },
      h("button", { class: "btn btn-sm deep-open", type: "button", dataset: { fk, bulkFirst: "1" }, title: "上の閉じたカードを開いて、キャンバスに出す", onClick: () => showOnCanvas(app, ctx, idx) }, icon("eye", 14), "キャンバスに出す"),
    ),
  ];
}

/** A の行（「どこまで開くか」と段数のボタン。上限を超える最初の段数は「見取り図で見る」）。先の無いカードは null */
export function depthRows(app: AppContext, ctx: DeepCtx, i: number, mapLink: () => void, split = drawnSplit(app, ctx, [i])): HTMLElement[] | null {
  const cm = ctx.cm;
  const ds = deepDepths(cm, i);
  if (!ds.length) return null;
  const id = ctx.idOf(i);
  const { drawn, inside } = split;
  const outside = drawn - inside;
  const row = h("div", { class: "deep-open-row deep-open-depth" });
  let over: { label: string; count: number } | null = null;
  for (const x of ds) {
    if (over) break;
    const label = depthLabel(ctx, x);
    const pk: ShapePick[] = [{ i, lim: x.toEnd ? Infinity : x.limit }];
    // 開いた後のこのカードの先の数（ちょうどその段数の形。書き換えた地図ではたどって数える）
    const c = shapeCount(app, ctx, pk, x);
    const total = outside + c.count;
    if (total > DEEP_OPEN_CAP) {
      over = { label, count: c.count };
      break;
    }
    const ask = needsAsk(total, drawn, c.rows);
    const b = openBtn(`open:${x.months}:${id}`, `${label}（${num(c.count)} 枚）`, `${label}の判断と手を開く（開いた後のキャンバス ${num(total)} 枚${ask ? "。開く前に確かめます" : ""}）`, () => {
      const plan = shapePlan(cm, pk, openIdx(app, ctx));
      const n = shapeCount(app, ctx, pk, plan);
      void runBulk(app, ctx, { from: cardName(app, ctx, i), what: label, open: plan.open, close: plan.close, head: i, count: n.count, inside, rows: n.rows, total: outside + n.count, drawn, back: "この先をまとめてたたむ", mapLink });
    });
    if (!row.childElementCount) b.dataset.bulkFirst = "1";
    row.append(b);
  }
  if (over) row.append(mapBtn(`open-map:${id}`, `見取り図で見る（${over.label} ${num(over.count)} 枚）`, `${over.label}は ${num(over.count)} 枚（キャンバスに出せるのは全体で ${num(DEEP_OPEN_CAP)} 枚まで）`, mapLink));
  // 今この先に見えている数（ボタンの数は開いた後の数: どれが今の形に近いかを比べられるように。見直し reader-5）
  const note = inside ? `どこまで開くか（今この先に ${num(inside)} 枚見えています）` : "どこまで開くか";
  return [h("p", { class: "deep-open-note" }, keepNum(note)), row];
}

// ------------------------------------------------------------ B: 見込みの高い道だけ

/** B の行（「5 本（見込み 24%・150 枚増える）」「10 本（36%・261 枚増える）」）。行き先の無いカードは null */
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
  const row = h("div", { class: "deep-open-row deep-open-likely" });
  let counts: Array<{ count: number; rows: number }>;
  if (ctx.edited) {
    // 書き換えた地図: 今開いている物に道を足した形を、見え方の範囲の線でたどって数える
    const cur = app.vm.impactOpenSet(ctx.root);
    counts = opts.map((p) => {
      const add = new Set(p.open);
      return liveCount(app, ctx, [i], (j) => add.has(j) || cur.has(ctx.idOf(j)));
    });
  } else {
    // 今開いている物（このカードの先の分）
    const mark = new Uint8Array(cm.size[i]!);
    for (const j of openIdx(app, ctx)) if (j >= i && j < i + mark.length) mark[j - i] = 1;
    // 5 本・10 本の開いた後の数は 1 回なめて（今日なら 8 万枚）
    counts = visibleUnderEach(cm, i, mark, opts.map((p) => new Set(p.open)));
  }
  opts.forEach((p, k) => {
    const vis = counts[k]!;
    const total = outside + vis.count;
    const added = Math.max(0, vis.count - inside);
    const pct = Math.max(1, Math.round(p.mass * 100));
    // 数は増える枚数（今開いている物に道を足す。開いた後の数だと、ほかで開いた分まで道が大きく見える: 見直し reader-5）
    const more = added ? `${num(added)} 枚増える` : "もう開いています";
    const text = k === 0 ? `${p.n} 本（見込み ${pct}%・${more}）` : `${p.n} 本（${pct}%・${more}）`;
    const over = total > DEEP_OPEN_CAP;
    row.append(
      openBtn(
        `likely:${p.n}:${id}`,
        text,
        (over ? `開いた後のキャンバスが ${num(total)} 枚（キャンバスに出せるのは全体で ${num(DEEP_OPEN_CAP)} 枚まで）` : `見込みの高い ${p.n} 本の道（この先へ進む見込みの合わせて ${pct}%）の上のカードを開く（開いた後のキャンバス ${num(total)} 枚）`),
        () => void runBulk(app, ctx, { from: cardName(app, ctx, i), what: `見込みの高い ${p.n} 本の道`, paths: true, open: p.open, close: [], head: i, count: vis.count, inside, rows: vis.rows, total, drawn, back: i === 0 ? "最初の形に戻す" : "この先をまとめてたたむ", mapLink }),
        { disabled: over },
      ),
    );
  });
  let note = "見込みの高い道だけ開く（分かれ道では、これにした手か、おすすめの手へ進む。% はその道へ進む見込みの合計）";
  if (i === 0) {
    const f = a.pi.pi[0] ?? -1;
    const name = f >= 0 ? ctx.text().title(f).trim() || "（無題）" : "";
    if (name) note = `見込みの高い道だけ開く（今日は『${name}』で進んだとき。% はその道へ進む見込みの合計）`;
  }
  return [h("p", { class: "deep-open-note" }, note), row];
}

// ------------------------------------------------------------ D: 同じ時期のカードを全部（今日から）

/** 選んでいた時期（作り直しても同じ物を選んだまま。このタブの間） */
let quarterChoice: number | null = null;

/** D の行（「この時期まで全部ひらく」・時期を選ぶ・「開く（N 枚）」・見取り図で見る・最初の形に戻す） */
export function quarterRows(app: AppContext, ctx: DeepCtx, mapLink: () => void, split = drawnSplit(app, ctx, [0])): HTMLElement[] | null {
  const cm = ctx.cm;
  const qs0 = quarterOpens(cm);
  if (!qs0.length) return null;
  const { drawn, inside } = split;
  const outside = drawn - inside;
  const pickOf = (q: { months: number; toEnd: boolean }): ShapePick[] => [{ i: 0, lim: q.toEnd ? Infinity : q.months }];
  // 時期ごとの開いた後の数（書き換えた地図ではたどって数える。上限を超えた先は、それより大きいので数えない）
  let overAt = -1;
  const qs = qs0.map((q, k) => {
    if (overAt >= 0) return { ...q, fit: false };
    // 上限を超えるかが分かったら数えるのをやめる（超えた時期は地図の数のまま出す: 開けないので）
    const c = shapeCount(app, ctx, pickOf(q), q, DEEP_OPEN_CAP - outside);
    const fit = outside + c.count <= DEEP_OPEN_CAP;
    if (!fit) overAt = k;
    return fit ? { ...q, count: c.count, rows: c.rows, fit } : { ...q, fit };
  });
  const fits = (k: number) => qs[k]!.fit;
  const sel = h("select", { class: "input input-sm deep-quarter", dataset: { fk: "quarter", bulkFirst: "1" }, attrs: { "aria-label": "開く時期" } });
  let def = -1;
  qs.forEach((q, k) => {
    const when = `${ym(ctx.map, q.months)}まで`;
    const ok = fits(k);
    const o = h("option", { value: String(q.months), disabled: !ok }, keepNum(ok ? `${when}（${relLabel(q.months)}・${num(q.count)} 枚）` : `${when}（${num(q.count)} 枚・多すぎて開けません）`));
    sel.append(o);
    if (ok && (q.months <= 12 || def < 0)) def = k;
  });
  const reset = h("div", { class: "deep-open-row deep-open-tools" }, resetBtn(app));
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
      reset,
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
    const pk = pickOf(q);
    const plan = shapePlan(cm, pk, openIdx(app, ctx));
    const n = shapeCount(app, ctx, pk, plan);
    void runBulk(app, ctx, { from: "今日", what: `${ym(ctx.map, q.months)}まで`, open: plan.open, close: plan.close, head: 0, count: n.count, inside, rows: n.rows, total: outside + n.count, drawn, back: "最初の形に戻す", mapLink });
  });
  const row = h("div", { class: "deep-open-row deep-open-quarter" }, sel, go);
  if (overAt >= 0) {
    const q = qs[overAt]!;
    row.append(mapBtn(`open-map:${ctx.root}`, `見取り図で見る（${ym(ctx.map, q.months)}から先）`, `${ym(ctx.map, q.months)}までは ${num(q.count)} 枚（キャンバスに出せるのは全体で ${num(DEEP_OPEN_CAP)} 枚まで）`, mapLink));
  }
  // 今日から開いた後に戻す道を、開くボタンのすぐ下に（パネルの下の方の「最初の形に戻す」まで探させない: 見直し reader-4）
  return [h("p", { class: "deep-open-note" }, "この時期まで全部ひらく（今日から）"), row, reset];
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

function fillMulti(app: AppContext, ctx: DeepCtx, el: HTMLElement, all: number[], other: number, mapLinkOf: (ctx: DeepCtx, i: number) => () => void): void {
  clear(el);
  const cm = ctx.cm;
  const H = cm.H;
  // 今キャンバスで隠れているカード（閉じた上のカードの中）は、開いても何も見えないので外し、出す道を出す
  const hidden = all.filter((i) => !isDrawn(app, ctx, i));
  const picks = hidden.length ? all.filter((i) => !hidden.includes(i)) : all;
  // 覆う先の頭（ほかの選んだカードの先に無い物）
  const tops = topsOf(cm, picks);
  const { drawn, inside } = picks.length ? drawnSplit(app, ctx, tops) : { drawn: 0, inside: 0 };
  const outside = drawn - inside;
  const row = h("div", { class: "deep-open-row deep-open-depth" });
  let prev = -1;
  let over: { label: string; count: number } | null = null;
  const from = `選んだ ${picks.length} 枚`;
  // 段数ごとの数は 1 回なめて数える（選ぶたびに作るので、段数ごとに shapePlan を回さない: 見直し speed-multiselect-regression）
  const ds = picks.length ? shapeDepths(cm, picks) : [];
  for (const x of ds) {
    if (over) break;
    const d = x.months;
    const pk: ShapePick[] = picks.map((i) => ({ i, lim: cm.month[i]! + d >= H ? Infinity : cm.month[i]! + d }));
    const c = shapeCount(app, ctx, pk, x);
    if (!c.count || c.count === prev) continue;
    prev = c.count;
    const label = depthLabel(ctx, { months: d, toEnd: x.toEnd });
    const total = outside + c.count;
    if (total > DEEP_OPEN_CAP) {
      over = { label, count: c.count };
      break;
    }
    const ask = needsAsk(total, drawn, c.rows);
    const b = openBtn(`multi-open:${d}`, `${label}（${num(c.count)} 枚）`, `選んだカードの先の、${label}の判断と手を開く（開いた後のキャンバス ${num(total)} 枚${ask ? "。開く前に確かめます" : ""}）`, () => {
      const p = shapePlan(cm, pk, openIdx(app, ctx));
      const n = shapeCount(app, ctx, pk, p);
      void runBulk(app, ctx, { from, what: label, open: p.open, close: p.close, head: tops[0]!, tops, count: n.count, inside, rows: n.rows, total: outside + n.count, drawn, back: "まとめてたたむ", mapLink: null });
    });
    if (!row.childElementCount) b.dataset.bulkFirst = "1";
    row.append(b);
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
  const head = h("h3", { class: "insp-label" }, `選んだ ${all.length} 枚の先をひらく`, h("span", { class: "insp-count" }, `キャンバスは全体で ${num(DEEP_OPEN_CAP)} 枚まで`));
  el.append(head);
  if (other) el.append(h("p", { class: "deep-open-note" }, `地図のカードだけを開きます（ほかの ${other} 件はそのまま）`));
  if (hidden.length) el.append(...hiddenRows(app, ctx, hidden, "multi-show"));
  if (row.childElementCount) el.append(h("p", { class: "deep-open-note" }, keepNum(hidden.length ? `見えている ${picks.length} 枚の先を、どこまで開くか（重なるときは深い方まで）` : "どこまで開くか（重なるときは深い方まで）")), row);
  else if (picks.length) el.append(h("p", { class: "deep-open-note" }, "選んだカードの先に、開ける判断と手がありません"));
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
