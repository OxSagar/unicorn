# Unicorn architecture

Unicorn is an Electron desktop application. It embeds the Chromium version bundled with its pinned Electron runtime; it does not embed or control an independently installed Google Chrome executable. The packaged application uses one Electron main process and Chromium's normal renderer, GPU and network processes.

## Process and trust boundaries

| Component                | Responsibility                                                                                             | Trust level                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/main/index.ts`      | Windows application, single-instance lock, tray, power events, IPC sender validation and shutdown          | Privileged application code                                               |
| `src/main/controller.ts` | Settings, job scheduling, proxy-provider refresh, budgets, performance samples and command dispatch        | Privileged application code                                               |
| `src/preload/index.ts`   | Three narrow bridge operations: command invocation, snapshot subscription and view geometry                | Trusted local dashboard only                                              |
| `src/renderer/`          | React controls, queue and profile inspection, settings, logs and embedded-view layout                      | Sandboxed local UI                                                        |
| `src/main/browser/`      | Native `WebContentsView` creation, lifecycle, persistent profiles, device settings, popups and diagnostics | Privileged coordinator of untrusted content                               |
| `src/main/network/`      | Request gate, fixed-proxy configuration and transport/restriction classification                           | Privileged networking controls                                            |
| `src/main/core/`         | Pure scope, state, distribution, validation, proxy-pool and scheduling logic                               | Independently unit-testable                                               |
| `src/main/qa/`           | Cancellable stage timing, DOM link inspection and gradual scrolling                                        | Main-process orchestration; bounded script execution in an isolated world |

Remote browser views never receive Unicorn's preload script. They have JavaScript enabled, Node integration disabled, context isolation enabled, Chromium sandboxing enabled and normal web security enabled. The local dashboard receives a typed bridge and cannot select arbitrary IPC channels. The main process validates the IPC sender and every command's shape, value bounds and allowed fields.

## Browser and profile model

The manager maintains up to 20 primary browser entries. Each uses its own persistent partition, such as `persist:unicorn-browser-01`. Chromium stores that profile's cookies, cache, LocalStorage, IndexedDB, CacheStorage and service-worker registrations in its partition. Application settings, the latest 200 history records per profile, selected device configurations, job records and navigation budgets are stored separately in `state.json`.

Shrinking the workspace closes excess views but retains their persistent profile data. Reopening a numbered profile reuses its partition. A complete reset requires an explicit profile action. Cache, cookie, permission and history actions are separate. Cookie clearing first moves the old page to `about:blank`, preventing its still-running JavaScript from immediately rewriting the removed cookies. History clearing updates both the saved list and Chromium's current navigation history.

Saved history is an application record. Unicorn does not silently restore and reload an old web page at startup; a proxy and an explicit eligible navigation must come first. Native back/forward entries exist for the current open view. The browser manager validates stored device configurations and falls back to the desktop preset if that small configuration record is invalid.

Native browser views are positioned above the React window using measured panel rectangles. Hiding a panel hides its view without sharing its storage with another browser. Chromium background throttling is disabled for managed views so running QA timers do not silently stop when panels are hidden. This consumes more resources than discarding background tabs; performance and heartbeat samples remain available internally.

## Network lifecycle

Before a browser view is created, its session receives a deny-by-default request handler and a fixed loopback discard proxy. The pool reserves a unique eligible API endpoint synchronously and delivers it through a cancellation-aware Promise API. There is no proxy validator, diagnostic request, measured latency, observed exit IP, or independent exit-country check.

Country labels come from ProxyScrape and include US, GB, CA, FR, DE, JP, IT and AT. Endpoint syntax/public-address checks and duplicate IP/port exclusion remain local prerequisites. A real browser connection establishes whether an assigned endpoint works; recognized transport failures release and quarantine it within the bounded retry policy.

The normal state sequence is `CREATED → WAITING_FOR_PROXY → ASSIGNING_PROXY → READY → NAVIGATING → RUNNING`. QA completion enters `COMPLETED`, closes connections and releases the lease. Pause blocks session requests while retaining the lease. Resume restores that fixed proxy. Stop cancels the current operation, closes child views and connections, releases the lease and enters `STOPPED`.

Fixed-proxy configurations never contain a `DIRECT` alternative. The bypass list subtracts Chromium's implicit loopback bypass using `<-loopback>`. After setting the proxy, assignment waits for a bounded native proxy-state reload and requires Chromium's resolved proxy result to match the assigned protocol, IP and port exactly. Each assignment has a generation number: a stop or newer assignment invalidates an older pending assignment before it can reopen the request gate.

Native mutations have an eight-second caller deadline. If a `setProxy`, `forceReloadProxyConfig` or `closeAllConnections` call has not actually settled when cancellation or timeout occurs, a Session-keyed registry marks that Session unusable for the remainder of the process. The request gate stays closed and every later assignment fails, including after closing and reopening its persistent profile. This prevents an unabortable late native completion from overwriting the route of another assignment. Restarting Unicorn creates a fresh network service while retaining profile data.

The gate invokes a per-host request-budget check for every enabled HTTP, HTTPS or WebSocket request, followed by the navigation/scope check where applicable. Request and navigation budgets are persisted separately. `SiteRestrictionError` carries the actual restricted hostname within the main process, so redirected destinations and external QA stages stop the appropriate host's queued work. Renderer-facing messages retain the specific HTTP, quota or challenge failure without exposing new privileged APIs.

ProxyScrape retrieval is a separate control-plane request made by Node. It does not run through a numbered browser profile. This allows proxy discovery before any browser proxy exists. Browser website requests and provider-list requests remain separate. There is no exit-diagnostic service dependency.

## Simple interface

One screen provides browser count, Desktop/Mobile/Tablet choice, pasted links, Distribute and Start. There is no sidebar, Apply step, Settings page, manual-assignment editor or proxy configuration. Live previews, run status, errors, Stop and optional preview expansion remain. The renderer clips every native view to the shared scrolling workspace so embedded pages cannot cover the input controls.

The main process prepares a batch from the normalized unique URLs, selected count and device. One URL is used by every requested browser. Multiple URLs cycle across the selected profiles, and excess URLs queue in order. The review records its own immutable job IDs, URLs, browser IDs and exact website hosts. Distribute never navigates. Any input change requires redistribution; Start accepts the reviewed identity and explicit authorization, applies the actual Chromium device preset, and starts only those jobs.

Existing profiles are grown as needed rather than deleted for a smaller batch. Unrelated saved jobs are retained but do not join a prepared run. Stop invalidates preparation/start generations before asynchronous cleanup so a late reply cannot restart cancelled work.

Existing rc.1 saved settings are migrated by dropping only the obsolete proxy-validation timeout and exit-uniqueness fields before strict settings validation. Profiles, jobs, budgets and other preferences are restored normally. IPC commands still reject unknown fields and the removed reserve-validation command.

## Authorized QA and scheduling

A job is a URL assigned to a browser. The ordinary interface automatically distributes links across the chosen profiles. The legacy same-URL, round-robin, balanced and manual APIs remain internal compatibility capabilities, without additional user-facing controls. HTTPS is the normal navigation scheme; opt-in loopback fixtures remain available to the controlled test harness.

Start is the deliberate staging/test-ad authorization action for the exact hosts shown in a prepared batch. Per-profile transient settings supply that batch's scope and fixed default timings/retries, with stricter saved budgets/resource bounds and exclusions retained. The settings callback and request/navigation budget callbacks receive the owning browser ID, including for child views and redirected requests. Unrelated profiles retain their original settings. Temporary authority is never written to the settings allowlist or restored after a restart, and it is removed only after the participating native operations have closed their request gates.

Synthetic QA applies the domain scope to every HTTP, HTTPS and WebSocket request, including scripts, images, fetch requests and service-worker traffic. The simple workflow approves only the exact hosts in its displayed batch; unrelated CDN and asset requests remain blocked. The retained internal manual-navigation API permits ordinary third-party subresources through its assigned proxy, while frame navigations still require approved destinations. A domain scope does not verify the advertising campaign running on an approved host; staging and test-ad configuration remain necessary.

Each run inspects a landing page, an eligible same-origin link and an explicitly approved external destination. Missing internal/external links are recorded as skipped stages. The default configured waits and scrolling total 200 seconds, excluding navigation and capture. Every stage has cancellation checkpoints. Pausing excludes paused time from configured dwell time, while navigation interrupted by pause restarts after resume.

DOM discovery ignores marked advertising containers, sponsored/nofollow links and downloads. It does not simulate advertisement clicks or solve challenges. HTTP 401, 403 and 429 disable further session requests and stop the job without changing proxies to bypass the response. Only a finite set of recognized Chromium connection failures enters the bounded retry/backoff path; certificate errors, application deadlines and unrecognized failures stop the job.

After every synthetic navigation, `qa/challenge.ts` checks the page in an isolated JavaScript world for rendered reCAPTCHA, hCaptcha and Turnstile widget markers or provider challenge iframes, plus narrowly matched challenge-page titles. The stage runner repeats this check approximately once per second during dwell and scrolling, and before capture. Detection closes the entire session request gate and fails with `Challenge detected; testing requires manual review`. The controller cancels that profile's remaining reviewed jobs and requires a new review before another run; legacy scheduled runs also remove the failed target from active recurrence. The detector neither clicks a widget nor submits or obtains challenge tokens. Hidden widget containers and general documentation text do not trigger it. This is conservative detection of known markers, not a guarantee that every possible access-control implementation will be recognized.

Remote script evaluation, device commands and screenshots have explicit deadlines. A renderer that freezes its own event loop cannot indefinitely hold a QA task or prevent cancellation. Navigation has its own configured deadline. Screenshots and navigation timing records are written to the diagnostics directory, capped at 400 files and the selected retention period.

The controller serializes work per browser, limits pending work and monitors memory before starting additional jobs. The simple workflow runs its accepted batch once and never arms recurrence. Saved recurrence settings are retained, but application startup does not arm them. The internal legacy scheduler still respects its configured operating window when explicitly invoked; its tests do not imply repeating controls in the ordinary interface. Daily limits count top-level navigation attempts, including unsuccessful attempts; they are not a byte limit or a limit on every image, script or XHR. Budgets use UTC calendar days.

On entering the simple workflow, unrelated pending work from the older interface is retained in a separate inert backlog, bounded to 1,000 jobs. It cannot consume the new batch's 1,000-job execution capacity or receive that batch's approval. The executable queue retains at most 1,000 pending/running jobs plus 500 terminal records. Stored identifiers mark jobs created by the simple workflow so a later Distribute can replace its own unstarted assignments after a restart; these identifiers carry no authorization and do not restore a reviewed batch.

## Popups, permissions and devices

Permitted `window.open` requests create managed child `WebContentsView` objects associated with the source browser. They share that browser's persistent partition, network gate and proxy. The limit is eight open children per primary browser. The internal manager can inspect or close each child; those controls are not exposed in the minimal interface. Closing the parent destroys its children.

All website permission requests are denied in this version. This deliberately includes media devices, geolocation, notifications and device access; an interactive per-site grant editor is not implemented. Ordinary HTML forms, JavaScript, cookies, storage and downloads remain supported. Manual downloads require a Save dialog; automated QA does not download files.

Device emulation uses Chromium's DevTools protocol for user agent and client hints, viewport and screen size, pixel ratio, touch support and orientation. The test user agent includes `UnicornQA/1.0`. Android/Windows characteristics identify the selected testing preset; they are not a claim to be real hardware. Changing a preset keeps the browser's stored website data. Inspecting DevTools may detach the protocol session; applying a device preset reconnects it and closes DevTools first.

## Persistence and recovery

Application state writes are serialized and replace a same-directory temporary file atomically. Corrupt state is preserved under a dated name and safe defaults are loaded. Chromium storage is flushed during operation completion, profile actions and shutdown. A renderer crash blocks and releases its network lease while retaining the profile. An accepted active QA job can restart from its original approved URL after a typed native crashed/killed/abnormal-exit event, under the configured retry limit and a separate maximum of three repairs per profile in a rolling ten-minute window. A lifetime cancellation signal spans attempts, while individual renderers have separate attempt cancellation. Repair replaces only the view, keeping the same persistent Session, request gate, device and job identity. Pause suspends backoff; Stop, replacement, close, access restrictions and a poisoned Session prevent a late restart. Manual browsing, memory exhaustion, integrity/launch failures and arbitrary page errors do not trigger automatic replay.

No backend service is required. The optional Windows login and tray integration operates in the user's interactive desktop session. Logging out terminates that environment; Unicorn does not claim to provide interactive Chromium rendering inside Windows Session 0.

## Scope of verification

Pure logic and network-gate tests exercise failure paths, cancellation, allocation races and request restrictions. Electron end-to-end tests use controlled pages and deterministic proxies. Build success and unit-test success alone do not certify Windows rendering, public-proxy availability, absence of every possible networking leak or 24-hour stability. The release report and CI artifacts record which of those checks actually ran.

## Primary references

- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Electron session and proxy configuration](https://www.electronjs.org/docs/latest/api/session)
- [Electron webContents and device emulation](https://www.electronjs.org/docs/latest/api/web-contents)
- [Electron navigation history](https://www.electronjs.org/docs/latest/api/navigation-history)
- [ProxyScrape public API](https://docs.proxyscrape.com/api-reference/public-api/get-proxy-list)

## Heartbeat and renderer watchdog

The existing two-second controller poll records a monotonic heartbeat count and current/peak sampling delay. Logs record a heartbeat at most once per minute. Every ten seconds, eligible loaded, active, unpaused views may receive one isolated-world constant-expression probe with a five-second deadline. Probes coalesce per view and are cancelled on lifecycle changes. Two consecutive misses stop that profile and close its network gate for manual review; a missed probe is never classified as a confirmed renderer crash. This is an in-process renderer watchdog, so a completely frozen main process still requires an external supervisor or user intervention.
