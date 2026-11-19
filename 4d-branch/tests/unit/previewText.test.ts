// 試し版（src/preview）の地図の読み手（load.ts）と文章の作り手（composeText.ts）の確かめ（DOM を使わない。小さい木 tests/fixtures/q-small.*）
// 確かめること: 同梱データ（impact-bundle-gzip）を W-gen の読み手で読む（DecompressionStream が無くても）・開発用の木も読める・
// 壊れたデータは訳のある LoadError・文章の作り手は作るだけでは組み立てず、仮の印が無く、composeCard / composeCont と同じ文章・
// 覚えは地図ごと・年収ごと（新しい 4 つまで）

import { describe, expect, it } from "vitest";
import { fallbackText } from "../../src/deepmap/core";
import type { MapData } from "../../src/deepmap/mapData";
import { composeCard, composeCont } from "../../src/demo/compose";
import { composedText, composeStats } from "../../src/preview/composeText";
import { base64ToBytes, BUNDLE_GZIP, DEV_TREE_GZIP, LoadError, loadMap, readEmbedded } from "../../src/preview/load";
import { setTextFactory, textSourceFor } from "../../src/preview/textSource";
import { gunzipStream, gzipStream, loadQSmall, nodeFs, Q_SMALL_B64, Q_SMALL_DEVTREE_URL } from "./helpers/qSmall";

