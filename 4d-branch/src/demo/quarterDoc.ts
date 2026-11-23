// 3 か月ごと 12 段の「3 年の分かれ道」（版 7 から。読むだけの地図 MapData）を 4D Branch の文書に組み立てる、軽い組み立て（lean builder）。
// 設計: 作業メモ SPEC v1 §3.4・D9・§6（見直し perf-6・perf-7・safety-4・safety-6・safety-11・safety-14・gaps-2）。SPEC §3.4 の組み立ての口
// （buildImpactDoc(map, {version, release, at, layout}) と書いてある物）はこの buildQuarterDoc。
// 版 6 の地図（同梱の impact-data.json）は今までどおり ./impact.ts の buildImpactDoc。こちらはまだアプリの読み込みにつないでいない。
//
// 決まり（同じ地図と同じ opts なら、どの端末・どの時差でも同じ文書）:
//   ID    どの鍵も 64 ビット（n_i_ + fnv64x36(鍵)。深さで分けない: safety-6）。親からの線は e_i_ + 子の鍵の 64 ビットの指紋（線は子ごとに 1 本）。
//         やることの項目は c_ + ノードの 64 ビットの指紋 + _ + 番号。線と項目の指紋はノードの指紋と同じ物なので、ノードの ID が重ならなければ
//         どれも重ならない。重なれば（違う鍵が同じ指紋・同じ鍵が 2 回）QuarterDocError で止める（黙って 1 枚にしない）
//   日付  地図の 0 か月目 header.anchor（"YYYY-MM"）から、整数の月の計算だけで出す（Date も時差も使わない: safety-14）。
//         今日・状態・行き先の期限はその月の末日。手はその次の月の 1 日から 3 か月目の月の末日まで（2026-11 の今日の手は 12 月 1 日〜2 月 28 日。
//         計算の芯の「12 月〜2 月」と同じ数え方: src/deepmap/core/time.ts）
//   時刻  作ったカード・線・プロジェクト・シナリオ・文書の createdAt = updatedAt = opts.at（ISO の UTC）
//   本文  作ったカードは ""（文章は見せるときに組み立てる: SPEC D5）。やることは地図の todo から（文 → 条件の項目、元の番号 → meta.cites の同じ番号）
//   タグ  役割と月から、版 6 と同じ決まり（未来の道筋・3年・今日／選択肢／3か月後…33か月後（12 は 1年後）／3年後）。impactTagsOf と同じなので、
//         新しい版にしたとき同梱のタグと利用者のタグを見分けられる（gaps-15 のタグの決まり）
//   線    結果の線の説明は地図の結果の名前（「—」= どの場合もこの道 は空。版 6 と同じ）、条件は判断の線の文。手への線のシナリオは手の種類の物（今のままは空）
//   位置  layout "none"（既定）は x = y = 0。"columns" は月から x（3 か月で 700: 判断 → 手 300・手 → 結果 400。impactLayout.ts の IMPACT_X と
//         同じ幅で、まとめた行き先は 36 か月目の列）、y = 0。並べるのはアプリ（全部を開いた形の outlineLayout はしない: perf-7）。どちらも整数なので、
//         整数のずらし（dx・dy）を足しても normalizeDoc の 0.01 の丸めで変わらない
//
// 軽さ（perf-6・perf-7）: 1 枚ごとに物を広げて写さない（{...x} を使わない）。同じ中身の部品（期限・タグ・プロジェクト・シナリオ・状態・月の稼ぎ・
//   判断の線・事実・幅・元の番号・やることの指紋・空の配列）は 1 つを共有し、開発とテストの組み立てでは凍らせる（書き換える所があればすぐ止まる）。
//   同じ中身かは数の指紋（数のビットと文字から）で引き、同じ指紋の中だけ中身で比べる（鍵の文字を作らない）。題名・短い名前・線の説明と条件も、
//   同じ文字は 1 つの文字列にする（開発用の木は、同じ文字でもカードごとに別の文字列のことがある）。題名の指紋 t0 は題名ごとに 1 回だけ数える。
//   やること（手ごとに 3 項目・8 万枚で約 10 万項目）は、地図の todo(i) が返す配列ごとに 1 回だけ数える（同梱データの読み手は同じ並びの手に
//   同じ凍らせた配列を返す: ./impactBundle.ts）: 文は同じ文字を 1 つ・元の番号の並び（cites）と文の指紋の並び（k0）は共有・文の指紋は文ごとに 1 回。
//   ID（ノード・線・やることの項目）は鍵の指紋の 36 進の文字の番号から 1 つの文字列で作る（つないだ文字列にしない。見直し perf-1・perf-3）。
//   共有する部品は書き換えない約束（ストアは新しい物に入れ替える: store.ts の updateNode）。カードと線と meta は 1 枚ごとの物。
//   normalizeDoc を通すと共有が外れて重くなるので、組み立てた文書は通さずに使う（通しても何も変わらないことはテストで確かめる）。
//   測った値（毎回読み直した地図から。tests/unit/quarterDocFull.test.ts の目標は 400 ms・100 MB。どちらも 3 回のうち一番良い値）:
//     node・開発の組み立て（凍らせる）: 文を入れた版 7 の候補（77,735 枚・やること 105,825 項目）で 組み立て 約 300〜340 ms・文書のヒープ 約 75 MB
//     （直す前は 420〜530 ms・90 MB）、文の無い候補（72,402 枚）で 約 260〜335 ms・約 60 MB。
//     Chrome（本番の組み立て）: 文を入れた候補で 冷えた 1 回目 約 300〜400 ms・ヒープ 約 48 MB、CPU 4 倍遅くして 約 1.6〜1.8 秒
//
// meta（アプリの src/model/**（forecast・impact・forks・impactRank・impactText・impactLayout）が今の地図で読む名前と同じ。
// SPEC §9 I-doc の変更つき: impact.v は 2 のまま・入口に anchor・手に q・まとめた行き先は sum。行き先の mix と cont は写さず、地図から引く）:
//   今日     forecastRoot・futureVersion（header.hash）・futureRelease（header.release）・impact {v: 2, horizon}・anchor・textVersion・never・fams・
//            fork "decision"・m 0・short・st・rr・key・t0・b0
//   手       fork "chance"・m・ak・fam・h・why・stub・base・cites・rank・short・key・t0・b0・k0・q（why・stub・base・cites・k0・q はある物だけ）
//   状態     fork "decision"・m・short・st・rr・band・rank・key・t0・b0（band はある物だけ）
//   行き先   end・sum・m・short・st・rr・band・rank・key・t0・b0（sum・band はある物だけ。mix と cont は map.indexOfKey(key) から）
//   結果の線 prob・r・ln・rv・p0・c0（ln・rv はある物だけ） / 手への線 c0
//   指紋（新しい版にしたとき、利用者が書き換えた所を見分ける: futureSwap.ts と同じ作り）: t0 = fnv36(題名)・b0 = fnv36(本文)・k0 = やることの文ごとの fnv36・
//   p0 = 元の見込み・c0 = edgeTextPrint(線の説明, 条件)

