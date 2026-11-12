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

import { normJa, parseBooks, cleanBookName, bookRefOf } from "./myWordsCore.js";

const META_KEY = "spelldash_user_items_meta"; // { "kind:key": { updatedAt, deleted } }
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

// ---- クラウドの行をローカルへ反映（項目ごとに新しい方が勝つ） ----
// 戻り値: { changed: {my_word,note,pack,day} の変更有無, toUpload: クラウドに無い／古いローカル項目,
//   adopted: クラウドの方が新しくて端末に取り込んだ項目の [id, その行の updated_at]（Batch 87: 取り込みの後で送る待ちから外す） }
// マイ単語帳の語（Batch 91・94）: 雲の行が勝っても、同じカードなら端末の新しい 3 状態と早い lf を残し（mergeMyWordPair）、3 状態か lf が雲の行と違う形になった語だけを
// 「勝った雲の行の時刻 + 1 ms」で送り返す（ほかの端末にも届ける。単語帳だけの違い〔bookMapper〕は送り返さない）。
// 今の時刻にしない: 中身は雲の行のままなので、雲の行より後にほかの端末がした、まだ送っていない変更（訳の直し・消す・答え）が、その端末の次の取り込みで負けて消える。
// 1 ms 後なら、その変更が勝ち、勝った端末の行に雲の 3 状態と lf を写して送る（下の端末の行が勝つ向き）

