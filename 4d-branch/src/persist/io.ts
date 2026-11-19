// JSON のエクスポート・インポート（置き換え／追加）。設計: docs/DESIGN.md §3.10・§5
// 書き出しも取り込みも保存の口（./codec.ts）を通す: ページの地図を持つ文書は薄い形で書き出し、薄い形のファイルは地図から組み立て直して読む
// （前の版・違う組み立ての地図は、鍵でページの地図に当て直す。新しい版のファイルは今までどおり読まない）

import { NODE_W } from "../model/constants";
import { isForecastRoot } from "../model/forecast";
import { isFlowEdge } from "../model/forks";
import { newId } from "../model/ids";
import { cloneDocShallow, docCounts, DocFormatError, serializeDoc, type NormalizeReport } from "../model/schema";
import { normalizeText } from "../model/search";
import type { DocData, GEdge, GNode, ID } from "../model/types";
import { decodeStored, decodeStoredAsync, guardStoredSize, toStored, upgradeNotice, type ThinUpgradeInfo } from "./codec";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function exportFileName(date = new Date(), prefix = "4d-branch"): string {
  return `${prefix}_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}

/** 書き出す JSON（保存の口を通した形: ページの地図を持つ文書は薄い形。そのまま取り込める） */
export function exportText(doc: DocData, appVersion: string): string {
  const text = serializeDoc(toStored(doc), appVersion);
  guardStoredSize(text.length, "export");
  return text;
}

/** ブラウザでファイルとして保存させる */
export function downloadText(filename: string, text: string, mime = "application/json"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface ImportPreview {
  doc: DocData;
  report: NormalizeReport;
  counts: ReturnType<typeof docCounts>;
  /** 前の版・違う組み立ての地図を、鍵でページの地図に当て直して読んだ（数） */
  upgrade?: ThinUpgradeInfo;
}

/** ファイルの文字を JSON として読む（読めなければ取り込みと同じ文の DocFormatError） */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DocFormatError("JSON として読めません。ファイルが壊れているか、別の形式です。");
  }
}

/** 取り込みで読んだ物（当て直したら、その数を警告にも出す） */
function previewOf(d: { doc: DocData; report: NormalizeReport; upgrade?: ThinUpgradeInfo }): ImportPreview {
  const pv: ImportPreview = { doc: d.doc, report: d.report, counts: docCounts(d.doc) };
  if (d.upgrade) {
    const u = d.upgrade;
    pv.upgrade = u;
    pv.report = { ...d.report, warnings: [upgradeNotice(u, "import"), ...d.report.warnings] };
  }
  return pv;
}

/**
 * 読み込む前の確認用（検証して件数と警告を出す。失敗は DocFormatError）。薄い形のファイルは、ページの地図を読んであるときだけ読める
 * （まだなら previewImportAsync）。前の版・違う組み立ての地図は当て直す。新しい版のファイルは NewerDocError（今までと同じ文）
 */
export function previewImport(text: string): ImportPreview {
  return previewOf(decodeStored(parseJson(text), { upgrade: "any" }));
}

/** 読み込む前の確認用（薄い形のファイルなら、ページの地図を読み込んでから） */
export async function previewImportAsync(text: string): Promise<ImportPreview> {
  return previewOf(await decodeStoredAsync(parseJson(text), { upgrade: "any" }));
}

/** 同じ名前と見なす鍵（全角半角・大文字小文字・カタカナひらがなをそろえる） */
export const nameKey = (name: string) => normalizeText(name.trim());

/** 追加の取り込みの決め方 */
export interface MergeOpts {
  /** 位置のずらし方（差し替えで同じ場所に置く）。無ければ今のグラフの右へ */
  offset?: { dx: number; dy: number };
  /**
   * 鍵のある同梱のカード（meta.key）は、取り込む側の ID を空いていればそのまま使う（やることの項目・カードどうしの同梱の線も）。
   * ページの地図を足すとき（追加する・新しい版に差し替える）に使う: ID を振り直すと、薄い形の保存がカードごとの読み替えで大きくなる（gaps-1）
   */
  keepIds?: boolean;
  /**
   * 今の文書の地図と同じ鍵の今日を持つ地図（版によらず）を、足さずに飛ばす（safety-9）。その地図に利用者が足したカードと線は足し、
   * 飛ばした地図のカードへの線は、今の文書の同じ鍵のカードにつなぎ直す（同じ鍵のカードが無ければ線は足さない）
   */
  skipSameMaps?: boolean;
}

/** 追加した結果 */
export interface MergeResult {
  doc: DocData;
  added: ReturnType<typeof docCounts>;
  reusedProjects: number;
  reusedScenarios: number;
  /** 足さずに飛ばした地図（同じ鍵の今日がもうあった）の数と、そのカードの数 */
  skippedMaps?: number;
  skippedCards?: number;
  /** 飛ばした地図のカードへの線を、今の文書の同じ鍵のカードにつなぎ直した数・つなぎ先が無くて足さなかった数 */
  retargeted?: number;
  droppedEdges?: number;
}

/** 鍵（meta.key） */
const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);

/** 並びの一番大きい・小さい数（引数に広げない: 7 万件でも iPhone の引数の上限 65,536 を超えない。見直し gaps-9） */
function extent(nodes: readonly GNode[], f: (n: GNode) => number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const n of nodes) {
    const v = f(n);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * 今の文書の地図（同じ鍵の今日）を、取り込む側から探す。返す: 飛ばす取り込む側のカード（その地図の今日と、今日の鍵の下の鍵のカード）と、
 * 今の文書の鍵 → カードの ID（つなぎ直す先。同じ鍵が 2 つ以上なら、今日から道の線でたどれる物 → 先に作った物）
 */
function sameMaps(base: DocData, incoming: DocData): { skip: Set<ID>; baseByKey: Map<string, ID>; maps: number } {
  const rootKeys = new Set<string>();
  for (const id of Object.keys(base.nodes)) {
    const n = base.nodes[id]!;
    const k = keyOf(n);
    if (k !== null && isForecastRoot(n)) rootKeys.add(k);
  }
  const skip = new Set<ID>();
  const baseByKey = new Map<string, ID>();
  if (!rootKeys.size) return { skip, baseByKey, maps: 0 };
  const hit = new Set<string>();
  for (const id of Object.keys(incoming.nodes)) {
    const n = incoming.nodes[id]!;
    const k = keyOf(n);
    if (k !== null && isForecastRoot(n) && rootKeys.has(k)) hit.add(k);
  }
  if (!hit.size) return { skip, baseByKey, maps: 0 };
  const under = (k: string): boolean => {
    for (const r of hit) if (k === r || k.startsWith(`${r}.`)) return true;
    return false;
  };
  for (const id of Object.keys(incoming.nodes)) {
    const k = keyOf(incoming.nodes[id]);
    if (k !== null && under(k)) skip.add(id);
  }
  // 今の文書の同じ鍵のカード: 今日から道の線でたどれる物を先に（たどれない物は、たどれる物が無い鍵だけ）
  const out = new Map<ID, ID[]>();
  for (const eid of Object.keys(base.edges)) {
    const e = base.edges[eid]!;
    if (!isFlowEdge(e) || !base.nodes[e.target]) continue;
    const l = out.get(e.source);
    if (l) l.push(e.target);
    else out.set(e.source, [e.target]);
  }
  const seen = new Set<ID>();
  const order: ID[] = [];
  for (const id of Object.keys(base.nodes)) {
    const n = base.nodes[id]!;
    const k = keyOf(n);
    if (k !== null && isForecastRoot(n) && hit.has(k) && !seen.has(id)) (seen.add(id), order.push(id));
  }
  for (let i = 0; i < order.length; i++) for (const t of out.get(order[i]!) ?? []) if (!seen.has(t)) (seen.add(t), order.push(t));
  for (const id of order) {
    const k = keyOf(base.nodes[id]);
    if (k !== null && !baseByKey.has(k)) baseByKey.set(k, id);
  }
  for (const id of Object.keys(base.nodes)) {
    const k = keyOf(base.nodes[id]);
    if (k !== null && under(k) && !baseByKey.has(k)) baseByKey.set(k, id);
  }
  return { skip, baseByKey, maps: hit.size };
}

/**
 * 追加の取り込み: 取り込む側の ID をすべて振り直して足す（今のデータを上書きしない）。
 * プロジェクト・シナリオは名前が同じならまとめる。位置は今のグラフの右に並べる。
 * keepIds: 鍵のある同梱のカードは ID をそのまま（空いていれば）。skipSameMaps: 今の地図と同じ鍵の今日を持つ地図は足さない（MergeOpts）
 */
export function mergeDocs(base: DocData, incoming: DocData, opts: MergeOpts = {}): MergeResult {
  const doc = cloneDocShallow(base);
  const pMap = new Map<ID, ID>();
  const sMap = new Map<ID, ID>();
  let reusedProjects = 0;
  let reusedScenarios = 0;
  let addedProjects = 0;
  let addedScenarios = 0;

  // 名前の照らし合わせは辞書で（数千件のプロジェクトでも、総当たりで固まらない）
  const pByName = new Map<string, ID>();
  for (const p of Object.values(doc.projects)) if (!pByName.has(nameKey(p.name))) pByName.set(nameKey(p.name), p.id);
  for (const pid of incoming.projectOrder) {
    const p = incoming.projects[pid];
    if (!p) continue;
    const hit = pByName.get(nameKey(p.name));
    if (hit) {
      pMap.set(pid, hit);
      reusedProjects++;
    } else {
      const id = newId("p");
      doc.projects[id] = { ...p, id };
      doc.projectOrder.push(id);
      pMap.set(pid, id);
      pByName.set(nameKey(p.name), id);
      addedProjects++;
    }
  }
  const sByName = new Map<string, ID>();
  for (const s of Object.values(doc.scenarios)) if (!sByName.has(nameKey(s.name))) sByName.set(nameKey(s.name), s.id);
  for (const sid of incoming.scenarioOrder) {
    const s = incoming.scenarios[sid];
    if (!s) continue;
    const hit = sByName.get(nameKey(s.name));
    if (hit) {
      sMap.set(sid, hit);
      reusedScenarios++;
    } else {
      const id = newId("s");
      doc.scenarios[id] = { ...s, id };
      doc.scenarioOrder.push(id);
      sMap.set(sid, id);
      sByName.set(nameKey(s.name), id);
      addedScenarios++;
    }
  }

  // 今の地図と同じ鍵の今日を持つ地図は足さない（版によらず: safety-9）
  const same = opts.skipSameMaps ? sameMaps(base, incoming) : null;
  const skip = same?.skip ?? new Set<ID>();

  // 位置: 今のグラフの右端の、さらに右へ（上をそろえる）。offset を渡されたらその分だけずらす（差し替えで同じ場所に置く）。
  // ID をそのまま使うときは、ずらし方を整数に（薄い形の保存は整数のずれで地図をそろえる）
  const baseNodes = Object.values(base.nodes);
  const inNodes = Object.values(incoming.nodes).filter((n) => !skip.has(n.id));
  let dx = opts.offset?.dx ?? 0;
  let dy = opts.offset?.dy ?? 0;
  if (!opts.offset && baseNodes.length && inNodes.length) {
    const bx = extent(baseNodes, (n) => n.x);
    const by = extent(baseNodes, (n) => n.y);
    const ix = extent(inNodes, (n) => n.x);
    const iy = extent(inNodes, (n) => n.y);
    dx = bx.max + NODE_W + 600 - ix.min;
    dy = by.min - iy.min;
  }
  if (opts.keepIds) {
    dx = Math.round(dx);
    dy = Math.round(dy);
  }

  const nMap = new Map<ID, ID>();
  const kept = new Set<ID>();
  for (const n of inNodes) {
    const keep = !!opts.keepIds && keyOf(n) !== null && !Object.hasOwn(doc.nodes, n.id) && !nMap.has(n.id);
    const id = keep ? n.id : newId("n");
    if (keep) kept.add(id);
    nMap.set(n.id, id);
    const next: GNode = {
      ...n,
      id,
      x: n.x + dx,
      y: n.y + dy,
      projectIds: n.projectIds.map((p) => pMap.get(p)).filter((p): p is ID => !!p),
      scenarioIds: n.scenarioIds.map((s) => sMap.get(s)).filter((s): s is ID => !!s),
      // 同梱のカードのやることの項目は ID をそのまま（項目の ID はカードの中で重ならなければよい）
      conditions: keep ? n.conditions : n.conditions.map((c) => ({ ...c, id: newId("c") })),
    };
    doc.nodes[id] = next;
  }
  // 飛ばした地図のカード → 今の文書の同じ鍵のカード（線をつなぎ直す先）
  const retarget = (id: ID): ID | undefined => {
    if (!skip.has(id)) return nMap.get(id);
    const k = keyOf(incoming.nodes[id]);
    return k === null ? undefined : same!.baseByKey.get(k);
  };
  let addedEdges = 0;
  let retargeted = 0;
  let droppedEdges = 0;
  for (const e of Object.values(incoming.edges)) {
    const both = skip.has(e.source) && skip.has(e.target);
    // 飛ばした地図の中の線（同梱の線）は足さない
    if (both) continue;
    const source = retarget(e.source);
    const target = retarget(e.target);
    const moved = skip.has(e.source) || skip.has(e.target);
    if (!source || !target) {
      if (moved) droppedEdges++;
      continue;
    }
    if (moved) retargeted++;
    const keep = !!opts.keepIds && kept.has(source) && kept.has(target) && !Object.hasOwn(doc.edges, e.id);
    const id = keep ? e.id : newId("e");
    const next: GEdge = { ...e, id, source, target, scenarioIds: e.scenarioIds.map((s) => sMap.get(s)).filter((s): s is ID => !!s) };
    doc.edges[id] = next;
    addedEdges++;
  }
  const res: MergeResult = {
    doc,
    added: { nodes: inNodes.length, edges: addedEdges, projects: addedProjects, scenarios: addedScenarios },
    reusedProjects,
    reusedScenarios,
  };
  if (same && same.maps) {
    res.skippedMaps = same.maps;
    res.skippedCards = skip.size;
    res.retargeted = retargeted;
    res.droppedEdges = droppedEdges;
  }
  return res;
}
