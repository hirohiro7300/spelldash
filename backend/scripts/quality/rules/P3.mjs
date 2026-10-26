// P3 同じ id の英単語で、パックによって品詞が違う。多くは多義（ship＝船／発送する）だが、
// 学習の記録は id で共有するので、別の品詞の語が 1 つの記録に混ざる（Q15 と同じ。id を分けるかは創業者の判断）。警告
import { wordCards } from "../common.mjs";
export default {
  id: "P3",
  level: "warn",
  describe: "同じ id の英単語の品詞がパックによって違う",
  run(ctx) {
    const list = wordCards(ctx).filter((w) => w.pos);
    const byId = new Map();
    for (const w of list) {
      if (!byId.has(w.id)) byId.set(w.id, new Set());
      byId.get(w.id).add(w.pos);
    }
    return list
      .filter((w) => byId.get(w.id).size > 1)
      .map((w) => ({ card: w.ref, group: w.id, detail: `品詞「${w.pos}」（訳「${w.ja}」）。ほかのパック: ${[...byId.get(w.id)].filter((p) => p !== w.pos).join("・")}` }));
  }
};
