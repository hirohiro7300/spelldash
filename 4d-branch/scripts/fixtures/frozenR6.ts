// 版 6 のページ（版 6 の同梱データを持っていた最後の版）が「未来の道筋を読み込む」で作った地図の文書の、凍結した写し（見直し found-1）。
// 合成のアカウントの文書 tests/fixtures/account-r6.json は「版 6 のページが書いた形」のまま変えないので、その作り方はアプリの今のコードを読まない:
//   組み立て（src/demo/impact.ts の buildImpactDoc）・並べ方（src/model/impactLayout.ts の outlineLayout と列の位置）・入れ物の形と検証
//   （src/model/schema.ts の makeNode・makeEdge・makeProject・makeScenario・normalizeDoc）・決まり（SCHEMA_VERSION・DEFAULT_DOC_TITLE・
//   src/model/constants.ts の NODE_W・src/persist/io.ts の nameKey）と、その型は、P2 でほかの仕事が変える。ここには版 6 の時の物を写して持つ
//   （型もここで決める）。版 6 のページの組み立ての後に検証（normalizeDoc）を通した物と同じ文書を、検証を通さずに初めから作る
//   （どの物も検証と同じ項目の順・同じ値。版 6 の同梱データには検証で直る所が無い）。
// 今のアプリがこの文書を読めるか（今の normalizeDoc で何も直されないか）は tests/unit/fixturesR6.test.ts が別に確かめる。
// 読めなくなったら（W-store の移行など）、この写しや文書ではなく、読み手かそのテストの答え（引き上げた後の形）を直す。

/** 版 6 のページの文書の形の印と版（src/model/schema.ts の SCHEMA・SCHEMA_VERSION。版 6 では 1） */
export const R6_SCHEMA = "4d-branch";
export const R6_SCHEMA_VERSION = 1;
/** 版 6 のページの新しい文書の名前（DEFAULT_DOC_TITLE） */
export const R6_DEFAULT_DOC_TITLE = "マイ・ブランチ";
/** 版 6 のページのカードの幅（NODE_W。「追加する」の取り込みで右へずらす幅に入る） */
export const R6_NODE_W = 212;

const R6_IMPACT_TITLE = "未来の道筋（仕事・3 年の分かれ道）";
/** 3 年の分かれ道の並べ方（impactLayout.ts の IMPACT_X・IMPACT_ROW・IMPACT_GROUP_GAP） */
const R6_IMPACT_X = [0, 300, 700, 1000, 1400, 1700, 2100];
const R6_IMPACT_ROW = 128;
const R6_IMPACT_GROUP_GAP = 24;

const R6_AREAS = {
  sd: { id: "p_spelldash", name: "SpellDash事業", color: "#FF7A59", description: "英単語学習ゲーム SpellDash を事業として伸ばす。" },
  fc: { id: "p_fcmarketing", name: "FCマーケティングでの業務", color: "#22D3EE", description: "会社での広告運用の仕事。成果と評価を積み上げる。" },
  ind: { id: "p_independence", name: "広告運用事業での独立", color: "#A3E635", description: "広告運用代行として独立し、自分の事業にする。" },
} as const;
const R6_SCENARIOS = [
  { id: "s_balance", name: "両立（基本）", color: "#8B7BFF", description: "会社員を続けながら、SpellDash と副業を同時に育てる。" },
  { id: "s_early", name: "早期独立", color: "#F2C14E", description: "2027 年中に副業の条件を満たし、独立する。" },
  { id: "s_focus", name: "SpellDash集中", color: "#4FD1E8", description: "広告に頼らずオーガニックで伸ばし、SpellDash に時間を寄せる。" },
] as const;

// ---- 版 6 の文書の形（src/model/types.ts の版 6 の時の物）

