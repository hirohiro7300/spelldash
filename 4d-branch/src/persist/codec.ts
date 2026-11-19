// 保存の口（コーデック）: 文書を保存先に書く形と、保存先から読む形を決める 1 か所。設計: 作業メモ SPEC v1 §6・R0 §6.1・§10.2 I1
//
// 書く: toStored(doc) → 保存する形（StoredDoc）。読む: fromStored(raw) / decodeStored(raw) / decodeStoredAsync(raw) → 手元で持つ文書（新しい入れ物）。
//   - ページの地図（同梱の 3 か月ごとの地図。setThinBaseline で入れる）を持つ文書は、地図の本体を省いた薄い形（版 2・maps つき。./thinMap.ts）
//   - それ以外の文書（地図が無い・版 6 の地図・ほかの年月の地図）は今までと同じ形のまま（同じ物を返す。既定のビルドは何も変わらない）
//   - 地図の基準を入れる前に、3 か月ごとの地図を持つ文書を書こうとしたら ThinBaselineMissingError（地図ごと書くと 7,000 万文字を超える: safety-15）。
//     ページの地図のカードが多いのに今日のカードが無い（壊れた形）ときも ThinWriteError で書かない
//   - 薄い形の文書（版 2 以上か maps がある）は、どんな失敗でも止める側の失敗（ThinMapError・NewerDocError）にする。壊れたデータと見なして
//     バックアップで始めたり、消したり、上書きしたりしない（safety-3）。版 1 の文書の読めない JSON・形だけが、今までどおり壊れたデータ
//   - 薄い形を読めるのは、ページに地図があるページ（setThinBaseline）か、地図の読み込み方を決めたページ（enableThinPage: main.ts が
//     ページに 3 か月ごとの地図を入れたビルドで呼ぶ）だけ。ほかのページ（既定のビルド）は、版 2 を今までどおり新しい版のデータとして止まる
//   - 地図は要るときに初めて読む（gaps-17）: 保存してあった物に地図がある（decodeStoredAsync）・利用者が地図を開く（ensurePageMap）
//   - 前の版の地図は、鍵でページの地図に当て直して読む（thinMap.ts の「版をまたいで読む」。既定）。同じ版で合わない物は止める
//     （「この版で開き直す」・取り込みだけ upgrade: "any" で当て直す: safety-5）
//   - 版 6 までの地図（太い形の版 1 の文書）は、ページの地図に引き上げて読む（./legacyMap.ts。SPEC §8・D11）。id と更新時刻は変えず、
//     次に保存するとき薄い形で書く。引き上げられなければ（ページに地図が無い・途中で失敗した）、今までどおり版 6 の地図のまま読む
// 呼ぶ所（保存・同期・書き出し・履歴は、ほかの道で文書を書いたり読んだりしない）:
//   src/persist/persistence.ts（writeStored・writeEmergency・createBackup → toStored、readStored・readEmergencies・readBackup → decodeStoredAsync）、
//   src/persist/cloud.ts（encodeDoc・decodeDoc）、src/persist/io.ts（exportText・previewImportAsync）。
//   版の記録（IndexedDB の meta・バックアップの見出し・アカウントのマニフェスト）の docVersion は storedVersion(保存する形)
// 大きさの見張り（safety-15）: 1 MB を超えたら知らせる。localStorage（緊急コピー・小さな保存先）には 400 万文字を超えて書かない

import type { MapData } from "../deepmap/mapData";
import { isNewerDocRaw, NewerDocError, normalizeDoc, SCHEMA_VERSION, THIN_VERSION, type NormalizeReport } from "../model/schema";
import type { DocData, GNode } from "../model/types";
import {
  decodeThin,
  encodeThin,
  ensurePageMap,
  isQuarterRoot,
  isThinShape,
  pageHash,
  pageRelease,
  sectionOf,
  setPageMapSource,
  thinReadable,
  ThinMapError,
  ThinNewerError,
  type CardCounts,
  type StoredDoc,
  type ThinDecodeOpts,
  type ThinStats,
  type ThinUpgradeInfo,
  THIN_BASELINE_VERSION,
} from "./thinMap";
import { isLegacyRootRaw, upgradeLegacyMap } from "./legacyMap";

