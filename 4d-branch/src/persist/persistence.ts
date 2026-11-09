// 保存とデータ保護。設計: docs/DESIGN.md §5
//
// - 自動保存: 変更から 0.3 秒まとめて IndexedDB へ（続けて変更しても 2 秒以内に必ず書く）
// - 書き込みの競合: 保存ごとに版番号（rev）を確かめ、知らない書き込みがあれば上書きしない
// - 複数タブ: Web Locks で編集できるタブを 1 つにする（他は閲覧のみ・引き継ぎ可）
// - 離脱時: 未保存があれば localStorage に緊急コピーを同期で書き、次の起動で新しい方を採る
// - バックアップ: 自動・日次・手動・安全用（取り込み・復元の直前）・競合の退避。種類ごとに件数で間引く
// - IndexedDB が使えないブラウザは localStorage に、?stress などの一時表示はメモリだけに置く

import { toDateStr } from "../model/dates";
import { newId, nowISO } from "../model/ids";
import { docCounts, normalizeDoc } from "../model/schema";
import type { DocData, ID } from "../model/types";
import { Emitter } from "../store/emitter";
import { done, openDb, req } from "./idb";

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error" | "conflict" | "readonly" | "ephemeral";
/**
 * バックアップの種類。sync = 別の端末の内容を読み込む前（ふだんの同期で多い）、
 * kept = 利用者の選択で使わなかった内容（ほかの種類に押し出されない・自分の枠で多めに残す）
 */
export type BackupKind = "auto" | "daily" | "manual" | "safety" | "conflict" | "sync" | "kept";

export interface BackupMeta {
  id: ID;
  kind: BackupKind;
  label: string;
  createdAt: string;
  docTitle: string;
  counts: { nodes: number; edges: number; projects: number; scenarios: number };
}

interface StoredMeta {
  rev: number;
  savedAt: string;
  writer: string;
}

/** 同期で読み書きする小さな保存先（localStorage）。テストではメモリに差し替える */
export interface SyncKV {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
  keys(): string[];
}

export const browserKV: SyncKV = {
  get: (k) => {
    try {
      return globalThis.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    globalThis.localStorage.setItem(k, v);
  },
  remove: (k) => {
    try {
      globalThis.localStorage?.removeItem(k);
    } catch {
      /* 使えないときは何もしない */
    }
  },
  keys: () => {
    try {
      const ls = globalThis.localStorage;
      const out: string[] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k !== null) out.push(k);
      }
      return out;
    } catch {
      return [];
    }
  },
};

export function memoryKV(): SyncKV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k), keys: () => [...data.keys()] };
}

export const KEEP: Record<BackupKind, number> = { auto: 24, daily: 30, manual: 50, safety: 20, conflict: 20, sync: 20, kept: 50 };
export const BACKUP_LABELS: Record<BackupKind, string> = { auto: "自動", daily: "日次", manual: "手動", safety: "安全用", conflict: "退避", sync: "同期", kept: "選ばなかった内容" };
const AUTO_BACKUP_MS = 10 * 60_000;
const MAX_WAIT_MS = 2000;
/** タブのロックの答えを待つ上限。来なければロック無しで続ける（読み込み中の画面で止めない） */
const LOCK_TIMEOUT_MS = 3000;
const DB_VERSION = 1;

export class ConflictError extends Error {
  override name = "ConflictError";
}

export interface PersistenceOptions {
  dbName?: string;
  kv?: SyncKV;
  /** Web Locks（無ければ版番号の確認だけで守る） */
  locks?: LockManager | null;
  channel?: boolean;
  /** memory: 保存しない一時表示 */
  mode?: "auto" | "memory";
  debounceMs?: number;
  autoBackupMs?: number;
  lockTimeoutMs?: number;
}

export interface PersistenceEvents {
  status: { status: SaveStatus; savedAt: string | null; message?: string };
  writer: boolean;
  /** 別のタブが保存した（閲覧のみのタブが読み直す合図） */
  remote: void;
  notice: { level: "info" | "warn" | "error"; text: string };
}

