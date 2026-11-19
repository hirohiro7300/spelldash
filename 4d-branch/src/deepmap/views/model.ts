// 画面に出す形（DOM を使わない。テストで確かめる）: 計算の芯の数に、単位と何の数かの言葉を付ける
//   overviewVM(a)        見取り図（今日の手ごとの行。良い順）
//   moveDetailVM(a, f)   手の詳しい画面（扇・分かれ道の帯・進め方・行き先・一番ありそうな道）
//   pathVM(a, i, text)   道の画面の仮の形（一番ありそうな道の行を並べるだけ。次の段で道の画面になる）
// 設計: 作業メモ SPEC v1 §5.1・§5.2・§5.3・§5.5・§5.7。作業メモ user-1・user-4・user-13・user-14・truth-4・truth-18

import {
  destinations,
  fanData,
  forkStrip,
  isUnder,
  kindKey,
  mostLikelyChain,
  overview,
  planView,
  quarterSpanText,
  walkPath,
  ROLE_A,
  type Analysis,
  type DeltaBasis,
  type Dist,
  type FanPoint,
  type MoveSummary,
  type Overview,
  type PlanCond,
  type TextSource,
} from "../core";
import {
  BASE_TEXT,
  basisNote,
  basisText,
  binColors,
  countsLine,
  countsParts,
  DELTA_LABEL,
  FOOTER_TEXT,
  kindName,
  man,
  manDelta,
  manDeltaRange,
  manMonthly,
  manRange,
  moveHash,
  moveName,
  NEAR_KEEP_TEXT,
  num,
  outcomeName,
  OVERVIEW_HASH,
  pathHash,
  pct,
  pct1,
  safeName,
  shareList,
  WORTH_LABEL,
  worthText,
  ym,
} from "./format";

// ------------------------------------------------------------ 見取り図

export interface PillVM {
  /** 何の差か（「今やる vs 3 か月待つ」） */
  label: string;
  /** 値（「+22 万円」・「ほぼ差なし」・「比べる元」） */
  text: string;
  /** 色の段（−4〜+4） */
  bin: number;
  /** 差の出し方（「地図の値」など）。無ければ null */
  basis: string | null;
  /** 比べる元（今のまま）の札 */
  base: boolean;
}

export interface SharePart {
  label: string;
  share: number;
}

export type DecidesVM =
  /** 事実を知る手（会社の答えなど） */
  | { kind: "reveal"; head: string; parts: SharePart[]; text: string; near: boolean }
  /** 今のままの先とほぼ同じ */
  | { kind: "near"; text: string }
  /** 結果で分かれる手 */
  | { kind: "outcomes"; head: string; parts: SharePart[]; text: string }
  /** 比べる元 */
  | { kind: "base"; text: string }
  /** 結果が 1 つで、今のままとも違う */
  | { kind: "plain"; text: string };

export interface StripCol {
  /** その段の月（0・3・…・33） */
  m: number;
  /** 年月（「2027 年 2 月」） */
  ym: string;
  /** 判断の数 */
  dec: number;
  /** 出来事の分かれの数 */
  split: number;
}

export interface OverviewRowVM {
  node: number;
  kind: string;
  href: string;
  name: string;
  isBase: boolean;
  /** 一番良い選び方で今日選ぶ手 */
  isPi: boolean;
  delta: PillVM | null;
  worth: PillVM | null;
  /** 3 年の合計の分布（ずっと今のままとの差の 9 段。合計 1） */
  bins: number[] | null;
  /** 「3 年の合計 1,159〜1,452 万円（10〜90%・真ん中 1,269 万円）」 */
  rangeText: string | null;
  /** rangeText の区切り（折り返しは区切りの間で） */
  rangeParts: string[];
  /** 「ずっと今のままより +35〜+328 万円」 */
  vsKeepText: string | null;
  decides: DecidesVM;
  /** 分かれ道（判断 + 出来事の分かれ） */
  forks: number;
  /** 「この先の分かれ道 2,038」 */
  forksText: string;
  /** 3 か月ごとの判断と出来事の分かれの数（0〜33 か月目） */
  strip: StripCol[];
  /** 判断・出来事の分かれ・行き先の数の 1 行 */
  countsText: string;
  /** countsText の区切り */
  countsParts: string[];
  /** 標準の続きの見積もりを含む割合の注記（ふつう null） */
  summaryText: string | null;
  /** 行全体の読み上げ */
  aria: string;
  /** 並べる順の値（表示した差） */
  sortKey: number;
}

