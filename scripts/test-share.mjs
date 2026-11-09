// マイ単語帳を人に渡す（Batch 84。docs/SPEC_MY_WORDS.md §13）の単体: 渡す code の作り方と読み方（js/myWordsShare.js）・文字で渡す形・
// 新しい単語帳の名前（js/myWordsCore.js uniqueBookName）・渡された語を足す（js/myWords.js addSharedWords）・URL を送る所に # の後ろを入れない・privacy.html の 1 行。
// 使い方: node scripts/test-share.mjs
// 先に書いた検査（Batch 84 の前の木には js/myWordsShare.js も addSharedWords も無い）: 読めない module・関数は 1 件ずつの失敗に数える（止まらない）
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import * as C from "../js/myWordsCore.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
// 投げても 1 件の失敗に数える（前の木で関数が無いとき）
async function t(name, fn) {
  try {
    const r = await fn();
    if (r === true) ok(name, true);
    else ok(name, false, typeof r === "string" ? r : JSON.stringify(r));
  } catch (e) {
    ok(name, false, `投げた: ${String(e?.message ?? e).slice(0, 160)}`);
  }
}

let X = null;
try {
  X = await import("../js/myWordsShare.js");
} catch (e) {
  console.log(`(js/myWordsShare.js を読めない: ${String(e?.message ?? e).slice(0, 120)})`);
}
ok("js/myWordsShare.js を読める（純な module。この台本から直に読める）", !!X);
const S = X ?? {};

const B64 = (bytes) => Buffer.from(bytes).toString("base64url");
const plain = (obj) => `j1.${B64(Buffer.from(JSON.stringify(obj), "utf8"))}`;
const zipped = (obj) => `z1.${B64(zlib.deflateRawSync(Buffer.from(JSON.stringify(obj), "utf8")))}`;
const reasonOf = async (code) => (await S.decodeShare(code)).reason ?? "ok";

// ===== 決めた値 =====
await t("決めた値: 版 1・頭の印 z1. と j1.・語は 1,000 語まで（Pro の上限）・JSON 1,100,000 バイト・code 1,500,000 字・長いリンクの目安 8,000 字・#share=", () =>
  S.SHARE_VERSION === 1 && S.SHARE_ZIP === "z1." && S.SHARE_PLAIN === "j1." && S.SHARE_MAX_WORDS === C.MY_PRO_LIMIT && S.SHARE_MAX_WORDS === 1000 &&
  S.SHARE_MAX_JSON === 1_100_000 && S.SHARE_MAX_CODE === 1_500_000 && S.SHARE_LONG_LINK === 8000 && S.SHARE_PARAM === "share" && S.SHARE_PATH === "/mywords.html");

// ===== base64url =====
await t("base64url: 0〜70 バイトの往復が台本の側の base64url と同じ（= なし）", () => {
  for (let n = 0; n <= 70; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 255);
    const s = S.toBase64Url(bytes);
    if (s !== B64(bytes)) return `enc n=${n}`;
    const back = S.fromBase64Url(s);
    if (!back || Buffer.compare(Buffer.from(back), Buffer.from(bytes)) !== 0) return `dec n=${n}`;
  }
  return true;
});
await t("base64url: 1 MB の往復", () => {
  const bytes = Uint8Array.from({ length: 1 << 20 }, (_, i) => (i * 2654435761) >>> 24);
  const back = S.fromBase64Url(S.toBase64Url(bytes));
  return !!back && back.length === bytes.length && Buffer.compare(Buffer.from(back), Buffer.from(bytes)) === 0;
});
await t("base64url: 読めない形は null（使えない字・+ / =・全角・長さの余り 1・最後の字の余りのビット）", () =>
  ["ab$c", "ab+c", "ab/c", "abc=", "ａｂｃｄ", "abcde", "a", "AB", "ABD"].every((s) => S.fromBase64Url(s) === null) && S.fromBase64Url("AA")?.length === 1 && S.fromBase64Url("AAA")?.length === 2);

