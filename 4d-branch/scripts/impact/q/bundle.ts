// 3 か月ごとの地図の同梱データを書く（形と読み手は src/demo/impactBundle.ts）。設計: 作業メモ SPEC v1 §3.1・D4（見直し safety-4・safety-5・perf-7）
// 1. canonicalizeDevTree: 開発用の木の数を同梱データの精度（SCALE）に丸めた写し。丸めた木を書き出せば、その木の fromDevTree() と
//    同梱データの読み手は、どの問いにもちょうど同じ答えを返す（生成の丸めより細かい数は、まとめた行き先の e・q・まとめた行き先の rr・1 社の月額だけ）
// 2. encodeMap: 読むだけの地図（MapData）の答えを、決まった並びのバイト列にする。表は深さ優先で初めて出た順なので、同じ答えなら同じバイト列
//    （読んだ地図を書き直しても同じバイト列になる）。鍵は「親の鍵 + . + 区切り」でなければ書かない
// 3. 中身の指紋は、このバイト列の 64 ビットの指紋（fnv64x36Bytes。header.hash には入れずに数える）。gzip と base64 は node の入口（main.ts）
// node の機能は使わない（テストからも呼ぶ）

import { fnv64x36Bytes } from "../../../src/demo/impact";
import {
  BUNDLE_FORMAT,
  BUNDLE_MAGIC,
  eScale,
  FLAG,
  JOBS,
  MIX_COLS,
  PERMS,
  ROLES,
  roundTo,
  SCALE,
  ST_NUMS,
  STR_TABLES,
  toScaled,
  WHYS,
  type BundleTables,
  type StrTableName,
} from "../../../src/demo/impactBundle";
import type { DevTree, DevTreeNode, MapContStep, MapData, MapHeader, MapMix } from "../../../src/deepmap/mapData";

/** 入口の JSON の項目の並び（hash は書かない。知らない項目は名前の順で後ろに） */
const HEADER_KEYS: readonly string[] = ["v", "kind", "title", "anchor", "horizon", "annual", "release", "textVersion", "kinds", "fams", "premises", "never", "counts"];

function fail(msg: string): never {
  throw new Error(`同梱データを書けません: ${msg}`);
}

