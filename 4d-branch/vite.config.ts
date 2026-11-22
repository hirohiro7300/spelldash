import { defineConfig } from "vite";
import vercel from "./vercel.json";

/**
 * 3 か月ごとの地図（版 7 の候補）をページに入れる切り替え（src/demo/pageBundle.ts）。
 * VITE_IMPACT_Q=1 と IMPACT_Q_BUNDLE（impact-q.b64 の絶対パス）が揃ったときだけ、その中身を入れる。
 * 揃わなければ空のファイルを指し、今の公開版（版 6）と同じページになる
 */
export function impactQAlias(): Array<{ find: RegExp; replacement: string }> {
  // このリポジトリは Node の型を入れていないので、process はここだけ型を付けて読む
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
  const file = env.VITE_IMPACT_Q === "1" && env.IMPACT_Q_BUNDLE ? env.IMPACT_Q_BUNDLE : decodeURIComponent(new URL("./src/demo/impact-q-none.b64", import.meta.url).pathname);
  // その地図の版の記録 {release, hash, digest, anchor}（IMPACT_Q_RELEASE。無ければ空の記録: 基準の文書の指紋は、初めて使うときに数える）
  const rel = env.VITE_IMPACT_Q === "1" && env.IMPACT_Q_RELEASE ? env.IMPACT_Q_RELEASE : decodeURIComponent(new URL("./src/demo/impact-q-none.json", import.meta.url).pathname);
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
