import { supabase } from "./supabase.js";
import { addMyConcept, validateConcept, getMyWords } from "./myWords.js";

// ===== テキストから場面カードを作る（AI生成） =====
//
// マニュアル・研修資料・記事などを貼ると、/api/generate-cards（サーバー側でClaudeを呼ぶ）が
// 「場面 → 用語」のカード候補を返す。ユーザーは候補を確認して選び、マイ単語帳に追加する。
// 端末には何も送らずに保存はしない: 追加ボタンを押した分だけ spelldash_my_words に入る。

const MIN_CHARS = 20;
const MAX_CHARS = 4000;

export async function requestCards(text) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch("/api/generate-cards", { method: "POST", headers, body: JSON.stringify({ text }) });
  } catch {
    return { ok: false, error: "network", message: "通信できませんでした。接続を確認してください。" };
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    const fallback = response.status === 401 ? "ログインすると使えます（無料）。" : response.status === 404 ? "この機能は準備中です。" : "うまく作れませんでした。時間をおいてお試しください。";
    return { ok: false, status: response.status, error: body.error || "http", message: body.message || fallback };
  }
  return { ok: true, cards: Array.isArray(body.cards) ? body.cards : [] };
}

export function initializeCardGen(onChange = () => {}) {
  const textarea = document.getElementById("cardGenText");
  const run = document.getElementById("cardGenRun");
  const status = document.getElementById("cardGenStatus");
  const preview = document.getElementById("cardGenPreview");
  const counter = document.getElementById("cardGenCount");
  if (!textarea || !run || !status || !preview) return;

  let cards = [];

  const setStatus = (text, isError = false) => {
    status.textContent = text;
    status.className = `muted my-words__status${isError ? " my-words__status--error" : ""}`;
  };

  const updateCounter = () => {
    const n = textarea.value.trim().length;
    if (counter) counter.textContent = `${n} / ${MAX_CHARS}文字`;
    run.disabled = n < MIN_CHARS || n > MAX_CHARS;
  };
  textarea.addEventListener("input", updateCounter);
  updateCounter();

  run.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (text.length < MIN_CHARS) return setStatus(`テキストが短すぎます（${MIN_CHARS}文字以上）`, true);
    if (text.length > MAX_CHARS) return setStatus(`テキストが長すぎます（${MAX_CHARS}文字まで）`, true);
    run.disabled = true;
    run.textContent = "作成中…（10〜30秒）";
    preview.innerHTML = "";
    setStatus("はちゃんが読んでいます…");
    const result = await requestCards(text);
    run.disabled = false;
    run.textContent = "カードを作る";
    if (!result.ok) {
      cards = [];
      return setStatus(result.message, true);
    }
    cards = result.cards;
    if (cards.length === 0) return setStatus("カードにできる用語が見つかりませんでした。用語や説明が含まれるテキストを貼ってみてください。", true);
    setStatus(`${cards.length}枚の候補ができました。文面はそのまま直せます。いらないものはチェックを外してください。`);
    renderPreview();
  });

  preview.addEventListener("click", (event) => {
    const add = event.target.closest("[data-cardgen-add]");
    if (!add) return;
    // チェックされたカードを、編集後の値で読み取る
    const picked = [...preview.querySelectorAll("[data-cardgen-pick]:checked")]
      .map((box) => {
        const card = box.closest(".cardgen__card");
        if (!card) return null;
        const value = (name) => card.querySelector(`[data-field="${name}"]`)?.value ?? "";
        return { q: value("q"), answer: value("answer"), explain: value("explain"), accept: value("accept") };
      })
      .filter(Boolean);
    if (picked.length === 0) return setStatus("追加するカードを選んでください", true);
    const added = [];
    const skipped = [];
    for (const card of picked) {
      const result = addMyConcept(card);
      if (result.ok) added.push(result.en);
      else skipped.push(`${card.answer}: ${result.error}`);
    }
    const lines = [];
    if (added.length > 0) lines.push(`${added.length}枚をマイ単語帳に追加しました`);
    if (skipped.length > 0) lines.push(`スキップ ${skipped.length}件: ${skipped.slice(0, 2).join(" / ")}${skipped.length > 2 ? " …" : ""}`);
    setStatus(lines.join("　"), added.length === 0);
    if (added.length > 0) {
      cards = [];
      preview.innerHTML = `<p class="cardgen__done">追加しました。<a href="/" data-cardgen-practice>マイ単語帳で練習する ▶</a></p>`;
      textarea.value = "";
      updateCounter();
      onChange();
    }
  });

  // 「練習する」はホームのカテゴリをマイ単語帳にしてから移動
  preview.addEventListener("click", (event) => {
    if (event.target.closest("[data-cardgen-practice]")) localStorage.setItem("spelldash_category", "my");
  });

  function renderPreview() {
    const existing = getMyWords();
    preview.innerHTML = `
      <div class="cardgen__list">
        ${cards
          .map((card, index) => {
            const dup = !validateConcept(card, existing).ok;
            // 各欄はそのまま編集できる（追加時に編集後の値を読む）
            return `
              <div class="cardgen__card${dup ? " cardgen__card--dup" : ""}">
                <input type="checkbox" data-cardgen-pick="${index}"${dup ? "" : " checked"} aria-label="このカードを追加する" />
                <span class="cardgen__body">
                  <textarea class="cardgen__field" data-field="q" rows="2" aria-label="場面・意味">${escapeHtml(card.q)}</textarea>
                  <input class="cardgen__field cardgen__field--answer" data-field="answer" value="${escapeHtml(card.answer)}" aria-label="答え" />
                  <input class="cardgen__field cardgen__field--sub" data-field="explain" value="${escapeHtml(card.explain ?? "")}" placeholder="解説（任意）" aria-label="解説" />
                  <input class="cardgen__field cardgen__field--sub" data-field="accept" value="${escapeHtml((card.accept ?? []).join(" / "))}" placeholder="別解（任意。/ 区切り）" aria-label="別解" />
                  ${dup ? `<span class="cardgen__dup">すでにマイ単語帳にあります</span>` : ""}
                </span>
              </div>`;
          })
          .join("")}
      </div>
      <button type="button" class="btn btn--sm" data-cardgen-add>選んだカードをマイ単語帳に追加</button>`;
  }
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
