// P2 品詞をまたぐ別解: 同じ訳（2 字以上・かっこの外）を持つ語どうしは別解の索引で互いに正解になるが、
// その訳の札が両方で確かで違う（repeatedly〔副「繰り返し」〕と repetition〔名「繰り返し」〕）のに結ばれている組。品詞が違えば別の語を問う問題になる
// （誤りを教える型）。札が確かなのは訳が 1 つのカードの札だけ（札はカードに 1 つ。訳が 2 つ以上のカードの札はどの訳の札か分からないので、
// 誤った × を出さない側で結ぶ）。訳ごとのまとめと「またぐ」の決め方は js/answers.js の meaningGroups・crossesPos を使う（別解の索引と同じ）。
// 全パックを有効にした索引で見る。当たりは組の両方のカード（その訳を持つカード）。group = 組
export default {
  id: "P2",
  level: "error",
  describe: "その訳の品詞の札が両方で確かで違う語どうしが、同じ訳で別解として結ばれている（全パックを有効にした索引）",
  run(ctx) {
    const { meaningGroups, crossesPos } = ctx.modules.answers;
    // check.mjs --root=<PR #175 より前の木> は、その木の answers.js にまとめ方が無い（その木の scripts/quality/check.mjs で流す。sim-judge.mjs と同じ）
    if (typeof meaningGroups !== "function" || typeof crossesPos !== "function") throw new Error("P2: js/answers.js に meaningGroups・crossesPos が無い（PR #175 より前の木。その木の scripts/quality/check.mjs で流す）");
    const index = ctx.altIndexAll();
    // 索引の鍵（js/answers.js altLookupKey: 同じ綴りで別の項目にしたカード〔5月〕は id、ほかは綴り）。綴り → その綴りのカードの鍵
    const lookupKey = ctx.modules.answers.altLookupKey ?? ((w) => w.en);
    const keysOf = new Map();
    // 組 → 共有する訳ごとに「品詞をまたぐ」か
    const pairs = new Map();
    for (const [key, m] of meaningGroups(ctx.cards)) {
      for (const [en, e] of m) for (const w of e.cards) keysOf.set(en, (keysOf.get(en) ?? new Set()).add(lookupKey(w)));
      const list = [...m];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [a, ea] = list[i];
          const [b, eb] = list[j];
          const k = [a, b].sort().join("|");
          if (!pairs.has(k)) pairs.set(k, { a, b, cross: [], same: false, cards: new Set() });
          const p = pairs.get(k);
          if (crossesPos(ea, eb)) {
            p.cross.push(`${key}（${a}=${ea.pos.join("・")}／${b}=${eb.pos.join("・")}）`);
            for (const w of [...ea.cards, ...eb.cards]) p.cards.add(w);
          } else p.same = true;
        }
      }
    }
    const hits = [];
    for (const [k, p] of pairs) {
      if (p.same || p.cross.length === 0) continue; // またがない訳（札が重なる・札が確かでない・札が無い）でも結ばれる組は正しい別解
      const linked = (a, b) => [...(keysOf.get(a) ?? [a])].some((k) => index.get(k)?.has(b));
      if (!(linked(p.a, p.b) || linked(p.b, p.a))) continue;
      for (const w of p.cards) hits.push({ card: w.ref, detail: `${p.a} と ${p.b} が品詞をまたいで別解: ${p.cross.join("・")}`, group: k });
    }
    return hits;
  }
};
