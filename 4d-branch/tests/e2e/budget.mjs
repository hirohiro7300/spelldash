// E2E: 性能の予算（作業メモ SPEC v1 §7.2・見直し perf-12）を、3 か月ごとの地図（版 7 の候補・約 7.2 万枚）を入れたページで測る
//   node tests/e2e/budget.mjs
//   既定のビルド（P2: ページに版 7 の地図を入れる）を作業用のフォルダ（BUDGET_DIST。既定は OS の一時フォルダの下）に作り、vite preview で開く
//   （E2E_PORT。既定 4520）。IMPACT_Q_BUNDLE を渡すと、その同梱データで作る（VITE_IMPACT_Q=1）。
//   BUDGET_BOOT=stored（既定）: 保存してあった物を読む起動の道で測る。合成した版 6 の利用者の文書（tests/fixtures/account-r6.json。本物のデータではない）を
//   IndexedDB に入れて 1 度開き（読むときに版 7 へ引き上げ、薄い形で保存）、その後の開き直し（保存した薄い形を読む）を測る。
//   BUDGET_BOOT=demo-q: #demo-q（組み立てた地図を保存しない一時表示）で測る（前の測り方）。
//   測り方: 入力が届いた瞬間（window の capture のリスナー）から、その入力の後の次のフレームの終わり（rAF の中で置いたタスクが動いた時刻:
//   そのフレームを描き終えた後）まで。リスナーの仕事を含む。続けて送る入力（変換中の文字）は、フレームの中の決まった所から始めないよう、
//   1 つごとにフレームの中のばらばらの時刻（0〜16 ms 待つ）から送る（rAF 2 回で測ると、どの 1 文字も 2 フレーム = 33 ms より短く出ない: 見直し perf-12）。
//   日本語の入力（IME）のように、変換中の 1 文字ずつ input を送る（題名・検索）。
//   机（1440×900）とスマホ（390×844・CPU 4 倍遅く）。それぞれ 3 回（カードを選ぶは 7 回: SELECT_ROUNDS）のうち一番良い値と中くらいの値。予算は一番良い値と中くらいの値の両方で見る
//   （どちらかが超えたら ✗。✗ があれば終わりのコードを 1 にする。BUDGET_REPORT_ONLY=1 なら 0 のまま）。
//   ヒープは JS のヒープ・ArrayBuffer など（backingStorageSize）・DOM（embedderHeapUsedSize）の合計（型付き配列の計算が数に入る: 見直し perf-3）。
//   予算の表のほかに: 選んだ後に概要へ戻る（Esc）・取り込み（全部の入れ替え）・手のカードを 50 枚見た後のヒープ・変更の後 3 秒の長い仕事・
//   引き出しを閉じたスマホでカードを選ぶときのレイアウトの時間（見直し perf-1〜perf-8・perf-12）。BUDGET_OUT に JSON を書く。
//   BUDGET_ONLY=desktop か phone で片方だけ。PW_CHROMIUM でブラウザの場所を指定できる
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.E2E_PORT || 4520);
const BASE = `http://localhost:${PORT}/`;
const SCRATCH = "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap";
const BUNDLE = process.env.IMPACT_Q_BUNDLE || "";
const BOOT = process.env.BUDGET_BOOT || "stored";
const FIXTURE = path.join(ROOT, "tests", "fixtures", "account-r6.json");
const DIST = process.env.BUDGET_DIST || path.join(os.tmpdir(), "4d-branch-budget-dist");
const ONLY = process.env.BUDGET_ONLY || "";
const ROUNDS = Number(process.env.BUDGET_ROUNDS || 3);
/**
 * カードを選ぶ行の回数（P4）。この行は 1 フレーム（16.7 ms）より短い仕事と、押した時刻から次のフレームの頭までの待ち（0〜16.7 ms の
 * どこか）の和なので、3 回だと中くらいの値がその待ちのばらつきでほぼ決まる（同じビルドで 25〜34 ms と振れた）。7 回にして中くらいの値を
 * 確かにする（予算 30 ms はそのまま。一番良い値と中くらいの値の両方で見るのも同じ）。Esc で概要へ戻る行は、これにする・見送るの
 * 後ごとに測るので、もう 2 × BUDGET_ROUNDS 回ある
 */
const SELECT_ROUNDS = Number(process.env.BUDGET_SELECT_ROUNDS || Math.max(ROUNDS, 7));

