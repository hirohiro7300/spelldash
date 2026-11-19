// 3 か月ごと 12 段の「3 年の分かれ道」（版 7 から）の同梱データの形と、その読み手（I-map の MapData を返す）。
// 設計: 作業メモ SPEC v1 §3.1・§3.2・§3.3（見直し gaps-3・gaps-4・safety-4・safety-5・safety-6・perf-7）
// 作る側: scripts/impact/q/bundle.ts（木 → 決まった並びのバイト列 → gzip → base64）。読み手はこのファイルだけ
//
// 決まった並び（圧縮する前のバイト列。中身の指紋 header.hash はこの全体の 64 ビットの指紋 fnv64x36Bytes）:
//   "4DQM" 4 バイト・形の版（可変長の整数）、その後は「長さ（可変長の整数）+ 中身」の塊が決まった順に並ぶ（後ろに余りは無い）
//   1. 入口: MapHeader から hash を除いた JSON（UTF-8）
//   2. 小さい表の JSON: kinds（手の種類の名前）・ln（判断の線）・rv（確かめるだけの事実）・band（幅）・fl（状態の印の組）・cont（標準の続き）
//   3. 文字列の表 7 つ（SEG 鍵の区切り・結果の名前 / LAB / LINE / TITLE / SHORT / TODO / CITE）: 数・UTF-16 の長さ・UTF-8 のバイト
//   4. まとめた行き先の中身（mix）の表: 項目ごとの列（10%・50%・90% の幅は前の値との差）
//   5. ノードの列（深さ優先の順）。どれも「数 + 可変長の整数（ジグザグ）」:
//      全ノード: 子の数・役割・月（親との差）・鍵の区切り・印・状態（仕事と答えと Pro は 1 つの数、ほかは親との差）・月の稼ぎ・幅・mix・cont・題名・短い名前
//      手だけ: 手の種類・週の時間 / q のある手だけ: q / やることのある手だけ: 数と（文・元の番号）
//      結果（状態・行き先）だけ: 見込み %・名前・線の文・判断の線・事実・線の稼ぎ / 鍵の区切りと違う結果の名前だけ: その名前
// 鍵は持たない（親の鍵 + "." + 区切り で読むときに作る）。ノードごとの物は作らず、型付きの配列から問われたときに作る。
//
// 数の精度（整数 / 倍率。作る側は木をこの精度に丸めてから書くので、読んだ値は丸めた木の値とちょうど同じ。SCALE）:
//   結果の線の稼ぎ e（まとめた行き先でない結果）: 給与の月数 0.0001 か月・万円 0.01（生成の丸めと同じなので変わらない）
//   まとめた行き先の e と手の q（続きの見積もりの期待値）: 0.000001 か月・0.0001 万円（1 円。年収 540 でも 1 枚 1.2 円以内）
//   月の稼ぎ rr: 倍率 0.0001・万円/月 0.01（まとめた行き先の rr は 36 か月目の見込みで、値には入らない）
//   状態: 遊ぶ人・有料会員 0.01・学校の席 1・顧客・1 社の月額・給与の倍率・続ける工夫 0.0001。週の時間 0.1
//   mix: 割合 0.0001・顧客 1・有料会員と遊ぶ人 0.01・給与の倍率 0.0001。入口（never など）と小さい表は JSON のまま（丸めない）

import type { MapBand, MapContStep, MapData, MapHeader, MapMix, MapRole, MapTodo, MapWhy } from "../deepmap/mapData";
import { fnv64x36Bytes, type ImpactLine, type ImpactSt, type R3 } from "./impact";
import { gunzipSync } from "./inflate";

/** 読めない・形の違う同梱データ（どの食い違いでも投げ、黙って読まない） */
export class ImpactBundleError extends Error {
  override name = "ImpactBundleError";
}

export const BUNDLE_MAGIC: readonly number[] = [0x34, 0x44, 0x51, 0x4d];
/** 形の版（並びを変えたら上げる） */
export const BUNDLE_FORMAT = 1;

/** 整数にして持つ数の倍率（値 = 整数 / 倍率） */
export const SCALE = {
  e: [1e4, 1e2, 1e2],
  eSum: [1e6, 1e4, 1e4],
  q: [1e6, 1e4, 1e4],
  rr: [1e4, 1e2, 1e2],
  mau: 1e2,
  pu: 1e2,
  seats: 1,
  cl: 1e4,
  fee: 1e4,
  sal: 1e4,
  cv: 1e4,
  hours: 10,
  share: 1e4,
  mixCl: 1,
  mixPu: 1e2,
  mixMau: 1e2,
  mixSal: 1e4,
} as const;

