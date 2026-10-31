// 旧い木（直前の本番）と新しい木を用意する（どちらも置き場か git の ref）。
//   旧い木: --old <dir> ならその置き場、ほかは git の ref（0507672・origin/main・FETCH_HEAD など）として git archive で取り出す（中身は本番に配った物そのまま）
//   新しい木: --new <dir>（既定はこの検査が入っている木）。--mutant を付けると、新しい木の写しに変異を当てた物（lib/mutants.mjs）
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

export function cacheDir() {
  const dir = process.env.OLDTAB_CACHE || path.join(os.tmpdir(), "spelldash-oldtab");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ref を git archive で取り出す（同じ commit は 1 度だけ）。戻り値: { root, commit }
export function prepareOldTree(spec, repo) {
  if (fs.existsSync(spec) && fs.statSync(spec).isDirectory()) return { root: path.resolve(spec), commit: null, from: "dir" };
  const commit = execFileSync("git", ["-C", repo, "rev-parse", "--verify", `${spec}^{commit}`], { encoding: "utf8" }).trim();
  const root = path.join(cacheDir(), `old-${commit.slice(0, 12)}`);
  if (!fs.existsSync(path.join(root, ".oldtab-complete"))) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", commit], { maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", root], { input: tar, maxBuffer: 1 << 30 });
    fs.writeFileSync(path.join(root, ".oldtab-complete"), commit + "\n");
  }
  return { root, commit, from: "git" };
}

// 新しい木の commit（分かれば）と、作業中の変更があるか
export function describeTree(root) {
  try {
    const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--", "js", "*.html", "sw.js", "vercel.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

// 木を写す（製品のファイルだけ: html・js・css・data・assets・sw.js・manifest・vercel.json など。node_modules・tests・.git は写さない）
export function copyTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const skip = new Set([".git", "node_modules", "tests", "android", "ios", "docs", "scripts", "supabase", "api"]);
  for (const name of fs.readdirSync(src)) {
    if (skip.has(name)) continue;
    fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true, dereference: false });
  }
  return dst;
}
