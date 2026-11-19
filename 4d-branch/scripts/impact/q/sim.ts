// 3 か月の手の計算（3 か月ごとの世界だけで使う。元の計算 ../sim.ts は同梱の版 6 の元なので変えない）。設計: 作業メモ SPEC v1 §2.2・§2.3
// 元の計算と同じ月ごとの決まり（出来事 → 4 月の昇給 → 伸び → 有料 → 顧客 → 稼ぎ）に、P2 の前提を足す:
//   顧客は整数の社数。3 か月ごとに 1 社ずつ 1 − 0.96³ の見込みで離れ（二項分布）、離れる顧客もその 3 か月の初めの 1 か月分は払う
//   副業の新しい顧客は月 3 万円、顧客が 4 社に届いた後に増えた顧客は月 5 万円（今の顧客は据え置く）。独立してから増やした顧客は月 7 万円
//   Pro は初回 1 か月無料（有料になった人は翌月から払う）
//   転職: 移る先は今の届け出の答えと同じ範囲を認める会社だけ（見込みに認める割合を掛ける）。答えは引き継ぎ、まだ・不可なら『まだ』に戻る
//   会社員に戻ると、届け出なしで『SpellDash だけ可』。顧客は手放す
// 1 つの出来事の分かれ（branch）の中では、仕事・給与と SpellDash の数と顧客は互いに関係なく動くので、別々に数え上げてから掛け合わせる。
// まとめた結果の状態は、顧客について「整数の社数の場合の混ざり（帳簿 cb）」を持つ。次の 3 か月はその場合ごとに数えるので、どの場合も社数は整数のまま

import { capOf, round2, round4, type Job, type Perm, type St, type Vec3 } from "../sim";
import { quarterFlags } from "./quarter";
import type { WorldQ } from "./world";

/** 顧客の帳簿の 1 つの場合: 月額の段ごとの社数 [副業の新しい月額, 上げた月額, 独立の月額]・料金を上げたか（顧客が 4 社に届いた）・重み */
export interface Comp {
  n: [number, number, number];
  f5: 0 | 1;
  w: number;
}

/** 3 か月ごとの世界の状態: 元の状態に、顧客の帳簿（場合の混ざり。重みの合計 1）を足す。cl・fee は帳簿の平均（cl × fee = 月の売上の見込み） */
export interface QSt extends St {
  cb: Comp[];
}

export interface QSample {
  w: number;
  /** その 3 か月の終わりの状態（帳簿は 1 つの場合だけ） */
  x: QSt;
  r: Vec3;
  tag: string;
}

/** 月額の段（0 副業の新しい顧客・1 上げた後の顧客・2 独立してから増やした顧客） */
export const priceOf = (w: WorldQ, t: number): number => (t === 0 ? w.q.feeFirst : t === 1 ? w.q.feeRaised : w.constants.indFee);
const countOf = (n: readonly number[]) => n[0]! + n[1]! + n[2]!;
const revOf = (w: WorldQ, n: readonly number[]) => n[0]! * priceOf(w, 0) + n[1]! * priceOf(w, 1) + n[2]! * priceOf(w, 2);
export const compKey = (c: { n: readonly number[]; f5: number }) => `${c.n[0]}.${c.n[1]}.${c.n[2]}.${c.f5}`;
/** 場合の番号（社数は 1 段 15 社まで。並べる順もこの番号の順） */
const compNum = (n: readonly number[], f5: number) => ((f5 * 16 + n[2]!) * 16 + n[1]!) * 16 + n[0]!;

/** 帳簿の数: 社数の平均・月の売上の平均・社数の一番小さい・大きい場合 */
export function bookStats(w: WorldQ, cb: readonly Comp[]): { cl: number; rev: number; lo: number; hi: number } {
  let cl = 0;
  let rev = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of cb) {
    const k = countOf(c.n);
    cl += c.w * k;
    rev += c.w * revOf(w, c.n);
    if (c.w > 0) {
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
  }
  return { cl, rev, lo: lo === Infinity ? 0 : lo, hi: hi === -Infinity ? 0 : hi };
}

