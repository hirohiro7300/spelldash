// アカウントへの同期（claude.ai の Artifact の db 機能）。設計: docs/DESIGN.md §5.1
//
// - 手元（IndexedDB）が主のまま、あなただけが読める場所（data/users/<id>/）に写しを置く。別の端末でも同じ内容が出る
// - db の 1 文書は 256 KiB までなので、JSON を gzip → base64 にして分割（parts）し、最後にマニフェストを書く（それが確定）。
//   読み手はいつもマニフェストから読む。古い世代の分割は、次の送信で（2 分以上たったものだけ）片付ける
// - 送信は短い貸し出し（lease）を取ってから。同時に 2 つの端末が書き換えない
// - 別の端末の変更: 手元に未送信の変更が無ければ取り込む。両方変わっていたら、相手の内容を手元のバックアップに退避してから送る
//   （どちらの変更も黙って消さない）

import type { DbApi } from "../host/claude";
import { errorCode } from "../host/claude";
import { newId, nowISO } from "../model/ids";
import { docCounts, normalizeDoc } from "../model/schema";
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
  /** 協調のための短い貸し出し。仕組みが無ければ、取れたことにする */
  lease(path: string, holder: string, ttlMs: number): Promise<boolean>;
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
        // 貸し出しの仕組みが使えないときは、協調なしで進める（版の確かめは残る）
        if (errorCode(e) === "resource_exhausted") throw e;
        return true;
      }
    },
  };
}

// ------------------------------------------------------------ 符号化（gzip + base64、無ければ JSON のまま）

const PART_CHARS = 180_000;

export interface Manifest {
  format: 1;
  enc: "gzip-b64" | "json";
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
}

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
  if (typeof CompressionStream === "undefined") return { enc: "json", payload: json, bytes: json.length };
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  return { enc: "gzip-b64", payload: toB64(gz), bytes: json.length };
}

export async function decodeDoc(enc: Manifest["enc"], payload: string): Promise<DocData> {
  let json = payload;
  if (enc === "gzip-b64") {
    const stream = new Blob([fromB64(payload)]).stream().pipeThrough(new DecompressionStream("gzip"));
    json = await new Response(stream).text();
  }
  return normalizeDoc(JSON.parse(json)).doc;
}

function parseManifest(d: Record<string, unknown> | undefined): Manifest | null {
  if (!d || d.format !== 1 || typeof d.gen !== "string" || typeof d.parts !== "number" || typeof d.hash !== "string") return null;
  const stale = Array.isArray(d.stale)
    ? d.stale.filter((s): s is Manifest["stale"][number] => !!s && typeof s === "object" && typeof (s as { gen?: unknown }).gen === "string" && typeof (s as { parts?: unknown }).parts === "number")
    : [];
  return {
    format: 1,
    enc: d.enc === "json" ? "json" : "gzip-b64",
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
  };
}

// ------------------------------------------------------------ 読み書き

