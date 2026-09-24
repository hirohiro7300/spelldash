// 別解（同じ訳になる別の英単語）の扱い。
//
// 「始める」と出して start だけを正解にすると、begin と打った人は
// 1文字目で不正解になる。正しい語を思い出せているのに打てない、という状態は
// 「思い出して打つ」練習として成り立たない（2026-09-24 創業者指摘: 受験生の声）。
//
// SpellDash は同じ訳を持つ語を自分のデータの中に持っている（広告 = ad / advertisement）。
// それを集めて「この訳ならこの語も正解」の表を作り、打っている途中の文字列が
// どれかに一致している限り受け入れる。
import { jaTokens } from "./jaAmbiguity.js";

// 訳の見出しとして比較できる形にする。かっこ書きは落とす（「たくさん（a ___ of）」→「たくさん」）
export function altKey(token) {
  return String(token ?? "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim();
}

// en → 別解の集合。全カードの訳を見て、同じ訳を持つ語どうしを結ぶ
export function buildAlternativeIndex(words) {
  const byMeaning = new Map();
  for (const w of words) {
    if (!w?.en || !w.ja || w.q || w.write || w.blank || w.calc || w.school) continue;
    if (!/^[a-z][a-z-]+$/.test(w.en)) continue;
    for (const token of jaTokens(w.ja)) {
      const key = altKey(token);
      if (key.length < 2) continue; // 1文字の訳は偶然ぶつかるので使わない
      if (!byMeaning.has(key)) byMeaning.set(key, new Set());
      byMeaning.get(key).add(w.en);
    }
  }
  const index = new Map();
  for (const ens of byMeaning.values()) {
    if (ens.size < 2) continue;
    for (const en of ens) {
      if (!index.has(en)) index.set(en, new Set());
      for (const other of ens) if (other !== en) index.get(en).add(other);
    }
  }
  return index;
}

// この語を出したときに正解として受け入れる綴りの一覧（先頭は必ず出題語）
export function acceptedAnswers(word, index) {
  const out = [word?.en].filter(Boolean);
  const push = (s) => {
    const v = String(s ?? "").toLowerCase().trim();
    if (v && !out.includes(v)) out.push(v);
  };
  // データに書かれた別解が最優先
  if (Array.isArray(word?.accept)) word.accept.forEach(push);
  // 同じ訳を持つ他のカードの語
  if (index && word?.en) (index.get(word.en) ?? []).forEach(push);
  return out;
}

// 打ち途中の文字列に対して、まだ可能性の残っている綴りを返す
export function viableAnswers(candidates, typed) {
  const prefix = String(typed ?? "").toLowerCase();
  return candidates.filter((c) => c.startsWith(prefix));
}

// つづり違い（favourite / favorite、practise / practice、maths / math）は「別の語」ではなく
// 同じ語の綴り違い。別解として案内するのではなく、そのまま正解にする。
// 先頭が同じで、編集距離が語長の1/4以内（最低1、最大3）なら同じ語とみなす。
export function isSpellingVariant(a, b) {
  const x = String(a ?? "").toLowerCase();
  const y = String(b ?? "").toLowerCase();
  if (!x || !y || x === y) return false;
  if (x[0] !== y[0]) return false;
  const limit = Math.min(3, Math.max(1, Math.floor(Math.max(x.length, y.length) / 4)));
  if (Math.abs(x.length - y.length) > limit) return false;
  // 編集距離（limit を超えたら打ち切る）
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    if (Math.min(...cur) > limit) return false;
    prev = cur;
  }
  return prev[y.length] <= limit;
}

// いま打ち終わっているか。出題語を優先し、まだ伸びる綴りが残っている間は完成としない
// （出題語が advertisement で別解が ad のとき、"ad" で止めない）
export function completedAnswer(candidates, typed, { force = false } = {}) {
  const prefix = String(typed ?? "").toLowerCase();
  const viable = viableAnswers(candidates, prefix);
  const exact = viable.filter((c) => c === prefix);
  if (exact.length === 0) return null;
  const canGrow = viable.some((c) => c.length > prefix.length);
  if (canGrow && !force) return null;
  // 出題語（candidates[0]）に一致しているならそれを返す
  return exact.includes(candidates[0]) ? candidates[0] : exact[0];
}
