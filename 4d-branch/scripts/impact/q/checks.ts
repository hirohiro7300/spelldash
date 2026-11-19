// 作った木の点検（P2 の前提の分。作業メモ SPEC v1 §2.2・§2.3・§2.6）と、転職活動の数（§2.7）。どれかに通らなければ生成は木を書き出さない。
//   N10 Pro を出していれば、届け出の答えが『全部可』か『SpellDash だけ可』、または独立（pro = 1 ⇒ pm ∈ {a, s} または j = i）
//   N7  広告運用の顧客がいれば、答えが『全部可』か独立（届け出の無い顧客はいない）
//   C1  顧客はどの場合も整数の社数。社数の違う場合をまとめた状態だけが幅（まとめた分布の 10%〜90%。整数）を持ち、平均は一番小さい〜大きい社数の中
//   C2  結果の名前の社数は、状態の社数と幅に合う（「顧客 1〜2 社」なら社数は 1 と 2 だけで、幅もその中。「1 社目」なら 1 社以上）
//   F1  事実（会社の答え・仕事・試用／導入／実績・転職したか）の違う結果をまとめていない
//   K1  暦: 4 月の月の番号はどれも (anchorMonth + a) mod 12 = 4 で、漏れが無い
//   J1  転職活動: この会社での期の数は searchMax まで、続けて決まらなかった期の数は searchRun まで（どの状態でも）
//   J2  一番ありそうな道で、続けて決まらなかった転職活動は searchRun 期まで（最初の手ごと）
//   J3  転職は 3 年で 1 回: 移った後の会社員の判断に転職活動の手が無い（前提の文と決まりが合うかは premiseRuleChecks）
//   J4  週 4 日は戻さない: 週 4 日の判断に転職活動の手が無い（同じく premiseRuleChecks）
// 前提の文と手の決まりの点検（premiseRuleChecks。世界だけで見る。見直し truth-3・truth-6・truth-7）:
//   J3  前提の文に SWITCH_ONCE がある ⇔ 移った後の会社員は転職活動を選べない（独立してから会社員に戻ると、また選べる）
//   J4  前提の文に PART_ONEWAY がある ⇔ 週 4 日からは転職活動も週 4 日の相談もできず、どの手でも 3 か月で会社員（週 5 日）に戻らない
//   K2  昇格を狙える 3 か月（4 月を含む段）でだけ昇格を狙う手が選べ、今日がその 3 か月なら今日の手にある
// 数（おすすめの道。どの判断でも一番良い手を選び、出来事はすべて）: 転職活動を 1 期以上する見込み・転職した見込み・転職活動の期の数の平均
// 新しい出力の点検（checkOutputs。作業メモ SPEC v1 §2.4・§2.6）:
//   Q1  まとめた手でない手にはどれも q（有限の R3）があり、まとめた手には無い
//   Q2  判断の一番良い手は、同じ見積もり方（q・まとめた手の値）でも一番（同じ見積もり方の ★ の元）
//   M1  まとめた行き先にはどれも mix があり、割合は 0〜1（仕事・届け出の答えは合わせて 1）、幅は小さい順、顧客は整数で幅 band と同じ
//   M2  まとめた行き先にはどれも cont があり、まとめた手の 3 か月の後から 33 か月目まで 3 か月ごとに 1 つずつ。手は世界の手、出来事は決まった語彙
//   B1  分かれ道の数は、最初の手ごとに min(目標, 届く上限) の ±tol
//   N1  ノードは maxNodes 枚まで
//   K0  never に _all とまとまりすべてがあり、3 か月の結果の入れ物を使い回して何も除かない計算をし直すと _all と同じ
//       （k(none) = 0。入れ物が値を変えないことの点検。年収 360・540 万円で 1e-9 まで）

import { calendarCheck, calendarOf } from "./calendar";
import { Wsum } from "./core";
import { displayOrder } from "./devTree";
import type { MoveStats, QNode } from "./gen";
import { bandOf } from "./group";
import { CONT_EVENTS, likeValue, type NeverResult } from "./outputs";
import { feasibleQ, isSearch, uses } from "./quarter";
import { bookStats, simQ, toQ, type QSt } from "./sim";
import { H, NSTAGE, PART_ONEWAY, SWITCH_ONCE, type WorldQ } from "./world";