/** 予算（§7.2。ms・MB。null は無し） */
const BUDGET = {
  boot: [1500, 5000],
  firstPaint: [800, 3000],
  select: [30, 120],
  pick: [150, 600],
  drop: [150, 600],
  open: [100, 400],
  close: [100, 400],
  jump: [100, 400],
  yearOpen: [300, 1200],
  structural: [400, 1600],
  structuralUndo: [400, 1600],
  scenario: [150, 600],
  scenarioOff: [150, 600],
  salary: [150, 600],
  keystroke: [30, 120],
  search: [30, 120],
  undo: [150, 600],
  deselect: [30, 120],
  adopt: [300, 1200],
  adoptClone: [null, null],
  autosave: [50, 200],
  longTask: [50, 50],
  bootLongTask: [50, 200],
  selectLayout: [null, 5],
  heapBoot: [150, null],
  heapBootEarly: [null, null],
  heapUse: [200, null],
  heapBrowse: [200, null],
};
const LABEL = {
  boot: "起動して触れるまで（地図あり）",
  firstPaint: "見取り図が最初に描かれるまで（文書の組み立ての前に先に描く 3 年の見取り図）",
  select: "カードを選ぶ",
  pick: "これにする",
  drop: "見送る",
  open: "1 つ開く（C）",
  close: "1 つ閉じる（C）",
  jump: "カードへ寄る（検索の候補から隠れたカードへ）",
  yearOpen: "1 年先まで開く（今日を選んだ詳細の、手ごとの「1 年先まで（N 枚）」を押す。今日から全部は縦に長すぎて見取り図で見る: 見直し user-8）",
  structural: "地図の中の形の編集（カードに子を足す: Tab）",
  structuralUndo: "形の編集を元に戻す",
  scenario: "シナリオを変える",
  scenarioOff: "シナリオを外す",
  salary: "年収を変える",
  keystroke: "題名の 1 文字（変換中を含む）",
  search: "検索の 1 文字（変換中を含む）",
  undo: "元に戻す（これにするの取り消し）",
  deselect: "これにした後に概要へ戻る（キャンバスで Esc）",
  adopt: "取り込み（別の端末の内容: 全部の入れ替え。届いた写しは測る前に作る。写しは本当の同期・ほかのタブ・インポート・復元と同じく、薄い形で書いて読み直した物: 変えていないカードは地図の基準と同じ物）",
  adoptClone: "（参考・予算なし）取り込みの写しが structuredClone（どのカードも別の物）。どの取り込みの道もこの形を作らない（作業メモ SPEC §7.2: P4 で予算の行を本当の取り込みに直した）",
  autosave: "自動保存の書き出し（これにした後の文書を薄い形にする: toStored）",
  longTask: "変更（シナリオ・年収・これにする）を描いた後 3 秒の、一番長い仕事（ms。空いた時間の仕事。変更そのものは数えない）",
  bootLongTask: "起動して触れるようになった後の、一番長い仕事（ms。机 10 秒・スマホ 20 秒。自動保存の覚えを先に作る・年収の境目・検索の索引など空いた時間の仕事。起動そのものは数えない。予算は自動保存の書き出しと同じ: P4）",
  selectLayout: "引き出しを閉じたスマホでカードを選ぶときのレイアウト（ms）",
  heapBoot:
    "起動後のヒープ（MB。JS・ArrayBuffer・DOM の合計）。起動の後の空いた時間の仕事（自動保存の覚え・検索の索引・見込みの計画・年収の境目）が済んだ後: 触れるようになってから机 10 秒・スマホ 20 秒、何もせずに待った後（最後の回のほかの回。作業メモ SPEC §7.2: P4 の見直しで測る時を決めた）",
  heapBootEarly: "（参考・予算なし）触れるようになった直後のヒープ（前の測り方。空いた時間の仕事の途中で測るので、どこまで済んだかで同じビルドが 142〜154 MB と振れた）",
  heapUse: "起動 + 10 回これにする + 1 年先まで開いたまま + 検索の後のヒープ（MB。合計）",
  heapBrowse: "その後、手のカードを 50 枚（違う判断の物）見た後のヒープ（MB。合計）",
};

function build() {
  if (BUNDLE && !fs.existsSync(BUNDLE)) throw new Error(`地図の同梱データがありません: ${BUNDLE}`);
  if (process.env.BUDGET_DIST && fs.existsSync(path.join(DIST, "index.html"))) return;
  console.log(`ビルド（${BUNDLE ? `VITE_IMPACT_Q=1・${BUNDLE}` : "既定: 版 7 の地図"}）→ ${DIST}`);
  const env = { ...process.env };
  if (BUNDLE) Object.assign(env, { VITE_IMPACT_Q: "1", IMPACT_Q_BUNDLE: BUNDLE });
  else delete env.VITE_IMPACT_Q;
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", DIST, "--emptyOutDir", "--logLevel", "warn"], {
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
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* まだ */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("preview サーバーが起動しません");
}

/** ページの中の測る道具（入力の capture で始め、終わりの入力の後の rAF 2 回で止める） */
function installTools() {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  /** 次のフレームの終わり（rAF の中で置いたタスク: そのフレームを描き終えた後に動く） */
  const afterFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  /** フレームの中のばらばらの時刻まで待つ（続けて送る入力を、フレームの頭にそろえない） */
  const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 16));
  window.__budget = {
    cur: null,
    arm(startType, endType) {
      const st = { start: 0 };
      st.promise = new Promise((res) => (st.res = res));
      const onStart = () => {
        if (!st.start) st.start = performance.now();
      };
      const onEnd = () => {
        if (!st.start) st.start = performance.now();
        window.removeEventListener(startType, onStart, true);
        window.removeEventListener(endType, onEnd, true);
        requestAnimationFrame(() => setTimeout(() => st.res(performance.now() - st.start), 0));
      };
      window.addEventListener(startType, onStart, true);
      window.addEventListener(endType, onEnd, true);
      window.__budget.cur = st;
    },
    wait() {
      return window.__budget.cur.promise;
    },
    async time(fn) {
      await frames();
      await jitter();
      const t0 = performance.now();
      fn();
      await afterFrame();
      return performance.now() - t0;
    },
    /** 変換中の文字を 1 つずつ送る（compositionstart → input ×n → compositionend → input）。それぞれの時間 */
    async ime(el, steps, final) {
      const out = [];
      el.focus();
      el.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      for (const v of steps) {
        await jitter();
        const t0 = performance.now();
        el.value = v;
        el.dispatchEvent(new InputEvent("input", { data: v, inputType: "insertCompositionText", isComposing: true, bubbles: true }));
        await afterFrame();
        out.push(performance.now() - t0);
      }
      el.dispatchEvent(new CompositionEvent("compositionend", { data: final, bubbles: true }));
      await jitter();
      const t0 = performance.now();
      el.value = final;
      el.dispatchEvent(new InputEvent("input", { data: final, inputType: "insertText", isComposing: false, bubbles: true }));
      await afterFrame();
      out.push(performance.now() - t0);
      return out;
    },
    /**
     * 長い仕事（50 ms 超）を見張る。from（その時刻より後に始まった仕事だけ。変更そのものを受ける仕事は数えない）を mark で決め、
     * stop で、見張っていた間の長い仕事の時間の並び
     */
    watchLong() {
      const list = [];
      let from = Infinity;
      let po = null;
      try {
        po = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) if (e.startTime >= from) list.push(e.duration);
        });
        po.observe({ type: "longtask", buffered: false });
      } catch {
        /* 見張れない */
      }
      return {
        mark() {
          from = performance.now();
        },
        stop() {
          po?.disconnect();
          return list;
        },
      };
    },
    frames,
    afterFrame,
  };
}

