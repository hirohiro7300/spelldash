// 旧タブの証明（tests/oldtab）が使う本物の認証の部品（包みの名前は下の PACKAGE）を、検査の時に登録所から取って作る。
// リポジトリには入れない（配布物の原文は公開の置き場に置かない）。作った物は置き場に置き、次からはそれを確かめて使う。
//   置き場: 既定 tests/oldtab/.cache/auth-lib（.gitignore 済み）。env OLDTAB_LIB_CACHE で替えられる。CI はこの置き場を控えに残す。
//   登録所: 既定は下の REGISTRY。env OLDTAB_REGISTRY で替えられる（固定の版は、どこから取っても下の固定の値で確かめる）。
//
//   node tests/oldtab/lib/authLib.mjs                  固定の版（2.118.0・2.105.0）を置き場に用意する（置き場にあれば確かめて使う）
//   node tests/oldtab/lib/authLib.mjs --check          置き場を使わずに登録所から取り直して作り、固定の値と同じか確かめる。
//                                                      置き場に写しがあれば、取り直した物と 1 バイトも違わないかも確かめる（置き場には書かない）
//   node tests/oldtab/lib/authLib.mjs --version <版>   その版だけ（--version は重ねられる。--check とも使える）
//
// 作り方（ビルドの道具は使わない）:
//   1. 登録所の版の情報（<登録所>/@supabase%2fsupabase-js/<版>）を読み、dist.integrity（sha512）と dist.tarball を取る。
//      固定の版は、版の情報の integrity が固定の値と同じか確かめる（違えば止める）
//   2. tarball を取り、sha512 が版の情報の integrity と同じか確かめる
//   3. tarball はメモリの中で開く（ファイルに展開しない）。読むのは package/package.json（名前と版を確かめる）・package/dist/umd/supabase.js・LICENSE（あれば）だけ
//   4. dist/umd/supabase.js は配布元が作った 1 ファイルの束（形は `var supabase=(function(e){ … return e})({});`。モジュールの中ではモジュールの変数になり、
//      window を汚さない）。頭に出どころの注記、末尾に export の行（束の末尾で e.<名前>= と Object.defineProperty(e,`<名前>` で出している名前の全部）を足す
//   5. 注記の後ろ（束と export の行）の sha256 が固定の値と同じか確かめる。2.118.0 の値は、前に作業のブランチに置いていた写し
//      （tests/oldtab/vendor/supabase-js-2.118.0.mjs）の注記の後ろと同じ。2.105.0 の値は、前の作り方で手元に作って流していた物の注記の後ろと同じ
// 固定の版でない版は、登録所の版の情報の integrity だけで確かめる（注意を出す）。版を足すときは、--version <版> が出す integrity と sha256 を PINNED に足す。
// 置き場の写しは、ファイルの全部が作り方どおりか確かめてから使う（注記の 3 行を固定の値から作り直し、注記の後ろの sha256 と合わせて 1 バイトずつ比べる）。
import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import { fileURLToPath } from "url";

const PACKAGE = "@supabase/supabase-js";
// 両方の木が読む版（本番の読み先が今 @2 で返す版）
export const VERSION = "2.118.0";
// 古い部品の回（run.mjs --old-auth-lib 2.105.0）。更新の途中で保存が変わったら結果を捨てる守りは 2.107.0 からなので、それより前の版
export const OLD_VERSION = "2.105.0";
// integrity = 登録所の dist.integrity（tarball の sha512）。body = 作った物の注記の後ろ（束と export の行）の sha256
const PINNED = {
  "2.118.0": {
    integrity: "sha512-FxI8UXMVC2UG7IkeiI8fuQZqq2oI3JeSuN8MPIC2RLVaoEAxKS0nqE6kii9Ewpq8f9gNPM6git1Y8f0vN/QLFw==",
    body: "9c5c59ecd5899a6c73c701400cb675ffb5bde827490a927c19ee222b5291eb91"
  },
  "2.105.0": {
    integrity: "sha512-UUmh6KpStf2RdKpRUmzj0cPl6OXlo1hkRTNHdFHozbiJv2MIxR/7eWGKHAO8OgnaZt0gv52k7NL/bZXgPQbw/A==",
    body: "1d2b4aae8e67dac0aa4de150c3677de505a57244be5f652bf2a178762f3fb2a3"
  }
};
export const PINNED_VERSIONS = Object.freeze(Object.keys(PINNED));
const HEAD_LINES = 3;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = (process.env.OLDTAB_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");

export function isVersion(s) {
  return /^\d+\.\d+\.\d+$/.test(String(s ?? ""));
}

export function libCacheDir() {
  return path.resolve(process.env.OLDTAB_LIB_CACHE || path.join(HERE, "..", ".cache", "auth-lib"));
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const fileOf = (dir, version) => path.join(dir, `supabase-js-${version}.mjs`);

// https だけ。4xx はすぐ止め、ほかの失敗は 3 回まで
async function get(url, what, headers = {}) {
  if (!url.startsWith("https://")) throw new Error(`${what}の URL が https でない: ${url}`);
  let last;
  for (let i = 0; i < 3; i++) {
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: "follow", headers });
    } catch (e) {
      last = new Error(`${what}を取れない: ${e?.cause?.code ?? e?.message ?? e} ${url}`);
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
      continue;
    }
    if (r.ok) return Buffer.from(await r.arrayBuffer());
    last = new Error(`${what}を取れない: ${r.status} ${url}`);
    if (r.status >= 400 && r.status < 500) break;
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  throw last;
}

