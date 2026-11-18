// 3 年の分かれ道の数の元: 状態（仕事・届け出・SpellDash・顧客・給与）と、手ごとの出来事を月ごとにたどる決まった計算（乱数は使わない）。
// 出来事（決まる・決まらない）× 伸びの幅（10%・50%・90% の 3 点、重み 30・40・30）× 顧客の来る数 を全部数え上げる。

export type Job = "e" | "p" | "i";
export type Perm = "?" | "a" | "s" | "n";

export interface St {
  /** 会社員・週 4 日・独立 */
  j: Job;
  /** 副業の届け出の答え: まだ・全部可・SpellDash だけ・不可 */
  pm: Perm;
  /** Pro を出した */
  pro: 0 | 1;
  /** 月に遊ぶ人 */
  mau: number;
  /** 有料会員（学校の席を含む） */
  pu: number;
  /** 学校の席 */
  seats: number;
  /** 広告運用の顧客（社） */
  cl: number;
  /** 1 社あたりの月額（万円） */
  fee: number;
  /** 給与（今を 1.0） */
  sal: number;
  /** 有料になる割合の倍率（続ける工夫） */
  cv: number;
  /** 印: scope 担当拡大・pilot 学校の試用・portfolio 実績・switched 転職済み */
  fl: string[];
}

export interface Constants {
  net: number;
  infra: number;
  indOverhead: number;
  aprilMonths: number[];
  aprilRaise: number;
  partFactor: number;
  partGrowth: number;
  sideFee: number;
  indFee: number;
  churn: number;
  capEmp: number;
  capPart: number;
  capInd: number;
  g0: number;
  gsd: number;
  conv: number;
  convSd: number;
  convPull: number;
  minMau: number;
  schoolSeats: number;
  baseHours: number;
  perm: { a: number; s: number; n: number };
}

export interface KindDef {
  label: string;
  area: "sd" | "fc" | "ind" | "base";
  family: string;
  scen: string[];
  hours: number;
  stages: number[];
  p: Record<string, number>;
}

export interface World {
  version: number;
  horizon: number;
  annual: number;
  stages: Array<{ month: number; len: number; maxAlts: number; maxOuts: number; plan?: boolean }>;
  cap: { nodes: number };
  minOutcomeP: number;
  neutralBand: number;
  today: St;
  constants: Constants;
  swanson: Array<[number, number]>;
  buckets: { mau: number[]; pu: number[]; cl: number[] };
  keyFamilies: string[];
  rootMenu: string[];
  kinds: Record<string, KindDef>;
  premises: string[];
  baseRates: Array<{ id: string; statement: string; range: [number, number]; source: string }>;
}

export type Vec3 = [number, number, number];

/** 結果の分け方の種類 */
export type Driver =
  | { t: "num"; metric: "mau" | "pu" | "cl" }
  | { t: "sal" }
  | { t: "cat"; metric: "perm" | "job" | "flag" | "permside" | "ind"; flag?: string }
  | { t: "none" };

export interface Sample {
  w: number;
  x: St;
  /** 期間の稼ぎ [給与の月数, 広告運用の万円, SpellDash の万円] */
  r: Vec3;
  /** 出来事の印（分け方に使う） */
  tag: string;
}

export const clone = (s: St): St => ({ ...s, fl: [...s.fl] });
export const has = (s: St, f: string) => s.fl.includes(f);
const addFlag = (s: St, f: string) => {
  if (!s.fl.includes(f)) s.fl = [...s.fl, f].sort();
};
const dropFlag = (s: St, f: string) => {
  s.fl = s.fl.filter((x) => x !== f);
};

/** 抱えられる顧客の数 */
export function capOf(w: World, s: St): number {
  const c = w.constants;
  return s.j === "i" ? c.capInd : s.j === "p" ? c.capPart : c.capEmp;
}

/** 給与の月数の倍率（独立は 0） */
export function salEff(w: World, s: St): number {
  return s.j === "e" ? s.sal : s.j === "p" ? w.constants.partFactor * s.sal : 0;
}

/** その時点の月の稼ぎ [給与の倍率, 広告運用 万円/月, SpellDash 万円/月]（特別な出費は入れない） */
export function runRate(w: World, s: St): Vec3 {
  const c = w.constants;
  return [round4(salEff(w, s)), round2(s.cl * s.fee - (s.j === "i" ? c.indOverhead : 0)), round2(s.pu * c.net - c.infra)];
}

