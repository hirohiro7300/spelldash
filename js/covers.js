// ===== 教材の小さな表紙（データだけ） =====
//
// 「本を足す」「本をさがす」の窓（js/bookshelf.js）の行の左に出す、教科の表紙の絵。絵は創業者が用意した表紙の、絵のある下の部分を
// 3:4 の縦長に切り出した物（assets/images/covers/<name>.webp・48×64・文字なし。作るのは scripts/build-covers.mjs。元の PNG はリポジトリに入れない）。
// 書名は今どおり HTML。絵は飾り（alt 空・aria-hidden）。
//
// 本 → 表紙は、この 1 か所の表で決める（教材の分野: data/manifest.json の id と group、js/shelves.js の棚。名前が似ているだけでは当てない）。
//   1. 本の id の表（BOOK_COVER）  2. コース（函）の表（COURSE_COVER）  3. 棚の既定（SHELF_COVER）  4. どれにも無ければ null（窓では今の革の無地）
// 表に無い本: 文法・英作文の全部、頻度順の全集と巻（NGSL・TSL・BSL・NAWL）、business・it・ads・listing、ビジネス英語のコース、
// security（038 は錠と鍵穴の絵なので使わない）、仕事の言葉の残り 43 冊、マイ単語帳。
// 仕事の言葉の総称の表紙（015）が届いたら: build-covers.mjs の COVERS に足して作り、SHELF_COVER に job: "<名前>" を足すだけ
// （本の id の表にある 5 冊はそのまま。残りの仕事の言葉の本が 015 になる）。

// 表紙の名前 → その表紙の本（manifest の id）
const BY_COVER = {
  english: ["junior", "highschool", "elem-english", "jhs-english1", "jhs-english2", "jhs-english3"], // 011 英単語
  conversation: ["daily", "travel"], // 057 英会話
  exam: ["toeic", "eiken5", "eiken4", "eiken3", "eikenp2", "eiken2", "eikenp1", "eiken1", "toeic500", "toeic600", "toeic730", "toeic860", "toeic990"], // 058 英語資格
  history: ["elem-hist", "jhist1", "jhist2"], // 012 社会と歴史
  japhist: ["hs-japhist1", "hs-japhist2"], // 052 日本史
  worldhist: ["hs-worldhist1", "hs-worldhist2"], // 053 世界史
  geography: ["pref", "jgeo1", "jgeo2", "hs-geo"], // 031 地理
  civics: ["jcivics", "hs-civics", "hs-ethics"], // 032 公民
  science: ["elem-sci", "jsci1", "jsci2"], // 013 理科
  physics: ["hs-physics"], // 034
  chemistry: ["hs-chem"], // 035
  biology: ["hs-bio"], // 033
  earth: ["hs-earth"], // 054 地学
  math: ["elem-math", "jmath"], // 036
  kokugo: ["elem-kanji", "jkokugo1", "jkokugo2", "hs-gendaibun"], // 014 国語
  kobun: ["hs-kobun"], // 055 古文
  kanbun: ["hs-kanbun"], // 056 漢文
  it: ["itsupport"], // 037 IT 基礎
  programming: ["programming"], // 059
  realestate: ["realestate"], // 039 宅建と不動産
  bookkeeping: ["accounting"], // 040 簿記
  bizlaw: ["legal"] // 060 ビジネス法務
};
export const BOOK_COVER = Object.fromEntries(Object.entries(BY_COVER).flatMap(([name, ids]) => ids.map((id) => [id, name])));
// コース（函）: 英語のコースだけ。ビジネス英語・頻度順の全集は専用の表紙が無い
export const COURSE_COVER = { "jhs-redo": "english", hs: "english", conversation: "conversation", eiken: "exam", toeic: "exam" };
// 棚の既定（本の id の表に無い本）。いまは無し（仕事の言葉の 015 は未着）
export const SHELF_COVER = {};

// 表の自分の項目だけを引く（id が constructor・__proto__・toString などでも Object.prototype の物を返さない）。無ければ null
const pick = (table, id) => (id && Object.hasOwn(table, id) ? table[id] : null);

// 窓の行の key（"b:<id>"・"c:<id>"）と棚の id → 表紙の名前。無ければ null（棚の id が空文字でも null）
export function coverOf(key, shelfId = null) {
  if (key.startsWith("c:")) return pick(COURSE_COVER, key.slice(2));
  const id = key.startsWith("b:") ? key.slice(2) : key;
  return pick(BOOK_COVER, id) ?? pick(SHELF_COVER, shelfId);
}

// <img>（飾り。alt 空・閉じた見出しの中と 360px 未満〔display:none〕では読まない loading=lazy・低い優先度・非同期の解読）。
// width・height は 3:4 の比（表示の大きさは CSS。読む前から箱の大きさが決まる: CLS 0）
export function coverImgHtml(name) {
  return `<img src="./assets/images/covers/${name}.webp" width="24" height="32" alt="" loading="lazy" decoding="async" fetchpriority="low" />`;
}