// tarball（gzip の tar）を開いて、keep(名前) が真のふつうのファイルだけを返す。展開してファイルに書くことはしない
function readTar(gz, keep) {
  const buf = zlib.gunzipSync(gz);
  const out = new Map();
  let off = 0;
  let nextName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0[\s\S]*$/, "");
    if (!field(257, 263).startsWith("ustar")) throw new Error(`tarball の形が想定と違う（${off} バイト目の見出しが ustar でない）`);
    const sum = h.reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== parseInt(field(148, 156).trim(), 8)) throw new Error(`tarball の見出しの合計が合わない（${off} バイト目）`);
    const size = parseInt(field(124, 136).trim() || "0", 8);
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const prefix = field(345, 500);
    const name = nextName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // pax の拡張見出し: 次の 1 件の名前（path=）だけを使う
      const m = body.toString("utf8").match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      nextName = m ? m[1] : null;
      continue;
    }
    if (type === "L") {
      nextName = body.toString("utf8").replace(/\0[\s\S]*$/, "");
      continue;
    }
    if (type === "g") continue;
    nextName = null;
    if (type === "0" && keep(name)) out.set(name, Buffer.from(body));
  }
  return out;
}

// 作った物の注記の 3 行。置き場の写しを確かめる時も、同じ値から作り直して比べる
function makeHead({ version, integrity, umdSha, bodySha }) {
  return [
    `// ${PACKAGE} ${version}。ライセンスは配布物のとおり（包みの文は同じ置き場の supabase-js-${version}.LICENSE.txt。束に入るほかの部品の文は写していない）。tests/oldtab の検査だけが読む。製品のページは読まない。リポジトリには入れない。`,
    `// 元: 登録所の supabase-js-${version}.tgz（${integrity}）の package/dist/umd/supabase.js（sha256 ${umdSha}）。`,
    `// 中身はそのまま。末尾の export の行だけを tests/oldtab/lib/authLib.mjs が足した（注記の後ろの sha256 ${bodySha}）。`
  ].join("\n");
}

// 注記の後ろの末尾の export の行の頭（ここより前が配布物の束）
const FOOT_HEAD = "\nexport const { ";

