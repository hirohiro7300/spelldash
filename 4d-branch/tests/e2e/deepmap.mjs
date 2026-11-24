// E2E: 3 か月ごとの地図（版 7）の見取り図・手の詳しい画面・道の画面・年月の目盛り・時間で区切って開く・新しい地図の知らせ・
// 組み立てた本文を、地図を入れたページ（P2 の既定のビルド）で確かめる（作業メモ SPEC v1 §5・§4.4・§11）
//   npm run e2e:deepmap
//   保存してあった物を読む起動の道（「保存」の組）: 合成した版 6 の利用者の文書（tests/fixtures/account-r6.json。本物のデータではない）を
//   IndexedDB に入れて開く（読むときに版 7 へ引き上げる）→ 見取り図・道の画面・一番ありそうな道・目盛り・時間で区切って開く・
//   新しい地図の知らせ（自分で選んだ・見送ったカードの差・「前の版で決めたこと」）→ 薄い形で保存 → 開き直す（保存した薄い形を読む）。
//   一時表示 #demo-q（保存しない・組み立てたままの地図）の組は、見せ方の細かい確かめ。
//   既定のビルドを作業用のフォルダ（DEEPMAP_DIST。既定は OS の一時フォルダの下）に作り、vite preview で開く（E2E_PORT。既定 4540）。
//   IMPACT_Q_BUNDLE を渡すと、その同梱データで作る（VITE_IMPACT_Q=1）。
//   DEEPMAP_DIST にビルド済みのフォルダを渡すと、そのまま使う。スマホ（390×844・タッチ）と机（1440×900）で同じ確かめをする。
//   DEEPMAP_SHOTS にフォルダを渡すと、確かめの途中の画面を撮って残す（DEEPMAP_DPR。既定 1）。DEEPMAP_PROFILE=390・1440・stored・splash で 1 つだけ。
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
const BUNDLE = process.env.IMPACT_Q_BUNDLE || "";
const FIXTURE = path.join(ROOT, "tests", "fixtures", "account-r6.json");
const DPR = Number(process.env.DEEPMAP_DPR || 1);
const DIST = process.env.DEEPMAP_DIST || path.join(os.tmpdir(), "4d-branch-deepmap-dist");
const SHOTS = process.env.DEEPMAP_SHOTS || "";
const ONLY = process.env.E2E_ONLY || "";

function build() {
  if (process.env.DEEPMAP_DIST && fs.existsSync(path.join(DIST, "index.html"))) return;
  if (BUNDLE && !fs.existsSync(BUNDLE)) throw new Error(`地図の同梱データがありません: ${BUNDLE}`);
  console.log(`ビルド（${BUNDLE ? `VITE_IMPACT_Q=1・${BUNDLE}` : "既定: 版 7 の地図"}）→ ${DIST}`);
  const env = { ...process.env };
  if (BUNDLE) Object.assign(env, { VITE_IMPACT_Q: "1", IMPACT_Q_BUNDLE: BUNDLE });
  else delete env.VITE_IMPACT_Q;
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", DIST, "--emptyOutDir", "--logLevel", "error"], {
    cwd: ROOT,
    env,
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
  const ctx = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: DPR, isMobile: profile.mobile, hasTouch: profile.mobile });
  if (opts.seedSheet) {
    await ctx.addInitScript((rel) => {
      try {
        localStorage.setItem("4d-branch:prefs", JSON.stringify({ releaseSheet: rel, onboardingDone: true }));
      } catch {
        /* about:blank など */
      }
    }, opts.seedSheet);
  }
  await ctx.addInitScript(noNativeDialogs);
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

