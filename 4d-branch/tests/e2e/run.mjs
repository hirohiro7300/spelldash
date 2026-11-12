// E2E: ブラウザで実際に操作して確かめる（npm run build の後に npm run e2e）
//   BASE_URL を渡せばそのサーバーを使う。無ければ vite preview を立ち上げる
//   PW_CHROMIUM でブラウザの場所を指定できる（無ければ playwright-core の既定）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.E2E_PORT || 4391);
let BASE = process.env.BASE_URL || `http://localhost:${PORT}/`;
const SHOTS = process.env.E2E_SHOTS || "";

let server = null;
async function startServer() {
  if (process.env.BASE_URL) return;
  if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) throw new Error("dist/ がありません。先に npm run build を実行してください");
  server = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "preview", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {
      /* まだ */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("preview サーバーが起動しません");
}

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 4).join("\n      ")}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * 何もしていないデモを開き直したときの「未来の道筋」の自動表示を、このコンテキストでは済んだことにする
 * （デモのまま確かめる流れのため。自動表示そのものは専用のコンテキストで確かめる）
 */
async function skipAutoFuture(context) {
  await context.addInitScript(() => {
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
}

const state = (page) =>
  page.evaluate(() => {
    const f = window.__fourD;
    return { nodes: Object.keys(f.store.doc.nodes).length, edges: Object.keys(f.store.doc.edges).length, sel: [...f.ui.selection.nodes], selEdges: [...f.ui.selection.edges], readOnly: f.store.readOnly, status: f.persistence.status, title: f.store.doc.title };
  });

const screenOf = (page, id) =>
  page.evaluate((nid) => {
    const f = window.__fourD;
    const n = f.store.doc.nodes[nid];
    const r = f.app.view.canvas.getBoundingClientRect();
    const s = f.app.view.camera.toScreen(n.x, n.y);
    const z = f.app.view.camera.zoom;
    return { x: r.left + s.x, y: r.top + s.y, z, halfW: 106 * z };
  }, id);

async function waitSaved(page) {
  await page.waitForFunction(() => window.__fourD.persistence.status === "saved", null, { timeout: 5000 });
}

/** ms の間にキャンバスを描いた回数 */
const framesIn = (page, ms) =>
  page.evaluate(async (wait) => {
    const v = window.__fourD.app.view;
    const f0 = v.frames;
    await new Promise((r) => setTimeout(r, wait));
    return v.frames - f0;
  }, ms);

const idByTitle = (page, title) => page.evaluate((t) => Object.values(window.__fourD.store.doc.nodes).find((n) => n.title === t)?.id, title);

/** 欄の上で直接タイトルを編集し始める（選んで Enter） */
async function startInlineEdit(page, id) {
  await page.evaluate((nid) => window.__fourD.ui.select([nid]), id);
  await page.locator(".graph-canvas").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.classList.contains("inline-editor"));
}

/** 開いているタイトルの欄を取り消して閉じる（確かめが途中で落ちても、打ちかけを後の確かめに残さない） */
const closeInlineEditor = (page) => page.evaluate(() => document.querySelector(".inline-editor")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

/** 別の書き手（ロックの使えない環境の別タブなど）が、知らないうちに版を進めた（次の保存が競合で止まる） */
const bumpStoredRev = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("4d-branch");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const t = db.transaction("kv", "readwrite");
          const s = t.objectStore("kv");
          const g = s.get("meta");
          g.onsuccess = () => s.put({ ...g.result, rev: g.result.rev + 5, writer: "t_other" }, "meta");
          t.oncomplete = () => (db.close(), resolve());
          t.onerror = () => reject(t.error);
        };
      }),
  );

// 上部バーを確かめる幅（段が切り替わる前後を含む。src/styles/app.css の「上部バーの段階」）
const TOPBAR_WIDTHS = [320, 400, 560, 640, 700, 760, 761, 762, 860, 880, 916, 917, 1040, 1100, 1177, 1178, 1280, 1300, 1329, 1330, 1440];

/** 上部バー: 横のはみ出し・画面の外に出たボタン・右のパネルの開閉ボタン（真ん中を押すとそのボタンに当たるか） */
const measureTopbar = (page) =>
  page.evaluate(() => {
    const vw = window.innerWidth;
    const bar = document.querySelector(".topbar");
    const shown = [...bar.querySelectorAll("button")].filter((b) => b.getClientRects().length > 0 && getComputedStyle(b).visibility !== "hidden");
    const out = shown
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.left < -0.5 || r.right > vw + 0.5;
      })
      .map((b) => b.getAttribute("aria-label") || b.textContent.trim() || b.className);
    const t = bar.querySelector('[aria-label="右のパネルを開閉"]').getBoundingClientRect();
    const x = t.left + t.width / 2;
    const y = t.top + t.height / 2;
    const hit = !!document.elementFromPoint(x, y)?.closest('[aria-label="右のパネルを開閉"]');
    return { vw, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, bar: bar.scrollWidth - bar.clientWidth, out, toggle: { x, y, w: t.width, hit } };
  });

/** CSS の移り変わりが終わるまで待つ（左右のパネルの列の幅は 0.2 秒かけて変わり、その間は上部バーも広がる） */
const settleTransitions = (page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))));

/** 幅ごとに、上部バーが収まり、右のパネルの開閉ボタンが押せる（押して開閉し、もう一度押して戻す） */
async function checkTopbarWidths(page, label) {
  for (const width of TOPBAR_WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await settleTransitions(page);
    const m = await measureTopbar(page);
    const at = `${label} ${width}px`;
    assert(m.doc <= m.vw && m.body <= m.vw && m.bar <= 0, `${at}: 横にはみ出す ${JSON.stringify(m)}`);
    assert(m.out.length === 0, `${at}: 画面の外のボタン: ${m.out.join(" / ")}`);
    assert(m.toggle.w > 0 && m.toggle.hit, `${at}: 右のパネルの開閉ボタンが見えない・押せない ${JSON.stringify(m.toggle)}`);
    const before = await page.evaluate(() => window.__fourD.ui.prefs.rightOpen);
    await page.mouse.click(m.toggle.x, m.toggle.y);
    const after = await page.evaluate(() => window.__fourD.ui.prefs.rightOpen);
    assert(after === !before, `${at}: 押しても右のパネルが開閉しない`);
    await page.mouse.click(m.toggle.x, m.toggle.y);
  }
}

