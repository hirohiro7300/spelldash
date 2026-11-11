import { getWordStats, getSessionLog } from "./storage.js";
import { getStreak, hasPlayedToday } from "./level.js";
import { getActiveDaysLast7, getCoreDelta7, getCoreNow, getGrowthLog } from "./growthLog.js";
import { localDateString } from "./stats.js";
import { hasumiWeeklyLine, hasumiBubbleHtml } from "./hasumi.js";
import { shouldShowWeeklyPro } from "./proFunnel.js";
import { isFocusOn } from "./focus.js";
import { getMyWords } from "./myWords.js";
import { countMyGain, myStudiedSince } from "./myWordsCore.js";
import { learnDayOf } from "./learnState.js";

// ===== 週間レポート（直近7日） =====
// 「自分は前進している」証拠を週に一度まとめて見せる。
// 数字は端末内の学習記録から算出（サーバー不要）。

// この端末に成長ログ（日ごとの行、js/growthLog.js）が足りない: 今日より前の行が 1 つも無いのに、連続日数はそれより長い。
// 2 台目の端末（ログインで語の記録だけ届いた）がこれ。学習した日・7日で覚えた はこの端末の行から数えるので、
// 休んだ週と同じ「0 / 7」「+0」に見えてしまう。初めての人（連続 0〜1 日）は本当に記録が無いだけなので当てはまらない
export function isGrowthLogMissing() {
  const today = localDateString();
  const log = getGrowthLog();
  const streak = getStreak().current;
  if (streak === 0) return false;
  // 連続中なのに、この端末の記録に直近 7 日の「学習した日」が 1 日も無い（ほかの端末でだけ学んでいる）
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 6);
  const since = localDateString(weekAgo);
  if (!log.some((e) => e.active && e.date >= since && e.date <= today)) return true;
  // この端末の記録が今日から始まったのに、連続日数はそれより長い（2 台目の初日）
  if (log.some((e) => e.date < today)) return false;
  const todayActive = log.some((e) => e.date === today && e.active);
  return streak > (todayActive ? 1 : 0);
}

// myList: マイ単語帳の語の並び（学習状況の 1 回の描画で 1 回だけ読んで渡す。渡さなければここで読む）
export function computeWeeklyReport({ myList = null } = {}) {
  // 今日まだやっていなければ「昨日までの 7 日」で数える（朝に開いても 6/7 にならない）
  const includeToday = hasPlayedToday();
  const endDay = new Date();
  endDay.setHours(23, 59, 59, 999);
  if (!includeToday) endDay.setDate(endDay.getDate() - 1);
  const start = new Date(endDay); // 日付単位で 6 日戻す（夏時間の切り替え日でも 7 日ぶんになる）
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  const since = start.getTime();
  // 上限は付けない: 語の記録は「最後の 1 回」の日時しか持たないので、今日の 1 回で上書きされた語を窓から落とすと母数が偏る
  const inWindow = (iso) => (Date.parse(iso ?? 0) || 0) >= since;
  const stats = getWordStats();

  let recalled = 0;
  let failed = 0;
  let reviewOk = 0;
  let reviewNg = 0;
  for (const s of Object.values(stats)) {
    if (s.lastRecallSuccessAt && inWindow(s.lastRecallSuccessAt)) recalled++;
    if (s.lastRecallFailAt && inWindow(s.lastRecallFailAt)) failed++;
    if (s.lastReviewAt && inWindow(s.lastReviewAt)) {
      if (s.lastReviewResult === "ok") reviewOk++;
      else if (s.lastReviewResult === "ng") reviewNg++;
    }
  }

  // 覚えた は学習状況の最初の画面と同じ数（3 状態。公開の語だけ。Batch 90: js/growthLog.js getCoreNow・getCoreDelta7）。
  // 増えは「今（今日まだ学んでいなければ昨日の終わり）− 窓の前の日の終わり」。null は分からない（この端末で数え始める前のほかの端末の日が窓に入る・表が一度も読めない）
  const learnedTotal = getCoreNow();
  const learnedDelta = getCoreDelta7(includeToday ? 0 : 1);
  const activeDays = getActiveDaysLast7(includeToday ? 0 : 1);

  const runs = getSessionLog().filter((e) => inWindow(e.at));
  const bestScore = runs.length ? Math.max(...runs.map((e) => e.score)) : 0;

  const retention = reviewOk + reviewNg > 0 ? Math.round((reviewOk / (reviewOk + reviewNg)) * 100) : null;
  const recallRate = recalled + failed > 0 ? Math.round((recalled / (recalled + failed)) * 100) : null;

  // マイ単語帳で 覚えた（Batch 91。docs/SPEC_MY_WORDS.md §17）: 窓の日（start〜endDay）に初めて 覚えた になり、今も 覚えた の語（語の lf。英単語の数には入れない。
  // 語と一緒に同期・バックアップ・領域で動くので、端末の成長ログは見ない）。マスは窓の中でマイ単語帳の語に答えたか、増えが 1 以上のときだけ出す
  const list = Array.isArray(myList) ? myList : getMyWords();
  const myGain = countMyGain(list, learnDayOf(since), learnDayOf(endDay.getTime()));
  const myShow = myGain > 0 || myStudiedSince(list, since);

  const end = new Date(endDay);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

  return {
    range: `${fmt(start)}〜${fmt(end)}`,
    activeDays,
    learnedDelta,
    learnedTotal,
    recalled,
    failed,
    recallRate,
    retention,
    reviewCount: reviewOk + reviewNg,
    bestScore,
    streak: getStreak().current,
    noLog: isGrowthLogMissing(),
    myGain,
    myShow
  };
}

