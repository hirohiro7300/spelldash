// Q15 同じ id の英単語で、パックによって訳が違う。学習の記録は id で共有するので、別の意味の語が 1 つの記録に混ざる。
// 表記だけの違い（そろえる）・片方が他方を含む・別の訳（id を分けるかは創業者の判断）が混ざる。警告
import { wordCards } from "../common.mjs";
export default {
  id: "Q15",
  level: "warn",
  describe: "同じ id の英単語の訳がパックによって違う",
  run(ctx) {
    const list = wordCards(ctx);
    const byId = new Map();
    for (const w of list) {
      if (!byId.has(w.id)) byId.set(w.id, new Set());
      byId.get(w.id).add(String(w.ja));
    }
    return list
      .filter((w) => byId.get(w.id).size > 1)
      .map((w) => ({ card: w.ref, group: w.id, detail: `訳「${w.ja}」。ほかのパック: ${[...byId.get(w.id)].filter((j) => j !== String(w.ja)).join(" | ")}` }));
  }
};
