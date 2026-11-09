// ===== マイ単語帳を人に渡す（Batch 84。docs/SPEC_MY_WORDS.md §13）: 渡すリンクと文字の形・読み方 =====
// 純な module（DOM・localStorage・画面を持たない。scripts/test-share.mjs が画面なしで直に読む）。画面は js/myWordsPage.js、足すのは js/myWords.js addSharedWords。
//
// リンク: <origin>/mywords.html#share=<code>（Web は今の origin、アプリは本番の origin: js/appEnv.js PRODUCTION_ORIGIN）。
//   # の後ろ（fragment）はブラウザがサーバーへ送らない。開いた人の端末の中だけで読む（どの単語かはサーバーに届かない）。
// code: 頭の印 + base64url（= なし）
//   z1.  JSON の UTF-8 を deflate-raw で縮めた物（CompressionStream が使えるとき。ふつうはこちら）
//   j1.  JSON の UTF-8 をそのまま（CompressionStream が無い・deflate-raw を知らないブラウザで作ったとき）
// JSON: { "v": 1, "n": "<単語帳の名前>", "w": [["<英語（画面の形）>", "<訳>"], ...] }
//   入れるのは単語帳の名前と、語ごとの英語（画面に出す形。鍵 up~<訳の印> は入れない）と訳だけ。覚えたかどうか（3 状態）・鍵・id・日付・アカウントは入れない。
//   場面カードと、今の決まり（1 語ずつ足すと同じ checkEnText・checkJaText と、下の名前と訳の字の決まり）に合わない古い語は入れない（入れなかった数を画面が言う）。
// 読み方（decodeShare）: z1・j1 のほかは断る。base64url は形を確かめる。縮めた物は SHARE_UNZIP_SLICE（4 KB）ずつ広げる道へ渡し、
//   広げた大きさに上限（SHARE_MAX_JSON）を付けて読む（超えたら読むのをやめ、残りは渡さない）。ブラウザの広げ方は、渡された 1 切れを全部広げてから
//   読む側に渡すので、1 度に全部を渡すと上限で止めても広げすぎる（1.3 MB の z1 で約 1 GB）。4 KB ずつなら 1 切れを広げても約 4 MB まで。
//   UTF-8 は壊れた並びを断る。JSON は JSON.parse だけ（eval しない）で、鍵は v・n・w の 3 つだけ・v は 1・n は単語帳の名前の決まり（20 字まで）・
//   w は 1〜SHARE_MAX_WORDS 個の [文字, 文字]。語は 1 語ずつ足すと同じ決まり（英語・訳とも 150 字まで）で、1 つでも合わなければリンクごと断る。
//   名前と訳の字の決まり（UNSAFE_TEXT）: 制御文字（U+0000〜U+001F・U+007F〜U+009F。タブと改行は先に空白 1 つになる）・組になっていないサロゲート・
//   向きを変える制御文字（埋め込み・上書き・隔離: U+202A〜U+202E・U+2066〜U+2069）があれば断る。同期の送り先（user_items の payload）は NUL と
//   組になっていないサロゲートを受け付けず、1 語でも入ると同じ送りの組の語・メモがどれも届かなくなる（1 語ずつ足す欄からは入らない字）。
//   向きを変える字は、名前と訳の見え方を並べ替えられるので一緒に断る。渡す側（bookShare）も同じ決まりで語を選ぶ（作った code は必ず読める）。
//   画面は読んだ字を textContent で出す（innerHTML に入れない）。
// 上限（決めた値。docs/SPEC_MY_WORDS.md §13.3）:
//   SHARE_MAX_WORDS = 1,000 語（Pro の上限と同じ。Pro の人の単語帳 1 冊がまるごと入る）
//   SHARE_MAX_JSON = 1,100,000 バイト（1,000 語がどれも英語 150 字・訳 150 字で、訳の字を JSON がいちばん長く書く形〔1 字 6 バイト〕でも入る）
//   SHARE_MAX_CODE = 1,500,000 字（その JSON を縮めずに j1 で書いた長さ〔約 1,410,000 字〕も入る）。これより長い code は読まない・リンクにしない
//   SHARE_LONG_LINK = 8,000 字: これより長いリンクは、チャットやメールによっては途中で切れることがあると言い、「文字をコピー」を勧める
//   （ふつうの単語帳は短い: 1,000 語でも英語 10 字・訳 8 字ほどなら z1 で約 22,000 字、73 語の単語帳で約 2,300 字）

import { checkEnText, checkJaText, checkBookName, displayOf, isWordEntry, entriesOfBook, MY_PRO_LIMIT, MY_FIRST_BOOK } from "./myWordsCore.js";

