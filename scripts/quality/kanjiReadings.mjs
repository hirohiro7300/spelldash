// データの中の「漢字 1 字 → 読み」の表（辞書の代わりの手がかり。反証の道具 scripts/quality/review-readings.mjs が使う。CI の規則には使わない）。
// 答えと主な読みの組（validate-words が見る確かな組）を、漢字 1 字に 1〜6 かなで並べ、EM（数回）で並べ方の重みを決めて、漢字ごとに
// 出てきた読みを数える。別表記に結んだ読みの「裏付け」（その字面の漢字のどれもが、データのどこかでその音で読まれているか）を見る。
// データに無い音（頼朝 の 朝＝とも・古文の訓）は正しくても裏付けが無いと出るので、規則にはしない（見直す人の一覧）。
// 漢字にはさまれた ケ・ヶ・ヵ・カ（関ケ原・吉野ケ里・四カ国）は、形の見張り（readingShape.mjs）と同じ関数 markFreeKana で見分け、
// 小さい ヵ・ヶ と同じ か・が・こ・け の 1 字の枠にする（形の見張りは漢字と同じ枠。どちらも け・か の字のままでは読まない。
// 並べ方の重みには入れないので、四カ国条約 の 四＝よん のような表の読みは散らない）
//   buildTable(pairs)                pairs: [{ face, reading }] → { count, sure, looseSure, known }（sure: 漢字 → 確かな読みの集合）
//   supported(table, face, reading)  → { ok, unknown, bad }  ok: どの漢字も、出てきた読み（ゆるく: 濁点・語末の っ）か知らない字で並べられる。
//                                    bad: 並ばないときの、裏付けの無い字と読み（[{ k, kana }]）
import { markFreeKana, FREE } from "./readingShape.mjs";

const KANJI = /[㐀-鿿々〆]/;
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
// ゆるい比べ: 濁点・半濁点を落とす。語末の っ は つ・く・ち・き のどれでもよい（復＝ふっ・日＝にっ・学＝がっ）
const devoice = (s) => String(s).normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC");
const looseForms = (s) => {
  const d = devoice(s);
  return d.endsWith("っ") ? ["つ", "く", "ち", "き"].map((x) => d.slice(0, -1) + x) : [d];
};
const looseKana = (s) => looseForms(s)[0];

function units(face) {
  // 字面を「漢字 1 字」「そのまま読む字」に分ける（記号・空白は落とした字面。かっこは落とす）。
  // 漢字にはさまれた ケ・ヶ・ヵ・カ（markFreeKana の FREE）と小さい ヵ・ヶ は ゖ（か・が・こ・け の 1 字）
  const out = [];
  for (const raw of markFreeKana(face).replace(/\([^()]*\)/g, "").toLowerCase()) {
    if (/[\p{P}\p{S}\p{Z}\s]/u.test(raw)) continue;
    const c = raw === FREE || /[ヵヶゕゖ]/.test(raw) ? "ゖ" : toHira(raw);
    if (KANJI.test(c)) out.push({ k: c });
    else out.push({ lit: c });
  }
  return out;
}

// face を reading に並べる方法を全部（上限つき）。返り値: [[{k, kana}...], ...]（漢字の分だけ）
function alignments(face, reading, limit = 3000) {
  const u = units(face);
  const r = [...reading];
  const res = [];
  // 残りの字で使う かな の数の下限・上限（枝を刈る）
  const lo = new Array(u.length + 1).fill(0), hi = new Array(u.length + 1).fill(0);
  for (let i = u.length - 1; i >= 0; i--) {
    const x = u[i];
    const [a, b] = x.k ? [1, 6] : x.lit === "ー" || /[ぁぃぅぇぉ]/.test(x.lit) ? [0, 1] : /[ぁ-ゖ]/.test(x.lit) ? [1, 1] : [0, 7];
    lo[i] = lo[i + 1] + a;
    hi[i] = hi[i + 1] + b;
  }
  const litOk = (c, x) => {
    if (c === x) return true;
    if (c === "ゖ") return "かがこけ".includes(x);
    if (c === "は") return x === "わ";
    if (c === "へ") return x === "え";
    if (c === "を") return x === "お";
    if (c === "づ") return x === "ず";
    if (c === "ぢ") return x === "じ";
    return false;
  };
  const go = (i, j, acc) => {
    if (res.length >= limit) return;
    const rest = r.length - j;
    if (rest < lo[i] || rest > hi[i]) return;
    if (i === u.length) {
      if (j === r.length) res.push(acc.slice());
      return;
    }
    const x = u[i];
    if (x.k) {
      for (let n = 1; n <= 6 && j + n <= r.length; n++) {
        acc.push({ k: x.k, kana: r.slice(j, j + n).join("") });
        go(i + 1, j + n, acc);
        acc.pop();
      }
      return;
    }
    if (x.lit === "ー") {
      if (r[j] === "ー" || /[あいうえお]/.test(r[j] ?? "")) go(i + 1, j + 1, acc);
      go(i + 1, j, acc);
      return;
    }
    if (/[a-z0-9]/.test(x.lit) || !/[ぁ-ゖ]/.test(x.lit)) {
      // 英字・数字・ギリシャ文字: 書いたまま か かな 0〜6（「X」→ えっくす）。並べ方の重みには入れない
      if (r[j] === x.lit) go(i + 1, j + 1, acc);
      for (let n = 0; n <= 6 && j + n <= r.length; n++) go(i + 1, j + n, acc);
      return;
    }
    if (litOk(x.lit, r[j])) go(i + 1, j + 1, acc);
    else if (/[ぁぃぅぇぉ]/.test(x.lit)) go(i + 1, j, acc);
  };
  go(0, 0, []);
  return res;
}

