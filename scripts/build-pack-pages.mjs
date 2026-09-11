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

const CARD_TYPE_LABEL = {
  word: "日本語訳を見て英単語を打つ",
  grammar: "英文の空欄に入る語を英語で打つ",
  school: "説明を読んで用語・人名・地名を日本語で答える（ひらがなでもOK）",
  concept: "場面の説明を読んで用語で答える（日本語OK）"
};

function sampleHtml(data, words) {
  const type = data.cardType ?? "concept";
  return words
    .map((w) => {
      if (type === "word") {
        return `<li class="pp-card"><span class="pp-card__q">${esc(w.ja)}${w.pos ? `<small>（${esc(w.pos)}）</small>` : ""}</span><span class="pp-card__a">${esc(w.en)}</span></li>`;
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
  <link rel="stylesheet" href="/css/layout.css" />
  <link rel="stylesheet" href="/css/game.css" />
  <link rel="stylesheet" href="/css/responsive.css" />
  <link rel="stylesheet" href="/css/theme.css" />
  <script>document.documentElement.dataset.theme = localStorage.getItem("spelldash_theme") === "dark" ? "dark" : "light";</script>
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
  <meta name="theme-color" content="#0f172a" />
  <link rel="icon" type="image/png" sizes="192x192" href="/assets/icons/icon-192.png" />
  <style>
    .pp { max-width: 760px; margin: 0 auto; padding: 0 16px 48px; }
    .pp-hero { padding: 28px 0 16px; }
    .pp-kicker { font-size: 12px; color: #64748b; margin: 0 0 6px; }
    .pp h1 { font-size: 26px; margin: 0 0 8px; line-height: 1.3; }
    .pp-lead { font-size: 15px; line-height: 1.7; margin: 0 0 6px; }
    .pp-meta { font-size: 13px; color: #64748b; margin: 0 0 16px; }
    .pp-cta { display: inline-block; padding: 12px 22px; border-radius: 999px; background: #2563eb; color: #fff; font-weight: 700; text-decoration: none; }
    .pp-cta:hover { background: #1d4ed8; }
    .pp-sub { margin-left: 12px; font-size: 13px; }
    .pp h2 { font-size: 17px; margin: 28px 0 10px; }
    .pp-genres { display: flex; flex-wrap: wrap; gap: 6px; padding: 0; margin: 0; list-style: none; }
    .pp-genres li { font-size: 12.5px; padding: 4px 10px; border-radius: 999px; border: 1px solid #cbd5e1; }
    .pp-cards { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; }
    .pp-card { display: grid; gap: 3px; padding: 10px 12px; border-radius: 12px; border: 1px solid #e2e8f0; background: #fff; }
    .pp-card__q { font-size: 14px; line-height: 1.6; }
    .pp-card__q small { color: #64748b; margin-left: 4px; }
    .pp-card__a { font-weight: 700; color: #1d4ed8; }
    .pp-card__ex { font-size: 12.5px; color: #475569; }
    .pp-how { font-size: 14px; line-height: 1.7; }
    .pp-how li { margin: 4px 0; }
    .pp-other { font-size: 13.5px; line-height: 1.9; }
    .pp-index h2 { margin-top: 24px; }
    .pp-index ul { padding-left: 18px; line-height: 1.9; }
    html[data-theme="dark"] .pp-kicker, html[data-theme="dark"] .pp-meta { color: #94a3b8; }
    html[data-theme="dark"] .pp-genres li { border-color: rgba(148,163,184,.35); }
    html[data-theme="dark"] .pp-card { background: rgba(15,23,42,.6); border-color: rgba(148,163,184,.25); }
    html[data-theme="dark"] .pp-card__a { color: #93c5fd; }
    html[data-theme="dark"] .pp-card__ex { color: #94a3b8; }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="site-header__inner">
      <a href="/" class="brand"><span class="brand__mark">SD</span><span class="brand__name">SpellDash</span></a>
      <nav class="site-nav" aria-label="メインナビ">
        <a href="/" class="site-nav__link">プレイ</a>
        <a href="/stats.html" class="site-nav__link">学習データ</a>
        <a href="/list.html" class="site-nav__link">単語帳</a>
        <a href="/battle.html" class="site-nav__link">バトル</a>
      </nav>
    </div>
  </header>
  <main class="pp">
${body}
  </main>
  <footer class="site-footer">
    <div class="site-footer__inner">
      <div class="site-footer__brand"><span class="brand__mark">SD</span><span class="brand__name">SpellDash</span></div>
      <p class="site-footer__tagline">思い出して打つから、残る。</p>
      <nav class="site-footer__nav" aria-label="フッターナビ">
        <a href="/news.html">お知らせ</a>
        <a href="/privacy.html">プライバシー</a>
        <a href="/packs/">分野パック一覧</a>
      </nav>
      <p class="site-footer__copy">© 2026 SpellDash</p>
    </div>
  </footer>
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
      const w = list.find((x) => x.level === lv && !sample.includes(x));
      if (w) sample.push(w);
      if (sample.length >= 8) break;
    }
    if (sample.length >= 8) break;
  }
  const genreCounts = [...byGenre.entries()].map(([tag, list]) => `<li>${esc(data.genres?.[tag] ?? tag)} <span>${list.length}</span></li>`).join("");
  const title = `${p.label}（${p.count}枚）| SpellDash 分野パック`;
  const description = `${p.blurb}。${p.audience}向け。${CARD_TYPE_LABEL[type]}。追加した人だけに出題され、思い出せなかった問題は復習の仕組みでまた出ます。`;
  const canonical = `${SITE}/packs/${p.id}.html`;
  const siblings = packs.filter((x) => x.group === p.group && x.id !== p.id).slice(0, 8);
  const body = `
    <section class="pp-hero">
      <p class="pp-kicker">${esc(p.group)} ・ 分野パック</p>
      <h1>${esc(p.label)}</h1>
      <p class="pp-lead">${esc(p.blurb)}</p>
      <p class="pp-meta">👤 ${esc(p.audience)} ・ ${p.count}枚 ・ ${esc(CARD_TYPE_LABEL[type])}</p>
      <a class="pp-cta" href="/list.html?add=${encodeURIComponent(p.id)}">＋ このパックを追加して始める</a>
      <a class="pp-sub" href="/packs/">他の分野を見る</a>
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
        <li>${esc(CARD_TYPE_LABEL[type])}。分からなければ Enter で答えを見て、数問後にもう一度出ます。</li>
        <li>自力で思い出せた語は復習の間隔が伸び、思い出せなかった語は近いうちにまた出ます（想起練習と間隔反復）。</li>
        <li>学習の記録は端末に保存され、ログインすると別の端末でも引き継げます。</li>
      </ul>
      <p><a class="pp-cta" href="/list.html?add=${encodeURIComponent(p.id)}">＋ このパックを追加して始める</a></p>
    </section>
    ${siblings.length ? `<section><h2>同じグループの分野</h2><p class="pp-other">${siblings.map((s) => `<a href="/packs/${s.id}.html">${esc(s.label)}</a>`).join(" ／ ")}</p></section>` : ""}
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
      <p class="pp-lead">仕事の共通言語、試験の語彙、学校の暗記もの。追加した分野だけがホームに出て、思い出して打つ・復習の仕組みで覚えられます。</p>
      <p class="pp-meta">${packs.length}パック ・ ${packs.reduce((n, p) => n + p.count, 0).toLocaleString("ja-JP")}枚</p>
      <a class="pp-cta" href="/list.html#packs">単語帳ページで追加する</a>
    </section>
    <section class="pp-index">
${[...groups.entries()].map(([g, list]) => `      <h2>${esc(g)}</h2>\n      <ul>${list.map((p) => `<li><a href="/packs/${p.id}.html">${esc(p.label)}</a> <small>${p.count}枚 ・ ${esc(p.blurb)}</small></li>`).join("")}</ul>`).join("\n")}
    </section>
  `;
fs.writeFileSync(
  path.join(OUT_DIR, "index.html"),
  pageShell({ title: "分野パック一覧 | SpellDash", description: "不動産・会計・医療・SaaS・英検・TOEIC・中学高校の教科など、SpellDash の学習パック一覧。追加した分野だけがホームに出ます。", canonical: `${SITE}/packs/`, body: indexBody })
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
  ["/privacy.html", "yearly", "0.2"]
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
  .map(([u, f, pr]) => `  <url><loc>${SITE}${u.replace(/&/g, "&amp;")}</loc><changefreq>${f}</changefreq><priority>${pr}</priority></url>`)
  .join("\n")}\n</urlset>\n`;
fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap);

console.log(`pack pages: ${packs.length} + index / sitemap urls: ${urls.length}`);
