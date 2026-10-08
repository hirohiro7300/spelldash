import { getAllWords, getCategories, getPackCatalog, getWordsByCategory, MY_CATEGORY } from "./wordStore.js";
import { esc, numHtml } from "./html.js";
import { getWordStats } from "./storage.js";
import { COURSES, getCourseId } from "./course.js";
import { SHELVES, shelfIdOf, shelfOf } from "./shelves.js";
import { pickWelcomeBook } from "./welcome.js";
import { scrollBehavior } from "./ui.js";

// ===== 本棚（書斎の右の列。スマホは机の下） =====
//
// 171 冊（基本 9＋分野パック 162）を 9 つの棚に並べる（棚割りは js/shelves.js）。本はぜんぶ最初から棚に見えていて、
// 背を押すとその本が机に出る（追加の手続きは要らない。読み込みは押したときに）。函はコース、扉の奥は仕事の言葉 49 冊。
//   initBookshelf({ onPick, onCourse })  … 1 回。描いて配線する。onPick(id) は本を机に出す、onCourse(id) はコースの乗り換え（js/main.js）
//   renderBookshelf()                    … 全体を組み直す（同期でパックが変わったとき）
//   updateBookshelf()                    … 机の上の本の空き・読みかけ・いまのコースだけ差し替える（焦点を奪わない）
// 初回（body.welcome-open）は机の本が替わるだけで、始めない（js/welcome.js pickWelcomeBook）。
// 見た目は css/bookshelf.css。動きは無い（スクロールだけ。prefers-reduced-motion では auto）。

const CATEGORY_KEY = "spelldash_category";

// 革の色（tokens.css の --leather-*）。初回の机の本（js/welcome.js）には値で渡す
const LEATHER = { walnut: "#2B1F17", oxblood: "#4A2320", cognac: "#5E361C", indigo: "#1E2436", slate: "#2C3550", cloth: "#3F4A6B", vellum: "#E2D3B4", umber: "#3A2A1E" };
const leather = (name) => `var(--leather-${name}, ${LEATHER[name]})`;

