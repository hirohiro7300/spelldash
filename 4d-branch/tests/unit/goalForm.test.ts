// 資産のゴールの前提の欄（src/model/goalForm.ts。画面は src/ui/goalPanel.ts）: 欄の言葉・入れた文字の読み方・範囲の外の知らせ・
// 文書に書く形（入れた欄だけ）・見出しの 1 行。数はどれも丸めた仮の数

import { describe, expect, it } from "vitest";
import { spacingIssues } from "../../scripts/impact/textChecks";
import { spaceJa } from "../../src/demo/compose/text";
import { DEFAULT_GOAL, goalAnchor, goalConfigOf, GOAL_KEYS, type GoalKey } from "../../src/model/goal";
import { goalEditorStale, goalFieldPlaceholder, goalFields, goalFieldValue, goalFromInputs, goalViewRow, parseGoalField, sameGoal } from "../../src/model/goalForm";

const ANCHOR = goalAnchor("2026-11");
const fields = goalFields(ANCHOR);
const field = (k: GoalKey) => fields.find((f) => f.key === k)!;

function spaced(s: string): void {
  expect(spaceJa(s), s).toBe(s);
  expect(spacingIssues(s), s).toEqual([]);
}

describe("欄", () => {
  it("6 つの欄が設計の順・名前・単位で並び、期限の範囲は地図の年月から（2030〜2106 年）", () => {
    expect(fields.map((f) => f.key)).toEqual([...GOAL_KEYS]);
    expect(fields.map((f) => f.label)).toEqual(["目標の資産", "今の資産（預金・投資の合計）", "積み立てに回す割合", "運用の利回り", "3 年後からの事業の伸び", "期限"]);
    expect(field("target").unit).toBe("億円");
    expect(field("target").hint).toBe("0.1〜1,000 億円");
    expect(field("assets").hint).toContain("あなたの地図の保存先（年収と同じ）にだけ残り、画像や共有リンクには入りません");
    expect(field("assets").hint).not.toContain("この端末にだけ");
    expect(field("ret").hint).toBe("0〜15%。ふつうは 3〜5%");
    expect(field("bizGrow").hint).toContain("−10〜60%");
    expect(field("by").hint).toBe("2030〜2106 年（地図が 3 年分のため、2029 年より先）");
    for (const f of fields) {
      spaced(f.label);
      spaced(f.hint);
    }
  });

  it("入れていない欄は空で、仮の値は薄い字（目標 10・今の資産 0・積立 20・利回り 3・伸び 0・期限 2056）", () => {
    const { cfg, assumed } = goalConfigOf(null);
    for (const f of fields) expect(goalFieldValue(f, cfg, assumed, ANCHOR)).toBe("");
    expect(fields.map((f) => goalFieldPlaceholder(f, ANCHOR))).toEqual(["10", "0", "20", "3", "0", "2056"]);
    const r = goalConfigOf({ meta: { goal: { v: 1, target: 30_000, assets: 500, by: 2050 } } });
    expect(goalFieldValue(field("target"), r.cfg, r.assumed, ANCHOR)).toBe("3");
    expect(goalFieldValue(field("assets"), r.cfg, r.assumed, ANCHOR)).toBe("500");
    expect(goalFieldValue(field("by"), r.cfg, r.assumed, ANCHOR)).toBe("2050");
    expect(goalFieldValue(field("save"), r.cfg, r.assumed, ANCHOR)).toBe("");
  });
});

