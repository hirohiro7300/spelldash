// 「資産 10 億円」のゴールを見取り図・手の詳しい画面・道の終わりに出す（設計: 作業メモ goal/design.md §4.1・§4.2・§4.4・§4.5）
//   goalOverviewVM(a, view)  見取り図の帯（たたむと 1 行と棒・開くと 3 つの数・届くための手立て・地図が数える範囲・前提・注）と、
//                            「10 の手をひと目で」の芽の札・その下の注・今日の欄の 1 行（DOM を使わない。テストで確かめる）
//   goalMoveVM(a, view, f)   手の詳しい画面の「10 億」の 1 行（この手の行き先の期限の資産の幅・芽・一番近い行き先）
//   goalEndText(a, view, i)  道の終わりの 1 文（3 年後の月の稼ぎがそのまま続くと、期限の年の資産は…）
//   goalStripEl / goalSeedEl / fillGoalSlots  DOM（数ができる前は「数えています」の場所だけ置き、できたら埋める）
// 36 か月目より先の数はどれも「目安」か「前提」と並べる。「届く見込み 0%」は出さない（届く年か、届かないときの資産を出す）。
// 数は計算ごとの出どころ（goalViewOf。アプリは文書の入口の meta.goal を読む）から。出どころが無い画面（起動の絵）は帯の場所だけ。

import { BIZ_MIN, formatGoalShare, formatGrowth, formatManMonthly, formatOku, formatTimes, G_MAX, GOAL_BASIS_NOTE, goalBand, goalFrameLine, goalLeafLine, goalLeaf, goalLeverLines, goalLevers, goalName, goalPremiseLine, goalSeedNote, REACH_CAP_Y, assetsAtBy, type GoalInput, type GoalKey, type GoalTables } from "../../model/goal";
import { CHECKED_ANNUALS, F_BASE, goalInputAt, kindKey, type Analysis, type GoalBest, type GoalBucket, type GoalScope, type GoalView } from "../core";
import { h, nobr } from "./dom";
import { annualDepthNote, moveName, num, pathHash, pct, pct1, ym } from "./format";

/** 帯の 3 つの数の 1 つ */
export interface GoalTileVM {
  label: string;
  value: string;
  sub: string;
}

/** 見取り図の帯（「3 年の見取り図」のいちばん上） */
export interface GoalStripVM {
  /** 数の鍵（同じ鍵なら描き直さない） */
  key: string;
  /** 「ゴール 資産 10 億円・2056 年まで」の後ろ（「資産 10 億円・2056 年まで」） */
  head: string;
  /** 棒（0〜1: ゴールの何割か。期限の年の資産の 10%・50%・90%）。出せなければ null */
  bar: { lo: number; mid: number; hi: number } | null;
  /** 棒の横（「2056 年に約 0.45 億円（5%）・目安」） */
  barText: string;
  /** 読み上げ（たたんだときも、地図が数える範囲の最初の文まで） */
  aria: string;
  /** 今の資産がもうゴール以上（「もう届いています」）。そのときは 3 つの数と手立てを出さない */
  done: string | null;
  tiles: GoalTileVM[];
  /** 「届くには、どれか 1 つ（…）」と手立ての行 */
  leversHead: string | null;
  levers: string[];
  /** 地図が数える範囲と、その先の前提（開いたときいつも出す） */
  frame: string;
  /** 前提の 1 行（入れていない物に（仮）） */
  premise: string;
  /** 事業の稼ぎの中身と税の扱い */
  basis: string;
  /** 当てはまるときだけの注 */
  notes: string[];
  /** 今の資産を入れていないときの 1 行（「入れる」と並べる） */
  nudge: string | null;
}

/** 「10 の手をひと目で」の行の芽の札 */
export interface GoalSeedVM {
  node: number;
  /** 「芽 14%」「芽は選び方しだい」 */
  text: string;
  /** seed: 芽の見込みがある・choice: 部分木にはあるが、おすすめの選び方では残らない */
  kind: "seed" | "choice";
  /** 行の読み上げに足す文 */
  aria: string;
}

export interface GoalOverviewVM {
  key: string;
  strip: GoalStripVM;
  /** 今日の手ごと（芽の無い手は入れない） */
  seeds: GoalSeedVM[];
  /** 「10 の手をひと目で」の下の注（芽とは何か） */
  seedNote: string;
  /** 今日の欄の 1 行（「10 億への芽が一番多い手: …」） */
  today: string | null;
}

