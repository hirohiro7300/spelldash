// 創業者の 5 段（docs/SPEC_ACCOUNT_AREAS.md §6 の 5 段）を 1 回流す。
//   1. 旧い本番の木を配り、A でログインした旧いタブを 5 つ開く（lib/seed.mjs の OLD_TABS: live 学習中のまま裏へ・frozen 学習中に凍らせる・
//      offline 学習状況のページで通信を切る・visible 見えたままトークンの更新を始める・sw 印の無いホームを裏へ）
//   2. 配信を新しい木に替え、同じオリジンの別のタブで新しいコードを開く（移行があれば流れる）。visible の更新は、受け口が移行の後まで答えを止める
//   3. 新しいタブで B にログインする（本物の部品の流れ: メールのリンク → #access_token）。login = "logout" は A をログアウトしてから、"link" は A のまま B のリンクを開く
//   4. 旧いタブを戻す（凍結を解く・通信を戻す・見える状態にする・focus）。旧い画面で語に答え、裏へ回して戻し（送信の道）、
//      読み込み済みの旧いモジュールの同期とセッションの読みを呼び、トークンの更新が起きるまで待つ。最後に全部のタブを裏へ回し、旧いタブを閉じる（pagehide）
//      旧いタブが答えた後と、旧いタブを閉じた後に、新しいタブで新しいコードの文書を開き直す（/ と /switch.html・裏と表）。移行の後に旧いタブが旧い鍵へ書いた値を、
//      新しいコードは次の読み込みの片付け（見張りの頭・切り替えの画面）でだけ扱うので、その道を通す
//   5. 記録した要求を lib/analyze.mjs で調べる
//   6. A へ戻る（orphans のある木だけ。docs/SPEC_ACCOUNT_AREAS.md §0.3 の 1）: 旧いタブを閉じた後に、新しいタブを A に戻す（logout の回は B をログアウトしてから A の欄で、
//      link の回は B のまま A のリンクで、B にログインしない回は A をログアウトしてから A の欄で）。A の領域の語の記録・送る語の印・学習状況の画面・
//      A のクラウドの行を読む。もう一度 A から離れて（link は B へ、ほかはゲストへ）A へ戻り、同じ書き込みを 2 度取り込まないかを見る。
//      その間ずっと、見張りのタブ（lib/watch.html）が localStorage の領域の鍵の書き込みの知らせを聞き、B（とゲスト）の領域に旧いタブの語が入らないかを見る
// 回の形（order・login）:
//   order "normal"      2 段で新しいタブが / を開き（移行）、3 段で B にログインする
//   order "direct-link" 新しいコードの最初の読み込みが B のリンクそのもの（旧いタブしか開いていない端末で B のメールのリンクを開く）。login は link
//   login "logout"・"link"・"none"（B にログインしない。止めていた更新の書き戻しの後に旧いタブを戻し、A の記録が後ろへ戻らないかを見る）
//   release "migrated"（既定。止めていた更新を移行の後に通す）・"login"（B のセッションが動いて落ち着いた後に通す。切り替えの時の片付けの後に書き戻す形）
// 旧いタブで動くのは、配信を替える前に読み込んだ旧いコードだけ（検査はページのコードを書き換えない。見える状態の切り替えはブラウザの代わりに
// document.visibilityState を上書きして visibilitychange を投げる。凍結はブラウザの開発用の口、通信断は開発用の口と受け口の両方）。
// どのタブが旧いコードのままだったかは、文書ごとの印で確かめる（init script が新しい文書のたびに印を作り、検査に知らせる。同じ文書の中の移動では作らない）。
// 凍った・通信の切れた・見えたままのタブは、読み直しの届かないタブとして配信の後の読み直しを受け付けない（lib/server.mjs の oldtab-keep。止めた試みは記録に残す）。
// 旧いコードの文書の localStorage の書き込みは、書いたその時にタブの中で記録する（lib/storageTap.mjs。旧いコードの振る舞いは変えない）。分離の入った木では
// 旧いタブが旧い場所へ書いた語の記録がすぐ orphans へ移されるので、「旧い画面で答えた」はこの記録で見る。orphans のある木は、開き直しの終わりに orphans も読む。
import fs from "fs";
import { startServer } from "./server.mjs";
import { createFakeSupabase, SUPABASE_URL, OLD_AUTH_KEY } from "./fakeSupabase.mjs";
import { USERS, aLocalStorage, cloudSeed, OLD_TABS, TAB_PAGES } from "./seed.mjs";
import { fileURLToPath } from "url";
import { installStorageTap, disarmStorageTap, readOrphansInPage, WORD_KEY, OLD_PREFIX, TAP_BINDING, ORPHANS, WATCH_BINDING, AREA_WORD_NAME, AREA_DIRTY_NAME, installAreaWatch, readAreasInPage } from "./storageTap.mjs";

