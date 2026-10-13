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

| Layer         | What                                                                                                  | Version at snapshot                        |
| ------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Shell         | Electron                                                                                              | 39.8.10, end of life since 2026-05-05      |
| UI            | React, Framer Motion                                                                                  | 19.2, 12.42                                |
| Build         | TypeScript, Vite (renderer), `tsc` + esbuild (main and preload), electron-builder                     | 5.9, 7.3, esbuild via Vite, 26.8.1         |
| Tests         | Vitest with jsdom, WebdriverIO with `wdio-electron-service`                                           | 4.1, 9.27                                  |
| Runtime deps  | electron-updater, electron-log, semver, marked, turndown (+gfm), dbus-next, node-llama-cpp (optional) | see `package.json`                         |
| Node (dev/CI) | Node.js                                                                                               | 22 locally; CI pins its own `NODE_VERSION` |

Electron support status comes from [endoflife.date/electron](https://endoflife.date/electron): 39.8.10 was the final 39.x release. The supported lines in October 2026 are 44 (until 2027-03-02), 43 (until 2027-01-05) and 42 (until 2026-10-20).

App code is 159 TypeScript files and about 23,600 lines (main 14,500, renderer 7,100, shared 1,500, preload 400).
Test code is about 93,600 lines, roughly four lines of tests for every line of app code.

## 3. Features: the must-not-regress list

Every feature below must keep working through the cleanup. The status is for packaged builds at the snapshot.
"Wayland, kernel 7+" is the CachyOS case.

| Feature                                                                                         | macOS                                             | Linux (Wayland, kernel 7+)                                 | Windows          | Main code                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- | ---------------- | --------------------------------------------------------------- |
| Gemini in tabs (up to 20; Ctrl/Cmd+T, Ctrl+W, Ctrl+Tab, Ctrl+1..9; reload keeps the tab's chat) | OK                                                | OK                                                         | OK               | `renderer/context/TabContext.tsx`, `TabStateIpcHandler.ts`      |
| Google sign-in window                                                                           | OK                                                | OK                                                         | OK               | `windows/authWindow.ts`                                         |
| Single instance                                                                                 | OK                                                | OK                                                         | OK               | `main.ts`                                                       |
| Close to tray, tray menu                                                                        | OK                                                | OK (needs an AppIndicator host; Plasma has one)            | OK               | `trayManager.ts`                                                |
| Native menu and custom titlebar menu                                                            | OK                                                | Degraded: wrong shortcut labels                            | Degraded: same   | `menuManager.ts`, `useMenuDefinitions.ts`                       |
| Options window and About                                                                        | OK, but the disclaimer link is a 404              | same                                                       | same             | `renderer/components/options/`                                  |
| Theme (system, light, dark)                                                                     | OK                                                | OK                                                         | OK               | `ThemeIpcHandler.ts`, `ThemeContext.tsx`                        |
| Zoom 50-200%                                                                                    | OK                                                | OK                                                         | OK               | `windowManager.ts`                                              |
| Always on top (Ctrl/Cmd+Alt+P)                                                                  | OK                                                | OK                                                         | OK               | `AlwaysOnTopIpcHandler.ts`                                      |
| Fullscreen (F11, also from inside Gemini)                                                       | OK                                                | OK                                                         | OK               | `mainWindow.ts`                                                 |
| Offline overlay, error boundaries, opt-in crash reporter                                        | OK                                                | OK                                                         | OK               | `OfflineOverlay`, `GeminiErrorBoundary`, `main.ts`              |
| Quick Chat global hotkey (Ctrl/Cmd+Shift+Alt+Space)                                             | OK                                                | **Disabled by code** (B1); X11 always disabled (B8)        | OK               | `QuickChatIpcHandler.ts`, `hotkeyManager.ts`, `dbusFallback.ts` |
| Peek and Hide global hotkey (Ctrl/Cmd+Shift+Space)                                              | OK                                                | **Disabled by code** (B1)                                  | OK               | `hotkeyManager.ts`, `windowManager.ts`                          |
| Voice Chat global hotkey (Ctrl/Cmd+Shift+M)                                                     | Degraded: can hit the wrong tab (B7)              | **Disabled by code** (B1)                                  | Degraded (B7)    | `windowManager.ts`, `micActivation.ts`                          |
| Hotkey customization and Linux hotkey notice                                                    | OK                                                | OK                                                         | OK               | `IndividualHotkeyToggles.tsx`, `LinuxHotkeyNotice.tsx`          |
| Local text prediction in Quick Chat (Qwen3 0.6B, ~640 MB download)                              | **Broken**: no binary shipped (B2)                | **Broken**: no binary shipped, and disabled on 7+          | Plausibly OK     | `llmManager.ts`, `TextPredictionIpcHandler.ts`                  |
| Export chat to PDF or Markdown (Ctrl/Cmd+Shift+P)                                               | Degraded: exports the first tab (B6)              | Degraded (B6)                                              | Degraded (B6)    | `exportManager.ts`, `chatExtraction.ts`                         |
| Response-ready notifications and badges                                                         | OK (Dock badge)                                   | OK (notification only)                                     | OK (overlay dot) | `notificationManager.ts`, `badgeManager.ts`                     |
| Auto-update                                                                                     | Notify-only, checks **upstream** (B10)            | AppImage: electron-updater. deb/rpm: notify-only, upstream | electron-updater | `updateManager.ts`                                              |
| Launch at startup, start minimized                                                              | Start minimized likely broken on 13+ _(inferred)_ | **No-op** (B9)                                             | OK               | `LaunchAtStartupIpcHandler.ts`                                  |
| Smart Enter and scroll-to-bottom button                                                         | OK                                                | OK                                                         | OK               | inline script in `mainWindow.ts`                                |
| Linux sandbox fallback (`--no-sandbox` when user namespaces and SUID sandbox are unavailable)   | n/a                                               | OK                                                         | n/a              | `sandboxDetector.ts`, `sandboxInit.ts`                          |

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

_To be completed from the build and release review._

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

## 7. Known bugs and risks

IDs are referenced from [TODO.md](../TODO.md).

| ID  | Severity | Issue                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                               |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| B1  | High     | Wayland global hotkeys are switched off on Linux kernel 7+. The guard works around a crash blamed on dbus-next's optional native `usocket` transport, which dbus-next can do without.                                                                                                                                                                        | `sandboxDetector.ts:36,183-199`, `dbusFallback.ts:437-440,496-505`                     |
| B2  | High     | Local text prediction cannot load in packaged Linux or macOS builds: the builder config excludes every Linux and macOS `@node-llama-cpp/*` binary, and the app calls `getLlama({ build: 'never' })`. Verified in a local Linux package.                                                                                                                      | `config/electron-builder.config.cjs:46-60`, `llmManager.ts:486-489`                    |
| B3  | High     | On Linux kernel 6 and older, enabling text prediction leaves a permanent "restart required" loop: `sandboxInit.ts` reads `settings.json`, but the preference is saved in `user-preferences.json`.                                                                                                                                                            | `sandboxInit.ts:22-40`, `ipcManager.ts:122`                                            |
| B4  | High     | Electron 39 is end of life, so the app renders a signed-in Google site on a Chromium that has missed five months of security fixes.                                                                                                                                                                                                                          | `package.json`                                                                         |
| B5  | Medium   | The full `window.electronAPI` bridge is attached to the Google sign-in window, which has no navigation allowlist. No IPC handler checks its sender, and dev/test IPC channels are registered in production builds.                                                                                                                                           | `baseWindow.ts:83-89`, `authWindow.ts:95-127`, `AutoUpdateIpcHandler.ts:75-103`        |
| B6  | Medium   | Export uses the first Gemini frame instead of the active tab.                                                                                                                                                                                                                                                                                                | `exportManager.ts:112-124`                                                             |
| B7  | Medium   | Voice Chat reads a stale, startup-time copy of the tab state, so it can click the mic in the wrong tab.                                                                                                                                                                                                                                                      | `windowManager.ts:55-56,253-260`, `store.ts:101`                                       |
| B8  | Medium   | Global hotkeys are always disabled on X11, on the false premise that Electron's `globalShortcut` does not work there.                                                                                                                                                                                                                                        | `LinuxX11Adapter.ts:1-8,74-81`                                                         |
| B9  | Medium   | "Launch at startup" is a silent no-op on Linux (`setLoginItemSettings` only works on macOS and Windows), and the toggles still show.                                                                                                                                                                                                                         | `LaunchAtStartupIpcHandler.ts:92-103`                                                  |
| B10 | Medium   | Update checks, release notes, "Report an Issue" and the security contact still point at upstream.                                                                                                                                                                                                                                                            | [section 8](#8-upstream-references-to-change)                                          |
| B11 | Medium   | Local prediction prompts and completions are written to the main-process log.                                                                                                                                                                                                                                                                                | `llmManager.ts:651-668`                                                                |
| B12 | Low      | Orphaned E2E specs and vacuous release checks (see section 6).                                                                                                                                                                                                                                                                                               | `scripts/run-e2e-sequential.cjs`, `config/wdio/`                                       |
| B13 | Low      | Smaller defects: the native "Sign in" menu reloads before the window closes; menu labels show the wrong shortcuts; the README says Ctrl+P for PDF (the binding is Ctrl/Cmd+Shift+P); Quick Chat can show a stale prediction; tab titles are polled every 3 s even when hidden; settings writes are not atomic and a corrupt file silently resets everything. | `menuManager.ts:311-318`, `useMenuDefinitions.ts:198`, `README.md`, `store.ts:104-160` |

## 8. Upstream references to change

`grep -rniE "bwendell|benwendell|wendell"` matches 25 files outside `package-lock.json`.

| Where                                                                                            | What it does in the fork                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/managers/updateManager.ts:698`                                                         | The macOS and deb/rpm update check asks `api.github.com/repos/bwendell/gemini-desktop`, so those users never hear about fork releases.                                                            |
| `src/shared/constants/urls.ts`, `src/main/utils/constants.ts`, `src/renderer/utils/constants.ts` | Three copies of the repo URL feed release notes, "Report an Issue", License and Disclaimer links. The Disclaimer link points at `/blob/main/DISCLAIMER.md`, but the file is `docs/DISCLAIMER.md`. |
| `src/main/dev-app-update.yml`                                                                    | Dev update tests point at upstream.                                                                                                                                                               |
| `package.json`                                                                                   | Upstream author, and no `repository`, `homepage` or `bugs` fields. The deb and pacman builds fail without a homepage.                                                                             |
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

1. **Tests outweigh the app four to one and absorb most of the churn.** Across the 279 non-Dependabot commits, test and test-config changes total about 349,000 lines against 87,000 for app code, and WDIO files changed in 140 of those commits. Much of that effort went into making E2E pass on CI runners rather than into features.
2. **The IPC plumbing multiplies small changes.** A boolean setting needs a channel constant, an `ElectronAPI` entry, a preload module, a handler, store defaults and two drifting `UserPreferences` interfaces. The four most-changed files in `src/` are all plumbing.
3. **Gemini DOM knowledge is scattered** over four files, so a Google UI change means hunting for every copy.
4. **Native modules cause platform-specific breakage.** `usocket` (through dbus-next) and `node-llama-cpp` are behind the kernel 7 workaround, the Linux sandbox flag juggling and most packaging exclusions.
5. **Things that should be one thing are two:** the native and custom menus, the two Linux adapters, two stores for `autoUpdateEnabled`, three copies of the repo and app URLs.
6. **Documentation sprawl.** 32 doc and instruction files (about 4,500 lines), including 741 lines of AI-agent instructions, some of which state false constraints.
7. **The release pipeline is large.** See section 5.
8. **Upstream identity is hardcoded** in several places instead of coming from `package.json`.
