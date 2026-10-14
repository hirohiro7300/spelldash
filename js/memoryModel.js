// ===== 記憶の強さの式（影の計算。純関数） =====
// DOM なし・localStorage なし・import なし（Node から直に import して確かめる: scripts/test-memory.mjs）。
// 語ごとに S（安定性: 思い出せる見込みが 0.9 に下がるまでの日数）と D（難しさ 1〜10）を持ち、見込みは冪の忘却曲線で読む
// （難しさ・安定性の式）。日はローカルの暦日の差（整数）。数はどれも仮の値で、設計の写し（docs/SPEC_MASTERY.md「記録の質」）。
//
// この Batch では出題に使わない（影の計算）。js/stats.js の書き手が、伸び率の違う 7 通りの S（memSv）と共通の D（memD・memD0）を
// 語ごとに更新し（0.1 刻みの整数で書く: writeShadow）、答える前の見込みと結果の当たりを js/memoryCheck.js の集計（cal）に数えるだけ。
// 期日・段・streak は今の規則のまま。

// 既定（速さを間隔に使わない）。速さありの通りは P_SPEED（影の 1 通り）
export const P_SPEED = Object.freeze({
  target: 0.9, // 目標の保持率（仮の出発点）
  F: 19 / 81, // 曲線 R(t) = (1 + F t / S)^C。t = S のとき 0.9
  C: -0.5,
  G0: 1.5, // 伸び率: 難しさ 5・ふつうの速さ・期日どおりの正解で S を何倍にするか（今の表に近い値から始める）
  dSlope: 0.12, // 難しさが 1 上がるごとに伸び（G − 1）を 12% 減らす（D=5 で G0、D=10 で 4 割、D=1 で 1.48 倍）
  speedMul: { fast: 1.5, normal: 1, slow: 0.5, unknown: 1 }, // 速さは伸び（G − 1）に掛ける
  rMulMin: 0.1, // 期日前の答え（見込みが高い）はほとんど伸ばさない（見込み 0.99 で 1 割）
  rMulMax: 2, // 遅れて思い出せた答え（見込みが低い）の伸びは 2 倍まで
  lapse: 0.3, // ×: S を 0.3 倍（0 にしない）
  sMin: 1,
  sMax: 730,
  dLapse: 1,
  dStep: { fast: -0.3, normal: -0.1, slow: 0.2, unknown: 0 },
  dTypo: 0.3,
  dRevert: 0.1, // 難しさは毎回 1 割だけ初めの値へ戻す
  knownS: 14, // 知ってた語は 2 週間後に確認（今と同じ）
  knownD: { fast: 2, normal: 3, unknown: 3, slow: 4 },
  iMax: 90, // 間隔の上限（間隔を直す段の始め。実測で 180 へ）
  floors: { 4: 7, 5: 30 }, // 段ごとの下限（今の S3 と同じ。遅い答えには当てない）
  floorGap: { 5: 14 } // 即答の 30 日の下限は前の答えから 14 日以上あいた答えだけ。短いときは 1 つ下の段の下限（7 日）
});

// 既定: 速さは間隔に入れない（伸び・難しさの動き・知ってた語の初めの難しさを速さで変えない）
export const SPEED_OFF = Object.freeze({
  speedMul: { fast: 1, normal: 1, slow: 1, unknown: 1 },
  dStep: { fast: -0.1, normal: -0.1, slow: -0.1, unknown: -0.1 },
  knownD: { fast: 3, normal: 3, unknown: 3, slow: 3 }
});
export const P = Object.freeze({ ...P_SPEED, ...SPEED_OFF });

// 影の 7 通り: 伸び率 6 通り（速さなし）と「1.5・速さあり」。D は共通（P の動き）。memSv の並びはこの順
export const VARIANTS = Object.freeze([
  Object.freeze({ ...P, G0: 1.3 }),
  Object.freeze({ ...P, G0: 1.5 }),
  Object.freeze({ ...P, G0: 1.8 }),
  Object.freeze({ ...P, G0: 2.2 }),
  Object.freeze({ ...P, G0: 2.7 }),
  Object.freeze({ ...P, G0: 3.3 }),
  Object.freeze({ ...P_SPEED, G0: 1.5 })
]);
export const VARIANT_NAMES = Object.freeze(["1.3", "1.5", "1.8", "2.2", "2.7", "3.3", "1.5s"]);
export const BASE_VARIANT = 1; // 今の伸び率の出発点（G0 1.5・速さなし）。損失の差の基準・速さの材料 (b) の S

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round1 = (x) => Math.round(x * 10) / 10;

