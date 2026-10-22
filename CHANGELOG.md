# Changelog

## 1.0.0-rc.3 — 2026-10-22

- Replace the four-page interface with browser count, device type, pasted links, Distribute and Start on one screen.
- Automatically spread links across the selected browsers; apply the selected real Chromium device preset at Start without a separate Apply step.
- Bind Start to the exact prepared batch and visible website authorization; changing inputs requires redistribution.
- Keep Stop available during preparation and proxy waits, and retain live browser previews with scroll-aware native clipping.
- Run each accepted batch once and prevent saved recurrence from starting on app launch; preserve unrelated saved preferences, jobs and profile data.
- Retain direct API proxy assignment, all eight eligible countries including Austria, and fixed proxy routing without direct fallback.

## 1.0.0-rc.2 — 2026-10-22

- Assign eligible ProxyScrape endpoints directly from the API without preflight diagnostics, exit-IP verification, or measured-latency checks.
- Add Austria (`AT`) alongside US, GB, CA, FR, DE, JP and IT.
- Keep unique endpoint allocation, fixed-proxy browser routing, blocked direct fallback, and bounded handling of actual connection failures.
- Simplify navigation to Browsers, Links, Proxies and Settings, with basic device presets and fewer customization controls.
- Remove obsolete validation commands/settings and migrate existing saved settings while preserving profiles, queues and other user configuration.
- Keep repetition disabled when Stop arrives during a settings save, and release failed endpoints after page-initiated navigation errors.
- Update native and unit coverage for direct assignment, absent diagnostics, Austria and the simplified interface.

## 1.0.0-rc.1 — 2026-10-22

Initial release candidate for Windows x64.

- Added persistent isolated Chromium profile management, native view grid, navigation, profiles, and popup inspection.
- Added device emulation, ProxyScrape ingestion, seven-country filtering, live HTTPS exit verification, unique leases, blocked networking, and bounded recovery.
- Added authorized URL distribution, cancellable QA stages, scheduling, request budgets, diagnostics, and real resource telemetry.
- Added typed IPC validation, sandboxed renderers, restricted privileges, local storage, log rotation, and Windows tray/login integration.
- Added unit and native Electron integration suites, controlled proxy fixtures, Windows installer/portable packaging, checksums, and gated release automation.

The release candidate designation is deliberate. Long-duration and consumer-device acceptance items are tracked in the testing/performance documents.
