// ===== 自分のデータの端末間同期（マイ単語帳・単語メモ・追加した分野パック） =====
//
// 学習記録（word_progress）は以前から同期しているが、マイ単語帳／メモ／パックの選択は端末ローカルだけだった。
// Supabase の user_items テーブル（docs/SQL_USER_ITEMS.md、作成は創業者側）に
//   kind: "my_word" | "note" | "pack"、key、payload(jsonb)、deleted、updated_at
// の1行1項目で保存し、項目ごとに「新しい方が勝つ」でマージする。削除は deleted=true の墓標で伝える。
// テーブルが無い／未ログインなら何もしない（Local First）。
//
// 変更の記録: 各モジュールが書き込み時に touchItem() を呼ぶ → meta（更新時刻）と dirty（未送信）に積む。

const META_KEY = "spelldash_user_items_meta"; // { "kind:key": { updatedAt, deleted } }
const DIRTY_KEY = "spelldash_user_items_dirty"; // ["kind:key", ...]
const MY_WORDS_KEY = "spelldash_my_words";
const NOTES_KEY = "spelldash_word_notes";
const PACKS_KEY = "spelldash_packs";

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
  return items;
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
// 戻り値: { changed: {my_word,note,pack} の変更有無, toUpload: クラウドに無い／古いローカル項目 }

export function mergeCloudItems(rows, userId = null) {
  const meta = getItemMeta();
  const items = localItems();
  const changed = { my_word: false, note: false, pack: false };
  const toUpload = [];
  const cloud = new Map();
  for (const r of rows ?? []) {
    if (r && r.kind && r.key) cloud.set(`${r.kind}:${r.key}`, r);
  }

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

// ---- Supabase との送受信（sync.js から呼ばれる。テーブル未作成・失敗は静かにスキップ） ----

export async function pushUserItems(supabase, userId) {
  const rows = buildDirtyRows(userId);
  if (rows.length === 0) return;
  try {
    const { error } = await supabase.from("user_items").upsert(rows);
    if (!error) clearDirtyItems();
  } catch {
    // ベストエフォート
  }
}

export async function pullUserItems(supabase, userId) {
  let rows = null;
  try {
    const result = await supabase.from("user_items").select("*");
    if (!result || result.error || !Array.isArray(result.data)) return { changed: null };
    rows = result.data;
  } catch {
    return { changed: null };
  }
  const { changed, toUpload } = mergeCloudItems(rows, userId);
  if (toUpload.length > 0) {
    try {
      for (let i = 0; i < toUpload.length; i += 500) {
        await supabase.from("user_items").upsert(toUpload.slice(i, i + 500));
      }
    } catch {
      // 次回の pushSync で再送される（dirty には入っていないので、失敗時は touch しておく）
      for (const r of toUpload) touchItem(r.kind, r.key, false, r.updated_at);
    }
  }
  if (changed.my_word) window.dispatchEvent(new CustomEvent("spelldash:mywords"));
  if (changed.note) window.dispatchEvent(new CustomEvent("spelldash:notes"));
  if (changed.pack) window.dispatchEvent(new CustomEvent("spelldash:packs", { detail: { synced: true } }));
  return { changed };
}
