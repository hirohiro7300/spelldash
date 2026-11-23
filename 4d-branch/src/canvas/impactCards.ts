// 3 年の分かれ道のカード・線に書く物（3 年の影響の数・見込み % ・色の段）。計算の結果（ImpactResult）ごとに 1 度だけ作る
// （題名などの文字だけが変わったカード・線は、計算し直さずにその 1 枚だけ作り直す）。設計: docs/DESIGN.md §4.7
// 描くたびに文字を作り直さない（全部開いて動かしても、作る物が増えないように）

import { ymText } from "../deepmap/core/time";
import type { ImpactResult } from "../model/impact";
import { IMPACT_FILL, IMPACT_NEUTRAL_RING, MINUS, formatMan, formatMonthly, formatMonthlyDelta, formatShare, impactBin } from "../model/impactFormat";
import { formatPercent } from "../model/forecast";
import type { DocData, ID } from "../model/types";

export type ImpactRole = "root" | "alt" | "out" | "end";

export interface ImpactCard {
  role: ImpactRole;
  /** 色の段（−4〜+4。選択肢は 3 年の影響、結果・行き先はその結果の良し悪し、今日は 0） */
  bin: number;
  /** 塗りの札（選択肢: 「+65万」「基準」「—」） */
  pill: string | null;
  /** 縁取りの札（結果・行き先: 「35%」、今日: 「最善 +65万」） */
  chip: string | null;
  /** ★・◎（おすすめ: q のある地図で、判断の一番良い手。★ の無い所だけ）・≒・✓ */
  marks: string;
  /** 1 行目の名前（選択肢: 領域「SpellDash」「本業」「独立」「今のまま」・結果: 「3 か月後」・今日: 「今日」） */
  head: string;
  /** 1 行目の名前の色（無ければ種類の色） */
  headColor: string | null;
  /** 下の行（大きく見ているとき） */
  bottom: string;
  /** 下の行の短い形（入らないとき。週の時間を落とす） */
  bottomShort: string;
  /** 見込みの帯（結果ごとの割合と色の段） */
  risk: Array<{ w: number; bin: number }>;
  /** 短い名前 */
  short: string;
  /** 縮小したときに真ん中に書く物（「+65」「35%」） */
  low: string;
  /** 基準（今のまま）: 破線の枠 */
  base: boolean;
  /** 見送った手 */
  dropped: boolean;
  /** 縮小したときの目印の文（選択肢「+65万｜…」・行き先「3年 +210万（2.4%）」） */
  label: string;
  /**
   * 目印の文から、カードの真ん中に出している差（選択肢の「+65万｜」）を除いた物（選択肢の題名。ほかは label と同じ）。
   * 縮小して真ん中に差を描いているときは、こちらを目印にする（同じ差を 2 度出さず、次の列へはみ出しにくい: 見直し user-9）
   */
  labelTitle: string;
  /** 一番小さくしたときの目印の文（行き先「3年後 月 42万（18%）」・今日「今日」） */
  dotLabel: string;
  /**
   * 縮小したとき（low・dot）の塗りの段: 状態・行き先は 3 年の合計とずっと今のままの差（3 か月ごとの地図だけ。地図を引いて見ると
   * 熱の地図になる: 作業メモ user-1 (3)）。null なら bin
   */
  heat: number | null;
  /** 縮小したときに真ん中に書く物（heat のとき「+120」。無ければ low） */
  heatLow: string;
}

export interface ImpactEdge {
  kind: "decision" | "chance";
  /** 線の色・太さ（描くたびに作らない） */
  style: { color: string; width: number };
  /** ふだんの濃さ */
  alpha: number;
  /** 見込み（結果の線だけ。「35%」） */
  pct: string;
  /** 「35%｜判断の線」 */
  long: string;
  /** その結果の色（札の枠と点） */
  color: string;
  /** まとめた行き先への線（標準の続き。3 か月ごとの地図では 2029 年 11 月の列までの破線: 作業メモ user-3） */
  cont: boolean;
}

/** 段の色（ほぼ同じは灰色の枠の色） */
export function binStroke(bin: number): string {
  return bin === 0 ? IMPACT_NEUTRAL_RING : IMPACT_FILL[bin]!;
}

/** 時期の名前（3 → 「3 か月後」、12 → 「1 年後」） */
export function stageLabel(m: number | undefined): string {
  if (m === undefined || !Number.isFinite(m)) return "";
  const r = Math.round(m);
  if (r <= 0) return "今日";
  if (r % 12 === 0) return `${r / 12} 年後`;
  return `${r} か月後`;
}

