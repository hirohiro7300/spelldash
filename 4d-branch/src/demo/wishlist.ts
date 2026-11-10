// やりたいことリスト（2,000 件）を 4D Branch の文書に組み立てる。
// 領域（プロジェクト）→ テーマ（見出し）→ やりたいこと の順に左から右へつなぎ、分岐（選択肢）と領域をまたぐつながりを足す。
// 並べ方: 横 = 時間の見通し（左 = 今すぐ、右 = いつか）、縦 = 領域の帯の中にテーマの段を重ねる

import { CHILD_DX, SIBLING_DY } from "../model/constants";
import { createEmptyDoc, makeCondition, makeEdge, makeNode, makeProject, makeScenario } from "../model/schema";
import type { DocData, GNode, ID, NodeType, Relation } from "../model/types";

export type Horizon = "now" | "y1" | "y3" | "y5" | "y10";
type ScenarioKey = "" | "base" | "early" | "focus";

/** やりたいこと: [id, 種類, タイトル, 本文, 時間の見通し, タグ, 先にやること（同じテーマの id）, 達成の目安] */
export type WishItem = [string, "action" | "goal" | "result", string, string, Horizon, string[], string[], string[]];
/** 分岐: [id, 問い, 本文, 時間の見通し, この判断の前にやること, 判断の材料, 選択肢 [行き先の id, こちらを選ぶ条件, シナリオ]] */
export type WishBranch = [string, string, string, Horizon, string[], string[], Array<[string, string, ScenarioKey]>];
/** 領域をまたぐつながり: [元の id, 先の id, 関係, ラベル] */
export type WishLink = [string, string, Relation, string];

export interface WishTheme {
  key: string;
  name: string;
  hubTitle: string;
  hubBody: string;
  items: WishItem[];
  branches: WishBranch[];
}

export interface WishArea {
  key: string;
  name: string;
  color: string;
  description: string;
  themes: WishTheme[];
}

export interface WishData {
  v: 1;
  areas: WishArea[];
  links: WishLink[];
}

export const WISHLIST_TITLE = "やりたいことリスト 2,000";

const HORIZONS: Horizon[] = ["now", "y1", "y3", "y5", "y10"];
/** 時間の見通しの言葉（ハブの本文・ヘルプ用） */
export const HORIZON_LABEL: Record<Horizon, string> = { now: "今すぐ（3 か月以内）", y1: "1 年以内", y3: "3 年以内", y5: "5 年以内", y10: "いつか（10 年以内）" };
/** 期限を割り振る範囲（読み込む日の月から数えた月数。月の末日にそろえる）: [始まり, 終わり] */
const HORIZON_MONTHS: Record<Horizon, [number, number]> = {
  now: [1, 3],
  y1: [4, 13],
  y3: [14, 37],
  y5: [38, 61],
  y10: [62, 121],
};
/** 1 つの時間の見通しに横へ並べる数（それより多ければ下の段へ） */
const SLOTS = 6;
const COL_W = CHILD_DX;
const ROW_H = SIBLING_DY;
const THEME_GAP = Math.round(ROW_H * 0.7);
const AREA_GAP = ROW_H * 2;

/** 既存のデモと同じ事業のプロジェクト・シナリオ（追加で読み込むと、名前が同じものはまとまる） */
const BUSINESS_IDS: Record<string, string> = { spell: "p_spelldash", fc: "p_fcmarketing", ind: "p_independence" };
const SCENARIOS: Record<Exclude<ScenarioKey, "">, { id: string; name: string; color: string; description: string }> = {
  base: { id: "s_balance", name: "両立（基本）", color: "#8B7BFF", description: "会社員を続けながら、SpellDash と副業を同時に育てる。" },
  early: { id: "s_early", name: "早期独立", color: "#F2C14E", description: "2027 年中に副業の条件を満たし、独立する。" },
  focus: { id: "s_focus", name: "SpellDash集中", color: "#4FD1E8", description: "広告に頼らずオーガニックで伸ばし、SpellDash に時間を寄せる。" },
};

