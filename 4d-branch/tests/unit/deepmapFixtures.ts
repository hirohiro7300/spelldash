// 計算の芯（src/deepmap/core）のテスト用の地図と、アプリの計算（computeImpact）で同じ地図を数えるための道具
//   handTree()            手で作った小さな地図（事実を知る手・同じ値の手・% の合計が 99・0% の結果・遅れて始まる手・
//                         36 か月目より前の行き先・まとめた手と mix・cont・ずっと今のままの 3 段・q・never）
//   randomTree(seed)      種から作る地図（深さ・手の数・同じ値の手・選べない手の組み合わせを広く当てる）
//   toBundle(map)         MapData → 今日の同梱データの形（v2 ImpactBundle）。テスト専用（作業メモ model-tree/bundleq.ts の toBundle と同じ考え）
//   bundleToDevTree(b)    今日の同梱データ（1,533 枚）→ 開発用の入れ子の木
//   appImpact(...)        buildImpactDoc で文書にして computeImpact で数える（選んだ手・見送った手・シナリオつき）

import { expect } from "vitest";
import { buildImpactDoc, impactNodeId, type ImpactAltX, type ImpactBNode, type ImpactBundle, type ImpactOutX, type ImpactRootX, type ImpactSt, type R3 } from "../../src/demo/impact";
import { baseOf, deltaBetween, optionDeltas, overview, ROLE_A, valueParts, type Analysis, type CompiledMap } from "../../src/deepmap/core";
import type { DevTree, DevTreeNode, MapData, MapHeader, MapMix } from "../../src/deepmap/mapData";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { computeImpact, type ImpactResult } from "../../src/model/impact";
import type { DocData, NodeStatus } from "../../src/model/types";

export const st = (over: Partial<ImpactSt> = {}): ImpactSt => ({ j: "e", pm: "?", pro: 0, mau: 40, pu: 0, seats: 0, cl: 0, fee: 0, sal: 1, cv: 1, fl: [], ...over });

export const KINDS: MapHeader["kinds"] = {
  keep: ["今のまま", "base", "keep", []],
  ad_permside: ["届け出て副業の 1 社目を探す", "ind", "side", ["s_balance", "s_early"]],
  ad_side: ["副業の顧客を 1 社増やす", "ind", "side", ["s_balance", "s_early"]],
  ad_more: ["紹介で顧客を増やす", "ind", "side", ["s_balance", "s_early"]],
  fc_switch: ["転職活動をする", "fc", "switch", ["s_balance"]],
  fc_switch2: ["転職活動を続ける", "fc", "switch", ["s_balance"]],
  fc_push: ["4 月の評価で昇格を狙う", "fc", "fcpush", ["s_balance"]],
  sd_grow: ["遊ぶ人を増やす", "sd", "sdgrow", ["s_balance", "s_focus"]],
  sd_retain: ["続ける人を増やす", "sd", "sdretain", ["s_balance", "s_focus"]],
  part: ["週 4 日勤務を相談する", "fc", "part", ["s_focus", "s_early"]],
  ind_quit: ["辞めて独立する", "ind", "ind", ["s_early"]],
};

export function header(over: Partial<MapHeader> = {}): MapHeader {
  return {
    v: 3,
    kind: "impact3y",
    title: "テストの地図",
    anchor: "2026-11",
    horizon: 36,
    annual: 360,
    release: 0,
    hash: "test",
    textVersion: "test",
    kinds: KINDS,
    fams: { keep: "今のまま", side: "広告運用の副業", switch: "転職", fcpush: "昇格を狙う", sdgrow: "遊ぶ人を増やす", sdretain: "続ける人を増やす", part: "週 4 日勤務", ind: "辞めて独立する" },
    premises: [],
    never: {},
    counts: { nodes: 0, decisions: 0, options: 0, forks: 0, ends: 0, sumEnds: 0 },
    ...over,
  };
}

/** 鍵を親の鍵 + "." + 名前にする（root は "r"） */
function keyed(n: DevTreeNode, parentKey: string | null): DevTreeNode {
  const k = parentKey === null ? n.k : `${parentKey}.${n.k}`;
  return { ...n, k, ...(n.kids ? { kids: n.kids.map((c) => keyed(c, k)) } : {}) };
}

