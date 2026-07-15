import { supabase } from "./supabase.js";

// Daily Dashランキング（daily_scoresテーブル）。
// テーブル未作成・未ログイン・オフラインでも静かに非表示になるだけで、
// ゲーム本体には一切影響しない（Local First原則）。

const TOP_LIMIT = 5;

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

async function getSessionUser() {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user ?? null;
  } catch {
    return null;
  }
}

// Daily完走時に呼ぶ（未ログインなら何もしない）。同日2回目のinsertはPKで弾かれる
export async function submitDailyScore({ score, speed }) {
  try {
    const user = await getSessionUser();
    if (!user) return false;

    const meta = user.user_metadata ?? {};
    // プロフィールで設定した表示名（ローカルキャッシュ）を最優先
    const displayName =
      localStorage.getItem("spelldash_display_name") ||
      meta.full_name ||
      meta.name ||
      user.email?.split("@")[0] ||
      "player";

    const { error } = await supabase.from("daily_scores").insert({
      day: todayString(),
      user_id: user.id,
      display_name: displayName,
      score,
      typing_speed: speed
    });

    return !error;
  } catch {
    return false;
  }
}

async function fetchDailyTop(limit = TOP_LIMIT) {
  try {
    const { data, error } = await supabase
      .from("daily_scores")
      .select("user_id, display_name, score")
      .eq("day", todayString())
      .order("score", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error || !Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

// 自分の今日の順位（TOP外のとき用）。score より高い人数 + 1
async function fetchMyRank(myScore) {
  try {
    const { count, error } = await supabase
      .from("daily_scores")
      .select("*", { count: "exact", head: true })
      .eq("day", todayString())
      .gt("score", myScore);

    if (error || typeof count !== "number") return null;
    return count + 1;
  } catch {
    return null;
  }
}

// #dailyRankArea にTOP5＋自分の順位を描画。データが無ければ非表示のまま
export async function renderDailyRanking(myScore = null) {
  const container = document.getElementById("dailyRankArea");
  if (!container) return;

  const [rows, user] = await Promise.all([fetchDailyTop(), getSessionUser()]);
  if (!rows || rows.length === 0) {
    container.hidden = true;
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const inTop = user && rows.some((row) => row.user_id === user.id);

  let myRankLine = "";
  if (user && !inTop && myScore != null) {
    const rank = await fetchMyRank(myScore);
    if (rank) {
      myRankLine = `<li class="daily-rank__item daily-rank__item--me"><span class="daily-rank__pos">${rank}</span><span class="daily-rank__name">あなた</span><span class="daily-rank__score">${myScore}</span></li>`;
    }
  }

  const loginHint =
    !user
      ? `<span class="daily-rank__hint">ログインするとランキングに参加できます</span>`
      : "";

  container.hidden = false;
  container.innerHTML = `
    <div class="daily-rank__head">今日のランキング ${loginHint}</div>
    <ol class="daily-rank__list">
      ${rows
        .map(
          (row, i) => `
        <li class="daily-rank__item${user && row.user_id === user.id ? " daily-rank__item--me" : ""}">
          <span class="daily-rank__pos">${medals[i] ?? i + 1}</span>
          <span class="daily-rank__name">${escapeHtml(row.display_name ?? "player")}</span>
          <span class="daily-rank__score">${row.score}</span>
        </li>`
        )
        .join("")}
      ${myRankLine}
    </ol>
  `;
}
