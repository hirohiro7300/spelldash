// 「資産 10 億円」を地図の最後のゴールにする計算（設計: 作業メモ goal/design.md §1）。画面・地図の計算（deepmap）には頼らない。
//
// 地図が数えるのは 3 年分（36 か月目まで）の額面の稼ぎだけ。その先は「3 年後の月の稼ぎがそのまま続く（事業の稼ぎだけは
// 決めた伸びで伸びる）」と置いた目安で、ここの数はどれもその前提から出す。給与は 36 か月目の後は据え置き（設定にしない）。
//
// 資産は、行き先の 3 つの数（T3 = 3 年の稼ぎの合計・Rsal = 3 年後の月の給与・Rbiz = 3 年後の月の事業の稼ぎ）の 1 次式:
//   A(Y) = α[Y] + β[Y]·T3 + γs[Y]·Rsal + γb[Y]·Rbiz
//   α = 今の資産·q^M、β = s·q^(M−18)（3 年の間の積立は真ん中の月にまとめて入れる）、
//   γs = s·Gs(K)（Gs(k+1) = Gs(k)·q + 1）、γb = s·Gb(K)（Gb(k+1) = Gb(k)·q + h^k）
//   q = (1 + 利回り)^(1/12)、h = (1 + 事業の伸び)^(1/12)、s = 積立の割合、M = 0 か月目から Y 年の同じ月までの月数、K = M − 36
// 年ごとの係数を 1 度だけ作り（tablesFor）、行き先ごとの数は O(1)〜O(log) で出す（goalLeaf）。
//
// 事業の稼ぎ（地図の 3 つの稼ぎの 2 つ目と 3 つ目）の中身（src/demo/impact.ts・scripts/impact/q/sim.ts で確かめた）:
//   広告運用・独立: 顧客からの売上（独立した後は独立の経費を引いた額）
//   SpellDash    : 有料会員と学校の席の入金から、手数料とサーバー代（と広告費）を引いた額。売上そのものではない
// 給与は額面。どれも税の前（GOAL_BASIS_NOTE）。

/** 設定の鍵（画面の並び順） */
export type GoalKey = "target" | "assets" | "save" | "ret" | "bizGrow" | "by";
export const GOAL_KEYS: readonly GoalKey[] = ["target", "assets", "save", "ret", "bizGrow", "by"];

/**
 * ゴールの設定（万円・%）。by は期限の年（null は「0 か月目の年 + 30」。地図の年月で決まるので、入れたときだけ持つ）
 */
export interface GoalConfig {
  /** 目標の資産（万円） */
  target: number;
  /** 今の資産（預金・投資の合計。万円） */
  assets: number;
  /** 額面の稼ぎのうち積み立てに回す割合（%） */
  save: number;
  /** 運用の利回り（%/年） */
  ret: number;
  /** 3 年後からの事業の稼ぎの伸び（%/年） */
  bizGrow: number;
  /** 期限の年（null は 0 か月目の年 + BY_DEFAULT_YEARS） */
  by: number | null;
}

/** 文書に残す形（root.meta.goal）。入れた物だけを持つ */
export interface GoalStored {
  v: 1;
  target?: number;
  assets?: number;
  save?: number;
  ret?: number;
  bizGrow?: number;
  by?: number;
}

/** 入れていないときの値（どれも仮。今の資産は 0: 本当の数は入れたときだけ文書に残る） */
export const DEFAULT_GOAL: Readonly<GoalConfig> = Object.freeze({ target: 100_000, assets: 0, save: 20, ret: 3, bizGrow: 0, by: null });

/** 読むときに収める範囲（by は 0 か月目の年からの年数） */
export const GOAL_RANGE: Readonly<Record<GoalKey, readonly [number, number]>> = Object.freeze({
  target: [1_000, 10_000_000],
  assets: [0, 10_000_000],
  save: [0, 100],
  ret: [0, 15],
  bizGrow: [-10, 60],
  by: [4, 80],
});

