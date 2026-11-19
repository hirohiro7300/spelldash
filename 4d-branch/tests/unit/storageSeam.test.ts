// 保存の口は 1 か所（R0 §10.2 I1・作業メモ SPEC v1 §6。見直し code-5）: 文書を保存先（IndexedDB・localStorage・バックアップ・アカウント・書き出し）に
// 書く物はどれも toStored / toStoredOrFull を、読む物はどれも fromStored / decodeStored(Async) を通す。
// ここでは、保存の口の外で文書をそのまま書いたり（put(doc・JSON.stringify(doc）、整えて読んだり（normalizeDoc(）していないかを、src の文字で確かめる。
// 許すのは、保存の口（codec.ts）と、その中身（thinMap.ts・legacyMap.ts）・決まりの定義（schema.ts）・同梱データの組み立て（信頼できる中身を整える）だけ
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const ALLOWED = new Set(["src/persist/codec.ts", "src/persist/thinMap.ts", "src/persist/legacyMap.ts", "src/model/schema.ts", "src/demo/futureBundle.ts", "src/demo/wishlistBundle.ts"]);

/** 注釈を除いた中身（注釈の中の名前は数えない） */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("保存の口は 1 か所（I1）", () => {
  it("保存の口の外で、文書をそのまま書かない・整えて読まない", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const path of files) {
      const rel = path.replace(/^(\.\.\/)+/, "");
      if (ALLOWED.has(rel)) continue;
      const text = code(sources[path]!);
      for (const re of [/\.put\(\s*doc\b/, /JSON\.stringify\(\s*doc\b/, /\bnormalizeDoc\(/]) if (re.test(text)) hits.push(`${rel}: ${re.source}`);
    }
    expect(hits).toEqual([]);
  });

  it("保存の道は保存の口を通す（本体・緊急コピー・バックアップは toStoredOrFull、アカウントは toStored、読む物は decodeStored）", () => {
    const at = (p: string) => code(sources[`../../src/${p}`]!);
    const persistence = at("persist/persistence.ts");
    expect(persistence).toMatch(/toStoredOrFull\(doc\)/);
    expect(persistence).toMatch(/toStoredOrFull\(d\)\.stored/);
    expect(persistence).toMatch(/decodeStoredAsync\(/);
    const cloud = at("persist/cloud.ts");
    expect(cloud).toMatch(/const stored = toStored\(doc\)/);
    expect(cloud).toMatch(/decodeStoredAsync\(raw\)/);
    const io = at("persist/io.ts");
    expect(io).toMatch(/serializeDoc\(toStoredOrFull\(doc\)\.stored/);
    expect(io).toMatch(/decodeStoredAsync\(parseJson\(text\)/);
  });
});
