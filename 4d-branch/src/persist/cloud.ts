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
/** 分割が見つからないときに読み直すまでの間（回ごとに延ばす。届くのが遅れているだけの分割を、壊れたと取り違えない） */
const READ_RETRY_MS = 1000;
/** 読めずに置き換えた世代を覚えておく数 */
const LOST_MAX = 8;

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
  /**
   * 通し番号を数え始めた世代（空のアカウントからなら ""）。前の版の写し（通し番号・系譜が無い）の上に
   * 書くと数え直しになるので、同じ数え方の中でだけ通し番号と系譜を比べる
   */
  chain?: string;
  /**
   * この世代に至る直前までの世代（新しい物が後ろ・最後が直前の世代・最大 64）。上書きされたか・古い世代が
   * 戻ってきたかを見分ける。確定に失敗したように見えた自分の世代と、書いた端末の基準の世代も入れる
   */
  lineage: string[];
  /**
   * 写しが読めず（分割が無い・壊れていた）、読まずに置き換えた世代。その世代を手元に持つ端末は、
   * 置き換えた内容を取り込まずに、自分の内容で戻す（戻したら外す）
   */
  lost?: string[];
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
    chain: typeof d.chain === "string" ? d.chain : undefined,
    lineage: Array.isArray(d.lineage) ? d.lineage.filter((g): g is string => typeof g === "string").slice(-LINEAGE_MAX) : [],
    lost: Array.isArray(d.lost) ? d.lost.filter((g): g is string => typeof g === "string").slice(-LOST_MAX) : [],
  };
}

/** 確定するときに足すこと */
export interface CommitExtra {
  /** 系譜に足す世代（確定に失敗したように見えた自分の世代・この端末の基準の世代とその系譜） */
  lineage?: string[];
  /** 読めずに置き換える世代 */
  lost?: string[];
  /**
   * この端末の手元が中身を持っている世代（基準とその系譜。読めずに置き換えられた世代は除く）。
   * 「読めずに置き換えた世代」にあれば、この確定で戻すので外す
   */
  has?: string[];
  /** 通し番号をこれより後にする（基準の上ではなく、戻ってきた古い世代の上に送り直すとき。基準より前の番号にしない） */
  after?: number;
  /** 基準の「読めずに置き換えた世代」（戻ってきた古い世代の上に送り直しても、まだ戻されていない印を残す） */
  keepLost?: string[];
}

/** prev の次の世代の系譜（直前の世代が最後。足す世代はその前に） */
function nextLineage(prev: Manifest | null, self: string, extra: string[] = []): string[] {
  const out = [...(prev?.lineage ?? [])];
  for (const g of extra) if (g && g !== self && g !== prev?.gen && !out.includes(g)) out.push(g);
  if (prev) out.push(prev.gen);
  return out.slice(-LINEAGE_MAX);
}

/** prev の次の世代の「読めずに置き換えた世代」（中身を持って戻した世代は外し、新しく置き換える世代を足す） */
function nextLost(prev: Manifest | null, extra: CommitExtra): string[] {
  const out = [...new Set([...(prev?.lost ?? []), ...(extra.keepLost ?? [])])].filter((g) => !extra.has?.includes(g));
  for (const g of extra.lost ?? []) if (!out.includes(g)) out.push(g);
  return out.slice(-LOST_MAX);
}

