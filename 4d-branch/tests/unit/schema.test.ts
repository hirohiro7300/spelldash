import { describe, expect, it } from "vitest";
import { normalizeDateStr } from "../../src/model/dates";
import { DocFormatError, SCHEMA_VERSION, createEmptyDoc, makeEdge, makeNode, makeProject, normalizeDoc, parseDocText, serializeDoc } from "../../src/model/schema";

describe("normalizeDoc", () => {
  it("書き出した JSON をそのまま読み戻せる（往復で変わらない）", () => {
    const doc = createEmptyDoc("テスト");
    const p = makeProject({ name: "A" });
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
    const a = makeNode({ title: "行動A", projectIds: [p.id], tags: ["スキル"], time: { due: "2027-03-31", start: null } });
    const b = makeNode({ title: "目標B", type: "goal" });
    doc.nodes[a.id] = a;
    doc.nodes[b.id] = b;
    const e = makeEdge({ source: a.id, target: b.id, relation: "supports", condition: "月10時間" });
    doc.edges[e.id] = e;
    const { doc: back, report } = parseDocText(serializeDoc(doc, "0.0.0"));
    expect(report.warnings).toEqual([]);
    expect(back).toEqual(doc);
    expect("exportedAt" in back).toBe(false);
  });

  it("知らない項目は消さずに持ち越す（新しい版のファイルを古い版で開いても欠けない）", () => {
    const { doc } = normalizeDoc({
      schema: "4d-branch",
      version: 1,
      futureTop: { a: 1 },
      nodes: { n1: { id: "n1", type: "goal", title: "x", x: 0, y: 0, aiScore: 0.8, time: { due: "2027-01-01", range: [1, 2] } } },
      edges: {},
    });
    expect((doc as unknown as Record<string, unknown>).futureTop).toEqual({ a: 1 });
    expect((doc.nodes.n1 as unknown as Record<string, unknown>).aiScore).toBe(0.8);
    expect((doc.nodes.n1!.time as unknown as Record<string, unknown>).range).toEqual([1, 2]);
  });

  it("壊れた要素は捨てて警告し、残りは読む", () => {
    const { doc, report } = normalizeDoc({
      schema: "4d-branch",
      version: 1,
      projects: [{ id: "p1", name: "P", color: "red" }],
      nodes: [
        { id: "a", type: "weird", title: "A", x: 0, y: 0, projectIds: ["p1", "nope"], tags: ["#タグ", "タグ", " ", 3] },
        { id: "b", title: "B" },
        "garbage",
        { id: "a", title: "dup" },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "b" },
        { source: "a", target: "a" },
        { source: "a", target: "zzz" },
      ],
    });
    expect(Object.keys(doc.nodes)).toEqual(["a", "b"]);
    expect(doc.nodes.a!.type).toBe("action");
    expect(doc.nodes.a!.projectIds).toEqual(["p1"]);
    expect(doc.nodes.a!.tags).toEqual(["タグ"]);
    expect(doc.projects.p1!.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(Object.keys(doc.edges)).toHaveLength(1);
    expect(report.warnings.length).toBeGreaterThan(3);
    // 位置の無いノードは並べる
    expect(Number.isFinite(doc.nodes.b!.x)).toBe(true);
  });

  it("循環（A→B→A）は捨てない", () => {
    const { doc } = normalizeDoc({ schema: "4d-branch", nodes: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 0 }], edges: [{ source: "a", target: "b" }, { source: "b", target: "a" }] });
    expect(Object.keys(doc.edges)).toHaveLength(2);
  });

  it("新しすぎる版・別の形式は読まない", () => {
    expect(() => normalizeDoc({ schema: "4d-branch", version: SCHEMA_VERSION + 1, nodes: {} })).toThrow(DocFormatError);
    expect(() => normalizeDoc({ schema: "other", nodes: {} })).toThrow(DocFormatError);
    expect(() => parseDocText("{not json")).toThrow(DocFormatError);
    expect(() => normalizeDoc([1, 2])).toThrow(DocFormatError);
  });

  it("__proto__ を含むファイルでプロトタイプを汚さない", () => {
    const { doc } = parseDocText('{"schema":"4d-branch","nodes":{"__proto__":{"polluted":true},"n1":{"id":"n1","x":0,"y":0,"__proto__":{"bad":1}}},"edges":{}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(doc.nodes)).toEqual(["n1"]);
    expect(Object.getPrototypeOf(doc.nodes.n1)).toBe(Object.prototype);
  });
});

describe("dates", () => {
  it("いろいろな書き方をそろえる", () => {
    expect(normalizeDateStr("2027/3/1")).toBe("2027-03-01");
    expect(normalizeDateStr("2027年3月31日")).toBe("2027-03-31");
    expect(normalizeDateStr("２０２７-０３-３１")).toBe("2027-03-31");
    expect(normalizeDateStr("2027-02-30")).toBeNull();
    expect(normalizeDateStr("2027-03-31T10:00:00Z")).toBe("2027-03-31");
    expect(normalizeDateStr("")).toBeNull();
  });
});