const opt = (k: string, kind: string, m: number, kids: DevTreeNode[], x: Partial<DevTreeNode> = {}): DevTreeNode => ({ k, r: "a", m, st: st(), kind, h: 2, ...(kind === "keep" ? { base: true, why: "keep" as const, h: 0 } : {}), ...x, kids });
const state = (k: string, m: number, p: number, lab: string, e: R3, rr: R3, kids: DevTreeNode[], x: Partial<DevTreeNode> = {}): DevTreeNode => ({ k, r: "s", m, st: st(), id: k, p, lab, line: `${lab}の場合`, e, rr, ...x, ...(kids.length ? { kids } : {}) });
const end = (k: string, m: number, p: number, lab: string, e: R3, rr: R3, x: Partial<DevTreeNode> = {}): DevTreeNode => ({ k, r: "e", m, st: st(), id: k, p, lab, line: `${lab}の場合`, e, rr, ...x });

export const MIX: MapMix = { j: { e: 0.9, p: 0.1, i: 0 }, pm: { "?": 0, a: 0.2, s: 0.5, n: 0.3 }, pro: 0.7, switched: 0.2, school: 0, cl: [0, 1, 2], pu: [10, 35, 80], mau: [200, 600, 1500], sal: [1, 1.1, 1.2] };