/** 期限の決まり: 0 か月目の年 + 30 */
export const BY_DEFAULT_YEARS = 30;
/** 「芽」: 3 年後に給与の外の稼ぎ（広告運用・独立・SpellDash）が月この額（万円）以上 */
export const SEED_BIZ = 10;
/** 事業を売る場合の値打ち（年の事業の稼ぎの何倍か。目安） */
export const SALE_MULT = 5;
/** 届く年を探す上限（0 か月目の年から何年先まで） */
export const REACH_CAP_Y = 80;
/** 要る事業の伸びを探す範囲（%/年）と刻み */
export const G_MIN = -10;
export const G_MAX = 60;
export const G_STEP = 0.25;
export const G_N = Math.round((G_MAX - G_MIN) / G_STEP) + 1;
/** 利回りの幅（画面に並べて出す。%/年） */
export const RET_BAND: readonly [number, number] = [1, 5];
/** ふつうの利回り（%/年。これより大きい要る利回りには「ふつうは 3〜5%」を添える） */
export const RET_TYPICAL: readonly [number, number] = [3, 5];
/** 要る利回りを探す上限（%/年） */
export const RET_SEARCH_MAX = 30;
/** 事業の稼ぎがこれ（万円/月）より小さい行き先は「給与だけの道」（伸びを置いても届かない） */
export const BIZ_MIN = 0.5;
/** 物価の目安（%/年。期限の年の目標を今のお金に直すときだけ使う） */
export const INFLATION = 2;
/** 地図が数える月数（36 か月目まで） */
export const MAP_MONTHS = 36;

/** 事業の稼ぎの中身と、税の扱い（前提の行・くわしく に出す） */
export const GOAL_BASIS_NOTE = "事業の稼ぎは、広告運用・独立の売上（独立の経費は引く）と、SpellDash の手数料とサーバー代を引いた後の稼ぎです。給与も事業も額面で、税は引いていません。";

// ---- 設定を読む

export interface GoalRead {
  cfg: GoalConfig;
  /** 入れていない（仮の値で計算する）鍵 */
  assumed: ReadonlySet<GoalKey>;
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * 入口の meta.goal を読む（知らない鍵は捨てる・数でない物は仮の値・範囲に収める）。期限の年は 0 か月目の年で決まる範囲に
 * 収めるので、ここでは 1900〜3000 の整数にするだけ（tablesFor で収める）。今の資産は目標より大きくてもよい（「もう届いています」）
 */
export function goalConfigOf(n: { meta?: Record<string, unknown> } | null | undefined): GoalRead {
  const raw = n?.meta?.goal;
  const g = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const cfg: GoalConfig = { ...DEFAULT_GOAL };
  const assumed = new Set<GoalKey>(GOAL_KEYS);
  if (!g || g.v !== 1) return { cfg, assumed };
  for (const k of GOAL_KEYS) {
    const x = num(g[k]);
    if (x === null) continue;
    if (k === "by") cfg.by = Math.round(clamp(x, 1900, 3000));
    else {
      const [lo, hi] = GOAL_RANGE[k];
      cfg[k] = clamp(x, lo, hi);
    }
    assumed.delete(k);
  }
  return { cfg, assumed };
}

/** 文書に書く形（入れた鍵だけ。範囲に収める）。values に無い鍵は仮のまま */
export function goalStored(values: Partial<Record<GoalKey, number | null | undefined>>): GoalStored {
  const out: GoalStored = { v: 1 };
  for (const k of GOAL_KEYS) {
    const x = num(values[k]);
    if (x === null) continue;
    if (k === "by") out.by = Math.round(clamp(x, 1900, 3000));
    else {
      const [lo, hi] = GOAL_RANGE[k];
      out[k] = clamp(x, lo, hi);
    }
  }
  return out;
}

// ---- 0 か月目の年月

export interface GoalAnchor {
  /** 0 か月目の年 */
  y: number;
  /** 0 か月目の月（1〜12） */
  mo: number;
  /** 地図に年月が無く、今月から数えた（「今月から数えて」と書く） */
  clock: boolean;
}

/** 地図の 0 か月目（"YYYY-MM"）。無い・読めないときは now() の月（今月から数える） */
export function goalAnchor(anchor: string | null | undefined, now: () => Date = () => new Date()): GoalAnchor {
  const m = typeof anchor === "string" ? /^(\d{4})-(\d{2})$/.exec(anchor) : null;
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return { y, mo, clock: false };
  }
  const d = now();
  return { y: d.getFullYear(), mo: d.getMonth() + 1, clock: true };
}

// ---- 年ごとの係数

/** 年ごとの係数の数（36 か月目の年 = 0 か月目の年 + 3 から、+ REACH_CAP_Y まで） */
export const GOAL_YEARS = REACH_CAP_Y - 3 + 1;

