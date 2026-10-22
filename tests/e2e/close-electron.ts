import { execFile } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';
import { withDeadline } from '../../src/main/browser/deadline';

type Application = Pick<ElectronApplication, 'close' | 'process'>;
interface CloseOptions {
  gracefulTimeoutMs?: number;
  killTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

async function terminateTree(app: Application, timeoutMs: number, platform: NodeJS.Platform): Promise<void> {
  const child = app.process();
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  let onExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    onExit = resolve;
    child.once('exit', onExit);
  });
  try {
    if (platform === 'win32') {
      // Playwright starts Electron through cmd.exe on Windows. Kill that exact tree,
      // including its Chromium children, without targeting unrelated Electron apps.
      await new Promise<void>((resolve, reject) => {
        execFile(
          'taskkill.exe',
          ['/PID', String(pid), '/T', '/F'],
          { windowsHide: true, timeout: timeoutMs },
          (error) => {
            if (error && child.exitCode === null && child.signalCode === null) reject(error);
            else resolve();
          },
        );
      });
    } else {
      // Playwright makes the POSIX application process the leader of its own group.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    if (child.exitCode === null && child.signalCode === null) await withDeadline(exited, timeoutMs);
  } finally {
    child.removeListener('exit', onExit);
  }
}

/** A force-killed application must never turn a broken graceful shutdown into a passing test. */
export async function closeElectronApplication(app: Application, options: CloseOptions = {}): Promise<void> {
  try {
    await withDeadline(app.close(), options.gracefulTimeoutMs ?? 15000);
  } catch (closeError) {
    try {
      await terminateTree(app, options.killTimeoutMs ?? 5000, options.platform ?? process.platform);
    } catch (cleanupError) {
      throw new AggregateError(
        [closeError, cleanupError],
        'Electron teardown and process-tree cleanup failed',
        { cause: cleanupError },
      );
    }
    throw new Error('Electron did not close gracefully; scoped process-tree cleanup was attempted', {
      cause: closeError,
    });
  }
}
