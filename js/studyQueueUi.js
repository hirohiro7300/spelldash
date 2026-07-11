import { getQueueSnapshot, getRecalledTodayCount, getSecuredTodayCount } from "./studyQueue.js";
import { findWord } from "./wordStore.js";

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

  // Unresolved（赤）だけ日本語の問題文を見せる。
  // 「投資」がまだ赤い、と具体的に見えることで消したくなる。
  // 英単語の答えは絶対に出さない。Pendingは内容を見せない（次問題の先読み防止）
  const chips = items
    .map((item) => {
      if (item.unresolved) {
        const word = findWord(item.id);
        const ja = word ? word.ja : "";
        const label = `未解決: ${ja}（もう一度出題されます）`;
        return `
          <div
            class="queue-chip queue-chip--unresolved"
            role="img"
            aria-label="${label}"
            title="${label}"
          ><span class="queue-chip__icon" aria-hidden="true">↻</span><span class="queue-chip__ja">${ja}</span></div>
        `;
      }

      return `
        <div class="queue-chip" role="img" aria-label="未回答" title="未回答"></div>
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

  const secured = document.getElementById("securedToday");
  if (secured) {
    const count = getSecuredTodayCount();
    secured.textContent = count > 0 ? `今日定着 ${count}` : "";
  }
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
