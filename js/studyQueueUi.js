import { getQueueSnapshot, getRecalledTodayCount } from "./studyQueue.js";

// Study Recall Loop の表示部分。
// 右側の小カード列は「次に何が来るか」ではなく「状態と残量」だけを伝える
// （内容を先に見せると現在の問題のRecall時間を汚染するため）

const VISIBLE_CHIPS = 5;

export function renderStudyQueue(visible) {
  const container = document.getElementById("studyQueue");
  if (!container) return;

  if (!visible) {
    container.innerHTML = "";
    return;
  }

  const { items, remaining } = getQueueSnapshot(VISIBLE_CHIPS);

  const chips = items
    .map((item) => {
      const label = item.unresolved ? "未解決（再挑戦待ち）" : "未回答";
      return `
        <div
          class="queue-chip${item.unresolved ? " queue-chip--unresolved" : ""}"
          role="img"
          aria-label="${label}"
          title="${label}"
        >${item.unresolved ? "↻" : ""}</div>
      `;
    })
    .join("");

  const more =
    remaining > VISIBLE_CHIPS
      ? `<div class="queue-chip queue-chip--more" aria-label="残り${remaining - VISIBLE_CHIPS}問">+${remaining - VISIBLE_CHIPS}</div>`
      : "";

  container.innerHTML = chips + more;
}

export function updateRecalledToday() {
  const element = document.getElementById("recalledToday");
  if (!element) return;
  element.textContent = getRecalledTodayCount();
}

// 自力正解: カードが緑になり右へ抜ける（reduced-motionでは色のみ）
export function playRecallSuccessEffect() {
  flashCard("game-card--recalled");

  const container = document.getElementById("studyQueue");
  if (!container) return;

  const chip = document.createElement("div");
  chip.className = "queue-chip queue-chip--recalled";
  chip.setAttribute("aria-hidden", "true");
  chip.textContent = "✓";
  container.prepend(chip);

  setTimeout(() => chip.remove(), 320);
}

// Recall Fail: カードが赤く点滅し、キューに赤カードが現れる
export function playRecallFailEffect() {
  flashCard("game-card--failed");
}

function flashCard(className) {
  const card = document.querySelector(".game-card");
  if (!card) return;

  card.classList.remove(className);
  void card.offsetWidth;
  card.classList.add(className);
  setTimeout(() => card.classList.remove(className), 400);
}
