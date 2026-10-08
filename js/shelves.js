// ===== 本棚の棚割り（データだけ） =====
//
// 171 のカテゴリ（基本 9＋分野パック 162）を 9 つの棚に振る。本棚（js/bookshelf.js）と机の本の柱（js/pathView.js）が使う。
// 振り分けは manifest の group 名 → 棚の表と、id の例外表（小学校・中学校・高校の group は教科が混ざるので id で振る）。
// 答え方（lang）と単位（語／枚）もここで決める。語数は manifest の count（基本カテゴリは読み込んだ語を数える）。

export const SHELVES = [
  { id: "course", name: "コース", lang: "順に進むコース" },
  { id: "eng", name: "英単語", lang: "答えは英語" },
  { id: "exam", name: "試験", lang: "答えは英語" },
  { id: "grammar", name: "文法・英作文", lang: "答えは英語・空欄と英文" },
  { id: "freq", name: "頻度順の全集", lang: "答えは英語" },
  { id: "social", name: "社会", lang: "答えは日本語" },
  { id: "science", name: "理科・数学", lang: "答えは日本語" },
  { id: "kokugo", name: "国語・漢字", lang: "答えは日本語" },
  { id: "job", name: "仕事の言葉", lang: "答えは日本語" }
];

const SHELF_BY_ID = Object.fromEntries(SHELVES.map((s) => [s.id, s]));

// manifest の group → 棚
const GROUP_SHELF = {
  "英語（教科書レベル）": "eng",
  "試験・レベル別（英検・TOEIC）": "exam",
  "文法（中学・高校・TOEIC）": "grammar",
  "英作文・表現（並べ替え・英作文・ライティング・面接）": "grammar",
  "NGSL 基本英単語 2,800語（オープン教材・頻度順）": "freq",
  "TOEIC 英単語 1,250語（オープン教材・頻度順）": "freq",
  "ビジネス英単語 1,750語（オープン教材・頻度順）": "freq",
  "学術英単語 960語（オープン教材・アルファベット順）": "freq",
  "ビジネス・バックオフィス": "job",
  "営業・マーケティング・メディア": "job",
  "IT・セキュリティ・ゲーム": "job",
  "医療・福祉・保育": "job",
  "店舗・サービス・教育・観光": "job",
  "建設・製造・物流・農業": "job",
  "不動産・自動車": "job"
};

// id の例外（基本カテゴリと、教科が混ざる小学校・中学校・高校の group）
const ID_SHELF = {
  junior: "eng", highschool: "eng", daily: "eng", travel: "eng", business: "eng", it: "eng", ads: "eng",
  toeic: "exam",
  listing: "job",
  "elem-hist": "social", pref: "social", jhist1: "social", jhist2: "social", jgeo1: "social", jgeo2: "social", jcivics: "social",
  "hs-worldhist1": "social", "hs-worldhist2": "social", "hs-japhist1": "social", "hs-japhist2": "social", "hs-geo": "social", "hs-civics": "social", "hs-ethics": "social",
  "elem-sci": "science", jsci1: "science", jsci2: "science", "hs-physics": "science", "hs-chem": "science", "hs-bio": "science", "hs-earth": "science", "elem-math": "science", jmath: "science",
  "elem-kanji": "kokugo", jkokugo1: "kokugo", jkokugo2: "kokugo", "hs-gendaibun": "kokugo", "hs-kobun": "kokugo", "hs-kanbun": "kokugo"
};

// 一部を漢字で答える本（答え方の 1 行に添える）
const KANJI_PART = new Set(["jkokugo2", "hs-kanbun"]);

// 棚の id を返す（分からなければ null）。category は manifest の 1 行（group を見る）
export function shelfIdOf(id, category = null) {
  if (ID_SHELF[id]) return ID_SHELF[id];
  if (category?.group && GROUP_SHELF[category.group]) return GROUP_SHELF[category.group];
  return null;
}

// 机の本の柱・meta が使う: { id, name, lang, unit }。lang は「英語」「日本語」「英語・空欄と英文」「日本語・一部は漢字で」
export function shelfOf(id, category = null) {
  const shelfId = shelfIdOf(id, category);
  const shelf = SHELF_BY_ID[shelfId] ?? null;
  const concept = category?.kind === "concept";
  const unit = concept ? "枚" : "語";
  let lang = shelfId === "grammar" ? "英語・空欄と英文" : shelfId && ["eng", "exam", "freq"].includes(shelfId) ? "英語" : concept ? "日本語" : "英語";
  if (KANJI_PART.has(id)) lang = "日本語・一部は漢字で";
  return { id: shelfId, name: shelf?.name ?? "", lang, unit };
}
