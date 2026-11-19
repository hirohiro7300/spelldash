// 変更・選択のたびに走る所で、文書のノード・線を全部なめない（作業メモ SPEC v1 §7.1 の 6・見直し perf-4・gaps-8）。
// src/app・src/ui・src/canvas の中の、doc.nodes・doc.edges への for…in・Object.keys・Object.values・Object.entries を探し、
// 認めた所（変更のたびではなく、取り込み・入れ替え・ダイアログを開いたときに 1 回だけの所）のほかに無いことを確かめる。
// 認めるには、その行か 1 つ上の行に「全体を見てよい: 訳」と書く（自分のファイル）。ほかの組の持ち物のファイルは下の一覧で認める
import { describe, expect, it } from "vitest";

const files = import.meta.glob(["../../src/app/**/*.ts", "../../src/ui/**/*.ts", "../../src/canvas/**/*.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** 文書のノード・線を全部なめる書き方 */
const SCAN = /for \(const [A-Za-z_$][\w$]* in [\w$.!?]*\.(nodes|edges)\)|Object\.(keys|values|entries)\([\w$.!?]*\.(nodes|edges)\)/;
const MARK = /全体を見てよい: \S/;

/** ほかの組の持ち物で、変更のたびではない所（ファイル → その行に含まれる文字） */
const OTHERS: Record<string, string[]> = {
  // 保存の組（W-store）の持ち物: バックアップ・同期の確かめのダイアログを開いたときに 1 回
  "../../src/ui/dialogs.ts": ['card("このブラウザ", o.local.title, Object.keys(o.local.nodes).length', "ノード ${Object.keys(local.nodes).length} 件"],
};

/** 認めた所の数の上限（増やすときは、変更のたびの道ではないことを確かめてから） */
const MAX_ALLOWED = 8;

describe("変更のたびに文書を全部なめない", () => {
  it("src/app・src/ui・src/canvas の doc.nodes・doc.edges の全部なめは、認めた所だけ", () => {
    expect(Object.keys(files).length).toBeGreaterThan(20);
    const bad: string[] = [];
    let allowed = 0;
    for (const [path, text] of Object.entries(files)) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (!SCAN.test(line)) return;
        const marked = MARK.test(line) || MARK.test(lines[i - 1] ?? "");
        const other = (OTHERS[path] ?? []).some((s) => line.includes(s));
        if (marked || other) allowed++;
        else bad.push(`${path.replace("../../", "")}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, "変更のたびの道で文書を全部なめている所（索引の数・版で覚えた物を使う）").toEqual([]);
    expect(allowed).toBeLessThanOrEqual(MAX_ALLOWED);
  });

  it("探し方そのものが当たる（書き方の確かめ）", () => {
    for (const s of ["for (const id in doc.nodes) {", "for (const id in this.store.doc.edges) x;", "Object.keys(doc.nodes).length", "Object.values(app.store.doc.nodes).some(", "Object.entries(d.edges)"]) expect(SCAN.test(s), s).toBe(true);
    for (const s of ["for (const id of idx.out.keys())", "Object.values(doc.projects)", "for (const id of vm.drawNodes)"]) expect(SCAN.test(s), s).toBe(false);
  });
});