export function mergeCloudItems(rows, userId = null) {
  const meta = getItemMeta();
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

  const items = localItems();
  for (const id of items.keys()) if (id.startsWith("day:")) items.delete(id); // day は上で済ませた

  const myWords = readJson(MY_WORDS_KEY, []).filter((w) => w && w.en);
  const notes = readJson(NOTES_KEY, {});
  let packs = readJson(PACKS_KEY, []).filter((id) => typeof id === "string");
  const mapBook = bookMapper(myWords); // 同じ名前の単語帳はこの端末の id へ（A3）

  const localTime = (id, item) => Date.parse(meta[id]?.updatedAt ?? item?.payload?.addedAt ?? 0) || 0;
  const relabeled = []; // 勝った雲の行に端末の 3 状態か早い lf を残した語と送る時刻（Batch 91・94。雲の行の時刻 + 1 ms で送り返す）

  // クラウド → ローカル
  for (const [id, r] of cloud) {
    const item = items.get(id);
    const cloudTime = Date.parse(r.updated_at ?? 0) || 0;
    const lTime = localTime(id, item);
    const localKnown = item || meta[id];
    if (localKnown && lTime >= cloudTime) continue; // ローカルが新しい（または同時刻）

    if (r.kind === "my_word") {
      const idx = myWords.findIndex((w) => w.en === r.key);
      if (r.deleted) {
        if (idx >= 0) myWords.splice(idx, 1);
      } else if (r.payload && r.payload.en) {
        const kept = mapBook(idx >= 0 ? mergeMyWordPair(r.payload, myWords[idx]) : r.payload);
        if (idx >= 0) myWords[idx] = kept;
        else myWords.push(kept);
        if (learnDiff(kept, r.payload)) relabeled.push({ key: r.key, payload: kept, at: new Date(cloudTime + 1).toISOString() });
      }
      changed.my_word = true;
    } else if (r.kind === "note") {
      if (r.deleted || !r.payload?.text) delete notes[r.key];
      else notes[r.key] = String(r.payload.text).slice(0, 80);
      changed.note = true;
    } else if (r.kind === "pack") {
      const on = !r.deleted && r.payload?.enabled !== false;
      packs = packs.filter((p) => p !== r.key);
      if (on) packs.push(r.key);
      changed.pack = true;
    }
    meta[id] = { updatedAt: r.updated_at, deleted: !!r.deleted };
    adopted.push([id, r.updated_at]);
  }

  // ローカルだけにある／ローカルが新しい項目 → アップロード対象
  for (const [id, item] of items) {
    const r = cloud.get(id);
    const lTime = localTime(id, item);
    const cloudTime = r ? Date.parse(r.updated_at ?? 0) || 0 : -1;
    if (!r || lTime > cloudTime) {
      const at = meta[id]?.updatedAt ?? item.payload?.addedAt ?? new Date().toISOString();
      let payload = item.payload;
      // 端末の語が新しくて勝つときも、同じカードなら雲の行の新しい 3 状態と早い lf を端末の語に写してから送る（雲の答えと早い日を消さない。Batch 91・94）。
      // 写す語は localItems と同じ、同じ鍵の最後の語。送る時刻は前のまま
      if (item.kind === "my_word" && r && !r.deleted && r.payload) {
        const kept = mergeMyWordPair(item.payload, r.payload);
        if (kept !== item.payload) {
          let i = myWords.length - 1;
          while (i >= 0 && myWords[i].en !== item.key) i--;
          if (i >= 0) {
            myWords[i] = withLearning(myWords[i], kept);
            payload = myWords[i];
            changed.my_word = true;
          }
        }
      }
      toUpload.push({ user_id: userId, kind: item.kind, key: item.key, payload, deleted: false, updated_at: at });
      if (!meta[id]) meta[id] = { updatedAt: at, deleted: false };
    }
  }

  for (const { key, payload, at } of relabeled) {
    toUpload.push({ user_id: userId, kind: "my_word", key, payload, deleted: false, updated_at: at });
    meta[`my_word:${key}`] = { updatedAt: at, deleted: false };
  }

  if (changed.my_word) writeJson(MY_WORDS_KEY, myWords);
  if (changed.note) writeJson(NOTES_KEY, notes);
  if (changed.pack) writeJson(PACKS_KEY, packs);
  writeJson(META_KEY, meta);
  return { changed, toUpload, adopted };
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

// 戻り値 { failed（送れなかった行: 次の送信で送り直す）, rejected（行の中身で断られた行・上限で確かめられなかった行: 印を付けて待つ） }
async function upsertRows(supabase, rows) {
  const groups = [rows.filter((r) => r.kind !== "day"), dayRejected ? [] : rows.filter((r) => r.kind === "day")];
  const failed = dayRejected ? rows.filter((r) => r.kind === "day") : [];
  const rejected = [];
  let budget = UPLOAD_SPLIT_MAX;
  const send = async (chunk) => {
    try {
      const result = await supabase.from("user_items").upsert(chunk);
      if (result && !result.error) return { ok: true };
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
    for (const half of [chunk.slice(0, mid), chunk.slice(mid)]) {
      if (budget <= 0) {
        rejected.push(...half);
        continue;
      }
      budget--;
      const r = await send(half);
      if (r.ok) continue;
      if (r.rowError) await split(half);
      else failed.push(...half);
    }
  };
  for (const group of groups) {
    for (let i = 0; i < group.length; i += UPLOAD_CHUNK) {
      const chunk = group.slice(i, i + UPLOAD_CHUNK);
      const r = await send(chunk);
      if (r.ok) continue;
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
  return { failed, rejected };
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

// options.now: 今の時刻（ms。待つ間の確かめと印。検査が渡す）
export async function pushUserItems(supabase, userId, { now = Date.now() } = {}) {
  const all = buildDirtyRows(userId);
  if (all.length === 0) return;
  const metaAtStart = getItemMeta(); // 送信中にまた変わった項目（印の時刻が変わった）は dirty に残す
  const due = all.filter((r) => r.kind === "day" || !waiting(metaAtStart[rowId(r)], now)); // 断られて待っている行は送らない（送る待ちには残る）
  const days = await mergeDayRowsWithCloud(supabase, due.filter((r) => r.kind === "day"));
  const { send } = prepareRows([...due.filter((r) => r.kind !== "day"), ...days]); // 鍵に送り先が受け付けない字がある行は送らない（送る待ちに残る）
  if (send.length === 0) return;
  const { failed, rejected } = await upsertRows(supabase, send); // ベストエフォート
  const notSent = new Set([...failed, ...rejected].map(rowId));
  const metaNow = getItemMeta();
  const sentIds = new Set(
    send
      .map(rowId)
      .filter((id) => !notSent.has(id) && metaNow[id]?.updatedAt === metaAtStart[id]?.updatedAt)
  );
  writeJson(DIRTY_KEY, [...getDirtyItems()].filter((id) => !sentIds.has(id))); // 送れた分だけ dirty から外す（読めなかった day は残る）
  markRejected(rejected, now);
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

// 取り込みの後で、送る待ち（dirty）から外す項目: 取り込みで送れた行（その後に変わっていない: 印の時刻が送った行と同じ）と、
// クラウドの方が新しくて取り込んだ項目（その後に変わっていない）。送っている間に直した項目は残り、次の送信で新しい版を送る
function clearSettledDirty(sent, adopted) {
  if (sent.length === 0 && adopted.length === 0) return;
  const meta = getItemMeta();
  const settled = new Set();
  for (const r of sent) if (meta[rowId(r)]?.updatedAt === r.updated_at) settled.add(rowId(r));
  for (const [id, at] of adopted) if (meta[id]?.updatedAt === at) settled.add(id);
  const dirty = [...getDirtyItems()];
  const left = dirty.filter((id) => !settled.has(id));
  if (left.length !== dirty.length) writeJson(DIRTY_KEY, left);
}

// options.deferPacksEvent: true なら spelldash:packs を投げない（呼び出し側が語の読み直しを 1 回にまとめる）。options.now: 今の時刻（ms。検査が渡す）
export async function pullUserItems(supabase, userId, options = {}) {
  const now = options.now ?? Date.now();
  const read = await readAllRows(supabase, "user_items", ["kind", "key"]);
  if (!read.ok) {
    // 表がまだ無い（Batch 86）: このページに知らせる（マイ単語帳の画面の 1 行）。送り方は前のまま
    if (isMissingTable(read)) {
      noteTable(true);
      return { changed: null, missing: true };
    }
    return { changed: null };
  }
  noteTable(false);
  const { changed, toUpload, adopted } = mergeCloudItems(read.rows, userId);
  // 断られて待っている行は送らない（ページを開くたびに同じ行で断られ続けない）。鍵に送り先が受け付けない字がある行も送らない
  const meta = getItemMeta();
  const { send } = prepareRows(toUpload.filter((r) => r.kind === "day" || !waiting(meta[rowId(r)], now)));
  let sent = [];
  if (send.length > 0) {
    // 送れなかった行は次回の pushSync で再送する（dirty に積む）。行の中身で断られた行は印を付けて待つ
    const { failed, rejected } = await upsertRows(supabase, send);
    const notSent = new Set([...failed, ...rejected].map(rowId));
    sent = send.filter((r) => !notSent.has(rowId(r)));
    for (const r of failed) touchItem(r.kind, r.key, false, r.updated_at);
    markRejected(rejected, now);
  }
  clearSettledDirty(sent, adopted);
  if (changed.my_word) window.dispatchEvent(new CustomEvent("spelldash:mywords"));
  if (changed.note) window.dispatchEvent(new CustomEvent("spelldash:notes"));
  if (changed.pack && !options.deferPacksEvent) window.dispatchEvent(new CustomEvent("spelldash:packs", { detail: { synced: true } }));
  return { changed };
}
