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
  // つながらない間（window.__dbDownUntil まで）: 読み書きは失敗し（コードの無いエラー = つながらない）、見張りは何も届けない
  const down = () => Date.now() < (window.__dbDownUntil || 0);
  // 返事が遅い db（flags.dbDelayMs: 読み書きのたびに待つ）
  const net = async () => {
    if (flags.dbDelayMs) await new Promise((r) => setTimeout(r, flags.dbDelayMs));
    if (down()) throw new Error("Failed to fetch");
  };
  const mkDoc = (path) => ({
    async get() {
      await net();
      const d = await window.__dbGet(path);
      return { exists: d !== null, data: () => (d === null ? undefined : d) };
    },
    async set(data) {
      await net();
      const r = await window.__dbSet(path, JSON.stringify(data));
      if (r) throw { code: r, message: r };
    },
    async delete() {
      await net();
      await window.__dbDel(path);
    },
    onSnapshot(next) {
      let last;
      let stop = false;
      const poll = async () => {
        if (stop) return;
        if (down()) {
          setTimeout(poll, 300);
          return;
        }
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
      await net();
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
            // 見る人が保存の確認を断った
            if (flags.declineDownloads) throw { code: "declined", message: "declined" };
            window.__saved.push({ filename, data: String(data) });
            return { status: "saved" };
          },
        });
      }
      if (name === "user") return Object.freeze({ id: async () => (flags.signedOut ? null : flags.uid || "u_test") });
      if (name === "db") {
        if (flags.signedOut) return null;
        const list = async (p) => {
          await net();
          return { docs: (await window.__dbList(p)).map((d) => ({ id: d.id, exists: true, data: () => d.data })) };
        };
        return Object.freeze({ doc: mkDoc, collection: (p) => ({ doc: (id) => mkDoc(`${p}/${id}`), get: () => list(p), limit: () => ({ get: () => list(p) }) }) });
      }
      return null;
    },
  };
};

const results = [];
/** 開発用: E2E_ONLY に名前の一部を渡すと、その確かめだけ動かす（前の確かめの状態を使う物は単独では動かない） */
const ONLY = process.env.E2E_ONLY || "";
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
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
  // 何もしていないデモを開き直したときの「未来の道筋」の自動表示は、専用の確かめ（autoFuture）のときだけ
  if (!flags.autoFuture)
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

await check("書き出しを断ったら、バックアップを作れないブラウザの内容を置き換えずに止める", async () => {
  const N = await newDevice({ signedOut: true, noIdb: true, declineDownloads: true });
  await N.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "unavailable", null, { timeout: 15000 });
  await N.page.evaluate(() => document.querySelector(".modal-close")?.click());
  await N.page.evaluate(() => window.__fourD.app.cmd.createNode("goal", { x: 0, y: 1700 }, { title: "断ったときに残る目標", exact: true }));
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
  await N.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "paused", null, { timeout: 15000 });
  const r = await N.page.evaluate(() => ({
    kept: Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "断ったときに残る目標"),
    switched: Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "端末Aで書いた目標"),
    message: window.__fourD.app.cloudInfo.message,
  }));
  assert(r.kept && !r.switched, `置き換えてしまった: ${JSON.stringify(r)}`);
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

await check("やりたいことリスト（3,000 件）を読み込むと、アカウントの写しも分割して新しくなる", async () => {
  const before = JSON.parse(dbStore.get("data/users/u_test/fourd")).gen;
  await A.page.evaluate(() => window.__fourD.app.loadWishlist());
  const dlg = A.page.getByRole("dialog", { name: "やりたいことリストを読み込む" });
  await dlg.waitFor();
  await dlg.locator(".radio-card", { hasText: "置き換える" }).click();
  await dlg.getByRole("button", { name: "読み込む" }).click();
  await A.page.waitForFunction(() => Object.keys(window.__fourD.store.doc.nodes).length > 3000);
  await A.page.evaluate(() => window.__fourD.app.cloud.flush());
  const m = JSON.parse(dbStore.get("data/users/u_test/fourd"));
  assert(m.gen !== before && m.nodes > 3000, `写し: ${m.nodes} ノード`);
  for (let i = 0; i < m.parts; i++) assert(dbStore.has(`data/users/u_test/fourd/parts/${m.gen}-${i}`), `分割 ${i} が無い`);
  assert((await cloudState(A.page)) === "synced", await cloudState(A.page));
});

