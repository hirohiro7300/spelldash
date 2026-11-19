// 文章の組み立てのテスト用の、手で作った小さな地図（tests/unit/compose.test.ts が使う。テストの外のスクリプトからも読める）
// TREE: 今日の手 6 つ・分かれる事実・数で分かれる結果・避けたい手・まとめた手・12 段の今のまま・独立・週 4 日・学校（R2 の組み立てを移したときの地図）
// RULES: SPEC §4.2 の決まりごとの地図（まとめた行き先の中身の幅と標準の続き・確定申告の年・移った会社と戻った会社・兄弟の題・英数字の名前・道で 1 回だけ）
import type { DevTree, DevTreeNode, MapContStep, MapHeader, MapMix, MapWhy } from "../../src/deepmap/mapData";
import type { ImpactLine, ImpactSt, R3 } from "../../src/demo/impact";

// ---- 手で作った小さな地図（今日の手 6 つ・分かれる事実・数で分かれる結果・避けたい手・まとめた手・12 段の今のまま・独立・週 4 日・学校）

export const st = (o: Partial<ImpactSt> = {}): ImpactSt => ({ j: "e", pm: "?", pro: 0, mau: 40, pu: 0, seats: 0, cl: 0, fee: 0, sal: 1, cv: 1, fl: [], ...o });
const HOURS: Record<string, number> = { keep: 0, ad_permside: 4, ad_side: 5, ad_more: 6, fc_switch: 5, fc_switch2: 5, fc_push: 4, ind_quit: -2, back_emp: 0, part: 0, sd_pilot: 3, sd_school: 3, sd_retain: 3 };

export function move(k: string, kind: string, m: number, s: ImpactSt, kids: DevTreeNode[], o: Partial<DevTreeNode> = {}): DevTreeNode {
  const base: Partial<DevTreeNode> = kind === "keep" ? { base: true, why: "keep" } : { why: "best" };
  return { k, r: "a", m, st: s, kind, h: HOURS[kind] ?? 0, ...base, ...o, kids };
}
export function out(k: string, m: number, s: ImpactSt, id: string, p: number, lab: string, ln: ImpactLine | null, e: R3, rr: R3, kids: DevTreeNode[] = [], o: Partial<DevTreeNode> = {}): DevTreeNode {
  const r = m >= 36 ? "e" : "s";
  return { k, r, m, st: s, id, p, lab, line: ln ? `${lab}の線` : "（どの場合もこの道）", ln, e, rr, ...o, ...(kids.length ? { kids } : {}) };
}
/** まとめた手（今のまま）と、その先のまとめた行き先 */
export function stub(k: string, m: number, s: ImpactSt, end: ImpactSt, rr: R3): DevTreeNode {
  return move(`${k}.${m / 3}k`, "keep", m, s, [out(`${k}.${m / 3}k.all`, 36, end, "all", 100, "どの場合も", null, [70, 30, 20], rr, [], { sum: true })], { stub: true });
}
/** 36 か月目まで今のままを続ける道（状態は 3 か月ごと。最後は本当の行き先） */
export function keepChain(k: string, m: number, s: ImpactSt): DevTreeNode[] {
  const key = `${k}.${m / 3}k`;
  const s2 = st({ ...s, mau: Math.round(s.mau * 1.25), sal: m + 3 === 5 || m + 3 === 17 || m + 3 === 29 ? s.sal * 1.03 : s.sal });
  const rr: R3 = [s2.sal, 0, -0.3];
  const child = m + 3 >= 36 ? out(`${key}.all`, 36, s2, "all", 100, "どの場合も", null, [3 * s2.sal, 0, -0.9], rr) : out(`${key}.all`, m + 3, s2, "all", 100, "どの場合も", null, [3 * s2.sal, 0, -0.9], rr, keepChain(`${key}.all`, m + 3, s2));
  return [move(key, "keep", m, s, [child])];
}

const S0 = st();
const sA = st({ pm: "a", pro: 1, mau: 50.59, pu: 1.25, cl: 1, fee: 5 });
const sA2 = st({ pm: "a", pro: 1, mau: 70, pu: 3, cl: 2, fee: 5 });
const sA9 = st({ pm: "a", pro: 1, mau: 90, pu: 5, cl: 2, fee: 5 });
const sA12 = st({ pm: "a", pro: 1, mau: 110, pu: 7, cl: 2, fee: 5 });
const sA15 = st({ pm: "a", pro: 1, mau: 125, pu: 8, cl: 2, fee: 5, sal: 1.03 });
const sS = st({ pm: "s", pro: 1, mau: 50.59, pu: 1.25 });
const sN = st({ pm: "n", mau: 50.59 });
const sI1 = st({ j: "i", pro: 1, mau: 50.59, pu: 0.78, cl: 1, fee: 7 });
const sI0 = st({ j: "i", pro: 1, mau: 50.59, pu: 0.78 });

