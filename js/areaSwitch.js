// ===== 切り替えの画面（switch.html）: 移行・直し・切り替え・旧い場所の片付け（docs は docs/SPEC_ACCOUNT_AREAS.md §3・§4・§8・§1.3） =====
// 学習の部品は読まない。排他のロック "spelldash-area-switch" を持つタブだけが、localStorage の人の記録の置き場所を変える。
// 決まり（不変条件）: localStorage に置く人の記録はいつも 1 人（今の領域）だけ。sd2.index が指す方だけが本物。
// 写して読み直して確かめてから index を替え、index を替えてから元を消す。容量で書けなければ部分的に有効にしない。
// 鍵の決まりは js/areaGuard.js（switch.html では data-switch で読み、window.SpellDashAreaKeys に置く）。
// 内部の 2: ログアウト（退避を確かめてから scope local の signOut）・ログインの「ゲストで学んだ記録を、このアカウントに移す？」（はい／いいえ）・
// ログインとログアウトの前の予行（precheck。アプリのページが呼ぶ）。
import { openAreaStore, sumOf, sameKeys, isQuotaError, askPersist, AreaStoreError } from "./areaStore.js";

const DRAIN_MAX_MS = 3000;
const DRAIN_STEP_MS = 100;
const DRAIN_SETTLE_MS = 300;
// 「はい」でゲストの記録をアカウントへ移すときに消す鍵（持ち主の鍵・同期の基準と送信の控え・ログアウトの時刻・3 状態の初めの埋めの印）
export const ADOPT_RESET = Object.freeze(["spelldash_owner", "spelldash_xp_synced", "spelldash_xp_write", "spelldash_logout_at", "spelldash_learn_filled"]);
// 予行の写しの置き場（areas の別の鍵。本物の写し〔その領域の鍵〕には触れない）
const PRECHECK_PREFIX = "pre:";
// アプリのページから切り替えの画面へ渡す頼み（sessionStorage。このタブだけ）と、切り替えの画面から戻り先へ渡す知らせ
export const INTENT_KEY = "sd2.intent";
export const NOTICE_KEY = "sd2.notice";
const INTENT_TTL_MS = 120000;

// 切り替えられなかった理由。reason: evacuate（退避）・quota（容量）・target（切り替え先の控えが読めない）・legacy（移行の写し）・
// migrate（移行の書き込み）・open（控えの置き場が使えない）・locks（排他のロックが使えない）・load（見張りが読めない）・changed（途中で変わった）・
// export（書き出す記録の控えが読めない）・signout（ログアウトの signOut が失敗した・セッションが残った）。switch.html の小さい script は、部品が読めないときに offline
export class SwitchError extends Error {
  constructor(reason, message, cause = null) {
    super(message);
    this.name = "SwitchError";
    this.reason = reason;
    this.cause = cause;
  }
}

const fail = (reason, cause = null) => new SwitchError(reason, reasonText(reason), cause);
function reasonText(reason) {
  if (reason === "quota") return "この端末の保存の空きが足りない。";
  if (reason === "signout") return "ログアウトできなかった。";
  return "この端末に記録を安全に保存できなかったため、切り替えられません。";
}

// その領域に学んだ記録があるか（元の名前 → 値）。js/sync.js の前の確認と同じ物を数える: 語・XP・マイ単語帳・メモ・Battle・学んだ跡のある成長ログ・今日のセットの履歴。
// 成長ログはホームを開いただけで 0 語の行が 1 つ書かれるので、学んだ跡のある行だけ数える
export function hasRecords(rec) {
  const json = (name, fallback) => {
    try {
      return JSON.parse(rec?.["spelldash_" + name] ?? "null") ?? fallback;
    } catch {
      return fallback;
    }
  };
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : false);
  const battle = json("battle", {});
  const growth = json("growth_log", []);
  const rows = Array.isArray(growth) ? growth : Array.isArray(growth?.rows) ? growth.rows : [];
  return (
    nonEmpty(json("word_stats", {})) ||
    (Number(rec?.spelldash_xp) || 0) > 0 ||
    nonEmpty(json("my_words", [])) ||
    nonEmpty(json("word_notes", {})) ||
    (Number(battle?.wins) || 0) + (Number(battle?.losses) || 0) + (Number(battle?.draws) || 0) > 0 ||
    rows.some((row) => row && (row.active === true || Number(row.learned) > 0 || Number(row.mastered) > 0)) ||
    nonEmpty(json("daily_set", {})?.history ?? [])
  );
}

