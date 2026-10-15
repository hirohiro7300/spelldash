// 教材の品質の規則を全部流し、基準線（scripts/quality/baseline.json）と比べる（docs/PACK_FORMAT.md「品質の規則と基準線」）。
//   node scripts/quality/check.mjs                  比べる。誤り（error）の規則で次のどれかがあれば exit 1（CI）
//                                                     ・新しい当たり: 基準線に無いカードに当たった（新しく足したカード・直したつもりのカードを含む）
//                                                     ・数が増えた: 当たりのカードの数が基準線より多い
//                                                     ・基準線が古い: 基準線のカードがもう当たらない（直した）→ --update で下げて同じ PR に入れる
//                                                   警告（warn）・情報（info）の規則は数を出すだけで落とさない
//   node scripts/quality/check.mjs --base=<木>      上に加えて、前の木（PR の向け先。<木>/data/ と <木>/scripts/quality/baseline.json を読む）と比べる（CI の PR）:
//                                                     ・変わったカードに新しい当たり: 基準線にもうあるカードを PR で変え、前の木では出なかった
//                                                       当たり（中身 detail が違うもの）が出た（漢字の別表記を足したのに読みが無い、など）。
//                                                       前の木の教材も今のコードと規則で流すので、違いは教材の変更から来たものだけ。
//                                                       基準線に無いカードは上の「新しい当たり」が見る
//                                                     ・基準線を上げた: 誤りの規則で、向け先の基準線に無いカードを今の基準線に足した（数を上げた）。
//                                                       向け先の基準線に無い規則（PR で足した規則）と、向け先の教材でも今のコードと規則で当たるカード
//                                                       （規則・判定器を変えて見つかった、前からある当たり）は除く
//   node scripts/quality/check.mjs --update         基準線を書き直す。誤りの規則は下げるだけ（もう当たらないカードを消す。新しい当たりは足さない）。
//                                                   警告・情報の規則は今の当たりに合わせる（落とさない規則。数の推移を基準線の差分で見る）
//   node scripts/quality/check.mjs --update=Q03,Q04 その規則だけ書き直す
//   node scripts/quality/check.mjs --update --add=Q05  その規則は今の当たりで書き直す（新しい当たりも足す）。新しい規則を基準線に入れるとき、
//                                                   規則・判定器を変えて前からの教材に当たりが見つかったときだけ（教材の変更から来た当たりは
//                                                   CI の PR で「基準線を上げた」で落ちる。直す）。--add Q05 とも書ける
//   node scripts/quality/check.mjs --only=Q03,Q04   その規則だけ流す（比べ方は同じ）
//   node scripts/quality/check.mjs --list=Q04       その規則の当たりを 1 行ずつ出す（カード・中身）
//   node scripts/quality/check.mjs --json           結果を JSON で出す
//
// 規則は scripts/quality/rules/<id>.mjs に 1 つ 1 ファイル（置けば登録される）:
//   export default { id, level: "error" | "warn" | "info", describe, run(ctx) → [{ card: "カテゴリ id:カード id", detail, group? }] }
//   ctx は scripts/quality/ctx.mjs（全カード・manifest・カテゴリごとのカード・別解の索引を作る関数）。
//   同じカードに何度当たっても 1 枚と数える。group（任意）は「組」の数も出したいとき（同じ例文・同じ id など）
// 基準線は { "<規則 id>": ["カテゴリ id:カード id", ...] }（並べ替え済み。パックそのものの当たりは "<パック id>:*"）。
// 基準線はカードの一覧だけなので、基準線にもうあるカードに当たりの中身が増えても、基準線だけでは気づけない。それを --base が見る
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadContext, ROOT } from "./ctx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES_DIR = path.join(HERE, "rules");
export const BASELINE = path.join(HERE, "baseline.json");
const LEVELS = ["error", "warn", "info"];

const idOrder = (a, b) => {
  const k = (id) => [id[0] === "Q" ? 0 : id[0] === "P" ? 1 : 2, id];
  const [x, y] = [k(a), k(b)];
  return x[0] - y[0] || x[1].localeCompare(y[1], "en", { numeric: true });
};