// 背の短い題。t=題・s=副題・c=革・h=高さ・w=幅（44 が既定）・kind=leather|cloth|label|vellum・vol=巻（ローマ数字）・lat=ラテン文字の題
const SPINE = {
  // 英単語
  "elem-english": { t: "小学英語", c: "cognac", h: 118, w: 46 },
  "jhs-english1": { t: "中学英語", s: "1年", c: "indigo", h: 134, vol: "I" },
  "jhs-english2": { t: "中学英語", s: "2年", c: "indigo", h: 134, vol: "II" },
  "jhs-english3": { t: "中学英語", s: "3年", c: "indigo", h: 134, vol: "III" },
  junior: { t: "中学英語", s: "基本", c: "walnut", h: 142, w: 52 },
  highschool: { t: "高校英語", s: "基本", c: "oxblood", h: 142, w: 52 },
  daily: { t: "日常英会話", c: "cloth", h: 134, kind: "label", w: 46 },
  travel: { t: "旅行の英語", c: "vellum", h: 124, kind: "vellum", w: 46 },
  business: { t: "ビジネス", s: "英単語", c: "slate", h: 130 },
  it: { t: "IT", s: "英単語", c: "walnut", h: 118, lat: true },
  ads: { t: "広告", s: "英単語", c: "cognac", h: 126, w: 48 },
  my: { t: "マイ単語帳", c: "vellum", h: 112, kind: "vellum", w: 40 },
  // 試験
  eiken5: { t: "英検5級", c: "oxblood", h: 142, vol: "I" },
  eiken4: { t: "英検4級", c: "oxblood", h: 142, vol: "II" },
  eiken3: { t: "英検3級", c: "oxblood", h: 142, vol: "III" },
  eikenp2: { t: "英検準2級", c: "oxblood", h: 142, vol: "IV" },
  eiken2: { t: "英検2級", c: "oxblood", h: 142, vol: "V" },
  eikenp1: { t: "英検準1級", c: "oxblood", h: 142, vol: "VI" },
  eiken1: { t: "英検1級", c: "oxblood", h: 142, vol: "VII" },
  toeic500: { t: "TOEIC", s: "500", c: "slate", h: 126, kind: "label", lat: true },
  toeic600: { t: "TOEIC", s: "600", c: "slate", h: 126, kind: "label", lat: true },
  toeic730: { t: "TOEIC", s: "730", c: "slate", h: 126, kind: "label", lat: true },
  toeic860: { t: "TOEIC", s: "860", c: "slate", h: 126, kind: "label", lat: true },
  toeic990: { t: "TOEIC", s: "990", c: "slate", h: 126, kind: "label", lat: true },
  toeic: { t: "TOEIC", s: "頻出", c: "walnut", h: 134, w: 52, lat: true },
  // 文法・英作文
  "grammar-jhs1": { t: "中学英文法", s: "1年", c: "cognac", h: 138, vol: "I" },
  "grammar-jhs2": { t: "中学英文法", s: "2年", c: "cognac", h: 138, vol: "II" },
  "grammar-jhs3": { t: "中学英文法", s: "3年", c: "cognac", h: 138, vol: "III" },
  "grammar-hs1": { t: "高校英文法", s: "基礎", c: "indigo", h: 134, w: 48 },
  "grammar-hs2": { t: "高校英文法", s: "発展", c: "indigo", h: 134, w: 48 },
  "grammar-toeic": { t: "TOEIC", s: "文法", c: "slate", h: 118, lat: true },
  "writing-jhs-order": { t: "中学英語", s: "並べ替え", c: "vellum", h: 122, kind: "vellum" },
  "writing-jhs": { t: "中学英作文", c: "walnut", h: 126, w: 52 },
  "writing-hs": { t: "高校英作文", s: "構文", c: "oxblood", h: 132 },
  "writing-eiken": { t: "英検", s: "ライティング", c: "cloth", h: 132, kind: "label" },
  "writing-interview": { t: "英語面接", s: "定番フレーズ", c: "umber", h: 124 },
  // 社会
  "elem-hist": { t: "小学歴史", s: "人物", c: "cognac", h: 118 },
  pref: { t: "都道府県", c: "vellum", h: 118, kind: "vellum", w: 46 },
  jgeo1: { t: "中学地理", s: "日本", c: "cloth", h: 124, kind: "label" },
  jgeo2: { t: "中学地理", s: "世界", c: "cloth", h: 124, kind: "label" },
  jhist1: { t: "中学歴史", s: "上巻", c: "walnut", h: 132 },
  jhist2: { t: "中学歴史", s: "下巻", c: "walnut", h: 132 },
  jcivics: { t: "中学公民", c: "indigo", h: 126, w: 48 },
  "hs-japhist1": { t: "高校日本史", s: "上巻", c: "oxblood", h: 138 },
  "hs-japhist2": { t: "高校日本史", s: "下巻", c: "oxblood", h: 138 },
  "hs-worldhist1": { t: "高校世界史", s: "上巻", c: "slate", h: 138 },
  "hs-worldhist2": { t: "高校世界史", s: "下巻", c: "slate", h: 138 },
  "hs-geo": { t: "高校地理", s: "総合・探究", c: "cognac", h: 126, w: 52 },
  "hs-civics": { t: "政治・経済", s: "高校", c: "indigo", h: 128 },
  "hs-ethics": { t: "高校倫理", c: "vellum", h: 122, kind: "vellum" },
  // 理科・数学
  "elem-sci": { t: "小学理科", c: "cognac", h: 118 },
  jsci1: { t: "中学理科", s: "物理・化学", c: "indigo", h: 128 },
  jsci2: { t: "中学理科", s: "生物・地学", c: "indigo", h: 128 },
  "hs-physics": { t: "物理基礎", s: "高校", c: "cloth", h: 132, kind: "label" },
  "hs-chem": { t: "化学基礎", s: "高校", c: "cloth", h: 132, kind: "label" },
  "hs-bio": { t: "生物基礎", s: "高校", c: "cloth", h: 132, kind: "label" },
  "hs-earth": { t: "地学基礎", s: "高校", c: "cloth", h: 132, kind: "label" },
  "elem-math": { t: "小学算数", s: "用語", c: "vellum", h: 116, kind: "vellum" },
  jmath: { t: "中学数学", s: "用語と定理", c: "walnut", h: 126, w: 48 },
  // 国語・漢字
  "elem-kanji": { t: "漢字の読み", s: "小学5・6年", c: "oxblood", h: 128 },
  jkokugo2: { t: "漢字の読み", s: "中学", c: "oxblood", h: 132 },
  jkokugo1: { t: "四字熟語", s: "ことわざ", c: "walnut", h: 136 },
  "hs-gendaibun": { t: "現代文", s: "キーワード", c: "indigo", h: 124 },
  "hs-kobun": { t: "古文単語", c: "cognac", h: 134, w: 52 },
  "hs-kanbun": { t: "漢文", s: "句法と重要語", c: "vellum", h: 124, kind: "vellum" },
  // 仕事の言葉（扉の奥。革は段ごとに回す）
  accounting: { t: "簿記・会計", s: "基本" },
  legal: { t: "契約・法務", s: "基本" },
  hr: { t: "人事・労務", s: "実務" },
  generalaffairs: { t: "総務", s: "実務" },
  secretary: { t: "秘書", s: "役員サポート" },
  pr: { t: "広報", s: "PR" },
  freelancetax: { t: "確定申告", s: "フリーランス" },
  staffing: { t: "人材紹介", s: "人材派遣" },
  publicbid: { t: "入札", s: "官公庁営業" },
  startupfinance: { t: "資金調達", s: "スタートアップ" },
  banking: { t: "銀行・金融", s: "基本" },
  insurance: { t: "保険営業", s: "基本" },
  trade: { t: "貿易実務" },
  saas: { t: "SaaS", s: "営業・CS", lat: true },
  ec: { t: "EC・D2C", s: "運営", lat: true },
  sns: { t: "SNS運用" },
  video: { t: "動画制作", s: "YouTube" },
  publishing: { t: "出版・編集" },
  callcenter: { t: "コールセンター", s: "CS運営" },
  webdev: { t: "Web制作", s: "SEO" },
  listing: { t: "リスティング", s: "広告" },
  programming: { t: "プログラミング" },
  itsupport: { t: "社内SE", s: "ヘルプデスク" },
  security: { t: "セキュリティ", s: "基本" },
  gamedev: { t: "ゲーム開発" },
  medical: { t: "医療事務", s: "受付" },
  nursing: { t: "看護・病棟", s: "基本" },
  pharmacy: { t: "調剤薬局", s: "事務" },
  pt: { t: "理学療法", s: "リハビリ" },
  labtech: { t: "臨床検査", s: "基本" },
  care: { t: "介護", s: "実務" },
  dental: { t: "歯科受付", s: "歯科助手" },
  childcare: { t: "保育の現場" },
  restaurant: { t: "飲食店経営" },
  hotel: { t: "ホテル", s: "宿泊業" },
  apparel: { t: "アパレル", s: "販売・店舗" },
  salon: { t: "美容室", s: "サロン経営" },
  juku: { t: "学習塾", s: "運営" },
  tourguide: { t: "観光ガイド", s: "旅行業" },
  event: { t: "イベント", s: "運営" },
  construction: { t: "建設", s: "施工管理" },
  archdesign: { t: "建築設計", s: "実務" },
  manufacturing: { t: "製造", s: "品質管理" },
  logistics: { t: "物流・倉庫" },
  printing: { t: "印刷", s: "DTP" },
  agriculture: { t: "農業", s: "実務" },
  realestate: { t: "不動産", s: "実務" },
  usedcar: { t: "中古車", s: "買取・販売" },
  mechanic: { t: "自動車整備", s: "車検" }
};

// 棚の中の並び。"|bookend"・"|flat:色,色" は飾り（寝かせた本・真鍮の本立て）。表に無い本（あとで足したパック）は棚の末尾に付く
const ORDER = {
  eng: ["elem-english", "jhs-english1", "jhs-english2", "jhs-english3", "junior", "highschool", "daily", "travel", "business", "it", "ads"],
  exam: ["eiken5", "eiken4", "eiken3", "eikenp2", "eiken2", "eikenp1", "eiken1", "|bookend", "toeic500", "toeic600", "toeic730", "toeic860", "toeic990", "toeic"],
  grammar: ["grammar-jhs1", "grammar-jhs2", "grammar-jhs3", "grammar-hs1", "grammar-hs2", "grammar-toeic", "|flat:walnut,slate", "writing-jhs-order", "writing-jhs", "writing-hs", "writing-eiken", "writing-interview"],
  social: ["elem-hist", "pref", "jgeo1", "jgeo2", "jhist1", "jhist2", "jcivics", "|flat:oxblood,cognac,umber", "hs-japhist1", "hs-japhist2", "hs-worldhist1", "hs-worldhist2", "hs-geo", "hs-civics", "hs-ethics"],
  science: ["elem-sci", "jsci1", "jsci2", "hs-physics", "hs-chem", "hs-bio", "hs-earth", "|bookend", "elem-math", "jmath"],
  kokugo: ["elem-kanji", "jkokugo2", "jkokugo1", "hs-gendaibun", "hs-kobun", "hs-kanbun", "|flat:slate,cognac,walnut"]
};

