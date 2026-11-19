import { describe, expect, it } from "vitest";
import { addMonths, dayNumber, fromDayNumber, normalizeDateStr } from "../../src/model/dates";
import { buildIndex } from "../../src/model/graph";
import { DocFormatError, NewerDocError, SCHEMA_VERSION, createEmptyDoc, isNewerDocRaw, isNewerVersion, makeEdge, makeNode, makeProject, migrate, normalizeDoc, parseDocText, serializeDoc } from "../../src/model/schema";

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

  it("新しすぎる版は NewerDocError（DocFormatError の一種・文は今までどおり）で、壊れた・別の形式のデータとは分かれる", () => {
    const caught = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return e;
      }
      return null;
    };
    const v = SCHEMA_VERSION + 1;
    // 今の形のままの新しい版・ノードを持たない薄い形・版が小数でも
    for (const raw of [{ schema: "4d-branch", version: v, nodes: {} }, { schema: "4d-branch", version: v, thin: { v: 1 } }, { schema: "4d-branch", version: v + 0.5, nodes: {} }]) {
      const e = caught(() => normalizeDoc(raw));
      expect(e).toBeInstanceOf(NewerDocError);
      expect(e).toBeInstanceOf(DocFormatError);
      expect((e as NewerDocError).version).toBe(v);
      expect((e as Error).message).toBe(`このファイルは新しい版（スキーマ ${v}）の 4D Branch で作られています。アプリを新しくしてから読み込んでください。`);
    }
    expect(caught(() => migrate({ version: v }))).toBeInstanceOf(NewerDocError);
    // 壊れた・別の形式のデータは、今までどおり DocFormatError だけ（新しい版とは見なさない）
    for (const f of [() => normalizeDoc({ schema: "other", version: v, nodes: {} }), () => normalizeDoc({ version: v, title: "nodes の無い物" }), () => normalizeDoc([1, 2]), () => normalizeDoc("文字"), () => normalizeDoc(null), () => parseDocText("{not json")]) {
      const e = caught(f);
      expect(e).toBeInstanceOf(DocFormatError);
      expect(e).not.toBeInstanceOf(NewerDocError);
    }
    // 今の版・版の無い物・数でない版は今の版として読む
    for (const version of [SCHEMA_VERSION, undefined, "2", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeDoc({ schema: "4d-branch", version, nodes: {} }).doc.version).toBe(SCHEMA_VERSION);
    }
    expect([v, v + 0.5, SCHEMA_VERSION, SCHEMA_VERSION + 0.5, "2", undefined, null, Number.NaN, Number.POSITIVE_INFINITY].map(isNewerVersion)).toEqual([true, true, false, false, false, false, false, false, false]);
  });

  it("整えずに見る isNewerDocRaw は、normalizeDoc が NewerDocError を出す物とちょうど同じ物を新しい版と見る", () => {
    const v = SCHEMA_VERSION + 1;
    const inputs: unknown[] = [
      { schema: "4d-branch", version: v, nodes: {} },
      { schema: "4d-branch", version: v, thin: { v: 1 } },
      { schema: "4d-branch", version: v + 0.5 },
      { version: v, nodes: {} },
      { version: v, title: "nodes の無い物" },
      { schema: "other", version: v, nodes: {} },
      { schema: "4d-branch", version: SCHEMA_VERSION, nodes: {} },
      { schema: "4d-branch", version: "2", nodes: {} },
      { schema: "4d-branch", nodes: {} },
      { schema: "4d-branch", version: Number.POSITIVE_INFINITY, nodes: {} },
      [1, 2],
      "文字",
      null,
      undefined,
      42,
    ];
    for (const input of inputs) {
      let newer = false;
      try {
        normalizeDoc(input);
      } catch (e) {
        newer = e instanceof NewerDocError;
      }
      expect(isNewerDocRaw(input), JSON.stringify(input)).toBe(newer);
    }
    expect(inputs.filter(isNewerDocRaw)).toHaveLength(4);
  });

  it("__proto__ を含むファイルでプロトタイプを汚さない", () => {
    const { doc } = parseDocText('{"schema":"4d-branch","nodes":{"__proto__":{"polluted":true},"n1":{"id":"n1","x":0,"y":0,"__proto__":{"bad":1}}},"edges":{}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(doc.nodes)).toEqual(["n1"]);
    expect(Object.getPrototypeOf(doc.nodes.n1)).toBe(Object.prototype);
  });
});