await check("未来の道筋を追加で読み込むと、見込み（線の %・予測の入口）ごとアカウントの写しも新しくなる", async () => {
  const before = JSON.parse(dbStore.get("data/users/u_test/fourd"));
  await A.page.evaluate(() => window.__fourD.app.loadFuture());
  const dlg = A.page.getByRole("dialog", { name: "未来の道筋を読み込む" });
  await dlg.waitFor();
  await dlg.getByRole("button", { name: "読み込む" }).click();
  await A.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true));
  const local = await A.page.evaluate(() => {
    const f = window.__fourD;
    const fc = f.app.vm.forecast;
    return { nodes: Object.keys(f.store.doc.nodes).length, probs: Object.values(f.store.doc.edges).filter((e) => typeof e.meta?.prob === "number").length, ends: fc.ends.length, sum: fc.ends.reduce((n, id) => n + fc.reach.get(id).p, 0) };
  });
  assert(local.probs >= 3 && local.ends >= 3 && Math.abs(local.sum - 1) < 1e-6, JSON.stringify(local));
  await A.page.evaluate(() => window.__fourD.app.cloud.flush());
  const m = JSON.parse(dbStore.get("data/users/u_test/fourd"));
  assert(m.gen !== before.gen && m.nodes === local.nodes && m.nodes > before.nodes, `写し: ${m.nodes} / ${local.nodes}`);
  assert((await cloudState(A.page)) === "synced", await cloudState(A.page));
});

await check("デモのまま同期していた端末で開き直すと、同期を待ってから未来の道筋が自動で開き、アカウントの写しも新しくなる（別の端末でも 1 つだけ出る）", async () => {
  const U = "data/users/u_demo/fourd";
  const D = await newDevice({ uid: "u_demo", autoFuture: true });
  await D.page.getByRole("dialog", { name: "4D Branch へようこそ" }).waitFor();
  await D.page.getByRole("button", { name: "すぐに使う" }).click();
  await D.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  const has = (p) => p.evaluate(() => Object.values(window.__fourD.store.doc.nodes).filter((n) => n.meta?.forecastRoot === true).length);
  const m0 = JSON.parse(dbStore.get(U));
  assert(m0.nodes < 40, `デモの写し ${m0.nodes}`);
  // 初めて開いたとき（ようこそ）は入れ替えない
  assert((await has(D.page)) === 0, "初めて開いたときに入れ替えた");
  await D.page.waitForTimeout(500);
  await D.page.reload({ waitUntil: "load" });
  await D.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true), null, { timeout: 20000 });
  await D.page.locator(".toast", { hasText: "未来の道筋（仕事・10 年）を開きました" }).waitFor();
  await D.page.evaluate(() => window.__fourD.app.cloud.flush());
  await D.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  const m1 = JSON.parse(dbStore.get(U));
  const local = await D.page.evaluate(() => Object.keys(window.__fourD.store.doc.nodes).length);
  assert(m1.gen !== m0.gen && m1.nodes === local && m1.nodes > 1500, `写し: ${m1.nodes} / ${local}`);
  // 同じアカウントの別の端末（初めて）で開くと、アカウントの未来の道筋が出る（2 つにならない）
  const D2 = await newDevice({ uid: "u_demo", autoFuture: true });
  await D2.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true), null, { timeout: 20000 });
  await D2.page.waitForTimeout(2500);
  assert((await has(D2.page)) === 1, `入口が ${await has(D2.page)} つ`);
  await D2.ctx.close();
  await D.ctx.close();
});

