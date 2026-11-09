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

/**
 * ID として使える形か（空白なし・100 文字まで）。Object の組み込みの名前（constructor・toString・__proto__ など）は
 * 辞書を引き間違えるので使わない。数（AI や表計算が書きがちな 1, 2, 3）は文字にして受ける
 */
function idOf(v: unknown): string | null {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
  if (typeof s !== "string" || s.length === 0 || s.length > 100 || /\s/.test(s)) return null;
  if (s in Object.prototype) return null;
  return s;
}

function validId(v: unknown): v is string {
  return typeof v === "string" && idOf(v) !== null;
}

/** ほかから指すときに書かれていた名前（接続の端・所属など）。照らし合わせ用 */
function refOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 辞書に自分の項目として持っているか（組み込みの名前に引っかからない） */
const has = (o: object, k: string): boolean => Object.hasOwn(o, k);

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
    let extra: Obj = {};
    if (typeof raw === "string") text = raw;
    else if (isObj(raw)) {
      text = str(raw.text);
      met = raw.met === true;
      id = validId(raw.id) ? raw.id : null;
      extra = extras(raw, CONDITION_KEYS); // 知らない項目は持ち越す
    } else continue;
    // 文が空でも、チェック済みや知らない項目があれば残す（読み込みのたびに黙って消さない）
    if (!text.trim() && !met && Object.keys(extra).length === 0) continue;
    if (!id || seen.has(id)) id = newId("c");
    seen.add(id);
    out.push({ ...extra, id, text, met });
  }
  return out;
}

/** ID の並び（所属・順番）。振り直した ID へ読み替え、無い物と重なりは外す */
function idList(v: unknown, map: object, remap?: ReadonlyMap<string, ID>): ID[] {
  if (!Array.isArray(v)) return [];
  const out: ID[] = [];
  for (const raw of v) {
    const ref = refOf(raw);
    if (ref === null) continue;
    const id = remap?.get(ref) ?? ref;
    if (has(map, id) && !out.includes(id)) out.push(id);
  }
  return out;
}

