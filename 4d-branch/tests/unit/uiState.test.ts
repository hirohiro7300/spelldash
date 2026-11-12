import { afterEach, describe, expect, it, vi } from "vitest";
import { UiState } from "../../src/app/uiState";

/** このブラウザの localStorage の代わり（タブどうしで共有する 1 つ） */
function fakeStorage(): Map<string, string> {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  });
  return mem;
}

describe("表示の設定", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("「未来の道筋を開いた」は、設定をまるごと書く古いタブ・前の版のタブに消されない（一度立てたら戻らない）", () => {
    const mem = fakeStorage();
    // 開く前から開いていたタブ（futureAutoOpened: false を持ったまま）
    const stale = new UiState();
    const a = new UiState();
    a.setPrefs({ futureAutoOpened: true });
    a.flushPrefs();
    // 古いタブが表示を変えると、設定をまるごと書き直す（false で上書き）
    stale.setPrefs({ leftOpen: false });
    stale.flushPrefs();
    expect(JSON.parse(mem.get("4d-branch:prefs")!).futureAutoOpened).toBe(false);
    // それでも、開き直したとき・ほかのタブが読み直したときは「開いた」のまま
    expect(new UiState().prefs.futureAutoOpened).toBe(true);
    expect(stale.storedPrefs().futureAutoOpened).toBe(true);
    // 前の版のタブ（この設定を知らない）が書いても
    mem.set("4d-branch:prefs", JSON.stringify({ leftOpen: true }));
    expect(new UiState().prefs.futureAutoOpened).toBe(true);
    // 設定が壊れていても
    mem.set("4d-branch:prefs", "{");
    expect(new UiState().prefs.futureAutoOpened).toBe(true);
    // ほかの設定はそのまま読める
    mem.set("4d-branch:prefs", JSON.stringify({ leftOpen: false }));
    expect(new UiState().prefs.leftOpen).toBe(false);
  });

  it("開いていなければ立たない（設定が無い・ほかの設定だけ）", () => {
    const mem = fakeStorage();
    expect(new UiState().prefs.futureAutoOpened).toBe(false);
    mem.set("4d-branch:prefs", JSON.stringify({ leftOpen: false, futureAutoOpened: false }));
    const ui = new UiState();
    expect(ui.prefs.futureAutoOpened).toBe(false);
    expect(ui.storedPrefs().futureAutoOpened).toBe(false);
    ui.setPrefs({ rightOpen: false });
    ui.flushPrefs();
    expect(mem.has("4d-branch:futureAutoOpened")).toBe(false);
  });
});
