import { getCategories, getWordsByCategory, getPackCatalog, isConceptWord } from "./wordStore.js";
import { groupByGenre } from "./genres.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";
import { getCourse, sectionOf, listCourses, getCourseId } from "./course.js";
import { getSetSize, isDailySetDone } from "./dailySet.js";
import { getDueReviewCount } from "./studyQueue.js";
import { resumableFor } from "./sessionResume.js";

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

  // 「すべて」の道: 「すべて」が実際に出題するカテゴリ（基本カテゴリの英単語。概念カードと分野パックは含まない）だけをユニットにする。
  // スタートはそのカテゴリに絞る（tag は "category:<id>"）
  const units =
    categoryId === "all"
      ? categories
          .filter((c) => c.id !== "my" && !c.pack)
          .map((c) => ({ id: c.id, words: getWordsByCategory(c.id).filter((w) => !isConceptWord(w) && !w.pack) }))
          .filter((c) => c.words.length > 0)
          .map((c) => ({ tag: `category:${c.id}`, label: categories.find((x) => x.id === c.id)?.label ?? c.id, ...unitProgress(c.words, stats) }))
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

// 済みユニットの折りたたみを開いたか（この表示の間だけ）
let doneExpanded = false;

// コース選択パネル（見出しの「コースを変える」で開く）
function courseChooserHtml(currentId) {
  return `
    <div class="path__courses" id="pathCourses" hidden>
      <div class="path__courses-head"><b>コースを選ぶ</b><span>進み具合は語ごとに残るので、いつでも戻れます</span></div>
      <ul class="path__courses-list">
        ${listCourses()
          .map(
            (c) => `
          <li class="path__course${c.id === currentId ? " path__course--current" : ""}">
            <div class="path__course-text">
              <b>${esc(c.label)}</b>
              <span>${esc(c.blurb)}</span>
              <small>${esc(c.audience)} ・ ${c.packs.length}セクション</small>
            </div>
            ${c.id === currentId ? `<span class="path__course-now">いまのコース</span>` : `<button type="button" class="path__course-pick" data-course="${esc(c.id)}">このコースにする</button>`}
          </li>`
          )
          .join("")}
      </ul>
    </div>`;
}

