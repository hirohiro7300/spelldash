// ===== 端末の保存の守り: 上限のときの優先と、読めなかった値の退避（import なし・DOM なし。Node からも読む: scripts/test-memory.mjs） =====
// 端末の保存の枠は 1 つのサイトに決まった字数しかなく、端末で違う（Chromium は鍵と値の合計 5,242,880 字、iPhone の Safari は約 250 万字）。
// 枠の中の優先は 学習の記録（spelldash_word_stats）＞ 影のデータ（記録の質。端末だけ・消しても次に答えたとき今の記録から作り直す）＞
// 読めなかった値の退避（読む所が無い）。docs/SPEC_MASTERY.md §12.2「保存の上限と優先」（PR #172 のレビュー 1）。
//   - 学習の記録が上限で書けなかったら、退避 → 影のデータ の順に消して、そのつど 1 回書き直す（js/storage.js flushWordStats）
//   - 影のデータの語ごとの欄（spelldash_memory_words）は、学習の記録と合わせて SHARED_BUDGET 字に収まるまで縮める（js/memoryWords.js）
//   - 退避は包み {"at": 退避した日時, "size": 元の字数, "head": 元の値（の頭）, "cut": 切ったら true} で CORRUPT_MAX 字まで、
//     CORRUPT_KEEP_MS（30 日）たったら読み込みのときに消す（js/storage.js・js/memoryWords.js が同じ作法で使う。PR #170 のレビュー 1）

export const WORD_STATS_CORRUPT_KEY = "spelldash_word_stats_corrupt";
export const MEMORY_WORDS_KEY = "spelldash_memory_words";
export const MEMORY_WORDS_CORRUPT_KEY = "spelldash_memory_words_corrupt";
export const MEMORY_CHECK_KEY = "spelldash_memory_check";
export const CORRUPT_KEYS = Object.freeze([WORD_STATS_CORRUPT_KEY, MEMORY_WORDS_CORRUPT_KEY]); // 退避（読む所が無い。上限のとき最初に消す）
export const SHADOW_KEYS = Object.freeze([MEMORY_WORDS_KEY, MEMORY_CHECK_KEY]); // 影のデータ（記録の質。上限のとき退避の次に消す）
// 学習の記録と語ごとの欄の合計（字）。iPhone の Safari の枠（約 250 万字）から、保持率の記録（2,000 語・1 年で約 21 万字）・
// 速さの箱・集計・ほかの設定の分（合わせて 50 万字）を残す。2,000 語を 1 年使った記録で 197 万字（語の記録 160 万字＋語ごとの欄 37 万字）
export const SHARED_BUDGET = 2000000;
export const CORRUPT_KEEP_MS = 30 * 86400000;
export const CORRUPT_MAX = 512 * 1024;

export function isQuotaError(error) {
  return error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED" || error?.code === 22 || error?.code === 1014;
}

// 鍵を消す。どれか 1 つでも消したら true
export function dropKeys(keys) {
  let dropped = false;
  for (const key of keys) {
    try {
      if (localStorage.getItem(key) === null) continue;
      localStorage.removeItem(key);
      dropped = true;
    } catch {
      // 消せない鍵は飛ばす
    }
  }
  return dropped;
}

// 退避の包みの文字列（CORRUPT_MAX 字まで）。収まらなければ元の値の頭だけにして cut を付ける（JSON の escape で伸びる分も含めて量る）
export function corruptEnvelope(raw, at) {
  if (raw.length < CORRUPT_MAX) {
    const whole = JSON.stringify({ at, size: raw.length, head: raw });
    if (whole.length <= CORRUPT_MAX) return whole;
  }
  let n = Math.min(raw.length, CORRUPT_MAX);
  for (let i = 0; i < 8 && n > 0; i++) {
    const text = JSON.stringify({ at, size: raw.length, head: raw.slice(0, n), cut: true });
    if (text.length <= CORRUPT_MAX) return text;
    n = Math.floor((n * CORRUPT_MAX) / text.length) - 64; // escape の割合で縮める（2〜3 回で収まる）
  }
  return JSON.stringify({ at, size: raw.length, head: "", cut: true });
}

// 退避の文字列から包みを読む。包みでない（Batch 67・68 の形＝元の値そのまま・読めない）なら null
function readCorrupt(text) {
  if (typeof text !== "string" || !text.startsWith('{"at":"')) return null;
  try {
    const value = JSON.parse(text);
    return typeof value?.at === "string" && typeof value.head === "string" && Number.isFinite(value.size) ? value : null;
  } catch {
    return null;
  }
}

function sameCorrupt(text, raw) {
  const kept = readCorrupt(text);
  return Boolean(kept) && kept.size === raw.length && (kept.cut ? raw.startsWith(kept.head) : kept.head === raw);
}

// 読めなかった値 raw（鍵 key の中身）を、上書きする前に退避の鍵 corruptKey へ 1 つだけ写す。同じ壊れた値を読み直したときは退避した日時を変えない。
// 容量で写せなければ元の鍵を退避の鍵へ移す（消してから書く。包みは 512K 字までなので大きい値ほど空きが増える）。それも書けなければ元に戻す。
// report: 写せなかったことを reportError で知らせる（語の記録。記録の質は黙って続ける）
export function keepCorrupt(key, corruptKey, raw, { report = false } = {}) {
  let text;
  try {
    if (sameCorrupt(localStorage.getItem(corruptKey), raw)) return;
    text = corruptEnvelope(raw, new Date().toISOString());
    localStorage.setItem(corruptKey, text);
  } catch (error) {
    try {
      localStorage.removeItem(key);
      localStorage.setItem(corruptKey, text ?? corruptEnvelope(raw, new Date().toISOString()));
    } catch {
      try { localStorage.setItem(key, raw); } catch {}
    }
    if (report) (globalThis.reportError ?? console.error)(error);
  }
}

// 読み込みのとき: 30 日たった退避を消す（読めない日時・先の日時も）。包みでない古い形は今の日時で包み直す（上限で切る）。
// 日時は文字列の頭だけで読む（包みは 512K 字まであり、毎回の読み込みで parse しない）
export function expireCorrupt(corruptKey) {
  try {
    const text = localStorage.getItem(corruptKey);
    if (text === null) return;
    const at = /^\{"at":"([^"]{1,40})"/.exec(text);
    if (!at) {
      localStorage.setItem(corruptKey, corruptEnvelope(text, new Date().toISOString()));
      return;
    }
    const age = Date.now() - Date.parse(at[1]);
    if (!(age < CORRUPT_KEEP_MS && age > -CORRUPT_KEEP_MS)) localStorage.removeItem(corruptKey);
  } catch {
    // 包み直せない（容量）: 写しは捨てる（読む所は無い。学習の記録の書き込みを優先する）
    try { localStorage.removeItem(corruptKey); } catch {}
  }
}
