// 保存とデータ保護。設計: docs/DESIGN.md §5
//
// - 自動保存: 変更から 0.3 秒まとめて IndexedDB へ（続けて変更しても 2 秒以内に必ず書く）
// - 書き込みの競合: 保存ごとに版番号（rev）を確かめ、知らない書き込みがあれば上書きしない
// - 複数タブ: Web Locks で編集できるタブを 1 つにする（他は閲覧のみ・引き継ぎ可）
// - 離脱時: 未保存があれば localStorage に緊急コピーを同期で書き、次の起動で新しい方を採る
// - バックアップ: 自動・日次・手動・安全用（取り込み・復元の直前）・競合の退避。種類ごとに件数で間引く
// - IndexedDB が使えないブラウザは localStorage に、?stress などの一時表示はメモリだけに置く
// - このページより新しい版で保存されたデータ: 壊れたデータと分ける。本体なら読まずに止め（blocked）、以後は何も書かない。
//   緊急コピー・バックアップは読まずに残す（消さない・採らない・復元しない）。新しい版の緊急コピーが本体より後の変更なら、それでも止める
// - 書く物・読む物はどれも保存の口（./codec.ts）を通す: ページの地図を持つ文書は薄い形（版 2）で書き、読むときに地図から組み立て直す。
//   版の記録・バックアップの見出しには、書いた形の版（docVersion）と、薄い形なら地図の版の順番と中身の指紋（mapRelease・mapHash）を書く
// - 読めなかった訳は記録の形で分ける（safety-3）: 版 2 以上か地図の変更がある記録は、何が投げられても止める側（blocked。消さない・
//   代わりの内容で始めない・上書きしない・バックアップでも始めない）。版 1 の記録の読めない JSON・形だけが、今までどおり壊れたデータ
// - 同じ版で地図が合わない記録は、利用者が「この版で開き直す」を選んだときだけ、安全用バックアップに記録をそのまま残してから、鍵で当て直して開く

import { toDateStr } from "../model/dates";
import { newId, nowISO } from "../model/ids";
import { NewerDocError, docCounts, isNewerVersion } from "../model/schema";
import type { DocData, ID } from "../model/types";
import { Emitter } from "../store/emitter";
import {
  guardStoredSize,
  classifyReadFailure,
  decodeStored,
  decodeStoredAsync,
  ensurePageMap,
  hasThinBaseline,
  headerBlock,
  isNewerRecord,
  isThinShape,
  needsPageMap,
  pageRelease,
  recordInfo,
  thinReadable,
  ThinMapError,
  ThinNewerError,
  ThinWriteError,
  StoredTooLargeError,
  toStored,
  upgradeNotice,
  type ReadFailure,
  type ThinErrorCode,
  type ThinUpgradeInfo,
  type ThinUpgradeMode,
} from "./codec";
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
  /**
   * 中身のドキュメントの版（書いた形の版: 薄い形なら 2）。このページより新しければ、中身を読まずに「新しい版」と分かる
   * （一覧の印・復元しない・間引かない）。前の版が作ったバックアップには無い（版 1）
   */
  docVersion?: number;
  /** 薄い形のとき、地図の版の順番・中身の指紋・組み立ての版（このページより新しい版・同じ版で合わない地図を、中身を読まずに見分ける） */
  mapRelease?: number;
  mapHash?: string;
  mapBv?: number;
}

/** このページより新しい版で作られたバックアップか（見出しの版で分かる物。中身でしか分からない物は readBackupChecked で） */
export function isNewerBackup(b: Pick<BackupMeta, "docVersion" | "mapRelease" | "mapHash" | "mapBv">): boolean {
  return headerBlock(b) === "newer";
}

/** このページでは開けない地図のバックアップか（同じ版の順番で中身の指紋か組み立ての版が違う。見出しで分かる物。止める側: 復元しない・間引かない） */
export function isBlockedBackup(b: Pick<BackupMeta, "docVersion" | "mapRelease" | "mapHash" | "mapBv">): boolean {
  return headerBlock(b) === "blocked";
}

interface StoredMeta {
  rev: number;
  savedAt: string;
  writer: string;
  /**
   * 保存してある本体の版（書いた形の版: 薄い形なら 2）。このページより新しければ、版番号が合っていても上書きしない
   * （本体を読まなくても分かる守り）。前の版が書いた記録には無い（版 1）
   */
  docVersion?: number;
  /** 薄い形のとき、地図の版の順番・中身の指紋・組み立ての版（このページより新しい版の地図なら、版番号が合っていても上書きしない） */
  mapRelease?: number;
  mapHash?: string;
  mapBv?: number;
}

/**
 * 版の記録が、このページより新しい版の本体を指していれば NewerDocError（本体を読む前に分かる。本体の形が変わっていても、無いと見なさない）。
 * 地図の版の順番は、ページの地図を読んであるときだけ比べる（まだなら、本体を読むときに分かる）
 */
function checkMetaVersion(meta: StoredMeta | null): void {
  const v = meta?.docVersion;
  if (isNewerVersion(v)) throw new NewerDocError(Math.floor(v));
  const rel = pageRelease();
  if (typeof meta?.mapRelease === "number" && rel !== null && meta.mapRelease > rel) throw new ThinNewerError(meta.mapRelease);
}

/** 版の記録が、このページでは上書きしてはいけない本体を指しているか（新しい版の形・新しい版の地図） */
function metaForbidsWrite(meta: StoredMeta | null | undefined): boolean {
  if (isNewerVersion(meta?.docVersion)) return true;
  const rel = pageRelease();
  return typeof meta?.mapRelease === "number" && rel !== null && meta.mapRelease > rel;
}

/**
 * 止めた訳: newer このページより新しい版のデータ（新しい版のページで開く）・stored 保存してあるデータをこのページでは開けない
 * （地図が合わない・地図を組み立てられない・薄い形が読めない。開き直すか、そのまま書き出すか、「この版で開き直す」）
 */
export interface BlockInfo {
  kind: "newer" | "stored";
  /** stored のときの細かい訳（mismatch・older・unavailable・corrupt） */
  code?: ThinErrorCode;
  /** 画面に出す訳の文（読めなかった物の文） */
  message?: string;
  /** 「この版で開き直す」で開けるか（同じ版で地図が合わない・前の版の地図） */
  reopen?: boolean;
}

/** 止めたときにそのまま書き出す記録（本体か、本体より後の緊急コピー） */
export interface RawRecord {
  /** 書き出す文字（記録をそのまま JSON に。読めない文字なら、その文字のまま） */
  text: string;
  /** どこの物か（知らせに使う） */
  source: "body" | "emergency" | "backup";
}

