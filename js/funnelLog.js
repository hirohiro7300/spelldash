// ===== Pro までの動線の計測（docs/SPEC_FUNNEL.md「計測」、docs/SQL_FUNNEL.md） =====
//
// 端末ごとのランダムな番号（spelldash_device_id）と段階だけを funnel_events に送る。メール・学習の中身は送らない。
// 同じ段階・同じ入口は 1 日 1 回（端末で覚え、サーバーも unique で重ねない）。first_visit と day7 は端末で 1 回きり。
// 表が無い（SQL 未実行）・オフラインなら何もしない。学習の動きを待たせない（送信は待たずに進む。加入の直前だけ短く待つ）。

import { supabase } from "./supabase.js";

const DEVICE_KEY = "spelldash_device_id";
const SENT_KEY = "spelldash_funnel_sent"; // ["step:source:YYYY-MM-DD" | "step:source:once", ...]（新しい 200 件）
const MISSING_KEY = "spelldash_funnel_missing"; // sessionStorage: このタブでは表が無いと分かった
const FIRST_PENDING_KEY = "spelldash_funnel_first"; // 初めて来た日（送れたら消す。表が無い・オフラインでも、後で送れる）
const PAID_PENDING_KEY = "spelldash_funnel_paid"; // 支払いを終えて戻った（Pro が反映されたら checkout_done を送って消す）
const QUEUE_KEY = "spelldash_funnel_queue"; // ページを移る直前に押されたもの（次のページで送る）[{ step, source, day }]
const ONCE_STEPS = new Set(["first_visit", "day7"]);
export const FUNNEL_STEPS = ["first_visit", "day7", "entry", "pro_view", "login_click", "login_return", "checkout_start", "checkout_done", "checkout_cancel"];

// 日付は JST（管理画面の 7 日・30 日の窓と、SQL の既定値と同じ。端末の時刻帯で日がずれないように）
function today() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function randomId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    // 下で作る
  }
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// 端末のランダムな番号（無ければ作る）。戻り値: { id, created }
export function deviceId() {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length >= 8) return { id: existing, created: false };
    const id = randomId();
    localStorage.setItem(DEVICE_KEY, id);
    return { id, created: true };
  } catch {
    return { id: null, created: false };
  }
}

function readSent() {
  try {
    const list = JSON.parse(localStorage.getItem(SENT_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function markSent(key) {
  try {
    const list = readSent().filter((k) => k !== key);
    list.push(key);
    localStorage.setItem(SENT_KEY, JSON.stringify(list.slice(-200)));
  } catch {
    // 覚えられなくてもサーバーの unique が重ねない
  }
}

function isMissingError(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  return code === "42P01" || code === "PGRST205" || /does not exist|schema cache/i.test(message);
}

async function currentUserId() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// 1 件記録する。戻り値の Promise は送り終わる（か諦める）と解決する。待たなくてよい
export function logFunnel(step, source = "", day = today()) {
  if (!FUNNEL_STEPS.includes(step)) return Promise.resolve(false);
  const src = String(source || "").slice(0, 32);
  try {
    if (sessionStorage.getItem(MISSING_KEY)) return Promise.resolve(false);
  } catch {
    // sessionStorage が使えなくても送る
  }
  const key = `${step}:${src}:${ONCE_STEPS.has(step) ? "once" : day}`;
  if (readSent().includes(key)) return Promise.resolve(false);
  const { id } = deviceId();
  if (!id) return Promise.resolve(false);
  return (async () => {
    try {
      const row = { device_id: id, step, source: src, day, user_id: await currentUserId() };
      const result = await supabase.from("funnel_events").upsert(row, { onConflict: "device_id,step,source,day", ignoreDuplicates: true });
      if (result && !result.error) {
        markSent(key);
        return true;
      }
      if (result?.error && isMissingError(result.error)) {
        try {
          sessionStorage.setItem(MISSING_KEY, "1");
        } catch {
          // 何もしない
        }
      }
      return false;
    } catch {
      return false;
    }
  })();
}

// ページを移る直前（Stripe へ移る前など）: 送り終わるか ms ミリ秒たつまで待つ
export function logFunnelBeforeLeave(step, source = "", ms = 800) {
  return Promise.race([logFunnel(step, source), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);
}

// ページを移る直前に押されたものは、送り切れずに切れることがあるので端末に積み、次のページで送る
function queueFunnel(step, source) {
  try {
    const list = JSON.parse(localStorage.getItem(QUEUE_KEY)) || [];
    list.push({ step, source: String(source || "").slice(0, 32), day: today() });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-20)));
  } catch {
    // 積めなければ数えないだけ
  }
}

// 積んであるものを送る（全ページの読み込み時。js/footer.js が呼ぶ）
export function flushFunnelQueue() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(QUEUE_KEY)) || [];
    localStorage.removeItem(QUEUE_KEY);
  } catch {
    return;
  }
  for (const item of Array.isArray(list) ? list : []) {
    if (item && FUNNEL_STEPS.includes(item.step)) logFunnel(item.step, item.source, typeof item.day === "string" ? item.day : today());
  }
}

// 加入画面へのリンクを押した: 入口（data-funnel、無ければ other）を積む。全ページ共通（js/footer.js が呼ぶ）
export function trackProEntries() {
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.('a[href$="pro.html"]');
      if (!link || location.pathname.endsWith("/pro.html")) return;
      queueFunnel("entry", link.dataset.funnel || "other");
    },
    { capture: true }
  );
}

// 学習記録があるか（空の "{}" は無いとみなす。js/storage.js の移行が初回に "{}" を書くため）
function hasLearningRecords() {
  try {
    const stats = JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}");
    return stats && typeof stats === "object" && Object.keys(stats).length > 0;
  } catch {
    return true;
  }
}

// 初めて来た端末: 番号を作ったときに学習記録が無ければ「初めて来た日」を控え、送れるまで毎回試す（js/footer.js が呼ぶ）
export function trackFirstVisit() {
  const { created } = deviceId();
  try {
    if (created && !hasLearningRecords()) localStorage.setItem(FIRST_PENDING_KEY, today());
    const day = localStorage.getItem(FIRST_PENDING_KEY);
    if (!day) return;
    logFunnel("first_visit", "", day).then((sent) => {
      if (sent) localStorage.removeItem(FIRST_PENDING_KEY);
    });
  } catch {
    // 数えないだけ
  }
}

// 支払いを終えて戻った（js/proView.js）。反映がすぐでなくても、後で Pro になったときに checkout_done を送る
export function markPaidPending() {
  try {
    localStorage.setItem(PAID_PENDING_KEY, today());
  } catch {
    // 何もしない
  }
}

// Pro になったら（全ページ。spelldash:plan のたびと読み込み時）控えてある支払いを checkout_done として送る
export function flushPaidPending(isProNow) {
  try {
    const day = localStorage.getItem(PAID_PENDING_KEY);
    if (!day || !isProNow) return;
    logFunnel("checkout_done", "", day).then((sent) => {
      if (sent) localStorage.removeItem(PAID_PENDING_KEY);
    });
  } catch {
    // 何もしない
  }
}