export class CloudError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  override name = "CloudError";
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
  private partPath(gen: string, i: number): string {
    return `${this.manifestPath}/parts/${gen}-${i}`;
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
      if ((await sha256Hex(payload)) !== m.hash) throw new CloudError("corrupt", "アカウントの写しが壊れています（ハッシュが合わない）");
      return { manifest: m, doc: await decodeDoc(m.enc, payload) };
    }
    throw new CloudError("unavailable", "アカウントの写しを読み切れませんでした（書き換えの途中）");
  }

  lease(ttlMs: number): Promise<boolean> {
    return this.be.lease(this.lockPath, this.holder, ttlMs);
  }

  /** 分割を書いてから、最後にマニフェストを書く。2 分以上前の古い世代はここで片付ける */
  async write(doc: DocData, prev: Manifest | null): Promise<Manifest> {
    const counts = docCounts(doc);
    const docId = doc.id;
    const docUpdatedAt = doc.updatedAt;
    const title = doc.title;
    const { enc, payload, bytes } = await encodeDoc(doc);
    const gen = `g${newId("b").slice(2)}`;
    const savedAt = nowISO();
    const parts: string[] = [];
    for (let i = 0; i < payload.length; i += PART_CHARS) parts.push(payload.slice(i, i + PART_CHARS));
    if (parts.length === 0) parts.push("");

    // 古い世代の片付け。直前の世代（prev）は、新しいマニフェストが確定するまで読み手がいるかもしれないので残し、
    // それより前の世代も 2 分は残す
    const keep: Manifest["stale"] = [];
    for (const s of prev?.stale ?? []) {
      const at = Date.parse(s.savedAt);
      if (Number.isFinite(at) && this.now() - at > 120_000) {
        for (let i = 0; i < s.parts; i++) await this.be.delete(this.partPath(s.gen, i)).catch(() => undefined);
      } else keep.push(s);
    }
    if (prev) keep.push({ gen: prev.gen, parts: prev.parts, savedAt: prev.savedAt });

    for (let i = 0; i < parts.length; i++) await this.be.set(this.partPath(gen, i), { gen, i, savedAt, data: parts[i]! });
    const m: Manifest = {
      format: 1,
      enc,
      gen,
      parts: parts.length,
      hash: await sha256Hex(payload),
      bytes,
      docId,
      docUpdatedAt,
      title,
      nodes: counts.nodes,
      edges: counts.edges,
      savedAt,
      writer: this.holder,
      stale: keep.slice(-20),
    };
    await this.be.set(this.manifestPath, m as unknown as Record<string, unknown>);
    return m;
  }

  watch(next: (m: Manifest | null) => void, error: (code: string) => void): () => void {
    return this.be.watch(this.manifestPath, (d) => next(d.exists ? parseManifest(d.data) : null), error);
  }
}

// ------------------------------------------------------------ 同期の決まり

export type CloudState = "off" | "connecting" | "synced" | "pending" | "syncing" | "offline" | "denied" | "error";

export interface SyncBase {
  /** 最後に合わせたクラウドの世代 */
  gen: string;
  /** そのときの手元のドキュメント */
  docId: string;
  docUpdatedAt: string;
}

export interface CloudSyncDeps {
  getDoc(): DocData;
  /** この端末のこのタブが書いてよいか（別のタブが編集中なら false） */
  isWriter(): boolean;
  /**
   * 別の端末の内容に入れ替える（手元にも保存してから返す。基準はその後に書く）。
   * 入れ替えられなかったら投げる（基準を進めず、あとでやり直す）
   */
  adopt(doc: DocData, firstLoad: boolean): void | Promise<void>;
  /** 手元のバックアップに残す */
  backup(doc: DocData, label: string): Promise<void>;
  readBase(): Promise<SyncBase | null>;
  writeBase(base: SyncBase): Promise<void>;
  notice(text: string, tone: "info" | "warn" | "error"): void;
}

export interface CloudSyncOptions {
  /** 手元がまだ何も変えていない初回のデモか（そうならクラウドの内容をそのまま採る） */
  localFresh: boolean;
  debounceMs?: number;
  /** 書く間の貸し出しの長さ（返す仕組みは無く、時間で切れる） */
  leaseMs?: number;
  /** 貸し出し中だったときに待つ時間 */
  retryMs?: number;
}

export class CloudSync {
  state: CloudState = "off";
  message = "";
  lastSyncedAt: string | null = null;
  private base: SyncBase | null = null;
  private lastPushedGen: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private unwatch: (() => void) | null = null;
  private stopped = false;
  private resubscribed = false;
  /** アカウントの写しが壊れていた: 読まずに手元の内容で書き直す */
  private overwriteRemote = false;
  private readonly emitter = new Emitter<{ state: CloudState }>();
  private readonly debounceMs: number;
  private readonly leaseMs: number;
  private readonly retryMs: number;

