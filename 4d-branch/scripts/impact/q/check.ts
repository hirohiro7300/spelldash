// 同梱データの点検（作業メモ SPEC v1 §2.6）。どれも、書いたバイト列を読み手（src/demo/impactBundle.ts）で読んだ地図（MapData）で見る:
// アプリに届く物そのものを点検する（生成の木の点検は ./checks.ts。こちらは丸めて書いて読んだ後）。入口 main.ts が全部を呼び、通らなければ書き出さない。
//   B2  読み手: どのノードのどの問いにも、丸めた開発用の木の fromDevTree() と同じ答え（compareMaps）
//   N1  ノードは 90,000 枚まで
//   B1  最初の手ごとの分かれ道（子が 2 つ以上のノード）が、合わせ込みの報告の数と同じで、目標 min(B, 届く上限) の ±tol
//   N10 Pro を出していれば、届け出の答えが『全部可』か『SpellDash だけ可』、または独立（まとめた行き先は数えるだけ）
//   C1  顧客の社数: 幅の無い状態は整数の社数、幅は整数で小さい順
//   K1  暦: 入口の年月と 4 月の月の番号（(anchorMonth + a) mod 12 = 4）
//   R1  一貫性（生成の年収）: 最初の手ごとのおすすめの道で、アプリの一番良い手がまとめた手になる判断が 0
//   R2  アプリと同じ値: 読んだ地図からアプリの文書を軽い組み立て（src/demo/quarterDoc.ts の buildQuarterDoc。P2 のアプリが使う物）で作り、
//       computeImpact の今日の値・ずっと今のまま・すべての手の差が、読んだ値から直接出した値と |差| ≤ 1e-9（年収 360・540）。一番良い手も同じ
//   I1  ID: 鍵からの 64 ビットの ID（ノード n_i_・線 e_i_）が重ならない
//   D1  決まり: 2 回作った決まった並びのバイト列と指紋が同じ（読んだ地図を書き直しても同じバイト列）
//   Z1・Z2 大きさ: 決まった並び ≤ 4 MB・gzip ≤ 1.2 MB（base64 も報告）
//   H1  版の記録（scripts/impact/releases.json）: 版の順番は増えるだけ、同じ版の順番に違う指紋・同じ指紋に違う版の順番は無い。
//       3 か月ごとの地図の記録（q1）は本番の形で作った物だけ（作った形 build: 2,000・±2% 以内・never・2 回・今日の手すべて。見直し format-1）。
//       記録の基準の文書の指紋（digest。src/demo/impactDigest.ts）は 36 進 14 文字で、同じ版の順番と中身の指紋のまま違う指紋にはしない
//       （組み立てを変えて鍵・ID・線・タグ・期限が変わったら、版の順番を進める。見直し safety-4）

import { calendarCheck } from "./calendar";
import { DEFAULTS } from "./gen";
import { impactEdgeId64, impactNodeId64 } from "../../../src/demo/impact";
import { DIGEST_AT } from "../../../src/demo/impactDigest";
import { buildQuarterDoc } from "../../../src/demo/quarterDoc";
import type { MapData } from "../../../src/deepmap/mapData";
import { computeForecast } from "../../../src/model/forecast";
import { buildIndex } from "../../../src/model/graph";
import { computeImpact } from "../../../src/model/impact";
import type { DocData } from "../../../src/model/types";

/** ノードの上限（SPEC v1 §2.6） */
export const MAX_NODES = 90_000;
/** 決まった並び（圧縮する前）の上限 Z1（測った値 3.2 MB に、文章の表の分の余裕）と gzip の上限 Z2 */
export const MAX_RAW = 4_000_000;
export const MAX_GZIP = 1_200_000;

const LIMIT = 40;
function collector(): { fails: string[]; fail: (s: string) => void } {
  const fails: string[] = [];
  return {
    fails,
    fail: (s) => {
      if (fails.length < LIMIT) fails.push(s);
      else if (fails.length === LIMIT) fails.push("（ほかにもある）");
    },
  };
}

// ---- B2 読み手

