import { getCategories, getPackCatalog, getWordsByCategory, MY_CATEGORY } from "./wordStore.js";
import { esc, numHtml } from "./html.js";
import { getWordStats, getCategoryBests } from "./storage.js";
import { COURSES, DEFAULT_COURSE, getCourseId } from "./course.js";
import { SHELVES, shelfIdOf, shelfOf } from "./shelves.js";
import { getEnabledPackIds } from "./packs.js";
import { pickWelcomeBook } from "./welcome.js";
import { scrollBehavior } from "./ui.js";
import { isPulling } from "./sync.js";
import { SHELF_KEY, parseShelf, serializeShelf, migrateShelf, reconcileShelf, noteStudyStart, shelfAtStart, applyStartChoice, startChanges, effectiveCourse, savedHas, addKey, dropKey, displayItems, packRows } from "./shelfStore.js";

// ===== わたしの本棚（書斎の右の列。スマホは机の下） =====
//
// 棚に並ぶのは自分の本だけ: 足した本・函（コース）＋机の本（空き）＋机の本が巻のコースの函（「いまのコース」）。
// 171 冊の目録は「本を足す」の窓（棚ごとの畳んだ見出し 9 つ・検索）。背を押すとその本が机に出る（読み込みは押したときに）、函はコース。
// 下ろすのは「整理」（背の上の紙の札）。棚の保存は localStorage の spelldash_shelf だけで、学習（packs・机・コース・記録）には書かない。
// 何を保存し何を並べるかの規則は js/shelfStore.js（純粋な関数。scripts/test-shelf.mjs）。ここは状態を集めて描くだけ。
//   initBookshelf({ onPick, onCourse }) … 1 回。描いて配線する。onPick(id) は本を机に出す、onCourse(id) はコースの乗り換え（js/main.js）
//   renderBookshelf()                   … 目録を組み直して描く（同期でパックが変わったとき）
//   updateBookshelf()                   … 照合して描き直す（renderHome から毎回。焦点を奪わない。入力が前回と同じなら何もしない・プレイ中は描かない。
//                                         書けなかった棚は入力が同じでも書き直しを試みる）
//   holdShelf()                         … 初回のスタートを押した（js/main.js の onStart の頭）: startShelf まで本棚は見せるだけで保存しない
//   startChoiceChanges(choice)          … 初回のスタートが替える状態（js/main.js の onStart が書く。下見の棚と同じ規則 js/shelfStore.js applyStartChoice）
//   startShelf()                        … 初回のスタート（状態を替えた後）: 下見の棚と同じ棚を保存する（保存した棚があればそれに足す。スタートの保存はこの 1 回）
//   rememberCourse(id)                  … 函・「コースを変える」でコースを選んだ: その函を棚に
// 初回（body.welcome-open）は「いまスタートしたら並ぶ物」を描くだけで保存しない（下見の棚）。閉じた直後の描き直しも見せるだけ
// （スタートで閉じたなら保存は startShelf、ログインの行・同期で閉じたなら次の描き直しが移行して保存する）。
// 見た目は css/bookshelf.css。動きは hover の持ち上がりだけ（prefers-reduced-motion では 0）。

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
  // 仕事の言葉（革は段ごとに回す。jobStyle）
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

// 棚の中の並び（目録の順）。"|" で始まる項目は旧い飾りの名残で、読み飛ばす。表に無い本（あとで足したパック）は棚の末尾に付く
const ORDER = {
  eng: ["elem-english", "jhs-english1", "jhs-english2", "jhs-english3", "junior", "highschool", "daily", "travel", "business", "it", "ads"],
  exam: ["eiken5", "eiken4", "eiken3", "eikenp2", "eiken2", "eikenp1", "eiken1", "toeic500", "toeic600", "toeic730", "toeic860", "toeic990", "toeic"],
  grammar: ["grammar-jhs1", "grammar-jhs2", "grammar-jhs3", "grammar-hs1", "grammar-hs2", "grammar-toeic", "writing-jhs-order", "writing-jhs", "writing-hs", "writing-eiken", "writing-interview"],
  social: ["elem-hist", "pref", "jgeo1", "jgeo2", "jhist1", "jhist2", "jcivics", "hs-japhist1", "hs-japhist2", "hs-worldhist1", "hs-worldhist2", "hs-geo", "hs-civics", "hs-ethics"],
  science: ["elem-sci", "jsci1", "jsci2", "hs-physics", "hs-chem", "hs-bio", "hs-earth", "elem-math", "jmath"],
  kokugo: ["elem-kanji", "jkokugo2", "jkokugo1", "hs-gendaibun", "hs-kobun", "hs-kanbun"]
};

// 函（コース）: 棚をまたぐコースと試験のコース、頻度順の 4 つの全集
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

// 仕事の言葉: 8 つの小見出し（窓の「仕事の言葉」の中）。背の色と高さもこの段と順で決める（棚の位置に依らない）。表に無い本は最後に付く
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

// 窓の棚ごとの見出し: 名前の後ろの 1 行（数は目録から数える）
const SHELF_NOTE = { course: "順に進むコース", eng: "答えは英語", exam: "答えは英語", grammar: "答えは英語", freq: "答えは英語", social: "答えは日本語", science: "答えは日本語", kokugo: "答えは日本語", job: "経理・医療・ITなど" };

// 検索: 書名・group・棚名・紹介文・対象のほかに引ける言葉（歴史→日本史・世界史、英検、TOEIC、公民、理科、仕事、かな読み）
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
  "writing-eiken": ["eiken", "えいけん"], jkokugo1: ["四字熟語", "よじじゅくご", "ことわざ"], pref: ["地理", "ちり"],
  my: ["自分", "じぶん", "マイ", "my"]
};
const COURSE_ALIAS = { eiken: ["eiken", "えいけん"], toeic: ["toeic", "トーイック", "トイック"], ngsl: ["ngsl", "基本語"], tsl: ["tsl", "toeic", "トーイック"], bsl: ["bsl", "ビジネス"], nawl: ["nawl", "学術", "論文"] };
const SEARCH_MAX = 30;

// 縦書きの背で 1〜2 桁の数字は縦中横
const tcy = (s) => esc(s).replace(/(^|\D)(\d{1,2})(?!\d)/g, '$1<span class="tcy">$2</span>');
// 本の題: 「中学英語 2年（教科書レベル）」の括弧書きは外す
const plainTitle = (label) => String(label ?? "").replace(/（[^）]*）$/, "").trim();
const kana = (s) => s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const norm = (s) => kana(String(s ?? "").normalize("NFKC").toLowerCase()).replace(/\s+/g, "");
const ICON = {
  lens: `<svg viewBox="0 0 17 17" aria-hidden="true" focusable="false"><circle cx="6.8" cy="6.8" r="4.9" fill="none" stroke="currentColor" stroke-width="1.15"/><path d="M10.4 10.6 15.6 15.8 14.6 16.4 9.9 11.3z" fill="currentColor"/></svg>`,
  close: `<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="M2.2 2.2 11.8 11.8M11.8 2.2 2.2 11.8" fill="none" stroke="currentColor" stroke-width="1.15"/></svg>`,
  arrow: `<svg viewBox="0 0 14 9" aria-hidden="true" focusable="false"><path d="M0 4.5h12.4M9 1l3.6 3.5L9 8" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
  plus: `<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 1v10M1 6h10" fill="none" stroke="currentColor" stroke-width="1.15"/></svg>`
};

// ---------- データ: manifest の 171 冊（＋マイ単語帳）と 10 の函 ----------
let BOOKS = new Map(); // id → book
let BOXES = new Map(); // コース id → box
let CATALOG = []; // 目録の表示順 [{ key, group }]（棚の並びの順。js/shelfStore.js displayItems）
let KNOWN = new Set(); // 目録にあるキー
let BASE = new Set(); // 基本カテゴリ（packs に入らない）
let BROWSE = []; // 窓の見出し 9 つ [{ id, name, unit, note, rows: [key], heads?: [{ name, rows }] }]
let SEARCH = []; // 検索の行 [{ key, title: [書名], alias: [棚名・別名], rest: [紹介文・対象] }]（目録の順。norm 済み）
let handlers = {};
let root = null;
let catalogSig = ""; // 目録の中身（本・函の id と数）。変わったときだけ catalogGen を進める（同期の後の 2 回目の renderBookshelf を吸収する）
let catalogGen = 0;

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