import type { MapBand, MapData, MapRole, MapTodo } from "../deepmap/mapData";
import { isDateStr } from "../model/dates";
import { SCHEMA, SCHEMA_VERSION } from "../model/schema";
import type { Condition, DocData, GEdge, GNode, ID, Meta, NodeTime, NodeType, Project, Scenario } from "../model/types";
import type { BundleMapData } from "./impactBundle";
import { quarterIdTable } from "./quarterIds";
import { edgeTextPrint, fnv36, fnv64x36, IMPACT_AREAS, IMPACT_SCENARIOS, IMPACT_TITLE, impactTagsOf, type ImpactLine, type ImpactSt, type R3 } from "./impact";

export type QuarterLayout = "none" | "columns";

export interface QuarterDocOpts {
  /** 同梱データの版（中身の指紋）。地図の header.hash と同じであること（入口の futureVersion） */
  version: string;
  /** 版の順番。地図の header.release と同じであること（入口の futureRelease） */
  release: number;
  /** 組み立てた時刻（1970 年からのミリ秒）。作った物の createdAt・updatedAt */
  at: number;
  /** 位置の決め方（既定 "none"） */
  layout?: QuarterLayout;
}

/** 組み立てられない地図（ID の重なり・版の食い違い・知らない手の種類など。黙って組み立てない） */
export class QuarterDocError extends Error {
  override name = "QuarterDocError";
}

/** 手の長さ（か月）。どの手も 3 か月（SPEC §2.1） */
export const QUARTER_MONTHS = 3;
/** 列の幅: 3 か月で 700（判断 → 手 300・手 → 結果 400。impactLayout.ts の IMPACT_X と同じ） */
export const QUARTER_COL = 700;
export const QUARTER_OPTION_X = 300;

/** 列の位置（layout "columns"）: 今日・状態・行き先はその月の列、手はその判断の列の 300 右（整数） */
export function quarterColumnX(role: MapRole, month: number): number {
  return Math.round((month * QUARTER_COL) / QUARTER_MONTHS) + (role === "a" ? QUARTER_OPTION_X : 0);
}

// ---- 日付（整数の月の計算だけ）

