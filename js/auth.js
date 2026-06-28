import { supabase } from "./supabase.js";

const userStatusElement = document.getElementById("userStatus");
const emailInputElement = document.getElementById("emailInput");
const loginButtonElement = document.getElementById("loginButton");
const logoutButtonElement = document.getElementById("logoutButton");

export async function initializeAuth() {
  const { data } = await supabase.auth.getSession();
  updateAuthDisplay(data.session);

  supabase.auth.onAuthStateChange((_event, session) => {
    updateAuthDisplay(session);
  });

  loginButtonElement.addEventListener("click", sendLoginLink);
  logoutButtonElement.addEventListener("click", logout);
}

async function sendLoginLink() {
  const email = emailInputElement.value.trim();

  if (!email) {
    userStatusElement.textContent = "メールアドレスを入力してください。";
    return;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin
    }
  });

  if (error) {
    userStatusElement.textContent = `ログインリンク送信失敗：${error.message}`;
    return;
  }

  userStatusElement.textContent = "ログインリンクをメールに送りました。";
}

async function logout() {
  await supabase.auth.signOut();
}

function updateAuthDisplay(session) {
  if (!session) {
    userStatusElement.textContent = "未ログイン";
    emailInputElement.style.display = "block";
    loginButtonElement.style.display = "inline-block";
    logoutButtonElement.style.display = "none";
    return;
  }

  userStatusElement.textContent = `ログイン中：${session.user.email}`;
  emailInputElement.style.display = "none";
  loginButtonElement.style.display = "none";
  logoutButtonElement.style.display = "inline-block";
}