# Unicorn user guide — 1.0.0-rc.2

Unicorn opens 1–20 persistent Chromium browser profiles inside one Windows application. The interface has four sections: **Browsers, Links, Proxies and Settings**.

## Install

Target systems are Windows 10/11 x64 with an active interactive user session. For larger grids, start with a modern 8-core CPU, 16 GB RAM and an SSD, then measure your own pages. This is a reference configuration, not a measured minimum.

Download the installer or portable ZIP and its `SHA256SUMS.txt` from [GitHub Releases](https://github.com/OxSagar/unicorn/releases). Verify the matching hash, for example:

```powershell
Get-FileHash -Algorithm SHA256 .\Unicorn-Setup-v1.0.0-rc.2-x64.exe
```

Run the installer, or extract the entire portable ZIP into a writable local directory and launch `Unicorn.exe`. The portable executable needs its neighboring files. Both forms store persistent data in the Windows user-data directory, normally `%APPDATA%\Unicorn`; the portable ZIP does not carry those profiles with it automatically.

The installer is unsigned unless the release explicitly records a valid signature. Windows or organizational policy may warn or block execution. Verify the source/hash and follow your administrator's deployment policy; do not disable Windows security controls to bypass a block.

## Start a run

1. Open **Settings**, enter your hosts in **Approved domains**, select **I am authorized to test these websites**, and choose **Save settings**. Include required authorized CDN/API hosts for automated QA and use staging or test-ad pages.
2. Open **Browsers**, choose a **Browser count** from 1–20, and choose **Apply**. Select profiles individually or with **Select all**, then apply a Desktop, Mobile or Tablet preset as needed.
3. Open **Proxies** and refresh the API list if needed. Eligible endpoints are available for direct assignment; there is no validation button or waiting period for a diagnostic check.
4. Open **Links**, enter URLs in **One URL per line** or use **Import TXT / CSV**, then **Choose browsers**. Distribute the URLs and review the **Queue**; use **Edit** or **Remove** to adjust pending rows.
5. Choose **Start tests** to run the reviewed jobs. Use the global Pause/Resume or Stop controls to manage them. `Ctrl+Shift+S` stops activity while Unicorn is focused.

Assigning URLs does not start browsing. New assignments and saved queue edits need an explicit Start, including while another run is active. An empty proxy pool leaves the browser waiting. A listed endpoint may fail on the first page connection; the browser never silently switches to a direct route.

## Browsers

The workspace contains the real browser views, count and device controls, and global run controls. Each profile has its own address, navigation, loading state and run controls. Focus or expand a profile for inspection, then return to the grid.

Manual address navigation is separate from the timed QA sequence. It still requires an approved top-level destination and an assigned proxy. Ordinary third-party resources can load through that proxy during manual browsing; automated QA applies the authorized scope to resources too.

Desktop, Mobile and Tablet presets configure Chromium viewport, pixel ratio, touch and user-agent behavior. Changing a preset preserves cookies and website data. Custom profiles saved by rc.1 remain intact until you explicitly apply another preset; detailed viewport/fingerprint customization is no longer shown in the main interface.

Profile inspection provides current page/device/proxy details, history and cleanup actions. Ordinary closing or reducing the browser count retains persistent data. Cache, cookies and history have separate cleanup actions; a complete reset requires confirmation and clears the selected profile's site data and device configuration. Clear cache removes HTTP cache and preserves CacheStorage; full reset clears site stores. Permissions remain denied by default. Sibling profiles retain their data.

## Links

Enter one URL per line or import TXT/CSV (up to 2 MB). The editor preserves exact text across page changes and application restart, with a 2-million-character limit. Import appends extracted URLs; it does not archive the original file's other columns or formatting. Clear input removes the saved draft without removing queue assignments.

Choose the target profiles. The default round-robin method assigns successive URLs to successive selected profiles. Expand **More options** to choose same-URL, balanced or manual assignment, or allow duplicate pending URLs. Same-URL sends one URL to all selected profiles. Balanced uses queued work and sampled resources; it does not move already assigned jobs continuously. Completed jobs appear under the collapsed **Recent results** section.

Review the queue before Start. Pending rows can be edited or removed. Saving a URL/browser change requires another explicit Start. Running/finished jobs cannot be edited. A maximum of 1,000 active jobs is retained.

The QA sequence visits the landing page, an eligible internal link and an approved external link, with waits, scrolling and local diagnostic captures. Missing eligible links are recorded as skipped stages. Existing saved stage timings and exclusions continue to apply, while their detailed customization is omitted from the simplified settings.

## Proxies

ProxyScrape is the sole automatic provider. Unicorn requests and accepts API country metadata for:

| Country        | Code |
| -------------- | ---- |
| United States  | US   |
| United Kingdom | GB   |
| Canada         | CA   |
| France         | FR   |
| Germany        | DE   |
| Japan          | JP   |
| Italy          | IT   |
| Austria        | AT   |

`GB` is the API country code for the United Kingdom. These labels describe the API listing; Unicorn does not independently verify current exit geography.

Eligible supported endpoints are assigned directly. There is **no preflight diagnostic, exit-IP lookup, measured-latency test or reserve-validation queue**. The pool presents available, assigned and failed endpoints. Available means eligible for assignment, not proven to work. Different endpoints can expose the same public exit IP; only IP/port endpoint uniqueness is enforced.

Failures are discovered through actual browser connections. Recognized connection failures release and temporarily quarantine the endpoint. Automated QA may try another endpoint within its finite retry limit; manual browsing reports the error. Website restrictions, challenges and certificate failures are not bypassed by rotating proxies. HTTPS certificate validation remains enabled.

Refreshes occur at startup and as needed for low reserve, stale lists, cycle boundaries or actual transport failures. Overlapping requests coalesce and respect a minimum one-minute cooldown and provider Retry-After responses. An outage preserves active assignments and shows the fetch error.

Public proxies may be unavailable, slow, hostile or geographically mislabeled. Do not use sensitive passwords, payment information, financial accounts or valuable authenticated sessions through them. There is no guarantee of 20 working endpoints. Application routing controls apply to managed browser sessions, not every program on the computer. Provider-list retrieval uses a separate normal control-plane connection.

## Settings and repeating tests

Settings keeps the essentials: approved domains and confirmation, basic repeated-run controls, appearance and desktop behavior. For recurrence, enable repetition, choose the interval, save, and Start the reviewed queue. Stop cancels active work and disarms recurrence. Saved operating windows and other advanced backend settings continue to apply; simplifying the interface does not reset them.

Use hostnames without a scheme, path or port. `example.com` approves that host. `*.example.com` approves its subdomains, not the apex. Enter both if both are authorized. Authorized CDN/API hosts must be listed for automated resources.

Settings changes require active QA to be stopped. The app preserves existing timing, quota, retry, exclusion, resource and operating-window values when editing the visible controls. Only the obsolete validation timeout and unique-exit-IP settings are removed during the rc.1 upgrade.

A minimum one-minute recurrence interval and separate daily per-domain navigation/request limits remain enforced. WebSocket opening requests count; frames on an established connection do not. New/edited assignments are never silently added to an already reviewed run.

Troubleshooting controls provide compact resource/status information and log/result export without separate Logs or Performance navigation. Logs are retained locally with rotation and URL-secret redaction. History, queued URLs and QA screenshots can contain test data; review exports before sharing. Results export does not bundle screenshot files.

Optional tray/login settings operate in a logged-in Windows session. Suspending the system pauses work; resume requires review. There is no automatic OS reconnect/resume service or promise of interactive rendering after logout. Updates are downloaded and installed manually from the release page.

## Troubleshooting

| Symptom                                               | Action                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Waiting for proxy                                     | Refresh the API list and inspect available endpoints; no eligible unassigned endpoint may be available                          |
| First page fails                                      | An API-listed proxy can be offline or reject the destination; inspect the connection error and retry within the normal controls |
| API refresh does not run immediately                  | A fetch is already running, the cooldown is active, or the provider supplied Retry-After                                        |
| Country differs from expectation                      | The displayed country is API metadata; independent geography validation was removed in rc.2                                     |
| Jobs remain pending                                   | Review assignments and Start; check pause status, saved operating windows and domain/resource limits                            |
| Scripts/resources are blocked                         | Add required authorized CDN/API hosts; automated QA enforces resource scope                                                     |
| HTTP 401/403/429 or visible challenge                 | Stop and resolve access/authorization with the site; Unicorn does not rotate to bypass restrictions                             |
| A profile becomes unusable after native cleanup fails | Restart Unicorn; the session gate stays closed to prevent unsafe late route changes, while profile data is retained             |
| Windows blocks the unsigned app                       | Verify the release and follow your organization's deployment policy                                                             |

The application remains an evaluation release candidate. See [acceptance](acceptance.md), [testing](testing.md), [security](security.md) and the matching release workflow for completed checks and remaining 24-hour, consumer-device and packet-audit work.
