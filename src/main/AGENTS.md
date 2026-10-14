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

## Manager Pattern

All managers are injected via `ApplicationContext`. Do not use global mutable manager singletons.
For architecture details, see `docs/ARCHITECTURE.md` (Manager Architecture section).

## IPC Handler Pattern

Handlers extend `BaseIpcHandler` and follow lifecycle: `register()` → optional `initialize()` → `unregister()`.
Use `getWindowFromEvent()` for safe sender window lookup, `broadcastToAllWindows()` for sync, and `handleError()` for consistent error logging.
See `src/main/managers/ipc/BaseIpcHandler.ts` and `docs/ARCHITECTURE.md` (IPC Handler Pattern section).
A manager announces a change by emitting an event on `windowManager`, for example `platform-hotkey-status-changed` from `HotkeyManager`; the IPC handler subscribes with a bound listener in `register()`, broadcasts it to all windows and removes the listener in `unregister()` (see `HotkeyIpcHandler.ts` and `ZoomIpcHandler.ts`).

## Desktop Look

- `src/main/managers/ipc/LookIpcHandler.ts` handles `look:get` and `look:set` (validated against `DesktopLookPreference`, saved as `desktopLook`, default `'default'`) and broadcasts `look:changed` with `LookData` to every window.
- `src/main/utils/desktopLook.ts` holds the pure detection: macOS → `macos`, Windows → `windows`, Linux from `XDG_CURRENT_DESKTOP` (colon list, in order), then `XDG_SESSION_DESKTOP` and `DESKTOP_SESSION`; unknown desktops resolve 'auto' to `default`.
- `src/main/utils/desktopAccent.ts` (`DesktopAccentWatcher`) reads `org.freedesktop.appearance` `accent-color` from the XDG Settings portal (`ReadOne`, falling back to `Read`), follows `SettingChanged`, and on KDE falls back to `~/.config/kdeglobals`. It only starts on Linux once a look other than `default` applies, connects dbus-next with `getSessionBusAddress()` (never the native `usocket` module), uses 1.5 s timeouts and fails soft to a null accent.

## Canonical Examples

- IPC handler: `src/main/managers/ipc/ThemeIpcHandler.ts` — `class ThemeIpcHandler extends BaseIpcHandler` (lines 25-120)
    - Shows: `ipcMain.handle`/`ipcMain.on` registration, validation, store persistence, window broadcast, error handling.
- Unit test: `tests/unit/main/ipc/ThemeIpcHandler.test.ts` — `describe('ThemeIpcHandler', ...)` (lines 1-271)
    - Shows: `vi.hoisted()` Electron mocking, shared mock helpers, handler registration, async invocation, broadcast verification.

## Agent Engine (hybrid Quick Chat, H2 and H3)

`src/main/managers/agentManager.ts` (`AgentManager`, created in `main.ts`, held in `ApplicationContext.agentManager`, passed to `IpcManager` and disposed at quit) drives a local agent CLI headless. `src/main/managers/ipc/AgentIpcHandler.ts` serves the `agent:*` channels; `QuickChatIpcHandler` serves `quick-chat:resize` (`WindowManager.resizeQuickChat` → `QuickChatWindow.resizeToContent`: 64..640 CSS px × zoom, width and top edge kept, only `setSize` on Wayland). Helpers live in `src/main/agent/`:

