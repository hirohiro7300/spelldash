// ===== 自分のデータの端末間同期（マイ単語帳・単語メモ・追加した分野パック・日ごとの記録） =====
//
// 学習記録（word_progress）は以前から同期しているが、マイ単語帳／メモ／パックの選択は端末ローカルだけだった。
// Supabase の user_items テーブル（docs/SQL_USER_ITEMS.md、作成は創業者側）に
//   kind: "my_word" | "note" | "pack" | "day"、key、payload(jsonb)、deleted、updated_at
// の1行1項目で保存し、項目ごとに「新しい方が勝つ」でマージする。削除は deleted=true の墓標で伝える。
// day（key=YYYY-MM-DD、payload={ learned, mastered, active, set, sets }）だけは成長ログと今日のセットの 1 日分で、
// 時刻ではなく値で合わせる（learned・mastered・sets は max、active・set は OR）。2 台で同じ日に学んでも巻き戻らない。削除は無い。
// テーブルが無い／未ログインなら何もしない（Local First）。
//
// 変更の記録: 各モジュールが書き込み時に touchItem() を呼ぶ → meta（更新時刻）と dirty（未送信）に積む。
// 送り方（Batch 85。docs/SPEC_MY_WORDS.md §14.3）: 送る写しの、送り先が受け付けない字だけを U+FFFD に替え（端末の保存は書き換えない）、行の中身で断られた組は半分ずつ送り直し、
// 1 行だけで断られた行は meta に印（failAt・failFor）を付けて、その行が変わるか UPLOAD_RETRY_MS が過ぎるまで送らない（下の「送る形と送り方」）。
// 読み方（Batch 87。docs/SPEC_MY_WORDS.md §16.1・§16.2）: 主キーの列で並べて READ_PAGE 行ずつ、全部の行の数に届き、満ちていないページが来るまで読む（readAllRows）。1 ページでも読めなければ
// 取り込み全体を止める。取り込みで送れた行・クラウドから取り込んだ行は、送る待ち（dirty）から外す（同じ行を次の送信で送り直さない）。
// 2 台の取り込み（Batch 94。docs/SPEC_MY_WORDS.md §18）: マイ単語帳の同じカードは 3 状態と lf を残し、ほかの端末で作った同じ名前の単語帳はこの端末の単語帳に入れる。
// 送る前に読む（Batch 95。docs/SPEC_MY_WORDS.md §18.11）: マイ単語帳の語は、送る前にその鍵の雲の行を読み、取り込みと同じ決まり（resolveMyWords）で合わせてから送る。
// 読めない回・読み始めから READ_FRESH_MS を過ぎた回は語を送らない（送る待ちに残す）。読んだときに雲に行の無かった鍵は「無いときだけ書く」で送る。
// 語の鍵を動かすのは取り込みだけ。送りで雲の墓標の鍵・違うカードの鍵に当たった語は送らずに待たせ、次の取り込みで新しい鍵へ移す。

import { normJa, parseBooks, cleanBookName, bookRefOf, answerKeyOf, isWordEntry, myIdentityFor, jaHash } from "./myWordsCore.js";

const META_KEY = "spelldash_user_items_meta"; // { "kind:key": { updatedAt, deleted } }（送る待ちの語の墓標は card も持つ: 下の「消した語の印」）と、行でない印 MERGED
// 雲と合わせた印（Batch 95。meta の中の 1 つ。{ at, out? }。行の id はいつも「kind:key」なので重ならない。雲へは送らない。docs/SPEC_MY_WORDS.md §18.10）:
// 「足した時刻が at まで（足した時刻の無い前からの語も）の端末の生きた語は、out の鍵の語を除いて、どれも一度は雲に入った（送れた・雲から取り込んだ）」。
// out はまだ雲に入っていない送る待ちの語の鍵（ふつうは 0〜数個）。雲を読めて合わせた回の終わり（advanceMark）に at を進め、out を数え直す。
// 無い = この端末はまだ一度も雲を読めて合わせていない（ゲストの「はい」・表の前から使っている端末・前の版の端末）
const MERGED = "merged";
// 前の版（Batch 94）の印「雲を読めなかった」。今は使わない（どの送りも先に読む）。雲を読めたときに外す
const UNMERGED = "unmerged";
const DIRTY_KEY = "spelldash_user_items_dirty"; // ["kind:key", ...]
const MY_WORDS_KEY = "spelldash_my_words";
const MY_BOOKS_KEY = "spelldash_my_books"; // js/myWords.js（単語帳の一覧。読むだけ）
const NOTES_KEY = "spelldash_word_notes";
const PACKS_KEY = "spelldash_packs";
const GROWTH_KEY = "spelldash_growth_log"; // js/growthLog.js（循環 import を避けて直接読む）
const DAILY_SET_KEY = "spelldash_daily_set"; // js/dailySet.js
const GROWTH_MAX_DAYS = 120; // growthLog.js の MAX_DAYS と同じ
const DAILY_HISTORY_MAX = 60; // dailySet.js の history の上限と同じ

// js/stats.js localDateString と同じ形（YYYY-MM-DD、端末の日付）
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const isDateKey = (k) => typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k);

const readJson = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));

