// アカウントへの同期（claude.ai の Artifact の db 機能）。設計: docs/DESIGN.md §5.1
//
// - 手元（IndexedDB）が主のまま、あなただけが読める場所（data/users/<id>/）に写しを置く。別の端末でも同じ内容が出る
// - db の 1 文書は 256 KiB までなので、JSON を gzip（使えなければ UTF-8 のまま）→ base64 にして分割（parts）し、
//   最後にマニフェストを書く（それが確定）。読み手はいつもマニフェストから読む
// - 古い世代の分割は確定のあとで片付ける（直前の世代と 2 分以内の世代は、読んでいる人のために残す）。
//   どこからも指されない分割（失敗した送信の残りなど）も、ときどき掃除する（25,000 文書の上限はみんなで共有）
// - 送信は貸し出し（lease）を取ってから。マニフェストを書く直前に貸し出しを延ばし、マニフェストが変わっていないことを
//   確かめる（書いている間に貸し出しが切れて、別の端末が先に書いていたら、確定せずに決め直す）
// - 別の端末の変更: 手元に未送信の変更が無ければ取り込む（読み終えてから確かめる）。両方変わっていたら、
//   相手の内容を手元のバックアップに退避してから送る（どちらも黙って消さない。退避できなければ止める）
// - この端末で初めて同期するとき（基準が無い）: どちらかが捨ててよい中身（何もしていないデモ・空）なら、もう一方を採る。
//   両方に中身があれば、どちらを使うか聞く（聞くまで送らない）
// - 連続した入力は 1 回の送信にまとめる（送る内容を固めたら窓を区切る）。失敗したら決めた時刻までは送らない

import type { DbApi } from "../host/claude";
import { errorCode } from "../host/claude";
import { newId, nowISO } from "../model/ids";
import { DocFormatError, docCounts, normalizeDoc } from "../model/schema";
import type { DocData } from "../model/types";
import { Emitter } from "../store/emitter";

// ------------------------------------------------------------ 保存先（db の薄い包み。テストでは差し替える）

export interface CloudDoc {
  exists: boolean;
  data?: Record<string, unknown>;
}

export interface CloudBackend {
  get(path: string): Promise<CloudDoc>;
  set(path: string, data: Record<string, unknown>): Promise<void>;
  delete(path: string): Promise<void>;
  watch(path: string, next: (d: CloudDoc) => void, error: (code: string) => void): () => void;
  /** 協調のための短い貸し出し（同じ holder なら延長）。仕組みが無ければ、取れたことにする */
  lease(path: string, holder: string, ttlMs: number): Promise<boolean>;
  /** コレクションの文書の一覧（掃除に使う）。無ければ掃除しない */
  list?(collectionPath: string): Promise<Array<{ id: string; data: Record<string, unknown> | undefined }>>;
}

export function dbBackend(db: DbApi): CloudBackend {
  return {
    async get(path) {
      const s = await db.doc(path).get();
      return { exists: s.exists, data: s.exists ? s.data() : undefined };
    },
    set: (path, data) => db.doc(path).set(data),
    delete: (path) => db.doc(path).delete(),
    watch(path, next, error) {
      return db.doc(path).onSnapshot(
        (s) => next({ exists: s.exists, data: s.exists ? s.data() : undefined }),
        (e) => error(errorCode(e)),
      );
    },
    async lease(path, holder, ttlMs) {
      const ref = db.doc(path);
      if (typeof ref.acquire !== "function") return true;
      try {
        return (await ref.acquire({ holder, ttlMs })).acquired;
      } catch (e) {
        const code = errorCode(e);
        // 貸し出しの仕組みそのものが無い runtime だけ、協調なしで進める（確定の前の確かめは残る）
        if (code === "capability_removed" || code === "capability_disabled") return true;
        // つながらない・混み合いなどは「取れなかった」。協調なしで書き始めない（失敗として待つ）
        throw e;
      }
    },
    async list(path) {
      const snap = await db.collection(path).limit(1000).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.exists ? d.data() : undefined }));
    },
  };
}

// ------------------------------------------------------------ 符号化（gzip + base64、無ければ UTF-8 + base64）

/** base64 は 1 文字 = 1 バイトなので、分割はいつも 256 KiB に収まる */
const PART_CHARS = 180_000;
/** 直前より前の世代を残す時間（その間に読み始めた人が読み切れるように） */
const STALE_MS = 120_000;
/** マニフェストに覚えておく古い世代の数（溢れた分はすぐ消す） */
const MAX_STALE = 20;
/** 掃除で消さない新しさ（別の端末が書いている途中の分割かもしれない） */
const SWEEP_MIN_AGE_MS = 10 * 60_000;

export interface Manifest {
  format: 1;
  enc: "gzip-b64" | "utf8-b64" | "json";
  gen: string;
  parts: number;
  hash: string;
  bytes: number;
  docId: string;
  docUpdatedAt: string;
  title: string;
  nodes: number;
  edges: number;
  savedAt: string;
  writer: string;
  /** まだ片付けていない古い世代 */
  stale: Array<{ gen: string; parts: number; savedAt: string }>;
  /** 確定の通し番号（前の世代 + 1）。前の版で書かれた写しには無い */
  seq?: number;
  /** この世代に至る直前までの世代（新しい物が後ろ・最大 64）。上書きされたかを見分ける */
  lineage: string[];
}

