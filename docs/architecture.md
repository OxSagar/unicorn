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
| `src/main/network/`      | Request gate, fixed-proxy configuration and independent exit-country verification                          | Privileged networking controls                                            |
| `src/main/core/`         | Pure scope, state, distribution, validation, proxy-pool and scheduling logic                               | Independently unit-testable                                               |
| `src/main/qa/`           | Cancellable stage timing, DOM link inspection and gradual scrolling                                        | Main-process orchestration; bounded script execution in an isolated world |

Remote browser views never receive Unicorn's preload script. They have JavaScript enabled, Node integration disabled, context isolation enabled, Chromium sandboxing enabled and normal web security enabled. The local dashboard receives a typed bridge and cannot select arbitrary IPC channels. The main process validates the IPC sender and every command's shape, value bounds and allowed fields.

## Browser and profile model

The manager maintains up to 20 primary browser entries. Each uses its own persistent partition, such as `persist:unicorn-browser-01`. Chromium stores that profile's cookies, cache, LocalStorage, IndexedDB, CacheStorage and service-worker registrations in its partition. Application settings, the latest 200 history records per profile, selected device configurations, job records and navigation budgets are stored separately in `state.json`.

Shrinking the workspace closes excess views but retains their persistent profile data. Reopening a numbered profile reuses its partition. A complete reset requires an explicit profile action. Cache, cookie, permission and history actions are separate. Cookie clearing first moves the old page to `about:blank`, preventing its still-running JavaScript from immediately rewriting the removed cookies. History clearing updates both the saved list and Chromium's current navigation history.

Saved history is an application record. Unicorn does not silently restore and reload an old web page at startup; a proxy and an explicit eligible navigation must come first. Native back/forward entries exist for the current open view. The browser manager validates stored device configurations and falls back to the desktop preset if that small configuration record is invalid.

Native browser views are positioned above the React window using measured panel rectangles. Hiding a panel hides its view without sharing its storage with another browser. Chromium background throttling is disabled for managed views so running QA timers do not silently stop when panels are hidden. This consumes more resources than discarding background tabs; the performance dashboard reports the cost.

## Network lifecycle

Before a browser view is created, its session receives a deny-by-default request handler and a fixed loopback discard proxy. Acquisition reserves a unique candidate before awaiting network validation. The validator uses a bounded pool of four in-memory Chromium sessions; these sessions are reused so repeated validation does not create an unbounded number of session objects.

The default validation request goes through the candidate proxy to `https://ipwho.is/`. The response must succeed over HTTPS and contain a valid exit IP and an allowed country matching the provider's country. TLS certificate errors are not overridden. A 30-second validation freshness window is configured by the controller; ordinary page transport failures still close the network gate.

The normal state sequence is `CREATED → WAITING_FOR_PROXY → VALIDATING_PROXY → READY → NAVIGATING → RUNNING`. QA completion enters `COMPLETED`, closes connections and releases the lease. Pause blocks session requests while retaining the lease. Resume restores that fixed proxy. Stop cancels the current operation, closes child views and connections, releases the lease and enters `STOPPED`.

Fixed-proxy configurations never contain a `DIRECT` alternative. The bypass list subtracts Chromium's implicit loopback bypass using `<-loopback>`. Proxy assignment also checks Chromium's resolved proxy result. Each assignment has a generation number: a stop or newer assignment invalidates an older pending assignment before it can reopen the request gate.

Native mutations have an eight-second caller deadline. If a `setProxy` or `closeAllConnections` call has not actually settled when cancellation or timeout occurs, a Session-keyed registry marks that Session unusable for the remainder of the process. The request gate stays closed and every later assignment fails, including after closing and reopening its persistent profile. This prevents an unabortable late native completion from overwriting the route of another assignment. Restarting Unicorn creates a fresh network service while retaining profile data.

