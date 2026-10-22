# Unicorn 1.0.0-rc.2

This update removes proxy preflight validation, adds Austria, and simplifies Unicorn's interface.

## Changes

- Assign eligible ProxyScrape endpoints directly from the API. There is no diagnostic request, exit-IP lookup, country recheck, latency probe, reserve-validation button or validation queue.
- Accept API-listed countries US, GB, CA, FR, DE, JP, IT and AT (Austria).
- Keep unique endpoint allocation and fixed-proxy browser routing. Actual connection failures are handled when browsing; an unavailable endpoint never enables direct fallback.
- Use four main sections: Browsers, Links, Proxies and Settings. Basic device presets and run controls remain prominent, with fewer settings and diagnostics kept out of the main workflow.
- Preserve existing profiles and saved configuration on upgrade. Obsolete validation settings are removed without resetting the remaining saved values.
- Keep Stop effective during a settings save, and handle connection failures caused by later page clicks as well as address-bar navigation.

The app still provides 1–20 persistent Chromium sessions, URL distribution, approved QA stages, scheduling, Pause/Resume/Stop, profile cleanup and bounded renderer recovery. The Chromium engine and renderer sandbox remain enabled.

## Installation

Download `Unicorn-Setup-v1.0.0-rc.2-x64.exe` or `Unicorn-Portable-v1.0.0-rc.2-x64.zip`, plus `SHA256SUMS.txt`. Verify the matching hash before launching. Extract the entire portable archive before opening `Unicorn.exe`.

Windows 10/11 x64 is targeted. For larger workloads, the documented starting reference is a modern 8-core CPU, 16 GB RAM and an SSD; it is not a measured universal minimum. An interactive Windows user session is required. The app embeds Chromium rather than an independently installed Google Chrome product.

## Verification

Publication is gated by source checks, unit tests, real Electron tests on Windows, actual portable-ZIP extraction and launch, installer installation and launch, and SHA-256 verification at the exact release commit. The associated [Actions run](https://github.com/OxSagar/unicorn/actions) records the current test counts, package evidence and failures if any. Updated coverage includes direct allocation without diagnostics, API-country assignment, Austria, unique endpoints, real connection failures, settings migration and the simpler interface.

The [rc.1 verification record](https://github.com/OxSagar/unicorn/blob/main/docs/verification.md) remains historical. Its old validation behavior and measurements do not describe rc.2. See the current [acceptance matrix](https://github.com/OxSagar/unicorn/blob/main/docs/acceptance.md) for the revised scope.

## Known limits

- This is an evaluation release candidate. The 24-hour soak, consumer Windows 10/11 benchmarks and independent packet-level leak audit remain incomplete.
- Country and availability labels come from ProxyScrape. Unicorn no longer verifies actual exit geography or distinct public exit IPs, and a listed endpoint may fail on its first page request.
- Public proxies may be unreliable or hostile; do not use sensitive credentials or valuable authenticated sessions through them.
- Application-level routing controls are not an OS firewall. HTTPS certificate checks, authorized-domain restrictions and site restriction handling remain enabled.
- Signing credentials have not been supplied. Treat the installer as unsigned and follow Windows or organizational application policies.
- The pinned dependency tree retains the documented moderate build-tool findings; publication still requires passing audit gates. See the [dependency assessment](https://github.com/OxSagar/unicorn/blob/main/docs/dependency-audit.md).
- Automatic updates, authenticated proxies, SOCKS4 and a Windows service are not provided. Custom device/timing/quota controls are no longer exposed in the simplified interface; existing stored values remain intact.
