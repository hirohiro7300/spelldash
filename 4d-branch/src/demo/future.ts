// 未来の道筋（仕事・10 年）を 4D Branch の文書に組み立てる。
// 今日（予測の入口）から、節目（0・6・12・24・36・60・84・120 か月目）の状態を通って 10 年後の行き先まで、
// 分かれ道（判断の線と見込み %）で枝分かれしながら続く道。節目の間は「歩み」（具体的な作業・出来事・小さな分かれ道）で埋める。
// 並べ方: 横 = 時間（節目ごとの列。節目の間は歩みを等間隔に）、縦 = 節目の状態ごとの帯（帯の中で本線の上下に寄り道）

import { CHILD_DX, NODE_H } from "../model/constants";
import { createEmptyDoc, makeCondition, makeEdge, makeNode, makeProject, makeScenario } from "../model/schema";
import type { DocData, GNode, NodeType } from "../model/types";

export type FutureLine = "start" | "base" | "early" | "focus";
export type FutureArea = "spell" | "fc" | "ind";
/** 節目の状態: [key, 今日から何か月目, 道, タイトル, 本文] */
export type FutureState = [string, number, FutureLine, string, string];
/** 歩み: [key, 種類, タイトル, 本文, 今日から何か月目, 領域, タグ, 目安, どの状態から次の節目までの歩みか] */
export type FutureStep = [string, NodeType, string, string, number, FutureArea, string[], string[], string];
/** つながり: [元, 先, 判断の線, 見込み %（分かれ道の選択肢だけ。ほかは null）, ラベル] */
export type FutureLink = [string, string, string, number | null, string];

export interface FutureData {
  v: 1;
  title: string;
  states: FutureState[];
  steps: FutureStep[];
  links: FutureLink[];
}

/** 節目（今日から何か月目） */
export const FUTURE_GATES = [0, 6, 12, 24, 36, 60, 84, 120];
export const FUTURE_TITLE = "未来の道筋（仕事・10 年）";

const COL_W = CHILD_DX;
const ROW_H = NODE_H + 44;
const BAND_GAP = ROW_H;
/** 節目の列の幅に足す余白（列の数） */
const GATE_PAD = 1;

const AREAS: Record<FutureArea, { id: string; name: string; color: string; description: string }> = {
  spell: { id: "p_spelldash", name: "SpellDash事業", color: "#FF7A59", description: "英単語学習ゲーム SpellDash を事業として伸ばす。" },
  fc: { id: "p_fcmarketing", name: "FCマーケティングでの業務", color: "#22D3EE", description: "会社での広告運用の仕事。成果と評価を積み上げる。" },
  ind: { id: "p_independence", name: "広告運用事業での独立", color: "#A3E635", description: "広告運用代行として独立し、自分の事業にする。" },
};
/** 既存のデモ・やりたいことリストと同じシナリオ（追加で読み込むと、名前が同じものはまとまる） */
const SCENARIOS: Record<Exclude<FutureLine, "start">, { id: string; name: string; color: string; description: string }> = {
  base: { id: "s_balance", name: "両立（基本）", color: "#8B7BFF", description: "会社員を続けながら、SpellDash と副業を同時に育てる。" },
  early: { id: "s_early", name: "早期独立", color: "#F2C14E", description: "2027 年中に副業の条件を満たし、独立する。" },
  focus: { id: "s_focus", name: "SpellDash集中", color: "#4FD1E8", description: "広告に頼らずオーガニックで伸ばし、SpellDash に時間を寄せる。" },
};
/** 節目の帯を上から並べる順 */
const LINE_ORDER: Record<FutureLine, number> = { start: 0, focus: 1, base: 2, early: 3 };

const nodeId = (key: string) => `n_f_${key.replace(/[^A-Za-z0-9]/g, "_")}`;

