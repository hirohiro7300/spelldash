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
// 送り方（Batch 85。docs/SPEC_MY_WORDS.md §14.3）: 送る写しの字を整え（端末の保存は書き換えない）、行の中身で断られた組は半分ずつ送り直し、
// 1 行だけで断られた行は meta に印（failAt・failFor）を付けて、その行が変わるか UPLOAD_RETRY_MS が過ぎるまで送らない（下の「送る形と送り方」）。

const META_KEY = "spelldash_user_items_meta"; // { "kind:key": { updatedAt, deleted } }
const DIRTY_KEY = "spelldash_user_items_dirty"; // ["kind:key", ...]
const MY_WORDS_KEY = "spelldash_my_words";
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

// ---- クラウドの行をローカルへ反映（項目ごとに新しい方が勝つ） ----
// 戻り値: { changed: {my_word,note,pack,day} の変更有無, toUpload: クラウドに無い／古いローカル項目 }

export function mergeCloudItems(rows, userId = null) {
  const meta = getItemMeta();
  const changed = { my_word: false, note: false, pack: false, day: false };
  const toUpload = [];
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

  const localTime = (id, item) => Date.parse(meta[id]?.updatedAt ?? item?.payload?.addedAt ?? 0) || 0;

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
        if (idx >= 0) myWords[idx] = r.payload;
        else myWords.push(r.payload);
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
  }

  // ローカルだけにある／ローカルが新しい項目 → アップロード対象
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

  if (changed.my_word) writeJson(MY_WORDS_KEY, myWords);
  if (changed.note) writeJson(NOTES_KEY, notes);
  if (changed.pack) writeJson(PACKS_KEY, packs);
  writeJson(META_KEY, meta);
  return { changed, toUpload };
}

// ---- 送る形と送り方（Batch 85。docs/SPEC_MY_WORDS.md §14.3） ----
// 1. 字を整える: 送る行の payload の文字（入れ子・鍵の名前も）から制御文字（タブ・改行・復帰のほか: U+0000〜U+0008・U+000B・U+000C・
//    U+000E〜U+001F・U+007F〜U+009F）を落とし、組になっていないサロゲートを U+FFFD に替える。送り先の表は NUL と組になっていないサロゲートを
//    受け付けず、1 行でも入ると同じ要求の行がどれも届かなかった（前の版のバックアップ・ほかの端末から届いた行・80 字で切れたメモの絵文字の半分）。
//    整えるのは送る写しだけ（端末の保存は書き換えない。端末では前の字のまま読める）。向きを変える字は送れるので残す（入れる道では断る: js/myWordsCore.js）
// 2. 鍵に整える字がある行（とても古い場面カードの鍵など）は送らない: 鍵を替えると別の項目になる（もう一方の端末で 2 つになる）。
//    端末にだけ残り、送る待ちにも残る（要求はしない）
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
const SEND_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const LONE_SURROGATES = /[\uD800-\uDFFF]/gu; // u フラグ: 組になったサロゲート（絵文字）には当たらない

const rowId = (r) => `${r.kind}:${r.key}`;

// 送る文字を整える
export function cleanSendText(text) {
  return String(text).replace(SEND_CONTROLS, "").replace(LONE_SURROGATES, "\uFFFD");
}

// 送る値を整えた写し（文字・配列・入れ子の物と鍵の名前。数・真偽・null はそのまま）。元の値は変えない
export function cleanSendValue(value) {
  if (typeof value === "string") return cleanSendText(value);
  if (Array.isArray(value)) return value.map((v) => cleanSendValue(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanSendText(k), cleanSendValue(v)]));
  return value;
}

// 送る写し（send）と、鍵に整える字があって送らない行（keep）
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
  const { send } = prepareRows([...due.filter((r) => r.kind !== "day"), ...days]); // 鍵に送れない字がある行は送らない（送る待ちに残る）
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

// options.deferPacksEvent: true なら spelldash:packs を投げない（呼び出し側が語の読み直しを 1 回にまとめる）。options.now: 今の時刻（ms。検査が渡す）
export async function pullUserItems(supabase, userId, options = {}) {
  const now = options.now ?? Date.now();
  let rows = null;
  try {
    const result = await supabase.from("user_items").select("*");
    if (!result || result.error || !Array.isArray(result.data)) return { changed: null };
    rows = result.data;
  } catch {
    return { changed: null };
  }
  const { changed, toUpload } = mergeCloudItems(rows, userId);
  // 断られて待っている行は送らない（ページを開くたびに同じ行で断られ続けない）。鍵に送れない字がある行も送らない
  const meta = getItemMeta();
  const { send } = prepareRows(toUpload.filter((r) => r.kind === "day" || !waiting(meta[rowId(r)], now)));
  if (send.length > 0) {
    // 送れなかった行は次回の pushSync で再送する（dirty に積む）。行の中身で断られた行は印を付けて待つ
    const { failed, rejected } = await upsertRows(supabase, send);
    for (const r of failed) touchItem(r.kind, r.key, false, r.updated_at);
    markRejected(rejected, now);
  }
  if (changed.my_word) window.dispatchEvent(new CustomEvent("spelldash:mywords"));
  if (changed.note) window.dispatchEvent(new CustomEvent("spelldash:notes"));
  if (changed.pack && !options.deferPacksEvent) window.dispatchEvent(new CustomEvent("spelldash:packs", { detail: { synced: true } }));
  return { changed };
}
