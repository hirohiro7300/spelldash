// Q04 漢字の別解に読みが無い。日本語の答えは読みをローマ字で打つ（Batch 54）ので、
// accept の漢字の別表記は、その読みが accept に無ければ打てない（単語帳には「別解」として出る）。
// 別表記ごとの読みはカードの acceptReadings に結ぶ（{ "<別表記>": "<読み>" | ["<読み>", …] }。docs/PACK_FORMAT.md「別表記の読み」）。
//   結んだ別表記: 結んだ読みが 1 つ以上あり、どれもひらがなを含む読みの形で、読みの候補（[answer, ...accept] の読み）にあり、
//            別表記の形（かなが同じ順で出る・漢字は 2 字以上の並びで 1 字 1〜4 字・1 字だけで 1〜5 字・数字の並びは位の読み。scripts/quality/readingShape.mjs）に合えば当たらない。
//            空・読みの形でない・accept に無い・形が合わない読みがあれば当たり（結び方の誤り）。読みを打てるかは validate-words と Q05 が見る。
//            形のほかの手がかり（短い形・他のカード・同じ読みなど）は正しいこともあるので、警告 Q04w が見直しの候補として出す
//   結んでいない別表記:
//     B・C 型: 答えと漢字の並びが違う別表記（B: 片方がもう片方を含む 定期保険／定期死亡保険、C: 別の語 電子線／陰極線）。
//            読みがあるかは機械では決まらない（辞書が要る）ので、結んでいなければ当たり
//     A 型の「の」: 漢字の並びは同じで「の」の数だけ違う別表記（民撰議院設立建白書／民撰議院設立の建白書）。
//            主な読みと「の」を除いて同じで、「の」の数が別表記に合う読みが無ければ当たり（結ばなくても機械で決まる）
//   漢字の並びが同じでほかのかなが違う型は数えない（学校のパックと基本カテゴリは validate-words がすべて結ばせる）
// 中身（detail）には別表記と読みだけを書く（数・並びの番号は書かない。別表記を外しただけで check.mjs --base の「変わったカードに新しい当たり」に出ないように）
// 直し方: 同じ意味なら読みを足して結ぶ（add-readings の alts）、違う意味・判断がつかなければ外す（docs/PACK_FORMAT.md「誤った別解は入れ忘れより有害」）
import { kanjiOf, acceptReadingsOf } from "../common.mjs";
import { readingShapeOk } from "../readingShape.mjs";

const countNo = (s) => (String(s).match(/の/g) ?? []).length;
const clean = (s) => String(s).replace(/[・\s･]/g, "");

export default {
  id: "Q04",
  level: "error",
  describe: "日本語の答えのカードの accept に、読みを結んでいない漢字の別表記（B・C 型）・結び方の誤り・「の」の有無だけの形の読みの抜けがある",
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
      const bound = acceptReadingsOf(w);
      for (const a of Array.isArray(w.accept) ? w.accept : []) {
        if (isReading(normalizeReading(a))) continue;
        const kb = kanjiOf(a);
        if (!kb) continue;
        if (bound.has(a)) {
          const list = bound.get(a); // 形の誤り（空の配列・文字列でない値）は null
          if (!list) hits.push({ card: w.ref, detail: `漢字の別表記「${a}」に結んだ読みが無い` });
          for (const r of list ?? []) {
            const n = normalizeReading(r);
            if (!isReading(n) || !hasKana(n)) hits.push({ card: w.ref, detail: `漢字の別表記「${a}」に結んだ「${r}」が読みの形でない` });
            else if (!readings.includes(n)) hits.push({ card: w.ref, detail: `漢字の別表記「${a}」に結んだ読み「${r}」が accept に無い` });
            else if (!readingShapeOk(a, n, normalizeReading)) hits.push({ card: w.ref, detail: `漢字の別表記「${a}」に結んだ読み「${r}」と、別表記のかな・字数が合わない` });
          }
          continue;
        }
        if (kb !== ka) {
          const type = ka.includes(kb) || kb.includes(ka) ? "B" : "C";
          hits.push({ card: w.ref, detail: `漢字の別表記「${a}」（${type} 型）に読みを結んでいない` });
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