const ANCHOR_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
const leap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** "YYYY-MM" を通しの月（年 × 12 + 月 − 1）に。読めなければ投げる */
function anchorIndex(anchor: string): number {
  const m = ANCHOR_RE.exec(anchor);
  if (!m) throw new QuarterDocError(`地図の年月が "YYYY-MM" ではありません: ${anchor}`);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

/** 通しの月 t の 1 日・末日（YYYY-MM-DD） */
function dayOf(t: number, end: boolean): string {
  const y = Math.floor(t / 12);
  const mo = t - y * 12;
  const d = !end ? 1 : mo === 1 && leap(y) ? 29 : DAYS[mo]!;
  return `${y}-${pad2(mo + 1)}-${pad2(d)}`;
}

/** 地図の年月 anchor から off か月後の月の末日（YYYY-MM-DD。整数の月の計算だけ。時差に依らない） */
export function anchorMonthEnd(anchor: string, off: number): string {
  return dayOf(anchorIndex(anchor) + Math.floor(off), true);
}

/** 地図の年月 anchor から off か月後の月の 1 日（YYYY-MM-DD） */
export function anchorMonthStart(anchor: string, off: number): string {
  return dayOf(anchorIndex(anchor) + Math.floor(off), false);
}

// ---- 共有する部品（中身ごとに 1 つ。数の指紋で引き、同じ指紋の中は中身で比べる。鍵の文字を作らない）

/** 開発とテストの組み立て（本番のビルドでは Vite が false にする）では、共有する部品を凍らせる */
const FREEZE: boolean = import.meta.env.DEV === true;
/** 凍らせる（開発とテストだけ。本番はそのまま返す。入れ子は作る所で先に凍らせる） */
const fz = <T>(x: T): T => (FREEZE ? Object.freeze(x) : x);

const PRIME = 0x01000193;
const SEED = 0x811c9dc5;
const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
/** 指紋に数を足す（数のビットそのまま。−0 と 0 も別の指紋） */
function hNum(h: number, x: number): number {
  F64[0] = x;
  return Math.imul(Math.imul(h ^ U32[0]!, PRIME) ^ U32[1]!, PRIME);
}
/** 指紋に文字を足す（最後に文字に無い印を足すので、"ab"+"c" と "a"+"bc" は別の指紋） */
function hStr(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), PRIME);
  return Math.imul(h ^ 0x10000, PRIME);
}
/** 指紋に小さな印（null・ある無しなど）を足す */
const hTag = (h: number, t: number): number => Math.imul(h ^ (0x20000 + t), PRIME);

const sameNums = (a: number, b: number): boolean => Object.is(a, b);
function sameStrs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 中身ごとに 1 つだけ作って共有する入れ物（指紋で引き、同じ指紋の中は same で比べる。無ければ make で作る） */
class Pool<T> {
  private readonly m = new Map<number, T[]>();
  constructor(
    private readonly same: (a: T, b: T) => boolean,
    private readonly make: (x: T) => T,
  ) {}
  of(h: number, x: T): T {
    const b = this.m.get(h);
    if (b !== undefined) for (let k = 0; k < b.length; k++) if (this.same(b[k]!, x)) return b[k]!;
    const v = this.make(x);
    if (b !== undefined) b.push(v);
    else this.m.set(h, [v]);
    return v;
  }
}

function hashSt(s: ImpactSt): number {
  let h = hStr(hStr(SEED, s.j), s.pm);
  h = hNum(hNum(hNum(hNum(h, s.pro), s.mau), s.pu), s.seats);
  h = hNum(hNum(hNum(hNum(h, s.cl), s.fee), s.sal), s.cv);
  for (let i = 0; i < s.fl.length; i++) h = hStr(h, s.fl[i]!);
  return hTag(h, s.fl.length);
}
const sameSt = (a: ImpactSt, b: ImpactSt): boolean =>
  a.j === b.j &&
  a.pm === b.pm &&
  sameNums(a.pro, b.pro) &&
  sameNums(a.mau, b.mau) &&
  sameNums(a.pu, b.pu) &&
  sameNums(a.seats, b.seats) &&
  sameNums(a.cl, b.cl) &&
  sameNums(a.fee, b.fee) &&
  sameNums(a.sal, b.sal) &&
  sameNums(a.cv, b.cv) &&
  sameStrs(a.fl, b.fl);
const hashR3 = (r: R3): number => hNum(hNum(hNum(SEED, r[0]), r[1]), r[2]);
const sameR3 = (a: R3, b: R3): boolean => sameNums(a[0], b[0]) && sameNums(a[1], b[1]) && sameNums(a[2], b[2]);
function hashLn(l: ImpactLine): number {
  let h = hNum(hStr(SEED, l[0]), l[1]);
  h = l[2] === null ? hTag(h, 0) : hNum(hTag(h, 1), l[2]);
  h = l[3] === null ? hTag(h, 0) : hNum(hTag(h, 1), l[3]);
  return l.length > 4 ? hStr(hTag(h, 2), String(l[4])) : hTag(h, 3);
}
const sameLn = (a: ImpactLine, b: ImpactLine): boolean =>
  a.length === b.length && a[0] === b[0] && sameNums(a[1], b[1]) && (a[2] === null ? b[2] === null : b[2] !== null && sameNums(a[2], b[2])) && (a[3] === null ? b[3] === null : b[3] !== null && sameNums(a[3], b[3])) && a[4] === b[4];
