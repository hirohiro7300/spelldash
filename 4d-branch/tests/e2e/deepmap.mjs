// E2E: 3 か月ごとの地図（版 7）の見取り図・手の詳しい画面・道の画面・年月の目盛り・時間で区切って開く・新しい地図の知らせ・
// 組み立てた本文を、地図を入れたページ（PAGE_Q のビルド）の #demo-q で確かめる（作業メモ SPEC v1 §5・§4.4・§11）
//   npm run e2e:deepmap
//   IMPACT_Q_BUNDLE: 地図の同梱データ（impact-q.b64）。無ければ作業メモの deepmap/gen/r7/impact-q.b64
//   VITE_IMPACT_Q=1 で作業用のフォルダ（DEEPMAP_DIST。既定は OS の一時フォルダの下）にビルドし、vite preview で開く（E2E_PORT。既定 4540）。
//   DEEPMAP_DIST にビルド済みのフォルダを渡すと、そのまま使う。スマホ（390×844・タッチ）と机（1440×900）で同じ確かめをする。
//   DEEPMAP_SHOTS にフォルダを渡すと、確かめの途中の画面を撮って残す（deviceScaleFactor 1）。DEEPMAP_PROFILE=390 か 1440 で片方だけ。
//   PW_CHROMIUM でブラウザの場所
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.E2E_PORT || 4540);
const BASE = `http://localhost:${PORT}/`;
const SCRATCH = "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap";
const BUNDLE = process.env.IMPACT_Q_BUNDLE || path.join(SCRATCH, "gen", "r7", "impact-q.b64");
const DIST = process.env.DEEPMAP_DIST || path.join(os.tmpdir(), "4d-branch-deepmap-dist");
const SHOTS = process.env.DEEPMAP_SHOTS || "";
const ONLY = process.env.E2E_ONLY || "";

function build() {
  if (process.env.DEEPMAP_DIST && fs.existsSync(path.join(DIST, "index.html"))) return;
  if (!fs.existsSync(BUNDLE)) throw new Error(`地図の同梱データがありません: ${BUNDLE}（IMPACT_Q_BUNDLE で渡してください）`);
  console.log(`ビルド（VITE_IMPACT_Q=1・${BUNDLE}）→ ${DIST}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", DIST, "--emptyOutDir", "--logLevel", "error"], {
    cwd: ROOT,
    env: { ...process.env, VITE_IMPACT_Q: "1", IMPACT_Q_BUNDLE: BUNDLE },
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("ビルドに失敗しました");
}

let server = null;
async function startServer() {
  if (await fetch(BASE).then(() => true, () => false)) throw new Error(`ポート ${PORT} では別のサーバーがもう答えています（E2E_PORT で変えられます）`);
  server = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  let exited = false;
  server.on("exit", () => (exited = true));
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error(`preview サーバーが起動しません（ポート ${PORT}）`);
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* まだ */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("preview サーバーが起動しません");
}

const results = [];
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 5).join("\n      ")}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
const settle = (page, ms = 250) => page.evaluate((t) => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), t)), ms);

/** #demo-q を開き、地図とパネルができるまで待つ。seedSheet: 新しい地図の知らせを見せた版を設定に入れておく（知らせは出ない） */
async function open(browser, profile, opts = {}) {
  const ctx = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: 1, isMobile: profile.mobile, hasTouch: profile.mobile });
  if (opts.seedSheet) {
    await ctx.addInitScript((rel) => {
      try {
        localStorage.setItem("4d-branch:prefs", JSON.stringify({ releaseSheet: rel, onboardingDone: true }));
      } catch {
        /* about:blank など */
      }
    }, opts.seedSheet);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${BASE}#demo-q`);
  await page.waitForFunction(() => !!window.__fourD?.app?.vm?.deep?.get(), null, { timeout: 120_000, polling: 200 });
  const n = await page.evaluate(() => window.__fourD.app.vm.nodeCount);
  assert(n > 50_000, `地図のカードが少なすぎる（${n} 枚）。PAGE_Q のビルドではないかもしれない`);
  await settle(page, 500);
  return { ctx, page, errors };
}

/** 横にはみ出していないか（ページと、右のパネルの中） */
async function noOverflow(page, where) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    // 右のパネルは開いているときだけ（閉じた引き出しは幅 0 で隠れている）
    const open = !document.querySelector(".app-shell")?.classList.contains("right-closed");
    const sc = open ? document.querySelector(".sidebar-right .insp-body-scroll") : null;
    return { page: doc.scrollWidth - window.innerWidth, panel: sc ? sc.scrollWidth - sc.clientWidth : 0 };
  });
  assert(r.page <= 1, `${where}: ページが横にはみ出している（${r.page}px）`);
  assert(r.panel <= 1, `${where}: 右のパネルの中が横にはみ出している（${r.panel}px）`);
}

