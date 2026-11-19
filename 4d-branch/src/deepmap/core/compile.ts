// 読むだけの地図（MapData）を 1 回だけ型付き配列に組み直す「計算の芯」（設計: 作業メモ SPEC v1 §5・§7.1 の 1〜3・11）
// 番号は MapData と同じ深さ優先の順（親は子より前・兄弟は並べる順）。だから、どのカードの先（部分木）も
// [i, i + size[i]) の続いた番号になり、今日の手ごとの数・扇・進め方は、その範囲をなめるだけで出る（O(部分木)）。
//
// 2 つの版に分けて持つ（作業メモ perf-11）:
//   形（topology）: 親子・役割・深さ・部分木の大きさ・下にある判断と行き先の数。カードが増減したときだけ作り直す
//   数（numbers） : 月・見込み %・稼ぎ・今のまま・まとめた手・q・事実。数が変わったら refillNumbers で入れ直す
// 年収・選んだ手と見送った手・シナリオは計算（passes.ts）の入力で、ここには持たない。

import type { MapData, MapRole } from "../mapData";

export const ROLE_R = 0;
export const ROLE_A = 1;
export const ROLE_S = 2;
export const ROLE_E = 3;
const ROLE_CODE: Readonly<Record<MapRole, number>> = { r: ROLE_R, a: ROLE_A, s: ROLE_S, e: ROLE_E };
const ROLE_NAME: readonly MapRole[] = ["r", "a", "s", "e"];

/** 印（flags のビット）: 今のまま（その判断で比べる元） */
export const F_BASE = 1;
/** まとめた手（子はまとめた行き先だけ） */
export const F_STUB = 2;
/** まとめた行き先（標準の選び方で続けた見積もり） */
export const F_SUM = 4;
/** q（まとめた手と同じ見積もり方の値）がある手 */
export const F_Q = 8;
/** 確かめるだけの事実（会社の答えなど）を知る結果 */
export const F_RV = 16;
/** まとめた行き先の中身（mix）がある */
export const F_MIX = 32;
/** まとめた行き先の後の目安（cont）がある */
export const F_CONT = 64;

export interface CompiledMap {
  readonly map: MapData;
  readonly n: number;
  /** 何か月目まで数えるか（36） */
  readonly H: number;

  // ---- 形（topology）
  /** 親の番号（今日は −1） */
  readonly parent: Int32Array;
  /** 子の並び（CSR）: i の子は kids[kidOff[i] .. kidOff[i + 1]) */
  readonly kidOff: Int32Array;
  readonly kids: Int32Array;
  /** 役割（ROLE_R・ROLE_A・ROLE_S・ROLE_E） */
  readonly role: Uint8Array;
  /** 今日からの深さ（今日 0・今日の手 1・その結果 2 …） */
  readonly depth: Uint16Array;
  /** 部分木の大きさ（自分を含む）。i の先は [i, i + size[i]) */
  readonly size: Int32Array;
  /** 兄弟の中の順番（0 から。アプリの meta.rank と同じ） */
  readonly rank: Int32Array;
  /** どの今日の手の下か（今日の手のノード番号。今日は −1） */
  readonly first: Int32Array;
  /** 今日の手（並べる順） */
  readonly firstMoves: Int32Array;
  /** 部分木の中の判断（手が 2 つ以上の今日・状態）の数 */
  readonly nDec: Int32Array;
  /** 部分木の中の出来事の分かれ（結果が 2 つ以上の手）の数 */
  readonly nSplit: Int32Array;
  /** 部分木の中の行き先の数（まとめた物を含む） */
  readonly nEnd: Int32Array;
  /** 部分木の中のまとめた行き先の数 */
  readonly nSumEnd: Int32Array;

  // ---- 数（numbers）
  /** 計算に使う月（アプリと同じく 0〜H に収め、親の月より前にしない） */
  readonly month: Float64Array;
  /** 手の種類の番号（kindNames の添え字。手でなければ −1） */
  readonly kind: Int16Array;
  /** 手のまとまりの番号（famNames の添え字。手でなければ −1） */
  readonly fam: Int16Array;
  readonly kindNames: readonly string[];
  readonly famNames: readonly string[];
  /** 印（F_BASE など） */
  readonly flags: Uint8Array;
  /** 結果の見込み %（結果でなければ 0） */
  readonly p: Float64Array;
  /** 兄弟の中の割合（アプリの chanceWeights と同じ: % を 0〜100 に収めて兄弟の合計で割る。合計が 0 なら等分） */
  readonly w: Float64Array;
  /** 親からの線の稼ぎ [給与の月数, 広告運用 万円, SpellDash 万円]（3 つずつ）。手は判断の月の稼ぎ × 経った月（ふつう 0） */
  readonly e: Float64Array;
  /** その時点の月の稼ぎ [給与の倍率, 広告運用 万円/月, SpellDash 万円/月]（3 つずつ）。手は判断の物 */
  readonly rr: Float64Array;
  /** q（3 つずつ。無ければ NaN） */
  readonly q: Float64Array;
  /** 事実の名前の番号（facts の添え字。無ければ −1） */
  readonly rvFact: Int16Array;
  /** 事実の答えの番号（answers の添え字。無ければ −1） */
  readonly rvAns: Int16Array;
  readonly facts: readonly string[];
  readonly answers: readonly string[];

