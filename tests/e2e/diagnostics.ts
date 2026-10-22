import type { ElectronApplication, TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withDeadline } from '../../src/main/browser/deadline';
import type { AppSnapshot } from '../../src/shared/types';
import type { BrowserFixtures } from '../fixtures/servers';
import type { Harness } from './helpers';

const NET_LOG_LIMIT = 5 * 1024 * 1024;
// Chromium's constants/final JSON envelope may add overhead to its event limit.
const ATTACHMENT_LIMIT = 6 * 1024 * 1024;
const RECORD_LIMIT = 256;

export interface HarnessDiagnostics {
  launchedAt: number;
  netLogPath: string;
  captureMode: 'default';
  maxFileSize: number;
  startedAt?: number;
  startError?: string;
  stopAttemptedAt?: number;
  stoppedAt?: number;
  stopError?: string;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 2000);
}

export function assertDiagnosticFixtures(fixtures: BrowserFixtures): void {
  for (const origin of [fixtures.httpOrigin, fixtures.httpsOrigin].filter(Boolean) as string[]) {
    const url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username ||
      url.password
    ) {
      throw new Error('Native diagnostics are restricted to controlled loopback fixtures');
    }
  }
  if (fixtures.proxies.some((proxy) => !['127.0.0.1', 'localhost'].includes(proxy.record.ip))) {
    throw new Error('Native diagnostics require controlled loopback proxy endpoints');
  }
}

export async function startHarnessDiagnostics(
  app: ElectronApplication,
  directory: string,
  launchedAt: number,
): Promise<HarnessDiagnostics> {
  const location = join(directory, 'native-diagnostics');
  const diagnostics: HarnessDiagnostics = {
    launchedAt,
    netLogPath: join(location, `net-log-${randomUUID()}.json`),
    captureMode: 'default',
    maxFileSize: NET_LOG_LIMIT,
  };
  try {
    await withDeadline(mkdir(location, { recursive: true }), 1000);
    diagnostics.startedAt = await withDeadline(
      app.evaluate(
        async ({ app: application, netLog }, options) => {
          if (application.isPackaged || process.env.UNICORN_E2E !== '1') {
            throw new Error('Native diagnostics require the unpackaged isolated E2E harness');
          }
          await application.whenReady();
          // Electron's default capture excludes cookies/auth and transferred bytes.
          // https://www.electronjs.org/docs/latest/api/net-log
          await netLog.startLogging(options.path, {
            captureMode: 'default',
            maxFileSize: options.maxFileSize,
          });
          return Date.now();
        },
        { path: diagnostics.netLogPath, maxFileSize: NET_LOG_LIMIT },
      ),
      3000,
    );
  } catch (error) {
    diagnostics.startError = errorText(error);
  }
  return diagnostics;
}

/** Logging failure must never replace the original test or teardown outcome. */
export async function stopHarnessDiagnostics(
  app: ElectronApplication,
  diagnostics: HarnessDiagnostics | undefined,
): Promise<void> {
  if (!diagnostics || diagnostics.stopAttemptedAt) return;
  diagnostics.stopAttemptedAt = Date.now();
  try {
    await withDeadline(
      app.evaluate(async ({ netLog }) => {
        if (netLog.currentlyLogging) await netLog.stopLogging();
      }),
      3000,
    );
    diagnostics.stoppedAt = Date.now();
  } catch (error) {
    diagnostics.stopError = errorText(error);
  }
}

async function captureRuntime(harness: Harness, fallbackUrl: string): Promise<unknown> {
  return withDeadline(
    harness.app.evaluate(async ({ app, netLog }, target) => {
      const runtime = (
        globalThis as unknown as {
          __unicornTest?: {
            controller: { snapshot(): AppSnapshot };
            manager: { getWebContents(id: number): Electron.WebContents };
          };
        }
      ).__unicornTest;
      if (!runtime) return { error: 'Main-process test runtime is unavailable' };
      const current = runtime.controller.snapshot();
      const routes = await Promise.all(
        current.browsers.slice(0, 20).map(async (browser) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const contents = runtime.manager.getWebContents(browser.id);
            const currentUrl = contents.getURL();
            const jobUrl = current.jobs.find((job) => job.browserId === browser.id)?.url;
            const url = /^https?:/.test(currentUrl) ? currentUrl : jobUrl || target;
            const native = {
              browserId: browser.id,
              webContentsId: contents.id,
              processId: contents.getOSProcessId(),
              destroyed: contents.isDestroyed(),
              loading: contents.isLoading(),
              currentUrl,
              inspectedUrl: url,
            };
            const resolution = await Promise.race([
              contents.session.resolveProxy(url),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Route inspection exceeded 1500 ms')), 1500);
              }),
            ]);
            return { ...native, resolution };
          } catch (error) {
            return { browserId: browser.id, error: String(error).slice(0, 2000) };
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      return {
        capturedAt: Date.now(),
        native: {
          platform: process.platform,
          versions: process.versions,
          packaged: app.isPackaged,
          noSandbox: app.commandLine.hasSwitch('no-sandbox'),
          netLogActive: netLog.currentlyLogging,
          processMetrics: app.getAppMetrics().slice(0, 32),
        },
        state: {
          version: current.version,
          settings: {
            browserCount: current.settings.browserCount,
            authorizedDomains: current.settings.authorizedDomains,
            retryLimit: current.settings.retryLimit,
            timings: current.settings.timings,
            dailyNavigationLimit: current.settings.dailyNavigationLimit,
            dailyRequestLimit: current.settings.dailyRequestLimit,
            schedule: current.settings.schedule,
          },
          preparedRun: current.preparedRun,
          browsers: current.browsers.slice(0, 20).map(({ history: _history, ...browser }) => browser),
          proxies: current.proxies.slice(0, 40),
          jobs: current.jobs.slice(-100),
          preservedJobs: current.preservedJobs.slice(-20),
          logs: current.logs.slice(0, 256),
          scheduler: current.scheduler,
          performance: current.performance,
          totals: current.totals,
          omitted: {
            jobs: Math.max(0, current.jobs.length - 100),
            preservedJobs: Math.max(0, current.preservedJobs.length - 20),
            proxies: Math.max(0, current.proxies.length - 40),
            logs: Math.max(0, current.logs.length - 256),
          },
        },
        routes,
      };
    }, fallbackUrl),
    4000,
  );
}

