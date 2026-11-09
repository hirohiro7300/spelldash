// ノード検索。全角・半角、大文字・小文字、カタカナ・ひらがなの違いを無視する。`#タグ` でタグを絞る

import { NODE_TYPES, STATUSES } from "./constants";
import type { DocData, GNode, ID } from "./types";

export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export interface SearchQuery {
  terms: string[];
  tags: string[];
  raw: string;
}

export function parseQuery(q: string): SearchQuery {
  const terms: string[] = [];
  const tags: string[] = [];
  for (const tok of q.trim().split(/[\s　]+/)) {
    if (!tok) continue;
    const n = normalizeText(tok);
    if (n.startsWith("#") && n.length > 1) tags.push(n.slice(1));
    else if (n !== "#") terms.push(n);
  }
  return { terms, tags, raw: q };
}

export function isEmptyQuery(q: SearchQuery): boolean {
  return q.terms.length === 0 && q.tags.length === 0;
}

// ノードは不変なので、オブジェクトごとに正規化した文をキャッシュできる
const hayCache = new WeakMap<GNode, { title: string; all: string; tags: string[] }>();

function hayOf(n: GNode, doc: DocData) {
  let h = hayCache.get(n);
  if (!h) {
    const title = normalizeText(n.title);
    const tags = n.tags.map(normalizeText);
    const projects = n.projectIds.map((p) => doc.projects[p]?.name ?? "").join(" ");
    const all = normalizeText(
      [n.title, n.body, n.tags.join(" "), n.conditions.map((c) => c.text).join(" "), NODE_TYPES[n.type].label, STATUSES[n.status].label, projects, n.time.due ?? ""].join("\n"),
    );
    h = { title, all, tags };
    hayCache.set(n, h);
  }
  return h;
}

/** 当たれば点数（高いほど上）、当たらなければ -1 */
export function scoreNode(n: GNode, q: SearchQuery, doc: DocData): number {
  const h = hayOf(n, doc);
  let score = 0;
  for (const t of q.tags) {
    const hit = h.tags.some((x) => x.startsWith(t));
    if (!hit) return -1;
    score += h.tags.includes(t) ? 30 : 20;
  }
  for (const t of q.terms) {
    const i = h.title.indexOf(t);
    if (i >= 0) score += i === 0 ? 40 : 25;
    else if (h.all.includes(t)) score += 8;
    else return -1;
  }
  if (n.type === "goal") score += 2;
  return score;
}

export function searchNodes(doc: DocData, q: SearchQuery, limit = Infinity): Array<{ id: ID; score: number }> {
  if (isEmptyQuery(q)) return [];
  const out: Array<{ id: ID; score: number }> = [];
  for (const id in doc.nodes) {
    const s = scoreNode(doc.nodes[id]!, q, doc);
    if (s >= 0) out.push({ id, score: s });
  }
  out.sort((a, b) => b.score - a.score || (doc.nodes[a.id]!.title || "").localeCompare(doc.nodes[b.id]!.title || "", "ja"));
  return limit === Infinity ? out : out.slice(0, limit);
}
