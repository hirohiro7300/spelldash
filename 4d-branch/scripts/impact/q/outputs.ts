// 生成の新しい出力（作業メモ SPEC v1 §2.4・D2。見直し truth-2・truth-3・truth-5・user-3）:
//   まとめた行き先の中身 mix と標準の続き cont: どちらも、その行き先の値を出した続きの見積もり（./core.ts の Roll。合流のある形）をたどって出す
//   「3 年やらない」場合の見積もり never: 粗い表をその種類なしで作り直した、今日からの続きの見積もり（R3）。_all は何も除かない同じ見積もり
//   ★ の数: 木の値で比べた場合と、同じ見積もり方（q・まとめた手の値）で比べた場合

import type { MapContStep, MapMix } from "../../../src/deepmap/mapData";
import type { Vec3 } from "../sim";
import { CoarseDP, GRID, OutcomeCache, quarterOutcomes, Rollouts, Wsum, type Mode, type Roll } from "./core";
import { qOf, type QNode } from "./gen";
import { clientDist, clientMode, distQuantiles } from "./group";
import { toQ, type QSt } from "./sim";
import type { WorldQ } from "./world";

// ---- 標準の続きの出来事（cont の ev）

/**
 * 標準の続きの出来事の名前。文章の組み立て（src/demo/compose の出来事）と同じ語彙で、並びは大事な順（1 つの 3 か月に複数あれば先の物）。
 * その 3 か月の初めの状態 a → 一番ありそうな結果の状態 b で決める。顧客の社数は一番ありそうな社数（顧客の場合の混ざりの最頻値。
 * 続きの見積もりは数の結果を平均するので、平均の四捨五入では離れる・戻るが交互に出る。最頻値なら、半分に届かない 1 社目の営業や 1 期分の離れ方は出来事にならない）:
 *   IND_START     会社員・週 4 日勤務 → 独立
 *   BACK_EMP      独立 → 会社員（戻る会社は SpellDash だけ可。広告運用の顧客は手放す）
 *   SWITCH_HIGH   転職した（給与が前の 1.13 倍以上）
 *   SWITCH_MID    転職した（1.13 倍未満）
 *   PERM_A        届け出る手（ad_perm・ad_permside・sd_permpro）で、会社の答えが『全部可』
 *   PERM_S        同じく『SpellDash だけ可』
 *   PERM_N        同じく『どちらも不可』
 *   PART_ON       会社員 → 週 4 日勤務
 *   PROMO         昇格を狙う手で昇格した（結果が up。続きの見積もりは昇格の結果を平均するので、ふつうは出ない）
 *   FIRST_CLIENT  広告運用の顧客が 0 → 1 社以上で、道でそれまで顧客がいなかった
 *   SCHOOL_ON     学校への提案で導入が決まった
 *   CLIENT_UP     顧客の社数が増え、道でそれまでの一番多い社数を超えた
 *   CLIENT_REGAIN 顧客の社数が増えた（道でそれまでの一番多い社数まで）
 *   PILOT_ON      学校・塾の無料の試用が決まった
 *   PU_MILE       有料会員が 10・30・100・300 人のどれかを超えた（Pro を出している）
 *   PORTFOLIO_ON  無償の手伝いが実績になった
 *   CLIENT_LOST   顧客の社数が減った（会社員に戻って手放した分は除く）
 *   PRO_START     Pro の受付を始めた（届け出の答えが出た 3 か月でない時）
 * どれも無い 3 か月は ev を付けない（文章は、同じ手が続いて出来事の無い 3 か月をまとめて書く）
 */
export const CONT_EVENTS: readonly string[] = [
  "IND_START",
  "BACK_EMP",
  "SWITCH_HIGH",
  "SWITCH_MID",
  "PERM_A",
  "PERM_S",
  "PERM_N",
  "PART_ON",
  "PROMO",
  "FIRST_CLIENT",
  "SCHOOL_ON",
  "CLIENT_UP",
  "CLIENT_REGAIN",
  "PILOT_ON",
  "PU_MILE",
  "PORTFOLIO_ON",
  "CLIENT_LOST",
  "PRO_START",
];