// 題か副題が 6 字以上の背（文字を少し小さく組む。css .spine--long）
const isLong = (book) => [...book.t].length >= 6 || [...(book.s ?? "")].length >= 6;

// 仕事の言葉の背: 革は段ごとに回し、高さは少しずつ変える（長い題の背は高く）
function jobStyle(book, row, i) {
  const c = JOB_LEATHER[(row + i) % JOB_LEATHER.length];
  const h = [126, 132, 120, 136, 128, 122, 134, 130][(row * 3 + i) % 8];
  return { ...book, c, h: isLong(book) ? Math.max(h, 136) : h, kind: c === "cloth" ? "cloth" : "leather", w: 46 };
}

function shelfName(id) {
  return SHELVES.find((s) => s.id === id)?.name ?? "";
}

// 函 1 つぶん（コース）。語数は巻の count の合計（基本カテゴリは読み込んだ語を数える）
function courseOf(courseId, catalog) {
  const course = COURSES[courseId];
  if (!course) return null;
  const spec = BOX[courseId] ?? { t: course.label, c: "walnut" };
  const words = course.packs.reduce((n, id) => n + (catalog.find((c) => c.id === id)?.count ?? getWordsByCategory(id).length), 0);
  return { id: courseId, course, vols: course.packs.length, words, ...spec };
}

const freqCourseOf = (id) => FREQ_BOXES.find((c) => COURSES[c]?.packs.includes(id)) ?? null;

function buildData() {
  const base = getCategories().filter((c) => !c.pack && c.id !== MY_CATEGORY.id);
  const packs = getPackCatalog();
  const all = [...base, ...packs];
  BASE = new Set(base.map((c) => c.id));
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
  // 棚の無い本は出せない（scripts/validate-words.mjs が manifest の全カテゴリに棚があることを確かめる）
  console.assert(unassigned.length === 0, "本棚: 棚の無い本", unassigned);
  // マイ単語帳は英単語の棚の末尾（171 冊には数えない）
  const my = bookOf({ id: MY_CATEGORY.id, label: MY_CATEGORY.label, kind: "" }, "eng");
  my.lang = "英語";
  BOOKS.set("my", my);
  // 仕事の言葉の背の色と高さ（小見出しの段と順で決める）
  const placedJobs = new Set(JOB_ROWS.flatMap((r) => r.books));
  const jobRest = byShelf.job.filter((b) => !placedJobs.has(b.id)).map((b) => b.id);
  const jobHeads = JOB_ROWS.map((row, r) => ({ name: row.name, ids: [...row.books.filter((id) => BOOKS.get(id)?.shelfId === "job"), ...(r === JOB_ROWS.length - 1 ? jobRest : [])] }));
  jobHeads.forEach((head, r) => head.ids.forEach((id, i) => BOOKS.set(id, jobStyle(BOOKS.get(id), r, i))));

  BOXES = new Map([...COURSE_BOXES, ...FREQ_BOXES].map((id) => [id, courseOf(id, all)]).filter(([, box]) => box));
  // 目録の順: 函 → 英単語（＋マイ単語帳）→ 試験 → 文法 → 頻度順の巻 → 社会 → 理科 → 国語 → 仕事
  const ordered = (shelfId) => {
    const list = (ORDER[shelfId] ?? []).filter((id) => BOOKS.get(id)?.shelfId === shelfId);
    const placed = new Set(list);
    return [...list, ...byShelf[shelfId].filter((b) => !placed.has(b.id)).map((b) => b.id)];
  };
  const shelfIds = {
    eng: [...ordered("eng"), "my"],
    exam: ordered("exam"),
    grammar: ordered("grammar"),
    freq: byShelf.freq.map((b) => b.id),
    social: ordered("social"),
    science: ordered("science"),
    kokugo: ordered("kokugo"),
    job: jobHeads.flatMap((h) => h.ids)
  };
  const boxKeys = [...BOXES.keys()].map((id) => ({ key: `c:${id}`, group: "course" }));
  CATALOG = [...boxKeys, ...["eng", "exam", "grammar", "freq", "social", "science", "kokugo", "job"].flatMap((g) => shelfIds[g].map((id) => ({ key: `b:${id}`, group: g })))];
  KNOWN = new Set(CATALOG.map((x) => x.key));
  // 窓の見出し 9 つ（頻度順は全集の函 4 つだけ。巻 58 は検索で出る）
  BROWSE = SHELVES.map((shelf) => {
    if (shelf.id === "course") return { id: shelf.id, name: shelf.name, unit: "組", rows: COURSE_BOXES.filter((id) => BOXES.has(id)).map((id) => `c:${id}`) };
    if (shelf.id === "freq") return { id: shelf.id, name: shelf.name, unit: "組", rows: FREQ_BOXES.filter((id) => BOXES.has(id)).map((id) => `c:${id}`) };
    if (shelf.id === "job") return { id: shelf.id, name: shelf.name, unit: "冊", rows: shelfIds.job.map((id) => `b:${id}`), heads: jobHeads.map((h) => ({ name: h.name, rows: h.ids.map((id) => `b:${id}`) })) };
    return { id: shelf.id, name: shelf.name, unit: "冊", rows: (shelfIds[shelf.id] ?? []).map((id) => `b:${id}`) };
  }).map((s) => ({ ...s, note: SHELF_NOTE[s.id] ?? "" }));
  // 検索: 本 171（頻度順の巻を含む）＋マイ単語帳＋コース 10。並びは照合の強さ（searchRows）、同じ強さなら目録の順
  const normed = (list) => list.filter(Boolean).map(norm).filter(Boolean);
  SEARCH = CATALOG.map(({ key }) => {
    const id = key.slice(2);
    if (key.startsWith("c:")) {
      const c = COURSES[id];
      const box = BOXES.get(id);
      return { key, title: normed([c.label, box ? box.t + (box.s ?? "") : ""]), alias: normed(["コース", "こーす", ...(COURSE_ALIAS[id] ?? [])]), rest: normed([c.blurb, c.audience]) };
    }
    const b = BOOKS.get(id);
    // manifest の group（「中学校（社会・理科・国語・数学）」など）は教科を束ねた名前なので、棚名と同じ強さにせず紹介文と同じ 4 に（「理科」で社会の本が理科の本より先に来ない）
    return { key, title: normed([b.full, b.label, b.t + b.s]), alias: normed([shelfName(b.shelfId), ...(SHELF_ALIAS[b.shelfId] ?? []), ...(BOOK_ALIAS[id] ?? [])]), rest: normed([b.group, b.blurb, b.audience]) };
  });
  const sig = JSON.stringify([CATALOG.map((x) => x.key), [...BOOKS.values()].map((b) => b.count), [...BOXES.values()].map((b) => b.words)]);
  if (sig !== catalogSig) {
    catalogSig = sig;
    catalogGen++;
  }
  updateFindCount();
}

// 目録の本の数（171。マイ単語帳は数えない）
const catalogCount = () => [...BOOKS.keys()].filter((id) => id !== "my").length;

function updateFindCount() {
  const n = document.querySelector("#welcomeFind .n");
  if (n && BOOKS.size) n.textContent = String(catalogCount());
}

// ---------- 状態 ----------
const isWelcome = () => document.body.classList.contains("welcome-open");
const deskId = () => localStorage.getItem(CATEGORY_KEY) || "all";
const myCount = () => getWordsByCategory(MY_CATEGORY.id).length;