export interface OverviewVM {
  annual: number;
  rows: OverviewRowVM[];
  /** 「今日選べる 10 の手。どの手の先にも、2029 年 11 月まで 1,981〜2,489 の分かれ道が続く」 */
  lead: string;
  /** 「一番良い選び方で進むと、3 年の稼ぎの合計は … 」 */
  headline: string | null;
  /** ずっと今のまま（比べる帯） */
  keep: { label: string; text: string; bins: number[] | null } | null;
  basis: DeltaBasis;
  basisNote: string;
  /** 「この種類を 3 年やらない場合との差」が無い版の注記 */
  worthNote: string | null;
  footer: string;
  /** 地図の終わりの年月（「2029 年 11 月」） */
  endYm: string;
  /** 今日から一番ありそうな道 */
  chain: { node: number; p: number; href: string; text: string } | null;
}

/** 分布の 10〜90% と真ん中の言葉 */
function distTexts(d: Dist | null, vSQ: number | null): { rangeText: string | null; rangeParts: string[]; vsKeepText: string | null } {
  if (!d) return { rangeText: null, rangeParts: [], vsKeepText: null };
  const rangeParts = [`3 年の合計 ${manRange(d.p10, d.p90)}`, `（10〜90%・真ん中 ${man(d.p50)}）`];
  const vsKeepText = vSQ === null ? null : `ずっと今のままより ${manDeltaRange(d.p10 - vSQ, d.p90 - vSQ)}`;
  return { rangeText: rangeParts.join(""), rangeParts, vsKeepText };
}

function stripOf(a: Analysis, f: number): StripCol[] {
  const st = forkStrip(a, f);
  const map = a.cm.map;
  const cols: StripCol[] = [];
  for (let q = 0; q < st.months.length; q++) {
    const m = st.months[q]!;
    if (m >= a.cm.H) continue;
    cols.push({ m, ym: ym(map, m), dec: st.decisions[q]!, split: st.splits[q]! });
  }
  return cols;
}

function decidesOf(a: Analysis, mv: MoveSummary): DecidesVM {
  const map = a.cm.map;
  if (mv.isBase) return { kind: "base", text: BASE_TEXT };
  const near = mv.nearKeep || mv.smallDelta;
  if (mv.reveals) {
    const parts = mv.reveals.answers.map((g) => ({ label: safeName(g.label, "答え"), share: g.share }));
    const head = mv.reveals.label;
    return { kind: "reveal", head, parts, text: `${head}: ${shareList(parts)}`, near };
  }
  if (near) return { kind: "near", text: NEAR_KEEP_TEXT };
  if (mv.outcomes.length >= 2) {
    const parts = mv.outcomes.map((o) => ({ label: outcomeName(map, o.node), share: o.w }));
    const m = a.cm.month[mv.outcomes[0]!.node]!;
    const head = `${ym(map, m)}の結果`;
    return { kind: "outcomes", head, parts, text: `${head}: ${shareList(parts)}` };
  }
  return { kind: "plain", text: "この手の結果は 1 つ（その後の選び方で分かれる）" };
}

function deltaPill(mv: MoveSummary): PillVM | null {
  if (mv.isBase) return { label: DELTA_LABEL, text: "比べる元", bin: 0, basis: null, base: true };
  if (!mv.delta) return null;
  return { label: DELTA_LABEL, text: manDelta(mv.delta.d), bin: binColors(mv.delta.d).bin, basis: basisText(mv.delta.basis), base: false };
}

function worthPill(mv: MoveSummary): PillVM | null {
  if (mv.isBase || mv.worth === null) return null;
  const text = worthText(mv.worth);
  return { label: WORTH_LABEL, text, bin: text === "ほぼ差なし" ? 0 : binColors(mv.worth).bin, basis: null, base: false };
}

