// 版 6 までの地図（太い形）の引き上げ（src/persist/legacyMap.ts）の答え合わせ（作業メモ SPEC v1 §8・見直し safety-1・gaps-5・gaps-14）。
// 合成のアカウントの形の版 6 の文書（tests/fixtures/account-r6.json）に利用者が入れた物を、凍結した版 6 の地図（scripts/fixtures/frozenR6.ts。
// 同じ同梱データから作った、手を入れていない地図）と比べて数え上げる（引き上げの作りは使わない）。そのうえで、引き上げた文書の中で、
// どれも鍵の同じカード・読み替えた手（3 か月後の手 → 同じ状態の 3 か月目の同じ種類の手）・「前の版で決めたこと」のどこかにあることを確かめる。
// legacyUpgrade.test.ts（小さい木）と legacyUpgradeFull.test.ts（版 7 の候補）が使う
import { expect } from "vitest";
import { ACCOUNT_R6_LOAD_DAY } from "../../../scripts/fixtures/accountR6";
import { buildR6MapDoc, type R6Bundle } from "../../../scripts/fixtures/frozenR6";
import type { MapData } from "../../../src/deepmap/mapData";
import { impactTagsOf } from "../../../src/demo/impact";
import { normalizeDoc } from "../../../src/model/schema";
import type { DocData, GEdge, GNode } from "../../../src/model/types";
import accountRaw from "../../fixtures/account-r6.json?raw";
import { R6_RAW, R6_RELEASE } from "./r6";

export const ACCOUNT_R6_RAW: string = accountRaw;

/** アカウントの形の版 6 の文書（読むたびに新しい物） */
export function accountR6Doc(): DocData {
  return normalizeDoc(JSON.parse(accountRaw)).doc;
}

const keyOf = (n: GNode | undefined): string | null => (n && typeof n.meta?.key === "string" ? n.meta.key : null);
const parentKey = (k: string): string => k.slice(0, k.lastIndexOf("."));

/** 利用者が入れた物（鍵ごとの種類・カード・親からの同梱の線・利用者の線・利用者のノード） */
export interface Inventory {
  kinds: Map<string, Set<string>>;
  card: Map<string, GNode>;
  inEdge: Map<string, GEdge>;
  ref: Map<string, GNode>;
  userEdges: GEdge[];
  ownNodes: GNode[];
  root: GNode;
}

/** 版 6 の文書に利用者が入れた物を、凍結した版 6 の地図と比べて数え上げる */
export function inventory(doc: DocData): Inventory {
  const refDoc = buildR6MapDoc(JSON.parse(R6_RAW) as R6Bundle, ACCOUNT_R6_LOAD_DAY, R6_RELEASE, "2026-11-12T10:30:00.000Z") as unknown as DocData;
  const ref = new Map<string, GNode>(Object.values(refDoc.nodes).map((n) => [keyOf(n)!, n]));
  const refEdge = new Map<string, GEdge>(Object.values(refDoc.edges).map((e) => [keyOf(refDoc.nodes[e.target])!, e]));
  const card = new Map<string, GNode>();
  const ownNodes: GNode[] = [];
  for (const n of Object.values(doc.nodes)) {
    const k = keyOf(n);
    if (k === null) ownNodes.push(n);
    else card.set(k, n);
  }
  const kinds = new Map<string, Set<string>>();
  const mark = (k: string | null, kind: string): void => {
    if (k === null) return;
    if (!kinds.has(k)) kinds.set(k, new Set());
    kinds.get(k)!.add(kind);
  };
  for (const [k, n] of card) {
    const r = ref.get(k)!;
    if (n.status !== "open") mark(k, n.status);
    if (n.conditions.some((c) => c.met && r.conditions.some((x) => x.text === c.text))) mark(k, "tick");
    if (n.conditions.some((c) => !r.conditions.some((x) => x.text === c.text))) mark(k, "own-todo");
    if (n.title !== r.title) mark(k, "title");
    if (n.body !== r.body) mark(k, "body");
    if (n.tags.some((t) => !impactTagsOf(n.meta).includes(t))) mark(k, "tag");
  }
  const inEdge = new Map<string, GEdge>();
  const userEdges: GEdge[] = [];
  for (const e of Object.values(doc.edges)) {
    const sk = keyOf(doc.nodes[e.source]);
    const tk = keyOf(doc.nodes[e.target]);
    if (sk !== null && tk !== null && parentKey(tk) === sk && refEdge.has(tk)) {
      inEdge.set(tk, e);
      const r = refEdge.get(tk)!;
      if (e.meta.prob !== r.meta.prob) mark(tk, "prob");
      if (e.label !== r.label || e.condition !== r.condition) mark(tk, "edge-text");
      continue;
    }
    userEdges.push(e);
    mark(sk, tk === null && e.relation !== "supports" ? "own-child" : "own-edge");
    mark(tk, "own-edge");
  }
  const root = card.get("r")!;
  return { kinds, card, inEdge, ref, userEdges, ownNodes, root };
}