  constructor(
    private readonly repo: CloudRepo,
    private readonly deps: CloudSyncDeps,
    private readonly opts: CloudSyncOptions,
  ) {
    this.debounceMs = opts.debounceMs ?? 5000;
    this.leaseMs = opts.leaseMs ?? 6_000;
    this.retryMs = opts.retryMs ?? 3000;
  }

  on(fn: (s: CloudState) => void): () => void {
    return this.emitter.on("state", fn);
  }

  private setState(state: CloudState, message = ""): void {
    this.state = state;
    this.message = message;
    if (state === "synced") this.lastSyncedAt = nowISO();
    this.emitter.emit("state", state);
  }

  /** 起動: クラウドと手元を突き合わせ、以後の変更を見張る */
  async start(): Promise<void> {
    this.setState("connecting");
    try {
      this.base = await this.deps.readBase();
    } catch {
      this.base = null;
    }
    await this.sync("start");
    this.subscribe();
  }

  /** 突き合わせをやり直す（別のタブから編集を引き継いだときなど） */
  resync(): void {
    if (this.stopped || this.state === "off" || this.state === "denied") return;
    void this.sync("remote");
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private subscribe(): void {
    if (this.stopped || this.unwatch) return;
    this.unwatch = this.repo.watch(
      (m) => this.onRemote(m),
      (code) => {
        this.unwatch = null;
        if (code === "revoked") return this.setState("off");
        if (code === "unavailable" && !this.resubscribed) {
          // 見張りが切れた: 少し待って 1 回だけ張り直す
          this.resubscribed = true;
          setTimeout(() => this.subscribe(), 30_000);
        }
      },
    );
  }

  /** 手元で前回の同期から変わったか */
  private localChanged(): boolean {
    const doc = this.deps.getDoc();
    if (!this.base) return !this.opts.localFresh;
    return doc.id !== this.base.docId || doc.updatedAt !== this.base.docUpdatedAt;
  }

  /** 手元で変更があった（ストアの変更のたびに呼ぶ） */
  markDirty(): void {
    this.opts.localFresh = false;
    if (this.stopped || this.state === "off" || this.state === "denied") return;
    if (!this.firstPendingAt) this.firstPendingAt = Date.now();
    if (this.state !== "syncing") this.setState("pending");
    this.schedule();
  }

  private schedule(delay?: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = delay ?? (this.firstPendingAt && Date.now() - this.firstPendingAt > this.debounceMs * 4 ? 0 : this.debounceMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync("push");
    }, wait);
  }