/** 「−38〜+140万」（前の数の「万」は省く） */
export function rangeLabel(lo: number, hi: number): string {
  const a = formatMan(lo);
  const b = formatMan(hi);
  return a.endsWith("万") && b.endsWith("万") ? `${a.slice(0, -1)}〜${b}` : `${a}〜${b}`;
}

/** 領域の短い名前（プロジェクトの名前から。同じ名前でまとめた文書でも ID ではなく名前で決める） */
function areaName(name: string): string {
  if (/SpellDash/i.test(name)) return "SpellDash";
  if (/FC|本業|マーケティング/.test(name)) return "本業";
  if (/独立/.test(name)) return "独立";
  return name.length > 8 ? `${name.slice(0, 7)}…` : name;
}

/** 縮小したときに書く数（「+65万」→「+65」） */
function lowOf(pill: string): string {
  return pill.endsWith("万") ? pill.slice(0, -1) : pill;
}

function clip(s: string, n: number): string {
  const chars = Array.from(s.replace(/\s+/g, " ").trim());
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
}

const DECISION = { color: "#8A97B1", width: 1.4 };
const DECISION_STAR = { color: "#C9D3E6", width: 2.6 };

/**
 * 計算の結果ごとの、カードと線に書く物（結果が変わったら作り直す）。
 * 題名・線の文だけの変更では結果は変わらないので、そのノード・線が変わった（文書の中の物が差し替わった）ときも、その 1 枚だけ作り直す
 */
export class ImpactCards {
  private imp: ImpactResult | null = null;
  private doc: DocData | null = null;
  /** 作ったときのノード・線（文書の物が差し替わったら作り直す）と、書く物 */
  private readonly cards = new Map<ID, { src: unknown; card: ImpactCard | null }>();
  private readonly edges = new Map<ID, { src: unknown; edge: ImpactEdge | null }>();
  private chanceStyles = new Map<string, { color: string; width: number }>();
  private ranks: Map<ID, number> | null = null;
  /** 3 か月ごとの地図の年月（入口の meta.anchor。無ければ null: 版 6 の地図） */
  private anchor: string | null = null;

  private sync(imp: ImpactResult, doc: DocData): void {
    if (imp === this.imp && doc === this.doc) return;
    this.imp = imp;
    this.doc = doc;
    this.cards.clear();
    this.edges.clear();
    this.ranks = null;
    const a = imp.root ? doc.nodes[imp.root]?.meta?.anchor : null;
    this.anchor = typeof a === "string" && /^\d{4}-\d{2}$/.test(a) ? a : null;
  }

  private emphStyles = new Map<{ color: string; width: number }, { color: string; width: number }>();

  /** 選び方の道（π）の線の太い描き方（3 か月ごとの地図はどの拡大率でも道を強める: 作業メモ SPEC v1 §5.6・user-10）。同じ物を返す */
  emph(style: { color: string; width: number }): { color: string; width: number } {
    let e = this.emphStyles.get(style);
    if (!e) this.emphStyles.set(style, (e = { color: style.color, width: Math.round((style.width + 1.4) * 10) / 10 }));
    return e;
  }

  /** 3 か月ごとの地図か（入口に地図の年月がある） */
  quarterly(imp: ImpactResult, doc: DocData): boolean {
    this.sync(imp, doc);
    return this.anchor !== null;
  }

  /** そのノードのカードに書く物（3 年の分かれ道の範囲の外は null） */
  card(imp: ImpactResult, doc: DocData, id: ID): ImpactCard | null {
    this.sync(imp, doc);
    const src = doc.nodes[id];
    let c = this.cards.get(id);
    if (c === undefined || c.src !== src) this.cards.set(id, (c = { src, card: buildCard(imp, doc, id, this.anchor) }));
    return c.card;
  }

  /** その線の描き方（3 年の分かれ道の判断・結果の線だけ。それ以外は null） */
  edge(imp: ImpactResult, doc: DocData, eid: ID): ImpactEdge | null {
    this.sync(imp, doc);
    const src = doc.edges[eid];
    let x = this.edges.get(eid);
    if (x === undefined || x.src !== src) this.edges.set(eid, (x = { src, edge: this.buildEdge(imp, doc, eid) }));
    return x.edge;
  }

