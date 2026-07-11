// 単語データのローダー。data/manifest.json を台帳として、
// カテゴリごとのJSONを fetch して読み込む（読み込み済みはキャッシュ）。
// 将来 math などの教科が増えても manifest に追記するだけで動く。

const DATA_BASE = "./data/";

let manifestCache = null;
const categoryCache = new Map();

export async function loadManifest() {
  if (!manifestCache) {
    const res = await fetch(`${DATA_BASE}manifest.json`);
    manifestCache = await res.json();
  }
  return manifestCache;
}

export async function getSubject(subjectId) {
  const manifest = await loadManifest();
  return manifest.subjects.find((s) => s.id === subjectId) ?? null;
}

// 1カテゴリ分の単語を読み込む。各単語に subject / category / label を注入して返す
export async function loadCategory(subjectId, categoryId) {
  const cacheKey = `${subjectId}/${categoryId}`;

  if (!categoryCache.has(cacheKey)) {
    const subject = await getSubject(subjectId);
    const category = subject?.categories.find((c) => c.id === categoryId);
    if (!category) return [];

    const res = await fetch(`${DATA_BASE}${category.file}`);
    const data = await res.json();

    const words = data.words.map((word) => ({
      ...word,
      subject: data.subject,
      category: data.category
    }));

    categoryCache.set(cacheKey, words);
  }

  return categoryCache.get(cacheKey);
}

// 教科の全カテゴリをまとめて読み込む
export async function loadAllWords(subjectId = "english") {
  const subject = await getSubject(subjectId);
  if (!subject) return [];

  const lists = await Promise.all(
    subject.categories.map((c) => loadCategory(subjectId, c.id))
  );

  return lists.flat();
}
