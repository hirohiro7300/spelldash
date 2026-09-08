import { supabase } from "./supabase.js";
import { getActiveDaysLast7, getGrowthLog } from "./growthLog.js";

// ===== 未ログインへの穏やかな保存案内 =====
// 3日以上学習した未ログインの人に、1回だけ「ログインすると別端末でも続きから」と伝える。
// 押し付けない: 「あとで」で消えて二度と出ない。データは今のまま引き継がれることを明記。

const KEY = "spelldash_login_nudge";

function activeDaysTotal() {
  return getGrowthLog().filter((e) => e.active).length;
}

export async function renderLoginNudge() {
  const el = document.getElementById("loginNudge");
  if (!el) return;
  el.innerHTML = "";
  if (localStorage.getItem(KEY)) return;
  if (activeDaysTotal() < 3 && getActiveDaysLast7() < 3) return;

  let loggedIn = false;
  try {
    const { data } = await supabase.auth.getSession();
    loggedIn = !!data?.session;
  } catch {
    loggedIn = false;
  }
  if (loggedIn) {
    localStorage.setItem(KEY, "done");
    return;
  }

  el.innerHTML = `
    <span class="login-nudge__text">☁️ ${activeDaysTotal()}日分の記録がこの端末にあります。ログインすると別の端末でも続きから。<b>今のデータはそのまま引き継がれます</b>。</span>
    <span class="login-nudge__actions">
      <button type="button" class="btn btn--sm" id="loginNudgeGo">ログイン</button>
      <button type="button" class="btn btn--sm btn--ghost" id="loginNudgeLater">あとで</button>
    </span>
  `;
  document.getElementById("loginNudgeGo")?.addEventListener("click", () => {
    localStorage.setItem(KEY, "clicked");
    el.innerHTML = "";
    const toggle = document.getElementById("loginToggle");
    if (toggle) {
      toggle.click();
      toggle.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
  document.getElementById("loginNudgeLater")?.addEventListener("click", () => {
    localStorage.setItem(KEY, "later");
    el.innerHTML = "";
  });
}
