import { defineConfig } from "vitest/config";
import { impactQAlias } from "./vite.config";

export default defineConfig({
  resolve: { alias: impactQAlias() },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // 同梱の地図を読み込んでから、どのテストも始める（同期で読む口は、読み込む前に呼ぶと止まる）
    setupFiles: ["tests/unit/setup.ts"],
    // 読めない写しの確かめ（数秒あけて読み直す）と失敗の後の待ちを、そのままの時間で通すテストがある
    testTimeout: 30_000,
  },
});
