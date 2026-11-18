// 認証の部品を自分の配信から出す（Batch 97。api/auth-module.js・api/_lib/authModule.js・js/supabase.js の読み先。docs/SECURITY.md の Batch 97 の節）の単体:
//   A. 作り方（偽の登録所: この検査がメモリの中で作った tarball。固定の値は検査が渡す）: 正しい tarball だけから答えを作る・sha512／束の sha256／答えの sha256／
//      包みの名前と版／束の形／LICENSE のどれが違っても作らない・5 秒で打ち切る・https だけ・2 MB まで
//   B. 配信の関数（偽の作り手）: 決まった 1 つの URL（版と答えの印）だけ 200（スクリプトの型・nosniff・1 年の immutable・同じオリジンだけ）・
//      ほかの版や印や問いは 404・GET のほかは 405（HEAD も: 中身の無い答えに 1 年の保存の頭を付けない）・
//      作れないときは 503（保存させない）・1 回作った物を持つ・同時の呼び出しは 1 回の作り・失敗の後 10 秒は作り直さない・ログは理由の字だけ
//   C. 値が 1 か所: js/supabase.js の読み先・tests/oldtab/lib/authLib.mjs の固定の版の値・作り方は api/_lib/authModule.js と同じ。
//      配る URL は答えの sha256 の頭 8 字を持つ（答えのバイトが変われば URL も変わる）
//   D. テストの口（window.__SUPABASE_MODULE_URL）は、ページの無い所か手元の名前のときの字だけ。www・ほかの名前・字でない値では読まない
// ネットワークには出ない（--live・--print を除く）。
// 使い方: node scripts/test-auth-module.mjs [--root <木>]   --root は別の木（直す前の main を git archive した所など）に同じ検査を流す
//         node scripts/test-auth-module.mjs --print <版>      版を上げるとき: 登録所から作って、api/_lib/authModule.js に書く 4 つの値と、
//                                                            js/supabase.js に書く URL を出す
//         node scripts/test-auth-module.mjs --live           登録所から本物の tarball を取って作り、固定の値と同じか・旧タブの証明の写し（置き場にあれば）と
//                                                            束が 1 バイトも違わないか・モジュールとして読めるか（CI のジョブ oldtab）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : path.join(path.dirname(SELF), "..");
const LIVE = process.argv.includes("--live");

