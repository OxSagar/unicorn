# Acceptance matrix — Unicorn 1.0.0-rc.2

The 22 October update supersedes the original brief's pre-assignment proxy validation and extensive customization requirements: assign API-listed eligible-country proxies directly, add Austria, and provide a simpler interface. The stable IDs below retain the original requirement mapping.

This is an evaluation release candidate. The associated [release workflow](https://github.com/OxSagar/unicorn/actions) supplies the exact current unit/native counts, pass/fail/skipped results, Windows package launches and checksums. The [rc.1 record](verification.md) is historical; it does not verify changed rc.2 behavior. Test references below describe coverage and do not independently assert a completed run. The [original matrix](https://github.com/OxSagar/unicorn/blob/v1.0.0-rc.1/docs/acceptance.md) remains available at its version tag.

## Application, profiles and devices

| ID  | Current implementation                                                       | Evidence / limit                                                                                                                 |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Modular source, lockfile, docs, CI and license notice                        | [Architecture](architecture.md); owner has not selected an open-source license                                                   |
| A02 | Real Electron WebContentsView Chromium engines                               | [Native browser suite](../tests/e2e/browser.spec.ts); consumer Windows 10/11 matrix remains open                                 |
| A03 | Every selectable count 1–20, individual/global lifecycle                     | Native all-count lifecycle and 1/5/10/15/20 concurrency; arbitrary heavy-site performance unverified                             |
| A04 | Responsive grid, navigation, focus and workspace expansion                   | [UI suite](../tests/e2e/ui.spec.ts); no OS fullscreen browser mode or independent panel drag-resizing                            |
| A05 | Chromium JavaScript, DOM, Fetch, WebSockets and persistent web stores        | Native browser/profile suites; representative fixtures do not establish complete forms/media/web-platform conformance            |
| A06 | Manual downloads, ordinary dialogs and overlays                              | Source-reviewed; automated downloads denied; dedicated native download/consent acceptance remains open                           |
| A07 | Persistent isolated website stores, device settings and saved URL history    | [Profile suite](../tests/e2e/profiles.spec.ts); native navigation stack does not persist; no arbitrary preferences/grants editor |
| A08 | Cache/cookie/history cleanup, complete reset, storage usage, reopen          | Native profile cases; clear HTTP cache preserves CacheStorage; physical power-loss behavior unverified                           |
| A09 | Desktop/mobile/tablet controls; existing custom profiles retained internally | Native presets/UI; custom controls removed from the interface by request; not physical-device equivalence                        |
| A10 | Actual page diagnostics available in session inspection                      | Native device cases; no standalone diagnostics page                                                                              |

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

| ID  | Current implementation                                                                   | Evidence / limit                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| A19 | URL input/import, duplicate handling, exact persistent editor draft                      | UI and parsing suites; 2M-character bound; original imported file bytes are not archived                                               |
| A20 | Same/round-robin/balanced/manual distribution and reviewed pending edits                 | Controller/UI suites; simpler ordinary workflow; balance is a heuristic, not continuous migration                                      |
| A21 | Approved host scope, synthetic identification and staging confirmation                   | Scope/gate/native policy suites; required CDN/API hosts need approval for QA                                                           |
| A22 | Landing/internal/approved-external QA with default stage settings                        | Native browser/policy suites use short timings; full default 200-second sequence not established by those tests                        |
| A23 | Gradual scrolling with cancellation/pause checkpoints                                    | Control/native QA tests; complex nested/virtualized scrollers need broader acceptance                                                  |
| A24 | Scoped anchor discovery and saved exclusions                                             | Policy/exclusion tests; URL navigation does not execute click handlers or JS-only routing                                              |
| A25 | Reviewed Start, repeat toggle/interval, saved operating-window policy, Pause/Resume/Stop | Controller/UI and [three-cycle suite](../tests/e2e/stability.spec.ts); interactive session required; multi-day reliability unverified  |
| A26 | Persisted daily navigation and HTTP/S/WebSocket-request budgets                          | Unit/native quota tests; advanced quota values are preserved internally, not exposed in simplified settings; WebSocket frames excluded |
| A27 | Managed popup ownership, shared profile/proxy, inspection and dismissal                  | Native allowed/denied popup cases; eight children per profile; no independent OS popunder windows                                      |
| A28 | Four sections: Browsers, Links, Proxies, Settings; dark/light themes                     | UI/native bounds and visual review; nine-section navigation and excessive customization removed by request                             |
| A29 | Bounded structured logs, rotation, redaction and secondary export controls               | [Storage tests](../tests/unit/storage.test.ts); export uses retained records; broader native export acceptance open                    |
| A30 | Local screenshots/timings/errors and results export                                      | QA suite/source review; results do not bundle captures; retained URLs/screenshots can contain test data                                |

## Reliability and delivery

| ID  | Current implementation                                                             | Evidence / limit                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A31 | Bounded queues/logs/captures, coalesced snapshots and memory deferral              | Unit/native resource cases; no validator sessions; no adaptive CPU concurrency; lists are paginated                                                     |
| A32 | Actual hosted Windows concurrency/resource measurements                            | Current release attachments; [rc.1 measurements](performance.md) are historical; consumer benchmarks remain open                                        |
| A33 | Bounded approved-job renderer recovery, health probes and heartbeat                | [Recovery suite](../tests/e2e/recovery.spec.ts) and unit tests; no external frozen-main supervisor; manual/OOM/integrity/restriction cases are terminal |
| A34 | Atomic state, profile flushes, saved recurrence and rc.1 settings migration        | Storage/controller/native profile cases; live scheduler process-kill and physical power-loss acceptance remain open                                     |
| A35 | Tray/login controls, suspend pause and resume notice                               | Source review; native desktop-event acceptance incomplete; no automatic OS reconnect/resume                                                             |
| A36 | Sandboxed remote content, isolation, restricted IPC, default-deny permissions, TLS | Unit/native privilege/package smokes; no credential vault or permission-grant editor; broader security audit open                                       |
| A37 | Updated unit and real Windows Chromium/proxy/UI/failure suites                     | Current Actions reports are authoritative; provider outage, OS reconnect and live scheduling interruption gaps remain                                   |
| A38 | Short three-cycle workload and documented 24-hour procedure                        | [Stability suite](../tests/e2e/stability.spec.ts); 24-hour soak remains unperformed; no production crash-rate claim                                     |
| A39 | Windows installer/ZIP, actual package launches, checksums, gated versioned release | [Release workflow](../.github/workflows/release.yml); rc.2 remains an unsigned evaluation candidate                                                     |
| A40 | Manual releases link                                                               | Automatic updates, optional installed-Chrome backend and Windows service remain absent                                                                  |

## Promotion gates

Before production acceptance, complete the 24-hour controlled soak, consumer Windows 10/11 benchmarks and independent packet-level network audit; resolve remaining mandatory partial requirements and native failure/desktop test gaps. The user-requested removal of proxy validation and customization is the current product scope, not an outstanding defect.

Public proxy availability and API geography remain external dependencies. Signing requires valid credentials if signed delivery is desired. Passing fixtures or source checks must not be reported as public-country availability, production endurance or consumer hardware acceptance.