// 函（コース）: 棚をまたぐコースと試験のコースは「コース」の棚、頻度順の 4 つの全集はその棚。巻（パック）の背は出さない
const COURSE_BOXES = ["jhs-redo", "biz", "conversation", "hs", "eiken", "toeic"];
const FREQ_BOXES = ["ngsl", "tsl", "bsl", "nawl"];
const BOX = {
  "jhs-redo": { t: "中学英語", s: "やり直し", c: "indigo" },
  biz: { t: "ビジネス英語", s: "社会人", c: "umber" },
  conversation: { t: "英会話", s: "日常・旅行の", c: "slate" },
  hs: { t: "高校英語", c: "oxblood" },
  eiken: { t: "英検", s: "5級→1級", c: "cognac" },
  toeic: { t: "TOEIC", s: "500→990", c: "walnut", lat: true },
  ngsl: { t: "基本英単語", s: "NGSL", c: "indigo", w: 72, h: 160 },
  tsl: { t: "TOEIC英単語", s: "TSL", c: "slate", w: 72, h: 160 },
  bsl: { t: "ビジネス英単語", s: "BSL", c: "umber", w: 72, h: 160 },
  nawl: { t: "学術英単語", s: "NAWL", c: "oxblood", w: 72, h: 160 }
};

// 仕事の言葉（扉の奥）: 8 段。1 段は 8 冊まで（PC で 1 段に収まる幅）。表に無い本は最後の段に付く
const JOB_ROWS = [
  { id: "office", name: "経理・法務・人事・総務", books: ["accounting", "legal", "hr", "generalaffairs", "secretary", "pr"] },
  { id: "finance", name: "金融・貿易・公共", books: ["freelancetax", "staffing", "publicbid", "startupfinance", "banking", "insurance", "trade"] },
  { id: "sales", name: "営業・マーケ・メディア", books: ["saas", "ec", "sns", "video", "publishing", "callcenter", "webdev", "listing"] },
  { id: "it", name: "IT・セキュリティ・ゲーム", books: ["programming", "itsupport", "security", "gamedev"] },
  { id: "care", name: "医療・福祉・保育", books: ["medical", "nursing", "pharmacy", "pt", "labtech", "care", "dental", "childcare"] },
  { id: "service", name: "店舗・サービス・教育・観光", books: ["restaurant", "hotel", "apparel", "salon", "juku", "tourguide", "event"] },
  { id: "industry", name: "建設・製造・物流・農業", books: ["construction", "archdesign", "manufacturing", "logistics", "printing", "agriculture"] },
  { id: "estate", name: "不動産・自動車", books: ["realestate", "usedcar", "mechanic"] }
];
const JOB_LEATHER = ["walnut", "oxblood", "cognac", "slate", "umber", "indigo"];

// 本をさがす: 書名・group・棚名・紹介文・対象のほかに引ける言葉（歴史→日本史・世界史、英検、TOEIC、公民、理科、仕事、かな読み）
const SHELF_ALIAS = {
  eng: ["英単語", "えいたんご", "単語", "たんご"],
  exam: ["試験", "しけん"],
  grammar: ["文法", "ぶんぽう", "英作文", "えいさくぶん"],
  freq: ["頻度順", "ひんどじゅん", "全集"],
  social: ["社会", "しゃかい"],
  science: ["理科", "りか", "数学", "すうがく"],
  kokugo: ["国語", "こくご", "漢字", "かんじ"],
  job: ["仕事", "しごと", "業界", "仕事の言葉"]
};
const BOOK_ALIAS = {
  "hs-japhist1": ["歴史", "日本史", "にほんし"], "hs-japhist2": ["歴史", "日本史", "にほんし"],
  "hs-worldhist1": ["歴史", "世界史", "せかいし"], "hs-worldhist2": ["歴史", "世界史", "せかいし"],
  jhist1: ["れきし"], jhist2: ["れきし"], "elem-hist": ["れきし"],
  "hs-civics": ["公民", "こうみん", "政経"], "hs-ethics": ["公民", "こうみん"], jcivics: ["こうみん"],
  "hs-physics": ["理科"], "hs-chem": ["理科"], "hs-bio": ["理科"], "hs-earth": ["理科"],
  toeic: ["toeic", "トーイック", "トイック"], "grammar-toeic": ["toeic", "トーイック"],
  "writing-eiken": ["eiken", "えいけん"], jkokugo1: ["四字熟語", "よじじゅくご", "ことわざ"], pref: ["地理", "ちり"]
};
const COURSE_ALIAS = { eiken: ["eiken", "えいけん"], toeic: ["toeic", "トーイック", "トイック"], ngsl: ["ngsl", "基本語"], tsl: ["tsl", "toeic", "トーイック"], bsl: ["bsl", "ビジネス"], nawl: ["nawl", "学術", "論文"] };
// 何も打っていないときの「よく開かれる本」
const FINDER_DEFAULT = ["jhs-english1", "toeic500", "eiken3", "jhist1", "jsci1", "accounting"];

// 縦書きの背で 1〜2 桁の数字は縦中横
const tcy = (s) => esc(s).replace(/(^|\D)(\d{1,2})(?!\d)/g, '$1<span class="tcy">$2</span>');
// 本の題: 「中学英語 2年（教科書レベル）」の括弧書きは外す
const plainTitle = (label) => String(label ?? "").replace(/（[^）]*）$/, "").trim();
const kana = (s) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const norm = (s) => kana(String(s ?? "").normalize("NFKC").toLowerCase()).replace(/\s+/g, "");
const ICON = {
  lens: `<svg viewBox="0 0 17 17" aria-hidden="true" focusable="false"><circle cx="6.8" cy="6.8" r="4.9" fill="none" stroke="currentColor" stroke-width="1.15"/><path d="M10.4 10.6 15.6 15.8 14.6 16.4 9.9 11.3z" fill="currentColor"/></svg>`,
  close: `<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="M2.2 2.2 11.8 11.8M11.8 2.2 2.2 11.8" fill="none" stroke="currentColor" stroke-width="1.15"/></svg>`,
  arrow: `<svg viewBox="0 0 14 9" aria-hidden="true" focusable="false"><path d="M0 4.5h12.4M9 1l3.6 3.5L9 8" fill="none" stroke="currentColor" stroke-width="1"/></svg>`
};

