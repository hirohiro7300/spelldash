// 3 か月の手の決まり: 選べるか（元の決まり ../sim.ts の feasible に、3 か月ごとの模型の決まりを足す）と、状態の印の付け外し。
// 粗い表（core.ts）と木（gen.ts）は同じ feasibleQ を使うので、上限はどちらでも同じに効く。設計: 作業メモ SPEC v1 §2.3 #2〜#4
// 転職は 3 年で 1 回まで（移った後の会社では転職活動をしない。前提の文 SWITCH_ONCE）、週 4 日は戻さず転職活動もしない（PART_ONEWAY）。
// どちらも前提の文があることと、ここでの決まりがその通りに効くことを点検 J3・J4（checks.ts の premiseRuleChecks）が見る
// 状態の印（fl）に足す物:
//   js 転職活動を続けている（前の 3 か月が決まらなかった転職活動）・jx この会社で転職活動をした
//   q1〜q4 この会社で転職活動をした期の数・r1〜r2 続けて決まらなかった期の数（上限に届いたら次の 3 か月はほかの手）
//   pq この会社で週 4 日を断られた・g1〜g4 遊ぶ人を増やすを使った期の数・a1〜a4 広告で集めるを使った期の数・rt 続ける人を増やすを使った

import { driverOf, feasible, type Driver, type Job, type St } from "../sim";
import type { WorldQ } from "./world";

const has = (s: { fl: string[] }, f: string) => s.fl.includes(f);
/** 使った期の数の印（g1・a3・q2・r1 など） */
const isUseFlag = (f: string, p: string) => f.length === 2 && f[0] === p && /[1-9]/.test(f[1]!);

/** 数える印の数（印 gN・aN・qN・rN。p は g・a・q・r） */
export function uses(s: { fl: string[] }, p: string): number {
  const f = s.fl.find((x) => isUseFlag(x, p));
  return f ? Number(f[1]) : 0;
}

/** 数える印を n にする（0 なら外す） */
function setUses(x: { fl: string[] }, p: string, n: number): void {
  const rest = x.fl.filter((f) => !isUseFlag(f, p));
  x.fl = (n > 0 ? [...rest, `${p}${n}`] : rest).sort();
}

/** 3 年で使える期の数の上限（続ける人を増やすは印 rt で 1 回だけ） */
export const LIMITS = { sd_grow: 4, sd_ads: 4, sd_retain: 1 } as const;

export const isSearch = (kind: string) => kind === "fc_switch" || kind === "fc_switch2";

/** その手が今の状態で選べるか（元の決まりに、3 か月ごとの模型の決まりを足す） */
export function feasibleQ(w: WorldQ, s: St, kind: string, m0: number): boolean {
  switch (kind) {
    case "fc_switch":
      // 転職活動の 1 期目（1 期目の見込み）は 1 つの会社で 1 回だけ。会社員（週 4 日は除く）で、まだ移っていない時だけ（転職は 3 年で 1 回まで）
      return s.j === "e" && !has(s, "switched") && !has(s, "js") && !has(s, "jx");
    case "fc_switch2":
      // 続ける（休んでから再開する）: 2 期目以降の見込み。1 つの会社で searchMax 期まで、続けて決まらないのは searchRun 期まで
      return s.j === "e" && !has(s, "switched") && (has(s, "js") || has(s, "jx")) && uses(s, "q") < w.q.searchMax && uses(s, "r") < w.q.searchRun;
    case "part":
      return s.j === "e" && !has(s, "pq");
    case "sd_grow":
      return uses(s, "g") < LIMITS.sd_grow;
    case "sd_ads":
      return feasible(w, s, kind, m0, 3) && uses(s, "a") < LIMITS.sd_ads;
    case "sd_retain":
      return feasible(w, s, kind, m0, 3) && !has(s, "rt");
    default:
      return feasible(w, s, kind, m0, 3);
  }
}

/** 結果の分け方（続ける転職活動は転職活動と同じ） */
export function driverQ(kind: string, s: St): Driver {
  return driverOf(kind === "fc_switch2" ? "fc_switch" : kind, s);
}

/**
 * 新しい会社（移った・会社員に戻った）: 週 4 日はまた聞け、この会社での転職活動の数え方も初めから。ただし転職は 3 年で 1 回まで
 * （印 switched がある間は転職活動をしない）なので、転職活動の 1 期目をまた選べるのは、独立してから会社員に戻った時だけ（会社員に戻る手が switched を外す）
 */
function newEmployer(x: { fl: string[] }): void {
  x.fl = x.fl.filter((f) => f !== "pq" && f !== "jx" && f !== "js" && !isUseFlag(f, "q") && !isUseFlag(f, "r"));
}

/** 3 か月の終わりの印を、3 か月ごとの模型の決まりで付け外しする（x はその出来事の分かれの終わりの仕事と印） */
export function quarterFlags(s0: St, kind: string, x: { j: Job; fl: string[] }): void {
  const movedNow = has(x, "switched") && !has(s0, "switched");
  if (isSearch(kind) && !movedNow) {
    // 決まらなかった転職活動: この会社での期の数と、続けて決まらなかった期の数を 1 つ増やす
    x.fl = [...new Set([...x.fl, "js", "jx"])].sort();
    setUses(x, "q", Math.min(9, uses(s0, "q") + 1));
    setUses(x, "r", Math.min(9, uses(s0, "r") + 1));
  } else {
    // ほかの手（または移った）: 続けていた転職活動は止まる
    x.fl = x.fl.filter((f) => f !== "js");
    setUses(x, "r", 0);
  }
  if (kind === "sd_grow" || kind === "sd_ads") {
    const p = kind === "sd_grow" ? "g" : "a";
    setUses(x, p, uses(s0, p) + 1);
  }
  if (kind === "sd_retain" && !has(x, "rt")) x.fl = [...x.fl, "rt"].sort();
  if (kind === "part" && x.j === "e" && !has(x, "pq")) x.fl = [...x.fl, "pq"].sort();
  if ((isSearch(kind) && movedNow) || (kind === "back_emp" && x.j === "e" && s0.j === "i")) newEmployer(x);
}
