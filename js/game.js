import { getWordsByCategory, findWord, findWordIn, getCategories, promptOf, speechTextOf, isConceptWord, answersFor } from "./wordStore.js";
import { jaLooksSame } from "./jaAmbiguity.js";
import { viableAnswers, completedAnswer, continuationsOf, isSpellingVariant } from "./answers.js";
import { createRomajiMatcher, readingEntries, primaryReading, romajiKeyOf, hasJapaneseScript, hasKana } from "./romaji.js";
import { applyGenre } from "./genres.js";
import { hasumiResultLine, hasumiSetLine, hasumiLearnedLine, hasumiBubbleHtml, renderHasumiHome } from "./hasumi.js";
import { historyDotsHtml, getLearnedCount, getLearnedCounts } from "./learnedWords.js";
import { getSetSize, markDailySetDone, getSetsToday, isTimedSet } from "./dailySet.js";
import { isTutorialRunPending } from "./tutorial.js";
import { rankOf, answerContext, isFirstAnswer, rankHtml, RANK_NAMES } from "./mastery.js";
import { boxKey, classifySpeed, noteSpeedSample, notePendingFirstFast, flushMasteryMeta, keyInputOf } from "./masteryMeta.js";
import { markActiveToday, recordGrowthSnapshot } from "./growthLog.js";
import { computeLegacyLearnedCount } from "./categoryProgress.js";
import { startBgm, stopBgm, setBgmIntensity } from "./bgm.js";
import { renderLearnedCard } from "./learnedCard.js";
import {
  getWordStats,
  getBestScore,
  saveBestScore,
  getCategoryBest,
  saveCategoryBest,
  getSessionLog,
  recordTypingSession,
  appendSessionLog
} from "./storage.js";
import {
  recordPlay,
  recordCorrect,
  recordAnswerSeen,
  recordTypingMiss,
  recordRecallFail,
  recordRecallSuccess,
  isReviewAttempt,
  localDateString
} from "./stats.js";
import {
  startStudyQueue,
  nextStudyWordId,
  onRecallFail as queueRecallFail,
  onRecallSuccess as queueRecallSuccess,
  claimPracticeXp,
  isRecalledToday,
  isWeakOnlyMode,
  isUnresolved,
  isLearningToday,
  isReviewDue,
  getSessionReviewCount,
  getDueReviewCount,
  getDueReviewWords,
  startRetryQueue,
  isPlacementRun,
  startResumedQueue,
  getUpcomingIds,
  getFocusGenre,
  getQueueComposition,
  insertBreather,
  isBeforePlacement
} from "./studyQueue.js";
import { getWeekGoal, getActiveDaysThisWeek } from "./growthLog.js";
import { canInstall, promptInstall } from "./installPrompt.js";
import { recordKeyMiss } from "./keyMiss.js";
import { icon } from "./icons.js";
import { REPEAT_SUCCESS_XP, NEW_WORD_DAILY_SUCCESS_TARGET } from "./studyConfig.js";
import {
  renderStudyQueue,
  updateRecalledToday,
  playRecallSuccessEffect,
  playRecallFailEffect
} from "./studyQueueUi.js";
import { addXp, updateStreak, getTitle } from "./level.js";
import { renderLevelBar, playLevelUpEffect } from "./levelUi.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { markMissionWord, isMissionWordPending, renderMission } from "./mission.js";
import {
  getDailyWords,
  isDailyPlayedToday,
  recordDailyResult,
  renderDailyCard,
  DAILY_BONUS_XP
} from "./dailyChallenge.js";
import { submitDailyScore } from "./dailyRank.js";
import {
  sfxCorrect,
  sfxSoftCorrect,
  sfxMiss,
  sfxReveal,
  sfxLevelUp,
  sfxComplete,
  sfxSparkle
} from "./sfx.js";
import { bumpActivity, markDailyDone } from "./activity.js";
import { allowedWordLevels, filterByAllowedLevels, unlockNoteForLevel, consumeBoostNote, consumePlacementNote } from "./difficulty.js";
import { pushSync, recordPlaySession } from "./sync.js";
import { speak, autoSpeak, speakOnCorrect, getListenRatio } from "./audio.js";
import { renderWordExample, hasExample } from "./wordExample.js";
import { saveSession, clearSession } from "./sessionResume.js";
import { getAfterCorrect, waitAfterCorrect, GLANCE_MS, MILESTONE_MS, ADVANCE_GUARD_MS, ECHO_AFTER_DONE_MS, NOTE_RECHECK_MS } from "./afterCorrect.js";
import { generateCalc } from "./calcCards.js";
import { getNote, setNote, escapeHtml, NOTE_MAX_LENGTH } from "./wordNotes.js";
import { renderWordAi } from "./wordAi.js";
import { editAtCaret } from "./keyboard.js";
import {
  elements,
  showMessage,
  showHiddenWordText,
  showColoredAnswer,
  showAnswerWithReading,
  updateRomajiPreview,
  updateTypedPreview,
  clearTypedPreview,
  updateCombo,
  scrollBehavior,
  announce
} from "./ui.js";

const MODE_KEY = "spelldash_mode";

// デバッグ用: ?t=10 でChallenge/Dailyの時間を短縮できる（battle.htmlと同じ流儀）。Study に効くのは 60 秒の回だけ（既定の語数の Study には効かない）
const durationOverride = Number(new URLSearchParams(location.search).get("t")) || null;
const CHALLENGE_SECONDS = durationOverride ?? 60;
const TIMED_SECONDS = durationOverride ?? 60; // Study の 60 秒の回の長さ（今日のセットの長さ「60秒」。docs/SPEC_MASTERY.md §4）
const TIMED_TICK_MS = 250; // 60 秒の回の時計を描く間隔（既存の timer に載せる）

let mode = localStorage.getItem(MODE_KEY) || "study";
let currentWord = null;
let currentIndex = 0;
// いま受け入れている綴りの候補（先頭が出題語、あとは同じ訳の別解）
let answerCandidates = [];
let typedSoFar = "";
let score = 0;
let typingMissCount = 0;
let recallFailCount = 0;
let time = 60;
let isPlaying = false;
let timer = null;
let correctChars = 0;
let hasMissedCurrentWord = false;
let isRevealed = false;
let startTime = null;
let combo = 0;
let gainedXp = 0;
let activeCategory = "all";

// 今日のセット（Study）: 自力で思い出せたユニーク語を数え、規定数で完了
let setRecalled = new Set();
let setFailed = new Set();
let setLearnEvents = new Map(); // id -> "learned" | "recovered"（完了パネルで語を見せる）
let setNewCount = 0;
let setReviewCount = 0;
let setCompletePending = false;
let currentWordKind = ""; // new / review / weak / repeat / ""

// 回の種類と長さ（Study。startGame で 1 度だけ決める。回の途中で設定が変わっても、この回には効かない）:
//   timed  = 今日のセットの長さが 60 秒（時計で終わる。15 語に届いても終わらない・続きからの地点を残さない・語数のセットの続きを消さない）
//   words  = 語数のセット（腕試し・チュートリアルの回を含む）、retry = 決めた語だけ（もう一度・単語帳の ?words=）、resume = 前回の続きから
let runKind = "words";
let runSize = 15; // 語数（currentSetSize）。timed のときは使わない（getSetSize() の 15）
// 60 秒の回の時計（performance.now の ms）。裏に回った間・覚え方のメモ／覚え方を作る・読む間は止める（期限を後ろへずらす）
let timedDeadline = 0;
let timedHiddenAt = null; // 裏に回った時刻（null = 表）
let timedLastTick = 0; // 前の描画の時刻（止まっていた分を足すため）
let timedWarned = false; // 「残り10秒」を読み上げた
// 回で最初に答えた語の、答える直前の段（習熟度。js/mastery.js）。Study（語数・60 秒）・Challenge・Daily とも。保存しない。
// id -> { before: 段, seenToday: その答えが同じ日の扱いだった（今日もう答えていた）, slowDown: 回の最初の答えが遅い正解で 5 → 4 になった（この回で × があれば偽） }
let runRankBefore = new Map();
// 1 問ごとの速さ（docs/SPEC_MASTERY.md §3.4）: tShow = 出題の文を書いた後の最初の rAF、tFirst = この語の最初のキー、input = その経路（kbd／touch）、
// spill = 前の語の続きが残っていた間に来たキー（測らない）、invalid = 測らない語（音・例文の訳つき・全文入力・計算・英文・空欄・並べ替え・ページの最初の語・裏に回った）
let wordTiming = null;
let keyPath = "kbd"; // いま処理している打鍵の経路（物理キーの keydown = kbd／画面キーボードの合成キー・ソフトウェアキーボードの keydown と input = touch）
let pageWordsShown = 0; // このページで出した語の数（ページを開いて最初の語は測らない）
const ambiguousCache = new Map(); // `${カテゴリ}|${id}` -> isAmbiguousPrompt（カテゴリの全語を走査するので、測るときだけ・語ごとに 1 回）
let wordSerial = 0; // setNewWordごとに増える。正解直後の二重進行防止に使う

// ヒント（Study）: 迷ったら次の1文字だけ見せる。見た時点で「自力」ではなくなる（×扱い）
// 「全く出てこない」と「見れば分かる」の間を埋め、数問後の「思い出せた！」につなげる
const HINT_DELAY_MS = Number(new URLSearchParams(location.search).get("hintms")) || 7000;
const LEECH_FAILS = 4; // これ以上思い出せていない語は「難敵」
let hintUsed = false;
let hintTimer = null;
let retryIds = null; // 「思い出せなかった語だけもう1周」中はその語のID配列
let consecutiveFails = 0; // Studyで連続して思い出せなかった数（3で救済）
let listenMode = false; // 音で出題（日本語を隠して発音だけ聞かせる）

// 全文入力モード（概念カード等、答えが a-z だけでない語）: 1文字ずつではなく Enter で答え全体を判定する。
// 日本語IMEで打てるように、入力欄の値には触らない
let freeMode = false;
let hintChars = 0; // 全文入力モードでヒントで見せた文字数
let awaitingNext = false; // 正解後、次の語へ進むまでの待ち（Enterで即進行）
let advanceTimer = null;
// 次の語が出た直後の 2 つの守り（寿命と使い切りの規則は isAdvanceEcho の上の注釈にまとめる）
let advancedAt = -Infinity; // 正解後の待ちを終えて次の語を出した時刻（直後の Enter／Esc の守り。isAdvanceEcho）
let advancedBy = null; // 次の語へ進んだきっかけ（"timer" = 待ちが終わった／"key" = Enter）
let completedAt = -Infinity; // Study で前の語を打ち終えた時刻（タイマーで進んだときの守り。isAdvanceEcho）
let tailUntil = -Infinity; // 待ちを縮めて次の語を出したときの、次の語の 1 打目の守りの終わり（-Infinity = 守らない。advanceNow が置く。spendTailGuard）
let milestoneThisWord = false; // この語で節目の演出（覚えた のスタンプ・レベルアップの幕）を出した
let learnedCardStale = false; // プレイ中は覚えた単語カードを描かない（畳まれて見えない）。終わったら描く
let keepMessage = false; // この語の結果の行を次の語が出ても残すか（語の名を含む行・節目の行。showResult が決める。advanceNow）
let readingHold = false; // 待ちの間に作った覚え方を読んでいる（自動では進めない。Enter で次へ）
let staleMessageTimer = null;

function isFreeAnswer(word) {
  return !!word && !/^[a-z-]+$/.test(word.en);
}

// Study の待ちの間: 次に出す語（setNewWord と同じ選び方: キューの先頭から、漢字の書き分けのカードを飛ばす）が全文入力か（計算カードも全文入力）。
// キューが空・語が見つからない（setNewWord が埋める語・抽選の語）は分からないので false（待ちを縮めてよい側。そのときは advanceNow が全文入力の語に
// 1 打目の守りを置かない）。セットを終えて次の語を出さないときも false
function nextStudyWordIsFree() {
  if (setCompletePending) return false;
  for (const id of getUpcomingIds()) {
    const word = findWordIn(activeCategory, id);
    if (word?.kanjiOnly) continue;
    return !!word && (!!word.calc || (romajiEntriesFor(word).length === 0 && isFreeAnswer(word)));
  }
  return false;
}

// ローマ字モード（日本語の答え: 鎌倉幕府 など）: 漢字に変換せず、読みをローマ字で打つ（2026-10 創業者指示。js/romaji.js）。
// 1打ずつ判定し（英単語の綴り入力と同じ 1 ミス＝不正解）、どれかの読みを打ち終えたら Enter なしで正解。
// 入力欄は読み取り専用にして IME・OS キーボードを開かせない（keydown は届く）。打ったかなと、その下に打ったキーを出す。
// かなの読みが 1 つもないカード（自分で作った場面カードなど）は従来どおり全文入力（IME で打って Enter）
let romajiMode = false;
let romaji = null; // いまの読みの判定（createRomajiMatcher）。答えを見た後は主な読みだけ
let romajiEntries = [];

// 語を打ち終えた直後の打鍵の持ち越し止め（打ち越し防止）。ローマ字と英単語で共通:
// - ローマ字: 終えた語の読みの続き（語末の ん の 2 つ目の n、いわじゅく で終えた後の いせき）
// - 英単語: 出題語で完成したときの、より長い候補の続き（gym で完成した後の nasium、a の後の n、sport の後の s。K0-1）
// 記録は 1 つ（spill）。Study・Challenge・Daily とも、物理キー・画面キーボード・Android の input 経路とも同じ:
// 1. Study の正解後の待ちの間（次の語はまだ無い）: 続きのキーは間がいくら空いても続きに食わせる（takeSpill）。続きを打っている間は
//    タイマーで次の語を出さない（completeWord の tick: 次の語を出す時刻 = max(本来の待ちの終わり, 最後の続きの打鍵 + SPILL_HOLD_MS〔まだ続く〕
//    ／+ SPILL_TAIL_MS〔打ち切った・読みを閉じた。2 打以上のときだけ。語末の ん の 2 つ目の n・an の n のような 1 打の続きは本来の待ちを変えない〕））。
//    ただし次の語が全文入力のときは、2 打以上の続きを打ち切った後も待ちを縮めない（+ SPILL_TAIL_MS の代わりに + 本来の待ちの長さ。PR #153 より前の数え直し。
//    全文入力の語は 1 打ずつ判定しないので、続きの直後の余分な 1 打が入力欄に入ってしまう。全文入力の語は稀でテンポへの影響は小さい。REVIEW-155 の 1）。
//    次の語を出す時刻が本当に SPILL_TAIL_MS で決まった（本来の待ちの終わりより後だった＝待ちを縮めた）ときだけ、次の語の 1 打目の守りを置く
//    （続きの直後の余分な 1 打＝空白・gymnasiums の s を、待ちの間に捨てられたのと同じくミスにせず捨てる。幅と使い切りの規則は isAdvanceEcho の上の注釈）
// 2. 次の語が出た後（judgeKey）: 完成後の 1 打を「続きの見方」と「次の語」の両方に食わせ、どちらかが拒んだ時点で 1 回だけ解決する
//    - 続きだけが受ける → 続きとして飲む（次の語の打鍵にしない。ミスにしない。1 打 0.9 秒の gymnasium の続き、an の n）
//    - 次の語だけが受ける → 次の語の打鍵（続きは終える）
//    - 両方が受ける（引き分け）→ 次の語に入れて見せたまま（入力欄・typedPreview）記録し（spill.shared）、次の打鍵で決める。
//      次の語がその字で出題語として完成したら次の語の正解（in → inside の続きが次の語 side そのもの、another → another one の one）。
//      ただし続きがまだ続くのに次の語が完成するとき（out → outdoors の続き do|ors と次の語 do）はここでは決めず保留する（shared.hold "finish"。
//      字は次の語に見せるが受理しない）。別解としての完成（hall → hallway の way と次の語 manner の別解 way）は続きが勝つ
//      （別解は答えを見た扱いで自力にならないので、続きを打った人の次の語に付けない）。続きがまだ続くとき（hallways の ways）も同じで、
//      窓の外で 2 字以上でも保留 typo にはせず、この字で続きと決めて引き分けの字を外す（この字は次の語も受ける字で、打ち間違いではない）
//    - 両方が拒む → 普通のミス。ただし引き分けの字を外せばこの字が次の語の 1 打目として通るなら、外して 1 打目にする
//      （an の n をあけて打ち、次の語 not を n から打つ。gym の後の n・a を打ちかけて止め、name を n から打つ）。黙って外せないとき
//      （下の取り消しの規則。窓の外で 2 字以上）は、打ち直しか打ち間違いかをその場で決めず保留する（shared.hold "restart"。字は見せない）:
//      次の打鍵で、保留の字 ＋ その字が次の語の頭から通れば打ち直しだった（引き分けの字を外し、保留の字を 1 打目に。name の n・a）、
//      通らなければ保留の字が打ち間違い（「違う」・1 ミス。in → six の s・i のあと x を s と打ち間違えた → 黙って消さない）
//    - 引き分けの字を次の語から外す（取り消す）のは、字が窓（最後の打鍵から SPILL_GAP_MS）の中で打たれた・続きがすでに始まっていた
//      （続きだけが受けた字がある）・1 字・この字で続きを打ち切った のどれかなら黙って行う。それ以外（窓の外で 2 字以上）はここでは決めず
//      保留する（shared.hold "typo"。字は続きにだけ食わせ、次の語には見せない）: 続きを打ち切れば全部が続きだった（黙って外す。
//      1 打 0.9 秒の inside と次の語 six）、続きが拒めば次の語を打ち続けていた（保留の字は打ち間違い＝「違う」・1 ミス。
//      in のあと six の s・i をゆっくり打ってから d → x）。続きが拒んだ字が次の語の 1 打目として通るなら（gym の後の n・a・s → name の n）、
//      続きを打ちかけてやめて打ち直したのかもしれないので、保留 restart に切り替えて次の打鍵で決める
//    - 保留は次の打鍵・Enter・時間切れ（finish は SPILL_HOLD_MS、typo・restart は SPILL_LATE_MS）で決まる（時間切れは次の語の勝ち: finish は保留の字で完成、
//      typo・restart は打ち間違い）。finish を時間切れで決めたときは、続きの残り（outdoors の ors）も echo として飲む（1 打 1.5 秒より遅く
//      outdoors を打つ人の残りを次の次の語の×にしない）。引き分けの字そのものは時間で消さない（見せている字を本人の操作なしに消さない）。
//      最後の打鍵から SPILL_LATE_MS を過ぎたら続きの見方は終える（引き分けの字の記録だけ残り、次の語を 1 打目から打ち直せば外して 1 打目にする）
//    - 続きで次の語が完成したら（another one の one、保留 finish の do）、同じ語をもう一度なぞる打鍵は飲む（echo: 完成した語を続きとして
//      張り直す。another one と打った人が出題が one に変わったのを見て one をもう一度打っても、3 語目に流れない）。Challenge で 3 語目が
//      全文入力なら英単語の echo は作らない（setNewWord と同じ。startSpellingSpill）。保留の字で前の語が完成したキー（judgeKey の "again"）は
//      新しい語へ流し直し、新しい語が全文入力なら字を入力欄に入れる（前の語の判定で preventDefault 済みのキーでも黙って消さない）
//    Enter は引き分けの字を次の語に入っているものとして普通に判定する（候補に一致していればその語で確定、そうでなければ答えを開く）。
//    ただし保留 finish は保留の字で確定（打った語で確定）。保留 typo・restart の字は捨てる（見せていない。ミスに数えない）。続きが終わっていて直後（続きの最後の打鍵から ECHO_AFTER_DONE_MS）の Study の Enter は、
//    「打ち終えたら Enter で次へ」の癖として字を外して 1 回だけ飲む（窓の内外によらない。2 回目は見えている字で普通に判定＝答えが開く）
//    Enter で自分から次へ進んだとき・答えを見たとき・本当のミス・ヒントのときは捨てる
// spill = { kind: "romaji" | "spelling", keyOf(event) → 続きと比べるキー（null = 比べない。Shift など）,
//           take(key) → "more"（まだ続く）| "closed"（読みを閉じた〔語末の ん の 2 つ目の n〕が、長い読みにまだ続けられる）| "end"（続きを打ち切った）
//                       | null（続きでない。状態は変えない）,
//           rest() → 続きの残りの綴り（英単語だけ。ローマ字は null）,
//           at: 最後に食わせた打鍵の時刻, n: 完成後に食わせた打鍵の数, live: まだ続けて打てる, ended: 最後の打鍵で打ち切った・閉じた（待ちを延ばさない）,
//           extra: 打ち切った・閉じた後に、続きでない打鍵が待ちの間に来て捨てた（続きの直後の余分な 1 打はもう来た。次の語の 1 打目の守りを置かない）,
//           shared: null | { serial: 次の語の wordSerial, keys, typed: 受理した後の次の語の打鍵, inWindow: 全部が窓の中, underway: 続きがすでに始まっていた,
//                            hold: null | { why: "finish" | "typo" | "restart", key: 保留の字, next: その打鍵の判定,
//                                           echo（finish: 完成した語をなぞる打鍵を飲む記録）, rest（finish: 保留にした時点の続きの残り） } } }
let spill = null;
let spillTimer = null; // 保留（shared.hold）の時間切れ（resolveHoldByTime）
// 正解後の待ちに入ったときに入力欄に残っている打ち終えた綴り（Android の input 経路。待ちの 1 回目の入力だけ比べる）。
// 続きの記録（spill）とは別に持つ: 完成の後に続き（エコー）を始め直しても消さず、入力欄を空にしたときだけ消す（REVIEW-153 の 1）
let waitInputBase = "";
const SPILL_GAP_MS = 600; // 窓（js/typingDrill.js の SPILL_GAP_MS と同じ値）。引き分けの字をこの中で打っていれば黙って外せる
const SPILL_HOLD_MS = 1500; // Study: 続きを打っている間、タイマーで次の語を出さない長さ（最後の続きの打鍵から）
const SPILL_TAIL_MS = 250; // Study: 続きを打ち切った後、次の語を出すまで置く長さ（直後の余分な 1 打＝空白・gymnasiums の s を待ちの間に捨てる）
const SPILL_LATE_MS = 4000; // 続きの見方と保留を残す長さ（最後の打鍵から。綴りを思い出しながらの 2〜3 秒の迷いも入る）
const SPILL_RECHECK_MS = 100; // Study: 続きを打っている間、タイマーで次の語を出すかを見直す間隔

