import { describe, expect, it } from 'vitest';
import {
  MAX_PROFILE_RECOVERIES,
  RECOVERY_WINDOW_MS,
  RecoveryBudget,
  RendererCrashError,
} from '../../src/main/browser/recovery';
import { SiteRestrictionError } from '../../src/main/network/site-restriction';

describe('renderer recovery classification and bounded reservations', () => {
  it.each(['crashed', 'killed', 'abnormal-exit'])(
    'allows a typed native %s exit within the configured attempt limit',
    (reason) => {
      const error = new RendererCrashError(reason, 17);
      expect(error).toBeInstanceOf(Error);
      expect(error.reason).toBe(reason);
      expect(error.exitCode).toBe(17);
      expect(error.message).toContain(reason);
      expect(new RecoveryBudget().reserve(error, 0, 2)).toEqual({
        allowed: true,
        retry: 1,
        delayMs: 1000,
      });
    },
  );

  it.each(['oom', 'memory-eviction', 'launch-failed', 'integrity-failure', 'clean-exit', 'unknown'])(
    'does not restart a renderer after %s',
    (reason) => {
      expect(new RecoveryBudget().reserve(new RendererCrashError(reason), 0, 5)).toEqual({
        allowed: false,
        reason: 'exit-not-retryable',
      });
    },
  );

  it.each([
    new Error('Browser renderer exited: crashed'),
    new Error('net::ERR_PROXY_CONNECTION_FAILED'),
    new Error('net::ERR_CERT_AUTHORITY_INVALID'),
    new Error('Stopped by user'),
    new Error('Renderer health probe timed out'),
    new SiteRestrictionError('HTTP 429: testing paused', 'https://authorized.test/page'),
    new SiteRestrictionError('Challenge detected; renderer crashed', 'https://authorized.test/page'),
    { name: 'RendererCrashError', reason: 'crashed' },
    null,
  ])('does not infer a recoverable crash from arbitrary errors or page-controlled text: %j', (error) => {
    expect(new RecoveryBudget().reserve(error, 0, 5)).toEqual({
      allowed: false,
      reason: 'not-renderer-crash',
    });
  });

  it('disables automatic recovery at retryLimit zero without consuming profile credit', () => {
    const budget = new RecoveryBudget(() => 0);
    const error = new RendererCrashError('crashed');
    for (let index = 0; index < 20; index++)
      expect(budget.reserve(error, 0, 0)).toEqual({ allowed: false, reason: 'retry-disabled' });
    for (let index = 0; index < MAX_PROFILE_RECOVERIES; index++)
      expect(budget.reserve(error, 0, 1).allowed).toBe(true);
  });

  it('uses exponential delays, stops at the configured limit, and does not automatically reset a job', () => {
    const budget = new RecoveryBudget(() => 0);
    const error = new RendererCrashError('crashed');
    expect(budget.reserve(error, 0, 2)).toEqual({ allowed: true, retry: 1, delayMs: 1000 });
    expect(budget.reserve(error, 1, 2)).toEqual({ allowed: true, retry: 2, delayMs: 2000 });
    expect(budget.reserve(error, 2, 2)).toEqual({ allowed: false, reason: 'retry-limit' });
    // A subsequent reviewed job still shares the profile's remaining credit.
    expect(budget.reserve(error, 0, 2).allowed).toBe(true);
    expect(budget.reserve(error, 0, 2)).toEqual({
      allowed: false,
      reason: 'profile-rate-limit',
      retryAfterMs: RECOVERY_WINDOW_MS,
    });
  });

  it('makes concurrent callers reserve the final profile credits atomically', async () => {
    const budget = new RecoveryBudget(() => 0);
    const results = await Promise.all(
      Array.from({ length: 100 }, async () => budget.reserve(new RendererCrashError('crashed'), 0, 5)),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(MAX_PROFILE_RECOVERIES);
    expect(results.filter((result) => !result.allowed)).toHaveLength(100 - MAX_PROFILE_RECOVERIES);
  });

  it('expires reservations individually rather than resetting all credits at a window boundary', () => {
    let now = 0;
    const budget = new RecoveryBudget(() => now);
    const reserve = () => budget.reserve(new RendererCrashError('crashed'), 0, 5);
    expect(reserve().allowed).toBe(true);
    now = 1000;
    expect(reserve().allowed).toBe(true);
    now = 2000;
    expect(reserve().allowed).toBe(true);
    now = RECOVERY_WINDOW_MS - 1;
    expect(reserve()).toEqual({ allowed: false, reason: 'profile-rate-limit', retryAfterMs: 1 });
    now = RECOVERY_WINDOW_MS;
    expect(reserve().allowed).toBe(true);
    expect(reserve()).toEqual({ allowed: false, reason: 'profile-rate-limit', retryAfterMs: 1000 });
    now += 1000;
    expect(reserve().allowed).toBe(true);
    expect(reserve().allowed).toBe(false);
  });

  it('isolates budgets between profiles and preserves consumed credit when an attempt is abandoned', () => {
    const first = new RecoveryBudget(() => 0);
    const second = new RecoveryBudget(() => 0);
    for (let index = 0; index < MAX_PROFILE_RECOVERIES; index++)
      expect(first.reserve(new RendererCrashError('crashed'), 0, 5).allowed).toBe(true);
    expect(first.reserve(new RendererCrashError('crashed'), 0, 5).allowed).toBe(false);
    expect(second.reserve(new RendererCrashError('crashed'), 0, 5).allowed).toBe(true);
  });

  it('cannot regain exhausted credit by moving the clock backwards', () => {
    let now = 1000;
    const budget = new RecoveryBudget(() => now);
    const reserve = () => budget.reserve(new RendererCrashError('crashed'), 0, 5);
    for (let index = 0; index < MAX_PROFILE_RECOVERIES; index++) expect(reserve().allowed).toBe(true);
    now = -RECOVERY_WINDOW_MS;
    expect(reserve()).toEqual({
      allowed: false,
      reason: 'profile-rate-limit',
      retryAfterMs: RECOVERY_WINDOW_MS,
    });
  });

  it('fails closed if the supplied clock stops returning finite timestamps', () => {
    for (const now of [NaN, Infinity, -Infinity])
      expect(new RecoveryBudget(() => now).reserve(new RendererCrashError('crashed'), 0, 5)).toEqual({
        allowed: false,
        reason: 'clock-unavailable',
      });
  });

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid completed-attempt counters: %s', (attempt) => {
    expect(() => new RecoveryBudget().reserve(new RendererCrashError('crashed'), attempt, 2)).toThrow(
      /nonnegative integer/,
    );
  });

  it.each([-1, 0.5, 6, NaN, Infinity])('rejects invalid configured retry limits: %s', (limit) => {
    expect(() => new RecoveryBudget().reserve(new RendererCrashError('crashed'), 0, limit)).toThrow(
      /0 through 5/,
    );
  });
});
