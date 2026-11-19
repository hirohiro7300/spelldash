import { describe, expect, it, vi } from "vitest";
import { futureRelease, futureVersion, impactBundleLoaded } from "../../src/demo/futureBundle";
import { impactDataVersion } from "../../src/demo/impact";
import raw from "../../src/demo/impact-data.json?raw";
import releaseFile from "../../src/demo/impact-release.json";

describe("同梱の地図を読み込む入口（loadImpactBundle。見直し gaps-3）", () => {
  it("単体テストの準備（tests/unit/setup.ts）で読み込んであり、同期で読む口がファイルの先頭からでも使える", () => {
    expect(impactBundleLoaded()).toBe(true);
    expect(futureRelease()).toBe(releaseFile.release);
    expect(futureVersion()).toBe(impactDataVersion(raw));
  });

  it("読み込む前は同期で読む口がどれも止まり（黙って空の地図を返さない）、読み込んだ後は使える。何度呼んでも同じ約束", async () => {
    // 準備で読み込んだ物とは別の、まだ読み込んでいない入口
    vi.resetModules();
    const fresh = await import("../../src/demo/futureBundle");
    expect(fresh.impactBundleLoaded()).toBe(false);
    const calls: Array<[string, () => unknown]> = [
      ["futureData", () => fresh.futureData()],
      ["futureVersion", () => fresh.futureVersion()],
      ["futureRelease", () => fresh.futureRelease()],
      ["buildFuture", () => fresh.buildFuture(new Date(2026, 10, 18))],
    ];
    for (const [name, call] of calls) {
      expect(call, name).toThrow(fresh.ImpactBundleNotLoadedError);
      expect(call, name).toThrow(`${name} の前に await loadImpactBundle() を呼ぶ`);
    }
    const p = fresh.loadImpactBundle();
    expect(fresh.loadImpactBundle()).toBe(p);
    await p;
    expect(fresh.impactBundleLoaded()).toBe(true);
    expect(fresh.loadImpactBundle()).toBe(p);
    expect(fresh.futureRelease()).toBe(releaseFile.release);
    expect(fresh.futureVersion()).toBe(releaseFile.version);
    expect(fresh.futureData().nodes.length).toBeGreaterThan(1000);
    const { pv, stats } = fresh.buildFuture(new Date(2026, 10, 18));
    expect(pv.counts.nodes).toBe(stats.nodes);
  });
});