function clearSpill() {
  const hold = spill?.shared?.hold;
  if (hold?.why === "finish") hold.next.show(false); // 次の語に見せていた保留の字は入力欄から戻す（受理はしていない）
  spill = null;
  clearTimeout(spillTimer);
  spillTimer = null;
}

function startSpill(kind, keyOf, take, rest = () => null) {
  clearSpill();
  spill = { kind, keyOf, take, rest, at: performance.now(), n: 0, live: true, ended: false, extra: false, shared: null };
}

// 待ちの間に来て捨てた打鍵が続きでなかった（続きに食わせなかった字・空白）: 打ち切った・閉じた後なら、続きの直後の余分な 1 打はもう来た
// （次の語の 1 打目の守りを置かない。まだ続く途中なら、続きの記録はそのまま＝ローマ字の読みの間の空白は続きを終えない）
function noteWaitExtra() {
  if (spill?.ended) spill.extra = true;
}

// 印字できる 1 字の打鍵（修飾キー〔Ctrl・⌘・Alt〕なしの 1 文字。空白を含む）なら event.key、そうでなければ null（Shift・Backspace・Enter など）
function printableKey(event) {
  return !event.ctrlKey && !event.metaKey && !event.altKey && [...String(event.key ?? "")].length === 1 ? event.key : null;
}

// 入力欄の値の、頭から n 個目の英字（a-z。大文字も数える）より後ろ（Android の input 経路: 判定は小文字の a-z だけを見るが、
// 入力欄には打たれたとおりの字〔大文字・空白・記号〕が入っている）
function afterLetters(text, n) {
  if (n <= 0) return text;
  let seen = 0;
  for (let i = 0; i < text.length; i++) if (/[a-z]/i.test(text[i]) && ++seen === n) return text.slice(i + 1);
  return "";
}

// ローマ字: 終えた語の判定（matcher）に続きのキーを食わせる。語末の ん を n 1 つで終えた後の 2 つ目の n は、読みを閉じただけ
// （長い読み〔荘園 → 荘園制〕にまだ続けられても "closed"。nn で ん を終える人の待ちを延ばさない）
function startRomajiSpill(matcher) {
  startSpill("romaji", romajiKeyOf, (key) => {
    const singleN = matcher.state().endedWithSingleN;
    if (!matcher.feed(key).ok) return null;
    const st = matcher.state();
    return !st.canContinue ? "end" : singleN && st.done && !st.endedWithSingleN ? "closed" : "more";
  });
}

// 英単語: 続きの綴りの残り（left）を 1 字ずつ減らす。キーは綴り入力と同じく event.key の 1 文字（小文字）。
// a-z のキーは、続きの頭の a-z 以外（空白・ハイフン・スラッシュ・数字）を読み飛ばして比べる
// （Android の input 経路は a-z しか届かない。a → a large の " large"、rest → rest api の " api"）
function startSpellingSpill(rests) {
  // 全文入力の語には英単語の続きを持ち越さない（setNewWord の守りと同じ）。Challenge は完成の直後に次の語が出ているので、
  // 引き分けの完成・保留の決着のエコー（startEchoSpill）が次の語の後に来る。綴りの続きを作る入口はここに集まるので、ここで止める（REVIEW-153 の 4）
  if (freeMode) {
    clearSpill();
    return;
  }
  let left = rests;
  startSpill(
    "spelling",
    (event) => printableKey(event)?.toLowerCase() ?? null,
    (key) => {
      const skip = /^[a-z]$/.test(key);
      const next = left.map((r) => (skip ? r.replace(/^[^a-z]+/, "") : r)).filter((r) => r[0] === key).map((r) => r.slice(1));
      if (next.length === 0) return null;
      left = next.filter(Boolean);
      return left.length > 0 ? "more" : "end";
    },
    () => left
  );
}

// 続きで次の語が完成した後: 同じ語をもう一度なぞる打鍵を飲むために、完成した語を続きとして張り直す（上の 2 の echo）。
// 完成の側が新しい持ち越し止め（完成した語のさらに長い候補）を始めていれば、そちらを優先する。Challenge で次の次の語が全文入力なら
// 英単語のエコーは作らない（startSpellingSpill）。Study の待ちに入っていても、入力欄の基準（waitInputBase）は消さない
function startEchoSpill(echo) {
  if (spill || !echo) return;
  if (echo.kind === "spelling") startSpellingSpill(echo.rests);
  else startRomajiSpill(createRomajiMatcher(echo.entries));
}

// 続きに 1 打を食わせた結果を記録する。「打ち終えた」時刻（isAdvanceEcho の 1.2 秒）もここから数える
function advanceSpill(s, result, now = performance.now()) {
  s.at = now;
  s.n++;
  s.live = result !== "end";
  s.ended = result !== "more";
  s.extra = false; // 閉じた読みの続き（長い読み）を打ち足した: 余分な 1 打はまだ来ていない
  completedAt = now;
}

// 続きに 1 打を食わせる。受けたら時刻・数・live を進める
function feedSpill(key) {
  if (!spill?.live || !key) return null;
  const result = spill.take(key);
  if (!result) return null;
  advanceSpill(spill, result);
  return result;
}

// Study の正解後の待ちの間・続きを完成させた入力と同じ入力の残り（次の語はまだ無い）: 続きのキーは間が空いても飲む。
// 続きでないキーは持ち越し止めを終える（打ち切った後に来たキーは捨てるだけ。次の語を出す時刻は変えない）
function takeSpill(key) {
  if (!spill?.live || !key) return false;
  if (feedSpill(key)) return true;
  clearSpill();
  return false;
}

// Android の input 経路の、待ちの間・続きを完成させた入力と同じ入力の残り: 字（a-z）は 1 字ずつ続きに食わせる（takeSpill）。
// 続きでない字が来た・最後の字の後ろに字でない打鍵（空白・記号。a-z だけを比べるので続きには食わせない）があれば、打ち切った後の余分な 1 打
// （keydown の待ちの枝と同じ。noteWaitExtra）
function takeSpillText(letters, trailing) {
  let taken = true;
  for (const ch of letters) if (!(taken = takeSpill(ch))) break;
  if (!taken || trailing) noteWaitExtra();
}

// Study の待ちの tick: 続きを打っている間は次の語を出さない。残りの ms（0 以下なら出してよい）。
// endedMs = 2 打以上の続きを打ち切った・閉じた後に置く長さ（SPILL_TAIL_MS。次の語が全文入力なら本来の待ちの長さ）
function spillHoldLeft(endedMs) {
  const s = spill;
  if (!s || s.n === 0) return 0;
  const until = s.live && !s.ended ? s.at + SPILL_HOLD_MS : s.n >= 2 ? s.at + endedMs : -Infinity;
  return until - performance.now();
}

// 引き分けの記録（spill.shared。上の spill の形）を作る。serial はいまの次の語、保留はまだ無い
function makeShared(keys, typed, inWindow, underway) {
  return { serial: wordSerial, keys, typed, inWindow, underway, hold: null };
}

// 引き分けの記録がいまの次の語の打鍵と合っているか（別の語・答えを見た・ヒントで足した字があれば合わない）
function sharedValid(s) {
  return !!s.shared && s.shared.serial === wordSerial && !isRevealed && s.shared.typed === nextTyped();
}

// 引き分けの字を次の語から黙って外して続きとしてよいか（上の「取り消し」の規則）
function canWithdraw(shared) {
  return shared.inWindow || shared.underway || shared.keys.length === 1;
}

// 次の語の入力欄に見せている字: 受理した字 ＋ 保留 finish の字（Android の input 経路が値と比べる基準）
function shownTyped() {
  const hold = spill?.shared?.hold;
  return typedSoFar + (hold?.why === "finish" && sharedValid(spill) ? hold.key : "");
}

// 保留を始める（finish: この字で次の語が完成するが続きもまだ続く。typo: 続きだけが受けたが引き分けの字を黙って外せない）。
// 引き分けの記録（s.shared）は呼び元が用意する（finish は無ければ作る。typo は引き分けの字があるときだけ呼ぶ）
function startHold(s, next, why, result) {
  s.shared.hold = { why, key: next.key, next, echo: why === "finish" ? next.echo() : null, rest: why === "finish" ? s.rest() : null };
  advanceSpill(s, result);
  if (why === "finish") next.show(true);
  clearTimeout(spillTimer);
  // finish の時間切れは SPILL_HOLD_MS（続きを打つ人の次の 1 打を待つ長さ。Study の「続きを打っている間は次の語を出さない」と同じ）。
  // 次の語を正しく打った人（out の後の do）をそれ以上待たせない（REVIEW-keys M2）。typo は SPILL_LATE_MS（迷いながら続きを打つ人を待つ）
  spillTimer = setTimeout(resolveHoldByTime, why === "finish" ? SPILL_HOLD_MS : SPILL_LATE_MS);
}

// 保留 restart を始める: 両方が拒むが、この字は次の語の 1 打目として通り、引き分けの字を黙って外せない（窓の外で 2 字以上）。
// 打ち直し（引き分けの字は続きの打ちかけだった。gym の後の n・a → name）か打ち間違い（次の語を打ち続けていた。in の後の s・i → x のつもりの s）かを
// 次の打鍵で決める。字は次の語に見せず、続きにも食わせない（typo の保留から切り替えるときは、typo の保留の字は続きの打ちかけとして捨てる）
function startRestartHold(s, next) {
  s.shared.hold = { why: "restart", key: next.key, next, echo: null, rest: null };
  clearTimeout(spillTimer);
  spillTimer = setTimeout(resolveHoldByTime, SPILL_LATE_MS);
}

// 保留を次の語の勝ちで決める: finish は保留の字で次の語を完成（同じ語をなぞる打鍵は echo で飲む）、typo・restart は保留の字を打ち間違いに。
// 完成したら true（この後に届いた字は新しい語のもの）。byTime = 時間切れで決めた
function resolveHoldToNext(s, byTime = false) {
  const { hold } = s.shared;
  clearSpill();
  if (hold.why !== "finish") {
    hold.next.miss(hold.key);
    return false;
  }
  if (hold.next.tryAccept() !== "done") {
    hold.next.miss(hold.key); // 保留の間に状態が変わって完成しなくなった（まず無い）: 打ち間違いとして数える
    return false;
  }
  // 時間切れで決めたときは、続きの残り（outdoors の ors）もなぞる打鍵として飲む（1 打 1.5 秒より遅く outdoors を打つ人の残りを
  // 次の次の語の×にしない。Study は待ちの間に飲み、続きを打つ間は次の語を待たせる）。Enter で確定したときは打った語で終わり
  const rest = byTime && hold.echo?.kind === "spelling" ? hold.rest ?? [] : [];
  startEchoSpill(rest.length > 0 ? { ...hold.echo, rests: [...hold.echo.rests, ...rest] } : hold.echo);
  return true;
}

// 保留のまま打鍵が止まった（最後の打鍵から finish は SPILL_HOLD_MS、typo・restart は SPILL_LATE_MS）: 次の語が勝つ
function resolveHoldByTime() {
  spillTimer = null;
  const s = spill;
  if (!isPlaying || !s?.shared?.hold || !sharedValid(s)) return;
  resolveHoldToNext(s, true);
}

// Enter／Esc のとき: 引き分け・保留の決着。true ならこの Enter はここで消費した（答えは開かない）。
// 保留 finish は保留の字で確定（Enter は打った語で確定）。続きが終わっていて直後（続きの最後の打鍵から ECHO_AFTER_DONE_MS）の Study の Enter は
// 「打ち終えたら Enter で次へ」の癖＝字を外して 1 回だけ飲む（2 回目は字が消えた状態で普通に判定）。それ以外は見せている字のまま普通に判定する
// （保留 typo・restart の字は捨てる。見せていない字なのでミスにはしない）。どれも続きの見方はここで終える（Enter の先は確定か答え表示）
function resolveSharedForEnter() {
  const s = spill;
  if (!s?.shared || !sharedValid(s)) return false;
  const { hold } = s.shared;
  if (hold?.why === "finish") return resolveHoldToNext(s);
  const echo = !hold && !s.live && mode === "study" && performance.now() - s.at <= ECHO_AFTER_DONE_MS;
  if (echo) {
    clearNextTyped();
    advancedAt = -Infinity; // 飲むのは 1 回だけ（isAdvanceEcho にも 2 回目を飲ませない）
    completedAt = -Infinity;
  }
  clearSpill();
  return echo;
}

// 次の語の 1 打（keydown・画面キーボード・Android の input・ローマ字で共通）。前の語の続き（spill）があれば両方に食わせて解決する（上の 2）。
// next = { key: 次の語に食わせるキー, contKey: 続きに食わせるキー（null = 続きとは比べない）,
//          tryAccept() → "done"（受理して完成）| "more"（受理）| null（拒む。状態は変えない）,
//          finishes() → この字で次の語が完成する綴り（null = 完成しない。状態は変えない）, own(done) → その完成が出題語（別解でない）か,
//          firstFits() → このキーが次の語の 1 打目として通るか（状態は変えない）, fitsFromStart(keys) → この打鍵の列が次の語の頭から通るか（状態は変えない）,
//          show(on) → 保留 finish の字を入力欄に見せる／戻す,
//          echo() → 完成した語をなぞる打鍵を飲むための記録, miss(typed = key) → ミス（typed は打ち間違えた字） }
// 返り値 "again" = 保留の字で前の語が完成したので、この字は新しい語に食わせ直す（呼び元が同じ event をもう一度流す）
function judgeKey(next) {
  const now = performance.now();
  // 次の語の 1 打目の守り（待ちを縮めて出したときだけ。isAdvanceEcho の上の注釈）: 次の語が拒む字（続きの直後の空白・複数形の s）はミスにせず捨てる。
  // 守りは最初の打鍵で使い切る（この打鍵が次の語に受けられても、続きに飲まれても）
  const tail = spendTailGuard();
  let s = spill;
  if (s && (s.shared ? !sharedValid(s) : now - s.at > SPILL_LATE_MS || !s.live)) {
    clearSpill();
    s = null;
  }
  // 前の語の続きが残っている間に来た打鍵がこの語の最初の字になったら、この語の速さは測らない（markFirstKey）
  if (s && wordTiming && wordTiming.tFirst === null) wordTiming.spill = true;
  if (!s) {
    if (!next.tryAccept() && !tail) next.miss();
    return;
  }
  const late = now - s.at > SPILL_LATE_MS; // 続きの見方は終わっている（引き分けの字の記録だけ残る）
  const hold = s.shared?.hold;
  if (hold?.why === "restart") {
    // 保留 restart: 保留の字 ＋ この字が次の語の頭から通れば打ち直しだった（引き分けの字を外し、保留の字を 1 打目に受理。この字は流し直す）。
    // 通らなければ保留の字が打ち間違い（「違う」・1 ミス。この字は捨てる。typo の保留と同じ）
    if (!next.fitsFromStart(hold.key + next.key)) {
      resolveHoldToNext(s);
      return;
    }
    clearNextTyped();
    clearSpill();
    if (!hold.next.tryAccept()) {
      hold.next.miss(hold.key); // 外した後の 1 打目が通らない（まず無い）: 打ち間違いとして数える
      return;
    }
    return "again";
  }
  if (hold) {
    const cont = !late && next.contKey ? s.take(next.contKey) : null;
    if (cont) {
      // 続きがまだ受ける: finish の保留の字も続きだった（引き分けの字を外して続きに戻る）。typo はまだ決めない。続きを打ち切れば全部が続きだった
      if (hold.why === "finish") {
        clearNextTyped();
        s.shared = null;
      }
      advanceSpill(s, cont, now);
      clearTimeout(spillTimer);
      spillTimer = null;
      if (cont === "end") {
        if (s.shared) clearNextTyped();
        clearSpill();
      } else if (s.shared) spillTimer = setTimeout(resolveHoldByTime, SPILL_LATE_MS); // 保留の時間切れは最後の打鍵から数える
      return;
    }
    // 続きが拒む（または 4 秒過ぎ）。typo の保留中で、この字が次の語の 1 打目として通るなら、続きを打ちかけてやめて次の語を打ち直したのかもしれない
    // （gym の後の n・a・s → name の n）: 保留 restart に切り替えて次の打鍵で決める
    if (hold.why === "typo" && next.firstFits()) {
      startRestartHold(s, next);
      return;
    }
    // 次の語が勝つ。finish なら保留の字で完成し、この字は新しい語へ。typo なら打ち間違い（この字は捨てる）
    return resolveHoldToNext(s) ? "again" : undefined;
  }
  const inWindow = now - s.at <= SPILL_GAP_MS;
  const underway = s.shared ? s.shared.underway : s.n > 0;
  const cont = s.live && !late && next.contKey ? s.take(next.contKey) : null;
  let accepted = null;
  let echo = null;
  let altDone = false; // この字で次の語が別解として完成する（続きが勝つ）
  if (cont) {
    const done = next.finishes();
    if (done && !next.own(done)) {
      // 別解としての完成: 続きが勝つ（下の「続きだけが受ける」へ）
      altDone = true;
    } else if (done && cont === "more") {
      // 次の語はこの字で完成するが、続きもまだ続く（out → outdoors の do と次の語 do）: 決めずに保留。字は見せる
      if (!s.shared) s.shared = makeShared("", nextTyped(), inWindow, underway);
      startHold(s, next, "finish", cont);
      return;
    } else {
      if (done) echo = next.echo();
      accepted = next.tryAccept();
    }
  } else accepted = next.tryAccept();
  if (cont && !accepted) {
    // 続きだけが受ける: 引き分けだった字は続きだったので次の語から外す。黙って外せないとき（窓の外で 2 字以上）は保留（この字で打ち切ったなら全部が続き）。
    // 別解としての完成（hall → hallways の続き ways と次の語 manner の別解 way の y）は保留しない: この字は次の語も受ける字で打ち間違いではなく、
    // 別解は答えを見た扱いで続きに勝てないので、ここで続きと決めて引き分けの字を外す（窓の外で 2 字以上でも。REVIEW-153 の 2）
    if (s.shared && !altDone && !canWithdraw(s.shared) && cont !== "end") {
      startHold(s, next, "typo", cont);
      return;
    }
    if (s.shared) clearNextTyped();
    s.shared = null;
    advanceSpill(s, cont, now);
    return;
  }
  if (!cont && accepted) {
    // 次の語だけが受ける: 続きは終える（引き分けだった字は次の語のもの）。完成して新しい持ち越し止めに替わっていたら触らない
    if (spill === s) clearSpill();
    return;
  }
  if (!cont && !accepted) {
    // 両方が拒む: 引き分けの字を外せばこの字が 1 打目として通るなら、外して 1 打目にする（an の n → not の n、gym の n を打ちかけて name の n）。
    // 黙って外せないとき（窓の外で 2 字以上）は、打ち直し（gym の後の n・a → name）か打ち間違い（in の後の s・i → x のつもりの s）かを次の打鍵で決める
    if (s.shared && next.firstFits()) {
      if (!canWithdraw(s.shared)) {
        startRestartHold(s, next);
        return;
      }
      clearNextTyped();
      clearSpill();
      if (!next.tryAccept()) next.miss();
      return;
    }
    clearSpill();
    if (!tail) next.miss();
    return;
  }
  // 引き分け: 次の語がこの字で完成したら次の語の正解（持ち越し止めは完成の側が替えてある。同じ語をなぞる打鍵は echo で飲む）。
  // そうでなければ記録して次の打鍵を待つ
  if (accepted === "done") {
    startEchoSpill(echo); // 完成の側（acceptChar・finishRomajiWord）が持ち越し止めを替えるか消してある
    return;
  }
  s.shared = makeShared((s.shared?.keys ?? "") + next.key, "", (s.shared?.inWindow ?? true) && inWindow, underway);
  advanceSpill(s, cont, now);
  s.shared.typed = nextTyped();
}