export function buildTable(pairs, { iters = 5 } = {}) {
  const data = [];
  for (const p of pairs) {
    const al = alignments(p.face, p.reading);
    if (al.length && al[0].length) data.push(al);
  }
  let prob = null; // Map(kanji → Map(kana → p))
  const P = (k, kana) => {
    if (!prob) return 1;
    const m = prob.get(k);
    return (m?.get(kana) ?? 0) + 1e-4;
  };
  let count;
  for (let it = 0; it <= iters; it++) {
    count = new Map();
    for (const al of data) {
      const ws = al.map((a) => a.reduce((w, s) => w * P(s.k, s.kana), 1));
      const sum = ws.reduce((a, b) => a + b, 0) || 1;
      al.forEach((a, n) => {
        const w = ws[n] / sum;
        if (w < 1e-6) return;
        for (const s of a) {
          if (!count.has(s.k)) count.set(s.k, new Map());
          const m = count.get(s.k);
          m.set(s.kana, (m.get(s.kana) ?? 0) + w);
        }
      });
    }
    prob = new Map();
    for (const [k, m] of count) {
      const tot = [...m.values()].reduce((a, b) => a + b, 0);
      prob.set(k, new Map([...m].map(([kana, c]) => [kana, c / tot])));
    }
  }
  // 確かな読み: 期待値の回数が 0.5 以上（並べ方のどれかでたまたま付いた読みは数えない）
  const sure = new Map();
  for (const [k, m] of count) sure.set(k, new Set([...m].filter(([, c]) => c >= 0.5).map(([kana]) => kana)));
  const looseSure = new Map([...sure].map(([k, set]) => [k, new Set([...set].map(looseKana))]));
  // 知っている字 = 確かな読みが 1 つ以上ある字（期待値の回数が散って確かな読みの無い字は、知らない字と同じに通す）
  return { count, sure, looseSure, known: new Set([...sure].filter(([, set]) => set.size > 0).map(([k]) => k)) };
}

// 裏付けの判定は並べ方を数え上げず、位置ごとの表（DP）で「どの漢字も確かな読み（ゆるく）か知らない字」で並ぶかを見る。
// 並ばないときの説明には、数え上げの最初の並べ方（上限つき）で裏付けの無い字を出す
export function supported(table, face, reading) {
  const u = units(face);
  const r = [...reading];
  const okK = (k, kana) => !table.known.has(k) || table.sure.get(k).has(kana) || looseForms(kana).some((x) => table.looseSure.get(k).has(x));
  const litOk = (c, x) => c === x || (c === "ゖ" && "かがこけ".includes(x)) || (c === "は" && x === "わ") || (c === "へ" && x === "え") || (c === "を" && x === "お") || (c === "づ" && x === "ず") || (c === "ぢ" && x === "じ");
  const memo = new Map();
  const go = (i, j) => {
    const key = i * 1000 + j;
    if (memo.has(key)) return memo.get(key);
    let ok = false;
    if (i === u.length) ok = j === r.length;
    else {
      const x = u[i];
      if (x.k) for (let n = 1; n <= 6 && j + n <= r.length && !ok; n++) ok = okK(x.k, r.slice(j, j + n).join("")) && go(i + 1, j + n);
      else if (x.lit === "ー") ok = ((r[j] === "ー" || /[あいうえお]/.test(r[j] ?? "")) && go(i + 1, j + 1)) || go(i + 1, j);
      else if (/[a-z0-9]/.test(x.lit) || !/[ぁ-ゖ]/.test(x.lit)) {
        ok = r[j] === x.lit && go(i + 1, j + 1);
        for (let n = 0; n <= 6 && j + n <= r.length && !ok; n++) ok = go(i + 1, j + n);
      } else if (litOk(x.lit, r[j])) ok = go(i + 1, j + 1);
      else if (/[ぁぃぅぇぉ]/.test(x.lit)) ok = go(i + 1, j);
    }
    memo.set(key, ok);
    return ok;
  };
  if (go(0, 0)) return { ok: true, unknown: u.filter((x) => x.k && !table.known.has(x.k)).length, bad: [] };
  let best = null;
  for (const a of alignments(face, reading, 500)) {
    const bad = a.filter((s) => !okK(s.k, s.kana));
    if (!best || bad.length < best.bad.length) best = { ok: false, unknown: 0, bad, align: a };
  }
  return best ?? { ok: false, unknown: 0, bad: [], align: null };
}
