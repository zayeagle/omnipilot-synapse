# One-click delivery — OmniPilot Synapse

This project ships a **browser extension** plus a **native-messaging companion** (`apps/git-bridge`),
not a service, so the generic `docker` / `k8s` / `binary` deploy modes do not apply: there is no
container to build and no cluster to schedule onto. The modes below are the deliverable equivalents —
build installable packages per browser family, and a single-file bundle for the companion process.

## Commands

```bash
make deploy-help                 # list everything below
make deploy                      # default: all browsers + companion
make deploy-chrome
make deploy-firefox
make deploy-verify               # verification only, no packages
make deploy-dry-run MODE=all     # print the steps without running them
make deploy MODE=companion ARGS=--dry-run
make deploy MODE=chrome ARGS=--skip-test
```

The Makefile delegates to `deploy/deploy.sh`, which routes to `deploy/pack/deploy.sh`:

```bash
./deploy/deploy.sh chrome    --dry-run
./deploy/deploy.sh companion --dry-run
./deploy/deploy.sh all       --build-only
./deploy/deploy.sh verify
ENV=production ./deploy/deploy.sh all --production
```

## Modes

| Mode | One-click | Produces |
|------|-----------|----------|
| `chrome` | `make deploy-chrome` | `.output/chrome-mv3/` + `*-chrome.zip` |
| `firefox` | `make deploy-firefox` | `.output/firefox-mv2/` + `*-firefox.zip` |
| `companion` | `make deploy MODE=companion` | `apps/git-bridge/.output/git-bridge-<platform>-<arch>.mjs` |
| `all` | `make deploy` | all three of the above |
| `verify` | `make deploy-verify` | typecheck + unit + integration + system + secret assertion, both packages |

`all` includes the companion. `chrome` and `firefox` still build only the extension, so they keep
working on a machine that has never installed the companion dependencies.

## Options

| Option | Effect |
|--------|--------|
| `--dry-run` | print each step without executing it |
| `--build-only` | compile the bundles, skip zipping/bundling |
| `--skip-test` | skip the unit/integration/system suites (local iteration only) |
| `--production` | refuse to package unless `ENV=production` is set |

## Prerequisites

- Node >= 20 and npm (the repo is developed on Node 24).
- `npm --prefix apps/extension install` (the root `postinstall` does this too).
- `npm --prefix apps/git-bridge install` — **companion modes only** (`companion`, `all`, `verify`).

## Install the artifact

**Chrome / Edge**

1. `make deploy-chrome`
2. `chrome://extensions` (Edge: `edge://extensions`) → enable **Developer mode**
3. **Load unpacked** → `apps/extension/.output/chrome-mv3`
   (or drag the `*-chrome.zip` onto the page — environment-dependent)

**Firefox**

1. `make deploy-firefox`
2. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**
3. Pick `apps/extension/.output/firefox-mv2/manifest.json`

A permanent Firefox install needs AMO signing; a permanent Chrome install needs the Web Store.

## Install the companion (native messaging host)

The SSH mode needs the companion registered as a native-messaging host. The host name is exactly
`com.omnipilot.synapse.git_bridge` and must stay equal to `DEFAULT_HOST_NAME` in
`apps/extension/lib/native/client.ts`.

1. Build the single-file bundle:

   ```bash
   make deploy MODE=companion            # or: npm --prefix apps/git-bridge run pack
   ```

2. Preview the manifests (this writes nothing):

   ```bash
   node apps/git-bridge/native-host/install.mjs --dry-run
   ```

3. Register the host. The extension does not pin an ID yet, so the installer requires it — guessing
   one would register a host the browser can never reach:

   ```bash
   # the unpacked extension ID from chrome://extensions → Details
   node apps/git-bridge/native-host/install.mjs --browser chrome --extension-id <chrome-extension-id>
   # both browsers (--firefox-id is the add-on ID from about:debugging)
   node apps/git-bridge/native-host/install.mjs --browser all \
     --extension-id <chrome-extension-id> --firefox-id <firefox-addon-id>
   ```

4. **Windows only:** the browser finds hosts through the registry, which is not a config directory, so
   the installer prints the exact `reg add` command instead of running it. Paste that command into a
   normal shell, then restart the browser.

The installer writes `<host>.json` inside that browser's own native-messaging directory —
`~/.config/google-chrome/NativeMessagingHosts` and `~/.mozilla/native-messaging-hosts` on Linux,
`~/Library/Application Support/{Google/Chrome,Mozilla}/…` on macOS, and
`%LOCALAPPDATA%\Google\Chrome\NativeMessagingHosts` on Windows. Nothing outside those directories
is touched, and `manifest.template.json` supplies the per-target shape (`allowed_origins` for
Chromium, `allowed_extensions` for Firefox) plus the absolute companion path.

## Environment variables

| Variable | Used by | Meaning |
|----------|---------|---------|
| `ENV` | `--production` guard | must be `production` to package a release explicitly |
| `ARGS` | every `make deploy-*` target | extra flags forwarded to the script |

There are **no application secrets** to configure for deployment. Everything the extension needs
(GitHub token, provider keys, vault passphrase) is entered by the user at runtime and stored only on
their device — see the security model in the [README](../README.md). The companion never receives a
credential: it runs the user's own `git`/`ssh`.

## Rollback

There is no server to roll back. To revert a bad build:

1. Remove the unpacked extension from `chrome://extensions` (or *Remove* the temporary add-on in
   Firefox).
2. Re-load the previous `.output/chrome-mv3` directory or the previously built zip.
3. Companion: delete the installed `<host>.json` from the browser's native-messaging directory (and,
   on Windows, the matching `HKCU\Software\…\NativeMessagingHosts\<host>` value), then re-run
   `make deploy MODE=companion` to restore the previous bundle.
4. Your data is unaffected: it lives in the GitHub repository you configured, not in the extension.

## Notes

- `make deploy-*` runs the content-bundle secret assertion before packaging; a build that could leak
  a credential into a page context fails rather than shipping.
- `npm run pack` (`scripts/pack.mjs`) in `apps/extension` is the Node-side equivalent of these shell
  scripts; either path produces the same artifacts. `apps/git-bridge/scripts/pack.mjs` is the
  companion equivalent: it typechecks, tests and folds `dist/` into one `.mjs` per OS without adding a
  bundler dependency.
- The companion bundle is plain Node ESM with no native modules, so the per-OS file name is a release
  label, not a build difference.