// ---------- データ: manifest の 171 冊を棚に振る ----------
let BOOKS = new Map(); // id → book
let SHELF_LIST = []; // [{ shelf, books: [book|deco], boxes: [course] }]
let JOBS = []; // 扉の奥の段
let FINDER = []; // 本をさがすの行
let handlers = {};
let root = null;
let doorsOpen = false;
let jobsRendered = false;

// 1 冊ぶんのデータ。category は manifest の 1 行（基本カテゴリは count が無いので読み込んだ語を数える）
function bookOf(category, shelfId) {
  const id = category.id;
  const spec = SPINE[id] ?? splitLabel(category.label);
  const info = shelfOf(id, category);
  const full = id === "my" ? MY_CATEGORY.label : plainTitle(category.label);
  const count = category.count ?? getWordsByCategory(id).length;
  const kind = spec.kind ?? (spec.c === "cloth" ? "cloth" : "leather");
  return {
    id,
    shelfId,
    label: category.label,
    full,
    t: spec.t,
    s: spec.s ?? "",
    lat: !!spec.lat,
    c: spec.c ?? "walnut",
    h: spec.h ?? 128,
    w: spec.w ?? 44,
    kind,
    vol: spec.vol ?? "",
    count,
    unit: info.unit,
    lang: info.lang, // 「英語」「日本語」「英語・空欄と英文」「日本語・一部は漢字で」
    pack: !!category.pack,
    group: category.group ?? "",
    blurb: category.blurb ?? "",
    audience: category.audience ?? ""
  };
}

// 表に無い本: 7 文字以内なら 1 行、長ければ「・」「（」「 」で 2 行に割る
function splitLabel(label) {
  const s = plainTitle(label);
  if ([...s].length <= 7) return { t: s };
  const m = s.match(/^(.+?)[・（ ](.+?)）?$/);
  return m ? { t: m[1], s: m[2] } : { t: s.slice(0, 6), s: s.slice(6) };
}

function buildData() {
  const base = getCategories().filter((c) => !c.pack && c.id !== MY_CATEGORY.id);
  const packs = getPackCatalog();
  const all = [...base, ...packs];
  const byShelf = Object.fromEntries(SHELVES.map((s) => [s.id, []]));
  const unassigned = [];
  BOOKS = new Map();
  for (const c of all) {
    const shelfId = shelfIdOf(c.id, c);
    if (!shelfId || !byShelf[shelfId]) {
      unassigned.push(c.id);
      continue;
    }
    const book = bookOf(c, shelfId);
    BOOKS.set(c.id, book);
    byShelf[shelfId].push(book);
  }
  // 棚の無い本は出せない（scripts/validate-words.mjs が manifest の全カテゴリに棚があることを確かめる）。見出しの冊数は棚に出た本だけ数える
  console.assert(unassigned.length === 0, "本棚: 棚の無い本", unassigned);
  // マイ単語帳は英単語の棚の末尾（171 冊には数えない）
  const my = bookOf({ id: MY_CATEGORY.id, label: MY_CATEGORY.label, kind: "" }, "eng");
  my.lang = "英語";
  BOOKS.set("my", my);

  SHELF_LIST = SHELVES.map((shelf) => {
    if (shelf.id === "course") return { shelf, boxes: COURSE_BOXES.map(courseOf).filter(Boolean), books: [] };
    if (shelf.id === "freq") return { shelf, boxes: FREQ_BOXES.map(courseOf).filter(Boolean), books: [], hidden: byShelf.freq.length };
    if (shelf.id === "job") return { shelf, boxes: [], books: byShelf.job };
    const order = ORDER[shelf.id] ?? [];
    const placed = new Set();
    const items = [];
    for (const key of order) {
      if (key.startsWith("|")) {
        items.push(decoOf(key));
        continue;
      }
      const book = BOOKS.get(key);
      if (book && book.shelfId === shelf.id) {
        items.push(book);
        placed.add(key);
      }
    }
    for (const book of byShelf[shelf.id]) if (!placed.has(book.id)) items.push(book);
    if (shelf.id === "eng") items.push(my);
    return { shelf, boxes: [], books: items };
  });

  // 扉の奥: 8 段（表に無い本は最後の段へ）
  const placedJobs = new Set(JOB_ROWS.flatMap((r) => r.books));
  JOBS = JOB_ROWS.map((row, r) => ({
    ...row,
    books: row.books.map((id) => BOOKS.get(id)).filter(Boolean).map((b, i) => jobStyle(b, r, i))
  }));
  const rest = byShelf.job.filter((b) => !placedJobs.has(b.id));
  if (rest.length) JOBS[JOBS.length - 1].books.push(...rest.map((b, i) => jobStyle(b, JOBS.length - 1, 3 + i)));

  // 本をさがす: 171 冊＋10 コース
  FINDER = [
    ...[...BOOKS.values()].filter((b) => b.id !== "my").map((b) => ({
      kind: "book",
      id: b.id,
      name: b.full,
      meta: `${shelfName(b.shelfId)}・答えは${b.lang.split("・")[0]}・${b.count}${b.unit}`,
      keys: [b.full, b.label, b.t + b.s, b.group, shelfName(b.shelfId), b.blurb, b.audience, ...(SHELF_ALIAS[b.shelfId] ?? []), ...(BOOK_ALIAS[b.id] ?? [])].map(norm).join("\n")
    })),
    ...Object.values(COURSES).map((c) => ({
      kind: "course",
      id: c.id,
      name: c.label,
      meta: `コース・全${c.packs.length}巻・答えは英語`,
      keys: [c.label, c.blurb, c.audience, "コース", "こーす", ...(COURSE_ALIAS[c.id] ?? [])].map(norm).join("\n")
    }))
  ];
  return { total: all.length - unassigned.length, unassigned };
}

// 題か副題が 6 字以上の背（文字を少し小さく組む。css .spine--long）
const isLong = (book) => [...book.t].length >= 6 || [...(book.s ?? "")].length >= 6;

// 仕事の言葉の背: 革は段ごとに回し、高さは少しずつ変える（長い題の背は高く）
function jobStyle(book, row, i) {
  const c = JOB_LEATHER[(row + i) % JOB_LEATHER.length];
  const h = [126, 132, 120, 136, 128, 122, 134, 130][(row * 3 + i) % 8];
  return { ...book, c, h: isLong(book) ? Math.max(h, 136) : h, kind: c === "cloth" ? "cloth" : "leather", w: 46 };
}

function decoOf(key) {
  if (key === "|bookend") return { deco: "bookend" };
  const colors = key.slice("|flat:".length).split(",").filter(Boolean);
  return { deco: "flat", colors };
}