/** ブラウザの確認・知らせ（confirm・alert・prompt）は使わない（Artifact の画面では動かない）。使ったらページのエラーにする */
function noNativeDialogs() {
  for (const k of ["confirm", "alert", "prompt"]) {
    window[k] = () => {
      throw new Error(`window.${k} を使った（ページの中の確かめを使う）`);
    };
  }
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
      // 狭い画面では右の引き出し（概要）がキャンバスを覆うので、閉じてから目盛りを写す（P2 の確かめ F3）
      if (profile.mobile) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: false }));
      await settle(page);
      if (profile.mobile) assert(await page.evaluate(() => window.__fourD.app.view.rulerShown), "引き出しを閉じた後に目盛りが無い");
      await shot(page, `${tag}-06-canvas-ruler`);
    });

    await check(`${tag}: 今日を選ぶと、手ごとに時間で区切って開ける（「手の名前（1 年先まで N 枚）」）。縦に長すぎる・3,000 枚を超える区切りは「見取り図で見る」（見直し user-8）`, async () => {
      await page.evaluate(() => {
        const f = window.__fourD;
        f.app.vm.resetImpactOpen();
        f.ui.select([f.app.vm.impact.root]);
        f.ui.setPrefs({ rightOpen: true });
      });
      await settle(page);
      // 概要（今日の「この先をひらく」も持つ）は外さずに隠して取っておく（P4: Esc で概要へ戻る速さ）。見ているのは出している詳細の物。
      // 隠した概要は見えず、読み上げに出ず、フォーカスも入らない
      const kept = await page.evaluate(() => {
        const ov = document.querySelector(".sidebar-right .insp-overview");
        if (!ov) return null;
        const b = ov.querySelector("button");
        b?.focus();
        return { off: ov.classList.contains("insp-kept-off"), aria: ov.getAttribute("aria-hidden"), shown: [...ov.children].some((x) => x.checkVisibility()) || ov.getBoundingClientRect().height > 0, btnShown: [...ov.querySelectorAll("button")].some((x) => x.checkVisibility()), focused: !!b && document.activeElement === b };
      });
      assert(!kept || (kept.off && kept.aria === "true" && !kept.shown && !kept.btnShown && !kept.focused), `隠した概要が見える・押せる（${JSON.stringify(kept)}）`);
      const sec = page.locator(".sidebar-right .deep-open-sec:visible");
      await sec.waitFor();
      const moves = sec.locator(".deep-open-moves button");
      assert((await moves.count()) >= 5, `手ごとに開くボタンが少ない（${await moves.count()}）`);
      const btn = moves.first();
      // 今日の詳細は資産のゴールの帯の下にある（机でも画面の外になりうる）。画面の外の欄は描画を後回しにする（content-visibility）ので、人と同じく寄せて、描いてから読む
      await btn.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const label = await btn.innerText();
      const m = /1 年先まで ([\d,]+) 枚/.exec(label);
      assert(m, `手ごとのボタンに区切りと枚数が無い（${label}）`);
      const want = Number(m[1].replace(/,/g, ""));
      // 今日から全部は「この時期まで全部ひらく」（まとめて開く D）: 1 年後（縦に 1,400 行）は聞いてから開き、3,000 枚を超える時期は
      // 選べず（多すぎて開けません）、見取り図で見る（見直し user-8・作業メモ bulk §2 D）
      const opts = await sec.locator("select[aria-label='開く時期'] option").evaluateAll((os) => os.map((o) => ({ t: o.textContent, d: o.disabled })));
      assert(opts.length === 12, `時期が 12 でない（${opts.length}）`);
      assert(opts.some((o) => /1\s年後/.test(o.t) && !o.d), `1 年後が選べない（${JSON.stringify(opts)}）`);
      assert(opts.filter((o) => o.d).every((o) => /多すぎて開けません/.test(o.t)) && opts.at(-1).d, `3,000 枚を超える時期が選べる（${JSON.stringify(opts)}）`);
      const allText = (await sec.locator(".deep-open-quarter button").allInnerTexts()).join(" / ");
      assert(/見取り図で見る（\d{4}\u00a0年 \d+\u00a0月から先）/.test(allText), `多すぎる時期の「見取り図で見る」が無い（${allText}）`);
      assert((await sec.locator("button", { hasText: "全部" }).count()) === 0, "「全部」と書いたボタンがある");
      await shot(page, `${tag}-07-open-actions`);
      const fk = await btn.getAttribute("data-fk");
      const startId = fk.slice(fk.lastIndexOf(":") + 1);
      await btn.click();
      await settle(page, 700);
      const after = await page.evaluate((id) => {
        const f = window.__fourD;
        const vm = f.app.vm;
        vm.ensure();
        const v = f.app.view;
        const p = vm.posOf(id);
        const s = p ? v.camera.toScreen(p.x, p.y) : null;
        const r = v.canvas.getBoundingClientRect();
        const toast = [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" / ");
        return { shown: vm.drawNodes.length, right: f.ui.prefs.rightOpen, s, w: r.width, h: r.height, zoom: v.camera.zoom, toast };
      }, startId);
      assert(after.shown >= want && after.shown <= 3000, `開いた後のカードの数が合わない（${after.shown}・ボタンは ${want} 枚）`);
      // 開き始めた手のカードが画面の中（今日の手と、その次の列が見える所へ寄る）
      assert(after.s && after.s.x > -40 && after.s.x < after.w * 0.6 && after.s.y > 0 && after.s.y < after.h, `開き始めた手のカードが画面の外（${JSON.stringify(after.s)}・${after.w}×${after.h}）`);
      assert(/開いた（[\d,]+[ \u00a0]枚）/.test(after.toast) && /見取り図で見る/.test(after.toast), `何を開いたかのお知らせが無い（${after.toast}）`);
      // 「1 年」「383 枚」は折り返さない 1 かたまり（390 で「から1」「年先まで」に割れていた: 見直し reader-4）
      assert(/から \d+\u00a0年/.test(after.toast) && /\d\u00a0枚）/.test(after.toast), `お知らせの数と単位の間で折り返せる（${after.toast}）`);
      if (tag === "390") assert(after.right === false, "スマホで開いた後に引き出しが開いたまま");
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
        // 狭い画面: 時間で区切って開いた後は引き出しを閉じている（見直し user-8）ので開く
        f.ui.setPrefs({ rightOpen: true });
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

    // ------------------------------------------------------------ 見直しの直し（user-1〜user-15・equiv-1〜equiv-5・perf-5）
    const showOverview = async () => {
      await page.evaluate(() => {
        const f = window.__fourD;
        f.ui.closeDeep();
        f.ui.clearSelection();
        f.ui.setPrefs({ rightOpen: true, scenarioId: null });
      });
      await settle(page, 300);
      await page.locator(".sidebar-right .deep-ov .dm-glance-row").first().waitFor();
    };
    const num = (t) => {
      const m = /([+\-−])?\s*([\d,]+(?:\.\d+)?)/.exec(t ?? "");
      return m ? (m[1] === "-" || m[1] === "−" ? -1 : 1) * Number(m[2].replace(/,/g, "")) : NaN;
    };

    await check(`${tag}: 今日の手の差は、キャンバスの札も見取り図の札も同じ数（比べ方をそろえた q どうし: 見直し user-1・equiv-1）`, async () => {
      await showOverview();
      const r = await page.evaluate(() => {
        const f = window.__fourD;
        const imp = f.app.vm.impact;
        const cards = f.app.view.cards;
        const canvas = {};
        for (const id of imp.decision.get(imp.root).alts) {
          const a = imp.alt.get(id);
          if (a.isBase) continue;
          canvas[f.store.doc.nodes[id].title.trim()] = { pill: cards.card(imp, f.store.doc, id).pill, basis: a.deltaBasis };
        }
        const glance = [...document.querySelectorAll(".sidebar-right .deep-ov a.dm-glance-row:not(.is-base)")].map((a) => ({ name: a.querySelector(".dm-glance-name")?.textContent?.trim(), pill: a.querySelector(".dm-glance-pill")?.textContent?.trim() }));
        const legend = document.querySelector(".sidebar-right .imp-overview")?.textContent ?? "";
        return { canvas, glance, legend };
      });
      assert(r.glance.length >= 8, `見取り図の行が少ない（${r.glance.length}）`);
      let matched = 0;
      for (const g of r.glance) {
        const c = r.canvas[g.name];
        if (!c) continue;
        matched++;
        const a = num(c.pill);
        const b = num(g.pill);
        assert(c.basis === "q", `${g.name}: キャンバスの差が q どうしでない（${c.basis}）`);
        assert(Math.abs(a - b) <= (Math.abs(b) >= 10 ? 1 : 0.11), `${g.name}: キャンバスの札 ${c.pill} と見取り図の札 ${g.pill} が違う`);
      }
      assert(matched >= 8, `見取り図の行とキャンバスの手の名前が合わない（${matched} 行）`);
    });

    await check(`${tag}: 今日の手のカードの「この種類が使えることの値打ち」は見取り図と同じ名前・同じ数（判断ごとの別の問いは出さない: 見直し user-2）`, async () => {
      await showOverview();
      const rows = await page.evaluate(() => [...document.querySelectorAll(".sidebar-right .deep-ov a.dm-row")].map((a) => ({ name: a.querySelector(".dm-row-name")?.textContent?.trim(), pills: [...a.querySelectorAll(".dm-row-pills .dm-pill-wrap")].map((x) => x.textContent?.trim()) })));
      const id = await page.evaluate(() => {
        const f = window.__fourD;
        const imp = f.app.vm.impact;
        const id = imp.decision.get(imp.root).alts.find((x) => !imp.alt.get(x).isBase);
        f.ui.select([id]);
        return id;
      });
      await settle(page, 300);
      const facts = await page.locator(".sidebar-right .imp-facts").first().innerText();
      assert(!facts.includes("この手を 3 年間ずっとやらない場合と比べると"), `判断ごとの「やらない場合」が出ている（${facts}）`);
      const name = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid].title.trim(), id);
      const row = rows.find((x) => x.name?.startsWith(name));
      assert(row, `見取り図に「${name}」の行が無い`);
      const worthPill = row.pills.find((x) => x.includes("値打ち"));
      // 名前と数は同じ項目（li）の中。見た目で行が分かれることがあるので、項目ごとに読む
      const line = await page.evaluate(() => [...document.querySelectorAll(".sidebar-right .imp-facts li")].map((li) => li.textContent?.replace(/\s+/g, " ").trim() ?? "").find((x) => x.includes("この種類が使えることの値打ち")));
      assert(line && worthPill, `値打ちが無い（カード ${line}・見取り図 ${worthPill}）`);
      if (worthPill.includes("ほぼ無し")) assert(line.includes("ほぼ無し"), `見取り図は「ほぼ無し」なのにカードは ${line}`);
      else assert(Math.abs(num(line.replace(/^[^+\-−\d]*/, "")) - num(worthPill.replace(/^[^+\-−\d]*/, ""))) < 0.6, `カード ${line} と見取り図 ${worthPill} が違う`);
    });

    await check(`${tag}: 「元の文章に戻す」は写した地図の文章だけを外し、自分で書いたメモは残す。手で書いただけのメモには出さない（見直し user-3）`, async () => {
      const id = await page.evaluate(() => {
        const f = window.__fourD;
        const deep = f.app.vm.deep.get();
        const id = deep.idOf(deep.cm.firstMoves[1]);
        f.ui.select([id]);
        f.ui.setPrefs({ rightOpen: true });
        return id;
      });
      await settle(page, 300);
      const sec = page.locator(".sidebar-right .deep-body");
      await sec.waitFor();
      const reset = sec.getByRole("button", { name: "元の文章に戻す" });
      // 手で書いたメモだけ: 出さない
      await page.evaluate((nid) => window.__fourD.app.cmd.updateNode(nid, { body: "上司に 12 月の面談で聞く。" }), id);
      await settle(page);
      assert(!(await reset.isVisible()), "手で書いただけのメモに「元の文章に戻す」が出ている");
      // 写す（自分のメモの前に足す）→ 写した所だけ外す・お知らせに元に戻す
      await sec.getByRole("button", { name: "この文章をもとに書き換える" }).click();
      await settle(page);
      const copied = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid].body, id);
      assert(copied.endsWith("上司に 12 月の面談で聞く。") && copied.length > 100, "写した文章が自分のメモの前に入っていない");
      assert(await sec.locator(".deep-body-text.is-folded").count(), "写した後に読むだけの文章をたたんでいない");
      await reset.click();
      await settle(page);
      const after = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid].body, id);
      assert(after === "上司に 12 月の面談で聞く。", `自分のメモが残っていない（${after.slice(0, 40)}）`);
      const toastText = await page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" / "));
      assert(/写した地図の文章を外した/.test(toastText) && /元に戻す/.test(toastText), `外したお知らせが無い（${toastText}）`);
      await page.evaluate((nid) => (window.__fourD.app.cmd.updateNode(nid, { body: "" }), window.__fourD.ui.clearSelection()), id);
      await settle(page);
    });

    await check(`${tag}: 概要は見取り図に無い物だけ: 前の版の欄は「くわしい数」にたたみ、見出しの数は見取り図と同じ言い方（まとめた行き先を行き先に数えない）。行き先は種類ごと（見直し user-5）`, async () => {
      await showOverview();
      const r = await page.evaluate(() => {
        const ov = document.querySelector(".sidebar-right .imp-overview");
        const more = ov?.querySelector("details.imp-more");
        return { counts: ov?.querySelector(".imp-counts, .imp-head-counts")?.textContent ?? ov?.textContent ?? "", more: !!more, open: more?.open ?? null, decideOutside: !!ov?.querySelector(":scope > .imp-decide") };
      });
      assert(r.more && r.open === false, "「くわしい数」のたたみが無い・開いている");
      assert(!r.decideOutside, "今決めることが見取り図の下に出ている");
      assert(/行き先 [\d,]+（見込み 1% 以上 [\d,]+）・標準の続きの見積もり [\d,]+/.test(r.counts), `見出しの数の言い方が見取り図と違う（${r.counts.slice(0, 120)}）`);
      await page.locator(".sidebar-right details.imp-more > summary").click();
      await settle(page, 300);
      assert(await page.locator(".sidebar-right .imp-more .imp-dest .dm-dest").count(), "くわしい数の行き先が種類ごとでない");
      await page.locator(".sidebar-right details.imp-more > summary").click();
      await settle(page);
    });

    await check(`${tag}: 同じ題名のカードは年月と親の手で見分ける（検索の行・同じ物は 1 行に N 枚: 見直し user-6）`, async () => {
      if (profile.mobile) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: false }));
      const input = page.locator(".search-input");
      await input.click();
      await input.fill("転職せず");
      await settle(page, 400);
      const rows = await page.locator(".search-results .search-row").allInnerTexts();
      assert(rows.length >= 3, `検索の行が少ない（${rows.length}）`);
      assert(rows.every((t) => /\d{4} 年 \d+ 月/.test(t) && t.includes("→")), `年月と親の手の無い行がある（${rows.slice(0, 3).join(" / ")}）`);
      assert(new Set(rows).size === rows.length, "同じ行が並んでいる（まとめていない）");
      await input.fill("");
      await page.keyboard.press("Escape");
      await settle(page);
    });

    await check(`${tag}: ≒ は一番の手（◎）から 10 万円未満だけ・◎ そのものには付けない（見直し user-7・equiv-3）`, async () => {
      const r = await page.evaluate(() => {
        const imp = window.__fourD.app.vm.impact;
        const alts = imp.decision.get(imp.root).alts.map((id) => imp.alt.get(id));
        const rec = alts.find((a) => a.rec);
        return { rec: rec ? { mark: rec.mark, d: rec.delta } : null, ties: alts.filter((a) => a.mark === "tie").map((a) => a.delta), n: alts.length };
      });
      assert(r.rec && r.rec.mark !== "tie", `◎ の手に ≒ が付いている（${JSON.stringify(r.rec)}）`);
      assert(r.ties.length < r.n - 2, `≒ が多すぎる（${r.ties.length} / ${r.n}）`);
      for (const d of r.ties) assert(r.rec.d - d < 10 + 1e-9, `◎ から 10 万円以上離れた手に ≒（${d} / ◎ ${r.rec.d}）`);
    });

    await check(`${tag}: 概要の「見取り図で見る」で見取り図の頭へ送る（見直し user-10）`, async () => {
      await showOverview();
      const btn = page.locator(".sidebar-right .imp-deep-open button", { hasText: "見取り図で見る" }).first();
      await btn.scrollIntoViewIfNeeded();
      await settle(page);
      const before = await page.evaluate(() => document.querySelector(".sidebar-right .insp-body-scroll").scrollTop);
      await btn.click();
      await settle(page, 400);
      const r = await page.evaluate(() => {
        const sc = document.querySelector(".sidebar-right .insp-body-scroll");
        const ov = document.querySelector(".sidebar-right .deep-ov");
        return { top: sc.scrollTop, off: ov.getBoundingClientRect().top - sc.getBoundingClientRect().top, focus: document.activeElement?.closest(".deep-ov") !== null };
      });
      assert(before > 200, `ボタンまで送れていない（${before}）`);
      assert(Math.abs(r.off) < 40, `見取り図の頭へ送っていない（見取り図の上端 ${r.off}px）`);
      assert(r.focus, "見取り図の見出しにフォーカスが無い");
    });

    await check(`${tag}: 方針（シナリオ）を選ぶと、見取り図の方針の外の手の行も薄くする（見直し user-13）`, async () => {
      await showOverview();
      const sid = await page.evaluate(() => {
        const f = window.__fourD;
        const sids = f.store.doc.scenarioOrder;
        const pick = sids.find((x) => /早期独立/.test(f.store.doc.scenarios[x]?.name ?? "")) ?? sids[1] ?? sids[0];
        f.ui.setPrefs({ scenarioId: pick });
        return pick;
      });
      await settle(page, 500);
      const r = await page.evaluate(() => {
        const f = window.__fourD;
        const imp = f.app.vm.impact;
        const off = imp.decision.get(imp.root).alts.filter((id) => !imp.alt.get(id).allowed).length;
        const dim = document.querySelectorAll(".sidebar-right .deep-ov a.dm-glance-row.is-off").length;
        return { off, dim };
      });
      assert(sid && r.off > 0, "方針の外の今日の手が無い（確かめられない）");
      assert(r.dim === r.off, `見取り図で薄くした行の数が方針の外の手と違う（${r.dim} / ${r.off}）`);
    });

    await check(`${tag}: 方針の外の手のカードは「計算では選びません」と言わない（版 7 は方針で絞っていない: 見直し equiv-5）`, async () => {
      const id = await page.evaluate(() => {
        const f = window.__fourD;
        const imp = f.app.vm.impact;
        const id = imp.decision.get(imp.root).alts.find((x) => !imp.alt.get(x).allowed);
        f.ui.select([id]);
        f.ui.setPrefs({ rightOpen: true });
        return id;
      });
      assert(id, "方針の外の手が無い");
      await settle(page, 300);
      const text = await page.locator(".sidebar-right .insp-body-scroll").innerText();
      assert(!text.includes("計算では選びません"), "方針の外の手に「計算では選びません」と出ている");
      assert(text.includes("方針で絞っていない"), "方針で絞っていないと言っていない");
      await page.evaluate(() => (window.__fourD.ui.setPrefs({ scenarioId: null }), window.__fourD.ui.clearSelection()));
      await settle(page);
    });

    await check(`${tag}: 手のカードの地図の文章は、同じ判断の手の一覧より上（狭い画面は同じ判断の手を 3 つまで: 見直し user-11）`, async () => {
      const id = await page.evaluate(() => {
        const f = window.__fourD;
        const deep = f.app.vm.deep.get();
        const id = deep.idOf(deep.cm.firstMoves[2]);
        f.ui.select([id]);
        f.ui.setPrefs({ rightOpen: true });
        return id;
      });
      await settle(page, 300);
      const r = await page.evaluate(() => {
        const sc = document.querySelector(".sidebar-right .insp-body-scroll");
        const top = (sel) => {
          const el = sc.querySelector(sel);
          return el ? el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop : null;
        };
        return { body: top(".deep-body"), sibs: top(".imp-sibs"), rows: sc.querySelectorAll(".imp-sibs .imp-alt-row, .imp-sibs [data-fk^='alt:']").length, more: !!sc.querySelector(".imp-alt-more") };
      });
      assert(r.body !== null && r.sibs !== null && r.body < r.sibs, `地図の文章が同じ判断の手より下（文章 ${r.body}・手 ${r.sibs}）`);
      if (profile.mobile) assert(r.more, "狭い画面で同じ判断の手をたたんでいない（「ほか N 個を見る」が無い）");
      await page.evaluate(() => window.__fourD.ui.clearSelection());
      await settle(page);
      void id;
    });

    await check(`${tag}: 年収を仮の 360 から 360 に入れると「（仮）」が消えて「仮に戻す」が出る（見直し equiv-2）`, async () => {
      await showOverview();
      await page.locator('[data-fk="salary"]').click();
      await page.locator(".imp-salary-input").fill("360");
      await page.locator('[data-fk="salary-ok"]').click();
      await settle(page, 300);
      const r = await page.evaluate(() => ({ set: window.__fourD.app.vm.impact.annualSet, kari: document.querySelector(".sidebar-right .imp-kari")?.hidden ?? true, reset: document.querySelector('.sidebar-right [data-fk="salary-reset"]')?.hidden ?? true }));
      assert(r.set === true && r.kari === true && r.reset === false, `年収を入れたのに仮のまま（${JSON.stringify(r)}）`);
      await page.evaluate(() => window.__fourD.app.cmd.undo());
      await settle(page);
      assert((await page.evaluate(() => window.__fourD.app.vm.impact.annualSet)) === false, "元に戻しても仮に戻らない");
    });

    await check(`${tag}: 道の画面の名前はカードの題名（書き換えれば道の画面も変わる: 見直し equiv-4）`, async () => {
      // 一番ありそうな行き先までの道。着いた所のカードの名前は、そのカードの題名（地図の題名の無い「—」は組み立てた名前）
      const node = await page.evaluate(() => {
        const f = window.__fourD;
        const deep = f.app.vm.deep.get();
        const end = f.app.vm.impact.ends[0].id;
        f.ui.setPrefs({ rightOpen: true });
        f.ui.openDeep({ kind: "path", node: deep.indexOf(end) });
        return end;
      });
      await settle(page, 400);
      const endCard = page.locator(".sidebar-right .deep-page.is-path .dm-tl-end");
      await endCard.waitFor();
      const before = await endCard.innerText();
      assert(before.length > 4, "着いた所のカードが空");
      await page.evaluate((id) => window.__fourD.app.cmd.updateNode(id, { title: "書き換えた行き先の題名" }), node);
      await settle(page, 400);
      const after = await page.locator(".sidebar-right .deep-page.is-path .dm-tl-end").innerText();
      assert(after.includes("書き換えた行き先の題名"), `題名を書き換えても道の画面が変わらない（${after.slice(0, 80)}）`);
      await page.evaluate(() => (window.__fourD.app.cmd.undo(), window.__fourD.ui.closeDeep()));
      await settle(page);
    });

    if (!profile.mobile) {
      await check(`${tag}: 引いたとき（21%）の手の目印は、真ん中に差を描いたカードでは題名だけ・次の列の手前で切る（見直し user-9）`, async () => {
        await page.evaluate(() => {
          const f = window.__fourD;
          f.ui.clearSelection();
          f.app.vm.resetImpactOpen();
          const v = f.app.view;
          const root = f.app.vm.impact.root;
          v.centerOn(root, { zoom: 0.21, animate: false });
        });
        await settle(page, 400);
        const r = await page.evaluate(async () => {
          const v = window.__fourD.app.view;
          v.debugHeads = [];
          v.requestRender();
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          const heads = v.debugHeads ?? [];
          v.debugHeads = null;
          return { heads, zoom: v.camera.zoom };
        });
        assert(r.zoom < 0.3 && r.zoom > 0.15, `21% にならない（${r.zoom}）`);
        assert(r.heads.length >= 5, `目印が少ない（${r.heads.length}）`);
        const withDelta = r.heads.filter((x) => /万｜/.test(x.text));
        assert(withDelta.length === 0, `真ん中に差を描いたカードの目印に差が残っている（${withDelta.map((x) => x.text).slice(0, 3).join(" / ")}）`);
        const over = r.heads.filter((x) => x.maxW !== null && x.x1 - x.x0 > x.maxW + 1);
        assert(over.length === 0, `次の列へはみ出す目印がある（${over.map((x) => `${x.text} ${(x.x1 - x.x0).toFixed(0)}/${x.maxW.toFixed(0)}`).slice(0, 3).join(" / ")}）`);
        assert(r.heads.some((x) => x.maxW !== null), "次の列の幅で切った目印が無い（確かめられない）");
        await shot(page, `${tag}-21-heads`);
      });
    }

    if (!profile.mobile) {
      await check(`${tag}: 道の画面の下の「地図でこの道をひらく」の後に閉じると、カードの詳細は頭から（見直し user-15）`, async () => {
        await page.evaluate(() => {
          const f = window.__fourD;
          const deep = f.app.vm.deep.get();
          f.ui.openDeep({ kind: "path", node: deep.cm.firstMoves[0] });
        });
        await settle(page, 400);
        const btn = page.locator(".sidebar-right [data-fk='deep-open-map']");
        await btn.scrollIntoViewIfNeeded();
        await btn.click();
        await settle(page, 400);
        await page.locator(".sidebar-right [data-fk='deep-close']").click();
        await settle(page, 400);
        const top = await page.evaluate(() => document.querySelector(".sidebar-right .insp-body-scroll").scrollTop);
        assert(top === 0, `閉じた後のカードの詳細が途中から（${top}px）`);
        await page.evaluate(() => (window.__fourD.app.vm.resetImpactOpen(), window.__fourD.ui.clearSelection()));
        await settle(page);
      });
    } else {
      await check(`${tag}: 閉じた引き出しは置かない（display: none。カードを押すたびに幅 0 の引き出しをレイアウトしない: 見直し perf-5）`, async () => {
        await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: false, leftOpen: false }));
        await settle(page);
        const d = await page.evaluate(() => [getComputedStyle(document.querySelector(".sidebar-right")).display, getComputedStyle(document.querySelector(".sidebar-left")).display]);
        assert(d[0] === "none" && d[1] === "none", `閉じた引き出しが置かれている（${d.join(" / ")}）`);
        await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: true }));
        await settle(page);
        assert((await page.evaluate(() => getComputedStyle(document.querySelector(".sidebar-right")).display)) !== "none", "開いた引き出しが出ない");
      });
    }

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

    await goalChecks(page, tag, profile);
    await bulkChecks(page, tag, profile);

    await check(`${tag}: コンソールのエラーが無い`, async () => {
      assert(!errors.length, errors.join("\n"));
    });
  } finally {
    await ctx.close();
  }
}