/** prev の次に確定する世代の通し番号と、その数え方（前の版の写しの上なら、その世代から数え直す） */
function nextSeq(prev: Manifest | null, after?: number): { seq: number; chain: string } {
  if (!prev) return { seq: Math.max(1, (after ?? 0) + 1), chain: "" };
  const counted = typeof prev.seq === "number" && typeof prev.chain === "string";
  return { seq: Math.max((prev.seq ?? 0) + 1, (after ?? 0) + 1), chain: counted ? prev.chain! : prev.gen };
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

  /**
   * 確定している最新を読む。書き換えの途中で古い分割が消えていたら、マニフェストから読み直す。
   * マニフェストが同じ世代を指したまま、何度読んでも分割が無ければ、その世代は壊れている（世代を添えて知らせ、
   * 手元の内容で書き直せるようにする。そのままだと、どの端末も読めないまま止まり続ける）
   */
  async read(): Promise<{ manifest: Manifest; doc: DocData } | null> {
    let missingGen = "";
    let misses = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
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
      if (missing) {
        misses = m.gen === missingGen ? misses + 1 : 1;
        missingGen = m.gen;
        if (misses >= 3) throw new CloudError("corrupt", "アカウントの写しの一部が見つかりません", m.gen);
        await new Promise((r) => setTimeout(r, READ_RETRY_MS * misses));
        continue;
      }
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
  async commit(p: Prepared, prev: Manifest | null, extra: CommitExtra = {}): Promise<{ manifest: Manifest; drop: Manifest["stale"] }> {
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
      ...nextSeq(prev, extra.after),
      lineage: nextLineage(prev, p.gen, extra.lineage),
      lost: nextLost(prev, extra),
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
  /** その世代の通し番号と、その数え方（Manifest.chain） */
  seq?: number;
  chain?: string;
  /** その世代はこの端末が確定した物か（後から系譜に無い世代が来たら、上書きされた） */
  own?: boolean;
  /** この端末が確定したとき、その上に書いた世代（"" = 空のアカウント） */
  parent?: string;
  /** その世代の系譜（ここにある世代が後から戻ってきたら、古い書き込みが届いただけ） */
  lineage?: string[];
  /** その世代の「読めずに置き換えた世代」（系譜にあっても、中身は持っていない） */
  lost?: string[];
  /**
   * 手元が古いまま「同期をやり直す」で戻ってきた古い世代を読み込んだとき、持っていなかった基準の世代。
   * 次の確定で「読めずに置き換えた世代」に書き残す（その世代を持つ端末が戻せるように）
   */
  unheld?: string[];
  /** 基準を書くたびに変わる印（同じ世代・同じ時刻でも、別のタブが書き直したと分かる） */
  at?: string;
}

/**
 * 基準を書いてよいか（stored = 手元に保存できた最新の印）。基準が手元に保存できた内容を超えるなら書かない。
 * この端末が送った基準で、手元がその後に入れ替えた（新しい時刻の）別のドキュメントなら書いてよい
 * （入れ替えは時刻を必ず進める。次に開いたとき、入れ替えた内容はふつうの変更として送る）
 */
export function baseCovered(stored: DocIdent | null, b: SyncBase): boolean {
  if (!stored) return false;
  if (stored.id === b.docId) return stored.updatedAt >= b.docUpdatedAt;
  return !!b.own && stored.updatedAt > b.docUpdatedAt;
}

/** 同じ基準か（世代とそのときの手元） */
function sameBase(a: Pick<SyncBase, "gen" | "docId" | "docUpdatedAt"> | null | undefined, b: Pick<SyncBase, "gen" | "docId" | "docUpdatedAt"> | null | undefined): boolean {
  return !!a && !!b && a.gen === b.gen && a.docId === b.docId && a.docUpdatedAt === b.docUpdatedAt;
}

/** 同じ書き込みの基準か（同じ基準で、書いた印も同じ。前の版が書いた基準は印を持たない） */
function sameWrite(a: SyncBase | null, b: SyncBase | null): boolean {
  return sameBase(a, b) && a!.at === b!.at;
}

/**
 * 入れ替えの種類: first = 捨ててよい手元（初めての同期・保存が失われて代わりに始めたデモなど）を /
 * choice = 利用者が選んで / remote = 別の端末の変更・新しいアカウントの内容を
 */
export type AdoptHow = "first" | "choice" | "remote";

/** 入れ替えた瞬間の手元の印（この後の編集は、次の送信に回る） */
export interface DocIdent {
  id: string;
  updatedAt: string;
}

/**
 * 起動したときに読み込んだ手元（どの編集よりも前）。基準を書くまで、このブラウザに残す（どのタブからも読め、
 * 開き直しても残る）。最後に基準を書いてから最初の起動の物（代わりの内容で始めたときは、その起動の物）
 */
export interface BootDoc extends DocIdent {
  /** 保存してあった内容を読めず、代わりの内容（デモ・バックアップ）で始めた */
  fallback: boolean;
  /**
   * 記録したときの基準（null = 基準が無かった・undefined = 分からない）。その後に基準が書き換わっていたら
   * （前の版のタブが書いた・書きかけで閉じた）、記録は古いので使わない
   */
  on?: { gen: string; docId: string; docUpdatedAt: string } | null;
}

export interface CloudSyncDeps {
  getDoc(): DocData;
  /**
   * 起動したときの手元の記録（無ければ null）。手元が基準より古い（保存が失われた）かは、これで決める
   * （同期が始まる前に編集した・開き直した・別のタブから引き継いだ ときも、古かったことを見落とさない）
   */
  bootDoc(): Promise<BootDoc | null>;
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
  /** 突き合わせをやり直す前に、このブラウザの状態（どのアカウントの内容か など）を読み直す */
  refresh?(): Promise<void>;
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
/** 初めての同期で「このブラウザの内容を使う」と答えたときの、アカウントの内容のバックアップと知らせ */
const KEPT_LABEL = "このブラウザの内容で置き換える前のアカウントの内容";
const KEPT_NOTICE = "このブラウザの内容で同期しました。アカウントにあった内容はバックアップに残しています（メニュー →「バックアップと復元」）。";
/** はっきり断られた（書かれていない）ときの答え。これ以外（つながらない等）は、書けているかもしれない */
const REJECTED = new Set(["invalid_argument", "resource_exhausted", "quota_exceeded", "revoked", "not_granted", "capability_disabled", "capability_removed", "transform_error"]);
const PRIORITY: Record<Reason, number> = { push: 1, remote: 2, start: 3, resync: 3 };

export class CloudSync {
  state: CloudState = "off";
  message = "";
  lastSyncedAt: string | null = null;
  private base: SyncBase | null = null;
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
  /** 起動したときの手元の記録（書き手として突き合わせを始めるときに読む） */
  private boot: BootDoc | null = null;
  /** 起動したときの手元が、基準と違うドキュメントの代わりの内容だった（基準を決め直すまで） */
  private bootLost = false;
  /**
   * 手元が古いと分かったときの基準。その基準のままの間は、その後に編集されても黙って送らない
   * （読み込むか、アカウントの内容を残してから送る）
   */
  private behindOf: SyncBase | null = null;
  /** 確定に失敗したように見えた送信（返事が届かなかっただけで、書けているかもしれない）。on = そのときの基準の世代 */
  private unconfirmed: { on: string | null; gen: string; docId: string; docUpdatedAt: string; seq: number; chain: string; lineage: string[]; lost: string[]; parent: string } | null = null;
  /** 確定に失敗したように見えた世代（次の確定の系譜に入れる。後から届いても、古い書き込みと分かる） */
  private failedGens: string[] = [];
  /** 確定している途中の世代（確定してから基準を書き終えるまで。その知らせは自分の書き込み） */
  private inFlightGen: string | null = null;
  /** 基準の系譜にある古い世代が戻ってきたが、手元が古くて送り直せない世代（利用者が「同期をやり直す」を押すと先へ進める） */
  private replayedGen: string | null = null;
  private replayOkFor: string | null = null;
  /** 初めての同期で「このブラウザの内容を使う」と答えたときのアカウントの世代（送れずにやり直しても、もう聞かない） */
  private chosenLocalFor: string | null = null;
  /** 「同期をやり直す」で戻ってきた古い世代を読み込むとき、持っていなかった基準の世代（読み込んだ基準に引き継ぐ） */
  private unheld: string[] = [];
  /** 読めない写しを、この端末の内容で書き直すところ（その世代） */
  private repairing: string | null = null;
  /** 確定に失敗したように見えた送信の分割（後から届かなければ、しばらくして片付ける） */
  private orphans: Manifest["stale"] = [];
  /** 利用者が「同期をやり直す」を押したときの読めない世代: その世代は、この端末の内容で書き直してよい */
  private repairOkFor: string | null = null;
  private orphanTimer: ReturnType<typeof setTimeout> | null = null;
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
    // 止めた後（共有の取り消しなど）は、走り終えた同期が「同期済み」などで上書きしない
    if (this.stopped) return;
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

  /**
   * 起動したときの手元の記録から、手元が基準より古いか（保存が失われた）を決める。書き手として突き合わせを
   * 始めるたびに（起動・引き継ぎ・やり直し）。同期が始まる前に編集した・開き直した・別のタブで編集されていた
   * ときも、記録は基準を書くまで残るので見落とさない。記録が無ければ、この基準で古いと分かっていた物だけ残す
   */
  private async checkBoot(): Promise<void> {
    const raw = await this.deps.bootDoc().catch(() => null);
    const b = this.base;
    // 記録した後に基準が書き換わっていた（前の版のタブが書いた・書きかけで閉じた）: その記録は古いので使わない
    const rec = raw && (raw.on === undefined || (raw.on === null ? !b : sameBase(raw.on, b))) ? raw : null;
    this.boot = rec;
    // 手元が基準そのもの（同じドキュメント・同じ時刻）なら、古くない
    const atBase = !!b && !this.localChanged();
    this.bootLost = !atBase && !!(b && rec && rec.fallback && rec.id !== b.docId);
    const behind = !atBase && !!(b && rec && (rec.id === b.docId ? rec.updatedAt < b.docUpdatedAt : rec.fallback));
    if (behind) this.behindOf = b;
    // 別のタブが基準を書き直した（同じ世代・同じ時刻でも）: そのタブが解決した
    else if (atBase || !sameWrite(this.behindOf, b)) this.behindOf = null;
  }

  /** 手元が古いと分かったときの基準のままか（同じ書き込みの基準） */
  private markedBehind(): boolean {
    return sameWrite(this.behindOf, this.base);
  }

  /** この端末の手元が、基準の内容を持っているか（古い手元・代わりの内容なら持っていない） */
  private holdsBase(): boolean {
    return !!this.base && !this.markedBehind() && !this.localBehindBase() && !this.bootLost;
  }

  /**
   * 突き合わせをやり直す（別のタブから編集を引き継いだとき・「同期をやり直す」）。保存してある基準から読み直す。
   * userAsked: 利用者が「同期をやり直す」を押した（読めない写しを、この端末の内容で書き直してよい）
   */
  resync(opts: { userAsked?: boolean } = {}): void {
    if (this.stopped || this.state === "off" || this.state === "denied") return;
    this.paused = false;
    this.notBefore = 0;
    if (opts.userAsked) {
      this.repairOkFor = this.corruptGen;
      this.replayOkFor = this.replayedGen;
    }
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
    for (const t of [this.timer, this.remoteTimer, this.cleanupTimer, this.orphanTimer]) if (t) clearTimeout(t);
    this.timer = null;
    this.remoteTimer = null;
    this.cleanupTimer = null;
    this.orphanTimer = null;
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
   * 今の手元が基準より古いか（基準だけが保存され、手元の保存が失われた・壊れた: そのまま送ると新しい写しを古い手元で潰す）。
   * 更新時刻は必ず進むので、同じドキュメントで基準より前の時刻なら古い。
   * 違うドキュメントは、保存が失われて代わりに始めた内容（デモ・空）を、捨ててよいまま使っているときだけ。
   * 利用者が入れ替えた内容（空にする・デモを読み込む・復元・インポート）は新しい id になり、ふだんどおり送る
   */
  private localBehindBase(): boolean {
    if (!this.base) return false;
    const doc = this.deps.getDoc();
    if (doc.id === this.base.docId) return doc.updatedAt < this.base.docUpdatedAt;
    // 代わりの内容のまま（捨ててよい中身か、起動してから手を付けていない）
    return this.bootLost && !!this.boot && doc.id === this.boot.id && (this.deps.isDisposable(doc) || doc.updatedAt === this.boot.updatedAt);
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

  /** その場の入力（題名など）が終わってから、もう一度アカウントの内容と突き合わせる（入れ替えも重なりの扱いもしない） */
  private waitForEditing(message: string): "done" {
    this.setState("pending", message);
    this.scheduleRemote(this.retryMs);
    return "done";
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
    // 自分の書き込み（確定の知らせが、基準を更新するより先に届くことがある）。書いた人ではなく世代で見分ける
    // （失敗したように見えた自分の古い書き込みが、後の確定より後に届くことがある: それは突き合わせる）
    if (m.gen === this.inFlightGen) return;
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

  private async setBase(gen: string, doc: DocIdent, extra: { seq?: number; chain?: string; own: boolean; parent?: string; lineage?: string[]; lost?: string[]; unheld?: string[] }): Promise<void> {
    this.base = { gen, docId: doc.id, docUpdatedAt: doc.updatedAt, seq: extra.seq, chain: extra.chain, own: extra.own, parent: extra.parent, lineage: extra.lineage, lost: extra.lost ?? [], at: newId("b") };
    if (extra.unheld?.length) this.base.unheld = extra.unheld;
    this.unheld = [];
    // 基準を決め直した: 古かった手元・代わりに始めた内容・確かめられなかった送信・戻ってきた古い世代の扱いは済んだ
    this.behindOf = null;
    this.bootLost = false;
    this.unconfirmed = null;
    this.replayedGen = null;
    this.replayOkFor = null;
    await this.deps.writeBase(this.base).catch(() => undefined);
  }

  /** 入れ替えが済んだ: 入れ替えた瞬間の手元を基準にする。その後に手元が変わっていれば送る */
  private async adopted(m: Manifest, ident: DocIdent, notice: string): Promise<void> {
    // 「同期をやり直す」で戻ってきた古い世代を読み込んだ: 持っていなかった基準の世代を、この基準に引き継ぐ
    await this.setBase(m.gen, ident, { seq: m.seq, chain: m.chain, own: false, lineage: m.lineage, lost: m.lost, unheld: m.gen === this.replayOkFor ? this.unheld : undefined });
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
    if (reason === "resync") {
      // このブラウザの状態（どのアカウントの内容か）を読み直す（別のタブが同期していたかもしれない）
      await this.deps.refresh?.().catch(() => undefined);
      const before = this.base;
      this.base = await this.loadBase(this.base);
      // 別のタブが基準を進めていた: この端末の確かめられなかった送信は、もう当てはまらない
      if (!sameBase(before, this.base)) this.unconfirmed = null;
    }
    if (!this.deps.isWriter()) {
      if (reason === "start" || reason === "resync") this.setState("pending", "別のタブが編集中");
      return;
    }
    if (this.paused) return;
    if (reason === "start" || reason === "resync") await this.checkBoot();
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
      const extra = this.commitExtra(remoteM);
      let committed: { manifest: Manifest; drop: Manifest["stale"] };
      // 確定してから基準を書き終えるまでの、この世代の知らせは自分の書き込み
      this.inFlightGen = prep.gen;
      try {
        committed = await this.repo.commit(prep, remoteM, extra);
      } catch (e) {
        // 書く前に止めた（大きすぎる）・はっきり断られた: 書かれていないので、この分割はどこからも指されない
        if (e instanceof CloudError || REJECTED.has(errorCode(e))) {
          this.inFlightGen = null;
          await drop();
          throw e;
        }
        // 返事が届かなかった（つながらない等）: 書けていることがある・やり直しが後で届くことがある。
        // 分割は消さない（書けていればマニフェストが指している。届かなければ、しばらくして片付ける）
        const now = await this.repo.readManifest().catch(() => null);
        if (now?.gen !== prep.gen) {
          this.inFlightGen = null;
          this.unconfirmed = { on: this.base?.gen ?? null, gen: prep.gen, docId: prep.docId, docUpdatedAt: prep.docUpdatedAt, ...nextSeq(remoteM, extra.after), lineage: nextLineage(remoteM, prep.gen, extra.lineage), lost: nextLost(remoteM, extra), parent: remoteM?.gen ?? "" };
          if (!this.failedGens.includes(prep.gen)) this.failedGens = [...this.failedGens, prep.gen].slice(-LOST_MAX);
          this.orphans.push({ gen: prep.gen, parts: prep.parts.length, savedAt: prep.savedAt });
          this.scheduleOrphanSweep();
          throw e;
        }
        // 書けていた: ふだんの確定と同じに続ける（置き換えで外れた世代も片付ける）
        committed = { manifest: now, drop: (remoteM?.stale ?? []).filter((s) => !now.stale.some((k) => k.gen === s.gen)) };
      }
      const { manifest } = committed;
      const repairing = !!remoteM && this.repairing === remoteM.gen;
      this.corruptGen = null;
      this.repairing = null;
      this.notBefore = 0;
      // 系譜に入れた失敗の世代は、もう覚えておかなくてよい（後の確定の系譜に引き継がれる）
      this.failedGens = this.failedGens.filter((g) => !manifest.lineage.includes(g));
      await this.setBase(manifest.gen, { id: prep.docId, updatedAt: prep.docUpdatedAt }, { seq: manifest.seq, chain: manifest.chain, own: true, parent: remoteM?.gen ?? "", lineage: manifest.lineage, lost: manifest.lost });
      this.inFlightGen = null;
      void this.repo.deleteGens(committed.drop).catch(() => undefined);
      if (repairing) this.deps.notice("アカウントの写しが読めなくなっていたため、この端末の内容で書き直しました。", "warn");
      // 確定している間に止めた（共有の取り消しなど）: 基準は残し、片付けの予約・掃除・状態の更新はしない
      if (this.stopped) return;
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

  /**
   * この確定に足すこと。系譜には、確定に失敗したように見えた世代（後から届いても古い書き込みと分かる）と、
   * 手元が基準の内容を持っているなら基準の世代とその系譜（戻ってきた古い世代の上に送り直しても、たどってきた世代を残す）。
   * 通し番号は基準より後に（前の版のタブも、送り直しを上書きと取り違えない）。読めずに置き換えるなら、その世代を書き残す
   * （手元が古いなら、持っていない基準の世代も）。中身を持っている世代は「読めずに置き換えた世代」から外す
   */
  private commitExtra(remoteM: Manifest | null): CommitExtra {
    const base = this.base;
    const holds = this.holdsBase();
    const onOther = !!base && base.gen !== remoteM?.gen;
    // 基準の系譜を足す（届いた写しが知っている世代は nextLineage が除く）。届いた写しの窓（64）がいっぱいのときだけ、
    // 届いた写しが知っている最初の世代より前（窓より古い世代）は足さない（後ろに足すと、新しい世代が窓から押し出される）。
    // 系譜の並びは古い順とは限らない（送り直しでは、戻ってきた古い世代が最後に来る）ので、知っている「最後」では切らない。
    // 分かれた所が窓に無いときは、届いた写しの方が古い（遅れて届いた古い書き込み）・系譜を持たない写しなら全部足し、
    // 届いた写しが先へ進んでいる（基準が窓を外れるほど古い）なら足さない
    const bl = base?.lineage ?? [];
    let branch = bl;
    if (remoteM && base) {
      const known = new Set([...remoteM.lineage, remoteM.gen]);
      const first = bl.findIndex((g) => known.has(g));
      if (first >= 0) branch = remoteM.lineage.length >= LINEAGE_MAX ? bl.slice(first) : bl;
      else {
        const sameChain = typeof base.seq === "number" && typeof remoteM.seq === "number" && (base.chain === undefined ? remoteM.chain === undefined : remoteM.chain === base.chain);
        const remoteOlder = remoteM.lineage.length === 0 || (sameChain && remoteM.seq! < base.seq!);
        branch = remoteOlder ? bl : [];
      }
    }
    const lineage = [...this.failedGens, ...(holds && onOther ? [...branch, base!.gen] : [])];
    // 中身を持っている世代: 基準と、（読めずに置き換えた世代を知っている基準なら）その系譜
    const has = holds && base ? [base.gen, ...(base.lost ? bl : [])].filter((g) => !base.lost?.includes(g)) : [];
    // 読めずに置き換える世代: 読めない写しを書き直すならその世代（古い手元なら、持っていない基準の世代も）、
    // 「同期をやり直す」で古い世代を読み込んだ後なら、持っていなかった基準の世代（もう戻されていれば書かない）
    const unheld = [...this.unheld, ...(base?.unheld ?? [])].filter((g) => !has.includes(g) && g !== remoteM?.gen && !remoteM?.lineage.includes(g));
    const lost = [...(remoteM && this.repairing === remoteM.gen ? [remoteM.gen, ...(base && !holds ? [base.gen] : [])] : []), ...unheld];
    const after = holds && onOther && typeof base!.seq === "number" ? base!.seq : undefined;
    // 基準の印は、届いた写しの系譜にまだその世代が無いときだけ残す（系譜にあって印が無い写しは、戻された後か、その世代から続く内容）
    const keepLost = holds && base ? (base.lost ?? []).filter((g) => !remoteM?.lineage.includes(g)) : [];
    return { lineage, lost, has, after, keepLost };
  }

  /**
   * 確定に失敗したように見えた送信の分割を、しばらくしてから片付ける（そのときマニフェストから指されていなければ。
   * 後から届いて使われていれば残す）
   */
  private scheduleOrphanSweep(): void {
    if (this.stopped || this.orphanTimer) return;
    this.orphanTimer = setTimeout(() => {
      this.orphanTimer = null;
      if (this.stopped) return;
      const due = this.orphans.filter((o) => Date.now() - Date.parse(o.savedAt) >= SWEEP_MIN_AGE_MS);
      if (due.length < this.orphans.length) this.scheduleOrphanSweep();
      if (!due.length) return;
      void this.repo
        .readManifest()
        .then(async (m) => {
          const live = new Set([m?.gen, ...(m?.stale ?? []).map((x) => x.gen)]);
          const gone = due.filter((o) => !live.has(o.gen));
          this.orphans = this.orphans.filter((o) => !due.includes(o));
          await this.repo.deleteGens(gone);
        })
        .catch(() => undefined);
    }, SWEEP_MIN_AGE_MS + 5000);
  }

  /** 置き換えられた古い世代を、2 分たったら次の送信を待たずに片付ける（共有の 25,000 文書の枠を空ける） */
  private scheduleCleanup(): void {
    if (this.stopped) return;
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
    // 手元が基準そのもの（同じドキュメント・同じ時刻）なら古くない: 別のタブが読み込んで直した後の印を残さない
    if (this.behindOf && !this.localChanged()) this.behindOf = null;
    // 確定に失敗したように見えた送信が、実は書けていた（その上に別の端末が書いていても）: この端末が確定した物として基準にする
    // （その送信の後に基準が変わっていたら、もう当てはまらない）
    const u = this.unconfirmed;
    if (u && u.on === (this.base?.gen ?? null) && (remoteM.gen === u.gen || remoteM.lineage.includes(u.gen))) {
      await this.setBase(u.gen, { id: u.docId, updatedAt: u.docUpdatedAt }, { seq: u.seq, chain: u.chain, own: true, parent: u.parent, lineage: u.lineage, lost: u.lost });
    }
    // 基準の系譜にある世代が戻ってきた（古い書き込み・失敗したように見えた自分の書き込みが、後から届いた）:
    // 取り込まずに、手元の内容で戻す。手元が古いなら、ほかの端末に任せて待つ（利用者が「同期をやり直す」を押したら、
    // ふつうの新しい写しと同じに扱う: 手を付けていなければ読み込み、編集していれば退避してから送る）
    if (this.base && remoteM.gen !== this.base.gen && this.base.lineage?.includes(remoteM.gen)) {
      if (this.holdsBase()) return "push";
      if (this.replayOkFor !== remoteM.gen) {
        this.replayedGen = remoteM.gen;
        this.setState("error", "アカウントの写しが古い内容に戻っています。最新の内容がある端末で開くと直ります（この端末で続けるときは、メニュー →「バックアップと復元」の「同期をやり直す」）");
        return "done";
      }
      // 利用者が押した: この端末は基準の内容を持っていない。次の確定で書き残し、それを持つ端末が戻せるようにする
      this.unheld = [...new Set([...this.unheld, ...(this.base.unheld ?? []), this.base.gen])].slice(-LOST_MAX);
    }
    // 読めない写し: 中身のある、古くない手元なら、その内容で書き直す（読めなかった世代を書き残し、その世代を持つ端末が戻せるように）
    if (this.corruptGen && remoteM.gen === this.corruptGen) {
      if (!this.canRepair(remoteM)) {
        // 捨ててよい中身（デモ・空）では書き直せないので、やり直しは勧めない
        const hint = this.deps.isDisposable(this.deps.getDoc()) ? "" : "（この端末の内容で書き直すときは、メニュー →「バックアップと復元」の「同期をやり直す」）";
        this.setState("error", `アカウントの写しが読めません。最新の内容がある端末で開くと直ります${hint}`);
        return "done";
      }
      if (!(await this.foreignOk())) return "done";
      this.repairing = remoteM.gen;
      return "push";
    }
    if (this.base && remoteM.gen === this.base.gen) {
      if (!this.localChanged()) {
        this.setState("synced");
        return "done";
      }
      // 手元が基準より古い（手元の保存が失われた）: 送らずに、アカウントの内容を読み込む。
      // 古かった手元を、その後に編集していても、黙っては送らない（アカウントの内容を残してから送る）
      if (this.localBehindBase() || this.markedBehind()) return this.recoverBehind();
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
      await this.setBase(remote.manifest.gen, doc, { seq: remote.manifest.seq, chain: remote.manifest.chain, own: false, lineage: remote.manifest.lineage, lost: remote.manifest.lost, unheld: remote.manifest.gen === this.replayOkFor ? this.unheld : undefined });
      this.setState("synced");
      return "done";
    }
    if (!this.base) return this.decideFirst(remote);
    // 手元が基準より古い: アカウントが基準より先へ進んでいても、古い手元では上書きしない
    if (this.localBehindBase() || this.markedBehind()) return this.recoverBehind(remote);
    // 読み終えてから確かめる（読んでいる間の変更を見落とさない）。
    // この端末が確定した世代が、相手の系譜に無い（上書きされた）ときも、手元に変更があるのと同じに扱う
    if (!this.localChanged() && !this.overwritten(remote.manifest)) {
      // その場の入力の途中: 確定すれば重なり、やめれば取り込みになる。終わるまで待って読み直す
      if (this.deps.isEditing()) return this.waitForEditing("入力が終わってから、別の端末の変更を読み込みます");
      const ident = await this.deps.adopt(remote.doc, "remote", () => !this.localChanged() && !this.deps.isEditing() && this.deps.isWriter());
      if (ident) {
        await this.adopted(remote.manifest, ident, "別の端末で保存された内容を読み込みました。");
        return "done";
      }
      if (!this.stillWriter()) return "done";
      // 読み込む直前に入力が始まった（手元は変わっていない）: 重なりにせず、入力が終わってから読み直す
      if (!this.localChanged()) return this.waitForEditing("入力が終わってから、別の端末の変更を読み込みます");
      // 読み込む直前に手元が変わった: 重なりとして扱う
    }
    // この端末の基準の世代が、読めずに置き換えられていた: 置き換えた内容を残して、手元の内容で戻す
    if (remote.manifest.lost?.includes(this.base.gen)) {
      return this.keepLocal(remote, "conflict", "この端末の内容を含まずに書き直されていたアカウントの内容", "アカウントの写しが、この端末にある内容を含まずに書き直されていたため、この端末の内容で戻しました。書き直された内容はバックアップに残しています（メニュー →「バックアップと復元」）。", "warn");
    }
    return this.keepLocal(remote, "conflict", "別の端末で保存されていた内容（同期で重なった）", "別の端末の内容と重なったため、手元の内容で同期し、別の端末の内容はバックアップに残しました（メニュー →「バックアップと復元」）。", "warn");
  }

  /**
   * 読めない写しを、この端末の内容で書き直してよいか。捨ててよい中身（デモ・空）・古い手元・代わりの内容では書き直さない
   * （新しい端末のデモや古い内容が、ほかの端末の内容を押し流さないように）。基準があるなら、手元に未送信の変更があるか、
   * 読めない世代のすぐ前の世代が基準のとき（読める中で最新の内容）。利用者が「同期をやり直す」を押したときも
   */
  private canRepair(m: Manifest): boolean {
    if (this.deps.isDisposable(this.deps.getDoc())) return false;
    // 利用者が「同期をやり直す」を押した: 古い手元・代わりの内容でも、この端末の内容で書き直す
    // （持っていない基準の世代も「読めずに置き換えた世代」に書き残すので、それを持つ端末が戻せる）
    if (this.repairOkFor === m.gen) return true;
    if (!this.holdsBase() && this.base) return false;
    if (!this.base) return true;
    return this.localChanged() || this.base.gen === m.lineage[m.lineage.length - 1];
  }

  /**
   * この端末が確定した世代（基準）が、届いた写しの系譜に無い: 書いている間に貸し出しが切れるなどして、
   * 別の端末がこちらの確定を知らずに上書きした。通し番号の数え方が違う（間に前の版の写しが入った）・
   * 系譜の窓を外れた古い基準は見分けない（重なりと決めつけない）
   */
  private overwritten(m: Manifest): boolean {
    const b = this.base;
    if (!b) return false;
    // この端末の基準の世代が、読めずに置き換えられた（手元にその内容がある）
    if (m.lost?.includes(b.gen)) return true;
    if (!b.own) return false;
    // 届いた写しが、この端末の世代をたどっている（系譜にある）: 上書きではない
    if (m.lineage.includes(b.gen)) return false;
    // この端末が確定した世代の親の上に、別の端末が書いた（親は系譜にあるのに、この端末の世代が無い）。数え方によらない
    if (b.parent && m.lineage.includes(b.parent)) return true;
    if (typeof b.seq !== "number" || typeof m.seq !== "number") return false;
    // 通し番号は同じ数え方の中でだけ比べる（数え方を持たない基準は、前の版が書いた写しとだけ）
    if (b.chain === undefined ? m.chain !== undefined : m.chain !== b.chain) return false;
    if (m.seq <= b.seq) return true;
    // 系譜の窓を外れた古い基準は見分けない
    return m.seq - b.seq <= m.lineage.length;
  }

  /**
   * 手元が基準より古かった: 新しいアカウントの内容を読み込む（読み込む前の手元はバックアップに残る）。
   * 入力の途中なら、終わってから。古かった手元をその後に編集していたら、アカウントの内容を残してから手元で送る
   */
  private async recoverBehind(known?: { manifest: Manifest; doc: DocData }): Promise<"done" | "push"> {
    this.behindOf = this.base;
    if (this.localBehindBase() && this.deps.isEditing()) return this.waitForEditing("入力が終わってから、アカウントの内容を読み込みます");
    const remote = known ?? (await this.repo.read());
    if (!remote) return "push";
    if (this.localBehindBase()) {
      // 違うドキュメント（保存が失われて代わりに始めた内容）: 捨ててよい中身（デモ・空）なら残すまでもなく、元に戻すの対象にもしない。
      // 中身があれば（戻したバックアップ）、ふだんの取り込みと同じく残してから読み込む
      const doc = this.deps.getDoc();
      const lost = doc.id !== this.base!.docId;
      const how = lost && this.deps.isDisposable(doc) ? "first" : "remote";
      const ident = await this.deps.adopt(remote.doc, how, () => this.localBehindBase() && !this.deps.isEditing() && this.deps.isWriter());
      if (ident) {
        const replayed = remote.manifest.gen === this.replayOkFor;
        await this.adopted(
          remote.manifest,
          ident,
          replayed
            ? "アカウントの写し（古い内容に戻っていた物）を読み込みました。最新の内容がある端末で開くと、その端末の内容に戻ります。"
            : lost
              ? "この端末に保存されていた内容を読めなかったため、アカウントの内容を読み込みました。"
              : "この端末に保存されていた内容が古かったため、アカウントの新しい内容を読み込みました。",
        );
        return "done";
      }
      if (!this.stillWriter()) return "done";
      // 読み込む直前に入力が始まった（手元はまだ古いまま）: 入力が終わってから読み込む
      if (this.localBehindBase()) return this.waitForEditing("入力が終わってから、アカウントの内容を読み込みます");
    }
    return this.keepLocal(remote, "conflict", "アカウントの内容（手元の古い内容と重なった）", "この端末の内容がアカウントの記録より古かったため、アカウントの内容をバックアップに残してから手元で同期しました。", "warn");
  }

  /** この端末で初めての同期（基準が無い）で、アカウントに手元と違う中身がある */
  private async decideFirst(remote: { manifest: Manifest; doc: DocData }): Promise<"done" | "push"> {
    if (this.deps.isEditing()) return this.waitForEditing("入力が終わってから、アカウントの内容と突き合わせます");
    // 「このブラウザの内容を使う」と答えた後に送れず（別の端末が保存中など）やり直した: アカウントが同じなら、もう聞かずに送る
    if (this.chosenLocalFor === remote.manifest.gen) return this.keepLocal(remote, "kept", KEPT_LABEL, KEPT_NOTICE, "info");
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
      // 読み込む直前に入力が始まった（手元はまだ捨ててよいまま）: 入力が終わってから突き合わせる
      if (this.deps.isDisposable(this.deps.getDoc())) return this.waitForEditing("入力が終わってから、アカウントの内容と突き合わせます");
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
    this.chosenLocalFor = remote.manifest.gen;
    return this.keepLocal(remote, "kept", KEPT_LABEL, KEPT_NOTICE, "info");
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
