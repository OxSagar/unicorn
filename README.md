# Unicorn

A Windows browser workspace with one ordinary workflow: **choose browser count and device → paste links → Distribute → Start**. Link assignments and eligible API proxies are handled automatically.

Unicorn embeds real Electron `WebContentsView` browser engines. Each profile keeps its own cookies, cache, local storage, IndexedDB, and service workers between application launches. It does not embed the branded Google Chrome executable.

## Download and release status

Get verified packages from [GitHub Releases](https://github.com/OxSagar/unicorn/releases). The current version is **1.0.0-rc.3**. A release candidate is intended for evaluation; it is not a production-readiness claim. Check [Actions](https://github.com/OxSagar/unicorn/actions) for the exact release's Windows verification and [release notes](docs/release-notes.md) for changes and acceptance limits.

Windows release assets include an NSIS installer, a portable ZIP, and `SHA256SUMS.txt`. Release automation requires unit checks, real Electron tests on Windows, package construction, packaged application launch, and installed application launch before publishing. Unsigned builds may trigger Windows warnings. No signing certificate is bundled or invented.

Version rc.3 replaces the four-page interface with one screen: browser count, device type, links, **Distribute**, **Start**, run status and live previews. There are no timing, distribution, proxy or advanced settings to configure. **Stop** remains available during work. Proxy preflight validation remains removed, and Austria remains eligible. The [recorded rc.1 measurements](docs/verification.md) are historical; current results belong to the matching release workflow.

## What it does

- Uses the selected 1–20 browsers and Desktop, Mobile or Tablet device type. One URL goes to every selected browser; multiple URLs are spread across them automatically, with additional URLs queued.
- Shows live Chromium previews, progress, errors and optional expansion. The chosen device preset applies to participating profiles while their cookies and website data remain intact.
- Fetches ProxyScrape public proxies from **US, GB, CA, FR, DE, JP, IT, and AT (Austria)** and assigns eligible API-listed endpoints directly. There is no diagnostic request, exit-IP lookup, latency probe, or separate validation queue.
- Reserves unique proxy endpoints atomically. Different endpoints can share an exit IP; API country labels are not independently verified.
- Blocks page networking before proxy assignment and after pause, stop, or failure. Proxy configuration contains no direct fallback and removes the implicit loopback bypass.
- Keeps the pasted draft locally. Distribute creates an exact, reviewable batch without browsing; changing the count, device or links requires another Distribute before Start.
- Runs bounded landing-page, internal-link, and approved external-link QA stages with asynchronous waits, scrolling, console/resource diagnostics, screenshots, and cancellation.
- Runs the prepared batch once using automatic defaults, with daily navigation/request budgets and emergency Stop. Saved recurrence never starts work on application launch, and the simple workflow does not arm a repeating schedule.
- Repairs eligible renderer crashes during an accepted QA job under bounded retry and per-profile limits; detects stalled renderers and preserves profile data.

## First run

Open Unicorn after installing or extracting it:

1. Choose **browser count** and **device type**, then **paste links**, one complete HTTPS URL per line.
2. Click **Distribute**. Unicorn prepares the browser assignments and shows the website hosts in the batch.
3. Click **Start**. This explicitly confirms authorization to test those listed websites in a staging or test-ad environment and starts only that prepared batch.

Use **Stop** or `Ctrl+Shift+S` to cancel. No settings page or separate proxy setup is required. Requests outside the reviewed website hosts remain blocked during automated QA; the app does not grant blanket access to unrelated hosts.

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