/** 重み付きの場合を足し合わせる入れ物（同じ場合はまとめる）。book() で重みの合計を 1 にした帳簿（並びは決まった順） */
export class BookAcc {
  m = new Map<number, Comp>();
  tot = 0;
  add(n: readonly number[], f5: 0 | 1, w: number): void {
    if (!(w > 0)) return;
    this.tot += w;
    const k = compNum(n, f5);
    const hit = this.m.get(k);
    if (hit) hit.w += w;
    else this.m.set(k, { n: [n[0]!, n[1]!, n[2]!], f5, w });
  }
  book(): Comp[] {
    if (!this.m.size) return [{ n: [0, 0, 0], f5: 0, w: 1 }];
    const out = [...this.m.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    for (const c of out) c.w /= this.tot;
    return out;
  }
}

/** 帳簿から cl（社数の平均。1 つの場合なら整数）・fee（1 社あたりの月額の平均。丸めないので cl × fee が売上）を入れる */
export function setBook(w: WorldQ, x: QSt, cb: Comp[]): QSt {
  const b = bookStats(w, cb);
  x.cb = cb;
  x.cl = cb.length === 1 ? b.cl : round4(b.cl);
  x.fee = b.cl > 0 ? b.rev / b.cl : 0;
  return x;
}

/** 帳簿の鍵（正確な状態の鍵に使う） */
export const bookKey = (cb: readonly Comp[]): string => cb.map((c) => `${compKey(c)}:${c.w}`).join(",");

/** ふつうの状態（今日など）を 3 か月ごとの状態にする。顧客は整数で、月額は 1 つの段の値であること */
export function toQ(w: WorldQ, s: St): QSt {
  const n = Math.round(s.cl);
  if (Math.abs(s.cl - n) > 1e-9) throw new Error(`顧客の社数が整数ではありません: ${s.cl}`);
  const t = [0, 1, 2].find((k) => priceOf(w, k) === s.fee) ?? 0;
  const counts: [number, number, number] = [0, 0, 0];
  counts[t] = n;
  return setBook(w, { ...s, fl: [...s.fl], cb: [] }, [{ n: counts, f5: n >= w.q.raiseAt ? 1 : 0, w: 1 }]);
}

/** 月の稼ぎ [給与の倍率, 広告運用 万円/月, SpellDash 万円/月]（帳簿の平均の売上。SpellDash は今の有料の人が来月払う分） */
export function runRateQ(w: WorldQ, s: QSt): Vec3 {
  const c = w.constants;
  const sal = s.j === "e" ? s.sal : s.j === "p" ? c.partFactor * s.sal : 0;
  return [round4(sal), round2(bookStats(w, s.cb).rev - (s.j === "i" ? c.indOverhead : 0)), round2((s.pu - s.seats) * c.net + s.seats * (c.seatNet ?? c.net) - c.infra)];
}

// ---- 出来事の分かれ

/** 期間の何か月目（1..3）の初めに起きること。仕事・給与・届け出・印・Pro／SpellDash の数／顧客 のどれかを変える */
interface Ev {
  at: number;
  j?: Job;
  salSet?: number;
  salAdd?: number;
  salMul?: number;
  pm?: Perm;
  pro?: true;
  add?: string[];
  drop?: string[];
  mau?: number;
  school?: true;
  cvMul?: number;
  client?: true;
  dropClients?: true;
}

/** 顧客の来る窓（期間の月 from..to に、月あたり lam 社。onlyInd なら独立している月だけ。fromClients なら紹介なので、初めに顧客がいる場合だけ） */
interface Win {
  from: number;
  to: number;
  lam: number;
  onlyInd: boolean;
  fromClients?: boolean;
}

interface Br {
  p: number;
  tag: string;
  ev: Ev[];
  /** 移る月（costAt）の初めに引く給与の月数（移る前の給与で数える） */
  cost: number;
  costAt: number;
  g: number;
  gsd: number;
  conv: number;
  convVar: boolean;
  spend: number;
  win: Win[];
}

/** Pro を出してよい（届け出の答えが『全部可』か『SpellDash だけ可』、または独立） */
const proAllowed = (j: Job, pm: Perm) => pm === "a" || pm === "s" || j === "i";
/** 期間の途中で届け出の答えが出る・独立する手（その翌月に Pro を出す） */
const LATE_PRO_KINDS = new Set(["ad_perm", "ad_permside", "ind_quit"]);
/** Pro を自分で出す手（届け出て Pro を出す。Pro だけを出す手 sd_pro は 3 か月ごとの世界には無い） */
const SELF_PRO_KINDS = new Set(["sd_permpro"]);

/** 転職の見込みに掛ける数: 今の答えと同じ範囲を認める会社だけを受ける（全部可 → 全部可の割合・SpellDash だけ可 → SpellDash を認める割合・まだ／不可 → 1） */
export function offerScale(w: WorldQ, pm: Perm): number {
  const c = w.constants.perm;
  return pm === "a" ? c.a : pm === "s" ? c.a + c.s : 1;
}

/** 移った会社での答え: 『全部可』『SpellDash だけ可』は引き継ぎ、まだ・不可は『まだ』（また届け出られる） */
export const carriedPm = (pm: Perm): Perm => (pm === "a" || pm === "s" ? pm : "?");

/** 3 か月の手の出来事の分かれ（../sim.ts の branchesOfRaw の 3 か月の場合に、P2 の前提を足した物） */
function branchesQ(w: WorldQ, s0: QSt, kind: string, m0: number): Br[] {
  const c = w.constants;
  const p = w.kinds[kind === "fc_switch2" ? "fc_switch" : kind]!.p;
  const base = (): Br => ({ p: 1, tag: "", ev: [], cost: 0, costAt: 0, g: c.g0, gsd: c.gsd, conv: c.conv, convVar: false, spend: 0, win: [] });
  const one = (f: (b: Br) => void = () => undefined): Br[] => {
    const b = base();
    f(b);
    return [b];
  };
  const bern = (q: number, yes: string, no: string, fy: (b: Br) => void, fn: (b: Br) => void = () => undefined): Br[] => {
    const by = base();
    by.p = q;
    by.tag = yes;
    fy(by);
    const bn = base();
    bn.p = 1 - q;
    bn.tag = no;
    fn(bn);
    return [by, bn].filter((b) => b.p > 1e-9);
  };
  const perm = (mk: () => Br = base): Br[] =>
    (["a", "s", "n"] as const).map((pm) => {
      const b = mk();
      b.p = c.perm[pm];
      b.tag = pm;
      b.ev.push({ at: 1, pm });
      return b;
    });
  const has = (f: string) => s0.fl.includes(f);
  switch (kind) {
    case "keep":
      return one((b) => {
        if (s0.j === "i") b.win.push({ from: 1, to: 3, lam: p.indLambda!, onlyInd: false });
      });
    case "sd_permpro":
      return perm(() => ({ ...base(), g: c.g0 + p.gBump! })).map((b) => {
        if (b.tag !== "n") {
          b.ev.push({ at: 2, pro: true });
          b.convVar = true;
        }
        return b;
      });
    case "sd_grow":
      return one((b) => {
        b.g = p.g!;
        b.gsd = p.gsd!;
      });
    case "sd_pilot":
      return bern(p.p!, "yes", "no", (b) => b.ev.push({ at: 3, add: ["pilot"], mau: p.mau! }));
    case "sd_school": {
      const q = Math.min(0.6, Math.min(p.max!, p.perQuarter!) * (has("pilot") ? p.pilotMult! : 1));
      return bern(q, "yes", "no", (b) => b.ev.push({ at: 2, school: true, add: ["school"] }));
    }
    case "sd_ads":
      return one((b) => {
        b.spend = p.spend!;
        b.g = p.g!;
        b.gsd = p.gsd!;
        b.conv = p.conv!;
      });
    case "sd_retain":
      return one((b) => {
        b.g = p.g!;
        b.ev.push({ at: 1, cvMul: p.convMult! });
      });
    case "fc_scope":
      return one((b) => {
        b.g = c.g0 - p.gCut!;
        b.ev.push({ at: 1, add: ["scope"] });
      });
    case "fc_push": {
      const a = c.aprilMonths.find((x) => x > m0 && x <= m0 + 3);
      if (a === undefined) throw new Error(`4 月を含まない 3 か月に昇格を狙う手（${m0} か月目）`);
      const q = has("scope") ? p.pScope! : p.p!;
      return bern(
        q,
        "up",
        "same",
        (b) => {
          b.g = c.g0 - p.gCut!;
          b.ev.push({ at: a - m0, salAdd: p.step! });
        },
        (b) => void (b.g = c.g0 - p.gCut!),
      );
    }
    case "fc_switch":
    case "fc_switch2": {
      const at = Math.min(p.moveAt!, 3);
      const f = offerScale(w, s0.pm);
      const pH = (kind === "fc_switch2" ? w.qSwitch2.pHigh : p.pHigh3!) * f;
      const pM = (kind === "fc_switch2" ? w.qSwitch2.pMid : p.pMid3!) * f;
      const pm = carriedPm(s0.pm);
      const move = (tag: string, q: number, mult: number): Br => ({ ...base(), p: q, tag, cost: c.switchCost ?? 0, costAt: at, ev: [{ at, salMul: mult, pm, drop: ["scope"], add: ["switched"] }] });
      return [move("high", pH, p.high!), move("mid", pM, p.mid!), { ...base(), p: 1 - pH - pM, tag: "none" }];
    }
    case "part":
      return bern(p.p!, "p", "e", (b) => b.ev.push({ at: Math.min(p.at!, 3), j: "p" }));
    case "ad_portfolio":
      return bern(
        p.p!,
        "yes",
        "no",
        (b) => {
          b.g = c.g0 - p.gCut!;
          b.ev.push({ at: 3, add: ["portfolio"] });
        },
        (b) => void (b.g = c.g0 - p.gCut!),
      );
    case "ad_perm":
      return perm();
    case "ad_permside": {
      const first = has("portfolio") ? p.firstPortfolio! : p.first!;
      const out: Br[] = [];
      for (const br of perm()) {
        if (br.tag !== "a") {
          out.push(br);
          continue;
        }
        out.push({ ...br, p: br.p * first, tag: "a1", ev: [...br.ev, { at: 2, client: true }] }, { ...br, p: br.p * (1 - first), tag: "a0", ev: [...br.ev] });
      }
      return out;
    }
    case "ad_side": {
      const q = has("portfolio") ? p.pPortfolio! : p.p!;
      return bern(q, "yes", "no", (b) => b.ev.push({ at: 2, client: true }));
    }
    case "ad_more":
      return one((b) => b.win.push({ from: 1, to: 3, lam: s0.j === "i" ? p.lamInd! : s0.j === "p" ? p.lamPart! : p.lamEmp!, onlyInd: false, fromClients: true }));
    case "ind_quit":
      return one((b) => {
        const at = Math.min(p.at!, 3);
        b.ev.push({ at, j: "i" });
        b.win.push({ from: at, to: 3, lam: p.lam!, onlyInd: false });
      });
    case "back_emp":
      return bern(
        p.p!,
        "e",
        "i",
        // 戻る会社は SpellDash を認める会社（届け出なしで『SpellDash だけ可』）。広告運用の顧客は手放す
        (b) => b.ev.push({ at: Math.min(p.at!, 3), j: "e", salSet: p.sal!, dropClients: true, pm: "s", drop: ["switched"] }),
        (b) => b.win.push({ from: 1, to: 3, lam: w.kinds.keep!.p.indLambda!, onlyInd: false }),
      );
    default:
      throw new Error(`3 か月ごとの世界に無い手: ${kind}`);
  }
}

// ---- 仕事・給与（出来事の分かれごとに 1 通り）

interface JobRun {
  /** 月ごとの仕事と Pro（0 は期間の初め） */
  J: Job[];
  P: Array<0 | 1>;
  j: Job;
  pm: Perm;
  pro: 0 | 1;
  sal: number;
  fl: string[];
  r0: number;
}

function jobPass(w: WorldQ, s0: QSt, br: Br, m0: number, latePro: boolean): JobRun {
  const c = w.constants;
  let j = s0.j;
  let pm = s0.pm;
  let pro = s0.pro;
  let sal = s0.sal;
  const fl = new Set(s0.fl);
  const J: Job[] = [j];
  const P: Array<0 | 1> = [pro];
  let r0 = 0;
  const salEff = () => (j === "e" ? sal : j === "p" ? c.partFactor * sal : 0);
  for (let i = 1; i <= 3; i++) {
    // 前の月までに認められた・独立したなら、この月に Pro を出す
    if (latePro && pro === 0 && proAllowed(j, pm)) pro = 1;
    if (br.cost && br.costAt === i) r0 -= br.cost * salEff();
    for (const ev of br.ev) {
      if (ev.at !== i) continue;
      if (ev.j) j = ev.j;
      if (ev.salSet !== undefined) sal = ev.salSet;
      if (ev.salAdd !== undefined) sal += ev.salAdd;
      if (ev.salMul !== undefined) sal *= ev.salMul;
      if (ev.pm) pm = ev.pm;
      if (ev.pro) pro = 1;
      for (const f of ev.drop ?? []) fl.delete(f);
      for (const f of ev.add ?? []) fl.add(f);
    }
    if (c.aprilMonths.includes(m0 + i) && (j === "e" || j === "p")) sal *= 1 + c.aprilRaise;
    r0 += salEff();
    J.push(j);
    P.push(pro);
  }
  return { J, P, j, pm, pro, sal, fl: [...fl].sort(), r0 };
}

// ---- SpellDash の数（伸びの幅 × 有料になる割合の幅）

interface SdRun {
  w: number;
  mau: number;
  pu: number;
  seats: number;
  cv: number;
  r2: number;
}

function sdPass(w: WorldQ, s0: QSt, br: Br, run: JobRun, zg: number, conv: number, weight: number): SdRun {
  const c = w.constants;
  let mau = s0.mau;
  let pu = s0.pu;
  let seats = s0.seats;
  let cv = s0.cv;
  let r2 = 0;
  for (let i = 1; i <= 3; i++) {
    for (const ev of br.ev) {
      if (ev.at !== i) continue;
      if (ev.mau !== undefined) mau += ev.mau;
      if (ev.school) {
        seats += c.schoolSeats;
        pu += c.schoolSeats;
      }
      if (ev.cvMul !== undefined) cv = Math.min(2.5, cv * ev.cvMul);
    }
    const g = br.g + zg * br.gsd + (run.J[i] === "p" ? c.partGrowth : 0);
    mau = Math.max(c.minMau, mau * (1 + g));
    // 初回 1 か月無料: この月に払うのは、先月までに有料になった人（学校の席は導入した月から）
    const paying = pu - seats;
    if (run.P[i]) {
      const free = pu - seats;
      const target = conv * cv * mau;
      pu = seats + Math.max(0, free + c.convPull * (target - free));
    }
    r2 += paying * c.net + seats * (c.seatNet ?? c.net) - c.infra - br.spend;
  }
  return { w: weight, mau, pu, seats, cv, r2 };
}

// ---- 顧客（帳簿の場合 × 離れる社数 × 来る社数）

interface ClRun {
  n: [number, number, number];
  f5: 0 | 1;
  w: number;
  r1: number;
}

/** 来る社数の見込み（../sim.ts と同じ: 平均 1.5 以下は 0・1・2・3 以上、それより上は 3 点） */
export function poissonCounts(mu: number, sw: Array<[number, number]>): Array<[number, number]> {
  if (!(mu > 0)) return [[0, 1]];
  if (mu <= 1.5) {
    const out: Array<[number, number]> = [];
    let acc = 0;
    let p = Math.exp(-mu);
    for (let k = 0; k < 3; k++) {
      out.push([k, p]);
      acc += p;
      p = (p * mu) / (k + 1);
    }
    out.push([3, Math.max(0, 1 - acc)]);
    return out.filter(([, q]) => q > 0.003).map(([k, q], _i, arr) => [k, q / arr.reduce((s, x) => s + x[1], 0)]);
  }
  const sd = Math.sqrt(mu);
  const pts = new Map<number, number>();
  for (const [z, q] of sw) {
    const k = Math.max(0, Math.round(mu + z * sd));
    pts.set(k, (pts.get(k) ?? 0) + q);
  }
  return [...pts.entries()];
}

/** n 社のうち k 社が離れる見込み */
export function binomP(n: number, k: number, q: number): number {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c * Math.pow(q, k) * Math.pow(1 - q, n - k);
}

const clientMemo = new WeakMap<WorldQ, Map<string, ClRun[]>>();

/** 1 つの帳簿の場合から、その 3 か月の顧客の行き先（重みの合計 1・同じ行き先はまとめ、売上は重みで平均） */
function clientPass(w: WorldQ, br: Br, run: JobRun, comp: Comp): ClRun[] {
  const evs = br.ev.filter((e) => e.client || e.dropClients);
  const key = `${evs.map((e) => `${e.at}${e.client ? "c" : "d"}`).join("")}|${br.win.map((x) => `${x.from}-${x.to}-${x.lam}-${x.onlyInd ? 1 : 0}${x.fromClients ? "f" : ""}`).join(",")}|${run.J.join("")}|${compKey(comp)}`;
  let memo = clientMemo.get(w);
  if (!memo) clientMemo.set(w, (memo = new Map()));
  const hit = memo.get(key);
  if (hit) return hit;
  const c = w.constants;
  const q = w.q.churnQ;
  const capAt = (i: number) => capOf(w, { j: run.J[i]! } as St);
  // 離れる社数（段ごとに二項分布。その 3 か月の初めにいた顧客だけ）
  const leave: Array<{ k: [number, number, number]; p: number }> = [];
  for (let a = 0; a <= comp.n[0]; a++)
    for (let b = 0; b <= comp.n[1]; b++)
      for (let d = 0; d <= comp.n[2]; d++) {
        const p = binomP(comp.n[0], a, q) * binomP(comp.n[1], b, q) * binomP(comp.n[2], d, q);
        if (p > 0) leave.push({ k: [a, b, d], p });
      }
  // 窓ごとの来る社数（紹介の窓は、初めに顧客がいる場合だけ）
  let arrivals: Array<{ k: number[]; p: number }> = [{ k: [], p: 1 }];
  for (const win of br.win) {
    const pts: Array<[number, number]> = win.fromClients && countOf(comp.n) === 0 ? [[0, 1]] : poissonCounts(win.lam * (win.to - win.from + 1), w.swanson);
    arrivals = arrivals.flatMap((a) => pts.map(([k, p]) => ({ k: [...a.k, k], p: a.p * p })));
  }
  const acc = new Map<number, ClRun>();
  for (const lv of leave) {
    for (const ar of arrivals) {
      const n: [number, number, number] = [comp.n[0], comp.n[1], comp.n[2]];
      let f5: 0 | 1 = comp.f5 || countOf(n) >= w.q.raiseAt ? 1 : 0;
      let r1 = 0;
      const add = (j: Job, cap: number) => {
        if (countOf(n) >= cap) return;
        n[j === "i" ? 2 : f5 ? 1 : 0]++;
        if (countOf(n) >= w.q.raiseAt) f5 = 1;
      };
      for (let i = 1; i <= 3; i++) {
        const j = run.J[i]!;
        const cap = capAt(i);
        for (const ev of evs) {
          if (ev.at !== i) continue;
          if (ev.client) add(j, cap);
          if (ev.dropClients) {
            n[0] = n[1] = n[2] = 0;
            f5 = 0;
          }
        }
        // 離れる顧客は 2 か月目の初めに離れる（1 か月目の分は払う）
        if (i === 2) for (let t = 0; t < 3; t++) n[t] = Math.max(0, n[t]! - lv.k[t]!);
        br.win.forEach((win, wi) => {
          if (i < win.from || i > win.to) return;
          const len = win.to - win.from + 1;
          const idx = i - win.from;
          const k = ar.k[wi]!;
          const came = Math.floor((k * (idx + 1)) / len + 1e-9) - Math.floor((k * idx) / len + 1e-9);
          for (let x = 0; x < came; x++) if (!win.onlyInd || j === "i") add(j, cap);
        });
        r1 += revOf(w, n) - (j === "i" ? c.indOverhead : 0);
      }
      const p = lv.p * ar.p;
      const k = compNum(n, f5);
      const prev = acc.get(k);
      if (prev) {
        prev.r1 += p * r1;
        prev.w += p;
      } else acc.set(k, { n, f5, w: p, r1: p * r1 });
    }
  }
  const out = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => o);
  for (const o of out) o.r1 /= o.w;
  memo.set(key, out);
  return out;
}

