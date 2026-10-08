import { getCategories, getWordsByCategory, getPackCatalog, isConceptWord } from "./wordStore.js";
import { groupByGenre } from "./genres.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";
import { getCourse, sectionOf, listCourses, getCourseId, PLACEMENT_NOTE } from "./course.js";
import { getSetSize, isDailySetDone } from "./dailySet.js";
import { getDueReviewCount, isBeforePlacement } from "./studyQueue.js";
import { isPlacementRunning } from "./difficulty.js";
import { resumableFor } from "./sessionResume.js";
import { icon } from "./icons.js";
import { trapFocus } from "./focusTrap.js";
import { scrollBehavior } from "./ui.js";
import { shelfOf } from "./shelves.js";
import { esc, numHtml } from "./html.js";

// ===== 机の上の本（ホームの 1 画面目） =====
//
// いま選んでいるカテゴリ（＝本。spelldash_category）のジャンル（＝章）を本の目次にして、「次に押すもの」をスタート 1 個に絞る。
// 左頁（#pathHead）: 柱（コース名と巻）・題・答え方と語数・覚えた n／N・コースを変える。
// 右頁（#pathNow）: 今の章（第 n 章／全 N 章・「…」の章・今日のセット・スタート）。節目（次の巻へ・復習）と「語が無い」もここ。
// 目次（#pathList）: 済みの畳み・済み・先の章・あと N 章・星の節目。
// 章は全部の語を覚えた（知ってた含む）ら済み。「すべて」を選んでいる人は、カテゴリを 1 つずつ章にした目次になる。
// #pathStart は右頁にだけ、ちょうど 1 個。

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

// 本の題: 「中学英語 2年（教科書レベル）」の括弧書きは題から外し、答え方の行に添える
const splitTitle = (label) => {
  const m = String(label).match(/^(.*?)（([^）]*)）$/);
  return m ? { title: m[1].trim(), note: m[2] } : { title: String(label), note: "" };
};

// 済みユニットの折りたたみを開いたか（この表示の間だけ）
let doneExpanded = false;

// コース選択パネル（見出しの「コースを変える」で開く）。
// 各コースは1行（太字ラベル＋対象・巻数）で、行全体がボタン。説明は「くわしく」で開く（開いたら「閉じる」）。
// 560px 以下は画面下から出るシート、それより広い画面は見出しの下に重ねる（どちらも本のスタートは動かない）。
function courseChooserHtml(currentId) {
  return `
    <div class="path__courses-backdrop" id="pathCoursesBackdrop" hidden></div>
    <div class="path__courses" id="pathCourses" role="dialog" aria-modal="true" aria-label="コースを選ぶ" hidden>
      <div class="path__courses-head"><b>コースを選ぶ</b><button type="button" class="path__guide path__courses-close" id="pathCoursesClose">閉じる</button></div>
      <ul class="path__courses-list">
        ${listCourses()
          .map((c, i) => {
            const now = c.id === currentId;
            const text = `<b>${esc(c.label)}</b><small>${esc(c.audience)} ・ 全${c.packs.length}巻${now ? `<span class="path__course-now">いまのコース</span>` : ""}</small>`;
            return `
          <li class="path__course${now ? " path__course--current" : ""}">
            <div class="path__course-row">
              ${now ? `<div class="path__course-text">${text}</div>` : `<button type="button" class="path__course-pick" data-course="${esc(c.id)}">${text}</button>`}
              <button type="button" class="path__course-info" aria-expanded="false" aria-controls="pathCourseBlurb${i}">くわしく</button>
            </div>
            <p class="path__course-blurb" id="pathCourseBlurb${i}" hidden>${esc(c.blurb)}</p>
          </li>`;
          })
          .join("")}
      </ul>
    </div>`;
}