/** デモのまま同期した端末 X（ようこそを済ませた）と、同じアカウントの端末 Y。write: Y で書き足して送る（アカウントは Y の内容が新しい） */
async function xyDemo(uid, { autoFuture = false, write = true, xFlags = {}, yFlags = {} } = {}) {
  const X = await newDevice({ uid, autoFuture, ...xFlags });
  await X.page.getByRole("dialog", { name: "4D Branch へようこそ" }).waitFor();
  await X.page.getByRole("button", { name: "すぐに使う" }).click();
  await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  await X.page.waitForFunction(() => JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}").onboardingDone === true);
  // Y が書く間、X は閉じていたことにする（開いたままだと見張りで Y の内容を取り込み始め、確かめの開き直しがその途中に当たる）
  if (write) await X.page.evaluate(() => window.__fourD.app.cloud?.stop());
  const Y = await newDevice({ uid, ...yFlags });
  await Y.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  const welcome = Y.page.getByRole("dialog", { name: "4D Branch へようこそ" });
  if (await welcome.isVisible()) await Y.page.getByRole("button", { name: "すぐに使う" }).click();
  if (write) {
    await Y.page.evaluate(() => window.__fourD.app.cmd.createNode("goal", { x: -900, y: 900 }, { title: "別の端末で書いた目標", exact: true }));
    await Y.page.evaluate(() => window.__fourD.app.cloud.flush());
    await Y.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  }
  const m = JSON.parse(dbStore.get(`data/users/${uid}/fourd`));
  if (write) assert(m.nodes > 23 && m.nodes < 40, `Y の写し ${m.nodes}`);
  return { X, Y, m };
}
const ownOf = (p) => p.evaluate(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "別の端末で書いた目標"));
const rootsOf = (p) => p.evaluate(() => Object.values(window.__fourD.store.doc.nodes).filter((n) => n.meta?.forecastRoot === true).length);
const manifestOf = (uid) => JSON.parse(dbStore.get(`data/users/${uid}/fourd`));
/** このブラウザで一度でも未来の道筋を開いたか（後で別の端末の内容に譲って消えていても分かる: 「開いた」の設定と開く前の安全用バックアップ） */
const everOpened = (p) =>
  p.evaluate(async () => window.__fourD.ui.prefs.futureAutoOpened === true || (await window.__fourD.persistence.listBackups()).some((b) => b.label === "「未来の道筋を開く」の前"));
/** デモのノードの題名を、その場の入力で書き換え始める（確定しない） */
const startTitleEdit = (p) =>
  p.evaluate(() => {
    const f = window.__fourD;
    const n = Object.values(f.store.doc.nodes).find((x) => x.type === "goal") ?? Object.values(f.store.doc.nodes)[0];
    f.app.editor.start(n.id);
    return n.id;
  });