const hashPair = (h: number, p: [number, number] | undefined): number => (p ? hNum(hNum(hTag(h, 1), p[0]), p[1]) : hTag(h, 0));
const samePair = (a: [number, number] | undefined, b: [number, number] | undefined): boolean => (a ? !!b && sameNums(a[0], b[0]) && sameNums(a[1], b[1]) : !b);
function hashStrs(xs: readonly string[]): number {
  let h = SEED;
  for (let i = 0; i < xs.length; i++) h = hStr(h, xs[i]!);
  return hTag(h, xs.length);
}

const ROLES: readonly MapRole[] = ["r", "a", "s", "e"];
const ROLE_TYPE: readonly NodeType[] = ["goal", "action", "branch", "result"];

const b36x7 = (h: number): string => (h >>> 0).toString(36).padStart(7, "0");

/**
 * やることの項目の ID: c_ + ノードの指紋 14 文字（ノードの ID の 5 文字目から）+ _ + 番号。初めから 1 つの文字列で作る（つないだ文字列は、
 * 名前に使うときと書き出すときに 1 つにし直すので、時間とメモリを食う。見直し perf-1）
 */
function condId(id: string, t: number): string {
  const L = (k: number): number => id.charCodeAt(4 + k);
  if (t < 10) return String.fromCharCode(99, 95, L(0), L(1), L(2), L(3), L(4), L(5), L(6), L(7), L(8), L(9), L(10), L(11), L(12), L(13), 95, 48 + t);
  const codes = [99, 95];
  for (let k = 0; k < 14; k++) codes.push(L(k));
  codes.push(95);
  for (const ch of String(t)) codes.push(ch.charCodeAt(0));
  return String.fromCharCode(...codes);
}

/** 線の説明と条件の指紋（./impact.ts の edgeTextPrint と同じ値。つないだ文字を作らずに数える） */
function textPrint(label: string, condition: string): string {
  let h = SEED;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), PRIME);
  h = Math.imul(h, PRIME);
  for (let i = 0; i < condition.length; i++) h = Math.imul(h ^ condition.charCodeAt(i), PRIME);
  return (h >>> 0).toString(36);
}

/** 入口の never・fams の名前（組み込みの名前は、写すと持ち物でなく型を変えてしまい、normalizeDoc も落とすので止める） */
function ownKey(k: string): string {
  if (k === "__proto__" || k === "constructor" || k === "prototype") throw new QuarterDocError(`地図の入口に使えない名前があります: ${k}`);
  return k;
}

/** 地図の今日のカードの ID（入口） */
export function quarterRootId(map: MapData): ID {
  return `n_i_${fnv64x36(map.key(0))}`;
}

/**
 * 3 か月ごとの地図（MapData）から文書を組み立てる（同じ地図と同じ opts なら同じ文書）。
 * 投げる物: QuarterDocError（版の食い違い・地図の年月・ID の重なり・知らない手の種類と領域とシナリオ・木の形）
 */
export function buildQuarterDoc(map: MapData, opts: QuarterDocOpts): DocData {
  const p = buildQuarterParts(map, opts);
  // 入れ物には番号の順に入れる（カード → 線。どちらも今日から深さ優先の番号の順。保存の基準 ../persist/thinMap.ts もこの順を前提にする）
  const nodes = p.doc.nodes;
  const edges = p.doc.edges;
  for (let i = 0; i < p.nodes.length; i++) nodes[p.ids[i]!] = p.nodes[i]!;
  for (let i = 1; i < p.edges.length; i++) {
    const e = p.edges[i]!;
    edges[e.id] = e;
  }
  return p.doc;
}

/**
 * 組み立てた物を番号ごとの並びで（文書の nodes・edges の入れ物は空のまま）。保存の基準（../persist/thinMap.ts）は入れ物を作らずにこれを使う
 * （8 万枚の入れ物を作って読み直すと、それだけで起動が遅く、ヒープも増える: 見直し perf-1・perf-6）。buildQuarterDoc はこれを入れ物に入れた物
 */
export interface QuarterParts {
  /** 文書（nodes・edges は空の入れ物。ほかは buildQuarterDoc と同じ） */
  doc: DocData;
  /** 番号ごとのカード */
  nodes: GNode[];
  /** 番号ごとの親からの線（今日は null） */
  edges: Array<GEdge | null>;
  /** 番号ごとのカードの ID（./quarterIds.ts の地図ごとの物。書き換えない） */
  ids: readonly ID[];
}