// 綴り入力の次の語の 1 打（keydown と Android の input 経路で共通）。accept(typedChar) は受理（完成なら true を返す）
function judgeSpellingKey(typedChar, contKey, accept) {
  const fits = (typed) => viableAnswers(activeCandidates(), typed).length > 0;
  return judgeKey({
    key: typedChar,
    contKey,
    tryAccept: () => (fits(typedSoFar + typedChar) ? (accept(typedChar) ? "done" : "more") : null),
    finishes: () => (fits(typedSoFar + typedChar) ? completedAnswer(activeCandidates(), typedSoFar + typedChar) : null),
    own: (done) => done === currentWord.en || isSpellingVariant(done, currentWord.en),
    firstFits: () => fits(typedChar),
    fitsFromStart: (keys) => fits(keys),
    show: (on) => {
      const shown = typedSoFar + (on ? typedChar : "");
      elements.input.value = shown;
      updateTypedPreview(shown);
    },
    echo: () => ({ kind: "spelling", rests: [typedSoFar + typedChar] }),
    miss: (typed = typedChar) => handleTypingMiss(currentWord.en[currentIndex], typed)
  });
}

function romajiEntriesFor(word) {
  if (!word || word.calc || word.kanjiOnly || word.write || word.blank || !isConceptWord(word)) return [];
  if (!hasJapaneseScript(word.en)) return [];
  const entries = readingEntries(word);
  // かなの読みが無い（英字の別解だけの自分の場面カード）は、答えを打てないので全文入力に戻す
  return entries.some((e) => hasKana(e.reading)) ? entries : [];
}

// 入力欄: ローマ字モードでは読み取り専用（IME も OS キーボードも開かない。keydown は届く）
const INPUT_LABEL = "英単語を入力";
function setInputRomaji(on) {
  const input = elements.input;
  if (!input) return;
  const changed = input.readOnly !== on;
  input.readOnly = on;
  input.setAttribute("aria-label", on ? "読みをローマ字で入力（変換しない）" : INPUT_LABEL);
  // フォーカス中に切り替わったら付け直す（IME の状態と、前のカードで開いた OS キーボードを捨てさせる）
  if (changed && document.activeElement === input) {
    input.blur();
    input.focus({ preventScroll: true });
  }
}

function resetRomajiMode() {
  romajiMode = false;
  romaji = null;
  romajiEntries = [];
  clearSpill();
  document.body.classList.remove("romaji-answer");
  setInputRomaji(false);
}

function primaryRomajiEntry() {
  return primaryReading(romajiEntries);
}

function renderRomaji() {
  if (!romaji) return;
  elements.input.value = romaji.keys; // 値は見えない（文字色は透明）。プレースホルダを消すため
  updateRomajiPreview(romaji.state());
}

// 表記ゆれを吸収して比較（全角/半角・空白・記号・大文字小文字・アポストロフィ）
function normalizeAnswer(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・／/\-‐－_（）()「」『』.,、。:：;；?？!！'’"”“]/g, "");
}

function answerMatches(word, text) {
  const typed = normalizeAnswer(text);
  if (!typed) return false;
  const candidates = [word.en, ...(Array.isArray(word.accept) ? word.accept : [])];
  return candidates.some((c) => normalizeAnswer(c) === typed);
}