/** MapData の問い（番号 1 つで答える物） */
export const ACCESSORS = [
  "parent",
  "childCount",
  "role",
  "month",
  "key",
  "kind",
  "hours",
  "isBase",
  "why",
  "stub",
  "q",
  "todo",
  "outId",
  "p",
  "label",
  "line",
  "ln",
  "e",
  "rv",
  "st",
  "rr",
  "sum",
  "band",
  "mix",
  "cont",
  "title",
  "short",
] as const satisfies ReadonlyArray<keyof MapData>;

/** 同じ値か（数は Object.is。物は中身で比べ、undefined の項目は無いのと同じ） */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  if (Array.isArray(a) && (a as unknown[]).length !== (b as unknown[]).length) return false;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue(ra[k], rb[k]));
}

/** 2 つの地図が、どのノードのどの問いにも同じ答えか（子の並び・鍵からの番号・入口も）。違う所の文を返す */
export function compareMaps(a: MapData, b: MapData): string[] {
  const { fails, fail } = collector();
  if (a.n !== b.n) return [`ノードの数が違います: ${a.n} / ${b.n}`];
  if (!sameValue(a.header, b.header)) fail("入口が違います");
  for (let i = 0; i < a.n; i++) {
    for (const f of ACCESSORS) {
      const x = (a[f] as (i: number) => unknown)(i);
      const y = (b[f] as (i: number) => unknown)(i);
      if (!sameValue(x, y)) fail(`${a.key(i)} の ${f}: ${JSON.stringify(x)} / ${JSON.stringify(y)}`);
    }
    for (let k = 0; k < a.childCount(i); k++) if (a.child(i, k) !== b.child(i, k)) fail(`${a.key(i)} の ${k} 番目の子が違います`);
    if (b.indexOfKey(a.key(i)) !== i) fail(`${a.key(i)} を鍵から引けません`);
  }
  return fails;
}

// ---- 木の数

/** 部分木の大きさ（深さ優先の並びなので、部分木は i から i + size[i] − 1） */
export function subtreeSizes(map: MapData): Int32Array {
  const size = new Int32Array(map.n).fill(1);
  for (let i = map.n - 1; i > 0; i--) size[map.parent(i)]! += size[i]!;
  return size;
}

/** 最初の手（今日の子）ごとの分かれ道（その手を含む部分木で、子が 2 つ以上のノード）。生成の countSub と同じ数え方 */
export function forksByFirstMove(map: MapData): Array<{ kind: string; i: number; forks: number; nodes: number }> {
  const size = subtreeSizes(map);
  const out: Array<{ kind: string; i: number; forks: number; nodes: number }> = [];
  for (let k = 0; k < map.childCount(0); k++) {
    const a0 = map.child(0, k);
    let forks = 0;
    for (let i = a0; i < a0 + size[a0]!; i++) if (map.childCount(i) >= 2) forks++;
    out.push({ kind: map.kind(a0) ?? map.key(a0), i: a0, forks, nodes: size[a0]! });
  }
  return out;
}

export function checkNodes(map: MapData, max = MAX_NODES): string[] {
  return map.n > max ? [`N1 ノードが ${map.n} 枚（上限 ${max}）`] : [];
}

/** 合わせ込みの報告（最初の手ごと）: 生成が数えた分かれ道・目標・目標に入ったか */
export interface ForkReport {
  kind: string;
  forks: number;
  target: number;
  saturated?: boolean;
}

/** B1: 読んだ地図の最初の手ごとの分かれ道が、報告の数と同じで、目標の ±tol */
export function checkForks(map: MapData, report: readonly ForkReport[], tol: number): string[] {
  const { fails, fail } = collector();
  const got = new Map(forksByFirstMove(map).map((x) => [x.kind, x.forks]));
  for (const r of report) {
    const f = got.get(r.kind);
    if (f === undefined) {
      fail(`B1 最初の手 ${r.kind} が地図にありません`);
      continue;
    }
    if (f !== r.forks) fail(`B1 ${r.kind} の分かれ道 ${f} が合わせ込みの報告 ${r.forks} と違います`);
    if (Math.abs(f - r.target) > r.target * tol + 1e-9) fail(`B1 ${r.kind} の分かれ道 ${f} が目標 ${r.target} の ±${(100 * tol).toFixed(0)}% に入りません`);
  }
  for (const k of got.keys()) if (!report.some((r) => r.kind === k)) fail(`B1 最初の手 ${k} の報告がありません`);
  return fails;
}

