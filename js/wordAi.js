import { supabase } from "./supabase.js";

// ===== ✨ 覚え方を作る（AI） =====
//
// 思い出せなかった語について、覚え方・例文・注意点を /api/explain-word（サーバー側でClaude）に
// 1回だけ作ってもらい、端末に保存する（spelldash_word_ai）。答え表示時と単語詳細に出る。
// 自分のメモ（📝）とは別物: メモは自分の言葉、こちらは助け舟。

const KEY = "spelldash_word_ai";

export function getAllWordAi() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function getWordAi(wordId) {
  const entry = getAllWordAi()[wordId];
  return entry && typeof entry === "object" && entry.mnemonic ? entry : null;
}

export function setWordAi(wordId, entry) {
  const all = getAllWordAi();
  all[wordId] = { mnemonic: entry.mnemonic, example: entry.example || "", exampleJa: entry.exampleJa || "", pitfall: entry.pitfall || "", at: new Date().toISOString() };
  localStorage.setItem(KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("spelldash:wordai"));
}

export function clearWordAi(wordId) {
  const all = getAllWordAi();
  delete all[wordId];
  localStorage.setItem(KEY, JSON.stringify(all));
}

export async function requestWordAi(word) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = { en: word.answer ?? word.en, ja: word.ja, q: word.q || "", explain: word.explain || "" };
  let response;
  try {
    response = await fetch("/api/explain-word", { method: "POST", headers, body: JSON.stringify({ word: payload }) });
  } catch {
    return { ok: false, message: "通信できませんでした。" };
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    const fallback = response.status === 401 ? "ログインすると使えます（無料）。" : response.status === 404 ? "この機能は準備中です。" : "うまく作れませんでした。";
    return { ok: false, status: response.status, message: body.message || fallback };
  }
  if (!body.mnemonic) return { ok: false, message: "うまく作れませんでした。" };
  setWordAi(word.id, body);
  return { ok: true, entry: getWordAi(word.id) };
}

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 保存済みの覚え方をHTMLにする（無ければ空）
export function wordAiHtml(wordId) {
  const entry = getWordAi(wordId);
  if (!entry) return "";
  return `
    <div class="word-ai">
      <div class="word-ai__line word-ai__mnemonic">✨ ${escapeHtml(entry.mnemonic)}</div>
      ${entry.example ? `<div class="word-ai__line word-ai__example">${escapeHtml(entry.example)}${entry.exampleJa ? `<span class="word-ai__ja">${escapeHtml(entry.exampleJa)}</span>` : ""}</div>` : ""}
      ${entry.pitfall ? `<div class="word-ai__line word-ai__pitfall">⚠ ${escapeHtml(entry.pitfall)}</div>` : ""}
    </div>`;
}

// 「✨ 覚え方を作る」ボタン＋結果。container 内に描画し、生成後は onDone を呼ぶ
export function renderWordAi(container, word, { onDone } = {}) {
  if (!container || !word) return;
  const cached = getWordAi(word.id);
  if (cached) {
    container.innerHTML = wordAiHtml(word.id);
    return;
  }
  container.innerHTML = `<button type="button" class="word-ai__button" data-word-ai-run>✨ 覚え方を作る</button>`;
  container.querySelector("[data-word-ai-run]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "作っています…";
    const result = await requestWordAi(word);
    if (!result.ok) {
      container.innerHTML = `<span class="word-ai__error">${escapeHtml(result.message)}</span>`;
      return;
    }
    container.innerHTML = wordAiHtml(word.id);
    if (onDone) onDone(result.entry);
  });
}
