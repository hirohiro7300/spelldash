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
    return Array.isArray(list) ? list.filter((w) => w && w.en && w.ja) : [];
  } catch {
    return [];
  }
}

function save(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent("spelldash:mywords"));
}

// 出題用の単語オブジェクトへ（level は easy 固定: 自分で入れた語は難易度ゲートに関係なく即出題）
export function toWordObjects(list = getMyWords()) {
  return list.map((w) => ({
    id: `my-${w.en}`,
    en: w.en,
    ja: w.ja,
    level: "easy",
    tags: ["my"],
    subject: "english",
    category: "my",
    addedAt: w.addedAt ?? null
  }));
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

// まとめて追加: 1行に「英単語, 日本語」（カンマ・タブ・全角読点・スペース区切り）
export function parseBulk(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // 区切りはカンマ・タブ・全角読点を優先。無ければ最初の空白で分ける
      const sepIndex = line.search(/[,、\t]/);
      if (sepIndex > 0) {
        return { en: line.slice(0, sepIndex).trim(), ja: line.slice(sepIndex + 1).trim() };
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
