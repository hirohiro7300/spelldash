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

async function main() {
  await startServer();
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
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

  await check("保存して再読み込みしても残る（ようこそは出ない）", async () => {
    await waitSaved(page);
    const before = await state(page);
    await page.reload({ waitUntil: "networkidle" });
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
    // 別の書き手（ロックの使えない環境の別タブなど）が、知らないうちに版を進めた
    await page.evaluate(
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
    for (const [k, v] of Object.entries(stats)) assert(v.p95 < 33, `${k}: 95% が 33ms 以上 (${v.p95.toFixed(1)})`);
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
