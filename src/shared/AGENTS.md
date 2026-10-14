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
- `src/shared/types/hotkeys.ts` — hotkey ids, accelerators and `PlatformHotkeyStatus`; while its `registrationPending` is true the desktop is still asking the user to approve the shortcuts, and the main process sends the final status on `PLATFORM_HOTKEY_STATUS_CHANGED`
- `src/shared/types/` — cross-boundary payloads and state types
- `src/shared/utils/` — shared pure helpers safe to reuse across boundaries

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
