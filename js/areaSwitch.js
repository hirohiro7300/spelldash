// ===== 切り替えの画面（switch.html）: 移行・直し・切り替え・旧い場所の片付け（docs は S/b78/acct/DESIGN-FINAL.md §3・§4・§8・§1.3） =====
// 学習の部品は読まない。排他のロック "spelldash-area-switch" を持つタブだけが、localStorage の人の記録の置き場所を変える。
// 決まり（不変条件）: localStorage に置く人の記録はいつも 1 人（今の領域）だけ。sd2.index が指す方だけが本物。
// 写して読み直して確かめてから index を替え、index を替えてから元を消す。容量で書けなければ部分的に有効にしない。
// 鍵の決まりは js/areaGuard.js（switch.html では data-switch で読み、window.SpellDashAreaKeys に置く）。
// この段（内部の 1）では、ログイン・ログアウトの確認（予行・はい／いいえ）は無い。今のセッションに合う領域へ、保存の層だけで切り替える。
import { openAreaStore, sumOf, sameKeys, isQuotaError, askPersist, AreaStoreError } from "./areaStore.js";

const DRAIN_MAX_MS = 3000;
const DRAIN_STEP_MS = 100;
const DRAIN_SETTLE_MS = 300;

// 切り替えられなかった理由。reason: evacuate（退避）・quota（容量）・target（切り替え先の控えが読めない）・legacy（移行の写し）・
// migrate（移行の書き込み）・open（控えの置き場が使えない）・locks（排他のロックが使えない）・load（見張りが読めない）・changed（途中で変わった）・
// export（書き出す記録の控えが読めない）。switch.html の小さい script は、部品が読めないときに offline
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
  return reason === "quota" ? "この端末の保存の空きが足りない。" : "この端末に記録を安全に保存できなかったため、切り替えられません。";
}

