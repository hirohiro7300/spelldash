// 生成の入口（scripts/impact/main.ts・scripts/impact/q/main.ts など）を型の点検にかけるための、node の機能の最小の宣言。
// リポジトリには @types/node が無いので、使う所だけをここに書く（scripts/impact/tsconfig.json だけが読む。アプリの点検には入らない）。
// 使う node の機能を増やしたら、ここにも足す（足さないと npm run typecheck が通らない）

declare module "node:fs" {
  const fs: {
    readFileSync(p: string | URL): Uint8Array;
    readFileSync(p: string | URL, enc: "utf8"): string;
    writeFileSync(p: string, d: string | Uint8Array): void;
    mkdirSync(p: string, o?: { recursive?: boolean }): void;
    existsSync(p: string | URL): boolean;
    readdirSync(p: string): string[];
  };
  export default fs;
}

declare module "node:path" {
  const path: {
    join(...p: string[]): string;
    resolve(...p: string[]): string;
    dirname(p: string): string;
    basename(p: string, ext?: string): string;
    relative(a: string, b: string): string;
  };
  export default path;
}

declare module "node:zlib" {
  export function gzipSync(d: string | Uint8Array, o?: { level?: number }): Uint8Array;
}

declare const Buffer: { from(s: string, enc: "utf8"): Uint8Array };

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  memoryUsage(): { heapUsed: number; rss: number };
};

// 生成は Vite の SSR で src を読むので、import.meta.env がある（開発の組み立て: DEV は true。src/demo/quarterDoc.ts が共有の部品を凍らせるかに使う）
interface ImportMeta {
  readonly env: { readonly DEV: boolean; readonly PROD: boolean; readonly MODE: string };
}
