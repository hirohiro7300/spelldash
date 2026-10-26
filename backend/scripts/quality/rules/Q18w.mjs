// Q18w 答えの漏れの率 50〜99%（Q18 の警告の段）
import { leakRates, leakTarget, pct } from "../common.mjs";
export default {
  id: "Q18w",
  level: "warn",
  describe: "概念カードの答えの字の半分以上が、問題文の 2 字以上の並びに出る（漏れの率 50〜99%）",
  run(ctx) {
    const hits = [];
    for (const w of ctx.cards) {
      if (!leakTarget(w)) continue;
      const r = leakRates(w.raw.answer, w.raw.q);
      if (r && r.L2 >= 0.5 && r.L2 < 1) hits.push({ card: w.ref, detail: `答え「${w.raw.answer}」の漏れの率 ${pct(r.L2)}` });
    }
    return hits;
  }
};