export async function loadRules(dir = RULES_DIR) {
  const rules = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    const r = mod.default;
    const where = `scripts/quality/rules/${f}`;
    if (!r || typeof r !== "object") throw new Error(`${where}: export default が無い`);
    if (r.id !== f.replace(/\.mjs$/, "")) throw new Error(`${where}: id（${r.id}）がファイル名と違う`);
    if (!LEVELS.includes(r.level)) throw new Error(`${where}: level は ${LEVELS.join("・")} のどれか（${r.level}）`);
    if (typeof r.describe !== "string" || !r.describe) throw new Error(`${where}: describe が無い`);
    if (typeof r.run !== "function") throw new Error(`${where}: run(ctx) が無い`);
    rules.push(r);
  }
  return rules.sort((a, b) => idOrder(a.id, b.id));
}

// 規則を流す → [{ id, level, describe, ms, hits: Map(card → [detail]), groups: number | null }]
export async function runRules(ctx, rules) {
  const out = [];
  for (const r of rules) {
    const t0 = performance.now();
    const list = await r.run(ctx);
    const ms = performance.now() - t0;
    if (!Array.isArray(list)) throw new Error(`${r.id}: run(ctx) が配列を返さない`);
    const hits = new Map();
    const groups = new Set();
    let grouped = false;
    for (const h of list) {
      if (!h || typeof h.card !== "string" || !/^[^:\s]+:\S+$/.test(h.card)) throw new Error(`${r.id}: 当たりの card は "カテゴリ id:カード id"（${JSON.stringify(h)}）`);
      if (!hits.has(h.card)) hits.set(h.card, []);
      if (h.detail != null) hits.get(h.card).push(String(h.detail));
      if (h.group != null) {
        grouped = true;
        groups.add(String(h.group));
      }
    }
    out.push({ id: r.id, level: r.level, describe: r.describe, ms, hits, groups: grouped ? groups.size : null });
  }
  return out;
}

// 基準線と比べる → 規則ごとの { before, now, added[], removed[], fail[] } と、落とす理由の一覧
// changed（任意）= compareWithBase の byRule（規則 → 変わったカードに出た新しい当たり）。あれば「変わったカードに新しい当たり」でも落とす
// raised（任意）= compareWithTargetBaseline の結果（規則 → 向け先の基準線から上げた分）。あれば「基準線を上げた」でも落とす
export function compareWithBaseline(results, baseline, { partial = false, changed = null, raised = null } = {}) {
  const rows = [];
  const failures = [];
  for (const r of results) {
    const known = Object.prototype.hasOwnProperty.call(baseline, r.id);
    const base = new Set(known ? baseline[r.id] : []);
    const added = [...r.hits.keys()].filter((c) => !base.has(c)).sort();
    const removed = [...base].filter((c) => !r.hits.has(c)).sort();
    const grown = r.level === "error" ? changed?.get(r.id) ?? [] : [];
    const up = r.level === "error" ? raised?.get(r.id) ?? null : null;
    const fail = [];
    if (r.level === "error") {
      if (added.length) fail.push(`新しい当たり ${added.length} 枚`);
      if (r.hits.size > base.size) fail.push(`数が増えた（${base.size} → ${r.hits.size}）`);
      if (removed.length) fail.push(`基準線が古い（もう当たらない ${removed.length} 枚。--update=${r.id} で下げる）`);
      if (grown.length) fail.push(`変わったカードに新しい当たり ${grown.length} 枚（基準線にあるカード。前の木では出なかった中身）`);
      if (up?.added.length) fail.push(`基準線を上げた（向け先 ${up.before} → 今 ${up.after}。向け先の基準線に無いカード ${up.added.length} 枚を足した）`);
    }
    const raisedCards = up?.added ?? [];
    const fromCode = up?.fromCode ?? [];
    rows.push({ id: r.id, level: r.level, describe: r.describe, known, before: base.size, now: r.hits.size, groups: r.groups, added, removed, grown, raised: raisedCards, fromCode, fail, ms: r.ms });
    if (fail.length) failures.push(`${r.id}: ${fail.join("・")}`);
  }
  if (!partial) {
    const ran = new Set(results.map((r) => r.id));
    for (const id of Object.keys(baseline)) if (!ran.has(id)) failures.push(`${id}: 基準線にあるのに規則のファイルが無い（--update で消す）`);
  }
  return { rows, failures };
}

