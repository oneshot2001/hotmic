export type SpeechKind = "question" | "permission" | "result" | "status" | "progress";
const priority: Record<SpeechKind, number> = { question: 0, permission: 0, result: 1, status: 2, progress: 2 };
type Item = { kind: SpeechKind; alias: string; run: () => Promise<void>; done: () => void; fail: (error: unknown) => void };
export class SpeechQueue {
  #queue: Item[] = [];
  #running = false;
  #progress = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}
  enqueue(kind: SpeechKind, alias: string, run: () => Promise<void>): Promise<void> {
    if (kind === "progress") {
      if (this.now() - (this.#progress.get(alias) ?? -Infinity) < 60000) return Promise.resolve();
      this.#progress.set(alias, this.now());
    }
    const promise = new Promise<void>((done, fail) => this.#queue.push({ kind, alias, run, done, fail }));
    if (!this.#running) { this.#running = true; queueMicrotask(() => void this.drain()); }
    return promise;
  }
  private async drain() {
    while (this.#queue.length) {
      this.#queue.sort((a, b) => priority[a.kind] - priority[b.kind]);
      const item = this.#queue.shift()!;
      try { await item.run(); item.done(); } catch (error) { item.fail(error); }
    }
    this.#running = false;
  }
}
