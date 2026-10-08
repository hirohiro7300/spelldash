// ===== 日本語の答えを「読みのローマ字」で打つ =====
// 日本語の答え（鎌倉幕府 など）は、漢字への変換をせず、読みをローマ字で打つ（2026-10 創業者指示）。
// このモジュールは打鍵の判定だけを持つ。DOM に触らず、他のモジュールも読み込まない
// （scripts/validate-words.mjs と scripts/test-romaji.mjs が Node から読み込む）。
//
// ── 読み（候補）──────────────────────────────────────────────
//   normalizeReading(text)  NFKC → カタカナをひらがなに → 記号・空白を落とす → 小文字。ー は残す
//   displayReading(text)    表示用。normalizeReading と 1 文字ずつ対応する（カタカナ・大文字はそのまま）
//   isReading(s)            正規化済みの文字列が ひらがな／ー／a-z／0-9 だけか
//   hasKana(s)              ひらがなを含むか（ラテン文字だけの「読み」と見分ける）
//   isJapaneseAnswer(card)  答えが ASCII 以外を含むか
//   hasJapaneseScript(text) かな・漢字を含むか（ゲームがローマ字モードにする答え。CPC÷CVR のような記号だけの非 ASCII は含まない）
//   readingEntries(card)    [answer, ...accept] のうち読みになるもの [{ reading, display }]（重複なし・データ順）
//   readingCandidates(card) 上の reading だけ（string[]）
//   primaryReading(list)    答えを見せるときの読み。ひらがなを含む最初のもの、なければ先頭（list は文字列でも entry でも可）
//
// ── 判定 ────────────────────────────────────────────────────
//   createRomajiMatcher(candidates)  candidates: 文字列（生でも正規化済みでも可）か {reading, display} の配列
//     .feed(key)   1 打鍵。→ { ok, ignored, done, finished, expected, key }
//                    ok:false & ignored:true … ローマ字のキーではない（空白・記号・Shift など）。ミスにしない
//                    ok:false & ignored:false … どの読みのどの綴りにも続かない＝ミス。状態は変えない
//                    done      … どれかの読みを打ち終えた。ここで即終了する（Enter も変換も無し）
//                    finished  … 打ち終えた読みの番号（done のときだけ入る）
//                    expected  … ミスのとき、正しい綴りなら次に来たキー（キーミス記録用。分からなければ ""）
//     .type(keys)  文字列をまとめて feed。最初のミスで止まる。→ 最後の結果 + { missAt }（ミスなしは -1）
//     .state()     → { keys, committed:[{kana, keys}], pending, done, finished, canGrow, canContinue, endedWithSingleN,
//                      expected, candidate }
//                    committed … 確定したかなと、その下に出す打鍵（2 段表示用）。kana は読みの表記どおり
//                                （カタカナの読みならカタカナ）。きゃ・ふぁ などは 1 つにまとまる
//                    pending   … まだかなにならない打鍵（末尾に出す）。読みのまだ打っていない部分は含まない
//                    canGrow   … 打ち終えていない、より長い読みがまだ残っている（いわじゅく の後の いわじゅくいせき）
//                    canContinue … まだ続けて打てるキーがある（canGrow に加え、語末の ん を n 1 つで終えた後の 2 つ目の n）。
//                                打ち終えた直後の打鍵を次の語に持ち越さない判断用（js/game.js）
//                    endedWithSingleN … 末尾の ん を n 1 つで打ち終えた
//                    candidate … 表示が追っている読みの番号
//     .hint()      次の 1 かなを打つためのキー → { kana, keys } | null（終わっていれば null）
//     .firstKana() 主な読みの最初のかな（拗音は 2 文字。例「きょ」「ファ」）
//     .reset()     打鍵を消す
//     .readings / .entries / .primary  正規化済みの読み・表示形・主な読みの番号
//   matchRomaji(candidates, keys)    状態を持たない版。→ state() と同じ + { alive, missAt }
//   canonicalRomaji(reading, {finalN})  各かなの最初の綴りで作った打鍵列（ん は nn。finalN:true なら末尾の ん だけ n）
//
// ── キー ────────────────────────────────────────────────────
//   normalizeRomajiKey(key)  1 文字を判定用のキーに（a-z 0-9 ' -）。ー・全角は変換、それ以外は null
//   romajiKeyOf(event)       KeyboardEvent 風の {key, code, ctrlKey, metaKey, altKey} からキーを得る。
//                            key が Process／Unidentified／かな（JIS かな配列）のときは code（KeyA／Digit1／Minus）を使う。
//                            修飾キー付き・Enter・Backspace・空白・ASCII 記号は null
//
// ── 綴りの規則 ───────────────────────────────────────────────
//  ・ヘボン式と訓令式の両方: shi/si/ci, chi/ti, tsu/tu, fu/hu, ji/zi, sha/sya, cha/tya/cya, ja/zya/jya,
//    ka/ca, ku/cu/qu, ko/co, se/ce, ぢ di/ji/zi, づ du/zu, を wo/o, ゐ wi/wyi, ゑ we/wye, ゔ vu
//    （ぢ・づ・を は IME と違い ji・zu・o も受ける。書院造＝しょいんづくり を shoinzukuri と打った人は読みを思い出せている）
//  ・拗音・外来音: kya…, ふぁ fa/fwa, てぃ thi, でぃ dhi, とぅ twu, どぅ dwu, うぃ wi/whi, うぇ we/whe, うぉ who,
//    いぇ ye, ゔぁ va, つぁ tsa, くぁ qa/kwa/qwa, ぐぁ gwa, すぃ swi など。き+ゃ を ki+xya と分けても可
//  ・小さいかな: x か l + 母音（xa la xi li xya lya xwa xka xke）
//  ・っ: 次のかなの子音を重ねる（kitte, maccha）。ch の前は t も可（matcha）。xtu ltu xtsu ltsu も可。
//    母音・n・ー・ラテン文字の前、語末は xtu など
//  ・ん: nn, n', xn。n 1 つは、次の打鍵が母音でも y でもないとき（な行の前も可: konnichiha）。
//    語末の ん は n 1 つで打ち終わる。
//    ヘボン式の m（shimbun）は受け付けない。IME も m を ん にしないので、IME と同じ打ち方に揃える
//  ・ー は -。ラテン文字・数字は読みに書いてあるとおりに打つ（大文字小文字は区別しない）
//  ・読みの中の空白・記号（・ = & / ( ) 、 。 - など）は打たなくてよい（正規化で落ちる）
//
// ── 終わりの判定 ─────────────────────────────────────────────
//  どれかの読みを打ち終えたら done（即終了。創業者指示「打ち終わったら変換もなく終了」）。
//  長い読み（いわじゅくいせき）の手前に短い読み（いわじゅく）があれば短い方で終わる。どちらも正解なので構わない。
//  長い読みを打ち続けていた人の残りの打鍵（いせき）や、語末の ん の 2 つ目の n は、canContinue を見て
//  呼ぶ側（js/game.js）が次の語に持ち越さない。

