import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeadline } from '../../src/main/browser/deadline';

afterEach(() => vi.useRealTimers());
describe('remote renderer deadline', () => {
  it('times out a renderer promise that never settles', async () => {
    vi.useFakeTimers();
    const result = withDeadline(new Promise<never>(() => undefined), 8000);
    const rejected = expect(result).rejects.toThrow('timed out after 8000 ms');
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('lets emergency stop abandon a frozen renderer immediately', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = withDeadline(new Promise<never>(() => undefined), 8000, controller.signal);
    const rejected = expect(result).rejects.toThrow('Emergency stop');
    controller.abort(new Error('Emergency stop'));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans the timer when work completes normally', async () => {
    vi.useFakeTimers();
    expect(await withDeadline(Promise.resolve('ready'), 8000)).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });
});
