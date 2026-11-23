// 3 年の影響を言葉にする（右のパネルで使う）。数は計算し直さず、src/model/impact.ts の結果とノードの状態（meta.st）を読みやすい文にする。
// 設計: docs/DESIGN.md §4.7
// 万円の数の書き方は impactFormat.ts（「+65万」「1,423万」）。文の中では「+65 万円」「1,423 万円」の形にする。

import { BAD_EPS } from "./impact";
import { formatMan, formatMonthlyDelta, formatShare, IMPACT_T, MINUS } from "./impactFormat";
import { isDateStr } from "./dates";
import type { DocData, GNode, ID } from "./types";

/** 今日の週の働く時間（本業 42 時間 + SpellDash 10 時間） */
export const IMPACT_BASE_HOURS = 52;
/** 週 4 日勤務の給与の倍率（状態に今の稼ぎ meta.rr が無いときだけ使う） */
const PART_FACTOR = 0.8;
/** どの結果でもこの手の先は同じ（判断の線が無い）ことを表す文 */
export const NO_LINE = "（どの場合もこの道）";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown, d: number): number => (isNum(v) ? v : d);

function groupDigits(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 整数（3 桁ごとに区切る） */
const n0 = (x: number): string => (x < 0 ? MINUS : "") + groupDigits(Math.abs(x));
/** 小数 2 桁（給与の倍率） */
const f2 = (x: number): string => (Math.round(x * 100) / 100).toFixed(2);
/** 小数 1 桁（.0 は落とす） */
const f1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "");

/** 万円の数を文の中の形に（「1,423 万円」「+293 万円」「−43 万円」「±0」「+1.2 億円」）。signed なら差として符号を付ける */
export function yen(x: number, signed = true): string {
  const s = formatMan(x, signed);
  if (s === "±0" || s === "—") return s;
  return s.replace(/万$/, " 万円").replace(/億$/, " 億円");
}

/** yen・formatMan が出す数そのもの（10 万円未満は 0.1 万円、1 億円未満は 1 万円、それ以上は 0.1 億円に丸めた値） */
export function shownManOf(x: number): number {
  const a = Math.abs(x);
  const r = a < 10 ? Math.round(a * 10) / 10 : a < 9999.5 ? Math.round(a) : Math.round(a / 1000) * 1000;
  return x < 0 ? -r : r;
}

/** 期限（YYYY-MM-DD）の年月（「2026年11月」）。読めなければ null */
export function ymText(due: string | null | undefined): string | null {
  if (!isDateStr(due)) return null;
  return `${Number(due.slice(0, 4))}年${Number(due.slice(5, 7))}月`;
}

/** 期限から months か月後の年月（「2029年11月」）。読めなければ null */
export function ymAfter(due: string | null | undefined, months: number): string | null {
  if (!isDateStr(due) || !Number.isFinite(months)) return null;
  const total = Number(due.slice(0, 4)) * 12 + Number(due.slice(5, 7)) - 1 + Math.round(months);
  return `${Math.floor(total / 12)}年${(total % 12) + 1}月`;
}

/** 数える期間（36 → 「3 年」、18 → 「18 か月」） */
export function horizonText(months: number): string {
  return months > 0 && months % 12 === 0 ? `${months / 12} 年` : `${months} か月`;
}

const PERM_TEXT: Record<string, string> = { "?": "副業は届け出前", a: "副業 OK", s: "SpellDash だけ可", n: "副業は不可" };

/**
 * その時の状態を 1 行に（「会社員（給与 1.05 倍）・副業 OK・顧客 1 社（月 5 万円）・SpellDash 有料 12 人（遊ぶ人 月 300 人）」）。
 * st はノードの meta.st（仕事 j・届け出の答え pm・Pro・遊ぶ人 mau・有料会員 pu・顧客 cl・1 社の月額 fee・給与の倍率 sal・学校の席 seats）、
 * rr は meta.rr（その時の月の稼ぎ。先頭が実際の給与の倍率。週 4 日勤務では 0.8 倍が掛かっている）。読めなければ null
 */
