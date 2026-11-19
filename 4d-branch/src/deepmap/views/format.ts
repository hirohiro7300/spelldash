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

/** 月の稼ぎの差（小数 1 桁・符号つき。「+1.0 万円」「−0.4 万円」）。0.05 万円未満は null（変わらない） */
export function manMonthlyDelta(x: number): string | null {
  if (!Number.isFinite(x) || Math.abs(x) < 0.05) return null;
  const a = Math.abs(x);
  return `${x < 0 ? MINUS : "+"}${a < 999.95 ? (Math.round(a * 10) / 10).toFixed(1) : num(a)} 万円`;
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

/** 差の出し方の短い言葉（出し方の違う差が同じ画面に並ぶときだけ、差ごとに付ける。作業メモ user-10） */
export function basisText(b: DeltaBasis): string {
  return b === "q" ? "見積もり同士の差" : "その先の選び直しも入れた差";
}

/** 差の出し方の説明（どの差も同じ出し方のとき、画面に 1 回だけ出す） */
export function basisLine(b: DeltaBasis): string {
  return b === "q"
    ? "差はどれも、その 3 か月は正確に、その後は標準の選び方で 2029 年 11 月まで続けた見積もりどうしで比べた"
    : "差はどれも、その後に一番良い選び方をした場合の 3 年の稼ぎで比べた";
}

/** 差の出し方の説明（見方） */
export function basisNote(b: DeltaBasis): string {
  return b === "q"
    ? "差は、どの手も同じ見積もり方（その 3 か月は正確に、その後は標準の選び方で 2029 年 11 月まで）で比べた。おすすめの印・分布・道は、一番良い選び方で進んだ場合"
    : "差は、その後に一番良い選び方をした場合の 3 年の稼ぎで比べた（先を広げた手には、その先の選び直しの分も入る。どの手も同じ見積もり方で比べる差は、計算の前提を直した地図で入る）";
}

export const DELTA_LABEL = "今やる vs 3 か月待つ";
export const WORTH_LABEL = "3 年やらない場合との差";
/** 「この種類を 3 年やらない場合との差」をほぼ差なしと書く差の下限（万円。地図の誤差が大きければ overview の worthNoise） */
export const WORTH_NOISE = 4;

/**
 * この種類を 3 年やらない場合との差の言葉。noise 万円未満（マイナスも）は見積もりの誤差の範囲なので「ほぼ差なし」（作業メモ truth-4）。
 * その種類を除いて 3 年の値が上がることは無いので、マイナスの差を損のように書かない
 */
export function worthText(k: number, noise = WORTH_NOISE): string {
  return k < noise ? "ほぼ差なし" : manDelta(k);
}

/** 今日の手の分かれ道と行き先の数の 1 行の区切り（作業メモ truth-18・user-13 の言い方。折り返しは区切りの間で） */
export function countsParts(c: MoveCounts, endYm: string): string[] {
  return [`判断 ${num(c.decisions)} 回・出来事の分かれ ${num(c.splits)} `, `→ ${endYm}の行き先 ${num(c.reachEnds)}`, `（見込み 1% 以上 ${num(c.reachEnds1)}）・`, `標準の続きの見積もり ${num(c.sumEnds)}`];
}

/** 今日の手の分かれ道と行き先の数の 1 行 */
export function countsLine(c: MoveCounts, endYm: string): string {
  return countsParts(c, endYm).join("");
}

/**
 * 今のままの先とほぼ同じ手の言葉（その後のおすすめの手の分布の違い TV < 0.1 のときだけ。作業メモ truth-2）。
 * 「同じ手が 3 か月遅れで続く」とは書かない（今のままの後にその手が選ばれるとは限らない）
 */
export const NEAR_KEEP_TEXT = "この手の先は『今のまま』の先とほぼ同じ（この後のおすすめの手が『今のまま』の後とほぼ同じ。違うのは主にこの 3 か月）";
/** 事実を知る手の、今のままの先と近いことの注記（TV < 0.1 のときだけ） */
export const NEAR_KEEP_NOTE = "この手の先は『今のまま』の先と近い（この後のおすすめの手がほぼ同じ）";
/** 差は小さいが、その先の選び方は違う手の言葉（|差| < 5 万円で TV ≥ 0.1） */
export const SMALL_DELTA_TEXT = "3 年の稼ぎは『この 3 か月は今のまま』とほぼ同じ（差 5 万円未満）。この先の選び方は違う";

/** 比べる元の言葉（差の出し方に合わせる。作業メモ truth-7） */
export function baseText(b: DeltaBasis): string {
  return b === "q" ? "比べる元: この 3 か月は今のまま（差は、その後を標準の選び方で続けた見積もりどうしで比べる）" : "比べる元: この 3 か月は今のまま、その後は一番良い選び方";
}
/** 3 年の合計の幅の読み方（見取り図の最初・手の詳しい画面の見出し。作業メモ user-1） */
export const FRAME_TEXT = "3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる";

/** 見込みの割合を「名前 20%」でつなぐ（「全部可 20%・SpellDash だけ 45%・どちらも不可 35%」） */
export function shareList(parts: readonly { label: string; share: number }[]): string {
  return parts.map((p) => `${p.label} ${pct(p.share)}`).join("・");
}

/**
 * 道の合計が、そこから先の行き先の分布のどこにあるか（低い方からの位置 p。0〜1）の言葉（作業メモ user-2・truth-6）:
 * 「低い方から約 1 割」「真ん中あたり」「高い方から約 2 割」
 */
export function placeText(p: number): string {
  const d = Math.round(Math.max(0, Math.min(1, p)) * 10);
  if (d <= 0) return "低い方から 1 割未満";
  if (d >= 10) return "高い方から 1 割未満";
  if (d === 5) return "真ん中あたり";
  return d < 5 ? `低い方から約 ${d} 割` : `高い方から約 ${10 - d} 割`;
}

// ---- 画面の切り替え（ハッシュ。英字・数字・ハイフンだけ。claude.ai の予約名は使わない）
// 道は、カードの番号でなく鍵から作る短い名前で指す（#path-t<名前>）: 地図を作り直して番号がずれても、同じ鍵のカードを指す（作業メモ code-2）

export type Route = { name: "overview" } | { name: "move"; slug: string } | { name: "path"; token: string | null };

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

/**
 * カードの鍵から道のハッシュに使う短い名前（英小文字と数字。53 ビットの混ぜ合わせ cyrb53 の 36 進）。
 * 鍵が同じなら地図を作り直しても同じ。scripts/build-preview.mjs も同じ式で、地図の中に同じ名前が無いことを確かめる
 */
export function keyToken(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** そのカードを通る道の画面のハッシュ（#path-t<鍵の短い名前>） */
export function pathHash(map: MapData, node: number): string {
  return `#path-t${keyToken(map.key(Math.max(0, Math.floor(node))))}`;
}

/** 道のハッシュの短い名前 → カードの番号（地図ごとに 1 回だけ作る。同じ名前が 2 つあればその名前は使わない）。done 枚目まで作った */
const tokenIndex = new WeakMap<MapData, { idx: Map<string, number>; done: number }>();
function tokensUpTo(map: MapData, upto: number): { idx: Map<string, number>; done: number } {
  let x = tokenIndex.get(map);
  if (!x) tokenIndex.set(map, (x = { idx: new Map(), done: 0 }));
  const end = Math.min(map.n, upto);
  for (let i = x.done; i < end; i++) {
    const t = keyToken(map.key(i));
    x.idx.set(t, x.idx.has(t) ? -1 : i);
  }
  x.done = Math.max(x.done, end);
  return x;
}

export function findPathToken(map: MapData, token: string): number {
  return tokensUpTo(map, map.n).idx.get(token) ?? -1;
}

/** 道の名前の表を count 枚だけ先に作る（空いた時間に少しずつ。作り終えたら true） */
export function warmPathTokens(map: MapData, count: number): boolean {
  const x = tokensUpTo(map, (tokenIndex.get(map)?.done ?? 0) + Math.max(1, count));
  return x.done >= map.n;
}

export const OVERVIEW_HASH = "#overview";

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const mv = /^move-([a-z0-9-]+)$/.exec(h);
  if (mv) return { name: "move", slug: mv[1]! };
  const pt = /^path-t([0-9a-z]{1,12})$/.exec(h);
  if (pt) return { name: "path", token: pt[1]! };
  // 前の版の番号の道（#path-123）: 地図を作り直すと別のカードを指すので使わない（見取り図と知らせ）
  if (/^path-\d{1,9}$/.test(h)) return { name: "path", token: null };
  return { name: "overview" };
}