/** 知っている符号化 */
const ENCODINGS = new Set(["gzip-b64", "utf8-b64", "json"]);
/** マニフェストに入れる題名の長さ（表示用。中身の題名は分割の方にある） */
const MANIFEST_TITLE_MAX = 200;
/** 系譜に覚えておく世代の数 */
const LINEAGE_MAX = 64;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON にしてから圧縮（呼んだ瞬間の内容を写す: 最初の await より前に文字列にする） */
export async function encodeDoc(doc: DocData): Promise<{ enc: Manifest["enc"]; payload: string; bytes: number }> {
  const json = JSON.stringify(doc);
  if (typeof CompressionStream === "undefined") {
    // 圧縮できないブラウザ: UTF-8 のバイト列を base64 に（日本語が多くても分割が 256 KiB を超えない）
    return { enc: "utf8-b64", payload: toB64(new TextEncoder().encode(json)), bytes: json.length };
  }
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  return { enc: "gzip-b64", payload: toB64(gz), bytes: json.length };
}

export async function decodeDoc(enc: Manifest["enc"], payload: string): Promise<DocData> {
  let json: string;
  if (enc === "gzip-b64") {
    if (typeof DecompressionStream === "undefined") throw new CloudError("unsupported", "このブラウザでは、アカウントの写し（圧縮）を読めません。新しいブラウザで開いてください");
    const stream = new Blob([fromB64(payload)]).stream().pipeThrough(new DecompressionStream("gzip"));
    json = await new Response(stream).text();
  } else if (enc === "utf8-b64") json = new TextDecoder().decode(fromB64(payload));
  else json = payload;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new CloudError("corrupt", "アカウントの写しが壊れています（JSON として読めない）");
  }
  try {
    return normalizeDoc(raw).doc;
  } catch (e) {
    // 新しい版のアプリで保存された（このページが古い）など: 上書きせずに止める
    if (e instanceof DocFormatError) throw new CloudError("format", e.message);
    throw e;
  }
}

/**
 * マニフェストを読む。新しい版の形・知らない符号化なら投げる（空と見なして上書きしない）。
 * この版の形で中身が壊れているときは null（読めない写しは手元で書き直す）
 */
function parseManifest(d: Record<string, unknown> | undefined): Manifest | null {
  if (d && typeof d.format === "number" && d.format !== 1) throw new CloudError("format", d.format > 1 ? "アカウントの写しは新しい版のアプリで保存されています" : "アカウントの写しの形が違います");
  if (d && d.enc !== undefined && !ENCODINGS.has(String(d.enc))) throw new CloudError("format", "アカウントの写しは新しい版のアプリで保存されています（知らない符号化）");
  if (!d || d.format !== 1 || typeof d.gen !== "string" || typeof d.parts !== "number" || typeof d.hash !== "string") return null;
  const stale = Array.isArray(d.stale)
    ? d.stale.filter((s): s is Manifest["stale"][number] => !!s && typeof s === "object" && typeof (s as { gen?: unknown }).gen === "string" && typeof (s as { parts?: unknown }).parts === "number")
    : [];
  return {
    format: 1,
    enc: d.enc === "json" ? "json" : d.enc === "utf8-b64" ? "utf8-b64" : "gzip-b64",
    gen: d.gen,
    parts: d.parts,
    hash: d.hash,
    bytes: typeof d.bytes === "number" ? d.bytes : 0,
    docId: typeof d.docId === "string" ? d.docId : "",
    docUpdatedAt: typeof d.docUpdatedAt === "string" ? d.docUpdatedAt : "",
    title: typeof d.title === "string" ? d.title : "",
    nodes: typeof d.nodes === "number" ? d.nodes : 0,
    edges: typeof d.edges === "number" ? d.edges : 0,
    savedAt: typeof d.savedAt === "string" ? d.savedAt : "",
    writer: typeof d.writer === "string" ? d.writer : "",
    stale,
    seq: typeof d.seq === "number" && Number.isFinite(d.seq) ? d.seq : undefined,
    lineage: Array.isArray(d.lineage) ? d.lineage.filter((g): g is string => typeof g === "string").slice(-LINEAGE_MAX) : [],
  };
}

// ------------------------------------------------------------ 読み書き

export class CloudError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** 壊れていた世代など */
    readonly gen?: string,
  ) {
    super(message);
  }
  override name = "CloudError";
}

/** 送る内容（固めた時点の写し） */
export interface Prepared {
  gen: string;
  enc: Manifest["enc"];
  parts: string[];
  hash: string;
  bytes: number;
  docId: string;
  docUpdatedAt: string;
  title: string;
  nodes: number;
  edges: number;
  savedAt: string;
}

