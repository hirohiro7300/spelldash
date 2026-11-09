/** 型つきの小さなイベントの仕組み */
export class Emitter<E extends object> {
  private handlers = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: E[K]) => void)(payload);
      } catch (err) {
        // 1 つの受け手の失敗で、ほかの受け手（自動保存など）を止めない
        console.error(err);
      }
    }
  }
}