export function getItemMeta() {
  const m = readJson(META_KEY, {});
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

export function getDirtyItems() {
  const d = readJson(DIRTY_KEY, []);
  return new Set(Array.isArray(d) ? d : []);
}

// ローカルで項目が変わった時に呼ぶ（追加・更新は deleted=false、削除は true）
export function touchItem(kind, key, deleted = false, at = new Date().toISOString()) {
  if (!kind || !key) return;
  const id = `${kind}:${key}`;
  const meta = getItemMeta();
  meta[id] = { updatedAt: at, deleted: !!deleted };
  writeJson(META_KEY, meta);
  const dirty = getDirtyItems();
  dirty.add(id);
  writeJson(DIRTY_KEY, [...dirty]);
}

// まとめて印を付ける（Batch 81 のマイ単語帳のまとめて消す・移す）: 印と送る待ちを 1 回ずつ書く。中身は touchItem を鍵の数だけ呼んだのと同じ
export function touchItems(kind, keys, deleted = false, at = new Date().toISOString()) {
  const list = (Array.isArray(keys) ? keys : []).filter(Boolean);
  if (!kind || list.length === 0) return;
  const meta = getItemMeta();
  const dirty = getDirtyItems();
  for (const key of list) {
    const id = `${kind}:${key}`;
    meta[id] = { updatedAt: at, deleted: !!deleted };
    dirty.add(id);
  }
  writeJson(META_KEY, meta);
  writeJson(DIRTY_KEY, [...dirty]);
}

// ---- 消した語の印（docs/SPEC_MY_WORDS.md §18.8） ----
// 雲の墓標の中身は空になる（docs/SQL_USER_ITEMS.md §4）ので、ほかの端末はどのカードが消えたかを知らない。マイ単語帳の語を消す道（js/myWords.js）は
// touchItems(..., true) の代わりにこれを呼び、墓標の印に消したカード card を足す（印と送る待ちは 1 回ずつ書く）。
// card: 足した時刻 addedAt・訳の印 jaHash・seen（消したカードが一度は雲に入っていたか: 送る待ちでなかったか、足した時刻が印 merged の at までで out に無い）。
// card は送る待ちの間だけ持つ（送れた墓標・要らなくなった墓標は印ごと外す: settleRows・resolveMyWords）。
// 消す印の時刻は「今」と「この端末の印の時刻 + 1 ms」の遅い方（Batch 95: 時計が遅れた端末でも、見えていた版より後に並べて消せる）。
// gone: [{ key, word }]（word は消した 1 語。同じ鍵の語が 2 つ以上なら null: card を付けない＝雲の生きた行に会えば取り込んで戻す）
export function touchDeletedWords(gone, at = new Date().toISOString()) {
  const list = (Array.isArray(gone) ? gone : []).filter((g) => g && g.key);
  if (list.length === 0) return;
  const meta = getItemMeta();
  const dirty = getDirtyItems();
  const atMs = Date.parse(at);
  for (const { key, word } of list) {
    const id = `my_word:${key}`;
    const card = word && typeof word === "object" && word.en ? { addedAt: word.addedAt ?? null, jaHash: jaHash(word.ja ?? ""), seen: !dirty.has(id) || (cardBeforeMark(word.addedAt, meta) && !markOut(meta).has(key)) } : null;
    const prev = Date.parse(meta[id]?.updatedAt ?? "");
    const t = Number.isFinite(prev) && Number.isFinite(atMs) && prev >= atMs ? new Date(prev + 1).toISOString() : at;
    meta[id] = { updatedAt: t, deleted: true, ...(card ? { card } : {}) };
    dirty.add(id);
  }
  writeJson(META_KEY, meta);
  writeJson(DIRTY_KEY, [...dirty]);
}

// 足した語を「まだ雲に入っていない」語に数える（Batch 95。足す 4 つの道が語を書いた後に呼ぶ。added: [[鍵, 足した時刻], ...]）。
// ふつうは足した時刻が印 merged の at より後なので何もしない。時計が at より前に戻った端末だけ、足した時刻では見分けられないので、
// その鍵を印の out に入れる（「雲に入った語」と見誤って、雲の古い墓標で消さない）
export function noteAddedWords(added) {
  const list = (Array.isArray(added) ? added : []).filter((a) => Array.isArray(a) && a[0]);
  if (list.length === 0) return;
  const meta = getItemMeta();
  const m = meta[MERGED];
  if (!m) return; // まだ一度も雲と合わせていない端末: 送る待ちの語はどれも雲に入っていないと見る
  const markMs = Date.parse(m.at ?? "");
  if (!Number.isFinite(markMs)) return;
  const late = list.filter(([, addedAt]) => !(Date.parse(addedAt ?? "") > markMs)).map(([k]) => k);
  if (late.length === 0) return;
  meta[MERGED] = { ...m, out: [...new Set([...markOut(meta), ...late])] };
  writeJson(META_KEY, meta);
}

// 印 merged の out（まだ雲に入っていない送る待ちの語の鍵）
function markOut(meta) {
  const out = meta[MERGED]?.out;
  return new Set(Array.isArray(out) ? out : []);
}

// 足した時刻 addedAt の語が、印 merged の at までに足されたか（印が無ければ false。足した時刻の無い語・時刻の読めない印は true）
function cardBeforeMark(addedAt, meta) {
  if (!meta[MERGED]) return false;
  const markMs = Date.parse(meta[MERGED].at ?? "");
  const a = Date.parse(addedAt ?? "");
  return !Number.isFinite(markMs) || !Number.isFinite(a) || a <= markMs;
}

// 消したカード card が一度は雲に入ったか（消したときの seen。seen の無い前の版の card は、足した時刻と印 merged で見る）。
// js/myWords.js が、送っていない墓標の鍵を同じ組の足し直しに使ってよいかを決める（使ってよいのは雲に入っていないカードだけ）
export function deletedCardInCloud(card, meta = getItemMeta()) {
  return typeof card?.seen === "boolean" ? card.seen : cardBeforeMark(card?.addedAt, meta);
}

// 送る待ちの墓標の印 m が消したカードと、雲の生きた行の中身 payload が同じカードか: "same" | "other" | "unknown"（card の無い墓標: 前の版か、
// 同じ鍵の 2 語を一緒に消した）。足した時刻が同じなら同じカード。訳の印が同じでも同じと見るのは、消したカードが一度は雲に入っていたときだけ
// （雲に入っていないカード〔ゲスト・表の前・送る前に消した語〕の墓標は、ほかの端末の同じ組を見ずに自分の写しを消しただけ）
function tombVsLive(m, payload, meta) {
  const card = m?.card;
  if (!card || !payload || !payload.en) return "unknown";
  if (card.addedAt != null && card.addedAt === payload.addedAt) return "same";
  if (deletedCardInCloud(card, meta) && card.jaHash === jaHash(payload.ja ?? "")) return "same";
  return "other";
}

// ---- ローカルの現在値を項目に展開 ----

function localItems() {
  const items = new Map(); // id → { kind, key, payload }
  for (const w of readJson(MY_WORDS_KEY, [])) {
    if (w && w.en) items.set(`my_word:${w.en}`, { kind: "my_word", key: w.en, payload: w });
  }
  const notes = readJson(NOTES_KEY, {});
  for (const [wordId, text] of Object.entries(notes && typeof notes === "object" ? notes : {})) {
    if (typeof text === "string" && text) items.set(`note:${wordId}`, { kind: "note", key: wordId, payload: { text } });
  }
  for (const id of readJson(PACKS_KEY, [])) {
    if (typeof id === "string") items.set(`pack:${id}`, { kind: "pack", key: id, payload: { enabled: true } });
  }
  for (const [date, payload] of localDays()) items.set(`day:${date}`, { kind: "day", key: date, payload });
  return items;
}

// 成長ログ（growth_log）と今日のセット（daily_set）から、日ごとの payload を作る
function readGrowthLog() {
  const list = readJson(GROWTH_KEY, []);
  return Array.isArray(list) ? list.filter((e) => e && isDateKey(e.date)) : [];
}

function readDailySet() {
  const raw = readJson(DAILY_SET_KEY, {});
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { ...s, history: Array.isArray(s.history) ? s.history.filter(isDateKey) : [], setsToday: Number(s.setsToday) || 0, setsTodayDate: s.setsTodayDate ?? null };
}

function dayPayload(date, growthRow, daily) {
  const set = daily.history.includes(date);
  return {
    learned: growthRow ? Number(growthRow.learned) || 0 : null,
    mastered: growthRow ? Number(growthRow.mastered) || 0 : null,
    active: !!growthRow?.active,
    set,
    sets: daily.setsTodayDate === date ? daily.setsToday : set ? 1 : 0
  };
}

function localDays() {
  const growth = new Map(readGrowthLog().map((e) => [e.date, e]));
  const daily = readDailySet();
  const dates = new Set([...growth.keys(), ...daily.history]);
  const days = new Map();
  for (const date of dates) days.set(date, dayPayload(date, growth.get(date), daily));
  return days;
}

const maxOrNull = (a, b) => (a == null ? (b == null ? null : Number(b) || 0) : b == null ? Number(a) || 0 : Math.max(Number(a) || 0, Number(b) || 0));

// 2 つの day payload を合わせる（max／OR。順番に依らない）
function mergeDayPayload(a, b) {
  return {
    learned: maxOrNull(a?.learned, b?.learned),
    mastered: maxOrNull(a?.mastered, b?.mastered),
    active: !!(a?.active || b?.active),
    set: !!(a?.set || b?.set),
    sets: Math.max(Number(a?.sets) || 0, Number(b?.sets) || 0)
  };
}

const sameDay = (a, b) =>
  (a?.learned ?? null) === (b?.learned ?? null) &&
  (a?.mastered ?? null) === (b?.mastered ?? null) &&
  !!a?.active === !!b?.active &&
  !!a?.set === !!b?.set &&
  (Number(a?.sets) || 0) === (Number(b?.sets) || 0);

// クラウドの day 行をローカルの成長ログ・今日のセットへ書き込む。戻り値: 変わったか
function applyCloudDays(cloudDays) {
  if (cloudDays.size === 0) return false;
  const oldest = (() => {
    const d = new Date();
    d.setDate(d.getDate() - (GROWTH_MAX_DAYS - 1));
    return localDate(d);
  })();
  const today = localDate();
  const log = readGrowthLog();
  // 成長ログが旧式（v1）の行だけの端末: クラウドの語数（v2 の尺度）を混ぜると、growthLog.js の旧式の底上げが二度と走らない。
  // その端末では「学習した日」だけ取り込み、語数は次の recordGrowthSnapshot（底上げ込み）に任せる
  const v1Only = log.length > 0 && !log.some((e) => e.v === 2);
  const byDate = new Map(log.map((e) => [e.date, e]));
  const daily = readDailySet();
  const history = new Set(daily.history);
  let growthChanged = false;
  let dailyChanged = false;

  for (const [date, p] of cloudDays) {
    if (date < oldest || date > today) continue; // 古すぎる日・未来の日は持たない
    const row = byDate.get(date);
    if (v1Only) {
      if (p.active && row && !row.active) {
        row.active = true;
        growthChanged = true;
      }
    } else if (p.learned != null || p.mastered != null || p.active) {
      if (row) {
        const next = {
          ...row,
          learned: maxOrNull(row.learned, p.learned) ?? 0,
          mastered: maxOrNull(row.mastered, p.mastered) ?? 0,
          active: !!(row.active || p.active)
        };
        if (next.learned !== row.learned || next.mastered !== row.mastered || next.active !== !!row.active) {
          Object.assign(row, next);
          growthChanged = true;
        }
      } else {
        const added = { date, learned: Number(p.learned) || 0, mastered: Number(p.mastered) || 0, active: !!p.active, v: 2 };
        log.push(added);
        byDate.set(date, added);
        growthChanged = true;
      }
    }
    if (p.set && !history.has(date)) {
      history.add(date);
      dailyChanged = true;
    }
    if (date === today && (Number(p.sets) || 0) > 0) {
      const localSets = daily.setsTodayDate === today ? daily.setsToday : 0;
      const sets = Math.max(localSets, Number(p.sets) || 0);
      if (sets !== localSets || daily.setsTodayDate !== today) {
        daily.setsToday = sets;
        daily.setsTodayDate = today;
        dailyChanged = true;
      }
    }
  }

  if (growthChanged) {
    log.sort((a, b) => (a.date < b.date ? -1 : 1));
    writeJson(GROWTH_KEY, log.slice(-GROWTH_MAX_DAYS));
  }
  if (dailyChanged) {
    daily.history = [...history].sort().slice(-DAILY_HISTORY_MAX);
    writeJson(DAILY_SET_KEY, daily);
  }
  return growthChanged || dailyChanged;
}

// 送信する行（dirty のもの。ローカルに無い＝削除された項目は墓標として送る）
export function buildDirtyRows(userId, now = new Date().toISOString()) {
  const meta = getItemMeta();
  const items = localItems();
  const rows = [];
  for (const id of getDirtyItems()) {
    const [kind, ...rest] = id.split(":");
    const key = rest.join(":");
    const item = items.get(id);
    const m = meta[id] ?? {};
    rows.push({
      user_id: userId,
      kind,
      key,
      payload: item ? item.payload : {},
      deleted: !item || !!m.deleted,
      updated_at: m.updatedAt ?? now
    });
  }
  return rows;
}

export function clearDirtyItems() {
  writeJson(DIRTY_KEY, []);
}

// ---- マイ単語帳の「初めて 覚えた になった日」lf を取り込みで残す（Batch 91。docs/SPEC_MY_WORDS.md §17） ----
// 語の行は新しい方が勝つ（ほかの欄はそのまま）。lf だけは、同じ語（足した時刻 addedAt が同じ）の早い方を残す: 勝った行の lf が無いか遅く、
// 負けた側（keep）に 0 以上の整数の lf があれば、keep の lf を写した語を返す。それ以外は win のまま（同じ物を返す: 呼ぶ側は !== で写したかを見る）。
// 0（前から 覚えた。数えない）はどの日より早い。消して足し直した語（addedAt が違う）・字などの読めない lf には写さない（純）。
// Batch 94 から取り込みは下の mergeMyWordPair を使う（この関数は前の決まりのまま残す）
export function keepFirstLearned(win, keep) {
  const own = keep?.lf;
  if (!Number.isInteger(own) || own < 0) return win;
  if (!win || win.addedAt !== keep.addedAt) return win;
  const theirs = win.lf;
  if (Number.isInteger(theirs) && theirs >= 0 && theirs <= own) return win;
  return { ...win, lf: own };
}

// ---- 2 台の取り込みで同じカードの 3 状態と lf を残す（Batch 94・A1。docs/SPEC_MY_WORDS.md §18） ----
// 語の行の勝ち負け（訳・字・単語帳・消した印）は今のまま新しい方。両方に生きた語があり、同じカード（足した時刻 addedAt が同じか、normJa で同じ訳。
// 足した時刻は両方にあるときだけ比べる）のときだけ、3 状態（ls・lsd・lsAt）は lsAt の新しい側から（lsAt の無い側は答えていない。同じなら win のまま）、
// lf は両方の早い方（0 以上の整数だけ。0 はどの日より早い）を写した写しを返す。違うカード・写す物が無いときは win そのもの（純。答えていない語を 覚えた にしない）
const LEARN_FIELDS = ["ls", "lsd", "lsAt", "lf"];
const sameCard = (a, b) => !!a && !!b && ((a.addedAt != null && a.addedAt === b.addedAt) || normJa(a.ja) === normJa(b.ja));
const lsAtOf = (w) => (Number.isFinite(w?.lsAt) ? w.lsAt : -Infinity);
const isLf = (v) => Number.isInteger(v) && v >= 0;
function mergeMyWordPair(win, other) {
  if (!win || !other || !sameCard(win, other)) return win;
  let out = win;
  if (lsAtOf(other) > lsAtOf(win)) out = withLearning(win, { ...other, lf: win.lf });
  if (isLf(other.lf) && (!isLf(out.lf) || other.lf < out.lf)) out = { ...out, lf: other.lf };
  return out;
}
// 3 状態か lf が違うか（雲の行へ送り返すかを決める）
const learnDiff = (a, b) => LEARN_FIELDS.some((f) => (a?.[f] ?? null) !== (b?.[f] ?? null));
// w に from の 3 状態と lf を写した写し（from に無い欄は消す）
function withLearning(w, from) {
  const out = { ...w };
  for (const f of LEARN_FIELDS) {
    if (from[f] === undefined) delete out[f];
    else out[f] = from[f];
  }
  return out;
}

// ---- 同じ名前の単語帳（Batch 94・A3） ----
// 単語帳の一覧（spelldash_my_books）は同期しないので、2 台で同じ単語帳を足すと、語の単語帳の id は端末ごとに違う。取り込みの初めに、端末の一覧と
// 端末の語から「知っている id」と「名前 → id」（名前は js/myWordsCore.js cleanBookName の形）を作る。雲から入れる語（新しく入れる・勝った行で置き換える）の
// 単語帳の id をこの端末が知らず、名前が知っている単語帳と同じなら、この端末の id にする。知らない名前ならそのまま（その id と名前を覚える）。送り返さない
function bookMapper(myWords) {
  const known = new Set();
  const idByName = new Map();
  const learn = (id, name) => {
    known.add(id);
    const n = cleanBookName(name);
    if (n && !idByName.has(n)) idByName.set(n, id);
  };
  for (const b of parseBooks(localStorage.getItem(MY_BOOKS_KEY)).books) learn(b.id, b.name);
  for (const w of myWords) if (!known.has(bookRefOf(w))) learn(bookRefOf(w), w.bookName);
  return (p) => {
    if (!p || bookRefOf(p) !== p.book || known.has(p.book)) return p; // 形の正しい id だけ見る（無い・形の違う値はそのまま）
    const to = idByName.get(cleanBookName(p.bookName));
    if (to) return { ...p, book: to };
    learn(p.book, p.bookName);
    return p;
  };
}

// ---- マイ単語帳の語の合わせ方（Batch 95。1 つの決まり: 取り込み〔phase "pull"〕と送る前〔phase "push"〕の両方が使う。docs/SPEC_MY_WORDS.md §18） ----
// 鍵ごとに、端末の語（か送る待ちの墓標）と雲の行を合わせる。語の行の勝ち負けは前のとおり新しい方（雲の updated_at と端末の印の時刻）。守り:
//  K1 雲に一度も入っていない語（seen でない語）は、雲の墓標の鍵を使わない（その墓標はほかのカードを消した印かもしれない）。
//  A1 同じカード（足した時刻が同じか同じ訳）: 3 状態は答えの新しい側・lf は早い方（mergeMyWordPair）。雲の行が勝って形が変わった語は「雲の時刻 + 1 ms」で送り返す。
//  A2 雲の生きた行が違うカード: いつも両方残す。
//  K1・A2 の語は、取り込みでは新しい鍵へ移す。送りでは端末の鍵を動かさず（回の途中かもしれない）held に入れて送らない（次の取り込みで移す）。
//  同じ時刻: 中身も同じなら同じ版（送れたとみなす）。違えば雲の行を土台に 3 状態と lf を合わせる。
//  雲の墓標と、雲に入った語: 新しい方が勝つ（消した後に答えた・直した語は戻る。同じ時刻なら「墓標の時刻 + 1 ms」で送る）。
//  送る待ちの墓標: 雲に行が無い・雲も墓標 → 外す（消す物が無い）。雲の生きた行が消したカードと同じ（tombVsLive）で墓標が新しい → 送る。
//    それ以外（違うカード・分からない・雲が新しい）→ 雲の行を取り込んで墓標を外す（消すより戻す）。
//  送った墓標の印（sentAt）: 読みが送るより前に始まっていたら、その鍵の生きた行を取り込まない（ほかのタブの古い読みで、消した語を戻さない）。
//  送る待ちでない印（送った墓標・前の版の印）は持たない（外す）。雲の生きた行があれば取り込む。
// 引数: cloud（"my_word:鍵" → 雲の行。pull は全部の行、push は読んだ鍵の行）、myWords・meta・dirty（その場で書き換える。保存は呼び手）、
//   scope（push: 送る待ちの端末の鍵）、read（push: 読んだ雲の鍵）、readAt（雲を読み始めた時刻）。
//   送りは「今も送る待ちの鍵」だけを合わせる（読んでいる間にほかのタブが送って外した鍵は触らない）。
// 戻り値: { changed, toUpload（送る行）, adopted（取り込んだ [端末の id, updated_at]）, held（送りで待たせた端末の鍵）,
//   absent（読んだときに雲に行の無かった送る行の鍵） }
function resolveMyWords({ cloud, myWords, meta, dirty, mapBook, userId, phase, scope = null, read = null, readAt = Date.now() }) {
  const out = { changed: false, toUpload: [], adopted: [], held: [], absent: new Set() };
  const markMs = meta[MERGED] ? Date.parse(meta[MERGED].at ?? "") : NaN;
  const nowIso = new Date().toISOString();
  const tOf = (iso) => Date.parse(iso ?? "") || 0;
  const idOf = (k) => `my_word:${k}`;
  const inScope = (k) => !scope || scope.has(k);
  const localTime = (id, w) => tOf(meta[id]?.updatedAt ?? w?.addedAt);
  // 一度は雲に入った語か: 送る待ちでない（送れた・取り込んだ）か、足した時刻が印の at まで（足した時刻の無い前からの語も）で out に無い
  const unsent = markOut(meta);
  let outChanged = false;
  const seen = (w, id) => !dirty.has(id) || (Number.isFinite(markMs) && (w.addedAt == null || tOf(w.addedAt) <= markMs) && !unsent.has(w.en));
  // 鍵 → 端末の語の位置（小さい順。any: どの語も・words: 英語の語だけ）。1,000 語で鍵ごとに並びを探さない。
  // 消す語は合わせ終わるまで並びに残して removed に入れ、最後に詰める
  const removed = new Set();
  let index = null;
  const addIdx = (m, k, i) => {
    const a = m.get(k);
    if (!a) m.set(k, [i]);
    else {
      a.push(i);
      if (a[a.length - 2] > i) a.sort((x, y) => x - y);
    }
  };
  const delIdx = (m, k, i) => {
    const a = m.get(k);
    if (!a) return;
    const j = a.lastIndexOf(i);
    if (j >= 0) a.splice(j, 1);
    if (a.length === 0) m.delete(k);
  };
  const reindex = () => {
    index = { any: new Map(), words: new Map() };
    myWords.forEach((w, i) => {
      if (removed.has(i)) return;
      addIdx(index.any, w.en, i);
      if (isWordEntry(w)) addIdx(index.words, w.en, i);
    });
  };
  // 同じ鍵の最後の語の位置（localItems・buildDirtyRows と同じ: 鍵が重なれば後ろの語）
  const lastIndex = (k, words = false) => {
    if (!index) reindex();
    const a = (words ? index.words : index.any).get(k);
    return a ? a[a.length - 1] : -1;
  };
  const setAt = (i, w) => {
    const prev = myWords[i];
    myWords[i] = w;
    if (!index) return;
    if (prev.en !== w.en || isWordEntry(prev) !== isWordEntry(w)) {
      delIdx(index.any, prev.en, i);
      delIdx(index.words, prev.en, i);
      addIdx(index.any, w.en, i);
      if (isWordEntry(w)) addIdx(index.words, w.en, i);
    }
  };
  const removeAt = (i, k) => {
    removed.add(i);
    if (index) {
      delIdx(index.any, k, i);
      delIdx(index.words, k, i);
    }
    out.changed = true;
  };
  const pushWord = (w) => {
    myWords.push(w);
    if (index) {
      addIdx(index.any, w.en, myWords.length - 1);
      if (isWordEntry(w)) addIdx(index.words, w.en, myWords.length - 1);
    }
  };
  const withKey = (w, key) => ({ ...w, en: key, text: typeof w.text === "string" && w.text ? w.text : answerKeyOf(w) });
  // 同じ版か（同じ時刻の行どうし）: 3 状態・lf・訳・字・足した時刻が同じ（単語帳の id は端末ごとに違ってよい: bookMapper）
  const sameVersion = (a, b) => !learnDiff(a, b) && (a?.ja ?? null) === (b?.ja ?? null) && (a?.text ?? null) === (b?.text ?? null) && (a?.addedAt ?? null) === (b?.addedAt ?? null);
  const relabeled = [];

  // 1. 取り込みだけ: K1・A2 の語を新しい鍵へ移す
  if (phase === "pull") {
    const rows = [...cloud.values()].filter((r) => r.kind === "my_word");
    const alive = rows.filter((r) => !r.deleted && isWordEntry(r.payload));
    for (const r of rows) {
      const id = idOf(r.key);
      const i = lastIndex(r.key, true);
      if (i < 0) continue;
      const w = myWords[i];
      const move = r.deleted ? !seen(w, id) : isWordEntry(r.payload) && !sameCard(w, r.payload);
      if (!move) continue;
      const answer = answerKeyOf(w);
      // 雲に同じ組（答えの英語と訳）が別の鍵であればその鍵（端末にその鍵が無いときだけ: 同じカードとして合わさる）。
      // 無ければ myIdentityFor（端末の語と雲の行の鍵を全部使っていると見る）
      const same = alive.find((x) => x.key !== r.key && answerKeyOf({ en: x.key }) === answer && normJa(x.payload.ja) === normJa(w.ja) && lastIndex(x.key) < 0);
      const key = same ? same.key : myIdentityFor([...myWords, ...rows.map((x) => ({ en: x.key }))], answer, w.ja);
      const nid = idOf(key);
      setAt(i, withKey(w, key));
      meta[nid] = { updatedAt: meta[id]?.updatedAt ?? w.addedAt ?? nowIso, deleted: false };
      delete meta[id];
      dirty.delete(id);
      dirty.add(nid);
      unsent.add(key); // 移した語はまだ雲に入っていない
      outChanged = true;
      out.changed = true;
    }
  }

  // 2. 鍵ごとに合わせる
  // 送る行を足す
  const upload = (k, payload, at = null) => {
    const id = idOf(k);
    const time = at ?? meta[id]?.updatedAt ?? payload?.addedAt ?? nowIso;
    if (at || !meta[id]) meta[id] = { updatedAt: time, deleted: false };
    out.toUpload.push({ user_id: userId, kind: "my_word", key: k, payload, deleted: false, updated_at: time });
    if (!cloud.has(id)) out.absent.add(k);
  };
  // 雲の行 r（鍵 k）を取り込む（i: 端末の語の位置か -1）
  const adopt = (k, r, i) => {
    const id = idOf(k);
    if (r.deleted) {
      if (i >= 0) removeAt(i, k);
      delete meta[id];
      dirty.delete(id);
      return;
    }
    const w = i >= 0 ? myWords[i] : null;
    if (r.payload && r.payload.en) {
      const kept = mapBook(w && isWordEntry(w) && isWordEntry(r.payload) ? mergeMyWordPair(r.payload, w) : r.payload);
      if (i >= 0) setAt(i, kept);
      else pushWord(kept);
      if (learnDiff(kept, r.payload)) relabeled.push({ key: k, payload: kept, at: new Date(tOf(r.updated_at) + 1).toISOString() });
    }
    out.changed = true;
    meta[id] = { updatedAt: r.updated_at, deleted: false };
    out.adopted.push([id, r.updated_at]);
  };
  // 端末の生きた語 w と雲の行 r（同じ鍵 k）が同じカード: 新しい方。同じ時刻で中身も同じなら送れたとみなす
  const settleSameCard = (k, w, i, r) => {
    const id = idOf(k);
    const tL = localTime(id, w);
    const tR = tOf(r.updated_at);
    if (tL > tR) {
      let payload = w;
      const kept = mergeMyWordPair(w, r.payload); // 端末が勝つときも、雲の新しい 3 状態と早い lf を写してから送る（A1）
      if (kept !== w) {
        setAt(i, withLearning(w, kept));
        payload = myWords[i];
        out.changed = true;
      }
      upload(k, payload);
    } else if (tL < tR || !sameVersion(w, r.payload)) adopt(k, r, i);
    else if (dirty.has(id)) out.adopted.push([id, r.updated_at]);
  };

  const keys = new Set();
  for (const r of cloud.values()) if (r.kind === "my_word") keys.add(r.key);
  for (const w of myWords) keys.add(w.en);
  for (const id of [...dirty, ...Object.keys(meta)]) if (id.startsWith("my_word:")) keys.add(id.slice(8));
  for (const k of keys) {
    if (!inScope(k)) continue;
    const id = idOf(k);
    const d = dirty.has(id);
    if (phase === "push" && !d) continue; // 送り: 今も送る待ちの鍵だけ
    const r = cloud.get(id) ?? null;
    const i = lastIndex(k);
    const w = i >= 0 ? myWords[i] : null;
    const m = meta[id];
    if (w) {
      if (!r) {
        upload(k, w); // 送る待ちでなくても送る（雲に行が無いのは送れていない証拠）
        continue;
      }
      const tL = localTime(id, w);
      const tR = tOf(r.updated_at);
      if (r.deleted) {
        if (isWordEntry(w) && !seen(w, id)) out.held.push(k); // K1（送りだけ。取り込みは 1. で移した）
        else if (tL > tR) upload(k, w);
        else if (tL === tR) upload(k, w, new Date(tR + 1).toISOString());
        else adopt(k, r, i);
        continue;
      }
      const both = isWordEntry(w) && isWordEntry(r.payload);
      if (both && !sameCard(w, r.payload)) {
        out.held.push(k); // A2（送りだけ。取り込みは 1. で移した）
        continue;
      }
      if (both) settleSameCard(k, w, i, r);
      else {
        // 場面カードと語が同じ鍵: 前のとおり新しい方
        if (tL > tR) upload(k, w);
        else if (tL < tR) adopt(k, r, i);
        else if (d && JSON.stringify(w) === JSON.stringify(r.payload)) out.adopted.push([id, r.updated_at]);
      }
      continue;
    }
    if (d) {
      // 送る待ちの墓標（印の無い送る待ちも buildDirtyRows と同じく墓標）
      if (!r || r.deleted) {
        dirty.delete(id);
        delete meta[id];
        continue;
      }
      if (tombVsLive(m?.deleted ? m : null, r.payload, meta) === "same" && tOf(m.updatedAt) > tOf(r.updated_at)) {
        out.toUpload.push({ user_id: userId, kind: "my_word", key: k, payload: {}, deleted: true, updated_at: m.updatedAt });
        continue;
      }
      dirty.delete(id);
      adopt(k, r, -1);
      continue;
    }
    if (m?.deleted && m.sentAt && readAt <= tOf(m.sentAt)) continue; // 送ったばかりの墓標: この読みは送る前の雲かもしれない
    if (m) delete meta[id];
    if (r && !r.deleted) adopt(k, r, -1);
  }
  if (removed.size > 0) {
    let j = 0;
    for (let i = 0; i < myWords.length; i++) if (!removed.has(i)) myWords[j++] = myWords[i];
    myWords.length = j;
  }
  for (const { key, payload, at } of relabeled) {
    out.toUpload.push({ user_id: userId, kind: "my_word", key, payload, deleted: false, updated_at: at });
    meta[idOf(key)] = { updatedAt: at, deleted: false };
  }
  if (outChanged && meta[MERGED]) meta[MERGED] = { ...meta[MERGED], out: [...unsent] };
  return out;
}

// 印 merged を進める（雲を読めて合わせた回の終わり。印のある端末は語を読めなかった回も）: at を「今 − 1 ms」まで進め（戻さない）、out を数え直す。
// out = 送る待ちに残った生きた語のうち、前の印で「雲に入った」と言えない語（この回で送れた・取り込んだ語〔settled〕と、鍵を送れないとても古い語は除く）。
// 送る待ちに残った語は印を止めない（止めると、その後に雲に入った語まで「入っていない」と見て、ほかの端末で消した語を戻してしまう）。
// 送った墓標の印（sentAt）は READ_FRESH_MS + 5 秒を過ぎたら外す（それより古い読みは捨てるので、もう要らない）
function advanceMark(nowMs, settled = new Set()) {
  const meta = getItemMeta();
  const dirty = getDirtyItems();
  const list = readJson(MY_WORDS_KEY, []);
  const old = meta[MERGED] ?? null;
  const oldMs = old ? Date.parse(old.at ?? "") : NaN;
  const oldOut = markOut(meta);
  const out = [];
  for (const w of Array.isArray(list) ? list : []) {
    if (!w || !w.en) continue;
    const id = `my_word:${w.en}`;
    if (!dirty.has(id) || settled.has(id)) continue;
    if (cleanSendText(w.en) !== w.en) continue;
    const a = Date.parse(w.addedAt ?? "");
    const seenBefore = Number.isFinite(oldMs) && (w.addedAt == null || (Number.isFinite(a) && a <= oldMs)) && !oldOut.has(w.en);
    if (!seenBefore) out.push(w.en);
  }
  let swept = false;
  for (const [id, m] of Object.entries(meta)) {
    if (!id.startsWith("my_word:") || !m?.deleted || !m.sentAt || dirty.has(id)) continue;
    if (nowMs - (Date.parse(m.sentAt) || 0) > READ_FRESH_MS + 5000) {
      delete meta[id];
      swept = true;
    }
  }
  const t = nowMs - 1; // 印の時刻ちょうどに足した語（同じミリ秒）は入ったと見ない
  const at = new Date(Number.isFinite(oldMs) ? Math.max(oldMs, t) : t).toISOString();
  const next = out.length > 0 ? { at, out } : { at };
  if (!swept && old && old.at === at && JSON.stringify(old.out ?? []) === JSON.stringify(out) && !(UNMERGED in meta)) return;
  meta[MERGED] = next;
  delete meta[UNMERGED];
  writeJson(META_KEY, meta);
}

// ---- クラウドの行をローカルへ反映（項目ごとに新しい方が勝つ） ----
// 戻り値: { changed: {my_word,note,pack,day} の変更有無, toUpload: クラウドに無い／古いローカル項目（マイ単語帳は送る墓標も）,
//   adopted: クラウドの方が新しくて端末に取り込んだ項目の [id, その行の updated_at]（Batch 87: 取り込みの後で送る待ちから外す）,
//   absent: マイ単語帳の送る行のうち、読んだときに雲に行の無かった鍵（resolveMyWords） }
// マイ単語帳の語は resolveMyWords（送る前の合わせと同じ決まり）。メモ・パック・日は前のまま。
// 印 merged はここでは進めない（送れなかった語を「雲に入った」と見ないため。送った後に pullUserItems が進める）。readAt: 雲を読み始めた時刻

export function mergeCloudItems(rows, userId = null, readAt = Date.now()) {
  const meta = getItemMeta();
  delete meta[UNMERGED];
  const changed = { my_word: false, note: false, pack: false, day: false };
  const toUpload = [];
  const adopted = [];
  const cloud = new Map();
  const cloudDays = new Map(); // date → payload（day は時刻ではなく値で合わせる）
  for (const r of rows ?? []) {
    if (!r || !r.kind || !r.key) continue;
    if (r.kind === "day") {
      if (isDateKey(r.key) && !r.deleted && r.payload && typeof r.payload === "object") cloudDays.set(r.key, r.payload);
      continue;
    }
    cloud.set(`${r.kind}:${r.key}`, r);
  }

  // day: クラウドの値をローカルへ（max／OR）→ 合わせた値がクラウドと違えば送り返す
  changed.day = applyCloudDays(cloudDays);
  const nowIso = new Date().toISOString();
  for (const [date, payload] of localDays()) {
    const merged = mergeDayPayload(payload, cloudDays.get(date));
    if (cloudDays.has(date) && sameDay(merged, cloudDays.get(date))) continue;
    toUpload.push({ user_id: userId, kind: "day", key: date, payload: merged, deleted: false, updated_at: nowIso });
    meta[`day:${date}`] = { updatedAt: nowIso, deleted: false };
  }

  // マイ単語帳の語（A1・A2・A3・K1・墓標）
  const myWords = readJson(MY_WORDS_KEY, []).filter((w) => w && w.en);
  const dirty = getDirtyItems();
  const words = resolveMyWords({ cloud, myWords, meta, dirty, mapBook: bookMapper(myWords), userId, phase: "pull", readAt });
  if (words.changed) changed.my_word = true;
  toUpload.push(...words.toUpload);
  adopted.push(...words.adopted);

  // メモ・パック（前のまま）
  const items = localItems();
  for (const [id, item] of items) if (item.kind !== "note" && item.kind !== "pack") items.delete(id);
  const notes = readJson(NOTES_KEY, {});
  let packs = readJson(PACKS_KEY, []).filter((id) => typeof id === "string");
  const localTime = (id, item) => Date.parse(meta[id]?.updatedAt ?? item?.payload?.addedAt ?? 0) || 0;
  for (const [id, r] of cloud) {
    if (r.kind !== "note" && r.kind !== "pack") continue;
    const item = items.get(id);
    const cloudTime = Date.parse(r.updated_at ?? 0) || 0;
    const lTime = localTime(id, item);
    if ((item || meta[id]) && lTime >= cloudTime) continue; // ローカルが新しい（または同時刻）
    if (r.kind === "note") {
      if (r.deleted || !r.payload?.text) delete notes[r.key];
      else notes[r.key] = String(r.payload.text).slice(0, 80);
      changed.note = true;
    } else {
      const on = !r.deleted && r.payload?.enabled !== false;
      packs = packs.filter((p) => p !== r.key);
      if (on) packs.push(r.key);
      changed.pack = true;
    }
    meta[id] = { updatedAt: r.updated_at, deleted: !!r.deleted };
    adopted.push([id, r.updated_at]);
  }
  for (const [id, item] of items) {
    const r = cloud.get(id);
    const lTime = localTime(id, item);
    const cloudTime = r ? Date.parse(r.updated_at ?? 0) || 0 : -1;
    if (!r || lTime > cloudTime) {
      const at = meta[id]?.updatedAt ?? item.payload?.addedAt ?? new Date().toISOString();
      toUpload.push({ user_id: userId, kind: item.kind, key: item.key, payload: item.payload, deleted: false, updated_at: at });
      if (!meta[id]) meta[id] = { updatedAt: at, deleted: false };
    }
  }

  // 書く順: 語 → 送る待ち → メモ・パック → 印
  if (changed.my_word) writeJson(MY_WORDS_KEY, myWords);
  writeJson(DIRTY_KEY, [...dirty]);
  if (changed.note) writeJson(NOTES_KEY, notes);
  if (changed.pack) writeJson(PACKS_KEY, packs);
  writeJson(META_KEY, meta);
  return { changed, toUpload, adopted, absent: words.absent };
}

// ---- 送る形と送り方（Batch 85。docs/SPEC_MY_WORDS.md §14.3） ----
// 1. 字を整える: 送る行の payload の文字（入れ子・鍵の名前も）のうち、送り先の表が受け付けない字（NUL と組になっていないサロゲート）だけを
//    1 字ずつ U+FFFD に替える。1 字でも入ると同じ要求の行がどれも届かなかった（前の版のバックアップ・ほかの端末から届いた行・80 字で切れた
//    メモの絵文字の半分）。ほかの字（タブ・改行・ほかの制御文字・C1・向きを変える字）は前のまま送る: 送り先は受け付ける。字を落とすと、
//    見えない字だけの訳や場面がほかの端末で空になって語が見えなくなり、字だけが違う 2 つの組が同じ組になる。1 字を 1 字に替えるので、空でない欄は空にならない。
//    整えるのは送る写しだけ（端末の保存は書き換えない。端末では前の字のまま読める）。新しく入れる字は、入れる道がどれも断る（js/myWordsCore.js）
// 2. 鍵に送り先が受け付けない字がある行（Batch 85 より前のデータから来た、とても古い場面カード・メモの鍵だけ）は送らない: 鍵を替えると
//    別の項目になる（もう一方の端末で 2 つになる）。端末にだけ残り、送る待ちにも残る（要求はしない）。ほかの見えない字のある鍵は鍵のまま送る
// 3. 組（UPLOAD_CHUNK 行）が行の中身で断られたら（400・413・422）、半分ずつに分けて送り直す。通った行は送れたことにし、1 行だけで断られた行に
//    印を付ける。分けて送り直す要求は 1 回の送信で UPLOAD_SPLIT_MAX まで（上限に着いたら、まだ確かめていない行も断られた行と同じに印を付けて待つ:
//    どの行も断られる表の食い違いで、ページを開くたびに要求を重ねない）
// 4. 印の付いた行（その版のまま）は UPLOAD_RETRY_MS（1 日）の間は送らない。行が変われば（touchItem・ほかの端末から届いた行）印は消え、次の送信で送る
// 5. day の行は前のまま（分けない・印を付けない・古い制約 23514 ならこのページでは送らない）。通信の失敗・5xx・401・403・409（記録の持ち主が
//    替わった）・状態の無い失敗は、分けずに組ごと送る待ちに残す（前のまま。次の送信で送り直す）
export const UPLOAD_CHUNK = 500;
export const UPLOAD_SPLIT_MAX = 40; // 500 行の組に断られる行が 2 つあっても見つけられる数（1 つなら 2 × 9 = 18）
export const UPLOAD_RETRY_MS = 24 * 60 * 60 * 1000;
const ROW_ERRORS = new Set([400, 413, 422]); // 行の中身で断られた（ほかの行は通るかもしれない）
// 送り先の表が受け付けない字: NUL と組になっていないサロゲート（u フラグ: 組になったサロゲート〔絵文字〕には当たらない）
const SEND_REFUSED = /\u0000|[\uD800-\uDFFF]/gu;

const rowId = (r) => `${r.kind}:${r.key}`;

// 送る文字を整える（送り先が受け付けない字だけを 1 字ずつ U+FFFD に。字を落とさない）
export function cleanSendText(text) {
  return String(text).replace(SEND_REFUSED, "\uFFFD");
}

// 送る値を整えた写し（文字・配列・入れ子の物と鍵の名前。数・真偽・null はそのまま）。元の値は変えない
export function cleanSendValue(value) {
  if (typeof value === "string") return cleanSendText(value);
  if (Array.isArray(value)) return value.map((v) => cleanSendValue(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanSendText(k), cleanSendValue(v)]));
  return value;
}

