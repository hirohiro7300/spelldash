// 基準の文書の指紋（baseline digest。作業メモ SPEC v1 §6・見直し safety-4）。
// 同梱の地図（同じ版の順番・同じ中身の指紋）から組み立てた文書が、アプリの版が変わっても同じカード・同じ ID・同じ線になるかを見分ける。
// 中身: カードごとの 鍵・ID・親・線の ID・条件の ID・projectIds・scenarioIds・タグ・期限（time）。決まった at で組み立て、端末の時差に依らない。
// 置き場: src/demo/impact-release.json（{release, hash, digest, anchor}）と、薄い形の入口ごと。CI が同梱データから組み立てて比べ、
// 同じ版の順番で違えば止める。読み手は、同じ版でも指紋が違えば版をまたぐ道へ回すか止める（黙って読まない）。
// 作る側: W-store（組み立ての後の文書で）。W-gen の生成は、ここで出した指紋を版の記録に書く

import type { DocData, ID } from "../model/types";

/** 基準の文書の指紋（36 進の文字列）。doc は buildImpactDoc(map, {version, release, at, layout}) で組み立てた文書、root はその地図の今日のカード */
export type ImpactBaselineDigest = (doc: DocData, root: ID) => string;

/**
 * 基準の文書の指紋を出す。
 * TODO(W-store): 地図の今日（root）から届くカードを鍵の順に並べ、カードごとに 鍵・ID・親の ID・親からの線の ID・条件の ID・
 * projectIds・scenarioIds・タグ・期限を決まった並びの文字列にして、64 ビットの指紋（fnv64x36。src/demo/impact.ts）を取る。
 * TZ=America/Los_Angeles と Asia/Tokyo で同じ値になることをテストで確かめる（safety-14）
 */
export const impactBaselineDigest: ImpactBaselineDigest = () => {
  throw new Error("impactBaselineDigest はまだ作っていません（W-store）");
};
