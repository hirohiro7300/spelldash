// Q24 パックの説明（label・blurb・audience）の、根拠の無い強い主張の語。
// 製品の決まり「数字・効果を誇張しない」。言い換える（創業者が文を見る）。当たりはパックそのもの（ref は "<パック id>:*"）
const TERMS = [
  ["網羅", /網羅/],
  ["頻出", /頻出/],
  ["毎回", /毎回/],
  ["公式", /公式/],
  ["準拠", /準拠/],
  ["教科書", /教科書/],
  ["新出語", /新出語/],
  ["狙われる", /狙われ/],
  ["約N割", /約\s*[0-9０-９一二三四五六七八九十]+\s*割/]
];
export default {
  id: "Q24",
  level: "warn",
  describe: "パックの説明に根拠の無い強い主張の語（網羅・頻出・毎回・公式・準拠・教科書・新出語・狙われる・約N割）",
  run(ctx) {
    const hits = [];
    for (const c of ctx.categories) {
      if (!c.pack) continue;
      const file = ctx.files.get(c.id);
      const found = [];
      for (const field of ["label", "blurb", "audience"]) {
        const texts = new Set([file?.[field], c[field]].filter((t) => typeof t === "string"));
        for (const text of texts) for (const [name, re] of TERMS) if (re.test(text)) found.push(`${field}「${name}」`);
      }
      if (found.length) hits.push({ card: ctx.packRef(c.id), detail: [...new Set(found)].join("・") });
    }
    return hits;
  }
};
