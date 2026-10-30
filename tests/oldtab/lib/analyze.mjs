// 記録した要求と、にせの表の最後の中身から、A の記録が B へ（と B の記録が A へ）送られたかを調べる。
// B はこの検査の中で学習しない。だから B の名前の書き込み（Authorization が B か、行の user_id が B）は、B のクラウドの初めの値（result.seed）と
// 列ごとに同じでなければならない。違ってよいのは、B が学ばなくても新しいコードが書き直す列（updated_at・user_progress の level・study_familiar_ratio・selected_*）だけ。
// 規則（どれか 1 つでも当たれば漏れ）:
//   seed:      B の行が B のクラウドの値と列ごとに違う／B のクラウドに無い行（B の今日の日の行で、端末の B の記録から作れる数だけの物は除く）／消した印（deleted）／B の行を消した
//   word:      word_progress の語が A の語（A が持っていた語・A が答えた語）
//   text:      A だけの文字（A の user id・メール・マイ単語帳の語・メモ・表示名・Battle の印）が中身のどこかにある（端末の計測と問い合わせの表もこれだけは見る）
//   owner:     B の名前の要求で行の user_id が A（RLS で断られても「送った」に数える）
//   違った値が A の値（A が 1 段で書いた値・A のクラウド・A の端末の初めの値）と同じなら、そう書き添える
// 逆向き（B → A）: A の名前の書き込みに B の語・B だけの文字・user_id が B の行。
// 表の最後の中身も同じ規則で見る（stored）。B の初めの行が消えていても漏れ。読み（GET）の中の印は参考（info）として出す。
// 旧いコードのタブの決まり（structural）: 旧いコードのまま（配信の後に新しい文書が始まる前）の旧いタブが、B のトークンで要求した・B のトークンを更新した・
//   行の user_id が B の要求を出した（通信断で届かなかった物も）、旧いモジュールの getSession が B を返した、旧い認証の鍵に B のセッションがあった、のどれか。
//   値の規則が見ない形（読み・更新・品・消した印など）も、正しい木なら 0 件のはず。
// A の記録の後退（integrity。漏れとは別の判定 LOSS）: 配信の後の A の名前の書き込み（受け口が受けた物）と、表の最後の A の行が、A の初めの値（A のクラウド・
//   A の端末）と A がそれまでに書いた値より後ろへ戻ったら当たり。数え上げ（語の回数・最高点・XP・Battle の勝ち負け・連続日数の最高・今日の活動・日ごとの記録の数）が減る、
//   連続日数が日が続いているのに戻る、Battle をしていないのに RP・連勝が変わる、品・メモ・マイ単語帳に消した印・中身が空・表示名が空、A の初めの行が消える。
//   既存の利用者のデータを消さない（COMMON 製品の決まり）。旧いコードのタブが移行の後の空の端末の値を A のクラウドへ上書きする形（2.107.0 より前の部品の書き戻し）を見つける
// A の語: A だけの語（A_WORDS）は B の行にあれば当たり。A が旧い画面で答えた語のうち A だけの語でない物（公開の語。B が学べば B の行もありうる）は、
//   回数が A の値（A が書いた行・旧いタブの端末の値）と同じときだけ当たり（B のクラウドに無い行なら seed の規則がどのみち当たる）
import { USERS, A_WORDS, B_WORDS, A_MARK, B_MARK, OLD_TABS, KEEP_TABS, TAB_MODULES, aLocalStorage, cloudSeed } from "./seed.mjs";
import { WORD_KEY } from "./storageTap.mjs";

const WRITE = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const A = USERS.A.id;
const B = USERS.B.id;
// 表ごとの主キー（user_id を除く）。ここに無い表は B のクラウドに行が無い（Battle・プレイ・順位・活動・加入は B が遊ばない限り書かれない）
const PK = { word_progress: ["word_id"], user_progress: [], user_items: ["kind", "key"], profiles: [], activity_days: ["day"], subscriptions: [] };
// 端末の計測と問い合わせ（人の記録ではない）。A だけの文字だけを見る
const DEVICE_TABLES = new Set(["funnel_events", "feedback"]);
// B の行で B のクラウドの値と違ってよい列
const freeCol = (table, col) => col === "user_id" || col === "updated_at" || (table === "user_progress" && (col === "level" || col === "study_familiar_ratio" || col.startsWith("selected_")));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const asText = (v) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
const isEmpty = (v) => v === null || v === undefined || v === 0 || v === false || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
const fmt = (v) => (v === undefined ? "（無い）" : JSON.stringify(v));

// 書いた値 a と B のクラウドの値 b が同じか（時刻は 5 秒まで・数は数として・物は diffKeys が空）
function same(a, b) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === "string" && typeof b === "string" && ISO.test(a) && ISO.test(b)) return Math.abs(Date.parse(a) - Date.parse(b)) <= 5000;
  if (typeof a === "number" || typeof b === "number") return a !== null && a !== undefined && b !== null && b !== undefined && a !== "" && Number(a) === Number(b);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") return diffKeys(a, b).length === 0;
  return a === b;
}
// 違う鍵の一覧 [鍵, 書いた値, B の値]。書いていない鍵は比べない（部分の書き込み）。B に無い鍵は空（null・0・false・""）でなければ違う
function diffKeys(a, b, free = () => false) {
  const out = [];
  for (const k of Object.keys(a)) {
    if (free(k)) continue;
    if (!(k in b)) {
      if (!isEmpty(a[k])) out.push([k, a[k], undefined]);
    } else if (!same(a[k], b[k])) out.push([k, a[k], b[k]]);
  }
  return out;
}

function textHits(value, strings) {
  const s = JSON.stringify(value ?? null);
  return strings.filter((x) => x && s.includes(x));
}