/** 読めなかった訳の文 */
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 止める側の失敗を、止めた訳にする */
function blockInfoOf(e: unknown): BlockInfo {
  if (e instanceof NewerDocError) return { kind: "newer" };
  const code = e instanceof ThinMapError ? e.code : "corrupt";
  return { kind: "stored", code, message: errorText(e), reopen: code === "mismatch" || code === "older" };
}

/** 緊急コピーの包みの形の版。これより新しい包みは、中身を読まずに残す（新しい版のページの写し） */
const EMERGENCY_FORMAT = 1;

/**
 * 開いている間に新しい版のデータに気づいて止めたとき、このタブのまだどこにも無い変更を残した所
 * （backup: 「退避」のバックアップ・copy: このタブの緊急コピー・null: 残す物が無い・残せなかった）
 */
export type KeptAside = "backup" | "copy" | null;

/** 緊急コピー（閉じたタブが保存しきれなかった変更）を読んだ物 */
interface EmergencyCopy {
  key: string;
  baseRev: number;
  tabId: string;
  /** 読めた中身（読めない・新しい版・止める側なら null） */
  doc: DocData | null;
  /** このページより新しい版の写し（読めないが壊れてもいない。消さずに残す） */
  newer: boolean;
  /** 薄い形の写しで、このページでは開けない物（地図が合わない など。壊れてもいないので消さずに残す: safety-3） */
  blocked: boolean;
  /** 止める側の訳（blocked のとき） */
  error?: unknown;
  /** 中身の書いた形の版（無ければ 1）。本体の版と違う写しは、古く見えても黙って消さない（別の版のページの間で分かれた内容） */
  docVersion: number;
  /** 中身の更新時刻（読まずに分かる範囲で。新しい版の写しが本体より後かを見るだけに使う） */
  rawUpdatedAt: string;
  /** 写しの中身をそのまま（止めたときに書き出す） */
  rawDoc: unknown;
}

/** 保存してある本体を読んだ物（読めない訳も分けて持つ） */
interface StoredRecord {
  /** 本体（無ければ null。localStorage で JSON として読めなければ undefined） */
  raw: unknown;
  meta: StoredMeta | null;
  /** localStorage の本体の文字（読めない物もそのまま書き出せるように） */
  text: string | null;
  /** 本体を JSON として読めなかった */
  parseError: unknown;
}

/** 本体を読めなかった訳（記録の形で分けた物）と、そのまま書き出せる記録 */
interface StoredFailure {
  fail: ReadFailure;
  error: unknown;
  record: RawRecord | null;
  meta: StoredMeta | null;
}

/** 本体を読んで整えた物 */
interface StoredDoc {
  doc: DocData;
  meta: StoredMeta;
  /** 前の版・違う組み立ての地図を、鍵でページの地図に当て直して読んだ（数） */
  upgrade?: ThinUpgradeInfo;
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
  /**
   * このページより新しい版で保存されたデータ・このページでは開けない保存してあるデータに気づいて止めた（以後は何も書かない。
   * 画面は開き直すよう伝える）。kept: このタブのまだどこにも無い変更を残した所（画面で伝える。起動で止めたときは null）。why: 止めた訳
   */
  blocked: { kept: KeptAside; why?: BlockInfo };
}

/** 書く形の見出しの印（版の記録・バックアップの見出し）: 形の版と、薄い形なら地図の版の順番・中身の指紋・組み立ての版 */
function headerOf(stored: unknown): { docVersion: number; mapRelease?: number; mapHash?: string; mapBv?: number } {
  const info = recordInfo(stored);
  return { docVersion: info.format, ...(info.mapRelease !== undefined ? { mapRelease: info.mapRelease, mapHash: info.mapHash, mapBv: info.mapBv } : {}) };
}

/** そのまま残す記録の件数（入っている物だけ数える。薄い形は地図のカードを数えない） */
function rawCounts(raw: unknown): BackupMeta["counts"] {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const n = (v: unknown): number => (v && typeof v === "object" ? Object.keys(v).length : 0);
  return { nodes: n(o.nodes), edges: n(o.edges), projects: n(o.projects), scenarios: n(o.scenarios) };
}

/** そのまま残す記録の題名（読めなければ空） */
function rawTitle(raw: unknown): string {
  const t = raw && typeof raw === "object" ? (raw as { title?: unknown }).title : undefined;
  return typeof t === "string" ? t : "";
}