/** 基準の月から off か月後の月の末日（YYYY-MM-DD）。off が 0 なら today の日付 */
function monthDate(today: Date, off: number): string {
  if (off <= 0) return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const total = today.getFullYear() * 12 + today.getMonth() + off;
  const y = Math.floor(total / 12);
  const m = total % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

interface Window {
  owner: string;
  steps: string[];
  layer: Map<string, number>;
  lane: Map<string, number>;
  width: number;
  minLane: number;
  maxLane: number;
}

/** 未来の道筋の文書を組み立てる（期限は today の月から数える） */
export function buildFutureDoc(data: FutureData, today = new Date(), version = ""): DocData {
  const doc = createEmptyDoc(data.title || FUTURE_TITLE);
  for (const a of Object.values(AREAS)) {
    const p = makeProject(a);
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
  }
  for (const s of Object.values(SCENARIOS)) {
    const sc = makeScenario(s);
    doc.scenarios[sc.id] = sc;
    doc.scenarioOrder.push(sc.id);
  }
  const allProjects = Object.values(AREAS).map((a) => a.id);
  const states = new Map(data.states.map((s) => [s[0], s]));
  const steps = new Map(data.steps.map((s) => [s[0], s]));
  const next = new Map<string, string[]>();
  const prev = new Map<string, string[]>();
  for (const [from, to] of data.links) {
    if (!(states.has(from) || steps.has(from)) || !(states.has(to) || steps.has(to)) || from === to) continue;
    next.set(from, [...(next.get(from) ?? []), to]);
    prev.set(to, [...(prev.get(to) ?? []), from]);
  }

  // 節目の間の歩み（状態ごと）: 層（状態から何歩目か）と段（本線 0、寄り道は上下）
  const windows = new Map<string, Window>();
  for (const s of data.states) windows.set(s[0], { owner: s[0], steps: [], layer: new Map(), lane: new Map(), width: 0, minLane: 0, maxLane: 0 });
  for (const st of data.steps) windows.get(st[8])?.steps.push(st[0]);
  for (const w of windows.values()) {
    const inWin = new Set(w.steps);
    // 層: 状態から歩みの中だけを通った最長の歩数（循環は切る）
    const layerOf = (k: string, seen: Set<string>): number => {
      const m = w.layer.get(k);
      if (m !== undefined) return m;
      if (seen.has(k)) return 1;
      seen.add(k);
      let d = 1;
      for (const p of prev.get(k) ?? []) if (inWin.has(p)) d = Math.max(d, layerOf(p, seen) + 1);
      seen.delete(k);
      w.layer.set(k, d);
      return d;
    };
    for (const k of w.steps) layerOf(k, new Set());
    w.width = Math.max(0, ...w.steps.map((k) => w.layer.get(k)!));
    // 本線: いちばん深い歩みから、層が 1 つずつ浅い前の歩みをたどる
    const main = new Set<string>();
    let cur = [...w.steps].sort((a, b) => w.layer.get(b)! - w.layer.get(a)!)[0];
    while (cur) {
      main.add(cur);
      const l = w.layer.get(cur)!;
      cur = (prev.get(cur) ?? []).find((p) => inWin.has(p) && w.layer.get(p) === l - 1);
    }
    const used = new Map<number, Set<number>>([[0, new Set([...main].map((k) => w.layer.get(k)!))]]);
    for (const k of main) w.lane.set(k, 0);
    // 寄り道: 本線でない歩みを、つながったまとまりごとに空いている段へ（上 → 下 → 2 つ上 …）。
    // まとまりの中で同じ層に 2 つ以上あれば、層ごとに 1 つ目をその段へ置き、残りをもう一度まとまりとして置く
    const placeGroup = (group: string[]): void => {
      const byLayer = new Map<number, string>();
      const extra: string[] = [];
      for (const k of [...group].sort((a, b) => w.layer.get(a)! - w.layer.get(b)!)) {
        const l = w.layer.get(k)!;
        if (byLayer.has(l)) extra.push(k);
        else byLayer.set(l, k);
      }
      const layers = [...byLayer.keys()];
      // 使っている段より外側は必ず空いているので、いずれ置ける
      for (let i = 1; ; i++) {
        const lane = i % 2 ? -Math.ceil(i / 2) : Math.ceil(i / 2);
        const taken = used.get(lane) ?? new Set<number>();
        if (layers.some((l) => taken.has(l))) continue;
        for (const k of byLayer.values()) w.lane.set(k, lane);
        used.set(lane, new Set([...taken, ...layers]));
        w.minLane = Math.min(w.minLane, lane);
        w.maxLane = Math.max(w.maxLane, lane);
        break;
      }
      if (extra.length) placeGroup(extra);
    };
    const rest = w.steps.filter((k) => !main.has(k)).sort((a, b) => w.layer.get(a)! - w.layer.get(b)!);
    const placed = new Set<string>();
    for (const start of rest) {
      if (placed.has(start)) continue;
      const group: string[] = [];
      const stack = [start];
      placed.add(start);
      while (stack.length) {
        const k = stack.pop()!;
        group.push(k);
        for (const n of [...(next.get(k) ?? []), ...(prev.get(k) ?? [])]) if (inWin.has(n) && !main.has(n) && !placed.has(n)) (placed.add(n), stack.push(n));
      }
      placeGroup(group);
    }
  }

  // 節目の列の位置（その節目から出る歩みのいちばん長いものに合わせる）
  const gateX = new Map<number, number>();
  let x = 0;
  FUTURE_GATES.forEach((g, i) => {
    gateX.set(g, x);
    const from = data.states.filter((s) => s[1] === g);
    const widest = Math.max(0, ...from.map((s) => windows.get(s[0])!.width));
    if (i < FUTURE_GATES.length - 1) x += (widest + 1 + GATE_PAD) * COL_W;
  });

  // 節目ごとに帯を上から積む（道の順 → key の順）。状態は帯の本線の高さに置く
  const pos = new Map<string, { x: number; y: number }>();
  const stateY = new Map<string, number>();
  for (const g of FUTURE_GATES) {
    const here = data.states.filter((s) => s[1] === g).sort((a, b) => LINE_ORDER[a[2]] - LINE_ORDER[b[2]] || a[0].localeCompare(b[0]));
    let y = 0;
    const centers: Array<[string, number]> = [];
    for (const s of here) {
      const w = windows.get(s[0])!;
      const top = y;
      const center = top + -w.minLane * ROW_H;
      centers.push([s[0], center]);
      y = top + (w.maxLane - w.minLane + 1) * ROW_H + BAND_GAP;
    }
    const mid = (y - BAND_GAP - ROW_H) / 2;
    for (const [k, c] of centers) stateY.set(k, c - mid);
  }
  for (const s of data.states) {
    const g = s[1];
    const x0 = gateX.get(g) ?? 0;
    pos.set(s[0], { x: x0, y: stateY.get(s[0]) ?? 0 });
    const w = windows.get(s[0])!;
    if (!w.steps.length) continue;
    const gi = FUTURE_GATES.indexOf(g);
    const x1 = gateX.get(FUTURE_GATES[Math.min(gi + 1, FUTURE_GATES.length - 1)]!) ?? x0 + (w.width + 1) * COL_W;
    const dx = Math.max(COL_W, (x1 - x0) / (w.width + 1));
    for (const k of w.steps) pos.set(k, { x: x0 + w.layer.get(k)! * dx, y: (stateY.get(s[0]) ?? 0) + w.lane.get(k)! * ROW_H });
  }

  // シナリオ: 6 か月目の 3 つの状態（両立・早期独立・SpellDash集中）で決める。
  // 6 か月目から先は、そこへ届く 6 か月目の道。6 か月目より前は、そこから届く 6 か月目の道（3 つとも届けば全シナリオ共通）。
  // こうすると、分かれ道の選択肢と 6 か月目の状態の間に歩みがあっても、選択肢の線からそのシナリオになる
  const m6 = data.states.filter((s) => s[1] === FUTURE_GATES[1] && s[2] !== "start");
  const after = new Map<string, Set<string>>();
  const before = new Map<string, Set<string>>();
  const spread = (from: string, sid: string, links: Map<string, string[]>, into: Map<string, Set<string>>, self: boolean) => {
    const stack = [from];
    const seen = new Set(stack);
    while (stack.length) {
      const k = stack.pop()!;
      if (k !== from || self) into.set(k, new Set([...(into.get(k) ?? []), sid]));
      for (const n of links.get(k) ?? []) if (!seen.has(n)) (seen.add(n), stack.push(n));
    }
  };
  for (const s of m6) {
    const sid = SCENARIOS[s[2] as Exclude<FutureLine, "start">].id;
    spread(s[0], sid, next, after, true);
    spread(s[0], sid, prev, before, false);
  }
  const scenOf = (k: string): string[] => {
    const a = after.get(k);
    if (a) return [...a].sort();
    const b = before.get(k);
    return b && b.size < m6.length ? [...b].sort() : [];
  };

  for (const s of data.states) {
    const [key, month, line, title, body] = s;
    const p = pos.get(key)!;
    const isEnd = !(next.get(key)?.length);
    const n: GNode = makeNode({
      id: nodeId(key),
      type: line === "start" || isEnd ? "goal" : "result",
      title,
      body,
      time: { due: monthDate(today, month), start: null },
      tags: line === "start" ? ["未来の道筋", "今日"] : isEnd ? ["未来の道筋", "10年後"] : ["未来の道筋", "節目"],
      projectIds: allProjects,
      scenarioIds: scenOf(key),
      x: p.x,
      y: p.y,
      meta: line === "start" ? { forecastRoot: true, futureVersion: version } : {},
    });
    doc.nodes[n.id] = n;
  }
  for (const st of data.steps) {
    const [key, type, title, body, month, area, tags, conds] = st;
    const p = pos.get(key) ?? { x: 0, y: 0 };
    const n = makeNode({
      id: nodeId(key),
      type,
      title,
      body,
      time: { due: monthDate(today, Math.max(month, 1)), start: null },
      tags,
      conditions: conds.map((c) => makeCondition(c, false)),
      projectIds: [AREAS[area]?.id ?? AREAS.spell.id],
      scenarioIds: scenOf(key),
      x: p.x,
      y: p.y,
    });
    doc.nodes[n.id] = n;
  }
  let seq = 0;
  const seen = new Set<string>();
  for (const [from, to, when, prob, label] of data.links) {
    const a = nodeId(from);
    const b = nodeId(to);
    if (!doc.nodes[a] || !doc.nodes[b] || a === b || seen.has(`${a}>${b}`)) continue;
    seen.add(`${a}>${b}`);
    // 線のシナリオは元のノードと同じ。全シナリオ共通のノードから出る線は、入る先のシナリオ（分かれ道の選択肢で分かれる）
    const fromScen = scenOf(from);
    const scenarioIds = fromScen.length ? fromScen : scenOf(to);
    const e = makeEdge({
      id: `e_f_${(++seq).toString(36)}`,
      source: a,
      target: b,
      relation: prob === null ? "leads" : "condition",
      condition: prob === null ? "" : when,
      label: prob === null ? when : label,
      scenarioIds,
      meta: prob === null ? {} : { prob },
    });
    doc.edges[e.id] = e;
  }
  return doc;
}

/** 数え: 歩み・分かれ道・行き先・節目の状態 */
export function countFuture(data: FutureData): { steps: number; forks: number; ends: number; states: number } {
  const hasNext = new Set(data.links.map((l) => l[0]));
  return {
    steps: data.steps.length,
    forks: data.steps.filter((s) => s[1] === "branch").length + data.states.filter((s) => data.links.filter((l) => l[0] === s[0] && l[3] !== null).length > 1).length,
    ends: data.states.filter((s) => !hasNext.has(s[0])).length,
    states: data.states.length,
  };
}
