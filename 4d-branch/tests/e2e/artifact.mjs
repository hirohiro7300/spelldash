// Artifact 版の E2E（npm run build:artifact の後に npm run e2e:artifact）。
// 公開のときと同じ骨組みで包み、偽の window.claude（db・user・downloads）を入れて確かめる。
// db は Node 側に 1 つだけ持ち、ブラウザのコンテキストをまたいで共有する（＝別の端末）
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGE = path.join(ROOT, "artifact", "4d-branch.html");
const SHOTS = process.env.E2E_SHOTS || "";
if (!fs.existsSync(PAGE)) throw new Error("artifact/4d-branch.html がありません。先に npm run build:artifact を実行してください");

// 公開のときの骨組み（文字コード・viewport・小さな初期化）
const SKELETON_HEAD =
  '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';
const harness = `${SKELETON_HEAD}${fs.readFileSync(PAGE, "utf8")}</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'" });
  res.end(harness);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

// ---- 偽の db（Node 側に 1 つ）
const dbStore = new Map();
const leases = new Map();

const FAKE_CLAUDE = () => {
  const flags = window.__fakeFlags || {};
  const mkDoc = (path) => ({
    async get() {
      const d = await window.__dbGet(path);
      return { exists: d !== null, data: () => (d === null ? undefined : d) };
    },
    async set(data) {
      const r = await window.__dbSet(path, JSON.stringify(data));
      if (r) throw { code: r, message: r };
    },
    async delete() {
      await window.__dbDel(path);
    },
    onSnapshot(next) {
      let last;
      let stop = false;
      const poll = async () => {
        if (stop) return;
        const d = await window.__dbGet(path);
        const key = JSON.stringify(d);
        if (key !== last) {
          last = key;
          next({ exists: d !== null, data: () => (d === null ? undefined : d) });
        }
        setTimeout(poll, 300);
      };
      void poll();
      return () => {
        stop = true;
      };
    },
    async acquire({ holder, ttlMs }) {
      return { acquired: await window.__dbLease(path, holder, ttlMs ?? 30000) };
    },
  });
  window.__saved = [];
  // 機能の返事が遅い（時間切れの後に返ってくる）
  if (flags.slowUseMs) window.__fourDCapabilityTimeoutMs = 300;
  // IndexedDB の使えないブラウザ（localStorage だけ。バックアップは作れない）
  if (flags.noIdb) Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true });
  const memo = new Map();
  window.claude = {
    // 本物と同じく、同じ名前の use() は同じ返事を使い回す
    use(name) {
      if (!memo.has(name)) memo.set(name, this.useOnce(name));
      return memo.get(name);
    },
    async useOnce(name) {
      if (flags.slowUseMs) await new Promise((r) => setTimeout(r, flags.slowUseMs));
      if (name === "downloads") {
        if (flags.noDownloads) return null;
        return Object.freeze({
          async save({ filename, data }) {
            window.__saved.push({ filename, data: String(data) });
            return { status: "saved" };
          },
        });
      }
      if (name === "user") return Object.freeze({ id: async () => (flags.signedOut ? null : "u_test") });
      if (name === "db") {
        if (flags.signedOut) return null;
        const list = async (p) => ({ docs: (await window.__dbList(p)).map((d) => ({ id: d.id, exists: true, data: () => d.data })) });
        return Object.freeze({ doc: mkDoc, collection: (p) => ({ doc: (id) => mkDoc(`${p}/${id}`), get: () => list(p), limit: () => ({ get: () => list(p) }) }) });
      }
      return null;
    },
  };
};

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 4).join("\n      ")}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const errors = [];
async function newDevice(flags = {}, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.exposeBinding("__dbGet", (_s, p) => (dbStore.has(p) ? JSON.parse(dbStore.get(p)) : null));
  await ctx.exposeBinding("__dbSet", (_s, p, json) => {
    if (json.length > 262144) return "invalid_argument";
    dbStore.set(p, json);
    return "";
  });
  await ctx.exposeBinding("__dbDel", (_s, p) => void dbStore.delete(p));
  await ctx.exposeBinding("__dbList", (_s, p) =>
    [...dbStore.keys()].filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes("/")).map((k) => ({ id: k.slice(p.length + 1), data: JSON.parse(dbStore.get(k)) })),
  );
  await ctx.exposeBinding("__dbLease", (_s, p, holder, ttl) => {
    const cur = leases.get(p);
    if (cur && cur.holder !== holder && cur.until > Date.now()) return false;
    leases.set(p, { holder, until: Date.now() + ttl });
    return true;
  });
  await ctx.addInitScript((f) => (window.__fakeFlags = f), flags);
  await ctx.addInitScript(FAKE_CLAUDE);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__fourD);
  return { ctx, page };
}
const cloudState = (page) => page.evaluate(() => window.__fourD.app.cloudInfo?.state ?? null);

console.log(`4D Branch Artifact E2E → ${BASE}`);
let A;
await check("骨組みで包んでも動き、題名は 4D Branch・ようこそが出る", async () => {
  A = await newDevice();
  assert((await A.page.title()) === "4D Branch", await A.page.title());
  await A.page.getByRole("dialog", { name: "4D Branch へようこそ" }).waitFor();
  const text = await A.page.locator(".welcome-modal").innerText();
  assert(text.includes("あなただけが読める場所"), "保存先の説明が Artifact 用になっていない");
  await A.page.getByRole("button", { name: "すぐに使う" }).click();
  SHOTS && (await A.page.screenshot({ path: path.join(SHOTS, "artifact-desktop.png") }));
});

await check("初めての端末: アカウントへ写しを送る（gzip・分割・マニフェスト）", async () => {
  await A.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  const m = JSON.parse(dbStore.get("data/users/u_test/fourd"));
  assert(m.format === 1 && m.enc === "gzip-b64" && m.parts >= 1, JSON.stringify(m).slice(0, 200));
  assert(dbStore.has(`data/users/u_test/fourd/parts/${m.gen}-0`), "分割が無い");
  const footer = await A.page.locator(".side-footer").innerText();
  assert(footer.includes("アカウント: 同期済み"), footer);
});

await check("JSON の書き出しは downloads 機能で保存を頼む", async () => {
  await A.page.locator(".graph-canvas").focus();
  await A.page.keyboard.press("Control+e");
  await A.page.waitForFunction(() => window.__saved.length === 1);
  const saved = await A.page.evaluate(() => window.__saved[0]);
  assert(/^4d-branch_\d{4}-\d{2}-\d{2}_\d{4}\.json$/.test(saved.filename), saved.filename);
  assert(JSON.parse(saved.data).schema === "4d-branch", "中身が JSON でない");
});

await check("編集するとアカウントの写しも新しくなる", async () => {
  const before = JSON.parse(dbStore.get("data/users/u_test/fourd")).gen;
  await A.page.evaluate(async () => {
    const f = window.__fourD;
    f.app.cmd.createNode("goal", { x: -400, y: 900 }, { title: "端末Aで書いた目標", exact: true });
    await f.app.cloud.flush();
  });
  const after = JSON.parse(dbStore.get("data/users/u_test/fourd"));
  assert(after.gen !== before, "写しが新しくならない");
  assert((await cloudState(A.page)) === "synced", await cloudState(A.page));
});

await check("新しい端末で開くと、デモではなくアカウントの内容が出る", async () => {
  const B = await newDevice();
  await B.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "端末Aで書いた目標"), null, { timeout: 15000 });
  await B.page.locator(".toast", { hasText: "アカウントに保存されていた内容を読み込みました" }).waitFor();
  // 最初の読み込みは「元に戻す」の対象にしない（戻すと、捨てたデモがアカウントへ送られてしまう）
  assert((await B.page.evaluate(() => window.__fourD.store.history.canUndo)) === false, "最初の読み込みを元に戻せてしまう");
  // 端末 B で書く → 端末 A に届く（A は未変更なので取り込む）
  await B.page.evaluate(async () => {
    const f = window.__fourD;
    if (document.querySelector(".welcome-modal")) document.querySelector(".modal-close").click();
    f.app.cmd.createNode("action", { x: -400, y: 1100 }, { title: "端末Bで足した行動", exact: true });
    await f.app.cloud.flush();
  });
  await A.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "端末Bで足した行動"), null, { timeout: 15000 });
  // 取り込む前の手元はバックアップに残る
  const kinds = await A.page.evaluate(async () => (await window.__fourD.persistence.listBackups()).map((b) => b.kind + ":" + b.label));
  assert(kinds.some((k) => k.startsWith("sync:別の端末の内容を読み込む前")), kinds.join(","));
  await B.ctx.close();
});

await check("サインインせずに書いたブラウザで、あとからサインインすると、どちらの内容を使うか聞く", async () => {
  // サインインしていない間に書く（このブラウザだけに保存）
  const E = await newDevice({ signedOut: true });
  await E.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "unavailable", null, { timeout: 15000 });
  await E.page.evaluate(() => document.querySelector(".modal-close")?.click());
  await E.page.evaluate(() => window.__fourD.app.cmd.createNode("goal", { x: 0, y: 1500 }, { title: "サインイン前に書いた目標", exact: true }));
  await E.page.waitForFunction(() => window.__fourD.persistence.status === "saved");
  // サインインして開き直す
  await E.ctx.addInitScript(() => {
    if (window.__fakeFlags) window.__fakeFlags.signedOut = false;
  });
  await E.page.reload({ waitUntil: "load" });
  await E.page.waitForFunction(() => !!window.__fourD);
  const dialog = E.page.getByRole("dialog", { name: "どちらの内容を使いますか？" });
  await dialog.waitFor({ timeout: 15000 });
  // 決めるまでは送らない
  const waiting = await E.page.evaluate(() => window.__fourD.app.cloudInfo);
  assert(waiting.state === "pending" && waiting.message.includes("選んで"), `決める前の状態 ${JSON.stringify(waiting)}`);
  if (SHOTS) {
    await E.page.waitForTimeout(300);
    await E.page.screenshot({ path: path.join(SHOTS, "artifact-choose.png") });
    await E.page.setViewportSize({ width: 400, height: 800 });
    await E.page.waitForTimeout(300);
    await E.page.screenshot({ path: path.join(SHOTS, "artifact-choose-phone.png") });
    await E.page.setViewportSize({ width: 1440, height: 900 });
  }
  await dialog.getByRole("button", { name: "アカウントの内容を使う" }).click();
  await E.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "端末Aで書いた目標"), null, { timeout: 15000 });
  // 手元へ保存してから「同期済み」になる
  await E.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  const r = await E.page.evaluate(async () => {
    const f = window.__fourD;
    const backups = await f.persistence.listBackups();
    const b = backups.find((x) => x.label === "アカウントの内容に切り替える前のこのブラウザの内容");
    const d = b ? await f.persistence.readBackup(b.id) : null;
    return {
      kept: !!d && Object.values(d.nodes).some((n) => n.title === "サインイン前に書いた目標"),
      canUndo: f.store.history.canUndo,
      state: f.app.cloudInfo?.state,
    };
  });
  assert(r.kept, "このブラウザの内容がバックアップに無い");
  assert(r.canUndo === false, "切り替えを元に戻せてしまう");
  assert(r.state === "synced", `状態 ${r.state}`);
  await E.ctx.close();
});

await check("機能の返事が遅くても「サインインしていない」とは言わず、返事が来たら同期を始める", async () => {
  const L = await newDevice({ slowUseMs: 1500 });
  await L.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "unavailable", null, { timeout: 15000 });
  const msg = await L.page.evaluate(() => window.__fourD.app.cloudInfo.message);
  assert(!msg.includes("サインインしていない"), `時間切れなのにサインインしていないと言う: ${msg}`);
  await L.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 20000 });
  await L.ctx.close();
});

await check("バックアップを作れないブラウザでも、書き出してからアカウントの内容に切り替えられる", async () => {
  const N = await newDevice({ signedOut: true, noIdb: true });
  await N.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "unavailable", null, { timeout: 15000 });
  assert((await N.page.evaluate(() => window.__fourD.persistence.canBackup)) === false, "バックアップが作れてしまう（前提が違う）");
  await N.page.evaluate(() => document.querySelector(".modal-close")?.click());
  await N.page.evaluate(() => window.__fourD.app.cmd.createNode("goal", { x: 0, y: 1600 }, { title: "IndexedDB の無いブラウザで書いた目標", exact: true }));
  await N.page.waitForFunction(() => window.__fourD.persistence.status === "saved");
  await N.ctx.addInitScript(() => {
    if (window.__fakeFlags) window.__fakeFlags.signedOut = false;
  });
  await N.page.reload({ waitUntil: "load" });
  await N.page.waitForFunction(() => !!window.__fourD);
  const dialog = N.page.getByRole("dialog", { name: "どちらの内容を使いますか？" });
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole("button", { name: "アカウントの内容を使う" }).click();
  const confirm = N.page.getByRole("dialog", { name: "このブラウザではバックアップを作れません" });
  await confirm.waitFor({ timeout: 10000 });
  await confirm.getByRole("button", { name: "書き出して続ける" }).click();
  await N.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  const r = await N.page.evaluate(() => ({
    switched: Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "端末Aで書いた目標"),
    exported: window.__saved.some((x) => x.data.includes("IndexedDB の無いブラウザで書いた目標")),
  }));
  assert(r.switched, "アカウントの内容に切り替わらない");
  assert(r.exported, "置き換える前の内容が書き出されていない");
  await N.ctx.close();
});

await check("書き出しの機能が無いときは、コピーできる画面を出す", async () => {
  const C = await newDevice({ noDownloads: true });
  await C.page.evaluate(() => document.querySelector(".modal-close")?.click());
  await C.page.evaluate(() => window.__fourD.app.exportJson());
  await C.page.getByRole("dialog", { name: "JSON を書き出す" }).waitFor();
  const v = await C.page.locator(".copy-area").inputValue();
  assert(JSON.parse(v).schema === "4d-branch", "コピー用の内容が JSON でない");
  await C.ctx.close();
});

await check("サインインしていないときは、このブラウザだけに保存して動く", async () => {
  const D = await newDevice({ signedOut: true });
  await D.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "unavailable", null, { timeout: 15000 });
  await D.page.evaluate(() => document.querySelector(".modal-close")?.click());
  await D.page.evaluate(() => window.__fourD.app.cmd.createNode("goal", { x: 0, y: 1400 }, { title: "ローカルだけ", exact: true }));
  await D.page.waitForFunction(() => window.__fourD.persistence.status === "saved");
  const footer = await D.page.locator(".side-footer").innerText();
  assert(footer.includes("サインインしていないため"), footer);
  await D.ctx.close();
});

await check("スマホの幅（400px）: 横にはみ出さず、上部バーが収まる", async () => {
  const P = await newDevice({}, { width: 400, height: 800 });
  await P.page.evaluate(() => document.querySelector(".modal-close")?.click());
  await P.page.waitForTimeout(400);
  const m = await P.page.evaluate(() => {
    const vw = window.innerWidth;
    const over = [...document.querySelectorAll(".topbar *, .bottombar *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && el.offsetParent !== null && (r.right > vw + 0.5 || r.left < -0.5) && !el.closest(".scenario-side");
    }).map((el) => el.className || el.tagName);
    return { vw, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth, over, addVisible: getComputedStyle(document.querySelector(".mobile-only")).display !== "none", left: getComputedStyle(document.querySelector(".sidebar-left")).visibility };
  });
  SHOTS && (await P.page.screenshot({ path: path.join(SHOTS, "artifact-phone.png") }));
  assert(m.scroll <= m.vw && m.body <= m.vw, JSON.stringify(m));
  assert(m.over.length === 0, `はみ出し: ${m.over.slice(0, 5).join(" / ")}`);
  assert(m.addVisible, "狭い画面の追加ボタンが出ない");
  assert(m.left === "hidden", "狭い画面で左のパネルが開いたまま");
  // 左のパネルを開くと重ねて出て、外側を押すと閉じる
  await P.page.locator(".topbar .icon-btn").first().click();
  await P.page.waitForTimeout(250);
  SHOTS && (await P.page.screenshot({ path: path.join(SHOTS, "artifact-phone-left.png") }));
  await P.page.mouse.click(380, 400);
  await P.page.waitForTimeout(250);
  const closed = await P.page.evaluate(() => window.__fourD.ui.prefs.leftOpen === false);
  assert(closed, "外側を押しても閉じない");
  await P.ctx.close();
});

await check("ページのエラーが無い", async () => {
  assert(errors.length === 0, errors.join("\n"));
});

await A.ctx.close();
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 件 合格`);
process.exit(failed ? 1 : 0);