/** 手の詳しい画面の「10 億」の 1 行 */
export interface GoalMoveVM {
  /** 見出し（「10 億」） */
  name: string;
  text: string;
  /** 「その道を見る」の行き先（無ければ null） */
  href: string | null;
  linkText: string;
}

/** 手の名前（見取り図の行と同じ: 文書のカードの題名・無ければ地図の名前） */
export type GoalNameOf = (node: number) => string | null | undefined;

// ---------------------------------------------------------------- 数の鍵

const ids = new WeakMap<object, number>();
let nextId = 1;

/** 画面に出す数の鍵（設定ごとの数と、仮の印の付き方で決まる） */
export function goalViewKey(view: GoalView): string {
  let id = ids.get(view.summary);
  if (id === undefined) ids.set(view.summary, (id = nextId++));
  return `${id}|${[...view.read.assumed].sort().join(",")}`;
}

// ---------------------------------------------------------------- 書き方

/** ゴールの単位で書く（目標が 1 億以上なら、100 万円以上は億で） */
const okuOf = (t: GoalTables): boolean => t.T >= 10_000;

/** 資産の幅（「0.40〜0.52 億円」。単位が違えば両方に付ける） */
export function okuRange(lo: number, hi: number, oku: boolean): string {
  const a = formatOku(lo, oku);
  const b = formatOku(hi, oku);
  if (a === b) return a;
  const unit = (s: string): string => s.replace(/^[\d.,]+ /, "");
  return unit(a) === unit(b) ? `${a.replace(/ (?:億|万)円$/, "")}〜${b}` : `${a}〜${b}`;
}

/** 手の名前（見取り図の行と同じ決まり） */
function moveLabel(a: Analysis, node: number, nameOf: GoalNameOf | undefined): string {
  const base = (a.cm.flags[node]! & F_BASE) !== 0;
  return (!base && nameOf?.(node)?.trim()) || moveName(a.cm.map, kindKey(a.cm, node), base);
}

/** 範囲の行き先のうち、期限の資産が p50 に一番近い物（真ん中あたりの行き先。手立てと前提の幅はこの行き先で出す） */
function middleOf(t: GoalTables, b: GoalBucket, p50: number): GoalInput | null {
  let best: GoalInput | null = null;
  let gap = Infinity;
  for (let k = 0; k < b.count; k++) {
    const T3 = b.items[k * 4]!;
    const Rsal = b.items[k * 4 + 1]!;
    const Rbiz = b.items[k * 4 + 2]!;
    const d = Math.abs(assetsAtBy(t, T3, Rsal, Rbiz) - p50);
    if (d < gap) {
      gap = d;
      best = { T3, Rsal, Rbiz, split: true };
    }
  }
  return best;
}

/** 範囲の行き先の 3 年後の月の稼ぎの平均（見込みの重みで） */
function meanEarn(b: GoalBucket): number {
  let s = 0;
  let m = 0;
  for (let k = 0; k < b.count; k++) {
    const w = b.items[k * 4 + 3]!;
    s += (b.items[k * 4 + 1]! + b.items[k * 4 + 2]!) * w;
    m += w;
  }
  return m > 0 ? s / m : NaN;
}

/** どの範囲の中でも、要る事業の伸びが一番小さい行き先 */
function nearestOf(scopes: readonly (GoalScope | null)[]): GoalBest | null {
  let out: GoalBest | null = null;
  for (const s of scopes) {
    const b = s?.bestGrow;
    if (b && (!out || b.gReq < out.gReq || (b.gReq === out.gReq && b.atBy > out.atBy))) out = b;
  }
  return out;
}

// ---------------------------------------------------------------- 見取り図

