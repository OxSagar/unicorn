# Performance and reliability

## Implemented controls

Unicorn shares one Electron runtime and creates separate persistent Chromium sessions and renderer views. The renderer UI subscribes to coalesced snapshots. Browser views are reused, remote JavaScript stays enabled, background throttling is disabled for accurate timed QA, lists are bounded/paginated, and screenshot capture is limited to stage boundaries.

The application samples actual Electron process CPU and working-set memory every two seconds. CPU is the sum of Electron's process CPU percentages; the measurement is not a page-view metric. Memory is the summed process working set, so shared operating-system pages can be counted more than once. The resource screen also shows system free/total memory and process count. Every sample increments a heartbeat counter and measures the monotonic delay beyond the two-second polling interval; current/peak delay and the last heartbeat time are visible. A bounded heartbeat log is written once per minute. A sampling gap includes main-process stalls and system suspension; this telemetry does not replace an external process supervisor.

Balanced assignment scores each selected profile using pending/running job count plus its current renderer CPU percentage divided by 25 and working-set MB divided by 512. This documented heuristic defers assignment toward less busy renderers; it does not migrate existing jobs or predict arbitrary page cost.

New QA jobs wait when the configured memory budget is exceeded. Existing browser profiles remain intact. Proxy validation uses at most four parallel Chromium validation sessions. Each browser has bounded retries and finite navigation/operation timeouts. Captures, histories, queues, and logs have retention/size limits.

## Reference hardware guidance

For a large grid, begin with Windows 11 x64, a modern 8-core CPU, 16 GB RAM or more, and an SSD. Page complexity, JavaScript, video, proxy latency, and device pixel ratio dominate actual resource use. A 20-profile support limit is not a claim that every computer can render 20 heavy websites without lag.

GitHub-hosted Windows runners are a verification environment; their available CPU/RAM vary and are not a substitute for a consumer-device benchmark. Concurrency tests attach real resource samples and response latency so the exact test run can be assessed.

## Short-run evidence

Native tests create and navigate 1, 5, 10, 15, and 20 browsers on controlled fixtures, exercise all selectable counts, measure snapshot responsiveness, and clean up child processes. These results must be read from the associated CI artifact. No baseline CPU/RAM numbers are asserted here before they have been measured.

## Extended soak procedure

Use a dedicated interactive Windows user session and owned local/staging sites without live ads. Record the exact application SHA/version, OS build, CPU, RAM, power policy, proxy type, page workload, and timing configuration. Run the normal QA schedule for 24 hours with 20 selected profiles, preserving representative failures and memory samples at regular intervals.

Verify that memory reaches a stable range after warmup, the UI remains responsive, no orphaned renderers accumulate, website storage survives a graceful restart, profile state stays isolated, failed proxies never produce direct requests, rate-limit responses stop work, and Windows suspend/resume does not create unexpected traffic. Analyze both successful and cancelled jobs and attach raw evidence.

The 24-hour soak has not been completed for 1.0.0-rc.1. No long-duration stability guarantee is made.