export interface SearchStats {
  kind: string;
  /** おすすめの道で、転職活動を 1 期以上する見込み */
  pSearch: number;
  /** 36 か月目に転職している見込み（会社員に戻ると数えない）・一度でも転職した見込み */
  pSwitched: number;
  pEverSwitched: number;
  /** 転職活動の期の数の平均 */
  meanSearch: number;
  /** 一番ありそうな道: 見込み・続けて決まらなかった転職活動の一番長い期の数・手と結果の並び */
  chainP: number;
  chainMaxFailRun: number;
  chain: string[];
}

export interface TreeCheck {
  fails: string[];
  warns: string[];
  counts: { states: number; mixed: number; n10: number; n10Sum: number };
  search: SearchStats[];
}

const better = (a: QNode, b: QNode) => a.V > b.V + 1e-9 || (Math.abs(a.V - b.V) <= 1e-9 && a.kind === "keep" && b.kind !== "keep");
/** 判断で一番良い手（値が同じなら今のまま）。rollbackApp の後に呼ぶ */
export const bestOf = (d: QNode): QNode => d.kids.reduce((b, a) => (better(a, b) ? a : b));

/**
  * 名前に書いた社数（「顧客 1〜2 社」「顧客 3 社」「全部可（1 社目あり）」）。無ければ null。名前は ./group.ts の describe（clRange・permside の名前）が書く物で、
 * 書き方を変えたらここも変える（変えないと C2 が何も見なくなる。テストが本物の名前で確かめる）
 */
export function labelClients(lab: string): { lo: number; hi: number } | null {
  const range = /顧客 (\d+)〜(\d+) 社/.exec(lab);
  if (range) return { lo: Number(range[1]), hi: Number(range[2]) };
  const one = /顧客 (\d+) 社/.exec(lab);
  if (one) return { lo: Number(one[1]), hi: Number(one[1]) };
  if (/1 社目/.test(lab)) return { lo: 1, hi: Infinity };
  return null;
}

/** 結果の名前（id）が違う事実をまとめていないか（a0・a1 はどちらも『全部可』） */
function mergesFacts(kind: string, id: string, metric: string): boolean {
  const keys = id.split("_");
  if (keys.length < 2) return false;
  if (metric === "perm" || metric === "permside") return new Set(keys.map((k) => k.charAt(0))).size > 1;
  if (metric === "job" || metric === "pilot" || metric === "portfolio" || metric === "school") return true;
  if (metric === "sal" && isSearch(kind)) return keys.includes("none");
  return false;
}

