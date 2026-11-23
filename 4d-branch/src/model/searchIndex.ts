// 検索の索引: 文字はどれも 1 度だけ正規化して表に入れ（同じ文字は同じ番号）、ノードはその番号だけを持つ。
// 設計: 作業メモ SPEC v1 §4.4・§7.1 の 9（見直し perf-9）
//
// 探す所はふつうの検索（./search.ts の scoreNode）と同じ: 題名・本文・タグ・条件・種類・状態・プロジェクトの名前・期限。
// 3 年の分かれ道のために、ひとこと（meta.short）と、入ってくる線の結果の名前（label）と判断の線の文（condition）も探す。
// 組み立てた本文（実行時に作る文章）は探さない（画面でそう伝える。P3 で Worker の索引にする）。
//
// 当たりは（言葉, 中身の版）で覚える。ノードの変更は、変わったノードと、線が変わったノードだけ直す（O(変わった物)）。
// 1 回の検索は「表の文字の数 × 言葉の数」の正規化済みの文字の部分一致と、ノードごとの番号の読み出しだけ（文書をなめない）。
// 並びは点数の高い順、同じ点数は題名の順（Intl.Collator("ja")。searchNodes の localeCompare と同じ）、同じ題名は文書の順。
// 上の 50 件だけを並べ、残りは数える（題名の比べは、上に入りうる物だけ）。

import { NODE_TYPES, STATUSES } from "./constants";
import { normalizeText, type SearchQuery } from "./search";
import type { DocData, GNode, ID } from "./types";

/** 1 回の検索の答え */
export interface SearchResult {
  /** 上の物（点数の高い順・同じ点数は題名の順。最大 limit 件） */
  hits: Array<{ id: ID; score: number }>;
  /** 当たった数（全部） */
  count: number;
  /** 当たったか */
  has(id: ID): boolean;
}

const EMPTY_RESULT: SearchResult = { hits: [], count: 0, has: () => false };

/** 中身の取り出しに使う索引（ノード → 入る線の ID） */
export interface SearchGraph {
  inc: ReadonlyMap<ID, readonly ID[]>;
}

let collator: Intl.Collator | null = null;
const titleCompare = (a: string, b: string): number => (collator ??= new Intl.Collator("ja")).compare(a, b);

export class SearchIndex {
  /** 文字の表（同じ文字は同じ番号）と、正規化した物（初めて使うときに作る） */
  private readonly strId = new Map<string, number>();
  private readonly strs: string[] = [];
  private readonly norms: Array<string | undefined> = [];
  /** ノードの場所（文書の順に足す。消したノードの場所は使い回さない＝場所の順が文書の順） */
  private readonly slotOf = new Map<ID, number>();
  private ids: Array<ID | null> = [];
  private title: Int32Array<ArrayBuffer> = new Int32Array(64);
  private goal: Uint8Array<ArrayBuffer> = new Uint8Array(64);
  /** 題名以外の文字の番号（pool[off .. off + len)） */
  private restOff: Int32Array<ArrayBuffer> = new Int32Array(64);
  private restLen: Int32Array<ArrayBuffer> = new Int32Array(64);
  private pool: Int32Array<ArrayBuffer> = new Int32Array(1024);
  private poolN = 0;
  /** タグの組（正規化したタグの並び）・プロジェクトの組の番号 */
  private tagsK: Int32Array<ArrayBuffer> = new Int32Array(64);
  private projK: Int32Array<ArrayBuffer> = new Int32Array(64);
  private readonly tagSets: string[][] = [];
  private readonly tagSetId = new Map<string, number>();
  private readonly projSets: ID[][] = [];
  private readonly projSetId = new Map<string, number>();
  private alive = 0;
  /** 中身の版（変わるたびに進む。当たりの覚えの鍵） */
  private version = 0;
  private memo: { key: string; version: number; projects: unknown; res: SearchResult } | null = null;

  /** doc を渡さなければ空（少しずつ作る: putRange をくり返し、finish。見直し perf-8） */
  constructor(doc?: DocData, graph?: SearchGraph) {
    if (doc && graph) this.rebuild(doc, graph);
  }

