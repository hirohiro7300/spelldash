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
// migrate（移行の書き込み）・open（控えの置き場が使えない）・locks（排他のロックが使えない）・load（見張りが読めない）・changed（途中で変わった）
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
    } else {
      // 1. 旧い鍵の人の記録を全部 legacy に写す → 読み直して比べる。失敗なら旧い記録はそのまま
      const old = {};
      for (const key of legacyKeys()) old[key] = ls.get(key);
      legacy = { id: newId(), savedAt: iso(), fromSchema: old[K.PREFIX + "schema_version"] ?? null, keys: old, sum: sumOf(old) };
      await askPersistOnce();
      try {
        await store.putVerified("legacy", legacy);
      } catch (error) {
        throw fail(isQuotaError(error) ? "quota" : "legacy", error);
      }
      // 2. 領域を決める
      state = { legacyId: legacy.id, area: decideArea(old), at: iso() };
      ls.set(K.MIGRATING_KEY, JSON.stringify(state));
    }
    const area = state.area;
    // 3. 新しい鍵へ書く（入らなければ、その鍵の旧い本体を消してから書く。中身は legacy にある）→ 読み直して legacy と比べる
    try {
      for (const [name, value] of Object.entries(legacy.keys)) {
        const phys = K.physicalKey(area, name);
        if (ls.get(phys) === value) continue;
        try {
          ls.set(phys, value);
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          ls.remove(name);
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
    // 5. 印を書く
    const at = iso();
    writeIndex({ ...readIndex(), [area]: { at: "ls", lastUsedAt: at } });
    ls.set(K.AREA_KEY, K.formatMarker(area, 1));
    ls.set(K.MIGRATED_KEY, JSON.stringify({ at, fromSchema: legacy.fromSchema, legacyId: legacy.id }));
    ls.remove(K.MIGRATING_KEY);
    return area;
  }

  // 認証のセッションを新しい鍵へ移して、旧い鍵を消す（旧コードのタブの認証の部品は新しい鍵を読まない）
  function moveAuth() {
    for (const suffix of ["", "-user"]) {
      const oldKey = K.OLD_AUTH_KEY + suffix;
      const newKey = K.AUTH_KEY + suffix;
      const value = ls.get(oldKey);
      if (value === null) continue;
      if (ls.get(newKey) === null) {
        ls.set(newKey, value);
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

  // ===== 直し（§3。sd2.switch が残っていた: タブを閉じた・落ちた） =====
  // index が指す方だけが本物。index が idb を指す領域の localStorage の残り（途中まで消した F・途中まで書いた T）は、確かめた写しと同じか
  // 写しの一部なので消す。index が ls を指す領域はそのまま。古い写しは index が指さないので戻さない
  function repair() {
    const index = readIndex();
    let removed = 0;
    for (const [area, entry] of Object.entries(index)) {
      if (typeof entry?.at !== "string" || !entry.at.startsWith("idb:")) continue;
      for (const key of physicalOf(area)) {
        ls.remove(key);
        removed++;
      }
    }
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
    // 1. 印を書く（ほかのタブは知らせで切り替えの画面へ移る）
    ls.set(K.SWITCH_KEY, JSON.stringify(flag));
    // 2. ページの持ち主が 0 になるのを最大 3 秒待つ + 300ms（凍ったタブが残っても進める。3 の後は書けない）
    await drain();
    // 3. swap の段。ここから人の記録への書き込みは、どのタブでも拒まれる
    ls.set(K.SWITCH_KEY, JSON.stringify({ ...flag, phase: "swap" }));
    const stop = (reason, cause = null) => {
      ls.remove(K.SWITCH_KEY);
      return fail(reason, cause);
    };
    // 4. 切り替え先でない localStorage の領域（ふつうは F の 1 つ）を IndexedDB に写す → 読み直して比べる。
    // 失敗なら止める（F は localStorage のまま・印も index も替えない）
    const archived = [];
    for (const area of live.filter((a) => a !== target)) {
      const snapshot = collect(area);
      await askPersistOnce();
      try {
        await store.putVerified("areas", { area, id, keys: snapshot, savedAt: iso(), schema: snapshot[K.PREFIX + "schema_version"] ?? null, sum: sumOf(snapshot) });
      } catch (error) {
        throw stop(isQuotaError(error) ? "quota" : "evacuate", error);
      }
      if (!sameKeys(collect(area), snapshot)) throw stop("changed");
      archived.push([area, snapshot]);
    }
    // 切り替え先を、元を消す前に読む（読めなければ元を消さずに止める）
    let incoming = null;
    const targetAt = readIndex()[target]?.at;
    if (typeof targetAt === "string" && targetAt.startsWith("idb:")) {
      let record;
      try {
        record = await store.get("areas", target);
      } catch (error) {
        throw stop("target", error);
      }
      if (!record || `idb:${record.id}` !== targetAt || sumOf(record.keys) !== record.sum) throw stop("target");
      incoming = record.keys;
    }
    // 6. index[F] = idb → F の鍵を localStorage から消す
    for (const [area] of archived) {
      writeIndex({ ...readIndex(), [area]: { at: `idb:${id}`, lastUsedAt: iso() } });
      for (const key of physicalOf(area)) ls.remove(key);
    }
    // 7. T を localStorage に全部書く。容量で書けなければ、T の鍵を消し、F を写しから書き戻して index[F] = ls。印は替えない
    if (incoming) {
      try {
        for (const [name, value] of Object.entries(incoming)) ls.set(K.physicalKey(target, name), value);
        if (!sameKeys(collect(target), incoming)) throw new AreaStoreError("verify", "切り替え先を書き戻すと中身が合わなかった。");
      } catch (error) {
        for (const key of physicalOf(target)) ls.remove(key);
        for (const [area, snapshot] of archived) {
          try {
            for (const [name, value] of Object.entries(snapshot)) ls.set(K.physicalKey(area, name), value);
            if (!sameKeys(collect(area), snapshot)) throw new AreaStoreError("verify", "元の記録を書き戻すと中身が合わなかった。");
            writeIndex({ ...readIndex(), [area]: { at: "ls", lastUsedAt: iso() } });
          } catch {
            // 書き戻せなければ、元は確かめた写し（index が指す）にある。localStorage の残りは消す
            for (const key of physicalOf(area)) ls.remove(key);
          }
        }
        throw stop(isQuotaError(error) ? "quota" : "target", error);
      }
    }
    // 8. index[T] = ls（新しければ作る）
    writeIndex({ ...readIndex(), [target]: { at: "ls", lastUsedAt: iso() } });
    // 9. 印を 1 回で替える。途中の印を消す
    ls.set(K.AREA_KEY, K.formatMarker(target, gen));
    ls.remove(K.SWITCH_KEY);
    return { from, to: target, gen };
  }

  // 今のセッションに合う領域にする（同じで localStorage にあれば何もしない）
  async function ensureArea(store, target = sessionArea()) {
    const marker = markerNow();
    const live = liveAreas();
    if (marker?.area === target && live.length === 1 && live[0] === target) return null;
    return switchTo(store, target);
  }

  // ロックの中で流す全部: 直し → 移行 → 片付け → 今のセッションの領域へ
  async function settle() {
    let store;
    try {
      store = await openStore();
    } catch (error) {
      throw fail(error?.code === "quota" ? "quota" : "open", error);
    }
    try {
      if (ls.get(K.SWITCH_KEY) !== null) repair();
      if (ls.get(K.MIGRATED_KEY) === null || ls.get(K.MIGRATING_KEY) !== null) await migrate(store);
      try {
        await sweepOrphans(store);
      } catch {
        // 片付けられなくても切り替えは続ける（旧い場所の値は読まない）
      }
      return await ensureArea(store);
    } finally {
      store.close();
    }
  }

  return { settle, migrate, repair, switchTo, ensureArea, sweepOrphans, decideArea, sessionArea, collect, readIndex };
}

// ===== アプリのページから（見張りが旧い場所の値を見つけたとき）: 手の空いたときに片付ける =====
// raw は見張りが渡す生の localStorage の口。ほかのタブが切り替え・移行をしている間は何もしない（次に開いたとき）
export async function sweepOrphansFromPage(raw) {
  const K = globalThis.SpellDashAreaKeys;
  const locks = globalThis.navigator?.locks;
  if (!K || !locks || !raw) return 0;
  return locks.request(K.SWITCH_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return 0;
    const switcher = createSwitcher({ ls: raw, keys: K, openStore: () => openAreaStore(), locks });
    const store = await openAreaStore();
    try {
      return await switcher.sweepOrphans(store);
    } finally {
      store.close();
    }
  });
}

// ===== 書き出し（復旧の画面の「記録を書き出す」） =====
// 今の localStorage の領域（index が ls を指す領域。無ければ印の領域）の記録と端末の鍵を、元の名前で書き出す。
// 移行の前なら旧い場所の記録。持ち主（§5）: ゲストは { kind: "guest" }、アカウントは { kind: "account", tag }（user id から作る安定した値。生の id は書かない）
export async function exportRecords(ls, K, digest = globalThis.crypto?.subtle) {
  const migrated = ls.get(K.MIGRATED_KEY) !== null;
  const index = K.readJson(ls.get(K.INDEX_KEY)) ?? {};
  const live = migrated ? (Object.keys(index).find((area) => index[area]?.at === "ls") ?? K.parseMarker(ls.get(K.AREA_KEY))?.area ?? null) : null;
  const data = {};
  for (const key of ls.keys()) {
    const value = ls.get(key);
    if (value === null || key === K.PROBE_KEY) continue;
    if (live && key.startsWith(K.areaPrefix(live))) {
      const name = K.logicalKey(live, key);
      if (name !== K.PROBE_KEY) data[name] = value;
      continue;
    }
    if (!key.startsWith(K.PREFIX) || key.startsWith(K.TEST_PREFIX)) continue;
    if (migrated && K.isPersonKey(key)) continue; // 移行の後の旧い場所の値（旧コードのタブ）は書き出さない
    data[key] = value;
  }
  const backup = { app: "SpellDash", version: 1, exportedAt: new Date().toISOString(), data };
  if (live) backup.owner = await ownerOf(live, digest);
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
  const store = globalThis.localStorage; // switch.html では見張りは包まない（生の口）
  return {
    ls: {
      get: (key) => store.getItem(key),
      set: (key, value) => store.setItem(key, value),
      remove: (key) => store.removeItem(key),
      keys: () => {
        const out = [];
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
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

// 戻り先: 同じ origin のパスだけ（切り替えの画面そのものと、外への URL は受けない）
export function safeBack(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.split(/[?#]/)[0] === "/switch.html") return "/";
  return value;
}

async function runSwitchPage() {
  const status = document.getElementById("switchStatus");
  const back = safeBack(new URL(location.href).searchParams.get("back"));
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
      const backup = await exportRecords(deps.ls, deps.keys);
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

if (typeof document !== "undefined" && document.documentElement?.hasAttribute("data-area-switch")) runSwitchPage();