/** 伸びるバイト列 */
class Bytes {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private room(k: number): void {
    if (this.len + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + k) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  u8(x: number): void {
    this.room(1);
    this.buf[this.len++] = x;
  }
  /** 可変長の整数（下から 7 ビットずつ） */
  uv(v: number): void {
    if (!(Number.isInteger(v) && v >= 0 && v < 2 ** 53)) fail(`負・大きすぎる整数 ${v}`);
    while (v >= 128) {
      this.u8((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    this.u8(v);
  }
  /** ジグザグ（0, −1, 1, −2, …）の可変長の整数 */
  sv(v: number): void {
    this.uv(v >= 0 ? 2 * v : -2 * v - 1);
  }
  raw(b: Uint8Array): void {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  /** 長さ + 中身の塊 */
  block(inner: Bytes): void {
    this.uv(inner.len);
    this.raw(inner.bytes());
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

/** 初めて出た順の表 */
class Interner<T> {
  ids = new Map<string, number>();
  list: T[] = [];
  constructor(private readonly keyOf: (x: T) => string) {}
  id(x: T): number {
    const k = this.keyOf(x);
    let i = this.ids.get(k);
    if (i === undefined) {
      i = this.list.length;
      this.ids.set(k, i);
      this.list.push(x);
    }
    return i;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 数の列（数 + ジグザグの整数）。読み手は 32 ビットの整数で持つので、その範囲に入らなければ書かない */
function col(out: Bytes, xs: readonly number[], what: string): void {
  const c = new Bytes();
  c.uv(xs.length);
  for (const x of xs) {
    if (!(Number.isInteger(x) && x <= 0x7fffffff && x >= -0x80000000)) fail(`${what} の値 ${x} が 32 ビットの整数に入りません`);
    c.sv(x);
  }
  out.block(c);
}

/** 文字列の表: 数・UTF-16 の長さ・UTF-8 のバイト（塊） */
function strTable(out: Bytes, list: readonly string[], what: string): void {
  const c = new Bytes();
  c.uv(list.length);
  for (const s of list) c.uv(s.length);
  const blob = list.join("");
  const b = enc.encode(blob);
  if (dec.decode(b) !== blob) fail(`${what} に UTF-8 にできない文字（対になっていないサロゲート）があります`);
  const inner = new Bytes();
  inner.raw(b);
  c.block(inner);
  out.block(c);
}

const json = (out: Bytes, x: unknown): void => {
  const inner = new Bytes();
  inner.raw(enc.encode(JSON.stringify(x)));
  out.block(inner);
};

/** 入口の JSON にする物（hash を除き、決まった項目の並び） */
export function headerForStream(h: MapHeader): Record<string, unknown> {
  const src = h as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of HEADER_KEYS) if (k in src) out[k] = src[k];
  for (const k of Object.keys(src).sort()) if (!HEADER_KEYS.includes(k) && k !== "hash") out[k] = src[k];
  return out;
}

const finite = (x: unknown, what: string): number => (typeof x === "number" && Number.isFinite(x) ? x : fail(`${what} が数でありません（${String(x)}）`));

/** 深さ優先の並びになっているか（子を順にたどった順が 0..n−1）と、鍵が「親の鍵 + . + 区切り」か。区切りを返す */
function segmentsOf(map: MapData): string[] {
  const n = map.n;
  const order: number[] = [];
  const stack: number[] = [0];
  while (stack.length) {
    const i = stack.pop()!;
    order.push(i);
    for (let k = map.childCount(i) - 1; k >= 0; k--) {
      const c = map.child(i, k);
      if (map.parent(c) !== i) fail(`親と子が合いません（${i} → ${c}）`);
      stack.push(c);
    }
  }
  if (order.length !== n || order.some((x, i) => x !== i)) fail("ノードの番号が深さ優先の並びではありません");
  if (map.parent(0) !== -1) fail("今日（0）に親があります");
  const segs: string[] = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const k = map.key(i);
    let s: string;
    if (i === 0) s = k;
    else {
      const pk = map.key(map.parent(i));
      if (!k.startsWith(`${pk}.`)) fail(`鍵が親の鍵 + . + 区切り ではありません: ${k}（親 ${pk}）`);
      s = k.slice(pk.length + 1);
    }
    if (!s || s.includes(".")) fail(`鍵の区切りが空か、. を含みます: ${k}`);
    segs[i] = s;
  }
  for (let i = 0; i < n; i++) {
    const seen = new Set<string>();
    for (let k = 0; k < map.childCount(i); k++) {
      const s = segs[map.child(i, k)]!;
      if (seen.has(s)) fail(`兄弟で鍵が重なります: ${map.key(map.child(i, k))}`);
      seen.add(s);
    }
  }
  return segs;
}

/**
 * 読むだけの地図の答えを、決まった並びのバイト列にする（形は src/demo/impactBundle.ts の先頭）。数は SCALE の精度に丸める。
 * 入口の counts.nodes はノードの数と同じであること
 */
export function encodeMap(map: MapData): Uint8Array {
  const n = map.n;
  const header = map.header;
  if (header.counts?.nodes !== n) fail(`入口のノードの数 ${String(header.counts?.nodes)} が ${n} と違います`);
  const segs = segmentsOf(map);
  const str = Object.fromEntries(STR_TABLES.map((t) => [t, new Interner<string>((s) => s)])) as Record<StrTableName, Interner<string>>;
  const kinds = new Interner<string>((s) => s);
  for (const k of Object.keys(header.kinds)) kinds.id(k);
  const lnT = new Interner<NonNullable<ReturnType<MapData["ln"]>>>((x) => JSON.stringify(x));
  const rvT = new Interner<[string, string]>((x) => JSON.stringify(x));
  const bandT = new Interner<NonNullable<ReturnType<MapData["band"]>>>((x) => JSON.stringify(x));
  const flT = new Interner<string[]>((x) => JSON.stringify(x));
  const contT = new Interner<MapContStep[]>((x) => JSON.stringify(x));
  const mixT = new Interner<MapMix>((x) => JSON.stringify(MIX_COLS.map((c) => toScaled(c.get(x), c.s))));
  const C = {
    cc: [] as number[],
    role: [] as number[],
    mon: [] as number[],
    seg: [] as number[],
    flags: [] as number[],
    jpp: [] as number[],
    st: ST_NUMS.map(() => [] as number[]),
    fl: [] as number[],
    rr: [[], [], []] as number[][],
    band: [] as number[],
    mix: [] as number[],
    cont: [] as number[],
    title: [] as number[],
    short: [] as number[],
    kind: [] as number[],
    hours: [] as number[],
    q: [[], [], []] as number[][],
    todoN: [] as number[],
    todoT: [] as number[],
    todoC: [] as number[],
    p: [] as number[],
    lab: [] as number[],
    line: [] as number[],
    ln: [] as number[],
    rv: [] as number[],
    e: [[], [], []] as number[][],
    outId: [] as number[],
  };
  const stInts: number[][] = ST_NUMS.map(() => new Array<number>(n));
  const monthOf: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const role = map.role(i);
    const ro = ROLES.indexOf(role);
    if (ro < 0) fail(`知らない役割 ${role}`);
    if ((i === 0) !== (role === "r")) fail("今日（r）は先頭の 1 枚だけです");
    const par = map.parent(i);
    C.cc.push(map.childCount(i));
    C.role.push(ro);
    const m = map.month(i);
    if (!(Number.isInteger(m) && m >= 0)) fail(`月が 0 以上の整数でありません: ${map.key(i)}（${m}）`);
    monthOf[i] = m;
    C.mon.push(i === 0 ? m : m - monthOf[par]!);
    C.seg.push(str.seg.id(segs[i]!));
    // 印
    let f = 0;
    if (role === "a") {
      const why = map.why(i);
      if (why !== null) {
        const w = WHYS.indexOf(why);
        if (w < 0) fail(`知らない訳 ${why}`);
        f |= w + 1;
      }
      if (map.isBase(i)) f |= FLAG.base;
      if (map.stub(i)) f |= FLAG.stub;
      if (map.q(i)) f |= FLAG.q;
      if (map.todo(i).length) f |= FLAG.todo;
    }
    if (map.sum(i)) f |= FLAG.sum;
    if ((role === "s" || role === "e") && map.outId(i) !== segs[i]) f |= FLAG.outId;
    C.flags.push(f);
    // 状態（数は親との差）
    const st = map.st(i);
    const j = JOBS.indexOf(st.j);
    const pm = PERMS.indexOf(st.pm);
    if (j < 0 || pm < 0 || (st.pro !== 0 && st.pro !== 1)) fail(`状態の仕事・答え・Pro が違います: ${map.key(i)}`);
    C.jpp.push(j | (pm << 2) | (st.pro << 4));
    ST_NUMS.forEach((k, c) => {
      const v = toScaled(finite(st[k], `状態 ${k}`), SCALE[k]);
      stInts[c]![i] = v;
      C.st[c]!.push(i === 0 ? v : v - stInts[c]![par]!);
    });
    if (!Array.isArray(st.fl) || st.fl.some((x) => typeof x !== "string")) fail(`状態の印が文字列の並びでありません: ${map.key(i)}`);
    C.fl.push(flT.id([...st.fl]));
    const rr = map.rr(i);
    for (let c = 0; c < 3; c++) C.rr[c]!.push(toScaled(finite(rr[c], "月の稼ぎ"), SCALE.rr[c]!));
    const band = map.band(i);
    C.band.push(band ? bandT.id(band) + 1 : 0);
    const mix = map.mix(i);
    C.mix.push(mix ? mixT.id(mix) + 1 : 0);
    const cont = map.cont(i);
    C.cont.push(cont ? contT.id(cont.map((c) => ({ ...c }))) + 1 : 0);
    C.title.push(str.title.id(map.title(i)));
    C.short.push(str.short.id(map.short(i)));
    if (role === "a") {
      const kind = map.kind(i);
      C.kind.push(kind === null ? 0 : kinds.id(kind) + 1);
      C.hours.push(toScaled(finite(map.hours(i), "週の時間"), SCALE.hours));
      const q = map.q(i);
      if (q) for (let c = 0; c < 3; c++) C.q[c]!.push(toScaled(finite(q[c], "q"), SCALE.q[c]!));
      const todo = map.todo(i);
      if (todo.length) {
        C.todoN.push(todo.length);
        for (const t of todo) {
          C.todoT.push(str.todo.id(t.text));
          C.todoC.push(str.cite.id(t.cite));
        }
      }
    }
    if (role === "s" || role === "e") {
      const p = map.p(i);
      if (!(Number.isInteger(p) && p >= 0)) fail(`見込み % が 0 以上の整数でありません: ${map.key(i)}（${p}）`);
      C.p.push(p);
      C.lab.push(str.lab.id(map.label(i)));
      C.line.push(str.line.id(map.line(i)));
      const ln = map.ln(i);
      if (ln && ln.some((x) => x === undefined || (typeof x === "number" && !Number.isFinite(x)))) fail(`判断の線に読めない値があります: ${map.key(i)}`);
      C.ln.push(ln ? lnT.id(ln) + 1 : 0);
      const rv = map.rv(i);
      C.rv.push(rv ? rvT.id([rv[0], rv[1]]) + 1 : 0);
      const e = map.e(i);
      const s = eScale(map.sum(i));
      for (let c = 0; c < 3; c++) C.e[c]!.push(toScaled(finite(e[c], "線の稼ぎ"), s[c]!));
      if (f & FLAG.outId) C.outId.push(str.seg.id(map.outId(i)));
    }
  }
  const tables: BundleTables = { kinds: kinds.list, ln: lnT.list, rv: rvT.list, band: bandT.list, fl: flT.list, cont: contT.list };

  const out = new Bytes();
  for (const b of BUNDLE_MAGIC) out.u8(b);
  out.uv(BUNDLE_FORMAT);
  json(out, headerForStream(header));
  json(out, tables);
  for (const t of STR_TABLES) strTable(out, str[t].list, `文字列の表 ${t}`);
  {
    const c = new Bytes();
    const ms = mixT.list;
    c.uv(ms.length);
    const ints = MIX_COLS.map((mc) => ms.map((m) => toScaled(finite(mc.get(m), "mix"), mc.s)));
    MIX_COLS.forEach((mc, f) => {
      for (let k = 0; k < ms.length; k++) c.sv(ints[f]![k]! - (mc.q ? ints[f - 1]![k]! : 0));
    });
    out.block(c);
  }
  col(out, C.cc, "子の数");
  col(out, C.role, "役割");
  col(out, C.mon, "月");
  col(out, C.seg, "鍵の区切り");
  col(out, C.flags, "印");
  col(out, C.jpp, "仕事と答え");
  ST_NUMS.forEach((k, c) => col(out, C.st[c]!, `状態 ${k}`));
  col(out, C.fl, "状態の印");
  for (let c = 0; c < 3; c++) col(out, C.rr[c]!, "月の稼ぎ");
  col(out, C.band, "幅");
  col(out, C.mix, "mix");
  col(out, C.cont, "cont");
  col(out, C.title, "題名");
  col(out, C.short, "短い名前");
  col(out, C.kind, "手の種類");
  col(out, C.hours, "週の時間");
  for (let c = 0; c < 3; c++) col(out, C.q[c]!, "q");
  col(out, C.todoN, "やることの数");
  col(out, C.todoT, "やることの文");
  col(out, C.todoC, "やることの元");
  col(out, C.p, "見込み");
  col(out, C.lab, "結果の名前");
  col(out, C.line, "線の文");
  col(out, C.ln, "判断の線");
  col(out, C.rv, "事実");
  for (let c = 0; c < 3; c++) col(out, C.e[c]!, "線の稼ぎ");
  col(out, C.outId, "結果の名前（区切りと違う物）");
  return out.bytes().slice();
}

/** 中身の指紋（決まった並びのバイト列の 64 ビットの指紋。36 進 14 文字） */
export const bundleHash = (bytes: Uint8Array): string => fnv64x36Bytes(bytes);

const roundR3 = (v: readonly number[], s: readonly number[]): [number, number, number] => [roundTo(v[0]!, s[0]!), roundTo(v[1]!, s[1]!), roundTo(v[2]!, s[2]!)];

function roundMix(m: MapMix): MapMix {
  const sh = (x: number) => roundTo(x, SCALE.share);
  const t3 = (v: readonly number[], s: number): [number, number, number] => [roundTo(v[0]!, s), roundTo(v[1]!, s), roundTo(v[2]!, s)];
  return {
    j: { e: sh(m.j.e), p: sh(m.j.p), i: sh(m.j.i) },
    pm: { "?": sh(m.pm["?"]), a: sh(m.pm.a), s: sh(m.pm.s), n: sh(m.pm.n) },
    pro: sh(m.pro),
    switched: sh(m.switched),
    school: sh(m.school),
    cl: t3(m.cl, SCALE.mixCl),
    pu: t3(m.pu, SCALE.mixPu),
    mau: t3(m.mau, SCALE.mixMau),
    sal: t3(m.sal, SCALE.mixSal),
  };
}

/**
 * 開発用の木を同梱データの精度に丸めた写し（元の木は変えない）。丸めた木の fromDevTree() と、encodeMap → decodeBundleBytes の答えはちょうど同じ。
 * 丸めるのは: 状態の数・月の稼ぎ・線の稼ぎ（まとめた行き先は細かい倍率）・q・週の時間・mix。ほかは写すだけ
 */
export function canonicalizeDevTree(tree: DevTree): DevTree {
  const visit = (x: DevTreeNode): DevTreeNode => {
    const y: DevTreeNode = { ...x };
    const st = x.st;
    y.st = { ...st, fl: [...st.fl] };
    for (const k of ST_NUMS) y.st[k] = roundTo(st[k], SCALE[k]);
    if (x.rr) y.rr = roundR3(x.rr, SCALE.rr);
    if (x.e) y.e = roundR3(x.e, eScale(x.r === "e" && !!x.sum));
    if (x.q) y.q = roundR3(x.q, SCALE.q);
    if (x.h !== undefined) y.h = roundTo(x.h, SCALE.hours);
    if (x.mix) y.mix = roundMix(x.mix);
    if (x.kids) y.kids = x.kids.map(visit);
    return y;
  };
  // 木の深さは 25 段ほど（今日 + 12 段の判断 × 2）なので、再帰でたどる
  return { header: { ...tree.header }, root: visit(tree.root) };
}

/** 丸めの差の最大（元の木 → 丸めた木。項目ごと）。報告用 */
export function roundingReport(tree: DevTree): Record<string, number> {
  const rep: Record<string, number> = {};
  const note = (k: string, a: number, b: number) => {
    const d = Math.abs(a - b);
    if (!(k in rep) || d > rep[k]!) rep[k] = d;
  };
  const stack: DevTreeNode[] = [tree.root];
  while (stack.length) {
    const x = stack.pop()!;
    for (const k of ST_NUMS) note(`st.${k}`, x.st[k], roundTo(x.st[k], SCALE[k]));
    const sum = x.r === "e" && !!x.sum;
    x.rr?.forEach((v, c) => note(`rr${c}${sum ? "（まとめた行き先）" : ""}`, v, roundTo(v, SCALE.rr[c]!)));
    x.e?.forEach((v, c) => note(`e${c}${sum ? "（まとめた行き先）" : ""}`, v, roundTo(v, eScale(sum)[c]!)));
    x.q?.forEach((v, c) => note(`q${c}`, v, roundTo(v, SCALE.q[c]!)));
    if (x.mix) for (const mc of MIX_COLS) note("mix", mc.get(x.mix), roundTo(mc.get(x.mix), mc.s));
    for (const k of x.kids ?? []) stack.push(k);
  }
  return rep;
}

/** バイト列を base64 に（atob・btoa の範囲。node の Buffer を使わない） */
export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH));
  return btoa(s);
}
