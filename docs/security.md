# Security model and limitations

Unicorn is an authorized browser quality-assurance tool. A loaded website, its scripts, a public proxy and a proxy-provider record are all treated as untrusted input. The application does not implement CAPTCHA bypass, anti-bot evasion, advertising clicks, credential theft or proxy rotation in response to a website's access restrictions.

## Website and desktop isolation

Remote pages run in real Chromium renderers with JavaScript enabled and Node integration disabled. Context isolation, renderer sandboxing and web security stay enabled. They receive no privileged preload, cannot select arbitrary IPC channels and cannot launch external applications through a page link. `file:`, `javascript:`, custom protocol and other unsafe navigation targets are rejected. Embedded webviews and unexpected native window creation are disabled.

The React dashboard loads bundled local content with a content security policy. Privileged commands are accepted only from that window's main frame, validated against known command forms and then checked again at the point where a URL or browser is used. Remote browser IDs are integers from 1 through 20. Filesystem exports use user-selected native dialogs. The only external application URL launch is the fixed project release page.

All website permission checks and requests are denied, including microphone, camera, screen capture, geolocation, notifications, USB, serial and Bluetooth access. Website dialogs are rate-limited by Electron's safe-dialogs setting. Public proxy sessions should not be used with sensitive passwords, payment details, financial services or valuable logged-in accounts.

## Network controls

Every browser partition starts with its request gate closed. No website navigation is permitted until the proxy pool has allocated an eligible API-listed endpoint and configured its fixed route. Every assignment uses Chromium's fixed-server proxy mode with no `DIRECT` fallback and no ordinary bypass list. The `<-loopback>` rule removes Chromium's usual implicit direct connection to localhost, so even local integration fixtures must cross the configured proxy.

When a session stops, completes QA or loses its proxy, the gate blocks further requests before the fixed proxy is replaced with a loopback discard endpoint. Existing connections are closed. The gate remains installed after a browser view closes, preventing retained service workers from starting background requests. Profile storage is kept; closing a session does not silently remove registrations or cookies.

Native Chromium network calls cannot always be cancelled after dispatch. If a proxy mutation or connection-close operation remains unsettled when its deadline or cancellation fires, that Session is permanently disabled for the rest of the application process. Reopening the same profile does not clear this condition; restart Unicorn before using it again. A late native completion therefore cannot change the route underneath a newly enabled browser. Cleanup still attempts to close connections, stops views and releases the proxy lease, while reporting cleanup failures.

Proxy endpoints must be numeric IP addresses. Chromium host-resolver rules prevent destination hostname resolution outside the proxy, and QUIC/WebTransport are disabled. Every parent and child webContents uses the `disable_non_proxied_udp` WebRTC IP policy. These controls constrain browser networking; the application does not install an operating-system firewall or claim to be a VPN. Packet-level verification on the target Windows environment remains necessary before claiming comprehensive DNS, WebRTC and other protocol leak prevention. Features that depend on unrestricted peer-to-peer UDP will not behave like an unrestricted Chrome installation.

The ProxyScrape provider fetch is a deliberate Node control-plane connection and may use the machine's normal network route. It retrieves public proxy metadata and carries no website cookies. It is not a fallback path for a managed browser's page requests. The external release-page button similarly opens the user's normal system browser by explicit action.

## Direct proxy assignment

The public provider is ProxyScrape. API country metadata is filtered to US, GB, CA, FR, DE, JP, IT and AT (Austria), alongside numeric-public-IP, port and supported-transport checks. The application assigns these endpoints directly. It performs no diagnostic network request, exit-IP lookup, independent geography check or measured-latency test. API metadata can be stale or incorrect, and an assigned endpoint can fail on its first real page request.

The pool reserves endpoints synchronously, preventing two active browsers from racing for the same IP/port. Different endpoints may share an observed public exit; exit-IP uniqueness is no longer checked or advertised. Release/cancellation invalidates undelivered assignments, and provider refresh preserves active leases.

Browser assignment still configures Chromium's fixed-server route with no DIRECT fallback, waits for native proxy-state reload, and requires the selected route to match the assigned protocol, IP and port exactly before opening the gate. Those local routing checks do not contact a diagnostic service. HTTPS destination certificates continue to be checked normally. Removing proxy preflight does not disable TLS verification.

Recognized failures during actual browser connections release and temporarily quarantine the endpoint. QA retries remain bounded. HTTP 401, 403 and 429, challenges, certificate failures, application deadlines and unrecognized errors stop the relevant work rather than triggering rotation around restrictions. Public proxy coverage and availability remain outside Unicorn's control.

## Scope and rate controls

