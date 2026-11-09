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
      this.undoStack.push(entry);
      if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
    }
    this.redoStack = [];
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
