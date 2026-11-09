import { afterEach, describe, expect, it, vi } from "vitest";
import { onPixelRatioChange } from "../../src/canvas/pixelRatio";

/** matchMedia の代わり: 作られたメディアクエリを覚え、change を送れるようにする */
function fakeMatchMedia() {
  const made: Array<{ query: string; fire: () => void }> = [];
  vi.stubGlobal("matchMedia", (query: string) => {
    const t = new EventTarget();
    made.push({ query, fire: () => t.dispatchEvent(new Event("change")) });
    return t;
  });
  return made;
}

describe("画素の細かさの変化（別の画面へ窓を移す）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("今の値の resolution が外れたら知らせ、新しい値でまた見張る", () => {
    vi.stubGlobal("devicePixelRatio", 1);
    const made = fakeMatchMedia();
    let calls = 0;
    onPixelRatioChange(() => calls++);
    expect(made.map((m) => m.query)).toEqual(["(resolution: 1dppx)"]);

    vi.stubGlobal("devicePixelRatio", 2);
    made[0]!.fire();
    expect(calls).toBe(1);
    expect(made.map((m) => m.query)).toEqual(["(resolution: 1dppx)", "(resolution: 2dppx)"]);

    // 前の見張りは 1 回きり（同じ所から二度は知らせない）
    made[0]!.fire();
    expect(calls).toBe(1);

    // 戻したときも知らせる（見張りを付け直している）
    vi.stubGlobal("devicePixelRatio", 1);
    made[1]!.fire();
    expect(calls).toBe(2);
    expect(made.map((m) => m.query).at(-1)).toBe("(resolution: 1dppx)");
  });

  it("matchMedia が無い所（Node など）では何もしない", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(() => onPixelRatioChange(() => undefined)).not.toThrow();
  });
});