// ===== URL の # =====
await t("#share=<code> から code を取る・ほかの # は null・#share= だけは空（読めないリンク）・%xx は戻す", () =>
  S.shareCodeOf("#share=z1.AbC-_") === "z1.AbC-_" && S.shareCodeOf("") === null && S.shareCodeOf("#myWords") === null && S.shareCodeOf("#back=%2F") === null &&
  S.shareCodeOf("#share=") === "" && S.shareCodeOf("#share=z1%2Eabc") === "z1.abc" && S.shareCodeOf("#xshare=z1.a") === null);
await t("リンク: <origin>/mywords.html#share=<code>（Web は今の origin・アプリは本番の origin を画面が渡す）", () =>
  S.shareLinkOf("https://www.spelldash.net", "z1.abc") === "https://www.spelldash.net/mywords.html#share=z1.abc" && S.shareLinkOf("http://127.0.0.1:5000", "j1.x") === "http://127.0.0.1:5000/mywords.html#share=j1.x");

// ===== 渡す中身（単語帳 1 冊） =====
const BOOKS = [{ id: "main", name: "マイ単語帳" }, { id: "w1", name: "仕事" }];
const LONG_EN = `${"word ".repeat(29)}words`; // 150 字
const LONG_JA = "長".repeat(150);
const LIST = [
  { en: "invoice", ja: "請求書", addedAt: "2026-11-01T00:00:00.000Z", ls: 2, lsAt: 5, lsd: 20400 }, // マイ単語帳（book なし）
  { en: "up", ja: "上がる", book: "w1", bookName: "仕事", addedAt: "2026-11-02T00:00:00.000Z", ls: 1, lsAt: 9 },
  { en: "up~94a018a8", text: "up", ja: "下がる", book: "w1", bookName: "仕事", addedAt: "2026-11-03T00:00:00.000Z", ls: 2 },
  { en: "kpi", text: "KPI", ja: "重要業績評価指標", book: "w1", bookName: "仕事" },
  { en: "due diligence", ja: "適正評価、買う前の調べ, とも", book: "w1", bookName: "仕事" },
  { en: LONG_EN, ja: LONG_JA, book: "w1", bookName: "仕事" },
  { en: "english", ja: "英語", book: "w1", bookName: "仕事" },
  { en: "q", ja: "\"引用\"", book: "w1", bookName: "仕事" },
  { kind: "concept", en: "ssl", q: "通信を暗号化する", answer: "SSL", explain: "", accept: [], ja: "", book: "w1" },
  { en: "café", ja: "喫茶店", book: "w1", bookName: "仕事" } // 前の版で入った、今の決まりに合わない語
];
let share = null;
await t("渡す中身: 今の単語帳（仕事）の英語の語だけ・画面の形の英語（鍵 up~<印> は入れない）と訳・足した順・場面カードと決まりに合わない語は数えて外す", () => {
  share = S.bookShare(LIST, "w1", BOOKS);
  const want = [["up", "上がる"], ["up", "下がる"], ["KPI", "重要業績評価指標"], ["due diligence", "適正評価、買う前の調べ, とも"], [LONG_EN, LONG_JA], ["english", "英語"], ["q", "\"引用\""]];
  return (share.name === "仕事" && JSON.stringify(share.words) === JSON.stringify(want) && share.scenes === 1 && share.invalid === 1 && share.over === false) || JSON.stringify(share);
});
await t("渡す中身: 3 状態・鍵・id・日付・単語帳の id・アカウントの欄は入らない（JSON の字に ~・ls・addedAt・book・w1・2026 が無い）", async () => {
  const { code } = await S.encodeShare(share, { zip: false });
  const json = Buffer.from(code.slice(3), "base64url").toString("utf8");
  const v = JSON.parse(json);
  return (Object.keys(v).join() === "v,n,w" && !/~|"ls|lsAt|lsd|addedAt|"book|bookName|w1|2026|main|user|email/.test(json) && v.w.every((e) => Array.isArray(e) && e.length === 2)) || json.slice(0, 200);
});
await t("渡す中身: 最初の単語帳（book の無い前からの語）も渡せる", () => {
  const s = S.bookShare(LIST, "main", BOOKS);
  return (s.name === "マイ単語帳" && JSON.stringify(s.words) === JSON.stringify([["invoice", "請求書"]])) || JSON.stringify(s);
});
await t("渡す中身: 1,000 語より多い単語帳は over（リンクにしない。文字では渡せる）", () => {
  const big = Array.from({ length: 1001 }, (_, i) => ({ en: `w${i}x`, ja: `語${i}`, book: "w1" }));
  const s = S.bookShare(big, "w1", BOOKS);
  return s.words.length === 1001 && s.over === true && S.bookShare(big.slice(0, 1000), "w1", BOOKS).over === false;
});