// いまの状態（js/shelfStore.js の snap）
function snapNow() {
  const stats = getWordStats();
  return {
    packs: getEnabledPackIds(),
    course: getCourseId(),
    desk: deskId(),
    myCount: myCount(),
    statsEmpty: Object.keys(stats).length === 0,
    best: getCategoryBests(),
    courses: COURSES,
    defaultCourse: DEFAULT_COURSE,
    freqCourseOf,
    isBase: (id) => BASE.has(id),
    isPack: (id) => getPackCatalog().some((c) => c.id === id), // manifest の分野パック（棚の割り付けが無く目録に入らないパックも。初回のスタートが packs に足すか）
    known: KNOWN,
    hasRecords: (ids) => ids.some((id) => getWordsByCategory(id).some((w) => stats[w.id])),
    baseRecordCounts: () => [...BASE].map((id) => ({ id, n: getWordsByCategory(id).filter((w) => stats[w.id]).length }))
  };
}

// 保存した棚は毎回 localStorage から読み直す（別のタブの単語帳・本棚の書き込みを古い値で上書きしない）。
// 書けなかった（容量・プライベートモード）ときだけ、その値をメモリに持って描き、次の照合で書き直しを試みる
let memShelf = null;
function rawShelf() {
  try {
    return localStorage.getItem(SHELF_KEY);
  } catch {
    return null;
  }
}

function loadShelf() {
  const shelf = parseShelf(rawShelf());
  if (shelf && !memShelf) return shelf;
  return memShelf ?? shelf;
}

function saveShelf(shelf) {
  try {
    localStorage.setItem(SHELF_KEY, serializeShelf(shelf));
    memShelf = null;
  } catch {
    memShelf = shelf;
  }
}

// 描くための棚: 普段は保存した棚を照合して（無ければ移行して）保存する。次の間は保存せずに組み立てるだけ（peekShelf）:
//   取り込みの途中（js/sync.js isPulling）… 記録だけ届いてコース・机の本・パックがまだ前の値（既定のコース）のことがあるので、移行・照合を保存しない
//     （保存すると、2 台目で使っていない中学英語やり直しの函が棚に残る）。取り込みが終わると spelldash:synced／spelldash:packs で描き直して保存する
//   初回のスタートを押してから startShelf まで（holdShelf）… 状態がスタートで替わる前の値なので、移行・照合を保存しない（保存はスタートの 1 回）
function viewShelf(snap) {
  return isPulling() || startHeld ? peekShelf(snap) : currentShelf(snap);
}

function peekShelf(snap) {
  const stored = loadShelf();
  return stored ? reconcileShelf(stored, snap).shelf : migrateShelf(snap);
}

// 保存した棚（無ければ移行して作る）を照合して返す。変わったときだけ書く
function currentShelf(snap) {
  let shelf = loadShelf();
  let dirty = !!memShelf;
  if (!shelf) {
    shelf = migrateShelf(snap);
    dirty = true;
  }
  const r = reconcileShelf(shelf, snap);
  if (r.changed || dirty) saveShelf(r.shelf);
  return r.shelf;
}

// ---------- 描画 ----------
function spineLabel(book) {
  const extra = book.id === "jkokugo2" || book.id === "hs-kanbun" ? "、一部は漢字で答える" : "";
  const n = book.id === "my" && book.count === 0 ? "語はまだ無い" : `${book.count}${book.unit}`;
  return `${book.full}、${n}、答えは${book.lang.split("・")[0]}${extra}`;
}

function boxLabel(box, current) {
  return `${box.course.label} 全${box.vols}巻（コース）、${box.words}語、答えは英語${current ? "、いまのコース" : ""}`;
}

// 背・函は普段は押せるボタン、整理の形では押せない絵（名前は残す）
const tagOpen = (asButton, cls, data, style, label) =>
  asButton ? `<button type="button" class="${cls}" ${data} style="${style}" aria-label="${esc(label)}" tabindex="-1">` : `<span class="${cls}" ${data} style="${style}" role="img" aria-label="${esc(label)}">`;

function spineInner(book, asButton = true) {
  const cls = ["spine", book.kind === "cloth" || book.kind === "label" ? "spine--cloth" : "", book.kind === "label" ? "spine--label" : "", book.kind === "vellum" ? "spine--vellum spine--label" : "", book.vol ? "spine--vol" : "", book.id === "my" ? "spine--my" : "", isLong(book) ? "spine--long" : ""].filter(Boolean).join(" ");
  const t = book.lat ? `<span class="lat">${esc(book.t)}</span>` : tcy(book.t);
  const s = book.s ? (/^\d{3}$/.test(book.s) || /^[A-Za-z]+$/.test(book.s) ? `<span class="spine__s lat">${esc(book.s)}</span>` : `<span class="spine__s">${tcy(book.s)}</span>`) : "";
  const style = `--c:${leather(book.c)};--h:${book.h}px;--w:${book.w}px`;
  return `${tagOpen(asButton, cls, `data-book="${esc(book.id)}"`, style, spineLabel(book))}<span class="spine__l" aria-hidden="true"><span class="spine__t">${t}</span>${s}</span>${book.vol ? `<span class="spine__v" aria-hidden="true">${book.vol}</span>` : ""}${asButton ? "</button>" : "</span>"}`;
}

// 机の本の空き: 穴の中に代本板（図書室で借りた本の跡に立てる板）。仔牛皮紙の薄い板に縦書きで短い題と「机の上」（名前は空きの aria-label が言う）
function slotInner(book) {
  const t = book.lat ? `<span class="lat">${esc(book.t)}</span>` : tcy(book.t);
  const latS = /^[A-Za-z0-9]{1,4}$/.test(book.s ?? "");
  const s = book.s && (latS || [...book.t].length + [...book.s].length <= 7) ? `<span class="slot__s">${latS ? `<span class="lat">${esc(book.s)}</span>` : tcy(book.s)}</span>` : "";
  return `<span class="slot" role="img" aria-label="${esc(book.full)}は机の上" style="--w:${slotWidth(book)}px;--h:${book.h}px"><span class="slot__card" aria-hidden="true"><span class="slot__t">${t}${s}</span><span class="slot__k">机の上</span></span></span>`;
}

function boxInner(box, current, asButton = true) {
  const s = box.s ? (/^[A-Z]+$/.test(box.s) ? `<span class="spine__s lat">${esc(box.s)}</span>` : `<span class="spine__s">${tcy(box.s)}</span>`) : "";
  const t = box.lat ? `<span class="lat">${esc(box.t)}</span>` : esc(box.t);
  const style = `--c:${leather(box.c)}${box.w ? `;--w:${box.w}px` : ""}${box.h ? `;--h:${box.h}px` : ""}`;
  const cls = `box${current ? " box--reading" : ""}${[...box.t].length >= 6 ? " box--long" : ""}`;
  return `${tagOpen(asButton, cls, `data-course="${esc(box.id)}"`, style, boxLabel(box, current))}<span class="box__vols" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="box__l" aria-hidden="true"><span class="spine__t">${t}</span>${s}</span><span class="box__n" aria-hidden="true">全<b>${box.vols}</b>巻</span>${asButton ? "</button>" : "</span>"}`;
}

const slotWidth = (book) => Math.max(40, book.w - 4);
const nameOf = (key) => (key.startsWith("c:") ? BOXES.get(key.slice(2))?.course.label : BOOKS.get(key.slice(2))?.full) ?? key.slice(2);

// 物の幅（css と同じ値。段の割り付けに使う）
function widthOf(item) {
  if (item.kind === "box") return BOXES.get(item.id)?.w ?? 68;
  const book = BOOKS.get(item.id);
  if (!book) return 44;
  return item.kind === "slot" ? slotWidth(book) : book.w;
}

function itemLi(item, gap, tidy) {
  // 群（函・目録の棚割り）の境目は間を 10px（class g）。整理の形で下ろした物は「終わる」まで同じ場所に暗く残る（class is-dropped・札は「戻す」）
  const cls = [gap === 10 ? "g" : "", item.dropped ? "is-dropped" : ""].filter(Boolean).join(" ");
  const attrs = `${cls ? ` class="${cls}"` : ""} data-group="${esc(item.group)}"`;
  const slip = tidy && item.droppable ? slipHtml(item.key, item.dropped) : "";
  if (item.kind === "box") {
    const box = BOXES.get(item.id);
    return `<li role="listitem"${attrs} data-key="${esc(item.key)}" data-course="${esc(item.id)}">${boxInner(box, item.current, !tidy)}${slip}</li>`;
  }
  const book = BOOKS.get(item.id);
  if (item.kind === "slot") return `<li role="listitem"${attrs} data-key="${esc(item.key)}" data-book="${esc(item.id)}" data-state="slot">${slotInner(book)}</li>`;
  return `<li role="listitem"${attrs} data-key="${esc(item.key)}" data-book="${esc(item.id)}">${spineInner(book, !tidy)}${slip}</li>`;
}

