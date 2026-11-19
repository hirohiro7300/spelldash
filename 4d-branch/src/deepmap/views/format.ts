// 見取り図・手の詳しい画面・道の画面の言葉と数の書き方（DOM を使わない。テストで確かめる）
// 決まり: どの数にも単位と何の数かを付ける（万円・3 年の合計・月の稼ぎ・見込み %・使った年収）。
//         地図の鍵・手の種類の鍵・結果の鍵（英字の名前）は画面に出さない。

import { IMPACT_FILL, IMPACT_INK, impactBin, MINUS } from "../../model/impactFormat";
import { factLabel, ymText, type DeltaBasis, type MoveCounts } from "../core";
import type { MapData } from "../mapData";

/** 3 桁ごとに区切った整数（「79,092」） */
export function num(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const v = Math.round(x);
  const s = Math.abs(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return v < 0 ? `${MINUS}${s}` : s;
}

/** 万円の数の本体（10 未満は小数 1 桁、それ以上は整数） */
function manBody(a: number): string {
  return a < 9.95 ? (Math.round(a * 10) / 10).toFixed(1).replace(/\.0$/, "") : num(a);
}

/** 万円の水準（「1,269 万円」「4.1 万円」） */
export function man(x: number): string {
  if (!Number.isFinite(x)) return "—";
  return `${x < 0 && Math.abs(x) >= 0.05 ? MINUS : ""}${manBody(Math.abs(x))} 万円`;
}

/** 万円の差（必ず符号を付ける。「+22 万円」「−77 万円」「±0 万円」） */
export function manDelta(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a < 0.05) return "±0 万円";
  return `${x < 0 ? MINUS : "+"}${manBody(a)} 万円`;
}

/** 水準の幅（「1,159〜1,452 万円」。同じなら 1 つ） */
export function manRange(lo: number, hi: number): string {
  const a = man(lo).replace(/ 万円$/, "");
  const b = man(hi).replace(/ 万円$/, "");
  return a === b ? `${a} 万円` : `${a}〜${b} 万円`;
}

/** 差の幅（「+35〜+328 万円」） */
export function manDeltaRange(lo: number, hi: number): string {
  const a = manDelta(lo).replace(/ 万円$/, "");
  const b = manDelta(hi).replace(/ 万円$/, "");
  return a === b ? `${a} 万円` : `${a}〜${b} 万円`;
}

/** 月の稼ぎ（小数 1 桁。「42.6 万円」） */
export function manMonthly(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  const body = a < 999.95 ? (Math.round(a * 10) / 10).toFixed(1) : num(a);
  return `${x < 0 && a >= 0.05 ? MINUS : ""}${body} 万円`;
}

/** 見込み（0〜1 →「20%」。0 より大きく 0.5% 未満は「1% 未満」） */
export function pct(p: number): string {
  if (!(p > 0)) return "0%";
  if (p < 0.005) return "1% 未満";
  if (p > 0.995 && p < 1 - 1e-9) return "99%";
  return `${Math.round(p * 100)}%`;
}