export function overviewRowVM(a: Analysis, ov: Overview, mv: MoveSummary): OverviewRowVM {
  const map = a.cm.map;
  const endYm = ym(map, a.cm.H);
  const name = moveName(map, mv.kind, mv.isBase);
  const delta = deltaPill(mv);
  const worth = worthPill(mv);
  const { rangeText, rangeParts, vsKeepText } = distTexts(mv.dist, ov.vSQ);
  const decides = decidesOf(a, mv);
  const strip = stripOf(a, mv.node);
  const forksText = `この先の分かれ道 ${num(mv.counts.forks)}`;
  const countsText = countsLine(mv.counts, endYm);
  const countsParts_ = countsParts(mv.counts, endYm);
  const via = mv.dist?.viaSummary ?? 0;
  const summaryText = via > 0.005 ? `3 年の合計の ${pct(via)} は標準の続きの見積もり` : null;
  const aria = [name, mv.isPi ? "一番良い手" : null, delta ? `${delta.label} ${delta.text}${delta.basis ? `（${delta.basis}）` : ""}` : null, worth ? `${worth.label} ${worth.text}` : null, rangeText, vsKeepText, decides.text, forksText, countsText]
    .filter((x): x is string => !!x)
    .join("。");
  return {
    node: mv.node,
    kind: mv.kind,
    href: moveHash(mv.kind),
    name,
    isBase: mv.isBase,
    isPi: mv.isPi,
    delta,
    worth,
    bins: mv.dist?.bins ?? null,
    rangeText,
    rangeParts,
    vsKeepText,
    decides,
    forks: mv.counts.forks,
    forksText,
    strip,
    countsText,
    countsParts: countsParts_,
    summaryText,
    aria,
    sortKey: mv.isBase ? 0 : (mv.delta?.d ?? -Infinity),
  };
}

export function overviewVM(a: Analysis, ov: Overview = overview(a)): OverviewVM {
  const map = a.cm.map;
  const endYm = ym(map, a.cm.H);
  const rows = ov.moves.map((mv) => overviewRowVM(a, ov, mv));
  // 良い順（表示した差の大きい順。同じなら地図の値、次に並べる順）
  const value = new Map(ov.moves.map((m) => [m.node, m.value] as const));
  const order = new Map(ov.moves.map((m) => [m.node, m.k] as const));
  rows.sort((x, y) => y.sortKey - x.sortKey || (value.get(y.node) ?? 0) - (value.get(x.node) ?? 0) || order.get(x.node)! - order.get(y.node)!);
  const forks = ov.moves.map((m) => m.counts.forks);
  const lo = forks.length ? Math.min(...forks) : 0;
  const hi = forks.length ? Math.max(...forks) : 0;
  const lead =
    forks.length > 0
      ? `今日選べる ${num(ov.moves.length)} の手。どの手の先にも、${endYm}まで ${lo === hi ? num(lo) : `${num(lo)}〜${num(hi)}`} の分かれ道が続く`
      : "今日選べる手がありません";
  let headline: string | null = null;
  if (ov.today && ov.vSQ !== null) {
    const t = ov.today;
    headline = `一番良い選び方で進むと、3 年の稼ぎの合計は ${manRange(t.p10, t.p90)}（10〜90%）、平均 ${man(t.mean)}。ずっと今のままなら ${ov.keep && Math.abs(ov.keep.p90 - ov.keep.p10) > 0.05 ? manRange(ov.keep.p10, ov.keep.p90) : man(ov.vSQ)}`;
  }
  const keep =
    ov.keep && ov.vSQ !== null
      ? {
          label: "ずっと今のまま（12 回とも今のまま）",
          text: Math.abs(ov.keep.p90 - ov.keep.p10) > 0.05 ? `3 年の合計 ${manRange(ov.keep.p10, ov.keep.p90)}（真ん中 ${man(ov.keep.p50)}）` : `3 年の合計 ${man(ov.vSQ)}（どの道でも同じ）`,
          bins: ov.keep.bins,
        }
      : null;
  const chainP = a.pi.def[0] ? mostLikelyChain(a, 0) : null;
  const chain = chainP && chainP.nodes.length > 1 ? { node: 0, p: chainP.p, href: pathHash(0), text: `一番ありそうな道（見込み ${pct1(chainP.p)}）` } : null;
  return {
    annual: a.annual,
    rows,
    lead,
    headline,
    keep,
    basis: ov.basis.delta,
    basisNote: basisNote(ov.basis.delta),
    worthNote: ov.basis.worth ? null : "「この種類を 3 年やらない場合との差」は、計算の前提を直した木で入る",
    footer: FOOTER_TEXT,
    endYm,
    chain,
  };
}

