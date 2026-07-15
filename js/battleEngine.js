import { BATTLE, calculateBattleScore , LEVEL_MIX_BY_RANK } from "./battleConfig.js";
import { createCpuOpponent } from "./cpuOpponent.js";
import { getWordsByCategory } from "./wordStore.js";
import { getRankState } from "./battleRank.js";
import {
  recordPlay,
  recordCorrect,
  recordTypingMiss,
  recordRecallFail,
  recordRecallSuccess
} from "./stats.js";

// ===== Battle試合エンジン（DOM非依存） =====
// プレイヤーとCPUは同じカテゴリ条件・同じ難易度構成比で「別々の」問題セットを解く。
// 1試合には多少の問題運が残り、長期的には実力がRankへ反映される設計。

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function dedupeById(words) {
  const seen = new Set();
  return words.filter((w) => {
    if (seen.has(w.id)) return false;
    seen.add(w.id);
    return true;
  });
}

// 難易度ミックスに沿って問題セットを抽選（excludeIdsは可能な範囲で避ける）
function buildWordSet(categoryId, count, excludeIds = new Set(), mix = BATTLE.levelMix) {
  const all = dedupeById(getWordsByCategory(categoryId));
  const byLevel = {
    easy: shuffle(all.filter((w) => w.level === "easy")),
    normal: shuffle(all.filter((w) => w.level === "normal")),
    hard: shuffle(all.filter((w) => w.level === "hard"))
  };

  const targets = {
    easy: Math.round(count * mix.easy),
    normal: Math.round(count * mix.normal),
    hard: Math.round(count * mix.hard)
  };

  const set = [];
  for (const level of ["easy", "normal", "hard"]) {
    const pool = byLevel[level];
    const preferred = pool.filter((w) => !excludeIds.has(w.id));
    const picked = preferred.slice(0, targets[level]);
    // 足りなければ除外指定を無視して補充（問題不足で停止しない）
    if (picked.length < targets[level]) {
      picked.push(...pool.filter((w) => !picked.includes(w)).slice(0, targets[level] - picked.length));
    }
    set.push(...picked);
  }

  // カテゴリの単語数が少なくても最低限のセットを保証
  if (set.length < 10) {
    set.push(...shuffle(all).filter((w) => !set.includes(w)).slice(0, 10 - set.length));
  }

  return shuffle(set);
}

function profileOfSet(set) {
  const counts = { easy: 0, normal: 0, hard: 0 };
  let totalLen = 0;
  for (const w of set) {
    counts[w.level] = (counts[w.level] ?? 0) + 1;
    totalLen += w.en.length;
  }
  return { ...counts, avgLength: Math.round((totalLen / set.length) * 10) / 10, size: set.length };
}