export function stateLine(st: unknown, rr?: unknown): string | null {
  if (!st || typeof st !== "object") return null;
  const s = st as Record<string, unknown>;
  const j = s.j;
  if (j !== "e" && j !== "p" && j !== "i") return null;
  const parts: string[] = [];
  if (j === "i") parts.push("独立");
  else {
    const rate = Array.isArray(rr) && isNum(rr[0]) ? rr[0] : null;
    const sal = num(s.sal, 1);
    const mul = rate ?? (j === "p" ? sal * PART_FACTOR : sal);
    parts.push(`${j === "e" ? "会社員" : "週 4 日勤務"}（給与 ${f2(mul)} 倍）`);
    const pm = typeof s.pm === "string" ? PERM_TEXT[s.pm] : undefined;
    if (pm) parts.push(pm);
  }
  // 顧客の数は見込みの平均のことがある（2.4 社など）。丸めた数と月の額が食い違わないように、端数があれば「平均」で書く
  const cl = Math.max(0, num(s.cl, 0));
  if (cl >= 0.05) {
    const whole = Math.abs(cl - Math.round(cl)) < 0.05;
    parts.push(`顧客 ${whole ? n0(cl) : `平均 ${f1(cl)}`} 社（月 ${f1(cl * num(s.fee, 0))} 万円）`);
  } else if (j === "i") parts.push("顧客なし");
  const mau = Math.max(0, num(s.mau, 0));
  const pro = s.pro === 1 || s.pro === true;
  parts.push(pro ? `SpellDash 有料 ${n0(Math.max(0, num(s.pu, 0)))} 人（遊ぶ人 月 ${n0(mau)} 人）` : `SpellDash 無料（遊ぶ人 月 ${n0(mau)} 人）`);
  const seats = num(s.seats, 0);
  if (seats >= 0.5) parts.push(`学校 ${n0(seats)} 席`);
  return parts.join("・");
}

/**
 * 内訳を、表示する合計とちょうど合うように丸める（最大剰余）。刻みは合計の書き方（formatMan）と同じ:
 * 合計が 10 万円未満なら 0.1 万円、それ以上は 1 万円。values を formatManStep で書けば、足すと合計の表示と同じになる
 */
export function splitExact(total: number, parts: number[]): { step: 0.1 | 1; values: number[] } {
  const step: 0.1 | 1 = Math.abs(total) < 10 ? 0.1 : 1;
  const scale = step === 0.1 ? 10 : 1;
  // 合計の表示と同じ丸め（絶対値を丸めて符号を戻す）
  const target = Math.sign(total) * Math.round(Math.abs(total) * scale);
  const raw = parts.map((p) => (isNum(p) ? Math.round(p * scale * 1e6) / 1e6 : 0));
  const units = raw.map((x) => Math.floor(x));
  const rem = raw.map((x, i) => x - units[i]!);
  let k = target - units.reduce((a, b) => a + b, 0);
  const n = parts.length;
  if (n > 0 && k !== 0) {
    // 余りの大きい順（同じなら前の内訳から）
    const order = rem.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r || a.i - b.i);
    for (let t = 0; k > 0; t++, k--) units[order[t % n]!.i]! += 1;
    for (let t = 0; k < 0; t++, k++) units[order[n - 1 - (t % n)]!.i]! -= 1;
  }
  return { step, values: units.map((u) => u / scale) };
}

/** splitExact の刻みで万円の差を書く（0.1 の刻みなら小数 1 桁。.0 は落とす） */
export function formatManStep(x: number, step: 0.1 | 1): string {
  const a = Math.abs(x);
  if (a < (step === 0.1 ? 0.05 : 0.5)) return "±0";
  const sign = x < 0 ? MINUS : "+";
  return step === 0.1 ? `${sign}${f1(a)}万` : `${sign}${groupDigits(a)}万`;
}

export type AreaKey = "sd" | "fc" | "ind" | "base";

export interface AreaInfo {
  key: AreaKey | string;
  label: string;
  color: string;
}

