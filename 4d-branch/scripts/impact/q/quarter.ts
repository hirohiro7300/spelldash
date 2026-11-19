// 3 か月の手の計算: 元の計算（../sim.ts の simulate・../group.ts の groupOutcomes。変えない）の前後に、3 か月ごとの模型の決まりを足す。
// R1 の試作（model-tree/simq.ts）を移した物で、計算は同じ。状態の印（fl）に足す物:
//   js 転職活動をしている（続けるなら fc_switch2）・jx この会社で転職活動をした・pq この会社で週 4 日を断られた
//   g1〜g4 遊ぶ人を増やすを使った期の数・a1〜a4 広告で集めるを使った期の数・rt 続ける人を増やすを使った

import { driverOf, feasible, simulate, type Driver, type Sample, type St } from "../sim";
import type { WorldQ } from "./world";

const has = (s: St, f: string) => s.fl.includes(f);
const addFlag = (s: St, f: string) => {
  if (!s.fl.includes(f)) s.fl = [...s.fl, f].sort();
};
const dropFlag = (s: St, f: string) => {
  s.fl = s.fl.filter((x) => x !== f);
};
/** 使った期の数の印（g1・a3 など） */
const isUseFlag = (f: string, p: string) => f.length === 2 && f[0] === p && /[1-9]/.test(f[1]!);

/** 伸びが積み上がる手を使った期の数（印 gN・aN。p は g か a） */
export function uses(s: St, p: string): number {
  const f = s.fl.find((x) => isUseFlag(x, p));
  return f ? Number(f[1]) : 0;
}

/** 3 年で使える期の数の上限（続ける人を増やすは印 rt で 1 回だけ） */
export const LIMITS = { sd_grow: 4, sd_ads: 4, sd_retain: 1 } as const;

/** その手が今の状態で選べるか（元の決まりに、3 か月ごとの模型の決まりを足す） */
export function feasibleQ(w: WorldQ, s: St, kind: string, m0: number): boolean {
  switch (kind) {
    case "fc_switch":
      // 転職活動の 1 期目（1 期目の見込み）は 1 つの会社で 1 回だけ
      return feasible(w, s, kind, m0, 3) && !has(s, "js") && !has(s, "jx");
    case "fc_switch2":
      // 続ける（休んでから再開する）: 2 期目以降の見込み
      return s.j === "e" && !has(s, "switched") && (has(s, "js") || has(s, "jx"));
    case "part":
      return s.j === "e" && !has(s, "pq");
    case "sd_pro":
      return false;
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

/** 続ける転職活動の世界: 転職活動の 3 か月の見込み（pHigh3・pMid3）を 2 期目以降の見込みにした写し（世界ごとに 1 つ） */
const continuing = new WeakMap<WorldQ, WorldQ>();
function worldFor(w: WorldQ, kind: string): WorldQ {
  if (kind !== "fc_switch2") return w;
  const hit = continuing.get(w);
  if (hit) return hit;
  const sw = w.kinds.fc_switch!;
  const w2: WorldQ = { ...w, kinds: { ...w.kinds, fc_switch: { ...sw, p: { ...sw.p, pHigh3: w.qSwitch2.pHigh, pMid3: w.qSwitch2.pMid } } } };
  continuing.set(w, w2);
  return w2;
}

/** 状態 s0 から m0 か月目に手 kind を 3 か月たどった数え上げ（印は 3 か月ごとの模型の決まりで付け外しする） */
export function simQ(w: WorldQ, s0: St, kind: string, m0: number): Sample[] {
  const k = kind === "fc_switch2" ? "fc_switch" : kind;
  const out = simulate(worldFor(w, kind), s0, k, m0, 3);
  const search = kind === "fc_switch" || kind === "fc_switch2";
  for (const smp of out) {
    const x = smp.x;
    if (search && !has(x, "switched")) {
      addFlag(x, "js");
      addFlag(x, "jx");
    } else dropFlag(x, "js");
    if (kind === "sd_grow" || kind === "sd_ads") {
      const p = kind === "sd_grow" ? "g" : "a";
      const n = uses(s0, p);
      x.fl = x.fl.filter((f) => !isUseFlag(f, p));
      addFlag(x, `${p}${n + 1}`);
    }
    if (kind === "sd_retain") addFlag(x, "rt");
    if (kind === "part" && x.j === "e") addFlag(x, "pq");
    // 新しい会社（この期に移った・会社員に戻った）: 週 4 日も転職活動の 1 期目も、また聞ける
    if (search && has(x, "switched") && !has(s0, "switched")) {
      dropFlag(x, "pq");
      dropFlag(x, "jx");
      dropFlag(x, "js");
    }
    if (kind === "back_emp" && x.j === "e") {
      dropFlag(x, "pq");
      dropFlag(x, "jx");
    }
  }
  return out;
}