await check("つながらない間・同期の途中は、デモを未来の道筋に入れ替えない（別の端末で書いた新しい内容を取り込み、押した「未来の道筋」は済んでから聞く）", async () => {
  // デモのまま同期した端末 X と、同じアカウントで書き足した端末 Y（アカウントは Y の内容が新しい）
  const setup = (uid, autoFuture) => xyDemo(uid, { autoFuture });

  // 1) 自動で開く: X を開き直したとき、アカウントに 3 秒つながらない（「つながらない」はあとで同期する。落ち着いたとは見ない）
  {
    const { X, Y, m } = await setup("u_race1", true);
    await X.ctx.addInitScript(() => (window.__dbDownUntil = Date.now() + 3000));
    await X.page.reload({ waitUntil: "load" });
    await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "offline", null, { timeout: 10000 });
    await X.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "別の端末で書いた目標"), null, { timeout: 20000 });
    await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
    await X.page.waitForTimeout(1500);
    assert((await rootsOf(X.page)) === 0, "つながらない間に未来の道筋へ入れ替えた");
    assert(!(await everOpened(X.page)), "つながらない間に一度未来の道筋を開いた（後で別の端末の内容に譲っただけ）");
    const m1 = JSON.parse(dbStore.get("data/users/u_race1/fourd"));
    assert(m1.nodes === m.nodes, `アカウントの写しが変わった ${m1.nodes} / ${m.nodes}`);
    assert((await ownOf(Y.page)) && (await rootsOf(Y.page)) === 0, "別の端末の内容が消えた");
    const warn = await X.page.locator(".toast", { hasText: "重なった" }).count();
    assert(warn === 0, "重なりのお知らせが出た");
    await X.ctx.close();
    await Y.ctx.close();
  }

  // 2) 押す: 同期の途中に右下の「未来の道筋」を押しても、すぐには入れ替えない（取り込んだ後、追加か入れ替えかを聞く）
  {
    const { X, Y, m } = await setup("u_race2", false);
    await X.ctx.addInitScript(() => (window.__dbDownUntil = Date.now() + 5000));
    await X.page.reload({ waitUntil: "load" });
    // まだ突き合わせていない（つながらない）うちに押す（重い環境で開くのが遅れても、押す前に済んでしまわないように）
    await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "offline", null, { timeout: 10000 });
    await X.page.locator(".zoom-ctl .future-btn").click();
    await X.page.locator(".toast", { hasText: "アカウントの内容を確かめています" }).waitFor({ timeout: 5000 });
    assert((await rootsOf(X.page)) === 0, "同期の途中に入れ替えた");
    await X.page.getByRole("dialog", { name: "未来の道筋を読み込む" }).waitFor({ timeout: 25000 });
    assert(await ownOf(X.page), "別の端末の内容を取り込む前に聞いた");
    const m1 = JSON.parse(dbStore.get("data/users/u_race2/fourd"));
    assert(m1.nodes === m.nodes && (await rootsOf(X.page)) === 0, `アカウントの写しが変わった ${m1.nodes} / ${m.nodes}`);
    await X.page.keyboard.press("Escape");
    await X.ctx.close();
    await Y.ctx.close();
  }
});

await check("題名をその場で書き換えている間に別の端末の変更が届き、書き換えずに ⌘S で閉じても、読まずに「同期済み」にして未来の道筋で上書きしない", async () => {
  const { X, Y, m } = await xyDemo("u_flush", { autoFuture: true, xFlags: { dbDelayMs: 250 } });
  // X を開き直してすぐ、題名をその場で書き換え始める（最初の突き合わせは、入力が終わるまで取り込みを待つ）
  await X.page.reload({ waitUntil: "load" });
  await X.page.waitForFunction(() => !!window.__fourD?.app);
  await startTitleEdit(X.page);
  // 入力の終わりを待つ状態に落ち着いてから（見張りの最初の知らせで読み直す間の、一瞬の「待つ」には当てない）
  const waiting = () => window.__fourD.app.cloudInfo?.state === "pending" && window.__fourD.app.cloudInfo.message.includes("入力が終わってから");
  await X.page.waitForFunction(waiting, null, { timeout: 15000 });
  await X.page.waitForTimeout(1500);
  await X.page.waitForFunction(waiting, null, { timeout: 15000 });
  assert(!(await ownOf(X.page)), "入力の途中に取り込んだ（確かめの前提）");
  // 書き換えずに ⌘S（入力を閉じて、すぐ同期する）: 読まずに「同期済み」と言わない
  await X.page.keyboard.press("Control+s");
  const st = await X.page.evaluate(() => ({ s: window.__fourD.app.cloudInfo?.state, own: Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "別の端末で書いた目標") }));
  assert(st.s !== "synced" || st.own, `読まずに「同期済み」にした ${JSON.stringify(st)}`);
  await X.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "別の端末で書いた目標"), null, { timeout: 15000 });
  await X.page.waitForTimeout(2500);
  assert((await rootsOf(X.page)) === 0, "取り込む前に未来の道筋を開いた");
  assert(!(await everOpened(X.page)), "取り込む前に一度未来の道筋を開いた（後で別の端末の内容に譲っただけ）");
  assert(manifestOf("u_flush").nodes === m.nodes, `アカウントの写しが変わった ${manifestOf("u_flush").nodes} / ${m.nodes}`);
  assert((await ownOf(Y.page)) && (await rootsOf(Y.page)) === 0, "別の端末の内容が消えた");
  assert((await X.page.locator(".toast", { hasText: "重なった" }).count()) === 0, "重なりのお知らせが出た");
  await X.ctx.close();
  await Y.ctx.close();
});

