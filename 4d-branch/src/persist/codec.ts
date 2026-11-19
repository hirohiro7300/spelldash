// 保存の口（コーデック）: 文書を保存先に書く形と、保存先から読む形を決める 1 か所。設計: 作業メモ SPEC v1 §6・R0 §6.1・§10.2 I1
//
// 書く: toStored(doc) → 保存する形（StoredDoc）。読む: fromStored(raw) / decodeStored(raw) → 手元で持つ文書（新しい入れ物）。
//   - ページの地図（同梱の 3 か月ごとの地図。setThinBaseline で入れる）を持つ文書は、地図の本体を省いた薄い形（版 2・maps つき。./thinMap.ts）
//   - それ以外の文書（地図が無い・版 6 の地図・ほかの年月の地図）は今までと同じ形のまま（同じ物を返す。既定のビルドは何も変わらない）
//   - 地図の基準を入れる前に、3 か月ごとの地図を持つ文書を書こうとしたら ThinBaselineMissingError（地図ごと書くと 7,000 万文字を超える: safety-15）。
//     ページの地図のカードが多いのに今日のカードが無い（壊れた形）ときも ThinWriteError で書かない
//   - 薄い形の文書（版 2 以上か maps がある）は、どんな失敗でも止める側の失敗（ThinMapError・NewerDocError）にする。壊れたデータと見なして
//     バックアップで始めたり、消したり、上書きしたりしない（safety-3）。版 1 の文書の読めない JSON・形だけが、今までどおり壊れたデータ
// 呼ぶ所（次の段でつなぐ。保存・同期・書き出し・履歴は、ほかの道で文書を書いたり読んだりしない）:
//   src/persist/persistence.ts（writeStored・writeEmergency・createBackup → toStored、readStored・readEmergencies・readBackup → fromStored）、
//   src/persist/cloud.ts（encodeDoc・decodeDoc）、src/persist/io.ts（exportText・previewImport）、src/store/history.ts（文書ごとの入れ替え）。
//   版の記録（IndexedDB の meta・バックアップの見出し・アカウントのマニフェスト）の docVersion は storedVersion(保存する形)
// 大きさの見張り（safety-15）: 1 MB を超えたら知らせる。localStorage（緊急コピー・小さな保存先）には 400 万文字を超えて書かない

import { NewerDocError, normalizeDoc, SCHEMA_VERSION, type NormalizeReport } from "../model/schema";
import type { DocData } from "../model/types";
import { decodeThin, encodeThin, isThinShape, ThinMapError, type StoredDoc, type ThinStats } from "./thinMap";

export { hasThinBaseline, isQuarterRoot, isThinShape, setThinBaseline, thinBaseline, thinBaselineDoc, ThinBaselineMissingError, ThinMapError, ThinNewerError, ThinWriteError, THIN_BASELINE_VERSION, THIN_LAYOUT } from "./thinMap";
export type { MapBase, PageMapRecord, StoredDoc, ThinErrorCode, ThinSection, ThinStats } from "./thinMap";

/** 書いた形の大きさがこれを超えたら知らせる（文字数。R0 I9 の目安の 1 MB） */
export const STORED_WARN_CHARS = 1_000_000;
/** localStorage（緊急コピー・小さな保存先）に書く上限（文字数。ブラウザの上限は約 520 万文字。ほかの物の分を残す） */
export const LOCAL_MAX_CHARS = 4_000_000;

/** localStorage に書くには大きすぎる（書かない。前の緊急コピーは残す） */
export class StoredTooLargeError extends Error {
  override name = "StoredTooLargeError";
  readonly chars: number;
  constructor(chars: number) {
    super(`保存する内容が大きすぎます（${chars.toLocaleString("ja-JP")} 文字。このブラウザの小さな保存先には ${LOCAL_MAX_CHARS.toLocaleString("ja-JP")} 文字までしか書きません）`);
    this.chars = chars;
  }
}

/** 知らせる先（既定はコンソール。テストと画面が差し替える） */
let warn: (message: string) => void = (m) => console.warn(m);
export function setCodecWarn(fn: ((message: string) => void) | null): void {
  warn = fn ?? ((m) => console.warn(m));
}

/** 書く形と、薄い形にしたときの数（地図が無ければ stats は null） */
export function encodeStored(doc: DocData): { stored: StoredDoc; stats: ThinStats | null } {
  const r = encodeThin(doc);
  if (!r) return { stored: doc, stats: null };
  if (r.stats.fatKeyed > 1000) warn(`地図のカードを ${r.stats.fatKeyed.toLocaleString("ja-JP")} 枚、丸ごと書きました（同じ地図が 2 つ以上あるかもしれません）`);
  return r;
}

/** 保存先に書く形（I1: 本体・緊急コピー・バックアップ・アカウント・書き出しのどれもここを通す） */
export function toStored(doc: DocData): StoredDoc {
  return encodeStored(doc).stored;
}

/** 保存した形の版（版の記録・バックアップの見出し・マニフェストの docVersion に書く物） */
export function storedVersion(stored: Pick<StoredDoc, "version">): number {
  return typeof stored.version === "number" && Number.isFinite(stored.version) ? stored.version : SCHEMA_VERSION;
}

/**
 * 保存した形を読む（新しい入れ物の文書と、整えたときの報告）。版 1 は今までどおり normalizeDoc（壊れていれば DocFormatError、新しい版なら NewerDocError）。
 * 薄い形はページの地図から組み立て直す。読めなければ ThinMapError（どの訳でも止める側）か NewerDocError
 */
export function decodeStored(raw: unknown): { doc: DocData; report: NormalizeReport } {
  if (isThinShape(raw)) return decodeThin(raw);
  return normalizeDoc(raw);
}

/** 保存した形を読む（文書だけ） */
export function fromStored(raw: unknown): DocData {
  return decodeStored(raw).doc;
}

/**
 * 読めなかった訳が「止める側」か（このページが古い・地図を組み立てられない・基準が合わない・薄い形が読めない）。
 * 止める側なら、保存してあるデータは消さない・上書きしない・代わりの内容で始めない（safety-3）
 */
export function isBlockedError(e: unknown): boolean {
  return e instanceof ThinMapError || e instanceof NewerDocError;
}

/**
 * 書いた形の大きさを見る（文字数）。1 MB を超えたら知らせ、localStorage に書く物が上限を超えたら StoredTooLargeError（書かない）
 */
export function checkStoredSize(chars: number, where: "local" | "idb" | "cloud" | "export"): void {
  if (where === "local" && chars > LOCAL_MAX_CHARS) throw new StoredTooLargeError(chars);
  if (chars > STORED_WARN_CHARS) warn(`保存する内容が大きくなっています（${chars.toLocaleString("ja-JP")} 文字・${where}）`);
}

/** 書く形の JSON（大きさを見てから返す。localStorage に書く物は where に "local"） */
export function storedJson(doc: DocData, where: "local" | "idb" | "cloud" | "export"): string {
  const json = JSON.stringify(toStored(doc));
  checkStoredSize(json.length, where);
  return json;
}