  /**
   * 縮小したとき（low）に名前を出す順位: 2 = 今日の選択肢、3 = ★ の選択肢（ここに至る見込み 1% 以上）、4 = 見込みの高い行き先 20。
   * reach は P_path（computeForecast）
   */
  labelRank(imp: ImpactResult, doc: DocData, reach: (id: ID) => number): Map<ID, number> {
    this.sync(imp, doc);
    if (this.ranks) return this.ranks;
    const ranks = new Map<ID, number>();
    // 行き先は見込みの高い順に置く（同じ順位の中で、上の物ほど先に）
    imp.ends.slice(0, 20).forEach((e, i) => ranks.set(e.id, 4 + i / 100));
    // ★ の選択肢（選択肢の詳細を作らず、印だけを読む）
    for (const id of imp.altIds()) if (reach(id) >= 0.01 && imp.markOf(id) === "star") ranks.set(id, 3);
    const root = imp.root ? imp.decision.get(imp.root) : undefined;
    for (const id of root?.alts ?? []) ranks.set(id, 2);
    if (imp.root) ranks.set(imp.root, 2);
    this.ranks = ranks;
    return ranks;
  }

  private buildEdge(imp: ImpactResult, doc: DocData, eid: ID): ImpactEdge | null {
    const e = doc.edges[eid];
    if (!e || (e.relation !== "leads" && e.relation !== "condition") || !imp.scope.has(e.source) || !imp.scope.has(e.target)) return null;
    const kind = imp.kind.get(e.source);
    if (kind === "decision") {
      const a = imp.alt.get(e.target);
      const star = a?.mark === "star";
      return { kind: "decision", style: star ? DECISION_STAR : DECISION, alpha: star ? 1 : a?.isBase ? 0.35 : 0.55, pct: "", long: "", color: DECISION.color, cont: false };
    }
    if (kind !== "chance" && kind !== "pass") return null;
    const o = imp.alt.get(e.source)?.outcomes.find((x) => x.edge === eid);
    const bin = o ? o.bin : 0;
    const color = binStroke(bin);
    // 割合の分からない線（選択肢でない所から分かれる、後から足した線）は中くらいの太さ
    const width = o ? Math.round((1.2 + 3.5 * o.w) * 10) / 10 : 2.2;
    const w = o ? o.w : 0;
    const key = `${color}|${width}`;
    let style = this.chanceStyles.get(key);
    if (!style) this.chanceStyles.set(key, (style = { color, width }));
    const pct = o ? formatShare(w) : "";
    const line = e.condition.trim() || e.label.trim();
    // まとめた行き先への線: 3 か月ごとの地図では 2029 年 11 月の列までの「標準の続き」の破線（札にもそう書く）
    const cont = this.anchor !== null && doc.nodes[e.target]?.meta?.sum === true;
    if (cont) return { kind: "chance", style, alpha: 0.7, pct, long: pct ? `${pct}｜標準の続き` : "標準の続き", color, cont };
    return { kind: "chance", style, alpha: 0.85, pct, long: pct && line ? `${pct}｜${line}` : pct || line, color, cont };
  }
}

/** 時期の名前: 3 か月ごとの地図は年月（「2027 年 2 月」: 作業メモ SPEC v1 §5.6・user-15）、ほかは「3 か月後」 */
function headOf(m: number | undefined, anchor: string | null): string {
  if (anchor === null || m === undefined || !Number.isFinite(m)) return stageLabel(m);
  try {
    return ymText(anchor, Math.round(m));
  } catch {
    return stageLabel(m);
  }
}

