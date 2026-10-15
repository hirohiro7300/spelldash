// P2 品詞をまたぐ別解: 同じ訳（2 字以上・かっこの外）を持つ語どうしは別解の索引で互いに正解になるが、
// 両方に品詞の札があって違う（different〔形〕と differ〔動〕の「異なる」）のに結ばれている組。品詞が違えば別の語を問う問題になる
// （誤りを教える型）。js/answers.js buildAlternativeIndex は、訳ごとに両方の札を見て、両方にあって違えば結ばない（Batch 69 で 0 に）。
// 全パックを有効にした索引で見る。当たりは組の両方のカード（その訳を持つカード）。group = 組
export default {
  id: "P2",
  level: "error",
  describe: "品詞の札が違う語どうしが、同じ訳で別解として結ばれている（全パックを有効にした索引）",
  run(ctx) {
    const { jaTokens } = ctx.modules.jaAmbiguity;
    const { altKey } = ctx.modules.answers;
    const index = ctx.altIndexAll();
    // 訳 → 語 → { pos: 札の集まり, cards: その訳を持つカード }（buildAlternativeIndex と同じカードだけ）
    const byMeaning = new Map();
    for (const w of ctx.cards) {
      if (!w?.en || !w.ja || w.q || w.write || w.blank || w.calc || w.school) continue;
      if (!/^[a-z][a-z-]+$/.test(w.en)) continue;
      for (const token of jaTokens(w.ja)) {
        const key = altKey(token);
        if (key.length < 2) continue;
        if (!byMeaning.has(key)) byMeaning.set(key, new Map());
        const m = byMeaning.get(key);
        if (!m.has(w.en)) m.set(w.en, { pos: new Set(), cards: [] });
        const e = m.get(w.en);
        if (w.pos) e.pos.add(w.pos);
        e.cards.push(w);
      }
    }
    // 組 → 共有する訳ごとに「札が両方にあって重ならない」か
    const pairs = new Map();
    for (const [key, m] of byMeaning) {
      const list = [...m];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [a, ea] = list[i];
          const [b, eb] = list[j];
          const k = [a, b].sort().join("|");
          if (!pairs.has(k)) pairs.set(k, { a, b, cross: [], same: false, cards: new Set() });
          const p = pairs.get(k);
          const crosses = ea.pos.size > 0 && eb.pos.size > 0 && ![...ea.pos].some((x) => eb.pos.has(x));
          if (crosses) {
            p.cross.push(`${key}（${a}=${[...ea.pos].join("・")}／${b}=${[...eb.pos].join("・")}）`);
            for (const w of [...ea.cards, ...eb.cards]) p.cards.add(w);
          } else p.same = true;
        }
      }
    }
    const hits = [];
    for (const [k, p] of pairs) {
      if (p.same || p.cross.length === 0) continue; // 札が重なる（または無い）訳でも結ばれる組は正しい別解
      if (!(index.get(p.a)?.has(p.b) || index.get(p.b)?.has(p.a))) continue;
      for (const w of p.cards) hits.push({ card: w.ref, detail: `${p.a} と ${p.b} が品詞をまたいで別解: ${p.cross.join("・")}`, group: k });
    }
    return hits;
  }
};