- `engineDiscovery.ts`: finds `agy` / `gemini` on PATH and in the usual install folders (`~/.local/bin`, which is Antigravity's documented location, `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`, `~/.npm-global/bin`, `~/.bun/bin`, `~/.volta/bin`; on Windows `%LOCALAPPDATA%\agy\bin` and `%APPDATA%\npm`, `.exe` only, because `.cmd` shims need a shell). `auto` prefers Antigravity. The status is cached for 30 s.
- `streamParsers.ts`: NDJSON line splitter (partial lines, invalid lines skipped) and the two event mappers (Antigravity `init`/`step_update`/`result`; Gemini CLI `init`/`message`/`tool_use`/`tool_result`/`error`/`result`). Unknown events and fields are ignored.
- `promptContext.ts`: the read-only context the app gathers and the prompt it wraps around the user's request.
- `workspace.ts`: the scratch workspace and the check of Antigravity's global settings.
- `filePlan.ts`: the plan schema (`--json-schema`), plan validation, path checks, apply and undo.

Runs: `spawn` without a shell, `-p <prompt> --output-format stream-json`; Antigravity adds `--print-timeout 5m --sandbox`, `--model`, `--conversation <id>` and, for `files`, `--json-schema`; Gemini CLI adds `--approval-mode default`, `--model`, `--resume <id>` and is asked for a fenced JSON block instead of a schema. One run at a time (a new run cancels the old one), a 6-minute app timeout (`TIMEOUT`), cancel = SIGINT, SIGTERM after 3 s, then SIGKILL. `runAgent` resolves with the `runId` first; events follow on `agent:event` to Quick Chat (the sender is the fallback). Never log prompts, answers or stderr text: only ids, lengths and statuses.

**Safety model (why the agent cannot change the user's files).** Neither CLI has a per-run settings file or flag (Antigravity's permissions doc, <https://antigravity.google/docs/permissions?tab=cli>, only documents the global `~/.gemini/antigravity-cli/settings.json` and per-project settings in the desktop app), so the app relies on the documented defaults and never widens them:

1. The CLI runs with `cwd` = `<userData>/agent-workspace`. Antigravity auto-allows file reads and writes only inside the active workspace; outside it, file tools are Ask (`allowNonWorkspaceAccess` defaults to false), and shell commands default to Ask. In headless mode Ask is soft-denied: the run continues and stderr names the tool. Gemini CLI's default approval mode likewise refuses tools that need approval when headless.
2. The workspace is made a repository root of its own (a minimal `.git` folder), so a CLI that looks for the enclosing repository cannot widen the workspace to a home folder kept in version control, and per-workspace settings files (`.gemini/settings.json`, `.gemini/antigravity-cli/settings.json`, `.antigravity/settings.json`, `.agents/settings.json`) are deleted before every run.
3. `--sandbox` puts any terminal command the user's own rules allow into Antigravity's OS sandbox, where only the workspace is writable. Never pass `--dangerously-skip-permissions` or `--approval-mode yolo`/`auto_edit`.
4. The app reads (never writes) Antigravity's global settings and reports the engine as unavailable when they allow changes outside the workspace: `toolPermission: "always-proceed"`, `allowNonWorkspaceAccess: true`, or `permissions.allow` rules `write_file(...)` outside the workspace, `command(*)`, `command(regex:...)` or `unsandboxed(...)`. Specific command prefixes such as `command(npm)` are the user's choice and stay allowed. `auto` then falls back to Gemini CLI if it is installed. Gemini CLI's own settings are not inspected (best effort).
5. Because the agent cannot read the user's files, the app gathers the context itself: folders named in the prompt (`~/…`, absolute or quoted paths, "Downloads", "Documents", "Pictures", …, resolved with `app.getPath`) are listed with names, sizes and dates (one level, two for `files` tasks; hidden entries skipped; 200 per folder, 600 in all, 40,000 characters, 8,000 on Windows because of its command-line limit). Single files named in a question are copied (up to 5, 25 MB each) into `inputs/<runId>/` in the workspace for the agent to read; copies older than a day are removed. Paths outside home, in hidden top-level folders, in userData or behind a symlink that leads elsewhere are never listed or copied.
6. File tasks (`category: 'files'`) are told not to change anything and return a `FileActionPlan`. Actions with unsafe paths are dropped (and the summary says so) before the `plan` event. Only `agent:apply-plan` changes files, in the main process: each path must be absolute, normalized, inside `os.homedir()` but not home itself, not in a dot-folder at the top of home or in userData, and the real path of its closest existing parent must stay inside home. Nothing is overwritten (a `mkdir` of an existing folder is a no-op), missing parent folders are created and recorded, moves fall back to copy-then-remove on `EXDEV`, `trash` uses `shell.trashItem`. A plan applies once; failures are reported per action and the rest continue. `agent:undo-last` reverses the last applied plan once (moves back, copies to the trash, created folders removed when empty; trashed items are reported as "restore it from the Trash").

## Common Mistakes

- Using global mutable state for managers instead of DI via `ApplicationContext`
- Forgetting `unregister()` cleanup for IPC handlers
- Sending to destroyed windows without checking `isDestroyed()` first
- Connecting dbus-next with its default address: for `unix:path=` and `unix:abstract=` addresses it loads the native `usocket` module, which crashes the app on Linux kernel 7+ (B1). Use `connectSessionBus()` in `utils/dbusFallback.ts`, which converts the address for Node's `net` module; the package leaves `usocket` out
- Calling `show()` and `focus()` to bring the main window to the front: GNOME on Wayland refuses the app's request to raise a window that is already open, so it stays behind other apps (B16). Call `windowManager.focusMainWindow()`, which goes through `PlatformAdapter.bringToFront()`; the Wayland adapter hides and shows the window again
- Adding `process.on('SIGTERM' | 'SIGINT' | 'SIGHUP')` listeners while the app starts on Linux: Node.js installs a signal's handler only for its first listener, so they stop `utils/terminationSignals.ts` from taking these signals over from Electron once the app is ready (B15)

## When You Change Files Here

- If you are working in a newly created git worktree, run `npm install` in that worktree first so Electron and other dependencies exist locally.
- Run `npm run test:electron`
- If IPC handlers are modified, also run `npm run test:integration`
