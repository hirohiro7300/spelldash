// Q09 同じカテゴリで 1 字の訳がぶつかる。別解の索引（js/answers.js）は 1 字の訳を使わないので、
// 「月」と出して moon と month のどちらも正しいのに、片方は 1 打目で × になる
export default {
  id: "Q09",
  level: "error",
  describe: "同じカテゴリの英単語で、1 字の訳（かっこの外）が同じで綴りが違う（互いに × になる）",
  run(ctx) {
    const hits = [];
    for (const c of ctx.categories) {
      const byTok = new Map();
      for (const w of ctx.cardsOf(c.id)) {
        const r = w.raw;
        if (r.q || !r.en || !r.ja || !/^[a-z][a-z-]*$/i.test(r.en)) continue;
        const core = String(r.ja).replace(/[（(][^）)]*[）)]/g, "");
        for (const t of core.split(/[・、／,]/).map((s) => s.trim()).filter(Boolean)) {
          if ([...t].length !== 1) continue;
          if (!byTok.has(t)) byTok.set(t, []);
          byTok.get(t).push(w);
        }
      }
      for (const [t, list] of byTok) {
        for (const w of list) {
          const others = list.filter((o) => o !== w && o.raw.en !== w.raw.en);
          if (others.length) hits.push({ card: w.ref, group: `${c.id}:${t}`, detail: `訳「${t}」が ${others.map((o) => o.raw.en).join("・")} とぶつかる` });
        }
      }
    }
    return hits;
  }
};
