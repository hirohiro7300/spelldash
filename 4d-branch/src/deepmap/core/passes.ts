// 年収ごとの稼ぎ・逆にたどる計算（値と選び方）・前へ流す計算（来る見込み）（設計: 作業メモ SPEC v1 §3.2・§7.1 の 2・3）
// src/model/impact.ts の computeImpact と同じ答えを出す（tests/unit/deepmapCore.test.ts で 1e-9 まで比べる）:
//   S = 年収 / 12、w(x) = x[0]·S + x[1] + x[2]（万円）
//   行き先（子の無いカード） V = w(rr)·max(0, H − 月)
//   手（結果で分かれる）     V = Σ 割合 ×（w(e(子)) + V(子)）。割合は % を兄弟の合計で割った物（アプリの chanceWeights）
//   判断（今日・状態）       V = 選ぶ手の w(e) + V。選ぶ手 = 選んだ手があればその中で、無ければ見送った手を除いて一番良い手。
//                            値の差が 1e-9 以内なら今のまま、次に並びの前（アプリの better と同じ）
// 「ずっと今のまま」（policy "keep"）は、今のままがあって選べる判断では必ず今のままを選ぶ（無ければふつうの選び方）。
// 選んだ手・見送った手（status）・シナリオ（allowed）・除く手（exclude）は、アプリに入れるとき（W-app）のための入口。

import { ROLE_A, F_BASE, F_Q, F_STUB, type CompiledMap } from "./compile";

/** 値の差がこれ以内なら同じとみなす（アプリの better と同じ） */
export const TIE = 1e-9;

/** 年収で決まる稼ぎ（選び方によらない） */
export interface Money {
  readonly annual: number;
  /** 月給（年収 / 12） */
  readonly S: number;
  /** 親からの線の稼ぎ w(e)（結果はその 3 か月の稼ぎ。手は判断からの線で、ふつう 0） */
  readonly We: Float64Array;
  /** その時点の月の稼ぎ w(rr)（万円/月） */
  readonly Wrr: Float64Array;
  /** 今日からそこまでの稼ぎ（親の acc + w(e)） */
  readonly acc: Float64Array;
}

export function moneyAt(cm: CompiledMap, annual: number): Money {
  if (!(typeof annual === "number" && Number.isFinite(annual) && annual > 0)) throw new RangeError(`年収が数ではありません: ${annual}`);
  const { n, e, rr, parent } = cm;
  const S = annual / 12;
  const We = new Float64Array(n);
  const Wrr = new Float64Array(n);
  const acc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    We[i] = S * e[i3]! + e[i3 + 1]! + e[i3 + 2]!;
    Wrr[i] = S * rr[i3]! + rr[i3 + 1]! + rr[i3 + 2]!;
    acc[i] = i === 0 ? 0 : acc[parent[i]!]! + We[i]!;
  }
  return { annual, S, We, Wrr, acc };
}

export type Policy = "pi" | "keep";

export interface PassOptions {
  /** 選び方: "pi" おすすめ（選んだ手があればその中で一番良い手）/ "keep" ずっと今のまま */
  policy?: Policy;
  /** 手ごとの状態（手のノード番号で引く）: 0 まだ・1 選んだ（進行中・完了）・2 見送った。無ければ全部 0 */
  status?: Uint8Array | null;
  /** 選べる手（手のノード番号で引く。1 = 選べる）。シナリオで絞るとき。無ければ全部選べる */
  allowed?: Uint8Array | null;
  /** 除く手（1 = 除く）。今のまま（比べる元）は除かない。その種類の手を使わない場合の計算など */
  exclude?: Uint8Array | null;
}

export interface Pass {
  readonly cm: CompiledMap;
  readonly money: Money;
  readonly policy: Policy;
  /** その時点から H か月目までの稼ぎ（その後は選び方どおり）。手は結果の平均（判断からの線の稼ぎは含まない） */
  readonly V: Float64Array;
  /** H か月目の月の稼ぎ（選び方どおりに進んだ場合の平均。アプリの rate） */
  readonly R: Float64Array;
  /** 数が出せる（選べる手が無い判断・数の出せない子しか無い手は 0） */
  readonly def: Uint8Array;
  /** 先に数の出ない所がある */
  readonly partial: Uint8Array;
  /** 判断で選ぶ手（子のノード番号。判断でない・数が出せなければ −1） */
  readonly pi: Int32Array;
  /** 一番良い手（見送った手を除く。選んだ手は考えない。アプリの best） */
  readonly best: Int32Array;
  /** 今日（= 1）から選び方どおりに進んだときに、そこへ来る見込み（アプリの pPi） */
  readonly reach: Float64Array;
  /** 今日の手ごとに、その手を選んだ（= 1）とした後、選び方どおりに進んだときの見込み */
  readonly reachIn: Float64Array;
}

