import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'test-results/certificates');
mkdirSync(directory, { recursive: true });
const bundled = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
const openssl = process.platform === 'win32' && existsSync(bundled) ? bundled : 'openssl';
const key = join(directory, 'fixture.key');
const pem = join(directory, 'fixture.pem');
const der = join(directory, 'fixture.cer');
execFileSync(
  openssl,
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Unicorn Local QA Fixture',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
    '-keyout',
    key,
    '-out',
    pem,
  ],
  { stdio: 'pipe' },
);
execFileSync(openssl, ['x509', '-in', pem, '-outform', 'der', '-out', der], { stdio: 'pipe' });
// Deliberately untrusted second CA exercises refusal without disabling TLS verification.
execFileSync(
  openssl,
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Unicorn Untrusted Fixture',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-keyout',
    join(directory, 'untrusted.key'),
    '-out',
    join(directory, 'untrusted.pem'),
  ],
  { stdio: 'pipe' },
);
console.log(`Created local QA certificate: ${der}`);
console.log('Windows CI must import fixture.cer into CurrentUser\\Root before HTTPS browser tests.');