// ===== 作って読む（往復） =====
await t("往復（z1: deflate-raw）: 名前・日本語・150 字の行・同じ英語 2 つ（訳が違う）・読点とカンマの入った訳がそのまま戻る", async () => {
  const enc = await S.encodeShare(share);
  const dec = await S.decodeShare(enc.code);
  return (enc.format === "z1" && enc.code.startsWith("z1.") && enc.fits && dec.ok && dec.format === "z1" && dec.name === "仕事" &&
    JSON.stringify(dec.words) === JSON.stringify(share.words.map(([en, ja]) => ({ en, ja })))) || JSON.stringify({ enc: enc.code.slice(0, 20), dec });
});
await t("往復（j1: 縮めない。CompressionStream の無いブラウザで作った形）", async () => {
  const enc = await S.encodeShare(share, { zip: false });
  const dec = await S.decodeShare(enc.code);
  return (enc.format === "j1" && enc.code.startsWith("j1.") && dec.ok && dec.format === "j1" && dec.words.length === 7 && dec.words[4].en === LONG_EN && dec.words[4].ja === LONG_JA) || JSON.stringify(dec);
});
await t("往復: 台本の側の縮め方（deflate-raw）で作った z1 も読める（同じ形）", async () => {
  const dec = await S.decodeShare(zipped({ v: 1, n: "旅行", w: [["check in", "チェックインする"], ["Due Diligence", "適正評価"]] }));
  return (dec.ok && dec.name === "旅行" && dec.words[1].en === "Due Diligence") || JSON.stringify(dec);
});
await t("読んだ語は 1 語ずつ足すと同じ形に直す（全角の英字は半角・’ は '・空白は 1 つ）", async () => {
  const dec = await S.decodeShare(plain({ v: 1, n: " 仕事 ", w: [["ＫＰＩ", " 指標 "], ["don’t   worry", "気にしない"]] }));
  return (dec.ok && dec.name === "仕事" && JSON.stringify(dec.words) === JSON.stringify([{ en: "KPI", ja: "指標" }, { en: "don't worry", ja: "気にしない" }])) || JSON.stringify(dec);
});
await t("ふつうの大きさ: 73 語の単語帳は 8,000 字より短いリンクになる（長いリンクの目安に当たらない）", async () => {
  const words = Array.from({ length: 73 }, (_, i) => [i % 2 ? "up" : "down", `場面${i}。数字は上がる？下がる？ 仕事の資料の見直しで、先月より費用が増えた`]);
  const enc = await S.encodeShare({ name: "仕事", words });
  return (enc.format === "z1" && S.shareLinkOf("https://www.spelldash.net", enc.code).length < S.SHARE_LONG_LINK) || enc.code.length;
});
await t("いちばん大きい単語帳（1,000 語・英語 150 字・訳 150 字）も z1・j1 とも上限の内（Pro の人の単語帳 1 冊）", async () => {
  let x = 12345;
  const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 4294967296);
  const kana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん日本語英会話仕事上下大小新古高安早遅行来見聞読書";
  const words = Array.from({ length: 1000 }, () => [Array.from({ length: 150 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(rnd() * 26)]).join(""), Array.from({ length: 150 }, () => kana[Math.floor(rnd() * kana.length)]).join("")]);
  const z = await S.encodeShare({ name: "仕事", words });
  const j = await S.encodeShare({ name: "仕事", words }, { zip: false });
  const dz = await S.decodeShare(z.code);
  const dj = await S.decodeShare(j.code);
  return (z.fits && j.fits && dz.ok && dj.ok && dz.words.length === 1000 && dj.words.length === 1000) || JSON.stringify({ z: z.code.length, j: j.code.length, dz: dz.reason, dj: dj.reason });
});
await t("訳の字を JSON がいちばん長く書く形（制御文字は 1 字 6 バイト）でも、1,000 語 × 150 字は j1 の上限の内", async () => {
  const words = Array.from({ length: 1000 }, (_, i) => [`${"a".repeat(146)}${String(i).padStart(4, "0")}`.replace(/\d/g, (d) => "abcdefghij"[d]), "\u0001".repeat(150)]);
  const j = await S.encodeShare({ name: "あ".repeat(20), words }, { zip: false });
  const dj = await S.decodeShare(j.code);
  return (j.fits && j.code.length <= S.SHARE_MAX_CODE && dj.ok && dj.words.length === 1000) || JSON.stringify({ len: j.code.length, r: dj.reason });
});

