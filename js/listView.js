import { exampleHtml, hasExample } from "./wordExample.js";
import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { setupUnloadSync } from "./sync.js";
import { initWordStore, getCategories, getPackCatalog, isConceptWord } from "./wordStore.js";
import { setPackEnabled } from "./packs.js";
import { openFeedback } from "./feedback.js";
import { initializeMyWordsView } from "./myWordsView.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";
import { historyDotsHtml, memoryGaugeHtml } from "./learnedWords.js";
import { noteChipHtml, bindNoteEditors, escapeHtml } from "./wordNotes.js";
import { bindWordDetail } from "./wordDetail.js";
import { groupByGenre, setGenre, getGenre, genreLabel } from "./genres.js";
import { icon } from "./icons.js";

// ===== 単語帳（ジャンルごとの一覧） =====
// カテゴリ → ジャンル → カード。読み物として眺められて、そのジャンルだけ練習にも入れる。

const STATUS_LABEL = { untouched: "未着手", weak: "苦手", learning: "覚えかけ", mastered: "習得", known: "知ってた" };
const CATEGORY_KEY = "spelldash_category";

const params = new URLSearchParams(location.search);
let categoryId = params.get("category") || localStorage.getItem(CATEGORY_KEY) || "all";
let keyword = "";
let statusFilter = "all"; // all | untouched | weak | learned

initializeAuth();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();

initWordStore().then(async () => {
  // ?add=<packId> で来たら、そのパックを追加してすぐ表示（分野ごとの紹介リンク用）
  const addId = params.get("add");
  if (addId && getPackCatalog().some((p) => p.id === addId && !p.enabled)) {
    setPackEnabled(addId, true);
    await initWordStore();
    categoryId = addId;
  }
  const categories = getCategories();
  if (categoryId === "all" || !categories.some((c) => c.id === categoryId)) {
    categoryId = categories[0]?.id ?? "all";
  }
  // 分野パックの棚: カテゴリが決まっている人には畳んで、一覧を上に。追加リンクや #packs では開く
  const packsFold = document.getElementById("packsFold");
  if (packsFold) {
    const hasCategory = Boolean(params.get("category") || localStorage.getItem(CATEGORY_KEY));
    packsFold.open = !hasCategory || Boolean(addId) || location.hash === "#packs";
  }
  renderPacks();
  renderCategorySelect(categories);
  render();
  bindWordDetail({ onNoteSaved: render });
  // マイ単語帳（自分の教材を作る）: 追加・削除のたびに一覧とカテゴリ選択を更新
  initializeMyWordsView(() => {
    renderCategorySelect(getCategories());
    render();
  });
  const myFold = document.getElementById("myWords");
  if (myFold && (location.hash === "#myWords" || categoryId === "my")) {
    myFold.open = true;
    if (location.hash === "#myWords") myFold.scrollIntoView({ block: "start" });
  }
  document.getElementById("listSearch")?.addEventListener("input", (e) => {
    keyword = e.target.value.trim().toLowerCase();
    render();
  });
  document.getElementById("listFilters")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    statusFilter = chip.dataset.filter;
    document.querySelectorAll("#listFilters [data-filter]").forEach((c) => c.classList.toggle("filter-chip--active", c === chip));
    render();
  });
  // 表示密度: 簡潔（用語＋意味だけ）／詳しく。選択を記憶
  const DENSITY_KEY = "spelldash_list_compact";
  const densityButton = document.getElementById("listDensity");
  const applyDensity = (compact) => {
    document.body.classList.toggle("list-compact", compact);
    densityButton?.setAttribute("aria-pressed", String(compact));
    densityButton?.classList.toggle("filter-chip--active", compact);
    if (densityButton) densityButton.textContent = compact ? "詳しく表示" : "簡潔表示";
    localStorage.setItem(DENSITY_KEY, compact ? "1" : "0");
  };
  applyDensity(localStorage.getItem(DENSITY_KEY) === "1");
  densityButton?.addEventListener("click", () => applyDensity(!document.body.classList.contains("list-compact")));

  // "/" で検索にフォーカス
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/input|textarea/i.test(document.activeElement?.tagName ?? "")) {
      e.preventDefault();
      document.getElementById("listSearch")?.focus();
    }
  });
});

window.addEventListener("spelldash:synced", render);
window.addEventListener("spelldash:notes", render);

let selectBound = false;
function renderCategorySelect(categories) {
  const select = document.getElementById("listCategory");
  if (!select) return;
  select.innerHTML = categories.map((c) => `<option value="${c.id}"${c.id === categoryId ? " selected" : ""}>${c.label}</option>`).join("");
  if (selectBound) return;
  selectBound = true;
  select.addEventListener("change", () => {
    categoryId = select.value;
    history.replaceState(null, "", `?category=${encodeURIComponent(categoryId)}`);
    render();
  });
}