/** 見取り図の帯・芽の札・注・今日の欄の 1 行 */
export function goalOverviewVM(a: Analysis, view: GoalView, opts: { name?: GoalNameOf } = {}): GoalOverviewVM {
  const { summary, base, read } = view;
  const t = summary.tables;
  const cfg = t.cfg;
  const oku = okuOf(t);
  const goal = goalName(t);
  const scope = summary.pi ?? summary.keep;
  const bucket = summary.pi ? base.pi : base.keep;
  const at = scope?.atBy ?? null;
  const mid = bucket && at ? middleOf(t, bucket, at.p50) : null;
  const leaf = mid ? goalLeaf(t, mid) : null;
  const band = mid ? goalBand(t, mid) : null;
  const head = `${goal}・${t.by} 年まで`;
  const share = at ? formatGoalShare(Math.min(1, Math.max(0, at.p50 / t.T))) : null;
  const barText = at ? `${t.by} 年に約 ${formatOku(at.p50, oku)}（${share}）・目安` : "期限の年の資産を出せません";
  const frame = goalFrameLine(t);
  const aria = [
    `ゴールは${goal}、${t.by} 年まで`,
    at ? `今の前提では ${t.by} 年に約 ${formatOku(at.p50, oku)}、ゴールの ${share}` : null,
    at ? `10〜90% で ${okuRange(at.p10, at.p90, oku)}` : null,
    "目安",
    frame.split("。")[0]!,
  ]
    .filter((x): x is string => !!x)
    .join("。");
  const bar = at ? { lo: Math.min(1, Math.max(0, at.p10 / t.T)), mid: Math.min(1, Math.max(0, at.p50 / t.T)), hi: Math.min(1, Math.max(0, at.p90 / t.T)) } : null;
  const done = cfg.assets >= t.T ? `もう届いています（今の資産 ${formatOku(cfg.assets)} ≥ ${formatOku(t.T)}）` : null;
  const tiles: GoalTileVM[] = [];
  let levers: string[] = [];
  const allScopes = [...summary.moves, summary.pi, summary.keep];
  if (!done && scope && leaf && mid) {
    // 1: 届く年（届く見込みは 0 より大きいときだけ。「0%」は出さない）
    if (scope.pBy > 0)
      tiles.push({ label: "期限までに届く見込み", value: pct(scope.pBy), sub: scope.reach.p50 !== null ? `届く年（真ん中） ${scope.reach.p50} 年・目安` : "目安" });
    else if (scope.reach.p50 !== null && scope.reach.unreached < 0.5) tiles.push({ label: "今の前提で届く年", value: `${scope.reach.p50} 年`, sub: "真ん中の行き先で・目安" });
    else tiles.push({ label: "今の前提で届く年", value: `${REACH_CAP_Y} 年先でも届かない`, sub: `${REACH_CAP_Y} 年後で約 ${formatOku(leaf.atCap, oku)}（真ん中の行き先・目安）` });
    // 2: 要る積立
    if (!(t.s > 0)) tiles.push({ label: "届くには毎月の積立", value: "—", sub: "積み立てない前提なので、資産は利回りだけで増えます" });
    else if (leaf.cReq <= 0) tiles.push({ label: "届くには毎月の積立", value: "積立なしで届く", sub: `3 年後からは積み立てなくても ${t.by} 年までに届く（利回りは年 ${cfg.ret}% の前提）` });
    else
      tiles.push({
        label: "届くには毎月の積立",
        value: formatManMonthly(leaf.cReq),
        sub: `3 年後から。3 年後の稼ぎ 月 ${formatManMonthly(mid.Rsal + mid.Rbiz)}の ${formatTimes(leaf.ratioEarn)}・目安`,
      });
    // 3: 要る事業の伸び（一番近い行き先で。給与は据え置き）
    const near = nearestOf(allScopes);
    const anyBiz = base.moves.some((b) => b.treeMaxBiz >= BIZ_MIN);
    const reachedBest = allScopes.some((s) => !!s?.best && s.best.atBy >= t.T);
    if (!(t.s > 0)) tiles.push({ label: "届くには事業が", value: "—", sub: "積み立てない前提なので、事業の伸びでは数えません" });
    else if (reachedBest) tiles.push({ label: "一番近い行き先は", value: "期限までに届く", sub: `事業の伸びは年 ${formatGrowth(cfg.bizGrow)} のままで・目安` });
    else if (near && Number.isFinite(near.gReq))
      tiles.push({ label: "届くには事業が", value: `毎年 ${formatGrowth(near.gReq)}`, sub: `一番近い行き先で（事業 月 ${formatManMonthly(near.Rbiz)}から・給与は据え置き）・目安` });
    else if (!anyBiz) tiles.push({ label: "届くには事業が", value: "—", sub: "給与だけの道では届かない（事業の稼ぎのある行き先が無い）" });
    else tiles.push({ label: "届くには事業が", value: `年 ${G_MAX}% でも足りない`, sub: "一番近い行き先でも（給与は据え置き）・目安" });
    levers = goalLeverLines(t, goalLevers(t, mid, leaf));
  }
  const notes: string[] = [];
  if (scope && scope.est >= 0.1) notes.push(`このうち ${pct(scope.est)} は、まとめた行き先の続きの見積もりから出ています。`);
  if (a.annual < CHECKED_ANNUALS[0] || a.annual > CHECKED_ANNUALS[1]) notes.push(`${annualDepthNote(ym(a.cm.map, a.cm.H))}。`);
  if (summary.noneReach && !done) {
    const means = base.moves.map(meanEarn).filter(Number.isFinite);
    const spread = means.length ? Math.max(...means) - Math.min(...means) : NaN;
    notes.push(
      `この地図のどの行き先でも、今の前提では期限までに届きません。${Number.isFinite(spread) ? `${num(base.moves.length)} の手の差は、3 年後の月の稼ぎの平均で月 ${formatManMonthly(spread)}ほどで、` : ""}届くかどうかは 3 年より後の事業の伸びで決まります。`,
    );
  }
  const strip: GoalStripVM = {
    key: goalViewKey(view),
    head,
    bar,
    barText,
    aria,
    done,
    tiles,
    leversHead: levers.length ? "届くには、どれか 1 つ（真ん中あたりの行き先で・ほかの前提はそのまま・目安）" : null,
    levers,
    frame,
    premise: goalPremiseLine(t, read.assumed, band),
    basis: GOAL_BASIS_NOTE,
    notes,
    nudge: read.assumed.has("assets") ? "今の資産を入れると、この数字があなたのものになります" : null,
  };
  // 芽の札（手ごと）
  const seeds: GoalSeedVM[] = [];
  for (const s of summary.moves) {
    if (s.seed > 0) seeds.push({ node: s.node, text: `芽 ${formatGoalShare(s.seed)}`, kind: "seed", aria: `芽のある行き先 ${formatGoalShare(s.seed)}` });
    else if (s.choiceOnly) seeds.push({ node: s.node, text: "芽は選び方しだい", kind: "choice", aria: "芽は選び方しだい（おすすめの選び方では残らない）" });
  }
  // 今日の欄: 芽が一番多い手と、どの手でも 3 年後の稼ぎのままならの期限の資産（手ごとの真ん中の幅）
  let today: string | null = null;
  const top = summary.moves.reduce<GoalScope | null>((m, s) => (s.seed > 0 && (!m || s.seed > m.seed) ? s : m), null);
  const p50s = summary.moves.map((s) => s.atBy?.p50).filter((x): x is number => x !== undefined && Number.isFinite(x));
  if (p50s.length) {
    const name = formatOku(t.T).replace(/円$/, "");
    const first = top ? `${name}への芽が一番多い手: ${moveLabel(a, top.node, opts.name)}（芽 ${formatGoalShare(top.seed)}）。` : "";
    today = `${first}どの手でも、3 年後の稼ぎのままなら ${t.by} 年に約 ${okuRange(Math.min(...p50s), Math.max(...p50s), oku)}です（手ごとの真ん中・目安）。`;
  }
  return { key: strip.key, strip, seeds, seedNote: goalSeedNote(t), today };
}

