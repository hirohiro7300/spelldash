// 配る HTML の inline の script と、vercel.json の Content-Security-Policy（Batch 88。docs/SECURITY.md）。
// script-src は 'self'・配る HTML の inline の script の本文の sha256 全部・https://esm.sh だけ（'unsafe-inline' なし）。
// 検査は scripts/test-site-map.mjs の 8。inline の script を 1 字でも直したら、次のコマンドが出す script-src を vercel.json に写す:
//   node scripts/lib/csp.mjs           今の木の配る HTML から作った script-src の値（1 行）と、ハッシュごとのファイルの数
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isMain } from "./is-main.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// 配る HTML（配信は .vercelignore の物を配らない。.git と node_modules も配らない）。{ 道（/ 区切り）: HTML }
export function servedHtml(root = ROOT) {
  let ignore = [];
  try {
    ignore = fs.readFileSync(path.join(root, ".vercelignore"), "utf8").split("\n").map((l) => l.trim().replace(/\/+$/, "")).filter((l) => l && !l.startsWith("#"));
  } catch {}
  const skip = new Set([".git", "node_modules", ...ignore]);
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (skip.has(rel) || skip.has(e.name)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".html")) out[rel] = fs.readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

// HTML の inline の script（ブラウザが走らせる物だけ: src なし・type なしか JS の型）の本文。ブラウザは本文の字（タグの間の字のまま）の sha256 で比べる
export function inlineScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    if (/(^|\s)src\s*=/i.test(attrs)) continue;
    const type = attrs.match(/(?:^|\s)type\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue;
    out.push(m[2]);
  }
  return out;
}

export const scriptHash = (body) => `'sha256-${crypto.createHash("sha256").update(body, "utf8").digest("base64")}'`;

// vercel.json の全体のヘッダー（source "/(.*)"）: [{ key, value }]
export function globalHeaders(vercelJsonText) {
  const conf = JSON.parse(vercelJsonText);
  return (conf.headers ?? []).find((h) => h.source === "/(.*)")?.headers ?? [];
}

// 全体のヘッダーの Content-Security-Policy を指示ごとに（"script-src 'self' …" の並び）
export function cspDirectives(vercelJsonText) {
  const value = globalHeaders(vercelJsonText).find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  return value.split(";").map((d) => d.trim()).filter(Boolean);
}

// 配る HTML から作る script-src の値（ハッシュは最初に出たファイルの順）と、ハッシュ → ファイルの並び
export function expectedScriptSrc(html) {
  const where = new Map();
  for (const file of Object.keys(html).sort()) {
    for (const body of inlineScripts(html[file])) {
      const hash = scriptHash(body);
      if (!where.has(hash)) where.set(hash, []);
      where.get(hash).push(file);
    }
  }
  return { value: ["script-src", "'self'", ...where.keys(), "https://esm.sh"].join(" "), where };
}

if (isMain(import.meta.url)) {
  const { value, where } = expectedScriptSrc(servedHtml());
  console.log(value);
  for (const [hash, files] of where) console.error(`${hash} ${files.length} ファイル（${files.slice(0, 3).join("・")}${files.length > 3 ? "…" : ""}）`);
}