export const round2 = (x: number) => Math.round(x * 100) / 100;
export const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** 4 月が期間（m0 より後、m0 + L まで）に入っている最初の月 */
export function aprilIn(w: World, m0: number, L: number): number | null {
  for (const a of w.constants.aprilMonths) if (a > m0 && a <= m0 + L) return a;
  return null;
}

/** その手が今の状態でできるか */
export function feasible(w: World, s: St, kind: string, m0: number, L: number): boolean {
  const roundCl = Math.round(s.cl);
  switch (kind) {
    case "keep":
      return true;
    case "sd_permpro":
      return s.pm === "?" && s.j !== "i" && s.pro === 0;
    case "sd_grow":
      return true;
    case "sd_pilot":
      return !has(s, "pilot");
    case "sd_pro":
      return s.pro === 0 && (s.pm === "a" || s.pm === "s" || s.j === "i");
    case "sd_school":
      return s.pro === 1 && (s.pu >= 5 || s.j === "i") && s.seats < 120;
    case "sd_ads":
    case "sd_retain":
      return s.pro === 1;
    case "fc_scope":
      return s.j === "e" && !has(s, "scope");
    case "fc_push":
      return (s.j === "e" || s.j === "p") && aprilIn(w, m0, L) !== null;
    case "fc_switch":
    case "plan_switch":
      return s.j === "e" && !has(s, "switched");
    case "part":
      return s.j === "e";
    case "ad_portfolio":
      return (s.j === "e" || s.j === "p") && !has(s, "portfolio") && s.pm !== "n";
    case "ad_perm":
      return s.pm === "?" && s.j !== "i";
    case "ad_permside":
      return s.pm === "?" && s.j !== "i";
    case "ad_side":
      return (s.j === "e" || s.j === "p") && s.pm === "a" && roundCl < capOf(w, s);
    case "ad_more":
      return roundCl >= 1 && (s.pm === "a" || s.j === "i") && roundCl < capOf(w, s);
    case "ind_quit":
      return s.j === "e" || s.j === "p";
    case "back_emp":
    case "plan_back":
      return s.j === "i";
    case "plan_ind":
      return (s.j === "e" || s.j === "p") && (s.pm === "a" || s.pm === "?");
    case "plan_side":
      return (s.j === "e" || s.j === "p") && (s.pm === "a" || s.pm === "?") && roundCl < capOf(w, s);
    case "plan_sd":
      return s.pro === 1 || s.pm !== "n" || s.j === "i";
    case "plan_fc":
      return s.j === "e" || s.j === "p";
    case "plan_ind_grow":
      return s.j === "i";
    default:
      return false;
  }
}

/** 結果の分け方 */
export function driverOf(kind: string, s: St): Driver {
  switch (kind) {
    case "keep":
      return s.j === "i" ? { t: "num", metric: "cl" } : s.pro ? { t: "num", metric: "pu" } : { t: "num", metric: "mau" };
    case "sd_permpro":
    case "ad_perm":
      return { t: "cat", metric: "perm" };
    case "sd_grow":
    case "sd_ads":
    case "sd_retain":
      return s.pro ? { t: "num", metric: "pu" } : { t: "num", metric: "mau" };
    case "sd_pro":
      return { t: "num", metric: "pu" };
    case "plan_sd":
      return s.pm === "?" && s.pro === 0 && s.j !== "i" ? { t: "cat", metric: "perm" } : { t: "num", metric: "pu" };
    case "sd_pilot":
      return { t: "cat", metric: "flag", flag: "pilot" };
    case "sd_school":
      return { t: "cat", metric: "flag", flag: "school" };
    case "ad_portfolio":
      return { t: "cat", metric: "flag", flag: "portfolio" };
    case "plan_side":
    case "plan_ind":
      return s.pm === "?" ? { t: "cat", metric: "perm" } : kind === "plan_ind" ? { t: "cat", metric: "ind" } : { t: "num", metric: "cl" };
    case "fc_scope":
      return { t: "none" };
    case "fc_push":
    case "fc_switch":
    case "plan_fc":
    case "plan_switch":
      return { t: "sal" };
    case "part":
    case "back_emp":
    case "plan_back":
      return { t: "cat", metric: "job" };
    case "ad_permside":
      return { t: "cat", metric: "permside" };
    default:
      return { t: "num", metric: "cl" };
  }
}

