// ページに入れた地図の版の記録（src/demo/pageBundle.ts の PAGE_Q_RELEASE。作業メモ SPEC §3.1・§6、見直し code-2）。
// 記録の基準の文書の指紋（digest）があれば、起動で数え直さずに使う（main.ts → enableThinPage）。その値が、ページの地図から数えた値と
// 同じか（組み立てを変えたのに記録を作り直していない・別の地図の記録を入れた、をここで見つける: 起動で薄い形の記録が全部止まる前に）。
// 既定のビルドは src/demo/impact-q-release.json（版 7）。生成の候補は IMPACT_Q_RELEASE で入れる（VITE_IMPACT_Q=1 IMPACT_Q_BUNDLE=… IMPACT_Q_RELEASE=<impact-release.json>）。
// VITE_IMPACT_Q=0 のビルドは記録も地図も無い
import { describe, expect, it } from "vitest";
import { mapBaselineDigest } from "../../src/demo/impactDigest";
import { loadPageMap, PAGE_Q, PAGE_Q_RELEASE } from "../../src/demo/pageBundle";
import { enableThinPage, ensurePageMap, setThinBaseline, thinBaseline } from "../../src/persist/codec";

describe("ページの地図の版の記録", () => {
  it("地図を入れないビルド（VITE_IMPACT_Q=0）: 地図も記録も無い", () => {
    if (PAGE_Q) return;
    expect(PAGE_Q_RELEASE).toBeNull();
  });

  it.skipIf(!PAGE_Q || !PAGE_Q_RELEASE)(
    "記録の版の順番・中身の指紋・年月は、ページの地図の入口と同じ。基準の文書の指紋は、ページの地図から数えた値と同じ",
    async () => {
      const map = (await loadPageMap())!;
      const rec = PAGE_Q_RELEASE!;
      expect({ release: rec.release, hash: rec.hash, anchor: rec.anchor }).toEqual({ release: map.header.release, hash: map.header.hash, anchor: map.header.anchor });
      if (!rec.digest) {
        console.warn("版の記録に基準の文書の指紋（digest）がありません。起動で数え直します（生成の --record で作り直してください）");
        return;
      }
      expect(mapBaselineDigest(map)).toBe(rec.digest);
      // 起動と同じ入れ方: 指紋は記録の物（数え直さない）
      enableThinPage(loadPageMap, { digest: rec.digest });
      try {
        expect(await ensurePageMap()).toBe(true);
        expect(thinBaseline()!.digest).toBe(rec.digest);
      } finally {
        enableThinPage(null);
        setThinBaseline(null);
      }
    },
    600_000,
  );
});
