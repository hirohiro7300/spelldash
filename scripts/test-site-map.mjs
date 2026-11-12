// 検索と導線の決まり（Batch 78 段 5a。創業者の決定 §7「主導線・ナビ・サイトマップ・検索の対象から外す」）の単体テスト。ブラウザなしで数秒で終わる:
//   node scripts/test-site-map.mjs
// 失敗が 1 つでもあれば終了コード 1。ファイルは書き換えない（読んだ文字列の写しを壊して流す。生成器のコマンドだけ一時の木に写す）。
// 確かめること:
//   1. sitemap.xml: 載るのは主導線（ホーム・学習状況・設定）とお知らせ・規約のページだけ（下の SITEMAP_PAGES）。noindex のページは載せない
//      （tokushoho.html は事業者の欄が埋まるまで noindex なので、その間は載らない）。載る URL のファイルがある
//   2. noindex: 検索から外すページ（battle・typing・typing-game・list・pro と packs/ の全ページ）にある。主導線とお知らせ・規約のページ（tokushoho を除く）には無い
//      （pro.html は加入画面として残し、検索には出さない。Batch 78 段 6・創業者の決定 3）
//   3. パックのページ: <head> の先頭で英単語のホーム（/?from=old）へ案内する（読み込みと描画の前。CSS より前）。生成器（scripts/build-pack-pages.mjs）の
//      --check が今の木で通り、写しの木でページを 1 枚古くすると落ちる
//   4. vercel.json: 読める。ホスト名の転送 3 つ（permanent: true）は前のまま先頭。/packs・/packs/…・/list.html・/typing.html・/typing-game.html・/battle.html は /?from=old へ
//      一時的（permanent: false。タイピングの 2 ページは Batch 78 段 6・創業者の決定 3: 古いお知らせのリンクは履歴のまま、開くと英単語のホームへ。Battle は Batch 78 段 7・
//      創業者の確認 2026-10-29 の 4）。ほかの URL（主導線・加入画面・Battle とタイピングの js と css と教材・data/packs/ の JSON・js/listView.js）は転送しない
//   5. ナビとフッター（ルートの 12 ページ〔admin.html を除く〕と packs/ の全ページ）: ナビは 4 つ「ホーム・英単語を学ぶ・学習状況・設定」で行き先は
//      /・/?learn=next・stats.html・profile.html。現在地はそのページのリンクだけ。フッターの一文は「ストレスなしで、英単語を覚える。」・ナビとフッターに
//      単語帳／Battle／タイピング／パック／Pro へのリンクが無い。js/footer.js はフッターに「SpellDash Pro」を差し込まない（js/proFunnel.js renderFooterPro を呼ばない）が、
//      受付中かどうかの控え（refreshBillingOpen）は前と同じ頁で取り直す（設定の「Pro について」などが読む。data-no-pro の頁〔タイピング練習〕と加入画面は前から取らない）
//   6. 写しを壊すと落ちる（決まりの検査そのものが効く）: sitemap に list.html を足す・tokushoho の noindex を外したのに sitemap に無い・battle と pro の noindex を消す・
//      パックのページの案内を消す・転送を permanent: true にする・転送の先を変える・転送が data/packs/ にも当たる・タイピングと Battle の転送を外す・ホスト名の転送を後ろへ回す・
//      ナビに単語帳を足す・ナビの順を替える・フッターにタイピング練習を戻す・footer.js で renderFooterPro を呼ぶ・控えを取り直さない・入口の門を消す／CSS の後へ回す／
//      旗（data-focus）を外す／行き先を変える／見張りより前に置く／見張りとの間に別の script を挟む・見張りを消す
//   7. 入口の門（Batch 78 段 7。創業者の確認 2026-10-29 の 4）: Battle・タイピング練習・タイピングゲームの 3 ページ（GATED_PAGES）は、記録の見張りの 1 行
//      （js/areaGuard.js と読めなかったときの 1 文。<head> の最初の同期の script。創業者の確認 2026-10-29「見張りは、ほかのアプリ用スクリプトより先に同期的に読み込む」・
//      単体 test-areas の U1）のすぐ後の <script>（id="focusGate"。見張りとの間は空白と注記だけ・ほかのどの <script> と <link>〔CSS・先読み〕より前）で、
//      旗（<html data-focus="english">）が立っていれば英単語のホーム（/?from=old）へ置き換える。配信の転送が効かないアプリの中でも止めるため。
//      3 ページの旗は js/focus.js FOCUS_ENGLISH と同じ（index.html・profile.html と同じ旗）。門は 3 ページで同じ文
//   8. CSP の script-src（Batch 88。docs/SECURITY.md）: 配る HTML 全部（.vercelignore と .git・node_modules を除いた木の *.html。今はルートと packs/）の
//      inline の script（src なし・type なしか module・text/javascript・application/javascript）の本文の sha256 を数え、vercel.json の全体のヘッダーの
//      Content-Security-Policy の script-src が「'self'・そのハッシュ全部（重ねない）・https://esm.sh」とちょうど同じ。'unsafe-inline'・'unsafe-eval'・
//      'unsafe-hashes'・'strict-dynamic' は無い。script-src のほかの指示は決めた字のまま（緩めない。締めるときはこの表も直す）。配る HTML の要素に
//      on* の属性（onclick= など）と javascript: の URL が 0。違うときは足りない・余ったハッシュと、そのハッシュの script があるファイルを出す
//      （inline の script を 1 字でも直したら、node scripts/lib/csp.mjs が出す script-src の値を vercel.json に写す）。写しを壊すと落ちる
//   9. 特定商取引法の表記（Batch 94。tokushoho.html）: 記入待ちの［ ］（注記の中は数えない）が残る間だけ noindex、残らなくなったら noindex も無い
//      （埋めたのに外し忘れると表記が検索に出ない・埋める前に外すと空欄が検索に出る）。今のファイルで通り、壊した写し 2 つ
//      （［ ］を埋めたのに noindex が残る・noindex を消したのに［ ］が残る）で落ちる。埋めて noindex を外した写しは通る
//   10. お知らせの頭の文（Batch 94 の直し。js/news.js の lead）: どの lead も 60 字以内（js/news.js の頭の決まり。お知らせの一覧は lead だけを見せる）。
//      字はコードポイントで数える（空白も 1 字）。lead の数がお知らせの数と同じ（読み落としが無い）。61 字の lead にした写しで落ちる
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { servedHtml, inlineScripts, scriptHash, cspDirectives } from "./lib/csp.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SCRIPTS, "..");
const SITE = "https://www.spelldash.net";
const OLD_URL_HOME = "/?from=old";

