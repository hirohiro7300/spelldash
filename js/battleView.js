import { initializeAuth } from "./auth.js";
import { setFooterYear } from "./footer.js";
import { initWordStore, getCategories } from "./wordStore.js";
import { setupUnloadSync, pushSync } from "./sync.js";
import { createBattleMatch } from "./battleEngine.js";
import { getBattleStore, getRankState, applyMatchResult, queueBattleSession } from "./battleRank.js";
import { BATTLE } from "./battleConfig.js";
import { renderColoredWord } from "./colors.js";

const $ = (id) => document.getElementById(id);

let match = null;
let currentCategory = localStorage.getItem("spelldash_category") || "all";

// デバッグ用: ?t=10 で試合時間を短縮できる（本番は60秒）
const durationOverride = Number(new URLSearchParams(location.search).get("t")) || null;

initializeAuth();
setFooterYear();
setupUnloadSync();

initWordStore().then(() => {
  renderCategorySelect();
  renderLobby();
});

$("startBattle").addEventListener("click", startMatch);
$("rematchButton").addEventListener("click", startMatch);
$("backToLobby").addEventListener("click", () => {
  showSection("battleLobby");
  renderLobby();
});

// エンジンが確定させた入力欄の値（onPlayerWord/onPlayerProgressで更新）。
// モバイルのinputイベント処理で「どこまで受理済みか」の基準になる
let engineValue = "";

$("battleInput").addEventListener("keydown", (event) => {
  if (!match) return;
  if (event.key === "Enter" || event.key.length === 1) {
    event.preventDefault();
    match.handleKey(event.key);
  }
});

// モバイル（ソフトキーボード）: keydownで文字が取れない環境はinputイベントで照合。
// デスクトップはkeydownでpreventDefault済みのため二重処理にならない
$("battleInput").addEventListener("beforeinput", (event) => {
  if (match && event.inputType === "insertLineBreak") {
    event.preventDefault();
    match.handleKey("Enter");
  }
});

$("battleInput").addEventListener("input", () => {
  const input = $("battleInput");
  if (!match) return;

  const raw = input.value.toLowerCase().replace(/\s/g, "");

  if (raw.startsWith(engineValue)) {
    for (const ch of raw.slice(engineValue.length)) {
      const before = engineValue;
      match.handleKey(ch);
      if (!match) break; // 最終文字で試合終了した場合
      if (engineValue === before) break; // ミス: 1イベントにつき1回まで
    }
  }

  // 受理済みの位置に巻き戻す（削除・予測変換の置き換えもここで吸収）
  if (input.value !== engineValue) {
    input.value = engineValue;
    $("battleTypedPreview").innerHTML = renderColoredWord(engineValue);
  }
});

function showSection(id) {
  for (const section of ["battleLobby", "battleArena", "battleResult"]) {
    $(section).hidden = section !== id;
  }
}

function renderCategorySelect() {
  const select = $("battleCategory");
  const categories = [{ id: "all", label: "すべて" }, ...getCategories()];
  select.innerHTML = categories
    .map((c) => `<option value="${c.id}"${c.id === currentCategory ? " selected" : ""}>${c.label}</option>`)
    .join("");

  select.addEventListener("change", () => {
    currentCategory = select.value;
  });
}

function renderLobby() {
  const store = getBattleStore();
  const rank = getRankState();

  $("lobbyRank").textContent = rank.label;
  $("lobbyRp").textContent = rank.next
    ? `${rank.intoRank} / ${rank.span} RP（${store.rp} RP）`
    : `${store.rp} RP`;
  $("lobbyRpFill").style.width = `${Math.round(rank.progress * 100)}%`;
  $("lobbyRecord").textContent = `${store.wins}勝 ${store.losses}敗 ${store.draws}分`;
  $("lobbyStreak").textContent =
    store.currentWinStreak >= 2 ? ` ${store.currentWinStreak}連勝中` : "";
}

// ===== 試合 =====