// ---- 状態

/** N10（まとめた行き先の代表の状態は、違う道を混ぜた物なので数えるだけ） */
export function checkN10(map: MapData): { fails: string[]; sumCount: number } {
  const { fails, fail } = collector();
  let sumCount = 0;
  for (let i = 0; i < map.n; i++) {
    if (map.role(i) === "a") continue;
    const st = map.st(i);
    if (st.pro === 1 && !(st.pm === "a" || st.pm === "s" || st.j === "i")) {
      if (map.sum(i)) sumCount++;
      else fail(`N10 Pro を出しているのに届け出が認められていない: ${map.key(i)}（${st.j}・${st.pm}）`);
    }
  }
  return { fails, sumCount };
}

/** C1: 幅の無い状態は整数の社数。幅は 0 以上の整数で小さい順（まとめた行き先の mix の顧客の幅とも同じ） */
export function checkClients(map: MapData): string[] {
  const { fails, fail } = collector();
  for (let i = 0; i < map.n; i++) {
    if (map.role(i) === "a") continue;
    const cl = map.st(i).cl;
    const b = map.band(i)?.cl;
    if (b) {
      if (!(Number.isInteger(b[0]) && Number.isInteger(b[1]) && 0 <= b[0] && b[0] <= b[1])) fail(`C1 顧客の幅が整数で小さい順でない: ${map.key(i)}（${b.join("〜")}）`);
    } else if (!(Number.isInteger(cl) && cl >= 0)) fail(`C1 幅の無い状態の社数が整数でない: ${map.key(i)}（${cl}）`);
    const mx = map.mix(i);
    if (mx && (b ? !(mx.cl[0] === b[0] && mx.cl[2] === b[1]) : mx.cl[0] !== mx.cl[2])) fail(`C1 mix の顧客の幅が band と違う: ${map.key(i)}`);
  }
  return fails;
}

/** K1: 入口の年月が生成の年月と同じで、4 月の月の番号が暦どおり */
export function checkCalendar(map: MapData, anchor: string, aprilMonths: readonly number[]): string[] {
  const out = map.header.anchor === anchor ? [] : [`K1 入口の年月 ${map.header.anchor} が生成の年月 ${anchor} と違います`];
  return [...out, ...calendarCheck(map.header.anchor, aprilMonths, map.header.horizon).map((s) => `K1 ${s}`)];
}

// ---- 値（アプリの決まり: src/model/impact.ts。SPEC v1 §3.2）

export interface MapValues {
  /** そのノードからの値（万円）。行き先は w(rr)·max(0, 36 − 月)、手は Σ p/100 (w(e) + V(子))、判断は一番良い手 */
  V: Float64Array;
  /** 判断で選ぶ手の番号（判断でなければ −1） */
  best: Int32Array;
}

/**
 * 読んだ地図の値（アプリと同じ決まり。年収 annual）。判断は値の大きい手、差が 1e-9 以内なら今のまま、次に並びの前の手。
 * keepOnly: どの判断でも今のまま（ずっと今のまま）
 */
