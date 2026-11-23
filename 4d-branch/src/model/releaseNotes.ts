// 新しい地図の知らせ（版 7）の「前の版 → 今の版」の差の表。設計: 作業メモ SPEC v1 §5.9（見直し user-5・user-11・truth-4）
// 前の版（版 6: 3 か月後・1 年後・2 年の進め方・3 年後の 4 段）の今日の 10 の手の差（今のままとの差。その後は一番良い選び方）と、
// 今の版（版 7: 3 か月ごと 12 段）の差（今やる vs 3 か月待つ。どの手も同じ見積もり方）を、手の種類で並べる。
// 前の版の数は、版 6 の地図（ページに同梱の版 6・テストでは凍結した写し tests/fixtures/impact-r6.json）を同じ年収で数え直した物

import { buildIndex } from "./graph";
import { computeImpact } from "./impact";
import type { DocData, GNode, ID } from "./types";

/** 地図の文書の今日の手ごとの差（手の種類 meta.ak → 今のままとの差。数が出せない手は入れない）。年収は annual に置き換えて数える */
export function todayDeltasOf(doc: DocData, annual: number): Map<string, number> {
  const out = new Map<string, number>();
  // 入口（今日）。この文書は版 6 の地図だけの文書（ストアの文書ではない）なので、全部を見てよい
  let root: GNode | null = null;
  for (const id in doc.nodes) {
    const n = doc.nodes[id]!;
    if (n.meta?.forecastRoot === true && n.meta?.impact && typeof n.meta.impact === "object") {
      root = n;
      break;
    }
  }
  if (!root) return out;
  const cfg = { ...(root.meta.impact as Record<string, unknown>), annual };
  const nodes: Record<ID, GNode> = { ...doc.nodes, [root.id]: { ...root, meta: { ...root.meta, impact: cfg } } };
  const d: DocData = { ...doc, nodes };
  const imp = computeImpact(d, buildIndex(d).out, null);
  const dec = imp.root ? imp.decision.get(imp.root) : undefined;
  for (const a of dec?.alts ?? []) {
    const n = d.nodes[a];
    const kind = typeof n?.meta?.ak === "string" ? (n.meta.ak as string) : null;
    const delta = imp.alt.get(a)?.delta ?? null;
    if (kind && delta !== null && Number.isFinite(delta)) out.set(kind, delta);
  }
  return out;
}

export interface DeltaRow {
  kind: string;
  /** 前の版の差（無ければ null） */
  before: number | null;
  /** 今の版の差（今のままは 0） */
  after: number | null;
  /** 今の版の比べる元（この 3 か月は今のまま） */
  isBase: boolean;
  /** 順位が変わった（前の版の差の順と、今の版の差の順） */
  rankChanged: boolean;
  /** 符号が変わった（前の版でプラスが今の版でマイナス、またはその逆。どちらも 1 万円未満なら数えない） */
  signChanged: boolean;
}

/** 前の版と今の版の差を手の種類でつなぐ（並びは今の版の差の大きい順。比べる元は最後の手前に） */
export function deltaTable(before: ReadonlyMap<string, number>, after: ReadonlyArray<{ kind: string; delta: number | null; isBase: boolean }>): DeltaRow[] {
  const rows = after.map((a) => ({ kind: a.kind, before: before.get(a.kind) ?? (a.isBase ? 0 : null), after: a.isBase ? 0 : a.delta, isBase: a.isBase }));
  const rankOf = (xs: Array<{ kind: string; v: number | null }>) => {
    const sorted = xs.filter((x) => x.v !== null).sort((p, q) => q.v! - p.v!);
    return new Map(sorted.map((x, k) => [x.kind, k]));
  };
  // 順位は比べる元（今のまま）を除いた手の中で
  const rb = rankOf(rows.filter((r) => !r.isBase).map((r) => ({ kind: r.kind, v: r.before })));
  const ra = rankOf(rows.filter((r) => !r.isBase).map((r) => ({ kind: r.kind, v: r.after })));
  const out: DeltaRow[] = rows.map((r) => ({
    ...r,
    rankChanged: !r.isBase && rb.has(r.kind) && ra.has(r.kind) && rb.get(r.kind) !== ra.get(r.kind),
    signChanged: !r.isBase && r.before !== null && r.after !== null && Math.max(Math.abs(r.before), Math.abs(r.after)) >= 1 && Math.sign(r.before) !== Math.sign(r.after),
  }));
  out.sort((p, q) => (q.after ?? -Infinity) - (p.after ?? -Infinity) || p.kind.localeCompare(q.kind));
  return out;
}