// 読みに書かれていても打たなくてよい文字（記号・句読点・空白・制御）。ー（U+30FC）は文字（Lm）なので残る
const IGNORABLE = /[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}\s]/gu;
const VOWELS = "aiueo";
const READING_RE = /^[ぁ-ゖーa-z0-9]+$/;
const KANA_RE = /[ぁ-ゖ]/;
const SMALL_KANA = /^[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]$/;

function toHiragana(s) {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function displayReading(text) {
  return String(text ?? "").normalize("NFKC").replace(IGNORABLE, "");
}

export function normalizeReading(text) {
  return toHiragana(displayReading(text)).toLowerCase();
}

export function isReading(s) {
  return typeof s === "string" && READING_RE.test(s);
}

export function hasKana(s) {
  return KANA_RE.test(String(s ?? ""));
}

function answerOf(card) {
  return String(card?.answer ?? card?.en ?? "");
}

export function isJapaneseAnswer(card) {
  const a = answerOf(card).trim();
  return a !== "" && !/^[\x00-\x7f]*$/.test(a);
}

// かな（ひらがな・カタカナ・半角カナ）か漢字を含む
const JAPANESE_SCRIPT_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f々〆]/;
export function hasJapaneseScript(text) {
  return JAPANESE_SCRIPT_RE.test(String(text ?? ""));
}