const best = (xs) => (xs.length ? Math.min(...xs) : NaN);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** 計測の道具と設定を入れるページの頭の台本（読み込みのたびに動く） */
function bootScript() {
  // 新しい地図の知らせ（版 7）はもう見せた形で測る（一度だけの物。出すと画面の操作を覆う）
  try {
    localStorage.setItem("4d-branch:prefs", JSON.stringify({ releaseSheet: 7, onboardingDone: true, futureAutoOpened: true, futureOffered: true, wishlistOffered: true }));
  } catch {
    /* about:blank */
  }
  // 見取り図が描かれたフレーム（右のパネルの 10 の手をひと目で）を記録する
  const deepTick = () => {
    // 起動の途中に先に描いた見取り図（.deep-splash）か、右のパネルの見取り図
    // 見つけたのは rAF の中（このフレームで描かれる）。そのフレームを描き終えた直後（rAF の中で置いたタスク）の時刻。
    // 次の rAF を待つと、先に描いた後に続く文書の組み立て（長い 1 つの仕事）の後になってしまう
    if (document.querySelector(".deep-splash .dm-glance-row, .sidebar-right .deep-ov .dm-glance-row")) {
      setTimeout(() => (window.__deepPaint ??= performance.now()), 0);
      return;
    }
    requestAnimationFrame(deepTick);
  };
  requestAnimationFrame(deepTick);
  // 長い仕事（50 ms 超）を、読み込みの初めから記録する（起動して触れた後の長い仕事: bootLongTask）
  window.__bootLong = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__bootLong.push([e.startTime, e.duration]);
    }).observe({ type: "longtask" });
  } catch {
    /* 見張れない */
  }
  // 地図が描かれた最初のフレーム（触れる）を記録する
  const tick = () => {
    const f = window.__fourD;
    const app = f && f.app;
    if (app && app.view && app.view.lastFrameMs > 0 && app.vm.drawNodes.length > 0 && app.vm.impact.active) {
      window.__firstMapFrame ??= performance.now();
      // 触れる: 描いた後の次のフレーム（入力を受けられる）
      requestAnimationFrame(() => (window.__interactive = performance.now()));
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

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
    },
    { rec },
  );
  await page.close();
}

/** 起動の時刻（ナビゲーションの始まりから）を待って読む */
async function bootTimes(page) {
  await page.waitForFunction(() => typeof window.__interactive === "number" && typeof window.__deepPaint === "number", null, { timeout: 180_000, polling: 200 });
  const t = await page.evaluate(() => ({ boot: window.__interactive, firstPaint: window.__deepPaint, mapPaint: window.__firstMapFrame, nodes: window.__fourD.app.vm.nodeCount, hash: location.hash }));
  if (t.nodes < 50_000) throw new Error(`地図のカードが少なすぎます（${t.nodes} 枚）。地図を入れたビルドではないかもしれません`);
  return t;
}

/**
 * 開いて、地図が描かれて触れるまで（起動の時刻はナビゲーションの始まりから）。stored: 同じ起点（保存先）の 2 回目からの開き直し
 * （prev に前の回の物を渡す: 同じページを読み直す）。1 回目は版 6 の文書を引き上げて薄い形で保存する（測らない）
 */
