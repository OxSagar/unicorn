# Acceptance matrix — Unicorn 1.0.0-rc.3

The latest 22 October user instruction supersedes the original extensive customization: expose only browser count, device type and links, followed by Distribute and Start. Proxy preflight remains removed and Austria remains eligible. The stable IDs below retain the original requirement mapping; internal compatibility APIs are distinguished from controls available to the user.

This is an evaluation release candidate. The associated [release workflow](https://github.com/OxSagar/unicorn/actions) supplies the exact current unit/native counts, pass/fail/skipped results, Windows package launches and checksums. The [rc.1 record](verification.md) is historical; it does not verify changed rc.3 behavior. Test references below describe coverage and do not independently assert a completed run. The [original matrix](https://github.com/OxSagar/unicorn/blob/v1.0.0-rc.1/docs/acceptance.md) remains available at its version tag.

## Application, profiles and devices

| ID  | Current implementation                                                        | Evidence / limit                                                                                                                 |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Modular source, lockfile, docs, CI and license notice                         | [Architecture](architecture.md); owner has not selected an open-source license                                                   |
| A02 | Real Electron WebContentsView Chromium engines                                | [Native browser suite](../tests/e2e/browser.spec.ts); consumer Windows 10/11 matrix remains open                                 |
| A03 | Select 1–20 browsers without a separate Apply step; automatically assign work | Native all-count lifecycle and concurrency; minimal workflow tests; arbitrary heavy-site performance unverified                  |
| A04 | Live browser previews, status and optional expansion on one scrolling screen  | UI/native clipping tests; address bars, per-profile controls and independent panel drag-resizing are absent                      |
| A05 | Chromium JavaScript, DOM, Fetch, WebSockets and persistent web stores         | Native browser/profile suites; representative fixtures do not establish complete forms/media/web-platform conformance            |
| A06 | Internal manual downloads/dialogs; automated QA downloads denied              | Source-reviewed; no manual-address flow in the minimal UI; broader download/desktop-event acceptance remains open                |
| A07 | Persistent isolated website stores, device settings and saved URL history     | [Profile suite](../tests/e2e/profiles.spec.ts); native navigation stack does not persist; no arbitrary preferences/grants editor |
| A08 | Existing profile stores retained; cleanup/reset/storage APIs kept internally  | Native profile cases; maintenance controls removed from the minimal UI; physical power-loss behavior unverified                  |
| A09 | One Desktop/Mobile/Tablet choice applied to participating profiles at Start   | Native device/UI cases; unused custom profiles retained; device emulation is not physical-device equivalence                     |
| A10 | Actual page/device diagnostics retained internally                            | Native device cases; no session inspector or diagnostics page in the ordinary UI                                                 |

## Proxies and authorization

| ID  | Current implementation                                                         | Evidence / limit                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A11 | Allocate eligible endpoint, configure fixed route, then enable browser traffic | [Gate unit tests](../tests/unit/engine-network.test.ts), [native failures](../tests/e2e/failures.spec.ts); application-level control, not an OS firewall                     |
| A12 | HTTP CONNECT, SOCKS5 and controlled TLS-to-proxy transport                     | [Protocol suite](../tests/e2e/protocols.spec.ts), [STUN observation](../tests/e2e/leaks.spec.ts); no authenticated/SOCKS4/manual HTTPS proxy support; full packet audit open |
| A13 | ProxyScrape API countries US/GB/CA/FR/DE/JP/IT/AT, endpoint parsing and dedupe | [Parser/provider tests](../tests/unit/core-proxy.test.ts), [provider contract](proxy-contract.md); API geography is not independently verified                               |
| A14 | Preflight validation removed by request; no exit/latency/diagnostic service    | Native direct-allocation and zero-diagnostic assertions; actual availability is learned on page connection; target TLS checks remain                                         |
| A15 | Atomic unique IP/port reservations, cancellation-safe delivery and release     | Pool unit/native concurrency tests; distinct public exit IPs are no longer checked or promised                                                                               |
| A16 | Startup/reserve/stale/cycle/failure refresh with finite pagination/cooldowns   | [Provider suite](../tests/unit/provider.test.ts); native provider outage scenarios remain incomplete                                                                         |
| A17 | Actual recognized transport failure quarantine and bounded QA retry            | Pool/manager/failure tests; manual browsing reports failure; dedicated mid-stage retry acceptance remains open                                                               |
| A18 | HTTP restrictions and detected challenges stop affected work                   | [Challenge suite](../tests/e2e/challenges.spec.ts), [policy suite](../tests/e2e/policies.spec.ts); custom challenge detection is incomplete                                  |

## Links, QA and interface

| ID  | Current implementation                                                            | Evidence / limit                                                                                                  |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A19 | Pasted URL list, automatic duplicate removal and persistent editor draft          | UI/parsing suites; bounded text; file-import button and custom duplicate options removed                          |
| A20 | Automatic round-robin/repeated filling, immutable prepared batch, explicit Start  | Controller/UI suites; one link reaches all selected browsers; changed inputs require redistribution               |
| A21 | Temporary exact-host approval from the displayed batch and deliberate Start       | Scope/gate/controller/native cases; unrelated CDN/API hosts stay blocked; no persisted blanket approval           |
| A22 | Landing/internal/approved-external QA with default stage settings                 | Native browser/policy suites use short timings; full default 200-second sequence not established by those tests   |
| A23 | Gradual scrolling with cancellation/pause checkpoints                             | Control/native QA tests; complex nested/virtualized scrollers need broader acceptance                             |
| A24 | Scoped anchor discovery and saved exclusions                                      | Policy/exclusion tests; URL navigation does not execute click handlers or JS-only routing                         |
| A25 | One accepted batch per Start, Stop, continuation after pause; no recurrence setup | Controller/UI cases; startup never arms saved recurrence; legacy scheduler tests remain internal coverage         |
| A26 | Persisted daily navigation and HTTP/S/WebSocket-request budgets                   | Unit/native quota tests; advanced quota values are preserved internally; WebSocket frames excluded                |
| A27 | Managed popup ownership, shared profile/proxy, inspection and dismissal           | Native allowed/denied popup cases; eight children per profile; no independent OS popunder windows                 |
| A28 | One screen: browser count, device type, links, Distribute and Start               | UI/native bounds and visual review; no sidebar, Settings page, Apply step or extra customization                  |
| A29 | Bounded structured logs, rotation and redaction; export API retained internally   | Storage tests; no export controls in the minimal flow; broader native export acceptance remains open              |
| A30 | Local QA captures/timings/errors, inline run results                              | QA suite/source review; internal export does not bundle captures; retained URLs/screenshots may contain test data |

## Reliability and delivery

| ID  | Current implementation                                                             | Evidence / limit                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A31 | Bounded queues/logs/captures, coalesced snapshots and memory deferral              | Controller/core/native resource cases; no preflight sessions; no adaptive CPU-based concurrency                                                         |
| A32 | Actual hosted Windows concurrency/resource measurements                            | Current release attachments; [rc.1 measurements](performance.md) are historical; consumer benchmarks remain open                                        |
| A33 | Bounded approved-job renderer recovery, health probes and heartbeat                | [Recovery suite](../tests/e2e/recovery.spec.ts) and unit tests; no external frozen-main supervisor; manual/OOM/integrity/restriction cases are terminal |
| A34 | Atomic state, profile flushes, retained preferences and inert saved jobs           | Storage/controller/native cases; temporary review approval never persists; physical power-loss acceptance remains open                                  |
| A35 | Retained desktop preferences, tray stop and suspend pause                          | Source review; no desktop-preference settings page; broader native desktop-event acceptance incomplete                                                  |
| A36 | Sandboxed remote content, isolation, restricted IPC, default-deny permissions, TLS | Unit/native privilege/package smokes; no credential vault or permission-grant editor; broader security audit open                                       |
| A37 | Updated unit and real Windows Chromium/proxy/UI/failure suites                     | Current Actions reports are authoritative; provider outage, OS reconnect and live scheduling interruption gaps remain                                   |
| A38 | Short three-cycle workload and documented 24-hour procedure                        | [Stability suite](../tests/e2e/stability.spec.ts); 24-hour soak remains unperformed; no production crash-rate claim                                     |
| A39 | Windows installer/ZIP, actual package launches, checksums, gated versioned release | [Release workflow](../.github/workflows/release.yml); rc.3 remains an unsigned evaluation candidate                                                     |
| A40 | Versioned GitHub releases; manual installation of updates                          | No automatic updater, independently installed Chrome backend or Windows service                                                                         |

## Promotion gates

Before production acceptance, complete the 24-hour controlled soak, consumer Windows 10/11 benchmarks and independent packet-level network audit; resolve remaining mandatory partial requirements and native failure/desktop test gaps. The user-requested removal of proxy validation and customization is the current product scope, not an outstanding defect.

Public proxy availability and API geography remain external dependencies. Signing requires valid credentials if signed delivery is desired. Passing fixtures or source checks must not be reported as public-country availability, production endurance or consumer hardware acceptance.