export class CloudRepo {
  constructor(
    private readonly be: CloudBackend,
    readonly uid: string,
    readonly holder: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get manifestPath(): string {
    return `data/users/${this.uid}/fourd`;
  }
  private get lockPath(): string {
    return `data/users/${this.uid}/fourd-lock`;
  }
  private get partsPath(): string {
    return `${this.manifestPath}/parts`;
  }
  private partPath(gen: string, i: number): string {
    return `${this.partsPath}/${gen}-${i}`;
  }

  async readManifest(): Promise<Manifest | null> {
    const d = await this.be.get(this.manifestPath);
    return d.exists ? parseManifest(d.data) : null;
  }

  /** 確定している最新を読む。書き換えの途中で古い分割が消えていたら、マニフェストから読み直す */
  async read(): Promise<{ manifest: Manifest; doc: DocData } | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const m = await this.readManifest();
      if (!m) return null;
      const chunks: string[] = [];
      let missing = false;
      for (let i = 0; i < m.parts; i++) {
        const p = await this.be.get(this.partPath(m.gen, i));
        const data = p.exists ? p.data?.data : undefined;
        if (typeof data !== "string") {
          missing = true;
          break;
        }
        chunks.push(data);
      }
      if (missing) continue;
      const payload = chunks.join("");
      if ((await sha256Hex(payload)) !== m.hash) throw new CloudError("corrupt", "アカウントの写しが壊れています（ハッシュが合わない）", m.gen);
      try {
        return { manifest: m, doc: await decodeDoc(m.enc, payload) };
      } catch (e) {
        if (e instanceof CloudError && e.code === "corrupt") throw new CloudError("corrupt", e.message, m.gen);
        throw e;
      }
    }
    throw new CloudError("unavailable", "アカウントの写しを読み切れませんでした（書き換えの途中）");
  }

  /** 貸し出しを取る（同じ holder なら延長） */
  lease(ttlMs: number): Promise<boolean> {
    return this.be.lease(this.lockPath, this.holder, ttlMs);
  }

  /** 送る内容を固める（呼んだ瞬間の内容） */
  async prepare(doc: DocData): Promise<Prepared> {
    const counts = docCounts(doc);
    const docId = doc.id;
    const docUpdatedAt = doc.updatedAt;
    // 題名はマニフェストでは表示に使うだけ。長すぎて 256 KiB を超えないよう切る（中身は分割の方に全部ある）
    const title = [...doc.title].slice(0, MANIFEST_TITLE_MAX).join("");
    const { enc, payload, bytes } = await encodeDoc(doc);
    const parts: string[] = [];
    for (let i = 0; i < payload.length; i += PART_CHARS) parts.push(payload.slice(i, i + PART_CHARS));
    if (parts.length === 0) parts.push("");
    return { gen: `g${newId("b").slice(2)}`, enc, parts, hash: await sha256Hex(payload), bytes, docId, docUpdatedAt, title, nodes: counts.nodes, edges: counts.edges, savedAt: nowISO() };
  }

  /** 分割を書く（まだ確定ではない。失敗したら書けた分を消す） */
  async writeParts(p: Prepared): Promise<void> {
    let written = 0;
    try {
      for (let i = 0; i < p.parts.length; i++) {
        await this.be.set(this.partPath(p.gen, i), { gen: p.gen, i, savedAt: p.savedAt, data: p.parts[i]! });
        written = i + 1;
      }
    } catch (e) {
      await this.deleteGens([{ gen: p.gen, parts: written, savedAt: p.savedAt }]);
      throw e;
    }
  }

  /**
   * マニフェストを書いて確定する。片付ける世代（2 分より古い・数の上限を超えた）を返す。
   * 消すのは確定のあと（確定に失敗しても、今のマニフェストが指す物は消さない）
   */
  async commit(p: Prepared, prev: Manifest | null): Promise<{ manifest: Manifest; drop: Manifest["stale"] }> {
    const expired = new Set(prev ? this.expiredStale(prev).map((s) => s.gen) : []);
    const keep: Manifest["stale"] = [];
    const drop: Manifest["stale"] = [];
    for (const s of prev?.stale ?? []) (expired.has(s.gen) ? drop : keep).push(s);
    if (prev) keep.push({ gen: prev.gen, parts: prev.parts, savedAt: prev.savedAt });
    while (keep.length > MAX_STALE) drop.push(keep.shift()!);
    const m: Manifest = {
      format: 1,
      enc: p.enc,
      gen: p.gen,
      parts: p.parts.length,
      hash: p.hash,
      bytes: p.bytes,
      docId: p.docId,
      docUpdatedAt: p.docUpdatedAt,
      title: p.title,
      nodes: p.nodes,
      edges: p.edges,
      savedAt: p.savedAt,
      writer: this.holder,
      stale: keep,
      seq: (prev?.seq ?? 0) + 1,
      lineage: prev ? [...prev.lineage, prev.gen].slice(-LINEAGE_MAX) : [],
    };
    // 自分の書き込みが大きすぎるときは、共有の権限の問題と取り違えないよう、送る前に止める
    if (new TextEncoder().encode(JSON.stringify(m)).length > 250 * 1024) throw new CloudError("too_large", "アカウントの写しの目録が大きすぎて保存できません");
    await this.be.set(this.manifestPath, m as unknown as Record<string, unknown>);
    return { manifest: m, drop };
  }

  /** 片付けてよい古い世代: 次の世代に置き換えられてから 2 分たった物（作られた時刻ではなく、置き換えられた時刻で数える） */
  expiredStale(m: Manifest): Manifest["stale"] {
    return m.stale.filter((_s, i) => {
      const at = Date.parse((m.stale[i + 1] ?? m).savedAt);
      return Number.isFinite(at) && this.now() - at > STALE_MS;
    });
  }

  /** まとめて書く（固める → 分割 → 確定 → 片付け）。テストや一度きりの書き込みに */
  async write(doc: DocData, prev: Manifest | null): Promise<Manifest> {
    const p = await this.prepare(doc);
    await this.writeParts(p);
    const { manifest, drop } = await this.commit(p, prev);
    await this.deleteGens(drop);
    return manifest;
  }

  async deleteGens(gens: Manifest["stale"]): Promise<void> {
    for (const s of gens) for (let i = 0; i < s.parts; i++) await this.be.delete(this.partPath(s.gen, i)).catch(() => undefined);
  }

  /**
   * どこからも指されない分割を消す（失敗した送信の残り・古い版の取りこぼし）。
   * 別の端末が書いている途中かもしれない新しい物（10 分以内）は残す。消した数を返す
   */
  async sweep(m: Manifest | null): Promise<number> {
    if (!this.be.list) return 0;
    const live = new Set<string>();
    if (m) {
      live.add(m.gen);
      for (const s of m.stale) live.add(s.gen);
    }
    let n = 0;
    for (const d of await this.be.list(this.partsPath)) {
      const gen = typeof d.data?.gen === "string" ? d.data.gen : d.id.replace(/-\d+$/, "");
      if (live.has(gen)) continue;
      const at = Date.parse(typeof d.data?.savedAt === "string" ? d.data.savedAt : "");
      if (Number.isFinite(at) && this.now() - at < SWEEP_MIN_AGE_MS) continue;
      await this.be.delete(`${this.partsPath}/${d.id}`).catch(() => undefined);
      n++;
    }
    return n;
  }

  /** マニフェストを見張る。読めない形（新しい版など）なら unreadable を呼ぶ */
  watch(next: (m: Manifest | null) => void, error: (code: string) => void, unreadable?: () => void): () => void {
    return this.be.watch(
      this.manifestPath,
      (d) => {
        if (!d.exists) return next(null);
        let m: Manifest | null;
        try {
          m = parseManifest(d.data);
        } catch {
          return unreadable?.();
        }
        next(m);
      },
      error,
    );
  }
}