export {
  ensurePageMap,
  hasThinBaseline,
  holdsPageMap,
  isQuarterRoot,
  isThinShape,
  pageHash,
  pageRelease,
  sectionOf,
  setThinBaseline,
  thinBaseline,
  thinBaselineDoc,
  ThinBaselineMissingError,
  ThinMapError,
  ThinNewerError,
  thinReadable,
  ThinWriteError,
  THIN_BASELINE_VERSION,
  THIN_LAYOUT,
} from "./thinMap";
export type { CardCounts, LegacyUpgradeDetail, MapBase, PageMapRecord, StoredDoc, ThinDecodeOpts, ThinDecoded, ThinErrorCode, ThinSection, ThinStats, ThinUpgradeInfo, ThinUpgradeMode } from "./thinMap";
export { legacyRootOf, upgradeLegacyMap } from "./legacyMap";

/**
 * このページは、ページに入れた 3 か月ごとの地図で薄い形を読み書きする（main.ts が、地図を入れたビルドで起動のときに呼ぶ）。
 * 地図はまだ読まない（要るときに load を 1 度だけ呼ぶ）。null で外す（テスト）
 */
export function enableThinPage(load: (() => Promise<MapData | null>) | null, opts: { digest?: string } = {}): void {
  setPageMapSource(load, opts);
}

/** 読んだ結果（当て直したときは upgrade に数） */
export interface StoredDecoded {
  doc: DocData;
  report: NormalizeReport;
  upgrade?: ThinUpgradeInfo;
}

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
 * 薄い形はページの地図から組み立て直す。読めなければ ThinMapError（どの訳でも止める側）か NewerDocError。
 * 薄い形を読めないページ（既定のビルド）では、今までどおり normalizeDoc（版 2 は NewerDocError）。地図はもう入れてあること（無ければ unavailable。
 * 入れていなければ decodeStoredAsync）
 */
export function decodeStored(raw: unknown, opts: ThinDecodeOpts = {}): StoredDecoded {
  if (isThinShape(raw) && thinReadable()) return noted(decodeThin(raw, opts));
  const r = normalizeDoc(raw);
  if (opts.upgrade === "none") return r;
  // 版 6 までの地図（太い形）は、ページの地図に引き上げる（ページの地図を入れてあるときだけ。既定のビルドでは何もしない）
  const up = legacyUpgrade(r.doc);
  return up ? noted({ doc: up.doc, report: r.report, upgrade: up.info }) : r;
}

/**
 * 版 6 までの地図の引き上げ。途中で失敗したら引き上げずに null（版 1 の文書は、このページでも版 6 の地図のまま読める。
 * 失敗を壊れたデータと取り違えて、バックアップで始めたりしない: safety-3）
 */
function legacyUpgrade(doc: DocData): ReturnType<typeof upgradeLegacyMap> {
  try {
    return upgradeLegacyMap(doc);
  } catch (e) {
    warn(`版 6 の地図を新しい版にできなかったため、前の版の地図のまま開きます（${e instanceof Error ? e.message : String(e)}）`);
    return null;
  }
}

/**
 * 版をまたいで読んだ文書と、そのときの数（読んだ文書ごと）。アカウントの突き合わせで、まだ送っていない変更・アカウントの写しが、
 * どの版の地図の上で書かれた物かを見る（safety-2）。アカウントの内容を読み込んだときの知らせにも使う
 */
const storedUpgrades = new WeakMap<DocData, ThinUpgradeInfo>();

function noted(d: StoredDecoded): StoredDecoded {
  if (d.upgrade) storedUpgrades.set(d.doc, d.upgrade);
  return d;
}

/** 版をまたいで読んだ文書の、保存してあった形の地図の版の順番（そのまま読んだ文書は undefined） */
export function storedMapReleaseOf(doc: DocData): number | undefined {
  return storedUpgrades.get(doc)?.from.release;
}