function errorMessage(e: unknown): string {
  if (e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22)) {
    return "保存容量が足りません。不要なバックアップを消すか、エクスポートしてください。";
  }
  const name = e instanceof Error ? e.name : String(e);
  return `保存に失敗しました（${name}）。少し待って自動でやり直します。`;
}

export class Persistence {
  readonly tabId = newId("t");
  mode: "idb" | "local" | "memory";
  status: SaveStatus = "idle";
  private lastFailEmergencyAt = 0;
  statusMessage = "";
  savedAt: string | null = null;
  rev = 0;
  writer = false;
  /**
   * 手元に保存できている最新の印（保存が終わってから更新する）。アカウントの同期の基準は、
   * これを超えないときだけ書く（基準だけが先に残ると、次に開いたときに新しい写しを古い手元で潰しかねない）
   */
  lastStored: { id: string; updatedAt: string } | null = null;

  private readonly dbName: string;
  private readonly keys: { emergencyPrefix: string; emergency: string; doc: string; meta: string };
  private db: IDBDatabase | null = null;
  private readonly kv: SyncKV;
  private readonly locks: LockManager | null;
  private readonly useChannel: boolean;
  private bc: BroadcastChannel | null = null;
  private getDoc: (() => DocData) | null = null;
  private dirty = false;
  private saving: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  private lastAutoBackupAt = Date.now();
  private changesSinceBackup = false;
  /** 競合を見つけてから解決するまで自動保存を止める */
  private stopped = false;
  private readonly debounceMs: number;
  private readonly autoBackupMs: number;
  private readonly lockTimeoutMs: number;
  private readonly emitter = new Emitter<PersistenceEvents>();

  constructor(opts: PersistenceOptions = {}) {
    this.dbName = opts.dbName ?? "4d-branch";
    // 緊急コピーはタブごとの鍵（別のタブの保存が、閉じたタブの緊急コピーを消さないように）
    const emergencyPrefix = `${this.dbName}:emergency:`;
    this.keys = { emergencyPrefix, emergency: `${emergencyPrefix}${this.tabId}`, doc: `${this.dbName}:doc`, meta: `${this.dbName}:meta` };
    this.kv = opts.kv ?? browserKV;
    this.locks = opts.locks === undefined ? (globalThis.navigator?.locks ?? null) : opts.locks;
    this.useChannel = opts.channel !== false;
    this.mode = opts.mode === "memory" ? "memory" : "idb";
    this.debounceMs = opts.debounceMs ?? 300;
    this.autoBackupMs = opts.autoBackupMs ?? AUTO_BACKUP_MS;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  }

  on<K extends keyof PersistenceEvents>(type: K, fn: (p: PersistenceEvents[K]) => void): () => void {
    return this.emitter.on(type, fn);
  }

  get hasUnsaved(): boolean {
    return this.mode !== "memory" && (this.dirty || this.saving !== null);
  }

  private setStatus(status: SaveStatus, message = ""): void {
    this.status = status;
    this.statusMessage = message;
    this.emitter.emit("status", { status, savedAt: this.savedAt, message });
  }

  private notice(level: "info" | "warn" | "error", text: string): void {
    this.emitter.emit("notice", { level, text });
  }

  // ------------------------------------------------------------ 開く・読む