// 整理の札: 「下ろす」。下ろした物は同じ札が「戻す」に替わる（指の下で物が動かない。2 回押しても隣の本は下りない）
function slipHtml(key, dropped = false) {
  const label = dropped ? `${nameOf(key)}を棚に戻す` : `${nameOf(key)}を棚から下ろす`;
  return `<button type="button" class="slip${dropped ? " slip--back" : ""}" data-key="${esc(key)}"${dropped ? ' data-act="back"' : ""} aria-label="${esc(label)}" tabindex="-1"><span class="slip__paper" aria-hidden="true">${dropped ? "戻す" : "下ろす"}</span></button>`;
}

// 段の中の幅（#shelfRun の内側 − .books の左右の余白）。畳まれている間（プレイ中は display: none）は前に測った幅、一度も測っていなければ画面幅からの仮の幅
let lastInner = 0;
function rowInner() {
  const run = root.querySelector("#shelfRun");
  const px = parseFloat(getComputedStyle(root).getPropertyValue("--books-px")) || 8;
  const w = run?.clientWidth ?? 0;
  if (w > 0) {
    lastInner = Math.floor(w - 2 * px);
    return lastInner;
  }
  if (lastInner) return lastInner;
  const vw = window.innerWidth;
  return vw < 600 ? vw - 56 : vw < 1100 ? Math.min(580, vw - 56) : Math.min(440, vw - 760) - 44;
}

// 最低の段数: < 1100 は 1 段。≥1100 は台輪の下端が机の列（#nook）の下端に届くまで（2〜6 段。床から立つ書架に）。
// 机の列は sticky（js/room.js）なので画面の位置ではなく高さで測る（机の列も本棚も同じ格子の行の頭から始まる。格子は align-items: start なので机の列の高さは本棚に左右されない）。
// lastSpace = 段（と腰の扉）に使える高さ（台輪 30px を除く）、lastRowH = 1 段の高さ
let lastMinRows = 1;
let lastSpace = 0;
let lastRowH = 226;
function minRows() {
  if (!window.matchMedia("(min-width: 1100px)").matches) {
    lastSpace = 0;
    return 1;
  }
  const nook = document.getElementById("nook");
  const run = root.querySelector("#shelfRun");
  const grid = nook?.parentElement;
  if (!nook || !run || !grid || root.getClientRects().length === 0) return lastMinRows;
  lastRowH = run.querySelector(".shelf")?.offsetHeight || 226;
  const runTop = run.getBoundingClientRect().top - grid.getBoundingClientRect().top;
  lastSpace = nook.offsetHeight - runTop - 30;
  lastMinRows = Math.max(2, Math.min(6, Math.floor(lastSpace / lastRowH)));
  return lastMinRows;
}

// ---------- 棚の段 ----------
let mode = "normal"; // "normal" | "tidy"
let lastItems = [];
let lastWelcome = false;
let lastHtml = "";
let lastPlan = null;
let activeKey = "";
let lastInput = ""; // 前回の描き直しの入力（stateInput＋shelfInput）。保存しない描き直しの後は空（次の描き直しで組み直して保存する）
let drawPending = false; // 畳まれている間（プレイ中）に替わった: 開いたときに描く

function draw(items, welcome) {
  lastItems = items;
  lastWelcome = welcome;
  drawPending = false;
  const run = root.querySelector("#shelfRun");
  if (!run) return;
  const tidy = mode === "tidy" && !welcome;
  const inner = rowInner();
  const least = minRows();
  const plan = packRows(items.map((it) => ({ w: widthOf(it), group: it.group })), inner, { minRows: least, hint: items.length <= 3 && !tidy });
  lastPlan = plan;
  const rows = plan.rows.map((row, r) => {
    const lis = row.items.map(({ i, gap }) => itemLi(items[i], gap, tidy)).join("");
    const end = r === plan.rows.length - 1 && plan.end ? `<li class="shelf-end" aria-hidden="true"><span class="bookend"></span></li>` : "";
    return `<div class="shelf"><div class="shelf__in"><ul class="books" role="none">${lis}${end}</ul></div><div class="shelf__board" aria-hidden="true"></div></div>`;
  });
  // ≥1100: 空の段は 1 枚（一文を置く段・足す余地）だけにし、その下は書架の腰の扉で机の列の下端まで埋める（台輪が机の列の下端に立つ）。
  // 扉の高さが 40px に満たないときは今までどおり空の段で（段は整数枚なので台輪は机の列の下端から 1 段未満の上）
  let shelves = plan.total;
  let doorsH = 0;
  if (least > 1 && lastSpace > 0) {
    const want = plan.rows.length + 1;
    const rest = Math.floor(lastSpace - want * lastRowH);
    if (rest >= 40) {
      shelves = want;
      doorsH = rest;
    }
  }
  for (let r = plan.rows.length; r < shelves; r++) rows.push(`<div class="shelf shelf--empty" aria-hidden="true"><div class="shelf__in"><ul class="books" role="none"></ul></div><div class="shelf__board"></div></div>`);
  if (doorsH) rows.push(`<div class="shelf-doors" aria-hidden="true" style="height:${doorsH}px"><i></i><i></i></div>`);
  const html = rows.join("");
  if (html !== lastHtml) {
    const active = document.activeElement;
    const focusKey = active && run.contains(active) ? active.closest("li")?.dataset.key ?? "" : "";
    const focusSlip = !!active?.classList?.contains("slip");
    run.innerHTML = html;
    lastHtml = html;
    setupRoving();
    if (focusKey) {
      const li = run.querySelector(`li[data-key="${CSS.escape(focusKey)}"]`);
      (li?.querySelector(focusSlip ? "button.slip" : "button") ?? run.querySelector(tidy ? "button.slip" : "button.spine, button.box"))?.focus({ preventScroll: true });
    }
  }
  placeHint(plan, welcome, tidy);
}

// 一文: リストの外（#shelfRun の兄弟）。packRows が決めた段・左端・幅に置く（少ない棚だけ）
function placeHint(plan, welcome, tidy) {
  const hint = root.querySelector("#shelfHint");
  const run = root.querySelector("#shelfRun");
  if (!hint || !run) return;
  if (!plan.hint || tidy || !BOOKS.size) {
    hint.hidden = true; // 目録の準備前（初回の読み込み中）は出さない: 出すと読み込み後に一文が下の段へ跳ぶ
    return;
  }
  const html = welcome ? "<span>ほかの本は、あとから足せる。</span>" : `<span><button type="button" class="shelf-hint__add">本を足す</button>と、ここに並ぶ。</span>`;
  if (hint.innerHTML !== html) hint.innerHTML = html;
  const rowEl = run.children[plan.hint.row];
  const books = rowEl?.querySelector(".books");
  if (!rowEl || !books) {
    hint.hidden = true;
    return;
  }
  const cs = getComputedStyle(books);
  const px = parseFloat(cs.paddingLeft) || 0;
  hint.hidden = false;
  hint.classList.toggle("shelf-hint--center", plan.hint.center);
  hint.style.top = `${rowEl.offsetTop + (parseFloat(cs.paddingTop) || 0)}px`;
  hint.style.left = `${run.offsetLeft + px + plan.hint.left}px`;
  hint.style.width = `${plan.hint.width}px`;
}

// キーボード: 棚全体で 1 つだけ Tab で止まり、←→↑↓・Home・End で動く（整理の形では札どうし）
const focusables = () => [...root.querySelectorAll(mode === "tidy" ? "#shelfRun button.slip" : "#shelfRun button.spine, #shelfRun button.box")];