const FILING = new Set(["ad_perm", "ad_permside", "sd_permpro"]);
const PU_MILES = [10, 30, 100, 300];
const has = (s: QSt, f: string) => s.fl.includes(f);

/** その 3 か月（手 kind・結果の名前 id）の一番大事な出来事。無ければ null。best はこの 3 か月の初めまでに道で一番多かった顧客の社数（一番ありそうな社数） */
export function contEvent(kind: string, a: QSt, b: QSt, id: string, best: number): string | null {
  const ev = new Set<string>();
  if (FILING.has(kind) && a.pm === "?" && b.pm !== "?") ev.add(b.pm === "a" ? "PERM_A" : b.pm === "s" ? "PERM_S" : "PERM_N");
  if (a.j !== "i" && b.j === "i") ev.add("IND_START");
  const back = a.j === "i" && b.j !== "i";
  if (back) ev.add("BACK_EMP");
  if (a.j === "e" && b.j === "p") ev.add("PART_ON");
  if (has(b, "switched") && !has(a, "switched")) ev.add(b.sal / Math.max(1e-9, a.sal) >= 1.13 ? "SWITCH_HIGH" : "SWITCH_MID");
  if (kind === "fc_push" && id === "up") ev.add("PROMO");
  if (a.pro === 0 && b.pro === 1 && !ev.has("PERM_A") && !ev.has("PERM_S")) ev.add("PRO_START");
  const ca = clientMode(a);
  const cb = clientMode(b);
  if (cb > ca) ev.add(ca === 0 && best === 0 ? "FIRST_CLIENT" : cb <= best ? "CLIENT_REGAIN" : "CLIENT_UP");
  else if (cb < ca && !back) ev.add("CLIENT_LOST");
  if (kind === "sd_school" && id === "yes" && has(b, "school")) ev.add("SCHOOL_ON");
  if (kind === "sd_pilot" && id === "yes" && has(b, "pilot") && !has(a, "pilot")) ev.add("PILOT_ON");
  if (kind === "ad_portfolio" && id === "yes" && has(b, "portfolio") && !has(a, "portfolio")) ev.add("PORTFOLIO_ON");
  if (b.pro === 1 && PU_MILES.some((m) => a.pu < m && b.pu >= m)) ev.add("PU_MILE");
  return CONT_EVENTS.find((e) => ev.has(e)) ?? null;
}

/**
 * 標準の続き（cont）: 続きの見積もり c の初め（まとめた手の 3 か月の結果）から 36 か月目まで、3 か月ごとに粗い表の手と、
 * その一番ありそうな結果（同じ見込みなら先の結果）の一番大事な出来事。次の 3 か月はその結果から。best0 は道でそれまでの一番多い顧客の社数
 */
export function contOf(c: Roll, best0: number): MapContStep[] {
  const out: MapContStep[] = [];
  let best = best0;
  for (let n = c; n.k; ) {
    const kid = n.kids.reduce((b, x) => (x.p > b.p ? x : b));
    best = Math.max(best, clientMode(n.x));
    const ev = contEvent(n.k, n.x, kid.next.x, kid.id, best);
    out.push(ev ? { m: 3 * n.s, kind: n.k, ev } : { m: 3 * n.s, kind: n.k });
    n = kid.next;
  }
  return out;
}

// ---- まとめた行き先の中身（mix）

/** 続きの見積もりの 36 か月目の行き先 1 つ: 状態・見込み・そのうち一度でも転職した見込み */
export interface Leaf {
  x: QSt;
  m: number;
  sw: number;
}