function entryOf(text) {
  if (text && typeof text === "object") {
    const reading = normalizeReading(text.reading);
    const display = text.display != null ? displayReading(text.display) : reading;
    return { reading, display: display.length === reading.length ? display : reading };
  }
  const reading = normalizeReading(text);
  const display = displayReading(text);
  // 表示形は 1 文字ずつ読みと対応させる（ずれる文字があれば読みをそのまま見せる）
  return { reading, display: display.length === reading.length ? display : reading };
}

function uniqueEntries(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const e = entryOf(item);
    if (!isReading(e.reading) || seen.has(e.reading)) continue;
    seen.add(e.reading);
    out.push(e);
  }
  return out;
}

export function readingEntries(card) {
  const accept = Array.isArray(card?.accept) ? card.accept : [];
  return uniqueEntries([answerOf(card), ...accept]);
}

export function readingCandidates(card) {
  return readingEntries(card).map((e) => e.reading);
}

function readingText(item) {
  return typeof item === "string" ? item : item?.reading ?? "";
}

function primaryIndex(list) {
  const i = list.findIndex((r) => hasKana(readingText(r)));
  return i >= 0 ? i : 0;
}

export function primaryReading(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[primaryIndex(list)];
}

// ── 綴りの表 ──────────────────────────────────────────────

const ONE = {
  あ: ["a"], い: ["i", "yi"], う: ["u", "wu", "whu"], え: ["e"], お: ["o"],
  か: ["ka", "ca"], き: ["ki"], く: ["ku", "cu", "qu"], け: ["ke"], こ: ["ko", "co"],
  さ: ["sa"], し: ["shi", "si", "ci"], す: ["su"], せ: ["se", "ce"], そ: ["so"],
  た: ["ta"], ち: ["chi", "ti"], つ: ["tsu", "tu"], て: ["te"], と: ["to"],
  な: ["na"], に: ["ni"], ぬ: ["nu"], ね: ["ne"], の: ["no"],
  は: ["ha"], ひ: ["hi"], ふ: ["fu", "hu"], へ: ["he"], ほ: ["ho"],
  ま: ["ma"], み: ["mi"], む: ["mu"], め: ["me"], も: ["mo"],
  や: ["ya"], ゆ: ["yu"], よ: ["yo"],
  ら: ["ra"], り: ["ri"], る: ["ru"], れ: ["re"], ろ: ["ro"],
  わ: ["wa"], ゐ: ["wi", "wyi"], ゑ: ["we", "wye"], を: ["wo", "o"],
  が: ["ga"], ぎ: ["gi"], ぐ: ["gu"], げ: ["ge"], ご: ["go"],
  ざ: ["za"], じ: ["ji", "zi"], ず: ["zu"], ぜ: ["ze"], ぞ: ["zo"],
  だ: ["da"], ぢ: ["di", "ji", "zi"], づ: ["du", "zu"], で: ["de"], ど: ["do"],
  ば: ["ba"], び: ["bi"], ぶ: ["bu"], べ: ["be"], ぼ: ["bo"],
  ぱ: ["pa"], ぴ: ["pi"], ぷ: ["pu"], ぺ: ["pe"], ぽ: ["po"],
  ゔ: ["vu"],
  ぁ: ["xa", "la"], ぃ: ["xi", "li", "xyi", "lyi"], ぅ: ["xu", "lu"], ぇ: ["xe", "le", "xye", "lye"], ぉ: ["xo", "lo"],
  ゃ: ["xya", "lya"], ゅ: ["xyu", "lyu"], ょ: ["xyo", "lyo"], ゎ: ["xwa", "lwa"], ゕ: ["xka", "lka"], ゖ: ["xke", "lke"],
  っ: ["xtu", "ltu", "xtsu", "ltsu"],
  ー: ["-"]
};

