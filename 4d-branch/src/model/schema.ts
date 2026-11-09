// ドキュメントの作成・検証・正規化・版の移行。設計: docs/DESIGN.md §3.6・§3.10
// 方針: 壊れた要素は捨てて警告に出す（全体は捨てない）／知らない項目は消さずに持ち越す

import { NODE_TYPE_ORDER, PROJECT_COLORS, RELATION_ORDER, SCENARIO_COLORS, STATUS_ORDER } from "./constants";
import { normalizeDateStr } from "./dates";
import { newId, nowISO } from "./ids";
import type { Condition, DocData, GEdge, GNode, ID, Meta, NodeStatus, NodeType, Project, Relation, Scenario } from "./types";

export const SCHEMA = "4d-branch" as const;
export const SCHEMA_VERSION = 1;

/** 読み込めないファイル（理由は日本語で利用者に見せる） */
export class DocFormatError extends Error {
  override name = "DocFormatError";
}

export interface NormalizeReport {
  warnings: string[];
  dropped: { nodes: number; edges: number; projects: number; scenarios: number };
}

// ---------------------------------------------------------------- 作成

export function createEmptyDoc(title = "マイ・ブランチ"): DocData {
  const t = nowISO();
  return {
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    id: newId("d"),
    title,
    createdAt: t,
    updatedAt: t,
    projects: {},
    scenarios: {},
    nodes: {},
    edges: {},
    projectOrder: [],
    scenarioOrder: [],
    meta: {},
  };
}

export function makeNode(init: Partial<GNode> = {}): GNode {
  const t = nowISO();
  return {
    id: init.id ?? newId("n"),
    type: init.type ?? "action",
    title: init.title ?? "",
    body: init.body ?? "",
    status: init.status ?? "open",
    time: { due: init.time?.due ?? null, start: init.time?.start ?? null },
    conditions: init.conditions ?? [],
    tags: init.tags ?? [],
    projectIds: init.projectIds ?? [],
    scenarioIds: init.scenarioIds ?? [],
    x: init.x ?? 0,
    y: init.y ?? 0,
    collapsed: init.collapsed ?? false,
    createdAt: init.createdAt ?? t,
    updatedAt: init.updatedAt ?? t,
    meta: init.meta ?? {},
  };
}

export function makeEdge(init: Partial<GEdge> & { source: ID; target: ID }): GEdge {
  const t = nowISO();
  return {
    id: init.id ?? newId("e"),
    source: init.source,
    target: init.target,
    relation: init.relation ?? "leads",
    label: init.label ?? "",
    condition: init.condition ?? "",
    scenarioIds: init.scenarioIds ?? [],
    collapsed: init.collapsed ?? false,
    createdAt: init.createdAt ?? t,
    updatedAt: init.updatedAt ?? t,
    meta: init.meta ?? {},
  };
}

export function makeProject(init: Partial<Project> & { name: string }): Project {
  const t = nowISO();
  return {
    id: init.id ?? newId("p"),
    name: init.name,
    color: init.color ?? PROJECT_COLORS[0]!,
    description: init.description ?? "",
    createdAt: init.createdAt ?? t,
    updatedAt: init.updatedAt ?? t,
    meta: init.meta ?? {},
  };
}

export function makeScenario(init: Partial<Scenario> & { name: string }): Scenario {
  const t = nowISO();
  return {
    id: init.id ?? newId("s"),
    name: init.name,
    color: init.color ?? SCENARIO_COLORS[0]!,
    description: init.description ?? "",
    createdAt: init.createdAt ?? t,
    updatedAt: init.updatedAt ?? t,
    meta: init.meta ?? {},
  };
}

export function makeCondition(text: string, met = false): Condition {
  return { id: newId("c"), text, met };
}

// ---------------------------------------------------------------- 正規化の部品

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 知らない項目を持ち越す（新しい版で足された項目を古い版で消さない） */
function extras(raw: Obj, known: ReadonlySet<string>): Obj {
  const out: Obj = {};
  for (const k of Object.keys(raw)) {
    if (known.has(k) || FORBIDDEN_KEYS.has(k)) continue;
    out[k] = raw[k];
  }
  return out;
}

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function validId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 100 && !/\s/.test(v);
}