// ===== 断る =====
const GOOD = { v: 1, n: "仕事", w: [["up", "上がる"]] };
await t("断る: 頭の印が z1. j1. でない（無い・x9.・Z1.・空）", async () => {
  const rs = await Promise.all(["", "z1", "x9.abc", "Z1.abc", "j2.abc", B64(Buffer.from(JSON.stringify(GOOD))), "z1abc"].map(reasonOf));
  return rs.every((r) => r === "format" || r === "base64") && rs[0] === "format" && rs[2] === "format" || JSON.stringify(rs);
});
await t("断る: 壊れた base64（使えない字・余り 1・空）", async () => {
  const rs = await Promise.all(["z1.@@@@", "j1.ab$c", "j1.abcde", "z1.", "j1."].map(reasonOf));
  return rs.every((r) => r === "base64") || JSON.stringify(rs);
});
await t("断る: 縮めた形が壊れている（途中で切れた・1 字替えた・縮めた形でない）", async () => {
  const code = zipped(GOOD);
  const cut = code.slice(0, code.length - 6);
  const flip = code.slice(0, 5) + (code[5] === "A" ? "B" : "A") + code.slice(6);
  const rs = await Promise.all([cut, flip, "z1.AAAA", `z1.${B64(Buffer.from(JSON.stringify(GOOD)))}`].map(reasonOf));
  return rs.every((r) => r !== "ok") || JSON.stringify(rs);
});
await t("縮めた形の後ろのごみ: 断るか（ブラウザの広げ方）、読めても中身は元の語だけ（ごみは語に入らない。JSON の確かめは同じ）", async () => {
  const junk = `z1.${B64(Buffer.concat([zlib.deflateRawSync(Buffer.from(JSON.stringify(GOOD))), Buffer.from([1, 2, 3, 4])]))}`;
  const r = await S.decodeShare(junk);
  return (!r.ok || (r.name === "仕事" && JSON.stringify(r.words) === JSON.stringify([{ en: "up", ja: "上がる" }]))) || JSON.stringify(r);
});
await t("断る: 版が違う（v: 2・\"1\"・無い）", async () => {
  const rs = await Promise.all([{ ...GOOD, v: 2 }, { ...GOOD, v: "1" }, { n: "仕事", w: [["up", "上がる"]] }].map((o) => reasonOf(plain(o))));
  return rs.every((r) => r === "version") || JSON.stringify(rs);
});
await t("断る: 型が違う（配列・文字・null・名前が数・w が物・語が 1 つ・3 つ・数・null・ほかの鍵・__proto__）", async () => {
  const bads = [[1, "仕事", []], "仕事", null, { ...GOOD, n: 1 }, { ...GOOD, w: {} }, { ...GOOD, w: [["up"]] }, { ...GOOD, w: [["up", "上がる", "x"]] }, { ...GOOD, w: [["up", 1]] }, { ...GOOD, w: [null] }, { ...GOOD, w: ["up, 上がる"] }, { ...GOOD, x: 1 }];
  const rs = await Promise.all(bads.map((o) => reasonOf(plain(o))));
  const proto = await reasonOf(`j1.${B64(Buffer.from('{"v":1,"n":"仕事","w":[["up","上がる"]],"__proto__":{"x":1}}'))}`);
  return (rs.every((r) => r !== "ok") && proto !== "ok") || JSON.stringify({ rs, proto });
});
await t("断る: JSON でない・壊れた UTF-8・頭に BOM", async () => {
  const rs = await Promise.all([`j1.${B64(Buffer.from("{v:1}"))}`, `j1.${B64(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))}`, `j1.${B64(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(GOOD))]))}`].map(reasonOf));
  return (rs[0] === "json" && rs[1] === "utf8" && rs[2] === "json") || JSON.stringify(rs);
});
await t("断る: 名前が使えない（空・21 字）・語が 0", async () => {
  const rs = await Promise.all([{ ...GOOD, n: " " }, { ...GOOD, n: "あ".repeat(21) }, { ...GOOD, w: [] }].map((o) => reasonOf(plain(o))));
  return (rs[0] === "name" && rs[1] === "name" && rs[2] === "empty") || JSON.stringify(rs);
});
await t("断る: 1 語でも決まりに合わなければリンクごと（使えない字・英語 151 字・訳 151 字・訳が空・英字の無い英語）", async () => {
  const rs = await Promise.all([["café", "喫茶店"], ["a".repeat(151), "x"], ["abc", "あ".repeat(151)], ["abc", " "], ["123", "数"]].map((e) => reasonOf(plain({ ...GOOD, w: [["up", "上がる"], e] }))));
  return rs.every((r) => r === "entry") || JSON.stringify(rs);
});
await t("断る: 語の数の上限（1,000 語は読める・1,001 語は断る）", async () => {
  const w = (n) => Array.from({ length: n }, (_, i) => [`w${"abcdefghij"[i % 10]}${"abcdefghij"[Math.floor(i / 10) % 10]}${"abcdefghij"[Math.floor(i / 100) % 10]}`, `語${i}`]);
  const a = await S.decodeShare(zipped({ v: 1, n: "仕事", w: w(1000) }));
  const b = await reasonOf(zipped({ v: 1, n: "仕事", w: w(1001) }));
  return (a.ok && a.words.length === 1000 && b === "size") || JSON.stringify({ a: a.reason, b });
});
await t("断る: 長すぎる code（1,500,001 字）は広げずに断る", async () => {
  const r = await reasonOf(`j1.${"A".repeat(S.SHARE_MAX_CODE - 2)}`);
  return r === "size" || r;
});
await t("断る: 広げると大きすぎる z1（2 MB の空白を縮めた物）は上限で読むのをやめる・j1 の大きすぎる JSON も", async () => {
  const bomb = `z1.${B64(zlib.deflateRawSync(Buffer.from(" ".repeat(2_000_000))))}`;
  const big = `j1.${B64(Buffer.from(" ".repeat(S.SHARE_MAX_JSON + 1)))}`;
  const rs = [bomb.length < S.SHARE_MAX_CODE, await reasonOf(bomb), await reasonOf(big)];
  return (rs[0] && rs[1] === "size" && rs[2] === "size") || JSON.stringify(rs);
});
await t("読む道に eval・Function・innerHTML が無い（JSON.parse だけ）", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "myWordsShare.js"), "utf8").replace(/\/\/.*$/gm, "");
  return (!/\beval\s*\(|new Function|Function\s*\(|innerHTML|insertAdjacentHTML|outerHTML/.test(src) && /JSON\.parse/.test(src)) || "見つかった";
});

