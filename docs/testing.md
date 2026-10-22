# Testing and release evidence

## Required local checks

```sh
npm ci
npm run typecheck
npm run format:check
npm run lint
npm test
npm run build
```

Unit suites cover proxy JSON parsing, all seven eligible countries, invalid/nonpublic endpoints, endpoint and exit-IP collisions, concurrent reservations, cancellation, country mismatch, provider metadata, domain boundaries, URL schemes, distribution, import, budgets, device/settings/IPC validation, lifecycle transitions, pause-aware time, synthetic asset restrictions, and proxy configuration races.

## Real Electron tests on Windows

The Playwright suite launches the actual application and communicates with its real Electron main process and browser views. It does not replace Chromium with mocked pages. Local servers provide deterministic HTTP, HTTPS, WebSocket, proxy, and failure fixtures.

Generate a temporary certificate before running the HTTPS tests:

```powershell
node tests/fixtures/prepare-cert.mjs
$cert = Import-Certificate -FilePath test-results/certificates/fixture.cer -CertStoreLocation Cert:\CurrentUser\Root
try {
  npm run build
  npm run test:e2e
} finally {
  Remove-Item "Cert:\CurrentUser\Root\$($cert.Thumbprint)"
}
```

Only the generated fixture certificate is trusted. The separate untrusted certificate must remain untrusted so TLS-refusal tests remain meaningful. Certificates and private fixture keys are generated under the ignored `test-results` directory and are never committed or bundled. The tests do not use `ignoreHTTPSErrors`, disable certificate verification, or disable the Windows sandbox.

The suite exercises JavaScript, Fetch, cookies, local storage, IndexedDB, cache, service workers, profile separation/restart, mobile/tablet emulation, controlled popups, QA navigation stages, 1/5/10/15/20 live sessions, every selectable count, wrong-country proxies, timeouts, empty pool, dropped proxies, certificate rejection, forbidden destinations, HTTP 403/429, cancellation, pause/resume, and renderer recovery. UI tests use the shipped renderer controls and native view bounds.

## CI and publishing

`.github/workflows/ci.yml` runs source checks on Ubuntu and real Chromium/package verification on `windows-2025`. Reports are uploaded even on failure. On Windows it builds the installer and portable ZIP, runs the packaged executable, silently installs into the temporary runner, launches that installed copy, and computes checksums. Test certificates are removed in an unconditional cleanup step.

The release workflow reuses the same checks. It publishes only after all jobs succeed, validates version/filenames/checksums, and never overwrites an already published version. A version containing a prerelease suffix is published as a GitHub prerelease. GitHub Actions dependencies are pinned to audited upstream tag SHAs; Dependabot tracks future updates.

## Evidence interpretation

- `unit.xml` reports pure logic tests. It does not prove native behavior.
- The Playwright report and `e2e.xml` identify real runtime tests and their pass/fail/skipped status.
- `packaged-smoke.json` and `installed-smoke.json` record the Windows application/version and actual preload sandbox/isolation observations.
- Concurrency-test attachments record the tested browser count and resource samples. They are short-run measurements, not a 24-hour benchmark.
- The npm dependency audit must succeed independently; an inaccessible audit endpoint is a blocked check, not a clean audit.

## Outstanding broader acceptance

A 24-hour soak run, Windows 10 and consumer Windows 11 device coverage, hardware-specific responsiveness baseline, authenticated proxy support, and independent packet-capture leak analysis are not implied by CI. The release candidate remains explicitly limited until its required broader acceptance work is completed. No 24-hour result or native Windows success should be reported unless the corresponding run exists.
