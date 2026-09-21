import { getEnabledPackIds, setPackEnabled } from "./packs.js";
import { getWordStats } from "./storage.js";

// ===== コース（道の並び） =====
//
// ホームの「道」は、いま選んでいるカテゴリ（＝セクション）のジャンル（＝ユニット）を順に進む。
// コースは「次のセクションはどのパックか」を決める並び。初期値は創業者判断で
// 「中学英語やり直し」（中学英語1〜3年 → 英文法1〜3年 → 並べ替え → 中学英作文）。
// 道の見出しの「コースを変える」で他のコースに乗り換えられる（進捗は語ごとなので失われない）。
// 他の分野パックを選んだ人は、そのパック1本が道になる（コースは無し）。

export const COURSES = {
  "jhs-redo": {
    id: "jhs-redo",
    label: "中学英語やり直し",
    blurb: "中学英語1〜3年の単語 → 英文法1〜3年 → 並べ替え → 中学英作文。基礎から順に",
    audience: "英語をもう一度、最初から",
    packs: ["jhs-english1", "jhs-english2", "jhs-english3", "grammar-jhs1", "grammar-jhs2", "grammar-jhs3", "writing-jhs-order", "writing-jhs"]
  },
  biz: {
    id: "biz",
    label: "社会人ビジネス英語",
    blurb: "ビジネス → TOEIC頻出 → TOEIC 500・600 → TOEIC文法 → 730・860 → 英語面接の定番フレーズ",
    audience: "仕事で使う語彙を積み上げたい社会人",
    packs: ["business", "toeic", "toeic500", "toeic600", "grammar-toeic", "toeic730", "toeic860", "writing-interview"]
  },
  conversation: {
    id: "conversation",
    label: "日常・旅行の英会話",
    blurb: "日常英会話 → 旅行 → 中学英語の基本語 → 中学英作文。話すための語から",
    audience: "旅行や日常で使いたい人",
    packs: ["daily", "travel", "junior", "writing-jhs"]
  },
  hs: {
    id: "hs",
    label: "高校英語",
    blurb: "高校英語の単語 → 高校英文法 基礎・発展 → 高校英作文（構文） → 英検準2級・2級",
    audience: "高校生、大学受験の土台を固めたい人",
    packs: ["highschool", "grammar-hs1", "grammar-hs2", "writing-hs", "eikenp2", "eiken2"]
  },
  eiken: {
    id: "eiken",
    label: "英検 5級→1級",
    blurb: "英検5級から1級まで、級ごとの新出語を順に。最後に英検ライティングの定型表現",
    audience: "英検を受ける人",
    packs: ["eiken5", "eiken4", "eiken3", "eikenp2", "eiken2", "eikenp1", "eiken1", "writing-eiken"]
  },
  ngsl: {
    id: "ngsl",
    label: "基本英単語 2,800語（NGSL）",
    blurb: "英文の約9割を作る基本語を頻度順に24セクション。数・曜日・月から始めて、よく出会う語から順に",
    audience: "英語をゼロから体系的にやり直したい人（オープン教材 NGSL）",
    packs: Array.from({ length: 24 }, (_, i) => `ngsl${String(i + 1).padStart(2, "0")}`)
  },
  toeic: {
    id: "toeic",
    label: "TOEIC 500→990",
    blurb: "TOEIC 500・600・730・860・990点の語彙と、短文穴埋めの文法",
    audience: "TOEICのスコアを上げたい人",
    packs: ["toeic500", "toeic600", "grammar-toeic", "toeic730", "toeic860", "toeic990"]
  }
};

// 分野パックではない基本カテゴリ（追加の手続きなしで常に読み込まれている）
const BASE_CATEGORIES = new Set(["junior", "highschool", "business", "toeic", "it", "daily", "travel", "ads", "listing"]);

const COURSE_KEY = "spelldash_course";
const CATEGORY_KEY = "spelldash_category";
export const DEFAULT_COURSE = "jhs-redo";

export function listCourses() {
  return Object.values(COURSES);
}

export function getCourseId() {
  return localStorage.getItem(COURSE_KEY) || "";
}

export function getCourse() {
  return COURSES[getCourseId()] ?? null;
}

// カテゴリがコースの何番目か（コースに無ければ null）
export function sectionOf(categoryId, course = getCourse()) {
  if (!course) return null;
  const index = course.packs.indexOf(categoryId);
  return index < 0 ? null : { index, total: course.packs.length, next: course.packs[index + 1] ?? null };
}

function ensureLoaded(categoryId) {
  if (BASE_CATEGORIES.has(categoryId)) return;
  if (!getEnabledPackIds().includes(categoryId)) setPackEnabled(categoryId, true);
}

// コースを始める／乗り換える: 開始セクション（省略時は最初のパック）を追加してカテゴリにする（語の読み直しは呼び出し側で）。
// 乗り換え時の開始位置（まだ制覇していない最初のセクション）は呼び出し側が語データを見て決める
export function startCourse(courseId, startId = null) {
  const course = COURSES[courseId];
  if (!course) return null;
  localStorage.setItem(COURSE_KEY, courseId);
  const start = startId && course.packs.includes(startId) ? startId : course.packs[0];
  ensureLoaded(start);
  localStorage.setItem(CATEGORY_KEY, start);
  return start;
}

// 次のセクションへ進む: 次のパックを追加してカテゴリにする。無ければ null
export function advanceSection(categoryId) {
  const section = sectionOf(categoryId);
  if (!section?.next) return null;
  ensureLoaded(section.next);
  localStorage.setItem(CATEGORY_KEY, section.next);
  return section.next;
}

// 初めての人（学習データもカテゴリの選択も無い）には既定のコースを敷く。既存ユーザーには触らない
export function ensureDefaultCourse() {
  if (getCourseId()) return false;
  if (localStorage.getItem(CATEGORY_KEY)) return false;
  if (Object.keys(getWordStats()).length > 0) return false;
  if (getEnabledPackIds().length > 0) return false;
  startCourse(DEFAULT_COURSE);
  return true;
}