// ===== 文字で渡す形（まとめて足すに貼る） =====
await t("文字の形: 1 行に「english, 訳」・見出しの決まりに当たる英語（english・answer・q）は全角の読点・訳の全体が \"…\" なら引用符を足す", () =>
  S.shareLineOf("up", "上がる") === "up, 上がる" && S.shareLineOf("English", "英語") === "English、英語" && S.shareLineOf("q", "質問") === "q、質問" && S.shareLineOf("answer", "答え") === "answer、答え" &&
  S.shareLineOf("quote", "\"引用\"") === "quote, \"\"引用\"\"" && S.shareTextOf([["a", "1"], ["b", "2"]]) === "a, 1\nb, 2");

// ===== 新しい単語帳の名前（js/myWordsCore.js uniqueBookName） =====
await t("新しい単語帳の名前: 空いていればそのまま・あれば「名前 2」「名前 3」・20 字に収まるよう削る・使えない名前は null", () => {
  const books = [{ id: "main", name: "マイ単語帳" }, { id: "a", name: "仕事" }, { id: "b", name: "仕事 2" }, { id: "c", name: "あ".repeat(20) }];
  const r = [C.uniqueBookName("旅行", books), C.uniqueBookName("仕事", books), C.uniqueBookName(" 仕事 ", [{ id: "a", name: "仕事" }]), C.uniqueBookName("あ".repeat(20), books), C.uniqueBookName("", books), C.uniqueBookName("あ".repeat(21), books)];
  return JSON.stringify(r) === JSON.stringify(["旅行", "仕事 3", "仕事 2", `${"あ".repeat(18)} 2`, null, null]) || JSON.stringify(r);
});
await t("新しい単語帳の名前: 字の途中（サロゲートの組）で切らない", () => {
  const name = `${"あ".repeat(17)}😀😀`; // 21 単位だが、名前は 20 字（.length）までなので 17 + 😀 = 19 単位
  const books = [{ id: "a", name: `${"あ".repeat(17)}😀` }];
  const r = C.uniqueBookName(`${"あ".repeat(17)}😀`, books);
  return (typeof r === "string" && r.length <= 20 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r) && r.endsWith(" 2")) || JSON.stringify({ r, name });
});

