// 画面に出す形（DOM を使わない。テストで確かめる）: 計算の芯の数に、単位と何の数かの言葉を付ける
//   overviewVM(a)        見取り図（今日の手ごとの行。良い順）と、その上の「10 の手をひと目で」（共通の万円の軸の 10〜90% の棒）
//   moveDetailVM(a, f)   手の詳しい画面（扇・分かれ道の帯・進め方・行き先・一番ありそうな道・真ん中あたりの道）
//   pathVM(a, i, text)   道の画面（今日から 2029 年 11 月まで 3 か月に 1 行・ほかの結果と手への切り替え・静かな期のまとめ・標準の続き）
// 設計: 作業メモ SPEC v1 §5.1〜§5.5・§5.7。作業メモ user-1〜user-14・user-20・truth-1〜truth-7・truth-18・code-1〜code-3

import {
  altStubCounts,
  assertFresh,
  destClassOf,
  destinations,
  destLabel,
  endsFrom,
  F_BASE,
  F_STUB,
  F_SUM,
  fanData,
  forkStrip,
  keepFan,
  kindKey,
  medianEnd,
  mostLikelyChain,
  overview,
  placeIn,
  planView,
  quarterSpanText,
  quarterSpanYmText,
  walkPath,
  ymSpanText,
  ROLE_E,
  ROLE_A,
  type Analysis,
  type Delta,
  type DeltaBasis,
  type Dist,
  type EndsFrom,
  type FanPoint,
  type MoveSummary,
  type Overview,
  type PathRow,
  type PathView,
  type PlanWhen,
  type TextSource,
} from "../core";
import {
  baseText,
  basisLine,
  basisNote,
  basisText,
  binColors,
  countsLine,
  countsParts,
  DELTA_LABEL,
  FRAME_TEXT,
  kindName,
  looksLikeId,
  man,
  manDelta,
  manDeltaRange,
  manMonthly,
  manMonthlyDelta,
  manRange,
  moveHash,
  moveName,
  NEAR_KEEP_NOTE,
  NEAR_KEEP_TEXT,
  num,
  outcomeName,
  OVERVIEW_HASH,
  pathHash,
  pct,
  pct1,
  placeText,
  safeName,
  shareList,
  SMALL_DELTA_TEXT,
  WORTH_LABEL,
  WORTH_NOISE,
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
  /** 差の出し方（出し方の違う差が同じ画面に並ぶときだけ。「見積もり同士の差」など）。無ければ null */
  basis: string | null;
  /** 比べる元（今のまま）の札 */
  base: boolean;
}

export interface SharePart {
  label: string;
  share: number;
}

export type DecidesVM =
  /** 事実を知る手（会社の答えなど）。note は今のままの先との近さ・差の小ささの注記 */
  | { kind: "reveal"; head: string; parts: SharePart[]; text: string; note: string | null }
  /** 今のままの先とほぼ同じ（その後のおすすめの手の違い TV < 0.1） */
  | { kind: "near"; text: string }
  /** 結果で分かれる手 */
  | { kind: "outcomes"; head: string; parts: SharePart[]; text: string; note: string | null }
  /** 比べる元 */
  | { kind: "base"; text: string }
  /** 結果が 1 つで、今のままとも違う */
  | { kind: "plain"; text: string; note: string | null };

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
  /** 3 年の合計の 10%・50%・90%（万円。ひと目の棒） */
  range: { p10: number; p50: number; p90: number } | null;
  /** 分布の見出し（列の見出しの出ない狭い画面で、何の分布かを書く） */
  distHead: string;
  /** 「3 年の合計 1,159〜1,452 万円（10〜90%・真ん中 1,269 万円）」 */
  rangeText: string | null;
  /** rangeText の区切り（折り返しは区切りの間で） */
  rangeParts: string[];
  /** 「ずっと今のままより +35〜+328 万円」 */
  vsKeepText: string | null;
  /** 比べる元の幅（「3 か月待っても +41〜+282 万円」。比べる元の行は null）（作業メモ user-1） */
  waitText: string | null;
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

/** 「10 の手をひと目で」の 1 行（作業メモ user-3） */
export interface GlanceRowVM {
  node: number;
  kind: string;
  href: string;
  name: string;
  isBase: boolean;
  isPi: boolean;
  delta: PillVM | null;
  /** 3 年の合計の 10%・50%・90%（万円）。出せなければ null */
  range: { p10: number; p50: number; p90: number } | null;
  aria: string;
}

export interface GlanceVM {
  /** 「10 の手をひと目で」 */
  title: string;
  /** 読み方 */
  sub: string;
  /** 差の出し方（どの差も同じ出し方のとき。並びの下に出す） */
  note: string | null;
  /** 共通の軸（万円） */
  lo: number;
  hi: number;
  ticks: number[];
  /** ずっと今のまま（3 年の合計・万円）。無ければ null */
  keep: number | null;
  keepLabel: string | null;
  rows: GlanceRowVM[];
}

/** 一番ありそうな道・真ん中あたりの道のボタン */
export interface ChainVM {
  node: number;
  /** その道の見込み（真ん中あたりの道は、その行き先に着く見込み） */
  p: number;
  href: string;
  text: string;
  /** ボタンの下の 1 行（3 年の合計と、行き先の分布の中の位置） */
  sub: string | null;
}

