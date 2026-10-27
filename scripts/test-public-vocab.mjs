// 公開する英単語の表（scripts/build-public-vocab.mjs → data/public/english.json）の単体テスト。ブラウザなしで 1 秒ほどで終わる:
//   node scripts/test-public-vocab.mjs
// 失敗が 1 つでもあれば終了コード 1。教材とファイルは書き換えず、読んだ JSON の写しを壊して流す（コマンドの検査だけ一時の木に写す）。
// 確かめること:
//   1. 今の教材とファイルは決まりどおり（問題 0・語数と機能語の数は定数どおり・補助の語は頭・機能語は最後・順位の列・作り直しても同じ）
//   2. 教材の写しを壊すと落ちる: 1 語を消す・巻の中の 2 語を入れ替える・id を重ねる・count をずらす・札を fn に変える／外す・
//      補助の語を後ろの巻へ動かす・補助の語を ngsl01 の中で頭の外へ動かす・5月の項目を ngsl01 の末尾に足す・CSV の語が欠ける・
//      巻が manifest に無い。5月の項目を月の並びに足すと、落ちるのは語数だけ（順位 0。助動詞の may の順位を拾わない）
//   3. ファイルの写しを壊すと落ちる: 機能語を途中に置く・2 語を入れ替える・id を重ねる・total をずらす・順位をずらす・
//      rank が 1 個足りない・24 巻に無い id・古いファイル（1 語少ない／空白だけ違う）・ファイルが無い・JSON でない
//   4. コマンド: 今の木の --check は exit 0。写しの木で、1 語を消した教材は --check も書き直しも exit 1（書かない）、
//      古いファイルは --check が exit 1 で、書き直すと exit 0 になり今のファイルと同じになる。巻が JSON でないと exit 1 で巻の名前を出す
//   5. 語数の数字は生成器の定数 1 か所だけ（この台本は数字を書かず定数を読む）
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { EXPECTED_TOTAL, EXPECTED_FN, PACKS, OUT_REL, SOURCE, loadInputs, buildPublicVocab, checkPublicVocab } from "./build-public-vocab.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SCRIPTS, "..");
const GEN = path.join(SCRIPTS, "build-public-vocab.mjs");

let passed = 0;
const failures = [];
function ok(name, cond, info = "") {
  if (cond) passed++;
  else failures.push(`${name}${info ? `\n    ${info}` : ""}`);
}
const show = (problems) => JSON.stringify(problems.slice(0, 6));
// problems のどれかが re に当たる
const has = (problems, re) => problems.some((p) => re.test(p));

const base = loadInputs();
const fileText = fs.readFileSync(path.join(ROOT, OUT_REL), "utf8");
const copy = () => structuredClone(base);
const wordsOf = (inputs, pack) => inputs.packs[pack].words;
const entryOf = (inputs, pack) => inputs.manifest.subjects.find((s) => s.id === "english").categories.find((c) => c.id === pack);
const take = (inputs, pack, id) => {
  const words = wordsOf(inputs, pack);
  const i = words.findIndex((w) => w.id === id);
  if (i < 0) throw new Error(`${pack} に ${id} が無い（検査の前提が崩れた）`);
  return words.splice(i, 1)[0];
};

