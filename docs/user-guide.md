# Unicorn user guide

Unicorn is a Windows desktop workspace for browser compatibility checks and authorized website quality assurance. It manages up to 20 independent, persistent Chromium sessions inside one application.

Use the verification report accompanying a release to determine which platforms, features, and session counts were actually tested. A source branch or release candidate is not a claim of production readiness. Public proxies, hardware capacity, and website behavior can limit a particular run.

## 1. Install and open Unicorn

### Windows requirements

- Target operating systems: Windows 10 or Windows 11, 64-bit.
- An active Windows user session, network access, and enough free storage for Chromium profiles and application files.
- For heavier multi-browser work, plan around a modern 8-core CPU, 16 GB RAM, and an SSD. This is a reference configuration, not a measured minimum or a guarantee that every 20-page workload will remain responsive.

The application window has a minimum size of 1100 × 740. You can resize it, change grid columns, or expand an individual browser to inspect a page more comfortably.

### Download the correct release

Open the official [Unicorn releases page](https://github.com/OxSagar/unicorn/releases). Use a release whose notes identify the completed Windows checks and any remaining limitations. If there is no verified downloadable release, do not assume that an installer has been published merely because source code exists.

Expected release files follow these patterns; the version may include a release-candidate suffix:

| File                                  | Purpose                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `Unicorn-Setup-v<version>-x64.exe`    | Interactive Windows installer                           |
| `Unicorn-Portable-v<version>-x64.zip` | Application directory that can run without installation |
| `SHA256SUMS.txt`                      | Checksums for the published binary assets               |

Compare the checksum of your download with the matching entry in `SHA256SUMS.txt`. In PowerShell, substitute the exact downloaded filename:

```powershell
Get-FileHash -Algorithm SHA256 .\Unicorn-Setup-v1.0.0-x64.exe
```

Run the installer and follow its prompts. The installer offers an installation location and creates Start menu and desktop shortcuts. For the portable ZIP, extract the **entire archive** into a writable local folder and open `Unicorn.exe`; the executable needs its neighboring runtime files.

The portable package avoids installation, but profile data still lives in your Windows user-data directory. It is not a self-contained profile folder that automatically travels with the ZIP.

### Unsigned builds and Windows warnings

Unless a release explicitly says that valid signing credentials were used, treat the build as unsigned. Microsoft Defender SmartScreen evaluates downloaded application reputation, and a new or unsigned app may show an unrecognized-app warning. Windows 11 Smart App Control or an organization’s application policy may block it outright. These mechanisms do not certify the app’s correctness or replace the release verification evidence. See Microsoft’s [SmartScreen guidance for app developers](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation) and [Smart App Control overview](https://learn.microsoft.com/windows/apps/develop/smart-app-control/overview).

Verify the repository, release version, checksum, and available test evidence before deciding to run a download. Do not disable Windows security controls to make the app run. If your managed PC blocks unsigned software, ask its administrator about an approved deployment or use a properly signed release when one is available.

## 2. First run

1. Open **Settings** and enter the domains you are authorized to test. Use hostnames such as `staging.example.com`, without a scheme, path, or port.
2. Add any authorized CDN or asset hosts the automated test needs. Automated QA restricts subresource traffic to the approved host scope, so missing asset hosts can cause blocked scripts, fonts, images, or API calls.
3. Confirm that you have permission and that repeated tests use a staging environment or test advertising placements. Production monetized advertising must not be exercised repeatedly to create synthetic engagement.
4. Save settings. Stop active QA jobs before changing settings. Saving settings stops existing browser network sessions and reapplies the saved workspace configuration.
5. Choose a browser count between **1 and 20** in the top bar, then select **Apply**.
6. Open **Proxies** and inspect the pool. **Refresh pool** fetches the current eligible list; **Validate reserve** starts validation of up to four reserve candidates. Navigation also validates candidates as it allocates them.
7. Open **Link distribution**, add an approved URL, select the target browser or browsers, choose a distribution mode, and select **Distribute URLs**.
8. Review the queue, then select **Start tests** or **Start all**.

A browser with no usable proxy waits. Empty reserve counts and unavailable public proxies are normal failure conditions, not permission to switch to a direct connection. Unicorn cannot guarantee that ProxyScrape will provide 20 eligible, working, distinct exits at any given time.

### Scope examples

| Approved entry        | What it authorizes                                             |
| --------------------- | -------------------------------------------------------------- |
| `staging.example.com` | That exact host                                                |
| `example.com`         | The apex host only, not its subdomains                         |
| `*.example.com`       | Its subdomains, including nested subdomains; not the apex host |
| `cdn.example.net`     | That exact asset host, when you have authority to test it      |

If both the apex and all subdomains are authorized, enter both `example.com` and `*.example.com`. A wildcard is broad authorization, so prefer exact hosts when possible.

HTTPS is the normal navigation scheme. **Allow local test fixtures** additionally permits HTTP loopback URLs for controlled testing. Loopback hosts must still appear in the authorized scope, and browser traffic still requires a proxy. A public proxy normally cannot reach a test server running on your own PC; deterministic local proxy fixtures are used by the developer test suite.

## 3. Dashboard and browser controls

**Dashboard** shows live browser counts, assigned and reserve proxies, completed runs, pending jobs, app memory, CPU, and JavaScript-error totals. **Browsers** gives more vertical space to the same native browser grid.

The number selector and **Apply** resize the open workspace. Reducing the count closes the higher-numbered sessions after confirmation. Their persistent data remains available when those profile numbers are reopened.

| Control                         | Behavior                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Start all                       | Starts pending QA jobs for open browsers; configure scope and distribute URLs first  |
| Pause all                       | Pauses test orchestration and the affected network activity                          |
| Resume all                      | Resumes paused work and eligible pending jobs                                        |
| Stop all                        | Cancels current work and disables saved recurrence, including recovery after restart |
| `Ctrl+Shift+S`                  | Emergency stop while the application is focused                                      |
| Select all / profile checkboxes | Chooses profiles for link and device operations                                      |
| Grid layout                     | Selects automatic layout or one to four columns                                      |
| Expand                          | Uses the workspace area to inspect one browser; **All browsers** restores the grid   |

Each browser panel has an address field, Back, Forward, Reload/Stop loading, Start, Pause, and Stop controls. Enter a complete approved URL and press Enter or the arrow to browse manually. Manual address navigation is separate from the timed QA sequence. It still requires an approved top-level destination and verified proxy. Manual browsing can load ordinary third-party subresources through that proxy; repeated QA uses the stricter authorized subresource scope.

The panel footer reports the selected device, proxy country and protocol, and elapsed operation time. Loading indicators and errors come from the actual browser state. A panel can be hidden because it is offscreen or another workspace page is open without deleting its profile.

The **information** icon opens a session inspector with the page title, current URL, lifecycle state, viewport, touch and pixel-ratio settings, proxy endpoint, observed exit IP, errors, stage, and saved history.

### Browser states

| State                     | Meaning                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| Created / Stopped         | Profile exists; no test is currently running                          |
| Waiting for proxy         | No eligible, verified, unassigned proxy is available                  |
| Validating proxy          | A candidate is undergoing a real connection check                     |
| Ready                     | Proxy assignment is established before navigation                     |
| Navigating                | Chromium is loading the approved destination                          |
| Running                   | Manual browsing or the QA sequence is active                          |
| Paused                    | Work is paused and can be resumed                                     |
| Retry wait / Proxy failed | A transport problem is undergoing bounded recovery or needs attention |
| Completed                 | The QA sequence finished                                              |
| Error                     | Inspect the session message and activity log                          |

### Popups, developer tools, and diagnostics

Approved popups appear in the originating session’s **Child windows** list. **Inspect** displays a child in that browser’s panel; selecting it again returns to the parent. **Close** dismisses the child. Children use the originating profile and proxy. A destination outside the approved scope is rejected and logged.

**Check device behavior** reports values read from the real page, including user agent, viewport, device pixel ratio, touch points, screen information, and available client hints. **Open developer tools** opens Chromium’s inspection tools. Applying a device configuration may close developer tools so Unicorn can attach its emulation controller again.

## 4. Persistent profiles and cleanup

Browser profiles are numbered consistently from `Unicorn-Browser-01` to `Unicorn-Browser-20`. Cookies, cache, local storage, IndexedDB, and supported Chromium site data are stored separately for each profile. Closing a browser or the application is not a profile reset.

The session inspector offers:

- **Clear cache:** remove the selected profile’s cached responses.
- **Clear cookies:** remove its cookies; this may sign it out of websites.
- **Clear permissions:** restore Unicorn’s default-deny website permission handlers. Version 1 does not offer arbitrary permission grants.
- **Clear history:** clear its recorded navigation history.
- **Inspect storage:** report the profile’s disk usage.
- **Reset complete profile:** stop it, clear site data, cache, authentication state and history, restore desktop emulation, and open a blank page. Confirm this irreversible action in the dialog.
- **Close browser:** stop and close the session while retaining its profile data.

Cleanup actions stop the selected browser first. Other profiles retain their own data.

On Windows, application state normally lives under `%APPDATA%\Unicorn`. The directory contains saved settings and queue state, Chromium partition data, activity logs, and QA diagnostic captures. QA captures can include visible page content; treat them and profiles as potentially sensitive. Uninstalling is configured to retain app data. Reset profiles deliberately if you want their website data removed.

## 5. Link distribution

Enter one full URL per line or import a TXT/CSV file. The desktop file importer accepts files up to 2 MB. TXT imports allow comment lines beginning with `#`; CSV imports can use a `url`, `link`, or `address` column. The prepared queue is bounded to 1,000 active jobs.

The original input list stays visible after distribution. Review syntax errors and duplicate counts, choose profiles, then select a mode:

| Mode            | Assignment                                                                     |
| --------------- | ------------------------------------------------------------------------------ |
| Same URL to all | Exactly one URL is assigned to each selected browser                           |
| Round-robin     | Consecutive URLs go to consecutive selected browser profiles                   |
| Balanced        | Pending/running workload is considered when choosing the next selected browser |
| Manual          | Choose a selected browser for each input URL before distribution               |

Duplicate pending jobs are excluded unless you enable the duplicate option. Distinct profile assignments used for a compatibility comparison are still meaningful separate jobs.

Distribution does not start browsing. Inspect **Queue preview** first. Remove a pending job and redistribute its URL to change that assignment. **Clear pending** removes pending assignments and disables saved recurrence, including recovery after restart; completed and failed records remain only within the application’s bounded retained history. Export results when you need an external record.

## 6. Device profiles

**Device profiles** provides these presets:

| Preset  | Viewport   | Device pixel ratio | Touch    |
| ------- | ---------- | ------------------ | -------- |
| Desktop | 1440 × 900 | 1                  | Disabled |
| Mobile  | 390 × 844  | 3                  | Enabled  |
| Tablet  | 768 × 1024 | 2                  | Enabled  |

Select a preset or configure custom dimensions, pixel ratio, orientation, mobile behavior, and touch. Apply the configuration to selected browsers or all open profiles. Select only one profile to change an individual browser.

This uses Chromium’s supported emulation interfaces, including compatible user-agent and client-hint settings where available. Profiles identify the testing environment with Unicorn’s QA identifier. Emulation supports responsive-layout checks; it does not reproduce every physical Android, iOS, tablet, GPU, codec, or hardware behavior. Use real devices for the device-specific acceptance criteria your product requires.

Changing a device configuration does not delete cookies or website storage. **Restore desktop defaults** resets the form; select an Apply button to send that choice to browsers. The grid scales the presentation to fit available panel space while preserving the configured emulated viewport.

## 7. Proxy pool and connection behavior

ProxyScrape is the only automatic list provider in this version. Unicorn filters the provider’s records and verifies each allocated candidate through an HTTPS diagnostic request before website navigation. The diagnostic checks the observed exit IP and country; provider metadata alone is insufficient.

Eligible countries are United States (**US**), United Kingdom (**GB**), Canada (**CA**), France (**FR**), Germany (**DE**), Japan (**JP**), and Italy (**IT**). The country code for the United Kingdom is `GB`, not `UK`.

The pool shows retrieved records, eligible records, verified candidates, active assignments, reserve availability, failed candidates, country totals, latency, and observed exit IPs. Filter by country, status, or endpoint; large lists are paginated. A refreshed list can contain unverified candidates and is not proof that every endpoint works.

No two active browser sessions may hold the same proxy endpoint. **Require unique exit IPs**, enabled by default, also excludes simultaneously assigned endpoints that expose the same observed public IP.

The supported proxy model uses HTTP, HTTPS, and SOCKS5 where available and validated. SOCKS4 is not enabled in this version. An HTTP proxy can carry an HTTPS website through a CONNECT tunnel; the website’s HTTPS protocol does not mean the proxy transport itself is HTTPS. Consult the release’s protocol test evidence for what was actually exercised.

Failed proxy connections are not silently replaced with direct networking. Public proxies may be slow, hostile, unavailable, mislocated, or unable to reach a particular destination. Never use sensitive passwords, payment details, financial accounts, or valuable authenticated sessions through them.

Transport retries are bounded by the saved retry limit. HTTP 403/429 responses, authentication restrictions, and detected challenges are reasons to stop and inspect the test rather than rotate proxies to evade restrictions. TLS certificate failures are not bypassed.

The proxy requirement applies to embedded browser sessions. The app’s control-plane request to retrieve the provider list and a user-requested opening of the GitHub release page are separate operations. This is not an operating-system VPN or a guarantee that every other program’s network traffic uses these proxies.

## 8. Timed QA and schedules

The default sequence has 200 seconds of configured waiting/scrolling, plus navigation and processing time:

| Stage                             | Initial wait | Gradual scrolling |
| --------------------------------- | ------------ | ----------------- |
| Landing URL                       | 20 seconds   | 60 seconds        |
| Eligible internal link            | 20 seconds   | 60 seconds        |
| Explicitly approved external link | 10 seconds   | 30 seconds        |

Missing or ineligible links are skipped and logged. Sponsored/ad links are excluded from automatic selection. The runner records client errors, page timing information, and bounded diagnostic screenshots. It does not automatically click ads or bypass CAPTCHA challenges.

In **Test schedules**, edit the stage durations, navigation timeout, maximum scroll distance, repeat interval, operating window, and recovery preference. Save before relying on new values. An interval can be at least one minute, with a default of 30 minutes; choose a cadence suitable for your authorized test environment.

Operating hours use the Windows computer’s local timezone. `00:00` through `24:00` allows the full day. A window that crosses midnight is supported. Daily navigation budgets use UTC dates and reset at 00:00 UTC; failed attempts consume budget too. The limit counts navigation attempts per host, not every image, script, or API request made by a page.

To set up repeated monitoring, enable **Repeat authorized test runs**, select **Save schedule**, then review the queue and select **Start tests**, **Start all**, a browser’s **Start**, or **Run queued tests now**. Start captures the current pending jobs for the chosen browsers as their recurring URLs. Historical completed records do not become recurring work. Starting a replacement queue for one browser replaces that browser’s recurring URLs while retaining the saved sets for other browsers.

New assignments remain pending until another Start. Pause preserves unfinished reviewed work until Resume. Stopping or closing an individual browser, or reducing the browser count, cancels that browser’s remaining queue and removes its recurrence. **Stop all** or **Emergency stop** cancels active work and disables saved recurrence while leaving pending assignments available for review. **Clear pending** removes pending assignments and also disables saved recurrence. These actions remain effective after an application restart. To set up recurrence again, enable and save the schedule, then review and Start the desired queue.

Automatic recovery after an interrupted application session requires saved recurring URLs, an enabled schedule, and **Resume eligible work after restart**. Access restrictions, detected challenges, rate limits, and exhausted daily navigation budgets cancel pending work and remove recurrence for the affected host; inspect the cause before assigning and starting new work.

Windows sleep pauses tests. After the computer resumes, confirm network availability and use Resume. Keeping the process open in the tray does not make it a Windows service. Interactive Chromium rendering requires an appropriate logged-in user session; operation after logout is not promised.

## 9. Logs, performance, and exports

**Activity logs** filters by severity, browser, category, text, and starting date. **Export logs** writes the currently retained in-memory activity records to JSON; bounded rotating files also exist in the app’s logs directory. **Export test results** writes retained jobs, totals, export time, and the current resource sample to JSON.

Log messages redact URL credentials, query strings, and fragments, but queue/history records and diagnostic screenshots can still contain test information. Review exports before sharing them.

**Performance** shows observed app CPU, tracked-process memory, system memory, process count, uptime, and recent sample charts. These are session measurements, not certification that an arbitrary workload will run without lag. CPU representation can depend on the operating system’s process reporting.

The memory threshold can defer new QA jobs when the current app measurement exceeds the configured budget. Existing profile data is not silently deleted. Reduce the browser count, inspect the tested pages, or adjust the threshold when your hardware has capacity. Log retention is configurable from 1 to 90 days.

## 10. Tray, startup, and updates

When **Close to system tray** is enabled, the window’s Close button hides the main window while the application remains active. The tray menu offers **Show Unicorn**, **Pause all tests**, **Emergency stop**, and **Quit**. Quit performs graceful shutdown. Without close-to-tray enabled, closing the window exits the app.

**Start at Windows login** is optional. It opens the application in a logged-in user session; it does not create a system service or bypass login.

**Releases and updates** opens the official GitHub releases page in your default browser. Version 1 uses manual download/installation rather than a silent automatic updater. Close Unicorn before replacing portable runtime files or installing an update, and consult that release’s compatibility notes.

## 11. Troubleshooting

| Symptom                                             | What to check                                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting for proxy                                   | Refresh the provider pool, inspect failure reasons, and allow validation to finish. There may be no usable eligible public proxy. The app will not connect directly.                |
| Several browsers stay idle                          | Check pending assignments, proxy and exit-IP uniqueness, memory budget, operating hours, pause status, and daily navigation budget.                                                 |
| Start reports no jobs                               | Distribution creates jobs; entering an address alone only performs manual navigation. Add URLs through Link distribution first.                                                     |
| Destination outside scope                           | Add the exact authorized host, including approved external destinations. Wildcards do not implicitly include their apex host.                                                       |
| QA page is missing scripts or assets                | Include the required authorized CDN/API/asset hosts in scope. Automated subresource filtering is stricter than manual browsing.                                                     |
| HTTP URL rejected                                   | Use HTTPS. HTTP is limited to explicitly enabled loopback fixtures.                                                                                                                 |
| Certificate error                                   | Correct the server/proxy/certificate problem. Unicorn does not offer an ignore-certificate-errors switch.                                                                           |
| HTTP 403, 429, or challenge                         | Stop and review the site’s policy, access authorization, and test rate. Do not use proxy rotation to bypass the restriction.                                                        |
| Slow page or repeated timeout                       | Inspect proxy latency and server behavior. Reduce concurrency or change the authorized test timeout within sensible limits.                                                         |
| Device results seem inconsistent                    | Reapply the preset, use Check device behavior, and inspect the site’s viewport meta tag and responsive behavior. A small panel is a scaled presentation of the configured viewport. |
| A popup does not open                               | Verify destination scope and inspect the activity log. Look under Child windows in the originating browser inspector.                                                               |
| Settings cannot be saved                            | Stop active QA jobs first; confirm numeric ranges and valid hostnames.                                                                                                              |
| Profile unexpectedly appears signed out             | Check whether Clear cookies or Reset profile was used and whether you reopened the same profile number.                                                                             |
| A renderer crashed                                  | Inspect Activity logs and restart the affected browser/test. The profile is retained, but a crashed page does not count as a successful run.                                        |
| The app does not exit when the window closes        | Close to system tray is enabled. Choose Quit from the tray menu.                                                                                                                    |
| Monitoring stops after sleep/logout                 | Resume after sleep when the network is ready. Use an active Windows user session; logout is outside the interactive-rendering guarantee.                                            |
| SmartScreen or application policy blocks the app    | Verify release source and checksums. Follow your organization’s policy or obtain a signed release; do not disable security controls.                                                |
| Opening HTML in a browser shows desktop unavailable | Launch the installed/extracted desktop executable. The UI needs Electron’s privileged, validated application bridge and real Chromium sessions.                                     |

## 12. Chromium and compatibility limits

Unicorn embeds Electron’s Chromium engine using native `WebContentsView` instances. It does not embed screenshots or execute websites with basic HTTP requests. It is also not the separately branded Google Chrome program: Chrome-specific services, account synchronization, extensions, protected media, codecs, and some browser features may differ.

Remote website pages have JavaScript enabled but do not receive Unicorn’s privileged API, Node.js integration, or permission to access arbitrary local files. The application retains context isolation, renderer sandboxing, web security, and TLS validation. Some network features are restricted to prevent direct proxy bypass. See the project’s security documentation and the release verification results for the exact enforced feature set and remaining evidence gaps.

For upstream implementation context, see Electron’s [WebContentsView documentation](https://www.electronjs.org/docs/latest/api/web-contents-view), [session documentation](https://www.electronjs.org/docs/latest/api/session), and [security guidance](https://www.electronjs.org/docs/latest/tutorial/security). ProxyScrape’s [public API documentation](https://docs.proxyscrape.com/api-reference/public-api/get-proxy-list) describes the list provider; a provider listing does not guarantee that a particular public proxy is currently usable.