  async open(): Promise<void> {
    if (this.mode === "memory") {
      this.writer = true;
      this.setStatus("ephemeral");
      return;
    }
    try {
      if (typeof indexedDB === "undefined") throw new Error("IndexedDB がありません");
      this.db = await openDb(this.dbName, DB_VERSION, (db) => {
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("backupMeta")) db.createObjectStore("backupMeta", { keyPath: "id" });
        if (!db.objectStoreNames.contains("backupData")) db.createObjectStore("backupData", { keyPath: "id" });
      });
      this.db.onversionchange = () => {
        this.db?.close();
        this.db = null;
        this.notice("warn", "別のタブで新しい版のアプリが開かれました。このタブを再読み込みしてください。");
      };
      this.mode = "idb";
    } catch {
      this.mode = "local";
      this.notice("warn", "このブラウザでは IndexedDB が使えないため、小さな保存先（localStorage）に保存します。バックアップは作れないので、こまめにエクスポートしてください。");
    }
    if (this.useChannel && typeof BroadcastChannel !== "undefined") {
      this.bc = new BroadcastChannel(this.dbName);
      this.bc.onmessage = (ev: MessageEvent) => {
        const m = ev.data as { type?: string; tabId?: string } | null;
        if (m?.type === "saved" && m.tabId !== this.tabId && !this.writer) this.emitter.emit("remote", undefined);
      };
    }
  }

  close(): void {
    this.bc?.close();
    this.db?.close();
    this.db = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private async readMeta(): Promise<StoredMeta | null> {
    if (this.mode === "idb" && this.db) {
      const t = this.db.transaction("kv", "readonly");
      const meta = (await req(t.objectStore("kv").get("meta"))) as StoredMeta | undefined;
      return meta ?? null;
    }
    if (this.mode === "local") {
      const raw = this.kv.get(this.keys.meta);
      return raw ? (JSON.parse(raw) as StoredMeta) : null;
    }
    return null;
  }

  /** 保存してある本体（正規化してから返す）。無ければ null、読めなければ例外 */
  async readStored(): Promise<{ doc: DocData; meta: StoredMeta } | null> {
    let raw: unknown = null;
    let meta: StoredMeta | null = null;
    if (this.mode === "idb" && this.db) {
      const t = this.db.transaction("kv", "readonly");
      const s = t.objectStore("kv");
      const [d, m] = await Promise.all([req(s.get("doc")), req(s.get("meta"))]);
      raw = d ?? null;
      meta = (m as StoredMeta | undefined) ?? null;
    } else if (this.mode === "local") {
      const text = this.kv.get(this.keys.doc);
      raw = text ? JSON.parse(text) : null;
      const m = this.kv.get(this.keys.meta);
      meta = m ? (JSON.parse(m) as StoredMeta) : null;
    }
    if (raw == null) return null;
    const { doc } = normalizeDoc(raw);
    return { doc, meta: meta ?? { rev: 0, savedAt: doc.updatedAt, writer: "" } };
  }

  private readEmergencies(): Array<{ key: string; baseRev: number; tabId: string; doc: DocData | null }> {
    const out: Array<{ key: string; baseRev: number; tabId: string; doc: DocData | null }> = [];
    for (const key of this.kv.keys()) {
      if (!key.startsWith(this.keys.emergencyPrefix)) continue;
      const text = this.kv.get(key);
      if (!text) continue;
      try {
        const raw = JSON.parse(text) as { baseRev?: unknown; tabId?: unknown; doc?: unknown };
        out.push({ key, baseRev: typeof raw.baseRev === "number" ? raw.baseRev : -1, tabId: typeof raw.tabId === "string" ? raw.tabId : "", doc: normalizeDoc(raw.doc).doc });
      } catch {
        out.push({ key, baseRev: -1, tabId: "", doc: null });
      }
    }
    // 新しい順
    return out.sort((a, b) => (b.doc?.updatedAt ?? "").localeCompare(a.doc?.updatedAt ?? ""));
  }

  /**
   * 緊急コピー（閉じたタブが保存しきれなかった変更）を片付ける。編集できるタブだけが行う。
   * 本体より新しく、本体がその続き（同じ版から・同じタブが書いた）なら採る。別の保存と重なっていたらバックアップへ退避。
   * 本体と同じか古ければ、もう保存されているので黙って消す
   */
  private async consumeEmergencies(stored: { doc: DocData; meta: StoredMeta } | null, notices: string[]): Promise<DocData | null> {
    if (!this.writer) return null;
    let adopted: DocData | null = null;
    for (const em of this.readEmergencies()) {
      if (em.doc) {
        // 本体がこの写しの元の版のまま（その後に保存が無い）なら、時刻が違えば写しの方が先の内容
        const sameBase = !!stored && em.baseRev === stored.meta.rev;
        const newer = !stored || em.doc.updatedAt > stored.doc.updatedAt || (sameBase && em.doc.updatedAt !== stored.doc.updatedAt);
        if (newer) {
          const continues = !stored || sameBase || (em.tabId !== "" && stored.meta.writer === em.tabId);
          if (continues && !adopted) {
            adopted = em.doc;
            notices.push("前回、保存しきれなかった変更を復元しました。");
          } else {
            const saved = await this.createBackup("conflict", "前回の未保存の変更（別の保存と重なった）", em.doc).catch(() => null);
            if (!saved) {
              // 退避できなかった写しは消さない（次に開いたときにもう一度試す）
              notices.push("前回の未保存の変更が別の保存と重なりましたが、バックアップを作れなかったため、消さずに残しています（JSON で書き出しておくと安心です）。");
              continue;
            }
            notices.push("前回の未保存の変更が別の保存と重なったため、バックアップに退避しました（メニュー →「バックアップと復元」）。");
          }
        }
      }
      this.kv.remove(em.key);
    }
    if (adopted) this.dirty = true;
    return adopted;
  }

  /**
   * 起動時の読み込み。緊急コピーがあれば、保存してある本体と比べて新しい方を採る
   * （本体の版が緊急コピーの元の版より進んでいたら＝別のタブが保存していたら、緊急コピーはバックアップへ退避）。
   * recovered: 保存してあった本体を読めず、バックアップ（か何も無し）で始めた
   */
  async loadInitial(): Promise<{ doc: DocData | null; notices: string[]; recovered: boolean }> {
    const notices: string[] = [];
    if (this.mode === "memory") return { doc: null, notices, recovered: false };
    let stored: { doc: DocData; meta: StoredMeta } | null = null;
    let recovered = false;
    try {
      stored = await this.readStored();
    } catch {
      recovered = true;
      const fallback = await this.latestBackupDoc();
      if (fallback) {
        notices.push("保存してあったデータを読めなかったため、いちばん新しいバックアップから復元しました。");
        stored = { doc: fallback, meta: (await this.readMeta().catch(() => null)) ?? { rev: 0, savedAt: fallback.updatedAt, writer: "" } };
        this.dirty = true;
      } else {
        notices.push("保存してあったデータを読めませんでした。");
      }
    }
    if (stored) {
      this.rev = stored.meta.rev;
      this.savedAt = stored.meta.savedAt;
      // 保存できている内容（バックアップから戻した物・緊急コピーは、まだ本体に保存できていない）
      if (!recovered) this.lastStored = { id: stored.doc.id, updatedAt: stored.doc.updatedAt };
    }
    const adopted = await this.consumeEmergencies(stored, notices);
    const doc = adopted ?? stored?.doc ?? null;
    return { doc, notices, recovered };
  }

  private async latestBackupDoc(): Promise<DocData | null> {
    try {
      const list = await this.listBackups();
      for (const b of list) {
        const d = await this.readBackup(b.id);
        if (d) return d;
      }
    } catch {
      /* バックアップも読めない */
    }
    return null;
  }

  // ------------------------------------------------------------ 保存

  /** ストアにつなぐ。以後 markDirty() のたびに自動保存する */
  attach(getDoc: () => DocData): void {
    this.getDoc = getDoc;
    if (this.mode === "memory") return;
    if (this.dirty && this.writer) this.schedule();
    else if (this.writer) this.setStatus(this.savedAt ? "saved" : "idle");
    else this.setStatus("readonly");
  }

  markDirty(): void {
    if (this.mode === "memory") return;
    this.changesSinceBackup = true;
    if (!this.dirty) {
      this.dirty = true;
      this.firstDirtyAt = Date.now();
    }
    if (this.stopped) return this.setStatus("conflict", this.statusMessage);
    if (!this.writer) return this.setStatus("readonly");
    // 保存に失敗している間は、表示を「保存できません」のままにして、5 秒後の再試行を待つ
    if (this.status === "error" && this.retryTimer) return;
    this.setStatus("pending");
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const wait = Date.now() - this.firstDirtyAt >= MAX_WAIT_MS ? 0 : this.debounceMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, wait);
  }

  /** すぐに保存する（タブが隠れたとき・⌘S・取り込みの前） */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.saving) await this.saving;
    if (this.dirty) await this.save();
  }

  private async save(): Promise<void> {
    if (!this.getDoc || !this.writer || this.stopped || this.mode === "memory") return;
    if (this.saving) {
      await this.saving;
      if (this.dirty) return this.save();
      return;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.dirty = false;
    this.setStatus("saving");
    const run = async () => {
      const doc = this.getDoc!();
      // 書く前に印を取る（書き終わるまでの間の変更は、印より新しいだけ。保存できた内容を多く見積もらない）
      const ident = { id: doc.id, updatedAt: doc.updatedAt };
      try {
        const newRev = await this.writeStored(doc, this.rev);
        this.rev = newRev;
        this.lastStored = ident;
        this.savedAt = nowISO();
        if (!this.dirty) this.kv.remove(this.keys.emergency);
        this.bc?.postMessage({ type: "saved", rev: newRev, tabId: this.tabId });
        this.setStatus(this.dirty ? "pending" : "saved");
        await this.maybeAutoBackup(doc).catch(() => undefined);
      } catch (e) {
        this.dirty = true;
        // 失敗の後は、入力のたびにすぐ保存し直さない（やり直しは 5 秒後の再試行に任せる）
        this.firstDirtyAt = Date.now();
        if (e instanceof ConflictError) {
          this.stopped = true;
          await this.createBackup("conflict", "保存の競合で退避した内容", doc).catch(() => undefined);
          this.setStatus("conflict", "別のタブで保存された内容があるため、上書きせずに止めました。手元の内容はバックアップに退避してあります。");
        } else {
          if (Date.now() - this.lastFailEmergencyAt > 5000) {
            this.lastFailEmergencyAt = Date.now();
            this.writeEmergency(true);
          }
          this.setStatus("error", errorMessage(e));
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.save();
          }, 5000);
        }
      }
    };
    this.saving = run();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
    if (this.dirty && !this.stopped && this.writer && this.status !== "error") this.schedule();
  }

  /** 版番号を確かめてから書く（1 つのトランザクションの中で読む→比べる→書く） */
  private async writeStored(doc: DocData, expectedRev: number): Promise<number> {
    const meta: StoredMeta = { rev: expectedRev + 1, savedAt: nowISO(), writer: this.tabId };
    if (this.mode === "idb") {
      if (!this.db) throw new Error("IndexedDB が閉じています");
      const t = this.db.transaction("kv", "readwrite");
      const s = t.objectStore("kv");
      let conflict = false;
      const r = s.get("meta");
      r.onsuccess = () => {
        const cur = (r.result as StoredMeta | undefined)?.rev ?? 0;
        if (cur !== expectedRev) {
          conflict = true;
          t.abort();
          return;
        }
        s.put(doc, "doc");
        s.put(meta, "meta");
      };
      try {
        await done(t);
      } catch (e) {
        if (conflict) throw new ConflictError("rev");
        throw e;
      }
      return meta.rev;
    }
    // localStorage
    const curRaw = this.kv.get(this.keys.meta);
    const cur = curRaw ? (JSON.parse(curRaw) as StoredMeta).rev : 0;
    if (cur !== expectedRev) throw new ConflictError("rev");
    this.kv.set(this.keys.doc, JSON.stringify(doc));
    this.kv.set(this.keys.meta, JSON.stringify(meta));
    return meta.rev;
  }

  /** 閉じる・隠れる瞬間に、未保存の内容を同期で残す（次の起動で採るか比べる） */
  writeEmergency(force = false): void {
    if (this.mode === "memory" || !this.getDoc) return;
    if (!force && !this.hasUnsaved) return;
    try {
      const doc = this.getDoc();
      this.kv.set(this.keys.emergency, JSON.stringify({ v: 1, baseRev: this.rev, at: nowISO(), tabId: this.tabId, doc }));
    } catch {
      /* 容量不足など。IndexedDB の保存に任せる */
    }
  }

  /** 競合の解決: reload = 保存されている最新を採る / overwrite = 手元の内容で上書きする（どちらも手元はバックアップ済み） */
  async resolveConflict(choice: "reload" | "overwrite"): Promise<DocData | null> {
    if (choice === "reload") {
      const s = await this.readStored();
      if (s) {
        this.rev = s.meta.rev;
        this.savedAt = s.meta.savedAt;
        this.lastStored = { id: s.doc.id, updatedAt: s.doc.updatedAt };
      }
      this.stopped = false;
      this.dirty = false;
      this.setStatus("saved");
      return s?.doc ?? null;
    }
    const meta = await this.readMeta();
    this.rev = meta?.rev ?? this.rev;
    this.stopped = false;
    this.dirty = true;
    await this.save();
    return null;
  }

  // ------------------------------------------------------------ 小さな鍵と値（同期の基準など。本体と同じ寿命の場所に置く）

  private memKv = new Map<string, unknown>();

  async readKv<T>(key: string): Promise<T | null> {
    if (this.mode === "idb" && this.db) {
      const t = this.db.transaction("kv", "readonly");
      return ((await req(t.objectStore("kv").get(`x:${key}`))) as T | undefined) ?? null;
    }
    if (this.mode === "local") {
      const raw = this.kv.get(`${this.dbName}:x:${key}`);
      try {
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return null;
      }
    }
    return (this.memKv.get(key) as T | undefined) ?? null;
  }

  async writeKv(key: string, value: unknown): Promise<void> {
    if (this.mode === "idb" && this.db) {
      const t = this.db.transaction("kv", "readwrite");
      t.objectStore("kv").put(value, `x:${key}`);
      await done(t);
      return;
    }
    if (this.mode === "local") {
      try {
        this.kv.set(`${this.dbName}:x:${key}`, JSON.stringify(value));
      } catch {
        /* 容量不足など */
      }
      return;
    }
    this.memKv.set(key, value);
  }

  // ------------------------------------------------------------ バックアップ

  private async maybeAutoBackup(doc: DocData): Promise<void> {
    if (!this.changesSinceBackup || Date.now() - this.lastAutoBackupAt < this.autoBackupMs) return;
    this.lastAutoBackupAt = Date.now();
    this.changesSinceBackup = false;
    await this.createBackup("auto", "", doc);
  }

  get canBackup(): boolean {
    return this.mode === "idb" && this.db !== null;
  }

  async createBackup(kind: BackupKind, label: string, doc?: DocData): Promise<BackupMeta | null> {
    const d = doc ?? this.getDoc?.();
    if (!d || !this.canBackup) return null;
    const meta: BackupMeta = { id: newId("b"), kind, label, createdAt: nowISO(), docTitle: d.title, counts: docCounts(d) };
    const t = this.db!.transaction(["backupMeta", "backupData"], "readwrite");
    try {
      // 中身を先に（写せない中身なら、見出しだけの行を残さない）
      t.objectStore("backupData").put({ id: meta.id, doc: d });
      t.objectStore("backupMeta").put(meta);
    } catch (e) {
      try {
        t.abort();
      } catch {
        /* すでに終わっている */
      }
      throw e;
    }
    await done(t);
    await this.prune(kind);
    return meta;
  }

  async listBackups(): Promise<BackupMeta[]> {
    if (!this.canBackup) return [];
    const t = this.db!.transaction("backupMeta", "readonly");
    const all = (await req(t.objectStore("backupMeta").getAll())) as BackupMeta[];
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async readBackup(id: ID): Promise<DocData | null> {
    if (!this.canBackup) return null;
    const t = this.db!.transaction("backupData", "readonly");
    const rec = (await req(t.objectStore("backupData").get(id))) as { doc?: unknown } | undefined;
    if (!rec?.doc) return null;
    try {
      return normalizeDoc(rec.doc).doc;
    } catch {
      return null;
    }
  }

  async deleteBackup(id: ID): Promise<void> {
    if (!this.canBackup) return;
    const t = this.db!.transaction(["backupMeta", "backupData"], "readwrite");
    t.objectStore("backupMeta").delete(id);
    t.objectStore("backupData").delete(id);
    await done(t);
  }

  private async prune(kind: BackupKind): Promise<void> {
    const list = (await this.listBackups()).filter((b) => b.kind === kind);
    const extra = list.slice(KEEP[kind]);
    if (extra.length === 0) return;
    const t = this.db!.transaction(["backupMeta", "backupData"], "readwrite");
    for (const b of extra) {
      t.objectStore("backupMeta").delete(b.id);
      t.objectStore("backupData").delete(b.id);
    }
    await done(t);
  }

  /** その日の最初の起動で、読み込んだ状態を日次バックアップに残す */
  async ensureDailyBackup(doc: DocData): Promise<void> {
    if (!this.canBackup) return;
    const today = toDateStr(new Date());
    const list = await this.listBackups();
    if (list.some((b) => b.kind === "daily" && toDateStr(new Date(b.createdAt)) === today)) return;
    await this.createBackup("daily", "", doc);
  }

  // ------------------------------------------------------------ 複数タブ

  private setWriter(w: boolean): void {
    if (this.writer === w) return;
    this.writer = w;
    this.emitter.emit("writer", w);
  }

  private get lockName(): string {
    return `${this.dbName}:writer`;
  }

  /** 編集できるタブになれたら true（別のタブが編集中なら false＝閲覧のみ） */
  async acquireWriter(): Promise<boolean> {
    if (this.mode === "memory") {
      this.writer = true;
      return true;
    }
    const ok = !this.locks || (await this.requestLock({ ifAvailable: true }));
    if (ok) this.setWriter(true);
    return ok;
  }

  /** このタブで編集する（別のタブから引き継ぐ）。最新の保存内容を返す */
  async takeOver(): Promise<DocData | null> {
    if (this.locks) await this.requestLock({ steal: true });
    const stored = await this.readStored();
    if (stored) {
      this.rev = stored.meta.rev;
      this.savedAt = stored.meta.savedAt;
      this.lastStored = { id: stored.doc.id, updatedAt: stored.doc.updatedAt };
    }
    this.stopped = false;
    this.dirty = false;
    this.setWriter(true);
    const notices: string[] = [];
    const adopted = await this.consumeEmergencies(stored, notices);
    for (const n of notices) this.notice("info", n);
    if (adopted) this.schedule();
    else this.setStatus(this.savedAt ? "saved" : "idle");
    return adopted ?? stored?.doc ?? null;
  }

  /**
   * 書き手のロックを頼む。true: 編集してよい／false: 別のタブが持っている（ifAvailable のとき）。
   * 取れたロックはタブを閉じるまで持ち、後で別のタブに引き継がれたら閲覧のみになる。
   * 要求そのものが断られたとき（保存を禁じた枠の中などの SecurityError）や答えが来ないときは、
   * Web Locks の無いブラウザと同じくロック無しで続ける（版番号の確認で守る。起動を止めない）
   */
  private requestLock(options: LockOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let answered = false;
      let held = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = (ok: boolean): boolean => {
        if (answered) return false;
        answered = true;
        clearTimeout(timer);
        resolve(ok);
        return true;
      };
      timer = setTimeout(() => answer(true), this.lockTimeoutMs);
      try {
        this.locks!.request(this.lockName, options, (lock) => {
          if (!lock) {
            // 別のタブが持っている。答えが遅れてロック無しで編集を始めていたら、閲覧のみに戻す
            if (!answer(false)) this.lockLost();
            return;
          }
          held = true;
          answer(true);
          return new Promise<void>(() => {
            /* タブを閉じるまで持ち続ける */
          });
        }).catch(() => {
          if (held) this.lockLost(); // 別のタブに引き継がれた
          else answer(true); // 要求が断られた（コールバックは呼ばれていない）
        });
      } catch {
        answer(true);
      }
    });
  }

  private lockLost(): void {
    if (!this.writer) return;
    const doc = this.getDoc?.();
    if (this.dirty && doc) void this.createBackup("conflict", "別のタブに編集を引き継いだときの未保存の変更", doc).catch(() => undefined);
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setWriter(false);
    this.setStatus("readonly");
  }

  // ------------------------------------------------------------ 保存先の状態

  async storageInfo(): Promise<{ persisted: boolean | null; usage: number | null; quota: number | null }> {
    const s = globalThis.navigator?.storage;
    const persisted = s?.persisted ? await s.persisted().catch(() => null) : null;
    const est = s?.estimate ? await s.estimate().catch(() => null) : null;
    return { persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
  }

  /** ブラウザの自動削除から守るよう頼む */
  async requestPersist(): Promise<boolean> {
    const s = globalThis.navigator?.storage;
    if (!s?.persist) return false;
    return s.persist().catch(() => false);
  }
}