// ------------------------------------------------------------ 同期の決まり

export type CloudState = "off" | "connecting" | "synced" | "pending" | "syncing" | "offline" | "denied" | "error" | "paused";

export interface SyncBase {
  /** 最後に合わせたクラウドの世代 */
  gen: string;
  /** そのときの手元のドキュメント */
  docId: string;
  docUpdatedAt: string;
  /** その世代の通し番号 */
  seq?: number;
  /** その世代はこの端末が確定した物か（後から系譜に無い世代が来たら、上書きされた） */
  own?: boolean;
}

/**
 * 入れ替えの種類: first = 初めての同期で、捨ててよい手元を / choice = 利用者が選んで / remote = 別の端末の変更を
 */
export type AdoptHow = "first" | "choice" | "remote";

/** 入れ替えた瞬間の手元の印（この後の編集は、次の送信に回る） */
export interface DocIdent {
  id: string;
  updatedAt: string;
}

export interface CloudSyncDeps {
  getDoc(): DocData;
  /** この端末のこのタブが書いてよいか（別のタブが編集中なら false） */
  isWriter(): boolean;
  /** 捨ててよい中身か（何もしていないデモ・まっさらな空）。初めての同期で、聞かずにもう一方を採ってよい */
  isDisposable(doc: DocData): boolean;
  /** その場の入力（題名の書き換えなど）の途中か。確定するまで取り込みを待つ */
  isEditing(): boolean;
  /** このブラウザの内容が、前に別のアカウントで同期していた物か（聞かずにこのアカウントへ送らない） */
  isForeign(): boolean;
  /**
   * 入れ替える。入れ替えた瞬間の手元の印を返す（手元にも保存してから返す）。
   * stillOk() が false なら（その間に手元が変わった）・閲覧のみなら・choice で手元を残せなかったら、入れ替えずに null
   */
  adopt(doc: DocData, how: AdoptHow, stillOk: () => boolean): Promise<DocIdent | null>;
  /**
   * 手元のバックアップに残す。kept = 利用者の選択で使わなかった内容（ふだんの入れ替えで押し出さない）。残せなかったら false
   */
  backup(doc: DocData, label: string, kind: "conflict" | "kept"): Promise<boolean>;
  /**
   * バックアップを作れないブラウザで、置き換える内容（doc）を書き出してから続けてよいか聞く。続けるなら true
   */
  confirmWithoutBackup(doc: DocData, what: "account" | "browser"): Promise<boolean>;
  /**
   * 初めての同期で、どちらを使うか聞く。remote が null なら「アカウントは空。別のアカウントの内容を送ってよいか」
   */
  chooseFirst(remote: { doc: DocData; manifest: Manifest } | null): Promise<"remote" | "local" | "later">;
  readBase(): Promise<SyncBase | null>;
  writeBase(base: SyncBase): Promise<void>;
  notice(text: string, tone: "info" | "warn" | "error"): void;
}

export interface CloudSyncOptions {
  /** 入力が止まってから送るまで（続いていても、最初の変更からこの 4 倍で送る） */
  debounceMs?: number;
  /** 書く間の貸し出しの長さ（返す仕組みは無く、時間で切れる。確定の直前に延ばす） */
  leaseMs?: number;
  /** 貸し出し中・入力中だったときに待つ時間 */
  retryMs?: number;
  /** 見張りが切れたときに張り直すまで（だんだん延ばす） */
  resubscribeMs?: number;
}

type Reason = "start" | "push" | "remote" | "resync";
const PRIORITY: Record<Reason, number> = { push: 1, remote: 2, start: 3, resync: 3 };

export class CloudSync {
  state: CloudState = "off";
  message = "";
  lastSyncedAt: string | null = null;
  private base: SyncBase | null = null;
  private lastPushedGen: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remoteTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  /** 今の窓で最初に変わった時刻（送る内容を固めたら 0 に戻す） */
  private firstPendingAt = 0;
  /** 失敗の後、この時刻までは送らない（入力があっても縮めない） */
  private notBefore = 0;
  private running: Promise<void> | null = null;
  private again: Reason | null = null;
  private unwatch: (() => void) | null = null;
  private watchFailures = 0;
  private stopped = false;
  /** 利用者の決定待ち・自分では解けない状態: 自動では同期しない（resync で再開） */
  private paused = false;
  /** 壊れていた世代（その世代だけは読まずに手元で書き直す） */
  private corruptGen: string | null = null;
  /** 退避済みの相手の世代（貸し出し待ちのやり直しで、同じ物を何度も退避しない） */
  private backedUpGen: string | null = null;
  /** 別のアカウントの内容を、このアカウントへ送ってよいと答えてもらった */
  private foreignConsent = false;
  private swept = false;
  private readonly emitter = new Emitter<{ state: CloudState }>();
  private readonly debounceMs: number;
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly resubscribeMs: number;

  constructor(
    private readonly repo: CloudRepo,
    private readonly deps: CloudSyncDeps,
    opts: CloudSyncOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 5000;
    this.leaseMs = opts.leaseMs ?? 6_000;
    this.retryMs = opts.retryMs ?? 3000;
    this.resubscribeMs = opts.resubscribeMs ?? 30_000;
  }

  on(fn: (s: CloudState) => void): () => void {
    return this.emitter.on("state", fn);
  }