// sitemap に載せてよいページ（主導線と、お知らせ・規約）。載るのはこのうち noindex でないものだけ
const SITEMAP_PAGES = [["/", "index.html"], ["/stats.html", "stats.html"], ["/profile.html", "profile.html"], ["/news.html", "news.html"], ["/privacy.html", "privacy.html"], ["/terms.html", "terms.html"], ["/tokushoho.html", "tokushoho.html"]];
// 検索から外すページ（加入画面は直接開けば動く。単語帳とパックのページはページの守り、Battle とタイピングの 2 ページは入口の門、単語帳と Battle とタイピングの 2 ページは
// 配信の転送でホームへ案内する）
const HIDDEN_PAGES = ["battle.html", "typing.html", "typing-game.html", "list.html", "pro.html", "mywords.html", "slang.html", "shortcuts.html"]; // マイ単語帳（Batch 79）とスラング（Batch 80）とショートカットキー（Batch 92）は人の道具: noindex・sitemap に載せない
// 入口の門を持つページ（7）
const GATED_PAGES = ["battle.html", "typing.html", "typing-game.html"];
// 記録の見張りの 1 行（全ページの <head> の最初の script。scripts/test-areas.mjs の U1 の GUARD_LINE と同じ）。入口の門はこのすぐ後（7）
const GUARD_LINE = '<script src="/js/areaGuard.js"></script><script>window.SpellDashArea||(stop(),location.replace("/switch.html#back="+encodeURIComponent(location.pathname+location.search+location.hash)))</script>';
// ナビとフッターを持つルートのページ（admin.html は対象外: 創業者の決定 §7「CRM・管理画面は今回の対象外」）
const ROOT_PAGES = ["index.html", "stats.html", "list.html", "profile.html", "battle.html", "news.html", "terms.html", "privacy.html", "tokushoho.html", "pro.html", "typing.html", "typing-game.html", "mywords.html", "slang.html", "shortcuts.html"];
const NAV = [["ホーム", "/"], ["英単語を学ぶ", "/?learn=next"], ["学習状況", "stats.html"], ["設定", "profile.html"]];
const CURRENT = { "index.html": "ホーム", "stats.html": "学習状況", "profile.html": "設定" };
const TAGLINE = "ストレスなしで、英単語を覚える。";
// ナビとフッターに出してはいけない行き先（単語帳・Battle・タイピング・パック・Pro）
const HIDDEN_HREF = /(^|\/)(list\.html|battle\.html|typing\.html|typing-game\.html|pro\.html)([?#]|$)|(^|\/)packs(\/|$)/;

let passed = 0;
const failures = [];
function ok(name, cond, info = "") {
  if (cond) passed++;
  else failures.push(`${name}${info ? `\n    ${info}` : ""}`);
}
const show = (problems) => JSON.stringify(problems.slice(0, 6));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const isNoindex = (html) => /<meta name="robots" content="[^"]*noindex[^"]*"\s*\/?>/.test(html);
const packFiles = fs.readdirSync(path.join(ROOT, "packs")).filter((f) => f.endsWith(".html")).map((f) => `packs/${f}`);

// ── 決まりの検査（文字列を受け取り、問題の一覧を返す。写しを壊して効くかも見る） ─────────────────────────

// 1. sitemap: pages = { ファイル名: HTML }
function sitemapProblems(xml, pages) {
  const problems = [];
  if (!/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">\n[\s\S]*<\/urlset>\n$/.test(xml)) problems.push("sitemap.xml の形が違う");
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  const urls = xml.match(/<url>/g)?.length ?? 0;
  if (urls !== locs.length) problems.push(`<url> ${urls} と <loc> ${locs.length} の数が違う`);
  const want = SITEMAP_PAGES.filter(([, file]) => !isNoindex(pages[file] ?? "")).map(([u]) => `${SITE}${u}`);
  if (JSON.stringify(locs) !== JSON.stringify(want)) problems.push(`載る URL が違う: ${JSON.stringify(locs)} ≠ ${JSON.stringify(want)}`);
  if (new Set(locs).size !== locs.length) problems.push("同じ URL が 2 回");
  for (const loc of locs) {
    const entry = SITEMAP_PAGES.find(([u]) => `${SITE}${u}` === loc);
    if (!entry) continue;
    if (pages[entry[1]] === undefined) problems.push(`ファイルが無い: ${entry[1]}`);
    else if (isNoindex(pages[entry[1]])) problems.push(`noindex のページが載っている: ${entry[1]}`);
  }
  return problems;
}

// 2. noindex: pages = { ファイル名: HTML }
function noindexProblems(pages, packs) {
  const problems = [];
  for (const file of [...HIDDEN_PAGES, ...packs]) if (!isNoindex(pages[file] ?? "")) problems.push(`noindex が無い: ${file}`);
  for (const [, file] of SITEMAP_PAGES) if (file !== "tokushoho.html" && isNoindex(pages[file] ?? "")) problems.push(`主導線のページに noindex: ${file}`);
  return problems;
}

// 3. パックのページ: 頭の先頭（CSS より前）で /?from=old へ案内する
function packGuardProblems(file, html) {
  const head = html.slice(0, html.indexOf("</head>"));
  const guard = head.indexOf(`<script>location.replace(${JSON.stringify(OLD_URL_HOME)});</script>`);
  const css = head.indexOf('<link rel="stylesheet"');
  if (guard < 0) return [`ホームへの案内が無い: ${file}`];
  if (css >= 0 && guard > css) return [`ホームへの案内が CSS より後: ${file}`];
  return [];
}

// 7. 入口の門: pages = { ファイル名: HTML }、flagOn = js/focus.js FOCUS_ENGLISH
function gateProblems(pages, flagOn) {
  const problems = [];
  const gates = [];
  for (const file of GATED_PAGES) {
    const html = pages[file] ?? "";
    const head = html.slice(0, html.indexOf("</head>"));
    const tag = html.match(/^<html\b[^>]*>/m)?.[0] ?? "";
    if (/\sdata-focus="english"/.test(tag) !== flagOn) problems.push(`${file}: <html data-focus> が js/focus.js FOCUS_ENGLISH（${flagOn}）と違う`);
    const gate = head.match(/<script id="focusGate">[\s\S]*?<\/script>/)?.[0] ?? null;
    if (!gate) {
      problems.push(`${file}: 入口の門（<script id="focusGate">）が無い`);
      continue;
    }
    gates.push(gate);
    const guard = head.indexOf(GUARD_LINE);
    const at = head.indexOf(gate);
    if (guard < 0) problems.push(`${file}: 記録の見張りの 1 行が <head> に無い`);
    else if (head.indexOf("<script") !== guard) problems.push(`${file}: 記録の見張りの 1 行が <head> の最初の <script> でない`);
    else if (at < guard + GUARD_LINE.length || !/^(\s|<!--[\s\S]*?-->)*$/.test(head.slice(guard + GUARD_LINE.length, at))) problems.push(`${file}: 入口の門が見張りの 1 行のすぐ後（間は空白と注記だけ）でない`);
    const link = head.indexOf("<link");
    if (link >= 0 && link < at) problems.push(`${file}: 入口の門が <link>（CSS・先読み）より後`);
    if (!gate.includes(`location.replace(${JSON.stringify(OLD_URL_HOME)})`) || !gate.includes('"english"') || !/dataset\.focus|data-focus/.test(gate)) problems.push(`${file}: 入口の門が旗を見て ${OLD_URL_HOME} へ置き換えない`);
  }
  if (new Set(gates).size > 1) problems.push("入口の門の文が 3 ページで違う");
  return problems;
}

// 4. vercel.json の redirects: Vercel の source の書き方（path-to-regexp。:name は 1 区切り、:name* は 0 個以上の区切り、末尾の / は任意、大小文字は区別しない）
function sourceRegExp(source) {
  let re = "";
  for (const seg of source.split("/").slice(1)) {
    const m = seg.match(/^:(\w+)([*+?])?$/);
    if (!m) re += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    else if (m[2] === "*") re += "(?:/[^/]+)*";
    else if (m[2] === "+") re += "(?:/[^/]+)+";
    else if (m[2] === "?") re += "(?:/[^/]+)?";
    else re += "/[^/]+";
  }
  return new RegExp(`^${re}/?$`, "i");
}
// 最初に当たる規則（Vercel は redirects を上から試し、最初に当たったものを使う）。host の条件は has の type: host
function firstRedirect(redirects, pathname, host = "www.spelldash.net") {
  return redirects.find((r) => sourceRegExp(r.source).test(pathname) && (r.has ?? []).every((h) => h.type === "host" && h.value === host)) ?? null;
}
const HOST_REDIRECTS = ["spelldash.vercel.app", "spelldash-jzf8.vercel.app", "spelldash.net"];
const OLD_PATHS = ["/packs", "/packs/", "/packs/index.html", "/packs/ngsl01.html", "/packs/accounting.html", "/PACKS/ngsl01.html", "/list.html", "/list.html/", "/typing.html", "/typing.html/", "/TYPING.html", "/typing-game.html", "/typing-game.html/", "/battle.html", "/battle.html/", "/BATTLE.html"];
const KEEP_PATHS = ["/", "/index.html", "/stats.html", "/profile.html", "/news.html", "/terms.html", "/privacy.html", "/tokushoho.html", "/pro.html", "/admin.html", "/battle", "/battle.html.bak", "/js/battleView.js", "/css/battle.css", "/sitemap.xml", "/robots.txt", "/sw.js", "/data/packs/ngsl01.json", "/data/manifest.json", "/js/listView.js", "/js/packs.js", "/packs.html", "/list", "/listing.html", "/list.html.bak", "/api/billing/config",
  "/typing", "/typing-game", "/typing.html.bak", "/typing-long.html", "/js/typingPage.js", "/js/typingGamePage.js", "/css/typing.css", "/css/typing-game.css", "/data/typing.json", "/data/typing-game.json", "/assets/images/og-typing.png", "/assets/images/og-typing-game.png"];
function redirectProblems(text) {
  let conf;
  try {
    conf = JSON.parse(text);
  } catch (e) {
    return [`vercel.json が JSON でない: ${e.message}`];
  }
  const problems = [];
  const redirects = conf.redirects ?? [];
  // ホスト名の転送は先頭の 3 つのまま（spelldash.net/packs/… もまず www へ、その次の要求で /?from=old へ）
  HOST_REDIRECTS.forEach((host, i) => {
    const r = redirects[i];
    if (!r || r.source !== "/:path*" || r.destination !== "https://www.spelldash.net/:path*" || r.permanent !== true || JSON.stringify(r.has) !== JSON.stringify([{ type: "host", value: host }])) problems.push(`ホスト名の転送 ${i + 1}（${host}）が前と違う`);
  });
  for (const r of redirects) {
    try {
      sourceRegExp(r.source);
    } catch {
      problems.push(`読めない source: ${r.source}`);
    }
    if (typeof r.permanent !== "boolean") problems.push(`permanent が無い: ${r.source}`);
  }
  for (const p of OLD_PATHS) {
    const r = firstRedirect(redirects, p);
    if (!r || r.destination !== OLD_URL_HOME || r.permanent !== false) problems.push(`${p} → ${r ? `${r.destination}（permanent: ${r.permanent}）` : "転送なし"}（${OLD_URL_HOME} へ一時的に転送する）`);
  }
  for (const p of KEEP_PATHS) {
    const r = firstRedirect(redirects, p);
    if (r) problems.push(`${p} を転送している（${r.source} → ${r.destination}）`);
  }
  for (const host of HOST_REDIRECTS) {
    const r = firstRedirect(redirects, "/packs/ngsl01.html", host);
    if (!r || r.destination !== "https://www.spelldash.net/:path*") problems.push(`${host} の /packs/… はまず www へ`);
  }
  return problems;
}

// 5. ナビとフッター
function chromeProblems(file, html) {
  const problems = [];
  const nav = html.match(/<nav class="site-nav" aria-label="メインナビ">([\s\S]*?)<\/nav>/)?.[1];
  if (nav === undefined) return [`${file}: ナビが無い`];
  const links = [...nav.matchAll(/<a href="([^"]*)" class="site-nav__link"( aria-current="page")?>([^<]*)<\/a>/g)].map((m) => ({ href: m[1], current: !!m[2], label: m[3] }));
  const anchors = nav.match(/<a\b/g)?.length ?? 0;
  const base = (href) => href.replace(/^\.?\//, "");
  if (anchors !== 4 || links.length !== 4 || links.some((l, i) => l.label !== NAV[i][0] || base(l.href) !== base(NAV[i][1]))) problems.push(`${file}: ナビ ${JSON.stringify(links.map((l) => `${l.label}=${l.href}`))}`);
  const current = links.filter((l) => l.current).map((l) => l.label);
  const wantCurrent = CURRENT[file] ? [CURRENT[file]] : [];
  if (JSON.stringify(current) !== JSON.stringify(wantCurrent)) problems.push(`${file}: 現在地 ${JSON.stringify(current)} ≠ ${JSON.stringify(wantCurrent)}`);
  const footer = html.match(/<footer class="site-footer">([\s\S]*?)<\/footer>/)?.[1];
  if (footer === undefined) return [...problems, `${file}: フッターが無い`];
  const tagline = footer.match(/<p class="site-footer__tagline">\s*([^<]*?)\s*<\/p>/)?.[1];
  if (tagline !== TAGLINE) problems.push(`${file}: フッターの一文「${tagline}」`);
  for (const section of [nav, footer]) for (const m of section.matchAll(/<a\b[^>]*href="([^"]*)"/g)) if (HIDDEN_HREF.test(m[1].replace(/^https:\/\/www\.spelldash\.net/, ""))) problems.push(`${file}: 外した面へのリンク ${m[1]}`);
  for (const word of ["単語帳", "バトル", "タイピング", "Pro", "書斎", "学習データ"]) if ([nav, footer].some((s) => s.replace(/<[^>]*>/g, "").includes(word))) problems.push(`${file}: ナビかフッターに「${word}」`);
  return problems;
}

// 5. js/footer.js: フッターに Pro のリンクを差し込まない・受付中かどうかの控えは取り直す（data-no-pro の頁と加入画面を除く）
function footerScriptProblems(js) {
  const problems = [];
  const code = js.replace(/^\s*\/\/.*$/gm, ""); // 注釈の行は見ない
  if (/renderFooterPro\s*\(/.test(code)) problems.push("js/footer.js が renderFooterPro を呼ぶ（フッターに SpellDash Pro が出る）");
  if (!/refreshBillingOpen\s*\(\s*\)/.test(code)) problems.push("js/footer.js が受付中かどうかの控え（refreshBillingOpen）を取り直さない");
  if (!/hasAttribute\("data-no-pro"\)/.test(code) || !/\/pro\.html/.test(code)) problems.push("js/footer.js が data-no-pro の頁と加入画面を除いていない");
  return problems;
}

// 8. CSP の script-src（Batch 88）
// script-src のほかの指示（緩めない。締めるときはここも直す）
const CSP_OTHER = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' https://esm.sh https://sujvgwozsnzjsjmkcrnk.supabase.co wss://sujvgwozsnzjsjmkcrnk.supabase.co",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
];
function cspProblems(vercelJson, html) {
  const problems = [];
  let directives;
  try {
    directives = cspDirectives(vercelJson);
  } catch (e) {
    return [`vercel.json が JSON でない: ${e.message}`];
  }
  const scriptSrc = directives.find((d) => d.split(/\s+/)[0] === "script-src");
  if (!scriptSrc) return ["script-src が無い"];
  const others = directives.filter((d) => d !== scriptSrc);
  if (JSON.stringify(others) !== JSON.stringify(CSP_OTHER)) problems.push(`script-src のほかの指示が決めた字と違う: ${JSON.stringify(others)}`);
  const tokens = scriptSrc.split(/\s+/).slice(1);
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'", "'wasm-unsafe-eval'"]) if (tokens.includes(bad)) problems.push(`script-src に ${bad}`);
  if (tokens[0] !== "'self'" || tokens.at(-1) !== "https://esm.sh") problems.push(`script-src の頭が 'self'・終わりが https://esm.sh でない: ${tokens.slice(0, 1)}…${tokens.slice(-1)}`);
  const middle = tokens.slice(1, -1);
  const where = new Map();
  for (const [file, h] of Object.entries(html)) for (const body of inlineScripts(h)) {
    const hash = scriptHash(body);
    if (!where.has(hash)) where.set(hash, []);
    where.get(hash).push(file);
  }
  const notHash = middle.filter((t) => !/^'sha256-[A-Za-z0-9+/]{43}='$/.test(t));
  if (notHash.length) problems.push(`script-src の間にハッシュでない物: ${JSON.stringify(notHash)}`);
  if (new Set(middle).size !== middle.length) problems.push("script-src に同じハッシュが 2 回");
  const missing = [...where.keys()].filter((h) => !middle.includes(h));
  const extra = middle.filter((t) => t.startsWith("'sha256-") && !where.has(t));
  for (const h of missing) problems.push(`足りないハッシュ ${h}（${where.get(h).length} ファイル: ${where.get(h).slice(0, 3).join("・")}）`);
  for (const h of extra) problems.push(`余ったハッシュ ${h}（どの配る HTML の inline の script にも当たらない）`);
  // on* の属性と javascript: の URL（script の本文と注記は除いて、要素の開始タグの中だけを見る）
  for (const [file, h] of Object.entries(html)) {
    const tags = h.replace(/<!--[\s\S]*?-->/g, "").replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, "$1$2").match(/<[a-zA-Z][^>]*>/g) ?? [];
    for (const tag of tags) {
      const on = tag.match(/[\s"'\/]on[a-z]+\s*=/i);
      if (on) problems.push(`${file}: 要素に on* の属性 ${tag.slice(0, 80)}`);
      if (/javascript\s*:/i.test(tag)) problems.push(`${file}: javascript: の URL ${tag.slice(0, 80)}`);
    }
  }
  return problems;
}

// ── 今の木 ─────────────────────────
const pages = Object.fromEntries([...new Set([...ROOT_PAGES, ...SITEMAP_PAGES.map(([, f]) => f), ...packFiles])].map((f) => [f, read(f)]));
const sitemapXml = read("sitemap.xml");
const vercelText = read("vercel.json");

const sm = sitemapProblems(sitemapXml, pages);
ok("1. sitemap.xml は主導線とお知らせ・規約のページだけ（noindex のページは載せない）", sm.length === 0, show(sm));
const locs = [...sitemapXml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].replace(SITE, ""));
ok("1. 今の sitemap の URL は 6 つ（/・stats・profile・news・privacy・terms。tokushoho は noindex の間は載らない）", JSON.stringify(locs) === JSON.stringify(["/", "/stats.html", "/profile.html", "/news.html", "/privacy.html", "/terms.html"]) && isNoindex(pages["tokushoho.html"]), JSON.stringify(locs));
ok("1. sitemap に単語帳・パック・タイピング・Battle・Pro・旧い ?category= が無い", !/list\.html|\/packs\/|typing|battle|pro\.html|category=/.test(sitemapXml));
const ni = noindexProblems(pages, packFiles);
ok(`2. noindex: battle・typing・typing-game・list・pro と packs/ の ${packFiles.length} ページにある・主導線とお知らせ・規約に無い`, ni.length === 0 && packFiles.length >= 165, show(ni));
const guards = packFiles.flatMap((f) => packGuardProblems(f, pages[f]));
ok(`3. パックの ${packFiles.length} ページは頭の先頭（CSS より前）で ${OLD_URL_HOME} へ案内する`, guards.length === 0, show(guards));
const rd = redirectProblems(vercelText);
ok(`4. vercel.json: ホスト名の転送はそのまま先頭・/packs と /packs/… と /list.html と /typing.html・/typing-game.html・/battle.html は ${OLD_URL_HOME} へ一時的・ほかの ${KEEP_PATHS.length} の URL は転送しない`, rd.length === 0, show(rd));
const flagOn = /^export const FOCUS_ENGLISH = true;$/m.test(read("js/focus.js"));
const gp = gateProblems(pages, flagOn);
ok(`7. 入口の門: ${GATED_PAGES.join("・")} は記録の見張りの 1 行（<head> の最初の script）のすぐ後・ほかのどの <script> と <link> より前で旗を見て ${OLD_URL_HOME} へ置き換える・3 ページで同じ文・旗は js/focus.js FOCUS_ENGLISH と同じ（${flagOn}）`, gp.length === 0 && flagOn, show(gp));
const ch = [...ROOT_PAGES, ...packFiles].flatMap((f) => chromeProblems(f, pages[f]));
ok(`5. ナビは 4 つ（ホーム・英単語を学ぶ・学習状況・設定）・現在地・フッターの一文・data-no-pro・外した面へのリンクが無い（ルートの ${ROOT_PAGES.length} ページと packs/ の ${packFiles.length} ページ）`, ch.length === 0, show(ch));
const fj = footerScriptProblems(read("js/footer.js"));
ok("5. js/footer.js はフッターに SpellDash Pro を差し込まず、受付中かどうかの控えは取り直す（data-no-pro の頁〔タイピング練習の 2 つ〕と加入画面は前から取らない）", fj.length === 0 && ["typing.html", "typing-game.html"].every((f) => /<nav class="site-footer__nav" aria-label="フッターナビ" data-no-pro>/.test(pages[f])), show(fj));
ok("5. admin.html は対象外（触らない）", read("admin.html").includes('<a href="./battle.html" class="site-nav__link">バトル</a>'));
const served = servedHtml(ROOT);
const servedFiles = Object.keys(served);
const cp = cspProblems(vercelText, served);
const inlineCount = new Set(Object.values(served).flatMap((h) => inlineScripts(h).map(scriptHash))).size;
ok(`8. CSP: vercel.json の script-src は 'self'・配る HTML（${servedFiles.length} ファイル: ルートと packs/）の inline の script の sha256 全部（${inlineCount} 種類）・https://esm.sh だけ（'unsafe-inline' なし）・ほかの指示は決めた字のまま・on* の属性と javascript: の URL は 0`, cp.length === 0 && servedFiles.length >= 175 && servedFiles.includes("index.html") && servedFiles.includes("packs/ngsl01.html") && !servedFiles.some((f) => /^(tests|scripts|docs|ios|android|dist)\//.test(f)) && inlineCount >= 10, show(cp));

// 9. 間違えた URL の行き先（Batch 89 A6）: root の 404.html（配信は見つからない道でこれを返す）。noindex・sitemap に無い・ナビの 4 つとフッター（5 と同じ決まり。現在地なし）・
//    「ページが見つからない。」と「ホームへ」（href="/"）・入れ子の道（/a/b）でも読めるよう href と src は / か https:// か # で始まる・inline の script はほかの配るページと
//    同じ字（8 のハッシュの一覧を増やさない）・値段・加入・pro.html への道が無い
function notFoundProblems(html, others) {
  if (html === null) return ["404.html が無い"];
  const problems = [];
  if (!isNoindex(html)) problems.push("noindex が無い");
  if (/404\.html/.test(read("sitemap.xml"))) problems.push("sitemap に載っている");
  problems.push(...chromeProblems("404.html", html));
  const text = html.replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, " ");
  if (!/<h1[^>]*>\s*ページが見つからない。\s*<\/h1>/.test(html)) problems.push("見出し「ページが見つからない。」が無い");
  if (!/<a\b[^>]*href="\/"[^>]*>\s*ホームへ\s*<\/a>/.test(html)) problems.push("「ホームへ」（href=\"/\"）が無い");
  for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) if (!/^(\/|https:\/\/|#)/.test(m[1])) problems.push(`入れ子の道で外れる相対の道: ${m[1]}`);
  const otherBodies = new Set(Object.entries(others).filter(([f]) => f !== "404.html").flatMap(([, h]) => inlineScripts(h)));
  for (const body of inlineScripts(html)) if (!otherBodies.has(body)) problems.push(`ほかのページに無い inline の script（ハッシュの一覧が増える）: ${body.trim().slice(0, 40)}`);
  if (/pro\.html|円|¥|加入/.test(html) || /Pro/.test(text)) problems.push("値段・加入・Pro への道がある");
  return problems;
}
const notFoundHtml = fs.existsSync(path.join(ROOT, "404.html")) ? read("404.html") : null;
const nf = notFoundProblems(notFoundHtml, served);
ok("9. 404.html: ある・noindex・sitemap に無い・ナビの 4 つとフッター・「ページが見つからない。」と「ホームへ」・href と src は / から（入れ子の道でも読める）・inline の script はほかのページと同じ字・値段と加入の道なし", nf.length === 0 && servedFiles.includes("404.html"), show(nf));
if (notFoundHtml) {
  const broken = (name, html) => ok(`9. 壊すと落ちる: ${name}`, notFoundProblems(html, served).length > 0);
  broken("404.html の noindex を消す", notFoundHtml.replace(/<meta name="robots"[^>]*>/, ""));
  broken("404.html の CSS を相対の道にする", notFoundHtml.replace('href="/css/reset.css"', 'href="./css/reset.css"'));
  broken("404.html に新しい inline の script を足す", notFoundHtml.replace("</body>", "<script>console.log(1)</script>\n</body>"));
  broken("404.html に加入画面へのリンクを足す", notFoundHtml.replace("</main>", '<a href="/pro.html">SpellDash Pro</a></main>'));
  broken("404.html の「ホームへ」を消す", notFoundHtml.replace(/<a\b[^>]*href="\/"[^>]*>\s*ホームへ\s*<\/a>/, ""));
}

// 3. 生成器のコマンド: 今の木で --check が通る。写しの木でページを 1 枚古くすると --check は落ち、書き出すと元に戻る
{
  const out = execFileSync(process.execPath, [path.join(SCRIPTS, "build-pack-pages.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" });
  ok("3. node scripts/build-pack-pages.mjs --check は今の木で通る（packs/*.html と sitemap.xml が最新）", /最新/.test(out), out.trim());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spelldash-site-map-"));
  try {
    const copy = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(tmp, rel), { recursive: true });
    for (const rel of ["scripts/build-pack-pages.mjs", "data/manifest.json", "data/packs", "packs", "sitemap.xml", ...SITEMAP_PAGES.map(([, f]) => f)]) copy(rel);
    const page = path.join(tmp, "packs", "ngsl01.html");
    const before = fs.readFileSync(page, "utf8");
    fs.writeFileSync(page, before.replace('<meta name="robots" content="noindex" />\n', ""));
    let failedCheck = false;
    try {
      execFileSync(process.execPath, [path.join(tmp, "scripts", "build-pack-pages.mjs"), "--check"], { cwd: tmp, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      failedCheck = e.status === 1 && /packs\/ngsl01\.html/.test(String(e.stderr));
    }
    ok("3. 写しの木: パックのページを 1 枚古くすると --check は終了コード 1 でそのページを出す", failedCheck);
    execFileSync(process.execPath, [path.join(tmp, "scripts", "build-pack-pages.mjs")], { cwd: tmp, encoding: "utf8" });
    ok("3. 写しの木: 書き出すと元のページに戻る", fs.readFileSync(page, "utf8") === before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 6. 写しを壊すと落ちる ─────────────────────────
const mutate = (name, problems) => ok(`6. 壊すと落ちる: ${name}`, problems.length > 0);
mutate("sitemap に list.html を足す", sitemapProblems(sitemapXml.replace("</urlset>", `  <url><loc>${SITE}/list.html</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>\n</urlset>`), pages));
mutate("sitemap から学習状況を消す", sitemapProblems(sitemapXml.replace(/ {2}<url><loc>[^<]*\/stats\.html<\/loc>[^\n]*\n/, ""), pages));
mutate("tokushoho の noindex を外したのに sitemap に無い", sitemapProblems(sitemapXml, { ...pages, "tokushoho.html": pages["tokushoho.html"].replace(/<meta name="robots"[^>]*>/, "") }));
mutate("battle の noindex を消す", noindexProblems({ ...pages, "battle.html": pages["battle.html"].replace(/<meta name="robots"[^>]*>/, "") }, packFiles));
mutate("pro の noindex を消す", noindexProblems({ ...pages, "pro.html": pages["pro.html"].replace(/<meta name="robots"[^>]*>/, "") }, packFiles));
mutate("ホームに noindex を付ける", noindexProblems({ ...pages, "index.html": pages["index.html"].replace("<head>", '<head>\n  <meta name="robots" content="noindex" />') }, packFiles));
mutate("パックのページの案内を消す", packGuardProblems("packs/ngsl01.html", pages["packs/ngsl01.html"].replace(/ {2}<script>location\.replace\([^<]*<\/script>\n/, "")));
mutate("パックのページの案内を CSS の後へ", packGuardProblems("packs/ngsl01.html", pages["packs/ngsl01.html"].replace(/ {2}(<script>location\.replace\([^<]*<\/script>)\n/, "").replace("</head>", `  <script>location.replace("${OLD_URL_HOME}");</script>\n</head>`)));
const conf = JSON.parse(vercelText);
const withRedirects = (f) => JSON.stringify({ ...conf, redirects: f(structuredClone(conf.redirects)) });
mutate("転送を permanent: true にする", redirectProblems(withRedirects((rs) => rs.map((r) => (r.source === "/list.html" ? { ...r, permanent: true } : r)))));
mutate("転送の先を / にする", redirectProblems(withRedirects((rs) => rs.map((r) => (r.source.startsWith("/packs") ? { ...r, destination: "/" } : r)))));
mutate("/packs の転送を外す", redirectProblems(withRedirects((rs) => rs.filter((r) => r.source !== "/packs/:path*" && r.source !== "/packs"))));
mutate("タイピングゲームの転送を外す", redirectProblems(withRedirects((rs) => rs.filter((r) => r.source !== "/typing-game.html"))));
mutate("Battle の転送を外す", redirectProblems(withRedirects((rs) => rs.filter((r) => r.source !== "/battle.html"))));
mutate("Battle の転送を permanent: true にする", redirectProblems(withRedirects((rs) => rs.map((r) => (r.source === "/battle.html" ? { ...r, permanent: true } : r)))));
mutate("タイピング練習の転送を permanent: true にする", redirectProblems(withRedirects((rs) => rs.map((r) => (r.source === "/typing.html" ? { ...r, permanent: true } : r)))));
mutate("転送がタイピングの js・css・教材にも当たる", redirectProblems(withRedirects((rs) => [...rs, { source: "/:dir/:file", destination: OLD_URL_HOME, permanent: false }])));
mutate("加入画面を転送する", redirectProblems(withRedirects((rs) => [...rs, { source: "/pro.html", destination: OLD_URL_HOME, permanent: false }])));
mutate("転送が data/packs/ にも当たる", redirectProblems(withRedirects((rs) => [...rs, { source: "/:dir/packs/:path*", destination: OLD_URL_HOME, permanent: false }])));
mutate("ホスト名の転送を後ろへ回す", redirectProblems(withRedirects((rs) => [...rs.slice(3), ...rs.slice(0, 3)])));
mutate("vercel.json が壊れている", redirectProblems(vercelText.replace("{", "")));
mutate("ナビに単語帳を足す", chromeProblems("stats.html", pages["stats.html"].replace('<a href="./profile.html" class="site-nav__link">設定</a>', '<a href="./profile.html" class="site-nav__link">設定</a>\n        <a href="./list.html" class="site-nav__link">単語帳</a>')));
mutate("ナビの順を替える", chromeProblems("news.html", pages["news.html"].replace(/(<a href="\/\?learn=next" class="site-nav__link">英単語を学ぶ<\/a>)\n(\s*)(<a href="\.\/stats\.html" class="site-nav__link">学習状況<\/a>)/, "$3\n$2$1")));
mutate("現在地を外す", chromeProblems("index.html", pages["index.html"].replace(' aria-current="page">ホーム', ">ホーム")));
mutate("フッターにタイピング練習を戻す", chromeProblems("terms.html", pages["terms.html"].replace('<a href="./news.html">お知らせ</a>', '<a href="./typing.html">タイピング練習</a>\n        <a href="./news.html">お知らせ</a>')));
const footerJs = read("js/footer.js");
mutate("footer.js で renderFooterPro を呼ぶ", footerScriptProblems(footerJs.replace("refreshBillingOpen();", "refreshBillingOpen();\n  renderFooterPro();")));
mutate("footer.js が控えを取り直さない", footerScriptProblems(footerJs.replace(/^ *if \(footerNav[^\n]*refreshBillingOpen\(\);$/m, "")));
const gateOf = (f) => pages[f].match(/<script id="focusGate">[\s\S]*?<\/script>\n?/)?.[0] ?? "<script id=\"focusGate\"></script>";
mutate("Battle の入口の門を消す", gateProblems({ ...pages, "battle.html": pages["battle.html"].replace(gateOf("battle.html"), "") }, true));
mutate("タイピング練習の入口の門を CSS の後へ回す", gateProblems({ ...pages, "typing.html": pages["typing.html"].replace(gateOf("typing.html"), "").replace("</head>", `${gateOf("typing.html")}</head>`) }, true));
mutate("タイピングゲームの旗（data-focus）を外す", gateProblems({ ...pages, "typing-game.html": pages["typing-game.html"].replace(' data-focus="english"', "") }, true));
mutate("旗を外したのに 3 ページに旗が残る", gateProblems(pages, false));
mutate("Battle の入口の門の行き先を変える", gateProblems({ ...pages, "battle.html": pages["battle.html"].replace(`location.replace("${OLD_URL_HOME}")`, 'location.replace("/")') }, true));
mutate("Battle の入口の門を見張りの 1 行より前に置く", gateProblems({ ...pages, "battle.html": pages["battle.html"].replace(gateOf("battle.html"), "").replace(GUARD_LINE, `${gateOf("battle.html")}${GUARD_LINE}`) }, true));
mutate("タイピングゲームの見張りと門の間に別の script を挟む", gateProblems({ ...pages, "typing-game.html": pages["typing-game.html"].replace(GUARD_LINE, `${GUARD_LINE}\n  <script>document.documentElement.dataset.x = "1";</script>`) }, true));
mutate("タイピング練習の見張りの 1 行を消す", gateProblems({ ...pages, "typing.html": pages["typing.html"].replace(GUARD_LINE, "") }, true));
mutate("Battle の門の前の見張りを CSS の後へ回す（門が最初の script になる）", gateProblems({ ...pages, "battle.html": pages["battle.html"].replace(GUARD_LINE, "").replace("</head>", `${GUARD_LINE}</head>`) }, true));
mutate("フッターの一文を前に戻す", chromeProblems("packs/ngsl01.html", pages["packs/ngsl01.html"].replace(TAGLINE, "タイピングで、英単語を体に覚えさせる。")));

// 8. CSP（Batch 88）: 写しを壊すと落ちる
const withCsp = (f) => {
  const conf = JSON.parse(vercelText);
  for (const h of conf.headers.find((x) => x.source === "/(.*)").headers) if (h.key === "Content-Security-Policy") h.value = f(h.value);
  return JSON.stringify(conf);
};
const firstHash = (v) => v.match(/'sha256-[^']+'/)?.[0] ?? "";
mutate("script-src に 'unsafe-inline' を戻す", cspProblems(withCsp((v) => v.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")), served));
mutate("script-src からハッシュを 1 つ消す", cspProblems(withCsp((v) => v.replace(`${firstHash(v)} `, "")), served));
mutate("script-src に余ったハッシュを足す", cspProblems(withCsp((v) => v.replace("https://esm.sh;", `'sha256-${"A".repeat(43)}=' https://esm.sh;`)), served));
mutate("script-src に同じハッシュを 2 回", cspProblems(withCsp((v) => v.replace(firstHash(v), `${firstHash(v)} ${firstHash(v)}`)), served));
mutate("ページの inline の script を 1 字変える（ハッシュを直さない）", cspProblems(vercelText, { ...served, "news.html": served["news.html"].replace("renderNews", "renderNews ") }));
mutate("パックのページの inline の script を 1 字変える", cspProblems(vercelText, { ...served, "packs/ngsl01.html": served["packs/ngsl01.html"].replace('location.replace("/?from=old");', 'location.replace("/?from=old"); ') }));
mutate("ページに inline の on* の属性（onclick）を足す", cspProblems(vercelText, { ...served, "terms.html": served["terms.html"].replace("<body", '<body onload="x()"') }));
mutate("ページに javascript: の URL を足す", cspProblems(vercelText, { ...served, "privacy.html": served["privacy.html"].replace('<a href="./news.html">', '<a href="javascript:void(0)">') }));
mutate("connect-src を緩める（https: を足す）", cspProblems(withCsp((v) => v.replace("connect-src 'self'", "connect-src 'self' https:")), served));
mutate("script-src に外の先を足す", cspProblems(withCsp((v) => v.replace("https://esm.sh;", "https://esm.sh https://cdn.example.com;")), served));
mutate("script-src に 'unsafe-eval' を足す", cspProblems(withCsp((v) => v.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")), served));
mutate("frame-ancestors を消す", cspProblems(withCsp((v) => v.replace(" frame-ancestors 'none';", "")), served));
mutate("新しいページの inline の script（ハッシュを足していない）", cspProblems(vercelText, { ...served, "new-page.html": "<!doctype html><script>console.log(1)</script>" }));
ok("8. 壊すと落ちる: 足りないハッシュはそのハッシュとファイルの名前を出す", cspProblems(vercelText, { ...served, "news.html": served["news.html"].replace("renderNews", "renderNews ") }).some((p) => /^足りないハッシュ 'sha256-[^']+'（1 ファイル: news\.html）$/.test(p)));
ok("8. 壊すと落ちる: 消したハッシュは「余った」ではなく「足りない」と出す", cspProblems(withCsp((v) => v.replace(`${firstHash(v)} `, "")), served).every((p) => p.startsWith("足りないハッシュ")));

// ── 9. 特定商取引法の表記: 記入待ちの［ ］と noindex は組（Batch 94）─────────────────────────
// 記入待ちは注記（<!-- … -->）の外の［…］。頭の注記の「［ ］が埋まるまで…」は数えない（埋めた後も注記が残っていてよい）
function tokushohoProblems(html) {
  const blanks = (html.replace(/<!--[\s\S]*?-->/g, "").match(/［[^］\n]*］/g) ?? []).length;
  const noindex = isNoindex(html);
  if (blanks > 0 && !noindex) return [`記入待ちの［ ］が ${blanks} つ残るのに noindex が無い（空欄が検索に出る）`];
  if (blanks === 0 && noindex) return ["記入待ちの［ ］が無いのに noindex が残る（埋めた表記が検索に出ない）"];
  return [];
}
{
  const html = pages["tokushoho.html"];
  const blanksNow = (html.replace(/<!--[\s\S]*?-->/g, "").match(/［[^］\n]*］/g) ?? []).length;
  const tp = tokushohoProblems(html);
  ok(`9. 特商法の表記: 今の tokushoho.html は記入待ちの［ ］（${blanksNow} つ）と noindex がそろう`, tp.length === 0 && blanksNow > 0 && isNoindex(html), show(tp));
  const filled = html.replace(/［[^］\n]*］/g, "試しの記入"); // 頭の注記の［ ］も置き換わるが、注記は数えないので同じ
  const filledKeepNote = html.replace(/(<dd>[^<]*?)［[^］\n]*］/g, "$1試しの記入"); // 欄だけ埋めて、頭の注記の［ ］は残す
  const unindexed = (h) => h.replace(/\n?\s*<meta name="robots"[^>]*>/, "");
  const broken = (name, problems) => ok(`9. 壊すと落ちる: ${name}`, problems.length > 0);
  broken("特商法の［ ］を埋めたのに noindex が残る", tokushohoProblems(filled));
  broken("特商法の欄を埋めたのに noindex が残る（頭の注記の［ ］はそのまま）", tokushohoProblems(filledKeepNote));
  broken("特商法の noindex を消したのに［ ］が残る", tokushohoProblems(unindexed(html)));
  const done = tokushohoProblems(unindexed(filledKeepNote));
  ok("9. 特商法の表記: 欄を埋めて noindex を外した写し（頭の注記は残る）は通る", done.length === 0 && !isNoindex(unindexed(filledKeepNote)), show(done));
}

// ── 10. お知らせの頭の文は 60 字以内（Batch 94 の直し。js/news.js の頭の決まり）─────────────────────────
// src は js/news.js の文。lead の字（JSON と同じ書き方の文字列）を読み、60 字を超える lead と、お知らせ（date の欄）と lead の数の違いを返す
const NEWS_LEAD_MAX = 60;
function newsLeadProblems(src) {
  const leads = [...src.matchAll(/\blead:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  const entries = (src.match(/\bdate:\s*"/g) ?? []).length;
  const problems = leads.filter((s) => [...s].length > NEWS_LEAD_MAX).map((s) => `${[...s].length} 字: ${[...s].slice(0, 24).join("")}…`);
  if (leads.length !== entries) problems.push(`lead が ${leads.length} 個・お知らせが ${entries} 件`);
  return problems;
}
{
  const src = read("js/news.js");
  const np = newsLeadProblems(src);
  ok(`10. お知らせの頭の文: どの lead も ${NEWS_LEAD_MAX} 字以内（${(src.match(/\bdate:\s*"/g) ?? []).length} 件）`, np.length === 0, show(np));
  const firstLead = (n) => src.replace(/(\blead:\s*")(?:[^"\\]|\\.)*"/, `$1${"字".repeat(n)}"`);
  ok("10. 壊すと落ちる: 最初の lead を 61 字にする", newsLeadProblems(firstLead(NEWS_LEAD_MAX + 1)).length > 0);
  ok("10. 最初の lead を 60 字ちょうどにした写しは通る（境は 60 字まで）", newsLeadProblems(firstLead(NEWS_LEAD_MAX)).length === 0, show(newsLeadProblems(firstLead(NEWS_LEAD_MAX))));
}

if (failures.length) {
  console.error(`✗ ${failures.length} 件\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ 検索と導線の決まり: ${passed} 件`);