function shelfName(id) {
  return SHELVES.find((s) => s.id === id)?.name ?? "";
}

// 函 1 つぶん（コース）。語数は巻の count の合計（基本カテゴリは読み込んだ語を数える）
function courseOf(courseId) {
  const course = COURSES[courseId];
  if (!course) return null;
  const spec = BOX[courseId] ?? { t: course.label, c: "walnut" };
  const catalog = [...getCategories(), ...getPackCatalog()];
  const words = course.packs.reduce((n, id) => n + (catalog.find((c) => c.id === id)?.count ?? getWordsByCategory(id).length), 0);
  return { id: courseId, course, vols: course.packs.length, words, ...spec };
}

// ---------- 状態 ----------
const currentBookId = () => localStorage.getItem(CATEGORY_KEY) || "all";
let readingSet = new Set();
// 読みかけ（記録のある語を 1 つでも持つ本）。全語を 1 回だけ走る（本ごとに getWordsByCategory で絞ると 171 × 全語になる）。
// 語の条件は getWordsByCategory と同じ（kanjiOnly は出さない）。マイ単語帳は数えない
function computeReading() {
  const stats = getWordStats();
  readingSet = new Set();
  if (Object.keys(stats).length === 0) return;
  for (const w of getAllWords()) {
    if (w.category && w.category !== "my" && !w.kanjiOnly && stats[w.id]) readingSet.add(w.category);
  }
}

// ---------- 描画 ----------
function spineLabel(book, reading) {
  const extra = book.id === "jkokugo2" || book.id === "hs-kanbun" ? "、一部は漢字で答える" : "";
  const n = book.id === "my" && book.count === 0 ? "語はまだ無い" : `${book.count}${book.unit}`;
  return `${book.full}、${n}、答えは${book.lang.split("・")[0]}${extra}${reading ? "、読みかけ" : ""}`;
}

// PC の細い背に題と副題が 1 本の縦の行で収まらない本は、2 行にできる幅（38px）を下限にする（モックの式）
function needsTwo(book) {
  const len = (str, px) => [...String(str || "").replace(/\d{1,2}/g, "0")].reduce((a, ch) => a + (/[A-Za-z0-9 ]/.test(ch) ? px * 0.58 : px), 0);
  const need = len(book.t, 14) + len(book.s, 12.5) + 8 + (book.vol ? 18 : 0) + (book.kind === "label" || book.kind === "vellum" ? 14 : 0);
  return need > book.h * 1.1 - 34;
}

function spineInner(book, { reading }) {
  const cls = ["spine", book.kind === "cloth" || book.kind === "label" ? "spine--cloth" : "", book.kind === "label" ? "spine--label" : "", book.kind === "vellum" ? "spine--vellum spine--label" : "", reading ? "spine--reading" : "", book.vol ? "spine--vol" : "", book.id === "my" ? "spine--my" : "", isLong(book) ? "spine--long" : ""].filter(Boolean).join(" ");
  const t = book.lat ? `<span class="lat">${esc(book.t)}</span>` : tcy(book.t);
  const s = book.s ? (/^\d{3}$/.test(book.s) || /^[A-Za-z]+$/.test(book.s) ? `<span class="spine__s lat">${esc(book.s)}</span>` : `<span class="spine__s">${tcy(book.s)}</span>`) : "";
  const style = `--c:${leather(book.c)};--h:${book.h}px;--w:${book.w}px`;
  return `<button type="button" class="${cls}" data-book="${esc(book.id)}" style="${style}" aria-label="${esc(spineLabel(book, reading))}" tabindex="-1"><span class="spine__l" aria-hidden="true"><span class="spine__t">${t}</span>${s}</span>${book.vol ? `<span class="spine__v" aria-hidden="true">${book.vol}</span>` : ""}</button>`;
}

function slotInner(book) {
  return `<span class="slot" role="img" aria-label="${esc(book.full)}は机の上" style="--w:${Math.max(40, book.w - 4)}px;--h:${book.h}px"></span>`;
}

function bookLi(book) {
  const slot = book.id === currentBookId();
  const reading = readingSet.has(book.id);
  const min = needsTwo(book) ? `;--min:${book.kind === "label" || book.kind === "vellum" ? 41 : 38}px` : "";
  return `<li data-book="${esc(book.id)}" data-state="${slot ? "slot" : reading ? "reading" : "plain"}" style="--g:${book.w}${min}">${slot ? slotInner(book) : spineInner(book, { reading })}</li>`;
}

function decoLi(item, cumWidth) {
  // 飾りは 1 段の累計幅が 420px を超えた位置にだけ（スマホの 1 画面目の右端で切れるのは本物の背にする）。手前なら PC だけ
  const late = cumWidth >= 420 ? "" : " mid--pc";
  if (item.deco === "bookend") return `<li class="mid${late}" aria-hidden="true"><span class="bookend"></span></li>`;
  const w = 78;
  return `<li class="mid${late}" aria-hidden="true"><span class="flat" style="width:${w}px">${item.colors.map((c, i) => `<i style="background-color:${leather(c)};width:${w - i * 7}px;margin-left:${i * 3}px"></i>`).join("")}</span></li>`;
}

function fillLi() {
  return `<li class="fill" aria-hidden="true"><span class="flat flat--fill">${["walnut", "slate", "oxblood"].map((c, i) => `<i style="background-color:${leather(c)};width:${100 - i * 7}%;margin-left:${i * 4}%"></i>`).join("")}</span><span class="bookend"></span></li>`;
}

function boxLi(box) {
  const reading = box.id === getCourseId();
  const s = box.s ? (/^[A-Z]+$/.test(box.s) ? `<span class="spine__s lat">${esc(box.s)}</span>` : `<span class="spine__s">${tcy(box.s)}</span>`) : "";
  const t = box.lat ? `<span class="lat">${esc(box.t)}</span>` : esc(box.t);
  const label = `${box.course.label} 全${box.vols}巻（コース）、${box.words}語、答えは英語${reading ? "、いまのコース" : ""}`;
  const style = `--c:${leather(box.c)}${box.w ? `;--w:${box.w}px` : ""}${box.h ? `;--h:${box.h}px` : ""}`;
  return `<li data-course="${esc(box.id)}"><button type="button" class="box${reading ? " box--reading" : ""}${[...box.t].length >= 6 ? " box--long" : ""}" data-course="${esc(box.id)}" style="${style}" aria-label="${esc(label)}" tabindex="-1"><span class="box__vols" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="box__l" aria-hidden="true"><span class="spine__t">${t}</span>${s}</span><span class="box__n" aria-hidden="true">全<b>${box.vols}</b>巻</span></button></li>`;
}

