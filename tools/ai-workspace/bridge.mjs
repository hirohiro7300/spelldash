#!/usr/bin/env node
// AI作業場の「中継役」
// このパソコンにある Claude Code・Codex・Muse Code を、それぞれのサブスクのログインのまま呼び出し、
// 作業場の画面（index.html）に答えを返す。API キーによる従量課金は使わない。
//
//   node bridge.mjs            起動して、ブラウザで作業場を開く（index.html と同じフォルダに置く）
//   node bridge.mjs --no-open  ブラウザを自動で開かない
//   node bridge.mjs --port 8788
//
// 安全のため:
//   ・このパソコンの中（127.0.0.1）からしかつながらない。ほかのサイトからは呼べない（Host・Origin・合言葉で確認）
//   ・各 AI は、毎回つくる空の作業フォルダで「答えを書くだけ」に絞って動かす（ファイルの読み書きやコマンドは使わせない）
//   ・ANTHROPIC_API_KEY など従量課金のキーは、各 AI に渡さない（サブスクのログインが使われる）
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argValue = (name, d) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(argValue("--port", process.env.AIWS_PORT || 8787));
const HOST = "127.0.0.1";
const OPEN = !argv.includes("--no-open") && process.env.AIWS_NO_OPEN !== "1";
const TOKEN = crypto.randomBytes(24).toString("hex");
const IS_WIN = process.platform === "win32";
const TIMEOUT_MS = Number(process.env.AIWS_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_BODY = 2 * 1024 * 1024;
const MAX_RUNNING = 4;
const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,100}$/;
// これらが子プロセスに渡ると、サブスクではなく API の従量課金（やクラウドの課金）で動いてしまうので外す
// （Claude Code は -p のとき ANTHROPIC_API_KEY があれば必ずそちらを使う。Muse Code も META_API_KEY を先に使う）
const STRIP_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY", "CODEX_API_KEY", "META_API_KEY"];
const CLAUDE_SYSTEM = "You are taking part in a group discussion run by a local tool. Read the user message and reply in plain text (Markdown is fine). Follow the instructions written there.";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("ポート番号が正しくありません。例: node bridge.mjs --port 8788");
  process.exit(2);
}
const INDEX = path.join(HERE, "index.html");
if (!fs.existsSync(INDEX)) {
  console.error(`index.html が見つかりません（${INDEX}）。bridge.mjs と index.html を同じフォルダに置いてください。`);
  process.exit(2);
}

/* ---------- 3つのアプリの呼び方 ---------- */
const CLIS = {
  claude: {
    label: "Claude Code",
    bin: process.env.AIWS_CLAUDE_BIN || "claude",
    login: "ターミナルで claude を起動し、/login で Claude のサブスクのアカウントにログイン",
    build: ({ model }) => ({
      args: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--tools", "", "--no-session-persistence", "--system-prompt", CLAUDE_SYSTEM, ...(model ? ["--model", model] : [])],
      stdin: true,
    }),
    parser: "claude",
  },
  codex: {
    label: "Codex",
    bin: process.env.AIWS_CODEX_BIN || "codex",
    login: "ターミナルで codex login を実行し、Sign in with ChatGPT でログイン",
    build: ({ model, effort }) => ({
      args: ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never",
        "--output-last-message", "last-message.txt", ...(model ? ["--model", model] : []),
        ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []), "-"],
      stdin: true,
      lastMessageFile: "last-message.txt",
    }),
    parser: "text",
  },
  muse: {
    label: "Muse Code",
    bin: process.env.AIWS_MUSE_BIN || "muse",
    login: "ターミナルで muse を起動し、ブラウザでのサインイン（Meta アカウント）を選ぶ",
    build: ({ model, effort, contributor }) => ({
      args: ["exec", "--prompt-file", "prompt.txt", "--no-session-log", "--disable-approval", "--max-model-steps", "8",
        ...(model ? ["--model", model] : []), ...(effort ? ["--reasoning-effort", effort] : []),
        ...(contributor ? ["--contributor-mode", contributor] : [])],
      promptFile: "prompt.txt",
    }),
    parser: "text",
  },
};

