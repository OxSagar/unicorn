/** One timer per active step; pausing never consumes configured dwell time. */
export class RunControl {
  private paused = false;
  private wake = new Set<() => void>();
  constructor(readonly signal: AbortSignal) {}
  pause(): void {
    this.paused = true;
    this.notify();
  }
  resume(): void {
    this.paused = false;
    this.notify();
  }
  get isPaused(): boolean {
    return this.paused;
  }
  private notify(): void {
    for (const wake of this.wake) wake();
    this.wake.clear();
  }
  async checkpoint(): Promise<void> {
    this.signal.throwIfAborted();
    while (this.paused) await this.tick();
    this.signal.throwIfAborted();
  }
  private tick(ms?: number): Promise<void> {
    this.signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clean = () => {
        if (timer) clearTimeout(timer);
        this.wake.delete(done);
        this.signal.removeEventListener('abort', abort);
      };
      const done = () => {
        clean();
        resolve();
      };
      const abort = () => {
        clean();
        reject(this.signal.reason ?? new Error('Cancelled'));
      };
      this.wake.add(done);
      this.signal.addEventListener('abort', abort, { once: true });
      if (ms !== undefined) timer = setTimeout(done, ms);
    });
  }
  async wait(ms: number): Promise<void> {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      await this.checkpoint();
      const start = performance.now();
      await this.tick(Math.min(remaining, 250));
      remaining -= performance.now() - start;
    }
    await this.checkpoint();
  }
}
