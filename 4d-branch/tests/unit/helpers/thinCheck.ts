// 薄い形の保存（src/persist/thinMap.ts）の往復の答え合わせ。書いた文書から、決めた違いだけを当てた答えを作り、読んだ文書と比べる:
//   基準と時刻のほかは同じ地図のカードと親からの線は、時刻が at（手を付けていないカードの時刻をそろえる）。今日の futureVersion・futureRelease は
//   基準の物。文書の版は 1。ほかは書いた文書と同じ（保存したノードと線は normalizeDoc を通るが、アプリで作った文書では何も変わらない）。
// もう一度書くと同じ文字列か・写し（IndexedDB の形）を読んでも同じかも確かめる。thinMap.test.ts と thinMapFull.test.ts が使う
import { expect } from "vitest";
import { SCHEMA_VERSION, THIN_VERSION } from "../../../src/model/schema";
import type { DocData, GEdge, GNode } from "../../../src/model/types";
import { fromStored, thinBaselineDoc, toStored, type StoredDoc, type ThinSection } from "../../../src/persist/codec";
import { jsonEq } from "../../../src/persist/thinMap";

const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);

/**
 * 読んだ結果の答え（書いた文書から、決めた違いだけを当てた物）: 基準と時刻のほかは同じ地図のカードと親からの線は、時刻が at。
 * 今日の futureVersion・futureRelease は基準の物。文書の版は 1。カードと線は ID ごとに作る（違う物だけ写す）
 */
export function expectedParts(doc: DocData, sec: ThinSection): { node: (id: string) => GNode; edge: (id: string) => GEdge } {
  const base = thinBaselineDoc({ at: sec.at, dx: sec.dx, dy: sec.dy, pmap: sec.pmap ?? {}, smap: sec.smap ?? {} });
  const vByKey = new Map<string, GNode>();
  for (const n of Object.values(base.nodes)) vByKey.set(keyOf(n)!, n);
  const veByChild = new Map<string, GEdge>();
  for (const e of Object.values(base.edges)) veByChild.set(keyOf(base.nodes[e.target])!, e);
  const keyed = new Map<string, GNode[]>();
  for (const n of Object.values(doc.nodes)) {
    const k = keyOf(n);
    if (k === null || !vByKey.has(k)) continue;
    const l = keyed.get(k);
    if (l) l.push(n);
    else keyed.set(k, [n]);
  }
  const keyOfId = new Map<string, string>();
  for (const [k, l] of keyed) if (l.length === 1) keyOfId.set(l[0]!.id, k);
  const node = (id: string): GNode => {
    const n = doc.nodes[id]!;
    if (id === sec.root) return { ...n, meta: { ...n.meta, futureVersion: sec.hash, futureRelease: sec.release } };
    const k = keyOfId.get(id);
    if (k === undefined) return n;
    const v = vByKey.get(k)!;
    return jsonEq({ ...n, id: v.id, createdAt: v.createdAt, updatedAt: v.updatedAt }, v) ? { ...n, createdAt: sec.at, updatedAt: sec.at } : n;
  };
  const edge = (id: string): GEdge => {
    const e = doc.edges[id]!;
    const tk = keyOfId.get(e.target);
    const sk = keyOfId.get(e.source);
    if (tk === undefined || sk === undefined || tk.slice(0, tk.lastIndexOf(".")) !== sk) return e;
    const ve = veByChild.get(tk)!;
    if (e.id !== ve.id && typeof e.meta.c0 !== "string") return e;
    return jsonEq({ ...e, id: ve.id, source: ve.source, target: ve.target, createdAt: ve.createdAt, updatedAt: ve.updatedAt }, ve) ? { ...e, createdAt: sec.at, updatedAt: sec.at } : e;
  };
  return { node, edge };
}

/** 読んだ文書が答えと同じか（カードと線は ID ごとに比べ、違えば差を出す） */
export function expectDecoded(decoded: DocData, doc: DocData, sec: ThinSection): void {
  const want = expectedParts(doc, sec);
  expect(decoded.version).toBe(SCHEMA_VERSION);
  for (const k of ["schema", "id", "title", "createdAt", "updatedAt", "projects", "scenarios", "projectOrder", "scenarioOrder", "meta"] as const) expect(decoded[k], k).toEqual(doc[k]);
  expect(Object.keys(decoded).sort()).toEqual(Object.keys(doc).sort());
  const nIds = Object.keys(doc.nodes);
  expect(Object.keys(decoded.nodes).sort()).toEqual([...nIds].sort());
  for (const id of nIds) {
    const w = want.node(id);
    if (!jsonEq(decoded.nodes[id], w)) expect(decoded.nodes[id], `ノード ${id}`).toEqual(w);
  }
  const eIds = Object.keys(doc.edges);
  expect(Object.keys(decoded.edges).sort()).toEqual([...eIds].sort());
  for (const id of eIds) {
    const w = want.edge(id);
    if (!jsonEq(decoded.edges[id], w)) expect(decoded.edges[id], `線 ${id}`).toEqual(w);
  }
}

/** 書いて（JSON で）読み、答えと同じか・もう一度書くと同じ文字列か・写し（IndexedDB の形）でも同じかを確かめる */
export function checkRoundTrip(doc: DocData): { stored: StoredDoc; json: string; decoded: DocData; sec: ThinSection } {
  const stored = toStored(doc);
  expect(stored.version).toBe(THIN_VERSION);
  expect(stored.schema).toBe("4d-branch");
  const json = JSON.stringify(stored);
  const decoded = fromStored(JSON.parse(json));
  const sec = stored.maps![0]!;
  expectDecoded(decoded, doc, sec);
  expect(JSON.stringify(toStored(decoded))).toBe(json);
  expect(JSON.stringify(toStored(fromStored(structuredClone(stored))))).toBe(json);
  return { stored, json, decoded, sec };
}

