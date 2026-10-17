// Q04w 結んだ読みの見直しの候補（警告。落とさない）。漢字の別表記に結んだ読み（acceptReadings。docs/PACK_FORMAT.md「別表記の読み」）が、
// 機械で分かる手がかりと合わない（形〔かな・字数〕が合わないのは Q04 の誤り。ここは正しいこともある手がかり）:
//   短い形       別表記が答えの頭（尾）そのもの（岩宿／岩宿遺跡・頼朝／源頼朝）なのに、結んだ読みがカードのほかの読みの頭（尾）にならない
//   他のカード   別表記が別のカードの答えそのもの（同じ字面）なのに、結んだ読みにそのカードの読みが 1 つも無い
//   同じ読み     答えと違う漢字の所（共通の頭と尾を除いた残りが、両方とも漢字だけ）があるのに、結んだ読みが答えの主な読みと同じ
//                （特例国債／赤字国債 に あかじこくさい。民撰／民選 のような書き換えは正しいので、見直して残す）
//   別表記の無い短い読み  読みでない別表記をすべて結んだカードに、主な読みの頭（尾）そのものの短い読みがあり、どの別表記にも結んでいない
//                （外した別表記の読みの消し忘れ: 岩宿 を外して いわじゅく が残る。答えのかなの中にある読みは除く）
//   同じ別表記の別の読み  同じ字面の別表記を、別のカードで共通の読みの無い読みに結んでいる（賢し: かしこし／さかし。両方のカードに出す）
// 読みが正しいかは辞書が要るので、ここは「見直す候補」を出すだけ（執筆 → 反証の 2 段の反証役が見る一覧）
import { acceptReadingsOf } from "../common.mjs";

const face = (s) => String(s ?? "").normalize("NFKC").replace(/[・･\s]/g, "");
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
    const { romajiEntriesFor } = ctx.modules.judge;
    // 字面 → そのカードのかなの読み（最初のカード）
    const byFace = new Map();
    for (const w of ctx.cards) {
      const entries = romajiEntriesFor(w);
      if (!entries.length) continue;
      const f = face(w.en);
      if (!byFace.has(f)) byFace.set(f, { ref: w.ref, readings: entries.map((e) => e.reading).filter(R.hasKana) });
    }
    const boundReadings = (list) => list.map(R.normalizeReading).filter((n) => R.isReading(n) && R.hasKana(n));
    const hits = [];
    // 同じ別表記の別の読み: 字面 → [{ ref, alt, rs }]
    const byAlt = new Map();
    for (const w of ctx.cards) {
      const entries = romajiEntriesFor(w);
      if (!entries.length) continue;
      const bound = acceptReadingsOf(w);
      const accept = Array.isArray(w.accept) ? w.accept : [];
      const alts = accept.filter((a) => R.hasJapaneseScript(a) && !R.isReading(R.normalizeReading(a)));
      const allBound = alts.every((a) => bound.has(a));
      if (!bound.size && !allBound) continue;
      const readings = entries.map((e) => e.reading).filter(R.hasKana);
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
        if (o && o.ref !== w.ref && o.readings.length && !rs.some((r) => o.readings.includes(r))) {
          hits.push({ card: w.ref, detail: `他のカード: 「${alt}」は ${o.ref} の答えで読みは「${o.readings.join("／")}」。結んだ読み「${rs.join("／")}」と違う` });
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
