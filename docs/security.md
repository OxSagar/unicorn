# Security model and limitations

Unicorn is an authorized browser quality-assurance tool. A loaded website, its scripts, a public proxy and a proxy-provider record are all treated as untrusted input. The application does not implement CAPTCHA bypass, anti-bot evasion, advertising clicks, credential theft or proxy rotation in response to a website's access restrictions.

## Website and desktop isolation

Remote pages run in real Chromium renderers with JavaScript enabled and Node integration disabled. Context isolation, renderer sandboxing and web security stay enabled. They receive no privileged preload, cannot select arbitrary IPC channels and cannot launch external applications through a page link. `file:`, `javascript:`, custom protocol and other unsafe navigation targets are rejected. Embedded webviews and unexpected native window creation are disabled.

The React dashboard loads bundled local content with a content security policy. Privileged commands are accepted only from that window's main frame, validated against known command forms and then checked again at the point where a URL or browser is used. Remote browser IDs are integers from 1 through 20. Filesystem exports use user-selected native dialogs. The only external application URL launch is the fixed project release page.

All website permission checks and requests are denied, including microphone, camera, screen capture, geolocation, notifications, USB, serial and Bluetooth access. Website dialogs are rate-limited by Electron's safe-dialogs setting. Public proxy sessions should not be used with sensitive passwords, payment details, financial services or valuable logged-in accounts.

## Network controls

Every browser partition starts with its request gate closed. No website navigation is permitted until the proxy pool has allocated a validated endpoint. Every assignment uses Chromium's fixed-server proxy mode with no `DIRECT` fallback and no ordinary bypass list. The `<-loopback>` rule removes Chromium's usual implicit direct connection to localhost, so even local integration fixtures must cross the configured proxy.

When a session stops, completes QA or loses its proxy, the gate blocks further requests before the fixed proxy is replaced with a loopback discard endpoint. Existing connections are closed. The gate remains installed after a browser view closes, preventing retained service workers from starting background requests. Profile storage is kept; closing a session does not silently remove registrations or cookies.

Native Chromium network calls cannot always be cancelled after dispatch. If a proxy mutation or connection-close operation remains unsettled when its deadline or cancellation fires, that Session is permanently disabled for the rest of the application process. Reopening the same profile does not clear this condition; restart Unicorn before using it again. A late native completion therefore cannot change the route underneath a newly enabled browser. Cleanup still attempts to close connections, stops views and releases the proxy lease, while reporting cleanup failures.

Proxy endpoints must be numeric IP addresses. Chromium host-resolver rules prevent destination hostname resolution outside the proxy, and QUIC/WebTransport are disabled. Every parent and child webContents uses the `disable_non_proxied_udp` WebRTC IP policy. These controls constrain browser networking; the application does not install an operating-system firewall or claim to be a VPN. Packet-level verification on the target Windows environment remains necessary before claiming comprehensive DNS, WebRTC and other protocol leak prevention. Features that depend on unrestricted peer-to-peer UDP will not behave like an unrestricted Chrome installation.

The ProxyScrape provider fetch is a deliberate Node control-plane connection and may use the machine's normal network route. It retrieves public proxy metadata and carries no website cookies. It is not a fallback path for a managed browser's page requests. The external release-page button similarly opens the user's normal system browser by explicit action.

## Proxy validation and allocation

The public provider is ProxyScrape. Automatic candidates are filtered to US, GB, CA, FR, DE, JP and IT. SOCKS4 is excluded because this implementation does not verify its DNS/privacy behavior. HTTP, HTTPS-to-proxy and SOCKS5 records are represented, but each candidate must pass the actual Chromium HTTPS request before use. Provider `ssl` support is not mislabeled as an HTTPS-encrypted connection to the proxy itself.

Validation uses `https://ipwho.is/` through the candidate. The TLS certificate chain is checked normally. A valid observed public exit IP and a matching allowed country are required. Unknown-country, wrong-country, invalid-address and malformed responses fail closed. A bounded pool of four in-memory sessions limits validator resources. Healthy sessions are cleaned and returned to the pool after each attempt. A native proxy mutation or cleanup that remains unsettled retires that slot for the process lifetime, preventing late work from changing a reused validation route. Exhausting all four slots requires an application restart; ordinary abort-aware request timeouts can reuse a cleaned slot.

The allocator reserves endpoints synchronously before awaiting validation, preventing two active browsers from racing for one endpoint. Duplicate observed exit IPs are also rejected when uniqueness is enabled. Failed candidates are quarantined. A stop invalidates a pending lease, so a late validation response cannot revive a cancelled run. Validation establishes a recent observation, not a guarantee that a public proxy will stay available or keep the same route indefinitely.