// 配布物の dist/umd/supabase.js から、ブラウザ用のモジュールを作る（前に作業のブランチに置いていた写しと同じ作り方。注記の文だけが違う）
function makeModule({ version, integrity, umdRaw }) {
  const umd = umdRaw.replace(/\s+$/, "");
  if (!umd.startsWith("var supabase=(function(e){") || !umd.endsWith("})({});")) throw new Error("dist/umd/supabase.js の形が想定と違う（var supabase=(function(e){ … })({});）");
  const tail = umd.slice(umd.lastIndexOf("e.createClient=") - 6000);
  const names = new Set();
  for (const m of tail.matchAll(/[,;(]e\.([A-Za-z_$][\w$]*)=/g)) names.add(m[1]);
  for (const m of tail.matchAll(/Object\.defineProperty\(e,`([A-Za-z_$][\w$]*)`/g)) names.add(m[1]);
  if (!names.has("createClient") || names.size < 30) throw new Error(`export の名前を読めない（${names.size} 個）`);
  const sorted = [...names].sort();
  const foot = [`export const { ${sorted.join(", ")} } = supabase;`, "export default supabase;"].join("\n");
  const body = `${umd}\n${foot}\n`;
  const bodySha = sha256(body);
  const head = makeHead({ version, integrity, umdSha: sha256(umd), bodySha });
  return { mjs: `${head}\n${body}`, bodySha, names: sorted.length };
}

// 登録所から取って作る（置き場は使わない）。戻り値: { version, integrity, tarball, mjs, license, bodySha, names, pinned }
export async function buildFromRegistry(version) {
  if (!isVersion(version)) throw new Error(`版の形が違う: ${version}`);
  const pin = PINNED[version] ?? null;
  const metaUrl = `${REGISTRY}/${PACKAGE.replace("/", "%2f")}/${version}`;
  const meta = JSON.parse((await get(metaUrl, "版の情報", { accept: "application/json" })).toString("utf8"));
  if (meta.name !== PACKAGE || meta.version !== version) throw new Error(`版の情報の名前か版が違う: ${meta.name}@${meta.version}`);
  const integrity = String(meta.dist?.integrity ?? "").split(/\s+/).find((s) => s.startsWith("sha512-"));
  if (!integrity) throw new Error(`版の情報に sha512 の integrity が無い: ${metaUrl}`);
  if (pin && integrity !== pin.integrity) throw new Error(`${version} の登録所の integrity が固定の値と違う: ${integrity}（固定 ${pin.integrity}）`);
  const tarball = String(meta.dist?.tarball ?? "");
  const tgz = await get(tarball, "tarball");
  const got = "sha512-" + crypto.createHash("sha512").update(tgz).digest("base64");
  if (got !== integrity) throw new Error(`tarball の sha512 が登録所の版の情報と違う: ${got}（版の情報 ${integrity}）`);
  const isLicense = (n) => /^package\/licen[cs]e(\.(md|txt))?$/i.test(n);
  const files = readTar(tgz, (n) => n === "package/package.json" || n === "package/dist/umd/supabase.js" || isLicense(n));
  const pkg = JSON.parse(files.get("package/package.json")?.toString("utf8") ?? "{}");
  if (pkg.name !== PACKAGE || pkg.version !== version) throw new Error(`tarball の package.json の名前か版が違う: ${pkg.name}@${pkg.version}`);
  const umd = files.get("package/dist/umd/supabase.js");
  if (!umd) throw new Error("tarball に package/dist/umd/supabase.js が無い");
  const { mjs, bodySha, names } = makeModule({ version, integrity, umdRaw: umd.toString("utf8") });
  if (pin && bodySha !== pin.body) throw new Error(`${version} の作った物（注記の後ろ）の sha256 が固定の値と違う: ${bodySha}（固定 ${pin.body}）`);
  // LICENSE の文は配布物にあればそのまま写す（2.105.0 の配布物には無く、package.json の license だけ）
  const licenseName = [...files.keys()].find(isLicense);
  const license = licenseName
    ? `${PACKAGE} ${version} の ${licenseName.slice("package/".length)}（配布物の文のとおり）\n\n${files.get(licenseName).toString("utf8").trim()}\n`
    : `${PACKAGE} ${version} の配布物に LICENSE の文は無い。package.json の license: ${pkg.license ?? "（無い）"}\n`;
  return { version, integrity, tarball, mjs, license, bodySha, names, pinned: !!pin };
}

// 置き場の写しを確かめる。注記の後ろの sha256 が固定の値（固定でない版は作った時の記録）と同じで、ファイルの全部が
// 「固定の値から作り直した注記の 3 行 + 注記の後ろ」と 1 バイトも違わないこと（注記の行に改行の代わりになる字やコードを足した写しは使わない）
function readCached(dir, version) {
  const file = fileOf(dir, version);
  if (!fs.existsSync(file)) return { ok: false, why: "無い" };
  const raw = fs.readFileSync(file);
  const text = raw.toString("utf8");
  let cut = -1;
  for (let i = 0; i < HEAD_LINES; i++) {
    cut = text.indexOf("\n", cut + 1);
    if (cut < 0) return { ok: false, why: "注記の形が違う" };
  }
  const body = text.slice(cut + 1);
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(file.replace(/\.mjs$/, ".json"), "utf8"));
  } catch {}
  const expect = PINNED[version]?.body ?? info?.bodySha256;
  if (!expect || sha256(body) !== expect) return { ok: false, why: "注記の後ろの sha256 が合わない" };
  const integrity = PINNED[version]?.integrity ?? info?.integrity ?? null;
  const footAt = body.lastIndexOf(FOOT_HEAD);
  if (!integrity || footAt < 0) return { ok: false, why: "注記を作り直せない" };
  const head = makeHead({ version, integrity, umdSha: sha256(body.slice(0, footAt)), bodySha: expect });
  if (!raw.equals(Buffer.from(`${head}\n${body}`, "utf8"))) return { ok: false, why: "注記が作り方どおりでない" };
  return { ok: true, file, integrity, bodySha: expect };
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// 版を用意して、その写しのファイルを返す（置き場にあって確かめが通ればそれを使い、無いか合わなければ登録所から作って置く）。
// 戻り値: { version, file, integrity, bodySha, pinned, from: "cache" | "registry" }
export async function ensureAuthLib(version, { log = console.log } = {}) {
  const dir = libCacheDir();
  const c = readCached(dir, version);
  if (c.ok) return { version, file: c.file, integrity: c.integrity, bodySha: c.bodySha, pinned: !!PINNED[version], from: "cache" };
  if (c.why !== "無い") log(`認証の部品 ${version} の置き場の写しを使わない（${c.why}）。登録所から作り直す`);
  const b = await buildFromRegistry(version);
  if (!b.pinned) log(`注意: ${version} は固定の版ではない（登録所の integrity だけで確かめた: ${b.integrity}・注記の後ろの sha256 ${b.bodySha}）`);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileOf(dir, version);
  writeAtomic(file.replace(/\.mjs$/, ".LICENSE.txt"), b.license);
  writeAtomic(file.replace(/\.mjs$/, ".json"), JSON.stringify({ package: PACKAGE, version, integrity: b.integrity, tarball: b.tarball, bodySha256: b.bodySha, exports: b.names, pinned: b.pinned, builtAt: new Date().toISOString() }, null, 1) + "\n");
  writeAtomic(file, b.mjs);
  return { version, file, integrity: b.integrity, bodySha: b.bodySha, pinned: b.pinned, from: "registry" };
}

// 取り直して作り、固定の値と、置き場の写し（あれば）と比べる。置き場には書かない。戻り値: { ok, lines }
export async function checkAuthLib(versions = PINNED_VERSIONS) {
  const lines = [];
  let ok = true;
  for (const version of versions) {
    if (!PINNED[version]) {
      ok = false;
      lines.push(`違う: ${version} は固定の版ではない（固定の値が無いので確かめられない。固定の版: ${PINNED_VERSIONS.join("・")}）`);
      continue;
    }
    try {
      const b = await buildFromRegistry(version);
      const file = fileOf(libCacheDir(), version);
      const cached = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      const same = cached === null || cached === b.mjs;
      if (!same) ok = false;
      const cache = cached === null ? "置き場に写しは無い" : same ? "置き場の写しとも 1 バイトも違わない" : `置き場の写しが取り直した物と違う（${file} を消して作り直す）`;
      lines.push(`${same ? "同じ" : "違う"}: ${PACKAGE} ${version}（登録所の integrity・tarball の sha512・作った物の注記の後ろの sha256 ${b.bodySha} が固定の値と同じ・export ${b.names} 個。${cache}）`);
    } catch (e) {
      ok = false;
      lines.push(`違う: ${PACKAGE} ${version}: ${e.message}`);
    }
  }
  return { ok, lines };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const versions = [];
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") check = true;
    else if (args[i] === "--version" && isVersion(args[i + 1])) versions.push(args[++i]);
    else {
      console.error("使い方: node tests/oldtab/lib/authLib.mjs [--check] [--version <版>]...");
      process.exit(2);
    }
  }
  const list = versions.length ? versions : PINNED_VERSIONS;
  if (check) {
    const { ok, lines } = await checkAuthLib(list);
    for (const l of lines) console.log(l);
    process.exit(ok ? 0 : 1);
  }
  for (const v of list) {
    const r = await ensureAuthLib(v);
    console.log(`${r.from === "cache" ? "置き場の写しを確かめた" : "登録所から作って置いた"}: ${PACKAGE} ${v}（${path.relative(process.cwd(), r.file) || r.file}・${r.integrity}・注記の後ろの sha256 ${r.bodySha}${r.pinned ? "" : "・固定の版ではない"}）`);
  }
}