function setupRoving() {
  const items = focusables();
  if (items.length === 0) return;
  const active = items.find((b) => b.closest("li")?.dataset.key === activeKey) ?? items[0];
  items.forEach((b) => (b.tabIndex = b === active ? 0 : -1));
}

// view: 画面に入れる要素（既定は焦点の物。整理に入ったときは最初の段ごと）
function roveTo(btn, view = btn) {
  activeKey = btn.closest("li")?.dataset.key ?? "";
  focusables().forEach((b) => (b.tabIndex = b === btn ? 0 : -1));
  btn.focus({ preventScroll: true });
  view.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior() });
}

// ---------- 見出しの欄・骨組み ----------
function ensureSkeleton() {
  root = document.getElementById("bookshelf");
  if (!root || root.querySelector("#shelfRun")) return root;
  root.innerHTML = `
    <div class="cabinet">
      <div class="cabinet__cornice" aria-hidden="true"><i class="cabinet__frieze"></i></div>
      <div class="cabinet__rail">
        <h2 class="bookshelf__title" id="bookshelfTitle">わたしの本棚</h2>
        <div class="rail__acts">
          <button type="button" class="find" id="bookFinderOpen" aria-haspopup="dialog" hidden>${ICON.plus}<span>本を足す</span></button>
          <button type="button" class="find" id="shelfTidy" hidden><span>整理</span></button>
        </div>
        <p class="rail__note" id="shelfNote" aria-live="polite" hidden></p>
      </div>
      <div class="cabinet__body">
        <div class="shelf-run" id="shelfRun" role="list" aria-label="棚の本"></div>
        <p class="shelf-hint" id="shelfHint" hidden></p>
      </div>
      <div class="cabinet__plinth" aria-hidden="true"></div>
    </div>
    <p class="sr-only" id="bookshelfStatus" role="status"></p>
    <dialog class="finder" id="bookFinder" aria-labelledby="bookFinderTitle">
      <form method="dialog" class="finder__card">
        <div class="finder__head"><h2 id="bookFinderTitle">本を足す</h2><button type="button" class="finder__close" aria-label="閉じる">${ICON.close}</button></div>
        <label class="finder__field"><span class="sr-only">書名・教科・試験</span>${ICON.lens}<input id="bookFinderQ" type="search" placeholder="書名・教科・試験（例: 歴史、英検）" autocomplete="off" enterkeyhint="search" /></label>
        <p class="finder__hint" id="bookFinderHint">棚ごとの一覧</p>
        <div class="finder__body">
          <div class="finder__browse" id="bookFinderBrowse"></div>
          <ol class="finder__list" id="bookFinderList" hidden></ol>
        </div>
        <p class="sr-only" id="bookFinderStatus" role="status"></p>
      </form>
    </dialog>`;
  return root;
}

function updateRail(items, welcome) {
  const tidyBtn = root.querySelector("#shelfTidy");
  const open = root.querySelector("#bookFinderOpen");
  const droppable = items.some((it) => it.droppable);
  if (tidyBtn) tidyBtn.hidden = welcome || (mode !== "tidy" && !droppable);
  if (open) open.hidden = welcome || mode === "tidy";
}

function show() {
  if (root?.hidden) root.hidden = false;
}

// ---------- 普段の棚・初回の下見の棚 ----------
// 描き直すかの入力（snap を組む前に、安い物だけで比べる）: 学習の状態の要点（packs・コース・机の本・マイ単語帳の数・記録が空か・カテゴリ別の最高）・
// 取り込みの途中か・整理の形と下ろした物・目録の版（stateInput）＋保存した棚の文字列と書けなかった棚（shelfInput）。
// 前回と同じなら何もしない（renderHome は操作のたびに呼ぶ。同期の後の renderHome → renderBookshelf の 2 回目もここで吸収する）。
// 移行・照合が使う記録の細部（hasRecords）は、保存した棚が無いか仮の棚のときだけ効き、そのときは保存した棚の文字列が替わるか記録が空かが替わる。
// 記録が空かは、前に組んだ snap で空でなかったら読まない（記録は増えるだけ。消す所 js/backup.js clearLocalRecords は保存した棚も消すので、棚の文字列で替わる）
const folded = () => document.body.classList.contains("home--playing");
let lastStatsEmpty = true;
const stateInput = () => JSON.stringify([getEnabledPackIds(), getCourseId(), deskId(), myCount(), lastStatsEmpty && Object.keys(getWordStats()).length === 0, getCategoryBests(), isPulling(), mode, [...tidyDropped], catalogGen]);
const shelfInput = () => JSON.stringify([rawShelf(), memShelf ? serializeShelf(memShelf) : ""]);

export function updateBookshelf() {
  refresh(true);
}

// save: false は見せるだけ（初回の画面を閉じた直後の描き直し）。スタートの保留中（holdShelf）も保存しない。
// 保存しない描き直しは入力を覚えない（次の描き直しは前回と同じ入力でも組み直して保存する）
function refresh(save) {
  if (!root?.isConnected) return;
  if (isWelcome()) return drawWelcome();
  if (!BOOKS.size) return;
  if (lastWelcome) mode = "normal";
  show();
  const keep = save && !startHeld;
  // 書けなかった棚（容量・プライベートモード）: 描き直すたびに書き直しを試みる（入力が同じでも）。書けたら memShelf は消え、棚の文字列が替わるので下で描き直す
  if (keep && memShelf) saveShelf(memShelf);
  const state = stateInput();
  if (keep && state + shelfInput() === lastInput) {
    if (drawPending && !folded()) draw(lastItems, false);
    return;
  }
  const snap = snapNow();
  lastStatsEmpty = snap.statsEmpty;
  BOOKS.get("my").count = snap.myCount;
  const shelf = keep ? viewShelf(snap) : peekShelf(snap);
  let items = displayItems(shelf, snap, CATALOG);
  if (mode === "tidy" && tidyDropped.size) {
    // 整理の形で下ろした物は「終わる」まで同じ場所に（目録の順なので、足し戻した棚で並べると元の位置になる）。ほかで足し戻された物は外す
    for (const key of [...tidyDropped]) if (savedHas(shelf, key)) tidyDropped.delete(key);
    const ghost = [...tidyDropped].reduce((sh, key) => addKey(sh, key), shelf);
    items = displayItems(ghost, snap, CATALOG).map((it) => (tidyDropped.has(it.key) && it.droppable ? { ...it, dropped: true } : it));
  }
  lastInput = keep ? state + shelfInput() : ""; // 照合で書いた後の棚の文字列で覚える（次に同じ状態で呼ばれたら何もしない）
  if (folded()) {
    // プレイ中は本棚が畳まれている（display: none）: 段の割り付けに要る幅・高さを読まない。開いたとき（机に戻る・ResizeObserver）に描く
    lastItems = items;
    lastWelcome = false;
    drawPending = true;
  } else {
    draw(items, false);
  }
  updateRail(items, false);
  syncFinderStates(shelf, snap);
}

// 初回の棚（下見）: welcome がいま机に載せている本（と、窓で選んだ函）でスタートしたら並ぶ物。保存しない
let welcomeCourse = null; // { id, book }（窓・函で選んだコース。机の本が別の本に替わったら忘れる）
function welcomeChoice() {
  const bookId = document.querySelector("#welcome [data-welcome-start]")?.dataset.book || "";
  const courseId = welcomeCourse && welcomeCourse.book === bookId ? welcomeCourse.id : "";
  return { bookId, courseId };
}

function drawWelcome() {
  if (!ensureSkeleton()) return;
  show();
  mode = "normal";
  root.dataset.mode = "";
  lastInput = ""; // 普段の棚に戻ったら描き直す
  let items = [];
  if (BOOKS.size) {
    const snap = snapNow();
    const next = applyStartChoice(snap, welcomeChoice());
    items = displayItems(shelfAtStart(next, loadShelf()), next, CATALOG);
  }
  draw(items, true);
  updateRail(items, true);
  const note = root.querySelector("#shelfNote");
  if (note) note.hidden = true;
}