// ------------------------------------------------------------ 扇（月の稼ぎの広がり）

export interface FanPt {
  m: number;
  lo: number | null;
  mid: number | null;
  hi: number | null;
}

export interface FanSeries {
  id: string;
  label: string;
  /** 線と帯の色 */
  color: string;
  /** その帯になる見込み（全体・ずっと今のままは null） */
  share: number | null;
  pts: FanPt[];
  /** 帯を描く（ずっと今のままは線だけ） */
  band: boolean;
}

export interface FanVM {
  /** 点の年月（0・3・…・36 か月目） */
  months: number[];
  yms: string[];
  all: FanSeries;
  /** 答えごとの帯（事実を知る手だけ。3 つより多ければ出さない） */
  answers: FanSeries[];
  answersHead: string | null;
  keep: FanSeries;
  /** 標準の続きの見積もりの注記 */
  notes: string[];
  /** 月の稼ぎの中身 */
  formula: string;
}

/** 扇の色: 全体はアプリの強調色、ずっと今のままは灰色、答えは 3 色（暗い面で色の見分けを確かめた組） */
export const FAN_ALL = "#8b7bff";
export const FAN_KEEP = "#8a94a6";
export const FAN_ANSWERS = ["#199e70", "#d95926", "#9085e9"] as const;

function ptsOf(points: readonly FanPoint[]): FanPt[] {
  return points.map((p) => ({ m: p.m, lo: p.p10, mid: p.p50, hi: p.p90 }));
}

export function fanVM(a: Analysis, f: number): FanVM {
  const map = a.cm.map;
  const fd = fanData(a, f);
  const months = fd.all.points.map((p) => p.m);
  const answers: FanSeries[] = [];
  let answersHead: string | null = null;
  if (fd.answers.length >= 2 && fd.answers.length <= FAN_ANSWERS.length) {
    fd.answers.forEach((b, k) => {
      answers.push({ id: `ans${k}`, label: safeName(b.label, `答え ${k + 1}`), color: FAN_ANSWERS[k]!, share: b.share, pts: ptsOf(b.points), band: true });
    });
    answersHead = "答えごと";
  }
  const notes: string[] = [];
  const via = Math.max(0, ...fd.all.points.map((p) => p.viaSummary));
  if (via > 0.005) notes.push(`${pct(via)} までの道は途中から標準の続きの見積もりで、その間の月の稼ぎは帯に入っていない`);
  const last = fd.all.points[fd.all.points.length - 1];
  if (last && last.estimated > 0.005) notes.push(`${ym(map, last.m)}の数の ${pct(last.estimated)} は標準の続きの見積もり`);
  return {
    months,
    yms: months.map((m) => ym(map, m)),
    all: { id: "all", label: "この手の後", color: FAN_ALL, share: null, pts: ptsOf(fd.all.points), band: true },
    answers,
    answersHead,
    keep: { id: "keep", label: "ずっと今のまま", color: FAN_KEEP, share: null, pts: ptsOf(fd.keep), band: false },
    notes,
    formula: `月の稼ぎ = 給与（年収 ${num(a.annual)} 万円 ÷ 12 × その時の給与の倍率）+ 広告運用 + SpellDash（税引き前）`,
  };
}