// 2 文字で 1 つの音（拗音・外来音）
const TWO = {};
function addTwo(kana, list) {
  TWO[kana] = [...(TWO[kana] ?? []), ...list];
}
// き・し・ち などの拗音: 小さい ゃ ぃ ゅ ぇ ょ（kya kyi kyu kye kyo）
const SMALL_Y = { ゃ: "a", ぃ: "i", ゅ: "u", ぇ: "e", ょ: "o" };
for (const [head, c] of [["き", "k"], ["ぎ", "g"], ["に", "n"], ["ひ", "h"], ["び", "b"], ["ぴ", "p"], ["み", "m"], ["り", "r"], ["ぢ", "d"]]) {
  for (const [small, v] of Object.entries(SMALL_Y)) addTwo(head + small, [`${c}y${v}`]);
}
for (const [small, v] of Object.entries(SMALL_Y)) {
  addTwo(`し${small}`, v === "i" ? ["syi"] : [`sh${v}`, `sy${v}`]);
  addTwo(`ち${small}`, v === "i" ? ["tyi", "cyi"] : [`ch${v}`, `ty${v}`, `cy${v}`]);
  addTwo(`じ${small}`, v === "i" ? ["zyi", "jyi"] : [`j${v}`, `zy${v}`, `jy${v}`]);
  addTwo(`ぢ${small}`, v === "i" ? ["zyi", "jyi"] : [`j${v}`, `zy${v}`, `jy${v}`]); // dy… の後に（ぢゃ も じゃ と同じに打てる）
  addTwo(`て${small}`, [`th${v}`]);
  addTwo(`で${small}`, [`dh${v}`]);
}
Object.assign(TWO, {
  ふぁ: ["fa", "fwa"], ふぃ: ["fi", "fwi", "fyi"], ふぅ: ["fwu"], ふぇ: ["fe", "fwe", "fye"], ふぉ: ["fo", "fwo"],
  ふゃ: ["fya"], ふゅ: ["fyu"], ふょ: ["fyo"],
  ゔぁ: ["va"], ゔぃ: ["vi", "vyi"], ゔぇ: ["ve", "vye"], ゔぉ: ["vo"], ゔゃ: ["vya"], ゔゅ: ["vyu"], ゔょ: ["vyo"],
  くぁ: ["qa", "qwa", "kwa"], くぃ: ["qi", "qwi", "qyi"], くぅ: ["qwu"], くぇ: ["qe", "qwe", "qye"], くぉ: ["qo", "qwo"],
  くゃ: ["qya"], くゅ: ["qyu"], くょ: ["qyo"],
  ぐぁ: ["gwa"], ぐぃ: ["gwi"], ぐぅ: ["gwu"], ぐぇ: ["gwe"], ぐぉ: ["gwo"],
  うぁ: ["wha"], うぃ: ["wi", "whi"], うぇ: ["we", "whe"], うぉ: ["who"],
  いぇ: ["ye"],
  つぁ: ["tsa"], つぃ: ["tsi"], つぇ: ["tse"], つぉ: ["tso"],
  とぁ: ["twa"], とぃ: ["twi"], とぅ: ["twu"], とぇ: ["twe"], とぉ: ["two"],
  どぁ: ["dwa"], どぃ: ["dwi"], どぅ: ["dwu"], どぇ: ["dwe"], どぉ: ["dwo"],
  すぁ: ["swa"], すぃ: ["swi"], すぅ: ["swu"], すぇ: ["swe"], すぉ: ["swo"]
});