export interface OverviewVM {
  annual: number;
  rows: OverviewRowVM[];
  /** 「今日選べる 10 の手。どの手の先にも、2029 年 11 月まで 1,981〜2,489 の分かれ道が続く」 */
  lead: string;
  /** 3 年の合計の幅の読み方（見取り図の最初に出す。作業メモ user-1） */
  frame: string;
  /** どの差も同じ出し方のときの説明（出し方が混ざれば null。差ごとに札に付ける） */
  basisLine: string | null;
  glance: GlanceVM;
  /** 「一番良い選び方で進むと、3 年の稼ぎの合計は … 」 */
  headline: string | null;
  /** ずっと今のまま（比べる帯） */
  keep: { label: string; text: string; bins: number[] | null } | null;
  basis: DeltaBasis;
  basisNote: string;
  /** 「この種類を 3 年やらない場合との差」が無い版の注記 */
  worthNote: string | null;
  /** 「この種類を 3 年やらない場合との差」をほぼ差なしとする大きさ（万円） */
  worthNoise: number;
  /** 地図の終わりの年月（「2029 年 11 月」） */
  endYm: string;
  /** 今日から一番ありそうな道 */
  chain: ChainVM | null;
  /** 今日から真ん中あたりの道 */
  median: ChainVM | null;
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

/**
 * その手で分かること。「今のままの先とほぼ同じ・近い」は、その後のおすすめの手の違い（TV）が 0.1 未満のときだけ言う。
 * 差が 5 万円未満でも TV が 0.1 以上なら、3 年の稼ぎが近いだけで、この先の選び方は違うと書く（作業メモ truth-2）
 */
function decidesOf(a: Analysis, mv: MoveSummary, basis: DeltaBasis): DecidesVM {
  const map = a.cm.map;
  if (mv.isBase) return { kind: "base", text: baseText(basis) };
  const small = mv.smallDelta && !mv.nearKeep ? SMALL_DELTA_TEXT : null;
  if (mv.reveals) {
    const parts = mv.reveals.answers.map((g) => ({ label: safeName(g.label, "答え"), share: g.share }));
    const head = mv.reveals.label;
    return { kind: "reveal", head, parts, text: `${head}: ${shareList(parts)}`, note: mv.nearKeep ? NEAR_KEEP_NOTE : small };
  }
  if (mv.nearKeep) return { kind: "near", text: NEAR_KEEP_TEXT };
  if (mv.outcomes.length >= 2) {
    const parts = mv.outcomes.map((o) => ({ label: outcomeName(map, o.node), share: o.w }));
    const m = a.cm.month[mv.outcomes[0]!.node]!;
    const head = `${ym(map, m)}の結果`;
    return { kind: "outcomes", head, parts, text: `${head}: ${shareList(parts)}`, note: small };
  }
  return { kind: "plain", text: "この手の結果は 1 つ（その後の選び方で分かれる）", note: small };
}

/** 差の札。basisShown は差ごとに出し方を書くとき（出し方が混ざる画面） */
function deltaPill(mv: MoveSummary, basisShown: boolean): PillVM | null {
  if (mv.isBase) return { label: DELTA_LABEL, text: "比べる元", bin: 0, basis: null, base: true };
  if (!mv.delta) return null;
  return { label: DELTA_LABEL, text: manDelta(mv.delta.d), bin: binColors(mv.delta.d).bin, basis: basisShown ? basisText(mv.delta.basis) : null, base: false };
}

/** この種類を 3 年やらない場合との差の札（誤差の範囲・マイナスは「ほぼ差なし」で色を付けない） */
function worthPill(mv: MoveSummary, noise: number): PillVM | null {
  if (mv.isBase || mv.worth === null) return null;
  const text = worthText(mv.worth, noise);
  return { label: WORTH_LABEL, text, bin: text === "ほぼ差なし" ? 0 : binColors(mv.worth).bin, basis: null, base: false };
}

/** 今日の手の差が全部同じ出し方か（同じなら札ごとに出し方を書かない） */
function uniformBasis(ov: Overview): DeltaBasis | null {
  const bs = new Set(ov.moves.filter((m) => !m.isBase && m.delta).map((m) => m.delta!.basis));
  return bs.size === 1 ? [...bs][0]! : bs.size === 0 ? ov.basis.delta : null;
}

export function overviewRowVM(a: Analysis, ov: Overview, mv: MoveSummary): OverviewRowVM {
  const map = a.cm.map;
  const endYm = ym(map, a.cm.H);
  const name = moveName(map, mv.kind, mv.isBase);
  const delta = deltaPill(mv, uniformBasis(ov) === null);
  const worth = worthPill(mv, ov.worthNoise ?? WORTH_NOISE);
  const { rangeText, rangeParts, vsKeepText } = distTexts(mv.dist, ov.vSQ);
  const baseMv = ov.moves.find((m) => m.isBase) ?? null;
  const waitText = !mv.isBase && baseMv?.dist && ov.vSQ !== null ? `3 か月待っても ${manDeltaRange(baseMv.dist.p10 - ov.vSQ, baseMv.dist.p90 - ov.vSQ)}` : null;
  const decides = decidesOf(a, mv, ov.basis.delta);
  const strip = stripOf(a, mv.node);
  const forksText = `この先の分かれ道 ${num(mv.counts.forks)}`;
  const countsText = countsLine(mv.counts, endYm);
  const countsParts_ = countsParts(mv.counts, endYm);
  const via = mv.dist?.viaSummary ?? 0;
  const summaryText = via > 0.005 ? `3 年の合計の ${pct(via)} は標準の続きの見積もり` : null;
  const decNote = decides.kind === "reveal" || decides.kind === "outcomes" || decides.kind === "plain" ? decides.note : null;
  const aria = [
    name,
    mv.isPi ? "一番良い手" : null,
    delta ? `${delta.label} ${delta.text}${delta.basis ? `（${delta.basis}）` : ""}` : null,
    worth ? `${worth.label} ${worth.text}` : null,
    rangeText,
    vsKeepText,
    waitText,
    decides.text,
    decNote,
    forksText,
    countsText,
  ]
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
    range: mv.dist ? { p10: mv.dist.p10, p50: mv.dist.p50, p90: mv.dist.p90 } : null,
    distHead: "3 年の合計の分布（この手の後、一番良い選び方で）",
    rangeText,
    rangeParts,
    vsKeepText,
    waitText,
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

/** 一番ありそうな道と真ん中あたりの道のボタン（x から先の行き先を 1 回だけ数えて両方に使う） */
function chainsOf(a: Analysis, x: number, where: string, prefix: string): { chain: ChainVM | null; median: ChainVM | null } {
  const ends = endsFrom(a, x);
  return { chain: chainOf(a, x, where, prefix, ends), median: medianOf(a, x, where, prefix, ends) };
}

/** 一番ありそうな道のボタン（x から下。3 年の合計と、x から先の行き先の中の位置を添える） */
function chainOf(a: Analysis, x: number, where: string, prefix: string, ends: EndsFrom): ChainVM | null {
  if (!a.pi.def[x]) return null;
  const ch = mostLikelyChain(a, x);
  if (ch.nodes.length <= 1) return null;
  const end = ch.nodes[ch.nodes.length - 1]!;
  const total = a.money.acc[end]! + a.pi.V[end]!;
  const pl = (a.cm.flags[end]! & F_SUM) === 0 ? placeIn(ends, total) : null;
  const sub = `3 年の合計 ${man(total)}${pl ? `・${where}の中で${placeText(pl.p)}（真ん中 ${man(pl.p50)}）` : ""}`;
  return { node: x, p: ch.p, href: pathHash(a.cm.map, x), text: `${prefix}一番ありそうな道（見込み ${pct1(ch.p)}）`, sub };
}

/** 真ん中あたりの道のボタン（x から先の行き先のうち、3 年の合計が真ん中あたりで見込みの一番大きい行き先までの道） */
function medianOf(a: Analysis, x: number, where: string, prefix: string, ends: EndsFrom): ChainVM | null {
  const m = medianEnd(a, x, ends);
  if (!m) return null;
  return {
    node: m.node,
    p: m.mass,
    href: pathHash(a.cm.map, m.node),
    text: `${prefix}真ん中あたりの道（3 年の合計 ${man(m.total)}）`,
    sub: `${where}のうち、3 年の合計が真ん中あたりに着く道で見込みの一番大きい物（その行き先に着く見込み ${pct1(m.mass)}）`,
  };
}

/** 「10 の手をひと目で」（共通の万円の軸に、どの手も 10〜90% の棒と真ん中の線。ずっと今のままの線） */
function glanceOf(ov: Overview, rows: readonly OverviewRowVM[], basis: DeltaBasis | null): GlanceVM {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    if (!r.range) continue;
    lo = Math.min(lo, r.range.p10);
    hi = Math.max(hi, r.range.p90);
  }
  if (ov.vSQ !== null) {
    lo = Math.min(lo, ov.vSQ);
    hi = Math.max(hi, ov.vSQ);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) (lo = 0), (hi = 1);
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step - 1e-9) * step;
  hi = Math.ceil(hi / step + 1e-9) * step;
  if (hi - lo < 1e-9) hi = lo + step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  const glanceRows: GlanceRowVM[] = rows.map((r) => ({
    node: r.node,
    kind: r.kind,
    href: r.href,
    name: r.name,
    isBase: r.isBase,
    isPi: r.isPi,
    delta: r.delta,
    range: r.range,
    aria: [
      r.name,
      r.delta ? `${r.delta.label} ${r.delta.text}` : null,
      r.range ? `3 年の合計 ${manRange(r.range.p10, r.range.p90)}（10〜90%）・真ん中 ${man(r.range.p50)}` : null,
      ov.vSQ !== null ? `ずっと今のまま ${man(ov.vSQ)}` : null,
      "押すとこの手の詳しい画面",
    ]
      .filter((x): x is string => !!x)
      .join("。"),
  }));
  const keepLabel = ov.vSQ !== null ? `ずっと今のまま ${man(ov.vSQ)}` : null;
  return {
    title: `${num(rows.length)} の手をひと目で`,
    sub: `札は${DELTA_LABEL}。棒はその手の後の 3 年の合計（万円）の 10〜90%、白い線は真ん中${ov.vSQ !== null ? "、点線はずっと今のまま" : ""}`,
    note: basis ? basisLine(basis) : null,
    lo,
    hi,
    ticks,
    keep: ov.vSQ,
    keepLabel,
    rows: glanceRows,
  };
}

export function overviewVM(a: Analysis, ov: Overview = overview(a)): OverviewVM {
  assertFresh(a);
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
  const keepSpread = !!ov.keep && Math.abs(ov.keep.p90 - ov.keep.p10) > 0.05;
  if (ov.today && ov.vSQ !== null) {
    const t = ov.today;
    headline = `一番良い選び方で進むと、3 年の稼ぎの合計は ${manRange(t.p10, t.p90)}（10〜90%）、平均 ${man(t.mean)}。ずっと今のままなら ${keepSpread ? manRange(ov.keep!.p10, ov.keep!.p90) : man(ov.vSQ)}`;
  }
  const keep =
    ov.keep && ov.vSQ !== null
      ? {
          label: "ずっと今のまま（12 回とも今のまま）",
          text: keepSpread ? `3 年の合計 ${manRange(ov.keep.p10, ov.keep.p90)}（真ん中 ${man(ov.keep.p50)}）` : `3 年の合計 ${man(ov.vSQ)}（ずっと今のままは分かれが無い）`,
          bins: ov.keep.bins,
        }
      : null;
  const basis = uniformBasis(ov);
  return {
    annual: a.annual,
    rows,
    lead,
    frame: FRAME_TEXT,
    basisLine: basis ? basisLine(basis) : null,
    glance: glanceOf(ov, rows, basis),
    headline,
    keep,
    basis: ov.basis.delta,
    basisNote: basisNote(ov.basis.delta),
    worthNote: ov.basis.worth ? null : "「この種類を 3 年やらない場合との差」は、計算の前提を直した地図で入る",
    worthNoise: ov.worthNoise ?? WORTH_NOISE,
    endYm,
    ...chainsOf(a, 0, "今日からの道", "今日から"),
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

/** raw 以上のきりの良い刻み（1・2・2.5・5 × 10 の何乗か） */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw - 1e-12) ?? 10 * mag;
}