const root: DevTreeNode = {
  k: "r",
  r: "r",
  m: 0,
  st: S0,
  rr: [1, 0, -0.3],
  kids: [
    move("r.ad_permside", "ad_permside", 0, S0, [
      out("r.ad_permside.a0_a1", 3, sA, "a0_a1", 20, "全部可", ["permside", 3, null, null, "a0_a1"], [3, 3.76, -0.71], [1, 5, -0.18], [
        move("r.ad_permside.a0_a1.1ad", "ad_side", 3, sA, [
          out("r.ad_permside.a0_a1.1ad.cl2", 6, sA2, "cl2", 55, "顧客 2 社以上", ["cl", 6, 2, null], [3, 22, -0.4], [1, 10, -0.02], [
            move("r.ad_permside.a0_a1.1ad.cl2.2k", "keep", 6, sA2, [
              out("r.ad_permside.a0_a1.1ad.cl2.2k.all", 9, sA9, "all", 100, "どの場合も", null, [3, 29, 0.1], [1, 10, 0.17], [
                move("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k", "keep", 9, sA9, [
                  out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all", 12, sA12, "all", 100, "どの場合も", null, [3, 29, 0.6], [1, 10, 0.36], [
                    move("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k", "keep", 12, sA12, [
                      out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all", 15, sA15, "all", 100, "どの場合も", null, [3, 29, 0.9], [1, 10, 0.4], [
                        move("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp", "fc_push", 15, sA15, [
                          out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp.up", 18, { ...sA15, sal: 1.1 }, "up", 30, "昇格", ["sal", 18, null, null, "up"], [3.2, 29, 0.9], [1.1, 10, 0.4], [stub("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp.up", 18, { ...sA15, sal: 1.1 }, st({ pm: "a", pro: 1, mau: 900, pu: 41, cl: 1.9, fee: 5, sal: 1.16 }), [1.16, 9.1, 3.6])]),
                          out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp.same", 18, { ...sA15, sal: 1.03 }, "same", 70, "据え置き", ["sal", 18, null, null, "same"], [3.1, 29, 0.9], [1.03, 10, 0.4], [stub("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp.same", 18, { ...sA15, sal: 1.03 }, st({ pm: "a", pro: 1, mau: 880, pu: 38, cl: 1.8, fee: 5, sal: 1.09 }), [1.09, 8.9, 3.3])]),
                        ]),
                        stub("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all", 15, sA15, st({ pm: "a", pro: 1, mau: 860, pu: 37, cl: 1.8, fee: 5, sal: 1.07 }), [1.07, 9, 3.2]),
                      ]),
                    ]),
                    move("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4sr", "sd_retain", 12, sA12, [out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4sr.all", 36, st({ pm: "a", pro: 1, mau: 870, pu: 45, cl: 1.8, fee: 5, sal: 1.07 }), "all", 100, "どの場合も", null, [70, 220, 45], [1.07, 9, 3.9], [], { sum: true })], { stub: true, why: "area" }),
                  ]),
                ]),
              ]),
            ]),
            move("r.ad_permside.a0_a1.1ad.cl2.2iq", "ind_quit", 6, sA2, [
              out("r.ad_permside.a0_a1.1ad.cl2.2iq.cl3", 36, st({ j: "i", pm: "a", pro: 1, mau: 700, pu: 24, cl: 3, fee: 7 }), "cl3", 40, "顧客 3 社以上", ["cl", 9, 3, null], [0, 600, 50], [0, 18, 1.9], [], { sum: true }),
              out("r.ad_permside.a0_a1.1ad.cl2.2iq.cl2", 36, st({ j: "i", pm: "a", pro: 1, mau: 690, pu: 22, cl: 1.6, fee: 7 }), "cl2", 60, "顧客 2 社以下", ["cl", 9, null, 3], [0, 300, 40], [0, 8.2, 1.7], [], { sum: true }),
            ], { why: "avoid", stub: true }),
          ]),
          out("r.ad_permside.a0_a1.1ad.cl1", 6, st({ ...sA, mau: 66, pu: 2.4 }), "cl1", 45, "顧客 1 社以下", ["cl", 6, null, 2], [3, 15, -0.5], [1, 5, -0.07], [stub("r.ad_permside.a0_a1.1ad.cl1", 6, st({ ...sA, mau: 66, pu: 2.4 }), st({ pm: "a", pro: 1, mau: 800, pu: 30, cl: 1.2, fee: 5, sal: 1.07 }), [1.07, 6, 2.5])]),
        ]),
        stub("r.ad_permside.a0_a1", 3, sA, st({ pm: "a", pro: 1, mau: 700, pu: 25, cl: 0.8, fee: 5, sal: 1.07 }), [1.07, 4, 2]),
      ], { rv: ["pm:0", "a"] }),
      out("r.ad_permside.s", 3, sS, "s", 45, "SpellDash だけ", ["permside", 3, null, null, "s"], [3, 0, -0.71], [1, 0, -0.18], [
        move("r.ad_permside.s.1sr", "sd_retain", 3, sS, [out("r.ad_permside.s.1sr.all", 6, st({ pm: "s", pro: 1, mau: 64, pu: 3 }), "all", 100, "どの場合も", null, [3, 0, -0.4], [1, 0, -0.02], [stub("r.ad_permside.s.1sr.all", 6, st({ pm: "s", pro: 1, mau: 64, pu: 3 }), st({ pm: "s", pro: 1, mau: 900, pu: 60, sal: 1.1 }), [1.1, 0, 5.3])])]),
        stub("r.ad_permside.s", 3, sS, st({ pm: "s", pro: 1, mau: 850, pu: 50, sal: 1.1 }), [1.1, 0, 4.4]),
      ], { rv: ["pm:0", "s"] }),
      out("r.ad_permside.n", 3, sN, "n", 35, "どちらも不可", ["permside", 3, null, null, "n"], [3, 0, -0.9], [1, 0, -0.3], [
        move("r.ad_permside.n.1fw", "fc_switch", 3, sN, [
          out("r.ad_permside.n.1fw.high", 6, st({ pm: "n", mau: 62, sal: 1.18, fl: ["switched"] }), "high", 10, "大きく上げて転職", ["sal", 6, null, null, "high"], [2.68, 0, -0.9], [1.18, 0, -0.3], [stub("r.ad_permside.n.1fw.high", 6, st({ pm: "n", mau: 62, sal: 1.18, fl: ["switched"] }), st({ pm: "n", mau: 700, sal: 1.25, fl: ["switched"] }), [1.25, 0, -0.3])]),
          out("r.ad_permside.n.1fw.none", 6, st({ pm: "n", mau: 62, fl: ["js"] }), "none", 72, "転職せず", ["sal", 6, null, null, "none"], [3, 0, -0.9], [1, 0, -0.3], [
            move("r.ad_permside.n.1fw.none.2fw2", "fc_switch2", 6, st({ pm: "n", mau: 62, fl: ["js"] }), [
              out("r.ad_permside.n.1fw.none.2fw2.high_mid", 9, st({ pm: "n", mau: 75, sal: 1.13, fl: ["switched"] }), "high_mid", 13, "上げて転職", ["sal", 9, null, null, "high_mid"], [2.9, 0, -0.9], [1.13, 0, -0.3], [stub("r.ad_permside.n.1fw.none.2fw2.high_mid", 9, st({ pm: "n", mau: 75, sal: 1.13, fl: ["switched"] }), st({ pm: "n", mau: 650, sal: 1.2, fl: ["switched"] }), [1.2, 0, -0.3])]),
              out("r.ad_permside.n.1fw.none.2fw2.none", 9, st({ pm: "n", mau: 75, fl: ["js"] }), "none", 87, "転職せず", ["sal", 9, null, null, "none"], [3, 0, -0.9], [1, 0, -0.3], [stub("r.ad_permside.n.1fw.none.2fw2.none", 9, st({ pm: "n", mau: 75, fl: ["js"] }), st({ pm: "n", mau: 600, sal: 1.06 }), [1.06, 0, -0.3])]),
            ]),
          ]),
        ]),
        stub("r.ad_permside.n", 3, sN, st({ pm: "n", mau: 600, sal: 1.06 }), [1.06, 0, -0.3]),
      ], { rv: ["pm:0", "n"] }),
    ]),
    move("r.ind_quit", "ind_quit", 0, S0, [
      out("r.ind_quit.cl1", 3, sI1, "cl1", 35, "顧客 1 社", ["cl", 3, 1, 2], [1, 1, -0.82], [0, 4, -0.23], [
        move("r.ind_quit.cl1.1am", "ad_more", 3, sI1, [
          out("r.ind_quit.cl1.1am.cl2", 6, st({ ...sI1, cl: 2, mau: 62, pu: 1.6 }), "cl2", 30, "顧客 2 社以上", ["cl", 6, 2, null], [0, 24, -0.5], [0, 11, -0.15], [stub("r.ind_quit.cl1.1am.cl2", 6, st({ ...sI1, cl: 2, mau: 62, pu: 1.6 }), st({ j: "i", pro: 1, mau: 600, pu: 20, cl: 2.2, fee: 7 }), [0, 12.4, 1.6])]),
          out("r.ind_quit.cl1.1am.cl1", 6, st({ ...sI1, mau: 62, pu: 1.6 }), "cl1", 70, "顧客 1 社以下", ["cl", 6, null, 2], [0, 12, -0.5], [0, 4, -0.15], [stub("r.ind_quit.cl1.1am.cl1", 6, st({ ...sI1, mau: 62, pu: 1.6 }), st({ j: "i", pro: 1, mau: 580, pu: 18, cl: 1, fee: 7 }), [0, 4, 1.4])]),
        ]),
      ]),
      out("r.ind_quit.cl0", 3, sI0, "cl0", 65, "顧客 0 社", ["cl", 3, 0, 1], [1, -6, -0.82], [0, -3, -0.23], [
        move("r.ind_quit.cl0.1be", "back_emp", 3, sI0, [
          out("r.ind_quit.cl0.1be.e", 6, st({ pro: 1, mau: 62, pu: 1.6 }), "e", 60, "会社員に戻る", ["job", 6, null, null, "e"], [2, -2, -0.5], [1, 0, -0.15], [stub("r.ind_quit.cl0.1be.e", 6, st({ pro: 1, mau: 62, pu: 1.6 }), st({ pro: 1, mau: 700, pu: 22, sal: 1.06 }), [1.06, 0, 1.8])]),
          out("r.ind_quit.cl0.1be.i", 6, st({ ...sI0, mau: 62, pu: 1.6 }), "i", 40, "独立のまま", ["job", 6, null, null, "i"], [0, -9, -0.5], [0, -3, -0.15], [stub("r.ind_quit.cl0.1be.i", 6, st({ ...sI0, mau: 62, pu: 1.6 }), st({ j: "i", pro: 1, mau: 560, pu: 17, cl: 0.4, fee: 7 }), [0, -0.2, 1.3])]),
        ]),
      ]),
    ], { why: "avoid" }),
    move("r.part", "part", 0, S0, [
      out("r.part.p", 3, st({ j: "p", mau: 52.48 }), "p", 35, "週 4 日に", ["job", 3, null, null, "p"], [2.6, 0, -0.9], [0.8, 0, -0.3], [stub("r.part.p", 3, st({ j: "p", mau: 52.48 }), st({ j: "p", pm: "s", pro: 1, mau: 650, pu: 25, sal: 1.06 }), [0.85, 0, 2.05])]),
      out("r.part.e", 3, st({ mau: 50.59, fl: ["pq"] }), "e", 65, "認められず", ["job", 3, null, null, "e"], [3, 0, -0.9], [1, 0, -0.3], [stub("r.part.e", 3, st({ mau: 50.59, fl: ["pq"] }), st({ mau: 600, sal: 1.06, fl: ["pq"] }), [1.06, 0, -0.3])]),
    ]),
    move("r.sd_pilot", "sd_pilot", 0, S0, [
      out("r.sd_pilot.yes", 3, st({ mau: 82.99, fl: ["pilot"] }), "yes", 30, "試用が決まる", ["pilot", 3, null, null, "yes"], [3, 0, -0.9], [1, 0, -0.3], [
        move("r.sd_pilot.yes.1ss", "sd_school", 3, st({ mau: 82.99, fl: ["pilot"] }), [
          out("r.sd_pilot.yes.1ss.yes", 6, st({ pm: "s", pro: 1, mau: 130, pu: 40, seats: 40, fl: ["pilot", "school"] }), "yes", 15, "導入が決まる", ["school", 6, null, null, "yes"], [3, 0, 2.4], [1, 0, 1.2], [stub("r.sd_pilot.yes.1ss.yes", 6, st({ pm: "s", pro: 1, mau: 130, pu: 40, seats: 40, fl: ["pilot", "school"] }), st({ pm: "s", pro: 1, mau: 900, pu: 70, seats: 40, sal: 1.06, fl: ["pilot", "school"] }), [1.06, 0, 4.9])]),
          out("r.sd_pilot.yes.1ss.no", 6, st({ mau: 104, fl: ["pilot"] }), "no", 85, "見送られる", ["school", 6, null, null, "no"], [3, 0, -0.9], [1, 0, -0.3], [stub("r.sd_pilot.yes.1ss.no", 6, st({ mau: 104, fl: ["pilot"] }), st({ mau: 700, sal: 1.06, fl: ["pilot"] }), [1.06, 0, -0.3])]),
        ]),
      ]),
      out("r.sd_pilot.no", 3, st({ mau: 50.59 }), "no", 70, "見つからず", ["pilot", 3, null, null, "no"], [3, 0, -0.9], [1, 0, -0.3], [stub("r.sd_pilot.no", 3, st({ mau: 50.59 }), st({ mau: 600, sal: 1.06 }), [1.06, 0, -0.3])]),
    ]),
    move("r.keep", "keep", 0, S0, [out("r.keep.all", 3, st({ mau: 50 }), "all", 100, "どの場合も", null, [3, 0, -0.9], [1, 0, -0.3], keepChain("r.keep.all", 3, st({ mau: 50 })))]),
  ],
};

