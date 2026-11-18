// 未来の道筋 v2「3 年の分かれ道」を 4D Branch の文書に組み立てる。データは scripts/impact/（決まった計算）で作る。設計: docs/DESIGN.md §4.7
// 今日（判断）→ 選択肢（その手。結果は見込み % で分かれる）→ 3 か月後（判断）→ … → 3 年後の行き先。どの道も 36 か月目の行き先まで書いてある。
// 選択肢の線（判断の線）には % を付けない。結果の線には % と判断の線（測れる条件）と期間の稼ぎ（meta.r）を付ける。

import { impactColX, outlineLayout } from "../model/impactLayout";
import { createEmptyDoc, makeCondition, makeEdge, makeNode, makeProject, makeScenario } from "../model/schema";
import type { DocData, GNode, ID } from "../model/types";

export type ImpactRole = "r" | "a" | "s" | "e";

/** 状態: 仕事（会社員 e・週 4 日 p・独立 i）、届け出の答え、Pro、遊ぶ人、有料会員、学校の席、顧客、1 社の月額、給与の倍率、続ける工夫の倍率、印 */
export interface ImpactSt {
  j: "e" | "p" | "i";
  pm: "?" | "a" | "s" | "n";
  pro: 0 | 1;
  mau: number;
  pu: number;
  seats: number;
  cl: number;
  fee: number;
  sal: number;
  cv: number;
  fl: string[];
}

export type R3 = [number, number, number];
/** 判断の線: [測る物, 何か月目, 下限, 上限, 分類] */
export type ImpactLine = [string, number, number | null, number | null, string?];

export interface ImpactRootX {
  st: ImpactSt;
  rr: R3;
}
export interface ImpactAltX {
  /** 手の種類 */
  k: string;
  /** 週の時間の増減 */
  h: number;
  base?: 1;
  todo?: string[];
  /** 何か月の期間か */
  len: number;
}
export interface ImpactOutX {
  /** 見込み % */
  p: number;
  lab: string;
  line: string;
  ln: ImpactLine;
  /** 期間の稼ぎ [給与の月数, 広告運用 万円, SpellDash 万円] */
  r: R3;
  st: ImpactSt;
  /** その時点の月の稼ぎ [給与の倍率, 広告運用 万円/月, SpellDash 万円/月] */
  rr: R3;
}

/** [鍵, 親の番号, 役割, 月, タイトル, 短い名前, 本文, 中身] */
export type ImpactBNode = [string, number, ImpactRole, number, string, string, string, ImpactRootX | ImpactAltX | ImpactOutX];

export interface ImpactBundle {
  v: 2;
  kind: "impact3y";
  title: string;
  /** 計算の元にした年収（万円） */
  annual: number;
  horizon: number;
  /** 手の種類: [名前, 領域, まとまり, シナリオ] */
  kinds: Record<string, [string, "sd" | "fc" | "ind" | "base", string, string[]]>;
  premises: string[];
  nodes: ImpactBNode[];
  check: {
    annual: number;
    vRoot: number;
    vSQ: number;
    rootDelta: Record<string, number>;
    counts: { nodes: number; decisions: number; options: number; forks: number; ends: number };
  };
}

export const IMPACT_TITLE = "未来の道筋（仕事・3 年の分かれ道）";

const AREAS = {
  sd: { id: "p_spelldash", name: "SpellDash事業", color: "#FF7A59", description: "英単語学習ゲーム SpellDash を事業として伸ばす。" },
  fc: { id: "p_fcmarketing", name: "FCマーケティングでの業務", color: "#22D3EE", description: "会社での広告運用の仕事。成果と評価を積み上げる。" },
  ind: { id: "p_independence", name: "広告運用事業での独立", color: "#A3E635", description: "広告運用代行として独立し、自分の事業にする。" },
} as const;
const SCENARIOS = [
  { id: "s_balance", name: "両立（基本）", color: "#8B7BFF", description: "会社員を続けながら、SpellDash と副業を同時に育てる。" },
  { id: "s_early", name: "早期独立", color: "#F2C14E", description: "2027 年中に副業の条件を満たし、独立する。" },
  { id: "s_focus", name: "SpellDash集中", color: "#4FD1E8", description: "広告に頼らずオーガニックで伸ばし、SpellDash に時間を寄せる。" },
];

/** 鍵からノードの ID（FNV-1a の 36 進 7 桁） */
export function impactNodeId(key: string): ID {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `n_i_${h.toString(36).padStart(7, "0")}`;
}