/**
 * 資産のゴール（作業メモ goal/design.md §4.1・§4.3・§5）: 見取り図のいちばん上の帯・地図のいちばん右のゴールの列とカード（札）・
 * 行き先からゴールへの線・前提の欄。前提に入れる数は試験用の丸めた数（今の資産 500 万円・積立 30%）
 */
const GOAL_ASSETS = "500";
const GOAL_SAVE = "30";

/** 地図の 1 つ目の手の先の行き先 n 個への道を開き、芽の行き先（無ければ最初の物）を返す */
const openGoalEnds = (page, n = 40) =>
  page.evaluate((n) => {
    const f = window.__fourD;
    const vm = f.app.vm;
    const deep = vm.deep.get();
    const cm = deep.cm;
    const a = deep.analysis();
    const m0 = cm.firstMoves[3];
    const leaves = [];
    for (let i = m0; i < m0 + cm.size[m0]; i++) if (cm.kidOff[i] === cm.kidOff[i + 1] && a.pi.def[i]) leaves.push(i);
    const pick = leaves.filter((_, k) => k % Math.ceil(leaves.length / n) === 0).slice(0, n);
    const open = new Set();
    for (const i of pick) for (const id of vm.impactChain(deep.idOf(i))) open.add(id);
    vm.setImpactOpen([...open]);
    vm.ensure();
    const ends = vm.drawNodes.filter((id) => vm.impact.kind.get(id) === "leaf");
    const doc = f.store.doc;
    const seed = ends.find((id) => {
      const rr = doc.nodes[id]?.meta?.rr;
      return Array.isArray(rr) && rr[1] + rr[2] >= 10;
    });
    return { ends: ends.length, end: seed ?? ends[0] };
  }, n);

/** ゴールのカード（札）と線の数 */
const goalRail = (page) =>
  page.evaluate(() => {
    const f = window.__fourD;
    const g = f.app.view.goal;
    const el = document.querySelector(".goal-rail");
    const r = el && !el.hidden ? el.getBoundingClientRect() : null;
    const cr = f.app.view.canvas.getBoundingClientRect();
    return {
      stubs: f.goalStubs,
      emph: g.emph,
      strokes: g.strokes,
      labeled: g.labeled,
      connector: g.connector,
      state: g.state,
      railSx: g.railSx,
      width: f.app.view.width,
      text: r ? el.innerText.replace(/\s+/g, " ").trim() : "",
      aria: r ? el.getAttribute("aria-label") : null,
      box: r && { top: r.top - cr.top, bottom: r.bottom - cr.top, left: r.left - cr.left, right: r.right - cr.left },
      ruler: f.app.view.rulerTexts.filter((t) => t.includes("ゴール")),
    };
  });

async function goalChecks(page, tag, profile) {
  const narrow = profile.viewport.width < 700;
  const panelTop = async () => {
    await closeSheet(page);
    await page.evaluate(() => {
      const f = window.__fourD;
      f.ui.closeDeep?.();
      f.ui.clearSelection();
      f.ui.setPrefs({ rightOpen: true });
    });
    await settle(page, 300);
    await page.locator(".sidebar-right .deep-ov .dm-goal[data-goal-key]:not(.is-wait)").first().waitFor({ timeout: 15_000 });
    await page.evaluate(() => {
      const sc = document.querySelector(".sidebar-right .insp-body-scroll");
      if (sc) sc.scrollTop = 0;
    });
    await settle(page, 100);
  };
  const stripText = () => page.evaluate(() => document.querySelector(".sidebar-right .deep-ov .dm-goal .dm-goal-bartext")?.textContent ?? "");

  await check(`${tag}: ゴール: 見取り図のいちばん上の帯（ゴール 資産 10 億円・期限・棒・目安）${narrow ? "。たたんだ帯と 10 の手の 10 行目が画面に収まる" : ""}・横にはみ出さない`, async () => {
    await panelTop();
    const strip = page.locator(".sidebar-right .deep-ov .dm-goal").first();
    const sum = (await strip.locator("summary").innerText()).replace(/\s+/g, " ");
    assert(/ゴール ?資産 10 億円・\d{4} 年まで/.test(sum), `帯の見出し: ${sum}`);
    assert(/\d{4} 年に約 [\d.]+ 億円.*目安/.test(sum), `帯の棒の横に期限の年の資産と目安が無い: ${sum}`);
    assert((await strip.locator(".dm-goal-bar .dm-goal-fill").count()) === 1, "帯の棒が無い");
    const first = await page.evaluate(() => {
      const ov = document.querySelector(".sidebar-right .deep-ov");
      const g = ov.querySelector(".dm-goal");
      const rows = ov.querySelectorAll(".dm-glance-row");
      return { before: g && rows[0] ? !!(g.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING) : false };
    });
    assert(first.before, "帯が 10 の手の行より前にない");
    if (narrow) {
      // スマホ: たたんだ帯（既定）と 10 行目まで、何も動かさずに見える
      const r = await page.evaluate(() => {
        const d = document.querySelector(".sidebar-right .deep-ov .dm-goal details");
        const rows = [...document.querySelectorAll(".sidebar-right .deep-ov .dm-glance-row")];
        return { open: d?.open, h: innerHeight, bottom: Math.round(rows[9]?.getBoundingClientRect().bottom ?? 1e9), strip: Math.round(d?.getBoundingClientRect().height ?? 0) };
      });
      assert(r.open === false, "スマホで帯が開いている（既定はたたむ）");
      assert(r.strip <= 64, `たたんだ帯が高い（${r.strip}px）`);
      assert(r.bottom <= r.h, `たたんだ帯の下で 10 の手の 10 行目が画面に収まらない（下の端 ${r.bottom} / ${r.h}）`);
    }
    await noOverflow(page, "ゴールの帯");
    await shot(page, `${tag}-goal-01-strip`);
  });

  await check(`${tag}: ゴール: 帯を開くと 3 つの数（届く年・要る積立・要る事業の伸び）と手立て・前提が並び、はみ出さない。「届く見込み 0%」は出さない`, async () => {
    await panelTop();
    // 机（高さ 900 以上）は最初から開いている。たたんでいれば「くわしく」で開く
    const wasOpen = await page.evaluate(() => document.querySelector(".sidebar-right .deep-ov .dm-goal details")?.open ?? false);
    if (!wasOpen) await page.locator(".sidebar-right .deep-ov .dm-goal summary").first().click();
    await settle(page, 200);
    const r = await page.evaluate(() => {
      const g = document.querySelector(".sidebar-right .deep-ov .dm-goal");
      const tiles = [...g.querySelectorAll(".dm-goal-tile")];
      return {
        open: g.querySelector("details").open,
        n: tiles.length,
        over: tiles.filter((t) => t.scrollWidth > t.clientWidth + 1).length,
        tops: [...new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().top)))].length,
        text: g.innerText,
      };
    });
    assert(r.open && r.n === 3, `開いた帯の 3 つの数（${r.n}）`);
    assert(r.over === 0, `3 つの数がはみ出す（${r.over} 個）`);
    assert(r.tops === 1, "3 つの数が 1 行に並ばない");
    for (const w of ["届くには", "目安", "前提:", "地図が数えるのは"]) assert(r.text.includes(w), `開いた帯に「${w}」が無い`);
    assert(!/見込み 0%/.test(r.text), "「届く見込み 0%」が出ている");
    await noOverflow(page, "開いたゴールの帯");
    await page.locator(".sidebar-right .deep-ov .dm-goal .dm-goal-premise-more").first().click();
    await settle(page, 100);
    await shot(page, `${tag}-goal-02-strip-open`);
    // 開け閉めはこのブラウザに残る: 元のたたんだ形に戻す（スマホの既定）
    if (!wasOpen) await page.locator(".sidebar-right .deep-ov .dm-goal summary").first().click();
    await settle(page, 100);
  });

  await check(`${tag}: ゴール: 今の資産 ${GOAL_ASSETS} 万円・積立 ${GOAL_SAVE}% を入れると帯と行き先の札が変わり、元に戻すで戻る`, async () => {
    await page.evaluate(() => window.__fourD.app.vm.resetImpactOpen());
    const { end } = await openGoalEnds(page, 10);
    await panelTop();
    const card = () => page.evaluate((id) => {
      const f = window.__fourD;
      return f.app.view.cards.card(f.app.vm.impact, f.store.doc, id)?.goal ?? null;
    }, end);
    const before = { strip: await stripText(), card: await card() };
    assert(before.card && before.card.text.includes("目安"), `行き先の札が無い・目安が無い（${JSON.stringify(before.card)}）`);
    await page.locator('.sidebar-right [data-fk="goal"]').first().click();
    await page.locator('.sidebar-right [data-fk="goal-assets"]').fill(GOAL_ASSETS);
    await page.locator('.sidebar-right [data-fk="goal-save"]').fill(GOAL_SAVE);
    await shot(page, `${tag}-goal-03-editor`);
    await page.locator('.sidebar-right [data-fk="goal-ok"]').click();
    await page.waitForFunction((b) => (document.querySelector(".sidebar-right .deep-ov .dm-goal .dm-goal-bartext")?.textContent ?? "") !== b, before.strip, { timeout: 10_000 });
    await settle(page, 200);
    const after = { strip: await stripText(), card: await card(), meta: await page.evaluate(() => { const f = window.__fourD; return f.store.doc.nodes[f.app.vm.impact.root].meta.goal; }), toast: await toasts(page) };
    assert(after.meta && after.meta.assets === Number(GOAL_ASSETS) && after.meta.save === Number(GOAL_SAVE) && after.meta.v === 1 && Object.keys(after.meta).length === 3, `入口の前提: ${JSON.stringify(after.meta)}`);
    assert(after.card && after.card.atBy > before.card.atBy, `行き先の期限の資産が増えていない（${before.card.atBy} → ${after.card?.atBy}）`);
    assert(after.toast.includes("10 億円の前提を変えました"), `お知らせ: ${after.toast}`);
    const row = await page.evaluate(() => document.querySelector(".sidebar-right .goal-view")?.textContent ?? "");
    assert(/前提 3 つは仮/.test(row), `見出しの行の仮の数が減っていない: ${row}`);
    await page.evaluate(() => window.__fourD.app.cmd.undo());
    await page.waitForFunction((b) => (document.querySelector(".sidebar-right .deep-ov .dm-goal .dm-goal-bartext")?.textContent ?? "") === b, before.strip, { timeout: 10_000 });
    const undone = { card: await card(), meta: await page.evaluate(() => { const f = window.__fourD; return f.store.doc.nodes[f.app.vm.impact.root].meta.goal; }) };
    assert(undone.meta === undefined && Math.abs(undone.card.atBy - before.card.atBy) < 1e-6, `元に戻らない（${JSON.stringify(undone)}）`);
    await dropToasts(page);
  });

  await check(`${tag}: ゴール: 地図のいちばん右のゴール。見えていなければ右の端の札（${narrow ? "10億 5% ›" : "→ ゴール 10 億円 5%"}）・行き先からゴールへ線（goalStubs）・選んだ行き先の線は濃く札つき・札を押すとゴールの列へ・カードを押すと前提の欄`, async () => {
    await page.evaluate(() => {
      const f = window.__fourD;
      f.app.vm.resetImpactOpen();
      f.ui.clearSelection();
      const imp = f.app.vm.impact;
      f.app.view.fit([imp.root, ...imp.decision.get(imp.root).alts], { animate: false });
    });
    if (narrow) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: false }));
    await settle(page, 900);
    let g = await goalRail(page);
    assert(g.state === "right", `今日に寄った画面でゴールが右の端の札でない（${JSON.stringify(g)}）`);
    assert(narrow ? /^10億 \d+% ›$/.test(g.text) : /^→ ゴール 10 億円 \d+%$/.test(g.text), `札の文字: ${g.text}`);
    assert(g.aria && g.aria.includes("押すとゴールの所へ動きます"), `読み上げのボタンが無い（${g.aria}）`);
    const covers = await page.evaluate(() => {
      const c = document.querySelector(".goal-rail").getBoundingClientRect();
      return [...document.querySelectorAll(".zoom-ctl, .toast:not(.closing), .bottom-bar, .banner")]
        .filter((e) => e.checkVisibility())
        .map((e) => e.getBoundingClientRect())
        .filter((r) => c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top).length;
    });
    assert(covers === 0, "ゴールの札が下の操作・お知らせ・帯に重なる");
    assert(g.stubs === 0, `行き先が見えていないのに線がある（${g.stubs}）`);
    await shot(page, `${tag}-goal-04-chip`);
    // 行き先を開いて寄る: 線が引かれる
    const { end } = await openGoalEnds(page, 40);
    await page.evaluate(([id, z]) => window.__fourD.app.view.centerOn(id, { zoom: z, animate: false }), [end, narrow ? 0.42 : 0.55]);
    await settle(page, 400);
    g = await goalRail(page);
    const ends = await page.evaluate(() => {
      const f = window.__fourD;
      const v = f.app.view;
      const vm = f.app.vm;
      vm.ensure();
      return vm.drawNodes.filter((id) => {
        if (vm.impact.kind.get(id) !== "leaf") return false;
        const s = v.camera.toScreen(0, vm.posOf(id).y);
        return s.y >= 0 && s.y <= v.height;
      }).length;
    });
    assert(g.stubs > 0 && g.stubs <= ends, `線の数（${g.stubs}・見えている高さの行き先 ${ends}）`);
    assert(g.strokes <= 5, `線をまとめて描いていない（${g.strokes} 回）`);
    assert(g.ruler.length === 1, `目盛りにゴールが無い（${g.ruler.join("・")}）`);
    await shot(page, `${tag}-goal-05-stubs`);
    // 選ぶ: その行き先の線は濃く、線の右に「2056 年 0.45 億円（5%）目安」
    await page.evaluate((id) => window.__fourD.ui.select([id]), end);
    if (narrow) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: false }));
    await settle(page, 500);
    g = await goalRail(page);
    assert(g.emph >= 1 && g.labeled, `選んだ行き先の線が濃くない・札が無い（${JSON.stringify(g)}）`);
    if (narrow && g.state === "right") assert(g.connector, "スマホで選んだ行き先から右の札への破線が無い");
    const fact = await page.evaluate(() => document.querySelector(".sidebar-right .goal-fact")?.textContent ?? "");
    if (!narrow) assert(/\d{4} 年の資産は約 [\d.]+ 億円.*目安/.test(fact) && fact.includes("前提を変える"), `詳細の欄の「10 億」の 1 文: ${fact}`);
    await shot(page, `${tag}-goal-06-end-selected`);
    // 札を押すとゴールの列へ（カードになる）
    if (g.state === "right") {
      await page.locator(".goal-rail").click();
      await settle(page, 700);
      g = await goalRail(page);
    }
    assert(g.state === "card" && g.railSx > 0 && g.railSx < g.width, `札を押してもゴールの列へ動かない（${JSON.stringify(g)}）`);
    assert(/^ゴール 資産 10 億円 \d{4} 年まで(（仮）)? 今の道 [\d.]+ 億（\d+%） ?目安$/.test(g.text), `ゴールのカードの文字: ${g.text}`);
    assert(g.aria && g.aria.includes("押すと前提と内訳を開きます"), `読み上げ: ${g.aria}`);
    assert(g.box.top >= 26, `ゴールのカードが目盛りに重なる（${JSON.stringify(g.box)}）`);
    await shot(page, `${tag}-goal-07-rail-card`);
    // カードを押すと前提の欄が開く
    await page.locator(".goal-rail").click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("goal-input"), null, { timeout: 5000 });
    await settle(page, 200);
    await shot(page, `${tag}-goal-08-editor-from-rail`);
    await page.keyboard.press("Escape");
    await settle(page, 200);
    assert((await page.locator(".goal-edit:not([hidden])").count()) === 0, "Esc で前提の欄が閉じない");
    await page.evaluate(() => (window.__fourD.app.vm.resetImpactOpen(), window.__fourD.ui.clearSelection()));
    await settle(page, 200);
  });

  await check(`${tag}: ゴール: 途中のカードの詳細に「この先の行き先: 期限の年の資産（10〜90%・目安）」`, async () => {
    const id = await selectCard(page, await page.evaluate(() => window.__fourD.app.vm.deep.get().cm.firstMoves[2]));
    const line = page.locator(".sidebar-right .deep-goal");
    await line.waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => /この先の行き先: \d{4} 年の資産/.test(document.querySelector(".sidebar-right .deep-goal")?.textContent ?? ""), null, { timeout: 10_000 });
    // 詳細の下の欄は画面の外では描かない（content-visibility）: 文は textContent で読む
    await line.scrollIntoViewIfNeeded();
    const t = (await line.textContent()) ?? "";
    assert(/この先の行き先: \d{4} 年の資産 [\d.〜]+ ?億円（10〜90%・目安）/.test(t), `途中のカードの 1 文: ${t}`);
    assert(t.includes("前提を変える"), `手のカードの 1 文に「前提を変える」が無い: ${t}`);
    await noOverflow(page, "途中のカードの詳細");
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    void id;
  });
}

