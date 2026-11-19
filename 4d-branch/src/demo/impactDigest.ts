// 基準の文書の指紋（baseline digest。作業メモ SPEC v1 §6・§2.6・見直し safety-4・safety-14）。
// 同梱の地図（同じ版の順番・同じ中身の指紋）から組み立てた文書が、アプリの版が変わっても同じカード・同じ ID・同じ線になるかを見分ける
// （中身の指紋 header.hash は同梱データしか見ない。鍵・ID・線・タグ・日付を作るのはアプリの組み立てなので、そちらが変わったことはこの指紋で分かる）。
// 中身: 今日（root）から道の線（進む・条件付き）で深さ優先にたどった順に、カードごとの
//   鍵・ID・親の ID・親からの線の ID・やることの項目の ID・projectIds・scenarioIds（カードと、親からの線）・タグ・期限（time の due と start）。
//   兄弟は作ったときの順位（meta.rank）の順（＝地図の並べる順）。時刻・位置・題名・数は入れない（数と文は中身の指紋 header.hash が持つ）。
// 値: 決まった並びの文字列の 64 ビットの FNV（./impact.ts の fnv64x36 と同じ作り。36 進 14 文字）。日付は地図の年月からの整数の計算なので、
//   端末の時差に依らない（テストで America/Los_Angeles と Asia/Tokyo を比べる）。
// 置き場: 版の記録（生成の --record。後で src/demo/impact-release.json の {release, hash, digest, anchor}）と、薄い形の入口ごと（W-store）。
//   CI は同梱データから組み立てて比べ、同じ版の順番のまま違えば止める。読み手は、同じ版でも指紋が違えば版をまたぐ道へ回すか止める（黙って読まない）。

import type { MapData } from "../deepmap/mapData";
import type { DocData, GEdge, GNode, ID } from "../model/types";
import { buildQuarterDoc, quarterRootId } from "./quarterDoc";

/** 基準の文書の指紋（36 進 14 文字）。doc は buildQuarterDoc(map, {version, release, at, layout}) で組み立てた文書、root はその地図の今日のカード */
export type ImpactBaselineDigest = (doc: DocData, root: ID) => string;

/** 指紋にする並びの版（並びや入れる物を変えたら上げる。どの指紋も変わる） */
export const DIGEST_FORMAT = "4DQD1";

/** 版の記録の指紋を出すときに組み立てる時刻（指紋は時刻に依らないが、組み立てをそろえる。2026-11-01T00:00:00Z） */
export const DIGEST_AT = Date.UTC(2026, 10, 1);

/** 3 か月ごとの地図の版の記録（src/demo/impact-release.json の形。SPEC §3.1） */
export interface QuarterRelease {
  release: number;
  /** 同梱データの中身の指紋（header.hash） */
  hash: string;
  /** 基準の文書の指紋（impactBaselineDigest） */
  digest: string;
  /** 0 か月目の年月 "YYYY-MM" */
  anchor: string;
}

const OFF1 = 0x811c9dc5;
const OFF2 = 0x9e3779b9;
const PRIME = 0x01000193;

/** 64 ビットの FNV（./impact.ts の fnv64x36 と同じ作り）を、文字を少しずつ足して数える。add した文字をつないだ物の fnv64x36 と同じ値 */
export class Fnv64Stream {
  private h1 = OFF1;
  private h2 = OFF2;
  add(s: string): this {
    let h1 = this.h1;
    let h2 = this.h2;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, PRIME);
      h2 = Math.imul(h2 ^ c, PRIME);
    }
    this.h1 = h1;
    this.h2 = h2;
    return this;
  }
  /** 並び（\u0002 で区切る）。xs.join("\u0002") を add するのと同じ */
  addList(xs: readonly string[]): this {
    for (let i = 0; i < xs.length; i++) {
      if (i > 0) this.add("\u0002");
      this.add(xs[i]!);
    }
    return this;
  }
  /** 36 進 7 桁 + 7 桁 */
  digest(): string {
    return (this.h1 >>> 0).toString(36).padStart(7, "0") + (this.h2 >>> 0).toString(36).padStart(7, "0");
  }
}

