import { supabase } from "./supabase.js";

// ===== ご意見・不具合フォーム =====
//
// 10人ローンチの定性フィードバックを、その場で・短く・匿名でも送れるようにする。
// 送信先は Supabase の feedback テーブル（作成SQLは docs/SQL_FEEDBACK.md、実行は創業者側）。
// テーブル未作成・オフライン時は端末に保持し、次回ページ表示時に再送する（取りこぼさない）。

const QUEUE_KEY = "spelldash_feedback_queue";
const MAX_LENGTH = 1000;

function loadQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-20)));
}

async function currentUserId() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// 1件送る。成功したら true
async function sendRow(row) {
  try {
    const result = await supabase.from("feedback").insert(row);
    return !!result && typeof result === "object" && result.error == null && "data" in result;
  } catch {
    return false;
  }
}

export async function flushFeedbackQueue() {
  const queue = loadQueue();
  if (queue.length === 0) return 0;
  const remaining = [];
  let sent = 0;
  for (const row of queue) {
    if (await sendRow(row)) sent++;
    else remaining.push(row);
  }
  saveQueue(remaining);
  return sent;
}

export async function submitFeedback({ message, contact = "" }) {
  const text = String(message ?? "").trim().slice(0, MAX_LENGTH);
  if (!text) throw new Error("内容を入力してください。");

  const row = {
    user_id: await currentUserId(),
    message: text,
    contact: String(contact ?? "").trim().slice(0, 120) || null,
    page: location.pathname + location.search,
    user_agent: navigator.userAgent.slice(0, 200),
    created_at: new Date().toISOString()
  };

  if (await sendRow(row)) return { status: "sent" };
  const queue = loadQueue();
  queue.push(row);
  saveQueue(queue);
  return { status: "queued" };
}

// ---- UI ----

function ensureModal() {
  let modal = document.getElementById("feedbackModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "feedbackModal";
  modal.className = "feedback-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="feedback-modal__backdrop" data-feedback-close></div>
    <form class="feedback-modal__panel" id="feedbackForm" role="dialog" aria-modal="true" aria-labelledby="feedbackTitle">
      <div class="feedback-modal__head">
        <h3 id="feedbackTitle">ご意見・不具合</h3>
        <button type="button" class="feedback-modal__close" data-feedback-close aria-label="閉じる">✕</button>
      </div>
      <p class="feedback-modal__lead">「訳が分かりにくい」「ここで詰まった」など、一言で大丈夫です。全部読みます。</p>
      <textarea id="feedbackMessage" rows="4" maxlength="${MAX_LENGTH}" placeholder="例: 復習の単語が多すぎて新しい語が出てこない" required></textarea>
      <input id="feedbackContact" type="text" maxlength="120" placeholder="返信先（任意: メール / X など）" autocomplete="off" />
      <div class="feedback-modal__actions">
        <span class="feedback-modal__status" id="feedbackStatus" role="status"></span>
        <button type="submit" class="btn btn--sm" id="feedbackSubmit">送信</button>
      </div>
      <p class="feedback-modal__note">送られるのは本文・返信先・ページ名・ブラウザ情報だけです。</p>
    </form>
  `;
  document.body.appendChild(modal);

  modal.querySelectorAll("[data-feedback-close]").forEach((el) => el.addEventListener("click", closeFeedback));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeFeedback();
  });

  modal.querySelector("#feedbackForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = modal.querySelector("#feedbackStatus");
    const button = modal.querySelector("#feedbackSubmit");
    const message = modal.querySelector("#feedbackMessage");
    const contact = modal.querySelector("#feedbackContact");
    button.disabled = true;
    status.textContent = "送信中…";
    try {
      const result = await submitFeedback({ message: message.value, contact: contact.value });
      status.textContent =
        result.status === "sent" ? "ありがとうございます。届きました！" : "ありがとうございます。保存しました（次回接続時に送ります）";
      message.value = "";
      setTimeout(closeFeedback, 1600);
    } catch (error) {
      status.textContent = error.message || "送信できませんでした。";
    } finally {
      button.disabled = false;
    }
  });

  return modal;
}

export function openFeedback() {
  const modal = ensureModal();
  modal.hidden = false;
  modal.querySelector("#feedbackStatus").textContent = "";
  modal.querySelector("#feedbackMessage").focus();
}

export function closeFeedback() {
  const modal = document.getElementById("feedbackModal");
  if (modal) modal.hidden = true;
}

// フッターの「ご意見・不具合」リンクを配線し、送信待ちがあれば再送を試みる
export function initFeedback() {
  document.querySelectorAll("[data-feedback-open]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openFeedback();
    });
  });
  setTimeout(() => {
    flushFeedbackQueue().catch(() => {});
  }, 3000);
}