/**
 * 地図の文書の、どの判断の手も含めた差（カードの鍵 meta.key → 今のままとの差。数が出せない手は入れない）。年収は annual に置き換えて数える。
 * 前の版（版 6）で選んだ・見送ったカードの差を、知らせの表に出すのに使う（作業メモ SPEC v1 §5.9・W-app の I5）
 */
export function optionDeltasOf(doc: DocData, annual: number): Map<string, number> {
  const out = new Map<string, number>();
  let root: GNode | null = null;
  // 全体を見てよい: 版 6 の地図だけの文書（ストアの文書ではない）を、知らせを開くときに 1 回
  for (const id in doc.nodes) {
    const n = doc.nodes[id]!;
    if (n.meta?.forecastRoot === true && n.meta?.impact && typeof n.meta.impact === "object") {
      root = n;
      break;
    }
  }
  if (!root) return out;
  const cfg = { ...(root.meta.impact as Record<string, unknown>), annual };
  const nodes: Record<ID, GNode> = { ...doc.nodes, [root.id]: { ...root, meta: { ...root.meta, impact: cfg } } };
  const d: DocData = { ...doc, nodes };
  const imp = computeImpact(d, buildIndex(d).out, null);
  for (const [, dec] of imp.decision) {
    for (const a of dec.alts) {
      const key = d.nodes[a]?.meta?.key;
      const delta = imp.alt.get(a)?.delta ?? null;
      if (typeof key === "string" && delta !== null && Number.isFinite(delta)) out.set(key, delta);
    }
  }
  return out;
}

/** 選んだ・見送ったカードの前の版と今の版の差（知らせの表の行） */
export interface DecidedRow {
  /** 今の地図の鍵 */
  key: string;
  status: string;
  before: number | null;
  after: number | null;
  /** 同じ判断の手の中の差の順位（1 から。数が出せなければ null） */
  rankBefore: number | null;
  rankAfter: number | null;
  signChanged: boolean;
  rankChanged: boolean;
}

/** 同じ親の鍵の手の中の、差の大きい順の順位（1 から） */
function rankIn(deltas: ReadonlyMap<string, number>, keys: readonly string[], key: string): number | null {
  const mine = deltas.get(key);
  if (mine === undefined) return null;
  let r = 1;
  for (const k of keys) if (k !== key && (deltas.get(k) ?? -Infinity) > mine) r++;
  return r;
}

/**
 * 選んだ・見送ったカード（版 6 の鍵 → 今の地図の鍵）の、前の版と今の版の差と順位。before: 版 6 の差（optionDeltasOf）。
 * after: 今の地図の鍵 → その判断の手の差（今のままとの差）と、同じ判断の手の鍵。向きか順位が変わった行だけを返す
 */
export function decidedTable(
  decided: ReadonlyArray<{ from: string; to: string; status: string }>,
  before: ReadonlyMap<string, number>,
  after: (key: string) => { delta: number | null; siblings: ReadonlyArray<{ key: string; delta: number | null }> } | null,
): DecidedRow[] {
  const parentOf = (k: string): string => k.slice(0, Math.max(0, k.lastIndexOf(".")));
  const rows: DecidedRow[] = [];
  for (const c of decided) {
    const now = after(c.to);
    if (!now) continue;
    const b = before.get(c.from) ?? null;
    const a = now.delta;
    const p = parentOf(c.from);
    const sibsBefore = [...before.keys()].filter((k) => parentOf(k) === p);
    const nowMap = new Map<string, number>();
    for (const s of now.siblings) if (s.delta !== null) nowMap.set(s.key, s.delta);
    const rankBefore = rankIn(before, sibsBefore, c.from);
    const rankAfter = rankIn(nowMap, now.siblings.map((s) => s.key), c.to);
    const signChanged = b !== null && a !== null && Math.max(Math.abs(b), Math.abs(a)) >= 1 && Math.sign(b) !== Math.sign(a);
    const rankChanged = rankBefore !== null && rankAfter !== null && rankBefore !== rankAfter;
    if (signChanged || rankChanged) rows.push({ key: c.to, status: c.status, before: b, after: a, rankBefore, rankAfter, signChanged, rankChanged });
  }
  return rows;
}
