// lib/analyze.mjs の判定だけを、作った記録で確かめる（ブラウザは使わない。数秒）。
//   node tests/oldtab/test-analyze.mjs
// 見ること:
//   - B の名前の書き込みは B のクラウドの初めの値と列ごとに比べる（A の連続日数・連続日数の 3→4・最高点・品・消した印・B の語の数を変えた行を見つける）
//   - 新しいコードが書き直す列（level・study_familiar_ratio・selected_*・updated_at）と、B の今日の日の行（B の語の数まで）は漏れにしない
//   - 旧いコードのタブが B として動いたら（読み・更新・通信断で届かなかった要求・getSession・旧い認証の鍵）漏れ。読み直された後のタブは数えない
//   - 途中で落ちた回は PASS にしない（漏れを見つけていても INVALID）
//   - A の記録の後退（配信の後の A の名前の書き込みと表の最後の A の行）: 語の回数・最高点・連続日数・Battle・今日の活動・日ごとの記録・消した印・表示名（判定 LOSS）
//   - A が答えた公開の語は、回数が A の値と同じときだけ「A の語」（B が学んだだけの行を A の語と言わない）
//   - 旧いコードのまま残った old-live・old-frozen のタブごとの答え・新しいコードの開き直し（4 段の後・閉じた後）が無ければ 5 段を通ったと言わない
//   - 旧い画面の答えは、タブの中の書き込みの記録（lib/storageTap.mjs）で答えごとに見る: そのタブの配信の前の文書が、答えの窓に、答えた語か答えた後に出た
//     次の語の記録を書いた。書き込みが見えなければ（端末の語の記録が変わっていても）通さない。記録の無い古い記録だけは前の決まり（端末の変化）で見る
//   - orphans のある木: 4 段より後に旧いコードのタブが書いた語の記録が orphans に 1 つも届かない・orphans を読めない・答えを数えたタブの最後の書き込みが
//     届かないときは通さない。答えの窓は次の答えの打ち始めで切り、画面が次の語へ進まなかった答えは数えない
//   - A へ戻る段（DECISION5 の 1）: 旧いタブの学習が A の領域に足される（置き換え・足りない・2 度・2 回目に増える・送信待ち・A のクラウド・
//     最後に答えた時刻・学習状況の画面）、B とゲストの領域に入らない、3 状態の決まり（report・keep・関数）、古い記録と分離の前の木には無い
import { analyze, verdictOf } from "./lib/analyze.mjs";
import { USERS, cloudSeed } from "./lib/seed.mjs";

const A = USERS.A.id;
const B = USERS.B.id;
const seedAt = Date.parse("2026-10-29T03:00:00Z");
const seed = cloudSeed(seedAt);
const d = new Date(seedAt);
const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
const today = ymd(d);
const yesterday = ymd(new Date(seedAt - 86400000));
const bProgress = seed.user_progress.find((r) => r.user_id === B);
const deployAt = seedAt + 60000;

let seq = 0;
const req = (over) => ({ seq: ++seq, at: deployAt + 120000 + seq, phase: "4-revive-old", tab: "new", method: "POST", path: "/rest/v1/" + (over.table ?? ""), query: {}, auth: { kind: "user", who: "B" }, body: [], status: 201, ...over });
const base = (requests, extra = {}) => ({ seedAt, seed, deployAt, requests, tables: {}, tabs: Object.fromEntries(["old-live", "old-frozen", "old-offline", "old-visible", "old-sw"].map((t) => [t, { url: "http://x/", loadedBeforeDeploy: [] }])), docStarts: [], ...extra });