// PATCH・DELETE の行: 問いの eq の絞り込みを行の列として足す
function rowsOf(r) {
  const eq = {};
  for (const [k, v] of Object.entries(r.query ?? {})) {
    const m = String(v).match(/^eq\.(.*)$/s);
    if (m && !["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) eq[k] = m[1];
  }
  if (r.method === "DELETE") return [eq];
  const body = Array.isArray(r.body) ? r.body : r.body && typeof r.body === "object" ? [r.body] : [];
  return r.method === "PATCH" ? body.map((b) => ({ ...eq, ...b })) : body;
}

// opts.importState: A へ戻った後の 3 状態の決まり（取り込みの仕様しだいなので、統合担当が決める）。
//   "report"（既定）= 値を出すだけで判定しない・"keep" = 取り込んだ語の状態は A の初めの状態のまま（A に無かった語は これから）・
//   関数 ({ id, prior, after, need, written, pub }) => 0|1|2|null（null は見ない。--import-state <ファイル> の既定の export）
export function analyze(result, opts = {}) {
  const reqs = result.requests ?? [];
  const seedAt = result.seedAt ?? result.timeline?.[0]?.t ?? Date.now();
  // B のクラウドの初めの値（この回の種。古い記録には無いので、同じ時刻から作り直す: 時刻は 5 秒まで同じと見る）
  const seed = result.seed ?? cloudSeed(seedAt);
  const day0 = new Date(seedAt);
  const todayKey = `${day0.getFullYear()}-${String(day0.getMonth() + 1).padStart(2, "0")}-${String(day0.getDate()).padStart(2, "0")}`;
  const bSeed = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.filter((r) => r.user_id === B)]));
  const findSeed = (table, row) => (PK[table] ? (bSeed[table] ?? []).find((s) => PK[table].every((c) => asText(s[c]) === asText(row[c]))) : undefined);
  const keyText = (table, row) => (PK[table]?.length ? PK[table].map((c) => row[c]).join(":") : table === "activity_days" ? row.day : "");
  const bMastered = (bSeed.word_progress ?? []).filter((r) => r.mastered).length;
  // B のクラウドに無い行で、許す物: B の今日の日の行（端末の B の記録の数を新しいコードが書く。学んだ印・セットは無く、語の数は B の語の数まで）
  const allowedNewB = (table, row) => {
    if (table !== "user_items" || row.kind !== "day" || row.key !== todayKey || row.deleted) return false;
    const p = row.payload ?? {};
    return !p.active && !p.set && !(Number(p.sets) > 0) && Number(p.learned ?? 0) <= B_WORDS.length && Number(p.mastered ?? 0) <= bMastered && Object.keys(p).every((k) => ["learned", "mastered", "active", "set", "sets"].includes(k) || isEmpty(p[k]));
  };

  const aOnlyWords = new Set(A_WORDS.filter((w) => !B_WORDS.includes(w)));
  const answered = new Set([...(result.words?.pre ?? []), ...(result.words?.old ?? [])].filter((w) => !B_WORDS.includes(w)));
  // タブの中の書き込みの記録（lib/storageTap.mjs）: 旧いタブの配信の前の文書（旧いコード）が語の記録へ書いた語と回数も、A が答えた語・A の値に入れる
  // （分離の入った木では、旧いタブの書いた語の記録が数ミリ秒で localStorage から消えるので、答えた後の端末の値には残らない）
  const writes = Array.isArray(result.storageWrites) ? result.storageWrites : [];
  const oldDocOf = (t) => result.tabs?.[t]?.docId ?? null;
  const tapWordWrites = writes.filter((w) => w.op === "set" && w.key === WORD_KEY && OLD_TABS.includes(w.tab) && w.docId && w.docId === oldDocOf(w.tab));
  for (const w of tapWordWrites) for (const id of Object.keys(w.changed ?? {})) if (!B_WORDS.includes(id)) answered.add(id);
  const aWords = new Set([...aOnlyWords, ...answered]); // 読みの条件の参考（info）だけに使う
  // A の語の回数（A のクラウド・A が書いた行・旧いタブで答えた後の端末の値）: [play_count, correct_count, recall_fail]
  const aWordVals = new Map();
  const addWordVal = (id, p, c, r) => {
    if (!id) return;
    if (!aWordVals.has(id)) aWordVals.set(id, []);
    aWordVals.get(id).push([p, c, r]);
  };
  for (const row of seed.word_progress ?? []) if (row.user_id === A) addWordVal(row.word_id, row.play_count, row.correct_count, row.recall_fail);
  for (const r of reqs) {
    if (r.table !== "word_progress" || !WRITE.has(r.method) || r.kind === "offline") continue;
    for (const row of rowsOf(r)) if (row && (r.auth?.who === "A" || row.user_id === A) && row.user_id !== B) addWordVal(row.word_id, row.play_count, row.correct_count, row.recall_fail);
  }
  for (const [id, st] of Object.entries(result.words?.stats ?? {})) addWordVal(id, st?.playCount, st?.correctCount, st?.recallFail);
  for (const w of tapWordWrites) for (const [id, v] of Object.entries(w.changed ?? {})) addWordVal(id, v?.playCount, v?.correctCount, v?.recallFail);
  const aWordHit = (row) => {
    if (aOnlyWords.has(row.word_id)) return `A だけの語 ${row.word_id}`;
    if (!answered.has(row.word_id)) return null;
    const vals = aWordVals.get(row.word_id) ?? [];
    return vals.some(([p, c, r]) => same(row.play_count, p) && same(row.correct_count, c) && same(row.recall_fail, r)) ? `A が答えた語 ${row.word_id}（回数が A の値と同じ）` : null;
  };
  const bWords = new Set(B_WORDS);
  const aStrings = [USERS.A.id, USERS.A.email, A_MARK.myWord, A_MARK.note, A_MARK.name, A_MARK.battleTag];
  const bStrings = [USERS.B.id, USERS.B.email, B_MARK.myWord, B_MARK.note];

  // A の値（書き添えるため）: A が 1 段で書いた行・A のクラウドの行・A の端末の初めの値。表.列 → 値の字の集まり（物の列は中の鍵ごとにも）
  const aValues = new Map();
  const addA = (table, col, v) => {
    if (v === null || v === undefined || isEmpty(v)) return;
    const k = `${table}.${col}`;
    if (!aValues.has(k)) aValues.set(k, new Set());
    aValues.get(k).add(asText(v));
    if (typeof v === "object" && !Array.isArray(v)) for (const [kk, vv] of Object.entries(v)) addA(table, `${col}.${kk}`, vv);
  };
  for (const r of reqs) {
    if (r.phase !== "1-old-A" || r.auth?.who !== "A" || !WRITE.has(r.method) || !r.path?.startsWith("/rest/v1/")) continue;
    for (const row of rowsOf(r)) if (row && typeof row === "object") for (const [c, v] of Object.entries(row)) if (c !== "user_id" && c !== "updated_at") addA(r.table, c, v);
  }
  for (const [t, rows] of Object.entries(seed)) for (const row of rows) if (row.user_id === A) for (const [c, v] of Object.entries(row)) if (c !== "user_id" && c !== "updated_at") addA(t, c, v);
  try {
    const ls = aLocalStorage(seedAt);
    addA("user_progress", "xp", Number(ls.spelldash_xp));
    addA("user_progress", "best_score", Number(ls.spelldash_best_score));
    addA("user_progress", "streak", JSON.parse(ls.spelldash_streak));
  } catch {}
  const aLabel = (table, col, v) => {
    if (v === null || v === undefined) return "";
    if (aValues.get(`${table}.${col}`)?.has(asText(v))) return "・A の値と同じ";
    if (typeof v === "object" && !Array.isArray(v)) {
      const hit = Object.entries(v).filter(([kk, vv]) => !isEmpty(vv) && aValues.get(`${table}.${col}.${kk}`)?.has(asText(vv))).map(([kk]) => kk);
      if (hit.length) return `・${hit.join("・")} が A の値と同じ`;
    }
    return "";
  };

  // B の名前の 1 行を調べる。戻り値: 当たった規則の一覧
  function aInB(table, row, method) {
    const hits = [];
    if (!row || typeof row !== "object") return hits;
    if (row.user_id === A) hits.push(["owner", "行の user_id が A"]);
    for (const s of textHits(row, aStrings)) if (s !== A || row.user_id !== A) hits.push(["text", s]);
    if (DEVICE_TABLES.has(table)) return hits;
    if (table === "word_progress") {
      const w = aWordHit(row);
      if (w) hits.push(["word", w]);
    }
    if (method === "DELETE") {
      hits.push(["seed", `B の ${table} の行を消した（${JSON.stringify(row)}）`]);
      return hits;
    }
    const s = findSeed(table, row);
    if (!s) {
      if (!allowedNewB(table, row)) hits.push(["seed", `${table} ${keyText(table, row)} は B のクラウドに無い行（B は学んでいない）${row.deleted ? "・消した印" : ""}${table === "user_items" ? ` ${JSON.stringify(row.payload ?? null)}` : ""}`]);
      return hits;
    }
    if (row.deleted === true && s.deleted !== true) hits.push(["seed", `${table} ${keyText(table, row)} に消した印`]);
    for (const [col, v, sv] of diffKeys(row, s, (k) => freeCol(table, k) || k === "deleted")) hits.push(["seed", `${table} ${keyText(table, row)} ${col} ${fmt(v)}（B のクラウドは ${fmt(sv)}）${aLabel(table, col, v)}`]);
    return hits;
  }

  function bInA(table, row) {
    const hits = [];
    if (!row || typeof row !== "object") return hits;
    if (row.user_id === B) hits.push(["owner", "行の user_id が B"]);
    for (const s of textHits(row, bStrings)) if (s !== B || row.user_id !== B) hits.push(["text", s]);
    if (table === "word_progress" && bWords.has(row.word_id)) hits.push(["word", `B の語 ${row.word_id}`]);
    if (table === "user_items" && row.kind === "my_word" && row.key === B_MARK.myWord) hits.push(["item", `マイ単語帳 ${row.key}`]);
    return hits;
  }

  const leaks = [];
  const reverse = [];
  const info = [];
  for (const r of reqs) {
    if (!r.path?.startsWith("/rest/v1/") || r.kind === "offline") continue; // 通信断で受け口に届かなかった物は送られていない（旧いコードのタブの分は structural で見る）
    const table = r.table;
    if (!WRITE.has(r.method)) {
      if (r.auth.who === "B") {
        const q = JSON.stringify(r.query);
        const hits = [...aWords].filter((w) => q.includes(w)).concat(aStrings.filter((s) => q.includes(s)));
        if (hits.length) info.push({ seq: r.seq, tab: r.tab, phase: r.phase, table, note: `B の読みの条件に A の印: ${hits.join(",")}` });
      }
      continue;
    }
    for (const row of rowsOf(r)) {
      if (r.auth.who === "B" || row?.user_id === B) {
        const hits = aInB(table, row, r.method);
        if (hits.length) leaks.push({ seq: r.seq, tab: r.tab, phase: r.phase, method: r.method, table, as: r.auth.who ?? r.auth.kind, rowUser: row?.user_id === A ? "A" : row?.user_id === B ? "B" : row?.user_id ?? null, status: r.status, rejected: r.rejected ?? null, hits: hits.map(([k, d]) => `${k}: ${d}`), key: row?.word_id ?? row?.key ?? row?.day ?? null });
      }
      if (r.auth.who === "A" || row?.user_id === A) {
        const hits = bInA(table, row);
        if (hits.length) reverse.push({ seq: r.seq, tab: r.tab, phase: r.phase, method: r.method, table, as: r.auth.who ?? r.auth.kind, status: r.status, rejected: r.rejected ?? null, hits: hits.map(([k, d]) => `${k}: ${d}`), key: row?.word_id ?? row?.key ?? row?.day ?? null });
      }
    }
  }
  const stored = [];
  for (const [table, rows] of Object.entries(result.tables ?? {})) {
    for (const row of rows) {
      if (row.user_id === B) {
        const hits = aInB(table, row, "STORED");
        if (hits.length) stored.push({ table, user: "B", key: row.word_id ?? row.key ?? row.day ?? null, hits: hits.map(([k, d]) => `${k}: ${d}`) });
      }
      if (row.user_id === A) {
        const hits = bInA(table, row);
        if (hits.length) stored.push({ table, user: "A", key: row.word_id ?? row.key ?? null, hits: hits.map(([k, d]) => `${k}: ${d}`) });
      }
    }
  }
  if (result.tables) {
    for (const [table, rows] of Object.entries(bSeed)) {
      for (const s of rows) {
        const keyCols = PK[table] ?? [];
        if (!(result.tables[table] ?? []).some((r) => r.user_id === B && keyCols.every((c) => asText(r[c]) === asText(s[c])))) stored.push({ table, user: "B", key: keyText(table, s), hits: [`seed: B の初めの行が消えた`] });
      }
    }
  }

  // ---- 旧いタブ: どれが旧いコードのままだったか・なぜか ----
  const deployAt = result.deployAt ?? result.timeline?.find((e) => /配信を新しい木に替えた/.test(e.msg))?.t ?? Infinity;
  const tabNames = OLD_TABS.filter((t) => result.tabs?.[t]);
  // 配信の後に新しい文書が始まった時刻（文書の印。古い記録には無いので load で代える）
  const newDocAt = Object.fromEntries(tabNames.map((t) => {
    const starts = (result.docStarts ?? []).filter((d) => d.tab === t && d.t >= deployAt).map((d) => d.t);
    const fromLoads = result.docStarts ? [] : (result.loads ?? []).filter((l) => l.tab === t && l.t >= deployAt).map((l) => l.t);
    const all = [...starts, ...fromLoads];
    return [t, all.length ? Math.min(...all) : Infinity];
  }));
  const isOldCode = (r) => tabNames.includes(r.tab) && (r.at ?? 0) < newDocAt[r.tab];
  const swOn = result.sw !== false;
  const fate = Object.fromEntries(tabNames.map((t) => {
    const tab = result.tabs[t];
    const url = tab.url ?? "";
    const blocked = (result.reloadBlocked ?? []).filter((b) => b.keep === t);
    const inDoc = (result.navs ?? []).filter((n) => n.tab === t && n.t >= deployAt && n.t < newDocAt[t]);
    let why;
    if (newDocAt[t] !== Infinity) why = `配信の後に新しい文書が始まった（読み直し）。${new Date(newDocAt[t]).toISOString()} からは新しいコード`;
    else if (!swOn) why = "Service Worker なしの回（読み直す物が無い）";
    else if (blocked.length) why = `新しい sw.js が読み直そうとした（${blocked.length} 回）が、検査が止めた（読み直しの届かないタブの代わり。lib/server.mjs の oldtab-keep）`;
    else if (/#/.test(url) && inDoc.length) why = `URL に # があり、読み直しは同じ文書の中の移動になった（${inDoc.length} 回）`;
    else if (/oldtab-keep=/.test(url)) why = "読み直しの試みが無かった（読み直しの届かないタブの印あり）";
    else if (/#/.test(url)) why = "読み直しの試みが無かった（URL に # がある）";
    else why = "読み直しの試みが無かった（新しい木の sw.js は開いている窓を読み直さない）";
    return [t, { stayedOld: newDocAt[t] === Infinity, why, url, controlled: tab.swBeforeDeploy?.controlled ?? null, keep: KEEP_TABS.includes(t), reloadBlocked: blocked.length, sameDocNavs: inDoc.length }];
  }));
  const stillOld = tabNames.filter((t) => fate[t].stayedOld);

  // ---- 旧いコードのタブの決まり: B として動いたら漏れ ----
  const bLoginAt = reqs.find((r) => r.kind === "auth:verify" && r.who === "B")?.at ?? Infinity;
  // B にログインしない回（--login none）: 「その後」の基準は、見えたままの旧いタブの止めていた更新を通した時（書き戻しの後）
  const noLogin = result.login === "none";
  const pivotAt = noLogin ? result.refreshRace?.releasedAt ?? result.deployAt ?? Infinity : bLoginAt;
  const structural = [];
  for (const r of reqs) {
    if (!isOldCode(r)) continue;
    const rowUsers = r.rowUserIds ?? rowsOf(r).map((x) => x?.user_id);
    const why = [];
    if (r.auth?.who === "B") why.push("B のトークンで要求した");
    if (r.who === "B" && /^auth:/.test(r.kind ?? "")) why.push(`B のセッションで ${r.kind}`);
    if (rowUsers.includes(B)) why.push("行の user_id が B");
    if (why.length) structural.push({ seq: r.seq, tab: r.tab, phase: r.phase, method: r.method, path: r.path, status: r.status, offline: r.kind === "offline", hits: why.map((w) => `old-as-B: ${w}${r.kind === "offline" ? "（通信断で届かなかった）" : ""}`) });
  }
  for (const t of tabNames) {
    const g = (result.tabs[t].forced ?? []).find(([k]) => k === "getSession");
    if (g && g[1] === USERS.B.email) structural.push({ tab: t, phase: "4-forced", hits: ["old-as-B: 旧いモジュールの getSession が B を返した"] });
  }
  for (const c of result.oldKeyChecks ?? []) if (c.who === "B") structural.push({ tab: c.via, phase: c.phase, hits: [`old-as-B: 旧い認証の鍵に B のセッション（${c.label}）`] });
  // 旧い認証の鍵の書き込みの知らせ（旧いタブ 2 つで聞いた）。節目の読みの間に置かれてすぐ消えた B のセッションも見る
  for (const e of result.oldKeyEvents ?? []) if (e.who === "B") structural.push({ tab: e.via, phase: "知らせ", hits: [`old-as-B: 旧い認証の鍵に B のセッションが書かれた（${new Date(e.t).toISOString()}・${e.via} が聞いた）`] });

  // ---- A の記録の後退（integrity） ----
  // A の行ごとの「それまでの値」（floor）: A のクラウドの初めの値・A の端末の初めの値から始め、A の名前の書き込みで後退しなかった物を重ねる（数え上げは大きい方）
  const MONO = {
    word_progress: ["play_count", "correct_count", "typing_miss", "recall_fail"],
    user_progress: ["xp", "best_score", "battle_wins", "battle_losses", "battle_draws", "battle_best_win_streak"],
    activity_days: ["study_correct", "challenge_runs", "battle_runs"]
  };
  const BATTLE_COUNTS = ["battle_wins", "battle_losses", "battle_draws"];
  // 写しの列と既定の値（旧いコードの pushUserProgress が空の端末で送る値）。A の値がこれと違うのに既定に戻ったら後退
  const SNAPSHOT_DEFAULTS = { user_progress: { selected_category: "all", selected_mode: "study" } };
  const floorKey = (table, row) => `${table}|${keyText(table, row)}`;
  const floors = new Map();
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  const dayDiff = (a, b) => (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000;
  function regressions(table, row, f, { oldCode = false } = {}) {
    const out = [];
    if (!f) return out;
    for (const c of MONO[table] ?? []) {
      if (!(c in row) || num(f[c]) === null) continue;
      if (num(row[c]) === null || num(row[c]) < num(f[c])) out.push(`${c} ${fmt(row[c])}（それまで ${fmt(f[c])}）`);
    }
    // 写しの列が既定の値に戻った（設定の写し）。旧いコードのタブが移行の後の空の端末の値を送る形だけを見る（新しいコードが設定を書き直すのは製品の決まり）
    if (oldCode) for (const [c, def] of Object.entries(SNAPSHOT_DEFAULTS[table] ?? {})) {
      if (!(c in row) || isEmpty(f[c]) || f[c] === def) continue;
      if (isEmpty(row[c]) || row[c] === def) out.push(`${c} ${fmt(row[c])}（それまで ${fmt(f[c])}・既定に戻った）`);
    }
    if (table === "word_progress" && "last_played" in row && typeof f.last_played === "string") {
      if (!row.last_played) out.push(`last_played ${fmt(row.last_played)}（それまで ${fmt(f.last_played)}・既定に戻った）`);
      else if (Date.parse(row.last_played) < Date.parse(f.last_played) - 5000) out.push(`last_played ${fmt(row.last_played)}（それまで ${fmt(f.last_played)}・前へ戻った）`);
    }
    if (table === "user_progress") {
      const st = row.streak, fs0 = f.streak;
      if ("streak" in row && fs0 && typeof fs0 === "object") {
        if (!st || typeof st !== "object") out.push(`streak ${fmt(st)}（それまで ${fmt(fs0)}）`);
        else {
          if (num(fs0.best) !== null && (num(st.best) ?? 0) < num(fs0.best)) out.push(`streak.best ${fmt(st.best)}（それまで ${fmt(fs0.best)}）`);
          if (num(fs0.current) !== null && (num(st.current) ?? 0) < num(fs0.current) && st.last && fs0.last && dayDiff(fs0.last, st.last) <= 1) out.push(`streak.current ${fmt(st.current)}（それまで ${fmt(fs0.current)}・日は続いている ${fs0.last}→${st.last}）`);
        }
      }
      // Battle をしていない（勝ち・負け・引き分けの数が同じ）のに RP・連勝が変わった
      const counts = (o) => BATTLE_COUNTS.reduce((a, c) => a + (num(o[c]) ?? 0), 0);
      const played = counts({ ...f, ...Object.fromEntries(BATTLE_COUNTS.filter((c) => c in row).map((c) => [c, row[c]])) }) > counts(f);
      for (const c of ["battle_rp", "battle_current_win_streak"]) if (c in row && num(f[c]) !== null && !played && num(row[c]) !== num(f[c])) out.push(`${c} ${fmt(row[c])}（それまで ${fmt(f[c])}・Battle をしていない）`);
    }
    if (table === "user_items") {
      if (row.deleted === true && f.deleted === false) out.push(`${row.kind}:${row.key} に消した印`);
      if ("payload" in row && f.payload && typeof f.payload === "object") {
        const p = row.payload && typeof row.payload === "object" ? row.payload : {};
        if (row.kind === "day") {
          for (const c of ["learned", "mastered", "sets"]) if (num(f.payload[c]) !== null && (num(p[c]) ?? 0) < num(f.payload[c])) out.push(`day ${row.key} の ${c} ${fmt(p[c])}（それまで ${fmt(f.payload[c])}）`);
          if (f.payload.active === true && p.active !== true) out.push(`day ${row.key} の active ${fmt(p.active)}（それまで true）`);
        } else if (!isEmpty(f.payload) && isEmpty(Object.fromEntries(Object.entries(p).filter(([, v]) => !isEmpty(v))))) out.push(`${row.kind}:${row.key} の中身が空 ${fmt(row.payload)}`);
      }
    }
    if (table === "activity_days" && f.daily_done === true && "daily_done" in row && row.daily_done !== true) out.push(`daily_done ${fmt(row.daily_done)}（それまで true）`);
    if (table === "profiles" && "display_name" in row && !isEmpty(f.display_name) && isEmpty(row.display_name)) out.push(`display_name ${fmt(row.display_name)}（それまで ${fmt(f.display_name)}）`);
    return out;
  }
  function mergeFloor(table, row) {
    const k = floorKey(table, row);
    const f = floors.get(k) ?? {};
    for (const [c, v] of Object.entries(row)) {
      if (c === "user_id" || c === "updated_at") continue;
      if ((MONO[table] ?? []).includes(c)) {
        if (num(v) !== null && (num(f[c]) === null || num(v) > num(f[c]))) f[c] = v;
      } else if (table === "user_items" && c === "payload" && row.kind === "day" && v && typeof v === "object") {
        const fp = { ...(f.payload ?? {}) };
        for (const [pc, pv] of Object.entries(v)) {
          if (typeof pv === "number") fp[pc] = Math.max(pv, Number(fp[pc] ?? -Infinity));
          else if (pc === "active") fp[pc] = fp[pc] === true || pv === true;
          else fp[pc] = pv;
        }
        f.payload = fp;
      } else if (table === "user_progress" && c === "streak" && v && typeof v === "object") {
        const o = f.streak && typeof f.streak === "object" ? f.streak : {};
        f.streak = { ...o, ...v, best: Math.max(num(v.best) ?? 0, num(o.best) ?? 0) };
      } else if (c === "daily_done") f[c] = f[c] === true || v === true;
      else if (table === "word_progress" && c === "last_played") f[c] = typeof f[c] === "string" && (!v || Date.parse(v) < Date.parse(f[c])) ? f[c] : v;
      else f[c] = v;
    }
    floors.set(k, f);
  }
  const integrity = [];
  {
    for (const [t, rows] of Object.entries(seed)) for (const row of rows) if (row.user_id === A) mergeFloor(t, row);
    // A の端末の初めの値（旧い形）
    try {
      const ls = aLocalStorage(seedAt);
      const st = JSON.parse(ls.spelldash_streak);
      const bt = JSON.parse(ls.spelldash_battle);
      mergeFloor("user_progress", { xp: Number(ls.spelldash_xp), best_score: Number(ls.spelldash_best_score), streak: { current: st.current, best: st.best, last: st.last }, battle_rp: bt.rp, battle_wins: bt.wins, battle_losses: bt.losses, battle_draws: bt.draws, battle_current_win_streak: bt.currentWinStreak, battle_best_win_streak: bt.bestWinStreak });
      for (const g of JSON.parse(ls.spelldash_growth_log)) mergeFloor("user_items", { kind: "day", key: g.date, payload: { learned: g.learned, mastered: g.mastered, active: g.active } });
      const act = JSON.parse(ls.spelldash_activity);
      mergeFloor("activity_days", { day: act.date, study_correct: act.studyCorrect, challenge_runs: act.challengeRuns, battle_runs: act.battleRuns, daily_done: act.dailyDone });
    } catch {}
    const ordered = [...reqs].sort((x, y) => (x.seq ?? 0) - (y.seq ?? 0));
    for (const r of ordered) {
      if (!r.path?.startsWith("/rest/v1/") || !WRITE.has(r.method) || r.kind === "offline" || DEVICE_TABLES.has(r.table)) continue;
      if (!(typeof r.status === "number" && r.status < 400)) continue; // 受け口が断った物はクラウドを変えていない
      const afterDeploy = (r.at ?? 0) >= deployAt;
      for (const row of rowsOf(r)) {
        if (!row || typeof row !== "object") continue;
        const mine = row.user_id === A || (r.auth?.who === "A" && row.user_id !== B);
        if (!mine) continue;
        const k = floorKey(r.table, row);
        if (r.method === "DELETE") {
          if (afterDeploy && floors.has(k)) integrity.push({ seq: r.seq, tab: r.tab, phase: r.phase, table: r.table, key: keyText(r.table, row), oldCode: isOldCode(r), hits: [`A の行を消した（${JSON.stringify(row)}）`] });
          continue;
        }
        const hits = afterDeploy ? regressions(r.table, row, floors.get(k), { oldCode: isOldCode(r) }) : [];
        if (hits.length) integrity.push({ seq: r.seq, tab: r.tab, phase: r.phase, table: r.table, key: keyText(r.table, row), oldCode: isOldCode(r), hits });
        else mergeFloor(r.table, row);
      }
    }
    if (result.tables) {
      for (const [table, rows] of Object.entries(result.tables)) {
        if (DEVICE_TABLES.has(table)) continue;
        for (const row of rows) {
          if (row.user_id !== A) continue;
          const hits = regressions(table, row, floors.get(floorKey(table, row)));
          if (hits.length) integrity.push({ stored: true, table, key: keyText(table, row), hits: hits.map((h) => `表: ${h}`) });
        }
      }
      for (const [table, rows] of Object.entries(seed)) {
        for (const s of rows) {
          if (s.user_id !== A || !PK[table] || !(table in result.tables)) continue; // 記録に無い表（作った記録）は見ない
          if (!(result.tables[table] ?? []).some((r) => r.user_id === A && PK[table].every((c) => asText(r[c]) === asText(s[c])))) integrity.push({ stored: true, table, key: keyText(table, s), hits: ["表: A の初めの行が消えた"] });
        }
      }
    }
  }

  // ---- 検査が 5 段を本当に通ったか（通っていなければ「漏れなし」と言えない） ----
  const reached = new Set((result.reached ?? []).map((x) => x.phase));
  const fz = result.freeze ?? {};
  const unfreezeAt = result.unfreezeAt ?? Infinity;
  const frozenReqs = reqs.filter((r) => r.tab === "old-frozen" && /^[23]/.test(r.phase)).length;
  const frozenPageReqs = (result.pageRequests ?? []).filter((p) => p.tab === "old-frozen" && !p.nav && p.t >= (fz.at ?? Infinity) && p.t < unfreezeAt).length;
  const notExercised = [];
  const frozenKey = "1-3 old-frozen は 2・3 段のあいだ凍っていた（同じ文書の検査の時計が止まり・読み直されず・受け口への要求もページの取得も 0）";
  const offlineKey = "1-3 old-offline は 2・3 段のあいだ受け口に届かず、読み直されなかった";
  if (fz.mode === "off") notExercised.push(frozenKey);
  if (noLogin) notExercised.push("3 B へのログイン（B にログインしない回。止めていた更新の書き戻しの後に旧いタブを戻す）");
  // 古い部品（書き戻す版）を旧いタブに読ませた回で、書き戻しが起きなかった（受け口の答えの時に旧い鍵が A に戻らなかった）
  // 書き戻しは書き込みの知らせで見る（writeBackSeen。知らせの無い古い記録は通した後の読みで）
  const writeBackSeen = result.refreshRace?.writeBackSeen ?? result.refreshRace?.oldKeyAfterRelease === "A";
  const writeBackKey = "2 古い部品の書き戻しが起きた（止めていた更新を通した後に、旧いタブの部品が A のセッションを旧い鍵へ書いた。--expect-writeback の回）";
  if (result.oldAuthLib && result.refreshRace?.held && !writeBackSeen) notExercised.push(`2 古い部品の書き戻し（止めていた更新を通した後に旧い鍵へ A が書かれなかった。通した後の読み ${result.refreshRace?.oldKeyAfterRelease ?? "空"}）`);
  const oldRefreshAfterLogin = reqs.filter((r) => isOldCode(r) && r.kind === "auth:token:refresh_token" && (r.at ?? 0) > pivotAt);
  const oldNoSession = stillOld.length > 0 && stillOld.every((t) => {
    const g = (result.tabs[t].forced ?? []).find(([k]) => k === "getSession");
    return !TAB_MODULES[t]?.includes("/js/supabase.js") || (g && g[1] === null);
  });
  // ログインしない回は、旧いタブを戻した 4 段からの読み（書き戻しの直後の読みは、その後に新しいコードが片付けたかを言わない）
  const keyAfterLogin = (result.oldKeyChecks ?? []).filter((c) => c.t > pivotAt && (!noLogin || /^[45]/.test(c.phase ?? "")));
  const oldKeyAbsent = keyAfterLogin.length > 0 && keyAfterLogin.every((c) => c.who === null);
  const refreshBranch = oldRefreshAfterLogin.length ? "attempted" : oldNoSession && oldKeyAbsent ? "no-session" : "none";
  const rr = result.refreshRace ?? {};
  const visFail = (result.visErrors ?? []).filter((e) => tabNames.includes(e.tab) && (fate[e.tab]?.stayedOld || e.t < newDocAt[e.tab] - 3000));
  // 旧い画面の答え: 旧いコードのまま残った old-live・old-frozen のどれもが、答えのたびに、そのタブの中で語の記録を書いた（タブごと・答えごと）。
  // 書き込みの記録（lib/storageTap.mjs）は、そのタブの配信の前の文書（tabs[t].docId。旧いコード）の物だけを数える。答えの窓（打ち始めてから、
  // 次の語に替わって落ち着くまで。[typingAt, t1 + 0.3 秒]）に、
  // 答えた語か、答えた後に画面に出た次の語の記録の変化があれば、その答えは書かれた。旧いコードは、端末の語の記録にその語が無いと答えた語の記録を書かず
  // （0507672 の js/stats.js の recordCorrect は記録の無い語で何もしない）、次の語を出す時の記録（recordPlay）だけを書く。分離の入った木では、移行の後の
  // 旧い場所の語の記録は空で、旧いタブが書いた物も見張りがすぐ片付けるので、こちらになる。分離の前の木では答えた語そのものが書かれる。
  // この文書に包みの印（install）が無い記録（書き込みの記録を始める前の記録）だけは、前の決まり（答えた後に端末の語の記録が変わった）で見る
  const ANSWER_TABS = ["old-live", "old-frozen"];
  const answerTabs = ANSWER_TABS.filter((t) => stillOld.includes(t));
  const ANSWER_SLACK_MS = 300;
  // 答えに数えるのは、打った後に画面が次の語へ進んだ物だけ（訳が替わった: ja !== jaAfter。記録に訳の無い古い形は ok だけで見る）
  const advancedAnswer = (a) => !!a?.ok && (a.ja === undefined || a.jaAfter === undefined || (a.jaAfter !== "" && a.jaAfter !== a.ja));
  const startOf = (a) => (Number.isFinite(a?.typingAt) ? a.typingAt : a?.t0);
  const countedWrites = []; // 数えた答えの窓の中の書き込み（A へ取り込む量の下限に使う）
  const answeredBy = Object.fromEntries(ANSWER_TABS.map((t) => {
    const tab = result.tabs?.[t] ?? {};
    const answers = tab.answers ?? [];
    const okAnswers = answers.filter(advancedAnswer);
    const doc = oldDocOf(t);
    const mine = writes.filter((w) => w.tab === t && doc && w.docId === doc);
    const installed = mine.some((w) => w.op === "install");
    const words = mine.filter((w) => w.op === "set" && w.key === WORD_KEY);
    const perAnswer = okAnswers.map((a) => {
      const from = startOf(a);
      // 窓の終わり = min(落ち着いた時 t1 + 0.3 秒, 同じタブの次の答えの打ち始め)。次の答えの書き込みをこの答えに数えない
      const i = answers.indexOf(a);
      const later = answers.slice(i + 1).map(startOf).find((x) => Number.isFinite(x));
      const to = Math.min(Number.isFinite(a.t1) ? a.t1 + ANSWER_SLACK_MS : -Infinity, Number.isFinite(later) ? later : Infinity);
      const inWin = Number.isFinite(from) && Number.isFinite(a.t1) ? words.filter((w) => w.t >= from && w.t <= to && (!Number.isFinite(later) || w.t < later) && w.t >= deployAt) : [];
      const ids = [...new Set(inWin.flatMap((w) => Object.keys(w.changed ?? {})))];
      const answeredHit = (a.ids ?? []).some((id) => ids.includes(id));
      const nextHit = (a.nextIds ?? []).some((id) => ids.includes(id));
      if ((answeredHit || nextHit) && stillOld.includes(t)) for (const w of inWin) if (!countedWrites.includes(w)) countedWrites.push(w);
      return { en: a.en ?? null, writes: inWin.length, ids, answered: answeredHit, next: nextHit, ok: answeredHit || nextHit, windowEnd: to };
    });
    const mode = installed ? "tap" : "local";
    const pass = mode === "tap" ? okAnswers.length > 0 && perAnswer.every((x) => x.ok) : okAnswers.length > 0 && Array.isArray(tab.changed) && tab.changed.length > 0;
    return [t, { stillOld: stillOld.includes(t), ok: okAnswers.length, mode, pass, wordWrites: words.filter((w) => w.t >= deployAt).length, perAnswer, changed: tab.changed ?? null, reasons: answers.filter((a) => !a.ok).map((a) => a.reason ?? "?") }];
  }));
  // 新しいコードの文書を開き直した（4 段の答えの後・旧いタブを閉じた後。移行の後に旧いタブが旧い鍵へ書いた値を、新しいコードが次の読み込みでどう扱うかを見る）
  const reloads = result.reloads ?? [];
  // 旧い場所から片付けた語の記録が IndexedDB の orphans に届いたか（orphans のある木。新しいコードのタブで、4 段の後と閉じた後の開き直しの終わりに読んだ）。
  // 4 段より後に旧いコードのタブが語の記録へ書いた値（digest）か、書いた語の回数が、最後に読めた orphans にあるか。届いた数を出す。
  // 1 つも届かない・orphans を読めない（DB か置き場が無い）ときだけ 5 段の確かめに当てる（新しいコードが旧いタブの答えを残さず消した形）
  const step4At = (result.reached ?? []).find((x) => x.phase === "4-revive-old")?.t ?? Infinity;
  const oldWordWrites = tapWordWrites.filter((w) => w.t >= step4At);
  const orphanReads = reloads.filter((r) => r.orphans).map((r) => ({ label: r.label, ...r.orphans }));
  const okReads = orphanReads.filter((o) => !o.error && o.storeExists === true);
  const lastRead = okReads[okReads.length - 1] ?? null;
  const orphanWord = (lastRead?.records ?? []).map((rec) => rec?.keys?.[WORD_KEY]).filter(Boolean);
  const orphanDigests = new Set(orphanWord.map((e) => e.digest).filter(Boolean));
  const writesFound = oldWordWrites.filter((w) => w.digest && orphanDigests.has(w.digest));
  const lastWritten = new Map();
  for (const w of oldWordWrites) for (const [id, v] of Object.entries(w.changed ?? {})) lastWritten.set(id, v);
  const wordInOrphans = (id, v) => orphanWord.some((e) => {
    const o = e.words?.[id];
    return !!o && same(o.playCount, v?.playCount) && same(o.correctCount, v?.correctCount) && same(o.recallFail, v?.recallFail);
  });
  const wordsFound = [...lastWritten].filter(([id, v]) => wordInOrphans(id, v)).map(([id]) => id);
  // タブごとの最後の書き込みが届いたか: 値（digest）が同じ写しがある、または、その書き込みで変わった語の回数がどれも写しにある
  // （2 つのタブの書き込みが 1 回の片付けにまとまると、前の値の digest は残らない）
  const writeReached = (w) => !!w && ((w.digest && orphanDigests.has(w.digest)) || (Object.keys(w.changed ?? {}).length > 0 && Object.entries(w.changed).every(([id, v]) => wordInOrphans(id, v))));
  const orphansApplies = result.orphansTree?.has === true && oldWordWrites.length > 0;
  const lastRaw = reloads.length ? reloads[reloads.length - 1].rawAfter ?? null : null;
  const orphansSummary = {
    treeHasOrphans: result.orphansTree?.has ?? null,
    applies: orphansApplies,
    reads: orphanReads.map((o) => ({ label: o.label, dbExists: o.dbExists ?? null, storeExists: o.storeExists ?? null, records: o.records?.length ?? 0, error: o.error ?? null })),
    oldWordWrites: oldWordWrites.length,
    writesFound: writesFound.length,
    lastWriteFound: Object.fromEntries(OLD_TABS.map((t) => {
      const ws = oldWordWrites.filter((w) => w.tab === t);
      return ws.length ? [t, writeReached(ws[ws.length - 1])] : null;
    }).filter(Boolean)),
    wordsWritten: [...lastWritten.keys()],
    wordsFound,
    wordsMissing: [...lastWritten.keys()].filter((id) => !wordsFound.includes(id)),
    localKeptAtEnd: Array.isArray(lastRaw) ? lastRaw.includes(WORD_KEY) : null
  };
  const orphansKey = "4 移行の後に旧いコードのタブが旧い場所へ書いた語の記録は、片付けで IndexedDB の orphans に届いた（orphans のある木。届いた数は summary。1 つも届かない・orphans を読めない・答えを数えたタブの最後の書き込みが届かないときは通さない）";
  // 答えを数えたタブ（旧いコードのまま残った old-live・old-frozen で 4 段より後に語の記録を書いたタブ）は、どれも最後の書き込みが orphans に届いたこと
  const countedTabs = answerTabs.filter((t) => oldWordWrites.some((w) => w.tab === t));
  const lastReachedByTab = Object.fromEntries(countedTabs.map((t) => {
    const ws = oldWordWrites.filter((w) => w.tab === t);
    return [t, writeReached(ws[ws.length - 1])];
  }));
  // ---- A へ戻る段（docs/SPEC_ACCOUNT_AREAS.md §0.3 の 1。orphans のある木で、その段を流した記録だけ。古い記録・分離の前の木には無い） ----
  // 旧いタブが 4 段で答えた学習（数えた答えの窓の書き込み）が、A へ戻った時に A の領域の語の記録・送る語の印・A のクラウドの行・学習状況の画面に
  // 入ったか（NOT_IMPORTED）、2 度入っていないか（DOUBLE）、B（とゲスト）の領域に一度も入っていないか（LEAK）を見る。
  // 量: 旧いタブの書き込みごとに、語ごとの「書いた値 − 書く前の値」（lib/storageTap.mjs の prev）を足す。数えた答えの窓の書き込みの和が下限（need）、
  //   配信の後の旧いコードの文書の語の記録の書き込み全部の和が上限（allowed。ふつうは同じ）。
  //   A へ戻った後の値 − A の初めの値（3 段の後の A の控え。B にログインしない回は A の localStorage）が [need, allowed] に入ること（回数 3 つ）、
  //   最後に答えた時刻が旧いタブの書いた時刻より前でないこと。足りなければ NOT_IMPORTED（A の値を旧いタブの値で置き換えた形もここ）、多ければ DOUBLE。
  //   2 回目に戻った後も同じ値（増えたら DOUBLE。1 回目に足りず 2 回目に入った物は NOT_IMPORTED のまま「2 回目に入った」と書く）
  const ret = result.returnA ?? null;
  const importApplies = result.orphansTree?.has === true && !!ret;
  const areaLeaks = [];
  let imports = null;
  const importValidity = {};
  if (importApplies) {
    const F = ["playCount", "correctCount", "recallFail"];
    const n0 = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
    const tms = (v) => (typeof v === "string" ? Date.parse(v) : Number.isFinite(v) ? v : NaN);
    const sumDeltas = (ws) => {
      const out = {};
      for (const w of ws) {
        for (const [id, v] of Object.entries(w.changed ?? {})) {
          const o = (out[id] ??= { playCount: 0, correctCount: 0, recallFail: 0, lastPlayed: null, written: null, writes: 0, prevUnknown: 0 });
          const known = v?.prev !== undefined || v?.isNew === true;
          if (!known) o.prevUnknown++;
          for (const f of F) o[f] += n0(v?.[f]) - (known ? n0(v?.prev?.[f]) : 0);
          if (v?.lastPlayed && (!o.lastPlayed || tms(v.lastPlayed) > tms(o.lastPlayed))) o.lastPlayed = v.lastPlayed;
          o.written = { playCount: v?.playCount ?? null, correctCount: v?.correctCount ?? null, recallFail: v?.recallFail ?? null };
          o.writes++;
        }
      }
      return out;
    };
    const need = sumDeltas(countedWrites);
    const allowedWrites = tapWordWrites.filter((w) => w.t >= deployAt);
    const allowed = sumDeltas(allowedWrites);
    const areaA = `u:${A}`;
    const areaB = `u:${B}`;
    const snaps = result.areaSnaps ?? [];
    const snap = (label) => snaps.find((x) => x.label === label) ?? null;
    // その時の領域の語の記録（index が ls を指せば localStorage、idb:<id> を指せばその控え）
    const wordsOf = (sn, area) => {
      if (!sn) return null;
      const at = sn.index?.[area]?.at;
      const inLs = sn.ls?.[area]?.words;
      if (at === "ls" && inLs && typeof inLs === "object") return { from: "ls", words: inLs, dirty: sn.ls?.[area]?.dirty ?? null };
      const rec = (sn.idb?.records ?? []).find((r) => r.area === area && typeof at === "string" && at === `idb:${r.id}`);
      if (rec && rec.words && typeof rec.words === "object") return { from: "idb", words: rec.words, dirty: rec.dirty ?? null };
      if (inLs && typeof inLs === "object") return { from: "ls(index なし)", words: inLs, dirty: sn.ls?.[area]?.dirty ?? null };
      return null;
    };
    const prior = wordsOf(snap("after-step3"), areaA);
    const after1 = wordsOf(snap("return1"), areaA);
    const after2 = wordsOf(snap("return2"), areaA);
    const retStart = ret.first?.t0 ?? ret.start ?? Infinity;
    const aWrites = (result.areaWrites ?? []).filter((e) => e.area === areaA && e.t >= retStart);
    const pushRows = reqs.filter((r) => (r.at ?? 0) >= retStart && r.table === "word_progress" && WRITE.has(r.method) && r.auth?.who === "A" && typeof r.status === "number" && r.status < 400).flatMap((r) => rowsOf(r)).filter((row) => row?.user_id === A);
    const finalRow = (id) => (result.tables?.word_progress ?? []).find((r) => r.user_id === A && r.word_id === id) ?? null;
    const stateOf = (w) => (w && (w.ls === 1 || w.ls === 2) ? w.ls : 0);
    // A の初めの値に 3 状態の欄（ls）が 1 語も無ければ、その写しはスキーマ 7 の移行の前（--order direct-link の A の控えは、A が新しいコードで一度も開かれていない）。
    // 初めの状態が分からないので、keep の決まりは当てない（関数には priorStates: false で渡す）
    const priorStates = !!prior?.words && Object.values(prior.words).some((v) => v && (v.ls === 1 || v.ls === 2));
    const rule = opts.importState ?? "report";
    const missing = [];
    const double = [];
    const perWord = {};
    const ids = [...new Set([...Object.keys(need), ...Object.keys(allowed)])].sort();
    for (const id of ids) {
      const lo = need[id] ?? { playCount: 0, correctCount: 0, recallFail: 0, lastPlayed: null, written: null };
      const hi = allowed[id] ?? lo;
      const p = prior?.words?.[id] ?? null;
      const a1 = after1?.words?.[id] ?? null;
      const a2 = after2?.words?.[id] ?? null;
      const counted = !!need[id];
      const w = { counted, need: Object.fromEntries(F.map((f) => [f, lo[f]])), allowed: Object.fromEntries(F.map((f) => [f, hi[f]])), written: lo.written ?? hi.written, writtenLastPlayed: lo.lastPlayed ?? hi.lastPlayed ?? null, prior: p, after1: a1, after2: a2, pub: a1?.pub ?? p?.pub ?? null, problems1: [], problems2: [] };
      const judge = (a, into) => {
        for (const f of F) {
          const got = n0(a?.[f]) - n0(p?.[f]);
          if (got < lo[f]) into.push({ kind: "missing", f, got, need: lo[f], replaced: !!a && w.written && n0(a[f]) === n0(w.written[f]) && n0(p?.[f]) > 0 });
          else if (got > hi[f]) into.push({ kind: "double", f, got, allowed: hi[f] });
        }
        if (counted && lo.lastPlayed && (!a?.lastPlayed || tms(a.lastPlayed) < tms(lo.lastPlayed) - 1000)) into.push({ kind: "missing", f: "lastPlayed", got: a?.lastPlayed ?? null, need: lo.lastPlayed });
      };
      if (after1) judge(a1, w.problems1);
      if (after2) judge(a2, w.problems2);
      // 2 回目: 1 回目に入っていた値から動かない（回数が増えたら 2 度目の取り込み）
      if (after1 && after2 && w.problems1.length === 0) for (const f of F) if (n0(a2?.[f]) !== n0(a1?.[f])) w.problems2.push({ kind: n0(a2?.[f]) > n0(a1?.[f]) ? "double" : "missing", f, got: n0(a2?.[f]) - n0(p?.[f]), after1: n0(a1?.[f]), after2: n0(a2?.[f]), second: true });
      // 送る語の印（送信待ち）: 1 回目に戻った後、A の送る語の印にこの語が入った（見張りの知らせ・その時の読み）、または A の名前の送信にこの語が A の値で載った
      const sentRow = pushRows.find((row) => row.word_id === id && F.every((f) => n0(row[f === "playCount" ? "play_count" : f === "correctCount" ? "correct_count" : "recall_fail"]) === n0(a1?.[f])));
      w.pending = { dirtySeen: aWrites.some((e) => e.name === "dirty_words" && Array.isArray(e.dirty) && e.dirty.includes(id)) || (Array.isArray(after1?.dirty) && after1.dirty.includes(id)), sent: !!sentRow };
      const c1 = (ret.cloud1 ?? []).find((r) => r.word_id === id) ?? null;
      const cEnd = finalRow(id);
      w.cloud = { afterReturn: c1 ? { play_count: c1.play_count, correct_count: c1.correct_count, recall_fail: c1.recall_fail, last_played: c1.last_played } : null, end: cEnd ? { play_count: cEnd.play_count, correct_count: cEnd.correct_count, recall_fail: cEnd.recall_fail, last_played: cEnd.last_played } : null };
      const cloudSame = (c) => !!c && n0(c.play_count) === n0(a1?.playCount) && n0(c.correct_count) === n0(a1?.correctCount) && n0(c.recall_fail) === n0(a1?.recallFail);
      if (counted && after1 && w.problems1.length === 0) {
        if (!w.pending.dirtySeen && !w.pending.sent) w.problems1.push({ kind: "missing", f: "送信待ち", got: "送る語の印にも A の送信にも無い" });
        if (!cloudSame(w.cloud.afterReturn)) w.problems1.push({ kind: "missing", f: "A のクラウド", got: w.cloud.afterReturn, need: { play_count: a1?.playCount, correct_count: a1?.correctCount, recall_fail: a1?.recallFail } });
      }
      if (counted && after1 && w.cloud.afterReturn && w.cloud.end && n0(w.cloud.end.play_count) > n0(w.cloud.afterReturn.play_count) && w.problems1.length === 0) w.problems2.push({ kind: "double", f: "A のクラウド", got: w.cloud.end.play_count, after1: w.cloud.afterReturn.play_count, second: true });
      // 3 状態: 値は出す。決まり（opts.importState）があれば当てる
      w.state = { prior: stateOf(p), after1: stateOf(a1), after2: stateOf(a2), priorStates };
      if (counted && after1) {
        let expected = null;
        if (rule === "keep") expected = priorStates ? stateOf(p) : null;
        else if (typeof rule === "function") {
          try {
            expected = rule({ id, prior: p, after: a1, need: w.need, written: w.written, pub: w.pub, priorStates });
          } catch (e) {
            expected = null;
            w.stateRuleError = String(e).slice(0, 200);
          }
        }
        w.state.expected = expected;
        if (expected !== null && expected !== undefined && w.pub !== false && stateOf(a1) !== expected) w.problems1.push({ kind: "missing", f: "3 状態", got: stateOf(a1), need: expected });
      }
      for (const x of w.problems1) (x.kind === "double" ? double : missing).push({ id, at: "return1", ...x });
      for (const x of w.problems2) (x.kind === "double" ? double : missing).push({ id, at: "return2", ...x });
      if (w.problems1.some((x) => x.kind === "missing") && w.problems2.length === 0 && after2) w.lateImport = true;
      perWord[id] = w;
    }
    // 学習状況の画面: 3 つの札の語数が、その時の A の語の記録の 3 状態（公開の語だけ）の数と同じ
    const storeCounts = (wd) => {
      if (!wd?.words) return null;
      let unsure = 0;
      let learned = 0;
      for (const v of Object.values(wd.words)) {
        if (v?.pub !== true) continue;
        if (v.ls === 1) unsure++;
        else if (v.ls === 2) learned++;
      }
      const total = result.publicTotal ?? null;
      return { new: total === null ? null : total - unsure - learned, unsure, learned };
    };
    const screenCheck = (screen, wd, label) => {
      const sc = storeCounts(wd);
      const cards = screen?.cards ?? null;
      const okc = !!cards && !!sc && cards.unsure === sc.unsure && cards.learned === sc.learned && (sc.new === null || cards.new === sc.new);
      if (cards && sc && !okc) missing.push({ id: "（学習状況の画面）", at: label, kind: "missing", f: "画面の 3 つの札", got: cards, need: sc });
      return { cards, store: sc, same: okc };
    };
    const screen1 = screenCheck(ret.screen1, after1, "return1");
    const screen2 = screenCheck(ret.screen2, after2, "return2");
    // B（とゲスト）の領域: 旧いタブが配信の後に書いた語（allowed の語。B の種の語は除く）が、どの時点でも入っていない（見張りの知らせ・節目の読み）
    const oldIds = Object.keys(allowed).filter((id) => !B_WORDS.includes(id));
    const baseArea = (a) => (typeof a === "string" ? a.replace(/^pre:/, "") : a);
    const foreign = (a) => !!a && baseArea(a) !== areaA;
    const seenLeak = new Set();
    const pushLeak = (area, id, where, t, v) => {
      const k = `${area}|${id}|${where}`;
      if (seenLeak.has(k)) return;
      seenLeak.add(k);
      areaLeaks.push({ area: baseArea(area) === areaB ? "B" : baseArea(area) === "guest" ? "guest" : area, id, where, t, value: v ?? null, hits: [`area: 旧いタブの語 ${id} が ${baseArea(area) === areaB ? "B" : baseArea(area)} の領域に入った（${where}）`] });
    };
    for (const e of result.areaWrites ?? []) {
      if (!foreign(e.area)) continue;
      if (e.name === "word_stats" && e.words && typeof e.words === "object") for (const id of oldIds) if (e.words[id]) pushLeak(e.area, id, "localStorage の語の記録への書き込み", e.t, e.words[id]);
      if (e.name === "dirty_words" && Array.isArray(e.dirty)) for (const id of oldIds) if (e.dirty.includes(id)) pushLeak(e.area, id, "localStorage の送る語の印への書き込み", e.t);
    }
    for (const sn of snaps) {
      for (const [area, v] of Object.entries(sn.ls ?? {})) {
        if (!foreign(area)) continue;
        if (v.words && typeof v.words === "object") for (const id of oldIds) if (v.words[id]) pushLeak(area, id, `${sn.label} の localStorage の語の記録`, sn.t, v.words[id]);
        if (Array.isArray(v.dirty)) for (const id of oldIds) if (v.dirty.includes(id)) pushLeak(area, id, `${sn.label} の localStorage の送る語の印`, sn.t);
      }
      for (const rec of sn.idb?.records ?? []) {
        if (!foreign(rec.area)) continue;
        if (rec.words && typeof rec.words === "object") for (const id of oldIds) if (rec.words[id]) pushLeak(rec.area, id, `${sn.label} の控え（IndexedDB）の語の記録`, sn.t, rec.words[id]);
      }
    }
    imports = {
      applies: true,
      rule: typeof rule === "function" ? "関数" : rule,
      mode: ret.mode ?? null,
      error: ret.error ?? null,
      counted: { writes: countedWrites.length, words: Object.keys(need) },
      allowedWrites: allowedWrites.length,
      priorFrom: prior?.from ?? null,
      after1From: after1?.from ?? null,
      after2From: after2?.from ?? null,
      perWord,
      screen1,
      screen2,
      missing,
      double,
      areaLeaks: areaLeaks.length,
      watched: (result.areaWrites ?? []).length,
      asked: [ret.first?.asked, ret.second?.asked, ret.away?.asked].filter(Boolean).reduce((x, y) => x + y, 0)
    };
    const anyNeed = Object.values(need).some((v) => F.some((f) => v[f] > 0));
    Object.assign(importValidity, {
      "6 A へ戻る段: 新しいタブの領域が A に戻り、A の取り込みの読みが受け口に届いた（1 回目）": ret.first?.active === true && !ret.error,
      "6 A へ戻る段: A から離れて（link は B へ・ほかはゲストへ）、もう一度 A へ戻った": (ret.away?.active === true || ret.away?.ok === true) && ret.second?.active === true && !ret.error,
      "6 A へ戻る段: 学習状況の画面の 3 つの札を読めた（1 回目と 2 回目）": ret.screen1?.drawn === true && ret.screen2?.drawn === true,
      "6 A へ戻る段: A の初めの値（3 段の後）と、戻った後の A の領域の語の記録（1 回目・2 回目）を読めた": !!prior && !!after1 && !!after2 && after1.from === "ls" && after2.from === "ls",
      "6 A へ戻る段: 見張りのタブが最後まで同じ文書で、localStorage の領域の鍵の書き込みの知らせを聞いた": result.watch?.install === "聞き始めた" && !!result.watch?.docId && result.watch?.docAtEnd === result.watch?.docId && (result.areaWrites ?? []).length > 0,
      "6 A へ戻る段: A へ取り込む物がある（数えた旧い画面の答えの窓の書き込みで、回数が増えた語）": anyNeed && countedWrites.every((w) => Object.values(w.changed ?? {}).every((v) => v?.prev !== undefined || v?.isNew === true))
    });
  }
  const reloadOk = (label) => {
    const r = reloads.find((x) => x.label === label);
    return !!r && r.docs >= 1 && r.settled === true && (!r.treeHasSwitch || r.switchLoaded === true) && !r.error;
  };
  const validity = {
    "0 途中で落ちずに 5 段の終わりまで走った": !result.crash && reached.has("5-flush") && reached.has("end"),
    "1 旧いタブで A がログインして同期した": reqs.some((r) => r.phase === "1-old-A" && r.tab === "old-live" && r.auth.who === "A" && r.table === "word_progress" && r.method === "GET"),
    "1 旧いタブは旧い木の同期と認証のコードを読んだ": tabNames.length === OLD_TABS.length && tabNames.every((t) => (TAB_MODULES[t] ?? []).every((m) => result.tabs[t].loadedBeforeDeploy?.includes(m))),
    "2 新しいタブは新しい木を受けた": (result.served ?? []).some((s) => s.tree === "new" && (s.path === "/" || s.path.endsWith(".html"))),
    "2 見えたままの旧いタブの更新を受け口が止め、新しいタブの移行の後に通した（移行のある木）": !!rr.held && !!rr.response && typeof rr.response.status === "number" && (!rr.treeHasMigration || rr.migratedBeforeRelease === true),
    ...(result.expectWriteBack ? { [writeBackKey]: !!rr.held && writeBackSeen === true } : {}),
    // 期限内の B のトークンで受け口が受けた要求が要る（期限の切れた B のトークンで断られただけ（403）なら、B のセッションは動いていない）
    "3 新しいタブで B のセッションが動いた（B にログインしない回は試していない）": noLogin || reqs.some((r) => r.phase === "3-login-B" && r.tab === "new" && r.auth.who === "B" && r.auth.kind === "user" && typeof r.status === "number" && r.status < 400),
    [frozenKey]: fz.mode === "off" || ((fz.mode === "lifecycle" || fz.mode === "debugger") && fz.ranWhileFrozen === false && fz.tickDocSame === true && fz.docAfterUnfreeze === fz.doc && newDocAt["old-frozen"] > unfreezeAt && frozenReqs === 0 && frozenPageReqs === 0),
    [offlineKey]: !reqs.some((r) => r.tab === "old-offline" && /^[23]/.test(r.phase) && r.kind !== "offline") && newDocAt["old-offline"] > (result.onlineAt ?? Infinity),
    "4 凍った・通信の切れた・見えたままのタブは最後まで旧いコードのまま（配信の後に新しい文書が始まらなかった）": KEEP_TABS.every((t) => fate[t]?.stayedOld && (result.tabs[t].docAtEnd === result.tabs[t].docId)),
    "4 旧いコードのまま残ったタブで動いた同期の関数はどれも旧い木の js/sync.js の字のまま": stillOld.filter((t) => result.tabs[t].syncCode).every((t) => result.tabs[t].syncCode.allInOldTree === true) && stillOld.some((t) => result.tabs[t].syncCode),
    "4 旧いコードのまま残った old-live と old-frozen のどれもが、旧い画面で答え、答えのたびにそのタブの中で語の記録を書いた（配信の後・タブごと。答えた語か答えた後に出た次の語。書き込みの記録の無い古い記録は、端末の語の記録が変わったかで見る）": answerTabs.length > 0 && answerTabs.every((t) => answeredBy[t].pass === true),
    ...(orphansApplies ? { [orphansKey]: !!lastRead && (writesFound.length > 0 || wordsFound.length > 0) && countedTabs.every((t) => lastReachedByTab[t] === true) } : {}),
    "4 旧いコードのタブは読み込み済みのモジュールの呼び出しを誤りなく終えた": stillOld.length > 0 && stillOld.every((t) => Array.isArray(result.tabs[t].forced) && result.tabs[t].forced.length > 0 && result.tabs[t].forced.every(([k, v]) => k !== "error" && !String(v ?? "").startsWith("error"))),
    "4 旧いコードのタブの見える状態の切り替えに失敗が無い": !!result.visErrors && visFail.length === 0,
    // 旧いコードのタブが B のログインの後にトークンの更新を試みたか。試みていなければ、試みられない理由（どの旧いコードのタブも getSession が空・旧い認証の鍵が空）を確かめる
    "4 旧いコードのタブのトークンの更新（B のログインの後・ログインしない回は書き戻しの後）: 試みた、または試みられない理由を確かめた（getSession が空・旧い認証の鍵が空）": refreshBranch !== "none",
    "4 旧いタブが答えた後に、新しいコードの文書を開き直した（/ と /switch.html・裏と表。落ち着くまで）": reloadOk("after-step4"),
    "5 旧いタブを閉じた後に、新しいコードの文書を開き直した（/ と /switch.html・裏と表。落ち着くまで）": reloadOk("after-close"),
    ...importValidity
  };
  const summary = {
    leaks: leaks.length,
    areaLeaks: areaLeaks.length,
    imports,
    integrity: integrity.length,
    order: result.order ?? "normal",
    login: result.login ?? null,
    answeredBy,
    orphans: orphansSummary,
    reloads: reloads.map((r) => ({ label: r.label, docs: r.docs, settled: r.settled, home: r.home ?? null, switchLoaded: r.switchLoaded ?? null, finalUrl: r.finalUrl ?? null, rawBefore: r.rawBefore ?? null, rawAfter: r.rawAfter ?? null, error: r.error ?? null })),
    integrityOldCode: integrity.filter((x) => x.oldCode).length,
    reverse: reverse.length,
    stored: stored.length,
    structural: structural.length,
    valid: Object.values(validity).every(Boolean),
    notExercised,
    oldTabs: fate,
    oldRefresh: { branch: refreshBranch, attempts: oldRefreshAfterLogin.map((r) => `${r.tab}:${r.who ?? "?"}:${r.status}`), getSession: Object.fromEntries(stillOld.map((t) => {
      const g = (result.tabs[t].forced ?? []).find(([k]) => k === "getSession");
      return [t, g ? g[1] : "（呼ばなかった）"];
    })), oldKeyAfterLogin: keyAfterLogin.map((c) => `${c.label}:${c.who ?? "空"}`) },
    refreshRace: rr.held === undefined ? null : { held: rr.held, migratedBeforeRelease: rr.migratedBeforeRelease ?? null, treeHasMigration: rr.treeHasMigration ?? null, response: rr.response ?? null, library: rr.library ?? null, libraryAtRevive: rr.libraryAtRevive ?? null, oldKeyBeforeRelease: rr.oldKeyBeforeRelease ?? null, oldKeyAfterRelease: rr.oldKeyAfterRelease ?? null, writeBackSeen: writeBackSeen ?? null, writeBackAt: rr.writeBackAt ?? null, removedAfterWriteBackMs: rr.writeBackAt && rr.removedAfterWriteBackAt ? rr.removedAfterWriteBackAt - rr.writeBackAt : null },
    // 旧い認証の鍵の書き込みの知らせ（配信の後。だれのセッションが置かれたか・消えたか）
    oldKeyEvents: (result.oldKeyEvents ?? []).filter((e) => e.t >= deployAt).map((e) => `${new Date(e.t).toISOString().slice(11, 23)}:${e.who ?? "消えた"}`),
    oldTabRequestsAfterLogin: Object.fromEntries(tabNames.map((t) => [t, reqs.filter((r) => r.tab === t && isOldCode(r) && (r.at ?? 0) > bLoginAt).length])),
    oldTabRefreshAfterLogin: Object.fromEntries(tabNames.map((t) => [t, reqs.filter((r) => r.tab === t && /^[345]/.test(r.phase) && r.kind === "auth:token:refresh_token").map((r) => `${isOldCode(r) ? "old" : "new"}:${r.who ?? "?"}:${r.status}`)])),
    oldTabWritesAfterLogin: Object.fromEntries(tabNames.map((t) => [t, reqs.filter((r) => r.tab === t && /^[345]/.test(r.phase) && WRITE.has(r.method) && r.path.startsWith("/rest/")).map((r) => `${isOldCode(r) ? "old" : "new"}:${r.auth.who ?? r.auth.kind}:${r.table}:${r.status}`)])),
    reloadedAfterDeploy: tabNames.filter((t) => !fate[t].stayedOld),
    reloadBlocked: (result.reloadBlocked ?? []).map((b) => `${b.keep}:${b.path}:${b.site ?? "?"}`),
    visErrors: visFail.map((e) => `${e.tab}:${e.phase}:${e.error}`),
    // 配信の後に、サーバーへの要求が 1 件も無かったいちばん長いあいだ（秒）。新しい木の Service Worker が有効になるまで取得を止めると長くなる
    longestServerGapSec: (() => {
      const ts = (result.served ?? []).map((x) => x.t).filter((t) => t >= deployAt).sort((a, b) => a - b);
      let gap = 0;
      for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
      return Math.round(gap / 1000);
    })(),
    offlineBlocked: reqs.filter((r) => r.kind === "offline").length,
    writesAsB: reqs.filter((r) => r.auth.who === "B" && WRITE.has(r.method) && r.path.startsWith("/rest/")).length,
    wordsOld: result.words?.old ?? [],
    wordsPre: result.words?.pre ?? []
  };
  return { leaks, reverse, stored, structural, integrity, areaLeaks, imports, info, validity, summary };
}

// 判定: 途中で落ちた回は漏れを見つけていても INVALID（落ちた後の段を通っていない）。漏れの数は summary に残る
// LEAK: A の記録が B へ（か B の記録が A へ）・旧いコードのタブが B として動いた・旧いタブの語が B（かゲスト）の領域に入った。
// LOSS: 漏れは無いが A の記録が後ろへ戻った（既存のデータを消した）。
// A へ戻る段のある記録（orphans のある木）だけ: DOUBLE = 旧いタブの学習を A へ 2 度取り込んだ（回数が多い・2 回目に戻って増えた）、
// NOT_IMPORTED = A へ戻っても旧いタブの学習が A の領域・送信待ち・A のクラウド・学習状況の画面（・決めた 3 状態）に入っていない。どちらも 5 段と戻る段を通った回だけ
export function verdictOf(report, result) {
  if (result.crash) return "INVALID";
  if (report.leaks.length || report.reverse.length || report.stored.length || report.structural.length || (report.areaLeaks ?? []).length) return "LEAK";
  if ((report.integrity ?? []).length) return "LOSS";
  if (!report.summary.valid) return "INVALID";
  if (report.imports?.double?.length) return "DOUBLE";
  if (report.imports?.missing?.length) return "NOT_IMPORTED";
  return "PASS";
}