let passed = 0;
let failed = 0;
const out = (line) => process.stdout.write(`${line}\n`);
function ok(name, cond, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    out(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const load = async (rel) => {
  try {
    return await import(pathToFileURL(path.join(ROOT, rel)).href);
  } catch (error) {
    return { __missing: String(error?.message ?? error).slice(0, 120) };
  }
};
const M = await load("api/_lib/authModule.js");
const H = await load("api/auth-module.js");
const have = (mod, name) => typeof mod?.[name] !== "undefined";

// ===== 版を上げるとき: 登録所の版の情報と tarball から、固定の 4 つの値（版・integrity・body・served）と配る URL を出す（ネットワークが要る） =====
const printAt = process.argv.indexOf("--print");
if (printAt > 0) {
  const version = process.argv[printAt + 1] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version) || !have(M, "AUTH_MODULE_REGISTRY")) {
    out("使い方: node scripts/test-auth-module.mjs --print <版>");
    process.exit(2);
  }
  const meta = await (await fetch(`${M.AUTH_MODULE_REGISTRY}/${M.AUTH_MODULE_PACKAGE.replace("/", "%2f")}/${version}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) })).json();
  const integrity = String(meta?.dist?.integrity ?? "").split(/\s+/).find((x) => x.startsWith("sha512-")) ?? "";
  const tgz = Buffer.from(await (await fetch(M.tarballUrlOf(version), { signal: AbortSignal.timeout(20000) })).arrayBuffer());
  if (!integrity || M.sha512Integrity(tgz) !== integrity) {
    out(`違う: 登録所の版の情報の integrity（${integrity || "無い"}）と tarball の sha512 が合わない`);
    process.exit(1);
  }
  const files = M.readTar(tgz, (n) => n === "package/package.json" || n === M.AUTH_MODULE_BUNDLE || M.isLicenseName(n));
  const { body } = M.moduleBody(files.get(M.AUTH_MODULE_BUNDLE)?.toString("utf8") ?? "");
  const license = [...files.keys()].find(M.isLicenseName);
  const served = M.servedText(license ? files.get(license).toString("utf8") : null, body);
  out(JSON.stringify({ version, integrity, body: sha256(body), served: sha256(served), url: `${M.AUTH_MODULE_PATH}?v=${version}&h=${sha256(served).slice(0, 8)}` }, null, 2));
  process.exit(0);
}

// ===== 本物の登録所から作って確かめる（CI のジョブ oldtab。ネットワークが要る） =====
if (LIVE) {
  if (!have(M, "buildAuthModule")) {
    out(`✗ api/_lib/authModule.js を読めない: ${M.__missing ?? ""}`);
    process.exit(1);
  }
  const t0 = Date.now();
  let built = null;
  try {
    built = await M.buildAuthModule();
  } catch (error) {
    ok(`本物: 登録所から作れて、固定の値（sha512・束の sha256・答えの sha256）と同じ`, false, `${error?.code ?? ""} ${error?.message ?? error}`);
  }
  if (built) {
    const served = built.served.toString("utf8");
    ok(`本物: 登録所から作れて、固定の値と同じ（${built.served.length} バイト・${Date.now() - t0} ミリ秒）`, sha256(served) === M.AUTH_MODULE_PIN.served && sha256(built.body) === M.AUTH_MODULE_PIN.body);
    // 旧タブの証明の写し（置き場にあれば）: 注記の 3 行の後ろが束と 1 バイトも違わない
    const cacheDir = path.resolve(process.env.OLDTAB_LIB_CACHE || path.join(ROOT, "tests", "oldtab", ".cache", "auth-lib"));
    const copy = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { withFileTypes: true }).find((e) => e.isFile() && e.name.endsWith(`-${M.AUTH_MODULE_VERSION}.mjs`)) : null;
    if (copy) {
      const text = fs.readFileSync(path.join(cacheDir, copy.name), "utf8");
      let cut = -1;
      for (let i = 0; i < 3; i++) cut = text.indexOf("\n", cut + 1);
      ok("本物: 旧タブの証明の写し（置き場）の注記の後ろと束が 1 バイトも違わない", text.slice(cut + 1) === built.body);
    } else out(`（置き場 ${cacheDir} に旧タブの証明の写しが無いので、写しとの比べは飛ばした）`);
    try {
      const mod = await import("data:text/javascript;base64," + built.served.toString("base64"));
      ok("本物: 答えは検査の中でもモジュールとして読め、createClient を出す", typeof mod.createClient === "function");
    } catch (error) {
      ok("本物: 答えは検査の中でもモジュールとして読め、createClient を出す", false, String(error?.message ?? error).slice(0, 160));
    }
  }
  out(`test-auth-module --live: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ===== 偽の登録所（tarball はこの検査がメモリの中で作る） =====
function tarOf(entries) {
  const blocks = [];
  for (const [name, data] of entries) {
    const body = Buffer.from(data);
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii");
    h.write("0000000\0", 116, 8, "ascii");
    h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    h.write("00000000000\0", 136, 12, "ascii");
    h.write("        ", 148, 8, "ascii");
    h.write("0", 156, 1, "ascii");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    const sum = h.reduce((s, b) => s + b, 0);
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}
const VERSION = M.AUTH_MODULE_VERSION ?? "0.0.0";
const LICENSE = "MIT License\n\nCopyright (c) 2020 Example Lemon\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n";
const NAMES = Array.from({ length: 31 }, (_, i) => `Lemon${i}`);
const UMD = `${M.AUTH_MODULE_BUNDLE_HEAD ?? "var x=(function(e){"}var t=1;e.createClient=function(){return{lemon:true}}${NAMES.map((n, i) => `,e.${n}=${i}`).join("")};return e})({});\n`;
// 束の頭の「var <名前>=」の名前（束の外へ出す名前）
const GLOBAL = /^var ([A-Za-z_$][\w$]*)=/.exec(M.AUTH_MODULE_BUNDLE_HEAD ?? "")?.[1] ?? "";
const pkgJson = (over = {}) => JSON.stringify({ name: M.AUTH_MODULE_PACKAGE, version: VERSION, ...over });
const goodEntries = () => [[M.AUTH_MODULE_BUNDLE, UMD], ["package/package.json", pkgJson()], ["package/LICENSE", LICENSE]];
function pinFor(tgz) {
  const body = M.moduleBody(UMD).body;
  return { version: VERSION, integrity: M.sha512Integrity(tgz), body: sha256(body), served: sha256(M.servedText(LICENSE, body)) };
}
// 偽の fetch: url → tarball。呼ばれた URL と signal を控える
function fakeFetch(tgz, { status = 200, finalUrl = null, hang = false, throws = null, length = null } = {}) {
  const calls = [];
  const fetchImpl = (url, init = {}) => {
    calls.push({ url, signal: init.signal ?? null, redirect: init.redirect ?? null });
    if (throws) return Promise.reject(throws);
    // 答えない登録所（打ち切りの signal が来るまで待つ。打ち切りの時計はプロセスを生かさないので、待つ間だけ別の時計で生かす。
    // 打ち切りの無い作りでも検査が止まらないように、生かすのは 3 秒まで）
    if (hang) return new Promise((_, reject) => { const keep = setTimeout(() => {}, 3000); init.signal?.addEventListener("abort", () => { clearTimeout(keep); reject(init.signal.reason); }); });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      url: finalUrl ?? url,
      headers: { get: (k) => (k.toLowerCase() === "content-length" && length !== null ? String(length) : null) },
      arrayBuffer: async () => tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.byteLength)
    });
  };
  return { fetchImpl, calls };
}
const codeOf = async (p) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    return error?.code ?? `throw:${String(error?.message ?? error).slice(0, 60)}`;
  }
};

