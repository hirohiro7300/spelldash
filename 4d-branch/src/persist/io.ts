// JSON のエクスポート・インポート（置き換え／追加）。設計: docs/DESIGN.md §3.10・§5

import { NODE_W } from "../model/constants";
import { newId } from "../model/ids";
import { cloneDocShallow, docCounts, parseDocText, serializeDoc, type NormalizeReport } from "../model/schema";
import { normalizeText } from "../model/search";
import type { DocData, GEdge, GNode, ID } from "../model/types";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function exportFileName(date = new Date(), prefix = "4d-branch"): string {
  return `${prefix}_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}

export function exportText(doc: DocData, appVersion: string): string {
  return serializeDoc(doc, appVersion);
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
}

/** 読み込む前の確認用（検証して件数と警告を出す。失敗は DocFormatError） */
export function previewImport(text: string): ImportPreview {
  const { doc, report } = parseDocText(text);
  return { doc, report, counts: docCounts(doc) };
}

/** 同じ名前と見なす鍵（全角半角・大文字小文字・カタカナひらがなをそろえる） */
const nameKey = (name: string) => normalizeText(name.trim());

/**
 * 追加の取り込み: 取り込む側の ID をすべて振り直して足す（今のデータを上書きしない）。
 * プロジェクト・シナリオは名前が同じならまとめる。位置は今のグラフの右に並べる
 */
export function mergeDocs(
  base: DocData,
  incoming: DocData,
  opts: { offset?: { dx: number; dy: number } } = {},
): { doc: DocData; added: ReturnType<typeof docCounts>; reusedProjects: number; reusedScenarios: number } {
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

  // 位置: 今のグラフの右端の、さらに右へ（上をそろえる）。offset を渡されたらその分だけずらす（差し替えで同じ場所に置く）
  const baseNodes = Object.values(base.nodes);
  const inNodes = Object.values(incoming.nodes);
  let dx = opts.offset?.dx ?? 0;
  let dy = opts.offset?.dy ?? 0;
  if (!opts.offset && baseNodes.length && inNodes.length) {
    const baseMaxX = Math.max(...baseNodes.map((n) => n.x));
    const baseMinY = Math.min(...baseNodes.map((n) => n.y));
    const inMinX = Math.min(...inNodes.map((n) => n.x));
    const inMinY = Math.min(...inNodes.map((n) => n.y));
    dx = baseMaxX + NODE_W + 600 - inMinX;
    dy = baseMinY - inMinY;
  }

  const nMap = new Map<ID, ID>();
  for (const n of inNodes) {
    const id = newId("n");
    nMap.set(n.id, id);
    const next: GNode = {
      ...n,
      id,
      x: n.x + dx,
      y: n.y + dy,
      projectIds: n.projectIds.map((p) => pMap.get(p)).filter((p): p is ID => !!p),
      scenarioIds: n.scenarioIds.map((s) => sMap.get(s)).filter((s): s is ID => !!s),
      conditions: n.conditions.map((c) => ({ ...c, id: newId("c") })),
    };
    doc.nodes[id] = next;
  }
  let addedEdges = 0;
  for (const e of Object.values(incoming.edges)) {
    const source = nMap.get(e.source);
    const target = nMap.get(e.target);
    if (!source || !target) continue;
    const id = newId("e");
    const next: GEdge = { ...e, id, source, target, scenarioIds: e.scenarioIds.map((s) => sMap.get(s)).filter((s): s is ID => !!s) };
    doc.edges[id] = next;
    addedEdges++;
  }
  return {
    doc,
    added: { nodes: inNodes.length, edges: addedEdges, projects: addedProjects, scenarios: addedScenarios },
    reusedProjects,
    reusedScenarios,
  };
}
