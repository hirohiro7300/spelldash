// Q01 基本カテゴリの概念カードに、パックと同じ「問題文に答え・別解」の検査をかける。
// パックは scripts/validate-words.mjs が止めている（q に答え／学校のパックは q に別解）。基本カテゴリ（listing など）は検査の外だった
export default {
  id: "Q01",
  level: "error",
  describe: "基本カテゴリの概念カードの問題文に、答えか別解（2 字以上）がそのまま出る",
  run(ctx) {
    const hits = [];
    for (const w of ctx.baseCards) {
      if (w.kind !== "concept") continue;
      const q = String(w.raw.q ?? "");
      const answer = w.raw.answer;
      if (answer && q.includes(answer)) hits.push({ card: w.ref, detail: `問題文に答え「${answer}」` });
      const leaked = (w.raw.accept ?? []).find((s) => String(s).length >= 2 && q.includes(String(s)));
      if (leaked) hits.push({ card: w.ref, detail: `問題文に別解「${leaked}」` });
    }
    return hits;
  }
};