/** buildQuarterDoc と同じ組み立てを、番号ごとの並びで返す（同じ地図と同じ opts なら buildQuarterDoc と同じ物） */
export function buildQuarterParts(map: MapData, opts: QuarterDocOpts): QuarterParts {
  const h = map.header;
  if (opts.version !== h.hash) throw new QuarterDocError(`版（${opts.version}）が地図の中身の指紋（${h.hash}）と違います`);
  if (opts.release !== h.release) throw new QuarterDocError(`版の順番（${opts.release}）が地図の版の順番（${h.release}）と違います`);
  if (!Number.isFinite(opts.at)) throw new QuarterDocError(`組み立てた時刻が数ではありません: ${opts.at}`);
  if (!(Number.isInteger(h.horizon) && h.horizon > 0)) throw new QuarterDocError(`地図の期間が正の整数ではありません: ${h.horizon}`);
  const a0 = anchorIndex(h.anchor);
  const at = new Date(opts.at).toISOString();
  const columns = (opts.layout ?? "none") === "columns";
  const n = map.n;
  if (!(Number.isInteger(n) && n >= 1)) throw new QuarterDocError(`地図のカードの数が違います: ${n}`);

  // 文書の入れ物（ID は地図の版と時刻から決める: 同じ組み立ては同じ ID、別の時刻の組み立ては別の ID）
  const doc: DocData = {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    id: `d_i_${fnv64x36(`${h.hash}\u0000${h.release}\u0000${opts.at}`)}`,
    title: h.title || IMPACT_TITLE,
    createdAt: at,
    updatedAt: at,
    projects: {},
    scenarios: {},
    nodes: {},
    edges: {},
    projectOrder: [],
    scenarioOrder: [],
    meta: {},
  };
  for (const a of Object.values(IMPACT_AREAS)) {
    const p: Project = { id: a.id, name: a.name, color: a.color, description: a.description, createdAt: at, updatedAt: at, meta: {} };
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
  }
  for (const s of IMPACT_SCENARIOS) {
    const sc: Scenario = { id: s.id, name: s.name, color: s.color, description: s.description, createdAt: at, updatedAt: at, meta: {} };
    doc.scenarios[sc.id] = sc;
    doc.scenarioOrder.push(sc.id);
  }

  // 共有する部品（この文書の中だけで共有する）
  const EMPTY: never[] = fz([]);
  const ALL: ID[] = fz(doc.projectOrder.slice());
  const AREA_IDS: Record<string, ID[]> = {};
  for (const [k, a] of Object.entries(IMPACT_AREAS)) AREA_IDS[k] = fz([a.id]);
  const B0 = fnv36("");
  const C0_NONE = edgeTextPrint("", "");
  const listPool = new Pool<string[]>(sameStrs, (xs) => fz(xs.slice()));
  // 状態の印の並び fl も、同じ並びは 1 つ（状態ごとに写さない）
  const stPool = new Pool<ImpactSt>(sameSt, (s) => fz({ j: s.j, pm: s.pm, pro: s.pro, mau: s.mau, pu: s.pu, seats: s.seats, cl: s.cl, fee: s.fee, sal: s.sal, cv: s.cv, fl: s.fl.length ? listPool.of(hashStrs(s.fl), s.fl) : EMPTY }));
  const r3Pool = new Pool<R3>(sameR3, (r) => fz([r[0], r[1], r[2]]));
  const lnPool = new Pool<ImpactLine>(sameLn, (l) => fz(l.length > 4 ? [l[0], l[1], l[2], l[3], l[4]] : [l[0], l[1], l[2], l[3]]));
  const rvPool = new Pool<[string, string]>(
    (a, b) => a[0] === b[0] && a[1] === b[1],
    (x) => fz([x[0], x[1]]),
  );
  const bandPool = new Pool<MapBand>(
    (a, b) => samePair(a.cl, b.cl) && samePair(a.pu, b.pu),
    (b) => {
      const o: MapBand = {};
      if (b.cl) o.cl = fz([b.cl[0], b.cl[1]]);
      if (b.pu) o.pu = fz([b.pu[0], b.pu[1]]);
      return fz(o);
    },
  );
  // 同梱データの読み手の、同じ中身の行の番号ごとの共有の部品（無ければ中身で引く）
  const rowKey = (map as Partial<BundleMapData>).rowKey;
  const stBy: ImpactSt[] = [];
  const rrBy: R3[] = [];
  const bandBy: MapBand[] = [];
  const lnBy: ImpactLine[] = [];
  const rvBy: Array<[string, string]> = [];
  // 期限とタグ（役割と月ごと）
  const optTime = new Map<number, NodeTime>();
  const outTime = new Map<number, NodeTime>();
  const timeOf = (option: boolean, m: number): NodeTime => {
    const pool = option ? optTime : outTime;
    const hit = pool.get(m);
    if (hit) return hit;
    // 今日・状態・行き先はその月の末日、手は次の月の 1 日から 3 か月目の末日まで
    const t: NodeTime = option ? { due: dayOf(a0 + m + QUARTER_MONTHS, true), start: dayOf(a0 + m + 1, false) } : { due: dayOf(a0 + m, true), start: null };
    if (!Number.isInteger(m) || !isDateStr(t.due) || (t.start !== null && !isDateStr(t.start))) throw new QuarterDocError(`地図の年月 ${h.anchor} から ${m} か月後の日付が使える範囲の外です`);
    pool.set(m, fz(t));
    return t;
  };
  const tagMaps = [new Map<number, string[]>(), new Map<number, string[]>(), new Map<number, string[]>(), new Map<number, string[]>()];
  /** タグ: 役割と月から（impactTagsOf と同じ。新しい版にしたとき、同梱のタグと利用者のタグを見分ける物と食い違わない）。同じ並びは 1 つ */
  const tagsOf = (code: number, m: number): string[] => {
    const pool = tagMaps[code]!;
    let t = pool.get(m);
    if (!t) {
      const tags = impactTagsOf(code === 0 ? { forecastRoot: true } : code === 3 ? { end: true, m } : code === 1 ? { ak: "", m } : { m });
      pool.set(m, (t = listPool.of(hashStrs(tags), tags)));
    }
    return t;
  };
  const kindInfo = new Map<string, { fam: string; projectIds: ID[]; scenarioIds: ID[] }>();
  const kindOf = (kind: string): { fam: string; projectIds: ID[]; scenarioIds: ID[] } => {
    let x = kindInfo.get(kind);
    if (x) return x;
    const kd = Object.hasOwn(h.kinds, kind) ? h.kinds[kind] : undefined;
    const area = kd?.[1] ?? "base";
    const projectIds = area === "base" ? ALL : AREA_IDS[area];
    if (!projectIds) throw new QuarterDocError(`手の種類 ${kind} の領域 ${area} を知りません`);
    const scen = kd?.[3] ?? [];
    for (const s of scen) if (!doc.scenarios[s]) throw new QuarterDocError(`手の種類 ${kind} のシナリオ ${s} を知りません`);
    x = { fam: kd?.[2] ?? kind, projectIds, scenarioIds: scen.length ? listPool.of(hashStrs(scen), scen) : EMPTY };
    kindInfo.set(kind, x);
    return x;
  };

  // 鍵 → 64 ビットの指紋（./impact.ts の fnv64x36 と同じ計算）と ID は、地図ごとに 1 度だけ数えた物（./quarterIds.ts。見え方の地図の画面・
  // エンジンも同じ物を使う）。重なれば止める（違う鍵が同じ指紋・同じ鍵が 2 回）。重なりは 2 つの 32 ビットの開いた番地の表で確かめる
  // （文字の鍵の表を作らない）。役割と、兄弟の中の順番（深さ優先の番号では、兄弟は並べる順に出てくる）
  const tab = quarterIdTable(map);
  const keys = tab.keys;
  const ids = tab.node;
  const eids = tab.edge;
  const H1 = tab.h1;
  const H2 = tab.h2;
  const roles = new Int8Array(n);
  const rank = new Int32Array(n);
  const fill = new Int32Array(n);
  let cap = 2;
  while (cap < n * 2) cap *= 2;
  const mask = cap - 1;
  /** 指紋の表（番地ごとに番号 + 1。0 は空き） */
  const slots = new Int32Array(cap);
  for (let i = 0; i < n; i++) {
    const key = keys[i]!;
    const role = map.role(i);
    const code = role === "r" ? 0 : role === "a" ? 1 : role === "s" ? 2 : role === "e" ? 3 : -1;
    if (code < 0) throw new QuarterDocError(`知らない役割です: ${String(role)}（${key}）`);
    roles[i] = code;
    const p = map.parent(i);
    if (i === 0) {
      if (p !== -1 || code !== 0) throw new QuarterDocError("地図の先頭が今日（r）ではありません");
    } else {
      if (!(Number.isInteger(p) && p >= 0 && p < i)) throw new QuarterDocError(`親がカードより前にありません: ${key}`);
      const pc = roles[p]!;
      if (code === 0 || (code === 1 ? pc !== 0 && pc !== 2 : pc !== 1)) throw new QuarterDocError(`カードの親の役割が違います: ${key}（${role} の親が ${ROLES[pc]}）`);
      rank[i] = fill[p]!++;
    }
    const h1 = H1[i]!;
    const h2 = H2[i]!;
    let at = Math.imul(h1, 0x9e3779b1) >>> 0;
    for (;;) {
      at &= mask;
      const j = slots[at]! - 1;
      if (j < 0) break;
      if (H1[j] === h1 && H2[j] === h2) {
        const other = keys[j]!;
        const hx = b36x7(h1) + b36x7(h2);
        throw new QuarterDocError(other === key ? `同じ鍵のカードが 2 枚あります: ${key}` : `カードの ID が重なりました（64 ビットの指紋が同じ）: ${other} と ${key}（${hx}）`);
      }
      at++;
    }
    slots[at] = i + 1;
  }
  for (let i = 0; i < n; i++) {
    if (fill[i] !== map.childCount(i)) throw new QuarterDocError(`子の数が合いません（深さ優先の並びでない）: ${keys[i]}`);
    if (i > 0 && map.child(map.parent(i), rank[i]!) !== i) throw new QuarterDocError(`兄弟の並びが番号の順と違います: ${keys[i]}`);
  }

  // 文字は同じ物を 1 つに（地図の問いは呼ぶたびに新しい文字を返す）。題名はその指紋 t0 と一緒に
  const titles = new Map<string, { s: string; t0: string }>();
  const strs = new Map<string, string>();
  const str = (x: string): string => {
    const hit = strs.get(x);
    if (hit !== undefined) return hit;
    strs.set(x, x);
    return x;
  };
  // やること: 地図の todo(i) が返す配列ごとに、文（同じ文字は 1 つ）・元の番号の並び（meta.cites）・文の指紋の並び（meta.k0）を 1 回だけ作る。
  // 同梱データの読み手は同じ並びの手に同じ配列を返すので（./impactBundle.ts）、手ごとに数え直さない。文の指紋は文ごとに 1 回（見直し perf-1・perf-3）。
  // 開発用の木（fromDevTree）は手ごとに別の配列なので、手ごとに作る（答えは同じ）
  const todoMemo = new Map<readonly MapTodo[], { texts: string[]; cites: string[]; k0: string[] }>();
  const textPrints = new Map<string, string>();
  const todoOf = (todo: readonly MapTodo[]): { texts: string[]; cites: string[]; k0: string[] } => {
    let x = todoMemo.get(todo);
    if (x !== undefined) return x;
    const texts = new Array<string>(todo.length);
    const cites = new Array<string>(todo.length);
    const prints = new Array<string>(todo.length);
    for (let t = 0; t < todo.length; t++) {
      const item = todo[t]!;
      const text = str(item.text);
      let pr = textPrints.get(text);
      if (pr === undefined) textPrints.set(text, (pr = fnv36(text)));
      texts[t] = text;
      cites[t] = item.cite;
      prints[t] = pr;
    }
    x = { texts, cites: listPool.of(hashStrs(cites), cites), k0: listPool.of(hashStrs(prints), prints) };
    todoMemo.set(todo, x);
    return x;
  };
  /** 線の説明と条件の指紋 c0（説明 → 条件 → 指紋。同じ組は 1 回だけ数える） */
  const c0Memo = new Map<string, Map<string, string>>();
  const c0Of = (label: string, condition: string): string => {
    let byLine = c0Memo.get(label);
    if (byLine === undefined) c0Memo.set(label, (byLine = new Map<string, string>()));
    let c0 = byLine.get(condition);
    if (c0 === undefined) byLine.set(condition, (c0 = textPrint(label, condition)));
    return c0;
  };

  const nodes = new Array<GNode>(n);
  const edges = new Array<GEdge | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    const code = roles[i]!;
    const m = map.month(i);
    const key = keys[i]!;
    const tx = map.title(i);
    let tt = titles.get(tx);
    if (tt === undefined) titles.set(tx, (tt = { s: tx, t0: fnv36(tx) }));
    const title = tt.s;
    const t0 = tt.t0;
    const short = str(map.short(i));
    const id = ids[i]!;
    let meta: Meta;
    let conditions: Condition[] = EMPTY;
    let projectIds = ALL;
    /** 手への線のシナリオ（今のままは空 = どの方針でも選べる） */
    let edgeScen: ID[] = EMPTY;
    if (code === 1) {
      const k = map.kind(i);
      if (typeof k !== "string" || !k) throw new QuarterDocError(`手の種類がありません: ${key}`);
      const info = kindOf(k);
      const base = map.isBase(i);
      projectIds = info.projectIds;
      if (!base) edgeScen = info.scenarioIds;
      meta = { fork: "chance", m, ak: k, fam: info.fam, h: map.hours(i) };
      const why = map.why(i);
      if (why !== null) meta.why = why;
      if (map.stub(i)) meta.stub = true;
      if (base) meta.base = true;
      const todo = map.todo(i);
      let k0: string[] | null = null;
      if (todo.length) {
        const td = todoOf(todo);
        conditions = new Array<Condition>(todo.length);
        for (let t = 0; t < todo.length; t++) conditions[t] = { id: condId(id, t), text: td.texts[t]!, met: false };
        meta.cites = td.cites;
        k0 = td.k0;
      }
      meta.rank = rank[i]!;
      meta.short = short;
      meta.key = key;
      meta.t0 = t0;
      meta.b0 = B0;
      if (k0) meta.k0 = k0;
      const q = map.q(i);
      if (q) meta.q = [q[0], q[1], q[2]];
    } else {
      let st: ImpactSt;
      let rr: R3;
      if (rowKey) {
        // 同梱データの読み手: 同じ中身の行は同じ番号（中身を作って数えて比べるのは番号ごとに 1 回）
        const ks = rowKey.call(map, i, "st");
        st = stBy[ks] ??= ((s0) => stPool.of(hashSt(s0), s0))(map.st(i));
        const kr = rowKey.call(map, i, "rr");
        rr = rrBy[kr] ??= ((r0) => r3Pool.of(hashR3(r0), r0))(map.rr(i));
      } else {
        const s0 = map.st(i);
        st = stPool.of(hashSt(s0), s0);
        const r0 = map.rr(i);
        rr = r3Pool.of(hashR3(r0), r0);
      }
      if (code === 0) {
        const never: Record<string, R3> = {};
        for (const f of Object.keys(h.never)) {
          const v = h.never[f]!;
          never[ownKey(f)] = fz([v[0], v[1], v[2]]);
        }
        const fams: Record<string, string> = {};
        for (const f of Object.keys(h.fams)) fams[ownKey(f)] = h.fams[f]!;
        meta = {
          forecastRoot: true,
          futureVersion: h.hash,
          futureRelease: h.release,
          impact: { v: 2, horizon: h.horizon },
          anchor: h.anchor,
          textVersion: h.textVersion,
          never: fz(never),
          fams: fz(fams),
          fork: "decision",
          m: 0,
          short,
          st,
          rr,
          key,
          t0,
          b0: B0,
        };
      } else {
        const kb = rowKey ? rowKey.call(map, i, "band") : -1;
        let band: MapBand | null;
        if (kb === 0) band = null;
        else if (kb > 0 && bandBy[kb] !== undefined) band = bandBy[kb]!;
        else {
          const b0 = map.band(i);
          band = b0 ? bandPool.of(hashPair(hashPair(SEED, b0.cl), b0.pu), b0) : null;
          if (kb > 0 && band) bandBy[kb] = band;
        }
        const r = rank[i]!;
        if (code === 2) meta = band ? { fork: "decision", m, short, st, rr, band, rank: r, key, t0, b0: B0 } : { fork: "decision", m, short, st, rr, rank: r, key, t0, b0: B0 };
        else if (map.sum(i)) meta = band ? { end: true, sum: true, m, short, st, rr, band, rank: r, key, t0, b0: B0 } : { end: true, sum: true, m, short, st, rr, rank: r, key, t0, b0: B0 };
        else meta = band ? { end: true, m, short, st, rr, band, rank: r, key, t0, b0: B0 } : { end: true, m, short, st, rr, rank: r, key, t0, b0: B0 };
      }
    }
    const node: GNode = {
      id,
      type: ROLE_TYPE[code]!,
      title,
      body: "",
      status: "open",
      time: timeOf(code === 1, m),
      conditions,
      tags: tagsOf(code, m),
      projectIds,
      scenarioIds: EMPTY,
      x: columns ? quarterColumnX(ROLES[code]!, m) : 0,
      y: 0,
      collapsed: false,
      createdAt: at,
      updatedAt: at,
      meta,
    };
    nodes[i] = node;
    if (code === 0) continue;
    // 親からの線（子の鍵の指紋。ノードの ID が重ならないので線も重ならない）
    const eid = eids[i]!;
    const source = ids[map.parent(i)]!;
    let edge: GEdge;
    if (code === 1) {
      edge = { id: eid, source, target: id, relation: "leads", label: "", condition: "", scenarioIds: edgeScen, collapsed: false, createdAt: at, updatedAt: at, meta: { c0: C0_NONE } };
    } else {
      const lab = map.label(i);
      const label = lab === "—" ? "" : str(lab);
      const condition = str(map.line(i));
      const prob = map.p(i);
      const e = map.e(i);
      const kl = rowKey ? rowKey.call(map, i, "ln") : -1;
      const kv = rowKey ? rowKey.call(map, i, "rv") : -1;
      const l = kl === 0 ? null : kl > 0 && lnBy[kl] !== undefined ? lnBy[kl]! : map.ln(i);
      const x = kv === 0 ? null : kv > 0 && rvBy[kv] !== undefined ? rvBy[kv]! : map.rv(i);
      const r: R3 = [e[0], e[1], e[2]];
      const c0 = c0Of(label, condition);
      let emeta: Meta;
      // 同じ番号の判断の線・事実は、1 度共有の物にしたらそのまま（共有の物を共有の入れ物で引いても同じ物が返る）
      const ln = l ? (kl > 0 ? (lnBy[kl] ??= lnPool.of(hashLn(l), l)) : lnPool.of(hashLn(l), l)) : null;
      const rv = x ? (kv > 0 ? (rvBy[kv] ??= rvPool.of(hStr(hStr(SEED, x[0]), x[1]), x)) : rvPool.of(hStr(hStr(SEED, x[0]), x[1]), x)) : null;
      if (ln && rv) emeta = { prob, r, ln, rv, p0: prob, c0 };
      else if (ln) emeta = { prob, r, ln, p0: prob, c0 };
      else if (rv) emeta = { prob, r, rv, p0: prob, c0 };
      else emeta = { prob, r, p0: prob, c0 };
      edge = { id: eid, source, target: id, relation: "condition", label, condition, scenarioIds: EMPTY, collapsed: false, createdAt: at, updatedAt: at, meta: emeta };
    }
    edges[i] = edge;
  }
  return { doc, nodes, edges, ids };
}