await check("自動で開いた未来の道筋は、送る前に別の端末で書かれた内容と重なったら、その内容に譲る（アカウントにも別の端末にも残る）", async () => {
  const { X, Y } = await xyDemo("u_yield", { autoFuture: true, write: false });
  // Y で書き始め（5 秒まとめてから送る）、すぐに X を開き直す（X は古い写しと突き合わせて、未来の道筋を開く）
  await Y.page.evaluate(() => window.__fourD.app.cmd.createNode("goal", { x: -900, y: 900 }, { title: "別の端末で書いた目標", exact: true }));
  await X.page.reload({ waitUntil: "load" });
  await X.page.locator(".toast", { hasText: "未来の道筋（仕事・10 年）を開きました" }).waitFor({ timeout: 15000 });
  // Y の送信が先に届き、X は自分の未来の道筋を送らずに、Y の内容を読み込む
  await X.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "別の端末で書いた目標"), null, { timeout: 25000 });
  await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  await X.page.waitForTimeout(2000);
  const m = manifestOf("u_yield");
  assert(m.nodes > 23 && m.nodes < 40, `アカウントの写しが未来の道筋になった ${m.nodes}`);
  assert((await rootsOf(X.page)) === 0, "X に未来の道筋が残った");
  assert((await ownOf(Y.page)) && (await rootsOf(Y.page)) === 0, "別の端末の内容が消えた");
  assert((await X.page.locator(".toast", { hasText: "重なった" }).count()) === 0, "重なりのお知らせが出た");
  const kept = await X.page.evaluate(async () => (await window.__fourD.persistence.listBackups()).some((b) => b.label.includes("別の端末の内容を読み込む前")));
  assert(kept, "開いた未来の道筋がバックアップに残っていない");
  // 譲った読み込みは「元に戻す」の対象にしない（戻すと、開いた地図で別の端末の内容を押し流す）
  assert(!(await X.page.evaluate(() => window.__fourD.store.history.canUndo)), "譲った読み込みを元に戻せる");
  await X.page.keyboard.press("Control+z");
  await X.page.waitForTimeout(6500);
  const m2 = manifestOf("u_yield");
  assert(m2.gen === m.gen && (await ownOf(Y.page)) && (await rootsOf(Y.page)) === 0, `元に戻す（⌘Z）で別の端末の内容を押し流した ${m2.nodes}`);
  await X.ctx.close();
  await Y.ctx.close();
});

await check("自動で開いた未来の道筋をすぐ元に戻しても、送る前に別の端末で書かれた内容を、戻しただけの地図で押し流さない", async () => {
  const { X, Y } = await xyDemo("u_undoyield", { autoFuture: true, write: false });
  await Y.page.evaluate(() => window.__fourD.app.cmd.createNode("goal", { x: -900, y: 900 }, { title: "別の端末で書いた目標", exact: true }));
  await X.page.reload({ waitUntil: "load" });
  const done = X.page.locator(".toast", { hasText: "未来の道筋（仕事・10 年）を開きました" });
  await done.waitFor({ timeout: 15000 });
  // 開いたお知らせの「元に戻す」で、開く前のデモに戻す（まだ送っていない）
  await done.getByRole("button", { name: "元に戻す" }).click();
  await X.page.waitForFunction(() => !Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true));
  // Y の送信が届くと、X は戻しただけのデモを送らずに、Y の内容を読み込む
  await X.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.title === "別の端末で書いた目標"), null, { timeout: 25000 });
  await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  await X.page.waitForTimeout(2000);
  const m = manifestOf("u_undoyield");
  assert(m.nodes > 23 && m.nodes < 40, `アカウントの写しが変わった ${m.nodes}`);
  assert((await ownOf(Y.page)) && (await rootsOf(Y.page)) === 0, "別の端末の内容が消えた");
  assert((await X.page.locator(".toast", { hasText: "重なった" }).count()) === 0, "重なりのお知らせが出た");
  await X.ctx.close();
  await Y.ctx.close();
});

