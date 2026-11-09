// claude.ai の Artifact の中で動いているときだけ使える機能（db・user・downloads）への入口。
// ふつうのページ（Vercel など）では window.claude が無く、どれも null を返す。
// 型は使う所だけ（正は Artifact の型定義 db.d.ts・user.d.ts・downloads.d.ts）

export interface DbDocSnap {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface DbError {
  code: string;
  message: string;
}

export interface DbDocRef {
  get(): Promise<DbDocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  onSnapshot(next: (snap: DbDocSnap) => void, error?: (e: DbError) => void): () => void;
  acquire?(options: { holder: string; ttlMs?: number }): Promise<{ acquired: boolean; expiresAt?: string }>;
}

export interface DbCollRef {
  doc(id?: string): DbDocRef;
  get(): Promise<{ docs: Array<DbDocSnap & { id: string }> }>;
}

export interface DbApi {
  doc(path: string): DbDocRef;
  collection(path: string): DbCollRef;
}

export interface UserApi {
  id(): Promise<string | null>;
  can?(name: string): Promise<boolean | null> | boolean | null;
}

export interface DownloadsApi {
  save(req: { filename: string; data: string | Blob }): Promise<{ status: "saved" | "delivered" }>;
}

interface ClaudeHost {
  use(name: string): Promise<unknown>;
}

export function claudeHost(): ClaudeHost | null {
  const c = (globalThis as { claude?: { use?: unknown } }).claude;
  return c && typeof c.use === "function" ? (c as ClaudeHost) : null;
}

/** Artifact の中か（機能が使えるかどうかは別。use() が null を返すことがある） */
export function inArtifactHost(): boolean {
  return claudeHost() !== null;
}

/** 機能を取り出す。使えない・答えが無いときは null（ページはそれ無しで動く） */
export async function useCapability<T>(name: "db" | "user" | "downloads", timeoutMs = 12_000): Promise<T | null> {
  const host = claudeHost();
  if (!host) return null;
  try {
    const res = await Promise.race([host.use(name), new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
    return (res as T | null) ?? null;
  } catch {
    return null;
  }
}

export function errorCode(e: unknown): string {
  return e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : "unavailable";
}