export interface GoalTables {
  /** 設定と 0 か月目で決まる鍵（同じ鍵なら同じ表） */
  readonly key: string;
  /** 期限を決めた設定 */
  readonly cfg: Readonly<GoalConfig> & { readonly by: number };
  readonly anchor: GoalAnchor;
  /** 0 か月目の年・36 か月目の年 */
  readonly y0: number;
  readonly y36: number;
  /** 期限の年と、その添え字（y36 + jBy = by）・36 か月目から期限までの月数 */
  readonly by: number;
  readonly jBy: number;
  readonly K: number;
  /** 目標（万円）・積立の割合（0〜1）・月の利回り q・月の事業の伸び h */
  readonly T: number;
  readonly s: number;
  readonly q: number;
  readonly h: number;
  /** 年ごとの係数（添え字 j: y36 + j 年の、0 か月目と同じ月） */
  readonly alpha: Float64Array;
  readonly beta: Float64Array;
  readonly gs: Float64Array;
  readonly gb: Float64Array;
  /** 期限での Gb(K)（事業の伸び g = G_MIN + k·G_STEP ごと。g について増える）。表を作るときに 1 度だけ */
  readonly grid: Float64Array;
}

/** 期限の年（入れた年を 0 か月目の年 + 4〜80 に収める。無ければ + 30） */
export function byYearOf(cfg: Readonly<GoalConfig>, y0: number): number {
  const [lo, hi] = GOAL_RANGE.by;
  return clamp(cfg.by ?? y0 + BY_DEFAULT_YEARS, y0 + lo, y0 + hi);
}

function buildTables(cfg: Readonly<GoalConfig>, anchor: GoalAnchor, key: string, grid: boolean): GoalTables {
  const y0 = anchor.y;
  const y36 = y0 + MAP_MONTHS / 12;
  const by = byYearOf(cfg, y0);
  const jBy = by - y36;
  const K = jBy * 12;
  const q = Math.pow(1 + cfg.ret / 100, 1 / 12);
  const h = Math.pow(1 + cfg.bizGrow / 100, 1 / 12);
  const s = cfg.save / 100;
  const alpha = new Float64Array(GOAL_YEARS);
  const beta = new Float64Array(GOAL_YEARS);
  const gs = new Float64Array(GOAL_YEARS);
  const gb = new Float64Array(GOAL_YEARS);
  // 36 か月目から 1 か月ずつ進める（ret = 0・bizGrow = 0・ret = bizGrow も同じ式）
  let a = cfg.assets * Math.pow(q, MAP_MONTHS);
  let b = s * Math.pow(q, MAP_MONTHS / 2);
  let Gs = 0;
  let Gb = 0;
  let hk = 1;
  for (let j = 0; j < GOAL_YEARS; j++) {
    alpha[j] = a;
    beta[j] = b;
    gs[j] = s * Gs;
    gb[j] = s * Gb;
    for (let m = 0; m < 12; m++) {
      a *= q;
      b *= q;
      Gs = Gs * q + 1;
      Gb = Gb * q + hk;
      hk *= h;
    }
  }
  const out: GoalTables = { key, cfg: { ...cfg, by }, anchor, y0, y36, by, jBy, K, T: cfg.target, s, q, h, alpha, beta, gs, gb, grid: new Float64Array(grid ? G_N : 0) };
  if (grid) fillGrid(out.grid, q, K);
  return out;
}

/** 期限での Gb(K) を、事業の伸びの刻みごとに */
function fillGrid(out: Float64Array, q: number, K: number): void {
  for (let k = 0; k < out.length; k++) {
    const h = Math.pow(1 + (G_MIN + k * G_STEP) / 100, 1 / 12);
    let G = 0;
    let hk = 1;
    for (let t = 0; t < K; t++) {
      G = G * q + hk;
      hk *= h;
    }
    out[k] = G;
  }
}

/** 設定の鍵（数を収めた後の設定と 0 か月目） */
export function goalKey(cfg: Readonly<GoalConfig>, anchor: GoalAnchor): string {
  return JSON.stringify([cfg.target, cfg.assets, cfg.save, cfg.ret, cfg.bizGrow, byYearOf(cfg, anchor.y), anchor.y, anchor.mo]);
}

const LRU = 4;
const cache = new Map<string, GoalTables>();
const bandCache = new WeakMap<GoalTables, readonly [GoalTables, GoalTables]>();