// deps: { ls: { get, set, remove, keys }（生の localStorage）, keys（js/areaGuard.js の SpellDashAreaKeys）, openStore, locks, now, newId, sleep, persist,
//         ask（「移す？」の答え。引数は切り替え先の領域。"yes" | "no"。無ければ移さない。切り替えの画面は排他のロックの中ではたずねず、まだ答えが無ければ
//              AskNeeded を投げてロックを放す: runSwitchPage）, signOut（ログアウト。{ error }。js/supabase.js の部品を scope local で） }
export function createSwitcher(deps) {
  const { ls, keys: K, openStore, locks } = deps;
  const now = deps.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const newId = deps.newId ?? (() => `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const persist = deps.persist ?? (() => askPersist());
  const ask = typeof deps.ask === "function" ? deps.ask : null;
  const signOut = typeof deps.signOut === "function" ? deps.signOut : async () => ({ error: { message: "signOut が無い" } });
  let persistAsked = false;

  const readJson = K.readJson;
  const readIndex = () => {
    const value = readJson(ls.get(K.INDEX_KEY));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  const writeIndex = (index) => ls.set(K.INDEX_KEY, JSON.stringify(index));
  const markerNow = () => K.parseMarker(ls.get(K.AREA_KEY));
  const sessionArea = () => K.areaOfUser(K.sessionUserOf(ls.get(K.AUTH_KEY), ls.get(K.AUTH_KEY + "-user")));
  // その領域の localStorage の鍵（物理の名前）
  const physicalOf = (area) => ls.keys().filter((key) => key.startsWith(K.areaPrefix(area)));
  // その領域の記録（元の名前 → 値）
  const collect = (area) => {
    const out = {};
    for (const key of physicalOf(area)) {
      const value = ls.get(key);
      if (value !== null) out[K.logicalKey(area, key)] = value;
    }
    return out;
  };
  // 旧い場所の人の記録（移行の印 OWNER_MOVED は除く）
  const legacyKeys = () => ls.keys().filter((key) => K.isPersonKey(key) && !(key === K.OWNER_KEY && ls.get(key) === K.OWNER_MOVED));
  const askPersistOnce = async () => {
    if (persistAsked) return;
    persistAsked = true;
    try {
      await persist();
    } catch {
      // 断られても分ける
    }
  };

  // ===== 移行（§8。1 回だけ・何度流しても同じ） =====
  // 領域を決める（§7 (c)）: 持ち主の印があればその人。無ければ、ログイン中ならその人、未ログインならゲスト
  function decideArea(old) {
    const owner = old[K.OWNER_KEY];
    if (typeof owner === "string" && owner && owner !== K.OWNER_MOVED) return K.areaOfUser(owner);
    const user = K.sessionUserOf(ls.get(K.OLD_AUTH_KEY), ls.get(K.OLD_AUTH_KEY + "-user")) ?? K.sessionUserOf(ls.get(K.AUTH_KEY), ls.get(K.AUTH_KEY + "-user"));
    return K.areaOfUser(user);
  }

  async function migrate(store) {
    let state = readJson(ls.get(K.MIGRATING_KEY));
    let legacy = null;
    if (state && typeof state.legacyId === "string" && typeof state.area === "string") {
      // 落ちた後の続き: legacy（同じ id）から 3 をやり直す
      try {
        legacy = await store.get("legacy", state.legacyId);
      } catch (error) {
        throw fail("legacy", error);
      }
      if (!legacy || sumOf(legacy.keys) !== legacy.sum) throw fail("legacy");
    } else if (finishedButUnmarked()) {
      // 手順 5 で、空きが足りずに途中の印を先に消し、終わりの印を書く前に落ちた: 記録は今の領域にそろっている。終わりの印だけ書く
      const area = markerNow().area;
      try {
        ls.set(K.MIGRATED_KEY, JSON.stringify({ at: iso(), fromSchema: null, legacyId: null, area }));
      } catch (error) {
        throw fail(isQuotaError(error) ? "quota" : "migrate", error);
      }
      return area;
    } else {
      // 1. 旧い鍵の人の記録を全部 legacy に写す → 読み直して比べる。失敗なら旧い記録はそのまま
      const old = {};
      for (const key of legacyKeys()) old[key] = ls.get(key);
      const sum = sumOf(old);
      // 前の回で写して確かめたが、途中の印が入らずに止まった（容量）: 同じ中身の legacy を使い回す（「もう一度」のたびに写しを増やさない）
      let found = null;
      try {
        found = (await store.list("legacy")).find((r) => r && typeof r.id === "string" && r.sum === sum && sumOf(r.keys) === r.sum && sameKeys(r.keys, old)) ?? null;
      } catch {
        found = null; // 読めなければ新しく写す
      }
      if (found) legacy = found;
      else {
        legacy = { id: newId(), savedAt: iso(), fromSchema: old[K.PREFIX + "schema_version"] ?? null, keys: old, sum };
        await askPersistOnce();
        try {
          await store.putVerified("legacy", legacy);
        } catch (error) {
          throw fail(isQuotaError(error) ? "quota" : "legacy", error);
        }
      }
      // 2. 領域を決める
      state = { legacyId: legacy.id, area: decideArea(old), at: iso() };
      try {
        ls.set(K.MIGRATING_KEY, JSON.stringify(state));
      } catch (error) {
        // 途中の印が入らない: 旧い記録はそのまま（まだ何も移していない）。復旧の画面で容量不足を出す
        throw fail(isQuotaError(error) ? "quota" : "migrate", error);
      }
    }
    const area = state.area;
    // 3. 新しい鍵へ書く → 読み直して legacy と比べる。入らなければ、legacy と同じ値の旧い本体を全部消してから書き直す
    // （中身は確かめた legacy にある。書き終えた鍵の旧い本体も場所を取るので、今の鍵だけ消しても入らないことがある）
    let freed = false;
    const freeOldBodies = () => {
      if (freed) return false;
      freed = true;
      for (const key of legacyKeys()) if (legacy.keys[key] === ls.get(key)) ls.remove(key);
      return true;
    };
    try {
      for (const [name, value] of Object.entries(legacy.keys)) {
        const phys = K.physicalKey(area, name);
        if (ls.get(phys) === value) continue;
        try {
          ls.set(phys, value);
        } catch (error) {
          if (!isQuotaError(error) || !freeOldBodies()) throw error;
          ls.set(phys, value);
        }
      }
    } catch (error) {
      throw fail(isQuotaError(error) ? "quota" : "migrate", error);
    }
    for (const [name, value] of Object.entries(legacy.keys)) if (ls.get(K.physicalKey(area, name)) !== value) throw fail("migrate");
    // 4. 旧い本体を消す（写した時と同じ値の物だけ。違う値は旧コードのタブが後から書いた物で、片付けが orphans へ写す）
    for (const key of legacyKeys()) if (legacy.keys[key] === ls.get(key)) ls.remove(key);
    try {
      ls.set(K.OWNER_KEY, K.OWNER_MOVED);
      moveAuth();
    } catch (error) {
      throw fail(isQuotaError(error) ? "quota" : "migrate", error);
    }
    // 5. 印を書く。終わりの印 sd2.migrated は途中の印 sd2.migrating より長い（同じ中身と時刻・版）ので、index と領域の印は途中の印があっても入る。
    // 終わりの印が途中の印と並んで入らなければ、途中の印を先に消す（落ちても、次に開くと領域の印と index から終わったと分かる: finishedButUnmarked）
    const at = iso();
    const done = JSON.stringify({ at, fromSchema: legacy.fromSchema, legacyId: legacy.id, area });
    try {
      writeIndex({ ...readIndex(), [area]: { at: "ls", lastUsedAt: at } });
      ls.set(K.AREA_KEY, K.formatMarker(area, 1));
      try {
        ls.set(K.MIGRATED_KEY, done);
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        const moving = ls.get(K.MIGRATING_KEY);
        ls.remove(K.MIGRATING_KEY);
        try {
          ls.set(K.MIGRATED_KEY, done);
        } catch (again) {
          // それでも入らない: 途中の印を戻す（次も legacy から続ける・書き出しは legacy）
          if (moving !== null) ls.set(K.MIGRATING_KEY, moving);
          throw again;
        }
      }
    } catch (error) {
      throw fail(isQuotaError(error) ? "quota" : "migrate", error);
    }
    ls.remove(K.MIGRATING_KEY);
    return area;
  }

  // 移行の印を書く途中だけで止まった形（終わりの印も途中の印も無いが、領域の印があり index がその領域を ls と指す）
  function finishedButUnmarked() {
    const marker = markerNow();
    return Boolean(marker) && ls.get(K.MIGRATED_KEY) === null && readIndex()[marker.area]?.at === "ls";
  }

  // 認証のセッションを新しい鍵へ移して、旧い鍵を消す（旧コードのタブの認証の部品は新しい鍵を読まない）
  function moveAuth() {
    for (const suffix of ["", "-user"]) {
      const oldKey = K.OLD_AUTH_KEY + suffix;
      const newKey = K.AUTH_KEY + suffix;
      const value = ls.get(oldKey);
      if (value === null) continue;
      if (ls.get(newKey) === null) {
        try {
          ls.set(newKey, value);
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          // 両方は入らない: 旧い鍵を先に消してから書く（新しい鍵は旧い鍵より短い）。それでも書けなければ旧い鍵を戻す
          ls.remove(oldKey);
          try {
            ls.set(newKey, value);
          } catch (again) {
            try {
              ls.set(oldKey, value);
            } catch {
              // 戻せなければログアウトになるだけ（記録は失わない）
            }
            throw again;
          }
        }
        if (ls.get(newKey) !== value) throw fail("migrate");
      }
      ls.remove(oldKey);
    }
    ls.remove(K.OLD_AUTH_KEY + "-code-verifier");
  }

  // ===== 旧い場所の片付け（§1.3。移行の後に旧コードのタブが旧い鍵へ書いた値） =====
  // orphans に写して読み直して確かめてから、localStorage から消す（写した時と同じ値の物だけ）。読まない・移し直さない。
  // 旧い認証の鍵が戻っていれば消す（写さない）。持ち主の印が消えていれば書き直す
  async function sweepOrphans(store) {
    const found = {};
    for (const key of legacyKeys()) found[key] = ls.get(key);
    const names = Object.keys(found);
    if (names.length > 0) {
      const record = { id: newId(), savedAt: iso(), keys: found, sum: sumOf(found) };
      await store.putVerified("orphans", record);
      for (const key of names) if (ls.get(key) === found[key]) ls.remove(key);
    }
    for (const suffix of ["", "-user", "-code-verifier"]) ls.remove(K.OLD_AUTH_KEY + suffix);
    if (ls.get(K.OWNER_KEY) === null) {
      try {
        ls.set(K.OWNER_KEY, K.OWNER_MOVED);
      } catch {
        // 書けなくても続ける（旧コードの同期が確認なしで足すのは、そのタブの人自身のクラウドだけ）
      }
    }
    return names.length;
  }

  // ===== 退避した領域の残りの片付け（§1.2 の 1 人だけの決まり） =====
  // index が idb を指す領域（index に無い、領域の印でない領域も）の localStorage の鍵は、途中で落ちた残りか、見え方の古いタブ（確認の窓・長い処理・
  // 凍結の間に切り替わった）が後から書いた物。書くたびの確かめは、そのタブの古い見え方の印を読むので止められない（§3 の 3 は、見え方が今のタブだけを止める）。
  // index が指す確かめた写しと同じ値なら消す。違う値（写しに無い鍵も）は orphans に領域つきで写して読み直してから消す（読まない・移し直さない）。
  // 消す直前に、同じ値で、まだ退避した領域であることを読み直す。only を渡すとその領域だけ。page（アプリのページから）は切り替えの印があれば消さない
  function staleByArea(only = null) {
    const index = readIndex();
    const markerArea = markerNow()?.area ?? null;
    const out = {};
    for (const key of ls.keys()) {
      const hit = K.areaOfPhysical(key);
      if (!hit || (only && !only.includes(hit.area)) || !K.isStaleArea(hit.area, index, markerArea)) continue;
      const value = ls.get(key);
      if (value !== null) (out[hit.area] ??= {})[hit.name] = value;
    }
    return out;
  }
  async function sweepStale(store, { only = null, page = false } = {}) {
    let removed = 0;
    for (const [area, found] of Object.entries(staleByArea(only))) {
      const copy = await readCopy(store, area);
      const late = {};
      for (const [name, value] of Object.entries(found)) if (!copy || copy[name] !== value) late[name] = value;
      if (Object.keys(late).length > 0) {
        await askPersistOnce();
        await store.putVerified("orphans", { id: newId(), savedAt: iso(), area, keys: late, sum: sumOf(late) });
      }
      for (const [name, value] of Object.entries(found)) {
        const phys = K.physicalKey(area, name);
        if (page && ls.get(K.SWITCH_KEY) !== null) return removed;
        if (ls.get(phys) === value && K.isStaleArea(area, readIndex(), markerNow()?.area ?? null)) {
          ls.remove(phys);
          removed++;
        }
      }
    }
    return removed;
  }

  // ===== 直し（§3。sd2.switch が残っていた: タブを閉じた・落ちた） =====
  // index が指す方だけが本物。index が idb を指す領域の localStorage の残り（途中まで消した F・途中まで書いた T）は、確かめた写しと同じなら消す。
  // 写しと違う値（見え方の古いタブが後から書いた）は orphans へ写してから消す（sweepStale）。index が ls を指す領域はそのまま。古い写しは index が指さないので戻さない
  async function repair(store) {
    const removed = await sweepStale(store);
    ls.remove(K.SWITCH_KEY);
    return removed;
  }

  // ===== 切り替え（§3 の 1〜9。F → T） =====
  async function drain() {
    const start = now();
    for (;;) {
      let held = 0;
      try {
        const state = await locks.query();
        held = (state?.held ?? []).filter((lock) => lock.name === K.PAGE_LOCK).length;
      } catch {
        held = 0;
      }
      if (held === 0 || now() - start >= DRAIN_MAX_MS) break;
      await sleep(DRAIN_STEP_MS);
    }
    await sleep(DRAIN_SETTLE_MS);
  }

  // その領域の記録を localStorage に全部書いて読み直す。もう同じ値がある鍵は書かない。書けない・合わなければ、この書き込みが替えた鍵だけを
  // 前の形に戻して例外（index は替えない）: 前に無かった鍵は消し（先に消して空きを作る）、前からあった鍵は前の値に戻す。
  // 前からあった鍵（止めるときに戻す元の領域へ、見え方の古いタブが遅れて書いた値）は消さない。書いた値と違う鍵（同じ時にほかのタブが書いた）にも触れない
  function writeArea(area, keys) {
    const wrote = []; // [物理の鍵, 前の値（無ければ null）, 書いた値]
    try {
      for (const [name, value] of Object.entries(keys)) {
        const phys = K.physicalKey(area, name);
        const prior = ls.get(phys);
        if (prior === value) continue;
        wrote.push([phys, prior, value]);
        ls.set(phys, value);
      }
      if (!sameKeys(collect(area), keys)) throw new AreaStoreError("verify", "書き戻すと中身が合わなかった。");
    } catch (error) {
      for (const [phys, prior, value] of wrote) if (prior === null && ls.get(phys) === value) ls.remove(phys);
      for (const [phys, prior, value] of wrote) {
        if (prior === null || ls.get(phys) !== value) continue;
        try {
          ls.set(phys, prior);
        } catch {
          // 戻せなければ書いた値のまま（前に入っていた値で、先に新しい鍵を消して空けたので、ほかのタブが同じ時に空きを使わない限り入る）
        }
      }
      throw error;
    }
  }
  // 元に戻す: 書けたら index を ls に。書けなければ、元は確かめた写し（index が指す）にあり、この書き込みで足した鍵は消してある（前からあった鍵はそのまま）
  function restore(area, keys) {
    try {
      writeArea(area, keys);
    } catch {
      return false;
    }
    writeIndex({ ...readIndex(), [area]: { at: "ls", lastUsedAt: iso() } });
    return true;
  }
  // index が指す確かめた写し（IndexedDB）の記録。無い・id が違う・要約が合わない・読めなければ null
  async function readCopy(store, area) {
    const at = readIndex()[area]?.at;
    if (typeof at !== "string" || !at.startsWith("idb:")) return null;
    let record;
    try {
      record = await store.get("areas", area);
    } catch {
      return null;
    }
    if (!record || `idb:${record.id}` !== at || sumOf(record.keys) !== record.sum) return null;
    return record.keys;
  }

  // localStorage に記録がある領域（index が ls を指す。index に無いが鍵がある印の領域も）。ふつうは 1 つ
  function liveAreas() {
    const index = readIndex();
    const live = Object.keys(index).filter((area) => index[area]?.at === "ls");
    const marker = markerNow();
    if (marker && index[marker.area] === undefined && physicalOf(marker.area).length > 0) live.push(marker.area);
    return live;
  }

  // op: "session"（今のセッションの領域へ）・"logout"（ログアウト。afterArchive が signOut して確かめる）・"adopt"（「はい」: ゲストの記録をこのアカウントへ移す）。
  // adopt は手順 4 で、ゲストの写しと、持ち主の鍵などを消した切り替え先の写しの両方を書いて読み直し、手順 6 で両方を index に入れ、手順 8 でゲストを index から外す
  // （移した記録をゲストに残さない。手順 6〜8 の間で落ちたときは、直しの finishAdopt が外す）
  async function switchTo(store, target, op = "session", { afterArchive = null } = {}) {
    const marker = markerNow();
    const gen = (marker?.gen ?? 0) + 1;
    const id = newId();
    // 元 F は localStorage にある領域（印ではなく index で決める: 印を替える前に落ちた形では、印と index が食い違う）
    const live = liveAreas();
    const from = live.includes(marker?.area) ? marker.area : (live[0] ?? marker?.area ?? null);
    const adopt = op === "adopt" && from === "guest" && live.includes("guest") && target !== "guest" && readIndex()[target] === undefined;
    const flag = { id, op: op === "adopt" && !adopt ? "session" : op, from, to: target, phase: "drain", at: iso() };
    const targetBefore = readIndex()[target]; // 止めるときに戻す（手順 8 の後に止まった）
    // 1. 印を書く（ほかのタブは知らせで切り替えの画面へ移る）。入らなければ何も替えずに止める
    try {
      ls.set(K.SWITCH_KEY, JSON.stringify(flag));
    } catch (error) {
      throw fail(isQuotaError(error) ? "quota" : "evacuate", error);
    }
    const archived = [];
    let incoming = null;
    let adoptKeys = null;
    let wroteTarget = false;
    let stopping = false;
    // 止める（§3 の 4・7、§4。どの段の書き込みが容量で入らなくても同じ）: 切り替え先の index を前に戻し、書いた切り替え先の鍵を消す（写しにある）。
    // 元を localStorage に戻してから途中の印を消す。印は替えない。元が localStorage に無い（前の切り替えが手順 6 の後で落ちて、やり直した）ときは、
    // index が指す確かめた写しから戻す
    const stop = async (reason, cause = null) => {
      stopping = true;
      if (!live.includes(target)) {
        const idx = readIndex();
        if (JSON.stringify(idx[target] ?? null) !== JSON.stringify(targetBefore ?? null)) {
          const back = { ...idx };
          if (targetBefore === undefined) delete back[target];
          else back[target] = targetBefore;
          try {
            writeIndex(back);
          } catch (error) {
            // index を戻す空きが無い: 書いた切り替え先の鍵（写しにある）を先に消してから戻す
            if (!isQuotaError(error)) throw error;
            for (const [name, value] of Object.entries(incoming ?? {})) if (ls.get(K.physicalKey(target, name)) === value) ls.remove(K.physicalKey(target, name));
            writeIndex(back);
          }
        }
        if (wroteTarget) for (const [name, value] of Object.entries(incoming ?? {})) if (ls.get(K.physicalKey(target, name)) === value) ls.remove(K.physicalKey(target, name));
      }
      // 元の領域へ遅れて書かれた鍵（手順 6 の後）は、戻す前に orphans へ。写せなければ、戻すときに残りの値を写しに重ねる（その人の後の値。失わない）。
      // 元と残りの両方が入らなければ、戻す書き込みは取り消す（残りは消さない）。元は確かめた写し（index が指す）のまま、残りは退避した領域の
      // localStorage の残りとして置く（次の片付けが orphans へ写す）。2 人分は重ねない
      try {
        await sweepStale(store, { only: [...archived.map(([area]) => area), ...(from ? [from] : [])] });
      } catch {
        // 写せなくても戻す
      }
      for (const [area, snapshot] of archived) if (readIndex()[area]?.at !== "ls") restore(area, { ...snapshot, ...collect(area) });
      if (from && from !== target && liveAreas().length === 0) {
        const copy = await readCopy(store, from);
        if (copy) restore(from, { ...copy, ...collect(from) });
      }
      ls.remove(K.SWITCH_KEY);
      return fail(reason, cause);
    };
    try {
      // 2. ページの持ち主が 0 になるのを最大 3 秒待つ + 300ms（凍ったタブが残っても進める。3 の後は、見え方が今のタブは書けない）
      await drain();
      // 3. swap の段。ここから人の記録への書き込みは、見え方が今のタブでは拒まれる（見え方の古いタブの遅れた書き込みは sweepStale が片付ける）
      ls.set(K.SWITCH_KEY, JSON.stringify({ ...flag, phase: "swap" }));
      // 4. 切り替え先でない localStorage の領域（ふつうは F の 1 つ）を IndexedDB に写す → 読み直して比べる。
      // 失敗なら止める（F は localStorage のまま・印も index も替えない）。adopt は切り替え先の写し（持ち主の鍵などを消した物）も書いて読み直す
      for (const area of live.filter((a) => a !== target)) {
        const snapshot = collect(area);
        await askPersistOnce();
        try {
          await store.putVerified("areas", { area, id, keys: snapshot, savedAt: iso(), schema: snapshot[K.PREFIX + "schema_version"] ?? null, sum: sumOf(snapshot) });
          if (adopt && area === from) {
            adoptKeys = Object.fromEntries(Object.entries(snapshot).filter(([name]) => !ADOPT_RESET.includes(name)));
            await store.putVerified("areas", { area: target, id, keys: adoptKeys, savedAt: iso(), schema: adoptKeys[K.PREFIX + "schema_version"] ?? null, sum: sumOf(adoptKeys) });
          }
        } catch (error) {
          throw await stop(isQuotaError(error) ? "quota" : "evacuate", error);
        }
        if (!sameKeys(collect(area), snapshot)) throw await stop("changed");
        archived.push([area, snapshot]);
      }
      // 切り替え先を、元を消す前・ログアウトの signOut の前に読む（読めない・確かめられなければ、元を消さず、ログインもそのままで止める。
      // docs/SPEC_ACCOUNT_AREAS.md §4 の必須修正 1: IndexedDB の読みと照合ができなければログアウトを完了しない）
      if (adopt) {
        if (!adoptKeys) throw await stop("changed");
        incoming = adoptKeys;
      } else {
        const targetAt = readIndex()[target]?.at;
        if (typeof targetAt === "string" && targetAt.startsWith("idb:")) {
          incoming = await readCopy(store, target);
          if (!incoming) throw await stop("target");
        }
      }
      // 切り替え先の領域に localStorage の残りがある（見え方の古いタブが書いた）: 写しと違う値は orphans へ写してから消す（写しで上書きして失わない）。
      // IndexedDB に書くので signOut の前にする。手順 7 の直前にもう一度（signOut の間に書かれた残り）
      const sweepTarget = async () => {
        if (live.includes(target) || physicalOf(target).length === 0) return;
        try {
          await sweepStale(store, { only: [target] });
        } catch (error) {
          throw await stop(isQuotaError(error) ? "quota" : "evacuate", error);
        }
        if (physicalOf(target).length > 0) throw await stop("changed");
      };
      await sweepTarget();
      // 5. ログアウトだけ: 退避と切り替え先の読みを確かめた後に signOut（scope local）と結果の確かめ。失敗なら止める（F は localStorage のまま・ログインもそのまま。写しは index が指さない）
      if (afterArchive) {
        try {
          await afterArchive();
        } catch (error) {
          throw await stop(error instanceof SwitchError ? error.reason : "signout", error);
        }
      }
      // 6. index[F] = idb → F の鍵を localStorage から消す。消す直前に、元が写しと同じかを確かめる（写しの後に遅れて書かれた値を消さない。
      // 確かめと消すのは同じ流れの中で、間にほかのタブの書き込みは入らない）。adopt は切り替え先の写しも同じ 1 回で index に入れる
      for (const [area, snapshot] of archived) {
        if (!sameKeys(collect(area), snapshot)) throw await stop("changed");
        const at = { at: `idb:${id}`, lastUsedAt: iso() };
        writeIndex({ ...readIndex(), [area]: at, ...(adopt && area === from ? { [target]: at } : {}) });
        for (const key of physicalOf(area)) ls.remove(key);
      }
      // 7 の前: 切り替え先の領域の残りをもう一度（ふつうは無い）
      await sweepTarget();
      // 7. T を localStorage に全部書く。容量で書けなければ、T の鍵を消し、F を写しから書き戻して index[F] = ls。印は替えない
      if (incoming) {
        wroteTarget = true;
        try {
          writeArea(target, incoming);
        } catch (error) {
          throw await stop(isQuotaError(error) ? "quota" : "target", error);
        }
      }
      // 8. index[T] = ls（新しければ作る）。adopt はゲストを index から外す（移した記録をゲストに残さない）
      const nextIndex = { ...readIndex(), [target]: { at: "ls", lastUsedAt: iso() } };
      if (adopt) delete nextIndex[from];
      writeIndex(nextIndex);
      // 9. 印を 1 回で替える。途中の印を消す
      ls.set(K.AREA_KEY, K.formatMarker(target, gen));
      ls.remove(K.SWITCH_KEY);
    } catch (error) {
      // 手順 3・6・8・9 の書き込みが入らない（容量）・ほかの例外: 同じ道で止める（復旧の画面は容量なら容量不足を出す）
      if (error instanceof SwitchError || stopping) throw error;
      throw await stop(isQuotaError(error) ? "quota" : "evacuate", error);
    }
    return { from, to: target, gen, op: flag.op };
  }

  // 「はい」の切り替えが手順 6 の後で落ちた（index がゲストを、その切り替えのゲストの写しで指す）: 移すのは確かめ済みなので、ゲストを index から外して終える
  // （ゲストと切り替え先の両方に同じ記録を残さない）。手順 6 の前に落ちた形は index が替わっていないので、もう一度たずねる
  function finishAdopt(pending) {
    if (!pending || pending.op !== "adopt" || typeof pending.id !== "string" || typeof pending.from !== "string") return;
    const index = readIndex();
    if (index[pending.from]?.at !== `idb:${pending.id}`) return;
    const next = { ...index };
    delete next[pending.from];
    writeIndex(next); // 減らす書き込み（入らないことは無い）
  }

  // ログアウト（§3 の 5・§4）: 今のログインの領域を退避して確かめてから signOut（scope local）し、セッションが消えたことを確かめてから、元を消してゲストを戻す。
  // 退避か signOut が失敗したら止める（元の記録とログインはそのまま）。signOut の後の展開の失敗は、認証が先に変わった形（復旧の画面）
  async function logout(store) {
    return switchTo(store, "guest", "logout", {
      afterArchive: async () => {
        let result;
        try {
          result = await signOut();
        } catch (error) {
          throw fail("signout", error);
        }
        if (result?.error) throw fail("signout", result.error);
        if (sessionArea() !== "guest") throw fail("signout");
      }
    });
  }

  // ===== 「移す？」の答え（docs/SPEC_ACCOUNT_AREAS.md §0.3 の 2: 複数のタブで答えても、最初に確定した答えだけが効く） =====
  // 答えたタブは、排他のロックの中で答えを端末に残す（sd2.decision = { id: 判断の id, from: "guest", to: 切り替え先, answer: "yes" | "no", at, gen: 今の印の世代, failed? }）。
  // ロックを後から取ったタブは、残った答えを使い、自分のタブで押した答えは捨てる。使うのは同じ問い（ゲスト → 同じ切り替え先・同じ世代）の答えだけで、
  // 違えば（ほかのタブで別の人に入り直した・その後にほかの切り替えが済んだ）消してたずね直す。切り替えが済んだら消す。
  // 決まった答えの切り替えが失敗したら、答えと理由（failed）を残す。「もう一度」（retry）でだけ同じ答えでやり直し、それまではどのタブも同じ理由で止まる
  function readDecision(target, gen) {
    const raw = ls.get(K.DECISION_KEY);
    if (raw === null) return null;
    const d = readJson(raw);
    if (d && typeof d.id === "string" && d.from === "guest" && d.to === target && d.gen === gen && (d.answer === "yes" || d.answer === "no")) return d;
    dropDecision();
    return null;
  }
  function dropDecision() {
    try {
      if (ls.get(K.DECISION_KEY) !== null) ls.remove(K.DECISION_KEY);
    } catch {
      // 消せなくても、次に読むときに問い（切り替え先・世代）と合わなければ使わない
    }
  }

  // 今のセッションに合う領域にする（同じで localStorage にあれば何もしない）。退避した領域の残りを写せなかった（staleError）ときは、
  // 切り替えずに止める（元の領域の残りを localStorage に置いたまま、別の領域を重ねて展開しない）。
  // この端末で初めてアカウントに入り（index にその領域が無い）、今のゲストに学んだ記録があれば、1 回たずねる（ask）。たずねている間にセッションが
  // 替わったら、今のセッションでやり直す（はいでも前のアカウントへは移さない）。答えは端末に残し、最初に確定した 1 つだけを使う（上の決まり）
  async function ensureArea(store, target = sessionArea(), staleError = null, { retry = false } = {}) {
    for (let round = 0; round < 4; round++) {
      const marker = markerNow();
      const live = liveAreas();
      if (marker?.area === target && live.length === 1 && live[0] === target) {
        dropDecision();
        return null;
      }
      if (staleError) throw fail(isQuotaError(staleError) ? "quota" : "evacuate", staleError);
      const from = live.includes(marker?.area) ? marker.area : (live[0] ?? null);
      let op = "session";
      let decision = null;
      if (ask && from === "guest" && target !== "guest" && readIndex()[target] === undefined && hasRecords(collect("guest"))) {
        const gen = marker?.gen ?? 0;
        decision = readDecision(target, gen);
        if (!decision) {
          const answer = await ask(target);
          const now = sessionArea();
          if (now !== target) {
            target = now;
            continue;
          }
          decision = { id: newId(), from: "guest", to: target, answer: answer === "yes" ? "yes" : "no", at: iso(), gen };
          try {
            ls.set(K.DECISION_KEY, JSON.stringify(decision));
          } catch (error) {
            throw fail(isQuotaError(error) ? "quota" : "evacuate", error);
          }
        } else if (decision.failed && !retry) {
          // 決まった答えの切り替えが前に失敗した: 「もう一度」まではやり直さない（ほかのタブの後の答えでも替えない）
          throw fail(decision.failed);
        }
        if (decision.answer === "yes") op = "adopt";
      } else dropDecision();
      try {
        const result = await switchTo(store, target, op);
        dropDecision();
        return result;
      } catch (error) {
        if (decision) {
          try {
            ls.set(K.DECISION_KEY, JSON.stringify({ ...decision, failed: error instanceof SwitchError ? error.reason : "evacuate" }));
          } catch {
            // 理由を書けなくても答えは残っている（次も同じ答えで切り替えを試す）
          }
        }
        throw error;
      }
    }
    throw fail("changed");
  }

  // ロックの中で流す全部: 直し → 移行 → 片付け（旧い場所・退避した領域の残り） → 今のセッションの領域へ（intent がログアウトならログアウト） → 退避した領域の残りをもう一度。
  // retry: 復旧の画面の「もう一度」から開いた（前に失敗した「移す？」の答えで、もう一度切り替える）
  async function settle(intent = null, { retry = false } = {}) {
    let store;
    try {
      store = await openStore();
    } catch (error) {
      throw fail(error?.code === "quota" ? "quota" : "open", error);
    }
    try {
      const pending = readJson(ls.get(K.SWITCH_KEY));
      if (ls.get(K.SWITCH_KEY) !== null) {
        try {
          await repair(store);
          finishAdopt(pending);
        } catch (error) {
          throw error instanceof SwitchError ? error : fail(isQuotaError(error) ? "quota" : "evacuate", error);
        }
      }
      if (ls.get(K.MIGRATED_KEY) === null || ls.get(K.MIGRATING_KEY) !== null) await migrate(store);
      try {
        await sweepOrphans(store);
      } catch {
        // 片付けられなくても切り替えは続ける（旧い場所の値は読まない）
      }
      let staleError = null;
      try {
        await sweepStale(store);
      } catch (error) {
        staleError = error;
      }
      // ログアウトの頼み: ログイン中で、その人の領域が localStorage にあるときだけ（もうセッションが無ければ、ふつうにゲストへ）
      const session = sessionArea();
      const live = liveAreas();
      let result;
      if (intent?.op === "logout" && session !== "guest" && markerNow()?.area === session && live.length === 1 && live[0] === session) {
        if (staleError) throw fail(isQuotaError(staleError) ? "quota" : "evacuate", staleError);
        result = await logout(store);
      } else {
        result = await ensureArea(store, session, staleError, { retry });
      }
      // 切り替えの間に、退避した領域へ遅れて書かれた鍵（見え方の古いタブ）。写せなければ残す（次に開いたページの見張りが見つけて片付ける）
      if (result) {
        try {
          await sweepStale(store);
        } catch {
          // 残りは失わない（localStorage にある）
        }
      }
      return result;
    } finally {
      store.close();
    }
  }

  return { settle, migrate, repair, switchTo, ensureArea, logout, sweepOrphans, sweepStale, decideArea, sessionArea, collect, readIndex };
}

// ===== アプリのページから（見張りが旧い場所の値・退避した領域の残りを見つけたとき）: 手の空いたときに片付ける =====
// raw は見張りが渡す生の localStorage の口。ほかのタブが切り替え・移行をしている間（排他のロック・途中の印）は何もしない（次に開いたとき）。
// deps は単体のための差し込み口（keys・locks・openStore）
export async function sweepOrphansFromPage(raw, deps = {}) {
  const K = deps.keys ?? globalThis.SpellDashAreaKeys;
  const locks = deps.locks ?? globalThis.navigator?.locks;
  const open = deps.openStore ?? (() => openAreaStore());
  if (!K || !locks || !raw) return 0;
  return locks.request(K.SWITCH_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return 0;
    if (raw.get(K.SWITCH_KEY) !== null || raw.get(K.MIGRATING_KEY) !== null || raw.get(K.MIGRATED_KEY) === null) return 0;
    const switcher = createSwitcher({ ls: raw, keys: K, openStore: open, locks });
    const store = await open();
    try {
      const old = await switcher.sweepOrphans(store);
      return old + (await switcher.sweepStale(store, { page: true }));
    } finally {
      store.close();
    }
  });
}

// ===== 予行（ログインのリンクを送る前・外部のログインへ移る前・ログアウトの前。js/auth.js が呼ぶ。§4） =====
// 今の領域の記録（元の名前 → 値）を IndexedDB に写して、新しいトランザクションで読み直して比べる。写すのは本物の写し（その領域の鍵）でなく予行の鍵
// （pre:<領域>）なので、index が指す写しにも、切り替えの途中の写しにも触れない。localStorage も印も替えない。
// 確かめたら予行の写しを消す（残すと、その写しが切り替えの画面の本物の退避の空きを使い、空きの少ない端末で予行が通っても本物の退避が入らない。反証）。
// 消せなければ失敗（空きを確かめたことにならない）。
// 返り値 { ok: true } か { ok: false, reason }（quota・open・evacuate）。できなければ、呼び手はリンクを送らない・ログアウトしない
export async function precheck({ area, records, openStore = () => openAreaStore(), persist = () => askPersist(), newId = null, now = () => Date.now() } = {}) {
  if (typeof area !== "string" || !area || !records || typeof records !== "object") return { ok: false, reason: "evacuate" };
  let store;
  try {
    store = await openStore();
  } catch (error) {
    return { ok: false, reason: error?.code === "quota" || isQuotaError(error?.cause) ? "quota" : "open" };
  }
  try {
    try {
      await persist();
    } catch {
      // 断られても写す
    }
    const keys = { ...records };
    const id = (typeof newId === "function" ? newId() : null) ?? (typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    const preKey = PRECHECK_PREFIX + area;
    let checked = false;
    try {
      await store.putVerified("areas", { area: preKey, of: area, id, keys, savedAt: new Date(now()).toISOString(), schema: keys.spelldash_schema_version ?? null, sum: sumOf(keys) });
      checked = true;
    } finally {
      // 予行の写しは、確かめても確かめられなくても消す（読み直しが合わなかった写しも残さない）。確かめた後に消せなければ失敗
      try {
        await store.remove("areas", preKey);
      } catch (error) {
        if (checked) throw error;
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: isQuotaError(error) ? "quota" : "evacuate" };
  } finally {
    store.close();
  }
}

// ログアウトは scope local（この端末のセッションだけ。ほかの端末のログインを切らない）。部品の答えの error をそのまま返す
export async function signOutLocal(auth) {
  const result = await auth.signOut({ scope: "local" });
  return { error: result?.error ?? null };
}

// アプリのページが切り替えの画面に頼んだこと（ログアウト）。読んだら消す。古い頼み（2 分より前）は使わない
export function takeIntent(store = globalThis.sessionStorage, now = Date.now()) {
  try {
    const text = store.getItem(INTENT_KEY);
    store.removeItem(INTENT_KEY);
    const intent = text ? JSON.parse(text) : null;
    return intent && typeof intent.op === "string" && Number(intent.at) > 0 && now - Number(intent.at) < INTENT_TTL_MS ? intent : null;
  } catch {
    return null;
  }
}

// ===== 書き出し（復旧の画面の「記録を書き出す」） =====
// 端末の鍵（端末の設定・計測）と、人の記録 1 人分を、元の名前で書き出す。人の記録は、保存先ごとに次の 1 つ:
//   移行の前 … 旧い場所の記録（持ち主は付けない）
//   移行の途中（sd2.migrating がある）… 確かめた legacy（持ち主は移す先の領域）。legacy が読めなければ、残った旧い鍵に移した新しい鍵を重ねた物（持ち主は付けない）
//   移行の後 … index が ls を指す領域。それが無ければ（切り替えが途中で止まった）index が指す確かめた写し。index が idb を指す領域の localStorage の残りは
//              途中の物なので読まない。写しも読めなければ書き出さない（SwitchError "export"。途中の記録をその人の持ち主の値で出さない）
// 持ち主（§5）: ゲストは { kind: "guest" }、アカウントは { kind: "account", tag }（user id から作る安定した値。生の id は書かない）。
// 持ち主の鍵・同期の印など（K.EXPORT_EXCLUDE）は書き出さない
export async function exportRecords(ls, K, { digest = globalThis.crypto?.subtle, openStore = () => openAreaStore() } = {}) {
  const index = K.readJson(ls.get(K.INDEX_KEY)) ?? {};
  const migrating = K.readJson(ls.get(K.MIGRATING_KEY));
  const marker = K.parseMarker(ls.get(K.AREA_KEY));
  // 移行の後（終わりの印を書く直前で止まった形も: 領域の印があり index がその領域を ls と指す）
  const migrated = ls.get(K.MIGRATED_KEY) !== null || (!migrating && Boolean(marker) && index[marker.area]?.at === "ls");
  const data = {};
  for (const key of ls.keys()) {
    if (!key.startsWith(K.PREFIX) || key.startsWith(K.TEST_PREFIX) || key === K.PROBE_KEY || K.isPersonKey(key)) continue;
    const value = ls.get(key);
    if (value !== null) data[key] = value;
  }
  const oldPlace = () => {
    const out = {};
    for (const key of ls.keys()) {
      if (!K.isPersonKey(key) || key === K.PROBE_KEY) continue;
      const value = ls.get(key);
      if (value !== null && !(key === K.OWNER_KEY && value === K.OWNER_MOVED)) out[key] = value;
    }
    return out;
  };
  const inLs = (area) => {
    const out = {};
    for (const key of ls.keys()) {
      if (!key.startsWith(K.areaPrefix(area))) continue;
      const name = K.logicalKey(area, key);
      const value = ls.get(key);
      if (name !== null && name !== K.PROBE_KEY && value !== null) out[name] = value;
    }
    return out;
  };
  const readVerified = async (storeName, key, match) => {
    let store;
    try {
      store = await openStore();
    } catch {
      return null;
    }
    try {
      const record = await store.get(storeName, key);
      return record && match(record) && sumOf(record.keys) === record.sum ? record.keys : null;
    } catch {
      return null;
    } finally {
      store.close();
    }
  };
  let person;
  let area = null;
  if (migrating && typeof migrating.legacyId === "string") {
    const moving = typeof migrating.area === "string" ? migrating.area : null;
    person = await readVerified("legacy", migrating.legacyId, (record) => record.id === migrating.legacyId);
    if (person) area = moving;
    else person = { ...oldPlace(), ...(moving ? inLs(moving) : {}) };
  } else if (!migrated) {
    person = oldPlace();
  } else {
    area = Object.keys(index).find((a) => index[a]?.at === "ls") ?? null;
    if (area) person = inLs(area);
    else {
      area = marker?.area ?? null;
      const at = area ? index[area]?.at : null;
      person = typeof at === "string" && at.startsWith("idb:") ? await readVerified("areas", area, (record) => `idb:${record.id}` === at) : null;
      if (!person) throw fail("export");
    }
  }
  Object.assign(data, person);
  // バックアップと同じ鍵は入れない（持ち主の鍵は同期が書く生の user id・同期の印・送信待ち・ログアウトの時刻。js/backup.js EXCLUDE と同じ一覧）。
  // 行の中の生の user id（送れなかったご意見の行の user_id）も外す（js/backup.js exportValueOf と同じ決まり）
  for (const key of K.EXPORT_EXCLUDE ?? []) delete data[key];
  for (const key of Object.keys(data)) {
    const value = typeof K.exportValueOf === "function" ? K.exportValueOf(key, data[key]) : data[key];
    if (value === null) delete data[key];
    else data[key] = value;
  }
  const backup = { app: "SpellDash", version: 1, exportedAt: new Date().toISOString(), data };
  if (area) backup.owner = await ownerOf(area, digest);
  return backup;
}

// 復旧の画面の「記録はこの端末に残っている。」を出してよいか。index が IndexedDB の写しを指す領域の全部（移行の途中なら確かめた legacy も）を読めて、
// id と要約が合うときだけ真。localStorage にある領域は読める。写しが無い・合わない・控えの置き場が開けなければ偽（その文は出さない）
export async function copiesReadable(ls, K, { openStore = () => openAreaStore() } = {}) {
  const index = K.readJson(ls.get(K.INDEX_KEY));
  const entries = index && typeof index === "object" && !Array.isArray(index) ? Object.entries(index) : [];
  const copies = entries.filter(([, entry]) => typeof entry?.at === "string" && entry.at.startsWith("idb:"));
  const migrating = K.readJson(ls.get(K.MIGRATING_KEY));
  const legacyId = typeof migrating?.legacyId === "string" ? migrating.legacyId : null;
  if (copies.length === 0 && !legacyId) return true;
  let store;
  try {
    store = await openStore();
  } catch {
    return false;
  }
  try {
    if (legacyId) {
      const record = await store.get("legacy", legacyId);
      if (!record || record.id !== legacyId || sumOf(record.keys) !== record.sum) return false;
    }
    for (const [area, entry] of copies) {
      const record = await store.get("areas", area);
      if (!record || `idb:${record.id}` !== entry.at || sumOf(record.keys) !== record.sum) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    store.close();
  }
}

// 持ち主の値（§5）: tag = SHA-256("spelldash-backup-owner-v1:" + user id) の頭 32 字。端末ごとの乱数を使わない
export async function ownerOf(area, digest = globalThis.crypto?.subtle) {
  if (area === "guest") return { kind: "guest" };
  const userId = area.startsWith("u:") ? area.slice(2) : area;
  if (!digest || typeof digest.digest !== "function") return { kind: "account", tag: null };
  const bytes = new Uint8Array(await digest.digest("SHA-256", new TextEncoder().encode(`spelldash-backup-owner-v1:${userId}`)));
  const tag = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return { kind: "account", tag };
}

// ===== 切り替えの画面 =====
function browserDeps() {
  const webStorage = globalThis.localStorage; // switch.html では見張りは包まない（生の口）
  return {
    ls: {
      get: (key) => webStorage.getItem(key),
      set: (key, value) => webStorage.setItem(key, value),
      remove: (key) => webStorage.removeItem(key),
      keys: () => {
        const out = [];
        for (let i = 0; i < webStorage.length; i++) {
          const key = webStorage.key(i);
          if (key !== null) out.push(key);
        }
        return out;
      }
    },
    keys: globalThis.SpellDashAreaKeys,
    openStore: () => openAreaStore(),
    locks: globalThis.navigator?.locks,
    newId: () => (typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : undefined) ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  };
}

// 戻り先は URL の # の後ろの back（見張りが /switch.html#back=… で開く）。? の後ろは読まない（ログインの戻りの値をサーバーへ送らないため、そこには置かない）
export function backFrom(loc) {
  try {
    return new URLSearchParams(String(loc?.hash ?? "").replace(/^#/, "")).get("back");
  } catch {
    return null;
  }
}

// 戻り先: 同じ origin のパスだけ。URL として読んでから origin を比べる（読むときにタブ・改行は消え、\ は / になるので、文字の形だけでは外へ出られる）。
// 制御文字と \ を含む値・切り替えの画面そのものは受けない。返すのはパス・パラメータ・# の後ろだけ
export function safeBack(value, origin = globalThis.location?.origin) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  const base = typeof origin === "string" && /^https?:\/\/[^/]+$/.test(origin) ? origin : "http://localhost";
  let url;
  try {
    url = new URL(value, base);
  } catch {
    return "/";
  }
  if (url.origin !== new URL(base).origin || url.pathname === "/switch.html") return "/";
  return url.pathname + url.search + url.hash;
}

// 復旧の画面の「もう一度」から開いた印（sessionStorage。このタブだけ。読んだら消す）。前に失敗した「移す？」の答えで、もう一度切り替える
export const RETRY_KEY = "sd2.retry";
export function takeRetry(store = globalThis.sessionStorage) {
  try {
    const value = store.getItem(RETRY_KEY) === "1";
    store.removeItem(RETRY_KEY);
    return value;
  } catch {
    return false;
  }
}

// 戻り先のページへの知らせ（js/auth.js が読んで文を出す）: logout・logout-failed・logout-blocked・login-cancelled
function setNotice(kind) {
  try {
    globalThis.sessionStorage.setItem(NOTICE_KEY, JSON.stringify({ kind, at: Date.now() }));
  } catch {
    // 知らせが出せなくても切り替えは済んでいる
  }
}

// 「移す？」の答えがまだ無い（切り替えの画面のロックの中）。ロックを放してから、このタブでたずねる
export class AskNeeded extends Error {
  constructor(target) {
    super("ask");
    this.name = "AskNeeded";
    this.target = target;
  }
}

// 「ゲストで学んだ記録を、このアカウントに移す？」をたずねる。排他のロックの外で、切り替えの画面を開いたどのタブもたずねる（ロックを持つタブだけが
// たずねると、使っているタブや後から開いたタブは「記録を準備している…」のまま止まる。裏のタブは凍ることもある。反証）。答えたタブがロックを取って切り替える。
// ほかのタブで答えて切り替えが始まった・人が替わった（印・index・セッションの知らせ）ときは null（たずね直すか、もう要らないかをロックの中で確かめ直す）
function askOnPage(K) {
  return new Promise((resolve) => {
    const box = document.getElementById("switchAsk");
    const status = document.getElementById("switchStatus");
    const yes = document.getElementById("switchAskYes");
    const no = document.getElementById("switchAskNo");
    if (!box || !yes || !no) {
      resolve("no"); // たずねられなければ移さない（混ぜない方）
      return;
    }
    const first = box.hidden;
    if (status) status.hidden = true;
    box.hidden = false;
    const watched = new Set([K.AREA_KEY, K.INDEX_KEY, K.SWITCH_KEY, K.MIGRATING_KEY, K.MIGRATED_KEY, K.DECISION_KEY, K.AUTH_KEY, K.AUTH_KEY + "-user"]);
    const finish = (answer) => {
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
      removeEventListener("storage", onStorage);
      if (answer !== null) {
        box.hidden = true;
        if (status) {
          status.hidden = false;
          status.textContent = "記録を準備している…";
        }
      }
      resolve(answer);
    };
    const onYes = () => finish("yes");
    const onNo = () => finish("no");
    const onStorage = (event) => {
      if (event.key === null || watched.has(event.key)) finish(null);
    };
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
    addEventListener("storage", onStorage);
    if (first) document.getElementById("switchAskLead")?.focus();
  });
}

// 問いの欄を閉じる（たずねなくてよくなった）
function hideAsk() {
  const box = document.getElementById("switchAsk");
  const status = document.getElementById("switchStatus");
  if (box && !box.hidden) {
    box.hidden = true;
    if (status) {
      status.hidden = false;
      status.textContent = "記録を準備している…";
    }
  }
}

// 今のセッションの人の領域が localStorage にそろっているか（ログアウトが止まったとき、何も替わっていなければ元のページへ戻す）
function sessionMatchesArea(K) {
  const raw = browserDeps().ls;
  const session = K.areaOfUser(K.sessionUserOf(raw.get(K.AUTH_KEY), raw.get(K.AUTH_KEY + "-user")));
  const marker = K.parseMarker(raw.get(K.AREA_KEY));
  const index = K.readJson(raw.get(K.INDEX_KEY)) ?? {};
  return Boolean(marker) && marker.area === session && index[session]?.at === "ls" && raw.get(K.SWITCH_KEY) === null;
}

async function runSwitchPage() {
  const status = document.getElementById("switchStatus");
  const back = safeBack(backFrom(location), location.origin);
  const K = globalThis.SpellDashAreaKeys;
  const locks = globalThis.navigator?.locks;
  if (!K) return showRecovery(fail("load"));
  if (!locks || typeof locks.request !== "function") return showRecovery(fail("locks"));
  const intent = takeIntent();
  const retry = takeRetry();
  // 「移す？」の答え（このタブで受けた物。どの切り替え先の問いか）。ロックの中では、同じ切り替え先の答えだけを使う。
  // ほかのタブの答えが先に端末に残っていれば、そちらを使う（このタブの答えは捨てる: js/areaSwitch.js ensureArea）
  let answer = null;
  const switcher = createSwitcher({
    ...browserDeps(),
    ask: async (target) => {
      if (answer && answer.target === target) return answer.value;
      throw new AskNeeded(target);
    },
    // ログアウトの部品はこの時だけ読む（オフラインで読めなければ失敗: 何も替えない）
    signOut: async () => signOutLocal((await import("./supabase.js")).supabase.auth)
  });
  try {
    for (;;) {
      try {
        await locks.request(K.SWITCH_LOCK, () => switcher.settle(intent, { retry }));
        break;
      } catch (error) {
        if (!(error instanceof AskNeeded)) throw error;
        // ロックを放してからたずねる（ほかのタブも同じくたずねる）。答えたらロックを取り直し、まだ同じ問いが要るかを確かめてから切り替える
        const value = await askOnPage(K);
        answer = value === null ? null : { target: error.target, value };
      }
    }
    hideAsk();
  } catch (error) {
    hideAsk();
    const reason = error instanceof SwitchError ? error : fail("evacuate", error);
    // ログアウトが止まって何も替わっていない（ログインも記録もそのまま）: 元のページへ戻して文を出す
    if (intent?.op === "logout" && sessionMatchesArea(K)) {
      setNotice(reason.reason === "signout" ? "logout-failed" : "logout-blocked");
      location.replace(back);
      return;
    }
    return showRecovery(reason);
  }
  if (intent?.op === "logout") {
    const raw = browserDeps().ls;
    const signedOut = K.sessionUserOf(raw.get(K.AUTH_KEY), raw.get(K.AUTH_KEY + "-user")) === null;
    setNotice(signedOut ? (intent.notice === "login-cancelled" ? "login-cancelled" : "logout") : "logout-failed");
  }
  if (status) status.textContent = "開いている…";
  location.replace(back);
}

function showRecovery(error) {
  const box = document.getElementById("switchRecovery");
  const status = document.getElementById("switchStatus");
  if (status) status.hidden = true;
  if (!box) return;
  box.hidden = false;
  box.dataset.reason = error?.reason ?? "evacuate";
  const lead = document.getElementById("switchLead");
  if (lead) lead.textContent = "この端末に記録を安全に保存できなかったため、切り替えられません。";
  const quota = document.getElementById("switchQuota");
  if (quota) quota.hidden = error?.reason !== "quota";
  // 「移す？」に決まった答えがあれば出す（「もう一度」はこの答えのまま続ける。ほかのタブで後から押した答えでは替えない）
  const decisionLine = document.getElementById("switchDecision");
  if (decisionLine) {
    const deps = browserDeps();
    const d = deps.keys ? deps.keys.readJson(deps.ls.get(deps.keys.DECISION_KEY)) : null;
    const shown = d && (d.answer === "yes" || d.answer === "no");
    decisionLine.hidden = !shown;
    if (shown) decisionLine.textContent = `「ゲストで学んだ記録を、このアカウントに移す？」の答えは「${d.answer === "yes" ? "はい" : "いいえ"}」。「もう一度」で、この答えのまま続ける。`;
  }
  // 「記録はこの端末に残っている。」は写しを確かめてから出す（読めない写しがあれば、読めなかったことを出す）
  const kept = document.getElementById("switchKept");
  const lost = document.getElementById("switchLost");
  if (kept && lost) {
    kept.hidden = true;
    lost.hidden = true;
    const deps = browserDeps();
    (deps.keys ? copiesReadable(deps.ls, deps.keys, { openStore: deps.openStore }) : Promise.resolve(false)).then(
      (readable) => {
        kept.hidden = !readable;
        lost.hidden = readable;
      },
      () => {
        lost.hidden = false;
      }
    );
  }
  const exportButton = document.getElementById("switchExport");
  if (exportButton && !exportButton.dataset.wired) {
    exportButton.dataset.wired = "1";
    exportButton.addEventListener("click", async () => {
      const deps = browserDeps();
      if (!deps.keys) return;
      const failLine = document.getElementById("switchExportFail");
      let backup;
      try {
        backup = await exportRecords(deps.ls, deps.keys);
      } catch {
        // 記録の控えを読めない（途中の記録は出さない）
        if (failLine) failLine.hidden = false;
        return;
      }
      if (failLine) failLine.hidden = true;
      const json = JSON.stringify(backup, null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      const d = new Date();
      a.href = url;
      a.download = `spelldash-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  const retry = document.getElementById("switchRetry");
  if (retry && !retry.dataset.wired) {
    retry.dataset.wired = "1";
    retry.addEventListener("click", () => {
      try {
        globalThis.sessionStorage.setItem(RETRY_KEY, "1");
      } catch {
        // 印が残せなくても開き直す（前に失敗した「移す？」の答えは、そのまま止まって出る）
      }
      location.reload();
    });
  }
}

// 切り替えの画面: 部品が読めた印を付けてから流す（読めないとき〔オフライン・取れない〕は switch.html の小さい script が復旧の画面を出す）
if (typeof document !== "undefined" && document.documentElement?.hasAttribute("data-area-switch")) {
  document.documentElement.dataset.switchReady = "1";
  runSwitchPage();
}