// deps: { ls: { get, set, remove, keys }（生の localStorage）, keys（js/areaGuard.js の SpellDashAreaKeys）, openStore, locks, now, newId, sleep, persist }
export function createSwitcher(deps) {
  const { ls, keys: K, openStore, locks } = deps;
  const now = deps.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const newId = deps.newId ?? (() => `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const persist = deps.persist ?? (() => askPersist());
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

  // その領域の記録を localStorage に全部書いて読み直す。書けない・合わなければ、書いた鍵（書いた値と同じ物）を消して例外（index は替えない）。
  // 書いた値と違う鍵（見え方の古いタブが同じ時に書いた）は消さない（退避した領域の残りとして sweepStale が写す）
  function writeArea(area, keys) {
    try {
      for (const [name, value] of Object.entries(keys)) ls.set(K.physicalKey(area, name), value);
      if (!sameKeys(collect(area), keys)) throw new AreaStoreError("verify", "書き戻すと中身が合わなかった。");
    } catch (error) {
      for (const [name, value] of Object.entries(keys)) {
        const phys = K.physicalKey(area, name);
        if (ls.get(phys) === value) ls.remove(phys);
      }
      throw error;
    }
  }
  // 元に戻す: 書けたら index を ls に。書けなければ、元は確かめた写し（index が指す）にあり、localStorage の残りは消してある
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

  async function switchTo(store, target, op = "session") {
    const marker = markerNow();
    const gen = (marker?.gen ?? 0) + 1;
    const id = newId();
    // 元 F は localStorage にある領域（印ではなく index で決める: 印を替える前に落ちた形では、印と index が食い違う）
    const live = liveAreas();
    const from = live.includes(marker?.area) ? marker.area : (live[0] ?? marker?.area ?? null);
    const flag = { id, op, from, to: target, phase: "drain", at: iso() };
    const targetBefore = readIndex()[target]; // 止めるときに戻す（手順 8 の後に止まった）
    // 1. 印を書く（ほかのタブは知らせで切り替えの画面へ移る）。入らなければ何も替えずに止める
    try {
      ls.set(K.SWITCH_KEY, JSON.stringify(flag));
    } catch (error) {
      throw fail(isQuotaError(error) ? "quota" : "evacuate", error);
    }
    const archived = [];
    let incoming = null;
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
      // 元の領域へ遅れて書かれた鍵（手順 6 の後）は、戻す前に orphans へ。写せなければ、戻すときに残りの値を写しに重ねる（その人の後の値。失わない）
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
      // 失敗なら止める（F は localStorage のまま・印も index も替えない）
      for (const area of live.filter((a) => a !== target)) {
        const snapshot = collect(area);
        await askPersistOnce();
        try {
          await store.putVerified("areas", { area, id, keys: snapshot, savedAt: iso(), schema: snapshot[K.PREFIX + "schema_version"] ?? null, sum: sumOf(snapshot) });
        } catch (error) {
          throw await stop(isQuotaError(error) ? "quota" : "evacuate", error);
        }
        if (!sameKeys(collect(area), snapshot)) throw await stop("changed");
        archived.push([area, snapshot]);
      }
      // 切り替え先を、元を消す前に読む（読めなければ元を消さずに止める）
      const targetAt = readIndex()[target]?.at;
      if (typeof targetAt === "string" && targetAt.startsWith("idb:")) {
        incoming = await readCopy(store, target);
        if (!incoming) throw await stop("target");
      }
      // 6. index[F] = idb → F の鍵を localStorage から消す。消す直前に、元が写しと同じかを確かめる（写しの後に遅れて書かれた値を消さない。
      // 確かめと消すのは同じ流れの中で、間にほかのタブの書き込みは入らない）
      for (const [area, snapshot] of archived) {
        if (!sameKeys(collect(area), snapshot)) throw await stop("changed");
        writeIndex({ ...readIndex(), [area]: { at: `idb:${id}`, lastUsedAt: iso() } });
        for (const key of physicalOf(area)) ls.remove(key);
      }
      // 7 の前: 切り替え先の領域に localStorage の残りがある（見え方の古いタブが前に書いた）。写しと違う値は orphans へ写してから消す（写しで上書きして失わない）
      if (!live.includes(target) && physicalOf(target).length > 0) {
        try {
          await sweepStale(store, { only: [target] });
        } catch (error) {
          throw await stop(isQuotaError(error) ? "quota" : "evacuate", error);
        }
        if (physicalOf(target).length > 0) throw await stop("changed");
      }
      // 7. T を localStorage に全部書く。容量で書けなければ、T の鍵を消し、F を写しから書き戻して index[F] = ls。印は替えない
      if (incoming) {
        wroteTarget = true;
        try {
          writeArea(target, incoming);
        } catch (error) {
          throw await stop(isQuotaError(error) ? "quota" : "target", error);
        }
      }
      // 8. index[T] = ls（新しければ作る）
      writeIndex({ ...readIndex(), [target]: { at: "ls", lastUsedAt: iso() } });
      // 9. 印を 1 回で替える。途中の印を消す
      ls.set(K.AREA_KEY, K.formatMarker(target, gen));
      ls.remove(K.SWITCH_KEY);
    } catch (error) {
      // 手順 3・6・8・9 の書き込みが入らない（容量）・ほかの例外: 同じ道で止める（復旧の画面は容量なら容量不足を出す）
      if (error instanceof SwitchError || stopping) throw error;
      throw await stop(isQuotaError(error) ? "quota" : "evacuate", error);
    }
    return { from, to: target, gen };
  }

  // 今のセッションに合う領域にする（同じで localStorage にあれば何もしない）。退避した領域の残りを写せなかった（staleError）ときは、
  // 切り替えずに止める（元の領域の残りを localStorage に置いたまま、別の領域を重ねて展開しない）
  async function ensureArea(store, target = sessionArea(), staleError = null) {
    const marker = markerNow();
    const live = liveAreas();
    if (marker?.area === target && live.length === 1 && live[0] === target) return null;
    if (staleError) throw fail(isQuotaError(staleError) ? "quota" : "evacuate", staleError);
    return switchTo(store, target);
  }

  // ロックの中で流す全部: 直し → 移行 → 片付け（旧い場所・退避した領域の残り） → 今のセッションの領域へ → 退避した領域の残りをもう一度
  async function settle() {
    let store;
    try {
      store = await openStore();
    } catch (error) {
      throw fail(error?.code === "quota" ? "quota" : "open", error);
    }
    try {
      if (ls.get(K.SWITCH_KEY) !== null) {
        try {
          await repair(store);
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
      const result = await ensureArea(store, sessionArea(), staleError);
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

  return { settle, migrate, repair, switchTo, ensureArea, sweepOrphans, sweepStale, decideArea, sessionArea, collect, readIndex };
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
  // バックアップと同じ鍵は入れない（持ち主の鍵は同期が書く生の user id・同期の印・送信待ち・ログアウトの時刻。js/backup.js EXCLUDE と同じ一覧）
  for (const key of K.EXPORT_EXCLUDE ?? []) delete data[key];
  const backup = { app: "SpellDash", version: 1, exportedAt: new Date().toISOString(), data };
  if (area) backup.owner = await ownerOf(area, digest);
  return backup;
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

async function runSwitchPage() {
  const status = document.getElementById("switchStatus");
  const back = safeBack(backFrom(location), location.origin);
  const K = globalThis.SpellDashAreaKeys;
  const locks = globalThis.navigator?.locks;
  if (!K) return showRecovery(fail("load"));
  if (!locks || typeof locks.request !== "function") return showRecovery(fail("locks"));
  const switcher = createSwitcher(browserDeps());
  try {
    await locks.request(K.SWITCH_LOCK, () => switcher.settle());
  } catch (error) {
    return showRecovery(error instanceof SwitchError ? error : fail("evacuate", error));
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
    retry.addEventListener("click", () => location.reload());
  }
}

// 切り替えの画面: 部品が読めた印を付けてから流す（読めないとき〔オフライン・取れない〕は switch.html の小さい script が復旧の画面を出す）
if (typeof document !== "undefined" && document.documentElement?.hasAttribute("data-area-switch")) {
  document.documentElement.dataset.switchReady = "1";
  runSwitchPage();
}