await check("別の端末から同期で受け取った未来の道筋を元に戻すと、どの端末でも（その間閉じていた端末でも）もう自動では入れ替えない", async () => {
  const uid = "u_mark";
  // B も「開いた」をまだ使っていない端末（開き直すと自動で開く）
  const { X: A, Y: B } = await xyDemo(uid, { autoFuture: true, write: false, yFlags: { autoFuture: true } });
  // C: デモのまま同期して、ようこそを済ませてから閉じていた端末（未来の道筋はまだ見ていない）
  const C = await newDevice({ uid, autoFuture: true });
  await C.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  const cw = C.page.getByRole("dialog", { name: "4D Branch へようこそ" });
  if (await cw.isVisible()) await C.page.getByRole("button", { name: "すぐに使う" }).click();
  await C.page.waitForFunction(() => JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}").onboardingDone === true);
  await C.page.waitForTimeout(500);
  await C.page.goto("about:blank");
  // B を開き直すと未来の道筋が自動で開き、送られる。開いたままの A は同期で受け取る
  const bw = B.page.getByRole("dialog", { name: "4D Branch へようこそ" });
  if (await bw.isVisible()) await B.page.getByRole("button", { name: "すぐに使う" }).click();
  await B.page.waitForFunction(() => JSON.parse(localStorage.getItem("4d-branch:prefs") || "{}").onboardingDone === true);
  await B.page.waitForTimeout(500);
  await B.page.reload({ waitUntil: "load" });
  await B.page.locator(".toast", { hasText: "未来の道筋（仕事・10 年）を開きました" }).waitFor({ timeout: 15000 });
  await B.page.evaluate(() => window.__fourD.app.cloud.flush());
  await A.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true), null, { timeout: 20000 });
  // A で元に戻す（受け取る前のデモに戻る）。戻したデモには入れ替えない印が付き、アカウントにも届く
  await A.page.evaluate(() => window.__fourD.app.cmd.undo());
  await A.page.waitForFunction(() => !Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true));
  assert((await A.page.evaluate(() => window.__fourD.store.doc.meta.noAutoFuture)) === true, "戻したデモに印が付かない");
  // 受け取る前のバックアップにも印（バックアップから戻しても、もう入れ替えない）
  const backupMark = await A.page.evaluate(async () => {
    const per = window.__fourD.persistence;
    const b = (await per.listBackups()).find((x) => x.label === "別の端末の内容を読み込む前");
    return b ? ((await per.readBackup(b.id))?.meta?.noAutoFuture ?? null) : "バックアップが無い";
  });
  assert(backupMark === true, `別の端末の内容を読み込む前のバックアップに印が付かない ${backupMark}`);
  await A.page.evaluate(() => window.__fourD.app.cloud.flush());
  await A.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  assert(manifestOf(uid).nodes < 40, `戻したデモが送られていない ${manifestOf(uid).nodes}`);
  // A を開き直しても、閉じていた C を開いても、もう入れ替えない
  await A.page.reload({ waitUntil: "load" });
  await C.page.goto(BASE, { waitUntil: "load" });
  await C.page.waitForFunction(() => !!window.__fourD);
  await C.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 15000 });
  await C.page.waitForTimeout(4000);
  assert((await rootsOf(A.page)) === 0, "A がまた入れ替えた");
  assert((await rootsOf(C.page)) === 0, "閉じていた C が、戻したデモをまた入れ替えた");
  assert(manifestOf(uid).nodes < 40, `アカウントがまた未来の道筋になった ${manifestOf(uid).nodes}`);
  for (const d of [A, B, C]) await d.ctx.close();
});

