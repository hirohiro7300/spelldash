// 分野パックの入口ページ（静的HTML）と sitemap.xml を生成する。
//   node scripts/build-pack-pages.mjs
// 出力: packs/<id>.html（各パック）、packs/index.html（一覧）、sitemap.xml
// 検索から着地 → 内容のサンプルを見る → 「追加して始める」で list.html?add=<id> へ。
// JS なしで読める（クローラ向け）。デザインは既存 CSS を流用。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://www.spelldash.net";
const OUT_DIR = path.join(ROOT, "packs");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "manifest.json"), "utf8"));
const subject = manifest.subjects.find((s) => s.id === "english");
const packs = subject.categories.filter((c) => c.pack);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 単位: 英単語パックは「語」、場面カード・暗記もの（manifest の kind: concept）は「枚」（js/listView.js と同じ判定）
const unit = (p) => (p.kind === "concept" ? "枚" : "語");

const CARD_TYPE_LABEL = {
  word: "日本語訳を見て英単語を打つ",
  grammar: "英文の空欄に入る語を英語で打つ",
  writing: "日本語の文を見て、英文を丸ごと打つ（語順まで身につく）",
  school: "説明を読んで用語・人名・地名を答える（読みをローマ字で打つ。漢字への変換なし）",
  concept: "場面の説明を読んで用語で答える（日本語の用語は読みをローマ字で）"
};

function sampleHtml(data, words) {
  const type = data.cardType ?? "concept";
  return words
    .map((w) => {
      if (type === "word") {
        return `<li class="pp-card pp-card--en"><span class="pp-card__q">${esc(w.ja)}${w.pos ? `<small>（${esc(w.pos)}）</small>` : ""}</span><span class="pp-card__a">${esc(w.en)}</span></li>`;
      }
      return `<li class="pp-card"><span class="pp-card__q">${esc(w.q)}</span><span class="pp-card__a">${esc(w.answer)}</span>${w.explain ? `<span class="pp-card__ex">${esc(w.explain)}</span>` : ""}</li>`;
    })
    .join("\n");
}