// 組み立ては header の anchor・horizon と、束に無い手の種類の名前（kinds）だけを読む
export const header: MapHeader = { v: 3, kind: "impact3y", title: "t", anchor: "2026-11", horizon: 36, annual: 360, release: 0, hash: "test", textVersion: "test", kinds: {}, fams: {}, premises: [], never: {}, counts: { nodes: 0, decisions: 0, options: 0, forks: 0, ends: 0, sumEnds: 0 } };
export const TREE: DevTree = { header, root };


// ---- RULES: SPEC §4.2 の決まりごとを確かめる地図

/** その状態の時点の月の稼ぎ（給与の倍率・広告運用・SpellDash。計算の決まりと同じ形） */
export const rrOf = (s: ImpactSt): R3 => [s.j === "i" ? 0 : s.j === "p" ? 0.8 * s.sal : s.sal, s.cl * s.fee - (s.j === "i" ? 3 : 0), s.pro ? s.pu * 0.094 - 0.3 : -0.3];

/** 1 本の道の 1 歩: 手の種類と結果（結果の名前を付けなければ「どの場合も」） */
export interface Step {
  kind: string;
  to: ImpactSt;
  id?: string;
  p?: number;
  lab?: string;
  ln?: ImpactLine | null;
  /** その 3 か月の稼ぎ（無ければ給与 3 か月分と、SpellDash のサーバー代） */
  e?: R3;
  why?: MapWhy;
  /** 同じ手のほかの結果（兄弟。m は結果の月、key は手の鍵） */
  others?: (m: number, key: string) => DevTreeNode[];
  /** 同じ判断のほかの手（m は手の月、key は判断の鍵） */
  alts?: (m: number, key: string) => DevTreeNode[];
  /** 結果のほかの値（幅 band など） */
  o?: Partial<DevTreeNode>;
}

