// 旧タブの証明: 直前の本番のコードを開いたままのタブから、A の記録が B へ 1 件も送られないことを、本物の旧いコードと本物の認証の部品で確かめる。
//
//   node tests/oldtab/run.mjs --old <dir|git ref> [--new <dir>] [--sw both|on|off | --no-sw] [--login both|logout|link|none] [--order normal|direct-link]
//                             [--release migrated|login] [--old-auth-lib <版|ファイル>] [--expect-writeback]
//                             [--old-confirm accept|dismiss] [--mutant <名前>] [--expect-leak] [--out <dir>] [--ttl 秒] [--wait-refresh 秒] [--freeze off]
//
//   --old   直前の本番の木（置き場か git の ref）。必ず渡す。分離の前の最後の本番 0507672（CI もこれに固定）。
//           分離の入った木（js/areaGuard.js がある）は渡せない: 旧いタブが切り替えの画面を通って B として動いてよい木なので、この 5 段の決まりが合わない
//           （止まって終わりの値 2。分離の後の本番を旧い側にする 5 段は別に作る）
//   --new   新しい木（置き場か git の ref。既定はこの検査が入っている木。ほかの worktree も渡せる）
//   --sw    Service Worker を許す（on）・止める（off）・両方（既定）
//   --login B へのログインの仕方。logout = 新しいタブで A をログアウトしてから B の欄でリンクを頼む・link = A のまま B のリンクを開く・both（既定）・
//           none = B にログインしない（止めていた更新の書き戻しの後に旧いタブを戻し、A の記録が後ろへ戻らないかを見る。--old-auth-lib の古い版と使う）
//   --order normal（既定）・direct-link = 新しいコードの最初の読み込みが B のリンク（/ を先に開かない。旧いタブしか開いていない端末で B のメールのリンクを開く）。login は link
//   --release migrated（既定。見えたままの旧いタブの止めていた更新を移行の後に通す）・login（B のセッションが動いて落ち着いた後に通す。切り替えの時の
//           片付けがすんだ後に、古い部品が旧い鍵へ書き戻す形。--login none では migrated と同じ）
//   --old-confirm  旧いタブに確認の窓が出たときの答え（既定 accept: 漏れがいちばん起きやすい側）
//   --mutant 新しい木の写しに変異を当てる（lib/mutants.mjs の一覧: mirror-session・person-key-as-device など。検査が落ちることを見る）
//   --expect-leak  変異の確かめ用: どの回も LEAK のときだけ exit 0（途中で落ちた回は数えない）
//   --freeze off   old-frozen を凍らせない（比べるための回）
//   --old-auth-lib <版|ファイル>  旧いタブ（配信の前に開いたタブ）にだけ、別の版の認証の部品を読ませる（本番の旧いタブが持ちうる古い @2。短く --oldlib）。
//                  版（2.105.0 など）なら lib/authLib.mjs が登録所から取って作る（固定の版 2.105.0 は固定の値で確かめる。置き場にあればそれを確かめて使う）。
//                  ファイルなら、その写しをそのまま読ませる
//   --expect-writeback  古い部品の回の確かめ: 止めていた更新を通した後に、旧いタブの部品が A のセッションを旧い鍵へ書き戻したこと（書き込みの知らせ）を
//                  5 段の確かめに足す（書き戻しが起きなければ INVALID。書き戻しの道を通らずに PASS と言わない）
//   --no-return    A へ戻る段（6 段。orphans のある木だけ）を流さない（前の 5 段だけの回と比べるため。CI では使わない）
//   --import-state report|keep|<ファイル>  A へ戻った後の、旧いタブで答えた語の 3 状態の決まり（取り込みの仕様しだい。統合担当が決める）。
//                  report（既定）= 値を出すだけ・keep = A の初めの状態のまま（A に無かった語は これから）・ファイル = 既定の export の関数
//                  ({ id, prior, after, need, written, pub }) => 0（これから）|1（あやふや）|2（覚えた）|null（見ない）
// 終わりの値（lib/analyze.mjs exitCodeOf）: 0 = 漏れなし（どの回も 5 段を通った）・1 = 漏れか A の記録の後退あり・
//           2 = 5 段（と戻る段）を通れなかった回がある（漏れなしとは言えない。処理されない失敗〔unhandledRejection など〕で止まったときも 2。
//           それまでの記録を書く）・4 = A へ戻った時に旧いタブの学習が 2 度入った（DOUBLE）回がある・
//           3 = 漏れも後退も無く、どの回も段を通ったが、A へ戻った時に旧いタブの学習が入っていない（NOT_IMPORTED）回がある。
//           1 > 2 > 4 > 3 の順に強い（3 は NOT_IMPORTED だけ。CI のジョブ oldtab は取り込みが入るまで 3 だけを注意にして通す）
// 判定: LEAK（漏れを見つけた。旧いタブの語が B かゲストの領域に入ったのも）・LOSS（漏れは無いが A の記録が後ろへ戻った）・
//       DOUBLE・NOT_IMPORTED（orphans のある木の A へ戻る段。上の 3）・PASS（どれも無く全部の段を通った）・
//       INVALID（段を通れなかった。途中で落ちた回は見つけていても INVALID）
// ブラウザは CHROME_PATH（無ければブラウザの置き場から探す）。ほかの E2E と同時に流さない（ローカルは flock で順番を取る）。
// 認証の部品（両方の木が読む 2.118.0）は lib/authLib.mjs が登録所から取って作り、置き場（tests/oldtab/.cache/auth-lib）に置く。2 回目からは置き場の写しを確かめて使う。
// 記録: --out の下に回ごとの JSON（全部の要求・表の最後の中身・見つけた漏れ・時刻の流れ）と summary.json。
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { chromium } from "playwright-core";
import { prepareOldTree, describeTree, cacheDir } from "./lib/trees.mjs";
import { runScenario } from "./lib/scenario.mjs";
import { analyze, verdictOf, exitCodeOf } from "./lib/analyze.mjs";
import { applyMutant, MUTANTS } from "./lib/mutants.mjs";
import { VERSION as SB_VERSION, ensureAuthLib, isVersion } from "./lib/authLib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function parseArgs(argv) {
  const o = { sw: "both", login: "both", order: "normal", release: "migrated", oldConfirm: "accept", newConfirm: "accept", ttl: 100, waitRefresh: 40, expectLeak: false, freeze: true, returnToA: true, importState: "report" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--old") o.old = next();
    else if (a === "--new") o.new = next();
    else if (a === "--sw") o.sw = next();
    else if (a === "--no-sw") o.sw = "off";
    else if (a === "--login") o.login = next();
    else if (a === "--order") o.order = next();
    else if (a === "--release") o.release = next();
    else if (a === "--old-confirm") o.oldConfirm = next();
    else if (a === "--new-confirm") o.newConfirm = next();
    else if (a === "--mutant") o.mutant = next();
    else if (a === "--expect-leak") o.expectLeak = true;
    else if (a === "--expect-writeback") o.expectWriteBack = true;
    else if (a === "--out") o.out = next();
    else if (a === "--ttl") o.ttl = Number(next());
    else if (a === "--wait-refresh") o.waitRefresh = Number(next());
    else if (a === "--freeze") o.freeze = next() !== "off";
    else if (a === "--old-auth-lib" || a === "--oldlib") o.oldAuthLib = next();
    else if (a === "--no-return") o.returnToA = false;
    else if (a === "--import-state") o.importState = next();
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`知らない引数: ${a}`);
  }
  return o;
}

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", path.join(os.homedir(), ".cache", "ms-playwright")]) {
    if (!root || !fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("chromium-"))) {
      for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
        const p = path.join(root, dir, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined; // 既定の置き場に任せる
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.old) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(opts.help ? 0 : 2);
}