// 目録を組み直して描く。目録も入力も前と同じなら何もしない（updateBookshelf）
export function renderBookshelf() {
  if (!ensureSkeleton()) return;
  buildData();
  updateBookshelf();
}

// 初回のスタートが替える状態 { course, desk, packs }（js/main.js onStart がこのとおりに書く）。下見の棚（drawWelcome）と同じ規則で求める
export function startChoiceChanges(choice) {
  if (!BOOKS.size) buildData();
  return startChanges(snapNow(), choice);
}

// 初回のスタートを押した（js/main.js onStart の頭。語の読み込みを待つ前に同期で呼ぶ）: startShelf までは本棚を見せるだけで保存しない。
// スタートで替わる前の状態（コース・机の本・packs）で移行した棚を書かない（語の読み込みの前に押したときは、その間にできる本棚 initBookshelf の描き直しも）
let startHeld = false;
export function holdShelf() {
  startHeld = true;
}

// スタートの処理が startShelf の前に失敗した（語の読み込みの失敗など）: 保留を解いて、次の描き直しから普通に移行・照合して保存する
export function releaseShelf() {
  startHeld = false;
}

// 初回のスタート（js/main.js onStart: 状態を替えた後・renderHome の前）: 下見の棚と同じ棚を保存する（スタートの保存はこの 1 回）。
// 保存した棚があれば（深いリンクで来て本を足してから初回の画面に来た人）それに足す（足した本・函を消さない。js/shelfStore.js shelfAtStart）。
// 初回の画面を閉じてからここまでは何も保存しない（閉じた直後の描き直しは見せるだけ・holdShelf）ので、保存した棚は下見の材料と同じ
export function startShelf() {
  startHeld = false;
  if (!BOOKS.size) buildData();
  saveShelf(shelfAtStart(snapNow(), loadShelf()));
}

// 函を押した・「コースを変える」で選んだ（js/main.js chooseCourse）: その函を棚に
export function rememberCourse(courseId) {
  if (!COURSES[courseId] || isWelcome()) return;
  if (!BOOKS.size) buildData();
  saveShelf(addKey(viewShelf(snapNow()), `c:${courseId}`));
}

// E2E とデバッグ用: 目録の順のキー
export function shelfCatalogKeys() {
  return CATALOG.map((x) => x.key);
}

// 机の本で 1 セット始めた（spelldash:game-start の study）: 机の本を棚に保存する。描き直しはしない（プレイ中は本棚が畳まれている）
function noteStudy() {
  if (isWelcome() || !BOOKS.size) return;
  const snap = snapNow();
  const stored = loadShelf();
  const r = noteStudyStart(viewShelf(snap), snap);
  if (r.changed || !stored) saveShelf(r.shelf);
}

// ---------- 押したときの動き ----------
function status(text) {
  const el = root?.querySelector("#bookshelfStatus");
  if (el) el.textContent = text;
}

function finderStatus(text) {
  const el = root?.querySelector("#bookFinderStatus");
  if (el) el.textContent = text;
}

function welcomeMeta(book, extra = {}) {
  const ja = book.lang.startsWith("日本語");
  return { shelf: shelfName(book.shelfId), title: book.full, sub: `${book.full}・答えは${ja ? "日本語" : "英語"}`, lang: ja ? "ja" : "en", cover: LEATHER[book.c] ?? LEATHER.walnut, ...extra };
}

// 初回: 机の本を替えるだけ（始めない・packs も棚も書かない）。下見の棚が替わる
function pickInWelcome(key) {
  if (!isWelcome()) return; // welcome が畳まれた後（ログイン・同期）に残った窓の行では机の本を替えない
  const id = key.slice(2);
  if (key.startsWith("c:")) {
    const course = COURSES[id];
    const first = course && BOOKS.get(course.packs[0]);
    if (!first) return;
    welcomeCourse = { id, book: first.id };
    pickWelcomeBook(first.id, welcomeMeta(first, { course: id, shelf: course.label, sub: `${first.full}から・答えは英語` }));
    status(`机の本を替えた: ${course.label}`);
  } else {
    const book = BOOKS.get(id);
    if (!book) return;
    welcomeCourse = null;
    pickWelcomeBook(id, welcomeMeta(book));
    status(`机の本を替えた: ${book.full}`);
  }
  drawWelcome(); // 机の本が同じ本のまま（data-book が替わらない）でも、函を選んだら下見を描き直す
}

async function openBook(id, btn) {
  const book = BOOKS.get(id);
  if (!book) return;
  if (id === "my" && book.count === 0) {
    location.href = "./list.html#myWords";
    return;
  }
  if (isWelcome()) return pickInWelcome(`b:${id}`);
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
  if (isWelcome()) return pickInWelcome(`c:${id}`);
  btn?.setAttribute("aria-busy", "true");
  status("読み込み中");
  try {
    await handlers.onCourse?.(id);
  } finally {
    btn?.removeAttribute("aria-busy");
  }
  status(`コースを替えた: ${course.label}`);
}

// ---------- 整理（下ろす） ----------
// 下ろした物は「終わる」まで同じ場所に暗く残り、札は「戻す」に替わる（指の下で物が詰まらないので、2 回押しても隣は下りない。どれでも戻せる）
const tidyDropped = new Set();
let lastSlip = { key: "", at: 0 };

function noteHtml(html) {
  const note = root.querySelector("#shelfNote");
  if (!note) return;
  note.innerHTML = html;
  note.hidden = !html;
}

function setTidy(on, { focus = true } = {}) {
  mode = on ? "tidy" : "normal";
  root.dataset.mode = on ? "tidy" : "";
  tidyDropped.clear();
  const tidyBtn = root.querySelector("#shelfTidy");
  if (tidyBtn) tidyBtn.innerHTML = `<span>${on ? "終わる" : "整理"}</span>`;
  noteHtml(on ? "下ろす本の札を押す。記録は消えない。" : "");
  updateBookshelf();
  if (!focus) return;
  if (on) {
    const first = focusables()[0];
    if (first) roveTo(first, first.closest(".shelf") ?? first);
    else tidyBtn?.focus({ preventScroll: true });
  } else {
    const target = tidyBtn && !tidyBtn.hidden ? tidyBtn : root.querySelector("#bookFinderOpen");
    target?.focus({ preventScroll: true });
  }
}

// 下ろす・戻す: 保存は照合した棚から（取り込みの途中でも、表示に出ている物を下ろせる）。焦点は同じ札のまま（名前が「…を棚に戻す」／「…を棚から下ろす」に替わる）
function drop(key) {
  saveShelf(dropKey(viewShelf(snapNow()), key));
  tidyDropped.add(key);
  updateBookshelf();
  noteHtml(`${esc(nameOf(key))}を下ろした。`);
  focusSlip(key);
}

function putBack(key) {
  saveShelf(addKey(viewShelf(snapNow()), key));
  tidyDropped.delete(key);
  updateBookshelf();
  noteHtml(`${esc(nameOf(key))}を棚に戻した。`);
  focusSlip(key);
}

function focusSlip(key) {
  const slip = root.querySelector(`#shelfRun button.slip[data-key="${CSS.escape(key)}"]`);
  if (slip) roveTo(slip);
  else root.querySelector("#shelfTidy")?.focus({ preventScroll: true });
}

// ---------- 本を足す（窓） ----------
let finderMode = "add"; // "add" | "welcome"
let lastAdded = "";
const addedKeys = new Set(); // この窓で足した物（閉じたあと棚の背の頭に金の押し点。次に棚を描き直すまで）
let picked = false;
let pendingFind = false; // 初回の「171冊から選ぶ」を目録の準備前に押した。届いた時点でまだ初回の画面なら窓を開く（スタートしたら忘れる）

