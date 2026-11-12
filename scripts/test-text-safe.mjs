// 文字の守りと同期の頑丈さ（Batch 85。docs/SPEC_MY_WORDS.md §14）の単体:
//   1. 名前と訳の字の決まり（見えない制御文字・組になっていないサロゲート・向きを変える制御文字は入れない）は js/myWordsCore.js の 1 か所。
//      1 語ずつ足す・まとめて足す（その行だけ断り、行の名前を言う）・訳を直す・単語帳を作る／名前を変える・渡すリンクが同じ決まりを使う
//   2. 前からある語（バックアップの読み込み・ほかの端末から届いた行）は消さず、そのまま読める（端末の保存は書き換えない）
//   3. 送る形（js/userItemsSync.js）: 送る写しでは送り先が受け付けない字（NUL・組になっていないサロゲート）だけを U+FFFD に替える
//      （ほかの字は前のまま送る: 欄を空にしない・別の組と同じ組にしない）・行の中身で断られた組は半分ずつ送り直す（要求の数に上限）・
//      1 行だけで断られた行は待つ（その行が変わるか、待つ時間が過ぎたら送る）・day の行は前のまま
//   4. 反証の直し: 場面カードの鍵と訳を絵文字の途中で切らない・断った行の名前と直す欄はタブ・改行を空白にしてから見えない字を外す・
//      送り直しの 413／422・送っている間に変わった行・時計が戻ったとき
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
// 断る文（欄の名前の後に続く）: 字の名前（制御文字など）は言わず、何が入っているかと、どうすればよいかを言う
const NOTE = /見えない字や壊れた字が入っています。打ち直してください/;

// ===== 1. 決まりは 1 か所（js/myWordsCore.js） =====
await t("決まりの口: js/myWordsCore.js が UNSAFE_TEXT（正規表現）・isSafeText・withoutUnsafe・visibleText・UNSAFE_TEXT_ERROR（「見えない字や壊れた字が入っています。打ち直してください」。「制御文字」の語は使わない）を持つ", () =>
  (C.UNSAFE_TEXT instanceof RegExp && typeof C.isSafeText === "function" && typeof C.withoutUnsafe === "function" && typeof C.visibleText === "function" && NOTE.test(C.UNSAFE_TEXT_ERROR ?? "") && /打ち直してください$/.test(C.UNSAFE_TEXT_ERROR ?? "") && !/制御文字/.test(C.UNSAFE_TEXT_ERROR ?? "")) ||
  show({ re: String(C.UNSAFE_TEXT), safe: typeof C.isSafeText, without: typeof C.withoutUnsafe, visible: typeof C.visibleText, err: C.UNSAFE_TEXT_ERROR }));
