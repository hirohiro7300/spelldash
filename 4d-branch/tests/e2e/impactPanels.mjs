// E2E: 右のパネルの「3 年の影響」（概要・選択肢・結果・行き先・年収・お知らせ）をブラウザで確かめる
//   npm run build の後に node tests/e2e/impactPanels.mjs
//   BASE_URL を渡せばそのサーバーを使う。無ければ vite preview を立ち上げる（E2E_PORT。既定 4502）
//   PW_CHROMIUM でブラウザの場所を指定できる。E2E_SHOTS にフォルダを渡すと画面を撮って残す
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.E2E_PORT || 4502);
const BASE = process.env.BASE_URL || `http://localhost:${PORT}/`;
const SHOTS = process.env.E2E_SHOTS || "";

let server = null;
async function startServer() {
  if (process.env.BASE_URL) return;
  // E2E_DIST: 確かめるビルドの置き場（既定は dist/。版 6 だけのページは npm run build:r6 → dist-r6/）
  const DIST_DIR = process.env.E2E_DIST || path.join(ROOT, "dist");
  if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) throw new Error(`${DIST_DIR} がありません。先に npm run build を実行してください`);
  if (await fetch(BASE).then(() => true, () => false)) throw new Error(`ポート ${PORT} では別のサーバーがもう答えています（E2E_PORT で変えられます）`);
  server = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "preview", "--outDir", DIST_DIR, "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  let exited = false;
  server.on("exit", () => (exited = true));
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error(`preview サーバーが起動しません（ポート ${PORT} が使われているかもしれません。E2E_PORT で変えられます）`);
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
const ONLY = process.env.E2E_ONLY || "";
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 4).join("\n      ")}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function shot(name, page) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** 画面の数（「+62万」「−0.9万」「±0」「1,299 万円」）を数に */
const num = (s) => {
  const t = String(s).replace(/\s|万円?|,/g, "").replace("−", "-");
  return t === "±0" ? 0 : Number(t);
};

/** 何もしていないデモから「未来の道筋」で 3 年の分かれ道を開く（自動で開くのは、このコンテキストでは済んだことにする） */
async function openImpact(browser, viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => {
    try {
      const k = "4d-branch:prefs";
      const p = JSON.parse(localStorage.getItem(k) || "{}");
      if (p.futureAutoOpened !== true) {
        p.futureAutoOpened = true;
        localStorage.setItem(k, JSON.stringify(p));
      }
    } catch {
      /* about:blank など */
    }
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`      [pageerror] ${e.message}`));
  await page.goto(BASE, { waitUntil: "networkidle" });
  const skip = page.getByRole("button", { name: "すぐに使う" });
  if (await skip.count()) await skip.click();
  await page.evaluate(() => window.__fourD.app.showFuture());
  await page.waitForFunction(() => window.__fourD?.app.vm.impact.active === true, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  // 概要から確かめる（開いた後に今日を選ぶ形になっても）
  await page.evaluate(() => window.__fourD.ui.clearSelection());
  return { ctx, page };
}

/** 今の 3 年の影響（画面の確かめ用に、計算の結果を読む） */
const impactOf = (page) =>
  page.evaluate(() => {
    const f = window.__fourD;
    const imp = f.app.vm.impact;
    const root = imp.decision.get(imp.root);
    const alts = root.alts.map((id) => ({ id, ...imp.alt.get(id), title: f.store.doc.nodes[id].title, status: f.store.doc.nodes[id].status }));
    return { root: imp.root, annual: imp.annual, annualSet: imp.annualSet, vRoot: imp.vRoot, vSQ: imp.vSQ, counts: imp.counts, best: root.best, alts, ends: imp.ends.slice(0, 10).map((e) => e.id), hasPicks: imp.hasPicks };
  });

/** 元に戻すで、履歴が n 件の形まで戻して選択を外す（確かめが途中で失敗しても、後の確かめに変更を残さない） */
const undoTo = (page, n) =>
  page.evaluate((k) => {
    const f = window.__fourD;
    f.store.readOnly = false;
    for (let i = 0; i < 20 && f.store.history.undoStack.length > k; i++) f.app.cmd.undo();
    f.ui.clearSelection();
  }, n);
const undoCount = (page) => page.evaluate(() => window.__fourD.store.history.undoStack.length);

/** そのノードが画面（キャンバス）の中に見えているか */
const onScreen = (page, id) =>
  page.evaluate((nid) => {
    const f = window.__fourD;
    const v = f.app.view;
    const n = f.store.doc.nodes[nid];
    const p = (typeof f.app.vm.posOf === "function" && f.app.vm.posOf(nid)) || { x: n.x, y: n.y };
    const s = v.camera.toScreen(p.x, p.y);
    return s.x > 0 && s.x < v.width && s.y > 0 && s.y < v.height;
  }, id);

/** 右のパネルが横にはみ出していないか（引き出しの中で横に動かない） */
const noHScroll = (page) =>
  page.evaluate(() => {
    const b = document.querySelector(".insp-body-scroll");
    return { ok: b.scrollWidth <= b.clientWidth + 1, scrollW: b.scrollWidth, clientW: b.clientWidth, side: document.querySelector(".sidebar-right").getBoundingClientRect().width };
  });

