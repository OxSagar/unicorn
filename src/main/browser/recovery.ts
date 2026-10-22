import { retryDelay } from '../core/timing';

/** This type is created only from a native renderer-exit event, never from website error text. */
export class RendererCrashError extends Error {
  constructor(
    readonly reason: string,
    readonly exitCode?: number,
  ) {
    super(`Browser renderer exited: ${reason}`);
    this.name = 'RendererCrashError';
  }
}

export const RECOVERY_WINDOW_MS = 10 * 60_000;
export const MAX_PROFILE_RECOVERIES = 3;
const retryableReasons = new Set(['crashed', 'killed', 'abnormal-exit']);

export type RecoveryDecision =
  | { allowed: true; retry: number; delayMs: number }
  | {
      allowed: false;
      reason:
        | 'not-renderer-crash'
        | 'exit-not-retryable'
        | 'retry-disabled'
        | 'retry-limit'
        | 'profile-rate-limit'
        | 'clock-unavailable';
      retryAfterMs?: number;
    };

/**
 * One budget belongs to a persistent profile for the application's lifetime.
 * Reservations are synchronous and remain consumed if Stop cancels a later repair.
 */
export class RecoveryBudget {
  private reservations: number[] = [];
  private lastTime = -Infinity;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reserve(error: unknown, retriesCompleted: number, retryLimit: number): RecoveryDecision {
    if (!Number.isSafeInteger(retriesCompleted) || retriesCompleted < 0)
      throw new Error('Completed renderer retries must be a nonnegative integer');
    if (!Number.isInteger(retryLimit) || retryLimit < 0 || retryLimit > 5)
      throw new Error('Renderer retry limit must be an integer from 0 through 5');
    if (!(error instanceof RendererCrashError)) return { allowed: false, reason: 'not-renderer-crash' };
    if (!retryableReasons.has(error.reason)) return { allowed: false, reason: 'exit-not-retryable' };
    if (!retryLimit) return { allowed: false, reason: 'retry-disabled' };
    if (retriesCompleted >= retryLimit) return { allowed: false, reason: 'retry-limit' };
    const observed = this.now();
    if (!Number.isFinite(observed)) return { allowed: false, reason: 'clock-unavailable' };
    // The default clock is monotonic. A broken injected clock cannot restore exhausted credit.
    const now = Math.max(observed, this.lastTime);
    this.lastTime = now;
    this.reservations = this.reservations.filter((at) => now - at < RECOVERY_WINDOW_MS);
    if (this.reservations.length >= MAX_PROFILE_RECOVERIES)
      return {
        allowed: false,
        reason: 'profile-rate-limit',
        retryAfterMs: Math.max(0, RECOVERY_WINDOW_MS - (now - this.reservations[0])),
      };
    this.reservations.push(now);
    return { allowed: true, retry: retriesCompleted + 1, delayMs: retryDelay(retriesCompleted) };
  }
}