await t("決まりは 1 か所: js/myWordsShare.js は自分の正規表現を持たず、js/myWordsCore.js の決まりを使う（渡すリンクの振る舞いは前のまま: scripts/test-share.mjs）", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "myWordsShare.js"), "utf8");
  const own = /\bconst\s+UNSAFE_TEXT\s*=/.test(src) || /\\u202A-\\u202E/i.test(src.replace(/\/\/.*$/gm, ""));
  return !own || "js/myWordsShare.js に自分の UNSAFE_TEXT がある";
});
await t("訳（checkJaText）: 制御文字・C1・向きを変える制御文字・組になっていないサロゲートは断る（理由は「日本語訳に見えない字や壊れた字…」・打った字を文に入れない）", () => {
  const bad = ALL_BAD.map(([k, ch]) => [k, C.checkJaText(`請求${ch}書`)]).filter(([, r]) => r.ok || !/日本語訳/.test(r.error ?? "") || !NOTE.test(r.error ?? "") || ALL_BAD.some(([, c]) => (r.error ?? "").includes(c)));
  return bad.length === 0 || show(bad);
});
await t("訳（checkJaText）: タブ・改行・縦タブは空白 1 つ（前のまま）・絵文字の組・全角の空白・ゼロ幅の字・向きの印（LRM）は読める", () => {
  const rs = ["行く\tこと\n", "a\u000bb", "楽しい😀", "よい\u3000とても", "x\u200By", "y\u200Ez"].map((s) => C.checkJaText(s));
  return (rs.every((r) => r.ok) && rs[0].ja === "行く こと" && rs[1].ja === "a b" && rs[2].ja === "楽しい😀") || show(rs);
});
await t("英語（checkEnText）: 見えない字は「英語に見えない字や壊れた字…」で断り、打った字を文に入れない（ほかの使えない字の文は前のまま）", () => {
  const rs = [["NUL", "go\u0000"], ["RLO", "\u202Ego"], ["上だけ", "go\ud800"], ["C1", "go\u0085"]].map(([k, s]) => [k, C.checkEnText(s)]);
  const bad = rs.filter(([, r]) => r.ok || !/^英語に/.test(r.error ?? "") || !NOTE.test(r.error ?? "") || ALL_BAD.some(([, c]) => (r.error ?? "").includes(c)));
  const cafe = C.checkEnText("café");
  return (bad.length === 0 && !cafe.ok && /「café」は使えない字を含みます/.test(cafe.error)) || show({ bad, cafe });
});
await t("単語帳の名前（checkBookName）: 見えない字は「単語帳の名前に見えない字や壊れた字…」で断る・絵文字は使える", () => {
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
  return (JSON.stringify(r.added) === '["sun"]' && r.skipped.length === 1 && /^go（行く）: 英語に見えない字や壊れた字/.test(r.skipped[0]) && JSON.stringify(r.rest) === JSON.stringify(["go\u0000, 行く"])) || show(r);
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
  return (r.ok && r.added.join() === "go" && r.skipped.length === 1 && /^tea（お茶）: 日本語訳に見えない字や壊れた字/.test(r.skipped[0])) || show(r);
});
await t("場面カード（addMyConcept。古い単語帳のページと文から作る道。今は閉じた画面だけ）も同じ決まり: 場面・答え・解説・別解に見えない字は断る・何も書かない・改行とタブは前のまま通す", () => {
  const base = { q: "会議の前に配る、話すことの一覧", answer: "agenda", explain: "議題", accept: "" };
  const cases = [["q", "場面", "会議の前に\u0000配る一覧"], ["answer", "答え", "agen\u202Eda"], ["explain", "解説", "議\ud800題"], ["accept", "別解", "agendum/age\u0085nda"]];
  const bad = [];
  for (const [field, label, value] of cases) {
    reset();
    const r = M.addMyConcept({ ...base, [field]: value });
    if (r.ok || !(r.error ?? "").startsWith(`${label}に`) || !NOTE.test(r.error ?? "") || LS.writes.length > 0) bad.push([field, r, LS.writes.length]);
  }
  reset();
  const fine = M.addMyConcept({ ...base, q: "会議の前に\n配る、話すことの\t一覧" });
  return (bad.length === 0 && fine.ok && words().length === 1) || show({ bad, fine });
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
// key が 200 字より長い行も要求ごと断る（400・23514: 表の check）。断るときは 1 行も書かない（要求は 1 つの文）。respond で答えを差し替える。
// 読み（Batch 87）: order（安定な並べ替え）・range（切り出し）・count（並べて切り出す前の数）を本物と同じに扱う。maxRows: 1 回の読みで返す行の上限（本物の Max Rows）。
// noCount: count を返さない。readAt(from): その行から始まる読みの答えを差し替える（失敗・行が消えた形）。行はクラウドの表の並び（rows の入れた順）
// 書き（Batch 95。本物の表の窓口と同じ形）: upsert(行, { ignoreDuplicates: true }) は同じ主キーの行があれば書かない。後に .select(列) が続けば
// 書いた行だけを data に返す（続かなければ null）。オプションの無い upsert は前のまま（上書き）。要求の記録の ignore はその選択肢を渡したか
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
      const ignore = !!up[2]?.ignoreDuplicates;
      const returning = ops.indexOf(up) < ops.findIndex((o) => o[0] === "select");
      const call = { op: "upsert", n: list.length, kinds: [...new Set(list.map((r) => r.kind))], keys: list.map((r) => r.key), ...(ignore ? { ignore } : {}) };
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
      const wrote = [];
      for (const r of list) {
        if (ignore && rows.has(`${r.kind}:${r.key}`)) continue;
        rows.set(`${r.kind}:${r.key}`, JSON.parse(JSON.stringify(r)));
        wrote.push({ kind: r.kind, key: r.key });
      }
      call.ok = true;
      return { data: returning ? wrote : null, error: null, status: 201 };
    }
    const range = ops.find((o) => o[0] === "range");
    const call = { op: "select", from: range ? range[1] : null, n: 0 };
    calls.push(call);
    const swap = range && opts.readAt ? opts.readAt(range[1]) : null;
    if (swap) return swap;
    let data = [...rows.values()];
    for (const o of ops) {
      if (o[0] === "eq") data = data.filter((r) => r[o[1]] === o[2]);
      if (o[0] === "in") data = data.filter((r) => o[2].includes(r[o[1]]));
    }
    const orders = ops.filter((o) => o[0] === "order").map((o) => [o[1], o[2]?.ascending !== false]);
    if (orders.length) {
      data = data.map((r, i) => [r, i]).sort((a, b) => {
        for (const [col, asc] of orders) {
          if (a[0][col] === b[0][col]) continue;
          return (a[0][col] < b[0][col] ? -1 : 1) * (asc ? 1 : -1);
        }
        return a[1] - b[1];
      }).map(([r]) => r);
    }
    const total = data.length;
    if (range) data = data.slice(range[1], range[2] + 1);
    if (opts.maxRows > 0) data = data.slice(0, opts.maxRows);
    call.n = data.length;
    const counted = ops.some((o) => o[0] === "select" && o[2]?.count) && !opts.noCount;
    return { data: JSON.parse(JSON.stringify(data)), error: null, status: 200, count: counted ? total : null };
  }
  return {
    rows,
    calls,
    upserts: () => calls.filter((c) => c.op === "upsert"),
    reads: () => calls.filter((c) => c.op === "select" && c.from !== null).map((c) => [c.from, c.n]),
    from() {
      const ops = [];
      const b = {
        upsert(x, o) { ops.push(["upsert", x, o]); return b; },
        select(c, o) { ops.push(["select", c, o]); return b; },
        eq(k, v) { ops.push(["eq", k, v]); return b; },
        in(k, v) { ops.push(["in", k, v]); return b; },
        order(c, o) { ops.push(["order", c, o]); return b; },
        range(f, t) { ops.push(["range", f, t]); return b; },
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

await t("送る字を整える（cleanSendValue）: 送り先が受け付けない字だけを U+FFFD に替える（NUL・組になっていないサロゲート。1 字を 1 字に）・ほかの制御文字・DEL・C1・向きを変える字は前のまま・入れ子と鍵の名前も・元の値は変えない", () => {
  const input = { en: "go", ja: "a\u0000b\u0001c\td\ne\rf\u007f\u0085\u009fg", n: 3, ok: true, none: null, list: ["x\ud800y", "😀", "\udfff", "\udc00\ud800"], deep: { "k\u0000": "\u202Eabc" } };
  const copy = JSON.parse(JSON.stringify(input));
  const out = S.cleanSendValue(input);
  const want = { en: "go", ja: "a\uFFFDb\u0001c\td\ne\rf\u007f\u0085\u009fg", n: 3, ok: true, none: null, list: ["x\uFFFDy", "😀", "\uFFFD", "\uFFFD\uFFFD"], deep: { "k\uFFFD": "\u202Eabc" } };
  return (JSON.stringify(out) === JSON.stringify(want) && JSON.stringify(input) === JSON.stringify(copy)) || show(out);
});
await t("送る: 前からの見えない字のある語（バックアップ・ほかの端末から）も、整えた写し（NUL と組になっていないサロゲートは U+FFFD）で 1 回で届く・ほかの語も届く・端末の保存は 1 字も変えない", async () => {
  reset({
    spelldash_my_words: OLD_RAW,
    spelldash_user_items_meta: Object.fromEntries(OLD_WORDS.map((w) => [`my_word:${w.en}`, { updatedAt: "2026-11-08T00:00:00.000Z", deleted: false }])),
    spelldash_user_items_dirty: OLD_WORDS.map((w) => `my_word:${w.en}`)
  });
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const go = cloud.rows.get("my_word:go");
  const sun = cloud.rows.get("my_word:sun");
  return (cloud.upserts().length === 1 && cloud.rows.size === 3 && go?.payload.ja === "行\uFFFDく" && go?.payload.bookName === "仕\u202E事" && sun?.payload.ja === "太陽\uFFFD" && dirty().length === 0 && LS.getItem("spelldash_my_words") === OLD_RAW) ||
    show({ calls: cloud.calls, n: cloud.rows.size, go: go?.payload, dirty: dirty() });
});
await t("送る: バックアップから戻した語（見えない字あり）も、次の送信で整えて届く（戻した保存はそのまま）", async () => {
  if (!B) return "js/backup.js が無い";
  reset();
  const m = Object.fromEntries(OLD_WORDS.map((w) => [`my_word:${w.en}`, { updatedAt: "2026-11-08T00:00:00.000Z", deleted: false }]));
  B.applyBackup({ app: "SpellDash", version: 1, data: { spelldash_schema_version: "7", spelldash_my_words: OLD_RAW, spelldash_user_items_meta: JSON.stringify(m), spelldash_user_items_dirty: JSON.stringify(Object.keys(m)) } });
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  return (cloud.rows.size === 3 && cloud.rows.get("my_word:go")?.payload.ja === "行\uFFFDく" && dirty().length === 0 && LS.getItem("spelldash_my_words") === OLD_RAW) || show({ calls: cloud.calls, dirty: dirty() });
});
await t("送る: ほかの端末から届いた行（見えない字・80 字で切れたメモ）を後で直しても、次の送信は届く（送り先が受け付けない字だけを替える: メモの絵文字の半分は U+FFFD・ほかの制御文字は前のまま。同じ要求の語も届く）", async () => {
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
  const go = cloud.rows.get("my_word:go")?.payload;
  // Batch 95: 雲に行の無い鍵の語は「無いときだけ書く」要求で別に送る（ほかの行と 2 つの要求）
  return (cloud.upserts().length === 2 && cloud.rows.size === 3 && n === `${"あ".repeat(79)}\uFFFD` && go?.ja === "行\u0001く" && go?.bookName === "仕\u0085事" && dirty().length === 0) || show({ calls: cloud.calls, n: n.length, go, dirty: dirty() });
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

// ===== 5. 反証の直し（fixer） =====
// 5.1 送る写しは送り先が受け付けない字（NUL・組になっていないサロゲート）だけを U+FFFD に替える: ほかの端末で欄が空にならない（語が消えて見えない）・
//     別の組と同じ組にならない・送り先が受け付ける字（C1・向きを変える字）が鍵にある前からの項目も送る
// 2 台目の端末（B）: 送り先に届いた行だけを持つ空の端末で取り込む
const onOtherDevice = (cloud) => {
  reset();
  S.mergeCloudItems([...cloud.rows.values()], "u1");
  return { list: M.getMyWords(), raw: words(), notes: JSON.parse(LS.getItem("spelldash_word_notes") || "{}") };
};
const seedItems = (list, notes = {}, extra = []) => {
  const ids = [...list.map((w) => `my_word:${w.en}`), ...Object.keys(notes).map((k) => `note:${k}`)];
  const m = Object.fromEntries(ids.map((id) => [id, { updatedAt: "2026-11-08T00:00:00.000Z", deleted: false }]));
  for (const [id, mm] of extra) m[id] = mm;
  reset({ spelldash_my_words: list, spelldash_word_notes: notes, spelldash_user_items_meta: m, spelldash_user_items_dirty: [...ids, ...extra.map(([id]) => id)] });
};
await t("5.1 送る: 前からの訳・場面・メモが見えない字だけ（制御文字 2 つ・NUL だけ）でも、ほかの端末で語もメモも見える（送る写しで欄を空にしない。NUL は U+FFFD、ほかの制御文字は前のまま）", async () => {
  const A = [
    { en: "tab", ja: "\u0001\u0085", addedAt: "2026-01-01T00:00:00.000Z" },
    { en: "nul", ja: "\u0000", addedAt: "2026-01-01T00:00:00.000Z" },
    { kind: "concept", en: "scene", answer: "scene", q: "\u0002\u0003\u0004\u0005", explain: "", accept: [], ja: "", addedAt: "2026-01-01T00:00:00.000Z" }
  ];
  seedItems(A, { "my-tab": "\u0001\u0002" });
  const seenOnA = M.getMyWords().length;
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const sent = { tab: cloud.rows.get("my_word:tab")?.payload.ja, nul: cloud.rows.get("my_word:nul")?.payload.ja, q: cloud.rows.get("my_word:scene")?.payload.q, note: cloud.rows.get("note:my-tab")?.payload.text };
  const B = onOtherDevice(cloud);
  const byEn = Object.fromEntries(B.list.map((w) => [w.en, w]));
  // Batch 95: 雲に行の無い鍵の語は「無いときだけ書く」要求で別に送る（ほかの行と 2 つの要求）
  return (seenOnA === 3 && cloud.upserts().length === 2 && sent.tab === "\u0001\u0085" && sent.nul === "\uFFFD" && sent.q === "\u0002\u0003\u0004\u0005" && sent.note === "\u0001\u0002"
    && B.list.length === 3 && byEn.tab?.ja === "\u0001\u0085" && byEn.nul?.ja === "\uFFFD" && byEn.scene?.q === "\u0002\u0003\u0004\u0005" && B.notes["my-tab"] === "\u0001\u0002") ||
    show({ seenOnA, sent, onB: B.raw, notes: B.notes });
});
await t("5.1 送る: NUL のある訳は U+FFFD にして送るので、ほかの端末で別の組（同じ英語・NUL の無い訳）と同じ組にならない（り・NUL・んご と りんご は 2 つの別の組のまま）", async () => {
  const second = C.myIdentityFor([{ en: "apple" }], "apple", "りんご");
  seedItems([{ en: "apple", ja: "り\u0000んご", addedAt: "2026-01-01T00:00:00.000Z" }, { en: second, ja: "りんご", text: "apple", addedAt: "2026-01-02T00:00:00.000Z" }]);
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const B = onOtherDevice(cloud);
  const same = B.list.filter((w) => C.answerKeyOf(w) === "apple" && C.normJa(w.ja) === "りんご");
  return (second !== "apple" && cloud.rows.size === 2 && B.list.length === 2 && same.length === 1 && B.list.find((w) => w.en === "apple")?.ja === "り\uFFFDんご") || show({ second, onB: B.raw });
});
await t("5.1 送る: 鍵に送り先が受け付ける見えない字（C1 の U+0085・向きを上書きする字）がある前からの項目は、鍵を変えずに送る（生きた項目も消した墓標も・送る待ちに残らない）。NUL の鍵は前のまま送らない", async () => {
  const A = [
    { kind: "concept", en: "a\u0085b", answer: "a\u0085b", q: "場面の説明です", explain: "", accept: [], ja: "", addedAt: "2026-01-01T00:00:00.000Z" },
    { kind: "concept", en: "x\u202Ey", answer: "x\u202Ey", q: "場面の説明です", explain: "", accept: [], ja: "", addedAt: "2026-01-01T00:00:00.000Z" },
    { kind: "concept", en: "n\u0000g", answer: "ng", q: "場面の説明です", explain: "", accept: [], ja: "", addedAt: "2026-01-01T00:00:00.000Z" }
  ];
  // 消した墓標は、消したカード（card）と同じ雲の生きた行に会ったときだけ送る（Batch 95 の設計。雲に行の無い墓標は送らずに外す）
  seedItems(A, {}, [["my_word:c\u0085d", { updatedAt: "2026-11-08T00:00:00.000Z", deleted: true, card: { addedAt: "2026-01-01T00:00:00.000Z", jaHash: C.jaHash("") } }]]);
  const cloud = fakeCloud();
  cloud.rows.set("my_word:c\u0085d", { user_id: "u1", kind: "my_word", key: "c\u0085d", payload: { kind: "concept", en: "c\u0085d", answer: "c\u0085d", q: "場面の説明です", explain: "", accept: [], ja: "", addedAt: "2026-01-01T00:00:00.000Z" }, deleted: false, updated_at: "2026-01-01T00:00:00.000Z" });
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const live = cloud.rows.get("my_word:a\u0085b");
  const tomb = cloud.rows.get("my_word:c\u0085d");
  // Batch 95: 雲に行の無い鍵の語は「無いときだけ書く」要求で別に送る（ほかの行と 2 つの要求）
  return (cloud.upserts().length === 2 && live?.deleted === false && live?.payload.q === "場面の説明です" && cloud.rows.has("my_word:x\u202Ey") && tomb?.deleted === true && cloud.rows.size === 3
    && JSON.stringify(dirty()) === JSON.stringify(["my_word:n\u0000g"])) || show({ keys: [...cloud.rows.keys()], dirty: dirty() });
});

// 5.2 場面カード（addMyConcept）の鍵と訳: 40 字で切るときに絵文字（組になったサロゲート）を半分にしない。切る所が絵文字の途中でなければ前と同じ
await t("5.2 場面カードの鍵: NFKC で長くなる答え（㍿ → 株式会社）を 40 字で切るときに絵文字を半分にしない（鍵に組になっていないサロゲートを作らない）・作ったカードは送ると届く（送る待ちに残らない）", async () => {
  reset();
  const r = M.addMyConcept({ q: "場面の説明です", answer: `${"㍿".repeat(9)}あいう😀` });
  const w = words().find((x) => x.kind === "concept");
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  return (r.ok && w?.en === `${"株式会社".repeat(9)}あいう` && C.isSafeText(w?.en) && cloud.rows.has(`my_word:${w?.en}`) && dirty().length === 0) ||
    show({ r, key: w?.en, tail: w?.en?.slice(-3), dirty: dirty(), calls: cloud.calls });
});
await t("5.2 場面カードの鍵: 切る所が絵文字の途中でなければ前と同じ（40 字目までに絵文字がまるごと入る答えは絵文字ごと・40 字より短い答えはそのまま）", () => {
  reset();
  const a = M.addMyConcept({ q: "場面の説明です", answer: `${"㍿".repeat(9)}あい😀` });
  const b = M.addMyConcept({ q: "場面の説明です", answer: "Agenda 😀" });
  const keys = words().map((x) => x.en);
  return (a.ok && b.ok && JSON.stringify(keys) === JSON.stringify([`${"株式会社".repeat(9)}あい😀`, "agenda😀"]) && keys.every((k) => C.isSafeText(k))) || show({ a, b, keys });
});
await t("5.2 場面カードの訳（解説の頭 40 字）: 絵文字を半分にしない（切る所が絵文字の途中なら絵文字の前まで・40 字目までに入る絵文字は残す）", () => {
  reset();
  const a = M.addMyConcept({ q: "場面の説明です", answer: "用語", explain: `${"あ".repeat(39)}😀説明` });
  const ja1 = words()[0]?.ja;
  reset();
  const b = M.addMyConcept({ q: "場面の説明です", answer: "用語", explain: `${"あ".repeat(38)}😀説明` });
  const ja2 = words()[0]?.ja;
  return (a.ok && b.ok && ja1 === "あ".repeat(39) && ja2 === `${"あ".repeat(38)}😀` && C.isSafeText(ja1) && C.isSafeText(ja2)) || show({ a, b, ja1, ja2 });
});

// 5.3 画面に出す形（visibleText）: タブ・改行などの空白の字は空白 1 つにしてから見えない字を外す（語がつながらない）。保存は書き換えない
await t("5.3 visibleText: タブ・改行・復帰は空白にしてから見えない字を外す（「a b cde」）・字の無い物は空の文字", () => {
  const a = C.visibleText("a\tb\nc\u0000d\u202Ee\ud800");
  const b = C.visibleText("x\r\ny");
  return (a === "a b cde" && b === "x  y" && C.visibleText(undefined) === "" && C.visibleText("\u0001") === "") || show({ a, b });
});
await t("5.3 まとめて足す: 断った行の名前はタブを空白にして見せる（「日本語だけ の行」「tea（お茶 です）」。語がつながらない）・欄に残す行は貼った形のまま", () => {
  reset();
  const r = M.addMyWordsBulk("go, 行く\n日本語だけ\tの行\ntea, お\u0000茶\tです", "main");
  return (JSON.stringify(r.added) === '["go"]' && r.skipped.length === 2 && r.skipped[0] === "日本語だけ の行: 英語が無い。「english, 訳」の形で書く" && /^tea（お茶 です）: 日本語訳に/.test(r.skipped[1])
    && JSON.stringify(r.rest) === JSON.stringify(["日本語だけ\tの行", "tea, お\u0000茶\tです"])) || show(r);
});

// 5.4 送り直しの分かれ道: 413・422 も行の中身で断られた組として半分ずつ送り直す・送っている間に変わった行には印を付けない・時計が戻ったら待たない
await t("5.4 分けて送り直す: 送り先が 413（大きすぎる）・422（中身が合わない）で断る組も半分ずつ送り直し、ほかの 9 行は届く・断られた 1 行だけに印", async () => {
  const bad = [];
  for (const status of [413, 422]) {
    seedWords(10);
    const cloud = fakeCloud({ respond: (list) => (list.some((r) => r.key === "w006") ? { data: null, error: { code: "", message: "rejected" }, status } : null) });
    await S.pushUserItems(cloud, "u1", { now: T0 });
    const n = cloud.upserts().length;
    if (!(cloud.rows.size === 9 && !cloud.rows.has("my_word:w006") && JSON.stringify(dirty()) === '["my_word:w006"]' && meta()["my_word:w006"]?.failAt === T0 && n <= 1 + 2 * Math.ceil(Math.log2(10)))) bad.push({ status, stored: cloud.rows.size, dirty: dirty(), mark: meta()["my_word:w006"], n });
  }
  return bad.length === 0 || show(bad);
});
await t("5.4 送っている間にその行が変わったら（touchItem）、断られても新しい版に印を付けない・次の送信で新しい版を送る（1 日待たない）", async () => {
  seedWords(10, [6]);
  const bad = `${LONG}6`;
  let touched = false;
  const cloud = fakeCloud({
    respond: (list) => {
      if (!touched && list.some((r) => r.key === bad)) {
        touched = true;
        S.touchItem("my_word", bad, false, "2026-11-08T12:00:00.000Z"); // 送っている間に直した
      }
      return null; // 返事は本物と同じ（長すぎる鍵の行があれば 400）
    }
  });
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const m1 = meta()[`my_word:${bad}`];
  const before = cloud.upserts().filter((c) => c.keys.includes(bad)).length;
  await S.pushUserItems(cloud, "u1", { now: T0 + 1 });
  const after = cloud.upserts().filter((c) => c.keys.includes(bad)).length;
  return (touched && m1 && !("failAt" in m1) && m1.updatedAt === "2026-11-08T12:00:00.000Z" && dirty().includes(`my_word:${bad}`) && cloud.rows.size === 9 && after === before + 1) || show({ touched, m1, before, after, dirty: dirty() });
});
await t("5.4 時計が戻って印の時刻が先になったら待たない（次の送信でその行を送る）", async () => {
  seedWords(10, [6]);
  const bad = `${LONG}6`;
  const cloud = fakeCloud();
  await S.pushUserItems(cloud, "u1", { now: T0 });
  const after1 = cloud.upserts().length;
  await S.pushUserItems(cloud, "u1", { now: T0 - 1000 });
  return (meta()[`my_word:${bad}`]?.failAt === T0 - 1000 && cloud.upserts().length === after1 + 1 && cloud.upserts().at(-1).keys.includes(bad)) || show({ after1, n: cloud.upserts().length, mark: meta()[`my_word:${bad}`] });
});

// ===== 6. 読み方と送る待ち（Batch 87。docs/SPEC_MY_WORDS.md §16.1・§16.2） =====
// 1 回の読みで返る行には上限がある（データベースの会社の API の既定は 1000 行）。readAllRows は主キーの列で並べて 1000 行ずつ、count に届くまで読む。
// 読み切れなければ失敗（取り込みは「クラウドに無い」と見て送り返す道へ進まない）。最初の取り込みで送れた行は送る待ちから外す
const T_OLD = "2026-11-01T00:00:00.000Z";
const T_NEW = "2026-11-08T00:00:00.000Z";
const keyN = (i) => `k${String(i).padStart(4, "0")}`;
const wordN = (i, ja = `訳${i}`) => ({ en: keyN(i), ja, addedAt: T_OLD });
const rowOfWord = (w, at = T_OLD) => ({ user_id: "u1", kind: "my_word", key: w.en, payload: w, deleted: false, updated_at: at });
const dayRowN = (i) => ({ user_id: "u1", kind: "day", key: `2026-08-${String(1 + (i % 28)).padStart(2, "0")}`, payload: { learned: i, mastered: 0, active: true, set: false, sets: 0 }, deleted: false, updated_at: T_OLD });
// 送り先の表に行を入れた順で置く（words の後ろに extra。並べない読みでは、上限より後ろの行は届かない）
const cloudWith = (rowsInOrder, opts = {}) => {
  const cloud = fakeCloud(opts);
  for (const r of rowsInOrder) cloud.rows.set(`${r.kind}:${r.key}`, r);
  return cloud;
};
const readAll = (cloud) => (typeof S.readAllRows === "function" ? S.readAllRows(cloud, "user_items", ["kind", "key"]) : Promise.reject(new Error("readAllRows が無い")));
await t("6.1 readAllRows: 1,090 行（上限 1000 行）を 1000 行ずつ 2 回で全部読む（1000＋90）・並びは主キーの列", async () => {
  const words = Array.from({ length: 1000 }, (_, i) => wordN(i));
  const cloud = cloudWith([...words.map((w) => rowOfWord(w)), ...Array.from({ length: 90 }, (_, i) => ({ ...dayRowN(i), key: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}` }))], { maxRows: 1000 });
  const r = await readAll(cloud);
  const keys = (r.rows ?? []).map((x) => `${x.kind}:${x.key}`);
  return (r.ok === true && r.rows.length === 1090 && new Set(keys).size === 1090 && JSON.stringify(cloud.reads()) === JSON.stringify([[0, 1000], [1000, 90]]) && keys[0].startsWith("day:")) || show({ ok: r.ok, n: r.rows?.length, reads: cloud.reads() });
});
await t("6.2 readAllRows: 1 回の上限が 500 行でも全部読む（500＋500＋90。次の頭は受け取った行の数だけ進める）", async () => {
  const cloud = cloudWith(Array.from({ length: 1090 }, (_, i) => rowOfWord(wordN(i))), { maxRows: 500 });
  const r = await readAll(cloud);
  return (r.ok === true && r.rows.length === 1090 && JSON.stringify(cloud.reads()) === JSON.stringify([[0, 500], [500, 500], [1000, 90]])) || show({ ok: r.ok, n: r.rows?.length, reads: cloud.reads() });
});
await t("6.3 readAllRows: 200 行の人は 1 回（count で終わる）・count を返さない送り先では 0 行の答えまで読む（2 回）", async () => {
  const a = cloudWith(Array.from({ length: 200 }, (_, i) => rowOfWord(wordN(i))), { maxRows: 1000 });
  const ra = await readAll(a);
  const b = cloudWith(Array.from({ length: 200 }, (_, i) => rowOfWord(wordN(i))), { maxRows: 1000, noCount: true });
  const rb = await readAll(b);
  return (ra.ok && ra.rows.length === 200 && JSON.stringify(a.reads()) === JSON.stringify([[0, 200]]) && rb.ok && rb.rows.length === 200 && JSON.stringify(b.reads()) === JSON.stringify([[0, 200], [200, 0]])) || show({ a: [ra.ok, ra.rows?.length, a.reads()], b: [rb.ok, rb.rows?.length, b.reads()] });
});
await t("6.4 readAllRows: 2 ページ目の読みの失敗・count に届く前の 0 行の答え・ページの数の上限（50）では読みは失敗（行を返さない）", async () => {
  const fail = cloudWith(Array.from({ length: 1090 }, (_, i) => rowOfWord(wordN(i))), { maxRows: 1000, readAt: (from) => (from === 1000 ? { data: null, error: { message: "boom" }, status: 500 } : null) });
  const rf = await readAll(fail);
  const gone = cloudWith(Array.from({ length: 1090 }, (_, i) => rowOfWord(wordN(i))), { maxRows: 1000, readAt: (from) => (from === 1000 ? { data: [], error: null, status: 200, count: 1090 } : null) });
  const rg = await readAll(gone);
  const many = cloudWith(Array.from({ length: 60 }, (_, i) => rowOfWord(wordN(i))), { maxRows: 1 });
  const rm = await readAll(many);
  return (rf.ok === false && !rf.rows && rg.ok === false && !rg.rows && rm.ok === false && many.reads().length === 50) || show({ rf: rf.ok, rg: rg.ok, rm: rm.ok, reads: many.reads().length });
});
// 1 台目の端末（全部ある）: 1,000 語・印の時刻はクラウドと同じ・送る待ちは空。target の語は古い訳
const seedSynced = (words) => reset({ spelldash_my_words: words, spelldash_user_items_meta: Object.fromEntries(words.map((w) => [`my_word:${w.en}`, { updatedAt: T_OLD, deleted: false }])), spelldash_user_items_dirty: [] });
await t("6.5 取り込み: 上限 1000 行の送り先に 1,090 行（新しい訳の行は 1,001 行目より後）でも全部読む・新しい訳を取り込み、古い訳で送り返さない（upsert 0）", async () => {
  const all = Array.from({ length: 1000 }, (_, i) => wordN(i));
  seedSynced(all);
  const target = all[3];
  const cloud = cloudWith([...all.filter((w) => w !== target).map((w) => rowOfWord(w)), ...Array.from({ length: 90 }, (_, i) => ({ ...dayRowN(i), key: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}` })), rowOfWord({ ...target, ja: "新しい訳" }, T_NEW)], { maxRows: 1000 });
  const r = await S.pullUserItems(cloud, "u1", { now: T0 });
  const local = words().find((w) => w.en === target.en);
  const sentWords = cloud.upserts().reduce((n, c) => n + c.keys.filter((k) => k.startsWith("k")).length, 0);
  return (r.changed?.my_word === true && local?.ja === "新しい訳" && cloud.rows.get(`my_word:${target.en}`)?.payload?.ja === "新しい訳" && sentWords === 0) || show({ changed: r.changed, local: local?.ja, cloud: cloud.rows.get(`my_word:${target.en}`)?.payload?.ja, sentWords, reads: cloud.reads() });
});
await t("6.6 取り込み: 2 ページ目の読みが失敗したら何も取り込まず・何も送らない（changed は null・端末の語は前のまま）", async () => {
  const all = Array.from({ length: 1000 }, (_, i) => wordN(i));
  seedSynced(all);
  const before = LS.getItem("spelldash_my_words");
  const cloud = cloudWith([...all.slice(0, 990).map((w) => rowOfWord(w)), ...all.slice(990).map((w) => rowOfWord({ ...w, ja: "新しい訳" }, T_NEW)), ...Array.from({ length: 90 }, (_, i) => ({ ...dayRowN(i), key: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}` }))], { maxRows: 1000, readAt: (from) => (from === 1000 ? { data: null, error: { message: "boom" }, status: 503 } : null) });
  const r = await S.pullUserItems(cloud, "u1", { now: T0 });
  return (r.changed === null && cloud.upserts().length === 0 && LS.getItem("spelldash_my_words") === before) || show({ changed: r.changed, ups: cloud.upserts().length, same: LS.getItem("spelldash_my_words") === before });
});
await t("6.7 最初の取り込み（1,000 語が送る待ち・送り先は空）: 送れた行は送る待ちから外す（0 行）・続けて送っても 0 回", async () => {
  seedWords(1000);
  const cloud = fakeCloud();
  await S.pullUserItems(cloud, "u1", { now: T0 });
  const first = cloud.upserts().map((c) => c.n);
  const left = dirty().length;
  await S.pushUserItems(cloud, "u1", { now: T0 + 1 });
  return (JSON.stringify(first) === "[500,500]" && left === 0 && cloud.upserts().length === 2 && cloud.rows.size === 1000) || show({ first, left, ups: cloud.upserts().length, stored: cloud.rows.size });
});
await t("6.8 最初の取り込み: 送っている間にまた直した語は送る待ちに残り、次の送信で新しい訳が届く（ほかの語は外す）", async () => {
  seedWords(20);
  let touched = false;
  const cloud = fakeCloud({
    respond: () => {
      if (!touched) {
        touched = true;
        M.setMyWordJa("w005", "送っている間に直した訳");
      }
      return null;
    }
  });
  await S.pullUserItems(cloud, "u1", { now: T0 });
  const left = dirty();
  await S.pushUserItems(cloud, "u1", { now: T0 + 1 });
  const sent = cloud.upserts().at(-1);
  return (touched && JSON.stringify(left) === JSON.stringify(["my_word:w005"]) && sent?.keys.join() === "w005" && cloud.rows.get("my_word:w005")?.payload?.ja === "送っている間に直した訳" && dirty().length === 0) || show({ touched, left, sent: sent?.keys, cloud: cloud.rows.get("my_word:w005")?.payload?.ja, dirty: dirty() });
});
await t("6.9 最初の取り込み: 送れなかった組（503）の行だけ送る待ちに残る・送れた組の行は外す", async () => {
  seedWords(1000);
  const cloud = fakeCloud({ respond: (list) => (list.some((r) => r.key === "w700") ? { data: null, error: { code: "", message: "unavailable" }, status: 503 } : null) });
  await S.pullUserItems(cloud, "u1", { now: T0 });
  const left = new Set(dirty());
  const want = Array.from({ length: 500 }, (_, i) => `my_word:w${String(500 + i).padStart(3, "0")}`);
  return (left.size === 500 && want.every((id) => left.has(id)) && cloud.rows.size === 500) || show({ left: left.size, sample: [...left].slice(0, 3), stored: cloud.rows.size });
});
await t("6.10 取り込み: クラウドの方が新しくて取り込んだ語は送る待ちから外す（送り返さない）・消した語の墓標は送る待ちに残り、次の送信で送る", async () => {
  const three = Array.from({ length: 3 }, (_, i) => wordN(i));
  reset({
    spelldash_my_words: three.slice(0, 2),
    spelldash_user_items_meta: { [`my_word:${three[0].en}`]: { updatedAt: T_OLD, deleted: false }, [`my_word:${three[1].en}`]: { updatedAt: T_OLD, deleted: false }, [`my_word:${three[2].en}`]: { updatedAt: T_OLD, deleted: true } },
    spelldash_user_items_dirty: [`my_word:${three[0].en}`, `my_word:${three[2].en}`]
  });
  const cloud = cloudWith([rowOfWord({ ...three[0], ja: "新しい訳" }, T_NEW), rowOfWord(three[1]), rowOfWord(three[2], "2026-10-01T00:00:00.000Z")]);
  await S.pullUserItems(cloud, "u1", { now: T0 });
  const left = dirty();
  await S.pushUserItems(cloud, "u1", { now: T0 + 1 });
  const pushed = cloud.upserts().map((c) => c.keys.join());
  // Batch 95 の設計: 消したカードの印（card）の無い墓標（前の版）は、雲の生きた行がどのカードか分からないので取り込む（消すより戻す）。送る物は無い
  return (JSON.stringify(left) === "[]" && JSON.stringify(pushed) === "[]" && cloud.rows.get(`my_word:${three[2].en}`)?.deleted === false && M.getMyWords().some((w) => w.en === three[2].en) && cloud.rows.get(`my_word:${three[0].en}`)?.payload?.ja === "新しい訳") || show({ left, pushed, del: cloud.rows.get(`my_word:${three[2].en}`)?.deleted });
});
await t("6.10b 取り込み: 消したカードの印（card）のある墓標が、同じカードの雲の古い生きた行に会えば、取り込みのときに墓標を送る（送る待ちに残らない）", async () => {
  const three = Array.from({ length: 3 }, (_, i) => wordN(i));
  reset({
    spelldash_my_words: three.slice(0, 2),
    spelldash_user_items_meta: { [`my_word:${three[0].en}`]: { updatedAt: T_OLD, deleted: false }, [`my_word:${three[1].en}`]: { updatedAt: T_OLD, deleted: false }, [`my_word:${three[2].en}`]: { updatedAt: T_OLD, deleted: true, card: { addedAt: three[2].addedAt ?? null, jaHash: C.jaHash(three[2].ja) } } },
    spelldash_user_items_dirty: [`my_word:${three[0].en}`, `my_word:${three[2].en}`]
  });
  const cloud = cloudWith([rowOfWord({ ...three[0], ja: "新しい訳" }, T_NEW), rowOfWord(three[1]), rowOfWord(three[2], "2026-10-01T00:00:00.000Z")]);
  await S.pullUserItems(cloud, "u1", { now: T0 });
  const left = dirty();
  return (JSON.stringify(left) === "[]" && cloud.rows.get(`my_word:${three[2].en}`)?.deleted === true && !M.getMyWords().some((w) => w.en === three[2].en) && cloud.rows.get(`my_word:${three[0].en}`)?.payload?.ja === "新しい訳") || show({ left, del: cloud.rows.get(`my_word:${three[2].en}`)?.deleted });
});

// 6.11〜6.13（Batch 87 の反証の直し）: 読みの途中で、ほかの端末が前のページの範囲に並ぶ行を足すと（今日の日の行・新しい学習記録など）、
// 後ろの行が 1 つずつ後ろへずれる。全部の行の数（count）は最初のページの時点の数なので、受け取った数がそれに届いた所で止めると、
// ずれて最後のページの外に出た前からの行を読まずに済ませ、その項目を「クラウドに無い」と見て端末の古い値で送り返してしまう。
// 2 ページ目からは、数に届いても満ちたページの後はもう 1 ページ読み、満ちていないページか 0 行の答えで終える
const rowsOfWords = (n) => Array.from({ length: n }, (_, i) => rowOfWord(wordN(i)));
const TODAY_ROW = { ...dayRowN(0), key: "2026-11-09" }; // kind "day" は my_word より前に並ぶ（主キーの並びで表の頭）
// 1 ページ目より後の最初の読みの直前に、ほかの端末が row を足す送り先
const racingCloud = (rows, opts, row = TODAY_ROW) => {
  const cloud = cloudWith(rows, opts);
  let inserted = false;
  opts.readAt = (from) => {
    if (from > 0 && !inserted) {
      inserted = true;
      cloud.rows.set(`${row.kind}:${row.key}`, JSON.parse(JSON.stringify(row)));
    }
    return null;
  };
  return cloud;
};
await t("6.11 readAllRows: 読みの途中でほかの端末が前のページの範囲に並ぶ行を足しても、前からある行を 1 つも抜かさない（2,000 行を 1,000 行ずつ・1,000 行を 500 行ずつ）・数がページの行の数のちょうど倍数のときだけ 0 行の答えまで 1 回多く読む", async () => {
  const raced = async (n, maxRows) => {
    const cloud = racingCloud(rowsOfWords(n), { maxRows });
    const r = await readAll(cloud);
    const got = new Set((r.rows ?? []).map((x) => `${x.kind}:${x.key}`));
    return { ok: r.ok, missing: rowsOfWords(n).map((x) => `my_word:${x.key}`).filter((id) => !got.has(id)), reads: cloud.reads() };
  };
  const a = await raced(2000, 1000);
  const b = await raced(1000, 500);
  const still = cloudWith(rowsOfWords(2000), { maxRows: 1000 });
  const rs = await readAll(still);
  return (a.ok === true && a.missing.length === 0 && JSON.stringify(a.reads) === JSON.stringify([[0, 1000], [1000, 1000], [2000, 1]])
    && b.ok === true && b.missing.length === 0 && JSON.stringify(b.reads) === JSON.stringify([[0, 500], [500, 500], [1000, 1]])
    && rs.ok === true && rs.rows.length === 2000 && JSON.stringify(still.reads()) === JSON.stringify([[0, 1000], [1000, 1000], [2000, 0]]))
    || show({ a, b, still: [rs.ok, rs.rows?.length, still.reads()] });
});
await t("6.12 取り込み: 読みの途中でほかの端末が今日の日の行を足しても、表の終わりの語（ほかの端末で直した新しい訳）を読んで取り込み、古い訳で送り返さない（1,000 語・1 回の上限 500 行）", async () => {
  const all = Array.from({ length: 1000 }, (_, i) => wordN(i));
  seedSynced(all);
  const target = all[999]; // 主キーの並びで表の終わり
  const cloud = racingCloud([...all.slice(0, 999).map((w) => rowOfWord(w)), rowOfWord({ ...target, ja: "新しい訳" }, T_NEW)], { maxRows: 500 });
  const r = await S.pullUserItems(cloud, "u1", { now: T0 });
  const local = words().find((w) => w.en === target.en);
  const sentWords = cloud.upserts().reduce((n, c) => n + c.keys.filter((k) => k.startsWith("k")).length, 0);
  return (r.changed?.my_word === true && local?.ja === "新しい訳" && cloud.rows.get(`my_word:${target.en}`)?.payload?.ja === "新しい訳" && sentWords === 0)
    || show({ changed: r.changed, local: local?.ja, cloud: cloud.rows.get(`my_word:${target.en}`)?.payload?.ja, sentWords, reads: cloud.reads() });
});
await t("6.13 取り込み: クラウドの方が新しくて取り込んだ語を、最初の送信の間に直すと、その語は送る待ちに残り、次の送信で直した訳が届く（取り込んだ時刻と印の時刻が違う）", async () => {
  const two = [wordN(0), wordN(1)];
  reset({
    spelldash_my_words: two,
    spelldash_user_items_meta: { [`my_word:${two[0].en}`]: { updatedAt: T_OLD, deleted: false }, [`my_word:${two[1].en}`]: { updatedAt: T_OLD, deleted: false } },
    spelldash_user_items_dirty: [`my_word:${two[0].en}`]
  });
  let touched = false;
  const cloud = cloudWith([rowOfWord({ ...two[1], ja: "クラウドの新しい訳" }, T_NEW)], {
    respond: () => {
      if (!touched) {
        touched = true;
        M.setMyWordJa(two[1].en, "送っている間に直した訳"); // 取り込んだ語を、最初の送信（two[0]）の間に直す
      }
      return null;
    }
  });
  await S.pullUserItems(cloud, "u1", { now: T0 });
  const left = dirty();
  await S.pushUserItems(cloud, "u1", { now: T0 + 1 });
  const sent = cloud.upserts().at(-1);
  return (touched && JSON.stringify(left) === JSON.stringify([`my_word:${two[1].en}`]) && sent?.keys.join() === two[1].en && cloud.rows.get(`my_word:${two[1].en}`)?.payload?.ja === "送っている間に直した訳" && dirty().length === 0)
    || show({ touched, left, sent: sent?.keys, cloud: cloud.rows.get(`my_word:${two[1].en}`)?.payload?.ja, dirty: dirty() });
});

// ===== 7. HTML の組み立ての見張り（Batch 88。docs/SECURITY.md の Batch 88 の節） =====
// js/*.js の HTML を組むテンプレートで、語・訳・名前・id の字が esc／escapeHtml／numHtml を通らずに出る所は 0。
// 見張りの読み方は scripts/lib/htmlTemplates.mjs。許すのは下の一覧だけ（理由つき。直したら一覧から外す: 一覧の項目が見つからなければ落ちる）
{
  const H = await import("./lib/htmlTemplates.mjs");
  const ALLOW = [
    { file: "battleView.js", expr: "c.id", why: "Battle の分野の選びの value。分野は組み込みの表（data の manifest）と「マイ単語帳」の定数だけで、人の字は入らない。js/battle*.js は変えない決まり" },
    { file: "battleView.js", expr: "c.label", why: "同じ選びの名前（組み込みの分野の名前と定数）。js/battle*.js は変えない決まり" },
    { file: "game.js", expr: "learnRun.my ? learnRun.src.label : LEARN_LABELS[learnRun.Q.LEARN_MODES[learnRun.mode]]", why: "回の進みの名前。src.label は定数「マイ単語帳」（単語帳の名前は countLabel で escapeHtml 済み・回の柱は textContent）と LEARN_LABELS の定数。答えるたびに描く所なので変えない（基準 13）" }
  ];
  // 見張りそのものの確かめ（見張りが何も見つけずに通らない）
  const sample = (code) => H.scanHtmlTemplates(code).hits.map((h) => h.expr);
  ok("見張り: 守っていない語・訳・id・名前・answerLabel・裸の ja を挙げる",
    show(sample('el.innerHTML = `<b data-id="${w.id}">${w.en}</b><i>${answerLabel(w)}</i><s title="${ja}">${book.name}</s>`;')) === show(["w.id", "w.en", "answerLabel(w)", "ja", "book.name"]),
    show(sample('el.innerHTML = `<b data-id="${w.id}">${w.en}</b><i>${answerLabel(w)}</i><s title="${ja}">${book.name}</s>`;')));
  ok("見張り: esc・escapeHtml・numHtml・*Html の呼び出し・三項の条件・比べる式・数・入れ子のテンプレートの外側は挙げない",
    sample('el.innerHTML = `<b class="${w.id === cur ? "on" : ""}" aria-pressed="${c.id === saved}">${esc(w.en)}${escapeHtml(answerLabel(w))}${numHtml(n)}${noteChipHtml(w.id)}${w.ja ? `<i>${esc(w.ja)}</i>` : ""}${items.map((x) => esc(x.label)).join("・")}${count}</b>`;').length === 0,
    show(sample('el.innerHTML = `<b class="${w.id === cur ? "on" : ""}" aria-pressed="${c.id === saved}">${esc(w.en)}${escapeHtml(answerLabel(w))}${numHtml(n)}${noteChipHtml(w.id)}${w.ja ? `<i>${esc(w.ja)}</i>` : ""}${items.map((x) => esc(x.label)).join("・")}${count}</b>`;')));
  ok("見張り: 入れ子のテンプレートの中・.map の戻り・三項の枝・&& の右・{ } の本体の return も見る",
    show(sample('el.innerHTML = `<ul>${list.map((w) => `<li>${w.ja}</li>`).join("")}${ids.map((w) => w.id).join(",")}${on ? w.term : ""}${has && x.label}${rows.map((r) => { const k = r.id === 1; return r.name; }).join("")}</ul>`;')) === show(["w.ja", "ids.map((w) => w.id).join(\",\")", "on ? w.term : \"\"", "has && x.label", "rows.map((r) => { const k = r.id === 1; return r.name; }).join(\"\")"]),
    show(sample('el.innerHTML = `<ul>${list.map((w) => `<li>${w.ja}</li>`).join("")}${ids.map((w) => w.id).join(",")}${on ? w.term : ""}${has && x.label}${rows.map((r) => { const k = r.id === 1; return r.name; }).join("")}</ul>`;')));
  ok("見張り: HTML のタグの無いテンプレート（文の字）・コメントと文字列の中の ` は見ない",
    sample('const a = `${w.ja}を覚えた`; // `<b>${w.en}</b>`\nconst b = "`<i>${w.q}</i>`"; const re = /`/; const c = `<p>${n}</p>`;').length === 0,
    show(sample('const a = `${w.ja}を覚えた`; // `<b>${w.en}</b>`\nconst b = "`<i>${w.q}</i>`"; const re = /`/; const c = `<p>${n}</p>`;')));

  const dir = path.join(ROOT, "js");
  const found = [];
  let exprs = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
    const r = H.scanHtmlTemplates(fs.readFileSync(path.join(dir, file), "utf8"));
    exprs += r.exprs;
    for (const h of r.hits) found.push({ file, ...h });
  }
  const allowed = (h) => ALLOW.some((a) => a.file === h.file && a.expr === h.expr);
  const bad = found.filter((h) => !allowed(h));
  ok(`見張り: js/*.js の HTML のテンプレート（式 ${exprs}）で、語・訳・名前・id の字が esc／escapeHtml／numHtml を通らずに出る所は 0（許す一覧 ${ALLOW.length} 件を除く）`,
    exprs > 500 && bad.length === 0, `${bad.length} 件: ${bad.slice(0, 40).map((h) => `${h.file}:${h.line} \${${h.expr.slice(0, 80)}}`).join(" | ")}`);
  const stale = ALLOW.filter((a) => !found.some((h) => h.file === a.file && h.expr === a.expr));
  ok("見張り: 許す一覧の項目はどれも今の木にある（直した所は一覧から外す）", stale.length === 0, show(stale.map((a) => `${a.file} ${a.expr}`)));

  // *Html という名の関数そのもの（上の見張りはその呼び出しを数えないので、関数の中で字の名前の引数を守っているかを見る。Batch 88 の反証:
  // hasumiBubbleHtml が一言〔今日覚えた語の名前を含む〕をそのまま出していた）
  const ALLOW_PARAMS = [
    { file: "covers.js", fn: "coverImgHtml", expr: "name", why: "表紙の絵の名前（js/covers.js の表の定数だけ。人の字は入らない）" }
  ];
  const sampleP = (code) => H.scanHtmlParams(code).hits.map((h) => `${h.fn} ${h.expr}`);
  ok("見張り（*Html の関数）: 字の名前の引数（分けて受けた { text } も）を守らずに出すと挙げる",
    show(sampleP('export function aHtml({ mood, text }, extra = "") { return `<b class="${extra}">${text}</b>`; }\nfunction bHtml(label) { return `<i>${on ? label : ""}</i>`; }')) === show(["aHtml text", "bHtml on ? label : \"\""]),
    show(sampleP('export function aHtml({ mood, text }, extra = "") { return `<b class="${extra}">${text}</b>`; }\nfunction bHtml(label) { return `<i>${on ? label : ""}</i>`; }')));
  ok("見張り（*Html の関数）: esc を通した引数・字の名前でない引数・比べる式・.map(esc) は挙げない",
    sampleP('function cHtml({ text }, size, word) { return `<b style="${size}">${esc(text)}${text.length > 3 ? "…" : ""}${word.accept.map(escapeHtml).join(" / ")}</b>`; }').length === 0,
    show(sampleP('function cHtml({ text }, size, word) { return `<b style="${size}">${esc(text)}${text.length > 3 ? "…" : ""}${word.accept.map(escapeHtml).join(" / ")}</b>`; }')));
  const foundP = [];
  let fns = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
    const r = H.scanHtmlParams(fs.readFileSync(path.join(dir, file), "utf8"));
    fns += r.fns;
    for (const h of r.hits) foundP.push({ file, ...h });
  }
  const badP = foundP.filter((h) => !ALLOW_PARAMS.some((a) => a.file === h.file && a.fn === h.fn && a.expr === h.expr));
  ok(`見張り（*Html の関数 ${fns} 個）: 字の名前の引数を esc を通さずに HTML に出す所は 0（許す一覧 ${ALLOW_PARAMS.length} 件を除く）`,
    fns > 20 && badP.length === 0, `${badP.length} 件: ${badP.map((h) => `${h.file}:${h.line} ${h.fn} \${${h.expr.slice(0, 80)}}`).join(" | ")}`);
  const staleP = ALLOW_PARAMS.filter((a) => !foundP.some((h) => h.file === a.file && h.fn === a.fn && h.expr === a.expr));
  ok("見張り（*Html の関数）: 許す一覧の項目はどれも今の木にある", staleP.length === 0, show(staleP.map((a) => `${a.file} ${a.fn} ${a.expr}`)));

  // esc は ' も実体に（adminView・wordAi の escapeHtml とそろえる。textContent は変わらない）
  const { esc } = await import("../js/html.js");
  ok("esc: & < > \" ' を実体に（' は &#39;）", esc(`<a href="x">&'`) === "&lt;a href=&quot;x&quot;&gt;&amp;&#39;", esc(`<a href="x">&'`));
  ok("js/wordList.js（どこからも読まれていない一覧）は無い", !fs.existsSync(path.join(ROOT, "js", "wordList.js")));
}

// ===== 8. ショートカットキーの札と絵と画面の組み立て（Batch 92。js/shortcutsArt.js・js/shortcutsPage.js。docs/SPEC_SHORTCUTS.md） =====
// 新しい組み立て（キーの札・キーボードの絵・前と後の絵・一覧の札・選択肢・結果の行）も 7 の見張りの対象（js/*.js を全部見る）。
// ここでは、その組み立てが見張りの目に入っている（HTML のテンプレートの式がある）ことと、表の字と読み上げの文を esc して出すことを確かめる
{
  const H = await import("./lib/htmlTemplates.mjs");
  const files = ["shortcutsArt.js", "shortcutsPage.js"];
  const seen = files.map((f) => {
    const p = path.join(ROOT, "js", f);
    if (!fs.existsSync(p)) return [f, -1, 0];
    const src = fs.readFileSync(p, "utf8");
    const r = H.scanHtmlTemplates(src);
    const q = H.scanHtmlParams(src);
    return [f, r.exprs, r.hits.length + q.hits.length];
  });
  ok("ショートカットキー: 札と絵と画面の組み立て（js/shortcutsArt.js・js/shortcutsPage.js）は HTML の見張りの目に入る（テンプレートの式がある）・語や名前の字を守らずに出す所は 0",
    seen.every(([, n, hits]) => n > 10 && hits === 0), show(seen));
  let A = null;
  try {
    A = await import("../js/shortcutsArt.js");
  } catch {
    A = null;
  }
  const bad = '<img src=x onerror="alert(1)">&\'';
  const caps = typeof A?.capsHtml === "function" ? A.capsHtml([bad, "C"]) : "";
  const pair = typeof A?.scenePairHtml === "function" ? A.scenePairHtml({ id: "x", ja: bad, short: bad, say: [bad, bad], scene: { k: "doc", a: { t: bad }, b: { t: bad, clip: bad } } }, "ctrl") : "";
  ok("ショートカットキー: キーの札・前と後の絵の字と読み上げの文は esc して出す（タグも属性も作らない）",
    caps.includes("&lt;img") && !caps.includes("<img") && pair.includes("&lt;img") && !pair.includes("<img") && !/onerror="/.test(pair), show({ caps: caps.slice(0, 120), pair: pair.slice(0, 200) }));
  // 画面の組み立て（一覧の札・詳しい欄・回の終わりの行・結果の行・近い組の文）も js/shortcutsArt.js の純な関数にして、毒の字を通す（Batch 92 のレビュー:
  // 7 の見張りの字の名前に入らない欄〔short・注・押したキーの字〕の esc を外しても、見張りは黙っていた）
  const it = { id: "x", g: "pc", p: "A", ja: bad, short: bad, say: [bad, bad], scene: { k: "doc", a: { t: bad }, b: { t: bad } },
    keys: { ctrl: { show: [[bad, "C"]], how: "choice", why: "os", src: ["os-ctrl"], note: bad, alt: [[bad]] } } };
  const builders = ["tileHtml", "detailHtml", "missedRowHtml", "resultHtml", "nearHtml"];
  const missing = builders.filter((f) => typeof A?.[f] !== "function");
  const outs = missing.length ? [] : [
    A.tileHtml(it, "ctrl", { state: 1, choice: true, open: true, arr: "jis" }),
    A.detailHtml(it, "ctrl", "us"),
    A.missedRowHtml(it, "ctrl"),
    A.resultHtml({ head: bad, right: [bad, "C"], pressed: [bad, "V"], lines: [bad] }),
    A.resultHtml({ head: bad, right: [bad], picked: [bad], lines: [bad, bad] }),
    A.nearHtml([bad, "Z"], [bad, "Y"])
  ];
  const leaks = outs.map((h, i) => (String(h).includes("<img") || /onerror="/.test(h) || !String(h).includes("&lt;img") ? i : -1)).filter((i) => i >= 0);
  ok("ショートカットキー（レビュー）: 一覧の札・詳しい欄の注・回の終わりの行（short）・結果の行（押したキー・選んだ組・ほかの項目の組の文）・近い組の文も純な関数で組み、字は esc して出す",
    missing.length === 0 && outs.length === 6 && leaks.length === 0, show({ missing, leaks }));
  // Batch 93: 寄せた絵（focusSvg）と枠つきの全体の絵（keyboardSvg の frames）も組み立て。出す字は表の札だけで、渡された字（キーボードの名前・並び・押すキーの字）をタグにしない
  const hasFocus = typeof A?.focusSvg === "function" && typeof A?.focusWindows === "function";
  const f1 = hasFocus ? A.focusSvg("ctrl", "jis", ["ctrl", "c", bad]) : null;
  const f2 = hasFocus ? A.focusSvg(bad, bad, [bad]) : null;
  const k2 = hasFocus ? A.keyboardSvg(bad, bad, { frames: A.focusWindows("ctrl", "jis", ["ctrl", "c"]) }) : null;
  ok("ショートカットキー（Batch 93）: 寄せた絵（focusSvg）と枠つきの全体の絵（keyboardSvg の frames）は表の札だけを出す（渡されたキーボードの名前・並び・押すキーの字をタグにしない）・押すキーがあれば窓と枠が出る",
    hasFocus && typeof f1 === "string" && f1.includes('class="kb kb-focus"') && f1.includes('class="kb-win"') && f2 === "" && typeof k2 === "string" && k2.includes('class="kb-win"')
      && ![f1, k2].some((h) => h.includes("<img") || /onerror="/.test(h)), show({ hasFocus, f1: String(f1).slice(0, 90), f2, k2: String(k2).slice(-120) }));
}

console.log(`test-text-safe: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
