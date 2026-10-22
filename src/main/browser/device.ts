import type { WebContents } from 'electron';
import type { DeviceConfig } from '../../shared/types';
import { withDeadline } from './deadline';

function command(contents: WebContents, method: string, params: Record<string, unknown>): Promise<unknown> {
  return withDeadline(contents.debugger.sendCommand(method, params), 8000);
}

export async function applyDevice(contents: WebContents, device: DeviceConfig, scale = 1): Promise<void> {
  if (contents.isDestroyed()) return;
  if (contents.isDevToolsOpened()) contents.closeDevTools();
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
  const chromeVersion = process.versions.chrome;
  const mobile = device.mobile;
  const platform = mobile ? 'Android' : 'Windows';
  const tablet = mobile && device.preset === 'tablet';
  const uaPlatform = mobile ? 'Linux; Android 14; Unicorn Test Device' : 'Windows NT 10.0; Win64; x64';
  const userAgent = `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}${mobile && !tablet ? ' Mobile' : ''} Safari/537.36 UnicornQA/1.0`;
  contents.setUserAgent(userAgent);
  await command(contents, 'Emulation.setUserAgentOverride', {
    userAgent,
    platform: mobile ? 'Linux armv8l' : 'Win32',
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: chromeVersion.split('.')[0] }],
      fullVersionList: [{ brand: 'Chromium', version: chromeVersion }],
      fullVersion: chromeVersion,
      platform,
      platformVersion: mobile ? '14.0.0' : '10.0.0',
      architecture: mobile ? 'arm' : 'x86',
      model: mobile ? 'Unicorn Test Device' : '',
      mobile: mobile && !tablet,
      bitness: '64',
      wow64: false,
    },
  });
  await command(contents, 'Emulation.setDeviceMetricsOverride', {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.scaleFactor,
    mobile,
    screenWidth: device.width,
    screenHeight: device.height,
    screenOrientation: {
      type: device.landscape ? 'landscapePrimary' : 'portraitPrimary',
      angle: device.landscape ? 90 : 0,
    },
    scale: Math.max(0.1, Math.min(1, scale)),
  });
  await command(contents, 'Emulation.setTouchEmulationEnabled', {
    enabled: device.touch,
    maxTouchPoints: device.touch ? 5 : 1,
  });
}

export async function fitDevice(
  contents: WebContents,
  device: DeviceConfig,
  width: number,
  height: number,
): Promise<void> {
  if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
  await command(contents, 'Emulation.setDeviceMetricsOverride', {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.scaleFactor,
    mobile: device.mobile,
    screenWidth: device.width,
    screenHeight: device.height,
    screenOrientation: {
      type: device.landscape ? 'landscapePrimary' : 'portraitPrimary',
      angle: device.landscape ? 90 : 0,
    },
    scale: Math.max(0.1, Math.min(1, width / device.width, height / device.height)),
  });
}

export async function readDiagnostic(contents: WebContents): Promise<Record<string, unknown>> {
  return withDeadline(
    contents.executeJavaScriptInIsolatedWorld(710, [
      {
        code: `({ userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight }, devicePixelRatio, touchPoints: navigator.maxTouchPoints, screen: { width: screen.width, height: screen.height, orientation: screen.orientation?.type }, clientHints: navigator.userAgentData?.toJSON(), javascript: true, nodeIntegration: typeof process !== 'undefined', privilegedApi: typeof window.unicorn !== 'undefined' })`,
      },
    ]) as Promise<Record<string, unknown>>,
    8000,
  );
}