// 覚えた の増えか累計が分からない（null）ときは、その部分だけ省く（シェアは残す）
const knowsLearned = (r) => r.learnedDelta !== null && r.learnedTotal !== null;

export function buildWeeklyShareText(r = computeWeeklyReport()) {
  const lines = [`SpellDash 週間レポート ${r.range}`];
  // マイ単語帳のマスを出す週（Batch 91）は、数の並びと同じく英単語の数にも頭を付ける（どちらの「覚えた」かを外の人にも分かるように）
  const learned = r.myShow ? "英単語で 覚えた" : "覚えた";
  lines.push(knowsLearned(r) ? `学習 ${r.activeDays}/7日 ・ ${learned} +${r.learnedDelta}語（累計 ${r.learnedTotal}）` : `学習 ${r.activeDays}/7日`);
  if (r.myShow) lines.push(`マイ単語帳で 覚えた +${r.myGain}語`);
  const rate = r.retention ?? r.recallRate;
  if (rate != null) lines.push(`思い出せた率 ${rate}%${r.streak > 0 ? ` ・ ${r.streak}日連続` : ""}`);
  else if (r.streak > 0) lines.push(`${r.streak}日連続`);
  if (r.bestScore > 0) lines.push(`⏱ 今週のベスト ${r.bestScore}`);
  lines.push("今日も、はちゃんと少しだけ。");
  lines.push("https://www.spelldash.net");
  return lines.join("\n");
}

// 最後に描いた中身（入れ物ごと）。同じ中身なら描き直さない（Batch 72: 学習データを開いた直後に Pro の受付の返事などで同じ中身を描き直すと、
// はちゃんの絵を読み直し、押した「レポートをシェア」の文も戻っていた）
const lastHtml = new WeakMap();

