// 作った木を、開発用の入れ子の木（src/deepmap/mapData.ts の DevTree）にする。src/deepmap/dev/fromTree.ts が読むだけの地図にする。
// 並べる順と、確かめるだけの事実（rv: 会社の答えは会社ごとに 1 つ）は R1 の試作（model-tree/bundleq.ts の toBundle）と同じ。
// 結果の名前（lab）・線の文（line）・判断の線（ln）は計算の結果のまま（../group.ts の describe）。文章（title・short など）はまだ入れない

import { IMPACT_TITLE, type ImpactLine, type ImpactSt, type R3 } from "../../../src/demo/impact";
import type { DevTree, DevTreeNode, MapHeader } from "../../../src/deepmap/mapData";
import type { Line } from "../group";
import { runRate, type St, type Vec3 } from "../sim";
import { Wsum } from "./core";
import { rollbackApp, type QNode } from "./gen";
import { H, type WorldQ } from "./world";

export interface DevTreeOpts {
  /** 0 か月目の年月 "YYYY-MM" */
  anchor: string;
  /** 版の順番（開発用の木は 0） */
  release: number;
  hash: string;
  textVersion: string;
}

const lnOut = (l: Line): ImpactLine => (l.cat !== undefined ? [l.metric, l.at, l.lo, l.hi, l.cat] : [l.metric, l.at, l.lo, l.hi]);
const stOut = (s: St): ImpactSt => ({ j: s.j, pm: s.pm, pro: s.pro, mau: s.mau, pu: s.pu, seats: s.seats, cl: s.cl, fee: s.fee, sal: s.sal, cv: s.cv, fl: [...s.fl] });
const r3 = (v: Vec3): R3 => [v[0], v[1], v[2]];

/** 会社の番号（今日の会社が 0）: 道の上で、転職した・独立から会社員に戻ったたびに 1 増える（toBundle と同じ数え方） */
export function employerOf(n: QNode): number {
  const path: QNode[] = [];
  for (let x: QNode | null = n; x; x = x.parent) path.push(x);
  path.reverse();
  let k = 0;
  let prev: St | null = null;
  for (const x of path) {
    if (x.role === "s" || x.role === "e" || x.role === "r") {
      if (prev && ((x.st.fl.includes("switched") && !prev.fl.includes("switched")) || (prev.j === "i" && x.st.j !== "i"))) k++;
      prev = x.st;
    }
  }
  return k;
}

/** 子を並べる順（toBundle と同じ。V は生成の年収での後ろからの値）: 判断の手は今のままを最後にして値の大きい順、手の結果は（線の稼ぎ + その先の値）の大きい順 */
export function displayOrder(n: QNode, S: number): QNode[] {
  if (n.role === "r" || n.role === "s") return [...n.kids].sort((a, b) => Number(a.kind === "keep") - Number(b.kind === "keep") || b.V - a.V);
  if (n.role === "a") return [...n.kids].sort((a, b) => Wsum(b.r!, S) + b.V - (Wsum(a.r!, S) + a.V));
  return n.kids;
}

/** 開発用の入れ子の木。値は生成の年収（world.annual）で後ろから出し直してから並べる */
export function toDevTree(w: WorldQ, root: QNode, opts: DevTreeOpts): DevTree {
  const S = w.annual / 12;
  rollbackApp(root, S);
  const counts: MapHeader["counts"] = { nodes: 0, decisions: 0, options: 0, forks: 0, ends: 0, sumEnds: 0 };
  const visit = (n: QNode): DevTreeNode => {
    const kids = displayOrder(n, S);
    counts.nodes++;
    if (kids.length >= 2) counts.forks++;
    if ((n.role === "r" || n.role === "s") && kids.length >= 2) counts.decisions++;
    const d: DevTreeNode = { k: n.key, r: n.role, m: n.m, st: stOut(n.st) };
    if (n.role === "r") d.rr = runRate(w, n.st);
    else if (n.role === "a") {
      counts.options++;
      d.kind = n.kind!;
      d.h = w.kinds[n.kind!]!.hours;
      if (n.kind === "keep") d.base = true;
      // 今日の決まった 10 手（menu）には訳を付けない
      if (n.why && n.why !== "menu") d.why = n.why;
      if (n.stub) d.stub = true;
    } else {
      const o = n.out!;
      d.rr = r3(n.rr ?? runRate(w, n.st));
      d.id = o.id;
      d.p = o.p;
      d.lab = o.lab;
      d.line = o.line;
      d.ln = lnOut(o.ln);
      d.e = r3(n.r!);
      // 会社の答えを知る結果: [会社の番号, 答え]。番号はその手を選んだ判断までの道で数える。
      // 答えはその 3 か月の終わりの答え（まとめた行き先でも、36 か月目の代表の状態の答えではない）
      if ((o.ln.metric === "perm" || o.ln.metric === "permside") && n.parent?.parent) d.rv = [`pm:${employerOf(n.parent.parent)}`, n.sumEnd ? o.st.pm : n.st.pm];
      if (n.role === "e") {
        counts.ends++;
        if (n.sumEnd) {
          d.sum = true;
          counts.sumEnds++;
        }
      }
    }
    if (kids.length) d.kids = kids.map(visit);
    return d;
  };
  const top = visit(root);
  const kinds: MapHeader["kinds"] = {};
  for (const [k, d] of Object.entries(w.kinds)) kinds[k] = [d.label, d.area, d.family, [...d.scen]];
  const header: MapHeader = {
    v: 3,
    kind: "impact3y",
    title: IMPACT_TITLE,
    anchor: opts.anchor,
    horizon: H,
    annual: w.annual,
    release: opts.release,
    hash: opts.hash,
    textVersion: opts.textVersion,
    kinds,
    fams: { ...(w.familyLabels ?? {}) },
    premises: [...w.premises],
    never: {},
    counts,
  };
  return { header, root: top };
}
