// 資産のゴールの前提（入口の meta.goal: 今の資産は文書の中で一番人に見せたくない数）を、利用者の保存先の外に出さない。
// - 試験データ（tests/fixtures）と同梱の地図（src/demo の *.json・*.b64）に goal の鍵が無い（仮の値も利用者の数も入れない）
// - 組み立てた地図の入口に goal が無い（入れていない前提は書かない。読むと 6 つとも仮）
// - カードの複製（写し）は前提を写さない
// - ページに画像の書き出しと共有リンク（navigator.share）は無い。足すときは meta.goal を外すこと（このテストが知らせる）
//   書き出す JSON（バックアップ）は利用者の保存先の写しなので、前提を残す（取り込み直すと戻る）
// 数はどれも丸めた仮の数

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Commands } from "../../src/app/commands";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import type { MapData } from "../../src/deepmap/mapData";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { DEFAULT_GOAL } from "../../src/model/goal";
import { goalConfigOf } from "../../src/model/forks";
import type { DocData, GNode } from "../../src/model/types";
import { setThinBaseline, thinBaselineDoc } from "../../src/persist/codec";
import { exportText, previewImport } from "../../src/persist/io";
import { Store } from "../../src/store/store";
import { gunzipStream, loadQSmall } from "./helpers/qSmall";
import { buildR6Future } from "./helpers/r6";

interface Fs {
  readFileSync(p: string | URL): Uint8Array;
  readdirSync(p: string | URL): string[];
}
async function fsOf(): Promise<Fs> {
  const name = "node:fs";
  return (await import(/* @vite-ignore */ name)) as Fs;
}

const GOAL = { v: 1, assets: 500, save: 25, ret: 4 };
const GOAL_KEY = /"goal"\s*:/;

/** ファイルの中身を文字列に（gzip は伸ばす。base64 の gzip も） */
async function textOf(name: string, bytes: Uint8Array): Promise<string> {
  const isGz = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
  if (isGz(bytes)) return new TextDecoder("latin1").decode(await gunzipStream(bytes));
  const text = new TextDecoder().decode(bytes);
  if (name.endsWith(".b64") && text.trim()) {
    const raw = Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
    return new TextDecoder("latin1").decode(isGz(raw) ? await gunzipStream(raw) : raw);
  }
  return text;
}

async function scanDir(url: URL, pick: (name: string) => boolean): Promise<Array<{ name: string; text: string }>> {
  const fs = await fsOf();
  const out: Array<{ name: string; text: string }> = [];
  for (const name of fs.readdirSync(url).filter(pick).sort()) out.push({ name, text: await textOf(name, fs.readFileSync(new URL(name, url))) });
  return out;
}

const rootOf = (d: DocData): GNode => Object.values(d.nodes).find((n) => n.meta?.forecastRoot === true)!;

let q: MapData;
beforeAll(async () => {
  q = await loadQSmall();
});
afterEach(() => setThinBaseline(null));

describe("試験データと同梱の地図に、資産のゴールの前提は入っていない", () => {
  it("tests/fixtures のどのファイル（gzip・base64 も伸ばして）にも goal の鍵が無い", async () => {
    const files = await scanDir(new URL("../fixtures/", import.meta.url), () => true);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) expect(GOAL_KEY.test(f.text), f.name).toBe(false);
  });

  it("同梱の地図（src/demo の *.json・*.b64。ページの 3 か月ごとの地図も）にも goal の鍵が無い", async () => {
    const files = await scanDir(new URL("../../src/demo/", import.meta.url), (n) => n.endsWith(".json") || n.endsWith(".b64"));
    expect(files.some((f) => f.name === "impact-q.b64")).toBe(true);
    for (const f of files) expect(GOAL_KEY.test(f.text), f.name).toBe(false);
  });

  it("組み立てた地図の入口（3 か月ごとの地図・保存の基準・版 6）に goal は無く、読むと 6 つとも仮の値（今の資産は 0）", () => {
    setThinBaseline(q);
    const roots = [
      rootOf(buildQuarterDoc(q, { version: q.header.hash, release: q.header.release, at: Date.UTC(2026, 10, 1) })),
      rootOf(thinBaselineDoc()),
      rootOf(buildR6Future(new Date(2026, 10, 18)).pv.doc),
    ];
    for (const r of roots) {
      expect("goal" in r.meta).toBe(false);
      const g = goalConfigOf(r);
      expect(g.cfg).toEqual(DEFAULT_GOAL);
      expect(g.assumed.size).toBe(6);
    }
    expect(DEFAULT_GOAL.assets).toBe(0);
  });
});

describe("前提を外に出す道", () => {
  it("今日のカードを複製しても、写しに前提は入らない", () => {
    const d0 = buildR6Future(new Date(2026, 10, 18)).pv.doc;
    const r = rootOf(d0);
    const store = new Store({ ...d0, nodes: { ...d0.nodes, [r.id]: { ...r, meta: { ...r.meta, goal: GOAL } } } });
    const ui = new UiState(structuredClone(DEFAULT_PREFS));
    ui.persistPrefs = false;
    const vm = new ViewModel(store, ui);
    vm.narrow = () => false;
    const cmd = new Commands(store, ui, vm, { toast: () => undefined, viewCenter: () => ({ x: 0, y: 0 }), startEdit: () => undefined, reveal: () => undefined, confirm: async () => true });
    const [copy] = cmd.duplicate([r.id]);
    expect(copy).toBeDefined();
    expect("goal" in store.doc.nodes[copy!]!.meta).toBe(false);
    expect(store.doc.nodes[r.id]!.meta.goal).toEqual(GOAL);
  });

  it("ページに画像の書き出し・共有リンクは無い（足すなら meta.goal を外す道を作ってから、ここを直す）", () => {
    const files = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(50);
    const ways = /\b(toDataURL|toBlob|convertToBlob|canShare)\s*\(|navigator\.share\b/;
    const hits = Object.entries(files).filter(([, src]) => ways.test(src)).map(([p]) => p);
    expect(hits).toEqual([]);
  });

  it("書き出す JSON（利用者のバックアップ）は前提を残し、取り込み直すと同じ前提に戻る", () => {
    const d0 = buildR6Future(new Date(2026, 10, 18)).pv.doc;
    const r = rootOf(d0);
    const doc: DocData = { ...d0, nodes: { ...d0.nodes, [r.id]: { ...r, meta: { ...r.meta, goal: GOAL } } } };
    const back = previewImport(exportText(doc, "test")).doc;
    expect(rootOf(back).meta.goal).toEqual(GOAL);
  });
});
