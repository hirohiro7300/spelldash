// 点検: 形（木・役割・基準・見込み・月）、数（アプリの計算と同じか・おかしな数）、判断の線、文章の長さ、大きさ。
// 失敗（failures）があれば書き出さない。気になる所（warnings）は報告に載せる。

import { gzipSync } from "node:zlib";
import { buildImpactDoc, impactNodeId, type ImpactAltX, type ImpactBundle, type ImpactOutX } from "../../src/demo/impact";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { impactBin } from "../../src/model/impactFormat";
import { rollback, type WriterText } from "./bundle";
import { shortWidth } from "./templates";
import { edgeW, familyOf, select, type Selection, type TNode } from "./tree";
import type { World } from "./sim";

const len = (s: string) => [...s].length;

/** 書き手の文章に数字を書いてよい形（それ以外の数字は差し込み {cl} などで入れる） */
const ALLOWED_NUM = [/980 円/g, /週 10 時間/g, /52 時間/g, /20[2-3]\d ?年/g, /\d{1,2} ?月/g, /[1-9] ?か月/g, /[1-3] ?年/g, /週 4 日/g, /[1-3] ?社目/g, /40 席/g, /GA4/g, /[1-3] ?回/g, /[1-5] ?つ/g, /[1-9] ?件/g, /0 円/g];

/** 書き手の文章の点検（数字・言葉・状態と合わない言い方） */
export function checkWriterText(w: World, tree: TNode, texts: Record<string, WriterText>): string[] {
  const out: string[] = [];
  const byKey = new Map<string, TNode>();
  const walk = (n: TNode) => {
    byKey.set(n.key, n);
    for (const k of n.kids) walk(k);
  };
  walk(tree);
  for (const [key, t] of Object.entries(texts)) {
    const n = byKey.get(key);
    if (!n) continue;
    const parts = [t.title, t.short, t.body, t.label, ...(t.todo ?? []).map((x) => (typeof x === "string" ? x : x[0]))].filter((x): x is string => typeof x === "string");
    for (const raw of parts) {
      let rest = raw.replace(/\{(cl|ads|pu|mau|sal|h)\}/g, "");
      for (const re of ALLOWED_NUM) rest = rest.replace(re, "");
      if (/[0-9０-９]/.test(rest)) out.push(`T2 数字を直接書いている: ${key}「${raw}」`);
      if (/[%％Δ]/.test(raw)) out.push(`T2 % や差を書いている: ${key}「${raw}」`);
      if (/(上|下|右|左)の(カード|選択肢|結果|手)/.test(raw)) out.push(`T2 位置の言葉: ${key}「${raw}」`);
      if (/(です|ます|ください)[。、」]?$|(です|ます)。/.test(raw)) out.push(`T2 敬語: ${key}「${raw}」`);
      if (/気持ち/.test(raw)) out.push(`T2 気持ちの言葉: ${key}「${raw}」`);
    }
    if (n.role === "s" || n.role === "e") {
      const st = n.st;
      const body = `${t.title ?? ""} ${t.body ?? ""}`;
      const ban: Array<[boolean, RegExp, string]> = [
        [st.j === "e", /辞めた|退職した|独立した/, "会社員なのに辞めた・独立した"],
        [st.j === "i", /会社員として|本業で/, "独立しているのに会社員・本業"],
        [st.pm === "n", /副業の顧客|1 社目が決まった/, "副業不可なのに副業の顧客"],
        [st.pro === 0, /有料会員|Pro の売上/, "Pro 前なのに有料会員"],
        [st.cl < 0.5, /顧客から|請求書/, "顧客がいないのに顧客から"],
        [st.j !== "p", /週 4 日勤務になった|週 4 日で働/, "週 4 日でないのに週 4 日"],
      ];
      for (const [cond, re, why] of ban) if (cond && re.test(body)) out.push(`T3 状態と合わない（${why}）: ${key}`);
    }
  }
  void w;
  return out;
}