export function mapValues(map: MapData, annual: number, keepOnly = false): MapValues {
  const S = annual / 12;
  const H = map.header.horizon;
  const n = map.n;
  const V = new Float64Array(n);
  const best = new Int32Array(n).fill(-1);
  const w = (x: readonly number[]) => x[0]! * S + x[1]! + x[2]!;
  for (let i = n - 1; i >= 0; i--) {
    const c = map.childCount(i);
    const role = map.role(i);
    if (c === 0) {
      V[i] = w(map.rr(i)) * Math.max(0, H - map.month(i));
      continue;
    }
    if (role === "a") {
      let v = 0;
      for (let k = 0; k < c; k++) {
        const j = map.child(i, k);
        v += (map.p(j) / 100) * (w(map.e(j)) + V[j]!);
      }
      V[i] = v;
      continue;
    }
    let b = -1;
    for (let k = 0; k < c; k++) {
      const j = map.child(i, k);
      if (keepOnly && map.isBase(j)) {
        b = j;
        break;
      }
      if (b < 0 || V[j]! > V[b]! + 1e-9 || (Math.abs(V[j]! - V[b]!) <= 1e-9 && map.isBase(j) && !map.isBase(b))) b = j;
    }
    best[i] = b;
    V[i] = V[b]!;
  }
  return { V, best };
}

export interface Consistency {
  /** 最初の手ごとのおすすめの道で通る判断（状態）の数と、一番良い手がまとめた手だった数 */
  decisions: number;
  intoStub: number;
  fails: string[];
}

/** R1: 最初の手はどれも選んだ物として、その後はアプリの一番良い手をたどる。まとめた手に入れば数える */
export function consistencyOfMap(map: MapData, annual: number): Consistency {
  const { fails, fail } = collector();
  const { best } = mapValues(map, annual);
  let decisions = 0;
  let intoStub = 0;
  const stack: number[] = [];
  for (let k = 0; k < map.childCount(0); k++) stack.push(map.child(0, k));
  while (stack.length) {
    const i = stack.pop()!;
    const role = map.role(i);
    if (role === "e") continue;
    if (role === "a") {
      for (let k = 0; k < map.childCount(i); k++) stack.push(map.child(i, k));
      continue;
    }
    decisions++;
    const b = best[i]!;
    if (map.stub(b)) {
      intoStub++;
      fail(`R1 おすすめの道がまとめた手に入ります（年収 ${annual}）: ${map.key(b)}`);
      continue;
    }
    stack.push(b);
  }
  return { decisions, intoStub, fails };
}

export interface Parity {
  annual: number;
  /** アプリ・読んだ値から直接 */
  vRoot: [number, number];
  vSQ: [number, number];
  /** 手の数と、手の差（今のままとの差）の |アプリ − 直接| の一番大きい物 */
  alts: number;
  maxDelta: number;
  /** 一番良い手が違う判断 */
  bestMismatch: number;
  ms: number;
}

/** R2: アプリの文書（軽い組み立て buildQuarterDoc。64 ビットの ID）を年収ごとに computeImpact し、読んだ値から直接出した値と比べる */
export function appParity(map: MapData, annuals: readonly number[]): { parities: Parity[]; fails: string[] } {
  const { fails, fail } = collector();
  const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: DIGEST_AT });
  const ids = Array.from({ length: map.n }, (_, i) => impactNodeId64(map.key(i)));
  const idx = buildIndex(doc);
  const rootId = ids[0]!;
  const parities: Parity[] = [];
  for (const annual of annuals) {
    const t0 = performance.now();
    const r = doc.nodes[rootId]!;
    const d2: DocData = { ...doc, nodes: { ...doc.nodes, [rootId]: { ...r, meta: { ...r.meta, impact: { v: 2, horizon: map.header.horizon, annual } } } } };
    const im = computeImpact(d2, idx.out, computeForecast(d2, idx.out), null);
    const ref = mapValues(map, annual);
    const sq = mapValues(map, annual, true);
    let alts = 0;
    let maxDelta = 0;
    let bestMismatch = 0;
    for (let i = 0; i < map.n; i++) {
      const role = map.role(i);
      if (role === "a") {
        const par = map.parent(i);
        let base = -1;
        for (let k = 0; k < map.childCount(par); k++) if (map.isBase(map.child(par, k))) base = map.child(par, k);
        const got = im.alt.get(ids[i]!)?.delta;
        if (base < 0) continue;
        alts++;
        const want = ref.V[i]! - ref.V[base]!;
        const d = got === undefined || got === null ? Infinity : Math.abs(got - want);
        if (d > maxDelta) maxDelta = d;
      } else if (map.childCount(i) > 0) {
        const want = ref.best[i]!;
        const got = im.decision.get(ids[i]!)?.best ?? null;
        if (got !== ids[want]) bestMismatch++;
      }
    }
    const p: Parity = { annual, vRoot: [im.vRoot ?? NaN, ref.V[0]!], vSQ: [im.vSQ ?? NaN, sq.V[0]!], alts, maxDelta, bestMismatch, ms: performance.now() - t0 };
    parities.push(p);
    if (!(Math.abs(p.vRoot[0] - p.vRoot[1]) <= 1e-9)) fail(`R2 今日の値がアプリと違います（年収 ${annual}）: ${p.vRoot[0]} / ${p.vRoot[1]}`);
    if (!(Math.abs(p.vSQ[0] - p.vSQ[1]) <= 1e-9)) fail(`R2 ずっと今のままの値がアプリと違います（年収 ${annual}）: ${p.vSQ[0]} / ${p.vSQ[1]}`);
    if (!(maxDelta <= 1e-9)) fail(`R2 手の差がアプリと違います（年収 ${annual}）: 最大 ${maxDelta}`);
    if (bestMismatch) fail(`R2 一番良い手がアプリと違う判断が ${bestMismatch}（年収 ${annual}）`);
  }
  return { parities, fails };
}

