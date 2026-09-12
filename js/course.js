import { getEnabledPackIds, setPackEnabled } from "./packs.js";
import { getWordStats } from "./storage.js";

// ===== コース（道の並び） =====
//
// ホームの「道」は、いま選んでいるカテゴリ（＝セクション）のジャンル（＝ユニット）を順に進む。
// コースは「次のセクションはどのパックか」を決める並び。初期値は創業者判断で
// 「中学英語やり直し」（中学英語1〜3年 → 英文法1〜3年 → 並べ替え → 中学英作文）。
// 他の分野パックを選んだ人は、そのパック1本が道になる（コースは無し）。

export const COURSES = {
  "jhs-redo": {
    id: "jhs-redo",
    label: "中学英語やり直し",
    packs: ["jhs-english1", "jhs-english2", "jhs-english3", "grammar-jhs1", "grammar-jhs2", "grammar-jhs3", "writing-jhs-order", "writing-jhs"]
  }
};

const COURSE_KEY = "spelldash_course";
const CATEGORY_KEY = "spelldash_category";
export const DEFAULT_COURSE = "jhs-redo";

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

// コースを始める: 最初のパックを追加してカテゴリにする（語の読み直しは呼び出し側で）
export function startCourse(courseId) {
  const course = COURSES[courseId];
  if (!course) return null;
  localStorage.setItem(COURSE_KEY, courseId);
  const first = course.packs[0];
  if (!getEnabledPackIds().includes(first)) setPackEnabled(first, true);
  localStorage.setItem(CATEGORY_KEY, first);
  return first;
}

// 次のセクションへ進む: 次のパックを追加してカテゴリにする。無ければ null
export function advanceSection(categoryId) {
  const section = sectionOf(categoryId);
  if (!section?.next) return null;
  if (!getEnabledPackIds().includes(section.next)) setPackEnabled(section.next, true);
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