/** 軸のきりの良い目盛り（lo〜hi を max 個くらいに） */
export function niceTicks(lo: number, hi: number, max = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const raw = (hi - lo) / Math.max(1, max);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw - 1e-12) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** 扇の縦の範囲（出す帯と線の 10〜90% を全部含み、目盛りの切りの良い所まで広げる） */
export function fanDomain(series: readonly FanSeries[]): { lo: number; hi: number; ticks: number[] } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series)
    for (const p of s.pts)
      for (const v of [p.lo, p.mid, p.hi]) {
        if (v === null || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1, ticks: [0, 1] };
  const pad = Math.max(1, (hi - lo) * 0.06);
  const ticks = niceTicks(Math.max(0, lo - pad), hi + pad, 5);
  const t0 = ticks[0]!;
  const t1 = ticks[ticks.length - 1]!;
  return { lo: Math.min(t0, lo), hi: Math.max(t1, hi), ticks };
}

// ------------------------------------------------------------ 分かれ道の帯

export interface StripVM {
  cols: StripCol[];
  decisions: number;
  splits: number;
  forks: number;
  caption: string;
}

export function stripVM(a: Analysis, f: number): StripVM {
  const st = forkStrip(a, f);
  const cols = stripOf(a, f);
  return {
    cols,
    decisions: st.total.decisions,
    splits: st.total.splits,
    forks: st.total.forks,
    caption: `判断 ${num(st.total.decisions)} 回 + 出来事の分かれ ${num(st.total.splits)} = 分かれ道 ${num(st.total.forks)}`,
  };
}

// ------------------------------------------------------------ 進め方

export interface PlanMoveVM {
  kind: string;
  name: string;
  share: number;
  shareText: string;
  /** そうなる直前の結果（「据え置き・昇格なら」「続ける人を増やすの後」）。今日の手は null */
  cond: string | null;
  /** 標準の続きの見積もりの手の割合の注記（ふつう null） */
  stubText: string | null;
}

export interface PlanRowVM {
  m: number;
  /** 「2027 年 2 月」 */
  ym: string;
  /** 「2 月〜4 月の手」 */
  span: string;
  moves: PlanMoveVM[];
  /** 出さなかった手（「ほか 2 つの手 6%」） */
  more: string | null;
  /** その時点で続いている道・標準の続きの注記 */
  note: string | null;
}

export const PLAN_MOVES = 3;

/** 直前の結果の言葉（結果が 1 つの手は「〜の後」、それ以外は「〜なら」。同じ言葉は 1 つに） */
export function condText(a: Analysis, conds: readonly PlanCond[], more: boolean): string | null {
  const map = a.cm.map;
  const ifs: string[] = [];
  const afters: string[] = [];
  for (const c of conds) {
    if (c.single) {
      const n = kindName(map, c.fromKind);
      if (!afters.includes(n)) afters.push(n);
    } else {
      const l = safeName(c.label, "その結果");
      if (!ifs.includes(l)) ifs.push(l);
    }
  }
  const parts: string[] = [];
  if (ifs.length) parts.push(`${ifs.join("・")}なら`);
  if (afters.length) parts.push(`${afters.join("・")}の後`);
  if (!parts.length) return null;
  return parts.join("／") + (more ? "など" : "");
}

export function planVM(a: Analysis, f: number): PlanRowVM[] {
  const map = a.cm.map;
  const anchor = map.header.anchor;
  const span = (m: number) => {
    try {
      return `${quarterSpanText(anchor, m)}の手`;
    } catch {
      return "";
    }
  };
  const rows: PlanRowVM[] = [];
  for (const q of planView(a, f, { conds: 4 })) {
    const shown = q.moves.slice(0, PLAN_MOVES);
    const rest = q.moves.slice(PLAN_MOVES);
    const moves: PlanMoveVM[] = shown.map((mv) => ({
      kind: mv.kind,
      name: q.m === 0 ? moveName(map, mv.kind, (a.cm.flags[f]! & 1) !== 0) : kindName(map, mv.kind),
      share: mv.share,
      shareText: pct(mv.share),
      cond: q.m === 0 ? null : condText(a, mv.conds.slice(0, 3), mv.conds.length > 3),
      stubText: mv.stub > 0.005 ? `${pct(mv.stub)} は標準の続きの見積もり` : null,
    }));
    const restShare = rest.reduce((s, x) => s + x.share, 0);
    const notes: string[] = [];
    if (q.m > 0 && q.alive < 0.995 && q.alive + q.viaSummary > 0) notes.push(`この時点で判断がある道 ${pct(q.alive)}`);
    if (q.viaSummary > 0.005) notes.push(`${pct(q.viaSummary)} は標準の続きの見積もりの中`);
    rows.push({
      m: q.m,
      ym: q.m === 0 ? "今日" : ym(map, q.m),
      span: span(q.m),
      moves,
      more: rest.length ? `ほか ${num(rest.length)} つの手 ${pct(restShare)}` : null,
      note: notes.length ? notes.join("・") : null,
    });
  }
  return rows;
}