if (!["normal", "direct-link"].includes(opts.order)) throw new Error(`--order は normal か direct-link: ${opts.order}`);
if (!["migrated", "login"].includes(opts.release)) throw new Error(`--release は migrated か login: ${opts.release}`);
if (!["both", "logout", "link", "none"].includes(opts.login)) throw new Error(`--login は both・logout・link・none: ${opts.login}`);
// A へ戻った後の 3 状態の決まり（report・keep・関数のファイル）
let importState = opts.importState;
if (!["report", "keep"].includes(importState)) {
  const file = path.resolve(importState);
  if (!fs.existsSync(file)) throw new Error(`--import-state は report・keep か関数のファイル: ${importState}`);
  const mod = await import(pathToFileURL(file).href);
  importState = mod.default ?? mod.expectedState;
  if (typeof importState !== "function") throw new Error(`--import-state のファイルに既定の export の関数が無い: ${file}`);
}
const oldTree = prepareOldTree(opts.old, ROOT);
// 分離の入った木を旧い側にしない（旧いタブが /switch.html を通って新しい文書になり、B として動いてよい。この 5 段の決まりが合わない）
if (fs.existsSync(path.join(oldTree.root, "js", "areaGuard.js"))) {
  console.log(`旧い木 ${opts.old}（${oldTree.commit ?? oldTree.root}）は、もうアカウントの分離（js/areaGuard.js）が入った木。この 5 段は分離の前の本番（0507672）を旧い側にする物。`);
  console.log("分離の後の本番を旧い側にするなら、旧いタブが切り替えの後に B として動いてよい（A の行を送らないことだけを見る）別の 5 段が要る。止める（INVALID）。");
  process.exit(2);
}
// --new は置き場か git の ref（ref なら旧い木と同じく git archive で取り出す。作業中の worktree を流している途中に変えられないように）
let newRoot = path.resolve(opts.new ?? ROOT);
let newInfo;
if (opts.new && !fs.existsSync(newRoot)) {
  const t = prepareOldTree(opts.new, ROOT);
  newRoot = t.root;
  newInfo = { commit: t.commit, dirty: false };
} else newInfo = describeTree(newRoot);
let mutantInfo = null;
if (opts.mutant) {
  mutantInfo = applyMutant(opts.mutant, newRoot, path.join(cacheDir(), `mutant-${opts.mutant.replace(/,/g, "+")}-${process.pid}`));
  newRoot = mutantInfo.root;
}
const out = path.resolve(opts.out ?? path.join(cacheDir(), "logs"));
fs.mkdirSync(out, { recursive: true });