export function runChecks(w: World, tree: TNode, b: ImpactBundle, sel: Selection, full: TNode, texts: Record<string, WriterText> = {}): { failures: string[]; warnings: string[]; report: string } {
  void full;
  void select;
  const failures: string[] = [];
  const warnings: string[] = [];
  const fail = (m: string) => failures.length < 200 && failures.push(m);
  const warn = (m: string) => warnings.length < 200 && warnings.push(m);
  for (const m of checkWriterText(w, tree, texts)) fail(m);
  const N = b.nodes;
  // ---- 形
  const kids = N.map(() => [] as number[]);
  N.forEach((n, i) => {
    if (i === 0 ? n[1] !== -1 : n[1] < 0 || n[1] >= i) fail(`S1 親の番号: ${n[0]}`);
    if (n[1] >= 0) kids[n[1]]!.push(i);
  });
  const ids = N.map((n) => impactNodeId(n[0]));
  if (new Set(ids).size !== ids.length) fail("S1 ID が重なる");
  if (new Set(N.map((n) => n[0])).size !== N.length) fail("S1 鍵が重なる");
  N.forEach((n, i) => {
    const [key, , role, m] = n;
    const ks = kids[i]!.map((k) => N[k]!);
    if (role === "r" || role === "s") {
      if (ks.some((k) => k[2] !== "a")) fail(`S2 判断の子が選択肢でない: ${key}`);
      const bases = ks.filter((k) => (k[7] as ImpactAltX).base);
      if (bases.length !== 1 || (bases[0]![7] as ImpactAltX).k !== "keep") fail(`S3 基準が 1 つでない: ${key}`);
      if (role === "r" && ks.length !== 10) fail(`S2 今日の選択肢が 10 でない: ${ks.length}`);
      if (role === "s" && ks.length < 2) fail(`S2 選択肢が 2 未満: ${key}`);
    }
    if (role === "a") {
      if (ks.length < 1 || ks.length > 4) fail(`S4 結果の数: ${key} ${ks.length}`);
      const ps = ks.map((k) => (k[7] as ImpactOutX).p);
      if (ps.reduce((a, c) => a + c, 0) !== 100) fail(`S4 見込みの合計が 100 でない: ${key}`);
      if (ks.length > 1 && ps.some((p) => p < 10 || p > 90)) fail(`S4 見込みが 10〜90 の外: ${key} ${ps.join(",")}`);
      for (const k of ks) if (k[2] !== "s" && k[2] !== "e") fail(`S2 選択肢の子が結果でない: ${k[0]}`);
      const ax = n[7] as ImpactAltX;
      for (const k of ks) if (k[3] !== m + ax.len) fail(`S5 結果の月: ${k[0]}`);
    }
    if (role === "e" && (m !== w.horizon || kids[i]!.length)) fail(`S5 行き先の月・子: ${key}`);
    if (role === "s" && !kids[i]!.length) fail(`S5 3 年前に終わる道: ${key}`);
  });
  const nonBaseAlts = N.filter((n) => n[2] === "a" && !(n[7] as ImpactAltX).base);
  const multi = nonBaseAlts.filter((n) => kids[N.indexOf(n)]!.length >= 2).length;
  if (multi / Math.max(1, nonBaseAlts.length) < 0.6) warn(`S4 結果が 2 つ以上の手が ${Math.round((multi / nonBaseAlts.length) * 100)}%（60% 未満）`);
  const c = b.check.counts;
  if (c.nodes > w.cap.nodes) fail(`S6 ノード数 ${c.nodes} > ${w.cap.nodes}`);
  if (c.ends < 600) warn(`S6 行き先 ${c.ends} < 600`);
  if (c.forks < 550) warn(`S6 分かれ道 ${c.forks} < 550`);
  for (const [f, k] of Object.entries(sel.stats.coverage)) if (k < 12) warn(`S6 「${f}」が出る判断 ${k} < 12`);

  // ---- 数: アプリの計算と同じか（年収 2 通り）
  const doc = buildImpactDoc(b, new Date(2026, 10, 18), "check");
  const idx = buildIndex(doc);
  const rootId = ids[0]!;
  const parity = (annual: number) => {
    const d2 = { ...doc, nodes: { ...doc.nodes } };
    const r = d2.nodes[rootId]!;
    d2.nodes[rootId] = { ...r, meta: { ...r.meta, impact: { v: 2, horizon: w.horizon, annual } } };
    const fc = computeForecast(d2, idx.out);
    const im = computeImpact(d2, idx.out, fc, null);
    const S = annual / 12;
    const v = rollback(tree, S, false);
    const vsq = rollback(tree, S, true);
    if (Math.abs((im.vRoot ?? NaN) - v) > 0.1) fail(`N1 今日の値が合わない（年収 ${annual}）: アプリ ${im.vRoot} / 作り ${v}`);
    if (Math.abs((im.vSQ ?? NaN) - vsq) > 0.1) fail(`N1 今のままの値が合わない（年収 ${annual}）: アプリ ${im.vSQ} / 作り ${vsq}`);
    const keep = tree.kids.find((a) => a.kind === "keep")!;
    for (const a of tree.kids) {
      const want = rollback(a, S, false) - rollback(keep, S, false);
      const got = im.alt.get(impactNodeId(a.key))?.delta;
      if (got === undefined || got === null || Math.abs(got - want) > 0.1) fail(`N1 今日の手の差が合わない（${a.kind}・年収 ${annual}）: ${got} / ${want}`);
    }
    // 結果の差の重み付き平均 = 手の差、行き先の見込みの合計 = 1、今日の値 = 行き先の平均
    let worst = 0;
    for (const [, info] of im.alt) {
      if (info.delta === null || !info.outcomes.length) continue;
      const s = info.outcomes.reduce((a2, o) => a2 + o.w * (o.u ?? 0), 0);
      worst = Math.max(worst, Math.abs(s - info.delta));
    }
    if (worst > 0.05) fail(`N2 結果の差の平均が手の差と合わない（最大 ${worst.toFixed(3)}）`);
    const pe = im.ends.reduce((a2, e) => a2 + e.p, 0);
    if (Math.abs(pe - 1) > 1e-6) fail(`N2 行き先の見込みの合計 ${pe}`);
    const ev = im.ends.reduce((a2, e) => a2 + e.p * e.tot, 0);
    if (Math.abs(ev - (im.vRoot ?? 0)) > 0.1) fail(`N2 今日の値と行き先の平均が合わない: ${ev} / ${im.vRoot}`);
    return im;
  };
  const im = parity(b.annual);
  const im540 = parity(540);

  // ---- 数: おかしな数
  const S = b.annual / 12;
  const walk = (n: TNode, f: (n: TNode) => void) => {
    f(n);
    for (const k of n.kids) walk(k, f);
  };
  walk(tree, (n) => {
    if (n.role === "a") {
      // 兄弟の結果は値の高い順（判断の線の上の方が良い）
      const vals = n.kids.map((k) => edgeW(k, S) + k.V);
      for (let i = 0; i + 1 < vals.length; i++) if (vals[i]! < vals[i + 1]! - 1e-6) fail(`N3 結果の並び: ${n.key}`);
      const zeroCost = w.kinds[n.kind!]!.hours <= 0 && !["ind_quit", "part", "back_emp", "plan_back"].includes(n.kind!);
      const base = n.parent!.kids.find((a) => a.kind === "keep")!;
      if (zeroCost && n.kind !== "keep" && n.V - base.V < -1) warn(`N5 手間の無い手が今のままより 1 万円以上悪い: ${n.key} ${(n.V - base.V).toFixed(1)}`);
    }
    if (n.role === "e") {
      const s = n.st;
      if (s.pu > 1500 || s.cl > 12) fail(`N6 3 年後の数が大きすぎる: ${n.key} 有料 ${s.pu} 顧客 ${s.cl}`);
      if (s.j !== "i" && (s.sal < 0.8 || s.sal > 1.6)) fail(`N6 給与の倍率: ${n.key} ${s.sal}`);
    }
    if (n.role === "s" || n.role === "e") {
      const s = n.st;
      if (s.pro === 0 && s.pu > 0.5) fail(`N7 Pro 前に有料会員: ${n.key}`);
      if (s.cl >= 0.5 && !(s.pm === "a" || s.j === "i")) fail(`N7 届け出の無い顧客: ${n.key} ${s.pm} ${s.j}`);
      // 前提 9: 認められている・独立しているなら Pro を出している（期間の途中で認められた・独立した場合も翌月に出す）
      if (s.pro === 0 && (s.pm === "a" || s.pm === "s" || s.j === "i")) fail(`N7 認められている・独立しているのに Pro を出していない: ${n.key} ${s.pm} ${s.j}`);
    }
  });
  for (const [id, info] of im.alt) {
    if (info.delta !== null && Math.abs(info.delta) > 1200) fail(`N6 差が大きすぎる: ${id} ${info.delta}`);
  }
  // 独立の見込み・有料 300 人以上の見込み（おすすめの選び方）
  let pInd = 0;
  let pPu = 0;
  for (const e of im.ends) {
    const n = doc.nodes[e.id]!;
    const st = n.meta.st as { j: string; pu: number };
    if (st.j === "i") pInd += e.p;
    if (st.pu >= 300) pPu += e.p;
  }
  if (pInd > 0.4) warn(`N8 おすすめの選び方で独立する見込み ${(pInd * 100).toFixed(0)}% > 40%`);
  if (pPu > 0.1) warn(`N8 有料 300 人以上の見込み ${(pPu * 100).toFixed(0)}% > 10%`);
  const bestRoot = Math.max(...Object.values(b.check.rootDelta));
  if (bestRoot > 12 * S) warn(`N8 今日の一番の差 ${bestRoot.toFixed(0)} 万円 > 年収 1 年分`);
  // 色の段の割合
  const binsCnt = new Map<number, number>();
  let nb = 0;
  for (const [, info] of im.alt) {
    if (info.isBase) continue;
    nb++;
    const k = impactBin(info.delta);
    binsCnt.set(k, (binsCnt.get(k) ?? 0) + 1);
  }
  const neutral = (binsCnt.get(0) ?? 0) / Math.max(1, nb);
  const top = ((binsCnt.get(4) ?? 0) + (binsCnt.get(-4) ?? 0)) / Math.max(1, nb);
  if (neutral > 0.35) warn(`N9 ほぼ同じ（±3 万円未満）の手が ${(neutral * 100).toFixed(0)}% > 35%`);
  if (top > 0.2) warn(`N9 一番濃い段の手が ${(top * 100).toFixed(0)}% > 20%`);

  // ---- 判断の線
  N.forEach((n, i) => {
    if (n[2] !== "a") return;
    const outs = kids[i]!.map((k) => N[k]![7] as ImpactOutX);
    if (outs.length < 2) return;
    const metric = new Set(outs.map((o) => o.ln[0]));
    if (metric.size !== 1) fail(`L1 線の測る物がそろわない: ${n[0]}`);
    const num = outs.every((o) => o.ln[4] === undefined);
    if (num) {
      const iv = outs.map((o) => [o.ln[2] ?? -Infinity, o.ln[3] ?? Infinity] as const).sort((a, b2) => a[0] - b2[0]);
      if (iv[0]![0] !== -Infinity || iv[iv.length - 1]![1] !== Infinity) fail(`L1 線が全体を覆わない: ${n[0]}`);
      for (let k = 0; k + 1 < iv.length; k++) if (iv[k]![1] !== iv[k + 1]![0]) fail(`L1 線に隙間・重なり: ${n[0]}`);
    }
    for (const o of outs) {
      if (len(o.line) > 44) warn(`L2 線が長い: ${o.line}`);
      if (/上の|下の/.test(o.line)) fail(`L2 位置の言葉: ${o.line}`);
    }
  });

  // ---- 文章の長さ
  N.forEach((n) => {
    const [key, , role, , title, short, body] = n;
    const max = role === "a" ? 16 : role === "e" ? 24 : 22;
    if (role !== "r" && len(title) > max) warn(`T1 タイトルが長い（${len(title)}）: ${title}`);
    if (shortWidth(short) > 7) warn(`T1 短い名前が長い: ${short}（${key}）`);
    if (!body.trim()) fail(`T1 本文が無い: ${key}`);
    if (role === "e" && !title.startsWith("3 年後:")) fail(`T1 行き先のタイトル: ${title}`);
  });
  // 手の種類（まとまり）の名前: 使っているまとまりには、概要の順位の行に出す名前が要る（12 文字まで）
  for (const fam of new Set(Object.values(w.kinds).map((k) => k.family))) {
    const label = b.fams?.[fam];
    if (!label?.trim()) fail(`T5 手の種類の名前が無い: ${fam}（world.json の familyLabels）`);
    else if (len(label) > 12) fail(`T5 手の種類の名前が長い（${len(label)}）: ${label}`);
  }
  const sib = new Map<number, Set<string>>();
  N.forEach((n) => {
    if (n[2] !== "a") return;
    const s = sib.get(n[1]) ?? new Set<string>();
    if (s.has(n[4])) fail(`T4 兄弟のタイトルが同じ: ${n[4]}（${n[0]}）`);
    s.add(n[4]);
    sib.set(n[1], s);
  });

  // ---- 大きさ
  const raw = JSON.stringify(b);
  const docJson = JSON.stringify(doc);
  const gz = gzipSync(Buffer.from(docJson, "utf8"), { level: 6 });
  const b64 = Math.ceil(gz.length / 3) * 4;
  if (raw.length > 800_000) fail(`Z1 同梱データ ${(raw.length / 1e3).toFixed(0)} KB > 800 KB`);
  if (docJson.length > 2_150_000) fail(`Z2 文書 ${(docJson.length / 1e6).toFixed(2)} MB > 2.15 MB`);
  if (b64 > 486_000) fail(`Z2 同期の大きさ ${b64} 文字 > 486,000`);

  // ---- 報告
  const rows: string[] = [];
  const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
  rows.push(`# 3 年の分かれ道: 作った結果`, "");
  rows.push(`- ノード ${c.nodes}（判断 ${c.decisions}・選択肢 ${c.options}・分かれ道 ${c.forks}・3 年後の行き先 ${c.ends}）`);
  rows.push(`- 主な手の出る判断: ${Object.entries(sel.stats.coverage).map(([f, k]) => `${f} ${k}`).join("・")}（足した所 ${sel.stats.promoted}・2 つ目を足した 1 年後の判断 ${sel.stats.filled}・外した ${sel.stats.trimmed}）`);
  rows.push(`- 大きさ: 同梱 ${(raw.length / 1e3).toFixed(0)} KB・文書 ${(docJson.length / 1e6).toFixed(2)} MB・gzip ${(gz.length / 1e3).toFixed(0)} KB・同期 ${b64.toLocaleString()} 文字（${(b64 / 180000).toFixed(2)} 分割）`);
  rows.push("", "## 今日の手（3 年の差・万円）", "", "| 手 | 年収 360 | 年収 540 | 悪くなる | 結果 |", "|---|---|---|---|---|");
  for (const a of tree.kids) {
    const id = impactNodeId(a.key);
    const i3 = im.alt.get(id)!;
    const i5 = im540.alt.get(id)!;
    rows.push(`| ${w.kinds[a.kind!]!.label} | ${fmt(i3.delta ?? 0)} | ${fmt(i5.delta ?? 0)} | ${Math.round((i3.pBad ?? 0) * 100)}% | ${a.kids.map((k) => `${k.out!.p}% ${k.out!.lab}`).join(" / ")} |`);
  }
  rows.push("", `- おすすめで 3 年 ${im.vRoot?.toFixed(0)} 万円・ずっと今のまま ${im.vSQ?.toFixed(0)} 万円（年収 ${b.annual}）`);
  rows.push(`- 年収 540: おすすめ ${im540.vRoot?.toFixed(0)}・今のまま ${im540.vSQ?.toFixed(0)}`);
  const f = im.salaryFlips();
  rows.push(`- 年収で一番が入れ替わる所: 上 ${f.above ? `${f.above.annual}（${doc.nodes[f.above.alt]?.title}）` : "なし"}・下 ${f.below ? `${f.below.annual}（${doc.nodes[f.below.alt]?.title}）` : "なし"}`);
  rows.push(`- おすすめの選び方で独立 ${(pInd * 100).toFixed(0)}%・有料 300 人以上 ${(pPu * 100).toFixed(0)}%`);
  rows.push(`- 段の割合（基準以外の ${nb} 手）: ${[-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => `${k}: ${(((binsCnt.get(k) ?? 0) / Math.max(1, nb)) * 100).toFixed(0)}%`).join("・")}`);
  const fams = new Map<string, number>();
  for (const [, info] of im.alt) void info;
  N.forEach((n) => {
    if (n[2] === "a") {
      const fam = familyOf(w, (n[7] as ImpactAltX).k);
      fams.set(fam, (fams.get(fam) ?? 0) + 1);
    }
  });
  rows.push(`- 手の種類ごとの数: ${[...fams.entries()].sort((a, b2) => b2[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  rows.push("", "## 3 年でやる価値（ずっとやらない場合との差）", "");
  for (const fam of im.families().sort((x, y) => (im.never(y).k ?? 0) - (im.never(x).k ?? 0))) rows.push(`- ${b.fams?.[fam] ?? fam}（${fam}）: ${fmt(im.never(fam).k ?? 0)}`);
  rows.push("", `## 失敗 ${failures.length}`, "", ...failures.map((x) => `- ${x}`), "", `## 気になる所 ${warnings.length}`, "", ...warnings.map((x) => `- ${x}`));
  return { failures, warnings, report: rows.join("\n") + "\n" };
}