// ===== 渡された語を足す（js/myWords.js addSharedWords。localStorage の写しで） =====
{
  const store = new Map();
  const writes = [];
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { writes.push(k); store.set(k, String(v)); }, removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
  globalThis.sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.window ??= globalThis;
  globalThis.dispatchEvent ??= () => true;
  globalThis.addEventListener ??= () => {};
  globalThis.window.__SUPABASE_MODULE_URL = "data:text/javascript,export const createClient = () => ({});";
  let M = null;
  try {
    M = await import("../js/myWords.js");
  } catch (e) {
    console.log(`(js/myWords.js を読めない: ${e.message})`);
  }
  const words = () => JSON.parse(store.get("spelldash_my_words") || "[]");
  const books = () => JSON.parse(store.get("spelldash_my_books") || "null");
  const meta = () => JSON.parse(store.get("spelldash_user_items_meta") || "{}");
  const reset = (seed = {}) => { store.clear(); writes.length = 0; for (const [k, v] of Object.entries(seed)) store.set(k, v); };
  const count = (k) => writes.filter((w) => w === k).length;
  const GOT = [{ en: "up", ja: "上がる" }, { en: "up", ja: "下がる" }, { en: "KPI", ja: "重要業績評価指標" }, { en: "due diligence", ja: "適正評価" }];
  const OLD = JSON.stringify([{ en: "invoice", ja: "請求書", addedAt: "2026-11-01T00:00:00.000Z", ls: 2, lsAt: 5 }]);

  await t("新しい単語帳として足す: 名前は渡された名前・語は全部これから（3 状態の欄なし）・同じ英語 2 つ（訳が違う）も入る・語の保存 1 回・一覧の保存 1 回・同期の印", () => {
    reset({ spelldash_my_words: OLD });
    const r = M.addSharedWords(GOT, { name: "仕事" });
    const w = words();
    const b = books();
    const mine = w.filter((x) => x.book === r.book?.id);
    return (r.ok && r.created && r.book?.name === "仕事" && r.added.join() === "up,up,KPI,due diligence" && r.skipped.length === 0 && r.limited === 0 &&
      mine.length === 4 && mine.every((x) => x.bookName === "仕事" && !("ls" in x) && !("lsAt" in x) && !("lsd" in x)) && mine[1].en.startsWith("up~") && mine[1].text === "up" && mine[2].text === "KPI" &&
      JSON.stringify(w[0]) === JSON.stringify(JSON.parse(OLD)[0]) && b.map((x) => x.name).join() === "マイ単語帳,仕事" && count("spelldash_my_words") === 1 && count("spelldash_my_books") === 1 &&
      mine.every((x) => meta()[`my_word:${x.en}`]?.deleted === false)) || JSON.stringify({ r, mine, b });
  });
  await t("同じ単語帳をもう一度新しい単語帳として足す: 全部が同じ組で断られ、空の単語帳「仕事 2」は作らない（語も一覧も書かない）", () => {
    writes.length = 0;
    const before = store.get("spelldash_my_words");
    const r = M.addSharedWords(GOT, { name: "仕事" });
    return (r.ok && !r.created && r.book === null && r.added.length === 0 && r.skipped.length === 4 && r.skipped.every((s) => /同じ訳で「仕事」にすでに登録/.test(s)) &&
      store.get("spelldash_my_words") === before && books().length === 2 && writes.length === 0) || JSON.stringify(r);
  });
  await t("今の単語帳に足す: 同じ組は断る・訳が違う同じ英語は足す・理由は英語と訳の頭", () => {
    const w1 = books()[1].id;
    const r = M.addSharedWords([{ en: "up", ja: "上がる" }, { en: "up", ja: "横ばい" }, { en: "agenda", ja: "議題" }], { book: w1 });
    return (r.ok && !r.created && r.book?.id === w1 && r.added.join() === "up,agenda" && r.skipped.length === 1 && /^up（上がる）: 同じ訳で「仕事」にすでに登録/.test(r.skipped[0]) &&
      words().filter((x) => x.book === w1).length === 6) || JSON.stringify(r);
  });
  await t("渡された中の 2 つ目の同じ組も断る（新しい単語帳の名前で言う）", () => {
    reset({});
    const r = M.addSharedWords([{ en: "up", ja: "上がる" }, { en: "UP", ja: "上がる" }], { name: "旅行" });
    return (r.ok && r.created && r.added.length === 1 && r.skipped.length === 1 && /「旅行」/.test(r.skipped[0])) || JSON.stringify(r);
  });
  await t("名前が重なれば「仕事 2」として作る（今の単語帳と重ねない）", () => {
    reset({ spelldash_my_books: JSON.stringify([{ id: "main", name: "マイ単語帳" }, { id: "w1", name: "仕事" }]) });
    const r = M.addSharedWords([{ en: "agenda", ja: "議題" }], { name: "仕事" });
    return (r.ok && r.book?.name === "仕事 2" && books().length === 3 && books()[2].name === "仕事 2") || JSON.stringify({ r, b: books() });
  });
  await t("上限（無料 100 語）: 95 語の人に 10 語を渡すと 5 語足して 5 語は上限で足せない（limited）・断った理由には入れない", () => {
    reset({ spelldash_my_words: JSON.stringify(Array.from({ length: 95 }, (_, i) => ({ en: `old${"abcdefghij"[i % 10]}${"abcdefghij"[Math.floor(i / 10)]}`, ja: `古い${i}` }))) });
    const r = M.addSharedWords(Array.from({ length: 10 }, (_, i) => ({ en: `new${"abcdefghij"[i]}`, ja: `新しい${i}` })), { name: "仕事" });
    return (r.ok && r.added.length === 5 && r.limited === 5 && r.skipped.length === 0 && words().length === 100 && M.maxMyWords() === 100) || JSON.stringify(r);
  });
  await t("上限に着いている人: 1 語も足せず、新しい単語帳も作らない", () => {
    writes.length = 0;
    const r = M.addSharedWords([{ en: "zzz", ja: "ぜ" }], { name: "旅行" });
    return (r.ok && r.added.length === 0 && r.limited === 1 && r.book === null && writes.length === 0) || JSON.stringify(r);
  });
  await t("単語帳の数の上限（20 冊）: 新しい単語帳としては断る・今の単語帳には足せる", () => {
    reset({ spelldash_my_books: JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ id: i ? `b${i}` : "main", name: i ? `帳${i}` : "マイ単語帳" }))) });
    const r1 = M.addSharedWords([{ en: "zzz", ja: "ぜ" }], { name: "仕事" });
    const r2 = M.addSharedWords([{ en: "zzz", ja: "ぜ" }], { book: "b3" });
    return (!r1.ok && /20冊まで/.test(r1.error) && r2.ok && r2.added.length === 1 && words()[0].book === "b3") || JSON.stringify({ r1, r2 });
  });
  await t("単語帳の一覧が読めない保存: 新しい単語帳としては断る（上書きしない）・今の単語帳には足せる", () => {
    reset({ spelldash_my_books: "{broken" });
    const r1 = M.addSharedWords([{ en: "zzz", ja: "ぜ" }], { name: "仕事" });
    const r2 = M.addSharedWords([{ en: "zzz", ja: "ぜ" }], { book: "main" });
    return (!r1.ok && store.get("spelldash_my_books") === "{broken" && r2.ok && r2.added.length === 1) || JSON.stringify({ r1, r2 });
  });
  await t("文字の形をまとめて足すに貼ると、同じ英語と訳の語になる（見出しの決まりに当たる英語・引用符の訳・読点とカンマの訳・150 字）", () => {
    const sent = S.bookShare(LIST, "w1", BOOKS).words;
    const parsed = M.parseBulk(S.shareTextOf(sent)).map((e) => [e.en, e.ja]);
    return JSON.stringify(parsed) === JSON.stringify(sent) || JSON.stringify(parsed);
  });
  await t("上限の断りは limit の印を持つ（ほかの断りは持たない）", () => {
    reset({ spelldash_my_words: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ en: `old${"abcdefghij"[i % 10]}${"abcdefghij"[Math.floor(i / 10)]}`, ja: `古い${i}` }))) });
    const a = M.validateEntry("fresh", "新しい");
    const b = M.validateEntry("olda" + "a", "古い0");
    const c = M.validateEntry("café", "x");
    return (a.ok === false && a.limit === true && b.ok === false && !b.limit && c.ok === false && !c.limit) || JSON.stringify({ a, b, c });
  });
}