// 前の木（base）と今の木（head）で中身が違うカードの ref（両方にあるカードだけ。足したカード・消したカードは入らない）。
// 生のカード（card.raw）か読み込んだ形（ファイルの頭の欄から来るものを含む）が違えば変わった。パックそのもの（"<パック id>:*"）は words のほかの欄で見る
export function changedRefs(baseCtx, headCtx) {
  const out = new Set();
  const sig = (w) => JSON.stringify(w.raw) + "\u0000" + JSON.stringify(w);
  for (const w of headCtx.cards) {
    const b = baseCtx.cardByRef.get(w.ref);
    if (b && sig(b) !== sig(w)) out.add(w.ref);
  }
  const head = (file) => JSON.stringify({ ...file, words: undefined });
  for (const [id, file] of headCtx.files) {
    const b = baseCtx.files.get(id);
    if (b && head(b) !== head(file)) out.add(headCtx.packRef(id));
  }
  return out;
}

// 変わったカードに出た新しい当たり（PR を通す条件「変わったカードに新しい当たり 0」のうち、基準線の比べ方では拾えない分）:
// 誤りの規則ごとに、基準線にもうあって PR で変わったカードについて、前の木の教材に同じ規則を流した当たりの中身（detail）と比べ、
// 前に無かった中身があれば新しい当たり（同じ中身が 2 度なら 2 度目も新しい）。前の木で当たっていなかったカード（--update で基準線に
// 足した＝残すと決めた当たり）と、基準線に無いカード（compareWithBaseline の「新しい当たり」が見る）は見ない。
// baseCtx は今のコード（js/・規則）で前の木の data/ を読んだもの（loadContext({ dataRoot })）。前の木を流すのは当てはまるカードがある規則だけ
// → { changed: Set(ref), byRule: Map(規則 id → [{ card, added: [detail] }]), ranBase: [規則 id] }
export async function compareWithBase(headCtx, headResults, baseCtx, rules, baseline) {
  const changed = changedRefs(baseCtx, headCtx);
  const targets = new Map();
  for (const r of headResults) {
    if (r.level !== "error") continue;
    const inBaseline = new Set(baseline[r.id] ?? []);
    const cards = [...r.hits.keys()].filter((c) => changed.has(c) && inBaseline.has(c));
    if (cards.length) targets.set(r.id, cards);
  }
  const byRule = new Map();
  if (!targets.size) return { changed, byRule, ranBase: [] };
  const baseResults = await runRules(baseCtx, rules.filter((r) => targets.has(r.id)));
  for (const [id, cards] of targets) {
    const head = headResults.find((x) => x.id === id);
    const base = baseResults.find((x) => x.id === id);
    const list = [];
    for (const card of cards.sort()) {
      const before = base.hits.get(card);
      if (!before) continue;
      const left = new Map();
      for (const d of before) left.set(d, (left.get(d) ?? 0) + 1);
      const added = [];
      for (const d of head.hits.get(card)) {
        if (left.get(d) > 0) left.set(d, left.get(d) - 1);
        else added.push(d);
      }
      if (added.length) list.push({ card, added });
    }
    if (list.length) byRule.set(id, list);
  }
  return { changed, byRule, ranBase: [...targets.keys()] };
}

// 基準線を上げていないか（CI の PR。target = 向け先の基準線〔--base の木の scripts/quality/baseline.json〕、current = 今の基準線）。
// 誤りの規則ごとに、向け先の基準線に無いのに今の基準線にあるカードを出す（数を上げたのはこのカードがあるときだけ。基準線はカードの集まり）。
// 向け先の基準線に無い規則（PR で足した規則）は見ない。足したカードのうち、向け先の教材（baseCtx = 今のコードで前の木の data/ を読んだもの）
// にも今の規則で当たるもの（規則・判定器を変えて見つかった、前からある当たり）は fromCode に分けて落とさない。前の木を流すのは足したカードがある規則だけ
// → Map(規則 id → { before, after, added: [落とすカード], fromCode: [落とさないカード] })
export async function compareWithTargetBaseline(target, current, rules, baseCtx) {
  const pending = new Map();
  for (const r of rules) {
    if (r.level !== "error" || !Object.prototype.hasOwnProperty.call(target, r.id)) continue;
    const before = new Set(target[r.id]);
    const now = current[r.id] ?? [];
    pending.set(r.id, { before: before.size, after: now.length, cards: now.filter((c) => !before.has(c)) });
  }
  const need = rules.filter((r) => pending.get(r.id)?.cards.length);
  const baseResults = need.length ? await runRules(baseCtx, need) : [];
  const out = new Map();
  for (const [id, p] of pending) {
    const hits = baseResults.find((x) => x.id === id)?.hits ?? new Map();
    out.set(id, { before: p.before, after: p.after, added: p.cards.filter((c) => !hits.has(c)).sort(), fromCode: p.cards.filter((c) => hits.has(c)).sort() });
  }
  return out;
}

