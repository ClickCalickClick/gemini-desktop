# Codebase Overview

A maintainer's map of Gemini Desktop as it stood when this fork was taken over: what the app does, how it is built and shipped, what is broken, and what makes it hard to maintain.
Planned work and progress live in [TODO.md](../TODO.md). This file is the evidence behind those items.

- **Snapshot:** 2026-10-13, at upstream commit `6dae4a7` (v0.12.1), the last upstream commit before its hiatus.
- **Fork:** [ClickCalickClick/gemini-desktop](https://github.com/ClickCalickClick/gemini-desktop), forked from [bwendell/gemini-desktop](https://github.com/bwendell/gemini-desktop).
- **Owner's platforms:** CachyOS (Arch-based, KDE Plasma on Wayland, Linux kernel 7.x) first, then macOS. Windows keeps building but is secondary.
- **How this was produced:** two read-only code reviews, a local run of lint, both builds and the three Vitest suites, and a local Linux packaging run. Anything marked _(inferred)_ comes from reading code or docs, not from running it on the target platform.

Line references point at `6dae4a7` and will drift as the code changes.
For the runtime architecture in depth, read [ARCHITECTURE.md](./ARCHITECTURE.md), keeping in mind the corrections in [section 9](#9-docs-that-are-wrong-today).

## 1. What the app is

Gemini Desktop is an unofficial Electron wrapper around `https://gemini.google.com/app`.
A React shell shows a tab bar, and each tab holds a cross-origin `<iframe>` of Gemini.
The main process strips `X-Frame-Options` and CSP `frame-ancestors` so Gemini can be framed, then drives the embedded page with `WebFrameMain.executeJavaScript`: it injects Quick Chat prompts, clicks the mic, extracts the conversation for export and changes how Enter behaves.

Around that core it adds a Spotlight-style Quick Chat window, global hotkeys (with an XDG desktop portal path over D-Bus for Wayland), a tray icon, response notifications and badges, PDF and Markdown export, zoom, themes, always-on-top, launch at startup, auto-update, and optional local next-word prediction with `node-llama-cpp`.

## 2. Stack and size

| Layer         | What                                                                                                  | Version at snapshot                   |
| ------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Shell         | Electron                                                                                              | 39.8.10, end of life since 2026-05-05 |
| UI            | React, Framer Motion                                                                                  | 19.2, 12.42                           |
| Build         | TypeScript, Vite (renderer), `tsc` + esbuild (main and preload), electron-builder                     | 5.9, 7.3, esbuild via Vite, 26.8.1    |
| Tests         | Vitest with jsdom, WebdriverIO with `wdio-electron-service`                                           | 4.1, 9.27                             |
| Runtime deps  | electron-updater, electron-log, semver, marked, turndown (+gfm), dbus-next, node-llama-cpp (optional) | see `package.json`                    |
| Node (dev/CI) | Node.js                                                                                               | CI pins 20 (end of life); no `.nvmrc` |

Electron support status comes from [endoflife.date/electron](https://endoflife.date/electron): 39.8.10 was the final 39.x release. The supported lines in October 2026 are 44 (until 2027-03-02), 43 (until 2027-01-05) and 42 (until 2026-10-20).

App code is 159 TypeScript files and about 23,600 lines (main 14,500, renderer 7,100, shared 1,500, preload 400).
Test code is about 93,600 lines, roughly four lines of tests for every line of app code.

## 3. Features: the must-not-regress list

Every feature below must keep working through the cleanup. The status is for packaged builds at the snapshot.
"Wayland, kernel 7+" is the CachyOS case.

| Feature                                                                                         | macOS                                             | Linux (Wayland, kernel 7+)                                                 | Windows          | Main code                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------- |
| Gemini in tabs (up to 20; Ctrl/Cmd+T, Ctrl+W, Ctrl+Tab, Ctrl+1..9; reload keeps the tab's chat) | OK                                                | OK                                                                         | OK               | `renderer/context/TabContext.tsx`, `TabStateIpcHandler.ts`      |
| Google sign-in window                                                                           | OK                                                | OK                                                                         | OK               | `windows/authWindow.ts`                                         |
| Single instance                                                                                 | OK                                                | OK                                                                         | OK               | `main.ts`                                                       |
| Close to tray, tray menu, tray click opens Quick Chat or the main window                        | OK                                                | OK (needs an AppIndicator host; Plasma has one)                            | OK               | `trayManager.ts`, `TrayIpcHandler.ts`                           |
| Native menu and custom titlebar menu                                                            | OK                                                | Degraded: wrong shortcut labels                                            | Degraded: same   | `menuManager.ts`, `useMenuDefinitions.ts`                       |
| Options window and About                                                                        | OK, but the disclaimer link is a 404              | same                                                                       | same             | `renderer/components/options/`                                  |
| Theme (system, light, dark)                                                                     | OK                                                | OK                                                                         | OK               | `ThemeIpcHandler.ts`, `ThemeContext.tsx`                        |
| Zoom 50-200%                                                                                    | OK                                                | OK                                                                         | OK               | `windowManager.ts`                                              |
| Always on top (Ctrl/Cmd+Alt+P)                                                                  | OK                                                | OK                                                                         | OK               | `AlwaysOnTopIpcHandler.ts`                                      |
| Fullscreen (F11, also from inside Gemini)                                                       | OK                                                | OK                                                                         | OK               | `mainWindow.ts`                                                 |
| Offline overlay, error boundaries, opt-in crash reporter                                        | OK                                                | OK                                                                         | OK               | `OfflineOverlay`, `GeminiErrorBoundary`, `main.ts`              |
| Quick Chat global hotkey (Ctrl/Cmd+Shift+Alt+Space)                                             | OK                                                | **Disabled by code** (B1); X11 always disabled (B8)                        | OK               | `QuickChatIpcHandler.ts`, `hotkeyManager.ts`, `dbusFallback.ts` |
| Peek and Hide global hotkey (Ctrl/Cmd+Shift+Space)                                              | OK                                                | **Disabled by code** (B1)                                                  | OK               | `hotkeyManager.ts`, `windowManager.ts`                          |
| Voice Chat global hotkey (Ctrl/Cmd+Shift+M)                                                     | Degraded: can hit the wrong tab (B7)              | **Disabled by code** (B1)                                                  | Degraded (B7)    | `windowManager.ts`, `micActivation.ts`                          |
| Hotkey customization and Linux hotkey notice                                                    | OK                                                | OK                                                                         | OK               | `IndividualHotkeyToggles.tsx`, `LinuxHotkeyNotice.tsx`          |
| Local text prediction in Quick Chat (Qwen3 0.6B, ~640 MB download)                              | **Broken**: no binary shipped (B2)                | **Broken**: no binary shipped, and disabled on 7+                          | Plausibly OK     | `llmManager.ts`, `TextPredictionIpcHandler.ts`                  |
| Export chat to PDF or Markdown (Ctrl/Cmd+Shift+P)                                               | Degraded: exports the first tab (B6)              | Degraded (B6)                                                              | Degraded (B6)    | `exportManager.ts`, `chatExtraction.ts`                         |
| Response-ready notifications and badges                                                         | OK (Dock badge)                                   | OK (notification only)                                                     | OK (overlay dot) | `notificationManager.ts`, `badgeManager.ts`                     |
| Auto-update                                                                                     | Notify-only, checks **upstream** (B10)            | AppImage: electron-updater. deb, rpm, tar.gz: notify-only, checks upstream | electron-updater | `updateManager.ts`                                              |
| Launch at startup, start minimized                                                              | Start minimized likely broken on 13+ _(inferred)_ | **No-op** (B9)                                                             | OK               | `LaunchAtStartupIpcHandler.ts`                                  |
| Smart Enter and scroll-to-bottom button                                                         | OK                                                | OK                                                                         | OK               | inline script in `mainWindow.ts`                                |
| Linux sandbox fallback (`--no-sandbox` when user namespaces and SUID sandbox are unavailable)   | n/a                                               | OK                                                                         | n/a              | `sandboxDetector.ts`, `sandboxInit.ts`                          |

Since then, the CachyOS test found that Gemini's own Sign in button cannot sign in on any platform (B14), and neither can a tab that a server redirect sends to Google's sign-in page while it loads. L18 ([#2](https://github.com/ClickCalickClick/gemini-desktop/pull/2)) opens both in the sign-in window. P1 (same PR) turns the three global hotkeys back on for Wayland on kernel 7+ (B1).

Persisted state lives in the user-data folder: `user-preferences.json`, `tabs-state.json`, `update-settings.json`, `notification-settings.json` and `models/*.gguf`.
Google cookies live in Chromium's default session; there is no `persist:` partition.

## 4. How it is put together

- **Main process.** `src/main/main.ts` is the composition root. It builds the Window, Hotkey, Badge, Update, Export, Llm and Ipc managers, then Menu, Tray and Notification, and keeps them in a module-level `appContext` that E2E tests also reach through `global.appContext`.
- **IPC.** 87 channels in `src/shared/constants/ipc-channels.ts` (9 of them dev or test only), 15 handler classes extending `BaseIpcHandler` in `src/main/managers/ipc/`, a 464-line `ElectronAPI` type in `src/shared/types/ipc.ts`, and 17 preload modules in `src/preload/api/` spread into `window.electronAPI`. Adding one boolean setting touches about eight files.
- **Renderer.** Three Vite pages (main window, options, Quick Chat) and five React contexts (Theme, Toast, UpdateToast, Tab, IndividualHotkeys).
- **Persistence.** A custom JSON `SettingsStore` (`src/main/store.ts`), not electron-store. It caches on construction and writes non-atomically.
- **Platform code.** Adapters in `src/main/platform/` for Linux Wayland, Linux X11, macOS and Windows, plus 43 platform checks spread across 17 other files.
- **Gemini integration.** Selectors are meant to live in `src/main/utils/geminiSelectors.ts` (last verified 2025-12-23), but copies also live in a ~390-line inline script in `mainWindow.ts`, in `chatExtraction.ts` and in `TabStateIpcHandler.ts`. A Google UI change breaks features silently, so this is the most likely source of future bug reports.

## 5. Build, packaging and release

Sections 5.1 to 5.3 describe the snapshot. Since then, TODO items L1 to L9 ([#1](https://github.com/ClickCalickClick/gemini-desktop/pull/1)) added the package metadata and the pacman target, made the `dist:*` scripts build first, and replaced the workflows; the root [AGENTS.md](../AGENTS.md#ci-and-releases-github-actions) describes the current ones.

### 5.1 Local build

| Step             | Command                                                | What it does                                                                                                                             |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer         | `npm run build`                                        | Type-checks, then Vite builds the three pages into `dist/`.                                                                              |
| Main and preload | `npm run build:electron`                               | `tsc` to CommonJS in `dist-electron/`, then `scripts/rename-electron-output.cjs` renames to `.cjs` and bundles the preload with esbuild. |
| Package          | `npm run dist:linux`, `dist:mac-arm64`, `dist:mac-x64` | electron-builder with `config/electron-builder.config.cjs`, output in `release/`.                                                        |
| Package Windows  | `npm run dist:win-x64`, `dist:win-arm64`               | Same, through `scripts/release/run-windows-dist.cjs`, which builds first if needed.                                                      |

Rough edges:

- The Linux and macOS `dist:*` scripts do not build first, so they can package stale output. Run both builds before them.
- esbuild is used by the build but not declared in `package.json`; it arrives through Vite.
- Lint only runs in the pre-commit hook. No workflow runs it.
- `npm run clean` runs `pkill -f electron`, which also kills VS Code, Slack and any other Electron app.
- There is no `.nvmrc` or `engines` field, and CI pins Node 20, which is end of life.

### 5.2 Packaging

electron-builder 26.8.1 produces:

| Platform | Targets                          | Notes                                                                                                   |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Linux    | AppImage, deb, rpm, tar.gz (x64) | No pacman target yet. File suffixes differ per format: `-x86_64.AppImage`, `-amd64.deb`, `-x86_64.rpm`. |
| macOS    | dmg and zip, arm64 and x64       | Unsigned (`identity: null`). The zip only feeds update metadata that nothing reads.                     |
| Windows  | NSIS installer, x64 and arm64    | Signed through Azure only when the `AZURE_*` secrets exist; the fork has none.                          |

Problems found in the config, several confirmed by a local Linux packaging run on 2026-10-13:

- **No package metadata.** `package.json` has no `repository`, `homepage`, `bugs` or `license`, and names the upstream author. electron-builder then falls back to the `origin` URL in `.git/config`. That works in a normal clone, but in a git worktree, a tarball or an AUR build the deb and pacman targets stop with "Please specify project homepage", and `app-update.yml` is not written. The pacman metadata also says `license = unknown` and `packager = Ben Wendell`.
- **pacman works with small changes.** Adding `pacman` to the targets produced a working `Gemini-Desktop-0.12.1-x64.pacman` (XZ, about 120 MB) once the build host had `bsdtar` (Ubuntu package `libarchive-tools`). electron-builder's default pacman dependencies all resolve on Arch today, but they pull in all of `ffmpeg` (111 dependencies), the stale `http-parser`, and `libappindicator-gtk3`, which only exists as a `provides`. An explicit list modelled on Arch's own Electron apps is better: `gtk3 nss nspr alsa-lib libxss libxtst libnotify libsecret xdg-utils hicolor-icon-theme mesa`.
- **deb and rpm dependency lists replace electron-builder's defaults** instead of adding to them, so they drop GTK 3, xdg-utils and AT-SPI (and libsecret on deb). Desktop systems have these anyway; minimal ones install the package and then fail to launch.
- **The text prediction binary is excluded on Linux and macOS** (B2). The local Linux package contains `node-llama-cpp` but no `@node-llama-cpp/*` binary.
- **The `.desktop` entry's `StartupWMClass` is "Gemini Desktop"** while the app runs with class `gemini-desktop`, so KDE may not group the window with its launcher _(inferred)_.
- **macOS hardened runtime is on with only the `audio-input` entitlement.** That does not matter while builds are unsigned, but signing will need the JIT entitlements electron-builder's template includes.

Local packaging results (Linux x64 container, 2026-10-13):

| Target   | Result                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| AppImage | Built, about 160 MB.                                                                                               |
| deb      | Built, about 130 MB, once a homepage was passed in.                                                                |
| pacman   | Built, about 120 MB, once a homepage was passed in and `bsdtar` was installed.                                     |
| All      | The native `usocket` rebuild needs to download Electron headers; GitHub runners can, the test container could not. |

Since then, P1 ([#2](https://github.com/ClickCalickClick/gemini-desktop/pull/2)) leaves `usocket` out of the package and turns off electron-builder's native module rebuild, so packaging no longer downloads Electron headers.

### 5.3 CI and release (GitHub Actions)

| Workflow             | Lines | Trigger                       | What it does                                                                                           |
| -------------------- | ----: | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `test.yml`           |    98 | push and PR to `main`, manual | Build, then `_test.yml`: about 48 jobs per push.                                                       |
| `release.yml`        |    57 | tag `v*`, manual              | Build, all 46 test jobs with E2E fail-fast, then `_release.yml`.                                       |
| `manual-release.yml` |    47 | manual                        | Build and release without tests.                                                                       |
| `_build.yml`         |    75 | reusable                      | Builds `dist/` and `dist-electron/` and passes them between jobs.                                      |
| `_test.yml`          |   578 | reusable                      | Unit, coordinated, integration, and E2E in 12 or 13 groups on each of Windows, macOS and Ubuntu.       |
| `_release.yml`       |   590 | reusable                      | macOS x2, Windows build, upgrade-validate and publish (x64 and arm64), Linux; four separate uploaders. |
| `scorecard.yml`      |    65 | weekly, push                  | OpenSSF Scorecard.                                                                                     |

One tagged release runs 55 jobs, 18 of them on macOS, and one flaky E2E group on any OS blocks the whole release.

The fork's state on 2026-10-13: Actions has never run (GitHub does not run workflows in a fork until the owner enables them), there are no releases or tags, Issues are off, and the repository's website field still points at upstream's GitHub Pages site.

Blockers for releasing from the fork as-is:

- Actions must be enabled first.
- The Windows upgrade check installs the previous release before testing the new one. The fork has no previous release, so `scripts/release/resolve-windows-baseline-installer.cjs` throws and the Windows installers are never published.
- Nothing checks that the tag matches the `package.json` version.
- About 186 lines of unit tests read `_release.yml` as text, so any workflow refactor must update them in the same change.

The proposed replacement is one tag-driven `release.yml` (verify, then a Linux job, then a publish job that creates a draft release with `gh`; Windows and macOS jobs added later) plus a small `ci.yml` for pushes and PRs. That is about 254 lines instead of about 1,445, and 3 to 5 jobs per release instead of 55. The Linux job should install the pacman package in an `archlinux:latest` container and fail if `ldd` reports a missing library.

### 5.4 Updates

Since then, L10 and L11 ([#2](https://github.com/ClickCalickClick/gemini-desktop/pull/2)) point the notify-only check at the fork's releases, and the notice on deb, rpm and pacman installs says to install the new package with the package manager.

| Install type                         | How updates work today                                          | What fork users get                                        |
| ------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------- |
| Windows installer                    | electron-updater, using `latest-x64.yml` or `latest-arm64.yml`  | Fork releases (the feed comes from the CI checkout).       |
| Linux AppImage                       | electron-updater, using `latest-linux.yml`                      | Fork releases.                                             |
| macOS, deb, rpm, tar.gz (and pacman) | Notify-only: the app asks the GitHub API for the latest release | **Upstream** releases, because the URL is hardcoded (B10). |

- Draft releases are invisible to both checks. Publishing the draft is what makes an update go live.
- Never enable electron-updater's `PacmanUpdater`: when `pacman -U` fails it runs `pacman -Sy --noconfirm`, a partial upgrade that Arch does not support. Package-manager installs should only notify.
- Installs of upstream builds have upstream's feed built in, so their users must install a fork build by hand once.
- macOS auto-update needs a signed app, so macOS stays notify-only until Developer ID signing exists.

### 5.5 Building installers by hand

Linux (Ubuntu or Debian build host; on Arch install `libarchive`, `rpm-tools` and `libxcrypt-compat` instead, because electron-builder's bundled fpm needs `libcrypt.so.1`):

```bash
sudo apt-get install -y libarchive-tools rpm
npm ci
npm run dist:linux
# Output in release/: the AppImage, deb, rpm, pacman and tar.gz packages.
# To build only the pacman package: npm run dist:linux -- -c.linux.target=pacman
```

macOS on Apple Silicon (`npm ci` tries to build the optional `usocket` module with the Xcode command line tools and carries on without it; the app never uses it):

```bash
npm ci
npm run dist:mac-arm64
# Output: release/Gemini-Desktop-<version>-arm64.dmg and release/mac-arm64/Gemini Desktop.app
```

An app you build yourself carries no quarantine flag, so Gatekeeper does not block it on your own Mac _(inferred)_. A copy downloaded from elsewhere needs `xattr -dr com.apple.quarantine "/Applications/Gemini Desktop.app"`.
Upstream CI cross-built the Intel version on Apple Silicon. That will stop working for text prediction once its binary is shipped (node-llama-cpp does not support packaging x64 on arm64), so build Intel copies on an Intel Mac or an Intel runner.

### 5.6 Notes for CachyOS (KDE Plasma, Wayland)

- **Prefer the pacman package over the AppImage.** It installs `gemini-desktop.desktop` (which the global-shortcuts portal uses to identify the app), keeps the Chromium sandbox, and needs no FUSE. The AppImage needs `fuse2` and launches with `--no-sandbox` from its desktop entry.
- **Wayland works natively.** Electron 38.2 and later use native Wayland by default, and Plasma's tray supports Electron's StatusNotifierItem.
- **Kernel 7.x turns off global hotkeys and text prediction** (B1). Arch's `core/linux` was 7.2.9 on 2026-10-13.

Since then, L15 ([#2](https://github.com/ClickCalickClick/gemini-desktop/pull/2)) builds the AppImage with electron-builder's type2 runtime (toolset `1.0.2`), which needs `fusermount3` from `fuse3` instead of `fuse2`. GNOME and KDE Plasma already install `fuse3` through `xdg-desktop-portal`. P1 (same PR) brings the global hotkeys back on kernel 7; text prediction waits on P3.
The owner's CachyOS machine runs GNOME on Wayland, not KDE Plasma. GNOME shows tray icons only through the AppIndicator extension, which is enabled there.
On Linux the tray uses `build/icon-tray.png`, a white Twin Sparks drawn edge to edge so it fills GNOME's top bar like other tray icons (Windows keeps `icon.ico`, macOS `icon-mac-trayTemplate.png`; a missing file falls back to the app icon). GNOME 51's AppIndicator extension (checked on the owner's machine) opens the tray menu on a single left click without telling the app, sends `Activate` on a double click, which Electron reports as the Tray `click` event, and `SecondaryActivate` on a middle click (Electron does not surface it, so the app does not handle it). The tray menu starts with Quick Chat, and the Options setting "Tray icon opens" (`trayClickAction`, Quick Chat by default, or the main window) decides what that click opens; on desktops that send `Activate` on a single click (KDE Plasma, Cinnamon, XFCE) and on Windows it opens on a single click. On macOS Electron emits the click and shows the tray menu on the same left click, so the chosen window opens behind the menu (from Electron's `tray_icon_cocoa.mm`; not yet checked on a Mac). The Options description is worded per platform: the GNOME double-click hint only on Linux.

## 6. Tests and current health

Results of a clean run on 2026-10-13 (Linux x64, Node 22, `npm ci`):

| Check                    | Command                    | Result                                     |
| ------------------------ | -------------------------- | ------------------------------------------ |
| Lint                     | `npm run lint`             | Pass                                       |
| Renderer build           | `npm run build`            | Pass                                       |
| Main and preload build   | `npm run build:electron`   | Pass                                       |
| Renderer unit            | `npm run test`             | 56 files, 651 passed, 4 skipped            |
| Main, preload, shared    | `npm run test:electron`    | 76 files, 1,880 passed                     |
| Coordinated (multi-unit) | `npm run test:coordinated` | 55 files, 852 passed                       |
| Integration (WDIO)       | `npm run test:integration` | Not run here; needs a display and Electron |
| E2E (WDIO)               | `npm run test:e2e`         | Not run here                               |

Seven renderer unit test files import the real `electron` package, so `npm run test` fails if dependencies were installed without the Electron binary (for example with `--ignore-scripts`).

Problems with the suites:

- A dozen top-level E2E specs, covering the newest features (tabs, zoom, voice chat, Wayland hotkeys, response notifications, text prediction), are not referenced by any config, script or workflow, so they never run. `tests/unit/e2e/` is in no Vitest config either.
- `npm run test:e2e` runs 12 specs while CI runs 12 spec groups, and `config/wdio/wdio.conf.js` lists a spec file that does not exist.
- WDIO retries failing tests twice and spec files twice, so one test can run up to nine times before it counts as failed (`config/wdio/wdio.base.conf.js`).
- The release-time text prediction checks launch with `--test-text-prediction`, which returns a stub prediction, so they cannot catch the missing binary (B2).
- Every IPC handler is tested twice, once in unit tests and once in `tests/coordinated/ipc/`. Coverage gates of 97-98% have produced `*.coverage.test.tsx` files that exist only to hit lines.
- Integration specs contain 44 `browser.pause()` calls even though the docs forbid fixed waits.

Since then, [TEST_COVERAGE.md](TEST_COVERAGE.md) maps every feature to the tests that exercise it, and TODO items T1 to T4 plan a harness that tries every feature.

## 7. Known bugs and risks

IDs are referenced from [TODO.md](../TODO.md).

Since then, the CachyOS test found B14 to B17. L18 ([#2](https://github.com/ClickCalickClick/gemini-desktop/pull/2)) fixes B14 and the first part of B13: the native "Sign in" menu item reloads after the window closes. L20 (same PR) fixes B15. P1 (same PR) fixes B1 for the global hotkeys: dbus-next connects through Node's `net` module, `usocket` is left out of the package, and the kernel guard covers only node-llama-cpp. L21 (same PR) fixes B16, and L22 ([#4](https://github.com/ClickCalickClick/gemini-desktop/pull/4)) fixes B17.

| ID  | Severity | Issue                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                               |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| B1  | High     | Wayland global hotkeys are switched off on Linux kernel 7+. The guard works around a crash blamed on dbus-next's optional native `usocket` transport, which dbus-next can do without.                                                                                                                                                                                                      | `sandboxDetector.ts:36,183-199`, `dbusFallback.ts:437-440,496-505`                     |
| B2  | High     | Local text prediction cannot load in packaged Linux or macOS builds: the builder config excludes every Linux and macOS `@node-llama-cpp/*` binary, and the app calls `getLlama({ build: 'never' })`. Verified in a local Linux package.                                                                                                                                                    | `config/electron-builder.config.cjs:46-60`, `llmManager.ts:486-489`                    |
| B3  | High     | On Linux kernel 6 and older, enabling text prediction leaves a permanent "restart required" loop: `sandboxInit.ts` reads `settings.json`, but the preference is saved in `user-preferences.json`.                                                                                                                                                                                          | `sandboxInit.ts:22-40`, `ipcManager.ts:122`                                            |
| B4  | High     | Electron 39 is end of life, so the app renders a signed-in Google site on a Chromium that has missed five months of security fixes.                                                                                                                                                                                                                                                        | `package.json`                                                                         |
| B5  | Medium   | The full `window.electronAPI` bridge is attached to the Google sign-in window, which has no navigation allowlist. No IPC handler checks its sender, and dev/test IPC channels are registered in production builds.                                                                                                                                                                         | `baseWindow.ts:83-89`, `authWindow.ts:95-127`, `AutoUpdateIpcHandler.ts:75-103`        |
| B6  | Medium   | Export uses the first Gemini frame instead of the active tab.                                                                                                                                                                                                                                                                                                                              | `exportManager.ts:112-124`                                                             |
| B7  | Medium   | Voice Chat reads a stale, startup-time copy of the tab state, so it can click the mic in the wrong tab.                                                                                                                                                                                                                                                                                    | `windowManager.ts:55-56,253-260`, `store.ts:101`                                       |
| B8  | Medium   | Global hotkeys are always disabled on X11, on the false premise that Electron's `globalShortcut` does not work there.                                                                                                                                                                                                                                                                      | `LinuxX11Adapter.ts:1-8,74-81`                                                         |
| B9  | Medium   | "Launch at startup" is a silent no-op on Linux (`setLoginItemSettings` only works on macOS and Windows), and the toggles still show.                                                                                                                                                                                                                                                       | `LaunchAtStartupIpcHandler.ts:92-103`                                                  |
| B10 | Medium   | Update checks, release notes, "Report an Issue" and the security contact still point at upstream.                                                                                                                                                                                                                                                                                          | [section 8](#8-upstream-references-to-change)                                          |
| B11 | Medium   | Local prediction prompts and completions are written to the main-process log.                                                                                                                                                                                                                                                                                                              | `llmManager.ts:651-668`                                                                |
| B12 | Low      | Orphaned E2E specs and vacuous release checks (see section 6).                                                                                                                                                                                                                                                                                                                             | `scripts/run-e2e-sequential.cjs`, `config/wdio/`                                       |
| B13 | Low      | Smaller defects: the native "Sign in" menu reloads before the window closes; menu labels show the wrong shortcuts; the README says Ctrl+P for PDF (the binding is Ctrl/Cmd+Shift+P); Quick Chat can show a stale prediction; tab titles are polled every 3 s even when hidden; settings writes are not atomic and a corrupt file silently resets everything.                               | `menuManager.ts:311-318`, `useMenuDefinitions.ts:198`, `README.md`, `store.ts:104-160` |
| B14 | High     | Gemini's own Sign in button shows Google's 401 "malformed request" page. The button navigates the Gemini iframe to `accounts.google.com`, and Google refuses its sign-in pages inside an iframe (`Sec-Fetch-Dest: iframe`). Only File > Sign in to Google opens a separate window.                                                                                                         | `mainWindow.ts:214-255`, `security.ts:28`                                              |
| B15 | Medium   | Quitting at logout crashes the app on Linux. A logout, a shutdown or `pkill` sends SIGTERM to all of the app's processes; the zygotes die too, so Chromium cannot start a new GPU process and ends the app with "GPU process isn't usable" (SIGTRAP; on CachyOS it then hung until SIGKILL). The app's own SIGTERM handler never runs: Electron replaces it.                               | `main.ts:481-496,536-545`, `mainWindow.ts:174-185`, electron/electron#54547            |
| B16 | Medium   | Sending a Quick Chat on GNOME Wayland leaves the main window behind other apps: the question reaches Gemini, but GNOME refuses the app's request to raise a window that is already open.                                                                                                                                                                                                   | `windowManager.ts` (`focusMainWindow`), Chromium's `WaylandToplevelWindow::Activate`   |
| B18 | Medium   | Changing a global hotkey in Options does nothing on GNOME or KDE Wayland once the user has approved the shortcuts: the desktop keeps the approved keys and ignores the app's new `preferred_trigger`. The "Use Copilot key" preset hit this, and GNOME names the Copilot key `XF86Assistant` rather than `F23` anyway. Fixed by H19: Options shows the desktop's key and opens its dialog. | `dbusFallback.ts`, gnome-control-center `cc-global-shortcut-dialog.c`                  |
| B17 | High     | Showing a minimized main window again ends the app on Wayland: Chromium still counts it as minimized after it is hidden, and its Wayland code refuses that state when it creates the window again. Clicking Show in the tray crashed it on CachyOS.                                                                                                                                        | `LinuxWaylandAdapter.ts`, Chromium's `WaylandToplevelWindow::CreateXdgToplevel`        |

## 8. Upstream references to change

`grep -rniE "bwendell|benwendell|wendell"` matches 25 files outside `package-lock.json`.

Since then, L1, L10 and L12 ([#1](https://github.com/ClickCalickClick/gemini-desktop/pull/1), [#2](https://github.com/ClickCalickClick/gemini-desktop/pull/2)) changed `package.json`, the app's repository constants, `dev-app-update.yml`, the tests that asserted upstream values, `README.md`, `docs/SECURITY.md`, and the issue links in `docs/CONTRIBUTING.md` and `docs/PRIVACY.md`. `docs/TRANSPARENCY.md` and upstream's GitHub Pages files are left for S6.

| Where                                                                                            | What it does in the fork                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/managers/updateManager.ts:698`                                                         | The notify-only update check (macOS, deb, rpm, tar.gz) asks `api.github.com/repos/bwendell/gemini-desktop`, so those users never hear about fork releases.                                        |
| `src/shared/constants/urls.ts`, `src/main/utils/constants.ts`, `src/renderer/utils/constants.ts` | Three copies of the repo URL feed release notes, "Report an Issue", License and Disclaimer links. The Disclaimer link points at `/blob/main/DISCLAIMER.md`, but the file is `docs/DISCLAIMER.md`. |
| `src/main/dev-app-update.yml`                                                                    | Dev update tests point at upstream.                                                                                                                                                               |
| `package.json`                                                                                   | Upstream author, and no `repository`, `homepage`, `bugs` or `license` fields, so packaging depends on `.git/config` (section 5.2).                                                                |
| `docs/SECURITY.md`                                                                               | Vulnerability reports go to the upstream author's email and upstream's Security tab.                                                                                                              |
| `README.md`, `docs/CONTRIBUTING.md`, `docs/PRIVACY.md`, `docs/TRANSPARENCY.md`                   | Hiatus banner, badges and download links for upstream.                                                                                                                                            |
| `docs/index.html`, `docs/sitemap.xml`, `docs/robots.txt`, `docs/script.js`, `docs/style.css`     | Upstream's GitHub Pages site.                                                                                                                                                                     |
| Tests asserting upstream values                                                                  | `releaseNotes.test.ts`, `constants.test.ts`, `windowsMacAdapters.test.ts`, `fatalErrors.test.ts`, `fatal-errors.coordinated.test.ts`, `AboutSection.test.tsx` must change with the constants.     |
| `appId` `com.benwendell.gemini-desktop`                                                          | Keep it. It is the macOS bundle id (microphone permission), the Windows AppUserModelId and the update identity of existing installs.                                                              |
| `LICENSE`, About screen copyright                                                                | Keep. MIT requires the notice; add a fork line next to it.                                                                                                                                        |

## 9. Docs that are wrong today

These claims appear in `AGENTS.md`, `docs/ARCHITECTURE.md` or the boundary `AGENTS.md` files and do not match the code:

- There is no `persist:gemini` session partition; Google sessions use Chromium's default session.
- The app does not connect only to Google: it also calls `api.github.com` and GitHub release downloads for updates, `huggingface.co` for the prediction model, and an optional `CRASH_REPORT_URL`. `docs/PRIVACY.md` and `docs/TRANSPARENCY.md` omit huggingface.co.
- `X-Frame-Options` stripping is not limited to `gemini.google.com`; it also covers `accounts.google.com`, `ogs.google.com`, `aistudio.google.com` and localhost (`src/main/utils/security.ts:23-33`).
- `src/main/store.ts` is a custom JSON store, not electron-store.
- `tests/unit/e2e/` is listed as a unit suite but never runs.
- The `docs` npm script (`typedoc --out docs src`) needs a plugin that is not installed, and if it ran it would overwrite `docs/` _(inferred)_.

## 10. What makes it hard to maintain

1. **Tests outweigh the app four to one and absorb most of the churn.** Across the 279 non-Dependabot commits, test and test-config changes total about 349,000 lines against 87,000 for app code, and WDIO files changed in 140 of those commits. A large share of the fix commits went into making E2E pass on CI runners rather than into the app.
2. **The IPC plumbing multiplies small changes.** A boolean setting needs a channel constant, an `ElectronAPI` entry, a preload module, a handler, store defaults and two drifting `UserPreferences` interfaces. The four most-changed files in `src/` are all plumbing.
3. **Gemini DOM knowledge is scattered** over four files, so a Google UI change means hunting for every copy.
4. **Native modules cause platform-specific breakage.** `usocket` (through dbus-next) and `node-llama-cpp` are behind the kernel 7 workaround, the Linux sandbox flag juggling and most packaging exclusions.
5. **Things that should be one thing are two:** the native and custom menus, the two Linux adapters, two stores for `autoUpdateEnabled`, three copies of the repo and app URLs.
6. **Documentation sprawl.** 32 doc and instruction files (about 4,500 lines), including 741 lines of AI-agent instructions, some of which state false constraints.
7. **The release pipeline is large and fragile.** About 1,445 lines of workflow YAML and 55 jobs per release, gated on cross-OS E2E (section 5.3).
8. **Upstream identity is hardcoded** in several places instead of coming from `package.json`.
