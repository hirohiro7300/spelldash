// 空いた時間の仕事（requestIdleCallback）を、空いた時間の内に収めて少しずつ進める所（見直し perf-8）
//   whenIdle(fn)        : 手が空いたときに 1 度呼ぶ（requestIdleCallback。無ければ次の番に。残りの時間を渡す）
//   idleSteps(step, ok) : step を空いた時間に繰り返す（true を返したら終わり）。1 回の呼び出しの中では、空いた時間の残りが
//                         直前の 1 歩の時間（と 5 ms）より長く、続けた時間が IDLE_SLICE_MS に収まる間だけ続け、足りなくなったら
//                         次の空いた時間へ。ok が false になったらやめる
//                         （画面の作り直しで要らなくなった など）。1 回の呼び出しで少なくとも 1 歩は進める

/** 空いた時間の残り（requestIdleCallback の deadline。無い環境では null） */
export interface IdleDeadlineLike {
  timeRemaining(): number;
  readonly didTimeout?: boolean;
}

type Ric = (cb: (dl: IdleDeadlineLike) => void, o?: { timeout: number }) => number;

/** 手が空いたときに 1 度呼ぶ（timeout ms のうちには必ず呼ぶ） */
export function whenIdle(fn: (dl: IdleDeadlineLike | null) => void, timeout = 300): void {
  const ric = (globalThis as { requestIdleCallback?: Ric }).requestIdleCallback;
  if (ric) ric((dl) => fn(dl), { timeout });
  else setTimeout(() => fn(null), 0);
}

/**
 * 1 回の空いた時間で続けて進める長さの上限（ms）。空いた時間は 50 ms まで続くことがあるが、それを使い切ると 1 歩の時間の揺れで
 * 50 ms を超える長い仕事になる（入力を待たせる）ので、その手前で次の空いた時間へ回す（perf-10）
 */
export const IDLE_SLICE_MS = 30;

/** 1 歩ずつ、空いた時間の内に進める（説明は上） */
export function idleSteps(step: () => boolean, ok: () => boolean = () => true, timeout = 300): void {
  let cost = 0;
  const run = (dl: IdleDeadlineLike | null): void => {
    const start = performance.now();
    for (;;) {
      if (!ok()) return;
      const t0 = performance.now();
      if (step()) return;
      cost = performance.now() - t0;
      // 次の 1 歩が残りの時間（と 1 回の上限）に収まらなければ、次の空いた時間へ（無い環境では 1 歩ずつ）
      if (!dl || dl.timeRemaining() < Math.max(5, cost) || performance.now() - start + cost > IDLE_SLICE_MS) break;
    }
    whenIdle(run, timeout);
  };
  whenIdle(run, timeout);
}
