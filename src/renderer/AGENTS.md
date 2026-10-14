> Extends [root AGENTS.md](../../AGENTS.md). Read that first.

## Boundary Definition

Renderer runs in Chromium sandbox with no direct Node.js access.
This layer contains React UI, contexts, hooks, and window-specific frontend behavior.

Primary files and folders:

- `src/renderer/App.tsx` — root component
- `src/renderer/main.tsx` — renderer entrypoint
- `src/renderer/components/` — UI components
- `src/renderer/context/` — global React contexts
- `src/renderer/hooks/` — custom hooks
- `src/renderer/windows/` — window-specific UI modules
- `src/renderer/utils/`, `src/renderer/types/`, `src/renderer/assets/`

## React Patterns

Use React Context for global UI state (Theme, Toast, Auth) and local state/reducers for component-local logic.
All system access must flow through preload bridge methods on `window.electronAPI`.
See renderer sections in `docs/ARCHITECTURE.md` for deeper rationale.

## IPC Communication from Renderer

Use only `window.electronAPI.*` APIs exposed by preload.
Subscription APIs return cleanup functions — always call them in `useEffect` cleanup.
For async initialization and subscriptions, use `AbortController` to prevent stale updates after unmount.

## Canonical Example

- `src/renderer/context/ThemeContext.tsx` — `ThemeProvider` and `useTheme`
    - Shows typed context API, `AbortController` guard, IPC subscription cleanup in `useEffect`, `useCallback` setter, and robust fallback/error handling.
    - Pattern aligns to preload `get → set → onChange` APIs.

## Desktop Looks

- `src/renderer/context/LookContext.tsx` (`LookProvider`, `useLook`) loads the look with `getLook`, follows `onLookChanged`, and sets `data-look="<effectiveLook>"`, `--desktop-accent` and `--desktop-accent-fg` (black or white, whichever has more WCAG contrast on the accent; see `utils/accentColor.ts`) on `<html>`. Text drawn on the accent uses `var(--desktop-accent-fg, var(--look-accent-fg, #fff))`. The main window (`App.tsx`), Options (`windows/options/main.tsx`) and Quick Chat (`windows/quickchat/main.tsx`) each wrap their root in it, inside `ThemeProvider`. `useLook()` returns the default look outside a provider, so components stay usable alone.
- Styles live in `src/renderer/looks/`: `index.css` (imported once from `theme.css`), `base.css` with the shared rules under `[data-look]:not([data-look='default'])`, and one file per look that sets `--look-*` and theme variables under `:root[data-look='<look>']` for dark and `[data-theme='light']`. The `default` look matches no rule, so it is the app as before. Quick Chat is styled through its class names (`.quick-chat-container`, `.quick-chat-input`, ...), not by editing `QuickChat.css`.
- Window controls follow the look through `utils/windowControlsLayout.ts` (`WindowControls`, `OptionsWindowTitlebar`): GNOME shows only close, elementary OS puts close left and maximize right, the macOS look puts traffic lights on the left; macOS itself keeps its native controls. A left group renders as `.window-controls--left` (moved first with CSS `order`).
- The Options `LookSelector` follows the WAI-ARIA radio group pattern: one tab stop (roving tabindex), Arrow keys and Home/End move focus and select.
- When adding a look: add it to `DesktopLook` (shared contract) and to `DESKTOP_LOOKS` and `DESKTOP_LOOK_NAMES` in `src/shared/constants/looks.ts` (main detection, `LookContext` validation and the Options list derive from them), give it a preview accent in `components/options/LookSelector.tsx`, a CSS file in `looks/`, and a layout entry in `utils/windowControlsLayout.ts` if its controls differ.

## Common Mistakes

- Importing Node.js APIs directly in renderer code
- Forgetting to clean up IPC subscriptions in `useEffect` return
- Skipping `GeminiErrorBoundary` around risky UI areas
- Missing `AbortController.abort()` in async cleanup paths

## When You Change Files Here

- If you are working in a newly created git worktree, run `npm install` in that worktree first so local dependencies are present before running the commands below.
- Run `npm run test`
- Run `npm run lint`