export function renderWeeklyReport(containerId, { compact = false, myList = null } = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const r = computeWeeklyReport({ myList });
  const rate = r.retention ?? r.recallRate;
  // 成長ログの無い端末: 学習した日・7日で覚えた は「–」、はちゃんは出さない（数字と矛盾しない）。注記 1 行。シェアも出さない
  const noLog = r.noLog;
  // 覚えた の増えが分からない（null。2 台目でこの端末の数え始めより前の日が窓に入る間など）: 7日で 覚えた は「–」と注記 1 行。シェアは残す（文の 覚えた の部分だけ省く）。
  // はちゃんの一言は増え 0 と同じ扱い（js/hasumi.js hasumiWeeklyLine）
  const unknown = !noLog && !knowsLearned(r);
  // Pro の 1 行: 英単語の学習に絞った間（js/focus.js）は出さない（マイ単語帳・連続記録の修復は画面に出ない機能。Batch 78 段 6。反証 rv5 shouldFix 3）。
  // 旗を外せば前と同じ決まり（shouldShowWeeklyPro）
  const showPro = !compact && !noLog && !isFocusOn() && shouldShowWeeklyPro(getGrowthLog().filter((e) => e.active).length);

  const html = `
    <div class="weekly__head">
      <span class="weekly__title">週間レポート</span>
      <span class="weekly__range">${r.range}</span>
    </div>
    ${compact || noLog ? "" : hasumiBubbleHtml(hasumiWeeklyLine(r), "hasumi--result")}
    <div class="weekly__grid">
      <div><span>学習した日</span><strong>${noLog ? "–" : `${r.activeDays}<small> / 7</small>`}</strong></div>
      <div><span>${r.myShow ? "英単語で 覚えた" : "7日で 覚えた"}</span><strong>${noLog || unknown ? "–" : `+${r.learnedDelta}<small> 語</small>`}</strong></div>
      ${r.myShow ? `<div><span>マイ単語帳で 覚えた</span><strong>+${r.myGain}<small> 語</small></strong></div>` : ""}
      <div><span>思い出せた率</span><strong>${rate == null ? "–" : `${rate}<small>%</small>`}</strong></div>
      ${r.bestScore ? `<div><span>ベスト</span><strong>${r.bestScore}</strong></div>` : ""}
    </div>
    ${noLog ? `<p class="weekly__note">この端末での記録は明日から</p>` : unknown ? `<p class="weekly__note">${r.myShow ? "英単語の " : ""}覚えた の増えは、この端末で数え始めた日から数える。</p>` : ""}
    ${r.retention != null ? `<p class="weekly__note">思い出せた率＝1日以上前に覚えた語を復習で思い出せた割合（${r.reviewCount}語）</p>` : ""}
    ${showPro ? `<p class="weekly__note weekly__pro">Pro なら、マイ単語帳 1,000語・連続記録の修復。<a href="./pro.html" data-funnel="weekly">Pro について</a></p>` : ""}
    ${noLog && !compact ? "" : `<div class="weekly__actions">
      ${noLog ? "" : `<button type="button" class="result-panel__action" data-weekly-share>レポートをシェア</button>`}
      ${compact ? `<a class="result-panel__action result-panel__action--ghost" href="./stats.html#weekly">くわしく見る</a>` : ""}
    </div>`}
  `;
  if (lastHtml.get(el) === html) return;
  lastHtml.set(el, html);
  el.innerHTML = html;

  el.querySelector("[data-weekly-share]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const outcome = await shareWeeklyReport().catch(() => "failed");
    if (outcome === "copied") button.textContent = "コピーした。SNSに貼り付けて使える";
    if (outcome === "failed") button.textContent = "シェアできなかった";
  });
}