/** 版をまたいで読んだ文書の、そのときの数（そのまま読んだ文書は undefined） */
export function storedUpgradeOf(doc: DocData): ThinUpgradeInfo | undefined {
  return storedUpgrades.get(doc);
}

/** 保存した形を読む（文書だけ） */
export function fromStored(raw: unknown, opts: ThinDecodeOpts = {}): DocData {
  return decodeStored(raw, opts).doc;
}

/**
 * 読むのにページの地図が要る物か: 薄い形（地図の変更がある）か、3 か月ごとの地図の今日を持つ文書（次に書くとき薄い形にする）か、
 * 版 6 までの地図の今日を持つ文書（ページの地図へ引き上げる）。薄い形を読めないページでは false（読み込まない）
 */
export function needsPageMap(raw: unknown): boolean {
  if (!thinReadable() || !raw || typeof raw !== "object") return false;
  const r = raw as { maps?: unknown; nodes?: unknown };
  if (Array.isArray(r.maps) && r.maps.length > 0) return true;
  if (r.maps !== undefined && !Array.isArray(r.maps)) return true;
  const nodes = r.nodes;
  if (!nodes || typeof nodes !== "object") return false;
  for (const id of Object.keys(nodes)) {
    const n = (nodes as Record<string, GNode | undefined>)[id];
    // 3 か月ごとの地図の今日（次に書くとき薄い形にする）・版 6 までの地図の今日（読むときにページの地図へ引き上げる）
    if (isQuarterRoot(n) || isLegacyRootRaw(n)) return true;
  }
  return false;
}

/** 保存した形を読む（地図が要れば先に読み込む。地図を読めなければ、薄い形は ThinMapError unavailable で止まる） */
export async function decodeStoredAsync(raw: unknown, opts: ThinDecodeOpts = {}): Promise<StoredDecoded> {
  if (needsPageMap(raw)) await ensurePageMap();
  return decodeStored(raw, opts);
}

/**
 * 読めなかった訳が「止める側」か（このページが古い・地図を組み立てられない・基準が合わない・薄い形が読めない）。
 * 止める側なら、保存してあるデータは消さない・上書きしない・代わりの内容で始めない（safety-3）
 */
export function isBlockedError(e: unknown): boolean {
  return e instanceof ThinMapError || e instanceof NewerDocError;
}

/**
 * 保存してあった物を読めなかった訳の分け方（記録の形で決める: safety-3）。newer: このページより新しい版（NewerDocError）。
 * blocked: 版 2 以上か地図の変更がある記録（版の記録の docVersion が 2 以上のときも）は、何が投げられても止める側（消さない・代わりで始めない・上書きしない）。
 * corrupt: 版 1 の記録の、読めない JSON・形だけ（今までどおり壊れたデータ）
 */
export type ReadFailure = "newer" | "blocked" | "corrupt";

export function classifyReadFailure(raw: unknown, e: unknown, metaVersion?: unknown): ReadFailure {
  if (e instanceof NewerDocError) return "newer";
  if (e instanceof ThinMapError) return "blocked";
  if (isThinShape(raw)) return "blocked";
  if (typeof metaVersion === "number" && Number.isFinite(metaVersion) && Math.floor(metaVersion) >= THIN_VERSION) return "blocked";
  return "corrupt";
}

/**
 * 保存してあった物が、このページより新しい版か（整えずに印だけ見る: 文書の版・薄い形の地図の変更の形の版と版の順番）。
 * 地図の版の順番は、ページの地図を入れてあるときだけ比べる
 */
export function isNewerRecord(raw: unknown): boolean {
  if (isNewerDocRaw(raw)) return true;
  if (!thinReadable() || !isThinShape(raw)) return false;
  try {
    const s = sectionOf(raw);
    const rel = pageRelease();
    return !!s && rel !== null && s.release > rel;
  } catch (e) {
    return e instanceof ThinNewerError || e instanceof NewerDocError;
  }
}

/** 保存した記録の印（版の記録・バックアップの見出しに書く物）: 形の版・地図の版の順番と中身の指紋と組み立ての版（薄い形のときだけ） */
export interface RecordInfo {
  format: number;
  mapRelease?: number;
  mapHash?: string;
  mapBv?: number;
}