// ---- ID・決まり・大きさ

/** I1: 鍵からの 64 ビットの ID が重ならない（ノードと、子の鍵からの線） */
export function checkIds(map: MapData): { fails: string[]; nodes: number; edges: number } {
  const { fails, fail } = collector();
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (let i = 0; i < map.n; i++) {
    const k = map.key(i);
    const id = impactNodeId64(k);
    if (nodeIds.has(id)) fail(`I1 ノードの ID が重なります: ${k}（${id}）`);
    nodeIds.add(id);
    if (i > 0) {
      const e = impactEdgeId64(k);
      if (edgeIds.has(e)) fail(`I1 線の ID が重なります: ${k}（${e}）`);
      edgeIds.add(e);
    }
  }
  return { fails, nodes: nodeIds.size, edges: edgeIds.size };
}

/** D1: どの作り直しも、1 回目と同じバイト列と指紋 */
export function checkDeterminism(runs: ReadonlyArray<{ bytes: Uint8Array; hash: string; what: string }>): string[] {
  const out: string[] = [];
  const a = runs[0];
  if (!a) return ["D1 比べる物がありません"];
  for (const b of runs.slice(1)) {
    if (b.hash !== a.hash) out.push(`D1 指紋が違います: ${a.what} ${a.hash} / ${b.what} ${b.hash}`);
    let at = -1;
    const n = Math.min(a.bytes.length, b.bytes.length);
    for (let i = 0; i < n; i++)
      if (a.bytes[i] !== b.bytes[i]) {
        at = i;
        break;
      }
    if (at >= 0 || a.bytes.length !== b.bytes.length) out.push(`D1 決まった並びが違います: ${a.what} / ${b.what}（長さ ${a.bytes.length} / ${b.bytes.length}・初めて違う所 ${at}）`);
  }
  return out;
}

export interface Sizes {
  raw: number;
  gzip: number;
  base64: number;
}

/** Z1・Z2 */
export function checkSizes(s: Sizes): string[] {
  const out: string[] = [];
  if (s.raw > MAX_RAW) out.push(`Z1 決まった並びが ${s.raw} バイト（上限 ${MAX_RAW}）`);
  if (s.gzip > MAX_GZIP) out.push(`Z2 gzip が ${s.gzip} バイト（上限 ${MAX_GZIP}）`);
  return out;
}

// ---- 版の記録（scripts/impact/releases.json。足すだけ）

