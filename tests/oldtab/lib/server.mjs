// 1 つのオリジンの静的サーバー。配信の前は旧い木、deploy() の後は新しい木を返す（本番の配信の入れ替えと同じ: 開いているタブは読み込んだコードを持ち続け、
// その後の取得（動的 import・ページ遷移・Service Worker の更新）は新しい木のファイルを受ける）。
// 本番（配信の設定 vercel.json）に合わせること:
//   - 応答の headers: その時に配っている木の vercel.json の headers（source が合う物。少なくとも Content-Security-Policy）
//   - redirects: 同じく、host の条件の無い物（/packs・/list.html など）。permanent false は 307、true は 308
//   - 静的ファイルのキャッシュ: cache-control: public, max-age=0, must-revalidate と ETag（中身の sha1）。If-None-Match が合えば 304
//   - "/" は /index.html。ファイルが無ければ 404
// 製品の木の外のファイルは /__oldtab/ の下に置く（認証の部品: どちらの木も window.__SUPABASE_MODULE_URL で読む）。配信を替えても同じ物（本番の CDN と同じ）
// 読み直しの届かない旧いタブ: 問い（query）に oldtab-keep=<タブの名前> があるページは、配信の後の文書の要求（ページの読み直し）に 204 を返す。
//   ブラウザは 204 の文書を表示しないので、そのタブは旧いコードのまま残る（新しい木の sw.js が client.navigate で読み直そうとしても、
//   本番で読み直しが届かない凍った・裏の・通信の切れたタブと同じになる）。止めた読み直しは blocked に残す（誰が・いつ・どの道で）
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".ico": "image/x-icon", ".mp3": "audio/mpeg"
};

// vercel.json の source（経路の型の簡単な形だけ: /(.*)・/:name*・/:name・文字どおり）を正規表現に
function sourceToRegex(source) {
  let re = "";
  for (let i = 0; i < source.length; ) {
    const rest = source.slice(i);
    let m;
    if ((m = rest.match(/^\(\.\*\)/))) { re += "(.*)"; i += m[0].length; continue; }
    if ((m = rest.match(/^:([A-Za-z_]\w*)\*/))) { re += "(?<" + m[1] + ">.*)"; i += m[0].length; continue; }
    if ((m = rest.match(/^:([A-Za-z_]\w*)/))) { re += "(?<" + m[1] + ">[^/]+)"; i += m[0].length; continue; }
    re += source[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp("^" + re + "$");
}

function readDeployConfig(root) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
    return {
      headers: (v.headers ?? []).map((h) => ({ re: sourceToRegex(h.source), headers: h.headers ?? [] })),
      redirects: (v.redirects ?? []).filter((r) => !r.has && !r.missing).map((r) => ({ re: sourceToRegex(r.source), destination: r.destination, permanent: !!r.permanent }))
    };
  } catch {
    return { headers: [], redirects: [] };
  }
}

export async function startServer({ oldRoot, newRoot, extraFiles = {}, log = () => {} }) {
  const trees = { old: { root: path.resolve(oldRoot), cfg: readDeployConfig(oldRoot) }, new: { root: path.resolve(newRoot), cfg: readDeployConfig(newRoot) } };
  let current = "old";
  const served = []; // { t, tree, method, path, status }
  const blocked = []; // { t, keep, path, site, mode, dest }: 配信の後に止めた、読み直しの届かないタブの文書の要求
  const etagCache = new Map();

  function etagOf(file) {
    const st = fs.statSync(file);
    const key = `${file}:${st.size}:${st.mtimeMs}`;
    let tag = etagCache.get(key);
    if (!tag) {
      tag = '"' + crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex") + '"';
      etagCache.set(key, tag);
    }
    return tag;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let urlPath;
    try {
      urlPath = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const tree = trees[current];
    const send = (status, headers, body) => {
      served.push({ t: Date.now(), tree: current, method: req.method, path: urlPath, status });
      res.writeHead(status, headers);
      res.end(body);
    };
    // 読み直しの届かない旧いタブ（oldtab-keep=<名前>）の、配信の後のページの要求は 204（表示しない＝旧いコードのまま）。
    // 印はページの URL にだけある（部品の取得には付かない）。Service Worker が取り直す要求は Sec-Fetch-Dest が document でないことがあるので、道（/ と .html）で見る
    const keep = url.searchParams.get("oldtab-keep");
    if (keep && current === "new" && (urlPath === "/" || urlPath.endsWith(".html"))) {
      blocked.push({ t: Date.now(), keep, path: urlPath, site: req.headers["sec-fetch-site"] ?? null, mode: req.headers["sec-fetch-mode"] ?? null, dest: req.headers["sec-fetch-dest"] ?? null });
      return send(204, { "Cache-Control": "no-store" }, "");
    }
    const cfgHeaders = {};
    for (const h of tree.cfg.headers) if (h.re.test(urlPath)) for (const { key, value } of h.headers) cfgHeaders[key] = value;

    for (const r of tree.cfg.redirects) {
      const m = urlPath.match(r.re);
      if (!m) continue;
      let dest = r.destination.replace(/:([A-Za-z_]\w*)\*?/g, (_, name) => m.groups?.[name] ?? "");
      if (url.search && !dest.includes("?")) dest += url.search;
      return send(r.permanent ? 308 : 307, { ...cfgHeaders, Location: dest }, "");
    }

    // 本番の関数（/api/*）は持たない。加入の設定だけ「受付をしていない」と返し、ほかは 404（画面はどちらも静かに受け流す）
    if (urlPath.startsWith("/api/")) {
      if (urlPath === "/api/billing/config") return send(200, { ...cfgHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }, JSON.stringify({ configured: false }));
      return send(404, { ...cfgHeaders, "Content-Type": "application/json" }, JSON.stringify({ error: "not_found" }));
    }

    let file;
    // 製品の木の外のファイル。{ old, new } なら配っている木で替える（旧いタブだけに別の版の認証の部品を読ませる: run.mjs --old-auth-lib）
    if (extraFiles[urlPath]) file = typeof extraFiles[urlPath] === "string" ? extraFiles[urlPath] : extraFiles[urlPath][current];
    else {
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      file = path.resolve(tree.root, rel);
      if (!file.startsWith(tree.root + path.sep)) return send(404, cfgHeaders, "");
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, { ...cfgHeaders, "Content-Type": "text/plain" }, "not found");
    const etag = etagOf(file);
    const headers = { ...cfgHeaders, "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "public, max-age=0, must-revalidate", ETag: etag };
    if (req.headers["if-none-match"] === etag) return send(304, headers, "");
    if (req.method === "HEAD") return send(200, headers, "");
    return send(200, headers, fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    served,
    blocked,
    get current() { return current; },
    deploy() {
      current = "new";
      log(`配信を新しい木に替えた: ${trees.new.root}`);
    },
    close: () => new Promise((r) => server.close(() => r()))
  };
}
