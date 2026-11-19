// 編集を受けるか（ストアの閲覧のみ）を決める決まり。App と単体テストが同じ物を使う。設計: docs/DESIGN.md §5・§5.1

/** 閲覧のみにするかを決める材料 */
export interface EditLockReasons {
  /** このタブが書き手か（別のタブが編集中なら false。「このタブで編集する」で引き継げば true に戻る） */
  writer: boolean;
  /** 保存しない一時表示（書き手でなくても編集できる） */
  ephemeral: boolean;
  /** アカウントの写しがこのページより新しい版と分かった（開き直すまで消えない） */
  accountNewer: boolean;
  /** このブラウザのデータがこのページより新しい版と分かった（開き直すまで消えない。画面ごと止めている） */
  localNewer: boolean;
}

/**
 * 閲覧のみにするか。新しい版の訳は開き直すまで消えないので、書き手に戻っても（「このタブで編集する」・別のタブが閉じた）、
 * 後の同期が済んでも、編集できる状態には戻らない
 */
export function editLocked(r: EditLockReasons): boolean {
  return r.accountNewer || r.localNewer || (!r.writer && !r.ephemeral);
}