/** 軸のきりの良い目盛り（lo〜hi を max 個くらいに） */
export function niceTicks(lo: number, hi: number, max = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep((hi - lo) / Math.max(1, max));
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
  /** そうなる理由（「2027 年 2 月に転職せずなら」「遊ぶ人を増やすの後」）。今日の手・理由の無い手は null */
  cond: string | null;
  /** 標準の続きの見積もりの手の割合の注記（ふつう null） */
  stubText: string | null;
}

export interface PlanRowVM {
  m: number;
  /** 「2027 年 2 月」 */
  ym: string;
  /** 「3 月〜5 月の手」（判断の次の月から 3 か月） */
  span: string;
  /** 上から出す手（PLAN_MOVES まで） */
  moves: PlanMoveVM[];
  /** 残りの手（開くと同じ形で出す。作業メモ user-8） */
  rest: PlanMoveVM[];
  /** 残りの手の見出し（「ほか 2 つの手 6%」）。無ければ null */
  more: string | null;
  /** その時点で続いている道・標準の続きの注記 */
  note: string | null;
}

export const PLAN_MOVES = 3;

/**
 * そうなる理由の言葉（作業メモ user-7・truth-5）:
 *   前の手で分ける・その手の結果を全部含む  「遊ぶ人を増やすの後」（2 期以上前は「2027 年 5 月の遊ぶ人を増やすの後」）
 *   結果で分ける                          「2027 年 2 月に転職せずなら」（手が 2 つ以上なら「…に顧客 1 社（副業の顧客を 1 社増やす）・…なら」）
 * 理由で覆えない残りがあれば頭に「主に」
 */
