> Extends [root AGENTS.md](../../AGENTS.md). Read that first.

## Boundary Definition

Main process runs in Node.js and owns window lifecycle, IPC handlers, tray, updates, and global hotkeys.

Primary files and folders:

- `src/main/main.ts` — app entrypoint
- `src/main/ApplicationContext.ts` — dependency injection container
- `src/main/store.ts` — electron-store integration
- `src/main/managers/` — manager classes
- `src/main/windows/` — window creation/lifecycle
- `src/main/platform/` — OS-specific behavior
- `src/main/utils/` — main-process utilities
- `src/main/utils/launchArgs.ts` — the app's own flags: `--quick-chat` (also passed as single-instance data) and `--hidden`
- `src/main/utils/quickChatLauncher.ts` — writes the Gemini Quick Chat launcher to `~/.local/share/applications` when the app runs as an AppImage (`$APPIMAGE`), and removes its own launcher in deb, rpm and pacman installs, which ship one; tar.gz and `release/linux-unpacked` runs write nothing, and `GEMINI_DESKTOP_NO_LAUNCHER=1` (set by `wdio.base.conf.js` and `scripts/live-check.mjs`) turns it off. It only rewrites or removes a file marked `X-Gemini-Desktop-Generated=true`

## Manager Pattern

All managers are injected via `ApplicationContext`. Do not use global mutable manager singletons.
For architecture details, see `docs/ARCHITECTURE.md` (Manager Architecture section).

## IPC Handler Pattern

Handlers extend `BaseIpcHandler` and follow lifecycle: `register()` → optional `initialize()` → `unregister()`.
Use `getWindowFromEvent()` for safe sender window lookup, `broadcastToAllWindows()` for sync, and `handleError()` for consistent error logging.
See `src/main/managers/ipc/BaseIpcHandler.ts` and `docs/ARCHITECTURE.md` (IPC Handler Pattern section).
A manager announces a change by emitting an event on `windowManager`, for example `platform-hotkey-status-changed` from `HotkeyManager`; the IPC handler subscribes with a bound listener in `register()`, broadcasts it to all windows and removes the listener in `unregister()` (see `HotkeyIpcHandler.ts` and `ZoomIpcHandler.ts`).

## Canonical Examples

- IPC handler: `src/main/managers/ipc/ThemeIpcHandler.ts` — `class ThemeIpcHandler extends BaseIpcHandler` (lines 25-120)
    - Shows: `ipcMain.handle`/`ipcMain.on` registration, validation, store persistence, window broadcast, error handling.
- Unit test: `tests/unit/main/ipc/ThemeIpcHandler.test.ts` — `describe('ThemeIpcHandler', ...)` (lines 1-271)
    - Shows: `vi.hoisted()` Electron mocking, shared mock helpers, handler registration, async invocation, broadcast verification.

## Common Mistakes

- Using global mutable state for managers instead of DI via `ApplicationContext`
- Forgetting `unregister()` cleanup for IPC handlers
- Sending to destroyed windows without checking `isDestroyed()` first
- Connecting dbus-next with its default address: for `unix:path=` and `unix:abstract=` addresses it loads the native `usocket` module, which crashes the app on Linux kernel 7+ (B1). Use `connectSessionBus()` in `utils/dbusFallback.ts`, which converts the address for Node's `net` module; the package leaves `usocket` out
- Calling `show()` and `focus()` to bring the main window to the front: GNOME on Wayland refuses the app's request to raise a window that is already open, so it stays behind other apps (B16). Call `windowManager.focusMainWindow()`, which goes through `PlatformAdapter.bringToFront()`; the Wayland adapter hides and shows the window again
- Adding `process.on('SIGTERM' | 'SIGINT' | 'SIGHUP')` listeners while the app starts on Linux: Node.js installs a signal's handler only for its first listener, so they stop `utils/terminationSignals.ts` from taking these signals over from Electron once the app is ready (B15)
- Reading `process.argv` for a new flag in `main.ts` without going through `utils/launchArgs.ts`: a second instance's flags arrive in the `second-instance` event (and Chromium may reorder or drop them), not in the running app's `process.argv`
- Hardcoding the install path of the Linux packages: the Quick Chat action, `build/linux/gemini-desktop-quick-chat.desktop` and `scripts/release/check-arch-install.sh` all use `/opt/Gemini Desktop/gemini-desktop`; change them together with `productName`

## When You Change Files Here

- If you are working in a newly created git worktree, run `npm install` in that worktree first so Electron and other dependencies exist locally.
- Run `npm run test:electron`
- If IPC handlers are modified, also run `npm run test:integration`
