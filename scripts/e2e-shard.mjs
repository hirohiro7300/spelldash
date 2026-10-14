// E2E（tests/e2e.mjs）を組に分けて 1 組だけ流す。CI の並列ジョブ用（.github/workflows/ci.yml の matrix）
//
// 使い方:
//   node scripts/e2e-shard.mjs --shard 2/4   4 組のうち 2 組目を流す（npm run test:shard -- 2/4）
//   node scripts/e2e-shard.mjs --plan 4      組の分け方の表を出す（流さない）
//   node scripts/e2e-shard.mjs --check 4     全部の組の台本を作り、構文と「どの節もちょうど 1 つの組に入る」を確かめる（流さない）
//
// tests/e2e.mjs を 3 つに切る:
//   頭     … 最初の「// ===== 」の行の手前まで（import・偽のサーバー・check・waitUntil・newPage・ブラウザの起動）
//   節     … 「// ===== 」で始まる行から、次の同じ行（最後の節は後始末）の手前まで
//   後始末 … 最後の「await browser.close();」の行から終わりまで（件数の行と終了コード）
// 組 k の台本 = 頭 + 組 k の節（元の順） + 後始末。tests/ の下に一時ファイルとして書くので、頭の ROOT（import.meta.url から）や
// 節の中の import("../…") はそのまま動く。流し終えたら（中断されても）消す。
//
// 組の分け方は決定的（毎回同じ）: 節の重さ = CI で測った秒（下の SECONDS。節の名前 = 目印の行の「:」「（」の手前）。表に無い節
// （足した・名前を変えた）は行数 × 表の節の平均（秒／行）で見積もる。重い順（同じ重さなら前の節から）に、その時点でいちばん軽い組
// （同じなら番号の小さい組）へ入れる。行数や check( の数だけで分けると、1 行あたりの時間が節によって 1 桁違う（16.5 判定は打鍵の
// 間合いを待つので重い）ため、いちばん重い組が 1.5 倍に偏る（2026-10-11 の CI の秒で試算: 行数で 11.5 分・秒の表で 7.4 分）。
// 節はどれも { } の中で閉じていて、ページは newPage で毎回作り直すので単独で動く。前の節の変数・ページ・状態に頼る節を足すときは
// STICKY に書き、前の節と 1 かたまりで動かす。
// 組の中の節にかかった秒を最後に SECONDS の形で出す（CI の組のログから写せば表を更新できる）。件数の行（「N passed, M failed」）は
// 1 本のときと同じく最後の行。
//
// ローカルの npm test は 1 本のまま（並列で流すと負荷で時間に敏感な検査が揺れる）。

import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "tests", "e2e.mjs");
const MARK = /^\/\/ ===== /;
const TAIL = /^await browser\.close\(\);/;

// 前の節と同じ組に置く節（節の名前で照合）。今は無い（2026-10-11 に 4 組で全件を確かめた）
export const STICKY = [];

// 節ごとの CI の秒（2026-10-13、main の CI〔run 38417468654・872b15e〕の 4 組のログの「節ごとの秒」。4 組で 1,947 件・節の秒の和 2,527 秒）に、
// Batch 66 で足した検査の秒の見積もり（手元の秒 × その節の CI／手元の比）を足したもの: 7.5 +4・7.55 +2・7.6 +10・8.7 +63（ヘッダーの字が 1 行の検査）・8.8 +15（初回の書斎の CLS の検査）・9.9996 +5。
// PR #168 のレビューで足した検査の見積もり: 7.5 +3（2 ページの窓の間は打鍵で始まらない）・8.7 +9（フッターの名前・家へのリンクの名前・連続日数の見た目）・8.8 +16（語の記録の 4 通り・判定の写しの突き合わせ・静的な積み）。
// Batch 67 で足した検査の見積もり: 8.6 書斎 +10（壊れた語の記録）・8.7 +75（ヘッダーの部品の重なり・battle／profile／packs の細い幅・全ページの横スクロール）・9.5 学習データ +19・9.98 単語帳 +19・19 Pro +52（読み込みの CLS +25・config だけが遅いとき +27）・9.7 +6（ご意見の窓の殻）。
// 組の重さにだけ使う。ずれても落ちはせず、偏るだけ。節を足したら CI の組のログ（最後の「節ごとの秒」）から写す（表に無い節は行数で見積もる）
export const SECONDS = {
  "1. 全ページがエラーなく表示される": 27, "2. Study": 13, "2.5 日本語IME＋Studyキュー配置": 3,
  "2.6 1ミス＝不正解＋スペル表示": 3, "3. Daily Dash": 6, "4. ストリークカード＋苦手トグル＋ヘッダーストリーク表示": 6,
  "5. Challenge": 6, "6. モバイル": 7, "7. お知らせページ＋フッターリンク": 3,
  "7.5 タイピング練習": 192, "7.55 タイピング練習の長文": 91, "7.6 タイピングゲーム": 148,
  "8. テーマ": 4, "8.5 書斎の土台": 3, "8.6 書斎": 27,
  "8.6 わたしの本棚": 139, "8.7 書斎の皮": 184, "8.8 書斎の仕上げ": 71,
  "8.9 Batch 57": 160, "9. 難易度ゲート": 3, "9.3 Challengeの手触り": 6,
  "9.4 今日のセット": 24, "study 60s": 155, "9.5 学習データ": 21,
  "9.5 覚えた瞬間 v2": 7, "9.55 成長の証拠": 2, "9.56 記憶の保持率": 12,
  "mastery": 33, "mastery writers": 110, "9.6 マイ単語帳": 8,
  "9.7 学びの質": 16, "9.8 初回体験と継続": 73, "9.9 成長の証拠と獲得": 6,
  "9.95 Challenge・品質": 13, "9.97 概念カード「リスティング広告 実務」": 6, "9.98 単語帳": 28,
  "9.99 Batch 5a": 27, "9.995 Batch 5b": 19, "9.999 Batch 6": 13,
  "9.9995 Batch 7a": 13, "9.9996 Batch 8": 70, "Batch 58": 183,
  "Batch 58 ここまで": 0, "10. 新カテゴリ「広告・マーケ」": 0, "日本語の答えは読みをローマ字で打つ": 31,
  "11. レビュー修正": 28, "12. コース選択と制覇の演出": 10, "12.5 Batch 47": 4,
  "13. 道": 2, "14. 前回の続きから": 14, "15. ネイティブアプリ": 19,
  "16. 同じ訳の語には例文の訳を文脈として添える": 14, "16.5 判定": 480, "17. 答え表示後の操作が1行": 3,
  "18. プレイヤー管理 CRM": 9, "19. SpellDash Pro": 123, "チュートリアル": 26,
  "20. Batch 48": 44, "21. Pro までの動線の計測": 6, "21.5 タイピング練習から来た端末": 40,
  "21.6 タイピングゲームから来た端末": 41,
};

