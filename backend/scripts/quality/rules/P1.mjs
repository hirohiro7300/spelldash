// P1 訳の形と品詞の食い違い（「建物＝build」の型）。誤検知の少ない形だけを見る:
//   R1 品詞が動詞なのに、訳に動詞の形が 1 つも無く、名詞の形（漢字かカタカナで終わる）がある（建物＝build）
//   R2 品詞が名詞なのに、訳がすべて「〜する・〜させる・〜される」（建てる＝building の「する」の形）
// かなだけの語（さる・いす）は名詞と動詞を区別できないので数えない。辞書は使わない（CI に依存を足さない）
const K = "[㐀-鿿々〆]";
const VERB = new RegExp(`(する|させる|される|できる|られる)$|${K}[ぁ-ん]*[うくぐすずつぬぶむる]$`);
const NOUN = new RegExp(`(${K}|[ァ-ヺー])$`);
const strip = (s) => String(s ?? "").replace(/[（(][^）)]*[）)]/g, "").replace(/[〜～~]/g, "").replace(/_+/g, "").trim();
export default {
  id: "P1",
  level: "error",
  describe: "品詞が動詞なのに訳が名詞だけ（建物＝build）・品詞が名詞なのに訳が「〜する」だけ",
  run(ctx) {
    const { jaTokens } = ctx.modules.jaAmbiguity;
    const hits = [];
    for (const w of ctx.cards) {
      if (w.kind === "concept" || !w.en || !w.ja || !w.pos) continue;
      const ts = jaTokens(strip(w.ja)).map((t) => t.trim()).filter(Boolean);
      if (!ts.length) continue;
      if (w.pos === "動" && !ts.some((t) => VERB.test(t)) && ts.some((t) => NOUN.test(t) && !/的$/.test(t))) hits.push({ card: w.ref, detail: `動詞に名詞の訳「${w.ja}」` });
      else if (w.pos === "名" && ts.every((t) => /(する|させる|される)$/.test(t))) hits.push({ card: w.ref, detail: `名詞に「〜する」の訳「${w.ja}」` });
    }
    return hits;
  }
};
