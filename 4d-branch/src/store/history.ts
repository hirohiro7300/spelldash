// 編集履歴（Undo/Redo）。1 回の操作 = 1 つの記録。記録はエンティティ単位の「前」と「後」（不変なので参照だけ持つ）

import type { Collection, DocData, ID } from "../model/types";

export interface EntityChange {
  c: Collection;
  id: ID;
  /** 前の値（undefined = 無かった） */
  before: unknown;
  /** 後の値（undefined = 消した） */
  after: unknown;
}

export type OrderKey = "projectOrder" | "scenarioOrder";

export interface HistoryEntry {
  label: string;
  at: number;
  /** 同じ鍵の続けての変更（文字入力など）を 1 つにまとめる */
  coalesce?: string;
  sealed: boolean;
  entities: Map<string, EntityChange>;
  orders: Map<OrderKey, { before: ID[]; after: ID[] }>;
  title?: { before: string; after: string };
  /** ドキュメントごとの入れ替え（取り込み・復元） */
  replace?: { before: DocData; after: DocData };
  /** 大きな文書の入れ替え（前か後のノードが HEAVY_REPLACE_NODES 以上。履歴に持つ数を限る） */
  heavy?: boolean;
}

/**
 * 大きな文書の入れ替え（ノードがこれ以上）は、履歴に HEAVY_REPLACE_KEEP 件までしか持たない（1 件で入れ物 2 組・数十 MB になる:
 * 作業メモ SPEC v1 §6「History」・見直し perf-6）。それより小さい文書（今の地図・やりたいことリストなど）は今までどおり
 */
export const HEAVY_REPLACE_NODES = 10_000;
export const HEAVY_REPLACE_KEEP = 2;

/** ノードの数がこれ以上か（数え終わる前にやめる） */
function atLeast(o: object, n: number): boolean {
  let k = 0;
  for (const _ in o) if (++k >= n) return true;
  return false;
}

/** 大きな文書の入れ替えか */
export function isHeavyReplace(r: { before: DocData; after: DocData }): boolean {
  return atLeast(r.before.nodes, HEAVY_REPLACE_NODES) || atLeast(r.after.nodes, HEAVY_REPLACE_NODES);
}

export function newEntry(label: string, coalesce?: string): HistoryEntry {
  return { label, at: Date.now(), coalesce, sealed: false, entities: new Map(), orders: new Map() };
}

export function isEmptyEntry(e: HistoryEntry): boolean {
  return e.entities.size === 0 && e.orders.size === 0 && !e.title && !e.replace;
}

const COALESCE_MS = 2000;

export class History {
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  constructor(public limit = 300) {}

  push(entry: HistoryEntry): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (entry.coalesce && top && top.coalesce === entry.coalesce && !top.sealed && entry.at - top.at < COALESCE_MS && !top.replace && !entry.replace) {
      for (const [k, ch] of entry.entities) {
        const ex = top.entities.get(k);
        if (ex) ex.after = ch.after;
        else top.entities.set(k, ch);
      }
      for (const [k, o] of entry.orders) {
        const ex = top.orders.get(k);
        if (ex) ex.after = o.after;
        else top.orders.set(k, o);
      }
      if (entry.title) top.title = top.title ? { before: top.title.before, after: entry.title.after } : entry.title;
      top.at = entry.at;
    } else {
      if (top) top.sealed = true;
      if (entry.replace && entry.heavy === undefined) entry.heavy = isHeavyReplace(entry.replace);
      this.undoStack.push(entry);
      if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
      if (entry.heavy) this.capHeavy();
    }
    this.redoStack = [];
  }

  /**
   * 大きな文書の入れ替えを、新しい方から HEAVY_REPLACE_KEEP 件だけ残す。それより古い入れ替えは、その記録から下（古い方）ごと捨てる
   * （元に戻すは、残した中で一番古い入れ替えの直前までで止まる。途中の記録だけを抜くと、戻した先の文書が合わなくなる）
   */
  private capHeavy(): void {
    let seen = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      if (!this.undoStack[i]!.heavy) continue;
      if (++seen > HEAVY_REPLACE_KEEP) {
        this.undoStack.splice(0, i + 1);
        return;
      }
    }
  }

  /** まとめを打ち切る（入力欄から離れたときなど） */
  seal(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.sealed = true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }
}
