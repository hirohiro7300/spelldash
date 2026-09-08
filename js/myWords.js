// ===== マイ単語帳（自分専用の単語） =====
//
// 仕事・試験・読んでいる本の単語を自分で入れて、同じ仕組み（思い出して打つ・
// Recall Loop・復習期日）で覚える。端末ローカル保存（spelldash_my_words）。
// 学習記録は既存の word_progress（word_id = "my-<en>"）にそのまま乗る。
// ※単語定義そのものの端末間同期は未対応（将来 my_words テーブル: SQL承認案件）

const KEY = "spelldash_my_words";
const MAX_WORDS = 500;
const EN_PATTERN = /^[a-z][a-z-]*$/;

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
      return {
        id: `my-q-${w.en}`,
        key: w.en,
        kind: "concept",
        en: spell ? answer.toLowerCase() : answer,
        answer,
        accept: Array.isArray(w.accept) ? w.accept : [],
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
    return {
      id: `my-${w.en}`,
      en: w.en,
      ja: w.ja,
      level: "easy",
      tags: ["my"],
      subject: "english",
      category: "my",
      addedAt: w.addedAt ?? null
    };
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
  if (existing.length >= MAX_WORDS) return { ok: false, error: `登録できるのは${MAX_WORDS}語までです` };
  return { ok: true, entry: { kind: "concept", en: key, answer: a, q: qq, explain: ex, accept: acc, ja: ex ? ex.slice(0, 40) : "" } };
}

export function addMyConcept(fields) {
  const list = getMyWords();
  const v = validateConcept(fields, list);
  if (!v.ok) return v;
  list.push({ ...v.entry, addedAt: new Date().toISOString() });
  save(list);
  return { ok: true, en: v.entry.answer };
}

export function normalizeEn(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

export function validateEntry(en, ja, existing = getMyWords()) {
  const e = normalizeEn(en);
  const j = String(ja ?? "").trim();
  if (!e) return { ok: false, error: "英単語を入力してください" };
  if (!EN_PATTERN.test(e)) return { ok: false, error: `「${e}」は英小文字（a-z）とハイフンのみ使えます` };
  if (e.length > 30) return { ok: false, error: "英単語が長すぎます（30文字まで）" };
  if (!j) return { ok: false, error: "日本語訳を入力してください" };
  if (j.length > 40) return { ok: false, error: "日本語訳が長すぎます（40文字まで）" };
  if (existing.some((w) => w.en === e)) return { ok: false, error: `「${e}」はすでに登録されています` };
  if (existing.length >= MAX_WORDS) return { ok: false, error: `登録できるのは${MAX_WORDS}語までです` };
  return { ok: true, en: e, ja: j };
}

export function addMyWord(en, ja) {
  const list = getMyWords();
  const v = validateEntry(en, ja, list);
  if (!v.ok) return v;
  list.push({ en: v.en, ja: v.ja, addedAt: new Date().toISOString() });
  save(list);
  return { ok: true, en: v.en, ja: v.ja };
}

export function removeMyWord(en) {
  const list = getMyWords().filter((w) => w.en !== en);
  save(list);
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
      const unquote = (s) => s.trim().replace(/^"(.*)"$/, "$1");
      // 区切りはカンマ・タブ・全角読点を優先。無ければ最初の空白で分ける
      const sepIndex = line.search(/[,、\t]/);
      if (sepIndex > 0) {
        return { en: unquote(line.slice(0, sepIndex)), ja: unquote(line.slice(sepIndex + 1)) };
      }
      const m = line.match(/^(\S+)\s+(.+)$/);
      return m ? { en: m[1], ja: m[2].trim() } : { en: line, ja: "" };
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
      continue;
    }
    const v = validateEntry(entry.en, entry.ja, list);
    if (!v.ok) {
      skipped.push(`${entry.en || "(空)"}: ${v.error}`);
      continue;
    }
    list.push({ en: v.en, ja: v.ja, addedAt: new Date().toISOString() });
    added.push(v.en);
  }
  if (added.length > 0) save(list);
  return { added, skipped };
}