Domains must be explicitly approved. In the minimal workflow, Distribute displays exact hosts from the prepared links and Start is the explicit authorization action for that batch. The review binds the chosen browser count/device and exact jobs; changing inputs requires another Distribute. There is no wildcard expansion, persistent authorization change or automatic approval after restart. Legacy stored wildcard scopes remain supported by internal APIs but do not broaden a simple run. Every top-level and child-frame navigation, including redirects and script navigation, is rechecked in the main process. Arbitrary private-network IP literals are rejected; enabled loopback fixtures are the documented exception.

During synthetic QA, the same scope also applies to all HTTP, HTTPS and WebSocket subresource requests. An unapproved advertising script or tracking endpoint is blocked before dispatch. Only the exact hosts in the prepared batch are permitted, so unrelated CDN and asset requests can fail. The retained internal manual-navigation API allows ordinary third-party subresources through the assigned proxy. Neither a domain allowlist nor a blocklist can prove that an allowed page or resource uses test advertising rather than a live campaign.

Automated testing requires a staging or test-ad confirmation. The visible Start explanation and deliberate Start action provide that confirmation without a separate settings page or extra confirmation dialog. It is the operator's responsibility to choose suitable environments accurately. Code cannot independently determine whether every permitted page carries monetized advertising. DOM link discovery excludes recognizable advertising containers, sponsored/nofollow links and download links. It never clicks advertisement elements. Unmarked advertising and site-specific behavior are a reason to use controlled staging fixtures instead of production ad placements.

Synthetic navigation and periodic stage checks detect rendered reCAPTCHA, hCaptcha and Turnstile widgets, known provider challenge iframes and a narrow set of challenge-page titles. A match immediately closes the session's request gate and stops the job with `Challenge detected; testing requires manual review`; no challenge is clicked, solved or submitted, and the failure cannot enter the proxy retry path. The controller cancels that browser's remaining reviewed jobs and requires a new review. Legacy scheduled runs remove the failed target from active recurrence; simple batches preserve unrelated saved work and inactive templates. These checks recognize explicit known markers, not every possible CAPTCHA or custom access-control page. Hidden widgets and general articles about CAPTCHA are not treated as visible challenges. Manual browsing does not run this synthetic challenge detector.

Separate daily budgets count top-level navigation attempts and the session's HTTP, HTTPS and WebSocket requests before dispatch. The request budget also applies to manual browsing and subresources, including requests from retained service workers. A WebSocket handshake counts as a request; individual frames on an established connection are not separate requests. Budgets persist across application restarts and reset by UTC date. Reaching either limit closes the affected session gate, and restriction metadata preserves the actual destination host even after a redirect or external QA stage. The simple workflow runs once and does not arm saved recurrence, including on restart. Internal legacy scheduling still requires a minimum one-minute interval and an operating window when explicitly used. Per-job retries are bounded. Emergency stop closes the request gate and cancels current task waits.

## Local data and diagnostics

Chromium persists each numbered partition independently under the current user's application data. The application does not implement a master-password vault or promise additional encryption of all website storage. Windows account and filesystem permissions protect local files to the extent provided by the operating system. Do not share another user's Unicorn profile directory.

Activity logs redact URL credentials, query strings and fragments. JavaScript errors are counted without saving raw console content by default. History and queued test URLs still contain the URLs needed to operate the browser; they may include query parameters. Exported job results therefore need review before sharing.

QA screenshots deliberately capture the visible test page. They can contain page information, so only use suitable test data. Screenshots and timing JSON remain local, with a 400-file cap and configurable retention. Diagnostic exports go only to a user-selected file. There is no background upload of screenshots or cookies.

## Test hooks and release constraints

Fixture configuration and the main-process test accessor require both an unpackaged application and an explicit E2E environment flag. A packaged installation does not expose that fixture path. The test mechanism can supply controlled proxies and short stage timings. Those timing overrides remain unavailable to packaged users; simple production runs use the defined defaults. Tests record that browser assignment performs no diagnostic requests; fixtures must not be confused with evidence of public proxy quality or geolocation.

The application has no automatic self-updater in this version. Updates are obtained from the project's release page and installed manually. Do not assume an unsigned executable is signed, and do not disable system protections to suppress an installation warning. Release notes identify signing and verification status.

Security tests and build audits reduce risk but do not prove the absence of all vulnerabilities. Known limitations, unperformed Windows tests, unperformed packet capture and an unperformed 24-hour soak must remain visible in the release report. A source build alone is not a production-readiness assertion.

## Primary references

- [Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron proxy session API](https://www.electronjs.org/docs/latest/api/session)
- [Electron WebRTC IP handling policy](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwebrtciphandlingpolicypolicy)
- [Chromium proxy networking](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)
- [ProxyScrape free proxy API](https://docs.proxyscrape.com/api-reference/public-api/get-proxy-list)
- [Google reCAPTCHA widget markup](https://developers.google.com/recaptcha/docs/display)
- [hCaptcha widget configuration](https://docs.hcaptcha.com/configuration)
- [Cloudflare Turnstile widget markup](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)
