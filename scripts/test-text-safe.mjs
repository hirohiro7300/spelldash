// 文字の守りと同期の頑丈さ（Batch 85。docs/SPEC_MY_WORDS.md §14）の単体:
//   1. 名前と訳の字の決まり（見えない制御文字・組になっていないサロゲート・向きを変える制御文字は入れない）は js/myWordsCore.js の 1 か所。
//      1 語ずつ足す・まとめて足す（その行だけ断り、行の名前を言う）・訳を直す・単語帳を作る／名前を変える・渡すリンクが同じ決まりを使う
//   2. 前からある語（バックアップの読み込み・ほかの端末から届いた行）は消さず、そのまま読める（端末の保存は書き換えない）
//   3. 送る形（js/userItemsSync.js）: 送る写しの字を整える・行の中身で断られた組は半分ずつ送り直す（要求の数に上限）・
//      1 行だけで断られた行は待つ（その行が変わるか、待つ時間が過ぎたら送る）・day の行は前のまま
// 使い方: node scripts/test-text-safe.mjs
// 先に書いた検査（Batch 85 の前の木には決まりの口も送り直しも無い）: 投げても 1 件の失敗に数えて止まらない
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
async function t(name, fn) {
  try {
    const r = await fn();
    if (r === true) ok(name, true);
    else ok(name, false, typeof r === "string" ? r : JSON.stringify(r));
  } catch (e) {
    ok(name, false, `投げた: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}
const show = (s) => JSON.stringify(s); // 見えない字はエスケープで見せる

// ===== 端末の偽物 =====
class FakeStorage {
  constructor() {
    this.map = new Map();
    this.writes = [];
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.writes.push(k);
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  get length() {
    return this.map.size;
  }
}
const LS = new FakeStorage();
const SS = new FakeStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => LS });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => SS });
globalThis.window = globalThis;
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
globalThis.dispatchEvent = () => true;
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, visibilityState: "visible", hidden: false };
globalThis.location ??= { search: "", hostname: "localhost", pathname: "/", href: "http://localhost/", origin: "http://localhost" };
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
globalThis.window.__SUPABASE_MODULE_URL = "data:text/javascript,export const createClient = () => ({});";
console.warn = () => {};

const reset = (seed = {}) => {
  LS.clear();
  LS.writes.length = 0;
  for (const [k, v] of Object.entries(seed)) LS.map.set(k, typeof v === "string" ? v : JSON.stringify(v));
};
const words = () => JSON.parse(LS.getItem("spelldash_my_words") || "[]");
const meta = () => JSON.parse(LS.getItem("spelldash_user_items_meta") || "{}");
const dirty = () => JSON.parse(LS.getItem("spelldash_user_items_dirty") || "[]");

const C = await import("../js/myWordsCore.js");
const M = await import("../js/myWords.js");
const S = await import("../js/userItemsSync.js");
let X = null;
try {
  X = await import("../js/myWordsShare.js");
} catch (e) {
  console.log(`(js/myWordsShare.js を読めない: ${e.message})`);
}
let B = null;
try {
  B = await import("../js/backup.js");
} catch (e) {
  console.log(`(js/backup.js を読めない: ${e.message})`);
}

// 入れない字（Batch 84 の渡すリンクと同じ）: 制御文字・C1・向きを変える制御文字（埋め込み・上書き・隔離）
const UNSAFE = [["NUL", "\u0000"], ["ESC", "\u001b"], ["US", "\u001f"], ["DEL", "\u007f"], ["NEL", "\u0085"], ["C1 の終わり", "\u009f"], ["LRE", "\u202A"], ["RLO", "\u202E"], ["LRI", "\u2066"], ["PDI", "\u2069"]];
// 組になっていないサロゲート（上だけ・下だけ・逆の順・絵文字の上の半分）
const LONE = [["上だけ", "\ud800"], ["下だけ", "\udfff"], ["逆の順", "\udc00\ud800"], ["絵文字の半分", "\ud83d"]];
const ALL_BAD = [...UNSAFE, ...LONE];
const NOTE = /見えない制御文字/;

// ===== 1. 決まりは 1 か所（js/myWordsCore.js） =====
await t("決まりの口: js/myWordsCore.js が UNSAFE_TEXT（正規表現）・isSafeText・withoutUnsafe・UNSAFE_TEXT_ERROR（「見えない制御文字…は使えません」）を持つ", () =>
  (C.UNSAFE_TEXT instanceof RegExp && typeof C.isSafeText === "function" && typeof C.withoutUnsafe === "function" && NOTE.test(C.UNSAFE_TEXT_ERROR ?? "") && /使えません$/.test(C.UNSAFE_TEXT_ERROR ?? "")) ||
  show({ re: String(C.UNSAFE_TEXT), safe: typeof C.isSafeText, without: typeof C.withoutUnsafe, err: C.UNSAFE_TEXT_ERROR }));
await t("決まりは 1 か所: js/myWordsShare.js は自分の正規表現を持たず、js/myWordsCore.js の決まりを使う（渡すリンクの振る舞いは前のまま: scripts/test-share.mjs）", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "myWordsShare.js"), "utf8");
  const own = /\bconst\s+UNSAFE_TEXT\s*=/.test(src) || /\\u202A-\\u202E/i.test(src.replace(/\/\/.*$/gm, ""));
  return !own || "js/myWordsShare.js に自分の UNSAFE_TEXT がある";
});
await t("訳（checkJaText）: 制御文字・C1・向きを変える制御文字・組になっていないサロゲートは断る（理由は「日本語訳に見えない制御文字…」・打った字を文に入れない）", () => {
  const bad = ALL_BAD.map(([k, ch]) => [k, C.checkJaText(`請求${ch}書`)]).filter(([, r]) => r.ok || !/日本語訳/.test(r.error ?? "") || !NOTE.test(r.error ?? "") || ALL_BAD.some(([, c]) => (r.error ?? "").includes(c)));
  return bad.length === 0 || show(bad);
});
await t("訳（checkJaText）: タブ・改行・縦タブは空白 1 つ（前のまま）・絵文字の組・全角の空白・ゼロ幅の字・向きの印（LRM）は読める", () => {
  const rs = ["行く\tこと\n", "a\u000bb", "楽しい😀", "よい\u3000とても", "x\u200By", "y\u200Ez"].map((s) => C.checkJaText(s));
  return (rs.every((r) => r.ok) && rs[0].ja === "行く こと" && rs[1].ja === "a b" && rs[2].ja === "楽しい😀") || show(rs);
});
await t("英語（checkEnText）: 見えない字は「英語に見えない制御文字…」で断り、打った字を文に入れない（ほかの使えない字の文は前のまま）", () => {
  const rs = [["NUL", "go\u0000"], ["RLO", "\u202Ego"], ["上だけ", "go\ud800"], ["C1", "go\u0085"]].map(([k, s]) => [k, C.checkEnText(s)]);
  const bad = rs.filter(([, r]) => r.ok || !/^英語に/.test(r.error ?? "") || !NOTE.test(r.error ?? "") || ALL_BAD.some(([, c]) => (r.error ?? "").includes(c)));
  const cafe = C.checkEnText("café");
  return (bad.length === 0 && !cafe.ok && /「café」は使えない字を含みます/.test(cafe.error)) || show({ bad, cafe });
});
await t("単語帳の名前（checkBookName）: 見えない字は「単語帳の名前に見えない制御文字…」で断る・絵文字は使える", () => {
  const bad = ALL_BAD.map(([k, ch]) => [k, C.checkBookName(`仕${ch}事`, [])]).filter(([, r]) => r.ok || !/単語帳の名前に/.test(r.error ?? "") || !NOTE.test(r.error ?? ""));
  const emoji = C.checkBookName("旅行😀", []);
  return (bad.length === 0 && emoji.ok) || show({ bad, emoji });
});
await t("withoutUnsafe: 見えない字だけを落とす（絵文字の組・全角の空白・ふつうの字はそのまま）・字の無い物は空の文字", () => {
  const a = C.withoutUnsafe("お\u0000茶\u202E😀\u3000x\ud800");
  return (a === "お茶😀\u3000x" && C.withoutUnsafe(undefined) === "" && C.withoutUnsafe("\u0001") === "") || show(a);
});

// ===== 2. 書く道（js/myWords.js）は同じ決まり =====
await t("1 語ずつ足す: 訳に見えない字は断る（日本語訳の欄の文）・何も書かない", () => {
  const bad = [];
  for (const [k, ch] of ALL_BAD) {
    reset();
    const r = M.addMyWord("go", `行${ch}く`, "main");
    if (r.ok || !/日本語訳/.test(r.error ?? "") || !NOTE.test(r.error ?? "") || LS.writes.length > 0) bad.push([k, r, LS.writes.length]);
  }
  return bad.length === 0 || show(bad);
});
await t("1 語ずつ足す: 英語に見えない字は断る（英語の欄の文・打った字は文に入れない）・何も書かない", () => {
  reset();
  const r = M.addMyWord("go\u202E", "行く", "main");
  return (!r.ok && /^英語に/.test(r.error ?? "") && NOTE.test(r.error ?? "") && !r.error.includes("\u202E") && LS.writes.length === 0) || show(r);
});
await t("まとめて足す: 見えない字のある行だけ断り、行の名前（英語と訳の頭。見えない字は外して見せる）と理由を言う・ほかの行は足す・断った行は貼った形のまま欄に残す", () => {
  reset();
  const text = "go, 行く\ntea, お\u0000茶\nsun, \u202E太陽\nmoon, 月";
  const r = M.addMyWordsBulk(text, "main");
  const want = ["tea（お茶）: 日本語訳に", "sun（太陽）: 日本語訳に"];
  return (JSON.stringify(r.added) === '["go","moon"]' && r.skipped.length === 2 && r.skipped.every((s, i) => s.startsWith(want[i]) && NOTE.test(s) && !/[\u0000\u202E]/.test(s))
    && JSON.stringify(r.rest) === JSON.stringify(["tea, お\u0000茶", "sun, \u202E太陽"]) && JSON.stringify(words().map((w) => w.en)) === '["go","moon"]') || show(r);
});
await t("まとめて足す: 英語の側の見えない字も、その行だけ断る（行の名前から見えない字を外す）", () => {
  reset();
  const r = M.addMyWordsBulk("go\u0000, 行く\nsun, 太陽", "main");
  return (JSON.stringify(r.added) === '["sun"]' && r.skipped.length === 1 && /^go（行く）: 英語に見えない制御文字/.test(r.skipped[0]) && JSON.stringify(r.rest) === JSON.stringify(["go\u0000, 行く"])) || show(r);
});
await t("訳を直す: 見えない字は断る・保存は変えない", () => {
  reset({ spelldash_my_words: [{ en: "go", ja: "行く", addedAt: "x" }] });
  const before = LS.getItem("spelldash_my_words");
  const rs = [["RLO", "行\u202Eく"], ["NUL", "行\u0000く"], ["下だけ", "行\udfffく"]].map(([k, ja]) => [k, M.setMyWordJa("go", ja)]);
  return (rs.every(([, r]) => !r.ok && /日本語訳/.test(r.error ?? "") && NOTE.test(r.error ?? "")) && LS.getItem("spelldash_my_words") === before && LS.writes.length === 0) || show(rs);
});
await t("単語帳を作る・名前を変える: 見えない字は断る・一覧も語も書かない", () => {
  reset({ spelldash_my_books: [{ id: "main", name: "マイ単語帳" }, { id: "w1", name: "仕事" }], spelldash_my_words: [{ en: "go", ja: "行く", book: "w1", bookName: "仕事" }] });
  const a = M.createMyBook("旅\u0000行");
  const b = M.renameMyBook("w1", "仕\u2066事");
  const c = M.renameMyBook("main", "マイ\ud800");
  return ([a, b, c].every((r) => !r.ok && /単語帳の名前に/.test(r.error ?? "") && NOTE.test(r.error ?? "")) && LS.writes.length === 0) || show({ a, b, c });
});
await t("渡された語を足す（addSharedWords）も同じ確かめ: 見えない字の語は足さずに理由を言う（リンクからは読む側が先に断る）", () => {
  reset();
  const r = M.addSharedWords([{ en: "go", ja: "行く" }, { en: "tea", ja: "お\u0000茶" }], { name: "仕事" });
  return (r.ok && r.added.join() === "go" && r.skipped.length === 1 && /^tea（お茶）: 日本語訳に見えない制御文字/.test(r.skipped[0])) || show(r);
});
await t("渡すリンクは前のまま: 訳・名前に見えない字のある code は読まない（entry・name）・ふつうの code は読める", async () => {
  if (!X) return "js/myWordsShare.js が無い";
  const j1 = (o) => `j1.${Buffer.from(JSON.stringify(o), "utf8").toString("base64url")}`;
  const a = await X.decodeShare(j1({ v: 1, n: "仕事", w: [["go", "行\u0000く"]] }));
  const b = await X.decodeShare(j1({ v: 1, n: "仕\u202E事", w: [["go", "行く"]] }));
  const c = await X.decodeShare(j1({ v: 1, n: "仕事", w: [["go", "行く"]] }));
  return (a.reason === "entry" && b.reason === "name" && c.ok) || show({ a, b, c });
});

// ===== 3. 前からある語は消さない・そのまま読める =====
const OLD_WORDS = [
  { en: "go", ja: "行\u0000く", addedAt: "2026-11-01T00:00:00.000Z", book: "w1", bookName: "仕\u202E事" },
  { en: "sun", ja: "太陽\ud800", addedAt: "2026-11-02T00:00:00.000Z" },
  { en: "tea", ja: "お茶", addedAt: "2026-11-03T00:00:00.000Z", ls: 2, lsAt: 5 }
];
const OLD_RAW = JSON.stringify(OLD_WORDS);
await t("前からの語: 見えない字のある語も一覧に読める（落とさない・書き直さない）", () => {
  reset({ spelldash_my_words: OLD_RAW });
  const list = M.getMyWords();
  return (list.length === 3 && list[0].ja === "行\u0000く" && list[1].ja === "太陽\ud800" && LS.writes.length === 0 && LS.getItem("spelldash_my_words") === OLD_RAW) || show(list);
});
await t("バックアップの読み込み（js/backup.js applyBackup）: 見えない字のある語・単語帳の名前もそのまま戻す（1 字も変えない・落とさない）", () => {
  if (!B) return "js/backup.js が無い";
  reset();
  const books = JSON.stringify([{ id: "main", name: "マイ単語帳" }, { id: "w1", name: "仕\u202E事" }]);
  B.applyBackup({ app: "SpellDash", version: 1, data: { spelldash_schema_version: "7", spelldash_my_words: OLD_RAW, spelldash_my_books: books } });
  return (LS.getItem("spelldash_my_words") === OLD_RAW && LS.getItem("spelldash_my_books") === books && M.getMyWords().length === 3) || show({ w: LS.getItem("spelldash_my_words"), b: LS.getItem("spelldash_my_books") });
});
await t("ほかの端末から届いた行（mergeCloudItems）: 見えない字のある語とメモも前のまま入れる（投げない・落とさない）", () => {
  reset({ spelldash_my_words: [{ en: "tea", ja: "お茶", addedAt: "2026-11-03T00:00:00.000Z" }] });
  const note = `${"あ".repeat(79)}😀`; // 80 字で切ると絵文字の上の半分が残る（前のまま）
  const rows = [
    { kind: "my_word", key: "go", payload: { en: "go", ja: "行\u0001く\u202E", book: "w1", bookName: "仕\u0085事" }, deleted: false, updated_at: "2026-11-08T00:00:00.000Z" },
    { kind: "note", key: "my-go", payload: { text: note }, deleted: false, updated_at: "2026-11-08T00:00:00.000Z" }
  ];
  const r = S.mergeCloudItems(rows, "u1");
  const got = words().find((w) => w.en === "go");
  const notes = JSON.parse(LS.getItem("spelldash_word_notes") || "{}");
  return (r.changed.my_word && got?.ja === "行\u0001く\u202E" && got?.bookName === "仕\u0085事" && words().length === 2 && notes["my-go"] === note.slice(0, 80)) || show({ r: r.changed, got, note: notes["my-go"]?.length });
});

// ===== 4. 送る形と送り方（js/userItemsSync.js） =====
// 送り先の偽物（user_items の表）: 本物と同じに、要求の中に NUL か組になっていないサロゲートのある文字（鍵の名前も）があれば要求ごと断る（400）。
// key が 200 字より長い行も要求ごと断る（400・23514: 表の check）。断るときは 1 行も書かない（要求は 1 つの文）。respond で答えを差し替える
function fakeCloud(opts = {}) {
  const rows = new Map();
  const calls = [];
  const badText = (s) => (s.includes("\u0000") ? "22P05" : /[\uD800-\uDFFF]/u.test(s) ? "22P02" : null);
  const badValue = (v) => {
    if (typeof v === "string") return badText(v);
    if (Array.isArray(v)) {
      for (const x of v) {
        const b = badValue(x);
        if (b) return b;
      }
      return null;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const b = badText(k) ?? badValue(x);
        if (b) return b;
      }
    }
    return null;
  };
  function run(ops) {
    const up = ops.find((o) => o[0] === "upsert");
    if (up) {
      const list = Array.isArray(up[1]) ? up[1] : [up[1]];
      const call = { op: "upsert", n: list.length, kinds: [...new Set(list.map((r) => r.kind))], keys: list.map((r) => r.key) };
      calls.push(call);
      if (opts.respond) {
        const r = opts.respond(list);
        if (r) {
          call.ok = false;
          return r;
        }
      }
      let code = null;
      for (const r of list) {
        code = badValue(r) ?? (String(r.key).length > 200 ? "23514" : null) ?? (r.kind === "day" && opts.noDay ? "23514" : null);
        if (code) break;
      }
      if (code) {
        call.ok = false;
        return { data: null, error: { code, message: "bad row" }, status: 400 };
      }
      for (const r of list) rows.set(`${r.kind}:${r.key}`, JSON.parse(JSON.stringify(r)));
      call.ok = true;
      return { data: null, error: null, status: 201 };
    }
    calls.push({ op: "select" });
    let data = [...rows.values()];
    for (const o of ops) {
      if (o[0] === "eq") data = data.filter((r) => r[o[1]] === o[2]);
      if (o[0] === "in") data = data.filter((r) => o[2].includes(r[o[1]]));
    }
    return { data: JSON.parse(JSON.stringify(data)), error: null, status: 200 };
  }
  return {
    rows,
    calls,
    upserts: () => calls.filter((c) => c.op === "upsert"),
    from() {
      const ops = [];
      const b = {
        upsert(x) { ops.push(["upsert", x]); return b; },
        select(c) { ops.push(["select", c]); return b; },
        eq(k, v) { ops.push(["eq", k, v]); return b; },
        in(k, v) { ops.push(["in", k, v]); return b; },
        then(resolve, reject) { return Promise.resolve().then(() => run(ops)).then(resolve, reject); }
      };
      return b;
    }
  };
}
const T0 = Date.parse("2026-11-09T00:00:00.000Z");
const RETRY = S.UPLOAD_RETRY_MS ?? 24 * 60 * 60 * 1000;
const SPLIT = S.UPLOAD_SPLIT_MAX ?? 40;
// 送る待ちの語 n 語（鍵 w000…）。bad = 送り先が断る行の番号（鍵が 201 字の語: 前の版のバックアップ・手で書いたファイルからしか入らない）
const LONG = "x".repeat(201);
function seedWords(n, bad = [], extra = []) {
  const list = Array.from({ length: n }, (_, i) => ({ en: bad.includes(i) ? `${LONG}${i}` : `w${String(i).padStart(3, "0")}`, ja: `訳${i}`, addedAt: "2026-11-01T00:00:00.000Z" }));
  list.push(...extra);
  const m = {};
  for (const w of list) m[`my_word:${w.en}`] = { updatedAt: "2026-11-08T00:00:00.000Z", deleted: false };
  reset({ spelldash_my_words: list, spelldash_user_items_meta: m, spelldash_user_items_dirty: list.map((w) => `my_word:${w.en}`) });
  return list;
}
const sentKeys = (cloud) => [...cloud.rows.values()].map((r) => r.key);

await t("送る字を整える（cleanSendValue）: NUL とほかの制御文字（タブ・改行・復帰は残す）・DEL・C1 を落とし、組になっていないサロゲートを U+FFFD に・入れ子と鍵の名前も・元の値は変えない", () => {
  const input = { en: "go", ja: "a\u0000b\u0001c\td\ne\rf\u007f\u0085\u009fg", n: 3, ok: true, none: null, list: ["x\ud800y", "😀", "\udfff"], deep: { "k\u0000": "\u202Eabc" } };
  const copy = JSON.parse(JSON.stringify(input));
  const out = S.cleanSendValue(input);
  const want = { en: "go", ja: "abc\td\ne\rfg", n: 3, ok: true, none: null, list: ["x\uFFFDy", "😀", "\uFFFD"], deep: { k: "\u202Eabc" } };
  return (JSON.stringify(out) === JSON.stringify(want) && JSON.stringify(input) === JSON.stringify(copy)) || show(out);
});
await t("送る: 前からの見えない字のある語（バックアップ・ほかの端末から）も、整えた写しで 1 回で届く・ほかの語も届く・端末の保存は 1 字も変えない", async () => {
  reset({
    spelldash_my_words: OLD_RAW,
    spelldash_user_items_meta: Object.fromEntries(OLD_WORDS.map((w) => [`my_word:${w.en}`, { updatedAt: "2026-11-08T00:00:00.000Z", deleted: false }])),
    spelldash_user_items_dirty: OLD_WORDS.map((w) => `my_word:${w.en}`)
  });
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const go = cloud.rows.get("my_word:go");
  const sun = cloud.rows.get("my_word:sun");
  return (cloud.upserts().length === 1 && cloud.rows.size === 3 && go?.payload.ja === "行く" && go?.payload.bookName === "仕\u202E事" && sun?.payload.ja === "太陽\uFFFD" && dirty().length === 0 && LS.getItem("spelldash_my_words") === OLD_RAW) ||
    show({ calls: cloud.calls, n: cloud.rows.size, go: go?.payload, dirty: dirty() });
});
await t("送る: バックアップから戻した語（見えない字あり）も、次の送信で整えて届く（戻した保存はそのまま）", async () => {
  if (!B) return "js/backup.js が無い";
  reset();
  const m = Object.fromEntries(OLD_WORDS.map((w) => [`my_word:${w.en}`, { updatedAt: "2026-11-08T00:00:00.000Z", deleted: false }]));
  B.applyBackup({ app: "SpellDash", version: 1, data: { spelldash_schema_version: "7", spelldash_my_words: OLD_RAW, spelldash_user_items_meta: JSON.stringify(m), spelldash_user_items_dirty: JSON.stringify(Object.keys(m)) } });
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  return (cloud.rows.size === 3 && cloud.rows.get("my_word:go")?.payload.ja === "行く" && dirty().length === 0 && LS.getItem("spelldash_my_words") === OLD_RAW) || show({ calls: cloud.calls, dirty: dirty() });
});
await t("送る: ほかの端末から届いた行（見えない字・80 字で切れたメモ）を後で直しても、次の送信は整えて届く（同じ要求の語も届く）", async () => {
  reset({ spelldash_my_words: [{ en: "tea", ja: "お茶", addedAt: "2026-11-03T00:00:00.000Z" }] });
  const note = `${"あ".repeat(79)}😀`;
  S.mergeCloudItems([
    { kind: "my_word", key: "go", payload: { en: "go", ja: "行\u0001く", bookName: "仕\u0085事" }, deleted: false, updated_at: "2026-11-08T00:00:00.000Z" },
    { kind: "note", key: "my-go", payload: { text: note }, deleted: false, updated_at: "2026-11-08T00:00:00.000Z" }
  ], "u1");
  S.touchItem("note", "my-go");
  S.touchItem("my_word", "go");
  S.touchItem("my_word", "tea");
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const n = cloud.rows.get("note:my-go")?.payload.text ?? "";
  return (cloud.upserts().length === 1 && cloud.rows.size === 3 && n === `${"あ".repeat(79)}\uFFFD` && cloud.rows.get("my_word:go")?.payload.ja === "行く" && dirty().length === 0) || show({ calls: cloud.calls, n: n.length, dirty: dirty() });
});
await t("送る: 鍵そのものに送れない字（NUL・組になっていないサロゲート）がある項目は送らない（端末に残り、送る待ちにも残る）・ほかの語は届く", async () => {
  seedWords(4, [], [{ en: "go\u0000x", ja: "行く", addedAt: "2026-11-01T00:00:00.000Z" }, { en: "sun\ud800", ja: "太陽", addedAt: "2026-11-01T00:00:00.000Z" }]);
  const before = LS.getItem("spelldash_my_words");
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const left = dirty();
  return (cloud.upserts().length === 1 && cloud.rows.size === 4 && left.length === 2 && left.includes("my_word:go\u0000x") && left.includes("my_word:sun\ud800") && LS.getItem("spelldash_my_words") === before) || show({ calls: cloud.calls, left });
});
await t("分けて送り直す: 10 行の組に断られる行が 1 つ → ほかの 9 行は届く・断られた行は送る待ちに残り、印（失敗の時刻）が付く・要求は 1 + 2×4 まで", async () => {
  seedWords(10, [6]);
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const bad = `my_word:${LONG}6`;
  const n = cloud.upserts().length;
  return (cloud.rows.size === 9 && !sentKeys(cloud).includes(`${LONG}6`) && JSON.stringify(dirty()) === JSON.stringify([bad]) && meta()[bad]?.failAt === T0 && n <= 1 + 2 * Math.ceil(Math.log2(10))) ||
    show({ stored: cloud.rows.size, dirty: dirty(), mark: meta()[bad], n });
});
await t("分けて送り直す: 501 行（組 2 つ）の 1 組目に断られる行が 1 つ → 500 行は届く・要求は 2 + 2×9 まで", async () => {
  seedWords(501, [250]);
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const n = cloud.upserts().length;
  return (cloud.rows.size === 500 && dirty().length === 1 && n <= 2 + 2 * Math.ceil(Math.log2(500))) || show({ stored: cloud.rows.size, dirty: dirty().length, n });
});
await t("待つ: 断られた行は、同じ時刻の次の送信・待つ時間の内（1 日）では送らない（要求 0）・送る待ちに残る", async () => {
  seedWords(10, [6]);
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const after1 = cloud.upserts().length;
  await S.pushUserItems(cloud, "u1", { now: T0 });
  await S.pushUserItems(cloud, "u1", { now: T0 + RETRY - 1 });
  return (cloud.upserts().length === after1 && dirty().length === 1) || show({ after1, now: cloud.upserts().length, dirty: dirty() });
});
await t("待つ: 待つ時間（1 日）が過ぎたら 1 回だけ送り直す（その 1 行の要求 1 つ）・まだ断られたら印を付け直す", async () => {
  seedWords(10, [6]);
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const after1 = cloud.upserts().length;
  await S.pushUserItems(cloud, "u1", { now: T0 + RETRY });
  const bad = `my_word:${LONG}6`;
  return (cloud.upserts().length === after1 + 1 && cloud.upserts().at(-1).n === 1 && meta()[bad]?.failAt === T0 + RETRY && dirty().length === 1) || show({ after1, n: cloud.upserts().length, mark: meta()[bad] });
});
await t("待つ: 断られた行が変わったら（touchItem）、待たずに次の送信で送る", async () => {
  seedWords(10, [6]);
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const after1 = cloud.upserts().length;
  S.touchItem("my_word", `${LONG}6`);
  await S.pushUserItems(cloud, "u1", { now: T0 + 1 });
  return (cloud.upserts().length === after1 + 1 && cloud.upserts().at(-1).keys.includes(`${LONG}6`)) || show({ after1, n: cloud.upserts().length });
});
await t("上限: どの行も断られる（表の形の食い違いなど）→ 1 回の送信の要求は 1 + UPLOAD_SPLIT_MAX まで・全部の行に印・次の送信は要求 0（ページを開くたびに送り直さない）", async () => {
  for (const n of [60, 500]) {
    seedWords(n);
    const cloud = fakeCloud({ respond: () => ({ data: null, error: { code: "42703", message: "column" }, status: 400 }) });
    await S.pushUserItems(cloud, "u1", { now: T0 });
    const first = cloud.upserts().length;
    const marked = Object.values(meta()).filter((m) => m.failAt === T0).length;
    await S.pushUserItems(cloud, "u1", { now: T0 + 60_000 });
    if (!(typeof S.UPLOAD_SPLIT_MAX === "number" && first <= 1 + SPLIT && marked === n && cloud.upserts().length === first && dirty().length === n)) return show({ n, first, marked, then: cloud.upserts().length, dirty: dirty().length });
  }
  return true;
});
await t("分けないで次へ（前のまま）: 通信の失敗・5xx・401・持ち主が替わった（409）・投げた・状態の無い失敗は、組ごと送る待ちに残し、印を付けない（要求は組に 1 つ）", async () => {
  const cases = {
    net: () => ({ data: null, error: { message: "FetchError", code: "" }, status: 0 }),
    server: () => ({ data: null, error: { message: "down", code: "" }, status: 503 }),
    auth: () => ({ data: null, error: { message: "jwt expired", code: "" }, status: 401 }),
    area: () => ({ data: null, error: { message: "記録の持ち主が替わったため送らなかった。", code: "SD2_AREA" }, status: 409 }),
    thrown: () => { throw new TypeError("boom"); },
    nostatus: () => ({ data: null, error: { message: "記録の持ち主が替わったため送らなかった。", code: "SD2_AREA" } })
  };
  const bad = [];
  for (const [k, respond] of Object.entries(cases)) {
    seedWords(10);
    const cloud = fakeCloud({ respond });
    await S.pushUserItems(cloud, "u1", { now: T0 });
    const marks = Object.values(meta()).filter((m) => "failAt" in m).length;
    await S.pushUserItems(cloud, "u1", { now: T0 + 1 });
    if (cloud.upserts().length !== 2 || dirty().length !== 10 || marks !== 0) bad.push({ k, n: cloud.upserts().length, dirty: dirty().length, marks });
  }
  return bad.length === 0 || show(bad);
});
await t("day の行は前のまま: 古い制約（23514）で断られたら分けずにこのページでは送らない・送る待ちに残す・印を付けない・ほかの行は届く", async () => {
  const D = await import("../js/userItemsSync.js?day-case");
  const growth = [{ date: "2026-11-07", learned: 3, mastered: 1, active: true, v: 2 }, { date: "2026-11-08", learned: 5, mastered: 2, active: true, v: 2 }];
  const ids = ["day:2026-11-07", "day:2026-11-08", "my_word:go", "my_word:sun"];
  reset({
    spelldash_growth_log: growth,
    spelldash_my_words: [{ en: "go", ja: "行く" }, { en: "sun", ja: "太陽" }],
    spelldash_user_items_meta: Object.fromEntries(ids.map((id) => [id, { updatedAt: "2026-11-08T00:00:00.000Z", deleted: false }])),
    spelldash_user_items_dirty: ids
  });
  const cloud = fakeCloud({ noDay: true });
  await D.pushUserItems(cloud, "u1", { now: T0 });
  const dayUps1 = cloud.upserts().filter((c) => c.kinds.includes("day")).length;
  const marks = Object.values(meta()).filter((m) => "failAt" in m).length;
  await D.pushUserItems(cloud, "u1", { now: T0 + 1 });
  const dayUps2 = cloud.upserts().filter((c) => c.kinds.includes("day")).length;
  const left = dirty();
  return (dayUps1 === 1 && dayUps2 === 1 && marks === 0 && cloud.rows.size === 2 && left.length === 2 && left.every((id) => id.startsWith("day:"))) || show({ dayUps1, dayUps2, marks, stored: cloud.rows.size, left, calls: cloud.calls });
});
await t("取り込み（pullUserItems）の送り直しも同じ: 断られる行の要求は分けて、ほかの行は届く・同じ時刻の次の取り込み（ページを開き直す）では、その行を送らない（要求 0）", async () => {
  seedWords(5, [2]);
  LS.removeItem("spelldash_user_items_dirty");
  LS.removeItem("spelldash_user_items_meta");
  const cloud = fakeCloud();
  await S.pullUserItems(cloud, "u1", { now: T0 });
  const first = cloud.upserts().length;
  const stored = cloud.rows.size;
  const bad = `my_word:${LONG}2`;
  await S.pullUserItems(cloud, "u1", { now: T0 + 60_000 });
  const second = cloud.upserts().length - first;
  await S.pullUserItems(cloud, "u1", { now: T0 + RETRY });
  const third = cloud.upserts().length - first - second;
  return (stored === 4 && first <= 1 + 2 * Math.ceil(Math.log2(5)) && meta()[bad]?.failAt === T0 + RETRY && second === 0 && third === 1 && dirty().includes(bad)) || show({ stored, first, second, third, mark: meta()[bad], dirty: dirty() });
});

console.log(`test-text-safe: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