// 送る写し（send）と、鍵に送り先が受け付けない字があって送らない行（keep）
function prepareRows(rows) {
  const send = [];
  const keep = [];
  for (const r of rows) {
    if (typeof r.key !== "string" || cleanSendText(r.key) !== r.key) keep.push(r);
    else send.push({ ...r, payload: cleanSendValue(r.payload) });
  }
  return { send, keep };
}

// 印（meta の failAt・failFor）があり、その版のままで、待つ間の中か（時計が戻って先の時刻の印になったときは待たない）
function waiting(m, now) {
  return !!m && typeof m.failAt === "number" && m.failFor === m.updatedAt && now >= m.failAt && now - m.failAt < UPLOAD_RETRY_MS;
}

// 断られた行に印を付ける（送った時と同じ版の行だけ。送っている間に変わった行は印を付けず、次の送信で新しい版を送る）。送る待ちにも入れる
// （取り込みの送り直しの行は送る待ちに無いので、待つ間が過ぎたら次の送信で送る）
function markRejected(rows, now) {
  if (rows.length === 0) return;
  const meta = getItemMeta();
  const dirty = getDirtyItems();
  for (const r of rows) {
    const id = rowId(r);
    const m = meta[id];
    if (m && m.updatedAt !== r.updated_at) continue;
    meta[id] = { ...(m ?? { updatedAt: r.updated_at, deleted: !!r.deleted }), failAt: now, failFor: m?.updatedAt ?? r.updated_at };
    dirty.add(id);
  }
  writeJson(META_KEY, meta);
  writeJson(DIRTY_KEY, [...dirty]);
}