// 見込み。S が 0 以下（まだ覚えていない）は 0
export function R(t, S, p = P) {
  if (!(S > 0)) return 0;
  return Math.pow(1 + (p.F * Math.max(0, t)) / S, p.C);
}

// 目標の保持率に下がるまでの日数（S の何倍か）。目標 0.9 で 1、0.85 で 1.64、0.95 で 0.46
export function intervalFactor(target = P.target, p = P) {
  return (Math.pow(target, 1 / p.C) - 1) / p.F;
}

export function growthBase(D, p = P) {
  const k = clamp(1 + p.dSlope * (5 - D), 0.4, 1.48);
  return 1 + (p.G0 - 1) * k;
}

// 初めての答え。kind: "x"（思い出せず）| "typo"（打ち間違いありの正解）| "clean"（ノーミス）
export function initState(kind, speed = "unknown", p = P) {
  if (kind === "clean") return { S: p.knownS, D: p.knownD[speed] ?? 3, D0: p.knownD[speed] ?? 3 };
  if (kind === "typo") return { S: 1, D: 5, D0: 5 };
  return { S: 0, D: 5, D0: 5 }; // まだ覚えていない（その日の最初の自力正解で S = 1）
}

// その日の最初の自力正解（同じ日の 2 回目以降は呼ばない）。t = 前の答えからの日数（1 以上）
export function onSuccess(st, { t, speed = "unknown", clean = true }, p = P) {
  if (!(st.S > 0)) return { ...st, S: 1 };
  if (!clean) return { ...st, D: clamp(st.D + p.dTypo, 1, 10) };
  const r = R(t, st.S, p);
  const mR = clamp((1 - r) / (1 - p.target), p.rMulMin, p.rMulMax);
  const G = growthBase(st.D, p);
  const g = 1 + (G - 1) * (p.speedMul[speed] ?? 1) * mR;
  const S = Math.min(p.sMax, Math.max(st.S, st.S * g));
  let D = clamp(st.D + (p.dStep[speed] ?? 0), 1, 10);
  D = D + p.dRevert * (st.D0 - D);
  return { ...st, S, D, lastR: r };
}

// その日の最初の ×
export function onFail(st, p = P) {
  const S = st.S > 0 ? Math.max(p.sMin, st.S * p.lapse) : 0;
  return { ...st, S, D: clamp(st.D + p.dLapse, 1, 10) };
}

// 次の間隔（日）。rank = 答えた後の段、speed = この答えの速さ。noFloor: 段の下限をかけない。gap: 前の答えからの日数
// （この Batch では使わない。間隔を直す段のための写し）
export function nextInterval(st, { rank = 0, speed = "unknown", afterFail = false, noFloor = false, gap = null } = {}, p = P) {
  if (afterFail || !(st.S > 0)) return 1;
  let I = Math.round(st.S * intervalFactor(p.target, p));
  let fl = p.floors[rank] ?? 0;
  if (p.floorGap && p.floorGap[rank] && !(typeof gap === "number" && gap >= p.floorGap[rank])) fl = p.floors[rank - 1] ?? 0;
  if (!noFloor && speed !== "slow" && fl) I = Math.max(I, fl);
  return clamp(I, 1, p.iMax);
}

// ===== 今の記録からの初めの値（移行の S と D） =====
// 影の欄（memSv）が無い語を、次に答えたとき今の記録から作る（書くのは答えたときだけ）。引数は答える前の記録の読み:
//   everRecalled 自力正解が一度でもある（無ければまだ覚えていない: S 0）
//   unresolved   最後が ×（S 1）
//   knownWaiting 確認待ちの知ってた語（S 14）
//   mastered     習得（S 45: 10 回目の正解は 30 日あけた答え。30 × 1.5）
//   ほか         期日 − 最後の自力正解 の日数を 1〜30 に丸めた値（今の表の最後の間隔が今の強さの目安）。読めなければ 1
//   D = clamp(4 + min(recallFail, 5) − (知ってた語 ? 2 : 0), 1, 9)
export function migrateState({ everRecalled = false, unresolved = false, knownWaiting = false, mastered = false, dueMs = 0, okMs = 0, recallFail = 0, known = false } = {}) {
  const D = clamp(4 + Math.min(Math.max(0, Number(recallFail) || 0), 5) - (known ? 2 : 0), 1, 9);
  let S;
  if (!everRecalled && !mastered && !known) S = 0;
  else if (unresolved) S = 1;
  else if (knownWaiting) S = P.knownS;
  else if (mastered) S = 45;
  else S = dueMs > 0 && okMs > 0 ? clamp(Math.round((dueMs - okMs) / 86400000), 1, 30) : 1;
  return { S, D, D0: D };
}

