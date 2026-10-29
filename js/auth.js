import { authRedirectOrigin } from "./appEnv.js";
import { supabase, isSupabaseConfigured, checkAuthReachable } from "./supabase.js";
import { initialSync, clearSyncedFlag } from "./sync.js";
import { getWordStats } from "./storage.js";
import { refreshPlan, clearPlan } from "./plan.js";
import { trapFocus } from "./focusTrap.js";
import { resumeProIntent, takeLoginReturn } from "./proFunnel.js";

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
// 加入画面へ移る前のページがログインから戻ったタブだった場合も同じに扱う（takeLoginReturn）
const RETURNED_FROM_LOGIN = (() => {
  try {
    return /(?:^|[#&])(access_token|refresh_token)=/.test(location.hash) || new URLSearchParams(location.search).has("code");
  } catch {
    return false;
  }
})() || takeLoginReturn();

// ===== 人ごとの保存の領域（js/areaGuard.js・js/areaSwitch.js。DESIGN-FINAL §4・§5） =====
// セッションの人とページの領域が違えば（ほかのタブ・このタブでログインした・ログアウトした）、同期も Pro の状態の更新もせずに切り替えの画面へ
function areaFits(session) {
  const area = window.SpellDashArea;
  if (!area || area.area === null) return true; // 保存の無い端末（何も残らない）
  const want = session?.user?.id ? "u:" + session.user.id : "guest";
  return area.area === want && area.stillMine() === true;
}

// 切り替えられないときの文（予行・退避の失敗。何も替えていない）
const BLOCKED_MESSAGE = "この端末に記録を安全に保存できなかったため、切り替えられません。ほかの SpellDash のタブを閉じる。端末の空きを作る。設定の「ファイルに書き出す」で記録を書き出してから、もう一度。";
const LOGOUT_FAILED_MESSAGE = "ログアウトできなかった。記録とログインはそのまま。通信がつながってから、もう一度。";
const LOGOUT_DONE_MESSAGE = "ログアウトした。記録はこのアカウントに残る。";
// 切り替えの画面から戻ったときの知らせ（js/areaSwitch.js NOTICE_KEY と同じ名前）と、切り替えの画面への頼み（INTENT_KEY）
const NOTICE_KEY = "sd2.notice";
const INTENT_KEY = "sd2.intent";
const NOTICES = {
  logout: [LOGOUT_DONE_MESSAGE, "", "guest"],
  "logout-failed": [LOGOUT_FAILED_MESSAGE, "error", "user"],
  "logout-blocked": [BLOCKED_MESSAGE, "error", "user"],
  "login-cancelled": ["ログインをやめた。記録はこの端末に残る。", "", "guest"]
};

function showPendingNotice() {
  let notice = null;
  try {
    notice = JSON.parse(sessionStorage.getItem(NOTICE_KEY) || "null");
    sessionStorage.removeItem(NOTICE_KEY);
  } catch {
    notice = null;
  }
  const row = notice && Date.now() - Number(notice.at) < 120000 ? NOTICES[notice.kind] : null;
  if (row) showAuthMessage(row[0], row[1], { scope: row[2] });
}

// 予行（ログインのリンクを送る前・Google に移る前・ログアウトの前）: 今の領域の記録を IndexedDB に写して読み直す（js/areaSwitch.js precheck）。
// できなければ切り替えを始めない。保存の無い端末では写す物が無い
async function precheckArea() {
  const area = window.SpellDashArea;
  if (!area || area.area === null) return { ok: true };
  if (area.stillMine() !== true) return { ok: false, reason: "busy" };
  const records = {};
  for (const key of area.keys()) {
    if (!area.isPersonKey(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) records[key] = value;
  }
  try {
    const mod = await import("./areaSwitch.js");
    return await mod.precheck({ area: area.area, records });
  } catch {
    return { ok: false, reason: "load" };
  }
}

// 切り替えの画面へ（ログアウトの頼みを渡す）。頼みを書けなければ移らない
function goSwitch(op, notice = null) {
  try {
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ op, at: Date.now(), ...(notice ? { notice } : {}) }));
  } catch {
    return false;
  }
  window.SpellDashArea.leave();
  return true;
}

