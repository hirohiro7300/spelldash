// CI（.github/workflows/4d-branch.yml）の仕事が、確かめるべき物を動かしているか（見直し found-2・found-4・gaps-16）。
// 型・単体テスト・ビルドの仕事は、時差の違う 2 つのプロセスでの確かめ（npm run test:tz）も動かす。遅いテストの仕事は落ちたら落ちる（continue-on-error を付けない）
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { nodeFs } from "./helpers/qSmall";

/** 仕事（jobs: の下の 2 字下げの名前）ごとの本文 */
function jobsOf(yml: string): Map<string, string> {
  const at = yml.indexOf("\njobs:\n");
  expect(at).toBeGreaterThan(0);
  const out = new Map<string, string>();
  const re = /^ {2}([A-Za-z0-9_-]+):\s*$/gm;
  const body = yml.slice(at + "\njobs:\n".length);
  const heads = [...body.matchAll(re)];
  heads.forEach((m, k) => out.set(m[1]!, body.slice(m.index!, k + 1 < heads.length ? heads[k + 1]!.index : body.length)));
  return out;
}

/** 仕事の中の run: の行（並びの順） */
const runsOf = (job: string): string[] => [...job.matchAll(/^\s+run:\s*(.+)$/gm)].map((m) => m[1]!.trim());

describe("CI の仕事（.github/workflows/4d-branch.yml）", () => {
  it("型・単体テスト・ビルドの仕事は、単体テストの後に時差の違う 2 つのプロセスでの確かめ（npm run test:tz）を動かす。test:tz はロサンゼルスと東京で組み立てと指紋のテストを動かす", async () => {
    const fs = await nodeFs();
    const yml = new TextDecoder().decode(fs.readFileSync(new URL("../../../.github/workflows/4d-branch.yml", import.meta.url)));
    const jobs = jobsOf(yml);
    const check = runsOf(jobs.get("check")!);
    expect(check).toContain("npm test");
    expect(check).toContain("npm run test:tz");
    expect(check.indexOf("npm run test:tz")).toBeGreaterThan(check.indexOf("npm test"));
    const tz = (pkg.scripts as Record<string, string>)["test:tz"]!;
    for (const zone of ["America/Los_Angeles", "Asia/Tokyo"]) expect(tz).toMatch(new RegExp(`TZ=${zone} vitest run tests/unit/quarterDoc\\.test\\.ts tests/unit/quarterDigest\\.test\\.ts`));
    // npm run check（手元のすべての確かめ）も同じ物を動かす
    expect((pkg.scripts as Record<string, string>).check).toContain("npm run test:tz");
  });

  it("遅いテストの仕事は npm run test:slow を動かし、落ちても通ったことにしない（continue-on-error が無い）", async () => {
    const fs = await nodeFs();
    const yml = new TextDecoder().decode(fs.readFileSync(new URL("../../../.github/workflows/4d-branch.yml", import.meta.url)));
    const slow = jobsOf(yml).get("slow")!;
    expect(runsOf(slow)).toContain("npm run test:slow");
    expect(yml).not.toMatch(/continue-on-error/);
  });
});