// ===== 影の 7 通り（語ごとの記録 memSv・memD・memD0 の形） =====
// sh = { Sv: [7 つの S（日）], D, D0 }。記録には 0.1 刻みの整数で書く（memSv = S × 10、memD = D × 10、memD0 = D0 × 10。
// 小数を書かないのは、正解のたびに語の表を丸ごと JSON にする保存（js/storage.js）で小数の書き出しが重いため）。読むたびに同じ値から計算する

export function shadowOf(S, D, D0 = D) {
  return { Sv: VARIANTS.map(() => round1(S)), D: round1(D), D0: round1(D0) };
}

const tenths = (x) => Math.round(x * 10);

// 記録から読む（形が合わなければ null: 移行の値で作り直す）
export function readShadow(stat) {
  const Sv = stat?.memSv;
  if (!Array.isArray(Sv) || Sv.length !== VARIANTS.length || !Sv.every((s) => Number.isInteger(s) && s >= 0)) return null;
  const D = stat.memD;
  if (!Number.isInteger(D)) return null;
  const D0 = Number.isInteger(stat.memD0) ? stat.memD0 : D;
  return { Sv: Sv.map((s) => s / 10), D: clamp(D / 10, 1, 10), D0: clamp(D0 / 10, 1, 10) };
}

// 記録に書く（書き手の写しに memSv・memD・memD0 を置く）
export function writeShadow(stat, sh) {
  stat.memSv = sh.Sv.map(tenths);
  stat.memD = tenths(sh.D);
  stat.memD0 = tenths(sh.D0);
}

// 初めての答え。kind: "clean" | "typo" | "x"。D は速さなしの既定（共通）
export function shadowInit(kind) {
  const st = initState(kind, "unknown", P);
  return shadowOf(st.S, st.D, st.D0);
}

// 答える前の見込み（7 通り）。S が 0 以下の通りは null（まだ覚えていない語は予測しない）
export function shadowPredict(sh, t) {
  return sh.Sv.map((S, i) => (S > 0 ? R(t, S, VARIANTS[i]) : null));
}

// その日の最初の自力正解。S が 0（まだ覚えていない）の語は S = 1、D = min(7, 4 + それまでの × の回数)（xCount）。
// D は共通（速さなしの動き）、S は通りごとの伸び率（7 通り目だけ速さで伸びを変える）
export function shadowSuccess(sh, { t, speed = "unknown", clean = true, xCount = 0 }) {
  if (!(sh.Sv[BASE_VARIANT] > 0)) {
    const D = Math.min(7, 4 + Math.max(0, Number(xCount) || 0));
    return { Sv: sh.Sv.map(() => 1), D, D0: D };
  }
  if (!clean) return { ...sh, Sv: [...sh.Sv], D: clamp(sh.D + P.dTypo, 1, 10) };
  const Sv = sh.Sv.map((S, i) => onSuccess({ S, D: sh.D, D0: sh.D0 }, { t, speed, clean: true }, VARIANTS[i]).S);
  const common = onSuccess({ S: sh.Sv[BASE_VARIANT], D: sh.D, D0: sh.D0 }, { t, speed, clean: true }, P);
  return { Sv, D: common.D, D0: sh.D0 };
}

// 同じ日の答え: まだ覚えていない語の最初の自力正解だけ S = 1（その日の × の後の Recall Loop・初見の × の後の同日反復）。ほかは変えない
export function shadowSameDay(sh, { ok, xCount = 0 }) {
  if (!ok || sh.Sv[BASE_VARIANT] > 0) return sh;
  return shadowSuccess(sh, { t: 0, xCount });
}

// その日の最初の ×
export function shadowFail(sh) {
  const Sv = sh.Sv.map((S, i) => onFail({ S, D: sh.D }, VARIANTS[i]).S);
  return { Sv, D: clamp(sh.D + P.dLapse, 1, 10), D0: sh.D0 };
}

// 見込みの帯: 0 = 0.95 以上・1 = 0.9〜0.95・2 = 0.85〜0.9・3 = 0.8〜0.85・4 = 0.8 未満
export function predBand(r) {
  if (r >= 0.95) return 0;
  if (r >= 0.9) return 1;
  if (r >= 0.85) return 2;
  if (r >= 0.8) return 3;
  return 4;
}

// 対数損失（見込み r で、結果 ok）。r は 0.001〜0.999 に丸める
export function logLoss(r, ok) {
  const q = clamp(r, 0.001, 0.999);
  return ok ? -Math.log(q) : -Math.log(1 - q);
}