export type R6Meta = Record<string, unknown>;
export type R6NodeType = "goal" | "action" | "branch" | "result";
export type R6Relation = "leads" | "condition" | "supports" | "blocks" | "feedback";
export interface R6Group {
  id: string;
  name: string;
  color: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  meta: R6Meta;
}
export interface R6Condition {
  id: string;
  text: string;
  met: boolean;
}
export interface R6Node {
  id: string;
  type: R6NodeType;
  title: string;
  body: string;
  status: "open" | "active" | "done" | "dropped";
  time: { due: string | null; start: string | null };
  conditions: R6Condition[];
  tags: string[];
  projectIds: string[];
  scenarioIds: string[];
  x: number;
  y: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  meta: R6Meta;
}
export interface R6Edge {
  id: string;
  source: string;
  target: string;
  relation: R6Relation;
  label: string;
  condition: string;
  scenarioIds: string[];
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  meta: R6Meta;
}
export interface R6Doc {
  schema: string;
  version: number;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  projects: Record<string, R6Group>;
  scenarios: Record<string, R6Group>;
  nodes: Record<string, R6Node>;
  edges: Record<string, R6Edge>;
  projectOrder: string[];
  scenarioOrder: string[];
  meta: R6Meta;
}

// ---- 版 6 の同梱データの形（src/demo/impact.ts の ImpactBundle v2。使う所だけ）

type R6Role = "r" | "a" | "s" | "e";
interface R6AltX {
  k: string;
  h: number;
  base?: 1;
  todo?: string[];
  cites?: string[];
  len: number;
}
interface R6OutX {
  p: number;
  lab: string;
  line: string;
  ln: unknown;
  r: unknown;
  st: unknown;
  rr: unknown;
  rv?: unknown;
}
interface R6RootX {
  st: unknown;
  rr: unknown;
}
/** [鍵, 親の番号, 役割, 月, タイトル, 短い名前, 本文, 中身] */
type R6BNode = [string, number, R6Role, number, string, string, string, R6RootX | R6AltX | R6OutX];
export interface R6Bundle {
  v: 2;
  kind: "impact3y";
  title: string;
  horizon: number;
  kinds: Record<string, [string, "sd" | "fc" | "ind" | "base", string, string[]]>;
  fams?: Record<string, string>;
  nodes: R6BNode[];
}
/** 版の記録（tests/fixtures/impact-r6-release.json） */
export interface R6Release {
  release: number;
  version: string;
}

// ---- 版 6 の小さな決まり

/** 文字列の指紋（FNV-1a の 36 進。impact.ts の fnv36） */
export function r6Fnv36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
/** 鍵からのノードの ID（版 6: n_i_ + FNV-1a の 36 進 7 桁） */
const r6NodeId = (key: string): string => `n_i_${r6Fnv36(key).padStart(7, "0")}`;
/** 線の説明と条件の指紋（edgeTextPrint） */
const r6EdgeTextPrint = (label: string, condition: string): string => r6Fnv36(`${label}\u0000${condition}`);

/** 名前の比べ方（io.ts の nameKey = search.ts の normalizeText(name.trim())） */
export function r6NameKey(name: string): string {
  return name
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/** 読み込んだ日（年・月 1〜12・日。端末の時差に依らない） */
export interface R6Day {
  year: number;
  month: number;
  day: number;
}
const pad2 = (n: number): string => String(n).padStart(2, "0");
const daysIn = (y: number, m0: number): number => (m0 === 1 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m0]!);
/** 読み込んだ日から off か月後の月の末日（off が 0 以下なら読み込んだ日。impact.ts の monthDate を整数の月で） */
function r6MonthDate(d: R6Day, off: number): string {
  if (off <= 0) return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
  const total = d.year * 12 + d.month - 1 + off;
  const y = Math.floor(total / 12);
  const m0 = total % 12;
  return `${y}-${pad2(m0 + 1)}-${pad2(daysIn(y, m0))}`;
}

const ROLE_TAG: Record<R6Role, (m: number) => string> = {
  r: () => "今日",
  a: () => "選択肢",
  s: (m) => (m === 3 ? "3か月後" : m === 12 ? "1年後" : `${m}か月後`),
  e: () => "3年後",
};
const r6CardTags = (role: R6Role, m: number): string[] => ["未来の道筋", "3年", ROLE_TAG[role](m)];

