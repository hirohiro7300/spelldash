// A と B の記録（端末とクラウド）と、漏れを見分ける目印。
// A の記録は A にしか無い値にする（語・XP・最高点・Battle・連続日数・マイ単語帳・メモ・日ごとの記録・今日の活動・送信待ちの Battle・表示名）。
// B は新しいタブでログインするだけで、この検査の中では学習しない。だから B の名前で送られる物は B のクラウドの値か既定の値だけのはず。
export const USERS = {
  A: { id: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "learner-a@example.test", label: "A" },
  B: { id: "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "learner-b@example.test", label: "B" }
};

// A だけが答えた語（旧い本番の基本カテゴリ daily の頭から）。B だけの語（business の頭から）。どちらの木の教材にもある id
export const A_WORDS = ["english-hello", "english-goodbye", "english-welcome", "english-thanks", "english-please", "english-sorry", "english-excuse", "english-meet"];
export const B_WORDS = ["english-business", "english-customer", "english-marketing", "english-strategy", "english-negotiate", "english-efficient"];

export const A_MARK = {
  xp: 48213, best: 9876, streak: 47, battleWins: 37, battleRp: 1777, learnedToday: 777, masteredToday: 77, studyCorrect: 333,
  myWord: "aonlyzephyr", note: "A-ONLY-NOTE-7f3", name: "A-ONLY-NAME", battleTag: "A-ONLY-BATTLE"
};
export const B_MARK = { xp: 1200, best: 111, streak: 3, battleWins: 1, battleRp: 1000, learnedDay: 5, myWord: "bonlyquartz", note: "B-ONLY-NOTE-2c9" };

// 旧いタブ（直前の本番のコード）。どれも A でログインした同じ端末のタブ:
//   old-live    ホームで学習中（ログインのリンクを開いたタブ。URL は "/#"）→ 裏へ
//   old-frozen  ホームで学習中に凍らせる（2・3 段のあいだスクリプトを止める）
//   old-offline 学習状況のページで通信を切る（2・3 段のあいだ）
//   old-visible ホームを開いたまま、見えたまま（配信の前にトークンの更新を始め、受け口が移行の後まで答えを止める）
//   old-sw      ホーム（URL に印も # も無い）→ 裏へ。新しい木の sw.js が読み直すなら読み直される（読み直しの道の確かめ）
export const OLD_TABS = ["old-live", "old-frozen", "old-offline", "old-visible", "old-sw"];
// 読み直しの届かないタブ（lib/server.mjs の oldtab-keep）: 凍った・通信の切れた・見えたまま更新を待つタブは、新しい sw.js が読み直そうとしても旧いコードのまま残す
export const KEEP_TABS = ["old-frozen", "old-offline", "old-visible"];
export const TAB_PAGES = { "old-live": "/", "old-frozen": "/?oldtab-keep=old-frozen", "old-offline": "/stats.html?oldtab-keep=old-offline", "old-visible": "/?oldtab-keep=old-visible", "old-sw": "/" };
// そのページで旧いコードが読む、同期と認証のモジュール（1 段の確かめ）
export const TAB_MODULES = { "old-live": ["/js/sync.js", "/js/auth.js", "/js/supabase.js"], "old-frozen": ["/js/sync.js", "/js/auth.js", "/js/supabase.js"], "old-offline": ["/js/supabase.js"], "old-visible": ["/js/sync.js", "/js/auth.js", "/js/supabase.js"], "old-sw": ["/js/sync.js", "/js/auth.js", "/js/supabase.js"] };

const DAY = 86400000;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function stat(i, now) {
  const at = new Date(now - (2 + (i % 3)) * DAY).toISOString();
  return { playCount: 3, correctCount: 2, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 1, mastered: false, masteredAt: null, lastPlayed: at, nextReviewAt: new Date(now + 3 * DAY).toISOString(), lastRecallSuccessAt: at, lastRecallFailAt: null, dailyLearningDate: null, dailyLearningStage: 0, srsAdvancedOn: null, history: [1, 0, 1] };
}

function row(userId, wordId, s) {
  return {
    user_id: userId, word_id: wordId, play_count: s.playCount, correct_count: s.correctCount, typing_miss: s.typingMiss, recall_fail: s.recallFail,
    clean_correct_streak: s.cleanCorrectStreak, mastered: s.mastered, mastered_at: s.masteredAt, last_played: s.lastPlayed, next_review_at: s.nextReviewAt,
    last_recall_fail_at: s.lastRecallFailAt, last_recall_success_at: s.lastRecallSuccessAt, daily_learning_date: s.dailyLearningDate,
    daily_learning_stage: s.dailyLearningStage, srs_advanced_on: s.srsAdvancedOn, updated_at: s.lastPlayed
  };
}

// 旧い本番（スキーマ 6）の形の、A の端末の localStorage（A はこの端末で前に同期した: spelldash_owner = A）
export function aLocalStorage(now = Date.now()) {
  const today = ymd(new Date(now));
  const stats = Object.fromEntries(A_WORDS.map((id, i) => [id, stat(i, now)]));
  const addedAt = new Date(now - 5 * DAY).toISOString();
  return {
    spelldash_schema_version: "6",
    spelldash_onboarded: "1",
    spelldash_placement: "done",
    spelldash_category: "daily",
    spelldash_owner: USERS.A.id,
    spelldash_word_stats: JSON.stringify(stats),
    spelldash_xp: String(A_MARK.xp),
    spelldash_xp_synced: String(A_MARK.xp),
    spelldash_best_score: String(A_MARK.best),
    spelldash_streak: JSON.stringify({ current: A_MARK.streak, best: A_MARK.streak + 5, last: ymd(new Date(now - DAY)), shields: 0 }),
    spelldash_battle: JSON.stringify({ rp: A_MARK.battleRp, wins: A_MARK.battleWins, losses: 11, draws: 2, currentWinStreak: 4, bestWinStreak: 9, updatedAt: new Date(now - 3 * DAY).toISOString() }),
    spelldash_pending_battles: JSON.stringify([{ mode: "battle", result: "win", opponent: A_MARK.battleTag, score: 4242, rp_change: 12, created_at: new Date(now - DAY).toISOString() }]),
    spelldash_my_words: JSON.stringify([{ en: A_MARK.myWord, ja: "Aだけの語", addedAt }]),
    spelldash_word_notes: JSON.stringify({ [A_WORDS[0]]: A_MARK.note }),
    spelldash_user_items_meta: JSON.stringify({ [`my_word:${A_MARK.myWord}`]: { updatedAt: addedAt, deleted: false }, [`note:${A_WORDS[0]}`]: { updatedAt: addedAt, deleted: false } }),
    spelldash_growth_log: JSON.stringify([{ date: today, learned: A_MARK.learnedToday, mastered: A_MARK.masteredToday, active: true, v: 2 }]),
    spelldash_activity: JSON.stringify({ date: today, studyCorrect: A_MARK.studyCorrect, challengeRuns: 0, battleRuns: 0, dailyDone: false }),
    spelldash_display_name: A_MARK.name
  };
}

// クラウド（にせの表）の初めの中身: A の語・進み・品と、B の語・進み・品
export function cloudSeed(now = Date.now()) {
  const A = USERS.A.id;
  const B = USERS.B.id;
  const today = ymd(new Date(now));
  const yesterday = ymd(new Date(now - DAY));
  const old = new Date(now - 4 * DAY).toISOString();
  return {
    word_progress: [...A_WORDS.map((id, i) => row(A, id, stat(i, now))), ...B_WORDS.map((id, i) => row(B, id, stat(i + 1, now)))],
    user_progress: [
      { user_id: A, xp: A_MARK.xp, level: 40, streak: { current: A_MARK.streak, best: A_MARK.streak + 5, last: yesterday }, best_score: A_MARK.best, selected_category: "daily", selected_mode: "study", battle_rp: A_MARK.battleRp, battle_wins: A_MARK.battleWins, battle_losses: 11, battle_draws: 2, battle_current_win_streak: 4, battle_best_win_streak: 9, study_familiar_ratio: 0.3, updated_at: old },
      { user_id: B, xp: B_MARK.xp, level: 8, streak: { current: B_MARK.streak, best: 9, last: yesterday }, best_score: B_MARK.best, selected_category: "business", selected_mode: "study", battle_rp: B_MARK.battleRp, battle_wins: B_MARK.battleWins, battle_losses: 1, battle_draws: 0, battle_current_win_streak: 0, battle_best_win_streak: 1, study_familiar_ratio: 0.3, updated_at: old }
    ],
    user_items: [
      { user_id: A, kind: "my_word", key: A_MARK.myWord, payload: { en: A_MARK.myWord, ja: "Aだけの語" }, deleted: false, updated_at: old },
      { user_id: A, kind: "note", key: A_WORDS[0], payload: { text: A_MARK.note }, deleted: false, updated_at: old },
      { user_id: A, kind: "day", key: today, payload: { learned: A_MARK.learnedToday, mastered: A_MARK.masteredToday, active: true, set: false, sets: 0 }, deleted: false, updated_at: old },
      { user_id: B, kind: "my_word", key: B_MARK.myWord, payload: { en: B_MARK.myWord, ja: "Bだけの語" }, deleted: false, updated_at: old },
      { user_id: B, kind: "note", key: B_WORDS[0], payload: { text: B_MARK.note }, deleted: false, updated_at: old },
      { user_id: B, kind: "day", key: yesterday, payload: { learned: B_MARK.learnedDay, mastered: 1, active: true, set: false, sets: 0 }, deleted: false, updated_at: old }
    ],
    profiles: [
      { user_id: A, display_name: A_MARK.name, avatar_url: null, audio_mode: "auto", preferred_accent: "us" },
      { user_id: B, display_name: "learner-b", avatar_url: null, audio_mode: "auto", preferred_accent: "us" }
    ]
  };
}