await check("押した「未来の道筋」が突き合わせを待つ間に、題名を書きかけていたら入れ替えない（書きかけを消さない）。メニューから開いた確認を閉じたら・自分でデモを読み込んだら、勝手に入れ替えない（自動で開くのも）", async () => {
  // 1) 書きかけ: アカウントは変わっていないが、開き直したとき 4 秒つながらない（つながらない間は待つ）
  {
    const { X, Y } = await xyDemo("u_wait1", { write: false });
    await Y.ctx.close();
    await X.ctx.addInitScript(() => (window.__dbDownUntil = Date.now() + 4000));
    await X.page.reload({ waitUntil: "load" });
    await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "offline", null, { timeout: 10000 });
    await X.page.locator(".zoom-ctl .future-btn").click();
    await X.page.locator(".toast", { hasText: "アカウントの内容を確かめています" }).waitFor({ timeout: 5000 });
    await startTitleEdit(X.page);
    await X.page.keyboard.type("書きかけのメモ");
    await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 25000 });
    await X.page.waitForTimeout(2000);
    const mid = await X.page.evaluate(() => ({ editing: window.__fourD.app.editor.active, text: document.querySelector(".inline-editor")?.value ?? null }));
    assert((await rootsOf(X.page)) === 0, "書きかけの間に入れ替えた");
    assert(mid.editing && mid.text?.includes("書きかけのメモ"), `書きかけが消えた ${JSON.stringify(mid)}`);
    // 書きかけをやめる（Esc）と、押した「未来の道筋」が開く
    await X.page.keyboard.press("Escape");
    await X.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true), null, { timeout: 10000 });
    await X.ctx.close();
  }
  // 2) 確認を閉じる: 待っている間に、メニューの「未来の道筋（仕事・10 年）を読み込む…」を開いてキャンセルした
  //    （自動で開く端末: 押した頼みも、この起動の自動で開くのも、どちらも入れ替えない）
  {
    const { X, Y } = await xyDemo("u_wait2", { autoFuture: true, write: false });
    await Y.ctx.close();
    await X.ctx.addInitScript(() => (window.__dbDownUntil = Date.now() + 4000));
    await X.page.reload({ waitUntil: "load" });
    await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "offline", null, { timeout: 10000 });
    await X.page.locator(".zoom-ctl .future-btn").click();
    await X.page.locator(".toast", { hasText: "アカウントの内容を確かめています" }).waitFor({ timeout: 5000 });
    await X.page.getByRole("button", { name: "メニュー", exact: true }).click();
    await X.page.getByRole("menuitem", { name: /未来の道筋（仕事・10 年）を読み込む/ }).click();
    const dlg = X.page.getByRole("dialog", { name: "未来の道筋を読み込む" });
    await dlg.waitFor();
    await dlg.getByRole("button", { name: "キャンセル" }).click();
    await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 25000 });
    await X.page.waitForTimeout(2500);
    assert((await rootsOf(X.page)) === 0, "キャンセルしたのに、待っていた頼み・自動で開くので入れ替えた");
    await X.ctx.close();
  }
  // 3) 自分で選んだ地図: 待っている間に「デモを読み込む（置き換え）」で読み込んだ
  {
    const { X, Y } = await xyDemo("u_wait3", { write: false });
    await Y.ctx.close();
    await X.ctx.addInitScript(() => (window.__dbDownUntil = Date.now() + 4000));
    await X.page.reload({ waitUntil: "load" });
    await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "offline", null, { timeout: 10000 });
    await X.page.locator(".zoom-ctl .future-btn").click();
    await X.page.locator(".toast", { hasText: "アカウントの内容を確かめています" }).waitFor({ timeout: 5000 });
    await X.page.getByRole("button", { name: "メニュー", exact: true }).click();
    await X.page.getByRole("menuitem", { name: "デモを読み込む（置き換え）" }).click();
    await X.page.getByRole("dialog", { name: "デモを読み込みますか？" }).getByRole("button", { name: "読み込む" }).click();
    await X.page.locator(".toast", { hasText: "デモを読み込みました" }).waitFor({ timeout: 5000 });
    await X.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "synced", null, { timeout: 25000 });
    await X.page.waitForTimeout(2500);
    assert((await rootsOf(X.page)) === 0, "選んで読み込んだデモを、待っていた頼みで入れ替えた");
    await X.ctx.close();
  }
});