describe("入れた文字を読む", () => {
  it("全角・カンマ・単位・マイナスの記号を許し、目標は億円から万円に直す。空は仮", () => {
    expect(parseGoalField(field("target"), "１０")).toEqual({ ok: true, value: 100_000 });
    expect(parseGoalField(field("target"), "0.5 億円")).toEqual({ ok: true, value: 5_000 });
    expect(parseGoalField(field("assets"), "1,000万円")).toEqual({ ok: true, value: 1_000 });
    expect(parseGoalField(field("save"), "25%")).toEqual({ ok: true, value: 25 });
    expect(parseGoalField(field("bizGrow"), "−5")).toEqual({ ok: true, value: -5 });
    expect(parseGoalField(field("bizGrow"), "－5")).toEqual({ ok: true, value: -5 });
    expect(parseGoalField(field("by"), "2050年")).toEqual({ ok: true, value: 2050 });
    expect(parseGoalField(field("assets"), "  ")).toEqual({ ok: true, value: null });
  });

  it("範囲の外・数でない物は直さずに知らせる（黙って収めない）", () => {
    const bad = (k: GoalKey, s: string): string => {
      const r = parseGoalField(field(k), s);
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.error;
    };
    expect(bad("target", "0.05")).toBe("目標の資産は 0.1〜1,000 億円の間で入れてください");
    expect(bad("save", "120")).toBe("積み立てに回す割合は 0〜100%の間で入れてください");
    expect(bad("ret", "abc")).toBe("運用の利回りは数で入れてください");
    expect(bad("bizGrow", "-20")).toBe("3 年後からの事業の伸びは −10〜60%の間で入れてください");
    expect(bad("by", "2029")).toBe("期限は 2030〜2106 年の間で入れてください（地図が 3 年分のため、2029 年より先）");
    expect(bad("by", "2040.5")).toBe("期限は年（整数）で入れてください");
    for (const [k, s] of [
      ["target", "0.05"],
      ["assets", "-1"],
      ["by", "2029"],
      ["by", "2040.5"],
      ["ret", "x"],
    ] as const)
      spaced(bad(k, s));
  });

  it("文書に書く形は入れた欄だけ。どの欄も空なら null（meta.goal を書かない）。読めない欄があればその欄", () => {
    expect(goalFromInputs(fields, { assets: "500", save: "25", ret: "4" })).toEqual({ ok: true, stored: { v: 1, assets: 500, save: 25, ret: 4 } });
    expect(goalFromInputs(fields, {})).toEqual({ ok: true, stored: null });
    expect(goalFromInputs(fields, { assets: "", by: "" })).toEqual({ ok: true, stored: null });
    const r = goalFromInputs(fields, { assets: "500", ret: "40" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.key).toBe("ret");
    // 書いた形は読み直すと同じ値（仮は入れなかった欄だけ）
    const w = goalFromInputs(fields, { target: "3", assets: "1000", by: "2050" });
    expect(w.ok).toBe(true);
    if (w.ok) {
      const back = goalConfigOf({ meta: { goal: w.stored } });
      expect(back.cfg).toEqual({ ...DEFAULT_GOAL, target: 30_000, assets: 1_000, by: 2050 });
      expect([...back.assumed].sort()).toEqual(["bizGrow", "ret", "save"]);
    }
  });

  it("同じ中身かは鍵の順・知らない鍵によらない", () => {
    expect(sameGoal({ ret: 4, v: 1, assets: 500 }, { v: 1, assets: 500, ret: 4 })).toBe(true);
    expect(sameGoal({ v: 1, assets: 500, x: 1 }, { v: 1, assets: 500 })).toBe(true);
    expect(sameGoal(undefined, null)).toBe(true);
    expect(sameGoal({ v: 1 }, null)).toBe(true);
    expect(sameGoal({ v: 1, assets: 500 }, null)).toBe(false);
    expect(sameGoal({ v: 1, assets: 500 }, { v: 1, assets: 1000 })).toBe(false);
  });
});

describe("見出しの 1 行", () => {
  it("「資産 10 億円・2056 年まで（前提 5 つは仮）」。入れるたびに仮の数が減り、全部入れれば仮は出ない", () => {
    const d = goalConfigOf(null);
    expect(goalViewRow(d.cfg, d.assumed, ANCHOR)).toEqual({ name: "資産 10 億円", by: "・2056 年まで", kari: "（前提 5 つは仮）" });
    const r = goalConfigOf({ meta: { goal: { v: 1, assets: 500, save: 25 } } });
    expect(goalViewRow(r.cfg, r.assumed, ANCHOR).kari).toBe("（前提 3 つは仮）");
    const all = goalConfigOf({ meta: { goal: { v: 1, assets: 500, save: 25, ret: 4, bizGrow: 0, by: 2050 } } });
    expect(goalViewRow(all.cfg, all.assumed, ANCHOR)).toEqual({ name: "資産 10 億円", by: "・2050 年まで", kari: null });
    const row = goalViewRow(d.cfg, d.assumed, ANCHOR);
    spaced(`ゴールは${row.name}${row.by}${row.kari}`);
  });
});

describe("閲覧のみの切り替え", () => {
  it("開いている欄は、閲覧のみになったときも、書けるようになったときも作り直す（閉じていれば作り直さない）", () => {
    // 閲覧のみで開いた欄: 書けるようになったら作り直す（止めた欄のままにしない）
    expect(goalEditorStale(true, true, false)).toBe(true);
    // 書けるときに開いた欄: 閲覧のみになったら作り直す
    expect(goalEditorStale(true, false, true)).toBe(true);
    // 変わっていなければ作り直さない（入れかけの文字をそのままに）
    expect(goalEditorStale(true, true, true)).toBe(false);
    expect(goalEditorStale(true, false, false)).toBe(false);
    // 閉じている欄は開くときに作る
    expect(goalEditorStale(false, true, false)).toBe(false);
  });
});