/** 年ごとの係数（直近の 4 つの設定を覚える） */
export function tablesFor(cfg: Readonly<GoalConfig>, anchor: GoalAnchor): GoalTables {
  const key = goalKey(cfg, anchor);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const t = buildTables(cfg, anchor, key, true);
  cache.set(key, t);
  while (cache.size > LRU) cache.delete(cache.keys().next().value!);
  return t;
}

/** 利回りの幅（RET_BAND の 2 つ）の表。ほかの設定は同じ（伸びの表は作らない） */
export function bandTables(t: GoalTables): readonly [GoalTables, GoalTables] {
  let b = bandCache.get(t);
  if (!b) {
    const mk = (ret: number): GoalTables => buildTables({ ...t.cfg, ret }, t.anchor, `${t.key}|ret${ret}`, false);
    b = [mk(RET_BAND[0]), mk(RET_BAND[1])];
    bandCache.set(t, b);
  }
  return b;
}

/** Y 年（y36 + j）の資産 */
export function assetsAt(t: GoalTables, j: number, T3: number, Rsal: number, Rbiz: number): number {
  return t.alpha[j]! + t.beta[j]! * T3 + t.gs[j]! * Rsal + t.gb[j]! * Rbiz;
}

/** 期限の年の資産 */
export function assetsAtBy(t: GoalTables, T3: number, Rsal: number, Rbiz: number): number {
  return assetsAt(t, t.jBy, T3, Rsal, Rbiz);
}

/** 届く年（REACH_CAP_Y 年先までに届かなければ null）。どの数も 0 以上なら年について増えるので 2 分探索、そうでなければ前から */
export function reachYearOf(t: GoalTables, T3: number, Rsal: number, Rbiz: number): number | null {
  const T = t.T;
  const last = GOAL_YEARS - 1;
  if (T3 >= 0 && Rsal >= 0 && Rbiz >= 0) {
    if (assetsAt(t, last, T3, Rsal, Rbiz) < T) return null;
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (assetsAt(t, mid, T3, Rsal, Rbiz) >= T) hi = mid;
      else lo = mid + 1;
    }
    return t.y36 + lo;
  }
  for (let j = 0; j <= last; j++) if (assetsAt(t, j, T3, Rsal, Rbiz) >= T) return t.y36 + j;
  return null;
}

/** 36 か月目の資産（3 年の積立を真ん中の月にまとめて入れた目安） */
export function assetsAt36(t: GoalTables, T3: number): number {
  return t.alpha[0]! + t.beta[0]! * T3;
}

/**
 * 期限に届くのに、36 か月目から毎月いくら積み立てればよいか（万円/月。同じ額を続ける）。0 以下なら積立なしでも届く
 */
export function savingNeeded(t: GoalTables, T3: number): number {
  const K = t.K;
  const A36 = assetsAt36(t, T3);
  if (t.q === 1) return (t.T - A36) / K;
  const qK = Math.pow(t.q, K);
  return ((t.T - A36 * qK) * (t.q - 1)) / (qK - 1);
}

/** 今日から years 年、毎月同じ額を積み立てて target に届くのに要る額（万円/月。利回り ret %/年。くわしく の比べる数） */
export function monthlyFromToday(target: number, years: number, ret: number): number {
  const n = Math.round(years * 12);
  const q = Math.pow(1 + ret / 100, 1 / 12);
  if (q === 1) return target / n;
  return (target * (q - 1)) / (Math.pow(q, n) - 1);
}

/**
 * 期限に届くのに要る事業の伸び（%/年。給与は据え置き）。刻みの間は直線で埋める。
 * 事業の稼ぎが BIZ_MIN より小さい・積み立てない・G_MAX でも足りなければ Infinity。G_MIN でも届くなら G_MIN
 */
export function growthNeeded(t: GoalTables, T3: number, Rsal: number, Rbiz: number): number {
  if (!(Rbiz >= BIZ_MIN) || !(t.s > 0) || t.grid.length === 0) return Infinity;
  const j = t.jBy;
  const need = t.T - t.alpha[j]! - t.beta[j]! * T3 - t.gs[j]! * Rsal;
  const x = need / (t.s * Rbiz);
  const g = t.grid;
  if (x <= g[0]!) return G_MIN;
  if (x > g[G_N - 1]!) return Infinity;
  let lo = 0;
  let hi = G_N - 1;
  // g[lo] < x <= g[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (g[mid]! >= x) hi = mid;
    else lo = mid;
  }
  const f = (x - g[lo]!) / (g[hi]! - g[lo]!);
  return G_MIN + (lo + f) * G_STEP;
}

