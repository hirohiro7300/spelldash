import { supabase, isSupabaseConfigured } from "./supabase.js";

const accountLoginElement = document.getElementById("accountLogin");
const accountUserElement = document.getElementById("accountUser");
const emailInputElement = document.getElementById("emailInput");
const loginButtonElement = document.getElementById("loginButton");
const logoutButtonElement = document.getElementById("logoutButton");
const userStatusElement = document.getElementById("userStatus");
const authMessageElement = document.getElementById("authMessage");
const avatarButtonElement = document.getElementById("avatarButton");
const accountMenuElement = document.getElementById("accountMenu");
const headerAvatarElement = document.getElementById("headerAvatar");

export async function initializeAuth() {
  const { data } = await supabase.auth.getSession();
  updateAuthDisplay(data.session);

  supabase.auth.onAuthStateChange((_event, session) => {
    updateAuthDisplay(session);
  });

  accountLoginElement.addEventListener("submit", (event) => {
    event.preventDefault();
    sendLoginLink();
  });

  logoutButtonElement.addEventListener("click", logout);

  avatarButtonElement.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
  });

  document.addEventListener("click", (event) => {
    if (!accountUserElement.contains(event.target)) {
      closeMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
    }
  });
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

  loginButtonElement.disabled = false;

  if (error) {
    showAuthMessage(`ログインリンク送信に失敗しました：${error.message}`, "error");
    return;
  }

  showAuthMessage("ログインリンクをメールに送りました。メールをご確認ください。", "success");
}

async function logout() {
  await supabase.auth.signOut();
  showAuthMessage("ログアウトしました。");
}

function updateAuthDisplay(session) {
  if (!session) {
    accountLoginElement.hidden = false;
    accountUserElement.hidden = true;
    userStatusElement.textContent = "";
    closeMenu();
    return;
  }

  const email = session.user.email ?? "";
  accountLoginElement.hidden = true;
  accountUserElement.hidden = false;
  userStatusElement.textContent = email;
  headerAvatarElement.textContent = email.charAt(0).toUpperCase() || "?";
}

function toggleMenu() {
  if (accountMenuElement.hidden) {
    openMenu();
  } else {
    closeMenu();
  }
}

function openMenu() {
  accountMenuElement.hidden = false;
  avatarButtonElement.setAttribute("aria-expanded", "true");
}

function closeMenu() {
  accountMenuElement.hidden = true;
  avatarButtonElement.setAttribute("aria-expanded", "false");
}

function showAuthMessage(text, type = "") {
  authMessageElement.textContent = text;
  authMessageElement.className = `auth-message ${type}`.trim();
}