function childEnv() {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  env.NO_COLOR = "1";
  return env;
}
// Windows では claude.cmd のような起動ファイルをシェル経由で動かす。引数は決まった字か、確かめた字だけ
const winArg = (a) => (/^[A-Za-z0-9._:/@=-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
function spawnCli(bin, args, cwd) {
  if (IS_WIN) return spawn([bin, ...args].map(winArg).join(" "), { cwd, env: childEnv(), shell: true, windowsHide: true });
  return spawn(bin, args, { cwd, env: childEnv(), detached: true });
}
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (IS_WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    else process.kill(-child.pid, "SIGTERM");
  } catch { /* もう終わっている */ }
  if (!IS_WIN) setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* 終わった */ } }, 3000).unref();
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const tail = (s, n = 1500) => stripAnsi(String(s || "")).trim().slice(-n);

function explainFailure(def, stderr, code) {
  const s = stripAnsi(stderr || "");
  if (/not recognized as an internal or external command|command not found|ENOENT|No such file or directory.*\b(claude|codex|muse)\b/i.test(s)) {
    return `${def.label} が見つかりません。インストールして、ターミナルで動くか確かめてください。`;
  }
  if (/log ?in|sign ?in|not authenticated|unauthori[sz]ed|authentication|\b401\b|credential/i.test(s)) {
    return `${def.label} にログインしていないようです。${def.login}してください。`;
  }
  if (/usage limit|rate limit|limit reached|too many requests|\b429\b|quota/i.test(s)) {
    return `${def.label} のサブスクの利用上限に達したようです。時間をおいてからやり直してください。`;
  }
  return `${def.label} がエラーで終わりました（終了コード ${code}）。`;
}

/* ---------- 出力の読み取り ---------- */
// Claude Code の stream-json: 1行ずつ JSON。文字は stream_event の text_delta で少しずつ届き、最後に result が来る
function claudeParser(send) {
  let buf = "", streamed = "", assistant = "", result = null, limit = null;
  const line = (l) => {
    if (!l.trim()) return;
    let j;
    try { j = JSON.parse(l); } catch { return; }
    if (j.type === "stream_event") {
      const ev = j.event || {};
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) {
        streamed += ev.delta.text;
        send({ t: "delta", text: ev.delta.text });
      }
    } else if (j.type === "assistant" && j.message && Array.isArray(j.message.content)) {
      assistant = j.message.content.filter((b) => b && b.type === "text").map((b) => b.text).join("");
    } else if (j.type === "rate_limit_event" && j.rate_limit_info) {
      limit = j.rate_limit_info;
    } else if (j.type === "result") {
      result = j;
    }
  };
  return {
    push(chunk) { buf += chunk; let i; while ((i = buf.indexOf("\n")) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } },
    end() {
      line(buf); buf = "";
      if (result && (result.is_error || (result.subtype && result.subtype !== "success"))) {
        const why = typeof result.result === "string" ? result.result
          : Array.isArray(result.errors) && result.errors.length ? result.errors.join("\n") : (result.subtype || "error");
        return { error: { message: /log ?in|auth|credential|401/i.test(why) ? `Claude Code にログインしていないようです。${CLIS.claude.login}してください。` : "Claude Code がエラーを返しました。", detail: why } };
      }
      const text = result && typeof result.result === "string" ? result.result : (streamed || assistant);
      const u = result && result.usage;
      return {
        text,
        usage: u ? { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens ?? null } : null,
        limit: limit ? { type: limit.rateLimitType || "", utilization: typeof limit.utilization === "number" ? limit.utilization : null, status: limit.status || "", resetsAt: limit.resetsAt || null } : null,
      };
    },
  };
}
// Codex・Muse Code: 標準出力をそのまま答えとして流す（Codex は最後に答えだけのファイルも読む）
function textParser(send) {
  let all = "";
  return {
    push(chunk) { const t = stripAnsi(chunk); if (t) { all += t; send({ t: "delta", text: t }); } },
    end() { return { text: all }; },
  };
}