async function boot(browser, profile, prev) {
  if (BOOT === "stored" && prev) {
    const { ctx, page, cdp, errors } = prev;
    await page.reload({ waitUntil: "commit" });
    const t = await bootTimes(page);
    await page.evaluate(installTools);
    return { ctx, page, cdp, t, errors };
  }
  const ctx = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: profile.dpr });
  await ctx.addInitScript(bootScript);
  if (BOOT === "stored") await seedStored(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  if (BOOT === "stored") {
    // 1 回目: 版 6 の文書を読むときに引き上げ、薄い形で保存する（測らない。速さを落とさずに済ませる）
    await page.goto(BASE, { waitUntil: "commit" });
    await bootTimes(page);
    await page.evaluate(() => window.__fourD.persistence.flush());
    if (profile.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
    await page.reload({ waitUntil: "commit" });
    const t = await bootTimes(page);
    await page.evaluate(installTools);
    return { ctx, page, cdp, t, errors };
  }
  if (profile.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
  await page.goto(`${BASE}#demo-q`, { waitUntil: "commit" });
  const t = await bootTimes(page);
  await page.evaluate(installTools);
  return { ctx, page, cdp, t, errors };
}

/** 何もせずに待つ（ページの中の時計で。待つ間にページへ何も送らない） */
const page_wait = (page, ms) => page.waitForTimeout(ms);

/** ヒープ（MB）: JS のヒープ + ArrayBuffer など（型付き配列）+ DOM。parts に内訳 */
async function heapMB(cdp, parts) {
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const h = await cdp.send("Runtime.getHeapUsage");
  const mb = (x) => (x ?? 0) / 1024 / 1024;
  if (parts) parts.push({ used: mb(h.usedSize), backing: mb(h.backingStorageSize), embedder: mb(h.embedderHeapUsedSize) });
  return mb(h.usedSize) + mb(h.backingStorageSize) + mb(h.embedderHeapUsedSize);
}

/** BUDGET_HEAP_TRACE=1 のとき、手順ごとの JS のヒープ（GC の後）を書き出す（ヒープの行を何が増やしたかを探す） */
async function traceHeap(cdp, step) {
  if (process.env.BUDGET_HEAP_TRACE !== "1") return;
  await cdp.send("HeapProfiler.collectGarbage");
  const h = await cdp.send("Runtime.getHeapUsage");
  console.log(`    ヒープ（${step}）: JS ${(h.usedSize / 1048576).toFixed(1)} MB・ArrayBuffer ${(h.backingStorageSize / 1048576).toFixed(1)} MB`);
}

/** キャンバスの上のカードの画面の位置（見えていなければ null） */
const cardPoint = (page, id) =>
  page.evaluate((nid) => {
    const f = window.__fourD;
    const v = f.app.view;
    const p = f.app.vm.posOf(nid);
    if (!p) return null;
    const s = v.camera.toScreen(p.x, p.y);
    const r = v.canvas.getBoundingClientRect();
    const x = r.left + s.x;
    const y = r.top + s.y;
    if (x < r.left + 20 || x > r.right - 20 || y < r.top + 20 || y > r.bottom - 20) return null;
    // ほかの部品（パネル・ボタン）に隠れていないか
    const top = document.elementFromPoint(x, y);
    return top === v.canvas ? { x, y } : null;
  }, id);

/** 見えている 3 年の分かれ道の手（選択肢）で、画面の中にある物（ID の並び） */
const visibleAlts = (page) =>
  page.evaluate(() => {
    const f = window.__fourD;
    const vm = f.app.vm;
    vm.ensure();
    return vm.drawNodes.filter((id) => vm.inImpact(id) && f.store.doc.nodes[id].meta.fork === "chance" && f.store.doc.nodes[id].status === "open");
  });

async function measureProfile(browser, profile) {
  console.log(`\n== ${profile.name}（${profile.viewport.width}×${profile.viewport.height}${profile.cpu > 1 ? `・CPU ${profile.cpu} 倍遅く` : ""}）`);
  const r = {};
  const push = (k, v) => {
    if (!Number.isFinite(v)) return;
    (r[k] ??= []).push(v);
  };
  // 起動（毎回新しいページ）
  let s = null;
  for (let k = 0; k < ROUNDS; k++) {
    if (s && BOOT !== "stored") await s.ctx.close();
    s = await boot(browser, profile, BOOT === "stored" ? s : null);
    push("boot", s.t.boot);
    push("firstPaint", s.t.firstPaint);
    // 最後の回のほかは、触れるようになった後しばらく何もせずに待ち、その間の一番長い仕事を見る（起動の後の空いた時間の仕事:
    // 自動保存の覚え・年収の境目・検索の索引など）。待った後に起動後のヒープ（heapBoot）を測る: 空いた時間の仕事が済んで落ち着いた物。
    // 触れるようになった直後に測ると、空いた時間の仕事がどこまで済んだかで同じビルドが 142〜154 MB と振れた（P4 の見直し
    // speed-heapboot-over: 直後 134 MB → 3 秒後に 149.6 MB で止まり、10 秒・15 秒後も同じ）。落ち着いた物は、何もしない利用者が
    // 持ち続けるヒープで、直後の物より大きい（予算 150 MB はそのまま）。最後の回はすぐに測る（前の測り方: heapBootEarly。予算なし）。
    // 回が 1 つだけなら、その回で待ってから測る
    const quietRound = k < ROUNDS - 1 || ROUNDS === 1;
    if (quietRound) {
      const quiet = profile.cpu > 1 ? 20_000 : 10_000;
      await page_wait(s.page, quiet);
      const lt = await s.page.evaluate(() => window.__bootLong.filter(([st]) => st >= window.__interactive).map(([st, d]) => [Math.round(st - window.__interactive), Math.round(d)]));
      push("bootLongTask", lt.length ? Math.max(...lt.map((x) => x[1])) : 0);
      (r.bootLongTasks ??= []).push(lt);
      (r.heapPartsBoot ??= []);
      push("heapBoot", await heapMB(s.cdp, r.heapPartsBoot));
      await s.cdp.send("HeapProfiler.disable");
    }
  }
  r.bootPath = BOOT;
  // 起動で 3 年の影響の形をどこから作ったか（map: 地図の列から・doc: 文書から）と、保存先の形
  r.lastCompile = await s.page.evaluate(() => window.__fourD.app.vm.engine?.lastCompile ?? null);
  const { page, cdp } = s;
  r.heapParts = [];
  push("heapBootEarly", await heapMB(cdp, r.heapParts));
  const narrow = profile.viewport.width < 700;
  const closePanels = () => page.evaluate(() => window.__fourD.ui.setPrefs({ leftOpen: false, rightOpen: false }));
  const openRight = () => page.evaluate(() => window.__fourD.ui.setPrefs({ rightOpen: true }));
  if (narrow) await closePanels();
  // 保存してあった起動は、前に見ていた所（保存したカメラ）から始まる: 今日と今日の手に寄せてから測る（#demo-q は最初からそこ）
  await page.evaluate(() => {
    const f = window.__fourD;
    const imp = f.app.vm.impact;
    f.ui.clearSelection();
    f.app.view.fit([imp.root, ...imp.decision.get(imp.root).alts], { animate: false, minZoom: 0.3 });
  });
  await page.waitForTimeout(300);

  // カードを選ぶ（キャンバスを押す）。狭い画面（引き出しは閉じている）は、その間のレイアウトの時間も（見直し perf-5）
  if (narrow) await cdp.send("Performance.enable");
  const layoutMs = async () => {
    const m = await cdp.send("Performance.getMetrics");
    return (m.metrics.find((x) => x.name === "LayoutDuration")?.value ?? 0) * 1000;
  };
  const canvasClick = async (id, key) => {
    const pt = await cardPoint(page, id);
    if (!pt) return false;
    const l0 = narrow ? await layoutMs() : 0;
    await page.evaluate(() => window.__budget.arm("pointerdown", "pointerup"));
    await page.mouse.click(pt.x, pt.y);
    push(key, await page.evaluate(() => window.__budget.wait()));
    if (narrow) push("selectLayout", (await layoutMs()) - l0);
    return true;
  };
  for (let k = 0, done = 0; done < SELECT_ROUNDS && k < 40; k++) {
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    await page.evaluate(() => window.__budget.frames());
    const alts = await visibleAlts(page);
    const id = alts[(k * 3 + 1) % Math.max(1, alts.length)];
    if (id && (await canvasClick(id, "select"))) done++;
  }

  await traceHeap(cdp, "選ぶの後");
  // これにする・見送る（詳細の「これにする」「見送る」）。その後に元に戻す（⌘Z / Ctrl+Z）
  const pickOnce = async (kind, key) => {
    const alts = await visibleAlts(page);
    const id = alts[Math.floor(Math.random() * alts.length)];
    if (!id) return false;
    await page.evaluate((nid) => window.__fourD.ui.select([nid]), id);
    if (narrow) await openRight();
    const btn = page.locator(`[data-fk="${kind}:${id}"]`);
    await btn.waitFor({ timeout: 10_000 });
    await page.evaluate(() => window.__budget.arm("pointerdown", "click"));
    await btn.click();
    push(key, await page.evaluate(() => window.__budget.wait()));
    if (narrow) await closePanels();
    // 概要へ戻る（キャンバスで Esc。選びを外すと、新しい結果の概要を作る: 見直し perf-6）
    await page.evaluate(() => window.__fourD.app.view.canvas.focus());
    await page.evaluate(() => window.__budget.frames());
    await page.evaluate(() => window.__budget.arm("keydown", "keydown"));
    await page.keyboard.press("Escape");
    push("deselect", await page.evaluate(() => window.__budget.wait()));
    // 元に戻す（キャンバスにフォーカスを置いて）
    await page.evaluate(() => window.__fourD.app.view.canvas.focus());
    await page.evaluate(() => window.__budget.arm("keydown", "keydown"));
    await page.keyboard.press("Control+z");
    push("undo", await page.evaluate(() => window.__budget.wait()));
    return true;
  };
  for (let k = 0; k < ROUNDS; k++) await pickOnce("pick", "pick");
  for (let k = 0; k < ROUNDS; k++) await pickOnce("drop", "drop");

  await traceHeap(cdp, "これにする・見送るの後");
  // 1 つ開く・閉じる（C）: 見えている閉じたカードを選んで
  for (let k = 0; k < ROUNDS; k++) {
    const id = await page.evaluate((kk) => {
      const f = window.__fourD;
      const vm = f.app.vm;
      vm.ensure();
      const list = vm.drawNodes.filter((x) => vm.inImpact(x) && vm.isCollapsed(x));
      return list[(kk * 5 + 2) % Math.max(1, list.length)] ?? null;
    }, k);
    if (!id) break;
    await page.evaluate((nid) => (window.__fourD.ui.select([nid]), window.__fourD.app.view.canvas.focus()), id);
    await page.evaluate(() => window.__budget.frames());
    await page.evaluate(() => window.__budget.arm("keydown", "keydown"));
    await page.keyboard.press("c");
    push("open", await page.evaluate(() => window.__budget.wait()));
    await page.evaluate(() => window.__budget.arm("keydown", "keydown"));
    await page.keyboard.press("c");
    push("close", await page.evaluate(() => window.__budget.wait()));
  }

  await traceHeap(cdp, "開く・閉じるの後");
  // カードへ寄る: 検索の候補から、隠れている深いカードを押す（上流を開いて寄る）
  for (let k = 0; k < ROUNDS; k++) {
    const term = await page.evaluate((kk) => {
      const f = window.__fourD;
      const imp = f.app.vm.impact;
      const end = imp.ends[40 + kk * 17];
      return end ? f.store.doc.nodes[end.id].title : null;
    }, k);
    if (!term) break;
    if (narrow) await closePanels();
    await page.locator(".search-input").fill(term);
    const row = page.locator(".search-row").filter({ has: page.locator(".search-hidden") }).first();
    try {
      await row.waitFor({ timeout: 10_000 });
    } catch {
      continue;
    }
    await page.evaluate(() => window.__budget.arm("pointerdown", "click"));
    await row.click();
    push("jump", await page.evaluate(() => window.__budget.wait()));
    await page.locator(".search-input").fill("");
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window.__fourD.app.vm.resetImpactOpen(), window.__fourD.ui.clearSelection()));
  }

  await traceHeap(cdp, "寄るの後");
  // 1 年先まで開く: 今日を選んで、詳細の「1 年先まで（N 枚）」を押す（開いた後に詳細の枚数も作り直す。3,000 枚まで）
  for (let k = 0; k < ROUNDS; k++) {
    await page.evaluate(() => {
      const f = window.__fourD;
      f.app.vm.resetImpactOpen();
      f.ui.select([f.app.vm.impactRoots()[0]]);
    });
    if (narrow) await openRight();
    // 隠して取っておいた概要にも今日の手ごとのボタンがある（P4）。出している詳細の物を押す
    const btn = page.locator(".sidebar-right .deep-open-moves button:visible").nth(k % 3);
    await btn.waitFor({ timeout: 10_000 });
    await page.evaluate(() => window.__budget.frames());
    await page.evaluate(() => window.__budget.arm("pointerdown", "click"));
    await btn.click();
    push("yearOpen", await page.evaluate(() => window.__budget.wait()));
    r.yearCards = await page.evaluate(() => (window.__fourD.app.vm.ensure(), window.__fourD.app.vm.drawNodes.length));
    await page.evaluate(() => (window.__fourD.app.vm.resetImpactOpen(), window.__fourD.ui.clearSelection()));
    if (narrow) await closePanels();
    await page.evaluate(() => window.__budget.frames());
  }

  await traceHeap(cdp, "1 年先までの後");
  // 地図の中の形の編集: 見えている状態のカードを選んで Tab（子を足す）→ 書き始めをやめて元に戻す。
  // 狭い画面の最初の形は今日だけなので、今日の手を 2 つ開いておく（測らない）
  await page.evaluate(() => {
    const f = window.__fourD;
    const vm = f.app.vm;
    const root = vm.impactRoots()[0];
    const kids = (vm.index.out.get(root) ?? []).map((e) => f.store.doc.edges[e].target);
    vm.setImpactOpen([root, ...kids.slice(0, 2)]);
  });
  for (let k = 0; k < ROUNDS; k++) {
    const id = await page.evaluate((kk) => {
      const f = window.__fourD;
      const vm = f.app.vm;
      vm.ensure();
      const list = vm.drawNodes.filter((x) => vm.inImpact(x) && f.store.doc.nodes[x].meta.fork === "decision" && x !== vm.impactRoots()[0]);
      return list[(kk * 7 + 3) % Math.max(1, list.length)] ?? null;
    }, k);
    if (!id) break;
    await page.evaluate((nid) => (window.__fourD.ui.select([nid]), window.__fourD.app.view.canvas.focus()), id);
    await page.evaluate(() => window.__budget.frames());
    await page.evaluate(() => window.__budget.arm("keydown", "keydown"));
    await page.keyboard.press("Tab");
    push("structural", await page.evaluate(() => window.__budget.wait()));
    // 書き始めた欄をやめて、キャンバスから元に戻す
    await page.keyboard.press("Escape");
    await page.evaluate(() => (document.activeElement?.blur?.(), window.__fourD.app.view.canvas.focus()));
    await page.evaluate(() => window.__budget.arm("keydown", "keydown"));
    await page.keyboard.press("Control+z");
    push("structuralUndo", await page.evaluate(() => window.__budget.wait()));
    await page.evaluate(() => window.__fourD.ui.clearSelection());
  }

  await traceHeap(cdp, "形の編集の後");
  // シナリオを変える・外す（下の切替）
  for (let k = 0; k < ROUNDS; k++) {
    const chips = page.locator(".scen-chip");
    if ((await chips.count()) < 2 || !(await chips.nth(1).isVisible())) break;
    await page.evaluate(() => window.__budget.arm("pointerdown", "click"));
    await chips.nth(1 + (k % Math.max(1, (await chips.count()) - 1))).click();
    push("scenario", await page.evaluate(() => window.__budget.wait()));
    await page.evaluate(() => window.__budget.arm("pointerdown", "click"));
    await chips.nth(0).click();
    push("scenarioOff", await page.evaluate(() => window.__budget.wait()));
  }

  await traceHeap(cdp, "シナリオの後");
  // 年収を変える（概要の「変える」→ 入れて「決める」）
  for (let k = 0; k < ROUNDS; k++) {
    await page.evaluate(() => window.__fourD.ui.clearSelection());
    if (narrow) await openRight();
    const change = page.locator('[data-fk="salary"]');
    try {
      await change.waitFor({ timeout: 10_000 });
    } catch {
      break;
    }
    await change.click();
    await page.locator(".imp-salary-input").fill(String(400 + k * 40));
    await page.evaluate(() => window.__budget.arm("pointerdown", "click"));
    await page.locator('[data-fk="salary-ok"]').click();
    push("salary", await page.evaluate(() => window.__budget.wait()));
    if (narrow) await closePanels();
    await page.evaluate(() => window.__fourD.app.cmd.undo());
  }

  await traceHeap(cdp, "年収の後");
  // （参考・予算なし）取り込みの写しが structuredClone（どのカードも別の物）。どの取り込みの道（アカウント・ほかのタブ・インポート・復元）も
  // 薄い形を読み直すので、この形は作らない（作業メモ SPEC §7.2・P4）。届いた写しは測る前に作る（手を 1 つ選んだ写し）。測った後は元に戻す
  for (let k = 0; k < ROUNDS; k++) {
    await page.evaluate((kk) => {
      const f = window.__fourD;
      const imp = f.app.vm.impact;
      const alts = imp.decision.get(imp.root).alts;
      const copy = structuredClone(f.store.doc);
      const id = alts[(kk * 3 + 2) % alts.length];
      copy.nodes[id].status = "active";
      window.__adoptCopy = copy;
    }, k);
    await page.evaluate(() => window.__budget.frames());
    push("adoptClone", await page.evaluate(() => window.__budget.time(() => window.__fourD.store.replaceDoc(window.__adoptCopy, "別の端末の内容を読み込む"))));
    await page.evaluate(() => {
      window.__adoptCopy = null;
      window.__fourD.store.undo();
    });
    await page.evaluate(() => window.__budget.frames());
  }

  // 取り込み（§7.2 の行。届いた写しを薄い形で書いて読み直した物。本当の同期と同じく、変えていないカードは地図の基準と同じ物: W-app の I4）
  for (let k = 0; k < ROUNDS; k++) {
    const ok = await page.evaluate((kk) => {
      const f = window.__fourD;
      if (!f.codec) return false;
      const imp = f.app.vm.impact;
      const alts = imp.decision.get(imp.root).alts;
      const id = alts[(kk * 3 + 4) % alts.length];
      const raw = JSON.parse(JSON.stringify(f.codec.toStored(f.store.doc)));
      const copy = f.codec.decodeStored(raw);
      copy.nodes[id] = { ...copy.nodes[id], status: "active" };
      window.__adoptCopy = copy;
      return true;
    }, k);
    if (!ok) break;
    await page.evaluate(() => window.__budget.frames());
    push("adopt", await page.evaluate(() => window.__budget.time(() => window.__fourD.store.replaceDoc(window.__adoptCopy, "別の端末の内容を読み込む"))));
    await page.evaluate(() => {
      window.__adoptCopy = null;
      window.__fourD.store.undo();
    });
    await page.evaluate(() => window.__budget.frames());
  }
  // 自動保存の書き出し（これにした後の文書を薄い形にする。保存先に書く時間は数えない: W-app の I6）
  for (let k = 0; k < ROUNDS; k++) {
    const ms = await page.evaluate(async (kk) => {
      const f = window.__fourD;
      if (!f.codec) return NaN;
      const imp = f.app.vm.impact;
      const alts = imp.decision.get(imp.root).alts;
      f.app.cmd.updateNode(alts[(kk * 5 + 1) % alts.length], { status: "active" }, { label: "これにする" });
      await window.__budget.frames();
      await new Promise((r) => setTimeout(r, Math.random() * 16));
      const t0 = performance.now();
      f.codec.toStored(f.store.doc);
      const dt = performance.now() - t0;
      f.store.undo();
      await window.__budget.frames();
      return dt;
    }, k);
    push("autosave", ms);
  }

  await traceHeap(cdp, "取り込みの後");
  // 変更の後 3 秒の長い仕事（空いた時間の計算が 1 つずつ短く分かれているか: 見直し perf-8）: シナリオ・年収・これにする
  const longAfter = async (fn) => {
    await page.evaluate(() => (window.__long = window.__budget.watchLong()));
    await fn();
    // 変更を受けて描いたフレームの後から数える（変更そのものの時間は、その行の予算で見る）
    await page.evaluate(async () => {
      await window.__budget.afterFrame();
      window.__long.mark();
    });
    await page.waitForTimeout(3000);
    const list = await page.evaluate(() => window.__long.stop());
    push("longTask", list.length ? Math.max(...list) : 0);
    (r.longTaskCounts ??= []).push(list.length);
  };
  {
    const chips = page.locator(".scen-chip");
    if ((await chips.count()) >= 2 && (await chips.nth(1).isVisible())) {
      await longAfter(() => chips.nth(1).click());
      await chips.nth(0).click();
      await page.waitForTimeout(1500);
    }
    await longAfter(() =>
      page.evaluate(() => {
        const f = window.__fourD;
        const root = f.store.doc.nodes[f.app.vm.impact.root];
        f.store.transact("年収", (tx) => tx.updateNode(root.id, { meta: { ...root.meta, impact: { ...root.meta.impact, annual: 480 } } }));
      }),
    );
    await page.evaluate(() => window.__fourD.store.undo());
    await page.waitForTimeout(1500);
    await longAfter(() =>
      page.evaluate(() => {
        const f = window.__fourD;
        const imp = f.app.vm.impact;
        f.app.cmd.setStatus([imp.decision.get(imp.root).alts[1]], "active");
      }),
    );
    await page.evaluate(() => window.__fourD.store.undo());
    await page.waitForTimeout(1500);
  }

  await traceHeap(cdp, "長い仕事の後");
  // 題名の 1 文字（変換中を含む。詳細の題名の欄）
  for (let k = 0; k < ROUNDS; k++) {
    const alts = await visibleAlts(page);
    const id = alts[k % Math.max(1, alts.length)];
    if (!id) break;
    await page.evaluate((nid) => window.__fourD.ui.select([nid]), id);
    if (narrow) await openRight();
    const ta = page.locator(".insp-title");
    await ta.waitFor({ timeout: 10_000 });
    const times = await page.evaluate(async () => {
      const el = document.querySelector(".insp-title");
      const base = el.value;
      return window.__budget.ime(el, [`${base}て`, `${base}てん`, `${base}てんし`, `${base}てんしょ`, `${base}てんしょく`], `${base}転職`);
    });
    for (const x of times) push("keystroke", x);
    await page.evaluate(() => document.activeElement?.blur());
    if (narrow) await closePanels();
  }

  await traceHeap(cdp, "題名の後");
  // 検索の 1 文字（変換中を含む）
  for (let k = 0; k < ROUNDS; k++) {
    const times = await page.evaluate(async (kk) => {
      const el = document.querySelector(".search-input");
      const r1 = await window.__budget.ime(el, ["て", "てん", "てんし", "てんしょ", "てんしょく"], kk % 2 ? "転職" : "転職活動");
      el.value = "";
      el.dispatchEvent(new InputEvent("input", { data: "", inputType: "deleteContentBackward", bubbles: true }));
      el.blur();
      return r1;
    }, k);
    for (const x of times) push("search", x);
  }

  await traceHeap(cdp, "検索の後");
  // 使った後のヒープ: 10 回これにする（命令で）・1 年先まで開いたまま（今日の詳細の「1 年先まで」）・検索 1 回
  await page.evaluate(async () => {
    const f = window.__fourD;
    const vm = f.app.vm;
    vm.ensure();
    const alts = vm.impact.decision.get(vm.impact.root).alts;
    for (let i = 0; i < 10; i++) {
      f.app.cmd.setStatus([alts[i % alts.length]], i % 2 ? "dropped" : "active");
      void vm.impact.vRoot;
      await window.__budget.frames();
    }
    vm.resetImpactOpen();
    f.ui.select([vm.impactRoots()[0]]);
  });
  if (narrow) await openRight();
  {
    const btn = page.locator(".sidebar-right .deep-open-moves button:visible").first();
    await btn.waitFor({ timeout: 10_000 });
    await btn.click();
    await page.evaluate(() => window.__budget.frames());
    r.heapOpenCards = await page.evaluate(() => (window.__fourD.app.vm.ensure(), window.__fourD.app.vm.drawNodes.length));
  }
  await page.evaluate(async () => {
    const f = window.__fourD;
    f.ui.clearSelection();
    f.ui.setSearch("転職");
    f.app.vm.ensure();
    await window.__budget.frames();
  });
  push("heapUse", await heapMB(cdp, r.heapParts));
  // 手のカードを 50 枚見る（違う判断の手。詳細のパネルを開いて: 見直し perf-2）
  if (narrow) await openRight();
  r.browsed = await page.evaluate(async () => {
    const f = window.__fourD;
    const imp = f.app.vm.impact;
    const seen = new Set();
    const pick = [];
    for (const id of imp.altIds()) {
      const a = imp.alt.get(id);
      if (!a || seen.has(a.decision) || a.isBase) continue;
      seen.add(a.decision);
      pick.push(id);
      if (pick.length >= 400) break;
    }
    const step = Math.max(1, Math.floor(pick.length / 50));
    let n = 0;
    for (let i = 0; i < pick.length && n < 50; i += step, n++) {
      f.ui.select([pick[i]]);
      await window.__budget.frames();
    }
    f.ui.clearSelection();
    await window.__budget.frames();
    return n;
  });
  push("heapBrowse", await heapMB(cdp, r.heapParts));
  r.errors = s.errors.slice(0, 5);
  await s.ctx.close();
  return r;
}