const CONDITION_KEYS = new Set(["id", "text", "met"]);
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

  // プロジェクト・シナリオ（使えない形の ID は振り直し、ノードや接続からの参照も読み替える）
  const projectRemap = new Map<string, ID>();
  const scenarioRemap = new Map<string, ID>();
  const groups = <T extends Project | Scenario>(v: unknown, kind: "projects" | "scenarios", palette: string[], label: string, remap: Map<string, ID>): Record<ID, T> => {
    const out: Record<ID, T> = {};
    let i = 0;
    for (const { key, value } of entriesOf(v)) {
      if (!isObj(value)) {
        dropped[kind]++;
        continue;
      }
      let id = idOf(value.id) ?? (key !== null ? idOf(key) : null);
      if (!id || has(out, id)) {
        if (id) warnings.push(`${label}の ID「${id}」が重複していたので、新しい ID を振りました。`);
        const fresh = newId(kind === "projects" ? "p" : "s");
        const ref = refOf(value.id) ?? key;
        if (!id && ref !== null && !remap.has(ref)) remap.set(ref, fresh);
        id = fresh;
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
  const projects = groups<Project>(raw.projects, "projects", PROJECT_COLORS, "プロジェクト", projectRemap);
  const scenarios = groups<Scenario>(raw.scenarios, "scenarios", SCENARIO_COLORS, "シナリオ", scenarioRemap);

  // ノード
  const nodes: Record<ID, GNode> = {};
  const nodeRemap = new Map<string, ID>();
  let unplaced = 0;
  let renamed = 0;
  let badDates = 0;
  let badDateExample = "";
  for (const { key, value } of entriesOf(raw.nodes)) {
    if (!isObj(value)) {
      dropped.nodes++;
      continue;
    }
    let id = idOf(value.id) ?? (key !== null ? idOf(key) : null);
    const ref = refOf(value.id) ?? key;
    if (!id) {
      if (ref !== null && nodeRemap.has(ref)) {
        warnings.push(`ノードの ID「${ref.slice(0, 40)}」が重複していたので、後の方を捨てました。`);
        dropped.nodes++;
        continue;
      }
      // 使えない形の ID（空白入り・組み込みの名前など）は振り直し、接続はそのままつなぐ。ID の無いノードも新しい ID で残す
      id = newId("n");
      if (ref !== null) {
        nodeRemap.set(ref, id);
        renamed++;
      } else warnings.push(`ID の無いノード「${str(value.title).slice(0, 20)}」に新しい ID を振りました。`);
    } else if (has(nodes, id)) {
      warnings.push(`ノードの ID「${id}」が重複していたので、後の方を捨てました。`);
      dropped.nodes++;
      continue;
    }
    const type: NodeType = NODE_TYPE_ORDER.includes(value.type as NodeType) ? (value.type as NodeType) : "action";
    if (value.type !== undefined && type !== value.type) warnings.push(`ノード「${str(value.title).slice(0, 20)}」の種類「${str(value.type)}」は使えないので「行動」にしました。`);
    const status: NodeStatus = STATUS_ORDER.includes(value.status as NodeStatus) ? (value.status as NodeStatus) : "open";
    const rawTime = isObj(value.time) ? value.time : {};
    const rawDue = rawTime.due ?? value.due ?? value.deadline ?? null;
    const rawStart = rawTime.start ?? null;
    const due = normalizeDateStr(rawDue);
    const start = normalizeDateStr(rawStart);
    for (const [r, v] of [[rawDue, due], [rawStart, start]] as const) {
      if (v === null && r !== null && r !== "") {
        badDates++;
        if (!badDateExample) badDateExample = `「${str(value.title).slice(0, 20)}」の「${str(r).slice(0, 30)}」`;
      }
    }
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
      projectIds: idList(value.projectIds, projects, projectRemap),
      scenarioIds: idList(value.scenarioIds, scenarios, scenarioRemap),
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      collapsed: value.collapsed === true,
      createdAt: isoOr(value.createdAt, now),
      updatedAt: isoOr(value.updatedAt, now),
      meta: metaOf(value.meta),
    } as GNode;
  }
  if (unplaced) warnings.push(`位置の無いノード ${unplaced} 件を下の方に並べました。`);
  if (renamed) warnings.push(`使えない形の ID（空白入りなど）を持つノード ${renamed} 件に新しい ID を振りました（接続はそのままつなぎました）。`);
  if (badDates) warnings.push(`日付として読めない期限・開始日 ${badDates} 件を外しました（例: ${badDateExample}）。`);

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
    // 接続の端は from / to でも受ける（AI が書きがちな形）。振り直したノードの ID へ読み替える
    const end = (v: unknown): string => {
      const r = refOf(v);
      return r === null ? "" : (nodeRemap.get(r) ?? r);
    };
    const source = end(value.source ?? value.from);
    const target = end(value.target ?? value.to);
    if (!has(nodes, source) || !has(nodes, target) || source === target) {
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
    let id = idOf(value.id) ?? (key !== null ? idOf(key) : null);
    if (!id || has(edges, id)) id = newId("e");
    pairs.add(pair);
    const relation: Relation = RELATION_ORDER.includes(value.relation as Relation) ? (value.relation as Relation) : "leads";
    const extra = extras(value, EDGE_KEYS);
    if (value.source === undefined) delete extra.from;
    if (value.target === undefined) delete extra.to;
    edges[id] = {
      ...extra,
      id,
      source,
      target,
      relation,
      label: str(value.label),
      condition: str(value.condition),
      scenarioIds: idList(value.scenarioIds, scenarios, scenarioRemap),
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

  const order = (v: unknown, map: Record<ID, Project | Scenario>, remap: ReadonlyMap<string, ID>): ID[] => {
    const out = idList(v, map, remap);
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
    projectOrder: order(raw.projectOrder, projects, projectRemap),
    scenarioOrder: order(raw.scenarioOrder, scenarios, scenarioRemap),
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