/* ---------- 1回分の呼び出し ---------- */
let running = 0;
const children = new Set();

async function ask(req, res, body) {
  const def = CLIS[body.cli];
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const effort = ["low", "high"].includes(body.effort) ? body.effort : "";
  const contributor = ["on", "off"].includes(body.contributor) ? body.contributor : "";
  if (!def) return json(res, 400, { error: "cli は claude・codex・muse のどれかにしてください。" });
  if (!prompt.trim()) return json(res, 400, { error: "prompt が空です。" });
  if (model && !MODEL_RE.test(model)) return json(res, 400, { error: "モデル名に使えない字が入っています。" });
  if (running >= MAX_RUNNING) return json(res, 429, { error: `同時に動かせるのは ${MAX_RUNNING} つまでです。少し待ってください。` });
  running++; // 待つ前に枠を取る（同時に届いても上限を超えない）
  const spec = def.build({ model, effort, contributor });
  let dir;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aiws-"));
    if (spec.promptFile) await fsp.writeFile(path.join(dir, spec.promptFile), prompt, "utf8");
  } catch (e) {
    running--;
    if (dir) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    return json(res, 500, { error: "作業用のフォルダを作れませんでした。", detail: String(e && e.message || e) });
  }

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.flushHeaders();
  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  const parser = def.parser === "claude" ? claudeParser(send) : textParser(send);
  const child = spawnCli(def.bin, spec.args, dir);
  children.add(child);
  let done = false, stderr = "";
  const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000);
  const cleanup = () => {
    if (done) return false;
    done = true;
    running--;
    children.delete(child);
    clearInterval(ping);
    clearTimeout(timer);
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    return true;
  };
  const finish = (obj) => { const stillOpen = !res.writableEnded; if (!cleanup()) return; if (stillOpen) { send(obj); res.end(); } };
  const timer = setTimeout(() => { killTree(child); finish({ t: "error", message: `時間切れになりました（${Math.round(TIMEOUT_MS / 60000)}分）。`, detail: "" }); }, TIMEOUT_MS);
  res.on("close", () => { if (!done) { killTree(child); cleanup(); } }); // 画面で「停止」を押した、またはタブを閉じた

  child.on("error", (e) => finish({ t: "error",
    message: e.code === "ENOENT" ? `${def.label} が見つかりません。インストールして、ターミナルで動くか確かめてください。` : `${def.label} を起動できませんでした。`,
    detail: String(e.message || e) }));
  child.stdin.on("error", () => {}); // すぐ終わったときの書き込みエラーは無視（終了コードで分かる）
  if (spec.stdin) child.stdin.end(prompt, "utf8"); else child.stdin.end();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => parser.push(d));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-8000); });
  child.on("close", async (code) => {
    if (done) return;
    const out = parser.end();
    let text = out.text || "";
    if (spec.lastMessageFile) {
      try { const t = await fsp.readFile(path.join(dir, spec.lastMessageFile), "utf8"); if (t.trim()) text = t; } catch { /* ファイルが無ければ標準出力を使う */ }
    }
    if (out.error) return finish({ t: "error", message: out.error.message, detail: [out.error.detail, tail(stderr)].filter(Boolean).join("\n") });
    if (code !== 0 && !text.trim()) return finish({ t: "error", message: explainFailure(def, stderr, code), detail: tail(stderr) || `exit ${code}` });
    finish({ t: "done", text: text.trim(), usage: out.usage || null, limit: out.limit || null,
      notice: code !== 0 ? `${def.label} の終わり方が正常ではありませんでした（終了コード ${code}）。答えが途中までかもしれません。` : "" });
  });
}