/** 基準の月から k / n の位置の月の末日（YYYY-MM-DD） */
function dueAt(base: { y: number; m: number }, h: Horizon, k: number, n: number): string {
  const [a, b] = HORIZON_MONTHS[h];
  const off = a + (n <= 1 ? Math.round((b - a) / 2) : Math.round(((b - a) * k) / (n - 1)));
  const total = base.y * 12 + base.m + off;
  const y = Math.floor(total / 12);
  const m = total % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

const nodeId = (local: string) => `n_w_${local.replace(/[^A-Za-z0-9]/g, "_")}`;

interface Placed {
  local: string;
  horizon: Horizon;
  depth: number;
  order: number;
}

/** テーマの中の深さ（先にやることを順にたどった長さ。循環は切る） */
function depths(theme: WishTheme): Map<string, number> {
  const preds = new Map<string, string[]>();
  for (const it of theme.items) preds.set(it[0], [...it[6]]);
  for (const b of theme.branches) preds.set(b[0], [...b[4]]);
  for (const b of theme.branches) for (const [to] of b[6]) preds.get(to)?.push(b[0]);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const m = memo.get(id);
    if (m !== undefined) return m;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of preds.get(id) ?? []) if (preds.has(p)) d = Math.max(d, depthOf(p) + 1);
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const id of preds.keys()) depthOf(id);
  return memo;
}