/** 手で作った小さな地図 */
export function handTree(): DevTree {
  const root: DevTreeNode = {
    k: "r",
    r: "r",
    m: 0,
    st: st(),
    rr: [1, 0, -0.3],
    kids: [
      // 事実を知る手: 会社の答え（全部可 20%・SpellDash だけ 45%・どちらも不可 35%）
      opt(
        "ad_permside",
        "ad_permside",
        0,
        [
          state("a", 3, 20, "全部可", [3, 3.76, -0.71], [1, 1.84, -0.18], [
            opt("1as", "ad_side", 3, [
              state("cl1", 6, 55, "顧客 1 社", [3, 8, -0.5], [1, 3, -0.1], [
                opt("2k", "keep", 6, [end("all", 36, 100, "どの場合も", [30.5, 90, 10], [1.1, 3, 1], { sum: true, mix: MIX, cont: [{ m: 9, kind: "ad_more", ev: "client_up" }, { m: 12, kind: "keep" }] })], { stub: true }),
                opt("2am", "ad_more", 6, [end("cl2", 36, 60, "顧客 2 社", [30, 150, 12], [1.1, 6, 1]), end("cl1b", 36, 40, "顧客 1 社のまま", [30, 80, 12], [1.1, 3, 1])]),
              ]),
              // 36 か月目より前に止まる状態（手が無い）
              state("cl0", 6, 45, "顧客 0 社", [3, 0, -0.5], [1, 0, -0.1], []),
            ]),
            opt("1k", "keep", 3, [end("all", 36, 100, "どの場合も", [33, 20, 5], [1.1, 1, 0.5], { sum: true })], { stub: true }),
          ], { rv: ["pm:0", "a"] }),
          state("s", 3, 45, "SpellDash だけ", [3, 0, -0.71], [1, 0, -0.18], [
            opt("1fp", "fc_push", 3, [
              end("up", 36, 30, "昇格", [34, 0, 6], [1.1, 0, 0.4]),
              end("same", 36, 70, "据え置き", [33, 0, 6], [1.03, 0, 0.4]),
            ]),
            opt("1k", "keep", 3, [end("all", 36, 100, "どの場合も", [33, 0, 5], [1.03, 0, 0.3], { sum: true })], { stub: true }),
          ], { rv: ["pm:0", "s"] }),
          state("n", 3, 35, "どちらも不可", [3, 0, -0.9], [1, 0, -0.3], [
            opt("1k", "keep", 3, [end("all", 36, 100, "どの場合も", [33, 0, -9], [1.03, 0, -0.3])]),
            opt("1fs", "fc_switch", 3, [
              end("high", 36, 10, "大きく上げて転職", [38, 0, -9], [1.18, 0, -0.3]),
              end("mid", 36, 18, "少し上げて転職", [35.5, 0, -9], [1.08, 0, -0.3]),
              end("none", 36, 72, "転職せず", [33, 0, -9], [1.03, 0, -0.3]),
            ]),
          ], { rv: ["pm:0", "n"] }),
        ],
        { h: 4, q: [36, 6, -2] },
      ),
      // 同じ値の手: 今のまま・遊ぶ人を増やす・続ける人を増やす（同じなら今のまま、次に並びの前）
      opt(
        "sd_grow",
        "sd_grow",
        0,
        [
          state("all", 3, 100, "どの場合も", [3, 0, -0.6], [1, 0, -0.1], [
            opt("1sg", "sd_grow", 3, [end("x", 36, 100, "どの場合も", [33, 0, 2], [1, 0, 0.1])]),
            opt("1sr", "sd_retain", 3, [end("x", 36, 100, "どの場合も", [33, 0, 2], [1, 0, 0.1])]),
            opt("1k", "keep", 3, [end("x", 36, 100, "どの場合も", [33, 0, 2], [1, 0, 0.1])]),
          ]),
        ],
        { q: [36, 0, 1] },
      ),
      // % の合計が 99（アプリは合計で割る）。転職せずの後は今のままの無い判断で、同じ値の 2 つの手（並びの前が選ばれる）
      opt(
        "fc_switch",
        "fc_switch",
        0,
        [
          end("high", 36, 33, "大きく上げて転職", [41, 0, -10], [1.18, 0, -0.3]),
          end("mid", 36, 33, "少し上げて転職", [38, 0, -10], [1.08, 0, -0.3]),
          state("none", 3, 33, "転職せず", [3, 0, -0.9], [1, 0, -0.3], [
            opt("1fw", "fc_switch2", 3, [end("moved", 36, 25, "移れた", [36, 0, -9], [1.1, 0, -0.3]), end("none", 36, 75, "決まらず", [33, 0, -9], [1, 0, -0.3])]),
            opt("1fp", "fc_push", 3, [end("moved", 36, 25, "移れた", [36, 0, -9], [1.1, 0, -0.3]), end("none", 36, 75, "決まらず", [33, 0, -9], [1, 0, -0.3])]),
          ]),
        ],
        { h: 5, q: [36.4, 0, -3] },
      ),
      // 0% の結果
      opt(
        "part",
        "part",
        0,
        [end("p", 36, 35, "週 4 日に", [29, 40, -10], [0.8, 2, -0.3]), end("e", 36, 65, "認められず", [36, 0, -10], [1, 0, -0.3]), end("z", 36, 0, "起こらない", [0, 0, 0], [0, 0, 0])],
        { h: 0, q: [33, 26, -10] },
      ),
      // 判断の 1 か月後に始まる手（判断からの線に 1 か月分の稼ぎが付く）
      opt("ind_quit", "ind_quit", 1, [end("cl1", 36, 40, "顧客 1 社", [1, 120, -5], [0, 4, -0.2]), end("cl0", 36, 60, "顧客 0 社", [1, 60, -5], [0, 2, -0.2])], { h: -2, q: [1, 80, -5] }),
      // ずっと今のまま: 3 段の今のまま（途中に 36 か月目より前の行き先）
      opt(
        "keep",
        "keep",
        0,
        [
          state("all", 3, 100, "どの場合も", [3, 0, -0.9], [1, 0, -0.3], [
            opt("1fp", "fc_push", 3, [end("early", 9, 50, "早く止まる", [6, 0, -1.8], [1.07, 0, -0.3]), end("same", 36, 50, "据え置き", [33.5, 0, -9], [1.03, 0, -0.3])]),
            opt("1k", "keep", 3, [
              state("all", 6, 100, "どの場合も", [3, 0, -0.9], [1, 0, -0.3], [
                opt("2k", "keep", 6, [end("all", 36, 100, "どの場合も", [30.6, 0, -9], [1.03, 0, -0.3])]),
                opt("2sg", "sd_grow", 6, [end("all", 36, 100, "どの場合も", [30.6, 0, -6], [1.03, 0, 0])]),
              ]),
            ]),
            // 手が 1 つだけの判断（判断には数えない）
            opt("1sr", "sd_retain", 3, [state("only", 6, 100, "どの場合も", [3, 0, -0.9], [1, 0, -0.3], [opt("2k", "keep", 6, [end("all", 36, 100, "どの場合も", [30, 0, -9], [1, 0, -0.3])])])]),
          ]),
        ],
        { q: [36, 0, -3] },
      ),
    ],
  };
  const never: Record<string, R3> = { _all: [37, 10, 3], side: [36.5, 2, 3], switch: [36.6, 10, 3], fcpush: [37, 9.9, 3] };
  return { header: header({ never }), root: keyed(root, null) };
}