/** 見えているカードの数（キャンバス） */
const drawn = (page) => page.evaluate(() => (window.__fourD.app.vm.ensure(), window.__fourD.app.vm.drawNodes.length));

/** 見えているカードのうち、地図の番号 tops の先の物（頭は含まない）の数 */
const drawnInside = (page, tops) =>
  page.evaluate((ts) => {
    const f = window.__fourD;
    const vm = f.app.vm;
    vm.ensure();
    const deep = vm.deep.get();
    let n = 0;
    for (const id of vm.drawNodes) {
      const j = deep.indexOf(id);
      if (ts.some((t) => j > t && j < t + deep.cm.size[t])) n++;
    }
    return n;
  }, tops);

/** ボタンの文の「（N 枚）」の N */
const cardsOf = (text) => {
  const m = /([\d,]+)\s枚）/.exec(text);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
};

/** まとめて開く前に見えていたカードを覚える（開いた後の「新しく出たカード」を数えるため） */
const markBefore = (page) => page.evaluate(() => (window.__fourD.app.vm.ensure(), (window.__bulkBefore = new Set(window.__fourD.app.vm.drawNodes))));

/**
 * まとめて開いた後に画面で読めるカード（スマホ: 作業メモ bulk 見直しの残り 1）。キャンバスのうち、上の帯・年月の目盛り・お知らせ・
 * 拡大縮小の部品・選ぶ帯に覆われていない所に、まるごと入っているカードを数える。
 * area: 開いた所（tops とその先）のカード・fresh: そのうち開く前に無かったカード・head: 開き始めたカードがまるごと見えるか
 */
const bulkInView = (page, tops, head) =>
  page.evaluate(
    ({ tops, head }) => {
      const f = window.__fourD;
      const v = f.app.view;
      const vm = f.app.vm;
      vm.ensure();
      const deep = vm.deep.get();
      const cr = v.canvas.getBoundingClientRect();
      const covers = [...document.querySelectorAll(".banner-area > *, .toast:not(.closing), .zoom-ctl, .pick-bar")]
        .filter((e) => e.checkVisibility())
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      if (v.rulerShown) covers.push({ left: cr.left, right: cr.right, top: cr.top, bottom: cr.top + 26 });
      const z = v.camera.zoom;
      const hw = 106 * z;
      const hh = 48 * z;
      const shows = (id) => {
        const p = vm.posOf(id);
        const s = v.camera.toScreen(p.x, p.y);
        const b = { left: cr.left + s.x - hw, right: cr.left + s.x + hw, top: cr.top + s.y - hh, bottom: cr.top + s.y + hh };
        if (b.left < cr.left || b.right > cr.right || b.top < cr.top || b.bottom > cr.bottom) return false;
        return !covers.some((c) => b.left < c.right && b.right > c.left && b.top < c.bottom && b.bottom > c.top);
      };
      let area = 0;
      let fresh = 0;
      for (const id of vm.drawNodes) {
        const j = deep.indexOf(id);
        if (!tops.some((t) => j >= t && j < t + deep.cm.size[t])) continue;
        if (!shows(id)) continue;
        area++;
        if (!window.__bulkBefore?.has(id)) fresh++;
      }
      return { zoom: z, area, fresh, head: shows(deep.idOf(head)) };
    },
    { tops, head },
  );

/**
 * スマホでまとめて開いた後: 開き始めたカードと、新しく開いたカードが、題名の読める大きさ（40% 以上）で、何にも覆われずに 3 枚以上見える。
 * fresh: false は、もう開いていた形に足したとき（半年後まで開いた後の 1 年後: 新しく出るカードは今日から 1 年右で、今日と同じ画面に
 * 読める大きさでは入らない。今日とその先の行を見せ、残りは動かして見る）
 */
async function assertBulkView(page, profile, what, tops, head, opts = { fresh: true }) {
  if (profile.viewport.width >= 700) return;
  const r = await bulkInView(page, tops, head);
  assert(r.zoom >= 0.4 - 1e-6 && r.head && r.area >= 3 && (!opts.fresh || r.fresh >= 1), `${what}: 開いた後の画面で読めるカードが足りない（拡大 ${Math.round(r.zoom * 100)}%・開き始めたカード ${r.head ? "見える" : "見えない"}・開いた所 ${r.area} 枚・新しく出た ${r.fresh} 枚）`);
}

/** 出ているお知らせの文 */
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll(".toast:not(.closing)")].map((t) => t.textContent).join(" / "));

/** 出ているお知らせを閉じる（次の確かめのお知らせと混ぜない） */
const dropToasts = (page) => page.evaluate(() => document.querySelectorAll(".toast:not(.closing) .toast-close").forEach((b) => b.click()));

/** 右のパネル（狭い画面では引き出し）を開いて、カード（地図の番号）を選ぶ */
async function selectCard(page, i) {
  const id = await page.evaluate((k) => {
    const f = window.__fourD;
    const deep = f.app.vm.deep.get();
    const id = deep.idOf(k);
    f.ui.select([id]);
    f.ui.setPrefs({ rightOpen: true });
    return id;
  }, i);
  await settle(page, 300);
  return id;
}

/**
 * まとめて開く（作業メモ bulk/design.md）: A 段数・B 見込みの高い道・C 複数のカード（狭い画面は「ほかのカードも選ぶ」）・D 同じ時期まで
 * （キーボードだけで）。押す前の枚数 = 開いた後のキャンバスの増え方・大きい物はページの中で聞く（やめる・開く）・お知らせの「元に戻す」
 */