// 節の名前: 目印の行から「// ===== 」と末尾の「=====」を除き、最初の「:」「：」「（」「(」の手前
export const sectionKey = (title) => title.split(/[:：（(]/)[0].trim();

export function splitE2E(src) {
  const lines = src.split("\n");
  const first = lines.findIndex((l) => MARK.test(l));
  const tail = lines.findLastIndex((l) => TAIL.test(l));
  if (first < 0 || tail <= first) throw new Error("tests/e2e.mjs の頭（最初の「// ===== 」）か後始末（await browser.close();）が見つからない");
  const starts = [];
  for (let i = first; i < tail; i++) if (MARK.test(lines[i])) starts.push(i);
  const sections = starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : tail;
    const title = lines[start].replace(MARK, "").replace(/\s*=+\s*$/, "");
    return { index: k, line: start + 1, title, key: sectionKey(title), text: lines.slice(start, end).join("\n"), lines: end - start };
  });
  // 重さ（秒）: 表にある節は表の秒、無い節は行数 × 表にある節の秒／行
  const known = sections.filter((s) => Object.hasOwn(SECONDS, s.key));
  const knownLines = known.reduce((a, s) => a + s.lines, 0);
  const perLine = knownLines ? known.reduce((a, s) => a + SECONDS[s.key], 0) / knownLines : 1;
  for (const s of sections) {
    s.estimated = !Object.hasOwn(SECONDS, s.key);
    s.weight = s.estimated ? Math.round(s.lines * perLine) : SECONDS[s.key];
  }
  return { head: lines.slice(0, first).join("\n"), sections, tail: lines.slice(tail).join("\n") };
}

export function planShards(sections, total) {
  const units = [];
  for (const s of sections) {
    if (units.length && STICKY.includes(s.key)) units.at(-1).push(s.index);
    else units.push([s.index]);
  }
  const order = units
    .map((idx, k) => ({ idx, k, weight: idx.reduce((sum, i) => sum + sections[i].weight, 0) }))
    .sort((a, b) => b.weight - a.weight || a.k - b.k);
  const shards = Array.from({ length: total }, () => ({ weight: 0, idx: [] }));
  for (const unit of order) {
    let best = 0;
    for (let j = 1; j < total; j++) if (shards[j].weight < shards[best].weight) best = j;
    shards[best].weight += unit.weight;
    shards[best].idx.push(...unit.idx);
  }
  for (const s of shards) s.idx.sort((a, b) => a - b);
  return shards;
}

function buildScript({ head, sections, tail }, idx) {
  const lap = (title) => `__e2eShardLap(${JSON.stringify(title)});\n`;
  const timer = [
    "// ---- e2e-shard: 節ごとの秒（scripts/e2e-shard.mjs が足した。tests/e2e.mjs には無い） ----",
    "const __e2eShardTimes = [];",
    "function __e2eShardLap(title) {",
    "  const now = Date.now();",
    "  const last = __e2eShardTimes.at(-1);",
    "  if (last) last.ms = now - last.at;",
    "  if (title !== null) __e2eShardTimes.push({ title, at: now, ms: 0 });",
    "}",
    ""
  ].join("\n");
  const report = [
    "",
    "__e2eShardLap(null);",
    'console.log("\\n節ごとの秒（この組。scripts/e2e-shard.mjs の SECONDS の形）:");',
    'for (const t of __e2eShardTimes) console.log(`  ${JSON.stringify(t.title)}: ${Math.round(t.ms / 1000)},`);',
    ""
  ].join("\n");
  const body = idx.map((i) => lap(sections[i].key) + sections[i].text).join("\n");
  return `${head}\n${timer}\n${body}\n${report}\n${tail}`;
}