export interface ReleaseEntry {
  release: number;
  /** 中身の指紋。版 6 までは JSON の文字列の指紋（impactDataVersion）、版 7 からは決まった並びの 64 ビットの指紋 */
  hash: string;
  /** 指紋の作り: v2-json（版 6 まで）・q1（3 か月ごとの地図の同梱データ） */
  scheme: "v2-json" | "q1";
  anchor?: string;
  /** その版を記録したコミット（分かる物だけ） */
  commit?: string;
  /** 同じ版の順番で先に記録され、後で置き換えられた指紋（もう使わない） */
  replaced?: Array<{ hash: string; commit?: string }>;
  /** 3 か月ごとの地図（q1）を作った形: 分かれ道の目標・幅・最初の手の数・never・作った回数・ノードの数（本番の形でなければ記録に足さない） */
  build?: { B: number; tol: number; moves: number; never: boolean; runs: number; nodes: number };
  /** 3 か月ごとの地図（q1）の基準の文書の指紋（src/demo/impactDigest.ts の mapBaselineDigest。36 進 14 文字） */
  digest?: string;
}

/** 版の記録の作った形が本番の形か（今日の手すべて = 10 手以上・2,000・±2% 以内・never・2 回・ノード 90,000 まで）。違う所の文を返す */
export function buildProblems(b: ReleaseEntry["build"]): string[] {
  if (!b) return ["作った形 build がありません"];
  const out: string[] = [];
  if (b.B !== DEFAULTS.B) out.push(`分かれ道の目標 ${b.B}（${DEFAULTS.B} であること）`);
  if (!(b.tol <= DEFAULTS.tol + 1e-12)) out.push(`幅 ${b.tol}（${DEFAULTS.tol} 以下であること）`);
  if (!(b.moves >= 10)) out.push(`最初の手 ${b.moves}（今日の手すべて）`);
  if (!b.never) out.push("never なし");
  if (b.runs !== 2) out.push(`作った回数 ${b.runs}（2 回であること）`);
  if (!(b.nodes > 0 && b.nodes <= MAX_NODES)) out.push(`ノード ${b.nodes}`);
  return out;
}

export interface ReleaseHistory {
  note?: string;
  releases: ReleaseEntry[];
}

const HASH_FORM: Record<ReleaseEntry["scheme"], RegExp> = { "v2-json": /^[0-9a-z]+-[0-9a-z]+$/, q1: /^[0-9a-z]{14}$/ };

/** H1: 版の順番は記録の順に増えるだけ・同じ指紋は 1 つの版だけ（置き換えられた指紋も含む）・指紋の形 */
export function checkReleaseHistory(h: ReleaseHistory): string[] {
  const out: string[] = [];
  if (!h || !Array.isArray(h.releases)) return ["H1 版の記録に releases がありません"];
  const hashes = new Map<string, number>();
  let prev = -Infinity;
  for (const r of h.releases) {
    if (!Number.isInteger(r.release) || r.release < 1) out.push(`H1 版の順番が 1 以上の整数でありません: ${String(r.release)}`);
    if (r.release <= prev) out.push(`H1 版の順番が増えていません（戻る・同じ順番を使い直す）: ${prev} の後に ${r.release}`);
    prev = Math.max(prev, r.release);
    if (!(r.scheme in HASH_FORM)) out.push(`H1 知らない指紋の作り: ${String(r.scheme)}（版 ${r.release}）`);
    else if (!HASH_FORM[r.scheme].test(r.hash)) out.push(`H1 指紋の形が違います: ${r.hash}（版 ${r.release}・${r.scheme}）`);
    if (r.scheme === "q1") {
      for (const p of buildProblems(r.build)) out.push(`H1 版 ${r.release} は本番の形で作っていません: ${p}`);
      // 3 か月ごとの地図の記録には基準の文書の指紋が要る（無いと、同じ版のまま組み立てが変わっても比べられない。記録は足すだけで後から足せない: 見直し compat-3）
      if (r.digest === undefined) out.push(`H1 版 ${r.release}（q1）に基準の文書の指紋 digest がありません（版の順番を進めて、指紋のある記録を足し直す）`);
    }
    if (r.digest !== undefined && !(r.scheme === "q1" && HASH_FORM.q1.test(r.digest))) out.push(`H1 基準の文書の指紋の形が違います: ${String(r.digest)}（版 ${r.release}・${r.scheme}）`);
    for (const x of [r.hash, ...(r.replaced ?? []).map((y) => y.hash)]) {
      const was = hashes.get(x);
      if (was !== undefined) out.push(`H1 同じ指紋が 2 回あります: ${x}（版 ${was} と ${r.release}）`);
      hashes.set(x, r.release);
    }
  }
  return out;
}