export function condText(a: Analysis, w: PlanWhen | null): string | null {
  if (!w || !w.items.length) return null;
  const map = a.cm.map;
  const afters: string[] = [];
  const ifs: string[] = [];
  const named = w.items.filter((it) => !it.all).length >= 2;
  for (const it of w.items) {
    if (it.all) {
      const t = `${w.back > 0 ? `${ym(map, it.mFrom)}の` : ""}${kindName(map, it.fromKind)}の後`;
      if (!afters.includes(t)) afters.push(t);
      continue;
    }
    const labs = it.labels.map((l) => safeName(l, "その結果")).join("・");
    ifs.push(named ? `${labs}（${kindName(map, it.fromKind)}）` : labs);
  }
  const parts: string[] = [];
  if (afters.length) parts.push(afters.join("・"));
  // 英字で始まる結果の名前の前は 1 字あける（「2027 年 2 月に SpellDash だけなら」）
  if (ifs.length) parts.push(`${ym(map, w.m)}に${/^[A-Za-z0-9]/.test(ifs[0]!) ? " " : ""}${ifs.join("・")}なら`);
  if (!parts.length) return null;
  // 理由で覆えない残りがあれば「主に」（その手になる道の大部分の理由）
  return (w.cover < 0.995 ? "主に " : "") + parts.join("／");
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
    const all: PlanMoveVM[] = q.moves.map((mv) => ({
      kind: mv.kind,
      name: q.m === 0 ? moveName(map, mv.kind, (a.cm.flags[f]! & F_BASE) !== 0) : kindName(map, mv.kind),
      share: mv.share,
      shareText: pct(mv.share),
      cond: q.m === 0 ? null : condText(a, mv.when),
      stubText: mv.stub > 0.005 ? `${pct(mv.stub)} は標準の続きの見積もり` : null,
    }));
    // 同じ理由が 2 つの手に付いたら、どちらにも出さない（手を分ける理由になっていない）
    const seen = new Map<string, number>();
    for (const m of all) if (m.cond) seen.set(m.cond, (seen.get(m.cond) ?? 0) + 1);
    for (const m of all) if (m.cond && seen.get(m.cond)! > 1) m.cond = null;
    const rest = all.slice(PLAN_MOVES);
    const restShare = rest.reduce((s, x) => s + x.share, 0);
    const notes: string[] = [];
    if (q.m > 0 && q.alive < 0.995 && q.alive + q.viaSummary > 0) notes.push(`この時点で判断がある道 ${pct(q.alive)}`);
    if (q.viaSummary > 0.005) notes.push(`${pct(q.viaSummary)} は標準の続きの見積もりの中`);
    rows.push({
      m: q.m,
      ym: q.m === 0 ? "今日" : ym(map, q.m),
      span: span(q.m),
      moves: all.slice(0, PLAN_MOVES),
      rest,
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
  /** いくつかの場合をまとめた行き先（顧客の数に幅）の割合の注記（作業メモ truth-3） */
  mergedText: string | null;
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
    mergedText: g.merged > 0.005 ? `${pct(g.merged)} は、いくつかの場合をまとめた道（顧客の数の見込みで分けた）` : null,
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
  /** 「今日の手・2026 年 12 月〜2027 年 2 月」（手は判断の次の月から 3 か月） */
  eyebrow: string;
  /** 3 年の合計の幅の読み方（作業メモ user-1） */
  frame: string;
  /** どの差も同じ出し方のときの説明（混ざれば null） */
  basisLine: string | null;
  /** まとめの数（3 年の合計とその内訳・分かれ道・行き先・先を広げていない手） */
  facts: string[];
  /** この手の結果（3 か月後） */
  outcomesHead: string;
  outcomes: OutcomeVM[];
  chain: ChainVM | null;
  median: ChainVM | null;
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

/**
 * 3 年の合計の平均を、この手の分と、3 か月待ってから一番良い選び方をしても出る分に分ける（作業メモ user-1）:
 * 平均 − ずっと今のまま = （この手 − この 3 か月は今のまま）+（この 3 か月は今のまま − ずっと今のまま）。どちらも地図の値
 */
function meanSplitText(ov: Overview, mv: MoveSummary): string | null {
  const d = mv.dist;
  if (!d || ov.vSQ === null) return null;
  const total = d.mean - ov.vSQ;
  if (mv.isBase) return `ずっと今のままより平均 ${manDelta(total)}（3 か月待ってから一番良い選び方で進む分）`;
  if (mv.deltaTree === null) return `ずっと今のままより平均 ${manDelta(total)}`;
  const own = mv.deltaTree;
  const later = total - own;
  const q = mv.delta && mv.delta.basis === "q" && Math.abs(mv.delta.d - own) >= 0.05 ? `（この手の分は地図の値。上の札は見積もり同士の差で ${manDelta(mv.delta.d)}）` : "";
  return `ずっと今のままより平均 ${manDelta(total)} ＝ この手の分 ${manDelta(own)} ＋ 3 か月待っても出る分 ${manDelta(later)}${q}`;
}

export function moveDetailVM(a: Analysis, f: number, ov: Overview = overview(a)): MoveDetailVM {
  assertFresh(a);
  const cm = a.cm;
  const map = cm.map;
  if (cm.parent[f] !== 0 || cm.role[f] !== ROLE_A) throw new RangeError(`今日の手ではありません: ${f}`);
  const mv = ov.moves.find((m) => m.node === f)!;
  const row = overviewRowVM(a, ov, mv);
  const endYm = ym(map, cm.H);
  let eyebrow = "今日の手";
  try {
    eyebrow = `今日の手・${quarterSpanYmText(map.header.anchor, 0)}`;
  } catch {
    /* 年月が読めない */
  }
  const facts: string[] = [];
  const d = mv.dist;
  if (d && a.vSQ !== null) facts.push(`3 年の合計（この手の後、一番良い選び方で）: ${manRange(d.p10, d.p90)}（10〜90%）・平均 ${man(d.mean)}`);
  const split = meanSplitText(ov, mv);
  if (split) facts.push(split);
  facts.push(`この先の分かれ道 ${num(mv.counts.forks)}（判断 ${num(mv.counts.decisions)} 回・出来事の分かれ ${num(mv.counts.splits)}）`);
  facts.push(`${endYm}の行き先 ${num(mv.counts.reachEnds)}（見込み 1% 以上 ${num(mv.counts.reachEnds1)}）・標準の続きの見積もり ${num(mv.counts.sumEnds)}`);
  const alt = altStubCounts(a, f);
  if (alt.options > 0 && alt.stubs > 0)
    facts.push(`おすすめの道の判断で選べるほかの手 ${num(alt.options)} のうち ${num(alt.stubs)}（${pct(alt.stubs / alt.options)}）は先を広げていない（${endYm}まで標準の続きの見積もり）`);
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
  const basis = uniformBasis(ov);
  return {
    row,
    endYm,
    eyebrow,
    frame: FRAME_TEXT,
    basisLine: basis ? basisLine(basis) : null,
    facts,
    outcomesHead,
    outcomes,
    ...chainsOf(a, f, "この手の後の道", ""),
    fan: fanVM(a, f),
    strip: stripVM(a, f),
    plan: planVM(a, f),
    dest: destVM(a, f),
  };
}

// ------------------------------------------------------------ 道の画面（§5.4・§5.5）
// 今日から 2029 年 11 月まで、3 か月に 1 行の縦の道。行 = 判断の年月・選ぶ手・結果と見込み・結果の月の月の稼ぎ・ここまでの稼ぎ。
// 行を開くと、その 3 か月の文章（TextSource）と数字の行・やること、ほかの結果（見込み）とほかの手（この道の手との差）が出る。
// ほかを押すとそのカードの道（#path-t<鍵の短い名前>）に切り替わる: 切り替えた所から先は一番ありそうな道（walkPath）。
// 続けて同じ手の静かな期は 1 行にまとめ（groupRows）、まとめた手の後は標準の続き（cont）を薄い行で出す（先頭に見積もりの印の行）。
// まとめた手を通る道は、見込みを「標準の続きに入るまでの見込み」と書き、着いた所の数は多くの道の平均と書く（作業メモ truth-1・user-6）。

export interface PathAltVM {
  /** 切り替え先のカード */
  node: number;
  href: string;
  name: string;
  /** 結果の見込み（「20%」）。手は null */
  shareText: string | null;
  /** 結果の後、一番良い選び方で進んだ 3 年の合計の見込み（「3 年の合計の見込み 1,431 万円」）。手は null */
  valueText: string | null;
  /** 差の札（結果: この道の結果との 3 年の合計の差・手: この道の手との差）。この道の物・数が出せない物は null */
  diffText: string | null;
  /** 差の色の段（−4〜+4） */
  bin: number;
  /** この道の物（押せない） */
  current: boolean;
  /** まとめた手（この先は標準の続きの見積もり） */
  stub: boolean;
  /** 印（「おすすめ」「標準の続きの見積もり」など） */
  tags: string[];
  aria: string;
}

/** 選べる手の並びの区切り（この先も読める手・この先は見積もりの手。作業メモ user-5） */
export interface PathAltGroupVM {
  /** 区切りの見出し（区切りが 1 つなら null） */
  head: string | null;
  items: PathAltVM[];
}

export interface PathCardVM {
  /** 「この 3 か月（12 月〜2 月）」「2027 年 2 月の結果（見込み 45%）」 */
  head: string;
  title: string;
  /** 数字の行（年収・広告運用・有料・遊ぶ人・週の時間） */
  numbers: string[];
  body: string;
  /** やること（手のカードと、標準の続きの期のカード） */
  todo: string[];
  /** 本文の下の数（「今日からここまでの見込み 45%」など） */
  facts: string[];
  /** 見積もりの文章（まとめた手の後の標準の続きの 1 期）。見出しに「見積もり」の印を付ける */
  est?: boolean;
}

export interface PathStepDetailVM {
  move: PathCardVM;
  /** 結果のカード（まとめた手は null: 着いた所は道の終わりのカードに出す） */
  outcome: PathCardVM | null;
  /** まとめた手の注記 */
  note: string | null;
}

export interface PathStepVM {
  /** 行の鍵（判断のカードから。切り替えても同じ行は同じ鍵） */
  key: string;
  /** 道の中の何行目か（0 から） */
  index: number;
  decision: number;
  option: number;
  outcome: number;
  m: number;
  /** 判断の年月（「2027 年 2 月」） */
  ym: string;
  /** 手の 3 か月（「3 月〜5 月の手」） */
  span: string;
  /** 選ぶ手の名前 */
  move: string;
  onPi: boolean;
  /** 一番ありそうな道から外れた所（おすすめでない手か、見込みの一番大きくない結果。今日の手の行の手は除く） */
  off: boolean;
  /** 道を切り替えた行 */
  pivot: boolean;
  /** まとめた手（この先は標準の選び方で続けた見積もり） */
  stub: boolean;
  /** 「SpellDash だけ 45%」（結果が 1 つの手は null） */
  outcomeText: string | null;
  /** お金の行の年月（結果の月。「2027 年 2 月」。まとめた手は null）（作業メモ user-12） */
  moneyAt: string | null;
  /** 「月の稼ぎ 30.8 万円」（まとめた手は null） */
  monthlyText: string | null;
  /** 前の行からの月の稼ぎの差（「+1.0 万円」。変わらなければ null） */
  monthlyDiff: string | null;
  /** 「ここまでの稼ぎ 181 万円」（まとめた手は null） */
  runningText: string | null;
  /** 「ほかの結果 2・ほかの手 3」（ほかが無ければ null。読み上げ用） */
  altText: string | null;
  /** 閉じた行に出すほかの結果（「昇格 30%」「全部可 20%・どちらも不可 35%」）。無ければ null */
  altOutcomesText: string | null;
  /** その区切り（「全部可 20%」ごと。折り返しは区切りの間で） */
  altOutcomeParts: string[];
  /** 閉じた行に出すほかの手の数（「ほかの手 3（どれも先は見積もり）」）。無ければ null */
  altOptionsText: string | null;
  /** この手の結果の並びの見出し（結果が 1 つなら null） */
  outcomesHead: string | null;
  /** この手の結果（この道の物を含む・並べる順） */
  outcomes: PathAltVM[];
  optionsHead: string;
  /** この判断で選べる手（この道の手を含む・この先も読める手が先、それぞれ差の大きい順） */
  options: PathAltVM[];
  /** options の区切り */
  optionGroups: PathAltGroupVM[];
  /** 「次の 3 か月へ（2027 年 5 月）」・最後の行は「着いた所へ（2029 年 11 月）」 */
  nextText: string;
  aria: string;
  /** 文章・数字の行・やること（開いたときに作る。同じ物を返す） */
  detail(): PathStepDetailVM;
}

export type PathItemVM =
  | { type: "step"; step: PathStepVM }
  | {
      type: "group";
      key: string;
      /** 「2027 年 8 月〜11 月」 */
      ym: string;
      /** 「転職活動を続ける（2 期・転職せず）」 */
      title: string;
      /** 「2 期とも転職せず 76%」（結果が 1 つの手なら null） */
      outcomeText: string | null;
      /** お金の行の年月（最後の期の結果の月） */
      moneyAt: string | null;
      monthlyText: string | null;
      runningText: string | null;
      steps: PathStepVM[];
      off: boolean;
      pivot: boolean;
      aria: string;
    }
  /**
   * まとめた手の後の標準の続き（薄い行）。head は見積もりの印の行（cont の行の前に 1 つ）。
   * 文章の作り手が標準の続きの文章（TextSource.cont）を持てば、cont の行は押して開ける（detail はその期の文章。開いたときに作り、
   * 同じ物を返す。文章が無ければ null）。開けない行は detail も null
   */
  | {
      type: "light";
      key: string;
      ym: string;
      title: string;
      note: string | null;
      head: boolean;
      /** 開ける行の読み上げ（開けない行は空） */
      aria: string;
      /** 開いた行の「次の 3 か月へ（2028 年 2 月・見積もり）」・最後の行は「着いた所へ（2029 年 11 月）」（開けない行は null） */
      nextText: string | null;
      detail: (() => PathCardVM | null) | null;
    };

export interface PathFigureVM {
  label: string;
  value: string;
  sub: string | null;
  /** 2 つ目の注記（3 年の合計が行き先の分布のどこか・その訳） */
  note: string | null;
}

export interface PathEndVM {
  node: number;
  /** 「2029 年 11 月に着く所」 */
  head: string;
  /** 行き先の種類（「会社員・SpellDash だけ可・副業なし・有料 30〜99 人」） */
  cls: string;
  /** カードの題名（種類と同じなら null） */
  title: string | null;
  numbers: string[];
  body(): string;
  /** 「3 年の合計 1,159 万円（ずっと今のままより +35 万円）」「この道の見込み 6.4%」 */
  facts: string[];
  summary: boolean;
  /** まとめた行き先の注記（作業メモ user-20） */
  note: string | null;
}

export interface PathStartVM {
  key: string;
  ym: string;
  title: string;
  numbers: string[];
  monthlyText: string;
  body(): string;
}

/** 道の月の稼ぎの線（見出しの小さな線）。まとめた手の後は見積もり（est） */
export interface PathSparkVM {
  path: Array<{ m: number; v: number; est: boolean }>;
  keep: Array<{ m: number; v: number }>;
  /** 点の年月（0・3・…・36） */
  yms: string[];
  /** 0〜36 か月目 */
  months: number[];
  label: string;
  /** ずっと今のままの線の名前（分かれがあれば「ずっと今のまま（真ん中）」） */
  keepLabel: string;
}

export interface PathVM {
  /** 道を決めたカード */
  node: number;
  title: string;
  eyebrow: string;
  intro: string;
  figures: PathFigureVM[];
  /** 一番ありそうな道と違う所（「2027 年 5 月の結果: 昇格 30%」） */
  offs: string[];
  resetHref: string | null;
  resetText: string;
  backHref: string;
  backText: string;
  readText: string;
  start: PathStartVM;
  items: PathItemVM[];
  /** 行（並び順。「次の 3 か月へ」で順に開く） */
  steps: PathStepVM[];
  end: PathEndVM;
  spark: PathSparkVM;
  /** 最初から開いておく行・まとめの鍵（切り替えた行。今日の手の道は空） */
  defaultOpen: string[];
  /** まとめた手を通る道（この先は標準の続き） */
  summary: boolean;
  /** 文章が仮（地図の数だけで作った物）。本文ごとに「文章は仮」と出す（作業メモ user-4） */
  provisional: boolean;
}

/** 本文が仮のときの印 */
export const PROVISIONAL_TEXT = "文章は仮（地図の数だけから作った短い説明。具体的な文章はこれから入る）";

const keepFanMemo = new WeakMap<Analysis, FanPoint[]>();
function keepFanOf(a: Analysis): FanPoint[] {
  let k = keepFanMemo.get(a);
  if (!k) keepFanMemo.set(a, (k = keepFan(a)));
  return k;
}

/** 印の言葉 */
const TAG_PI = "おすすめ";
const TAG_STUB = "この先は標準の続きの見積もり";
const TAG_CURRENT_OPT = "この道の手";
const TAG_CURRENT_OUT = "この道";

function stepKey(decision: number): string {
  return `s${decision}`;
}

/** 道の 1 行の画面の形 */
function stepVM(a: Analysis, pv: PathView, r: PathRow, k: number, text: TextSource, prevMonthly: number, markRow: number): PathStepVM {
  const cm = a.cm;
  const map = cm.map;
  const anchor = map.header.anchor;
  const endYm = ym(map, cm.H);
  const isBase = (cm.flags[r.option]! & F_BASE) !== 0;
  const move = moveName(map, kindKey(cm, r.option), isBase);
  const nOut = cm.kidOff[r.option + 1]! - cm.kidOff[r.option]!;
  const split = nOut >= 2;
  const yms = ym(map, r.m);
  let span = "";
  try {
    span = `${quarterSpanText(anchor, r.m)}の手`;
  } catch {
    /* 年月が読めない */
  }
  const outcomeText = r.outcome >= 0 && split ? `${outcomeName(map, r.outcome)} ${pct(r.w)}` : null;
  const moneyAt = r.stub ? null : ym(map, Math.min(cm.H, r.mNext));
  const monthlyText = r.stub ? null : `月の稼ぎ ${manMonthly(r.monthly)}`;
  const monthlyDiff = r.stub ? null : manMonthlyDelta(r.monthly - prevMonthly);
  const runningText = r.stub ? null : `ここまでの稼ぎ ${man(r.acc)}`;
  const off = (k > 0 && !r.onPi) || !r.likely;
  // この手の結果（この道の物を含む）
  const outcomes: PathAltVM[] = [];
  if (split) {
    for (let s = cm.kidOff[r.option]!; s < cm.kidOff[r.option + 1]!; s++) {
      const c = cm.kids[s]!;
      const current = c === r.outcome;
      const total = a.money.acc[c]! + a.pi.V[c]!;
      const diff = total - r.total;
      const name = outcomeName(map, c);
      const share = pct(cm.w[c]!);
      const tags = (cm.flags[c]! & F_SUM) !== 0 ? ["標準の続きの見積もり"] : [];
      if (current) tags.unshift(TAG_CURRENT_OUT);
      const valueText = `3 年の合計の見込み ${man(total)}`;
      outcomes.push({
        node: c,
        href: pathHash(map, c),
        name,
        shareText: share,
        valueText,
        diffText: current ? null : manDelta(diff),
        bin: current ? 0 : binColors(diff).bin,
        current,
        stub: false,
        tags,
        aria: current ? `${name} ${share}（この道）。${valueText}` : `${name} ${share}。${valueText}（この道の結果より ${manDelta(diff)}）。押すとこの結果の道に切り替える`,
      });
    }
  }
  // この判断で選べる手（この道の手を含む）。この先も読める手が先、まとめた手（この先は見積もり）が後。それぞれこの道の手との差の大きい順
  const deltas = new Map<number, Delta | null>();
  for (const o of r.altOptions) deltas.set(o.node, o.delta);
  const bases = new Set<string>();
  for (const o of r.altOptions) if (o.delta) bases.add(o.delta.basis);
  const mixed = bases.size > 1;
  const optNodes: number[] = [];
  for (let s = cm.kidOff[r.decision]!; s < cm.kidOff[r.decision + 1]!; s++) optNodes.push(cm.kids[s]!);
  const dOf = (j: number): number => (j === r.option ? 0 : (deltas.get(j)?.d ?? -Infinity));
  const stubOf = (j: number): number => ((cm.flags[j]! & F_STUB) !== 0 ? 1 : 0);
  optNodes.sort((x, y) => stubOf(x) - stubOf(y) || dOf(y) - dOf(x) || cm.rank[x]! - cm.rank[y]!);
  const options: PathAltVM[] = optNodes.map((j) => {
    const current = j === r.option;
    const d = current ? null : (deltas.get(j) ?? null);
    const jBase = (cm.flags[j]! & F_BASE) !== 0;
    const stub = stubOf(j) === 1;
    const name = moveName(map, kindKey(cm, j), jBase);
    const tags: string[] = [];
    if (current) tags.push(TAG_CURRENT_OPT);
    if (r.piOption === j) tags.push(TAG_PI);
    if (stub) tags.push(TAG_STUB);
    if (mixed && d) tags.push(basisText(d.basis));
    const diffText = current ? null : d ? manDelta(d.d) : "差を出せない";
    return {
      node: j,
      href: pathHash(map, j),
      name,
      shareText: null,
      valueText: null,
      diffText,
      bin: d ? binColors(d.d).bin : 0,
      current,
      stub,
      tags,
      aria: current
        ? `${name}（この道の手）${r.piOption === j ? "・おすすめ" : ""}`
        : `${name}${r.piOption === j ? "（おすすめ）" : ""}${stub ? "（この先は標準の続きの見積もり）" : ""}。この道の手との 3 年の合計の差 ${diffText}。押すとこの手の道に切り替える`,
    };
  });
  const openOpts = options.filter((o) => !o.stub);
  const stubOpts = options.filter((o) => o.stub);
  const optionGroups: PathAltGroupVM[] =
    openOpts.length && stubOpts.length
      ? [
          { head: "この先も 3 か月ごとに読める手", items: openOpts },
          { head: `この先は ${endYm}まで標準の続きの見積もりの手`, items: stubOpts },
        ]
      : [{ head: stubOpts.length && !openOpts.length ? `どの手も、この先は ${endYm}まで標準の続きの見積もり` : null, items: options }];
  const optionsHead = `${yms}に選べる手（この道の手との 3 年の合計の差）`;
  const outcomesHead = split ? (r.stub ? `この手の結果（${endYm}まで続けた見積もり）` : `この手の結果（${ym(map, r.mNext)}に分かる・この道との 3 年の合計の差）`) : null;
  const nAltOut = Math.max(0, outcomes.length - 1);
  const altOutcomeParts = outcomes.filter((o) => !o.current).map((o) => `${o.name} ${o.shareText ?? ""}`.trim());
  const nAltOpt = r.altOptions.length;
  const nAltStub = r.altOptions.filter((o) => o.stub).length;
  const altOptionsText = nAltOpt ? `ほかの手 ${num(nAltOpt)}${nAltStub === nAltOpt ? "（どれも先は見積もり）" : nAltStub > 0 ? `（うち ${num(nAltStub)} は先が見積もり）` : ""}` : null;
  const altParts = [nAltOut ? `ほかの結果 ${num(nAltOut)}` : null, altOptionsText].filter((x): x is string => !!x);
  const next = pv.rows[k + 1];
  const nextText = next ? `次の 3 か月へ（${ym(map, next.m)}）` : `着いた所へ（${ym(map, cm.month[pv.end]!)}）`;
  const pivot = markRow === k;
  let memo: PathStepDetailVM | null = null;
  const detail = (): PathStepDetailVM => {
    if (memo) return memo;
    let qs = "";
    try {
      qs = `（${quarterSpanText(anchor, r.m)}）`;
    } catch {
      /* 年月が読めない */
    }
    const moveCard: PathCardVM = {
      head: `この 3 か月${qs}`,
      title: safeName(text.title(r.option), move),
      numbers: text.numbers(r.option),
      body: text.body(r.option),
      todo: map
        .todo(r.option)
        .map((t) => t.text.trim())
        .filter((t) => t && !looksLikeId(t)),
      facts: [],
    };
    let outCard: PathCardVM | null = null;
    let note: string | null = null;
    if (r.stub)
      note = pv.cont.length
        ? `この手の先は、標準の選び方で ${endYm}まで続けた見積もり。下の薄い行は、その代表の 1 本の手（一番ありそうな出来事をたどった例）。着いた所の数は多くの道の平均で、道の終わりに出す`
        : `この手の先は、標準の選び方で ${endYm}まで続けた見積もり（3 か月ごとの手と結果には分けていない）。着いた所の数は多くの道の平均で、道の終わりに出す`;
    else if (r.outcome >= 0) {
      outCard = {
        head: `${ym(map, r.mNext)}の結果${split ? `（見込み ${pct(r.w)}）` : ""}`,
        title: safeName(text.title(r.outcome), outcomeName(map, r.outcome)),
        numbers: text.numbers(r.outcome),
        body: text.body(r.outcome),
        todo: [],
        facts: [`今日からここまでの見込み ${pct1(r.cum)}`, `ここから一番良い選び方で進んだ 3 年の合計の見込み ${man(r.total)}`],
      };
    }
    return (memo = { move: moveCard, outcome: outCard, note });
  };
  const aria = [
    `${yms}（${span}）`,
    `${move}${r.onPi ? "（おすすめ）" : ""}`,
    outcomeText ? `結果 ${outcomeText}` : null,
    monthlyText ? `${moneyAt ?? ""} ${monthlyText}${monthlyDiff ? `（${monthlyDiff}）` : ""}` : TAG_STUB,
    runningText,
    nAltOut ? `ほかの結果 ${altOutcomeParts.join("・")}` : null,
    altOptionsText,
  ]
    .filter((x): x is string => !!x)
    .join("。");
  return {
    key: stepKey(r.decision),
    index: k,
    decision: r.decision,
    option: r.option,
    outcome: r.outcome,
    m: r.m,
    ym: yms,
    span,
    move,
    onPi: r.onPi,
    off,
    pivot,
    stub: r.stub,
    outcomeText,
    moneyAt,
    monthlyText,
    monthlyDiff,
    runningText,
    altText: altParts.length ? altParts.join("・") : null,
    altOutcomesText: nAltOut ? altOutcomeParts.join("・") : null,
    altOutcomeParts,
    altOptionsText,
    outcomesHead,
    outcomes,
    optionsHead,
    options,
    optionGroups,
    nextText,
    aria,
    detail,
  };
}

/** まとめた静かな期の言葉（「転職活動を続ける（2 期・転職せず）」「遊ぶ人を増やす（2 期続けて）」） */
export function quietTitle(move: string, count: number, label: string | null): string {
  return label ? `${move}（${num(count)} 期・${label}）` : `${move}（${num(count)} 期続けて）`;
}

/** 道の画面の形。node は道を決めたカード（そこから下は一番ありそうな道）。from は道の始め（ふつう今日） */
export function pathVM(a: Analysis, node: number, text: TextSource, opts: { from?: number } = {}): PathVM {
  assertFresh(a);
  const cm = a.cm;
  const map = cm.map;
  const anchor = map.header.anchor;
  const endYm = ym(map, cm.H);
  const n = Math.max(0, Math.min(cm.n - 1, Math.floor(node)));
  const pv = walkPath(a, n, opts.from ?? 0);
  const { Wrr } = a.money;
  const start = pv.from;
  const firstMove = cm.first[n]!;
  const isEnd = cm.role[n] === ROLE_E;
  // 切り替えた行（ほかの結果・手のカードで開いた道だけ。今日・今日の手・行き先から開いた道には無い）
  const markRow = pv.pivotRow >= 0 && n !== firstMove && !isEnd ? pv.pivotRow : -1;
  // 行
  const steps: PathStepVM[] = [];
  let prev = Wrr[start]!;
  pv.rows.forEach((r, k) => {
    steps.push(stepVM(a, pv, r, k, text, prev, markRow));
    if (!r.stub) prev = r.monthly;
  });
  // まとめた静かな期
  const items: PathItemVM[] = [];
  for (const g of pv.groups) {
    const first = steps[g.from]!;
    if (g.count < 2) {
      items.push({ type: "step", step: first });
      continue;
    }
    const last = steps[g.to]!;
    const members = steps.slice(g.from, g.to + 1);
    const r0 = pv.rows[g.from]!;
    const split = cm.kidOff[r0.option + 1]! - cm.kidOff[r0.option]! >= 2;
    const label = split && r0.outcome >= 0 ? outcomeName(map, r0.outcome) : null;
    let span = first.ym;
    try {
      span = ymSpanText(anchor, first.m, last.m);
    } catch {
      /* 年月が読めない */
    }
    // 今のままが続く期は「今のまま」（「この 3 か月は今のまま（3 期続けて）」とは書かない）
    const gName = (cm.flags[r0.option]! & F_BASE) !== 0 ? kindName(map, kindKey(cm, r0.option)) : first.move;
    const title = quietTitle(gName, g.count, label);
    const outcomeText = label ? `${num(g.count)} 期とも${label} ${pct(g.w)}` : null;
    items.push({
      type: "group",
      key: `g${first.decision}`,
      ym: span,
      title,
      outcomeText,
      moneyAt: last.moneyAt,
      monthlyText: last.monthlyText,
      runningText: last.runningText,
      steps: members,
      off: members.some((x) => x.off),
      pivot: members.some((x) => x.pivot),
      aria: [`${span}`, title, outcomeText, last.monthlyText ? `${last.moneyAt ?? ""} ${last.monthlyText}` : null, last.runningText, `${num(g.count)} 期をまとめた行。押すと 1 期ずつ出る`].filter((x): x is string => !!x).join("。"),
    });
  }
  // まとめた手の後（標準の続き）: cont があれば見積もりの印の行と代表の 1 本の手、無ければ 1 本の薄い行。
  // 文章の作り手が標準の続きの文章を持てば、手の行は押して開ける（その期の文章・やること。見積もりの印つき。作業メモ reader-1・SPEC §5.4）
  const lastRow = pv.rows[pv.rows.length - 1];
  if (pv.summary && lastRow?.stub) {
    const from = lastRow.m + 3;
    let span = ym(map, from);
    try {
      span = ymSpanText(anchor, from, cm.H - 3);
    } catch {
      /* 年月が読めない */
    }
    if (pv.cont.length) {
      const readable = typeof text.cont === "function";
      const endNode = pv.end;
      const arrive = `着いた所へ（${ym(map, cm.month[endNode]!)}）`;
      items.push({
        type: "light",
        key: "ch",
        ym: span,
        title: "ここから先は標準の選び方で続けた見積もり",
        note: readable ? "代表の 1 本（一番ありそうな出来事と標準の手）。行を押すと、その 3 か月の文章。数は着いた所の平均" : "代表の 1 本（一番ありそうな出来事と標準の手）。数は着いた所の平均",
        head: true,
        aria: "",
        nextText: null,
        detail: null,
      });
      pv.cont.forEach((c, k) => {
        const isKeep = map.header.kinds[c.kind]?.[1] === "base";
        const name = isKeep ? "今のまま" : kindName(map, c.kind);
        const at = ym(map, c.m);
        const next = pv.cont[k + 1];
        let memo: PathCardVM | null | undefined;
        const detail = (): PathCardVM | null => {
          if (memo !== undefined) return memo;
          const ct = text.cont?.(endNode, k) ?? null;
          if (!ct) return (memo = null);
          let qs = "";
          try {
            qs = `（${quarterSpanText(anchor, c.m)}）`;
          } catch {
            /* 年月が読めない */
          }
          return (memo = {
            head: `この 3 か月${qs}・標準の続きの代表の 1 本`,
            title: safeName(ct.title, name),
            numbers: [],
            body: ct.body,
            todo: ct.todo.map((t) => t.text.trim()).filter((t) => t && !looksLikeId(t)),
            facts: [],
            est: true,
          });
        };
        items.push({
          type: "light",
          key: `c${k}`,
          ym: at,
          title: name,
          note: null,
          head: false,
          aria: readable ? `${at}・${name}（標準の続きの見積もり）。押すと、その 3 か月の文章とやること` : "",
          nextText: readable ? (next ? `次の 3 か月へ（${ym(map, next.m)}・見積もり）` : arrive) : null,
          detail: readable ? detail : null,
        });
      });
      // まとめた手の行の「次の 3 か月へ」は、開ける標準の続きの最初の行へ（着いた所へ飛ばない）
      const stubStep = steps[steps.length - 1];
      if (readable && stubStep?.stub) stubStep.nextText = `次の 3 か月へ（${ym(map, pv.cont[0]!.m)}・見積もり）`;
    } else if (from < cm.H) {
      items.push({ type: "light", key: "c", ym: span, title: "標準の選び方で続けた見積もり", note: "3 か月ごとの手と結果は、この地図では 1 つずつに分けていない", head: true, aria: "", nextText: null, detail: null });
    }
  }
  // 一番ありそうな道と違う所
  const offs: string[] = [];
  pv.rows.forEach((r, k) => {
    if (k > 0 && !r.onPi) offs.push(`${ym(map, r.m)}の手: ${steps[k]!.move}`);
    if (!r.likely && r.outcome >= 0) offs.push(`${ym(map, r.mNext)}の結果: ${outcomeName(map, r.outcome)} ${pct(r.w)}`);
  });
  const firstName = firstMove >= 0 ? moveName(map, kindKey(cm, firstMove), (cm.flags[firstMove]! & F_BASE) !== 0) : null;
  const endNode = pv.end;
  const endM = cm.month[endNode]!;
  const total = a.money.acc[endNode]! + a.pi.V[endNode]!;
  const vs = a.vSQ === null ? null : `ずっと今のままより ${manDelta(total - a.vSQ)}`;
  const title = offs.length === 0 ? "一番ありそうな道" : isEnd ? "この行き先までの道" : "切り替えた道";
  let eyebrow = `${firstName ?? "今日から"}・${ym(map, cm.month[start]!)}〜${endYm}`;
  if (start !== 0) eyebrow = `${ym(map, cm.month[start]!)}から・${endYm}まで`;
  const stubRow = pv.summary ? pv.rows.find((r) => r.stub) : undefined;
  const stubYm = stubRow ? ym(map, stubRow.m) : null;
  const openTail = "行を押すと、その 3 か月の文章と、ほかの結果・ほかの手が出る。ほかを押すと、そこから先の道に切り替わる";
  const intro = pv.summary
    ? `${offs.length === 0 ? "3 か月ごとに一番良い手を選び、見込みの一番大きい結果をたどった。" : isEnd ? "この行き先に着く道を今日からたどった。" : "切り替えた所から先は、3 か月ごとに一番良い手を選び、見込みの一番大きい結果をたどった。"}${stubYm}に選ぶ手から先は、3 か月ごとに分けず、標準の選び方で ${endYm}まで続けた見積もり（多くの道の平均）。${openTail}`
    : offs.length === 0
      ? `3 か月ごとに一番良い手を選び、どの分かれでも見込みの一番大きい結果をたどった道。${openTail}`
      : isEnd
        ? `この行き先に着く道を今日からたどった。${openTail}`
        : "切り替えた所から先は、3 か月ごとに一番良い手を選び、見込みの一番大きい結果をたどった。行を押すと、その 3 か月の文章と、ほかの結果・ほかの手が出る";
  const splits = pv.rows.filter((r) => cm.kidOff[r.option + 1]! - cm.kidOff[r.option]! >= 2 && !r.stub).length;
  // 3 年の合計の位置: その道が「一番ありそうな道」になる所（道を決めたカード）から先の行き先の中で。行き先から開いた道は今日の手の後の中で
  let placeNote: string | null = null;
  if (!pv.summary) {
    const ref = isEnd ? (firstMove >= 0 ? firstMove : 0) : pv.pivot;
    const where = ref === 0 ? "今日からの道" : ref === firstMove ? "この手の後の道" : "切り替えた所から先の道";
    const pl = placeIn(endsFrom(a, ref), total);
    if (pl) {
      placeNote = `${where}の中で${placeText(pl.p)}（真ん中 ${man(pl.p50)}・平均 ${man(pl.mean)}）`;
      if (!isEnd && pl.p <= 0.3) {
        // 分かれごとに一番ありそうな結果（多くは「変わらない」方）をつないだので、低い側に寄る（作業メモ user-2・truth-6）
        const labels: string[] = [];
        let more = false;
        pv.rows.forEach((r, k) => {
          if (k < Math.max(0, pv.pivotRow) || r.outcome < 0 || !r.likely || cm.kidOff[r.option + 1]! - cm.kidOff[r.option]! < 2) return;
          const l = outcomeName(map, r.outcome);
          if (labels.includes(l)) return;
          if (labels.length < 3) labels.push(l);
          else more = true;
        });
        if (labels.length) placeNote += `。分かれごとに一番ありそうな結果（${labels.join("・")}${more ? " など" : ""}）をつないだ道なので、3 年の合計は低い側に寄る`;
      }
    }
  }
  const figures: PathFigureVM[] = pv.summary
    ? [
        {
          label: "標準の続きに入るまでの見込み",
          value: pct1(pv.p),
          sub: `${stubYm}に選ぶ手から標準の続きに入る。その後 ${endYm}までの分かれは標準の続きの中で平均した（1 本の道の見込みではない）`,
          note: null,
        },
        { label: "3 年の合計", value: man(total), sub: [vs, "この先は標準の続きの平均"].filter((x): x is string => !!x).join("・"), note: null },
        { label: `${ym(map, Math.min(endM, cm.H))}の月の稼ぎ`, value: manMonthly(Wrr[endNode]!), sub: `標準の続きの平均・今日 ${manMonthly(Wrr[start]!)}`, note: null },
      ]
    : [
        { label: "この道の見込み", value: pct1(pv.p), sub: splits > 0 ? `出来事の分かれ ${num(splits)} 回が、どれもこのとおりになる見込み` : "出来事の分かれが無い道", note: null },
        { label: "3 年の合計", value: man(total), sub: vs, note: placeNote },
        { label: `${ym(map, Math.min(endM, cm.H))}の月の稼ぎ`, value: manMonthly(Wrr[endNode]!), sub: `今日 ${manMonthly(Wrr[start]!)}`, note: null },
      ];
  // 道の終わり
  const cls = destLabel(destClassOf(map.st(endNode), pv.summary ? map.mix(endNode) : null, map.band(endNode)));
  const endTitle = safeName(text.title(endNode), cls);
  const end: PathEndVM = {
    node: endNode,
    head: endM >= cm.H ? `${endYm}に着く所${pv.summary ? "（標準の続きの見積もり）" : ""}` : `${ym(map, endM)}で止まる道（その後は同じ月の稼ぎが ${endYm}まで続くとして数えた）`,
    cls,
    title: endTitle === cls ? null : endTitle,
    numbers: text.numbers(endNode),
    body: () => text.body(endNode),
    facts: pv.summary
      ? [`3 年の合計 ${man(total)}（多くの道の平均${vs ? `・${vs}` : ""}）`, `標準の続きに入るまでの見込み ${pct1(pv.p)}`]
      : [`3 年の合計 ${man(total)}${vs ? `（${vs}）` : ""}`, `この道の見込み ${pct1(pv.p)}`],
    summary: pv.summary,
    note: pv.summary ? "この先は標準の続きの平均（3 年の合計と数字の行は、標準の選び方で続けた多くの道の平均。1 本の道の数ではない）" : null,
  };
  // 見出しの線: この道の月の稼ぎ（まとめた手の後は見積もり）と、ずっと今のまま（分かれがあれば真ん中）
  const sparkPath: PathSparkVM["path"] = [{ m: cm.month[start]!, v: Wrr[start]!, est: false }];
  for (const r of pv.rows) {
    if (r.outcome < 0) continue;
    sparkPath.push({ m: Math.min(cm.H, cm.month[r.outcome]!), v: r.monthly, est: r.stub });
  }
  if (endM < cm.H) sparkPath.push({ m: cm.H, v: Wrr[endNode]!, est: false });
  const kf = keepFanOf(a);
  const keepSpread = kf.some((p) => p.p10 !== null && p.p90 !== null && Math.abs(p.p90 - p.p10) > 0.05);
  const keepLabel = keepSpread ? "ずっと今のまま（真ん中）" : "ずっと今のまま";
  const keep = kf.filter((p) => p.p50 !== null).map((p) => ({ m: p.m, v: p.p50! }));
  const months: number[] = [];
  for (let m = 0; m <= cm.H; m += 3) months.push(m);
  const spark: PathSparkVM = {
    path: sparkPath,
    keep,
    months,
    yms: months.map((m) => ym(map, m)),
    keepLabel,
    label: `この道の月の稼ぎ: ${ym(map, cm.month[start]!)} ${manMonthly(Wrr[start]!)} → ${ym(map, Math.min(endM, cm.H))} ${manMonthly(Wrr[endNode]!)}${keep.length ? `。${keepLabel}は ${manMonthly(keep[keep.length - 1]!.v)}` : ""}`,
  };
  // 最初から開く行: 切り替えた行（今日の手・今日・行き先から開いた道は閉じたまま）
  const defaultOpen: string[] = [];
  if (markRow >= 0) {
    const st = steps[markRow]!;
    defaultOpen.push(st.key);
    for (const it of items) if (it.type === "group" && it.steps.includes(st)) defaultOpen.push(it.key);
  }
  return {
    node: n,
    title,
    eyebrow,
    intro,
    figures,
    offs,
    resetHref: offs.length ? pathHash(map, firstMove >= 0 ? firstMove : 0) : null,
    resetText: "一番ありそうな道に戻す",
    backHref: firstMove >= 0 ? moveHash(kindKey(cm, firstMove)) : OVERVIEW_HASH,
    backText: firstName ? `${firstName}へ` : "見取り図へ",
    readText: "最初の 3 か月から読む",
    start: {
      key: "start",
      ym: ym(map, cm.month[start]!),
      title: start === 0 ? "今日" : safeName(text.title(start), ym(map, cm.month[start]!)),
      numbers: text.numbers(start),
      monthlyText: `月の稼ぎ ${manMonthly(Wrr[start]!)}`,
      body: () => text.body(start),
    },
    items,
    steps,
    end,
    spark,
    defaultOpen,
    summary: pv.summary,
    provisional: !!text.provisional,
  };
}

// ------------------------------------------------------------ 見方と前提

export interface NotesModel {
  howTo: string[];
  premises: string[];
  /** 出さなかった前提の数（3 か月ごとでない手の前提。この地図には無い） */
  premisesHidden: number;
  annual: number;
}

/** 3 か月ごとの地図に無い手（9 か月・2 年の手）の前提（前の版の木の見出しに残っている） */
const STALE_PREMISE = /9 か月|2 年の(?:手|計画)/;

/** 見方（言葉の意味・数の出し方・数えていない物）と前提（地図の見出しのまま） */
export function notesVM(a: Analysis, basis: DeltaBasis, worthAvailable: boolean, opts: { worthNoise?: number } = {}): NotesModel {
  const map = a.cm.map;
  const y0 = ym(map, 0);
  const yEnd = ym(map, a.cm.H);
  const noise = opts.worthNoise ?? WORTH_NOISE;
  const howTo = [
    basis === "q"
      ? `${DELTA_LABEL}: 今日その手を始める場合と、この 3 か月は今のままで 3 か月後に選ぶ場合の、3 年の稼ぎの差。どちらもその 3 か月は正確に、その後は標準の選び方で見積もった（おすすめの印・分布・道は一番良い選び方）`
      : `${DELTA_LABEL}: 今日その手を始める場合と、この 3 か月は今のままで 3 か月後に選ぶ場合の、3 年の稼ぎの差（どちらもその後は一番良い選び方）`,
    "「この 3 か月は今のまま」は比べる元（3 年の合計の分布・道では、その後は一番良い選び方で進む）。「ずっと今のまま」は 12 回とも今のままで、3 年の合計を比べる元",
    `3 年の合計: ${y0}から ${yEnd}までの税引き前の稼ぎ（給与・広告運用・SpellDash）の合計。給与は年収 ${num(a.annual)} 万円（賞与込みの額面）から数える`,
    "3 年の合計の幅（「ずっと今のままより」の幅）には、その手の分のほか、その後の選び方と運の分が入る。その手の分は「今やる vs 3 か月待つ」で、3 か月待ってから一番良い選び方をしても出る幅は「3 か月待っても」に出している",
    "分布の棒: その手の後、一番良い選び方で進んだときの行き先を見込みの重さで並べ、ずっと今のままとの差の段で色を付けた。10〜90% は、低い方と高い方の 1 割ずつを除いた幅",
    `分かれ道 = 判断（手を選ぶ時点）+ 出来事の分かれ（結果が見込み % で分かれる手）。行き先は ${yEnd}に着く所で、「見込み 1% 以上」はそこへ着く見込みが 1% 以上の物`,
    `標準の続きの見積もり: 先を広げなかった手の先。標準の選び方で ${yEnd}まで続けた見積もりを 1 枚にまとめた行き先（数は多くの道の平均）`,
    basisNote(basis),
    worthAvailable
      ? `${WORTH_LABEL}: その種類の手を 3 年間ずっと使わない場合と比べた、3 年の稼ぎの差。${man(noise)}未満（マイナスも）は見積もりの誤差の範囲なので「ほぼ差なし」`
      : "「この種類を 3 年やらない場合との差」は、計算の前提を直した地図で入る（この地図にはまだ無い）",
    "一番ありそうな道: 3 か月ごとに一番良い手を選び、どの分かれでも見込みの一番大きい結果をたどった 1 本の道。見込みは、その道のとおりになる見込み。見込みの一番大きい結果は多くが『変わらない』方なので、3 年の合計は行き先の中で低い側に寄りやすい（道の画面に、行き先の中の位置を出している。真ん中あたりの道も選べる）",
    `道の画面: 行の年月は手を選ぶ月で、手はその次の月から 3 か月。お金の行の年月はその結果の月で、「月の稼ぎ」はその月の 1 か月の稼ぎ（かっこの中は前の行との差）、「ここまでの稼ぎ」は ${y0}からその月までの合計で、${yEnd}で 3 年の合計になる`,
    "道の画面のほかの結果・ほかの手: 押すと、そこから先を一番ありそうな道でたどり直す。結果の差はこの道の結果との 3 年の合計の差（その結果の後は一番良い選び方）、手の差はこの道の手との 3 年の合計の差。先を広げていない手（標準の続きの見積もり）に切り替えると、その先は多くの道の平均になる",
    "週の時間（手ごとに増える作業の時間）は数に入れていない。お金だけで比べている",
    "数字はどれもモデルの見積もりで、決まった未来ではない",
  ];
  const all = (Array.isArray(map.header.premises) ? map.header.premises : []).filter((x): x is string => typeof x === "string" && x.trim() !== "");
  const premises = all.filter((x) => !STALE_PREMISE.test(x));
  return { howTo, premises, premisesHidden: all.length - premises.length, annual: a.annual };
}