/** 行き先の 3 つの数（3 年の合計・3 年後の月の給与・3 年後の月の事業の稼ぎ。split が false なら Rsal に月の稼ぎ全部） */
export interface GoalInput {
  T3: number;
  Rsal: number;
  Rbiz: number;
  /** 給与と事業に分けられた（false: 内訳が無く、芽・事業の伸びは出さない） */
  split: boolean;
}

export interface GoalLeaf {
  /** 期限の年の資産（万円・目安） */
  atBy: number;
  /** ゴールの何割か（0〜1） */
  frac: number;
  /** 期限までに届く */
  reached: boolean;
  /** 届く年（REACH_CAP_Y 年先までに届かなければ null） */
  reachYear: number | null;
  /** REACH_CAP_Y 年先の資産（届かないときに「80 年後で約 3.1 億円」） */
  atCap: number;
  /** 36 か月目から要る毎月の積立（万円/月。0 以下なら積立なしでも届く） */
  cReq: number;
  /** 要る積立が 3 年後の月の稼ぎの何倍か */
  ratioEarn: number;
  /** 要る積立が今の前提の積立（s × 3 年後の月の稼ぎ）の何倍か */
  ratioSave: number;
  /** 要る事業の伸び（%/年。給与だけの道・届かない・内訳が無いときは Infinity・NaN） */
  gReq: number;
  /** 給与だけの道（事業の稼ぎが BIZ_MIN より小さい） */
  salaryOnly: boolean;
  /** 芽（3 年後の事業の稼ぎが SEED_BIZ 以上） */
  seed: boolean;
}

/** 行き先 1 つの数（O(log)） */
export function goalLeaf(t: GoalTables, x: GoalInput): GoalLeaf {
  const { T3, Rsal, Rbiz, split } = x;
  const atBy = assetsAtBy(t, T3, Rsal, Rbiz);
  const reachYear = reachYearOf(t, T3, Rsal, Rbiz);
  const cReq = savingNeeded(t, T3);
  const R = Rsal + Rbiz;
  const salaryOnly = split && !(Rbiz >= BIZ_MIN);
  return {
    atBy,
    frac: t.T > 0 ? Math.max(0, Math.min(1, atBy / t.T)) : 1,
    reached: atBy >= t.T,
    reachYear,
    atCap: assetsAt(t, GOAL_YEARS - 1, T3, Rsal, Rbiz),
    cReq,
    ratioEarn: R > 0 ? cReq / R : Infinity,
    ratioSave: t.s > 0 && R > 0 ? cReq / (t.s * R) : Infinity,
    gReq: split ? growthNeeded(t, T3, Rsal, Rbiz) : NaN,
    salaryOnly,
    seed: split && Rbiz >= SEED_BIZ,
  };
}

/** 期限の年の資産の幅（利回り RET_BAND の 2 つ） */
export function goalBand(t: GoalTables, x: GoalInput): [number, number] {
  const [lo, hi] = bandTables(t);
  return [assetsAtBy(lo, x.T3, x.Rsal, x.Rbiz), assetsAtBy(hi, x.T3, x.Rsal, x.Rbiz)];
}

/** 期限の年の月の事業の稼ぎ（事業が毎年 g% 伸びた場合。万円/月） */
export function deadlineBiz(t: GoalTables, Rbiz: number, g: number): number {
  return Rbiz * Math.pow(1 + g / 100, t.K / 12);
}

/** 期限の年の資産（利回りだけを ret %/年に替えた場合。O(K)） */
export function assetsAtRet(t: GoalTables, x: GoalInput, ret: number): number {
  const q = Math.pow(1 + ret / 100, 1 / 12);
  const s = t.s;
  let A = t.cfg.assets * Math.pow(q, MAP_MONTHS) + s * x.T3 * Math.pow(q, MAP_MONTHS / 2);
  let hk = 1;
  for (let k = 0; k < t.K; k++) {
    A = A * q + s * (x.Rsal + x.Rbiz * hk);
    hk *= t.h;
  }
  return A;
}

