import { defineConfig } from "vite";
import vercel from "./vercel.json";

// 本番（vercel.json）と同じセキュリティのヘッダーを、確かめ用のサーバー（vite preview）にも付ける。
// E2E が本番と同じ条件で動き、CSP の違反があればエラーとして見つかる
const securityHeaders = Object.fromEntries(vercel.headers[0]!.headers.map((x) => [x.key, x.value]));

// 出力は dist/ の静的ファイルだけ（サーバー不要）。相対パスにして、どの階層に置いても開けるようにする
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    // やりたいことリスト（3,000 件・約 1.1 MB、文字列のまま同梱）を含めて 1 つの JS にする（Artifact 版は 1 枚のページに埋め込むため分けない）
    chunkSizeWarningLimit: 1600,
  },
  server: { port: 5178 },
  preview: { port: 4178, headers: securityHeaders },
});