// ── 1. 今の教材とファイル ─────────────────────────
const real = checkPublicVocab(base, fileText);
const { data } = real;
ok("今の教材とファイルは問題 0", real.problems.length === 0, show(real.problems));
ok("語数は定数どおり（total・order・rank）", data.total === EXPECTED_TOTAL && data.order.length === EXPECTED_TOTAL && data.rank.length === EXPECTED_TOTAL);
ok("機能語の数は定数どおり", data.fnLast === EXPECTED_FN);
ok("作り直しても同じ文字列", buildPublicVocab(copy()).text === real.text && real.text === fileText);
ok("頭の欄: v 1・id english・label 英単語・24 巻", data.v === 1 && data.id === "english" && data.label === "英単語" && JSON.stringify(data.packs) === JSON.stringify(PACKS) && PACKS.length === 24);
const fnIds = new Set(real.cards.filter((c) => c.fn).map((c) => c.id));
const tail = data.order.slice(-EXPECTED_FN);
const headPart = data.order.slice(0, -EXPECTED_FN);
ok("最後の機能語の数だけが機能語で、その前に機能語が無い", tail.every((id) => fnIds.has(id)) && headPart.every((id) => !fnIds.has(id)));
const csvWords = base.csv.split(/\r?\n/).slice(1).filter((l) => l.trim()).length;
const extra = data.rank.filter((r) => r === 0).length;
ok("NGSL の CSV の語はどれも順位つきで表にあり、残りが補助の語", data.rank.filter((r) => r > 0).length === csvWords && extra === EXPECTED_TOTAL - csvWords && extra > 0);
ok("補助の語（順位 0）は並びの頭にまとまる", data.rank.slice(0, extra).every((r) => r === 0) && data.rank.slice(extra).every((r) => r > 0));
const rising = (list) => list.every((r, i) => i === 0 || r > list[i - 1]);
ok("機能語でない語・機能語のそれぞれで、順位は上がる一方", rising(data.rank.slice(extra, -EXPECTED_FN)) && rising(data.rank.slice(-EXPECTED_FN)));
ok("並びの頭は ngsl01 の補助の語（zero から）", data.order[0] === "english-zero" && data.order.slice(0, extra).every((id) => real.cards.find((c) => c.id === id)?.pack === "ngsl01"));
ok(
  "出典の欄: NGSL 1.2・作者・CC BY-SA 4.0 とその URL・配布元・変えたこと（補助の語と機能語の数）",
  Object.entries(SOURCE).every(([k, v]) => data.source[k] === v) &&
    data.source.license === "CC BY-SA 4.0" &&
    data.source.changes.includes(`${extra} 語を足した`) &&
    data.source.changes.includes(`機能語 ${EXPECTED_FN} 語は最後`),
  JSON.stringify(data.source)
);

// ── 2. 教材の写しを壊す ──────────────────────────
{
  const m = copy();
  take(m, "ngsl05", "english-film");
  const p = buildPublicVocab(m).problems;
  ok(
    "1 語を消す（ngsl05 の film）: count・NGSL の語・語数で落ちる",
    has(p, /ngsl05: manifest の count/) && has(p, /NGSL の語が表に無い english-film/) && has(p, /^語数 /),
    show(p)
  );
}
{
  const m = copy();
  const w = wordsOf(m, "ngsl03");
  [w[0], w[5]] = [w[5], w[0]];
  const p = buildPublicVocab(m).problems;
  ok("巻の中の 2 語を入れ替える（ngsl03）: 順位の逆で落ちる", has(p, /NGSL の順位が逆 .*ngsl03/), show(p));
}
{
  const m = copy();
  wordsOf(m, "ngsl24").push(structuredClone(wordsOf(m, "ngsl01").find((w) => w.id === "english-they")));
  entryOf(m, "ngsl24").count++;
  const p = buildPublicVocab(m).problems;
  ok("id を重ねる（ngsl24 に they。count も合わせる）: 重なりと語数で落ちる", has(p, /id が重なる english-they/) && has(p, /^語数 /), show(p));
}
{
  const m = copy();
  entryOf(m, "ngsl10").count--;
  const p = buildPublicVocab(m).problems;
  ok("manifest の count をずらす（ngsl10）: count で落ちる", has(p, /ngsl10: manifest の count/), show(p));
}
{
  const m = copy();
  wordsOf(m, "ngsl10")[0].tags[0] = "fn";
  const r = checkPublicVocab(m, fileText);
  ok("札を fn に変える（ngsl10 の頭）: 機能語の数と生成物の違いで落ちる", has(r.problems, /^機能語 .* 語（決定は/) && has(r.problems, /生成物と違う/), show(r.problems));
}
{
  const m = copy();
  wordsOf(m, "ngsl01").find((w) => w.id === "english-the").tags[0] = "n";
  const p = buildPublicVocab(m).problems;
  ok("札の fn を外す（the）: 機能語の数で落ちる", has(p, /^機能語 .* 語（決定は/), show(p));
}
{
  const m = copy();
  wordsOf(m, "ngsl02").push(take(m, "ngsl01", "english-zero"));
  entryOf(m, "ngsl01").count--;
  entryOf(m, "ngsl02").count++;
  const p = buildPublicVocab(m).problems;
  ok("補助の語を後ろの巻へ動かす（zero を ngsl02 の末尾。count も合わせる）: 頭の外で落ちる", has(p, /NGSL に無い語が ngsl01 の頭の外にある english-zero/), show(p));
}
{
  // 巻は同じで語数も変わらない。順位つきの語の後ろに来たら頭の外
  const m = copy();
  wordsOf(m, "ngsl01").push(take(m, "ngsl01", "english-december"));
  const p = buildPublicVocab(m).problems;
  ok("補助の語を ngsl01 の中で頭の外へ動かす（december を ngsl01 の末尾）: 頭の外で落ちる", has(p, /NGSL に無い語が ngsl01 の頭の外にある english-december（ngsl01）/), show(p));
}
// 5月を助動詞の may と別の項目にする形（返事待ち。足すなら月の並びに置く）。順位は id で引くので en が may でも順位 0
const mayMonth = () => ({ id: "english-may-month", en: "may", tags: ["n"] });
{
  const m = copy();
  wordsOf(m, "ngsl01").push(mayMonth());
  entryOf(m, "ngsl01").count++;
  const p = buildPublicVocab(m).problems;
  ok("5月の項目を ngsl01 の末尾に足す（count も合わせる）: 頭の外と語数で落ちる", has(p, /NGSL に無い語が ngsl01 の頭の外にある english-may-month（ngsl01）/) && has(p, /^語数 /), show(p));
}
{
  const m = copy();
  const w = wordsOf(m, "ngsl01");
  w.splice(w.findIndex((x) => x.id === "english-april") + 1, 0, mayMonth());
  entryOf(m, "ngsl01").count++;
  const b = buildPublicVocab(m);
  ok(
    "5月の項目を april の後に足す（count も合わせる）: 頭の外にも順位の逆にもならず、語数で落ちる。順位は 0",
    !has(b.problems, /頭の外|順位が逆/) && has(b.problems, /^語数 /) && b.cards.find((c) => c.id === "english-may-month")?.rank === 0,
    show(b.problems)
  );
}
{
  const m = copy();
  m.csv = m.csv.trimEnd().split("\n").slice(0, -1).join("\n") + "\n";
  const p = buildPublicVocab(m).problems;
  ok("CSV の最後の語が欠ける（thirst）: その語が補助の語の扱いになり、頭の外で落ちる", has(p, /NGSL に無い語が ngsl01 の頭の外にある english-thirst/), show(p));
}
{
  const m = copy();
  const cats = m.manifest.subjects.find((s) => s.id === "english").categories;
  cats.splice(cats.findIndex((c) => c.id === "ngsl24"), 1);
  const p = buildPublicVocab(m).problems;
  ok("manifest に巻が無い（ngsl24）: 巻と語数で落ちる", has(p, /manifest に ngsl24 が無い/) && has(p, /^語数 /), show(p));
}