interface Branch {
  p: number;
  tag: string;
  /** 期間の何か月目（1 始まり）の初めに起きること */
  at: Array<[number, (x: St) => void]>;
  /** 期間の何か月目の終わりに起きること（その月の稼ぎの後） */
  end: Array<[number, (x: St) => void]>;
  /** 伸び（月）・幅 */
  g: number;
  gsd: number;
  /** 有料になる割合（Pro を出す月から幅を持たせるか） */
  conv: number;
  convVar: boolean;
  spend: number;
  /** 顧客の来る窓: [始め, 終わり]（期間の月）、月あたりの数、月額。lam は窓の始まりの状態で決めてよい */
  windows: Array<{ from: number; to: number; lam: (x: St) => number; fee: (x: St) => number; onlyInd?: boolean }>;
}

function poissonCounts(mu: number, sw: Array<[number, number]>): Array<[number, number]> {
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

/** 届け出がまだなら、まず届け出て（1 か月目）、認められた場合だけその手の中身をする */
function withPerm(w: World, s: St, kind: string, m0: number, L: number): Branch[] {
  const inner = branchesOfRaw(w, s, kind, m0, L);
  const needs = s.pm === "?" && s.j !== "i" && (kind === "plan_side" || kind === "plan_ind" || (kind === "plan_sd" && s.pro === 0));
  if (!needs) return inner;
  const c = w.constants;
  const out: Branch[] = [];
  for (const pm of ["a", "s", "n"] as const) {
    const q = c.perm[pm];
    const ok = pm === "a" || (kind === "plan_sd" && pm === "s");
    const setPm: [number, (x: St) => void] = [1, (x) => void (x.pm = pm)];
    if (ok) for (const b of inner) out.push({ ...b, p: b.p * q, tag: pm, at: [setPm, ...b.at] });
    else out.push({ p: q, tag: pm, at: [setPm], end: [], g: c.g0, gsd: c.gsd, conv: c.conv, convVar: false, spend: 0, windows: [] });
  }
  return out;
}

function branchesOf(w: World, s: St, kind: string, m0: number, L: number): Branch[] {
  return withPerm(w, s, kind, m0, L);
}

function branchesOfRaw(w: World, s: St, kind: string, m0: number, L: number): Branch[] {
  const c = w.constants;
  const k = w.kinds[kind]!;
  const p = k.p;
  const base = (): Branch => ({ p: 1, tag: "", at: [], end: [], g: c.g0, gsd: c.gsd, conv: c.conv, convVar: false, spend: 0, windows: [] });
  const sideLam = (x: St, lamEmp: number, lamPart: number, mult = 1) => (x.j === "p" ? lamPart : lamEmp) * (has(x, "portfolio") ? mult : 1);
  const permBranches = (b: () => Branch, then?: (x: St) => void, atMonth = 1): Branch[] =>
    (["a", "s", "n"] as const).map((pm) => {
      const br = b();
      br.p = c.perm[pm];
      br.tag = pm;
      br.at.push([
        Math.min(atMonth, L),
        (x) => {
          x.pm = pm;
          if (pm !== "n") then?.(x);
        },
      ]);
      return br;
    });
  const one = (f: (b: Branch) => void = () => undefined): Branch[] => {
    const b = base();
    f(b);
    return [b];
  };
  const bern = (q: number, tagYes: string, tagNo: string, yes: (b: Branch) => void, no: (b: Branch) => void = () => undefined): Branch[] => {
    const by = base();
    by.p = q;
    by.tag = tagYes;
    yes(by);
    const bn = base();
    bn.p = 1 - q;
    bn.tag = tagNo;
    no(bn);
    return [by, bn].filter((b) => b.p > 1e-9);
  };
  switch (kind) {
    case "keep":
      return one((b) => {
        if (s.j === "i") b.windows.push({ from: 1, to: L, lam: () => p.indLambda!, fee: () => c.indFee });
      });
    case "sd_permpro":
      return permBranches(
        () => {
          const b = base();
          b.g = c.g0 + p.gBump!;
          return b;
        },
        undefined,
        1,
      ).map((b) => {
        if (b.tag !== "n") {
          b.at.push([Math.min(2, L), (x) => void (x.pro = 1)]);
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
      return bern(
        p.p!,
        "yes",
        "no",
        (b) => b.at.push([L, (x) => (addFlag(x, "pilot"), (x.mau += p.mau!))]),
        () => undefined,
      );
    case "sd_pro":
      return one((b) => {
        b.g = c.g0 + p.gBump!;
        b.convVar = true;
        b.at.push([1, (x) => void (x.pro = 1)]);
      });
    case "sd_school": {
      const q = Math.min(0.6, Math.min(p.max!, (p.perQuarter! * L) / 3) * (has(s, "pilot") ? p.pilotMult! : 1));
      return bern(q, "yes", "no", (b) =>
        b.at.push([
          Math.max(1, Math.ceil(L / 2)),
          (x) => {
            x.seats += c.schoolSeats;
            x.pu += c.schoolSeats;
            addFlag(x, "school");
          },
        ]),
      );
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
        b.at.push([1, (x) => void (x.cv = Math.min(2.5, x.cv * p.convMult!))]);
      });
    case "fc_scope":
      return one((b) => {
        b.g = c.g0 - p.gCut!;
        b.at.push([1, (x) => addFlag(x, "scope")]);
      });
    case "fc_push": {
      const a = aprilIn(w, m0, L)!;
      const q = has(s, "scope") ? p.pScope! : p.p!;
      return bern(
        q,
        "up",
        "same",
        (b) => {
          b.g = c.g0 - p.gCut!;
          b.at.push([a - m0, (x) => void (x.sal += p.step!)]);
        },
        (b) => void (b.g = c.g0 - p.gCut!),
      );
    }
    case "fc_switch":
    case "plan_switch": {
      const at = Math.min(p.moveAt!, L);
      const move = (mult: number) => (x: St) => {
        x.sal = x.sal * mult;
        if (x.pm !== "a" || x.cl < 0.5) x.pm = "?";
        dropFlag(x, "scope");
        addFlag(x, "switched");
      };
      const hi = base();
      hi.p = p.pHigh!;
      hi.tag = "high";
      hi.at.push([at, move(p.high!)]);
      const mid = base();
      mid.p = p.pMid!;
      mid.tag = "mid";
      mid.at.push([at, move(p.mid!)]);
      const no = base();
      no.p = 1 - p.pHigh! - p.pMid!;
      no.tag = "none";
      return [hi, mid, no];
    }
    case "part":
      return bern(p.p!, "p", "e", (b) => b.at.push([Math.min(p.at!, L), (x) => void (x.j = "p")]));
    case "ad_portfolio":
      return bern(
        p.p!,
        "yes",
        "no",
        (b) => {
          b.g = c.g0 - p.gCut!;
          b.at.push([L, (x) => addFlag(x, "portfolio")]);
        },
        (b) => void (b.g = c.g0 - p.gCut!),
      );
    case "ad_perm":
      return permBranches(base);
    case "ad_permside": {
      const first = has(s, "portfolio") ? p.firstPortfolio! : p.first!;
      const out: Branch[] = [];
      for (const br of permBranches(base)) {
        if (br.tag !== "a") {
          out.push(br);
          continue;
        }
        const found = base();
        found.p = br.p * first;
        found.tag = "a1";
        found.at = [...br.at, [Math.min(2, L), (x) => addClient(x, c.sideFee)]];
        found.end = [...br.end];
        const not = base();
        not.p = br.p * (1 - first);
        not.tag = "a0";
        not.at = [...br.at];
        not.end = [...br.end];
        out.push(found, not);
      }
      return out;
    }
    case "ad_side": {
      const q = has(s, "portfolio") ? p.pPortfolio! : p.p!;
      return bern(q, "yes", "no", (b) => b.at.push([Math.min(2, L), (x) => addClient(x, c.sideFee)]));
    }
    case "ad_more":
      return one((b) =>
        b.windows.push({ from: 1, to: L, lam: (x) => (x.j === "i" ? p.lamInd! : x.j === "p" ? p.lamPart! : p.lamEmp!), fee: (x) => (x.j === "i" ? c.indFee : c.sideFee) }),
      );
    case "ind_quit":
      return one((b) => {
        const at = Math.min(p.at!, L);
        b.at.push([
          at,
          (x) => {
            x.j = "i";
            x.fee = x.cl > 0 ? Math.max(x.fee, c.indFee) : x.fee;
          },
        ]);
        b.windows.push({ from: at, to: L, lam: () => p.lam!, fee: () => c.indFee });
      });
    case "back_emp":
    case "plan_back":
      return bern(
        p.p!,
        "e",
        "i",
        (b) =>
          b.at.push([
            Math.min(p.at!, L),
            (x) => {
              x.j = "e";
              x.sal = p.sal!;
              x.cl = 0;
              x.fee = 0;
              x.pm = "?";
              dropFlag(x, "switched");
            },
          ]),
        (b) => b.windows.push({ from: 1, to: L, lam: () => w.kinds.keep!.p.indLambda!, fee: () => c.indFee }),
      );
    case "plan_ind": {
      const half = Math.min(12, L);
      return one((b) => {
        b.windows.push({ from: 1, to: half, lam: (x) => sideLam(x, p.lamSide!, p.lamPart!, p.portfolioMult!), fee: () => c.sideFee });
        b.end.push([
          half,
          (x) => {
            if (Math.round(x.cl) >= p.threshold!) {
              x.j = "i";
              x.fee = Math.max(x.fee, c.indFee);
            }
          },
        ]);
        b.windows.push({ from: half + 1, to: L, lam: (x) => (x.j === "i" ? p.lamInd! : p.lamStay!), fee: (x) => (x.j === "i" ? c.indFee : c.sideFee) });
      });
    }
    case "plan_side":
      return one((b) => b.windows.push({ from: 1, to: L, lam: (x) => sideLam(x, p.lamSide!, p.lamPart!, p.portfolioMult!), fee: () => c.sideFee }));
    case "plan_sd": {
      const q = Math.min(0.6, p.pSchool! * (has(s, "pilot") ? p.pilotMult! : 1));
      const aprils = w.constants.aprilMonths.filter((a) => a > m0 && a <= m0 + L);
      // 4 月ごとの提案: 0・1・2 校
      const out: Branch[] = [];
      const n = aprils.length;
      for (let kk = 0; kk <= n; kk++) {
        const comb = binom(n, kk) * q ** kk * (1 - q) ** (n - kk);
        if (comb < 1e-9) continue;
        const b = base();
        b.p = comb;
        b.tag = `s${kk}`;
        b.g = p.g!;
        b.gsd = p.gsd!;
        if (s.pro === 0) {
          b.at.push([1, (x) => void (x.pro = 1)]);
          b.convVar = true;
        }
        // 決まる校の数は前から順に（期待値のずれは小さい）
        aprils.slice(0, kk).forEach((a) =>
          b.at.push([
            a - m0,
            (x) => {
              x.seats += c.schoolSeats;
              x.pu += c.schoolSeats;
              addFlag(x, "school");
            },
          ]),
        );
        out.push(b);
      }
      return out;
    }
    case "plan_fc": {
      const q = has(s, "scope") ? p.pScope! : p.p!;
      const aprils = w.constants.aprilMonths.filter((a) => a > m0 && a <= m0 + L);
      const n = aprils.length;
      const out: Branch[] = [];
      for (let kk = 0; kk <= n; kk++) {
        const comb = binom(n, kk) * q ** kk * (1 - q) ** (n - kk);
        if (comb < 1e-9) continue;
        const b = base();
        b.p = comb;
        b.tag = `u${kk}`;
        aprils.slice(0, kk).forEach((a) => b.at.push([a - m0, (x) => void (x.sal += p.step!)]));
        out.push(b);
      }
      return out;
    }
    case "plan_ind_grow":
      return one((b) => b.windows.push({ from: 1, to: L, lam: () => p.lam!, fee: () => p.fee! }));
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

function addClient(x: St, fee: number): void {
  x.fee = (x.fee * x.cl + fee) / (x.cl + 1);
  x.cl += 1;
}

/**
 * (状態, 手) を m0 か月目から L か月たどる。出来事 × 伸びの幅 × 有料になる割合の幅 × 顧客の来る数を全部数え上げる
 */
export function simulate(w: World, s0: St, kind: string, m0: number, L: number): Sample[] {
  const c = w.constants;
  const out: Sample[] = [];
  // 続けている SpellDash の作業: 認められていて Pro がまだなら、期間の 2 か月目に出す（Pro を出す手は自分で出す）
  const autoPro = s0.pro === 0 && (s0.pm === "a" || s0.pm === "s" || s0.j === "i") && kind !== "sd_permpro" && kind !== "sd_pro" && kind !== "plan_sd";
  for (const br0 of branchesOf(w, s0, kind, m0, L)) {
    let br = autoPro ? { ...br0, convVar: true, at: [...br0.at, [Math.min(2, L), (x: St) => void (x.pro = 1)] as [number, (x: St) => void]] } : br0;
    // 独立していれば、ほかの手を選んでいてもふだんの営業は続ける（顧客を増やす手は自分の来る割合を使う）
    if (s0.j === "i" && !br.windows.length) br = { ...br, windows: [{ from: 1, to: L, lam: (x: St) => (x.j === "i" ? w.kinds.keep!.p.indLambda! : 0), fee: () => c.indFee, onlyInd: true }] };
    for (const [zg, pg] of w.swanson) {
      const convs: Array<[number, number]> = br.convVar ? w.swanson.map(([z, q]) => [br.conv * Math.exp(c.convSd * z), q]) : [[br.conv, 1]];
      for (const [conv, pc] of convs) {
        // 顧客の窓ごとに来る数を数え上げる（2 つ目の窓の来る割合は、その窓の始まりの状態で決まる）
        const runFrom = (x0: St, month0: number, wi: number, counts: number[], weight: number, r0: Vec3) => {
          const win = br.windows[wi];
          if (!win) {
            finish(x0, month0, counts, weight, r0);
            return;
          }
          // 窓の始まりまで進めてから来る割合を決める
          const pre = clone(x0);
          const rPre: Vec3 = [...r0];
          step(pre, month0, win.from - 1, counts, rPre);
          const lam = win.lam(pre);
          const len = win.to - win.from + 1;
          for (const [k, q] of poissonCounts(lam * len, w.swanson)) {
            const x = clone(pre);
            const r: Vec3 = [...rPre];
            const cs = [...counts, k];
            step(x, win.from - 1, win.to, cs, r, { k, from: win.from, to: win.to, fee: win.fee(pre), onlyInd: !!win.onlyInd });
            runFrom(x, win.to, wi + 1, cs, weight * q, r);
          }
        };
        const finish = (x0: St, month0: number, counts: number[], weight: number, r0: Vec3) => {
          const x = clone(x0);
          const r: Vec3 = [...r0];
          step(x, month0, L, counts, r);
          out.push({ w: br.p * pg * pc * weight, x: tidy(x), r: [round4(r[0]), round2(r[1]), round2(r[2])], tag: br.tag });
        };
        /** 期間の月 a+1 .. b をたどる */
        const step = (x: St, a: number, b: number, _counts: number[], r: Vec3, arr?: { k: number; from: number; to: number; fee: number; onlyInd: boolean }) => {
          for (let i = a + 1; i <= b; i++) {
            const month = m0 + i;
            for (const [at, fn] of br.at) if (at === i) fn(x);
            if (c.aprilMonths.includes(month) && (x.j === "e" || x.j === "p")) x.sal *= 1 + c.aprilRaise;
            const g = br.g + zg * br.gsd + (x.j === "p" ? c.partGrowth : 0);
            x.mau = Math.max(c.minMau, x.mau * (1 + g));
            if (x.pro) {
              const free = Math.max(0, x.pu - x.seats);
              const target = conv * x.cv * x.mau;
              x.pu = x.seats + Math.max(0, free + c.convPull * (target - free));
            }
            // 顧客: 離れる → 来る（窓の中で均等に）→ 抱えられる数まで
            if (x.cl > 0) x.cl = x.cl * (1 - c.churn);
            if (arr && (!arr.onlyInd || x.j === "i")) {
              const len = arr.to - arr.from + 1;
              const idx = i - arr.from;
              const came = Math.floor((arr.k * (idx + 1)) / len + 1e-9) - Math.floor((arr.k * idx) / len + 1e-9);
              for (let n = 0; n < came; n++) if (x.cl < capOf(w, x) - 0.5) addClient(x, arr.fee);
            }
            if (x.cl < 0.05) x.cl = 0;
            r[0] += salEff(w, x);
            r[1] += x.cl * x.fee - (x.j === "i" ? c.indOverhead : 0);
            r[2] += x.pu * c.net - c.infra - br.spend;
            for (const [at, fn] of br.end) if (at === i) fn(x);
          }
        };
        runFrom(clone(s0), 0, 0, [], 1, [0, 0, 0]);
      }
    }
  }
  return out;
}

function tidy(x: St): St {
  return { ...x, mau: round2(x.mau), pu: round2(x.pu), seats: x.seats, cl: round4(x.cl), fee: round2(x.fee), sal: round4(x.sal), cv: round4(x.cv), fl: [...x.fl].sort() };
}