async function bulkChecks(page, tag, profile) {
  const narrow = profile.viewport.width < 700;
  const reset = async () => {
    await dropToasts(page);
    await page.evaluate(() => {
      const f = window.__fourD;
      f.ui.setMultiPick(false);
      f.app.vm.resetImpactOpen();
      f.ui.clearSelection();
    });
    await settle(page, 300);
  };
  const shotB = async (name) => {
    await settle(page, 250);
    await shot(page, `${tag}-bulk-${name}`);
  };

  await check(`${tag}: まとめて開く A（段数）: ボタンの枚数どおりに開き、お知らせの「元に戻す」で前の形に戻る。どの段数も枚数つき`, async () => {
    await reset();
    const f = await page.evaluate(() => window.__fourD.app.vm.deep.get().cm.firstMoves[0]);
    const id = await selectCard(page, f);
    const sec = page.locator(".sidebar-right .deep-open-sec:visible");
    await sec.waitFor();
    const texts = await sec.locator(".deep-open-depth button").allTextContents();
    assert(texts.length >= 3, `段数のボタンが少ない（${texts.join(" / ")}）`);
    for (const t of texts) assert(Number.isFinite(cardsOf(t)), `枚数の無いボタン（${t}）`);
    assert(/3\sか月先まで/.test(texts[0]) && texts.some((t) => /半年先まで/.test(t)) && texts.some((t) => /1\s年先まで/.test(t)), `段数が 3 か月・半年・1 年でない（${texts.join(" / ")}）`);
    await sec.locator(".deep-open-depth button").first().scrollIntoViewIfNeeded();
    await noOverflow(page, "段数で開く");
    await shotB("A-before");
    const btn = sec.locator(`[data-fk="open:12:${id}"]`);
    const want = cardsOf(await btn.textContent());
    const title = await btn.getAttribute("title");
    assert(/開いた後のキャンバス [\d,]+ 枚/.test(title), `開いた後の全体の枚数が無い（${title}）`);
    const before = await drawn(page);
    const inside = await drawnInside(page, [f]);
    await markBefore(page);
    await btn.click();
    await settle(page, 600);
    const after = await drawn(page);
    await assertBulkView(page, profile, "A", [f], f);
    assert(after === before - inside + want, `開いた後の枚数が合わない（${before} − ${inside} + ${want} ≠ ${after}）`);
    const t = await toasts(page);
    assert(/から\s1\u00a0年先までの判断と手を開いた（383\u00a0枚）|から\s1\u00a0年先までの判断と手を開いた（[\d,]+\u00a0枚）/.test(t) && /元に戻す/.test(t) && /見取り図で見る/.test(t), `お知らせが違う（${t}）`);
    if (narrow) assert(!(await page.evaluate(() => window.__fourD.ui.prefs.rightOpen)), "スマホで開いた後に引き出しが開いたまま");
    await shotB("A-after");
    await page.locator(".toast:not(.closing) .toast-action", { hasText: "元に戻す" }).click();
    await settle(page, 400);
    assert((await drawn(page)) === before, `元に戻すで前の枚数に戻らない（${await drawn(page)} / ${before}）`);
    await reset();
  });

  await check(`${tag}: まとめて開く A（大きい段数）: 1,000 枚を超えるときはページの中で聞く。「やめる」で何も開かず、「開く」で開き、「この先をまとめてたたむ」で閉じる`, async () => {
    await reset();
    // 2 年先までが 3,000 枚の内に入る今日の手
    const f = await page.evaluate(() => {
      const deep = window.__fourD.app.vm.deep.get();
      const cm = deep.cm;
      for (const f of cm.firstMoves) {
        const end = f + cm.size[f];
        let n = 0;
        for (let j = f + 1; j < end; j++) if (cm.month[cm.parent[j]] < cm.month[f] + 24) n++;
        if (n > 1100 && n < 2900) return f;
      }
      return -1;
    });
    assert(f >= 0, "2 年先までが 3,000 枚に入る手が無い");
    const id = await selectCard(page, f);
    const btn = page.locator(`.sidebar-right [data-fk="open:24:${id}"]`);
    await btn.waitFor();
    const want = cardsOf(await btn.textContent());
    assert(/開く前に確かめます/.test(await btn.getAttribute("title")), "大きい段数のボタンに「確かめます」が無い");
    const before = await drawn(page);
    await btn.click();
    const dlg = page.locator(".modal[role='dialog']");
    await dlg.waitFor();
    const dt = await dlg.innerText();
    assert(new RegExp(`${want.toLocaleString("en-US")} 枚を開きます`).test(dt) && /元に戻す/.test(dt) && /この先をまとめてたたむ/.test(dt), `確かめの文が違う（${dt}）`);
    await shotB("A-confirm");
    await dlg.getByRole("button", { name: "やめる" }).click();
    await page.waitForFunction(() => !document.querySelector(".modal-backdrop:not(.closing)"));
    await settle(page, 300);
    assert((await drawn(page)) === before, "「やめる」の後に開いた");
    if (narrow) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: true }));
    await settle(page, 200);
    await btn.click();
    await dlg.waitFor();
    await dlg.getByRole("button", { name: "開く" }).click();
    await settle(page, 800);
    const inside = await drawnInside(page, [f]);
    assert(inside === want, `開いた後の手の先の枚数が合わない（${inside} / ${want}）`);
    assert((await drawn(page)) <= 3000, "3,000 枚を超えた");
    if (narrow) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: true }));
    await settle(page, 300);
    const fold = page.locator(`.sidebar-right [data-fk="fold:${id}"]`);
    await fold.waitFor();
    assert(cardsOf(await fold.textContent()) === want, `まとめてたたむの枚数が違う（${await fold.innerText()}）`);
    await fold.click();
    await settle(page, 400);
    assert((await drawnInside(page, [f])) === 0, "まとめてたたむの後に手の先が見える");
    const left = await page.evaluate((k) => {
      const f = window.__fourD;
      const deep = f.app.vm.deep.get();
      return [...f.app.vm.impactOpenSet(deep.root)].filter((x) => {
        const j = deep.indexOf(x);
        return j >= k && j < k + deep.cm.size[k];
      }).length;
    }, f);
    assert(left === 0, `まとめてたたんだのに手の先の開いた印が残っている（${left}）`);
    await reset();
  });

  await check(`${tag}: まとめて開く B（見込みの高い道）: 5 本・10 本に見込みと枚数。押すと道の上だけを開き、行き先が見える`, async () => {
    await reset();
    const f = await page.evaluate(() => window.__fourD.app.vm.deep.get().cm.firstMoves[1]);
    const id = await selectCard(page, f);
    const row = page.locator(".sidebar-right .deep-open-likely:visible");
    await row.waitFor();
    const texts = await row.locator("button").allTextContents();
    // 数は増える枚数（今開いている物に道を足す: 見直し reader-5）
    assert(texts.length === 2 && /^5\s本（見込み \d+%・[\d,]+\s枚増える）$/.test(texts[0].trim()) && /^10\s本（\d+%・[\d,]+\s枚増える）$/.test(texts[1].trim()), `見込みの高い道のボタンが違う（${texts.join(" / ")}）`);
    const inside0 = await drawnInside(page, [f]);
    await row.scrollIntoViewIfNeeded();
    await shotB("B-before");
    const want = Number(/([\d,]+)\s枚増える/.exec(texts[0])[1].replace(/,/g, ""));
    await markBefore(page);
    await row.locator(`[data-fk="likely:5:${id}"]`).click();
    await settle(page, 600);
    await assertBulkView(page, profile, "B", [f], f);
    assert((await drawnInside(page, [f])) === inside0 + want, `開いた後の枚数が合わない（${await drawnInside(page, [f])} / ${inside0} + ${want}）`);
    // 開いたのは押した手の先の道の上だけ（開いた印はどれも手の先。兄弟は閉じたまま +N の札）
    const out = await page.evaluate((k) => {
      const f = window.__fourD;
      const deep = f.app.vm.deep.get();
      return [...f.app.vm.impactOpenSet(deep.root)].map((x) => deep.indexOf(x)).filter((j) => j > k && j < k + deep.cm.size[k] && deep.cm.kidOff[j + 1] > deep.cm.kidOff[j]).length;
    }, f);
    assert(out > 0 && out < want, `道の上だけを開いていない（開いた ${out}・見える ${want}）`);
    const t = await toasts(page);
    // 「道」を 2 度言わない（見直し reader-8）。数は増えた枚数
    assert(/見込みの高い\s5\s本の道を開いた（[\d,]+\s枚増えた）/.test(t) && !/道\s5\s本の道/.test(t), `お知らせが違う（${t}）`);
    await shotB("B-after");
    await reset();
  });

  await check(`${tag}: まとめて開く C（複数のカード）: 「ほかのカードも選ぶ」で${narrow ? "タップする" : "押す"}たびに足し、帯の「まとめて開く」から、選んだ全部の先を一度に開く`, async () => {
    await reset();
    // 今日と今日の手が見える所へ（狭い画面は今日の手を開いておく）
    const moves = await page.evaluate(() => {
      const f = window.__fourD;
      const vm = f.app.vm;
      const deep = vm.deep.get();
      const ms = [...deep.cm.firstMoves].slice(0, 3);
      vm.setImpactOpen([deep.root]);
      vm.ensure();
      f.app.view.fit([deep.root, ...ms.map((m) => deep.idOf(m))], { animate: false, minZoom: 0.3 });
      return ms;
    });
    const id0 = await selectCard(page, moves[0]);
    const toggle = page.locator(`.sidebar-right [data-fk="bulk-pick:${id0}"]`);
    await toggle.waitFor();
    assert((await toggle.getAttribute("aria-pressed")) === "false", "「ほかのカードも選ぶ」が押してある");
    await toggle.click();
    await settle(page, 300);
    const bar = page.locator(".pick-bar");
    assert(await bar.isVisible(), "選んでいる間の帯が無い");
    if (narrow) assert(!(await page.evaluate(() => window.__fourD.ui.prefs.rightOpen)), "スマホで引き出しが閉じない（カードを押せない）");
    else assert((await toggle.getAttribute("aria-pressed")) === "true", "押した印が付かない");
    for (const m of moves.slice(1)) {
      await page.evaluate((k) => {
        const f = window.__fourD;
        const deep = f.app.vm.deep.get();
        f.app.view.centerOn(deep.idOf(k));
      }, m);
      await settle(page, 400);
      const pt = await page.evaluate((k) => {
        const f = window.__fourD;
        const deep = f.app.vm.deep.get();
        const v = f.app.view;
        const p = f.app.vm.posOf(deep.idOf(k));
        const s = v.camera.toScreen(p.x, p.y);
        const r = v.canvas.getBoundingClientRect();
        return { x: r.left + s.x, y: r.top + s.y };
      }, m);
      if (narrow) await page.touchscreen.tap(pt.x, pt.y);
      else await page.mouse.click(pt.x, pt.y);
      await settle(page, 300);
    }
    const n = await page.evaluate(() => window.__fourD.ui.selection.nodes.size);
    assert(n === 3, `${narrow ? "タップ" : "押す"}で選びに足せない（${n} 枚）`);
    const barText = await bar.innerText();
    assert(/3\s枚を選んでいます/.test(barText), `帯の数が違う（${barText}）`);
    await noOverflow(page, "選んでいる間の帯");
    await shotB("C-before");
    // 帯に押し方の 1 行（タッチでは title が出ない）。ボタンは「開き方を選ぶ」（帯のボタンでは開かない: 見直し reader-6）
    assert(/カードを押すと足す・外す/.test(barText), `帯に押し方が無い（${barText}）`);
    await bar.getByRole("button", { name: "開き方を選ぶ" }).click();
    await settle(page, 500);
    const sec = page.locator(".sidebar-right .deep-multi:visible");
    await sec.waitFor();
    const head = await sec.locator(".insp-label").textContent();
    assert(/選んだ 3 枚の先をひらく/.test(head), `見出しが違う（${head}）`);
    const focusIn = await page.evaluate(() => !!document.activeElement?.closest(".deep-multi"));
    assert(focusIn, "「まとめて開く」の後のフォーカスが選び方に無い");
    const btn = sec.locator("[data-fk='multi-open:12']");
    const want = cardsOf(await btn.textContent());
    const before = await drawn(page);
    const inside = await drawnInside(page, moves);
    await noOverflow(page, "選んだカードの先をひらく");
    await shotB("C-panel");
    await markBefore(page);
    await btn.click();
    const dlg = page.locator(".modal[role='dialog']");
    if (await dlg.isVisible().catch(() => false)) await dlg.getByRole("button", { name: "開く" }).click();
    await settle(page, 700);
    await assertBulkView(page, profile, "C", moves, moves[0]);
    assert((await drawn(page)) === before - inside + want, `開いた後の枚数が合わない（${before} − ${inside} + ${want} ≠ ${await drawn(page)}）`);
    assert(/選んだ 3 枚から\s1\u00a0年先まで/.test(await toasts(page)), `お知らせが違う（${await toasts(page)}）`);
    await shotB("C-after");
    // 開いたら「ほかのカードも選ぶ」は終わる（次に押したカードを選びに足さない。選んだ物はそのまま: 見直し reader-6）
    const st = await page.evaluate(() => ({ pick: window.__fourD.ui.multiPick, n: window.__fourD.ui.selection.nodes.size }));
    assert(!st.pick && st.n === 3 && !(await bar.isVisible()), `開いた後も選ぶのが続く・選びが外れた（${JSON.stringify(st)}）`);
    // Esc で選ぶのを終える（選んだ物はそのまま）
    await page.evaluate(() => window.__fourD.ui.setMultiPick(true));
    await page.evaluate(() => window.__fourD.app.view.canvas.focus());
    await page.keyboard.press("Escape");
    await settle(page, 200);
    const st2 = await page.evaluate(() => ({ pick: window.__fourD.ui.multiPick, n: window.__fourD.ui.selection.nodes.size }));
    assert(!st2.pick && st2.n === 3 && !(await bar.isVisible()), `Esc で選ぶのが終わらない・選びが外れた（${JSON.stringify(st2)}）`);
    await reset();
  });

  await check(`${tag}: まとめて開く D（同じ時期まで）: キーボードだけで時期を選んで開く。大きい時期は確かめ（Esc でやめる・Enter で開く）`, async () => {
    await reset();
    await page.evaluate(() => {
      window.__fourD.ui.setPrefs({ rightOpen: true });
      window.__fourD.app.view.canvas.focus();
    });
    await settle(page, 400);
    // ⇧C で「この先をひらく」へ
    await page.keyboard.press("Shift+C");
    await settle(page, 300);
    const inSec = await page.evaluate(() => !!document.activeElement?.closest(".imp-deep-open .deep-open-sec"));
    assert(inSec, `⇧C で「この先をひらく」にフォーカスが行かない（${await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120))}）`);
    // Tab で時期の欄へ
    for (let k = 0; k < 20; k++) {
      if (await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "開く時期")) break;
      await page.keyboard.press("Tab");
    }
    assert(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "開く時期"), "Tab で時期の欄へ行けない");
    const sec = page.locator(".sidebar-right .imp-deep-open .deep-open-sec");
    await sec.scrollIntoViewIfNeeded();
    await shotB("D-before");
    // 1 年後（既定）から 2 つ上（半年後: 1,000 枚に満たず、縦も 320 行の内）へ
    const v0 = await page.evaluate(() => document.activeElement.value);
    assert(v0 === "12", `既定の時期が 1 年後でない（${v0}）`);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await settle(page, 100);
    const sel = await page.evaluate(() => ({ v: document.activeElement.value, go: document.querySelector(".sidebar-right .imp-deep-open [data-fk='quarter-open']").textContent }));
    assert(sel.v === "6", `矢印で時期が変わらない（${JSON.stringify(sel)}）`);
    const want = cardsOf(sel.go);
    await page.keyboard.press("Tab");
    assert(await page.evaluate(() => document.activeElement?.dataset.fk === "quarter-open"), "Tab で「開く」へ行けない");
    const before = await drawn(page);
    const inside = await drawnInside(page, [0]);
    await markBefore(page);
    await page.keyboard.press("Enter");
    await settle(page, 700);
    await assertBulkView(page, profile, "D（半年後）", [0], 0);
    assert((await page.locator(".modal[role='dialog']").count()) === 0, "1,000 枚に満たないのに確かめが出た");
    assert((await drawn(page)) === before - inside + want, `開いた後の枚数が合わない（${before} − ${inside} + ${want} ≠ ${await drawn(page)}）`);
    await shotB("D-after-6m");
    // 1 年後: 確かめが出る。Esc でやめる
    if (narrow) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: true }));
    await settle(page, 300);
    const q = page.locator(".sidebar-right .imp-deep-open select[aria-label='開く時期']");
    await q.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert((await q.inputValue()) === "12", `矢印で 1 年後へ戻れない（${await q.inputValue()}）`);
    const go = page.locator(".sidebar-right .imp-deep-open [data-fk='quarter-open']");
    const want12 = cardsOf(await go.textContent());
    await go.focus();
    const b2 = await drawn(page);
    await page.keyboard.press("Enter");
    const dlg = page.locator(".modal[role='dialog']");
    await dlg.waitFor();
    assert(new RegExp(`${want12.toLocaleString("en-US")} 枚を開きます`).test(await dlg.innerText()), `確かめの見出しが違う（${await dlg.innerText()}）`);
    assert(/縦に約 [\d,]+ 行/.test(await dlg.innerText()) && /最初の形に戻す/.test(await dlg.innerText()), "確かめに縦の長さ・戻し方が無い");
    await shotB("D-confirm");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".modal-backdrop:not(.closing)"));
    await settle(page, 300);
    assert((await drawn(page)) === b2, "Esc でやめたのに開いた");
    await go.focus();
    await page.keyboard.press("Enter");
    await dlg.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === "開く");
    await markBefore(page);
    await page.keyboard.press("Enter");
    await settle(page, 900);
    const after = await drawn(page);
    assert(after > b2, "開いていない");
    await assertBulkView(page, profile, "D（1 年後）", [0], 0, { fresh: false });
    const inside12 = await drawnInside(page, [0]);
    assert(inside12 === want12 && after <= 3000, `1 年後の枚数が合わない（${inside12} / ${want12}・全体 ${after}）`);
    await shotB("D-after-1y");
    // 元に戻す（1 年後のお知らせ）: 半年後の形へ
    await page.locator(".toast:not(.closing)", { hasText: "2027" }).last().locator(".toast-action", { hasText: "元に戻す" }).click();
    await settle(page, 500);
    assert((await drawn(page)) === b2, `元に戻すで半年後の形に戻らない（${await drawn(page)} / ${b2}）`);
    await reset();
  });
}

