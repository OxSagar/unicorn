# Dependency audit assessment

Assessment date: **22 October 2026**. This records the dependency tree pinned in `package-lock.json` for Unicorn `1.0.0-rc.1`; it is not a claim that future installs or releases have the same findings.

## Results and release implications

The complete dependency audit reports **eight moderate findings**, with no high or critical findings. They arise from one advisory and its affected build-tool dependency chain. The CI gate at `--audit-level=high` passes while these moderate findings remain. A separate successful `npm audit --omit=dev --json` run reports **zero findings** for the production dependency tree.

The unresolved advisory is [GHSA-hp3w-g68c-fv3c / CVE-2026-97058](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). It concerns `sprintf-js` through version `1.1.3`: attacker-controlled numeric precision in a format string can throw an uncaught `RangeError` and interrupt the calling operation. The advisory lists **no patched version**. The [upstream report and remediation discussion](https://github.com/alexei/sprintf.js/issues/237) remain open at the assessment date.

This is a residual build-tool finding, not a clean full audit. It must remain visible in release evidence until a supported upstream change removes or fixes the affected dependency.

## Dependency path and exposure

`npm ls sprintf-js roarr global-agent @electron/get electron-builder app-builder-lib --all` confirms the installed path:

| Dependency         | Installed version | Relationship                                         |
| ------------------ | ----------------- | ---------------------------------------------------- |
| `electron-builder` | `26.15.3`         | Development and packaging tool                       |
| `app-builder-lib`  | `26.15.3`         | Packaging implementation                             |
| `@electron/get`    | `3.1.0`           | Download helper used by the packaging implementation |
| `global-agent`     | `3.0.0`           | Optional download-proxy support                      |
| `roarr`            | `2.15.4`          | Logger used by that proxy support                    |
| `sprintf-js`       | `1.1.3`           | Affected formatting dependency                       |

The separately pinned Electron `45.0.0` installation uses `@electron/get` `5.1.0`; it is distinct from the older nested download helper above. A range appearing in an audit report should not be mistaken for the installed version.

The application declares only React and React DOM as production packages, with `scheduler` transitively included. The main process and preload are bundled by [the build script](../scripts/build.mjs), and the packaged file selection is defined in [electron-builder.yml](../electron-builder.yml). Inspection of the generated main and preload bundles found no `sprintf-js`, `roarr`, or `global-agent` dependency. This limits the identified exposure to dependency installation and packaging; it does not certify all third-party code or replace Windows package validation.

Review of the installed `global-agent` logging calls found constant message strings, with URLs, response headers, and errors supplied as structured context. No attacker-controlled format-string path was identified in those calls. This is a scoped source review, not proof that every use of the affected library is safe.

## Remediation decision

The registry metadata checked on the assessment date provides no compatible patched release within this dependency chain: `app-builder-lib` `26.15.3` still requests `@electron/get` `^3.0.0`, and the available `3.x` download helper retains this optional proxy chain. Newer major releases of `global-agent` or `roarr` change that chain, but forcing them beneath older consumers would override their declared compatibility constraints.

The audit also suggests downgrading `electron-builder` to `26.5.0`, whose dependency tree lacks this path. That is an older packaging toolchain requiring a fresh compatibility and artifact review. A clean audit count alone does not establish that the downgrade is a safe release change.

For this candidate, retain the pinned toolchain and document the moderate residual. No `audit fix --force`, arbitrary dependency override, or unvalidated packaging downgrade has been applied. Reassess when the formatter publishes a patch or the packaging tool adopts a compatible download helper without this chain. Any such update should run the full audit, typecheck, unit tests, Windows browser tests, installer build, and packaged launch check before release.

## Reproducing the assessment

From a clean checkout with the supported Node version:

```sh
npm ci
npm audit --json
npm audit --omit=dev --json
npm ls sprintf-js roarr global-agent @electron/get electron-builder app-builder-lib --all
```

`npm audit --json` may exit nonzero while still producing its findings. Preserve that output and the exact lockfile revision in CI. Registry and advisory data can change, so rerun these checks for every release candidate rather than treating this dated assessment as a permanent exemption.