/** 手と結果を交互に並べた 1 本の道。最後の結果が 36 か月目なら行き先、そうでなければ状態で止まる。先頭の手を返す */
export function line(key: string, m: number, from: ImpactSt, steps: Step[]): DevTreeNode {
  const [s, ...rest] = steps;
  if (!s) throw new Error("空の道");
  const mk = `${key}.${m / 3}${s.kind}`;
  const id = s.id ?? "all";
  const ok = `${mk}.${id}`;
  const kids = rest.length ? [line(ok, m + 3, s.to, rest), ...(rest[0]!.alts?.(m + 3, ok) ?? [])] : [];
  const o = out(ok, m + 3, s.to, id, s.id ? (s.p ?? 60) : 100, s.lab ?? (s.id ? id : "どの場合も"), s.ln ?? null, s.e ?? [3 * rrOf(s.to)[0], 0, -0.9], rrOf(s.to), kids, s.o ?? {});
  return move(mk, s.kind, m, from, [o, ...(s.others?.(m + 3, mk) ?? [])], s.why ? { why: s.why } : {});
}

/** n 回続ける今のまま（どの場合も同じ状態 to。稼ぎは e） */
export const keeps = (n: number, to: ImpactSt, e?: R3): Step[] => Array.from({ length: n }, () => ({ kind: "keep", to, ...(e ? { e } : {}) }));

const sPA = st({ pm: "a", pro: 1, mau: 50, pu: 1, cl: 1, fee: 5 });
const sPS = st({ pm: "s", pro: 1, mau: 50, pu: 2 });
const sPN = st({ pm: "n", mau: 50 });
const sInd = st({ j: "i", pm: "a", pro: 1, mau: 50, pu: 1, cl: 1, fee: 7 });