function errorMessage(e: unknown): string {
  if (e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22)) {
    return "保存容量が足りません。不要なバックアップを消すか、エクスポートしてください。";
  }
  // 大きすぎる（localStorage に 400 万文字を超えて書かない）・地図ごと書いてしまう形（書かない）: 訳をそのまま出す
  if (e instanceof StoredTooLargeError || e instanceof ThinWriteError) return `${e.message}。JSON で書き出しておくと安心です。`;
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
  /**
   * このページより新しい版で保存されたデータに気づいて止めた（起動したときの本体・保存先の形、または開いている間に
   * 別のタブの新しい版のページが保存した）。以後は何も書かない: 本体・版の記録・緊急コピー・バックアップ・小さな鍵と値。
   * 書き手のロックも手放す（新しい版のページのタブが、引き継がずに編集を始められるように）
   */
  blocked = false;
  /** 止めた訳（止めていなければ null） */
  blockedWhy: BlockInfo | null = null;
  /** 止めたときの、このページでは開けない記録（「保存されているデータをそのまま書き出す」で書き出す。無ければ保存先から読み直す） */
  private blockedRecord: RawRecord | null = null;

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
  /** 持っている書き手のロックを手放す（持っていなければ null） */
  private releaseLock: (() => void) | null = null;
  /** 別のタブに引き継がれたときに、このタブのまだどこにも無い変更を「退避」に残した（後で止めたときに画面で伝える） */
  private keptAside: KeptAside = null;
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
      this.db.onversionchange = (ev) => {
        // このページは開いている間に保存先の版を上げない。上げたのはこのページより新しい版のページ: 開いている間でも止める
        // （接続は止めるときに閉じ、書き手のロックも手放す。まだ保存していない変更は、このタブの緊急コピーに残してから）
        if (ev.newVersion !== null && ev.newVersion > DB_VERSION) return this.blockNewer(this.writer && this.dirty ? this.keepUnsaved(null) : null);
        // 消された（版を上げたのではない）: 今までどおり知らせるだけ（止めると、ここにしか無くなった内容を緊急コピーにも残せなくなる）
        this.db?.close();
        this.db = null;
        this.notice("warn", "別のタブで新しい版のアプリが開かれました。このタブを再読み込みしてください。");
      };
      this.mode = "idb";
    } catch (e) {
      if (e instanceof DOMException && e.name === "VersionError") {
        // 保存先がこのページより新しい版の形に作り直されている（新しい版のページが開いた）: 小さな保存先に切り替えて
        // 別の内容で始めたりせず、何も書かずに止める
        this.blockNewer();
        return;
      }
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

  /**
   * このページより新しい版で保存されたデータに気づいた（読めた物を壊れた物と取り違えない）。以後は何も書かない:
   * 本体・版の記録・緊急コピー・バックアップ・小さな鍵と値のどれも。未保存の印は捨て（閉じるときに緊急コピーを書かない）、
   * 書き手のロックは手放し、保存先への接続も閉じる（新しい版のページのタブが、そのまま編集を始められるように）。
   * 開いている間に気づいたときは、先に keepUnsaved でこのタブのまだどこにも無い変更を残し、残した所を kept で渡す（画面で伝える）
   */
  blockNewer(kept: KeptAside = null, why: BlockInfo = { kind: "newer" }): void {
    if (this.blocked) return;
    this.blocked = true;
    this.blockedWhy = why;
    this.stopped = true;
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
    this.releaseLock?.();
    this.releaseLock = null;
    this.bc?.close();
    this.bc = null;
    this.db?.close();
    this.db = null;
    this.setWriter(false);
    this.setStatus(
      "readonly",
      why.kind === "newer" ? "このページより新しい版で保存されたデータがあるため、止めています。ページを開き直してください。" : "保存されているデータをこのページでは開けないため、止めています（データには触れていません）。",
    );
    // 新しい版で止めたときの知らせの形は前と同じ（why は、このページでは開けない保存してあるデータで止めたときだけ）
    this.emitter.emit("blocked", why.kind === "newer" ? { kept: kept ?? this.keptAside } : { kept: kept ?? this.keptAside, why });
  }

  /**
   * このページでは開けない保存してあるデータ（止める側の失敗: safety-3）に気づいて止める。新しい版なら新しい版として止める。
   * record: そのまま書き出せるように覚えておく記録
   */
  private blockOn(e: unknown, record: RawRecord | null, kept: KeptAside = null): void {
    if (this.blocked) return;
    if (record) this.blockedRecord = record;
    this.blockNewer(kept, blockInfoOf(e));
  }

  /**
   * 開いている間に気づいて止める直前に、このタブのまだどこにも無い変更を残す。「退避」のバックアップ（backedUp: 退避した中身と、
   * そのときの更新時刻）に今の内容がそのまま入っていれば、それでよい（backup）。入っていなければ（localStorage の保存先・
   * 容量不足・退避した後の入力・保存先が閉じた）、このタブの緊急コピーに同期で書く（copy。このタブだけの鍵・この版の包みなので、
   * 新しい版の本体・版の記録・ほかのタブの写しには触れない。止めるまでの入力も漏らさない）。止める前に呼ぶ
   */
  private keepUnsaved(backedUp: { doc: DocData; updatedAt: string } | null): KeptAside {
    const doc = this.getDoc?.();
    if (!doc || this.mode === "memory") return null;
    if (backedUp && backedUp.doc === doc && backedUp.updatedAt === doc.updatedAt) return "backup";
    try {
      this.putEmergency(doc);
      return "copy";
    } catch {
      return backedUp ? "backup" : null;
    }
  }

  /**
   * 本体を読めなかった（別のタブの保存を読み直したとき など）訳が止める側なら、止めて true（新しい版・このページでは開けない地図: safety-3）。
   * 壊れた版 1 の本体なら何もせずに false（今までどおり）
   */
  async blocksOnRead(e: unknown): Promise<boolean> {
    if (this.blocked) return true;
    const r = await this.failureOf(e);
    if (r.fail === "corrupt") return false;
    this.blockOn(e, r.record);
    return true;
  }

  /** 開いている間に気づいて止める（このタブのまだどこにも無い変更を残してから。もう止めていれば何もしない） */
  private blockNewerKeeping(backedUp: { doc: DocData; updatedAt: string } | null, why: { error: unknown; record: RawRecord | null } | null = null): void {
    if (this.blocked) return;
    const kept = this.keepUnsaved(backedUp);
    if (why) this.blockOn(why.error, why.record, kept);
    else this.blockNewer(kept);
  }

  /**
   * 保存してある本体を、このページで上書きしてはいけないか（このページより新しい版・このページでは開けない地図: 止める側）。
   * 版 1 の本体は印だけ見る（整えない: 保存の競合のたびに大きな本体を整え直さない。壊れていても今までどおり上書きできる）。
   * 薄い形の本体は読んで確かめる（地図が合わない物を、上書きできる物と取り違えない）。止める側なら、その訳と記録
   */
  private async storedBlocks(): Promise<{ error: unknown; record: RawRecord | null } | null> {
    let rec: StoredRecord;
    try {
      rec = await this.readRecord();
    } catch (e) {
      return e instanceof NewerDocError ? { error: e, record: null } : null;
    }
    const record = this.recordOf(rec);
    if (rec.parseError !== null) return classifyReadFailure(undefined, rec.parseError, rec.meta?.docVersion) === "blocked" ? { error: new ThinMapError("corrupt", "保存されている本体を JSON として読めません（新しい形の記録）。保存されているデータには触れていません。"), record } : null;
    if (rec.raw == null) return null;
    if (isNewerRecord(rec.raw)) return { error: new NewerDocError(recordInfo(rec.raw).format), record };
    if (!isThinShape(rec.raw) || !thinReadable()) return null;
    try {
      await decodeStoredAsync(rec.raw);
      return null;
    } catch (e) {
      return classifyReadFailure(rec.raw, e, rec.meta?.docVersion) === "corrupt" ? null : { error: e, record };
    }
  }

  /** 読んだ本体を、そのまま書き出せる記録にする（無ければ null） */
  private recordOf(rec: StoredRecord): RawRecord | null {
    if (rec.text !== null) return { text: rec.text, source: "body" };
    if (rec.raw == null) return null;
    try {
      return { text: JSON.stringify(rec.raw, null, 2), source: "body" };
    } catch {
      return null;
    }
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

  /**
   * 保存してある本体と版の記録を、整えずにそのまま読む（本体が無ければ raw は null）。
   * 版の記録が新しい版を指していれば、本体を読む前に NewerDocError（新しい版の本体は、localStorage でも JSON とは限らない）。
   * localStorage の本体が JSON でなければ parseError に（版の記録の版で、壊れた本体か止める側かを分ける）
   */
  private async readRecord(check = true): Promise<StoredRecord> {
    if (this.mode === "idb" && this.db) {
      const t = this.db.transaction("kv", "readonly");
      const s = t.objectStore("kv");
      const [d, m] = await Promise.all([req(s.get("doc")), req(s.get("meta"))]);
      const meta = (m as StoredMeta | undefined) ?? null;
      if (check) checkMetaVersion(meta);
      return { raw: d ?? null, meta, text: null, parseError: null };
    }
    if (this.mode === "local") {
      const m = this.kv.get(this.keys.meta);
      let meta: StoredMeta | null = null;
      try {
        meta = m ? (JSON.parse(m) as StoredMeta) : null;
      } catch (e) {
        if (check) throw e;
      }
      if (check) checkMetaVersion(meta);
      const text = this.kv.get(this.keys.doc);
      if (!text) return { raw: null, meta, text: null, parseError: null };
      try {
        return { raw: JSON.parse(text) as unknown, meta, text, parseError: null };
      } catch (e) {
        return { raw: undefined, meta, text, parseError: e };
      }
    }
    return { raw: null, meta: null, text: null, parseError: null };
  }

  /**
   * 保存してある本体（読んで整えてから返す）。無ければ null、読めなければ例外。
   * このページより新しい版（本体の版か版の記録の docVersion が新しい）なら NewerDocError（壊れているのとは分けて扱う）。
   * 薄い形はページの地図から組み立て直す（地図はここで初めて読む）。読めなければ ThinMapError（止める側）
   */
  async readStored(opts: { upgrade?: ThinUpgradeMode } = {}): Promise<StoredDoc | null> {
    const rec = await this.readRecord();
    if (rec.parseError !== null) throw rec.parseError;
    if (rec.raw == null) {
      // 薄い形を書いたページの記録なのに本体が無い（消えた）: 無いと見なして別の内容で始めない（止める側）
      if (thinReadable() && classifyReadFailure(undefined, null, rec.meta?.docVersion) === "blocked") throw new ThinMapError("corrupt", "版の記録はあるのに、保存されている本体が見つかりません。保存されているデータには触れていません。");
      return null;
    }
    const d = await decodeStoredAsync(rec.raw, opts);
    return { doc: d.doc, meta: rec.meta ?? { rev: 0, savedAt: d.doc.updatedAt, writer: "" }, ...(d.upgrade ? { upgrade: d.upgrade } : {}) };
  }

  /**
   * 保存してある本体を読み、読めない訳を記録の形で分ける（safety-3）。ok: 読めた（無ければ null）/
   * fail: newer このページより新しい版・blocked 止める側（版 2 以上か地図の変更がある記録）・corrupt 版 1 の壊れた本体
   */
  private async loadStored(opts: { upgrade?: ThinUpgradeMode } = {}): Promise<{ ok: StoredDoc | null } | StoredFailure> {
    try {
      return { ok: await this.readStored(opts) };
    } catch (e) {
      return this.failureOf(e);
    }
  }

  /** 本体を読めなかった訳を、記録の形で分ける（記録をもう一度、版を確かめずに読む。そのまま書き出せるように記録も持つ） */
  private async failureOf(e: unknown): Promise<StoredFailure> {
    let rec: StoredRecord | null = null;
    try {
      rec = await this.readRecord(false);
    } catch {
      rec = null;
    }
    const record = rec ? this.recordOf(rec) : null;
    const raw = rec && rec.parseError === null ? rec.raw : undefined;
    return { fail: classifyReadFailure(raw, e, rec?.meta?.docVersion), error: e, record, meta: rec?.meta ?? null };
  }

  /**
   * 保存してある本体を読む。このページより新しい版・このページでは開けない（止める側）なら止めて undefined
   * （壊れているなど、ほかの読めない訳はそのまま投げる）
   */
  private async readStoredOrBlock(): Promise<StoredDoc | null | undefined> {
    try {
      return await this.readStored();
    } catch (e) {
      const r = await this.failureOf(e);
      if (r.fail === "corrupt") throw e;
      this.blockOn(e, r.record);
      return undefined;
    }
  }

  /** 緊急コピーの中身を読むのに、ページの地図が要れば先に読み込む（読めなければ、その写しは止める側として残る） */
  private async prepareEmergencies(): Promise<void> {
    if (!thinReadable() || hasThinBaseline()) return;
    for (const key of this.kv.keys()) {
      if (!key.startsWith(this.keys.emergencyPrefix)) continue;
      try {
        const raw = JSON.parse(this.kv.get(key) ?? "null") as { doc?: unknown } | null;
        if (raw && needsPageMap(raw.doc)) {
          await ensurePageMap();
          return;
        }
      } catch {
        /* 壊れた写しは読まない */
      }
    }
  }

  /**
   * 緊急コピーを読む。壊れた写しは doc: null、このページより新しい版の写し（包みか中身の版が新しい）は newer: true、
   * このページでは開けない薄い形の写しは blocked: true（どれも読めないが、新しい版・止める側の写しは壊れていないので消さない）。
   * 薄い形の写しを読むには、先に prepareEmergencies でページの地図を読み込む
   */
  private readEmergencies(upgrade?: ThinUpgradeMode): EmergencyCopy[] {
    const out: EmergencyCopy[] = [];
    for (const key of this.kv.keys()) {
      if (!key.startsWith(this.keys.emergencyPrefix)) continue;
      const text = this.kv.get(key);
      if (!text) continue;
      try {
        const raw = JSON.parse(text) as { v?: unknown; baseRev?: unknown; tabId?: unknown; doc?: unknown };
        const rawDoc = raw.doc as { updatedAt?: unknown; version?: unknown } | null | undefined;
        const head = {
          key,
          baseRev: typeof raw.baseRev === "number" ? raw.baseRev : -1,
          tabId: typeof raw.tabId === "string" ? raw.tabId : "",
          rawUpdatedAt: rawDoc && typeof rawDoc === "object" && typeof rawDoc.updatedAt === "string" ? rawDoc.updatedAt : "",
          docVersion: rawDoc && typeof rawDoc === "object" && typeof rawDoc.version === "number" && Number.isFinite(rawDoc.version) ? Math.floor(rawDoc.version) : 1,
          rawDoc: raw.doc,
        };
        if (typeof raw.v === "number" && raw.v > EMERGENCY_FORMAT) {
          out.push({ ...head, doc: null, newer: true, blocked: false });
          continue;
        }
        try {
          out.push({ ...head, doc: decodeStored(raw.doc, upgrade ? { upgrade } : {}).doc, newer: false, blocked: false });
        } catch (e) {
          const cls = classifyReadFailure(raw.doc, e);
          if (cls === "corrupt") throw e;
          out.push({ ...head, doc: null, newer: cls === "newer", blocked: cls === "blocked", error: e });
        }
      } catch {
        out.push({ key, baseRev: -1, tabId: "", doc: null, newer: false, blocked: false, docVersion: 1, rawUpdatedAt: "", rawDoc: null });
      }
    }
    // 新しい順
    return out.sort((a, b) => (b.doc?.updatedAt ?? "").localeCompare(a.doc?.updatedAt ?? ""));
  }

  /**
   * このページより新しい版のページの緊急コピー・このページでは開けない緊急コピーのうち、本体より後の変更（本体が無い・時刻が分からない・
   * 本体より後・同じ版からの別の時刻）の物（無ければ null）。あればそれがこのブラウザの最新なので、この版では始めない（引き継がない）
   */
  private copyAhead(stored: { doc: DocData; meta: StoredMeta } | null, copies = this.readEmergencies()): EmergencyCopy | null {
    return (
      copies.find((em) => {
        if (!em.newer && !em.blocked) return false;
        const at = em.rawUpdatedAt;
        return !stored || !at || at > stored.doc.updatedAt || (em.baseRev === stored.meta.rev && at !== stored.doc.updatedAt);
      }) ?? null
    );
  }

  /** 本体より後の、このページでは読めない緊急コピーに気づいて止める（新しい版の写しなら新しい版として。写しはそのまま書き出せるように覚える） */
  private blockOnCopy(em: EmergencyCopy): void {
    let text = "";
    try {
      text = JSON.stringify(em.rawDoc, null, 2);
    } catch {
      text = this.kv.get(em.key) ?? "";
    }
    if (em.newer && !(em.error instanceof ThinMapError)) {
      this.blockedRecord = { text, source: "emergency" };
      this.blockNewer();
      return;
    }
    this.blockOn(em.error ?? new ThinMapError("corrupt", "緊急コピーをこのページでは開けません。"), { text, source: "emergency" });
  }

  /**
   * 緊急コピー（閉じたタブが保存しきれなかった変更）を片付ける。編集できるタブだけが行う。
   * 本体より新しく、本体がその続き（同じ版から・同じタブが書いた）なら採る。別の保存と重なっていたらバックアップへ退避。
   * 本体と同じか古ければ、もう保存されているので黙って消す。ただし写しの中身の版が本体の版（版の記録の docVersion。無ければ 1）と違えば、
   * 古く見えても黙って消さず、「退避」のバックアップに残してから消す（別の版のページの間で分かれた内容。残せなければ消さない）。
   * このページより新しい版の写し・このページでは開けない写しは読めないので採らず、消さずに残す（そのページが開いたときに、そのページが決める）。
   * その写しが本体より後の変更なら、何も片付けずに止める（この版で続けると、その上に古い内容を保存して追い越してしまう）
   */
  private async consumeEmergencies(stored: { doc: DocData; meta: StoredMeta } | null, notices: string[], how?: { sameBase: boolean }, upgrade?: ThinUpgradeMode): Promise<DocData | null> {
    if (!this.writer || this.blocked) return null;
    await this.prepareEmergencies();
    const copies = this.readEmergencies(upgrade);
    const ahead = this.copyAhead(stored, copies);
    if (ahead) {
      this.blockOnCopy(ahead);
      return null;
    }
    const storedVersion = typeof stored?.meta.docVersion === "number" ? Math.floor(stored.meta.docVersion) : 1;
    let adopted: DocData | null = null;
    for (const em of copies) {
      if (em.newer || em.blocked) continue;
      if (em.doc) {
        // 本体がこの写しの元の版のまま（その後に保存が無い）なら、時刻が違えば写しの方が先の内容
        const sameBase = !!stored && em.baseRev === stored.meta.rev;
        const newer = !stored || em.doc.updatedAt > stored.doc.updatedAt || (sameBase && em.doc.updatedAt !== stored.doc.updatedAt);
        if (newer) {
          const continues = !stored || sameBase || (em.tabId !== "" && stored.meta.writer === em.tabId);
          if (continues && !adopted) {
            adopted = em.doc;
            if (how) how.sameBase = sameBase;
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
        } else if (stored && em.docVersion !== storedVersion) {
          // 別の版のページの写し（本体の版と違う）: 古く見えても「もう保存された」とは限らない。退避してから消す（残せなければ消さない）
          const saved = await this.createBackup("conflict", "前回の未保存の変更（別の版のページの写し）", em.doc).catch(() => null);
          if (!saved) {
            notices.push("別の版のページの未保存の変更を、バックアップを作れなかったため、消さずに残しています（JSON で書き出しておくと安心です）。");
            continue;
          }
          notices.push("別の版のページの未保存の変更を、バックアップに退避しました（メニュー →「バックアップと復元」）。");
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
   * recovered: 保存してあった本体を読めず、バックアップ（か何も無し）で始めた。ただし、読めなかった本体の版の続きの
   * 緊急コピー（このブラウザの最新）を採ったときは、代わりの内容で始めたのではない。
   * blocked: 保存してある本体（か保存先の形）がこのページより新しい版、このページでは開けない（薄い形の記録の読めない訳はどれも: safety-3）、
   * または新しい版のページの・開けない緊急コピーが本体より後の変更。壊れたのではないので、バックアップでも緊急コピーでもデモでも始めず、
   * 何も書かずに止める（doc は null。以後このインスタンスは何も書かない。why に訳）。
   * reopen: 「この版で開き直す」。薄い形の本体を、安全用バックアップにそのまま残してから、鍵でページの地図に当て直して開く（残せなければ止める）
   */
  async loadInitial(opts: { reopen?: boolean } = {}): Promise<{ doc: DocData | null; notices: string[]; recovered: boolean; blocked: boolean; why?: BlockInfo; upgrade?: ThinUpgradeInfo }> {
    const notices: string[] = [];
    if (this.mode === "memory") return { doc: null, notices, recovered: false, blocked: false };
    // 止めた結果（新しい版で止めたときの形は前と同じ。why は、このページでは開けない保存してあるデータで止めたときだけ）
    const blocked = () => {
      const why = this.blockedWhy;
      return { doc: null, notices: [] as string[], recovered: false, blocked: true as const, ...(why && why.kind !== "newer" ? { why } : {}) };
    };
    if (this.blocked) return blocked();
    const upgrade: ThinUpgradeMode | undefined = opts.reopen ? "any" : undefined;
    if (opts.reopen) {
      // 開けなかった記録（本体と、このページでは開けない緊急コピー）を、そのまま安全用バックアップに残す（残せなければ、当て直さずに止めたまま）
      if (!(await this.backupRawRecord("「この版で開き直す」の前に保存されていた内容")) || !(await this.backupRawCopies("「この版で開き直す」の前の緊急コピー"))) {
        const r = await this.loadStored();
        this.blockOn(new ThinMapError("mismatch", "保存されているデータをバックアップに残せなかったため、この版で開き直すのをやめました。先に「保存されているデータをそのまま書き出す」で書き出してください。"), "ok" in r ? null : r.record);
        return blocked();
      }
    }
    let stored: StoredDoc | null = null;
    let recovered = false;
    /** 読めなかった本体の版（meta）は読めた */
    let metaKnown = true;
    const r = await this.loadStored(upgrade ? { upgrade } : {});
    if ("ok" in r) stored = r.ok;
    else if (r.fail !== "corrupt") {
      // 新しい版・止める側（薄い形の記録の読めない訳はどれも）: 壊れたと見なして古いバックアップで始めない（前は最初の保存で上書きしていた）
      this.blockOn(r.error, r.record);
      return blocked();
    } else {
      recovered = true;
      const meta = r.meta ?? (await this.readMeta().catch(() => null));
      const skipped = { older: 0 };
      const fallback = await this.latestBackupDoc({ format: meta?.docVersion, mapRelease: meta?.mapRelease }, skipped);
      if (fallback) {
        notices.push("保存してあったデータを読めなかったため、いちばん新しいバックアップから復元しました。");
        metaKnown = !!meta;
        stored = { doc: fallback, meta: meta ?? { rev: 0, savedAt: fallback.updatedAt, writer: "" } };
        this.dirty = true;
      } else {
        notices.push("保存してあったデータを読めませんでした。");
      }
      // 保存してあった物より前の版のバックアップは、自分では戻さない（選んでもらう）
      if (skipped.older) notices.push(`前の版のバックアップ（${skipped.older} 件）は自動では戻しませんでした。メニュー →「バックアップと復元」から選べます。`);
    }
    if (stored?.upgrade) {
      // 前の版の地図・違う組み立ての地図を、ページの地図に当て直して開いた: 当て直す前の記録を安全用バックアップに残す（そのページで戻せる）
      if (!opts.reopen) await this.backupRawRecord("地図を新しい版で開く前に保存されていた内容");
      // 知らせは当て直した結果の数のまま（版 6 までの地図は、移した手・引き継いだカード・別のカードに残したカードを数で: user-6）。
      // 次に保存するとき、ページの地図を持つ文書として薄い形で書く
      notices.push(upgradeNotice(stored.upgrade, "boot"));
      this.dirty = true;
    }
    if (stored) {
      this.rev = stored.meta.rev;
      this.savedAt = stored.meta.savedAt;
      // 保存できている内容（バックアップから戻した物・緊急コピー・当て直した物は、まだ本体に保存できていない）
      if (!recovered && !stored.upgrade) this.lastStored = { id: stored.doc.id, updatedAt: stored.doc.updatedAt };
    }
    const how = { sameBase: false };
    const adopted = await this.consumeEmergencies(stored, notices, how, upgrade);
    if (this.blocked) return blocked();
    const doc = adopted ?? stored?.doc ?? null;
    // 採った緊急コピーが、読めなかった本体の版の続き（このブラウザの最新）なら、代わりの内容で始めたのではない
    return { doc, notices, recovered: recovered && !(adopted && how.sameBase && metaKnown), blocked: false, ...(stored?.upgrade ? { upgrade: stored.upgrade } : {}) };
  }

  /**
   * 起動で使う、いちばん新しいバックアップ。「退避」（別の端末・別のタブの内容）と「選ばなかった内容」は、
   * このブラウザで続けてきた内容ではないので使わない（それを手元として送ると、新しい内容を古い内容で潰しかねない）。
   * このページより新しい版のバックアップ・このページでは開けないバックアップも使わない（読めない。飛ばして、その前の物を探す）。
   * 保存してあった本体より前の形・前の版の地図のバックアップ（版の記録で分かる物）は、自分では戻さない（数を skipped に。利用者に選んでもらう: safety-3）
   */
  private async latestBackupDoc(storedInfo: { format?: unknown; mapRelease?: unknown } = {}, skipped: { older: number } = { older: 0 }): Promise<DocData | null> {
    const fmt = typeof storedInfo.format === "number" && Number.isFinite(storedInfo.format) ? Math.floor(storedInfo.format) : 1;
    const rel = typeof storedInfo.mapRelease === "number" ? storedInfo.mapRelease : null;
    try {
      const list = await this.listBackups();
      for (const b of list) {
        if (b.kind === "conflict" || b.kind === "kept" || headerBlock(b) !== null) continue;
        const bf = typeof b.docVersion === "number" ? Math.floor(b.docVersion) : 1;
        if (bf < fmt || (rel !== null && (typeof b.mapRelease !== "number" || b.mapRelease < rel))) {
          skipped.older++;
          continue;
        }
        const { doc } = await this.readBackupChecked(b.id);
        if (doc) return doc;
      }
    } catch {
      /* バックアップも読めない */
    }
    return null;
  }

  /** このページでは開けない緊急コピーの中身を、整えずにそのまま安全用バックアップに残す（「この版で開き直す」の前）。全部残せたら true */
  private async backupRawCopies(label: string): Promise<boolean> {
    if (!this.canBackup || this.blocked) return false;
    await this.prepareEmergencies();
    for (const em of this.readEmergencies()) {
      if (!em.blocked) continue;
      try {
        await this.putBackup("safety", label, em.rawDoc, rawCounts(em.rawDoc), rawTitle(em.rawDoc));
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * 保存してある本体の記録を、整えずにそのまま安全用バックアップに残す（「この版で開き直す」・地図を新しい版で開く前）。
   * 見出しには記録の形の版と地図の版の順番を書く（間引き・復元の見分けに）。残せたら true（本体が無ければ true）
   */
  private async backupRawRecord(label: string): Promise<boolean> {
    if (!this.canBackup || this.blocked) return false;
    let rec: StoredRecord;
    try {
      rec = await this.readRecord();
    } catch {
      return false;
    }
    if (rec.raw == null && rec.text === null) return true;
    const raw = rec.raw !== undefined ? rec.raw : rec.text;
    try {
      await this.putBackup("safety", label, raw, rawCounts(raw), rawTitle(raw));
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ 保存

  /** ストアにつなぐ。以後 markDirty() のたびに自動保存する */
  attach(getDoc: () => DocData): void {
    this.getDoc = getDoc;
    if (this.mode === "memory" || this.blocked) return;
    if (this.dirty && this.writer) this.schedule();
    else if (this.writer) this.setStatus(this.savedAt ? "saved" : "idle");
    else this.setStatus("readonly");
  }

  markDirty(): void {
    if (this.mode === "memory" || this.blocked) return;
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
    if (this.dirty && !this.blocked) await this.save();
  }

  private async save(): Promise<void> {
    if (!this.getDoc || !this.writer || this.stopped || this.blocked || this.mode === "memory") return;
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
        // 書いている間に、新しい版のデータに気づいて止めた: 以後のことはしない（状態も止めたまま）
        if (this.blocked) return;
        this.rev = newRev;
        this.lastStored = ident;
        this.savedAt = nowISO();
        if (!this.dirty) this.kv.remove(this.keys.emergency);
        this.bc?.postMessage({ type: "saved", rev: newRev, tabId: this.tabId });
        this.setStatus(this.dirty ? "pending" : "saved");
        await this.maybeAutoBackup(doc).catch(() => undefined);
      } catch (e) {
        if (this.blocked) return;
        this.dirty = true;
        // 失敗の後は、入力のたびにすぐ保存し直さない（やり直しは 5 秒後の再試行に任せる）
        this.firstDirtyAt = Date.now();
        if (e instanceof ConflictError) {
          this.stopped = true;
          // 退避に入る中身はこの時点の物（書き始めに写す）。その後の入力は、止めるときに確かめる
          const at = doc.updatedAt;
          const saved = await this.createBackup("conflict", "保存の競合で退避した内容", doc).catch(() => null);
          if (this.blocked) return;
          // 書いたのが新しい版のページ（別のタブ）・このページでは開けない地図の記録: 「上書き」「最新を開く」を選ばせず、手元を残して止める
          // （退避に今の内容が無ければ・退避を作れなければ、このタブの緊急コピーに）
          const why = await this.storedBlocks();
          if (why) return this.blockNewerKeeping(saved ? { doc, updatedAt: at } : null, why);
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

  /**
   * 版番号を確かめてから書く（1 つのトランザクションの中で読む→比べる→書く）。
   * 版の記録がこのページより新しい版を指していれば、版番号が合っていても書かない（競合として止める）
   */
  private async writeStored(doc: DocData, expectedRev: number): Promise<number> {
    if (this.blocked) throw new ConflictError("newer");
    // ページの地図を持つ文書は薄い形で書く（地図をまだ読んでいなければ、先に読む: 地図ごと書かない）
    if (thinReadable() && !hasThinBaseline() && needsPageMap(doc)) await ensurePageMap();
    const stored = toStored(doc);
    const meta: StoredMeta = { rev: expectedRev + 1, savedAt: nowISO(), writer: this.tabId, ...headerOf(stored) };
    if (this.mode === "idb") {
      if (!this.db) throw new Error("IndexedDB が閉じています");
      const t = this.db.transaction("kv", "readwrite");
      const s = t.objectStore("kv");
      let conflict = false;
      const r = s.get("meta");
      r.onsuccess = () => {
        const m = r.result as StoredMeta | undefined;
        if ((m?.rev ?? 0) !== expectedRev || metaForbidsWrite(m)) {
          conflict = true;
          t.abort();
          return;
        }
        s.put(stored, "doc");
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
    // localStorage（400 万文字を超える物は書かない: 前の本体のまま、保存の失敗として知らせる）
    const curRaw = this.kv.get(this.keys.meta);
    const cur = curRaw ? (JSON.parse(curRaw) as StoredMeta) : null;
    if ((cur?.rev ?? 0) !== expectedRev || metaForbidsWrite(cur)) throw new ConflictError("rev");
    const json = JSON.stringify(stored);
    guardStoredSize(json.length, "local");
    this.kv.set(this.keys.doc, json);
    this.kv.set(this.keys.meta, JSON.stringify(meta));
    return meta.rev;
  }

  /** 閉じる・隠れる瞬間に、未保存の内容を同期で残す（次の起動で採るか比べる） */
  writeEmergency(force = false): void {
    if (this.mode === "memory" || this.blocked || !this.getDoc) return;
    if (!force && !this.hasUnsaved) return;
    try {
      this.putEmergency(this.getDoc());
    } catch {
      /* 容量不足など。IndexedDB の保存に任せる */
    }
  }

  /**
   * このタブの緊急コピーを書く（このタブだけの鍵・この版の包み。中身は保存の口を通した形: ページの地図なら薄い形）。書けなければ例外。
   * 400 万文字を超える物は書かない（前の緊急コピーを残す: safety-15）
   */
  private putEmergency(doc: DocData): void {
    const json = JSON.stringify({ v: EMERGENCY_FORMAT, baseRev: this.rev, at: nowISO(), tabId: this.tabId, doc: toStored(doc) });
    guardStoredSize(json.length, "local");
    this.kv.set(this.keys.emergency, json);
  }

  /**
   * 競合の解決: reload = 保存されている最新を採る / overwrite = 手元の内容で上書きする（どちらも手元はバックアップ済み）。
   * 保存されているのがこのページより新しい版なら、どちらも選ばずに止める（blocked。上書きはしない）
   */
  async resolveConflict(choice: "reload" | "overwrite"): Promise<DocData | null> {
    if (this.blocked) return null;
    if (choice === "reload") {
      const s = await this.readStoredOrBlock();
      if (s === undefined) return null;
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
    const why = await this.storedBlocks();
    if (why) {
      // 新しい版の内容・このページでは開けない内容は上書きしない。競合に気づいた後の変更はまだどこにも無いので、このタブの内容を残してから止める
      // （退避に今の内容が無ければ・退避を作れなければ、このタブの緊急コピーに）
      const doc = this.getDoc?.();
      const at = doc?.updatedAt ?? "";
      const saved = doc ? await this.createBackup("conflict", "新しい版で保存された内容に気づいたときのこのタブの内容", doc).catch(() => null) : null;
      this.blockNewerKeeping(saved && doc ? { doc, updatedAt: at } : null, why);
      return null;
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
    if (this.blocked) return;
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
    if (!d || !this.canBackup || this.blocked) return null;
    // 中身は保存の口を通した形（ページの地図なら薄い形）。件数は手元の文書で数える
    if (thinReadable() && !hasThinBaseline() && needsPageMap(d)) await ensurePageMap();
    return this.putBackup(kind, label, toStored(d), docCounts(d), d.title);
  }

  /** バックアップを書く（stored: 保存する形・止めたときの記録そのまま）。見出しには形の版と地図の版の順番 */
  private async putBackup(kind: BackupKind, label: string, stored: unknown, counts: BackupMeta["counts"], docTitle: string): Promise<BackupMeta> {
    const meta: BackupMeta = { id: newId("b"), kind, label, createdAt: nowISO(), docTitle, counts, ...headerOf(stored) };
    const t = this.db!.transaction(["backupMeta", "backupData"], "readwrite");
    try {
      // 中身を先に（写せない中身なら、見出しだけの行を残さない）
      t.objectStore("backupData").put({ id: meta.id, doc: stored });
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

  /** バックアップの中身（無い・壊れている・このページより新しい版・このページでは開けないなら null。どれかを分けるなら readBackupChecked） */
  async readBackup(id: ID): Promise<DocData | null> {
    return (await this.readBackupChecked(id)).doc;
  }

  /**
   * バックアップの中身を、読めない訳と一緒に読む。newer: このページより新しい版で作られた（見出しの版か中身の版で分かる。
   * 読まない・復元しない）。blocked: このページでは開けない地図（薄い形の中身の読めない訳はどれも: safety-3。復元しない・間引かない）。
   * doc が null で newer でも blocked でもなければ、無いか壊れている。前の版の地図は、ページの地図に当て直して読む（upgrade に数）
   */
  async readBackupChecked(id: ID): Promise<{ doc: DocData | null; newer: boolean; blocked?: boolean; upgrade?: ThinUpgradeInfo; message?: string }> {
    if (!this.canBackup) return { doc: null, newer: false };
    const t = this.db!.transaction(["backupMeta", "backupData"], "readonly");
    const [meta, rec] = await Promise.all([req(t.objectStore("backupMeta").get(id)), req(t.objectStore("backupData").get(id))]);
    const head = meta ? headerBlock(meta as BackupMeta) : null;
    if (head === "newer") return { doc: null, newer: true };
    const data = rec as { doc?: unknown } | undefined;
    if (!data?.doc) return { doc: null, newer: false };
    try {
      const d = await decodeStoredAsync(data.doc);
      return { doc: d.doc, newer: false, ...(d.upgrade ? { upgrade: d.upgrade } : {}) };
    } catch (e) {
      const cls = classifyReadFailure(data.doc, e, (meta as BackupMeta | undefined)?.docVersion);
      if (cls === "newer") return { doc: null, newer: true };
      return cls === "blocked" ? { doc: null, newer: false, blocked: true, message: errorText(e) } : { doc: null, newer: false };
    }
  }

  /** バックアップの中身を、整えずにそのまま書き出す形で（このページでは開けないバックアップも書き出せるように。無ければ null） */
  async readBackupRaw(id: ID): Promise<RawRecord | null> {
    if (!this.canBackup) return null;
    const t = this.db!.transaction("backupData", "readonly");
    const rec = (await req(t.objectStore("backupData").get(id))) as { doc?: unknown } | undefined;
    if (rec?.doc === undefined) return null;
    try {
      return { text: typeof rec.doc === "string" ? rec.doc : JSON.stringify(rec.doc, null, 2), source: "backup" };
    } catch {
      return null;
    }
  }

  async deleteBackup(id: ID): Promise<void> {
    if (!this.canBackup || this.blocked) return;
    const t = this.db!.transaction(["backupMeta", "backupData"], "readwrite");
    t.objectStore("backupMeta").delete(id);
    t.objectStore("backupData").delete(id);
    await done(t);
  }

  /**
   * 種類ごとに件数で間引く。このページより新しい版のバックアップ・このページでは開けない地図のバックアップ（見出しで分かる物）は
   * 数えず、消さない（読めるページが間引く: safety-3）
   */
  private async prune(kind: BackupKind): Promise<void> {
    const list = (await this.listBackups()).filter((b) => b.kind === kind && headerBlock(b) === null);
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
    if (!this.canBackup || this.blocked) return;
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
    if (this.blocked) return false;
    const ok = !this.locks || (await this.requestLock({ ifAvailable: true }));
    if (ok && !this.blocked) this.setWriter(true);
    return ok && !this.blocked;
  }

  /**
   * このタブで編集する（別のタブから引き継ぐ）。最新の保存内容を返す。
   * 保存されているのがこのページより新しい版、または新しい版のページの緊急コピーが本体より後の変更なら、引き継がずに止めて null
   * （blocked。新しい版のタブのロックも奪わない）。本体はロックを取る前に 1 回だけ読んで整え、取る間に前のタブが保存していたら
   * （版の記録の版番号か版が変わった）読み直す
   */
  async takeOver(): Promise<DocData | null> {
    if (this.blocked) return null;
    let stored = await this.readStoredOrBlock();
    if (stored === undefined) return null;
    await this.prepareEmergencies();
    const ahead = this.copyAhead(stored);
    if (ahead) {
      this.blockOnCopy(ahead);
      return null;
    }
    if (this.locks) {
      await this.requestLock({ steal: true });
      const meta = await this.readMeta().catch(() => null);
      if ((meta?.rev ?? 0) !== (stored?.meta.rev ?? 0) || meta?.docVersion !== stored?.meta.docVersion) {
        // 引き継ぐ間に前のタブ（か新しい版のページ）が保存した
        stored = await this.readStoredOrBlock();
        if (stored === undefined) return null;
      }
    }
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
    if (this.blocked) return null;
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
          // 止めた後に遅れて取れたロックは持たない（新しい版のページのタブが取れるように）
          if (this.blocked) {
            answer(false);
            return;
          }
          answer(true);
          // タブを閉じるまで持ち続ける（新しい版のデータで止めたときだけ手放す）
          return new Promise<void>((release) => {
            this.releaseLock = release;
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
    if (this.dirty && doc) {
      // 残せたら覚えておく（後で新しい版のデータに気づいて止めたときに、画面で伝える）
      void this.createBackup("conflict", "別のタブに編集を引き継いだときの未保存の変更", doc).then(
        (m) => {
          if (m) this.keptAside = "backup";
        },
        () => undefined,
      );
    }
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setWriter(false);
    this.setStatus("readonly");
  }

  // ------------------------------------------------------------ そのまま書き出す（止めたときも）

  /**
   * 「保存されているデータをそのまま書き出す」の中身: 止めたときの記録（このページでは開けない本体か、本体より後の緊急コピー）、
   * 止めていなければ保存してある本体を、整えずにそのまま（IndexedDB の物は JSON に）。保存先の接続を閉じていれば、読むときだけ開き直す。
   * 何も無ければ null
   */
  async rawRecord(): Promise<RawRecord | null> {
    if (this.blockedRecord) return this.blockedRecord;
    if (this.mode === "local") {
      const text = this.kv.get(this.keys.doc);
      return text ? { text, source: "body" } : null;
    }
    if (this.mode !== "idb") return null;
    let db = this.db;
    let temp = false;
    if (!db) {
      if (typeof indexedDB === "undefined") return null;
      // 止めたときに閉じた（新しい版のページのタブが開けるように）: 版を決めずに開き、読んだらすぐ閉じる（何も書かない）
      db = await new Promise<IDBDatabase | null>((resolve) => {
        try {
          const r = indexedDB.open(this.dbName);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(null);
          r.onupgradeneeded = () => {
            // 保存先がまだ無かった: 作らずにやめる
            r.transaction?.abort();
            resolve(null);
          };
        } catch {
          resolve(null);
        }
      });
      temp = true;
    }
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains("kv")) return null;
      const t = db.transaction("kv", "readonly");
      const raw = (await req(t.objectStore("kv").get("doc"))) as unknown;
      if (raw === undefined || raw === null) return null;
      return { text: typeof raw === "string" ? raw : JSON.stringify(raw, null, 2), source: "body" };
    } catch {
      return null;
    } finally {
      if (temp) db.close();
    }
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
