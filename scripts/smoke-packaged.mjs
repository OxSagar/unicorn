import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
if (process.platform !== 'win32') throw new Error('Packaged executable verification must run on Windows.');
await mkdir('test-results', { recursive: true });
const output = path.resolve('test-results/packaged-smoke.json');
await rm(output, { force: true });
const child = spawn(path.resolve('release/win-unpacked/Unicorn.exe'), [`--smoke-output=${output}`], {
  stdio: 'inherit',
});
const code = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error('Packaged application timed out'));
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
  result.windowReady !== true ||
  result.browsers < 1 ||
  result.sandbox !== true
)
  throw new Error('Packaged smoke check failed');
console.log(JSON.stringify(result, null, 2));