// --update で書く基準線。誤りの規則は下げるだけ: 前の基準線のカードのうち、今も当たるものだけを残す（新しい当たりは足さない）。
// add にある規則は今の当たりにする（新しい規則を入れる・規則や判定器を変えて見つかった前からの当たりを足す）。
// 警告・情報の規則は今の当たりにする（落とさない規則。数の推移を基準線の差分で見る）。
// only（任意）があればその規則（と add の規則）だけ書き直す。無ければ、規則のファイルが無い基準線の行も消す
export function updateBaseline(results, prev = {}, { only = null, add = null } = {}) {
  const next = { ...prev };
  for (const r of results) {
    if (only && !only.has(r.id) && !add?.has(r.id)) continue;
    const now = [...r.hits.keys()].sort();
    if (r.level !== "error" || add?.has(r.id)) next[r.id] = now;
    else {
      const before = new Set(prev[r.id] ?? []);
      next[r.id] = now.filter((c) => before.has(c));
    }
  }
  if (!only) for (const id of Object.keys(next)) if (!results.some((r) => r.id === id)) delete next[id];
  const sorted = {};
  for (const id of Object.keys(next).sort(idOrder)) sorted[id] = next[id];
  return sorted;
}

export function readBaseline(file = BASELINE) {
  if (!fs.existsSync(file)) return {};
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [id, list] of Object.entries(b)) if (!Array.isArray(list)) throw new Error(`baseline.json: ${id} が配列でない`);
  return b;
}

const fmt = (n) => n.toLocaleString("en-US");

function printTable(rows, ctx, seconds) {
  console.log(`品質の規則（scripts/quality/check.mjs）: カード ${fmt(ctx.cards.length)} 枚・規則 ${rows.length}・${seconds.toFixed(1)} 秒`);
  const w = Math.max(...rows.map((r) => r.id.length), 4);
  console.log(`  ${"規則".padEnd(w - 1)} 段     基準線 → 今      新   減  ms    中身`);
  for (const r of rows) {
    const nums = `${r.known ? fmt(r.before) : "—"} → ${fmt(r.now)}`.padStart(15);
    const grp = r.groups != null ? `（${fmt(r.groups)} 組）` : "";
    const mark = r.fail.length ? " ←" : "";
    console.log(`  ${r.id.padEnd(w)} ${r.level.padEnd(5)} ${nums} ${String(r.added.length).padStart(4)} ${String(r.removed.length).padStart(4)} ${String(Math.round(r.ms)).padStart(4)}  ${r.describe}${grp}${mark}`);
  }
}