/** やりたいことリストの文書を組み立てる（期限は today の月から数える） */
export function buildWishlistDoc(data: WishData, today = new Date()): DocData {
  const base = { y: today.getFullYear(), m: today.getMonth() };
  const doc = createEmptyDoc(WISHLIST_TITLE);
  for (const s of Object.values(SCENARIOS)) {
    const sc = makeScenario(s);
    doc.scenarios[sc.id] = sc;
    doc.scenarioOrder.push(sc.id);
  }
  const local2id = new Map<string, ID>();
  // id を英数字と _ にそろえると、別の id が同じになることがある（a-01 と a_01 など）。重なったら番号を足して分ける
  const idFor = (local: string): ID => {
    const base = nodeId(local);
    let id = base;
    for (let i = 2; doc.nodes[id]; i++) id = `${base}_${i}`;
    return id;
  };
  let edgeSeq = 0;
  const addEdge = (source: ID, target: ID, relation: Relation, label = "", condition = "", scen: ScenarioKey = "") => {
    if (source === target) return;
    const e = makeEdge({ id: `e_w_${(++edgeSeq).toString(36)}`, source, target, relation, label, condition, scenarioIds: scen ? [SCENARIOS[scen].id] : [] });
    doc.edges[e.id] = e;
  };

  let y = 0;
  for (const area of data.areas) {
    const p = makeProject({ id: BUSINESS_IDS[area.key] ?? `p_w_${area.key}`, name: area.name, color: area.color, description: area.description });
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
    const total = area.themes.reduce((n, t) => n + t.items.length, 0);
    const root = makeNode({
      id: idFor(`root-${area.key}`),
      type: "goal",
      title: area.description.replace(/。$/, ""),
      body: `${area.name}のやりたいこと ${total} 件（テーマ ${area.themes.length} 個）。テーマの見出しを畳むと、その先をまとめて隠せます。`,
      projectIds: [p.id],
      tags: ["やりたいこと"],
      x: -2 * COL_W,
      y: 0,
    });
    doc.nodes[root.id] = root;
    const hubYs: number[] = [];

    for (const theme of area.themes) {
      const depth = depths(theme);
      const placed: Placed[] = [];
      theme.items.forEach((it, i) => placed.push({ local: it[0], horizon: it[4], depth: depth.get(it[0]) ?? 0, order: i }));
      theme.branches.forEach((b, i) => placed.push({ local: b[0], horizon: b[3], depth: depth.get(b[0]) ?? 0, order: theme.items.length + i }));
      // 時間の見通しごとに、深さ（先にやることが先）→ 元の順で並べる
      const buckets = new Map<Horizon, Placed[]>(HORIZONS.map((h) => [h, []]));
      for (const pl of placed) buckets.get(HORIZONS.includes(pl.horizon) ? pl.horizon : "y1")!.push(pl);
      let rows = 1;
      for (const list of buckets.values()) {
        list.sort((a, b) => a.depth - b.depth || a.order - b.order);
        rows = Math.max(rows, Math.ceil(list.length / SLOTS));
      }
      const top = y;
      const pos = new Map<string, { x: number; y: number; due: string }>();
      HORIZONS.forEach((h, hi) => {
        const list = buckets.get(h)!;
        list.forEach((pl, k) => {
          const slot = k % SLOTS;
          const row = Math.floor(k / SLOTS);
          pos.set(pl.local, { x: (hi * SLOTS + slot) * COL_W, y: top + row * ROW_H, due: dueAt(base, h, k, list.length) });
        });
      });
      const hubY = top + ((rows - 1) * ROW_H) / 2;
      hubYs.push(hubY);
      const hub = makeNode({
        id: idFor(`hub-${theme.key}`),
        type: "goal",
        title: theme.hubTitle,
        body: `${theme.hubBody}\n（テーマ「${theme.name}」: やりたいこと ${theme.items.length} 件・分岐 ${theme.branches.length} 個）`,
        projectIds: [p.id],
        tags: ["やりたいこと"],
        x: -COL_W,
        y: hubY,
      });
      doc.nodes[hub.id] = hub;
      addEdge(root.id, hub.id, "leads");

      for (const it of theme.items) {
        const at = pos.get(it[0])!;
        const n: GNode = makeNode({
          id: idFor(it[0]),
          type: it[1] as NodeType,
          title: it[2],
          body: it[3],
          time: { due: at.due, start: null },
          tags: it[5],
          conditions: it[7].map((c) => makeCondition(c, false)),
          projectIds: [p.id],
          x: at.x,
          y: at.y,
        });
        doc.nodes[n.id] = n;
        local2id.set(it[0], n.id);
      }
      for (const b of theme.branches) {
        const at = pos.get(b[0])!;
        const n = makeNode({
          id: idFor(b[0]),
          type: "branch",
          title: b[1],
          body: b[2],
          time: { due: at.due, start: null },
          tags: ["判断"],
          conditions: b[5].map((c) => makeCondition(c, false)),
          projectIds: [p.id],
          x: at.x,
          y: at.y,
        });
        doc.nodes[n.id] = n;
        local2id.set(b[0], n.id);
      }

      // テーマの中のつながり: 先にやること → やりたいこと、分岐 → 選択肢
      const next = new Map<string, string[]>();
      const link = (from: string, to: string, relation: Relation, condition = "", scen: ScenarioKey = "") => {
        if (from === to) return;
        addEdge(local2id.get(from)!, local2id.get(to)!, relation, "", condition, scen);
        next.set(from, [...(next.get(from) ?? []), to]);
      };
      const known = (l: string) => local2id.has(l) && pos.has(l);
      for (const it of theme.items) for (const a of it[6]) if (known(a)) link(a, it[0], "leads");
      for (const b of theme.branches) {
        for (const a of b[4]) if (known(a)) link(a, b[0], "leads");
        for (const [to, when, scen] of b[6]) if (known(to)) link(b[0], to, "condition", when, scen);
      }
      // 見出しから入る: 入口の無いもの、それでも届かないもの（輪の中だけでつながっているもの）の順に
      const order = [...theme.items.map((it) => it[0]), ...theme.branches.map((b) => b[0])];
      const hasIn = new Set([...next.values()].flat());
      const reached = new Set<string>();
      const enter = (l: string) => {
        addEdge(hub.id, local2id.get(l)!, "leads");
        const stack = [l];
        reached.add(l);
        while (stack.length) for (const t of next.get(stack.pop()!) ?? []) if (!reached.has(t)) (reached.add(t), stack.push(t));
      };
      for (const l of order) if (!hasIn.has(l)) enter(l);
      for (const l of order) if (!reached.has(l)) enter(l);

      y = top + rows * ROW_H + THEME_GAP;
    }
    root.y = hubYs.length ? (hubYs[0]! + hubYs[hubYs.length - 1]!) / 2 : y;
    y += AREA_GAP - THEME_GAP;
  }

  // 領域をまたぐつながり（相乗効果・阻害・条件）
  const seen = new Set<string>();
  for (const [from, to, rel, label] of data.links) {
    const a = local2id.get(from);
    const b = local2id.get(to);
    if (!a || !b || a === b) continue;
    const k = `${a}>${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    addEdge(a, b, rel, rel === "condition" ? "" : label, rel === "condition" ? label : "");
  }
  return doc;
}

/** やりたいこと（目標・行動・結果）の件数（分岐・見出しは数えない） */
export function countWishes(data: WishData): number {
  return data.areas.reduce((n, a) => n + a.themes.reduce((m, t) => m + t.items.length, 0), 0);
}