function buildCard(imp: ImpactResult, doc: DocData, id: ID, anchor: string | null): ImpactCard | null {
  if (!imp.active || !imp.scope.has(id)) return null;
  const n = doc.nodes[id];
  if (!n) return null;
  const short = typeof n.meta?.short === "string" && n.meta.short.trim() ? (n.meta.short as string).trim() : n.title.trim() || "（無題）";
  const card: ImpactCard = { role: "out", bin: 0, pill: null, chip: null, marks: "", head: "", headColor: null, bottom: "", bottomShort: "", risk: [], short, low: "", base: false, dropped: n.status === "dropped", label: "", labelTitle: "", dotLabel: "", heat: null, heatLow: "" };
  const horizonLabel = `${Math.round((imp.horizon / 12) * 10) / 10}年後`;

  if (id === imp.root) {
    const d = imp.decision.get(id);
    const best = d?.stakes ?? d?.spread?.[1] ?? null;
    card.role = "root";
    card.head = "今日";
    card.chip = best !== null ? `最善 ${formatMan(best)}` : null;
    const parts = d ? [`選択肢 ${d.alts.length}`] : [];
    if (d?.spread) parts.push(rangeLabel(d.spread[0], d.spread[1]));
    card.bottom = card.bottomShort = parts.join(" · ");
    // 縮小したときの目印は短く（すぐ下の選択肢の目印を押しのけない）
    card.label = short;
    card.dotLabel = short;
    return card;
  }

  const a = imp.alt.get(id);
  if (a) {
    card.role = "alt";
    card.bin = a.bin;
    card.base = a.isBase;
    card.dropped = a.dropped;
    card.pill = a.delta === null ? "—" : a.isBase ? "基準" : `${a.partial ? "≈" : ""}${formatMan(a.delta)}`;
    card.low = a.delta === null ? "—" : a.isBase ? "基準" : lowOf(card.pill);
    card.marks = (a.mark === "star" ? "★" : a.rec ? "◎" : "") + (a.mark === "tie" ? "≒" : "") + (a.picked ? "✓" : "");
    if (a.isBase) {
      // 3 か月ごとの地図の比べる元は「この 3 か月は今のまま」（作業メモ SPEC v1 §5.10・user-11）: 1 行目「この 3 か月」と題名「今のまま」で読む
      card.head = anchor !== null ? "この 3 か月" : "今のまま";
      card.headColor = "#A3ADBF";
    } else {
      const p = n.projectIds.map((pid) => doc.projects[pid]).find((x) => x !== undefined);
      if (p) {
        card.head = areaName(p.name);
        card.headColor = p.color;
      }
    }
    // 下の行: 3 年後の月の稼ぎ（差。基準は水準）・週の時間
    const parts: string[] = [];
    if (a.isBase) {
      const r = imp.rate.get(id);
      if (r !== undefined) parts.push(`${horizonLabel} ${formatMonthly(r)}`);
    } else if (a.dR !== null) parts.push(`${horizonLabel} ${formatMonthlyDelta(a.dR)}`);
    const hours = n.meta?.h;
    if (typeof hours === "number" && Number.isFinite(hours) && Math.abs(hours) >= 0.05) parts.push(`週${hours > 0 ? "+" : MINUS}${Math.round(Math.abs(hours) * 10) / 10}h`);
    card.bottom = parts.join(" · ");
    card.bottomShort = parts[0] ?? "";
    card.risk = a.outcomes.filter((o) => o.w > 0).map((o) => ({ w: o.w, bin: o.bin }));
    card.label = `${a.isBase ? "基準" : card.pill}｜${clip(n.title, 12)}`;
    card.labelTitle = clip(n.title, 12);
    return card;
  }

  const kind = imp.kind.get(id);
  const o = imp.outcome.get(id);
  card.role = kind === "leaf" ? "end" : "out";
  card.bin = o?.bin ?? 0;
  card.chip = o ? formatShare(o.w) : null;
  card.low = card.chip ?? "";
  card.head = headOf(imp.month.get(id), anchor);
  // 3 か月ごとの地図: 縮小したときは 3 年の合計（今日からそこまで + その後のおすすめの選び方）とずっと今のままの差で塗る（熱の地図）
  if (anchor !== null && imp.vSQ !== null) {
    const acc = imp.acc.get(id);
    const v = imp.value.get(id);
    if (acc !== undefined && v !== undefined) {
      const g = acc + v - imp.vSQ;
      card.heat = impactBin(g);
      card.heatLow = lowOf(formatMan(g));
    }
  }
  if (card.role === "end") {
    const acc = imp.acc.get(id);
    const v = imp.value.get(id);
    const rate = imp.rate.get(id);
    const parts: string[] = [];
    const g = acc !== undefined && v !== undefined && imp.vSQ !== null ? acc + v - imp.vSQ : null;
    if (g !== null) parts.push(`3年 ${formatMan(g)}`);
    if (rate !== undefined) parts.push(formatMonthly(rate));
    card.bottom = parts.join(" · ");
    card.bottomShort = parts[0] ?? "";
    const p = imp.pPi.get(id);
    card.label = g !== null ? `3年 ${formatMan(g)}${p !== undefined ? `（${formatPercent(p)}）` : ""}` : clip(n.title, 12);
    card.dotLabel = rate !== undefined ? `${horizonLabel} ${formatMonthly(rate)}${p !== undefined ? `（${formatPercent(p)}）` : ""}` : card.label;
  } else {
    const d = imp.decision.get(id);
    if (d) {
      const parts = [`選択肢 ${d.alts.length}`];
      if (d.spread) parts.push(rangeLabel(d.spread[0], d.spread[1]));
      card.bottom = parts.join(" · ");
      card.bottomShort = parts[0]!;
    }
    card.label = clip(n.title, 12);
  }
  return card;
}