// ── 3. ファイルの写しを壊す ─────────────────────────
const tableOf = (edit) => {
  const t = JSON.parse(fileText);
  edit(t);
  return checkPublicVocab(base, JSON.stringify(t)).problems;
};
{
  const p = tableOf((t) => {
    const i = t.order.indexOf("english-the");
    t.order.splice(1000, 0, t.order.splice(i, 1)[0]);
    t.rank.splice(1000, 0, t.rank.splice(i, 1)[0]);
  });
  ok("機能語を途中に置く（the を 1000 番目へ）: 機能語が途中で落ちる", has(p, /機能語が途中にある english-the（1000 番目/), show(p));
}
{
  const p = tableOf((t) => {
    [t.order[100], t.order[200]] = [t.order[200], t.order[100]];
    [t.rank[100], t.rank[200]] = [t.rank[200], t.rank[100]];
  });
  ok("並びの 2 語を入れ替える（順位も一緒に）: 巻の順で落ちる", has(p, /巻の順と違う/), show(p));
}
{
  const p = tableOf((t) => {
    t.order[5] = t.order[4];
  });
  ok("id を重ねる（5 番目を 4 番目と同じに）: 重なりと無い id で落ちる", has(p, /order で id が重なる/) && has(p, /order に無い id/), show(p));
}
{
  const p = tableOf((t) => {
    t.total--;
  });
  ok("total をずらす: 欄 total で落ちる", has(p, /欄 total が生成物と違う/) && has(p, /^total .* と order の/), show(p));
}
{
  const p = tableOf((t) => {
    t.rank[3000 % t.rank.length]++;
  });
  ok("順位を 1 つずらす: 順位で落ちる", has(p, /順位が違う/), show(p));
}
{
  const p = tableOf((t) => {
    t.rank.pop();
  });
  ok("rank が 1 個足りない: rank の数で落ちる", has(p, /^rank が .* 個（order は/), show(p));
}
{
  const p = tableOf((t) => {
    t.order[10] = "english-nonexistent";
  });
  ok("order の 1 語を 24 巻に無い id に替える: 無い id と抜けた id で落ちる", has(p, /order に 24 巻に無い id がある english-nonexistent/) && has(p, /^order に無い id /), show(p));
}
{
  const p = checkPublicVocab(base, fileText.replace(/\n {4}"english-film",/, "")).problems;
  ok("古いファイル（film が無い）: 無い id・語数・生成物の違いで落ちる", has(p, /order に無い id english-film/) && has(p, /^order が .* 語（決定は/) && has(p, /生成物と違う/), show(p));
}
{
  const p = checkPublicVocab(base, fileText.replace(/\n}\n$/, "\n}\n\n")).problems;
  ok("古いファイル（空白だけ違う）: 生成物の違いの 1 件だけで落ちる", p.length === 1 && has(p, /生成物と違う/), show(p));
}
{
  const p = checkPublicVocab(base, null).problems;
  ok("ファイルが無い: 落ちる", has(p, /が無い（node scripts\/build-public-vocab\.mjs で作る）/), show(p));
}
{
  const p = checkPublicVocab(base, fileText.slice(0, 500)).problems;
  ok("JSON でない（途中で切れた）: 落ちる", has(p, /JSON として読めない/) && has(p, /生成物と違う/), show(p));
}