/** 木を点検する（rollbackApp(root, 生成の月給) の後に呼ぶ） */
export function checkTree(w: WorldQ, root: QNode): TreeCheck {
  const fails: string[] = [];
  const warns: string[] = [];
  const counts = { states: 0, mixed: 0, n10: 0, n10Sum: 0 };
  const fail = (s: string) => {
    if (fails.length < 40) fails.push(s);
    else if (fails.length === 40) fails.push("（ほかにもある）");
  };
  for (const e of calendarCheck(w.anchor, w.constants.aprilMonths, H)) fail(`K1 ${e}`);
  const walk = (n: QNode) => {
    if (n.role !== "a") {
      const st = n.st;
      counts.states++;
      const b = bookStats(w, st.cb);
      const sum = !!n.sumEnd;
      // N10・N7（まとめた行き先の状態は、違う道の代表を混ぜた物なので数えるだけ）
      if (st.pro === 1 && !(st.pm === "a" || st.pm === "s" || st.j === "i")) {
        if (sum) counts.n10Sum++;
        else {
          counts.n10++;
          fail(`N10 Pro を出しているのに届け出が認められていない: ${n.key}（${st.j}・${st.pm}）`);
        }
      }
      if (!sum && b.hi > 0 && !(st.pm === "a" || st.j === "i")) fail(`N7 届け出の無い顧客: ${n.key}（${st.j}・${st.pm}・顧客 ${b.lo}〜${b.hi} 社）`);
      // C1 顧客は整数・幅は混ざりだけ
      for (const c of st.cb) if (!c.n.every((k) => Number.isInteger(k) && k >= 0)) fail(`C1 顧客の社数が整数でない: ${n.key}`);
      const band = bandOf(w, st);
      if (b.lo < b.hi) {
        counts.mixed++;
        if (!(st.cl >= b.lo - 1e-9 && st.cl <= b.hi + 1e-9)) fail(`C1 顧客の平均が社数の外: ${n.key}（${st.cl}・${b.lo}〜${b.hi}）`);
        const [lo, hi] = band?.cl ?? [NaN, NaN];
        if (!(Number.isInteger(lo) && Number.isInteger(hi) && b.lo <= lo && lo <= hi && hi <= b.hi)) fail(`C1 幅が整数でない・社数の外: ${n.key}（${lo}〜${hi}）`);
      } else {
        if (band) fail(`C1 1 つの社数なのに幅がある: ${n.key}`);
        if (!Number.isInteger(st.cl) || st.cl !== b.lo) fail(`C1 1 つの社数なのに整数でない: ${n.key}（${st.cl}）`);
      }
      // C2 名前の社数（その 3 か月の終わりの状態と比べる。まとめた行き先の状態は 36 か月目の代表なので、結果の状態の方）
      if (n.out) {
        const ob = bookStats(w, n.out.st.cb);
        const lc = labelClients(n.out.lab);
        if (lc && !(ob.lo >= lc.lo && ob.hi <= lc.hi)) fail(`C2 名前の社数が状態と合わない: ${n.key}「${n.out.lab}」（${ob.lo}〜${ob.hi} 社）`);
        const oband = bandOf(w, n.out.st);
        if (lc && oband && !(oband.cl[0] >= lc.lo && oband.cl[1] <= lc.hi)) fail(`C2 名前の社数が幅と合わない: ${n.key}「${n.out.lab}」（幅 ${oband.cl.join("〜")} 社）`);
        if (n.out.ln.metric === "cl" && lc && !(lc.lo === ob.lo && lc.hi === ob.hi)) fail(`C2 顧客で分けた結果の名前が社数と違う: ${n.key}「${n.out.lab}」（${ob.lo}〜${ob.hi} 社）`);
        if (n.parent?.kind && mergesFacts(n.parent.kind, n.out.id, n.out.ln.metric)) fail(`F1 違う事実をまとめた結果: ${n.key}`);
      }
      // J1 転職活動の上限
      if (uses(st, "q") > w.q.searchMax || uses(st, "r") > w.q.searchRun) fail(`J1 転職活動の期の数が上限を超える: ${n.key}（${st.fl.join(",")}）`);
      // J3・J4 移った後の会社員・週 4 日の判断に転職活動の手が無い
      const search = n.kids.find((a) => a.role === "a" && isSearch(a.kind!));
      if (search && st.j === "e" && st.fl.includes("switched")) fail(`J3 移った後の会社で転職活動の手: ${search.key}`);
      if (search && st.j === "p") fail(`J4 週 4 日で転職活動の手: ${search.key}`);
    }
    for (const k of n.kids) walk(k);
  };
  walk(root);
  if (counts.n10Sum) warns.push(`N10 まとめた行き先の代表の状態（違う道を混ぜた物）で ${counts.n10Sum} 枚`);
  const search = root.kids.map((a0) => searchStats(w, a0));
  for (const s of search) if (s.chainMaxFailRun > w.q.searchRun) fail(`J2 一番ありそうな道で続けて決まらなかった転職活動が ${s.chainMaxFailRun} 期（${s.kind}）`);
  return { fails, warns, counts, search };
}

/**
 * 前提の文と手の決まりが合うか（世界だけで見る。生成は木を作る前に呼ぶ）。通らない物の文を返す:
 *   J3 前提の文に SWITCH_ONCE がある ⇔ 移った後の会社員は転職活動（1 期目・続ける）を選べない。独立してから会社員に戻ると印が外れて、また選べる
 *   J4 前提の文に PART_ONEWAY がある ⇔ 週 4 日からは転職活動・週 4 日の相談を選べず、どの手でも 3 か月で週 5 日の会社員に戻らない
 *   K2 昇格を狙う手は 4 月を含む 3 か月（calendarOf の promoStages）でだけ選べ、今日がその 3 か月なら今日の手にある
 * feas は手の決まり（テストで決まりを変えて、文と合わない時に通らないことを確かめる）
 */