// 描画。onStart(unit|null) はスタート／復習、onAdvance() は次のセクションへ、onCourse(courseId) はコースの乗り換え
export function renderPath({ onStart, onAdvance, onCourse } = {}) {
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

  const category = getCategories().find((c) => c.id === path.categoryId);
  const kicker = section
    ? `${esc(course.label)} ・ セクション ${section.index + 1}／${section.total}`
    : path.categoryId === "all"
      ? "コース: すべての単語"
      : path.categoryId === "my"
        ? "自分で登録した語"
        : category?.pack
          ? "分野パック"
          : "カテゴリ";
  const unitLine = allDone
    ? `🏆 ${units.length}ユニット制覇`
    : current
      ? `ユニット ${currentIndex + 1}／${units.length} ・ ${esc(current.label)}`
      : "";
  const resume = firstVisit ? null : resumableFor(path.categoryId);
  const startSub = resume
    ? `▶ 前回の続きから（${resume.recalled.length}／${resume.setSize}語 済み・残り ${resume.queue.length}語）`
    : firstVisit
    ? "まず腕試し10語（約2分）。知ってる語はそのまま打って、知らない語は Enter でOK"
    : isDailySetDone()
      ? `✓ 今日のぶんは完了。もう1セット（${setSize}語）`
      : `今日のセット ${setSize}語・約5分${due > 0 ? ` ・ 復習 ${due}語 待ち` : ""}`;

  // 現在地より先の未着手ユニットは3つまで見せ、残りは「あとNユニット」にまとめる（道が長くなりすぎない）
  const lockedLimit = currentIndex >= 0 ? currentIndex + 3 : units.length;
  const hiddenUnits = units.filter((u, i) => !u.done && i !== currentIndex && i > lockedLimit);
  const hiddenLocked = hiddenUnits.length;
  // 現在地より前の済みユニットは直前の2つだけ見せ、それより前は「済み Nユニット」1つに畳む（開くと全部出る）。
  // 毎日開くたびに済みの列をスクロールしなくていいように、現在地が最初の画面に来る
  const doneBefore = currentIndex >= 0 ? units.slice(0, currentIndex).filter((u) => u.done) : [];
  const foldDone = !doneExpanded && doneBefore.length > 3 ? doneBefore.slice(0, doneBefore.length - 2) : [];
  const foldedSet = new Set(foldDone);
  const listHref = (tag) => `./list.html?category=${encodeURIComponent(path.categoryId === "all" ? "" : path.categoryId)}${tag && !tag.startsWith("category:") ? `#genre-${encodeURIComponent(tag)}` : ""}`;
  const nodes = units
    .map((u, i) => {
      const state = u.done ? "done" : i === currentIndex ? "current" : "locked";
      const lane = ["c", "r", "c", "l"][i % 4];
      if (state === "locked" && i > lockedLimit) return "";
      if (foldedSet.has(u)) {
        if (u !== foldDone[0]) return "";
        return `
          <li class="path__node path__node--done path__node--fold path__node--c">
            <button type="button" class="path__dot" id="pathDoneFold" aria-expanded="false" aria-label="済みのユニットを開く">✓</button>
            <div class="path__label"><b>済み ${foldDone.length}ユニット</b><span>${foldDone.map((d) => esc(d.label)).join("・")} ・ <button type="button" class="path__linkbtn" data-fold-open>開く</button></span></div>
          </li>`;
      }
      const count = `${u.learned}／${u.total}`;
      if (state === "current") {
        return `
          <li class="path__node path__node--current path__node--${lane}">
            <button type="button" class="path__start${resume ? " path__start--resume" : ""}" id="pathStart" data-unit="${esc(u.tag)}" aria-label="${resume ? "続きから" : "スタート"}: ${esc(u.label)}">
              <span class="path__tip">${resume ? "途中のセット" : `${count} 語 覚えた`}</span>${resume ? "続きから" : "スタート"}
            </button>
            <div class="path__label"><b>${esc(u.label)} <a class="path__unit-link" href="${listHref(u.tag)}" aria-label="${esc(u.label)} の一覧">📖</a></b><span>${startSub}</span></div>
          </li>`;
      }
      if (state === "done") {
        return `
          <li class="path__node path__node--done path__node--${lane}">
            <button type="button" class="path__dot" data-unit="${esc(u.tag)}" data-review="1" aria-label="復習: ${esc(u.label)}">✓</button>
            <div class="path__label"><b>${esc(u.label)} <a class="path__unit-link" href="${listHref(u.tag)}" aria-label="${esc(u.label)} の一覧">📖</a></b><span>${count}${u.weak > 0 ? ` ・ 苦手 ${u.weak}` : ""} ・ タップで復習</span></div>
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
      ? `<li class="path__node path__node--goal path__node--c"><button type="button" class="path__start path__start--next" id="pathNext">次のセクションへ →</button><div class="path__label"><b>${esc(label)} 制覇！</b><span>次は「${esc([...getCategories(), ...getPackCatalog()].find((c) => c.id === section.next)?.label ?? "次のパック")}」</span></div></li>`
      : `<li class="path__node path__node--goal path__node--c"><button type="button" class="path__start" id="pathStart" data-unit="" aria-label="復習を続ける"><span class="path__tip">全部覚えた</span>復習</button><div class="path__label"><b>${esc(label)} 制覇！</b><span>復習を続けるか、<a href="./list.html#packs">単語帳</a>から次の分野を追加</span></div></li>`
    : `<li class="path__node path__node--goal path__node--c"><span class="path__dot path__dot--goal" aria-hidden="true">🏆</span><div class="path__label"><b>${esc(label)} 制覇</b><span>${section?.next ? "次のセクションが開く" : "全ユニットを覚えたら"}</span></div></li>`;

  const more = hiddenLocked > 0
    ? `<li class="path__node path__node--locked path__node--more path__node--c"><span class="path__dot" aria-hidden="true">…</span><div class="path__label"><b>あと${hiddenLocked}ユニット</b><span>${hiddenUnits.map((u) => esc(u.label)).join("・")}</span></div></li>`
    : "";

  headEl.innerHTML = `
    <div class="path__head">
      <div class="path__head-text">
        <span class="path__kicker">${kicker}</span>
        <span class="path__title">${esc(label)}</span>
        <span class="path__unit">${unitLine}${units.length > 0 && !allDone ? ` <small>（${doneCount}／${units.length} 済み）</small>` : ""}</span>
      </div>
      <div class="path__head-actions">
        <a class="path__guide" href="./list.html?category=${encodeURIComponent(path.categoryId === "all" ? "" : path.categoryId)}">📖 一覧</a>
        <button type="button" class="path__guide path__guide--course" id="pathCourse" aria-expanded="false" aria-controls="pathCourses">コースを変える</button>
      </div>
    </div>
    ${courseChooserHtml(getCourseId())}
    <div class="path__toast" id="pathToast" hidden role="status"></div>
  `;
  // 語が1つも無いカテゴリ（空のマイ単語帳など）: 道の代わりに次にやることを出す
  const empty = units.length === 0
    ? `<li class="path__node path__node--goal path__node--c"><span class="path__dot path__dot--goal" aria-hidden="true">📝</span><div class="path__label"><b>まだ語がありません</b><span>${
        path.categoryId === "my"
          ? `<a href="./list.html#myWords">マイ単語帳</a>に語を登録するか、上の「出題」から別のカテゴリを選んでください`
          : `<a href="./list.html#packs">単語帳</a>から分野を追加するか、上の「出題」から別のカテゴリを選んでください`
      }</span></div></li>`
    : "";
  listEl.innerHTML = `<ol class="path__list">${nodes}${more}${units.length > 0 ? goal : empty}</ol>`;
  applyToast(false); // 表示中のお知らせは描き直しても残す

  el.querySelector("#pathStart")?.addEventListener("click", () => onStart?.(current && !allDone ? current : null));
  el.querySelectorAll(".path__dot[data-review]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const unit = units.find((u) => u.tag === btn.dataset.unit) ?? null;
      onStart?.(unit, { review: true });
    });
  });
  el.querySelector("#pathNext")?.addEventListener("click", () => onAdvance?.());
  el.querySelectorAll("#pathDoneFold, [data-fold-open]").forEach((btn) =>
    btn.addEventListener("click", () => {
      doneExpanded = true;
      renderPath({ onStart, onAdvance, onCourse });
    })
  );
  const courseBtn = el.querySelector("#pathCourse");
  const courses = el.querySelector("#pathCourses");
  courseBtn?.addEventListener("click", () => {
    const open = courses.hidden;
    courses.hidden = !open;
    courseBtn.setAttribute("aria-expanded", String(open));
  });
  el.querySelectorAll(".path__course-pick").forEach((btn) => btn.addEventListener("click", () => onCourse?.(btn.dataset.course)));
  return path;
}

// ユニット制覇の小さな演出（道の見出しの下に数秒）。はちゃんは出さない（登場は3場面だけ）。
// 直後に同期などで道が描き直されても消えないよう、表示中の内容を覚えておいて再描画時に出し直す
let toastState = null;
const TOAST_MS = 5000;

function applyToast(animate) {
  const toast = document.getElementById("pathToast");
  if (!toast) return;
  if (!toastState || Date.now() >= toastState.until) {
    toastState = null;
    toast.hidden = true;
    return;
  }
  toast.textContent = toastState.text;
  toast.hidden = false;
  toast.classList.remove("path__toast--in");
  if (animate) {
    void toast.offsetWidth;
    toast.classList.add("path__toast--in");
  }
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.hidden = true;
    toastState = null;
  }, Math.max(0, toastState.until - Date.now()));
}

export function showPathToast(text) {
  toastState = { text, until: Date.now() + TOAST_MS };
  applyToast(true);
}