function parseShard(arg) {
  const m = /^(\d+)\/(\d+)$/.exec(arg ?? "");
  const k = m ? Number(m[1]) : NaN;
  const n = m ? Number(m[2]) : NaN;
  if (!(n >= 1 && k >= 1 && k <= n)) throw new Error(`組の指定は k/N（1 ≤ k ≤ N）: ${arg}`);
  return { k, n };
}

function tempPath(k, n) {
  return path.join(ROOT, "tests", `.e2e-shard-${k}of${n}-${process.pid}.mjs`);
}

function printPlan(parts, shards) {
  const n = shards.length;
  const est = parts.sections.filter((s) => s.estimated);
  console.log(`tests/e2e.mjs: 節 ${parts.sections.length} 個・重さ ${parts.sections.reduce((a, s) => a + s.weight, 0)} 秒を ${n} 組に（* = SECONDS に無く行数から見積もった節: ${est.length} 個）`);
  shards.forEach((s, j) => {
    console.log(`\n組 ${j + 1}/${n}（重さ ${s.weight} 秒・節 ${s.idx.length} 個）`);
    for (const i of s.idx) {
      const sec = parts.sections[i];
      console.log(`  ${String(sec.weight).padStart(4)}${sec.estimated ? "*" : " "} L${sec.line}  ${sec.title.slice(0, 70)}`);
    }
  });
}

function check(parts, n) {
  const shards = planShards(parts.sections, n);
  const seen = shards.flatMap((s) => s.idx).sort((a, b) => a - b);
  const once = seen.length === parts.sections.length && seen.every((v, i) => v === i);
  if (!once) throw new Error(`どの節もちょうど 1 つの組に入っていない: ${JSON.stringify(seen)}`);
  // 頭（最初の節の手前）は全部の組に入るので、そこに検査があると件数が組の数だけ水増しされる
  if (/(^|[^\w.])check\(/m.test(parts.head.replace(/^function check\(/m, ""))) throw new Error("tests/e2e.mjs の頭（最初の「// ===== 」の手前）に check( がある。検査は節の中に書く");
  let bad = 0;
  shards.forEach((s, j) => {
    const file = tempPath(j + 1, n);
    try {
      fs.writeFileSync(file, buildScript(parts, s.idx));
      const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (r.status !== 0) {
        bad++;
        console.error(`組 ${j + 1}/${n} の台本が構文で通らない（節の目印「// ===== 」が { } の中にある？）:\n${r.stderr}`);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
  if (bad) process.exit(1);
  console.log(`OK: ${n} 組（節 ${parts.sections.length} 個はどれもちょうど 1 つの組に入り、どの組の台本も構文が通る）`);
}

async function run(parts, k, n) {
  const shards = planShards(parts.sections, n);
  const mine = shards[k - 1];
  console.log(`E2E 組 ${k}/${n}: 節 ${mine.idx.length} 個（重さ ${mine.weight} 秒／全体 ${shards.reduce((a, s) => a + s.weight, 0)} 秒）`);
  for (const i of mine.idx) console.log(`  L${parts.sections[i].line}  ${parts.sections[i].title.slice(0, 70)}`);
  const file = tempPath(k, n);
  fs.writeFileSync(file, buildScript(parts, mine.idx));
  const cleanup = () => fs.rmSync(file, { force: true });
  process.on("exit", cleanup);
  const child = spawn(process.execPath, [file], { stdio: "inherit", env: process.env });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      child.kill(sig);
      cleanup();
      process.exit(130);
    });
  }
  const code = await new Promise((resolve) => child.on("close", (c, signal) => resolve(signal ? 1 : c ?? 1)));
  cleanup();
  process.exit(code);
}

// 直接呼ばれたときだけ動く（symlink を含むパスで呼ばれても実体のパスでそろえて比べる）
const realOf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
if (process.argv[1] && realOf(path.resolve(process.argv[1])) === realOf(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
    if (i < 0) return undefined;
    return args[i].includes("=") ? args[i].slice(name.length + 1) : args[i + 1];
  };
  const parts = splitE2E(fs.readFileSync(SRC, "utf8"));
  if (opt("--plan") !== undefined) {
    const n = Number(opt("--plan"));
    if (!(n >= 1)) throw new Error("--plan N（N ≥ 1）");
    printPlan(parts, planShards(parts.sections, n));
  } else if (opt("--check") !== undefined) {
    const n = Number(opt("--check"));
    if (!(n >= 1)) throw new Error("--check N（N ≥ 1）");
    check(parts, n);
  } else {
    const { k, n } = parseShard(opt("--shard") ?? args.find((a) => /^\d+\/\d+$/.test(a)));
    await run(parts, k, n);
  }
}