function fixtureSnapshot(fixtures: BrowserFixtures, launchedAt: number): unknown {
  const requests = fixtures.requests.filter((request) => request.at >= launchedAt);
  return {
    httpOrigin: fixtures.httpOrigin,
    httpsOrigin: fixtures.httpsOrigin,
    directRequests: requests.filter((request) => !request.proxied).length,
    totalRequests: requests.length,
    requests: requests.slice(-RECORD_LIMIT),
    omittedRequests: Math.max(0, requests.length - RECORD_LIMIT),
    proxies: fixtures.proxies.slice(0, 20).map((proxy) => {
      const traffic = proxy.traffic.filter((event) => event.at >= launchedAt);
      return {
        endpoint: proxy.record,
        totalRequests: proxy.requests,
        totalTunnels: proxy.tunnels,
        traffic: traffic.slice(-RECORD_LIMIT),
        omittedTraffic: Math.max(0, traffic.length - RECORD_LIMIT),
        native: proxy.diagnostics?.() ?? { unavailable: 'This fixture wrapper does not expose TCP events' },
      };
    }),
  };
}

/** Bounded, failure-only capture. Read-only route resolution sends no request. */
export async function attachFailureDiagnostics(
  harness: Harness | undefined,
  fixtures: BrowserFixtures | undefined,
  testInfo: TestInfo,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const errors: string[] = [];
  try {
    const launchedAt = harness?.diagnostics?.launchedAt ?? 0;
    const fixture = fixtures ? fixtureSnapshot(fixtures, launchedAt) : { error: 'Fixture unavailable' };
    const [runtime] = await Promise.all([
      harness
        ? captureRuntime(harness, fixtures?.httpOrigin ?? 'http://127.0.0.1/').catch((error: unknown) => ({
            error: errorText(error),
          }))
        : Promise.resolve({ error: 'Harness unavailable; launch may not have completed' }),
      harness ? stopHarnessDiagnostics(harness.app, harness.diagnostics) : Promise.resolve(),
    ]);
    await withDeadline(
      testInfo.attach('native-failure-diagnostics.json', {
        body: JSON.stringify(
          {
            scope: 'Controlled loopback fixtures only; metadata without cookies, auth or socket payloads',
            capturedAt: Date.now(),
            test: { title: testInfo.title, status: testInfo.status, expectedStatus: testInfo.expectedStatus },
            errors: testInfo.errors.map((error) => ({
              message: error.message?.slice(0, 4000),
              stack: error.stack?.slice(0, 8000),
            })),
            netLog: harness?.diagnostics,
            runtime,
            fixture,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      }),
      2000,
    ).catch((error: unknown) => errors.push(`State attachment: ${errorText(error)}`));

    if (harness?.diagnostics) {
      const path = harness.diagnostics.netLogPath;
      const file = await withDeadline(
        (async () => {
          const information = await stat(path);
          if (information.size > ATTACHMENT_LIMIT) throw new Error('NetLog exceeds the 6 MiB attachment cap');
          const body = await readFile(path);
          if (body.byteLength > ATTACHMENT_LIMIT) throw new Error('NetLog exceeds the 6 MiB attachment cap');
          let complete = false;
          try {
            const parsed = JSON.parse(body.toString('utf8')) as { events?: unknown[] };
            complete = Array.isArray(parsed.events);
          } catch {
            // Preserve incomplete metadata separately when a hung native flush timed out.
          }
          return { body, complete };
        })(),
        2000,
      );
      await withDeadline(
        testInfo.attach(file.complete ? 'chromium-net-log.json' : 'chromium-net-log.partial.txt', {
          body: file.body,
          contentType: file.complete ? 'application/json' : 'text/plain',
        }),
        2000,
      );
    }
  } catch (error) {
    errors.push(errorText(error));
  }
  if (errors.length) console.warn('Failure diagnostics incomplete:', errors.join('; '));
}