// ===== 教材ライブラリ: 分野パックの追加／外す =====
let packKeyword = "";
// 開いたグループを覚えておく（棚は検索や追加のたびに描き直されるので、
// 覚えていないと開いた直後に閉じてしまう）
const openPackGroups = new Set();
document.getElementById("packsSearch")?.addEventListener("input", (e) => {
  packKeyword = e.target.value.trim().toLowerCase();
  renderPacks();
});

function renderPacks() {
  const grid = document.getElementById("packsGrid");
  if (!grid) return;
  const packs = getPackCatalog();
  if (packs.length === 0) {
    grid.closest("#packs")?.setAttribute("hidden", "");
    return;
  }
  // 検索語で絞り込み（分野名・説明・対象・ジャンル名）。分野ごとにグループ見出し
  const q = packKeyword;
  const hit = (p) => !q || [p.label, p.blurb, p.audience, p.group].filter(Boolean).join(" ").toLowerCase().includes(q);
  const groups = new Map();
  for (const p of packs) {
    if (!hit(p)) continue;
    const key = p.group ?? "その他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const enabledCount = packs.filter((p) => p.enabled).length;
  const countEl = document.getElementById("packsCount");
  if (countEl) countEl.textContent = `${packs.length}分野 ・ 追加済み ${enabledCount}`;
  const fold = grid.closest("#packsFold");
  if (fold && q && !fold.open) fold.open = true;

  // 1行＝1分野: 名前・枚数・1行の説明・追加ボタン（対象者は title に）
  const card = (p) => `
        <article class="pack${p.enabled ? " pack--on" : ""}" data-pack="${p.id}"${p.audience ? ` title="${escapeHtml(p.audience)}向け"` : ""}>
          <div class="pack__head">
            <h3 class="pack__title">${escapeHtml(p.label)}</h3>
            <span class="pack__count mono">${p.count ?? ""}${p.count ? "枚" : ""}</span>
          </div>
          <p class="pack__blurb">${escapeHtml(p.blurb ?? "")}</p>
          <div class="pack__actions">
            ${p.enabled ? `<button type="button" class="btn btn--sm btn--ghost" data-pack-view="${p.id}">一覧</button>` : ""}
            <button type="button" class="btn btn--sm btn--ghost${p.enabled ? " pack__toggle--on" : ""}" data-pack-toggle="${p.id}">${p.enabled ? `${icon("check", { size: 14 })}追加済み` : "追加する"}</button>
          </div>
        </article>`;

  grid.innerHTML =
    groups.size === 0
      ? `<p class="muted">該当する分野がありません。</p>`
      : [...groups.entries()]
          .map(([name, list]) => {
            // グループは畳んでおく（分野が140を超えて、開いたままだと延々スクロールになるため）。
            // 検索中と、追加済みの分野を含むグループは開く。
            const open = Boolean(q) || list.some((p) => p.enabled) || openPackGroups.has(name);
            return `
        <details class="pack-group" data-group-name="${escapeHtml(name)}"${open ? " open" : ""}>
          <summary class="pack-group__title">${escapeHtml(name)} <span class="pack-group__count">${list.length}</span></summary>
          <div class="pack-group__grid">${list.map(card).join("")}</div>
        </details>`;
          })
          .join("");

  grid.querySelectorAll("details.pack-group").forEach((group) => {
    group.addEventListener("toggle", () => {
      const name = group.dataset.groupName;
      if (!name) return;
      if (group.open) openPackGroups.add(name);
      else openPackGroups.delete(name);
    });
  });

  grid.querySelectorAll("[data-pack-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.packToggle;
      const wasEnabled = getPackCatalog().find((p) => p.id === id)?.enabled;
      setPackEnabled(id, !wasEnabled);
      button.disabled = true;
      button.textContent = wasEnabled ? "外しています" : "読み込み中";
      await initWordStore();
      const categories = getCategories();
      if (!wasEnabled) {
        categoryId = id; // 追加したらその一覧をすぐ見せる
        localStorage.setItem(CATEGORY_KEY, id); // ホームのカテゴリもこれに
      } else if (categoryId === id) {
        categoryId = categories[0]?.id ?? "all";
        if (localStorage.getItem(CATEGORY_KEY) === id) localStorage.setItem(CATEGORY_KEY, "all");
      }
      history.replaceState(null, "", `?category=${encodeURIComponent(categoryId)}`);
      renderPacks();
      renderCategorySelect(categories);
      render();
      if (!wasEnabled) document.getElementById("listSummary")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  grid.querySelectorAll("[data-pack-view]").forEach((button) => {
    button.addEventListener("click", () => {
      categoryId = button.dataset.packView;
      history.replaceState(null, "", `?category=${encodeURIComponent(categoryId)}`);
      renderCategorySelect(getCategories());
      render();
      document.getElementById("listSummary")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function matchesStatus(word, stats) {
  if (statusFilter === "all") return true;
  const st = classifyWord(stats[word.id]);
  if (statusFilter === "untouched") return st === "untouched";
  if (statusFilter === "weak") return st === "weak";
  if (statusFilter === "learned") return st === "learning" || st === "mastered";
  return true;
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
    .map((g) => ({ ...g, words: g.words.filter((w) => matches(w) && matchesStatus(w, stats)) }))
    .filter((g) => g.words.length > 0);
  const total = groups.reduce((n, g) => n + g.words.length, 0);
  const learned = groups.reduce((n, g) => n + g.words.filter((w) => ["learning", "mastered"].includes(classifyWord(stats[w.id]))).length, 0);
  const activeGenre = getGenre();
  const label = getCategories().find((c) => c.id === categoryId)?.label ?? categoryId;

  if (summary) summary.textContent = `${label} ・ ${groups.length}ジャンル ・ ${total}語 ・ 覚えた ${learned}`;

  // 分野パックは業界の人のレビューで磨く: 気になる点をその場で送れる導線
  const review = document.getElementById("listReview");
  if (review) {
    const isPack = getPackCatalog().some((p) => p.id === categoryId);
    review.hidden = !isPack;
    review.innerHTML = isPack
      ? `<span>この分野に詳しい方へ:</span> <button type="button" class="list-review__button" data-pack-review>用語や説明の気になる点を送る</button>`
      : "";
    review.querySelector("[data-pack-review]")?.addEventListener("click", () => openFeedback({ prefill: `[分野パック: ${label}] ` }));
  }

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
            <h2 class="genre__title">${escapeHtml(g.label)} <span class="genre__count mono">${g.words.length}語</span>${done === g.words.length ? ` <span class="genre__clear">${icon("check", { size: 12 })}制覇</span>` : ""}</h2>
            <div class="genre__meta">覚えた ${done}${weak > 0 ? ` ・ 苦手 ${weak}` : ""}</div>
            ${weak > 0 ? `<button type="button" class="btn btn--sm btn--ghost genre__weak" data-practice-words="${g.words.filter((w) => classifyWord(stats[w.id]) === "weak").map((w) => w.id).join(",")}">苦手 ${weak}語だけ練習</button>` : ""}
            <button type="button" class="btn btn--sm${practicing ? "" : " btn--ghost"} genre__practice" data-practice="${g.tag}">${practicing ? "このジャンルを練習中" : "このジャンルを練習"}</button>
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
  // 苦手だけ練習: その語だけの回収セッションをホームで始める
  container.querySelectorAll("[data-practice-words]").forEach((button) => {
    button.addEventListener("click", () => {
      localStorage.setItem(CATEGORY_KEY, categoryId);
      location.href = `/?words=${encodeURIComponent(button.dataset.practiceWords)}`;
    });
  });
  bindNoteEditors(container, render);
}

function cardHtml(word, stat) {
  const status = classifyWord(stat);
  const concept = isConceptWord(word);
  // 1行目: 見出し語（英語は等幅）＋訳＋状態、2行目: 例文または場面。足元に履歴・記憶・メモ
  const term = escapeHtml(word.answer ?? word.en);
  const termClass = concept && !/^[A-Za-z0-9 .,'’/&()-]+$/.test(word.answer ?? word.en ?? "") ? "gcard__term" : "gcard__term mono";
  return `
    <article class="gcard gcard--${status}">
      <div class="gcard__head">
        <button type="button" class="${termClass}" data-word-detail="${word.id}" data-word-category="${escapeHtml(word.category ?? "")}">${term}</button>
        ${concept
          ? `<p class="gcard__ja">${escapeHtml(word.ja)}</p>`
          : `<p class="gcard__ja">${escapeHtml(word.ja)}${word.pos ? ` <span class="gcard__pos">${escapeHtml(word.pos)}</span>` : ""}</p>`}
        <span class="gcard__status gcard__status--${status}">${STATUS_LABEL[status]}</span>
      </div>
      ${concept
        ? `<p class="gcard__q">${escapeHtml(word.q)}</p>
           ${word.explain ? `<p class="gcard__explain">${escapeHtml(word.explain)}</p>` : ""}
           ${word.accept?.length ? `<p class="gcard__accept">別解: ${word.accept.map(escapeHtml).join(" / ")}</p>` : ""}`
        : hasExample(word) ? `<p class="gcard__ex">${exampleHtml(word, { speakButton: false, className: "gcard__ex" })}</p>` : ""}
      <div class="gcard__foot">
        ${historyDotsHtml(stat)}
        ${memoryGaugeHtml(stat)}
        ${noteChipHtml(word.id)}
      </div>
    </article>`;
}

// 練習中ジャンルの表示名（ホーム用に再利用）
export function currentGenreLabel() {
  const g = getGenre();
  return g ? genreLabel(g) : "";
}