async function main() {
  await startServer();
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await skipAutoFuture(ctx);
  const page = await ctx.newPage();
  const errors = [];
  const watch = (p) => {
    p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    p.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
  };
  watch(page);
  const shot = async (name, p = page) => SHOTS && (await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }));

  console.log(`4D Branch E2E → ${BASE}`);

  await check("初回: ようこそ画面とデモ（3 プロジェクト）が出る", async () => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("dialog", { name: "4D Branch へようこそ" }).waitFor();
    const s = await page.evaluate(() => {
      const d = window.__fourD.store.doc;
      return { projects: d.projectOrder.map((p) => d.projects[p].name), nodes: Object.keys(d.nodes).length };
    });
    assert(s.projects.join("|") === "SpellDash事業|FCマーケティングでの業務|広告運用事業での独立", s.projects.join("|"));
    assert(s.nodes >= 20, `nodes ${s.nodes}`);
    await shot("e2e-01-welcome");
  });

  await check("操作ガイドが最後まで進み、閉じると二度目は出ない", async () => {
    await page.getByRole("button", { name: "操作ガイドを見る（1 分）" }).click();
    for (let i = 0; i < 6; i++) {
      await page.locator(".tour-card").getByRole("button", { name: "次へ" }).click();
      await page.waitForTimeout(80);
    }
    await shot("e2e-02-tour-last");
    await page.locator(".tour-card").getByRole("button", { name: "はじめる" }).click();
    assert((await page.locator(".tour").count()) === 0, "ガイドが閉じない");
    const done = await page.evaluate(() => window.__fourD.ui.prefs.onboardingDone);
    assert(done === true, "onboardingDone");
  });

  await check("空き所をダブルクリック → タイトルを打って Enter でノードができる", async () => {
    await page.evaluate(() => {
      const f = window.__fourD;
      f.ui.clearSelection();
      f.app.view.camera.x = 300;
      f.app.view.camera.y = 300;
      f.app.view.camera.zoom = 1;
      f.app.view.cameraChanged();
    });
    await page.waitForTimeout(100);
    const before = await state(page);
    const r = await page.locator(".graph-canvas").boundingBox();
    // デモの左下（何も無い所）
    const empty = await page.evaluate(() => {
      const f = window.__fourD;
      const w = f.app.view.camera.toWorld(80, 520);
      return { ok: f.app.view.hitTest(80, 520).kind === "empty", w };
    });
    assert(empty.ok, "空き所が見つからない");
    await page.mouse.dblclick(r.x + 80, r.y + 520);
    await page.waitForFunction(() => document.activeElement?.classList.contains("inline-editor"));
    await page.keyboard.type("E2Eの目標");
    await page.keyboard.press("Enter");
    const after = await state(page);
    assert(after.nodes === before.nodes + 1, `nodes ${before.nodes} → ${after.nodes}`);
    const title = await page.evaluate(() => window.__fourD.store.doc.nodes[window.__fourD.ui.singleNode].title);
    assert(title === "E2Eの目標", title);
  });

  await check("Tab で分岐（子）を足し、接続もできる", async () => {
    const before = await state(page);
    await page.locator(".graph-canvas").focus();
    await page.keyboard.press("Tab");
    // Tab の直後から打てる（入力欄がすぐにフォーカスを持つ）
    assert(await page.evaluate(() => document.activeElement?.classList.contains("inline-editor")), "Tab の直後に入力欄へフォーカスが無い");
    await page.keyboard.type("E2Eの行動");
    await page.keyboard.press("Enter");
    const after = await state(page);
    assert(after.nodes === before.nodes + 1 && after.edges === before.edges + 1, JSON.stringify({ before, after }));
  });

  await check("右の ● を別のノードへドラッグ → 接続ができる", async () => {
    const ids = await page.evaluate(() => {
      const f = window.__fourD;
      const ns = Object.values(f.store.doc.nodes);
      return { a: ns.find((n) => n.title === "E2Eの目標").id, b: ns.find((n) => n.title === "E2Eの行動").id };
    });
    // b → a は無い。b を選んで、b の出口を a へ
    await page.evaluate((id) => window.__fourD.ui.select([id]), ids.b);
    await page.waitForTimeout(50);
    const pb = await screenOf(page, ids.b);
    const pa = await screenOf(page, ids.a);
    const before = await state(page);
    await page.mouse.move(pb.x + pb.halfW, pb.y);
    await page.mouse.down();
    await page.mouse.move(pb.x + pb.halfW + 40, pb.y + 30, { steps: 4 });
    await page.mouse.move(pa.x, pa.y, { steps: 8 });
    await page.mouse.up();
    const after = await state(page);
    assert(after.edges === before.edges + 1, `edges ${before.edges} → ${after.edges}`);
  });

  await check("● を何もない所で離す → 種類を選んで新しい分岐ができる", async () => {
    const id = await page.evaluate(() => Object.values(window.__fourD.store.doc.nodes).find((n) => n.title === "E2Eの目標").id);
    await page.evaluate((nid) => window.__fourD.ui.select([nid]), id);
    await page.waitForTimeout(50);
    const p = await screenOf(page, id);
    const before = await state(page);
    await page.mouse.move(p.x + p.halfW, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + p.halfW + 120, p.y + 150, { steps: 10 });
    await page.mouse.up();
    await page.locator(".type-menu").getByRole("menuitem", { name: /結果/ }).click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("inline-editor"));
    await page.keyboard.type("E2Eの結果");
    await page.keyboard.press("Enter");
    const after = await state(page);
    assert(after.nodes === before.nodes + 1 && after.edges === before.edges + 1, JSON.stringify({ before, after }));
    const t = await page.evaluate(() => window.__fourD.store.doc.nodes[window.__fourD.ui.singleNode].type);
    assert(t === "result", t);
  });

  await check("元に戻す（Ctrl+Z）・やり直す（Ctrl+Shift+Z）", async () => {
    await page.locator(".graph-canvas").focus();
    const before = await state(page);
    await page.keyboard.press("Control+z"); // タイトル
    await page.keyboard.press("Control+z"); // 作成
    const mid = await state(page);
    assert(mid.nodes === before.nodes - 1, `undo: ${before.nodes} → ${mid.nodes}`);
    await page.keyboard.press("Control+Shift+z");
    await page.keyboard.press("Control+Shift+z");
    const after = await state(page);
    assert(after.nodes === before.nodes, `redo: ${after.nodes}`);
  });

  await check("削除 → お知らせの「元に戻す」で戻る", async () => {
    const id = await page.evaluate(() => Object.values(window.__fourD.store.doc.nodes).find((n) => n.title === "E2Eの結果").id);
    await page.evaluate((nid) => window.__fourD.ui.select([nid]), id);
    await page.locator(".graph-canvas").focus();
    const before = await state(page);
    await page.keyboard.press("Delete");
    const mid = await state(page);
    assert(mid.nodes === before.nodes - 1 && mid.edges === before.edges - 1, "削除できない");
    await page.locator(".toast").getByRole("button", { name: "元に戻す" }).click();
    const after = await state(page);
    assert(after.nodes === before.nodes && after.edges === before.edges, "戻らない");
  });

  await check("詳細パネルで文章・期限・条件・タグ・所属を編集できる", async () => {
    const id = await page.evaluate(() => Object.values(window.__fourD.store.doc.nodes).find((n) => n.title === "E2Eの目標").id);
    await page.evaluate((nid) => window.__fourD.ui.select([nid]), id);
    await page.locator(".insp-text").first().fill("外部の AI と考えた内容");
    await page.locator(".input-date").first().fill("2027-12-31");
    await page.locator(".input-date").first().dispatchEvent("change");
    const cond = page.getByPlaceholder("条件を追加（Enter）");
    await cond.fill("月 10 時間を確保");
    await cond.press("Enter");
    const tag = page.getByPlaceholder("タグを追加");
    await tag.fill("E2E");
    await tag.press("Enter");
    await page.locator(".sidebar-right .chip-toggle", { hasText: "SpellDash事業" }).click();
    await page.locator(".sidebar-right .chip-toggle", { hasText: "広告運用事業での独立" }).click();
    const n = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid], id);
    assert(n.body === "外部の AI と考えた内容", n.body);
    assert(n.time.due === "2027-12-31", n.time.due);
    assert(n.conditions.length === 1 && n.conditions[0].text === "月 10 時間を確保", JSON.stringify(n.conditions));
    assert(n.tags.includes("E2E"), JSON.stringify(n.tags));
    assert(n.projectIds.length === 2, `複数プロジェクト: ${JSON.stringify(n.projectIds)}`);
    // 文章の入力は 1 回の Undo で戻る
    await page.locator(".graph-canvas").focus();
    await shot("e2e-03-inspector");
  });

  await check("詳細: 今ある条件を直しても、入力の途中でフォーカスが外れない（次の Backspace でノードを消さない）", async () => {
    const id = await page.evaluate(() => Object.values(window.__fourD.store.doc.nodes).find((n) => n.title === "E2Eの目標").id);
    await page.evaluate((nid) => window.__fourD.ui.select([nid]), id);
    const text = page.locator(".cond-text").first();
    await text.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("XY");
    const r = await page.evaluate((nid) => {
      const n = window.__fourD.store.doc.nodes[nid];
      return { exists: !!n, cond: n?.conditions[0]?.text, focused: document.activeElement?.classList.contains("cond-text") };
    }, id);
    assert(r.exists, "ノードが消えた");
    assert(r.cond === "月 10 時間をXY", `条件 ${r.cond}`);
    assert(r.focused, "フォーカスが外れた");
    await page.keyboard.press("Enter");
  });

  await check("メニュー: 「ここに作る」で数字キーを押すと、その種類で作る（選んでいるノードの種類は変えない）", async () => {
    const id = await page.evaluate(() => Object.values(window.__fourD.store.doc.nodes).find((n) => n.title === "E2Eの目標").id);
    await page.evaluate((nid) => window.__fourD.ui.select([nid]), id);
    await page.waitForTimeout(50);
    const p = await screenOf(page, id);
    const before = await state(page);
    const typeBefore = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid].type, id);
    await page.mouse.move(p.x + p.halfW, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + p.halfW + 140, p.y + 260, { steps: 10 });
    await page.mouse.up();
    await page.locator(".type-menu").waitFor();
    await page.keyboard.press("4"); // 開いた直後に押しても、メニューが受ける
    await page.waitForFunction(() => document.activeElement?.classList.contains("inline-editor"), null, { timeout: 5000 });
    await page.keyboard.type("数字キーで作った結果");
    await page.keyboard.press("Enter");
    const after = await state(page);
    const r = await page.evaluate((nid) => ({ type: window.__fourD.store.doc.nodes[nid].type, made: Object.values(window.__fourD.store.doc.nodes).find((n) => n.title === "数字キーで作った結果")?.type }), id);
    assert(after.nodes === before.nodes + 1, JSON.stringify({ before, after }));
    assert(r.type === typeBefore, `元のノードの種類が変わった: ${typeBefore} → ${r.type}`);
    assert(r.made === "result", `作ったノードの種類: ${r.made}`);
  });

  await check("ダイアログ: 開くとフォーカスが中に入り、Tab が外へ出ない。重ねた確認の Esc は確認だけを閉じる", async () => {
    await page.evaluate(() => window.__fourD.app.openBackups());
    const dlg = page.getByRole("dialog", { name: "バックアップと復元" });
    await dlg.waitFor();
    await page.waitForTimeout(100);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => !!document.activeElement?.closest(".modal"));
    assert(inside, "Tab でダイアログの外へ出た");
    // 復元の確認を重ねて Esc → 確認だけが閉じる
    const restore = dlg.locator(".backup-row button", { hasText: "復元" }).first();
    if (await restore.count()) {
      await restore.click();
      await page.getByRole("dialog", { name: "このバックアップに戻しますか？" }).waitFor();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      assert((await page.getByRole("dialog", { name: "このバックアップに戻しますか？" }).count()) === 0, "確認が閉じない");
      assert((await dlg.count()) === 1, "下のダイアログまで閉じた");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  });

  await check("検索: 候補から選ぶとそのノードへ", async () => {
    await page.keyboard.press("Control+k");
    await page.keyboard.type("ポートフォリオ");
    await page.locator(".search-row").first().waitFor();
    await page.keyboard.press("Enter");
    const sel = await page.evaluate(() => window.__fourD.store.doc.nodes[window.__fourD.ui.singleNode]?.title);
    assert(sel?.includes("ポートフォリオ"), sel);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  await check("検索: 貼り付けで一度に入れても、件数と候補はその言葉の当たり（1 つ前の言葉の当たりを出さない）", async () => {
    await page.keyboard.press("Control+k");
    const read = () =>
      page.evaluate(() => ({
        count: document.querySelector(".search-count")?.textContent,
        rows: document.querySelectorAll(".search-row").length,
        empty: !!document.querySelector(".search-empty"),
        hits: window.__fourD.app.vm.searchHits.length,
      }));
    await page.locator(".search-input").fill("ポートフォリオ");
    const a = await read();
    assert(a.hits > 0 && a.count === `${a.hits} 件` && a.rows === Math.min(50, a.hits) && !a.empty, `貼り付け: ${JSON.stringify(a)}`);
    // 別の言葉に入れ替えても、前の言葉の当たりが残らない
    await page.locator(".search-input").fill("存在しない言葉ぴよ");
    const b = await read();
    assert(b.hits === 0 && b.count === "0 件" && b.rows === 0 && b.empty, `入れ替え: ${JSON.stringify(b)}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  await check("折りたたみ: C で下流が隠れ、もう一度で戻る（合流先は残る）", async () => {
    await page.evaluate(() => window.__fourD.ui.select(["n_demo_learn_ads"]));
    await page.locator(".graph-canvas").focus();
    await page.keyboard.press("c");
    const hidden = await page.evaluate(() => {
      const f = window.__fourD;
      f.app.vm.ensure();
      return f.app.vm.hiddenCount;
    });
    assert(hidden > 0, "隠れない");
    await page.keyboard.press("c");
    const hidden2 = await page.evaluate(() => {
      const f = window.__fourD;
      f.app.vm.ensure();
      return f.app.vm.hiddenCount;
    });
    assert(hidden2 === 0, `戻らない ${hidden2}`);
  });

  await check("検索: 折りたたみで隠れたノードも「隠れています」と出て、選ぶと開いて表示する", async () => {
    const target = await page.evaluate(() => {
      const f = window.__fourD;
      f.app.cmd.toggleCollapse(["n_demo_learn_ads"]);
      f.app.vm.ensure();
      const counts = new Map();
      for (const n of Object.values(f.store.doc.nodes)) counts.set(n.title, (counts.get(n.title) ?? 0) + 1);
      const id = [...f.app.vm.nodes.entries()].find(([nid, v]) => v.hidden && f.store.doc.nodes[nid].title && counts.get(f.store.doc.nodes[nid].title) === 1)?.[0];
      return id ? { id, title: f.store.doc.nodes[id].title } : null;
    });
    assert(target, "折りたたみで隠れたノードが無い");
    await page.keyboard.press("Control+k");
    await page.keyboard.type(target.title);
    const esc = target.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const row = page.locator(".search-row").filter({ has: page.locator(".search-title", { hasText: new RegExp(`^${esc}$`) }) });
    await row.first().waitFor();
    assert((await row.first().locator(".search-hidden").count()) === 1, "「隠れています」が出ない");
    await row.first().click();
    const vis = await page.evaluate((id) => {
      const f = window.__fourD;
      return { hidden: f.app.vm.node(id).hidden, sel: f.ui.singleNode };
    }, target.id);
    assert(!vis.hidden && vis.sel === target.id, JSON.stringify(vis));
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // 片付け: 開いた分と折りたたみを戻す
    await page.evaluate(() => {
      const f = window.__fourD;
      f.store.undo();
      f.store.undo();
      f.ui.clearSelection();
    });
    const left = await page.evaluate(() => (window.__fourD.app.vm.ensure(), window.__fourD.app.vm.hiddenCount));
    assert(left === 0, `片付けで戻らない ${left}`);
  });

  await check("縮小（30〜80%）: 描かれていない折りたたみの印の所を押しても折りたたまず、そこからノードを動かせる", async () => {
    const t = await page.evaluate(() => {
      const f = window.__fourD;
      const v = f.app.view;
      f.app.vm.ensure();
      // 出る線があり、折りたたんでいないノード（選択・ホバー中でも compact では印を描かない）
      const id = f.app.vm.drawNodes.find((nid) => !f.store.doc.nodes[nid].collapsed && (f.app.vm.index.out.get(nid)?.length ?? 0) > 0);
      const n = f.store.doc.nodes[id];
      f.ui.select([id]);
      // 前の確かめの寄る動き（検索で選んだノードへ）が残っていると、置いたカメラが上書きされる
      v.stopCameraAnimation();
      v.camera.zoom = 0.5;
      v.camera.x = v.width / 2 - n.x * 0.5;
      v.camera.y = v.height / 2 - n.y * 0.5;
      v.cameraChanged();
      // 印の中心（ノードの下の縁の右寄り: x + 106 - 34, y + 48）の少し上 = ノードの中
      const s = v.camera.toScreen(n.x + 72, n.y + 40);
      const r = v.canvas.getBoundingClientRect();
      return { id, x0: n.x, y0: n.y, sx: s.x, sy: s.y, cx: r.left + s.x, cy: r.top + s.y };
    });
    const hitAt = () => page.evaluate(({ sx, sy }) => window.__fourD.app.view.hitTest(sx, sy).kind, t);
    assert((await hitAt()) === "node", `描かれていない印に当たる: ${await hitAt()}`);
    await page.mouse.move(t.cx, t.cy);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.mouse.up();
    const collapsed = await page.evaluate((id) => window.__fourD.store.doc.nodes[id].collapsed, t.id);
    assert(collapsed === false, "描かれていない印の所を押したら折りたたまれた");
    await page.mouse.down();
    await page.mouse.move(t.cx + 40, t.cy + 30, { steps: 5 });
    await page.mouse.up();
    const moved = await page.evaluate(({ id, x0, y0 }) => {
      const n = window.__fourD.store.doc.nodes[id];
      return Math.hypot(n.x - x0, n.y - y0);
    }, t);
    assert(moved > 50, `そこから押して動かしてもノードが動かない (${moved})`);
    await page.evaluate(() => window.__fourD.store.undo());
    // 折りたたみ中は compact でも印を描くので、押すと開く
    await page.evaluate((id) => window.__fourD.app.cmd.toggleCollapse([id]), t.id);
    assert((await hitAt()) === "badge", `折りたたみ中の印に当たらない: ${await hitAt()}`);
    await page.mouse.click(t.cx, t.cy);
    const reopened = await page.evaluate((id) => window.__fourD.store.doc.nodes[id].collapsed, t.id);
    assert(reopened === false, "折りたたみ中の印を押しても開かない");
    await page.evaluate(() => {
      const f = window.__fourD;
      f.store.undo();
      f.store.undo();
      f.ui.clearSelection();
    });
  });

  await check("クリックのすぐ後にパン・ドラッグしても、離した所の dblclick でノードを作ったり編集を始めたりしない", async () => {
    const id = await idByTitle(page, "E2Eの目標");
    const center = (nid) =>
      page.evaluate((x) => {
        const f = window.__fourD;
        const v = f.app.view;
        const n = f.store.doc.nodes[x];
        f.ui.clearSelection();
        v.stopCameraAnimation();
        v.camera.zoom = 1;
        v.camera.x = v.width / 2 - n.x;
        v.camera.y = v.height / 2 - n.y;
        v.cameraChanged();
      }, nid);
    await center(id);
    await page.waitForTimeout(60);
    const r = await page.locator(".graph-canvas").boundingBox();
    // 何もない所（右下のミニマップ・拡大縮小のボタンにかからない所）
    const empty = await page.evaluate(() => {
      const v = window.__fourD.app.view;
      for (let y = 120; y < v.height - 200; y += 37) for (let x = 120; x < v.width - 340; x += 41) if (v.hitTest(x, y).kind === "empty") return { x, y };
      return null;
    });
    assert(empty, "空き所が見つからない");
    const editing = () => page.evaluate(() => !!document.querySelector(".inline-editor"));
    try {
      // 何もない所: クリック → すぐに押してパン（2 回目の押しはダブルクリックの数え方になる）
      const before = await state(page);
      await page.mouse.click(r.x + empty.x, r.y + empty.y);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.move(r.x + empty.x + 90, r.y + empty.y + 20, { steps: 6 });
      await page.mouse.up({ clickCount: 2 });
      await page.waitForTimeout(60);
      const mid = await state(page);
      assert(mid.nodes === before.nodes && !(await editing()), `パンの後の dblclick でノードができた: ${before.nodes} → ${mid.nodes}`);
    } finally {
      await closeInlineEditor(page);
    }
    // ノード: クリック → すぐに押してドラッグ
    await center(id);
    await page.waitForTimeout(60);
    const p = await screenOf(page, id);
    const n0 = await page.evaluate((nid) => ({ ...window.__fourD.store.doc.nodes[nid] }), id);
    try {
      await page.mouse.click(p.x, p.y);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.move(p.x + 60, p.y + 40, { steps: 6 });
      await page.mouse.up({ clickCount: 2 });
      await page.waitForTimeout(60);
      const n1 = await page.evaluate((nid) => ({ ...window.__fourD.store.doc.nodes[nid] }), id);
      assert(n1.x !== n0.x && !(await editing()), `ドラッグの後の dblclick で編集が始まった（動き ${n1.x - n0.x}）`);
    } finally {
      await closeInlineEditor(page);
      await page.evaluate(() => window.__fourD.store.undo());
    }
    // ふつうのダブルクリックは今までどおり編集を始める
    await page.mouse.dblclick(p.x, p.y);
    await page.waitForFunction(() => document.activeElement?.classList.contains("inline-editor"));
    await page.keyboard.press("Escape");
    assert(!(await editing()), "Esc で編集が閉じない");
  });

  await check("タイトルの欄: 日本語入力の変換中の Esc・Tab は入力に任せる（編集を取り消さない・子を作らない）", async () => {
    const id = await idByTitle(page, "E2Eの目標");
    await startInlineEdit(page, id);
    const before = await state(page);
    const r = await page.evaluate(() => {
      const ta = document.querySelector(".inline-editor");
      const open = () => !!document.querySelector(".inline-editor");
      const send = (init) => ta.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      send({ key: "Escape", isComposing: true }); // macOS の Chrome
      const esc1 = open();
      send({ key: "Escape", keyCode: 229 }); // Safari（isComposing は false で来る）
      const esc2 = open();
      send({ key: "Tab", keyCode: 229 }); // Safari の変換中の Tab
      return { esc1, esc2, tab: open() };
    });
    const after = await state(page);
    assert(r.esc1 && r.esc2, `変換中の Esc で編集が取り消された: ${JSON.stringify(r)}`);
    assert(r.tab && after.nodes === before.nodes, `変換中の Tab で確定して子ができた: ${JSON.stringify(r)} ${before.nodes} → ${after.nodes}`);
    // 変換していない Esc は今までどおり取り消す
    await page.keyboard.press("Escape");
    const closed = await page.evaluate((nid) => ({ open: !!document.querySelector(".inline-editor"), title: window.__fourD.store.doc.nodes[nid].title }), id);
    assert(!closed.open && closed.title === "E2Eの目標", JSON.stringify(closed));
  });

  await check("タイトルの欄: Ctrl+S は題名を確定してアプリが保存する（ブラウザの保存に行かない）。Ctrl+Z・Ctrl+A は文字の編集のまま", async () => {
    const id = await idByTitle(page, "E2Eの目標");
    await startInlineEdit(page, id);
    const value = () => page.evaluate(() => document.querySelector(".inline-editor")?.value ?? null);
    let r;
    try {
      const rev0 = await page.evaluate(() => window.__fourD.store.revision);
      await page.keyboard.type("abc");
      await page.keyboard.press("Control+z");
      const v1 = await value();
      assert(v1 !== null && v1 !== "abc", `Ctrl+Z で欄の文字が戻らない: ${v1}`);
      await page.keyboard.press("Control+a");
      await page.keyboard.type("保存の題名");
      assert((await value()) === "保存の題名", `Ctrl+A で欄の文字を全部選べない: ${await value()}`);
      const rev1 = await page.evaluate(() => window.__fourD.store.revision);
      assert(rev1 === rev0, "欄の中の Ctrl+Z・Ctrl+A がドキュメントの操作になった");
      await page.evaluate(() => {
        window.__saveKey = null;
        window.__saveKeyFn = (e) => {
          if (e.key.toLowerCase() === "s") window.__saveKey = e.defaultPrevented;
        };
        window.addEventListener("keydown", window.__saveKeyFn);
      });
      await page.keyboard.press("Control+s");
      await page.locator(".toast-text", { hasText: /保存しました|保存しています/ }).first().waitFor({ timeout: 3000 }).catch(() => undefined);
      r = await page.evaluate((nid) => {
        window.removeEventListener("keydown", window.__saveKeyFn);
        return { title: window.__fourD.store.doc.nodes[nid].title, open: !!document.querySelector(".inline-editor"), prevented: window.__saveKey, toasts: [...document.querySelectorAll(".toast-text")].map((t) => t.textContent) };
      }, id);
    } finally {
      await closeInlineEditor(page);
    }
    assert(r.prevented === true, `Ctrl+S がアプリに届かない（ブラウザの「ページを保存」が開く）: ${JSON.stringify(r)}`);
    assert(r.title === "保存の題名" && !r.open, `Ctrl+S で題名が確定しない: ${JSON.stringify(r)}`);
    assert(r.toasts.some((t) => /保存しました|保存しています/.test(t)), `保存のお知らせが出ない: ${r.toasts.join(" / ")}`);
    await page.evaluate(() => window.__fourD.store.undo());
    const title = await page.evaluate((nid) => window.__fourD.store.doc.nodes[nid].title, id);
    assert(title === "E2Eの目標", `片付けで戻らない: ${title}`);
  });

  await check("キャンバスから素早く出ても、ノードのホバーの光が残らない", async () => {
    const id = await idByTitle(page, "E2Eの目標");
    const p = await screenOf(page, id);
    const hover = await page.evaluate(async ({ x, y }) => {
      const f = window.__fourD;
      const c = f.app.view.canvas;
      f.ui.setHover(null, null);
      const o = { pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y };
      // ノードの上で動いた（ホバーの更新は次のフレーム）→ そのフレームより前に外へ出た
      c.dispatchEvent(new PointerEvent("pointermove", { ...o, bubbles: true }));
      c.dispatchEvent(new PointerEvent("pointerleave", o));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return f.ui.hover.node;
    }, p);
    assert(hover === null, `外へ出たのにホバーが残る: ${hover}`);
  });

  await check("リスト表示の間は隠れたキャンバスを描き続けない（地図に戻すと描き直す）", async () => {
    const id = await idByTitle(page, "E2Eの目標");
    await page.evaluate((nid) => {
      const f = window.__fourD;
      const v = f.app.view;
      const n = f.store.doc.nodes[nid];
      f.ui.select([nid]);
      v.stopCameraAnimation();
      v.camera.zoom = 1;
      v.camera.x = v.width / 2 - n.x;
      v.camera.y = v.height / 2 - n.y;
      v.cameraChanged();
    }, id);
    await page.waitForTimeout(100);
    const flowing = await framesIn(page, 300);
    assert(flowing > 5, `確かめの前提: 選んだ経路の流れが動いていない (${flowing} フレーム)`);
    let hidden;
    try {
      await page.evaluate(() => window.__fourD.ui.setPrefs({ view: "list" }));
      await page.waitForTimeout(100);
      hidden = await framesIn(page, 400);
    } finally {
      await page.evaluate(() => window.__fourD.ui.setPrefs({ view: "map" }));
    }
    assert(hidden <= 1, `リスト表示の間もキャンバスを描いている (${hidden} フレーム)`);
    await page.waitForTimeout(100);
    const back = await framesIn(page, 300);
    assert(back > 5, `地図に戻しても描き直さない (${back} フレーム)`);
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  });

  await check("ミニマップ: 指で動かしてもブラウザに取られず、取られて止まったら押したままにしない", async () => {
    const r = await page.evaluate(() => {
      const v = window.__fourD.app.view;
      const c = document.querySelector(".minimap-canvas");
      const b = c.getBoundingClientRect();
      const at = (x, y) => ({ pointerId: 1, pointerType: "touch", isPrimary: true, clientX: b.left + x, clientY: b.top + y, bubbles: true, cancelable: true });
      const out = { touchAction: getComputedStyle(c).touchAction };
      for (const end of ["pointercancel", "lostpointercapture"]) {
        c.dispatchEvent(new PointerEvent("pointerdown", at(60, 60)));
        c.dispatchEvent(new PointerEvent(end, at(60, 60)));
        // 指はもう離れている（押していない）のに来た動き
        const cam = { x: v.camera.x, y: v.camera.y };
        c.dispatchEvent(new PointerEvent("pointermove", at(150, 100)));
        out[end] = Math.hypot(v.camera.x - cam.x, v.camera.y - cam.y);
      }
      c.dispatchEvent(new PointerEvent("pointerup", at(150, 100)));
      if (c.hasPointerCapture(1)) c.releasePointerCapture(1);
      return out;
    });
    assert(r.touchAction === "none", `指で動かすとブラウザのスクロールに取られる（touch-action: ${r.touchAction}）`);
    assert(r.pointercancel === 0, `pointercancel の後も押したままになる（${r.pointercancel.toFixed(1)}px 動いた）`);
    assert(r.lostpointercapture === 0, `捕まえが外れた後も押したままになる（${r.lostpointercapture.toFixed(1)}px 動いた）`);
  });

  // Safari・Mac でだけ起きることは、その環境のふりをした一時表示（?demo）で確かめる
  let envPage = null;
  const openEnvPage = async () => {
    if (envPage) return envPage;
    envPage = await ctx.newPage();
    watch(envPage);
    await envPage.addInitScript(() => {
      // Safari のように GestureEvent がある・Mac として振る舞う・resolution のメディアクエリを覚えておく
      window.GestureEvent = class GestureEvent extends UIEvent {};
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel", configurable: true });
      const orig = window.matchMedia.bind(window);
      window.__resolutionQueries = [];
      window.matchMedia = (q) => {
        const m = orig(q);
        if (q.includes("resolution")) window.__resolutionQueries.push(m);
        return m;
      };
    });
    await envPage.goto(`${BASE}?demo`, { waitUntil: "networkidle" });
    await envPage.waitForFunction(() => !!window.__fourD);
    // 前の確かめの表示の設定（リスト表示など）を持ち込まない（一時表示なので設定は保存されない）
    await envPage.evaluate(() => window.__fourD.ui.setPrefs({ view: "map", showMinimap: true }));
    await envPage.waitForFunction(() => window.__fourD.app.view.width > 0);
    return envPage;
  };

  await check("Safari（macOS）のトラックパッドのピンチ（gesture*）でキャンバスを拡大縮小し、ページは拡大させない", async () => {
    const p = await openEnvPage();
    const r = await p.evaluate(() => {
      const v = window.__fourD.app.view;
      v.stopCameraAnimation();
      v.camera.x = 0;
      v.camera.y = 0;
      v.camera.zoom = 1;
      v.cameraChanged();
      const c = v.canvas;
      const b = c.getBoundingClientRect();
      const send = (type, scale) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(e, { scale, clientX: b.left + 200, clientY: b.top + 100 });
        c.dispatchEvent(e);
        return e.defaultPrevented;
      };
      const prevented = [send("gesturestart", 1), send("gesturechange", 1.5), send("gesturechange", 2)];
      const mid = { zoom: v.camera.zoom, x: v.camera.x, y: v.camera.y };
      prevented.push(send("gestureend", 2));
      return { prevented, mid, end: v.camera.zoom };
    });
    assert(r.prevented.every(Boolean), `gesture* を止めない（ページごと拡大される）: ${r.prevented}`);
    // 2 倍に。指の下（200, 100）の所は動かない
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    assert(near(r.mid.zoom, 2) && near(r.mid.x, -200) && near(r.mid.y, -100), `ピンチで拡大しない: ${JSON.stringify(r.mid)}`);
    assert(near(r.end, 2), `ピンチの終わりで拡大率が変わった: ${r.end}`);
  });

  await check("Mac の Ctrl+クリック（右クリック）は選択に足さず、メニューは押したノードだけに効く", async () => {
    const p = await openEnvPage();
    const t = await p.evaluate(() => {
      const f = window.__fourD;
      const v = f.app.view;
      v.fit(undefined, { animate: false });
      f.app.vm.ensure();
      // 画面の中ほど（ミニマップ・拡大縮小のボタンにかからない所）にあるノードを 2 つ
      const inner = f.app.vm.drawNodes.filter((id) => {
        const n = f.store.doc.nodes[id];
        const s = v.camera.toScreen(n.x, n.y);
        const hit = v.hitTest(s.x, s.y);
        return s.x > 120 && s.x < v.width - 260 && s.y > 80 && s.y < v.height - 200 && hit.kind === "node" && hit.node === id;
      });
      if (inner.length < 2) return null;
      const [a, b] = inner;
      f.ui.select([a]);
      const r = v.canvas.getBoundingClientRect();
      const at = (id) => {
        const n = f.store.doc.nodes[id];
        const s = v.camera.toScreen(n.x, n.y);
        return { x: r.left + s.x, y: r.top + s.y };
      };
      return { a, b, pa: at(a), pb: at(b) };
    });
    assert(t, "押せるノードが 2 つ見つからない");
    const sel = () => p.evaluate(() => [...window.__fourD.ui.selection.nodes]);
    await p.keyboard.down("Control");
    await p.mouse.click(t.pb.x, t.pb.y);
    await p.keyboard.up("Control");
    const afterDown = await sel();
    // Mac では続けて contextmenu が来る（Linux の Chromium では来ないので送る）
    await p.evaluate(({ x, y }) => window.__fourD.app.view.canvas.dispatchEvent(new MouseEvent("contextmenu", { clientX: x, clientY: y, ctrlKey: true, bubbles: true, cancelable: true })), t.pb);
    const afterMenu = await sel();
    await p.waitForTimeout(20);
    await p.keyboard.press("Escape");
    assert(afterDown.length === 1 && afterDown[0] === t.a, `Ctrl+クリックで選択に足された: ${afterDown.join(", ")}`);
    assert(afterMenu.length === 1 && afterMenu[0] === t.b, `メニューが押していないノードにも効く: ${afterMenu.join(", ")}`);
    // ⌘+クリックは今までどおり選択に足す
    await p.keyboard.down("Meta");
    await p.mouse.click(t.pa.x, t.pa.y);
    await p.keyboard.up("Meta");
    const added = await sel();
    assert(added.length === 2 && added.includes(t.a) && added.includes(t.b), `⌘+クリックで選択に足せない: ${added.join(", ")}`);
  });

  await check("画素の細かさが違う画面へ移ると、キャンバスとミニマップの描く大きさを合わせ直す", async () => {
    const p = await openEnvPage();
    const size = () => p.evaluate(() => ({ dpr: devicePixelRatio, canvas: window.__fourD.app.view.canvas.width, css: window.__fourD.app.view.width, mini: document.querySelector(".minimap-canvas").width }));
    const s0 = await size();
    assert(s0.dpr === 1 && s0.canvas === s0.css && s0.mini === 208, `確かめの前提: ${JSON.stringify(s0)}`);
    const cdp = await ctx.newCDPSession(p);
    // 画面を移ると、ブラウザは外れた resolution のメディアクエリに change を送る（ヘッドレスの切り替えでは来ないので、ここで送る）
    const moveTo = async (dsf) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: dsf, mobile: false });
      await p.evaluate(() => {
        const list = window.__resolutionQueries;
        window.__resolutionQueries = [];
        for (const m of list) {
          if (m.matches) window.__resolutionQueries.push(m);
          else m.dispatchEvent(new Event("change"));
        }
      });
      await p.waitForTimeout(200);
    };
    await moveTo(2);
    const s1 = await size();
    await moveTo(1);
    const s2 = await size();
    await cdp.detach();
    await p.close();
    envPage = null;
    assert(s1.dpr === 2 && s1.canvas === s1.css * 2 && s1.mini === 416, `2 倍の画面へ移っても描く大きさが前のまま: ${JSON.stringify(s1)}`);
    assert(s2.dpr === 1 && s2.canvas === s2.css && s2.mini === 208, `1 倍の画面へ戻しても合わない: ${JSON.stringify(s2)}`);
  });

  await check("時間軸を押すと時点が決まり、シナリオを切り替えられる", async () => {
    const box = await page.locator(".timeline-canvas").boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const cursor = await page.evaluate(() => window.__fourD.ui.prefs.timeCursor);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(cursor ?? ""), String(cursor));
    await page.locator(".scen-chip", { hasText: "早期独立" }).click();
    const sid = await page.evaluate(() => window.__fourD.ui.prefs.scenarioId);
    assert(sid === "s_early", String(sid));
    const off = await page.evaluate(() => window.__fourD.app.vm.node("n_demo_stay").offScenario);
    assert(off === true, "シナリオ外が薄くならない");
    await shot("e2e-04-time-scenario");
    await page.locator(".scen-chip", { hasText: "すべて" }).click();
    await page.locator(".timeline-cursor-btn").click();
  });

  await check("時間軸の再生中でも、シナリオのボタンが押せる", async () => {
    await page.locator(".timeline-play").click();
    await page.waitForTimeout(300);
    await page.locator(".scen-chip", { hasText: "早期独立" }).click();
    const sid = await page.evaluate(() => window.__fourD.ui.prefs.scenarioId);
    assert(sid === "s_early", `再生中に押せない: ${sid}`);
    await page.locator(".scen-chip", { hasText: "すべて" }).click();
    await page.waitForTimeout(7200); // 再生が終わるまで
    if (await page.locator(".timeline-cursor-btn.on").count()) await page.locator(".timeline-cursor-btn").click();
  });

  await check("リスト: 絞り込んだときの全選択は、表に出ている行だけ", async () => {
    await page.evaluate(() => {
      const f = window.__fourD;
      f.ui.setPrefs({ view: "list", projectFilter: ["p_spelldash"], projectMode: "dim" });
    });
    await page.waitForTimeout(200);
    const shown = await page.evaluate(() => window.__fourD.app.listIds().length);
    await page.locator(".list-view").click({ position: { x: 300, y: 80 } }).catch(() => undefined);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Control+a");
    const sel = await page.evaluate(() => window.__fourD.ui.selection.nodes.size);
    const total = await page.evaluate(() => Object.keys(window.__fourD.store.doc.nodes).length);
    assert(sel === shown && sel < total, `選ばれた ${sel}・表 ${shown}・全体 ${total}`);
    await page.evaluate(() => {
      const f = window.__fourD;
      f.ui.clearSelection();
      f.ui.setPrefs({ view: "map", projectFilter: [] });
    });
  });

  await check("保存して再読み込みしても残る（ようこそは出ない）", async () => {
    await waitSaved(page);
    const before = await state(page);
    // 表示の設定を変えてすぐ開き直しても、設定は残る（まとめて書く前でも、閉じるときに書く）
    await page.evaluate(() => window.__fourD.ui.setPrefs({ edgeMode: "cross" }));
    await page.reload({ waitUntil: "networkidle" });
    assert((await page.evaluate(() => window.__fourD.ui.prefs.edgeMode)) === "cross", "すぐ開き直すと表示の設定が消えた");
    await page.evaluate(() => window.__fourD.ui.setPrefs({ edgeMode: "all" }));
    await page.waitForFunction(() => !!window.__fourD);
    const after = await state(page);
    assert(after.nodes === before.nodes && after.edges === before.edges, JSON.stringify({ before, after }));
    assert((await page.locator(".welcome-modal").count()) === 0, "ようこそがまた出た");
    const has = await page.evaluate(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "E2Eの目標" && n.tags.includes("E2E")));
    assert(has, "編集が残っていない");
  });

  await check("2 つ目のタブは閲覧のみ・「このタブで編集する」で引き継げる", async () => {
    const p2 = await ctx.newPage();
    watch(p2);
    await p2.goto(BASE, { waitUntil: "networkidle" });
    await p2.waitForFunction(() => !!window.__fourD);
    const s2 = await state(p2);
    assert(s2.readOnly === true, "2 つ目のタブが編集できてしまう");
    await p2.getByRole("button", { name: "このタブで編集する" }).click();
    await p2.waitForFunction(() => window.__fourD.store.readOnly === false);
    await page.waitForFunction(() => window.__fourD.store.readOnly === true);
    // 新しいタブで編集 → 元のタブ（閲覧のみ）に反映される
    await p2.evaluate(() => window.__fourD.app.cmd.createNode("goal", { x: -600, y: 900 }, { title: "別タブの目標", exact: true }));
    await p2.waitForFunction(() => window.__fourD.persistence.status === "saved");
    await page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "別タブの目標"), null, { timeout: 4000 });
    await shot("e2e-05-readonly", page);
    await p2.close();
    // 元のタブに戻して編集を引き継ぐ
    await page.getByRole("button", { name: "このタブで編集する" }).click();
    await page.waitForFunction(() => window.__fourD.store.readOnly === false);
  });

  let exported = null;
  await check("JSON でエクスポートできる（中身はそのまま読める）", async () => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+e")]);
    const file = path.join(os.tmpdir(), `4d-e2e-${Date.now()}.json`);
    await dl.saveAs(file);
    exported = file;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const s = await state(page);
    assert(json.schema === "4d-branch" && json.version === 1, "schema");
    assert(Object.keys(json.nodes).length === s.nodes, "ノードの数が違う");
    assert(/^4d-branch_\d{4}-\d{2}-\d{2}_\d{4}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  });

  await check("JSON をインポート（追加）→ 元に戻す", async () => {
    const before = await state(page);
    const chooser = page.waitForEvent("filechooser");
    await page.evaluate(() => window.__fourD.app.pickImport());
    await (await chooser).setFiles(exported);
    await page.getByRole("dialog", { name: "JSON を読み込む" }).waitFor();
    await page.getByRole("button", { name: "読み込む" }).click();
    const mid = await state(page);
    assert(mid.nodes === before.nodes * 2, `追加: ${before.nodes} → ${mid.nodes}`);
    assert(mid.sel.length === mid.nodes - before.nodes, `足した分が選ばれていない: ${mid.sel.length}`);
    const projects = await page.evaluate(() => window.__fourD.store.doc.projectOrder.length);
    assert(projects === 3, `同じ名前のプロジェクトはまとまる: ${projects}`);
    await page.locator(".graph-canvas").focus();
    await page.keyboard.press("Control+z");
    const after = await state(page);
    assert(after.nodes === before.nodes, "Undo で戻らない");
  });

  await check("バックアップと復元のダイアログ（手動バックアップ → 一覧に出る）", async () => {
    await page.evaluate(() => window.__fourD.app.openBackups());
    await page.getByRole("dialog", { name: "バックアップと復元" }).waitFor();
    await page.getByRole("button", { name: "今すぐバックアップ" }).click();
    await page.locator(".backup-row .kind-manual").first().waitFor();
    await shot("e2e-06-backups");
    await page.keyboard.press("Escape");
  });

  await check("競合: 別の保存で止まったら ⌘S は「保存しました」と言わず、「最新を開く」でもこのタブの内容をバックアップに残す", async () => {
    await waitSaved(page);
    await bumpStoredRev(page);
    await page.evaluate(() => window.__fourD.app.cmd.createNode("action", { x: -600, y: 1300 }, { title: "競合の前に足した", exact: true }));
    await page.waitForFunction(() => window.__fourD.persistence.status === "conflict", null, { timeout: 5000 });
    await page.getByRole("button", { name: "保存されている最新を開く" }).waitFor();
    // 競合に気づいた後にも書き足す（この変更はまだどこにも無い）
    await page.evaluate(() => window.__fourD.app.cmd.createNode("action", { x: -600, y: 1450 }, { title: "気づいた後の変更", exact: true }));
    await page.locator(".graph-canvas").focus();
    await page.keyboard.press("Control+s");
    await page.waitForTimeout(300);
    const toasts = await page.locator(".toast-text").allTextContents();
    assert(!toasts.includes("保存しました"), `競合なのに「保存しました」: ${toasts.join(" / ")}`);
    await page.getByRole("button", { name: "保存されている最新を開く" }).click();
    await page.waitForFunction(() => window.__fourD.persistence.status === "saved", null, { timeout: 5000 });
    const kept = await page.evaluate(async () => {
      const p = window.__fourD.persistence;
      const b = (await p.listBackups()).find((x) => x.label === "保存されている最新を開く前のこのタブの内容");
      if (!b) return "バックアップが無い";
      const d = await p.readBackup(b.id);
      return Object.values(d.nodes).some((n) => n.title === "気づいた後の変更") ? "ok" : "気づいた後の変更が無い";
    });
    assert(kept === "ok", kept);
  });

  await check("閉じる直前の変更も消えない（緊急コピー）", async () => {
    const p3 = await ctx.newPage();
    watch(p3);
    await page.close();
    await p3.goto(BASE, { waitUntil: "networkidle" });
    await p3.waitForFunction(() => window.__fourD && window.__fourD.store.readOnly === false);
    await p3.evaluate(() => window.__fourD.app.cmd.createNode("action", { x: -600, y: 1100 }, { title: "閉じる直前", exact: true }));
    await p3.close({ runBeforeUnload: true });
    const p4 = await ctx.newPage();
    watch(p4);
    await p4.goto(BASE, { waitUntil: "networkidle" });
    await p4.waitForFunction(() => !!window.__fourD);
    const ok = await p4.evaluate(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "閉じる直前"));
    assert(ok, "閉じる直前の変更が消えた");
    await p4.close();
  });

  await check("性能: 2,000 ノード（一時表示）でパン・ズームが滑らか", async () => {
    const p5 = await ctx.newPage();
    watch(p5);
    await p5.goto(`${BASE}?stress=2000`, { waitUntil: "networkidle" });
    await p5.waitForFunction(() => !!window.__fourD);
    const n = await p5.evaluate(() => Object.keys(window.__fourD.store.doc.nodes).length);
    assert(n === 2000, `nodes ${n}`);
    const status = await p5.evaluate(() => window.__fourD.persistence.status);
    assert(status === "ephemeral", status);
    // 地図で測る（前の確かめでリスト表示が残っていても）
    await p5.evaluate(() => window.__fourD.ui.setPrefs({ view: "map" }));
    await p5.waitForFunction(() => window.__fourD.app.view.width > 0);
    const stats = await p5.evaluate(async () => {
      const f = window.__fourD;
      const v = f.app.view;
      const measure = async (zoom, frames) => {
        v.camera.zoom = zoom;
        const times = [];
        for (let i = 0; i < frames; i++) {
          v.camera.x -= 25;
          v.camera.y += i % 2 ? 10 : -10;
          v.cameraChanged();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          times.push(v.lastFrameMs);
        }
        times.sort((a, b) => a - b);
        return { avg: times.reduce((s, t) => s + t, 0) / times.length, p95: times[Math.floor(times.length * 0.95)] };
      };
      v.fit(undefined, { animate: false });
      const all = await measure(v.camera.zoom, 40);
      const mid = await measure(0.45, 40);
      const near = await measure(1, 40);
      // 選択して経路を光らせた状態
      f.ui.select([Object.keys(f.store.doc.nodes)[0]]);
      const sel = await measure(0.45, 40);
      return { all, mid, near, sel };
    });
    console.log(`      描画時間 ms（平均 / 95%）: 全体 ${stats.all.avg.toFixed(1)}/${stats.all.p95.toFixed(1)}・中 ${stats.mid.avg.toFixed(1)}/${stats.mid.p95.toFixed(1)}・寄り ${stats.near.avg.toFixed(1)}/${stats.near.p95.toFixed(1)}・選択中 ${stats.sel.avg.toFixed(1)}/${stats.sel.p95.toFixed(1)}`);
    await shot("e2e-07-stress", p5);
    for (const [k, v] of Object.entries(stats)) {
      // 描いていない（0ms）なら測れていない
      assert(v.avg > 0, `${k}: 描画されていない（${v.avg}ms）`);
      assert(v.p95 < 33, `${k}: 95% が 33ms 以上 (${v.p95.toFixed(1)})`);
    }
    // 一時表示は保存しない（ふだんのデータに触れない）
    const saved = await p5.evaluate(async () => {
      const f = window.__fourD;
      f.app.cmd.createNode("goal", { x: 0, y: 0 }, { title: "保存されないはず", exact: true });
      await f.persistence.flush();
      return f.persistence.status;
    });
    assert(saved === "ephemeral", saved);
    await p5.close();
    const p6 = await ctx.newPage();
    await p6.goto(BASE, { waitUntil: "networkidle" });
    await p6.waitForFunction(() => !!window.__fourD);
    const leaked = await p6.evaluate(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "保存されないはず") || Object.keys(window.__fourD.store.doc.nodes).length >= 2000);
    assert(!leaked, "一時表示の内容がふだんのデータに入った");
    await p6.close();
  });

  // ---- 画面の幅（別のコンテキスト = 初めて開いた端末。ここまでのデータとは分ける）
  const wctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await skipAutoFuture(wctx);
  const wp = await wctx.newPage();
  watch(wp);
  await wp.goto(BASE, { waitUntil: "networkidle" });
  await wp.getByRole("button", { name: "すぐに使う" }).click();

  await check("上部バー: どの幅でもはみ出さず、右のパネルの開閉ボタンが見えて押せる（ふだん・一時表示）", async () => {
    await checkTopbarWidths(wp, "ふだん");
    // 一時表示は保存の状態の文がいちばん長い（「一時表示（保存しません）」）
    const demo = await wctx.newPage();
    watch(demo);
    await demo.goto(`${BASE}#demo`, { waitUntil: "networkidle" });
    await demo.waitForFunction(() => window.__fourD?.persistence.status === "ephemeral");
    await checkTopbarWidths(demo, "一時表示");
    // 検索欄がいちばん縮む所（一時表示の 1178px）でも、欄を押せば入力でき（虫めがねの所を押す）、入力の幅が残る（⌘K の印と件数に取られない）
    await demo.setViewportSize({ width: 1178, height: 800 });
    await settleTransitions(demo);
    const box = await demo.locator(".search").boundingBox();
    await demo.mouse.click(box.x + 14, box.y + box.height / 2);
    await demo.keyboard.type("ad");
    const s = await demo.evaluate(() => ({ focused: !!document.activeElement?.classList.contains("search-input"), q: window.__fourD.ui.search, input: Math.round(document.querySelector(".search-input").getBoundingClientRect().width) }));
    assert(s.focused && s.q === "ad" && s.input >= 10, `縮んだ検索欄に入力できない ${JSON.stringify({ ...s, box: Math.round(box.width) })}`);
    await demo.close();
  });

  await check("ちょうど 860px（パネルを重ねて出す幅）では、左右のパネルを閉じて始める", async () => {
    await wp.setViewportSize({ width: 860, height: 800 });
    await wp.reload({ waitUntil: "networkidle" });
    await wp.waitForFunction(() => !!window.__fourD);
    const s = await wp.evaluate(() => ({ left: window.__fourD.ui.prefs.leftOpen, right: window.__fourD.ui.prefs.rightOpen, overlay: getComputedStyle(document.querySelector(".overlay-scrim")).display }));
    assert(!s.left && !s.right && s.overlay === "none", `パネルが重なって開いたまま始まる ${JSON.stringify(s)}`);
  });

  await check("操作ガイド（狭い画面）: パネルを照らすステップでは閉じているパネルを開き、離れると閉じる", async () => {
    await wp.setViewportSize({ width: 400, height: 800 });
    await wp.reload({ waitUntil: "networkidle" });
    await wp.waitForFunction(() => !!window.__fourD);
    const panels = () => wp.evaluate(() => ({ left: window.__fourD.ui.prefs.leftOpen, right: window.__fourD.ui.prefs.rightOpen }));
    // 照らす枠が、幅のある対象を囲むまで待つ（枠は動いてから止まる）
    const lit = (sel) =>
      wp.waitForFunction(
        (s) => {
          const t = document.querySelector(s)?.getBoundingClientRect();
          const hole = document.querySelector(".tour-hole");
          const r = hole?.getBoundingClientRect();
          return !!t && !!r && !hole.hidden && t.width > 100 && t.height > 20 && r.left <= t.left + 1 && r.right >= t.right - 1 && r.top <= t.top + 1 && r.bottom >= t.bottom - 1;
        },
        sel,
        { timeout: 3000 },
      );
    const next = () => wp.locator(".tour-card").getByRole("button", { name: "次へ" }).click();
    assert(JSON.stringify(await panels()) === '{"left":false,"right":false}', "狭い画面でパネルが開いて始まる");
    await wp.evaluate(() => window.__fourD.app.startTour());
    try {
      await lit('.sidebar-left [data-section="projects"]');
      assert((await panels()).left, "1 つ目で左のパネルが開かない");
      const covered = await wp.evaluate(() => {
        const t = document.querySelector('.sidebar-left [data-section="projects"]').getBoundingClientRect();
        const c = document.querySelector(".tour-card").getBoundingClientRect();
        return c.left < t.right && c.right > t.left && c.top < t.bottom && c.bottom > t.top;
      });
      assert(!covered, "1 つ目: 説明の札がプロジェクトの一覧を隠す");
      await next();
      assert(!(await panels()).left, "2 つ目で左のパネルが閉じない");
      await next();
      await next();
      await lit(".sidebar-right");
      assert((await panels()).right, "4 つ目で右のパネルが開かない");
      await next();
      assert(!(await panels()).right, "5 つ目で右のパネルが閉じない");
      // 戻ると開き直し、途中でやめると閉じる
      await wp.locator(".tour-card").getByRole("button", { name: "戻る" }).click();
      await lit(".sidebar-right");
      await wp.keyboard.press("Escape");
      assert((await wp.locator(".tour").count()) === 0, "ガイドが閉じない");
      assert(JSON.stringify(await panels()) === '{"left":false,"right":false}', `ガイドを閉じた後もパネルが開いている ${JSON.stringify(await panels())}`);
    } finally {
      // 落ちてもガイドを残さない（後の確かめの邪魔をしない）
      if (await wp.locator(".tour").count()) await wp.keyboard.press("Escape");
    }
  });

  await check("お知らせ（400px）: 画面の幅いっぱいまで使い、はみ出さない", async () => {
    // 閲覧のみで止められたときのお知らせ（長い文）
    await wp.evaluate(() => {
      const f = window.__fourD;
      f.store.readOnly = true;
      f.store.transact("確かめ", () => undefined);
      f.store.readOnly = false;
    });
    const t = await wp.locator(".toast").last().boundingBox();
    assert(t.x >= 0 && t.x + t.width <= 400, `はみ出す ${JSON.stringify(t)}`);
    assert(t.width >= 300, `お知らせが画面の半分ほどしか使わない（${Math.round(t.width)}px）`);
    if (SHOTS) await wp.waitForTimeout(250); // 出てくる動きが終わってから撮る
    await shot("e2e-08-phone-toast", wp);
  });

  await check("メニューの「性能確認」は同じ画面のまま切り替わり（新しいタブを開かない）、帯の「ふだんの画面へ」で戻る", async () => {
    let opened = 0;
    wctx.on("page", () => opened++);
    await wp.locator(".topbar").getByRole("button", { name: "メニュー", exact: true }).click();
    await Promise.all([wp.waitForEvent("load", { timeout: 10000 }), wp.getByRole("menuitem", { name: /性能確認/ }).click()]);
    await wp.waitForFunction(() => window.__fourD && Object.keys(window.__fourD.store.doc.nodes).length === 2000, null, { timeout: 15000 });
    assert(opened === 0, "新しいタブが開いた");
    const s = await wp.evaluate(() => ({ hash: location.hash, status: window.__fourD.persistence.status }));
    assert(s.hash === "#stress-2000" && s.status === "ephemeral", JSON.stringify(s));
    await Promise.all([wp.waitForEvent("load", { timeout: 10000 }), wp.getByRole("button", { name: "ふだんの画面へ" }).click()]);
    await wp.waitForFunction(() => !!window.__fourD);
    const back = await wp.evaluate(() => ({ hash: location.hash, status: window.__fourD.persistence.status, nodes: Object.keys(window.__fourD.store.doc.nodes).length }));
    assert(back.hash === "" && back.status !== "ephemeral" && back.nodes < 2000, JSON.stringify(back));
  });

  await check("競合の帯（400px）: 文は 1 行目に、2 つのボタンは下に折り返して画面に収まる", async () => {
    await wp.waitForFunction(() => window.__fourD.persistence.writer);
    await bumpStoredRev(wp);
    await wp.evaluate(() => window.__fourD.app.cmd.createNode("action", { x: -600, y: 1300 }, { title: "幅の確かめ", exact: true }));
    await wp.waitForFunction(() => window.__fourD.persistence.status === "conflict", null, { timeout: 5000 });
    const m = await wp.evaluate(() => {
      const vw = window.innerWidth;
      const banner = document.querySelector(".banner");
      const out = [banner, ...banner.querySelectorAll("*")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.left < -0.5 || r.right > vw + 0.5);
        })
        .map((el) => el.getAttribute("class") || el.tagName);
      const text = banner.querySelector(".banner-text").getBoundingClientRect();
      const buttons = [...banner.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
      return { vw, out, buttons: buttons.length, text: Math.round(text.width), banner: Math.round(banner.getBoundingClientRect().width), below: buttons.every((b) => b.top >= text.bottom - 1) };
    });
    await shot("e2e-09-phone-conflict", wp);
    assert(m.buttons === 2, `ボタンの数 ${m.buttons}`);
    assert(m.out.length === 0, `画面の外: ${m.out.join(" / ")}`);
    assert(m.text >= m.banner * 0.7, `文が押しつぶされる（文 ${m.text}px・帯 ${m.banner}px）`);
    assert(m.below, "ボタンが文の下に折り返さない");
  });
  await wctx.close();

  // ---- やりたいことリスト（別のコンテキスト = 初めて開いた端末）
  const lctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await skipAutoFuture(lctx);
  const lp = await lctx.newPage();
  watch(lp);
  await lp.goto(BASE, { waitUntil: "networkidle" });
  await lp.getByRole("button", { name: "すぐに使う" }).click();
  const offerToast = () => lp.locator(".toast", { hasText: "やりたいことリスト" });
  const storedOffered = () => lp.evaluate(() => JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}").wishlistOffered === true);
  const clearOffered = () =>
    lp.evaluate(() => {
      const p = JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}");
      delete p.wishlistOffered;
      localStorage.setItem("4d-branch:prefs", JSON.stringify(p));
    });

  await check("やりたいことリスト: ようこそで知らせた人には、開き直してもお知らせを出さない", async () => {
    // 設定の保存（200ms 遅れ）を待ってから、ほかの確かめが印を付ける前に見る
    await lp.waitForFunction(() => JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}").onboardingDone === true);
    assert(await storedOffered(), "ようこそで印が付かない");
    await lp.reload({ waitUntil: "networkidle" });
    await lp.waitForFunction(() => !!window.__fourD?.app);
    await lp.waitForTimeout(1200 + 1000);
    assert((await offerToast().count()) === 0, "ようこそを見た人にもお知らせが出た");
  });

  await check("やりたいことリスト: メニューから確かめて読み込み（置き換え）、3,000 件が地図に出て、滑らかに動き、元に戻せる", async () => {
    const before = await state(lp);
    await lp.getByRole("button", { name: "メニュー", exact: true }).click();
    await lp.getByRole("menuitem", { name: /やりたいことリスト/ }).click();
    const dlg = lp.getByRole("dialog", { name: "やりたいことリストを読み込む" });
    await dlg.waitFor();
    const shown = await dlg.locator(".stat-value").first().textContent();
    assert(shown === "3,000", `やりたいことの件数の表示: ${shown}`);
    await shot("e2e-10-wishlist-dialog", lp);
    await dlg.locator(".radio-card", { hasText: "置き換える" }).click();
    await dlg.getByRole("button", { name: "読み込む" }).click();
    await lp.waitForFunction(() => Object.keys(window.__fourD.store.doc.nodes).length > 3000);
    const s = await lp.evaluate(() => {
      const d = window.__fourD.store.doc;
      const all = Object.values(d.nodes);
      const wishes = all.filter((n) => n.id.startsWith("n_w_") && !/^n_w_(root|hub)_/.test(n.id) && n.type !== "branch");
      return { wishes: wishes.length, branches: all.filter((n) => n.type === "branch").length, projects: d.projectOrder.length, title: d.title, sel: window.__fourD.ui.selection.nodes.size };
    });
    assert(s.wishes === 3000, `やりたいこと ${s.wishes}`);
    assert(s.branches >= 100, `分岐 ${s.branches}`);
    assert(s.projects === 12, `領域 ${s.projects}`);
    assert(s.sel === 0, `置き換えた後に選択が残っている: ${s.sel}`);
    await lp.waitForTimeout(400);
    await shot("e2e-11-wishlist-first", lp);
    // 全体は大きすぎるので、最初の領域（SpellDash事業）に寄って始める
    const first = await lp.evaluate(() => {
      const f = window.__fourD;
      const v = f.app.view;
      const cam = v.camera;
      const pid = f.store.doc.projectOrder.find((p) => f.store.doc.projects[p].name === "SpellDash事業");
      const ids = f.app.vm.index.projectNodes.get(pid) ?? [];
      let inView = 0;
      for (const id of ids) {
        const n = f.store.doc.nodes[id];
        const { x: sx, y: sy } = cam.toScreen(n.x, n.y);
        if (sx > -50 && sy > -50 && sx < v.width + 50 && sy < v.height + 50) inView++;
      }
      return { ids: ids.length, inView, toast: [...document.querySelectorAll(".toast-text")].map((t) => t.textContent).join(" / ") };
    });
    assert(first.ids > 200 && first.inView >= first.ids * 0.9, `SpellDash事業に寄っていない: ${first.inView}/${first.ids}`);
    assert(first.toast.includes("やりたいことリストに入れ替えました"), `お知らせ: ${first.toast}`);
    // 地図を動かしても滑らか（全体・中くらい・寄り）
    const stats = await lp.evaluate(async () => {
      const v = window.__fourD.app.view;
      const measure = async (zoom, frames) => {
        v.camera.zoom = zoom;
        const times = [];
        for (let i = 0; i < frames; i++) {
          v.camera.x -= 25;
          v.camera.y += i % 2 ? 10 : -10;
          v.cameraChanged();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          times.push(v.lastFrameMs);
        }
        times.sort((a, b) => a - b);
        return { avg: times.reduce((s2, t) => s2 + t, 0) / times.length, p95: times[Math.floor(times.length * 0.95)] };
      };
      v.fit(undefined, { animate: false });
      return { all: await measure(v.camera.zoom, 30), mid: await measure(0.3, 30), near: await measure(0.9, 30) };
    });
    console.log(`      描画時間 ms（平均 / 95%）: 全体 ${stats.all.avg.toFixed(1)}/${stats.all.p95.toFixed(1)}・中 ${stats.mid.avg.toFixed(1)}/${stats.mid.p95.toFixed(1)}・寄り ${stats.near.avg.toFixed(1)}/${stats.near.p95.toFixed(1)}`);
    for (const [k, v] of Object.entries(stats)) {
      assert(v.avg > 0, `${k}: 描画されていない（${v.avg}ms）`);
      assert(v.p95 < 33, `${k}: 95% が 33ms 以上 (${v.p95.toFixed(1)})`);
    }
    // 左のプロジェクト（領域）を押すと、その領域に寄る
    await lp.locator(".side-row", { hasText: "旅・体験" }).click();
    await lp.waitForTimeout(500);
    const focus = await lp.evaluate(() => {
      const f = window.__fourD;
      const v = f.app.view;
      const pid = f.store.doc.projectOrder.find((p) => f.store.doc.projects[p].name === "旅・体験");
      const ids = f.app.vm.index.projectNodes.get(pid) ?? [];
      const cam = v.camera;
      let inView = 0;
      for (const id of ids) {
        const n = f.store.doc.nodes[id];
        const { x: sx, y: sy } = cam.toScreen(n.x, n.y);
        if (sx > -50 && sy > -50 && sx < v.width + 50 && sy < v.height + 50) inView++;
      }
      return { filter: f.ui.prefs.projectFilter.length, ids: ids.length, inView };
    });
    assert(focus.filter === 1 && focus.ids > 200, JSON.stringify(focus));
    assert(focus.inView >= focus.ids * 0.9, `旅・体験の大半が画面の外: ${focus.inView}/${focus.ids}`);
    await shot("e2e-12-wishlist-travel", lp);
    await lp.locator(".side-row", { hasText: "旅・体験" }).click();
    // 所要時間のタグで探せる（#1時間 を貼り付けると、その件数と候補がすぐ出る）
    await lp.keyboard.press("Control+k");
    await lp.locator(".search-input").fill("#1時間");
    const hour = await lp.evaluate(() => ({
      count: document.querySelector(".search-count")?.textContent,
      rows: [...document.querySelectorAll(".search-row .search-title")].map((x) => x.textContent),
      tagged: Object.values(window.__fourD.store.doc.nodes).filter((n) => n.tags.includes("1時間")).length,
    }));
    assert(hour.tagged > 100, `#1時間 のタグ ${hour.tagged} 件`);
    assert(hour.count === `${hour.tagged} 件` && hour.rows.length === 50, `#1時間: ${hour.count}・候補 ${hour.rows.length}`);
    await shot("e2e-13-wishlist-search-1h", lp);
    await lp.keyboard.press("Escape");
    await lp.keyboard.press("Escape");
    // 元に戻すと、読み込む前（デモ）に戻る
    await lp.locator(".graph-canvas").focus();
    await lp.keyboard.press("Control+z");
    const after = await state(lp);
    assert(after.nodes === before.nodes, `Undo で戻らない: ${after.nodes} / ${before.nodes}`);
  });

  await check("やりたいことリスト: 追加で読み込むと、デモの 3 つの事業とシナリオにまとまる", async () => {
    const before = await lp.evaluate(() => ({ nodes: Object.keys(window.__fourD.store.doc.nodes).length, projects: window.__fourD.store.doc.projectOrder.length, scenarios: window.__fourD.store.doc.scenarioOrder.length }));
    await lp.evaluate(() => window.__fourD.app.loadWishlist());
    const dlg = lp.getByRole("dialog", { name: "やりたいことリストを読み込む" });
    await dlg.waitFor();
    await dlg.getByRole("button", { name: "読み込む" }).click();
    await lp.waitForFunction((n) => Object.keys(window.__fourD.store.doc.nodes).length > n + 3000, before.nodes);
    const s = await lp.evaluate(() => ({ projects: window.__fourD.store.doc.projectOrder.length, scenarios: window.__fourD.store.doc.scenarioOrder.length, sel: window.__fourD.ui.selection.nodes.size, toast: [...document.querySelectorAll(".toast-text")].map((t) => t.textContent).join(" / ") }));
    assert(s.sel === 0, `追加した分を全部選んでいる（Delete 1 回で消える）: ${s.sel}`);
    assert(s.projects === before.projects + 9, `プロジェクト ${before.projects} → ${s.projects}（事業 3 つはまとまるはず）`);
    assert(s.scenarios === before.scenarios, `シナリオ ${before.scenarios} → ${s.scenarios}`);
    assert(/やりたいことリスト: ノード 3,\d{3} 件/.test(s.toast) && s.toast.includes("プロジェクト 3 件・シナリオ 3 件はまとめました"), `お知らせ: ${s.toast}`);
    await lp.locator(".graph-canvas").focus();
    await lp.keyboard.press("Control+z");
  });

  await check("やりたいことリスト: 前から使っている人には一度だけお知らせが出て、押さずに開き直しても二度は出ない", async () => {
    await clearOffered();
    await lp.reload({ waitUntil: "networkidle" });
    await offerToast().waitFor({ timeout: 5000 });
    assert(await lp.evaluate(() => window.__fourD.ui.prefs.wishlistOffered === true), "出したのに印が立たない");
    await lp.reload({ waitUntil: "networkidle" });
    await lp.waitForFunction(() => !!window.__fourD?.app);
    await lp.waitForTimeout(1200 + 1000);
    assert((await offerToast().count()) === 0, "お知らせが二度出た");
  });

  await check("やりたいことリスト: お知らせの「見る」をダブルクリックしても、確かめの画面は 1 枚だけ（2 回読み込まない）", async () => {
    await clearOffered();
    await lp.reload({ waitUntil: "networkidle" });
    await offerToast().waitFor({ timeout: 5000 });
    await offerToast().getByRole("button", { name: "見る" }).dblclick();
    await lp.getByRole("dialog", { name: "やりたいことリストを読み込む" }).first().waitFor();
    await lp.waitForTimeout(300);
    const dialogs = await lp.getByRole("dialog", { name: "やりたいことリストを読み込む" }).count();
    assert(dialogs === 1, `確かめの画面が ${dialogs} 枚開いた`);
    // 開いている間にメニューから開こうとしても、もう 1 枚は開かない
    await lp.evaluate(() => window.__fourD.app.loadWishlist());
    assert((await lp.getByRole("dialog", { name: "やりたいことリストを読み込む" }).count()) === 1, "メニューからも 2 枚目が開いた");
    // ラジオは画面ごとの組で、どちらかが選ばれている
    const checked = await lp.locator(".modal .radio-card input:checked").count();
    assert(checked === 1, `選ばれている読み込み方が ${checked} 個`);
    await lp.keyboard.press("Escape");
    await lp.waitForTimeout(300);
    // 閉じた後は、また開ける
    await lp.evaluate(() => window.__fourD.app.loadWishlist());
    await lp.getByRole("dialog", { name: "やりたいことリストを読み込む" }).waitFor();
    await lp.keyboard.press("Escape");
  });

  await check("やりたいことリスト: 閲覧のみのタブは印を使い切らず、「このタブで編集する」で編集できるようになってからお知らせを出す", async () => {
    await clearOffered();
    const lp2 = await lctx.newPage();
    watch(lp2);
    await lp2.goto(BASE, { waitUntil: "networkidle" });
    await lp2.waitForFunction(() => !!window.__fourD?.app && window.__fourD.store.readOnly === true);
    await lp2.waitForTimeout(1200 + 1000);
    assert((await lp2.locator(".toast", { hasText: "やりたいことリスト" }).count()) === 0, "閲覧のみのタブにお知らせが出た");
    assert(!(await storedOffered()), "閲覧のみのタブが印を立てた");
    await lp2.getByRole("button", { name: "このタブで編集する" }).click();
    await lp2.locator(".toast", { hasText: "やりたいことリスト" }).waitFor({ timeout: 5000 });
    await lp2.waitForTimeout(400);
    assert(await storedOffered(), "出したのに印が保存されない");
    await lp2.close();
  });
  await lctx.close();

  // ---- 未来の道筋（別のコンテキスト = 初めて開いた端末）
  const fctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await skipAutoFuture(fctx);
  const fp = await fctx.newPage();
  watch(fp);
  await fp.goto(BASE, { waitUntil: "networkidle" });
  await fp.getByRole("button", { name: "すぐに使う" }).click();
  const forecastOf = () =>
    fp.evaluate(() => {
      const fc = window.__fourD.app.vm.forecast;
      return { active: fc.active, ends: fc.ends.length, sum: fc.ends.reduce((n, id) => n + fc.reach.get(id).p, 0), longest: fc.longest };
    });

  await check("未来の道筋: メニューから確かめて読み込み（置き換え）、今日の近くに寄り、行き先の見込みが合計 100% で並ぶ", async () => {
    const before = await state(fp);
    await fp.getByRole("button", { name: "メニュー", exact: true }).click();
    await fp.getByRole("menuitem", { name: /未来の道筋（仕事・10 年）を読み込む/ }).click();
    const dlg = fp.getByRole("dialog", { name: "未来の道筋を読み込む" });
    await dlg.waitFor();
    await shot("e2e-14-future-dialog", fp);
    await dlg.locator(".radio-card", { hasText: "置き換える" }).click();
    await dlg.getByRole("button", { name: "読み込む" }).click();
    await fp.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true));
    await fp.waitForTimeout(500);
    const fc = await forecastOf();
    assert(fc.active && fc.ends >= 3, JSON.stringify(fc));
    assert(Math.abs(fc.sum - 1) < 1e-6, `行き先の見込みの合計 ${fc.sum}`);
    const ov = await fp.evaluate(() => [...document.querySelectorAll(".forecast-ends .end-row .end-pct")].map((x) => x.textContent));
    assert(ov.length === Math.min(14, fc.ends) && ov.every((t) => /%/.test(t)), `概要: ${JSON.stringify(ov)}`);
    const root = await fp.evaluate(() => {
      const f = window.__fourD;
      const n = Object.values(f.store.doc.nodes).find((x) => x.meta?.forecastRoot);
      const v = f.app.view;
      const p = v.camera.toScreen(n.x, n.y);
      return { x: p.x, y: p.y, w: v.width, h: v.height, sel: f.ui.selection.nodes.size };
    });
    assert(root.x > -50 && root.x < root.w + 50 && root.y > -50 && root.y < root.h + 50, `今日が画面の外: ${JSON.stringify(root)}`);
    assert(root.sel === 0, `読み込んだ後に選択が残っている: ${root.sel}`);
    assert((await state(fp)).nodes !== before.nodes, "入れ替わっていない");
    await shot("e2e-15-future-start", fp);
  });

  await check("未来の道筋: 行き先を押すと寄って、ここに至る見込みと今日から何歩目かが出る", async () => {
    await fp.locator(".forecast-ends .end-row").first().click();
    await fp.waitForTimeout(400);
    const t = (await fp.locator(".insp-forecast").textContent()) ?? "";
    assert(/ここに至る見込み/.test(t) && /%/.test(t) && /歩目/.test(t), t);
    await shot("e2e-16-future-end", fp);
  });

  await check("未来の道筋: 分かれ道の線の % を直すと、見込みを計算し直し、元に戻せる", async () => {
    const pick = await fp.evaluate(() => {
      const f = window.__fourD;
      const d = f.store.doc;
      const e = Object.values(d.edges).find((x) => typeof x.meta?.prob === "number" && x.meta.prob >= 10 && x.meta.prob <= 80 && d.nodes[x.source]?.type === "branch");
      return { id: e.id, prob: e.meta.prob, target: e.target, p: f.app.vm.forecast.reach.get(e.target).p };
    });
    await fp.evaluate((id) => window.__fourD.ui.select([], [id]), pick.id);
    const input = fp.locator(".edge-prob");
    await input.waitFor();
    assert((await input.inputValue()) === String(pick.prob), `入力欄 ${await input.inputValue()} / ${pick.prob}`);
    await input.fill(String(pick.prob + 15));
    await input.press("Tab");
    const after = await fp.evaluate((id) => {
      const f = window.__fourD;
      const e = f.store.doc.edges[id];
      return { prob: e.meta.prob, p: f.app.vm.forecast.reach.get(e.target).p };
    }, pick.id);
    assert(after.prob === pick.prob + 15, `見込み ${after.prob}`);
    assert(after.p > pick.p, `計算し直していない: ${pick.p} → ${after.p}`);
    const sum = (await fp.locator(".prob-sum").textContent()) ?? "";
    assert(/合計 \d+%/.test(sum), sum);
    const fc = await forecastOf();
    assert(Math.abs(fc.sum - 1) < 1e-6, `合計が 100% から外れた: ${fc.sum}`);
    await fp.locator(".graph-canvas").focus();
    await fp.keyboard.press("Control+z");
    const undone = await fp.evaluate((id) => window.__fourD.store.doc.edges[id].meta.prob, pick.id);
    assert(undone === pick.prob, `元に戻らない: ${undone}`);
  });

  await check("未来の道筋: シナリオを選ぶと、その道を選んだ場合の見込み（合計 100%）に変わる", async () => {
    await fp.evaluate(() => window.__fourD.ui.clearSelection());
    await fp.locator(".scen-chip", { hasText: "早期独立" }).click();
    await fp.waitForTimeout(300);
    const head = (await fp.locator(".forecast-ends .insp-label").textContent()) ?? "";
    assert(head.includes("早期独立を選んだ場合"), head);
    const fc = await forecastOf();
    assert(fc.active && Math.abs(fc.sum - 1) < 1e-6, `合計 ${fc.sum}`);
    await fp.locator(".scen-chip", { hasText: "すべて" }).click();
  });

  await check("未来の道筋: 地図を動かしても滑らか", async () => {
    const stats = await fp.evaluate(async () => {
      const v = window.__fourD.app.view;
      const measure = async (zoom, frames) => {
        v.camera.zoom = zoom;
        const times = [];
        for (let i = 0; i < frames; i++) {
          v.camera.x -= 25;
          v.camera.y += i % 2 ? 10 : -10;
          v.cameraChanged();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          times.push(v.lastFrameMs);
        }
        times.sort((a, b) => a - b);
        return { avg: times.reduce((s2, t) => s2 + t, 0) / times.length, p95: times[Math.floor(times.length * 0.95)] };
      };
      v.fit(undefined, { animate: false });
      return { all: await measure(v.camera.zoom, 30), mid: await measure(0.3, 30), near: await measure(0.9, 30) };
    });
    console.log(`      描画時間 ms（平均 / 95%）: 全体 ${stats.all.avg.toFixed(1)}/${stats.all.p95.toFixed(1)}・中 ${stats.mid.avg.toFixed(1)}/${stats.mid.p95.toFixed(1)}・寄り ${stats.near.avg.toFixed(1)}/${stats.near.p95.toFixed(1)}`);
    for (const [k, v] of Object.entries(stats)) {
      assert(v.avg > 0, `${k}: 描画されていない（${v.avg}ms）`);
      assert(v.p95 < 33, `${k}: 95% が 33ms 以上 (${v.p95.toFixed(1)})`);
    }
  });

  await check("未来の道筋: 前から使っている人には一度だけお知らせが出て、「見る」で地図の未来の道筋の今日へ寄る", async () => {
    await fp.waitForTimeout(500);
    await fp.evaluate(() => {
      const p = JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}");
      delete p.futureOffered;
      p.wishlistOffered = true;
      localStorage.setItem("4d-branch:prefs", JSON.stringify(p));
    });
    await fp.reload({ waitUntil: "networkidle" });
    const offer = fp.locator(".toast", { hasText: "未来の道筋（仕事・10 年）を用意しました" });
    await offer.waitFor({ timeout: 6000 });
    // 遠くへ動かしておき、「見る」で今日（入口）が選ばれて画面に入る（地図に無ければ読み込みの確認が開く: 別の確かめ）
    await fp.evaluate(() => {
      const v = window.__fourD.app.view;
      v.camera.x = -40000;
      v.camera.zoom = 0.05;
      v.cameraChanged();
    });
    await offer.getByRole("button", { name: "見る" }).click();
    await fp.waitForTimeout(800);
    const r = await fp.evaluate(() => {
      const f = window.__fourD;
      const root = Object.values(f.store.doc.nodes).find((n) => n.meta?.forecastRoot === true);
      const rect = f.app.view.canvas.getBoundingClientRect();
      const s = f.app.view.camera.toScreen(root.x, root.y);
      return { sel: [...f.ui.selection.nodes], root: root.id, onScreen: s.x > 0 && s.x < rect.width && s.y > 0 && s.y < rect.height, dialog: !!document.querySelector(".modal") };
    });
    assert(r.sel.length === 1 && r.sel[0] === r.root && r.onScreen && !r.dialog, JSON.stringify(r));
    await fp.waitForTimeout(500);
    await fp.reload({ waitUntil: "networkidle" });
    await fp.waitForTimeout(1200 + 1000);
    assert((await fp.locator(".toast", { hasText: "未来の道筋（仕事・10 年）を用意しました" }).count()) === 0, "二度目のお知らせが出た");
  });

  await check("未来の道筋: 古い版が入っていれば一度だけ知らせ、「差し替える」で未来の道筋だけを新しい版に入れ替える（自分のノードは残る）", async () => {
    // 古い版で読み込んだ状態を作る: 入口の版を古くし、自分のメモを 1 つ足す
    const prep = await fp.evaluate(() => {
      const f = window.__fourD;
      const root = Object.values(f.store.doc.nodes).find((n) => n.meta?.forecastRoot === true);
      f.app.cmd.updateNode(root.id, { meta: { ...root.meta, futureVersion: "old" } });
      const own = f.app.cmd.createNode("goal", { x: root.x - 2000, y: root.y - 2000 }, { title: "自分で足したメモ", exact: true });
      return { own, nodes: Object.keys(f.store.doc.nodes).length, rootPos: [root.x, root.y] };
    });
    await fp.waitForTimeout(800);
    await fp.evaluate(() => {
      const p = JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}");
      delete p.futureNotified;
      localStorage.setItem("4d-branch:prefs", JSON.stringify(p));
    });
    await fp.reload({ waitUntil: "networkidle" });
    const notice = fp.locator(".toast", { hasText: "未来の道筋の新しい版があります" });
    await notice.waitFor({ timeout: 8000 });
    await notice.getByRole("button", { name: "差し替える" }).click();
    const confirm = fp.getByRole("dialog", { name: "未来の道筋を新しい版に差し替えますか？" });
    await confirm.waitFor();
    await confirm.getByRole("button", { name: "差し替える" }).click();
    await fp.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true && n.meta.futureVersion !== "old"));
    const after = await fp.evaluate((own) => {
      const f = window.__fourD;
      const roots = Object.values(f.store.doc.nodes).filter((n) => n.meta?.forecastRoot === true);
      const fc = f.app.vm.forecast;
      return { own: f.store.doc.nodes[own]?.title, roots: roots.length, pos: [roots[0].x, roots[0].y], nodes: Object.keys(f.store.doc.nodes).length, sum: fc.ends.reduce((n, id) => n + fc.reach.get(id).p, 0), toast: [...document.querySelectorAll(".toast-text")].map((t) => t.textContent).join(" / ") };
    }, prep.own);
    assert(after.own === "自分で足したメモ", `自分のノードが消えた: ${after.own}`);
    assert(after.roots === 1 && after.pos[0] === prep.rootPos[0] && after.pos[1] === prep.rootPos[1], `入口: ${JSON.stringify(after)}`);
    assert(after.nodes === prep.nodes, `ノードの数 ${after.nodes} / ${prep.nodes}`);
    assert(Math.abs(after.sum - 1) < 1e-6, `行き先の見込みの合計 ${after.sum}`);
    assert(after.toast.includes("差し替えました"), after.toast);
    // 同じ版ではもう知らせない
    await fp.waitForTimeout(600);
    await fp.reload({ waitUntil: "networkidle" });
    await fp.waitForTimeout(2600 + 1200);
    assert((await fp.locator(".toast", { hasText: "未来の道筋の新しい版があります" }).count()) === 0, "差し替えた後も知らせた");
  });
  await fctx.close();

  // ---- 未来の道筋の自動表示（別のコンテキスト = デモのまま使っていた端末）
  const actx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ap = await actx.newPage();
  watch(ap);
  await ap.goto(BASE, { waitUntil: "networkidle" });
  await ap.getByRole("button", { name: "すぐに使う" }).click();
  const hasFuture = (p = ap) => p.evaluate(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true));

  await check("未来の道筋: 何もしていないデモのまま開き直すと、今日から自動で開き、元に戻せて、戻した地図は（設定が消えても）もう入れ替えない", async () => {
    // 初めて開いたとき（ようこそ・ガイドの間）は入れ替えない
    await ap.waitForTimeout(1500);
    assert(!(await hasFuture()), "初めて開いたときに入れ替えた");
    await ap.waitForFunction(() => JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}").onboardingDone === true);
    await waitSaved(ap);
    await ap.reload({ waitUntil: "networkidle" });
    await ap.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true), null, { timeout: 10000 });
    const done = ap.locator(".toast", { hasText: "未来の道筋（仕事・10 年）を開きました" });
    await done.waitFor();
    await ap.waitForTimeout(600);
    const s = await ap.evaluate(() => {
      const f = window.__fourD;
      const fc = f.app.vm.forecast;
      return {
        nodes: Object.keys(f.store.doc.nodes).length,
        ends: fc.ends.length,
        sum: fc.ends.reduce((n, id) => n + fc.reach.get(id).p, 0),
        zoom: f.app.view.camera.zoom,
        auto: f.ui.prefs.futureAutoOpened,
        overview: document.querySelectorAll(".forecast-ends .end-row").length,
        text: document.querySelector(".toast-text")?.textContent ?? "",
        root: (() => {
          const n = Object.values(f.store.doc.nodes).find((x) => x.meta?.forecastRoot === true);
          const p = f.app.view.camera.toScreen(n.x, n.y);
          return { x: p.x, y: p.y, w: f.app.view.width, h: f.app.view.height };
        })(),
        // お知らせが、地図の右下の操作（未来の道筋・拡大縮小）を隠さない
        covered: [...document.querySelectorAll(".zoom-ctl button")].filter((b) => {
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return !(hit && b.contains(hit));
        }).length,
      };
    });
    assert(s.nodes > 1500 && s.ends === 14 && Math.abs(s.sum - 1) < 1e-6, JSON.stringify(s));
    // 全体（横 8 万）はいちばん引いても収まらないので、今日（入口）が読める大きさで画面に入る
    assert(s.root.x > 0 && s.root.x < s.root.w && s.root.y > 0 && s.root.y < s.root.h && s.zoom >= 0.3, `今日が読める大きさで画面に入らない ${JSON.stringify(s)}`);
    assert(s.auto === true, "印が立たない");
    assert(s.overview >= 3, "右の概要に行き先が出ない");
    assert(/歩み 1,\d{3}/.test(s.text) && s.text.includes("行き先 14") && s.text.includes("今日"), s.text);
    assert(s.covered === 0, `お知らせが地図の右下の操作 ${s.covered} 個を隠している`);
    await shot("e2e-16-future-auto", ap);
    // 元に戻すとデモに戻り、戻したデモには入れ替えない印が付く
    await done.getByRole("button", { name: "元に戻す" }).click();
    await ap.waitForFunction(() => !Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true));
    assert((await ap.evaluate(() => window.__fourD.store.doc.meta.noAutoFuture)) === true, "戻した地図に印が付かない");
    await waitSaved(ap);
    await ap.waitForTimeout(400);
    await ap.reload({ waitUntil: "networkidle" });
    await ap.waitForTimeout(3000);
    assert(!(await hasFuture()), "元に戻したのに、開き直すとまた入れ替えた");
    // このブラウザの「開いた」の設定が消えても（別の端末・設定をまるごと書く古いタブ）、地図の印で入れ替えない
    await ap.evaluate(() => {
      const p = JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}");
      p.futureAutoOpened = false;
      localStorage.setItem("4d-branch:prefs", JSON.stringify(p));
      localStorage.removeItem("4d-branch:futureAutoOpened");
    });
    await ap.reload({ waitUntil: "networkidle" });
    await ap.waitForTimeout(3000);
    assert(!(await hasFuture()), "設定が消えると、戻した地図をまた入れ替えた");
  });

  await check("地図の右下の「未来の道筋」: デモなら押すとすぐ開き（二度押しでも 1 回）、開いた後は今日を選んで読める大きさで寄る（隠れていれば出す・スマホの幅でも見える）", async () => {
    const btn = ap.locator(".zoom-ctl .future-btn");
    assert(await btn.isVisible(), "ボタンが見えない");
    // 入れ替えない印の付いた地図でも、押せば開く。二度押しても入れ替えは 1 回
    await btn.dblclick();
    await ap.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true));
    await ap.waitForTimeout(800);
    const once = await ap.evaluate(() => ({
      undo: window.__fourD.store.history.undoStack.filter((e) => e.label === "未来の道筋を開く").length,
      toasts: [...document.querySelectorAll(".toast-text")].filter((t) => t.textContent.includes("を開きました")).length,
    }));
    assert(once.undo === 1 && once.toasts === 1, `二度押しで 2 回入れ替えた ${JSON.stringify(once)}`);
    // 遠くへ動かしてから押すと、今日（入口）が選ばれて画面に入る
    await ap.evaluate(() => {
      const v = window.__fourD.app.view;
      v.camera.x = -50000;
      v.camera.y = 3000;
      v.camera.zoom = 0.05;
      v.cameraChanged();
    });
    await btn.click();
    await ap.waitForTimeout(800);
    const r = await ap.evaluate(() => {
      const f = window.__fourD;
      const root = Object.values(f.store.doc.nodes).find((n) => n.meta?.forecastRoot === true);
      const rect = f.app.view.canvas.getBoundingClientRect();
      const s = f.app.view.camera.toScreen(root.x, root.y);
      return { sel: [...f.ui.selection.nodes], root: root.id, x: s.x, y: s.y, w: rect.width, h: rect.height, zoom: f.app.view.camera.zoom };
    });
    assert(r.sel.length === 1 && r.sel[0] === r.root, `今日が選ばれない ${JSON.stringify(r)}`);
    assert(r.x > 0 && r.x < r.w && r.y > 0 && r.y < r.h && r.zoom >= 0.3, `今日が読める大きさで画面に入らない ${JSON.stringify(r)}`);
    // メニューの「読み込む…」でも 2 つ目は足さず、今日へ寄る
    await ap.getByRole("button", { name: "メニュー", exact: true }).click();
    await ap.getByRole("menuitem", { name: /未来の道筋（仕事・10 年）を読み込む/ }).click();
    await ap.locator(".toast", { hasText: "未来の道筋はもう地図にあります" }).waitFor();
    const again = await ap.evaluate(() => ({ roots: Object.values(window.__fourD.store.doc.nodes).filter((n) => n.meta?.forecastRoot === true).length, modal: document.querySelectorAll(".modal").length }));
    assert(again.roots === 1 && again.modal === 0, `メニューから 2 つ目を読み込めた ${JSON.stringify(again)}`);
    // 絞り込み（つながる相手だけ残して隠す）で今日が隠れていても、押せば「薄くする」にして出す
    await ap.evaluate(() => {
      const f = window.__fourD;
      const pid = f.app.cmd.addProject("関係のないプロジェクト");
      f.ui.setPrefs({ projectFilter: [pid], projectMode: "focus" });
    });
    await ap.waitForTimeout(300);
    const hiddenBefore = await ap.evaluate(() => {
      const f = window.__fourD;
      const root = Object.values(f.store.doc.nodes).find((n) => n.meta?.forecastRoot === true);
      return f.app.vm.node(root.id).hidden;
    });
    assert(hiddenBefore === true, "絞り込みで今日が隠れない（確かめの前提）");
    await btn.click();
    await ap.waitForTimeout(600);
    const shown = await ap.evaluate(() => {
      const f = window.__fourD;
      const root = Object.values(f.store.doc.nodes).find((n) => n.meta?.forecastRoot === true);
      return { hidden: f.app.vm.node(root.id).hidden, mode: f.ui.prefs.projectMode };
    });
    assert(!shown.hidden && shown.mode === "dim", `隠れた今日を出さない ${JSON.stringify(shown)}`);
    await ap.evaluate(() => window.__fourD.ui.setPrefs({ projectFilter: [], projectMode: "dim" }));
    // スマホの幅でも、ボタンは画面の中にあって押せる
    await ap.setViewportSize({ width: 390, height: 800 });
    await ap.waitForTimeout(400);
    const box = await btn.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 800, `スマホの幅でボタンが外にはみ出す ${JSON.stringify(box)}`);
    await shot("e2e-17-future-button-phone", ap);
    await ap.setViewportSize({ width: 1440, height: 900 });
  });

  await check("ようこそ画面の「未来の道筋を開く」で、初めての人もすぐ開ける", async () => {
    const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p3 = await c3.newPage();
    watch(p3);
    await p3.goto(BASE, { waitUntil: "networkidle" });
    const welcome = p3.getByRole("dialog", { name: "4D Branch へようこそ" });
    await welcome.waitFor();
    await welcome.getByRole("button", { name: "未来の道筋を開く" }).click();
    await p3.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true));
    const prefs = await p3.evaluate(() => window.__fourD.ui.prefs);
    assert(prefs.onboardingDone === true && prefs.futureAutoOpened === true, JSON.stringify(prefs));
    await c3.close();
  });

  await check("自分で書いた地図は勝手に入れ替えず、「未来の道筋」は追加か入れ替えかを選ぶ確認を出す", async () => {
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await c2.newPage();
    watch(p2);
    await p2.goto(BASE, { waitUntil: "networkidle" });
    await p2.getByRole("button", { name: "すぐに使う" }).click();
    await p2.evaluate(() => window.__fourD.app.cmd.createNode("goal", { x: -900, y: 900 }, { title: "自分で書いた目標", exact: true }));
    await waitSaved(p2);
    await p2.waitForTimeout(400);
    await p2.reload({ waitUntil: "networkidle" });
    await p2.waitForTimeout(3000);
    assert(!(await hasFuture(p2)), "自分で書いた地図を勝手に入れ替えた");
    await p2.locator(".zoom-ctl .future-btn").click();
    await p2.getByRole("dialog", { name: "未来の道筋を読み込む" }).waitFor();
    await c2.close();
  });
  await actx.close();

  await check("ページのエラーが無い", async () => {
    assert(errors.length === 0, errors.join("\n"));
  });

  await browser.close();
  server?.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 件 合格`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server?.kill();
  process.exit(1);
});