/** 届くための手立て（どれか 1 つ。ほかの前提はそのまま・目安） */
export interface GoalLevers {
  /** 36 か月目から毎月の積立（万円/月） */
  save: number;
  /** 3 年後の稼ぎの何倍か・今の前提の積立の何倍か */
  ratioEarn: number;
  ratioSave: number;
  /** 事業の伸び（%/年。Infinity: 給与だけの道・G_MAX でも足りない。NaN: 内訳が無い） */
  grow: number;
  /** その伸びのときの期限の年の月の事業の稼ぎ（万円/月。伸びが出ないときは NaN） */
  growBiz: number;
  /** 給与だけの道（事業の伸びでは届かない） */
  salaryOnly: boolean;
  /** 利回り（%/年。RET_SEARCH_MAX でも足りなければ null） */
  ret: number | null;
  /** 期限に届くのに今すぐ要る資産（万円。今の資産より小さければ届いている） */
  lump: number;
  /** 事業を売る場合に要る月の事業の稼ぎ（値打ちを年の稼ぎの SALE_MULT 倍として。万円/月） */
  sale: number;
}

/** 届くための手立て（見せる行き先 1 つだけ。利回りは 2 分探索で O(K · 50)） */
export function goalLevers(t: GoalTables, x: GoalInput, leaf: GoalLeaf = goalLeaf(t, x)): GoalLevers {
  const short = Math.max(0, t.T - leaf.atBy);
  let ret: number | null = null;
  if (leaf.atBy >= t.T) ret = t.cfg.ret;
  else if (assetsAtRet(t, x, RET_SEARCH_MAX) >= t.T) {
    let lo = t.cfg.ret;
    let hi = RET_SEARCH_MAX;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      if (assetsAtRet(t, x, mid) >= t.T) hi = mid;
      else lo = mid;
    }
    ret = hi;
  }
  const M = (t.by - t.y0) * 12;
  const noAssets = leaf.atBy - t.alpha[t.jBy]!;
  const lump = Math.max(0, (t.T - noAssets) / Math.pow(t.q, M));
  const grow = leaf.gReq;
  return {
    save: leaf.cReq,
    ratioEarn: leaf.ratioEarn,
    ratioSave: leaf.ratioSave,
    grow,
    growBiz: Number.isFinite(grow) ? deadlineBiz(t, x.Rbiz, grow) : NaN,
    salaryOnly: leaf.salaryOnly,
    ret,
    lump,
    sale: short / (12 * SALE_MULT),
  };
}

/** 期限の年の目標を、物価が年 INFLATION % 上がるとして今のお金に直した額（万円） */
export function targetToday(t: GoalTables): number {
  return t.T / Math.pow(1 + INFLATION / 100, t.by - t.y0);
}

// ---- 数の書き方（日本語と数の間は 1 文字空ける: 地図のほかの文と同じ）

/** 3 桁ごとに区切る（地域の設定によらない） */
function commas(x: number): string {
  const r = Math.round(x);
  const s = Math.abs(r)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return r < 0 ? `−${s}` : s;
}

/** 小数を最大 d 桁（後ろの 0 は落とす） */
function dec(x: number, d: number): string {
  const p = Math.pow(10, d);
  const v = Math.round(x * p) / p;
  return v === 0 ? "0" : `${v}`;
}

/**
 * 資産の額（万円）: 1 億以上は「10 億円」「3.1 億円」「0.45 億円」、1 億より下は「3,000 万円」。
 * oku（目標が 1 億以上の画面）なら、100 万円以上は 1 億より下でも億で書く（「0.45 億円」。ゴールと同じ単位で比べる）
 */
export function formatOku(man: number, oku = false): string {
  const v = Math.max(0, man);
  if (v >= 10_000 || (oku && v >= 100)) {
    const x = v / 10_000;
    const s = x >= 100 ? commas(x) : x >= 10 ? dec(x, 1) : x >= 1 ? dec(x, 1) : dec(x, 2);
    return `${s} 億円`;
  }
  return `${commas(v)} 万円`;
}

/** 月の額（万円/月）: 100 より下は小数 1 桁まで（「10.5 万円」）、それより上は整数（「1,590 万円」） */
export function formatManMonthly(x: number): string {
  return Math.abs(x) >= 100 ? `${commas(x)} 万円` : `${dec(x, 1).replace("-", "−")} 万円`;
}