export function createBattleMatch({ categoryId, durationSeconds, callbacks }) {
  const duration = (durationSeconds ?? BATTLE.durationSeconds) * 1000;
  const rank = getRankState();

  // ランク別の難易度構成（Bronzeはhardなし）。両者同構成なので公平
  const levelMix = LEVEL_MIX_BY_RANK[rank.id] ?? BATTLE.levelMix;
  const playerSet = buildWordSet(categoryId, BATTLE.wordsPerSet, new Set(), levelMix);
  const cpuSet = buildWordSet(categoryId, BATTLE.wordsPerSet, new Set(playerSet.map((w) => w.id)), levelMix);

  const timeline = [];
  let startTime = null;
  let timerInterval = null;
  let finished = false;

  const player = {
    index: 0,
    word: null,
    charIndex: 0,
    wordStartTime: null,
    hadMissThisWord: false,
    score: 0,
    combo: 0,
    correct: 0,
    typingMiss: 0,
    passes: [] // Recall Failしたword id（Study接続用）
  };

  const cpuState = { ja: "", done: 0, total: 0, score: 0, combo: 0, lastEvent: "" };

  const cpu = createCpuOpponent({
    rankId: rank.id,
    words: cpuSet,
    onEvent: (event) => {
      if (finished) return;
      if (event.type === "word-start") {
        cpuState.ja = event.ja;
        cpuState.total = event.total;
        cpuState.done = 0;
      } else if (event.type === "progress") {
        cpuState.done = event.done;
      } else {
        cpuState.score = event.score;
        cpuState.combo = event.combo;
        cpuState.lastEvent = event.type;
        timeline.push({ timeMs: event.timeMs, side: "cpu", type: event.type, score: event.score, combo: event.combo });
      }
      callbacks.onCpuUpdate(cpuState, event);
    }
  });

  function nextPlayerWord() {
    player.word = playerSet[player.index % playerSet.length];
    player.index += 1;
    player.charIndex = 0;
    player.hadMissThisWord = false;
    player.wordStartTime = Date.now();
    recordPlay(player.word.id);
    callbacks.onPlayerWord(player.word);
  }

  function pushPlayerEvent(type) {
    timeline.push({
      timeMs: Date.now() - startTime,
      side: "player",
      type,
      score: player.score,
      combo: player.combo
    });
  }

  // プレイヤーのキー入力。answered=trueで処理済み
  function handleKey(key) {
    if (finished || !player.word) return;

    if (key === "Enter") {
      // Pass: 0点・答えは表示しない・Recall Failとして記録（StudyのUnresolvedへ）
      recordRecallFail(player.word.id);
      player.passes.push(player.word.id);
      player.combo = 0;
      pushPlayerEvent("pass");
      callbacks.onPlayerPass(player);
      nextPlayerWord();
      return;
    }

    if (key.length !== 1) return;

    const expected = player.word.en[player.charIndex];
    if (key.toLowerCase() === expected) {
      player.charIndex += 1;
      callbacks.onPlayerProgress(player);

      if (player.charIndex === player.word.en.length) {
        completePlayerWord();
      }
    } else {
      // typingMiss: 時間を失うこと自体がペナルティ。Unresolvedにはしない
      player.typingMiss += 1;
      player.hadMissThisWord = true;
      player.combo = 0;
      recordTypingMiss(player.word.id);
      callbacks.onPlayerMiss(player);
    }
  }

  function completePlayerWord() {
    const answerMs = Date.now() - player.wordStartTime;
    const clean = !player.hadMissThisWord;

    // 既存の単語統計を更新（自力正解＝Unresolvedも解決される）
    recordCorrect(player.word.id, clean);
    recordRecallSuccess(player.word.id);

    if (clean) player.combo += 1;
    player.correct += 1;
    player.score += calculateBattleScore({ answerMs, hadTypingMiss: player.hadMissThisWord });

    pushPlayerEvent("correct");
    callbacks.onPlayerCorrect(player);
    nextPlayerWord();
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(timerInterval);
    cpu.stop();
    // 時間切れ時に入力途中だった単語はRecall Failにしない（間に合わなかっただけ）

    const result =
      player.score > cpu.stats.score ? "win" : player.score < cpu.stats.score ? "loss" : "draw";

    const attempts = player.correct + player.passes.length;

    callbacks.onFinish({
      result,
      player: {
        score: player.score,
        correct: player.correct,
        typingMiss: player.typingMiss,
        passes: [...new Set(player.passes)],
        passCount: player.passes.length,
        accuracy: attempts > 0 ? Math.round((player.correct / attempts) * 100) : 0
      },
      cpu: { ...cpu.stats, profile: cpu.profile },
      timeline,
      difficultyProfile: {
        player: profileOfSet(playerSet),
        cpu: profileOfSet(cpuSet),
        rankId: rank.id,
        cpuType: cpu.profile.typeId
      },
      durationSeconds: Math.round(duration / 1000),
      categoryId
    });
  }

  return {
    cpuProfile: cpu.profile,
    handleKey,
    start() {
      startTime = Date.now();
      nextPlayerWord();
      cpu.start();

      timerInterval = setInterval(() => {
        const remaining = Math.max(0, duration - (Date.now() - startTime));
        callbacks.onTick(Math.ceil(remaining / 1000));
        if (remaining <= 0) finish();
      }, 200);
    },
    stop() {
      finished = true;
      clearInterval(timerInterval);
      cpu.stop();
    }
  };
}
