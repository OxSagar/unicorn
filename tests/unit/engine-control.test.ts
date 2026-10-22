import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunControl } from '../../src/main/qa/control';

afterEach(() => vi.useRealTimers());
describe('QA run clock', () => {
  it('does not count paused time as dwell time', async () => {
    vi.useFakeTimers();
    const control = new RunControl(new AbortController().signal);
    const finished = vi.fn();
    const work = control.wait(1000).then(finished);
    await vi.advanceTimersByTimeAsync(250);
    control.pause();
    await vi.advanceTimersByTimeAsync(10000);
    expect(finished).not.toHaveBeenCalled();
    control.resume();
    await vi.advanceTimersByTimeAsync(749);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await work;
    expect(finished).toHaveBeenCalledOnce();
  });
  it('cancels immediately while paused without leaving timers', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const control = new RunControl(abort.signal);
    control.pause();
    const work = control.wait(10000);
    const rejected = expect(work).rejects.toThrow('Emergency stop');
    abort.abort(new Error('Emergency stop'));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a running wait and removes its timer', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const control = new RunControl(abort.signal);
    const work = control.wait(10000);
    const rejected = expect(work).rejects.toThrow('Stopped');
    await vi.advanceTimersByTimeAsync(100);
    abort.abort(new Error('Stopped'));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not allow zero-length steps through a paused checkpoint', async () => {
    const control = new RunControl(new AbortController().signal);
    control.pause();
    let done = false;
    const work = control.wait(0).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    control.resume();
    await work;
    expect(done).toBe(true);
  });
});
