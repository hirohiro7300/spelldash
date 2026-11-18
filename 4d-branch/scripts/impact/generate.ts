// 3 年の分かれ道のデータ（src/demo/impact-data.json）を作る。数は world.json から決まった計算で出し、文章は型（templates.ts）と
// 書き手の文章（text/*.json、鍵ごと）で埋める。点検（check.ts）に通らなければ書き出さない。
// 使い方: node scripts/impact/run.mjs [--annual 540] [--no-write]

import { buildBundle, type ImpactBundle } from "./bundle";
import { runChecks } from "./check";
import { expand, prune, select, type TNode } from "./tree";
import type { World } from "./sim";

export interface GenerateResult {
  bundle: ImpactBundle;
  report: string;
  failures: string[];
  warnings: string[];
}

export function generate(world: World, texts: Record<string, Record<string, unknown>>, opts: { annual?: number } = {}): GenerateResult {
  const annual = opts.annual ?? world.annual;
  const S = annual / 12;
  const full = expand(world, S);
  const sel = select(world, full, S);
  const tree = prune(full, sel.shown, S);
  const bundle = buildBundle(world, tree, texts, annual);
  const { failures, warnings, report } = runChecks(world, tree, bundle, sel, full);
  return { bundle, report, failures, warnings };
}

export type { TNode };