export async function initializeAuth() {
  const { data } = await supabase.auth.getSession();
  // ページの領域がこのセッションの人でない: 切り替えの画面へ（同期・Pro の状態の更新・加入画面への戻しはその後のページで）
  if (!areaFits(data.session)) {
    window.SpellDashArea?.leave?.();
    return;
  }
  const hadSessionAtLoad = Boolean(data.session) && !RETURNED_FROM_LOGIN;
  // 加入画面で「ログインして始める」を押してログインから戻った: 加入画面へ戻す（ログインのリンクはトップに戻る）
  if (data.session && RETURNED_FROM_LOGIN && resumeProIntent()) return;
  updateAuthDisplay(data.session);
  showPendingNotice();
  refreshPlan(); // Pro の状態（spelldash_plan）を更新

  // ログイン済みならクラウドと初回同期（マージ）
  if (data.session) {
    runInitialSync({ freshLogin: !hadSessionAtLoad });
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    // ほかのタブ・このタブでセッションの人が替わった: 同期の前に切り替えの画面へ（見張りも移すが、知らせの順によらずここでも止める）
    if (!areaFits(session)) {
      window.SpellDashArea?.leave?.();
      return;
    }
    updateAuthDisplay(session);
    if (_event === "SIGNED_OUT") clearPlan(); else if (_event === "SIGNED_IN") refreshPlan();

    if (_event === "SIGNED_IN") {
      // 加入画面へ戻すのはログインから戻ったタブだけ（上の getSession）。ほかのタブに届いた SIGNED_IN では移動しない
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

  // 切り替えを始める前の予行（戻ってきたら、この端末の今の記録を IndexedDB に退避してから切り替える）。できなければ Google に移らない
  if (!(await precheckArea()).ok) {
    googleLoginButtonElement.disabled = false;
    showAuthMessage(BLOCKED_MESSAGE, "error");
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

  // 切り替えを始める前の予行。できなければリンクを送らない
  if (!(await precheckArea()).ok) {
    loginButtonElement.disabled = false;
    showAuthMessage(BLOCKED_MESSAGE, "error");
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

// ログアウト: 予行の後に切り替えの画面へ。切り替えの画面が今の領域を IndexedDB に退避して確かめてから signOut（scope local）し、ゲストの領域を戻す。
// 予行・退避・signOut のどれかが失敗したら、記録もログインもそのまま（文を出す）。同期の印は領域の世代が替わったタブの見張りが消す
async function logout() {
  const area = window.SpellDashArea;
  if (!area || area.area === null) {
    // 保存の無い端末: 切り替える記録が無い
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) showAuthMessage(LOGOUT_FAILED_MESSAGE, "error", { scope: "user" });
    else showAuthMessage(LOGOUT_DONE_MESSAGE);
    return;
  }
  logoutButtonElement.disabled = true;
  const check = await precheckArea();
  if (!check.ok || !goSwitch("logout")) {
    logoutButtonElement.disabled = false;
    showAuthMessage(BLOCKED_MESSAGE, "error", { scope: "user" });
  }
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
    updateAccountEmblem(null);
    return;
  }

  // ログイン中の画面に、未ログインのときの文（ログアウトした・送信中など）を残さない。同期の文は残す
  if (authMessageElement.dataset.scope === "guest") showAuthMessage("", "", { scope: "" });
  const email = session.user.email ?? "";
  accountGuestElement.hidden = true;
  accountUserElement.hidden = false;
  userStatusElement.textContent = email;
  setAvatarLetter(email.charAt(0).toUpperCase() || "?");
  closeDropdown(accountGuestElement, loginToggleElement);
  updateAccountEmblem(session);
}

// 頭文字は #headerAvatar の中の span の字だけを替える（中身を丸ごと書き換えると、紋章の img が消える: 認証の知らせはトークンの更新・タブに戻ったときにも来る）
function setAvatarLetter(letter) {
  let el = headerAvatarElement.querySelector(".avatar__letter");
  if (!el) {
    for (const node of [...headerAvatarElement.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove(); // HTML の「?」
    el = document.createElement("span");
    el.className = "avatar__letter";
    el.setAttribute("aria-hidden", "true"); // 名前はボタンの aria-label
    headerAvatarElement.prepend(el);
  }
  el.textContent = letter;
}

// ===== アカウントのアイコンの紋章（今の学習のランク。js/accountEmblem.js） =====
// ログイン中だけ、読み込みの後の手の空いたときに動的 import で読む（最初の描画・LCP の絵と競らない。静的 import を足すと各ページの modulepreload が変わる）。
// 読んだ後は、認証の知らせのたびにセッションを渡す（同じ人なら状態を捨てずに比べ直すだけ。幕とプレイの間は段を替えない: js/accountEmblem.js setAccountSession）
let accountEmblem = null;
let accountEmblemQueued = false;
let accountSession = null;

function updateAccountEmblem(session) {
  accountSession = session;
  if (accountEmblem) {
    accountEmblem.setAccountSession(session);
    return;
  }
  if (!session || accountEmblemQueued) return;
  accountEmblemQueued = true;
  afterLoadIdle(() => {
    import("./accountEmblem.js")
      .then((mod) => {
        accountEmblem = mod;
        mod.setAccountSession(accountSession);
      })
      .catch(() => {
        accountEmblemQueued = false; // 読めなかった（オフライン等）: 頭文字のまま。次の認証の知らせで読み直す
      });
  });
}

function afterLoadIdle(run) {
  const idle = () => (typeof requestIdleCallback === "function" ? requestIdleCallback(run, { timeout: 2000 }) : setTimeout(run, 1200));
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
}

// initialSync の戻り値（js/sync.js）: "changed"（取り込んだ）／"same"（変化なし）／"cancelled"（ログアウトの後の記録を足すのを断った）／
// false（未ログイン・このタブで同期済み・ページの領域がこのアカウントでない）
async function runInitialSync(options = {}) {
  try {
    const result = await initialSync(options);
    if (result === "cancelled") {
      // 端末の記録は何も書き換えていない。ログインだけやめる（次にログインしたら、もう一度たずねる）。ログアウトと同じく切り替えの画面で
      // 退避を確かめてから scope local で signOut（この端末だけ）。予行ができなければログインのまま（同期はしない）
      clearSyncedFlag();
      if (!(await precheckArea()).ok || !goSwitch("logout", "login-cancelled")) showAuthMessage(BLOCKED_MESSAGE, "error", { scope: "user" });
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
  } finally {
    // 結果によらず紋章を描き直す（取り込みの失敗・変化なしでは spelldash:synced が来ない。置き換えた後は持ち主の印が替わる）
    accountEmblem?.refreshAccountEmblem();
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