await check("同期が止まっている・機能の返事が遅れて使えないと分かったときは、「未来の道筋」を押しても 30 秒待たせない", async () => {
  // 1) 新しい版のアプリが書いた写し（読めない）: 同期を止めている。押すと、すぐに読み込み方を選ぶ確認を出す
  {
    dbStore.set("data/users/u_paused/fourd", JSON.stringify({ format: 2, gen: "g_new", parts: 1, hash: "h" }));
    const P = await newDevice({ uid: "u_paused" });
    await P.page.getByRole("button", { name: "すぐに使う" }).click();
    await P.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "paused", null, { timeout: 15000 });
    const t0 = Date.now();
    await P.page.locator(".zoom-ctl .future-btn").click();
    await P.page.getByRole("dialog", { name: "未来の道筋を読み込む" }).waitFor({ timeout: 5000 });
    assert(Date.now() - t0 < 5000, `確認が出るまで ${Date.now() - t0}ms`);
    assert((await P.page.locator(".toast", { hasText: "同期が止まっている" }).count()) === 1, "止まっている訳を知らせない");
    await P.ctx.close();
  }
  // 2) 機能の返事が時間切れの後に返ってきて、使えなかった（サインインしていない）: もう待つ物は無いので、押せばすぐ開く
  {
    const L = await newDevice({ slowUseMs: 1500, signedOut: true });
    await L.page.getByRole("button", { name: "すぐに使う" }).click();
    await L.page.waitForFunction(() => window.__fourD.app.cloudInfo?.state === "unavailable" && window.__fourD.app.cloudInfo.message.includes("サインインしていない"), null, { timeout: 10000 });
    const t0 = Date.now();
    await L.page.locator(".zoom-ctl .future-btn").click();
    await L.page.waitForFunction(() => Object.values(window.__fourD.store.doc.nodes).some((n) => n.meta?.forecastRoot === true), null, { timeout: 8000 });
    assert(Date.now() - t0 < 8000, `開くまで ${Date.now() - t0}ms`);
    await L.ctx.close();
  }
  // 3) 押した後で同期が止まった（新しい版の写しを、遅い db で読む）: 30 秒待たせずに、止まった訳を知らせて確認を出す
  {
    dbStore.set("data/users/u_paused2/fourd", JSON.stringify({ format: 2, gen: "g_new2", parts: 1, hash: "h" }));
    const P = await newDevice({ uid: "u_paused2", dbDelayMs: 2500 });
    await P.page.getByRole("button", { name: "すぐに使う" }).click();
    assert((await cloudState(P.page)) !== "paused", "押す前に止まった（確かめの前提）");
    const t0 = Date.now();
    await P.page.locator(".zoom-ctl .future-btn").click();
    await P.page.locator(".toast", { hasText: "アカウントの内容を確かめています" }).waitFor({ timeout: 3000 });
    await P.page.getByRole("dialog", { name: "未来の道筋を読み込む" }).waitFor({ timeout: 12000 });
    assert(Date.now() - t0 < 12000, `確認が出るまで ${Date.now() - t0}ms`);
    assert((await P.page.locator(".toast", { hasText: "同期が止まっている" }).count()) === 1, "止まった訳を知らせない");
    await P.ctx.close();
  }
});

await check("ページのエラーが無い", async () => {
  assert(errors.length === 0, errors.join("\n"));
});

// 絞り込んで動かしたとき（E2E_ONLY）は、最初の確かめで作る端末が無い
await A?.ctx.close();
await browser.close();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 件 合格`);
process.exit(failed ? 1 : 0);