  /** 少しずつ作る: 文書の順のノード ID（ids）の [from, to) を入れる（無くなったノードは飛ばす）。作り終えたら finish */
  putRange(doc: DocData, graph: SearchGraph, ids: readonly ID[], from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const id = ids[i]!;
      if (doc.nodes[id]) this.putEntry(doc, graph, id);
    }
  }

  /** 少しずつ作り終えた（当たりの覚えを捨てる） */
  finish(): void {
    this.version++;
  }

  /** そのノードが入っている */
  has(id: ID): boolean {
    return this.slotOf.has(id);
  }

  /** 全部を作り直す（全部が入れ替わったとき） */
  rebuild(doc: DocData, graph: SearchGraph): void {
    this.slotOf.clear();
    this.ids = [];
    this.poolN = 0;
    this.alive = 0;
    for (const id in doc.nodes) this.putEntry(doc, graph, id);
    this.version++;
  }

  /** 変わったノード（ids）を直す。消えたノードは外し、新しいノードは後ろに足す */
  update(doc: DocData, graph: SearchGraph, ids: Iterable<ID>): void {
    for (const id of ids) {
      if (doc.nodes[id]) this.putEntry(doc, graph, id);
      else this.drop(id);
    }
    this.version++;
  }

  /** プロジェクトの名前などが変わった（ノードは同じ。当たりだけ数え直す） */
  touch(): void {
    this.version++;
  }

  /** 当たり（言葉と中身の版が同じなら前の答え）。projects はプロジェクトの名前の元（名前が変わったら数え直す） */
  query(q: SearchQuery, doc: DocData, limit = 50): SearchResult {
    if (q.terms.length === 0 && q.tags.length === 0) return EMPTY_RESULT;
    const key = `${limit}\u0000${q.tags.join("\u0001")}\u0000${q.terms.join("\u0001")}`;
    const m = this.memo;
    if (m && m.key === key && m.version === this.version && m.projects === doc.projects) return m.res;
    const res = this.run(q, doc, limit);
    this.memo = { key, version: this.version, projects: doc.projects, res };
    return res;
  }

  // ------------------------------------------------------------ 中で使う

  private sid(s: string): number {
    let i = this.strId.get(s);
    if (i === undefined) {
      i = this.strs.length;
      this.strId.set(s, i);
      this.strs.push(s);
      this.norms.push(undefined);
    }
    return i;
  }

  private norm(i: number): string {
    let v = this.norms[i];
    if (v === undefined) this.norms[i] = v = normalizeText(this.strs[i]!);
    return v;
  }

  private grow(n: number): void {
    if (n <= this.title.length) return;
    let cap = this.title.length;
    while (cap < n) cap *= 2;
    const g32 = (a: Int32Array): Int32Array<ArrayBuffer> => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    this.title = g32(this.title);
    this.restOff = g32(this.restOff);
    this.restLen = g32(this.restLen);
    this.tagsK = g32(this.tagsK);
    this.projK = g32(this.projK);
    const g = new Uint8Array(cap);
    g.set(this.goal);
    this.goal = g;
  }

  private poolPush(v: number): void {
    if (this.poolN >= this.pool.length) {
      const b = new Int32Array(this.pool.length * 2);
      b.set(this.pool);
      this.pool = b;
    }
    this.pool[this.poolN++] = v;
  }

  private drop(id: ID): void {
    const s = this.slotOf.get(id);
    if (s === undefined) return;
    this.slotOf.delete(id);
    this.ids[s] = null;
    this.alive--;
  }

  private putEntry(doc: DocData, graph: SearchGraph, id: ID): void {
    const n = doc.nodes[id]!;
    let s = this.slotOf.get(id);
    if (s === undefined) {
      s = this.ids.length;
      this.ids.push(id);
      this.slotOf.set(id, s);
      this.alive++;
      this.grow(s + 1);
    }
    this.title[s] = this.sid(n.title);
    this.goal[s] = n.type === "goal" ? 1 : 0;
    // 題名以外の文字（空の物は入れない）
    const off = this.poolN;
    if (n.body) this.poolPush(this.sid(n.body));
    const tags = n.tags.length ? this.tagsOf(n.tags) : null;
    if (tags) this.poolPush(tags.joined);
    for (const c of n.conditions) if (c.text) this.poolPush(this.sid(c.text));
    this.poolPush(this.labelSid(n));
    if (n.time.due) this.poolPush(this.sid(n.time.due));
    const short = n.meta?.short;
    if (typeof short === "string" && short) this.poolPush(this.sid(short));
    for (const eid of graph.inc.get(id) ?? []) {
      const e = doc.edges[eid];
      if (!e) continue;
      if (e.label) this.poolPush(this.sid(e.label));
      if (e.condition) this.poolPush(this.sid(e.condition));
    }
    this.restOff[s] = off;
    this.restLen[s] = this.poolN - off;
    this.tagsK[s] = tags ? tags.set : -1;
    this.projK[s] = n.projectIds.length ? this.projSet(n.projectIds) : -1;
  }

  /** 種類と状態の名前（2 つを 1 つの文字にして、組ごとに 1 度だけ表に入れる。種類 → 状態 → 番号） */
  private readonly labelSids = new Map<string, Map<string, number>>();
  private labelSid(n: GNode): number {
    let byStatus = this.labelSids.get(n.type);
    if (!byStatus) this.labelSids.set(n.type, (byStatus = new Map()));
    let i = byStatus.get(n.status);
    if (i === undefined) {
      i = this.sid(`${NODE_TYPES[n.type]?.label ?? ""} ${STATUSES[n.status]?.label ?? ""}`);
      byStatus.set(n.status, i);
    }
    return i;
  }

  /** タグの並び → つないだ文字の番号とタグの組の番号（同じ配列は 1 度だけ。組み立てた地図は配列を使い回す） */
  private readonly tagsMemo = new WeakMap<readonly string[], { joined: number; set: number }>();
  private tagsOf(tags: readonly string[]): { joined: number; set: number } {
    let r = this.tagsMemo.get(tags);
    if (!r) {
      const k = tags.join("\u0001");
      let i = this.tagSetId.get(k);
      if (i === undefined) {
        i = this.tagSets.length;
        this.tagSetId.set(k, i);
        this.tagSets.push(tags.map(normalizeText));
      }
      r = { joined: this.sid(tags.join(" ")), set: i };
      this.tagsMemo.set(tags, r);
    }
    return r;
  }

  /** プロジェクトの組の番号（同じ配列は 1 度だけ） */
  private readonly projMemo = new WeakMap<readonly ID[], number>();
  private projSet(pids: readonly ID[]): number {
    let i = this.projMemo.get(pids);
    if (i === undefined) {
      const k = pids.join("\u0001");
      i = this.projSetId.get(k);
      if (i === undefined) {
        i = this.projSets.length;
        this.projSetId.set(k, i);
        this.projSets.push(pids.slice());
      }
      this.projMemo.set(pids, i);
    }
    return i;
  }

  private run(q: SearchQuery, doc: DocData, limit: number): SearchResult {
    const nStr = this.strs.length;
    // 言葉ごとに、表の文字の当たり（2: 先頭から・1: 途中に・0: 無い）
    const termBits = q.terms.map((t) => {
      const b = new Uint8Array(nStr);
      for (let i = 0; i < nStr; i++) {
        const v = this.norm(i);
        const at = v.indexOf(t);
        b[i] = at === 0 ? 2 : at > 0 ? 1 : 0;
      }
      return b;
    });
    // プロジェクトの組ごとの名前の当たり（名前は今の文書から）
    const projBits = q.terms.map((t) =>
      this.projSets.map((ps) => {
        const names = ps.map((p) => doc.projects[p]?.name ?? "").join(" ");
        return names && normalizeText(names).includes(t) ? 1 : 0;
      }),
    );
    // タグの組ごとの点（0 = 当たらない）。言葉がタグだけでも、どのタグの言葉にも当たる組だけ
    let tagScore: Int32Array | null = null;
    if (q.tags.length) {
      tagScore = new Int32Array(this.tagSets.length);
      this.tagSets.forEach((tags, k) => {
        let sc = 0;
        for (const t of q.tags) {
          if (!tags.some((x) => x.startsWith(t))) return;
          sc += tags.includes(t) ? 30 : 20;
        }
        tagScore![k] = sc;
      });
    }
    const n = this.ids.length;
    const score = new Int32Array(n).fill(-1);
    const mask = new Uint8Array(n);
    let count = 0;
    let maxScore = 0;
    const T = termBits.length;
    for (let s = 0; s < n; s++) {
      if (this.ids[s] === null) continue;
      let sc = 0;
      if (tagScore) {
        const k = this.tagsK[s]!;
        if (k < 0) continue;
        const ts = tagScore[k]!;
        if (!ts) continue;
        sc += ts;
      }
      let ok = true;
      for (let k = 0; k < T; k++) {
        const b = termBits[k]!;
        const tb = b[this.title[s]!]!;
        if (tb === 2) sc += 40;
        else if (tb === 1) sc += 25;
        else {
          let hit = false;
          const o = this.restOff[s]!;
          const e = o + this.restLen[s]!;
          for (let j = o; j < e; j++) {
            if (b[this.pool[j]!]) {
              hit = true;
              break;
            }
          }
          if (!hit) {
            const pk = this.projK[s]!;
            hit = pk >= 0 && projBits[k]![pk] === 1;
          }
          if (!hit) {
            ok = false;
            break;
          }
          sc += 8;
        }
      }
      if (!ok) continue;
      if (this.goal[s]) sc += 2;
      score[s] = sc;
      mask[s] = 1;
      count++;
      if (sc > maxScore) maxScore = sc;
    }
    const hits = this.top(score, count, maxScore, limit);
    const slotOf = this.slotOf;
    return {
      hits,
      count,
      has: (id: ID) => {
        const s = slotOf.get(id);
        return s !== undefined && s < mask.length && mask[s] === 1;
      },
    };
  }

  /** 上の limit 件（点数の高い順・同じ点数は題名の順・同じ題名は場所の順＝文書の順） */
  private top(score: Int32Array, count: number, maxScore: number, limit: number): Array<{ id: ID; score: number }> {
    if (!count || limit <= 0) return [];
    // 点数ごとの数から、上の limit 件に入る一番低い点数（境目）を決める
    const hist = new Int32Array(maxScore + 1);
    for (let s = 0; s < score.length; s++) if (score[s]! >= 0) hist[score[s]!]!++;
    let above = 0;
    let border = 0;
    for (let v = maxScore; v >= 0; v--) {
      if (above + hist[v]! >= limit) {
        border = v;
        break;
      }
      above += hist[v]!;
      border = v;
    }
    const pick: number[] = [];
    const group: number[] = [];
    for (let s = 0; s < score.length; s++) {
      const v = score[s]!;
      if (v > border) pick.push(s);
      else if (v === border) group.push(s);
    }
    // 境目より上は全部（limit 件より少ない）、境目の点数の物は題名の順で足りるだけ
    const need = Math.min(group.length, limit - pick.length);
    const chosen = pick.concat(this.firstByTitle(group, need));
    chosen.sort((a, b) => score[b]! - score[a]! || this.cmpSlot(a, b));
    return chosen.map((s) => ({ id: this.ids[s]!, score: score[s]! }));
  }

  private cmpSlot(a: number, b: number): number {
    const ta = this.title[a]!;
    const tb = this.title[b]!;
    return (ta === tb ? 0 : titleCompare(this.strs[ta]!, this.strs[tb]!)) || a - b;
  }

  /** 場所の中から、題名の順（同じ題名は場所の順）で先頭の k 件。題名は違う物ごとに 1 度だけ比べる */
  private firstByTitle(slots: number[], k: number): number[] {
    if (k <= 0) return [];
    if (slots.length <= k) return slots;
    // 題名ごとにまとめる（場所の順）
    const byTitle = new Map<number, number[]>();
    for (const s of slots) {
      const t = this.title[s]!;
      let l = byTitle.get(t);
      if (!l) byTitle.set(t, (l = []));
      l.push(s);
    }
    const titles = [...byTitle.keys()];
    const cmp = (a: number, b: number) => titleCompare(this.strs[a]!, this.strs[b]!);
    let order: number[];
    if (titles.length <= 2048) order = titles.sort(cmp);
    else {
      // 題名が多いときは、先頭の k 個の題名だけを選ぶ（大きい物から外す山）
      const heap: number[] = [];
      const up = (i: number) => {
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (cmp(heap[i]!, heap[p]!) <= 0) break;
          [heap[i], heap[p]] = [heap[p]!, heap[i]!];
          i = p;
        }
      };
      const down = (i: number) => {
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && cmp(heap[l]!, heap[m]!) > 0) m = l;
          if (r < heap.length && cmp(heap[r]!, heap[m]!) > 0) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m]!, heap[i]!];
          i = m;
        }
      };
      for (const t of titles) {
        if (heap.length < k) {
          heap.push(t);
          up(heap.length - 1);
        } else if (cmp(t, heap[0]!) < 0) {
          heap[0] = t;
          down(0);
        }
      }
      order = heap.sort(cmp);
    }
    const out: number[] = [];
    for (const t of order) {
      for (const s of byTitle.get(t)!) {
        out.push(s);
        if (out.length >= k) return out;
      }
    }
    return out;
  }

  /** 生きているノードの数（確かめ用） */
  get size(): number {
    return this.alive;
  }
}
