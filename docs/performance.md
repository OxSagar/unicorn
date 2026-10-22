# Performance and reliability

## Implemented controls

Unicorn shares one Electron runtime and creates separate persistent Chromium sessions and renderer views. The renderer UI subscribes to coalesced snapshots. Browser views are reused, remote JavaScript stays enabled, background throttling is disabled for accurate timed QA, lists are bounded/paginated, and screenshot capture is limited to stage boundaries.

The application samples actual Electron process CPU and working-set memory every two seconds. CPU is the sum of Electron's process CPU percentages; the measurement is not a page-view metric. Memory is the summed process working set, so shared operating-system pages can be counted more than once. The resource screen also shows system free/total memory and process count. Every sample increments a heartbeat counter and measures the monotonic delay beyond the two-second polling interval; current/peak delay and the last heartbeat time are visible. A bounded heartbeat log is written once per minute. A sampling gap includes main-process stalls and system suspension; this telemetry does not replace an external process supervisor.

Balanced assignment scores each selected profile using pending/running job count plus its current renderer CPU percentage divided by 25 and working-set MB divided by 512. This documented heuristic defers assignment toward less busy renderers; it does not migrate existing jobs or predict arbitrary page cost.

New QA jobs wait when the configured memory budget is exceeded. Existing browser profiles remain intact. Proxy validation uses at most four parallel Chromium validation sessions. Each browser has bounded retries and finite navigation/operation timeouts. A renderer watchdog probes eligible loaded pages every ten seconds, allows five seconds per probe, and stops a profile after two consecutive misses. Only confirmed eligible renderer exits can trigger bounded replay of an already accepted QA job. The same profile is retained; memory exhaustion and site restrictions require manual review. Captures, histories, queues, and logs have retention/size limits.

## Reference hardware guidance

For a large grid, begin with Windows 11 x64, a modern 8-core CPU, 16 GB RAM or more, and an SSD. Page complexity, JavaScript, video, proxy latency, and device pixel ratio dominate actual resource use. A 20-profile support limit is not a claim that every computer can render 20 heavy websites without lag.

GitHub-hosted Windows runners are a verification environment; their available CPU/RAM vary and are not a substitute for a consumer-device benchmark. Concurrency tests attach real resource samples and response latency so the exact test run can be assessed.

## Short-run evidence

The [Windows verification record](verification.md) and [machine-readable evidence](evidence/windows-candidate.json) identify the exact source SHA, run, test results and hardware. The hosted runner exposed four logical CPUs and 16,379 MiB RAM on Windows Server 2025. Native tests passed concurrent navigation at 1, 5, 10, 15 and 20 profiles, plus creation/resizing/closure at every count from 1 through 20.

| Profiles | Workload elapsed (ms) | Summed CPU sample | Summed working set (MiB) | Electron processes | Dashboard IPC (ms) |
| -------: | --------------------: | ----------------: | -----------------------: | -----------------: | -----------------: |
|        1 |                   122 |            17.59% |                      402 |                  5 |                  5 |
|        5 |                 1,008 |            18.64% |                      788 |                  9 |                  6 |
|       10 |                 2,916 |            10.58% |                    1,291 |                 14 |                  7 |
|       15 |                 4,013 |            10.84% |                    1,793 |                 19 |                 11 |
|       20 |                 4,991 |            14.37% |                    2,288 |                 24 |                 14 |

Workload elapsed includes proxy preparation, navigation, page verification and metrics collection after profile creation. CPU is a single aggregate Electron sample, not a sustained average. Summed working sets may count shared OS pages more than once. Dashboard IPC is a snapshot-command roundtrip, not visual frame rate or input-to-paint latency. The pages are small fixtures, not arbitrary production workloads.

A separate **141.840-second** run started 20 profiles once and completed **60 jobs across three actual one-minute cycles**. All profile storage markers survived; no direct fixture request occurred; Stop released all leases. Across 69 samples, memory was 1,860 MiB initially and 1,510 MiB finally, with a 2,084 MiB peak; median/max summed CPU was 0.4%/20.3%; median/max dashboard IPC was 18.13/81.89 ms. The process count stayed at 24, and heartbeat delay peaked at 40 ms. This short run does not establish long-term memory stability or a production crash rate.

The native suite also deliberately injected eight renderer crashes across six cases; all recovery/containment tests passed. The short scheduling workload configured renderer retries to zero and completed every job, but did not collect a separate systemwide crash counter. See the verification record for exact scope and earlier failed stress-fixture runs. Consumer Windows benchmarks and the 24-hour procedure remain separate acceptance work.

## Extended soak procedure

Use a dedicated interactive Windows user session and owned local/staging sites without live ads. Record the exact application SHA/version, OS build, CPU, RAM, power policy, proxy type, page workload, and timing configuration. Run the normal QA schedule for 24 hours with 20 selected profiles, preserving representative failures and memory samples at regular intervals.

Verify that memory reaches a stable range after warmup, the UI remains responsive, no orphaned renderers accumulate, website storage survives a graceful restart, profile state stays isolated, failed proxies never produce direct requests, rate-limit responses stop work, and Windows suspend/resume does not create unexpected traffic. Analyze both successful and cancelled jobs and attach raw evidence.

The 24-hour soak has not been completed for 1.0.0-rc.1. No long-duration stability guarantee is made.