// ---------------------------------------------------------------- 手の詳しい画面・道の終わり

/** 手の詳しい画面の「10 億」の 1 行（今日の手 f の範囲。出せなければ null） */
export function goalMoveVM(a: Analysis, view: GoalView, f: number): GoalMoveVM | null {
  const s = view.summary.moves.find((m) => m.node === f);
  if (!s || !s.atBy) return null;
  const t = view.summary.tables;
  const oku = okuOf(t);
  const name = formatOku(t.T).replace(/円$/, "");
  const parts: string[] = [`この手の行き先の ${t.by} 年の資産は ${okuRange(s.atBy.p10, s.atBy.p90, oku)}（10〜90%・目安）。`];
  if (s.seed > 0) parts.push(`芽のある行き先 ${formatGoalShare(s.seed)}。`);
  let href: string | null = null;
  let linkText = "その道を見る";
  const best = s.bestGrow;
  const top = s.best;
  if (top && top.atBy >= t.T) {
    parts.push(`この手の先で一番 ${name}に近い行き先は、${t.by} 年までに届く目安です（そこへ向かう手を選び続けたら ${pct1(top.prob)}）。`);
    href = pathHash(a.cm.map, top.node);
  } else if (best && Number.isFinite(best.gReq)) {
    parts.push(
      `この手の先で一番 ${name}に近い行き先でも、事業の稼ぎ（月 ${formatManMonthly(best.Rbiz)}）が毎年 ${formatGrowth(best.gReq)} 伸び続ける必要があります（そこへ向かう手を選び続けたら ${pct1(best.prob)}）。`,
    );
    href = pathHash(a.cm.map, best.node);
  } else if (top) {
    parts.push(`この手の先で一番 ${name}に近い行き先でも、${t.by} 年に約 ${formatOku(top.atBy, oku)}（事業の稼ぎが年 ${G_MAX}% 伸びても届かない目安）です。`);
    href = pathHash(a.cm.map, top.node);
  }
  if (s.choiceOnly) {
    parts.push("おすすめの選び方では芽が残りません。芽のある行き先は、別の答えを選んだときだけです。");
    if (best) href = pathHash(a.cm.map, best.node);
  }
  if (!href) linkText = "";
  return { name, text: parts.join(""), href, linkText };
}

