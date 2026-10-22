# Unicorn

A simple Windows workspace for **1–20 isolated Chromium browser sessions**, device presets, direct API proxy assignment, and authorized website quality assurance.

Unicorn embeds real Electron `WebContentsView` browser engines. Each profile keeps its own cookies, cache, local storage, IndexedDB, and service workers between application launches. It does not embed the branded Google Chrome executable.

## Download and release status

Get verified packages from [GitHub Releases](https://github.com/OxSagar/unicorn/releases). The current version is **1.0.0-rc.2**. A release candidate is intended for evaluation; it is not a production-readiness claim. Check [Actions](https://github.com/OxSagar/unicorn/actions) for the exact release's Windows verification and [release notes](docs/release-notes.md) for changes and acceptance limits.

Windows release assets include an NSIS installer, a portable ZIP, and `SHA256SUMS.txt`. Release automation requires unit checks, real Electron tests on Windows, package construction, packaged application launch, and installed application launch before publishing. Unsigned builds may trigger Windows warnings. No signing certificate is bundled or invented.

Version rc.2 removes proxy preflight validation and simplifies the interface to **Browsers, Links, Proxies, and Settings**. Proxy country labels come directly from the API. The release workflow tests the new behavior, all selectable browser counts, 20 concurrent profiles, scheduling, profile persistence, renderer recovery, and actual portable/installed application launch. The [recorded rc.1 measurements](docs/verification.md) remain historical evidence for that earlier version; current results belong to the matching release workflow.

## What it does

- Displays a responsive grid of independent, persistent Chromium sessions with address bars, navigation controls, expanded inspection, and individual or global run controls.
- Offers desktop, mobile, and tablet presets using Chromium's viewport, pixel ratio, touch, orientation, user agent, and client-hint controls.
- Fetches ProxyScrape public proxies from **US, GB, CA, FR, DE, JP, IT, and AT (Austria)** and assigns eligible API-listed endpoints directly. There is no diagnostic request, exit-IP lookup, latency probe, or separate validation queue.
- Reserves unique proxy endpoints atomically. Different endpoints can share an exit IP; API country labels are not independently verified.
- Blocks page networking before proxy assignment and after pause, stop, or failure. Proxy configuration contains no direct fallback and removes the implicit loopback bypass.
- Imports TXT/CSV URLs and distributes them using same-URL, round-robin, balanced, or manual assignment, with editable queue review before starting.
- Runs bounded landing-page, internal-link, and approved external-link QA stages with asynchronous waits, scrolling, console/resource diagnostics, screenshots, and cancellation.
- Supports schedules, daily navigation/request quotas, emergency stop, local logs/results export, performance/heartbeat measurements, tray controls, and optional start at login.
- Repairs eligible renderer crashes during an accepted QA job under bounded retry and per-profile limits; detects stalled renderers and preserves profile data.

## First run

1. Install or extract the application, then open Unicorn.
2. In **Settings**, enter your hosts in **Approved domains**, including required authorized CDN/resource hosts.
3. Select **I am authorized to test these websites**, then **Save settings**. Use staging or test-ad pages; automated tests must not generate production advertising engagement.
4. Open **Proxies** and refresh the API list if needed. A profile waits when no eligible, unassigned endpoint is available.
5. Select a browser count and a device preset. In **Links**, assign URLs and review the queue.
6. Start the run. Use Pause, Stop, or `Ctrl+Shift+S` to interrupt activity.

See the complete [user guide](docs/user-guide.md).

## Requirements and limits

Windows 10/11 x64 is the intended target. Recommended starting hardware is an SSD, a modern 8-core CPU, and 16 GB RAM; this is guidance, not a measured guarantee for arbitrary websites. The app defers new QA jobs when its configured memory budget is exceeded. Interactive browsing needs an active Windows user session.

Free public proxies may be unavailable, slow, misclassified, or hostile. No number of working proxies or country coverage is guaranteed. Do not enter sensitive credentials through them. HTTP CONNECT and SOCKS5 are automatic provider transports; SOCKS4 is intentionally excluded. HTTPS browsing retains certificate validation.

Application-level network safeguards are not an operating-system firewall or a complete traffic-capture audit. UDP/WebRTC and DNS controls have compatibility implications described in [security](docs/security.md). Sites may reject synthetic traffic, require unsupported browser features, or behave differently from branded Chrome. HTTP 401/403/429 responses stop testing instead of triggering proxy rotation.

The 24-hour soak test, Windows 10/11 consumer-device matrix, and independent packet-level leak audit remain separate acceptance work. Do not infer their completion from a successful build. See [testing](docs/testing.md) and [performance](docs/performance.md).

## Develop

Use Node.js 24 and npm with the committed lockfile:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

`npm run dev` rebuilds and starts Electron. `npm run package:win` creates Windows packages; run it on Windows for release verification. `npm run test:e2e` uses controlled local proxy/web fixtures and never visits public advertising destinations. Trusted HTTPS fixtures need the setup in [testing](docs/testing.md).

Application source is TypeScript; the UI is React/Vite. Settings, queue state, budgets, and profile metadata use a serialized atomic JSON store. Chromium owns each profile's actual website databases.

## Documentation

- [Architecture](docs/architecture.md)
- [Security and network boundaries](docs/security.md)
- [Proxy provider contract](docs/proxy-contract.md)
- [Testing and evidence](docs/testing.md)
- [Windows verification record and measurements](docs/verification.md)
- [Requirement acceptance matrix](docs/acceptance.md)
- [Dependency audit assessment](docs/dependency-audit.md)
- [Performance and soak testing](docs/performance.md)
- [User guide](docs/user-guide.md)
- [Release notes](docs/release-notes.md)
- [Changelog](CHANGELOG.md)

The repository owner has not selected an open-source license. See [LICENSE](LICENSE); third-party Electron/Chromium notices remain in distribution packages.