/** 伸び（%/年）: 「+20%」「−2%」「0%」。10 より下は小数 1 桁まで */
export function formatGrowth(g: number): string {
  const s = Math.abs(g) >= 10 ? `${Math.round(Math.abs(g))}` : dec(Math.abs(g), 1);
  if (s === "0") return "0%";
  return `${g < 0 ? "−" : "+"}${s}%`;
}

/** 倍率: 10 より下は小数 1 桁（「5.0 倍」）、それより上は整数（「25 倍」） */
export function formatTimes(x: number): string {
  return `${x >= 10 ? commas(x) : (Math.round(x * 10) / 10).toFixed(1)} 倍`;
}

/** 割合（0〜1）: 「5%」。1% より下は「1% 未満」（0 は出さない画面で使う） */
export function formatGoalShare(p: number): string {
  const v = Math.round(p * 100);
  return v === 0 && p > 0 ? "1% 未満" : `${v}%`;
}

/** 「資産 10 億円」 */
export function goalName(t: GoalTables): string {
  return `資産 ${formatOku(t.T)}`;
}

/** 0 か月目からの月数の年月（「2029 年 11 月」） */
export function goalYm(a: GoalAnchor, m: number): string {
  const k = a.y * 12 + (a.mo - 1) + m;
  return `${Math.floor(k / 12)} 年 ${(k % 12) + 1} 月`;
}

/** 地図が数える範囲と、その先の前提（いつも出す 1 文） */
export function goalFrameLine(t: GoalTables): string {
  const end = goalYm(t.anchor, MAP_MONTHS);
  const g = t.cfg.bizGrow;
  const rest = g === 0 ? "3 年後の月の稼ぎがそのまま続く" : `3 年後の月の稼ぎが続き、事業の稼ぎだけ毎年 ${formatGrowth(g)} 変わる`;
  const from = t.anchor.clock ? " 今月から数えて " : " ";
  return `地図が数えるのは${from}${end}までの額面の稼ぎです。その先は「${rest}」と置いた目安で、運・景気・税は入っていません。`;
}

/** 前提の行（入れていない物に（仮））。band は利回り RET_BAND の 2 つの期限の資産 */
export function goalPremiseLine(t: GoalTables, assumed: ReadonlySet<GoalKey>, band: readonly [number, number] | null): string {
  const c = t.cfg;
  const tmp = (k: GoalKey): string => (assumed.has(k) ? "（仮）" : "");
  const oku = t.T >= 10_000;
  const retNote = band ? `（${assumed.has("ret") ? "仮、" : ""}${RET_BAND[0]}〜${RET_BAND[1]}% なら ${formatOku(band[0], oku).replace(/ (億|万)円$/, "")}〜${formatOku(band[1], oku)}）` : tmp("ret");
  const parts = [
    `今の資産 ${formatOku(c.assets, false)}${tmp("assets")}`,
    `額面の ${dec(c.save, 1)}% を積立${tmp("save")}`,
    `利回りは年 ${dec(c.ret, 2)}%${retNote}`,
    `事業の伸びは年 ${formatGrowth(c.bizGrow)}${tmp("bizGrow")}`,
    `期限は ${t.by} 年${tmp("by")}`,
    "税は引いていません",
    `物価が年 ${INFLATION}% 上がると、${t.by} 年の ${formatOku(t.T)}は今の約 ${formatOku(targetToday(t))}`,
  ];
  return `前提: ${parts.join("・")}`;
}

/** 「芽」の注（見取り図の 10 の手の下） */
export function goalSeedNote(t: GoalTables): string {
  return `芽: 3 年後に、給与の外の稼ぎ（広告運用・独立・SpellDash）が月 ${SEED_BIZ} 万円以上ある見込み。${formatOku(t.T)}まで伸びうるのは、ほぼこの道です（目安）。`;
}