/** 道の終わり（地図の番号 i の行き先）の 1 文。数が出せなければ null */
export function goalEndText(a: Analysis, view: GoalView, i: number): string | null {
  const x = goalInputAt(a, i);
  if (!x) return null;
  const t = view.summary.tables;
  const leaf = goalLeaf(t, x);
  return goalLeafLine(t, x, leaf, goalBand(t, x));
}

// ---------------------------------------------------------------- DOM

/** 帯を開いておくか（このブラウザの表示の設定。読めなければ画面の高さで: 900px 以上なら開く） */
const OPEN_KEY = "4d-branch:goalStripOpen";

function stripOpen(): boolean {
  try {
    const v = globalThis.localStorage?.getItem(OPEN_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* 読めなくても動く */
  }
  return typeof window !== "undefined" && window.innerHeight >= 900;
}

function rememberOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* 残せなくても動く */
  }
}

/** 前提を変える・入れるのボタン（アプリが押したのを受ける: data-goal-act） */
function editBtn(text: string, field: GoalKey | null, title: string): HTMLButtonElement {
  return h("button", { class: "dm-goal-link", title, attrs: { type: "button", "data-goal-act": "edit", "data-goal-field": field } }, text);
}

/** 数ができる前の帯（たたんだ帯と同じ高さ。数ができたら埋める） */
export function goalSkeletonEl(): HTMLElement {
  return h(
    "section",
    { class: "dm-goal is-wait", attrs: { "aria-label": "資産のゴール", "aria-busy": "true" }, dataset: { goalKey: "" } },
    h("p", { class: "dm-goal-wait" }, "資産のゴールまでの距離を数えています…"),
  );
}