function actHtml(key, name, on) {
  if (finderMode === "welcome") return `<button type="button" class="finder__act" data-key="${esc(key)}" aria-label="${esc(name)}を机に出す">机に出す</button>`;
  return on
    ? `<button type="button" class="finder__act finder__act--on" data-key="${esc(key)}" aria-disabled="true" aria-label="${esc(name)}は棚にある"><i class="finder__dot" aria-hidden="true"></i>棚にある</button>`
    : `<button type="button" class="finder__act" data-key="${esc(key)}" aria-label="${esc(name)}を棚に足す">${ICON.plus}棚に足す</button>`;
}

function rowMeta(key, search, ctx) {
  const id = key.slice(2);
  if (key.startsWith("c:")) {
    const box = BOXES.get(id);
    const head = id === ctx.eff ? "いまのコース・" : "";
    return head + (search ? `コース・全${box.vols}巻・答えは英語` : `全${box.vols}巻・${box.words}語`);
  }
  const book = BOOKS.get(id);
  const head = id === ctx.desk ? "机の上・" : "";
  if (id === "my") return `${head}自分で書いた本・${book.count > 0 ? `${book.count}語` : "語はまだ無い"}`;
  return `${head}${search ? `${shelfName(book.shelfId)}・` : ""}答えは${book.lang.split("・")[0]}・${book.count}${book.unit}`;
}

function rowHtml(key, search, ctx) {
  const name = nameOf(key);
  const attr = key.startsWith("c:") ? `data-course="${esc(key.slice(2))}"` : `data-book="${esc(key.slice(2))}"`;
  return `<li class="finder__row" ${attr}><span class="finder__txt"><span class="finder__t">${numHtml(name)}</span><span class="finder__m">${numHtml(rowMeta(key, search, ctx))}</span></span>${actHtml(key, name, ctx.shelf && savedHas(ctx.shelf, key))}</li>`;
}

// 窓の行の状態（棚にあるか・いまのコース・机の上）。窓を開いたときと棚が替わったとき（足した・同期: syncFinderStates）に作り、打つたびには作らない
let finderCtxNow = null;
function finderCtx(snap = null, shelf = null) {
  if (finderMode === "welcome" || !BOOKS.size) return { shelf: null, eff: "", desk: "" };
  const s = snap ?? snapNow();
  return { shelf: shelf ?? viewShelf(s), eff: effectiveCourse(s), desk: s.desk };
}

function renderBrowse(ctx) {
  const browse = root.querySelector("#bookFinderBrowse");
  const welcome = finderMode === "welcome";
  const visible = (key) => !(welcome && key === "b:my");
  browse.innerHTML = BROWSE.map((s) => {
    const rows = s.rows.filter(visible);
    const body = s.heads
      ? s.heads.map((h) => `<h4 class="cat__h">${esc(h.name)}</h4><ol class="finder__list">${h.rows.filter(visible).map((k) => rowHtml(k, false, ctx)).join("")}</ol>`).join("")
      : `<ol class="finder__list">${rows.map((k) => rowHtml(k, false, ctx)).join("")}</ol>`;
    const open = welcome && s.id === "course" ? " open" : "";
    // 見出しは 1 つずつ開く（name。開いた見出しは .finder__body の上端へ送る: bind の toggle）
    return `<details class="cat" name="finderCat" data-shelf="${esc(s.id)}"${open}><summary><span class="cat__n">${esc(s.name)}</span> <span class="cat__m"><span class="n">${rows.length}</span>${s.unit} ${esc(s.note)}</span>${ICON.arrow}</summary>${body}</details>`;
  }).join("");
}

// 照合の強さ: 0 書名と一致 → 1 書名の頭・函の別名と一致（「ngsl」で全集の函）→ 2 書名に含む → 3 棚名・別名に含む → 4 group・紹介文・対象。当たらなければ -1。
// 本の別名は 3 のまま（「歴史」で高校日本史が中学歴史より先に来ない）
function matchRank(row, n) {
  if (row.title.some((t) => t === n)) return 0;
  if (row.title.some((t) => t.startsWith(n)) || (row.key.startsWith("c:") && row.alias.some((t) => t === n))) return 1;
  if (row.title.some((t) => t.includes(n))) return 2;
  if (row.alias.some((t) => t.includes(n))) return 3;
  if (row.rest.some((t) => t.includes(n))) return 4;
  return -1;
}