/** 見込み（小数 1 桁。道の見込みなど小さい数: 「6.4%」） */
export function pct1(p: number): string {
  if (!(p > 0)) return "0%";
  const v = p * 100;
  if (v < 0.05) return "0.1% 未満";
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}%`;
}

/** 差の段の塗りと文字の色（アプリのカードの札と同じ） */
export function binColors(x: number | null): { bin: number; fill: string; ink: string } {
  const bin = x === null ? 0 : impactBin(x);
  return { bin, fill: IMPACT_FILL[bin] ?? IMPACT_FILL[0]!, ink: IMPACT_INK[bin] ?? "#F0EFEC" };
}

/** 段（−4〜+4）の幅の言葉（「+30〜100 万円」「±3 万円未満」「−300 万円以下」） */
export function binText(bin: number): string {
  const T = [3, 30, 100, 300];
  const step = Math.abs(bin);
  if (step === 0) return "±3 万円未満";
  const sign = bin < 0 ? MINUS : "+";
  const lo = T[step - 1]!;
  const hi = T[step];
  return hi === undefined ? `${sign}${lo} 万円${bin < 0 ? "以下" : "以上"}` : `${sign}${lo}〜${hi} 万円`;
}

/** 鍵（英数字と記号だけの名前）に見える */
export function looksLikeId(s: string): boolean {
  return /^[A-Za-z0-9_:.\-]+$/.test(s.trim());
}

/** 地図の名前を画面に出す形に（空・鍵に見える名前は代わりの言葉） */
export function safeName(s: string | null | undefined, fallback: string): string {
  const t = (s ?? "").trim();
  return t && !looksLikeId(t) ? t : fallback;
}

/** 手の種類の名前（今のままは「今のまま」。見出しに無い種類は「別の手」） */
export function kindName(map: MapData, kind: string): string {
  return safeName(map.header.kinds[kind]?.[0], "別の手");
}

/** 今日の手の名前（比べる元は「この 3 か月は今のまま」） */
export function moveName(map: MapData, kind: string, isBase: boolean): string {
  return isBase ? "この 3 か月は今のまま" : kindName(map, kind);
}

/** 結果の名前 */
export function outcomeName(map: MapData, i: number): string {
  return safeName(map.label(i), "その結果");
}

/** 事実の名前（会社の答え など） */
export function factName(fact: string): string {
  return factLabel(fact);
}

/** 0 か月目から m か月後の年月（地図の年月が読めなければ「m か月後」） */
export function ym(map: MapData, m: number): string {
  try {
    return ymText(map.header.anchor, m);
  } catch {
    return m === 0 ? "今月" : `${Math.round(m)} か月後`;
  }
}

/** 差の出し方の言葉 */
export function basisText(b: DeltaBasis): string {
  return b === "q" ? "同じ見積もり方" : "地図の値";
}

/** 差の出し方の説明（見方） */
export function basisNote(b: DeltaBasis): string {
  return b === "q"
    ? "差は、どの手も同じ見積もり方（その 3 か月は正確に、その後は標準の選び方で 2029 年 11 月まで）で比べた"
    : "差は地図の値で比べた（先を広げた手には、その先の選び直しの分も入る。同じ見積もり方の値は、計算の前提を直した木で入る）";
}

export const DELTA_LABEL = "今やる vs 3 か月待つ";
export const WORTH_LABEL = "3 年やらない場合との差";
/** 「この種類を 3 年やらない場合との差」をほぼ差なしと書く差（万円） */
export const WORTH_NOISE = 4;

/** この種類を 3 年やらない場合との差の言葉（4 万円未満は「ほぼ差なし」） */
export function worthText(k: number): string {
  return Math.abs(k) < WORTH_NOISE ? "ほぼ差なし" : manDelta(k);
}

/** 今日の手の分かれ道と行き先の数の 1 行の区切り（作業メモ truth-18・user-13 の言い方。折り返しは区切りの間で） */
export function countsParts(c: MoveCounts, endYm: string): string[] {
  return [`判断 ${num(c.decisions)} 回・出来事の分かれ ${num(c.splits)} `, `→ ${endYm}の行き先 ${num(c.reachEnds)}`, `（見込み 1% 以上 ${num(c.reachEnds1)}）・`, `標準の続きの見積もり ${num(c.sumEnds)}`];
}

/** 今日の手の分かれ道と行き先の数の 1 行 */
export function countsLine(c: MoveCounts, endYm: string): string {
  return countsParts(c, endYm).join("");
}

/** 今のままの先とほぼ同じ手の言葉 */
export const NEAR_KEEP_TEXT = "この手の先は『今のまま』の先とほぼ同じ（同じ手が 3 か月遅れで続く）";
/** 比べる元の言葉 */
export const BASE_TEXT = "比べる元: この 3 か月は今のまま、その後は一番良い選び方";
/** 見取り図の結び */
export const FOOTER_TEXT = "3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる";

/** 見込みの割合を「名前 20%」でつなぐ（「全部可 20%・SpellDash だけ 45%・どちらも不可 35%」） */
export function shareList(parts: readonly { label: string; share: number }[]): string {
  return parts.map((p) => `${p.label} ${pct(p.share)}`).join("・");
}

// ---- 画面の切り替え（ハッシュ。英字・数字・ハイフンだけ。claude.ai の予約名は使わない）

export type Route = { name: "overview" } | { name: "move"; slug: string } | { name: "path"; node: number };

/** 手の種類の鍵からハッシュの名前（「ad_permside」→「ad-permside」） */
export function kindSlug(kind: string): string {
  const s = kind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "move";
}

export function moveHash(kind: string): string {
  return `#move-${kindSlug(kind)}`;
}

export function pathHash(node: number): string {
  return `#path-${Math.max(0, Math.floor(node))}`;
}

export const OVERVIEW_HASH = "#overview";

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const mv = /^move-([a-z0-9-]+)$/.exec(h);
  if (mv) return { name: "move", slug: mv[1]! };
  const pt = /^path-(\d{1,9})$/.exec(h);
  if (pt) return { name: "path", node: Number(pt[1]) };
  return { name: "overview" };
}
