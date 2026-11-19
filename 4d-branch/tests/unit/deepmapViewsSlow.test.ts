// 8 万枚の開発用の木での「画面に出す形」の確かめ（遅いので DEEPMAP_SLOW=1 のときだけ。ふだんの npm test では飛ばす）
//   DEEPMAP_SLOW=1 npx vitest run tests/unit/deepmapViewsSlow.test.ts --maxWorkers=2
// 木の置き場は DEEPMAP_TREE（R1 の木。無ければ R1 の木の確かめは飛ばす）・DEEPMAP_QTREE（前提を直した木。あれば）で変えられる。.json.gz でもよい。
// 確かめること: 年収 360 の見取り図の並び・差・数の 1 行・会社の答え・分かれ道の帯（作業メモ dev/check-values.ts と review の数）・
// どの画面の文字にも英字の鍵が出ない・見取り図と 10 の手の詳しい画面を全部作る時間（3 回の一番速い物）

import { describe, expect, it } from "vitest";
import { analyze, compileMap, fallbackText, type Analysis } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree } from "../../src/deepmap/mapData";
import { moveDetailVM, notesVM, overviewVM, pathVM, SMALL_DELTA_TEXT, type PathVM } from "../../src/deepmap/views";

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

/** 木のファイル（.json か .json.gz）があるか */
async function treeExists(path: string): Promise<boolean> {
  const fsName = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
  return fs.existsSync(path) || fs.existsSync(`${path}.gz`);
}

/** R1 の木（作業メモの試作の木。リポジトリには無く、CI でも作れない）があるか。無ければ R1 の木の確かめは飛ばす（前提を直した木の確かめは動く） */
const HAS_R1 = SLOW && (await treeExists(TREE));
if (SLOW && !HAS_R1) console.log(`R1 の木がありません: ${TREE}。R1 の木の確かめは飛ばします（DEEPMAP_TREE で場所を渡せる）`);

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
const ID_RE = /\b(?:ad|sd|fc|ind|back)_[a-z0-9_]+\b|\b[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)*\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bpm:\d+\b|\b(?:keep|stub|undefined|null|NaN|Infinity)\b/;

/** 道の画面の文字（開いたときの文章・着いた所の本文も） */
function pathTexts(p: PathVM, out: string[]): void {
  strings(p, out);
  for (const st of p.steps) strings(st.detail(), out);
  out.push(p.end.body(), p.start.body());
}

/** 見取り図と 10 の手の詳しい画面と一番ありそうな道（と、その道の 2 行目のほかの結果・手に切り替えた道）を全部作り、画面の文字を集める */
function allTexts(a: Analysis): string[] {
  const out: string[] = [];
  const ov = overviewVM(a);
  strings(ov, out);
  const text = fallbackText(a.cm.map, { annual: a.annual });
  for (const f of a.cm.firstMoves) {
    const d = moveDetailVM(a, f);
    strings(d, out);
    if (d.chain) {
      const p = pathVM(a, d.chain.node, text);
      pathTexts(p, out);
      for (const alt of [...(p.steps[1]?.outcomes ?? []), ...(p.steps[1]?.options ?? [])]) if (!alt.current) pathTexts(pathVM(a, alt.node, text), out);
    }
    for (const r of d.dest.rows.slice(0, 2)) pathTexts(pathVM(a, r.ends[0]!, text), out);
  }
  strings(notesVM(a, ov.basis, ov.worthNote === null), out);
  return out;
}