describe("外から作ったファイルの取り込み（AI・表計算・手書き）", () => {
  it("組み込みの名前の ID（constructor・toString・__proto__）でも、ノードも接続も失わず、落ちない", () => {
    const { doc } = parseDocText(
      JSON.stringify({
        schema: "4d-branch",
        projects: [{ id: "toString", name: "本業" }],
        nodes: [
          { id: "a", title: "A", x: 0, y: 0 },
          { id: "constructor", title: "施工会社に相談", x: 0, y: 0, projectIds: ["toString", "hasOwnProperty"] },
          { id: "__proto__", title: "原型", x: 0, y: 0 },
        ],
        edges: [
          { source: "a", target: "constructor" },
          { source: "constructor", target: "__proto__" },
          { source: "a", target: "valueOf" },
        ],
      }),
    );
    const byTitle = (t: string) => Object.values(doc.nodes).find((n) => n.title === t)!;
    expect(Object.keys(doc.nodes)).toHaveLength(3);
    expect(Object.keys(doc.nodes).some((id) => id in Object.prototype)).toBe(false);
    const ends = Object.values(doc.edges).map((e) => `${doc.nodes[e.source]!.title}>${doc.nodes[e.target]!.title}`).sort();
    expect(ends).toEqual(["A>施工会社に相談", "施工会社に相談>原型"]); // 無い先（valueOf）への線だけ捨てる
    expect(Object.keys(doc.projects)).toHaveLength(1);
    expect(byTitle("施工会社に相談").projectIds).toEqual(Object.keys(doc.projects));
    expect(doc.projectOrder).toEqual(Object.keys(doc.projects));
    expect(() => buildIndex(doc)).not.toThrow();
  });

  it("数の ID（1, 2, 3）と from / to の接続をつなぐ。空白入りの ID は振り直して、接続は読み替える", () => {
    const { doc, report } = normalizeDoc({
      nodes: [
        { id: 1, title: "A" },
        { id: 2, title: "B" },
        { id: "goal 1", title: "目標" },
      ],
      edges: [
        { source: 1, target: 2 },
        { from: 2, to: "goal 1" },
      ],
      projects: [{ id: 10, name: "P" }],
    });
    const title = (id: string) => doc.nodes[id]!.title;
    const ends = Object.values(doc.edges).map((e) => `${title(e.source)}>${title(e.target)}`).sort();
    expect(ends).toEqual(["A>B", "B>目標"]);
    expect(doc.nodes["1"]!.title).toBe("A");
    expect(Object.keys(doc.projects)).toEqual(["10"]);
    expect(report.warnings.join()).toContain("新しい ID を振りました（接続はそのままつなぎました）");
    expect(report.warnings.join()).not.toContain("捨てました");
    // from / to は読んだので持ち越さない
    for (const e of Object.values(doc.edges)) expect("from" in e || "to" in e).toBe(false);
  });

  it("条件の知らない項目は持ち越し、チェック済みの条件は文が空でも消さない", () => {
    const { doc } = normalizeDoc({
      schema: "4d-branch",
      nodes: [{ id: "a", x: 0, y: 0, conditions: [{ id: "c1", text: "予算が通る", met: false, weight: 0.7, meta: { by: "ai" } }, { id: "c2", text: "", met: true }, { id: "c3", text: "  " }] }],
      edges: [],
    });
    const conds = doc.nodes.a!.conditions;
    expect(conds).toHaveLength(2);
    expect(conds[0]).toMatchObject({ id: "c1", text: "予算が通る", weight: 0.7, meta: { by: "ai" } });
    expect(conds[1]).toMatchObject({ id: "c2", met: true });
  });

  it("入れ子がとても深い項目（5,000 段）は省き、保存・書き出しできる形にする", () => {
    const deep = `${'{"a":'.repeat(5000)}{"leaf":1}${"}".repeat(5000)}`;
    const text = `{"schema":"4d-branch","nodes":[{"id":"a","title":"A","x":0,"y":0,"meta":${deep},"extra":${deep}}],"edges":[]}`;
    const { doc, report } = parseDocText(text);
    expect(() => JSON.stringify(doc)).not.toThrow();
    expect(() => structuredClone(doc)).not.toThrow();
    expect(report.warnings.join()).toContain("入れ子が深すぎる");
    expect(doc.nodes.a!.title).toBe("A");
  });

  it("とても遠い位置（1e307）は無限大にせず、下の方に並べる", () => {
    const { doc } = normalizeDoc({ schema: "4d-branch", nodes: [{ id: "a", x: 1e307, y: 0 }, { id: "b", x: -5e7, y: 10 }, { id: "c", x: 120, y: 340 }], edges: [] });
    for (const n of Object.values(doc.nodes)) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
      expect(Math.abs(n.x)).toBeLessThanOrEqual(1e7);
    }
    expect(doc.nodes.c).toMatchObject({ x: 120, y: 340 });
  });

  it("時刻つきの期限も日付として読み、読めない期限は警告して外す", () => {
    const { doc, report } = normalizeDoc({
      nodes: [
        { id: "a", title: "A", due: "2027-03-31 10:00", x: 0, y: 0 },
        { id: "b", title: "B", time: { due: "2027/03/31 10:00", start: "2027-03-01 00:00:00" }, x: 0, y: 0 },
        { id: "c", title: "C", due: "来年の春", x: 0, y: 0 },
      ],
      edges: [],
    });
    expect(doc.nodes.a!.time.due).toBe("2027-03-31");
    expect(doc.nodes.b!.time).toMatchObject({ due: "2027-03-31", start: "2027-03-01" });
    expect(doc.nodes.c!.time.due).toBeNull();
    expect(report.warnings.join()).toContain("日付として読めない期限・開始日 1 件");
    expect(report.warnings.join()).toContain("来年の春");
  });
});