/** ページの埋め込み（<script id="deepmap-data" data-format=…>）の代わり */
function fakeDoc(format: string, text: string): Document {
  const el = { textContent: text, getAttribute: (n: string) => (n === "data-format" ? format : n === "data-name" ? "q-small" : null) };
  return { getElementById: (id: string) => (id === "deepmap-data" ? el : null) } as unknown as Document;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 地図の問い合わせの数を数える包み（文章の作り手を作るだけで地図を読むか） */
function counting(map: MapData): { map: MapData; calls: () => number } {
  let n = 0;
  const p = new Proxy(map, {
    get(t, k) {
      const v = Reflect.get(t, k) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        n++;
        return (v as (...xs: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { map: p, calls: () => n };
}

/** 役割ごとに 1 枚（今日・手・状態・行き先・まとめた行き先） */
function samples(map: MapData): number[] {
  const out = [0];
  const want = new Set(["a", "s", "e", "sum"]);
  for (let i = 1; i < map.n && want.size; i++) {
    const r = map.sum(i) ? "sum" : map.role(i);
    if (want.delete(r)) out.push(i);
  }
  return out;
}

async function expectLoadError(p: Promise<unknown>, kind: LoadError["kind"], words: RegExp): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(LoadError);
  expect((e as LoadError).kind).toBe(kind);
  expect((e as LoadError).message).toMatch(words);
}

describe("試し版の地図の読み手（load.ts）", () => {
  it("同梱データ（impact-bundle-gzip）は W-gen の読み手で読む: decodeBundle と同じ地図", async () => {
    const ref = await loadQSmall();
    const src = readEmbedded(fakeDoc(BUNDLE_GZIP, Q_SMALL_B64));
    expect(src.format).toBe(BUNDLE_GZIP);
    const map = await loadMap(src);
    expect(map.n).toBe(ref.n);
    expect(map.header).toEqual(ref.header);
    expect(map.header.textVersion).not.toBe("");
    for (let i = 0; i < map.n; i += 61) expect([map.key(i), map.role(i), map.title(i), map.short(i), map.todo(i), map.q(i)]).toEqual([ref.key(i), ref.role(i), ref.title(i), ref.short(i), ref.todo(i), ref.q(i)]);
  });

  it("DecompressionStream の無いブラウザでも、同梱データは小さな伸長で読む", async () => {
    const ref = await loadQSmall();
    const g = globalThis as { DecompressionStream?: unknown };
    const saved = g.DecompressionStream;
    try {
      g.DecompressionStream = undefined;
      expect(typeof DecompressionStream).toBe("undefined");
      const map = await loadMap(readEmbedded(fakeDoc(BUNDLE_GZIP, Q_SMALL_B64)));
      expect([map.n, map.header.hash, map.key(map.n - 1)]).toEqual([ref.n, ref.header.hash, ref.key(ref.n - 1)]);
      // 開発用の木は DecompressionStream が要る（訳を出して止まる）
      const fs = await nodeFs();
      await expectLoadError(loadMap(readEmbedded(fakeDoc(DEV_TREE_GZIP, toBase64(fs.readFileSync(Q_SMALL_DEVTREE_URL))))), "unsupported", /圧縮したデータを開けない/);
    } finally {
      g.DecompressionStream = saved;
    }
  });

  it("開発用の入れ子の木（devtree-json-gzip）も読める: 同じ木の同梱データと同じ鍵・題・やること", async () => {
    const ref = await loadQSmall();
    const fs = await nodeFs();
    const map = await loadMap(readEmbedded(fakeDoc(DEV_TREE_GZIP, toBase64(fs.readFileSync(Q_SMALL_DEVTREE_URL)))));
    expect(map.n).toBe(ref.n);
    for (let i = 0; i < map.n; i += 61) expect([map.key(i), map.title(i), map.todo(i)]).toEqual([ref.key(i), ref.title(i), ref.todo(i)]);
  });

  it("壊れたデータ・違う形・知らない形の名前は、訳のある LoadError（黙って読まない）", async () => {
    const raw = await gunzipStream(base64ToBytes(Q_SMALL_B64));
    const load = (format: string, bytes: Uint8Array) => loadMap({ format, name: "x", bytes });
    // gzip でない
    await expectLoadError(load(BUNDLE_GZIP, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), "decode", /圧縮をほどけなかった/);
    // gzip だが同梱データでない
    await expectLoadError(load(BUNDLE_GZIP, await gzipStream(new TextEncoder().encode('{"header":{}}'))), "format", /読める形と違う.*同梱データではありません/);
    // 途中で切れた同梱データ
    await expectLoadError(load(BUNDLE_GZIP, await gzipStream(raw.subarray(0, Math.floor(raw.length / 2)))), "decode", /壊れていて開けない/);
    // 知らない形の名前
    await expectLoadError(load("impact-bundle-zstd", base64ToBytes(Q_SMALL_B64)), "format", /読めない形/);
    // 埋め込みが無い
    expect(() => readEmbedded(fakeDoc(BUNDLE_GZIP, "  "))).toThrow(LoadError);
  });
});

describe("試し版の文章の作り手（composeText.ts）", () => {
  it("作るだけでは組み立てない（地図を読まない）。仮の印は無く、文章は composeCard と同じ。題は焼き込んだ題と同じ", async () => {
    const ref = await loadQSmall();
    const c = counting(ref);
    const before = composeStats.cards;
    const text = composedText(c.map, 360);
    expect(c.calls()).toBe(0);
    expect(composeStats.cards).toBe(before);
    expect(text.provisional).toBeFalsy();
    for (const i of samples(ref)) {
      const card = composeCard(ref, i, { annual: 360 });
      expect([i, text.title(i), text.short(i), text.body(i), text.numbers(i)]).toEqual([i, card.title, card.short, card.body, card.numbers]);
      // 生成が焼き込んだ題・やることと同じ（道の画面はやることを地図から出す）
      expect([i, text.title(i)]).toEqual([i, ref.title(i)]);
      if (ref.role(i) === "a") expect(card.todo).toEqual(ref.todo(i));
    }
    expect(c.calls()).toBeGreaterThan(0);
    expect(composeStats.cards - before).toBe(samples(ref).length);
  });

  it("覚えは地図ごと・年収ごと: 同じ年収はもう組み立てない・年収を戻しても作り直さない・覚える年収は新しい 4 つまで", async () => {
    const map = await loadQSmall();
    const i = map.child(0, 0);
    const n360 = composedText(map, 360).numbers(i);
    const before = composeStats.cards;
    expect(composedText(map, 360).numbers(i)).toBe(n360);
    expect(composeStats.cards).toBe(before);
    const n540 = composedText(map, 540).numbers(i);
    expect(n540).not.toBe(n360);
    expect(n540[0]).toContain("年収 540 万円");
    expect(composedText(map, 360).numbers(i)).toBe(n360);
    // 新しく 4 つの年収を使うと、360 は忘れる（同じ文章を作り直す）
    for (const s of [400, 450, 500, 600]) composedText(map, s).numbers(i);
    const again = composedText(map, 360).numbers(i);
    expect(again).not.toBe(n360);
    expect(again).toEqual(n360);
  });

  it("まとめた行き先の後の標準の続きの 1 期は composeCont と同じ（開いたときだけ。同じ物を返す）。まとめた行き先でない・期の外は null", async () => {
    const map = await loadQSmall();
    let end = -1;
    for (let i = 0; i < map.n && end < 0; i++) if (map.role(i) === "e" && map.sum(i) && (map.cont(i)?.length ?? 0) >= 2) end = i;
    expect(end).toBeGreaterThan(0);
    const text = composedText(map, 360);
    const before = composeStats.cont;
    for (const k of [0, 1]) {
      const want = composeCont(map, end, k, { annual: 360 })!;
      const got = text.cont!(end, k)!;
      expect(got).toEqual({ title: want.title, body: want.body, todo: want.todo });
      expect(text.cont!(end, k)).toBe(got);
      expect(got.todo.length).toBeGreaterThanOrEqual(1);
    }
    expect(composeStats.cont - before).toBe(2);
    expect(text.cont!(end, map.cont(end)!.length)).toBeNull();
    expect(text.cont!(map.child(0, 0), 0)).toBeNull();
  });

  it("差し替え口: setTextFactory で入れた作り手を textSourceFor が使う（差し替える前は仮の文章）", async () => {
    const map = await loadQSmall();
    expect(textSourceFor(map, 360).provisional).toBe(true);
    setTextFactory(composedText);
    try {
      const t = textSourceFor(map, 360);
      expect(t.provisional).toBeFalsy();
      expect(typeof t.cont).toBe("function");
      expect(t.body(0)).toBe(composeCard(map, 0, { annual: 360 }).body);
    } finally {
      setTextFactory((m, annual) => fallbackText(m, { annual }));
    }
  });
});