describe.skipIf(!SLOW)("8 万枚の木での見取り図と手の詳しい画面の言葉", () => {
  it.runIf(HAS_R1)("年収 360: 並び・差・数の 1 行・会社の答え・分かれ道の帯・英字の鍵なし", async () => {
    const t = await loadTree(TREE);
    expect(t, `木がありません: ${TREE}`).not.toBeNull();
    const a = analyze(compileMap(fromDevTree(t!)), 360);
    const vm = overviewVM(a);
    expect(vm.rows.map((r) => r.kind)).toEqual(["ad_permside", "sd_permpro", "fc_switch", "fc_scope", "sd_grow", "sd_pilot", "ad_portfolio", "keep", "part", "ind_quit"]);
    expect(vm.rows.map((r) => r.delta?.text)).toEqual(["+22 万円", "+16 万円", "+15 万円", "+10 万円", "+5.1 万円", "+4.9 万円", "+4.1 万円", "比べる元", "−77 万円", "−219 万円"]);
    expect(vm.basis).toBe("tree");
    // どの差も地図の値: 札ごとには書かず、見取り図に 1 回だけ（作業メモ user-10）
    expect(vm.rows.filter((r) => !r.isBase).every((r) => r.delta?.basis === null)).toBe(true);
    expect(vm.basisLine).toBe("差はどれも、その後に一番良い選び方をした場合の 3 年の稼ぎで比べた");
    // 比べる元（3 か月待つ）の幅を、どの手の行にも並べる（作業メモ user-1）
    expect(vm.rows.filter((r) => !r.isBase).every((r) => r.waitText === "3 か月待っても +41〜+282 万円")).toBe(true);
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
    expect(vm.chain?.text).toBe("今日から一番ありそうな道（見込み 6.4%）");
    expect(vm.chain?.sub).toBe("3 年の合計 1,159 万円・今日からの道の中で低い方から約 1 割（真ん中 1,269 万円）");
    expect(vm.keep?.text).toBe("3 年の合計 1,124 万円（ずっと今のままは分かれが無い）");
    expect(vm.lead).toBe("今日選べる 10 の手。どの手の先にも、2029 年 11 月まで 1,981〜2,489 の分かれ道が続く");
    const d = moveDetailVM(a, ap.node);
    expect(d.strip.caption).toBe("判断 1,452 回 + 出来事の分かれ 586 = 分かれ道 2,038");
    expect(d.dest.rows[0]!.label).toBe("会社員・SpellDash だけ可・副業なし・有料 30〜99 人");
    expect(d.dest.rows[0]!.shareText).toBe("36%");
    expect(d.plan[1]!.ym).toBe("2027 年 2 月");
    expect(d.plan[1]!.moves[0]!.shareText).toBe("80%");
    // 進め方の理由は、その月の手どうしを分ける結果（作業メモ truth-5）
    expect(d.plan[1]!.moves.map((m) => m.cond)).toEqual(["2027 年 2 月に SpellDash だけ・どちらも不可なら", "2027 年 2 月に全部可なら"]);
    // 平均の内訳（作業メモ user-1）
    expect(d.facts[1]).toBe("ずっと今のままより平均 +166 万円 ＝ この手の分 +22 万円 ＋ 3 か月待っても出る分 +145 万円");
    const bad = allTexts(a).filter((s) => ID_RE.test(s) || /NaN|Infinity|undefined/.test(s));
    expect(bad).toEqual([]);
  }, 120_000);

  it.runIf(HAS_R1)("年収 360: 道の画面（届け出て副業の 1 社目を探す の一番ありそうな道と、切り替えた道）", async () => {
    const t = await loadTree(TREE);
    const a = analyze(compileMap(fromDevTree(t!)), 360);
    const text = fallbackText(a.cm.map, { annual: 360 });
    const f = a.cm.firstMoves.find((x) => a.cm.kindNames[a.cm.kind[x]!] === "ad_permside")!;
    const p = pathVM(a, f, text);
    expect(p.title).toBe("一番ありそうな道");
    expect(p.figures[0]!.value).toBe("6.4%");
    expect(p.figures[0]!.sub).toBe("出来事の分かれ 9 回が、どれもこのとおりになる見込み");
    expect(p.figures[1]!.value).toBe("1,159 万円");
    // 一番ありそうな道は低い側（作業メモ user-2・truth-6）
    expect(p.figures[1]!.note).toBe("この手の後の道の中で低い方から約 1 割（真ん中 1,269 万円・平均 1,291 万円）。分かれごとに一番ありそうな結果（SpellDash だけ・据え置き・転職せず）をつないだ道なので、3 年の合計は低い側に寄る");
    expect(p.end.head).toBe("2029 年 11 月に着く所");
    expect(p.end.facts).toEqual(["3 年の合計 1,159 万円（ずっと今のままより +35 万円）", "この道の見込み 6.4%"]);
    expect(p.end.cls).toBe("会社員・SpellDash だけ可・副業なし・有料 30〜99 人");
    expect(p.steps.map((st) => st.ym)).toEqual(["2026 年 11 月", "2027 年 2 月", "2027 年 5 月", "2027 年 8 月", "2027 年 11 月", "2028 年 2 月", "2028 年 5 月", "2028 年 8 月", "2028 年 11 月", "2029 年 2 月", "2029 年 5 月", "2029 年 8 月"]);
    expect(p.steps[0]!.outcomeText).toBe("SpellDash だけ 45%");
    expect(p.steps[0]!.altOutcomesText).toBe("全部可 20%・どちらも不可 35%");
    expect(p.steps[1]!.move).toBe("4 月の評価で昇格を狙う");
    expect(p.steps[1]!.span).toBe("3 月〜5 月の手");
    expect(p.steps[11]!.runningText).toBe("ここまでの稼ぎ 1,159 万円");
    // 静かな期は 1 行（「2027 年 8 月〜11 月 転職活動を続ける（2 期・転職せず）」）
    const groups = p.items.filter((x) => x.type === "group").map((x) => (x.type === "group" ? `${x.ym} ${x.title}` : ""));
    expect(groups).toEqual(["2027 年 8 月〜11 月 転職活動を続ける（2 期・転職せず）", "2028 年 8 月〜11 月 転職活動を続ける（2 期・転職せず）"]);
    // 2 行目の結果を「昇格」に切り替える: 上の行はそのまま、その行から先が変わる
    const up = p.steps[1]!.outcomes.find((o) => o.name === "昇格")!;
    expect(up.shareText).toBe("30%");
    expect(up.diffText).toBe("+76 万円");
    const q = pathVM(a, up.node, text);
    expect(q.title).toBe("切り替えた道");
    expect(q.steps[0]!.outcome).toBe(p.steps[0]!.outcome);
    expect(q.steps[1]!.outcomeText).toBe("昇格 30%");
    expect(q.steps[1]!.pivot).toBe(true);
    expect(q.offs).toEqual(["2027 年 5 月の結果: 昇格 30%"]);
    expect(q.end.head).toBe("2029 年 11 月に着く所");
    // まとめた手に切り替える: その先は標準の続き（薄い行 1 本）と見積もりの着いた所。見込みは標準の続きに入るまで（作業メモ truth-1）
    const stub = p.steps[1]!.options.find((o) => o.tags.includes("この先は標準の続きの見積もり"))!;
    expect(p.steps[1]!.altOptionsText).toBe("ほかの手 3（どれも先は見積もり）");
    const r = pathVM(a, stub.node, text);
    expect(r.end.summary).toBe(true);
    expect(r.items.filter((x) => x.type === "light").map((x) => (x.type === "light" ? `${x.ym} ${x.title}` : ""))).toEqual(["2027 年 5 月〜2029 年 8 月 標準の選び方で続けた見積もり"]);
    expect(r.figures[0]!.label).toBe("標準の続きに入るまでの見込み");
    expect(r.figures[0]!.value).toBe("45%");
    expect(r.end.facts).toEqual(["3 年の合計 1,248 万円（多くの道の平均・ずっと今のままより +124 万円）", "標準の続きに入るまでの見込み 45%"]);
  }, 120_000);

  it.runIf(HAS_R1)("道の画面を作る時間（今日の手ごとの道と、その 2 行目のほかの結果・手への切り替え。3 回の一番速い物）", async () => {
    const t = await loadTree(TREE);
    const a = analyze(compileMap(fromDevTree(t!)), 360);
    const text = fallbackText(a.cm.map, { annual: 360 });
    let ms = Infinity;
    let n = 0;
    for (let k = 0; k < 3; k++) {
      n = 0;
      const t0 = performance.now();
      for (const f of a.cm.firstMoves) {
        const p = pathVM(a, f, text);
        n++;
        for (const alt of [...(p.steps[1]?.outcomes ?? []), ...(p.steps[1]?.options ?? [])]) {
          if (alt.current) continue;
          pathVM(a, alt.node, text);
          n++;
        }
      }
      ms = Math.min(ms, performance.now() - t0);
    }
    console.log(`道の画面 ${n} 本: ${ms.toFixed(1)} ms（1 本 ${(ms / n).toFixed(2)} ms）`);
    // 1 本の道の形は切り替えの予算（50 ms）の小さな一部
    expect(ms / n).toBeLessThan(10);
  }, 120_000);

  it.runIf(HAS_R1)("見取り図と 10 の手の詳しい画面を全部作る時間（3 回の一番速い物）", async () => {
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
      if (a.cm.has.q > 0) expect(vm.basisLine).toContain("見積もりどうしで比べた");
      const bad = allTexts(a).filter((s) => ID_RE.test(s) || /NaN|Infinity|undefined/.test(s));
      expect(bad).toEqual([]);
    }
  }, 240_000);

  it("前提を直した木（あれば）: 差が小さくても、この先の選び方が違う手に「近い・ほぼ同じ」と書かない（作業メモ truth-2）", async () => {
    const t = await loadTree(QTREE);
    if (!t || !t.header.never || !Array.isArray(t.header.never._all)) return;
    const cm = compileMap(fromDevTree(t));
    const near = (annual: number, kind: string) => {
      const vm = overviewVM(analyze(cm, annual));
      const r = vm.rows.find((x) => x.kind === kind)!;
      return r.decides;
    };
    // 360: 届け出て Pro を出す（TV 0.22・差 +3.9）・知人の店の広告を無償で手伝う（TV 0.15・差 +1.3）。540: 届け出て副業の 1 社目を探す（TV 0.22・差 +3.1）
    for (const [annual, kind, k] of [
      [360, "sd_permpro", "reveal"],
      [360, "ad_portfolio", "outcomes"],
      [540, "ad_permside", "reveal"],
    ] as const) {
      const d = near(annual, kind);
      expect([annual, kind, d.kind]).toEqual([annual, kind, k]);
      expect("note" in d ? d.note : null).toBe(SMALL_DELTA_TEXT);
    }
    // 学校・塾（−5.1 万円）など、マイナスの「3 年やらない場合との差」は誤差として「ほぼ差なし」（作業メモ truth-4）
    const vm = overviewVM(analyze(cm, 360));
    expect(vm.rows.find((r) => r.kind === "sd_pilot")!.worth?.text).toBe("ほぼ差なし");
    expect(vm.worthNoise).toBeGreaterThan(5);
  }, 240_000);

  it("前提を直した木（あれば）: まとめた手を通る道は「この道の見込み」と書かず、標準の続きは見積もりの印の行から（作業メモ truth-1・code-1）", async () => {
    const t = await loadTree(QTREE);
    if (!t) return;
    const cm = compileMap(fromDevTree(t));
    const a = analyze(cm, 360);
    const text = fallbackText(cm.map, { annual: 360 });
    for (const key of ["r.ad_permside.s.1sr", "r.fc_scope.all.1k"]) {
      const i = cm.map.indexOfKey(key);
      if (i < 0) continue;
      const p = pathVM(a, i, text);
      expect(p.summary).toBe(true);
      expect(p.figures[0]!.label).toBe("標準の続きに入るまでの見込み");
      const words = [...p.figures.flatMap((x) => [x.label, x.sub ?? ""]), ...p.end.facts];
      expect(words.some((w) => w.includes("この道の見込み") || w.includes("出来事の分かれが無い道"))).toBe(false);
      const light = p.items.filter((x) => x.type === "light");
      if (cm.has.cont > 0) {
        expect(light[0]!.type === "light" && light[0]!.head).toBe(true);
        expect(light[0]!.type === "light" ? light[0]!.title : "").toBe("ここから先は標準の選び方で続けた見積もり");
        expect(light.length).toBeGreaterThan(1);
      }
    }
  }, 240_000);
});
