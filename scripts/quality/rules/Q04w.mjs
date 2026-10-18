// Q04w 結んだ読みの見直しの候補（警告。落とさない）。漢字の別表記に結んだ読み（acceptReadings。docs/PACK_FORMAT.md「別表記の読み」）が、
// 機械で分かる手がかりと合わない（形〔かな・字数〕が合わないのは Q04 の誤り。ここは正しいこともある手がかり）:
//   短い形       別表記が答えの頭（尾）そのもの（岩宿／岩宿遺跡・頼朝／源頼朝）なのに、結んだ読みがカードのほかの読みの頭（尾）にならない
//   他のカード   別表記が別のカードの答えそのもの（同じ字面）なのに、結んだ読みにそのカードの読みが 1 つも無い
//   同じ読み     答えと違う漢字の所（共通の頭と尾を除いた残りが、両方とも漢字だけ）があるのに、結んだ読みが答えの主な読みと同じ
//                （特例国債／赤字国債 に あかじこくさい。民撰／民選 のような書き換えは正しいので、見直して残す）
//   別表記の無い短い読み  読みでない別表記が 1 つ以上あり、それをすべて結んだカードに、主な読みの頭（尾）そのものの短い読みがあり、
//                どの別表記にも結んでいない（外した別表記の読みの消し忘れ: 吉野ヶ里遺跡 から 吉野ヶ里 を外して よしのがり が残る。答えのかなの中に
//                ある読みは除く）。別表記の無いカード（分野パックのほとんど・別表記を全部外したカード）は結ぶ先が無く直す手立てが無いので見ない
//   同じ別表記の別の読み  同じ字面の別表記を、別のカードで共通の読みの無い読みに結んでいる（賢し: かしこし／さかし。両方のカードに出す）
// 読みが正しいかは辞書が要るので、ここは「見直す候補」を出すだけ（執筆 → 反証の 2 段の反証役が見る一覧）
import { acceptReadingsOf } from "../common.mjs";
import { faceOf as face, readingsByFace } from "../sim-judge.mjs"; // 字面と「同じ字面を答えにするカードの読み」の表は sim-judge と同じ物
const KANJI_ONLY = /^[㐀-鿿々〆]+$/;
// 共通の頭と尾を除いた残り（答え側・別表記側）
function middles(a, b) {
  const x = [...a];
  const y = [...b];
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return [x.slice(i, x.length - j).join(""), y.slice(i, y.length - j).join("")];
}

export default {
  id: "Q04w",
  level: "warn",
  describe: "漢字の別表記に結んだ読みの見直しの候補（短い形・他のカード・同じ読み・別表記の無い短い読み・同じ別表記の別の読み）",
  run(ctx) {
    const R = ctx.modules.romaji;
    // 読みは 1 枚に 1 回だけ作る（字面の表と、下の見直しの両方で使う）
    const entriesOf = new Map(ctx.cards.map((w) => [w, ctx.modules.judge.romajiEntriesFor(w)]));
    // 字面 → その字面を答えにする最初のカードの読み
    const byFace = readingsByFace(ctx.cards, ctx.modules.judge, entriesOf);
    const kanaReadings = (entries) => entries.map((e) => e.reading).filter(R.hasKana);
    const boundReadings = (list) => (list ?? []).map(R.normalizeReading).filter((n) => R.isReading(n) && R.hasKana(n));
    const hits = [];
    // 同じ別表記の別の読み: 字面 → [{ ref, alt, rs }]
    const byAlt = new Map();
    for (const w of ctx.cards) {
      const entries = entriesOf.get(w);
      if (!entries.length) continue;
      const bound = acceptReadingsOf(w);
      if (!bound.size) continue; // 結んだ別表記の無いカードは見ない（下の allBound も結んだ別表記が 1 つ以上要る）
      const accept = Array.isArray(w.accept) ? w.accept : [];
      const alts = accept.filter((a) => R.hasJapaneseScript(a) && !R.isReading(R.normalizeReading(a)));
      // 漢字の別表記が 1 つ以上あり、それが全部結んである（every は空の配列で真になるので、数も見る）
      const allBound = alts.length > 0 && alts.every((a) => bound.has(a));
      const readings = kanaReadings(entries);
      const ans = face(w.raw.answer);
      const prim = R.primaryReading(readings) ?? "";
      const allRs = new Set();
      for (const [alt, list] of bound) {
        const rs = boundReadings(list);
        if (!rs.length) continue; // 形の誤りは Q04・validate-words
        rs.forEach((r) => allRs.add(r));
        const f = face(alt);
        if (!byAlt.has(f)) byAlt.set(f, []);
        byAlt.get(f).push({ ref: w.ref, alt, rs });
        const others = readings.filter((x) => !rs.includes(x));
        if (f !== ans && ans.startsWith(f) && others.length && !rs.some((r) => others.some((x) => x.length > r.length && x.startsWith(r)))) {
          hits.push({ card: w.ref, detail: `短い形: 「${alt}」は答えの頭なのに、読み「${rs.join("／")}」がほかの読みの頭にならない` });
        }
        if (f !== ans && ans.endsWith(f) && !ans.startsWith(f) && others.length && !rs.some((r) => others.some((x) => x.length > r.length && x.endsWith(r)))) {
          hits.push({ card: w.ref, detail: `短い形: 「${alt}」は答えの尾なのに、読み「${rs.join("／")}」がほかの読みの尾にならない` });
        }
        const o = byFace.get(f);
        const oReadings = o && o.ref !== w.ref ? kanaReadings(o.entries) : [];
        if (oReadings.length && !rs.some((r) => oReadings.includes(r))) {
          hits.push({ card: w.ref, detail: `他のカード: 「${alt}」は ${o.ref} の答えで読みは「${oReadings.join("／")}」。結んだ読み「${rs.join("／")}」と違う` });
        }
        const [ma, mb] = middles(ans, f);
        if (ma && mb && KANJI_ONLY.test(ma) && KANJI_ONLY.test(mb) && rs.includes(prim)) {
          hits.push({ card: w.ref, detail: `同じ読み: 「${alt}」は答えと漢字が違う（${ma}／${mb}）のに、結んだ読みが答えの主な読み「${prim}」と同じ` });
        }
      }
      if (allBound) {
        // 別表記の無い短い読み（読みでない別表記をすべて結んだカードだけ。結んでいない別表記があれば、その読みかもしれない）
        const kanaRuns = R.normalizeReading(w.raw.answer).match(/[ぁ-ゖー]+/g) ?? [];
        for (const r of readings) {
          if (r === prim || r.length >= prim.length || allRs.has(r) || kanaRuns.some((k) => k.includes(r))) continue;
          const where = prim.startsWith(r) ? "頭" : prim.endsWith(r) ? "尾" : "";
          if (!where) continue;
          hits.push({ card: w.ref, detail: `別表記の無い短い読み: 「${r}」は主な読み「${prim}」の${where}。外した別表記の読みなら消し、残すなら別表記に結ぶ` });
        }
      }
    }
    for (const list of byAlt.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < list.length; j++) {
          const [a, b] = [list[i], list[j]];
          if (i === j || a.ref === b.ref || a.rs.some((r) => b.rs.includes(r))) continue;
          hits.push({ card: a.ref, detail: `同じ別表記の別の読み: 「${a.alt}」を ${b.ref} では「${b.rs.join("／")}」に結んでいる（このカードでは「${a.rs.join("／")}」）` });
        }
      }
    }
    return hits;
  }
};
