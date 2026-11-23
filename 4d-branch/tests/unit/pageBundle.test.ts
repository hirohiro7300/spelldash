import { describe, expect, it } from "vitest";
import { loadPageMap, PAGE_Q, PAGE_Q_RELEASE } from "../../src/demo/pageBundle";

// P2 からは既定のビルドが版 7 の地図を入れる。VITE_IMPACT_Q=0 で走らせると、地図を入れない版 6 だけのページを確かめる
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const off = env.VITE_IMPACT_Q === "0";

describe("ページに入れる 3 か月ごとの地図の切り替え", () => {
  it.runIf(off)("VITE_IMPACT_Q=0 のビルドでは何も入れず、読む口は null を返す（版 6 だけ）", async () => {
    expect(PAGE_Q).toBe(false);
    expect(PAGE_Q_RELEASE).toBeNull();
    await expect(loadPageMap()).resolves.toBeNull();
  });

  it.skipIf(off)("既定のビルドでは地図を 1 度だけ伸ばして読む（版 7・基準の文書の指紋つきの記録）", async () => {
    expect(PAGE_Q).toBe(true);
    const a = loadPageMap();
    expect(loadPageMap()).toBe(a);
    const map = await a;
    expect(map).not.toBeNull();
    expect(map!.n).toBeGreaterThan(1000);
    expect(map!.header.v).toBe(3);
    expect(map!.role(0)).toBe("r");
    if (env.VITE_IMPACT_Q !== "1") {
      expect(PAGE_Q_RELEASE).toMatchObject({ release: 7, hash: map!.header.hash, anchor: map!.header.anchor });
      expect(PAGE_Q_RELEASE!.digest).toMatch(/^[0-9a-z]{14}$/);
    }
  });
});