export const SHARE_VERSION = 1;
export const SHARE_PARAM = "share"; // #share=<code>
export const SHARE_PATH = "/mywords.html";
export const SHARE_ZIP = "z1.";
export const SHARE_PLAIN = "j1.";
export const SHARE_MAX_WORDS = MY_PRO_LIMIT;
export const SHARE_MAX_JSON = 1_100_000;
export const SHARE_MAX_CODE = 1_500_000;
export const SHARE_LONG_LINK = 8000;
export const SHARE_UNZIP_SLICE = 4096; // 縮めた物を広げる道へ渡す 1 切れ（deflate は 1 バイトが最大約 1,032 バイトに広がる: 4 KB で約 4 MB まで）

// 名前と訳に入れない字（u フラグ: [\uD800-\uDFFF] は組になっていないサロゲートだけに当たる。組になった絵文字などは当たらない）
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]|[\uD800-\uDFFF]/u;
const safeText = (text) => !UNSAFE_TEXT.test(text);

// ===== base64url（= なし。RFC 4648 §5） =====
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET.charCodeAt(i)] = i;

export function toBase64Url(bytes) {
  const n = bytes.length;
  let out = "";
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63];
  }
  if (n - i === 1) {
    const v = bytes[i] << 16;
    out += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63];
  } else if (n - i === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63];
  }
  return out;
}

// 読めない形（使えない字・長さの余りが 1・最後の字の使わないビットが 0 でない）は null
export function fromBase64Url(text) {
  if (typeof text !== "string") return null;
  const n = text.length;
  if (n % 4 === 1) return null;
  const at = (k) => {
    const c = text.charCodeAt(k);
    return c < 128 ? INDEX[c] : -1;
  };
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    const a = at(i);
    const b = at(i + 1);
    const c = at(i + 2);
    const d = at(i + 3);
    if ((a | b | c | d) < 0) return null;
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 255;
    out[o++] = v & 255;
  }
  if (n - i === 2) {
    const a = at(i);
    const b = at(i + 1);
    if ((a | b) < 0 || (b & 15) !== 0) return null;
    out[o++] = (a << 2) | (b >> 4);
  } else if (n - i === 3) {
    const a = at(i);
    const b = at(i + 1);
    const c = at(i + 2);
    if ((a | b | c) < 0 || (c & 3) !== 0) return null;
    const v = (a << 18) | (b << 12) | (c << 6);
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 255;
  }
  return out;
}

// ===== 縮める・広げる（CompressionStream／DecompressionStream の deflate-raw） =====
function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

// 縮めた物を size バイトずつ出す流れ（広げる道が次の切れを求めたときだけ出す: highWaterMark 0 で先に積まない）。
// 読む側（readAll）が上限で読むのをやめると、広げる道とこの流れも止まり、残りの切れは出さない
function sliceStream(bytes, size) {
  let at = 0;
  return new ReadableStream(
    {
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(at, at + size));
        at += size;
      }
    },
    { highWaterMark: 0 }
  );
}

// 流れを読み切る。max バイトを超えたら読むのをやめて null（縮めた物を広げると大きくなりすぎる形を、全部広げずに断る）
async function readAll(stream, max) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const supports = (Kind) => {
  if (typeof Kind !== "function") return false;
  try {
    new Kind("deflate-raw");
    return true;
  } catch {
    return false; // deflate-raw を知らない古い版
  }
};
export const canZip = () => supports(globalThis.CompressionStream);
export const canUnzip = () => supports(globalThis.DecompressionStream);

// ===== 渡す物（単語帳 1 冊）=====

// 単語帳 1 冊の渡す中身。list = 語の並び・bookId = 単語帳の id・books = 単語帳の並び（js/myWords.js getMyBooks）。
// 返り値 { name, words: [[英語（画面の形）, 訳], ...]（足した順）, scenes（入れない場面カードの数）, invalid（今の決まりに合わないので入れない語の数）, over（SHARE_MAX_WORDS より多い） }
export function bookShare(list, bookId, books) {
  const found = (Array.isArray(books) ? books : []).find((b) => b.id === bookId)?.name ?? "";
  const named = checkBookName(found, []);
  const words = [];
  let scenes = 0;
  let invalid = 0;
  for (const w of entriesOfBook(list, bookId, books)) {
    if (!isWordEntry(w)) {
      if (w?.kind === "concept") scenes++;
      continue;
    }
    const en = checkEnText(displayOf(w)); // 画面の形（KPI・Due Diligence）。鍵（up~<訳の印>）は入れない
    const ja = checkJaText(w.ja);
    if (!en.ok || !ja.ok || !safeText(ja.ja)) {
      invalid++;
      continue;
    }
    words.push([en.text, ja.ja]);
  }
  return { name: named.ok && safeText(named.name) ? named.name : MY_FIRST_BOOK.name, words, scenes, invalid, over: words.length > SHARE_MAX_WORDS };
}

// まとめて足す（js/myWords.js parseBulk）の見出し行の決まり（「english, …」「answer, …」「q, …」の行は CSV の見出しとして飛ばす）に当たる英語。
// その英語の行は区切りを全角の読点にする（読点でも分けられ、見出しの決まりには当たらない）
const HEADER_WORD = /^(english|英単語|answer|q|場面)$/i;