// ---- Supabase との送受信（sync.js から呼ばれる。テーブル未作成・失敗は静かにスキップ） ----

// day の行は別の送信に分ける: kind の check 制約に day が無い古い表（docs/SQL_USER_ITEMS.md 1b. 未実行）でも、
// マイ単語帳・メモ・パックの送信まで一緒に失敗しないように。
// 古い制約（check 違反 23514）で day が弾かれたら、このページでは day を送らない（毎回 120 行を送って失敗し続けないため）。
// dirty には残すので、表が直った後の次のページで送られる
let dayRejected = false;

// 戻り値 { failed（送れなかった行: 次の送信で送り直す）, rejected（行の中身で断られた行・上限で確かめられなかった行: 印を付けて待つ）,
//   skipped（送らなかった行・書かれなかった行: 送る待ちに残し、次に読んでから送る） }
// options.deadline（Batch 95）: マイ単語帳の語の行を送ってよい最後の時刻（読み始めから READ_FRESH_MS）。語の行を送る要求のたびに直前に確かめ、
//   過ぎていれば語の行は送らずに skipped に入れる（止まっていたページの古い読みで書かない）。メモ・パック・日は送る。
// options.absent（Batch 95）: 読んだときに雲に行の無かった語の鍵。その行は「無いときだけ書く」（upsert の ignoreDuplicates。同じ鍵の行があれば書かない）で
//   別の要求にし、書いた行だけを返させる（.select）。返らなかった行は書かれていない（読んだ後にほかの端末が同じ鍵に書いた）ので skipped。
//   行を返さない答え（data が配列でない）は、どの行も書けたと確かめられないので全部 skipped（次の送りが読んで合わせる）
async function upsertRows(supabase, rows, { deadline = Infinity, absent = null } = {}) {
  const isNew = (r) => r.kind === "my_word" && !!absent && absent.has(r.key);
  // 組: 雲に行の無かった鍵の語（無いときだけ書く）・ほかの語とメモ・パック（前のとおり 1 つの要求）・日
  const groups = [rows.filter(isNew), rows.filter((r) => r.kind !== "day" && !isNew(r)), dayRejected ? [] : rows.filter((r) => r.kind === "day")];
  const failed = dayRejected ? rows.filter((r) => r.kind === "day") : [];
  const rejected = [];
  const skipped = [];
  let budget = UPLOAD_SPLIT_MAX;
  // 読み始めから時間がたった: 組の語の行は送らずに skipped へ（メモ・パックは送る）
  const fresh = (chunk) => {
    if (Date.now() <= deadline || !chunk.some((r) => r.kind === "my_word")) return chunk;
    skipped.push(...chunk.filter((r) => r.kind === "my_word"));
    return chunk.filter((r) => r.kind !== "my_word");
  };
  const send = async (chunk) => {
    try {
      const onlyNew = isNew(chunk[0]);
      const result = await (onlyNew ? supabase.from("user_items").upsert(chunk, { ignoreDuplicates: true }).select("kind,key") : supabase.from("user_items").upsert(chunk));
      if (result && !result.error) {
        if (!onlyNew) return { ok: true, skipped: [] };
        const wrote = new Set((Array.isArray(result.data) ? result.data : []).map((r) => `${r?.kind}:${r?.key}`));
        return { ok: true, skipped: chunk.filter((r) => !wrote.has(rowId(r))) };
      }
      return { ok: false, rowError: ROW_ERRORS.has(Number(result?.status)), code: result?.error?.code };
    } catch {
      return { ok: false, rowError: false };
    }
  };
  // 行の中身で断られた組（day でない）を半分ずつ送り直す。1 行なら断られた行
  const split = async (chunk) => {
    if (chunk.length === 1) {
      rejected.push(chunk[0]);
      return;
    }
    const mid = Math.ceil(chunk.length / 2);
    for (const whole of [chunk.slice(0, mid), chunk.slice(mid)]) {
      const half = fresh(whole);
      if (half.length === 0) continue;
      if (budget <= 0) {
        rejected.push(...half);
        continue;
      }
      budget--;
      const r = await send(half);
      if (r.ok) {
        skipped.push(...r.skipped);
        continue;
      }
      if (r.rowError) await split(half);
      else failed.push(...half);
    }
  };
  for (const group of groups) {
    for (let i = 0; i < group.length; i += UPLOAD_CHUNK) {
      const chunk = fresh(group.slice(i, i + UPLOAD_CHUNK));
      if (chunk.length === 0) continue;
      const r = await send(chunk);
      if (r.ok) {
        skipped.push(...r.skipped);
        continue;
      }
      if (chunk[0]?.kind === "day") {
        failed.push(...chunk);
        if (r.code === "23514") dayRejected = true;
      } else if (r.rowError) {
        await split(chunk);
      } else {
        failed.push(...chunk);
      }
    }
  }
  return { failed, rejected, skipped };
}