/**
 * 続きの見積もり c の 36 か月目の行き先（合流した所は見込みを足し合わせる）。段ごとに見込みを流すので、道の数ではなく見積もりの状態の数だけかかる。
 * ever: c の初めまでに道ですでに転職した（それなら見込みはすべて「転職した」）
 */
export function leavesOf(c: Roll, ever: boolean): Leaf[] {
  let layer = new Map<Roll, [number, number]>([[c, ever || has(c.x, "switched") ? [0, 1] : [1, 0]]]);
  const out: Leaf[] = [];
  while (layer.size) {
    const next = new Map<Roll, [number, number]>();
    for (const [n, [m0, m1]] of layer) {
      if (!n.k) {
        out.push({ x: n.x, m: m0 + m1, sw: m1 });
        continue;
      }
      const sw0 = has(n.x, "switched");
      for (const kid of n.kids) {
        const q = kid.p / 100;
        const cur = next.get(kid.next) ?? [0, 0];
        if (!sw0 && has(kid.next.x, "switched")) cur[1] += (m0 + m1) * q;
        else {
          cur[0] += m0 * q;
          cur[1] += m1 * q;
        }
        next.set(kid.next, cur);
      }
    }
    layer = next;
  }
  return out;
}

const share = (x: number) => Math.round(x * 1e4) / 1e4;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** その月に払われる給与の倍率（会社員は sal・週 4 日は partFactor × sal・独立は 0。月の稼ぎ rr[0] と同じ） */
export const paidSal = (w: WorldQ, x: QSt): number => r4(x.j === "e" ? x.sal : x.j === "p" ? w.constants.partFactor * x.sal : 0);

/**
 * まとめた行き先の中身（MapMix）: 割合は 36 か月目の行き先の見込みの割合（小数 4 桁）。仕事・届け出の答え・Pro・学校の席（seats > 0）は行き先の状態、
 * 転職は道の初めからの「一度でも転職した」。幅 [10%, 50%, 90%] は、顧客は行き先の状態（st: 行き先の顧客の場合の混ざり）の社数（整数。band と同じ取り方）、
 * 有料・遊ぶ人（月）・給与（その月に払われる倍率）は行き先ごとの値
 */
export function mixOf(w: WorldQ, st: QSt, leaves: readonly Leaf[]): MapMix {
  let tot = 0;
  const j = { e: 0, p: 0, i: 0 };
  const pm = { "?": 0, a: 0, s: 0, n: 0 };
  let pro = 0;
  let sw = 0;
  let school = 0;
  for (const l of leaves) {
    tot += l.m;
    j[l.x.j] += l.m;
    pm[l.x.pm] += l.m;
    if (l.x.pro === 1) pro += l.m;
    if (l.x.seats > 0) school += l.m;
    sw += l.sw;
  }
  const f = (x: number) => share(x / tot);
  const q = (g: (x: QSt) => number, round: (v: number) => number) => distQuantiles(leaves.map((l): [number, number] => [g(l.x), l.m / tot]).sort((a, b) => a[0] - b[0]), [0.1, 0.5, 0.9]).map(round) as [number, number, number];
  return {
    j: { e: f(j.e), p: f(j.p), i: f(j.i) },
    pm: { "?": f(pm["?"]), a: f(pm.a), s: f(pm.s), n: f(pm.n) },
    pro: f(pro),
    switched: f(sw),
    school: f(school),
    cl: distQuantiles(clientDist(st), [0.1, 0.5, 0.9]) as [number, number, number],
    pu: q((x) => x.pu, r2),
    mau: q((x) => x.mau, r2),
    sal: q((x) => paidSal(w, x), r4),
  };
}

/**
 * まとめた行き先すべてに mix と cont を入れる（道の上の、それまでの一番多い顧客の社数と、すでに転職したかを持って下りる）。
 * 同じ続きの見積もりから始まる行き先は同じ物を指す（文字列にすると同じ）
 */