let failed = 0;
function check(name, cond) {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "NG  "} ${name}`);
}

// ---- 値の規則（B の名前の書き込み） ----
const flagged = (table, row, over = {}) => analyze(base([req({ table, body: [row], ...over })])).leaks.length > 0;
const newCodeStreak = { last: yesterday, current: 3, best: 9, shields: 0, shieldSavedOn: null, lost: null, repairedMonth: null };
check("新しいコードの B の user_progress（level・study_familiar_ratio・selected_* だけ違う・連続日数の空の鍵）は漏れにしない", !flagged("user_progress", { ...bProgress, streak: newCodeStreak, level: 6, study_familiar_ratio: 0, selected_category: "all", updated_at: new Date().toISOString() }));
check("A の連続日数 48/52 が B に（xp なしの送信）", flagged("user_progress", { user_id: B, streak: { current: 48, best: 52, last: today } }));
check("A の種の連続日数 47", flagged("user_progress", { user_id: B, streak: { current: 47, best: 52, last: today } }));
check("B の連続日数が 3→4（ほかの人の答え）", flagged("user_progress", { user_id: B, streak: { ...newCodeStreak, current: 4, last: today } }));
check("最高点 9877", flagged("user_progress", { user_id: B, best_score: 9877 }));
check("Battle の勝ち 38・RP 1789", flagged("user_progress", { user_id: B, battle_wins: 38, battle_rp: 1789 }));
check("Battle の負け 11（A の値）", flagged("user_progress", { user_id: B, battle_losses: 11 }));
check("xp 1201", flagged("user_progress", { user_id: B, xp: 1201 }));
check("B のクラウドに無い列に値（rank_peak 9）", flagged("user_progress", { user_id: B, rank_peak: 9 }));
check("品 pack（B のクラウドに無い）", flagged("user_items", { user_id: B, kind: "pack", key: "tsl01", payload: { enabled: true }, deleted: false }));
check("B のマイ単語帳の消した印", flagged("user_items", { user_id: B, kind: "my_word", key: "bonlyquartz", payload: { en: "bonlyquartz", ja: "Bだけの語" }, deleted: true }));
check("B のメモの消した印", flagged("user_items", { user_id: B, kind: "note", key: "english-business", payload: {}, deleted: true }));
check("B のマイ単語帳をそのまま送るのは漏れにしない", !flagged("user_items", { user_id: B, kind: "my_word", key: "bonlyquartz", payload: { en: "bonlyquartz", ja: "Bだけの語" }, deleted: false }));
check("B の今日の日の行（learned 6・印なし）は漏れにしない", !flagged("user_items", { user_id: B, kind: "day", key: today, payload: { learned: 6, mastered: 0, active: false, set: false, sets: 0 }, deleted: false }));
check("B の今日の日の行に学んだ印", flagged("user_items", { user_id: B, kind: "day", key: today, payload: { learned: 6, mastered: 0, active: true, set: false, sets: 0 }, deleted: false }));
check("B の今日の日の行の語の数が B の語より多い（7）", flagged("user_items", { user_id: B, kind: "day", key: today, payload: { learned: 7, mastered: 0, active: false, set: false, sets: 0 }, deleted: false }));
check("B の昨日の日の行を書き替えた", flagged("user_items", { user_id: B, kind: "day", key: yesterday, payload: { learned: 9, mastered: 1, active: true, set: false, sets: 0 }, deleted: false }));
check("B の語 english-business の play_count 99", flagged("word_progress", { user_id: B, word_id: "english-business", play_count: 99 }));
check("B の語をそのまま送るのは漏れにしない", !flagged("word_progress", seed.word_progress.find((r) => r.user_id === B && r.word_id === "english-business")));
check("A の語 english-hello（対照）", flagged("word_progress", { user_id: B, word_id: "english-hello" }));
check("xp 48213（対照）", flagged("user_progress", { user_id: B, xp: 48213 }));
check("activity_days の B の行（0 でも B のクラウドに無い）", flagged("activity_days", { user_id: B, day: today, study_correct: 0, challenge_runs: 0, daily_done: false, battle_runs: 0 }));
check("B の行を消した（DELETE）", flagged("user_items", null, { method: "DELETE", body: null, query: { user_id: `eq.${B}`, kind: "eq.my_word", key: "eq.bonlyquartz" } }));
check("PATCH で B の表示名を A の物に", flagged("profiles", { display_name: "A-ONLY-NAME" }, { method: "PATCH", query: { user_id: `eq.${B}` }, body: { display_name: "A-ONLY-NAME" } }));
check("battle_sessions の B の行", flagged("battle_sessions", { user_id: B, score: 1 }));
check("端末の計測（funnel_events）は A の文字だけを見る", !flagged("funnel_events", { device_id: "d1", step: "x", source: "y", day: today, user_id: null }) && flagged("funnel_events", { device_id: "d1", step: "x", source: USERS.A.email, day: today }));

// ---- 表の最後の中身 ----
{
  const tables = { user_progress: seed.user_progress.map((r) => (r.user_id === B ? { ...r, streak: { current: 48, best: 52, last: today } } : r)), word_progress: seed.word_progress, user_items: seed.user_items, profiles: seed.profiles };
  const rep = analyze(base([], { tables }));
  check("表: B の連続日数が A の物", rep.stored.some((s) => s.table === "user_progress" && s.user === "B"));
  const t2 = { user_progress: seed.user_progress, word_progress: seed.word_progress.filter((r) => r.word_id !== "english-business"), user_items: seed.user_items, profiles: seed.profiles };
  check("表: B の初めの行が消えた", analyze(base([], { tables: t2 })).stored.some((s) => /消えた/.test(s.hits.join())));
  const t3 = { user_progress: seed.user_progress, word_progress: seed.word_progress, user_items: seed.user_items, profiles: seed.profiles };
  check("表: 初めのままなら 0 件", analyze(base([], { tables: t3 })).stored.length === 0);
}

// ---- 旧いコードのタブの決まり ----
{
  const sel = (over) => req({ method: "GET", table: "word_progress", path: "/rest/v1/word_progress", body: null, status: 200, ...over });
  check("旧いコードのタブが B のトークンで読んだ（読みだけ）", analyze(base([sel({ tab: "old-live" })])).structural.length === 1);
  check("読み直された後のタブ（新しいコード）の B の読みは数えない", analyze(base([sel({ tab: "old-sw", at: deployAt + 50000 })], { docStarts: [{ tab: "old-sw", t: deployAt + 10000, id: "x" }] })).structural.length === 0);
  check("読み直される前の B の読みは数える", analyze(base([sel({ tab: "old-sw", at: deployAt + 5000 })], { docStarts: [{ tab: "old-sw", t: deployAt + 10000, id: "x" }] })).structural.length === 1);
  check("旧いコードのタブが B のトークンを更新した", analyze(base([req({ tab: "old-frozen", method: "POST", path: "/auth/v1/token", kind: "auth:token:refresh_token", who: "B", auth: { kind: "anon", who: null }, body: { refresh_token: "x" }, status: 200 })])).structural.length === 1);
  check("通信断で届かなかった B の要求も数える", analyze(base([req({ tab: "old-offline", kind: "offline", status: "offline", rowUserIds: [B] })])).structural.length === 1);
  check("旧いタブの A の要求は数えない", analyze(base([sel({ tab: "old-live", auth: { kind: "user", who: "A" } })])).structural.length === 0);
  const tabs = base([]).tabs;
  tabs["old-live"].forced = [["getSession", USERS.B.email]];
  check("旧いモジュールの getSession が B", analyze(base([], { tabs })).structural.length === 1);
  check("旧い認証の鍵に B のセッション", analyze(base([], { oldKeyChecks: [{ t: deployAt + 9e4, phase: "3-login-B", label: "x", via: "old-live", who: "B" }] })).structural.length === 1);
}

// ---- 判定 ----
{
  const r1 = base([]);
  r1.crash = "Error: page.evaluate: Target page, context or browser has been closed";
  check("途中で落ちた回は INVALID（漏れが無くても）", verdictOf(analyze(r1), r1) === "INVALID");
  const r2 = base([req({ table: "word_progress", body: [{ user_id: B, word_id: "english-hello" }] })]);
  r2.crash = "Error: x";
  check("途中で落ちた回は漏れを見つけていても INVALID", verdictOf(analyze(r2), r2) === "INVALID");
  const r3 = base([req({ table: "word_progress", body: [{ user_id: B, word_id: "english-hello" }] })]);
  check("落ちていなければ LEAK", verdictOf(analyze(r3), r3) === "LEAK");
  const r4 = base([], { tables: structuredClone(seed) });
  check("漏れが無くても、5 段の記録の足りない回は PASS にしない", verdictOf(analyze(r4), r4) === "INVALID");
}

// ---- A の記録の後退（integrity） ----
{
  const aReq = (table, row, over = {}) => req({ tab: "old-live", table, auth: { kind: "user", who: "A" }, body: [{ user_id: A, ...row }], ...over });
  const integ = (rep) => rep.integrity ?? []; // 後退の規則の無い判定（直す前）でも落ちずに NG を出す
  const lossOf = (requests, extra = {}) => integ(analyze(base(requests, extra)));
  const aSeedUp = seed.user_progress.find((r) => r.user_id === A);
  const wiped = { streak: { last: today, current: 1, best: 1, shields: 0 }, best_score: 0, selected_category: "all", battle_rp: 0, battle_wins: 0, battle_losses: 0, battle_draws: 0, battle_current_win_streak: 0, battle_best_win_streak: 0 };
  const rWiped = base([aReq("user_progress", wiped)], { tables: structuredClone(seed) });
  const repW = analyze(rWiped);
  check("後退: 移行の後の空の値で A の user_progress を上書き（最高点 0・連続日数 1/1・Battle 0）", integ(repW).length === 1 && /best_score/.test(integ(repW)[0].hits.join()) && /streak\.best/.test(integ(repW)[0].hits.join()) && /battle_rp/.test(integ(repW)[0].hits.join()) && /battle_wins/.test(integ(repW)[0].hits.join()));
  check("後退だけなら判定は LOSS", verdictOf(repW, rWiped) === "LOSS");
  check("後退でない A の書き込み（新しいコード: XP が増えた・連続日数 48/52 で今日・level と selected_* が違う）", lossOf([aReq("user_progress", { ...aSeedUp, xp: 48300, level: 41, selected_category: "all", streak: { current: 48, best: 52, last: today, shields: 0 }, updated_at: new Date(seedAt + 2e5).toISOString() }, { tab: "new" })]).length === 0);
  check("後退でない A の書き込み（旧いコード: XP が増えた・連続日数 48/52 で今日・選んだ分野は A のまま）", lossOf([aReq("user_progress", { ...aSeedUp, xp: 48300, level: 41, streak: { current: 48, best: 52, last: today, shields: 0 }, updated_at: new Date(seedAt + 2e5).toISOString() })]).length === 0);
  const reset = lossOf([aReq("user_progress", { ...aSeedUp, xp: 48300, selected_category: "all", streak: { current: 48, best: 52, last: today, shields: 0 } })]);
  check("後退: 旧いコードのタブが A の選んだ分野を既定（all）に戻した（移行の後の空の端末の写し）", reset.length === 1 && /selected_category/.test(reset[0].hits.join()));
  const lp = seed.word_progress.find((r) => r.user_id === A && r.word_id === "english-goodbye");
  check("後退: A の語の last_played が空に戻った", lossOf([aReq("word_progress", { ...lp, play_count: 4, last_played: null }, { tab: "new" })]).some((x) => /last_played/.test(x.hits.join())));
  check("後退: A の語の last_played が前へ戻った", lossOf([aReq("word_progress", { ...lp, play_count: 4, last_played: new Date(Date.parse(lp.last_played) - 86400000).toISOString() })]).some((x) => /last_played/.test(x.hits.join())));
  check("後退でない: A の語の last_played が後へ進んだ", lossOf([aReq("word_progress", { ...lp, play_count: 4, last_played: new Date(seedAt + 2e5).toISOString() })]).length === 0);
  check("後退: A の語 english-goodbye の play_count 1（A は 3）", lossOf([aReq("word_progress", { word_id: "english-goodbye", play_count: 1, correct_count: 2, recall_fail: 0 })]).length === 1);
  check("後退でない: A の語の play_count 4", lossOf([aReq("word_progress", { ...seed.word_progress.find((r) => r.user_id === A && r.word_id === "english-goodbye"), play_count: 4, correct_count: 3 })]).length === 0);
  check("後退: 今日の活動 study_correct 4（A の端末は 333）", lossOf([aReq("activity_days", { day: today, study_correct: 4, challenge_runs: 0, daily_done: false, battle_runs: 0 })]).length === 1);
  check("後退: A のマイ単語帳に消した印", lossOf([aReq("user_items", { kind: "my_word", key: "aonlyzephyr", payload: { en: "aonlyzephyr", ja: "Aだけの語" }, deleted: true })]).length === 1);
  check("後退: A の今日の日の行の learned 700（A は 777）", lossOf([aReq("user_items", { kind: "day", key: today, payload: { learned: 700, mastered: 77, active: true, set: false, sets: 0 }, deleted: false })]).length === 1);
  check("後退: A の表示名を空に", lossOf([aReq("profiles", { display_name: null, avatar_url: null })]).length === 1);
  check("後退: A の行を消した（DELETE）", lossOf([aReq("user_items", null, { method: "DELETE", body: null, query: { user_id: `eq.${A}`, kind: "eq.note", key: `eq.${"english-hello"}` } })]).length === 1);
  check("配信の前の書き込みは後退に数えない（その時の本番の振る舞い）", lossOf([aReq("user_progress", wiped, { at: deployAt - 1000, phase: "1-old-A" })]).length === 0);
  check("受け口が断った書き込み（403）は後退に数えない", lossOf([aReq("user_progress", wiped, { status: 403 })]).length === 0);
  check("連続日数が途切れた（日が 2 日以上あいた）のは後退にしない", lossOf([aReq("user_progress", { streak: { current: 1, best: 52, last: ymd(new Date(seedAt + 3 * 86400000)) } })]).length === 0);
  check("Battle をした（負けが増えた）なら RP が下がってもよい", lossOf([aReq("user_progress", { battle_rp: 1765, battle_losses: 12, battle_current_win_streak: 0 })]).length === 0);
  const tWiped = { ...structuredClone(seed), user_progress: seed.user_progress.map((r) => (r.user_id === A ? { ...r, ...wiped } : r)) };
  check("表: A の user_progress が空の値に戻った", integ(analyze(base([], { tables: tWiped }))).some((x) => x.stored && x.table === "user_progress"));
  const tGone = { ...structuredClone(seed), word_progress: seed.word_progress.filter((r) => !(r.user_id === A && r.word_id === "english-meet")) };
  check("表: A の初めの行が消えた", integ(analyze(base([], { tables: tGone }))).some((x) => x.stored && /消えた/.test(x.hits.join())));
  check("表: 初めのままなら後退 0 件", integ(analyze(base([], { tables: structuredClone(seed) }))).length === 0 && analyze(base([], { tables: structuredClone(seed) })).integrity !== undefined);
  check("A の名前の書き込みは B の漏れの規則に入らない（後退だけ）", analyze(rWiped).leaks.length === 0);
}

// ---- A が答えた公開の語 ----
{
  const words = { pre: ["english-zero"], old: [], stats: { "english-zero": { playCount: 2, correctCount: 2, recallFail: 2 } } };
  const hitsOf = (row) => analyze(base([req({ table: "word_progress", body: [{ user_id: B, word_id: "english-zero", ...row }] })], { words })).leaks.flatMap((l) => l.hits);
  const own = hitsOf({ play_count: 1, correct_count: 0, recall_fail: 0 });
  check("B が学んだだけの公開の語（回数が A と違う）は A の語と言わない（B のクラウドに無い行としては当たる）", own.length > 0 && !own.some((h) => h.startsWith("word:")) && own.some((h) => h.startsWith("seed:")));
  check("回数が A の値と同じなら A の語", hitsOf({ play_count: 2, correct_count: 2, recall_fail: 2 }).some((h) => h.startsWith("word:")));
  check("A だけの語は回数によらず A の語", analyze(base([req({ table: "word_progress", body: [{ user_id: B, word_id: "english-meet", play_count: 1 }] })])).leaks.flatMap((l) => l.hits).some((h) => h.startsWith("word:")));
}

// ---- 5 段の確かめ: タブごとの答え・新しいコードの開き直し ----
{
  const key = (rep, head) => Object.keys(rep.validity).find((k) => k.startsWith(head));
  const ANS = "4 旧いコードのまま残った old-live と old-frozen";
  const tabsWith = (frozenAnswers, frozenChanged) => {
    const t = base([]).tabs;
    t["old-live"].answers = [{ ok: true, en: "goodbye" }, { ok: true, en: "please" }];
    t["old-live"].changed = ["english-goodbye", "english-please"];
    t["old-frozen"].answers = frozenAnswers;
    t["old-frozen"].changed = frozenChanged;
    return t;
  };
  const r1 = analyze(base([], { tabs: tabsWith([{ ok: false, reason: "error page.focus: Timeout 30000ms exceeded." }], []) }));
  check("old-frozen が答えられなかった回は 5 段を通っていない（old-live だけの答えで通さない）", r1.validity[key(r1, ANS)] === false);
  const r2 = analyze(base([], { tabs: tabsWith([{ ok: true, en: "meet" }], ["english-meet"]) }));
  check("old-live と old-frozen の両方が答えて記録を変えたら通る", r2.validity[key(r2, ANS)] === true);
  const r3 = analyze(base([], { tabs: tabsWith([{ ok: true, en: "meet" }], []) }));
  check("答えても端末の語の記録が変わらなければ通さない", r3.validity[key(r3, ANS)] === false);
  const RL4 = "4 旧いタブが答えた後に、新しいコードの文書を開き直した";
  const RL5 = "5 旧いタブを閉じた後に、新しいコードの文書を開き直した";
  const r4 = analyze(base([]));
  check("新しいコードの開き直しが無い回は 5 段を通っていない（4 段の後・閉じた後）", r4.validity[key(r4, RL4)] === false && r4.validity[key(r4, RL5)] === false);
  const good = (label) => ({ label, docs: 2, settled: true, treeHasSwitch: true, switchLoaded: true, finalUrl: "http://x/" });
  const r5 = analyze(base([], { reloads: [good("after-step4"), good("after-close")] }));
  check("開き直して /switch.html も読み、落ち着いたら通る", r5.validity[key(r5, RL4)] === true && r5.validity[key(r5, RL5)] === true);
  const r6 = analyze(base([], { reloads: [{ ...good("after-step4"), switchLoaded: false }, good("after-close")] }));
  check("/switch.html を読めていなければ通さない（切り替えの画面のある木）", r6.validity[key(r6, RL4)] === false);
  const r7 = analyze(base([], { reloads: [{ ...good("after-step4"), treeHasSwitch: false, switchLoaded: undefined }, { ...good("after-close"), treeHasSwitch: false, switchLoaded: undefined }] }));
  check("切り替えの画面の無い木（分離の前）は / だけで通る", r7.validity[key(r7, RL4)] === true && r7.validity[key(r7, RL5)] === true);
  const tNone = base([]).tabs;
  for (const t of Object.keys(tNone)) tNone[t].forced = [["getSession", null]];
  const r9 = analyze(base([], { login: "none", tabs: tNone, refreshRace: { held: true, releasedAt: deployAt + 5000 }, oldKeyChecks: [{ t: deployAt + 6000, phase: "2-deploy-new", label: "止めていた更新を通した後", who: "A" }, { t: deployAt + 9e4, phase: "4-forced", label: "旧いモジュールを呼んだ後", who: null }] }));
  check("ログインしない回: 書き戻しの直後に旧い鍵が A でも、旧いタブを戻した 4 段で空・getSession が空なら「試みられない理由」を確かめた", r9.validity[key(r9, "4 旧いコードのタブのトークンの更新")] === true && r9.summary.oldRefresh.branch === "no-session");
  const r10 = analyze(base([], { login: "none", tabs: tNone, refreshRace: { held: true, releasedAt: deployAt + 5000 }, oldKeyChecks: [{ t: deployAt + 9e4, phase: "4-forced", label: "旧いモジュールを呼んだ後", who: "A" }] }));
  check("ログインしない回: 4 段で旧い鍵が A のまま（旧いタブが A として動ける）なら「試みられない理由」にしない", r10.summary.oldRefresh.branch !== "no-session");
  const r11 = analyze(base([], { oldAuthLib: true, refreshRace: { held: true, oldKeyAfterRelease: null } }));
  check("古い部品の回で書き戻しが起きなかったら「試していない」に出す", r11.summary.notExercised.some((x) => x.startsWith("2 古い部品の書き戻し")));
  const r12 = analyze(base([], { oldAuthLib: true, refreshRace: { held: true, oldKeyAfterRelease: null, writeBackSeen: true } }));
  check("書き戻しの直後に片付けられても、書き込みの知らせで見えたら「試していない」にしない", !r12.summary.notExercised.some((x) => x.startsWith("2 古い部品の書き戻し")));
  const WB = "2 古い部品の書き戻しが起きた";
  const x13 = base([], { tables: structuredClone(seed), oldAuthLib: true, expectWriteBack: true, refreshRace: { held: true, response: { status: 200 }, oldKeyAfterRelease: null, writeBackSeen: false } });
  const r13 = analyze(x13);
  check("--expect-writeback の回で書き戻しが起きなければ 5 段を通っていない", r13.validity[key(r13, WB)] === false && verdictOf(r13, x13) === "INVALID");
  const r14 = analyze(base([], { oldAuthLib: true, expectWriteBack: true, refreshRace: { held: true, response: { status: 200 }, writeBackSeen: true } }));
  check("--expect-writeback の回で書き戻しが見えたら、その確かめは通る", r14.validity[key(r14, WB)] === true);
  check("--expect-writeback でない回には書き戻しの確かめが無い", key(r11, WB) === undefined);
  const r15 = analyze(base([], { oldKeyEvents: [{ t: deployAt + 5e4, via: "old-live", who: "B" }] }));
  check("旧い認証の鍵に B のセッションが書かれた（書き込みの知らせ）は旧いコードのタブの決まりに当たる", r15.structural.length === 1);
  const r16 = analyze(base([], { oldKeyEvents: [{ t: deployAt + 5e4, via: "old-live", who: "A" }, { t: deployAt + 5e4 + 30, via: "old-live", who: null }] }));
  check("旧い認証の鍵に A のセッション・消えた知らせは当たらない", r16.structural.length === 0);
  const r8 = analyze(base([], { login: "none" }));
  check("B にログインしない回は B のセッションの確かめを「試していない」にする", r8.validity[key(r8, "3 新しいタブで B のセッションが動いた")] === true && r8.summary.notExercised.some((x) => x.startsWith("3 B へのログイン")));
}

// ---- 旧い画面の答え: タブの中の書き込みの記録（lib/storageTap.mjs） ----
{
  const key = (rep, head) => Object.keys(rep.validity).find((k) => k.startsWith(head));
  const ANS = "4 旧いコードのまま残った old-live と old-frozen";
  const at0 = deployAt + 100000;
  const DOC = { "old-live": "docLive", "old-frozen": "docFrozen" };
  // 答え 2 つずつ。答えの窓は [typingAt, t1]。ids は答えた語、nextIds は答えた後に出た次の語
  const ans = (i, en, next) => ({ ok: true, ja: "x", en, how: "recall", t0: at0 + i * 10000, typingAt: at0 + i * 10000 + 500, t1: at0 + i * 10000 + 3000, ids: [`english-${en}`], nextIds: next ? [`english-${next}`] : [] });
  const ANSWERS = { "old-live": [ans(0, "sorry", "goodbye"), ans(1, "goodbye", "please")], "old-frozen": [ans(2, "goodbye", "please"), ans(3, "please", "meet")] };
  const install = (tab) => ({ tab, op: "install", key: null, t: seedAt + 1000, docId: DOC[tab] });
  const wr = (tab, t, ids, over = {}) => ({ tab, op: "set", key: "spelldash_word_stats", t, docId: DOC[tab], size: 100, digest: `d-${tab}-${t}`, changed: Object.fromEntries(ids.map((id) => [id, { playCount: 1, correctCount: 0, recallFail: 0, lastPlayed: null, isNew: true }])), ...over });
  const mk = ({ writes, changed = { "old-live": [], "old-frozen": [] }, installs = ["old-live", "old-frozen"], answers = ANSWERS, extra = {} }) => {
    const t = base([]).tabs;
    for (const name of ["old-live", "old-frozen"]) {
      t[name].docId = DOC[name];
      t[name].answers = answers[name];
      t[name].changed = changed[name];
    }
    return base([], { tabs: t, storageWrites: [...installs.map(install), ...writes], reached: [{ phase: "4-revive-old", t: at0 - 5000 }], ...extra });
  };
  // 答えのたびに次の語を書いた（分離の入った木の形: 端末の語の記録は空なので、答えた語は書かれず、次の語を出す時の記録だけ）
  const nextWrites = [wr("old-live", ANSWERS["old-live"][0].typingAt + 800, ["english-goodbye"]), wr("old-live", ANSWERS["old-live"][1].typingAt + 800, ["english-please"]), wr("old-frozen", ANSWERS["old-frozen"][0].typingAt + 800, ["english-please"]), wr("old-frozen", ANSWERS["old-frozen"][1].typingAt + 800, ["english-meet"])];
  const v = (rec) => {
    const rep = analyze(rec);
    return rep.validity[key(rep, ANS)];
  };
  check("答えても、タブの中の書き込みが見えなければ通さない（端末の語の記録も変わらない）", v(mk({ writes: [] })) === false);
  check("答えた後に端末の語の記録が変わっていても、タブの中の書き込みが見えなければ通さない（包みのある文書）", v(mk({ writes: [], changed: { "old-live": ["english-goodbye"], "old-frozen": ["english-meet"] } })) === false);
  check("答えのたびに次の語の記録を書いたら通る（分離の入った木の形・端末の変化は無い）", v(mk({ writes: nextWrites })) === true);
  const answeredWrites = [wr("old-live", ANSWERS["old-live"][0].typingAt + 700, ["english-sorry"]), wr("old-live", ANSWERS["old-live"][1].typingAt + 700, ["english-goodbye"]), wr("old-frozen", ANSWERS["old-frozen"][0].typingAt + 700, ["english-goodbye"]), wr("old-frozen", ANSWERS["old-frozen"][1].typingAt + 700, ["english-please"])];
  const repA = analyze(mk({ writes: answeredWrites, changed: { "old-live": ["english-goodbye"], "old-frozen": ["english-meet"] } }));
  check("答えた語そのものの記録を書いたら通る（分離の前の木の形）", repA.validity[key(repA, ANS)] === true && (repA.summary.answeredBy["old-live"].perAnswer ?? []).length === 2 && repA.summary.answeredBy["old-live"].perAnswer.every((x) => x.answered));
  check("別の文書（配信の後の新しいコードなど）の書き込みは数えない", v(mk({ writes: nextWrites.map((w) => ({ ...w, docId: "docNew" })) })) === false);
  check("old-live の書き込みだけでは old-frozen を通さない（タブごと）", v(mk({ writes: nextWrites.filter((w) => w.tab === "old-live") })) === false);
  check("old-frozen の書き込みを old-live の物と取り違えない（タブで見る）", v(mk({ writes: nextWrites.map((w) => ({ ...w, tab: "old-live", docId: DOC["old-live"] })) })) === false);
  check("打ち始める前の書き込み（出ていた語の記録）は答えに数えない", v(mk({ writes: nextWrites.map((w) => ({ ...w, t: w.t - 2000 })) })) === false);
  check("窓の中でも、答えた語でも次の語でもない語の記録だけなら通さない", v(mk({ writes: nextWrites.map((w) => ({ ...w, changed: { "english-zero": { playCount: 1 } } })) })) === false);
  check("2 つの答えの 1 つしか書かれていなければ通さない（答えごと）", v(mk({ writes: nextWrites.filter((w, i) => i !== 1) })) === false);
  // 答えの窓の終わり = min(t1 + 0.3 秒, 次の答えの打ち始め): 次の答えの打ち始めより後の書き込みを前の答えに数えない
  const lateAns = { "old-live": [{ ...ANSWERS["old-live"][0], t1: ANSWERS["old-live"][1].typingAt + 2000 }, ANSWERS["old-live"][1]], "old-frozen": ANSWERS["old-frozen"] };
  const onlySecond = [wr("old-live", ANSWERS["old-live"][1].typingAt + 800, ["english-goodbye", "english-please"]), ...nextWrites.slice(2)];
  check("前の答えの落ち着きが次の答えの打ち始めより後でも、次の答えの窓の書き込みを前の答えに数えない", v(mk({ writes: onlySecond, answers: lateAns })) === false);
  const repW = analyze(mk({ writes: nextWrites, answers: lateAns }));
  check("同じ形で前の答えの窓に書き込みがあれば通る（窓の終わりは次の答えの打ち始め）", repW.validity[key(repW, ANS)] === true && repW.summary.answeredBy["old-live"].perAnswer[0].windowEnd === ANSWERS["old-live"][1].typingAt);
  // 画面が次の語へ進まなかった答え（訳が同じまま）は数えない
  const stuck = { "old-live": [{ ...ANSWERS["old-live"][0], ja: "すみません", jaAfter: "すみません" }, ANSWERS["old-live"][1]], "old-frozen": ANSWERS["old-frozen"] };
  const repS = analyze(mk({ writes: nextWrites, answers: stuck }));
  check("打った後に画面が進まなかった答えは数えない（ja と jaAfter が同じ）", repS.summary.answeredBy["old-live"].ok === 1);
  const stuckAll = { "old-live": ANSWERS["old-live"].map((a) => ({ ...a, ja: "x", jaAfter: "x" })), "old-frozen": ANSWERS["old-frozen"] };
  check("old-live のどの答えも画面が進まなければ通さない", v(mk({ writes: nextWrites, answers: stuckAll })) === false);
  check("配信の前の書き込みは数えない", v(mk({ writes: nextWrites.map((w) => ({ ...w, t: deployAt - 1000 })), answers: { "old-live": ANSWERS["old-live"].map((a) => ({ ...a, typingAt: deployAt - 5000, t1: deployAt })), "old-frozen": ANSWERS["old-frozen"].map((a) => ({ ...a, typingAt: deployAt - 5000, t1: deployAt })) } })) === false);
  check("語の記録でない鍵の書き込みは数えない", v(mk({ writes: nextWrites.map((w) => ({ ...w, key: "spelldash_xp" })) })) === false);
  const repL = analyze(mk({ writes: [], installs: [], changed: { "old-live": ["english-goodbye"], "old-frozen": ["english-meet"] } }));
  check("書き込みの記録の無い古い記録（包みの印が無い）は前の決まり（端末の語の記録が変わった）で通る", repL.validity[key(repL, ANS)] === true && repL.summary.answeredBy["old-live"].mode === "local");
  check("書き込みの記録の無い古い記録で端末の語の記録も変わらなければ通さない", v(mk({ writes: [], installs: [] })) === false);
  // A が答えた語: タブの中で書いた回数も A の値に入る（分離の入った木では端末に残らない）
  const zeroWrite = [wr("old-live", ANSWERS["old-live"][0].typingAt + 800, ["english-zero"])];
  const bRow = { user_id: B, word_id: "english-zero", play_count: 1, correct_count: 0, recall_fail: 0 };
  const hitsWith = analyze({ ...mk({ writes: zeroWrite }), requests: [req({ table: "word_progress", body: [bRow] })] }).leaks.flatMap((l) => l.hits);
  const hitsWithout = analyze({ ...mk({ writes: [] }), requests: [req({ table: "word_progress", body: [bRow] })] }).leaks.flatMap((l) => l.hits);
  check("旧いタブの中で書いた語と回数（english-zero 1/0/0）が B の行にあれば A の語", hitsWith.some((h) => h.startsWith("word:")) && !hitsWithout.some((h) => h.startsWith("word:")));

  // ---- orphans ----
  const OK = "4 移行の後に旧いコードのタブが旧い場所へ書いた語の記録は、片付けで IndexedDB の orphans に届いた";
  const orphansRead = (records, over = {}) => ({ at: at0 + 60000, dbExists: true, storeExists: true, records, error: null, ...over });
  const recOf = (digest, words = {}) => ({ id: "o1", savedAt: null, area: null, keys: { spelldash_word_stats: { size: 100, digest, words } } });
  const withOrphans = (read, tree = { has: true, db: "spelldash-areas", store: "orphans" }) => {
    const r = mk({ writes: nextWrites, extra: { orphansTree: tree } });
    r.reloads = [{ label: "after-step4", docs: 2, settled: true, treeHasSwitch: true, switchLoaded: true, rawAfter: [], orphans: read }];
    return analyze(r);
  };
  const o1 = withOrphans(orphansRead([recOf(nextWrites[1].digest), { ...recOf(nextWrites[3].digest), id: "o2" }]));
  check("orphans: 旧いコードのタブが書いた値（digest）が届いていれば通る・届いた数を出す", o1.validity[key(o1, OK)] === true && o1.summary.orphans?.writesFound === 2 && o1.summary.orphans?.oldWordWrites === 4);
  const o1b = withOrphans(orphansRead([recOf(nextWrites[3].digest)]));
  check("orphans: 答えを数えたタブの 1 つ（old-live）の最後の書き込みが届かなければ通さない（ほかのタブの値が届いていても）", o1b.validity[key(o1b, OK)] === false && o1b.summary.orphans?.lastWriteFound?.["old-live"] === false && o1b.summary.orphans?.lastWriteFound?.["old-frozen"] === true);
  const o5 = withOrphans(orphansRead([recOf("other", { "english-please": { playCount: 1, correctCount: 0, recallFail: 0 }, "english-meet": { playCount: 1, correctCount: 0, recallFail: 0 } })]));
  check("orphans: 値が違っても、書いた語の回数が届いていれば通る（語ごとの数を出す。2 つのタブの書き込みが 1 回の片付けにまとまった形）", o5.validity[key(o5, OK)] === true && o5.summary.orphans?.wordsFound?.includes("english-meet") === true && o5.summary.orphans?.wordsMissing?.length === 1);
  const o5b = withOrphans(orphansRead([recOf("other", { "english-meet": { playCount: 1, correctCount: 0, recallFail: 0 } })]));
  check("orphans: 語の回数で見ても、old-live の最後の書き込み（english-please）が届いていなければ通さない", o5b.validity[key(o5b, OK)] === false);
  const o2 = withOrphans(orphansRead([recOf("other", { "english-zero": { playCount: 9 } })]));
  check("orphans: 1 つも届いていなければ通さない", o2.validity[key(o2, OK)] === false);
  const o3 = withOrphans({ at: at0 + 60000, dbExists: false, storeExists: false, records: [], error: null });
  check("orphans: orphans の DB が無ければ通さない", o3.validity[key(o3, OK)] === false);
  const o4 = withOrphans(undefined, { has: false, db: null, store: "orphans" });
  check("orphans の無い木（分離の前）には orphans の確かめが無い", key(o4, OK) === undefined && o4.summary.orphans?.treeHasOrphans === false);
}

// ---- A へ戻る段（DECISION5 の 1）: 旧いタブの学習が A に入る・2 度入らない・B に入らない ----
{
  const key = (rep, head) => Object.keys(rep.validity).find((k) => k.startsWith(head));
  const at0 = deployAt + 100000;
  const DOC = { "old-live": "docLive", "old-frozen": "docFrozen" };
  const ans = (i, en, next) => ({ ok: true, ja: `訳${i}`, jaAfter: `訳${i + 1}`, en, how: "recall", t0: at0 + i * 10000, typingAt: at0 + i * 10000 + 500, t1: at0 + i * 10000 + 3000, ids: [`english-${en}`], nextIds: next ? [`english-${next}`] : [] });
  const ANSWERS = { "old-live": [ans(0, "sorry", "goodbye"), ans(1, "goodbye", "please")], "old-frozen": [ans(2, "goodbye", "please"), ans(3, "please", "meet")] };
  const LP = (i) => new Date(at0 + i * 10000 + 1300).toISOString();
  const wr = (tab, i, id) => ({ tab, op: "set", key: "spelldash_word_stats", t: at0 + i * 10000 + 1300, docId: DOC[tab], size: 100, digest: `d-${tab}-${i}`, changed: { [id]: { playCount: 1, correctCount: 0, recallFail: 0, lastPlayed: LP(i), isNew: true, prev: null } } });
  const writes = [wr("old-live", 0, "english-goodbye"), wr("old-live", 1, "english-please"), wr("old-frozen", 2, "english-please"), wr("old-frozen", 3, "english-meet")];
  const AREA_A = `u:${A}`;
  const AREA_B = `u:${B}`;
  const W = (p, c, r, ls, lastPlayed, pub = true) => ({ playCount: p, correctCount: c, recallFail: r, lastPlayed: lastPlayed ?? "2026-10-28T00:00:00.000Z", ls: ls ?? null, pub });
  const prior = { "english-hello": W(3, 2, 1, 2), "english-goodbye": W(3, 2, 1, 1, null, false), "english-please": W(3, 2, 1, 1), "english-meet": W(3, 2, 1, 1) };
  const good = { "english-hello": W(3, 2, 1, 2), "english-goodbye": W(4, 2, 1, 1, LP(0), false), "english-please": W(5, 2, 1, 1, LP(2)), "english-meet": W(4, 2, 1, 1, LP(3)) };
  const T6 = at0 + 300000;
  const snapA = (label, words, { inLs = true, extraLs = {}, extraIdb = [] } = {}) => ({ label, t: T6 + 1000, marker: inLs ? `${AREA_A}#3` : `${AREA_B}#2`, index: inLs ? { [AREA_A]: { at: "ls" }, [AREA_B]: { at: "idb:b1" } } : { [AREA_A]: { at: "idb:a1" }, [AREA_B]: { at: "ls" } }, ls: { ...(inLs ? { [AREA_A]: { keys: 20, words, dirty: [] } } : {}), ...extraLs }, idb: { dbExists: true, storeExists: true, records: [...(inLs ? [] : [{ area: AREA_A, id: "a1", words }]), ...extraIdb] } });
  const cloudOf = (words) => Object.entries(words).map(([id, v]) => ({ word_id: id, play_count: v.playCount, correct_count: v.correctCount, recall_fail: v.recallFail, last_played: v.lastPlayed }));
  const pushOf = (words) => ({ seq: 9000, at: T6 + 500, phase: "6-return-A", tab: "new", method: "POST", path: "/rest/v1/word_progress", table: "word_progress", query: { on_conflict: "user_id,word_id" }, auth: { kind: "user", who: "A" }, status: 201, body: Object.entries(words).map(([id, v]) => ({ user_id: A, word_id: id, play_count: v.playCount, correct_count: v.correctCount, recall_fail: v.recallFail, last_played: v.lastPlayed })) });
  const counts = (words) => {
    let unsure = 0;
    let learned = 0;
    for (const v of Object.values(words)) if (v.pub) (v.ls === 1 ? unsure++ : v.ls === 2 ? learned++ : 0);
    return { new: 2858 - unsure - learned, unsure, learned };
  };
  const imp = ({ after1 = good, after2 = after1, cloud1 = cloudOf(after1), push = true, dirty = false, areaWrites = [], screen1 = null, screen2 = null, extraSnaps = [], ret = {}, watch = {} } = {}) => {
    const t = base([]).tabs;
    for (const name of ["old-live", "old-frozen"]) {
      t[name].docId = DOC[name];
      t[name].answers = ANSWERS[name];
      t[name].changed = [];
    }
    const aw = [{ t: T6 - 1000, key: "sd2.area", area: null, name: null, op: "set", value: `${AREA_A}#3` }, ...(dirty ? [{ t: T6 + 200, key: `sd2.${AREA_A}.dirty_words`, area: AREA_A, name: "dirty_words", op: "set", dirty: Object.keys(after1) }] : []), ...areaWrites];
    return base(push ? [pushOf(after1)] : [], {
      tabs: t,
      storageWrites: [...["old-live", "old-frozen"].map((tab) => ({ tab, op: "install", key: null, t: seedAt + 1000, docId: DOC[tab] })), ...writes],
      reached: [{ phase: "4-revive-old", t: at0 - 5000 }],
      orphansTree: { has: true, db: "spelldash-areas", store: "orphans" },
      publicTotal: 2858,
      areaWrites: aw,
      areaSnaps: [snapA("after-step3", prior, { inLs: false }), snapA("return1", after1), snapA("away2", after1, { inLs: false }), snapA("return2", after2), ...extraSnaps],
      returnA: { mode: "logout", start: T6 - 5000, first: { active: true, t0: T6 - 4000 }, away: { ok: true }, second: { active: true }, screen1: { drawn: true, cards: screen1 ?? counts(after1) }, screen2: { drawn: true, cards: screen2 ?? counts(after2) }, cloud1, ...ret },
      watch: { install: "聞き始めた", docId: "w1", docAtEnd: "w1", ...watch },
      tables: (() => {
        // 受け口の表の最後: 種に、A へ戻った後に送った値（2 回目の値）を重ねる
        const tb = structuredClone(seed);
        for (const [id, v] of Object.entries(after2)) {
          const row = tb.word_progress.find((r) => r.user_id === A && r.word_id === id);
          const vals = { play_count: v.playCount, correct_count: v.correctCount, recall_fail: v.recallFail, last_played: v.lastPlayed };
          if (row) Object.assign(row, vals);
          else tb.word_progress.push({ user_id: A, word_id: id, ...vals });
        }
        return tb;
      })()
    });
  };
  const R = (over, opts) => analyze(imp(over), opts);
  const r1 = R();
  check("A へ戻る段: 旧いタブの 4 つの答え（goodbye +1・please +2・meet +1）が A の値に足され、送り、画面と合えば取り込みの問題 0", r1.imports?.missing.length === 0 && r1.imports?.double.length === 0 && r1.areaLeaks.length === 0);
  check("A へ戻る段: 数えた答えの書き込みと語（4 回・3 語）を出す", r1.imports?.counted.writes === 4 && r1.imports.counted.words.length === 3 && r1.imports.perWord["english-please"].need.playCount === 2);
  const VALID6 = ["6 A へ戻る段: 新しいタブの領域が A に戻り", "6 A へ戻る段: A から離れて", "6 A へ戻る段: 学習状況の画面", "6 A へ戻る段: A の初めの値", "6 A へ戻る段: 見張りのタブ", "6 A へ戻る段: A へ取り込む物がある"];
  check("A へ戻る段: 戻る段の確かめ 6 つが通る", VALID6.every((h) => r1.validity[key(r1, h)] === true));
  const r2 = R({ after1: prior, after2: prior, push: false });
  check("取り込まれない（A の値が初めのまま）なら足りない（NOT_IMPORTED）", r2.imports.missing.some((x) => x.id === "english-please" && x.f === "playCount" && x.at === "return1") && verdictOf({ ...r2, summary: { ...r2.summary, valid: true } }, {}) === "NOT_IMPORTED");
  const replaced = { ...good, "english-please": W(2, 0, 0, null, LP(2)), "english-meet": W(1, 0, 0, null, LP(3)) };
  const r3 = R({ after1: replaced });
  check("A の値を旧いタブの値で置き換えた（3 → 1）なら足りない・置き換えたと書く", r3.imports.missing.some((x) => x.id === "english-meet" && x.f === "playCount" && x.replaced === true));
  const twice = { ...good, "english-please": W(7, 2, 1, 1, LP(2)) };
  const r4 = R({ after1: twice });
  check("同じ書き込みを 2 度足した（please 3 → 7）なら DOUBLE", r4.imports.double.some((x) => x.id === "english-please" && x.at === "return1") && verdictOf({ ...r4, summary: { ...r4.summary, valid: true } }, {}) === "DOUBLE");
  const again = { ...good, "english-meet": W(5, 2, 1, 1, LP(3)) };
  const r5 = R({ after2: again });
  check("2 回目に A へ戻ったら回数がまた増えた（meet 4 → 5）なら DOUBLE", r5.imports.double.some((x) => x.id === "english-meet" && x.at === "return2"));
  const r6 = R({ after1: prior, after2: good, push: false, cloud1: cloudOf(prior) });
  check("1 回目に入らず 2 回目に入ったら NOT_IMPORTED のまま（2 回目に入ったと書く）", r6.imports.missing.some((x) => x.at === "return1") && r6.imports.double.length === 0 && r6.imports.perWord["english-please"].lateImport === true);
  const r7 = R({ push: false, dirty: false });
  check("送る語の印にも A の送信にも無ければ足りない（送信待ち）", r7.imports.missing.some((x) => x.f === "送信待ち"));
  const r7b = R({ push: false, dirty: true });
  check("送る語の印に入っていれば送信待ちは通る（A のクラウドは別に見る）", !r7b.imports.missing.some((x) => x.f === "送信待ち"));
  const r8 = R({ cloud1: cloudOf(prior) });
  check("A へ戻った後の A のクラウドの行が初めのままなら足りない（A のクラウド）", r8.imports.missing.some((x) => x.f === "A のクラウド" && x.id === "english-please"));
  const stale = { ...good, "english-please": W(5, 2, 1, 1, "2026-10-28T00:00:00.000Z") };
  const r9 = R({ after1: stale });
  check("最後に答えた時刻が旧いタブの書いた時刻より前なら足りない（lastPlayed）", r9.imports.missing.some((x) => x.f === "lastPlayed" && x.id === "english-please"));
  const r10 = R({ areaWrites: [{ t: at0 + 1500, key: `sd2.${AREA_B}.word_stats`, area: AREA_B, name: "word_stats", op: "set", words: { "english-business": W(4, 3, 1, null), "english-please": W(1, 0, 0, null) } }] });
  check("B の領域の語の記録に旧いタブの語が書かれた（見張りの知らせ）なら LEAK", r10.areaLeaks.some((l) => l.area === "B" && l.id === "english-please") && verdictOf(r10, {}) === "LEAK");
  const r11 = R({ extraSnaps: [{ ...snapA("away2b", good), ls: { guest: { keys: 3, words: { "english-meet": W(1, 0, 0, null) } } } }] });
  check("ゲストの領域（節目の読み）に旧いタブの語があれば LEAK", r11.areaLeaks.some((l) => l.area === "guest" && l.id === "english-meet"));
  const r12 = R({ extraSnaps: [snapA("x", good, { extraIdb: [{ area: `pre:${AREA_A}`, id: "p1", words: good }] })] });
  check("A の予行の写し（pre:u:A）に旧いタブの語があっても LEAK にしない", r12.areaLeaks.length === 0);
  const r12b = R({ areaWrites: [{ t: at0 + 1500, key: `sd2.${AREA_B}.dirty_words`, area: AREA_B, name: "dirty_words", op: "set", dirty: ["english-business", "english-meet"] }] });
  check("B の送る語の印に旧いタブの語が入ったら LEAK", r12b.areaLeaks.some((l) => l.area === "B" && l.id === "english-meet"));
  const r13 = R({ screen1: { new: 2856, unsure: 1, learned: 1 } });
  check("学習状況の画面の札が A の語の記録の 3 状態と違えば足りない（画面）", r13.imports.missing.some((x) => x.f === "画面の 3 つの札") && r13.imports.screen1.same === false);
  const moved = { ...good, "english-please": W(5, 2, 1, 2, LP(2)) };
  const r14 = R({ after1: moved, after2: moved });
  check("3 状態の決まり report（既定）は値を出すだけ（あやふや → 覚えた でも問題にしない）", r14.imports.missing.length === 0 && r14.imports.perWord["english-please"].state.after1 === 2);
  const r15 = analyze(imp({ after1: moved, after2: moved }), { importState: "keep" });
  check("3 状態の決まり keep: A の初めの状態から動いたら足りない（3 状態）", r15.imports.missing.some((x) => x.f === "3 状態" && x.id === "english-please"));
  const r16 = analyze(imp({ after1: moved, after2: moved }), { importState: ({ id }) => (id === "english-please" ? 2 : null) });
  check("3 状態の決まりを関数で渡せる（please は覚えた）", r16.imports.missing.length === 0 && r16.imports.perWord["english-please"].state.expected === 2);
  const noLs = Object.fromEntries(Object.entries(prior).map(([id, v]) => [id, { ...v, ls: null }]));
  const imp18 = imp({ after1: good, after2: good });
  imp18.areaSnaps[0] = snapA("after-step3", noLs, { inLs: false });
  const r18k = analyze(imp18, { importState: "keep" });
  check("keep: A の初めの控えに 3 状態の欄が 1 語も無い（移行の前の写し）なら初めの状態が分からないので当てない", !r18k.imports.missing.some((x) => x.f === "3 状態") && r18k.imports.perWord["english-please"].state.priorStates === false);
  const r17 = R({ ret: { first: { active: false, t0: T6 - 4000 } } });
  check("A へ戻れなかった回は戻る段の確かめが通らない（INVALID）", r17.validity[key(r17, VALID6[0])] === false);
  const r18 = R({ watch: { docAtEnd: "w2" } });
  check("見張りのタブが読み直された（文書が替わった）回は戻る段の確かめが通らない", r18.validity[key(r18, VALID6[4])] === false);
  const old = analyze(base([], { orphansTree: { has: true, db: "spelldash-areas", store: "orphans" } }));
  check("A へ戻る段の無い古い記録には、取り込みの確かめも新しい判定も無い", old.imports === null && !Object.keys(old.validity).some((k) => k.startsWith("6 ")));
  const noTree = analyze(base([], { returnA: { first: { active: true } } }));
  check("orphans の無い木（分離の前）には取り込みの確かめが無い", noTree.imports === null);
}

console.log(failed ? `\n${failed} 件 NG` : "\nすべて ok");
process.exit(failed ? 1 : 0);
