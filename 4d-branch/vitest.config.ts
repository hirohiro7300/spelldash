import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    // 読めない写しの確かめ（数秒あけて読み直す）と失敗の後の待ちを、そのままの時間で通すテストがある
    testTimeout: 30_000,
  },
});