export function buildWeeklyReportImage(r = computeWeeklyReport()) {
  const W = 1080;
  const H = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.2, H * 0.1, 60, W * 0.2, H * 0.1, 700);
  glow.addColorStop(0, "rgba(59,130,246,0.35)");
  glow.addColorStop(1, "rgba(59,130,246,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const grad = ctx.createLinearGradient(80, 80, 176, 176);
  grad.addColorStop(0, "#3b82f6");
  grad.addColorStop(1, "#6366f1");
  ctx.fillStyle = grad;
  roundRect(ctx, 80, 80, 96, 96, 26);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 40px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SD", 128, 130);
  ctx.textAlign = "left";
  ctx.font = "800 56px sans-serif";
  ctx.fillText("SpellDash", 208, 130);

  ctx.fillStyle = "#93c5fd";
  ctx.font = "800 60px sans-serif";
  ctx.fillText(`週間レポート ${r.range}`, 80, 300);

  // 大きい数（純の weeklyImageHero）: 7 日で覚えた語。分からない（null）ときは学習した日（下の行に重ねない）。マイ単語帳のマスを出す週はどちらの数かを字で言う
  const { big, label } = weeklyImageHero(r);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "800 200px sans-serif";
  ctx.fillText(big, 80, 500);
  const w = ctx.measureText(big).width;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 56px sans-serif";
  // 字が長い（「語 マイ単語帳で 覚えた」）か数が大きいときは、右の端からはみ出さないように字を小さくする（36px まで）
  const room = W - 60 - (80 + w + 24);
  const lw = ctx.measureText(label).width;
  if (lw > room) ctx.font = `700 ${Math.max(36, Math.floor((56 * room) / lw))}px sans-serif`;
  ctx.fillText(label, 80 + w + 24, 520);

  const rows = weeklyImageRows(r);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "700 52px sans-serif";
  const gap = rows.length > 4 ? 68 : 84; // 5 行（マイ単語帳のマスを出す週に、英単語かマイ単語帳の行を足した週）でも下の spelldash.net に重ねない
  rows.forEach((line, i) => ctx.fillText(line, 80, 660 + i * gap));

  ctx.fillStyle = "#64748b";
  ctx.font = "600 40px sans-serif";
  ctx.fillText("spelldash.net", 80, H - 70);
  return canvas;
}

// シェアの絵の大きい数と、その横の字（純）。マイ単語帳のマスを出さない週は前のまま（7 日で覚えた語「語 覚えた」。分からないときは学習した日）。
// 出す週（Batch 91）は数の並びと同じく頭でどちらの数かを言う: 英単語の増えが 0 か分からない週にマイ単語帳で 1 語以上覚えたら、大きい数はマイ単語帳の数
// （マイ単語帳だけで学ぶ人の絵に、大きい「+0 語」を出さない）。それ以外は英単語の数（「語 英単語で 覚えた」）
export function weeklyImageHero(r) {
  const known = knowsLearned(r);
  if (r.myShow && r.myGain > 0 && !(known && r.learnedDelta > 0)) return { big: `+${r.myGain}`, label: "語 マイ単語帳で 覚えた", of: "my" };
  if (known) return { big: `+${r.learnedDelta}`, label: r.myShow ? "語 英単語で 覚えた" : "語 覚えた", of: "english" };
  return { big: `${r.activeDays}`, label: "/ 7日 学習した", of: "days" };
}

// シェアの絵の大きい数の下の行（純）。学習した日は大きい数が学習した日でないとき。マスを出す週（Batch 91）は、大きい数に出さなかった方の数を学習した日の次に
// （大きい数がマイ単語帳なら「英単語で 覚えた」。英単語の増えが分からないときは出さない）
export function weeklyImageRows(r) {
  const rate = r.retention ?? r.recallRate;
  const hero = weeklyImageHero(r);
  return [
    hero.of !== "days" ? `学習した日  ${r.activeDays} / 7` : null,
    r.myShow && hero.of === "my" && knowsLearned(r) ? `英単語で 覚えた  +${r.learnedDelta}語` : null,
    r.myShow && hero.of !== "my" ? `マイ単語帳で 覚えた  +${r.myGain}語` : null,
    rate == null ? null : `↻ 思い出せた率  ${rate}%`,
    r.streak > 0 ? `${r.streak}日連続` : null,
    r.bestScore > 0 ? `⏱ 今週のベスト  ${r.bestScore}` : null
  ].filter(Boolean);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function shareWeeklyReport() {
  const text = buildWeeklyShareText();
  if (navigator.share) {
    try {
      const blob = await new Promise((resolve) => buildWeeklyReportImage().toBlob(resolve, "image/png"));
      if (blob) {
        const file = new File([blob], "spelldash-weekly.png", { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ text, files: [file] });
          return "shared";
        }
      }
    } catch {
      // 画像共有に失敗したらテキストへ
    }
    try {
      await navigator.share({ text });
      return "shared";
    } catch {
      // キャンセル等 → コピーへ
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
