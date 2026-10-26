// Q18 答えの漏れの率 100%（L2）: 答えの字がすべて、問題文の 2 字以上の並びに出る。思い出さずに写せる
import { leakRates, leakTarget } from "../common.mjs";
export default {
  id: "Q18",
  level: "error",
  describe: "概念カードの答えの字が、すべて問題文の 2 字以上の並びに出る（漏れの率 100%）",
  run(ctx) {
    const hits = [];
    for (const w of ctx.cards) {
      if (!leakTarget(w)) continue;
      const r = leakRates(w.raw.answer, w.raw.q);
      if (r && r.L2 === 1) hits.push({ card: w.ref, detail: `答え「${w.raw.answer}」の字がすべて問題文に出る` });
    }
    return hits;
  }
};