/** 予算の表。予算は一番良い値と中くらいの値の両方で見る（どちらかが超えたら ✗）。fails に超えた行 */
function table(results, fails) {
  const profiles = Object.keys(results);
  const lines = [];
  lines.push(`| 操作 | ${profiles.map((p) => `${p}（一番良い / 中くらい）| 予算`).join(" | ")} |`);
  lines.push(`|---|${profiles.map(() => "---|---").join("|")}|`);
  for (const k of Object.keys(LABEL)) {
    const cells = profiles.map((p) => {
      const xs = results[p][k] ?? [];
      const i = results[p].profileIndex ?? 0;
      const b = BUDGET[k]?.[i] ?? null;
      if (!xs.length) return `— | ${b ?? "—"}`;
      const v = best(xs);
      const m = median(xs);
      const ok = b === null ? "" : v <= b && m <= b ? " ✓" : v <= b ? " ✗（中くらい）" : " ✗";
      if (b !== null && (v > b || m > b)) fails.push(`${p}: ${LABEL[k]} ${v.toFixed(0)} / ${m.toFixed(0)}（予算 ${b}）`);
      return `${v.toFixed(k.startsWith("heap") ? 1 : 0)} / ${m.toFixed(k.startsWith("heap") ? 1 : 0)}${ok} | ${b ?? "—"}`;
    });
    lines.push(`| ${LABEL[k]} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

async function main() {
  build();
  await startServer();
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ["--enable-precise-memory-info"] });
  const results = {};
  try {
    const profiles = [
      { name: "机", key: "desktop", viewport: { width: 1440, height: 900 }, dpr: 1, cpu: 1 },
      { name: "スマホ", key: "phone", viewport: { width: 390, height: 844 }, dpr: 2, cpu: 4 },
    ].filter((p) => !ONLY || p.key === ONLY);
    for (const p of profiles) {
      results[p.name] = await measureProfile(browser, p);
      results[p.name].profileIndex = p.key === "phone" ? 1 : 0;
    }
  } finally {
    await browser.close();
    server?.kill();
  }
  const load = os.loadavg().map((x) => x.toFixed(2)).join(" ");
  console.log(`\n予算の表（ms。ヒープは MB。${ROUNDS} 回（カードを選ぶは ${SELECT_ROUNDS} 回）のうち一番良い値 / 中くらいの値。測ったときの負荷 ${load}）\n`);
  const fails = [];
  console.log(table(results, fails));
  for (const [p, r] of Object.entries(results)) {
    if (r.yearCards) console.log(`${p}: 1 年先まで開いたときに見えるカード ${r.yearCards} 枚（ヒープを測ったときは ${r.heapOpenCards ?? "—"} 枚）`);
    if (r.heapPartsBoot?.length) console.log(`${p}: 起動後（落ち着いた後）のヒープの内訳（MB: JS / ArrayBuffer など / DOM）${r.heapPartsBoot.map((x) => `${x.used.toFixed(1)} / ${x.backing.toFixed(1)} / ${x.embedder.toFixed(1)}`).join("・")}`);
    if (r.heapParts?.length) console.log(`${p}: ヒープの内訳（MB: JS / ArrayBuffer など / DOM）${r.heapParts.map((x) => `${x.used.toFixed(1)} / ${x.backing.toFixed(1)} / ${x.embedder.toFixed(1)}`).join(" → ")}`);
    if (r.longTaskCounts) console.log(`${p}: 変更の後 3 秒の長い仕事の数 ${r.longTaskCounts.join(" / ")}（シナリオ・年収・これにする）`);
    if (r.bootLongTasks) console.log(`${p}: 起動して触れた後の長い仕事（触れてからの ms・長さ）${r.bootLongTasks.map((l) => (l.length ? l.map(([a, d]) => `${a}:${d}`).join(" ") : "無し")).join(" / ")}`);
    if (r.errors?.length) console.log(`${p}: ページのエラー ${r.errors.join(" / ")}`);
  }
  if (process.env.BUDGET_OUT) fs.writeFileSync(process.env.BUDGET_OUT, JSON.stringify({ load, results, fails }, null, 2));
  if (fails.length) {
    console.log(`\n予算を超えた行（${fails.length}）:\n${fails.map((x) => `  ✗ ${x}`).join("\n")}`);
    if (process.env.BUDGET_REPORT_ONLY !== "1") process.exitCode = 1;
  } else console.log("\nどの行も予算の内");
  for (const [p, r] of Object.entries(results)) if (r.errors?.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  server?.kill();
  process.exit(1);
});