describe("dates", () => {
  it("いろいろな書き方をそろえる", () => {
    expect(normalizeDateStr("2027/3/1")).toBe("2027-03-01");
    expect(normalizeDateStr("2027年3月31日")).toBe("2027-03-31");
    expect(normalizeDateStr("２０２７-０３-３１")).toBe("2027-03-31");
    expect(normalizeDateStr("2027-02-30")).toBeNull();
    expect(normalizeDateStr("2027-03-31T10:00:00Z")).toBe("2027-03-31");
    expect(normalizeDateStr("2027-03-31 10:00")).toBe("2027-03-31");
    expect(normalizeDateStr("")).toBeNull();
    // 時間軸の計算が崩れない範囲（入力欄と同じ 1900〜2999 年）
    expect(normalizeDateStr("2999-12-31")).toBe("2999-12-31");
    expect(normalizeDateStr("9999-12-31")).toBeNull();
    expect(normalizeDateStr("0999-01-01")).toBeNull();
    expect(addMonths("2999-12-31", 2)).toBe("3000-02-28");
    expect(fromDayNumber(dayNumber("1900-01-01") - 365 * 1500)).toMatch(/^\d{4}-\d{2}-\d{2}$/); // 4 桁にそろえる
    expect(dayNumber(addMonths("2999-12-31", 2))).not.toBeNaN();
  });
});
