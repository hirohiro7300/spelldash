import { supabase } from "./supabase.js";

const accountLoginElement = document.getElementById("accountLogin");
const accountUserElement = document.getElementById("accountUser");
const emailInputElement = document.getElementById("emailInput");
const loginButtonElement = document.getElementById("loginButton");
const logoutButtonElement = document.getElementById("logoutButton");
const userStatusElement = document.getElementById("userStatus");
const authMessageElement = document.getElementById("authMessage");

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
}

async function sendLoginLink() {
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
    return;
  }

  accountLoginElement.hidden = true;
  accountUserElement.hidden = false;
  userStatusElement.textContent = session.user.email;
}

function showAuthMessage(text, type = "") {
  authMessageElement.textContent = text;
  authMessageElement.className = `auth-message ${type}`.trim();
}
