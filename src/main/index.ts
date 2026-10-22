import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, Tray } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UnicornController, type TestConfiguration } from './controller';
import { ActivityLog, LocalStore } from './storage';
import { validateBounds, validateCommand, validateSettings } from './core/validation';

// Browser DNS resolution is delegated to numeric-endpoint proxies. The provider's
// Node control-plane request is intentionally independent of Chromium sessions.
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]',
);
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('disable-features', 'AsyncDns,DnsOverHttps,WebTransport');
app.setName('Unicorn');
app.setAppUserModelId('com.oxsagar.unicorn');

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let controller: UnicornController | undefined;
let exiting = false;
let shutdownStarted = false;
let test: TestConfiguration | undefined;
const testEnabled = !app.isPackaged && process.env.UNICORN_E2E === '1';

async function start(): Promise<void> {
  if (testEnabled && process.env.UNICORN_TEST_CONFIG) {
    test = JSON.parse(await readFile(process.env.UNICORN_TEST_CONFIG, 'utf8')) as TestConfiguration;
    if (
      !path.isAbsolute(test.userData) ||
      !Array.isArray(test.proxies) ||
      !new URL(test.diagnosticUrl).hostname
    )
      throw new Error('Invalid local integration-test configuration');
    app.setPath('userData', test.userData);
  }
  if (!testEnabled && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  const store = new LocalStore(app.getPath('userData'));
  const data = await store.load();
  if (test?.settings) data.settings = validateSettings({ ...data.settings, ...test.settings });
  const logs = new ActivityLog(path.join(store.directory, 'logs'));
  await logs.initialize(data.settings.logRetentionDays);
  window = new BrowserWindow({
    title: 'Unicorn',
    width: 1560,
    height: 1000,
    minWidth: 1100,
    minHeight: 740,
    backgroundColor: '#0c101a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  const host = window;
  controller = new UnicornController(host, data, store, logs, test);
  const controls = controller;
  const trustedSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    event.sender === host.webContents && event.senderFrame === host.webContents.mainFrame;
  ipcMain.handle('unicorn:command', (event, input: unknown) => {
    if (!trustedSender(event)) throw new Error('Privileged command rejected from an untrusted renderer');
    return controls.command(validateCommand(input));
  });
  ipcMain.on('unicorn:layout', (event, input: unknown) => {
    if (!trustedSender(event)) return;
    try {
      controls.manager.layout(validateBounds(input));
    } catch (error) {
      logs.add('warn', 'ipc', String(error));
    }
  });
  host.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  host.webContents.on('will-navigate', (event) => event.preventDefault());
  host.webContents.on('will-attach-webview', (event) => event.preventDefault());
  host.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  host.webContents.session.setPermissionCheckHandler(() => false);
  host.once('ready-to-show', () => {
    host.show();
  });
  host.on('close', (event) => {
    if (exiting) return;
    event.preventDefault();
    if (controls.snapshot().settings.closeToTray && tray && !testEnabled) host.hide();
    else app.quit();
  });
  await controls.initialize();
  await host.loadFile(path.join(__dirname, '../renderer/index.html'));
  host.show();
  if (testEnabled) {
    Object.assign(globalThis, {
      __unicornTest: { manager: controls.manager, controller: controls, pool: controls.pool },
    });
  }
  if (!testEnabled) {
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 2; y < 14; y++)
      for (let x = 2; x < 14; x++) {
        const i = (y * 16 + x) * 4;
        pixels[i] = 220;
        pixels[i + 1] = 106;
        pixels[i + 2] = 139;
        pixels[i + 3] = 255;
      }
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
    tray.setToolTip('Unicorn — Browser QA');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Show Unicorn',
          click: () => {
            host.show();
            host.focus();
          },
        },
        {
          label: 'Pause all tests',
          click: () => {
            void controls.command({ type: 'global', action: 'pause' });
          },
        },
        {
          label: 'Emergency stop',
          click: () => {
            void controls.command({ type: 'global', action: 'stop' });
          },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
    tray.on('double-click', () => {
      host.show();
      host.focus();
    });
  }
  powerMonitor.on('suspend', () => {
    logs.add('info', 'power', 'Windows suspended; all test work is paused.');
    void controls.command({ type: 'global', action: 'pause' });
  });
  powerMonitor.on('resume', () => {
    logs.add('info', 'power', 'Windows resumed. Resume tests when network connectivity is ready.');
    controls.changed();
  });
  const smokeOutput = process.argv
    .find((arg) => arg.startsWith('--smoke-output='))
    ?.slice('--smoke-output='.length);
  if (app.isPackaged && smokeOutput && path.isAbsolute(smokeOutput)) {
    setTimeout(() => {
      void (async () => {
        const security = (await host.webContents.executeJavaScript('window.unicorn.security')) as {
          sandboxed: boolean;
          contextIsolated: boolean;
        };
        await writeFile(
          smokeOutput,
          JSON.stringify({
            version: app.getVersion(),
            platform: process.platform,
            windowReady: !host.isDestroyed(),
            browsers: controls.snapshot().browsers.length,
            sandbox: security.sandboxed,
            contextIsolation: security.contextIsolated,
            at: new Date().toISOString(),
          }),
        );
        app.quit();
      })();
    }, 5000);
  }
}

app.on('second-instance', () => {
  window?.show();
  window?.focus();
});
app.on('activate', () => {
  window?.show();
});
app.on('before-quit', (event) => {
  if (exiting) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void (async () => {
    try {
      await controller?.shutdown();
    } catch (error) {
      console.error('Unicorn shutdown failed', error);
    } finally {
      exiting = true;
      tray?.destroy();
      app.quit();
    }
  })();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
start().catch((error) => {
  console.error(error);
  dialog.showErrorBox('Unicorn could not start', String(error));
  exiting = true;
  app.exit(1);
});