  private setState(state: CloudState, message = ""): void {
    this.state = state;
    this.message = message;
    if (state === "synced") {
      this.lastSyncedAt = nowISO();
      this.firstPendingAt = 0;
    }
    this.emitter.emit("state", state);
  }

  /** 自分では解けない（利用者の決定・操作が要る）: 自動の同期を止める */
  private pause(message: string): void {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setState("paused", message);
  }

  /**
   * 保存してある基準を読む。このブラウザの内容が別のアカウントの物になっていたら、
   * 手元がその基準のときのままでない限り使わない（古い基準で、別のアカウントの内容を黙って送らない）
   */
  private async loadBase(fallback: SyncBase | null): Promise<SyncBase | null> {
    const b = await this.deps.readBase().catch(() => fallback);
    if (!b || !this.deps.isForeign()) return b;
    const d = this.deps.getDoc();
    return d.id === b.docId && d.updatedAt === b.docUpdatedAt ? b : null;
  }

  /** 起動: クラウドと手元を突き合わせ、以後の変更を見張る */
  async start(): Promise<void> {
    this.setState("connecting");
    this.base = await this.loadBase(null);
    await this.sync("start");
    this.subscribe();
  }

  /** 突き合わせをやり直す（別のタブから編集を引き継いだとき・「同期をやり直す」）。保存してある基準から読み直す */
  resync(): void {
    if (this.stopped || this.state === "off" || this.state === "denied") return;
    this.paused = false;
    this.notBefore = 0;
    if (!this.unwatch) this.subscribe();
    void this.sync("resync");
  }

  /** アカウントの写しが変わっていないか確かめる（画面に戻ったとき・つながったとき）。見張りが切れていれば張り直す */
  checkRemote(): void {
    if (this.stopped || this.paused || this.state === "off" || this.state === "denied") return;
    if (Date.now() < this.notBefore) return;
    if (!this.unwatch) this.subscribe();
    void this.sync("remote");
  }

  /** このタブが書き手でなくなった（別のタブに引き継がれた） */
  writerLost(): void {
    if (this.stopped || this.state === "off" || this.state === "denied") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setState("pending", "別のタブが編集中");
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    for (const t of [this.timer, this.remoteTimer, this.cleanupTimer]) if (t) clearTimeout(t);
    this.timer = null;
    this.remoteTimer = null;
    this.cleanupTimer = null;
  }

  private subscribe(): void {
    if (this.stopped || this.unwatch) return;
    this.unwatch = this.repo.watch(
      (m) => {
        this.watchFailures = 0;
        this.onRemote(m);
      },
      (code) => {
        this.unwatch = null;
        if (code === "revoked" || code === "not_granted" || code === "capability_disabled" || code === "capability_removed") {
          this.setState("off");
          this.stop();
          return;
        }
        // 見張りが切れた（ホストが答えない・混み合いなど）: 間をあけて何度でも張り直す。張り直すと今の写しが届く
        const wait = Math.min(this.resubscribeMs * 2 ** this.watchFailures, 5 * 60_000);
        this.watchFailures++;
        setTimeout(() => this.subscribe(), wait);
      },
      // 読めない形の写し（新しい版など）が来た: 読みに行けば止まる（上書きしない）
      () => {
        if (!this.stopped && !this.paused) void this.sync("remote");
      },
    );
  }

  /** 手元で前回の同期から変わったか（基準が無ければ、まだ一度も合わせていない） */
  private localChanged(): boolean {
    if (!this.base) return true;
    const doc = this.deps.getDoc();
    return doc.id !== this.base.docId || doc.updatedAt !== this.base.docUpdatedAt;
  }

  /**
   * 手元が基準より古いか（基準だけが保存され、手元の保存が失われた・壊れた: そのまま送ると新しい写しを古い手元で潰す）。
   * 更新時刻は必ず進むので、同じドキュメントで基準より前の時刻なら古い。違うドキュメントが捨ててよい中身（デモなど）でも同じ
   */
  private localBehindBase(): boolean {
    if (!this.base) return false;
    const doc = this.deps.getDoc();
    if (doc.id === this.base.docId) return doc.updatedAt < this.base.docUpdatedAt;
    return this.deps.isDisposable(doc);
  }

  /** 手元で変更があった（ストアの変更のたびに呼ぶ） */
  markDirty(): void {
    if (this.stopped || this.paused || this.state === "off" || this.state === "denied") return;
    if (!this.firstPendingAt) this.firstPendingAt = Date.now();
    // 失敗の後の待ちの間は、その知らせ（混み合い・つながらない）を残す
    const waiting = Date.now() < this.notBefore;
    if (this.state !== "syncing" && this.state !== "connecting" && !waiting) this.setState("pending");
    this.schedule();
  }

  private schedule(delay?: number): void {
    if (this.stopped || this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    let wait = delay ?? (this.firstPendingAt && Date.now() - this.firstPendingAt > this.debounceMs * 4 ? 0 : this.debounceMs);
    wait = Math.max(wait, this.notBefore - Date.now(), 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync("push");
    }, wait);
  }