/* ---------- 状態（入っているか・ログインの種類） ---------- */
function runQuick(bin, args, ms = 15000) {
  return new Promise((resolve) => {
    let out = "", err = "", child;
    try { child = spawnCli(bin, args, os.tmpdir()); } catch (e) { resolve({ ok: false, out: "", err: String(e) }); return; }
    const timer = setTimeout(() => { killTree(child); resolve({ ok: false, out, err: err || "timeout" }); }, ms);
    child.stdin.end();
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (d) => { out += d; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out, err: String(e.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: stripAnsi(out).trim(), err: stripAnsi(err).trim() }); });
  });
}
let statusCache = null;
async function status(force) {
  if (statusCache && !force && Date.now() - statusCache.at < 30000) return statusCache.data;
  const entries = await Promise.all(Object.entries(CLIS).map(async ([id, def]) => {
    const v = await runQuick(def.bin, ["--version"]);
    const info = { id, label: def.label, installed: v.ok, version: v.ok ? (v.out.split("\n")[0] || "").slice(0, 80) : "", login: def.login, note: "" };
    if (id === "codex" && v.ok) {
      const s = await runQuick(def.bin, ["login", "status"]);
      const txt = `${s.out}\n${s.err}`;
      if (/api key/i.test(txt)) info.note = "API キーでログインしています（従量課金）。codex logout のあと codex login で ChatGPT のアカウントに入り直してください。";
      else if (/chatgpt/i.test(txt)) info.note = "ChatGPT のアカウントでログイン中";
      else if (!s.ok) info.note = "ログインしていないようです。codex login を実行してください。";
    }
    return [id, info];
  }));
  const keys = STRIP_ENV.filter((k) => process.env[k]);
  statusCache = { at: Date.now(), data: { ok: true, clis: Object.fromEntries(entries), strippedKeys: keys } };
  return statusCache.data;
}

/* ---------- HTTP ---------- */
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const goodHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const goodOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
function tokenOk(req) {
  const got = Buffer.from(String(req.headers["x-aiws-token"] || ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!goodHosts.has(String(req.headers.host || ""))) return json(res, 403, { error: "bad host" }); // DNS リバインディング対策
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith("/api/")) {
      const origin = req.headers.origin;
      if (origin && !goodOrigins.has(origin)) return json(res, 403, { error: "bad origin" });
      if (!tokenOk(req)) return json(res, 403, { error: "bad token" });
      if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, await status(url.searchParams.has("refresh")));
      if (req.method === "POST" && url.pathname === "/api/ask") {
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { error: "JSON で送ってください。" });
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.message === "too_large" ? 413 : 400, { error: e.message === "too_large" ? "会話が長すぎます。" : "JSON が読めません。" }); }
        return await ask(req, res, body || {});
      }
      return json(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = (await fsp.readFile(INDEX, "utf8")).replace(/<head>/i, `<head>\n<meta name="aiws-bridge" content="${TOKEN}">`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
      return res.end(html);
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: "中継役でエラーが起きました。", detail: String(e && e.message || e) });
    else res.end();
  }
});

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", [url]] : IS_WIN ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref(); } catch { /* 開けなくてもよい */ }
}

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `ポート ${PORT} はほかのアプリが使っています。node bridge.mjs --port 8788 のように別の番号で起動してください。` : `起動できませんでした: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, async () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`\nAI作業場の中継役を起動しました → ${url}`);
  console.log("（このウィンドウを閉じるか Ctrl+C で止まります）\n");
  const st = await status(true);
  for (const c of Object.values(st.clis)) console.log(`  ${c.installed ? "✓" : "✗"} ${c.label.padEnd(12)} ${c.installed ? c.version : "見つかりません"}${c.note ? `  … ${c.note}` : ""}`);
  if (st.strippedKeys.length) console.log(`\n  ※ ${st.strippedKeys.join("・")} が設定されていますが、従量課金にならないよう各 AI には渡しません。`);
  console.log("");
  if (OPEN) openBrowser(url);
});
const shutdown = () => { for (const c of children) killTree(c); server.close(); setTimeout(() => process.exit(0), 300).unref(); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
