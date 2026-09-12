import { getCategories, getWordsByCategory } from "./wordStore.js";
import { groupByGenre } from "./genres.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";
import { getCourse, sectionOf } from "./course.js";
import { getSetSize, isDailySetDone } from "./dailySet.js";
import { getDueReviewCount } from "./studyQueue.js";

// ===== ホームの「道」 =====
//
// いま選んでいるカテゴリ（セクション）のジャンル（ユニット）を縦の道にして、
// 「次に押すもの」をスタート1個に絞る。ユニットは全部の語を覚えた（知ってた含む）ら済み。
// 「すべて」を選んでいる人は、カテゴリを1つずつノードにした道になる。

const CATEGORY_KEY = "spelldash_category";

function isRemembered(state) {
  return state === "learning" || state === "mastered" || state === "known";
}

function unitProgress(words, stats) {
  const seen = new Set();
  let total = 0;
  let learned = 0;
  let weak = 0;
  for (const w of words) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    total++;
    const state = classifyWord(stats[w.id]);
    if (isRemembered(state)) learned++;
    if (state === "weak") weak++;
  }
  return { total, learned, weak, done: total > 0 && learned === total };
}

// 道のデータ: units（順）と現在地
export function buildPath(categoryId = localStorage.getItem(CATEGORY_KEY) || "all") {
  const stats = getWordStats();
  const categories = getCategories();
  const category = categories.find((c) => c.id === categoryId);
  const label = categoryId === "all" ? "すべて" : category?.label ?? categoryId;

  const units =
    categoryId === "all"
      ? categories
          .filter((c) => c.id !== "my")
          .map((c) => ({ tag: "", label: c.label, ...unitProgress(getWordsByCategory(c.id), stats) }))
      : groupByGenre(categoryId).map((g) => ({ tag: g.tag, label: g.label, ...unitProgress(g.words, stats) }));

  const currentIndex = units.findIndex((u) => !u.done);
  const course = getCourse();
  const section = sectionOf(categoryId, course);
  return { categoryId, label, units, currentIndex, allDone: units.length > 0 && currentIndex < 0, course, section };
}

