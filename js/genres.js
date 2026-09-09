import { getWordsByCategory } from "./wordStore.js";
import { packGenreLabels } from "./wordData.js";

// ===== ジャンル（タグ）で束ねる =====
// カテゴリの中を「指標」「入札」「車業界」のようなジャンルに分けて、一覧と練習を絞れるようにする。
// ジャンル = 各語の tags[0]。ラベル表は表示用（未登録のタグはそのまま出す）。

export const GENRE_LABELS = {
  // リスティング広告 実務
  flow: "商流（検索から粗利まで）", auto: "車業界の主体と用語", structure: "Google広告の構造", metrics: "指標・略語",
  formula: "式", bidding: "入札・配信", keyword: "キーワード・検索語句", ai: "AI Max", audience: "オーディエンス",
  ad: "広告・品質", status: "状態表示", measurement: "計測（CV・GCLID）", callcenter: "コールセンター",
  economics: "経済性（CPAの逆算）", translation: "ビジネス語との翻訳", reflex: "誤読防止", abbr: "略語", calc: "計算ドリル（数字は毎回変わる）",
  // 広告・マーケ
  targeting: "ターゲティング", quality: "品質", marketing: "マーケティング",
  // ビジネス・TOEIC
  management: "マネジメント", sales: "営業", strategy: "戦略", contract: "契約", finance: "財務・金融", economy: "経済",
  office: "オフィス", meeting: "会議", hr: "人事", trade: "貿易", legal: "法務", event: "イベント", housing: "住居",
  // IT
  software: "ソフトウェア", web: "Web", hardware: "ハードウェア", infrastructure: "インフラ", security: "セキュリティ", data: "データ",
  // 日常・旅行・学校
  greeting: "あいさつ", shopping: "買い物", food: "食べ物", feeling: "気持ち", home: "家", family: "家族", time: "時間",
  weather: "天気", health: "健康", airport: "空港", hotel: "ホテル", transport: "交通", sightseeing: "観光", money: "お金",
  general: "その他", daily: "日常", travel: "旅行", school: "学校", people: "人", nature: "自然", animal: "動物",
  body: "体", color: "色", house: "家", object: "もの", place: "場所", action: "動作", emotion: "感情", size: "大きさ",
  state: "状態", mind: "心・考え", life: "生活", art: "芸術", media: "メディア", sports: "スポーツ", society: "社会",
  science: "科学", work: "仕事", music: "音楽",
  // マイ単語帳
  my: "英単語", "my-concept": "場面カード"
};

const GENRE_KEY = "spelldash_genre";

export function genreOf(word) {
  return word?.tags?.[0] ?? "general";
}

export function genreLabel(tag) {
  return GENRE_LABELS[tag] ?? packGenreLabels[tag] ?? tag;
}

// 練習で絞っているジャンル（カテゴリ切替で解除）
export function getGenre() {
  return localStorage.getItem(GENRE_KEY) || "";
}

export function setGenre(tag) {
  if (tag) localStorage.setItem(GENRE_KEY, tag);
  else localStorage.removeItem(GENRE_KEY);
  window.dispatchEvent(new CustomEvent("spelldash:genre"));
}

export function applyGenre(words, tag = getGenre()) {
  if (!tag) return words;
  const filtered = words.filter((w) => (w.tags ?? []).includes(tag));
  return filtered.length > 0 ? filtered : words; // ジャンルが無いカテゴリでは何もしない
}

// カテゴリの語をジャンルごとに束ねる（出現順）
export function groupByGenre(categoryId) {
  const seen = new Set();
  const groups = new Map();
  for (const word of getWordsByCategory(categoryId)) {
    if (seen.has(word.id)) continue;
    seen.add(word.id);
    const tag = genreOf(word);
    if (!groups.has(tag)) groups.set(tag, { tag, label: genreLabel(tag), words: [] });
    groups.get(tag).words.push(word);
  }
  return [...groups.values()];
}