  /** 版（形・数）。数を入れ直すと numbers が 1 つ進む */
  readonly version: { topology: number; numbers: number };
  /** 地図が持つ物の数（試し版に「どの数で比べたか」を出す） */
  readonly has: { q: number; mix: number; cont: number; never: boolean };
}

/** 地図を組み直す（O(N)）。番号が深さ優先の順でない・役割の親子がおかしい地図は止める */
export function compileMap(map: MapData): CompiledMap {
  const n = map.n;
  if (!(n >= 1)) throw new Error("地図にカードがありません");
  const kidOff = new Int32Array(n + 1);
  let links = 0;
  for (let i = 0; i < n; i++) {
    kidOff[i] = links;
    links += map.childCount(i);
  }
  kidOff[n] = links;
  if (links !== n - 1) throw new Error(`地図の親子の数が合いません（カード ${n}・親子 ${links}）`);
  const kids = new Int32Array(links);
  const parent = new Int32Array(n);
  const role = new Uint8Array(n);
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = ROLE_CODE[map.role(i)];
    if (r === undefined) throw new Error(`役割が分かりません: ${i}`);
    role[i] = r;
    parent[i] = map.parent(i);
    const a = kidOff[i]!;
    const cnt = kidOff[i + 1]! - a;
    for (let k = 0; k < cnt; k++) {
      const c = map.child(i, k);
      if (!(c > i && c < n)) throw new Error(`子の番号が親より前か範囲の外です: ${i} → ${c}`);
      kids[a + k] = c;
      rank[c] = k;
    }
  }
  if (parent[0] !== -1 || role[0] !== ROLE_R) throw new Error("0 番が今日になっていません");
  for (let i = 0; i < n; i++) {
    const ri = role[i]!;
    for (let s = kidOff[i]!; s < kidOff[i + 1]!; s++) {
      const c = kids[s]!;
      if (parent[c] !== i) throw new Error(`親子が食い違っています: ${i} → ${c}`);
      const rc = role[c]!;
      const ok = ri === ROLE_A ? rc === ROLE_S || rc === ROLE_E : ri !== ROLE_E && rc === ROLE_A;
      if (!ok) throw new Error(`役割の親子がおかしい: ${ROLE_NAME[ri]} → ${ROLE_NAME[rc]}（${map.key(c)}）`);
    }
  }
  // 部分木の大きさ（後ろから足す）と、深さ優先の順の確かめ（最初の子は i + 1、次の子は前の子の部分木のすぐ後）
  const size = new Int32Array(n).fill(1);
  for (let i = n - 1; i > 0; i--) size[parent[i]!] = size[parent[i]!]! + size[i]!;
  for (let i = 0; i < n; i++) {
    let c = i + 1;
    for (let s = kidOff[i]!; s < kidOff[i + 1]!; s++) {
      if (kids[s] !== c) throw new Error(`地図の番号が深さ優先の順になっていません（${map.key(i)}）`);
      c += size[kids[s]!]!;
    }
  }
  const depth = new Uint16Array(n);
  const first = new Int32Array(n);
  first[0] = -1;
  for (let i = 1; i < n; i++) {
    const p = parent[i]!;
    depth[i] = depth[p]! + 1;
    first[i] = p === 0 ? i : first[p]!;
  }
  const firstMoves = kids.slice(kidOff[0]!, kidOff[1]!);
  // 下にある判断・出来事の分かれ・行き先の数（後ろから親へ足す。作業メモ perf-14）
  const nDec = new Int32Array(n);
  const nSplit = new Int32Array(n);
  const nEnd = new Int32Array(n);
  const nSumEnd = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const deg = kidOff[i + 1]! - kidOff[i]!;
    const r = role[i]!;
    if ((r === ROLE_R || r === ROLE_S) && deg >= 2) nDec[i] = 1;
    if (r === ROLE_A && deg >= 2) nSplit[i] = 1;
    if (r === ROLE_E) {
      nEnd[i] = 1;
      if (map.sum(i)) nSumEnd[i] = 1;
    }
  }
  for (let i = n - 1; i > 0; i--) {
    const p = parent[i]!;
    nDec[p] = nDec[p]! + nDec[i]!;
    nSplit[p] = nSplit[p]! + nSplit[i]!;
    nEnd[p] = nEnd[p]! + nEnd[i]!;
    nSumEnd[p] = nSumEnd[p]! + nSumEnd[i]!;
  }
  const cm: CompiledMap = {
    map,
    n,
    H: horizonOf(map),
    parent,
    kidOff,
    kids,
    role,
    depth,
    size,
    rank,
    first,
    firstMoves,
    nDec,
    nSplit,
    nEnd,
    nSumEnd,
    month: new Float64Array(n),
    kind: new Int16Array(n),
    fam: new Int16Array(n),
    kindNames: [],
    famNames: [],
    flags: new Uint8Array(n),
    p: new Float64Array(n),
    w: new Float64Array(n),
    e: new Float64Array(n * 3),
    rr: new Float64Array(n * 3),
    q: new Float64Array(n * 3),
    rvFact: new Int16Array(n),
    rvAns: new Int16Array(n),
    facts: [],
    answers: [],
    version: { topology: 1, numbers: 0 },
    has: { q: 0, mix: 0, cont: 0, never: false },
  };
  fillNumbers(cm, map);
  return cm;
}