/** 届くための手立ての行（どれか 1 つ。ほかの前提はそのまま・目安）。出せない手立ては行を出さない */
export function goalLeverLines(t: GoalTables, lev: GoalLevers): string[] {
  const out: string[] = [];
  if (lev.save <= 0) out.push(`3 年後からは積み立てなくても、${t.by} 年までに届きます（利回りは年 ${dec(t.cfg.ret, 2)}% の前提）`);
  else {
    const now = Number.isFinite(lev.ratioSave) && lev.ratioSave > 0 ? lev.save / lev.ratioSave : NaN;
    const cmp = Number.isFinite(now) ? `（今の前提の積立 月 ${formatManMonthly(now)}の ${formatTimes(lev.ratioSave)}）` : "";
    out.push(`毎月 ${formatManMonthly(lev.save)}を 3 年後から積み立てる${cmp}`);
  }
  if (Number.isFinite(lev.grow)) out.push(`事業の稼ぎが毎年 ${formatGrowth(lev.grow)} 伸び続ける（その場合 ${t.by} 年の事業の稼ぎは月 ${formatManMonthly(lev.growBiz)}）`);
  else if (lev.salaryOnly) out.push("給与だけの道なので、事業の伸びでは届きません（給与は 3 年後のまま据え置きで計算）");
  else if (lev.grow === Infinity) out.push(`事業の稼ぎが年 ${G_MAX}% 伸び続けても足りません`);
  if (lev.ret !== null) out.push(`利回りが年 ${dec(lev.ret, 1)}%${lev.ret > RET_TYPICAL[1] ? `（ふつうは ${RET_TYPICAL[0]}〜${RET_TYPICAL[1]}%）` : ""}`);
  if (lev.lump > t.cfg.assets) out.push(`今すぐ ${formatOku(lev.lump)}の資産がある`);
  if (lev.sale > 0) out.push(`事業を売る: 値打ちを年の稼ぎの ${SALE_MULT} 倍（目安）とすると、事業の稼ぎ 月 ${formatManMonthly(lev.sale)}`);
  return out;
}

/**
 * 行き先の 1 文（道の終わり・行き先のカードの くわしく）。地図の 3 年後の月の稼ぎから、期限の年の資産と届くための手立てを言う
 */
export function goalLeafLine(t: GoalTables, x: GoalInput, leaf: GoalLeaf, band: readonly [number, number] | null): string {
  const oku = t.T >= 10_000;
  const R = x.Rsal + x.Rbiz;
  const parts = x.split ? `（給与 ${dec(x.Rsal, 1)}・事業 ${dec(x.Rbiz, 1)}）` : "";
  const bandTxt = band ? `。利回り ${RET_BAND[0]}〜${RET_BAND[1]}% なら ${formatOku(band[0], oku).replace(/ (億|万)円$/, "")}〜${formatOku(band[1], oku)}` : "";
  const head = `この行き先の 3 年後の月の稼ぎ ${formatManMonthly(R)}${parts}がそのまま続くと、${t.by} 年の資産は約 ${formatOku(leaf.atBy, oku)}（ゴールの ${formatGoalShare(leaf.frac)}・目安${bandTxt}）。`;
  let tail = "";
  if (leaf.reached) tail = leaf.reachYear !== null ? `${leaf.reachYear} 年に届く目安です。` : "";
  else if (leaf.salaryOnly) tail = `給与だけの道なので、事業の伸びをいくら置いても届きません。届くには毎月 ${formatManMonthly(leaf.cReq)}の積立（稼ぎの ${formatTimes(leaf.ratioEarn)}）が要ります。`;
  else if (leaf.cReq > 0) {
    const save = `3 年後から毎月 ${formatManMonthly(leaf.cReq)}の積立（稼ぎの ${formatTimes(leaf.ratioEarn)}）`;
    if (Number.isFinite(leaf.gReq)) tail = `届くには、${save}か、事業の稼ぎが毎年 ${formatGrowth(leaf.gReq)} 伸び続けること。`;
    else if (x.split) tail = `届くには、${save}が要ります。事業の伸びは年 ${G_MAX}% でも足りません。`;
    else tail = `届くには、${save}が要ります。`;
  }
  const seed = leaf.seed ? `この道は芽あり（給与の外の稼ぎ 月 ${formatManMonthly(x.Rbiz)}）。` : "";
  return head + tail + seed;
}

/** 行き先のカードの札（「10 億: 事業が年 +24%」など） */
export function goalBadge(t: GoalTables, leaf: GoalLeaf): string {
  const name = formatOku(t.T).replace(/円$/, "");
  if (leaf.reached && leaf.reachYear !== null) return `${name}: ${leaf.reachYear} 年`;
  if (leaf.salaryOnly) return `${name}: 給与だけでは届かない`;
  if (Number.isFinite(leaf.gReq)) return `${name}: 事業が年 ${formatGrowth(leaf.gReq)}`;
  return `${name}: ${formatGoalShare(leaf.frac)}`;
}