/** 中身の幅: 9 割がそろう（会社員・全部可・Pro あり） */
export const MIX_SURE: MapMix = { j: { e: 0.95, p: 0, i: 0.05 }, pm: { "?": 0.02, a: 0.93, s: 0.05, n: 0 }, pro: 0.97, switched: 0.04, school: 0, cl: [1, 2, 2], pu: [22.4, 35, 48.6], mau: [610.2, 880, 1210.7], sal: [1.03, 1.07, 1.12] };
/** 中身の幅: そろわない（会社員と独立・答えも分かれる。顧客の幅は端数） */
export const MIX_SPLIT: MapMix = { j: { e: 0.6, p: 0.05, i: 0.35 }, pm: { "?": 0.3, a: 0.3, s: 0.25, n: 0.15 }, pro: 0.55, switched: 0.3, school: 0.2, cl: [0, 1, 2.6], pu: [0, 12, 40.2], mau: [300, 700, 1500], sal: [1, 1.1, 1.25] };
/** 標準の続き: 今のまま 3 期 → 転職活動 → 続き（転職）→ 昇格狙い（昇格）→ 今のまま → 副業（1 社目）→ 今のまま… */
export const CONT_A: MapContStep[] = [
  { m: 3, kind: "keep" },
  { m: 6, kind: "keep" },
  { m: 9, kind: "keep" },
  { m: 12, kind: "fc_switch" },
  { m: 15, kind: "fc_switch2", ev: "SWITCH_HIGH" },
  { m: 18, kind: "fc_push", ev: "PROMO" },
  { m: 21, kind: "keep" },
  { m: 24, kind: "ad_side", ev: "FIRST_CLIENT" },
  { m: 27, kind: "keep" },
  { m: 30, kind: "keep" },
  { m: 33, kind: "keep" },
];
/** 中身の幅: 大きな事実が無い（題は遊ぶ人で言い、年収では言わない。code-1） */
export const MIX_MAU: MapMix = { j: { e: 0.85, p: 0, i: 0.15 }, pm: { "?": 0.8, a: 0.1, s: 0.1, n: 0 }, pro: 0.05, switched: 0.2, school: 0, cl: [0, 0, 0.3], pu: [0, 0, 2], mau: [1079, 1279, 1479], sal: [0, 1.05, 1.12] };
/** 中身の幅: 独立した後、多くの道で会社員に戻る */
export const MIX_BACK: MapMix = { j: { e: 0.8, p: 0, i: 0.2 }, pm: { "?": 0.05, a: 0, s: 0.95, n: 0 }, pro: 0.95, switched: 0, school: 0, cl: [0, 0, 1], pu: [20, 30, 41], mau: [650, 700, 760], sal: [0, 1.05, 1.08] };
/** 標準の続き: 紹介での顧客探しが続いた後、2029 年 5 月に会社員に戻る（長いので途中を「ほか N 期」にまとめても、戻る期は残す） */
export const CONT_BACK: MapContStep[] = [
  { m: 3, kind: "ad_more" },
  { m: 6, kind: "ad_side", ev: "CLIENT_UP" },
  { m: 9, kind: "ad_more" },
  { m: 12, kind: "sd_grow" },
  { m: 15, kind: "ad_more", ev: "CLIENT_LOST" },
  { m: 18, kind: "sd_grow" },
  { m: 21, kind: "ad_side" },
  { m: 24, kind: "sd_retain" },
  { m: 27, kind: "ad_more" },
  { m: 30, kind: "back_emp", ev: "BACK_EMP" },
  { m: 33, kind: "keep" },
];
/** 標準の続き: 束にも地図にも名前の無い手と出来事を含む（英数字の名前を出さない） */
export const CONT_B: MapContStep[] = [
  { m: 3, kind: "sd_grow" },
  { m: 6, kind: "zz_new", ev: "ZZ_EVENT" },
  { m: 9, kind: "keep" },
];

/** まとめた手（stub）と、その先のまとめた行き先 1 つ */
function sumMove(k: string, kind: string, s: ImpactSt, end: ImpactSt, rr: R3, o: Partial<DevTreeNode>): DevTreeNode {
  return move(k, kind, 0, s, [out(`${k}.all`, 36, end, "all", 100, "どの場合も", null, [70, 30, 20], rr, [], { sum: true, ...o })], { stub: true });
}

