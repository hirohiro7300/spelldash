// ===== スラング（Batch 80。docs/SPEC_SLANG.md） =====
// 組み込みの一覧（js/slangData.js）と、人ごとの 3 状態（これから・あやふや・覚えた）の保存 spelldash_slang。
// 鍵は人の記録（js/areaGuard.js の端末の鍵の一覧に無い鍵はみな人ごと）: ゲスト → A の「はい」で移り、A と B は別々、バックアップに入る。
// 保存するのは項目ごとの状態だけ { "<id>": { ls, lsd?, lsAt } }（一覧そのものは持たない）。クラウドへの同期はしない（表が無い）。
// 決まりはマイ単語帳と同じ（js/myWordsCore.js: 3 状態は js/learnState.js applyLearnAnswer・列 これから → あやふや → 覚えた・1 回 10 語・打ち方）。
// 語の記録（spelldash_word_stats）・送る 15 列・マイ単語帳の鍵・中心の学習の続きには書かない。画面は slang.html（js/slangPage.js）、学ぶ回は js/game.js（/?learn=slang）

import { SLANG, SLANG_GROUPS } from "./slangData.js";
import { wordCardOf, applyMyAnswer, countMyStates, myStateOf } from "./myWordsCore.js";
import { isAnswerKind } from "./learnState.js";

export { SLANG, SLANG_GROUPS };
export const SLANG_KEY = "spelldash_slang";
export const SLANG_URL = "/slang.html";
export const GROUP_PARAM = "group"; // 学ぶ回と画面の絞り込み（?group=daily|work|net。無ければ すべて）

const GROUP_IDS = new Set(SLANG_GROUPS.map((g) => g.id));
const BY_ID = new Map(SLANG.map((e) => [e.id, e]));

// 読めるグループの値（無い・読めない値は "" = すべて）
export function parseGroup(value) {
  const v = String(value ?? "").trim();
  return GROUP_IDS.has(v) ? v : "";
}

export function groupOf(id) {
  return SLANG_GROUPS.find((g) => g.id === id) ?? null;
}

// 保存の値を読む。無ければ空。読めない値（壊れた JSON・形が違う）は ok: false（書き手は上書きしない）。
// storage は単体の検査だけが渡す（ふだんは localStorage。js/areaGuard.js が包んだ口をそのまま呼ぶ）
export function readSlangProgress(storage = null) {
  let raw = null;
  try {
    raw = (storage ? storage.getItem(SLANG_KEY) : localStorage.getItem(SLANG_KEY)) ?? null;
  } catch {
    return { ok: false, map: {} };
  }
  if (!raw) return { ok: true, map: {} };
  try {
    const map = JSON.parse(raw);
    return map && typeof map === "object" && !Array.isArray(map) ? { ok: true, map } : { ok: false, map: {} };
  } catch {
    return { ok: false, map: {} };
  }
}

// 一覧の項目に今の状態を重ねた形（js/myWordsCore.js の語の形: en = 鍵〔小文字〕・text = 画面の形・ls・lsd・lsAt）。group で絞る
export function slangEntries(group = "", map = readSlangProgress().map) {
  const g = parseGroup(group);
  const out = [];
  for (const e of SLANG) {
    if (g && e.g !== g) continue;
    const st = map?.[e.id];
    const row = { ...e, en: e.en.toLowerCase(), text: e.en };
    if (st && typeof st === "object") {
      if (st.ls !== undefined) row.ls = st.ls;
      if (st.lsd !== undefined) row.lsd = st.lsd;
      if (st.lsAt !== undefined) row.lsAt = st.lsAt;
    }
    out.push(row);
  }
  return out;
}

// 出題のカード（js/myWordsCore.js wordCardOf と同じ形。id は slang-…・略語は全文入力・ヒントと答えの後に使い方の 1 行・例文）
export function slangCardOf(e) {
  const row = { ...e, en: e.en.toLowerCase(), text: e.en };
  const card = { ...wordCardOf(row), id: e.id, tags: ["slang"], category: "slang", explain: e.note, note: e.note, ex: e.ex, exJa: e.exJa };
  if (e.exForm) card.exForm = e.exForm;
  if (e.abbr) card.free = true;
  delete card.addedAt;
  return card;
}

const CARDS = new Map();
export function slangCard(id) {
  if (!BY_ID.has(id)) return null;
  if (!CARDS.has(id)) CARDS.set(id, slangCardOf(BY_ID.get(id)));
  return CARDS.get(id);
}

// 1 問の答えをその項目の状態に書く（kind = js/learnState.js ANSWER_KINDS の値）。書けたら true。読めない保存の値は上書きしない（false）
export function recordSlangAnswer(id, kind, nowMs = Date.now(), storage = null) {
  if (!isAnswerKind(kind) || !BY_ID.has(id)) return false;
  const { ok, map } = readSlangProgress(storage);
  if (!ok) return false;
  try {
    const cur = map[id] && typeof map[id] === "object" ? map[id] : {};
    const next = applyMyAnswer(cur, kind, nowMs);
    const rec = { ls: next.ls, lsAt: next.lsAt };
    if (next.lsd !== undefined) rec.lsd = next.lsd;
    const text = JSON.stringify({ ...map, [id]: rec });
    if (storage) storage.setItem(SLANG_KEY, text);
    else localStorage.setItem(SLANG_KEY, text);
    return true;
  } catch {
    return false;
  }
}

// 3 状態の数（group で絞る）。new + unsure + learned = total
export function countSlang(group = "", map = readSlangProgress().map) {
  return countMyStates(slangEntries(group, map));
}

export function slangStateOf(entry) {
  return myStateOf(entry);
}

// 学ぶ回の材料（js/game.js beginMyLearn。マイ単語帳の回と同じ機械に渡す）。語の記録に書かない（noStats）
export function slangLearnSource(group = "") {
  const g = parseGroup(group);
  const short = groupOf(g)?.short ?? "";
  return {
    kind: "slang",
    label: "スラング",
    countLabel: short ? `スラング（${short}）` : "スラング",
    url: g ? `${SLANG_URL}?${GROUP_PARAM}=${g}` : SLANG_URL,
    linkId: "learnSlang",
    noStats: true,
    list: () => slangEntries(g),
    idOf: (w) => w.id,
    find: (id) => (g && BY_ID.get(id)?.g !== g ? null : slangCard(id)),
    entryOf: (word) => slangEntries(g).find((w) => w.id === word?.id) ?? null,
    record: (word, kind) => recordSlangAnswer(word.id, kind),
    emptyTitle: "スラングが無い",
    emptyNote: "スラングの一覧から始める。",
    doneNote: "スラングを、ひととおり学んだ。"
  };
}
