import { supabase, isSupabaseConfigured } from "./supabase.js";

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

  closeDropdown(accountGuestElement, loginToggleElement);
  showAuthMessage("ログインリンクをメールに送りました。メールをご確認ください。", "success");
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

function showAuthMessage(text, type = "") {
  authMessageElement.textContent = text;
  authMessageElement.className = `auth-message ${type}`.trim();
}
