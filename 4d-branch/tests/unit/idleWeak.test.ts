// 空いた時間に回す仕事が、待つ間に画面に渡す物・計算を持ち続けない（src/app/idle.ts の whenIdleWeak）。
// 前は選び直すたびに「この先の行き先」の 1 文（400 ms 後の空いた時間）・見取り図の帯の埋め直しが、その時の画面に渡す物
// （8 万枚の計算: 1 つ 8 MB ほど）を持って待ち、続けて選ぶと使った後のヒープが机で +24 MB になっていた

import { afterEach, describe, expect, it, vi } from "vitest";
import { whenIdleWeak } from "../../src/app/idle";

/** node の gc（--expose-gc を後から入れて取り出す。テストの worker は node） */
async function gcFn(): Promise<() => void> {
  const v8Name = "node:v8";
  const vmName = "node:vm";
  const v8 = (await import(/* @vite-ignore */ v8Name)) as { setFlagsFromString(s: string): void };
  const vmMod = (await import(/* @vite-ignore */ vmName)) as { runInNewContext(code: string): unknown };
  v8.setFlagsFromString("--expose-gc");
  return vmMod.runInNewContext("gc") as () => void;
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whenIdleWeak", () => {
  it("持っている物は、ms 後の空いた時間に引数で渡す（空いた時間の呼び出しが無い環境では次の番に）", async () => {
    const target = { n: 1 };
    const seen: Array<{ n: number }> = [];
    whenIdleWeak(target, (t) => seen.push(t), { ms: 20 });
    await tick(5);
    expect(seen).toEqual([]);
    await tick(40);
    expect(seen).toEqual([target]);
  });

  it("空いた時間の呼び出しには timeout を渡す（ms が 0 ならすぐに頼む）", () => {
    const calls: Array<{ timeout: number } | undefined> = [];
    vi.stubGlobal("requestIdleCallback", (_cb: unknown, o?: { timeout: number }) => (calls.push(o), 1));
    whenIdleWeak({}, () => undefined, { timeout: 2000 });
    expect(calls).toEqual([{ timeout: 2000 }]);
  });

  it("待つ間は弱く持つ: ほかで手放された物は集められ、呼ばない", async () => {
    const gc = await gcFn();
    let called = 0;
    const big = (): WeakRef<object> => {
      // 大きな型付き配列を持つ物（計算の代わり）
      const target = { arr: new Float64Array(1 << 20) };
      whenIdleWeak(target, () => called++, { ms: 200 });
      return new WeakRef(target);
    };
    const ref = big();
    await tick(0);
    gc();
    expect(ref.deref()).toBeUndefined();
    await tick(260);
    expect(called).toBe(0);
  });
});