// ------------------------------------------------------------ 行き先

export interface DestRowVM {
  key: string;
  label: string;
  share: number;
  shareText: string;
  /** 「82 通りの道」 */
  countText: string;
  /** 「3 年の合計 平均 1,301 万円」 */
  meanText: string;
  /** 「ずっと今のままより +177 万円」 */
  vsKeepText: string | null;
  bin: number;
  /** 行き先（見込みの大きい順） */
  ends: number[];
  summaryText: string | null;
}

export interface DestVM {
  rows: DestRowVM[];
  more: string | null;
  groups: number;
}

export const DEST_ROWS = 8;

export function destVM(a: Analysis, f: number | null): DestVM {
  const all = destinations(a, f);
  const vSQ = a.vSQ;
  const rows = all.slice(0, DEST_ROWS).map((g) => ({
    key: g.key,
    label: safeName(g.label, "行き先"),
    share: g.share,
    shareText: pct(g.share),
    countText: `${num(g.count)} 通りの道`,
    meanText: `3 年の合計 平均 ${man(g.mean)}`,
    vsKeepText: vSQ === null ? null : `ずっと今のままより ${manDelta(g.mean - vSQ)}`,
    bin: vSQ === null ? 0 : binColors(g.mean - vSQ).bin,
    ends: g.ends,
    summaryText: g.summary > 0.005 ? `${pct(g.summary)} は標準の続きの見積もり` : null,
  }));
  const rest = all.slice(DEST_ROWS);
  const restShare = rest.reduce((s, g) => s + g.share, 0);
  return { rows, more: rest.length ? `ほか ${num(rest.length)} 種類（合わせて ${pct(restShare)}）` : null, groups: all.length };
}

// ------------------------------------------------------------ 手の詳しい画面

export interface OutcomeVM {
  label: string;
  shareText: string;
  totalText: string;
  vsKeepText: string | null;
  bin: number;
}

export interface MoveDetailVM {
  row: OverviewRowVM;
  /** 地図の終わりの年月（「2029 年 11 月」） */
  endYm: string;
  /** 「今日の手・2026 年 11 月〜2027 年 1 月」 */
  eyebrow: string;
  /** まとめの数（3 年の合計・分かれ道・行き先） */
  facts: string[];
  /** この手の結果（3 か月後） */
  outcomesHead: string;
  outcomes: OutcomeVM[];
  chain: { node: number; p: number; href: string; text: string } | null;
  fan: FanVM;
  strip: StripVM;
  plan: PlanRowVM[];
  dest: DestVM;
}

/** 今日の手 f（並べる順の鍵から）を探す。無ければ −1 */
export function findFirstMove(a: Analysis, slugOf: (kind: string) => string, slug: string): number {
  for (const f of a.cm.firstMoves) if (slugOf(kindKey(a.cm, f)) === slug) return f;
  return -1;
}