const swModes = opts.sw === "both" ? [true, false] : [opts.sw === "on"];
const logins = opts.order === "direct-link" ? ["link"] : opts.login === "both" ? ["logout", "link"] : [opts.login];
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
console.log(`旧い木: ${oldTree.root}（${oldTree.commit ?? "置き場"}）`);
console.log(`新しい木: ${newRoot}（${newInfo.commit ?? "?"}${newInfo.dirty ? "・作業中の変更あり" : ""}${mutantInfo ? `・変異 ${opts.mutant}` : ""}）`);
// 認証の部品: 登録所から取って作る（置き場にあれば確かめて使う）。--old-auth-lib は版かファイル
const authLib = await ensureAuthLib(SB_VERSION);
const VENDOR = authLib.file;
let oldAuthLib = null;
if (opts.oldAuthLib) {
  if (isVersion(opts.oldAuthLib)) oldAuthLib = await ensureAuthLib(opts.oldAuthLib);
  else {
    const file = path.resolve(opts.oldAuthLib);
    if (!fs.existsSync(file)) throw new Error(`--old-auth-lib のファイルが無い: ${file}`);
    oldAuthLib = { file, from: "file", pinned: false, integrity: null, bodySha: null };
  }
  oldAuthLib.version = fs.readFileSync(oldAuthLib.file, "utf8").slice(0, 200).match(/@supabase\/supabase-js (\d+\.\d+\.\d+)/)?.[1] ?? "?";
  opts.oldAuthLib = oldAuthLib.file;
}
const oldAuthLibVersion = oldAuthLib?.version ?? null;
const libNote = (l) => `${l.from === "cache" ? "置き場の写しを確かめた" : l.from === "registry" ? "登録所から作った" : "渡されたファイル"}${l.pinned ? "・固定の版" : ""}`;
console.log(`認証の部品 ${SB_VERSION}（${path.relative(ROOT, VENDOR)}・${libNote(authLib)}）${oldAuthLib ? `・旧いタブだけ ${oldAuthLibVersion}（${path.relative(ROOT, oldAuthLib.file)}・${libNote(oldAuthLib)}）` : ""}`);