const N_OPTIONS = [
  { keys: "nn", len: 1, parts: [{ len: 1, keys: "nn" }] },
  { keys: "n'", len: 1, parts: [{ len: 1, keys: "n'" }] },
  { keys: "xn", len: 1, parts: [{ len: 1, keys: "xn" }] },
  // n 1 つ: 次の打鍵が母音・y なら認めない（guard）
  { keys: "n", len: 1, parts: [{ len: 1, keys: "n" }], guard: true }
];

function simple(keys, len) {
  return { keys, len, parts: [{ len, keys }] };
}

// 読み r の位置 i で打てる綴りの一覧（先頭がいちばん普通の綴り）
function buildOptions(r, i, memo) {
  if (memo[i]) return memo[i];
  const ch = r[i];
  let out = [];
  if (ch === undefined) out = [];
  else if (/[a-z0-9]/.test(ch)) out = [simple(ch, 1)];
  else if (ch === "ん") out = N_OPTIONS;
  else {
    for (const k of TWO[r.slice(i, i + 2)] ?? []) out.push(simple(k, 2));
    if (ch === "っ" && KANA_RE.test(r[i + 1] ?? "")) {
      for (const o of buildOptions(r, i + 1, memo)) {
        const c = o.keys[0];
        if (!/[a-z]/.test(c) || VOWELS.includes(c) || c === "n") continue;
        out.push({ keys: c + o.keys, len: 1 + o.len, parts: [{ len: 1, keys: c }, ...o.parts], guard: o.guard });
        if (o.keys.startsWith("ch")) out.push({ keys: `t${o.keys}`, len: 1 + o.len, parts: [{ len: 1, keys: "t" }, ...o.parts], guard: o.guard });
      }
    }
    for (const k of ONE[ch] ?? []) out.push(simple(k, 1));
  }
  memo[i] = out;
  return out;
}

export function canonicalRomaji(reading, { finalN = false } = {}) {
  const r = normalizeReading(reading);
  if (!isReading(r)) return null;
  const memo = [];
  let out = "";
  let i = 0;
  while (i < r.length) {
    const o = buildOptions(r, i, memo)[0];
    if (!o) return null;
    out += finalN && r[i] === "ん" && i === r.length - 1 ? "n" : o.keys;
    i += o.len;
  }
  return out;
}

// ── キー ──────────────────────────────────────────────────