// 英作文: 語ごとに比べて、最初に違う語の位置を返す（語順・時制の誤りを指摘するため）
function splitWords(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.,、。:：;；?？!！"”“]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

function firstWordDiff(answer, typed) {
  const a = splitWords(answer);
  const t = splitWords(typed);
  const shown = String(answer ?? "").replace(/[.,、。:：;；?？!！"”“]/g, "").split(/\s+/).filter(Boolean); // 表示用（大文字を保つ）
  for (let i = 0; i < Math.max(a.length, t.length); i++) {
    if (a[i] !== t[i]) return { index: i, expected: shown[i] ?? "", typed: t[i] ?? "", total: a.length, typedTotal: t.length };
  }
  return null;
}

// 並べ替え: 答えの語をシャッフル（元の順と同じにならないように。カードごとに固定）
let bankWords = [];
function buildWordBank(word) {
  const words = String(word?.en ?? "").replace(/[.?!]$/, "").split(/\s+/).filter(Boolean);
  if (words.length < 2) return words;
  let shuffled = words.slice();
  for (let attempt = 0; attempt < 8; attempt++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (shuffled.join(" ") !== words.join(" ")) break;
  }
  return shuffled;
}

function renderExplain(word) {
  const el = document.getElementById("wordExplain");
  if (el) el.textContent = word?.explain ? word.explain : "";
  renderWordExample(document.getElementById("wordExample"), word); // 例文（英単語カード）も同じタイミングで出す
}

export function setActiveCategory(categoryId) {
  activeCategory = categoryId;
}

export function isGamePlaying() {
  return isPlaying;
}

export function getMode() {
  return mode;
}

let modeInitialized = false;

// Study / Challenge の切り替え。プレイ中なら中断する
export function setMode(newMode) {
  if (mode === newMode && modeInitialized) return;
  modeInitialized = true;

  mode = newMode;
  stopGame();
  localStorage.setItem(MODE_KEY, newMode);

  document.body.classList.toggle("mode-study", mode === "study");
  // カード下の数字のラベル: Study は「思い出せた」、Challenge は「正解」（index.html の初期値は Study 側）
  const scoreLabel = elements.score?.previousElementSibling;
  if (scoreLabel && scoreLabel.tagName === "SPAN") scoreLabel.textContent = mode === "study" ? "思い出せた" : "正解";

  document.querySelectorAll(".mode-switch__btn").forEach((btn) => {
    btn.classList.toggle("mode-switch__btn--active", btn.dataset.mode === mode);
  });

  showIdleMessage();
}

function showIdleMessage() {
  if (mode === "study") {
    showMessage(nextRunIsTimed() ? "Enter で開始（60秒）" : "Enter で開始");
  } else {
    showMessage("Enter で開始（60秒）");
  }
}

// 次に始まる Study の回が 60 秒か（今日のセットの長さが 60 秒で、腕試し前でもチュートリアルの回でもない）。待ち受けの文と完了パネルの「もう60秒」に使う。
// 回の種類そのものは startGame が決める（腕試しは組めたときだけ語数で走る: isPlacementRun）
function nextRunIsTimed() {
  return isTimedSet() && !isBeforePlacement() && !isTutorialRunPending();
}

function timedRun() {
  return mode === "study" && runKind === "timed";
}

// ゲームが終わった／止まったことをホームに知らせる（専用キーボードを畳む等）
function notifyGameEnd() {
  if (learnedCardStale) {
    learnedCardStale = false;
    renderLearnedCard();
  }
  document.body.classList.remove("placement"); // 腕試しの途中でやめても数字1行は戻す（css/home.css）
  resetRomajiMode(); // 入力欄を読み取り専用のままにしない（道のスタートの Enter・他の画面の入力に戻す）
  window.dispatchEvent(new CustomEvent("spelldash:game-end", { detail: { mode } }));
}

export function stopGame() {
  clearInterval(timer);
  isPlaying = false;
  timedHiddenAt = null;
  wordTiming = null;
  flushMasteryMeta(); // 速さの基準・確かめの集計（変わっていなければ書かない。机に戻るたびに走る）
  notifyGameEnd();
  document.body.classList.remove("is-playing");
  stopBgm();
  currentWord = null;
  dailyRun = null; // 中断したDailyはロックせず、カードからやり直せる
  document.body.classList.remove("set-done");
  elements.japanese.textContent = ""; // 内部モード名（Study Mode 等）は出さない。完了の見出しは結果パネルの 1 つだけ
  setPromptLabel("");
  renderPromptContext(null);
  showHiddenWordText("");
  updateCombo(0);
  updateBigTimer();
  renderPlayScore();
  hideResultPanel();
  renderStudyQueue(false);
  renderSetProgress();
  hideHint();
  renderWordNote(null);
  renderExplain(null);
  clearTimeout(advanceTimer);
  awaitingNext = false;
  advancedAt = -Infinity;
  advancedBy = null;
  completedAt = -Infinity;
  tailUntil = -Infinity;
  readingHold = false;
  milestoneThisWord = false;
  document.body.classList.remove("free-answer");
  document.getElementById("gameCard")?.classList.remove("game-card--concept");
  const meta = document.getElementById("wordMeta");
  if (meta) meta.textContent = "";
}

// ===== Daily Dash =====
// 日替わり固定セットを順番に出題する60秒チャレンジ。完走でその日はロック
let dailyRun = null;

export function startDailyGame() {
  if (isDailyPlayedToday()) return false;

  setMode("challenge");
  stopGame(); // 通常Challengeのプレイ中でも確実に仕切り直す（dailyRunはこの後に設定）
  dailyRun = { words: getDailyWords(), index: 0, emoji: [] };
  startGame();
  return true;
}

export function startGame(options = {}) {
  if (isPlaying) return;
  const retry = Array.isArray(options.retry) && options.retry.length > 0 ? options.retry : null;
  const resume = !retry && options.resume && Array.isArray(options.resume.queue) && options.resume.queue.length > 0 ? options.resume : null; // 前回の続きから
  let composition = null;

  if (getWordsByCategory(activeCategory).length === 0) {
    showMessage(
      activeCategory === "my"
        ? "マイ単語帳はまだ空。単語帳ページから追加する"
        : "単語データを読み込み中"
    );
    return;
  }

  isPlaying = true;
  window.dispatchEvent(new CustomEvent("spelldash:game-start", { detail: { mode } })); // ホーム: ゲームカードを出す
  // フォーカスモード: 時間制ラン中はスマホで周辺UIを畳む（1画面1目的）。
  // Studyは終了の概念がないため対象外（モード切替手段を奪わない）
  document.body.classList.toggle("is-playing", mode === "challenge");
  document.body.classList.remove("set-done"); // 前回の結果画面の畳みを解く
  if (mode === "challenge") startBgm(); // 時間制ランのみBGM（Studyは静かに集中）
  hideResultPanel();
  score = 0;
  typingMissCount = 0;
  recallFailCount = 0;
  time = CHALLENGE_SECONDS;
  if (dailyRun) {
    // 「もう一回」は先頭から（完走前のみ可能）
    dailyRun.index = 0;
    dailyRun.emoji = [];
  }
  correctChars = 0;
  combo = 0;
  gainedXp = 0;
  runKind = "words";
  runRankBefore = new Map();
  timedDeadline = 0;
  timedHiddenAt = null;
  timedWarned = false;
  clearSpill();
  advancedAt = -Infinity;
  advancedBy = null;
  completedAt = -Infinity;
  tailUntil = -Infinity;
  readingHold = false;
  milestoneThisWord = false;
  startTime = Date.now();
  updateCombo(0);

  elements.input.disabled = false;
  elements.input.value = "";
  elements.input.focus();
  clearTypedPreview();

  elements.score.textContent = score;
  elements.miss.textContent = typingMissCount;
  if (elements.recallFail) elements.recallFail.textContent = recallFailCount;
  elements.time.textContent = time;
  elements.typeSpeed.textContent = "0.0";
  updateBigTimer();
  renderPlayScore();

  // 出題中の案内は入力欄の上の 1 本（#word の「分からないときは Enter で答えを表示」）だけ。下の行は結果にだけ使う
  showMessage("");

  // Study: Recall Loopキューを構築（Unresolved → Mission Review → 復習期限 → Mission New → 通常）
  if (mode === "study") {
    retryIds = retry;
    consecutiveFails = 0;
    if (retry) startRetryQueue(retry);
    else if (resume) startResumedQueue(resume.queue, resume.recalled);
    else startStudyQueue(activeCategory);
    composition = getQueueComposition(); // 最初の1語を取り出す前に構成を控える
    // 回の種類と長さ（ここで 1 度だけ。腕試しかどうかは startStudyQueue の後で決まる）。60 秒にしないのは決めた語だけの回・続きから・腕試し・チュートリアルの回
    if (retry) {
      runKind = "retry";
      runSize = retry.length;
    } else if (resume) {
      runKind = "resume";
      runSize = Number(resume.setSize) || getSetSize();
    } else {
      runKind = isTimedSet() && !isPlacementRun() && !isTutorialRunPending() ? "timed" : "words";
      runSize = getSetSize();
    }
    updateRecalledToday();
    setRecalled = new Set(resume?.recalled ?? []);
    setFailed = new Set(resume?.failed ?? []);
    setLearnEvents = new Map();
    setNewCount = resume?.newCount ?? 0;
    setReviewCount = resume?.reviewCount ?? 0;
    setCompletePending = false;
    renderSetProgress();
  }

  setNewWord();

  // 60 秒の回: 最初の語を出した時に時計を始める（苦手のみで出題が無く止まったときは始めない）
  if (isPlaying && timedRun()) startTimedClock();

  // 腕試し中は body.placement（css/home.css が「思い出せた 0 ・ 思い出せず 0 …」の行を畳む）。確定・終了・中断で外す
  document.body.classList.toggle("placement", mode === "study" && isPlacementRun());

  // セットの中身を先に伝える（何をやるか分かってから始める）
  if (mode === "study") {
    if (retry) {
      showMessage(`思い出せなかった ${retry.length}語をもう一度`, "revealed");
    } else if (resume) {
      showMessage(`前回の続きから。あと ${Math.max(0, currentSetSize() - setRecalled.size)}語で今日のセット完了`, "revealed");
    } else if (isPlacementRun()) {
      showMessage(""); // 腕試しの告知はトップの注記が済ませている。Enter の説明は #word の 1 本
    } else {
      const c = composition ?? getQueueComposition();
      const parts = [];
      if (c.review > 0) parts.push(`復習 ${c.review}`);
      if (c.weak > 0) parts.push(`もう一度 ${c.weak}`);
      if (c.repeat > 0) parts.push(`反復 ${c.repeat}`);
      if (c.fresh > 0) parts.push(`新しい単語 ${c.fresh}`);
      if (c.review > 0 || c.weak > 0) {
        showMessage(`${parts.join("・")}から`, "revealed");
      }
    }
  }

  // タイマーはChallengeのみ
  if (mode === "challenge") {
    timer = setInterval(() => {
      time--;
      elements.time.textContent = time;
      updateBigTimer();
      updateTypeSpeed();

      if (time <= 0) {
        endChallenge();
      }
    }, 1000);
  }
}

// カード右上の大型タイマー（Challenge/Dailyプレイ中のみ表示、残り10秒で赤）
function updateBigTimer() {
  const el = document.getElementById("bigTimer");
  if (!el) return;

  const active = isPlaying && mode === "challenge";
  el.hidden = !active;
  if (!active) return;

  el.textContent = time;
  el.classList.toggle("big-timer--danger", time <= 10);
  setBgmIntensity(time <= 10 ? 2 : 1); // 終盤はBGMも前のめりに
}

// ===== Study の 60 秒の回の時計（docs/SPEC_MASTERY.md §4.5） =====
// 既存の timer に載せる（stopGame・restartGame・endStudySession・#setRetry・endChallenge の clearInterval がどれも効く）。250ms ごとに描く。
// 止める間: タブが裏（visibilitychange で裏に回った時刻を控え、表に戻ったら期限をその分ずらす。裏ではブラウザが interval を間引くので tick の差では数えない）／
// 覚え方のメモを書いている間・覚え方を作っている間・作った覚え方を読んでいる間（描画ごとに見て、前の描画からの経過を期限に足す）。答え表示の後の打ち直しの間も進む
function isPageHidden() {
  return document.visibilityState === "hidden" || document.hidden === true;
}

function prefersReducedMotion() {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function startTimedClock() {
  const now = performance.now();
  timedDeadline = now + TIMED_SECONDS * 1000;
  timedLastTick = now;
  timedHiddenAt = isPageHidden() ? now : null;
  timedWarned = false;
  clearInterval(timer);
  timer = setInterval(tickTimedClock, TIMED_TICK_MS);
  announce(`${TIMED_SECONDS}秒`); // 読み上げは始めと残り 10 秒の 2 回だけ（#setProgress は aria-live にしない）
  renderSetProgress();
}

// 残りの ms（裏に回っている間は止まったまま）。時計を始める前は全部
function timedRemainingMs(now = performance.now()) {
  if (!timedDeadline) return TIMED_SECONDS * 1000;
  return Math.max(0, timedDeadline - (timedHiddenAt ?? now));
}

function tickTimedClock() {
  if (!isPlaying || !timedRun()) return;
  const now = performance.now();
  // visibilitychange を取りこぼしても、裏の間は数えず、表に戻ったらずらす
  if (timedHiddenAt === null && isPageHidden()) timedHiddenAt = now;
  else if (timedHiddenAt !== null && !isPageHidden()) resumeTimedClock(now);
  if (timedHiddenAt !== null) {
    timedLastTick = now;
    return;
  }
  if (isEditingNote() || isMakingWordAi() || readingHold) timedDeadline += now - timedLastTick;
  timedLastTick = now;
  const left = timedRemainingMs(now);
  if (!timedWarned && TIMED_SECONDS > 10 && left <= 10000) {
    timedWarned = true;
    announce("残り10秒");
  }
  renderTimedClock(left);
  if (left <= 0) endTimedRun();
}

function resumeTimedClock(now = performance.now()) {
  if (timedHiddenAt === null) return;
  timedDeadline += now - timedHiddenAt;
  timedHiddenAt = null;
  timedLastTick = now;
}

// 時計の数字と棒だけを替える（#setProgress の 3 つの要素はそのまま。高さは変わらず、入力欄は動かない）。残り 10 秒でも朱にしない・点滅しない。
// 動きを減らす設定では棒は動かさない（数字だけが減る）
function renderTimedClock(left = timedRemainingMs()) {
  const el = document.getElementById("setProgress");
  const count = el?.querySelector(".set-progress__count b");
  const bar = el?.querySelector(".set-progress__bar i");
  if (!el || el.dataset.timed !== "1" || !count || !bar) {
    renderSetProgress();
    return;
  }
  count.textContent = String(Math.ceil(left / 1000));
  if (!prefersReducedMotion()) bar.style.width = `${(left / (TIMED_SECONDS * 1000)) * 100}%`;
}

// 時間切れ: その場で止める（次の語へ進む待ち・ヒントの時計も）。画面の語にまだ答えていなければ何も記録しない（× にしない。T1 も捨てる）。
// 答え表示の後の打ち直しの途中・正解のあとの待ちの途中は、答えは記録済みのまま終わる
function endTimedRun() {
  clearInterval(timer);
  timer = null;
  clearTimeout(advanceTimer);
  advanceTimer = null;
  awaitingNext = false;
  hideHint();
  clearSpill();
  endStudySession({ timed: true });
}

// 裏に回った: 出題から最初のキーまでに裏に回った語は速さを測らない。60 秒の回の時計は止める（表に戻ったら期限をずらす）
document.addEventListener("visibilitychange", () => {
  const now = performance.now();
  if (isPageHidden()) {
    if (wordTiming && wordTiming.tFirst === null) wordTiming.invalid = true;
    if (isPlaying && timedRun() && timedHiddenAt === null) timedHiddenAt = now;
    return;
  }
  if (timedHiddenAt !== null) {
    resumeTimedClock(now);
    if (isPlaying && timedRun()) renderTimedClock();
  }
});

export function restartGame() {
  clearInterval(timer);
  isPlaying = false;
  startGame();
}

// Enterキー相当の操作（物理キーボード・ソフトキーボード共通）
// 未開始=スタート / プレイ中=「わからない」1回目で答え表示、2回目で次へ
function triggerEnter() {
  if (!isPlaying) {
    startGame();
    return;
  }

  // 正解直後の待ち: Enterで待たずに次へ
  if (awaitingNext) {
    advanceNow("key");
    return;
  }
  // 前の語の続きと引き分け・保留の字（次の語に見せている字）の決着（resolveSharedForEnter）: 保留 finish は保留の字で確定、続きが終わった直後
  // （1.2 秒）の Enter は「打ち終えたら Enter で次へ」の癖として字を外して 1 回だけ飲む、それ以外は見せている字のまま普通に判定する
  // （下: 候補に一致していればその語で確定、そうでなければ答えを開く）
  if (resolveSharedForEnter()) return;
  // 次の語が出た直後の、前の語に向けた Enter／Esc（答えを開かない＝×にしない）
  if (isAdvanceEcho()) return;

  // ローマ字モード: 読みは打ち終えた時点で正解になっている。Enter は英単語と同じく 1 回目は答え表示、
  // 答えを見た後はスキップ（下の通常処理）
  if (romajiMode && romaji && !isRevealed) {
    revealAnswer();
    return;
  }

  // 全文入力モード: 入力があれば判定、空なら「分からない」
  if (freeMode) {
    const typed = elements.input.value.trim();
    if (!isRevealed) {
      if (typed) submitFreeAnswer(typed);
      else revealAnswer();
      return;
    }
    if (typed) {
      if (answerMatches(currentWord, typed)) {
        finishFreeWord();
      } else {
        showMessage("違う。答えのとおりに打つ", "wrong");
        elements.input.value = "";
      }
      return;
    }
    // 空でEnter = スキップして次へ（下の通常処理）
  }

  if (!isRevealed) {
    // Enter は「打った語で確定」: 打った綴りがそのまま候補の 1 つに一致して止まっているなら、その語で確定する
    // （別解 = 出題語 advertisement に対して "ad" なら別解として受け取る。出題語に一致していれば正解。どちらも「分からない」にしない）
    const done = completedAnswer(activeCandidates(), typedSoFar, { force: true });
    if (done) {
      finishTypedAnswer(done);
      return;
    }
    revealAnswer();
  } else {
    // 答えを見た後のスキップ = Dailyでは「打てなかった単語」⬛
    if (dailyRun && mode === "challenge") {
      dailyRun.emoji.push("⬛");
    }
    setNewWord();
    showMessage("");
  }
}

// ===== 次の語が出た直後の 2 つの守り（Study。寿命と使い切りの規則はここにまとめる） =====
// どちらも前の語に向けた打鍵が次の語の×にならないようにするもので、次の語を出したとき（advanceNow）に始まり、ゲームの開始・中断（startGame・stopGame）で消える。
// 本物の打ち間違い・本当の「分からない」は捨てない（1 ミス＝不正解）。
// - Enter／Esc の守り（isAdvanceEcho。advancedAt・advancedBy・completedAt）: 待ちの終わり際に「次へ」と押した指・二度押し・打ち終えたら Enter で次への癖
//   寿命: 次の語が出てから ADVANCE_GUARD_MS（0.3 秒）。タイマーで進んだときは、前の語を打ち終えてから（続きを打っていれば続きの最後の打鍵から。advanceSpill）
//         ECHO_AFTER_DONE_MS（1.2 秒）の間も
//   使い切り: 次の語に字が入ったら効かない（受理した字・入力欄の字・ローマ字の打鍵がどれも空のときだけ）。引き分けの字を外して Enter を飲んだら
//         その場で使い切る（resolveSharedForEnter。2 回目の Enter は普通に判定）
// - 1 打目の守り（spendTailGuard。tailUntil）: 続きの直後の余分な 1 打（空白・gymnasiums の s）
//   置くとき: 2 打以上の続きを打ち切り、次の語を出す時刻が SPILL_TAIL_MS で決まった（本来の待ちの終わりより後＝待ちを縮めた）ときだけ（completeWord の tick）。
//         余分な 1 打がもう待ちの間に来て捨てていれば置かない（spill.extra）。次の語が全文入力なら待ちを縮めないので置かない
//   寿命: 続きの最後の打鍵から min(本来の待ち〔節目・チュートリアルの保持を含む〕, 標準のペースの表の値〔語の種類の値: 英単語 0.7 秒・概念カード 0.9 秒。
//         例文の有無によらない〕)。長いペースの表の値（2.2 秒・2.6 秒）まで広げると、次の語が見えて 2 秒近くたってからの本物の打ち間違いまで捨てる
//         （余分な 1 打が来るのは打ち切ってすぐ）。次の語が変わったら消える（setNewWord）
//   使い切り: 次の語が出た後の最初の打鍵（印字できる 1 字。字でも空白でも、どの経路でも: keydown・画面キーボード・Android の input・ローマ字。
//         judgeKey を通らない Android の空白・ローマ字の空白も）。その打鍵が次の語に拒まれたらミスにせず捨てる。2 打目からは普通に判定
//
// 次の語が出てから ADVANCE_GUARD_MS（0.3 秒）の、その語にまだ何も打っていない Enter／Esc か（タイマーで進んだときは打ち終えてから 1.2 秒も）
function isAdvanceEcho() {
  const now = performance.now();
  return (
    mode === "study" &&
    !isRevealed &&
    (now - advancedAt < ADVANCE_GUARD_MS || (advancedBy === "timer" && now - completedAt < ECHO_AFTER_DONE_MS)) &&
    typedSoFar === "" &&
    !elements.input.value &&
    !romaji?.keys
  );
}

// 次の語の 1 打目の守りを使う（上の注釈）。この打鍵を守るなら true。どの打鍵でも 1 回で消える
function spendTailGuard() {
  const on = performance.now() < tailUntil && !isRevealed && nextTyped() === "";
  tailUntil = -Infinity;
  return on;
}

// 次の語にいま受理している打鍵（綴り入力は typedSoFar、ローマ字は打ったキー）
function nextTyped() {
  return romajiMode ? (romaji?.keys ?? "") : typedSoFar;
}

// 次の語に受理した打鍵を空に戻す（引き分けの字が前の語の続きだったとき。ミス・答え表示・記録は触らない）
function clearNextTyped() {
  if (romajiMode) {
    romaji?.reset();
    renderRomaji();
    return;
  }
  correctChars = Math.max(0, correctChars - typedSoFar.length);
  typedSoFar = "";
  currentIndex = 0;
  elements.input.value = "";
  updateTypedPreview("");
  updateTypeSpeed();
}

export function handleKeydown(event) {
  // IME変換確定のEnter（isComposing / keyCode 229）はゲーム操作にしない
  if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) return;

  if (event.key === "Enter") {
    event.preventDefault();
    triggerEnter();
    return;
  }

  if (!isPlaying || !currentWord) return;

  // 速さの箱の入力の経路（js/masteryMeta.js keyInputOf）: 信頼された keydown で code が物理キーの名前（KeyA・Digit1・Minus など）なら kbd
  // （日本語入力オンの物理キーの keyCode 229・key Process も code で kbd）。iPhone・Android の画面キーボード（信頼された keydown でも
  // code が空・Unidentified）と #osk のボタンが合成する keydown は touch
  keyPath = keyInputOf(event);

  // 正解直後の待ち（次の語が出る前）: 文字キーは判定しない（次の語の1文字目をミス扱いにしない）。
  // 打ち終えた語の続き（ローマ字の読みの続き・英単語の長い候補の続き）は判定に食わせて時刻を進める
  // （続きを打っている間はタイマーで次の語を出さない。completeWord の tick）。続きを打ち切った後に来た余分な 1 打（空白・s）は捨て、
  // 次の語の 1 打目の守りはもう使ったものとする（noteWaitExtra）
  if (awaitingNext) {
    if (!takeSpill(spill?.keyOf(event)) && printableKey(event)) noteWaitExtra();
    event.preventDefault();
    return;
  }

  // Esc = 「わからない」（Enterと同じ: 答え表示 → もう一度で次へ）
  if (event.key === "Escape") {
    event.preventDefault();
    triggerEnter();
    return;
  }
  // Ctrl+.（Cmd+.）= 発音。Tab は既定どおり次の要素へ（入力欄に閉じ込めない）
  if (event.key === "." && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    speak(speechTextOf(currentWord));
    return;
  }

  // ローマ字モード: 読みを 1 打ずつ判定（IME は通さない）。前の語の続き（読みの続き・英単語の長い候補の続き）との突き合わせは judgeKey
  if (romajiMode) {
    handleRomajiKey(event);
    return;
  }

  // 全文入力モード: 文字入力はブラウザ／IMEに任せる（Enterで判定）。前の語がローマ字なら、読みの続きは窓の中だけ飲む（以前のまま。
  // 英単語の続きは持ち越さない: setNewWord・startSpellingSpill）
  if (freeMode) {
    const key = spill?.keyOf(event);
    if (key) {
      if (performance.now() - spill.at <= SPILL_GAP_MS && feedSpill(key)) {
        event.preventDefault();
        return;
      }
      clearSpill();
    }
    // 保留の字で前の語が完成して流し直したキー（"again"）は、前の語の判定で preventDefault 済みでブラウザが入力欄に入れない。
    // 黙って消さず、ここで入力欄（カーソルの位置）に入れる（画面キーボードの合成キーも同じ。REVIEW-153 の 5）。
    // ブラウザが字を入れたのと同じにするので input イベントは出さない（全文入力の判定は Enter）
    if (event.defaultPrevented && printableKey(event)) editAtCaret(elements.input, event.key, 0, { notify: false });
    return;
  }

  if (event.key.length !== 1) return;

  event.preventDefault();

  // 語を打ち終えた直後の、終えた語の続き（gym の後の nasium、a の後の n）は次の語の打鍵にしない（judgeKey。前の語の続きと次の語の両方に食わせて解決）。
  // 保留の字で前の語が完成したら（"again"）、このキーは新しい語のものとして流し直す（新しい語が Study の待ち・ローマ字・全文入力でも正しい先へ。
  // 全文入力の語では、preventDefault 済みのこのキーの字を全文入力の枝が入力欄に入れる）
  if (judgeSpellingKey(event.key.toLowerCase(), spill?.keyOf(event), handleCorrectChar) === "again") handleKeydown(event);
}

// ローマ字モードの 1 打。ローマ字のキーでないもの（空白・記号・Backspace）は判定しない（ミスにもしない）
function handleRomajiKey(event) {
  if (!romaji) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return; // 再読み込み・コピーなどブラウザの操作は止めない
  const key = romajiKeyOf(event);
  if (!key) {
    // 判定しない字（空白・記号）でも、次の語の 1 打目の守りは使い切る（物理キーの綴り入力で空白が守りを使うのと同じ。REVIEW-155 の 2）
    const printable = printableKey(event);
    if (printable) spendTailGuard();
    if (printable || ["Backspace", "Delete", "Process", "Unidentified"].includes(event.key)) event.preventDefault();
    return;
  }
  event.preventDefault();
  let expected = null;
  const verdict = judgeKey({
    key,
    contKey: spill?.keyOf(event),
    tryAccept: () => {
      const result = romaji.feed(key);
      if (!result.ok) {
        expected = result.expected;
        return null; // ミスの feed は状態を変えない
      }
      markFirstKey();
      renderRomaji();
      // 画面キーボードが出ていると、長い問題文の下の入力欄が盤面に隠れることがある。打ち始めに見える位置へ
      if (romaji.keys.length === 1 && document.body.classList.contains("osk-open")) {
        elements.input.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
      }
      if (result.done) finishRomajiWord();
      return result.done ? "done" : "more";
    },
    // この字で読みを打ち終えるか（状態は変えない: 写しの判定に打った字 ＋ この字を食わせる）
    finishes: () => {
      const r = createRomajiMatcher(romajiEntries).type(romaji.keys + key);
      return r.missAt === -1 && r.done ? "done" : null;
    },
    own: () => true, // どの読みで打ち終えても正解（別解の案内は無い）
    firstFits: () => createRomajiMatcher(romajiEntries).feed(key).ok,
    fitsFromStart: (keys) => createRomajiMatcher(romajiEntries).type(keys).missAt === -1,
    show: () => {}, // 入力欄の字は見えない（かなの 2 段表示は判定に食わせた打鍵だけ）。保留の字は見せない
    echo: () => ({ kind: "romaji", entries: romajiEntries }),
    miss: (typed = key) => handleTypingMiss(expected ?? romaji.state().expected, typed)
  });
  if (verdict === "again") handleKeydown(event); // 保留の字で前の語が完成した: このキーは新しい語のもの
}

// 読みを打ち終えた（Enter なし・変換なし）。速度はかなの数で数える
function finishRomajiWord() {
  const state = romaji.state();
  const entry = romaji.entries[state.finished] ?? romaji.entries[0];
  correctChars += [...(entry?.reading ?? "")].length;
  updateTypeSpeed();
  // まだ続けて打てる（長い読み・語末の ん の nn）なら、直後の続きの打鍵を次の語に持ち越さない
  if (state.canContinue) startRomajiSpill(romaji);
  else clearSpill();
  completeWord();
}

// 答えを見た後は出題語だけを練習させる（別解でごまかせないように）
function activeCandidates() {
  return isRevealed ? [currentWord.en] : answerCandidates;
}

// ===== モバイル（ソフトキーボード/IME）対応 =====
// AndroidのGboard等はkeydownで "Unidentified" しか返さないため、
// inputイベントで入力欄の実際の値を照合する。
// デスクトップではprintableキーをkeydownでpreventDefaultしているので二重処理にならない。

// 日本語IMEの変換中はvalueを触らない（触るとIMEと衝突して入力が壊れる）
let composing = false;

export function handleCompositionStart() {
  composing = true;
}

export function handleCompositionEnd() {
  composing = false;
  if (!isPlaying || !currentWord) return;
  if (romajiMode) {
    // 入力欄は読み取り専用なので来ないはず。来ても値は打ったキーに戻す（判定は keydown だけ）
    elements.input.value = romaji?.keys ?? "";
    return;
  }
  if (freeMode) return; // 全文入力モードでは日本語をそのまま受け付ける

  // 確定された文字に日本語等が含まれていたら、受理済み位置へ巻き戻して案内する
  // （かな→ローマ字の復元は不可能なため、打ち直してもらうのが最も安全）
  if (/[^a-z\s]/i.test(elements.input.value)) {
    elements.input.value = typedSoFar;
    updateTypedPreview(typedSoFar);
    showMessage("キーボードを英字モードに", "wrong");
    return;
  }
  handleTextInput();
}

export function handleTextInput() {
  if (!isPlaying || !currentWord) return;
  if (romajiMode) {
    elements.input.value = romaji?.keys ?? ""; // 判定は keydown だけ（入力欄は読み取り専用）
    return;
  }
  if (freeMode) return; // 全文入力モードは Enter で判定
  if (composing) return; // 変換確定はhandleCompositionEndで処理する
  const value = elements.input.value; // 打たれたとおりの字（大文字・空白・記号を含む）
  const raw = value.toLowerCase().replace(/[^a-z]/g, "");

  if (awaitingNext) {
    // 正解直後の待ち: 入力は捨てる（次の語の判定に持ち越さない）。打ち終えた語の続き（gym の後の nasium）は
    // 続きの判定に食わせて時刻を進める（keydown の takeSpill と同じ。続きを打っている間はタイマーで次の語を出さない）。
    // 入力欄には打ち終えた綴りが残っている（待ちに入って 1 回目。waitInputBase）か、前の回で空にしてある
    // （2 回目からは打ち終えた綴りと比べない。a の続き a large の a を、残っている a と取り違えない）
    const base = waitInputBase;
    waitInputBase = "";
    takeSpillText(base && raw.startsWith(base) ? raw.slice(base.length) : raw, afterLetters(value, raw.length) !== "");
    elements.input.value = "";
    return;
  }

  const accepted = shownTyped(); // 受理した字 ＋ 保留 finish で見せている字

  // 字（a-z）でない打鍵（空白・記号）は判定に入らない（raw から落ちる）が、次の語の 1 打目の守りは使い切る
  // （物理キーで空白が judgeKey を通って守りを使うのと同じ結果にする。REVIEW-155 の 2）
  if (raw.startsWith(accepted) && /^[^a-z]/i.test(afterLetters(value, accepted.length))) spendTailGuard();

  if (raw === accepted) return;

  // 削除や予測変換での置き換えは、受理済みの位置へ巻き戻すだけ（ミス扱いしない）
  if (!raw.startsWith(accepted)) {
    elements.input.value = accepted;
    updateTypedPreview(accepted);
    return;
  }

  const fresh = [...raw.slice(accepted.length)];
  keyPath = "touch"; // ソフトウェアキーボードの input 経路（速さの箱）
  for (let i = 0; i < fresh.length; i++) {
    const typedChar = fresh[i];
    const missBefore = typingMissCount;
    let finished = false;
    // 打ち終えた前の語の続き（a の後の n、gym の後の nasium）は次の語の打鍵にしない（keydown と同じ judgeKey。続きと次の語の両方に食わせて解決）
    const verdict = judgeSpellingKey(typedChar, typedChar, (ch) => {
      if (completedAnswer(activeCandidates(), typedSoFar + ch) !== null) {
        elements.input.value = typedSoFar + ch;
        updateTypedPreview(elements.input.value);
      }
      finished = acceptChar(ch);
      return finished;
    });
    if (verdict === "again") {
      // 保留の字で前の語が完成した: この字から先は新しい語のもの（keydown の流し直しと同じ先へ）
      const rest = fresh.slice(i);
      if (awaitingNext || romajiMode) {
        // Study の待ちの間・ローマ字の語: 続き（echo）に食わせるだけ。入力欄は空にして待ちの基準もそろえる
        // （待ちの通常の道と同じ。次の入力は空の欄からの差分だけを比べる。REVIEW-153 の 3）
        takeSpillText(rest, afterLetters(value, raw.length) !== "");
        elements.input.value = "";
        waitInputBase = "";
        return;
      }
      if (freeMode) {
        // 全文入力の語: 字は入力欄に入れる（判定は Enter。setNewWord が空にした欄に、この字から先を戻す。REVIEW-153 の 5）。
        // 戻すのは入力欄に実際に打たれた字（受け付け済みの部分より後ろ。大文字・空白もそのまま）。物理キーが event.key をそのまま入れるのと同じ（REVIEW-155 の 4）
        elements.input.value = afterLetters(value, accepted.length + i);
        return;
      }
      i--;
      continue;
    }
    if (finished) {
      // 単語完成。同じ入力で一度に入った残り（予測変換で gymnasium と入ったときの nasium）は捨てる（setNewWord が入力欄をリセットする）。
      // 続きなら続きの判定に食わせて、次の入力で来る続きも飲めるようにする（同じ入力の残りは前の語の打鍵）
      takeSpillText(fresh.slice(i + 1), afterLetters(value, raw.length) !== "");
      return;
    }
    if (typingMissCount !== missBefore) break; // 1イベントにつきミスは1回まで（予測変換の一括挿入対策）
  }

  const shown = shownTyped();
  elements.input.value = shown;
  updateTypedPreview(shown);
}

// ソフトキーボードのEnter（Go/実行）はkeydownではなくinsertLineBreakとして来る環境がある
export function handleBeforeInput(event) {
  if (event.inputType === "insertLineBreak") {
    event.preventDefault();
    triggerEnter();
    return;
  }
  if (romajiMode) event.preventDefault(); // ローマ字モードは keydown だけで判定する（値を書き換えさせない）
}

// 「思い出せなかった」の記録（答え表示・ヒントで共通）。1語につき1回だけ
function markRecallFail() {
  recallFailCount++;
  if (elements.recallFail) elements.recallFail.textContent = recallFailCount;

  // 習熟度: 回で最初の答えなら、書く前の stat の段と同じ日の扱いを控える（完了パネル・結果の「段が動いた語」）
  const prevStat = getWordStats()[currentWord.id];
  const failCtx = prevStat ? answerContext(prevStat, Date.now()) : null;
  recordRecallFail(currentWord.id);
  noteRunAnswer(currentWord.id, { before: failCtx?.rank ?? 0, ok: false, sameDay: !!failCtx?.sameDay });

  // Study: Unresolved（赤）としてキューへ戻す。数問後に再出題される
  if (mode === "study") {
    setFailed.add(currentWord.id);
    queueRecallFail(currentWord.id);
    playRecallFailEffect();
    renderStudyQueue(true);

    // 3連続で思い出せなかったら、次に「思い出せる語」を1つ挟んで立て直す
    consecutiveFails++;
    if (consecutiveFails === 3 && insertBreather()) {
      // 60 秒の回は息抜きの語を挟むだけ（時計の進む盤面に、はちゃんの知らせを出さない）
      const toast = timedRun() ? null : document.getElementById("learnToast");
      if (toast) {
        toast.innerHTML = hasumiBubbleHtml({ mood: "normal", text: "3つ続けて出てこないのは、よくある。次は思い出せる語を1つ挟む。" }, "hasumi--result");
        toast.hidden = false;
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
          toast.hidden = true;
        }, 4000);
      }
      renderStudyQueue(true);
    }
  }

  combo = 0;
  updateCombo(0);
  renderPlayScore();
}

// Enter1回目 or 1ミスタイプ: 不正解 → 答えを表示（recallFailとして記録）
// 別解を打ち終わったとき: 減点も×記録もしない。「それも正解」と伝えたうえで、
// この問題の語を見せて打ってもらう（別解だけで済ませると出題語が身につかないため）
function acceptAlternative(typed) {
  sfxSoftCorrect();
  isRevealed = true;
  recordAnswerSeen(currentWord.id); // 答えの綴りを見た印（初見の語だけ。打ち直さずに終わっても、次の答えを「知ってた」にしない。js/stats.js）
  hideHint();
  showColoredAnswer(currentWord.en);
  if (listenMode) elements.japanese.textContent = promptOf(currentWord);
  renderWordFamily(currentWord);
  renderWordHistory();
  renderWordNote(currentWord);
  renderExplain(currentWord);
  autoSpeak(speechTextOf(currentWord));
  if (elements.speakButton) elements.speakButton.hidden = !speechTextOf(currentWord);

  currentIndex = 0;
  typedSoFar = "";
  elements.input.value = "";
  clearTypedPreview();
  showMessage(`${typed} も「${promptOf(currentWord)}」。この問題の語は ${currentWord.en}`, "info");
}

// 答えを見せる。ローマ字モードは答えの下に読みも（鎌倉幕府 ／ かまくらばくふ）
function showAnswer() {
  if (romajiMode) showAnswerWithReading(currentWord.en, primaryRomajiEntry()?.display);
  else showColoredAnswer(currentWord.en);
}

function revealAnswer(fromMiss = false) {
  isRevealed = true;
  clearSpill(); // 答えを見た: 前の語の続きの持ち越し止めは終える
  hideHint();
  window.dispatchEvent(new CustomEvent("spelldash:reveal", { detail: { id: currentWord?.id, fromMiss } })); // チュートリアル（js/tutorial.js）
  if (!fromMiss) sfxReveal(); // ミス起点ではsfxMissが鳴っているので重ねない

  // ヒントを見た時点で×は記録済み。二重に数えない
  if (!hintUsed) markRecallFail();

  showAnswer();
  if (listenMode) elements.japanese.textContent = promptOf(currentWord); // 音だけだった語の意味を見せる
  renderWordFamily(currentWord);
  renderWordHistory();
  renderWordNote(currentWord);
  renderExplain(currentWord);

  // 発音: autoなら1回再生。スピーカーボタンも表示（英語がある語だけ）
  autoSpeak(speechTextOf(currentWord));
  if (elements.speakButton) {
    elements.speakButton.hidden = !speechTextOf(currentWord);
  }

  // 頭から打ち直して練習できるようにリセット
  currentIndex = 0;
  typedSoFar = "";
  elements.input.value = "";
  clearTypedPreview();
  if (romajiMode) romaji = createRomajiMatcher([primaryRomajiEntry()]); // 答えを見た後は、見せた読みだけを打って練習

  const stat = getWordStats()[currentWord.id];
  const leech = (stat?.recallFail ?? 0) >= LEECH_FAILS;
  showMessage(
    fromMiss
      ? freeMode
        ? "違う。答えを見て打ち直す（Enter で判定）"
        : "違う。答えを見て打ち直す"
      : leech
        ? `${stat.recallFail}回目の難敵。覚え方をメモすると残る`
        : freeMode
          ? "打って練習するか、空のまま Enter で次へ"
          : "打って練習するか、Enter で次へ",
    fromMiss ? "wrong" : "revealed"
  );

  // 画面キーボードが出ていると、答え・例文・操作チップの分だけ入力欄が盤面の下に落ちる。見える位置へ戻す
  // （html:has(body.osk-open) の scroll-padding-bottom が盤面の高さ分を確保している）
  if (document.body.classList.contains("osk-open")) {
    elements.input.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }
}

// ===== 全文入力モードの判定 =====
function submitFreeAnswer(typed) {
  if (answerMatches(currentWord, typed)) {
    finishFreeWord();
    return;
  }
  // 違う答え = 思い出せていない。答えを見せて打ち直し（1ミス＝不正解の方針と同じ）
  typingMissCount++;
  elements.miss.textContent = typingMissCount;
  hasMissedCurrentWord = true;
  combo = 0;
  updateCombo(0);
  sfxMiss();
  recordTypingMiss(currentWord.id);
  revealAnswer(true);
  // 英作文: どこから違うかを語単位で指摘（語順・時制・冠詞の気づきに）
  if (currentWord.write) {
    const diff = firstWordDiff(currentWord.en, typed);
    if (diff) {
      const where = diff.index >= diff.total
        ? `${diff.total}語で終わりだけど、余分に「${diff.typed}」がある`
        : diff.typed
          ? `${diff.index + 1}語目が違う: あなたは「${diff.typed}」、答えは「${diff.expected}」`
          : `${diff.index + 1}語目「${diff.expected}」から先が足りない`;
      showMessage(`違う。${where}。答えを見て打ち直す（Enter で判定）`, "wrong");
    }
  }
}

function finishFreeWord() {
  currentIndex = currentWord.en.length;
  correctChars += currentWord.en.length;
  updateTypeSpeed();
  completeWord();
}

// 正解後の待ちを終えて次へ（by: "key" = Enter で自分から／"timer" = 待ちが終わった）。
// tail = 次の語の 1 打目の守りの終わり（待ちを縮めて出したときだけ。isAdvanceEcho の上の注釈。全文入力の語は 1 打ずつ判定しないので置かない）
function advanceNow(by = "key", tail = -Infinity) {
  clearTimeout(advanceTimer);
  advanceTimer = null;
  if (!awaitingNext) return; // タイマーと Enter が重なっても 1 回だけ進む
  awaitingNext = false;
  readingHold = false;
  if (by !== "timer") clearSpill(); // Enter で自分から進んだ: 次の語の 1 打目から受け付ける
  if (!isPlaying) return;
  if (mode === "study" && setCompletePending) {
    endStudySession();
    return;
  }
  const prev = currentWord;
  setNewWord();
  // 前の語の結果の行（「正解」「思い出せた +N XP」など語の名を含まない行）を次の語の下に見せない。
  // 語の名を含む行（「知ってた。business は…」「X を習得」）と節目の行（Lv・連続日数・シールド・ミッション）は残す（showResult の keep）。
  if (isPlaying && prev && !keepMessage) hideStaleMessage();
  advancedAt = performance.now();
  advancedBy = by;
  tailUntil = isPlaying && !freeMode && tail > advancedAt ? tail : -Infinity;
}

// 前の語の結果の行を見えなくする。文はすぐには消さない（aria-live の読み上げを途中で落とさない）。
// 次の showMessage が置き換える。1.5 秒たっても置き換わらなければ文も消す（あとで読み上げで辿っても前の語の結果が出ない）
function hideStaleMessage() {
  const el = elements.message;
  if (!el.textContent) return;
  el.classList.add("message--stale");
  clearTimeout(staleMessageTimer);
  staleMessageTimer = setTimeout(() => {
    if (el.classList.contains("message--stale")) showMessage("");
  }, 1500);
}

// この語の結果の行。keep: 次の語が出ても残す（語の名を含む行・節目の行）。最後に出した行が決める
function showResult(text, type, keep = false) {
  keepMessage = keep;
  showMessage(text, type);
}

// ===== ヒント（Study） =====
function scheduleHint() {
  clearTimeout(hintTimer);
  hintTimer = null;
  if (mode !== "study" || !isPlaying) return;
  hintTimer = setTimeout(() => {
    if (!isPlaying || !currentWord || isRevealed || mode !== "study") return;
    const button = document.getElementById("hintButton");
    if (button) button.hidden = false;
  }, HINT_DELAY_MS);
}

function hideHint() {
  clearTimeout(hintTimer);
  hintTimer = null;
  const button = document.getElementById("hintButton");
  if (button) button.hidden = true;
}

// 次の1文字を見せる（＝その文字を受理する）。最初のヒントで×を記録
export function useHint() {
  if (!isPlaying || !currentWord || isRevealed || mode !== "study") return;

  if (!hintUsed) {
    hintUsed = true;
    hasMissedCurrentWord = true; // クリーン判定からも外す
    markRecallFail();
    renderWordHistory();
    renderWordNote(currentWord);
    sfxReveal();
  }
  clearSpill(); // ヒントで足す字は次の語のもの。前の語の続きとの突き合わせは終える

  // 計算カード: 頭文字ではなく式を見せる
  if (currentWord.calc) {
    showHiddenWordText(currentWord.calcFormula, { hint: true });
    showMessage(`${currentWord.calcFormula}。計算して数字を入力（ヒントを見たので、この問題はまた出す）`, "revealed");
    return;
  }

  // 英作文: 1語ずつ見せる（文字単位だと長すぎる）
  if (currentWord.write) {
    const words = currentWord.en.split(/\s+/).filter(Boolean);
    hintChars = Math.min(words.length, hintChars + 1);
    const shown = words.slice(0, hintChars).join(" ");
    showHiddenWordText(`${shown}${" ▢".repeat(Math.max(0, words.length - hintChars))}（${words.length}語）`, { hint: true });
    showMessage(
      hintChars === 1
        ? `最初の語は「${words[0]}」。続きを思い出して入力（ヒントを見たので、この文はまた出す）`
        : `${shown} … 続きを入力してEnter`,
      "revealed"
    );
    return;
  }

  // ローマ字モード: 読みの次の 1 かなを打ったことにする（その下に綴りも出る）。見せるのは打った分のかなと残りの字数
  if (romajiMode && romaji) {
    const next = romaji.hint();
    if (!next) return;
    romaji.type(next.keys);
    renderRomaji();
    const state = romaji.state();
    const shown = state.committed.map((seg) => seg.kana).join("");
    const total = [...(romaji.entries[state.candidate ?? 0]?.display ?? "")].length;
    showHiddenWordText(`${shown}${"・".repeat(Math.max(0, total - [...shown].length))}（${total}文字）`, { hint: true });
    showMessage(
      hintChars === 0
        ? `頭の字は「${next.kana}」。続きを打つ（ヒントを見たので、この語はまた出す）`
        : `次は「${next.kana}」。続きを打つ`,
      "revealed"
    );
    hintChars++;
    if (state.done) finishRomajiWord();
    return;
  }

  // 全文入力モード: 文字を入力欄に入れず、頭から1文字ずつ見せるだけ
  if (freeMode) {
    hintChars = Math.min(currentWord.en.length, hintChars + 1);
    const total = currentWord.en.length;
    showHiddenWordText(`${currentWord.en.slice(0, hintChars)}${"・".repeat(Math.max(0, total - hintChars))}（${total}文字）`, { hint: true });
    showMessage(
      hintChars === 1
        ? `頭文字は「${currentWord.en[0]}」。続きを思い出して入力（ヒントを見たので、この語はまた出す）`
        : `${currentWord.en.slice(0, hintChars)}… 続きを入力してEnter`,
      "revealed"
    );
    return;
  }

  const nextChar = currentWord.en[currentIndex];
  const total = currentWord.en.length;
  const shown = currentIndex + 1;
  showHiddenWordText(`${currentWord.en.slice(0, shown)}${"・".repeat(Math.max(0, total - shown))}（${total}文字）`, { hint: true });
  showMessage(
    shown === 1
      ? `頭文字は「${nextChar}」。残りを自力で打つ（ヒントを見たので、この語はまた出す）`
      : `次は「${nextChar}」。続きを打つ`,
    "revealed"
  );

  elements.input.value += nextChar;
  updateTypedPreview(elements.input.value);
  acceptChar();
}

// ===== 自分のメモ（覚え方）: 答え表示・ヒント後に表示＋編集 =====
// 覚え方のメモを書いている途中か: 欄か保存ボタンに焦点がある、または欄の中を押し下げている
// （マウスで「保存」を押すと、押し下げで焦点が欄から離れる。Safari はボタンに焦点を移さない）
let notePressed = false;
function releaseNote() {
  notePressed = false;
}
function isEditingNote() {
  if (!document.getElementById("noteInput")) return false;
  return notePressed || !!document.getElementById("wordNote")?.contains(document.activeElement);
}

// 覚え方を作る（AI）の返事を待っている（待ちを止めるのは長くて AI_HOLD_MAX_MS。返事が来なくても先へ進める）
const AI_HOLD_MAX_MS = 10000;
let aiStartedAt = -Infinity;
function isMakingWordAi() {
  return !!document.querySelector("#wordAi [data-word-ai-run]:disabled") && performance.now() - aiStartedAt < AI_HOLD_MAX_MS;
}

function renderWordNote(word) {
  const el = document.getElementById("wordNote");
  if (!el) return;
  const aiSlot = document.getElementById("wordAi");
  if (!word || mode !== "study") {
    el.innerHTML = "";
    if (aiSlot) {
      aiSlot.innerHTML = "";
      delete aiSlot.dataset.wordAiFor; // ログインの確かめが後から返っても、前の語のボタンを描かない
    }
    return;
  }
  // 覚え方を作る（AI）: 保存済みなら表示、ログイン中ならボタン。生成後は入力欄へ戻す
  renderWordAi(aiSlot, word, {
    onStart: () => {
      aiStartedAt = performance.now();
      elements.input.focus(); // 押したボタンは返事まで押せない。焦点を入力欄へ戻し、Enter で次へ進めるようにする
    },
    // 返事（覚え方・断りの文）が出た: 待ちの間なら読み終えるまで待つ（Enter で次へ）
    onSettled: () => {
      if (awaitingNext && currentWord === word) readingHold = true;
      elements.input.focus();
    }
  });

  const note = getNote(word.id);
  el.innerHTML = note
    ? `<span class="word-note__text">${icon("note")}${escapeHtml(note)}</span><button type="button" class="word-note__edit" id="noteEdit">編集</button>`
    : `<button type="button" class="word-note__edit word-note__edit--add" id="noteEdit">${icon("note")}覚え方をメモ</button>`;

  document.getElementById("noteEdit")?.addEventListener("click", () => {
    el.innerHTML = `
      <input type="text" class="note-input" id="noteInput" maxlength="${NOTE_MAX_LENGTH}" placeholder="覚え方（例: nego＝交渉のネゴ）" value="${escapeHtml(note)}" autocomplete="off" />
      <button type="button" class="word-note__save" id="noteSave">保存</button>
    `;
    const input = document.getElementById("noteInput");
    const save = () => {
      setNote(word.id, input.value);
      renderWordNote(word);
      elements.input.focus();
    };
    document.getElementById("noteSave")?.addEventListener("click", save);
    // 欄・保存ボタンを押し下げている間は待ちを止める（離したら次の見直しで進む。click は離した直後に同じ流れで来る）
    for (const target of [input, document.getElementById("noteSave")]) {
      target?.addEventListener("pointerdown", () => {
        notePressed = true;
        document.addEventListener("pointerup", releaseNote, { once: true });
        document.addEventListener("pointercancel", releaseNote, { once: true });
      });
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        renderWordNote(word);
        elements.input.focus();
      }
    });
    input.focus();
  });
}

