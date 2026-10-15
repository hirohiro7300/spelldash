// P4 例文の語形（exForm）が、別の見出し語と同じ綴りで意味が違う。
// build の例文に building（その綴りの見出し語は「建物」）を使うと、「建てる」の例で「建物」の綴りを見せる。
// 意味が同じものは数えない（目で見て除いた 11 枚と同じ形を機械で除く）:
//   ・その綴りの見出し語の訳と、このカードの訳に、片方がもう片方を含む語がある（shoe／shoes の「靴」、sightsee／sightseeing の「観光」）
//   ・その綴りの見出し語が形容詞で、綴りが「見出し語＋ed／d」（excite／excited のような過去分詞の形容詞）
import { wordCards, jaWords } from "../common.mjs";
export default {
  id: "P4",
  level: "warn",
  describe: "例文の語形（exForm）が、意味の違う別の見出し語と同じ綴り（build の例文の building）",
  run(ctx) {
    const heads = new Map(); // 綴り → [{ ja, pos }]
    for (const w of ctx.cards) {
      if (w.kind === "concept" || !w.en) continue;
      if (!heads.has(w.en)) heads.set(w.en, []);
      heads.get(w.en).push({ ja: String(w.ja ?? ""), pos: w.pos ?? "" });
    }
    const hits = [];
    for (const w of wordCards(ctx)) {
      if (!w.ex || !w.exForm) continue;
      const f = String(w.exForm).toLowerCase();
      if (f === w.en || !heads.has(f)) continue;
      const others = heads.get(f);
      const mine = jaWords(ctx, w.ja);
      const theirs = others.flatMap((o) => jaWords(ctx, o.ja));
      const sameMeaning = mine.some((a) => theirs.some((b) => a.includes(b) || b.includes(a)));
      const participle = others.some((o) => o.pos === "形") && (f === `${w.en}ed` || f === `${w.en}d`);
      if (sameMeaning || participle) continue;
      hits.push({ card: w.ref, detail: `例文の「${f}」は別の見出し語（${[...new Set(others.map((o) => o.ja))].join(" | ")}）と同じ綴り` });
    }
    return hits;
  }
};