Recognized Chromium connection failures may trigger a bounded retry with a new eligible proxy. HTTP 401, 403 and 429 instead stop the test. Certificate errors, TLS policy failures, application deadlines and unrecognized errors do not trigger proxy rotation. TLS verification is never disabled to make a failing proxy pass. Public proxy coverage and availability are outside Unicorn's control; a waiting state is a valid outcome.

## Scope and rate controls

Domains must be explicitly approved. Exact-host matching is the default; `*.example.com` is a deliberate subdomain scope and does not implicitly approve the apex host. Every top-level and child-frame navigation, including redirects and script navigation, is rechecked in the main process. Arbitrary private-network IP literals are rejected; enabled loopback fixtures are the documented exception.

During synthetic QA, the same scope also applies to all HTTP, HTTPS and WebSocket subresource requests. An unapproved advertising script or tracking endpoint is blocked before dispatch. Add required CDN and asset hosts explicitly to the authorized list; omitting them can cause expected page-resource failures. Manual browsing allows ordinary third-party subresources through the assigned proxy. Neither a domain allowlist nor a blocklist can prove that an allowed page or resource uses test advertising rather than a live campaign.

Automated testing requires a staging or test-ad confirmation. It is the operator's responsibility to configure those environments accurately. Code cannot independently determine whether every permitted page carries monetized advertising. DOM link discovery excludes recognizable advertising containers, sponsored/nofollow links and download links. It never clicks advertisement elements. Unmarked advertising and site-specific behavior are a reason to use controlled staging fixtures instead of production ad placements.

Synthetic navigation and periodic stage checks detect rendered reCAPTCHA, hCaptcha and Turnstile widgets, known provider challenge iframes and a narrow set of challenge-page titles. A match immediately closes the session's request gate and stops the job with `Challenge detected; testing requires manual review`; no challenge is clicked, solved or submitted, and the failure cannot enter the proxy retry path. The controller removes the failed target from scheduled recurrence and pauses further work for that browser. These checks recognize explicit known markers, not every possible CAPTCHA or custom access-control page. Hidden widgets and general articles about CAPTCHA are not treated as visible challenges. Manual browsing does not run this synthetic challenge detector.

Separate daily budgets count top-level navigation attempts and the session's HTTP, HTTPS and WebSocket requests before dispatch. The request budget also applies to manual browsing and subresources, including requests from retained service workers. A WebSocket handshake counts as a request; individual frames on an established connection are not separate requests. Budgets persist across application restarts and reset by UTC date. Reaching either limit closes the affected session gate, and restriction metadata preserves the actual destination host even after a redirect or external QA stage. Scheduling requires a minimum one-minute cycle interval and a configured operating window. Per-job retries are bounded. Emergency stop closes the request gate and cancels current task waits.

## Local data and diagnostics

Chromium persists each numbered partition independently under the current user's application data. The application does not implement a master-password vault or promise additional encryption of all website storage. Windows account and filesystem permissions protect local files to the extent provided by the operating system. Do not share another user's Unicorn profile directory.

Activity logs redact URL credentials, query strings and fragments. JavaScript errors are counted without saving raw console content by default. History and queued test URLs still contain the URLs needed to operate the browser; they may include query parameters. Exported job results therefore need review before sharing.

QA screenshots deliberately capture the visible test page. They can contain page information, so only use suitable test data. Screenshots and timing JSON remain local, with a 400-file cap and configurable retention. Diagnostic exports go only to a user-selected file. There is no background upload of screenshots or cookies.

## Test hooks and release constraints

Fixture configuration and the main-process test accessor require both an unpackaged application and an explicit E2E environment flag. A packaged installation does not expose that fixture path. The test mechanism can supply controlled proxies and a local diagnostic endpoint; it must not be confused with verification of public proxy quality or geolocation.

The application has no automatic self-updater in this version. Updates are obtained from the project's release page and installed manually. Do not assume an unsigned executable is signed, and do not disable system protections to suppress an installation warning. Release notes identify signing and verification status.

Security tests and build audits reduce risk but do not prove the absence of all vulnerabilities. Known limitations, unperformed Windows tests, unperformed packet capture and an unperformed 24-hour soak must remain visible in the release report. A source build alone is not a production-readiness assertion.

## Primary references

- [Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron proxy session API](https://www.electronjs.org/docs/latest/api/session)
- [Electron WebRTC IP handling policy](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwebrtciphandlingpolicypolicy)
- [Chromium proxy networking](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)
- [ProxyScrape free proxy API](https://docs.proxyscrape.com/api-reference/public-api/get-proxy-list)
- [IPWho.is API and limits](https://ipwhois.io/documentation)
- [Google reCAPTCHA widget markup](https://developers.google.com/recaptcha/docs/display)
- [hCaptcha widget configuration](https://docs.hcaptcha.com/configuration)
- [Cloudflare Turnstile widget markup](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)