export function runPass(cm: CompiledMap, money: Money, opts: PassOptions = {}): Pass {
  const { n, kidOff, kids, role, flags, w, rank, month, H, firstMoves } = cm;
  const { We, Wrr } = money;
  const policy: Policy = opts.policy ?? "pi";
  const keep = policy === "keep";
  const status = opts.status ?? null;
  const allowed = opts.allowed ?? null;
  const exclude = opts.exclude ?? null;
  const V = new Float64Array(n);
  const R = new Float64Array(n);
  const def = new Uint8Array(n);
  const partial = new Uint8Array(n);
  const pi = new Int32Array(n).fill(-1);
  const best = new Int32Array(n).fill(-1);
  // アプリの better: 値が 1e-9 より大きければ良い。差が小さければ今のまま、次に並びの前
  const better = (j: number, qj: number, b: number, qb: number): boolean => {
    if (b < 0) return true;
    if (qj > qb + TIE) return true;
    if (qj < qb - TIE) return false;
    const bj = flags[j]! & F_BASE;
    const bb = flags[b]! & F_BASE;
    if (bj !== bb) return bj !== 0;
    return rank[j]! < rank[b]!;
  };
  for (let i = n - 1; i >= 0; i--) {
    const a = kidOff[i]!;
    const b = kidOff[i + 1]!;
    if (a === b) {
      const left = Math.max(0, H - month[i]!);
      V[i] = Wrr[i]! * left;
      R[i] = Wrr[i]!;
      def[i] = 1;
      continue;
    }
    if (role[i] === ROLE_A) {
      let sw = 0;
      let cnt = 0;
      let part = 0;
      for (let s = a; s < b; s++) {
        const c = kids[s]!;
        if (!def[c]) {
          part = 1;
          continue;
        }
        sw += w[c]!;
        cnt++;
      }
      if (cnt === 0) continue;
      const equal = sw <= 0;
      const norm = equal ? cnt : sw;
      let v = 0;
      let r = 0;
      for (let s = a; s < b; s++) {
        const c = kids[s]!;
        if (!def[c]) continue;
        const ww = (equal ? 1 : w[c]!) / norm;
        v += ww * (We[c]! + V[c]!);
        r += ww * R[c]!;
        if (partial[c]) part = 1;
      }
      V[i] = v;
      R[i] = r;
      def[i] = 1;
      partial[i] = part;
      continue;
    }
    // 判断
    let anyJ = -1;
    let anyQ = 0;
    let bestJ = -1;
    let bestQ = 0;
    let pickJ = -1;
    let pickQ = 0;
    let baseJ = -1;
    for (let s = a; s < b; s++) {
      const j = kids[s]!;
      const isBase = (flags[j]! & F_BASE) !== 0;
      if (isBase && baseJ < 0) baseJ = j;
      if (!def[j] || (allowed !== null && !allowed[j])) continue;
      if (exclude !== null && exclude[j] && !isBase) continue;
      const qj = We[j]! + V[j]!;
      if (better(j, qj, anyJ, anyQ)) (anyJ = j), (anyQ = qj);
      const st = status !== null ? status[j]! : 0;
      if (st !== 2 && better(j, qj, bestJ, bestQ)) (bestJ = j), (bestQ = qj);
      if (st === 1 && better(j, qj, pickJ, pickQ)) (pickJ = j), (pickQ = qj);
    }
    if (anyJ < 0) continue;
    if (bestJ < 0) bestJ = anyJ;
    const forceBase = keep && baseJ >= 0 && (allowed === null || allowed[baseJ] === 1) && def[baseJ] === 1;
    const c = forceBase ? baseJ : pickJ >= 0 ? pickJ : bestJ;
    V[i] = We[c]! + V[c]!;
    R[i] = R[c]!;
    partial[i] = partial[c]!;
    def[i] = 1;
    pi[i] = c;
    best[i] = bestJ;
  }
  // 前へ流す。今日の手はどれも 1 から始めて（reachIn）、今日の選ぶ手の先だけを今日からの見込み（reach）にする
  const reachIn = new Float64Array(n);
  for (const f of firstMoves) reachIn[f] = 1;
  for (let i = 1; i < n; i++) {
    const m = reachIn[i]!;
    if (!(m > 0) || !def[i]) continue;
    const a = kidOff[i]!;
    const b = kidOff[i + 1]!;
    if (a === b) continue;
    if (role[i] !== ROLE_A) {
      const c = pi[i]!;
      if (c >= 0) reachIn[c] = reachIn[c]! + m;
      continue;
    }
    let sw = 0;
    let cnt = 0;
    for (let s = a; s < b; s++) {
      const c = kids[s]!;
      if (def[c]) (sw += w[c]!), cnt++;
    }
    if (!cnt) continue;
    const equal = sw <= 0;
    for (let s = a; s < b; s++) {
      const c = kids[s]!;
      if (def[c]) reachIn[c] = reachIn[c]! + (m * (equal ? 1 : w[c]!)) / (equal ? cnt : sw);
    }
  }
  const reach = new Float64Array(n);
  reach[0] = 1;
  const top = def[0] ? pi[0]! : -1;
  if (top >= 0) {
    const end = top + cm.size[top]!;
    for (let i = top; i < end; i++) reach[i] = reachIn[i]!;
  }
  return { cm, money, policy, V, R, def, partial, pi, best, reach, reachIn };
}