async function main() {
  await startServer();
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  console.log("3 年の影響（右のパネル）");

  // ---- 机（1280×800）
  const { ctx, page } = await openImpact(browser, { width: 1280, height: 800 });

  await check("概要: 見出し（期間・年収（仮）・おすすめの 3 年・ずっと今のまま・数）", async () => {
    const imp = await impactOf(page);
    const t = await page.evaluate(() => ({
      title: document.querySelector(".imp-overview .imp-title")?.textContent,
      salary: document.querySelector(".imp-overview .imp-salary")?.textContent,
      kari: !document.querySelector(".imp-overview .imp-kari")?.hidden,
      main: document.querySelector(".imp-overview .imp-hl-main")?.textContent,
      sub: document.querySelector(".imp-overview .imp-hl-sub")?.textContent,
      counts: document.querySelector(".imp-overview .imp-counts")?.textContent,
      v1: !!document.querySelector(".forecast-ends:not([hidden])"),
    }));
    assert(/^3 年の影響（\d{4}年\d{1,2}月 → \d{4}年\d{1,2}月・税引き前）$/.test(t.title ?? ""), `見出し: ${t.title}`);
    assert(/年収（額面）360 万円で計算中（仮）/.test(t.salary ?? "") && t.kari && !imp.annualSet, `年収: ${t.salary}`);
    assert(/^おすすめの選び方で 3 年 [\d,]+ 万円$/.test(t.main ?? ""), `見出し: ${t.main}`);
    assert(Math.abs(num(t.main.replace("おすすめの選び方で 3 年 ", "")) - imp.vRoot) < 1, `3 年の稼ぎ ${t.main} / ${imp.vRoot}`);
    assert(/^ずっと今のままなら [\d,]+ 万円（差 \+[\d,]+ 万円）$/.test(t.sub ?? ""), `今のまま: ${t.sub}`);
    assert(t.counts === `判断 ${imp.counts.decisions} · 選択肢 ${imp.counts.options} · 3 年後の行き先 ${imp.counts.ends}`, `数: ${t.counts}`);
    assert(!t.v1, "前の版の「行き先の見込み」が出ている");
    await shot("impact-desktop-overview", page);
  });

  await check("概要: 今決めること（10 行・3 年の影響の順・★ か ≒・基準・差の棒・2 行目・年収で入れ替わる所）", async () => {
    const imp = await impactOf(page);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".imp-overview .imp-decide .imp-alt-row")].map((r) => ({
        id: r.dataset.id,
        mark: r.querySelector(".imp-mark")?.textContent ?? "",
        pill: r.querySelector(".imp-pill")?.textContent ?? "",
        area: r.querySelector(".imp-area")?.textContent ?? "",
        bar: !!r.querySelector(".imp-bar .imp-bar-zero"),
        meta: r.querySelector(".imp-alt-meta")?.textContent ?? "",
      })),
    );
    assert(rows.length === 10, `行の数 ${rows.length}`);
    const ds = rows.map((r) => imp.alts.find((a) => a.id === r.id)?.delta ?? null);
    for (let i = 1; i < ds.length; i++) assert(ds[i - 1] >= ds[i] - 1e-9, `3 年の影響の順になっていない: ${ds.join(",")}`);
    // ★ はちょうど 1 つ、または一番の手から 10 万円以内の手がどれも ≒（2 つ以上）
    const stars = rows.filter((r) => r.mark.includes("★")).length;
    const ties = rows.filter((r) => r.mark.includes("≒")).length;
    assert((stars === 1 && ties === 0) || (stars === 0 && ties >= 2), `★ ${stars}・≒ ${ties}`);
    assert(rows.filter((r) => r.pill === "基準").length === 1, "基準（今のまま）の行が 1 つでない");
    assert(rows.every((r) => r.bar && r.area), "差の棒か領域の札が無い行がある");
    for (const r of rows) {
      if (r.pill === "基準") continue;
      const a = imp.alts.find((x) => x.id === r.id);
      assert(Math.abs(num(r.pill) - a.delta) < (Math.abs(a.delta) < 10 ? 0.06 : 0.6), `札 ${r.pill} / ${a.delta}`);
      assert(/^悪くなる \d+%/.test(r.meta) && r.meta.includes("3年後 月") && /週[+−±]/.test(r.meta), `2 行目: ${r.meta}`);
    }
    const flip = (await page.locator(".imp-overview .imp-flip").textContent()) ?? "";
    assert(/年収 [\d,]+ 万円より(上|下)なら『.+』がいちばん|いちばんの手は同じ/.test(flip), `年収で入れ替わる所: ${flip}`);
  });

  await check("概要: 3 年後の分布（2 本の棒・段の色・平均と 10〜90%）と行き先（10 行）・前提・見方", async () => {
    const d = await page.evaluate(() => ({
      bars: [...document.querySelectorAll(".imp-overview .imp-dist-bar")].map((b) => b.querySelectorAll(".imp-dist-seg").length),
      labels: [...document.querySelectorAll(".imp-overview .imp-dist-label")].map((x) => x.textContent),
      height: document.querySelector(".imp-overview .imp-dist-bar")?.getBoundingClientRect().height,
      text: document.querySelector(".imp-overview .imp-dist-text")?.textContent ?? "",
      ends: [...document.querySelectorAll(".imp-overview .imp-end-row")].map((r) => ({ g: r.querySelector(".imp-pill")?.textContent, pct: r.querySelector(".imp-end-pct")?.textContent })),
      legend: document.querySelector(".imp-overview .imp-legend")?.textContent ?? "",
      premise: document.querySelector(".imp-overview .imp-premise")?.textContent ?? "",
    }));
    assert(d.bars.length === 2 && d.bars.every((n) => n >= 1), `分布の棒 ${JSON.stringify(d.bars)}`);
    assert(d.labels[0] === "おすすめ" && d.labels[1] === "ずっと今のまま", `分布の名前 ${d.labels}`);
    assert(Math.round(d.height) === 14, `分布の棒の高さ ${d.height}`);
    assert(/^平均 [\d,]+万（[+−][\d,.]+万）· 10〜90%: [\d,]+〜[\d,]+万 · 今のままより悪くなる \d+%$/.test(d.text), `分布の文: ${d.text}`);
    assert(d.ends.length === 10 && d.ends.every((e) => /%$/.test(e.pct ?? "") && /^([+−][\d,.]+万|±0)$/.test(e.g ?? "")), `行き先 ${JSON.stringify(d.ends.slice(0, 3))}`);
    for (const s of ["塗りの数字: その手を今やると、3 年の稼ぎが今のままよりどれだけ変わるか（どちらもその後は一番良い選び方）", "% の札: その結果になる見込み。色はその結果の良し悪し（今のままと比べて）", "★ おすすめ（2 位より 10 万円以上良い）・≒ 一番から 10 万円以内・✓ 選んだ手", "月+2.1万: 3 年後の月の稼ぎの差"])
      assert(d.legend.includes(s), `見方に「${s}」が無い`);
    assert(d.premise.includes("数字はモデルの目安です"), "前提の注意が無い");
    await page.locator(".imp-premises summary").click();
    // 開いた知らせ（toggle）は後から届く
    await page.locator(".imp-premise-list li").first().waitFor({ timeout: 3000 });
    const items = await page.locator(".imp-premise-list li").count();
    assert(items >= 3, `前提の数 ${items}`);
    await page.locator(".imp-premises summary").click();
    assert((await page.getByRole("button", { name: "全部ひらく" }).count()) === 1, "「全部ひらく」が無い");
  });

  await check("年収: 一度だけのお知らせの「入れる」で欄が開き、540 を入れると計算し直し、元に戻せる", async () => {
    const before = await impactOf(page);
    const offer = page.locator(".toast", { hasText: "年収（額面）を入れると、本業の数字が合います（いまは仮に 360 万円）" });
    // 「開きました」のお知らせが消えてから出る（重ねない）
    await offer.waitFor({ timeout: 20000 });
    const others = await page.evaluate(() => [...document.querySelectorAll(".toast:not(.closing) .toast-text")].map((t) => t.textContent));
    assert(others.length === 1, `ほかのお知らせと重なった: ${others.join(" / ")}`);
    await offer.getByRole("button", { name: "入れる" }).click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("imp-salary-input"));
    // 範囲の外は受け付けない
    await page.keyboard.press("Control+a");
    await page.keyboard.type("50");
    await page.keyboard.press("Enter");
    const err = (await page.locator(".imp-overview .imp-salary-err").textContent()) ?? "";
    assert(err.includes("100〜3,000 万円"), `範囲の外の知らせ: ${err}`);
    await page.keyboard.press("Control+a");
    await page.keyboard.type("540");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const after = await impactOf(page);
    assert(after.annual === 540 && after.annualSet, `年収 ${after.annual}`);
    const stored = await page.evaluate((r) => window.__fourD.store.doc.nodes[r].meta.impact.annual, after.root);
    assert(stored === 540, `入口に年収が無い: ${stored}`);
    const t = await page.evaluate(() => ({ salary: document.querySelector(".imp-overview .imp-salary")?.textContent, kari: !document.querySelector(".imp-overview .imp-kari")?.hidden }));
    assert(/年収（額面）540 万円で計算中/.test(t.salary ?? "") && !t.kari, `年収の行: ${t.salary}`);
    assert(Math.abs(after.vRoot - before.vRoot) > 1, "3 年の稼ぎが変わらない");
    const changed = after.alts.filter((a) => {
      const b = before.alts.find((x) => x.id === a.id);
      return a.delta !== null && b.delta !== null && Math.abs(a.delta - b.delta) > 0.05;
    });
    assert(changed.length > 0, "今日の手の札が変わらない");
    // 札の表示も変わる（同じフレームの後）
    const pill = await page.evaluate((id) => document.querySelector(`.imp-overview .imp-alt-row[data-id="${id}"] .imp-pill`)?.textContent, changed[0].id);
    assert(Math.abs(num(pill) - changed[0].delta) < (Math.abs(changed[0].delta) < 10 ? 0.06 : 0.6), `札 ${pill} / ${changed[0].delta}`);
    await shot("impact-desktop-salary", page);
    await page.locator(".graph-canvas").focus();
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(200);
    const undone = await impactOf(page);
    assert(!undone.annualSet && undone.annual === 360 && Math.abs(undone.vRoot - before.vRoot) < 1e-6, `元に戻らない: ${undone.annual}`);
    assert(!(await page.locator(".imp-overview .imp-kari").evaluate((x) => x.hidden)), "（仮）に戻らない");
  });

  await check("概要: 欄の順（見出し → 今決めること → 3 年でやる価値が大きい手 → 避けたい手 → この先の大事な判断 → 分布 → 行き先 → 前提 → 見方 → ボタン）", async () => {
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({
      order: [...document.querySelectorAll(".imp-overview > *")].filter((e) => !e.hidden).map((e) => [...e.classList].find((c) => c.startsWith("imp-") && c !== "imp-sec") ?? e.className),
      labels: [...document.querySelectorAll(".imp-overview > .imp-sec:not([hidden]) > h3.insp-label")].map((x) => [x.firstChild?.textContent ?? "", x.querySelector(".insp-count")?.textContent ?? ""]),
    }));
    const want = ["imp-head", "imp-decide", "imp-worth", "imp-avoid", "imp-keys", "imp-dist", "imp-ends", "imp-premise", "imp-legend", "imp-actions"];
    assert(JSON.stringify(r.order) === JSON.stringify(want), `欄の順 ${r.order.join(",")}`);
    const at = (name) => r.labels.find((l) => l[0] === name);
    assert(at("3 年でやる価値が大きい手")?.[1] === "ずっと使わない場合との差", `やる価値の見出し ${JSON.stringify(r.labels)}`);
    assert(at("避けたい手")?.[1] === "出てくる所の差の平均", `避けたい手の見出し ${JSON.stringify(r.labels)}`);
    assert(at("この先の大事な判断")?.[1] === "来る見込み × 差の大きさの順", `大事な判断の見出し ${JSON.stringify(r.labels)}`);
    const names = r.labels.map((l) => l[0]);
    const idx = ["今決めること", "3 年でやる価値が大きい手", "避けたい手", "この先の大事な判断", "3 年後の分布", "3 年後の行き先", "見方"].map((n) => names.indexOf(n));
    assert(idx.every((i, k) => i >= 0 && (k === 0 || i > idx[k - 1])), `見出しの順 ${names.join(",")}`);
  });

  /** 概要の手の種類の行（やる価値・避けたい手） */
  const famRows = (p, sec) =>
    p.evaluate(
      (s) =>
        [...document.querySelectorAll(`.imp-overview .imp-${s} .imp-rank-row`)].map((b) => ({
          fam: b.dataset.fam,
          fk: b.dataset.fk,
          pill: b.querySelector(".imp-pill")?.textContent ?? "",
          name: b.querySelector(".imp-rank-name")?.textContent ?? "",
          area: b.querySelector(".imp-area")?.textContent ?? "",
          meta: b.querySelector(".imp-rank-meta")?.textContent ?? "",
          n: Number(/地図に ([\d,]+) か所/.exec(b.textContent)?.[1].replace(/,/g, "") ?? NaN),
        })),
      sec,
    );
  /** 選んでいるカードとその手の種類（meta.fam、無ければ meta.ak） */
  const selectedFam = (p) =>
    p.evaluate(() => {
      const f = window.__fourD;
      const id = [...f.ui.selection.nodes][0] ?? null;
      const n = id ? f.store.doc.nodes[id] : null;
      return { id, count: f.ui.selection.nodes.size, fam: n ? (typeof n.meta.fam === "string" ? n.meta.fam : (n.meta.ak ?? null)) : null };
    });

  await check("概要: 3 年でやる価値が大きい手（差の札の大きい順・どれも +・名前・地図に N か所）と避けたい手（どれも −）", async () => {
    const r = await page.evaluate(() => {
      const f = window.__fourD;
      return { fams: f.store.doc.nodes[f.app.vm.impact.root].meta.fams ?? {}, avoidShown: !document.querySelector(".imp-overview .imp-avoid")?.hidden };
    });
    const worth = await famRows(page, "worth");
    assert(worth.length >= 1 && worth.length <= 5, `やる価値の行の数 ${worth.length}`);
    const vals = worth.map((w) => num(w.pill));
    assert(vals.every((v) => v > 0), `+ でない札 ${worth.map((w) => w.pill).join(",")}`);
    for (let i = 1; i < vals.length; i++) assert(vals[i - 1] >= vals[i], `差の札の大きい順になっていない: ${worth.map((w) => w.pill).join(",")}`);
    for (const w of worth) {
      assert(w.fk === `worth:${w.fam}` && w.name === r.fams[w.fam], `行 ${JSON.stringify(w)}`);
      assert(w.n >= 1 && w.meta === (w.n >= 2 ? `地図に ${w.n} か所 · 次: 1 / ${w.n}` : `地図に ${w.n} か所`), `2 行目 ${w.meta}`);
      assert(w.area !== "", `領域の札が無い ${w.name}`);
    }
    const avoid = await famRows(page, "avoid");
    assert(r.avoidShown && avoid.length >= 1 && avoid.length <= 3, `避けたい手 ${avoid.length}`);
    for (const a of avoid) assert(num(a.pill) < 0 && a.fk === `avoid:${a.fam}` && a.name === r.fams[a.fam] && /^地図に \d+ か所/.test(a.meta), `避けたい手の行 ${JSON.stringify(a)}`);
    for (let i = 1; i < avoid.length; i++) assert(num(avoid[i - 1].pill) <= num(avoid[i].pill), `悪い順になっていない ${avoid.map((a) => a.pill).join(",")}`);
  });

  await check("概要: やる価値・避けたい手の行を押すと、その種類のカードを選んで寄り、もう一度押すと次の出てくる所へ（数が変わったら最初から）", async () => {
    const u0 = await undoCount(page);
    try {
      await famCycle();
    } finally {
      await undoTo(page, u0);
    }
  });
  async function famCycle() {
    for (const sec of ["worth", "avoid"]) {
      await page.evaluate(() => window.__fourD.ui.clearSelection());
      await page.waitForTimeout(150);
      const row = (await famRows(page, sec)).find((x) => x.n >= 2);
      assert(row, `${sec}: 出てくる所が 2 つ以上の行が無い`);
      const sel = `.imp-overview [data-fk="${row.fk}"]`;
      const nextText = () => page.locator(`${sel} .imp-rank-next`).textContent();
      assert((await nextText()) === `次: 1 / ${row.n}`, `${sec}: 押す前 ${await nextText()}`);
      await page.locator(sel).click();
      await page.waitForTimeout(250);
      const a = await selectedFam(page);
      assert(a.count === 1 && a.fam === row.fam, `${sec}: 1 回目に選んだカード ${JSON.stringify(a)} / ${row.fam}`);
      assert(await onScreen(page, a.id), `${sec}: 選んだカードが画面に入らない`);
      // マウスで押した後は、パネルの入れ物にフォーカス（押した行は詳細に変わって消える）
      assert(await page.evaluate(() => !!document.activeElement?.classList.contains("insp-focus-park")), `${sec}: 押した後のフォーカス`);
      // 概要へ戻ると、次は 2 つ目
      await page.evaluate(() => window.__fourD.ui.clearSelection());
      await page.waitForTimeout(150);
      assert((await nextText()) === `次: 2 / ${row.n}`, `${sec}: 1 回押した後 ${await nextText()}`);
      await page.locator(sel).click();
      await page.waitForTimeout(250);
      const b = await selectedFam(page);
      assert(b.count === 1 && b.fam === row.fam && b.id !== a.id, `${sec}: 2 回目に選んだカード ${JSON.stringify(b)} / ${JSON.stringify(a)}`);
      // キーボード（Enter）でも次へ
      await page.evaluate(() => window.__fourD.ui.clearSelection());
      await page.waitForTimeout(150);
      await page.locator(sel).focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(250);
      const c = await selectedFam(page);
      assert(c.fam === row.fam && c.id !== b.id && (row.n === 2 ? c.id === a.id : c.id !== a.id), `${sec}: 3 回目（Enter）${JSON.stringify(c)}`);
      assert(await page.evaluate(() => !!document.activeElement?.closest(".imp-node")), `${sec}: Enter の後、選んだ手の詳細へフォーカスが移らない`);
    }
    // 数が変わると最初から（年収を変える）
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(150);
    const row = (await famRows(page, "worth")).find((x) => x.n >= 2);
    assert(!/次: 1 \//.test(row.meta), `押した後なのに最初のまま ${row.meta}`);
    await page.evaluate(() => {
      const f = window.__fourD;
      const r = f.store.doc.nodes[f.app.vm.impact.root];
      f.app.cmd.updateNode(r.id, { meta: { ...r.meta, impact: { ...r.meta.impact, annual: 380 } } });
    });
    await page.waitForTimeout(200);
    const again = (await famRows(page, "worth")).find((x) => x.fam === row.fam);
    assert(again && /次: 1 \//.test(again.meta), `数が変わっても最初に戻らない ${again?.meta}`);
  }

  await check("概要: この先の大事な判断（6 行まで・来る見込みと差・一番の手）。押すとその判断のカードを選び、詳細に選べる手が出る", async () => {
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(150);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".imp-overview .imp-keys .imp-rank-row")].map((b) => {
        const f = window.__fourD;
        return { id: b.dataset.id, fk: b.dataset.fk, name: b.querySelector(".imp-rank-name")?.textContent, title: f.store.doc.nodes[b.dataset.id]?.title, kind: f.app.vm.impact.kind.get(b.dataset.id), meta: [...b.querySelectorAll(".imp-rank-meta")].map((m) => m.textContent) };
      }),
    );
    assert(rows.length >= 1 && rows.length <= 6, `大事な判断の行の数 ${rows.length}`);
    for (const r of rows) {
      assert(r.fk === `key:${r.id}` && r.name === r.title && r.kind === "decision", `行 ${JSON.stringify(r)}`);
      assert(/^来る見込み \d+%・この判断で最大 \+[\d,.]+万の差$/.test(r.meta[0] ?? ""), `2 行目 ${r.meta[0]}`);
      assert(r.meta.length === 1 || /^一番: .+/.test(r.meta[1] ?? ""), `一番の手 ${r.meta[1]}`);
    }
    const k = rows[Math.min(1, rows.length - 1)];
    await page.locator(`.imp-overview [data-fk="key:${k.id}"]`).click();
    await page.waitForTimeout(250);
    const s = await page.evaluate(() => ({ sel: [...window.__fourD.ui.selection.nodes], sibs: document.querySelectorAll(".imp-node .imp-sibs .imp-alt-row").length, box: !!document.activeElement?.classList.contains("insp-focus-park") }));
    assert(s.sel.length === 1 && s.sel[0] === k.id, `選んだカード ${JSON.stringify(s.sel)} / ${k.id}`);
    assert(s.sibs >= 2 && s.box, `判断の詳細 ${JSON.stringify(s)}`);
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  });

  await check("キーボード: やる価値・大事な判断の行にいる間に数が変わって概要を作り直しても、同じ行にフォーカスが残る", async () => {
    const u0 = await undoCount(page);
    try {
      await page.evaluate(() => window.__fourD.ui.clearSelection());
      await page.waitForTimeout(150);
      for (const fk of [(await famRows(page, "worth"))[0].fk, await page.locator(".imp-overview .imp-keys .imp-rank-row").first().getAttribute("data-fk")]) {
        await page.locator(`.imp-overview [data-fk="${fk}"]`).focus();
        await page.evaluate(() => (window.__el0 = document.activeElement));
        const annual = 380 + (await undoCount(page));
        await page.evaluate((a) => {
          const f = window.__fourD;
          const r = f.store.doc.nodes[f.app.vm.impact.root];
          f.app.cmd.updateNode(r.id, { meta: { ...r.meta, impact: { ...r.meta.impact, annual: a } } });
        }, annual);
        await page.waitForTimeout(200);
        const r = await page.evaluate(() => ({ fk: document.activeElement?.dataset?.fk ?? document.activeElement?.tagName, rebuilt: document.activeElement !== window.__el0 }));
        assert(r.fk === fk && r.rebuilt, `作り直した後のフォーカス ${JSON.stringify(r)} / ${fk}`);
      }
    } finally {
      await undoTo(page, u0);
    }
  });

  let alt2 = null;
  await check("選択肢: 今決めることの 2 行目を押すと選んで寄り、3 年の影響・内訳（合計と同じ）・結果・同じ判断の手・ボタンが出る", async () => {
    const imp = await impactOf(page);
    const rowId = await page.locator(".imp-overview .imp-decide .imp-alt-row").nth(1).getAttribute("data-id");
    alt2 = rowId;
    await page.locator(".imp-overview .imp-decide .imp-alt-row").nth(1).click();
    await page.waitForTimeout(500);
    const sel = await page.evaluate(() => [...window.__fourD.ui.selection.nodes]);
    assert(sel.length === 1 && sel[0] === rowId, `選択 ${sel}`);
    assert(await onScreen(page, rowId), "選んだカードが画面に入らない");
    const a = imp.alts.find((x) => x.id === rowId);
    const p = await page.evaluate(() => {
      const box = document.querySelector(".imp-node.is-alt");
      return {
        hl: box?.querySelector(".imp-hl")?.textContent ?? "",
        note: box?.querySelector(".imp-note")?.textContent ?? "",
        facts: box?.querySelector(".imp-facts")?.textContent ?? "",
        total: box?.querySelector(".imp-split .insp-count")?.textContent ?? "",
        split: [...(box?.querySelectorAll(".imp-split-val") ?? [])].map((x) => x.textContent),
        outs: box?.querySelectorAll(".imp-out-row").length ?? 0,
        sibs: [...(box?.querySelectorAll(".imp-sibs .imp-alt-row") ?? [])].map((r) => ({ id: r.dataset.id, cur: r.classList.contains("is-current") })),
        kari: box?.querySelector(".imp-kari-note")?.textContent ?? "",
        buttons: [...(box?.querySelectorAll(".imp-picks .btn") ?? [])].map((b) => b.textContent),
        todo: [...document.querySelectorAll(".insp-node .insp-section .insp-label")].map((x) => x.firstChild?.textContent),
      };
    });
    assert(/^3 年の稼ぎ: 今のままより[+−][\d,.]+ 万円$/.test(p.hl), `見出し: ${p.hl}`);
    assert(p.note === "（この期間に何もせず、その後は一番良い選び方をした場合と比べて）", `注: ${p.note}`);
    assert(/この手を 3 年間ずっとやらない場合と比べると [+−±]/.test(p.facts), `ずっとやらない: ${p.facts}`);
    assert(/3 年後の月の稼ぎ: 月 [+−±]/.test(p.facts) && /悪くなる見込み \d+%/.test(p.facts) && /週の時間 [+−±][\d.]* ?時間（今は 52 時間）/.test(p.facts), `数: ${p.facts}`);
    const shown = num(p.total.replace("合計 ", ""));
    const sum = p.split.reduce((s, x) => s + num(x), 0);
    assert(p.split.length === 3 && Math.abs(sum - shown) < 1e-6, `内訳 ${p.split.join(" ")} の合計 ${sum} / ${p.total}`);
    assert(Math.abs(shown - a.delta) < (Math.abs(a.delta) < 10 ? 0.06 : 0.6), `内訳の合計 ${shown} / ${a.delta}`);
    assert(p.outs === a.outcomes.length, `結果の行 ${p.outs} / ${a.outcomes.length}`);
    assert(p.sibs.length === 10 && p.sibs.filter((s) => s.cur).length === 1 && p.sibs.find((s) => s.cur).id === rowId, `同じ判断の手 ${JSON.stringify(p.sibs)}`);
    assert(p.kari.includes("年収が仮（360 万円）なので本業の数字は目安です"), `年収の注: ${p.kari}`);
    assert(p.buttons.some((b) => b.includes("これにする")) && p.buttons.some((b) => b.includes("見送る")) && p.buttons.some((b) => b.includes("選び直す")), `ボタン ${p.buttons}`);
    assert(p.todo.indexOf("やること") >= 0 && p.todo.indexOf("やること") < p.todo.indexOf("文章"), `やることが文章の前に無い: ${p.todo}`);
    await shot("impact-desktop-alt", page);
  });

  await check("選択肢: 「これにする」で見出しが「あなたの選び方で…（おすすめとの差）」になり、★ はそのまま。「選び直す」で戻る", async () => {
    const before = await impactOf(page);
    assert(alt2 && alt2 !== before.best, "2 行目がおすすめと同じ");
    await page.locator(".imp-node.is-alt .imp-picks .btn", { hasText: "これにする" }).click();
    await page.waitForTimeout(200);
    const after = await impactOf(page);
    assert(after.alts.find((a) => a.id === alt2).status === "active" && after.hasPicks, "進行中にならない");
    const pressed = await page.locator(".imp-node.is-alt .imp-pick").getAttribute("aria-pressed");
    assert(pressed === "true", "「これにした」にならない");
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(200);
    const main = (await page.locator(".imp-overview .imp-hl-main").textContent()) ?? "";
    assert(/^あなたの選び方で 3 年 [\d,]+ 万円（おすすめとの差 −[\d,.]+ 万円）$/.test(main), `見出し: ${main}`);
    const marks = await page.evaluate(() => [...document.querySelectorAll(".imp-overview .imp-decide .imp-alt-row")].map((r) => ({ id: r.dataset.id, mark: r.querySelector(".imp-mark").textContent })));
    // おすすめの印（★ か ≒）は、自分で選んでも一番良い手から動かない
    const bestMark = marks.find((m) => m.id === before.best).mark;
    assert(bestMark.includes("★") || bestMark.includes("≒"), `★ が動いた ${JSON.stringify(marks)}`);
    assert(marks.find((m) => m.id === alt2).mark.includes("✓"), "選んだ手に ✓ が無い");
    assert((await page.locator(".imp-overview .imp-dist-label").first().textContent()) === "あなたの選び方", "分布の名前が変わらない");
    await page.evaluate((id) => window.__fourD.ui.select([id]), alt2);
    await page.locator(".imp-node.is-alt .imp-picks .btn", { hasText: "選び直す" }).click();
    await page.waitForTimeout(200);
    const back = await impactOf(page);
    assert(!back.hasPicks && Math.abs(back.vRoot - before.vRoot) < 1e-6, "選び直しで戻らない");
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(100);
    assert(/^おすすめの選び方で/.test((await page.locator(".imp-overview .imp-hl-main").textContent()) ?? ""), "見出しがおすすめに戻らない");
  });

  await check("選択肢: 同じ判断で別の手を「これにする」と、前に選んだ手は未着手に戻り、✓ と見出しはあとの手に移る（1 回で元に戻せる）", async () => {
    const u0 = await undoCount(page);
    try {
      await pickTwo();
    } finally {
      await undoTo(page, u0);
    }
  });
  async function pickTwo() {
    const before = await impactOf(page);
    const others = before.alts.filter((x) => !x.isBase && x.id !== before.best && x.delta !== null);
    const a = others[0];
    const b = others[1];
    assert(a && b, "選べる手が足りない（確かめの前提）");
    for (const x of [a, b]) {
      await page.evaluate((id) => window.__fourD.ui.select([id]), x.id);
      await page.waitForTimeout(150);
      await page.locator(".imp-node.is-alt .imp-picks .btn", { hasText: "これにする" }).click();
      await page.waitForTimeout(150);
    }
    const after = await impactOf(page);
    const st = (s, id) => s.alts.find((x) => x.id === id).status;
    assert(st(after, a.id) === "open" && st(after, b.id) === "active", `状態 ${st(after, a.id)} / ${st(after, b.id)}`);
    const r = await page.evaluate(() => {
      const f = window.__fourD;
      const imp = f.app.vm.impact;
      return { chosen: imp.decision.get(imp.root).chosen, undo: f.store.history.undoStack.at(-1)?.label };
    });
    assert(r.chosen === b.id, "あとで選んだ手で計算していない");
    assert(r.undo === `「${b.title}」にする`, `元に戻すの名前 ${r.undo}`);
    // あとの手だけを選んだ数（おすすめとの差 = その手とおすすめの手の差）
    const best = before.alts.find((x) => x.id === before.best);
    assert(Math.abs(after.vRoot - (before.vRoot + b.delta - best.delta)) < 1e-6, `3 年の稼ぎ ${after.vRoot} / ${before.vRoot + b.delta - best.delta}`);
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(150);
    const main = (await page.locator(".imp-overview .imp-hl-main").textContent()) ?? "";
    assert(/^あなたの選び方で 3 年 [\d,]+ 万円（おすすめとの差 −[\d,.]+ 万円）$/.test(main) && Math.abs(num(main.replace(/^あなたの選び方で 3 年 /, "").replace(/（.*$/, "")) - after.vRoot) < 1, `見出し: ${main}`);
    const picked = await page.evaluate(() => [...document.querySelectorAll(".imp-overview .imp-decide .imp-alt-row")].filter((x) => x.querySelector(".imp-mark").textContent.includes("✓")).map((x) => x.dataset.id));
    assert(picked.length === 1 && picked[0] === b.id, `✓ の行 ${JSON.stringify(picked)}`);
    // 1 回で両方が戻る（前の手を選んだ所へ）、もう 1 回で何も選んでいない形へ
    await page.evaluate(() => window.__fourD.app.cmd.undo());
    const back1 = await impactOf(page);
    assert(st(back1, a.id) === "active" && st(back1, b.id) === "open", `1 回戻した状態 ${st(back1, a.id)} / ${st(back1, b.id)}`);
    await page.evaluate(() => window.__fourD.app.cmd.undo());
    const back2 = await impactOf(page);
    assert(!back2.hasPicks && Math.abs(back2.vRoot - before.vRoot) < 1e-6, "選ぶ前に戻らない");
  }

  await check("キーボード: 「これにする」「見送る」「選び直す」・年収の欄・今決めることの行を押した後も、フォーカスはパネルに残り、次の Tab・Backspace で地図を変えない", async () => {
    const u0 = await undoCount(page);
    try {
      await keyboardFocus();
    } finally {
      await undoTo(page, u0);
    }
  });
  async function keyboardFocus() {
    const imp = await impactOf(page);
    const alt = imp.alts.find((x) => !x.isBase && x.id !== imp.best && x.delta !== null).id;
    const count = () => page.evaluate(() => Object.keys(window.__fourD.store.doc.nodes).length);
    const fk = () => page.evaluate(() => (document.activeElement?.closest(".sidebar-right") ? (document.activeElement.dataset.fk ?? document.activeElement.className) : document.activeElement?.tagName));
    const status = () => page.evaluate((id) => window.__fourD.store.doc.nodes[id].status, alt);
    const n0 = await count();
    await page.evaluate((id) => window.__fourD.ui.select([id]), alt);
    await page.waitForTimeout(150);
    // タイトルの欄から Tab で「これにする」へ進み、Enter
    await page.locator(".insp-title").focus();
    for (let i = 0; i < 40 && (await fk()) !== `pick:${alt}`; i++) await page.keyboard.press("Tab");
    assert((await fk()) === `pick:${alt}`, `Tab で「これにする」へ行けない（${await fk()}）`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert((await status()) === "active", "Enter で選べない");
    assert((await fk()) === `redo:${alt}`, `「これにする」の後のフォーカス ${await fk()}`);
    // 「これにした」へ戻ってから、ほかの手の変更で作り直しても、同じ部品に残る（「選び直す」へは、押した直後だけ）
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    assert((await fk()) === `pick:${alt}`, `Shift+Tab で「これにした」へ戻れない（${await fk()}）`);
    const other = imp.alts.find((x) => !x.isBase && x.id !== alt && x.id !== imp.best).id;
    await page.evaluate((id) => window.__fourD.app.cmd.setStatus([id], "dropped"), other);
    await page.waitForTimeout(150);
    assert((await fk()) === `pick:${alt}`, `ほかの手の変更で、フォーカスが「これにした」から動いた（${await fk()}）`);
    await page.evaluate(() => window.__fourD.app.cmd.undo());
    await page.locator(`.imp-node [data-fk="redo:${alt}"]`).focus();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    assert((await count()) === n0 && (await fk()) !== "BODY", `Tab でノードが増えた・フォーカスが外れた（${await fk()}）`);
    // 「選び直す」の後は「これにする」へ
    await page.locator(`.imp-node [data-fk="redo:${alt}"]`).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert((await status()) === "open" && (await fk()) === `pick:${alt}`, `「選び直す」の後のフォーカス ${await fk()}`);
    // 「見送る」の後は「選び直す」へ。Backspace で選択肢を消さない
    await page.locator(`.imp-node [data-fk="drop:${alt}"]`).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert((await status()) === "dropped" && (await fk()) === `redo:${alt}`, `「見送る」の後のフォーカス ${await fk()}`);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(150);
    assert((await count()) === n0 && (await page.evaluate((id) => !!window.__fourD.store.doc.nodes[id], alt)), "Backspace で選択肢が消えた");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert((await status()) === "open", "選び直せない");
    // 今日の年収: 「変える」→ 入れて Enter → 「変える」へ戻る。入力中は同期の取り込みを待つ（入力の途中と見なす）
    await page.evaluate((id) => window.__fourD.ui.select([id]), imp.root);
    await page.waitForTimeout(150);
    await page.locator(".imp-node.is-root .imp-salary-change").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.classList.contains("imp-salary-input"));
    assert(await page.evaluate(() => window.__fourD.app.editingNow()), "年収の欄に入力中を、入力の途中と見なさない");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("540");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    assert((await page.evaluate(() => window.__fourD.app.vm.impact.annual)) === 540, "年収が変わらない");
    assert((await fk()) === "salary", `年収を決めた後のフォーカス ${await fk()}`);
    assert(!(await page.evaluate(() => window.__fourD.app.editingNow())), "欄を閉じても入力の途中のまま");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    assert((await count()) === n0, "年収の後の Tab でノードが増えた");
    await page.locator(".imp-node.is-root .imp-salary-change").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.classList.contains("imp-salary-input"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert((await fk()) === "salary", `年収の欄をやめた後のフォーカス ${await fk()}`);
    await page.evaluate(() => window.__fourD.app.cmd.undo());
    assert((await page.evaluate(() => window.__fourD.app.vm.impact.annualSet)) === false, "年収が仮に戻らない");
    // 概要の今決めることの行を Enter: 選んだ手の詳細の最初の部品（これにする）へ
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(150);
    const rowId = await page.locator(".imp-overview .imp-decide .imp-alt-row").nth(2).getAttribute("data-id");
    await page.locator(`.imp-overview [data-fk="row:${rowId}"]`).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    assert((await page.evaluate(() => [...window.__fourD.ui.selection.nodes][0])) === rowId, "行の手が選ばれない");
    assert((await fk()) === `pick:${rowId}`, `行を押した後のフォーカス ${await fk()}`);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    assert((await count()) === n0, "行の後の Tab でノードが増えた");
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  }

  await check("マウス: 今決めることの行・「これにする」「見送る」「選び直す」を押した後は、押した部品ではなくパネルの入れ物にフォーカスを置く（続く Enter・Space で黙って選ばず、Tab・Backspace で地図を変えない）", async () => {
    const u0 = await undoCount(page);
    try {
      await mouseFocus();
    } finally {
      await page.evaluate(() => window.__fourD.app.editor.cancel());
      await undoTo(page, u0);
    }
  });
  async function mouseFocus() {
    const read = (id) =>
      page.evaluate((x) => {
        const f = window.__fourD;
        const a = document.activeElement;
        return {
          status: f.store.doc.nodes[x]?.status ?? null,
          sel: [...f.ui.selection.nodes].join(","),
          nodes: Object.keys(f.store.doc.nodes).length,
          editor: f.app.editor.active,
          box: !!a?.classList.contains("insp-focus-park"),
          inPanel: !!a?.closest(".sidebar-right"),
          undo: f.store.history.undoStack.at(-1)?.label ?? null,
        };
      }, id);
    /** 入れ物にいる間のキー: Enter・Space は何も押さない、Backspace は選んだ手を消さない（どれも地図・文書を変えない） */
    const keysDoNothing = async (id, what) => {
      const r0 = await read(id);
      assert(r0.box, `${what}: パネルの入れ物にフォーカスが無い ${JSON.stringify(r0)}`);
      for (const key of ["Enter", "Space", "Backspace", "Delete"]) {
        await page.keyboard.press(key);
        await page.waitForTimeout(120);
        const r1 = await read(id);
        assert(r1.status === r0.status && r1.undo === r0.undo && r1.nodes === r0.nodes && r1.sel === r0.sel && !r1.editor && r1.box, `${what} の後の ${key} ${JSON.stringify({ r0, r1 })}`);
      }
    };
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(150);
    const id = await page.locator(".imp-overview .imp-decide .imp-alt-row").nth(2).getAttribute("data-id");
    await page.locator(`.imp-overview [data-fk="row:${id}"]`).click();
    await page.waitForTimeout(300);
    assert((await page.evaluate(() => [...window.__fourD.ui.selection.nodes][0])) === id, "行の手が選ばれない");
    await keysDoNothing(id, "今決めることの行");
    // Tab はパネルの最初の部品へ（分岐を足さない）
    const n0 = (await read(id)).nodes;
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    const t = await read(id);
    assert(t.nodes === n0 && !t.editor && t.inPanel && !t.box, `行の後の Tab ${JSON.stringify(t)}`);
    // 「これにする」「見送る」「選び直す」をマウスで: 押した部品は作り直しで消える。入れ物に置き、次のキーで選び直さない・消さない
    for (const [fk, want] of [
      ["pick", "active"],
      ["drop", "dropped"],
      ["redo", "open"],
    ]) {
      await page.locator(`.imp-node [data-fk="${fk}:${id}"]`).click();
      await page.waitForTimeout(150);
      assert((await read(id)).status === want, `マウスで ${fk} を押した後の状態 ${(await read(id)).status}`);
      await keysDoNothing(id, fk);
    }
    await page.locator(`.imp-node [data-fk="pick:${id}"]`).click();
    await page.waitForTimeout(150);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    const t2 = await read(id);
    assert(t2.nodes === n0 && !t2.editor && t2.inPanel && t2.status === "active", `「これにする」の後の Tab ${JSON.stringify(t2)}`);
    // 入れ物に置いた後も、キャンバスを押せば今までどおりキャンバスのキー（Escape で選択を外せる）
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert((await page.evaluate(() => window.__fourD.ui.selection.nodes.size)) === 0, "Escape で選択が外れない");
  }

  await check("マウス: パネルの何も無い所（見出し）を押しても、フォーカスは置き場へ移らず、キャンバスのキー（Escape で選択を外す）は今までどおり効く", async () => {
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(150);
    const id = await page.locator(".imp-overview .imp-decide .imp-alt-row").nth(1).getAttribute("data-id");
    await page.evaluate((x) => window.__fourD.ui.select([x]), id);
    await page.waitForTimeout(200);
    await page.locator(".sidebar-right .insp-head").click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(100);
    const a = await page.evaluate(() => ({ park: !!document.activeElement?.classList.contains("insp-focus-park"), tag: document.activeElement?.tagName }));
    assert(!a.park && a.tag === "BODY", `見出しを押した後のフォーカス ${JSON.stringify(a)}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    assert((await page.evaluate(() => window.__fourD.ui.selection.nodes.size)) === 0, "見出しを押した後、Escape で選択が外れない");
  });

  await check("取り込み: フォーカスのあった欄・線・ノードが別の端末で消えたら、フォーカスはパネルの置き場へ移り、次のキーで地図もほかの欄も変えない", async () => {
    const u0 = await undoCount(page);
    try {
      await vanishedOnAdopt();
    } finally {
      await undoTo(page, u0);
    }
  });
  async function vanishedOnAdopt() {
    const st = () =>
      page.evaluate(() => {
        const f = window.__fourD;
        const a = document.activeElement;
        return { fk: a?.dataset?.fk ?? (a?.classList.contains("insp-focus-park") ? "box" : a?.tagName), nodes: Object.keys(f.store.doc.nodes).length, editor: f.app.editor.active, sel: [...f.ui.selection.nodes], caret: a?.selectionStart ?? null, len: a?.value?.length ?? null };
      });
    const editing = () => page.evaluate(() => window.__fourD.app.editingNow());
    const imp = await impactOf(page);
    const X = imp.alts.find((a) => !a.isBase && a.delta !== null).id;
    // (1) 条件（やること）の欄。別の端末でその項目が消えた: 同じカードの題名の欄へ（文字の位置は終わり）
    await page.evaluate((x) => {
      const f = window.__fourD;
      f.app.cmd.addCondition(x, "確かめる項目");
      f.ui.select([x]);
    }, X);
    await page.waitForTimeout(200);
    const cid = await page.evaluate((x) => window.__fourD.store.doc.nodes[x].conditions.at(-1).id, X);
    await page.locator(`[data-fk="cond:${cid}"]`).focus();
    assert(!(await editing()), "項目の欄にフォーカスがあるだけで、入力の途中と見なした（取り込みが待つので確かめにならない）");
    await page.evaluate(
      ([x, c]) => {
        const f = window.__fourD;
        const next = structuredClone(f.store.doc);
        next.nodes[x].conditions = next.nodes[x].conditions.filter((k) => k.id !== c);
        f.store.replaceDoc(next, "別の端末の内容を読み込む");
      },
      [X, cid],
    );
    await page.waitForTimeout(200);
    const a1 = await st();
    assert(a1.fk === "box" && a1.sel[0] === X, `項目が消えた後のフォーカス ${JSON.stringify(a1)}`);
    // 続けて打ったキーは、ほかの欄（題名）を黙って書き換えず、カードも消さない
    const t0 = await page.evaluate((x) => window.__fourD.store.doc.nodes[x].title, X);
    await page.keyboard.press("Backspace");
    await page.keyboard.type("xy");
    await page.waitForTimeout(150);
    const a2 = await st();
    const t1 = await page.evaluate((x) => window.__fourD.store.doc.nodes[x]?.title ?? null, X);
    assert(a2.nodes === a1.nodes && t1 === t0 && !a2.editor, `続くキーがカードを消した・題名を書き換えた ${JSON.stringify({ a1, a2, t0, t1 })}`);
    // (2) 題名の欄。別の端末でそのノードが消えた: 選択が外れて概要になり、入れ物へ
    const Y = await page.evaluate(() => {
      const f = window.__fourD;
      const id = f.app.cmd.createNode("action", { x: -3000, y: 0 }, { exact: true, title: "自分のメモ" });
      f.app.editor.cancel();
      f.ui.select([id]);
      return id;
    });
    await page.waitForTimeout(200);
    await page.locator(".insp-title").focus();
    assert(!(await editing()), "題名の欄にフォーカスがあるだけで、入力の途中と見なした");
    await page.evaluate((y) => {
      const f = window.__fourD;
      const next = structuredClone(f.store.doc);
      delete next.nodes[y];
      for (const [id, e] of Object.entries(next.edges)) if (e.source === y || e.target === y) delete next.edges[id];
      f.store.replaceDoc(next, "別の端末の内容を読み込む");
    }, Y);
    await page.waitForTimeout(200);
    const b1 = await st();
    assert(b1.fk === "box" && b1.sel.length === 0, `ノードが消えた後のフォーカス ${JSON.stringify(b1)}`);
    for (const key of ["n", "Tab"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(150);
    }
    const b2 = await st();
    assert(b2.nodes === b1.nodes && !b2.editor && b2.fk !== "BODY", `続くキーで地図を変えた ${JSON.stringify({ b1, b2 })}`);
    // (3) 線の説明の欄。別の端末でその線が消えた: 入れ物へ
    const E = await page.evaluate(() => {
      const f = window.__fourD;
      const a = f.app.cmd.createNode("action", { x: -3000, y: 600 }, { exact: true, title: "メモA" });
      const b = f.app.cmd.createNode("action", { x: -2700, y: 600 }, { exact: true, title: "メモB", from: [a] });
      f.app.editor.cancel();
      const e = Object.values(f.store.doc.edges).find((x) => x.source === a && x.target === b).id;
      f.ui.select([], [e]);
      return e;
    });
    await page.waitForTimeout(200);
    await page.locator('[data-fk="edge-label"]').focus();
    await page.evaluate((e) => {
      const f = window.__fourD;
      const next = structuredClone(f.store.doc);
      delete next.edges[e];
      f.store.replaceDoc(next, "別の端末の内容を読み込む");
    }, E);
    await page.waitForTimeout(200);
    const c1 = await st();
    assert(c1.fk === "box", `線が消えた後のフォーカス ${JSON.stringify(c1)}`);
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  }

  await check("入力欄: 打つたびに入れる欄（題名）・空のタグの欄にフォーカスがあるだけなら同期の取り込みを待たず、取り込んで作り直してもフォーカスと文字の位置が残る。書きかけのタグの間は待つ", async () => {
    const u0 = await undoCount(page);
    try {
      await inputsOnAdopt();
    } finally {
      await undoTo(page, u0);
    }
  });
  async function inputsOnAdopt() {
    const imp = await impactOf(page);
    const alt = imp.alts.find((x) => !x.isBase && x.delta !== null).id;
    await page.evaluate((id) => window.__fourD.ui.select([id]), alt);
    await page.waitForTimeout(150);
    const editing = () => page.evaluate(() => window.__fourD.app.editingNow());
    const fk = () => page.evaluate(() => (document.activeElement?.closest(".sidebar-right") ? (document.activeElement.dataset.fk ?? document.activeElement.className) : document.activeElement?.tagName));
    // 別の端末の内容を読み込む（同期の入れ替えと同じ。右のパネルは全部作り直す）
    const adopt = () =>
      page.evaluate(() => {
        const f = window.__fourD;
        const next = structuredClone(f.store.doc);
        const other = Object.values(next.nodes).find((n) => n.type === "goal");
        if (other) other.title += "（別の端末）";
        f.store.replaceDoc(next, "別の端末の内容を読み込む");
      });
    const t0 = await page.evaluate((id) => window.__fourD.store.doc.nodes[id].title, alt);
    await page.locator(".insp-title").focus();
    await page.evaluate(() => {
      window.__el0 = document.activeElement;
      document.activeElement.setSelectionRange(2, 2);
    });
    assert(!(await editing()), "題名の欄にフォーカスがあるだけで、入力の途中と見なした");
    await adopt();
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const a = document.activeElement;
      return { title: !!a?.classList.contains("insp-title"), rebuilt: a !== window.__el0, sel: [a?.selectionStart, a?.selectionEnd] };
    });
    assert(r.title && r.rebuilt && r.sel[0] === 2 && r.sel[1] === 2, `作り直した後のフォーカス・文字の位置 ${JSON.stringify(r)}`);
    await page.keyboard.type("！");
    await page.waitForTimeout(100);
    const t1 = await page.evaluate((id) => window.__fourD.store.doc.nodes[id].title, alt);
    assert(t1 === `${t0.slice(0, 2)}！${t0.slice(2)}`, `続けて打った文字 ${t1}`);
    // タグの欄: 空なら待たない。書きかけがあれば待つ
    await page.locator(".tag-input").focus();
    assert(!(await editing()), "空のタグの欄にフォーカスがあるだけで、入力の途中と見なした");
    await page.keyboard.type("書きかけ");
    assert(await editing(), "書きかけのタグを、入力の途中と見なさない");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    // キーボードで操作していたボタンは、作り直した後も同じ部品へ。マウスで押さえただけのボタンからは動かさない
    await page.locator(`.imp-node [data-fk="drop:${alt}"]`).focus();
    await adopt();
    await page.waitForTimeout(150);
    assert((await fk()) === `drop:${alt}`, `作り直した後のフォーカス（キーボード） ${await fk()}`);
    const box = await page.locator(`.imp-node [data-fk="drop:${alt}"]`).boundingBox();
    const hl = await page.locator(".imp-node.is-alt .imp-hl").boundingBox();
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(hl.x + 8, hl.y + hl.height / 2);
    await page.mouse.up();
    assert((await fk()) === `drop:${alt}`, `マウスで押さえたボタンにフォーカスが無い（確かめの前提） ${await fk()}`);
    await adopt();
    await page.waitForTimeout(150);
    assert(!(await page.evaluate(() => !!document.activeElement?.closest(".sidebar-right"))), `マウスで押さえただけのボタンへ、作り直した後もフォーカスを戻した ${await fk()}`);
    assert((await page.evaluate((id) => window.__fourD.store.doc.nodes[id].status, alt)) !== "dropped", "押さえただけで見送った");
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  }

  await check("題名の欄の変換中（IME）の 1 文字ずつは文書に入れず詳細も作り直さない。変換を決めたら入れる（作業メモ perf-9）", async () => {
    const imp = await impactOf(page);
    const alt = imp.alts.find((x) => !x.isBase && x.delta !== null).id;
    await page.evaluate((id) => window.__fourD.ui.select([id]), alt);
    await page.waitForTimeout(150);
    const r = await page.evaluate(async (id) => {
      const f = window.__fourD;
      const el = document.querySelector(".insp-title");
      const base = el.value;
      const rev0 = f.store.revision;
      const row0 = document.querySelector(".imp-node .imp-node-body > *");
      const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
      el.focus();
      el.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      for (const v of [`${base}て`, `${base}てん`, `${base}てんし`]) {
        el.value = v;
        el.dispatchEvent(new InputEvent("input", { data: v, inputType: "insertCompositionText", isComposing: true, bubbles: true }));
        await frame();
      }
      const during = { rev: f.store.revision, title: f.store.doc.nodes[id].title, same: !!row0 && document.querySelector(".imp-node .imp-node-body > *") === row0 };
      // Chrome は compositionend の後に input を送らない（決めた文字は compositionend の時の欄の中身）
      el.value = `${base}転`;
      el.dispatchEvent(new CompositionEvent("compositionend", { data: "転", bubbles: true }));
      await frame();
      const after = { rev: f.store.revision, title: f.store.doc.nodes[id].title, focus: document.activeElement === el };
      el.blur();
      return { base, rev0, during, after };
    }, alt);
    assert(r.during.rev === r.rev0 && r.during.title === r.base, `変換中の文字を文書に入れた ${JSON.stringify(r)}`);
    assert(r.during.same, "変換中の 1 文字で 3 年の影響の欄を作り直した");
    assert(r.after.rev > r.rev0 && r.after.title === `${r.base}転` && r.after.focus, `変換を決めた文字が入らない ${JSON.stringify(r)}`);
    await page.evaluate(() => window.__fourD.app.cmd.undo());
    await page.waitForTimeout(150);
    assert((await page.evaluate((id) => window.__fourD.store.doc.nodes[id].title, alt)) === r.base, "元に戻すで題名が戻らない");
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  });

  await check("詳細で題名を書き換えると、3 年の影響は計算し直さず、パネルの行の題名はすぐ変わる", async () => {
    const u0 = await undoCount(page);
    try {
      await retitle();
    } finally {
      await undoTo(page, u0);
    }
  });
  async function retitle() {
    const imp = await impactOf(page);
    const alt = imp.alts.find((x) => !x.isBase && x.delta !== null).id;
    await page.evaluate((id) => window.__fourD.ui.select([id]), alt);
    await page.waitForTimeout(150);
    await page.evaluate(() => void (window.__imp0 = window.__fourD.app.vm.impact));
    await page.locator(".insp-title").focus();
    await page.keyboard.press("End");
    await page.keyboard.type("（書き換え）");
    await page.waitForTimeout(150);
    const r = await page.evaluate((id) => ({
      same: window.__fourD.app.vm.impact === window.__imp0,
      title: window.__fourD.store.doc.nodes[id].title,
      row: document.querySelector(`.imp-node .imp-sibs .imp-alt-row[data-id="${id}"] .imp-alt-name`)?.textContent,
      focus: document.activeElement?.classList.contains("insp-title"),
    }), alt);
    assert(r.title.endsWith("（書き換え）"), `題名 ${r.title}`);
    assert(r.same, "題名の入力で 3 年の影響を計算し直した");
    assert(r.row === r.title, `同じ判断の手の行 ${r.row}`);
    assert(r.focus, "入力中の題名の欄からフォーカスが外れた");
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.waitForTimeout(150);
    const row = await page.evaluate((id) => document.querySelector(`.imp-overview .imp-decide .imp-alt-row[data-id="${id}"] .imp-alt-name`)?.textContent, alt);
    assert(row === r.title, `今決めることの行 ${row}`);
    await page.evaluate(() => window.__fourD.app.cmd.undo());
    await page.waitForTimeout(150);
    const back = await page.evaluate((id) => ({ title: window.__fourD.store.doc.nodes[id].title, row: document.querySelector(`.imp-overview .imp-decide .imp-alt-row[data-id="${id}"] .imp-alt-name`)?.textContent }), alt);
    assert(!back.title.endsWith("（書き換え）") && back.row === back.title, `元に戻した題名 ${JSON.stringify(back)}`);
  }

  await check("概要の「全部ひらく」は 3 年の分かれ道だけを見え方で開く（自分で折りたたんだノード・文書・元に戻すはそのまま。閲覧のみでもお知らせを出さない）", async () => {
    const own = await page.evaluate(() => {
      const f = window.__fourD;
      const id = f.app.cmd.createNode("goal", { x: -3000, y: 0 }, { exact: true, title: "自分のメモ" });
      const kid = f.app.cmd.createNode("action", { x: -2700, y: 0 }, { exact: true, title: "自分のメモの先", from: [id] });
      f.store.transact("自分で折りたたむ", (tx) => tx.updateNode(id, { collapsed: true }));
      f.ui.clearSelection();
      return { id, kid };
    });
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => ({ rev: window.__fourD.store.revision, undo: window.__fourD.store.history.undoStack.length }));
    let after;
    try {
      await page.evaluate(() => (window.__fourD.store.readOnly = true));
      await page.getByRole("button", { name: "全部ひらく" }).click();
      await page.waitForTimeout(300);
      after = await page.evaluate((o) => {
        const f = window.__fourD;
        const vm = f.app.vm;
        vm.ensure();
        const imp = vm.impact;
        return {
          rev: f.store.revision,
          undo: f.store.history.undoStack.length,
          collapsed: f.store.doc.nodes[o.id].collapsed,
          kidHidden: vm.node(o.kid).hidden,
          hiddenInScope: [...imp.scope].filter((id) => vm.node(id).hidden).length,
          warn: [...document.querySelectorAll(".toast:not(.closing) .toast-text")].filter((t) => t.textContent.includes("閲覧のみ")).length,
        };
      }, own);
    } finally {
      // 後の確かめのために戻す（閲覧のみ・開いた所・足したノード）
      await page.evaluate((n) => {
        const f = window.__fourD;
        f.store.readOnly = false;
        f.app.cmd.resetImpactOpen();
        for (let i = 0; i < 10 && f.store.history.undoStack.length > n; i++) f.app.cmd.undo();
      }, before.undo - 3);
    }
    assert(after.rev === before.rev && after.undo === before.undo, `文書・元に戻すが変わった ${JSON.stringify({ before, after })}`);
    assert(after.collapsed === true && after.kidHidden, `自分で折りたたんだノードが開いた ${JSON.stringify(after)}`);
    assert(after.hiddenInScope === 0, `3 年の分かれ道に隠れたノードが残る（${after.hiddenInScope}）`);
    assert(after.warn === 0, "閲覧のみのお知らせが出た");
    assert(await page.evaluate((o) => !window.__fourD.store.doc.nodes[o.id], own), "確かめに足したノードが残った");
  });

  await check("詳細の「折りたたむ／展開する」は、3 年の分かれ道では見え方の開閉に合わせ、キャンバスで開閉しても合い、閲覧のみでも押せる（文書は変えない）", async () => {
    const id = await page.evaluate(() => {
      const f = window.__fourD;
      const vm = f.app.vm;
      vm.ensure();
      for (const [x, m] of vm.impact.month) if (m === 3 && vm.isCollapsed(x) && !vm.node(x).hidden) return x;
      return null;
    });
    assert(id, "閉じた 3 か月後のカードが無い（確かめの前提）");
    await page.evaluate((x) => window.__fourD.ui.select([x]), id);
    await page.waitForTimeout(150);
    const read = () =>
      page.evaluate((x) => {
        const f = window.__fourD;
        const b = document.querySelectorAll(".insp-node .insp-actions .btn")[1];
        return { label: b.textContent.trim(), disabled: b.disabled, view: f.app.vm.isCollapsed(x), doc: f.store.doc.nodes[x].collapsed, rev: f.store.revision };
      }, id);
    const r0 = await read();
    assert(r0.label === "展開する" && r0.view && !r0.doc, `閉じたカードの見出し ${JSON.stringify(r0)}`);
    await page.locator(".insp-node .insp-actions .btn").nth(1).click();
    await page.waitForTimeout(150);
    const r1 = await read();
    assert(r1.label === "折りたたむ" && !r1.view && !r1.doc && r1.rev === r0.rev, `開いた後 ${JSON.stringify(r1)}`);
    // キャンバスで閉じる（C）: ボタンも合わせる
    await page.locator(".graph-canvas").focus();
    await page.keyboard.press("c");
    await page.waitForTimeout(150);
    const r2 = await read();
    assert(r2.label === "展開する" && r2.view && r2.rev === r0.rev, `キャンバスで閉じた後 ${JSON.stringify(r2)}`);
    // 閲覧のみでも見え方の開閉は押せる
    let r3;
    let r4;
    try {
      await page.evaluate((x) => {
        const f = window.__fourD;
        f.store.readOnly = true;
        f.ui.clearSelection();
        f.ui.select([x]);
      }, id);
      await page.waitForTimeout(150);
      r3 = await read();
      if (!r3.disabled) {
        await page.locator(".insp-node .insp-actions .btn").nth(1).click();
        await page.waitForTimeout(150);
      }
      r4 = await read();
    } finally {
      await page.evaluate(() => {
        const f = window.__fourD;
        f.store.readOnly = false;
        f.app.cmd.resetImpactOpen();
        f.ui.clearSelection();
      });
    }
    assert(!r3.disabled, "閲覧のみで押せない");
    assert(r4.label === "折りたたむ" && !r4.view && r4.rev === r0.rev, `閲覧のみで開いた後 ${JSON.stringify(r4)}`);
  });

  await check("相乗効果の線しか出ていないカード（行き先から自分のメモへ）は、折りたたみの印・詳細のボタン・右クリックのメニューで開閉しない。閉じた選択肢と一緒に選ぶとメニューは「展開する」で、押すと開く", async () => {
    const undo0 = await undoCount(page);
    /** カードを画面の真ん中に出して、右クリックする所（カードの中・印とつなぐ点を避けた所） */
    const spot = (id) =>
      page.evaluate((x) => {
        const f = window.__fourD;
        const v = f.app.view;
        v.centerOn(x, { zoom: 0.8, animate: false });
        const p = f.app.vm.posOf(x);
        const s = v.camera.toScreen(p.x - 40, p.y);
        const r = v.canvas.getBoundingClientRect();
        return { x: r.left + s.x, y: r.top + s.y };
      }, id);
    /** 右クリックのメニューの開閉の項目（見出しと押せるか）を読んで閉じる */
    const menuAt = async (id) => {
      const at = await spot(id);
      await page.waitForTimeout(120);
      await page.mouse.click(at.x, at.y, { button: "right" });
      const item = page.getByRole("menuitem", { name: /展開する|この先を折りたたむ/ });
      await item.waitFor({ timeout: 3000 });
      const r = { label: (await item.locator(".menu-label").textContent())?.trim(), disabled: await item.isDisabled() };
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      return r;
    };
    let r;
    try {
      const ids = await page.evaluate(() => {
        const f = window.__fourD;
        const vm = f.app.vm;
        vm.ensure();
        const end = vm.impact.ends.map((e) => e.id).find((id) => !(vm.index.out.get(id)?.length ?? 0));
        f.app.cmd.revealNode(end);
        const own = f.app.cmd.createNode("goal", { x: -3000, y: 0 }, { exact: true, title: "自分のメモ" });
        f.app.cmd.connect([end], own, "supports");
        // 閉じる選択肢は、行き先への道の上に無い物（閉じても行き先は見えたまま）
        let alt = null;
        for (const a of vm.impact.decision.get(vm.impact.root).alts) {
          vm.setImpactOpen([], [a]);
          vm.ensure();
          if (!vm.node(end).hidden) {
            alt = a;
            break;
          }
          vm.setImpactOpen([a]);
        }
        f.ui.select([end]);
        f.ui.setHover(end, null);
        return { end, alt };
      });
      await page.waitForTimeout(200);
      r = await page.evaluate((o) => {
        const f = window.__fourD;
        const b = document.querySelectorAll(".insp-node .insp-actions .btn")[1];
        return { badge: f.app.view.badgeVisible(o.end, "full"), btn: b?.disabled, altClosed: !f.app.vm.isOpen(o.alt), endShown: !f.app.vm.node(o.end).hidden };
      }, ids);
      r.endMenu = await menuAt(ids.end);
      await page.evaluate((o) => window.__fourD.ui.select([o.alt, o.end]), ids);
      r.mixMenu = await menuAt(ids.alt);
      // 押すと閉じた選択肢が開く
      if (r.mixMenu.label === "展開する") {
        const at = await spot(ids.alt);
        await page.mouse.click(at.x, at.y, { button: "right" });
        await page.getByRole("menuitem", { name: /展開する/ }).click();
        await page.waitForTimeout(150);
        r.altOpened = await page.evaluate((o) => window.__fourD.app.vm.isOpen(o.alt), ids);
      }
    } finally {
      await page.keyboard.press("Escape");
      await undoTo(page, undo0);
      await page.evaluate(() => {
        const f = window.__fourD;
        f.ui.setHover(null, null);
        f.app.cmd.resetImpactOpen();
      });
    }
    assert(r.altClosed && r.endShown, `確かめの前提 ${JSON.stringify(r)}`);
    assert(r.badge === false, `相乗効果の線しか出ていないカードに折りたたみの印を描く ${JSON.stringify(r)}`);
    assert(r.btn === true, `詳細の「折りたたむ」が押せる ${JSON.stringify(r)}`);
    assert(r.endMenu.disabled === true, `メニューの開閉が押せる ${JSON.stringify(r.endMenu)}`);
    assert(r.mixMenu.label === "展開する" && !r.mixMenu.disabled, `閉じた選択肢と一緒のメニュー ${JSON.stringify(r.mixMenu)}`);
    assert(r.altOpened, "メニューの「展開する」で閉じた選択肢が開かない");
  });

  await check("複数選んだ詳細の「折りたたむ」も同じ決まり: 相乗効果の線しか出ていないカード 2 枚では押せず、閉じた選択肢と一緒なら「展開する」で開き、開いたら「折りたたむ」に戻る", async () => {
    const undo0 = await undoCount(page);
    /** 複数選んだ詳細の開閉のボタン（見出し・押せるか・題） */
    const btn = () => page.locator(".insp-multi .insp-actions .btn").nth(1);
    const read = async () => ({ label: (await btn().textContent())?.trim(), disabled: await btn().isDisabled(), title: await btn().getAttribute("title") });
    let r;
    try {
      const ids = await page.evaluate(() => {
        const f = window.__fourD;
        const vm = f.app.vm;
        vm.ensure();
        const ends = vm.impact.ends.map((e) => e.id).filter((id) => !(vm.index.out.get(id)?.length ?? 0)).slice(0, 2);
        f.app.cmd.revealNode(ends[0]);
        const own = f.app.cmd.createNode("goal", { x: -3000, y: 0 }, { exact: true, title: "自分のメモ" });
        for (const e of ends) f.app.cmd.connect([e], own, "supports");
        // 閉じる選択肢は、1 枚目の行き先への道の上に無い物（閉じても行き先は見えたまま）
        let alt = null;
        for (const a of vm.impact.decision.get(vm.impact.root).alts) {
          vm.setImpactOpen([], [a]);
          vm.ensure();
          if (!vm.node(ends[0]).hidden) {
            alt = a;
            break;
          }
          vm.setImpactOpen([a]);
        }
        f.ui.select(ends);
        return { ends, alt };
      });
      assert(ids.ends.length === 2 && ids.alt, `確かめの前提（行き先 2 枚と、閉じても 1 枚目が見えたままの選択肢） ${JSON.stringify(ids)}`);
      await page.waitForTimeout(200);
      r = { ends: await read() };
      // 閉じた選択肢と行き先: 「展開する」で開く。開いたら「折りたたむ」に変わる（キャンバスでの開閉にも合わせる）
      await page.evaluate((o) => window.__fourD.ui.select([o.alt, o.ends[0]]), ids);
      await page.waitForTimeout(200);
      r.mix = await read();
      assert(!r.mix.disabled, `閉じた選択肢と一緒なのに押せない ${JSON.stringify(r)}`);
      await btn().click();
      await page.waitForTimeout(200);
      r.altOpened = await page.evaluate((o) => window.__fourD.app.vm.isOpen(o.alt), ids);
      r.mixAfter = await read();
      await page.evaluate((o) => window.__fourD.app.vm.setImpactOpen([], [o.alt]), ids);
      await page.waitForTimeout(200);
      r.mixClosedOnCanvas = await read();
      r.altClosed = await page.evaluate((o) => !window.__fourD.app.vm.isOpen(o.alt), ids);
      r.endShown = await page.evaluate((o) => !window.__fourD.app.vm.node(o.ends[0]).hidden, ids);
    } finally {
      await undoTo(page, undo0);
      await page.evaluate(() => window.__fourD.app.cmd.resetImpactOpen());
    }
    assert(r.endShown, `確かめの前提 ${JSON.stringify(r)}`);
    assert(r.ends.disabled === true, `相乗効果の線しか出ていないカード 2 枚で「折りたたむ」が押せる（押しても何も起きない） ${JSON.stringify(r.ends)}`);
    assert(r.mix.label === "展開する" && !r.mix.disabled && r.mix.title === "この先を展開する（C）", `閉じた選択肢と一緒のボタン ${JSON.stringify(r.mix)}`);
    assert(r.altOpened, "「展開する」で閉じた選択肢が開かない");
    assert(r.mixAfter.label === "折りたたむ" && !r.mixAfter.disabled, `開いた後のボタン ${JSON.stringify(r.mixAfter)}`);
    assert(r.altClosed && r.mixClosedOnCanvas.label === "展開する", `キャンバスで閉じた後のボタン ${JSON.stringify(r.mixClosedOnCanvas)}`);
  });

  await check("結果の線: % の欄に「この手の結果の合計」、判断の線の % には使わないと出す", async () => {
    const ids = await page.evaluate(() => {
      const f = window.__fourD;
      const imp = f.app.vm.impact;
      const best = imp.decision.get(imp.root).best;
      const chance = imp.alt.get(best).outcomes[0].edge;
      const decision = imp.alt.get(best).edge;
      return { chance, decision };
    });
    await page.evaluate((id) => window.__fourD.ui.select([], [id]), ids.chance);
    await page.waitForTimeout(150);
    const sum = (await page.locator(".prob-sum").textContent()) ?? "";
    assert(/^この手の結果の合計 100%$/.test(sum), `合計: ${sum}`);
    const title = await page.locator(".insp-edge .insp-section", { has: page.locator(".edge-prob") }).locator(".insp-label").textContent();
    assert(title === "見込み（この結果になる見込み %）", `欄の名前: ${title}`);
    await page.evaluate((id) => window.__fourD.ui.select([], [id]), ids.decision);
    await page.waitForTimeout(150);
    assert(!(await page.locator(".edge-prob").isVisible()), "判断の線に % の欄が出ている");
    await page.evaluate((id) => {
      const f = window.__fourD;
      f.app.cmd.updateEdge(id, { meta: { ...f.store.doc.edges[id].meta, prob: 40 } });
    }, ids.decision);
    await page.waitForTimeout(150);
    const note = (await page.locator(".prob-sum").textContent()) ?? "";
    assert(note === "判断の線なので % は使いません（選んだ手で計算します）", `判断の線: ${note}`);
    await page.evaluate(() => window.__fourD.app.cmd.undo());
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  });

  await check("基準（今のまま）が無い判断: 差を出さずに訳を言い、「これを基準にする」で基準を決められ、元に戻せる", async () => {
    const ids = await page.evaluate(() => {
      const imp = window.__fourD.app.vm.impact;
      const best = imp.decision.get(imp.root).best;
      const state = imp.alt.get(best).outcomes[0].node;
      const dec = imp.decision.get(state);
      return { state, base: dec.base, other: dec.alts.find((a) => a !== dec.base) };
    });
    await page.evaluate(({ base }) => {
      const f = window.__fourD;
      const meta = { ...f.store.doc.nodes[base].meta };
      delete meta.base;
      f.app.cmd.updateNode(base, { meta }, { label: "基準を外す" });
    }, ids);
    await page.evaluate((id) => window.__fourD.ui.select([id]), ids.state);
    await page.waitForTimeout(150);
    const rows = await page.evaluate(() => [...document.querySelectorAll(".imp-node.is-outcome .imp-sibs .imp-alt-row")].map((r) => ({ pill: r.querySelector(".imp-pill").textContent, meta: r.querySelector(".imp-alt-meta").textContent })));
    assert(rows.length > 1 && rows.every((r) => r.pill === "—" && r.meta.includes("基準（今のまま）が無いので差を出せません")), `基準の無い判断の行 ${JSON.stringify(rows)}`);
    await page.evaluate((id) => window.__fourD.ui.select([id]), ids.other);
    await page.waitForTimeout(150);
    const warn = (await page.locator(".imp-node.is-alt .imp-warn").first().textContent()) ?? "";
    assert(warn.includes("基準（今のまま）が無いので差を出せません"), `訳: ${warn}`);
    await page.locator(".imp-node.is-alt .btn", { hasText: "これを基準にする" }).click();
    await page.waitForTimeout(150);
    const after = await page.evaluate((id) => {
      const a = window.__fourD.app.vm.impact.alt.get(id);
      return { isBase: a.isBase, delta: a.delta };
    }, ids.other);
    assert(after.isBase && after.delta === 0, `基準にならない ${JSON.stringify(after)}`);
    await page.evaluate(() => {
      window.__fourD.app.cmd.undo();
      window.__fourD.app.cmd.undo();
    });
    const restored = await page.evaluate((s) => window.__fourD.app.vm.impact.decision.get(s).base, ids.state);
    assert(restored === ids.base, `元の基準に戻らない ${restored}`);
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  });

  await check("行き先: 概要の行き先を押すと、見込み（この手で・この道で・おすすめで）・3 年の稼ぎ・その時の状態・目印が出る", async () => {
    const id = await page.locator(".imp-overview .imp-end-row").first().getAttribute("data-id");
    await page.locator(".imp-overview .imp-end-row").first().click();
    await page.waitForTimeout(500);
    assert((await page.evaluate(() => [...window.__fourD.ui.selection.nodes][0])) === id, "行き先が選ばれない");
    assert(await onScreen(page, id), "行き先のカードが画面に入らない");
    const p = await page.evaluate(() => {
      const box = document.querySelector(".imp-node.is-outcome");
      return {
        facts: box?.querySelector(".imp-facts")?.textContent ?? "",
        state: box?.querySelector(".imp-state")?.textContent ?? "",
        trail: [...(box?.querySelectorAll(".imp-trail-step") ?? [])].map((s) => ({ when: s.querySelector(".imp-trail-when").textContent, cur: s.classList.contains("is-current") })),
      };
    });
    assert(/この結果になる見込み \d+%（この手を選んだ場合）/.test(p.facts) && /この手:.+/.test(p.facts), `見込み: ${p.facts}`);
    assert(/この道で [\d.]+% · おすすめの選び方で [\d.]+%/.test(p.facts), `この道で: ${p.facts}`);
    assert(/この結果なら 今のままより/.test(p.facts) && /この行き先の 3 年の稼ぎ [\d,]+ 万円（ずっと今のままより [+−±]/.test(p.facts), `3 年の稼ぎ: ${p.facts}`);
    assert(/^その時: (会社員|週 4 日勤務|独立)/.test(p.state) && p.state.includes("SpellDash"), `状態: ${p.state}`);
    assert(p.trail.length === 3 && p.trail.every((s) => /^\d{4}年\d{1,2}月$/.test(s.when)) && p.trail[2].cur, `目印 ${JSON.stringify(p.trail)}`);
    await shot("impact-desktop-end", page);
  });

  await check("今日を選ぶと、見出し（年収）と今決めることが詳細に出る", async () => {
    const imp = await impactOf(page);
    await page.evaluate((id) => window.__fourD.ui.select([id]), imp.root);
    await page.waitForTimeout(200);
    const p = await page.evaluate(() => ({ head: document.querySelector(".imp-node.is-root .imp-hl-main")?.textContent ?? "", rows: document.querySelectorAll(".imp-node.is-root .imp-alt-row").length, salary: !!document.querySelector(".imp-node.is-root .imp-salary") }));
    assert(/^おすすめの選び方で 3 年/.test(p.head) && p.rows === 10 && p.salary, JSON.stringify(p));
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  });

  await check("方針（早期独立）を選ぶと「早期独立の方針だと…（おすすめとの差）」になり、方針の外の手は薄くなる", async () => {
    await page.locator(".scen-chip", { hasText: "早期独立" }).click();
    await page.waitForTimeout(300);
    const p = await page.evaluate(() => ({
      main: document.querySelector(".imp-overview .imp-hl-main")?.textContent ?? "",
      label: document.querySelector(".imp-overview .imp-dist-label")?.textContent ?? "",
      off: document.querySelectorAll(".imp-overview .imp-decide .imp-alt-row.is-off").length,
    }));
    assert(/^早期独立の方針だと 3 年 [\d,]+ 万円（おすすめとの差 [−±][\d,.]* ?万円?）$/.test(p.main), `見出し: ${p.main}`);
    assert(p.label === "早期独立の方針", `分布の名前: ${p.label}`);
    assert(p.off > 0, "方針の外の手が薄くならない");
    await shot("impact-desktop-scenario", page);
    await page.locator(".scen-chip", { hasText: "すべて" }).click();
    await page.waitForTimeout(200);
  });
  await ctx.close();

  // ---- スマホ（390×844）: 引き出しは幅 300px、横にはみ出さない。今決めることを押すと引き出しを閉じて寄る
  const ph = await openImpact(browser, { width: 390, height: 844 });
  const pp = ph.page;
  await check("スマホ: 引き出しの幅・横にはみ出さない・見出しと今決めること（10 行）が引き出しに収まって読める", async () => {
    await pp.evaluate(() => window.__fourD.ui.clearSelection());
    await pp.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: true }));
    await pp.waitForTimeout(400);
    const w = await noHScroll(pp);
    assert(Math.round(w.side) === 300, `引き出しの幅 ${w.side}`);
    assert(w.ok, `横にはみ出す ${JSON.stringify(w)}`);
    const vis = await pp.evaluate(() => {
      document.querySelector(".insp-body-scroll").scrollTop = 0;
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const head = r(".imp-overview .imp-head");
      const rows = [...document.querySelectorAll(".imp-overview .imp-decide .imp-alt-row")];
      const fs = parseFloat(getComputedStyle(document.querySelector(".imp-overview .imp-alt-title")).fontSize);
      // 詰めた行: タイトルは 1 行（短い名前）、全部の題名は行の title に
      const oneLine = rows.every((x) => {
        const t = x.querySelector(".imp-alt-title");
        return t.getBoundingClientRect().height <= parseFloat(getComputedStyle(t).lineHeight) + 1 && x.title.length > 0;
      });
      return { headTop: head?.top, headBottom: head?.bottom, bottoms: rows.map((x) => Math.round(x.getBoundingClientRect().bottom)), h: innerHeight, fs, oneLine };
    });
    assert(vis.headTop > 0 && vis.bottoms.length === 10 && vis.fs >= 12, `見出しと今決めることが見えない ${JSON.stringify(vis)}`);
    assert(vis.bottoms.every((b) => b <= vis.h), `今決めることの 10 行が引き出しに収まらない ${JSON.stringify(vis)}`);
    assert(vis.oneLine, "詰めた行のタイトルが 1 行でない");
    await shot("impact-phone-overview", pp);
  });

  await check("スマホ: やる価値・避けたい手・大事な判断の行も引き出しに収まり（横にはみ出さない・1 行ずつ）、押す所は 44px 以上", async () => {
    await pp.evaluate(() => {
      window.__fourD.ui.clearSelection();
      window.__fourD.ui.setPrefs({ rightOpen: true });
    });
    await pp.waitForTimeout(400);
    const r = await pp.evaluate(() => {
      const side = document.querySelector(".sidebar-right").getBoundingClientRect();
      const rows = [...document.querySelectorAll(".imp-overview .imp-rank-row")].map((b) => {
        const x = b.getBoundingClientRect();
        const lines = [...b.querySelectorAll(".imp-rank-title, .imp-rank-meta")].every((t) => t.getBoundingClientRect().height <= parseFloat(getComputedStyle(t).lineHeight) + 1);
        return { fk: b.dataset.fk, h: x.height, left: x.left, right: x.right, sw: b.scrollWidth, cw: b.clientWidth, lines, title: b.title.length > 0 };
      });
      return { rows, side: { left: side.left, right: side.right }, doc: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth } };
    });
    assert(r.rows.length >= 5, `行の数 ${r.rows.length}`);
    for (const x of r.rows) {
      assert(x.h >= 44 - 0.5, `押す所が 44px 未満 ${JSON.stringify(x)}`);
      assert(x.left >= r.side.left - 0.5 && x.right <= r.side.right + 0.5 && x.sw <= x.cw + 1, `横にはみ出す ${JSON.stringify(x)}`);
      assert(x.lines && x.title, `詰めた行が 1 行ずつでない・全部の文が行の title に無い ${JSON.stringify(x)}`);
    }
    assert(r.doc.sw <= r.doc.cw, `ページが横にはみ出す ${JSON.stringify(r.doc)}`);
    const w = await noHScroll(pp);
    assert(w.ok, `横にはみ出す ${JSON.stringify(w)}`);
    await pp.evaluate(() => {
      const s = document.querySelector(".imp-overview .imp-worth");
      document.querySelector(".insp-body-scroll").scrollTop = s.offsetTop - 60;
    });
    await shot("impact-phone-ranks", pp);
  });

  await check("スマホ: やる価値が大きい手の行を押すと引き出しを閉じ、その種類のカードを選んで寄る（フォーカスは閉じた引き出しに残さない）", async () => {
    const row = (await famRows(pp, "worth"))[0];
    await pp.locator(`.imp-overview [data-fk="${row.fk}"]`).click();
    await pp.waitForTimeout(500);
    const s = await pp.evaluate(() => ({ open: window.__fourD.ui.prefs.rightOpen, inPanel: !!document.activeElement?.closest(".sidebar-right") }));
    const a = await selectedFam(pp);
    assert(!s.open && !s.inPanel && a.count === 1 && a.fam === row.fam, JSON.stringify({ s, a, fam: row.fam }));
    assert(await onScreen(pp, a.id), "選んだカードが画面に入らない");
  });

  await check("スマホ: 今決めることの行を押すと引き出しを閉じ、そのカードを選んで寄る", async () => {
    await pp.evaluate(() => {
      window.__fourD.ui.clearSelection();
      window.__fourD.ui.setPrefs({ rightOpen: true });
    });
    await pp.waitForTimeout(400);
    const id = await pp.locator(".imp-overview .imp-decide .imp-alt-row").first().getAttribute("data-id");
    await pp.locator(".imp-overview .imp-decide .imp-alt-row").first().click();
    await pp.waitForTimeout(500);
    const s = await pp.evaluate(() => ({ open: window.__fourD.ui.prefs.rightOpen, sel: [...window.__fourD.ui.selection.nodes], inPanel: !!document.activeElement?.closest(".sidebar-right") }));
    assert(!s.open && !s.inPanel && s.sel.length === 1 && s.sel[0] === id, JSON.stringify(s));
    assert(await onScreen(pp, id), "選んだカードが画面に入らない");
  });

  await check("スマホ: キーボードで今決めることの行を押すと、引き出しは開いたまま選んだ手の詳細（これにする）へフォーカスが移り、次の Tab で地図を変えない", async () => {
    await pp.evaluate(() => {
      window.__fourD.ui.clearSelection();
      window.__fourD.ui.setPrefs({ rightOpen: true });
    });
    await pp.waitForTimeout(400);
    const n0 = await pp.evaluate(() => Object.keys(window.__fourD.store.doc.nodes).length);
    const id = await pp.locator(".imp-overview .imp-decide .imp-alt-row").nth(1).getAttribute("data-id");
    await pp.locator(`.imp-overview [data-fk="row:${id}"]`).focus();
    await pp.keyboard.press("Enter");
    await pp.waitForTimeout(400);
    const s = await pp.evaluate(() => ({ open: window.__fourD.ui.prefs.rightOpen, sel: [...window.__fourD.ui.selection.nodes], fk: document.activeElement?.dataset?.fk ?? document.activeElement?.tagName }));
    assert(s.open && s.sel.length === 1 && s.sel[0] === id && s.fk === `pick:${id}`, JSON.stringify(s));
    await pp.keyboard.press("Tab");
    await pp.waitForTimeout(200);
    const t = await pp.evaluate(() => ({ nodes: Object.keys(window.__fourD.store.doc.nodes).length, editor: window.__fourD.app.editor.active, fk: document.activeElement?.dataset?.fk ?? document.activeElement?.tagName }));
    assert(t.nodes === n0 && !t.editor && t.fk !== "BODY", `Tab の後 ${JSON.stringify(t)}`);
    await pp.evaluate(() => window.__fourD.ui.clearSelection());
  });

  await check("スマホ: 選択肢・行き先の詳細も横にはみ出さない", async () => {
    const imp = await impactOf(pp);
    await pp.evaluate((id) => window.__fourD.ui.select([id]), imp.best);
    await pp.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: true }));
    await pp.waitForTimeout(400);
    const a = await noHScroll(pp);
    assert(a.ok, `選択肢: ${JSON.stringify(a)}`);
    await shot("impact-phone-alt", pp);
    await pp.evaluate((id) => window.__fourD.ui.select([id]), imp.ends[0]);
    await pp.waitForTimeout(300);
    const e = await noHScroll(pp);
    assert(e.ok, `行き先: ${JSON.stringify(e)}`);
    await shot("impact-phone-end", pp);
  });
  await ph.ctx.close();

  // ---- ふつうの地図（デモ）: 今までどおり（3 年の影響は出さない）
  await check("ふつうの地図（デモ）では 3 年の影響を出さない", async () => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await c.addInitScript(() => {
      try {
        localStorage.setItem("4d-branch:prefs", JSON.stringify({ futureAutoOpened: true }));
      } catch {
        /* about:blank など */
      }
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    const skip = p.getByRole("button", { name: "すぐに使う" });
    if (await skip.count()) await skip.click();
    await p.waitForTimeout(300);
    const s = await p.evaluate(() => ({ active: window.__fourD.app.vm.impact.active, overview: !!document.querySelector(".imp-overview:not([hidden])"), stats: !!document.querySelector(".stat-grid .stat") }));
    assert(!s.active && !s.overview && s.stats, JSON.stringify(s));
    await p.evaluate(() => window.__fourD.ui.select([Object.keys(window.__fourD.store.doc.nodes)[0]]));
    await p.waitForTimeout(200);
    assert((await p.locator(".imp-node").count()) === 0, "ふつうのノードに 3 年の影響が出た");
    assert((await p.locator(".insp-node .insp-section .insp-label", { hasText: "条件" }).count()) === 1, "条件の欄が変わった");
    await p.waitForTimeout(3500);
    assert((await p.locator(".toast", { hasText: "年収（額面）を入れると" }).count()) === 0, "ふつうの地図で年収のお知らせが出た");
    await c.close();
  });

  await browser.close();
}

try {
  await main();
} catch (e) {
  console.error(e);
  results.push({ name: "起動", ok: false, err: e });
} finally {
  server?.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件 通過`);
process.exit(failed.length ? 1 : 0);