// 1 段。lang は札の短い 1 行（「答えは英語」「答えは日本語」）。boxes があれば函の段
function shelfHtml({ id, name, count, unit, lang, books = [], boxes = [], mod = "" }) {
  const isBox = boxes.length > 0;
  let cum = 0;
  const items = isBox
    ? boxes.map(boxLi)
    : books.map((item) => {
        if (item.deco) return decoLi(item, cum);
        cum += item.w + 2;
        return bookLi(item);
      });
  items.push(fillLi());
  const nBooks = isBox ? boxes.length : books.filter((b) => !b.deco).length;
  const scroll = isBox ? boxes.length > 5 : nBooks > 7;
  const more = scroll ? `<button type="button" class="more" data-more="${esc(id)}" aria-label="${esc(name)}の棚の続きを見る"><span class="more__n">あと<b class="n">${Math.max(0, nBooks - 7)}</b>${isBox ? "組" : "冊"}</span>${ICON.arrow}</button>` : "";
  return `
    <section class="shelf shelf--${esc(id)}${isBox ? " shelf--box" : ""}${mod}" id="shelf-${esc(id)}" aria-labelledby="sh-${esc(id)}">
      <div class="shelf__in"><ul class="books${scroll ? " books--scroll" : ""}" role="list" aria-label="${esc(name)}の棚">${items.join("")}</ul></div>
      <div class="shelf__board"><h3 class="shelf__label" id="sh-${esc(id)}"><span class="plate">${esc(name)}<small><span class="n">${count}</span>${unit}</small></span></h3><span class="shelf__lang">${esc(lang)}</span>${more}</div>
    </section>`;
}

function shortLang(lang) {
  const l = lang.replace(/^答えは/, ""); // shelves.js の lang は「答えは日本語」の形（社会・理科・国語の札が「答えは英語」になっていた）
  return l.startsWith("日本語") ? "答えは日本語" : l.startsWith("順") ? l : "答えは英語";
}

function jobsHtml() {
  return JOBS.map((row, i) => shelfHtml({ id: `job-${row.id}`, name: row.name, count: row.books.length, unit: "冊", lang: "答えは日本語", books: row.books, mod: " shelf--job" })).join("");
}

export function renderBookshelf() {
  root = document.getElementById("bookshelf");
  if (!root) return;
  const { total } = buildData();
  computeReading();
  const jobCount = SHELF_LIST.find((s) => s.shelf.id === "job")?.books.length ?? 0;
  const shelves = SHELF_LIST.filter((s) => s.shelf.id !== "job")
    .map((s) =>
      shelfHtml({
        id: s.shelf.id,
        name: s.shelf.name,
        count: s.boxes.length || s.books.filter((b) => !b.deco && b.id !== "my").length,
        unit: s.boxes.length ? "組" : "冊",
        lang: shortLang(s.shelf.lang),
        books: s.books,
        boxes: s.boxes
      })
    )
    .join("");
  const idx = SHELVES.filter((s) => s.id !== "course" && s.id !== "job")
    .map((s) => `<a href="#shelf-${s.id}">${esc(s.name.split("・")[0].replace("の全集", ""))}</a>`)
    .join("") + `<a href="#archive">仕事</a>`;
  root.innerHTML = `
    <div class="cabinet">
      <div class="cabinet__cornice" aria-hidden="true"><i class="cabinet__frieze"></i></div>
      <div class="cabinet__rail">
        <h2 class="bookshelf__title" id="bookshelfTitle">本棚<small><span class="n">${total}</span>冊</small></h2>
        <button type="button" class="find" id="bookFinderOpen" aria-haspopup="dialog">${ICON.lens}<span>本をさがす</span></button>
        <nav class="shelf-index" aria-label="棚へ移る">${idx}</nav>
      </div>
      <div class="cabinet__body">
        ${shelves}
        <section class="archive" id="archive" aria-labelledby="archiveName">
          <button type="button" class="doors${doorsOpen ? " doors--open" : ""}" id="archiveDoors" aria-expanded="${doorsOpen}" aria-controls="shelf-job">
            <span class="door door--l" aria-hidden="true"><span class="door__glass"><i></i><i></i><i></i><i></i></span><i class="pull"></i></span>
            <span class="door door--r" aria-hidden="true"><span class="door__glass"><i></i><i></i><i></i><i></i></span><i class="pull"></i></span>
            <span class="doors__plate" aria-hidden="true"><b>仕事の言葉 <span class="n">${jobCount}</span>冊</b><small>経理・医療・ITなど</small></span>
            <span class="doors__go" aria-hidden="true"><span class="doors__go-t">${doorsOpen ? "閉じる" : `<span class="n">${jobCount}</span>冊を見る`}</span>${ICON.arrow}</span>
            <span class="sr-only" id="archiveName">仕事の言葉 ${jobCount}冊（経理・医療・ITなど、答えは日本語）</span>
          </button>
          <div class="archive__in" id="shelf-job"${doorsOpen ? "" : " hidden"}>${doorsOpen ? jobsHtml() : ""}</div>
        </section>
      </div>
      <div class="cabinet__plinth" aria-hidden="true"></div>
    </div>
    <p class="sr-only" id="bookshelfStatus" role="status"></p>
    <dialog class="finder" id="bookFinder" aria-labelledby="bookFinderTitle">
      <form method="dialog" class="finder__card">
        <div class="finder__head"><h2 id="bookFinderTitle">本をさがす</h2><button type="button" class="finder__close" aria-label="閉じる">${ICON.close}</button></div>
        <label class="finder__field"><span class="sr-only">書名・教科・試験</span>${ICON.lens}<input id="bookFinderQ" type="search" placeholder="書名・教科・試験（例: 歴史、英検）" autocomplete="off" enterkeyhint="search" /></label>
        <p class="finder__hint" id="bookFinderHint">よく開かれる本</p>
        <ol class="finder__list" id="bookFinderList"></ol>
      </form>
    </dialog>`;
  jobsRendered = doorsOpen;
  root.hidden = false;
  setupRows();
  setupRoving();
}

// 机の上の本の空き・読みかけ・いまのコースだけ差し替える（焦点は奪わない）
export function updateBookshelf() {
  if (!root || !root.isConnected || !BOOKS.size) return;
  computeReading();
  const current = currentBookId();
  const course = getCourseId();
  for (const li of root.querySelectorAll("li[data-book]")) {
    const book = BOOKS.get(li.dataset.book);
    if (!book) continue;
    const state = book.id === current ? "slot" : readingSet.has(book.id) ? "reading" : "plain";
    if (li.dataset.state === state) continue;
    li.dataset.state = state;
    li.innerHTML = state === "slot" ? slotInner(book) : spineInner(book, { reading: state === "reading" });
  }
  for (const btn of root.querySelectorAll("button.box")) {
    const on = btn.dataset.course === course;
    btn.classList.toggle("box--reading", on);
    const base = btn.getAttribute("aria-label").replace(/、いまのコース$/, "");
    btn.setAttribute("aria-label", on ? `${base}、いまのコース` : base);
  }
  setupRoving();
}