/** 状態 s0 から m0 か月目に手 kind を 3 か月たどった数え上げ（出来事 × 伸びの幅 × 有料になる割合の幅 × 顧客の行き先） */
export function simQ(w: WorldQ, s0: QSt, kind: string, m0: number): QSample[] {
  const c = w.constants;
  const out: QSample[] = [];
  const allowed0 = proAllowed(s0.j, s0.pm);
  const selfPro = SELF_PRO_KINDS.has(kind);
  const autoPro = s0.pro === 0 && allowed0 && !selfPro;
  const latePro = s0.pro === 0 && !allowed0 && !selfPro && LATE_PRO_KINDS.has(kind);
  for (const br0 of branchesQ(w, s0, kind, m0)) {
    const br: Br = { ...br0, ev: [...br0.ev], win: [...br0.win] };
    // 続けている SpellDash の作業: 認められていて Pro がまだなら、期間の 2 か月目に出す。期間の途中で認められた・独立したら、その翌月
    if (autoPro) {
      br.convVar = true;
      br.ev.push({ at: 2, pro: true });
    } else if (latePro) br.convVar = true;
    // 独立していれば、ほかの手を選んでいてもふだんの営業は続ける
    if (s0.j === "i" && !br.win.length) br.win.push({ from: 1, to: 3, lam: w.kinds.keep!.p.indLambda!, onlyInd: true });
    const run = jobPass(w, s0, br, m0, latePro);
    quarterFlags(s0, kind, run);
    const sds: SdRun[] = [];
    for (const [zg, pg] of w.swanson) {
      const convs: Array<[number, number]> = br.convVar ? w.swanson.map(([z, q]) => [br.conv * Math.exp(c.convSd * z), q]) : [[br.conv, 1]];
      for (const [conv, pc] of convs) sds.push(sdPass(w, s0, br, run, zg, conv, pg * pc));
    }
    // 帳簿の場合ごとの顧客の行き先を、同じ行き先どうしでまとめる
    const cls = new Map<number, ClRun>();
    for (const comp of s0.cb) {
      for (const o of clientPass(w, br, run, comp)) {
        const k = compNum(o.n, o.f5);
        const prev = cls.get(k);
        const wt = comp.w * o.w;
        if (prev) {
          prev.r1 += wt * o.r1;
          prev.w += wt;
        } else cls.set(k, { n: o.n, f5: o.f5, w: wt, r1: wt * o.r1 });
      }
    }
    const clList = [...cls.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => o);
    for (const o of clList) o.r1 /= o.w;
    // 1 つの場合だけの帳簿は行き先ごとに 1 つ作り、伸びの幅の数え上げで分け合う（状態は作った後に書き換えない）
    const books = clList.map((cl): Comp[] => [{ n: [cl.n[0], cl.n[1], cl.n[2]], f5: cl.f5, w: 1 }]);
    const fl = run.fl;
    const sal = round4(run.sal);
    const r0 = round4(run.r0);
    for (const sd of sds) {
      const mau = round2(sd.mau);
      const pu = round2(sd.pu);
      const cv = round4(sd.cv);
      const r2 = round2(sd.r2);
      clList.forEach((cl, i) => {
        const x: QSt = { j: run.j, pm: run.pm, pro: run.pro, mau, pu, seats: sd.seats, cl: 0, fee: 0, sal, cv, fl, cb: [] };
        setBook(w, x, books[i]!);
        out.push({ w: br.p * sd.w * cl.w, x, r: [r0, round2(cl.r1), r2], tag: br.tag });
      });
    }
  }
  return out;
}
