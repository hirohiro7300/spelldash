// 8 万枚の開発用の木での「画面に出す形」の確かめ（遅いので DEEPMAP_SLOW=1 のときだけ。ふだんの npm test では飛ばす）
//   DEEPMAP_SLOW=1 npx vitest run tests/unit/deepmapViewsSlow.test.ts --maxWorkers=2
// 木の置き場は DEEPMAP_TREE（R1 の木）・DEEPMAP_QTREE（前提を直した木。あれば）で変えられる。.json.gz でもよい。
// 確かめること: 年収 360 の見取り図の並び・差・数の 1 行・会社の答え・分かれ道の帯（作業メモ dev/check-values.ts と review の数）・
// どの画面の文字にも英字の鍵が出ない・見取り図と 10 の手の詳しい画面を全部作る時間（3 回の一番速い物）

import { describe, expect, it } from "vitest";
import { analyze, compileMap, fallbackText, type Analysis } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree } from "../../src/deepmap/mapData";
import { moveDetailVM, notesVM, overviewVM, pathVM } from "../../src/deepmap/views";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SLOW = env.DEEPMAP_SLOW === "1";
const DEV = "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap/dev";
const TREE = env.DEEPMAP_TREE ?? `${DEV}/r1-tree.json`;
const QTREE = env.DEEPMAP_QTREE ?? `${DEV}/q-tree.json`;

interface NodeFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
interface NodeZlib {
  gunzipSync(b: Uint8Array): Uint8Array;
}

/** 木を読む（.json か .json.gz。無ければ null） */
async function loadTree(path: string): Promise<DevTree | null> {
  const fsName = "node:fs";
  const zName = "node:zlib";
  const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
  const z = (await import(/* @vite-ignore */ zName)) as NodeZlib;
  for (const p of [path, `${path}.gz`]) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p);
    const bytes = p.endsWith(".gz") ? z.gunzipSync(raw) : raw;
    return JSON.parse(new TextDecoder().decode(bytes)) as DevTree;
  }
  return null;
}

const KEY_FIELDS = new Set(["kind", "href", "backHref", "key", "id", "color", "slug", "answer", "fact"]);
function strings(x: unknown, out: string[] = [], key = ""): string[] {
  if (KEY_FIELDS.has(key)) return out;
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out, key);
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) strings(v, out, k);
  return out;
}
const ID_RE = /\b(?:ad|sd|fc|ind|back)_[a-z0-9_]+\b|\b[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)*\b|\bpm:\d+\b|\b(?:keep|stub|undefined|null|NaN|Infinity)\b/;

/** 見取り図と 10 の手の詳しい画面と一番ありそうな道を全部作り、画面の文字を集める */
function allTexts(a: Analysis): string[] {
  const out: string[] = [];
  const ov = overviewVM(a);
  strings(ov, out);
  const text = fallbackText(a.cm.map, { annual: a.annual });
  for (const f of a.cm.firstMoves) {
    const d = moveDetailVM(a, f);
    strings(d, out);
    if (d.chain) strings(pathVM(a, d.chain.node, text), out);
    for (const r of d.dest.rows.slice(0, 2)) strings(pathVM(a, r.ends[0]!, text), out);
  }
  strings(notesVM(a, ov.basis, ov.worthNote === null), out);
  return out;
}

