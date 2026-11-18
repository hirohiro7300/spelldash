// ===== 認証の部品の固定の版と作り方（Batch 97。docs/SECURITY.md の Batch 97 の節・docs/FOUNDER_TODO.md の決めてほしいことの 16） =====
//
// 1 か所にまとめる物: 版・登録所の integrity（tarball の sha512）・束の sha256・答えの sha256・配る URL、と tarball から束を作る手順。
// 使う所: api/auth-module.js（配信の関数）・tests/oldtab/lib/authLib.mjs（旧タブの証明と E2E が使う写し。同じ値・同じ作り方）・
//   js/supabase.js の読み先（AUTH_MODULE_URL と同じ字。scripts/test-auth-module.mjs が確かめる）。
// 作り方（ビルドの道具は使わない。リポジトリに配布物を入れない）:
//   1. 登録所の決まった tarball の URL（https。転送されたら行き着いた先も https か見る）から取る（5 秒で打ち切り〔本文を読む間も〕・
//      読みながら数え、2 MB を超えたらそこで読むのをやめる）
//   2. sha512 が固定の integrity と同じか（違えば止める。開く前に確かめる）
//   3. メモリの中で開く（ファイルに展開しない）。読むのは package/package.json（名前と版）・束（package/dist/umd/ の 1 ファイル）・LICENSE だけ
//   4. 束の末尾に export の行を足す（旧タブの証明と同じ作り方）→ sha256 が固定の値と同じか
//   5. 頭に配布物の LICENSE の文をそのまま注記にして足す → 答えの sha256 が固定の値と同じか
// どれかが違えば例外（code に短い理由。ログにはそれだけを書く）。呼ぶ側は答えない（503・保存させない）。
// 答えのバイトが変わるとき（版を上げる・束の作り方や注記を変える）: 下の 4 つの値を替える（node scripts/test-auth-module.mjs --print <版> が
// 登録所から作って出す）。配る URL には答えの sha256 の頭 8 字（h）が入るので URL も変わる。js/supabase.js の字を AUTH_MODULE_URL と同じにする
// （答えは 1 年保存させるので、同じ URL のまま答えを替えると、前に読んだ端末に届かない。scripts/test-auth-module.mjs の C1・C5 が見る）。
import crypto from "crypto";
import zlib from "zlib";

// 包みの名前と束の道（前からある識別子。登録所と tarball の中の名前のとおり）
export const AUTH_MODULE_PACKAGE = "@supabase/supabase-js";
export const AUTH_MODULE_BUNDLE = "package/dist/umd/supabase.js";
// 束の頭の字（配布元が作った 1 ファイルの束の形: <頭> … })({});）
export const AUTH_MODULE_BUNDLE_HEAD = "var supabase=(function(e){";
export const AUTH_MODULE_VERSION = "2.118.0";
// integrity = 登録所の dist.integrity（tarball の sha512）。body = 束と export の行の sha256（旧タブの証明の写しの注記の後ろと同じ）。
// served = 答え（LICENSE の注記 + body）の sha256
export const AUTH_MODULE_PIN = Object.freeze({
  version: AUTH_MODULE_VERSION,
  integrity: "sha512-FxI8UXMVC2UG7IkeiI8fuQZqq2oI3JeSuN8MPIC2RLVaoEAxKS0nqE6kii9Ewpq8f9gNPM6git1Y8f0vN/QLFw==",
  body: "9c5c59ecd5899a6c73c701400cb675ffb5bde827490a927c19ee222b5291eb91",
  served: "c1a6b90ccf0339dcee60c5a7f9dcf8390a02d7b66186c3297120a7bf24b5289b"
});
// 配る URL（同じオリジンの /api/ の下: Service Worker は /api/ を保存しない）。問いは版（v）と答えの印（h = 答えの sha256 の頭 8 字）。
// 答えは端末と配信の縁で 1 年保存させる（immutable）ので、答えのバイトが変われば URL も変わるようにする
export const AUTH_MODULE_PATH = "/api/auth-module";
export const AUTH_MODULE_TAG = AUTH_MODULE_PIN.served.slice(0, 8);
export const AUTH_MODULE_URL = `${AUTH_MODULE_PATH}?v=${AUTH_MODULE_VERSION}&h=${AUTH_MODULE_TAG}`;

// 登録所（固定。環境変数では替えない）
export const AUTH_MODULE_REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const sha512Integrity = (buf) => "sha512-" + crypto.createHash("sha512").update(buf).digest("base64");

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 登録所の tarball の URL（<登録所>/<包み>/-/<名前>-<版>.tgz）
export function tarballUrlOf(version, pkg = AUTH_MODULE_PACKAGE) {
  return `${AUTH_MODULE_REGISTRY}/${pkg}/-/${pkg.split("/").pop()}-${version}.tgz`;
}

export const isLicenseName = (n) => /^package\/licen[cs]e(\.(md|txt))?$/i.test(n);

