# Unicorn 1.0.0-rc.3

Unicorn now has one main screen with only the requested setup: **browser count, device type and links**, followed by **Distribute → Start**.

## Changes

- Remove the four-page navigation, advanced settings, manual assignments, profile inspector and separate proxy controls.
- Keep a browser-count choice from 1–20 and one Desktop/Mobile/Tablet selector. No separate Apply button is needed.
- Spread links automatically. One link goes to every selected browser; multiple links cycle across the selected browsers, with additional links queued.
- Prepare an exact batch without browsing. Changing any input requires another Distribute; Start runs only that reviewed batch, once.
- Make Start the explicit authorization action for the displayed website hosts. Approval is limited to that batch and is not silently restored after restart.
- Keep Stop available during setup and proxy waits, plus live browser previews and optional expansion.
- Preserve profile storage, unrelated saved jobs and hidden preferences. Only explicitly chosen count/device values change; legacy schedules do not start work automatically.
- Continue direct API proxy assignment for US, GB, CA, FR, DE, JP, IT and AT (Austria), without proxy preflight validation.

## Installation

Download `Unicorn-Setup-v1.0.0-rc.3-x64.exe` or `Unicorn-Portable-v1.0.0-rc.3-x64.zip`, plus `SHA256SUMS.txt`. Check the matching hash before launching. Extract the entire portable archive before opening `Unicorn.exe`.

Windows 10/11 x64 is targeted. An interactive user session is required. The app embeds Chromium, not a separately installed branded Google Chrome product.

## Verification

Publication requires source checks, unit tests, real Electron tests on Windows, actual portable-ZIP extraction and launch, installer installation and launch, and SHA-256 verification at the exact release commit. The associated [Actions run](https://github.com/OxSagar/unicorn/actions) records current counts and results.

New coverage checks the minimal workflow, chosen count and real device behavior, exact prepared batches, input changes, cancellation, temporary host approval, single-run behavior, saved-data preservation and native view clipping. Existing proxy, TLS, profile, concurrency and recovery checks remain release gates.

Earlier version measurements remain historical. See the current [acceptance matrix](https://github.com/OxSagar/unicorn/blob/main/docs/acceptance.md) for scope and remaining limits.

## Known limits

- This is an unsigned evaluation release candidate. The 24-hour soak, consumer Windows 10/11 benchmarks and independent packet-level leak audit remain incomplete.
- API-listed proxy country and availability are not independently verified. An endpoint can fail on its first page request.
- A prepared run permits only its displayed exact hosts, including for automated page resources; unrelated redirects or asset hosts remain blocked.
- HTTPS certificate checks, authorized-site restrictions, budgets and challenge handling remain enabled. Application-level routing is not an OS firewall.
- Public proxies may be unreliable or hostile; do not use valuable authenticated sessions or sensitive credentials through them.
- The pinned dependency tree retains documented moderate build-tool findings; publication still requires passing audit gates. See the [dependency assessment](https://github.com/OxSagar/unicorn/blob/main/docs/dependency-audit.md).
- Automatic updates, authenticated proxies, SOCKS4 and a Windows service are not provided. Detailed device, timing, quota, recurrence and profile-maintenance controls are no longer exposed in the interface.