/** 保存する形・保存した記録から、見出しに書く印を作る（読めなければ形の版だけ） */
export function recordInfo(stored: unknown): RecordInfo {
  const o = stored && typeof stored === "object" ? (stored as { version?: unknown }) : {};
  const format = typeof o.version === "number" && Number.isFinite(o.version) ? Math.floor(o.version) : SCHEMA_VERSION;
  try {
    const s = sectionOf(stored);
    if (s) return { format, mapRelease: s.release, mapHash: s.hash, mapBv: s.bv };
  } catch {
    /* 形の版だけ */
  }
  return { format };
}

/**
 * 見出しの印から、このページでは読めないと分かるか（中身を読まずに）: newer 新しい版（形の版か地図の版の順番）・
 * blocked 同じ版の順番で中身の指紋か組み立ての版が違う地図（このページでは開けない）・null 中身を読まないと分からない
 */
export function headerBlock(h: { docVersion?: unknown; mapRelease?: unknown; mapHash?: unknown; mapBv?: unknown }): "newer" | "blocked" | null {
  const v = h.docVersion;
  if (typeof v === "number" && Number.isFinite(v) && Math.floor(v) > THIN_VERSION) return "newer";
  if (typeof v === "number" && Number.isFinite(v) && Math.floor(v) >= THIN_VERSION && !thinReadable()) return "newer";
  const rel = pageRelease();
  if (typeof h.mapRelease === "number" && rel !== null) {
    if (h.mapRelease > rel) return "newer";
    if (h.mapRelease === rel && typeof h.mapHash === "string" && h.mapHash !== pageHash()) return "blocked";
    if (h.mapRelease === rel && typeof h.mapBv === "number" && h.mapBv !== THIN_BASELINE_VERSION) return "blocked";
  }
  return null;
}

/**
 * 書いた形の大きさを見る（文字数）。1 MB を超えたら知らせ、localStorage に書く物が上限を超えたら StoredTooLargeError（書かない）
 */
export function checkStoredSize(chars: number, where: "local" | "idb" | "cloud" | "export"): void {
  if (where === "local" && chars > LOCAL_MAX_CHARS) throw new StoredTooLargeError(chars);
  if (chars > STORED_WARN_CHARS) warn(`保存する内容が大きくなっています（${chars.toLocaleString("ja-JP")} 文字・${where}）`);
}

/**
 * 保存先に書く前の大きさの見張り（薄い形を読み書きするページだけ。既定のビルドは今までどおり見張らない: 版 6 の地図は 160 万文字ある）
 */
export function guardStoredSize(chars: number, where: "local" | "idb" | "cloud" | "export"): void {
  if (thinReadable()) checkStoredSize(chars, where);
}

/** 書く形の JSON（大きさを見てから返す。localStorage に書く物は where に "local"） */
export function storedJson(doc: DocData, where: "local" | "idb" | "cloud" | "export"): string {
  const json = JSON.stringify(toStored(doc));
  checkStoredSize(json.length, where);
  return json;
}

// ---------------------------------------------------------------- 版をまたいで読んだときの知らせ

/**
 * 知らせを出す所: boot 起動・import 取り込み（確認の警告）・backup バックアップから戻す（確認）・confirm 地図を新しい版にするか聞く・
 * swap 地図を新しい版にした（お知らせ）・adopt アカウントの内容（前の版の地図）を読み込んだ（お知らせ）
 */
export type UpgradeNoticeWhere = "boot" | "import" | "backup" | "confirm" | "swap" | "adopt";

/** 利用者の物を持つカードの数の言い方（「選んだ手 3 件・見送った手 1 件・書き換えた・チェックしたカード 2 件」） */
function cardsLabel(c: CardCounts, noun: string): string {
  const parts: string[] = [];
  if (c.picks) parts.push(`選んだ手 ${c.picks} 件`);
  if (c.drops) parts.push(`見送った手 ${c.drops} 件`);
  const rest = c.cards - c.picks - c.drops;
  if (rest > 0) {
    const how = [c.edits ? "書き換えた" : "", c.ticks ? "チェックした" : "", c.links ? "線でつないだ" : ""].filter(Boolean);
    parts.push(`${how.length ? how.join("・") : "手を入れた"}${noun} ${rest} 件`);
  }
  return parts.join("・");
}

