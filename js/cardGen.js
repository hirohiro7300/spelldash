import { canOfferPro } from "./proFunnel.js";
import { apiUrl } from "./appEnv.js";
import { supabase } from "./supabase.js";
import { addMyConcept, validateConcept, getMyWords } from "./myWords.js";

// ===== テキストから場面カードを作る（AI生成） =====
//
// マニュアル・研修資料・記事などを貼ると、/api/generate-cards（サーバー側でClaudeを呼ぶ）が
// 「場面 → 用語」のカード候補を返す。ユーザーは候補を確認して選び、マイ単語帳に追加する。
// 端末には何も送らずに保存はしない: 追加ボタンを押した分だけ spelldash_my_words に入る。

const MIN_CHARS = 20;
const MAX_CHARS = 4000;
const LOGIN_HINT = "ログインすると使える（無料）";

export async function requestCards(text) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(apiUrl("/api/generate-cards"), { method: "POST", headers, body: JSON.stringify({ text }) });
  } catch {
    return { ok: false, error: "network", message: "通信できなかった。接続を確認" };
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    const fallback = response.status === 401 ? LOGIN_HINT : response.status === 404 ? "準備中" : "作れなかった。時間をおいてもう一度";
    // 429 で upgrade:true は「無料ぶんを使い切った」: Pro の案内を添える
    return { ok: false, status: response.status, error: body.error || "http", message: body.message || fallback, upgrade: response.status === 429 && body.upgrade === true };
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

  const setStatus = (text, isError = false, { upgrade = false } = {}) => {
    status.textContent = text;
    if (upgrade) {
      const link = document.createElement("a");
      link.href = "./pro.html";
      link.dataset.funnel = "cards";
      link.className = "pro-link";
      link.textContent = "Pro について";
      status.append(" ", link);
    }
    status.className = `muted my-words__status${isError ? " my-words__status--error" : ""}`;
  };

  const updateCounter = () => {
    const n = textarea.value.trim().length;
    if (counter) counter.textContent = `${n} / ${MAX_CHARS}文字`;
    run.disabled = n < MIN_CHARS || n > MAX_CHARS;
  };
  textarea.addEventListener("input", updateCounter);
  updateCounter();

  // 未ログインの人には、押す前から理由を出しておく（ボタンは生かしたまま。押せば同じ案内）
  const showLoginHint = (hasSession) => {
    if (hasSession) {
      if (status.textContent === LOGIN_HINT) setStatus("");
    } else if (!status.textContent) {
      setStatus(LOGIN_HINT);
    }
  };
  supabase.auth.getSession().then(({ data }) => showLoginHint(Boolean(data?.session)));
  supabase.auth.onAuthStateChange((_event, nextSession) => showLoginHint(Boolean(nextSession)));

  run.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (text.length < MIN_CHARS) return setStatus(`${MIN_CHARS}文字以上で`, true);
    if (text.length > MAX_CHARS) return setStatus(`${MAX_CHARS}文字まで`, true);
    run.disabled = true;
    run.textContent = "作成中（10〜30秒）";
    preview.innerHTML = "";
    setStatus("読んでいる…");
    const result = await requestCards(text);
    run.disabled = false;
    run.textContent = "カードを作る";
    if (!result.ok) {
      cards = [];
      const offer = result.upgrade === true && canOfferPro(); // 受付前・アプリでは Pro の話をしない
      return setStatus(offer ? result.message : String(result.message).replace(/Pro なら[^。]*。?$/, ""), true, { upgrade: offer });
    }
    cards = result.cards;
    if (cards.length === 0) return setStatus("用語が見つからなかった。説明文や会話文を貼る", true);
    setStatus(`候補 ${cards.length}枚。文面はそのまま直せる。いらないものはチェックを外す`);
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
    if (picked.length === 0) return setStatus("追加するカードを選ぶ", true);
    const added = [];
    const skipped = [];
    for (const card of picked) {
      const result = addMyConcept(card);
      if (result.ok) added.push(result.en);
      else skipped.push(`${card.answer}: ${result.error}`);
    }
    const lines = [];
    if (added.length > 0) lines.push(`${added.length}枚をマイ単語帳に追加した`);
    if (skipped.length > 0) lines.push(`スキップ ${skipped.length}件: ${skipped.slice(0, 2).join(" / ")}${skipped.length > 2 ? " …" : ""}`);
    setStatus(lines.join("　"), added.length === 0);
    if (added.length > 0) {
      cards = [];
      preview.innerHTML = `<p class="cardgen__done">追加した。<a href="/" data-cardgen-practice>マイ単語帳で練習する</a></p>`;
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
                  ${dup ? `<span class="cardgen__dup">すでにマイ単語帳にある</span>` : ""}
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