export function currentUnitOf(path) {
  return path.currentIndex >= 0 ? path.units[path.currentIndex] : null;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 描画。onStart(unit|null) はスタート／復習、onAdvance() は次のセクションへ
export function renderPath({ onStart, onAdvance } = {}) {
  const el = document.getElementById("pathCard");
  const headEl = document.getElementById("pathHead");
  const listEl = document.getElementById("pathList");
  if (!el || !headEl || !listEl) return null;

  const path = buildPath();
  const { units, currentIndex, allDone, course, section, label } = path;
  const current = currentUnitOf(path);
  const firstVisit = Object.keys(getWordStats()).length === 0;
  const setSize = getSetSize();
  const due = getDueReviewCount(path.categoryId);
  const doneCount = units.filter((u) => u.done).length;

  const kicker = section
    ? `${esc(course.label)} ・ セクション ${section.index + 1}／${section.total}`
    : path.categoryId === "all"
      ? "コース: すべての単語"
      : "分野パック";
  const unitLine = allDone
    ? `🏆 ${units.length}ユニット制覇`
    : current
      ? `ユニット ${currentIndex + 1}／${units.length} ・ ${esc(current.label)}`
      : "";
  const startSub = firstVisit
    ? "まず腕試し10語（約2分）。知ってる語はそのまま打って、知らない語は Enter でOK"
    : isDailySetDone()
      ? `✓ 今日のぶんは完了。もう1セット（${setSize}語）`
      : `今日のセット ${setSize}語・約5分${due > 0 ? ` ・ 復習 ${due}語 待ち` : ""}`;

  // 現在地より先の未着手ユニットは3つまで見せ、残りは「あとNユニット」にまとめる（道が長くなりすぎない）
  const lockedLimit = currentIndex >= 0 ? currentIndex + 3 : units.length;
  const hiddenLocked = Math.max(0, units.length - 1 - lockedLimit);
  const nodes = units
    .map((u, i) => {
      const state = u.done ? "done" : i === currentIndex ? "current" : "locked";
      const lane = ["c", "r", "c", "l"][i % 4];
      if (state === "locked" && i > lockedLimit) return "";
      const count = `${u.learned}／${u.total}`;
      if (state === "current") {
        return `
          <li class="path__node path__node--current path__node--${lane}">
            <button type="button" class="path__start" id="pathStart" data-unit="${esc(u.tag)}" aria-label="スタート: ${esc(u.label)}">
              <span class="path__tip">${count} 語 覚えた</span>スタート
            </button>
            <div class="path__label"><b>${esc(u.label)}</b><span>${startSub}</span></div>
          </li>`;
      }
      if (state === "done") {
        return `
          <li class="path__node path__node--done path__node--${lane}">
            <button type="button" class="path__dot" data-unit="${esc(u.tag)}" data-review="1" aria-label="復習: ${esc(u.label)}">✓</button>
            <div class="path__label"><b>${esc(u.label)}</b><span>${count}${u.weak > 0 ? ` ・ 苦手 ${u.weak}` : ""} ・ タップで復習</span></div>
          </li>`;
      }
      return `
        <li class="path__node path__node--locked path__node--${lane}">
          <span class="path__dot" aria-hidden="true">★</span>
          <div class="path__label"><b>${esc(u.label)}</b><span>${u.learned > 0 ? count : `${u.total}語`}</span></div>
        </li>`;
    })
    .join("");

  const goal = allDone
    ? section?.next
      ? `<li class="path__node path__node--goal path__node--c"><button type="button" class="path__start path__start--next" id="pathNext">次のセクションへ →</button><div class="path__label"><b>${esc(label)} 制覇！</b><span>次は「${esc(getCategories().find((c) => c.id === section.next)?.label ?? "次のパック")}」</span></div></li>`
      : `<li class="path__node path__node--goal path__node--c"><button type="button" class="path__start" id="pathStart" data-unit="" aria-label="復習を続ける"><span class="path__tip">全部覚えた</span>復習</button><div class="path__label"><b>${esc(label)} 制覇！</b><span>復習を続けるか、<a href="./list.html#packs">単語帳</a>から次の分野を追加</span></div></li>`
    : `<li class="path__node path__node--goal path__node--c"><span class="path__dot path__dot--goal" aria-hidden="true">🏆</span><div class="path__label"><b>${esc(label)} 制覇</b><span>${section?.next ? "次のセクションが開く" : "全ユニットを覚えたら"}</span></div></li>`;

  const more = hiddenLocked > 0
    ? `<li class="path__node path__node--locked path__node--more path__node--c"><span class="path__dot" aria-hidden="true">…</span><div class="path__label"><b>あと${hiddenLocked}ユニット</b><span>${units.slice(lockedLimit + 1).map((u) => esc(u.label)).join("・")}</span></div></li>`
    : "";

  headEl.innerHTML = `
    <div class="path__head">
      <div class="path__head-text">
        <span class="path__kicker">${kicker}</span>
        <span class="path__title">${esc(label)}</span>
        <span class="path__unit">${unitLine}${units.length > 0 && !allDone ? ` <small>（${doneCount}／${units.length} 済み）</small>` : ""}</span>
      </div>
      <a class="path__guide" href="./list.html?category=${encodeURIComponent(path.categoryId === "all" ? "" : path.categoryId)}">📖 一覧</a>
    </div>
  `;
  listEl.innerHTML = `<ol class="path__list">${nodes}${more}${units.length > 0 ? goal : ""}</ol>`;

  el.querySelector("#pathStart")?.addEventListener("click", () => onStart?.(current && !allDone ? current : null));
  el.querySelectorAll(".path__dot[data-review]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const unit = units.find((u) => u.tag === btn.dataset.unit) ?? null;
      onStart?.(unit, { review: true });
    });
  });
  el.querySelector("#pathNext")?.addEventListener("click", () => onAdvance?.());
  return path;
}
