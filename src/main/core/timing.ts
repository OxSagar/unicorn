interface Waiter {
  remaining: number;
  started: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (reason: Error) => void;
}
/** Tracks active time, so pauses do not consume dwell/scroll durations. */
export class PauseController {
  private waiters = new Set<Waiter>();
  private paused = false;
  private cancelled: Error | null = null;
  private readonly controller = new AbortController();
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  pause(): void {
    if (this.paused || this.cancelled) return;
    this.paused = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
      waiter.remaining = Math.max(0, waiter.remaining - (performance.now() - waiter.started));
    }
  }
  resume(): void {
    if (!this.paused || this.cancelled) return;
    this.paused = false;
    for (const waiter of this.waiters) this.arm(waiter);
  }
  cancel(reason = 'Operation cancelled'): void {
    if (this.cancelled) return;
    this.cancelled = new Error(reason);
    this.controller.abort(this.cancelled);
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.cancelled);
    }
    this.waiters.clear();
  }
  checkpoint(): Promise<void> {
    return this.wait(0);
  }
  wait(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0 || ms > 86400000)
      return Promise.reject(new Error('Timer duration is invalid'));
    if (this.cancelled) return Promise.reject(this.cancelled);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { remaining: ms, started: 0, resolve, reject };
      this.waiters.add(waiter);
      if (!this.paused) this.arm(waiter);
    });
  }
  private arm(waiter: Waiter): void {
    waiter.started = performance.now();
    waiter.timer = setTimeout(() => {
      this.waiters.delete(waiter);
      waiter.resolve();
    }, waiter.remaining);
  }
}
export function retryDelay(attempt: number, baseMs = 1000, capMs = 30000): number {
  if (
    !Number.isInteger(attempt) ||
    attempt < 0 ||
    !Number.isFinite(baseMs) ||
    baseMs <= 0 ||
    !Number.isFinite(capMs) ||
    capMs <= 0
  )
    throw new Error('Invalid retry configuration');
  return Math.min(capMs, baseMs * 2 ** Math.min(attempt, 30));
}
/** Operating hours use the local Windows clock; overnight windows are supported. */
export function inOperatingWindow(now: Date, startHour: number, endHour: number): boolean {
  if (
    !Number.isInteger(startHour) ||
    startHour < 0 ||
    startHour > 23 ||
    !Number.isInteger(endHour) ||
    endHour < 0 ||
    endHour > 24 ||
    startHour === endHour
  )
    return false;
  const hour = now.getHours() + now.getMinutes() / 60;
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}
