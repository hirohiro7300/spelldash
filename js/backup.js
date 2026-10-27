import { forgetWordStats, getWordStats, loadLearnStateDeps, learnStateSource, migrateRestored } from "./storage.js";
import { isQuotaError } from "./storageGuard.js";
import { countLearnStates } from "./learnState.js";
import { RANK_PEAK_KEY, parseRankPeak, rankFor } from "./rank.js";
import { forgetMasteryMeta } from "./masteryMeta.js";
import { forgetMemoryCheck } from "./memoryCheck.js";
import { forgetMemoryWords } from "./memoryWords.js";

// ===== 学習データのバックアップ / 復元 =====
//
// Local First のため、未ログインの人のデータは端末にしかない。
// 端末の買い替え・ブラウザのデータ消去に備えて、spelldash_* をまとめてJSONで持ち出せるようにする。
// 復元は「上書き」（マージはしない。単純で説明しやすい方を選ぶ）。

const PREFIX = "spelldash_";
export const BACKUP_VERSION = 1;

// 端末固有・一時的なものは含めない（xp_synced は「この端末が最後にクラウドと一致した XP」。別の端末に持ち込むと差分がずれる）。
// タイピング練習の種類・タイピングゲームのコースの記憶（この端末の開き方の好み。Batch 65 P1・P2）も入れない。
// ログアウトの時刻と 3 状態の初めの埋めの印（この端末とアカウントの同期の印。js/sync.js。Batch 78）も入れない。
// 最高到達ランク（spelldash_rank_peak）と語ごとの 3 状態の欄（spelldash_word_stats の ls・lsd・lsAt）は入れる（js/rank.js・js/learnState.js）
const EXCLUDE = new Set(["spelldash_dirty_words", "spelldash_synced_this_session", "spelldash_xp_synced", "spelldash_xp_write", "spelldash_owner", "spelldash_typing_kind", "spelldash_typing_game_course", "spelldash_logout_at", "spelldash_learn_filled"]);
// 復元のときに必ず消すもの（復元した記録の持ち主と、クラウドとの差分の基準は分からないので、次の同期を初回の扱いにする）
const RESET_ON_RESTORE = ["spelldash_xp_synced", "spelldash_xp_write", "spelldash_owner", "spelldash_logout_at", "spelldash_learn_filled"];
// このタブの同期の印（sessionStorage。js/sync.js clearSyncedFlag と同じ 4 つ。sync.js は backup.js を import するので、ここからは直に消す）。
// ログイン中のタブで戻したら消す: 残すと、再読み込みの後も取り込みを飛ばし、全部送信待ちにした古い行でクラウドの新しい行を上書きしていた
// （Batch 78 の前からの不具合: verify-dataloss m2）。消せば、次の取り込みで語ごとに新しい方を採る
const SYNC_FLAGS = ["spelldash_synced_this_session", "spelldash_pulled_this_session", "spelldash_sync_done_this_session", "spelldash_pull_started_at"];

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

// spelldash_* の今の中身（復元が途中で失敗したときに書き戻す控え。メモリーだけ）
function snapshotRecords() {
  const out = new Map();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX)) out.set(key, localStorage.getItem(key));
  }
  return out;
}

// 控えに戻す: 書きかけの spelldash_* をいったん全部消してから書く（前は入っていた中身なので、消した後なら入る）
function restoreSnapshot(snapshot) {
  for (const key of [...snapshotRecords().keys()]) localStorage.removeItem(key);
  for (const [key, value] of snapshot) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 1 つ書けなくても残りは戻す
    }
  }
}

// メモリーに持っている中身を捨てる（語の記録・習熟度の速さの基準と集計・記録の質。古い中身が、書き換えた保存を後から上書きしない）
function forgetMemory() {
  forgetWordStats(); // js/storage.js（書きかけも）
  forgetMasteryMeta(); // js/masteryMeta.js
  forgetMemoryCheck(); // spelldash_memory_check（js/memoryCheck.js）
  forgetMemoryWords(); // spelldash_memory_words（js/memoryWords.js）
}

// 復元: spelldash_* を一度消してから書き戻す（上書き）。版 6 の記録は、返る前に 3 状態の欄を移して版 7 にする（js/storage.js migrateRestored）。
// 途中で書けなかった（容量）ら、書きかけを消して前の記録に戻し、投げる（前の記録を消したまま半分で止めない。前からの不具合: verify-dataloss m1）。
// 最高到達ランクは、復元の前の値・バックアップの値・戻した記録の今の数の段のうち大きい方を残す（下げない: 決定 §5。dataloss d8・創業者に送った既定）
export function applyBackup(obj) {
  const summary = inspectBackup(obj);
  const peakBefore = parseRankPeak(localStorage.getItem(RANK_PEAK_KEY));
  const snapshot = snapshotRecords();
  try {
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
  } catch (error) {
    restoreSnapshot(snapshot);
    forgetMemory();
    throw new Error(isQuotaError(error) ? "端末の空きが足りず、復元できなかった。今の記録はそのまま。" : "復元できなかった。今の記録はそのまま。");
  }
  forgetMemory();
  migrateRestored(); // 版 6 の記録はその場で版 7 に（容量で書けなければ版 6 のまま。js/storage.js）
  // 復元した単語はクラウド側にも送れるよう全部dirtyにする（ログイン時のみ意味を持つ）
  try {
    const ids = Object.keys(JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}"));
    localStorage.setItem("spelldash_dirty_words", JSON.stringify(ids));
  } catch {
    // 無視
  }
  try {
    for (const key of SYNC_FLAGS) sessionStorage.removeItem(key);
  } catch {
    // sessionStorage が使えない環境では何もしない
  }
  keepRankPeak(peakBefore, parseRankPeak(obj.data[RANK_PEAK_KEY]));
  return summary;
}