// ===== URL を送る所に # の後ろを入れない（ご意見のページ名・動線の計測・同期・送信） =====
await t("URL を送る module は location.href・location.hash・document.URL を読まない（ご意見のページ名は pathname + search だけ）", () => {
  const files = ["feedback.js", "funnelLog.js", "sync.js", "userItemsSync.js", "supabase.js", "plan.js", "proFunnel.js", "wordAi.js", "cardGen.js", "myWords.js", "myWordsShare.js"];
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, "js", f), "utf8").replace(/\/\/.*$/gm, "");
    if (/location\.href|location\.hash|document\.URL|document\.location|location\.toString\(\)|String\(location\)|`\$\{location\}`/.test(src)) hits.push(f);
  }
  const feedback = fs.readFileSync(path.join(ROOT, "js", "feedback.js"), "utf8");
  return (hits.length === 0 && /page: location\.pathname \+ location\.search,/.test(feedback)) || JSON.stringify(hits);
});

// ===== プライバシーポリシーの 1 行 =====
await t("privacy.html に渡すリンクの 1 行（入るのは単語帳の名前と英語と訳だけ・# から後ろはサーバーに送られない・リンクを知っている人はだれでも見られる）", () => {
  const html = fs.readFileSync(path.join(ROOT, "privacy.html"), "utf8");
  const para = html.split("<p>").find((s) => s.includes("「渡す」"))?.split("</p>")[0].replace(/\s+/g, " ") ?? "";
  return (/単語帳の名前と英語と訳だけ/.test(para) && /サーバーには送られません/.test(para) && /リンクを知っている人はだれでも/.test(para)) || para || "no line";
});

console.log(`test-share: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