// 文字で渡す 1 行（まとめて足すの形「english, 訳」）。訳の全体が "…" のときは引用符をもう 1 組つける
// （まとめて足すは前後の引用符を 1 組外す: js/myWordsCore.js parseWordLine）
export function shareLineOf(en, ja) {
  const sep = HEADER_WORD.test(en) ? "、" : ", ";
  const body = /^".*"$/.test(ja) ? `"${ja}"` : ja;
  return `${en}${sep}${body}`;
}

// 文字で渡す形（1 行に 1 語。まとめて足すに貼ると同じ英語と訳の語になる）
export function shareTextOf(words) {
  return (Array.isArray(words) ? words : []).map(([en, ja]) => shareLineOf(en, ja)).join("\n");
}

// 渡す code を作る（{ name, words } は bookShare の形）。zip: false なら縮めない（j1）。
// 返り値 { code, format: "z1" | "j1", fits（SHARE_MAX_CODE 以内: リンクにできる） }
export async function encodeShare(share, { zip = true } = {}) {
  const json = JSON.stringify({ v: SHARE_VERSION, n: String(share?.name ?? ""), w: Array.isArray(share?.words) ? share.words : [] });
  const bytes = new TextEncoder().encode(json);
  let code = null;
  if (zip && canZip()) {
    try {
      const packed = await readAll(streamOf(bytes).pipeThrough(new CompressionStream("deflate-raw")), Infinity);
      code = SHARE_ZIP + toBase64Url(packed);
    } catch {
      code = null; // 縮められなければ、縮めない形で
    }
  }
  if (code === null) code = SHARE_PLAIN + toBase64Url(bytes);
  return { code, format: code.slice(0, 2), fits: code.length <= SHARE_MAX_CODE };
}

// リンク（origin は Web なら今の origin、アプリなら本番の origin: 画面が決める）
export function shareLinkOf(origin, code) {
  return `${origin}${SHARE_PATH}#${SHARE_PARAM}=${code}`;
}

// URL の # の部分（location.hash）から code。#share= で始まらなければ null（#share= だけなら空の文字: 読めないリンク）
export function shareCodeOf(hash) {
  const m = /^#share=(.*)$/s.exec(String(hash ?? ""));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

// ===== 読む =====
const bad = (reason) => ({ ok: false, reason });

// JSON.parse した値を確かめる（形・型・版・名前・語の決まり）。返り値 { ok, name, words: [{ en, ja }], format } か { ok: false, reason }
export function readShare(value, format = "j1") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("shape");
  if (value.v !== SHARE_VERSION) return bad("version");
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((k) => k === "v" || k === "n" || k === "w")) return bad("shape");
  if (typeof value.n !== "string") return bad("name");
  const name = checkBookName(value.n, []);
  if (!name.ok || !safeText(name.name)) return bad("name");
  if (!Array.isArray(value.w)) return bad("shape");
  if (value.w.length === 0) return bad("empty");
  if (value.w.length > SHARE_MAX_WORDS) return bad("size");
  const words = [];
  for (const entry of value.w) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") return bad("entry");
    const en = checkEnText(entry[0]);
    const ja = checkJaText(entry[1]);
    if (!en.ok || !ja.ok || !safeText(ja.ja)) return bad("entry"); // 英語は checkEnText が英字・数字・ハイフン・アポストロフィ・空白だけにする
    words.push({ en: en.text, ja: ja.ja });
  }
  return { ok: true, name: name.name, words, format };
}

// code を読む。reason: format（頭の印が違う）・size（長すぎる・広げると大きすぎる・語が多すぎる）・base64・unsupported（このブラウザは z1 を広げられない）・
// zip（縮めた物が壊れている）・utf8・json・shape・version・name・empty・entry
export async function decodeShare(code) {
  if (typeof code !== "string" || code.length < SHARE_ZIP.length) return bad("format");
  if (code.length > SHARE_MAX_CODE) return bad("size");
  const head = code.slice(0, SHARE_ZIP.length);
  if (head !== SHARE_ZIP && head !== SHARE_PLAIN) return bad("format");
  const raw = fromBase64Url(code.slice(head.length));
  if (!raw || raw.length === 0) return bad("base64");
  let bytes = raw;
  if (head === SHARE_ZIP) {
    if (!canUnzip()) return bad("unsupported");
    try {
      bytes = await readAll(sliceStream(raw, SHARE_UNZIP_SLICE).pipeThrough(new DecompressionStream("deflate-raw")), SHARE_MAX_JSON);
    } catch {
      return bad("zip");
    }
    if (!bytes) return bad("size");
  } else if (bytes.length > SHARE_MAX_JSON) {
    return bad("size");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return bad("utf8");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return bad("json");
  }
  return readShare(value, head === SHARE_ZIP ? "z1" : "j1");
}