export function moveDetailVM(a: Analysis, f: number, ov: Overview = overview(a)): MoveDetailVM {
  const cm = a.cm;
  const map = cm.map;
  if (cm.parent[f] !== 0 || cm.role[f] !== ROLE_A) throw new RangeError(`今日の手ではありません: ${f}`);
  const mv = ov.moves.find((m) => m.node === f)!;
  const row = overviewRowVM(a, ov, mv);
  const endYm = ym(map, cm.H);
  let eyebrow = "今日の手";
  try {
    eyebrow = `今日の手・${ym(map, 0)}〜${ym(map, 2)}`;
  } catch {
    /* 年月が読めない */
  }
  const facts: string[] = [];
  const d = mv.dist;
  if (d && a.vSQ !== null) facts.push(`3 年の合計（この手の後、一番良い選び方で）: ${manRange(d.p10, d.p90)}（10〜90%）・平均 ${man(d.mean)}・ずっと今のままより平均 ${manDelta(d.mean - a.vSQ)}`);
  facts.push(`この先の分かれ道 ${num(mv.counts.forks)}（判断 ${num(mv.counts.decisions)} 回・出来事の分かれ ${num(mv.counts.splits)}）`);
  facts.push(`${endYm}の行き先 ${num(mv.counts.reachEnds)}（見込み 1% 以上 ${num(mv.counts.reachEnds1)}）・標準の続きの見積もり ${num(mv.counts.sumEnds)}`);
  const vSQ = a.vSQ;
  const outcomes: OutcomeVM[] = mv.outcomes.map((o) => ({
    label: outcomeName(map, o.node),
    shareText: pct(o.w),
    totalText: `3 年の合計 平均 ${man(o.total)}`,
    vsKeepText: vSQ === null ? null : `ずっと今のままより ${manDelta(o.total - vSQ)}`,
    bin: vSQ === null ? 0 : binColors(o.total - vSQ).bin,
  }));
  const outM = mv.outcomes.length ? cm.month[mv.outcomes[0]!.node]! : 3;
  const outcomesHead = mv.reveals ? `${mv.reveals.label}（${ym(map, outM)}）` : `${ym(map, outM)}の結果`;
  const ch = a.pi.def[f] ? mostLikelyChain(a, f) : null;
  const chain = ch && ch.nodes.length > 1 ? { node: f, p: ch.p, href: pathHash(f), text: `一番ありそうな道（見込み ${pct1(ch.p)}）` } : null;
  return { row, endYm, eyebrow, facts, outcomesHead, outcomes, chain, fan: fanVM(a, f), strip: stripVM(a, f), plan: planVM(a, f), dest: destVM(a, f) };
}

// ------------------------------------------------------------ 道の画面（仮の形: 行を並べるだけ）

export interface PathRowVM {
  /** 「2027 年 2 月」 */
  ym: string;
  /** 選んだ手 */
  move: string;
  /** 一番良い選び方の手 */
  onPi: boolean;
  /** 結果の名前と見込み（「SpellDash だけ 45%」）。結果が無ければ null */
  outcome: string | null;
  /** 結果の後の月の稼ぎ（「月の稼ぎ 30.4 万円」） */
  monthly: string;
  /** 道の始めからここまでの見込み */
  cum: string;
  /** まとめた手（この先は標準の続き） */
  stub: boolean;
}

export interface PathVM {
  title: string;
  intro: string;
  rows: PathRowVM[];
  /** 着いた所 */
  endTitle: string;
  endText: string;
  endNumbers: string[];
  /** まとめた行き先の後の目安（手の名前と年月だけ） */
  cont: string[];
  backHref: string;
  backText: string;
}