const isFlow = (e: GEdge): boolean => e.relation === "leads" || e.relation === "condition";
const rankOf = (n: GNode): number => (typeof n.meta.rank === "number" && Number.isFinite(n.meta.rank) ? n.meta.rank : Number.MAX_SAFE_INTEGER);
const keyOf = (n: GNode): string | null => (typeof n.meta.key === "string" ? n.meta.key : null);

/**
 * 基準の文書の指紋を出す（組み立てた文書と、その地図の今日のカード）。今日から道の線で届く、鍵のあるカードを深さ優先にたどる。
 * 区切り: 項目の間は \u0001、並びの中は \u0002、カードの終わりは \n（どれも鍵・ID・タグ・日付に入らない文字）。今日が無ければ投げる
 */
export const impactBaselineDigest: ImpactBaselineDigest = (doc, root) => {
  const top = doc.nodes[root];
  if (!top || keyOf(top) === null) throw new Error(`基準の文書の指紋: 今日のカード ${root} がありません`);
  // 道の線（鍵のあるカードへの物）を、元のカードごとに
  const out = new Map<ID, GEdge[]>();
  for (const id in doc.edges) {
    const e = doc.edges[id]!;
    const t = doc.nodes[e.target];
    if (!isFlow(e) || e.source === e.target || !doc.nodes[e.source] || !t || keyOf(t) === null) continue;
    const list = out.get(e.source);
    if (list) list.push(e);
    else out.set(e.source, [e]);
  }
  const order = (a: GEdge, b: GEdge): number => {
    const x = doc.nodes[a.target]!;
    const y = doc.nodes[b.target]!;
    const d = rankOf(x) - rankOf(y);
    if (d !== 0) return d;
    const kx = keyOf(x)!;
    const ky = keyOf(y)!;
    return kx < ky ? -1 : kx > ky ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  const h = new Fnv64Stream().add(`${DIGEST_FORMAT}\n`);
  const seen = new Set<ID>([root]);
  // 深さ優先（再帰を使わずに。子は並べる順に積み直す）
  const stack: Array<{ node: GNode; edge: GEdge | null }> = [{ node: top, edge: null }];
  while (stack.length) {
    const { node, edge } = stack.pop()!;
    h.add(keyOf(node)!).add("\u0001").add(node.id).add("\u0001");
    h.add(edge ? edge.source : "").add("\u0001").add(edge ? edge.id : "").add("\u0001");
    for (let k = 0; k < node.conditions.length; k++) {
      if (k > 0) h.add("\u0002");
      h.add(node.conditions[k]!.id);
    }
    h.add("\u0001").addList(node.projectIds).add("\u0001").addList(node.scenarioIds).add("\u0001");
    if (edge) h.addList(edge.scenarioIds);
    h.add("\u0001").addList(node.tags).add("\u0001");
    h.add(node.time.due ?? "").add("\u0001").add(node.time.start ?? "").add("\n");
    const kids = out.get(node.id);
    if (!kids) continue;
    kids.sort(order);
    for (let k = kids.length - 1; k >= 0; k--) {
      const e = kids[k]!;
      if (seen.has(e.target)) continue;
      seen.add(e.target);
      stack.push({ node: doc.nodes[e.target]!, edge: e });
    }
  }
  return h.digest();
};

/** 地図から基準の文書を組み立てて（決まった時刻 DIGEST_AT・位置なし）指紋を出す。版の記録・CI の比べ・薄い形の入口で使う */
export function mapBaselineDigest(map: MapData): string {
  const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: DIGEST_AT, layout: "none" });
  return impactBaselineDigest(doc, quarterRootId(map));
}

/** 地図の版の記録 {release, hash, digest, anchor}（生成の --record と、後で src/demo/impact-release.json に書く物） */
export function quarterReleaseOf(map: MapData): QuarterRelease {
  return { release: map.header.release, hash: map.header.hash, digest: mapBaselineDigest(map), anchor: map.header.anchor };
}