/** 種から決まる乱数（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANDOM_KINDS = ["ad_permside", "ad_side", "fc_switch", "fc_push", "sd_grow", "sd_retain", "part", "ind_quit"];

/** 種から作る地図（budget はおおよそのカードの数） */
export function randomTree(seed: number, budget = 700): DevTree {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const r3 = (scale: number): R3 => [Math.round(rand() * 3 * 100) / 100, Math.round((rand() - 0.3) * scale * 100) / 100, Math.round((rand() - 0.4) * scale * 50) / 100];
  let used = 1;
  const outcomes = (m: number, kind: string, stub: boolean, depth: number): DevTreeNode[] => {
    const k = 1 + Math.floor(rand() * 3);
    // 見込み %: ふつうは合計 100。ときどき 99・101・0% を混ぜる
    const ps: number[] = [];
    let left = 100;
    for (let j = 0; j < k - 1; j++) {
      const p = Math.floor(rand() * left);
      ps.push(p);
      left -= p;
    }
    ps.push(left);
    const u = rand();
    if (u < 0.08) ps[0] = ps[0]! + 1;
    else if (u < 0.16 && ps[0]! > 0) ps[0] = ps[0]! - 1;
    else if (u < 0.2) ps.push(0);
    const fact = kind === "ad_permside" && rand() < 0.7;
    const answers = ["a", "s", "n"];
    return ps.map((p, j) => {
      used++;
      const id = `o${j}`;
      const x: Partial<DevTreeNode> = fact ? { rv: ["pm:0", answers[j % 3]!] } : {};
      const m2 = m + 3;
      if (stub || m2 >= 36) return end(id, 36, p, `結果 ${j + 1}`, [36 - m, (rand() - 0.2) * 100, (rand() - 0.4) * 20], r3(8), { ...x, ...(stub ? { sum: true } : {}), ...(stub && rand() < 0.3 ? { mix: MIX } : {}) });
      const v = rand();
      // ときどき 36 か月目を越える月（アプリは 36 に収める）・36 か月目より前の行き先・手の無い状態
      if (v < 0.04) return end(id, 40, p, `結果 ${j + 1}`, r3(10), r3(8), x);
      if (v < 0.1) return end(id, m2, p, `結果 ${j + 1}`, r3(10), r3(8), x);
      if (v < 0.14) return state(id, m2, p, `結果 ${j + 1}`, r3(10), r3(8), [], x);
      return state(id, m2, p, `結果 ${j + 1}`, r3(10), r3(8), decision(m2, depth + 1), x);
    });
  };
  const decision = (m: number, depth: number): DevTreeNode[] => {
    const n = 1 + Math.floor(rand() * 4);
    const hasBase = rand() < 0.85;
    const opts: DevTreeNode[] = [];
    for (let j = 0; j < n; j++) {
      const kind = j === n - 1 && hasBase ? "keep" : pick(RANDOM_KINDS);
      const stub = used > budget || depth > 6 || rand() < 0.3;
      const late = rand() < 0.05 ? 1 : 0;
      used++;
      const x: Partial<DevTreeNode> = { ...(stub ? { stub: true } : {}), ...(rand() < 0.5 ? { q: r3(30) } : {}) };
      opts.push(opt(`${m}${kind}${j}`, kind, m + late, outcomes(m + late, kind, stub, depth), x));
      // 同じ値の手（同じ中身を写す）。今のままと同じなら今のまま、ほかの手同士なら並びの前
      if (rand() < 0.15) {
        const twin = JSON.parse(JSON.stringify(opts[opts.length - 1]!)) as DevTreeNode;
        twin.k = `${twin.k}t`;
        twin.kind = pick(RANDOM_KINDS);
        delete twin.base;
        delete twin.why;
        if (rand() < 0.5) opts.unshift(twin);
        else opts.push(twin);
      }
    }
    return opts;
  };
  const root: DevTreeNode = { k: "r", r: "r", m: 0, st: st(), rr: [1, 0, -0.3], kids: decision(0, 0) };
  // 今日には今のままを必ず置く
  if (!root.kids!.some((c) => c.kind === "keep")) root.kids!.push(opt("keep", "keep", 0, outcomes(0, "keep", false, 1)));
  return { header: header({ never: { _all: r3(30), side: r3(30), switch: r3(30) } }), root: keyed(root, null) };
}