export function pathVM(a: Analysis, node: number, text: TextSource): PathVM {
  const cm = a.cm;
  const map = cm.map;
  const n = Math.max(0, Math.min(cm.n - 1, Math.floor(node)));
  const pv = walkPath(a, n, 0);
  const rows: PathRowVM[] = pv.rows.map((r) => ({
    ym: ym(map, r.m),
    move: kindName(map, kindKey(cm, r.option)),
    onPi: r.onPi,
    outcome: r.outcome >= 0 ? `${outcomeName(map, r.outcome)} ${pct(r.w)}` : null,
    monthly: `月の稼ぎ ${manMonthly(r.monthly)}`,
    cum: `ここまでの見込み ${pct1(r.cum)}`,
    stub: r.stub,
  }));
  // 戻り先: その道の今日の手の詳しい画面（今日なら見取り図）
  let first = -1;
  for (const f of cm.firstMoves) if (isUnder(cm, n, f)) first = f;
  const backHref = first >= 0 ? moveHash(kindKey(cm, first)) : OVERVIEW_HASH;
  const backText = first >= 0 ? `${moveName(map, kindKey(cm, first), (cm.flags[first]! & 1) !== 0)}へ` : "見取り図へ";
  const end = pv.end;
  const total = a.money.acc[end]! + a.pi.V[end]!;
  const vs = a.vSQ === null ? "" : `（ずっと今のままより ${manDelta(total - a.vSQ)}）`;
  const isChainFromMove = n === 0 || cm.parent[n] === 0;
  const title = isChainFromMove ? `一番ありそうな道（見込み ${pct1(pv.p)}）` : `この道（ここから先の見込み ${pct1(pv.p)}）`;
  const startYm = ym(map, cm.month[pv.pivot]!);
  const intro = `${startYm}から${ym(map, cm.H)}まで、3 か月ごとに一番良い手を選び、一番ありそうな結果をたどった道。ほかの結果やほかの手への切り替えと、カードの文章は次の版で入る。`;
  const cont: string[] = [];
  for (const c of pv.cont) cont.push(`${ym(map, c.m)} ${kindName(map, c.kind)}`);
  return {
    title,
    intro,
    rows,
    endTitle: safeName(text.title(end), "行き先"),
    endText: `${ym(map, cm.month[end]!)}・3 年の合計 ${man(total)}${vs}${pv.summary ? "・この先は標準の続きの見積もり" : ""}`,
    endNumbers: text.numbers(end),
    cont,
    backHref,
    backText,
  };
}

// ------------------------------------------------------------ 見方と前提

export interface NotesModel {
  howTo: string[];
  premises: string[];
  annual: number;
}

/** 見方（言葉の意味・数の出し方・数えていない物）と前提（地図の見出しのまま） */
export function notesVM(a: Analysis, basis: DeltaBasis, worthAvailable: boolean): NotesModel {
  const map = a.cm.map;
  const y0 = ym(map, 0);
  const yEnd = ym(map, a.cm.H);
  const howTo = [
    `${DELTA_LABEL}: 今日その手を始める場合と、この 3 か月は今のままで 3 か月後に選ぶ場合の、3 年の稼ぎの差（どちらもその後は一番良い選び方）`,
    "「今のまま」は「この 3 か月は今のまま、その後は一番良い選び方」。「ずっと今のまま」は 12 回とも今のままで、3 年の合計を比べる元",
    `3 年の合計: ${y0}から${yEnd}までの税引き前の稼ぎ（給与・広告運用・SpellDash）の合計。給与は年収 ${num(a.annual)} 万円（賞与込みの額面）から数える`,
    "分布の棒: その手の後、一番良い選び方で進んだときの行き先を見込みの重さで並べ、ずっと今のままとの差の段で色を付けた。10〜90% は、低い方と高い方の 1 割ずつを除いた幅",
    `分かれ道 = 判断（手を選ぶ時点）+ 出来事の分かれ（結果が見込み % で分かれる手）。行き先は${yEnd}に着く所で、「見込み 1% 以上」はそこへ着く見込みが 1% 以上の物`,
    `標準の続きの見積もり: 先を広げなかった手の先。標準の選び方で${yEnd}まで続けた見積もりを 1 枚にまとめた行き先`,
    basisNote(basis),
    worthAvailable
      ? `${WORTH_LABEL}: その種類の手を 3 年間ずっと使わない場合と比べた、3 年の稼ぎの差。${num(4)} 万円未満は「ほぼ差なし」`
      : "「この種類を 3 年やらない場合との差」は、計算の前提を直した木で入る（この木にはまだ無い）",
    "一番ありそうな道: 3 か月ごとに一番良い手を選び、どの分かれでも見込みの一番大きい結果をたどった 1 本の道。見込みは、その道のとおりになる見込み",
    "週の時間（手ごとに増える作業の時間）は数に入れていない。お金だけで比べている",
    "数字はどれもモデルの見積もりで、決まった未来ではない",
  ];
  const premises = (Array.isArray(map.header.premises) ? map.header.premises : []).filter((x): x is string => typeof x === "string" && x.trim() !== "");
  return { howTo, premises, annual: a.annual };
}