const RULES_ROOT: DevTreeNode = {
  k: "r",
  r: "r",
  m: 0,
  st: S0,
  rr: [1, 0, -0.3],
  kids: [
    // 確定申告: 副業の所得が年 20 万円を大きく超える（2027 年分・2028 年分）。暦と 4 月・住民税は道で 1 回だけ
    line("r.tax", 0, S0, [{ kind: "ad_permside", to: sPA, id: "a0_a1", lab: "全部可", ln: ["permside", 3, null, null, "a0_a1"], e: [3, 3.76, -0.71] }, ...keeps(11, sPA, [3, 15, 0.3])]),
    // 確定申告: 所得が 20 万円以下（住民税の申告だけ）
    line("r.low", 0, S0, [{ kind: "sd_permpro", to: sPS, id: "s", lab: "SpellDash だけ", ln: ["perm", 3, null, null, "s"], e: [3, 0, 0.3] }, ...keeps(4, sPS, [3, 0, 1.5])]),
    // 確定申告: 所得が 20 万円の近く（超えるなら申告）
    line("r.near", 0, S0, [{ kind: "sd_retain", to: sPS, e: [3, 0, 3.3] }, ...keeps(4, sPS, [3, 0, 6.6])]),
    // 独立（2027 年 1 月から）: 2026 年分は給与だけなので独立の申告は書かない。2027 年分は独立の申告。住民税は前の年の給与で決まる
    line("r.ind", 0, S0, [{ kind: "ind_quit", to: sInd, id: "cl1", lab: "顧客 1 社", ln: ["cl", 3, 1, 2], e: [1, 1, -0.82] }, ...keeps(5, sInd, [0, 12, 0.3])]),
    // 辞めた年（2027 年 4 月から独立）: 給与と独立してからの売上を一緒に
    line("r.quit", 0, S0, [{ kind: "fc_scope", to: st({ mau: 50, fl: ["scope"] }) }, { kind: "ind_quit", to: sInd, id: "cl1", lab: "顧客 1 社", ln: ["cl", 6, 1, 2], e: [1, 1, -0.82] }, ...keeps(3, sInd, [0, 12, 0.3])]),
    // 戻った年（2027 年 5 月に会社員へ）: 独立していた間の売上と戻った会社の給与を一緒に
    line("r.back", 0, S0, [
      { kind: "sd_grow", to: st({ mau: 60 }) },
      { kind: "ind_quit", to: st({ j: "i", pm: "a", pro: 1, mau: 70, pu: 1 }), id: "cl0", lab: "顧客 0 社", ln: ["cl", 6, 0, 1], e: [0, -9, -0.8] },
      { kind: "back_emp", to: st({ pm: "s", pro: 1, mau: 80, pu: 2 }), id: "e", lab: "会社員に戻る", ln: ["job", 9, null, null, "e"], e: [1, -6, -0.5] },
      ...keeps(2, st({ pm: "s", pro: 1, mau: 90, pu: 2 }), [3, 0, -0.5]),
    ]),
    // 移った会社: 全部可のまま移る（顧客も続く）
    line("r.carry", 0, S0, [{ kind: "ad_permside", to: st({ ...sPA, cl: 2 }), id: "a0_a1", lab: "全部可", ln: ["permside", 3, null, null, "a0_a1"] }, { kind: "fc_switch", to: st({ ...sPA, cl: 2, sal: 1.18, fl: ["switched"] }), id: "high", lab: "大きく上げて転職", ln: ["sal", 6, null, null, "high"] }]),
    // 移った会社: SpellDash だけ可のまま移る
    line("r.keeps", 0, S0, [{ kind: "sd_permpro", to: sPS, id: "s", lab: "SpellDash だけ", ln: ["perm", 3, null, null, "s"] }, { kind: "fc_switch", to: st({ ...sPS, sal: 1.08, fl: ["switched"] }), id: "mid", lab: "少し上げて転職", ln: ["sal", 6, null, null, "mid"] }]),
    // 移った会社: どちらも不可から移る（出し直す）
    line("r.refile", 0, S0, [{ kind: "sd_permpro", to: sPN, id: "n", lab: "どちらも不可", ln: ["perm", 3, null, null, "n"] }, { kind: "fc_switch", to: st({ mau: 60, sal: 1.18, fl: ["switched"] }), id: "high", lab: "大きく上げて転職", ln: ["sal", 6, null, null, "high"] }]),
    // 移った会社: まだ届け出ていない（初めて出す）。結果の名前が英数字（high_mid）・空（none）でも、日本語で書く
    line("r.first", 0, S0, [
      {
        kind: "fc_switch",
        to: st({ mau: 50, sal: 1.13, fl: ["switched"] }),
        id: "high_mid",
        lab: "high_mid",
        ln: ["sal", 3, null, null, "high_mid"],
        others: (m, k) => [out(`${k}.none`, m, st({ mau: 50, fl: ["js"] }), "none", 72, "", ["sal", 3, null, null, "none"], [3, 0, -0.9], [1, 0, -0.3])],
      },
    ]),
    // 移った会社: 顧客を引き継ぎ先に渡して移る（離れた顧客とは言わない）
    line("r.handover", 0, S0, [{ kind: "ad_permside", to: st({ ...sPA, cl: 2 }), id: "a0_a1", lab: "全部可", ln: ["permside", 3, null, null, "a0_a1"] }, { kind: "fc_switch", to: st({ pm: "?", pro: 1, mau: 50, pu: 1, sal: 1.08, fl: ["switched"] }), id: "mid", lab: "少し上げて転職", ln: ["sal", 6, null, null, "mid"] }]),
    // 戻った会社: SpellDash だけを認める会社（届け出なし）・顧客は引き継ぎ先へ。届け出の答えの出来事は書かない
    line("r.sonly", 0, S0, [{ kind: "ind_quit", to: st({ ...sInd, cl: 2 }), id: "cl2", lab: "顧客 2 社", ln: ["cl", 3, 2, null] }, { kind: "back_emp", to: st({ pm: "s", pro: 1, mau: 50, pu: 1 }), id: "e", lab: "会社員に戻る", ln: ["job", 6, null, null, "e"] }]),
    // 戻った会社: 届け出は出し直す
    line("r.backrefile", 0, S0, [{ kind: "ind_quit", to: sInd, id: "cl1", lab: "顧客 1 社", ln: ["cl", 3, 1, 2] }, { kind: "back_emp", to: st({ pm: "?", pro: 1, mau: 50, pu: 1 }), id: "e", lab: "会社員に戻る", ln: ["job", 6, null, null, "e"] }]),
    // 届け出る手でないのに答えが変わった（届け出の答えの出来事は書かない）
    line("r.nofile", 0, S0, [{ kind: "fc_scope", to: st({ pm: "s", mau: 50, fl: ["scope"] }) }]),
    // 題: 事例の分かれ（どちらも顧客が 1 社減る）。題は事例を言い、兄弟で違う
    line("r.pf", 0, S0, [
      { kind: "ad_permside", to: st({ ...sPA, cl: 2 }), id: "a0_a1", lab: "全部可", ln: ["permside", 3, null, null, "a0_a1"] },
      { kind: "ad_portfolio", to: st({ ...sPA, cl: 1, fl: ["portfolio"] }), id: "yes", lab: "実績ができる", ln: ["portfolio", 6, null, null, "yes"], others: (m, k) => [out(`${k}.no`, m, st({ ...sPA, cl: 1 }), "no", 20, "成果が出ず", ["portfolio", 6, null, null, "no"], [3, 5, -0.9], rrOf(st({ ...sPA, cl: 1 })))] },
    ]),
    // 題: 有料会員の数の分かれ（どちらも顧客が 1 社減る）。題は有料会員の数を言う
    line("r.pu", 0, S0, [
      { kind: "ad_permside", to: st({ ...sPA, cl: 2, pu: 25 }), id: "a0_a1", lab: "全部可", ln: ["permside", 3, null, null, "a0_a1"] },
      { kind: "keep", to: st({ ...sPA, cl: 1, pu: 35 }), id: "pu30", lab: "有料 30 人以上", ln: ["pu", 6, 30, null], others: (m, k) => [out(`${k}.pu0`, m, st({ ...sPA, cl: 1, pu: 22 }), "pu0", 40, "有料 29 人以下", ["pu", 6, null, 30], [3, 5, -0.9], rrOf(st({ ...sPA, cl: 1, pu: 22 })))] },
    ]),
    // 題: 3 年後の行き先が同じ数に丸まる兄弟（結果の名前で言い分ける）。道で 1 回だけの文もこの長い道で確かめる
    line("r.ends", 0, S0, [
      ...keeps(11, sPS, [3, 0, 0.3]),
      { kind: "keep", to: st({ ...sPS, pu: 33 }), id: "pu30", lab: "有料 30 人以上", ln: ["pu", 36, 30, null], others: (m, k) => [out(`${k}.pu0`, m, st({ ...sPS, pu: 32.8 }), "pu0", 40, "有料 29 人以下", ["pu", 36, null, 30], [3, 0, 0.2], rrOf(st({ ...sPS, pu: 32.8 })))] },
    ]),
    // 題: 名前の無い手が 2 つ並ぶ（番号で言い分ける）・転職活動が続いて決まらない（辞める前の文と助言は道で 1 回だけ）
    line("r.search", 0, S0, [
      { kind: "keep", to: st({ mau: 50 }) },
      {
        kind: "fc_switch",
        to: st({ mau: 60, fl: ["js"] }),
        id: "none",
        lab: "転職せず",
        ln: ["sal", 6, null, null, "none"],
        alts: (m, k) => [move(`${k}.${m / 3}zza`, "zz_a", m, st({ mau: 50 }), [out(`${k}.${m / 3}zza.all`, m + 3, st({ mau: 55 }), "all", 100, "どの場合も", null, [3, 0, -0.9], [1, 0, -0.3], [move(`${k}.${m / 3}zza.all.${m / 3 + 1}k`, "keep", m + 3, st({ mau: 55 }), [out(`${k}.${m / 3}zza.all.${m / 3 + 1}k.all`, m + 6, st({ mau: 60 }), "all", 100, "どの場合も", null, [3, 0, -0.9], [1, 0, -0.3])])])]), move(`${k}.${m / 3}zzb`, "zz_b", m, st({ mau: 50 }), [out(`${k}.${m / 3}zzb.all`, m + 3, st({ mau: 55 }), "all", 100, "どの場合も", null, [3, 0, -0.9], [1, 0, -0.3])])],
      },
      { kind: "fc_switch2", to: st({ mau: 70, fl: ["js"] }), id: "none", lab: "転職せず", ln: ["sal", 9, null, null, "none"] },
      { kind: "fc_switch2", to: st({ mau: 80, fl: ["js"] }), id: "none", lab: "転職せず", ln: ["sal", 12, null, null, "none"] },
      { kind: "fc_switch2", to: st({ mau: 90, fl: ["js"] }), id: "none", lab: "転職せず", ln: ["sal", 15, null, null, "none"] },
      ...keeps(7, st({ mau: 100, fl: ["js"] })),
    ]),
    // まとめた結果（facts-1・reader-3・reader-9）: 昇格と据え置きをまとめた結果・社数の違う場合をまとめた顧客探し（幅）・幅のまま進む今のまま
    line("r.merge", 0, S0, [
      { kind: "keep", to: st({ pm: "a", pro: 1, mau: 50, pu: 1, cl: 1, fee: 3 }) },
      { kind: "fc_push", to: st({ pm: "a", pro: 1, mau: 55, pu: 1, cl: 1, fee: 3, sal: 1.0516 }) },
      { kind: "ad_side", to: st({ pm: "a", pro: 1, mau: 60, pu: 2, cl: 1.55, fee: 3, sal: 1.0516 }), o: { band: { cl: [1, 2] } } },
      { kind: "keep", to: st({ pm: "a", pro: 1, mau: 65, pu: 2, cl: 1.4, fee: 3, sal: 1.0516 }), o: { band: { cl: [1, 2] } } },
    ]),
    // 次の顧客の月額（facts-2）: 週 4 日で顧客が 4 社に届いた後に増える顧客は月 5 万円。学校の 2 校目は 40 席が加わる（facts-3）
    line("r.fee", 0, S0, [
      { kind: "part", to: st({ j: "p", pm: "a", pro: 1, mau: 50, pu: 2, cl: 4, fee: 3 }), id: "p", lab: "週 4 日に", ln: ["job", 3, null, null, "p"] },
      { kind: "keep", to: st({ j: "p", pm: "a", pro: 1, mau: 55, pu: 2, cl: 3, fee: 3 }) },
      { kind: "ad_side", to: st({ j: "p", pm: "a", pro: 1, mau: 60, pu: 3, cl: 4, fee: 3.5, seats: 40, fl: ["school"] }), id: "cl4", lab: "顧客 4 社", ln: ["cl", 9, 4, null], others: (m, k) => [out(`${k}.cl3`, m, st({ j: "p", pm: "a", pro: 1, mau: 60, pu: 3, cl: 3, fee: 3, seats: 40, fl: ["school"] }), "cl3", 45, "顧客 3 社", ["cl", 9, null, 4], [2.4, 9, 0.3], rrOf(st({ j: "p", pm: "a", pro: 1, mau: 60, pu: 3, cl: 3, fee: 3 })))] },
      { kind: "sd_school", to: st({ j: "p", pm: "a", pro: 1, mau: 70, pu: 83, cl: 4, fee: 3.5, seats: 80, fl: ["school"] }), id: "yes", lab: "導入が決まる", ln: ["school", 12, null, null, "yes"], others: (m, k) => [out(`${k}.no`, m, st({ j: "p", pm: "a", pro: 1, mau: 70, pu: 43, cl: 4, fee: 3.5, seats: 40, fl: ["school"] }), "no", 85, "見送られる", ["school", 12, null, null, "no"], [2.4, 14, 3], rrOf(st({ j: "p", pm: "a", pro: 1, mau: 70, pu: 43, cl: 4, fee: 3.5, seats: 40 })))] },
    ]),
    // 確定申告（facts-4）: 11 月までの所得は線の 7 割（14 万円）に届かないが、12 月の稼ぎを足すと届く（「要らない」と言い切らない）
    line("r.dec", 0, S0, [{ kind: "sd_permpro", to: st({ pm: "s", pro: 1, mau: 50, pu: 30 }), id: "s", lab: "SpellDash だけ", ln: ["perm", 3, null, null, "s"], e: [3, 0, 0.3] }, ...keeps(4, st({ pm: "s", pro: 1, mau: 50, pu: 30 }), [3, 0, 3.9])]),
    // 節目の月（facts-7）: 9 か月目に転職を言う状態は「大きな節目はまだ無い」と言わない
    line("r.since", 0, S0, [...keeps(2, st({ mau: 50 })), { kind: "fc_switch", to: st({ mau: 60, sal: 1.18, fl: ["switched"] }), id: "high", lab: "大きく上げて転職", ln: ["sal", 9, null, null, "high"] }, ...keeps(1, st({ mau: 70, sal: 1.18, fl: ["switched"] }))]),
    // まとめた行き先: 中身の幅がそろう・そろわない・幅が無い（平均）。標準の続きの目安
    sumMove("r.mix", "keep", S0, st({ pm: "a", pro: 1, mau: 880, pu: 35, cl: 1.6, fee: 5, sal: 1.07 }), [1.07, 8, 3], { mix: MIX_SURE, cont: CONT_A }),
    sumMove("r.mixb", "sd_grow", S0, st({ pm: "?", pro: 1, mau: 700, pu: 13.4, cl: 1.3, fee: 5, sal: 1.1, seats: 8 }), [0.8, 5, 1], { mix: MIX_SPLIT, cont: CONT_B }),
    sumMove("r.avg", "sd_pilot", S0, st({ pm: "n", pro: 1, mau: 900, pu: 41.3, cl: 1.31, fee: 5, sal: 1.09, seats: 3 }), [1.09, 6.6, 3.6], { cont: CONT_A }),
    // 題が年収で変わらない（code-1）: 大きな事実の無い中身の幅（独立は 9 割未満・顧客の上が 0・Pro はほぼ無い・遊ぶ人は 4 桁）
    sumMove("r.mau", "sd_grow", S0, st({ mau: 1300, sal: 1.05 }), [1.05, 0, -0.3], { mix: MIX_MAU }),
    // 標準の続きを短くするときも、会社員に戻る期を残す（facts-9）
    sumMove("r.contback", "ind_quit", S0, st({ pm: "s", pro: 1, mau: 700, pu: 30, sal: 1.05 }), [1.05, 0, 2.5], { mix: MIX_BACK, cont: CONT_BACK }),
    // 中身の同じまとめた行き先の兄弟（reader-5）: 違うのはこの 3 か月の結果と、そこからの稼ぎの合計
    move("r.twins", "ind_quit", 0, S0, [
      out("r.twins.cl0", 36, st({ pm: "s", pro: 1, mau: 700, pu: 30, sal: 1.05 }), "cl0", 60, "顧客 0 社", ["cl", 3, null, 1], [28, -6, 20], [1.05, 0, 2.5], [], { sum: true, mix: MIX_BACK, cont: CONT_BACK }),
      out("r.twins.cl1", 36, st({ pm: "s", pro: 1, mau: 700, pu: 30, sal: 1.05 }), "cl1", 40, "顧客 1 社", ["cl", 3, 1, null], [28, 9, 20], [1.05, 0, 2.5], [], { sum: true, mix: MIX_BACK, cont: CONT_BACK }),
    ], { stub: true, why: "avoid" }),
  ],
};

/** SPEC §4.2 の決まりごとの地図（名前の無い手 zz_a・zz_b は header.kinds にも無い） */
export const RULES: DevTree = { header, root: RULES_ROOT };
