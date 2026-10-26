// Q03 accept の重複・答えと同じ accept（NFKC・小文字で比べる）。
// 判定は変わらない（js/answers.js・js/romaji.js・js/game.js の比べ方はどれも同じものを 1 つにまとめる）が、単語帳の「別解」に同じ語が並ぶ。
// validate-words.mjs は英単語のカードの「そのままの綴りの重複・出題語そのもの」だけを見る
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase();
export default {
  id: "Q03",
  level: "error",
  describe: "accept に同じ語が 2 度ある・答えと同じ語がある（NFKC・小文字で比べる）",
  run(ctx) {
    const hits = [];
    for (const w of ctx.cards) {
      const accept = Array.isArray(w.raw.accept) ? w.raw.accept : [];
      if (!accept.length) continue;
      const answer = norm(w.raw.answer ?? w.raw.en);
      const seen = new Map();
      for (const a of accept) {
        const k = norm(a);
        if (k === answer) hits.push({ card: w.ref, detail: `答えと同じ「${a}」（答え「${w.raw.answer ?? w.raw.en}」）` });
        else if (seen.has(k)) hits.push({ card: w.ref, detail: `重複「${seen.get(k)}」と「${a}」` });
        else seen.set(k, a);
      }
    }
    return hits;
  }
};