export function premiseRuleChecks(w: WorldQ, feas: (w: WorldQ, x: QSt, kind: string, m0: number) => boolean = feasibleQ): string[] {
  const fails: string[] = [];
  const stated = (t: string) => w.premises.some((p) => p.includes(t));
  const today = toQ(w, w.today);
  const at = (j: QSt["j"], fl: string[]): QSt => ({ ...today, j, fl: [...fl].sort(), cb: today.cb });
  // J3 転職は 3 年で 1 回
  const moved = at("e", ["switched"]);
  const locked = !feas(w, moved, "fc_switch", 3) && !feas(w, at("e", ["jx", "q1", "switched"]), "fc_switch2", 3);
  if (stated(SWITCH_ONCE) !== locked) fail(`J3 前提の文（転職は 3 年で 1 回）${stated(SWITCH_ONCE) ? "がある" : "が無い"}のに、移った後の会社員が転職活動を${locked ? "選べない" : "選べる"}`);
  const back = simQ(w, at("i", ["switched"]), "back_emp", 3).filter((x) => x.x.j === "e");
  if (!back.length || back.some((x) => !feas(w, x.x, "fc_switch", 6))) fail("J3 独立してから会社員に戻った会社で、転職活動の 1 期目を選べない");
  // J4 週 4 日は戻さない
  const part = at("p", ["pq"]);
  const noSearch = ["fc_switch", "fc_switch2", "part"].every((k) => !feas(w, part, k, 3) && !feas(w, at("p", ["jx", "pq", "q1"]), k, 3));
  const toFull: string[] = [];
  for (const k of Object.keys(w.kinds)) if (feas(w, part, k, 3) && simQ(w, part, k, 3).some((x) => x.x.j === "e")) toFull.push(k);
  const oneWay = noSearch && !toFull.length;
  if (stated(PART_ONEWAY) !== oneWay) fail(`J4 前提の文（週 4 日は戻さない）${stated(PART_ONEWAY) ? "がある" : "が無い"}のに、週 4 日から${oneWay ? "戻らない" : `戻る・転職活動ができる（${toFull.join(",") || "転職活動・週 4 日の相談"}）`}`);
  // K2 昇格を狙える 3 か月
  const cal = calendarOf(w.anchor, H);
  for (let s = 0; s < NSTAGE; s++) {
    const promo = cal.promoStages.includes(s);
    for (const j of ["e", "p"] as const) if (feas(w, at(j, []), "fc_push", 3 * s) !== promo) fail(`K2 ${3 * s} か月目の昇格を狙う手が${promo ? "選べない（4 月を含む 3 か月）" : "選べる（4 月を含まない 3 か月）"}（${j}）`);
  }
  if (cal.promoStages.includes(0) && !w.rootMenu.includes("fc_push")) fail("K2 今日の 3 か月が昇格を狙える 3 か月なのに、今日の手に昇格を狙う手が無い");
  return fails;
  function fail(x: string): void {
    fails.push(x);
  }
}

/** 届け出の答えの順（見直し truth-4）: 届け出る手ごとに、答えごとの値 V(答え) = Σ p (w(e) + V(子)) / Σ p（rollbackApp の後に呼ぶ） */
export interface Dominance {
  /** 答えで分かれた届け出る手の数 */
  options: number;
  /** V(SpellDash だけ可) < V(どちらも不可) − eps の手・V(全部可) < V(SpellDash だけ可) − eps の手と、一番大きい差（万円）・例 */
  sn: number;
  as: number;
  worstSn: number;
  worstAs: number;
  examples: string[];
}

