import { supabase, isSupabaseConfigured } from "./supabase.js";
import { initialSync } from "./sync.js";

const accountGuestElement = document.getElementById("accountGuest");
const accountUserElement = document.getElementById("accountUser");
const accountLoginElement = document.getElementById("accountLogin");
const loginToggleElement = document.getElementById("loginToggle");
const emailInputElement = document.getElementById("emailInput");
const loginButtonElement = document.getElementById("loginButton");
const logoutButtonElement = document.getElementById("logoutButton");
const userStatusElement = document.getElementById("userStatus");
const authMessageElement = document.getElementById("authMessage");
const avatarButtonElement = document.getElementById("avatarButton");
const headerAvatarElement = document.getElementById("headerAvatar");
const googleLoginButtonElement = document.getElementById("googleLoginButton");

export async function initializeAuth() {
  const { data } = await supabase.auth.getSession();
  updateAuthDisplay(data.session);

  // ログイン済みならクラウドと初回同期（マージ）
  if (data.session) {
    runInitialSync();
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    updateAuthDisplay(session);

    if (_event === "SIGNED_IN") {
      runInitialSync();
    }
  });

  accountLoginElement.addEventListener("submit", (event) => {
    event.preventDefault();
    sendLoginLink();
  });

  googleLoginButtonElement.addEventListener("click", signInWithGoogle);
  logoutButtonElement.addEventListener("click", logout);

  // ホバーはCSS（.dropdown:hover）が担当。クリックはタッチ端末用の開閉。
  setupDropdownToggle(loginToggleElement, accountGuestElement, () => {
    emailInputElement.focus();
  });
  setupDropdownToggle(avatarButtonElement, accountUserElement);

  document.addEventListener("click", (event) => {
    if (!accountGuestElement.contains(event.target)) {
      closeDropdown(accountGuestElement, loginToggleElement);
    }
    if (!accountUserElement.contains(event.target)) {
      closeDropdown(accountUserElement, avatarButtonElement);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDropdown(accountGuestElement, loginToggleElement);
      closeDropdown(accountUserElement, avatarButtonElement);
    }
  });
}

function setupDropdownToggle(trigger, dropdown, onOpen) {
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = dropdown.classList.toggle("is-open");
    trigger.setAttribute("aria-expanded", String(isOpen));

    if (isOpen && onOpen) {
      onOpen();
    }
  });
}

function closeDropdown(dropdown, trigger) {
  dropdown.classList.remove("is-open");
  trigger.setAttribute("aria-expanded", "false");
}

async function signInWithGoogle() {
  googleLoginButtonElement.disabled = true;
  showAuthMessage("Googleに移動します…");

  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin
    }
  });

  // 成功時はGoogleへページ遷移するため、ここに戻るのはエラー時のみ
  if (error) {
    googleLoginButtonElement.disabled = false;
    showAuthMessage(`Googleログインに失敗しました：${error.message}`, "error");
  }
}

async function sendLoginLink() {
  if (!isSupabaseConfigured) {
    showAuthMessage(
      "ログイン設定が未完了です（Supabaseキー未設定）。管理者にお問い合わせください。",
      "error"
    );
    return;
  }

  const email = emailInputElement.value.trim();

  if (!email) {
    showAuthMessage("メールアドレスを入力してください。", "error");
    return;
  }

  loginButtonElement.disabled = true;
  showAuthMessage("ログインリンクを送信中…");

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin
    }
  });

  if (error) {
    loginButtonElement.disabled = false;
    showAuthMessage(formatAuthError(error), "error");
    return;
  }

  closeDropdown(accountGuestElement, loginToggleElement);
  showAuthMessage("ログインリンクをメールに送りました。メールをご確認ください。", "success");
  startSendCooldown();
}

// 送信直後の連打でメール送信枠（レートリミット）を消費しないための待機
function startSendCooldown() {
  let remaining = 60;
  loginButtonElement.disabled = true;
  loginButtonElement.textContent = `再送信まで ${remaining}秒`;

  const cooldownTimer = setInterval(() => {
    remaining--;

    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      loginButtonElement.disabled = false;
      loginButtonElement.textContent = "リンクを送信";
      return;
    }

    loginButtonElement.textContent = `再送信まで ${remaining}秒`;
  }, 1000);
}

function formatAuthError(error) {
  const message = error.message ?? "";

  if (message.includes("rate limit")) {
    return "メール送信の上限に達しました。約1時間おいてから再度お試しください。";
  }

  if (message.includes("Invalid API key")) {
    return "ログイン設定に問題があります（APIキーが無効）。管理者にお問い合わせください。";
  }

  return `ログインリンク送信に失敗しました：${message}`;
}

async function logout() {
  await supabase.auth.signOut();
  showAuthMessage("ログアウトしました。");
}

function updateAuthDisplay(session) {
  if (!session) {
    accountGuestElement.hidden = false;
    accountUserElement.hidden = true;
    userStatusElement.textContent = "";
    closeDropdown(accountUserElement, avatarButtonElement);
    return;
  }

  const email = session.user.email ?? "";
  accountGuestElement.hidden = true;
  accountUserElement.hidden = false;
  userStatusElement.textContent = email;
  headerAvatarElement.textContent = email.charAt(0).toUpperCase() || "?";
  closeDropdown(accountGuestElement, loginToggleElement);
}

async function runInitialSync() {
  try {
    const synced = await initialSync();
    if (synced) {
      showAuthMessage("学習データをクラウドと同期しました。", "success");
    }
  } catch {
    // 同期失敗してもローカルで動き続ける（Local First）
  }
}

function showAuthMessage(text, type = "") {
  authMessageElement.textContent = text;
  authMessageElement.className = `auth-message ${type}`.trim();
}