const WATCH_PAGE = fileURLToPath(new URL("./watch.html", import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runScenario({ browser, oldRoot, newRoot, vendorFile, oldVendorFile = null, sw, login, order = "normal", release = "migrated", expectWriteBack = false, tokenTtl = 100, waitRefreshMs = 40000, oldConfirm = "accept", newConfirm = "accept", freeze = true, loginWaitMs = 360000, returnToA = true, live = null, log = console.log }) {
  if (order === "direct-link") login = "link";
  const timeline = [];
  const note = (step, msg, extra) => {
    const e = { t: Date.now(), step, msg, ...(extra ? { extra } : {}) };
    timeline.push(e);
    log(`  [${step}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
  };
  // 認証の部品: 配信の前（旧いタブが読む）は oldVendorFile（--old-auth-lib。無ければ固定の版）、配信の後（新しい文書が読む）は固定の版
  // /__oldtab/watch.html は A へ戻る段の見張りのタブ（検査のページ。アプリのコードは無い。配信を替えても同じ物）
  const srv = await startServer({ oldRoot, newRoot, extraFiles: { "/__oldtab/supabase-js.mjs": { old: oldVendorFile ?? vendorFile, new: vendorFile }, "/__oldtab/watch.html": WATCH_PAGE }, log: (m) => note("server", m) });
  const seedAt = Date.now();
  const seed = cloudSeed(seedAt);
  const fake = createFakeSupabase({ users: [USERS.A, USERS.B], tokenTtl, seed });
  // run.mjs が処理されない失敗（unhandledRejection）で止まるときに、それまでの記録を書けるように
  if (live) Object.assign(live, { fake, srv });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: sw ? "allow" : "block" });
  const pageName = new WeakMap();
  const nameOf = (page) => (page ? pageName.get(page) ?? "page?" : "worker");
  const external = [];
  const pageRequests = []; // 旧いタブの同じオリジンへの要求（凍っていた間に要求が無かったかを見る）
  ctx.on("request", (req) => {
    const u = new URL(req.url());
    if (u.hostname !== "127.0.0.1" && u.origin !== SUPABASE_URL && !u.protocol.startsWith("data") && !u.protocol.startsWith("blob")) external.push({ t: Date.now(), url: req.url() });
    if (u.origin !== srv.origin) return;
    let tab = "worker";
    try {
      tab = nameOf(req.frame().page());
    } catch {}
    if (tab.startsWith("old")) pageRequests.push({ t: Date.now(), tab, path: u.pathname, nav: req.isNavigationRequest(), type: req.resourceType() });
  });
  await ctx.route(SUPABASE_URL + "/**", (route) => fake.handle(route));
  await ctx.routeWebSocket(/supabase\.co/, (ws) => {
    note("ws", `WebSocket ${ws.url()} を閉じた`);
    ws.close();
  });
  // 本番の既定の読み先（js/supabase.js の既定の配信元）を指す要求が来たら、同じ固定の版を返す（新しい木が既定の口を使う場合のため。旧い木は下の差し替え口で読む）
  await ctx.route("https://esm.sh/**", (route) => {
    const u = route.request().url();
    if (/\/@supabase\/supabase-js@/.test(u)) return route.fulfill({ status: 200, headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" }, body: fs.readFileSync(vendorFile, "utf8") });
    return route.abort();
  });
  // 新しい文書が始まるたびに知らせる（文書ごとの印。読み直し＝新しい文書。同じ文書の中の移動（# だけ）では init script は動かない）
  const docStarts = [];
  await ctx.exposeBinding("__oldtabDocStart", (source, info) => {
    docStarts.push({ t: Number(info?.t) || Date.now(), tab: nameOf(source.page), url: String(info?.url ?? ""), id: String(info?.id ?? "") });
  });
  // 本物の認証の部品を、両方の木にある差し替え口（js/supabase.js の window.__SUPABASE_MODULE_URL）で読ませる。製品のコードは変えない
  await ctx.addInitScript(() => {
    window.__SUPABASE_MODULE_URL = "/__oldtab/supabase-js.mjs";
    if (window.top !== window) return;
    const id = Math.random().toString(36).slice(2, 12);
    Object.defineProperty(window, "__oldtabDocId", { value: id, configurable: false, writable: false });
    try {
      window.__oldtabDocStart({ t: Date.now(), url: location.href, id });
    } catch {}
  });
  // 旧いコードのタブの localStorage の書き込みを、書いたその時にタブの中で記録する（lib/storageTap.mjs）。分離の入った木の見張りは、旧いコードのタブが
  // 旧い場所へ書いた人の記録を数ミリ秒で orphans へ移して消すので、答えた後の localStorage では「旧い画面で答えた」を確かめられない。
  // 包むのは配信の前に始まった文書だけ（配信の直前に disarmStorageTap を足し、その後の文書では外す）
  const storageWrites = [];
  await ctx.exposeBinding(TAP_BINDING, (source, rec) => {
    if (!rec || typeof rec !== "object") return;
    let tab = "page?";
    try {
      tab = nameOf(source.page);
    } catch {}
    storageWrites.push({ tab, at: Date.now(), op: String(rec.op ?? ""), key: rec.key ?? null, n: Number(rec.n) || 0, t: Number(rec.t) || Date.now(), docId: rec.docId ?? null, size: rec.size ?? null, prevSize: rec.prevSize ?? null, digest: rec.digest ?? null, ...(rec.changed ? { changed: rec.changed, removed: rec.removed ?? 0, entries: rec.entries ?? null, parseError: rec.parseError ?? null, changedDigest: rec.changedDigest ?? null } : {}) });
  });
  await ctx.addInitScript(installStorageTap, { wordKey: WORD_KEY, prefix: OLD_PREFIX, binding: TAP_BINDING });
  // A へ戻る段の見張り: 見張りのタブ（watch）が聞いた localStorage の領域の鍵の書き込みの知らせ（ほかのタブの書き込み。lib/storageTap.mjs installAreaWatch）
  const areaWrites = [];
  await ctx.exposeBinding(WATCH_BINDING, (source, rec) => {
    let tab = "page?";
    try {
      tab = nameOf(source.page);
    } catch {}
    if (tab !== "watch" || !rec || typeof rec !== "object") return;
    areaWrites.push({ ...rec, at: Date.now() });
  });

  const tabs = {};
  const dialogs = [];
  const errors = [];
  const loads = [];
  const navs = []; // 主の枠の移動（同じ文書の中の移動も含む）
  async function open(name, url) {
    const page = await ctx.newPage();
    tabs[name] = page;
    pageName.set(page, name);
    fake.label(page, name);
    page.on("dialog", async (d) => {
      const policy = name.startsWith("old") ? oldConfirm : newConfirm;
      dialogs.push({ t: Date.now(), tab: name, type: d.type(), message: d.message(), answer: d.type() === "confirm" ? policy : "accept" });
      note("dialog", `${name}: ${d.type()} 「${d.message().slice(0, 60)}」→ ${d.type() === "confirm" ? policy : "accept"}`);
      // 答える前にページが移った（/switch.html へ移るなど）と、窓はもう無い。落とさずに記録する
      try {
        if (d.type() === "confirm" && policy === "dismiss") await d.dismiss();
        else await d.accept();
      } catch (e) {
        dialogs[dialogs.length - 1].gone = String(e.message).split("\n")[0];
        note("dialog", `${name}: 答える前に窓が無くなった（${String(e.message).split("\n")[0]}）`);
      }
    });
    page.on("pageerror", (e) => errors.push({ t: Date.now(), tab: name, message: String(e.message).slice(0, 300) }));
    page.on("load", () => loads.push({ t: Date.now(), tab: name, url: page.url() }));
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navs.push({ t: Date.now(), tab: name, url: f.url() });
    });
    if (url) await page.goto(srv.origin + url, { waitUntil: "load", timeout: 30000 }).catch((e) => note("goto", `${name}: ${url} の読み込みを待てなかった（${String(e.message).split("\n")[0]}）`));
    return page;
  }
  const lastReqAt = () => (fake.requests.length ? fake.requests[fake.requests.length - 1].at : 0);
  async function settle(page, { quietMs = 2500, maxMs = 30000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const onSwitch = page && !page.isClosed() && /\/switch\.html/.test(page.url());
      if (!onSwitch && Date.now() - lastReqAt() >= quietMs && Date.now() - start >= quietMs) return true;
      await sleep(250);
    }
    return false;
  }
  const waitFor = async (fn, maxMs = 20000, step = 250) => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      try {
        if (await fn()) return true;
      } catch {}
      await sleep(step);
    }
    return false;
  };
  async function setVisible(page, visible) {
    await page.evaluate((v) => {
      const s = v ? "visible" : "hidden";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => !v });
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      window.dispatchEvent(new Event(v ? "focus" : "blur"));
    }, visible);
  }
  // 見える状態の切り替え。失敗（タブが移動の途中など）は 1 秒後に 1 回だけやり直し、それでも駄目なら記録する（旧いコードのタブで失敗したら 5 段を通ったと言わない）
  const visErrors = [];
  let phaseNow = "0";
  async function vis(name, visible) {
    const page = tabs[name];
    if (!page || page.isClosed()) {
      visErrors.push({ t: Date.now(), phase: phaseNow, tab: name, visible, error: "閉じている" });
      return false;
    }
    try {
      await setVisible(page, visible);
      return true;
    } catch (e1) {
      await sleep(1000);
      try {
        await setVisible(page, visible);
        return true;
      } catch (e) {
        visErrors.push({ t: Date.now(), phase: phaseNow, tab: name, visible, error: String(e.message).split("\n")[0], first: String(e1.message).split("\n")[0] });
        note("vis", `${name}: 見える状態を ${visible ? "visible" : "hidden"} にできなかった（${String(e.message).split("\n")[0]}）`);
        return false;
      }
    }
  }
  const wordStats = (page) => page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}") || {};
    } catch {
      return {};
    }
  });
  const storageView = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, (localStorage.getItem(k) || "").length]))).catch((e) => ({ error: String(e.message).split("\n")[0] }));
  // 旧い画面（0507672 の #input）で語に答える。訳が旧い木の daily の 1 語に決まればその綴りを打つ（思い出せた ○）。
  // 決まらなければ Enter で答えを見てから打つ。始まっていなければ Enter で始める（#word に英字が出るまで最大 3 回）。
  // 画面の読みと #input への focus は page.evaluate、打鍵は page.keyboard で行う（要素を探して待つブラウザ操作の口は使わない。新しい sw.js が読み直そうとして
  // 検査が 204 で止めたタブでは、page.focus などが 30 秒待って落ちた。evaluate とキーボードは同じタブで動く）
  const jaToEn = (() => {
    try {
      const d = JSON.parse(fs.readFileSync(`${oldRoot}/data/english/daily.json`, "utf8"));
      const m = new Map();
      for (const w of d.words ?? d) m.set(w.ja, m.has(w.ja) ? null : w.en);
      return m;
    } catch {
      return new Map();
    }
  })();
  // 綴り → 語の id（旧い木の教材の全部の分野）。答えた語と、答えた後に画面に出た次の語を、タブの中の書き込みの記録と突き合わせるため
  const enToIds = (() => {
    const m = new Map();
    try {
      for (const f of fs.readdirSync(`${oldRoot}/data/english`).filter((x) => x.endsWith(".json"))) {
        try {
          const d = JSON.parse(fs.readFileSync(`${oldRoot}/data/english/${f}`, "utf8"));
          for (const w of d.words ?? d) {
            if (!w?.en || !w?.id) continue;
            const k = String(w.en).toLowerCase();
            if (!m.has(k)) m.set(k, []);
            if (!m.get(k).includes(w.id)) m.get(k).push(w.id);
          }
        } catch {}
      }
    } catch {}
    return m;
  })();
  const idsOf = (en) => (en ? enToIds.get(String(en).toLowerCase()) ?? [] : []);
  const LETTERS = /^[A-Za-z][A-Za-z' .-]*$/;
  const ev = (page, fn, arg, ms = 8000) => Promise.race([page.evaluate(fn, arg), sleep(ms).then(() => { throw new Error(`evaluate が ${ms}ms で返らない`); })]);
  const domText = (page, id) => ev(page, (i) => (document.getElementById(i)?.textContent ?? "").trim(), id).catch(() => "");
  const focusInput = (page) => ev(page, () => {
    const el = document.getElementById("input");
    if (!el) return "無い";
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || (r.width === 0 && r.height === 0)) return "見えない";
    el.focus();
    return document.activeElement === el ? "ok" : "focus できない";
  }).catch((e) => "error " + String(e.message).split("\n")[0]);
  const pressKey = async (page, k) => {
    await focusInput(page);
    await page.keyboard.press(k);
  };
  async function answerOld(page, count = 1, tabName = null) {
    const before = await wordStats(page);
    const doc = await docIdOf(page);
    const done = [];
    const playing = () => ev(page, () => document.body.classList.contains("home--playing") && (document.getElementById("japanese")?.textContent ?? "").trim() !== "").catch(() => false);
    for (let i = 0; i < count; i++) {
      const t0 = Date.now();
      const ready = await focusInput(page);
      if (ready !== "ok") {
        done.push({ ok: false, reason: `#input が${ready === "無い" || ready === "見えない" ? ready : `使えない（${ready}）`}` });
        break;
      }
      if (!(await playing())) {
        await pressKey(page, "Enter");
        await waitFor(playing, 4000, 100);
        await sleep(500);
      }
      const ja = await domText(page, "japanese");
      const known = jaToEn.get(ja);
      let en = known ?? "";
      let how = "recall";
      if (!known) {
        how = "reveal";
        for (let k = 0; k < 3 && !LETTERS.test(await domText(page, "word")); k++) {
          await pressKey(page, "Enter");
          await waitFor(async () => LETTERS.test(await domText(page, "word")), 1500, 100);
        }
        en = await domText(page, "word");
      }
      const typed = LETTERS.test(en);
      let typingAt = null;
      if (typed) {
        await focusInput(page);
        typingAt = Date.now();
        for (const ch of en) await page.keyboard.press(ch === " " ? "Space" : ch);
      }
      await waitFor(async () => (await domText(page, "japanese")) !== ja, 3000, 100);
      await sleep(900);
      const jaAfter = await domText(page, "japanese");
      // 答えに数えるのは、打った後に画面が次の語へ進んだときだけ（訳が替わった。進まなければ旧い画面が答えを受けていない）
      const advanced = jaAfter !== "" && jaAfter !== ja;
      const ok = typed && advanced;
      // 答えの窓 [typingAt, t1]（打ち始めてから、次の語に替わって落ち着くまで。判定は次の答えの打ち始めで切る。タブの中の書き込みの記録と突き合わせる）。
      // ids は答えた語、nextIds は答えた後に画面に出た次の語の id の候補
      done.push({ ok, typed, advanced, ...(ok ? {} : { reason: typed ? "打った後に画面が次の語へ進まなかった" : "綴りが分からない" }), ja, en, how, t0, typingAt, t1: Date.now(), ids: idsOf(en), jaAfter, nextIds: idsOf(jaToEn.get(jaAfter) ?? "") });
    }
    const after = await wordStats(page);
    const changed = Object.keys(after).filter((id) => !before[id] || before[id].lastPlayed !== after[id].lastPlayed || before[id].playCount !== after[id].playCount);
    const stats = Object.fromEntries(changed.map((id) => [id, { playCount: after[id]?.playCount ?? null, correctCount: after[id]?.correctCount ?? null, recallFail: after[id]?.recallFail ?? null }]));
    // タブの中の書き込みの記録: この文書が答えの窓のあいだに語の記録へ書いた語（答えごとの突き合わせは lib/analyze.mjs。ここは語の集まりと回数だけ）
    await sleep(300);
    const start = done[0]?.t0 ?? Date.now();
    const end = (done[done.length - 1]?.t1 ?? Date.now()) + 300;
    const writes = storageWrites.filter((w) => w.tab === tabName && w.docId === doc && w.op === "set" && w.key === WORD_KEY && w.t >= start && w.t <= end);
    const writtenStats = {};
    for (const w of writes) for (const [id, v] of Object.entries(w.changed ?? {})) writtenStats[id] = { playCount: v.playCount ?? null, correctCount: v.correctCount ?? null, recallFail: v.recallFail ?? null };
    return { answers: done, changed, stats, doc, written: Object.keys(writtenStats), writtenStats, wordWrites: writes.length };
  }
  // Service Worker の様子（このタブを受け持つ物と、保存の名前。旧い sw.js は spelldash-v4、新しい木は版を上げている）
  const swState = (page) => page.evaluate(async () => ({
    controlled: !!navigator.serviceWorker?.controller,
    caches: typeof caches === "undefined" ? [] : await caches.keys().catch(() => [])
  })).catch((e) => ({ error: String(e.message).slice(0, 120) }));
  // このタブで動いている同期のモジュール（読み込み済みの物。import は同じ物を返し、取り直さない）の関数の字が、どちらの木の js/sync.js にあるか
  const syncSource = { old: fs.readFileSync(`${oldRoot}/js/sync.js`, "utf8"), new: fs.existsSync(`${newRoot}/js/sync.js`) ? fs.readFileSync(`${newRoot}/js/sync.js`, "utf8") : "" };
  async function codeOf(page) {
    const fns = await page.evaluate(async () => {
      const m = await import("/js/sync.js");
      return Object.entries(m).filter(([, v]) => typeof v === "function").map(([k, v]) => [k, String(v)]);
    }).catch((e) => ({ error: String(e.message).slice(0, 120) }));
    if (!Array.isArray(fns)) return fns;
    const inOld = fns.every(([, t]) => syncSource.old.includes(t));
    const notInNew = fns.filter(([, t]) => !syncSource.new.includes(t)).map(([k]) => k);
    return { functions: fns.length, allInOldTree: inOld, notInNewTree: notInNew };
  }
  const docIdOf = (page) => Promise.race([page.evaluate(() => window.__oldtabDocId ?? null), sleep(3000).then(() => "timeout")]).catch((e) => "error " + String(e.message).split("\n")[0]);
  let frozenNow = false;
  // 検査の時計を読む（凍らせたタブ以外のどれかの旧いタブから。localStorage は同じオリジンで共有）
  async function readTick() {
    for (const name of ["old-live", "old-visible", "old-sw", "old-offline", "new"]) {
      const page = tabs[name];
      if (!page || page.isClosed()) continue;
      const v = await Promise.race([page.evaluate(() => Storage.prototype.getItem.call(localStorage, "oldtab-harness-tick")), sleep(3000).then(() => undefined)]).catch(() => undefined);
      if (v === undefined) continue;
      const [doc, ts] = String(v ?? ":0").split(":");
      return { doc: doc || null, ts: Number(ts) || 0, via: name };
    }
    return { doc: null, ts: 0, via: null };
  }
  // タブを凍らせる。まず開発用の口の凍結（Page.setWebLifecycleState frozen）。画面の無いブラウザの見えるタブでは凍結が効かない（試した）ので、
  // 検査の時計（このタブだけの setInterval が localStorage の oldtab-harness-tick に「文書の印:時刻」を書く。アプリの鍵ではない）が止まったかで確かめる。
  // 止まらなければスクリプトを止める（Debugger.pause）に替える。どちらでも止まらなければ mode "none"（検査は「凍った」と言わない）。
  // 文書の印を時計に入れるのは、タブが読み直されて時計ごと消えたのを「止まった」と取り違えないため
  async function freezeTab(page, cdp) {
    const doc = await page.evaluate(() => {
      window.__oldtabTicker = setInterval(() => {
        try { localStorage.setItem("oldtab-harness-tick", window.__oldtabDocId + ":" + Date.now()); } catch {}
      }, 200);
      return window.__oldtabDocId;
    });
    const stopped = async () => {
      await sleep(1000);
      const from = Date.now();
      await sleep(1200);
      return (await readTick()).ts < from;
    };
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" }).catch(() => {});
    if (await stopped()) return { mode: "lifecycle", doc, at: Date.now() };
    await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
    await cdp.send("Debugger.enable").catch(() => {});
    await cdp.send("Debugger.pause").catch(() => {});
    if (await stopped()) return { mode: "debugger", doc, at: Date.now() };
    await cdp.send("Debugger.resume").catch(() => {});
    return { mode: "none", doc, at: Date.now() };
  }
  async function unfreezeTab(page, cdp, f) {
    if (f.mode === "lifecycle") await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
    if (f.mode === "debugger") await cdp.send("Debugger.resume").catch(() => {});
    await page.evaluate(() => {
      clearInterval(window.__oldtabTicker);
      try { localStorage.removeItem("oldtab-harness-tick"); } catch {}
    }).catch(() => {});
    return f.mode;
  }
  const loadedModules = (page) => page.evaluate(() => performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname).filter((p) => p.startsWith("/js/")));
  // ページの欄でログインのリンクを頼む。この呼び出しの後に、その人の欄からのメール（受け口の otp）が届いたときだけ true
  // （前に届いた同じ人のリンクでは true にしない。新しいコードは頼む前に予行（IndexedDB への写し）をするので、届くまで少しかかる）
  async function loginByForm(page, email, waitMs = 8000) {
    const t0 = Date.now();
    const ok = await page.evaluate(() => {
      const t = document.getElementById("loginToggle");
      const f = document.getElementById("emailInput");
      return !!t && !!f && !document.getElementById("accountGuest")?.hidden;
    }).catch(() => false);
    if (!ok) return false;
    try {
      await page.click("#loginToggle", { timeout: 5000 });
      await page.fill("#emailInput", email, { timeout: 5000 });
      await page.click("#loginButton", { timeout: 5000 });
    } catch (e) {
      note("login", `ログインの欄を使えなかった（${String(e.message).split("\n")[0]}）`);
      return false;
    }
    return waitFor(() => fake.mailbox.some((m) => m.email === email && m.at >= t0 && !m.outside), waitMs);
  }
  // 旧い認証の鍵の書き込みの知らせ（storage イベント）を、旧いタブ 2 つ（old-live・old-visible）で聞いて残す。書いたタブには知らせが来ないので 2 つで聞く。
  // 節目ごとの読み（oldKeyCheck）は、書き戻しの直後に新しいコードが片付けると見落とすので、書き戻しが起きたか・B のセッションが置かれたかはこの知らせで見る
  const watchOldKey = (page) => page.evaluate((k) => {
    if (window.__oldtabAuthKeyEvents) return;
    window.__oldtabAuthKeyEvents = [];
    window.addEventListener("storage", (e) => {
      if (e.key !== k) return;
      let email = null;
      if (e.newValue) {
        try {
          const j = JSON.parse(e.newValue);
          email = j?.user?.email ?? j?.currentSession?.user?.email ?? "?";
        } catch {
          email = "?";
        }
      }
      window.__oldtabAuthKeyEvents.push({ t: Date.now(), email });
    });
  }, OLD_AUTH_KEY).catch((e) => note("key", `旧い認証の鍵の知らせを聞けなかった（${String(e.message).split("\n")[0]}）`));
  const oldKeyEventsSeen = new Map(); // 同じ知らせを 2 度数えない（タブと時刻と値）
  const oldKeyEvents = [];
  async function collectOldKeyEvents() {
    for (const name of ["old-live", "old-visible"]) {
      const page = tabs[name];
      if (!page || page.isClosed()) continue;
      const list = await Promise.race([page.evaluate(() => window.__oldtabAuthKeyEvents ?? null), sleep(3000).then(() => null)]).catch(() => null);
      for (const ev0 of list ?? []) {
        const who = ev0.email === USERS.A.email ? "A" : ev0.email === USERS.B.email ? "B" : ev0.email ? "?" : null;
        const k = `${name}|${ev0.t}|${ev0.email}`;
        if (oldKeyEventsSeen.has(k)) continue;
        oldKeyEventsSeen.set(k, true);
        oldKeyEvents.push({ t: ev0.t, via: name, who });
      }
    }
    oldKeyEvents.sort((x, y) => x.t - y.t);
    return oldKeyEvents;
  }
  // 旧い認証の鍵（旧いコードの部品のセッション）は今だれの物か。localStorage は共有なので、読めるタブのどれかで読む（凍らせたタブは除く）
  const oldKeyChecks = [];
  async function oldKeyCheck(label) {
    for (const name of ["old-visible", "old-live", "old-sw", "old-offline", "old-frozen", "new"]) {
      if (name === "old-frozen" && frozenNow) continue;
      const page = tabs[name];
      if (!page || page.isClosed()) continue;
      const v = await Promise.race([
        page.evaluate((k) => {
          const raw = Storage.prototype.getItem.call(localStorage, k);
          if (!raw) return { email: null };
          try {
            const j = JSON.parse(raw);
            return { email: j?.user?.email ?? j?.currentSession?.user?.email ?? "?" };
          } catch {
            return { email: "?" };
          }
        }, OLD_AUTH_KEY),
        sleep(3000).then(() => null)
      ]).catch(() => null);
      if (!v) continue;
      const who = v.email === USERS.A.email ? "A" : v.email === USERS.B.email ? "B" : v.email ? "?" : null;
      oldKeyChecks.push({ t: Date.now(), phase: phaseNow, label, via: name, who });
      note("key", `旧い認証の鍵（${label}・${name} で読んだ）: ${who ?? "空"}`);
      return who;
    }
    oldKeyChecks.push({ t: Date.now(), phase: phaseNow, label, via: null, who: "unread" });
    return "unread";
  }

  let offlineOn = false;
  const reached = [];
  const setPhase = (p) => {
    phaseNow = p;
    fake.setPhase(p);
    reached.push({ phase: p, t: Date.now() });
  };
  const reloads = [];
  // 新しい木に IndexedDB の orphans（移行の後に旧いコードのタブが旧い場所へ書いた値の写し。js/areaStore.js）があるか。DB の名前は木から読む
  const orphansTree = (() => {
    try {
      const src = fs.readFileSync(`${newRoot}/js/areaStore.js`, "utf8");
      const db = src.match(/DB_NAME\s*=\s*"([^"]+)"/)?.[1] ?? null;
      const has = /\borphans\s*:/.test(src);
      return { has: has && !!db, db: db ?? ORPHANS.db, store: ORPHANS.store };
    } catch {
      return { has: false, db: null, store: ORPHANS.store };
    }
  })();
  // A へ戻る段（orphans のある木だけ。--no-return で外す）。公開の語（3 状態と学習状況の画面が数える母集団）は新しい木の data/public/english.json
  const doReturn = returnToA && orphansTree.has;
  const publicIds = (() => {
    try {
      return new Set(JSON.parse(fs.readFileSync(`${newRoot}/data/public/english.json`, "utf8")).order ?? []);
    } catch {
      return null;
    }
  })();
  const areaSnaps = [];
  const result = { sw, login, order, release, oldAuthLib: !!oldVendorFile, expectWriteBack, oldConfirm, newConfirm, seedAt, seed: structuredClone(seed), timeline, dialogs, errors, loads, navs, docStarts, pageRequests, visErrors, oldKeyChecks, oldKeyEvents, reached, reloads, external, tabs: {}, words: { pre: [], old: [], stats: {} }, storage: {}, tap: { wordKey: WORD_KEY, prefix: OLD_PREFIX, disarmedAt: null }, storageWrites, orphansTree, areaWrites, areaSnaps, publicTotal: publicIds?.size ?? null };
  if (live) live.result = result;
  const treeHasSwitch = fs.existsSync(`${newRoot}/switch.html`);
  // localStorage の生の鍵のうち、旧い場所の物（spelldash_*）と旧い認証の鍵（新しいコードのタブでは見張りが読み替えるので、名前の一覧で見る）
  const rawOldKeys = (page) => ev(page, (k) => Object.keys(localStorage).filter((x) => x.startsWith("spelldash_") || x.startsWith(k)).sort(), OLD_AUTH_KEY).catch((e) => ["error " + String(e.message).split("\n")[0]]);
  // 新しいタブで新しいコードの文書を開き直す: / → 落ち着く → 裏と表（送信の道）→ /switch.html（ある木だけ）→ 落ち着く → 裏と表。
  // 移行の後に旧いタブが旧い鍵へ書いた値（答え・閉じる時の書き出し）は、新しいコードが次の読み込みの片付けでだけ扱うので、その後の要求と表を判定に入れる
  async function reloadNew(label, page) {
    const rec = { label, phase: phaseNow, at: Date.now(), treeHasSwitch };
    reloads.push(rec);
    try {
      rec.rawBefore = await rawOldKeys(page);
      await page.goto(srv.origin + "/", { waitUntil: "commit", timeout: 30000 }).catch((e) => note("reload", `new: / を開けなかった（${String(e.message).split("\n")[0]}）`));
      await sleep(4000);
      const s1 = await settle(page, { maxMs: 60000, quietMs: 3000 });
      await vis("new", false);
      await sleep(1500);
      await vis("new", true);
      const s2 = await settle(page, { maxMs: 30000, quietMs: 3000 });
      rec.home = page.url();
      let s3 = true;
      if (treeHasSwitch) {
        const before = Date.now();
        await page.goto(srv.origin + "/switch.html", { waitUntil: "commit", timeout: 30000 }).catch((e) => note("reload", `new: /switch.html を開けなかった（${String(e.message).split("\n")[0]}）`));
        await sleep(3000);
        s3 = await settle(page, { maxMs: 60000, quietMs: 3000 });
        rec.switchLoaded = docStarts.some((d) => d.tab === "new" && d.t >= before && /\/switch\.html/.test(d.url));
        await vis("new", false);
        await sleep(1500);
        await vis("new", true);
        s3 = (await settle(page, { maxMs: 30000, quietMs: 3000 })) && s3;
      }
      rec.finalUrl = page.url();
      rec.settled = s1 && s2 && s3;
      rec.docs = docStarts.filter((d) => d.tab === "new" && d.t >= rec.at).length;
      rec.rawAfter = await rawOldKeys(page);
      // 旧い場所から片付けた値が IndexedDB の orphans に届いたか（新しいコードのタブで読む。orphans のある木だけ）
      if (orphansTree.has) rec.orphans = await ev(page, readOrphansInPage, { db: orphansTree.db, store: orphansTree.store, wordKey: WORD_KEY }, 20000).catch((e) => ({ at: Date.now(), error: String(e.message).split("\n")[0] }));
    } catch (e) {
      rec.error = String(e.message).split("\n")[0];
    }
    rec.end = Date.now();
    note("reload", `new を開き直した（${label}）: ${JSON.stringify({ docs: rec.docs, settled: rec.settled, home: rec.home, switchLoaded: rec.switchLoaded ?? null, finalUrl: rec.finalUrl, rawBefore: rec.rawBefore, rawAfter: rec.rawAfter, orphans: rec.orphans ? { storeExists: rec.orphans.storeExists, records: rec.orphans.records?.length ?? null, error: rec.orphans.error ?? null } : null, error: rec.error ?? null })}`);
    return rec;
  }
  // ---- A へ戻る段の道具（見張りのタブで読む。アプリのページには何も足さない） ----
  // 端末の領域の印（sd2.area）。見張りのタブは見張り（js/areaGuard.js）の無い文書なので、生の値を読む
  const markerNow = async () => {
    const w = tabs.watch;
    if (!w || w.isClosed()) return null;
    return ev(w, () => window.localStorage.getItem("sd2.area"), null, 5000).catch(() => null);
  };
  const pubMark = (words) => (words && typeof words === "object" ? Object.fromEntries(Object.entries(words).map(([id, v]) => [id, { ...v, pub: publicIds ? publicIds.has(id) : null }])) : words);
  // 端末の印・localStorage の領域の語の記録と送る語の印・IndexedDB の areas の控えを読んで残す（見張りのタブで）
  async function snapAreas(label) {
    const w = tabs.watch;
    const rec = { label, phase: phaseNow, t: Date.now() };
    if (!w || w.isClosed()) rec.error = "見張りのタブが無い";
    else {
      const r = await ev(w, readAreasInPage, { db: orphansTree.db, wordName: AREA_WORD_NAME, dirtyName: AREA_DIRTY_NAME }, 20000).catch((e) => ({ error: String(e.message).split("\n")[0] }));
      Object.assign(rec, r);
      for (const a of Object.values(rec.ls ?? {})) a.words = pubMark(a.words);
      for (const c of rec.idb?.records ?? []) c.words = pubMark(c.words);
    }
    areaSnaps.push(rec);
    const brief = (words) => (words && typeof words === "object" ? Object.keys(words).length : words ?? "-");
    note("area", `${label}: 印 ${rec.marker ?? "-"}・localStorage ${JSON.stringify(Object.fromEntries(Object.entries(rec.ls ?? {}).map(([a, v]) => [a, { words: brief(v.words), dirty: Array.isArray(v.dirty) ? v.dirty.length : v.dirty ?? null }])))}・控え ${JSON.stringify((rec.idb?.records ?? []).map((c) => `${c.area}:${brief(c.words)}`))}${rec.error ? `・誤り ${rec.error}` : ""}`);
    return rec;
  }
  // A のクラウド（にせの表）の語の行の写し
  const cloudWords = (userId) => (fake.tables.get("word_progress") ?? []).filter((r) => r.user_id === userId).map((r) => ({ word_id: r.word_id, play_count: r.play_count, correct_count: r.correct_count, recall_fail: r.recall_fail, last_played: r.last_played, updated_at: r.updated_at ?? null }));
  // 切り替えの画面に「ゲストで学んだ記録を、このアカウントに移す？」が出ていたら「いいえ」（ゲストの記録を A に混ぜない。この段では出ないはず。出たら記録する）
  async function answerAsk(page, rec) {
    const asked = await ev(page, () => {
      const box = document.getElementById("switchAsk");
      return !!box && !box.hidden;
    }, null, 3000).catch(() => false);
    if (!asked) return false;
    rec.asked = (rec.asked ?? 0) + 1;
    await ev(page, () => document.getElementById("switchAskNo")?.click(), null, 3000).catch(() => {});
    note("6", "切り替えの画面に「移す？」が出たので「いいえ」を押した");
    return true;
  }
  // 新しいタブを who のアカウントへ切り替える。via "form" はページの欄でリンクを頼み、"link" はほかの端末で頼んだリンクを開く。
  // 領域の印が u:<who>#… になり、切り替えの画面から戻り、その人の取り込みの読み（rest:select）が受け口に届くまで待つ
  async function switchAccount(page, who, via) {
    const user = USERS[who];
    const rec = { who, via, t0: Date.now() };
    let link = null;
    if (via === "form") {
      rec.form = await loginByForm(page, user.email, 20000);
      if (rec.form) link = [...fake.mailbox].reverse().find((m) => m.email === user.email && m.at >= rec.t0 && !m.outside)?.link ?? null;
    }
    if (!link) {
      link = fake.issueLink(user.email, srv.origin);
      rec.outside = true;
    }
    note("6", `new: ${who} のリンク（${rec.outside ? "ほかの端末で頼んだ物" : "new の欄から頼んだ"}）を開く`);
    await page.goto(link, { waitUntil: "commit", timeout: 30000 }).catch((e) => note("goto", `new: ${who} のリンクを開けなかった（${String(e.message).split("\n")[0]}）`));
    rec.active = await waitFor(async () => {
      if (/\/switch\.html/.test(page.url())) {
        await answerAsk(page, rec);
        return false;
      }
      const m = (await markerNow()) ?? "";
      if (!m.startsWith(`u:${user.id}#`)) return false;
      return fake.requests.some((r) => r.at >= rec.t0 && r.tab === "new" && r.auth?.who === who && r.auth?.kind === "user" && r.kind === "rest:select");
    }, sw ? loginWaitMs : 180000, 500);
    rec.settled = await settle(page, { maxMs: 40000, quietMs: 3000 });
    rec.url = page.url();
    rec.marker = await markerNow();
    rec.at = Date.now();
    note("6", `new: ${who} の領域になった ${rec.active}（印 ${rec.marker}・${rec.url}）`);
    return rec;
  }
  // 新しいタブでログアウトする（ページのボタン）。領域の印が guest#… になり、切り替えの画面から戻るまで待つ
  async function logoutOnPage(page) {
    const rec = { t0: Date.now() };
    rec.hadUser = await waitFor(() => page.evaluate(() => !document.getElementById("accountUser")?.hidden), 15000, 300);
    await page.click("#avatarButton", { timeout: 5000 }).catch(() => {});
    await page.click("#logoutButton", { timeout: 5000 }).catch((e) => note("6", `ログアウトのボタンを押せない: ${String(e.message).split("\n")[0]}`));
    rec.ok = await waitFor(async () => !/\/switch\.html/.test(page.url()) && ((await markerNow()) ?? "").startsWith("guest#"), sw ? loginWaitMs : 90000, 500);
    rec.settled = await settle(page, { maxMs: 30000, quietMs: 3000 });
    rec.guestShown = await waitFor(() => page.evaluate(() => !document.getElementById("accountGuest")?.hidden), 10000, 300);
    rec.url = page.url();
    rec.marker = await markerNow();
    note("6", `new: ログアウトした ${rec.ok}（印 ${rec.marker}・${rec.url}）`);
    return rec;
  }
  // 学習状況の画面（stats.html）の 3 つの札の語数と「覚えた N」を読む。読んだらホームへ戻る
  async function readLearnScreen(page) {
    const rec = { t0: Date.now() };
    await page.goto(srv.origin + "/stats.html", { waitUntil: "commit", timeout: 30000 }).catch((e) => note("goto", `new: 学習状況を開けなかった（${String(e.message).split("\n")[0]}）`));
    rec.drawn = await waitFor(() => ev(page, () => {
      const box = document.getElementById("learnStatus");
      const cards = [...document.querySelectorAll("#learnCards .learn-card")];
      return !!box && !box.classList.contains("is-unavailable") && cards.length === 3 && cards.every((c) => c.dataset.count !== undefined);
    }, null, 5000), 45000, 300);
    await settle(page, { maxMs: 30000, quietMs: 2500 });
    Object.assign(rec, await ev(page, () => ({
      url: location.href,
      cards: Object.fromEntries([...document.querySelectorAll("#learnCards .learn-card")].map((c) => [c.dataset.state, c.dataset.count === undefined ? null : Number(c.dataset.count)])),
      learnCount: document.getElementById("learnCount")?.textContent ?? null,
      learnTotal: document.getElementById("learnTotal")?.textContent ?? null,
      unavailable: document.getElementById("learnStatus")?.classList.contains("is-unavailable") ?? null
    }), null, 8000).catch((e) => ({ error: String(e.message).split("\n")[0] })));
    rec.marker = await markerNow();
    note("6", `学習状況の画面: ${JSON.stringify({ drawn: rec.drawn, cards: rec.cards, learnCount: rec.learnCount, marker: rec.marker })}`);
    await page.goto(srv.origin + "/", { waitUntil: "commit", timeout: 30000 }).catch(() => {});
    await sleep(2000);
    await settle(page, { maxMs: 30000, quietMs: 3000 });
    return rec;
  }
  // 送り切る（裏と表: 新しいコードの送信の道 pushSync({ leaving })）
  async function flushNew(page) {
    await vis("new", false);
    await sleep(1500);
    await vis("new", true);
    await settle(page, { maxMs: 30000, quietMs: 3000 });
  }
  async function returnPhase(page) {
    const rec = { mode: login === "none" ? "relogin" : login, start: Date.now() };
    result.returnA = rec;
    try {
      // 6-1. A へ戻る（1 回目）
      setPhase("6-return-A");
      if (login === "link") rec.first = await switchAccount(page, "A", "link");
      else {
        rec.firstLogout = await logoutOnPage(page);
        rec.first = await switchAccount(page, "A", "form");
      }
      rec.firstAt = rec.first.at;
      rec.screen1 = await readLearnScreen(page);
      await flushNew(page);
      rec.snap1 = (await snapAreas("return1")).label;
      rec.cloud1 = cloudWords(USERS.A.id);
      rec.cloud1At = Date.now();
      // 6-2. A から離れる（link は B へ・ほかはゲストへ）
      setPhase("6-away-again");
      if (login === "link") rec.away = await switchAccount(page, "B", "link");
      else rec.away = await logoutOnPage(page);
      await flushNew(page);
      rec.snapAway = (await snapAreas("away2")).label;
      // 6-3. A へ戻る（2 回目）
      setPhase("6-return-again");
      rec.second = await switchAccount(page, "A", login === "link" ? "link" : "form");
      rec.screen2 = await readLearnScreen(page);
      await flushNew(page);
      rec.snap2 = (await snapAreas("return2")).label;
      rec.cloud2 = cloudWords(USERS.A.id);
    } catch (e) {
      rec.error = String(e?.stack || e).slice(0, 600);
      note("6", `A へ戻る段で止まった: ${rec.error.split("\n")[0]}`);
    }
    rec.end = Date.now();
    return rec;
  }
  try {
    // ---- 1. 旧い木・A ----
    setPhase("1-old-A");
    note("1", `旧い木を配る: ${oldRoot}`);
    const live = await open("old-live", "/robots.txt");
    await live.evaluate((seed) => {
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    }, aLocalStorage(seedAt));
    await live.goto(srv.origin + TAB_PAGES["old-live"], { waitUntil: "load" });
    await sleep(1500);
    const viaForm = await loginByForm(live, USERS.A.email);
    note("1", `A がログインのリンクを頼んだ（${viaForm ? "画面の欄から" : "画面の欄が無いので外で"}）`);
    const linkA = fake.lastLink(USERS.A.email) ?? fake.issueLink(USERS.A.email, srv.origin);
    await live.goto(linkA, { waitUntil: "load", timeout: 30000 }).catch((e) => note("goto", `old-live: リンクの読み込みを待てなかった（${String(e.message).split("\n")[0]}）`));
    const aSynced = await waitFor(() => live.evaluate((id) => sessionStorage.getItem("spelldash_sync_done_this_session") === id, USERS.A.id), 25000);
    note("1", `old-live: A の同期 ${aSynced ? "済み" : "済まない"}`);
    await watchOldKey(live);
    await settle(live, { maxMs: 15000 });
    const pre1 = await answerOld(live, 1, "old-live");
    result.words.pre.push(...pre1.changed);
    Object.assign(result.words.stats, pre1.stats);
    note("1", `old-live: A として答えた ${JSON.stringify(pre1.answers.map((a) => `${a.en}(${a.how})`))} → 記録が変わった語 ${pre1.changed.join(",")}`);

    const frozen = await open("old-frozen", TAB_PAGES["old-frozen"]);
    await waitFor(() => frozen.evaluate((id) => sessionStorage.getItem("spelldash_sync_done_this_session") === id, USERS.A.id), 20000);
    await settle(frozen, { maxMs: 12000 });
    const pre2 = await answerOld(frozen, 1, "old-frozen");
    result.words.pre.push(...pre2.changed);
    Object.assign(result.words.stats, pre2.stats);
    note("1", `old-frozen: A として答えた ${JSON.stringify(pre2.answers.map((a) => `${a.en}(${a.how})`))}`);

    const offline = await open("old-offline", TAB_PAGES["old-offline"]);
    await waitFor(() => offline.evaluate((id) => sessionStorage.getItem("spelldash_sync_done_this_session") === id, USERS.A.id), 12000);
    await settle(offline, { maxMs: 10000 });

    const visible = await open("old-visible", TAB_PAGES["old-visible"]);
    await watchOldKey(visible);
    await waitFor(() => visible.evaluate((id) => sessionStorage.getItem("spelldash_sync_done_this_session") === id, USERS.A.id), 20000);
    await settle(visible, { maxMs: 10000 });

    const swTab = await open("old-sw", TAB_PAGES["old-sw"]);
    await waitFor(() => swTab.evaluate((id) => sessionStorage.getItem("spelldash_sync_done_this_session") === id, USERS.A.id), 20000);
    await settle(swTab, { maxMs: 10000 });

    for (const name of OLD_TABS) {
      const page = tabs[name];
      result.tabs[name] = { loadedBeforeDeploy: await loadedModules(page), url: page.url(), swBeforeDeploy: await swState(page), docId: await docIdOf(page) };
      // 利用者が別のタブへ移った（旧いコードの送信: pushSync({leaving})）。old-visible だけは見えたまま
      if (name !== "old-visible") await vis(name, false);
    }
    await settle(null, { maxMs: 10000 });
    result.storage.afterStep1 = await storageView(live);
    // A へ戻る段の見張りのタブ（orphans のある木だけ。配信の前に開き、配信の後の読み直しは読み直しの届かないタブと同じく 204 で止める）
    if (doReturn) {
      const w = await open("watch", "/__oldtab/watch.html?oldtab-keep=watch");
      result.watch = { openedAt: Date.now(), install: await ev(w, installAreaWatch, { binding: WATCH_BINDING, wordName: AREA_WORD_NAME, dirtyName: AREA_DIRTY_NAME }).catch((e) => "error " + String(e.message).split("\n")[0]), docId: await docIdOf(w) };
      note("1", `見張りのタブを開いた: ${result.watch.install}`);
    }

    const cdpFrozen = await ctx.newCDPSession(frozen);
    // --freeze off: 凍らせない（比べるための回。old-frozen はほかの旧いタブと同じく動き続ける）
    const frozenState = freeze ? await freezeTab(frozen, cdpFrozen) : { mode: "off", doc: result.tabs["old-frozen"].docId, at: Date.now() };
    frozenNow = frozenState.mode === "lifecycle" || frozenState.mode === "debugger";
    result.freeze = frozenState;
    note("1", `old-frozen を凍らせた: ${JSON.stringify(frozenState)}`);
    const cdpOffline = await ctx.newCDPSession(offline);
    await cdpOffline.send("Network.enable");
    // 開発用の口の通信断は navigator.onLine と offline の知らせだけに効く（にせの受け口は網の手前で答えるので、受け口の側でもこのタブを断つ）。
    // 同じオリジンの取得は Service Worker を通ると止められないので、ページの取得だけ断つ
    await cdpOffline.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    fake.setOffline("old-offline", true);
    await offline.route((url) => !url.href.startsWith(SUPABASE_URL), (route) => (offlineOn ? route.abort("internetdisconnected") : route.fallback()));
    offlineOn = true;
    result.offlineAt = Date.now();
    note("1", "old-offline の通信を切った");

    // 見えたままの old-visible でトークンの更新を始め、受け口がその答えを止める（新しいタブの移行が終わるまで）。
    // docs/SPEC_ACCOUNT_AREAS.md §6 の 2「自分のトークンの更新で旧い鍵を書き戻しても A のまま」の道: 更新の途中で旧い鍵が移されて消える
    result.refreshRace = { trigger: "refreshSession", held: false };
    await oldKeyCheck("更新を止める前");
    fake.holdToken("old-visible");
    await visible.evaluate(() => {
      window.__oldtabRefresh = import("/js/supabase.js")
        .then((m) => m.supabase.auth.refreshSession())
        .then((r) => ({ email: r?.data?.session?.user?.email ?? null, error: r?.error ? `${r.error.name}: ${r.error.message}` : null }))
        .catch((e) => ({ error: "throw " + String(e) }));
    }).catch((e) => note("1", `old-visible: 更新を始められなかった（${String(e.message).split("\n")[0]}）`));
    result.refreshRace.held = await waitFor(() => fake.held.length > 0, 15000, 100);
    result.refreshRace.heldAt = fake.held[0]?.at ?? null;
    note("1", `old-visible: トークンの更新を受け口で止めた: ${result.refreshRace.held}`);

    // ---- 2. 新しい木を配る・別のタブで開く ----
    setPhase("2-deploy-new");
    // 配信の後に始まる文書（新しいコード）には書き込みの記録を入れない（包みを外す init script を、配信を替える前に足す）
    await ctx.addInitScript(disarmStorageTap);
    result.tap.disarmedAt = Date.now();
    srv.deploy();
    const deployAt = Date.now();
    result.deployAt = deployAt;
    // 移行のある木（記録の見張り js/areaGuard.js がある）は、移行が終わって旧い認証の鍵が消えるまで待ってから、止めていた更新を通す
    const treeHasMigration = fs.existsSync(`${newRoot}/js/areaGuard.js`);
    result.refreshRace.treeHasMigration = treeHasMigration;
    let newTab;
    const migrated = () => newTab.evaluate((k) => Storage.prototype.getItem.call(localStorage, "sd2.migrated") !== null && Storage.prototype.getItem.call(localStorage, k) === null, OLD_AUTH_KEY);
    async function releaseHeld() {
      const migratedBeforeRelease = treeHasMigration ? await waitFor(migrated, sw ? loginWaitMs : 60000, 500) : false;
      result.refreshRace.migratedBeforeRelease = migratedBeforeRelease;
      result.refreshRace.oldKeyBeforeRelease = await oldKeyCheck("移行の後・更新を通す前");
      fake.releaseToken();
      result.refreshRace.releasedAt = Date.now();
      const heldSeq = () => fake.held[0]?.seq ?? null;
      await waitFor(() => heldSeq() !== null && fake.requests.some((r) => r.seq === heldSeq()), 15000, 100);
      await sleep(2500);
      const heldReq = fake.requests.find((r) => r.seq === heldSeq());
      result.refreshRace.response = heldReq ? { seq: heldReq.seq, status: heldReq.status, who: heldReq.who ?? null, phase: heldReq.phase, heldMs: heldReq.heldMs } : null;
      result.refreshRace.library = await Promise.race([visible.evaluate(() => window.__oldtabRefresh ?? null), sleep(20000).then(() => "timeout")]).catch((e) => "error " + String(e.message).split("\n")[0]);
      result.refreshRace.oldKeyAfterRelease = await oldKeyCheck("止めていた更新を通した後");
      // 書き戻し（古い部品が更新の結果を旧い鍵へ書いた）を、節目の読みではなく書き込みの知らせで確かめる（直後に片付けられても見える）
      const evs = (await collectOldKeyEvents()).filter((e) => e.t >= result.refreshRace.releasedAt - 200);
      const wb = evs.find((e) => e.who === "A");
      result.refreshRace.writeBackSeen = !!wb || result.refreshRace.oldKeyAfterRelease === "A";
      result.refreshRace.writeBackAt = wb?.t ?? null;
      result.refreshRace.removedAfterWriteBackAt = wb ? evs.find((e) => e.t >= wb.t && e.who === null)?.t ?? null : null;
      note("2", `old-visible の更新を通した: ${JSON.stringify(result.refreshRace)}`);
    }
    // B のセッションが新しいタブで動くまで待つ（新しい木の Service Worker が有効になるまで取得が止まることがある。止まりの長さは判定の summary に出す）
    const waitB = async () => {
      const bSeen = await waitFor(() => fake.requests.some((r) => r.phase === "3-login-B" && r.tab === "new" && r.auth.who === "B" && r.auth.kind === "user" && r.kind === "rest:select"), loginWaitMs);
      await settle(newTab, { maxMs: 30000, quietMs: 3000 });
      note("3", `new: B の取り込み ${bSeen ? "あり" : "なし"}（${newTab.url()}）`);
      result.storage.afterStep3 = await storageView(newTab);
      await oldKeyCheck("B のログインの後");
    };
    if (order === "direct-link") {
      // 新しいコードの最初の読み込みが B のリンク（旧いタブしか開いていない端末で B のメールのリンクを開いた）。2 段と 3 段が同じ読み込みで起きる
      setPhase("3-login-B");
      newTab = await open("new", null);
      const linkB = fake.issueLink(USERS.B.email, srv.origin);
      note("2", "new: 新しいコードの最初の読み込みが B のリンク（移行の前・旧い認証の鍵は A）");
      // 新しいコードは頭で止めて /switch.html へ移ることがある（load が来ない）。届いた（commit）ところから待つ
      await newTab.goto(linkB, { waitUntil: "commit", timeout: 30000 }).catch((e) => note("goto", `new: B のリンクを開けなかった（${String(e.message).split("\n")[0]}）`));
      result.tabs.new = { url: newTab.url() };
      if (release === "login") {
        // 止めていた更新を、B のセッションが動いて落ち着いた後に通す（切り替えの時の片付けが全部すんだ後に、旧いタブの部品が旧い鍵へ書き戻す形）
        await waitFor(migrated, sw ? loginWaitMs : 60000, 500);
        result.storage.afterStep2 = await storageView(newTab);
        await waitB();
        await releaseHeld();
      } else {
        await releaseHeld();
        result.storage.afterStep2 = await storageView(newTab);
        await waitB();
      }
    } else {
      newTab = await open("new", "/");
      const settled2 = await settle(newTab, { maxMs: 40000, quietMs: 3000 });
      note("2", `new: ${newTab.url()} を開いた（落ち着いた: ${settled2}）`);
      result.tabs.new = { url: newTab.url() };
      if (release !== "login" || login === "none") await releaseHeld();
      result.storage.afterStep2 = await storageView(newTab);

      // ---- 3. 新しいタブで B にログインする ----
      if (login === "none") {
        setPhase("3-no-login");
        note("3", "B にはログインしない（止めていた更新の書き戻しの後に、そのまま旧いタブを戻す）");
        await settle(newTab, { maxMs: 15000, quietMs: 3000 });
        result.storage.afterStep3 = await storageView(newTab);
        await oldKeyCheck("ログインしないまま");
      } else {
        setPhase("3-login-B");
        if (login === "logout") {
          const hadUser = await newTab.evaluate(() => !document.getElementById("accountUser")?.hidden).catch(() => false);
          if (hadUser) {
            await newTab.click("#avatarButton").catch(() => {});
            await newTab.click("#logoutButton").catch((e) => note("3", `ログアウトのボタンを押せない: ${e.message.split("\n")[0]}`));
            await waitFor(() => fake.requests.some((r) => r.phase === "3-login-B" && r.kind === "auth:logout"), 10000);
            await settle(newTab, { maxMs: 30000 });
            note("3", `new: A をログアウトした（${newTab.url()}）`);
          } else note("3", "new: ログインの表示が無い（A のセッションが見えていない）");
        }
        let viaFormB = false;
        if (login === "logout") viaFormB = await loginByForm(newTab, USERS.B.email);
        const linkB = viaFormB ? fake.lastLink(USERS.B.email) : fake.issueLink(USERS.B.email, srv.origin);
        note("3", `B のリンク（${viaFormB ? "new の欄から頼んだ" : "ほかの端末で頼んだ物"}）を new で開く`);
        await newTab.goto(linkB, { waitUntil: "commit", timeout: 30000 }).catch((e) => note("goto", `new: B のリンクを開けなかった（${String(e.message).split("\n")[0]}）`));
        await waitB();
        // --release login: 止めていた更新を B のログインの後に通す
        if (release === "login") await releaseHeld();
      }
    }

    // A の初めの値（旧いタブが 4 段で答える前。B に替わった後は A の控え、B にログインしない回は A の localStorage）
    if (doReturn) await snapAreas("after-step3");
    // ---- 4. 旧いタブを戻す ----
    setPhase("4-revive-old");
    // 凍っていた間に old-frozen の時計が進まなかったか（進んでいたら凍っていない）。時計の文書の印が凍らせた文書と同じか（読み直されて時計ごと消えたのではないか）
    if (result.freeze.mode !== "off") {
      const tick = await readTick();
      result.freeze.tickAtRevive = tick;
      result.freeze.tickDocSame = tick.doc === result.freeze.doc;
      result.freeze.ranWhileFrozen = !(tick.doc === result.freeze.doc && tick.ts > 0 && tick.ts <= result.freeze.at + 1500);
    }
    const resumed = await unfreezeTab(frozen, cdpFrozen, result.freeze);
    frozenNow = false;
    result.unfreezeAt = Date.now();
    result.freeze.docAfterUnfreeze = await docIdOf(frozen);
    await cdpOffline.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    fake.setOffline("old-offline", false);
    offlineOn = false;
    result.onlineAt = Date.now();
    // 止めていた更新の部品の答え（Service Worker が有効になるまで取得が止まる木では、2 段では読めないことがある）
    if (result.refreshRace.library === "timeout" || result.refreshRace.library == null) result.refreshRace.libraryAtRevive = await Promise.race([visible.evaluate(() => window.__oldtabRefresh ?? null), sleep(10000).then(() => "timeout")]).catch((e) => "error " + String(e.message).split("\n")[0]);
    note("4", `old-frozen の凍結を解いた: ${resumed}（文書の印 ${result.freeze.docAfterUnfreeze === result.freeze.doc ? "同じ" : "違う"}）・old-offline の通信を戻した`);
    for (const name of OLD_TABS) {
      await tabs[name].bringToFront().catch(() => {});
      await vis(name, true);
      await sleep(1500);
    }
    await sleep(3000);
    // 配信の後に新しい文書が始まった旧いタブ（新しい木の sw.js が読み直したなど）は、もう旧いコードではない。
    // 答えも旧いモジュールの呼び出しもしない（そのタブの要求は記録して同じく判定する）。旧いコードのまま残ったタブだけで 4 段を流す
    const reloaded = (name) => docStarts.some((d) => d.tab === name && d.t >= deployAt);
    const stillOldNow = () => OLD_TABS.filter((n) => !reloaded(n));
    const stillOld = stillOldNow();
    for (const name of OLD_TABS) result.tabs[name].reloadedAfterDeploy = reloaded(name);
    note("4", `配信の後に読み直された旧いタブ: ${OLD_TABS.filter(reloaded).join("・") || "なし"}・止めた読み直し: ${JSON.stringify(srv.blocked.map((b) => b.keep))}`);
    for (const name of ["old-live", "old-frozen"].filter((n) => stillOld.includes(n))) {
      const r = await answerOld(tabs[name], 2, name).catch((e) => ({ answers: [{ ok: false, reason: "error " + String(e.message).split("\n")[0] }], changed: [], stats: {}, written: [], writtenStats: {}, wordWrites: 0 }));
      // A の語（判定の A が答えた語）: 端末に残った変化と、タブの中で書いた語（分離の入った木では端末にすぐ残らない）
      result.words.old.push(...r.changed, ...(r.written ?? []).filter((id) => !r.changed.includes(id)));
      Object.assign(result.words.stats, r.writtenStats ?? {}, r.stats);
      result.tabs[name].answers = r.answers;
      result.tabs[name].changed = r.changed;
      result.tabs[name].written = r.written ?? [];
      result.tabs[name].answerDoc = r.doc ?? null;
      note("4", `${name}: 旧い画面で答えた ${JSON.stringify(r.answers.map((a) => (a.en ? `${a.en}(${a.how})` : a.reason)))} → 端末の記録が変わった語 ${r.changed.join(",") || "なし"}・タブの中で語の記録へ書いた ${r.wordWrites ?? 0} 回（語 ${(r.written ?? []).join(",") || "なし"}）`);
    }
    for (const name of OLD_TABS) {
      await vis(name, false);
      await sleep(1500);
      await vis(name, true);
    }
    await settle(null, { maxMs: 10000 });
    // 読み込み済みの旧いモジュールの送信・同期・セッションの読み（= トークンの更新）を直に呼ぶ。配信の前に読み込んだ物だけ（新しいファイルを旧いタブに読ませない）
    for (const name of OLD_TABS) {
      result.tabs[name].swAfterLogin = await swState(tabs[name]);
      if (stillOldNow().includes(name) && result.tabs[name].loadedBeforeDeploy.includes("/js/sync.js")) result.tabs[name].syncCode = await codeOf(tabs[name]);
    }
    result.tabs.new.sw = await swState(newTab);
    note("4", `旧いタブの同期のコード: ${JSON.stringify(Object.fromEntries(OLD_TABS.map((n) => [n, result.tabs[n].syncCode ?? null])))}`);
    note("4", `Service Worker: ${JSON.stringify(Object.fromEntries([...OLD_TABS, "new"].map((n) => [n, n === "new" ? result.tabs.new.sw : { before: result.tabs[n].swBeforeDeploy, after: result.tabs[n].swAfterLogin }])))}`);
    setPhase("4-forced");
    for (const name of stillOldNow()) {
      const loaded = result.tabs[name].loadedBeforeDeploy;
      result.tabs[name].forcedAt = Date.now();
      const calls = await tabs[name].evaluate(async (loaded) => {
        const out = [];
        if (loaded.includes("/js/supabase.js")) {
          const m = await import("/js/supabase.js");
          const r = await m.supabase.auth.getSession().catch((e) => ({ error: String(e) }));
          out.push(["getSession", r?.error ? "error " + r.error : r?.data?.session?.user?.email ?? null]);
        }
        if (loaded.includes("/js/sync.js")) {
          const m = await import("/js/sync.js");
          out.push(["pushSync", String(await m.pushSync().catch((e) => "error " + e))]);
          out.push(["initialSync", String(await m.initialSync({}).catch((e) => "error " + e))]);
          out.push(["pushSync", String(await m.pushSync().catch((e) => "error " + e))]);
        }
        return out;
      }, loaded).catch((e) => [["error", "error " + String(e.message).slice(0, 200)]]);
      result.tabs[name].forced = calls;
      note("4", `${name}: 旧いモジュールを呼んだ ${JSON.stringify(calls)}`);
    }
    await settle(null, { maxMs: 15000 });
    await oldKeyCheck("旧いモジュールを呼んだ後");
    setPhase("4-wait-refresh");
    note("4", `トークンの更新を待つ（${Math.round(waitRefreshMs / 1000)} 秒・途中で裏と表を 1 回ずつ）`);
    await sleep(waitRefreshMs / 2);
    for (const name of OLD_TABS) {
      await vis(name, false);
      await sleep(500);
      await vis(name, true);
    }
    await sleep(waitRefreshMs / 2);
    await oldKeyCheck("更新を待った後");
    // 旧いタブが旧い鍵へ書いた後に、新しいコードの文書を開き直す（旧いタブは開いたまま）
    setPhase("4-reload-new");
    await reloadNew("after-step4", newTab);
    await oldKeyCheck("新しいコードを開き直した後");
    // ---- 送り切る: 全部のタブを裏へ回す・旧いタブを閉じる（pagehide） ----
    setPhase("5-flush");
    for (const name of [...OLD_TABS, "new"]) await vis(name, false);
    await settle(null, { maxMs: 10000 });
    for (const name of OLD_TABS) result.tabs[name].docAtEnd = await docIdOf(tabs[name]);
    await collectOldKeyEvents();
    result.storage.end = await storageView(newTab).catch(() => null);
    result.storage.endWordStatsOld = Object.keys(await wordStats(live).catch(() => ({})));
    for (const name of OLD_TABS) await tabs[name].close({ runBeforeUnload: true }).catch(() => {});
    await sleep(3000);
    await settle(null, { maxMs: 8000 });
    // 閉じる時の書き出し（pagehide）も旧い鍵へ書く。もう一度、新しいコードの文書を開き直す
    setPhase("5-reload-new");
    await reloadNew("after-close", newTab);
    result.storage.afterReload = await storageView(newTab).catch(() => null);
    // ---- 6. A へ戻る（orphans のある木だけ） ----
    if (doReturn) {
      await snapAreas("after-step5");
      await returnPhase(newTab);
      result.watch.docAtEnd = await docIdOf(tabs.watch);
    }
    reached.push({ phase: "end", t: Date.now() });
  } catch (e) {
    result.crash = String(e?.stack || e);
    note("error", result.crash.split("\n")[0]);
  } finally {
    fake.releaseToken();
    result.requests = fake.requests;
    result.held = fake.held;
    result.tables = Object.fromEntries([...fake.tables].map(([t, rows]) => [t, rows]));
    if (doReturn) result.mailbox = fake.mailbox.map((m) => ({ email: m.email === USERS.A.email ? "A" : m.email === USERS.B.email ? "B" : "?", at: m.at, outside: !!m.outside }));
    result.served = srv.served;
    result.reloadBlocked = srv.blocked;
    await ctx.close().catch(() => {});
    await srv.close();
  }
  return result;
}