const browser = await chromium.launch({
  executablePath: findBrowser(),
  // 本物のプロジェクトにもほかの外にも出ない: 名前の引きを 127.0.0.1 以外すべて失敗にし、代理も使わない（にせの受け口は名前を引く前に答える）
  args: ["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"]
});
const runs = [];
// 処理されない失敗（ブラウザ操作の窓の答えの取り違えなど）で止まるときは、それまでの記録を書いて INVALID（2）で終える（1 は漏れの意味なので使わない）
const live = { current: null };
let aborting = false;
function writeSummary() {
  const summary = { at: new Date().toISOString(), old: opts.old, oldCommit: oldTree.commit, newRoot, newCommit: newInfo.commit, mutant: opts.mutant ?? null, order: opts.order, expectLeak: opts.expectLeak, runs };
  fs.writeFileSync(path.join(out, `${stamp}-${opts.mutant ? opts.mutant.replace(/,/g, "+") + "-" : ""}summary.json`), JSON.stringify(summary, null, 1));
}
function abort(kind, err) {
  if (aborting) return;
  aborting = true;
  const msg = `${kind}: ${String(err?.stack || err)}`;
  console.log(`\n処理されない失敗で止まった（INVALID）: ${msg.split("\n")[0]}`);
  try {
    const cur = live.current;
    if (cur?.result) {
      const result = cur.result;
      result.crash = msg;
      result.requests = cur.fake?.requests ?? result.requests ?? [];
      result.held = cur.fake?.held ?? result.held;
      if (cur.fake?.tables) result.tables = Object.fromEntries([...cur.fake.tables].map(([t, rows]) => [t, rows]));
      result.served = cur.srv?.served ?? result.served;
      result.reloadBlocked = cur.srv?.blocked ?? result.reloadBlocked;
      let report = null;
      try {
        report = analyze(result, { importState });
      } catch (e) {
        console.log(`   判定もできなかった: ${String(e).split("\n")[0]}`);
      }
      const file = path.join(out, `${cur.name}.json`);
      fs.writeFileSync(file, JSON.stringify({ name: cur.name, verdict: "INVALID", aborted: kind, report, result }, null, 1));
      runs.push({ name: cur.name, verdict: "INVALID", file, aborted: kind, findings: report ? report.leaks.length + report.reverse.length + report.stored.length + report.structural.length + report.integrity.length + (report.areaLeaks ?? []).length : null, crash: msg });
      console.log(`   それまでの記録: ${file}`);
    }
    writeSummary();
  } catch (e) {
    console.log(`   記録を書けなかった: ${String(e).split("\n")[0]}`);
  }
  process.exit(2);
}
process.on("unhandledRejection", (e) => abort("unhandledRejection", e));
process.on("uncaughtException", (e) => abort("uncaughtException", e));
try {
  for (const sw of swModes) {
    for (const login of logins) {
      const name = `${stamp}-${opts.mutant ? opts.mutant.replace(/,/g, "+") + "-" : ""}${oldAuthLibVersion ? `oldlib${oldAuthLibVersion}-` : ""}${opts.order === "direct-link" ? "direct-" : ""}${opts.release === "login" ? "release-login-" : ""}sw-${sw ? "on" : "off"}-${login}`;
      console.log(`\n== ${name}`);
      const t0 = Date.now();
      live.current = { name };
      const result = await runScenario({ browser, oldRoot: oldTree.root, newRoot, vendorFile: VENDOR, oldVendorFile: opts.oldAuthLib ?? null, sw, login, order: opts.order, release: opts.release, expectWriteBack: !!opts.expectWriteBack, tokenTtl: opts.ttl, waitRefreshMs: opts.waitRefresh * 1000, oldConfirm: opts.oldConfirm, newConfirm: opts.newConfirm, freeze: opts.freeze, returnToA: opts.returnToA, live: live.current });
      live.current = null;
      const report = analyze(result, { importState });
      const verdict = verdictOf(report, result);
      const file = path.join(out, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify({ name, verdict, seconds: Math.round((Date.now() - t0) / 1000), config: { old: opts.old, oldCommit: oldTree.commit, oldRoot: oldTree.root, newRoot, newCommit: newInfo.commit, newDirty: newInfo.dirty, mutant: opts.mutant ?? null, mutantNote: mutantInfo?.note ?? null, sw, login, order: opts.order, release: opts.release, expectWriteBack: !!opts.expectWriteBack, returnToA: opts.returnToA, importState: typeof importState === "function" ? opts.importState : importState, oldConfirm: opts.oldConfirm, newConfirm: opts.newConfirm, ttl: opts.ttl, supabaseJs: SB_VERSION, oldTabsSupabaseJs: oldAuthLibVersion ?? SB_VERSION, authLib: { file: VENDOR, from: authLib.from, integrity: authLib.integrity, bodySha256: authLib.bodySha }, oldAuthLib: oldAuthLib ? { file: oldAuthLib.file, from: oldAuthLib.from, integrity: oldAuthLib.integrity, bodySha256: oldAuthLib.bodySha } : null }, report, result }, null, 1));
      const findings = report.leaks.length + report.reverse.length + report.stored.length + report.structural.length + report.integrity.length + report.areaLeaks.length;
      runs.push({ name, verdict, file, findings, ...report.summary, validity: report.validity, crash: result.crash ?? null });
      console.log(`→ ${verdict}: A→B ${report.leaks.length} 件・B→A ${report.reverse.length} 件・表に残った ${report.stored.length} 件・旧いコードのタブが B として動いた ${report.structural.length} 件・A の記録の後退 ${report.integrity.length} 件（旧いコードのタブ ${report.summary.integrityOldCode}）・B の名前の書き込み ${report.summary.writesAsB} 件${report.imports ? `・旧いタブの語が B かゲストの領域に ${report.areaLeaks.length} 件・A への取り込みが足りない ${report.imports.missing.length} 件・2 度 ${report.imports.double.length} 件` : ""}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
      if (result.crash) console.log(`   途中で落ちた（INVALID）: ${result.crash.split("\n")[0]}`);
      for (const [k, v] of Object.entries(report.validity)) if (!v) console.log(`   通れなかった: ${k}`);
      for (const k of report.summary.notExercised) console.log(`   試していない: ${k}`);
      if (report.summary.longestServerGapSec >= 60) console.log(`   注意: 配信の後、サーバーへの要求が ${report.summary.longestServerGapSec} 秒止まった（新しい木の Service Worker が有効になるまで取得を待たせた疑い）`);
      for (const [t, f] of Object.entries(report.summary.oldTabs)) console.log(`   ${t}: ${f.stayedOld ? "旧いコードのまま" : "新しいコードになった"}（${f.why}）`);
      console.log(`   旧いコードのタブのトークンの更新（B のログインの後）: ${report.summary.oldRefresh.branch === "attempted" ? `試みた ${report.summary.oldRefresh.attempts.join(",")}` : report.summary.oldRefresh.branch === "no-session" ? `試みない（getSession ${JSON.stringify(report.summary.oldRefresh.getSession)}・旧い認証の鍵 ${report.summary.oldRefresh.oldKeyAfterLogin.join(",")}）` : "確かめられない"}`);
      if (report.summary.refreshRace) console.log(`   見えたままの旧いタブの更新（移行の後まで止めた）: ${JSON.stringify(report.summary.refreshRace)}`);
      if (report.summary.oldKeyEvents.length) console.log(`   旧い認証の鍵の書き込みの知らせ（配信の後）: ${report.summary.oldKeyEvents.join(" ")}`);
      for (const l of report.leaks.slice(0, 12)) console.log(`   A→B #${l.seq} ${l.phase} ${l.tab} ${l.method} ${l.table} as ${l.as} row ${l.rowUser} → ${l.status}${l.rejected ? "(rls)" : ""}: ${l.hits.join(" / ")}`);
      if (report.leaks.length > 12) console.log(`   …ほか ${report.leaks.length - 12} 件`);
      for (const l of report.reverse.slice(0, 6)) console.log(`   B→A #${l.seq} ${l.phase} ${l.tab} ${l.method} ${l.table} as ${l.as} → ${l.status}: ${l.hits.join(" / ")}`);
      for (const s of report.stored.slice(0, 6)) console.log(`   表 ${s.table} ${s.user} ${s.key}: ${s.hits.join(" / ")}`);
      for (const s of report.structural.slice(0, 8)) console.log(`   旧いコード #${s.seq ?? "-"} ${s.phase} ${s.tab} ${s.method ?? ""} ${s.path ?? ""} → ${s.status ?? ""}: ${s.hits.join(" / ")}`);
      if (report.structural.length > 8) console.log(`   …ほか ${report.structural.length - 8} 件`);
      for (const s of report.integrity.slice(0, 8)) console.log(`   A の後退 ${s.stored ? "表" : `#${s.seq} ${s.phase} ${s.tab}${s.oldCode ? "（旧いコード）" : ""}`} ${s.table} ${s.key}: ${s.hits.join(" / ")}`);
      if (report.integrity.length > 8) console.log(`   …ほか ${report.integrity.length - 8} 件`);
      for (const [t, a] of Object.entries(report.summary.answeredBy)) console.log(`   旧い画面の答え ${t}: ${a.stillOld ? "旧いコード" : "新しいコードになった（この確かめに数えない）"}・答え ${a.ok}・${a.mode === "tap" ? `タブの中の書き込みの記録で見た（語の記録へ ${a.wordWrites} 回）` : "書き込みの記録が無いので端末の変化で見た"}・${a.pass ? "通った" : "通らない"}${(a.perAnswer ?? []).length ? `・答えごと ${a.perAnswer.map((x) => `${x.en}:${x.answered ? "答えた語" : x.next ? "次の語" : "無い"}(${x.ids.join("|") || "-"})`).join(" ")}` : ""}・端末の変化 ${(a.changed ?? []).join(",") || "なし"}${a.reasons.length ? `・答えられない ${a.reasons.join(",")}` : ""}`);
      const o = report.summary.orphans;
      if (o) console.log(`   orphans: ${o.treeHasOrphans ? `木にある・旧いコードのタブが 4 段より後に語の記録へ書いた ${o.oldWordWrites} 回のうち値が届いた ${o.writesFound}・最後の書き込み ${JSON.stringify(o.lastWriteFound)}・語 ${o.wordsFound.length}/${o.wordsWritten.length}${o.wordsMissing.length ? `（届かない ${o.wordsMissing.join(",")}）` : ""}・読み ${o.reads.map((r) => `${r.label}:${r.error ? `誤り ${r.error}` : r.storeExists ? `${r.records} 件` : r.dbExists === false ? "DB が無い" : "置き場が無い"}`).join(" ")}` : "木に無い"}・最後に localStorage に残った語の記録 ${o.localKeptAtEnd === null ? "?" : o.localKeptAtEnd ? "あり" : "なし"}`);
      const im = report.imports;
      if (im) {
        const fmtW = (w) => (w ? `${w.playCount ?? "-"}/${w.correctCount ?? "-"}/${w.recallFail ?? "-"}${w.ls ? `・状態 ${w.ls}` : ""}` : "無い");
        console.log(`   A へ戻る段（${im.mode}・3 状態の決まり ${im.rule}）: 数えた答えの書き込み ${im.counted.writes} 回（語 ${im.counted.words.join(",") || "なし"}）・配信の後の旧いコードの語の記録の書き込み ${im.allowedWrites} 回・A の初めの値 ${im.priorFrom ?? "読めない"}・戻った後 ${im.after1From ?? "読めない"}/${im.after2From ?? "読めない"}${im.error ? `・止まった ${im.error.split("\n")[0]}` : ""}${im.asked ? `・「移す？」が ${im.asked} 回出た` : ""}`);
        for (const [id, w] of Object.entries(im.perWord)) console.log(`   取り込み ${id}${w.counted ? "" : "（数えた答えの外）"}${w.pub === false ? "（公開の語でない）" : ""}: 回数（遊んだ/正解/思い出せず）A の初め ${fmtW(w.prior)} + 旧いタブ ${w.need.playCount}/${w.need.correctCount}/${w.need.recallFail} → 1 回目 ${fmtW(w.after1)}・2 回目 ${fmtW(w.after2)}・3 状態 ${w.state.prior}→${w.state.after1}→${w.state.after2}${w.state.expected !== undefined && w.state.expected !== null ? `（決まり ${w.state.expected}）` : ""}・送信待ち ${w.pending.dirtySeen ? "印あり" : "印なし"}${w.pending.sent ? "・送った" : ""}・A のクラウド ${w.cloud.afterReturn ? `${w.cloud.afterReturn.play_count}/${w.cloud.afterReturn.correct_count}/${w.cloud.afterReturn.recall_fail}` : "行なし"}→終わり ${w.cloud.end ? `${w.cloud.end.play_count}/${w.cloud.end.correct_count}/${w.cloud.end.recall_fail}` : "行なし"}${w.problems1.length + w.problems2.length ? `・問題 ${[...w.problems1, ...w.problems2].map((x) => `${x.second ? "2 回目 " : ""}${x.kind === "double" ? "多い" : "足りない"} ${x.f}${x.replaced ? "（A の値を置き換えた）" : ""}`).join("・")}` : ""}${w.lateImport ? "・2 回目に入った" : ""}`);
        console.log(`   学習状況の画面: 1 回目 ${JSON.stringify(im.screen1.cards)}（記録から ${JSON.stringify(im.screen1.store)}・${im.screen1.same ? "同じ" : "違う"}）・2 回目 ${JSON.stringify(im.screen2.cards)}（記録から ${JSON.stringify(im.screen2.store)}・${im.screen2.same ? "同じ" : "違う"}）・見張りの知らせ ${im.watched} 件`);
        for (const l of report.areaLeaks.slice(0, 8)) console.log(`   B かゲストの領域 ${l.area} ${l.id}: ${l.where}`);
      }
      for (const r of report.summary.reloads) console.log(`   新しいコードの開き直し（${r.label}）: 文書 ${r.docs}・落ち着いた ${r.settled}・/switch.html ${r.switchLoaded ?? "（無い木）"}・最後 ${r.finalUrl}・旧い場所の鍵 ${JSON.stringify(r.rawBefore)} → ${JSON.stringify(r.rawAfter)}${r.error ? `・誤り ${r.error}` : ""}`);
      console.log(`   旧いコードのタブの要求（B のログインの後）: ${JSON.stringify(report.summary.oldTabRequestsAfterLogin)}・更新 ${JSON.stringify(report.summary.oldTabRefreshAfterLogin)}`);
      console.log(`   記録: ${file}`);
    }
  }
} finally {
  await browser.close();
}
writeSummary();
// 途中で落ちて INVALID の回でも、見つけた漏れ・後退があれば 1
console.log(`\n${runs.map((r) => `${r.verdict} ${r.name}`).join("\n")}`);
const code = exitCodeOf(runs, { expectLeak: opts.expectLeak });
if (opts.expectLeak) console.log(code === 0 ? "変異: どの回も漏れを見つけた（検査は落ちることができる）" : "変異なのに漏れを見つけない回か、途中で落ちた回がある（検査が甘いか、確かめになっていない）");
process.exit(code);