/** 整数にする（丸めた値 = この整数 / 倍率。−0 は 0）。有限でない数は投げる */
export function toScaled(x: number, s: number): number {
  if (!Number.isFinite(x)) throw new ImpactBundleError(`有限でない数は書けません: ${x}`);
  return Math.round(x * s) || 0;
}

/** 丸めた値（作る側が木を丸めるときと、読み手が返す値が同じになる式） */
export const roundTo = (x: number, s: number): number => toScaled(x, s) / s;

export const ROLES: readonly MapRole[] = ["r", "a", "s", "e"];
export const WHYS: readonly MapWhy[] = ["best", "keep", "area", "avoid"];
export const JOBS: readonly ImpactSt["j"][] = ["e", "p", "i"];
export const PERMS: readonly ImpactSt["pm"][] = ["?", "a", "s", "n"];
/** 状態の数の列の並び（親との差で持つ） */
export const ST_NUMS = ["mau", "pu", "seats", "cl", "fee", "sal", "cv"] as const;

/** 印のビット: 0〜2 訳（0 無し・1 + WHYS の番号）・今のまま・まとめた手・まとめた行き先・q がある・やることがある・結果の名前が鍵の区切りと違う */
export const FLAG = { whyMask: 7, base: 8, stub: 16, sum: 32, q: 64, todo: 128, outId: 256 } as const;

/** 文字列の表の並び */
export const STR_TABLES = ["seg", "lab", "line", "title", "short", "todo", "cite"] as const;
export type StrTableName = (typeof STR_TABLES)[number];

/** 小さい表（JSON） */
export interface BundleTables {
  kinds: string[];
  ln: ImpactLine[];
  rv: Array<[string, string]>;
  band: MapBand[];
  fl: string[][];
  cont: MapContStep[][];
}

/** mix の表の列（[読み方, 倍率]）。q > 0 の幅の列は前の幅との差で持つ */
export const MIX_COLS: ReadonlyArray<{ get: (m: MapMix) => number; s: number; q?: 1 | 2 }> = [
  { get: (m) => m.j.e, s: SCALE.share },
  { get: (m) => m.j.p, s: SCALE.share },
  { get: (m) => m.j.i, s: SCALE.share },
  { get: (m) => m.pm["?"], s: SCALE.share },
  { get: (m) => m.pm.a, s: SCALE.share },
  { get: (m) => m.pm.s, s: SCALE.share },
  { get: (m) => m.pm.n, s: SCALE.share },
  { get: (m) => m.pro, s: SCALE.share },
  { get: (m) => m.switched, s: SCALE.share },
  { get: (m) => m.school, s: SCALE.share },
  ...(["cl", "pu", "mau", "sal"] as const).flatMap((k) => {
    const s = k === "cl" ? SCALE.mixCl : k === "pu" ? SCALE.mixPu : k === "mau" ? SCALE.mixMau : SCALE.mixSal;
    return [
      { get: (m: MapMix) => m[k][0], s },
      { get: (m: MapMix) => m[k][1], s, q: 1 as const },
      { get: (m: MapMix) => m[k][2], s, q: 2 as const },
    ];
  }),
];

/** 丸めた木で問われる値の読み: まとめた行き先の e は細かい倍率 */
export const eScale = (sum: boolean): readonly number[] => (sum ? SCALE.eSum : SCALE.e);

// ---- 読み手

function bad(msg: string): never {
  throw new ImpactBundleError(`同梱データ: ${msg}`);
}

/** 可変長の整数（下から 7 ビットずつ・続く印は上のビット。2^53 まで）を読む */
class Reader {
  constructor(
    readonly b: Uint8Array,
    public p: number,
    readonly end: number,
  ) {}
  uv(): number {
    let r = 0;
    let mul = 1;
    for (;;) {
      if (this.p >= this.end) bad("塊が途中で切れています");
      const x = this.b[this.p++]!;
      r += (x & 127) * mul;
      if (!(x & 128)) break;
      mul *= 128;
      if (mul > 2 ** 49) bad("整数が長すぎます");
    }
    return r;
  }
  sv(): number {
    const u = this.uv();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }
  block(): Reader {
    const len = this.uv();
    if (this.p + len > this.end) bad("塊の長さが残りより長い");
    const r = new Reader(this.b, this.p, this.p + len);
    this.p += len;
    return r;
  }
  done(what: string): void {
    if (this.p !== this.end) bad(`${what} の後ろに余りがあります`);
  }
}