// ---------- 段の続き（スマホ）: 隠れている冊数と「あと N冊 →」。右端で切れるのは本物の背（のぞく幅を 30〜40% に） ----------
// 本棚が畳まれている間（プレイ中。同期で組み直したとき）は測れない（矩形がぜんぶ 0 で、全冊が「隠れている」になる）ので何もしない。
// 出たときに ResizeObserver（initBookshelf）が測り直す
function setupRows() {
  if (!root || root.getClientRects().length === 0) return;
  for (const ul of root.querySelectorAll(".books--scroll")) {
    fitPeek(ul);
    const btn = ul.closest(".shelf")?.querySelector(".more");
    if (!btn) continue;
    const count = () => {
      const box = ul.getBoundingClientRect();
      let hidden = 0;
      ul.querySelectorAll(".spine, .box, .slot").forEach((s) => {
        const r = s.getBoundingClientRect();
        if (r.left + r.width * 0.5 > box.right - 30) hidden++;
      });
      const atEnd = hidden === 0;
      btn.hidden = atEnd && ul.scrollLeft < 8;
      btn.classList.toggle("more--back", atEnd);
      const n = btn.querySelector(".more__n");
      const unit = ul.closest(".shelf--box") ? "組" : "冊";
      n.innerHTML = atEnd ? "はじめへ" : `あと<b class="n">${hidden}</b>${unit}`;
      const name = ul.getAttribute("aria-label")?.replace(/の棚$/, "") ?? "";
      btn.setAttribute("aria-label", atEnd ? `${name}の棚のはじめへ` : `${name}の棚の続きを見る（あと${hidden}${unit}）`);
    };
    btn.onclick = () => {
      const back = btn.classList.contains("more--back");
      ul.scrollBy({ left: back ? -ul.scrollWidth : ul.clientWidth * 0.8, behavior: scrollBehavior() });
    };
    ul.onscroll = count;
    count();
  }
}

// 右端で切れる 1 冊が本物の背で、30〜40% のぞくように、本の並びを 0〜1 冊ぶんの範囲でずらす（並べる幅は 360／375／390／414 で違う）。
// ずらす量は、左の余白（14px まで）と本のあいだ（残りを等分）に分ける（左に大きな穴を開けない）
function fitPeek(ul) {
  if (ul.scrollLeft > 0) return; // 送った段はそのまま（測り直しで余白を消すと跳ねる）
  ul.style.paddingLeft = "";
  ul.style.gap = "";
  if (ul.scrollWidth <= ul.clientWidth + 4) return;
  const base = parseFloat(getComputedStyle(ul).paddingLeft) || 8;
  const gap = parseFloat(getComputedStyle(ul).gap) || 2;
  const right = ul.clientWidth;
  const items = [...ul.children].filter((li) => !li.classList.contains("fill") && getComputedStyle(li).display !== "none").map((li) => ({ li, left: li.offsetLeft, width: li.offsetWidth, real: !!li.querySelector(".spine, .slot, .box") }));
  if (items.length === 0) return;
  let best = null;
  for (let p = 0; p <= 56; p += 2) {
    const k = items.findIndex((it) => it.left + p + it.width > right);
    if (k < 0) break;
    const cross = items[k];
    const frac = (right - (cross.left + p)) / cross.width;
    const score = (cross.real ? 0 : 10) + Math.abs(frac - 0.35) + p / 1000;
    if (!best || score < best.score) best = { p, k, score, ok: cross.real && frac >= 0.26 && frac <= 0.46 };
    if (best.ok) break;
  }
  if (!best || best.p === 0) return;
  const pad = Math.min(best.p, 14);
  const rest = best.p - pad;
  if (pad > 0) ul.style.paddingLeft = `${base + pad}px`;
  if (rest > 0 && best.k > 0) ul.style.gap = `${gap + rest / best.k}px`;
}

// ---------- キーボード: 段の中は 1 本だけ Tab で止まり、←→ で動く ----------
function setupRoving() {
  for (const ul of root.querySelectorAll(".books")) {
    const items = [...ul.querySelectorAll("button.spine, button.box")];
    if (items.length === 0) continue;
    const active = items.find((b) => b.tabIndex === 0) ?? items[0];
    items.forEach((b) => (b.tabIndex = b === active ? 0 : -1));
  }
}

function roveTo(btn) {
  const ul = btn.closest(".books");
  if (!ul) return;
  ul.querySelectorAll("button.spine, button.box").forEach((b) => (b.tabIndex = b === btn ? 0 : -1));
  btn.focus({ preventScroll: true });
  btn.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior() });
}

// ---------- 本をさがす ----------
function finderRows(q) {
  const n = norm(q);
  if (!n) return FINDER.filter((r) => r.kind === "book" && FINDER_DEFAULT.includes(r.id)).sort((a, b) => FINDER_DEFAULT.indexOf(a.id) - FINDER_DEFAULT.indexOf(b.id));
  return FINDER.filter((r) => r.keys.includes(n));
}

function showFinder(q) {
  const list = root.querySelector("#bookFinderList");
  const hint = root.querySelector("#bookFinderHint");
  const rows = finderRows(q);
  hint.textContent = !norm(q) ? "よく開かれる本" : rows.length ? `${rows.length}${rows.every((r) => r.kind === "course") ? "コース" : "冊"}` : "見つからない。棚の名前でも探せる（社会、試験）";
  list.innerHTML = rows
    .slice(0, 16)
    .map((r) => `<li><button type="button" class="finder__row" data-${r.kind === "course" ? "course" : "book"}="${esc(r.id)}"><span class="finder__t">${numHtml(r.name)}</span><span class="finder__lead" aria-hidden="true"></span><span class="finder__m">${numHtml(r.meta)}</span></button></li>`)
    .join("");
}

// ---------- 押したときの動き ----------
function status(text) {
  const el = root?.querySelector("#bookshelfStatus");
  if (el) el.textContent = text;
}

function welcomeMeta(book, extra = {}) {
  const ja = book.lang.startsWith("日本語");
  return { shelf: shelfName(book.shelfId), title: book.full, sub: `${book.full}・答えは${ja ? "日本語" : "英語"}`, lang: ja ? "ja" : "en", cover: LEATHER[book.c] ?? LEATHER.walnut, ...extra };
}

