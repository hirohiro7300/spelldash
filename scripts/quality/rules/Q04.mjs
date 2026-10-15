// Q04 漢字の別解に読みが無い。日本語の答えは読みをローマ字で打つ（Batch 54）ので、
// accept の漢字の別表記は、その読みが accept に無ければ打てない（単語帳には「別解」として出る）。
//   B・C 型: 答えと漢字の並びが違う別表記（B: 片方がもう片方を含む 定期保険／定期死亡保険、C: 別の語 電子線／陰極線）。
//            読みがあるかは機械では決まらない（辞書が要る）ので、別表記があればすべて当たり（上限）
//   A 型の「の」: 漢字の並びは同じで「の」の数だけ違う別表記（民撰議院設立建白書／民撰議院設立の建白書）。
//            主な読みと「の」を除いて同じで、「の」の数が別表記に合う読みが無ければ当たり
// 直し方: 同じ意味なら読みを足す（「の」の型）、違う意味・判断がつかなければ外す（docs/PACK_FORMAT.md「誤った別解は入れ忘れより有害」）
import { kanjiOf } from "../common.mjs";

const countNo = (s) => (String(s).match(/の/g) ?? []).length;
const clean = (s) => String(s).replace(/[・\s･]/g, "");

export default {
  id: "Q04",
  level: "error",
  describe: "日本語の答えのカードの accept に、読みの無い漢字の別表記がある（B・C 型は上限で数える。A 型は「の」の有無だけの形）",
  run(ctx) {
    const { readingEntries, primaryReading, hasKana, isReading, normalizeReading, hasJapaneseScript } = ctx.modules.romaji;
    const hits = [];
    for (const w of ctx.cards) {
      if (w.kind !== "concept" || w.calc || w.kanjiOnly || w.write || w.blank || !hasJapaneseScript(w.en)) continue;
      const entries = readingEntries(w);
      if (!entries.some((e) => hasKana(e.reading))) continue;
      const readings = entries.map((e) => e.reading);
      const prim = primaryReading(entries.filter((e) => hasKana(e.reading)))?.reading ?? "";
      const answer = String(w.raw.answer ?? "");
      const ka = kanjiOf(answer);
      for (const a of Array.isArray(w.accept) ? w.accept : []) {
        if (isReading(normalizeReading(a))) continue;
        const kb = kanjiOf(a);
        if (!kb) continue;
        if (kb !== ka) {
          const type = ka.includes(kb) || kb.includes(ka) ? "B" : "C";
          hits.push({ card: w.ref, detail: `漢字の別表記「${a}」（${type} 型）。読みがあるかは機械で決まらない` });
          continue;
        }
        const A = clean(a);
        const N = clean(answer);
        if (A.replace(/の/g, "") !== N.replace(/の/g, "") || countNo(A) === countNo(N)) continue;
        const want = countNo(prim) + (countNo(A) - countNo(N));
        const covered = readings.some((r) => r.replace(/の/g, "") === prim.replace(/の/g, "") && countNo(r) === want);
        if (!covered) hits.push({ card: w.ref, detail: `「の」の有無だけ違う別表記「${a}」の読みが無い（主な読み ${prim}）` });
      }
    }
    return hits;
  }
};