function searchRows(q) {
  const n = norm(q);
  const welcome = finderMode === "welcome";
  return SEARCH.map((r, i) => ({ key: r.key, i, rank: welcome && r.key === "b:my" ? -1 : matchRank(r, n) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((r) => r.key);
}

function showSearch(q, ctx) {
  const list = root.querySelector("#bookFinderList");
  const browse = root.querySelector("#bookFinderBrowse");
  const hint = root.querySelector("#bookFinderHint");
  if (!norm(q)) {
    hint.textContent = "棚ごとの一覧";
    list.hidden = true;
    list.innerHTML = "";
    browse.hidden = false;
    return;
  }
  const rows = searchRows(q);
  const books = rows.filter((k) => k.startsWith("b:")).length;
  const courses = rows.length - books;
  const n = rows.length;
  hint.textContent = n === 0 ? "見つからない。棚の名前でも探せる（社会、試験）" : n > SEARCH_MAX ? `${n}件（上の${SEARCH_MAX}件。言葉を足して絞る）` : courses === 0 ? `${n}冊` : books === 0 ? `${n}コース` : `${n}件`;
  list.innerHTML = rows.slice(0, SEARCH_MAX).map((k) => rowHtml(k, true, ctx)).join("");
  list.hidden = false;
  browse.hidden = true;
}

function openFinder(welcome = isWelcome()) {
  if (!ensureSkeleton()) return;
  if (!BOOKS.size) {
    pendingFind = true;
    status("読み込み中");
    return;
  }
  const dlg = root.querySelector("#bookFinder");
  if (!dlg || typeof dlg.showModal !== "function" || dlg.open) return;
  finderMode = welcome ? "welcome" : "add";
  lastAdded = "";
  addedKeys.clear();
  picked = false;
  root.querySelector("#bookFinderTitle").textContent = welcome ? "本をさがす" : "本を足す";
  const q = root.querySelector("#bookFinderQ");
  q.value = "";
  finderStatus("");
  finderCtxNow = finderCtx();
  renderBrowse(finderCtxNow);
  showSearch("", finderCtxNow);
  root.querySelector(".finder__body").scrollTop = 0;
  dlg.showModal();
  q.focus();
}

// 窓が開いている間に棚が変わった（同期など）: 行のボタンの状態と、次に打ったときの行の状態（ctx）だけ合わせる（窓は描き直さない）
function syncFinderStates(shelf, snap) {
  const dlg = root?.querySelector("#bookFinder");
  if (!dlg?.open || finderMode !== "add") return;
  finderCtxNow = finderCtx(snap, shelf);
  for (const btn of dlg.querySelectorAll(".finder__act")) {
    const on = savedHas(shelf, btn.dataset.key);
    if ((btn.getAttribute("aria-disabled") === "true") !== on) btn.outerHTML = actHtml(btn.dataset.key, nameOf(btn.dataset.key), on);
  }
}

function act(btn) {
  const key = btn.dataset.key;
  const name = nameOf(key);
  if (finderMode === "welcome") {
    picked = true;
    root.querySelector("#bookFinder")?.close();
    pickInWelcome(key);
    return;
  }
  if (btn.getAttribute("aria-disabled") === "true") {
    finderStatus(`${name}は棚にある`);
    return;
  }
  const next = addKey(viewShelf(snapNow()), key);
  saveShelf(next);
  if (finderCtxNow) finderCtxNow = { ...finderCtxNow, shelf: next }; // 足した後に打った検索の行も「棚にある」に
  lastAdded = key;
  addedKeys.add(key);
  // 押したボタンは同じ要素のまま「棚にある」に（焦点を残す）。ほかの行（一覧と検索の両方にある）も合わせる。棚を描き直すのはその後
  btn.classList.add("finder__act--on");
  btn.setAttribute("aria-disabled", "true");
  btn.setAttribute("aria-label", `${name}は棚にある`);
  btn.innerHTML = `<i class="finder__dot" aria-hidden="true"></i>棚にある`;
  for (const other of root.querySelectorAll(`#bookFinder .finder__act[data-key="${CSS.escape(key)}"]`)) {
    if (other !== btn) other.outerHTML = actHtml(key, name, true);
  }
  updateBookshelf();
  finderStatus(`棚に足した: ${name}`);
}

function onFinderClosed() {
  finderCtxNow = null;
  if (finderMode === "welcome") {
    if (!isWelcome()) return root.querySelector("#bookFinderOpen")?.focus({ preventScroll: true }); // welcome が畳まれて閉じた
    const target = picked ? document.querySelector("#welcome .welcome__cta [data-welcome-start]") : document.getElementById("welcomeFind");
    target?.focus({ preventScroll: true });
    return;
  }
  // 足した物の背の頭に金の押し点（マウスで閉じると焦点の輪が出ないので、どこに並んだかを目に出す。次に棚を描き直すまで）
  for (const key of addedKeys) root.querySelector(`#shelfRun li[data-key="${CSS.escape(key)}"]`)?.classList.add("is-new");
  const li = lastAdded ? root.querySelector(`#shelfRun li[data-key="${CSS.escape(lastAdded)}"]`) : null;
  const btn = li?.querySelector("button.spine, button.box");
  if (btn) {
    activeKey = lastAdded;
    setupRoving();
    btn.focus({ preventScroll: true });
    btn.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    return;
  }
  root.querySelector("#bookFinderOpen")?.focus({ preventScroll: true });
}

// ---------- 配線 ----------
function bind() {
  if (root.dataset.bound) return;
  root.dataset.bound = "1";

  root.addEventListener("click", (event) => {
    const t = event.target;
    if (t.id === "bookFinder") return t.close(); // 外側（backdrop）
    const slip = t.closest("button.slip");
    if (slip) {
      // 指・マウスで同じ札を続けて押した（0.45 秒以内）2 回目は読み捨てる（連打で下ろしてすぐ戻さない）。キーボード（detail 0）はそのまま
      const now = performance.now();
      if (event.detail > 0 && lastSlip.key === slip.dataset.key && now - lastSlip.at < 450) return;
      lastSlip = { key: slip.dataset.key, at: now };
      return slip.dataset.act === "back" ? putBack(slip.dataset.key) : drop(slip.dataset.key);
    }
    const spine = t.closest("button.spine");
    if (spine) return openBook(spine.dataset.book, spine);
    const box = t.closest("button.box");
    if (box) return openCourse(box.dataset.course, box);
    if (t.closest("#bookFinderOpen, .shelf-hint__add")) return openFinder(false);
    if (t.closest("#shelfTidy")) return setTidy(mode !== "tidy");
    if (t.closest(".finder__close")) return root.querySelector("#bookFinder")?.close();
    const actBtn = t.closest(".finder__act");
    if (actBtn) return act(actBtn);
    const row = t.closest(".finder__row");
    if (row) row.querySelector(".finder__act")?.click(); // 行のどこを押してもボタンと同じ（Tab で止まるのはボタンだけ）
  });

  root.addEventListener("keydown", (event) => {
    const dlg = event.target.closest("#bookFinder");
    if (dlg) {
      if (event.key !== "Escape") return;
      // Esc は自前で閉じる（ページの他の keydown が先に止めても閉じるように）
      event.preventDefault();
      event.stopPropagation();
      dlg.close();
      return;
    }
    const btn = event.target.closest("#shelfRun button");
    if (!btn) return;
    const items = focusables();
    const i = items.indexOf(btn);
    if (i < 0) return;
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
    const btn = event.target.closest("#shelfRun button");
    if (!btn || !focusables().includes(btn)) return;
    activeKey = btn.closest("li")?.dataset.key ?? "";
    focusables().forEach((b) => (b.tabIndex = b === btn ? 0 : -1));
  });

  // 窓: 打つたびに絞る。入力欄の Enter（submit）は最初の行のボタンへ焦点を移すだけ（足さない・閉じない）。
  // IME の確定の Enter では submit は起きない。フォームに submit ボタンは置かない（置くと Enter がそのボタンの click になる）
  root.addEventListener("input", (event) => {
    if (event.target.id === "bookFinderQ") showSearch(event.target.value, finderCtxNow ?? (finderCtxNow = finderCtx()));
  });
  root.addEventListener("submit", (event) => {
    const dlg = event.target.closest("#bookFinder");
    if (!dlg) return;
    event.preventDefault();
    if (!norm(root.querySelector("#bookFinderQ")?.value)) return;
    root.querySelector("#bookFinderList .finder__act")?.focus();
  });
  root.addEventListener(
    "close",
    (event) => {
      if (event.target?.id === "bookFinder") onFinderClosed();
    },
    true
  );
  // 窓の見出しを開いたら、その見出しを .finder__body の上端へ送る（下の見出しを開いても中身が画面の外に残らない）。toggle は泡立たないので捕捉で
  root.addEventListener(
    "toggle",
    (event) => {
      const d = event.target;
      if (!d?.matches?.("details.cat") || !d.open) return;
      const body = d.closest(".finder__body");
      if (!body) return;
      const top = d.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
      body.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
    },
    true
  );

  // 幅・机の列の高さが変わった・畳まれていた本棚が出た（プレイ中 → 机に戻る）ら段を割り直す
  let timer = null;
  const remeasure = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (root.getClientRects().length === 0) return;
      draw(lastItems, lastWelcome);
    }, 80);
  };
  window.addEventListener("resize", remeasure);
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(remeasure);
    ro.observe(root);
    const nook = document.getElementById("nook");
    if (nook) ro.observe(nook);
  }

  // プレイが始まったら整理を終える。机の本で 1 セット始めたら（study）その本を棚に
  window.addEventListener("spelldash:game-start", (event) => {
    if (mode === "tidy") setTidy(false, { focus: false });
    if (event.detail?.mode === "study") noteStudy();
  });
}

export function initBookshelf({ onPick, onCourse } = {}) {
  handlers = { onPick, onCourse };
  if (!ensureSkeleton()) return;
  buildData();
  bind();
  lastHtml = "";
  updateBookshelf();
  // 準備前に押された「171冊から選ぶ」: まだ初回の画面なら開く。スタート（またはログインの行）で初回の画面を閉じていたら開かない（ゲームの入力欄から焦点を奪わない）
  if (pendingFind) {
    pendingFind = false;
    if (isWelcome()) openFinder(true);
  }
}

// ---------- 読み込まれた時点（語の読み込みの前）に結ぶもの ----------
// 初回の「171冊から選ぶ」: 最初から見えている（読み込み後に押し下げない）。準備前に押されたら、読み込み後に窓を開く
document.getElementById("welcomeFind")?.addEventListener("click", () => openFinder(true));
// welcome の開け閉め（スタート・ログインの行・auth-ready は renderHome を呼ばないことがある）と、welcome の机の本（下見の棚）
{
  let wasWelcome = isWelcome();
  new MutationObserver(() => {
    const now = isWelcome();
    if (now === wasWelcome) return;
    wasWelcome = now;
    if (now) return drawWelcome();
    pendingFind = false; // 初回の画面を閉じた（スタート・ログインの行・同期）: 準備前に押された「171冊から選ぶ」は忘れる
    // welcome が畳まれた（ログインの行・auth-ready・同期）: 初回の形の窓（本をさがす・机に出す）が開いていたら閉じる
    const dlg = root?.querySelector("#bookFinder");
    if (dlg?.open && finderMode === "welcome") dlg.close();
    // 閉じた直後の描き直しは見せるだけ（保存しない）。スタートで閉じたなら保存は startShelf の 1 回、ほかで閉じたなら次の描き直しが移行して保存する
    if (root?.querySelector("#shelfRun")) refresh(false);
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const startBtn = document.querySelector("#welcome [data-welcome-start]");
  if (startBtn) {
    new MutationObserver(() => {
      if (welcomeCourse && welcomeCourse.book !== startBtn.dataset.book) welcomeCourse = null;
      if (isWelcome()) drawWelcome();
    }).observe(startBtn, { attributes: true, attributeFilter: ["data-book"] });
  }
}
