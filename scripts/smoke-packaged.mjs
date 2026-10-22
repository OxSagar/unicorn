import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
if (process.platform !== 'win32') throw new Error('Packaged executable verification must run on Windows.');
await mkdir('test-results', { recursive: true });
const output = path.resolve('test-results/packaged-smoke.json');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const archiveName = `Unicorn-Portable-v${version}-x64.zip`;
const directory = await mkdtemp(path.join(tmpdir(), 'unicorn-portable-smoke-'));
await rm(output, { force: true });

try {
  // Exercise the exact distributed archive and its neighboring runtime files.
  // Paths are environment values, never interpolated into PowerShell source.
  await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:UNICORN_SMOKE_ARCHIVE -DestinationPath $env:UNICORN_SMOKE_DIRECTORY -Force",
      ],
      {
        timeout: 120000,
        env: {
          ...process.env,
          UNICORN_SMOKE_ARCHIVE: path.resolve('release', archiveName),
          UNICORN_SMOKE_DIRECTORY: directory,
        },
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  const child = spawn(path.join(directory, 'Unicorn.exe'), [`--smoke-output=${output}`], {
    stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (child.pid)
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 }, () => {
          reject(new Error('Packaged application timed out; scoped process-tree cleanup attempted'));
        });
      else reject(new Error('Packaged application did not start before the deadline'));
    }, 60000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  if (code !== 0) throw new Error(`Packaged application exited with status ${code}`);
  const result = JSON.parse(await readFile(output, 'utf8'));
  if (
    result.platform !== 'win32' ||
    result.version !== version ||
    result.windowReady !== true ||
    !Number.isInteger(result.browsers) ||
    result.browsers < 1 ||
    result.browsers > 20 ||
    result.sandbox !== true ||
    result.contextIsolation !== true
  )
    throw new Error('Packaged smoke check failed');
  const evidence = { ...result, archive: archiveName, extractedArchiveLaunched: true };
  await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