/** 届け出の答えの順 V(全部可) ≥ V(SpellDash だけ可) ≥ V(どちらも不可) を、届け出る手ごとに見る（数えるだけ。年収 S で rollbackApp した後） */
export function filingDominance(root: QNode, S: number, eps = 1e-6): Dominance {
  const d: Dominance = { options: 0, sn: 0, as: 0, worstSn: 0, worstAs: 0, examples: [] };
  const walk = (n: QNode) => {
    if (n.role === "a" && n.kids.length && n.kids.every((c) => c.out && (c.out.ln.metric === "perm" || c.out.ln.metric === "permside"))) {
      const acc = new Map<string, [number, number]>();
      for (const c of n.kids) {
        const ans = c.out!.id.charAt(0);
        const t = acc.get(ans) ?? [0, 0];
        t[0] += c.out!.p * (Wsum(c.r!, S) + c.V);
        t[1] += c.out!.p;
        acc.set(ans, t);
      }
      const v = (a: string) => {
        const t = acc.get(a);
        return t ? t[0] / t[1] : null;
      };
      const [va, vs, vn] = [v("a"), v("s"), v("n")];
      d.options++;
      if (vs !== null && vn !== null && vs < vn - eps) {
        d.sn++;
        d.worstSn = Math.max(d.worstSn, vn - vs);
        if (d.examples.length < 3) d.examples.push(`${n.key}（SpellDash だけ可 ${(vs - vn).toFixed(2)}）`);
      }
      if (va !== null && vs !== null && va < vs - eps) {
        d.as++;
        d.worstAs = Math.max(d.worstAs, vs - va);
        if (d.examples.length < 3) d.examples.push(`${n.key}（全部可 ${(va - vs).toFixed(2)}）`);
      }
    }
    for (const k of n.kids) walk(k);
  };
  walk(root);
  return d;
}

/** 最初の手 a0 のおすすめの道（どの判断でも一番良い手）の転職活動の数と、一番ありそうな道 */
export function searchStats(w: WorldQ, a0: QNode): SearchStats {
  const S = w.annual / 12;
  let pSearch = 0;
  let pSwitched = 0;
  let pEver = 0;
  let mean = 0;
  let total = 0;
  // 出来事はすべて、判断は一番良い手
  const go = (opt: QNode, p: number, ns: number, ever: boolean) => {
    const n2 = ns + (isSearch(opt.kind!) ? 1 : 0);
    for (const c of opt.kids) {
      const q = p * (c.out!.p / 100);
      const ev = ever || (c.st.fl.includes("switched") && !opt.st.fl.includes("switched"));
      if (c.role === "e") {
        total += q;
        if (n2 >= 1) pSearch += q;
        if (c.st.fl.includes("switched")) pSwitched += q;
        if (ev) pEver += q;
        mean += q * n2;
        continue;
      }
      go(bestOf(c), q, n2, ev);
    }
  };
  go(a0, 1, 0, false);
  // 一番ありそうな道: 一番ありそうな結果（並べる順で先の物）→ 一番良い手 → …
  const chain: string[] = [];
  let chainP = 1;
  let run = 0;
  let maxRun = 0;
  let opt: QNode | null = a0;
  while (opt) {
    const kids = displayOrder(opt, S);
    const c = kids.reduce((b, x) => (x.out!.p > b.out!.p ? x : b));
    chainP *= c.out!.p / 100;
    chain.push(`${opt.kind}→${c.out!.id}`);
    const failed = isSearch(opt.kind!) && !(c.st.fl.includes("switched") && !opt.st.fl.includes("switched"));
    run = failed ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
    opt = c.role === "e" ? null : bestOf(c);
  }
  return { kind: a0.kind!, pSearch: pSearch / total, pSwitched: pSwitched / total, pEverSwitched: pEver / total, meanSearch: mean / total, chainP, chainMaxFailRun: maxRun, chain };
}

export interface OutputCheckOpts {
  /** 最初の手ごとの数（予算の合わせ込みの報告つき）。無ければ B1 は見ない */
  stats?: readonly MoveStats[];
  /** 分かれ道の数の目標の幅（±） */
  tol: number;
  /** 「3 年やらない」見積もり（無ければ K0 は見ない）と、そのまとまり */
  never?: NeverResult;
  fams?: readonly string[];
  maxNodes: number;
}

