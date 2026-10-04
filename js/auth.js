import { authRedirectOrigin } from "./appEnv.js";
import { supabase, isSupabaseConfigured, checkAuthReachable } from "./supabase.js";
import { initialSync } from "./sync.js";
import { refreshPlan, clearPlan } from "./plan.js";
import { trapFocus } from "./focusTrap.js";

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
  refreshPlan(); // Pro の状態（spelldash_plan）を更新

  // ログイン済みならクラウドと初回同期（マージ）
  if (data.session) {
    runInitialSync();
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    updateAuthDisplay(session);
    if (_event === "SIGNED_OUT") clearPlan(); else if (_event === "SIGNED_IN") refreshPlan();

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

// 開いているドロップダウンのフォーカストラップ解除関数（dropdown 要素 → release）
const dropdownTraps = new Map();

function setupDropdownToggle(trigger, dropdown, onOpen) {
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = dropdown.classList.toggle("is-open");
    trigger.setAttribute("aria-expanded", String(isOpen));

    if (isOpen) {
      // Esc で閉じて焦点をトリガーへ。パネルの端を Tab で越えたら閉じる（ループしない）
      dropdownTraps.get(dropdown)?.({ restore: false });
      const release = trapFocus(dropdown.querySelector(".dropdown__panel"), {
        loop: false,
        restoreFocus: false,
        initialFocus: () => dropdown.querySelector(".dropdown__panel").querySelector("input, button, a"),
        onEscape: (e, info) => {
          const leaving = info?.leaving;
          if (leaving === "pointer" && trigger.contains(e.target)) return; // トリガー自身のクリック（閉じる）は click 側で畳む
          closeDropdown(dropdown, trigger);
          // Tab で先に抜けるときは焦点をトリガーに置いてブラウザの既定の移動に任せる（＝トリガーの次へ）。
          // Shift+Tab で戻るときはトリガー自身に止める
          if (leaving === "forward") trigger.focus();
          if (leaving === "backward") {
            e.preventDefault();
            trigger.focus();
          }
        }
      });
      dropdownTraps.set(dropdown, release);
      if (onOpen) onOpen();
    } else {
      closeDropdown(dropdown, trigger);
    }
  });
}

function closeDropdown(dropdown, trigger) {
  const wasOpen = dropdown.classList.contains("is-open");
  dropdown.classList.remove("is-open");
  trigger.setAttribute("aria-expanded", "false");
  const release = dropdownTraps.get(dropdown);
  if (release) {
    dropdownTraps.delete(dropdown);
    release({ restore: false });
  }
  if (wasOpen && dropdown.contains(document.activeElement) && document.activeElement !== trigger) trigger.focus();
}

const UNREACHABLE_MESSAGE = "ログインのサーバーにつながりません（停止中か、通信の問題です）。学習はこのまま続けられ、記録はこの端末に残ります。";

async function signInWithGoogle() {
  googleLoginButtonElement.disabled = true;
  showAuthMessage("Googleに移動します…");

  // サーバーが止まっていると Google ではなく「このサイトにアクセスできません」へ飛ぶので、先に確かめる
  if (!(await checkAuthReachable())) {
    googleLoginButtonElement.disabled = false;
    showAuthMessage(UNREACHABLE_MESSAGE, "error");
    return;
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: authRedirectOrigin()
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

  if (!(await checkAuthReachable())) {
    loginButtonElement.disabled = false;
    showAuthMessage(UNREACHABLE_MESSAGE, "error");
    return;
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: authRedirectOrigin()
    }
  });

  if (error) {
    loginButtonElement.disabled = false;
    showAuthMessage(formatAuthError(error), "error");
    return;
  }

  closeDropdown(accountGuestElement, loginToggleElement);
  showAuthMessage("ログインリンクを送った。メールを開いて続ける。", "success");
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
      loginButtonElement.textContent = "ログインリンクを送る";
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
  // 表示を切り替えたことを知らせる（js/main.js の ?login=1 など、ドロップダウンの準備を待つ側が使う）
  queueMicrotask(() => window.dispatchEvent(new CustomEvent("spelldash:auth-ready", { detail: { loggedIn: Boolean(session) } })));
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
