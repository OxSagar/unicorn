import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
const files = (await readdir('release')).filter((name) => /\.(exe|zip)$/.test(name)).sort();
if (files.length < 2) throw new Error('Installer and portable ZIP are both required.');
const lines = await Promise.all(
  files.map(
    async (name) =>
      `${createHash('sha256')
        .update(await readFile(`release/${name}`))
        .digest('hex')}  ${name}`,
  ),
);
await writeFile('release/SHA256SUMS.txt', `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