/** 基準の月から off か月後の月の末日（YYYY-MM-DD）。off が 0 なら today の日付 */
export function monthDate(today: Date, off: number): string {
  if (off <= 0) return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const total = today.getFullYear() * 12 + today.getMonth() + off;
  const y = Math.floor(total / 12);
  const m = total % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

const ROLE_TAG: Record<ImpactRole, (m: number) => string> = {
  r: () => "今日",
  a: () => "選択肢",
  s: (m) => (m === 3 ? "3か月後" : m === 12 ? "1年後" : `${m}か月後`),
  e: () => "3年後",
};

export interface ImpactCounts {
  nodes: number;
  decisions: number;
  options: number;
  forks: number;
  ends: number;
}

export function countImpact(b: ImpactBundle): ImpactCounts {
  const kids = new Array<number>(b.nodes.length).fill(0);
  b.nodes.forEach((n) => {
    if (n[1] >= 0) kids[n[1]]!++;
  });
  let decisions = 0;
  let options = 0;
  let forks = 0;
  let ends = 0;
  b.nodes.forEach((n, i) => {
    if (kids[i]! >= 2) forks++;
    if ((n[2] === "r" || n[2] === "s") && kids[i]! >= 2) decisions++;
    if (n[2] === "a") options++;
    if (n[2] === "e") ends++;
  });
  return { nodes: b.nodes.length, decisions, options, forks, ends };
}

/** 3 年の分かれ道の文書を組み立てる（期限は today の月から数える）。同じデータ・同じ today なら同じ文書（作った時刻を除く） */
export function buildImpactDoc(b: ImpactBundle, today = new Date(), version = ""): DocData {
  const doc = createEmptyDoc(b.title || IMPACT_TITLE);
  for (const a of Object.values(AREAS)) {
    const p = makeProject(a);
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
  }
  for (const s of SCENARIOS) {
    const sc = makeScenario(s);
    doc.scenarios[sc.id] = sc;
    doc.scenarioOrder.push(sc.id);
  }
  const all = Object.values(AREAS).map((a) => a.id);
  const ids = b.nodes.map((n) => impactNodeId(n[0]));
  if (new Set(ids).size !== ids.length) throw new Error("3 年の分かれ道: ノードの ID が重なりました");
  const kids: number[][] = b.nodes.map(() => []);
  b.nodes.forEach((n, i) => {
    if (n[1] >= 0) kids[n[1]]!.push(i);
  });
  // 並べ方（全部開いた形。古いタブ・書き出し用。見るときはアプリが開いている所だけで並べ直す）
  const at = new Map(ids.map((id, i) => [id, i]));
  const pos = outlineLayout(ids[0]!, (id) => kids[at.get(id)!]!.map((k) => ids[k]!));
  const rankOf = new Map<number, number>();
  for (const list of kids) list.forEach((k, r) => rankOf.set(k, r));
  let seq = 0;
  b.nodes.forEach((n, i) => {
    const [key, parent, role, m, title, short, body, x] = n;
    const p = pos.get(ids[i]!) ?? { x: impactColX(0), y: 0 };
    const tags = ["未来の道筋", "3年", ROLE_TAG[role](m)];
    const common: Partial<GNode> = { id: ids[i]!, title, body, tags, x: p.x, y: p.y, status: "open" };
    let node: GNode;
    if (role === "r") {
      const rx = x as ImpactRootX;
      node = makeNode({
        ...common,
        type: "goal",
        time: { due: monthDate(today, 0), start: null },
        projectIds: all,
        meta: { forecastRoot: true, futureVersion: version, impact: { v: 2, horizon: b.horizon }, fork: "decision", m: 0, short, st: rx.st, rr: rx.rr, key },
      });
    } else if (role === "a") {
      const ax = x as ImpactAltX;
      const kind = b.kinds[ax.k];
      const area = kind?.[1] ?? "base";
      node = makeNode({
        ...common,
        type: "action",
        time: { due: monthDate(today, m + ax.len), start: monthDate(today, m) },
        projectIds: area === "base" ? all : [AREAS[area].id],
        conditions: (ax.todo ?? []).map((t, k) => ({ ...makeCondition(t, false), id: `c_${ids[i]!.slice(4)}_${k}` })),
        meta: { fork: "chance", m, ak: ax.k, fam: kind?.[2] ?? ax.k, h: ax.h, ...(ax.base ? { base: true } : {}), rank: rankOf.get(i) ?? 0, short, key },
      });
    } else {
      const ox = x as ImpactOutX;
      node = makeNode({
        ...common,
        type: role === "e" ? "result" : "branch",
        time: { due: monthDate(today, m), start: null },
        projectIds: all,
        meta: { ...(role === "e" ? { end: true } : { fork: "decision" }), m, short, st: ox.st, rr: ox.rr, rank: rankOf.get(i) ?? 0, key },
      });
    }
    doc.nodes[node.id] = node;
    if (parent < 0) return;
    const pid = ids[parent]!;
    const e = makeEdge({ id: `e_i_${(seq++).toString(36)}`, source: pid, target: node.id, relation: role === "a" ? "leads" : "condition" });
    if (role === "a") {
      const kind = b.kinds[(x as ImpactAltX).k];
      e.scenarioIds = (x as ImpactAltX).base ? [] : [...(kind?.[3] ?? [])];
    } else {
      const ox = x as ImpactOutX;
      e.label = ox.lab === "—" ? "" : ox.lab;
      e.condition = ox.line;
      e.meta = { prob: ox.p, r: ox.r, ln: ox.ln };
    }
    doc.edges[e.id] = e;
  });
  return doc;
}
