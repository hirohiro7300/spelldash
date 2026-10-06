import { authRedirectOrigin } from "./appEnv.js";
import { supabase, isSupabaseConfigured, checkAuthReachable } from "./supabase.js";
import { initialSync, clearSyncedFlag } from "./sync.js";
import { getWordStats } from "./storage.js";
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

// いまログインから戻ってきたか（メールのリンク・Google のリダイレクト）。Supabase が URL を片付ける前に読む
const RETURNED_FROM_LOGIN = (() => {
  try {
    return /(?:^|[#&])(access_token|refresh_token)=/.test(location.hash) || new URLSearchParams(location.search).has("code");
  } catch {
    return false;
  }
})();

export async function initializeAuth() {
  const { data } = await supabase.auth.getSession();
  const hadSessionAtLoad = Boolean(data.session) && !RETURNED_FROM_LOGIN;
  updateAuthDisplay(data.session);
  refreshPlan(); // Pro の状態（spelldash_plan）を更新

  // ログイン済みならクラウドと初回同期（マージ）
  if (data.session) {
    runInitialSync({ freshLogin: !hadSessionAtLoad });
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    updateAuthDisplay(session);
    if (_event === "SIGNED_OUT") clearPlan(); else if (_event === "SIGNED_IN") refreshPlan();

    if (_event === "SIGNED_IN") {
      runInitialSync({ freshLogin: !hadSessionAtLoad });
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

const UNREACHABLE_MESSAGE = "ログインのサーバーにつながらない。学習はこのまま続けられ、記録はこの端末に残る。";

async function signInWithGoogle() {
  googleLoginButtonElement.disabled = true;
  showAuthMessage("Google に移動する…");

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
    showAuthMessage(`Google ログインに失敗した: ${error.message}`, "error");
  }
}

async function sendLoginLink() {
  if (!isSupabaseConfigured) {
    showAuthMessage(
      "ログインの設定が済んでいない（Supabase のキーが無い）。管理者に知らせる。",
      "error"
    );
    return;
  }

  const email = emailInputElement.value.trim();

  if (!email) {
    showAuthMessage("メールアドレスを入れる。", "error");
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
    return "メール送信の上限。約1時間あけてもう一度。";
  }

  if (message.includes("Invalid API key")) {
    return "ログインの設定に問題がある（API キーが無効）。管理者に知らせる。";
  }

  return `ログインリンクの送信に失敗した: ${message}`;
}

async function logout() {
  clearSyncedFlag(); // 同じタブで（別のアカウントでも）ログインし直したら、もう一度同期する
  await supabase.auth.signOut();
  showAuthMessage("ログアウトした。記録はこの端末に残る。");
}

function updateAuthDisplay(session) {
  // 表示を切り替えたことを知らせる（js/main.js の ?login=1・トップページを畳む など、ドロップダウンの準備を待つ側が使う）
  queueMicrotask(() => window.dispatchEvent(new CustomEvent("spelldash:auth-ready", { detail: { loggedIn: Boolean(session) } })));
  const welcomeLogin = document.getElementById("welcomeLogin"); // トップページの「すでに使っている方はログイン」
  if (welcomeLogin) welcomeLogin.hidden = Boolean(session);
  if (!session) {
    accountGuestElement.hidden = false;
    accountUserElement.hidden = true;
    userStatusElement.textContent = "";
    closeDropdown(accountUserElement, avatarButtonElement);
    return;
  }

  // ログイン中の画面に、未ログインのときの文（ログアウトした・送信中など）を残さない。同期の文は残す
  if (authMessageElement.dataset.scope === "guest") showAuthMessage("", "", { scope: "" });
  const email = session.user.email ?? "";
  accountGuestElement.hidden = true;
  accountUserElement.hidden = false;
  userStatusElement.textContent = email;
  headerAvatarElement.textContent = email.charAt(0).toUpperCase() || "?";
  closeDropdown(accountGuestElement, loginToggleElement);
}

// initialSync の戻り値（js/sync.js）: "changed"（取り込んだ）／"same"（変化なし）／"cancelled"（別アカウントの記録の置き換えを断った）／false（未ログイン・このタブで同期済み）
async function runInitialSync(options = {}) {
  try {
    const result = await initialSync(options);
    if (result === "cancelled") {
      // 端末の記録は何も書き換えていない。ログインだけやめる（次にログインしたら、もう一度たずねる）。
      // ページの文が出ていても、ログアウトは必ず行う
      clearSyncedFlag();
      await supabase.auth.signOut();
      if (!pageMessageShown()) showAuthMessage("ログインをやめた。記録はこの端末に残る。");
      return;
    }
    if (pageMessageShown()) return; // ほかのページの文（プロフィールの「Pro になった」など）は上書きしない
    if (result === "changed") {
      showAuthMessage("記録を同期した。", "success", { scope: "user" });
    }
  } catch {
    if (pageMessageShown()) return;
    // 同期に失敗してもローカルで動き続ける（Local First）。記録のある端末では何も言わない。
    // 空の端末だけ、記録が届いていないことを伝える（ここで新しく始めると、届くはずの記録と混ざる）
    if (Object.keys(getWordStats()).length === 0) {
      showAuthMessage("記録を取り込めなかった。開き直すともう一度試す。", "error", { scope: "user" });
    }
  }
}

// ページが同じ欄に書いた文（js/profileView.js が scope="page" を付ける）が出ているか
function pageMessageShown() {
  return authMessageElement.dataset.scope === "page" && authMessageElement.textContent.trim() !== "";
}

// scope: "guest" は未ログインのときの文（ログアウトした・送信中など）で、ログインしたら消す（updateAuthDisplay）。
// "user" はログイン中の文（同期の結果）。"page" はほかのページが同じ欄に書く文（プロフィールの Pro の反映など）で、auth は消さず上書きもしない
function showAuthMessage(text, type = "", { scope = "guest" } = {}) {
  authMessageElement.textContent = text;
  authMessageElement.className = `auth-message ${type}`.trim();
  authMessageElement.dataset.scope = scope;
}