The gate invokes a per-host request-budget check for every enabled HTTP, HTTPS or WebSocket request, followed by the navigation/scope check where applicable. Request and navigation budgets are persisted separately. `SiteRestrictionError` carries the actual restricted hostname within the main process, so redirected destinations and external QA stages stop the appropriate host's queued work. Renderer-facing messages retain the specific HTTP, quota or challenge failure without exposing new privileged APIs.

ProxyScrape retrieval is a separate control-plane request made by Node. It does not run through a numbered browser profile. This allows proxy discovery before any browser proxy exists. Browser website requests, validator requests and provider requests are distinct in the implementation and documentation.

## Authorized QA and scheduling

A job is a URL assigned to a browser. Same-URL, round-robin, balanced and manual distribution create reviewable jobs without navigating immediately. The main process requires approved domains and a staging/test-ad confirmation before automated work begins. HTTPS is the normal navigation scheme; opt-in loopback fixtures may use HTTP.

Synthetic QA applies the domain scope to every HTTP, HTTPS and WebSocket request, including scripts, images, fetch requests and service-worker traffic. Required CDN and asset hosts must therefore be explicitly approved. Manual browsing permits ordinary third-party subresources through its assigned proxy, while frame navigations still require approved destinations. A domain scope does not verify the advertising campaign running on an approved host; staging and test-ad configuration remain necessary.

Each run inspects a landing page, an eligible same-origin link and an explicitly approved external destination. Missing internal/external links are recorded as skipped stages. The default configured waits and scrolling total 200 seconds, excluding navigation and capture. Every stage has cancellation checkpoints. Pausing excludes paused time from configured dwell time, while navigation interrupted by pause restarts after resume.

DOM discovery ignores marked advertising containers, sponsored/nofollow links and downloads. It does not simulate advertisement clicks or solve challenges. HTTP 401, 403 and 429 disable further session requests and stop the job without changing proxies to bypass the response. Only a finite set of recognized Chromium connection failures enters the bounded retry/backoff path; certificate errors, application deadlines and unrecognized failures stop the job.

After every synthetic navigation, `qa/challenge.ts` checks the page in an isolated JavaScript world for rendered reCAPTCHA, hCaptcha and Turnstile widget markers or provider challenge iframes, plus narrowly matched challenge-page titles. The stage runner repeats this check approximately once per second during dwell and scrolling, and before capture. Detection closes the entire session request gate and fails with `Challenge detected; testing requires manual review`. The controller removes failed targets from recurrence and requires manual review before another run. The detector neither clicks a widget nor submits or obtains challenge tokens. Hidden widget containers and general documentation text do not trigger it. This is conservative detection of known markers, not a guarantee that every possible access-control implementation will be recognized.

Remote script evaluation, device commands and screenshots have explicit deadlines. A renderer that freezes its own event loop cannot indefinitely hold a QA task or prevent cancellation. Navigation has its own configured deadline. Screenshots and navigation timing records are written to the diagnostics directory, capped at 400 files and the selected retention period.

The controller serializes work per browser, respects the configured operating window for repeated cycles, limits pending work and monitors memory before starting additional jobs. Daily limits count top-level navigation attempts, including unsuccessful attempts; they are not a byte limit or a limit on every image, script or XHR. Budgets use UTC calendar days.

## Popups, permissions and devices

Permitted `window.open` requests create managed child `WebContentsView` objects associated with the source browser. They share that browser's persistent partition, network gate and proxy. The limit is eight open children per primary browser. The dashboard can inspect or close each child. Closing the parent destroys its children.

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
- [IPWho.is diagnostic API](https://ipwhois.io/documentation)

## Heartbeat and renderer watchdog

The existing two-second controller poll records a monotonic heartbeat count and current/peak sampling delay. Logs record a heartbeat at most once per minute. Every ten seconds, eligible loaded, active, unpaused views may receive one isolated-world constant-expression probe with a five-second deadline. Probes coalesce per view and are cancelled on lifecycle changes. Two consecutive misses stop that profile and close its network gate for manual review; a missed probe is never classified as a confirmed renderer crash. This is an in-process renderer watchdog, so a completely frozen main process still requires an external supervisor or user intervention.