/** 仕事の 3 つの領域（文書のプロジェクト ID と、無いときの色） */
const AREAS: Record<string, { key: AreaKey; label: string; color: string }> = {
  p_spelldash: { key: "sd", label: "SpellDash", color: "#FF7A59" },
  p_fcmarketing: { key: "fc", label: "本業", color: "#22D3EE" },
  p_independence: { key: "ind", label: "独立", color: "#A3E635" },
};

/** 今のまま（基準）の札の色 */
export const BASE_AREA_COLOR = "#8A94A6";

/** 選択肢の領域（札の名前と色）。今のまま（基準）は「今のまま」。領域が 1 つに決まらなければ null */
export function areaOf(n: GNode, doc: Pick<DocData, "projects">): AreaInfo | null {
  if (n.meta?.base === true) return { key: "base", label: "今のまま", color: BASE_AREA_COLOR };
  if (n.projectIds.length !== 1) return null;
  const pid = n.projectIds[0]!;
  const known = AREAS[pid];
  const p = doc.projects[pid];
  if (!known && !p) return null;
  return { key: known?.key ?? pid, label: known?.label ?? p!.name, color: p?.color ?? known!.color };
}

/** プロジェクトの領域の札（選択肢の行と同じ名前と色。手の種類の行で使う）。分からなければ null */
export function projectArea(pid: ID | null, doc: Pick<DocData, "projects">): AreaInfo | null {
  if (!pid) return null;
  const known = AREAS[pid];
  const p = doc.projects[pid];
  if (!known && !p) return null;
  return { key: known?.key ?? pid, label: known?.label ?? p!.name, color: p?.color ?? known!.color };
}

/** 影響の内訳の並び（impact.ts の deltaV と同じ: 本業・広告運用と独立・SpellDash） */
export function breakdownAreas(doc: Pick<DocData, "projects">): Array<{ label: string; color: string }> {
  const color = (pid: string) => doc.projects[pid]?.color ?? AREAS[pid]!.color;
  return [
    { label: "本業", color: color("p_fcmarketing") },
    { label: "広告運用・独立", color: color("p_independence") },
    { label: "SpellDash", color: color("p_spelldash") },
  ];
}

/** 週の時間の差（「週+3h」「週−2h」「週±0h」） */
export function hoursShort(h: number): string {
  if (!isNum(h) || Math.abs(h) < 0.05) return "週±0h";
  return `週${h > 0 ? "+" : MINUS}${f1(Math.abs(h))}h`;
}

/** 週の時間の差の文（「週の時間 +3 時間（今は 52 時間）」） */
export function hoursText(h: number): string {
  const d = !isNum(h) || Math.abs(h) < 0.05 ? "±0" : `${h > 0 ? "+" : MINUS}${f1(Math.abs(h))}`;
  return `週の時間 ${d} 時間（今は ${IMPACT_BASE_HOURS} 時間）`;
}

/**
 * 悪くなる見込み（「悪くなる 25%（悪くて −20万）」）。「悪くなる」に数えるのは今のままより 3 万円（BAD_EPS）以上悪い結果だけなので、
 * いちばん悪くてもそれより小さい差なら「悪くなる 0%」だけ（「0%（悪くて −0.4万）」のように食い違わない）
 */
export function riskShort(pBad: number | null, worst: number | null): string | null {
  if (pBad === null) return null;
  const head = `悪くなる ${formatShare(pBad)}`;
  return worst !== null && worst < -BAD_EPS ? `${head}（悪くて ${formatMan(worst)}）` : head;
}

/** 悪くなる見込みの文（「悪くなる見込み 25%（悪くて −20 万円）」） */
export function riskText(pBad: number | null, worst: number | null): string | null {
  if (pBad === null) return null;
  const head = `悪くなる見込み ${formatShare(pBad)}`;
  if (worst === null) return head;
  return worst < -BAD_EPS ? `${head}（悪くて ${yen(worst)}）` : `${head}（最悪でも ${yen(worst)}）`;
}