describe.skipIf(!SLOW)("8 万枚の木での見取り図と手の詳しい画面の言葉", () => {
  it("年収 360: 並び・差・数の 1 行・会社の答え・分かれ道の帯・英字の鍵なし", async () => {
    const t = await loadTree(TREE);
    expect(t, `木がありません: ${TREE}`).not.toBeNull();
    const a = analyze(compileMap(fromDevTree(t!)), 360);
    const vm = overviewVM(a);
    expect(vm.rows.map((r) => r.kind)).toEqual(["ad_permside", "sd_permpro", "fc_switch", "fc_scope", "sd_grow", "sd_pilot", "ad_portfolio", "keep", "part", "ind_quit"]);
    expect(vm.rows.map((r) => r.delta?.text)).toEqual(["+22 万円", "+16 万円", "+15 万円", "+10 万円", "+5.1 万円", "+4.9 万円", "+4.1 万円", "比べる元", "−77 万円", "−219 万円"]);
    expect(vm.basis).toBe("tree");
    expect(vm.rows.filter((r) => !r.isBase).every((r) => r.delta?.basis === "地図の値")).toBe(true);
    const ap = vm.rows[0]!;
    expect(ap.isPi).toBe(true);
    expect(ap.countsText).toBe("判断 1,452 回・出来事の分かれ 586 → 2029 年 11 月の行き先 383（見込み 1% 以上 9）・標準の続きの見積もり 2,131");
    expect(ap.decides.text).toBe("会社の答え: 全部可 20%・SpellDash だけ 45%・どちらも不可 35%");
    expect(ap.rangeText).toBe("3 年の合計 1,159〜1,452 万円（10〜90%・真ん中 1,269 万円）");
    expect(ap.vsKeepText).toBe("ずっと今のままより +35〜+328 万円");
    expect(ap.forksText).toBe("この先の分かれ道 2,038");
    expect(ap.strip.map((c) => c.dec).join("·")).toBe("0·3·6·16·41·62·107·157·194·240·304·322");
    // 今のままの先とほぼ同じ手（全変動距離 < 0.1 か |差| < 5）
    const near = vm.rows.filter((r) => r.decides.kind === "near").map((r) => r.kind);
    expect(near.sort()).toEqual(["ad_portfolio", "fc_scope", "sd_grow", "sd_pilot"]);
    expect(vm.chain?.text).toBe("一番ありそうな道（見込み 6.4%）");
    expect(vm.keep?.text).toBe("3 年の合計 1,124 万円（どの道でも同じ）");
    expect(vm.lead).toBe("今日選べる 10 の手。どの手の先にも、2029 年 11 月まで 1,981〜2,489 の分かれ道が続く");
    const d = moveDetailVM(a, ap.node);
    expect(d.strip.caption).toBe("判断 1,452 回 + 出来事の分かれ 586 = 分かれ道 2,038");
    expect(d.dest.rows[0]!.label).toBe("会社員・SpellDash だけ可・副業なし・有料 30〜99 人");
    expect(d.dest.rows[0]!.shareText).toBe("36%");
    expect(d.plan[1]!.ym).toBe("2027 年 2 月");
    expect(d.plan[1]!.moves[0]!.shareText).toBe("80%");
    expect(d.plan[1]!.moves[0]!.cond).toBe("SpellDash だけ・どちらも不可なら");
    const bad = allTexts(a).filter((s) => ID_RE.test(s) || /NaN|Infinity|undefined/.test(s));
    expect(bad).toEqual([]);
  }, 120_000);

  it("見取り図と 10 の手の詳しい画面を全部作る時間（3 回の一番速い物）", async () => {
    const t = await loadTree(TREE);
    const a = analyze(compileMap(fromDevTree(t!)), 360);
    let ms = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      overviewVM(a);
      for (const f of a.cm.firstMoves) moveDetailVM(a, f);
      ms = Math.min(ms, performance.now() - t0);
    }
    console.log(`見取り図 + 10 の手の詳しい画面: ${ms.toFixed(1)} ms`);
    // 上限はゆるく（ほかの作業と CPU を分け合う）。目安は 100 ms 前後
    expect(ms).toBeLessThan(400);
  }, 120_000);

  it("前提を直した木（あれば）: q の差で比べ、英字の鍵が出ない", async () => {
    const t = await loadTree(QTREE);
    if (!t) return;
    for (const annual of [360, 540]) {
      const a = analyze(compileMap(fromDevTree(t)), annual);
      const vm = overviewVM(a);
      expect(vm.rows).toHaveLength(a.cm.firstMoves.length);
      if (a.cm.has.q > 0) expect(vm.rows.some((r) => r.delta?.basis === "同じ見積もり方")).toBe(true);
      const bad = allTexts(a).filter((s) => ID_RE.test(s) || /NaN|Infinity|undefined/.test(s));
      expect(bad).toEqual([]);
    }
  }, 240_000);
});