/** 新しい出力の点検（rollbackApp(root, 生成の月給) と summaryOutputs の後に呼ぶ）。通らない物の文を返す */
export function checkOutputs(w: WorldQ, root: QNode, o: OutputCheckOpts): string[] {
  const S = w.annual / 12;
  const fails: string[] = [];
  const fail = (s: string) => {
    if (fails.length < 40) fails.push(s);
    else if (fails.length === 40) fails.push("（ほかにもある）");
  };
  const isR3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
  const kinds = new Set(Object.keys(w.kinds));
  const events = new Set(CONT_EVENTS);
  let nodes = 0;
  const in01 = (x: number) => x >= -1e-9 && x <= 1 + 1e-9;
  const sorted3 = (t: readonly number[]) => t.length === 3 && t.every((x) => Number.isFinite(x)) && t[0]! <= t[1]! && t[1]! <= t[2]!;
  const walk = (n: QNode) => {
    nodes++;
    if (n.role === "a") {
      if (n.stub && n.qv) fail(`Q1 まとめた手に q がある: ${n.key}`);
      if (!n.stub && !isR3(n.qv)) fail(`Q1 まとめた手でない手に q が無い: ${n.key}`);
    }
    if (n.role === "s" || n.role === "r") {
      const best = n.kids.find((a) => a.why === "best") ?? (n.role === "s" ? n.kids.find((a) => a.kind === "keep") : undefined);
      if (best) {
        const lb = likeValue(best, S);
        for (const a of n.kids) if (likeValue(a, S) > lb + 1e-6) fail(`Q2 同じ見積もり方で一番良い手より良い手: ${a.key}（${likeValue(a, S).toFixed(3)} > ${lb.toFixed(3)}）`);
      }
    }
    if (n.role === "e" && n.sumEnd) {
      const mx = n.mix;
      if (!mx) fail(`M1 まとめた行き先に mix が無い: ${n.key}`);
      else {
        const js = mx.j.e + mx.j.p + mx.j.i;
        const pms = mx.pm["?"] + mx.pm.a + mx.pm.s + mx.pm.n;
        const shares = [mx.j.e, mx.j.p, mx.j.i, mx.pm["?"], mx.pm.a, mx.pm.s, mx.pm.n, mx.pro, mx.switched, mx.school];
        if (!shares.every(in01) || Math.abs(js - 1) > 1e-3 || Math.abs(pms - 1) > 1e-3) fail(`M1 mix の割合: ${n.key}`);
        if (![mx.cl, mx.pu, mx.mau, mx.sal].every(sorted3) || !mx.cl.every((k) => Number.isInteger(k) && k >= 0)) fail(`M1 mix の幅: ${n.key}`);
        const band = bandOf(w, n.st);
        if (band && (band.cl[0] !== mx.cl[0] || band.cl[1] !== mx.cl[2])) fail(`M1 mix の顧客の幅が band と違う: ${n.key}（${band.cl.join("〜")} / ${mx.cl.join("・")}）`);
        if (!band && mx.cl[0] !== mx.cl[2]) fail(`M1 1 つの社数なのに mix の顧客に幅: ${n.key}`);
      }
      const ct = n.cont;
      const m1 = n.parent!.m + 3;
      if (!ct) fail(`M2 まとめた行き先に cont が無い: ${n.key}`);
      else if (ct.length !== (H - m1) / 3 || ct.some((c, i) => c.m !== m1 + 3 * i || !kinds.has(c.kind) || (c.ev !== undefined && !events.has(c.ev)))) fail(`M2 cont の並び: ${n.key}`);
    }
    for (const k of n.kids) walk(k);
  };
  walk(root);
  if (nodes > o.maxNodes) fail(`N1 ノードが ${nodes} 枚（上限 ${o.maxNodes}）`);
  for (const s of o.stats ?? []) {
    const c = s.calib;
    if (!c.hit) fail(`B1 分かれ道 ${s.forks} が目標 ${c.target} の ±${(100 * o.tol).toFixed(0)}% に入らない: ${s.kind}`);
  }
  if (o.never) {
    const nv = o.never.never;
    for (const k of ["_all", ...(o.fams ?? [])]) if (!isR3(nv[k])) fail(`K0 never に ${k} が無い`);
    // 3 か月の結果の入れ物を使い回して作り直した _all（none）が、新しい入れ物で作った _all と同じ（入れ物が値を変えない）
    for (const annual of [360, 540]) {
      const s = annual / 12;
      const k = Wsum(nv._all!, s) - Wsum(o.never.none.v, s);
      if (!(Math.abs(k) <= 1e-9)) fail(`K0 3 か月の結果の入れ物を使い回すと値が変わる: k(none) = ${k.toExponential(2)}（年収 ${annual} 万円）`);
    }
  }
  return fails;
}