const utf8 = (b: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return bad("UTF-8 として読めません");
  }
};

/** 数の列: 塊の中は数 + ジグザグの整数。数が want と違う・32 ビットに入らない値は投げる */
function readCol(r: Reader, want: number, what: string): Int32Array {
  const c = r.block();
  const n = c.uv();
  if (n !== want) bad(`${what} の数 ${n} が ${want} と違います`);
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const v = c.sv();
    if (v > 0x7fffffff || v < -0x80000000) bad(`${what} の値が大きすぎます`);
    out[i] = v;
  }
  c.done(what);
  return out;
}

/** 文字列の表（全部を 1 つの文字列にして、問われたら切り出す） */
interface StrTable {
  n: number;
  get(k: number): string;
}
function readStrTable(r: Reader, what: string): StrTable {
  const c = r.block();
  const n = c.uv();
  // 長さは 1 つ 1 バイト以上なので、塊より多い数は壊れた並び（大きすぎる配列を作らない）
  if (n > c.end - c.p) bad(`${what} の数が塊より大きい`);
  const off = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) off[k + 1] = off[k]! + c.uv();
  const bytes = c.block();
  const blob = utf8(bytes.b.subarray(bytes.p, bytes.end));
  c.done(what);
  if (blob.length !== off[n]) bad(`${what} の文字列の長さが合いません`);
  return {
    n,
    get: (k) => {
      if (!(k >= 0 && k < n)) bad(`${what} の番号 ${k} が表の外です`);
      return blob.substring(off[k]!, off[k + 1]!);
    },
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function readJson(r: Reader, what: string): unknown {
  const c = r.block();
  try {
    return JSON.parse(utf8(c.b.subarray(c.p, c.end)));
  } catch (e) {
    if (e instanceof ImpactBundleError) throw e;
    return bad(`${what} の JSON が読めません`);
  }
}

/** 小さい表の中身の形（読むときに投げないように、先に全部見る） */
function checkTables(T: BundleTables): void {
  const str = (x: unknown) => typeof x === "string";
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const pair = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every(num);
  if (!T.kinds.every(str)) bad("手の種類の表の形が違います");
  for (const l of T.ln)
    if (!(Array.isArray(l) && (l.length === 4 || l.length === 5) && str(l[0]) && num(l[1]) && (l[2] === null || num(l[2])) && (l[3] === null || num(l[3])) && (l.length === 4 || str(l[4]))))
      bad("判断の線の表の形が違います");
  for (const r of T.rv) if (!(Array.isArray(r) && r.length === 2 && r.every(str))) bad("事実の表の形が違います");
  for (const b of T.band) if (!(isObj(b) && Object.keys(b).every((k) => (k === "cl" || k === "pu") && pair(b[k])))) bad("幅の表の形が違います");
  for (const f of T.fl) if (!(Array.isArray(f) && f.every(str))) bad("状態の印の表の形が違います");
  for (const c of T.cont)
    if (!(Array.isArray(c) && c.every((x) => isObj(x) && num(x.m) && str(x.kind) && (x.ev === undefined || str(x.ev)) && Object.keys(x).every((k) => k === "m" || k === "kind" || k === "ev"))))
      bad("標準の続きの表の形が違います");
}

const NO_TODO: readonly MapTodo[] = Object.freeze([]);
const copyLn = (l: ImpactLine): ImpactLine => [...l] as ImpactLine;
const copyBand = (b: MapBand): MapBand => {
  const o: MapBand = {};
  if (b.cl) o.cl = [b.cl[0], b.cl[1]];
  if (b.pu) o.pu = [b.pu[0], b.pu[1]];
  return o;
};

/**
 * 決まった並びのバイト列（gzip を伸ばした後）から、読むだけの地図を作る（同期・型付きの配列。ノードごとの物は問われたときに作る）。
 * どの accessor も、同じ木（作る側が丸めた開発用の木）の fromDevTree() と同じ答えを返す。食い違いは ImpactBundleError
 */
export function decodeBundleBytes(bytes: Uint8Array): MapData {
  const r = new Reader(bytes, 0, bytes.length);
  for (let k = 0; k < 4; k++) if (bytes[k] !== BUNDLE_MAGIC[k]) bad("3 か月ごとの地図の同梱データではありません");
  r.p = 4;
  const format = r.uv();
  if (format !== BUNDLE_FORMAT) bad(`知らない形の版 ${format}（読めるのは ${BUNDLE_FORMAT}）`);
  const hj = readJson(r, "入口");
  if (!isObj(hj) || hj.v !== 3 || hj.kind !== "impact3y" || !isObj(hj.counts) || "hash" in hj) bad("入口の形が違います");
  const n = (hj as { counts: { nodes: unknown } }).counts.nodes;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) bad("入口のノードの数が違います");
  const header = { ...(hj as unknown as Omit<MapHeader, "hash">), hash: fnv64x36Bytes(bytes) } as MapHeader;
  const tj = readJson(r, "小さい表");
  if (!isObj(tj)) bad("小さい表の形が違います");
  const T = tj as unknown as BundleTables;
  for (const k of ["kinds", "ln", "rv", "band", "fl", "cont"] as const) if (!Array.isArray(T[k])) bad(`小さい表 ${k} がありません`);
  checkTables(T);
  const S = {} as Record<StrTableName, StrTable>;
  for (const name of STR_TABLES) S[name] = readStrTable(r, `文字列の表 ${name}`);
  // mix の表: 項目ごとの整数の列（幅の 50%・90% は前の幅との差）
  const mixTab: MapMix[] = [];
  {
    const c = r.block();
    const m = c.uv();
    if (m * MIX_COLS.length > c.end - c.p) bad("mix の表の数が塊より大きい");
    const ints = MIX_COLS.map(() => new Float64Array(m));
    MIX_COLS.forEach((col, f) => {
      for (let k = 0; k < m; k++) ints[f]![k] = c.sv() + (col.q ? ints[f - 1]![k]! : 0);
    });
    c.done("mix の表");
    for (let k = 0; k < m; k++) {
      const v = (f: number) => ints[f]![k]! / MIX_COLS[f]!.s;
      mixTab.push({
        j: { e: v(0), p: v(1), i: v(2) },
        pm: { "?": v(3), a: v(4), s: v(5), n: v(6) },
        pro: v(7),
        switched: v(8),
        school: v(9),
        cl: [v(10), v(11), v(12)],
        pu: [v(13), v(14), v(15)],
        mau: [v(16), v(17), v(18)],
        sal: [v(19), v(20), v(21)],
      });
    }
  }
  // ノードの列（全ノード）
  const cc = readCol(r, n, "子の数");
  const role = readCol(r, n, "役割");
  const mon = readCol(r, n, "月");
  const seg = readCol(r, n, "鍵の区切り");
  const flags = readCol(r, n, "印");
  const jpp = readCol(r, n, "仕事と答え");
  const stCols = ST_NUMS.map((k) => readCol(r, n, `状態 ${k}`));
  const fl = readCol(r, n, "状態の印");
  const rr = [readCol(r, n, "月の稼ぎ 0"), readCol(r, n, "月の稼ぎ 1"), readCol(r, n, "月の稼ぎ 2")];
  const band = readCol(r, n, "幅");
  const mix = readCol(r, n, "mix");
  const cont = readCol(r, n, "cont");
  const title = readCol(r, n, "題名");
  const short = readCol(r, n, "短い名前");

  // 木の形: 子の数（深さ優先）から親と子の並び
  const parent = new Int32Array(n);
  const kidOff = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    if (cc[i]! < 0) bad("子の数が負です");
    kidOff[i + 1] = kidOff[i]! + cc[i]!;
  }
  if (kidOff[n] !== n - 1) bad("子の数の合計がノードの数と合いません");
  const kids = new Int32Array(n - 1);
  const fill = new Int32Array(n);
  {
    const stack = new Int32Array(n);
    let sp = 0;
    parent[0] = -1;
    stack[sp++] = 0;
    for (let i = 1; i < n; i++) {
      while (sp > 0 && fill[stack[sp - 1]!] === cc[stack[sp - 1]!]) sp--;
      if (sp === 0) bad("木の形が深さ優先の並びになっていません");
      const p = stack[sp - 1]!;
      parent[i] = p;
      kids[kidOff[p]! + fill[p]!] = i;
      fill[p]!++;
      stack[sp++] = i;
    }
    for (let i = 0; i < n; i++) if (fill[i] !== cc[i]) bad("木の形が深さ優先の並びになっていません");
  }

  // 役割ごとの番号（手・結果の中での番号）と、絶対の月・状態
  const sub = new Int32Array(n).fill(-1);
  let nA = 0;
  let nO = 0;
  let nQ = 0;
  let nTodo = 0;
  let nOutId = 0;
  const month = new Int32Array(n);
  const qPos = new Int32Array(n).fill(-1);
  const todoPos = new Int32Array(n).fill(-1);
  const outIdPos = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const ro = role[i]!;
    if (ro < 0 || ro > 3) bad("知らない役割です");
    if ((i === 0) !== (ro === 0)) bad("今日（r）は先頭の 1 枚だけです");
    month[i] = mon[i]! + (i > 0 ? month[parent[i]!]! : 0);
    const f = flags[i]!;
    if (f < 0 || f >= 512 || (f & FLAG.whyMask) > WHYS.length) bad("知らない印です");
    if (ro === 1) {
      sub[i] = nA++;
      if (f & FLAG.q) qPos[i] = nQ++;
      if (f & FLAG.todo) todoPos[i] = nTodo++;
    } else if (ro >= 2) {
      sub[i] = nO++;
      if (f & FLAG.outId) outIdPos[i] = nOutId++;
    }
    if (ro !== 1 && f & (FLAG.whyMask | FLAG.base | FLAG.stub | FLAG.q | FLAG.todo)) bad("手でないノードに手の印があります");
    if (ro < 2 && f & FLAG.outId) bad("結果でないノードに結果の印があります");
    if (ro !== 3 && f & FLAG.sum) bad("行き先でないノードにまとめた行き先の印があります");
  }
  for (let i = 1; i < n; i++) for (const c of stCols) c[i] = c[i]! + c[parent[i]!]!;
  const kind = readCol(r, nA, "手の種類");
  const hours = readCol(r, nA, "週の時間");
  const q = [readCol(r, nQ, "q 0"), readCol(r, nQ, "q 1"), readCol(r, nQ, "q 2")];
  const todoN = readCol(r, nTodo, "やることの数");
  let nItems = 0;
  const todoOff = new Int32Array(nTodo + 1);
  for (let k = 0; k < nTodo; k++) {
    if (todoN[k]! < 1) bad("やることの数が 0 です");
    nItems += todoN[k]!;
    todoOff[k + 1] = nItems;
  }
  const todoT = readCol(r, nItems, "やることの文");
  const todoC = readCol(r, nItems, "やることの元");
  const p = readCol(r, nO, "見込み");
  const lab = readCol(r, nO, "結果の名前");
  const line = readCol(r, nO, "線の文");
  const ln = readCol(r, nO, "判断の線");
  const rv = readCol(r, nO, "事実");
  const e = [readCol(r, nO, "線の稼ぎ 0"), readCol(r, nO, "線の稼ぎ 1"), readCol(r, nO, "線の稼ぎ 2")];
  const outId = readCol(r, nOutId, "結果の名前（区切りと違う物）");
  r.done("同梱データ");

  // 表の番号の確かめ（読むときに範囲の外を引かないように、先に全部見る）
  const within = (col: Int32Array, lo: number, hi: number, what: string) => {
    for (let k = 0; k < col.length; k++) if (col[k]! < lo || col[k]! > hi) bad(`${what} の番号が表の外です`);
  };
  within(seg, 0, S.seg.n - 1, "鍵の区切り");
  within(jpp, 0, 31, "仕事と答え");
  for (let i = 0; i < n; i++) if ((jpp[i]! & 3) > 2) bad("仕事と答えの値が違います");
  within(fl, 0, T.fl.length - 1, "状態の印");
  within(band, 0, T.band.length, "幅");
  within(mix, 0, mixTab.length, "mix");
  within(cont, 0, T.cont.length, "cont");
  within(title, 0, S.title.n - 1, "題名");
  within(short, 0, S.short.n - 1, "短い名前");
  within(kind, 0, T.kinds.length, "手の種類");
  within(todoT, 0, S.todo.n - 1, "やることの文");
  within(todoC, 0, S.cite.n - 1, "やることの元");
  within(lab, 0, S.lab.n - 1, "結果の名前");
  within(line, 0, S.line.n - 1, "線の文");
  within(ln, 0, T.ln.length, "判断の線");
  within(rv, 0, T.rv.length, "事実");
  within(outId, 0, S.seg.n - 1, "結果の名前");
  for (let i = 0; i < n; i++) if (month[i]! < 0) bad("月が負です");

  // 鍵: 区切りの番号からの子（鍵から番号を引くとき）と、問われたら作って覚える鍵
  const segId = new Map<string, number>();
  for (let k = 0; k < S.seg.n; k++) segId.set(S.seg.get(k), k);
  if (segId.size !== S.seg.n) bad("鍵の区切りの表に同じ文字列が 2 つあります");
  const segOk = new Uint8Array(S.seg.n);
  for (let i = 0; i < n; i++) {
    if (!segOk[seg[i]!]) {
      const t = S.seg.get(seg[i]!);
      if (t.length === 0 || t.includes(".")) bad("鍵の区切りが空か、. を含みます");
      segOk[seg[i]!] = 1;
    }
    for (let a = kidOff[i]!; a < kidOff[i + 1]!; a++)
      for (let b = a + 1; b < kidOff[i + 1]!; b++) if (seg[kids[a]!] === seg[kids[b]!]) bad("兄弟で鍵が重なります");
  }
  const keys: Array<string | undefined> = new Array<string | undefined>(n);

  const N = (i: number): number => {
    if (!(Number.isInteger(i) && i >= 0 && i < n)) throw new RangeError(`番号が範囲の外です: ${i}`);
    return i;
  };
  const isA = (i: number) => role[N(i)] === 1;
  const isOut = (i: number) => role[N(i)]! >= 2;
  const r3 = (cols: Int32Array[], k: number, s: readonly number[]): R3 => [cols[0]![k]! / s[0]!, cols[1]![k]! / s[1]!, cols[2]![k]! / s[2]!];
  const keyOf = (i: number): string => {
    const hit = keys[i];
    if (hit !== undefined) return hit;
    // 根まで上がって、覚えている所から下へ作る（深い木でも呼び出しを重ねない）
    const path: number[] = [];
    let x = i;
    while (x >= 0 && keys[x] === undefined) {
      path.push(x);
      x = parent[x]!;
    }
    let k = x >= 0 ? keys[x]! : "";
    for (let j = path.length - 1; j >= 0; j--) {
      const y = path[j]!;
      k = y === 0 ? S.seg.get(seg[0]!) : `${k}.${S.seg.get(seg[y]!)}`;
      keys[y] = k;
    }
    return k;
  };
  const kindName = (i: number) => {
    const k = kind[sub[i]!]!;
    return k === 0 ? null : T.kinds[k - 1]!;
  };

  return {
    header,
    n,
    parent: (i) => parent[N(i)]!,
    childCount: (i) => kidOff[N(i) + 1]! - kidOff[i]!,
    child: (i, k) => {
      const a = kidOff[N(i)]!;
      if (!(Number.isInteger(k) && k >= 0 && a + k < kidOff[i + 1]!)) throw new RangeError(`子の番号が範囲の外です: ${i}/${k}`);
      return kids[a + k]!;
    },
    role: (i) => ROLES[role[N(i)]!]!,
    month: (i) => month[N(i)]!,
    key: (i) => keyOf(N(i)),
    indexOfKey: (key) => {
      const parts = key.split(".");
      if (parts[0] !== S.seg.get(seg[0]!)) return -1;
      let x = 0;
      for (let j = 1; j < parts.length; j++) {
        const id = segId.get(parts[j]!);
        if (id === undefined) return -1;
        let next = -1;
        for (let a = kidOff[x]!; a < kidOff[x + 1]!; a++)
          if (seg[kids[a]!] === id) {
            next = kids[a]!;
            break;
          }
        if (next < 0) return -1;
        x = next;
      }
      return x;
    },
    kind: (i) => (isA(i) ? kindName(i) : null),
    hours: (i) => (isA(i) ? hours[sub[i]!]! / SCALE.hours : 0),
    isBase: (i) => isA(i) && (flags[i]! & FLAG.base) !== 0,
    why: (i) => (isA(i) && flags[i]! & FLAG.whyMask ? WHYS[(flags[i]! & FLAG.whyMask) - 1]! : null),
    stub: (i) => isA(i) && (flags[i]! & FLAG.stub) !== 0,
    q: (i) => (isA(i) && qPos[i]! >= 0 ? r3(q, qPos[i]!, SCALE.q) : null),
    todo: (i): readonly MapTodo[] => {
      if (!isA(i) || todoPos[i]! < 0) return NO_TODO;
      const k = todoPos[i]!;
      const out: MapTodo[] = [];
      for (let t = todoOff[k]!; t < todoOff[k + 1]!; t++) out.push({ text: S.todo.get(todoT[t]!), cite: S.cite.get(todoC[t]!) });
      return out;
    },
    outId: (i) => (isOut(i) ? S.seg.get(outIdPos[i]! >= 0 ? outId[outIdPos[i]!]! : seg[i]!) : ""),
    p: (i) => (isOut(i) ? p[sub[i]!]! : 0),
    label: (i) => (isOut(i) ? S.lab.get(lab[sub[i]!]!) : ""),
    line: (i) => (isOut(i) ? S.line.get(line[sub[i]!]!) : ""),
    ln: (i) => {
      if (!isOut(i)) return null;
      const k = ln[sub[i]!]!;
      return k === 0 ? null : copyLn(T.ln[k - 1]!);
    },
    e: (i): R3 => (isOut(i) ? r3(e, sub[i]!, eScale((flags[i]! & FLAG.sum) !== 0)) : [0, 0, 0]),
    rv: (i) => {
      if (!isOut(i)) return null;
      const k = rv[sub[i]!]!;
      return k === 0 ? null : [T.rv[k - 1]![0], T.rv[k - 1]![1]];
    },
    st: (i): ImpactSt => {
      N(i);
      const x = jpp[i]!;
      return {
        j: JOBS[x & 3]!,
        pm: PERMS[(x >> 2) & 3]!,
        pro: ((x >> 4) & 1) as 0 | 1,
        mau: stCols[0]![i]! / SCALE.mau,
        pu: stCols[1]![i]! / SCALE.pu,
        seats: stCols[2]![i]! / SCALE.seats,
        cl: stCols[3]![i]! / SCALE.cl,
        fee: stCols[4]![i]! / SCALE.fee,
        sal: stCols[5]![i]! / SCALE.sal,
        cv: stCols[6]![i]! / SCALE.cv,
        fl: [...T.fl[fl[i]!]!],
      };
    },
    rr: (i): R3 => r3(rr, N(i), SCALE.rr),
    sum: (i) => role[N(i)] === 3 && (flags[i]! & FLAG.sum) !== 0,
    band: (i) => (band[N(i)] ? copyBand(T.band[band[i]! - 1]!) : null),
    mix: (i) => {
      const k = mix[N(i)]!;
      if (!k) return null;
      const m = mixTab[k - 1]!;
      return { j: { ...m.j }, pm: { ...m.pm }, pro: m.pro, switched: m.switched, school: m.school, cl: [...m.cl], pu: [...m.pu], mau: [...m.mau], sal: [...m.sal] };
    },
    cont: (i) => {
      const k = cont[N(i)]!;
      return k ? T.cont[k - 1]!.map((s) => ({ ...s })) : null;
    },
    title: (i) => S.title.get(title[N(i)]!),
    short: (i) => S.short.get(short[N(i)]!),
  };
}

// ---- base64 と gzip

/** base64（空白は読み飛ばす）をバイト列に。読めない文字は投げる */
export function base64ToBytes(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64.replace(/\s+/g, ""));
  } catch {
    return bad("base64 として読めません");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** gzip を伸ばす: DecompressionStream があればそれで、無ければ小さな伸長（./inflate.ts） */
export async function gunzipBytes(gz: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") return gunzipSync(gz);
  const stream = new Blob([gz as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 同梱データ（base64 の gzip）から読むだけの地図を作る。読めなければ ImpactBundleError（gzip の食い違いも） */
export async function decodeBundle(b64: string): Promise<MapData> {
  const gz = base64ToBytes(b64);
  let raw: Uint8Array;
  try {
    raw = await gunzipBytes(gz);
  } catch (e) {
    throw new ImpactBundleError(`同梱データ: gzip を伸ばせません（${(e as Error).message}）`, { cause: e });
  }
  return decodeBundleBytes(raw);
}
