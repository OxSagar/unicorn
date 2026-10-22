import { readFile, readdir } from 'node:fs/promises';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
const ref = process.env.GITHUB_REF ?? '';
if (ref.startsWith('refs/tags/') && ref !== `refs/tags/v${version}`)
  throw new Error('Version and release tag differ');
const files = await readdir('release');
for (const name of [
  `Unicorn-Setup-v${version}-x64.exe`,
  `Unicorn-Portable-v${version}-x64.zip`,
  'SHA256SUMS.txt',
]) {
  if (!files.includes(name)) throw new Error(`Missing release asset: ${name}`);
}
const notes = await readFile('docs/release-notes.md', 'utf8');
if (!notes.includes(version)) throw new Error('Release notes must name the exact version');
console.log(`Verified complete release asset set for ${version}`);
