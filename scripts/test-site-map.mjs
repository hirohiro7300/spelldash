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
//   4. vercel.json: 読める。ホスト名の転送 3 つ（permanent: true）は前のまま先頭。/packs・/packs/…・/list.html・/typing.html・/typing-game.html は /?from=old へ
//      一時的（permanent: false。タイピングの 2 ページは Batch 78 段 6・創業者の決定 3: 古いお知らせのリンクは履歴のまま、開くと英単語のホームへ）。
//      ほかの URL（主導線・Battle・加入画面・タイピングの js と css と教材・data/packs/ の JSON・js/listView.js）は転送しない
//   5. ナビとフッター（ルートの 12 ページ〔admin.html を除く〕と packs/ の全ページ）: ナビは 4 つ「ホーム・英単語を学ぶ・学習状況・設定」で行き先は
//      /・/?learn=next・stats.html・profile.html。現在地はそのページのリンクだけ。フッターの一文は「ストレスなしで、英単語を覚える。」・ナビとフッターに
//      単語帳／Battle／タイピング／パック／Pro へのリンクが無い。js/footer.js はフッターに「SpellDash Pro」を差し込まない（js/proFunnel.js renderFooterPro を呼ばない）が、
//      受付中かどうかの控え（refreshBillingOpen）は前と同じ頁で取り直す（設定の「Pro について」などが読む。data-no-pro の頁〔タイピング練習〕と加入画面は前から取らない）
//   6. 写しを壊すと落ちる（決まりの検査そのものが効く）: sitemap に list.html を足す・tokushoho の noindex を外したのに sitemap に無い・battle と pro の noindex を消す・
//      パックのページの案内を消す・転送を permanent: true にする・転送の先を変える・転送が data/packs/ にも当たる・タイピングの転送を外す・ホスト名の転送を後ろへ回す・
//      ナビに単語帳を足す・ナビの順を替える・フッターにタイピング練習を戻す・footer.js で renderFooterPro を呼ぶ・控えを取り直さない
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SCRIPTS, "..");
const SITE = "https://www.spelldash.net";
const OLD_URL_HOME = "/?from=old";

// sitemap に載せてよいページ（主導線と、お知らせ・規約）。載るのはこのうち noindex でないものだけ
const SITEMAP_PAGES = [["/", "index.html"], ["/stats.html", "stats.html"], ["/profile.html", "profile.html"], ["/news.html", "news.html"], ["/privacy.html", "privacy.html"], ["/terms.html", "terms.html"], ["/tokushoho.html", "tokushoho.html"]];
// 検索から外すページ（Battle と加入画面は直接開けば動く。単語帳とパックのページはページの守り、単語帳とタイピングの 2 ページは配信の転送でホームへ案内する）
const HIDDEN_PAGES = ["battle.html", "typing.html", "typing-game.html", "list.html", "pro.html"];
// ナビとフッターを持つルートのページ（admin.html は対象外: 創業者の決定 §7「CRM・管理画面は今回の対象外」）
const ROOT_PAGES = ["index.html", "stats.html", "list.html", "profile.html", "battle.html", "news.html", "terms.html", "privacy.html", "tokushoho.html", "pro.html", "typing.html", "typing-game.html"];
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
const OLD_PATHS = ["/packs", "/packs/", "/packs/index.html", "/packs/ngsl01.html", "/packs/accounting.html", "/PACKS/ngsl01.html", "/list.html", "/list.html/", "/typing.html", "/typing.html/", "/TYPING.html", "/typing-game.html", "/typing-game.html/"];
const KEEP_PATHS = ["/", "/index.html", "/stats.html", "/profile.html", "/news.html", "/terms.html", "/privacy.html", "/tokushoho.html", "/pro.html", "/battle.html", "/admin.html", "/sitemap.xml", "/robots.txt", "/sw.js", "/data/packs/ngsl01.json", "/data/manifest.json", "/js/listView.js", "/js/packs.js", "/packs.html", "/list", "/listing.html", "/list.html.bak", "/api/billing/config",
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
ok(`4. vercel.json: ホスト名の転送はそのまま先頭・/packs と /packs/… と /list.html と /typing.html・/typing-game.html は ${OLD_URL_HOME} へ一時的・ほかの ${KEEP_PATHS.length} の URL は転送しない`, rd.length === 0, show(rd));
const ch = [...ROOT_PAGES, ...packFiles].flatMap((f) => chromeProblems(f, pages[f]));
ok(`5. ナビは 4 つ（ホーム・英単語を学ぶ・学習状況・設定）・現在地・フッターの一文・data-no-pro・外した面へのリンクが無い（ルートの ${ROOT_PAGES.length} ページと packs/ の ${packFiles.length} ページ）`, ch.length === 0, show(ch));
const fj = footerScriptProblems(read("js/footer.js"));
ok("5. js/footer.js はフッターに SpellDash Pro を差し込まず、受付中かどうかの控えは取り直す（data-no-pro の頁〔タイピング練習の 2 つ〕と加入画面は前から取らない）", fj.length === 0 && ["typing.html", "typing-game.html"].every((f) => /<nav class="site-footer__nav" aria-label="フッターナビ" data-no-pro>/.test(pages[f])), show(fj));
ok("5. admin.html は対象外（触らない）", read("admin.html").includes('<a href="./battle.html" class="site-nav__link">バトル</a>'));

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
mutate("フッターの一文を前に戻す", chromeProblems("packs/ngsl01.html", pages["packs/ngsl01.html"].replace(TAGLINE, "タイピングで、英単語を体に覚えさせる。")));

if (failures.length) {
  console.error(`✗ ${failures.length} 件\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ 検索と導線の決まり: ${passed} 件`);
