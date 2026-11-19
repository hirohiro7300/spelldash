// 文の型の束（BANKS）。組み立て（../compose.ts）が、カードの状態と道に合う型を選んで数を差し込む。設計: 作業メモ SPEC v1 §4.1・§4.5
// 中身は ./sentences.ts（文の型）と ./playbook.ts（手引き）。この束が文の型の唯一の元（生成でも画面でも同じ物を使う）
import type { Banks } from "../types";
import { PLAYBOOK } from "./playbook";
import { SENTENCES } from "./sentences";

/** 今の文の型の束。言葉を直したら version を上げる（0.1 は試作 R2 の束をそのまま移した版）。
 * 組み立ては束ごとに道の覚えを持つので、書き換えない（凍らせてある。別の束は写して作る） */
export const BANKS: Banks = deepFreeze({
  version: "0.1",
  // 文が言う計算の前提の数（scripts/impact/world.json の constants・kinds と同じ値。tests/unit/compose.test.ts で確かめる）
  C: { sideFee: 5, indFee: 7, overhead: 3, spend: 2, capEmp: 2, capPart: 4, capInd: 6, net: 0.094, infra: 0.3, step: 0.07, seatYen: 300, partFactor: 0.8, schoolSeats: 40, baseHours: 52 },
  ...SENTENCES,
  playbook: PLAYBOOK,
});

function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}