/** 見取り図の帯 */
export function goalStripEl(vm: GoalStripVM): HTMLElement {
  const bar = h("span", { class: "dm-goal-bar", attrs: { "aria-hidden": "true" } });
  if (vm.bar) {
    const pc = (x: number): string => `${(x * 100).toFixed(2)}%`;
    bar.append(
      h("i", { class: "dm-goal-band", style: { left: pc(vm.bar.lo), width: pc(Math.max(0, vm.bar.hi - vm.bar.lo)) } }),
      h("i", { class: "dm-goal-fill", style: { width: pc(vm.bar.mid) } }),
    );
  }
  const body = h("div", { class: "dm-goal-body" });
  if (vm.done) body.append(h("p", { class: "dm-goal-done" }, nobr(vm.done)));
  if (vm.tiles.length)
    body.append(
      h(
        "div",
        { class: "dm-goal-tiles" },
        vm.tiles.map((x) => h("div", { class: "dm-goal-tile" }, h("span", { class: "dm-goal-tile-label" }, x.label), h("b", { class: `dm-goal-tile-value${x.value.length > 7 ? " is-long" : ""}` }, nobr(x.value)), h("span", { class: "dm-goal-tile-sub" }, nobr(x.sub)))),
      ),
    );
  if (vm.leversHead && vm.levers.length)
    body.append(h("div", { class: "dm-goal-levers" }, h("p", { class: "dm-goal-levers-head" }, vm.leversHead), h("ul", null, vm.levers.map((t) => h("li", null, nobr(t))))));
  body.append(h("p", { class: "dm-goal-frame" }, vm.frame));
  const premiseText = h("span", { class: "dm-goal-premise-t" }, nobr(vm.premise));
  const premise = h(
    "p",
    {
      class: "dm-goal-premise",
      title: "押すと前提の全文",
      on: {
        click: (ev) => {
          if ((ev.target as Element | null)?.closest?.("button")) return;
          premise.classList.toggle("is-open");
        },
      },
    },
    premiseText,
    " ",
    editBtn("前提を変える", null, "資産のゴールの前提を変える"),
  );
  body.append(premise, h("p", { class: "dm-goal-basis" }, vm.basis));
  for (const n of vm.notes) body.append(h("p", { class: "dm-goal-note" }, nobr(n)));
  if (vm.nudge) body.append(h("p", { class: "dm-goal-nudge" }, vm.nudge, " ", editBtn("入れる", "assets", "今の資産を入れる")));
  const box = h(
    "details",
    { class: "dm-goal-box", on: { toggle: () => rememberOpen(box.open) } },
    h(
      "summary",
      { class: "dm-goal-sum", attrs: { "aria-label": vm.aria } },
      h("span", { class: "dm-goal-head" }, h("b", null, "ゴール"), nobr(vm.head)),
      h("span", { class: "dm-goal-more", attrs: { "aria-hidden": "true" } }),
      bar,
      h("span", { class: "dm-goal-bartext" }, nobr(vm.barText)),
    ),
    body,
  );
  if (stripOpen()) box.open = true;
  return h("section", { class: "dm-goal", attrs: { "aria-label": "資産のゴール" }, dataset: { goalKey: vm.key } }, box);
}

/** 「10 の手をひと目で」の行の芽の札（数ができる前・芽の無い手は空） */
export function goalSeedEl(node: number, vm: GoalSeedVM | null, key: string): HTMLElement {
  return h("span", { class: `dm-goal-seed${vm ? ` is-${vm.kind}` : ""}`, dataset: { goalNode: String(node), goalKey: key } }, vm ? vm.text : "");
}

/** 置いた場所（帯・芽の札・注・今日の欄の 1 行）を、鍵が違う物だけ今の数で埋める。埋めた場所の数を返す */
export function fillGoalSlots(root: ParentNode, vm: GoalOverviewVM): number {
  let n = 0;
  for (const el of root.querySelectorAll<HTMLElement>(".dm-goal[data-goal-key]")) {
    if (el.dataset.goalKey === vm.key) continue;
    const fresh = goalStripEl(vm.strip);
    // 開け閉めは、今の帯のまま
    const was = el.querySelector("details");
    if (was) (fresh.querySelector("details") as HTMLDetailsElement).open = (was as HTMLDetailsElement).open;
    el.replaceWith(fresh);
    n++;
  }
  const seeds = new Map(vm.seeds.map((s) => [s.node, s] as const));
  for (const el of root.querySelectorAll<HTMLElement>(".dm-goal-seed[data-goal-node]")) {
    if (el.dataset.goalKey === vm.key) continue;
    const s = seeds.get(Number(el.dataset.goalNode)) ?? null;
    el.className = `dm-goal-seed${s ? ` is-${s.kind}` : ""}`;
    el.textContent = s ? s.text : "";
    el.dataset.goalKey = vm.key;
    const row = el.closest("a");
    if (row) {
      const base = row.dataset.goalAria ?? row.getAttribute("aria-label") ?? "";
      row.dataset.goalAria = base;
      row.setAttribute("aria-label", s ? `${base}。${s.aria}` : base);
    }
    n++;
  }
  for (const el of root.querySelectorAll<HTMLElement>(".dm-goal-seednote[data-goal-key]")) {
    if (el.dataset.goalKey === vm.key) continue;
    el.textContent = vm.seedNote;
    el.dataset.goalKey = vm.key;
    n++;
  }
  for (const el of root.querySelectorAll<HTMLElement>(".dm-goal-today[data-goal-key]")) {
    if (el.dataset.goalKey === vm.key) continue;
    el.replaceChildren(...flat(nobr(vm.today ?? "")));
    el.hidden = !vm.today;
    el.dataset.goalKey = vm.key;
    n++;
  }
  return n;
}

function flat(xs: ReturnType<typeof nobr>): Array<Node | string> {
  return xs.filter((x): x is Node | string => typeof x === "string" || x instanceof Node);
}