/** MapData → 今日の同梱データの形（テスト専用） */
export function toBundle(map: MapData): ImpactBundle {
  const nodes: ImpactBNode[] = [];
  for (let i = 0; i < map.n; i++) {
    const role = map.role(i);
    let x: ImpactRootX | ImpactAltX | ImpactOutX;
    if (role === "r") x = { st: map.st(i), rr: map.rr(i) };
    else if (role === "a") {
      const first = map.childCount(i) ? map.month(map.child(i, 0)) - map.month(i) : 3;
      const ax: ImpactAltX = { k: map.kind(i) ?? "", h: map.hours(i), len: Math.max(1, first) };
      if (map.isBase(i)) ax.base = 1;
      x = ax;
    } else {
      const ox: ImpactOutX = { p: map.p(i), lab: map.label(i), line: map.line(i), ln: map.ln(i) ?? ["", map.month(i), null, null], r: map.e(i), st: map.st(i), rr: map.rr(i) };
      const rv = map.rv(i);
      if (rv) ox.rv = rv;
      x = ox;
    }
    nodes.push([map.key(i), map.parent(i), role, map.month(i), map.title(i), map.short(i), "", x]);
  }
  const h = map.header;
  return { v: 2, kind: "impact3y", title: h.title, annual: h.annual, horizon: h.horizon, kinds: h.kinds, fams: h.fams, premises: h.premises, nodes, check: { annual: h.annual, vRoot: 0, vSQ: 0, rootDelta: {}, counts: { nodes: map.n, decisions: 0, options: 0, forks: 0, ends: 0 } } };
}

/** 今日の同梱データ（v2）→ 開発用の入れ子の木 */
export function bundleToDevTree(b: ImpactBundle): DevTree {
  const nodes: DevTreeNode[] = b.nodes.map((n) => {
    const [k, , r, m, title, short, , x] = n;
    const d: DevTreeNode = { k, r, m, st: (x as ImpactRootX).st, title, short };
    if (r === "r") d.rr = (x as ImpactRootX).rr;
    else if (r === "a") {
      const ax = x as ImpactAltX;
      d.kind = ax.k;
      d.h = ax.h;
      d.base = ax.base === 1;
      d.st = st();
    } else {
      const ox = x as ImpactOutX;
      Object.assign(d, { p: ox.p, lab: ox.lab, line: ox.line, ln: ox.ln, e: ox.r, rr: ox.rr, ...(ox.rv ? { rv: ox.rv } : {}) });
    }
    return d;
  });
  b.nodes.forEach((n, i) => {
    if (n[1] < 0) return;
    const p = nodes[n[1]]!;
    (p.kids ??= []).push(nodes[i]!);
  });
  const counts = { nodes: b.nodes.length, decisions: 0, options: 0, forks: 0, ends: 0, sumEnds: 0 };
  return { header: { v: 3, kind: "impact3y", title: b.title, anchor: "2026-11", horizon: 36, annual: b.annual, release: 6, hash: "r6", textVersion: "r6", kinds: b.kinds, fams: b.fams ?? {}, premises: b.premises, never: {}, counts }, root: nodes[0]! };
}

export interface AppRun {
  doc: DocData;
  res: ImpactResult;
  id: (key: string) => string;
}

/** アプリの計算: buildImpactDoc で文書にして computeImpact で数える */
export function appImpact(b: ImpactBundle, annual: number, opts: { status?: ReadonlyMap<string, NodeStatus>; scenario?: string | null; doc?: DocData } = {}): AppRun {
  const doc = opts.doc ?? buildImpactDoc(b, new Date(2026, 10, 19), "test");
  const id = (key: string) => impactNodeId(key);
  const root = doc.nodes[id(b.nodes[0]![0])]!;
  root.meta = { ...root.meta, impact: { v: 2, horizon: b.horizon, annual } };
  for (const n of b.nodes) {
    const node = doc.nodes[id(n[0])]!;
    node.status = opts.status?.get(n[0]) ?? "open";
  }
  const scen = opts.scenario ?? null;
  const idx = buildIndex(doc);
  const res = computeImpact(doc, idx.out, computeForecast(doc, idx.out, scen), scen);
  return { doc, res, id };
}

const EPS = 1e-9;

export function close(a: number | null | undefined, b: number | null | undefined, what: string): void {
  if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
    expect([what, a ?? null]).toEqual([what, b ?? null]);
    return;
  }
  if (Math.abs(a - b) > EPS) expect([what, a]).toEqual([what, b]);
}