  /** 別の端末の変更を、少し待ってから読み直す。入力の途中なら db には触れずに待ち続ける（終わってから 1 回だけ読む） */
  private scheduleRemote(delay: number): void {
    if (this.stopped || this.paused) return;
    if (this.remoteTimer) clearTimeout(this.remoteTimer);
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = null;
      if (this.deps.isEditing()) return this.scheduleRemote(delay);
      void this.sync("remote");
    }, delay);
  }

  /** すぐに同期する（タブが隠れたとき・⌘S）。失敗の後の待ちは守る */
  async flush(): Promise<void> {
    if (this.stopped || this.paused || this.state === "off" || this.state === "denied") return;
    if (Date.now() < this.notBefore) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) await this.running;
    if (this.base && !this.localChanged()) {
      // 送る物は無い（インポートの後などで「同期待ち」のまま残さない）
      if (this.state === "pending") this.setState("synced");
      return;
    }
    await this.sync("push");
  }

  private onRemote(m: Manifest | null): void {
    if (!m || this.stopped || this.paused) return;
    if (this.base && m.gen === this.base.gen) return;
    // 自分の書き込み（確定の知らせが、基準を更新するより先に届くことがある）
    if (m.gen === this.lastPushedGen || m.writer === this.repo.holder) return;
    // 別の端末が書いた
    void this.sync("remote");
  }

  private sync(reason: Reason): Promise<void> {
    if (this.running) {
      // 走っている間に来た: 終わってから続ける（重い方を残す。送信はまとめる間隔を守る）
      if (!this.again || PRIORITY[reason] > PRIORITY[this.again]) this.again = reason;
      return this.running;
    }
    const run = this.doSync(reason)
      .catch((e) => this.fail(e))
      .finally(() => {
        this.running = null;
        const next = this.again;
        this.again = null;
        if (!next || this.stopped || this.paused) return;
        if (next === "push") {
          if (this.localChanged()) this.schedule();
        } else void this.sync(next);
      });
    this.running = run;
    return run;
  }

  private async setBase(gen: string, doc: DocIdent, extra: { seq?: number; own: boolean }): Promise<void> {
    this.base = { gen, docId: doc.id, docUpdatedAt: doc.updatedAt, seq: extra.seq, own: extra.own };
    await this.deps.writeBase(this.base).catch(() => undefined);
  }

  /** 入れ替えが済んだ: 入れ替えた瞬間の手元を基準にする。その後に手元が変わっていれば送る */
  private async adopted(m: Manifest, ident: DocIdent, notice: string): Promise<void> {
    await this.setBase(m.gen, ident, { seq: m.seq, own: false });
    if (this.localChanged()) {
      this.setState("pending");
      if (!this.firstPendingAt) this.firstPendingAt = Date.now();
      this.schedule();
    } else this.setState("synced");
    this.deps.notice(notice, "info");
  }

  /** 書き手でなくなっていたら止める（別のタブに引き継がれた。そのタブが同期する） */
  private stillWriter(): boolean {
    if (this.deps.isWriter()) return true;
    this.setState("pending", "別のタブが編集中");
    return false;
  }

  private async doSync(reason: Reason): Promise<void> {
    if (this.stopped) return;
    if (reason === "resync") this.base = await this.loadBase(this.base);
    if (!this.deps.isWriter()) {
      if (reason === "start" || reason === "resync") this.setState("pending", "別のタブが編集中");
      return;
    }
    if (this.paused) return;
    this.setState("syncing");
    for (let attempt = 0; attempt < 3; attempt++) {
      const remoteM = await this.repo.readManifest();
      if ((await this.decide(remoteM, reason)) === "done") return;
      if (!this.stillWriter()) return;
      // 送る内容を固める。ここからの変更は次の送信へ（まとめる窓もここで区切る）
      const prep = await this.repo.prepare(this.deps.getDoc());
      this.firstPendingAt = 0;
      // 貸し出しは短く（返す仕組みが無く、長いと別の端末を待たせる）。書く途中で切れても、確定の前の確かめで気づく
      const ttl = this.leaseMs;
      if (!(await this.repo.lease(ttl))) {
        this.setState("pending", "別の端末が保存中");
        this.schedule(this.retryMs);
        return;
      }
      // 決めている間に、別の端末が書いたかもしれない
      if (((await this.repo.readManifest())?.gen ?? null) !== (remoteM?.gen ?? null)) continue;
      await this.repo.writeParts(prep);
      const drop = async () => this.repo.deleteGens([{ gen: prep.gen, parts: prep.parts.length, savedAt: prep.savedAt }]);
      // 書いている間に貸し出しが切れて、別の端末が先に確定したかもしれない: 延ばして確かめてから確定する
      let renewed: boolean;
      try {
        renewed = (await this.repo.lease(ttl)) && ((await this.repo.readManifest())?.gen ?? null) === (remoteM?.gen ?? null);
      } catch (e) {
        await drop();
        throw e;
      }
      if (!renewed) {
        await drop();
        continue;
      }
      if (!this.deps.isWriter()) {
        await drop();
        this.stillWriter();
        return;
      }
      let committed: { manifest: Manifest; drop: Manifest["stale"] };
      try {
        committed = await this.repo.commit(prep, remoteM);
      } catch (e) {
        await drop();
        throw e;
      }
      const { manifest } = committed;
      this.lastPushedGen = manifest.gen;
      this.corruptGen = null;
      this.notBefore = 0;
      await this.setBase(manifest.gen, { id: prep.docId, updatedAt: prep.docUpdatedAt }, { seq: manifest.seq, own: true });
      void this.repo.deleteGens(committed.drop).catch(() => undefined);
      this.scheduleCleanup();
      if (!this.swept) {
        this.swept = true;
        void this.repo.sweep(manifest).catch(() => undefined);
      }
      if (this.localChanged()) {
        // 送っている間にまた変わった: 次の窓で送る
        this.setState("pending");
        if (!this.firstPendingAt) this.firstPendingAt = Date.now();
        this.schedule();
      } else this.setState("synced");
      return;
    }
    // 何度も追い越された: 少し待ってからやり直す
    this.setState("pending", "別の端末が保存中");
    this.schedule(this.retryMs);
  }

  /** 置き換えられた古い世代を、2 分たったら次の送信を待たずに片付ける（共有の 25,000 文書の枠を空ける） */
  private scheduleCleanup(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      if (this.stopped) return;
      void this.repo
        .readManifest()
        .then((m) => (m ? this.repo.deleteGens(this.repo.expiredStale(m)) : undefined))
        .catch(() => undefined);
    }, STALE_MS + 5000);
  }

  /** 基準が無く、別のアカウントで同期していた（捨ててよい物でない）中身を送る前に聞く。送ってよければ true */
  private async foreignOk(): Promise<boolean> {
    if (this.base || this.foreignConsent || !this.deps.isForeign() || this.deps.isDisposable(this.deps.getDoc())) return true;
    this.setState("pending", "このアカウントに保存するか、選んでください");
    const choice = await this.deps.chooseFirst(null);
    if (this.stopped || !this.stillWriter()) return false;
    if (choice !== "local") {
      this.pause("このブラウザの内容をこのアカウントに保存するか決めるまで、同期を止めています");
      return false;
    }
    this.foreignConsent = true;
    return true;
  }

  /** 取り込みや確認だけで済む・止めたなら "done"、送る必要があれば "push" */
  private async decide(remoteM: Manifest | null, reason: Reason): Promise<"done" | "push"> {
    if (!remoteM) {
      // アカウントは空: 手元を送る（初めての端末・写しが消されていた）。別のアカウントで同期していた中身は、聞いてから
      return (await this.foreignOk()) ? "push" : "done";
    }
    // 壊れていた写しは、手元の内容で書き直す
    if (this.corruptGen && remoteM.gen === this.corruptGen) return (await this.foreignOk()) ? "push" : "done";
    if (this.base && remoteM.gen === this.base.gen) {
      if (!this.localChanged()) {
        this.setState("synced");
        return "done";
      }
      // 手元が基準より古い（手元の保存が失われた）: 送らずに、アカウントの内容を読み込む
      if (this.localBehindBase()) return this.recoverBehind();
      // アカウントは変わっていない。手元の変更は、まとめる間隔を守って送る（確かめのついでにすぐ送らない）
      if (reason === "remote") {
        this.setState("pending");
        if (!this.firstPendingAt) this.firstPendingAt = Date.now();
        this.schedule();
        return "done";
      }
      return "push";
    }
    const remote = await this.repo.read();
    if (!remote) return (await this.foreignOk()) ? "push" : "done";
    const doc = this.deps.getDoc();
    if (remote.doc.id === doc.id && remote.doc.updatedAt === doc.updatedAt) {
      // 中身は同じ（この端末が送ったもの・基準の保存に失敗していたなど）
      await this.setBase(remote.manifest.gen, doc, { seq: remote.manifest.seq, own: false });
      this.setState("synced");
      return "done";
    }
    if (!this.base) return this.decideFirst(remote);
    // 読み終えてから確かめる（読んでいる間の変更を見落とさない）。
    // この端末が確定した世代が、相手の系譜に無い（上書きされた）ときも、手元に変更があるのと同じに扱う
    if (!this.localChanged() && !this.overwritten(remote.manifest)) {
      if (this.deps.isEditing()) {
        // その場の入力の途中: 確定すれば重なり、やめれば取り込みになる。終わるまで待って読み直す
        this.setState("pending", "入力が終わってから、別の端末の変更を読み込みます");
        this.scheduleRemote(this.retryMs);
        return "done";
      }
      const ident = await this.deps.adopt(remote.doc, "remote", () => !this.localChanged() && !this.deps.isEditing() && this.deps.isWriter());
      if (ident) {
        await this.adopted(remote.manifest, ident, "別の端末で保存された内容を読み込みました。");
        return "done";
      }
      if (!this.stillWriter()) return "done";
      // 読み込む直前に手元が変わった: 重なりとして扱う
    }
    return this.keepLocal(remote, "conflict", "別の端末で保存されていた内容（同期で重なった）", "別の端末の内容と重なったため、手元の内容で同期し、別の端末の内容はバックアップに残しました（メニュー →「バックアップと復元」）。", "warn");
  }

  /**
   * この端末が確定した世代（基準）が、届いた写しの系譜に無い: 書いている間に貸し出しが切れるなどして、
   * 別の端末がこちらの確定を知らずに上書きした。前の版の写し（通し番号が無い）・系譜の窓を外れた古い基準は見分けない
   */
  private overwritten(m: Manifest): boolean {
    const b = this.base;
    if (!b?.own || typeof b.seq !== "number" || typeof m.seq !== "number") return false;
    if (m.seq <= b.seq) return true;
    if (m.seq - b.seq > m.lineage.length) return false;
    return !m.lineage.includes(b.gen);
  }

  /** 手元が基準より古かった: 新しいアカウントの内容を読み込む（読み込む前の手元はバックアップに残る） */
  private async recoverBehind(): Promise<"done" | "push"> {
    const remote = await this.repo.read();
    if (!remote) return "push";
    const ident = await this.deps.adopt(remote.doc, "remote", () => this.localBehindBase() && !this.deps.isEditing() && this.deps.isWriter());
    if (ident) {
      await this.adopted(remote.manifest, ident, "この端末に保存されていた内容が古かったため、アカウントの新しい内容を読み込みました。");
      return "done";
    }
    if (!this.stillWriter()) return "done";
    return this.keepLocal(remote, "conflict", "アカウントの内容（手元の古い内容と重なった）", "この端末の内容がアカウントの記録より古かったため、アカウントの内容をバックアップに残してから手元で同期しました。", "warn");
  }

  /** この端末で初めての同期（基準が無い）で、アカウントに手元と違う中身がある */
  private async decideFirst(remote: { manifest: Manifest; doc: DocData }): Promise<"done" | "push"> {
    if (this.deps.isEditing()) {
      this.setState("pending", "入力が終わってから、アカウントの内容と突き合わせます");
      this.scheduleRemote(this.retryMs);
      return "done";
    }
    const local = this.deps.getDoc();
    const foreign = this.deps.isForeign();
    if (this.deps.isDisposable(local)) {
      // 手元は何もしていないデモ（かまっさらな空）: アカウントの内容を採る（元に戻す対象にしない）
      const ident = await this.deps.adopt(remote.doc, "first", () => this.deps.isDisposable(this.deps.getDoc()) && !this.deps.isEditing() && this.deps.isWriter());
      if (ident) {
        await this.adopted(remote.manifest, ident, "アカウントに保存されていた内容を読み込みました。");
        return "done";
      }
      if (!this.stillWriter()) return "done";
      // その間に手元に中身ができた: 下で聞く
    } else if (this.deps.isDisposable(remote.doc) && !foreign) {
      // アカウントにあるのは何もしていないデモ（か空）: 手元を送る（別のアカウントの中身なら聞く）
      return "push";
    }
    this.setState("pending", "どちらの内容を使うか、選んでください");
    const choice = await this.deps.chooseFirst(remote);
    if (this.stopped) return "done";
    if (!this.deps.isWriter()) {
      this.stillWriter();
      this.deps.notice("別のタブで編集中のため、この選択は使いませんでした。編集中のタブで選んでください。", "warn");
      return "done";
    }
    if (choice === "later") {
      this.pause("このブラウザの内容とアカウントの内容のどちらを使うか決めるまで、同期を止めています");
      return "done";
    }
    if (choice === "remote") {
      const ident = await this.deps.adopt(remote.doc, "choice", () => this.deps.isWriter());
      if (!ident) {
        if (!this.stillWriter()) return "done";
        this.pause("このブラウザの内容を残せなかったため、切り替えをやめました。「同期をやり直す」から、書き出してから続けられます");
        return "done";
      }
      await this.adopted(remote.manifest, ident, "アカウントの内容に切り替えました。このブラウザにあった内容はバックアップに残しています（メニュー →「バックアップと復元」）。");
      return "done";
    }
    this.foreignConsent = true;
    return this.keepLocal(remote, "kept", "このブラウザの内容で置き換える前のアカウントの内容", "このブラウザの内容で同期しました。アカウントにあった内容はバックアップに残しています（メニュー →「バックアップと復元」）。", "info");
  }

  /**
   * 手元を正として送る前に、相手の内容をバックアップへ（同じ世代は 1 回だけ）。
   * バックアップを作れないブラウザでは、書き出してから続けるか聞き、断られたら止める
   */
  private async keepLocal(remote: { manifest: Manifest; doc: DocData }, kind: "conflict" | "kept", label: string, notice: string, tone: "info" | "warn"): Promise<"done" | "push"> {
    if (this.backedUpGen !== remote.manifest.gen) {
      if (!(await this.deps.backup(remote.doc, label, kind))) {
        if (!(await this.deps.confirmWithoutBackup(remote.doc, "account"))) {
          this.pause("アカウントの内容を残せないため、上書きせずに同期を止めました。「同期をやり直す」から、書き出してから続けられます");
          return "done";
        }
        notice = "アカウントにあった内容を書き出してから、手元の内容で同期しました。";
      }
      if (!this.stillWriter()) return "done";
      this.backedUpGen = remote.manifest.gen;
      this.deps.notice(notice, tone);
    }
    return "push";
  }

  /** 失敗: 種類ごとに待つ（待っている間は入力があっても送らない） */
  private backoff(ms: number): void {
    this.notBefore = Date.now() + ms;
    this.schedule(ms);
  }

  private fail(e: unknown): void {
    if (this.stopped) return;
    // 書き手でなくなっていた（入れ替えの途中で引き継がれた など）: 失敗として待たない。そのタブが同期する
    if (!this.deps.isWriter()) {
      this.setState("pending", "別のタブが編集中");
      return;
    }
    const code = e instanceof CloudError ? e.code : errorCode(e);
    if (code === "invalid_argument" || code === "not_granted" || code === "transform_error") {
      // 自分の場所に書けない（閲覧のみの共有など）: このブラウザだけに保存する
      this.setState("denied", "この共有のされ方では、アカウントには保存できません");
      this.stop();
      return;
    }
    if (code === "revoked" || code === "capability_disabled" || code === "capability_removed") {
      this.setState("off");
      this.stop();
      return;
    }
    if (code === "format" || code === "unsupported") {
      // 新しい版のアプリで保存された写し・このブラウザで読めない写し: 上書きしない
      this.pause(code === "format" ? `アカウントの写しを読めません（${e instanceof Error ? e.message : ""}）。ページを開き直してください` : e instanceof Error ? e.message : "アカウントの写しを読めません");
      return;
    }
    if (code === "too_large") {
      this.pause(`${e instanceof Error ? e.message : "大きすぎて保存できません"}。ドキュメントの名前を短くしてから「同期をやり直す」を押してください`);
      return;
    }
    if (code === "quota_exceeded") {
      this.setState("error", "アカウント側の保存容量がいっぱいです。使われていない写しを片付けてから、しばらくしてもう一度試します");
      // 使われていない分割・置き換えられて 2 分たった世代を片付ける（溜まっていれば、それで空く）
      void this.repo
        .readManifest()
        .then(async (m) => {
          if (m) await this.repo.deleteGens(this.repo.expiredStale(m));
          await this.repo.sweep(m);
        })
        .catch(() => undefined);
      this.backoff(10 * 60_000);
      return;
    }
    if (code === "resource_exhausted") {
      this.setState("pending", "混み合っているため、少し待って同期します");
      this.backoff(30_000);
      return;
    }
    if (code === "corrupt") {
      this.setState("error", "アカウントの写しが壊れていたため、手元の内容で書き直します");
      // 壊れた写しは手元の内容で置き換える（手元は無事）。その世代だけ。別の端末が直していれば読む
      this.corruptGen = e instanceof CloudError && e.gen ? e.gen : this.corruptGen;
      this.backoff(2000);
      return;
    }
    this.setState("offline", "つながらないため、あとで同期します");
    this.backoff(15_000);
  }
}
