import { describe, expect, it } from "vitest";
import { loadPageMap, PAGE_Q } from "../../src/demo/pageBundle";

// 既定（今の公開版）は版 6 のまま。VITE_IMPACT_Q=1 と IMPACT_Q_BUNDLE を付けて走らせると、版 7 の候補を読む側を確かめる
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const qRun = env.VITE_IMPACT_Q === "1" && !!env.IMPACT_Q_BUNDLE;

describe("ページに入れる 3 か月ごとの地図の切り替え", () => {
  it.skipIf(qRun)("既定のビルドでは何も入れず、読む口は null を返す（版 6 のまま）", async () => {
    expect(PAGE_Q).toBe(false);
    await expect(loadPageMap()).resolves.toBeNull();
  });

  it.runIf(qRun)("切り替えたビルドでは候補の地図を 1 度だけ伸ばして読む", async () => {
    expect(PAGE_Q).toBe(true);
    const a = loadPageMap();
    expect(loadPageMap()).toBe(a);
    const map = await a;
    expect(map).not.toBeNull();
    expect(map!.n).toBeGreaterThan(1000);
    expect(map!.header.v).toBe(3);
    expect(map!.role(0)).toBe("r");
  });
});