export function speakCurrentWord() {
  if (currentWord) {
    speak(speechTextOf(currentWord));
  }
}

// 正解時にスコア数字をパルスさせる（気持ちよさの微調整）
function pulseScore() {
  const el = elements.score;
  if (!el) return;
  el.classList.remove("stat-pulse");
  void el.offsetWidth; // アニメーション再トリガー
  el.classList.add("stat-pulse");
}

// Knowledge Map（Phase A）: 答え表示時に派生語ファミリーを1行見せる。
// 「単語は孤立した点ではなく、つながっている」ことの予告編
function renderWordFamily(word) {
  if (!elements.wordFamily) return;

  const lines = [];
  if (Array.isArray(word.family) && word.family.length > 0) {
    const names = word.family
      .map((id) => findWord(id))
      .filter(Boolean)
      .map((w) => `${w.en}（${w.ja}）`);
    if (names.length) lines.push(`仲間の語: ${names.join("・")}`);
  }
  // 紛らわしい語（affect/effect, adapt/adopt …）: 綴りが1〜2文字違いの語を並べて混同を潰す
  const confusables = findConfusables(word);
  if (confusables.length) lines.push(`似た綴り: ${confusables.map((w) => `${w.en}（${w.ja}）`).join("・")}`);

  elements.wordFamily.textContent = lines.join("　");
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function findConfusables(word) {
  if (!word || isConceptWord(word) || !/^[a-z-]{4,}$/.test(word.en)) return [];
  const family = new Set(Array.isArray(word.family) ? word.family : []);
  const seen = new Set([word.id]);
  const maxDistance = word.en.length >= 7 ? 2 : 1;
  const out = [];
  for (const w of getWordsByCategory(word.category === "my" ? "my" : "all")) {
    if (seen.has(w.id) || family.has(w.id) || isConceptWord(w) || !/^[a-z-]+$/.test(w.en)) continue;
    seen.add(w.id);
    if (levenshtein(word.en, w.en) <= maxDistance) out.push(w);
    if (out.length >= 3) break;
  }
  return out;
}

function handleCorrectChar(typedChar) {
  elements.input.value += typedChar;
  updateTypedPreview(elements.input.value);
  return acceptChar(typedChar);
}

// 1文字受理の共通処理（DOMの入力欄には触れない）。単語完成ならtrueを返す
function acceptChar(typedChar) {
  if (typedChar !== undefined) markFirstKey(); // ヒントで足した字（useHint は字を渡さない）はこの語の最初のキーにしない
  typedSoFar += typedChar ?? currentWord.en[currentIndex];
  currentIndex = typedSoFar.length;
  correctChars++;
  updateTypeSpeed();

  const done = completedAnswer(activeCandidates(), typedSoFar);
  if (done) {
    // 打った綴りより長い候補が残っている（gym → gymnasium、a → an、sport → sports）: 続けて打たれた続きを次の語の打鍵にしない
    const rests = continuationsOf(activeCandidates(), typedSoFar);
    if (rests.length > 0) startSpellingSpill(rests);
    else clearSpill();
    finishTypedAnswer(done);
    return true;
  }

  return false;
}

// 打ち終わった綴りで分岐。出題語ならそのまま正解、別解なら減点せずに出題語を見せる
function finishTypedAnswer(typed) {
  if (typed === currentWord.en) {
    completeWord();
    return;
  }
  // つづり違い（favourite / favorite）は同じ語。打ち直させずにそのまま正解にする
  if (isSpellingVariant(typed, currentWord.en)) {
    completeWord();
    showResult(`${typed} も正解（この教材では ${currentWord.en}）`, "info", true);
    return;
  }
  acceptAlternative(typed);
}

// ===== 習熟度: 1 問ごとの速さと、回で最初に答えた語の段（docs/SPEC_MASTERY.md §3.4・§4.7） =====

// この語の最初のキー（英単語の受理・打ち間違い・ローマ字の受理）。出題の rAF より前に来た・前の語の続きが残っていた間に来たら測らない
function markFirstKey() {
  const t = wordTiming;
  if (!t || t.serial !== wordSerial || t.tFirst !== null) return;
  t.tFirst = performance.now();
  t.input = keyPath;
  if (t.tShow === null || t.spill) t.invalid = true;
}

// 同じ訳の語があり、例文の訳を添えて出す問い（例文の有無によらず、訳だけで決まらない問いは測らない）
function isAmbiguousCached(word) {
  const key = `${activeCategory}|${word.id}`;
  if (!ambiguousCache.has(key)) ambiguousCache.set(key, isAmbiguousPrompt(word));
  return ambiguousCache.get(key);
}

// 今の語の速さの見本 { t1, pc }（ms）。測らない語は null。t1 = 出題から最初のキー、pc = 1 字あたり（打った字数 3 以上のときだけ）。
// 200ms 未満（先打ちの疑い）は js/masteryMeta.js が測らない答えとして扱う
function speedSample(tDone) {
  const t = wordTiming;
  if (!t || t.serial !== wordSerial || t.invalid || t.tShow === null || t.tFirst === null) return null;
  if (isAmbiguousCached(currentWord)) return null;
  const chars = romajiMode ? String(romaji?.keys ?? "").length : typedSoFar.length;
  return { t1: t.tFirst - t.tShow, pc: chars >= 3 ? (tDone - t.tFirst) / (chars - 1) : null };
}

// 速さの箱: 答えの種類（英語の綴り／ローマ字の答え）× 最初のキーの経路 × Study／遊び（Challenge・Daily）
function speedBox() {
  return boxKey({ lang: romajiMode ? "ja" : "en", input: wordTiming?.input, ctx: mode === "study" ? "study" : "play" });
}

// 答えを 1 つ控える（○ は recordRecallSuccess、× は recordRecallFail のとき）。回で最初の答えなら答える前の段と同じ日の扱いを、
// 遅い正解で 5 → 4 になったら slowDown を。この回で × があれば slowDown は外す（「時間がかかった」ではなく「下がった」）
function noteRunAnswer(id, { before = 0, ok, speed = "unknown", sameDay = false, after = null }) {
  const entry = runRankBefore.get(id);
  if (!entry) {
    runRankBefore.set(id, { before, seenToday: !!sameDay, slowDown: !!ok && speed === "slow" && before === 5 && after === 4 });
    return;
  }
  if (!ok) entry.slowDown = false;
}

let studyWordsSinceSync = 0;

function completeWord() {
  const tDone = performance.now(); // 速さ: 打ち終えた時刻（1 字あたりの見張り）
  keepMessage = false;
  let holdMs = 0; // チュートリアル T3 を出した語の最低の待ち（js/tutorial.js が spelldash:recall の detail.hold に書く）
  score++;
  elements.score.textContent = score;
  pulseScore();
  hideHint();

  // 自力 = 答えもヒントも見ていない
  const selfRecall = !isRevealed && !hintUsed;

  if (selfRecall) {
    sfxCorrect(combo);
  } else {
    sfxSoftCorrect();
  }

  // Dailyのシェア用グリッド: 🟩自力正解 🟨答えを見て正解
  if (dailyRun && mode === "challenge") {
    dailyRun.emoji.push(isRevealed ? "🟨" : "🟩");
  }

  // Studyは終了イベントがないため、10語ごとにクラウド同期
  if (mode === "study") {
    studyWordsSinceSync++;
    if (studyWordsSinceSync >= 10) {
      studyWordsSinceSync = 0;
      pushSync();
    }
  }

  // clean = 思い出せて、かつ打ち間違いもなし（ヒント使用は hasMissedCurrentWord=true で除外済み）
  const isClean = !hasMissedCurrentWord && selfRecall;

  // 当日初の自力正解かどうか（XPと学習ループの判定に使う。記録前に見る）
  const prevStat = getWordStats()[currentWord.id];
  const firstRecallToday = !isRecalledToday(prevStat);

  // 学びの瞬間を判定（記録前の状態で）:
  //  learned   = 別の日に思い出せなかった語を、今日自力で思い出せた（学習成立）
  //  recovered = 同じ日の失敗からの回復（Recall Loop）
  //  retained  = 1日以上前に覚えた語を復習で思い出せた（定着）
  //  known     = 初見でノーミス自力正解（もともと知っていた）
  let learnEvent = null;
  if (mode === "study" && selfRecall && prevStat) {
    if (isUnresolved(prevStat)) {
      const failDay = prevStat.lastRecallFailAt ? localDateString(new Date(prevStat.lastRecallFailAt)) : null;
      learnEvent = failDay && failDay !== localDateString() ? "learned" : "recovered";
    } else if (isClean && isFirstAnswer(prevStat)) {
      // 初見 = まだ一度も答えていない（js/mastery.js。出題の回数は見ない: 出題だけされて答えなかった語も知ってたになれる）
      learnEvent = "known";
    } else if (isReviewAttempt(prevStat)) {
      learnEvent = "retained";
    }
  }

  // 習熟度（自力正解のときだけ。書き手の前に、答える前の stat から）: 答えの文脈・速さの分類（入れる前の箱と比べる）
  const answerCtx = selfRecall && prevStat ? answerContext(prevStat, Date.now()) : null;
  const sample = answerCtx && isClean ? speedSample(tDone) : null;
  const box = sample ? speedBox() : null;
  const { speed, basis } = sample && box ? classifySpeed(sample, box, { firstAnswer: answerCtx.firstAnswer }) : { speed: "unknown", basis: null };
  let ranks = null; // { before, after }（盤面の文の「習熟度 …」）

  recordCorrect(currentWord.id, isClean, answerCtx); // 答える前の文脈は上で出したものを渡す（書き手で二重に計算しない。答えを見た後の打ち直しは null）

  // 答えを見ずに正解 = 自力で思い出せた（打ち間違いは許容）
  // ※答え表示後の入力練習では lastRecallSuccessAt を更新しない
  let loopResult = null;
  if (selfRecall) {
    consecutiveFails = 0;
    recordRecallSuccess(currentWord.id, { clean: isClean, speed });
    if (answerCtx) {
      // 本人の基準に入れるのは、初めての答えかその日の最初の答えで、ノーミス・測れた答えだけ（分類は上で済ませた）
      if (sample && box && (answerCtx.firstAnswer || answerCtx.firstOfDay)) noteSpeedSample(box, sample);
      if (answerCtx.firstAnswer && speed === "fast") notePendingFirstFast(currentWord.id, basis);
      ranks = { before: answerCtx.rank, after: rankOf(getWordStats()[currentWord.id]) };
      noteRunAnswer(currentWord.id, { before: ranks.before, ok: true, speed, sameDay: answerCtx.sameDay, after: ranks.after });
    }
    const recallDetail = { id: currentWord.id, mode };
    window.dispatchEvent(new CustomEvent("spelldash:recall", { detail: recallDetail })); // チュートリアル（js/tutorial.js）
    holdMs = Number(recallDetail.hold) || 0;
    if (mode === "study") bumpActivity("studyCorrect"); // KPI心拍

    if (mode === "study") {
      speakOnCorrect(speechTextOf(currentWord)); // 綴りを打てた直後に音でも確認（設定で切れる）
      loopResult = queueRecallSuccess(currentWord.id);
      playRecallSuccessEffect();
      updateRecalledToday();

      if (learnEvent === "learned" || learnEvent === "recovered") {
        if (!setLearnEvents.has(currentWord.id) || learnEvent === "learned") setLearnEvents.set(currentWord.id, learnEvent);
      }
      renderWordHistory();

      // 今日のセット: 自力正解のユニーク語を数える
      if (!setRecalled.has(currentWord.id)) {
        setRecalled.add(currentWord.id);
        if (currentWordKind === "new") setNewCount++;
        if (currentWordKind === "review") setReviewCount++;
        renderSetProgress();
        // 60 秒の回は語数で終わらない（時計で終わる）
        if (runKind !== "timed" && setRecalled.size >= currentSetSize()) setCompletePending = true;
        saveResumePoint();
      }
    }
  }

  if (isClean) {
    combo++;
  }
  updateCombo(combo);

  // XP: 答えを見た後の練習は+5（Studyでは同一単語につきセッション1回まで）。
  // 自力正解は 基本10+クリーン5+コンボ最大10。
  // ただしStudyでの同日反復（2回目以降の自力正解）は少額XP（反復の目的は定着でありXP稼ぎではない）
  let wordXp;
  if (!selfRecall) {
    wordXp = mode === "study" ? (claimPracticeXp(currentWord.id) ? 5 : 0) : 5;
  } else if (mode === "study" && !firstRecallToday) {
    wordXp = REPEAT_SUCCESS_XP;
  } else {
    wordXp = 10 + (isClean ? 5 : 0) + Math.min(combo, 10);
  }
  let earned = wordXp;

  const missionResult = markMissionWord(currentWord.id);
  earned += missionResult.bonusXp;
  renderMission();

  if (mode === "study") {
    applyStudyXp(earned, missionResult, loopResult, learnEvent, ranks);
    if (consumeBoostNote()) {
      setTimeout(() => showMessage("知っている語が多い。少し難しい単語も混ぜる", "revealed"), 1200);
    }
    announcePlacement();
  } else {
    gainedXp += earned;

    // Challenge 中の XP は結果パネルの 1 か所にまとめる（打っている最中に動く数字を増やさない）
    showResult(missionResult.justCompleted ? "ミッション達成" : "正解", "correct");
  }

  // Challenge/Daily: 待ち時間ゼロで次の単語へ（60秒×30語で7.5秒あった空白をなくす）。
  // 正解の音・スコアのパルスは非同期で重なるのでテンポを止めない
  if (mode !== "study") {
    renderPlayScore();
    setNewWord();
    return;
  }

  // Study: 正解の手応えのあと次へ。自力で正解した例文つきの語・概念カードは、答えと例文・解説を少しだけ見せる（Enter で即進行）。
  // 長さは設定「正解のあと」（js/afterCorrect.js）。答えを見た語・腕試しは手応えだけ（表示の時に読んでいる／テンポ優先）
  const concept = isConceptWord(currentWord);
  const { ms, glance } = waitAfterCorrect({
    concept,
    withExample: hasExample(currentWord),
    revealed: isRevealed,
    placement: isPlacementRun(),
    pace: timedRun() ? "quick" : getAfterCorrect() // 60 秒の回は「すぐ次へ」（250ms・例文は見せない）
  });
  if (glance) {
    renderExplain(currentWord);
    showAnswer();
  } else if (concept && !isRevealed) {
    showAnswer(); // 読みを打った語は答えの漢字を一目（すぐ次へ・腕試し）
  }
  if (listenMode) elements.japanese.textContent = promptOf(currentWord);
  // 節目（覚えた・レベルアップの幕）とチュートリアル T3 の語は、演出・札が次の語に重ならない長さまで待つ
  const wait = Math.max(ms, milestoneThisWord ? MILESTONE_MS : 0, holdMs);
  const serialAtComplete = wordSerial;
  awaitingNext = true;
  waitInputBase = elements.input.value.toLowerCase().replace(/[^a-z]/g, "");
  completedAt = performance.now();
  // 本来の待ちの終わり（completedAt は続きの打鍵で進む〔advanceSpill〕ので、待ちを始めた時刻からここで決めて取っておく。1 打目の守り）
  const waitEnd = completedAt + wait;
  // 1 打目の守りの幅（続きの最後の打鍵から）: 本来の待ち（節目・チュートリアルの保持を含む）。ただし標準のペースの表の、この語の種類の値まで
  // （英単語 0.7 秒・概念カード 0.9 秒。例文の無い語の表の値 0.25 秒では、覚えた の 1.4 秒の待ちでも幅が 0 になる。REVIEW-155 の 3）。
  // 長いペースの表の値（2.2 秒・2.6 秒）のままだと、次の語が見えて 2 秒近くたってからの本物の打ち間違いまで捨てる（isAdvanceEcho の上の注釈）
  const tailMs = Math.min(wait, GLANCE_MS.standard[concept ? "concept" : "example"]);
  clearTimeout(advanceTimer);
  const tick = () => {
    if (!isPlaying || wordSerial !== serialAtComplete) return;
    // 待ちの間に作った覚え方を読んでいる: 自動では進めない（Enter で次へ）
    if (readingHold) return;
    // 覚え方のメモを書いている間・覚え方を作っている間は進めない（次の語の renderWordNote(null) が書きかけを消す）
    if (isEditingNote() || isMakingWordAi()) {
      advanceTimer = setTimeout(tick, NOTE_RECHECK_MS);
      return;
    }
    // 前の語の続き（gymnasium の nasium・いわじゅくいせき の いせき）を打っている: 次の語を出す時刻 = max(本来の待ちの終わり,
    // 最後の続きの打鍵 + SPILL_HOLD_MS〔まだ続く〕／+ SPILL_TAIL_MS〔2 打以上で打ち切った〕)。続きを打たない人・1 打の続き（語末の ん の 2 つ目の n）の待ちは変わらない。
    // 次の語が全文入力なら、打ち切った後も待ちを縮めない（+ SPILL_TAIL_MS の代わりに + 本来の待ちの長さ。続きの直後の余分な 1 打が入力欄に入らない。REVIEW-155 の 1）
    const nextFree = nextStudyWordIsFree();
    const hold = spillHoldLeft(nextFree ? wait : SPILL_TAIL_MS);
    if (hold > 0) {
      // まだ続きを打っている間は 100ms ごとに見直す（打ち切ったら時刻が縮む）。打ち切った後は残りをそのまま待つ
      advanceTimer = setTimeout(tick, spill?.live ? Math.min(SPILL_RECHECK_MS, hold) : Math.max(10, hold));
      return;
    }
    // 2 打以上の続きを打ち切り、次の語を出す時刻が SPILL_TAIL_MS で決まった（最後の続きの打鍵 + SPILL_TAIL_MS が本来の待ちの終わりより後＝待ちを縮めた）:
    // 出す時刻はそのまま（テンポは変えない）。続きの最後の打鍵から tailMs までの次の語の 1 打目で、次の語が拒む字（続きの直後の空白・gymnasiums の s）は
    // ミスにせず捨てる（gym と打って空白を打つ人は本来の待ちの間に空白が捨てられるのと同じ扱い。REVIEW-153 の 6）。続きを速く打ち切って本来の待ちの終わりに
    // 出したとき（待ちは縮んでいない）・余分な 1 打がもう待ちの間に来たとき（spill.extra）・次の語が全文入力のときは守らない（isAdvanceEcho の上の注釈）
    const s = spill;
    const shortened = !nextFree && !!s && s.n >= 2 && s.ended && !s.extra && s.at + SPILL_TAIL_MS > waitEnd;
    advanceNow("timer", shortened ? s.at + tailMs : -Infinity);
  };
  advanceTimer = setTimeout(tick, wait);
}

// 成長ログ: 覚えた語数のスナップショット（今週+N・30日推移の材料）
function snapshotGrowth() {
  try {
    recordGrowthSnapshot({ ...getLearnedCounts(), legacyLearned: computeLegacyLearnedCount });
  } catch {
    // ログは装飾
  }
}

// ===== 今日のセット: 進捗と完了 =====
// セットの目標語数（回収モードではその語数）
function currentSetSize() {
  return runSize; // startGame が回の始めに決めた語数（もう一度は語の数、続きからは保存した語数）
}

function renderSetProgress() {
  const el = document.getElementById("setProgress");
  if (!el) return;
  if (!isPlaying || mode !== "study") {
    delete el.dataset.timed;
    el.innerHTML = "";
    return;
  }
  if (runKind === "timed") {
    // 60 秒の回: 同じ 3 つの要素で残りの秒（高さは語数のときと同じ）。数字と棒は tick ごとに renderTimedClock が替える
    const total = TIMED_SECONDS * 1000;
    const left = timedRemainingMs();
    el.dataset.timed = "1";
    el.innerHTML = `
    <span class="set-progress__label">${TIMED_SECONDS}秒</span>
    <span class="set-progress__count">残り <b>${Math.ceil(left / 1000)}</b>秒</span>
    <span class="set-progress__bar"><i style="width:${prefersReducedMotion() ? 100 : (left / total) * 100}%"></i></span>
  `;
    return;
  }
  delete el.dataset.timed;
  const size = currentSetSize();
  const done = Math.min(setRecalled.size, size);
  el.innerHTML = `
    <span class="set-progress__label">${retryIds ? "もう一度" : "今日のセット"}</span>
    <span class="set-progress__count"><b>${done}</b> / ${size}</span>
    <span class="set-progress__bar"><i style="width:${(done / size) * 100}%"></i></span>
  `;
}

// ===== 「覚えた！」の瞬間 =====
// 別の日に思い出せなかった語を今日自力で思い出せた＝学習成立。ここだけは大きく祝う
function celebrateLearned(word, earned, note = "") {
  const jaShort = word.ja.length > 22 ? `${word.ja.slice(0, 22)}…` : word.ja;
  const line = `覚えた！ ${word.en}（${jaShort}）${earned > 0 ? `  +${earned} XP` : ""}${note}`;
  if (timedRun()) {
    // 60 秒の回: メッセージ行の「覚えた！ X」だけ（スタンプ・はちゃんの知らせは出さない。待ちも延ばさない）
    sfxSparkle();
    showResult(line, "learned", true);
    return;
  }
  milestoneThisWord = true; // スタンプ（1.4 秒）が消えるまで次の語を出さない
  sfxSparkle();
  sfxComplete();

  const card = document.getElementById("gameCard");
  if (card) {
    card.classList.remove("game-card--learned");
    void card.offsetWidth;
    card.classList.add("game-card--learned");
    const stamp = document.createElement("div");
    stamp.className = "learn-stamp";
    stamp.textContent = "覚えた";
    card.appendChild(stamp);
    setTimeout(() => stamp.remove(), 1400);
  }

  showResult(line, "learned", true);

  const toast = document.getElementById("learnToast");
  if (toast) {
    toast.innerHTML = hasumiBubbleHtml(hasumiLearnedLine(word.en), "hasumi--result");
    toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.hidden = true;
    }, 4500);
  }
}