/**
 * 数だけを入れ直す（同じ形の地図: カードの数・親子が同じ）。形が違えば止める（compileMap で作り直す）。
 * 年収・選んだ手・シナリオが変わっただけなら、これも要らない（計算だけやり直す）
 */
export function refillNumbers(cm: CompiledMap, map: MapData): void {
  if (map.n !== cm.n) throw new Error("形の違う地図です（作り直してください）");
  for (let i = 0; i < cm.n; i++) {
    if (map.parent(i) !== cm.parent[i] || ROLE_CODE[map.role(i)] !== cm.role[i]) throw new Error("形の違う地図です（作り直してください）");
  }
  fillNumbers(cm, map);
}

function horizonOf(map: MapData): number {
  // アプリの impactConfigOf と同じ（0 より大きい数なら 240 まで。無ければ 36）
  const h = map.header.horizon as number;
  return typeof h === "number" && Number.isFinite(h) && h > 0 ? Math.min(240, h) : 36;
}

function intern(list: string[], index: Map<string, number>, s: string): number {
  const hit = index.get(s);
  if (hit !== undefined) return hit;
  const k = list.length;
  if (k >= 32767) throw new Error("名前の種類が多すぎます");
  list.push(s);
  index.set(s, k);
  return k;
}

function fillNumbers(cm: CompiledMap, map: MapData): void {
  const { n, parent, role, kidOff, kids, month, kind, fam, flags, p, w, e, rr, q, rvFact, rvAns } = cm;
  const H = horizonOf(map);
  (cm as { H: number }).H = H;
  const header = map.header;
  // 手の種類とまとまり（見出しの順。見出しに無い種類は後ろへ足す。まとまりはアプリと同じく見出しのまとまり、無ければ種類そのもの）
  const kindNames = cm.kindNames as string[];
  const famNames = cm.famNames as string[];
  const facts = cm.facts as string[];
  const answers = cm.answers as string[];
  kindNames.length = 0;
  famNames.length = 0;
  facts.length = 0;
  answers.length = 0;
  const kindIx = new Map<string, number>();
  const famIx = new Map<string, number>();
  const factIx = new Map<string, number>();
  const ansIx = new Map<string, number>();
  const kindFam: number[] = [];
  const famOfKind = (k: string): number => {
    const ki = intern(kindNames, kindIx, k);
    if (kindFam[ki] === undefined) kindFam[ki] = intern(famNames, famIx, header.kinds[k]?.[2] ?? k);
    return ki;
  };
  for (const k of Object.keys(header.kinds)) famOfKind(k);
  const has = cm.has as { q: number; mix: number; cont: number; never: boolean };
  has.q = 0;
  has.mix = 0;
  has.cont = 0;
  has.never = !!header.never && typeof header.never === "object" && Array.isArray(header.never._all);
  for (let i = 0; i < n; i++) {
    const r = role[i]!;
    const par = parent[i]!;
    const lo = par >= 0 ? month[par]! : 0;
    const m = map.month(i);
    month[i] = Math.min(H, Math.max(0, lo, typeof m === "number" && Number.isFinite(m) ? m : lo));
    let f = 0;
    kind[i] = -1;
    fam[i] = -1;
    p[i] = 0;
    rvFact[i] = -1;
    rvAns[i] = -1;
    const i3 = i * 3;
    q[i3] = NaN;
    q[i3 + 1] = NaN;
    q[i3 + 2] = NaN;
    if (r === ROLE_A) {
      const ki = famOfKind(map.kind(i) ?? "");
      kind[i] = ki;
      fam[i] = kindFam[ki]!;
      if (map.isBase(i)) f |= F_BASE;
      if (map.stub(i)) f |= F_STUB;
      const qq = map.q(i);
      if (qq && qq.length === 3 && qq.every((x) => Number.isFinite(x))) {
        q[i3] = qq[0];
        q[i3 + 1] = qq[1];
        q[i3 + 2] = qq[2];
        f |= F_Q;
        has.q++;
      }
      // 手の月の稼ぎは判断の物（アプリは meta.rr の無いノードに親の物を使う）。線の稼ぎは判断の月の稼ぎ × 経った月（ふつう 0）
      const p3 = par * 3;
      const dt = Math.max(0, month[i]! - month[par]!);
      for (let c = 0; c < 3; c++) {
        rr[i3 + c] = rr[p3 + c]!;
        e[i3 + c] = dt > 0 ? rr[p3 + c]! * dt : 0;
      }
    } else {
      const x = map.rr(i);
      for (let c = 0; c < 3; c++) rr[i3 + c] = finite(x[c]);
      if (r === ROLE_R) {
        e[i3] = 0;
        e[i3 + 1] = 0;
        e[i3 + 2] = 0;
      } else {
        const y = map.e(i);
        for (let c = 0; c < 3; c++) e[i3 + c] = finite(y[c]);
        p[i] = finite(map.p(i));
        const rv = map.rv(i);
        if (rv) {
          rvFact[i] = intern(facts, factIx, rv[0]);
          rvAns[i] = intern(answers, ansIx, rv[1]);
          f |= F_RV;
        }
        if (r === ROLE_E && map.sum(i)) f |= F_SUM;
        if (map.mix(i)) (f |= F_MIX), has.mix++;
        if (map.cont(i)) (f |= F_CONT), has.cont++;
      }
    }
    flags[i] = f;
  }
  // 結果の割合（アプリの chanceWeights: % が書いてあれば 0〜100 に収めて合計で割る。合計が 0 なら等分）
  for (let i = 0; i < n; i++) {
    if (role[i] !== ROLE_A) continue;
    const a = kidOff[i]!;
    const b = kidOff[i + 1]!;
    let total = 0;
    for (let s = a; s < b; s++) total += Math.max(0, Math.min(100, p[kids[s]!]!));
    for (let s = a; s < b; s++) {
      const c = kids[s]!;
      w[c] = total > 0 ? Math.max(0, Math.min(100, p[c]!)) / total : 1 / (b - a);
    }
  }
  w[0] = 1;
  (cm.version as { numbers: number }).numbers++;
}

