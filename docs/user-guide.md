# Unicorn user guide — 1.0.0-rc.4

## Choose browsers and device → Paste → Distribute → Start

Unicorn has one main screen. The only setup choices are **browser count** and **device type**.

1. Choose **1–20 browsers** and **Desktop, Mobile or Tablet**.
2. **Paste links**, one complete HTTPS URL per line.
3. Click **Distribute**. Unicorn prepares the assignments and shows the batch. This does not visit the pages.
4. Click **Start**. Start confirms that you are authorized to test the listed websites in a staging or test-ad environment, then runs that batch once.

A single link goes to every selected browser. Multiple links are spread in order across the browsers. If there are fewer unique links than browsers, the links repeat so each browser receives work. If there are more links, additional links wait in those browsers' queues. Duplicate pasted URLs are removed before assignment.

Only the prepared batch starts. Older saved work is not silently included. After changing the browser count, device type or pasted text, click Distribute again before Start.

Live browser previews appear below the controls. Expand a preview for a closer view. Progress and errors appear on the same screen.

Use **Stop** or `Ctrl+Shift+S` to cancel. Stop remains available while a command is starting or waiting for a proxy. Start can continue a paused accepted batch without approving new links.

## Everything else is automatic

- Proxies come directly from ProxyScrape for **US, GB, CA, FR, DE, JP, IT and AT (Austria)**. There is no proxy preflight request, exit-IP lookup, geography recheck or latency probe.
- Each active profile reserves a unique endpoint. During a reviewed run, a connection failure quarantines that proxy and automatically retries the same URL using another endpoint until it connects or you press Stop. When none are available, Unicorn waits and periodically tries the provider again. Failed proxies never enable direct fallback. Country labels are API metadata, so an endpoint can fail on its first page request.
- The selected device preset changes real Chromium viewport, pixel ratio, touch and user-agent behavior. It does not erase that profile's website data.
- QA uses bounded default waits, scrolling and retries for non-connection recovery. Connection-level proxy failures during reviewed runs have continuous, stoppable replacement rather than a two-attempt limit. Its stages can include the landing page, an eligible internal link and an approved external link. Missing eligible links are recorded as skipped stages.
- The batch runs once. Saved repeating schedules are not armed by this workflow or by restarting Unicorn.

There is no Settings page, browser-selection checklist, manual assignment editor, proxy refresh button or separate Apply step.

Only the exact website hosts listed in the prepared batch are approved for that run. This scope also applies to automated HTTP, HTTPS and WebSocket resources. Requests to unrelated hosts remain blocked. Start does not permanently create a broad allowlist.

HTTPS certificate checks, daily navigation/request budgets, resource limits, access-restriction handling and challenge detection remain enabled. The app does not click advertisements, solve CAPTCHAs or rotate proxies to bypass a site's refusal.

## Saved data

Each profile retains its real Chromium cookies, cache, local storage, IndexedDB and service workers. A smaller run does not delete unused profiles. The selected count and device choice are deliberate changes; other saved preferences, historical jobs and unrelated pending work remain stored. Pending work from the older interface is kept separately, so even an old full queue cannot block a new batch.

The link draft is saved locally. Approval is temporary: after restarting, Distribute the current inputs and click Start again. No old page or batch starts automatically.

## Install or update

Download the versioned installer or portable ZIP and `SHA256SUMS.txt` from [GitHub Releases](https://github.com/OxSagar/unicorn/releases). Check the matching SHA-256 value before launching:

```powershell
Get-FileHash -Algorithm SHA256 .\Unicorn-Setup-v1.0.0-rc.4-x64.exe
```

Install the EXE, or extract the entire ZIP and open `Unicorn.exe`. Windows 10/11 x64 and an interactive user session are targeted. The release is unsigned; follow Windows or organizational application policies. Automatic updates are not provided.

## When a run cannot continue

| Message or symptom                      | Meaning and next step                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Invalid link                            | Paste a complete HTTPS URL without credentials. Ordinary private-network destinations are not supported.              |
| No eligible proxy available             | Unicorn waits for an eligible unassigned endpoint. Stop remains available; public proxies are not guaranteed to work. |
| Inputs changed                          | Click Distribute again so Start uses the choices and links currently shown.                                           |
| Destination outside the approved scope  | The request targets a host outside this prepared batch and remains blocked.                                           |
| HTTP 401/403/429 or a visible challenge | Resolve access or authorization with the website before another run.                                                  |
| Budget or memory limit reached          | Stop and allow resources or the daily budget to recover; limits are not bypassed.                                     |
| A batch failed                          | Review the inline error, correct the inputs if needed, then Distribute and Start a new batch.                         |

The matching [Actions run](https://github.com/OxSagar/unicorn/actions) records native Windows and package checks. A successful run does not establish a 24-hour soak, consumer-device performance or a system-wide network audit; see [release notes](release-notes.md).
