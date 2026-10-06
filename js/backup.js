// ===== 学習データのバックアップ / 復元 =====
//
// Local First のため、未ログインの人のデータは端末にしかない。
// 端末の買い替え・ブラウザのデータ消去に備えて、spelldash_* をまとめてJSONで持ち出せるようにする。
// 復元は「上書き」（マージはしない。単純で説明しやすい方を選ぶ）。

const PREFIX = "spelldash_";
export const BACKUP_VERSION = 1;

// 端末固有・一時的なものは含めない（xp_synced は「この端末が最後にクラウドと一致した XP」。別の端末に持ち込むと差分がずれる）
const EXCLUDE = new Set(["spelldash_dirty_words", "spelldash_synced_this_session", "spelldash_xp_synced", "spelldash_owner"]);
// 復元のときに必ず消すもの（復元した記録の持ち主と、クラウドとの差分の基準は分からないので、次の同期を初回の扱いにする）
const RESET_ON_RESTORE = ["spelldash_xp_synced", "spelldash_owner"];

export function buildBackup() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX) || EXCLUDE.has(key)) continue;
    data[key] = localStorage.getItem(key);
  }
  return { app: "SpellDash", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data };
}

export function backupFileName(date = new Date()) {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  return `spelldash-backup-${ymd}.json`;
}

export function downloadBackup() {
  const json = JSON.stringify(buildBackup(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backupFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return json.length;
}

// バックアップの中身を検証して要約を返す（適用はしない）
export function inspectBackup(obj) {
  if (!obj || typeof obj !== "object" || obj.app !== "SpellDash" || !obj.data || typeof obj.data !== "object") {
    throw new Error("SpellDashのバックアップファイルではありません。");
  }
  if (Number(obj.version) > BACKUP_VERSION) {
    throw new Error("新しいバージョンのバックアップです。アプリを再読み込みしてから試してください。");
  }
  let words = 0;
  try {
    words = Object.keys(JSON.parse(obj.data.spelldash_word_stats || "{}")).length;
  } catch {
    words = 0;
  }
  const keys = Object.keys(obj.data).filter((k) => k.startsWith(PREFIX));
  return { words, keys: keys.length, exportedAt: obj.exportedAt ?? null, xp: Number(obj.data.spelldash_xp) || 0 };
}

// 復元: spelldash_* を一度消してから書き戻す（上書き）
export function applyBackup(obj) {
  const summary = inspectBackup(obj);
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX) && !EXCLUDE.has(key)) toRemove.push(key);
  }
  toRemove.forEach((key) => localStorage.removeItem(key));
  RESET_ON_RESTORE.forEach((key) => localStorage.removeItem(key));
  for (const [key, value] of Object.entries(obj.data)) {
    if (!key.startsWith(PREFIX) || EXCLUDE.has(key) || typeof value !== "string") continue;
    localStorage.setItem(key, value);
  }
  // 復元した単語はクラウド側にも送れるよう全部dirtyにする（ログイン時のみ意味を持つ）
  try {
    const ids = Object.keys(JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}"));
    localStorage.setItem("spelldash_dirty_words", JSON.stringify(ids));
  } catch {
    // 無視
  }
  return summary;
}

// ===== この端末の記録を消す（別のアカウントでログインしたとき。js/sync.js initialSync が呼ぶ） =====
// applyBackup と同じく spelldash_* を消す。残すのは端末の設定（人の記録ではないもの）だけ:
//   theme（表示の色）・audio（音声の設定）・osk（専用キーボード）・list_compact／setup_open／stats_tab／trend_range／weak_only（画面の開き方）、
//   installed（ホーム画面に追加の案内）・onboarded（この端末でトップページを見た）・schema_version（保存形式の版。消すと移行が走り直す）、
//   test_*（E2E のスタブのログイン状態）
// 消すもの（主なもの）: word_stats・xp・xp_synced・streak・best_score・best_by_category・battle・pending_battles・study_mix・
//   growth_log・daily_set・daily・sets_total・veteran・course・category・mode・packs・my_words・word_notes・user_items_meta／dirty・
//   dirty_words・session・session_log・mission・placement(_note)・first_sight・level_boost(_note)・tutorial・typing_stats・key_miss・
//   word_ai・activity・feedback_queue・plan・display_name・login_nudge・week_goal・set_size・genre・owner
const KEEP_ON_CLEAR = new Set([
  "spelldash_theme",
  "spelldash_audio",
  "spelldash_osk",
  "spelldash_list_compact",
  "spelldash_setup_open",
  "spelldash_stats_tab",
  "spelldash_trend_range",
  "spelldash_weak_only",
  "spelldash_installed",
  "spelldash_onboarded",
  "spelldash_schema_version"
]);

export function clearLocalRecords() {
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX) || KEEP_ON_CLEAR.has(key) || key.startsWith("spelldash_test_")) continue;
    toRemove.push(key);
  }
  toRemove.forEach((key) => localStorage.removeItem(key));
  return toRemove.length;
}

export function readBackupFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)));
      } catch {
        reject(new Error("ファイルを読み取れませんでした（JSONではありません）。"));
      }
    };
    reader.onerror = () => reject(new Error("ファイルを読み取れませんでした。"));
    reader.readAsText(file);
  });
}