/** 選択肢の 2 行目の部品（悪くなる見込み・3 年後の月の稼ぎの差・週の時間） */
export function altMetaParts(x: { pBad: number | null; worst: number | null; dR: number | null }, hours: number | null): string[] {
  const parts: string[] = [];
  const risk = riskShort(x.pBad, x.worst);
  if (risk) parts.push(risk);
  if (x.dR !== null && Number.isFinite(x.dR)) parts.push(`3年後 ${formatMonthlyDelta(x.dR)}`);
  if (hours !== null && isNum(hours)) parts.push(hoursShort(hours));
  return parts;
}

/** 部品を「 · 」でつなぐ（全角の括弧の後ろは空きがあるので、区切りの前の空白を入れない） */
export function joinMeta(parts: string[]): string {
  return parts.reduce((s, p) => (s ? `${s}${metaSep(s)}${p}` : p), "");
}

/** 前の部品の後ろに置く区切り */
export function metaSep(prev: string): string {
  return prev.endsWith("）") ? "· " : " · ";
}

/** 選択肢の 2 行目（「悪くなる 25%（悪くて −20万）· 3年後 月+2.1万 · 週+3h」） */
export function altMetaLine(x: { pBad: number | null; worst: number | null; dR: number | null }, hours: number | null): string {
  return joinMeta(altMetaParts(x, hours));
}

export interface HeadlineInput {
  /** 数える期間（月） */
  horizon: number;
  /** 今の選び方（自分で選んだ手・方針を入れた）での 3 年の稼ぎ */
  value: number | null;
  /** ずっと今のままの 3 年の稼ぎ */
  statusQuo: number | null;
  /** おすすめの選び方（自分で選んだ手と方針を外した）での 3 年の稼ぎ */
  best: number | null;
  /** 自分で選んだ手（進行中・完了）がある */
  picks: boolean;
  /** 選んでいる方針（シナリオ）の名前 */
  scenario: string | null;
}

export interface Headline {
  /** 「おすすめの選び方で 3 年 1,423 万円」「あなたの選び方で 3 年 1,380 万円（おすすめとの差 −43 万円）」 */
  main: string;
  /** main の部品（数を目立たせて書くため）: 「おすすめの選び方で 3 年」「1,423 万円」「（おすすめとの差 −43 万円）」 */
  lead: string;
  value: string;
  vsBest: string;
  /** 「ずっと今のままなら 1,130 万円（差 +293 万円）」 */
  sub: string | null;
  /** 分布の行の名前（「おすすめ」「あなたの選び方」「早期独立の方針」） */
  label: string;
}

/** 概要の見出し（3 つの形: おすすめ・自分で選んだ手がある・方針を選んでいる） */
export function headlineOf(x: HeadlineInput): Headline | null {
  if (x.value === null || !Number.isFinite(x.value)) return null;
  const span = horizonText(x.horizon);
  const who = x.scenario ? `${x.scenario}の方針${x.picks ? "とあなたの選び方" : ""}だと` : x.picks ? "あなたの選び方で" : "おすすめの選び方で";
  const lead = `${who} ${span}`;
  const value = yen(x.value, false);
  // 差は、出した数どうしの差（「1,737 万円 … 1,503 万円（差 +234 万円）」。丸める前の差を丸めると 1 万円ずれる: 見直し R5）
  const vsBest = (x.scenario || x.picks) && x.best !== null && Number.isFinite(x.best) ? `（おすすめとの差 ${yen(shownManOf(x.value) - shownManOf(x.best))}）` : "";
  const sub = x.statusQuo !== null && Number.isFinite(x.statusQuo) ? `ずっと今のままなら ${yen(x.statusQuo, false)}（差 ${yen(shownManOf(x.value) - shownManOf(x.statusQuo))}）` : null;
  const label = x.scenario ? `${x.scenario}の方針` : x.picks ? "あなたの選び方" : "おすすめ";
  return { main: `${lead} ${value}${vsBest}`, lead, value, vsBest, sub, label };
}