// day の行は、送る前にクラウドの同じ日の行を読んで max／OR で合わせる（別の端末が先に送った完了や語数を巻き戻さない）。
// 合わせた値はこの端末にも書く。読めなかった日は送らずに dirty に残す。戻り値: 送ってよい day 行
async function mergeDayRowsWithCloud(supabase, dayRows) {
  if (dayRows.length === 0 || dayRejected) return [];
  let cloud;
  try {
    const result = await supabase.from("user_items").select("key,payload").eq("kind", "day").in("key", dayRows.map((r) => r.key));
    if (!result || result.error || !Array.isArray(result.data)) return [];
    cloud = new Map(result.data.map((r) => [r.key, r.payload]));
  } catch {
    return [];
  }
  const merged = new Map();
  const rows = dayRows.map((r) => {
    if (!cloud.has(r.key)) return r;
    const payload = mergeDayPayload(r.payload, cloud.get(r.key));
    merged.set(r.key, payload);
    return { ...r, payload };
  });
  if (merged.size > 0) applyCloudDays(merged);
  return rows;
}

// ---- 送る（Batch 95。pushSync の最後の await。答えの道・pushSync の頭は変えない。docs/SPEC_MY_WORDS.md §18.11） ----
// マイ単語帳の語の行は、送る前にその鍵の雲の行を読み、取り込みと同じ決まり（resolveMyWords の phase "push"）で合わせ、合わせた後の行だけを送る。
// 読み方: 送る待ちの鍵が PUSH_READ_KEYS_MAX 以下で、どれも英語の鍵の形（英字・数字・空白・ハイフン・アポストロフィ・「~」）なら鍵の並びで読む
// （鍵の長さの合計 KEYS_PER_READ_CHARS ごとに要求を分ける: URL が長くなりすぎない）。それより多い・古い形の鍵がある → 全部の行を 1,000 行ずつ（readAllRows）。
// 読めない回は語を送らない（送る待ちに残す。次の送りか取り込みが読み直す）。メモ・パック・日は前のとおり送る。
// ページを離れるとき（pagehide・裏に回す）も同じ（読む → 送る）。途中でページが閉じても送る待ちに残り、次に読んでから送る
export const PUSH_READ_KEYS_MAX = 200;
export const KEYS_PER_READ_CHARS = 1500;
// 読み始めから READ_FRESH_MS を過ぎた読み（裏に回したページが止まっていた）では語を書かない: その間にほかの端末が書いた新しい行を、
// 古い読みで合わせた行で上書きしてしまう。確かめるのは合わせる前と、語の行を送る要求のたび（upsertRows の deadline）。取り込みも同じ
export const READ_FRESH_MS = 20000;
const KEY_LIST_SAFE = /^[a-z0-9' ~-]+$/i;

function keyChunks(keys) {
  const out = [];
  let cur = [];
  let len = 0;
  for (const k of keys) {
    const n = encodeURIComponent(k).length + 3;
    if (cur.length > 0 && len + n > KEYS_PER_READ_CHARS) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(k);
    len += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// 鍵の雲の行（戻り値は readAllRows と同じ形。鍵の並びで読んだときは、その鍵の my_word の行だけ）
async function readWordRows(client, keys) {
  if (keys.length > PUSH_READ_KEYS_MAX || !keys.every((k) => KEY_LIST_SAFE.test(k))) return readAllRows(client, "user_items", ["kind", "key"]);
  const rows = [];
  for (const chunk of keyChunks(keys)) {
    let result;
    try {
      result = await client.from("user_items").select("kind,key,payload,deleted,updated_at").eq("kind", "my_word").in("key", chunk);
    } catch (error) {
      return { ok: false, error, status: null };
    }
    if (!result || result.error || !Array.isArray(result.data)) return { ok: false, error: result?.error ?? null, status: result?.status ?? null };
    rows.push(...result.data);
  }
  return { ok: true, rows };
}

// 読めた雲の行で、送る待ちの語を合わせる（語・送る待ち・印をその場で書く）。keys: 送る待ちの端末の鍵、read: 読んだ雲の鍵
function mergeBeforeSend(rows, keys, read, userId, readAt) {
  const meta = getItemMeta();
  delete meta[UNMERGED];
  const cloud = new Map();
  for (const r of rows ?? []) if (r && r.kind === "my_word" && r.key && read.has(r.key)) cloud.set(`my_word:${r.key}`, r);
  const myWords = readJson(MY_WORDS_KEY, []).filter((w) => w && w.en);
  const dirty = getDirtyItems();
  const res = resolveMyWords({ cloud, myWords, meta, dirty, mapBook: bookMapper(myWords), userId, phase: "push", scope: new Set(keys), read, readAt });
  if (res.changed) writeJson(MY_WORDS_KEY, myWords);
  writeJson(DIRTY_KEY, [...dirty]);
  writeJson(META_KEY, meta);
  if (res.changed) window.dispatchEvent(new CustomEvent("spelldash:mywords"));
  return res;
}

// 送れた行・取り込んだ項目を送る待ちから外す（送った時と同じ版だけ: 送っている間に変わった行は残す。マイ単語帳でない行は、
// metaAtStart を渡せば前のとおり「印の時刻が送りの初めと同じ」で見る）。送れたマイ単語帳の墓標は、雲の鍵の印に
// { updatedAt, deleted: true, sentAt } だけを残す（card は外す。advanceMark が後で外す: 送るより前に始めたほかのタブの読みで消した語を戻さない）
function settleRows(sent, adopted = [], metaAtStart = null) {
  if (sent.length === 0 && adopted.length === 0) return;
  const meta = getItemMeta();
  const dirty = getDirtyItems();
  const before = dirty.size;
  let metaChanged = false;
  const sentAt = new Date().toISOString();
  for (const r of sent) {
    const id = rowId(r);
    const m = meta[id];
    const same = metaAtStart && r.kind !== "my_word" ? m?.updatedAt === metaAtStart[id]?.updatedAt : m?.updatedAt === r.updated_at;
    if (!same) continue;
    dirty.delete(id);
    if (r.kind === "my_word" && r.deleted && m?.deleted) {
      meta[id] = { updatedAt: r.updated_at, deleted: true, sentAt };
      metaChanged = true;
    }
  }
  for (const [id, at] of adopted) if (meta[id]?.updatedAt === at) dirty.delete(id);
  if (dirty.size !== before) writeJson(DIRTY_KEY, [...dirty]);
  if (metaChanged) writeJson(META_KEY, meta);
}

// 送れなかった行（通信の失敗・読みが古くて送らなかった・書かれなかった）を送る待ちに残す（印は合わせたときのまま。墓標の card も残す）
function markUnsent(rows) {
  if (rows.length === 0) return;
  const meta = getItemMeta();
  const dirty = getDirtyItems();
  for (const r of rows) {
    const id = rowId(r);
    dirty.add(id);
    if (!meta[id]) meta[id] = { updatedAt: r.updated_at, deleted: !!r.deleted };
  }
  writeJson(META_KEY, meta);
  writeJson(DIRTY_KEY, [...dirty]);
}

// options.now: 今の時刻（ms。待つ間の確かめと印。検査が渡す）
export async function pushUserItems(supabase, userId, { now = Date.now() } = {}) {
  const metaAtStart = getItemMeta(); // 送信中にまた変わった項目（印の時刻が変わった）は dirty に残す
  const dirtyIds = [...getDirtyItems()];
  if (dirtyIds.length === 0) return;
  // 1. 読む: 語の送る待ちの鍵と日の行を同時に（読みと送りの間に別の待ちをはさまない）。断られて待っている行は読まない・送らない
  const keys = dirtyIds.filter((id) => id.startsWith("my_word:") && !waiting(metaAtStart[id], now)).map((id) => id.slice(8));
  const others = buildDirtyRows(userId).filter((r) => r.kind !== "my_word" && (r.kind === "day" || !waiting(metaAtStart[rowId(r)], now)));
  const readAt = Date.now();
  const [read, days] = await Promise.all([keys.length > 0 ? readWordRows(supabase, keys) : null, mergeDayRowsWithCloud(supabase, others.filter((r) => r.kind === "day"))]);
  // 2. 合わせる（読み始めから READ_FRESH_MS の内だけ）。待たせた語（K1・A2）は送らない（次の取り込みで移す）
  let words = null;
  if (read?.ok) {
    noteTable(false);
    if (Date.now() - readAt <= READ_FRESH_MS) words = mergeBeforeSend(read.rows, keys, new Set(keys), userId, readAt);
  } else if (read && isMissingTable(read)) noteTable(true);
  // 3. 送る（鍵に送り先が受け付けない字がある行は送らない: 送る待ちに残る）
  const { send } = prepareRows([...(words?.toUpload ?? []), ...others.filter((r) => r.kind !== "day"), ...days]);
  let sent = [];
  if (send.length > 0) {
    const { failed, rejected, skipped } = await upsertRows(supabase, send, { deadline: readAt + READ_FRESH_MS, absent: words?.absent }); // ベストエフォート
    const notSent = new Set([...failed, ...rejected, ...skipped].map(rowId));
    sent = send.filter((r) => !notSent.has(rowId(r)));
    markUnsent([...failed, ...skipped].filter((r) => r.kind === "my_word"));
    markRejected(rejected, now);
  }
  settleRows(sent, words?.adopted ?? [], metaAtStart);
  // 印 merged は回の終わりに進める（印の無い端末は、語を読めて合わせた回だけ: 最初の印は雲を読めた印）
  if (words || getItemMeta()[MERGED]) advanceMark(Date.now(), new Set([...sent.map(rowId), ...(words?.adopted ?? []).map(([id]) => id)]));
}

// ---- 表がまだ無い（Batch 86。docs/SPEC_MY_WORDS.md §4） ----
// user_items の表がクラウドに無い（作るのは創業者: docs/SQL_USER_ITEMS.md）とき、マイ単語帳の画面はログイン中の人に「この端末だけに保存している」と 1 行で言う。
// 知らせはこのページの中だけ（保存の鍵は作らない）: tableMissing（null は分からない）と spelldash:useritems-table（detail.missing）。表ができれば次に読んだときに消える
let tableMissing = null;
function noteTable(missing) {
  if (tableMissing === missing) return;
  tableMissing = missing;
  window.dispatchEvent(new CustomEvent("spelldash:useritems-table", { detail: { missing } }));
}
// 表が無いときの答え: js/funnelLog.js の isMissingError と同じ見分け（42P01・PGRST205・「does not exist」「schema cache」）に、HTTP の 404 を足す
function isMissingTable(result) {
  const error = result?.error;
  if (!error) return false;
  const code = String(error.code ?? "");
  return Number(result?.status) === 404 || code === "42P01" || code === "PGRST205" || /does not exist|schema cache/i.test(String(error.message ?? ""));
}
export function userItemsTableMissing() {
  return tableMissing;
}
// 1 行だけ読んで表があるかを確かめる（同じタブのほかのページで同期が済み、このページでは取り込まないとき。js/sync.js の checkUserItemsTable）。
// 戻り値: true（無い）・false（ある）・null（分からない: つながらない・ほかの失敗）。端末には何も書かない
export async function probeUserItemsTable(supabase) {
  try {
    const result = await supabase.from("user_items").select("kind").limit(1);
    if (result && !result.error) noteTable(false);
    else if (isMissingTable(result)) noteTable(true);
  } catch {
    // 分からないまま
  }
  return tableMissing;
}

// ---- 読み方（Batch 87。docs/SPEC_MY_WORDS.md §16.1・§16.2） ----
// 送り先の API は 1 回の読みで返す行に上限がある（既定 1,000 行。上限より後ろの行は、何も言わずに届かない）。
// 1,000 語の人の user_items（語 1,000 行と日ごとの記録）や学習記録（word_progress）を読み切るため、主キーの列で並べて READ_PAGE 行ずつ読む。
// - 最初の読みで全部の行の数（count）を聞く。次のページの頭は「受け取った行の数」（上限が READ_PAGE より小さい送り先でも抜けない）。
//   1 ページ目は数と同じ時点の行なので、数に届けば終わり。2 ページ目からは、数に届いても、そのページが満ちていれば（1 ページ目と同じ行の数）
//   もう 1 ページ読み、満ちていないページか 0 行の答えで終える（数がページの行の数のちょうど倍数のときだけ、要求が 1 回増える）。
//   count が来ない送り先では、0 行の答えまで読む
// - どのページの読みが落ちても、count に届く前に 0 行の答えが来ても、READ_PAGES_MAX ページで終わらなくても、読み全体を失敗にする
//   （途中までの行で合わせると、届かなかった行の項目を「クラウドに無い」と見て古い値で送り返す）
// - 読みの途中でほかの端末が、前のページの範囲に並ぶ行を足すと（今日の日の行・新しい学習記録など）、後ろの行が 1 つずつ後ろへずれる。
//   数（1 ページ目の時点）に届いた所で止めると、ずれて最後のページの外に出た前からの行を読まずに済ませてしまうので、満ちていないページまで読む。
//   行は消さない（消すのは墓標）ので、足されただけなら、満ちていないページまで読めば前からある行はどれも 1 度は届く（同じ行が 2 度届くことは
//   ある: 項目ごとに合わせるので害は無い）。読みを始めた後に足された行は届かないことがある（読む前の表を読んだのと同じ。次の同期で届く）
// 戻り値: { ok: true, rows } か { ok: false, error, status }（status・error は落ちたページの答え。表が無いかの見分けに使う）
export const READ_PAGE = 1000;
export const READ_PAGES_MAX = 50; // 50,000 行（ここに着くのは壊れた答えだけ）

export async function readAllRows(client, table, orderCols) {
  const rows = [];
  let total = null;
  let full = 0; // 満ちたページの行の数（1 ページ目の行の数: 送り先の 1 回の上限か READ_PAGE）
  for (let page = 0; page < READ_PAGES_MAX; page++) {
    let result;
    try {
      let query = client.from(table).select("*", page === 0 ? { count: "exact" } : {});
      for (const col of orderCols) query = query.order(col, { ascending: true });
      result = await query.range(rows.length, rows.length + READ_PAGE - 1);
    } catch (error) {
      return { ok: false, error, status: null };
    }
    if (!result || result.error || !Array.isArray(result.data)) return { ok: false, error: result?.error ?? null, status: result?.status ?? null };
    const got = result.data.length;
    if (page === 0) {
      if (typeof result.count === "number") total = result.count;
      full = got;
    }
    if (got === 0) return total === null || rows.length >= total ? { ok: true, rows } : { ok: false, error: null, status: result.status ?? null };
    rows.push(...result.data);
    if (total !== null && rows.length >= total && (page === 0 || got < full)) return { ok: true, rows };
  }
  return { ok: false, error: null, status: null };
}

// options.deferPacksEvent: true なら spelldash:packs を投げない（呼び出し側が語の読み直しを 1 回にまとめる）。options.now: 今の時刻（ms。検査が渡す）
export async function pullUserItems(supabase, userId, options = {}) {
  const now = options.now ?? Date.now();
  const readAt = Date.now();
  const read = await readAllRows(supabase, "user_items", ["kind", "key"]);
  const fresh = Date.now() - readAt <= READ_FRESH_MS;
  if (!read.ok) {
    // 雲を読めなかった: 合わせない・送らない（語は送る待ちに残る。次の送りは送る前に自分で読む）。
    // 表がまだ無い（Batch 86）: このページに知らせる（マイ単語帳の画面の 1 行）
    if (isMissingTable(read)) {
      noteTable(true);
      return { changed: null, missing: true };
    }
    return { changed: null };
  }
  noteTable(false);
  const { changed, toUpload, adopted, absent } = mergeCloudItems(read.rows, userId, readAt);
  // 断られて待っている行は送らない（ページを開くたびに同じ行で断られ続けない）。鍵に送り先が受け付けない字がある行も送らない
  const meta = getItemMeta();
  const { send } = prepareRows(toUpload.filter((r) => r.kind === "day" || !waiting(meta[rowId(r)], now)));
  let sent = [];
  if (send.length > 0 && !fresh) markUnsent(send.filter((r) => r.kind !== "day")); // 古い読み: 語・メモ・パックは送る待ちに残す（次の送りが読み直す）
  else if (send.length > 0) {
    // 送れなかった行は次回の pushSync で再送する（dirty に積む）。行の中身で断られた行は印を付けて待つ。
    // 語の行は送りと同じく、要求のたびに読み始めから READ_FRESH_MS の内かを確かめ、雲に行の無かった鍵は「無いときだけ書く」
    const { failed, rejected, skipped } = await upsertRows(supabase, send, { deadline: readAt + READ_FRESH_MS, absent });
    const notSent = new Set([...failed, ...rejected, ...skipped].map(rowId));
    sent = send.filter((r) => !notSent.has(rowId(r)));
    markUnsent([...failed, ...skipped]);
    markRejected(rejected, now);
  }
  settleRows(sent, adopted);
  if (fresh) advanceMark(Date.now(), new Set([...sent.map(rowId), ...adopted.map(([id]) => id)]));
  if (changed.my_word) window.dispatchEvent(new CustomEvent("spelldash:mywords"));
  if (changed.note) window.dispatchEvent(new CustomEvent("spelldash:notes"));
  if (changed.pack && !options.deferPacksEvent) window.dispatchEvent(new CustomEvent("spelldash:packs", { detail: { synced: true } }));
  return { changed };
}
