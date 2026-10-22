import { EventEmitter } from 'node:events';
import type { ElectronApplication } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeElectronApplication } from '../e2e/close-electron';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function application(close: () => Promise<void>) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null as number | null,
    signalCode: null,
  });
  const app = { close: vi.fn(close), process: () => child } as unknown as ElectronApplication;
  return { app, child };
}

describe('bounded Electron test teardown', () => {
  it('allows a normal graceful close without terminating processes', async () => {
    const { app } = application(async () => undefined);
    await closeElectronApplication(app, { platform: 'win32' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('kills only the scoped Windows process tree after a hang and still fails teardown', async () => {
    vi.useFakeTimers();
    const { app, child } = application(() => new Promise<never>(() => undefined));
    execFile.mockImplementation((_file, _args, _options, callback) => {
      child.exitCode = 1;
      child.emit('exit', 1);
      callback(null);
    });
    const rejection = expect(
      closeElectronApplication(app, { gracefulTimeoutMs: 100, platform: 'win32' }),
    ).rejects.toThrow('did not close gracefully');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(execFile).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '4321', '/T', '/F'],
      { windowsHide: true, timeout: 5000 },
      expect.any(Function),
    );
    expect(child.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the original close error and the process-cleanup error', async () => {
    const original = new Error('Original close failure');
    const cleanup = new Error('Cannot terminate the process tree');
    const { app, child } = application(async () => {
      throw original;
    });
    execFile.mockImplementation((_file, _args, _options, callback) => callback(cleanup));
    const failure = await closeElectronApplication(app, { platform: 'win32' }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([original, cleanup]);
    expect(child.listenerCount('exit')).toBe(0);
  });
});