/**
 * H1: 新しい記録 rec（3 か月ごとの地図。基準の文書の指紋 digest つき）を足せるか。同じ（版の順番・指紋）がもうあれば足さずに済む（"same"）。
 * ただし記録の基準の文書の指紋が今の組み立ての指紋と違えば断る（同じ版のまま組み立てが変わった: 版の順番を進める。見直し safety-4）。
 * 3 か月ごとの地図（q1）の記録は、どちらかの指紋が無ければ比べられないので "same" にしない・足さない（見直し compat-3）。
 * 版の順番が最後の版以下（戻る・使い直す）や、同じ指紋が別の版の順番にある物は足さない（文を返す）
 */
export function checkReleaseAppend(h: ReleaseHistory, rec: { release: number; hash: string; digest?: string }): { verdict: "append" | "same" | "refuse"; why: string[] } {
  const why = checkReleaseHistory(h);
  if (why.length) return { verdict: "refuse", why };
  const hasDigest = rec.digest !== undefined && HASH_FORM.q1.test(rec.digest);
  const same = h.releases.find((r) => r.release === rec.release);
  if (same && same.hash === rec.hash) {
    if (same.scheme === "q1") {
      if (same.digest === undefined) return { verdict: "refuse", why: [`H1 版 ${rec.release} の記録に基準の文書の指紋がありません（今の組み立てと比べられない。版の順番を進めて記録し直す）`] };
      if (!hasDigest) return { verdict: "refuse", why: [`H1 今の組み立ての基準の文書の指紋が無いか形が違うので（${String(rec.digest)}）、版 ${rec.release} の記録と比べられません`] };
      if (same.digest !== rec.digest)
        return { verdict: "refuse", why: [`H1 版 ${rec.release} の基準の文書の指紋 ${same.digest} が今の組み立て ${rec.digest} と違います（鍵・ID・線・タグ・期限・やることの元の作りを変えたら版の順番を進める）`] };
    }
    return { verdict: "same", why: [] };
  }
  if (same) return { verdict: "refuse", why: [`H1 版 ${rec.release} はもう別の指紋 ${same.hash} で記録されています（中身を変えたら版の順番を進める）`] };
  const used = h.releases.find((r) => r.hash === rec.hash || (r.replaced ?? []).some((y) => y.hash === rec.hash));
  if (used) return { verdict: "refuse", why: [`H1 指紋 ${rec.hash} はもう版 ${used.release} で記録されています`] };
  const last = Math.max(0, ...h.releases.map((r) => r.release));
  if (rec.release <= last) return { verdict: "refuse", why: [`H1 版の順番 ${rec.release} は最後の版 ${last} 以下です（戻せない）`] };
  if (!hasDigest) return { verdict: "refuse", why: [`H1 基準の文書の指紋が無いか形が違う記録（${String(rec.digest)}）は足しません（足すだけの記録なので、後から指紋を足せない）`] };
  return { verdict: "append", why: [] };
}

/** 版の記録の JSON の書き方（1 行に 1 つの版。足すだけの記録なので、差分が足した行だけになる。scripts/impact/releases.json はこの形のまま） */
export function formatHistory(h: ReleaseHistory): string {
  const fmt = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(fmt).join(", ")}]`;
    if (typeof x === "object" && x !== null) return `{ ${Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}: ${fmt(v)}`).join(", ")} }`;
    return JSON.stringify(x);
  };
  const head = h.note !== undefined ? `  "note": ${JSON.stringify(h.note)},\n` : "";
  return `{\n${head}  "releases": [\n${h.releases.map((r) => `    ${fmt(r)}`).join(",\n")}\n  ]\n}\n`;
}