/** 年収で今日の一番が入れ替わる所の文（「年収 540 万円より上なら『転職活動をする』がいちばん」） */
export function flipTexts(f: { below: { annual: number; alt: ID } | null; above: { annual: number; alt: ID } | null }, titleOf: (id: ID) => string): string[] {
  const out: string[] = [];
  if (f.above) out.push(`年収 ${n0(f.above.annual)} 万円より上なら『${titleOf(f.above.alt)}』がいちばん`);
  if (f.below) out.push(`年収 ${n0(f.below.annual)} 万円より下なら『${titleOf(f.below.alt)}』がいちばん`);
  return out;
}

/** 入力された年収（万円）。全角・カンマ・「万円」も読む。100〜3,000 万円の整数でなければ null */
export function parseAnnual(input: string, min = 100, max = 3000): number | null {
  const s = input
    .normalize("NFKC")
    .replace(/[,\s]/g, "")
    .replace(/万円?$/, "")
    .replace(/円$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const v = Math.round(Number(s));
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** 差の棒の範囲（0 を必ず含む。全部 0 なら 0〜1） */
export function divergingDomain(values: Array<number | null | undefined>): { lo: number; hi: number } {
  let lo = 0;
  let hi = 0;
  for (const v of values) {
    if (!isNum(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 1e-9) hi = lo + 1;
  return { lo, hi };
}

/** 差の棒の形（0〜1 の割合）: zero = 0 の位置、left・width = 棒（0 から値まで） */
export function divergingBar(v: number, d: { lo: number; hi: number }): { zero: number; left: number; width: number } {
  const span = d.hi - d.lo;
  const zero = -d.lo / span;
  const end = Math.max(0, Math.min(1, (v - d.lo) / span));
  return { zero, left: Math.min(zero, end), width: Math.abs(end - zero) };
}

/** 段（−4〜+4）の幅の言葉（「+30〜100万」「±3万未満」「−300万以下」） */
export function binRangeText(bin: number): string {
  const step = Math.abs(bin);
  if (step === 0) return `±${IMPACT_T[0]}万未満`;
  const sign = bin < 0 ? MINUS : "+";
  const lo = IMPACT_T[step - 1]!;
  const hi = IMPACT_T[step];
  if (hi === undefined) return `${sign}${groupDigits(lo)}万${bin < 0 ? "以下" : "以上"}`;
  return `${sign}${groupDigits(lo)}〜${groupDigits(hi)}万`;
}

export interface TrailStep {
  /** その結果に進んだ手（選択肢） */
  alt: ID;
  /** 結果の線 */
  edge: ID;
  /** 結果のノード */
  node: ID;
  /** 判断の線（測れる条件。「3 か月後の給与が今の 1.13 倍以上」）。どの場合もこの道なら "" */
  line: string;
  /** 結果の名前（「大きく上げて転職」） */
  label: string;
  /** その時（結果のノードの期限の年月） */
  when: string | null;
}

/**
 * 目印: 今日からそのノードまでの道で、運で分かれた所（結果の線）を今日から順に。
 * inc はノード → 入ってくる線の ID（graph の索引）、isChance はそのノードが結果の分かれ道（選択肢）か。
 * 合流では最初の線をたどる。範囲（inScope）の外・循環に入ったら止める
 */
export function trailOf(doc: DocData, inc: Map<ID, ID[]>, id: ID, isChance: (id: ID) => boolean, inScope?: (id: ID) => boolean): TrailStep[] {
  const out: TrailStep[] = [];
  const seen = new Set<ID>();
  let cur: ID | null = doc.nodes[id] ? id : null;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    let next: ID | null = null;
    for (const eid of inc.get(cur) ?? []) {
      const e = doc.edges[eid];
      if (!e || (e.relation !== "leads" && e.relation !== "condition") || e.source === e.target || !doc.nodes[e.source]) continue;
      if (inScope && !inScope(e.source)) continue;
      if (isChance(e.source)) {
        const line = (e.condition ?? "").trim();
        out.push({ alt: e.source, edge: e.id, node: cur, line: line === NO_LINE ? "" : line, label: (e.label ?? "").trim(), when: ymText(doc.nodes[cur]!.time.due) });
      }
      next = e.source;
      break;
    }
    cur = next;
  }
  return out.reverse();
}