export function summaryOutputs(w: WorldQ, root: QNode): { sums: number; leaves: number } {
  let sums = 0;
  let leafCount = 0;
  const mixMemo = new Map<Roll, [MapMix | null, MapMix | null]>();
  const contMemo = new Map<Roll, Map<number, MapContStep[]>>();
  const walk = (n: QNode, best: number, ever: boolean) => {
    if (n.role === "r" || n.role === "s") {
      best = Math.max(best, clientMode(n.st));
      ever = ever || has(n.st, "switched");
    }
    if (n.role === "e") {
      if (!n.sumEnd) return;
      const c = n.roll!;
      const ev = ever || has(c.x, "switched");
      const mm = mixMemo.get(c) ?? [null, null];
      let mix = mm[ev ? 1 : 0];
      if (!mix) {
        const leaves = leavesOf(c, ev);
        leafCount += leaves.length;
        mix = mixOf(w, n.st, leaves);
        mm[ev ? 1 : 0] = mix;
        mixMemo.set(c, mm);
      }
      let cm = contMemo.get(c);
      if (!cm) contMemo.set(c, (cm = new Map()));
      let cont = cm.get(best);
      if (!cont) cm.set(best, (cont = contOf(c, best)));
      n.mix = mix;
      n.cont = cont;
      sums++;
      return;
    }
    for (const k of n.kids) walk(k, best, ever);
  };
  walk(root, 0, false);
  return { sums, leaves: leafCount };
}

/** mix・cont を出した後は、続きの見積もりの形（Roll）を木から放す（「3 年やらない」見積もりの粗い表を作る前に。大きいので） */
export function releaseRolls(root: QNode): void {
  const walk = (n: QNode) => {
    delete n.roll;
    delete n.ev;
    for (const k of n.kids) walk(k);
  };
  walk(root);
}

// ---- 「3 年やらない」場合の見積もり（never）

export interface NeverOne {
  /** 今日から 36 か月目までの稼ぎ（R3） */
  v: Vec3;
  /** 選んだ今日の手 */
  k: string;
  /** 作った粗い表のマスの数・続きの見積もりの状態の数・かかった時間 */
  cells: number;
  rolls: number;
  ms: number;
}

/**
 * 種類 exclude を使わない場合の、今日からの見積もり: 粗い表をその種類なしで作り直し（表を引く順は今日の手の順の続きの見積もり）、
 * 今日の手（その種類の手を除く）ごとに、その 3 か月（木の今日の手と同じまとめ方: fineAt）+ 続きの見積もり。生成の年収で一番大きい手の R3
 */
export function neverOf(w: WorldQ, S: number, exclude: ReadonlySet<string>, mode: (kind: string, x: QSt) => Mode, fineAt: (k: string) => boolean, oc: OutcomeCache | null): NeverOne {
  const t0 = performance.now();
  const kinds = Object.keys(w.kinds).filter((k) => !exclude.has(k));
  const dp = new CoarseDP(w, S, kinds, GRID, oc);
  const ro = new Rollouts(w, S, dp, mode);
  const today = toQ(w, w.today);
  let best: { v: Vec3; k: string; W: number } | null = null;
  for (const k of w.rootMenu) {
    if (exclude.has(k)) continue;
    const outs = quarterOutcomes(w, today, k, 0, "split", S, fineAt(k));
    const v = qOf(outs, outs.map((o) => ro.roll(1, o.st)));
    const W = Wsum(v, S);
    if (!best || W > best.W + 1e-9) best = { v, k, W };
  }
  if (!best) throw new Error("「3 年やらない」見積もり: 選べる今日の手がありません");
  return { v: best.v, k: best.k, cells: dp.memo.size, rolls: ro.memo.size, ms: performance.now() - t0 };
}

export interface NeverResult {
  /** 見出しの never: まとまりごと + "_all" */
  never: Record<string, Vec3>;
  info: Record<string, NeverOne>;
  /** 点検用: 何も除かない同じ計算を、3 か月の結果の入れ物を使わずに別に作った物 */
  none: NeverOne;
}