function isoOr(v: unknown, fallback: string): string {
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return v;
  return fallback;
}

function metaOf(v: unknown): Meta {
  return isObj(v) ? { ...v } : {};
}

function colorOr(v: unknown, fallback: string): string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : fallback;
}

/** 配列でも ID をキーにしたオブジェクトでも受ける */
function entriesOf(v: unknown): Array<{ key: string | null; value: unknown }> {
  if (Array.isArray(v)) return v.map((value) => ({ key: null, value }));
  if (isObj(v)) return Object.keys(v).filter((k) => !FORBIDDEN_KEYS.has(k)).map((key) => ({ key, value: v[key] }));
  return [];
}

export function normalizeTag(t: string): string {
  return t.normalize("NFKC").trim().replace(/^#+/, "").replace(/\s+/g, " ").slice(0, 64);
}

export function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const t = normalizeTag(raw);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

function normalizeConditions(v: unknown): Condition[] {
  if (!Array.isArray(v)) return [];
  const out: Condition[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    let text = "";
    let met = false;
    let id: string | null = null;
    if (typeof raw === "string") text = raw;
    else if (isObj(raw)) {
      text = str(raw.text);
      met = raw.met === true;
      id = validId(raw.id) ? raw.id : null;
    }
    if (!text.trim()) continue;
    if (!id || seen.has(id)) id = newId("c");
    seen.add(id);
    out.push({ id, text, met });
  }
  return out;
}

function idList(v: unknown, exists: (id: string) => boolean): ID[] {
  if (!Array.isArray(v)) return [];
  const out: ID[] = [];
  for (const id of v) if (typeof id === "string" && exists(id) && !out.includes(id)) out.push(id);
  return out;
}

const NODE_KEYS = new Set(["id", "type", "title", "body", "status", "time", "conditions", "tags", "projectIds", "scenarioIds", "x", "y", "collapsed", "createdAt", "updatedAt", "meta"]);
const TIME_KEYS = new Set(["due", "start"]);
const EDGE_KEYS = new Set(["id", "source", "target", "relation", "label", "condition", "scenarioIds", "collapsed", "createdAt", "updatedAt", "meta"]);
const GROUP_KEYS = new Set(["id", "name", "color", "description", "createdAt", "updatedAt", "meta"]);
const DOC_KEYS = new Set(["schema", "version", "id", "title", "createdAt", "updatedAt", "projects", "scenarios", "nodes", "edges", "projectOrder", "scenarioOrder", "meta"]);
/** 書き出しのときだけ付ける項目（読み込みでは持ち越さない） */
const EXPORT_ONLY_KEYS = new Set(["exportedAt", "app"]);

// ---------------------------------------------------------------- 版の移行

/** 古い版のファイルを今の版へ。新しすぎる版は読まない（勝手に壊さない） */
export function migrate(raw: Obj): Obj {
  const v = typeof raw.version === "number" && Number.isFinite(raw.version) ? Math.floor(raw.version) : SCHEMA_VERSION;
  if (v > SCHEMA_VERSION) {
    throw new DocFormatError(`このファイルは新しい版（スキーマ ${v}）の 4D Branch で作られています。アプリを新しくしてから読み込んでください。`);
  }
  const out = raw;
  // 版 1 が最初の版。版を上げるときはここに順に足す: if (v < 2) out = v1to2(out); …
  return { ...out, version: SCHEMA_VERSION };
}

// ---------------------------------------------------------------- 正規化

export function normalizeDoc(input: unknown): { doc: DocData; report: NormalizeReport } {
  if (!isObj(input)) throw new DocFormatError("4D Branch のデータの形ではありません（オブジェクトではない）。");
  const warnings: string[] = [];
  const dropped = { nodes: 0, edges: 0, projects: 0, scenarios: 0 };
  const now = nowISO();

  if (input.schema !== undefined && input.schema !== SCHEMA) {
    throw new DocFormatError("4D Branch のファイルではありません（schema が違います）。");
  }
  if (input.schema === undefined) {
    if (!("nodes" in input)) throw new DocFormatError("4D Branch のファイルではありません（nodes がありません）。");
    warnings.push("ファイルの種類の印（schema）がありません。4D Branch のデータとして読み込みました。");
  }
  const raw = migrate(input);

  // プロジェクト・シナリオ
  const groups = <T extends Project | Scenario>(v: unknown, kind: "projects" | "scenarios", palette: string[], label: string): Record<ID, T> => {
    const out: Record<ID, T> = {};
    let i = 0;
    for (const { key, value } of entriesOf(v)) {
      if (!isObj(value)) {
        dropped[kind]++;
        continue;
      }
      let id = validId(value.id) ? value.id : validId(key) ? key : null;
      if (!id || out[id]) {
        if (id) warnings.push(`${label}の ID「${id}」が重複していたので、新しい ID を振りました。`);
        id = newId(kind === "projects" ? "p" : "s");
      }
      const name = str(value.name).trim() || `無題の${label}`;
      out[id] = {
        ...extras(value, GROUP_KEYS),
        id,
        name,
        color: colorOr(value.color, palette[i % palette.length]!),
        description: str(value.description),
        createdAt: isoOr(value.createdAt, now),
        updatedAt: isoOr(value.updatedAt, now),
        meta: metaOf(value.meta),
      } as T;
      i++;
    }
    return out;
  };
  const projects = groups<Project>(raw.projects, "projects", PROJECT_COLORS, "プロジェクト");
  const scenarios = groups<Scenario>(raw.scenarios, "scenarios", SCENARIO_COLORS, "シナリオ");

  // ノード
  const nodes: Record<ID, GNode> = {};
  let unplaced = 0;
  for (const { key, value } of entriesOf(raw.nodes)) {
    if (!isObj(value)) {
      dropped.nodes++;
      continue;
    }
    let id = validId(value.id) ? value.id : validId(key) ? key : null;
    if (!id) {
      // ID の無いノードは接続でたどれないので、新しい ID で残す
      id = newId("n");
      warnings.push(`ID の無いノード「${str(value.title).slice(0, 20)}」に新しい ID を振りました。`);
    } else if (nodes[id]) {
      warnings.push(`ノードの ID「${id}」が重複していたので、後の方を捨てました。`);
      dropped.nodes++;
      continue;
    }
    const type: NodeType = NODE_TYPE_ORDER.includes(value.type as NodeType) ? (value.type as NodeType) : "action";
    if (value.type !== undefined && type !== value.type) warnings.push(`ノード「${str(value.title).slice(0, 20)}」の種類「${str(value.type)}」は使えないので「行動」にしました。`);
    const status: NodeStatus = STATUS_ORDER.includes(value.status as NodeStatus) ? (value.status as NodeStatus) : "open";
    const rawTime = isObj(value.time) ? value.time : {};
    const due = normalizeDateStr(rawTime.due ?? value.due ?? value.deadline ?? null);
    const start = normalizeDateStr(rawTime.start ?? null);
    let x = typeof value.x === "number" && Number.isFinite(value.x) ? value.x : NaN;
    let y = typeof value.y === "number" && Number.isFinite(value.y) ? value.y : NaN;
    if (Number.isNaN(x) || Number.isNaN(y)) {
      // 位置の無いノードは格子に並べる
      x = (unplaced % 6) * 300;
      y = 2000 + Math.floor(unplaced / 6) * 140;
      unplaced++;
    }
    nodes[id] = {
      ...extras(value, NODE_KEYS),
      id,
      type,
      title: str(value.title),
      body: str(value.body),
      status,
      time: { ...extras(rawTime, TIME_KEYS), due, start },
      conditions: normalizeConditions(value.conditions),
      tags: normalizeTags(value.tags),
      projectIds: idList(value.projectIds, (p) => p in projects),
      scenarioIds: idList(value.scenarioIds, (s) => s in scenarios),
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      collapsed: value.collapsed === true,
      createdAt: isoOr(value.createdAt, now),
      updatedAt: isoOr(value.updatedAt, now),
      meta: metaOf(value.meta),
    } as GNode;
  }
  if (unplaced) warnings.push(`位置の無いノード ${unplaced} 件を下の方に並べました。`);

  // 接続
  const edges: Record<ID, GEdge> = {};
  const pairs = new Set<string>();
  let badEnds = 0;
  let dupes = 0;
  for (const { key, value } of entriesOf(raw.edges)) {
    if (!isObj(value)) {
      dropped.edges++;
      continue;
    }
    const source = str(value.source);
    const target = str(value.target);
    if (!(source in nodes) || !(target in nodes) || source === target) {
      badEnds++;
      dropped.edges++;
      continue;
    }
    const pair = `${source}>${target}`;
    if (pairs.has(pair)) {
      dupes++;
      dropped.edges++;
      continue;
    }
    let id = validId(value.id) ? value.id : validId(key) ? key : null;
    if (!id || edges[id]) id = newId("e");
    pairs.add(pair);
    const relation: Relation = RELATION_ORDER.includes(value.relation as Relation) ? (value.relation as Relation) : "leads";
    edges[id] = {
      ...extras(value, EDGE_KEYS),
      id,
      source,
      target,
      relation,
      label: str(value.label),
      condition: str(value.condition),
      scenarioIds: idList(value.scenarioIds, (s) => s in scenarios),
      collapsed: value.collapsed === true,
      createdAt: isoOr(value.createdAt, now),
      updatedAt: isoOr(value.updatedAt, now),
      meta: metaOf(value.meta),
    } as GEdge;
  }
  if (badEnds) warnings.push(`つながる先のノードが無い（または自分自身への）接続 ${badEnds} 件を捨てました。`);
  if (dupes) warnings.push(`同じ向きに重なっていた接続 ${dupes} 件を 1 本にまとめました。`);
  if (dropped.nodes) warnings.push(`読めないノード ${dropped.nodes} 件を捨てました。`);
  if (dropped.projects) warnings.push(`読めないプロジェクト ${dropped.projects} 件を捨てました。`);
  if (dropped.scenarios) warnings.push(`読めないシナリオ ${dropped.scenarios} 件を捨てました。`);

  const order = (v: unknown, map: Record<ID, Project | Scenario>): ID[] => {
    const out = idList(v, (id) => id in map);
    const rest = Object.values(map)
      .filter((g) => !out.includes(g.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return [...out, ...rest.map((g) => g.id)];
  };

  const docExtras = extras(raw, DOC_KEYS);
  for (const k of EXPORT_ONLY_KEYS) delete docExtras[k];

  const doc: DocData = {
    ...docExtras,
    schema: SCHEMA,
    version: SCHEMA_VERSION,
    id: validId(raw.id) ? raw.id : newId("d"),
    title: str(raw.title).trim() || "マイ・ブランチ",
    createdAt: isoOr(raw.createdAt, now),
    updatedAt: isoOr(raw.updatedAt, now),
    projects,
    scenarios,
    nodes,
    edges,
    projectOrder: order(raw.projectOrder, projects),
    scenarioOrder: order(raw.scenarioOrder, scenarios),
    meta: metaOf(raw.meta),
  };
  return { doc, report: { warnings, dropped } };
}

/** JSON の文字列から読む（取り込み・バックアップの復元） */
export function parseDocText(text: string): { doc: DocData; report: NormalizeReport } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DocFormatError("JSON として読めません。ファイルが壊れているか、別の形式です。");
  }
  return normalizeDoc(raw);
}

/** 書き出し用の JSON（そのまま取り込める） */
export function serializeDoc(doc: DocData, appVersion: string): string {
  const out = { ...doc, exportedAt: nowISO(), app: { name: "4D Branch", version: appVersion } };
  return JSON.stringify(out, null, 2);
}

export function docCounts(doc: DocData): { nodes: number; edges: number; projects: number; scenarios: number } {
  return {
    nodes: Object.keys(doc.nodes).length,
    edges: Object.keys(doc.edges).length,
    projects: Object.keys(doc.projects).length,
    scenarios: Object.keys(doc.scenarios).length,
  };
}

/** 入れ物（Record と配列）だけ複製する。中のエンティティは不変として共有する */
export function cloneDocShallow(doc: DocData): DocData {
  return {
    ...doc,
    projects: { ...doc.projects },
    scenarios: { ...doc.scenarios },
    nodes: { ...doc.nodes },
    edges: { ...doc.edges },
    projectOrder: [...doc.projectOrder],
    scenarioOrder: [...doc.scenarioOrder],
    meta: { ...doc.meta },
  };
}
