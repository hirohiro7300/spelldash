import { defineConfig } from "vite";
import vercel from "./vercel.json";

/**
 * ページに入れる 3 か月ごとの地図（src/demo/pageBundle.ts）。P2 からは版 7（src/demo/impact-q.b64 と、その版の記録 src/demo/impact-q-release.json）が既定。
 *   VITE_IMPACT_Q=0: 地図を入れない（版 6 だけのページ。前の版のページを確かめるテストのため）
 *   VITE_IMPACT_Q=1 と IMPACT_Q_BUNDLE（impact-q.b64 の絶対パス）: その地図を入れる（生成の候補を試す。版の記録は IMPACT_Q_RELEASE。無ければ空の記録）
 */
export function impactQAlias(): Array<{ find: RegExp; replacement: string }> {
  // このリポジトリは Node の型を入れていないので、process はここだけ型を付けて読む
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
  const local = (f: string): string => decodeURIComponent(new URL(`./src/demo/${f}`, import.meta.url).pathname);
  const off = env.VITE_IMPACT_Q === "0";
  const other = env.VITE_IMPACT_Q === "1" && !!env.IMPACT_Q_BUNDLE;
  const file = off ? local("impact-q-none.b64") : other ? env.IMPACT_Q_BUNDLE! : local("impact-q.b64");
  // その地図の版の記録 {release, hash, digest, anchor}（基準の文書の指紋 digest があれば、起動で数え直さない）
  const rel = off ? local("impact-q-none.json") : other ? (env.IMPACT_Q_RELEASE ?? local("impact-q-none.json")) : local("impact-q-release.json");
  return [
    { find: /^@impact-q-bundle(\?raw)?$/, replacement: `${file}$1` },
    { find: /^@impact-q-release(\?raw)?$/, replacement: `${rel}$1` },
  ];
}

// 本番（vercel.json）と同じセキュリティのヘッダーを、確かめ用のサーバー（vite preview）にも付ける。
// E2E が本番と同じ条件で動き、CSP の違反があればエラーとして見つかる
const securityHeaders = Object.fromEntries(vercel.headers[0]!.headers.map((x) => [x.key, x.value]));

// 出力は dist/ の静的ファイルだけ（サーバー不要）。相対パスにして、どの階層に置いても開けるようにする
export default defineConfig({
  base: "./",
  resolve: { alias: impactQAlias() },
  build: {
    target: "es2022",
    sourcemap: true,
    // やりたいことリスト（3,000 件・約 1.1 MB、文字列のまま同梱）を含めて 1 つの JS にする（Artifact 版は 1 枚のページに埋め込むため分けない）
    chunkSizeWarningLimit: 1600,
  },
  server: { port: 5178 },
  preview: { port: 4178, headers: securityHeaders },
});
