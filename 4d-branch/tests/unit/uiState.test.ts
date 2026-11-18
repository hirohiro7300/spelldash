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

  it("「未来の道筋」から聞かれた新しい版を断った版は、設定をまるごと書く別のタブに消されない（前の版が設定の中に書いた物も移す）", () => {
    const mem = fakeStorage();
    // 断る前から開いていたタブ（断ったことを知らない）
    const other = new UiState();
    const a = new UiState();
    a.declineFuture("v2");
    a.flushPrefs();
    expect(a.isFutureDeclined("v2")).toBe(true);
    // ほかのタブがカードを開く（見え方の設定をまるごと書き直す。断った版は空のまま）
    other.setImpactOpen("n_root", ["n_root", "n_kid"]);
    other.flushPrefs();
    expect(JSON.parse(mem.get("4d-branch:prefs")!).futureDeclined).toBe("");
    // それでも、開き直したタブ・ほかのタブは断ったと分かる。ほかの版は断っていない
    expect(new UiState().isFutureDeclined("v2")).toBe(true);
    expect(other.isFutureDeclined("v2")).toBe(true);
    expect(new UiState().isFutureDeclined("v3")).toBe(false);
    expect(new UiState().isFutureDeclined("")).toBe(false);
    // 前の版が設定の中に書いた断った版は、開いたときに別の場所へ移す（その後に設定が書き直されても断ったまま）
    mem.clear();
    mem.set("4d-branch:prefs", JSON.stringify({ futureDeclined: "v1" }));
    new UiState();
    mem.set("4d-branch:prefs", JSON.stringify({ leftOpen: false }));
    expect(new UiState().isFutureDeclined("v1")).toBe(true);
    // 移すのは別の場所がまだ無いときだけ（新しく断った版を、前の版の値で戻さない）
    const b = new UiState();
    b.declineFuture("v4");
    b.flushPrefs();
    mem.set("4d-branch:prefs", JSON.stringify({ futureDeclined: "v1" }));
    new UiState();
    expect(mem.get("4d-branch:futureDeclined")).toBe("v4");
    // 断っていなければ別の場所には書かない
    mem.clear();
    const c = new UiState();
    c.setPrefs({ leftOpen: false });
    c.flushPrefs();
    expect(mem.has("4d-branch:futureDeclined")).toBe(false);
  });

  it("保存が使えないブラウザでも、断った版はこのタブの間は覚えている", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    });
    const a = new UiState();
    expect(a.isFutureDeclined("v2")).toBe(false);
    a.declineFuture("v2");
    a.flushPrefs();
    expect(a.isFutureDeclined("v2")).toBe(true);
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
