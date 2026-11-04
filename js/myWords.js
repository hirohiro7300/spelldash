// ===== マイ単語帳（自分専用の単語） =====
//
// 仕事・試験・読んでいる本の単語や熟語を自分で入れて、思い出して打って覚える。保存は spelldash_my_words（人ごとの領域の鍵: js/areaGuard.js。
// バックアップに入る）。語の定義と 3 状態は同期の項目 user_items の my_word に乗る（表があるときだけ: docs/SQL_USER_ITEMS.md・js/userItemsSync.js）。
// 決まり（入れられる英語・出題のカード・3 状態・学ぶ回の列）は js/myWordsCore.js（純）、画面は mywords.html（js/myWordsPage.js）、学ぶ回は js/game.js（/?learn=my）。
// 仕様は docs/SPEC_MY_WORDS.md（Batch 79）

import { touchItem } from "./userItemsSync.js";
import { isSpellAlt } from "./answers.js";
import { isPro } from "./plan.js";
import { canOfferPro } from "./proFunnel.js";
import { isAnswerKind } from "./learnState.js";
import { checkEnText, checkJaText, wordCardOf, parseWordLine, applyMyAnswer, MY_FREE_LIMIT, MY_PRO_LIMIT } from "./myWordsCore.js";

const KEY = "spelldash_my_words";

// 追加できる語数の上限（無料 100 語・Pro 1,000 語）。上限を超えて持っている人も閲覧・削除はできる（追加だけ止まる）
export function maxMyWords() {
  return isPro() ? MY_PRO_LIMIT : MY_FREE_LIMIT;
}

// 上限の文（表示側はこの文のときだけ「Pro について」のリンクを続ける）
export function limitMessage() {
  if (isPro()) return "追加できるのは1,000語まで";
  // 受付前・アプリでは Pro の話をしない（買えないものを勧めない）
  return canOfferPro() ? "無料で追加できるのは100語まで（Pro なら1,000語）。" : "無料で追加できるのは100語まで。";
}

function limitError() {
  return limitMessage();
}

export function getMyWords() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list)
      ? list.filter((w) => w && w.en && (w.kind === "concept" ? w.q && w.answer : w.ja))
      : [];
  } catch {
    return [];
  }
}

// 場面カード用のキー（idに使う。日本語の答えもそのまま鍵にする）
export function conceptKey(answer) {
  return String(answer ?? "").normalize("NFKC").toLowerCase().replace(/[\s・／/]/g, "").slice(0, 40);
}

function save(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent("spelldash:mywords"));
}

// 出題用の単語オブジェクトへ（level は easy 固定: 自分で入れた語は難易度ゲートに関係なく即出題）
export function toWordObjects(list = getMyWords()) {
  return list.map((w) => {
    if (w.kind === "concept") {
      const answer = String(w.answer).trim();
      const spell = /^[a-z-]+$/i.test(answer);
      // 答えが英字（綴り入力: SSL・CPC）なら、別解は綴りで打てる語だけ（js/answers.js isSpellAlt: 半角の英字・数字・記号・空白。教材と同じ決まり）。
      // 打てない語（https化・クリック単価）は表示と検索だけの名前（aka。単語帳の「別名」）にする。保存した形は変えない（PR #191 のレビュー 2）
      const accept = Array.isArray(w.accept) ? w.accept : [];
      const aka = spell ? accept.filter((a) => !isSpellAlt(a)) : [];
      return {
        id: `my-q-${w.en}`,
        key: w.en,
        kind: "concept",
        en: spell ? answer.toLowerCase() : answer,
        answer,
        accept: spell ? accept.filter((a) => isSpellAlt(a)) : accept,
        ...(aka.length ? { aka } : {}),
        ja: w.ja || (w.explain ? w.explain.slice(0, 40) : "自分の場面カード"),
        q: w.q,
        explain: w.explain || "",
        level: "easy",
        tags: ["my-concept"],
        subject: "english",
        category: "my",
        addedAt: w.addedAt ?? null
      };
    }
    return wordCardOf(w); // 英語と訳の語（js/myWordsCore.js。前からの語の id・en・ja は前と同じ）
  });
}

// 場面カード: q（場面・意味）→ answer（用語。日本語OK）。explain（解説）・accept（別解）は任意
export function validateConcept({ q, answer, explain = "", accept = [] }, existing = getMyWords()) {
  const qq = String(q ?? "").trim();
  const a = String(answer ?? "").trim();
  const ex = String(explain ?? "").trim();
  const acc = (Array.isArray(accept) ? accept : String(accept ?? "").split(/[\/／,、]/))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!qq) return { ok: false, error: "場面（意味）を入力してください" };
  if (qq.length < 4) return { ok: false, error: "場面が短すぎます（4文字以上）" };
  if (qq.length > 160) return { ok: false, error: "場面が長すぎます（160文字まで）" };
  if (!a) return { ok: false, error: "答え（用語）を入力してください" };
  if (a.length > 40) return { ok: false, error: "答えが長すぎます（40文字まで）" };
  if (ex.length > 120) return { ok: false, error: "解説が長すぎます（120文字まで）" };
  const key = conceptKey(a);
  if (!key) return { ok: false, error: "答えに使える文字がありません" };
  if (existing.some((w) => w.kind === "concept" && w.en === key)) return { ok: false, error: `「${a}」の場面カードはすでにあります` };
  if (existing.length >= maxMyWords()) return { ok: false, error: limitError() };
  return { ok: true, entry: { kind: "concept", en: key, answer: a, q: qq, explain: ex, accept: acc, ja: ex ? ex.slice(0, 40) : "" } };
}