async function openBook(id, btn) {
  const book = BOOKS.get(id);
  if (!book) return;
  if (id === "my" && book.count === 0) {
    location.href = "./list.html#myWords";
    return;
  }
  if (document.body.classList.contains("welcome-open")) {
    pickWelcomeBook(id, welcomeMeta(book));
    status(`机の本を替えた: ${book.full}`);
    return;
  }
  btn?.setAttribute("aria-busy", "true");
  status("読み込み中");
  try {
    await handlers.onPick?.(id);
  } finally {
    btn?.removeAttribute("aria-busy");
  }
  status(`机に出した: ${book.full}`);
}

async function openCourse(id, btn) {
  const course = COURSES[id];
  if (!course) return;
  if (document.body.classList.contains("welcome-open")) {
    const first = BOOKS.get(course.packs[0]);
    if (first) pickWelcomeBook(first.id, welcomeMeta(first, { course: id, shelf: course.label, sub: `${first.full}から・答えは英語` }));
    status(`机の本を替えた: ${course.label}`);
    return;
  }
  btn?.setAttribute("aria-busy", "true");
  status("読み込み中");
  try {
    await handlers.onCourse?.(id);
  } finally {
    btn?.removeAttribute("aria-busy");
  }
  status(`コースを替えた: ${course.label}`);
}

function setDoors(open) {
  const doors = root.querySelector("#archiveDoors");
  const inner = root.querySelector("#shelf-job");
  if (!doors || !inner) return;
  doorsOpen = open;
  inner.hidden = !open; // 段を測る（setupRows）前に出す（hidden のままだと矩形が 0）
  if (open && !jobsRendered) {
    inner.innerHTML = jobsHtml();
    jobsRendered = true;
    setupRows();
    setupRoving();
  }
  doors.setAttribute("aria-expanded", String(open));
  doors.classList.toggle("doors--open", open);
  const go = doors.querySelector(".doors__go-t");
  if (go) go.innerHTML = open ? "閉じる" : `<span class="n">${JOBS.reduce((n, r) => n + r.books.length, 0)}</span>冊を見る`;
  if (open) {
    const first = inner.querySelector("button.spine");
    if (first) roveTo(first);
  }
}

export function initBookshelf({ onPick, onCourse } = {}) {
  handlers = { onPick, onCourse };
  root = document.getElementById("bookshelf");
  if (!root) return;
  renderBookshelf();
  if (root.dataset.bound) return;
  root.dataset.bound = "1";

  root.addEventListener("click", (event) => {
    const spine = event.target.closest("button.spine");
    if (spine) return openBook(spine.dataset.book, spine);
    const box = event.target.closest("button.box");
    if (box) return openCourse(box.dataset.course, box);
    if (event.target.closest("#archiveDoors")) return setDoors(!doorsOpen);
    if (event.target.closest("#bookFinderOpen")) {
      const dlg = root.querySelector("#bookFinder");
      const q = root.querySelector("#bookFinderQ");
      if (!dlg || typeof dlg.showModal !== "function") return;
      q.value = "";
      showFinder("");
      dlg.dataset.picked = "";
      dlg.showModal();
      q.focus();
      return;
    }
    const row = event.target.closest(".finder__row");
    if (row) {
      const dlg = root.querySelector("#bookFinder");
      dlg.dataset.picked = "1";
      dlg.close();
      if (row.dataset.course) return openCourse(row.dataset.course);
      return openBook(row.dataset.book);
    }
    if (event.target.closest(".finder__close")) return root.querySelector("#bookFinder")?.close();
    const idx = event.target.closest(".shelf-index a");
    if (idx) {
      // 索引: その棚の上端を画面の上に（前の棚の札が上に残らない）。URL のハッシュは変えない
      event.preventDefault();
      const target = root.querySelector(idx.getAttribute("href"));
      target?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
      (target?.querySelector("button.spine[tabindex='0'], button.box[tabindex='0'], button") ?? target)?.focus?.({ preventScroll: true });
    }
  });

  // 段の中の矢印キー
  root.addEventListener("keydown", (event) => {
    const btn = event.target.closest("button.spine, button.box");
    if (!btn) return;
    const items = [...btn.closest(".books").querySelectorAll("button.spine, button.box")];
    const i = items.indexOf(btn);
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = items[Math.min(items.length - 1, i + 1)];
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = items[Math.max(0, i - 1)];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items[items.length - 1];
    if (!next) return;
    event.preventDefault();
    roveTo(next);
  });
  root.addEventListener("focusin", (event) => {
    const btn = event.target.closest("button.spine, button.box");
    if (btn) btn.closest(".books")?.querySelectorAll("button.spine, button.box").forEach((b) => (b.tabIndex = b === btn ? 0 : -1));
  });

  // 本をさがす: 打つたびに絞る。Enter は最初の 1 冊、Esc と外側で閉じる。閉じたら開いたボタンへ焦点を戻す（本を選んだときは机へ）
  root.addEventListener("input", (event) => {
    if (event.target.id === "bookFinderQ") showFinder(event.target.value);
  });
  // 入力欄の Enter（フォームに submit ボタンは置かない: 置くと Enter がそのボタンの click になり、閉じるボタンなら閉じてしまう）
  root.addEventListener("submit", (event) => {
    const dlg = event.target.closest("#bookFinder");
    if (!dlg) return;
    event.preventDefault();
    dlg.querySelector(".finder__row")?.click();
  });
  // 外側（backdrop）で閉じる。Esc は自前で閉じる（ページの他の keydown が先に止めても閉じるように）。閉じたら開いたボタンへ焦点を戻す
  root.addEventListener("click", (event) => {
    if (event.target.id === "bookFinder") event.target.close();
  });
  root.addEventListener("keydown", (event) => {
    const dlg = event.target.closest("#bookFinder");
    if (!dlg || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dlg.close();
  });
  root.addEventListener(
    "close",
    (event) => {
      const dlg = event.target;
      if (dlg?.id === "bookFinder" && !dlg.dataset.picked) root.querySelector("#bookFinderOpen")?.focus({ preventScroll: true });
    },
    true
  );

  // 幅が変わった・畳まれていた本棚が出た（プレイ中 → 机に戻る。畳まれている間は測れない）ら段を測り直す
  let resizeTimer = null;
  const remeasure = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setupRows, 120);
  };
  window.addEventListener("resize", remeasure);
  if (typeof ResizeObserver === "function") new ResizeObserver(remeasure).observe(root);
}
