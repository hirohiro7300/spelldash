import { canOfferPro } from "./proFunnel.js";
import { apiUrl } from "./appEnv.js";
import { supabase } from "./supabase.js";
import { icon } from "./icons.js";

// ===== 覚え方を作る（AI） =====
//
// 思い出せなかった語について、覚え方・例文・注意点を /api/explain-word（サーバー側でClaude）に
// 1回だけ作ってもらい、端末に保存する（spelldash_word_ai）。答え表示時と単語詳細に出る。
// 自分のメモとは別物: メモは自分の言葉、こちらは助け舟。
// 生成はログイン中だけ（未ログインではボタンを出さない。保存済みの本文は誰でも見える）。

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
    response = await fetch(apiUrl("/api/explain-word"), { method: "POST", headers, body: JSON.stringify({ word: payload }) });
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
    const fallback = response.status === 401 ? "ログインすると使える（無料）" : response.status === 404 ? "この機能は準備中" : "作れなかった。";
    // 429 で upgrade:true は「無料ぶんを使い切った」: 表示側が Pro の案内を添える
    return { ok: false, status: response.status, message: body.message || fallback, upgrade: response.status === 429 && body.upgrade === true, offer: typeof body.offer === "string" ? body.offer : "" };
  }
  if (!body.mnemonic) return { ok: false, message: "作れなかった。" };
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
      <div class="word-ai__line word-ai__mnemonic">${escapeHtml(entry.mnemonic)}</div>
      ${entry.example ? `<div class="word-ai__line word-ai__example">${escapeHtml(entry.example)}${entry.exampleJa ? `<span class="word-ai__ja">${escapeHtml(entry.exampleJa)}</span>` : ""}</div>` : ""}
      ${entry.pitfall ? `<div class="word-ai__line word-ai__pitfall">注意: ${escapeHtml(entry.pitfall)}</div>` : ""}
    </div>`;
}

// ログイン状態（初回だけ問い合わせ、以後は変更イベントで追う）
let loggedIn = null;
async function isLoggedIn() {
  if (loggedIn !== null) return loggedIn;
  try {
    const { data } = await supabase.auth.getSession();
    loggedIn = !!data?.session;
    supabase.auth.onAuthStateChange((_event, session) => {
      loggedIn = !!session;
    });
  } catch {
    loggedIn = false;
  }
  return loggedIn;
}

// 「覚え方を作る」ボタン＋結果。container 内に描画し、生成後は onDone を呼ぶ。
// 未ログインではボタンを出さない（生成 API がログイン必須のため）
export function renderWordAi(container, word, { onDone } = {}) {
  if (!container || !word) return;
  container.dataset.wordAiFor = word.id;
  const cached = getWordAi(word.id);
  if (cached) {
    container.innerHTML = wordAiHtml(word.id);
    return;
  }
  container.innerHTML = "";
  isLoggedIn().then((ok) => {
    if (!ok || container.dataset.wordAiFor !== word.id || container.innerHTML !== "") return;
    renderAiButton(container, word, onDone);
  });
}

function renderAiButton(container, word, onDone) {
  container.innerHTML = `<button type="button" class="word-ai__button" data-word-ai-run>${icon("spark")}覚え方を作る</button>`;
  container.querySelector("[data-word-ai-run]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "作っています…";
    const result = await requestWordAi(word);
    // 返事を待つ間に次の語へ進んだ（欄が空になった・別の語を描いた）: 前の語の覚え方を次の語の下に出さない（保存は済んでいる）
    if (!button.isConnected || container.dataset.wordAiFor !== word.id) return;
    if (!result.ok) {
      // Pro の案内は文の中に括弧で入れる（1 本の流し込み: 390 でリンクが語の途中で折れない）
      // 受付前・アプリでは Pro の話をしない（サーバーの別欄 offer「Pro なら…」を足すのは受付中だけ）
      const offer = result.upgrade && canOfferPro();
      const message = offer && result.offer ? `${result.message}${result.offer}` : result.message;
      container.innerHTML = `<span class="word-ai__error">${escapeHtml(message)}${offer ? '（<a class="ai-upgrade" href="./pro.html" data-funnel="ai">Pro について</a>）' : ""}</span>`;
      return;
    }
    container.innerHTML = wordAiHtml(word.id);
    if (onDone) onDone(result.entry);
  });
}