// 描画。onStart(unit|null) はスタート／復習、onAdvance() は次の巻へ、onCourse(courseId) はコースの乗り換え
export function renderPath({ onStart, onAdvance, onCourse } = {}) {
  const el = document.getElementById("pathCard");
  const headEl = document.getElementById("pathHead");
  const listEl = document.getElementById("pathList");
  const nowEl = document.getElementById("pathNow"); // 右頁（無いページでは目次の先頭に出す）
  if (!el || !headEl || !listEl) return null;

  // 描き直しで焦点を失わない: 本の中に焦点があれば同じ id の要素へ戻す（畳みを開いたときは最初の済みの章へ）
  const active = document.activeElement;
  const activeId = active && el.contains(active) ? active.id : "";
  const wasFold = activeId === "pathDoneFold" || (active && el.contains(active) && active.hasAttribute("data-fold-open"));

  const path = buildPath();
  const { units, currentIndex, allDone, course, section, label } = path;
  const current = currentUnitOf(path);
  const firstVisit = Object.keys(getWordStats()).length === 0;
  const setSize = getSetSize();
  const due = getDueReviewCount(path.categoryId);

  const category = getCategories().find((c) => c.id === path.categoryId);
  const shelf = shelfOf(path.categoryId, category);
  const words = path.categoryId === "all" ? [] : getWordsByCategory(path.categoryId);
  const unit = category?.kind === "concept" || isConceptWord(words[0]) ? "枚" : "語"; // 概念カード（日本語で答える）の本は「枚」
  const total = units.reduce((n, u) => n + u.total, 0);
  const learned = units.reduce((n, u) => n + u.learned, 0);
  // 腕試し前（まだ 1 語も答えていない。js/studyQueue.js の腕試し発動条件と同じ）: 進捗の数字（第 1 巻／全 8 巻・第 1 章／全 11 章・覚えた n／N）は出さず、コース名だけ
  const beforePlacement = isBeforePlacement();
  const kicker = section
    ? beforePlacement
      ? esc(course.label)
      : `${esc(course.label)}　第<span class="n">${section.index + 1}</span>巻／全<span class="n">${section.total}</span>巻`
    : path.categoryId === "all"
      ? "すべての単語"
      : path.categoryId === "my"
        ? "自分で書いた本"
        : shelf.name
          ? `${esc(shelf.name)}の棚`
          : "分野パック";
  const { title, note } = splitTitle(label);
  // 「教科書レベル・答えは英語・120語」: 折り返しは「・」の後だけ（各部分は nowrap）
  const metaParts = [];
  if (note) metaParts.push(`<span class="nb">${esc(note)}</span>`);
  metaParts.push(`<span class="nb">答えは${esc(path.categoryId === "all" ? "英語" : shelf.lang)}</span>`);
  if (total > 0) metaParts.push(`<span class="nb"><span class="n">${total}</span>${unit}</span>`);
  const progress =
    !beforePlacement && total > 0
      ? `<div class="path__progress progress" role="img" aria-label="${total}${unit}中${learned}${unit}を覚えた"><div class="progress__rule"><i style="width:${Math.round((learned / total) * 100)}%"></i></div><p class="progress__txt">覚えた <b class="n">${learned}</b><span class="of">／${total}</span></p></div>`
      : "";
  const resume = firstVisit ? null : resumableFor(path.categoryId);
  const doneToday = !resume && !firstVisit && isDailySetDone(); // 今日のぶんが済んだ（ラベルと板の見た目の両方で使う）
  const startSub = resume
    ? `前回の続きから（${resume.recalled.length}／${resume.setSize}語 済み）`
    : firstVisit || (beforePlacement && isPlacementRunning()) // 腕試しを開いて 1 語も答えずに戻った人も（始まった腕試しだけ。組めずに通常のセットになる道では言わない）
    ? PLACEMENT_NOTE
    : doneToday
      ? "今日のぶんは完了"
      : `今日のセット ${setSize}語・約5分${due >= setSize ? " ・ 復習から" : due > 0 ? ` ・ 復習 ${due}語から` : ""}`;

  // 現在地より先の未着手の章は3つまで見せ、残りは「あとN章」にまとめる（目次が長くなりすぎない）
  const lockedLimit = currentIndex >= 0 ? currentIndex + 3 : units.length;
  const hiddenUnits = units.filter((u, i) => !u.done && i !== currentIndex && i > lockedLimit);
  const hiddenLocked = hiddenUnits.length;
  // 現在地より前の済みの章は直前の2つだけ見せ、それより前は「済み N章」1つに畳む（開くと全部出る）。
  // 毎日開くたびに済みの列をスクロールしなくていいように、現在地が最初の画面に来る。
  // 全章済みのときも畳む（「次の巻へ」が最初の画面に来る）
  const doneBefore = currentIndex >= 0 ? units.slice(0, currentIndex).filter((u) => u.done) : units.filter((u) => u.done);
  const foldDone = !doneExpanded && doneBefore.length > 3 ? doneBefore.slice(0, doneBefore.length - 2) : [];
  const foldedSet = new Set(foldDone);
  const listHref = (tag) => `./list.html?category=${encodeURIComponent(path.categoryId === "all" ? "" : path.categoryId)}${tag && !tag.startsWith("category:") ? `#genre-${encodeURIComponent(tag)}` : ""}`;
  const chapterK = !beforePlacement && currentIndex >= 0 ? `<p class="path__chapter chap__k">第<span class="n">${currentIndex + 1}</span>章／全<span class="n">${units.length}</span>章</p>` : "";

  let nowHtml = "";
  const nodes = units
    .map((u, i) => {
      const state = u.done ? "done" : i === currentIndex ? "current" : "locked";
      if (state === "locked" && i > lockedLimit) return "";
      if (foldedSet.has(u)) {
        if (u !== foldDone[0]) return "";
        return `
          <li class="path__node path__node--done path__node--fold">
            <button type="button" class="path__dot" id="pathDoneFold" aria-expanded="false" aria-label="済みの章を開く">${icon("check", { size: 14 })}</button>
            <div class="path__label"><b>済み ${foldDone.length}章</b><span>${foldDone.map((d) => esc(d.label)).join("・")} ・ <button type="button" class="path__linkbtn" data-fold-open>開く</button></span></div>
          </li>`;
      }
      const count = `${u.learned}／${u.total}`;
      if (state === "current") {
        // 右頁: 今の章（1 列。章のキッカー → 「…」の章 → 今日のセットの 1 行 → スタート → 一覧と本棚）
        nowHtml = `
          <ol class="path__list path__list--now">
            <li class="path__node path__node--current path__node--now">
              ${chapterK}
              <div class="path__label"><b class="chap__t"><span class="chap__q">「</span>${esc(u.label)}<span class="chap__q">」</span>の章</b><span class="todays">${numHtml(startSub)}</span></div>
              <button type="button" class="path__start start${resume ? " path__start--resume" : ""}${doneToday ? " path__start--done" : ""}" id="pathStart" data-unit="${esc(u.tag)}" aria-label="${resume ? "続きから" : doneToday ? "もう1回" : "スタート"}: ${esc(u.label)}">${resume ? "続きから" : doneToday ? "もう1回" : "スタート"}</button>
              <p class="path__links tome__links"><a class="path__unit-link" href="${listHref(u.tag)}" aria-label="${esc(u.label)} の一覧">この章の一覧</a><a class="path__shelf-link" href="#bookshelf">本棚・本をさがす</a></p>
            </li>
          </ol>`;
        return "";
      }
      if (state === "done") {
        return `
          <li class="path__node path__node--done">
            <button type="button" class="path__dot" data-unit="${esc(u.tag)}" data-review="1" aria-label="復習: ${esc(u.label)}">${icon("check", { size: 14 })}</button>
            <div class="path__label"><b>${esc(u.label)}<a class="path__unit-link" href="${listHref(u.tag)}" aria-label="${esc(u.label)} の一覧">${icon("book", { size: 14 })}</a></b><span>${count}${u.weak > 0 ? ` ・ 苦手 ${u.weak}` : ""} ・ 押して復習</span></div>
          </li>`;
      }
      return `
        <li class="path__node path__node--locked">
          <span class="path__dot" aria-hidden="true"></span>
          <div class="path__label"><b>${esc(u.label)}</b><span>${u.learned > 0 ? count : `${u.total}${unit}`}</span></div>
        </li>`;
    })
    .join("");

  // 節目: 全章済みなら右頁（次の巻へ／復習）、まだなら目次の末尾に星
  const nextLabel = section?.next ? splitTitle([...getCategories(), ...getPackCatalog()].find((c) => c.id === section.next)?.label ?? "次の本").title : "";
  if (allDone) {
    nowHtml = section?.next
      ? `
          <ol class="path__list path__list--now">
            <li class="path__node path__node--goal path__node--now">
              <p class="path__chapter chap__k">全<span class="n">${units.length}</span>章 済み</p>
              <div class="path__label"><b class="chap__t">次は<span class="chap__q">「</span>${esc(nextLabel)}<span class="chap__q">」</span></b></div>
              <button type="button" class="path__start start path__start--next" id="pathNext">次の巻へ${icon("arrowRight")}</button>
            </li>
          </ol>`
      : `
          <ol class="path__list path__list--now">
            <li class="path__node path__node--goal path__node--now">
              <p class="path__chapter chap__k">全<span class="n">${units.length}</span>章 済み</p>
              <div class="path__label"><b class="chap__t">${section ? "このコースは終わり" : "全部済み"}</b><span>復習を続けるか、<button type="button" class="path__linkbtn" data-open-course>${section ? "コースを変える" : "コースを選ぶ"}</button></span></div>
              <button type="button" class="path__start start" id="pathStart" data-unit="" aria-label="復習">復習</button>
            </li>
          </ol>`;
  }
  // 語が 1 つも無い本（右頁は「まだ語が無い」）には「0章を終えると」の星を出さない
  const goal = allDone || units.length === 0
    ? ""
    : `<li class="path__node path__node--goal"><span class="path__dot path__dot--goal" aria-hidden="true">${icon("star", { size: 14 })}</span><div class="path__label"><b>${units.length}章を終えると</b><span>${section?.next ? "次の巻が開く" : "このコースは終わり"}</span></div></li>`;

  const more = hiddenLocked > 0
    ? `<li class="path__node path__node--locked path__node--more"><span class="path__dot path__dot--more" aria-hidden="true"></span><div class="path__label"><b>あと${hiddenLocked}章</b><span>${hiddenUnits.map((u) => esc(u.label)).join("・")}</span></div></li>`
    : "";

  headEl.innerHTML = `
    <div class="path__head">
      <div class="path__head-text">
        <p class="path__kicker runhead">${kicker}</p>
        <h1 class="path__title tome__title">${numHtml(title)}</h1>
        <p class="path__meta tome__meta">${metaParts.join("・")}</p>
        ${progress}
      </div>
      <div class="path__head-actions">
        <button type="button" class="path__guide path__guide--course" id="pathCourse" aria-expanded="false" aria-controls="pathCourses">コースを変える</button>
      </div>
    </div>
    ${courseChooserHtml(getCourseId())}
  `;
  // 語が1つも無い本（空のマイ単語帳など）: 章の代わりに次にやることを右頁に出す
  if (units.length === 0) {
    nowHtml = `
      <ol class="path__list path__list--now">
        <li class="path__node path__node--goal path__node--now"><span class="path__dot path__dot--goal" aria-hidden="true">${icon("note", { size: 14 })}</span><div class="path__label"><b class="chap__t">まだ語が無い</b><span>${
          path.categoryId === "my"
            ? `<a href="./list.html#myWords">マイ単語帳</a>に語を登録するか、下の「出題」から別の本を選ぶ`
            : `<a href="./list.html#packs">単語帳</a>から分野を追加するか、下の「出題」から別の本を選ぶ`
        }</span></div></li>
      </ol>`;
  }
  const tocHtml = `${units.length > 0 ? `<p class="path__toc-k">目次</p>` : ""}<ol class="path__list">${nodes}${more}${goal}</ol>`;
  if (nowEl) {
    nowEl.innerHTML = nowHtml;
    listEl.innerHTML = tocHtml;
  } else {
    listEl.innerHTML = nowHtml + tocHtml;
  }
  if (wasFold) {
    (el.querySelector(".path__node--done .path__dot[data-review]") ?? el.querySelector("#pathStart"))?.focus({ preventScroll: true });
  } else if (activeId) {
    el.querySelector(`#${CSS.escape(activeId)}`)?.focus({ preventScroll: true });
  }

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
      // 開いた済みの章が画面の外に出ないように（スタートは右頁にあるので動かない）
      el.querySelector(".path__node--done")?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
    })
  );
  const courseBtn = el.querySelector("#pathCourse");
  const courses = el.querySelector("#pathCourses");
  const backdrop = el.querySelector("#pathCoursesBackdrop");
  // 開いている間はフォーカストラップ（Tab は中で循環・Esc で閉じる）。閉じたら必ず「コースを変える」へ戻す
  let releaseCourses = null;
  let courseOpener = null; // 右頁の「コースを変える」から開いたときは、閉じたらそこへ戻す
  function setCoursesOpen(open) {
    if (!courses) return;
    courses.hidden = !open;
    if (backdrop) backdrop.hidden = !open;
    courseBtn?.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("courses-open", open);
    if (open) {
      releaseCourses?.({ restore: false });
      releaseCourses = trapFocus(courses, {
        onEscape: () => setCoursesOpen(false),
        initialFocus: courses.querySelector(".path__course-pick, #pathCoursesClose"),
        restoreFocus: false
      });
    } else {
      const release = releaseCourses;
      releaseCourses = null;
      release?.({ restore: false });
      const back = courseOpener?.isConnected ? courseOpener : courseBtn;
      courseOpener = null;
      if (back && back.isConnected) back.focus({ preventScroll: true });
    }
  }
  courseBtn?.addEventListener("click", () => setCoursesOpen(courses.hidden));
  el.querySelectorAll("[data-open-course]").forEach((btn) =>
    btn.addEventListener("click", () => {
      courseOpener = btn;
      setCoursesOpen(true);
    })
  );
  el.querySelector("#pathCoursesClose")?.addEventListener("click", () => setCoursesOpen(false));
  backdrop?.addEventListener("click", () => setCoursesOpen(false));
  el.querySelectorAll(".path__course-info").forEach((btn) =>
    btn.addEventListener("click", () => {
      const blurb = document.getElementById(btn.getAttribute("aria-controls"));
      if (!blurb) return;
      const open = blurb.hidden;
      blurb.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "閉じる" : "くわしく";
    })
  );
  el.querySelectorAll(".path__course-pick").forEach((btn) =>
    btn.addEventListener("click", () => {
      setCoursesOpen(false);
      onCourse?.(btn.dataset.course);
    })
  );
  return path;
}
