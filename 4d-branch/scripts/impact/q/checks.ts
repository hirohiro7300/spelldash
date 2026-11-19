// 作った木の点検（P2 の前提の分。作業メモ SPEC v1 §2.2・§2.3・§2.6）と、転職活動の数（§2.7）。どれかに通らなければ生成は木を書き出さない。
//   N10 Pro を出していれば、届け出の答えが『全部可』か『SpellDash だけ可』、または独立（pro = 1 ⇒ pm ∈ {a, s} または j = i）
//   N7  広告運用の顧客がいれば、答えが『全部可』か独立（届け出の無い顧客はいない）
//   C1  顧客はどの場合も整数の社数。社数の違う場合をまとめた状態だけが幅（まとめた分布の 10%〜90%。整数）を持ち、平均は一番小さい〜大きい社数の中
//   C2  結果の名前の社数は、状態の社数と幅に合う（「顧客 1〜2 社」なら社数は 1 と 2 だけで、幅もその中。「1 社目」なら 1 社以上）
//   F1  事実（会社の答え・仕事・試用／導入／実績・転職したか）の違う結果をまとめていない
//   K1  暦: 4 月の月の番号はどれも (anchorMonth + a) mod 12 = 4 で、漏れが無い
//   J1  転職活動: この会社での期の数は searchMax まで、続けて決まらなかった期の数は searchRun まで（どの状態でも）
//   J2  一番ありそうな道で、続けて決まらなかった転職活動は searchRun 期まで（最初の手ごと）
// 数（おすすめの道。どの判断でも一番良い手を選び、出来事はすべて）: 転職活動を 1 期以上する見込み・転職した見込み・転職活動の期の数の平均

import { calendarCheck } from "./calendar";
import { displayOrder } from "./devTree";
import type { QNode } from "./gen";
import { bandOf } from "./group";
import { isSearch, uses } from "./quarter";
import { bookStats } from "./sim";
import { H, type WorldQ } from "./world";

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

/** 名前に書いた社数（「顧客 1〜2 社」「顧客 3 社」「全部可・1 社目」）。無ければ null */
function labelClients(lab: string): { lo: number; hi: number } | null {
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
    }
    for (const k of n.kids) walk(k);
  };
  walk(root);
  if (counts.n10Sum) warns.push(`N10 まとめた行き先の代表の状態（違う道を混ぜた物）で ${counts.n10Sum} 枚`);
  const search = root.kids.map((a0) => searchStats(w, a0));
  for (const s of search) if (s.chainMaxFailRun > w.q.searchRun) fail(`J2 一番ありそうな道で続けて決まらなかった転職活動が ${s.chainMaxFailRun} 期（${s.kind}）`);
  return { fails, warns, counts, search };
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