function pageShell({ title, description, canonical, body }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/css/reset.css" />
  <link rel="stylesheet" href="/css/tokens.css" />
  <link rel="stylesheet" href="/css/layout.css" />
  <link rel="stylesheet" href="/css/game.css" />
  <link rel="stylesheet" href="/css/responsive.css" />
  <link rel="stylesheet" href="/css/brand.css" />
  <link rel="stylesheet" href="/css/pages.css" />
  <meta name="theme-color" content="#f7f6f2" />
  <script>(() => { const t = localStorage.getItem("spelldash_theme"); const theme = ["dark","paper","indigo"].includes(t) ? t : "light"; document.documentElement.dataset.theme = theme; const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = { light: "#f7f6f2", dark: "#131417", paper: "#f3ecdd", indigo: "#121a2b" }[theme]; })();</script>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="SpellDash" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="${SITE}/assets/images/og-image.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" type="image/png" sizes="192x192" href="/assets/icons/icon-192.png" />
  <style>
    .pp { max-width: 720px; margin: 0 auto; padding: 8px 16px 56px; color: var(--ink); }
    .pp-hero { padding: 24px 0 8px; }
    .pp-kicker { margin: 0 0 6px; font-family: var(--font-mono); font-size: 12px; color: var(--ink-3); }
    .pp h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; }
    .pp-lead { margin: 0 0 6px; font-size: 16px; line-height: 1.7; color: var(--ink-2); }
    .pp-meta { margin: 0 0 16px; font-size: 13px; color: var(--ink-3); }
    .pp-cta { display: inline-flex; align-items: center; height: 40px; padding: 0 18px; border-radius: var(--radius); background: var(--ink); color: var(--paper); font-size: 14px; font-weight: 700; text-decoration: none; }
    .pp-cta:hover { background: var(--ink-2); }
    .pp-cta--ghost, .pp-cta--ghost:hover { background: transparent; color: var(--ink); border: 1px solid var(--line-2); }
    .pp-cta--ghost:hover { background: var(--paper-3); }
    .pp-sub { display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; margin: 0 -8px 0 4px; font-size: 13px; color: var(--ink-2); text-decoration: underline; text-underline-offset: 2px; }
    .pp-sub:hover { color: var(--signal-ink); }
    .pp h2 { margin: 32px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line-2); font-size: 16px; font-weight: 700; }
    .pp-genres { display: flex; flex-wrap: wrap; gap: 6px; padding: 0; margin: 0; list-style: none; }
    .pp-genres li { padding: 4px 10px; border-radius: 999px; background: var(--paper-3); color: var(--ink-2); font-size: 12px; font-weight: 600; }
    .pp-genres li span { margin-left: 4px; font-family: var(--font-mono); font-weight: 500; color: var(--ink-3); }
    .pp-cards { display: grid; gap: 0; padding: 0; margin: 0; list-style: none; border-top: 1px solid var(--line); }
    .pp-card { display: grid; gap: 2px; padding: 10px 0; border-bottom: 1px solid var(--line); }
    .pp-card__q { font-size: 14px; line-height: 1.6; color: var(--ink-2); }
    .pp-card__q small { font-size: 12px; }
    .pp-card__q small { margin-left: 4px; color: var(--ink-3); }
    .pp-card__a { font-weight: 600; color: var(--ink); }
    .pp-card--en .pp-card__a { font-family: var(--font-mono); font-size: 16px; }
    .pp-card__ex { font-size: 13px; line-height: 1.5; color: var(--ink-3); }
    .pp-how { padding-left: 18px; font-size: 14px; line-height: 1.7; color: var(--ink-2); }
    .pp-how li { margin: 4px 0; }
    .pp-index h2 { margin-top: 28px; scroll-margin-top: 72px; }
    /* 一覧の 1 行＝1 パック。行全体がリンク（44px）。説明は 560px 以下では出さない（入口ページに同じ文がある） */
    .pp-index ul { padding: 0; margin: 0; list-style: none; line-height: 1.5; }
    .pp-index li { border-bottom: 1px solid var(--line); }
    .pp-index .packs-item { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 8px 0; color: var(--ink); text-decoration: none; }
    .pp-index .packs-item b { flex: 0 0 auto; max-width: 100%; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
    .pp-index .packs-item:hover b { color: var(--signal-ink); }
    .pp-index .packs-item small { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--ink-3); }
    .pp-index .packs-item__n { white-space: nowrap; font-family: var(--font-mono); }
    /* チップ状のリンク（同じグループの分野・一覧のグループへのジャンプ）。指で押せる 40px */
    .pp-related, .packs-jump { display: flex; flex-wrap: wrap; gap: 8px; padding: 0; margin: 0; list-style: none; }
    .packs-jump { margin: 16px 0 0; }
    .pp-related a, .packs-jump a { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border-radius: 999px; background: var(--paper-3); color: var(--ink); font-size: 13px; font-weight: 600; text-decoration: none; }
    .pp-related a:hover, .packs-jump a:hover { background: var(--line); }
    .packs-jump a small { margin-left: 6px; font-family: var(--font-mono); font-weight: 500; font-size: 12px; color: var(--ink-3); }
    /* 560px 以下: ジャンプチップは 2 列 grid（1 行 1 個の縦積みにしない）。一覧の説明は出さない（.packs-jump の flex より後に置く） */
    @media (max-width: 560px) {
      .packs-jump { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .packs-jump a { min-height: 40px; padding: 0 10px; font-size: 12px; }
      .pp-index .packs-item__blurb { display: none; }
      .pp-index .packs-item b { flex: 1 1 auto; }
      .pp-index .packs-item small { flex: 0 0 auto; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">本文へ</a>
  <header class="site-header">
    <div class="site-header__inner">
      <a href="/" class="brand"><span class="brand__mark" aria-hidden="true">SD</span><span class="brand__name">SpellDash</span></a>
      <nav class="site-nav" aria-label="メインナビ">
        <a href="/" class="site-nav__link">プレイ</a>
        <a href="/stats.html" class="site-nav__link">学習データ</a>
        <a href="/list.html" class="site-nav__link">単語帳</a>
        <a href="/battle.html" class="site-nav__link">バトル</a>
      </nav>
      <a id="headerStreak" class="header-streak" href="/stats.html" title="連続プレイ日数" hidden></a>
      <div class="account">
        <a class="btn btn--sm btn--ghost account__home account__link" id="accountLink" href="/?login=1">ログイン</a>
      </div>
    </div>
  </header>
  <main class="pp" id="main" tabindex="-1">
${body}
  </main>
  <footer class="site-footer">
    <div class="site-footer__inner">
      <div class="site-footer__brand"><span class="brand__mark" aria-hidden="true">SD</span><span class="brand__name">SpellDash</span></div>
      <p class="site-footer__tagline">タイピングで、英単語を体に覚えさせる。</p>
      <nav class="site-footer__nav" aria-label="フッターナビ">
        <a href="/news.html">お知らせ</a>
        <a href="/privacy.html">プライバシー</a>
        <a href="/tokushoho.html">特定商取引法に基づく表記</a>
        <a href="/terms.html">利用規約</a>
        <button type="button" class="site-footer__linkbtn" data-feedback-open>ご意見・不具合</button>
      </nav>
      <p class="site-footer__copy">© <span id="footerYear">2026</span> SpellDash</p>
    </div>
  </footer>
  <script type="module">
    import "/js/staticHeader.js"; // ヘッダー右端（連続日数・ログイン／設定）
    import { setFooterYear } from "/js/footer.js";
    setFooterYear();
  </script>
</body>
</html>
`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const groups = new Map();

for (const p of packs) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", p.file), "utf8"));
  const type = data.cardType ?? "concept";
  const words = data.words;
  // サンプル: ジャンルをまたいで easy 優先で 8 枚
  const byGenre = new Map();
  for (const w of words) {
    const g = w.tags?.[0] ?? "";
    if (!byGenre.has(g)) byGenre.set(g, []);
    byGenre.get(g).push(w);
  }
  const sample = [];
  const order = ["easy", "normal", "hard"];
  for (const lv of order) {
    for (const list of byGenre.values()) {
      const w = list.find((x) => x.level === lv && !x.kanjiOnly && !sample.includes(x)); // 漢字の書き分けのカードは学習に出さないので見本にもしない
      if (w) sample.push(w);
      if (sample.length >= 8) break;
    }
    if (sample.length >= 8) break;
  }
  const genreCounts = [...byGenre.entries()].map(([tag, list]) => `<li>${esc(data.genres?.[tag] ?? tag)} <span>${list.length}</span></li>`).join("");
  const title = `${p.label}（${p.count}${unit(p)}）| SpellDash 分野パック`;
  const description = `${p.blurb}。${p.audience}向け。${CARD_TYPE_LABEL[type]}。追加した人だけに出題され、思い出せなかった問題は復習の仕組みでまた出ます。`;
  const canonical = `${SITE}/packs/${p.id}.html`;
  const siblings = packs.filter((x) => x.group === p.group && x.id !== p.id).slice(0, 8);
  const body = `
    <section class="pp-hero">
      <p class="pp-kicker">${esc(p.group)} ・ パック</p>
      <h1>${esc(p.label)}</h1>
      <p class="pp-lead">${esc(p.blurb)}</p>
      <p class="pp-meta">${esc(p.audience)}向け ・ ${p.count}${unit(p)} ・ ${esc(CARD_TYPE_LABEL[type])}</p>
      <a class="pp-cta" href="/list.html?add=${encodeURIComponent(p.id)}">このパックを追加して始める</a>
      <a class="pp-sub" href="/packs/">他のパックを見る</a>
    </section>
    <section>
      <h2>収録ジャンル</h2>
      <ul class="pp-genres">${genreCounts}</ul>
    </section>
    <section>
      <h2>カードの例</h2>
      <ul class="pp-cards">
${sampleHtml(data, sample)}
      </ul>
    </section>
    <section>
      <h2>どう覚えるか</h2>
      <ul class="pp-how">
        <li>${esc(CARD_TYPE_LABEL[type])}。分からなければ Enter で答えを見て、数問後にもう一度出る</li>
        <li>自力で思い出せた語は復習の間隔が伸び、思い出せなかった語は近いうちにまた出る（想起練習と間隔反復）</li>
        <li>学習の記録は端末に保存され、ログインすると別の端末でも続きから</li>
      </ul>
      <p><a class="pp-cta pp-cta--ghost" href="/list.html?add=${encodeURIComponent(p.id)}">このパックを追加して始める</a></p>
    </section>
    ${siblings.length ? `<section><h2>同じグループのパック</h2><ul class="pp-related">${siblings.map((s) => `<li><a href="/packs/${s.id}.html">${esc(s.label)}</a></li>`).join("")}</ul></section>` : ""}
    ${data.source ? `<section><h2>出典</h2><p class="pp-source">語彙リスト: <a href="${esc(data.source.url)}" rel="license noopener" target="_blank">${esc(data.source.list)}</a>（${esc(data.source.license)}${data.source.ranks ? ` ・ 頻度順位 ${esc(data.source.ranks)}` : ""}）。訳・品詞・例文は SpellDash が作成。</p></section>` : ""}
  `;
  fs.writeFileSync(path.join(OUT_DIR, `${p.id}.html`), pageShell({ title, description, canonical, body }));
  if (!groups.has(p.group)) groups.set(p.group, []);
  groups.get(p.group).push(p);
}

// 一覧ページ
const indexBody = `
    <section class="pp-hero">
      <p class="pp-kicker">SpellDash</p>
      <h1>分野パック一覧</h1>
      <p class="pp-lead">仕事の共通言語、試験の語彙、学校の暗記もの。追加したパックだけがホームに出て、思い出して打つ・復習の仕組みで覚える。</p>
      <p class="pp-meta">${packs.length}パック ・ 英単語 ${packs.filter((p) => unit(p) === "語").reduce((n, p) => n + p.count, 0).toLocaleString("ja-JP")}語 ・ 場面カード ${packs.filter((p) => unit(p) === "枚").reduce((n, p) => n + p.count, 0).toLocaleString("ja-JP")}枚</p>
      <a class="pp-cta" href="/list.html#packs">単語帳ページで追加する</a>
      <nav aria-label="グループへ移動"><ul class="packs-jump">${[...groups.entries()].map(([g, list], i) => `<li><a href="#group-${i + 1}">${esc(g.split("（")[0])}<small>${list.length}</small></a></li>`).join("")}</ul></nav>
    </section>
    <section class="pp-index">
${[...groups.entries()].map(([g, list], i) => `      <h2 id="group-${i + 1}">${esc(g)}</h2>\n      <ul>${list.map((p) => `<li><a class="packs-item" href="/packs/${p.id}.html"><b>${esc(p.label)}</b><small><span class="packs-item__n">${p.count}${unit(p)}</span><span class="packs-item__blurb"> ・ ${esc(p.blurb)}</span></small></a></li>`).join("")}</ul>`).join("\n")}
    </section>
  `;
fs.writeFileSync(
  path.join(OUT_DIR, "index.html"),
  pageShell({ title: "分野パック一覧 | SpellDash", description: "不動産・会計・医療・SaaS・英検・TOEIC・中学高校の教科など、SpellDash の学習パック一覧。追加したパックだけがホームに出ます。", canonical: `${SITE}/packs/`, body: indexBody })
);

// sitemap.xml（基本ページ＋パックの入口ページ）
const urls = [
  ["/", "weekly", "1.0"],
  ["/list.html", "weekly", "0.8"],
  ["/packs/", "weekly", "0.8"],
  ...packs.map((p) => [`/packs/${p.id}.html`, "monthly", "0.7"]),
  ["/list.html?category=listing", "monthly", "0.6"],
  ["/news.html", "weekly", "0.5"],
  ["/battle.html", "monthly", "0.4"],
  ["/privacy.html", "yearly", "0.2"],
  ["/pro.html", "monthly", "0.6"],
  ["/tokushoho.html", "yearly", "0.2"],
  ["/terms.html", "yearly", "0.2"]
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
  .map(([u, f, pr]) => `  <url><loc>${SITE}${u.replace(/&/g, "&amp;")}</loc><changefreq>${f}</changefreq><priority>${pr}</priority></url>`)
  .join("\n")}\n</urlset>\n`;
fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);

console.log(`pack pages: ${packs.length} + index / sitemap urls: ${urls.length}`);