// ===== A. 作り方 =====
{
  const ready = have(M, "buildAuthModule") && have(M, "buildFromTarball") && have(M, "moduleBody") && have(M, "servedText");
  ok("A0 api/_lib/authModule.js が作り方（buildAuthModule・buildFromTarball・moduleBody・servedText）と固定の値を出す", ready && have(M, "AUTH_MODULE_PIN") && have(M, "AUTH_MODULE_URL"), M.__missing ?? "");
  if (ready) {
    const tgz = tarOf(goodEntries());
    const pin = pinFor(tgz);
    const f = fakeFetch(tgz);
    let built = null;
    try {
      built = await M.buildAuthModule({ pin, fetchImpl: f.fetchImpl });
    } catch (error) {
      built = { error: error?.code ?? String(error) };
    }
    const served = built?.served ? built.served.toString("utf8") : "";
    const body = M.moduleBody(UMD).body;
    ok("A1 正しい tarball: 答えは「/*!」・LICENSE の文・「*/」・束・export の行（束の名前 32 個を並べ替えて出す）", GLOBAL !== "" && Buffer.isBuffer(built?.served) && served === `/*!\n${LICENSE.trim()}\n*/\n${body}` && body.startsWith(UMD.trimEnd() + "\nexport const { ") && body.endsWith(` } = ${GLOBAL};\nexport default ${GLOBAL};\n`) && /export const \{ Lemon0, Lemon1, Lemon10,/.test(body) && body.includes("createClient"), JSON.stringify(built?.error ?? served.slice(0, 80)));
    ok("A1 取るのは 1 回・決まった https の tarball の URL（登録所・包みの名前・版）・打ち切りの signal 付き", f.calls.length === 1 && f.calls[0].url === M.tarballUrlOf(VERSION) && /^https:\/\/[^/]+\/.+\/-\/.+-\d+\.\d+\.\d+\.tgz$/.test(f.calls[0].url) && f.calls[0].signal instanceof AbortSignal, JSON.stringify(f.calls.map((c) => c.url)));
    const tryPin = (over, entries = goodEntries(), opts = {}) => {
      const t = tarOf(entries);
      return codeOf(M.buildAuthModule({ pin: { ...pinFor(t), ...over }, fetchImpl: fakeFetch(t, opts).fetchImpl, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) }));
    };
    ok("A2 tarball の sha512 が固定の値と違う → 作らない（tarball_hash）", (await tryPin({ integrity: M.sha512Integrity(Buffer.from("lemon")) })) === "tarball_hash");
    // 固定の integrity は正しい tarball の物のまま、配る側が別の tarball を返す（登録所の中身が替わった）
    {
      const other = tarOf([[M.AUTH_MODULE_BUNDLE, UMD.replace("lemon:true", "lemon:false")], ["package/package.json", pkgJson()], ["package/LICENSE", LICENSE]]);
      ok("A2 配る側の tarball が替わった（固定の integrity と合わない）→ 作らない", (await codeOf(M.buildAuthModule({ pin, fetchImpl: fakeFetch(other).fetchImpl }))) === "tarball_hash");
    }
    ok("A3 束の sha256 が固定の値と違う → 作らない（body_hash）", (await tryPin({ body: sha256("lemon") })) === "body_hash");
    ok("A4 答えの sha256 が固定の値と違う → 作らない（served_hash）", (await tryPin({ served: sha256("lemon") })) === "served_hash");
    ok("A5 tarball の package.json の名前が違う → 作らない（package）", (await tryPin({}, [[M.AUTH_MODULE_BUNDLE, UMD], ["package/package.json", pkgJson({ name: "lemon-lib" })], ["package/LICENSE", LICENSE]])) === "package");
    ok("A5 tarball の package.json の版が違う → 作らない（package）", (await tryPin({}, [[M.AUTH_MODULE_BUNDLE, UMD], ["package/package.json", pkgJson({ version: "9.9.9" })], ["package/LICENSE", LICENSE]])) === "package");
    ok("A6 束が無い → 作らない（no_bundle）", (await tryPin({}, [["package/package.json", pkgJson()], ["package/LICENSE", LICENSE]])) === "no_bundle");
    ok("A6 束の形が違う → 作らない（bundle_shape）", (await tryPin({}, [[M.AUTH_MODULE_BUNDLE, "export const lemon = 1;\n"], ["package/package.json", pkgJson()], ["package/LICENSE", LICENSE]])) === "bundle_shape");
    ok("A7 LICENSE が無い → 作らない（license）", (await tryPin({}, [[M.AUTH_MODULE_BUNDLE, UMD], ["package/package.json", pkgJson()]])) === "license");
    ok("A7 LICENSE に注記を閉じる字 */ がある → 作らない（license）", (await tryPin({}, [[M.AUTH_MODULE_BUNDLE, UMD], ["package/package.json", pkgJson()], ["package/LICENSE", "MIT */ alert(1) /*"]])) === "license");
    ok("A7 LICENSE に ASCII でない字・見えない字がある → 作らない（license）", (await tryPin({}, [[M.AUTH_MODULE_BUNDLE, UMD], ["package/package.json", pkgJson()], ["package/LICENSE", "MIT\u2028alert(1)"]])) === "license");
    // 打ち切りが無い作りでも検査が止まらないように、2 秒で終わらなければ「hung」（この件が落ちる）
    const hung = await new Promise((resolve) => {
      const t = setTimeout(() => resolve("hung"), 2000);
      tryPin({}, goodEntries(), { hang: true, timeoutMs: 50 }).then((code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    ok("A8 登録所が 5 秒（検査では 50 ミリ秒）で答えない → 作らない（timeout。打ち切りが無ければ 2 秒で hung）", hung === "timeout", hung);
    ok("A8 登録所に届かない → 作らない（network）", (await tryPin({}, goodEntries(), { throws: new TypeError("fetch failed") })) === "network");
    ok("A8 登録所が 404・500 → 作らない（status_404・status_500）", (await tryPin({}, goodEntries(), { status: 404 })) === "status_404" && (await tryPin({}, goodEntries(), { status: 500 })) === "status_500");
    ok("A8 転送の先が https でない → 作らない（not_https）", (await tryPin({}, goodEntries(), { finalUrl: "http://registry.example/x.tgz" })) === "not_https");
    ok("A8 大きすぎる（見出しの長さ・本当の長さ）→ 作らない（too_large）", (await tryPin({}, goodEntries(), { length: 3 * 1024 * 1024 })) === "too_large" && (await tryPin({}, goodEntries(), { maxBytes: 100 })) === "too_large");
    ok("A9 固定の値は凍っている（書き換えられない）・版の形・sha512 と sha256 の形", Object.isFrozen(M.AUTH_MODULE_PIN) && /^\d+\.\d+\.\d+$/.test(M.AUTH_MODULE_PIN.version) && /^sha512-[A-Za-z0-9+/]{86}==$/.test(M.AUTH_MODULE_PIN.integrity) && /^[0-9a-f]{64}$/.test(M.AUTH_MODULE_PIN.body) && /^[0-9a-f]{64}$/.test(M.AUTH_MODULE_PIN.served) && M.AUTH_MODULE_PIN.body !== M.AUTH_MODULE_PIN.served);
  }
}

// ===== B. 配信の関数 =====
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, ended: false };
  res.setHeader = (k, v) => {
    res.headers[k.toLowerCase()] = String(v);
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.ended = true;
    return res;
  };
  res.end = (body) => {
    res.body = body;
    res.ended = true;
    return res;
  };
  return res;
}
const call = async (handler, method, url) => {
  const res = fakeRes();
  await handler({ method, url, headers: {} }, res);
  return res;
};
{
  const ready = have(H, "createAuthModuleHandler") && typeof H.default === "function" && have(M, "AUTH_MODULE_URL");
  ok("B0 api/auth-module.js が配信の関数（default）と作り手を替えられる作り方（createAuthModuleHandler）を出す", ready, H.__missing ?? "");
  if (ready) {
    const SERVED = Buffer.from("/*!\nMIT\n*/\nexport const createClient = () => ({});\n");
    let builds = 0;
    const logs = [];
    const quiet = console.error;
    console.error = (...a) => logs.push(a.join(" "));
    try {
      const h = H.createAuthModuleHandler({ build: async () => (builds++, { served: SERVED }) });
      const r = await call(h, "GET", M.AUTH_MODULE_URL);
      ok("B1 GET 決まった URL → 200・スクリプトの型（utf-8）・nosniff・1 年の immutable（端末と配信の縁）・同じオリジンだけ・中身は作った答え",
        r.statusCode === 200 && r.headers["content-type"] === "text/javascript; charset=utf-8" && r.headers["x-content-type-options"] === "nosniff" && r.headers["cache-control"] === "public, max-age=31536000, s-maxage=31536000, immutable" && r.headers["cross-origin-resource-policy"] === "same-origin" && Buffer.isBuffer(r.body) && r.body.equals(SERVED),
        JSON.stringify({ s: r.statusCode, h: r.headers }));
      const head = await call(h, "HEAD", M.AUTH_MODULE_URL);
      ok("B2 HEAD → 405・Allow: GET・保存させない（中身の無い答えに 1 年の保存の頭を付けない）・スクリプトの型でない",
        head.statusCode === 405 && head.headers.allow === "GET" && head.headers["cache-control"] === "no-store" && !/javascript/.test(head.headers["content-type"] ?? ""), JSON.stringify({ s: head.statusCode, h: head.headers }));
      await call(h, "GET", M.AUTH_MODULE_URL);
      ok("B3 1 回作った物を持つ（3 回の呼び出しで作りは 1 回）", builds === 1, String(builds));
      const P = M.AUTH_MODULE_PATH;
      const T = String(M.AUTH_MODULE_TAG ?? "");
      // ほかの印（終わりの 1 字だけ違う）と、大文字の印（印に英字があるときだけ。版を上げて印が数字だけになっても落ちない）
      const otherT = T.slice(0, -1) + (T.endsWith("0") ? "1" : "0");
      const upperT = T !== T.toUpperCase() ? [`${P}?v=${VERSION}&h=${T.toUpperCase()}`] : [];
      const wrong = [`${P}?v=2.117.0&h=${T}`, `${P}?v=${VERSION}&h=${otherT}`, ...upperT, `${P}?v=${VERSION}`, `${P}?h=${T}`, `${P}?v=${VERSION}&h=${T}&x=1`,
        `${P}?v=${VERSION}&v=${VERSION}&h=${T}`, `${P}?v=${VERSION}&h=${T}&h=${T}`, `${P}?V=${VERSION}&h=${T}`, P, `${P}?v=&h=${T}`, `${P}?v=${VERSION}.0&h=${T}`];
      const answers = [];
      for (const u of wrong) answers.push(await call(h, "GET", u));
      ok("B4 ほかの版・ほかの印（大文字も）・印が無い・版が無い・余った問い・2 つの v や h・大文字の V・問い無し・空の版 → 404・保存させない（no-store）・スクリプトの型でない",
        answers.every((a) => a.statusCode === 404 && a.headers["cache-control"] === "no-store" && !/javascript/.test(a.headers["content-type"] ?? "")), JSON.stringify(answers.map((a) => a.statusCode)));
      const post = await call(h, "POST", M.AUTH_MODULE_URL);
      ok("B5 POST → 405・Allow: GET・保存させない", post.statusCode === 405 && post.headers.allow === "GET" && post.headers["cache-control"] === "no-store");
      // 作れない → 503・10 秒は作り直さない・その後は作り直す
      let clock = 1_000_000;
      let tries = 0;
      let failNext = true;
      const h2 = H.createAuthModuleHandler({
        now: () => clock,
        build: async () => {
          tries++;
          if (failNext) throw Object.assign(new Error("registry https://registry.example/secret?token=abc"), { code: "timeout" });
          return { served: SERVED };
        }
      });
      const f1 = await call(h2, "GET", M.AUTH_MODULE_URL);
      ok("B6 作れない → 503・保存させない（no-store）・Retry-After・スクリプトの型でない", f1.statusCode === 503 && f1.headers["cache-control"] === "no-store" && f1.headers["retry-after"] === "10" && !/javascript/.test(f1.headers["content-type"] ?? "") && tries === 1);
      failNext = false;
      clock += 9000;
      const f2 = await call(h2, "GET", M.AUTH_MODULE_URL);
      ok("B6 作れなかった後 10 秒の間は作り直さない（503 のまま・作りを呼ばない）", f2.statusCode === 503 && tries === 1, String(tries));
      clock += 1001;
      const f3 = await call(h2, "GET", M.AUTH_MODULE_URL);
      ok("B6 10 秒の後は作り直し、作れたら 200", f3.statusCode === 200 && tries === 2 && Buffer.isBuffer(f3.body), `${f3.statusCode} ${tries}`);
      ok("B7 ログは理由の短い字だけ（URL・問いの字・中身を書かない）", logs.length >= 1 && logs.every((l) => /^auth-module: unavailable [a-z_0-9]+$/.test(l)), JSON.stringify(logs));
      // 同時の呼び出しは 1 回の作りを待つ
      let slowBuilds = 0;
      let release;
      const gate = new Promise((r) => (release = r));
      const h3 = H.createAuthModuleHandler({ build: async () => (slowBuilds++, await gate, { served: SERVED }) });
      const both = Promise.all([call(h3, "GET", M.AUTH_MODULE_URL), call(h3, "GET", M.AUTH_MODULE_URL), call(h3, "GET", M.AUTH_MODULE_URL)]);
      release();
      const three = await both;
      ok("B8 同時の 3 つの呼び出しは 1 回の作りを待ち、どれも 200", slowBuilds === 1 && three.every((a) => a.statusCode === 200), String(slowBuilds));
      const h4 = H.createAuthModuleHandler({ build: async () => ({ served: "not a buffer" }) });
      ok("B9 作り手が答えの形でない物を返す → 503", (await call(h4, "GET", M.AUTH_MODULE_URL)).statusCode === 503);
    } finally {
      console.error = quiet;
    }
  }
}

// ===== C. 値が 1 か所 =====
{
  const supa = (() => {
    try {
      return fs.readFileSync(path.join(ROOT, "js", "supabase.js"), "utf8");
    } catch {
      return "";
    }
  })();
  ok("C1 js/supabase.js の読み先は api/_lib/authModule.js の AUTH_MODULE_URL と同じ字（同じオリジンの /api/ の下）",
    have(M, "AUTH_MODULE_URL") && supa.includes(`const OWN_MODULE_URL = "${M.AUTH_MODULE_URL}";`) && M.AUTH_MODULE_URL.startsWith("/api/auth-module?"));
  // 答えは 1 年保存させる（immutable）ので、答えのバイト（served）が変われば URL も変わる: 問いは版と served の頭 8 字
  ok("C5 配る URL の問いは版（v）と答えの sha256 の頭 8 字（h）だけ（答えが変われば URL も変わる。js/supabase.js の字は C1）",
    have(M, "AUTH_MODULE_TAG") && have(M, "AUTH_MODULE_PIN") && /^[0-9a-f]{8}$/.test(M.AUTH_MODULE_TAG) && M.AUTH_MODULE_TAG === M.AUTH_MODULE_PIN.served.slice(0, 8) &&
      M.AUTH_MODULE_URL === `${M.AUTH_MODULE_PATH}?v=${M.AUTH_MODULE_PIN.version}&h=${M.AUTH_MODULE_TAG}`, String(M.AUTH_MODULE_URL ?? ""));
  // 注記を除いたコード（「://」の「//」は注記の頭でない）
  const code = supa.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  ok("C2 js/supabase.js のコードに外の配信元の URL（https://・//）が無い（読み先は同じオリジンだけ）", code !== "" && !/["'`](https?:)?\/\/(?!sujvgwozsnzjsjmkcrnk\.)/.test(code));
  // 新しい道に包みの名前（前からある識別子）を入れない: 包みの名前の最後の語の頭（「-」の前）を道に含まない
  const pkgWord = String(M.AUTH_MODULE_PACKAGE ?? "").split("/").pop().split("-")[0];
  ok("C3 配る道は /api/auth-module（新しい道に包みの名前を入れない）", have(M, "AUTH_MODULE_PATH") && M.AUTH_MODULE_PATH === "/api/auth-module" && pkgWord.length > 3 && !M.AUTH_MODULE_PATH.toLowerCase().includes(pkgWord.toLowerCase()));
  const libText = (() => {
    try {
      return fs.readFileSync(path.join(ROOT, "tests", "oldtab", "lib", "authLib.mjs"), "utf8");
    } catch {
      return "";
    }
  })();
  let lib = null;
  try {
    lib = await import(pathToFileURL(path.join(ROOT, "tests", "oldtab", "lib", "authLib.mjs")).href);
  } catch {
    lib = null;
  }
  ok("C4 旧タブの証明の部品（tests/oldtab/lib/authLib.mjs）は固定の版の値と作り方を api/_lib/authModule.js から読む（自分で integrity を持たない）",
    /from "\.\.\/\.\.\/\.\.\/api\/_lib\/authModule\.js"/.test(libText) && have(M, "AUTH_MODULE_PIN") && !libText.includes(M.AUTH_MODULE_PIN.integrity) && !libText.includes(M.AUTH_MODULE_PIN.body) && !/function readTar\(/.test(libText));
  ok("C4 旧タブの証明の部品の版（両方の木が読む版）は AUTH_MODULE_VERSION と同じ・固定の版に入っている", lib?.VERSION === M.AUTH_MODULE_VERSION && Array.isArray(lib?.PINNED_VERSIONS) && lib.PINNED_VERSIONS.includes(M.AUTH_MODULE_VERSION), JSON.stringify([lib?.VERSION, lib?.PINNED_VERSIONS]));
}

// ===== D. テストの口 =====
// 毎回 js/supabase.js を新しく読み（問いの字を替える）、どの部品を使ったかを見る: 口の偽の部品はセッション { lemon: 1 } を返す。
// 口を使わないときの読み先（自分の配信の道）はこの検査の中では読めないので、オフラインの代わり（セッション null）になる
{
  const supaUrl = pathToFileURL(path.join(ROOT, "js", "supabase.js")).href;
  const HOOK = `data:text/javascript,${encodeURIComponent("export const createClient = () => ({ auth: { getSession: async () => ({ data: { session: { lemon: 1 } } }) }, from: () => ({}) });")}`;
  const saved = { window: Object.getOwnPropertyDescriptor(globalThis, "window"), location: Object.getOwnPropertyDescriptor(globalThis, "location") };
  const quietWarn = console.warn;
  console.warn = () => {};
  let n = 0;
  const usedHook = async ({ hook, host }) => {
    n++;
    if (hook === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { __SUPABASE_MODULE_URL: hook } });
    if (host === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { hostname: host, search: "", pathname: "/", href: `https://${host}/`, origin: `https://${host}` } });
    try {
      const mod = await import(`${supaUrl}?gate=${n}`);
      const { data } = await mod.supabase.auth.getSession();
      return data?.session?.lemon === 1;
    } catch (error) {
      return `読めない: ${String(error?.message ?? error).slice(0, 80)}`;
    }
  };
  try {
    const rows = [];
    const expect = async (label, setup, want) => {
      const got = await usedHook(setup);
      rows.push([label, got === want]);
      if (got !== want) out(`  ${label}: ${got}`);
    };
    await expect("ページの無い所（単体の検査）・字の口 → 口の部品", { hook: HOOK, host: undefined }, true);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) await expect(`${host}・字の口 → 口の部品`, { hook: HOOK, host }, true);
    for (const host of ["www.spelldash.net", "spelldash.net", "check.example.app", "example.com", "localhost.example.com", "127.0.0.1.example.com", "localhost.", ""]) await expect(`${host || "(空)"}・字の口 → 口を読まない`, { hook: HOOK, host }, false);
    await expect("localhost・字でない口（入った HTML の要素の形: 字に直すと口の URL）→ 口を読まない", { hook: { toString: () => HOOK }, host: "localhost" }, false);
    await expect("localhost・空の口 → 口を読まない", { hook: "", host: "localhost" }, false);
    const bad = rows.filter(([, good]) => !good).map(([l]) => l);
    ok(`D1 テストの口（window.__SUPABASE_MODULE_URL）は、ページの無い所と手元の名前（localhost・127.0.0.1・[::1]）の字だけ。www・ほかの名前・字でない値では読まない（${rows.length} 通り）`, bad.length === 0, bad.join(" / "));
    const supa = fs.readFileSync(path.join(ROOT, "js", "supabase.js"), "utf8");
    ok("D2 口を読まないときの読み先は自分の配信の道（const MODULE_URL = testModuleUrl() ?? OWN_MODULE_URL）", /const MODULE_URL = testModuleUrl\(\) \?\? OWN_MODULE_URL;/.test(supa));
  } finally {
    console.warn = quietWarn;
    if (saved.window) Object.defineProperty(globalThis, "window", saved.window);
    else delete globalThis.window;
    if (saved.location) Object.defineProperty(globalThis, "location", saved.location);
    else delete globalThis.location;
  }
}

out(`test-auth-module: ${passed} passed, ${failed} failed${rootArg > 0 ? `（--root ${ROOT}）` : ""}`);
process.exit(failed ? 1 : 0);