/** 版 6 の鍵のカードの行き先（kept: 同じ鍵・moved: 読み替えた手・detached: 前の版で決めたこと）と、ページの地図の鍵 */
export function expectedFate(map: MapData, key: string, card: GNode): { how: "kept" | "moved" | "detached"; key7: string | null } {
  if (map.indexOfKey(key) >= 0) return { how: "kept", key7: key };
  const seg = key.split(".");
  if (seg.length === 4 && card.meta.m === 3 && typeof card.meta.ak === "string") {
    const s = map.indexOfKey(seg.slice(0, 3).join("."));
    if (s >= 0)
      for (let k = 0; k < map.childCount(s); k++) {
        const c = map.child(s, k);
        if (map.role(c) === "a" && map.month(c) === 3 && map.kind(c) === card.meta.ak) return { how: "moved", key7: map.key(c) };
      }
  }
  return { how: "detached", key7: null };
}

/** 引き上げた文書の、ページの地図のカード（鍵から）の親からの線 */
function edgeInto(out: DocData, id: string): GEdge | undefined {
  const k = keyOf(out.nodes[id]);
  if (k === null) return undefined;
  return Object.values(out.edges).find((e) => e.target === id && keyOf(out.nodes[e.source]) === parentKey(k));
}

/**
 * 利用者が入れた物が、引き上げた文書のどこかにあるか（無くした物が無いか）を確かめ、行き先ごとの数を返す。
 * 鍵のカードは ID のまま（kept・moved はページの地図のカードとして、detached は鍵の無いカードとして）
 */