// 単語の履歴ドット（× × ○ ○）を単語の下に出す（Studyのみ）
function renderWordHistory() {
  const el = document.getElementById("wordHistory");
  if (!el) return;
  if (mode !== "study" || !currentWord) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = historyDotsHtml(getWordStats()[currentWord.id]);
}

// Challenge/Dailyプレイ中: カード内にスコアとコンボを常設（統計カードは視界外のため）
function renderPlayScore() {
  const el = document.getElementById("playScore");
  if (!el) return;
  const active = isPlaying && mode === "challenge";
  el.hidden = !active;
  if (!active) return;
  const tier = combo >= 20 ? "max" : combo >= 10 ? "blaze" : combo >= 5 ? "hot" : combo >= 2 ? "on" : "";
  el.innerHTML = `
    <span class="play-score__value">${score}</span>
    <span class="play-score__combo ${tier ? `play-score__combo--${tier}` : ""}">${combo >= 2 ? `×${combo}` : ""}</span>
  `;
}

// 完了パネル: 数字ではなく語で見せる（覚えた！／思い出せた／思い出せず）
function renderSetWordChips() {
  const chip = (id, cls = "") => {
    const w = findWord(id);
    return w ? `<button type="button" class="word-chip ${cls}" data-speak="${w.en}"><b>${w.en}</b><small>${w.ja}</small></button>` : "";
  };
  const learned = [...setLearnEvents].filter(([, e]) => e === "learned").map(([id]) => id);
  const recovered = [...setLearnEvents].filter(([, e]) => e === "recovered").map(([id]) => id);
  const failed = [...setFailed].filter((id) => !setRecalled.has(id));
  const group = (title, ids, cls) =>
    ids.length ? `<div class="word-chips"><span class="word-chips__title">${title}</span>${ids.map((id) => chip(id, cls)).join("")}</div>` : "";
  return (
    group("覚えた（前は出てこなかった語）", learned, "word-chip--learned") +
    group("思い出せた（2回目）", recovered, "word-chip--recovered") +
    group("思い出せず", failed, "word-chip--failed")
  );
}

// 回で最初に答えた直前の段（before）と今の段（after）から、語チップに添える 1 語。同じなら無し（矢印・記号は使わない）。
// 正解の遅さだけで 5 → 4 になった語は「時間がかかった」（正解したのに「下がった」と出て不具合に見えないように）
function rankMoveLabel({ before, slowDown }, after) {
  if (before === 0) return "初めて";
  if (after > before) return "上がった";
  if (after === before - 1 && slowDown) return "時間がかかった";
  if (after < before) return "下がった";
  return "";
}

// 60 秒の終わりのパネル: この回に答えた語を、終わりの時点の段ごとに（5 → 1。0 語の群は出さない。群の中は回で最初に答えた順）。
// 答えた語が 0 なら題も群も出さない。今日もう答えていた語があれば「習熟度が上がるのは…」の行（同じ日の 2 回目では上がらない）
function renderRankGroups() {
  const stats = getWordStats();
  const rows = [];
  for (const [id, entry] of runRankBefore) {
    const word = findWord(id);
    const after = rankOf(stats[id]);
    if (word && after >= 1) rows.push({ word, entry, after });
  }
  if (rows.length === 0) return "";
  let html = `<p class="rank-groups__title">習熟度（この回に答えた語）</p>`;
  for (let n = RANK_NAMES.length - 1; n >= 1; n--) {
    const group = rows.filter((r) => r.after === n);
    if (group.length === 0) continue;
    const chips = group
      .map(({ word, entry, after }) => {
        const move = rankMoveLabel(entry, after);
        // ボタンの名前は「budget 予算 上がった」と読まれる（flex の中の空白は見た目に影響しない）
        return `<button type="button" class="word-chip" data-speak="${escapeHtml(word.en)}"><b>${escapeHtml(word.en)}</b> <small>${escapeHtml(word.ja)}</small>${move ? ` <span class="word-chip__move">${move}</span>` : ""}</button>`;
      })
      .join("");
    html += `<div class="word-chips rank-group" role="group" aria-labelledby="rankGroup${n}"><span class="word-chips__title" id="rankGroup${n}">${rankHtml(n)}</span>${chips}</div>`;
  }
  if (rows.some((r) => r.entry.seenToday)) html += `<p class="rank-groups__note">習熟度が上がるのは、各語その日の最初の答えだけ。</p>`;
  return html;
}