export function addMyConcept(fields) {
  const list = getMyWords();
  const v = validateConcept(fields, list);
  if (!v.ok) return v;
  list.push({ ...v.entry, addedAt: new Date().toISOString() });
  save(list);
  touchItem("my_word", v.entry.en);
  return { ok: true, en: v.entry.answer };
}

export function normalizeEn(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

// 英語と訳の 1 語を確かめる（js/myWordsCore.js checkEnText・checkJaText）。返り値 { ok, en（鍵）, ja, text（画面の形） } か { ok: false, error }
export function validateEntry(en, ja, existing = getMyWords()) {
  const e = checkEnText(en);
  if (!e.ok) return e;
  const j = checkJaText(ja);
  if (!j.ok) return j;
  if (existing.some((w) => w.en === e.key)) return { ok: false, error: `「${e.text}」はすでに登録されています` };
  if (existing.length >= maxMyWords()) return { ok: false, error: limitError() };
  return { ok: true, en: e.key, ja: j.ja, text: e.text };
}

// 保存する 1 語（画面の形 text は鍵と違うときだけ）
const entryOf = (v) => ({ en: v.en, ja: v.ja, ...(v.text !== v.en ? { text: v.text } : {}), addedAt: new Date().toISOString() });

export function addMyWord(en, ja) {
  const list = getMyWords();
  const v = validateEntry(en, ja, list);
  if (!v.ok) return v;
  list.push(entryOf(v));
  save(list);
  touchItem("my_word", v.en);
  return { ok: true, en: v.text, ja: v.ja };
}

// 学ぶ回の 1 問の答えを、その語の 3 状態に当てる（js/myWordsCore.js applyMyAnswer。js/game.js がマイ単語帳の回でだけ呼ぶ）。
// 保存の配列はそのまま読んで、その語だけを替える（形の読めない要素も消さない）。語の記録（spelldash_word_stats）には書かない。
// 同期の印（touchItem）を付ける: user_items の表があれば、ほかの端末にも 3 状態が届く。返り値: 保存できたら true（語が無い・保存に失敗したら false）
export function recordMyAnswer(key, kind, nowMs = Date.now()) {
  if (!isAnswerKind(kind)) return false;
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(list)) return false;
    const i = list.findIndex((w) => w && w.kind !== "concept" && w.en === key);
    if (i < 0) return false;
    list[i] = applyMyAnswer(list[i], kind, nowMs);
    localStorage.setItem(KEY, JSON.stringify(list)); // 答えのたびに一覧を描き直さない（spelldash:mywords は出さない）
    touchItem("my_word", key);
    return true;
  } catch {
    return false;
  }
}

// kind: "concept"（場面カード）／"word"（英単語）。省略時は鍵が同じものをすべて（英単語と場面カードの鍵は重なりうる）
export function removeMyWord(en, kind) {
  const same = (w) => w.en === en && (!kind || (w.kind === "concept") === (kind === "concept"));
  const list = getMyWords().filter((w) => !same(w));
  save(list);
  touchItem("my_word", en, true); // 墓標: 他の端末からも消える
}

// まとめて追加:
//   英単語:   1行に「英単語, 日本語」（カンマ・タブ・全角読点・スペース区切り）
//   場面カード: 1行に「場面 → 答え | 解説 | 別解1/別解2」（→ ⇒ => のいずれか。解説・別解は任意）
export function parseBulk(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(english|英単語|answer|q|場面)\s*[,\t]/i.test(line)) // CSVの見出し行は飛ばす
    .map((line) => {
      const arrow = line.match(/^(.+?)\s*(?:→|⇒|=>|->)\s*(.+)$/);
      if (arrow) {
        const [answer, explain = "", accept = ""] = arrow[2].split("|").map((s) => s.trim());
        return { kind: "concept", q: arrow[1].trim(), answer, explain, accept };
      }
      // 区切りはカンマ・タブ・全角読点を優先。無ければ英語と日本語の境、それも無ければ最初の空白で分ける（js/myWordsCore.js parseWordLine）
      return parseWordLine(line);
    });
}

export function addMyWordsBulk(text) {
  const list = getMyWords();
  const added = [];
  const skipped = [];
  for (const entry of parseBulk(text)) {
    if (entry.kind === "concept") {
      const v = validateConcept(entry, list);
      if (!v.ok) {
        skipped.push(`${entry.answer || "(空)"}: ${v.error}`);
        continue;
      }
      list.push({ ...v.entry, addedAt: new Date().toISOString() });
      added.push(v.entry.answer);
      touchItem("my_word", v.entry.en);
      continue;
    }
    const v = validateEntry(entry.en, entry.ja, list);
    if (!v.ok) {
      skipped.push(`${entry.en || "(空)"}: ${v.error}`);
      continue;
    }
    list.push(entryOf(v));
    added.push(v.text);
    touchItem("my_word", v.en);
  }
  if (added.length > 0) save(list);
  return { added, skipped };
}