export function checkUpgrade(input: DocData, out: DocData, map: MapData): { kept: number; moved: number; detached: number; kinds: Record<string, number>; prevGroup: GNode | null } {
  const inv = inventory(input);
  const count = { kept: 0, moved: 0, detached: 0 };
  const kinds: Record<string, number> = {};
  const outRoot = Object.values(out.nodes).find((n) => n.meta.forecastRoot === true && typeof n.meta.anchor === "string")!;
  expect(outRoot.id).toBe(inv.root.id);
  const group = Object.values(out.nodes).find((n) => n.meta.prevGroup !== undefined) ?? null;
  for (const [key, set] of inv.kinds) {
    for (const k of set) kinds[k] = (kinds[k] ?? 0) + 1;
    if (key === "r") continue;
    const c = inv.card.get(key)!;
    const fate = expectedFate(map, key, c);
    const n = out.nodes[c.id];
    expect(n, `${key} が無い`).toBeDefined();
    count[fate.how]++;
    const r6Met = c.conditions.filter((x) => x.met);
    const ownTodo = c.conditions.filter((x) => !inv.ref.get(key)!.conditions.some((y) => y.text === x.text));
    const e6 = inv.inEdge.get(key);
    if (fate.how !== "detached") {
      expect(n!.meta.key, key).toBe(fate.key7);
      if (set.has("active") || set.has("done") || set.has("dropped")) expect(n!.status, key).toBe(c.status);
      if (set.has("title")) expect(n!.title, key).toBe(c.title);
      if (set.has("body")) expect(n!.body, key).toBe(c.body);
      if (set.has("tag")) for (const t of c.tags.filter((t) => !impactTagsOf(c.meta).includes(t))) expect(n!.tags, key).toContain(t);
      // チェック: 同じ元の番号の項目がチェック済みか、チェックした項目が文ごと（どちらでも、チェックは無くならない）
      for (const m of r6Met) {
        const refIdx = inv.ref.get(key)!.conditions.findIndex((y) => y.text === m.text);
        const cite = refIdx >= 0 && Array.isArray(c.meta.cites) ? (c.meta.cites as string[])[refIdx] : undefined;
        const cites = Array.isArray(n!.meta.cites) ? (n!.meta.cites as string[]) : [];
        const bySlot = cite !== undefined && n!.conditions.some((y, t) => y.met && cites[t] === cite);
        expect(bySlot || n!.conditions.some((y) => y.met && y.text === m.text), `${key} のチェック ${m.text}`).toBe(true);
      }
      for (const m of ownTodo) expect(n!.conditions.some((y) => y.text === m.text && y.met === m.met), `${key} の自分の項目`).toBe(true);
      if (set.has("prob") || set.has("edge-text")) {
        const e = edgeInto(out, c.id)!;
        expect(e, `${key} の線`).toBeDefined();
        if (set.has("prob")) expect(e.meta.prob, key).toBe(e6!.meta.prob);
        if (set.has("edge-text")) expect([e.label, e.condition], key).toEqual([e6!.label, e6!.condition]);
      }
    } else {
      // 鍵の無い利用者のカードとして、題名・本文・状態・やること・タグ・期限はそのまま
      expect(keyOf(n), key).toBeNull();
      expect(n!.meta.prevKey, key).toBe(key);
      expect({ title: n!.title, body: n!.body, status: n!.status, conditions: n!.conditions, tags: n!.tags, time: n!.time }, key).toEqual({ title: c.title, body: c.body, status: c.status, conditions: c.conditions, tags: c.tags, time: c.time });
      expect(n!.x, key).toBeLessThan(outRoot.x);
      expect(group, "前の版で決めたこと").not.toBeNull();
      expect(n!.x).toBe(group!.x);
      expect(n!.y).toBeGreaterThan(group!.y);
      const pe = n!.meta.prevEdge as { prob?: unknown; label?: unknown; condition?: unknown } | undefined;
      if (set.has("prob")) expect(pe?.prob, key).toBe(e6!.meta.prob);
      if (set.has("edge-text")) expect([pe?.label, pe?.condition], key).toEqual([e6!.label, e6!.condition]);
    }
  }
  // 利用者のノードと線はそのまま（同じ ID・同じ中身）。線の両端は、どれも引き上げた文書にある
  for (const o of inv.ownNodes) expect(out.nodes[o.id], o.title).toEqual(o);
  for (const e of inv.userEdges) expect(out.edges[e.id], e.id).toEqual(e);
  for (const e of Object.values(out.edges)) {
    expect(out.nodes[e.source], `線 ${e.id} の元`).toBeDefined();
    expect(out.nodes[e.target], `線 ${e.id} の先`).toBeDefined();
  }
  // 年収と今日の書き換え
  expect((outRoot.meta.impact as { annual?: number }).annual).toBe((inv.root.meta.impact as { annual?: number }).annual);
  // 地図のカードは、ページの地図のカード（鍵ごとに 1 枚）・前の版で決めたこと・利用者のノードだけ（利用者の物を持たない版 6 のカードは残らない）
  const keyed = Object.values(out.nodes).filter((n) => keyOf(n) !== null);
  expect(keyed.length).toBe(map.n);
  const prev = Object.values(out.nodes).filter((n) => n.meta.prevKey !== undefined);
  expect(prev.length).toBe(count.detached);
  expect(Object.keys(out.nodes).length).toBe(map.n + inv.ownNodes.length + count.detached + (count.detached ? 1 : 0));
  return { ...count, kinds, prevGroup: group };
}