/** おすすめの選び方と、ずっと今のまま（同じ年収・同じ選んだ手とシナリオ） */
export interface Analysis {
  readonly cm: CompiledMap;
  readonly annual: number;
  readonly money: Money;
  /** おすすめ（選んだ手があればその中で一番良い手） */
  readonly pi: Pass;
  /** ずっと今のまま */
  readonly keep: Pass;
  /** 今日から 3 年の稼ぎ（おすすめの選び方）。数が出せなければ null */
  readonly vRoot: number | null;
  /** 今日から 3 年の稼ぎ（ずっと今のまま） */
  readonly vSQ: number | null;
  /** 計算したときの地図の版（形・数）。数を入れ直すと古くなる（assertFresh） */
  readonly stamp: { readonly topology: number; readonly numbers: number };
}

export function analyze(cm: CompiledMap, annual: number, opts: Omit<PassOptions, "policy"> = {}): Analysis {
  const money = moneyAt(cm, annual);
  const pi = runPass(cm, money, { ...opts, policy: "pi" });
  const keep = runPass(cm, money, { status: opts.status ?? null, allowed: opts.allowed ?? null, policy: "keep" });
  const stamp = { topology: cm.version.topology, numbers: cm.version.numbers };
  return { cm, annual, money, pi, keep, vRoot: pi.def[0] ? pi.V[0]! : null, vSQ: keep.def[0] ? keep.V[0]! : null, stamp };
}

/**
 * 計算が今の地図の版の物か確かめる。数を入れ直した（refillNumbers）後の古い計算は、新しい数と混ざるので止める（作業メモ code-3）。
 * 見取り図・扇・進め方・道・行き先と、その画面の形（views）の入口で呼ぶ
 */
export function assertFresh(a: Analysis): void {
  const v = a.cm.version;
  if (a.stamp.topology !== v.topology || a.stamp.numbers !== v.numbers) throw new Error("古い計算です（地図の数を入れ直した後は analyze し直す）");
}

/**
 * 値の内訳 [本業, 広告運用・独立, SpellDash]（3 つずつ。アプリの valueV）。選び方は pass のまま、逆にたどって足し直す（O(N)）。
 * 数が出せないカードは NaN
 */
export function valueParts(pass: Pass): Float64Array {
  const { n, kidOff, kids, role, w, month, H, e, rr } = pass.cm;
  const { S } = pass.money;
  const { def, pi } = pass;
  const out = new Float64Array(n * 3);
  for (let i = n - 1; i >= 0; i--) {
    const i3 = i * 3;
    if (!def[i]) {
      out[i3] = out[i3 + 1] = out[i3 + 2] = NaN;
      continue;
    }
    const a = kidOff[i]!;
    const b = kidOff[i + 1]!;
    if (a === b) {
      const left = Math.max(0, H - month[i]!);
      out[i3] = S * rr[i3]! * left;
      out[i3 + 1] = rr[i3 + 1]! * left;
      out[i3 + 2] = rr[i3 + 2]! * left;
      continue;
    }
    if (role[i] === ROLE_A) {
      let sw = 0;
      let cnt = 0;
      for (let s = a; s < b; s++) if (def[kids[s]!]) (sw += w[kids[s]!]!), cnt++;
      const equal = sw <= 0;
      const norm = equal ? cnt : sw;
      let x = 0;
      let y = 0;
      let z = 0;
      for (let s = a; s < b; s++) {
        const c = kids[s]!;
        if (!def[c]) continue;
        const ww = (equal ? 1 : w[c]!) / norm;
        const c3 = c * 3;
        x += ww * (S * e[c3]! + out[c3]!);
        y += ww * (e[c3 + 1]! + out[c3 + 1]!);
        z += ww * (e[c3 + 2]! + out[c3 + 2]!);
      }
      out[i3] = x;
      out[i3 + 1] = y;
      out[i3 + 2] = z;
      continue;
    }
    const c = pi[i]!;
    const c3 = c * 3;
    out[i3] = S * e[c3]! + out[c3]!;
    out[i3 + 1] = e[c3 + 1]! + out[c3 + 1]!;
    out[i3 + 2] = e[c3 + 2]! + out[c3 + 2]!;
  }
  return out;
}