// 語数のセットの完了パネル・Challenge／Daily の結果: 回の前が段 1 以上で段が動いた語だけ、1〜2 行（無ければ何も足さない）。
// 「習熟度が上がった: budget（身についた）・ invoice（思い出せる）」。1 行 8 語まで、残りは「ほか N語」。exclude = 「覚えた」のチップの語（必ず 1 → 2 で上がっている）
const RANK_MOVES_PER_LINE = 8;
function renderRankMoves(exclude = new Set()) {
  const stats = getWordStats();
  const ups = [];
  const downs = [];
  for (const [id, entry] of runRankBefore) {
    if (entry.before < 1) continue;
    const after = rankOf(stats[id]);
    const word = findWord(id);
    if (!word || after < 1 || after === entry.before) continue;
    if (after > entry.before) {
      if (!exclude.has(id)) ups.push(`${escapeHtml(word.en)}（${RANK_NAMES[after]}）`);
    } else {
      downs.push(`${escapeHtml(word.en)}（${RANK_NAMES[after]}${rankMoveLabel(entry, after) === "時間がかかった" ? "・時間がかかった" : ""}）`);
    }
  }
  const line = (label, items) =>
    items.length
      ? `<p class="rank-moves">${label}: ${items.slice(0, RANK_MOVES_PER_LINE).join("・ ")}${items.length > RANK_MOVES_PER_LINE ? ` ほか${items.length - RANK_MOVES_PER_LINE}語` : ""}</p>`
      : "";
  return line("習熟度が上がった", ups) + line("習熟度が下がった", downs);
}

// 腕試し（初回10語）の結果を1回だけ伝える。答え表示後にも出るよう、少し遅らせて上書きする
function announcePlacement() {
  const p = consumePlacementNote();
  if (!p) return;
  document.body.classList.remove("placement"); // 腕試しが確定した。ここから先の数字は本物（css/home.css）
  const line =
    p.boost >= 2
      ? `腕試し: ${p.total}語中 ${p.known}語 知ってた。難しい単語も最初から混ぜていく`
      : p.boost === 1
        ? `腕試し: ${p.total}語中 ${p.known}語 知ってた。少し難しい単語も混ぜていく`
        : p.known === 0
          ? "腕試し終わり。基本の単語から積み上げる"
          : `腕試し: ${p.total}語中 ${p.known}語 知ってた。まずは基本の単語から積み上げる`;
  setTimeout(() => showMessage(line, "revealed"), 1300);
}

// timed = 60 秒の回の終わり（時間切れ・苦手のみで出題が尽きた）。続きからの地点は残さず、語数のセットの続きも消さない。
// 自力で思い出せた語が 1 語以上の回だけ今日のぶん（7 日のドット・解放の累計・user_items の day）に数える（時間を流すだけで進む抜け道を塞ぐ）
function endStudySession({ timed = false } = {}) {
  learnedCardStale = false; // 下で自分で描く（notifyGameEnd で二重に描かない）
  clearInterval(timer);
  isPlaying = false;
  timedHiddenAt = null;
  wordTiming = null; // 時間切れの語の T1 は捨てる
  notifyGameEnd();
  setCompletePending = false;
  currentWord = null;
  if (!retryIds && !timed) clearSession(); // セットを終えたので「前回の続き」は消す
  flushMasteryMeta(); // 速さの基準・確かめの集計（変わっていれば 1 回だけ書く）

  const isRetry = !!retryIds;
  retryIds = null;
  const recalled = setRecalled.size;
  const failedIds = [...setFailed].filter((id) => !setRecalled.has(id));
  const failed = failedIds.length;
  const countsAsSet = !isRetry && (!timed || recalled >= 1);
  const state = countsAsSet ? markDailySetDone(recalled) : { setsToday: getSetsToday() };
  pushSync();
  window.dispatchEvent(new CustomEvent("spelldash:session-end", { detail: { recalled, failed: failedIds.length, retry: isRetry, ...(timed ? { timed: true } : {}) } })); // ホームの道を描き直す

  // 完了画面: 出題 UI は畳む（body.set-done → css/card.css）。完了の事実は見出し 1 つ、数字は 1 行
  document.body.classList.add("set-done");
  elements.japanese.textContent = "";
  setPromptLabel("");
  showHiddenWordText("");
  const meta = document.getElementById("wordMeta");
  if (meta) meta.textContent = "";
  renderStudyQueue(false);
  renderSetProgress();
  renderLearnedCard();
  renderHasumiHome();

  // 明日までに復習期日が来る語（今日片付けた分は除く）
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(23, 59, 59, 999);
  const dueTomorrow = getDueReviewCount(activeCategory, tomorrow.getTime());
  const dueWords = getDueReviewWords(activeCategory, tomorrow.getTime(), 3);
  const tomorrowLine =
    dueTomorrow > 0
      ? `<div class="result-panel__tomorrow">明日の復習: <b>${dueWords.map((w) => w.en).join("・")}</b>${dueTomorrow > dueWords.length ? ` ほか${dueTomorrow - dueWords.length}語` : ""}</div>`
      : `<div class="result-panel__tomorrow">明日の復習はまだ無い。新しい語から</div>`;

  // 週の目標（学習日数）: ちょうど達成した日だけ一言添える（途中経過の数字は出さない。数字は 1 行の原則）
  const goal = getWeekGoal();
  const activeDays = getActiveDaysThisWeek();
  const goalLine = activeDays === goal ? `<div class="result-panel__goal">今週の目標 ${goal}日 達成</div>` : "";

  const panel = document.getElementById("resultPanel");
  if (panel) {
    const hasumiLine = timed && recalled === 0
      ? hasumiSetLine({ timedEmpty: true, failed }) // 60 秒の回で思い出せた 0 語: 今日のぶんにはならない（2 通りの事実だけ）
      : isRetry
        ? failed === 0
          ? { mood: "happy", text: "全部回収した。" }
          : { mood: "normal", text: "残りは明日また出す。" }
        : hasumiSetLine({ count: recalled, failed, recovered: [...setFailed].filter((id) => setRecalled.has(id)).length, sets: state.setsToday }); // 答えを見てから思い出せた語（再開後も残る setFailed から）
    const title = timed ? (recalled > 0 ? "今日のセット完了" : "60秒 終わり") : isRetry ? "回収完了" : "今日のセット完了";
    // 語: 60 秒の回は段ごとの語チップ（この回に答えた語）。語数の回は今の語チップと、その下に段が動いた語の行（「覚えた」のチップの語は除く）
    const learnedIds = new Set([...setLearnEvents].filter(([, e]) => e === "learned").map(([id]) => id));
    const wordsHtml = timed ? renderRankGroups() : `${renderSetWordChips()}${renderRankMoves(learnedIds)}`;
    // 次に「もう…」で始まる回が 60 秒なら「もう60秒」（腕試し・もう一度・続きからの回の後も）。60 秒の回では Challenge のボタンを並べない（60 秒が 2 つで紛れる）
    const againLabel = nextRunIsTimed() ? "もう60秒" : "もう1セット";
    panel.innerHTML = `
      <h2 class="result-panel__title" id="resultTitle" tabindex="-1">${title}</h2>
      ${hasumiBubbleHtml(hasumiLine, "hasumi--result")}
      <div class="result-panel__grid">
        <div><span>思い出せた</span><strong>${recalled}</strong></div>
        <div><span>思い出せず</span><strong>${failed}</strong></div>
      </div>
      ${wordsHtml}
      ${tomorrowLine}
      ${goalLine}
      <div class="result-panel__actions">
        ${failed > 0 ? `<button type="button" class="result-panel__action" id="setRetry">思い出せなかった${failed}語をもう一度</button>` : ""}
        <button type="button" class="result-panel__action${failed > 0 ? " result-panel__action--ghost" : ""}" id="setAgain">${againLabel}</button>
        ${timed ? "" : `<button type="button" class="result-panel__action result-panel__action--ghost" id="setChallenge">Challenge（60秒）</button>`}
        ${canInstall() ? `<button type="button" class="result-panel__action result-panel__action--ghost" id="setInstall">ホーム画面に追加</button>` : ""}
      </div>
    `;
    panel.hidden = false;
    if (focusResultTitle(panel)) panel.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    panel.querySelectorAll("[data-speak]").forEach((chip) => chip.addEventListener("click", () => speak(chip.dataset.speak)));
    document.getElementById("setRetry")?.addEventListener("click", () => {
      clearInterval(timer);
      isPlaying = false;
      startGame({ retry: failedIds });
      elements.input.focus();
    });
    document.getElementById("setInstall")?.addEventListener("click", async (event) => {
      const outcome = await promptInstall();
      event.currentTarget.textContent = outcome === "accepted" ? "追加しました" : "ホーム画面に追加";
    });
    document.getElementById("setAgain")?.addEventListener("click", () => {
      restartGame();
      elements.input.focus();
    });
    document.getElementById("setChallenge")?.addEventListener("click", () => {
      setMode("challenge");
      startGame();
      elements.input.focus();
    });
  }

  showMessage(""); // 完了の事実はパネルの見出しが言う
}

// Studyモードは1語ごとに即XP反映（セッションの「終了」がないため）
// ranks = { before, after }（この答えの前後の習熟度。自力正解のときだけ）
function applyStudyXp(earned, missionResult, loopResult, learnEvent = null, ranks = null) {
  markActiveToday();
  snapshotGrowth();
  learnedCardStale = true; // プレイ中は畳まれて見えない（css/room.css の body.home--playing）。終わったら notifyGameEnd が描く
  const streak = updateStreak();
  if (streak.isFirstToday) {
    earned += 50;
    renderHeaderStreak();
    renderHasumiHome();
  }

  // シールド獲得（5 日ごとに 1 回きり）: 「覚えた」「レベルアップ」の行が勝っても、音と注記は落とさない
  const shieldNote = streak.earnedShield ? " ・ シールド獲得（1日休んでも切れない）" : "";
  if (streak.earnedShield) sfxSparkle();

  const result = addXp(earned);
  renderLevelBar();

  // 「覚えた！」は他の何より先に祝う（学習が成立した瞬間）
  if (learnEvent === "learned") {
    celebrateLearned(currentWord, earned, shieldNote);
    return;
  }

  if (result.leveledUp) {
    playLevelUpEffect();
    sfxLevelUp();
    // ランクが変わる節目はオーバーレイ 1 つ、それ以外は 1 行。両方は出さない
    if (isPlacementRun() || timedRun() || !celebrateRankUp(result)) {
      showResult(`Lv.${result.after.level} に上がった${unlockNoteForLevel(result.after.level)}${shieldNote}`, "finished", true);
    } else {
      showResult(`思い出せた${shieldNote}`, "correct", !!shieldNote); // 幕が節目。1 行の「思い出せた」は次の語で消す
    }
    return;
  }

  // 連続日数は自力正解のときだけ言う。ただしシールド獲得は答えを見た語でも知らせる
  if (streak.isFirstToday && streak.current >= 2 && (!isRevealed || streak.earnedShield)) {
    showResult(`${streak.current}日連続${shieldNote}`, "correct", true);
    return;
  }

  if (missionResult.justCompleted) {
    sfxComplete();
    showResult(`ミッション達成 +${missionResult.bonusXp} XP`, "correct", true);
    return;
  }

  // New単語を今日4回思い出せた → 静かに定着を伝える
  if (loopResult?.secured) {
    sfxComplete();
    showResult("今日はもう出ない", "correct");
    return;
  }

  // ヒントを見て打てた: 自力ではないが、次に自力で打てる準備はできた
  if (hintUsed && !isRevealed) {
    showResult(`ヒントありで打てた。数問後にもう一度、今度は自力で${earned > 0 ? `  +${earned} XP` : ""}`, "revealed");
    return;
  }

  // 自力正解: 学びの種類ごとに違う言葉で（数字より意味）
  if (!isRevealed) {
    const xp = earned > 0 ? `  +${earned} XP` : "";
    const stat = getWordStats()[currentWord.id];
    if (stat?.mastered) {
      sfxComplete();
      showResult(`${currentWord.en} を習得。10回連続で思い出せた${xp}`, "learned", true);
      return;
    }
    if (learnEvent === "recovered") {
      sfxSparkle();
      showResult(`思い出せた。さっき思い出せなかった ${currentWord.en}`, "correct", true);
      return;
    }
    if (learnEvent === "retained") {
      const days = stat?.lastReviewAt && stat?.history?.length > 1
        ? Math.max(1, Math.round((Date.now() - Date.parse(stat.history[stat.history.length - 2]?.d ?? stat.lastReviewAt)) / 86400000))
        : null;
      // 「定着」は保持率（7 日窓）の言葉なので使わない。この答えで段が 身についた・即答 に上がったときだけ添える
      const promo = ranks && ranks.after >= 4 && ranks.after > ranks.before ? `。習熟度 ${RANK_NAMES[ranks.after]}` : "";
      showResult(`${days ? `${days}日ぶりでも` : ""}思い出せた${promo}${xp}`, "correct");
      return;
    }
    if (learnEvent === "known") {
      // 初見の日なので「身についた」と過去形で言わない。確認待ちの間は補充に出ない（S6）ので「2週間後に確認」は事実
      showResult(
        ranks?.after === 4 ? `知ってた。${currentWord.en} はもう身についている。2週間後に確認${xp}` : `知ってた。${currentWord.en} は2週間後に確認${xp}`,
        "correct",
        true
      );
      return;
    }
    const streakCount = stat?.cleanCorrectStreak ?? 0;
    showResult(`思い出せた${streakCount >= 2 ? `（${streakCount}回目）` : ""}${xp}`, "correct");
    return;
  }

  showResult("正解", "correct");
}

// 打ち間違い: 答えは表示しない（覚えていたかどうかとは別のデータとして記録）
function handleTypingMiss(expectedChar = currentWord?.en[currentIndex], typedChar = "") {
  markFirstKey();
  clearSpill(); // この語の本当のミス。前の語の続きとしては見ない
  typingMissCount++;
  elements.miss.textContent = typingMissCount;
  hasMissedCurrentWord = true;
  combo = 0;
  updateCombo(0);
  sfxMiss();

  recordTypingMiss(currentWord.id);
  recordKeyMiss(expectedChar, typedChar); // よく間違えるキー（学習データ）

  // 1回でもミスしたら不正解: スペルを表示して打ち直し。
  // 当てずっぽうでの正解到達は「思い出して打つ」の本質ではない（2026-08-15創業者決定）
  if (!isRevealed) {
    revealAnswer(true);
    return;
  }

  // 答え表示後の練習中のミスは表示のみ
  showMessage("違う。もう一度", "wrong");
}

function setNewWord() {
  wordSerial++;
  // Daily: 固定セットを順番に / Study: Recall Loopキュー / Challenge: 重み付き抽選
  if (dailyRun && mode === "challenge") {
    currentWord = dailyRun.words[dailyRun.index % dailyRun.words.length];
    dailyRun.index++;
  } else if (mode === "study") {
    let wordId = nextStudyWordId();
    // 漢字の書き分けのカード（kanjiOnly）は学習に出さない。前回の続き・もう一度の列に残っていても飛ばす
    while (wordId && findWordIn(activeCategory, wordId)?.kanjiOnly) wordId = nextStudyWordId();

    // 苦手のみモードで出題が尽きた = 全部クリア。達成感を演出して終了
    // （60 秒の回で 1 語以上答えていれば、時間切れと同じ終わりのパネル）
    if (!wordId && isWeakOnlyMode() && timedRun() && isPlaying && runRankBefore.size > 0) {
      endTimedRun();
      return;
    }
    if (!wordId && isWeakOnlyMode()) {
      stopGame();
      showMessage("苦手単語をすべてクリア。明日また確認", "finished");
      return;
    }

    currentWord = (wordId && findWordIn(activeCategory, wordId)) || chooseWord();
    renderStudyQueue(true);
  } else {
    currentWord = chooseWord();
  }

  // 計算カード: 出題のたびに数字を作り直し、この1問だけの答え・解説を持つ複製にする（記録は元のidに乗る）
  if (currentWord.calc) {
    const g = generateCalc(currentWord.calc);
    if (g) currentWord = { ...currentWord, en: g.answer, answer: g.answer, accept: g.accept, q: g.q, explain: g.explain, calcFormula: g.formula };
  }

  // 音で出題: Studyの英単語（概念カード以外）を設定の割合で「聞いて打つ」にする
  listenMode =
    mode === "study" &&
    !isConceptWord(currentWord) &&
    !!speechTextOf(currentWord) &&
    getListenRatio() > 0 &&
    Math.random() * 100 < getListenRatio();

  currentIndex = 0;
  typedSoFar = "";
  // 答えを見た後は出題語だけを練習させる（別解でごまかせないように）
  answerCandidates = answersFor(currentWord);
  hasMissedCurrentWord = false;
  isRevealed = false;
  hintUsed = false;
  hintChars = 0;
  awaitingNext = false;
  milestoneThisWord = false;
  tailUntil = -Infinity; // 1 打目の守りはこの語を出した advanceNow だけが置く（前の語の守りを持ち越さない）
  clearTimeout(advanceTimer);
  hideHint();
  renderWordNote(null);
  renderExplain(null);

  // ローマ字モード（日本語の答え）／全文入力モード（英語の用語・読みのない日本語の答え）の切替
  romajiEntries = romajiEntriesFor(currentWord);
  romajiMode = romajiEntries.length > 0;
  romaji = romajiMode ? createRomajiMatcher(romajiEntries) : null;
  freeMode = !romajiMode && isFreeAnswer(currentWord);
  // 全文入力の語は 1 打ずつ判定しない（入力欄の字はブラウザ・IME が入れる）。英単語の長い候補の続きは持ち越さない
  // （物理キーだけ飲んで Android の input 経路では飲まない、という食い違いを作らない。ローマ字の続きの扱いは以前のまま）
  if (freeMode && spill?.kind === "spelling") clearSpill();
  document.body.classList.toggle("romaji-answer", romajiMode);
  setInputRomaji(romajiMode);
  document.body.classList.toggle("free-answer", freeMode);
  document.body.classList.toggle("write-answer", !!currentWord.write); // 画面キーボード: 英文カードは A〜Z＋空白で打てる
  document.getElementById("gameCard")?.classList.toggle("game-card--concept", isConceptWord(currentWord));
  bankWords = currentWord.bank ? buildWordBank(currentWord) : [];
  elements.input.placeholder = currentWord.write
    ? "英文を入力してEnter"
    : currentWord.blank
      ? freeMode ? "空欄の英語を入力してEnter" : "空欄の英語を入力"
      : romajiMode ? "読みをローマ字で（変換しない）" : freeMode ? "答えを入力して Enter（日本語可）" : "英単語を入力";

  // 品詞（pos）があるレベル別パックの語は「日本語訳（動）」のように添える。訳の曖昧さを減らす
  setPromptLabel(
    currentWord.calc
      ? "計算（数字で答える）"
      : listenMode
        ? "音を聞いて打つ（発音 か Ctrl+. でもう一度）"
        : currentWord.write
          ? `${currentWord.bank ? "語を並べ替えて英文を打つ" : "日本語を英文にして打つ"}${currentWord.ja ? `（${currentWord.ja}）` : ""}`
        : currentWord.blank
          ? `空欄に入る英語を打つ${currentWord.ja ? `（${currentWord.ja}）` : ""}`
          : currentWord.school
            ? currentWord.kanjiOnly
              ? "説明に合う語を漢字で答える"
              : romajiMode
                ? "説明に合う語を答える（読みをローマ字で）"
                : "説明に合う語を答える（漢字でも、ひらがなでも可）"
            : isConceptWord(currentWord)
              ? "場面（これは何のこと？）"
            : currentWord.pos
              ? `日本語訳（${currentWord.pos}）`
              : "日本語訳"
  );
  elements.japanese.textContent = listenMode ? "聞いて打つ" : promptOf(currentWord);
  renderPromptContext(listenMode ? null : currentWord);
  if (currentWord.calc) elements.input.placeholder = "数字を入力してEnter（例: 8000 / 5%）";
  showHiddenWordText(
    currentWord.calc
      ? "式を思い出して計算。分からないときは Enter（ヒントで式）"
      : currentWord.bank
        ? `並べ替え: ${bankWords.join(" / ")}`
        : currentWord.write
          ? "英文を打つ（大文字・句読点は不問）。分からないときは Enter"
      : currentWord.blank
        ? "空欄に入る語を英語で。分からないときは Enter で答えを表示"
        : romajiMode
          ? "読みをローマ字で打つ。分からないときは Enter"
          : freeMode
            ? "用語や略語で答える。分からないときは Enter"
            : "分からないときは Enter で答えを表示",
    { hint: !!currentWord.bank }
  );
  if (elements.speakButton) {
    elements.speakButton.hidden = !listenMode;
  }
  if (listenMode) {
    // 150ms のうちに次の語へ進んだら読まない（前の語の発音で答えが漏れない）
    const serial = wordSerial;
    setTimeout(() => {
      if (serial === wordSerial && isPlaying && listenMode) speak(speechTextOf(currentWord));
    }, 150);
  }
  if (elements.wordFamily) {
    elements.wordFamily.textContent = "";
  }

  elements.input.value = "";
  waitInputBase = "";
  clearTypedPreview();

  renderWordMeta(); // recordPlayより前（未プレイ判定のため）
  const hist = document.getElementById("wordHistory");
  if (hist) hist.innerHTML = "";
  recordPlay(currentWord.id);
  startWordTiming();
  scheduleHint();
  window.dispatchEvent(new CustomEvent("spelldash:word", { detail: { id: currentWord.id } })); // 画面キーボード等が盤面を更新する
  saveResumePoint();
}

