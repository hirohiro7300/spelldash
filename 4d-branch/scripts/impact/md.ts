// 3 年の分かれ道の読みやすい一覧（docs/future/README.md）をデータから作る。数は年収 360 万円（仮）で計算した目安

import { buildImpactDoc, impactNodeId, type ImpactBundle } from "../../src/demo/impact";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { formatMan, formatMonthlyDelta, formatShare } from "../../src/model/impactFormat";
import type { DocData, ID } from "../../src/model/types";

const esc = (s: string) => s.replace(/\|/g, "｜").replace(/\n/g, " ");

export function impactMarkdown(b: ImpactBundle): string {
  const doc: DocData = buildImpactDoc(b, new Date(2026, 10, 18), "md");
  const idx = buildIndex(doc);
  const im = computeImpact(doc, idx.out, computeForecast(doc, idx.out), null);
  const kids = (id: ID): ID[] =>
    (idx.out.get(id) ?? [])
      .map((e) => doc.edges[e]!.target)
      .sort((a, b) => ((doc.nodes[a]!.meta.rank as number) ?? 0) - ((doc.nodes[b]!.meta.rank as number) ?? 0));
  const edgeTo = (id: ID) => Object.values(doc.edges).find((e) => e.target === id)!;
  const rootId = impactNodeId(b.nodes[0]![0]);
  const root = doc.nodes[rootId]!;
  const out: string[] = [];
  const c = b.check.counts;
  out.push("# 未来の道筋（仕事・3 年の分かれ道）", "");
  out.push(
    "> 4D Branch のメニュー「未来の道筋（仕事・3 年）を読み込む…」で地図として読み込めるデータの一覧です（`node scripts/impact/run.mjs` で `scripts/impact/world.json` から作り直せます）。",
    "> 数は年収（額面）360 万円の仮の値で計算した目安です。アプリでは年収・見込み %・選んだ手を変えると、その場で計算し直します。",
    "",
  );
  out.push(`- 判断 ${c.decisions}・選択肢 ${c.options}・分かれ道 ${c.forks}・3 年後の行き先 ${c.ends.toLocaleString("ja-JP")}（ノード ${c.nodes.toLocaleString("ja-JP")}）`);
  out.push(`- おすすめの選び方で 3 年 ${formatMan(im.vRoot ?? 0, false)}円・ずっと今のままなら ${formatMan(im.vSQ ?? 0, false)}円（差 ${formatMan((im.vRoot ?? 0) - (im.vSQ ?? 0))}円）`);
  out.push("", "## 見方", "");
  out.push("- **3 年の差**: その手を今やると、今日から 3 年の稼ぎ（税引き前）が「今のまま」よりどれだけ変わるか。どちらもその後は一番良い選び方をした場合");
  out.push("- **悪くなる**: その手の結果のうち、今のままより悪くなる見込み（会社の答えを聞くだけの手は、聞かなかった場合の同じ答えの世界と比べる）");
  out.push("- **3 年後の月**: 3 年後の月の稼ぎが今のままよりどれだけ違うか（勢い）");
  out.push("- **結果**: 見込み % と判断の線（その時に測れる条件）", "");
  out.push("## 前提", "", ...b.premises.map((p) => `- ${p}`), "");
  out.push(`## ${esc(root.title)}`, "", esc(root.body), "");
  out.push("| 手 | 3 年の差 | 悪くなる | 3 年後の月 | 週の時間 | 結果 |", "|---|---|---|---|---|---|");
  const rootAlts = kids(rootId);
  const sorted = [...rootAlts].sort((a, b) => (im.alt.get(b)?.delta ?? 0) - (im.alt.get(a)?.delta ?? 0));
  for (const a of sorted) {
    const n = doc.nodes[a]!;
    const info = im.alt.get(a)!;
    const outs = kids(a).map((o) => `${(edgeTo(o).meta.prob as number) ?? 0}% ${esc(edgeTo(o).label || "（どの場合も）")}`);
    const mark = info.mark === "star" ? "★ " : info.mark === "tie" ? "≒ " : "";
    out.push(`| ${mark}${esc(n.title)} | ${info.isBase ? "基準" : formatMan(info.delta ?? 0)} | ${info.pBad === null ? "—" : formatShare(info.pBad)} | ${info.dR === null ? "—" : formatMonthlyDelta(info.dR)} | ${(n.meta.h as number) >= 0 ? "+" : ""}${n.meta.h as number}h | ${outs.join(" / ")} |`);
  }
  out.push("");
  for (const a of sorted) {
    const n = doc.nodes[a]!;
    const info = im.alt.get(a)!;
    out.push(`## ${esc(n.title)}（${info.isBase ? "基準" : formatMan(info.delta ?? 0)}）`, "", esc(n.body), "");
    if (n.conditions.length) out.push(...n.conditions.map((x) => `- [ ] ${esc(x.text)}`), "");
    for (const o of kids(a)) {
      const st = doc.nodes[o]!;
      const e = edgeTo(o);
      const ou = im.outcome.get(o);
      out.push(`### ${(e.meta.prob as number) ?? 0}% ${esc(st.title)}${ou && ou.u !== null ? `（今のままより ${formatMan(ou.u)}）` : ""}`, "");
      out.push(`- 判断の線: ${esc(e.condition)}`, `- ${esc(st.body)}`, "");
      const next = kids(o);
      if (!next.length) continue;
      out.push("| 3 か月後の手 | 3 年の差 | 悪くなる | 結果 |", "|---|---|---|---|");
      for (const a2 of [...next].sort((x, y) => (im.alt.get(y)?.delta ?? 0) - (im.alt.get(x)?.delta ?? 0))) {
        const n2 = doc.nodes[a2]!;
        const i2 = im.alt.get(a2)!;
        const outs = kids(a2).map((x) => `${(edgeTo(x).meta.prob as number) ?? 0}% ${esc(edgeTo(x).label || "（どの場合も）")}`);
        const mark = i2.mark === "star" ? "★ " : i2.mark === "tie" ? "≒ " : "";
        out.push(`| ${mark}${esc(n2.title)} | ${i2.isBase ? "基準" : formatMan(i2.delta ?? 0)} | ${i2.pBad === null ? "—" : formatShare(i2.pBad)} | ${outs.join(" / ")} |`);
      }
      out.push("");
    }
  }
  out.push("## 3 年後の行き先（おすすめの選び方で見込みの高い順）", "", "| 見込み | 行き先 | 3 年の稼ぎ |", "|---|---|---|");
  for (const e of im.ends.slice(0, 20)) out.push(`| ${formatShare(e.p)} | ${esc(doc.nodes[e.id]!.title)} | ${formatMan(e.tot, false)}円（今のままより ${formatMan(e.tot - (im.vSQ ?? 0))}円） |`);
  out.push("");
  return out.join("\n");
}