/** 手の値（判断からの線の稼ぎを含む。アプリの Q）。数が出せなければ NaN */
export function optionValue(pass: Pass, j: number): number {
  return pass.def[j] ? pass.money.We[j]! + pass.V[j]! : NaN;
}

/**
 * 比べ方をそろえた手の値（作業メモ truth-2）: 生成が書いた q（その 3 か月は正確に・その後は標準の選び方）。
 * まとめた手は木の値がそのまま同じ見積もり方。どちらでもなければ NaN
 */
export function likeValue(pass: Pass, j: number): number {
  const { flags, q } = pass.cm;
  const f = flags[j]!;
  if (f & F_Q) return pass.money.S * q[j * 3]! + q[j * 3 + 1]! + q[j * 3 + 2]!;
  if (f & F_STUB) return optionValue(pass, j);
  return NaN;
}

/** 差の出し方: "q" 同じ見積もり方（q・まとめた手の値）で比べた / "tree" 地図の値（先を広げた手は、その先の選び直しも入る）で比べた */
export type DeltaBasis = "q" | "tree";

export interface Delta {
  d: number;
  basis: DeltaBasis;
}

/** 同じ判断の 2 つの手の差（j − b）。両方とも同じ見積もり方の値があればそれで、無ければ地図の値で。数が出せなければ null */
export function deltaBetween(pass: Pass, j: number, b: number): Delta | null {
  const lj = likeValue(pass, j);
  const lb = likeValue(pass, b);
  if (Number.isFinite(lj) && Number.isFinite(lb)) return { d: lj - lb, basis: "q" };
  const vj = optionValue(pass, j);
  const vb = optionValue(pass, b);
  return Number.isFinite(vj) && Number.isFinite(vb) ? { d: vj - vb, basis: "tree" } : null;
}

/** 手ごとの今のままとの差（地図の値どうし。q の無い地図のアプリの AltInfo.delta と同じ。q のある地図のアプリの差は deltaBetween）。手でない・今のままが無い・数が出せなければ NaN */
export function optionDeltas(pass: Pass): Float64Array {
  const { n, role, kidOff, kids, flags } = pass.cm;
  const out = new Float64Array(n).fill(NaN);
  for (let d = 0; d < n; d++) {
    if (role[d] === ROLE_A || kidOff[d] === kidOff[d + 1]) continue;
    let base = -1;
    for (let s = kidOff[d]!; s < kidOff[d + 1]!; s++) {
      if (flags[kids[s]!]! & F_BASE) {
        base = kids[s]!;
        break;
      }
    }
    if (base < 0) continue;
    const vb = optionValue(pass, base);
    if (!Number.isFinite(vb)) continue;
    for (let s = kidOff[d]!; s < kidOff[d + 1]!; s++) {
      const j = kids[s]!;
      out[j] = optionValue(pass, j) - vb;
    }
  }
  return out;
}

/**
 * カードごとの「3 年の合計 − ずっと今のまま」（地図を引いて見たときの塗り。作業メモ user-1 (3)）:
 * 今日からそこまでの稼ぎ + そこから先（おすすめの選び方）の値 − ずっと今のままの 3 年。数が出せなければ NaN
 */
export function heatValues(a: Analysis): Float64Array {
  const { n } = a.cm;
  const out = new Float64Array(n).fill(NaN);
  if (a.vSQ === null) return out;
  const { acc } = a.money;
  const { V, def } = a.pi;
  for (let i = 0; i < n; i++) if (def[i]) out[i] = acc[i]! + V[i]! - a.vSQ;
  return out;
}

/** そのまとまりの手（今のままを除く）に 1 を立てた印。runPass の exclude に渡すと「その種類を 3 年使わない」計算（アプリの never の木の版） */
export function familyMask(cm: CompiledMap, fam: string): Uint8Array {
  const { n, role, flags, fam: famIx, famNames } = cm;
  const f = famNames.indexOf(fam);
  const out = new Uint8Array(n);
  if (f < 0) return out;
  for (let i = 0; i < n; i++) if (role[i] === ROLE_A && famIx[i] === f && !(flags[i]! & F_BASE)) out[i] = 1;
  return out;
}

/** シナリオで選べる手（アプリと同じ: 今のまま・シナリオの書いていない種類・そのシナリオを含む種類） */
export function scenarioMask(cm: CompiledMap, scenarioId: string): Uint8Array {
  const { n, role, flags, kind, kindNames } = cm;
  const kinds = cm.map.header.kinds;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (role[i] !== ROLE_A) continue;
    if (flags[i]! & F_BASE) {
      out[i] = 1;
      continue;
    }
    const sc = kinds[kindNames[kind[i]!]!]?.[3] ?? [];
    out[i] = sc.length === 0 || sc.includes(scenarioId) ? 1 : 0;
  }
  return out;
}