export function normalizeRomajiKey(key) {
  if (typeof key !== "string" || [...key].length !== 1) return null;
  const k = key.normalize("NFKC").toLowerCase();
  if (/^[a-z0-9'-]$/.test(k)) return k;
  if (k === "ー" || k === "‐" || k === "−" || k === "–") return "-";
  if (k === "’") return "'";
  return null;
}

export function romajiKeyOf(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = typeof event.key === "string" ? event.key : "";
  if ([...key].length === 1) {
    const k = normalizeRomajiKey(key);
    if (k) return k;
    if (/^[\x00-\x7f]$/.test(key)) return null; // 空白・ASCII の記号はローマ字のキーではない
  } else if (key && key !== "Process" && key !== "Unidentified" && key !== "Dead") {
    return null; // Enter・Backspace・Shift・矢印など
  }
  // IME が打鍵を受け取っている（Process）か、かな配列でかなが来た: 物理キーの位置で読む
  const code = String(event.code ?? "");
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if ((m = /^(?:Digit|Numpad)(\d)$/.exec(code))) return m[1];
  if (code === "Minus" || code === "NumpadSubtract") return "-";
  return null;
}

// ── 判定 ──────────────────────────────────────────────────
// 状態 = { c: 読みの番号, i: 読みの位置, buf: まだかなにならない打鍵, guard: 直前が n 1 つの ん, segs: 確定したかな }
// 打鍵ごとに、生き残っている状態をすべて進める（読み 1 つあたり数個。毎打鍵やり直しても軽い）

function compile(candidates) {
  const entries = uniqueEntries(Array.isArray(candidates) ? candidates : []);
  return entries.map((e) => ({ ...e, memo: [] }));
}

function optionsOf(cand, i) {
  return buildOptions(cand.reading, i, cand.memo);
}

function segsOf(cand, pos, option) {
  let p = pos;
  return option.parts.map((part) => {
    const seg = { kana: cand.display.slice(p, p + part.len), keys: part.keys };
    p += part.len;
    return seg;
  });
}

const blockedAfterSingleN = (k) => VOWELS.includes(k) || k === "y";

function step(cands, states, k) {
  const next = new Map();
  const put = (s) => {
    const id = `${s.c}|${s.i}|${s.buf}|${s.guard ? 1 : 0}`;
    if (!next.has(id)) next.set(id, s);
  };
  for (const s of states) {
    if (s.guard && s.buf === "" && blockedAfterSingleN(k)) continue;
    const cand = cands[s.c];
    const buf = s.buf + k;
    for (const o of optionsOf(cand, s.i)) {
      if (o.keys === buf) put({ c: s.c, i: s.i + o.len, buf: "", guard: !!o.guard, segs: [...s.segs, ...segsOf(cand, s.i, o)] });
      else if (o.keys.startsWith(buf)) put({ c: s.c, i: s.i, buf, guard: false, segs: s.segs });
    }
  }
  return [...next.values()];
}

const isDoneState = (cands, s) => s.buf === "" && s.i === cands[s.c].reading.length;

// この状態で次に打てる綴り（n 1 つの直後なら母音・y で始まるものを除く）
function liveOptions(cands, s) {
  return optionsOf(cands[s.c], s.i).filter((o) => o.keys.startsWith(s.buf) && o.keys.length > s.buf.length && !(s.guard && s.buf === "" && blockedAfterSingleN(o.keys[0])));
}

// 2 段表示に出す形。打ち途中の綴りは「その先まで打った部分」だけかなにする（kk → っ + k、t だけなら t のまま）。
// n 1 つで打った ん は、次の打鍵で決まるまで n のまま見せる（IME と同じ）
function viewOf(cands, s) {
  const cand = cands[s.c];
  if (s.guard && s.buf === "" && s.i < cand.reading.length) {
    return { committed: s.segs.slice(0, -1), pending: s.segs[s.segs.length - 1]?.keys ?? "" };
  }
  if (!s.buf) return { committed: s.segs, pending: "" };
  const o = optionsOf(cand, s.i).find((x) => x.keys.startsWith(s.buf) && x.keys.length > s.buf.length);
  const extra = [];
  let used = 0;
  let pos = s.i;
  for (const part of o?.parts ?? []) {
    if (used + part.keys.length >= s.buf.length) break;
    extra.push({ kana: cand.display.slice(pos, pos + part.len), keys: part.keys });
    used += part.keys.length;
    pos += part.len;
  }
  return { committed: extra.length ? [...s.segs, ...extra] : s.segs, pending: s.buf.slice(used) };
}

function kanaCount(segs) {
  return segs.reduce((n, seg) => n + seg.kana.length, 0);
}

// 表示に使う状態の順: 進んだかなが多い → 残りの打鍵が短い → 主な読み → n 1 つの仮の ん でない → 読みの番号
function rankStates(cands, states, primary) {
  return states
    .map((s, order) => ({ s, view: viewOf(cands, s), order }))
    .sort((a, b) =>
      kanaCount(b.view.committed) - kanaCount(a.view.committed) ||
      a.view.pending.length - b.view.pending.length ||
      (a.s.c === primary ? 0 : 1) - (b.s.c === primary ? 0 : 1) ||
      (a.s.guard ? 1 : 0) - (b.s.guard ? 1 : 0) ||
      a.s.c - b.s.c ||
      a.order - b.order
    );
}

function summarize(cands, states, keys, primary) {
  const ranked = rankStates(cands, states, primary);
  const doneStates = states.filter((s) => isDoneState(cands, s));
  const doneSet = new Set(doneStates.map((s) => s.c));
  // 打ち終えた読みが複数（ゐ と うぃ を wi）なら主な読み → 番号の小さい方
  const finishedState = doneSet.has(primary) ? doneStates.find((s) => s.c === primary) : doneStates.sort((a, b) => a.c - b.c)[0];
  const finished = finishedState ? finishedState.c : null;
  const canGrow = states.some((s) => !isDoneState(cands, s) && !doneSet.has(s.c));
  const canContinue = states.some((s) => liveOptions(cands, s).length > 0);
  let expected = "";
  for (const { s } of ranked) {
    const o = liveOptions(cands, s)[0];
    if (o) {
      expected = o.keys[s.buf.length];
      break;
    }
  }
  const best = finishedState ? { s: finishedState, view: viewOf(cands, finishedState) } : ranked[0];
  return {
    keys,
    committed: best ? best.view.committed.map((seg) => ({ ...seg })) : [],
    pending: best ? best.view.pending : keys,
    done: finished !== null,
    finished,
    canGrow,
    canContinue,
    endedWithSingleN: !!finishedState?.guard,
    expected,
    candidate: best ? best.s.c : null
  };
}

export function createRomajiMatcher(candidates) {
  const cands = compile(candidates);
  const primary = primaryIndex(cands);
  const start = () => cands.map((_, c) => ({ c, i: 0, buf: "", guard: false, segs: [] }));
  let states = start();
  let keys = "";

  const state = () => summarize(cands, states, keys, primary);

  function feed(rawKey) {
    const k = normalizeRomajiKey(rawKey);
    if (!k) {
      const s = state();
      return { ok: false, ignored: true, done: s.done, finished: s.finished, expected: s.expected, key: null };
    }
    const next = step(cands, states, k);
    if (next.length === 0) {
      const s = state();
      return { ok: false, ignored: false, done: s.done, finished: s.finished, expected: s.expected, key: k };
    }
    states = next;
    keys += k;
    const s = state();
    return { ok: true, ignored: false, done: s.done, finished: s.finished, expected: s.expected, key: k };
  }

  function type(text) {
    const s0 = state();
    let last = { ok: true, ignored: false, done: s0.done, finished: s0.finished, expected: s0.expected, key: null };
    let missAt = -1;
    [...String(text ?? "")].some((ch, idx) => {
      last = feed(ch);
      if (!last.ok && !last.ignored) {
        missAt = idx;
        return true;
      }
      return false;
    });
    return { ...last, missAt };
  }

  function hint() {
    const ranked = rankStates(cands, states, primary);
    for (const { s } of ranked) {
      const o = liveOptions(cands, s)[0];
      if (!o) continue;
      const cand = cands[s.c];
      return { kana: cand.display.slice(s.i, s.i + o.len), keys: o.keys.slice(s.buf.length) };
    }
    return null;
  }

  function firstKana() {
    const e = cands[primary];
    if (!e) return "";
    const chars = [...e.display];
    return chars[0] + (chars[1] && SMALL_KANA.test(chars[1]) ? chars[1] : "");
  }

  function reset() {
    states = start();
    keys = "";
  }

  return {
    feed,
    type,
    state,
    hint,
    firstKana,
    reset,
    get keys() {
      return keys;
    },
    readings: cands.map((c) => c.reading),
    entries: cands.map(({ reading, display }) => ({ reading, display })),
    primary: cands.length ? primary : null
  };
}

export function matchRomaji(candidates, keys) {
  const m = createRomajiMatcher(candidates);
  const r = m.type(keys);
  return { ...m.state(), alive: r.missAt === -1 && m.readings.length > 0, missAt: r.missAt };
}