/**
 * 起動の間に先に描く見取り図（読み込み中）: 押せる形に見せず、文書の組み立ての間に押した入力は、組み立ての後に入れ替わったアプリの
 * 同じ位置を押さない（見直し user-12）
 */
/** 合成した版 6 の利用者の文書を、この起点の IndexedDB に入れる（中身の無いページで。アプリはまだ開いていない） */
async function seedStored(ctx) {
  const rec = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  await ctx.route(`${BASE}__seed`, (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: '<!doctype html><meta charset="utf-8"><title>seed</title>' }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}__seed`);
  await page.evaluate(
    async ({ rec }) => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("4d-branch", 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          for (const [n, kp] of [["kv"], ["backupMeta", "id"], ["backupData", "id"]]) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, kp ? { keyPath: kp } : undefined);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise((resolve, reject) => {
        const t = db.transaction("kv", "readwrite");
        t.objectStore("kv").put(rec, "doc");
        t.objectStore("kv").put({ rev: 1, savedAt: rec.updatedAt, writer: "old-page", docVersion: 1 }, "meta");
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
      db.close();
      localStorage.setItem("4d-branch:prefs", JSON.stringify({ onboardingDone: true, futureAutoOpened: true, futureOffered: true, wishlistOffered: true }));
    },
    { rec },
  );
  await page.close();
  return rec;
}

/** 保存先の本体と見出し（IndexedDB の kv） */
const storedBody = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("4d-branch");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const get = (key) =>
      new Promise((resolve) => {
        const r = db.transaction("kv", "readonly").objectStore("kv").get(key);
        r.onsuccess = () => resolve(r.result);
      });
    const doc = await get("doc");
    const meta = await get("meta");
    db.close();
    const raw = JSON.stringify(doc ?? null);
    return { version: doc?.version, maps: doc?.maps?.length ?? 0, nodes: doc ? Object.keys(doc.nodes).length : 0, chars: raw.length, raw, meta, sheet: doc?.meta?.releaseSheet ?? null };
  });

/**
 * 保存してあった物を読む起動の道（作業メモ SPEC §11 の e2e・W-store の §11.4）: 版 6 の利用者の文書 → 起動で版 7 に引き上げ →
 * 見取り図・道・一番ありそうな道・目盛り・時間で区切って開く・新しい地図の知らせ（自分のカード・前の版で決めたこと）→ 薄い形で保存 → 開き直す
 */
async function storedProfile(browser, profile) {
  const tag = profile.name;
  console.log(`\n[${tag}] ${profile.viewport.width}×${profile.viewport.height}${profile.mobile ? "・タッチ" : ""}・保存してあった版 6 の文書から`);
  const ctx = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: DPR, isMobile: profile.mobile, hasTouch: profile.mobile });
  await ctx.addInitScript(noNativeDialogs);
  const errors = [];
  let page = null;
  try {
    const rec = await seedStored(ctx);
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    const ready = () => page.waitForFunction(() => !!window.__fourD?.app?.vm?.deep?.get(), null, { timeout: 180_000, polling: 200 });
    await check(`${tag}: 起動で版 7 に引き上げる（id と更新時刻はそのまま・知らせに数・今日は版 7・「前の版で決めたこと」が今日の左）`, async () => {
      await page.goto(BASE);
      await ready();
      // 引き上げの知らせは、新しい地図の知らせが開けばその中に移る（お知らせが知らせの上に重ならない: 見直し R2）
      const toast = page.locator(".toast .toast-text, .rel-notices p", { hasText: "3 か月ごとの新しい地図" });
      await toast.first().waitFor({ timeout: 30_000 });
      await settle(page, 400);
      // 最初の画面で今日が見える（引き上げで自分のカードが数万 px 離れて残り、4% に縮んで今日が画面の外だった: 見直し R1）
      const cam = await page.evaluate(() => {
        const f = window.__fourD;
        const vm = f.app.vm;
        vm.ensure();
        const v = f.app.view;
        const deep = vm.deep.get();
        const p = vm.posOf(deep.root);
        const s = p ? v.camera.toScreen(p.x, p.y) : null;
        return { s, w: v.width, h: v.height, zoom: v.camera.zoom };
      });
      assert(cam.zoom >= 0.08, `最初の画面が縮みすぎ（${JSON.stringify(cam)}）`);
      assert(cam.s && cam.s.x >= 0 && cam.s.x <= cam.w && cam.s.y >= 0 && cam.s.y <= cam.h, `最初の画面に今日が無い（${JSON.stringify(cam)}）`);
      const info = await page.evaluate(() => {
        const f = window.__fourD;
        const d = f.store.doc;
        const deep = f.app.vm.deep.get();
        const root = d.nodes[deep.root];
        const groups = Object.values(d.nodes).filter((n) => typeof n.meta?.prevGroup === "number");
        return { id: d.id, updatedAt: d.updatedAt, release: root?.meta?.futureRelease, annual: root?.meta?.impact?.annual, rootX: root?.x, group: groups.map((g) => g.x), n: f.app.vm.nodeCount };
      });
      assert(info.id === rec.id, "文書の id が変わった");
      assert(info.release === 7 && info.annual === 480, `今日が版 7 でない・年収が引き継がれていない（${JSON.stringify(info)}）`);
      assert(info.group.length === 1 && info.group[0] < info.rootX, `「前の版で決めたこと」が今日の左に 1 つない（${JSON.stringify(info)}）`);
      assert(info.n > 50_000, `地図のカードが少ない（${info.n}）`);
    });

    await check(`${tag}: 新しい地図の知らせ（版 7）に、前の版で選んだ・見送ったカードの差と「前の版で決めたこと」が出る`, async () => {
      const sheet = page.locator(".rel-sheet");
      await sheet.waitFor({ timeout: 15_000 });
      const text = await sheet.innerText();
      for (const w of ["12 回の判断", "2,000 の分かれ道", "2 年の進め方は無くなった", "前の版で決めたこと"]) assert(text.includes(w), `知らせに「${w}」が無い`);
      const mineRows = await sheet.locator(".rel-mine tbody tr").count();
      const mineNone = await sheet.locator(".rel-mine-none").count();
      assert(mineRows > 0 || mineNone === 1, "前の版で選んだ・見送ったカードの欄が無い");
      if (mineRows > 0) {
        const t = await sheet.locator(".rel-mine").innerText();
        assert(/選んだ手|見送った手/.test(t) && /番目 → |からマイナスに|からプラスに/.test(t), `自分のカードの行に状態か変わった所が無い（${t.slice(0, 200)}）`);
      }
      const notes = sheet.locator(".rel-notices");
      assert((await notes.count()) === 1 && (await notes.innerText()).includes("3 か月ごとの新しい地図"), "引き上げの知らせが新しい地図の知らせの中に無い");
      assert((await page.locator(".toast:not(.closing) .toast-text", { hasText: "3 か月ごとの新しい地図" }).count()) === 0, "引き上げのお知らせが新しい地図の知らせの上に残っている");
      const prevItems = await sheet.locator(".rel-prev-list li").count();
      assert(prevItems >= 1, "「前の版で決めたこと」のカードが並んでいない");
      for (const name of ["見取り図を見る", "一番ありそうな道を読む", "前の版で決めたことを見る"]) assert((await sheet.getByRole("button", { name }).count()) === 1, `「${name}」のボタンが無い`);
      await shot(page, `${tag}-00-release-sheet`);
      await noOverflow(page, "知らせ");
      await sheet.getByRole("button", { name: "前の版で決めたことを見る" }).click();
      await page.waitForFunction(() => !document.querySelector(".modal-backdrop:not(.closing)"));
      await settle(page, 500);
      const sel = await page.evaluate(() => {
        const f = window.__fourD;
        const id = [...f.ui.selection.nodes][0];
        return { id, prev: typeof f.store.doc.nodes[id]?.meta?.prevGroup === "number" };
      });
      assert(sel.prev, `「前の版で決めたこと」が選ばれていない（${JSON.stringify(sel)}）`);
      // 狭い画面では右の引き出しを閉じ、寄せたカードが見える（見直し R7）
      const drawer = await page.evaluate(() => ({ narrow: window.innerWidth <= 860, right: window.__fourD.ui.prefs.rightOpen }));
      assert(!drawer.narrow || !drawer.right, "狭い画面で「前の版で決めたこと」に寄せたのに、右の引き出しがキャンバスを覆っている");
      await shot(page, `${tag}-01-prev-group`);
      // 見出しのカードは目標ではない: 詳細に種類（目標）と状態（未着手）の欄を出さない（見直し R7）
      if (drawer.narrow) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: true }));
      await settle(page, 300);
      const ctl = await page.evaluate(() => {
        const vis = (el) => !!el && el.getClientRects().length > 0;
        const body = document.querySelector(".sidebar-right .insp-body-scroll");
        const labels = [...(body?.querySelectorAll(".insp-section") ?? [])].filter(vis).map((x) => x.querySelector(".insp-label")?.textContent ?? "");
        return {
          title: body?.querySelector(".insp-title")?.value ?? null,
          picker: vis(body?.querySelector(".type-picker")),
          status: vis(body?.querySelector(".select-status")),
          labels,
          pill: [...(body?.querySelectorAll(".muted-pill") ?? [])].filter(vis).map((x) => x.textContent),
          dates: vis(body?.querySelector(".insp-dates")),
        };
      });
      assert(ctl.title === "前の版で決めたこと" && !ctl.picker && !ctl.status, `見出しのカードに種類・状態の欄が出ている（${JSON.stringify(ctl)}）`);
      // 空の期限・条件・つながり・「未分類」も出さない（見直し reader-5）
      assert(!ctl.dates && !ctl.labels.some((l) => /^(時間|条件|つながり)/.test(l)) && !ctl.pill.includes("未分類"), `見出しのカードに空の期限・条件・つながりの欄が出ている（${JSON.stringify(ctl)}）`);
      if (drawer.narrow) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: false }));
      const meta = await page.evaluate(() => window.__fourD.store.doc.meta?.releaseSheet ?? null);
      assert(meta === 7, `見せた版が文書に残っていない（${meta}）`);
    });

    await check(`${tag}: 見取り図（10 の手）→ 一番ありそうな道（パネルの縦の道）`, async () => {
      await page.evaluate(() => {
        const f = window.__fourD;
        f.ui.clearSelection();
        f.ui.setPrefs({ rightOpen: true });
        f.ui.closeDeep();
      });
      await settle(page, 400);
      const ov = page.locator(".sidebar-right .deep-ov");
      await ov.waitFor();
      assert((await ov.locator(".dm-glance-row").count()) === 10, "見取り図のひと目の行が 10 でない");
      await shot(page, `${tag}-02-mitorizu`);
      const chainBtn = ov.locator("a.dm-btn", { hasText: "一番ありそうな道" }).first();
      assert((await chainBtn.count()) === 1, "見取り図に一番ありそうな道が無い");
      await chainBtn.click();
      await page.locator(".sidebar-right .deep-page.is-path").waitFor();
      const path = page.locator(".sidebar-right .deep-page.is-path");
      assert((await path.locator(".dm-tl > li").count()) >= 8, "道の行が少ない");
      assert((await path.locator(".dm-tl-end").innerText()).includes("2029 年 11 月"), "着いた所が 2029 年 11 月でない");
      const head = path.locator(".dm-tl > li.is-step .dm-tl-head").nth(1);
      await head.click();
      await settle(page);
      const p0 = await deepPage(page);
      const alt = path.locator("li.is-open a.dm-alt").first();
      assert((await alt.count()) === 1, "開いた行に、ほかの結果・手が無い");
      await alt.click();
      await page.waitForFunction((n) => window.__fourD.ui.deepPage?.kind === "path" && window.__fourD.ui.deepPage.node !== n, p0.node);
      await shot(page, `${tag}-03-path`);
      await noOverflow(page, "道の画面");
      await page.evaluate(() => window.__fourD.ui.closeDeep());
      await settle(page);
    });

    await check(`${tag}: 年月の目盛りがどの拡大率でも出る（今日 2026 年 11 月から）`, async () => {
      for (const zoom of [1, 0.3, 0.08]) {
        // 今日に寄せてから拡大率を変える（「前の版で決めたこと」は今日の左で、その辺りには年月の列が無い）
        await page.evaluate((z) => {
          const f = window.__fourD;
          const v = f.app.view;
          f.app.vm.ensure();
          const p = f.app.vm.posOf(f.app.vm.deep.get().root);
          v.camera.zoom = z;
          v.camera.x = v.width * 0.25 - p.x * z;
          v.camera.y = v.height * 0.4 - p.y * z;
          v.cameraChanged();
        }, zoom);
        await settle(page, 80);
        const r = await page.evaluate(() => ({ on: window.__fourD.app.view.rulerShown, texts: window.__fourD.app.view.rulerTexts }));
        assert(r.on && r.texts.length >= 1, `拡大率 ${zoom} で目盛りが無い`);
      }
      await page.evaluate(() => {
        const f = window.__fourD;
        f.app.view.fit([f.app.vm.deep.get().root], { animate: false, minZoom: 0.5 });
      });
      await settle(page, 150);
      const t = await page.evaluate(() => window.__fourD.app.view.rulerTexts);
      assert(t.some((x) => x.startsWith("今日 2026 年 11 月")), `目盛りに今日が無い（${t.join("・")}）`);
      // 狭い画面では右の引き出し（概要）がキャンバスを覆うので、閉じてから目盛りを写す（P2 の確かめ F3）
      if (profile.mobile) {
        await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: false }));
        await settle(page, 150);
        const covered = await page.evaluate(() => {
          const c = window.__fourD.app.view.canvas.getBoundingClientRect();
          const el = document.elementFromPoint(c.left + c.width / 2, c.top + 30);
          return el !== window.__fourD.app.view.canvas;
        });
        assert(!covered, "引き出しを閉じても目盛りの所がキャンバスでない");
      }
      await shot(page, `${tag}-04-ruler`);
    });

    await check(`${tag}: 今日を選んで、手ごとに 1 年先まで開く（N 枚・3,000 枚まで）`, async () => {
      await page.evaluate(() => {
        const f = window.__fourD;
        f.app.vm.resetImpactOpen();
        f.ui.select([f.app.vm.deep.get().root]);
        f.ui.setPrefs({ rightOpen: true });
      });
      await settle(page);
      // 隠して取っておいた概要にも今日の「この先をひらく」がある（P4）。出している詳細の物を押す
      const sec = page.locator(".sidebar-right .deep-open-sec:visible");
      await sec.waitFor();
      const btn = sec.locator(".deep-open-moves button").first();
      await btn.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const label = await btn.innerText();
      const m = /1 年先まで ([\d,]+) 枚/.exec(label);
      assert(m, `手ごとのボタンに区切りと枚数が無い（${label}）`);
      const want = Number(m[1].replace(/,/g, ""));
      await btn.click();
      await settle(page, 700);
      const shown = await page.evaluate(() => (window.__fourD.app.vm.ensure(), window.__fourD.app.vm.drawNodes.length));
      assert(shown >= want && shown <= 3000 + 200, `開いた後のカードの数が合わない（${shown}・ボタンは ${want} 枚）`);
      await shot(page, `${tag}-05-opened-1y`);
      await page.evaluate(() => window.__fourD.app.vm.resetImpactOpen());
      await settle(page);
    });

    await check(`${tag}: 前の版で書き換えた本文は「前の版のメモ」と出る`, async () => {
      const id = await page.evaluate(() => {
        const f = window.__fourD;
        const deep = f.app.vm.deep.get();
        // 全体を見てよい: 確かめ
        const n = Object.values(f.store.doc.nodes).find((x) => x.meta?.prevBody === true && deep.indexOf(x.id) >= 0 && x.body.trim());
        return n?.id ?? null;
      });
      assert(id, "前の版で書き換えた本文を移したカードが無い（試験データに書き換えた本文がある）");
      await page.evaluate((nid) => {
        const f = window.__fourD;
        f.ui.select([nid]);
        f.ui.setPrefs({ rightOpen: true });
      }, id);
      await settle(page, 400);
      const labels = await page.locator(".sidebar-right .insp-section .insp-label").allTextContents();
      assert(labels.some((x) => x.trim() === "前の版のメモ"), `「前の版のメモ」が無い（${labels.join("・")}）`);
      await shot(page, `${tag}-06-prev-note`);
      // メモを書き換えたら「前の版のメモ」ではなくなる。元に戻すと戻る（見直し data-3）
      const ta = page.locator('.sidebar-right textarea[data-fk="body"]');
      await ta.fill("書き直したメモ");
      await settle(page, 300);
      const labels2 = await page.locator(".sidebar-right .insp-section .insp-label").allTextContents();
      const mark2 = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid].meta.prevBody ?? null, id);
      assert(!labels2.some((x) => x.trim() === "前の版のメモ") && mark2 === null, `書き換えた後も「前の版のメモ」のまま（${labels2.join("・")}・${mark2}）`);
      await page.evaluate(() => window.__fourD.store.undo());
      await settle(page, 300);
      const mark3 = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid].meta.prevBody ?? null, id);
      assert(mark3 === true, "元に戻しても前の版のメモの印が戻らない");
      await page.evaluate(() => window.__fourD.ui.clearSelection());
    });

    await check(`${tag}: 薄い形で保存し、開き直すと同じ（知らせは出ない・見取り図がある）`, async () => {
      await page.evaluate(() => window.__fourD.persistence.flush());
      const b = await storedBody(page);
      assert(b.version === 2 && b.maps === 1, `保存した本体が薄い形でない（${JSON.stringify(b)}）`);
      assert(b.meta?.mapRelease === 7 && b.meta?.docVersion === 2, `見出しが版 7 の薄い形でない（${JSON.stringify(b.meta)}）`);
      assert(b.sheet === 7 && b.chars < 64_000, `保存した本体が大きい・見せた版が無い（${b.chars} 文字・${b.sheet}）`);
      const before = await page.evaluate(() => ({ id: window.__fourD.store.doc.id, n: window.__fourD.app.vm.nodeCount }));
      await page.reload();
      await ready();
      await settle(page, 1200);
      const after = await page.evaluate(() => ({ id: window.__fourD.store.doc.id, n: window.__fourD.app.vm.nodeCount, compile: window.__fourD.app.vm.engine.lastCompile }));
      assert(after.id === before.id && after.n === before.n, `開き直した文書が違う（${JSON.stringify({ before, after })}）`);
      assert((await page.locator(".rel-sheet").count()) === 0, "開き直したら知らせがもう一度出た");
      assert((await page.locator(".toast .toast-text", { hasText: "3 か月ごとの新しい地図" }).count()) === 0, "開き直したら引き上げの知らせがもう一度出た");
      await page.evaluate(() => (window.__fourD.ui.clearSelection(), window.__fourD.ui.setPrefs({ rightOpen: true })));
      await settle(page, 300);
      assert((await page.locator(".sidebar-right .deep-ov .dm-glance-row").count()) === 10, "開き直した後に見取り図が無い");
      console.log(`      開き直した後の 3 年の影響の形: ${after.compile}・保存した本体 ${b.chars} 文字`);
      await shot(page, `${tag}-07-reopened`);
    });

    await check(`${tag}: ゴール: 前提（今の資産 ${GOAL_ASSETS} 万円・積立 ${GOAL_SAVE}%）を入れると保存され、開き直しても帯と見出しの行に残る。元に戻すと消える`, async () => {
      await page.evaluate(() => (window.__fourD.app.vm.resetImpactOpen(), window.__fourD.ui.clearSelection(), window.__fourD.ui.setPrefs({ rightOpen: true })));
      await settle(page, 300);
      await page.locator(".sidebar-right .deep-ov .dm-goal[data-goal-key]:not(.is-wait)").first().waitFor({ timeout: 15_000 });
      const before = await page.evaluate(() => document.querySelector(".sidebar-right .deep-ov .dm-goal .dm-goal-bartext")?.textContent ?? "");
      await page.locator('.sidebar-right [data-fk="goal"]').first().click();
      await page.locator('.sidebar-right [data-fk="goal-assets"]').fill(GOAL_ASSETS);
      await page.locator('.sidebar-right [data-fk="goal-save"]').fill(GOAL_SAVE);
      await page.locator('.sidebar-right [data-fk="goal-ok"]').click();
      await page.waitForFunction((b) => (document.querySelector(".sidebar-right .deep-ov .dm-goal .dm-goal-bartext")?.textContent ?? "") !== b, before, { timeout: 10_000 });
      const changed = await page.evaluate(() => document.querySelector(".sidebar-right .deep-ov .dm-goal .dm-goal-bartext")?.textContent ?? "");
      await page.evaluate(() => window.__fourD.persistence.flush());
      const b = await storedBody(page);
      assert(b.raw.includes(`"goal":{"v":1,"assets":${GOAL_ASSETS},"save":${GOAL_SAVE}}`), "保存した本体に前提が無い");
      await page.reload();
      await ready();
      await settle(page, 1200);
      await page.evaluate(() => (window.__fourD.ui.clearSelection(), window.__fourD.ui.setPrefs({ rightOpen: true })));
      await page.locator(".sidebar-right .deep-ov .dm-goal[data-goal-key]:not(.is-wait)").first().waitFor({ timeout: 15_000 });
      const r = await page.evaluate(() => {
        const f = window.__fourD;
        return { meta: f.store.doc.nodes[f.app.vm.impact.root].meta.goal, bar: document.querySelector(".sidebar-right .deep-ov .dm-goal .dm-goal-bartext")?.textContent ?? "", row: document.querySelector(".sidebar-right .goal-view")?.textContent ?? "" };
      });
      assert(r.meta?.assets === Number(GOAL_ASSETS) && r.meta?.save === Number(GOAL_SAVE), `開き直したら前提が無い（${JSON.stringify(r.meta)}）`);
      assert(r.bar === changed, `開き直した帯の数が違う（${changed} → ${r.bar}）`);
      assert(/前提 3 つは仮/.test(r.row), `見出しの行: ${r.row}`);
      await shot(page, `${tag}-goal-reopened`);
      // 後の確かめに残さない（入れる前に戻す: 仮の前提だけの文書）
      await page.evaluate(() => {
        const f = window.__fourD;
        const root = f.store.doc.nodes[f.app.vm.impact.root];
        const meta = { ...root.meta };
        delete meta.goal;
        f.store.transact("前提を戻す", (tx) => tx.updateNode(root.id, { meta }));
      });
      await dropToasts(page);
      await page.evaluate(() => window.__fourD.persistence.flush());
      const b2 = await storedBody(page);
      assert(!b2.raw.includes('"goal":'), "前提を消しても保存した本体に残る");
    });

    await check(`${tag}: まとめて開いた形（同じ時期まで）は開き直しても同じ。文書の保存（薄い形）は書き直さない（開く・閉じるは見え方の設定だけ）`, async () => {
      await page.evaluate(() => (window.__fourD.app.vm.resetImpactOpen(), window.__fourD.ui.clearSelection(), window.__fourD.ui.setPrefs({ rightOpen: true })));
      await settle(page, 400);
      await page.evaluate(() => window.__fourD.persistence.flush());
      const b0 = await storedBody(page);
      const q = page.locator(".sidebar-right .imp-deep-open select[aria-label='開く時期']");
      await q.waitFor();
      await q.selectOption("6");
      const go = page.locator(".sidebar-right .imp-deep-open [data-fk='quarter-open']");
      const want = cardsOf(await go.textContent());
      await go.click();
      await settle(page, 800);
      // 引き上げた文書には自分のカード（地図の番号が無い）もある: 今日の先に見えている物は、範囲の見えているカード全部（見直し data-counts-ignore-user-edits）
      const insideAll = () => page.evaluate(() => {
        const f = window.__fourD;
        const vm = f.app.vm;
        vm.ensure();
        const root = vm.deep.get().root;
        return vm.drawNodes.filter((id) => id !== root && vm.inImpact(id)).length;
      });
      assert((await insideAll()) === want, `半年後までの枚数が合わない（${await insideAll()} / ${want}）`);
      // 設定は 200 ms 後に 1 回書く。文書の保存は無い（書き直していない）
      await page.waitForTimeout(500);
      const dirty = await page.evaluate(() => window.__fourD.persistence.hasUnsaved);
      await page.evaluate(() => window.__fourD.persistence.flush());
      const b1 = await storedBody(page);
      assert(!dirty && b1.raw === b0.raw && JSON.stringify(b1.meta) === JSON.stringify(b0.meta), `まとめて開いたら文書の保存が変わった（${b0.chars} → ${b1.chars} 文字・保存待ち ${dirty}）`);
      const prefs = await page.evaluate(() => localStorage.getItem("4d-branch:prefs").length);
      assert(prefs < 100_000, `設定が大きい（${prefs} 字）`);
      const shown = await page.evaluate(() => (window.__fourD.app.vm.ensure(), [...window.__fourD.app.vm.drawNodes].sort()));
      await page.reload();
      await ready();
      await settle(page, 1200);
      const again = await page.evaluate(() => (window.__fourD.app.vm.ensure(), [...window.__fourD.app.vm.drawNodes].sort()));
      assert(again.length === shown.length && again.every((x, k) => x === shown[k]), `開き直したら見えるカードが違う（${shown.length} → ${again.length}）`);
      await page.evaluate(() => window.__fourD.app.vm.resetImpactOpen());
      await settle(page, 300);
    });

    // 概要の「やる価値が大きい手」は、見込みを空いた時間に数え終えてから入れる（perf-1）。概要はカードを選んでいる間も取っておいて
    // 置き直す（perf-8）ので、外れている間に数え終えても入れる（前は外れていると入れず、戻ると「計算中…」のまま残った: P3 を合わせたときの直し）
    if (profile.viewport.width >= 700)
      await check(`${tag}: 見込みを数えている間にカードを選び、数え終えてから概要へ戻っても「やる価値が大きい手」が「計算中」のまま残らない`, async () => {
        const cdp = await ctx.newCDPSession(page);
        // 見込みを数え終える前に選べるよう、遅い端末にする（数え終えていても、確かめは同じ: 戻った概要に計算中が無い）
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
        try {
          await page.goto(BASE, { waitUntil: "commit" });
          await page.waitForFunction(() => !!window.__fourD?.app?.vm?.deep?.get() && !!document.querySelector(".sidebar-right .imp-overview .imp-more"), null, { timeout: 180_000, polling: 20 });
          await page.evaluate(() => {
            const d = document.querySelector(".sidebar-right .imp-overview .imp-more");
            d.open = true;
          });
          await page.waitForFunction(() => !!document.querySelector(".sidebar-right .imp-overview .imp-worth .insp-label"), null, { timeout: 30_000, polling: 20 });
          const busy = await page.evaluate(() => {
            const f = window.__fourD;
            const busy = !!document.querySelector(".sidebar-right .imp-overview .imp-worth.is-busy");
            const imp = f.app.vm.impact;
            f.ui.select([imp.decision.get(imp.root).alts[0]]);
            return busy;
          });
          await page.waitForFunction(() => !!window.__fourD.app.vm.forecastIfReady(), null, { timeout: 60_000, polling: 100 });
          await settle(page, 300);
          await page.evaluate(() => window.__fourD.ui.clearSelection());
          await settle(page, 300);
          const r = await page.evaluate(() => {
            const s = document.querySelector(".sidebar-right .imp-overview .imp-worth");
            return { busy: !!s?.classList.contains("is-busy"), wait: !!s?.querySelector(".imp-worth-wait"), rows: s?.querySelectorAll(".imp-rank-title").length ?? 0 };
          });
          console.log(`      選んだときに見込みを数えていた: ${busy ? "はい" : "いいえ（もう数え終えていた）"}`);
          assert(!r.busy && !r.wait && r.rows > 0, `戻った概要の「やる価値が大きい手」が計算中のまま・空（${JSON.stringify(r)}）`);
        } finally {
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          await cdp.detach();
        }
      });

    // P4 の見直し: 起動の後の空いた時間に先に作ったノードの詳細（speed-select-desktop-edge）・本文は書き換えた手の題で手を呼ぶ（reader-1）・
    // つながりの名前が見込みの札で切れない（reader-3）
    await check(`${tag}: 先に作った詳細で初めて選んだカードの題と本文が出る・書き換えた手の題で本文が手を呼ぶ・つながりの名前が切れない`, async () => {
      await page.goto(BASE, { waitUntil: "commit" });
      await page.waitForFunction(() => !!window.__fourD?.app?.vm?.deep?.get() && !!window.__fourD.app.vm.forecastIfReady(), null, { timeout: 180_000, polling: 100 });
      await settle(page, 2000);
      const narrow = profile.viewport.width < 700;
      // 先に作った詳細は今日の最初の手の物: 別の手を初めて選ぶ
      const first = await page.evaluate(async () => {
        const f = window.__fourD;
        f.ui.setPrefs({ rightOpen: true });
        const imp = f.app.vm.impact;
        const id = imp.decision.get(imp.root).alts[1];
        f.ui.select([id]);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const body = document.querySelector(".sidebar-right .insp-body-scroll");
        const vis = (el) => !!el && el.getClientRects().length > 0;
        const titles = [...body.querySelectorAll(".insp-title")].filter(vis).map((x) => x.value);
        return { id, want: f.store.doc.nodes[id].title, titles, copy: !!body.querySelector(`[data-fk="body-copy:${id}"]`), prewarm: !!document.querySelector(".insp-prewarm") };
      });
      assert(first.titles.length === 1 && first.titles[0] === first.want, `初めて選んだカードの題が出ていない（${JSON.stringify(first)}）`);
      assert(first.copy, `初めて選んだカードの組み立てた本文が、そのカードの物でない（${JSON.stringify(first)}）`);
      assert(!first.prewarm, "先に作るための入れ物が残っている");
      // つながり（出る）の名前: 見込みの札で切れない（札は次の行へ送る）
      const conn = await page.evaluate(() =>
        [...document.querySelectorAll(".sidebar-right .conn-row .conn-title")]
          .filter((x) => x.getClientRects().length > 0)
          .map((x) => ({ t: x.textContent, sw: x.scrollWidth, cw: x.clientWidth })),
      );
      assert(conn.length > 0, "つながりの行が無い");
      const cut = conn.filter((x) => x.sw > x.cw + 1 && x.t.length <= 16);
      assert(cut.length === 0, `つながりの名前が切れている（${JSON.stringify(cut)}）`);
      // 本文が呼ぶ手の題を書き換える: 本文（詳細の地図の文章）がその題で呼ぶ。戻すと前の名前に戻る
      const found = await page.evaluate(() => {
        const f = window.__fourD;
        const ctx = f.app.vm.deep.get();
        const map = ctx.map;
        for (let s = 1; s < map.n; s++) {
          if (map.role(s) !== "s") continue;
          const body = ctx.text().body(s);
          for (let k = 0; k < map.childCount(s); k++) {
            const a = map.child(s, k);
            const t = ctx.text().title(a);
            if (map.role(a) === "a" && t && body.includes(`『${t}』`)) return { s: ctx.idOf(s), a: ctx.idOf(a), old: t };
          }
        }
        return null;
      });
      assert(found, "子の手を『』で呼ぶ本文が見つからない");
      const NEW = "面談を自分から申し込む（自分の言葉）";
      const r = await page.evaluate(
        async ({ s, a, NEW }) => {
          const f = window.__fourD;
          f.app.cmd.updateNode(a, { title: NEW }, { label: "タイトルを編集" });
          f.ui.select([s]);
          await new Promise((res) => setTimeout(res, 1500));
          const ctx = f.app.vm.deep.get();
          const i = ctx.indexOf(s);
          const shown = document.querySelector(".sidebar-right .deep-body-text")?.textContent ?? "";
          return { body: ctx.text().body(i), shown, copy: f.app.vm.deep.materialize(s) ?? "" };
        },
        { ...found, NEW },
      );
      for (const [k, v] of Object.entries(r)) {
        assert(v.includes(`『${NEW}』`), `${k}: 書き換えた手の題で呼んでいない（${v.slice(0, 300)}）`);
        assert(!v.includes(`『${found.old}』`), `${k}: 前の手の題のまま（${v.slice(0, 300)}）`);
      }
      const back = await page.evaluate(
        async ({ s, a, old }) => {
          const f = window.__fourD;
          f.app.cmd.updateNode(a, { title: old }, { label: "タイトルを編集" });
          await new Promise((res) => setTimeout(res, 1500));
          const ctx = f.app.vm.deep.get();
          return { body: ctx.text().body(ctx.indexOf(s)), shown: document.querySelector(".sidebar-right .deep-body-text")?.textContent ?? "" };
        },
        found,
      );
      for (const [k, v] of Object.entries(back)) assert(v.includes(`『${found.old}』`) && !v.includes(NEW), `${k}: 題を戻しても前の名前に戻らない（${v.slice(0, 300)}）`);
      await page.evaluate(() => window.__fourD.ui.clearSelection());
      if (narrow) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: false }));
    });

    // P4 の見直し reader-2: 本文は結果を線の名前（『大きく上げて転職』）で呼び、キャンバスのカードとつながりは題（「転職で給与 1.18 倍」）で出す。
    // 手の詳細の「結果」の行にはカードの題も並べ、結果のカードの詳細はその名前で見込みを言う（どちらの名前からも同じカードだと読める）
    await check(`${tag}: 手の詳細の結果の行にカードの題が並び、結果のカードは本文の呼ぶ名前で見込みを言う`, async () => {
      const r = await page.evaluate(async () => {
        const f = window.__fourD;
        f.ui.setPrefs({ rightOpen: true });
        const doc = f.store.doc;
        const imp = f.app.vm.impact;
        const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        let hit = null;
        for (const [id, o] of imp.outcome) {
          const lab = doc.edges[o.edge]?.label?.trim() ?? "";
          const title = doc.nodes[id]?.title?.trim() ?? "";
          if (lab && title && lab !== title && imp.alt.has(o.alt)) {
            hit = { id, alt: o.alt, lab, title };
            break;
          }
        }
        if (!hit) return null;
        f.ui.select([hit.alt]);
        await frame();
        const row = document.querySelector(`.sidebar-right .imp-out-row[data-id="${hit.id}"]`);
        const out = { ...hit, label: row?.querySelector(".imp-out-label")?.textContent ?? null, card: row?.querySelector(".imp-out-card")?.textContent ?? null };
        f.ui.select([hit.id]);
        await frame();
        out.fact = document.querySelector(".sidebar-right .imp-facts li")?.textContent ?? null;
        f.ui.clearSelection();
        return out;
      });
      assert(r, "線の名前とカードの題が違う結果が見つからない");
      assert(r.label === r.lab, `結果の行の名前が線の名前でない（${JSON.stringify(r)}）`);
      assert(r.card === `カード「${r.title}」`, `結果の行にカードの題が並ばない（${JSON.stringify(r)}）`);
      assert(r.fact?.startsWith(`『${r.lab}』になる見込み`), `結果のカードが本文の呼ぶ名前で見込みを言わない（${JSON.stringify(r)}）`);
      if (profile.viewport.width < 700) await page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: false }));
    });

    await check(`${tag}: コンソールのエラーが無い`, async () => {
      assert(errors.length === 0, errors.slice(0, 5).join("\n"));
    });
  } finally {
    await ctx.close();
  }
}

async function splashCheck(browser) {
  // スマホ（引き出しの行が、先に描いた見取り図の行と少しずれた所にある: 前の版では、押した行の 1 つ上の手が開いた）
  console.log("\n[起動の見取り図] 390×844・タッチ・CPU 4 倍遅く");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("4d-branch:prefs", JSON.stringify({ releaseSheet: 7, onboardingDone: true }));
    } catch {
      /* about:blank */
    }
    // 押した時刻（入力が起きた時刻）と、先に描いた見取り図が出た・外れた時刻・2 行目の位置・読み込み中か・押せるリンクの数を記録する
    // 押し始め（タッチ・ポインタ）。先に描いた見取り図が捨てる入力の前に記録する（一番先に足した capture のリスナー）。押した後の click は、
    // 捨てたタッチからは作られない
    window.__clicks = [];
    for (const t of ["touchstart", "pointerdown"]) window.addEventListener(t, (ev) => window.__clicks.push(ev.timeStamp), true);
    const mo = new MutationObserver(() => {
      const box = document.querySelector(".deep-splash");
      if (box && !window.__splashAt) {
        window.__splashAt = performance.now();
        const r = box.querySelectorAll(".dm-glance-row")[1]?.getBoundingClientRect();
        try {
          sessionStorage.setItem("splash", JSON.stringify({ x: r ? r.left + r.width / 2 : 0, y: r ? r.top + r.height / 2 : 0, busy: box.textContent.includes("読み込み中"), hrefs: box.querySelectorAll("a[href]").length }));
        } catch {
          /* 使えない */
        }
      }
      if (!box && window.__splashAt && !window.__splashGone) window.__splashGone = performance.now();
    });
    document.addEventListener("DOMContentLoaded", () => mo.observe(document.body, { childList: true, subtree: true }));
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const ready = () => page.waitForFunction(() => !!window.__fourD?.app?.vm?.deep?.get(), null, { timeout: 180_000, polling: 200 });
  try {
    await check("起動: 先に描く見取り図は「読み込み中」で押せる形に見せず、組み立ての間に押した所は後のアプリで押されない（見直し user-12）", async () => {
      // 1 回目: 見取り図の 2 行目の位置を記録する（組み立ての間はページの中を読めないので、出たときに記録した物を後で読む）
      await page.goto(`${BASE}#demo-q`);
      await ready();
      const sp = await page.evaluate(() => JSON.parse(sessionStorage.getItem("splash") || "null"));
      assert(sp && sp.x > 0, "先に描いた見取り図が記録されていない");
      assert(sp.busy, "先に描いた見取り図に「読み込み中」が無い");
      assert(sp.hrefs === 0, `先に描いた見取り図に押せるリンクがある（${sp.hrefs}）`);
      // 2 回目から: CPU を遅くして、組み立ての間（見取り図が出てから外れるまで）に押す。押した時刻が間に入った回で確かめる
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      let done = false;
      for (const wait of [1800, 2600, 3400, 1200]) {
        await page.evaluate(() => sessionStorage.removeItem("splash"));
        // 同じ URL（# だけ）への goto は読み直さないので、読み直す
        await page.reload({ waitUntil: "commit" });
        await new Promise((r) => setTimeout(r, wait));
        await Promise.race([page.touchscreen.tap(sp.x, sp.y), new Promise((r) => setTimeout(r, 30_000))]);
        await ready();
        await settle(page, 600);
        const r = await page.evaluate(() => ({ clicks: window.__clicks, at: window.__splashAt ?? null, gone: window.__splashGone ?? null, page: window.__fourD.ui.deepPage, sel: window.__fourD.ui.selection.nodes.size }));
        const inWindow = r.at !== null && r.gone !== null && r.clicks.some((t) => t > r.at && t < r.gone);
        if (process.env.DEEPMAP_DEBUG) console.log(`      待ち ${wait} ms: 見取り図 ${r.at?.toFixed(0)}〜${r.gone?.toFixed(0)} ms・押した ${r.clicks.map((t) => t.toFixed(0)).join(", ")}`);
        if (!inWindow) continue;
        assert(r.page === null && r.sel === 0, `組み立ての間に押した所が、後のアプリで押された（${JSON.stringify({ page: r.page, sel: r.sel })}）`);
        done = true;
        break;
      }
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      assert(done, "組み立ての間に押せなかった（確かめられない）");
      // 起動の後に押したのは届く
      await page.locator(".sidebar-right .deep-ov a.dm-glance-row").nth(1).tap();
      await settle(page, 400);
      assert((await page.evaluate(() => window.__fourD.ui.deepPage?.kind)) === "move", "起動の後に押した手の行が開かない");
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
    if (!only || only === "stored") {
      await storedProfile(browser, { name: "保存 390", viewport: { width: 390, height: 844 }, mobile: true });
      await storedProfile(browser, { name: "保存 1440", viewport: { width: 1440, height: 900 }, mobile: false });
    }
    if (!only || only === "splash") await splashCheck(browser);
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