// tarball（gzip の tar）を開いて、keep(名前) が真のふつうのファイルだけを返す。展開してファイルに書くことはしない
export function readTar(gz, keep) {
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

// 配布物の束から、ブラウザ用のモジュールの本体（束 + 末尾の export の行）を作る。旧タブの証明の写しの注記の後ろと同じ字
export function moduleBody(umdRaw) {
  const umd = umdRaw.replace(/\s+$/, "");
  if (!umd.startsWith(AUTH_MODULE_BUNDLE_HEAD) || !umd.endsWith("})({});")) throw fail("bundle_shape", "束の形が想定と違う（var <名前>=(function(e){ … })({});）");
  const tail = umd.slice(umd.lastIndexOf("e.createClient=") - 6000);
  const names = new Set();
  for (const m of tail.matchAll(/[,;(]e\.([A-Za-z_$][\w$]*)=/g)) names.add(m[1]);
  for (const m of tail.matchAll(/Object\.defineProperty\(e,`([A-Za-z_$][\w$]*)`/g)) names.add(m[1]);
  if (!names.has("createClient") || names.size < 30) throw fail("bundle_exports", `export の名前を読めない（${names.size} 個）`);
  const sorted = [...names].sort();
  const foot = [`export const { ${sorted.join(", ")} } = supabase;`, "export default supabase;"].join("\n");
  return { umd, body: `${umd}\n${foot}\n`, names: sorted.length };
}

// 答え: 配布物の LICENSE の文（そのまま。改行は \n にそろえ、前後の空白を除く）を注記にして、本体の前に置く。
// 注記を閉じる字・見えない字・ASCII でない字があれば作らない（固定の版の LICENSE は答えの sha256 で決まっている）
export function servedText(license, body) {
  const text = String(license ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text || text.includes("*/") || /[^\t\n\x20-\x7e]/.test(text)) throw fail("license", "LICENSE の文が無いか、注記にできない字がある");
  return `/*!\n${text}\n*/\n${body}`;
}

// tarball（確かめる前のバイト）から答えを作る。固定の値（pin）と 1 つでも違えば例外
export function buildFromTarball(tgz, pin = AUTH_MODULE_PIN) {
  if (sha512Integrity(tgz) !== pin.integrity) throw fail("tarball_hash", "tarball の sha512 が固定の値と違う");
  const files = readTar(tgz, (n) => n === "package/package.json" || n === AUTH_MODULE_BUNDLE || isLicenseName(n));
  let pkg = {};
  try {
    pkg = JSON.parse(files.get("package/package.json")?.toString("utf8") ?? "{}");
  } catch {
    pkg = {};
  }
  if (pkg.name !== AUTH_MODULE_PACKAGE || pkg.version !== pin.version) throw fail("package", "tarball の package.json の名前か版が違う");
  const umd = files.get(AUTH_MODULE_BUNDLE);
  if (!umd) throw fail("no_bundle", "tarball に束が無い");
  const { body } = moduleBody(umd.toString("utf8"));
  if (sha256(body) !== pin.body) throw fail("body_hash", "束の sha256 が固定の値と違う");
  const licenseName = [...files.keys()].find(isLicenseName);
  const served = servedText(licenseName ? files.get(licenseName).toString("utf8") : null, body);
  if (sha256(served) !== pin.served) throw fail("served_hash", "答えの sha256 が固定の値と違う");
  return { served: Buffer.from(served, "utf8"), body };
}

// 登録所から取って作る（配信の関数が 1 インスタンスで 1 回呼ぶ）。fetchImpl と pin は単体の検査が偽物を渡す
export async function buildAuthModule({ pin = AUTH_MODULE_PIN, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const url = tarballUrlOf(pin.version);
  if (!url.startsWith("https://")) throw fail("not_https");
  const timedOut = (e) => e?.name === "TimeoutError" || e?.name === "AbortError";
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { signal, redirect: "follow" });
  } catch (e) {
    throw fail(timedOut(e) ? "timeout" : "network");
  }
  if (!response?.ok) throw fail(`status_${Number(response?.status) || 0}`);
  if (response.url && !String(response.url).startsWith("https://")) throw fail("not_https");
  if (Number(response.headers?.get?.("content-length")) > maxBytes) throw fail("too_large");
  // 本文は読みながら数え、maxBytes を超えたらそこで読むのをやめる（長さの見出しが無い・偽りでも、全部をメモリーに読まない）
  const reader = response.body?.getReader?.();
  const chunks = [];
  let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) break;
      chunks.push(value);
    }
  } catch (e) {
    throw fail(timedOut(e) || signal.aborted ? "timeout" : "network");
  }
  if (size > maxBytes) {
    reader.cancel().catch(() => {});
    throw fail("too_large");
  }
  return buildFromTarball(Buffer.concat(chunks), pin);
}
