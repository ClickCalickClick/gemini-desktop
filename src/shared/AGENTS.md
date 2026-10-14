> Extends [root AGENTS.md](../../AGENTS.md). Read that first.

## Boundary Definition

`src/shared/` is the alignment layer between main, preload, and renderer.
It holds the contracts that keep those boundaries synchronized: IPC channel names, shared types, URL constants, and tab helpers.

Primary files and folders:

- `src/shared/constants/ipc-channels.ts` — canonical IPC channel names
- `src/shared/constants/urls.ts` — the fork's GitHub repository and every link derived from it (release notes, issues, License, Disclaimer, the notify-only update check)
- `src/shared/constants/looks.ts` — the one list of desktop looks (`DESKTOP_LOOKS`), their display names (`DESKTOP_LOOK_NAMES`) and the `isDesktopLook`/`isDesktopLookPreference` guards; the main process detection, `LookContext` and the Options look selector all derive from it. The `DesktopLook` union itself stays in `src/shared/types/look.ts`; keep both in step
- `src/shared/types/ipc.ts` — typed preload/renderer contract (`ElectronAPI`)
- `src/shared/types/tabs.ts` — shared tab state and payload shapes
- `src/shared/types/hotkeys.ts` — hotkey ids, accelerators and `PlatformHotkeyStatus`; while its `registrationPending` is true the desktop is still asking the user to approve the shortcuts, and the main process sends the final status on `PLATFORM_HOTKEY_STATUS_CHANGED`; `COPILOT_KEY_ACCELERATOR` (`Shift+Super+F23`) is the Options preset for Copilot keys where the app records keys itself. On the Wayland portal the desktop owns the keys: `HotkeyRegistrationResult.desktopTrigger` is the key it bound (its own words, such as `Press <Shift><Super>XF86Assistant`) and `canChangeInDesktop` says it can open its own dialog through `HOTKEYS_CHANGE_IN_DESKTOP`
- `src/shared/types/` — cross-boundary payloads and state types
- `src/shared/types/tray.ts` — `TrayClickAction` (`'quickChat' | 'mainWindow'`), `TRAY_CLICK_ACTIONS`, `DEFAULT_TRAY_CLICK_ACTION` (`'quickChat'`) and the `isTrayClickAction` guard, used by `TrayIpcHandler`, `TrayManager` and the Options "Tray icon opens" row
- `src/shared/types/agent.ts` — hybrid Quick Chat contract: routes, `RouteDecision`, agent settings and status, run requests and `AgentRunEvent`s, file plans
- `src/shared/utils/` — shared pure helpers safe to reuse across boundaries
- `src/shared/utils/quickChatRouter.ts` — `routePrompt(text, { mode, agentAvailable })` decides whether a Quick Chat prompt goes to the Gemini tab or the local agent, with a short reason. Order: prefix (`@web`, `@gemini`, `@agent`, `@cli`, `@local`, `/web`, `/agent`, stripped from `prompt`), then the routing mode, then the auto rules (paths and quoted file names, web cues such as images, video, Deep Research, Canvas, Gems, web search, news and weather, bare file names (stem of two or more characters, never URLs, hosts, abbreviations such as "D.C." or libraries such as "Alpine.js"), well-known folders, local code that needs an anchor such as "my project" or "this repo", system topics only with a local anchor such as "my laptop", "this machine" or "do I have", else "general question"). With `followUp: true` (an agent conversation is open) auto mode sends prompts without a prefix or web cue to the agent with the reason "follow-up to the agent". An agent route without an installed agent falls back to web unless a prefix forced it. `forceRoute` serves the chip toggle and Ctrl+Enter, `describeRoute` the chip label. The heuristics are exported; `tests/unit/shared/quickChatRouter.test.ts` holds the table of prompts, so add a row there when you change a rule

## Contract Rules

Changes here must preserve cross-boundary consistency.
If you add, rename, or remove a channel or shared payload, update every consuming boundary in the same change:

- main-process handlers and broadcasts
- preload bridge methods
- renderer callers/subscriptions
- any tests that assert the contract

For architecture context, read [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), especially the **Shared Contracts** section.

## Canonical Examples

- `src/shared/constants/ipc-channels.ts`
    - Central source of truth for channel names shared by main and preload.
- `src/shared/types/ipc.ts`
    - Canonical typed contract for `window.electronAPI`.
- `src/shared/types/tabs.ts`
    - Example of stable payload/state definitions reused across boundaries.

## Common Mistakes

- Changing a shared contract without updating preload and main in the same change
- Hardcoding channel strings outside `src/shared/constants/ipc-channels.ts`
- Writing a GitHub repository URL anywhere but `src/shared/constants/urls.ts` (`tests/unit/shared/urls.test.ts` fails)
- Adding boundary-specific behavior to shared utilities instead of keeping them pure and reusable
- Renaming payload fields without updating the renderer and tests that consume them

## When You Change Files Here

- If you are working in a newly created git worktree, run `npm install` in that worktree first so local dependencies are present.
- Default verification: `npm run test:electron`
- Also run: `npm run lint`
- If channels or preload-facing contracts changed, also run: `npm run test:integration`