/**
 * 地図を新しい版で読んだときの知らせの文（数は当て直した結果そのまま: user-6・gaps-14。「そのまま残ります」とは言わない）。
 * 版 6 までの地図の引き上げ（u.legacy）は、移した手・引き継いだカード・別のカードに残したカードを、それぞれの数で言う
 */
export function upgradeNotice(u: ThinUpgradeInfo, where: UpgradeNoticeWhere): string {
  const L = u.legacy;
  if (!L) {
    const carried = `書き換えたカード ${u.applied} 枚の選んだ手・チェック・文章は引き継ぎ`;
    const detached = u.detached ? `、地図から無くなったカード ${u.detached} 枚は「前の版で決めたこと」に残し${where === "boot" || where === "swap" || where === "adopt" ? "ました" : "ます"}` : "";
    if (where === "boot") return `地図を新しい版（版 ${u.to.release}）で開きました。前の版で${carried}${detached}${u.lostTicks ? `（引き継げなかったチェック ${u.lostTicks} 件）` : ""}。前の内容はバックアップに残しています。`;
    if (where === "import")
      return `地図はこのページの版（版 ${u.to.release}）に合わせて読み込みます（ファイルは版 ${u.from.release} の地図）。書き換えたカード ${u.applied} 枚を引き継ぎ${detached}${u.lostTicks ? `。引き継げないチェックが ${u.lostTicks} 件あります` : ""}。`;
    if (where === "backup") return `このバックアップの地図は前の版（版 ${u.from.release}）の物です。このページの版（版 ${u.to.release}）に合わせて戻します（${carried}${detached}）。`;
    if (where === "confirm") return `地図を新しい版（版 ${u.to.release}）にします。${carried}${detached}。`;
    if (where === "adopt") return `アカウントの内容は前の版の地図だったため、新しい版（版 ${u.to.release}）にして読み込みました。${carried}${detached}。`;
    return `未来の道筋を新しい版（版 ${u.to.release}）にしました。${carried}${detached}。`;
  }
  // 版の順番を残す前に読み込んだ地図（版の順番が無い）は「前の版」とだけ言う
  const known = u.from.release > 0;
  const next = `3 か月ごとの新しい地図（版 ${u.to.release}）`;
  const head =
    where === "boot"
      ? `地図を、${next}で開きました。`
      : where === "import"
        ? `地図は、このページの${next}に合わせて読み込みます（ファイルは${known ? `版 ${u.from.release} の` : "前の版の"}地図）。`
        : where === "backup"
          ? `このバックアップの地図は前の版${known ? `（版 ${u.from.release}）` : ""}の物です。このページの${next}に合わせて戻します。`
          : where === "confirm"
            ? `未来の道筋を、${next}にします。`
            : where === "adopt"
              ? `アカウントの内容は前の版の地図だったため、${next}にして読み込みました。`
              : `未来の道筋を、${next}にしました。`;
  const done = where === "boot" || where === "swap" || where === "adopt";
  const parts: string[] = [];
  if (L.moved.cards) parts.push(`${cardsLabel(L.moved, "手")}は ${L.movedAt}の同じ手へ移${done ? "しました" : "します"}`);
  if (L.kept.cards) parts.push(`最初の手と 3 か月後のカードで決めたこと ${L.kept.cards} 件はそのまま引き継${done ? "ぎました" : "ぎます"}`);
  if (L.detached.cards) parts.push(`新しい地図に無いカードの${cardsLabel(L.detached, "カード")}は、別のカードとして「前の版で決めたこと」（今日の左）に残${done ? "しました" : "します"}`);
  const body = parts.length ? `${parts.join("。")}。` : "";
  return `${head}${body}${where === "boot" ? "前の内容はバックアップに残しています。" : ""}`;
}