// 速さの計測を始める（docs/SPEC_MASTERY.md §3.4）。tShow は出題の文を書いた後の最初の rAF の中（recordPlay の同期の書き込みを数えない）。
// 測らない語: ページを開いて最初の語・音で出題・全文入力（概念カード・IME）・計算・英文を打つ・空欄・並べ替え・裏に回っている。
// ローマ字の答えは測る（ja の箱）。例文の訳を添える問い（同じ訳の語がある）は、測るときに見る（speedSample。カテゴリの全語を走査するため）
function startWordTiming() {
  pageWordsShown++;
  const w = currentWord;
  const timing = {
    serial: wordSerial,
    tShow: null,
    tFirst: null,
    input: null,
    spill: false,
    invalid:
      pageWordsShown === 1 ||
      listenMode ||
      (!romajiMode && (freeMode || isConceptWord(w))) ||
      !!(w.calc || w.write || w.blank || w.bank) ||
      isPageHidden()
  };
  wordTiming = timing;
  requestAnimationFrame(() => {
    if (wordTiming === timing && timing.tFirst === null) timing.tShow = performance.now();
  });
}

// 同じ訳の語が同じカテゴリに複数あるとき（見る: see／look／watch など）は、例文の訳を文脈として添える。
// 訳だけでは決まらない語を「当てずっぽう」にしない（英語の綴りは見せない）
function isAmbiguousPrompt(word) {
  if (!word || isConceptWord(word) || word.write || word.blank || word.calc || word.school) return false;
  if (!String(word.ja ?? "").trim()) return false;
  return getWordsByCategory(activeCategory).some((w) => w.id !== word.id && w.en !== word.en && jaLooksSame(word.ja, w.ja));
}

// カード上部のラベル（「日本語訳（動）」など）。完了・停止時は空にする
function setPromptLabel(text) {
  const promptLabel = document.querySelector("#gameCard .label");
  if (promptLabel) promptLabel.textContent = text;
}

function renderPromptContext(word) {
  const el = document.getElementById("promptContext");
  if (!el) return;
  el.textContent = word && word.exJa && isAmbiguousPrompt(word) ? `例文: ${word.exJa}` : "";
}

// 「前回の続きから」用に、いまの語と残りの語・セットの進みを保存（通常の Study セットだけ）
function saveResumePoint() {
  // 60 秒の回は続きからの地点を残さない（語数のセットの続きも消さない）
  if (mode !== "study" || !isPlaying || !currentWord || retryIds || isPlacementRun() || runKind === "timed") return;
  saveSession({
    category: activeCategory,
    focus: getFocusGenre(),
    queue: [currentWord.id, ...getUpcomingIds()],
    recalled: [...setRecalled],
    failed: [...setFailed],
    newCount: setNewCount,
    reviewCount: setReviewCount,
    setSize: currentSetSize()
  });
}

// 単語の状態ラベル（Studyのみ）: 「なぜ今この単語が出たか」を1行で見せる
function renderWordMeta() {
  const el = document.getElementById("wordMeta");
  if (!el) return;
  if (mode !== "study" || !currentWord) {
    el.textContent = "";
    return;
  }

  const stat = getWordStats()[currentWord.id];
  let label = "";
  currentWordKind = "";
  if (!stat || (stat.playCount ?? 0) === 0) {
    label = "新しい単語";
    currentWordKind = "new";
  } else if (isUnresolved(stat)) {
    const fails = stat.recallFail ?? 0;
    label = fails >= LEECH_FAILS ? `難敵（${fails}回思い出せていない）` : "もう一度（前回は思い出せなかった）";
    currentWordKind = "weak";
  } else if (isLearningToday(stat)) {
    label = `今日の反復 ${Math.min((stat.dailyLearningStage ?? 0) + 1, NEW_WORD_DAILY_SUCCESS_TARGET)}/${NEW_WORD_DAILY_SUCCESS_TARGET}`;
    currentWordKind = "repeat";
  } else if (isReviewDue(stat)) {
    currentWordKind = "review";
    const days = stat.lastRecallSuccessAt
      ? Math.floor((Date.now() - Date.parse(stat.lastRecallSuccessAt)) / 86400000)
      : 0;
    label = days >= 1 ? `${days}日ぶりの復習` : "復習";
  }
  el.textContent = label;
}

function chooseWord() {
  const stats = getWordStats();
  const allowed = allowedWordLevels();

  // 未プレイの単語はプレイヤーレベルで解放（既習語は常に出題対象）。
  // カテゴリ内に解放難易度が無い場合はfilterByAllowedLevelsが最易難易度で救済
  const pool = applyGenre(getWordsByCategory(activeCategory)); // ジャンル絞り込みはChallengeにも効く
  const played = pool.filter((word) => stats[word.id]);
  const unlocked = filterByAllowedLevels(
    pool.filter((word) => !stats[word.id]),
    allowed
  );
  const words = [...played, ...unlocked];

  const weightedWords = words.flatMap((word) => {
    const data = stats[word.id];
    let weight = 3;

    if (data) {
      // 古い word_stats には missCount 等が無いことがある。NaN にすると Array(NaN) で落ちるので安全に読む
      weight += (Number(data.missCount) || 0) * 3;

      const accuracy = (Number(data.correctCount) || 0) / Math.max(Number(data.playCount) || 0, 1);
      if (accuracy < 0.5) weight += 5;
      if (data.mastered) weight = 1;
      // 復習期日が来ている語はChallengeでも優先（Challengeが復習にもなる）
      if (isReviewDue(data)) weight += 6;
    }

    // 今日のミッション対象は優先的に出題（遊んでいるだけで達成できる）
    if (isMissionWordPending(word.id)) {
      weight += 8;
    }

    return Array(Math.max(1, Math.round(weight) || 1)).fill(word);
  });

  let selected = weightedWords[Math.floor(Math.random() * weightedWords.length)];

  if (currentWord && selected.id === currentWord.id && words.length > 1) {
    selected = words.find((word) => word.id !== currentWord.id);
  }

  return selected;
}

function endChallenge() {
  clearInterval(timer);
  isPlaying = false;
  wordTiming = null;
  flushMasteryMeta(); // 速さの基準・確かめの集計（変わっていれば 1 回だけ書く）
  notifyGameEnd();
  markActiveToday();
  snapshotGrowth();
  document.body.classList.remove("is-playing");
  document.body.classList.add("set-done"); // 出題 UI を畳んで結果パネルだけにする（css/card.css）
  stopBgm();
  elements.input.disabled = true;
  updateBigTimer();
  renderPlayScore();
  setPromptLabel("");
  elements.japanese.textContent = "";
  showHiddenWordText("");
  renderExplain(null);

  const isDaily = !!dailyRun;
  const previousBest = getBestScore();
  const previousRun = getSessionLog().filter((e) => e.mode === (isDaily ? "daily" : "challenge")).at(-1)?.score ?? null;
  const categoryBestBefore = isDaily ? 0 : getCategoryBest(activeCategory);
  const categoryBestUpdated = isDaily ? false : saveCategoryBest(activeCategory, score);

  const elapsedSeconds = startTime ? (Date.now() - startTime) / 1000 : 0;
  const speed = elapsedSeconds > 0 ? correctChars / elapsedSeconds : 0;

  recordTypingSession({
    correctChars,
    missChars: typingMissCount,
    seconds: elapsedSeconds,
    speed
  });

  // スコア推移グラフ用のローカル履歴
  appendSessionLog({
    at: new Date().toISOString(),
    mode: isDaily ? "daily" : "challenge",
    score,
    speed: Math.round(speed * 10) / 10,
    typingMiss: typingMissCount,
    recallFail: recallFailCount
  });

  // クラウド同期＋プレイ履歴（未ログインなら何もしない）
  recordPlaySession({
    mode: isDaily ? "daily" : "challenge",
    score,
    typingSpeed: Math.round(speed * 10) / 10,
    typingMiss: typingMissCount,
    recallFail: recallFailCount,
    durationSeconds: Math.round(elapsedSeconds)
  });
  pushSync();

  // KPI心拍: challenge/daily の完走を記録
  if (isDaily) {
    markDailyDone();
  } else {
    bumpActivity("challengeRuns");
  }

  // Daily完走: 結果を保存してその日はロック＋ボーナスXP
  if (isDaily) {
    gainedXp += DAILY_BONUS_XP;
    recordDailyResult({
      score,
      typingMiss: typingMissCount,
      recallFail: recallFailCount,
      speed: Math.round(speed * 10) / 10,
      emoji: dailyRun.emoji.join("")
    });
    dailyRun = null;
    renderDailyCard();
    const more = document.getElementById("homeMore");
    if (more) more.open = true; // 結果とランキングが見える位置に
    // ランキング送信 → 反映後にカードを再描画（未ログイン・テーブル未作成なら静かに無視）
    submitDailyScore({ score, speed: Math.round(speed * 10) / 10 }).finally(() => renderDailyCard());
  }

  saveBestScore(score);
  const isBest = score > 0 && score > previousBest;
  elements.bestScore.textContent = getBestScore();
  updateCombo(0);

  // 今日最初のプレイならストリークボーナス（XP の内訳は書かない。合計は結果パネルの 1 か所）
  const streak = updateStreak();
  if (streak.isFirstToday) {
    gainedXp += 50;
    renderHeaderStreak();
    renderHasumiHome();
  }

  const result = addXp(gainedXp);
  renderLevelBar();

  // シールド獲得（5 日ごとに 1 回きり）は、その日の最初のプレイが Challenge／Daily でも知らせる
  let shieldLine = "";
  if (streak.earnedShield) {
    sfxSparkle();
    shieldLine = `${streak.current}日連続 ・ シールド獲得（1日休んでも切れない）`;
  }

  // 結果の事実はパネルだけに書く（メッセージ行は空にして二重に言わない）
  showMessage("");
  let levelLine = "";
  if (result.leveledUp) {
    playLevelUpEffect();
    sfxLevelUp();
    // ランクが変わる節目はオーバーレイ 1 つ、それ以外はパネルに 1 行。両方は出さない
    if (!celebrateRankUp(result)) levelLine = `Lv.${result.after.level} に上がった${unlockNoteForLevel(result.after.level)}`;
  } else if (isDaily) {
    sfxComplete();
  }
  renderResultPanel({ isDaily, isBest, gainedXp, speed, previousBest, previousRun, categoryBestBefore, categoryBestUpdated, levelLine, shieldLine });
}

// ===== 終了リザルトパネル =====
// メッセージ1行では終了の満足感と次のアクションが弱いため、
// スコア・ベスト更新・次の一手（もう一回/シェア）をカード内に見せる
function renderResultPanel({ isDaily, isBest, gainedXp, speed, previousBest = 0, previousRun = null, categoryBestBefore = 0, categoryBestUpdated = false, levelLine = "", shieldLine = "" }) {
  const panel = document.getElementById("resultPanel");
  if (!panel) return;

  // 見出し 1 つ・数字 1 行。ベストの値は数字の行に入れるので、ここは「更新した」という事実と前回比だけ
  let bestBadge = "";
  if (isBest) {
    bestBadge = `<div class="result-panel__best">ベスト更新</div>`;
  }
  // 前回比（1回ごとの伸び）
  const diff = previousRun != null ? score - previousRun : null;
  if (diff != null) {
    bestBadge += `<div class="result-panel__diff${diff > 0 ? " result-panel__diff--up" : diff < 0 ? " result-panel__diff--down" : ""}">前回 ${previousRun} → ${score}（${diff > 0 ? `+${diff}` : diff === 0 ? "同じ" : diff}）</div>`;
  }
  // カテゴリ別ベスト: 全体ベストと同時には出さない。前の記録を更新したときだけ（初回は何も言わない。「初めての記録」は「ベスト N」と並ぶと矛盾して読める）
  if (!isDaily && !isBest && activeCategory !== "all" && categoryBestUpdated && categoryBestBefore > 0) {
    bestBadge += `<div class="result-panel__cat">このカテゴリのベスト更新</div>`;
  }
  if (levelLine) bestBadge += `<div class="result-panel__level">${levelLine}</div>`;
  if (shieldLine) bestBadge += `<div class="result-panel__level">${shieldLine}</div>`;
  const title = isDaily ? "Daily Dash 結果" : "Challenge 結果";

  const actions = isDaily
    ? `<button type="button" class="result-panel__action" id="resultStudy">苦手を復習</button>`
    : `<button type="button" class="result-panel__action" id="resultRetry">もう一回</button>
       <button type="button" class="result-panel__action result-panel__action--ghost" id="resultStudy">苦手を復習</button>`;

  panel.innerHTML = `
    <h2 class="result-panel__title" id="resultTitle" tabindex="-1">${title}</h2>
    ${bestBadge}
    ${hasumiBubbleHtml(hasumiResultLine({ isBest, isDaily, diff }), "hasumi--result")}
    <div class="result-panel__grid">
      <div><span>スコア</span><strong>${score}</strong></div>
      <div><span>ベスト</span><strong>${getBestScore()}</strong></div>
      <div><span>速度</span><strong>${(Math.round(speed * 10) / 10).toFixed(1)}打/秒</strong></div>
      <div><span>経験値</span><strong>+${gainedXp}</strong></div>
    </div>
    ${renderRankMoves()}
    <div class="result-panel__actions">${actions}</div>
  `;
  panel.hidden = false;
  // 結果は見出しから見せる（scroll-margin-top はヘッダー分。css/card.css）。焦点が盤面の外にあれば、焦点も位置も動かさない
  if (focusResultTitle(panel)) panel.scrollIntoView({ behavior: scrollBehavior(), block: "start" });

  document.getElementById("resultRetry")?.addEventListener("click", () => {
    restartGame();
    elements.input.focus();
  });

  document.getElementById("resultStudy")?.addEventListener("click", () => {
    setMode("study");
    startGame();
    elements.input.focus();
  });
}

function getCategoryLabel(id) {
  return getCategories().find((c) => c.id === id)?.label ?? (id === "my" ? "マイ単語帳" : id);
}

// 称号が変わるレベルアップ（F3→F2 等）は節目。大きめのオーバーレイで祝う（画面の語は「レベルアップ」。「ランク」は Battle の RP の制度に取っておく）
function celebrateRankUp(result) {
  if (!result?.leveledUp) return false;
  const beforeTitle = getTitle(result.before.level);
  const afterTitle = result.after.title;
  if (beforeTitle === afterTitle) return false;
  const overlay = document.createElement("div");
  overlay.className = "rank-up";
  overlay.setAttribute("aria-hidden", "true"); // 読み上げは静的な #srStatus（role=status）に流す。後から挿入した live 領域は読まれない
  announce(`レベルアップ: ${beforeTitle} から ${afterTitle}`);
  overlay.innerHTML = `
    <div class="rank-up__inner">
      <div class="rank-up__label">レベルアップ</div>
      <div class="rank-up__title"><span>${beforeTitle}</span><i>→</i><b>${afterTitle}</b></div>
      <div class="rank-up__sub">${unlockNoteForLevel(result.after.level).replace(/^。/, "")}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  milestoneThisWord = true; // 幕（1.2 秒＋消える 0.22 秒）が消えるまで次の語を出さない
  sfxSparkle();
  // 1.2 秒で静かに消える。タップでも閉じられる（次の一手を待たせない）
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.classList.add("rank-up--out");
    setTimeout(() => overlay.remove(), 220);
  };
  // キーボードでも閉じられる（Esc／Enter）。既定動作は妨げない。表示直後の Enter（答え表示→次への連打）では消さない
  const shownAt = performance.now();
  const onKey = (event) => {
    if (event.key === "Enter" && performance.now() - shownAt < 300) return;
    if (event.key === "Escape" || event.key === "Enter") close();
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("pointerdown", close);
  setTimeout(close, 1200);
  return true;
}

// 結果パネルが出たら見出しに焦点（SR に「今日のセット完了」等が伝わり、Tab で次の操作に届く）。
// ただし時間切れ（60 秒の回・Challenge）や正解のあとの待ちで終わった瞬間に、盤面の外で作業中（focusOnBoard の下の 3 つ:
// 盤面の外の書ける欄・開いている窓・メモ／覚え方の欄）なら動かさない（打っている文を奪わない。Batch 64 M3）。そのときは見出しの文を
// #srStatus で読み上げる（焦点を移したときと同じく、読み上げで終わりが分かる。直前のレベルアップの文とは 1 つの文につながる: js/ui.js announce。
// 背後を inert にする窓〔ご意見・語の詳細〕の間は、今も見出しへ焦点を移せず読まれない）。
// 焦点を移したら true（呼び手はそのときだけ見出しへ寄せる。寄せないので窓の背後も動かない）
function focusResultTitle(panel) {
  const title = panel.querySelector("#resultTitle");
  if (!title) return false;
  if (!focusOnBoard()) {
    announce(title.textContent.trim());
    return false;
  }
  try {
    title.focus({ preventScroll: true });
  } catch {
    // 無視
  }
  return true;
}

// 焦点が盤面にある（見出しへ移してよい）か。「盤面の外で作業中」（false）は次の 3 つのときだけ（PR #164 レビューの 1・2）:
//   (a) 盤面（#gameCard・#osk）の外の書ける欄（input・textarea・select・contenteditable。ヘッダーのログインの欄・出題設定の select など）
//   (b) 開いている窓（aria-modal・role=dialog。ご意見・語の詳細・コースを選ぶ）の中
//   (c) 盤面の中のメモ・覚え方の欄（#wordNote・#wordAi）
// ほかは「盤面にある」と同じ: どこにも無い（body）・盤面の祖先（盤面の空いた所をクリックすると Chromium は <main tabindex="-1"> に、
// 「本文へ」も #main に焦点を置く）・入力欄・画面キーボード・押したあとに焦点が残ったボタン／リンク／summary（「出題: … ・ 設定」など）、
// 隠れた要素に残った焦点（完了で畳んだ出題の UI）
function focusOnBoard() {
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return true;
  if (!active.getClientRects().length) return true;
  if (active.closest("#wordNote, #wordAi")) return false;
  if (active.closest('[aria-modal="true"], [role="dialog"]')) return false;
  return !!active.closest("#gameCard, #osk") || !isWritableField(active);
}

// 書ける欄（input の押すだけの種類〔button・submit・reset・image・checkbox・radio〕は除く。値を動かしている range〔出題設定の配分〕は欄と同じ）
const NON_WRITABLE_INPUT = new Set(["button", "submit", "reset", "image", "checkbox", "radio"]);
function isWritableField(el) {
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLInputElement && !NON_WRITABLE_INPUT.has(el.type);
}

function hideResultPanel() {
  const panel = document.getElementById("resultPanel");
  if (panel) panel.hidden = true;
}

function updateTypeSpeed() {
  if (!startTime) return;

  const elapsedSeconds = Math.max((Date.now() - startTime) / 1000, 1);
  const speed = correctChars / elapsedSeconds;

  elements.typeSpeed.textContent = speed.toFixed(1);
}
