// Q06 同じ例文を別の語に使い回す。例文は見出し語の使い方を見せるもの。別の語に同じ文を出すと、どちらの例かが決まらない
import { wordCards } from "../common.mjs";
export default {
  id: "Q06",
  level: "error",
  describe: "同じ例文（ex）が別の見出し語にも使われている",
  run(ctx) {
    const byEx = new Map();
    const list = wordCards(ctx).filter((w) => w.ex);
    for (const w of list) {
      const k = String(w.ex).trim();
      if (!byEx.has(k)) byEx.set(k, new Set());
      byEx.get(k).add(w.en);
    }
    const hits = [];
    for (const w of list) {
      const ens = byEx.get(String(w.ex).trim());
      if (ens.size > 1) hits.push({ card: w.ref, group: String(w.ex).trim(), detail: `例文「${String(w.ex).trim()}」を ${[...ens].filter((e) => e !== w.en).join("・")} と共有` });
    }
    return hits;
  }
};