async function main() {
  // --add Q05（空白で区切った形）は --add=Q05 と同じ
  const args = process.argv.slice(2).flatMap((a, i, all) => (a === "--add" && all[i + 1] && !all[i + 1].startsWith("--") ? [`--add=${all[i + 1]}`] : all[i - 1] === "--add" && !a.startsWith("--") ? [] : [a]));
  const opt = (name) => {
    const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
    if (!a) return null;
    return a.includes("=") ? a.slice(a.indexOf("=") + 1) : true;
  };
  const idList = (v) => (typeof v === "string" ? new Set(v.split(",").map((s) => s.trim()).filter(Boolean)) : null);
  const known = ["update", "add", "only", "list", "json", "root", "baseline", "base"];
  const unknown = args.filter((a) => !known.some((k) => a === `--${k}` || a.startsWith(`--${k}=`)));
  if (unknown.length) {
    console.error(`知らない引数: ${unknown.join(" ")}（使い方は scripts/quality/check.mjs の先頭）`);
    process.exit(2);
  }
  const t0 = performance.now();
  const root = typeof opt("root") === "string" ? opt("root") : ROOT;
  const baselineFile = typeof opt("baseline") === "string" ? path.resolve(opt("baseline")) : BASELINE;
  const ctx = await loadContext({ root });
  let rules = await loadRules();
  const only = idList(opt("only"));
  const list = opt("list");
  if (typeof list === "string") rules = rules.filter((r) => r.id === list);
  else if (only) rules = rules.filter((r) => only.has(r.id));
  if (!rules.length) {
    console.error("流す規則が無い（--only・--list の id を確かめる）");
    process.exit(2);
  }
  const add = opt("add") ? idList(opt("add")) : null;
  if (opt("add") && (!add?.size || !opt("update"))) {
    console.error("--add=<規則> は --update と一緒に使う（--update --add=Q05。その規則の新しい当たりも基準線に足す）");
    process.exit(2);
  }
  for (const id of add ?? []) {
    if (!rules.some((r) => r.id === id)) {
      console.error(`--add: 規則 ${id} を流していない（規則の id・--only を確かめる）`);
      process.exit(2);
    }
  }
  const results = await runRules(ctx, rules);
  const seconds = (performance.now() - t0) / 1000;
  const baseline = readBaseline(baselineFile);

  if (typeof list === "string") {
    const r = results[0];
    const base = new Set(baseline[r.id] ?? []);
    for (const [card, details] of [...r.hits].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`${base.has(card) ? " " : "+"} ${card}\t${details.join(" ／ ")}`);
    for (const card of [...base].filter((c) => !r.hits.has(c)).sort()) console.log(`- ${card}\t（もう当たらない）`);
    console.log(`${r.id}: ${fmt(r.hits.size)} 枚（基準線 ${fmt(base.size)}）`);
    return;
  }

  const update = opt("update");
  if (update) {
    const subset = idList(update) ?? only;
    const next = updateBaseline(results, baseline, { only: subset, add });
    fs.writeFileSync(baselineFile, JSON.stringify(next, null, 2) + "\n");
    const { rows } = compareWithBaseline(results, baseline, { partial: true });
    printTable(rows, ctx, seconds);
    const has = (id) => Object.prototype.hasOwnProperty.call(baseline, id);
    const changed = rows.filter((r) => JSON.stringify(next[r.id] ?? null) !== JSON.stringify(has(r.id) ? baseline[r.id] : null));
    console.log(`基準線を書き直した: ${path.relative(process.cwd(), baselineFile) || baselineFile}${changed.length ? `（${changed.map((r) => `${r.id} ${has(r.id) ? fmt(baseline[r.id].length) : "—"} → ${fmt(next[r.id].length)}`).join("・")}）` : "（変わりなし）"}`);
    const kept = rows.filter((r) => r.level === "error" && (!subset || subset.has(r.id)) && !add?.has(r.id) && r.added.length);
    if (kept.length) {
      console.log(`誤りの規則の新しい当たりは基準線に足していない（--update は下げるだけ）: ${kept.map((r) => `${r.id} ${fmt(r.added.length)} 枚`).join("・")}`);
      console.log("  直す。足すのは、新しい規則と、規則・判定器を変えて前からの教材に見つかった当たりだけ（--update --add=<規則>。教材の変更から来た当たりは CI の PR で「基準線を上げた」で落ちる）");
    }
    return;
  }

  // --base: 前の木の data/ を今のコードで読み、変わったカードに出た新しい当たりを見る
  let vsBase = null;
  const baseOpt = opt("base");
  if (baseOpt === true) {
    console.error("--base=<前の木> と木の根を渡す（その木の data/ を読む）");
    process.exit(2);
  }
  if (typeof baseOpt === "string") {
    const baseRoot = path.resolve(baseOpt);
    const targetFile = path.join(baseRoot, "scripts", "quality", "baseline.json");
    for (const f of [path.join(baseRoot, "data", "manifest.json"), targetFile]) {
      if (!fs.existsSync(f)) {
        console.error(`--base: ${f} が無い（前の木の根を渡す。git archive <向け先> data scripts/quality/baseline.json | tar -x -C <木>）`);
        process.exit(2);
      }
    }
    const baseCtx = await loadContext({ root, dataRoot: baseRoot });
    vsBase = await compareWithBase(ctx, results, baseCtx, rules, baseline);
    vsBase.raised = await compareWithTargetBaseline(readBaseline(targetFile), baseline, rules, baseCtx);
  }
  const allSeconds = (performance.now() - t0) / 1000;
  const { rows, failures } = compareWithBaseline(results, baseline, { partial: Boolean(only), changed: vsBase?.byRule ?? null, raised: vsBase?.raised ?? null });
  if (opt("json")) {
    const base = vsBase && { changedCards: vsBase.changed.size, ranBase: vsBase.ranBase, raised: Object.fromEntries([...vsBase.raised].filter(([, x]) => x.added.length || x.fromCode.length)) };
    console.log(JSON.stringify({ cards: ctx.cards.length, seconds: allSeconds, ok: failures.length === 0, failures, base, rules: rows.map(({ ms, ...r }) => ({ ...r, ms: Math.round(ms) })) }, null, 1));
    process.exitCode = failures.length ? 1 : 0; // exit() は標準出力を書き切る前に終わることがある（パイプ）
    return;
  }
  printTable(rows, ctx, allSeconds);
  if (vsBase) {
    const grown = [...vsBase.byRule.values()].reduce((n, l) => n + l.length, 0);
    console.log(`前の木（${baseOpt}）と比べた: 変わったカード ${fmt(vsBase.changed.size)} 枚。そのうち基準線にあって新しい中身の当たりが出たカード ${fmt(grown)} 枚`);
    const ups = [...vsBase.raised].filter(([, x]) => x.added.length || x.fromCode.length);
    console.log(`  向け先の基準線と比べた: ${ups.length ? ups.map(([id, x]) => `${id} ${fmt(x.before)} → ${fmt(x.after)}（足したカード ${fmt(x.added.length + x.fromCode.length)} 枚${x.fromCode.length ? `。うち向け先の教材でも当たる ${fmt(x.fromCode.length)} 枚は落とさない` : ""}）`).join("・") : "誤りの規則の基準線は上げていない"}`);
  }
  if (!failures.length) {
    console.log(`OK: 誤りの規則で新しい当たりなし・基準線は最新${vsBase ? "・変わったカードに新しい当たりなし・基準線を上げていない" : ""}`);
    return;
  }
  console.log(`NG: ${failures.length} 件`);
  for (const f of failures) console.log(`  ${f}`);
  for (const r of rows.filter((x) => x.fail.length)) {
    const res = results.find((x) => x.id === r.id);
    for (const c of r.added.slice(0, 30)) console.log(`    + ${c}  ${(res.hits.get(c) ?? []).join(" ／ ")}`);
    if (r.added.length > 30) console.log(`    …ほか ${r.added.length - 30} 枚（--list=${r.id}）`);
    for (const c of r.removed.slice(0, 10)) console.log(`    - ${c}  （もう当たらない）`);
    if (r.removed.length > 10) console.log(`    …ほか ${r.removed.length - 10} 枚`);
    for (const g of r.grown.slice(0, 30)) console.log(`    * ${g.card}  ${g.added.join(" ／ ")}`);
    if (r.grown.length > 30) console.log(`    …ほか ${r.grown.length - 30} 枚`);
    for (const c of r.raised.slice(0, 30)) console.log(`    ^ ${c}  （向け先の基準線に無い。向け先の教材では当たらない）`);
    if (r.raised.length > 30) console.log(`    …ほか ${r.raised.length - 30} 枚`);
  }
  console.log("直し方: 新しい当たりは直す（--update は下げるだけで足さない）。直して減ったら --update で基準線を下げて同じ PR に入れる");
  console.log("  新しい規則を足した・規則や判定器を変えて前からの教材に当たりが見つかったときだけ --update --add=<規則> で足し、PR に理由を書く");
  if (rows.some((r) => r.grown.length)) console.log("  * は基準線にもうあるカードを変えて出た当たり。基準線はカードの一覧なので --update では残せない。そのカードの変更を直す");
  if (rows.some((r) => r.raised.length)) console.log("  ^ は向け先の基準線に無いのに今の基準線に足したカード（教材の変更から来た当たり）。誤りの規則の基準線は上げない。基準線から外し、カードを直す");
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exitCode = 2;
  });
}