const r6ColX = (depth: number): number => {
  const last = R6_IMPACT_X.length - 1;
  return depth <= last ? R6_IMPACT_X[depth]! : R6_IMPACT_X[last]! + 300 * (depth - last);
};

/** 目次の形に並べる（impactLayout.ts の outlineLayout。入口の木だけ） */
function r6OutlineLayout(root: string, kids: (id: string) => string[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  let cursor = 0;
  interface Frame {
    id: string;
    depth: number;
    list: string[];
    i: number;
    firstY: number | null;
    prevHadKids: boolean;
  }
  const open = (id: string, depth: number): Frame | null => {
    pos.set(id, { x: r6ColX(depth), y: cursor });
    const list = kids(id).filter((k) => !pos.has(k));
    if (!list.length) {
      cursor += R6_IMPACT_ROW;
      return null;
    }
    return { id, depth, list, i: 0, firstY: null, prevHadKids: false };
  };
  const stack: Frame[] = [];
  const f0 = open(root, 0);
  if (f0) stack.push(f0);
  while (stack.length) {
    const f = stack[stack.length - 1]!;
    if (f.i >= f.list.length) {
      stack.pop();
      pos.get(f.id)!.y = f.firstY ?? pos.get(f.id)!.y;
      const parent = stack[stack.length - 1];
      if (parent) parent.prevHadKids = true;
      continue;
    }
    const k = f.list[f.i]!;
    f.i++;
    if (pos.has(k)) continue;
    if (f.i > 1 && f.prevHadKids) cursor += R6_IMPACT_GROUP_GAP;
    f.prevHadKids = false;
    const child = open(k, f.depth + 1);
    if (f.firstY === null) f.firstY = pos.get(k)!.y;
    if (child) stack.push(child);
  }
  return pos;
}

/** 版 6 の検証の後のノード（項目の順は makeNode・normalizeDoc と同じ） */
function node(x: Omit<R6Node, "scenarioIds" | "collapsed" | "createdAt" | "updatedAt">, at: string): R6Node {
  return { id: x.id, type: x.type, title: x.title, body: x.body, status: x.status, time: { due: x.time.due, start: x.time.start }, conditions: x.conditions, tags: x.tags, projectIds: x.projectIds, scenarioIds: [], x: x.x, y: x.y, collapsed: false, createdAt: at, updatedAt: at, meta: x.meta };
}
const group = (g: { id: string; name: string; color: string; description: string }, at: string): R6Group => ({ id: g.id, name: g.name, color: g.color, description: g.description, createdAt: at, updatedAt: at, meta: {} });

/**
 * 版 6 のページが同梱データを地図の文書にした物（buildImpactDoc の後に検証を通した物と同じ。カード・線・プロジェクト・シナリオの時刻は at）。
 * 期限は読み込んだ日 day から数える。入口には版（release.version）と版の順番（release.release）。文書そのものの ID と時刻は持たない
 * （「追加する」で取り込む側なので使わない）
 */
export function buildR6MapDoc(b: R6Bundle, day: R6Day, release: R6Release, at: string): Omit<R6Doc, "id" | "createdAt" | "updatedAt"> {
  const projects: Record<string, R6Group> = {};
  const projectOrder: string[] = [];
  for (const a of Object.values(R6_AREAS)) {
    projects[a.id] = group(a, at);
    projectOrder.push(a.id);
  }
  const scenarios: Record<string, R6Group> = {};
  const scenarioOrder: string[] = [];
  for (const s of R6_SCENARIOS) {
    scenarios[s.id] = group(s, at);
    scenarioOrder.push(s.id);
  }
  const all = Object.values(R6_AREAS).map((a) => a.id);
  const ids = b.nodes.map((n) => r6NodeId(n[0]));
  if (new Set(ids).size !== ids.length) throw new Error("版 6 の地図: ノードの ID が重なりました");
  const kids: number[][] = b.nodes.map(() => []);
  b.nodes.forEach((n, i) => {
    if (n[1] >= 0) kids[n[1]]!.push(i);
  });
  const index = new Map(ids.map((id, i) => [id, i]));
  const pos = r6OutlineLayout(ids[0]!, (id) => kids[index.get(id)!]!.map((k) => ids[k]!));
  const rankOf = new Map<number, number>();
  for (const list of kids) list.forEach((k, r) => rankOf.set(k, r));
  const nodes: Record<string, R6Node> = {};
  const edges: Record<string, R6Edge> = {};
  let seq = 0;
  b.nodes.forEach((n, i) => {
    const [key, parent, role, m, title, short, body, x] = n;
    const id = ids[i]!;
    const p = pos.get(id) ?? { x: r6ColX(0), y: 0 };
    const tags = r6CardTags(role, m);
    const t0 = r6Fnv36(title);
    const b0 = r6Fnv36(body);
    let card: R6Node;
    if (role === "r") {
      const rx = x as R6RootX;
      const meta: R6Meta = { forecastRoot: true, futureVersion: release.version, futureRelease: release.release, impact: { v: 2, horizon: b.horizon }, fork: "decision", m: 0, short, st: rx.st, rr: rx.rr, key, t0, b0 };
      if (b.fams) meta.fams = { ...b.fams };
      card = node({ id, type: "goal", title, body, status: "open", time: { due: r6MonthDate(day, 0), start: null }, conditions: [], tags, projectIds: all, x: p.x, y: p.y, meta }, at);
    } else if (role === "a") {
      const ax = x as R6AltX;
      const kind = b.kinds[ax.k];
      const area = kind?.[1] ?? "base";
      const meta: R6Meta = { fork: "chance", m, ak: ax.k, fam: kind?.[2] ?? ax.k, h: ax.h };
      if (ax.base) meta.base = true;
      if (ax.cites?.length) meta.cites = ax.cites;
      Object.assign(meta, { rank: rankOf.get(i) ?? 0, short, key, t0, b0 });
      if (ax.todo?.length) meta.k0 = ax.todo.map((t) => r6Fnv36(t));
      const conditions = (ax.todo ?? []).map((t, k): R6Condition => ({ id: `c_${id.slice(4)}_${k}`, text: t, met: false }));
      card = node({ id, type: "action", title, body, status: "open", time: { due: r6MonthDate(day, m + ax.len), start: r6MonthDate(day, m) }, conditions, tags, projectIds: area === "base" ? all : [R6_AREAS[area].id], x: p.x, y: p.y, meta }, at);
    } else {
      const ox = x as R6OutX;
      const meta: R6Meta = role === "e" ? { end: true } : { fork: "decision" };
      Object.assign(meta, { m, short, st: ox.st, rr: ox.rr, rank: rankOf.get(i) ?? 0, key, t0, b0 });
      card = node({ id, type: role === "e" ? "result" : "branch", title, body, status: "open", time: { due: r6MonthDate(day, m), start: null }, conditions: [], tags, projectIds: all, x: p.x, y: p.y, meta }, at);
    }
    nodes[id] = card;
    if (parent < 0) return;
    const eid = `e_i_${(seq++).toString(36)}`;
    const e: R6Edge = { id: eid, source: ids[parent]!, target: id, relation: role === "a" ? "leads" : "condition", label: "", condition: "", scenarioIds: [], collapsed: false, createdAt: at, updatedAt: at, meta: {} };
    if (role === "a") {
      const ax = x as R6AltX;
      e.scenarioIds = ax.base ? [] : [...(b.kinds[ax.k]?.[3] ?? [])];
      e.meta = { c0: r6EdgeTextPrint("", "") };
    } else {
      const ox = x as R6OutX;
      e.label = ox.lab === "—" ? "" : ox.lab;
      e.condition = ox.line;
      const meta: R6Meta = { prob: ox.p, r: ox.r, ln: ox.ln };
      if (ox.rv) meta.rv = ox.rv;
      meta.p0 = ox.p;
      meta.c0 = r6EdgeTextPrint(e.label, e.condition);
      e.meta = meta;
    }
    edges[eid] = e;
  });
  return { schema: R6_SCHEMA, version: R6_SCHEMA_VERSION, title: b.title || R6_IMPACT_TITLE, projects, scenarios, nodes, edges, projectOrder, scenarioOrder, meta: {} };
}