  /** すぐに同期する（タブが隠れたとき・⌘S） */
  async flush(): Promise<void> {
    if (this.stopped || this.state === "off" || this.state === "denied") return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) await this.running;
    if (this.localChanged()) await this.sync("push");
  }

  private onRemote(m: Manifest | null): void {
    if (!m || this.stopped) return;
    if (this.base && m.gen === this.base.gen) return;
    if (m.gen === this.lastPushedGen) return;
    // 別の端末が書いた
    void this.sync("remote");
  }

  private sync(reason: "start" | "push" | "remote"): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = this.doSync(reason)
      .catch((e) => this.fail(e))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          void this.sync("push");
        }
      });
    this.running = run;
    return run;
  }

  private async setBase(gen: string, docId: string, docUpdatedAt: string): Promise<void> {
    this.base = { gen, docId, docUpdatedAt };
    await this.deps.writeBase(this.base).catch(() => undefined);
  }

  private async doSync(reason: "start" | "push" | "remote"): Promise<void> {
    if (this.stopped) return;
    if (!this.deps.isWriter()) {
      if (reason === "start") this.setState("pending", "別のタブが編集中");
      return;
    }
    this.setState("syncing");
    let remoteM = await this.repo.readManifest();
    if ((await this.decide(remoteM, reason)) === "done") return;

    // 送る: 書く間だけ貸し出しを取り、取れたらもう一度確かめる（決めている間に別の端末が書いたかもしれない）
    if (!(await this.repo.lease(this.leaseMs))) {
      this.setState("pending", "別の端末が保存中");
      this.schedule(this.retryMs);
      return;
    }
    const again = await this.repo.readManifest();
    if ((again?.gen ?? null) !== (remoteM?.gen ?? null)) {
      remoteM = again;
      if ((await this.decide(remoteM, "remote")) === "done") return;
    }
    const doc = this.deps.getDoc();
    const docId = doc.id;
    const docUpdatedAt = doc.updatedAt;
    const m = await this.repo.write(doc, remoteM);
    this.overwriteRemote = false;
    this.lastPushedGen = m.gen;
    await this.setBase(m.gen, docId, docUpdatedAt);
    this.opts.localFresh = false;
    if (this.localChanged()) {
      // 送っている間にまた変わった
      this.setState("pending");
      this.schedule();
    } else {
      this.firstPendingAt = 0;
      this.setState("synced");
    }
  }

  /** 取り込みや確認だけで済むなら "done"、送る必要があれば "push" */
  private async decide(remoteM: Manifest | null, reason: "start" | "push" | "remote"): Promise<"done" | "push"> {
    const known = !!remoteM && !!this.base && remoteM.gen === this.base.gen;
    const localChanged = this.localChanged();
    if (remoteM && !known && !this.overwriteRemote) {
      const remote = await this.repo.read();
      if (remote) {
        const doc = this.deps.getDoc();
        if (remote.doc.id === doc.id && remote.doc.updatedAt === doc.updatedAt) {
          // 中身は同じ（この端末が送ったものなど）
          await this.setBase(remote.manifest.gen, doc.id, doc.updatedAt);
          this.firstPendingAt = 0;
          this.setState("synced");
          return "done";
        }
        if (!localChanged) {
          await this.deps.adopt(remote.doc, reason === "start");
          // 基準は「読み込んだ後の手元」で取る（読み込みで手元の更新時刻が進んでも、変更と見なして送り返さない）
          const adopted = this.deps.getDoc();
          await this.setBase(remote.manifest.gen, adopted.id, adopted.updatedAt);
          this.opts.localFresh = false;
          this.firstPendingAt = 0;
          this.setState("synced");
          this.deps.notice(reason === "start" ? "アカウントに保存されていた内容を読み込みました。" : "別の端末で保存された内容を読み込みました。", "info");
          return "done";
        }
        // 両方が変わった: 手元を正とし、相手の内容は消さずにバックアップへ
        await this.deps.backup(remote.doc, "別の端末で保存されていた内容（同期で重なった）");
        this.deps.notice("別の端末の内容と重なったため、手元の内容で同期し、別の端末の内容はバックアップに残しました（メニュー →「バックアップと復元」）。", "warn");
      }
      return "push";
    }
    if (known && !localChanged && !this.overwriteRemote) {
      this.firstPendingAt = 0;
      this.setState("synced");
      return "done";
    }
    return "push";
  }

  private fail(e: unknown): void {
    const code = e instanceof CloudError ? e.code : errorCode(e);
    if (code === "invalid_argument" || code === "not_granted") {
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
    if (code === "quota_exceeded") {
      this.setState("error", "アカウント側の保存容量がいっぱいです。不要なノードを減らすか、JSON で書き出してください");
      this.schedule(60_000);
      return;
    }
    if (code === "resource_exhausted") {
      this.setState("pending", "混み合っているため、少し待って同期します");
      this.schedule(30_000);
      return;
    }
    if (code === "corrupt") {
      this.setState("error", "アカウントの写しが壊れていたため、手元の内容で書き直します");
      // 壊れた写しは手元の内容で置き換える（手元は無事）
      this.overwriteRemote = true;
      this.schedule(2000);
      return;
    }
    this.setState("offline", "つながらないため、あとで同期します");
    this.schedule(15_000);
  }
}
