import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { setupUnloadSync } from "./sync.js";
import { initWordStore, getCategories, isConceptWord } from "./wordStore.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";
import { historyDotsHtml } from "./learnedWords.js";
import { noteChipHtml, bindNoteEditors, escapeHtml } from "./wordNotes.js";
import { bindWordDetail } from "./wordDetail.js";
import { groupByGenre, setGenre, getGenre, genreLabel } from "./genres.js";

// ===== 単語帳（ジャンルごとの一覧） =====
// カテゴリ → ジャンル → カード。読み物として眺められて、そのジャンルだけ練習にも入れる。

const STATUS_LABEL = { untouched: "未着手", weak: "苦手", learning: "覚えかけ", mastered: "習得", known: "知ってた" };
const CATEGORY_KEY = "spelldash_category";

const params = new URLSearchParams(location.search);
let categoryId = params.get("category") || localStorage.getItem(CATEGORY_KEY) || "all";
let keyword = "";

initializeAuth();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();

initWordStore().then(() => {
  const categories = getCategories();
  if (categoryId === "all" || !categories.some((c) => c.id === categoryId)) {
    categoryId = categories[0]?.id ?? "all";
  }
  renderCategorySelect(categories);
  render();
  bindWordDetail({ onNoteSaved: render });
  document.getElementById("listSearch")?.addEventListener("input", (e) => {
    keyword = e.target.value.trim().toLowerCase();
    render();
  });
});

window.addEventListener("spelldash:synced", render);
window.addEventListener("spelldash:notes", render);

function renderCategorySelect(categories) {
  const select = document.getElementById("listCategory");
  if (!select) return;
  select.innerHTML = categories.map((c) => `<option value="${c.id}"${c.id === categoryId ? " selected" : ""}>${c.label}</option>`).join("");
  select.addEventListener("change", () => {
    categoryId = select.value;
    history.replaceState(null, "", `?category=${encodeURIComponent(categoryId)}`);
    render();
  });
}

function matches(word) {
  if (!keyword) return true;
  const hay = [word.en, word.ja, word.q, word.explain, ...(word.accept ?? []), ...(word.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
  return hay.includes(keyword);
}

function render() {
  const container = document.getElementById("listBody");
  const nav = document.getElementById("listGenres");
  const summary = document.getElementById("listSummary");
  if (!container) return;

  const stats = getWordStats();
  const groups = groupByGenre(categoryId)
    .map((g) => ({ ...g, words: g.words.filter(matches) }))
    .filter((g) => g.words.length > 0);
  const total = groups.reduce((n, g) => n + g.words.length, 0);
  const learned = groups.reduce((n, g) => n + g.words.filter((w) => ["learning", "mastered"].includes(classifyWord(stats[w.id]))).length, 0);
  const activeGenre = getGenre();
  const label = getCategories().find((c) => c.id === categoryId)?.label ?? categoryId;

  if (summary) summary.textContent = `${label} ・ ${groups.length}ジャンル ・ ${total}語 ・ 覚えた ${learned}`;

  if (nav) {
    nav.innerHTML = groups
      .map((g) => `<a class="genre-chip${g.tag === activeGenre ? " genre-chip--active" : ""}" href="#genre-${g.tag}">${escapeHtml(g.label)}<span>${g.words.length}</span></a>`)
      .join("");
  }

  if (groups.length === 0) {
    container.innerHTML = `<p class="muted">該当する語がありません。</p>`;
    return;
  }

  container.innerHTML = groups
    .map((g) => {
      const done = g.words.filter((w) => ["learning", "mastered"].includes(classifyWord(stats[w.id]))).length;
      const weak = g.words.filter((w) => classifyWord(stats[w.id]) === "weak").length;
      const practicing = g.tag === activeGenre;
      return `
        <section class="genre" id="genre-${g.tag}">
          <div class="genre__head">
            <h2 class="genre__title">${escapeHtml(g.label)} <span class="genre__count">${g.words.length}語</span></h2>
            <div class="genre__meta">覚えた ${done}${weak > 0 ? ` ・ 苦手 ${weak}` : ""}</div>
            <button type="button" class="btn btn--sm${practicing ? "" : " btn--ghost"} genre__practice" data-practice="${g.tag}">${practicing ? "▶ このジャンルを練習中" : "このジャンルを練習"}</button>
          </div>
          <div class="genre__cards">
            ${g.words.map((w) => cardHtml(w, stats[w.id])).join("")}
          </div>
        </section>`;
    })
    .join("");

  container.querySelectorAll("[data-practice]").forEach((button) => {
    button.addEventListener("click", () => {
      localStorage.setItem(CATEGORY_KEY, categoryId);
      setGenre(button.dataset.practice);
      location.href = "/";
    });
  });
  bindNoteEditors(container, render);
}

function cardHtml(word, stat) {
  const status = classifyWord(stat);
  const concept = isConceptWord(word);
  return `
    <article class="gcard gcard--${status}">
      <div class="gcard__head">
        <button type="button" class="gcard__term" data-word-detail="${word.id}">${escapeHtml(word.answer ?? word.en)}</button>
        <span class="gcard__status gcard__status--${status}">${STATUS_LABEL[status]}</span>
      </div>
      ${concept
        ? `<p class="gcard__q">${escapeHtml(word.q)}</p>
           <p class="gcard__ja">${escapeHtml(word.ja)}</p>
           ${word.explain ? `<p class="gcard__explain">📘 ${escapeHtml(word.explain)}</p>` : ""}
           ${word.accept?.length ? `<p class="gcard__accept">別解: ${word.accept.map(escapeHtml).join(" / ")}</p>` : ""}`
        : `<p class="gcard__ja">${escapeHtml(word.ja)}</p>`}
      <div class="gcard__foot">
        ${historyDotsHtml(stat)}
        ${noteChipHtml(word.id)}
      </div>
    </article>`;
}

// 練習中ジャンルの表示名（ホーム用に再利用）
export function currentGenreLabel() {
  const g = getGenre();
  return g ? genreLabel(g) : "";
}
