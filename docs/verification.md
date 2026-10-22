# Windows verification record — 1.0.0-rc.1

## Source, results and provenance

The verified source candidate is **`8dd07f0ebf4798df2362dc2f4810946123645087`**, executed on **22 October 2026** in [Actions run 39720790456](https://github.com/OxSagar/unicorn/actions/runs/39720790456). The complete [machine-readable evidence](evidence/windows-candidate.json) preserves the native test list, hardware, measurements, package smoke observations and candidate package hashes.

- **377 unit tests passed**, with zero failures or errors.
- **55 real Electron tests passed**, with zero unexpected results, flaky results or skips. Test retries were disabled. The native suite took **304.691 seconds**.
- Type checking, formatting, linting and production build passed.
- The dependency audit found zero high/critical issues and zero production-package issues; **eight moderate build-tool findings remain**. See the [assessment](dependency-audit.md).
- The NSIS installer and portable ZIP were built on Windows. The actual ZIP was extracted and its `Unicorn.exe` launched. The installer was installed and its installed executable launched separately. Both observations report version `1.0.0-rc.1`, a ready window, four initial profiles, `sandbox: true` and `contextIsolation: true`.
- The installer reported **Authenticode `NotSigned`**. Signing credentials were not supplied.

The reports are attached as `windows-verification-reports` (artifact `12400274671`), `unit-test-reports` (`12400579320`) and `windows-release-assets` (`12400334368`). GitHub Actions artifacts have retention limits; the JSON above preserves the reviewed measurements in the repository.

These measurements are for the named candidate. [PR #1](https://github.com/OxSagar/unicorn/pull/1) additionally records documentation, a targeted stress-fixture deadline adjustment and the existing-tag publication guard. Release automation repeats the complete checks, package construction and launch checks at the **exact merged commit** before publication. The authoritative hashes for downloads are the `SHA256SUMS.txt` attached to that release; the candidate hashes in this evidence file must not be substituted for them.

## Native coverage

The 55 tests use actual Chromium renderer processes, persistent partitions and local TCP proxy/web servers. Controlled diagnostic fixtures report known exit identities and countries so allocation policy is deterministic. They do not demonstrate 20 independent public egress IPs or live geographical availability.

Coverage includes real JavaScript/Fetch/WebSockets; cookies, LocalStorage, IndexedDB, CacheStorage and service workers; profile isolation/restart and six native cleanup cases; desktop/mobile/tablet emulation; permitted and denied popups; URL input/import/edit/review; native view bounds; all selectable counts; concurrent 1/5/10/15/20 sessions; approved QA stages and missing/excluded links; quotas; restrictions and visible challenges; proxy failure/replacement; HTTP CONNECT, TLS-to-proxy and SOCKS5; untrusted-certificate refusal; pause, Stop and eight deliberately injected renderer crashes.

The six crash-related tests executed **eight intentional native renderer crashes**: one manual containment/reopen case and seven injections across five automated recovery cases. They verify retained profile/job identity, sibling isolation, Pause/Resume, Stop, retry exhaustion and retry-limit zero. A separate health-probe/heartbeat unit suite checks bounded watchdog behavior. These tests do not establish a production crash rate or recovery of a completely frozen main process.

## Measured concurrency

Runner: **Windows Server 2025 Datacenter, build 10.0.26100**, exposing **four logical CPUs**, **16,379 MiB RAM**, and the host CPU model **AMD EPYC 9V45 96-Core Processor**. Only four logical CPUs were available to the job. This is a hosted runner, not a consumer Windows 10/11 reference device.

| Active profiles | Workload elapsed (ms) | Summed CPU sample | Summed working set (MiB) | Electron processes | Dashboard IPC (ms) |
| --------------: | --------------------: | ----------------: | -----------------------: | -----------------: | -----------------: |
|               1 |                   122 |            17.59% |                      402 |                  5 |                  5 |
|               5 |                 1,008 |            18.64% |                      788 |                  9 |                  6 |
|              10 |                 2,916 |            10.58% |                    1,291 |                 14 |                  7 |
|              15 |                 4,013 |            10.84% |                    1,793 |                 19 |                 11 |
|              20 |                 4,991 |            14.37% |                    2,288 |                 24 |                 14 |

`loadMs` starts after profile creation and includes proxy preparation, navigation, page-state checks and metrics collection. It is not only document-load time. CPU is the sum of Electron's process percentages at one sample, not a sustained workload average. Memory sums working sets and can double-count shared OS pages. Dashboard IPC is a snapshot-command roundtrip, not paint latency or frame rate. Pages are small controlled fixtures; arbitrary websites can consume substantially more resources.

Every count from **1 through 20** was also created, resized and closed in the all-count lifecycle test. This is separate from simultaneous navigation at the five counts above.

## Three-cycle scheduling and storage run

A single Start command scheduled **60 completed jobs across 20 profiles**, using three real one-minute recurrence cycles. The recorded workload elapsed time was **141.840 seconds**, with **69 samples**. Each profile's two recurrence gaps measured **60,641–61,288 ms** after the preceding job finished. No clock was accelerated and no additional Start command was sent.

| Observation                            | Recorded result                                              |
| -------------------------------------- | ------------------------------------------------------------ |
| Completed / failed / cancelled jobs    | 60 / 0 / 0                                                   |
| Per-profile LocalStorage marker checks | All 20 markers preserved after each of three cycles          |
| Fixture page requests                  | 80: 20 preparatory navigations plus 60 scheduled navigations |
| Direct fixture requests                | 0                                                            |
| Peak unique active proxy leases        | 20                                                           |
| Active leases after Stop               | 0                                                            |
| Summed working set                     | 1,860 → 1,510 MiB; sampled peak 2,084 MiB                    |
| Summed CPU samples                     | Median 0.4%; maximum 20.3%                                   |
| Dashboard IPC                          | Median 18.13 ms; maximum 81.89 ms                            |
| Electron processes                     | 24 throughout                                                |
| Heartbeat counter                      | 2 → 69                                                       |
| Peak reported heartbeat delay          | 40 ms                                                        |

The workload configured `retryLimit: 0` and all jobs completed. It did not collect a separate systemwide crash-event counter. This evidence covers a short controlled workload and does **not** establish bounded memory over 24 hours, a production crash rate, physical power-loss integrity or consumer hardware responsiveness.

## Controlled WebRTC UDP observation

The test first sent a positive-control datagram to an IPv4 loopback STUN trap and confirmed receipt. It then started actual Chromium ICE gathering under `disable_non_proxied_udp`. Gathering completed in **3,007.9 ms**, with **zero observed browser datagrams and no candidate protocols**. This verifies one controlled destination over that observation window. It is not a DNS, IPv6, operating-system or comprehensive packet-capture audit.

HTTP/HTTPS/WebSocket failure tests also assert zero direct fixture requests when a proxy is missing or fails. Application/session enforcement is distinct from a system firewall. [Security boundaries](security.md) remain applicable.

## Discovered defects and retained failure evidence

Earlier Windows runs exposed a popup view lifecycle defect and a fixture-certificate directory being cleared by Playwright. Both were fixed before the passing candidate above. Native profile cleanup tests also exposed stale Back/Forward flags after history clearing; the flags now follow Chromium's actual history state, and all six profile cases passed on Windows.

The previous 42-test [PR run 39719712501](https://github.com/OxSagar/unicorn/actions/runs/39719712501) had **41 passes and one failure**. The 55-test [PR run 39720794860](https://github.com/OxSagar/unicorn/actions/runs/39720794860) had **54 passes and one failure**. Both failures were the 20-profile case reaching the stress fixture's six-second navigation deadline; matching push runs passed. The production default was already 45 seconds. The final fixture now uses a bounded 15-second allowance for concurrent-load and three-cycle tests. Test retries remain zero, every traffic/isolation assertion remains, and the independent one-second slow-navigation failure test is unchanged. The final branch and release checks must pass with this correction before publication.

The release tag guard was also exercised in five temporary-repository cases: absent tag, matching lightweight tag and matching annotated tag were allowed; mismatched lightweight and annotated tags were rejected. Publication never replaces an existing release and does not claim GitHub immutable-release settings have been enabled.

## Remaining production acceptance

This is an evaluation release candidate. The [40-row acceptance matrix](acceptance.md) records implementation, successful tests, partial functionality and gaps. The 24-hour soak, consumer Windows 10/11 benchmarks, independent packet-level leak audit, and several native desktop/site interaction scenarios remain incomplete. No stable-production acceptance is claimed.