/** 計算の芯とアプリの計算（computeImpact）を、値・差・選び方・見込み・稼ぎ・分布で比べる */
export function compare(map: MapData, a: Analysis, app: AppRun): { options: number; decisions: number } {
  const cm = a.cm;
  const { res, id } = app;
  const deltas = optionDeltas(a.pi);
  const parts = valueParts(a.pi);
  let options = 0;
  let decisions = 0;
  for (let i = 0; i < cm.n; i++) {
    const nid = id(map.key(i));
    const key = map.key(i);
    close(a.pi.def[i] ? a.pi.V[i]! : null, res.value.get(nid), `値 ${key}`);
    const vv = res.valueV.get(nid);
    for (let c = 0; c < 3; c++) close(a.pi.def[i] ? parts[i * 3 + c]! : null, vv ? vv[c] : null, `値の内訳 ${c} ${key}`);
    close(a.pi.def[i] ? a.pi.R[i]! : null, res.rate.get(nid), `36 か月目の月の稼ぎ ${key}`);
    close(a.money.acc[i]!, res.acc.get(nid), `そこまでの稼ぎ ${key}`);
    close(a.pi.reach[i]! > 0 ? a.pi.reach[i]! : null, res.pPi.get(nid), `来る見込み ${key}`);
    if (cm.role[i] === ROLE_A && cm.parent[i]! >= 0) {
      const info = res.alt.get(nid);
      if (info) {
        options++;
        // 画面に出す差: アプリの文書に q がある地図（版 7）は、両方の手に比べ方をそろえた値（q・まとめた手の値）があればその差、
        // 無ければ地図の値（木の値）の差（計算の芯の deltaBetween。木の値の差が出ない手は、アプリも差を出さない: 見直し user-1・equiv-1）。
        // q の無い文書（今日の同梱データの形に直した物など）は木の値の差
        const tree = Number.isFinite(deltas[i]!) ? deltas[i]! : null;
        const b = baseOf(cm, cm.parent[i]!);
        const want = tree !== null && b >= 0 && res.likeBasis ? deltaBetween(a.pi, i, b) : null;
        close(res.likeBasis ? (want ? want.d : null) : tree, info.delta, `差 ${key}`);
        if (want) expect([key, info.deltaBasis]).toEqual([key, want.basis]);
      }
    } else if (cm.kidOff[i] !== cm.kidOff[i + 1]) {
      const d = res.decision.get(nid);
      if (d) {
        decisions++;
        const chosen = a.pi.pi[i]! >= 0 ? id(map.key(a.pi.pi[i]!)) : null;
        const best = a.pi.best[i]! >= 0 ? id(map.key(a.pi.best[i]!)) : null;
        expect([key, chosen]).toEqual([key, d.chosen]);
        expect([key, best]).toEqual([key, d.best]);
      }
    }
  }
  close(a.vRoot, res.vRoot, "今日の値");
  close(a.vSQ, res.vSQ, "ずっと今のまま");
  const ov = overview(a);
  const d = res.dist;
  if (d) {
    close(ov.today?.mean, d.mean, "平均");
    close(ov.today?.p10, d.p10, "10%");
    close(ov.today?.p50, d.p50, "50%");
    close(ov.today?.p90, d.p90, "90%");
    close(ov.today?.pWorse, d.pWorse, "悪くなる見込み");
    d.bins.forEach((x, k) => close(ov.today?.bins[k], x, `段 ${k}`));
    d.sqBins.forEach((x, k) => close(ov.keep?.bins[k], x, `今のままの段 ${k}`));
  } else expect(ov.today).toBeNull();
  return { options, decisions };
}

export function statusArray(cm: CompiledMap, map: MapData, status: ReadonlyMap<string, NodeStatus>): Uint8Array {
  const out = new Uint8Array(cm.n);
  for (const [key, s] of status) {
    const i = map.indexOfKey(key);
    if (i >= 0) out[i] = s === "active" || s === "done" ? 1 : s === "dropped" ? 2 : 0;
  }
  return out;
}

/** 手のうちいくつかを選んだ・見送ったにする（種から決める） */
export function randomStatus(map: MapData, seed: number): Map<string, NodeStatus> {
  const rand = rng(seed);
  const out = new Map<string, NodeStatus>();
  for (let i = 0; i < map.n; i++) {
    if (map.role(i) !== "a") continue;
    const u = rand();
    if (u < 0.08) out.set(map.key(i), "active");
    else if (u < 0.12) out.set(map.key(i), "done");
    else if (u < 0.22) out.set(map.key(i), "dropped");
  }
  return out;
}
