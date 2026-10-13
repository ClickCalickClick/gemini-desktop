# TODO

The working plan for this fork of Gemini Desktop: what to do next, in what order, and what is already done.
This file is how progress is remembered between sessions, for people and AI agents alike.
The evidence behind each item is in [docs/CODEBASE_OVERVIEW.md](docs/CODEBASE_OVERVIEW.md); bug IDs such as B1 point there.

## How to use this file

- Read it before starting work. Unless asked for something else, take the first open item in the current focus.
- Every item has an ID. Use it in the branch name, the commit message and the PR title, for example `L2: add pacman target`.
- In the PR that does the work, tick the item, link the PR, and add a line to the [Done log](#done-log). Mark work in flight as `[~]` with its PR link.
- New problems become new items in the right section, not notes in a chat.
- Items marked **(owner)** need Jared: an account, a secret, a repository setting, or a test on real hardware.
- Keep every feature and keep Windows building. An item that would drop a feature needs the owner's OK first.

Legend: `[ ]` open, `[~]` in progress, `[x]` done, `[!]` blocked (say on what).

## Decisions

- **2026-10-13:** The main platforms are CachyOS (Arch-based, KDE Plasma on Wayland, kernel 7.x) and macOS. Windows stays supported but secondary.
- **2026-10-13:** GitHub Actions builds the installers. Linux comes first. macOS CI comes later; until then the owner builds macOS locally ([how](docs/CODEBASE_OVERVIEW.md#55-building-installers-by-hand)).
- **2026-10-13 (proposed, confirm):** Keep the app id `com.benwendell.gemini-desktop`. It ties together the macOS bundle and its microphone permission, the Windows install identity and existing installs' settings, so changing it would break upgrades from upstream builds.
- **2026-10-13 (proposed, confirm):** Keep upstream's version line. The first fork release is `v0.13.0`.
- **2026-10-13 (proposed, confirm):** Installs from pacman, deb, rpm and tar.gz only notify about updates; the package manager does the update. The AppImage and Windows builds keep self-updating.

## Needs the owner

These are one-time settings only Jared can change. O1 blocks every CI item.

- [ ] **O1** Enable GitHub Actions on the fork: open the Actions tab and choose "I understand my workflows, go ahead and enable them". GitHub does not run workflows in a fork until this is done.
- [ ] **O2** Repository settings: turn on Issues, and change the Website field, which still points at upstream's GitHub Pages site.
- [ ] **O3** Choose the maintainer line baked into Linux packages. Default if no choice is made: `ClickCalickClick <16350651+ClickCalickClick@users.noreply.github.com>`.
- [ ] **O4** Settings, Code security: turn on private vulnerability reporting, Dependabot alerts and Dependabot security updates.

Later owner items: L13 and L14 (first release and CachyOS test), L16 (AUR), M2 and M3 (macOS runners and signing), S12 (Dependabot version updates).

## Current focus: Phase 1, Linux installers from GitHub Actions

Goal: pushing a `v*` tag builds the AppImage, pacman, deb, rpm and tar.gz packages on GitHub Actions, proves the pacman package installs on real Arch, and drafts a GitHub release. Windows keeps building in the same workflow.

**Packaging config** (one PR)

- [ ] **L1** Package metadata. Add `license: "MIT"`, `homepage`, `repository`, `bugs` and `desktopName: "gemini-desktop.desktop"` to `package.json`. In `config/electron-builder.config.cjs`, set `publish.owner` and `publish.repo`, and `linux.maintainer` (O3). Done when packaging works from a git worktree without `-c` overrides and the pacman `.PKGINFO` shows the MIT license and the fork maintainer.
- [ ] **L2** pacman target. Add `pacman` (x64) to `linux.target` with an explicit `pacman.depends`: `gtk3 nss nspr alsa-lib libxss libxtst libnotify libsecret xdg-utils hicolor-icon-theme mesa`. Set `linux.desktop.entry.StartupWMClass` to `gemini-desktop`. Extend `tests/unit/main/electronBuilderLinuxPackageMetadata.test.ts`.
- [ ] **L3** deb and rpm dependencies. Use electron-builder's default lists plus ALSA instead of the custom lists, which drop GTK 3, xdg-utils and AT-SPI (and libsecret on deb). Keep appindicator as a deb `recommends`; drop rpm's GTK 2 `libappindicator`.
- [ ] **L4** Make `dist:linux` and `dist:mac-*` build first, as the Windows scripts already do.

**Workflows** (one PR)

- [ ] **L5** Replace `release.yml`, `manual-release.yml`, `_build.yml` and `_release.yml` with one `release.yml`:
    - `verify`: the tag matches `package.json`, then lint, both builds and the three Vitest suites.
    - `linux` on `ubuntu-24.04`: install `libarchive-tools`, `rpm` and `xvfb`, package, run `npm run test:e2e:release`, write `SHA256SUMS`.
    - `publish`: create or update a **draft** release with `gh`.
    - Rewrite the ~186 lines of unit tests that read `_release.yml` as text, and update `AGENTS.md`, `tests/e2e/AGENTS.md` and `docs/CONTRIBUTING.md`.
- [ ] **L6** Arch install check in the `linux` job: in an `archlinux:latest` container, `pacman -Syu`, `pacman -U` the package, check that `gemini-desktop.desktop` is installed, and fail if `ldd` reports a missing library.
- [ ] **L7** `ci.yml` for pushes and PRs: lint, both builds, the three Vitest suites, and a Linux packaging job that uploads the AppImage and pacman package as a 7-day artifact, so any PR can be installed on CachyOS. Move `test.yml` and `_test.yml` to manual or nightly runs.
- [ ] **L8** Node 22 in CI, plus `.nvmrc` and an `engines` field. CI pins Node 20, which is end of life.
- [ ] **L9** Windows x64 and arm64 jobs in the new `release.yml`, with the x64 packaged E2E and installer smoke test. The upgrade-from-previous-release check cannot pass until the fork has a release, so drop it or make it non-blocking; if dropped, remove `scripts/release/resolve-windows-baseline-installer.cjs` and its test.

**Update path and fork identity** (app change, one PR)

- [ ] **L10** One repository constant for the fork (B10). Define the URL once in `src/shared/constants/urls.ts` and use it for the update check (`updateManager.ts:698`), release notes, "Report an Issue", License and Disclaimer (fixing the 404 path to `docs/DISCLAIMER.md`), and `src/main/dev-app-update.yml`. Delete the two other copies and update the tests that assert upstream values.
- [ ] **L11** Package-manager installs: keep deb, rpm, pacman and tar.gz notify-only, and have the toast say to update with the package manager (detect the install type from `resources/package-type`). Never enable electron-updater's `PacmanUpdater`, which runs `pacman -Sy` on failure.
- [ ] **L12** README and SECURITY for the fork. Replace the hiatus banner, badges and download links; correct the artifact names; add CachyOS/Arch install steps (`sudo pacman -U ./Gemini-Desktop-<version>-x64.pacman`, and `fuse2` for the AppImage); credit upstream. Point `docs/SECURITY.md` at the fork's private vulnerability reporting (O4).

**First release**

- [ ] **L13 (owner)** Set the version to `0.13.0`, push tag `v0.13.0`, review the draft release, note that users of upstream builds must install this one by hand once, and publish it. Publishing is what makes it visible to update checks.
- [ ] **L14 (owner)** Test on CachyOS: `pacman -U` pulls only the expected dependencies; the KDE launcher, taskbar icon and window grouping are right; the tray works; sign-in survives a restart; `pacman -R` removes `/usr/bin/gemini-desktop`; the AppImage runs (install `fuse2` if it complains).

**Optional**

- [ ] **L15** AppImage without `fuse2`: try `toolsets.appimage: "1.0.2"`, or `1.0.3` with electron-builder 26.17 or later. Needs a CachyOS test.
- [ ] **L16 (owner)** An AUR package, `gemini-desktop-bin`, that repackages the release's pacman file, so `paru` or `yay` handle updates. Needs an AUR account.

## Phase 2: Bring back features that are off on CachyOS and macOS

- [ ] **P1** Global hotkeys on kernel 7+ (B1). Never load the native `usocket` module: exclude it from the package, and connect dbus-next with a `unix:socket=` address converted from `DBUS_SESSION_BUS_ADDRESS`. Then remove the D-Bus part of the kernel guard, keeping it for node-llama-cpp until P3. **(owner)** Verify on CachyOS: no `v8_ArrayBuffer_NewBackingStore` crash, KDE shows its shortcut dialog, and all three hotkeys fire and survive a restart.
- [ ] **P2** Upgrade Electron 39 to 44 (B4). Work through the breaking changes of 40 to 44 (`console-message`, login items, Wayland), and re-check the V8 sandbox behaviour behind the kernel guard, wdio-electron-service and chromedriver.
- [ ] **P3** Text prediction in packaged builds (B2, B3). Stop excluding the packaged platform's own `@node-llama-cpp` CPU (or Metal) binary; check that the binary loads before starting the 640 MB model download; fix `sandboxInit.ts` reading the wrong settings file, or remove that gate if node-llama-cpp no longer needs it; add a CI check that `llama-addon.node` is in the Linux package. **(owner)** Confirm the model loads on macOS.
- [ ] **P4** Close the bridge exposure (B5): no preload in the sign-in window, one navigation and window-open allowlist for every window, dev and test IPC only in development or E2E runs, and sender checks in `BaseIpcHandler`.
- [ ] **P5** Export and Voice Chat act on the active tab (B6, B7), through one `getActiveTabId()` and frames found by their `gemini-tab-<id>` name.
- [ ] **P6** Stop logging text prediction prompts and completions (B11).
- [ ] **P7** Global hotkeys on X11 (B8): let the X11 adapter use Electron's native `globalShortcut`. Test in a Plasma X11 session.
- [ ] **P8** Launch at startup on Linux through an XDG autostart entry, and "start minimized" on macOS through `wasOpenedAtLogin` (B9). Until then, hide the toggles where they do nothing.
- [ ] **P9** Small fixes (B13): the native "Sign in" waits for the window to close; menu labels come from the real accelerators; the README's PDF shortcut; stale predictions are discarded; title polling pauses while hidden; settings writes are atomic.

## Phase 3: macOS installers from GitHub Actions (later)

Until then, build on a Mac by hand ([recipe](docs/CODEBASE_OVERVIEW.md#55-building-installers-by-hand)).

- [ ] **M1** Consistent ad-hoc signing (`identity: "-"`), with hardened runtime off or the full JIT entitlements. Drop the zip until macOS auto-update exists, updating `tests/unit/main/releaseWorkflowAliases.test.ts`.
- [ ] **M2** macOS jobs in `release.yml`: arm64 on `macos-latest`, and Intel on `macos-15-intel` or not at all **(owner decides)**. Avoid `macos-14`, which retires on 2026-11-02.
- [ ] **M3 (owner)** Developer ID signing and notarization: Apple Developer Program (US$99 a year), then the `CSC_LINK`, `CSC_KEY_PASSWORD` and notarization secrets.
- [ ] **M4** macOS auto-update after M3: support in `MacAdapter`, upload the zip and `latest-mac.yml`, and fix the channel naming in `updateManager.ts`.

## Phase 4: Simplify, keeping every feature

- [ ] **S1** Delete dead code and assets (about 1,000 lines and 3.3 MB): the unused hooks `useQuickChatNavigation`, `useWebviewInit` and `useOptionsWindow`, the never-rendered `UpdateToast`, the unreachable model selection in `llmManager.ts`, unused images in `src/renderer/assets`, `public/` and `build/`, and the `.sisyphus` line in `.ignore`.
- [ ] **S2** Dependencies: remove `yaml`, `@playwright/test`, `@types/marked`, and `typedoc` together with `typedoc.json` and the `docs` script (which would overwrite `docs/`); declare `esbuild`; update electron-builder to the latest 26.x.
- [ ] **S3** Scripts: remove `scripts/process_icon.cjs`, `scripts/run-all-e2e-groups.cjs` and the unused `.github/actions/e2e-setup`; narrow the `pkill` in `scripts/clean.cjs`; fix the stale version comments on pinned actions.
- [ ] **S4** Make the tests honest (B12): wire in or delete the orphan E2E specs and `tests/unit/e2e/`; remove the missing spec from `config/wdio/wdio.conf.js`; make `npm run test:e2e` run what CI runs; set WDIO retries to 0 or 1; remove the release checks that read the defunct `globalThis.llmManager`.
- [ ] **S5** Slim the test suite: one test layer per behaviour (drop the duplicated `tests/coordinated/ipc/` tests), merge duplicate test files, lower the coverage gates to about 80/70 and drop the `*.coverage.test` files, give renderer tests one home, keep an E2E smoke set for Linux Wayland (macOS later), and replace the 44 `browser.pause()` calls.
- [ ] **S6** Docs: merge the agent instructions into one shorter `AGENTS.md`, fix the false claims listed in the [overview](docs/CODEBASE_OVERVIEW.md#9-docs-that-are-wrong-today), merge the testing docs into one and the Linux and Wayland docs into one, fold `TRANSPARENCY.md` into `PRIVACY.md` with a correct list of endpoints, and remove upstream's GitHub Pages files from `docs/`.
- [ ] **S7** One typed settings channel (`settings:get`, `settings:set`, `settings:changed`) and one store with atomic writes; migrate `update-settings.json` and `notification-settings.json` into it.
- [ ] **S8** One Gemini integration layer: move the inline script out of `mainWindow.ts`, build every injected script from `geminiSelectors.ts`, and add a dev command that reports which selectors still match the live site.
- [ ] **S9** One Linux adapter, with the scattered platform checks moved into the adapters.
- [ ] **S10** One menu model that renders both the native menu and the custom titlebar menu.
- [ ] **S11** Log files with rotation through electron-log, so bug reports can include logs.
- [ ] **S12 (owner)** Restore Dependabot version updates, grouped monthly. Forks must turn them on explicitly.
- [ ] **S13** Report the fpm `pacman_opt_depends` template bug upstream, so the pacman package can declare optional dependencies later.

## Done log

- **2026-10-13:** Codebase overview and this TODO list ([docs/CODEBASE_OVERVIEW.md](docs/CODEBASE_OVERVIEW.md), `TODO.md`).