function finite(x: number | undefined): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

/** 3 か月ごとの段（0 か月目 = 0、3 か月目 = 1 … 36 か月目 = 12）。月が 3 の倍数でなければ、その月を含む段 */
export function quarterOf(m: number): number {
  return Math.max(0, Math.floor(m / 3 + 1e-9));
}

/** 判断（今日・状態）か */
export function isDecision(cm: CompiledMap, i: number): boolean {
  const r = cm.role[i]!;
  return r === ROLE_R || r === ROLE_S;
}

/** 子の数 */
export function degree(cm: CompiledMap, i: number): number {
  return cm.kidOff[i + 1]! - cm.kidOff[i]!;
}

/** 判断の今のまま（最初の今のまま。無ければ −1） */
export function baseOf(cm: CompiledMap, d: number): number {
  for (let s = cm.kidOff[d]!; s < cm.kidOff[d + 1]!; s++) if (cm.flags[cm.kids[s]!]! & F_BASE) return cm.kids[s]!;
  return -1;
}

/** 手の種類の名前（鍵）。手でなければ "" */
export function kindKey(cm: CompiledMap, i: number): string {
  const k = cm.kind[i]!;
  return k >= 0 ? cm.kindNames[k]! : "";
}

/** 手のまとまりの名前（鍵）。手でなければ "" */
export function famKey(cm: CompiledMap, i: number): string {
  const f = cm.fam[i]!;
  return f >= 0 ? cm.famNames[f]! : "";
}

/** x が a の先（a 自身を含む）か */
export function isUnder(cm: CompiledMap, x: number, a: number): boolean {
  return x >= a && x < a + cm.size[a]!;
}