// ── 4. コマンド ────────────────────────────────
const cli = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [GEN, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
};
{
  const r = cli("--check");
  ok("今の木の --check は exit 0", r.code === 0 && r.out.startsWith("OK:"), r.out.slice(-300));
}
{
  // 写しの木: 生成器が読むファイルだけ（manifest・24 巻・CSV・表）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spelldash-public-"));
  try {
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), text);
    };
    const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
    const packRel = (id) => path.join("data", entryOf(base, id).file);
    put("data/manifest.json", src("data/manifest.json"));
    for (const id of PACKS) put(packRel(id), src(packRel(id)));
    put("data/sources/ngsl/NGSL_1.2_stats.csv", base.csv);
    put(OUT_REL, fileText);
    const at = `--root=${tmp}`;
    const a = cli("--check", at);
    ok("写しの木（壊す前）の --check は exit 0", a.code === 0, a.out.slice(-300));

    const pack = JSON.parse(src(packRel("ngsl05")));
    pack.words = pack.words.filter((w) => w.id !== "english-film");
    put(packRel("ngsl05"), JSON.stringify(pack));
    const b = cli("--check", at);
    ok("1 語を消した教材: --check は exit 1 で理由を出す", b.code === 1 && b.out.includes("english-film") && b.out.includes("ngsl05: manifest の count"), b.out.slice(-400));
    const c = cli(at);
    ok("1 語を消した教材: 書き直しも exit 1 で、ファイルを書かない", c.code === 1 && c.out.includes("書かない") && fs.readFileSync(path.join(tmp, OUT_REL), "utf8") === fileText, c.out.slice(-300));

    put(packRel("ngsl05"), src(packRel("ngsl05")));
    put(OUT_REL, fileText.replace(/\n {4}"english-film",/, ""));
    const d = cli("--check", at);
    ok("古いファイル: --check は exit 1", d.code === 1 && d.out.includes("生成物と違う"), d.out.slice(-300));
    const e = cli(at);
    const f = cli("--check", at);
    ok("古いファイル: 書き直すと exit 0 で今のファイルと同じになり、--check も通る", e.code === 0 && e.out.startsWith("書いた:") && f.code === 0 && fs.readFileSync(path.join(tmp, OUT_REL), "utf8") === fileText, e.out + f.out);

    put(packRel("ngsl07"), src(packRel("ngsl07")).slice(0, 200));
    const g = cli("--check", at);
    ok("巻が JSON でない（ngsl07 が途中で切れた）: --check は exit 1 で巻の名前を出す", g.code === 1 && g.out.includes(`ngsl07: data/${entryOf(base, "ngsl07").file} が読めない`) && !g.out.includes("SyntaxError"), g.out.slice(-400));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 5. 語数の数字は 1 か所 ───────────────────────────
{
  const genSrc = fs.readFileSync(GEN, "utf8");
  const total = Number(genSrc.match(/^export const EXPECTED_TOTAL = (\d+);/m)?.[1]);
  const digits = String(total);
  const re = new RegExp(`(?<![\\d,])${digits.slice(0, -3)},?${digits.slice(-3)}(?![\\d,])`, "g");
  const inGen = genSrc.match(re)?.length ?? 0;
  const inTest = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").match(re)?.length ?? 0;
  ok("語数の数字は生成器の定数の 1 か所だけ（この台本には無い）", total === EXPECTED_TOTAL && inGen === 1 && inTest === 0, `生成器 ${inGen} か所・単体 ${inTest} か所`);
}

// ── 結果 ─────────────────────────────────────────
if (failures.length) {
  console.error(`test-public-vocab: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-public-vocab: ${passed} passed`);