/**
 * 「3 年やらない」見積もりをまとまり fams（今のままを除く）ごとと _all に。表どうしで 3 か月の結果の入れ物を分け合う（値は変わらず速くなる）。
 * 点検用に、何も除かない計算を入れ物なしでもう一度作る（k(none) = _all − none は 0 になるはず。truth-3）
 */
export function neverValues(w: WorldQ, S: number, mode: (kind: string, x: QSt) => Mode, fineAt: (k: string) => boolean, fams: readonly string[]): NeverResult {
  const oc = new OutcomeCache();
  const never: Record<string, Vec3> = {};
  const info: Record<string, NeverOne> = {};
  const all = neverOf(w, S, new Set(), mode, fineAt, oc);
  never._all = all.v;
  info._all = all;
  for (const fam of fams) {
    const ex = new Set(Object.keys(w.kinds).filter((k) => w.kinds[k]!.family === fam));
    const one = neverOf(w, S, ex, mode, fineAt, oc);
    never[fam] = one.v;
    info[fam] = one;
  }
  const none = neverOf(w, S, new Set(), mode, fineAt, null);
  return { never, info, none };
}

// ---- ★ の数（見直し truth-2）

export interface StarCount {
  /** 数えた判断（手が 2 つ以上） */
  decisions: number;
  /** ★（一番の手が 2 位より lead 万円以上良い）: 木の値で・同じ見積もり方で・両方で */
  tree: number;
  q: number;
  both: number;
  /** 一番の手が、木の値と同じ見積もり方で違う判断 */
  argmaxDiff: number;
}

/** 手の同じ見積もり方の値: q があればそれ（まとめた手でない手）、まとめた手は木の値（子の行き先から。同じ見積もり方） */
export const likeValue = (a: QNode, S: number): number => (a.qv ? Wsum(a.qv, S) : a.V);

/**
 * ★ の数（rollbackApp(root, S) の後に呼ぶ）。all: すべての判断・mixed: 一番の手（木の値）を広げていて、まとめた手も並ぶ判断（truth-2 の数え方）・
 * pi: おすすめの道の上の判断
 */
export function starCounts(root: QNode, S: number, lead: number): { all: StarCount; mixed: StarCount; pi: StarCount } {
  const zero = (): StarCount => ({ decisions: 0, tree: 0, q: 0, both: 0, argmaxDiff: 0 });
  const all = zero();
  const mixed = zero();
  const pi = zero();
  // 1e-9 までの差は同じ値（アプリと同じく今のままを先に）。木の値と q が同じ式の 33 か月目で、足す順の違いで一番が入れ替わらないように
  const top2 = (xs: QNode[], val: (a: QNode) => number): [QNode, number] => {
    const s = [...xs].sort((a, b) => (Math.abs(val(b) - val(a)) > 1e-9 ? val(b) - val(a) : Number(b.kind === "keep") - Number(a.kind === "keep")));
    return [s[0]!, val(s[0]!) - val(s[1]!)];
  };
  const walk = (n: QNode) => {
    if ((n.role === "r" || n.role === "s") && n.kids.length >= 2) {
      const [tb, tl] = top2(n.kids, (a) => a.V);
      const [qb, ql] = top2(n.kids, (a) => likeValue(a, S));
      const add = (c: StarCount) => {
        c.decisions++;
        if (tl >= lead) c.tree++;
        if (ql >= lead) c.q++;
        if (tl >= lead && ql >= lead) c.both++;
        if (tb !== qb) c.argmaxDiff++;
      };
      add(all);
      if (!tb.stub && n.kids.some((a) => a.stub)) add(mixed);
      if (n.onPi) add(pi);
    }
    for (const k of n.kids) walk(k);
  };
  walk(root);
  return { all, mixed, pi };
}