// 復元の後の最高到達ランク = max（前の値, バックアップの値, 戻した記録の覚えた語数の段）。今の数は、材料（公開の語の表）が読めているときだけ
// （readBackupFile が読んでおく。読めなければ前とバックアップの大きい方）。どれも無ければ書かない
function keepRankPeak(before, backup) {
  let now = null;
  const source = learnStateSource();
  if (source) {
    const counts = countLearnStates(getWordStats(), source.vocab, source.isDone);
    now = rankFor(counts.learned, counts.total);
  }
  const peak = Math.max(before ?? -1, backup ?? -1, now ?? -1);
  if (peak < 0) return;
  try {
    localStorage.setItem(RANK_PEAK_KEY, String(peak));
  } catch {
    // 書けなければ戻した値のまま（次の学習状況の表示で今の数から上げる）
  }
}

// ===== この端末の記録を消す（別のアカウントでログインしたとき。js/sync.js initialSync が呼ぶ） =====
// applyBackup と同じく spelldash_* を消す。残すのは端末の設定（人の記録ではないもの）だけ:
//   theme（表示の色）・audio（音声の設定）・osk（専用キーボード）・after_correct（正解のあとの長さ）・list_compact／setup_open／stats_tab／trend_range／weak_only（画面の開き方）、
//   typing_kind／typing_game_course（タイピング練習の種類・タイピングゲームのコースの記憶。この端末の開き方の好みで、バックアップにも入れない。Batch 65）、
//   installed（ホーム画面に追加の案内）・onboarded（この端末でトップページを見た）・schema_version（保存形式の版。消すと移行が走り直す）、
//   test_*（E2E のスタブのログイン状態）
// 消すもの（主なもの）: word_stats・xp・xp_synced・streak・best_score・best_by_category・battle・pending_battles・study_mix・
//   growth_log・daily_set・daily・sets_total・veteran・course・category・mode・packs・my_words・word_notes・user_items_meta／dirty・
//   dirty_words・session・session_log・mission・placement(_note)・first_sight・level_boost(_note)・tutorial・typing_stats・key_miss・
//   word_ai・activity・feedback_queue・plan・display_name・login_nudge・week_goal・set_size・genre・owner・mastery_meta・memory_check・
//   memory_words(_corrupt)・rank_peak（最高到達ランク）・logout_at・learn_filled（Batch 78）
const KEEP_ON_CLEAR = new Set([
  "spelldash_theme",
  "spelldash_audio",
  "spelldash_osk",
  "spelldash_after_correct",
  "spelldash_list_compact",
  "spelldash_setup_open",
  "spelldash_stats_tab",
  "spelldash_trend_range",
  "spelldash_weak_only",
  "spelldash_installed",
  "spelldash_onboarded",
  "spelldash_schema_version",
  "spelldash_typing_kind",
  "spelldash_typing_game_course"
]);

export function clearLocalRecords() {
  const toRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX) || KEEP_ON_CLEAR.has(key) || key.startsWith("spelldash_test_")) continue;
    toRemove.push(key);
  }
  toRemove.forEach((key) => localStorage.removeItem(key));
  forgetWordStats(); // 語の記録を直に消した。持っている中身と書きかけを捨てる（js/storage.js）
  forgetMasteryMeta(); // spelldash_mastery_meta も消した（KEEP_ON_CLEAR に入れない）。メモリーの基準も捨てる
  forgetMemoryCheck(); // spelldash_memory_check も消した（KEEP_ON_CLEAR に入れない）。メモリーの集計も捨てる
  forgetMemoryWords(); // spelldash_memory_words（と壊れた値の写し）も消した。メモリーの語ごとの欄と書きかけも捨てる
  return toRemove.length;
}

// 読むあいだに、復元で使う材料（公開の語の表と旧の判定。js/storage.js loadLearnStateDeps）も読んでおく: applyBackup がその場で版 7 にし、
// 最高到達ランクを戻した記録の今の数と比べられる（applyBackup は確認の窓と同じタスクで走るので、そこでは待てない）。
// 材料が読めなくても復元は止めない（版 7 の段は後から: js/storage.js）
export function readBackupFile(file) {
  const deps = loadLearnStateDeps();
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
  }).then((obj) => deps.then(() => obj));
}