/** 新しい地図の知らせを「見取り図を見る」で閉じる（出ていれば） */
async function closeSheet(page) {
  const btn = page.locator(".rel-sheet").getByRole("button", { name: "見取り図を見る" });
  if (await btn.count()) {
    await btn.click();
    await page.waitForFunction(() => !document.querySelector(".modal-backdrop:not(.closing)"));
    await settle(page);
  }
}

const deepPage = (page) => page.evaluate(() => window.__fourD.ui.deepPage);

async function runProfile(browser, profile) {
  const tag = profile.name;
  console.log(`\n[${tag}] ${profile.viewport.width}×${profile.viewport.height}${profile.mobile ? "・タッチ" : ""}`);
  const { ctx, page, errors } = await open(browser, profile);
  try {
    await check(`${tag}: 新しい地図の知らせ（版 7）が出る（12 段・2,000 の分かれ道・2 年の進め方・差の表 10 行・2 つのボタン）`, async () => {
      const sheet = page.locator(".rel-sheet");
      await sheet.waitFor({ timeout: 10_000 });
      const text = await sheet.innerText();
      for (const w of ["12 回の判断", "2029 年 11 月", "2,000 の分かれ道", "2 年の進め方は無くなった", "今やる場合と、3 か月待ってから選ぶ場合の、3 年の稼ぎの差"]) assert(text.includes(w), `知らせに「${w}」が無い`);
      const rows = await sheet.locator(".rel-table tbody tr").count();
      assert(rows === 10, `差の表が 10 行でない（${rows}）`);
      assert((await sheet.getByRole("button", { name: "見取り図を見る" }).count()) === 1, "「見取り図を見る」が無い");
      assert((await sheet.getByRole("button", { name: "一番ありそうな道を読む" }).count()) === 1, "「一番ありそうな道を読む」が無い");
      await shot(page, `${tag}-01-release-sheet`);
      await noOverflow(page, "知らせ");
      await closeSheet(page);
      const rel = await page.evaluate(() => window.__fourD.ui.prefs.releaseSheet);
      assert(rel === 7, `見せた版が設定に入っていない（${rel}）`);
    });

    await check(`${tag}: 知らせは 1 度だけ（閉じた後に選ぶ・パネルを開け閉めしても出ない。見せた版が設定にあれば最初から出ない）`, async () => {
      await page.evaluate(() => {
        const f = window.__fourD;
        f.ui.select([f.app.vm.impact.root]);
        f.ui.setPrefs({ rightOpen: false });
        f.ui.setPrefs({ rightOpen: true });
        f.ui.clearSelection();
      });
      await settle(page, 900);
      assert((await page.locator(".rel-sheet").count()) === 0, "知らせがもう一度出た");
      const again = await open(browser, profile, { seedSheet: 7 });
      try {
        await settle(again.page, 1200);
        assert((await again.page.locator(".rel-sheet").count()) === 0, "見せた版が設定にあるのに知らせが出た");
      } finally {
        await again.ctx.close();
      }
    });

    await check(`${tag}: 見取り図が概要の先頭にある（10 の手をひと目で・10 行・読み方・今やる vs 3 か月待つ）`, async () => {
      await page.evaluate(() => window.__fourD.ui.clearSelection());
      await settle(page);
      const ov = page.locator(".sidebar-right .deep-ov");
      await ov.waitFor();
      assert(await ov.isVisible(), "見取り図が見えていない");
      const first = await page.evaluate(() => document.querySelector(".sidebar-right .insp-body-scroll .insp-overview")?.firstElementChild?.classList.contains("deep-ov"));
      assert(first, "見取り図が概要の先頭でない");
      assert((await ov.locator(".dm-glance-row").count()) === 10, "ひと目の行が 10 でない");
      assert((await ov.locator(".dm-row").count()) === 10, "手の行が 10 でない");
      const text = await ov.innerText();
      for (const w of ["3 年の見取り図", "3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる", "今やる vs 3 か月待つ", "この 3 か月は今のまま"]) assert(text.includes(w), `見取り図に「${w}」が無い`);
      await shot(page, `${tag}-02-overview`);
      await noOverflow(page, "見取り図");
    });

    await check(`${tag}: 手を押すと、パネルに手の詳しい画面（扇・分かれ道の帯・進め方・行き先の種類・判断と行き先の数）`, async () => {
      await page.locator(".sidebar-right .deep-ov .dm-glance-row").first().click();
      await page.locator(".sidebar-right .deep-page.is-move").waitFor();
      const pg = await deepPage(page);
      assert(pg?.kind === "move", `手の詳しい画面になっていない（${JSON.stringify(pg)}）`);
      const mv = page.locator(".sidebar-right .deep-page.is-move");
      for (const sel of [".dm-card-fan svg", ".dm-card-strip", ".dm-card-plan", ".dm-card-dest"]) assert((await mv.locator(sel).count()) > 0, `手の詳しい画面に ${sel} が無い`);
      const text = await mv.innerText();
      assert(/判断 [\d,]+ 回/.test(text) && text.includes("出来事の分かれ"), "判断と出来事の分かれの数が無い");
      assert(text.includes("一番ありそうな道"), "一番ありそうな道のボタンが無い");
      assert(await page.evaluate(() => location.hash === "#demo-q"), "ページの # が変わった");
      await shot(page, `${tag}-03-move`);
      await noOverflow(page, "手の詳しい画面");
    });

    await check(`${tag}: 一番ありそうな道（パネルの中の縦の道。地図の横の列ではない）→ 行を開いてほかの結果に切り替える`, async () => {
      const mv = page.locator(".sidebar-right .deep-page.is-move");
      await mv.locator("a.dm-btn", { hasText: "一番ありそうな道" }).first().click();
      await page.locator(".sidebar-right .deep-page.is-path").waitFor();
      const p0 = await deepPage(page);
      assert(p0?.kind === "path", "道の画面になっていない");
      const path = page.locator(".sidebar-right .deep-page.is-path");
      const items = await path.locator(".dm-tl > li").count();
      assert(items >= 8, `道の行が少ない（${items}）`);
      assert((await path.locator(".dm-tl-end").count()) === 1, "着いた所のカードが無い");
      const end = await path.locator(".dm-tl-end").innerText();
      assert(end.includes("2029 年 11 月"), "着いた所が 2029 年 11 月でない");
      // 狭い画面: 地図の横の列（8,000 px）を開くボタンは出さない（道の画面で読む: user-7）
      const mapBtn = await path.getByRole("button", { name: "地図でこの道をひらく" }).count();
      assert(profile.mobile ? mapBtn === 0 : mapBtn === 1, `「地図でこの道をひらく」の数が違う（${mapBtn}）`);
      await shot(page, `${tag}-04-path`);
      // 2 行目（今日の手の結果の後の判断）を開いて、ほかの結果か手を押す
      const head = path.locator(".dm-tl > li.is-step .dm-tl-head").nth(1);
      await head.click();
      await settle(page);
      const alt = path.locator("li.is-open a.dm-alt").first();
      assert((await alt.count()) === 1, "開いた行に、ほかの結果・手が無い");
      await alt.click();
      await page.waitForFunction((n) => window.__fourD.ui.deepPage?.kind === "path" && window.__fourD.ui.deepPage.node !== n, p0.node);
      await settle(page);
      const p1 = await deepPage(page);
      assert(p1.node !== p0.node, "道が切り替わっていない");
      assert((await page.locator(".sidebar-right .deep-page.is-path .dm-tl-flag").count()) >= 1, "切り替えた行の印が無い");
      assert(await page.evaluate(() => location.hash === "#demo-q"), "ページの # が変わった");
      await shot(page, `${tag}-05-path-switched`);
      await noOverflow(page, "道の画面");
      if (!profile.mobile) {
        // 広い画面: 地図でこの道をひらく（今日から道の終わりまでの判断と手を開き、終わりのカードを選ぶ。道の画面は開いたまま）
        await page.locator(".sidebar-right .deep-page.is-path").getByRole("button", { name: "地図でこの道をひらく" }).click();
        await settle(page, 600);
        const r = await page.evaluate(() => {
          const f = window.__fourD;
          const sel = [...f.ui.selection.nodes][0];
          return { page: f.ui.deepPage?.kind, sel, hidden: sel ? f.app.vm.node(sel).hidden : true, end: f.store.doc.nodes[sel]?.meta?.end === true, shown: f.app.vm.drawNodes.length };
        });
        assert(r.page === "path", "地図で開いたら道の画面が閉じた");
        assert(r.sel && !r.hidden && r.end, `道の終わりのカードが選ばれて見えていない（${JSON.stringify(r)}）`);
        assert(r.shown <= 3000, `開きすぎ（${r.shown} 枚）`);
        await shot(page, `${tag}-05b-path-on-canvas`);
      }
      // 戻る: 前の道 → 手の詳しい画面 → 閉じる
      await page.locator(".sidebar-right .deep-bar .deep-back").click();
      await settle(page);
      assert((await deepPage(page))?.kind === "move", "戻るで手の詳しい画面に戻らない");
      await page.locator(".sidebar-right .deep-bar .deep-close").click();
      await settle(page);
      assert((await deepPage(page)) === null, "閉じるで閉じない");
    });

    await check(`${tag}: 年月の目盛りがどの拡大率でも上に出る（今日 2026 年 11 月から）。まとめた行き先は 2029 年 11 月の列に「標準の続き」の破線`, async () => {
      for (const zoom of [1, 0.5, 0.2, 0.06]) {
        await page.evaluate((z) => {
          const v = window.__fourD.app.view;
          v.camera.zoom = z;
          v.cameraChanged();
        }, zoom);
        await settle(page, 80);
        const r = await page.evaluate(() => ({ on: window.__fourD.app.view.rulerShown, texts: window.__fourD.app.view.rulerTexts }));
        assert(r.on && r.texts.length >= 1, `拡大率 ${zoom} で目盛りが無い`);
      }
      await page.evaluate(() => window.__fourD.app.view.fit(undefined, { animate: false }));
      await settle(page, 150);
      const t = await page.evaluate(() => window.__fourD.app.view.rulerTexts);
      assert(t.some((x) => x.startsWith("今日 2026 年 11 月")), `目盛りに今日が無い（${t.join("・")}）`);
      // 1 年先まで開いて、まとめた行き先の列と線を見る
      const r = await page.evaluate(() => {
        const f = window.__fourD;
        const vm = f.app.vm;
        const deep = vm.deep.get();
        const cm = deep.cm;
        // 3 か月後のまとめた手（最初の物）を開く
        let stub = -1;
        for (let i = 0; i < cm.n; i++)
          if (cm.role[i] === 1 && cm.month[i] === 3 && cm.flags[i] & 2) {
            stub = i;
            break;
          }
        const chain = vm.impactChain(deep.idOf(stub));
        vm.setImpactOpen([...chain, deep.idOf(stub)]);
        vm.ensure();
        const end = cm.kids[cm.kidOff[stub]];
        const root = vm.posOf(deep.idOf(0));
        const p = vm.posOf(deep.idOf(end));
        const e = f.store.doc.edges[vm.index.inc.get(deep.idOf(end))[0]];
        const card = f.app.view.cards.edge(vm.impact, f.store.doc, e.id);
        return { dx: p.x - root.x, cont: card?.cont, long: card?.long, sum: f.store.doc.nodes[deep.idOf(end)].meta.sum };
      });
      assert(r.sum === true, "まとめた行き先でない");
      assert(r.dx === 8400, `まとめた行き先が 2029 年 11 月の列にない（入口から ${r.dx}px）`);
      assert(r.cont === true && /標準の続き/.test(r.long), "まとめた行き先への線が「標準の続き」でない");
      await page.evaluate(() => window.__fourD.app.vm.resetImpactOpen());
      await settle(page);
      await shot(page, `${tag}-06-canvas-ruler`);
    });

    await check(`${tag}: 今日を選ぶと時間で区切って開ける（「1 年先まで（N 枚）」。3,000 枚を超える区切りは「見取り図で見る」）`, async () => {
      await page.evaluate(() => {
        const f = window.__fourD;
        f.ui.select([f.app.vm.impact.root]);
        f.ui.setPrefs({ rightOpen: true });
      });
      await settle(page);
      const sec = page.locator(".sidebar-right .deep-open-sec");
      await sec.waitFor();
      const btn = sec.locator("button", { hasText: "1 年先まで" });
      assert((await btn.count()) === 1, "「1 年先まで」が無い");
      const label = await btn.innerText();
      const m = /（([\d,]+) 枚）/.exec(label);
      assert(m, `枚数が無い（${label}）`);
      const want = Number(m[1].replace(/,/g, ""));
      assert((await sec.locator("button", { hasText: "見取り図で見る" }).count()) === 1, "上限を超える区切りの「見取り図で見る」が無い");
      assert((await sec.locator("button", { hasText: "全部" }).count()) === 0, "「全部」と書いたボタンがある");
      await shot(page, `${tag}-07-open-actions`);
      await btn.click();
      await settle(page, 400);
      const shown = await page.evaluate(() => {
        const vm = window.__fourD.app.vm;
        vm.ensure();
        return vm.drawNodes.length;
      });
      assert(shown >= want && shown <= 3000, `開いた後のカードの数が合わない（${shown}・ボタンは ${want} 枚）`);
      await shot(page, `${tag}-08-opened-1y`);
      await page.evaluate(() => window.__fourD.app.vm.resetImpactOpen());
      await settle(page);
    });

    await check(`${tag}: 地図のカードの組み立てた本文（読むだけ）と自分のメモ（書き換える・元の文章に戻す）`, async () => {
      const id = await page.evaluate(() => {
        const f = window.__fourD;
        const deep = f.app.vm.deep.get();
        const id = deep.idOf(deep.cm.firstMoves[0]);
        f.ui.select([id]);
        return id;
      });
      await settle(page, 300);
      const sec = page.locator(".sidebar-right .deep-body");
      await sec.waitFor();
      const body = await sec.locator(".deep-body-text").innerText();
      assert(body.length > 100, `組み立てた本文が短い（${body.length} 字）`);
      assert((await sec.locator(".deep-nums li").count()) >= 3, "数の行が無い");
      const note = page.locator(".sidebar-right textarea[aria-label='自分のメモ']");
      assert((await note.inputValue()) === "", "自分のメモが空でない");
      await sec.scrollIntoViewIfNeeded();
      await settle(page);
      await shot(page, `${tag}-09-composed-body`);
      await sec.getByRole("button", { name: "この文章をもとに書き換える" }).click();
      await settle(page);
      const copied = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid].body, id);
      assert(copied.includes(body.slice(0, 40)), "自分のメモに本文が写っていない");
      await sec.getByRole("button", { name: "元の文章に戻す" }).click();
      await settle(page);
      const cleared = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid].body, id);
      assert(cleared === "", "元の文章に戻すでメモが空にならない");
      // 複製は組み立てた本文を写しに入れる
      const dupBody = await page.evaluate((nid) => {
        const f = window.__fourD;
        const ids = f.app.cmd.duplicate([nid]);
        const b = f.store.doc.nodes[ids[0]]?.body ?? "";
        f.app.cmd.undo();
        return b;
      }, id);
      assert(dupBody.includes(body.slice(0, 40)), "複製に組み立てた本文が入っていない");
      await page.evaluate(() => window.__fourD.ui.clearSelection());
      await settle(page);
    });

    await check(`${tag}: 検索は組み立てた本文を探さないと言う`, async () => {
      const input = page.locator(".search-input").first();
      await input.click();
      await input.fill("転職");
      const noteEl = page.locator(".search-results .search-note", { hasText: "組み立てた本文" });
      await noteEl.waitFor({ timeout: 10_000 });
      const note = await noteEl.innerText();
      assert(note.includes("組み立てた本文は探しません"), `検索の注記が違う（${note}）`);
      await input.fill("");
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        window.__fourD.ui.setSearch("");
        document.activeElement?.blur?.();
      });
      await settle(page);
    });

    await check(`${tag}: 新しい地図の知らせの「一番ありそうな道を読む」で道の画面が開く（新しく開いたページで）`, async () => {
      const again = await open(browser, profile);
      try {
        const btn = again.page.locator(".rel-sheet").getByRole("button", { name: "一番ありそうな道を読む" });
        await btn.waitFor({ timeout: 10_000 });
        await btn.click();
        await again.page.locator(".sidebar-right .deep-page.is-path").waitFor();
        await settle(again.page);
        assert(await again.page.locator(".sidebar-right .deep-page.is-path").isVisible(), "道の画面が見えない");
        const pg = await deepPage(again.page);
        const chain = await again.page.evaluate(() => {
          const deep = window.__fourD.app.vm.deep.get();
          return deep.overview().moves.find((m) => m.isPi)?.node ?? -1;
        });
        assert(pg?.kind === "path" && pg.node >= 0 && chain >= 0, "一番ありそうな道でない");
        await noOverflow(again.page, "知らせから開いた道の画面");
        assert(!again.errors.length, again.errors.join("\n"));
      } finally {
        await again.ctx.close();
      }
    });

    await check(`${tag}: コンソールのエラーが無い`, async () => {
      assert(!errors.length, errors.join("\n"));
    });
  } finally {
    await ctx.close();
  }
}

async function main() {
  build();
  await startServer();
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ["--no-sandbox"] });
  try {
    const only = process.env.DEEPMAP_PROFILE || "";
    if (!only || only === "390") await runProfile(browser, { name: "390", viewport: { width: 390, height: 844 }, mobile: true });
    if (!only || only === "1440") await runProfile(browser, { name: "1440", viewport: { width: 1440, height: 900 }, mobile: false });
  } finally {
    await browser.close();
    server?.kill();
  }
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通った`);
  if (bad.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  server?.kill();
  process.exit(1);
});