function startMatch() {
  showSection("battleArena");

  match = createBattleMatch({
    categoryId: currentCategory,
    durationSeconds: durationOverride ?? BATTLE.durationSeconds,
    callbacks: {
      onTick(seconds) {
        $("battleTimer").textContent = seconds;
      },
      onPlayerWord(word) {
        $("playerJa").textContent = word.ja;
        engineValue = "";
        $("battleInput").value = "";
        $("battleTypedPreview").innerHTML = "";
      },
      onPlayerProgress(player) {
        const typed = player.word.en.slice(0, player.charIndex);
        engineValue = typed;
        $("battleInput").value = typed;
        $("battleTypedPreview").innerHTML = renderColoredWord(typed);
      },
      onPlayerCorrect(player) {
        $("playerScore").textContent = player.score;
        $("playerCombo").textContent = player.combo >= 2 ? `${player.combo} combo` : "";
        flash($("playerScore"), "score-pulse");
        $("playerStatus").textContent = "";
      },
      onPlayerMiss() {
        $("playerStatus").textContent = "Miss!";
      },
      onPlayerPass(player) {
        $("playerCombo").textContent = "";
        $("playerStatus").textContent = "Pass（試合後にStudyで復習できます）";
      },
      onCpuUpdate(cpuState, event) {
        $("cpuJa").textContent = cpuState.ja;
        $("cpuScore").textContent = cpuState.score;
        $("cpuCombo").textContent = cpuState.combo >= 2 ? `${cpuState.combo} combo` : "";
        renderCpuProgress(cpuState.done, cpuState.total);

        if (event.type === "correct") {
          $("cpuStatus").textContent = "正解";
          flash($("cpuScore"), "score-pulse");
        } else if (event.type === "pass") {
          $("cpuStatus").textContent = "Pass";
        } else if (event.type === "word-start") {
          $("cpuStatus").textContent = "";
        }
      },
      onFinish(summary) {
        match = null;
        showResult(summary);
      }
    }
  });

  $("cpuName").textContent = `${match.cpuProfile.name}（${match.cpuProfile.typeLabel} / CPU）`;
  $("playerScore").textContent = "0";
  $("cpuScore").textContent = "0";
  $("playerCombo").textContent = "";
  $("cpuCombo").textContent = "";
  $("playerStatus").textContent = "分からなければ Enter でパス（答えは出ません）";
  $("cpuStatus").textContent = "";
  $("battleTimer").textContent = durationOverride ?? BATTLE.durationSeconds;

  match.start();
  $("battleInput").focus();
}

// CPUの入力進捗（文字数ドットのみ。実際の文字は見せない）
function renderCpuProgress(done, total) {
  const shown = Math.min(total, 12);
  const doneShown = Math.round((done / Math.max(total, 1)) * shown);
  $("cpuProgress").innerHTML = Array.from({ length: shown }, (_, i) =>
    `<span class="cpu-dot${i < doneShown ? " cpu-dot--done" : ""}"></span>`
  ).join("");
}

function flash(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

// ===== 結果 =====

function showResult(summary) {
  const outcome = applyMatchResult(summary.result);

  const verdict = summary.result === "win" ? "VICTORY" : summary.result === "loss" ? "DEFEAT" : "DRAW";
  $("resultVerdict").textContent = verdict;
  $("resultVerdict").className = `battle-verdict battle-verdict--${summary.result}`;

  $("resultPlayerScore").textContent = summary.player.score;
  $("resultCpuName").textContent = summary.cpu.profile.name;
  $("resultCpuScore").textContent = summary.cpu.score;

  $("resultDetail").innerHTML = `
    <div><span>Accuracy</span><strong>${summary.player.accuracy}%</strong></div>
    <div><span>Typing Miss</span><strong>${summary.player.typingMiss}</strong></div>
    <div><span>Passed</span><strong>${summary.player.passCount}</strong></div>
  `;

  const sign = outcome.rpChange >= 0 ? "+" : "";
  $("resultRpChange").textContent = `Rank Points ${sign}${outcome.rpChange}`;
  $("resultRankLine").textContent = `${outcome.rankAfter.label}  ${outcome.rpBefore} → ${outcome.rpAfter} RP`;
  $("resultRpFill").style.width = `${Math.round(outcome.rankAfter.progress * 100)}%`;

  const promotion = $("resultPromotion");
  promotion.hidden = !outcome.promoted;
  if (outcome.promoted) {
    promotion.textContent = `RANK UP — ${outcome.rankAfter.label}`;
  }

  // Recall Loopへの接続: Passした単語はlastRecallFailAtによりUnresolved化済み。
  // Studyを開けば最優先で出題され、右側に「↻ 日本語」の赤カードとして見える
  const unresolvedCount = summary.player.passes.length;
  $("resultReview").hidden = unresolvedCount === 0;
  if (unresolvedCount > 0) {
    $("resultUnresolvedText").textContent = `未解決 ${unresolvedCount}語`;
  }

  showSection("battleResult");

  // battle_sessionsへの保存（Local Firstで保留→同期時に送信）
  queueBattleSession({
    opponent_type: summary.cpu.profile.typeId,
    opponent_name: summary.cpu.profile.name,
    category: summary.categoryId,
    duration_seconds: summary.durationSeconds,
    result: summary.result,
    player_score: summary.player.score,
    opponent_score: summary.cpu.score,
    rp_before: outcome.rpBefore,
    rp_change: outcome.rpChange,
    rp_after: outcome.rpAfter,
    correct_count: summary.player.correct,
    typing_miss: summary.player.typingMiss,
    recall_fail: summary.player.passCount,
    accuracy: summary.player.accuracy,
    event_timeline: summary.timeline,
    difficulty_profile: summary.difficultyProfile,
    played_at: new Date().toISOString()
  });

  pushSync();
}
